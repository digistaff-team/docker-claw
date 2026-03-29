const Imap = require('imap-simple');
const simpleParser = require('mailparser').simpleParser;
const nodemailer = require('nodemailer');
const fs = require('fs').promises;
const path = require('path');
const manageStore = require('../store');
// manageStore.load() вызывается в server.js при старте, не нужно вызывать здесь
const sessionService = require('../../services/session.service');
const contextHelper = require('../context');
const aiRouterService = require('../../services/ai_router_service');
const dockerService = require('../../services/docker.service');

const { executeAgentLoop } = require('../telegram/agentLoop');
const { TOOLS_TERMINAL } = require('../telegram/tools');
const { getSystemInstruction } = require('../prompts');
const { enqueue } = require('../agentQueue');
const { getEnabledChannels } = require('../../services/content/repository');

let emailCronInterval = null;

function isOwnReply(parsed, config) {
    const from = (parsed.from?.text || parsed.from || '').toLowerCase();
    const subject = (parsed.subject || '').toLowerCase();
    
    return from.includes(config.smtpUser.toLowerCase()) ||
           subject.includes('auto-reply') ||
           subject.includes('out of office') ||
           parsed.headers?.get('x-auto-response-suppress');
}

function createEmailAgentCtx(chatId, config, parsed) {
    return {
        channel: 'email',
        chatId,
        sendMessage: async (text) => {
            await sendEmail(chatId, parsed.from?.text || parsed.from, parsed.subject, text, []);
        },
        sendFile: async (filePath, caption) => {
            await sendEmail(chatId, parsed.from?.text || parsed.from, parsed.subject, caption || `Файл: ${path.basename(filePath)}`, [filePath]);
        },
        confirm: async (question) => true // Email — нет интерактивности
    };
}

async function sendEmail(chatId, toEmail, subject, body, filePaths = []) {
    const data = manageStore.getState(chatId);
    if (!data || !data.email) return;

    const config = data.email;
    console.log('[EMAIL-DEBUG] nodemailer:', Object.keys(nodemailer));
    const transporter = nodemailer.createTransport({
        host: config.smtpHost,
        port: config.smtpPort,
        secure: config.smtpPort === 465, // true for 465, false for other ports
        auth: {
            user: config.smtpUser,
            pass: config.smtpPass
        },
        tls: { rejectUnauthorized: false }
    });

    const attachments = [];
    for (const filePath of filePaths) {
        try {
            const timestamp = Date.now();
            const random = Math.floor(Math.random() * 10000);
            const fileName = path.basename(filePath);
            const tempFileName = `email-send-${timestamp}-${random}-${fileName}`;
            const tempPath = path.join('/tmp', tempFileName);

            await dockerService.copyFromContainer(sessionService.getSession(chatId).containerId, filePath, tempPath);

            const stats = await fs.stat(tempPath);
            if (stats.size > 0) {
                attachments.push({
                    filename: fileName,
                    path: tempPath,
                    contentType: 'application/octet-stream'
                });
            } else {
                await fs.unlink(tempPath).catch(() => {});
            }
        } catch (e) {
            console.error('[EMAIL-SEND-FILE-ERR]', chatId, filePath, e.message);
        }
    }

    const mailOptions = {
        from: `"AI Agent" <${config.smtpUser}>`,
        to: toEmail,
        subject: `Re: ${subject}`,
        html: `<p>${body.replace(/\n/g, '<br>')}</p>`,
        attachments
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log('[EMAIL-SENT]', chatId, toEmail);

        // Cleanup temp files
        for (const att of attachments) {
            await fs.unlink(att.path).catch(() => {});
        }
    } catch (e) {
        console.error('[EMAIL-SEND-ERR]', chatId, e.message);
    }
}

