const API_MANAGE = `${window.location.origin}/api/manage`;
const API_CONTENT = `${window.location.origin}/api/content`;

// === Переключение табов каналов ===
function initChannelTabs() {
    const tabs = document.querySelectorAll('.channel-tab');
    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            const channel = tab.dataset.channel;
            // Убираем active у всех табов
            tabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            // Скрываем все панели, показываем нужную
            document.querySelectorAll('.channel-panel').forEach(p => p.style.display = 'none');
            const panel = document.getElementById('channelPanel-' + channel);
            if (panel) panel.style.display = 'block';
        });
    });
}

// === Все доступные каналы для попапа ===
const ALL_CHANNELS = [
    { id: 'telegram', name: 'Telegram', required: true },
    { id: 'vk', name: 'ВКонтакте' },
    { id: 'ok', name: 'Одноклассники' },
    { id: 'pinterest', name: 'Pinterest' },
    { id: 'instagram', name: 'Instagram' },
    { id: 'email', name: 'Email' },
    { id: 'youtube', name: 'YouTube' },
    { id: 'facebook', name: 'Facebook' },
    { id: 'dzen', name: 'Яндекс Дзен' },
    { id: 'tiktok', name: 'TikTok' }
];

// Текущие включённые каналы (обновляется при загрузке)
let _currentEnabledChannels = ['telegram'];

function openChannelPicker() {
    const listEl = document.getElementById('channelPickerList');
    if (!listEl) return;

    listEl.innerHTML = ALL_CHANNELS.map(ch => {
        const checked = _currentEnabledChannels.includes(ch.id) ? 'checked' : '';
        const disabled = ch.required ? 'disabled' : '';
        return `<label style="display: flex; align-items: center; gap: 8px; padding: 8px 10px; border: 1px solid #eee; border-radius: 6px; cursor: pointer;">
            <input type="checkbox" value="${ch.id}" ${checked} ${disabled} />
            <span>${ch.name}</span>
        </label>`;
    }).join('');

    document.getElementById('channelPickerOverlay').style.display = 'block';
}

function closeChannelPicker() {
    document.getElementById('channelPickerOverlay').style.display = 'none';
}

async function saveChannelPicker() {
    const listEl = document.getElementById('channelPickerList');
    const selected = [];
    listEl.querySelectorAll('input[type="checkbox"]:checked').forEach(cb => {
        selected.push(cb.value);
    });

    // Telegram всегда включён
    if (!selected.includes('telegram')) selected.unshift('telegram');

    try {
        const res = await fetch(`${API_MANAGE}/enabled-channels`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: currentChatId, channels: selected })
        });
        if (!res.ok) throw new Error('Ошибка сохранения');

        _currentEnabledChannels = selected;
        closeChannelPicker();

        // Обновляем видимость табов
        document.querySelectorAll('.channel-tab[data-channel]').forEach(tab => {
            tab.style.display = selected.includes(tab.dataset.channel) ? '' : 'none';
        });

        // Если текущий активный таб скрыт — переключаемся на первый видимый
        const activeTab = document.querySelector('.channel-tab.active');
        if (activeTab && activeTab.style.display === 'none') {
            const firstVisible = document.querySelector(`.channel-tab[data-channel="${selected[0]}"]`);
            if (firstVisible) firstVisible.click();
        }

        if (typeof showToast === 'function') showToast('Каналы обновлены', 'success');
    } catch (e) {
        console.error('saveChannelPicker', e);
        if (typeof showToast === 'function') showToast('Ошибка сохранения', 'error');
    }
}

async function onLoginSuccess() {
    // Загружаем список включённых каналов и фильтруем меню
    let enabledChannels = ['telegram']; // fallback — всегда показываем Telegram
    try {
        const res = await fetch(`${API_MANAGE}/enabled-channels?chat_id=${encodeURIComponent(currentChatId)}`);
        if (res.ok) {
            const data = await res.json();
            if (data.channels && Array.isArray(data.channels) && data.channels.length > 0) {
                enabledChannels = data.channels;
            }
        }
    } catch (e) {
        console.error('Error loading enabled channels:', e);
    }

    // Сохраняем для попапа
    _currentEnabledChannels = enabledChannels;

    // Показываем только включённые табы
    enabledChannels.forEach(ch => {
        const tab = document.querySelector(`.channel-tab[data-channel="${ch}"]`);
        if (tab) tab.style.display = '';
    });

    // Привязываем кнопку "+"
    const addBtn = document.getElementById('addChannelBtn');
    if (addBtn) addBtn.addEventListener('click', openChannelPicker);

    // Закрытие попапа по клику на оверлей
    const overlay = document.getElementById('channelPickerOverlay');
    if (overlay) overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeChannelPicker();
    });

    // Активируем первый таб
    const firstTab = document.querySelector(`.channel-tab[data-channel="${enabledChannels[0]}"]`);
    if (firstTab) {
        firstTab.click();
    }

    // Загружаем статус всех каналов
    await loadTelegramStatus();
    await loadEmailStatus();
    await loadContentSettings();
    await loadPinterestConfig();
    await loadInstagramConfig();
    await loadVkStatus();
    await loadOkStatus();
}

// Специальная инициализация для страницы каналов
// Позволяет подключить бота без авторизации
async function initChannelsAuth() {
    const savedChatId = localStorage.getItem('chatId');
    const savedTelegramId = localStorage.getItem('telegramId');
    const authSection = document.getElementById('authSection');
    const mainContent = document.getElementById('mainContent');
    const logoutBtn = document.getElementById('logoutButton');
    const chatIdInput = document.getElementById('chatIdInput');

    if (savedChatId && savedTelegramId) {
        // Уже авторизован - показываем контент
        currentChatId = savedChatId;
        if (chatIdInput) chatIdInput.value = savedTelegramId;
        if (logoutBtn) {
            logoutBtn.style.display = 'block';
            injectAdminButton(); // Добавляем кнопку Админ
        }
        if (authSection) authSection.style.display = 'none';
        if (mainContent) mainContent.style.display = 'block';
        await onLoginSuccess();
    } else {
        // Не авторизован - показываем форму для ввода Telegram ID
        if (authSection) authSection.style.display = 'block';
        if (mainContent) mainContent.style.display = 'none';
        if (logoutBtn) logoutBtn.style.display = 'none';
    }
}

