const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs').promises;
const http = require('http');
const storageService = require('../services/storage.service');
const sessionService = require('../services/session.service');
const dockerService = require('../services/docker.service');
const manageStore = require('../manage/store');
const config = require('../config');

// ─────────────────────────────────────────────────────────────────────────────
// Детерминированный порт — совпадает с алгоритмом в toolHandlers.js
// Диапазон 3100–3999, не пересекается с основным сервером (3015).
// ─────────────────────────────────────────────────────────────────────────────
function calcAppPort(chatId, appName) {
    let hash = 0;
    const str = `${chatId}:${appName}`;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
    }
    return 3100 + (Math.abs(hash) % 900);
}

// ─────────────────────────────────────────────────────────────────────────────
// Вспомогательная функция: получить порт pm2-приложения внутри контейнера.
// Уровни: store (кэш) → pm2 jlist (реальный) → детерминированный хэш (fallback).
// ─────────────────────────────────────────────────────────────────────────────
async function getAppPort(chatId, appName, containerId) {
    // 1. Быстрый путь — из store
    const apps = manageStore.getApps(chatId);
    const stored = apps.find(a => a.name === appName);
    if (stored && stored.port) return stored.port;

    // 2. Спросить pm2 внутри контейнера (ищем и по имени app-NAME и по NAME)
    try {
        const result = await dockerService.executeInContainer(
            containerId,
            `pm2 jlist 2>/dev/null | python3 -c "` +
            `import sys,json; ` +
            `procs=json.load(sys.stdin); ` +
            `p=[x for x in procs if x.get('name') in ('app-${appName}','${appName}')]; ` +
            `print(p[0]['pm2_env'].get('env',{}).get('PORT','') if p else '')" 2>/dev/null`,
            10
        );
        const port = parseInt(result.stdout.trim());
        if (!isNaN(port) && port > 0) {
            // Кэшируем в store
            manageStore.addOrUpdateApp(chatId, { name: appName, port });
            return port;
        }
    } catch (_) { /* ignore */ }

    // 3. Детерминированный хэш — всегда возвращает одно и то же значение
    //    для данной пары chatId:appName, даже если pm2 daemon не запущен.
    const fallbackPort = calcAppPort(chatId, appName);
    // Сохраняем в store чтобы следующий запрос был быстрым
    manageStore.addOrUpdateApp(chatId, { name: appName, port: fallbackPort });
    return fallbackPort;
}

