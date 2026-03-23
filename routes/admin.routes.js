/**
 * Admin Routes - API для управления пользовательскими контейнерами
 * Требует авторизации через ADMIN_PASSWORD
 */
const express = require('express');
const router = express.Router();
const dockerService = require('../services/docker.service');
const sessionService = require('../services/session.service');

// Middleware для проверки админ-пароля
function requireAdminAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    const password = req.body.password || req.query.password || req.headers['x-admin-password'];

    // Проверка через Bearer токен
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.slice(7);
        if (token === process.env.ADMIN_PASSWORD) {
            return next();
        }
    }

    // Проверка через password параметр
    if (password && password === process.env.ADMIN_PASSWORD) {
        return next();
    }

    // Проверка через сессию админа
    if (req.session && req.session.isAdmin) {
        return next();
    }

    return res.status(401).json({ error: 'Admin authentication required' });
}

// GET /admin - редирект на страницу контейнеров
router.get('/', (req, res) => {
    res.redirect('/admin/containers');
});

// GET /admin/login - страница входа
router.get('/login', (req, res) => {
    res.sendFile(require('path').resolve(__dirname, '../public/admin/login.html'));
});

// POST /admin/login - проверка пароля
router.post('/login', (req, res) => {
    const { password } = req.body;

    if (!password) {
        return res.status(400).json({ error: 'Password is required' });
    }

    if (password === process.env.ADMIN_PASSWORD) {
        if (req.session) {
            req.session.isAdmin = true;
        }
        res.json({ success: true, message: 'Authenticated' });
    } else {
        res.status(401).json({ error: 'Invalid password' });
    }
});

// POST /admin/logout
router.post('/logout', (req, res) => {
    if (req.session) {
        req.session.isAdmin = false;
    }
    res.json({ success: true });
});

// GET /admin/containers - страница со списком контейнеров
router.get('/containers', requireAdminAuth, (req, res) => {
    res.sendFile(require('path').resolve(__dirname, '../public/admin/containers.html'));
});