// Вход для страницы каналов - создаёт временную сессию
async function loginForChannels() {
    const chatIdInput = document.getElementById('chatIdInput');
    if (!chatIdInput) return;
    const telegramId = chatIdInput.value.trim();

    if (!telegramId) {
        showToast('Введите ваш Telegram ID', 'error');
        return;
    }

    if (!/^\d+$/.test(telegramId)) {
        showToast('Telegram ID должен быть числом (например: 123456789)', 'error');
        return;
    }

    setApiStatus('Создание сессии...', 'info');

    try {
        // Создаём новую сессию с chat_id = telegram_id
        const response = await fetch(`${API_URL}/session/create`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: telegramId })
        });

        if (response.ok) {
            currentChatId = telegramId;
            localStorage.setItem('chatId', telegramId);
            localStorage.setItem('telegramId', telegramId);

            setApiStatus('', '');

            document.getElementById('authSection').style.display = 'none';
            document.getElementById('mainContent').style.display = 'block';
            const logoutBtn = document.getElementById('logoutButton');
            if (logoutBtn) {
                logoutBtn.style.display = 'block';
                injectAdminButton(); // Добавляем кнопку Админ
            }

            showToast('Сессия создана. Теперь подключите бота.', 'success');
            await onLoginSuccess();
        } else {
            const errorData = await response.json().catch(() => ({}));
            showToast(errorData.error || 'Ошибка создания сессии', 'error');
        }
    } catch (error) {
        showToast('Ошибка подключения к серверу', 'error');
    }
}

async function loadTelegramStatus() {
    const chatId = getChatId();
    if (!chatId) return;
    // Telegram bot is now configured during onboarding via CW_BOT_TOKEN
    // Just load content settings
    await loadContentSettings();
}

async function loadEmailStatus() {
    const chatId = getChatId();
    if (!chatId) return;
    try {
        const res = await fetch(`${API_MANAGE}/email/status?chat_id=${encodeURIComponent(chatId)}`);
        const data = await res.json();
        const statusEl = document.getElementById('emailStatus');
        const disconnectBtn = document.getElementById('disconnectEmailBtn');
        if (!statusEl) return;

        if (data.hasEmail) {
            statusEl.innerHTML = `<span style="color: #0a0;">✅ Активен: IMAP ${data.config.imapHost} / SMTP ${data.config.smtpHost}. Обработано: ${data.processedCount||0}. Интервал: ${data.pollIntervalMinutes||5} мин. Последний опрос: ${data.lastPollAgoMinutes ? data.lastPollAgoMinutes + ' мин назад' : 'не было'}.</span>`;
            const pollSettings = document.getElementById('pollSettings');
            if (pollSettings) pollSettings.style.display = 'block';
            const select = document.getElementById('emailPollInterval');
            if (select) select.value = data.pollIntervalMinutes || 5;
            if (disconnectBtn) disconnectBtn.style.display = 'inline-block';
            
            // Заполняем поля формы сохранёнными значениями
            if (data.config.imapHost) {
                const imapHostInput = document.getElementById('emailImapHost');
                if (imapHostInput) imapHostInput.value = data.config.imapHost;
            }
            if (data.config.imapPort) {
                const imapPortInput = document.getElementById('emailImapPort');
                if (imapPortInput) imapPortInput.value = data.config.imapPort;
            }
            if (data.config.imapUser) {
                const imapUserInput = document.getElementById('emailImapUser');
                if (imapUserInput) imapUserInput.value = data.config.imapUser;
            }
            if (data.config.imapPass) {
                const imapPassInput = document.getElementById('emailImapPass');
                if (imapPassInput) imapPassInput.value = data.config.imapPass;
            }
            if (data.config.smtpHost) {
                const smtpHostInput = document.getElementById('emailSmtpHost');
                if (smtpHostInput) smtpHostInput.value = data.config.smtpHost;
            }
            if (data.config.smtpPort) {
                const smtpPortInput = document.getElementById('emailSmtpPort');
                if (smtpPortInput) smtpPortInput.value = data.config.smtpPort;
            }
            if (data.config.smtpUser) {
                const smtpUserInput = document.getElementById('emailSmtpUser');
                if (smtpUserInput) smtpUserInput.value = data.config.smtpUser;
            }
            if (data.config.smtpPass) {
                const smtpPassInput = document.getElementById('emailSmtpPass');
                if (smtpPassInput) smtpPassInput.value = data.config.smtpPass;
            }
        } else {
            statusEl.textContent = '';
            if (disconnectBtn) disconnectBtn.style.display = 'none';
        }
    } catch (e) {
        console.error('loadEmailStatus', e);
    }
}

async function saveEmailConfig() {
    const chatId = getChatId();
    if (!chatId) return;

    const imapHost = document.getElementById('emailImapHost')?.value?.trim();
    const imapPort = document.getElementById('emailImapPort')?.value?.trim();
    const imapUser = document.getElementById('emailImapUser')?.value?.trim();
    const imapPass = document.getElementById('emailImapPass')?.value?.trim();
    const smtpHost = document.getElementById('emailSmtpHost')?.value?.trim();
    const smtpPort = document.getElementById('emailSmtpPort')?.value?.trim();
    const smtpUser = document.getElementById('emailSmtpUser')?.value?.trim();
    const smtpPass = document.getElementById('emailSmtpPass')?.value?.trim();
    const pollIntervalMinutes = document.getElementById('emailPollInterval')?.value?.trim() || '5';

    if (!imapHost || !imapUser || !imapPass || !smtpHost || !smtpUser || !smtpPass) {
        showToast('Заполните все обязательные поля IMAP и SMTP', 'error');
        return;
    }

    try {
        const res = await fetch(`${API_MANAGE}/email`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                imap_host: imapHost,
                imap_port: imapPort,
                imap_user: imapUser,
                imap_pass: imapPass,
                smtp_host: smtpHost,
                smtp_port: smtpPort,
                smtp_user: smtpUser,
                smtp_pass: smtpPass,
                poll_interval_minutes: pollIntervalMinutes
            })
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
            showToast('Email настройки сохранены и активированы. Установлено правило проверки почты через скрипт processor.js. Cron запущен.', 'success');
            // НЕ очищаем поля паролей - перезагружаем статус чтобы сохранить значения
            await loadEmailStatus();
        } else {
            showToast(data.error || 'Ошибка сохранения', 'error');
        }
    } catch (e) {
        showToast('Ошибка сети', 'error');
    }
}

async function updateEmailPoll() {
    const chatId = getChatId();
    if (!chatId) return;
    const select = document.getElementById('emailPollInterval');
    if (!select) return;
    const minutes = parseInt(select.value);
    try {
        const res = await fetch(`${API_MANAGE}/email/poll`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, minutes })
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
            showToast('Интервал обновлён', 'success');
            await loadEmailStatus();
        } else {
            showToast(data.error || 'Ошибка', 'error');
        }
    } catch (e) {
        showToast('Ошибка сети', 'error');
    }
}

