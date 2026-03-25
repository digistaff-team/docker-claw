// Загрузка переменных окружения: сначала .env, затем .env.local (переопределяет)
require('dotenv').config();
require('dotenv').config({ path: '.env.local', override: true });
const express = require('express');
const config = require('./config');
const routes = require('./routes');
const sessionService = require('./services/session.service');
const storageService = require('./services/storage.service');
const snapshotService = require('./services/snapshot.service');
const contentMvpService = require('./services/contentMvp.service');
const session = require('express-session');

const app = express();

// Middleware
app.use(express.json({ limit: '100mb' }));
app.use(express.static('public'));
app.use(session({
    secret: process.env.SESSION_SECRET || 'docker-claw-admin-secret-key-change-in-production',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: false, // Set to true if using HTTPS
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }
}));

// Middleware для обработки admin_auth токена
app.use(async (req, res, next) => {
    const { admin_auth, chatId } = req.query;
    
    if (admin_auth && chatId) {
        try {
            const manageStore = require('./manage/store');
            await manageStore.load();
            
            const state = manageStore.getState(chatId);
            if (state && state.adminAuthToken === admin_auth && state.adminAuthExpires > Date.now()) {
                // Токен валиден - устанавливаем сессию
                const session = await sessionService.getOrCreateSession(chatId);
                
                // Устанавливаем chatId в сессию для последующего использования
                if (req.session) {
                    req.session.chatId = chatId;
                    req.session.authorizedByAdmin = true;
                }
                
                // Очищаем токен после использования
                state.adminAuthToken = null;
                state.adminAuthExpires = null;
                
                // Обновляем cache
                const allStates = manageStore.getAllStates();
                allStates[chatId] = state;
                await manageStore.persist(chatId);
                
                // Редирект на главную
                return res.redirect('/');
            }
        } catch (e) {
            console.error('[ADMIN_AUTH] Error:', e.message);
        }
    }
    next();
});

// Sandbox Routes (без префикса /api)
const sandboxRoutes = require('./routes/sandbox.routes');
app.use('/sandbox', sandboxRoutes);

// Admin Routes
const adminRoutes = require('./routes/admin.routes');
app.use('/admin', adminRoutes);

// API Routes
app.use('/api', routes);

// ==================== STARTUP ====================

