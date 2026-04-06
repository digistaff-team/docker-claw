const express = require('express');
const router = express.Router();
const manageStore = require('./store');
const telegramRunner = require('./telegram/runner');
const balanceService = require('../services/balance.service');
const { getEnabledChannels, setEnabledChannels, ensureChannelSchema, ensureSchema } = require('../services/content/repository');

router.post('/telegram', async (req, res) => {
    const { chat_id: chatId, token } = req.body;
    if (!chatId || !token) {
        return res.status(400).json({ error: 'chat_id and token are required' });
    }
    const trimmed = String(token).trim();
    if (!trimmed) {
        return res.status(400).json({ error: 'token is required' });
    }
    try {
        await manageStore.setToken(chatId, trimmed);
        telegramRunner.startBot(chatId, trimmed);
        
        // Получаем имя бота через getMe
        try {
            const { Telegraf } = require('telegraf');
            const tempBot = new Telegraf(trimmed);
            const botInfo = await tempBot.telegram.getMe();
            if (botInfo && botInfo.username) {
                await manageStore.setBotUsername(chatId, botInfo.username);
            }
            tempBot.stop();
        } catch (botErr) {
            console.error('[TELEGRAM-ROUTE] Could not fetch bot username:', botErr.message);
        }
        
        res.json({ success: true, message: 'Токен сохранён, бот запущен' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.post('/telegram/verify', async (req, res) => {
    const { chat_id: chatId, code } = req.body;
    if (!chatId || code === undefined) {
        return res.status(400).json({ error: 'chat_id and code are required' });
    }
    const result = manageStore.verify(chatId, String(code).trim());
    if (!result.ok) {
        const msg = result.reason === 'expired' ? 'Код просрочен' : result.reason === 'wrong_code' ? 'Неверный код' : 'Нет ожидающего кода';
        return res.status(400).json({ error: msg });
    }
    res.json({ success: true, message: 'Подтверждено' });
});

router.get('/telegram/status', (req, res) => {
    const chatId = req.query.chat_id;
    if (!chatId) {
        return res.status(400).json({ error: 'chat_id is required' });
    }
    const data = manageStore.getState(chatId);
    const hasToken = !!(data && data.token);
    const verified = !!(data && data.verifiedTelegramId);
    const username = data && data.verifiedUsername ? data.verifiedUsername : null;
    const pending = !!(data && data.pending);
    const botUsername = data && data.botUsername ? data.botUsername : null;

    // Возвращаем полный токен (пользователь авторизован по Chat ID)
    const fullToken = hasToken && data.token ? data.token : null;

    res.json({
        hasToken,
        verified,
        username,
        pending,
        botUsername,
        token: fullToken, // Полный токен для отображения в форме
        telegramId: data && data.verifiedTelegramId ? data.verifiedTelegramId : null,
        firstName: data && data.verifiedFirstName ? data.verifiedFirstName : null,
        lastName: data && data.verifiedLastName ? data.verifiedLastName : null
    });
});

/**
 * GET /api/manage/telegram/user-info - Получить информацию о пользователе Telegram по chat_id
 * Требует ADMIN_PASSWORD
 * Возвращает: username, first_name, last_name, language_code
 */
router.get('/telegram/user-info', async (req, res) => {
    const chatId = req.query.chat_id;
    const adminPassword = req.headers['x-admin-password'] || req.query.admin_password;
    
    if (!chatId) {
        return res.status(400).json({ error: 'chat_id is required' });
    }
    
    // Проверка админского пароля
    if (adminPassword !== process.env.ADMIN_PASSWORD) {
        return res.status(401).json({ error: 'Admin authentication required' });
    }
    
    try {
        // Сначала пробуем получить из сохранённых данных
        const data = manageStore.getState(chatId);
        if (data && data.verifiedTelegramId) {
            return res.json({
                success: true,
                telegramId: data.verifiedTelegramId,
                username: data.verifiedUsername || null,
                firstName: data.verifiedFirstName || null,
                lastName: data.verifiedLastName || null,
                fromCache: true
            });
        }
        
        // Если нет сохранённых данных - пробуем получить через Bot API
        // Используем AUTH_BOT_TOKEN для запроса
        const botToken = process.env.AUTH_BOT_TOKEN;
        if (!botToken) {
            return res.status(500).json({ error: 'AUTH_BOT_TOKEN not configured' });
        }
        
        // Запрашиваем информацию о пользователе через getChat
        const botApiUrl = `https://api.telegram.org/bot${botToken}/getChat?chat_id=${encodeURIComponent(chatId)}`;
        const botResponse = await fetch(botApiUrl);
        const botResult = await botResponse.json();
        
        if (botResult.ok) {
            const chat = botResult.result;
            return res.json({
                success: true,
                telegramId: chat.id,
                username: chat.username || null,
                firstName: chat.first_name || null,
                lastName: chat.last_name || null,
                languageCode: chat.language_code || null,
                fromCache: false
            });
        } else {
            return res.status(404).json({ 
                error: 'User not found or bot cannot access this chat',
                telegramError: botResult.description 
            });
        }
    } catch (e) {
        console.error('[TELEGRAM-USER-INFO] Error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

router.delete('/telegram', (req, res) => {
    const chatId = req.query.chat_id || req.body.chat_id;
    if (!chatId) {
        return res.status(400).json({ error: 'chat_id is required' });
    }
    telegramRunner.stopBot(chatId);
    manageStore.clearToken(chatId);
    res.json({ success: true });
});

// AI Router settings
router.post('/ai', async (req, res) => {
    const { chat_id: chatId, bot_id, bot_token, user_email, model } = req.body;
    if (!chatId || !bot_id || !bot_token || !user_email || !model) {
        return res.status(400).json({ error: 'chat_id, bot_id, bot_token, user_email and model are required' });
    }
    const trimmedId = String(bot_id).trim();
    const trimmedToken = String(bot_token).trim();
    const trimmedEmail = String(user_email).trim();
    if (!trimmedId || !trimmedToken || !trimmedEmail) {
        return res.status(400).json({ error: 'bot_id, bot_token and user_email are required' });
    }
    
    // Проверяем баланс пользователя
    const balanceCheck = await balanceService.checkAICanUse(trimmedEmail);
    
    // Сохраняем информацию о балансе в store
    await manageStore.setAI(chatId, trimmedId, trimmedToken, trimmedEmail, model, balanceCheck);
    
    // Если баланс невалидный - возвращаем предупреждение, но сохраняем настройки
    if (!balanceCheck.canUse) {
        return res.json({ 
            success: true, 
            message: 'Настройки сохранены, но ИИ отключён из-за проблем с балансом',
            balanceWarning: {
                balance: balanceCheck.balance,
                expired: balanceCheck.expired,
                reason: balanceCheck.reason,
                aiBlocked: true
            }
        });
    }
    
    res.json({ 
        success: true, 
        message: 'ИИ ассистент настроен',
        balance: {
            balance: balanceCheck.balance,
            expired: balanceCheck.expired
        }
    });
});

router.get('/ai/status', (req, res) => {
    const chatId = req.query.chat_id;
    if (!chatId) {
        return res.status(400).json({ error: 'chat_id is required' });
    }
    const data = manageStore.getState(chatId);
    
    // Возвращаем полный токен (пользователь авторизован по Chat ID)
    // Это нужно для корректного отображения при смене модели
    const fullBotToken = data && data.aiBotToken ? data.aiBotToken : null;
    
    // AI считается настроенным если есть ProTalk (aiAuthToken) ИЛИ OpenAI/OpenRouter (aiCustomApiKey)
    const hasProTalk = !!(data && data.aiAuthToken);
    const hasCustomProvider = !!(data && data.aiCustomApiKey && (data.aiProvider === 'openai' || data.aiProvider === 'openrouter'));

    res.json({
        hasAI: hasProTalk || hasCustomProvider,
        aiBotId: data && data.aiBotId ? data.aiBotId : null,
        aiBotToken: fullBotToken, // Полный токен для отображения в форме
        aiUserEmail: data && data.aiUserEmail ? data.aiUserEmail : null,
        aiModel: data && data.aiModel ? data.aiModel : null,
        aiProvider: data && data.aiProvider ? data.aiProvider : null,
        aiBlocked: data && data.aiBlocked ? data.aiBlocked : false,
        balance: data && data.aiBalance !== undefined ? data.aiBalance : null,
        balanceExpired: data && data.aiBalanceExpired ? data.aiBalanceExpired : null
    });
});

// AI Context settings
router.get('/ai/context-settings', (req, res) => {
    const chatId = req.query.chat_id;
    if (!chatId) {
        return res.status(400).json({ error: 'chat_id is required' });
    }
    const settings = manageStore.getContextSettings(chatId);
    res.json(settings);
});

router.post('/ai/context-settings', async (req, res) => {
    const { chat_id: chatId, ...settings } = req.body;
    if (!chatId) {
        return res.status(400).json({ error: 'chat_id is required' });
    }
    try {
        await manageStore.setContextSettings(chatId, settings);
        res.json({ success: true, message: 'Настройки контекста сохранены' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.delete('/ai', (req, res) => {
    const chatId = req.query.chat_id || req.body.chat_id;
    if (!chatId) {
        return res.status(400).json({ error: 'chat_id is required' });
    }
    manageStore.clearAI(chatId);
    res.json({ success: true, message: 'ИИ отключён' });
});

// AI Provider settings (OpenAI / OpenRouter)
router.post('/ai/provider', async (req, res) => {
    const { chat_id: chatId, provider, api_key, model } = req.body;
    
    if (!chatId || !provider) {
        return res.status(400).json({ error: 'chat_id and provider are required' });
    }
    
    // Валидация провайдера
    const validProviders = ['protalk', 'openai', 'openrouter'];
    if (!validProviders.includes(provider)) {
        return res.status(400).json({ error: `Invalid provider. Must be one of: ${validProviders.join(', ')}` });
    }
    
    // Для openai и openrouter нужен API ключ
    if ((provider === 'openai' || provider === 'openrouter') && !api_key) {
        return res.status(400).json({ error: 'api_key is required for openai/openrouter providers' });
    }
    
    try {
        // Сохраняем настройки провайдера
        await manageStore.setAIProvider(chatId, provider, api_key, model);
        
        let message = '';
        switch (provider) {
            case 'openai':
                message = `Настройки OpenAI сохранены. Модель: ${model || 'gpt-4o'}`;
                break;
            case 'openrouter':
                message = `Настройки OpenRouter сохранены. Модель: ${model || 'anthropic/claude-3-haiku'}`;
                break;
            case 'protalk':
            default:
                message = 'Переключено на ProTalk AI';
                break;
        }
        
        res.json({ success: true, message });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.get('/ai/provider', (req, res) => {
    const chatId = req.query.chat_id;
    if (!chatId) {
        return res.status(400).json({ error: 'chat_id is required' });
    }
    
    const providerInfo = manageStore.getAIProvider(chatId);
    
    res.json({
        provider: providerInfo.provider,
        model: providerInfo.model,
        // Не возвращаем полный API ключ в целях безопасности
        hasApiKey: !!providerInfo.apiKey,
        // Для ProTalk возвращаем данные бота
        hasProTalkConfig: !!(providerInfo.botId && providerInfo.botToken),
        userEmail: providerInfo.userEmail
    });
});

// Email settings
router.post('/email', async (req, res) => {
    const { chat_id: chatId, imap_host, imap_port, imap_user, imap_pass, smtp_host, smtp_port, smtp_user, smtp_pass, poll_interval_minutes } = req.body;
    if (!chatId || !imap_host || !imap_user || !imap_pass || !smtp_host || !smtp_user || !smtp_pass) {
        return res.status(400).json({ error: 'Required fields: chat_id, imap_host/user/pass, smtp_host/user/pass' });
    }
    try {
        const config = {
            imapHost: imap_host,
            imapPort: parseInt(imap_port) || 993,
            imapUser: imap_user,
            imapPass: imap_pass,
            smtpHost: smtp_host,
            smtpPort: parseInt(smtp_port) || 587,
            smtpUser: smtp_user,
            smtpPass: smtp_pass,
            pollIntervalMinutes: parseInt(poll_interval_minutes) || 5
        };
        await manageStore.setEmail(chatId, config);
        require('./email/processor').startEmailCron();
        console.log(`[EMAIL-ACTIVATED] ${chatId}: настройки сохранены, cron активен (интервал ${config.pollIntervalMinutes} мин)`);
        res.json({ success: true, message: 'Email настройки сохранены' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.post('/email/poll', async (req, res) => {
    const { chat_id: chatId, minutes } = req.body;
    if (!chatId || minutes == null) {
        return res.status(400).json({ error: 'chat_id and minutes are required' });
    }
    manageStore.setEmailPoll(chatId, parseInt(minutes));
    res.json({ success: true, message: `Интервал обновлён на ${minutes} мин` });
});

router.get('/email/status', (req, res) => {
    const chatId = req.query.chat_id;
    if (!chatId) {
        return res.status(400).json({ error: 'chat_id is required' });
    }
    const status = manageStore.getEmailStatus(chatId);
    res.json(status);
});

router.delete('/email', (req, res) => {
    const chatId = req.query.chat_id || req.body.chat_id;
    if (!chatId) {
        return res.status(400).json({ error: 'chat_id is required' });
    }
    manageStore.clearEmail(chatId);
    if (!manageStore.hasAnyEmailActive()) {
        const processor = require('./email/processor');
        processor.stopEmailCron();
        console.log('[ROUTES] Last email removed, cron stopped');
    }
    res.json({ success: true, message: 'Email откл��чён' });
});

router.get('/cron/status', (req, res) => {
    const chatId = req.query.chat_id;
    if (!chatId) {
        return res.status(400).json({ error: 'chat_id is required' });
    }
    const status = manageStore.getCronStatus(chatId);
    res.json(status);
});

router.get('/cron/logs', (req, res) => {
    const chatId = req.query.chat_id;
    if (!chatId) {
        return res.status(400).json({ error: 'chat_id is required' });
    }
    const logs = manageStore.getCronLogs(chatId);
    res.json(logs);
});

router.post('/cron/poll-now', async (req, res) => {
    const { chat_id: chatId } = req.body;
    if (!chatId) {
        return res.status(400).json({ error: 'chat_id is required' });
    }
    try {
        const processor = require('./email/processor');
        const result = await processor.processSingleEmail(chatId, true);
        console.log(`[ROUTES-MANUAL-POLL] ${chatId}:`, result);
        res.json({ success: true, ...result });
    } catch (e) {
        console.error('[ROUTES-MANUAL-POLL-ERR]', chatId, e.message);
        res.status(500).json({ error: e.message });
    }
});

router.get('/ai/skills', async (req, res) => {
    const chatId = req.query.chat_id;
    if (!chatId) {
        return res.status(400).json({ error: 'chat_id is required' });
    }
    
    const data = manageStore.getState(chatId);
    const userEmail = data && data.aiUserEmail ? data.aiUserEmail : null;

    if (!userEmail) {
        return res.json({ skills: [] });
    }

    try {
        // Используем локальный MySQL сервис
        const mysqlService = require('../services/mysql.service');
        const skills = await mysqlService.getUserSkills(userEmail);
        res.json({ skills });
    } catch (e) {
        console.error('[AI-SKILLS-ERROR]', e.message);
        res.json({ skills: [], error: e.message });
    }
});

// ===========================================
// MySQL Query Endpoint (для клиентских запросов)
// ===========================================
router.post('/mysql/query', async (req, res) => {
    try {
        const { sql, params = [] } = req.body;
        
        if (!sql) {
            return res.status(400).json({ error: 'SQL query is required' });
        }
        
        // Используем локальный MySQL сервис
        const mysqlService = require('../services/mysql.service');
        const result = await mysqlService.query(sql, params);
        
        res.json(result);
    } catch (e) {
        console.error('[MYSQL-QUERY-ERROR]', e.message);
        res.status(500).json({ error: e.message });
    }
});

router.get('/content/settings', (req, res) => {
    const chatId = req.query.chat_id;
    if (!chatId) {
        return res.status(400).json({ error: 'chat_id is required' });
    }
    const settings = manageStore.getContentSettings(chatId) || {};
    res.json({ settings });
});

router.post('/content/settings', async (req, res) => {
    const {
        chat_id: chatId,
        channel_id: channelId,
        moderator_user_id: moderatorUserId,
        schedule_time: scheduleTime,
        schedule_tz: scheduleTz,
        daily_limit: dailyLimit,
        publish_interval_hours: publishIntervalHours,
        allowed_weekdays: allowedWeekdays,
        random_publish: randomPublish,
        premoderation_enabled: premoderationEnabled
    } = req.body;

    if (!chatId) {
        return res.status(400).json({ error: 'chat_id is required' });
    }
    try {
        await manageStore.setContentSettings(chatId, {
            channelId,
            moderatorUserId,
            scheduleTime,
            scheduleTz,
            dailyLimit,
            publishIntervalHours,
            allowedWeekdays,
            randomPublish,
            premoderationEnabled
        });
        const settings = manageStore.getContentSettings(chatId) || {};
        res.json({ success: true, settings });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// === Pinterest Channel ===

router.get('/channels/pinterest', (req, res) => {
    const chatId = req.query.chat_id;
    if (!chatId) return res.status(400).json({ error: 'chat_id is required' });
    const config = manageStore.getPinterestConfig(chatId);
    if (config && config.buffer_api_key && config.buffer_channel_id) {
        const safeConfig = { ...config };
        // Маскируем Buffer API ключ
        if (safeConfig.buffer_api_key) safeConfig.buffer_api_key = safeConfig.buffer_api_key.slice(0, 6) + '***';
        // Убираем legacy OAuth-поля
        delete safeConfig.app_id;
        delete safeConfig.app_secret;
        delete safeConfig.access_token;
        delete safeConfig.refresh_token;
        delete safeConfig.access_token_expires;
        res.json({ connected: true, config: safeConfig });
    } else {
        res.json({ connected: false, config: null });
    }
});

router.post('/channels/pinterest', async (req, res) => {
    const { chat_id: chatId, board_id, board_name, website_url, is_active, auto_publish,
        buffer_api_key, buffer_channel_id,
        schedule_time, schedule_tz, daily_limit, publish_interval_hours, allowed_weekdays } = req.body;
    if (!chatId) return res.status(400).json({ error: 'chat_id is required' });
    try {
        const patch = {};
        if (board_id !== undefined) patch.board_id = board_id;
        if (board_name !== undefined) patch.board_name = board_name;
        if (website_url !== undefined) patch.website_url = website_url;
        if (is_active !== undefined) patch.is_active = is_active;
        if (auto_publish !== undefined) patch.auto_publish = auto_publish;
        if (buffer_api_key !== undefined) patch.buffer_api_key = buffer_api_key;
        if (buffer_channel_id !== undefined) patch.buffer_channel_id = buffer_channel_id;
        if (schedule_time !== undefined) patch.schedule_time = schedule_time;
        if (schedule_tz !== undefined) patch.schedule_tz = schedule_tz;
        if (daily_limit !== undefined) patch.daily_limit = daily_limit;
        if (publish_interval_hours !== undefined) patch.publish_interval_hours = publish_interval_hours;
        if (allowed_weekdays !== undefined) patch.allowed_weekdays = allowed_weekdays;
        await manageStore.setPinterestConfig(chatId, patch);

        // Создаём таблицы для Pinterest
        await ensureChannelSchema(chatId, 'pinterest');

        res.json({ success: true });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

router.delete('/channels/pinterest', async (req, res) => {
    const chatId = req.query.chat_id;
    if (!chatId) return res.status(400).json({ error: 'chat_id is required' });
    try {
        await manageStore.clearPinterestConfig(chatId);
        res.json({ success: true });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

router.get('/channels/pinterest/boards', async (req, res) => {
    const chatId = req.query.chat_id;
    if (!chatId) return res.status(400).json({ error: 'chat_id is required' });
    try {
        const pinterestRepo = require('../services/content/pinterest.repository');
        const boards = await pinterestRepo.getBoards(chatId);
        res.json({ boards: (boards || []).map(b => ({
            id: b.board_id,
            name: b.board_name,
            idea: b.idea,
            focus: b.focus,
            purpose: b.purpose,
            keywords: b.keywords,
            link: b.link
        })) });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Проверка соединения с Buffer API
router.post('/channels/pinterest/test-buffer', async (req, res) => {
    const { chat_id: chatId, buffer_api_key, buffer_channel_id } = req.body;
    if (!chatId) return res.status(400).json({ error: 'chat_id is required' });
    if (!buffer_api_key || !buffer_channel_id) {
        return res.status(400).json({ error: 'buffer_api_key и buffer_channel_id обязательны' });
    }
    try {
        const bufferService = require('../services/buffer.service');
        const result = await bufferService.testConnection(buffer_api_key, buffer_channel_id);
        res.json({ success: true, ...result });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// Загрузка досок Pinterest из Buffer API
router.post('/channels/pinterest/boards/import-buffer', async (req, res) => {
    const chatId = req.body.chat_id;
    if (!chatId) return res.status(400).json({ error: 'chat_id is required' });
    // Берём credentials из store (в UI они замаскированы)
    const cfg = manageStore.getPinterestConfig(chatId) || {};
    const apiKey = req.body.buffer_api_key || cfg.buffer_api_key;
    const channelId = req.body.buffer_channel_id || cfg.buffer_channel_id;
    if (!apiKey || !channelId) {
        return res.status(400).json({ error: 'buffer_api_key и buffer_channel_id не настроены' });
    }
    try {
        const bufferService = require('../services/buffer.service');
        const pinterestRepo = require('../services/content/pinterest.repository');
        const boards = await bufferService.getPinterestBoards(apiKey, channelId);
        const mapped = boards.map(b => ({
            id: b.serviceId || b.id,
            name: b.name,
            serviceId: b.serviceId,
            description: b.description || '',
            link: b.url || ''
        }));
        await pinterestRepo.ensureBoardsSchema(chatId);
        const saved = await pinterestRepo.saveBoards(chatId, mapped);
        res.json({ success: true, boards: saved, count: saved.length });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// Обновление настроек доски (идея, фокус, ключи, ссылка)
router.post('/channels/pinterest/board', async (req, res) => {
    const chatId = req.body.chat_id;
    const { board_id, idea, focus, purpose, keywords, link } = req.body;
    if (!chatId || !board_id) {
        return res.status(400).json({ error: 'chat_id и board_id обязательны' });
    }
    try {
        const { updateBoard } = require('../services/pinterest.service');
        await updateBoard(chatId, board_id, { idea, focus, purpose, keywords, link });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Получение настроек одной доски
router.get('/channels/pinterest/board', async (req, res) => {
    const chatId = req.query.chat_id;
    const board_id = req.query.board_id;
    if (!chatId || !board_id) {
        return res.status(400).json({ error: 'chat_id и board_id обязательны' });
    }
    try {
        const { getBoard } = require('../services/pinterest.service');
        const board = await getBoard(chatId, board_id);
        if (!board) {
            return res.status(404).json({ error: 'Доска не найдена' });
        }
        // Возвращаем только публичные данные (без чувствительных полей)
        res.json({
            board_id: board.board_id,
            board_name: board.board_name,
            idea: board.idea || null,
            focus: board.focus || null,
            purpose: board.purpose || null,
            keywords: board.keywords || null,
            link: board.link || null
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Обновление настроек всех досок (массовое сохранение)
router.post('/channels/pinterest/boards', async (req, res) => {
    const chatId = req.body.chat_id;
    const boards = req.body.boards;
    if (!chatId) {
        return res.status(400).json({ error: 'chat_id обязателен' });
    }
    if (!Array.isArray(boards)) {
        return res.status(400).json({ error: 'boards должен быть массивом' });
    }
    try {
        const { saveBoardsToDb } = require('../services/pinterest.service');
        await saveBoardsToDb(chatId, boards.map(b => ({
            board_id: b.id,
            board_name: b.name,
            idea: b.idea || null,
            focus: b.focus || null,
            purpose: b.purpose || null,
            keywords: b.keywords || null,
            link: b.link || null
        })));
        res.json({ success: true, count: boards.length });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Удаление доски из базы
router.delete('/channels/pinterest/board', async (req, res) => {
    const chatId = req.body.chat_id || req.query.chat_id;
    const board_id = req.body.board_id || req.query.board_id;
    if (!chatId || !board_id) {
        return res.status(400).json({ error: 'chat_id и board_id обязательны' });
    }
    try {
        const { deleteBoard } = require('../services/pinterest.service');
        await deleteBoard(chatId, board_id);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// === Instagram ===

router.get('/channels/instagram', (req, res) => {
    const chatId = req.query.chat_id;
    if (!chatId) return res.status(400).json({ error: 'chat_id is required' });
    const config = manageStore.getInstagramConfig(chatId);
    if (!config) return res.json({ connected: false });
    const safe = { ...config };
    if (safe.app_secret) safe.app_secret = safe.app_secret.slice(0, 4) + '****';
    if (safe.access_token) safe.access_token = safe.access_token.slice(0, 8) + '****';
    res.json({ connected: true, config: safe });
});

router.post('/channels/instagram', async (req, res) => {
    const chatId = req.body.chat_id;
    if (!chatId) return res.status(400).json({ error: 'chat_id is required' });
    try {
        const patch = {};
        const fields = [
            'app_id', 'app_secret', 'access_token',
            'fb_page_id', 'fb_page_name', 'ig_user_id', 'ig_username',
            'default_alt_text', 'location_id',
            'is_active', 'auto_publish', 'is_reel',
            'daily_limit', 'posting_hours',
            'moderator_user_id'
        ];
        for (const f of fields) {
            if (req.body[f] !== undefined) patch[f] = req.body[f];
        }
        await manageStore.setInstagramConfig(chatId, patch);
        res.json({ success: true });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

router.delete('/channels/instagram', async (req, res) => {
    const chatId = req.query.chat_id;
    if (!chatId) return res.status(400).json({ error: 'chat_id is required' });
    try {
        await manageStore.clearInstagramConfig(chatId);
        res.json({ success: true });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

router.get('/channels/instagram/accounts', async (req, res) => {
    const chatId = req.query.chat_id;
    if (!chatId) return res.status(400).json({ error: 'chat_id is required' });
    const config = manageStore.getInstagramConfig(chatId);
    if (!config || !config.access_token) {
        return res.status(400).json({ error: 'Instagram не подключён или отсутствует access_token. Подключите приложение через Facebook OAuth.' });
    }
    try {
        // Запрос Facebook Pages с привязанными Instagram-аккаунтами
        const fetch = require('node-fetch');
        const fbRes = await fetch(
            `https://graph.facebook.com/v19.0/me/accounts?fields=id,name,instagram_business_account{id,username}&access_token=${encodeURIComponent(config.access_token)}`,
            { timeout: 15000 }
        );
        if (!fbRes.ok) {
            const err = await fbRes.text();
            return res.status(fbRes.status).json({ error: `Facebook API error: ${err.slice(0, 300)}` });
        }
        const fbData = await fbRes.json();
        const accounts = (fbData.data || [])
            .filter(p => p.instagram_business_account)
            .map(p => ({
                fb_page_id: p.id,
                page_name: p.name,
                ig_user_id: p.instagram_business_account.id,
                ig_username: p.instagram_business_account.username || ''
            }));
        res.json({ accounts });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// === VKontakte Channel ===

router.get('/channels/vk', async (req, res) => {
    try {
        const chatId = req.query.chat_id;
        if (!chatId) {
            return res.status(400).json({ error: 'chat_id is required' });
        }

        const vkConfig = manageStore.getVkConfig(chatId);
        const vkSettings = manageStore.getVkSettings(chatId);

        res.json({
            connected: !!vkConfig?.group_id,
            config: vkConfig || {},
            settings: vkSettings || {}
        });
    } catch (e) {
        console.error('GET /api/manage/channels/vk', e);
        res.status(500).json({ error: e.message });
    }
});

router.post('/channels/vk', async (req, res) => {
    try {
        const { chat_id, group_id, service_key } = req.body;
        if (!chat_id || !group_id || !service_key) {
            return res.status(400).json({ error: 'chat_id, group_id, and service_key are required' });
        }

        manageStore.setVkConfig(chat_id, {
            group_id,
            service_key,
            is_active: true,
            connected_at: new Date().toISOString()
        });

        // Создаём таблицы для VK
        await ensureChannelSchema(chat_id, 'vk');

        res.json({ success: true });
    } catch (e) {
        console.error('POST /api/manage/channels/vk', e);
        res.status(500).json({ error: e.message });
    }
});

router.delete('/channels/vk', async (req, res) => {
    try {
        const chatId = req.query.chat_id;
        if (!chatId) {
            return res.status(400).json({ error: 'chat_id is required' });
        }

        manageStore.setVkConfig(chatId, {});
        manageStore.setVkSettings(chatId, {});

        res.json({ success: true });
    } catch (e) {
        console.error('DELETE /api/manage/channels/vk', e);
        res.status(500).json({ error: e.message });
    }
});

router.post('/channels/vk/settings', async (req, res) => {
    try {
        const {
            chat_id,
            schedule_time,
            schedule_tz,
            daily_limit,
            publish_interval_hours,
            random_publish,
            premoderation_enabled,
            post_type,
            allowed_weekdays,
            moderator_user_id
        } = req.body;

        console.log(`[VK-SETTINGS] POST /api/manage/channels/vk/settings received: chat_id=${chat_id}, moderator_user_id=${moderator_user_id}`);

        if (!chat_id) {
            console.error('[VK-SETTINGS] Missing chat_id');
            return res.status(400).json({ error: 'chat_id is required' });
        }

        console.log(`[VK-SETTINGS] Saving moderator_user_id=${moderator_user_id} for chat_id=${chat_id}`);

        manageStore.setVkSettings(chat_id, {
            schedule_time,
            schedule_tz,
            daily_limit,
            publish_interval_hours,
            random_publish,
            premoderation_enabled,
            post_type,
            allowed_weekdays,
            moderatorUserId: moderator_user_id
        });

        const verifySettings = manageStore.getVkSettings(chat_id);
        console.log(`[VK-SETTINGS] After save: moderator_user_id=${verifySettings?.moderator_user_id}`);

        res.json({ success: true });
    } catch (e) {
        console.error('POST /api/manage/channels/vk/settings', e);
        res.status(500).json({ error: e.message });
    }
});

// === Odnoklassniki Channel ===

router.get('/channels/ok', async (req, res) => {
    try {
        const chatId = req.query.chat_id;
        if (!chatId) {
            return res.status(400).json({ error: 'chat_id is required' });
        }

        const okConfig = manageStore.getOkConfig(chatId);
        const okSettings = manageStore.getOkSettings(chatId);

        res.json({
            connected: !!okConfig?.group_id,
            config: okConfig || {},
            settings: okSettings || {}
        });
    } catch (e) {
        console.error('GET /api/manage/channels/ok', e);
        res.status(500).json({ error: e.message });
    }
});

router.post('/channels/ok', async (req, res) => {
    try {
        const { chat_id, group_id, access_token, session_secret, public_key } = req.body;
        if (!chat_id || !group_id || !access_token || !session_secret) {
            return res.status(400).json({ error: 'chat_id, group_id, access_token, and session_secret are required' });
        }

        manageStore.setOkConfig(chat_id, {
            group_id,
            access_token,
            session_secret,
            public_key: public_key || null,
            is_active: true,
            connected_at: new Date().toISOString()
        });

        // Создаём таблицы для OK
        await ensureChannelSchema(chat_id, 'ok');

        res.json({ success: true });
    } catch (e) {
        console.error('POST /api/manage/channels/ok', e);
        res.status(500).json({ error: e.message });
    }
});

router.delete('/channels/ok', async (req, res) => {
    try {
        const chatId = req.query.chat_id;
        if (!chatId) {
            return res.status(400).json({ error: 'chat_id is required' });
        }

        manageStore.setOkConfig(chatId, {});
        manageStore.setOkSettings(chatId, {});

        res.json({ success: true });
    } catch (e) {
        console.error('DELETE /api/manage/channels/ok', e);
        res.status(500).json({ error: e.message });
    }
});

router.post('/channels/ok/settings', async (req, res) => {
    try {
        const {
            chat_id,
            schedule_time,
            schedule_tz,
            daily_limit,
            publish_interval_hours,
            random_publish,
            premoderation_enabled,
            post_type,
            allowed_weekdays,
            moderator_user_id
        } = req.body;

        if (!chat_id) {
            return res.status(400).json({ error: 'chat_id is required' });
        }

        manageStore.setOkSettings(chat_id, {
            schedule_time,
            schedule_tz,
            daily_limit,
            publish_interval_hours,
            random_publish,
            premoderation_enabled,
            post_type,
            allowed_weekdays,
            moderatorUserId: moderator_user_id
        });

        res.json({ success: true });
    } catch (e) {
        console.error('POST /api/manage/channels/ok/settings', e);
        res.status(500).json({ error: e.message });
    }
});

router.get('/config-path', (req, res) => {
    const chatId = req.query.chat_id;
    const configPath = manageStore.getConfigPath(chatId);
    res.json({ configPath });
});

// AI Router Logs
router.get('/ai/router-logs', (req, res) => {
    const chatId = req.query.chat_id;
    if (!chatId) {
        return res.status(400).json({ error: 'chat_id is required' });
    }
    const limit = parseInt(req.query.limit) || 50;
    const logs = manageStore.getAIRouterLogs(chatId, limit);
    const stats = manageStore.getAIRouterStats(chatId);
    res.json({ logs, stats });
});

router.delete('/ai/router-logs', (req, res) => {
    const chatId = req.query.chat_id || req.body.chat_id;
    if (!chatId) {
        return res.status(400).json({ error: 'chat_id is required' });
    }
    manageStore.clearAIRouterLogs(chatId);
    res.json({ success: true, message: 'Логи AI Router очищены' });
});

// === Setup / Onboarding ===

/**
 * GET /api/manage/setup - Получить статус онбординга
 */
router.get('/setup', async (req, res) => {
    try {
        const chatId = req.query.chat_id;
        if (!chatId) {
            return res.status(400).json({ error: 'chat_id is required' });
        }

        const state = manageStore.getState(chatId);
        const hasBotToken = !!(state && state.token);
        const onboardingComplete = !!(state && state.onboardingComplete);

        let enabledChannels = [];
        if (onboardingComplete) {
            try {
                enabledChannels = await getEnabledChannels(chatId);
            } catch (dbErr) {
                console.error('GET /api/manage/setup - getEnabledChannels error:', dbErr.message);
            }
        }

        res.json({
            onboardingComplete,
            hasBotToken,
            enabledChannels: enabledChannels || []
        });
    } catch (e) {
        console.error('GET /api/manage/setup', e);
        res.status(500).json({ error: e.message });
    }
});

/**
 * POST /api/manage/setup - Сохранить токен бота и выбранные каналы
 */
router.post('/setup', async (req, res) => {
    try {
        const { chat_id: chatId, channels } = req.body;
        if (!chatId) {
            return res.status(400).json({ error: 'chat_id is required' });
        }

        // Проверяем что аккаунт уже подтвержден через CW-бот
        const data = manageStore.getState(chatId);
        if (!data?.verifiedTelegramId) {
            return res.status(400).json({ error: 'Сначала подтвердите аккаунт через бота Копирайтер' });
        }

        // Гарантируем что схема БД пользователя создана
        await ensureSchema(chatId);

        // Сохраняем выбранные каналы (всегда включаем telegram)
        const selectedChannels = Array.isArray(channels) ? channels : [];
        if (!selectedChannels.includes('telegram')) {
            selectedChannels.push('telegram');
        }
        await setEnabledChannels(chatId, selectedChannels);

        // Ставим флаг завершения онбординга (в manageStore, чтобы GET /setup читал оттуда же)
        manageStore.setOnboardingComplete(chatId, true);

        res.json({ success: true, message: 'Настройка завершена' });
    } catch (e) {
        console.error('POST /api/manage/setup', e);
        res.status(500).json({ error: e.message });
    }
});

/**
 * GET /api/manage/enabled-channels - Получить список включённых каналов
 */
router.get('/enabled-channels', async (req, res) => {
    try {
        const chatId = req.query.chat_id;
        if (!chatId) {
            return res.status(400).json({ error: 'chat_id is required' });
        }

        const channels = await getEnabledChannels(chatId);
        res.json({ channels: channels || [] });
    } catch (e) {
        console.error('GET /api/manage/enabled-channels', e);
        res.status(500).json({ error: e.message });
    }
});

/**
 * POST /api/manage/enabled-channels - Обновить список включённых каналов
 */
router.post('/enabled-channels', async (req, res) => {
    try {
        const { chat_id: chatId, channels } = req.body;
        if (!chatId) {
            return res.status(400).json({ error: 'chat_id is required' });
        }

        const selectedChannels = Array.isArray(channels) ? channels : [];
        if (!selectedChannels.includes('telegram')) {
            selectedChannels.unshift('telegram');
        }

        await setEnabledChannels(chatId, selectedChannels);
        res.json({ success: true, channels: selectedChannels });
    } catch (e) {
        console.error('POST /api/manage/enabled-channels', e);
        res.status(500).json({ error: e.message });
    }
});

// === YouTube Channel ===

/**
 * GET /api/manage/channels/youtube — чтение конфига
 */
router.get('/channels/youtube', async (req, res) => {
    try {
        const chatId = req.query.chat_id;
        if (!chatId) return res.status(400).json({ error: 'chat_id required' });

        const cfg = manageStore.getYoutubeConfig(chatId);
        if (!cfg) return res.json({ connected: false });

        res.json({ connected: true, config: cfg });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/**
 * POST /api/manage/channels/youtube — сохранение конфига
 */
router.post('/channels/youtube', async (req, res) => {
    try {
        const {
            chat_id: chatId, buffer_api_key, buffer_channel_id,
            is_active, auto_publish, schedule_time, schedule_tz,
            daily_limit, publish_interval_hours, allowed_weekdays,
            moderator_user_id, random_publish
        } = req.body;

        console.log(`[YOUTUBE] POST /channels/youtube chatId=${chatId}, is_active=${is_active}`);

        if (!chatId) return res.status(400).json({ error: 'chat_id required' });

        const patch = {};
        if (buffer_api_key !== undefined && !buffer_api_key.endsWith('***')) patch.buffer_api_key = buffer_api_key;
        if (buffer_channel_id !== undefined) patch.buffer_channel_id = buffer_channel_id;
        if (is_active !== undefined) patch.is_active = is_active;
        if (auto_publish !== undefined) patch.auto_publish = auto_publish;
        if (schedule_time !== undefined) patch.schedule_time = schedule_time;
        if (schedule_tz !== undefined) patch.schedule_tz = schedule_tz;
        if (daily_limit !== undefined) patch.daily_limit = daily_limit;
        if (publish_interval_hours !== undefined) patch.publish_interval_hours = publish_interval_hours;
        if (allowed_weekdays !== undefined) patch.allowed_weekdays = allowed_weekdays;
        if (moderator_user_id !== undefined) patch.moderator_user_id = moderator_user_id;
        if (random_publish !== undefined) patch.random_publish = random_publish;

        manageStore.setYoutubeConfig(chatId, patch);

        // Инициализация YouTube-схемы в БД пользователя (не критично, если БД недоступна)
        try {
            await ensureChannelSchema(chatId, 'youtube');
        } catch (dbErr) {
            console.warn(`[YOUTUBE] ensureChannelSchema skipped (DB unavailable): ${dbErr.message}`);
        }

        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/**
 * DELETE /api/manage/channels/youtube — удаление конфига
 */
router.delete('/channels/youtube', async (req, res) => {
    try {
        const chatId = req.query.chat_id;
        if (!chatId) return res.status(400).json({ error: 'chat_id required' });
        manageStore.clearYoutubeConfig(chatId);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/**
 * POST /api/manage/channels/youtube/test-buffer — тест соединения
 */
router.post('/channels/youtube/test-buffer', async (req, res) => {
    try {
        const { buffer_api_key, buffer_channel_id } = req.body;
        if (!buffer_api_key || !buffer_channel_id) {
            return res.status(400).json({ ok: false, error: 'buffer_api_key и buffer_channel_id обязательны' });
        }
        const bufferService = require('../services/buffer.service');
        const result = await bufferService.testConnection(buffer_api_key, buffer_channel_id);
        if (result.service !== 'youtube') {
            return res.status(400).json({ ok: false, error: `Канал является ${result.service}, а не YouTube` });
        }
        res.json(result);
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

/**
 * GET /api/manage/channels/youtube/jobs — список заданий
 */
router.get('/channels/youtube/jobs', async (req, res) => {
    try {
        const { chat_id: chatId, limit = 20, offset = 0, status } = req.query;
        if (!chatId) return res.status(400).json({ error: 'chat_id required' });
        const youtubeRepo = require('../services/content/youtube.repository');
        const jobs = await youtubeRepo.listJobs(chatId, { limit, offset, status });
        res.json(jobs);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/**
 * POST /api/manage/channels/youtube/run-now — немедленная генерация
 */
router.post('/channels/youtube/run-now', async (req, res) => {
    try {
        const { chat_id: chatId } = req.body;
        if (!chatId) return res.status(400).json({ error: 'chat_id required' });
        const youtubeMvp = require('../services/youtubeMvp.service');
        const result = await youtubeMvp.runNow(chatId, null, 'manual');
        res.json(result);
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

/**
 * POST /api/manage/channels/buffer/channels — получить список каналов из Buffer API
 */
router.post('/channels/buffer/channels', async (req, res) => {
    try {
        const { buffer_api_key } = req.body;
        if (!buffer_api_key) {
            return res.status(400).json({ error: 'buffer_api_key обязателен' });
        }

        const bufferService = require('../services/buffer.service');
        const channels = await bufferService.getChannels(buffer_api_key);

        // Опциональная фильтрация по сервису
        const serviceFilter = req.query.service;
        const filtered = serviceFilter
            ? channels.filter(ch => ch.service === serviceFilter)
            : channels;

        res.json({ success: true, channels: filtered });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

module.exports = router;