async function disconnectEmail() {
    const chatId = getChatId();
    if (!chatId || !confirm('Отключить обработку Email для этого окружения?')) return;
    try {
        const res = await fetch(`${API_MANAGE}/email?chat_id=${encodeURIComponent(chatId)}`, { method: 'DELETE' });
        if (res.ok) {
            showToast('Email отключён', 'success');
            await loadEmailStatus();
        } else {
            showToast('Ошибка отключения', 'error');
        }
    } catch (e) {
        showToast('Ошибка сети', 'error');
    }
}

// === Контент-настройки ===

function updateScheduleTime() {
    const hour = document.getElementById('contentScheduleHour')?.value || '00';
    const minute = document.getElementById('contentScheduleMinute')?.value || '00';
    const timeField = document.getElementById('contentScheduleTime');
    if (timeField) {
        timeField.value = `${hour}:${minute.padStart(2, '0')}`;
    }
}

function validateMinutes() {
    const minuteInput = document.getElementById('contentScheduleMinute');
    if (!minuteInput) return;
    let val = minuteInput.value.replace(/[^0-9]/g, '');
    if (val.length > 2) val = val.slice(0, 2);
    if (val !== '' && parseInt(val, 10) > 59) val = '59';
    minuteInput.value = val;
    updateScheduleTime();
}

function setScheduleTimeInputs(timeValue) {
    if (!timeValue) return;
    const parts = timeValue.split(':');
    if (parts.length < 2) return;
    const hourSelect = document.getElementById('contentScheduleHour');
    const minuteInput = document.getElementById('contentScheduleMinute');
    if (hourSelect) hourSelect.value = parts[0].padStart(2, '0');
    if (minuteInput) minuteInput.value = parts[1].padStart(2, '0');
    updateScheduleTime();
}

function updateScheduleTz() {
    return;
}

function setScheduleTzInput(tzValue) {
    const tzSelect = document.getElementById('contentScheduleTz');
    if (!tzSelect || !tzValue) return;
    const optionExists = Array.from(tzSelect.options).some((opt) => opt.value === tzValue);
    if (optionExists) {
        tzSelect.value = tzValue;
        return;
    }
    const newOption = document.createElement('option');
    newOption.value = tzValue;
    newOption.text = `${tzValue} (custom)`;
    newOption.selected = true;
    tzSelect.insertBefore(newOption, tzSelect.firstChild);
}

async function loadContentSettings() {
    const chatId = getChatId();
    if (!chatId) return;
    try {
        const res = await fetch(`${API_MANAGE}/content/settings?chat_id=${encodeURIComponent(chatId)}`);
        const data = await res.json();
        const s = data.settings || {};
        const channelEl = document.getElementById('contentChannelId');
        const moderatorEl = document.getElementById('contentModeratorUserId');
        const timeEl = document.getElementById('contentScheduleTime');
        const limitEl = document.getElementById('contentDailyLimit');
        if (channelEl) channelEl.value = s.channelId || '';
        // По умолчанию подставляем chatId пользователя как Moderator User ID
        if (moderatorEl) moderatorEl.value = s.moderatorUserId || chatId;
        if (timeEl) timeEl.value = s.scheduleTime || '';
        if (s.scheduleTime) setScheduleTimeInputs(s.scheduleTime);
        setScheduleTzInput(s.scheduleTz || 'Europe/Moscow');
        if (limitEl) limitEl.value = s.dailyLimit || '';
        const intervalEl = document.getElementById('contentPublishInterval');
        if (intervalEl) intervalEl.value = String(s.publishIntervalHours ?? 24);
        const randomEl = document.getElementById('contentRandomPublish');
        if (randomEl) randomEl.checked = !!s.randomPublish;
        const premoderEl = document.getElementById('contentPremoderation');
        if (premoderEl) premoderEl.checked = s.premoderationEnabled !== false;
        const weekdays = Array.isArray(s.allowedWeekdays) ? s.allowedWeekdays : [1, 2, 3, 4, 5];
        for (let d = 0; d <= 6; d++) {
            const cb = document.getElementById('weekday' + d);
            if (cb) cb.checked = weekdays.includes(d);
        }
    } catch (e) {
        console.error('loadContentSettings', e);
    }
}

