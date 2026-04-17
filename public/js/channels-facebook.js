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

    const apiKey = (document.getElementById('facebookBufferApiKey')?.value || document.getElementById('globalBufferApiKey')?.value || '').trim();

    try {
        setFbStatus('Загрузка каналов...', '#666');

        const result = await jfetch(`${API_MANAGE}/channels/buffer/channels`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ buffer_api_key: apiKey, chat_id: chatId })
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

    const apiKey = (document.getElementById('facebookBufferApiKey')?.value || document.getElementById('globalBufferApiKey')?.value || '').trim();
    const channelId = $('fbBufferChannelId').value;

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

        if (cfg.buffer_channel_id) {
            $('fbBufferChannelId').value = cfg.buffer_channel_id;
        }

        // Load scheduler settings
        if (cfg.schedule_time) {
            setFacebookScheduleTimeInputs(cfg.schedule_time);
        } else {
            const hourEl = document.getElementById('facebookScheduleHour');
            const minuteEl = document.getElementById('facebookScheduleMinute');
            if (hourEl) hourEl.value = '10';
            if (minuteEl) minuteEl.value = '00';
            updateFacebookScheduleTime();
        }
        if (cfg.schedule_end_time) {
            setFacebookScheduleEndTimeInputs(cfg.schedule_end_time);
        }
        
        if (cfg.schedule_tz) {
            setFacebookScheduleTzInput(cfg.schedule_tz);
        }
        
        if (cfg.daily_limit) $('facebookDailyLimit').value = cfg.daily_limit;
        if (cfg.publish_interval_hours) {
            const intervalEl = document.getElementById('facebookPublishInterval');
            if (intervalEl) intervalEl.value = cfg.publish_interval_hours.toString();
        }
        
        if (cfg.allowed_weekdays) {
            setWeekdays('facebook-weekday', cfg.allowed_weekdays);
        }
        
        // Load toggles
        const randomPublishEl = document.getElementById('facebookRandomPublish');
        if (randomPublishEl) randomPublishEl.checked = !!cfg.random_publish;
        
        const premoderationEl = document.getElementById('facebookPremoderation');
        if (premoderationEl) {
            premoderationEl.checked = !!cfg.premoderation;
        }
        const facebookModeratorEl = document.getElementById('facebookModeratorUserId');
        if (facebookModeratorEl) facebookModeratorEl.value = cfg.moderator_user_id || '';
        toggleFacebookModeratorField();

        // Статус
        const pageName = cfg.page_name ? `Страница: ${cfg.page_name}` : '';
        setFbStatus(`✅ Facebook ${pageName}`, '#0a0');

    } catch (e) {
        console.warn('loadFacebookConfig:', e.message);
        setFbStatus('Не удалось загрузить настройки', '#f90');
    }
};

// Facebook scheduler helpers
function setFacebookScheduleTimeInputs(timeValue) {
    const [hour, minute] = timeValue.split(':');
    const hourEl = document.getElementById('facebookScheduleHour');
    const minuteEl = document.getElementById('facebookScheduleMinute');
    if (hourEl) hourEl.value = hour || '10';
    if (minuteEl) minuteEl.value = (minute || '00').padStart(2, '0');
    updateFacebookScheduleTime();
}

function updateFacebookScheduleTime() {
    const hour = document.getElementById('facebookScheduleHour')?.value || '00';
    const minute = document.getElementById('facebookScheduleMinute')?.value || '00';
    const timeField = document.getElementById('facebookScheduleTime');
    if (timeField) {
        timeField.value = `${hour}:${minute.padStart(2, '0')}`;
    }
}

function validateFacebookMinutes() {
    const minuteInput = document.getElementById('facebookScheduleMinute');
    if (!minuteInput) return;
    let val = minuteInput.value.replace(/\D/g, '');
    if (val.length > 2) val = val.slice(0, 2);
    if (val !== '' && parseInt(val, 10) > 59) val = '59';
    minuteInput.value = val;
}

function setFacebookScheduleEndTimeInputs(timeValue) {
    const [hour, minute] = timeValue.split(':');
    const hourEl = document.getElementById('facebookScheduleEndHour');
    const minuteEl = document.getElementById('facebookScheduleEndMinute');
    if (hourEl) hourEl.value = hour || '00';
    if (minuteEl) minuteEl.value = (minute || '00').padStart(2, '0');
    updateFacebookScheduleEndTime();
}

function updateFacebookScheduleEndTime() {
    const hour = document.getElementById('facebookScheduleEndHour')?.value || '00';
    const minute = document.getElementById('facebookScheduleEndMinute')?.value || '00';
    const timeField = document.getElementById('facebookScheduleEndTime');
    if (timeField) {
        timeField.value = `${hour}:${minute.padStart(2, '0')}`;
    }
}
window.updateFacebookScheduleEndTime = updateFacebookScheduleEndTime;

function validateFacebookEndMinutes() {
    const minuteInput = document.getElementById('facebookScheduleEndMinute');
    if (!minuteInput) return;
    let val = minuteInput.value.replace(/\D/g, '');
    if (val.length > 2) val = val.slice(0, 2);
    if (val !== '' && parseInt(val, 10) > 59) val = '59';
    minuteInput.value = val;
}
window.validateFacebookEndMinutes = validateFacebookEndMinutes;

function setFacebookScheduleTzInput(tzValue) {
    const tzSelect = document.getElementById('facebookScheduleTz');
    if (!tzSelect || !tzValue) return;
    tzSelect.value = tzValue;
    if (!tzSelect.value) {
        const opt = document.createElement('option');
        opt.value = tzValue;
        opt.textContent = tzValue;
        opt.selected = true;
        tzSelect.appendChild(opt);
    }
}

function toggleFacebookModeratorField() {
    const premoderation = document.getElementById('facebookPremoderation')?.checked || false;
    const moderatorField = document.getElementById('facebookModeratorField');
    if (moderatorField) {
        moderatorField.classList.toggle('visible', premoderation);
    }
}

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

        updateFacebookScheduleEndTime();
        const scheduleTime = document.getElementById('facebookScheduleTime')?.value || '10:00';
        const scheduleEndTime = (document.getElementById('facebookScheduleEndTime')?.value || '').trim();
        const scheduleTz = document.getElementById('facebookScheduleTz')?.value || 'Europe/Moscow';
        const dailyLimit = parseInt(document.getElementById('facebookDailyLimit')?.value || '10', 10);
        const publishInterval = parseFloat(document.getElementById('facebookPublishInterval')?.value || '4');
        const allowedWeekdays = getWeekdays('facebook-weekday');
        const randomPublish = !!document.getElementById('facebookRandomPublish')?.checked;
        const premoderation = !!document.getElementById('facebookPremoderation')?.checked;
        const payload = {
            chat_id: chatId,
            buffer_channel_id: $('fbBufferChannelId').value || null,
            page_name: window.facebookConfig?.page_name || null,
            schedule_time: scheduleTime,
            schedule_end_time: scheduleEndTime,
            schedule_tz: scheduleTz,
            daily_limit: dailyLimit,
            publish_interval_hours: publishInterval,
            allowed_weekdays: allowedWeekdays,
            random_publish: randomPublish,
            premoderation: premoderation,
            moderator_user_id: (document.getElementById('facebookModeratorUserId')?.value || '').trim()
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
            btn.textContent = '▶️ Тест сейчас';
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

