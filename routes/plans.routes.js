const express = require('express');
const router = express.Router();
const planService = require('../services/plan.service');

// Middleware для авторизации
function authMiddleware(req, res, next) {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ success: false, error: 'Authorization required' });
    }
    
    const chatId = authHeader.substring(7); // Убираем 'Bearer '
    
    if (!chatId) {
        return res.status(401).json({ success: false, error: 'Invalid authorization token' });
    }
    
    req.user = { chatId };
    next();
}

// Применяем middleware ко всем роутам
router.use(authMiddleware);

// Получить список всех планов
router.get('/', async (req, res) => {
    try {
        const chatId = req.user.chatId;
        const plans = await planService.listActivePlans(chatId);
        res.json({ success: true, plans });
    } catch (error) {
        console.error('Error fetching plans:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Получить все планы с полным содержимым за один запрос (для UI-карточек)
router.get('/summary', async (req, res) => {
    try {
        const chatId = req.user.chatId;
        const plans  = await planService.getPlansSummary(chatId);
        res.json({ success: true, plans });
    } catch (error) {
        console.error('Error fetching plans summary:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Удалить все завершённые (DONE) и приостановленные (PAUSED) планы
// ВАЖНО: Этот роут должен быть ПЕРЕД параметрическими роутами (/:planId)
router.delete('/completed', async (req, res) => {
    try {
        const chatId = req.user.chatId;
        const deletedCount = await planService.cleanupCompletedPlans(chatId);
        console.log(`[PLANS] Cleaned up ${deletedCount} completed/paused plans for ${chatId}`);
        res.json({ success: true, deletedCount });
    } catch (error) {
        console.error('Error cleaning up completed plans:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Получить содержимое конкретного плана (параметрический роут)
router.get('/:planId', async (req, res) => {
    try {
        const chatId = req.user.chatId;
        const planId = req.params.planId;
        const content = await planService.readPlan(chatId, planId);
        res.json({ success: true, content });
    } catch (error) {
        console.error('Error fetching plan:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Удалить план (параметрический роут)
router.delete('/:planId', async (req, res) => {
    try {
        const chatId = req.user.chatId;
        const planId = req.params.planId;
        await planService.deletePlan(chatId, planId);
        res.json({ success: true });
    } catch (error) {
        console.error('Error deleting plan:', error);
        const status = error.message.includes('not found') ? 404 : 500;
        res.status(status).json({ success: false, error: error.message });
    }
});

module.exports = router;
