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
const FileStore = require('session-file-store')(session);

const app = express();

if (process.env.NODE_ENV === 'production') {
    app.set('trust proxy', 1);
}

// Middleware для обработки admin_auth токена (должен быть ДО express.static!)
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
                    req.session.adminChatId = chatId; // Сохраняем original chatId для админа
                }

                // Очищаем токен после использования
                state.adminAuthToken = null;
                state.adminAuthExpires = null;

                // Обновляем cache
                const allStates = manageStore.getAllStates();
                allStates[chatId] = state;
                await manageStore.persist(chatId);

                // Редирект на страницу авторизации с chatId и admin_auth для автовхода
                return res.redirect('/auth.html?chat_id=' + encodeURIComponent(chatId) + '&admin_auth=' + encodeURIComponent(admin_auth));
            }
        } catch (e) {
            console.error('[ADMIN_AUTH] Error:', e.message);
        }
    }
    next();
});

// Middleware
app.use(express.json({ limit: '100mb' }));
app.use(express.static('public'));
app.use(session({
    store: new FileStore({
        path: '/var/sandbox-data/.admin-sessions',
        ttl: 86400, // 24 часа в секундах
        retries: 0,
        logFn: () => {} // отключить лишние логи
    }),
    secret: process.env.SESSION_SECRET || 'docker-claw-admin-secret-key-change-in-production',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }
}));

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

    // Инициализация MySQL для навыков (проверка и сидирование)
    try {
        const mysqlService = require('./services/mysql.service');
        const isConnected = await mysqlService.checkConnection();
        if (isConnected) {
            console.log('[MYSQL] ✅ Connected and initialized');
        } else {
            console.warn('[MYSQL] ⚠️  Connection check failed, will retry on first use');
        }
    } catch (e) {
        console.warn('[MYSQL] ⚠️  Initialization skipped:', e.message);
    }
    
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

    // Запуск центрального бота премодерации контента (единый для всех пользователей)
    const cwBotToken = process.env.CW_BOT_TOKEN;
    let cwBot = null;
    let cwBotUsername = null;

    if (cwBotToken) {
        // Создаём отдельного бота для премодерации
        const { Telegraf } = require('telegraf');
        cwBot = new Telegraf(cwBotToken);

        // Получаем username бота для deep link'а
        cwBot.telegram.getMe().then(info => {
            cwBotUsername = info.username;
            console.log(`[CW-BOT] Username: @${cwBotUsername}`);
        }).catch(err => {
            console.error(`[CW-BOT] Failed to get bot info:`, err.message);
        });

        // Обработчик текстовых сообщений для верификации через код
        cwBot.on('text', async (ctx) => {
            const fromId = String(ctx.from?.id || '');
            const username = ctx.from?.username ? `@${ctx.from.username}` : null;
            const data = manageStore.getState(fromId);
            if (!data) {
                await ctx.reply('Вы не найдены в системе. Авторизуйтесь на сайте.').catch(() => {});
                return;
            }
            if (data.verifiedTelegramId) {
                await ctx.reply('Аккаунт уже подтверждён.').catch(() => {});
                return;
            }
            const code = String(Math.floor(100000 + Math.random() * 900000));
            manageStore.setPending(fromId, code, fromId, username);
            await ctx.reply(`Код подтверждения: <b>${code}</b>\n\nВведите этот код на странице настройки. Код действителен 10 минут.`, { parse_mode: 'HTML' }).catch(() => {});
        });

        // Регистрируем обработчик callback query для модерации контента
        cwBot.action(/^content:(\d+):(approve|regen_text|regen_image|regen_video|reject)$/, async (ctx) => {
            const fromId = String(ctx.from?.id || '');
            const tgChatId = String(ctx.chat?.id || '');
            
            const [, jobIdRaw, action] = ctx.match || [];
            const jobId = Number(jobIdRaw);
            if (!Number.isFinite(jobId)) {
                await ctx.answerCbQuery('Некорректный ID').catch(() => {});
                return;
            }
            
            // Находим правильный chatId: ищем сессию где есть черновик с этим jobId
            // Модератор может иметь доступ к черновикам разных пользователей
            let resolvedChatId = null;
            const allStates = manageStore.getAllStates();
            for (const [cid, data] of Object.entries(allStates)) {
                // Проверяем есть ли черновик с этим jobId
                const drafts = data.contentDrafts || {};
                if (!drafts[String(jobId)]) {
                    continue;
                }
                // Проверяем доступ: владелец или модератор
                const ownerTgId = String(data.verifiedTelegramId || '');
                const contentSettings = data.contentSettings || {};
                const moderatorId = String(contentSettings.moderatorUserId || process.env.CONTENT_MVP_MODERATOR_USER_ID || '');
                const allowedIds = new Set([ownerTgId, moderatorId].filter(Boolean));
                if (allowedIds.has(fromId)) {
                    resolvedChatId = cid;
                    break;
                }
            }

            if (!resolvedChatId) {
                resolvedChatId = manageStore.getByVerifiedTelegramId(fromId);
            }
            
            if (!resolvedChatId) {
                await ctx.answerCbQuery('Черновик не найден').catch(() => {});
                await ctx.reply('❌ Черновик не найден. Возможно, он уже был обработан.').catch(() => {});
                return;
            }
            
            console.log(`[CW-BOT] ${action} job ${jobId} for chatId=${resolvedChatId} (fromId=${fromId})`);
            try {
                const result = await contentMvpService.handleModerationAction(resolvedChatId, { telegram: ctx.telegram }, action, jobId);
                await ctx.answerCbQuery(result?.ok ? 'Готово' : 'Ошибка').catch(() => {});
                if (result?.ok) {
                    await ctx.reply(result.message || 'Операция выполнена.').catch(() => {});
                } else {
                    await ctx.reply(`❌ ${result?.message || 'Ошибка модерации'}`).catch(() => {});
                }
            } catch (e) {
                console.error(`[CW-BOT] Error:`, e);
                await ctx.answerCbQuery('Ошибка').catch(() => {});
                await ctx.reply(`Ошибка модерации: ${e.message}`).catch(() => {});
            }
        });

        // VK moderation callbacks for CW_BOT_TOKEN users
        cwBot.action(/^vk_mod:(\d+):(approve|reject|regen_text|regen_image)$/, async (ctx) => {
            const fromId = String(ctx.from?.id || '');
            const jobId = Number(ctx.match?.[1]);
            const action = ctx.match?.[2];

            console.log(`[CW-BOT-VK] ${action} job ${jobId} (fromId=${fromId})`);

            // Находим chatId по черновику
            let resolvedChatId = null;
            const allStates = manageStore.getAllStates();
            console.log(`[CW-BOT-VK] Searching in ${Object.keys(allStates).length} states for jobId=${jobId}`);
            for (const [cid, data] of Object.entries(allStates)) {
                const drafts = data.vkDrafts || {};
                console.log(`[CW-BOT-VK] cid=${cid}, vkDrafts keys=${Object.keys(drafts)}`);
                if (!drafts[String(jobId)]) continue;

                const vkSettings = manageStore.getVkSettings?.(cid) || {};
                const globalSettings = data.contentSettings || {};
                const channelModeratorId = vkSettings.moderatorUserId ||
                                           globalSettings.moderatorUserId ||
                                           process.env.CONTENT_MVP_MODERATOR_USER_ID;
                const ownerTgId = String(data.verifiedTelegramId || '');
                const allowedIds = new Set([ownerTgId, channelModeratorId].filter(Boolean));

                console.log(`[CW-BOT-VK] cid=${cid} has draft, checking access: fromId=${fromId}, ownerTgId=${ownerTgId}, channelModeratorId=${channelModeratorId}`);
                if (allowedIds.has(fromId)) {
                    resolvedChatId = cid;
                    console.log(`[CW-BOT-VK] Access granted for cid=${cid}`);
                    break;
                }
            }

            if (!resolvedChatId) {
                console.log(`[CW-BOT-VK] Draft not found or access denied for jobId=${jobId}, fromId=${fromId}`);
                await ctx.answerCbQuery('Черновик не найден').catch(() => {});
                return;
            }
            
            try {
                const result = await vkMvpService.handleVkModerationAction(resolvedChatId, { telegram: ctx.telegram }, jobId, action);
                await ctx.answerCbQuery(result?.ok ? 'Готово' : 'Ошибка').catch(() => {});
                await ctx.reply(result?.message || 'Операция выполнена.').catch(() => {});
            } catch (e) {
                console.error(`[CW-BOT-VK] Error:`, e);
                await ctx.answerCbQuery('Ошибка').catch(() => {});
                await ctx.reply(`Ошибка модерации VK: ${e.message}`).catch(() => {});
            }
        });

        // OK moderation callbacks for CW_BOT_TOKEN users
        cwBot.action(/^ok_mod:(\d+):(approve|reject|regen_text|regen_image)$/, async (ctx) => {
            const fromId = String(ctx.from?.id || '');
            const jobId = Number(ctx.match?.[1]);
            const action = ctx.match?.[2];

            console.log(`[CW-BOT-OK] ${action} job ${jobId} (fromId=${fromId})`);

            // Находим chatId по черновику
            let resolvedChatId = null;
            const allStatesOk = manageStore.getAllStates();
            for (const [cid, data] of Object.entries(allStatesOk)) {
                const drafts = data.okDrafts || {};
                if (!drafts[String(jobId)]) continue;

                const okSettings = manageStore.getOkSettings?.(cid) || {};
                const globalSettings = data.contentSettings || {};
                const channelModeratorId = okSettings.moderatorUserId ||
                                           globalSettings.moderatorUserId ||
                                           process.env.CONTENT_MVP_MODERATOR_USER_ID;
                const ownerTgId = String(data.verifiedTelegramId || '');
                const allowedIds = new Set([ownerTgId, channelModeratorId].filter(Boolean));

                if (allowedIds.has(fromId)) {
                    resolvedChatId = cid;
                    break;
                }
            }

            if (!resolvedChatId) {
                await ctx.answerCbQuery('Черновик не найден').catch(() => {});
                return;
            }

            try {
                const result = await okMvpService.handleOkModerationAction(resolvedChatId, { telegram: ctx.telegram }, jobId, action);
                await ctx.answerCbQuery(result?.ok ? 'Готово' : 'Ошибка').catch(() => {});
                await ctx.reply(result?.message || 'Операция выполнена.').catch(() => {});
            } catch (e) {
                console.error(`[CW-BOT-OK] Error:`, e);
                await ctx.answerCbQuery('Ошибка').catch(() => {});
                await ctx.reply(`Ошибка модерации ОК: ${e.message}`).catch(() => {});
            }
        });

        // Instagram moderation callbacks for CW_BOT_TOKEN users
        cwBot.action(/^ig_mod:(\d+):(approve|reject|regen_text|regen_image)$/, async (ctx) => {
            const fromId = String(ctx.from?.id || '');
            const jobId = Number(ctx.match?.[1]);
            const action = ctx.match?.[2];
            console.log(`[CW-BOT-IG] ${action} job ${jobId} (fromId=${fromId})`);
            await ctx.answerCbQuery('В разработке').catch(() => {});
        });

        // Pinterest moderation callbacks for CW_BOT_TOKEN users
        cwBot.action(/^pin_mod:(\d+):(approve|reject|regen_text|regen_image)$/, async (ctx) => {
            const fromId = String(ctx.from?.id || '');
            const jobId = Number(ctx.match?.[1]);
            const action = ctx.match?.[2];
            console.log(`[CW-BOT-PIN] ${action} job ${jobId} (fromId=${fromId})`);
            await ctx.answerCbQuery('В разработке').catch(() => {});
        });

        // API endpoint для получения username CW бота
        app.get('/api/manage/cw-bot-info', (req, res) => {
            res.json({ username: cwBotUsername || null });
        });

        // Запускаем с webhook если CW_BOT_WEBHOOK_URL установлен
        // Используем отдельную переменную чтобы избежать конфликтов с webhook.routes.js
        if (process.env.CW_BOT_WEBHOOK_URL) {
            const webhookUrl = process.env.CW_BOT_WEBHOOK_URL;
            cwBot.telegram.setWebhook(webhookUrl).then(() => {
                console.log(`🤖 Content bot: ✅ WEBHOOK SET (${webhookUrl})`);
            }).catch((err) => {
                console.error('🤖 Content bot: ⚠️  WEBHOOK ERROR:', err.message);
            });
            // Извлекаем путь из URL для регистрации роута
            const urlParts = new URL(webhookUrl);
            const webhookPath = urlParts.pathname;
            app.use(webhookPath, async (req, res) => {
                await cwBot.handleUpdate(req.body);
                res.status(200).send('OK');
            });
        } else if (process.env.WEBHOOK_URL) {
            // Fallback: используем WEBHOOK_URL с суффиксом /cw
            const webhookUrl = `${process.env.WEBHOOK_URL}/cw`;
            cwBot.telegram.setWebhook(webhookUrl).then(() => {
                console.log(`🤖 Content bot: ✅ WEBHOOK SET (${webhookUrl})`);
            }).catch((err) => {
                console.error('🤖 Content bot: ⚠️  WEBHOOK ERROR:', err.message);
            });
            const urlParts = new URL(webhookUrl);
            const webhookPath = urlParts.pathname;  // e.g. '/telegram/webhook/cw'
            app.use(webhookPath, async (req, res) => {
                await cwBot.handleUpdate(req.body);
                res.status(200).send('OK');
            });
        } else {
            cwBot.launch().catch((err) => {
                console.error('[CW-BOT] Launch error:', err.message);
            });
        }

        console.log('🤖 Content bot: ✅ STARTED (CW_BOT_TOKEN)');
    } else {
        console.log('🤖 Content bot: ⏸️  SKIPPED (CW_BOT_TOKEN not set)');
    }
    
    // Делаем cwBot доступным для всех сервисов
    contentMvpService.setContentBot(cwBot);

    // Передаём cwBot в другие сервисы (Pinterest, VK, OK, Instagram)
    const pinterestMvpService = require('./services/pinterestMvp.service');
    const vkMvpService = require('./services/vkMvp.service');
    const okMvpService = require('./services/okMvp.service');
    const instagramMvpService = require('./services/instagramMvp.service');

    pinterestMvpService.setPinterestCwBot(cwBot);
    vkMvpService.setVkCwBot(cwBot);
    okMvpService.setOkCwBot(cwBot);
    instagramMvpService.setIgCwBot(cwBot);

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

    // Запуск Telegram-ботов (передаём cwBot, чтобы зарегистрировать пользователей с CW_BOT_TOKEN в bots Map)
    await telegramRunner.startAllBots(cwBot);
    contentMvpService.startScheduler(() => telegramRunner.bots);

    // Запуск Pinterest-планировщика
    pinterestMvpService.startScheduler(() => telegramRunner.bots);

    // Запуск VK-планировщика
    vkMvpService.startScheduler(() => telegramRunner.bots);

    // Запуск OK-планировщика
    okMvpService.startScheduler(() => telegramRunner.bots);

    // Запуск Instagram-планировщика
    instagramMvpService.startScheduler(() => telegramRunner.bots);

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
    
    // Бэкап перед выключением (только не при перезапуске nodemon)
    if (process.env.NODE_ENV !== 'development') {
        const chatIds = sessions.map(s => s.chatId);
        await storageService.backupAllUsers(chatIds);
    }
    
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
