// routes/webhook.routes.js
const express = require('express');
const router = express.Router();
const manageStore = require('../manage/store');
const sessionService = require('../services/session.service');
const contextHelper = require('../manage/context');
const { executeAgentLoop } = require('../manage/telegram/agentLoop');
const { getSystemInstruction } = require('../manage/prompts');
const { enqueue } = require('../manage/agentQueue');
const { TOOLS_CHAT, TOOLS_WORKSPACE, TOOLS_TERMINAL } = require('../manage/telegram/tools');

// Хранилище async jobs (in-memory)
const jobs = new Map(); // jobId -> { status, result, createdAt }

// Middleware: авторизация по aiAuthToken
function authWebhook(req, res, next) {
    const chatId = req.params.chatId;
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
    
    const data = manageStore.getState(chatId);
    if (!data) return res.status(404).json({ ok: false, error: 'chatId not found' });
    if (!data.aiAuthToken) return res.status(403).json({ ok: false, error: 'AI not configured' });
    if (data.aiAuthToken !== token) return res.status(401).json({ ok: false, error: 'Invalid token' });
    if (data.aiBlocked) return res.status(402).json({ ok: false, error: data.aiBlockReason || 'Account blocked' });
    
    req.chatData = data;
    next();
}

// Создать WebhookAgentCtx
function createWebhookAgentCtx(chatId, channel) {
    const messages = [];  // Копим сообщения для возврата
    return {
        channel,
        chatId,
        outgoing: messages,
        sendMessage: async (text) => { messages.push({ type: 'text', content: text }); },
        sendFile: async (filePath, caption) => { messages.push({ type: 'file', path: filePath, caption }); },
        confirm: async () => true
    };
}

// Основная обработка
async function runAgent(chatId, data, message, mode, channel) {
    const toolsMap = { CHAT: TOOLS_CHAT, WORKSPACE: TOOLS_WORKSPACE, TERMINAL: TOOLS_TERMINAL };
    const tools = toolsMap[mode] || TOOLS_TERMINAL;
    
    console.log(`[WEBHOOK-CALL] chatId=${chatId} channel=${channel} mode=${mode} msg="${message.slice(0, 80).replace(/\n/g, ' ')}"`);

    const agentCtx = createWebhookAgentCtx(chatId, channel);
    const structuredContext = await contextHelper.buildFullContextStructured(chatId);
    const systemPrompt = getSystemInstruction(mode, structuredContext, channel);
    
    const historyMessages = manageStore.getAIMessages(chatId, channel, 20);
    const messages = [
        { role: 'system', content: systemPrompt },
        ...historyMessages.map(m => ({
            role: m.role,
            content: m.content || '',
            tool_calls: m.tool_calls,
            tool_call_id: m.tool_call_id
        })),
        { role: 'user', content: message }
    ];
    
    const result = await executeAgentLoop(chatId, data, messages, tools, agentCtx, 10);
    
    // Сохраняем историю
    manageStore.setAIMessages(chatId, channel, messages.filter(m => m.role !== 'system'));

    const reply = result.html_report || result.summary || '';
    console.log(`[WEBHOOK-DONE] chatId=${chatId} channel=${channel} reply="${reply.slice(0, 100).replace(/\n/g, ' ')}"`);

    return {
        summary: result.summary || '',
        reply,
        files: result.filesToSend || [],
        outgoing: agentCtx.outgoing
    };
}

// POST /{chatId}/webhook — синхронный и асинхронный режим
router.post('/:chatId/webhook', authWebhook, async (req, res) => {
    const { chatId } = req.params;
    const { message, mode = 'TERMINAL', channel = 'webhook', sync = true } = req.body;
    
    if (!message) return res.status(400).json({ ok: false, error: 'message is required' });
    
    // Вложенный вызов: приложение пользователя делает запрос изнутри уже работающего агента.
    // Без флага nested=true возникнет deadlock — очередь per chatId заблокирована внешним агентом.
    const isNested = req.headers['x-agent-nested'] === '1';

    if (sync) {
        // Синхронный: ждём результата
        try {
            const result = await enqueue(chatId, () => runAgent(chatId, req.chatData, message, mode, channel), { nested: isNested });
            return res.json({ ok: true, chatId, ...result });
        } catch (e) {
            return res.status(500).json({ ok: false, error: e.message });
        }
    } else {
        // Асинхронный: во��вращаем jobId немедленно
        const jobId = `job_${chatId}_${Date.now()}`;
        jobs.set(jobId, { status: 'pending', createdAt: Date.now() });
        
        enqueue(chatId, () => runAgent(chatId, req.chatData, message, mode, channel))
            .then(result => jobs.set(jobId, { status: 'done', result, completedAt: Date.now() }))
            .catch(e => jobs.set(jobId, { status: 'error', error: e.message }));
        
        return res.json({
            ok: true,
            jobId,
            statusUrl: `/${chatId}/webhook/status/${jobId}`
        });
    }
});

// GET /{chatId}/webhook/history?channel=app:my-app — история конкретного канала
router.get('/:chatId/webhook/history', authWebhook, (req, res) => {
    const channel = req.query.channel || 'webhook';
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const history = manageStore.getAIMessages(req.params.chatId, channel, limit);
    res.json({ ok: true, channel, count: history.length, messages: history });
});

// GET /{chatId}/webhook/status/{jobId} — статус async job
router.get('/:chatId/webhook/status/:jobId', authWebhook, (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ ok: false, error: 'Job not found' });
    res.json({ ok: true, ...job });
});

// POST /{chatId}/internal_cron — внутренний webhook для cron-задач
router.post('/:chatId/internal_cron', authWebhook, async (req, res) => {
    const { chatId } = req.params;
    const { prompt } = req.body;
    
    if (!prompt) return res.status(400).json({ ok: false, error: 'prompt is required' });
    
    // Запускаем задачу асинхронно, так как cron не ждет ответа
    const jobId = `cron_${chatId}_${Date.now()}`;
    jobs.set(jobId, { status: 'pending', createdAt: Date.now() });
    
    // Формируем специальное сообщение для агента
    const message = `[СИСТЕМНОЕ СООБЩЕНИЕ: СРАБОТАЛ CRON]\nЭто запланированная задача. Выполни ее и отправь результат пользователю.\n\nЗадача: ${prompt}`;
    
    enqueue(chatId, () => runAgent(chatId, req.chatData, message, 'TERMINAL', 'cron'))
        .then(result => jobs.set(jobId, { status: 'done', result, completedAt: Date.now() }))
        .catch(e => jobs.set(jobId, { status: 'error', error: e.message }));
    
    return res.json({ ok: true, message: 'Cron job accepted', jobId });
});

module.exports = router;