async function processEmail(chatId, parsed) {
    const text = (parsed.text || '').trim();
    if (!text) return;

    console.log('[EMAIL-MSG]', chatId, text.slice(0, 100));

    const data = manageStore.getState(chatId);
    if (!data || !data.email) return;

    const session = sessionService.getSession(chatId);
    if (!session) {
        console.log('[EMAIL-NO-SESSION]', chatId);
        return;
    }

    if (data.aiAuthToken && data.aiModel) {
        // AI mode
        try {
            const agentCtx = createEmailAgentCtx(chatId, data.email, parsed);
            const structuredContext = await contextHelper.buildFullContextStructured(chatId);
            let enabledChannels = [];
            try { enabledChannels = await getEnabledChannels(chatId); } catch (_) {}

            const systemPrompt = getSystemInstruction('TERMINAL', structuredContext, 'email', enabledChannels);

            const historyMessages = manageStore.getAIMessages(chatId, 'email', 20);
            const messages = [
                { role: 'system', content: systemPrompt },
                ...historyMessages.map(m => ({
                    role: m.role,
                    content: m.content || '',
                    tool_calls: m.tool_calls,
                    tool_call_id: m.tool_call_id
                })),
                { role: 'user', content: text }
            ];

            const result = await enqueue(chatId, () => executeAgentLoop(chatId, data, messages, TOOLS_TERMINAL, agentCtx, 10));

            // Сохраняем обновленную историю сообщений (без system prompt)
            const messagesToSave = messages.filter(m => m.role !== 'system');
            manageStore.setAIMessages(chatId, 'email', messagesToSave);

            if (result.error) {
                await agentCtx.sendMessage(`❌ Ошибка: ${result.error}`);
                return;
            }

            const { summary, filesToSend = [] } = result;

            if (summary) {
                await agentCtx.sendMessage(summary);
            } else if (filesToSend.length === 0) {
                await agentCtx.sendMessage('✅ Запрос обработан.');
            }

            for (const file of filesToSend) {
                await agentCtx.sendFile(file);
            }

        } catch (err) {
            console.error('[EMAIL-AI]', chatId, err);
            await sendEmail(chatId, parsed.from?.text || parsed.from, parsed.subject, `Ошибка ИИ ассистента: ${err.message}`, []);
        }
    } else {
        // Direct command mode
        try {
            const result = await sessionService.executeCommand(chatId, text, 60);
            manageStore.addCommand(chatId, text, result.stdout, result.stderr, result.exitCode != null ? result.exitCode : 0);
            let reply = '';
            if (result.stdout) reply += result.stdout.slice(0, 3500);
            if (result.stderr) reply += (reply ? '\n\n' : '') + 'stderr:\n' + result.stderr.slice(0, 1500);
            if (!reply) reply = '(пустой вывод)';
            if (result.exitCode !== undefined && result.exitCode !== 0) {
                reply += `\n\n[exit ${result.exitCode}]`;
            }
            await sendEmail(chatId, parsed.from?.text || parsed.from, parsed.subject, reply, []);
        } catch (err) {
            manageStore.addCommand(chatId, text, '', err.message, -1);
            await sendEmail(chatId, parsed.from?.text || parsed.from, parsed.subject, 'Ошибка выполнения: ' + err.message, []);
        }
    }
}

