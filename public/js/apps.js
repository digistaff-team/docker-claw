/* ─── Страница "Приложения" (PM2) ─────────────────────────────────────────── */

let appsAutoUpdateTimer = null;
let currentLogsApp     = null;
let currentLogsLines   = 50;
let appsFirstLoad      = true;   // первая загрузка — рисуем всё с нуля
let lastAppsData       = [];     // кэш последнего списка для тихого обновления

// ─── Утилиты ─────────────────────────────────────────────────────────────────

function formatMemory(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + units[i];
}

function formatUptime(ms) {
    if (!ms) return '—';
    const diff = Date.now() - ms;
    if (diff < 0) return '—';
    const s = Math.floor(diff / 1000);
    if (s < 60)  return s + 'с';
    const m = Math.floor(s / 60);
    if (m < 60)  return m + 'м';
    const h = Math.floor(m / 60);
    if (h < 24)  return h + 'ч ' + (m % 60) + 'м';
    return Math.floor(h / 24) + 'д ' + (h % 24) + 'ч';
}

function statusLabel(status) {
    const map = { online: 'Online', stopped: 'Stopped', errored: 'Errored', launching: 'Launching' };
    return map[status] || status;
}

function statusIcon(status) {
    const map = { online: '●', stopped: '■', errored: '✕', launching: '◌' };
    return map[status] || '?';
}

// ─── Рендер карточки ─────────────────────────────────────────────────────────

function renderAppCard(app) {
    const chatId      = getChatId();
    const statusClass = ['online','stopped','errored','launching'].includes(app.status) ? app.status : 'unknown';
    const isOnline    = app.status === 'online';
    const isStopped   = app.status === 'stopped' || app.status === 'errored';
    const isErrored   = app.status === 'errored';

    const appName  = escapeHtml(app.name);
    const appUrl   = `/sandbox/${encodeURIComponent(chatId)}/app/${encodeURIComponent(app.name)}/`;
    const portInfo = app.port ? `<span class="app-port-badge">:${app.port}</span>` : '';

    return `
    <div class="app-card status-${statusClass}" id="app-card-${app.id}">

        <!-- Шапка -->
        <div class="app-card-header">
            <div class="app-card-title">
                <div class="app-card-id">${app.id}</div>
                <div class="app-card-name" title="${appName}">${appName}</div>
                ${portInfo}
            </div>
            <span class="app-status-badge ${statusClass}">
                ${statusIcon(app.status)} ${statusLabel(app.status)}
            </span>
        </div>

        <!-- Метрики -->
        <div class="app-metrics">
            <div class="app-metric">
                <div class="app-metric-label">CPU</div>
                <div class="app-metric-value">${app.cpu ?? 0}%</div>
            </div>
            <div class="app-metric">
                <div class="app-metric-label">RAM</div>
                <div class="app-metric-value">${formatMemory(app.memory)}</div>
            </div>
            <div class="app-metric">
                <div class="app-metric-label">Uptime</div>
                <div class="app-metric-value">${formatUptime(app.uptime)}</div>
            </div>
            <div class="app-metric">
                <div class="app-metric-label">Рестарты</div>
                <div class="app-metric-value">${app.restarts}</div>
            </div>
            <div class="app-metric">
                <div class="app-metric-label">PID</div>
                <div class="app-metric-value">${app.pid ?? '—'}</div>
            </div>
            <div class="app-metric">
                <div class="app-metric-label">Режим</div>
                <div class="app-metric-value">${(app.exec_mode || 'fork').replace('_mode','')}</div>
            </div>
        </div>

        <!-- Путь к скрипту -->
        ${app.script ? `<div class="app-script-path" title="${escapeHtml(app.script)}">📄 ${escapeHtml(app.script)}</div>` : ''}

        <!-- Предупреждение для сломанных приложений -->
        ${isErrored ? `
        <div class="app-error-hint">
            ⚠️ Приложение упало. Возможно, оно создано в старом формате.
            <button class="app-btn btn-fix" onclick="fixApp('${appName}')">🔧 Починить автоматически</button>
        </div>` : ''}

        <!-- Кнопки: строка 1 — главные действия -->
        <div class="app-actions-row">
            <a class="app-btn btn-open" href="${appUrl}" target="_blank">
                🌐 Открыть
            </a>
            <button class="app-btn btn-logs" onclick="openLogs('${appName}')">
                📋 Логи
            </button>
        </div>

        <!-- Кнопки: строка 2 — управление -->
        <div class="app-actions-row app-actions-ctrl">
            <button class="app-btn btn-start"   ${isOnline ? 'disabled' : ''}  onclick="appAction('start',   '${appName}')">▶ Старт</button>
            <button class="app-btn btn-stop"    ${isStopped ? 'disabled' : ''} onclick="appAction('stop',    '${appName}')">■ Стоп</button>
            <button class="app-btn btn-restart"                                onclick="appAction('restart', '${appName}')">↺ Рестарт</button>
            <button class="app-btn btn-delete"                                 onclick="appAction('delete',  '${appName}')">🗑</button>
        </div>
    </div>`;
}

