const { Telegraf, Markup } = require('telegraf');
const manageStore = require('../store');
const sessionService = require('../../services/session.service');
const contextHelper = require('./context');
const fs = require('fs').promises;
const path = require('path');
const dockerService = require('../../services/docker.service');

const { TOOLS_CHAT, TOOLS_WORKSPACE, TOOLS_TERMINAL } = require('./tools');
const { executeAgentLoop, classifyTask } = require('./agentLoop');
const { getSystemInstruction } = require('../prompts');
const { enqueue } = require('../agentQueue');
const contentMvpService = require('../../services/contentMvp.service');

const bots = new Map(); // chatId -> { bot, token }
const LOGIN_LINK_MESSAGE_TTL_MS = 10 * 60 * 1000;

function scheduleMessageDeletion(bot, chatId, messageId, delayMs = LOGIN_LINK_MESSAGE_TTL_MS) {
    if (!bot || !chatId || !messageId) return;
    setTimeout(async () => {
        try {
            await bot.telegram.deleteMessage(chatId, messageId);
        } catch (e) {
            // Сообщение уже удалено или недоступно
        }
    }, delayMs);
}
const workingMessages = new Map(); // chatId -> messageId

const MODE_LABELS = {
    CHAT:      { icon: '💬', label: 'Чат' },
    WORKSPACE: { icon: '📁', label: 'Workspace' },
    TERMINAL:  { icon: '⚡', label: 'Терминал' }
};

// Иконки статусов шагов прогресс-блока
const STEP_ICONS = {
    pending:     '⬜',
    in_progress: '⏳',
    done:        '✅',
    error:       '❌'
};

/**
 * Удаляет ВСЕ HTML-теги — используется как последний fallback для plain-text отправки.
 */