async function processAllEmails() {
    console.log('\n[EMAIL-CRON-TICK] 📬 Starting poll cycle');
    console.log(`[EMAIL-CRON-TICK] ⏰ Time: ${new Date().toISOString()}`);
    
    const chatIds = Object.keys(manageStore.getAllStates() || {});
    console.log(`[EMAIL-CRON-TICK] 📊 Found ${chatIds.length} chats with potential email configs`);
    
    let totalProcessed = 0;
    let totalErrors = 0;
    
    for (const chatId of chatIds) {
        const data = manageStore.getState(chatId);
        if (!data || !data.email) {
            console.log(`[EMAIL-CRON-TICK] ⏭️  Chat ${chatId}: no email config, skipping`);
            continue;
        }

        // Проверяем активность (если поле не установлено - считаем активным для обратной совместимости)
        if (data.email.active === false) {
            console.log(`[EMAIL-CRON-TICK] ⏸️  Chat ${chatId}: email disabled, skipping`);
            continue;
        }

        const pollMin = data.email.pollIntervalMinutes || 5;
        const lastPoll = data.email.lastPollTime || 0;
        const timeSinceLastPoll = Math.floor((Date.now() - lastPoll) / 1000);
        
        console.log(`[EMAIL-CRON-TICK] 📧 Chat ${chatId}: last poll ${timeSinceLastPoll}s ago, interval ${pollMin}min`);
        
        if (Date.now() - lastPoll < pollMin * 60 * 1000) {
            console.log(`[EMAIL-CRON-TICK] ⏳ Chat ${chatId}: waiting for ${pollMin}min interval`);
            manageStore.addCronLog(chatId, {
                type: 'email-polling',
                status: 'skipped',
                reason: `wait ${pollMin} min`,
                pollInterval: pollMin
            });
            continue;
        }

        console.log(`[EMAIL-CRON-TICK] 🔍 Chat ${chatId}: starting poll...`);
        manageStore.addCronLog(chatId, {
            type: 'email-polling',
            status: 'started',
            pollInterval: pollMin
        });

        const config = data.email;
        if (!config.imapHost || !config.imapUser || !config.imapPass) {
            console.log(`[EMAIL-CRON-TICK] ⚠️  Chat ${chatId}: missing IMAP config`);
            manageStore.addCronLog(chatId, {
                type: 'email-polling',
                status: 'skipped',
                reason: 'missing IMAP config',
                pollInterval: pollMin
            });
            data.email.lastPollTime = Date.now();
            manageStore.persist(chatId);
            continue;
        }

        console.log(`[EMAIL-CRON-TICK] 🔌 Chat ${chatId}: connecting to ${config.imapHost}:${config.imapPort || 993}...`);

        const imapConfig = {
            imap: {
                user: config.imapUser,
                password: config.imapPass,
                host: config.imapHost,
                port: config.imapPort || 993,
                tls: true,
                authTimeout: 3000
            }
        };

        let connection;
        let processedCount = 0;
        try {
            connection = await Imap.connect(imapConfig);
            console.log(`[EMAIL-CRON-TICK] ✅ Chat ${chatId}: connected to IMAP`);
            
            await connection.openBox('INBOX');
            console.log(`[EMAIL-CRON-TICK] 📂 Chat ${chatId}: INBOX opened`);

            const searchCriteria = ['UNSEEN'];
            const fetchOptions = { bodies: '', struct: true };
            const messages = await connection.search(searchCriteria, fetchOptions);

            console.log(`[EMAIL-CRON-TICK] 📨 Chat ${chatId}: found ${messages.length} unread messages`);

            for (const message of messages) {
                const uid = message.attributes.uid;
                try {
                    // imap-simple с bodies: '' возвращает данные в message.parts[0].body
                    const msgData = message.parts && message.parts[0] ? message.parts[0].body : null;
                    if (!msgData) {
                        console.log(`[EMAIL-CRON-TICK] ⚠️  Chat ${chatId}: no data in message UID ${uid}`);
                        continue;
                    }
                    const parsed = await simpleParser(msgData);

                    console.log(`[EMAIL-CRON-TICK] 📬 Chat ${chatId}: processing "${parsed.subject}" from ${parsed.from?.text || parsed.from}`);

                    // Пропускаем пустые письма
                    if (!parsed.text?.trim()) {
                        console.log(`[EMAIL-CRON-TICK] 📭 Chat ${chatId}: empty message, skipping`);
                        continue;
                    }

                    // Пропускаем собственные ответы
                    if (isOwnReply(parsed, config)) {
                        console.log(`[EMAIL-CRON-TICK] 🔄 Chat ${chatId}: own reply, skipping`);
                        await connection.addFlags(uid, '\\Seen');
                        continue;
                    }

                    await processEmail(chatId, parsed);
                    await connection.addFlags(uid, '\\Seen');
                    processedCount++;
                    console.log(`[EMAIL-CRON-TICK] ✅ Chat ${chatId}: message processed and marked as read`);

                } catch (parseErr) {
                    console.error(`[EMAIL-CRON-TICK] ❌ Chat ${chatId}: parse error UID ${uid}: ${parseErr.message}`);
                    totalErrors++;
                    continue;
                }
            }

            manageStore.addCronLog(chatId, {
                type: 'email-polling',
                status: 'success',
                processedCount,
                pollInterval: pollMin
            });
            
            totalProcessed += processedCount;
            console.log(`[EMAIL-CRON-TICK] ✅ Chat ${chatId}: poll complete, ${processedCount} messages processed`);

        } catch (e) {
            console.error(`[EMAIL-CRON-TICK] ❌ Chat ${chatId}: IMAP error: ${e.message}`);
            totalErrors++;
            manageStore.addCronLog(chatId, {
                type: 'email-polling',
                status: 'error',
                error: e.message,
                pollInterval: pollMin
            });
        } finally {
            if (connection) {
                connection.end();
                console.log(`[EMAIL-CRON-TICK] 🔌 Chat ${chatId}: connection closed`);
            }
        }
        data.email.lastPollTime = Date.now();
        manageStore.persist(chatId);
    }
    
    console.log(`\n[EMAIL-CRON-TICK] 📊 Poll cycle complete: ${totalProcessed} messages processed, ${totalErrors} errors`);
    
    // Проверяем, остались ли активные конфигурации
    if (!manageStore.hasAnyEmailActive()) {
        stopEmailCron();
        console.log('[EMAIL-CRON-TICK] ⏹️  No more active emails, cron stopped');
    }
}

