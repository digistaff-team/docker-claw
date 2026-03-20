const express = require('express');
const router = express.Router();
const manageStore = require('./store');
const telegramRunner = require('./telegram/runner');
const balanceService = require('../services/balance.service');

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
    
    // Возвращаем полный токен (пользователь авторизован по Chat ID)
    const fullToken = hasToken && data.token ? data.token : null;
    
    res.json({
        hasToken,
        verified,
        username,
        pending,
        token: fullToken // Полный токен для отображения в форме
    });
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
    
    res.json({
        hasAI: !!(data && data.aiAuthToken),
        aiBotId: data && data.aiBotId ? data.aiBotId : null,
        aiBotToken: fullBotToken, // Полный токен для отображения в форме
        aiUserEmail: data && data.aiUserEmail ? data.aiUserEmail : null,
        aiModel: data && data.aiModel ? data.aiModel : null,
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
        // MySQL API для получения навыков
        const MYSQL_API_URL = 'https://ai.memory.api.atiks.org/mysql_full_proxy_api';
        const MYSQL_API_KEY = 'mysql-VTJGc2RHVmtYMS9PQ09iSlgycDZrRWVWVWt5bWR1azQ4bkVqK0JkeXlvSjhpMGg0UW1YSUFlbjRycmM3ZWIzZmkxOVZ1bDNQZ2NITVVtZE9iWGp2R0FiSFRUKzU3YjJEdzMvKzRoR0VaM0htNWtsM2pCOU5rK29VcElGZHRFaXpaa0N5UGVmN2hwdk9aeWdZMkIrcnNCVnRpdWFyaDV1RXVFSFpTK2JJM0hZeHBwZ2dEUGgrQ0pJV3Biem9RdHBGQlhOZ0hkbXhkZDRHSCtXUkpUTnQxYjI5T3VuQklVbUJPdE91Z1VYdm02K2lsL3lHSUpacCtSOWlzQ0xBcktLUQ==';
        
        const response = await fetch(MYSQL_API_URL, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${MYSQL_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                sql: `SELECT s.* FROM ai_skills s 
                      INNER JOIN user_selected_skills us ON s.id = us.skill_id 
                      WHERE us.user_email = %s AND s.is_active = 1`,
                params: [userEmail]
            })
        });
        
        if (!response.ok) {
            throw new Error(`MySQL API error: ${response.status}`);
        }
        
        const result = await response.json();
        if (result.error) {
            throw new Error(result.error);
        }
        
        res.json({ skills: result.data || [] });
    } catch (e) {
        console.error('[AI-SKILLS-ERROR]', e.message);
        res.json({ skills: [], error: e.message });
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
        daily_limit: dailyLimit
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
            dailyLimit
        });
        const settings = manageStore.getContentSettings(chatId) || {};
        res.json({ success: true, settings });
    } catch (e) {
        res.status(400).json({ error: e.message });
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

module.exports = router;