async function startServer() {
    console.log('\n' + '='.repeat(60));
    console.log('🚀 AI BASH EXECUTOR v3 - MODULAR');
    console.log('='.repeat(60));
    
    // Инициализация хранилища
    await storageService.initStorage();
    
    // Инициализация снапшотов
    await snapshotService.initSnapshots();
    
    // Восстановление существующих сессий
    await sessionService.recoverAllSessions();
    
    // Управление: загрузка состояния и запуск Telegram-ботов
    const manageStore = require('./manage/store');
    const telegramRunner = require('./manage/telegram/runner');
    const authBot = require('./manage/telegram/authBot');
    
    // Сначала загружаем состояние
    await manageStore.load();
    
    // Запуск главного бота авторизации @clientzavod_bot
    const authBotToken = process.env.AUTH_BOT_TOKEN;
    if (authBotToken) {
        authBot.startAuthBot(authBotToken);
        console.log('🤖 Auth bot: ✅ STARTED (@clientzavod_bot)');
    } else {
        console.log('🤖 Auth bot: ⏸️  SKIPPED (AUTH_BOT_TOKEN not set)');
    }
    
    // Email processor - запуск cron для опроса почты
    let emailProcessor;
    try {
        emailProcessor = require('./manage/email/processor');
        const cronResult = emailProcessor.startEmailCron();
        
        if (cronResult && cronResult.started) {
            console.log(`📧 Email polling: ✅ ACTIVE (${cronResult.activeConfigs} configs)`);
        } else {
            console.log(`📧 Email polling: ⏸️  INACTIVE (no active configs)`);
        }
    } catch (e) {
        console.warn('📧 Email polling: ❌ UNAVAILABLE');
        console.warn(`   Reason: ${e.message}`);
        console.warn('   Run "npm install" to enable Email channel');
    }
    
    // Запуск Telegram-ботов
    telegramRunner.startAllBots();
    contentMvpService.startScheduler(() => telegramRunner.bots);

    // Запуск Pinterest-планировщика
    const pinterestMvpService = require('./services/pinterestMvp.service');
    pinterestMvpService.startScheduler(() => telegramRunner.bots);

    // Запуск VK-планировщика
    const vkMvpService = require('./services/vkMvp.service');
    vkMvpService.startScheduler(() => telegramRunner.bots);

    // Подключение Webhook API
    const webhookRoutes = require('./routes/webhook.routes');
    app.use('/', webhookRoutes);
    
    // Подключение пользовательских вебхуков
    const userHooksRoutes = require('./routes/user_hooks.routes');
    app.use('/hook', userHooksRoutes);
    
    // Запуск сервера
    app.listen(config.PORT, () => {
        console.log(`\n📡 Server: http://localhost:${config.PORT}`);
        console.log(`📁 Data: ${config.DATA_ROOT}`);
        console.log(`🗄️  PostgreSQL: ${config.PG_HOST}:${config.PG_PORT}`);
        console.log(`🔄 Auto-backup: every ${config.BACKUP_INTERVAL_HOURS}h`);
        console.log('\n' + '='.repeat(60) + '\n');
    });
    
    // Периодическая очистка неактивных сессий
    setInterval(async () => {
        const cleaned = await sessionService.cleanupIdleSessions();
        if (cleaned > 0) {
            console.log(`[CLEANUP] Removed ${cleaned} idle sessions`);
        }
    }, config.CLEANUP_INTERVAL_MS);
    
    // Периодический бэкап
    setInterval(async () => {
        console.log('[BACKUP] Starting scheduled backup...');
        const sessions = sessionService.getAllSessions();
        const chatIds = sessions.map(s => s.chatId);
        await storageService.backupAllUsers(chatIds);
        await storageService.cleanOldBackups();
    }, config.BACKUP_INTERVAL_HOURS * 60 * 60 * 1000);
    
    // Периодическая очистка старых снапшотов (каждые 24 часа)
    setInterval(async () => {
        console.log('[SNAPSHOT] Starting scheduled cleanup...');
        await snapshotService.cleanOldSnapshots();
    }, 24 * 60 * 60 * 1000);
}

// ==================== SHUTDOWN ====================

async function gracefulShutdown() {
    console.log('\n[SHUTDOWN] Graceful shutdown initiated...');
    
    const sessions = sessionService.getAllSessions();
    console.log(`[SHUTDOWN] Saving data for ${sessions.length} users...`);
    
    // Остановка Telegram-ботов
    try {
        const telegramRunner = require('./manage/telegram/runner');
        const authBot = require('./manage/telegram/authBot');
        const manageStore = require('./manage/store');
        const contentMvpService = require('./services/contentMvp.service');
        let emailProcessor;
        try {
            emailProcessor = require('./manage/email/processor');
        } catch (e) {
            // ignore
        }
        
        // Остановка auth-бота
        authBot.stopAuthBot();
        
        // Остановка пользовательских ботов
        for (const chatId of Array.from(telegramRunner.bots.keys())) {
            telegramRunner.stopBot(chatId);
        }
        if (emailProcessor) {
            emailProcessor.stopEmailCron();
        }
        contentMvpService.stopScheduler();
        try { require('./services/pinterestMvp.service').stopScheduler(); } catch (_) {}
        await manageStore.persist();
    } catch (e) {
        // ignore
    }
    
    // Бэкап перед выключением
    const chatIds = sessions.map(s => s.chatId);
    await storageService.backupAllUsers(chatIds);
    
    console.log('[SHUTDOWN] Goodbye!');
    process.exit(0);
}

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

// Запуск
startServer().catch(err => {
    console.error('[FATAL] Startup failed:', err);
    process.exit(1);
});