// ─────────────────────────────────────────────────────────────────────────────
// Вспомогательная функция: проксировать HTTP-запрос к контейнеру.
// Использует IP контейнера в docker bridge-сети — порты наружу не пробрасываются.
// ─────────────────────────────────────────────────────────────────────────────
function proxyRequest(req, res, targetHost, targetPort, targetPath) {
    return new Promise((resolve) => {
        // Собираем query string
        const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';

        // Экранируем путь: кириллица и прочие не-ASCII символы → %XX.
        // encodeURI сохраняет структурные символы (/ ? = & # : @),
        // но кодирует всё не-ASCII и пробелы — именно то, что нужно для прокси.
        const safePath = encodeURI(targetPath);
        const fullPath = safePath + qs;

        // Копируем заголовки, убираем hop-by-hop
        const headers = { ...req.headers };
        delete headers['host'];
        delete headers['connection'];
        delete headers['transfer-encoding'];
        headers['host'] = `${targetHost}:${targetPort}`;

        const options = {
            hostname: targetHost,
            port: targetPort,
            path: fullPath,
            method: req.method,
            headers,
            timeout: 30000,
        };

        // http.request() может бросить синхронно (ERR_UNESCAPED_CHARACTERS и др.)
        // до того как будет возможность навесить обработчик 'error' — ловим явно.
        let proxyReq;
        try {
            proxyReq = http.request(options, (proxyRes) => {
                // Копируем статус и заголовки ответа
                res.status(proxyRes.statusCode);
                for (const [key, value] of Object.entries(proxyRes.headers)) {
                    // Пропускаем hop-by-hop заголовки
                    if (!['connection', 'transfer-encoding', 'keep-alive'].includes(key.toLowerCase())) {
                        res.setHeader(key, value);
                    }
                }
                // Стримим тело ответа
                proxyRes.pipe(res, { end: true });
                proxyRes.on('end', resolve);
            });
        } catch (syncErr) {
            if (!res.headersSent) {
                res.status(400).json({
                    error: 'Bad Request: invalid proxy path',
                    detail: syncErr.message,
                });
            }
            return resolve();
        }

        proxyReq.on('timeout', () => {
            proxyReq.destroy();
            if (!res.headersSent) {
                res.status(504).json({ error: 'Gateway Timeout: app did not respond in 30s' });
            }
            resolve();
        });

        proxyReq.on('error', (err) => {
            if (!res.headersSent) {
                res.status(502).json({
                    error: 'Bad Gateway: cannot connect to app',
                    detail: err.message,
                    hint: 'Приложение может быть остановлено. Попроси ИИ перезапустить его.'
                });
            }
            resolve();
        });

        // Передаём тело запроса (POST/PUT/PATCH)
        if (['POST', 'PUT', 'PATCH'].includes(req.method) && req.body) {
            const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
            proxyReq.setHeader('content-length', Buffer.byteLength(body));
            proxyReq.write(body);
        }

        proxyReq.end();
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Маршрут: /sandbox/:chat_id/app/:app_name[/*]
// Проксирует все HTTP-запросы к pm2-приложению внутри контейнера пользователя.
// ─────────────────────────────────────────────────────────────────────────────
router.all('/:chat_id/app/:app_name*', async (req, res) => {
    const { chat_id, app_name } = req.params;

    // Путь внутри приложения (всё после /app/:app_name)
    const appPath = req.params[0] || '/';

    // Проверяем сессию
    const session = sessionService.getSession(chat_id);
    if (!session) {
        return res.status(404).json({
            error: 'Container not found or inactive.',
            hint: 'Откройте панель управления и убедитесь, что контейнер запущен.'
        });
    }

    // Получаем IP контейнера
    const containerIP = await dockerService.getContainerIP(session.containerId);
    if (!containerIP) {
        return res.status(503).json({
            error: 'Cannot determine container IP address.',
            hint: 'Контейнер может быть в сети --network none. Проверьте настройки.'
        });
    }

    // Получаем порт приложения
    const port = await getAppPort(chat_id, app_name, session.containerId);
    if (!port) {
        return res.status(503).json({
            error: `Cannot determine port for app "${app_name}".`,
            hint: 'Приложение может быть не запущено через pm2. Попроси ИИ запустить его.'
        });
    }

    // Проксируем запрос
    console.log(`[SANDBOX] Proxy ${req.method} /sandbox/${chat_id}/app/${app_name}${appPath} → ${containerIP}:${port}${appPath}`);
    await proxyRequest(req, res, containerIP, port, appPath);
});

// ─────────────────────────────────────────────────────────────────────────────
// Маршрут: /sandbox/:chat_id/* — статические файлы из output/web
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:chat_id/*', async (req, res) => {
    const { chat_id } = req.params;
    const filepath = req.params[0];

    if (!filepath) {
        return res.status(400).send('File path is required');
    }

    try {
        let userDir = storageService.getDataDir(chat_id);

        try {
            await fs.access(userDir);
        } catch (err) {
            const dirs = await fs.readdir(config.DATA_ROOT);
            const matchedDir = dirs.find(d => d.includes(chat_id));
            if (matchedDir) {
                userDir = path.join(config.DATA_ROOT, matchedDir);
            } else {
                return res.status(404).send('User sandbox not found');
            }
        }

        const webDir = path.join(userDir, 'output', 'web');
        const absolutePath = path.resolve(webDir, filepath);

        if (!absolutePath.startsWith(webDir)) {
            return res.status(403).send('Access denied');
        }

        try {
            const stat = await fs.stat(absolutePath);
            if (!stat.isFile()) {
                return res.status(404).send('File not found');
            }
        } catch (err) {
            return res.status(404).send('File not found');
        }

        res.sendFile(absolutePath);
    } catch (error) {
        console.error(`[SANDBOX] Error serving file for ${chat_id}:`, error);
        res.status(500).send('Internal Server Error');
    }
});

module.exports = router;