async function processSingleEmail(chatId, force = true) {
    console.log(`[MANUAL-POLL] Starting for chatId: ${chatId}, force: ${force}`);
    const data = manageStore.getState(chatId);
    if (!data || !data.email) {
        manageStore.addCronLog(chatId, { type: 'email-polling-manual', status: 'skipped', reason: 'no email config' });
        return { success: false, reason: 'no email config' };
    }

    const pollMin = data.email.pollIntervalMinutes || 5;
    const lastPoll = data.email.lastPollTime || 0;
    const type = force ? 'email-polling-manual' : 'email-polling';

    if (!force && Date.now() - lastPoll < pollMin * 60 * 1000) {
        manageStore.addCronLog(chatId, {
            type,
            status: 'skipped',
            reason: `wait ${pollMin} min`,
            pollInterval: pollMin
        });
        return { success: true, skipped: true };
    }

    manageStore.addCronLog(chatId, {
        type,
        status: 'started',
        pollInterval: pollMin
    });

    const config = data.email;
    if (!config.imapHost || !config.imapUser || !config.imapPass) {
        manageStore.addCronLog(chatId, {
            type,
            status: 'skipped',
            reason: 'missing IMAP config',
            pollInterval: pollMin
        });
        data.email.lastPollTime = Date.now();
        manageStore.persist(chatId);
        return { success: false, reason: 'missing IMAP config' };
    }

    const imapConfig = {
        imap: {
            user: config.imapUser,
            password: config.imapPass,
            host: config.imapHost,
            port: config.imapPort || 993,
            tls: true,
            authTimeout: 3000
        }
    };

    let connection;
    let processedCount = 0;
    try {
        connection = await Imap.connect(imapConfig);
        await connection.openBox('INBOX');

        const searchCriteria = ['UNSEEN'];
        const fetchOptions = { bodies: '', struct: true };
        const messages = await connection.search(searchCriteria, fetchOptions);

        console.log(`[EMAIL-UNSEEN-FOUND] ${messages.length} непрочитанных писем в ящике`);        for (const message of messages) {
            const uid = message.attributes.uid;
            try {
                // imap-simple с bodies: '' возвращает данные в message.parts[0].body
                const msgData = message.parts && message.parts[0] ? message.parts[0].body : null;
                if (!msgData) {
                    console.log('[EMAIL-NO-DATA]', chatId, uid, 'parts:', JSON.stringify(Object.keys(message)));
                    continue;
                }
                const parsed = await simpleParser(msgData);

                console.log('[EMAIL-MSG-UNSEEN]', chatId, parsed.subject, parsed.from?.text || parsed.from, parsed.messageId);

                // Пропускаем пустые письма
                if (!parsed.text?.trim()) {
                    console.log('[EMAIL-EMPTY]', chatId, parsed.subject);
                    continue;
                }

                // Пропускаем собственные ответы
                if (isOwnReply(parsed, config)) {
                    console.log('[EMAIL-OWN-REPLY]', chatId, parsed.subject);
                    await connection.addFlags(uid, '\\Seen');
                    continue;
                }

                await processEmail(chatId, parsed);
                await connection.addFlags(uid, '\\Seen');
                processedCount++;

            } catch (parseErr) {
                console.error('[EMAIL-PARSE-ERR]', chatId, uid, parseErr.message);
                continue;
            }
        }

        manageStore.addCronLog(chatId, {
            type,
            status: 'success',
            processedCount,
            pollInterval: pollMin
        });

    } catch (e) {
        console.error('[EMAIL-IMAP-ERR]', chatId, e.message);
        manageStore.addCronLog(chatId, {
            type,
            status: 'error',
            error: e.message,
            pollInterval: pollMin
        });
        return { success: false, error: e.message };
    } finally {
        if (connection) connection.end();
    }

    data.email.lastPollTime = Date.now();
    manageStore.persist(chatId);
    console.log(`[MANUAL-POLL] Completed for ${chatId}: processed ${processedCount}`);
    return { success: true, processedCount };
}

