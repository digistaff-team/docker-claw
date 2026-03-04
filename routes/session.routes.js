const express = require('express');
const router = express.Router();
const sessionService = require('../services/session.service');

// Статус инициализации контейнера (для поллинга с фронта)
// ВАЖНО: должен быть выше /:chat_id, иначе Express перехватит его как chat_id
router.get('/init-status/:chat_id', (req, res) => {
    const { chat_id } = req.params;
    const status = sessionService.getInitStatus(chat_id);
    res.json({ chat_id, ...status });
});

// Информация о сессии
router.get('/:chat_id', async (req, res) => {
    const { chat_id } = req.params;
    const session = sessionService.getSession(chat_id);
    
    if (!session) {
        return res.json({ exists: false, chat_id });
    }
    
    const dockerService = require('../services/docker.service');
    const isAlive = await dockerService.isContainerAlive(session.containerId);
    
    res.json({
        exists: true,
        chat_id,
        sessionId: session.sessionId,
        containerId: session.containerId.substring(0, 12),
        dataDir: session.dataDir,
        created: new Date(session.created).toISOString(),
        lastActivity: new Date(session.lastActivity).toISOString(),
        age: Math.round((Date.now() - session.created) / 1000) + 's',
        idle: Math.round((Date.now() - session.lastActivity) / 1000) + 's',
        commandCount: session.commandCount,
        containerAlive: isAlive,
        database: session.database,
        recovered: session.recovered || false
    });
});

// Создать сессию
router.post('/create', async (req, res) => {
    const { chat_id, allowNetwork, force } = req.body;
    
    if (!chat_id) {
        return res.status(400).json({ error: 'chat_id is required' });
    }
    
    try {
        if (force) {
            await sessionService.destroySession(chat_id);
        }
        
        const session = await sessionService.getOrCreateSession(chat_id, { allowNetwork });
        
        res.json({
            status: 'created',
            chat_id,
            sessionId: session.sessionId,
            containerId: session.containerId.substring(0, 12),
            database: session.database,
            message: 'Персональное окружение готово'
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Удалить сессию
router.post('/destroy', async (req, res) => {
    const { chat_id } = req.body;
    
    if (!chat_id) {
        return res.status(400).json({ error: 'chat_id is required' });
    }
    
    await sessionService.destroySession(chat_id);
    
    res.json({
        status: 'destroyed',
        chat_id,
        message: 'Окружение и база данных удалены'
    });
});

// Сбросить файлы
router.post('/reset', async (req, res) => {
    const { chat_id } = req.body;
    
    if (!chat_id) {
        return res.status(400).json({ error: 'chat_id is required' });
    }
    
    const session = sessionService.getSession(chat_id);
    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }
    
    const dockerService = require('../services/docker.service');
    await dockerService.resetContainerWorkspace(session.containerId);
    session.commandCount = 0;
    
    res.json({
        status: 'reset',
        chat_id,
        message: 'Файлы очищены (база данных сохранена)'
    });
});

// Список всех сессий
router.get('/', (req, res) => {
    const sessions = sessionService.getAllSessions().map(s => ({
        chatId: s.chatId,
        sessionId: s.sessionId,
        containerId: s.containerId.substring(0, 12),
        dataDir: s.dataDir,
        created: new Date(s.created).toISOString(),
        lastActivity: new Date(s.lastActivity).toISOString(),
        commandCount: s.commandCount,
        hasDatabase: !!s.database
    }));
    
    res.json({ count: sessions.length, sessions });
});

module.exports = router;
