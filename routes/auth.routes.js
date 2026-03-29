/**
 * Авторизация через Telegram ID
 * 
 * Схема работы:
 * 1. Пользователь вводит свой Telegram ID в веб-интерфейсе
 * 2. Если есть сессия с этим chat_id - он входит
 * 3. Если сессии нет - предлагается создать её через страницу "Каналы"
 */

const router = require('express').Router();
const crypto = require('crypto');
const manageStore = require('../manage/store');
const sessionService = require('../services/session.service');
const config = require('../config');

const TELEGRAM_WEB_LOGIN_TTL_MS = 10 * 60 * 1000;
const telegramWebLoginTokens = new Map();

function cleanupExpiredTelegramWebLoginTokens() {
    const now = Date.now();
    for (const [token, entry] of telegramWebLoginTokens.entries()) {
        if (!entry || entry.expiresAt <= now) {
            telegramWebLoginTokens.delete(token);
        }
    }
}

function issueTelegramWebLoginToken(chatId, telegramId, username) {
    cleanupExpiredTelegramWebLoginTokens();
    const token = crypto.randomBytes(32).toString('hex');
    telegramWebLoginTokens.set(token, {
        chatId: String(chatId),
        telegramId: String(telegramId),
        username: username || null,
        expiresAt: Date.now() + TELEGRAM_WEB_LOGIN_TTL_MS
    });
    return token;
}

function consumeTelegramWebLoginToken(token) {
    cleanupExpiredTelegramWebLoginTokens();
    const entry = telegramWebLoginTokens.get(token);
    if (!entry) return null;
    telegramWebLoginTokens.delete(token);
    return entry;
}

/**
 * Проверка авторизации по Telegram ID
 * GET /api/auth/check?telegram_id=123456789
 */
router.get('/check', async (req, res) => {
    const telegramId = String(req.query.telegram_id || '').trim();

    if (!telegramId) {
        return res.status(400).json({ error: 'telegram_id is required' });
    }

    // Сначала проверяем, есть ли сессия с chatId = telegramId
    const directState = manageStore.getState(telegramId);

    if (directState) {
        // Сессия существует
        const session = sessionService.getSession(telegramId);

        return res.json({
            authorized: true,
            chatId: telegramId,
            username: directState.verifiedUsername || null,
            verified: !!directState.verifiedTelegramId,
            hasBot: !!directState.token,
            sessionActive: !!session,
            containerId: session?.containerId || null
        });
    }

    // Если нет прямой сессии - ищем по verifiedTelegramId
    const allStates = manageStore.getAllStates();
    let foundSession = null;

    for (const [chatId, state] of Object.entries(allStates)) {
        if (state.verifiedTelegramId === telegramId) {
            foundSession = { chatId, state };
            break;
        }
    }

    if (foundSession) {
        const session = sessionService.getSession(foundSession.chatId);

        return res.json({
            authorized: true,
            chatId: foundSession.chatId,
            username: foundSession.state.verifiedUsername || null,
            verified: true,
            hasBot: !!foundSession.state.token,
            sessionActive: !!session,
            containerId: session?.containerId || null
        });
    }

    // Если сессия не найдена - проверяем, есть ли активная сессия в памяти
    const session = sessionService.getSession(telegramId);
    if (session) {
        // Сессия есть в памяти (например, создана админом)
        return res.json({
            authorized: true,
            chatId: telegramId,
            username: null,
            verified: false,
            hasBot: false,
            sessionActive: true,
            containerId: session.containerId || null
        });
    }

    // Сессия не найдена
    res.json({
        authorized: false,
        message: 'Telegram ID не найден. Сначала подключите бота в разделе "Каналы".',
        needCreate: true
    });
});

/**
 * Вход по Telegram ID
 * POST /api/auth/login
 * Body: { telegram_id: "123456789" }
 */
