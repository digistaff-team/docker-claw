const express = require('express');
const router = express.Router();
const sessionService = require('../services/session.service');
const config = require('../config');

// Выполнить команду
router.post('/', async (req, res) => {
    const { command, timeout = 30, chat_id } = req.body;
    
    if (!command) {
        return res.status(400).json({ error: 'Command is required' });
    }
    
    if (!chat_id) {
        return res.status(400).json({ error: 'chat_id is required' });
    }
    
    const actualTimeout = Math.min(timeout, config.MAX_COMMAND_TIMEOUT);
    
    try {
        const result = await sessionService.executeCommand(chat_id, command, actualTimeout);
        res.json(result);
    } catch (error) {
        res.status(500).json({
            error: 'Execution failed',
            details: error.message
        });
    }
});

module.exports = router;
