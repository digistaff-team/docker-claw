/* Общие переменные и функции для всех страниц */
let currentChatId = null;
const API_URL = `${window.location.origin}/api`;

function getChatId() {
    return currentChatId || localStorage.getItem('chatId');
}

function showToast(message, type = 'success') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
}

// ─── Лоадер инициализации контейнера ────────────────────────────────────────

const INIT_STEPS = [
    { key: 'Исправление прав доступа', label: 'Настройка прав доступа',     icon: '🔐' },
    { key: 'Создание рабочих папок',   label: 'Создание рабочих папок',      icon: '📁' },
    { key: 'Установка yarn и pnpm',    label: 'Установка yarn и pnpm',       icon: '📦' },
    { key: 'Установка nodemon и pm2',  label: 'Установка nodemon и pm2',     icon: '⚙️' },
    { key: 'Установка TypeScript, ESLint, Prettier', label: 'TypeScript, ESLint, Prettier', icon: '🔷' },
    { key: 'Установка Vite',           label: 'Установка Vite',              icon: '⚡' },
    { key: 'Готово',                   label: 'Финализация окружения',       icon: '✅' },
];

function showInitLoader(chatId) {
    // Убираем старый лоадер если есть
    hideInitLoader();

    const overlay = document.createElement('div');
    overlay.id = 'initLoaderOverlay';
    overlay.className = 'init-loader-overlay';
    overlay.innerHTML = `
        <div class="init-loader-card">
            <div class="init-loader-header">
                <div class="init-spinner"></div>
                <div>
                    <h2 class="init-loader-title">🚀 Подготовка окружения</h2>
                    <p class="init-loader-subtitle">Настраиваем ваш персональный контейнер…</p>
                </div>
            </div>

            <div class="init-progress-wrap">
                <div class="init-progress-bar-bg">
                    <div class="init-progress-bar-fill" id="initProgressFill" style="width:0%"></div>
                </div>
                <span class="init-progress-pct" id="initProgressPct">0%</span>
            </div>

            <div class="init-step-label" id="initStepLabel">Запуск…</div>

            <ul class="init-steps-list" id="initStepsList">
                ${INIT_STEPS.map((s, i) => `
                    <li class="init-step-item" id="initStep_${i}" data-key="${s.key}">
                        <span class="init-step-icon-wrap">
                            <span class="init-step-dot"></span>
                        </span>
                        <span class="init-step-icon">${s.icon}</span>
                        <span class="init-step-name">${s.label}</span>
                        <span class="init-step-status"></span>
                    </li>
                `).join('')}
            </ul>

            <p class="init-loader-note">Это займёт около 1–2 минут при первом запуске</p>
        </div>
    `;
    document.body.appendChild(overlay);
    // Анимация появления
    requestAnimationFrame(() => overlay.classList.add('visible'));
}

function hideInitLoader() {
    const overlay = document.getElementById('initLoaderOverlay');
    if (!overlay) return;
    overlay.classList.remove('visible');
    overlay.classList.add('hiding');
    setTimeout(() => overlay.remove(), 400);
}

function updateInitLoader(status, step, stepIndex, total) {
    const fill = document.getElementById('initProgressFill');
    const pct  = document.getElementById('initProgressPct');
    const label = document.getElementById('initStepLabel');
    if (!fill) return;

    const percent = total > 0 ? Math.round((stepIndex / total) * 100) : 0;
    fill.style.width = percent + '%';
    if (pct) pct.textContent = percent + '%';
    if (label) label.textContent = step || 'Инициализация…';

    // Обновляем состояние шагов
    INIT_STEPS.forEach((s, i) => {
        const el = document.getElementById(`initStep_${i}`);
        if (!el) return;
        el.classList.remove('done', 'active', 'pending');

        if (step === s.key || step === 'Готово' && i === INIT_STEPS.length - 1) {
            el.classList.add('active');
        } else if (stepIndex > i + 1 || status === 'ready') {
            el.classList.add('done');
        } else {
            el.classList.add('pending');
        }
    });
}

let _initPollTimer = null;

function startInitPolling(chatId, onReady) {
    stopInitPolling();

    const poll = async () => {
        try {
            const res = await fetch(`${API_URL}/session/init-status/${encodeURIComponent(chatId)}`);
            if (!res.ok) return;
            const data = await res.json();

            updateInitLoader(data.status, data.step, data.stepIndex, data.total);

            if (data.status === 'ready') {
                stopInitPolling();
                // Небольшая пауза чтобы пользователь увидел 100%
                setTimeout(() => {
                    hideInitLoader();
                    if (typeof onReady === 'function') onReady();
                }, 700);
                return;
            }

            if (data.status === 'error') {
                stopInitPolling();
                hideInitLoader();
                showToast(`Ошибка инициализации: ${data.error || 'неизвестная ошибка'}`, 'error');
                return;
            }
        } catch (e) {
            // сеть недоступна — просто ждём
        }
        _initPollTimer = setTimeout(poll, 1200);
    };

    _initPollTimer = setTimeout(poll, 800);
}

