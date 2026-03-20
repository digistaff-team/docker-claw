const express = require('express');
const router = express.Router();

const sessionRoutes = require('./session.routes');
const executeRoutes = require('./execute.routes');
const filesRoutes = require('./files.routes');
const databaseRoutes = require('./database.routes');
const manageRoutes = require('../manage/routes');
const plansRoutes = require('./plans.routes');
const appsRoutes = require('./apps.routes');
const contentRoutes = require('./content.routes');
const authRoutes = require('./auth.routes');

router.use('/session', sessionRoutes);
router.use('/execute', executeRoutes);
router.use('/files', filesRoutes);
router.use('/database', databaseRoutes);
router.use('/manage', manageRoutes);
router.use('/plans', plansRoutes);
router.use('/apps', appsRoutes);
router.use('/content', contentRoutes);
router.use('/auth', authRoutes);

// Health check
router.get('/health', (req, res) => {
    const sessionService = require('../services/session.service');
    
    res.json({
        status: 'ok',
        message: 'AI Bash Executor API v3 - Modular',
        activeSessions: sessionService.sessions.size,
        features: [
            'persistent-storage',
            'auto-recovery',
            'postgresql-per-user',
            'ssl-connection',
            'automatic-backups'
        ]
    });
});

module.exports = router;
