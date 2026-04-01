const API_MANAGE = `${window.location.origin}/api/manage`;

let codeVerified = false;

async function onLoginSuccess() {
    // Показываем форму настройки
    // mainContent уже показан через common.js после авторизации
}

/**
 * Открыть диалог с ботом Копирайтер
 */
async function connectBot() {
    try {
        const response = await fetch(`${API_MANAGE}/cw-bot-info`, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' }
        });
        const data = await response.json();
        if (data.username) {
            window.open(`https://t.me/${data.username}`, '_blank');
        } else {
            showError('Не удалось получить информацию о боте');
        }
    } catch (e) {
        console.error('Connect bot error:', e);
        showError(`Ошибка подключения: ${e.message}`);
    }
}

/**
 * Подтвердить код из бота
 */
async function verifyCode() {
    const code = document.getElementById('verifyCodeInput').value.trim();
    if (!code || code.length !== 6) {
        showError('Введите 6-значный код');
        return;
    }

    const statusDiv = document.getElementById('verifyStatusDiv');
    statusDiv.innerHTML = '<div class="spinner" style="width: 20px; height: 20px; display: inline-block;"></div> Проверка...';
    statusDiv.style.color = '';

    try {
        const response = await fetch(`${API_MANAGE}/telegram/verify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: currentChatId,
                code: code
            })
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || `HTTP ${response.status}`);
        }

        codeVerified = true;
        statusDiv.innerHTML = '✅ Подтверждено';
        statusDiv.style.color = 'green';
        document.getElementById('verifyCodeInput').disabled = true;
        document.getElementById('verifyCodeBtn').disabled = true;
        updateSaveButton();
        showSuccess('Аккаунт подтвержден. Выберите каналы и сохраните.');
    } catch (e) {
        codeVerified = false;
        statusDiv.innerHTML = `❌ ${e.message}`;
        statusDiv.style.color = 'red';
        showError(`Ошибка подтверждения: ${e.message}`);
    }
}

/**
 * Получить выбранные каналы
 */
function getSelectedChannels() {
    const channels = [];
    document.querySelectorAll('.channel-checkbox input[type="checkbox"]:checked').forEach(cb => {
        channels.push(cb.value);
    });
    return channels;
}

/**
 * Обновить статус кнопки сохранения
 */
function updateSaveButton() {
    const channels = getSelectedChannels();
    const saveBtn = document.getElementById('saveBtn');

    // Кнопка активна если: код подтвержден, выбраны каналы
    const isEnabled = codeVerified && channels.length > 0;
    saveBtn.disabled = !isEnabled;
}

/**
 * Сохранить настройки
 */
async function saveSetup() {
    const channels = getSelectedChannels();

    if (!codeVerified) {
        showError('Сначала подтвердите код');
        return;
    }

    if (channels.length === 0) {
        showError('Выберите хотя бы один канал');
        return;
    }

    showLoading(true);
    clearMessages();

    try {
        const response = await fetch(`${API_MANAGE}/setup`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: currentChatId,
                channels: channels
            })
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || `HTTP ${response.status}`);
        }

        showSuccess('Настройка завершена. Переход в раздел Каналы...');

        // Сохраняем, что онбординг завершён
        localStorage.setItem('onboardingComplete', 'true');

        // Переходим на channels.html
        setTimeout(() => {
            window.location.href = '/channels.html';
        }, 1500);
    } catch (e) {
        console.error('Save setup error:', e);
        showError(`Ошибка при сохранении: ${e.message}`);
    } finally {
        showLoading(false);
    }
}

/**
 * Показать/скрыть загрузку
 */
function showLoading(show = true) {
    document.getElementById('loadingDiv').style.display = show ? 'block' : 'none';
}

/**
 * Показать сообщение об ошибке
 */
function showError(msg) {
    const div = document.getElementById('errorMessage');
    div.textContent = msg;
    div.style.display = 'block';
    document.getElementById('successMessage').style.display = 'none';
}

/**
 * Показать сообщение об успехе
 */
function showSuccess(msg) {
    const div = document.getElementById('successMessage');
    div.textContent = msg;
    div.style.display = 'block';
    document.getElementById('errorMessage').style.display = 'none';
}

/**
 * Очистить сообщения
 */
function clearMessages() {
    document.getElementById('errorMessage').style.display = 'none';
    document.getElementById('successMessage').style.display = 'none';
}

// Инициализация при загрузке страницы
document.addEventListener('DOMContentLoaded', async () => {
    // Сначала проверяем, если пользователь уже прошёл онбординг — перенаправляем
    if (currentChatId) {
        try {
            const res = await fetch(`${API_MANAGE}/setup?chat_id=${encodeURIComponent(currentChatId)}`);
            if (res.ok) {
                const setup = await res.json();
                if (setup.onboardingComplete) {
                    // Пользователь уже прошёл онбординг — перенаправляем
                    window.location.href = '/channels.html';
                    return;
                }
            }
        } catch (e) {
            console.error('Error checking onboarding status:', e);
        }
    }

    // Кнопка "Подключить"
    document.getElementById('connectBotBtn').addEventListener('click', connectBot);

    // Кнопка "Подтвердить" (код)
    document.getElementById('verifyCodeBtn').addEventListener('click', verifyCode);

    // Кнопка "Сохранить и продолжить"
    document.getElementById('saveBtn').addEventListener('click', saveSetup);

    // Обновляем статус кнопки при выборе/отключении каналов
    document.querySelectorAll('.channel-checkbox input[type="checkbox"]').forEach(cb => {
        cb.addEventListener('change', updateSaveButton);
    });

    // Инициализация аутентификации (из common.js)
    initAuth();
});