async function saveContentSettings() {
    const chatId = getChatId();
    if (!chatId) return;
    updateScheduleTime();
    try {
        const res = await fetch(`${API_MANAGE}/content/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                channel_id: (document.getElementById('contentChannelId')?.value || '').trim(),
                moderator_user_id: (document.getElementById('contentModeratorUserId')?.value || '').trim(),
                schedule_time: (document.getElementById('contentScheduleTime')?.value || '').trim(),
                schedule_tz: (document.getElementById('contentScheduleTz')?.value || '').trim(),
                daily_limit: (document.getElementById('contentDailyLimit')?.value || '').trim(),
                publish_interval_hours: parseFloat(document.getElementById('contentPublishInterval')?.value || '24'),
                random_publish: !!document.getElementById('contentRandomPublish')?.checked,
                premoderation_enabled: !!document.getElementById('contentPremoderation')?.checked,
                allowed_weekdays: [0,1,2,3,4,5,6].filter(d => document.getElementById('weekday' + d)?.checked)
            })
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
            showToast('Контент-настройки сохранены', 'success');
            await loadContentSettings();
        } else {
            showToast(data.error || 'Ошибка сохранения', 'error');
        }
    } catch (e) {
        showToast('Ошибка сети', 'error');
    }
}

// === Pinterest ===

async function connectPinterest() {
    const chatId = getChatId();
    if (!chatId) return;
    const appId = (document.getElementById('pinterestAppId')?.value || '').trim();
    const appSecret = (document.getElementById('pinterestAppSecret')?.value || '').trim();
    if (!appId || !appSecret) {
        showToast('Введите App ID и App Secret', 'error');
        return;
    }
    try {
        const res = await fetch(`${API_MANAGE}/channels/pinterest`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, app_id: appId, app_secret: appSecret })
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
            showToast('Pinterest подключён', 'success');
            await loadPinterestConfig();
        } else {
            showToast(data.error || 'Ошибка подключения', 'error');
        }
    } catch (e) {
        showToast('Ошибка сети', 'error');
    }
}

async function loadPinterestConfig() {
    const chatId = getChatId();
    if (!chatId) return;
    try {
        const res = await fetch(`${API_MANAGE}/channels/pinterest?chat_id=${encodeURIComponent(chatId)}`);
        const data = await res.json();
        const statusEl = document.getElementById('pinterestStatus');
        const disconnectBtn = document.getElementById('disconnectPinterestBtn');
        const settingsBlock = document.getElementById('pinterestSettingsBlock');
        if (!statusEl) return;

        if (data.connected) {
            statusEl.innerHTML = '<span style="color: #0a0;">✅ Pinterest подключён</span>';
            if (disconnectBtn) disconnectBtn.style.display = 'inline-block';
            if (settingsBlock) settingsBlock.style.display = 'block';
            // Заполняем поля
            const cfg = data.config || {};
            if (cfg.app_id) document.getElementById('pinterestAppId').value = cfg.app_id;
            if (cfg.app_secret) document.getElementById('pinterestAppSecret').value = cfg.app_secret;
            if (cfg.board_id) document.getElementById('pinterestBoardId').value = cfg.board_id;
            if (cfg.website_url) document.getElementById('pinterestWebsiteUrl').value = cfg.website_url;
            const isActiveEl = document.getElementById('pinterestIsActive');
            if (isActiveEl) isActiveEl.checked = cfg.is_active !== false;
            const autoPublishEl = document.getElementById('pinterestAutoPublish');
            if (autoPublishEl) autoPublishEl.checked = !!cfg.auto_publish;
            // Устанавливаем выбранную доску в select
            const boardSelect = document.getElementById('pinterestBoardSelect');
            if (boardSelect && cfg.board_id) {
                const exists = Array.from(boardSelect.options).some(o => o.value === cfg.board_id);
                if (!exists && cfg.board_name) {
                    const opt = document.createElement('option');
                    opt.value = cfg.board_id;
                    opt.textContent = cfg.board_name;
                    boardSelect.appendChild(opt);
                }
                boardSelect.value = cfg.board_id;
            }
        } else {
            statusEl.textContent = '';
            if (disconnectBtn) disconnectBtn.style.display = 'none';
            if (settingsBlock) settingsBlock.style.display = 'none';
        }
    } catch (e) {
        console.error('loadPinterestConfig', e);
    }
}

async function loadPinterestBoards() {
    const chatId = getChatId();
    if (!chatId) return;
    const boardSelect = document.getElementById('pinterestBoardSelect');
    if (!boardSelect) return;
    try {
        const res = await fetch(`${API_MANAGE}/channels/pinterest/boards?chat_id=${encodeURIComponent(chatId)}`);
        const data = await res.json();
        if (!res.ok) {
            showToast(data.error || 'Ошибка загрузки досок', 'error');
            return;
        }
        const boards = data.boards || [];
        const currentVal = boardSelect.value;
        boardSelect.innerHTML = '<option value="">— выберите доску —</option>';
        boards.forEach(b => {
            const opt = document.createElement('option');
            opt.value = b.id;
            opt.textContent = b.name;
            boardSelect.appendChild(opt);
        });
        if (currentVal) boardSelect.value = currentVal;
        showToast(`Загружено досок: ${boards.length}`, 'success');
    } catch (e) {
        showToast('Ошибка сети', 'error');
    }
}

function onPinterestBoardSelect() {
    const boardSelect = document.getElementById('pinterestBoardSelect');
    const boardIdInput = document.getElementById('pinterestBoardId');
    if (boardSelect && boardIdInput) {
        boardIdInput.value = boardSelect.value;
    }
}

async function savePinterestConfig() {
    const chatId = getChatId();
    if (!chatId) return;
    const boardId = (document.getElementById('pinterestBoardId')?.value || '').trim();
    const boardSelect = document.getElementById('pinterestBoardSelect');
    const boardName = boardSelect ? (boardSelect.options[boardSelect.selectedIndex]?.textContent || '').trim() : '';
    const websiteUrl = (document.getElementById('pinterestWebsiteUrl')?.value || '').trim();
    const isActive = !!document.getElementById('pinterestIsActive')?.checked;
    const autoPublish = !!document.getElementById('pinterestAutoPublish')?.checked;

    if (!websiteUrl) {
        showToast('Укажите Website URL', 'error');
        return;
    }

    try {
        const res = await fetch(`${API_MANAGE}/channels/pinterest`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                board_id: boardId,
                board_name: boardName,
                website_url: websiteUrl,
                is_active: isActive,
                auto_publish: autoPublish
            })
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
            showToast('Настройки Pinterest сохранены', 'success');
            await loadPinterestConfig();
        } else {
            showToast(data.error || 'Ошибка сохранения', 'error');
        }
    } catch (e) {
        showToast('Ошибка сети', 'error');
    }
}

async function disconnectPinterest() {
    const chatId = getChatId();
    if (!chatId || !confirm('Отключить Pinterest?')) return;
    try {
        const res = await fetch(`${API_MANAGE}/channels/pinterest?chat_id=${encodeURIComponent(chatId)}`, { method: 'DELETE' });
        if (res.ok) {
            showToast('Pinterest отключён', 'success');
            document.getElementById('pinterestAppId').value = '';
            document.getElementById('pinterestAppSecret').value = '';
            document.getElementById('pinterestBoardId').value = '';
            document.getElementById('pinterestWebsiteUrl').value = '';
            const boardSelect = document.getElementById('pinterestBoardSelect');
            if (boardSelect) boardSelect.innerHTML = '<option value="">— выберите доску —</option>';
            await loadPinterestConfig();
        } else {
            showToast('Ошибка отключения', 'error');
        }
    } catch (e) {
        showToast('Ошибка сети', 'error');
    }
}

// === Instagram ===

async function connectInstagram() {
    const chatId = getChatId();
    if (!chatId) return;
    const appId = (document.getElementById('instagramAppId')?.value || '').trim();
    const appSecret = (document.getElementById('instagramAppSecret')?.value || '').trim();
    if (!appId || !appSecret) {
        showToast('Введите Facebook App ID и App Secret', 'error');
        return;
    }
    try {
        const res = await fetch(`${API_MANAGE}/channels/instagram`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, app_id: appId, app_secret: appSecret })
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
            showToast('Instagram подключён', 'success');
            await loadInstagramConfig();
        } else {
            showToast(data.error || 'Ошибка подключения', 'error');
        }
    } catch (e) {
        showToast('Ошибка сети', 'error');
    }
}

async function loadInstagramConfig() {
    const chatId = getChatId();
    if (!chatId) return;
    try {
        const res = await fetch(`${API_MANAGE}/channels/instagram?chat_id=${encodeURIComponent(chatId)}`);
        const data = await res.json();
        const statusEl = document.getElementById('instagramStatus');
        const disconnectBtn = document.getElementById('disconnectInstagramBtn');
        const settingsBlock = document.getElementById('instagramSettingsBlock');
        if (!statusEl) return;

        if (data.connected) {
            statusEl.innerHTML = '<span style="color: #0a0;">✅ Instagram подключён</span>';
            if (disconnectBtn) disconnectBtn.style.display = 'inline-block';
            if (settingsBlock) settingsBlock.style.display = 'block';

            const cfg = data.config || {};
            if (cfg.app_id) document.getElementById('instagramAppId').value = cfg.app_id;
            if (cfg.app_secret) document.getElementById('instagramAppSecret').value = cfg.app_secret;
            if (cfg.ig_user_id) document.getElementById('instagramAccountId').value = cfg.ig_user_id;
            if (cfg.fb_page_id) document.getElementById('instagramFbPageId').value = cfg.fb_page_id;
            if (cfg.ig_username) document.getElementById('instagramUsername').value = cfg.ig_username;
            if (cfg.default_alt_text) document.getElementById('instagramDefaultAltText').value = cfg.default_alt_text;
            if (cfg.location_id) document.getElementById('instagramLocationId').value = cfg.location_id;

            // Загружаем moderator_user_id
            const moderatorEl = document.getElementById('instagramModeratorUserId');
            if (moderatorEl) {
                moderatorEl.value = cfg.moderator_user_id || chatId;
            }

            const isActiveEl = document.getElementById('instagramIsActive');
            if (isActiveEl) isActiveEl.checked = cfg.is_active !== false;
            const autoPublishEl = document.getElementById('instagramAutoPublish');
            if (autoPublishEl) autoPublishEl.checked = !!cfg.auto_publish;
            const isReelEl = document.getElementById('instagramIsReel');
            if (isReelEl) isReelEl.checked = !!cfg.is_reel;
            const dailyLimitEl = document.getElementById('instagramDailyLimit');
            if (dailyLimitEl) dailyLimitEl.value = cfg.daily_limit || 5;
            const postingHoursEl = document.getElementById('instagramPostingHours');
            if (postingHoursEl && Array.isArray(cfg.posting_hours)) {
                postingHoursEl.value = cfg.posting_hours.join(',');
            }

            // Заполняем select страниц если есть сохранённая
            const pageSelect = document.getElementById('instagramPageSelect');
            if (pageSelect && cfg.fb_page_id) {
                const exists = Array.from(pageSelect.options).some(o => o.value === cfg.fb_page_id);
                if (!exists && cfg.fb_page_name) {
                    const opt = document.createElement('option');
                    opt.value = cfg.fb_page_id;
                    opt.textContent = cfg.fb_page_name;
                    opt.dataset.igUserId = cfg.ig_user_id || '';
                    opt.dataset.igUsername = cfg.ig_username || '';
                    pageSelect.appendChild(opt);
                }
                pageSelect.value = cfg.fb_page_id;
            }
        } else {
            statusEl.textContent = '';
            if (disconnectBtn) disconnectBtn.style.display = 'none';
            if (settingsBlock) settingsBlock.style.display = 'none';
        }
    } catch (e) {
        console.error('loadInstagramConfig', e);
    }
}

async function loadInstagramAccounts() {
    const chatId = getChatId();
    if (!chatId) return;
    const pageSelect = document.getElementById('instagramPageSelect');
    if (!pageSelect) return;
    try {
        const res = await fetch(`${API_MANAGE}/channels/instagram/accounts?chat_id=${encodeURIComponent(chatId)}`);
        const data = await res.json();
        if (!res.ok) {
            showToast(data.error || 'Ошибка загрузки аккаунтов', 'error');
            return;
        }
        const accounts = data.accounts || [];
        const currentVal = pageSelect.value;
        pageSelect.innerHTML = '<option value="">— выберите страницу —</option>';
        accounts.forEach(a => {
            const opt = document.createElement('option');
            opt.value = a.fb_page_id;
            opt.textContent = a.page_name + (a.ig_username ? ` (@${a.ig_username})` : '');
            opt.dataset.igUserId = a.ig_user_id || '';
            opt.dataset.igUsername = a.ig_username || '';
            pageSelect.appendChild(opt);
        });
        if (currentVal) pageSelect.value = currentVal;
        showToast(`Загружено аккаунтов: ${accounts.length}`, 'success');
    } catch (e) {
        showToast('Ошибка сети', 'error');
    }
}

function onInstagramPageSelect() {
    const pageSelect = document.getElementById('instagramPageSelect');
    const accountIdInput = document.getElementById('instagramAccountId');
    const fbPageIdInput = document.getElementById('instagramFbPageId');
    const usernameInput = document.getElementById('instagramUsername');
    if (!pageSelect) return;
    const selected = pageSelect.options[pageSelect.selectedIndex];
    if (fbPageIdInput) fbPageIdInput.value = pageSelect.value;
    if (accountIdInput) accountIdInput.value = selected?.dataset?.igUserId || '';
    if (usernameInput) usernameInput.value = selected?.dataset?.igUsername || '';
}

async function saveInstagramConfig() {
    const chatId = getChatId();
    if (!chatId) return;

    const fbPageId = (document.getElementById('instagramFbPageId')?.value || '').trim();
    const igUserId = (document.getElementById('instagramAccountId')?.value || '').trim();
    const igUsername = (document.getElementById('instagramUsername')?.value || '').trim();
    const pageSelect = document.getElementById('instagramPageSelect');
    const fbPageName = pageSelect ? (pageSelect.options[pageSelect.selectedIndex]?.textContent || '').trim() : '';
    const defaultAltText = (document.getElementById('instagramDefaultAltText')?.value || '').trim();
    const locationId = (document.getElementById('instagramLocationId')?.value || '').trim();
    const isActive = !!document.getElementById('instagramIsActive')?.checked;
    const autoPublish = !!document.getElementById('instagramAutoPublish')?.checked;
    const isReel = !!document.getElementById('instagramIsReel')?.checked;
    const dailyLimit = parseInt(document.getElementById('instagramDailyLimit')?.value || '5', 10);
    const postingHoursRaw = (document.getElementById('instagramPostingHours')?.value || '').trim();
    const postingHours = postingHoursRaw
        ? postingHoursRaw.split(',').map(h => parseInt(h.trim(), 10)).filter(h => h >= 0 && h <= 23)
        : [];
    const moderatorUserId = (document.getElementById('instagramModeratorUserId')?.value || '').trim() || chatId;

    try {
        const res = await fetch(`${API_MANAGE}/channels/instagram`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                fb_page_id: fbPageId,
                fb_page_name: fbPageName,
                ig_user_id: igUserId,
                ig_username: igUsername,
                default_alt_text: defaultAltText,
                location_id: locationId,
                is_active: isActive,
                auto_publish: autoPublish,
                is_reel: isReel,
                daily_limit: dailyLimit,
                posting_hours: postingHours,
                moderator_user_id: moderatorUserId
            })
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
            showToast('Настройки Instagram сохранены', 'success');
            await loadInstagramConfig();
        } else {
            showToast(data.error || 'Ошибка сохранения', 'error');
        }
    } catch (e) {
        showToast('Ошибка сети', 'error');
    }
}

async function disconnectInstagram() {
    const chatId = getChatId();
    if (!chatId || !confirm('Отключить Instagram?')) return;
    try {
        const res = await fetch(`${API_MANAGE}/channels/instagram?chat_id=${encodeURIComponent(chatId)}`, { method: 'DELETE' });
        if (res.ok) {
            showToast('Instagram отключён', 'success');
            document.getElementById('instagramAppId').value = '';
            document.getElementById('instagramAppSecret').value = '';
            document.getElementById('instagramAccountId').value = '';
            document.getElementById('instagramFbPageId').value = '';
            document.getElementById('instagramUsername').value = '';
            document.getElementById('instagramDefaultAltText').value = '';
            document.getElementById('instagramLocationId').value = '';
            const pageSelect = document.getElementById('instagramPageSelect');
            if (pageSelect) pageSelect.innerHTML = '<option value="">— выберите страницу —</option>';
            await loadInstagramConfig();
        } else {
            showToast('Ошибка отключения', 'error');
        }
    } catch (e) {
        showToast('Ошибка сети', 'error');
    }
}

// === VKontakte ===

function updateVkScheduleTime() {
    const hour = document.getElementById('vkScheduleHour')?.value || '00';
    const minute = document.getElementById('vkScheduleMinute')?.value || '00';
    const timeField = document.getElementById('vkScheduleTime');
    if (timeField) {
        timeField.value = `${hour}:${minute.padStart(2, '0')}`;
    }
}

function validateVkMinutes() {
    const minuteInput = document.getElementById('vkScheduleMinute');
    if (!minuteInput) return;
    let val = minuteInput.value.replace(/[^0-9]/g, '');
    if (val.length > 2) val = val.slice(0, 2);
    if (val !== '' && parseInt(val, 10) > 59) val = '59';
    minuteInput.value = val;
    updateVkScheduleTime();
}

function updateVkScheduleTz() {
    return;
}

function setVkScheduleTimeInputs(timeValue) {
    if (!timeValue) return;
    const parts = timeValue.split(':');
    if (parts.length < 2) return;
    const hourSelect = document.getElementById('vkScheduleHour');
    const minuteInput = document.getElementById('vkScheduleMinute');
    if (hourSelect) hourSelect.value = parts[0].padStart(2, '0');
    if (minuteInput) minuteInput.value = parts[1].padStart(2, '0');
    updateVkScheduleTime();
}

async function loadVkStatus() {
    const chatId = getChatId();
    if (!chatId) return;
    try {
        const res = await fetch(`${API_MANAGE}/channels/vk?chat_id=${encodeURIComponent(chatId)}`);
        const data = await res.json();
        const statusEl = document.getElementById('vkStatus');
        const disconnectBtn = document.getElementById('disconnectVkBtn');
        const settingsBlock = document.getElementById('vkSettingsBlock');
        if (!statusEl) return;

        if (data.connected) {
            statusEl.innerHTML = '<span style="color: #0a0;">✅ VK подключён</span>';
            if (disconnectBtn) disconnectBtn.style.display = 'inline-block';
            if (settingsBlock) settingsBlock.style.display = 'block';

            const cfg = data.config || {};
            if (cfg.group_id) document.getElementById('vkGroupId').value = cfg.group_id;
            if (cfg.service_key) document.getElementById('vkServiceKey').value = cfg.service_key;

            const s = data.settings || {};
            if (s.schedule_time) {
                document.getElementById('vkScheduleTime').value = s.schedule_time;
                setVkScheduleTimeInputs(s.schedule_time);
            }
            const tzSelect = document.getElementById('vkScheduleTz');
            if (tzSelect && s.schedule_tz) {
                const optionExists = Array.from(tzSelect.options).some((opt) => opt.value === s.schedule_tz);
                if (optionExists) {
                    tzSelect.value = s.schedule_tz;
                } else {
                    const newOption = document.createElement('option');
                    newOption.value = s.schedule_tz;
                    newOption.text = `${s.schedule_tz} (custom)`;
                    newOption.selected = true;
                    tzSelect.insertBefore(newOption, tzSelect.firstChild);
                }
            }
            if (s.daily_limit) document.getElementById('vkDailyLimit').value = s.daily_limit;
            const intervalEl = document.getElementById('vkPublishInterval');
            if (intervalEl) intervalEl.value = String(s.publish_interval_hours ?? 24);
            const randomEl = document.getElementById('vkRandomPublish');
            if (randomEl) randomEl.checked = !!s.random_publish;
            const premoderEl = document.getElementById('vkPremoderation');
            if (premoderEl) premoderEl.checked = s.premoderation_enabled !== false;
            const postTypeEl = document.getElementById('vkPostType');
            if (postTypeEl) postTypeEl.value = s.post_type || 'post';

            const weekdays = Array.isArray(s.allowed_weekdays) ? s.allowed_weekdays : [1, 2, 3, 4, 5];
            for (let d = 0; d <= 6; d++) {
                const cb = document.getElementById('vkWeekday' + d);
                if (cb) cb.checked = weekdays.includes(d);
            }

            // Загружаем moderator_user_id
            const moderatorEl = document.getElementById('vkModeratorUserId');
            if (moderatorEl) {
                moderatorEl.value = s.moderator_user_id || chatId;
            }
        } else {
            statusEl.textContent = '';
            if (disconnectBtn) disconnectBtn.style.display = 'none';
            if (settingsBlock) settingsBlock.style.display = 'none';
        }
    } catch (e) {
        console.error('loadVkStatus', e);
    }
}

async function saveVkToken() {
    const chatId = getChatId();
    if (!chatId) return;
    const groupId = document.getElementById('vkGroupId')?.value?.trim();
    const serviceKey = document.getElementById('vkServiceKey')?.value?.trim();

    if (!groupId || !serviceKey) {
        showToast('Введите Group ID и User access token', 'error');
        return;
    }

    try {
        const res = await fetch(`${API_MANAGE}/channels/vk`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                group_id: groupId,
                service_key: serviceKey
            })
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
            showToast('VK подключён', 'success');
            await loadVkStatus();
        } else {
            showToast(data.error || 'Ошибка подключения', 'error');
        }
    } catch (e) {
        showToast('Ошибка сети', 'error');
    }
}

async function disconnectVk() {
    const chatId = getChatId();
    if (!chatId || !confirm('Отключить VK для этого окружения?')) return;
    try {
        const res = await fetch(`${API_MANAGE}/channels/vk?chat_id=${encodeURIComponent(chatId)}`, { method: 'DELETE' });
        if (res.ok) {
            showToast('VK отключён', 'success');
            await loadVkStatus();
        } else {
            showToast('Ошибка отключения', 'error');
        }
    } catch (e) {
        showToast('Ошибка сети', 'error');
    }
}

async function saveVkSettings() {
    const chatId = getChatId();
    if (!chatId) return;
    updateVkScheduleTime();

    const moderatorUserId = (document.getElementById('vkModeratorUserId')?.value || '').trim() || chatId;

    try {
        const res = await fetch(`${API_MANAGE}/channels/vk/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                schedule_time: (document.getElementById('vkScheduleTime')?.value || '').trim(),
                schedule_tz: (document.getElementById('vkScheduleTz')?.value || '').trim(),
                daily_limit: (document.getElementById('vkDailyLimit')?.value || '').trim(),
                publish_interval_hours: parseFloat(document.getElementById('vkPublishInterval')?.value || '24'),
                random_publish: !!document.getElementById('vkRandomPublish')?.checked,
                premoderation_enabled: !!document.getElementById('vkPremoderation')?.checked,
                post_type: (document.getElementById('vkPostType')?.value || 'post').trim(),
                allowed_weekdays: [0,1,2,3,4,5,6].filter(d => document.getElementById('vkWeekday' + d)?.checked),
                moderator_user_id: moderatorUserId
            })
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
            showToast('Настройки VK сохранены', 'success');
            await loadVkStatus();
        } else {
            showToast(data.error || 'Ошибка сохранения', 'error');
        }
    } catch (e) {
        console.error('VK settings save error:', e);
        showToast(`Ошибка сети: ${e.message || 'Неизвестная ошибка'}`, 'error');
    }
}

