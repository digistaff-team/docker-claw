const express = require('express');
const router = express.Router();
const { Telegraf } = require('telegraf');

const contentMvpService = require('../services/contentMvp.service');
const vkMvpService = require('../services/vkMvp.service');
const okMvpService = require('../services/okMvp.service');
const pinterestMvpService = require('../services/pinterestMvp.service');
const telegramRunner = require('../manage/telegram/runner');
const manageStore = require('../manage/store');

function normalizeChatId(chatId) {
  return String(chatId || '').trim();
}

function getBotFacade(chatId) {
  const entry = telegramRunner.bots.get(normalizeChatId(chatId));
  if (!entry || !entry.bot || !entry.bot.telegram) return null;
  return { telegram: entry.bot.telegram };
}

function getBotFacadeFromStoredToken(chatId) {
  const state = manageStore.getState(normalizeChatId(chatId));
  const token = String(state?.token || '').trim();
  if (!token) return null;
  return { telegram: new Telegraf(token).telegram };
}

function resolveBotFacade(chatId) {
  return getBotFacade(chatId) || getBotFacadeFromStoredToken(chatId);
}

function toPositiveInt(value, fallback) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

router.post('/run-now', async (req, res) => {
  const chatId = normalizeChatId(req.body.chat_id);
  const reason = String(req.body.reason || 'api').trim() || 'api';
  if (!chatId) {
    return res.status(400).json({ error: 'chat_id is required' });
  }
  const bot = resolveBotFacade(chatId);
  if (!bot) {
    return res.status(409).json({ error: 'Telegram bot is not running for chat_id' });
  }
  try {
    const result = await contentMvpService.runNow(chatId, bot, reason);
    return res.json(result);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

router.get('/topics', async (req, res) => {
  const chatId = normalizeChatId(req.query.chat_id);
  if (!chatId) {
    return res.status(400).json({ error: 'chat_id is required' });
  }

  const status = req.query.status ? String(req.query.status).trim().toLowerCase() : null;
  const limit = Math.min(toPositiveInt(req.query.limit, 100), 500);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

  try {
    const result = await contentMvpService.listTopics(chatId, { status, limit, offset });
    return res.json(result);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

router.post('/topics', async (req, res) => {
  const chatId = normalizeChatId(req.body.chat_id);
  if (!chatId) {
    return res.status(400).json({ error: 'chat_id is required' });
  }

  try {
    const topic = await contentMvpService.createTopic(chatId, req.body || {});
    return res.status(201).json({ topic });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
});

router.patch('/topics/:id', async (req, res) => {
  const chatId = normalizeChatId(req.body.chat_id);
  const topicId = parseInt(req.params.id, 10);
  if (!chatId) {
    return res.status(400).json({ error: 'chat_id is required' });
  }
  if (!Number.isFinite(topicId) || topicId <= 0) {
    return res.status(400).json({ error: 'invalid topic id' });
  }

  try {
    const topic = await contentMvpService.updateTopic(chatId, topicId, req.body || {});
    return res.json({ topic });
  } catch (e) {
    return res.status(/not found/i.test(e.message) ? 404 : 400).json({ error: e.message });
  }
});

router.delete('/topics/:id', async (req, res) => {
  const chatId = normalizeChatId(req.body.chat_id || req.query.chat_id);
  const topicId = parseInt(req.params.id, 10);
  if (!chatId) {
    return res.status(400).json({ error: 'chat_id is required' });
  }
  if (!Number.isFinite(topicId) || topicId <= 0) {
    return res.status(400).json({ error: 'invalid topic id' });
  }

  try {
    const topic = await contentMvpService.deleteTopic(chatId, topicId);
    return res.json({ topic });
  } catch (e) {
    return res.status(/not found/i.test(e.message) ? 404 : 400).json({ error: e.message });
  }
});

router.get('/materials', async (req, res) => {
  const chatId = normalizeChatId(req.query.chat_id);
  if (!chatId) {
    return res.status(400).json({ error: 'chat_id is required' });
  }

  const limit = Math.min(toPositiveInt(req.query.limit, 100), 500);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

  try {
    const result = await contentMvpService.listMaterials(chatId, { limit, offset });
    return res.json(result);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

router.post('/materials', async (req, res) => {
  const chatId = normalizeChatId(req.body.chat_id);
  if (!chatId) {
    return res.status(400).json({ error: 'chat_id is required' });
  }

  try {
    const material = await contentMvpService.createMaterial(chatId, req.body || {});
    return res.status(201).json({ material });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
});

router.patch('/materials/:id', async (req, res) => {
  const chatId = normalizeChatId(req.body.chat_id);
  const materialId = parseInt(req.params.id, 10);
  if (!chatId) {
    return res.status(400).json({ error: 'chat_id is required' });
  }
  if (!Number.isFinite(materialId) || materialId <= 0) {
    return res.status(400).json({ error: 'invalid material id' });
  }

  try {
    const material = await contentMvpService.updateMaterial(chatId, materialId, req.body || {});
    return res.json({ material });
  } catch (e) {
    return res.status(/not found/i.test(e.message) ? 404 : 400).json({ error: e.message });
  }
});

router.delete('/materials/:id', async (req, res) => {
  const chatId = normalizeChatId(req.body.chat_id || req.query.chat_id);
  const materialId = parseInt(req.params.id, 10);
  if (!chatId) {
    return res.status(400).json({ error: 'chat_id is required' });
  }
  if (!Number.isFinite(materialId) || materialId <= 0) {
    return res.status(400).json({ error: 'invalid material id' });
  }

  try {
    const material = await contentMvpService.deleteMaterial(chatId, materialId);
    return res.json({ material });
  } catch (e) {
    return res.status(/not found/i.test(e.message) ? 404 : 400).json({ error: e.message });
  }
});

router.post('/import-google-sheet/preview', async (req, res) => {
  const chatId = normalizeChatId(req.body.chat_id);
  if (!chatId) {
    return res.status(400).json({ error: 'chat_id is required' });
  }

  try {
    const result = await contentMvpService.previewContentImport(chatId, req.body || {});
    return res.json(result);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
});

router.post('/import-google-sheet', async (req, res) => {
  const chatId = normalizeChatId(req.body.chat_id);
  if (!chatId) {
    return res.status(400).json({ error: 'chat_id is required' });
  }

  try {
    const result = await contentMvpService.importContentFromGoogleSheet(chatId, req.body || {});
    return res.json(result);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
});

// === Pinterest Boards Import from Google Sheets ===

router.post('/import-pinterest-boards/preview', async (req, res) => {
  const chatId = normalizeChatId(req.body.chat_id);
  if (!chatId) return res.status(400).json({ error: 'chat_id is required' });

  try {
    const result = await contentMvpService.previewPinterestBoardsImport(chatId, req.body || {});
    return res.json(result);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
});

router.post('/import-pinterest-boards', async (req, res) => {
  const chatId = normalizeChatId(req.body.chat_id);
  if (!chatId) return res.status(400).json({ error: 'chat_id is required' });

  try {
    const result = await contentMvpService.importPinterestBoardsFromSheet(chatId, req.body || {});
    return res.json(result);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
});

// POST /api/content/pinterest/run-now — генерация Pinterest-пина
router.post('/pinterest/run-now', async (req, res) => {
  const chatId = normalizeChatId(req.body.chat_id);
  const reason = String(req.body.reason || 'api').trim() || 'api';
  if (!chatId) {
    return res.status(400).json({ error: 'chat_id is required' });
  }
  const bot = resolveBotFacade(chatId);
  if (!bot) {
    return res.status(409).json({ error: 'Telegram bot is not running for chat_id' });
  }
  try {
    const result = await pinterestMvpService.runNow(chatId, bot, reason);
    return res.json(result);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

router.get('/profile', async (req, res) => {
  const chatId = normalizeChatId(req.query.chat_id);
  if (!chatId) {
    return res.status(400).json({ error: 'chat_id is required' });
  }

  try {
    const profile = await contentMvpService.getProfile(chatId);
    return res.json(profile);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

router.post('/profile', async (req, res) => {
  const chatId = normalizeChatId(req.body.chat_id);
  const files = req.body.files;
  if (!chatId) {
    return res.status(400).json({ error: 'chat_id is required' });
  }
  if (!files || typeof files !== 'object') {
    return res.status(400).json({ error: 'files is required' });
  }

  try {
    const profile = await contentMvpService.saveProfile(chatId, files);
    return res.json(profile);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
});

router.get('/jobs', async (req, res) => {
  const chatId = normalizeChatId(req.query.chat_id);
  if (!chatId) {
    return res.status(400).json({ error: 'chat_id is required' });
  }
  const status = req.query.status ? String(req.query.status).trim().toLowerCase() : null;
  const limit = Math.min(toPositiveInt(req.query.limit, 50), 200);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

  try {
    const result = await contentMvpService.listJobs(chatId, { status, limit, offset });
    return res.json(result);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

router.get('/jobs/:id', async (req, res) => {
  const chatId = normalizeChatId(req.query.chat_id);
  const jobId = parseInt(req.params.id, 10);
  if (!chatId) {
    return res.status(400).json({ error: 'chat_id is required' });
  }
  if (!Number.isFinite(jobId) || jobId <= 0) {
    return res.status(400).json({ error: 'invalid job id' });
  }

  try {
    const result = await contentMvpService.getJobById(chatId, jobId);
    if (!result) return res.status(404).json({ error: 'job not found' });
    return res.json({ job: result });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

router.post('/jobs/:id/:action', async (req, res) => {
  const chatId = normalizeChatId(req.body.chat_id || req.query.chat_id);
  const jobId = parseInt(req.params.id, 10);
  const actionRaw = String(req.params.action || '').trim().toLowerCase();
  const action = actionRaw.replace(/-/g, '_');
  const allowed = new Set(['approve', 'reject', 'regen_text', 'regen_image', 'regen_video']);

  if (!chatId) {
    return res.status(400).json({ error: 'chat_id is required' });
  }
  if (!Number.isFinite(jobId) || jobId <= 0) {
    return res.status(400).json({ error: 'invalid job id' });
  }
  if (!allowed.has(action)) {
    return res.status(400).json({ error: 'invalid action' });
  }

  const bot = resolveBotFacade(chatId);
  if (!bot) {
    return res.status(409).json({ error: 'Telegram bot is not running for chat_id' });
  }

  try {
    const result = await contentMvpService.handleModerationAction(chatId, bot, action, jobId);
    return res.json(result);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

router.get('/metrics', async (req, res) => {
  const chatId = normalizeChatId(req.query.chat_id);
  if (!chatId) {
    return res.status(400).json({ error: 'chat_id is required' });
  }
  try {
    const metrics = await contentMvpService.getMetrics(chatId);
    return res.json(metrics);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// =============================================
// VK Endpoints
// =============================================

// POST /api/content/vk/run-now — генерация VK-поста
router.post('/vk/run-now', async (req, res) => {
  const chatId = normalizeChatId(req.body.chat_id);
  const reason = String(req.body.reason || 'api').trim() || 'api';
  if (!chatId) {
    return res.status(400).json({ error: 'chat_id is required' });
  }
  const bot = resolveBotFacade(chatId);
  if (!bot) {
    return res.status(409).json({ error: 'Telegram bot is not running for chat_id' });
  }
  try {
    const result = await vkMvpService.runNow(chatId, bot, reason);
    return res.json(result);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// GET /api/content/vk/jobs — список VK-задач
router.get('/vk/jobs', async (req, res) => {
  const chatId = normalizeChatId(req.query.chat_id);
  if (!chatId) {
    return res.status(400).json({ error: 'chat_id is required' });
  }
  const status = req.query.status ? String(req.query.status).trim().toLowerCase() : null;
  const limit = Math.min(toPositiveInt(req.query.limit, 50), 200);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

  try {
    const result = await vkMvpService.listJobs(chatId, { status, limit, offset });
    return res.json(result);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// GET /api/content/vk/jobs/:id — VK-задача по ID
router.get('/vk/jobs/:id', async (req, res) => {
  const chatId = normalizeChatId(req.query.chat_id);
  const jobId = parseInt(req.params.id, 10);
  if (!chatId) {
    return res.status(400).json({ error: 'chat_id is required' });
  }
  if (!Number.isFinite(jobId) || jobId <= 0) {
    return res.status(400).json({ error: 'invalid job id' });
  }

  try {
    const result = await vkMvpService.getJobById(chatId, jobId);
    if (!result) return res.status(404).json({ error: 'job not found' });
    return res.json({ job: result });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// POST /api/content/vk/jobs/:id/:action — модерация VK-поста
router.post('/vk/jobs/:id/:action', async (req, res) => {
  const chatId = normalizeChatId(req.body.chat_id || req.query.chat_id);
  const jobId = parseInt(req.params.id, 10);
  const actionRaw = String(req.params.action || '').trim().toLowerCase();
  const action = actionRaw.replace(/-/g, '_');
  const allowed = new Set(['approve', 'reject', 'regen_text', 'regen_image']);

  if (!chatId) {
    return res.status(400).json({ error: 'chat_id is required' });
  }
  if (!Number.isFinite(jobId) || jobId <= 0) {
    return res.status(400).json({ error: 'invalid job id' });
  }
  if (!allowed.has(action)) {
    return res.status(400).json({ error: 'invalid action' });
  }

  const bot = resolveBotFacade(chatId);
  if (!bot) {
    return res.status(409).json({ error: 'Telegram bot is not running for chat_id' });
  }

  try {
    const result = await vkMvpService.handleVkModerationAction(chatId, bot, jobId, action);
    return res.json(result);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// GET /api/content/vk/settings — настройки VK
router.get('/vk/settings', async (req, res) => {
  const chatId = normalizeChatId(req.query.chat_id);
  if (!chatId) {
    return res.status(400).json({ error: 'chat_id is required' });
  }
  try {
    const settings = vkMvpService.getVkSettings(chatId);
    return res.json(settings);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// =============================================
// OK (Odnoklassniki) Endpoints
// =============================================

// POST /api/content/ok/run-now — генерация ОК-поста
router.post('/ok/run-now', async (req, res) => {
  const chatId = normalizeChatId(req.body.chat_id);
  const reason = String(req.body.reason || 'api').trim() || 'api';
  if (!chatId) {
    return res.status(400).json({ error: 'chat_id is required' });
  }
  const bot = resolveBotFacade(chatId);
  if (!bot) {
    return res.status(409).json({ error: 'Telegram bot is not running for chat_id' });
  }
  try {
    const result = await okMvpService.runNow(chatId, bot, reason);
    return res.json(result);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// GET /api/content/ok/jobs — список ОК-задач
router.get('/ok/jobs', async (req, res) => {
  const chatId = normalizeChatId(req.query.chat_id);
  if (!chatId) {
    return res.status(400).json({ error: 'chat_id is required' });
  }
  const status = req.query.status ? String(req.query.status).trim().toLowerCase() : null;
  const limit = Math.min(toPositiveInt(req.query.limit, 50), 200);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

  try {
    const result = await okMvpService.listJobs(chatId, { status, limit, offset });
    return res.json(result);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// GET /api/content/ok/jobs/:id — ОК-задача по ID
router.get('/ok/jobs/:id', async (req, res) => {
  const chatId = normalizeChatId(req.query.chat_id);
  const jobId = parseInt(req.params.id, 10);
  if (!chatId) {
    return res.status(400).json({ error: 'chat_id is required' });
  }
  if (!Number.isFinite(jobId) || jobId <= 0) {
    return res.status(400).json({ error: 'invalid job id' });
  }

  try {
    const result = await okMvpService.getJobById(chatId, jobId);
    if (!result) return res.status(404).json({ error: 'job not found' });
    return res.json({ job: result });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// POST /api/content/ok/jobs/:id/:action — модерация ОК-поста
router.post('/ok/jobs/:id/:action', async (req, res) => {
  const chatId = normalizeChatId(req.body.chat_id || req.query.chat_id);
  const jobId = parseInt(req.params.id, 10);
  const actionRaw = String(req.params.action || '').trim().toLowerCase();
  const action = actionRaw.replace(/-/g, '_');
  const allowed = new Set(['approve', 'reject', 'regen_text', 'regen_image']);

  if (!chatId) {
    return res.status(400).json({ error: 'chat_id is required' });
  }
  if (!Number.isFinite(jobId) || jobId <= 0) {
    return res.status(400).json({ error: 'invalid job id' });
  }
  if (!allowed.has(action)) {
    return res.status(400).json({ error: 'invalid action' });
  }

  const bot = resolveBotFacade(chatId);
  if (!bot) {
    return res.status(409).json({ error: 'Telegram bot is not running for chat_id' });
  }

  try {
    const result = await okMvpService.handleOkModerationAction(chatId, bot, jobId, action);
    return res.json(result);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// GET /api/content/ok/settings — настройки ОК
router.get('/ok/settings', async (req, res) => {
  const chatId = normalizeChatId(req.query.chat_id);
  if (!chatId) {
    return res.status(400).json({ error: 'chat_id is required' });
  }
  try {
    const settings = okMvpService.getOkSettings(chatId);
    return res.json(settings);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// =============================================
// Instagram Endpoints
// =============================================

const instagramMvpService = require('../services/instagramMvp.service');

// POST /api/content/instagram/run-now — генерация Instagram-поста
router.post('/instagram/run-now', async (req, res) => {
  const chatId = normalizeChatId(req.body.chat_id);
  const reason = String(req.body.reason || 'api').trim() || 'api';
  if (!chatId) {
    return res.status(400).json({ error: 'chat_id is required' });
  }
  const bot = resolveBotFacade(chatId);
  if (!bot) {
    return res.status(409).json({ error: 'Telegram bot is not running for chat_id' });
  }
  try {
    const result = await instagramMvpService.runNow(chatId, bot, reason);
    return res.json(result);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// GET /api/content/instagram/jobs — список Instagram-задач
router.get('/instagram/jobs', async (req, res) => {
  const chatId = normalizeChatId(req.query.chat_id);
  if (!chatId) {
    return res.status(400).json({ error: 'chat_id is required' });
  }
  const status = req.query.status ? String(req.query.status).trim().toLowerCase() : null;
  const limit = Math.min(toPositiveInt(req.query.limit, 50), 200);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

  try {
    const result = await instagramMvpService.listJobs(chatId, { status, limit, offset });
    return res.json(result);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// GET /api/content/instagram/jobs/:id — Instagram-задача по ID
router.get('/instagram/jobs/:id', async (req, res) => {
  const chatId = normalizeChatId(req.query.chat_id);
  const jobId = parseInt(req.params.id, 10);
  if (!chatId) {
    return res.status(400).json({ error: 'chat_id is required' });
  }
  if (!Number.isFinite(jobId) || jobId <= 0) {
    return res.status(400).json({ error: 'invalid job id' });
  }

  try {
    const result = await instagramMvpService.getJobById(chatId, jobId);
    if (!result) return res.status(404).json({ error: 'job not found' });
    return res.json({ job: result });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// POST /api/content/instagram/jobs/:id/:action — модерация Instagram-поста
router.post('/instagram/jobs/:id/:action', async (req, res) => {
  const chatId = normalizeChatId(req.body.chat_id || req.query.chat_id);
  const jobId = parseInt(req.params.id, 10);
  const actionRaw = String(req.params.action || '').trim().toLowerCase();
  const action = actionRaw.replace(/-/g, '_');
  const allowed = new Set(['approve', 'reject', 'regen_text', 'regen_image']);

  if (!chatId) {
    return res.status(400).json({ error: 'chat_id is required' });
  }
  if (!Number.isFinite(jobId) || jobId <= 0) {
    return res.status(400).json({ error: 'invalid job id' });
  }
  if (!allowed.has(action)) {
    return res.status(400).json({ error: 'invalid action' });
  }

  const bot = resolveBotFacade(chatId);
  if (!bot) {
    return res.status(409).json({ error: 'Telegram bot is not running for chat_id' });
  }

  try {
    const result = await instagramMvpService.handleInstagramModerationAction(chatId, bot, jobId, action);
    return res.json(result);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// GET /api/content/instagram/settings — настройки Instagram
router.get('/instagram/settings', async (req, res) => {
  const chatId = normalizeChatId(req.query.chat_id);
  if (!chatId) {
    return res.status(400).json({ error: 'chat_id is required' });
  }
  try {
    const settings = instagramMvpService.getIgSettings(chatId);
    return res.json(settings);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

module.exports = router;
