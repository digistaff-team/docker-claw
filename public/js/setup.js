const API_MANAGE = `${window.location.origin}/api/manage`;

let botTokenValid = false;

async function onLoginSuccess() {
    // Показываем форму настройки
    // mainContent уже показан через common.js после авторизации

    // Фокус на поле токена
    document.getElementById('botTokenInput').focus();
}

/**
 * Проверить токен бота через API
 */
async function verifyBotToken() {
    const token = document.getElementById('botTokenInput').value.trim();
    if (!token) {
        showError('Введите токен бота');
        botTokenValid = false;
        updateSaveButton();
        return;
    }

    const statusDiv = document.getElementById('botStatusDiv');
    statusDiv.innerHTML = '<div class="spinner" style="width: 20px; height: 20px; display: inline-block;"></div> Проверка...';

    try {
        // Простая проверка через API: попробуем сохранить и получить статус
        const response = await fetch(`${API_MANAGE}/telegram/status?chat_id=${encodeURIComponent(currentChatId)}`, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' }
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        // На данном этапе просто проверяем формат токена и доступность API
        // Реальная проверка произойдёт при сохранении
        if (token.length > 20 && token.includes(':')) {
            botTokenValid = true;
            statusDiv.innerHTML = '✅ Формат токена корректен';
            showSuccess('Токен проверен. Убедитесь, что выбрали нужные каналы и нажмите "Сохранить".');
        } else {
            throw new Error('Неверный формат токена');
        }
    } catch (e) {
        botTokenValid = false;
        statusDiv.innerHTML = `❌ Ошибка: ${e.message}`;
        showError(`Не удалось проверить токен: ${e.message}`);
    }

    updateSaveButton();
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
    const botToken = document.getElementById('botTokenInput').value.trim();
    const channels = getSelectedChannels();
    const saveBtn = document.getElementById('saveBtn');

    // Кнопка активна если: токен введён, токен проверен, выбраны каналы
    const isEnabled = botToken && botTokenValid && channels.length > 0;
    saveBtn.disabled = !isEnabled;
}

/**
 * Сохранить настройки
 */
async function saveSetup() {
    const token = document.getElementById('botTokenInput').value.trim();
    const channels = getSelectedChannels();

    if (!token) {
        showError('Введите токен бота');
        return;
    }

    if (!botTokenValid) {
        showError('Проверьте токен бота');
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
                token: token,
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
document.addEventListener('DOMContentLoaded', () => {
    // Кнопка "Проверить токен"
    document.getElementById('verifyBotBtn').addEventListener('click', verifyBotToken);

    // Кнопка "Сохранить и продолжить"
    document.getElementById('saveBtn').addEventListener('click', saveSetup);

    // Обновляем статус кнопки при вводе токена
    document.getElementById('botTokenInput').addEventListener('input', () => {
        botTokenValid = false; // Сброс проверки при изменении
        document.getElementById('botStatusDiv').innerHTML = '';
        updateSaveButton();
    });

    // Обновляем статус кнопки при выборе/отключении каналов
    document.querySelectorAll('.channel-checkbox input[type="checkbox"]').forEach(cb => {
        cb.addEventListener('change', updateSaveButton);
    });

    // Инициализация аутентификации (из common.js)
    initAuth();
});