async function runVkNow() {
    const chatId = getChatId();
    if (!chatId) return;
    const btn = document.getElementById('vkRunNowBtn');
    const statusEl = document.getElementById('vkSettingsStatus');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Генерация...'; }
    if (statusEl) { statusEl.innerHTML = '<span style="color:#888;">Генерация VK-поста... Это может занять 2-3 минуты.</span>'; }
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 180000); // 3 минуты
        const res = await fetch(`${API_CONTENT}/vk/run-now`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, reason: 'ui_manual' }),
            signal: controller.signal
        });
        clearTimeout(timeoutId);
        const text = await res.text();
        let data;
        try { data = JSON.parse(text); } catch { data = { error: text || `HTTP ${res.status}` }; }
        if (res.ok && data.ok) {
            showToast(data.message || 'Задача в очереди', 'success');
            if (statusEl) { statusEl.innerHTML = '<span style="color:#0a0;">✅ ' + (data.message || 'Задача в очереди') + '. Черновик придёт в Telegram.</span>'; }
        } else {
            const errMsg = data.error || data.message || `HTTP ${res.status}`;
            showToast(errMsg, 'error');
            if (statusEl) { statusEl.innerHTML = '<span style="color:#c00;">❌ ' + errMsg + '</span>'; }
        }
    } catch (e) {
        const errMsg = e.name === 'AbortError' ? 'Таймаут (3 мин). Проверьте логи сервера.' : ('Ошибка сети: ' + e.message);
        showToast(errMsg, 'error');
        if (statusEl) { statusEl.innerHTML = '<span style="color:#c00;">❌ ' + errMsg + '</span>'; }
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '▶️ Сгенерировать сейчас'; }
    }
}