// ─── Тихое обновление данных в существующих карточках ────────────────────────

function silentUpdateCard(app) {
    const card = document.getElementById(`app-card-${app.id}`);
    if (!card) return false;   // карточки нет — нужен полный ре-рендер

    const statusClass = ['online','stopped','errored','launching'].includes(app.status) ? app.status : 'unknown';
    const isOnline    = app.status === 'online';
    const isStopped   = app.status === 'stopped' || app.status === 'errored';

    // Обновляем класс карточки
    card.className = `app-card status-${statusClass}`;

    // Бейдж статуса
    const badge = card.querySelector('.app-status-badge');
    if (badge) {
        badge.className = `app-status-badge ${statusClass}`;
        badge.textContent = `${statusIcon(app.status)} ${statusLabel(app.status)}`;
    }

    // Метрики — ищем по порядку внутри .app-metrics
    const metrics = card.querySelectorAll('.app-metric-value');
    if (metrics.length >= 6) {
        metrics[0].textContent = (app.cpu ?? 0) + '%';
        metrics[1].textContent = formatMemory(app.memory);
        metrics[2].textContent = formatUptime(app.uptime);
        metrics[3].textContent = app.restarts;
        metrics[4].textContent = app.pid ?? '—';
        metrics[5].textContent = (app.exec_mode || 'fork').replace('_mode','');
    }

    // Кнопки управления
    const btnStart   = card.querySelector('.btn-start');
    const btnStop    = card.querySelector('.btn-stop');
    if (btnStart) btnStart.disabled = isOnline;
    if (btnStop)  btnStop.disabled  = isStopped;

    return true;
}

// ─── Загрузка / обновление списка ────────────────────────────────────────────

async function loadApps(silent = false) {
    const chatId = getChatId();
    if (!chatId) return;

    const grid  = document.getElementById('appsGrid');
    const badge = document.getElementById('appsCountBadge');

    // При первой загрузке показываем спиннер
    if (appsFirstLoad) {
        grid.innerHTML = `
            <div class="apps-empty" style="grid-column:1/-1">
                <span class="apps-empty-icon">⏳</span><p>Загрузка…</p>
            </div>`;
    }

    try {
        const res = await fetch(`${API_URL}/apps/${encodeURIComponent(chatId)}`);

        const contentType = res.headers.get('content-type') || '';
        if (!contentType.includes('application/json')) {
            throw new Error(`Сервер вернул неожиданный ответ (HTTP ${res.status})`);
        }

        const data = await res.json();

        if (!data.success) {
            if (res.status === 404 || (data.error && data.error.includes('Session not found'))) {
                // Сессия не в памяти — пробуем пересоздать через login и повторить
                if (!silent) {
                    try {
                        await fetch(`${API_URL}/session/create`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ chat_id: chatId })
                        });
                        // Повторяем запрос после создания сессии
                        const retry = await fetch(`${API_URL}/apps/${encodeURIComponent(chatId)}`);
                        const retryData = await retry.json();
                        if (retryData.success) {
                            if (badge) badge.textContent = `${retryData.count} процессов`;
                            if (retryData.count === 0) {
                                lastAppsData = [];
                                grid.innerHTML = `
                                    <div class="apps-empty" style="grid-column:1/-1">
                                        <span class="apps-empty-icon">🚀</span>
                                        <p>Нет запущенных приложений</p>
                                        <small>Запустите приложение через консоль: <code>pm2 start app.js --name myapp</code></small>
                                    </div>`;
                            } else {
                                grid.innerHTML = retryData.apps.map(renderAppCard).join('');
                                lastAppsData = retryData.apps;
                            }
                            appsFirstLoad = false;
                            return;
                        }
                    } catch (_) { /* ignore retry errors */ }

                    grid.innerHTML = `
                        <div class="apps-empty" style="grid-column:1/-1">
                            <span class="apps-empty-icon">🔌</span>
                            <p>Контейнер не запущен</p>
                            <small>Перейдите в <a href="/console.html" style="color:#667eea">Консоль</a> — она автоматически запустит контейнер.</small>
                        </div>`;
                }
                if (badge) badge.textContent = '— процессов';
                return;
            }
            throw new Error(data.error || 'Ошибка загрузки');
        }

        if (badge) badge.textContent = `${data.count} процессов`;

        if (data.count === 0) {
            lastAppsData = [];
            grid.innerHTML = `
                <div class="apps-empty" style="grid-column:1/-1">
                    <span class="apps-empty-icon">🚀</span>
                    <p>Нет запущенных приложений</p>
                    <small>Запустите приложение через консоль: <code>pm2 start app.js --name myapp</code></small>
                </div>`;
            appsFirstLoad = false;
            return;
        }

        // Проверяем: изменился ли состав приложений (id-набор)?
        const newIds  = data.apps.map(a => a.id).sort().join(',');
        const prevIds = lastAppsData.map(a => a.id).sort().join(',');

        if (!appsFirstLoad && newIds === prevIds) {
            // Тихое обновление — только данные, без перерисовки DOM
            data.apps.forEach(silentUpdateCard);
        } else {
            // Полный ре-рендер (первая загрузка или изменился состав)
            grid.innerHTML = data.apps.map(renderAppCard).join('');
        }

        lastAppsData  = data.apps;
        appsFirstLoad = false;

    } catch (err) {
        if (!silent) {
            grid.innerHTML = `
                <div class="apps-empty" style="grid-column:1/-1">
                    <span class="apps-empty-icon">⚠️</span>
                    <p style="color:#ff6b6b">Ошибка загрузки</p>
                    <small style="color:#aaa">${escapeHtml(err.message)}</small>
                </div>`;
            if (badge) badge.textContent = '— процессов';
        }
    }
}