// GET /admin/containers - API для получения списка контейнеров
router.get('/containers-api', requireAdminAuth, async (req, res) => {
    try {
        const containers = await dockerService.getAllUserContainers();
        res.json({ containers });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// GET /admin/stats - API статистики
router.get('/stats-api', requireAdminAuth, async (req, res) => {
    try {
        const containers = await dockerService.getAllUserContainers();
        const running = containers.filter(c => c.status === 'running').length;
        const stopped = containers.filter(c => c.status !== 'running').length;

        const sessions = sessionService.getAllSessions();

        res.json({
            totalContainers: containers.length,
            runningContainers: running,
            stoppedContainers: stopped,
            activeSessions: sessions.length,
            containers: containers.map(c => ({
                chatId: c.chatId,
                status: c.status,
                uptime: c.uptime
            }))
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// GET /admin/container/:chatId/manage - страница управления контейнером
router.get('/container/:chatId/manage', requireAdminAuth, (req, res) => {
    res.sendFile(require('path').resolve(__dirname, '../public/admin/container-manage.html'));
});

// POST /admin/container/:chatId/auth - создать сессию авторизации для пользователя
router.post('/container/:chatId/auth', requireAdminAuth, async (req, res) => {
    const { chatId } = req.params;
    
    try {
        // Получаем или создаём сессию для пользователя
        const session = await sessionService.getOrCreateSession(chatId);
        
        // Генерируем токен для авторизации
        const authToken = require('crypto').randomBytes(32).toString('hex');
        
        // Сохраняем токен в manage store для последующей проверки
        const manageStore = require('../manage/store');
        await manageStore.load();
        
        // Получаем текущее состояние из cache
        const state = manageStore.getState(chatId) || {};
        
        // Добавляем admin auth данные
        state.adminAuthToken = authToken;
        state.adminAuthExpires = Date.now() + (24 * 60 * 60 * 1000); // 24 часа
        
        // Обновляем cache напрямую
        const allStates = manageStore.getAllStates();
        allStates[chatId] = state;
        
        // Сохраняем через persist
        await manageStore.persist(chatId);
        
        res.json({
            success: true,
            chatId,
            token: authToken,
            redirectUrl: `/?admin_auth=${authToken}&chatId=${chatId}`
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// POST /admin/container/:chatId/exec - выполнить команду в контейнере (API)
router.post('/container/:chatId/exec', requireAdminAuth, async (req, res) => {
    const { chatId } = req.params;
    const { command, timeout = 30 } = req.body;

    if (!command) {
        return res.status(400).json({ error: 'Command is required' });
    }

    try {
        const containerName = `sandbox-user-${chatId}`;
        const containerId = await dockerService.getContainerIdByName(containerName);

        if (!containerId) {
            return res.status(404).json({ error: 'Container not found' });
        }

        const status = await dockerService.getContainerStatus(containerId);
        if (status !== 'running') {
            return res.status(409).json({ error: `Container is not running (status: ${status})` });
        }

        const result = await dockerService.executeInContainer(containerId, command, timeout);
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// GET /admin/container/:chatId/info - информация о контейнере
router.get('/container/:chatId/info', requireAdminAuth, async (req, res) => {
    const { chatId } = req.params;

    
    try {
        const containerName = `sandbox-user-${chatId}`;
        const containerId = await dockerService.getContainerIdByName(containerName);
        
        if (!containerId) {
            return res.status(404).json({ error: 'Container not found' });
        }
        
        const status = await dockerService.getContainerStatus(containerId);
        const session = sessionService.getSession(chatId);
        
        res.json({
            chatId,
            containerId,
            containerName,
            status,
            session: session ? {
                created: session.created,
                lastActivity: session.lastActivity,
                commandCount: session.commandCount,
                hasPython3: session.hasPython3
            } : null,
            initStatus: sessionService.getInitStatus(chatId)
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// POST /admin/container/:chatId/exec - выполнить команду в контейнере
router.post('/container/:chatId/exec', requireAdminAuth, async (req, res) => {
    const { chatId } = req.params;
    const { command, timeout = 30 } = req.body;
    
    if (!command) {
        return res.status(400).json({ error: 'Command is required' });
    }
    
    try {
        const containerName = `sandbox-user-${chatId}`;
        const containerId = await dockerService.getContainerIdByName(containerName);
        
        if (!containerId) {
            return res.status(404).json({ error: 'Container not found' });
        }
        
        const status = await dockerService.getContainerStatus(containerId);
        if (status !== 'running') {
            return res.status(409).json({ error: `Container is not running (status: ${status})` });
        }
        
        const result = await dockerService.executeInContainer(containerId, command, timeout);
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// POST /admin/container/:chatId/start - запустить контейнер
router.post('/container/:chatId/start', requireAdminAuth, async (req, res) => {
    const { chatId } = req.params;
    
    try {
        const containerName = `sandbox-user-${chatId}`;
        const containerId = await dockerService.getContainerIdByName(containerName);
        
        if (!containerId) {
            return res.status(404).json({ error: 'Container not found' });
        }
        
        const status = await dockerService.getContainerStatus(containerId);
        if (status === 'running') {
            return res.json({ success: true, message: 'Container already running', status });
        }
        
        await dockerService.startContainer(containerId);
        const newStatus = await dockerService.getContainerStatus(containerId);
        
        res.json({ success: true, status: newStatus });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// POST /admin/container/:chatId/stop - остановить контейнер
router.post('/container/:chatId/stop', requireAdminAuth, async (req, res) => {
    const { chatId } = req.params;
    
    try {
        const containerName = `sandbox-user-${chatId}`;
        const containerId = await dockerService.getContainerIdByName(containerName);
        
        if (!containerId) {
            return res.status(404).json({ error: 'Container not found' });
        }
        
        await dockerService.execDocker(['stop', containerId]);
        const status = await dockerService.getContainerStatus(containerId);
        
        res.json({ success: true, status });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// POST /admin/container/:chatId/restart - перезапустить контейнер
router.post('/container/:chatId/restart', requireAdminAuth, async (req, res) => {
    const { chatId } = req.params;
    
    try {
        const containerName = `sandbox-user-${chatId}`;
        const containerId = await dockerService.getContainerIdByName(containerName);
        
        if (!containerId) {
            return res.status(404).json({ error: 'Container not found' });
        }
        
        await dockerService.execDocker(['restart', containerId]);
        const status = await dockerService.getContainerStatus(containerId);
        
        res.json({ success: true, status });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// DELETE /admin/container/:chatId - удалить контейнер
router.delete('/container/:chatId', requireAdminAuth, async (req, res) => {
    const { chatId } = req.params;
    
    try {
        const containerName = `sandbox-user-${chatId}`;
        const containerId = await dockerService.getContainerIdByName(containerName);
        
        if (!containerId) {
            return res.status(404).json({ error: 'Container not found' });
        }
        
        // Сначала останавливаем
        await dockerService.execDocker(['stop', containerId]);
        // Удаляем контейнер
        await dockerService.removeContainer(containerId);
        
        // Удаляем сессию из памяти
        sessionService.removeSession(chatId);
        
        res.json({ success: true, message: 'Container removed' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// GET /admin/container/:chatId/logs - логи контейнера
router.get('/container/:chatId/logs', requireAdminAuth, async (req, res) => {
    const { chatId } = req.params;
    const { lines = 100 } = req.query;
    
    try {
        const containerName = `sandbox-user-${chatId}`;
        const containerId = await dockerService.getContainerIdByName(containerName);
        
        if (!containerId) {
            return res.status(404).json({ error: 'Container not found' });
        }
        
        const result = await dockerService.execDocker(['logs', '--tail', String(lines), containerId]);
        res.json({ 
            stdout: result.stdout || '', 
            stderr: result.stderr || '' 
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// GET /admin/stats - общая статистика
router.get('/stats', requireAdminAuth, async (req, res) => {
    try {
        const containers = await dockerService.getAllUserContainers();
        const running = containers.filter(c => c.status === 'running').length;
        const stopped = containers.filter(c => c.status !== 'running').length;
        
        const sessions = sessionService.getAllSessions();
        
        res.json({
            totalContainers: containers.length,
            runningContainers: running,
            stoppedContainers: stopped,
            activeSessions: sessions.length,
            containers: containers.map(c => ({
                chatId: c.chatId,
                status: c.status,
                uptime: c.uptime
            }))
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;