function stripAllTags(html) {
    if (!html) return '';
    return html
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n\n')
        .replace(/<\/div>/gi, '\n')
        .replace(/<\/li>/gi, '\n')
        .replace(/<li[^>]*>/gi, '• ')
        .replace(/<[^>]*>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/&#\d+;/g, '')
        .replace(/&[a-z]+;/gi, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/**
 * Санитизация HTML для Telegram Bot API (parse_mode: HTML).
 *
 * Telegram поддерживает только: <b> <i> <u> <s> <code> <pre> <a href="...">
 * Все остальные теги удаляются. Незакрытые/вложенные разрешённые теги
 * принудительно закрываются в конце, чтобы избежать "Unexpected end tag".
 */
function sanitizeHtmlForTelegram(html) {
    if (!html) return '';

    // Нормализуем буквальные \n (экранированные в JSON строках) → реальные переносы
    let result = html.replace(/\\n/g, '\n');

    // Заменяем <br>, <br/>, <br /> на переносы строк
    result = result.replace(/<br\s*\/?>/gi, '\n');

    // Заменяем блочные элементы на переносы (до удаления тегов)
    result = result.replace(/<\/p>/gi, '\n\n');
    result = result.replace(/<p[^>]*>/gi, '');
    result = result.replace(/<\/div>/gi, '\n');
    result = result.replace(/<div[^>]*>/gi, '');
    result = result.replace(/<\/li>/gi, '\n');
    result = result.replace(/<li[^>]*>/gi, '• ');
    result = result.replace(/<\/?[uo]l[^>]*>/gi, '');

    // <h1>–<h6> → <b>текст</b>
    result = result.replace(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi, '<b>$1</b>\n');

    // <strong> → <b>, <em> → <i>, <del>/<strike> → <s>
    result = result.replace(/<\/?strong[^>]*>/gi, (m) => m.startsWith('</') ? '</b>' : '<b>');
    result = result.replace(/<\/?em[^>]*>/gi,     (m) => m.startsWith('</') ? '</i>' : '<i>');
    result = result.replace(/<\/?del[^>]*>/gi,    (m) => m.startsWith('</') ? '</s>' : '<s>');
    result = result.replace(/<\/?strike[^>]*>/gi, (m) => m.startsWith('</') ? '</s>' : '<s>');

    // Удаляем <span> и другие неподдерживаемые теги, сохраняя разрешённые
    const ALLOWED = new Set(['b', 'i', 'u', 's', 'code', 'pre', 'a']);
    result = result.replace(/<(\/?)\s*([a-zA-Z][a-zA-Z0-9]*)[^>]*>/g, (match, slash, tagName) => {
        const tag = tagName.toLowerCase();
        if (!ALLOWED.has(tag)) return ''; // удаляем неподдерживаемый тег

        // Для <a> оставляем только href, убираем все остальные атрибуты
        if (tag === 'a' && !slash) {
            const hrefMatch = match.match(/href\s*=\s*["']([^"']+)["']/i);
            if (hrefMatch) return `<a href="${hrefMatch[1]}">`;
            return ''; // <a> без href — удаляем
        }
        // Для остальных разрешённых — оставляем только чистый тег без атрибутов
        return slash ? `</${tag}>` : `<${tag}>`;
    });

    // Принудительно закрываем незакрытые разрешённые теги (кроме <a> — он сложнее)
    // Проходим по тексту и отслеживаем стек открытых тегов
    const VOID_SAFE = ['b', 'i', 'u', 's', 'code', 'pre', 'a'];
    const stack = [];
    const tagRe = /<(\/?)([a-z]+)>/g;
    let m;
    while ((m = tagRe.exec(result)) !== null) {
        const [, closing, tag] = m;
        if (!VOID_SAFE.includes(tag)) continue;
        if (!closing) {
            stack.push(tag);
        } else {
            const idx = stack.lastIndexOf(tag);
            if (idx !== -1) stack.splice(idx, 1);
        }
    }
    // Закрываем всё что осталось открытым (в обратном порядке)
    for (let i = stack.length - 1; i >= 0; i--) {
        result += `</${stack[i]}>`;
    }

    // Убираем пустые теги вида <b></b>, <i></i> и т.д.
    result = result.replace(/<(b|i|u|s|code|pre|a)><\/\1>/g, '');

    // Убираем лишние пустые строки (более 2 подряд)
    result = result.replace(/\n{3,}/g, '\n\n');

    return result.trim();
}

/**
 * Единая точка отправки одного чанка в Telegram.
 *
 * @param {object} ctx       - Telegraf context (нужен только ctx.telegram)
 * @param {string} tgChatId  - РЕАЛЬНЫЙ Telegram chat ID (ctx.chat.id), числовой или строковый
 * @param {string} text      - Текст для отправки (может содержать HTML)
 * @param {object} opts      - Дополнительные опции (reply_markup и т.д.)
 *
 * Уровни fallback:
 *   1. HTML (parse_mode: HTML) — основной
 *   2. Plain text (теги удалены) — если HTML не прошёл
 *   3. Аварийная отправка (первые 1000 символов) — пользователь ДОЛЖЕН что-то получить
 */
async function safeSend(ctx, tgChatId, text, opts = {}) {
    const sanitized = sanitizeHtmlForTelegram(text);

    // Уровень 1: HTML
    try {
        await ctx.telegram.sendMessage(tgChatId, sanitized, {
            parse_mode: 'HTML',
            disable_web_page_preview: true,
            ...opts
        });
        return;
    } catch (htmlErr) {
        console.warn(`[TG-SEND-HTML-WARN] tgChatId: ${tgChatId}, error: ${htmlErr.message}`);
    }

    // Уровень 2: plain text (теги удалены)
    const plain = stripAllTags(text);
    try {
        await ctx.telegram.sendMessage(tgChatId, plain.slice(0, 4096), opts);
        return;
    } catch (plainErr) {
        console.warn(`[TG-SEND-PLAIN-WARN] tgChatId: ${tgChatId}, error: ${plainErr.message}`);
    }

    // Уровень 3: аварийная отправка — минимальный текст без форматирования
    try {
        const emergency = plain.slice(0, 1000) || '(ответ получен, но не удалось отформатировать)';
        await ctx.telegram.sendMessage(tgChatId, emergency);
    } catch (emergencyErr) {
        console.error(`[TG-SEND-FATAL] tgChatId: ${tgChatId}, error: ${emergencyErr.message}`);
    }
}

function getContextKeyboard() {
    return Markup.inlineKeyboard([
        [Markup.button.callback('🔄 Очистить контекст', 'clear_context')]
    ]);
}

/**
 * Удаляет "рабочее" сообщение (⏳ Обрабатываю...) из чата.
 * tgChatId — реальный Telegram chat ID (ctx.chat.id).
 * sessionId — внутренний ключ сессии (для workingMessages Map).
 */
async function clearWorkingMessage(ctx, tgChatId, sessionId) {
    const key = sessionId || tgChatId;
    const msgId = workingMessages.get(key);
    if (msgId) {
        try {
            await ctx.telegram.deleteMessage(tgChatId, msgId);
        } catch (e) {
            // Игнорируем ошибку, если сообщение уже удалено
        }
        workingMessages.delete(key);
    }
}

/**
 * Отправляет финальный ответ пользователю.
 * tgChatId — реальный Telegram chat ID (ctx.chat.id).
 * sessionId — внутренний ключ сессии (для workingMessages Map).
 */
async function sendReply(ctx, tgChatId, text, sessionId) {
    await clearWorkingMessage(ctx, tgChatId, sessionId);

    // Нормализуем буквальные \n → реальные переносы строк
    const normalized = (text || '').replace(/\\n/g, '\n');

    if (normalized.length <= 4096) {
        const opts = getContextKeyboard();
        await safeSend(ctx, tgChatId, normalized, opts);
    } else {
        console.warn(`[TG-SEND-WARN] Message too long (${normalized.length} chars), splitting...`);
        // Разбиваем по 4000 символов
        const chunks = [];
        let remaining = normalized;
        while (remaining.length > 0) {
            chunks.push(remaining.substring(0, 4000));
            remaining = remaining.substring(4000);
        }
        for (let i = 0; i < chunks.length; i++) {
            const opts = i === chunks.length - 1 ? getContextKeyboard() : {};
            await safeSend(ctx, tgChatId, chunks[i], opts);
        }
    }
}

function makeCode() {
    return String(Math.floor(100000 + Math.random() * 900000));
}

/**
 * Обработка текстового сообщения от пользователя.
 * Вынесено в отдельную функцию для вызова из bot.on('text') и из callback-кнопок.
 */
async function handleTextMessage(ctx, chatId) {
    const fromId = ctx.from?.id;
    const username = ctx.from?.username ? `@${ctx.from.username}` : null;
    const text = (ctx.message?.text || '').trim();
    if (!text) return;

    // tgChatId — РЕАЛЬНЫЙ числовой Telegram chat ID, используется для отправки сообщений
    // chatId   — внутренний ключ сессии (из замыкания startBot), используется для store/session
    const tgChatId = String(ctx.chat.id);
    console.log('[TG-MSG]', tgChatId, '(session:', chatId, ')', text.slice(0,100));

    const data = manageStore.getState(chatId);
    if (!data || !data.token) {
        return ctx.reply('Бот отключён. Добавьте токен в панели управления.');
    }

    if (!data.verifiedTelegramId) {
        const code = makeCode();
        manageStore.setPending(chatId, code, fromId, username);
        await ctx.reply(
            `Код подтверждения: ${code}\n\nВведите этот код в панели управления (Каналы связи → Телеграм Бот → Подтвердить), чтобы привязать управление к этому аккаунту. Код действителен 10 минут.`
        );
        return;
    }

    if (data.verifiedTelegramId !== fromId) {
        return ctx.reply('Управление окружением привязано к другому пользователю. Только он может давать команды.');
    }

    const lower = text.toLowerCase();

    if (lower === '/post_now') {
        try {
            const result = await contentMvpService.runNow(chatId, { telegram: ctx.telegram }, 'manual');
            await ctx.reply(result?.message || 'Операция выполнена.');
        } catch (e) {
            await ctx.reply(`Ошибка запуска публикации: ${e.message}`);
        }
        return;
    }
    
    // Команда /role - показать системную роль и историю переписки
    if (lower === '/role' || lower === '/context') {
        try {
            await ctx.reply('📋 Формирую файл с системной ролью и историей переписки...');
            
            const structuredContext = await contextHelper.buildFullContextStructured(chatId);
            const currentMode = manageStore.getAgentMode(chatId) || 'TERMINAL';
            const systemPrompt = getSystemInstruction(currentMode, structuredContext);
            
            const aiMessages = manageStore.getAIMessages(chatId, 'telegram', 50);
            
            let fileContent = `═══════════════════════════════════════════════════════════════\n`;
            fileContent += `                    СИСТЕМНАЯ РОЛЬ AI АССИСТЕНТА\n`;
            fileContent += `═══════════════════════════════════════════════════════════════\n\n`;
            fileContent += `Chat ID: ${chatId}\n`;
            fileContent += `Дата: ${new Date().toLocaleString('ru-RU')}\n`;
            fileContent += `Модель: ${data.aiModel || 'не указана'}\n`;
            fileContent += `Режим: ${currentMode}\n\n`;
            fileContent += `───────────────────────────────────────────────────────────────\n`;
            fileContent += `                    СИСТЕМНЫЙ ПРОМПТ\n`;
            fileContent += `───────────────────────────────────────────────────────────────\n\n`;
            fileContent += systemPrompt;
            fileContent += `\n\n═══════════════════════════════════════════════════════════════\n`;
            fileContent += `                    ИСТОРИЯ ПЕРЕПИСКИ\n`;
            fileContent += `═══════════════════════════════════════════════════════════════\n\n`;
            
            if (aiMessages.length === 0) {
                fileContent += `(история пуста - переписка с AI ещё не начиналась)\n`;
            } else {
                fileContent += `Всего сообщений: ${aiMessages.length}\n\n`;
                
                aiMessages.forEach((msg, idx) => {
                    const roleEmoji = msg.role === 'user' ? '👤' : 
                                     msg.role === 'assistant' ? '🤖' : 
                                     msg.role === 'tool' ? '🔧' : '📝';
                    const roleName = msg.role === 'user' ? 'ПОЛЬЗОВАТЕЛЬ' :
                                    msg.role === 'assistant' ? 'AI АССИСТЕНТ' :
                                    msg.role === 'tool' ? 'TOOL RESULT' :
                                    msg.role.toUpperCase();
                    
                    fileContent += `───────────────────────────────────────────────────────────────\n`;
                    fileContent += `${roleEmoji} [${idx + 1}] ${roleName}`;
                    if (msg.at) {
                        fileContent += ` (${new Date(msg.at).toLocaleString('ru-RU')})`;
                    }
                    fileContent += `\n`;
                    fileContent += `───────────────────────────────────────────────────────────────\n`;
                    
                    if (msg.content) {
                        fileContent += `${msg.content}\n`;
                    }
                    
                    if (msg.tool_calls && msg.tool_calls.length > 0) {
                        fileContent += `\n📎 Tool Calls:\n`;
                        msg.tool_calls.forEach((tc, tcIdx) => {
                            fileContent += `  [${tcIdx + 1}] ${tc.function.name}\n`;
                            if (tc.function.arguments) {
                                const args = JSON.parse(tc.function.arguments);
                                fileContent += `      Аргументы: ${JSON.stringify(args, null, 2).split('\n').join('\n      ')}\n`;
                            }
                        });
                    }
                    
                    if (msg.tool_call_id) {
                        fileContent += `\n🔧 Tool Call ID: ${msg.tool_call_id}\n`;
                    }
                    
                    fileContent += `\n`;
                });
            }
            
            fileContent += `\n═══════════════════════════════════════════════════════════════\n`;
            fileContent += `                    КОНЕЦ ОТЧЕТА\n`;
            fileContent += `═══════════════════════════════════════════════════════════════\n`;
            
            const timestamp = Date.now();
            const tempFileName = `ai-role-${chatId}-${timestamp}.txt`;
            const tempPath = path.join('/tmp', tempFileName);
            
            await fs.writeFile(tempPath, fileContent, 'utf8');
            
            await ctx.replyWithDocument(
                { source: tempPath },
                { 
                    caption: `📋 Системная роль и история переписки AI\n\nВсего сообщений в истории: ${aiMessages.length}`,
                    filename: `ai-role-${chatId}.txt`
                }
            );
            
            await fs.unlink(tempPath).catch(e => 
                console.error('[TG-ROLE-CLEANUP-ERR]', e.message)
            );
            
        } catch (e) {
            console.error('[TG-ROLE-ERROR]', chatId, e);
            await ctx.reply('❌ Ошибка формирования файла: ' + e.message);
        }
        return;
    }
    
    if (lower === 'статус' || lower === 'status' || lower === 'контекст' || lower === 'context' || lower === 'info') {
        try {
            const context = await contextHelper.buildContext(chatId);
            const chunk = context.slice(0, 4000);
            await ctx.reply(chunk || 'Контекст пуст.');
        } catch (e) {
            await ctx.reply('Ошибка получения контекста: ' + e.message);
        }
        return;
    }

    const session = sessionService.getSession(chatId);
    if (!session) {
        return ctx.reply('Сессия не найдена. Создайте сессию в панели (войдите по Chat ID).');
    }

    if (data.aiAuthToken && data.aiModel) {
        // AI ассистент mode

        if (data.aiBlocked) {
            const blockReason = data.aiBlockReason || 'Баланс отрицательный или срок тарифа истёк.';
            return ctx.reply(`⚠️ ИИ ассистент временно отключён.\n\n${blockReason}\n\nПродлите Ваш тариф для возобновления работы.`);
        }

        // Отправляем статус-сообщение СРАЗУ — до любой тяжёлой работы.
        // Это важно: Telegram ждёт ответа от обработчика, а агентский loop
        // может занять минуты. Запускаем loop в фоне через setImmediate.
        const workingMsg = await ctx.reply('⏳ Обрабатываю запрос...').catch(() => null);
        // Ключ в workingMessages — tgChatId (числовой), т.к. editMessageText тоже использует tgChatId
        if (workingMsg) workingMessages.set(tgChatId, workingMsg.message_id);

        // Весь тяжёлый AI-блок уходит в фон — обработчик text немедленно завершается
        setImmediate(async () => {
            try {
                const currentMode = manageStore.getAgentMode(chatId) || 'TERMINAL';
                let effectiveMode = currentMode;

                const structuredContext = await contextHelper.buildFullContextStructured(chatId);
                const systemPrompt = getSystemInstruction(effectiveMode, structuredContext, 'telegram');

                const historyMessages = manageStore.getAIMessages(chatId, 'telegram', 30);

                let messages = [
                    { role: "system", content: systemPrompt },
                    ...historyMessages.map(m => ({
                        role: m.role,
                        content: m.content || '',
                        tool_calls: m.tool_calls,
                        tool_call_id: m.tool_call_id
                    })),
                    { role: "user", content: text }
                ];

                let tools = [];
                if (effectiveMode === 'CHAT') tools = TOOLS_CHAT;
                else if (effectiveMode === 'WORKSPACE') tools = TOOLS_WORKSPACE;
                else tools = TOOLS_TERMINAL;

                let currentSteps = [];
                let currentStepIndex = -1;
                let lastStatusMessage = '';
                let sessionTokens = 0; // суммарные токены за сессию
                const startTime = Date.now();

                // Форматирует прошедшее время: "5с", "1м 23с"
                const formatElapsed = () => {
                    const sec = Math.floor((Date.now() - startTime) / 1000);
                    if (sec < 60) return `${sec}с`;
                    return `${Math.floor(sec / 60)}м ${sec % 60}с`;
                };

                const renderProgressBlock = () => {
                    const modeInfo = MODE_LABELS[effectiveMode] || { icon: '🤖', label: effectiveMode };
                    const elapsed = formatElapsed();
                    const tokStr = sessionTokens > 0 ? `  ·  🪙 ${sessionTokens.toLocaleString()} токенов` : '';

                    if (currentSteps.length === 0) {
                        // Нет плана — показываем просто статус
                        const status = lastStatusMessage || '⏳ Думаю...';
                        return `${modeInfo.icon} <b>${modeInfo.label}</b>  ·  ⏱ ${elapsed}${tokStr}\n\n${status}`;
                    }

                    const done  = currentSteps.filter((_, i) => i < currentStepIndex).length;
                    const total = currentSteps.length;

                    let out = `${modeInfo.icon} <b>${modeInfo.label}</b>  ·  ⏱ ${elapsed}  ·  ${done}/${total} шагов${tokStr}\n`;
                    out += `<b>📋 План выполнения:</b>\n`;

                    currentSteps.forEach((step, idx) => {
                        let icon = STEP_ICONS.pending;
                        if (idx < currentStepIndex)      icon = STEP_ICONS.done;
                        else if (idx === currentStepIndex) icon = STEP_ICONS.in_progress;
                        // Экранируем спецсимволы HTML в тексте шага
                        const safeStep = step.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
                        out += `${icon} ${idx + 1}. ${safeStep}\n`;
                    });

                    if (lastStatusMessage) {
                        // lastStatusMessage уже содержит готовый HTML (теги <code> и т.д.) — не экранируем
                        out += `\n${lastStatusMessage}`;
                    }
                    return out;
                };

                const updateProgressMessage = async () => {
                    const msg = renderProgressBlock();
                    // Ключ в Map — tgChatId (числовой Telegram ID)
                    const msgId = workingMessages.get(tgChatId);
                    if (msgId) {
                        try {
                            await ctx.telegram.editMessageText(tgChatId, msgId, null, msg, { parse_mode: 'HTML' });
                        } catch (editErr) {
                            if (editErr.message && editErr.message.includes('parse')) {
                                // HTML не прошёл — редактируем plain text
                                try {
                                    await ctx.telegram.editMessageText(tgChatId, msgId, null, stripAllTags(msg));
                                } catch (_) {
                                    // Игнорируем: текст не изменился или сообщение удалено
                                }
                            }
                            // Иначе игнорируем (текст не изменился и т.п.)
                        }
                    } else {
                        const m = await ctx.telegram.sendMessage(tgChatId, msg, { parse_mode: 'HTML' }).catch(async () => {
                            // Fallback: plain text
                            return ctx.telegram.sendMessage(tgChatId, stripAllTags(msg)).catch(() => null);
                        });
                        if (m) workingMessages.set(tgChatId, m.message_id);
                    }
                };

                const agentCtx = {
                    channel: 'telegram',
                    chatId, // внутренний sessionId — для store/session
                    sendMessage: async (msg) => {
                        // tgChatId — реальный Telegram ID для отправки
                        // chatId   — sessionId для clearWorkingMessage Map
                        await sendReply(ctx, tgChatId, msg, tgChatId);
                    },
                    setSteps: async (steps) => {
                        currentSteps = steps;
                        currentStepIndex = 0;
                        await updateProgressMessage();
                    },
                    markStepDone: async () => {
                        if (currentStepIndex < currentSteps.length) {
                            currentStepIndex++;
                            await updateProgressMessage();
                        }
                    },
                    updateStatusMessage: async (msg) => {
                        lastStatusMessage = msg;
                        await updateProgressMessage();
                    },
                    sendHtmlMessage: async (htmlText) => {
                        await clearWorkingMessage(ctx, tgChatId, tgChatId);
                        // safeSend уже содержит 3-уровневый fallback: HTML → plain → emergency
                        await safeSend(ctx, tgChatId, htmlText || '', getContextKeyboard());
                    },
                    sendFile: async (_filePath, _caption) => {
                        // Файлы отправляются после завершения loop
                    },
                    updateTokens: async (prompt, completion, total) => {
                        sessionTokens = total;
                        await updateProgressMessage();
                    },
                    confirm: async (question) => {
                        // Показываем план пользователю с кнопками и сразу продолжаем.
                        // Кнопки — для удобства: они просто шлют текст в чат через bot.on('text').
                        // Агент не ждёт ответа — он уже получил план и начинает выполнение.
                        await ctx.reply(question, Markup.inlineKeyboard([
                            [Markup.button.callback('✅ Подтвердить', 'confirm_yes')],
                            [Markup.button.callback('❌ Отклонить', 'confirm_no')]
                        ])).catch(() => {});
                        return true; // всегда продолжаем — пользователь может остановить текстом
                    }
                };

                // Запускаем агентский loop
                const result = await enqueue(chatId, () => executeAgentLoop(chatId, data, messages, tools, agentCtx));

                // Сохраняем историю (без system prompt)
                const messagesToSave = messages.filter(m => m.role !== 'system');
                manageStore.setAIMessages(chatId, 'telegram', messagesToSave);

                if (result.error) {
                    return await sendReply(ctx, tgChatId, `❌ Ошибка: ${result.error}`, tgChatId);
                }

                const { summary, html_report, filesToSend = [] } = result;

                // Отправляем файлы если они есть
                if (filesToSend.length > 0) {
                    await clearWorkingMessage(ctx, tgChatId, tgChatId);
                    console.log('[TG-PROCESSING-FILES]', filesToSend.length, 'files');

                    for (const filePath of filesToSend) {
                        try {
                            if (!filePath) continue;

                            try {
                                const checkCmd = `test -f "${filePath}" && echo "EXISTS" || echo "NOT FOUND"`;
                                const checkResult = await sessionService.executeCommand(chatId, checkCmd, 10);
                                if (!checkResult.stdout.includes('EXISTS')) {
                                    await ctx.reply(`❌ Файл не найден в контейнере: ${filePath}`);
                                    continue;
                                }
                            } catch (checkErr) {
                                console.error('[TG-FILE-CHECK-ERROR]', checkErr.message);
                            }

                            const timestamp = Date.now();
                            const random = Math.floor(Math.random() * 10000);
                            const fileName = path.basename(filePath);
                            const tempFileName = `tg-send-${timestamp}-${random}-${fileName}`;
                            const tempPath = path.join('/tmp', tempFileName);

                            await dockerService.copyFromContainer(session.containerId, filePath, tempPath);

                            try {
                                const stats = await fs.stat(tempPath);
                                if (stats.size === 0) {
                                    await ctx.reply(`⚠️ Файл ${fileName} пустой`);
                                    await fs.unlink(tempPath).catch(() => {});
                                    continue;
                                }
                            } catch (statErr) {
                                await ctx.reply(`❌ Ошибка при копировании файла ${fileName}`);
                                continue;
                            }

                            await ctx.replyWithDocument(
                                { source: tempPath },
                                { caption: `📎 ${fileName}`, filename: fileName }
                            );

                            await fs.unlink(tempPath).catch(() => {});

                        } catch (e) {
                            console.error('[TG-SEND-FILE-ERROR]', chatId, filePath, e.message);
                            await ctx.reply(`❌ Не удалось отправить файл ${path.basename(filePath)}: ${e.message}`);
                        }
                    }
                }

                // Отправляем финальный ответ
                if (html_report) {
                    await agentCtx.sendHtmlMessage(html_report);
                } else if (result.limitReached) {
                    // Если лимит достигнут — предлагаем продолжить
                    await ctx.telegram.sendMessage(tgChatId, '⚠️ Достигнут лимит шагов. Продолжить выполнение?', {
                        reply_markup: {
                            inline_keyboard: [[
                                { text: '▶️ Продолжить', callback_data: 'continue_execution' }
                            ]]
                        }
                    });
                } else if (summary) {
                    await sendReply(ctx, tgChatId, summary.slice(0, 4096), tgChatId);
                } else if (filesToSend.length === 0) {
                    await sendReply(ctx, tgChatId, '✅ Запрос обработан.', tgChatId);
                }

            } catch (err) {
                console.error('[TG-AI]', chatId, err);
                await sendReply(ctx, tgChatId, `❌ Ошибка ИИ ассистента: ${err.message}`, tgChatId).catch(() => {});
            }
        }); // конец setImmediate
    } else {
        // Direct command mode
        try {
            const result = await sessionService.executeCommand(chatId, text, 60);
            manageStore.addCommand(
                chatId,
                text,
                result.stdout,
                result.stderr,
                result.exitCode != null ? result.exitCode : 0
            );
            let reply = '';
            if (result.stdout) reply += result.stdout.slice(0, 3500);
            if (result.stderr) reply += (reply ? '\n\n' : '') + 'stderr:\n' + result.stderr.slice(0, 1500);
            if (!reply) reply = '(пустой вывод)';
            if (result.exitCode !== undefined && result.exitCode !== 0) {
                reply += `\n\n[exit ${result.exitCode}]`;
            }
            await ctx.reply(reply.slice(0, 4096));
        } catch (err) {
            manageStore.addCommand(chatId, text, '', err.message, -1);
            await ctx.reply('Ошибка выполнения: ' + err.message);
        }
    }
}

function startBot(chatId, token) {
    if (bots.has(chatId)) {
        try {
            bots.get(chatId).bot.stop();
        } catch (e) {
            // ignore
        }
        bots.delete(chatId);
    }

    const bot = new Telegraf(token);

    bot.catch((err, ctx) => {
        console.error('[MANAGE-TG]', chatId, err.message);
        ctx.reply('Произошла ошибка. Попробуйте позже.').catch(() => {});
    });

    // Обработчик "Войти в аккаунт" — авторизация через Telegram ID
    bot.action('login_account', async (ctx) => {
        const fromId = String(ctx.from?.id || '');
        const username = ctx.from?.username ? `@${ctx.from.username}` : null;

        await ctx.answerCbQuery('Авторизация...').catch(() => {});

        console.log(`[TG-LOGIN] telegram_id=${fromId}, username=${username}`);

        try {
            // Вызываем API авторизации
            const apiUrl = process.env.API_URL || 'https://claw.pro-talk.ru';
            const response = await fetch(`${apiUrl}/api/auth/telegram-login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    telegram_id: fromId,
                    username: username
                })
            });

            const result = await response.json();

            // Удаляем исходное сообщение с кнопкой сразу после нажатия
            try {
                await ctx.deleteMessage();
            } catch (e) {
                await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
            }

            if (result.success) {
                // Формируем приветственное сообщение
                let welcomeMsg;

                if (result.isNewUser) {
                    // Новый пользователь — аккаунт создан
                    welcomeMsg = `🎉 <b>Добро пожаловать, ${username || 'пользователь'}!</b>\n\n`;
                    welcomeMsg += `✅ Ваш аккаунт создан и активирован.\n\n`;
                    welcomeMsg += `<b>Вам доступно:</b>\n`;
                    welcomeMsg += `• 🐍 Python 3 с основными библиотеками\n`;
                    welcomeMsg += `• 📦 Node.js + npm\n`;
                    welcomeMsg += `• 🗄️ PostgreSQL база данных\n`;
                    welcomeMsg += `• 📁 Персональное рабочее пространство\n\n`;
                    welcomeMsg += `⏱ Ссылка на вход действует 10 минут.\n`;
                    welcomeMsg += `🔗 <a href="${result.redirectUrl}">Открыть панель (10 мин)</a>\n\n`;
                    welcomeMsg += `<i>💡 Совет: подключите AI-ассистента в разделе "Каналы связи" для работы с кодом через чат.</i>`;
                } else {
                    // Существующий пользователь
                    welcomeMsg = `✅ <b>С возвращением, ${result.username || username || 'пользователь'}!</b>\n\n`;
                    welcomeMsg += `Вы успешно вошли в свой аккаунт.\n\n`;

                    if (result.hasAI) {
                        welcomeMsg += `🤖 <b>AI-ассистент:</b> подключён\n`;
                    } else {
                        welcomeMsg += `🤖 <b>AI-ассистент:</b> не подключён\n`;
                    }

                    if (result.hasBot) {
                        welcomeMsg += `🤖 <b>Telegram бот:</b> активен\n\n`;
                    }

                    welcomeMsg += `⏱ Ссылка на вход действует 10 минут.\n`;
                    welcomeMsg += `🔗 <a href="${result.redirectUrl}">Открыть панель (10 мин)</a>`;
                }

                const sentMessage = await ctx.reply(welcomeMsg, {
                    parse_mode: 'HTML',
                    disable_web_page_preview: true
                }).catch(() => {});
                scheduleMessageDeletion(bot, ctx.chat?.id, sentMessage?.message_id);

                console.log(`[TG-LOGIN] Success for telegram_id=${fromId}, chatId=${result.chatId}, isNew=${result.isNewUser || false}`);
            } else {
                // Ошибка авторизации
                const errorMsg = result.error || 'Неизвестная ошибка';
                await ctx.reply(`❌ <b>Ошибка авторизации</b>\n\n${errorMsg}\n\nПопробуйте позже или обратитесь в поддержку.`, {
                    parse_mode: 'HTML'
                }).catch(() => {});

                console.error(`[TG-LOGIN] Failed for telegram_id=${fromId}:`, errorMsg);
            }
        } catch (e) {
            console.error('[TG-LOGIN-ERROR]', e.message);
            console.error('[TG-LOGIN-ERROR] API URL:', apiUrl);
            console.error('[TG-LOGIN-ERROR] Full error:', e);
            
            // Более подробное сообщение об ошибке для отладки
            let errorMsg = '❌ Ошибка соединения. Попробуйте позже.';
            
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

    // Обработчик очистки контекста
    bot.action('clear_context', async (ctx) => {
        // chatId из замыкания — правильный внутренний ID сессии
        manageStore.setAIMessages(chatId, 'telegram', []);
        manageStore.clearLastCommands(chatId);
        
        // Очищаем завершённые планы и удалённые приложения
        try {
            const planService = require('../../services/plan.service');
            const deletedPlans = await planService.cleanupCompletedPlans(chatId);
            const deletedApps = manageStore.cleanupDeletedApps(chatId);
            
            let cleanupMsg = '🔄 Контекст ИИ-ассистента и история команд очищены.';
            if (deletedPlans > 0 || deletedApps > 0) {
                cleanupMsg += '\n\n🧹 Удалено:';
                if (deletedPlans > 0) cleanupMsg += `\n• ${deletedPlans} завершённых планов`;
                if (deletedApps > 0) cleanupMsg += `\n• ${deletedApps} неактивных приложений`;
            }
            cleanupMsg += '\n\nНачинаем с чистого листа.';
            
            await ctx.answerCbQuery('Контекст очищен');
            await ctx.reply(cleanupMsg);
        } catch (e) {
            console.error('[CLEAR-CONTEXT-ERROR]', e.message);
            await ctx.answerCbQuery('Контекст очищен');
            await ctx.reply('🔄 Контекст ИИ-ассистента и история команд очищены. Начинаем с чистого листа.');
        }
    });

    // Обработчики кнопок подтверждения — вызывают handleTextMessage напрямую
    bot.action('confirm_yes', async (ctx) => {
        await ctx.answerCbQuery('Подтверждено').catch(() => {});
        await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
        // Имитируем сообщение от пользователя — агент обработает его как обычный текст
        ctx.message = { ...ctx.update.callback_query.message, text: '✅ Подтверждаю. Выполняй план.' };
        ctx.update.message = ctx.message;
        await handleTextMessage(ctx, chatId);
    });

    bot.action('confirm_no', async (ctx) => {
        await ctx.answerCbQuery('Отклонено').catch(() => {});
        await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
        ctx.message = { ...ctx.update.callback_query.message, text: '❌ Отклоняю план. Предложи другой вариант.' };
        ctx.update.message = ctx.message;
        await handleTextMessage(ctx, chatId);
    });

    bot.action('continue_execution', async (ctx) => {
        await ctx.answerCbQuery('Продолжаем...').catch(() => {});
        await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
        ctx.message = { ...ctx.update.callback_query.message, text: 'Продолжай выполнение.' };
        ctx.update.message = ctx.message;
        await handleTextMessage(ctx, chatId);
    });

    // Обработчик загрузки файлов
    bot.action(/^content:(\d+):(approve|regen_text|regen_image|reject)$/, async (ctx) => {
        const fromId = String(ctx.from?.id || '');
        const moderatorId = String(process.env.CONTENT_MVP_MODERATOR_USER_ID || '128247430');
        if (fromId !== moderatorId) {
            await ctx.answerCbQuery('Недостаточно прав', { show_alert: true }).catch(() => {});
            return;
        }

        const [, jobIdRaw, action] = ctx.match || [];
        const jobId = Number(jobIdRaw);
        if (!Number.isFinite(jobId)) {
            await ctx.answerCbQuery('Некорректный ID').catch(() => {});
            return;
        }

        try {
            const result = await contentMvpService.handleModerationAction(chatId, { telegram: ctx.telegram }, action, jobId);
            await ctx.answerCbQuery(result?.ok ? 'Готово' : 'Ошибка').catch(() => {});
            await ctx.reply(result?.message || 'Операция выполнена.');
        } catch (e) {
            await ctx.answerCbQuery('Ошибка').catch(() => {});
            await ctx.reply(`Ошибка модерации: ${e.message}`);
        }
    });

    bot.on('document', async (ctx) => {
        const fromId = ctx.from?.id;
        const username = ctx.from?.username ? `@${ctx.from.username}` : null;
        const document = ctx.message?.document;
        if (!document) return;

        const tgChatId = String(ctx.chat.id);
        console.log('[TG-FILE]', tgChatId, '(session:', chatId, ')', document.file_name, document.file_size);

        const data = manageStore.getState(chatId);
        if (!data || !data.token) {
            return ctx.reply('Бот отключён. Добавьте токен в панели управления.');
        }

        if (!data.verifiedTelegramId) {
            return ctx.reply('Сначала подтвердите аккаунт. Отправьте текстовое сообщение для получения кода.');
        }

        if (data.verifiedTelegramId !== fromId) {
            return ctx.reply('Управление окружением привязано к другому пользователю. Только он может загружать файлы.');
        }

        const session = sessionService.getSession(chatId);
        if (!session) {
            return ctx.reply('Сессия не найдена. Создайте сессию в панели (войдите по Chat ID).');
        }

        // Ограничение размера файла: 10MB
        const maxSize = 10 * 1024 * 1024;
        if (document.file_size > maxSize) {
            return ctx.reply(`❌ Файл слишком большой (${Math.round(document.file_size / 1024 / 1024)}MB). Максимальный размер: 10MB.`);
        }

        // Санитизация имени файла
        let fileName = document.file_name.replace(/[^a-zA-Z0-9._-]/g, '_');
        if (!fileName) fileName = 'uploaded_file';

        try {
            // Скачиваем файл
            const fileLink = await ctx.telegram.getFileLink(document.file_id);
            const response = await fetch(fileLink.href);
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const buffer = await response.arrayBuffer();
            const timestamp = Date.now();
            const random = Math.floor(Math.random() * 10000);
            const tempFileName = `tg-upload-${timestamp}-${random}-${fileName}`;
            const tempPath = path.join('/tmp', tempFileName);

            await fs.writeFile(tempPath, Buffer.from(buffer));

            // Копируем в контейнер в /workspace/input
            const containerPath = `/workspace/input/${fileName}`;
            await dockerService.copyToContainer(tempPath, session.containerId, containerPath);

            // Удаляем временный файл
            await fs.unlink(tempPath).catch(() => {});

            await ctx.reply(`✅ Файл "${fileName}" загружен в /workspace/input\nРазмер: ${Math.round(document.file_size / 1024)}KB`);

        } catch (err) {
            console.error('[TG-FILE-ERROR]', chatId, err.message);
            await ctx.reply(`❌ Ошибка загрузки файла: ${err.message}`);
        }
    });

    bot.on('text', async (ctx) => {
        await handleTextMessage(ctx, chatId);
    });

    bot.launch().then(() => {
        bots.set(chatId, { bot, token });
        console.log('[MANAGE-TG] Bot started for chatId:', chatId);
    }).catch((err) => {
        console.error('[MANAGE-TG] Failed to start bot for', chatId, err.message);
    });

    return bot;
}

function stopBot(chatId) {
    const entry = bots.get(chatId);
    if (entry) {
        try {
            entry.bot.stop();
        } catch (e) {
            // ignore
        }
        bots.delete(chatId);
        console.log('[MANAGE-TG] Bot stopped for chatId:', chatId);
    }
}

async function startAllBots() {
    const list = manageStore.getAllTokens();
    for (const { chatId, token } of list) {
        if (token) startBot(chatId, token);
    }
}

module.exports = {
    startBot,
    stopBot,
    startAllBots,
    bots
};