// ─── Починить сломанное приложение ───────────────────────────────────────────

async function fixApp(name) {
    const chatId = getChatId();
    if (!chatId) return;

    showToast(`🔧 Починяю «${name}»… это займёт ~15 сек`);

    try {
        const res  = await fetch(`${API_URL}/apps/${encodeURIComponent(chatId)}/fix/${encodeURIComponent(name)}`, {
            method: 'POST',
        });
        const data = await res.json();

        if (data.success) {
            showToast(`✅ «${name}» починено! Порт: ${data.port}`, 'success');
        } else {
            showToast(`❌ Не удалось починить: ${data.error || data.output?.slice(0,100)}`, 'error');
        }

        appsFirstLoad = true;
        setTimeout(() => loadApps(), 1500);
    } catch (err) {
        showToast(`Ошибка: ${err.message}`, 'error');
    }
}

// ─── Действия над приложением ─────────────────────────────────────────────────

async function appAction(action, name) {
    const chatId = getChatId();
    if (!chatId) return;

    if (action === 'delete' && !confirm(`Удалить приложение «${name}»?\n\n⚠️ Будут удалены:\n• Процесс из PM2\n• Все файлы приложения\n• Логи\n\nЭто действие необратимо!`)) return;

    const labels = { start: 'Запуск', stop: 'Остановка', restart: 'Рестарт', delete: 'Удаление' };
    showToast(`${labels[action] || action} «${name}»…`);

    try {
        const res  = await fetch(`${API_URL}/apps/${encodeURIComponent(chatId)}/${action}`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ name }),
        });
        const data = await res.json();

        if (data.success) {
            showToast(`✅ ${labels[action]} выполнен: «${name}»`, 'success');
        } else {
            showToast(`❌ Ошибка: ${data.output || data.error}`, 'error');
        }

        // Принудительный полный ре-рендер после действия
        appsFirstLoad = true;
        setTimeout(() => loadApps(), 900);
    } catch (err) {
        showToast(`Ошибка: ${err.message}`, 'error');
    }
}

// ─── Модальное окно «Открыть приложение» ─────────────────────────────────────

function openApp(name, chatId) {
    const url = `/sandbox/${encodeURIComponent(chatId)}/app/${encodeURIComponent(name)}/`;

    let overlay = document.getElementById('appViewOverlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'appViewOverlay';
        overlay.className = 'appview-overlay';
        overlay.innerHTML = `
            <div class="appview-modal">
                <div class="appview-header">
                    <div class="appview-title">
                        <span class="appview-icon">🌐</span>
                        <span id="appViewTitle"></span>
                    </div>
                    <div class="appview-controls">
                        <a id="appViewExtLink" href="#" target="_blank" class="appview-ctrl-btn" title="Открыть в новой вкладке">↗</a>
                        <button class="appview-ctrl-btn" onclick="reloadAppFrame()" title="Обновить">↺</button>
                        <button class="appview-ctrl-btn appview-close" onclick="closeApp()" title="Закрыть">✕</button>
                    </div>
                </div>
                <div class="appview-body">
                    <iframe id="appViewFrame" src="" frameborder="0" allowfullscreen></iframe>
                </div>
                <div class="appview-footer">
                    <span class="appview-url" id="appViewUrl"></span>
                    <span class="appview-hint">Нажмите Esc или кликните вне окна для закрытия</span>
                </div>
            </div>`;
        overlay.addEventListener('click', e => { if (e.target === overlay) closeApp(); });
        document.addEventListener('keydown', e => { if (e.key === 'Escape') closeApp(); });
        document.body.appendChild(overlay);
    }

    document.getElementById('appViewTitle').textContent  = name;
    document.getElementById('appViewUrl').textContent    = url;
    document.getElementById('appViewExtLink').href       = url;
    document.getElementById('appViewFrame').src          = url;

    requestAnimationFrame(() => overlay.classList.add('visible'));
}