// === Одноклассники ===

function updateOkScheduleTime() {
    const hour = document.getElementById('okScheduleHour')?.value || '00';
    const minute = document.getElementById('okScheduleMinute')?.value || '00';
    const timeField = document.getElementById('okScheduleTime');
    if (timeField) {
        timeField.value = `${hour}:${minute.padStart(2, '0')}`;
    }
}

function validateOkMinutes() {
    const minuteInput = document.getElementById('okScheduleMinute');
    if (!minuteInput) return;
    let val = minuteInput.value.replace(/[^0-9]/g, '');
    if (val.length > 2) val = val.slice(0, 2);
    if (val !== '' && parseInt(val, 10) > 59) val = '59';
    minuteInput.value = val;
    updateOkScheduleTime();
}

function setOkScheduleTimeInputs(timeValue) {
    if (!timeValue) return;
    const parts = timeValue.split(':');
    if (parts.length < 2) return;
    const hourSelect = document.getElementById('okScheduleHour');
    const minuteInput = document.getElementById('okScheduleMinute');
    if (hourSelect) hourSelect.value = parts[0].padStart(2, '0');
    if (minuteInput) minuteInput.value = parts[1].padStart(2, '0');
    updateOkScheduleTime();
}

async function loadOkStatus() {
    const chatId = getChatId();
    if (!chatId) return;
    try {
        const res = await fetch(`${API_MANAGE}/channels/ok?chat_id=${encodeURIComponent(chatId)}`);
        const data = await res.json();
        const statusEl = document.getElementById('okStatus');
        const disconnectBtn = document.getElementById('disconnectOkBtn');
        const settingsBlock = document.getElementById('okSettingsBlock');
        if (!statusEl) return;

        if (data.connected) {
            statusEl.innerHTML = '<span style="color: #0a0;">✅ ОК подключён</span>';
            if (disconnectBtn) disconnectBtn.style.display = 'inline-block';
            if (settingsBlock) settingsBlock.style.display = 'block';

            const cfg = data.config || {};
            if (cfg.group_id) document.getElementById('okGroupId').value = cfg.group_id;
            if (cfg.access_token) document.getElementById('okAccessToken').value = cfg.access_token;
            if (cfg.session_secret) document.getElementById('okSessionSecret').value = cfg.session_secret;
            if (cfg.public_key) document.getElementById('okPublicKey').value = cfg.public_key;

            const s = data.settings || {};
            if (s.schedule_time) {
                document.getElementById('okScheduleTime').value = s.schedule_time;
                setOkScheduleTimeInputs(s.schedule_time);
            }
            const tzSelect = document.getElementById('okScheduleTz');
            if (tzSelect && s.schedule_tz) {
                const optionExists = Array.from(tzSelect.options).some((opt) => opt.value === s.schedule_tz);
                if (optionExists) {
                    tzSelect.value = s.schedule_tz;
                } else {
                    const newOption = document.createElement('option');
                    newOption.value = s.schedule_tz;
                    newOption.text = `${s.schedule_tz} (custom)`;
                    newOption.selected = true;
                    tzSelect.insertBefore(newOption, tzSelect.firstChild);
                }
            }
            if (s.daily_limit) document.getElementById('okDailyLimit').value = s.daily_limit;
            const intervalEl = document.getElementById('okPublishInterval');
            if (intervalEl) intervalEl.value = String(s.publish_interval_hours ?? 24);
            const randomEl = document.getElementById('okRandomPublish');
            if (randomEl) randomEl.checked = !!s.random_publish;
            const premoderEl = document.getElementById('okPremoderation');
            if (premoderEl) premoderEl.checked = s.premoderation_enabled !== false;
            const postTypeEl = document.getElementById('okPostType');
            if (postTypeEl) postTypeEl.value = s.post_type || 'post';

            const weekdays = Array.isArray(s.allowed_weekdays) ? s.allowed_weekdays : [1, 2, 3, 4, 5];
            for (let d = 0; d <= 6; d++) {
                const cb = document.getElementById('okWeekday' + d);
                if (cb) cb.checked = weekdays.includes(d);
            }

            // Загружаем moderator_user_id
            const moderatorEl = document.getElementById('okModeratorUserId');
            if (moderatorEl) {
                moderatorEl.value = s.moderator_user_id || chatId;
            }
        } else {
            statusEl.textContent = '';
            if (disconnectBtn) disconnectBtn.style.display = 'none';
            if (settingsBlock) settingsBlock.style.display = 'none';
        }
    } catch (e) {
        console.error('loadOkStatus', e);
    }
}

