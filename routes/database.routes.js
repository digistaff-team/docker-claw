const express = require('express');
const router = express.Router();
const postgresService = require('../services/postgres.service');

// Информация о базе данных
router.get('/:chat_id', async (req, res) => {
    const { chat_id } = req.params;
    
    try {
        const dbInfo = await postgresService.getDatabaseInfo(chat_id);
        res.json(dbInfo);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Проверить существование БД
router.get('/:chat_id/exists', async (req, res) => {
    const { chat_id } = req.params;
    
    try {
        const exists = await postgresService.databaseExists(chat_id);
        res.json({ exists, chat_id });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