function startEmailCron() {
    console.log('[EMAIL-CRON] 🔄 Initializing email polling service...');
    
    if (emailCronInterval) {
        clearInterval(emailCronInterval);
        console.log('[EMAIL-CRON] Previous interval cleared');
    }
    
    // Подсчитываем активные конфигурации
    const allStates = manageStore.getAllStates() || {};
    const chatIds = Object.keys(allStates);
    let activeCount = 0;
    const activeChats = [];
    
    for (const chatId of chatIds) {
        const data = allStates[chatId];
        // active по умолчанию true, проверяем только если явно false
        if (data && data.email && data.email.active !== false) {
            activeCount++;
            activeChats.push(chatId);
        }
    }
    
    console.log(`[EMAIL-CRON] 📊 Found ${chatIds.length} total chats, ${activeCount} with active email configs`);
    
    if (!manageStore.hasAnyEmailActive()) {
        console.log('[EMAIL-CRON] ⏸️  No active email configurations found');
        console.log('[EMAIL-CRON] 💡 Email polling will start automatically when you configure email in UI');
        return { started: false, reason: 'no_active_configs', totalChats: chatIds.length };
    }
    
    emailCronInterval = setInterval(processAllEmails, 60 * 1000); // every minute
    console.log(`[EMAIL-CRON] ✅ Cron started successfully`);
    console.log(`[EMAIL-CRON] ⏱️  Interval: 60 seconds`);
    console.log(`[EMAIL-CRON] 📧 Active chats: ${activeChats.join(', ')}`);
    
    // Запускаем первый цикл опроса через 5 секунд после старта
    console.log('[EMAIL-CRON] 🚀 First poll scheduled in 5 seconds...');
    setTimeout(() => {
        console.log('[EMAIL-CRON] 🔔 Triggering initial poll...');
        processAllEmails();
    }, 5000);
    
    return { started: true, activeConfigs: activeCount, activeChats };
}

function stopEmailCron() {
    if (emailCronInterval) {
        clearInterval(emailCronInterval);
        emailCronInterval = null;
    }
}

module.exports = {
    processAllEmails,
    processSingleEmail,
    startEmailCron,
    stopEmailCron
};