async function saveOkToken() {
    const chatId = getChatId();
    if (!chatId) return;
    const groupId = document.getElementById('okGroupId')?.value?.trim();
    const accessToken = document.getElementById('okAccessToken')?.value?.trim();
    const sessionSecret = document.getElementById('okSessionSecret')?.value?.trim();
    const publicKey = document.getElementById('okPublicKey')?.value?.trim();

    if (!groupId || !accessToken || !sessionSecret) {
        showToast('Введите Group ID, Access Token и Session Secret', 'error');
        return;
    }

    try {
        const res = await fetch(`${API_MANAGE}/channels/ok`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                group_id: groupId,
                access_token: accessToken,
                session_secret: sessionSecret,
                public_key: publicKey
            })
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
            showToast('ОК подключён', 'success');
            await loadOkStatus();
        } else {
            showToast(data.error || 'Ошибка подключения', 'error');
        }
    } catch (e) {
        showToast('Ошибка сети', 'error');
    }
}

async function disconnectOk() {
    const chatId = getChatId();
    if (!chatId || !confirm('Отключить Одноклассники для этого окружения?')) return;
    try {
        const res = await fetch(`${API_MANAGE}/channels/ok?chat_id=${encodeURIComponent(chatId)}`, { method: 'DELETE' });
        if (res.ok) {
            showToast('ОК отключён', 'success');
            await loadOkStatus();
        } else {
            showToast('Ошибка отключения', 'error');
        }
    } catch (e) {
        showToast('Ошибка сети', 'error');
    }
}