router.post('/login', async (req, res) => {
    const telegramId = String(req.body.telegram_id || '').trim();
    
    if (!telegramId) {
        return res.status(400).json({ error: 'telegram_id is required' });
    }
    
    // Проверяем прямую сессию
    const directState = manageStore.getState(telegramId);
    
    if (directState) {
        // Сессия существует - входим
        try {
            await sessionService.getOrCreateSession(telegramId);
            
            return res.json({ 
                success: true, 
                chatId: telegramId,
                verified: !!directState.verifiedTelegramId,
                message: 'Авторизация успешна'
            });
        } catch (e) {
            return res.status(500).json({ error: e.message });
        }
    }
    
    // Ищем по verifiedTelegramId
    const allStates = manageStore.getAllStates();
    let foundChatId = null;
    
    for (const [chatId, state] of Object.entries(allStates)) {
        if (state.verifiedTelegramId === telegramId) {
            foundChatId = chatId;
            break;
        }
    }
    
    if (foundChatId) {
        try {
            await sessionService.getOrCreateSession(foundChatId);
            
            return res.json({ 
                success: true, 
                chatId: foundChatId,
                verified: true,
                message: 'Авторизация успешна'
            });
        } catch (e) {
            return res.status(500).json({ error: e.message });
        }
    }
    
    // Сессия не найдена - предлагаем создать
    res.status(401).json({ 
        error: 'Telegram ID не найден. Перейдите в раздел "Каналы" для создания сессии.',
        needCreate: true
    });
});

/**
 * Получение информации о текущем пользователе
 * GET /api/auth/me?chat_id=xxx
 */
router.get('/me', (req, res) => {
    const chatId = req.query.chat_id;
    
    if (!chatId) {
        return res.status(400).json({ error: 'chat_id is required' });
    }
    
    const state = manageStore.getState(chatId);
    
    if (!state) {
        return res.json({ authorized: false });
    }
    
    res.json({
        authorized: true,
        telegramId: state.verifiedTelegramId || chatId,
        username: state.verifiedUsername || null,
        hasBot: !!state.token,
        hasAI: !!(state.aiBotId && state.aiBotToken)
    });
});

/**
 * Создание сессии для Telegram ID
 * POST /api/auth/create-session
 * Body: { telegram_id: "123456789" }
 */
