// Facebook Channels UI

const API = `${window.location.origin}/api`;
const API_MANAGE = `${window.location.origin}/api/manage`;
const API_CONTENT = `${window.location.origin}/api/content`;

/**
 * Загрузка каналов из Buffer API
 */
window.fetchFacebookBufferChannels = async function() {
    const chatId = getChatId();
    if (!chatId) {
        setFbStatus('Сначала войдите в систему', '#c00');
        return;
    }

    const apiKey = $('fbBufferApiKey').value.trim();
    if (!apiKey) {
        setFbStatus('Введите Buffer API Token', '#c00');
        return;
    }

    try {
        setFbStatus('Загрузка каналов...', '#666');

        const result = await jfetch(`${API_MANAGE}/channels/buffer/channels`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ buffer_api_key: apiKey })
        });

        if (!result.success || !result.channels) {
            throw new Error(result.error || 'Не удалось загрузить каналы');
        }

        // Фильтруем только Facebook каналы
        const fbChannels = result.channels.filter(ch => ch.service === 'facebook');

        if (fbChannels.length === 0) {
            setFbStatus('В Buffer нет подключённых Facebook страниц', '#f90');
            $('fbBufferChannelId').innerHTML = '<option value="">-- Нет Facebook каналов --</option>';
            return;
        }

        const select = $('fbBufferChannelId');
        select.innerHTML = fbChannels.map(ch =>
            `<option value="${ch.id}">${escapeHtml(ch.name)} (ID: ${ch.id})</option>`
        ).join('');

        // Если есть сохранённый channel_id, выбираем его
        const savedConfig = window.facebookConfig || {};
        if (savedConfig.buffer_channel_id) {
            const option = select.querySelector(`option[value="${savedConfig.buffer_channel_id}"]`);
            if (option) option.selected = true;
        }

        setFbStatus(`Загружено ${fbChannels.length} Facebook каналов`, '#0a0');
    } catch (e) {
        setFbStatus(`Ошибка: ${e.message}`, '#c00');
        console.error('fetchFacebookBufferChannels:', e);
    }
};

/**
 * Проверка подключения к Buffer
 */
window.testFacebookBufferConnection = async function() {
    const chatId = getChatId();
    if (!chatId) {
        setFbStatus('Сначала войдите в систему', '#c00');
        return;
    }

    const apiKey = $('fbBufferApiKey').value.trim();
    const channelId = $('fbBufferChannelId').value;

    if (!apiKey) {
        setFbStatus('Введите Buffer API Token', '#c00');
        return;
    }

    if (!channelId) {
        setFbStatus('Выберите Facebook канал', '#c00');
        return;
    }

    try {
        setFbStatus('Проверка подключения...', '#666');

        const result = await jfetch(`${API_MANAGE}/channels/facebook/test-buffer`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                buffer_api_key: apiKey,
                buffer_channel_id: channelId
            })
        });

        if (result.success) {
            setFbStatus(`✅ Подключено: ${result.channelName || result.service}`, '#0a0');
        } else {
            setFbStatus(`❌ ${result.error || 'Не удалось подключиться'}`, '#c00');
        }
    } catch (e) {
        setFbStatus(`❌ ${e.message}`, '#c00');
        console.error('testFacebookBufferConnection:', e);
    }
};

/**
 * Загрузка конфигурации Facebook
 */
window.loadFacebookConfig = async function() {
    const chatId = getChatId();
    if (!chatId) return;

    try {
        const result = await jfetch(`${API_MANAGE}/channels/facebook?chat_id=${encodeURIComponent(chatId)}`);

        if (!result.connected || !result.config) {
            setFbStatus('Facebook не подключён', '#666');
            return;
        }

        const cfg = result.config;
        window.facebookConfig = cfg;

        // Buffer credentials (замаскированы, не перезаписываем)
        if (!cfg.buffer_api_key || cfg.buffer_api_key.endsWith('***')) {
            $('fbBufferApiKey').value = '';
        } else {
            $('fbBufferApiKey').value = cfg.buffer_api_key;
        }

        if (cfg.buffer_channel_id) {
            $('fbBufferChannelId').value = cfg.buffer_channel_id;
        }

        // Настройки
        $('fbActive').checked = !!cfg.is_active;
        $('fbAutoPublish').checked = !!cfg.auto_publish;
        $('fbRandomPublish').checked = !!cfg.random_publish;

        if (cfg.schedule_time) $('fbScheduleTime').value = cfg.schedule_time;
        if (cfg.schedule_tz) $('fbScheduleTz').value = cfg.schedule_tz;
        if (cfg.daily_limit) $('fbDailyLimit').value = cfg.daily_limit;
        if (cfg.publish_interval_hours) $('fbIntervalHours').value = cfg.publish_interval_hours;
        if (cfg.moderator_user_id) $('fbModeratorUserId').value = cfg.moderator_user_id;

        // Дни недели
        const days = cfg.allowed_weekdays || [0, 1, 2, 3, 4, 5, 6];
        document.querySelectorAll('#fbWeekdays input[data-day]').forEach(input => {
            input.checked = days.includes(parseInt(input.dataset.day, 10));
        });

        // Статус
        const pageName = cfg.page_name ? `Страница: ${cfg.page_name}` : '';
        setFbStatus(`✅ Facebook ${pageName}`, '#0a0');

        // Показываем блок настроек
        $('facebookSettingsBlock').style.display = 'block';

    } catch (e) {
        console.warn('loadFacebookConfig:', e.message);
        setFbStatus('Не удалось загрузить настройки', '#f90');
    }
};

