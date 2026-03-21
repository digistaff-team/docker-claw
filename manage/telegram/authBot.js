/**
 * Главный Telegram-бот для авторизации новых пользователей
 * @DigiStaff_Team_bot
 * 
 * Этот бот работает как "точка входа" - пользователь переходит по ссылке
 * и нажимает кнопку "Войти в аккаунт" для авторизации через Telegram ID.
 */

const { Telegraf, Markup } = require('telegraf');
const manageStore = require('../store');
const config = require('../../config');

let authBot = null;
const LOGIN_LINK_MESSAGE_TTL_MS = 10 * 60 * 1000;

function scheduleMessageDeletion(bot, chatId, messageId, delayMs = LOGIN_LINK_MESSAGE_TTL_MS) {
    if (!bot || !chatId || !messageId) return;
    setTimeout(async () => {
        try {
            await bot.telegram.deleteMessage(chatId, messageId);
        } catch (e) {
            // Сообщение уже удалено вручную или недоступно
        }
    }, delayMs);
}

/**
 * Запускает главный бот авторизации
 * @param {string} token - Telegram Bot Token для @DigiStaff_Team_bot
 */
function startAuthBot(token) {
    if (!token) {
        console.warn('[AUTH-BOT] No token provided, auth bot not started');
        return null;
    }

    if (authBot) {
        try {
            authBot.stop();
        } catch (e) {
            // ignore
        }
    }

    const bot = new Telegraf(token);

    bot.catch((err, ctx) => {
        console.error('[AUTH-BOT]', err.message);
        ctx.reply('Произошла ошибка. Попробуйте позже.').catch(() => {});
    });

    // Команда /start - приветствие и кнопка входа
    bot.command('start', async (ctx) => {
        const fromId = ctx.from?.id;
        const username = ctx.from?.username ? `@${ctx.from.username}` : null;
        const firstName = ctx.from?.first_name || '';
        
        console.log(`[AUTH-BOT] /start from ${fromId} (${username})`);
        
        // Формируем приветственное сообщение
        let message = `👋 <b>Привет${firstName ? ', ' + firstName : ''}!</b>\n\n`;
        message += `Я — бот для авторизации на платформе <b>Контент Завод</b>.\n\n`;
        message += `🔐 Нажмите кнопку ниже, чтобы войти в свой аккаунт или создать новый.\n\n`;
        message += `<i>💡 Если у вас уже есть аккаунт, вы будете автоматически авторизованы.</i>`;

        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('🔑 Войти в аккаунт', 'login_account')]
        ]);

        await ctx.reply(message, {
            parse_mode: 'HTML',
            ...keyboard
        });
    });

    // Команда /login - альтернативный вход
    bot.command('login', async (ctx) => {
        const fromId = ctx.from?.id;
        const username = ctx.from?.username ? `@${ctx.from.username}` : null;
        
        console.log(`[AUTH-BOT] /login from ${fromId} (${username})`);
        
        await ctx.reply('🔐 Нажмите кнопку для входа:', 
            Markup.inlineKeyboard([
                [Markup.button.callback('🔑 Войти в аккаунт', 'login_account')]
            ])
        );
    });

    // Команда /help
    bot.command('help', async (ctx) => {
        let message = `📖 <b>Справка по боту DigiStaff Team</b>\n\n`;
        message += `<b>Доступные команды:</b>\n`;
        message += `/start - Начать работу и войти в аккаунт\n`;
        message += `/login - Войти в аккаунт\n`;
        message += `/help - Показать эту справку\n`;
        message += `/id - Узнать свой Telegram ID\n\n`;
        message += `<b>Как это работает:</b>\n`;
        message += `1. Нажмите кнопку "Войти в аккаунт"\n`;
        message += `2. Система найдёт или создаст ваш аккаунт\n`;
        message += `3. Вы получите ссылку на панель управления\n\n`;
        message += `<b>Что доступно после входа:</b>\n`;
        message += `• 🐍 Python 3 + библиотеки\n`;
        message += `• 📦 Node.js + npm\n`;
        message += `• 🗄️ PostgreSQL база данных\n`;
        message += `• 🤖 AI-ассистент для работы с кодом`;

        await ctx.reply(message, { parse_mode: 'HTML' });
    });

    // Команда /id - показать Telegram ID пользователя
    bot.command('id', async (ctx) => {
        const fromId = ctx.from?.id;
        const username = ctx.from?.username;
        
        let message = `🆔 <b>Ваш Telegram ID:</b> <code>${fromId}</code>\n\n`;
        if (username) {
            message += `👤 <b>Username:</b> ${username}\n\n`;
        }
        message += `<i>Вы можете использовать этот ID для входа на сайте.</i>`;
        
        await ctx.reply(message, { parse_mode: 'HTML' });
    });

    // Обработчик кнопки "Войти в аккаунт"
    bot.action('login_account', async (ctx) => {
        const fromId = String(ctx.from?.id || '');
        const username = ctx.from?.username ? `@${ctx.from.username}` : null;
        const firstName = ctx.from?.first_name || '';
        
        await ctx.answerCbQuery('Авторизация...').catch(() => {});
        
        console.log(`[AUTH-BOT] Login attempt from ${fromId} (${username})`);
        
        try {
            // Вызываем API авторизации
            const apiUrl = process.env.API_URL || 'https://claw.pro-talk.ru';
            console.log(`[AUTH-BOT] Using API URL: ${apiUrl}`);
            
            const response = await fetch(`${apiUrl}/api/auth/telegram-login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    telegram_id: fromId,
                    username: username
                })
            });
            
            console.log(`[AUTH-BOT] Response status: ${response.status}`);
            const result = await response.json();
            console.log(`[AUTH-BOT] Response:`, JSON.stringify(result));
            
            // Удаляем стартовое сообщение с кнопкой после нажатия
            try {
                await ctx.deleteMessage();
            } catch (e) {
                try {
                    await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
                } catch (_) {
                    // ignore
                }
            }
            
            if (result.success) {
                // Формируем приветственное сообщение
                let welcomeMsg;
                const keyboard = Markup.inlineKeyboard([
                    [Markup.button.url('🚀 Открыть панель · 10 мин', result.redirectUrl)]
                ]);
                
                if (result.isNewUser) {
                    // Новый пользователь — аккаунт создан
                    welcomeMsg = `🎉 <b>Добро пожаловать${firstName ? ', ' + firstName : ''}!</b>\n\n`;
                    welcomeMsg += `✅ Ваш аккаунт успешно создан!\n\n`;
                    welcomeMsg += `<b>📝 Ваш Chat ID:</b> <code>${result.chatId}</code>\n\n`;
                    welcomeMsg += `<b>Вам доступно:</b>\n`;
                    welcomeMsg += `• 🐍 Python 3 с основными библиотеками\n`;
                    welcomeMsg += `• 📦 Node.js + npm\n`;
                    welcomeMsg += `• 🗄️ PostgreSQL база данных\n`;
                    welcomeMsg += `• 📁 Персональное рабочее пространство\n\n`;
                    welcomeMsg += `⏱ Вход по кнопке ниже доступен 10 минут.\n\n`;
                    welcomeMsg += `<i>💡 Совет: подключите AI-ассистента в разделе "Каналы связи" для работы с кодом через чат.</i>`;
                } else {
                    // Существующий пользователь
                    welcomeMsg = `✅ <b>С возвращением${firstName ? ', ' + (result.username || firstName) : ''}!</b>\n\n`;
                    welcomeMsg += `Вы успешно вошли в свой аккаунт.\n\n`;
                    welcomeMsg += `<b>📝 Ваш Chat ID:</b> <code>${result.chatId}</code>\n\n`;
                    
                    // Статус сервисов
                    const services = [];
                    if (result.hasAI) services.push('🤖 AI-ассистент');
                    if (result.hasBot) services.push('🤖 Telegram бот');
                    if (result.sessionActive) services.push('🐳 Docker контейнер');
                    
                    if (services.length > 0) {
                        welcomeMsg += `<b>Активные сервисы:</b>\n`;
                        services.forEach(s => welcomeMsg += `• ${s}\n`);
                        welcomeMsg += `\n`;
                    }

                    welcomeMsg += `⏱ Кнопка входа действует 10 минут.\n`;
                }
                
                console.log(`[AUTH-BOT] Sending reply message to ${fromId}...`);
                
                try {
                    const sentMessage = await ctx.reply(welcomeMsg, { 
                        parse_mode: 'HTML',
                        disable_web_page_preview: true,
                        ...keyboard
                    });
                    scheduleMessageDeletion(bot, ctx.chat?.id, sentMessage?.message_id);
                    console.log(`[AUTH-BOT] Reply sent successfully`);
                } catch (replyErr) {
                    console.error(`[AUTH-BOT] Reply error:`, replyErr);
                }
                
                console.log(`[AUTH-BOT] Login success for ${fromId}, chatId=${result.chatId}, isNew=${result.isNewUser || false}`);
            } else {
                // Ошибка авторизации
                const errorMsg = result.error || 'Неизвестная ошибка';
                
                let errMsg = `❌ <b>Ошибка авторизации</b>\n\n${errorMsg}\n\n`;
                
                if (result.needRegister) {
                    errMsg += `<i>Если это ваш первый вход, попробуйте ещё раз или обратитесь в поддержку.</i>`;
                }
                
                console.log(`[AUTH-BOT] Sending error reply to ${fromId}...`);
                try {
                    await ctx.reply(errMsg, { 
                        parse_mode: 'HTML' 
                    });
                    console.log(`[AUTH-BOT] Error reply sent`);
                } catch (replyErr) {
                    console.error(`[AUTH-BOT] Error reply failed:`, replyErr);
                }
                
                console.error(`[AUTH-BOT] Login failed for ${fromId}:`, errorMsg);
            }
        } catch (e) {
            const apiUrl = process.env.API_URL || 'https://claw.pro-talk.ru';
            console.error('[AUTH-BOT] Login error:', e.message);
            console.error('[AUTH-BOT] API URL:', apiUrl);
            console.error('[AUTH-BOT] Full error:', e);
            
            // Более подробное сообщение об ошибке для отладки
            let errorMsg = '❌ Ошибка соединения с сервером. Попробуйте позже.';
            
            if (e.code === 'ECONNREFUSED') {
                errorMsg = '❌ Сервер недоступен. Убедитесь, что сервер запущен.';
            } else if (e.code === 'ENOTFOUND') {
                errorMsg = '❌ Неверный адрес сервера. Проверьте API_URL.';
            } else if (e.message.includes('fetch')) {
                errorMsg = `❌ Ошибка: ${e.message}`;
            }
            
            await ctx.reply(errorMsg).catch(() => {});
        }
    });

    // Обработка текстовых сообщений (если пользователь просто пишет что-то)
    bot.on('text', async (ctx) => {
        const text = ctx.message?.text?.toLowerCase() || '';

        // Если пользователь спрашивает про ID
        if (text.includes('id') || text.includes('айди') || text.includes('какой мой')) {
            const fromId = ctx.from?.id;
            return ctx.reply(`🆔 Ваш Telegram ID: <code>${fromId}</code>\n\nНажмите /start для входа в аккаунт.`, {
                parse_mode: 'HTML'
            });
        }

        // Если пользователь хочет войти
        if (text.includes('войти') || text.includes('вход') || text.includes('логин') || text.includes('login')) {
            return ctx.reply('🔐 Нажмите кнопку для входа:',
                Markup.inlineKeyboard([
                    [Markup.button.callback('🔑 Войти в аккаунт', 'login_account')]
                ])
            );
        }

        // Default response
        await ctx.reply(
            '👋 Привет! Я помогу вам войти в аккаунт DigiStaff Team.\n\n' +
            'Нажмите /start или кнопку ниже:',
            Markup.inlineKeyboard([
                [Markup.button.callback('🔑 Войти в аккаунт', 'login_account')]
            ])
        );
    });

    // Запускаем бота
    // Приоритет: webhook (быстрее) > long polling (медленнее)
    const webhookUrl = process.env.WEBHOOK_URL;
    
    if (webhookUrl && webhookUrl.includes(token)) {
        // Режим webhook - мгновенная доставка сообщений
        console.log('[AUTH-BOT] Starting in WEBHOOK mode for instant response...');
        
        bot.launch({
            dropPendingUpdates: false,
            allowedUpdates: ['message', 'callback_query', 'my_chat_member']
        }).then(() => {
            authBot = bot;
            console.log('[AUTH-BOT] Auth bot @DigiStaff_Team_bot started successfully (webhook mode)');
        }).catch((err) => {
            console.error('[AUTH-BOT] Failed to start auth bot:', err.message);
        });
    } else {
        // Режим long polling - задержка 1-3 секунды
        console.log('[AUTH-BOT] Starting in LONG POLLING mode...');
        console.log('[AUTH-BOT] TIP: Set WEBHOOK_URL in .env for instant message delivery');
        
        bot.launch({
            dropPendingUpdates: false,
            allowedUpdates: ['message', 'callback_query', 'my_chat_member'],
            timeout: 30,
            limit: 100
        }).then(() => {
            authBot = bot;
            console.log('[AUTH-BOT] Auth bot @DigiStaff_Team_bot started successfully (polling mode)');
        }).catch((err) => {
            console.error('[AUTH-BOT] Failed to start auth bot:', err.message);
        });
    }

    // Обработка ошибок запуска
    process.once('SIGINT', () => {
        bot.stop('SIGINT');
    });
    process.once('SIGTERM', () => {
        bot.stop('SIGTERM');
    });

    return bot;
}

/**
 * Останавливает главный бот авторизации
 */
function stopAuthBot() {
    if (authBot) {
        try {
            authBot.stop();
        } catch (e) {
            // ignore
        }
        authBot = null;
        console.log('[AUTH-BOT] Auth bot stopped');
    }
}

/**
 * Возвращает экземпляр бота
 */
function getAuthBot() {
    return authBot;
}

module.exports = {
    startAuthBot,
    stopAuthBot,
    getAuthBot
};