router.post('/create-session', async (req, res) => {
    const telegramId = String(req.body.telegram_id || '').trim();
    
    if (!telegramId) {
        return res.status(400).json({ error: 'telegram_id is required' });
    }
    
    try {
        // Создаём сессию с chatId = telegramId
        await sessionService.getOrCreateSession(telegramId);
        
        res.json({ 
            success: true, 
            chatId: telegramId,
            message: 'Сессия создана'
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/**
 * Обмен одноразового токена из Telegram-бота на веб-сессию
 * GET /api/auth/telegram-web-login?token=...
 */
router.get('/telegram-web-login', async (req, res) => {
    const token = String(req.query.token || '').trim();

    if (!token) {
        return res.status(400).json({ error: 'token is required' });
    }

    const loginData = consumeTelegramWebLoginToken(token);
    if (!loginData) {
        return res.status(401).json({ error: 'Invalid or expired login token' });
    }

    try {
        await sessionService.getOrCreateSession(loginData.chatId);

        return res.json({
            success: true,
            authorized: true,
            chatId: loginData.chatId,
            telegramId: loginData.telegramId,
            username: loginData.username
        });
    } catch (e) {
        console.error('[AUTH-TELEGRAM-WEB-LOGIN] Error:', e.message);
        return res.status(500).json({ error: e.message });
    }
});

/**
 * Авторизация через Telegram ID из Telegram-бота
 * POST /api/auth/telegram-login
 * Body: { telegram_id: "123456789", username: "@username", first_name: "FirstName", last_name: "SurName" }
 *
 * Вызывается при нажатии кнопки "Войти в аккаунт" в боте @clientzavod_bot
 */
router.post('/telegram-login', async (req, res) => {
    const telegramId = String(req.body.telegram_id || '').trim();
    const username = req.body.username || null;
    const firstName = req.body.first_name || null;
    const lastName = req.body.last_name || null;

    if (!telegramId) {
        return res.status(400).json({ error: 'telegram_id is required' });
    }

    console.log(`[AUTH-TELEGRAM-LOGIN] telegram_id=${telegramId}, username=${username}, first_name=${firstName}, last_name=${lastName}`);

    // Сначала ищем прямую сессию (chatId = telegramId)
    const directState = manageStore.getState(telegramId);

    if (directState) {
        // Сессия существует — входим
        try {
            const session = await sessionService.getOrCreateSession(telegramId);

            // Если это первый вход и есть username — сохраняем
            // Или обновляем username если пользователь сменил его в Telegram
            if (username) {
                // Сохраняем username, firstName, lastName
                const state = manageStore.getState(telegramId) || {};
                if (!state.verifiedTelegramId) {
                    // Автоматически верифицируем при входе через бота
                    state.verifiedTelegramId = telegramId;
                    state.verifiedUsername = username;
                    if (firstName) state.verifiedFirstName = firstName;
                    if (lastName) state.verifiedLastName = lastName;
                    await manageStore.persist(telegramId);
                } else if (state.verifiedUsername !== username) {
                    // Username изменился — обновляем
                    state.verifiedUsername = username;
                    if (firstName) state.verifiedFirstName = firstName;
                    if (lastName) state.verifiedLastName = lastName;
                    await manageStore.persist(telegramId);
                    console.log(`[AUTH] Updated username for ${telegramId}: ${state.verifiedUsername}`);
                }
            }
            
            const appUrl = config.APP_URL;
            const webLoginToken = issueTelegramWebLoginToken(telegramId, telegramId, directState.verifiedUsername || username);

            return res.json({
                success: true,
                chatId: telegramId,
                username: directState.verifiedUsername || username,
                verified: !!directState.verifiedTelegramId,
                hasBot: !!directState.token,
                hasAI: !!(directState.aiAuthToken && directState.aiModel),
                sessionActive: !!session,
                redirectUrl: `${appUrl}/auth.html?tg_login_token=${webLoginToken}`,
                message: 'Авторизация успешна'
            });
        } catch (e) {
            console.error('[AUTH-TELEGRAM-LOGIN] Error:', e.message);
            return res.status(500).json({ error: e.message });
        }
    }
    
    // Ищем по verifiedTelegramId (пользователь привязал бота к другому chatId)
    const allStates = manageStore.getAllStates();
    let foundChatId = null;
    let foundState = null;
    
    for (const [chatId, state] of Object.entries(allStates)) {
        if (state.verifiedTelegramId === telegramId) {
            foundChatId = chatId;
            foundState = state;
            break;
        }
    }
    
    if (foundChatId && foundState) {
        try {
            const session = await sessionService.getOrCreateSession(foundChatId);
            
            const appUrl = config.APP_URL;
            const webLoginToken = issueTelegramWebLoginToken(foundChatId, telegramId, foundState.verifiedUsername || username);

            return res.json({
                success: true,
                chatId: foundChatId,
                username: foundState.verifiedUsername || username,
                verified: true,
                hasBot: !!foundState.token,
                hasAI: !!(foundState.aiAuthToken && foundState.aiModel),
                sessionActive: !!session,
                redirectUrl: `${appUrl}/auth.html?tg_login_token=${webLoginToken}`,
                message: 'Авторизация успешна'
            });
        } catch (e) {
            console.error('[AUTH-TELEGRAM-LOGIN] Error:', e.message);
            return res.status(500).json({ error: e.message });
        }
    }
    
    // Сессия не найдена — создаём новую
    try {
        const session = await sessionService.getOrCreateSession(telegramId);
        
        // Автоматически верифицируем нового пользователя
        const state = manageStore.getState(telegramId) || {};
        state.verifiedTelegramId = telegramId;
        state.verifiedUsername = username;
        await manageStore.persist(telegramId);
        
        const appUrl = config.APP_URL;
        const webLoginToken = issueTelegramWebLoginToken(telegramId, telegramId, username);

        res.json({
            success: true,
            chatId: telegramId,
            username: username,
            verified: true,
            hasBot: false,
            hasAI: false,
            sessionActive: !!session,
            isNewUser: true,
            redirectUrl: `${appUrl}/auth.html?tg_login_token=${webLoginToken}`,
            message: 'Аккаунт создан и авторизован'
        });
    } catch (e) {
        console.error('[AUTH-TELEGRAM-LOGIN] Error creating session:', e.message);
        res.status(500).json({ error: e.message });
    }
});

/**
 * Вход по Telegram ID (вводится вручную на сайте)
 * POST /api/auth/by-telegram-id
 * Body: { telegram_id: "123456789" }
 * 
 * Альтернативный способ входа — пользователь вводит свой Telegram ID
 */
router.post('/by-telegram-id', async (req, res) => {
    const telegramId = String(req.body.telegram_id || '').trim();
    
    if (!telegramId) {
        return res.status(400).json({ error: 'telegram_id is required' });
    }
    
    // Валидация Telegram ID (должен быть числом)
    if (!/^\d+$/.test(telegramId)) {
        return res.status(400).json({ error: 'telegram_id должен содержать только цифры' });
    }
    
    console.log(`[AUTH-BY-TELEGRAM-ID] telegram_id=${telegramId}`);
    
    // Ищем сессию по chatId или verifiedTelegramId
    const directState = manageStore.getState(telegramId);
    
    if (directState) {
        // Прямая сессия
        try {
            await sessionService.getOrCreateSession(telegramId);
            
            const appUrl = config.APP_URL;
            const webLoginToken = issueTelegramWebLoginToken(
                telegramId,
                directState.verifiedTelegramId || telegramId,
                directState.verifiedUsername || null
            );

            return res.json({
                success: true,
                chatId: telegramId,
                username: directState.verifiedUsername || null,
                verified: !!directState.verifiedTelegramId,
                hasBot: !!directState.token,
                hasAI: !!(directState.aiAuthToken && directState.aiModel),
                redirectUrl: `${appUrl}/auth.html?tg_login_token=${webLoginToken}`,
                message: 'Вход выполнен'
            });
        } catch (e) {
            return res.status(500).json({ error: e.message });
        }
    }
    
    // Ищем по verifiedTelegramId
    const allStates = manageStore.getAllStates();
    let foundChatId = null;
    let foundState = null;
    
    for (const [chatId, state] of Object.entries(allStates)) {
        if (state.verifiedTelegramId === telegramId) {
            foundChatId = chatId;
            foundState = state;
            break;
        }
    }
    
    if (foundChatId && foundState) {
        try {
            await sessionService.getOrCreateSession(foundChatId);
            
            const appUrl = config.APP_URL;
            const webLoginToken = issueTelegramWebLoginToken(
                foundChatId,
                telegramId,
                foundState.verifiedUsername || null
            );

            return res.json({
                success: true,
                chatId: foundChatId,
                username: foundState.verifiedUsername || null,
                verified: true,
                hasBot: !!foundState.token,
                hasAI: !!(foundState.aiAuthToken && foundState.aiModel),
                redirectUrl: `${appUrl}/auth.html?tg_login_token=${webLoginToken}`,
                message: 'Вход выполнен'
            });
        } catch (e) {
            return res.status(500).json({ error: e.message });
        }
    }
    
    // Сессия не найдена — предлагаем перейти в бота
    res.status(404).json({
        success: false,
        error: 'Пользователь с таким Telegram ID не найден.',
        needRegister: true,
        botLink: 'https://t.me/DigiStaff_Team_bot',
        message: 'Перейдите в бота и нажмите "Войти в аккаунт" для создания аккаунта.'
    });
});

/**
 * Получение информации о пользователе по Telegram ID
 * GET /api/auth/telegram-info?telegram_id=123456789
 */
router.get('/telegram-info', (req, res) => {
    const telegramId = String(req.query.telegram_id || '').trim();
    
    if (!telegramId) {
        return res.status(400).json({ error: 'telegram_id is required' });
    }
    
    // Ищем по chatId
    let state = manageStore.getState(telegramId);
    let chatId = telegramId;
    
    // Если не нашли — ищем по verifiedTelegramId
    if (!state) {
        const allStates = manageStore.getAllStates();
        for (const [cid, s] of Object.entries(allStates)) {
            if (s.verifiedTelegramId === telegramId) {
                state = s;
                chatId = cid;
                break;
            }
        }
    }
    
    if (!state) {
        return res.json({
            found: false,
            message: 'Пользователь не найден'
        });
    }
    
    const session = sessionService.getSession(chatId);
    
    res.json({
        found: true,
        chatId,
        telegramId: state.verifiedTelegramId || chatId,
        username: state.verifiedUsername || null,
        verified: !!state.verifiedTelegramId,
        hasBot: !!state.token,
        hasAI: !!(state.aiAuthToken && state.aiModel),
        sessionActive: !!session,
        containerId: session?.containerId || null
    });
});

module.exports = router;