function reloadAppFrame() {
    const frame = document.getElementById('appViewFrame');
    if (frame) frame.src = frame.src;
}

function closeApp() {
    const overlay = document.getElementById('appViewOverlay');
    if (!overlay) return;
    overlay.classList.remove('visible');
    setTimeout(() => {
        const frame = document.getElementById('appViewFrame');
        if (frame) frame.src = 'about:blank';   // останавливаем приложение в iframe
    }, 300);
}

// ─── Модальное окно логов ─────────────────────────────────────────────────────

async function openLogs(name) {
    currentLogsApp   = name;
    currentLogsLines = 50;

    let overlay = document.getElementById('logsModalOverlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'logsModalOverlay';
        overlay.className = 'logs-modal-overlay';
        overlay.innerHTML = `
            <div class="logs-modal">
                <div class="logs-modal-header">
                    <span class="logs-modal-title">📋 Логи: <span id="logsModalAppName"></span></span>
                    <button class="logs-modal-close" onclick="closeLogs()">✕</button>
                </div>
                <div class="logs-modal-body" id="logsModalBody">Загрузка…</div>
                <div class="logs-modal-footer">
                    <select class="logs-lines-select" id="logsLinesSelect" onchange="reloadLogs()">
                        <option value="30">30 строк</option>
                        <option value="50" selected>50 строк</option>
                        <option value="100">100 строк</option>
                        <option value="200">200 строк</option>
                        <option value="500">500 строк</option>
                    </select>
                    <button class="btn btn-secondary" onclick="reloadLogs()" style="font-size:13px;padding:6px 14px;">🔄 Обновить</button>
                    <button class="btn btn-secondary" onclick="closeLogs()"  style="font-size:13px;padding:6px 14px;">✕ Закрыть</button>
                </div>
            </div>`;
        overlay.addEventListener('click', e => { if (e.target === overlay) closeLogs(); });
        document.body.appendChild(overlay);
    }

    document.getElementById('logsModalAppName').textContent = name;
    document.getElementById('logsModalBody').textContent    = 'Загрузка…';
    await fetchLogs(name, currentLogsLines);
}

async function fetchLogs(name, lines) {
    const chatId = getChatId();
    if (!chatId) return;
    const body = document.getElementById('logsModalBody');
    if (!body) return;
    try {
        const res  = await fetch(`${API_URL}/apps/${encodeURIComponent(chatId)}/${encodeURIComponent(name)}/logs?lines=${lines}`);
        const data = await res.json();
        body.textContent = data.lines || '(нет логов)';
        body.scrollTop   = body.scrollHeight;
    } catch (err) {
        body.textContent = `Ошибка: ${err.message}`;
    }
}

async function reloadLogs() {
    if (!currentLogsApp) return;
    const lines = parseInt(document.getElementById('logsLinesSelect')?.value || 50);
    currentLogsLines = lines;
    await fetchLogs(currentLogsApp, lines);
}

function closeLogs() {
    const overlay = document.getElementById('logsModalOverlay');
    if (overlay) overlay.remove();
    currentLogsApp = null;
}

// ─── Авто-обновление ──────────────────────────────────────────────────────────

function toggleAutoUpdate(enabled) {
    if (appsAutoUpdateTimer) {
        clearInterval(appsAutoUpdateTimer);
        appsAutoUpdateTimer = null;
    }
    if (enabled) {
        // silent=true — не мигаем, не сбрасываем DOM
        appsAutoUpdateTimer = setInterval(() => loadApps(true), 5000);
    }
}

// ─── Инициализация ────────────────────────────────────────────────────────────

async function onLoginSuccess() {
    appsFirstLoad = true;
    await loadApps();

    const cb = document.getElementById('autoUpdateCheckbox');
    if (cb && cb.checked) toggleAutoUpdate(true);
}
