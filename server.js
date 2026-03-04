require('dotenv').config();
const express = require('express');
const config = require('./config');
const routes = require('./routes');
const sessionService = require('./services/session.service');
const storageService = require('./services/storage.service');
const snapshotService = require('./services/snapshot.service');

const app = express();

// Middleware
app.use(express.json({ limit: '100mb' }));
app.use(express.static('public'));

// Sandbox Routes (без префикса /api)
const sandboxRoutes = require('./routes/sandbox.routes');
app.use('/sandbox', sandboxRoutes);

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
    
    // Сначала загружаем состояние
    await manageStore.load();
    
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
        const manageStore = require('./manage/store');
        let emailProcessor;
        try {
            emailProcessor = require('./manage/email/processor');
        } catch (e) {
            // ignore
        }
        for (const chatId of Array.from(telegramRunner.bots.keys())) {
            telegramRunner.stopBot(chatId);
        }
        if (emailProcessor) {
            emailProcessor.stopEmailCron();
        }
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
