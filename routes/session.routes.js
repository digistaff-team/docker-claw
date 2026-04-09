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
    let session = sessionService.getSession(chat_id);

    const dockerService = require('../services/docker.service');
    const storageService = require('../services/storage.service');
    const { getDatabaseInfo } = require('../services/postgres.service');

    // Если сессии нет в памяти — ищем контейнер в Docker
    if (!session) {
        const containerName = `sandbox-user-${chat_id}`;
        const containerId = await dockerService.getContainerIdByName(containerName);

        if (containerId) {
            // Контейнер существует (может быть остановлен)
            const status = await dockerService.getContainerStatus(containerId);
            const isRunning = status === 'running';
            const dataDir = storageService.getDataDir(chat_id);

            let dbInfo = null;
            try {
                dbInfo = await getDatabaseInfo(chat_id);
            } catch (e) {
                // База может не существовать
            }

            // Получаем возраст контейнера из Docker
            let createdAt = null;
            try {
                const { exec } = require('child_process');
                createdAt = await new Promise((resolve) => {
                    exec(`docker inspect -f '{{.Created}}' ${containerId}`, (err, stdout) => {
                        resolve(err ? null : stdout.trim());
                    });
                });
            } catch (e) {
                // ignore
            }

            return res.json({
                exists: true,
                chat_id,
                sessionId: null,
                containerId: containerId.substring(0, 12),
                dataDir,
                created: createdAt || null,
                lastActivity: null,
                age: null,
                idle: null,
                commandCount: null,
                containerAlive: isRunning,
                containerStatus: status,
                database: dbInfo,
                recovered: false,
                sessionInMemory: false
            });
        }

        // Нет ни сессии, ни контейнера — проверяем есть ли файлы на диске
        const dataDir = storageService.getDataDir(chat_id);
        const fs = require('fs').promises;
        let hasDataDir = false;
        try {
            await fs.access(dataDir);
            hasDataDir = true;
        } catch (e) {
            // ignore
        }

        return res.json({
            exists: false,
            chat_id,
            hasFilesOnDisk: hasDataDir,
            message: hasDataDir
                ? 'Файлы пользователя сохранены на диске. Контейнер будет создан при первом обращении.'
                : 'Нет данных о пользователе'
        });
    }

    // Сессия есть в памяти
    const isAlive = await dockerService.isContainerAlive(session.containerId);
    let status = 'unknown';
    try {
        status = await dockerService.getContainerStatus(session.containerId);
    } catch (e) {
        // ignore
    }

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
        containerStatus: status,
        database: session.database,
        recovered: session.recovered || false,
        sessionInMemory: true
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