/**
 * Сохранение конфигурации Facebook
 */
window.saveFacebookConfig = async function() {
    const chatId = getChatId();
    if (!chatId) {
        setFbStatus('Сначала войдите в систему', '#c00');
        return;
    }

    try {
        setFbStatus('Сохранение...', '#666');

        const days = [];
        document.querySelectorAll('#fbWeekdays input[data-day]:checked').forEach(input => {
            days.push(parseInt(input.dataset.day, 10));
        });

        const payload = {
            chat_id: chatId,
            buffer_api_key: $('fbBufferApiKey').value.trim() || null,
            buffer_channel_id: $('fbBufferChannelId').value || null,
            page_name: window.facebookConfig?.page_name || null,
            is_active: $('fbActive').checked,
            auto_publish: $('fbAutoPublish').checked,
            schedule_time: $('fbScheduleTime').value,
            schedule_tz: $('fbScheduleTz').value,
            daily_limit: parseInt($('fbDailyLimit').value, 10) || 10,
            publish_interval_hours: parseFloat($('fbIntervalHours').value) || 4,
            allowed_weekdays: days,
            random_publish: $('fbRandomPublish').checked,
            moderator_user_id: $('fbModeratorUserId').value.trim() || null
        };

        await jfetch(`${API_MANAGE}/channels/facebook`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        // Перезагружаем конфиг
        await loadFacebookConfig();
        setFbStatus('✅ Сохранено', '#0a0');

        showToast('Настройки Facebook сохранены', 'success');

    } catch (e) {
        setFbStatus(`❌ ${e.message}`, '#c00');
        console.error('saveFacebookConfig:', e);
    }
};

/**
 * Запуск генерации сейчас
 */
window.runFacebookNow = async function() {
    const chatId = getChatId();
    if (!chatId) {
        setFbStatus('Сначала войдите в систему', '#c00');
        return;
    }

    try {
        const btn = $('fbRunNowBtn');
        if (btn) {
            btn.disabled = true;
            btn.textContent = '⏳ Генерация...';
        }

        setFbStatus('Запуск генерации...', '#666');

        await jfetch(`${API_CONTENT}/facebook/run-now`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                reason: 'manual_ui'
            })
        });

        setFbStatus('✅ Генерация запущена. Проверьте статус в разделе "Контент"', '#0a0');
        showToast('Facebook генерация запущена', 'success');

    } catch (e) {
        setFbStatus(`❌ ${e.message}`, '#c00');
        console.error('runFacebookNow:', e);
    } finally {
        const btn = $('fbRunNowBtn');
        if (btn) {
            btn.disabled = false;
            btn.textContent = '▶️ Сгенерировать сейчас';
        }
    }
};

// Утилиты

function $(id) {
    return document.getElementById(id);
}

function setFbStatus(msg, color) {
    const el = $('facebookStatus');
    if (el) {
        el.textContent = msg;
        el.style.color = color || '#666';
    }
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

async function jfetch(url, opts) {
    const res = await fetch(url, opts);
    let data = null;
    try { data = await res.json(); } catch (e) {}
    if (!res.ok) {
        throw new Error((data && (data.error || data.message)) || `HTTP ${res.status}`);
    }
    return data || {};
}

// Автозагрузка каналов при изменении API ключа
document.addEventListener('DOMContentLoaded', () => {
    const apiKeyInput = $('fbBufferApiKey');
    if (apiKeyInput) {
        apiKeyInput.addEventListener('change', () => {
            const apiKey = apiKeyInput.value.trim();
            if (apiKey && !apiKey.endsWith('***')) {
                fetchFacebookBufferChannels();
            }
        });
    }
});