function stopInitPolling() {
    if (_initPollTimer) {
        clearTimeout(_initPollTimer);
        _initPollTimer = null;
    }
}

// ─── Авторизация ─────────────────────────────────────────────────────────────

async function login() {
    const chatIdInput = document.getElementById('chatIdInput');
    if (!chatIdInput) return;
    const chatId = chatIdInput.value.trim();
    if (!chatId) {
        showToast('Введите Chat ID', 'error');
        return;
    }

    currentChatId = chatId;
    localStorage.setItem('chatId', chatId);

    try {
        const response = await fetch(`${API_URL}/session/create`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId })
        });

        if (response.ok) {
            document.getElementById('authSection').style.display = 'none';
            const logoutBtn = document.getElementById('logoutButton');
            if (logoutBtn) logoutBtn.style.display = 'block';

            // Проверяем, нужна ли инициализация
            const initRes = await fetch(`${API_URL}/session/init-status/${encodeURIComponent(chatId)}`);
            const initData = initRes.ok ? await initRes.json() : { status: 'ready' };

            if (initData.status === 'ready' || initData.status === 'unknown') {
                // Контейнер уже готов (восстановленная сессия)
                document.getElementById('mainContent').style.display = 'block';
                if (typeof onLoginSuccess === 'function') await onLoginSuccess();
            } else {
                // Идёт инициализация — показываем лоадер
                showInitLoader(chatId);
                updateInitLoader(initData.status, initData.step, initData.stepIndex, initData.total);
                startInitPolling(chatId, async () => {
                    document.getElementById('mainContent').style.display = 'block';
                    if (typeof onLoginSuccess === 'function') await onLoginSuccess();
                });
            }
        } else {
            const errorData = await response.json().catch(() => ({}));
            showToast(errorData.error || 'Ошибка создания сессии', 'error');
        }
    } catch (error) {
        showToast('Ошибка подключения к серверу', 'error');
    }
}

function logout() {
    if (!confirm('Вы уверены, что хотите выйти? Вы сможете войти с другим Chat ID.')) return;
    stopInitPolling();
    hideInitLoader();
    currentChatId = null;
    localStorage.removeItem('chatId');
    document.getElementById('authSection').style.display = 'block';
    document.getElementById('mainContent').style.display = 'none';
    const logoutBtn = document.getElementById('logoutButton');
    if (logoutBtn) logoutBtn.style.display = 'none';
    const chatIdInput = document.getElementById('chatIdInput');
    if (chatIdInput) chatIdInput.value = '';
    showToast('Вы вышли из системы', 'success');
}

function initAuth() {
    const savedChatId = localStorage.getItem('chatId');
    const authSection = document.getElementById('authSection');
    const mainContent = document.getElementById('mainContent');
    const logoutBtn = document.getElementById('logoutButton');

    if (savedChatId) {
        currentChatId = savedChatId;
        const chatIdInput = document.getElementById('chatIdInput');
        if (chatIdInput) chatIdInput.value = savedChatId;
        if (logoutBtn) logoutBtn.style.display = 'block';
        login();
    } else {
        if (authSection) authSection.style.display = 'block';
        if (mainContent) mainContent.style.display = 'none';
        if (logoutBtn) logoutBtn.style.display = 'none';
    }
}

// ─── Утилиты ─────────────────────────────────────────────────────────────────

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

/**
 * Рендерит навигационное меню
 * @param {string} currentPage - URL текущей страницы (например, '/' или '/tasks.html')
 */
function renderMenu(currentPage) {
    const menuContainer = document.getElementById('mainMenu');
    if (!menuContainer) return;

    const menuItems = [
        { href: '/', label: '🎭 Личность' },
        { href: '/files.html', label: '📁 Файлы' },
        { href: '/channels.html', label: '📡 Каналы' },
        { href: '/ai.html', label: '🤖 ИИ' },
        { href: '/skills.html', label: '🎯 Навыки' },
        { href: '/tasks.html', label: '📋 Задачи' },
        { href: '/apps.html', label: '🚀 Приложения' },
        { href: '/console.html', label: '💻 Консоль' },
        { href: '/info.html', label: '📊 Инфо' }
    ];

    const html = menuItems.map(item => {
        const isActive = item.href === currentPage ? ' class="active"' : '';
        return `<a href="${item.href}"${isActive}>${item.label}</a>`;
    }).join('');

    menuContainer.innerHTML = html;
}
