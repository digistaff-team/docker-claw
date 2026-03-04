const express = require('express');
const router = express.Router();
const sessionService = require('../services/session.service');
const dockerService = require('../services/docker.service');
const manageStore = require('../manage/store');

// ─── Вспомогательная функция: детерминированный порт (совпадает с toolHandlers) ──
function calcAppPort(chatId, appName) {
    let hash = 0;
    const str = `${chatId}:${appName}`;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
    }
    return 3100 + (Math.abs(hash) % 900);
}

/**
 * Получить список приложений (pm2 list) для пользователя
 * GET /api/apps/:chat_id
 */
router.get('/:chat_id', async (req, res) => {
    const { chat_id } = req.params;

    // Используем getSession (без создания) — страница списка не должна поднимать контейнер
    const session = sessionService.getSession(chat_id);
    if (!session) {
        return res.status(404).json({ success: false, error: 'Session not found' });
    }

    try {
        // pm2 jlist возвращает JSON-массив процессов
        const result = await dockerService.executeInContainer(
            session.containerId,
            'pm2 jlist 2>/dev/null || echo "[]"',
            10
        );

        let apps = [];
        try {
            const raw = result.stdout.trim();
            // pm2 jlist может выводить лог-строки перед JSON — берём только JSON-часть
            const jsonStart = raw.indexOf('[');
            const jsonEnd   = raw.lastIndexOf(']');
            if (jsonStart !== -1 && jsonEnd !== -1) {
                apps = JSON.parse(raw.slice(jsonStart, jsonEnd + 1));
            }
        } catch (parseErr) {
            // pm2 не запущен или нет процессов — возвращаем пустой список
            apps = [];
        }

        // Загружаем сохранённые данные из store для обогащения (порт и т.д.)
        const storedApps = manageStore.getApps(chat_id);

        // Нормализуем данные для фронта
        const normalized = apps.map(p => {
            const appName = p.name || '';
            // Порт: из pm2_env.env → из store → детерминированный хэш
            const envPort = parseInt(p.pm2_env?.env?.PORT);
            const stored  = storedApps.find(a => a.name === appName);
            const port    = (!isNaN(envPort) && envPort > 0)
                ? envPort
                : (stored?.port || calcAppPort(chat_id, appName));

            // Обновляем порт в store если он там не был
            if (stored && !stored.port && port) {
                manageStore.addOrUpdateApp(chat_id, { name: appName, port });
            }

            return {
                id:           p.pm_id,
                name:         appName,
                status:       p.pm2_env?.status        ?? 'unknown',
                pid:          p.pid                    ?? null,
                cpu:          p.monit?.cpu             ?? 0,
                memory:       p.monit?.memory          ?? 0,
                uptime:       p.pm2_env?.pm_uptime     ?? null,
                restarts:     p.pm2_env?.restart_time  ?? 0,
                script:       p.pm2_env?.pm_exec_path  ?? '',
                cwd:          p.pm2_env?.pm_cwd        ?? '',
                instances:    p.pm2_env?.instances     ?? 1,
                exec_mode:    p.pm2_env?.exec_mode     ?? 'fork',
                node_version: p.pm2_env?.node_version  ?? '',
                created_at:   p.pm2_env?.created_at    ?? null,
                port,
            };
        });

        res.json({ success: true, apps: normalized, count: normalized.length });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * Получить порт конкретного приложения (используется sandbox proxy)
 * GET /api/apps/:chat_id/port/:app_name
 */
router.get('/:chat_id/port/:app_name', async (req, res) => {
    const { chat_id, app_name } = req.params;

    const session = sessionService.getSession(chat_id);
    if (!session) {
        return res.status(404).json({ success: false, error: 'Session not found' });
    }

    // 1. Из store
    const stored = manageStore.getApps(chat_id).find(a => a.name === app_name);
    if (stored?.port) {
        return res.json({ success: true, port: stored.port, source: 'store' });
    }

    // 2. Из pm2 jlist
    try {
        const result = await dockerService.executeInContainer(
            session.containerId,
            `pm2 jlist 2>/dev/null | python3 -c "` +
            `import sys,json; ` +
            `procs=json.load(sys.stdin); ` +
            `p=[x for x in procs if x.get('name')=='${app_name}']; ` +
            `print(p[0]['pm2_env'].get('env',{}).get('PORT','') if p else '')" 2>/dev/null`,
            10
        );
        const port = parseInt(result.stdout.trim());
        if (!isNaN(port) && port > 0) {
            manageStore.addOrUpdateApp(chat_id, { name: app_name, port });
            return res.json({ success: true, port, source: 'pm2' });
        }
    } catch (_) { /* ignore */ }

    // 3. Детерминированный хэш (fallback)
    const port = calcAppPort(chat_id, app_name);
    return res.json({ success: true, port, source: 'hash' });
});

/**
 * Починить сломанное приложение: перезаписать app.js новым шаблоном и перезапустить.
 * Нужно для приложений, созданных до рефакторинга (старый формат "скрипт с argv").
 * POST /api/apps/:chat_id/fix/:app_name
 */
router.post('/:chat_id/fix/:app_name', async (req, res) => {
    const { chat_id, app_name } = req.params;

    let session;
    try {
        session = await sessionService.getOrCreateSession(chat_id);
    } catch (err) {
        return res.status(503).json({ success: false, error: 'Не удалось подключиться к контейнеру: ' + err.message });
    }

    const appDir  = `/workspace/apps/${app_name}`;
    const port    = calcAppPort(chat_id, app_name);

    // Новый корректный app.js — Express-сервер на фиксированном порту
    const newAppJs = `const express = require('express');
const path = require('path');
const app = express();
const port = parseInt(process.env.PORT) || ${port};

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  const idx = path.join(__dirname, 'public', 'index.html');
  const fs = require('fs');
  if (fs.existsSync(idx)) return res.sendFile(idx);
  res.send('<h1>${app_name}</h1><p>App is running on port ' + port + '</p>');
});

app.get('/api/ping', (req, res) => {
  res.json({ status: 'ok', app: '${app_name}', port, time: new Date().toISOString() });
});

app.post('/api/message', (req, res) => {
  const msg = req.body.message || req.body.text || 'no message';
  res.json({ reply: 'Echo: ' + msg, received: new Date().toISOString() });
});

app.listen(port, '0.0.0.0', () => {
  console.log('${app_name} running on port ' + port);
});
`;

    // Скрипт: проверяем наличие express, перезаписываем app.js, перезапускаем pm2
    const fixScript = [
        `cd "${appDir}"`,
        // Устанавливаем express если нет
        `[ -f package.json ] || npm init -y --quiet`,
        `[ -d node_modules/express ] || npm install express --save --quiet`,
        // Перезаписываем app.js через python3 (надёжнее heredoc)
        `python3 -c "open('${appDir}/app.js','w').write(${JSON.stringify(newAppJs)})"`,
        // Останавливаем старый процесс (по любому имени)
        `pm2 delete "${app_name}" 2>/dev/null || true`,
        `pm2 delete "app-${app_name}" 2>/dev/null || true`,
        // Запускаем с правильным портом
        `PORT=${port} pm2 start "${appDir}/app.js" --name "${app_name}" --cwd "${appDir}"`,
        `sleep 2`,
        `pm2 save --force 2>/dev/null || true`,
        // Проверяем
        `curl -sf http://localhost:${port}/api/ping && echo "OK" || echo "WARN: not responding yet"`,
    ].join(' && ');

    try {
        const result = await dockerService.executeInContainer(session.containerId, fixScript, 60);

        // Обновляем порт в store
        manageStore.addOrUpdateApp(chat_id, { name: app_name, port, status: result.exitCode === 0 ? 'running' : 'error' });

        res.json({
            success: result.exitCode === 0,
            port,
            output: (result.stdout + '\n' + result.stderr).trim(),
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * Действие над приложением: start / stop / restart / delete
 * POST /api/apps/:chat_id/:action
 * body: { name: "app-name" }  или  { id: 0 }
 */
router.post('/:chat_id/:action', async (req, res) => {
    const { chat_id, action } = req.params;
    const { name, id } = req.body;

    const allowed = ['start', 'stop', 'restart', 'delete'];
    if (!allowed.includes(action)) {
        return res.status(400).json({ success: false, error: `Unknown action: ${action}` });
    }

    let session;
    try {
        session = await sessionService.getOrCreateSession(chat_id);
    } catch (err) {
        return res.status(503).json({ success: false, error: 'Не удалось подключиться к контейнеру: ' + err.message });
    }
    if (!session) {
        return res.status(404).json({ success: false, error: 'Session not found' });
    }

    // Идентификатор процесса — имя или числовой id
    const target = name ?? id;
    if (target === undefined || target === null || target === '') {
        return res.status(400).json({ success: false, error: 'name or id is required' });
    }

    try {
        // Для delete - полное удаление: PM2 + папка + логи + store
        if (action === 'delete') {
            const appName = String(target);
            const appDir = `/workspace/apps/${appName}`;
            
            // Составляем скрипт полного удаления
            const deleteScript = [
                // 1. Останавливаем и удаляем из PM2
                `pm2 delete "${appName}" 2>/dev/null || true`,
                // 2. Удаляем логи PM2 для этого приложения
                `rm -f /root/.pm2/logs/${appName}-*.log 2>/dev/null || true`,
                // 3. Удаляем папку приложения со всеми файлами
                `rm -rf "${appDir}"`,
                // 4. Сохраняем состояние PM2 (чтобы не восстановилось при рестарте)
                `pm2 save --force 2>/dev/null || true`,
            ].join(' && ');
            
            const result = await dockerService.executeInContainer(session.containerId, deleteScript, 30);
            
            // Удаляем из store
            manageStore.removeApp(chat_id, appName);
            
            res.json({
                success: true,
                action,
                target: appName,
                deletedFiles: true,
                output: result.stdout + result.stderr,
            });
            return;
        }

        // Остальные действия - как раньше
        const cmd = `pm2 ${action} ${String(target)} 2>&1`;
        const result = await dockerService.executeInContainer(session.containerId, cmd, 15);

        res.json({
            success: result.exitCode === 0,
            action,
            target,
            output: result.stdout + result.stderr,
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * Логи приложения
 * GET /api/apps/:chat_id/:name/logs?lines=50
 */
router.get('/:chat_id/:name/logs', async (req, res) => {
    const { chat_id, name } = req.params;
    const lines = Math.min(parseInt(req.query.lines) || 50, 500);

    const session = sessionService.getSession(chat_id);
    if (!session) {
        return res.status(404).json({ success: false, error: 'Session not found' });
    }

    try {
        const result = await dockerService.executeInContainer(
            session.containerId,
            `pm2 logs ${name} --lines ${lines} --nostream 2>&1 || echo "(нет логов)"`,
            15
        );

        res.json({
            success: true,
            name,
            lines: result.stdout || result.stderr || '(нет логов)',
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;