async function saveOkSettings() {
    const chatId = getChatId();
    if (!chatId) return;
    updateOkScheduleTime();

    const moderatorUserId = (document.getElementById('okModeratorUserId')?.value || '').trim() || chatId;

    try {
        const res = await fetch(`${API_MANAGE}/channels/ok/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                schedule_time: (document.getElementById('okScheduleTime')?.value || '').trim(),
                schedule_tz: (document.getElementById('okScheduleTz')?.value || '').trim(),
                daily_limit: (document.getElementById('okDailyLimit')?.value || '').trim(),
                publish_interval_hours: parseFloat(document.getElementById('okPublishInterval')?.value || '24'),
                random_publish: !!document.getElementById('okRandomPublish')?.checked,
                premoderation_enabled: !!document.getElementById('okPremoderation')?.checked,
                post_type: (document.getElementById('okPostType')?.value || 'post').trim(),
                allowed_weekdays: [0,1,2,3,4,5,6].filter(d => document.getElementById('okWeekday' + d)?.checked),
                moderator_user_id: moderatorUserId
            })
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
            showToast('Настройки ОК сохранены', 'success');
            await loadOkStatus();
        } else {
            showToast(data.error || 'Ошибка сохранения', 'error');
        }
    } catch (e) {
        showToast('Ошибка сети', 'error');
    }
}

async function runOkNow() {
    const chatId = getChatId();
    if (!chatId) return;
    const btn = document.getElementById('okRunNowBtn');
    const statusEl = document.getElementById('okSettingsStatus');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Генерация...'; }
    if (statusEl) { statusEl.innerHTML = '<span style="color:#888;">Генерация ОК-поста... Это может занять 2-3 минуты.</span>'; }
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 180000);
        const res = await fetch(`${API_CONTENT}/ok/run-now`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, reason: 'ui_manual' }),
            signal: controller.signal
        });
        clearTimeout(timeoutId);
        const text = await res.text();
        let data;
        try { data = JSON.parse(text); } catch { data = { error: text || `HTTP ${res.status}` }; }
        if (res.ok && data.ok) {
            showToast(data.message || 'Задача в очереди', 'success');
            if (statusEl) { statusEl.innerHTML = '<span style="color:#0a0;">✅ ' + (data.message || 'Задача в очереди') + '. Черновик придёт в Telegram.</span>'; }
        } else {
            const errMsg = data.error || data.message || `HTTP ${res.status}`;
            showToast(errMsg, 'error');
            if (statusEl) { statusEl.innerHTML = '<span style="color:#c00;">❌ ' + errMsg + '</span>'; }
        }
    } catch (e) {
        const errMsg = e.name === 'AbortError' ? 'Таймаут (3 мин). Проверьте логи сервера.' : ('Ошибка сети: ' + e.message);
        showToast(errMsg, 'error');
        if (statusEl) { statusEl.innerHTML = '<span style="color:#c00;">❌ ' + errMsg + '</span>'; }
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '▶️ Сгенерировать сейчас'; }
    }
}

async function runTelegramNow() {
    const chatId = getChatId();
    if (!chatId) return;
    const btn = document.getElementById('telegramRunNowBtn');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Генерация...'; }
    try {
        const res = await fetch(`${API_CONTENT}/run-now`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, reason: 'ui_manual' })
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
            showToast(data.message || 'Контент сгенерирован', 'success');
        } else {
            showToast(data.error || data.message || 'Ошибка генерации', 'error');
        }
    } catch (e) {
        showToast('Ошибка сети', 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '▶️ Сгенерировать сейчас'; }
    }
}
