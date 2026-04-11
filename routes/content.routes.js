const express = require('express');
const router = express.Router();
const { Telegraf } = require('telegraf');

const telegramMvpService = require('../services/telegramMvp.service');
const vkMvpService = require('../services/vkMvp.service');
const okMvpService = require('../services/okMvp.service');
const pinterestMvpService = require('../services/pinterestMvp.service');
const instagramMvpService = require('../services/instagramMvp.service');
const facebookMvpService = require('../services/facebookMvp.service');
const wordpressMvpService = require('../services/wordpressMvp.service');
const blogGenerator = require('../services/blogGenerator.service');
const wpRepo = require('../services/content/wordpress.repository');
const contentRepo = require('../services/content/repository');
const contentLimits = require('../services/content/limits');
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
    const result = await telegramMvpService.runNow(chatId, bot, reason);
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
    const result = await telegramMvpService.listTopics(chatId, { status, limit, offset });
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
    const topic = await telegramMvpService.createTopic(chatId, req.body || {});
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
    const topic = await telegramMvpService.updateTopic(chatId, topicId, req.body || {});
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
    const topic = await telegramMvpService.deleteTopic(chatId, topicId);
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
    const result = await telegramMvpService.listMaterials(chatId, { limit, offset });
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
    const material = await telegramMvpService.createMaterial(chatId, req.body || {});
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
    const material = await telegramMvpService.updateMaterial(chatId, materialId, req.body || {});
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
    const material = await telegramMvpService.deleteMaterial(chatId, materialId);
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
    const result = await telegramMvpService.previewContentImport(chatId, req.body || {});
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
    const result = await telegramMvpService.importContentFromGoogleSheet(chatId, req.body || {});
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
    const result = await telegramMvpService.previewPinterestBoardsImport(chatId, req.body || {});
    return res.json(result);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
});

router.post('/import-pinterest-boards', async (req, res) => {
  const chatId = normalizeChatId(req.body.chat_id);
  if (!chatId) return res.status(400).json({ error: 'chat_id is required' });

  try {
    const result = await telegramMvpService.importPinterestBoardsFromSheet(chatId, req.body || {});
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
    const profile = await telegramMvpService.getProfile(chatId);
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
    const profile = await telegramMvpService.saveProfile(chatId, files);
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
    const result = await telegramMvpService.listJobs(chatId, { status, limit, offset });
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
    const result = await telegramMvpService.getJobById(chatId, jobId);
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
    const result = await telegramMvpService.handleModerationAction(chatId, bot, action, jobId);
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
    const metrics = await telegramMvpService.getMetrics(chatId);
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

// =============================================
// Facebook Endpoints
// =============================================

// POST /api/content/facebook/run-now — генерация Facebook-поста
router.post('/facebook/run-now', async (req, res) => {
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
    const result = await facebookMvpService.runNow(chatId, bot, reason);
    return res.json(result);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// GET /api/content/facebook/jobs — список Facebook-задач
router.get('/facebook/jobs', async (req, res) => {
  const chatId = normalizeChatId(req.query.chat_id);
  if (!chatId) {
    return res.status(400).json({ error: 'chat_id is required' });
  }
  const status = req.query.status ? String(req.query.status).trim().toLowerCase() : null;
  const limit = Math.min(toPositiveInt(req.query.limit, 50), 200);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

  try {
    const fbRepo = require('../services/content/facebook.repository');
    const result = await fbRepo.listJobs(chatId, { status, limit, offset });
    return res.json(result);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// GET /api/content/facebook/jobs/:id — Facebook-задача по ID
router.get('/facebook/jobs/:id', async (req, res) => {
  const chatId = normalizeChatId(req.query.chat_id);
  const jobId = parseInt(req.params.id, 10);
  if (!chatId) {
    return res.status(400).json({ error: 'chat_id is required' });
  }
  if (!Number.isFinite(jobId) || jobId <= 0) {
    return res.status(400).json({ error: 'invalid job id' });
  }

  try {
    const fbRepo = require('../services/content/facebook.repository');
    const result = await fbRepo.getJobById(chatId, jobId);
    if (!result) return res.status(404).json({ error: 'job not found' });
    return res.json({ job: result });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// POST /api/content/facebook/jobs/:id/:action — модерация Facebook-поста
router.post('/facebook/jobs/:id/:action', async (req, res) => {
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
    const result = await facebookMvpService.handleFacebookModerationAction(chatId, bot, jobId, action);
    return res.json(result);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// GET /api/content/facebook/settings — настройки Facebook
router.get('/facebook/settings', async (req, res) => {
  const chatId = normalizeChatId(req.query.chat_id);
  if (!chatId) {
    return res.status(400).json({ error: 'chat_id is required' });
  }
  try {
    const settings = facebookMvpService.getFacebookSettings(chatId);
    return res.json(settings);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// ============================================
// WordPress Blog Integration Endpoints
// ============================================

// POST /api/content/wordpress/connect — подключить WordPress блог
router.post('/wordpress/connect', async (req, res) => {
  const chatId = normalizeChatId(req.body.chat_id);
  if (!chatId) {
    return res.status(400).json({ error: 'chat_id is required' });
  }

  const { baseUrl, username, appPassword, defaultCategoryId } = req.body || {};
  if (!baseUrl || !username || !appPassword) {
    return res.status(400).json({ error: 'baseUrl, username, and appPassword are required' });
  }

  try {
    // Валидация URL
    let normalizedUrl = baseUrl.trim().replace(/\/+$/, '');
    if (!normalizedUrl.startsWith('http://') && !normalizedUrl.startsWith('https://')) {
      normalizedUrl = 'https://' + normalizedUrl;
    }

    // Сохраняем конфиг
    manageStore.setWpConfig(chatId, {
      baseUrl: normalizedUrl,
      username: username.trim(),
      appPassword,
      defaultCategoryId: defaultCategoryId ? parseInt(defaultCategoryId, 10) : null,
      enabled: true
    });

    // Проверяем подключение
    const pingResult = await wordpressMvpService.ping(chatId);
    if (!pingResult.ok) {
      manageStore.setWpConfig(chatId, { enabled: false });
      return res.status(400).json({
        error: `WordPress connection failed: ${pingResult.error}`,
        ping: pingResult
      });
    }

    return res.json({
      ok: true,
      message: `WordPress подключён: ${pingResult.siteName}`,
      ping: pingResult
    });
  } catch (e) {
    manageStore.setWpConfig(chatId, { enabled: false });
    return res.status(500).json({ error: e.message });
  }
});

// POST /api/content/wordpress/disconnect — отключить WordPress
router.post('/wordpress/disconnect', async (req, res) => {
  const chatId = normalizeChatId(req.body.chat_id);
  if (!chatId) {
    return res.status(400).json({ error: 'chat_id is required' });
  }

  try {
    manageStore.clearWpConfig(chatId);
    return res.json({ ok: true, message: 'WordPress отключён' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// GET /api/content/wordpress/status — статус и последние посты
router.get('/wordpress/status', async (req, res) => {
  const chatId = normalizeChatId(req.query.chat_id);
  if (!chatId) {
    return res.status(400).json({ error: 'chat_id is required' });
  }

  try {
    const wpConfig = manageStore.getWpConfig(chatId) || {};
    const recentPosts = await wpRepo.getRecentPosts(chatId, 10);
    const stats = await wpRepo.getStatusStats(chatId);
    const publishedToday = await wpRepo.countPublishedToday(chatId);

    // Проверяем подключение если блог включён
    let ping = null;
    if (wpConfig.enabled && wpConfig.baseUrl) {
      ping = await wordpressMvpService.ping(chatId);
    }

    return res.json({
      config: wpConfig,
      stats,
      publishedToday,
      recentPosts,
      ping
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// GET /api/content/wordpress/config — получить конфигурацию
router.get('/wordpress/config', async (req, res) => {
  const chatId = normalizeChatId(req.query.chat_id);
  if (!chatId) {
    return res.status(400).json({ error: 'chat_id is required' });
  }

  try {
    const config = manageStore.getWpConfig(chatId) || {};
    const limits = contentLimits.getLimits(chatId);
    const today = new Intl.DateTimeFormat('sv-SE', { timeZone: config.scheduleTz || 'Europe/Moscow' }).format(new Date());
    const usage = await contentLimits.getTodayUsage(chatId, today, config.scheduleTz || 'Europe/Moscow');

    return res.json({
      config,
      limits: {
        dailyLimit: config.dailyLimit || limits.blogDailyQuota,
        minIntervalHours: config.minIntervalHours || 6
      },
      usage: {
        blogGenerated: usage.blogGenerated || 0
      }
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// PUT /api/content/wordpress/config — сохранить конфигурацию
router.put('/wordpress/config', async (req, res) => {
  const chatId = normalizeChatId(req.body.chat_id);
  if (!chatId) {
    return res.status(400).json({ error: 'chat_id is required' });
  }

  try {
    const currentConfig = manageStore.getWpConfig(chatId) || {};
    const patch = req.body || {};

    // Валидация
    if (patch.scheduleTime !== undefined && patch.scheduleTime) {
      if (!/^\d{2}:\d{2}$/.test(patch.scheduleTime)) {
        return res.status(400).json({ error: 'scheduleTime must be in HH:MM format' });
      }
    }

    if (patch.scheduleTz !== undefined && patch.scheduleTz) {
      try {
        Intl.DateTimeFormat(undefined, { timeZone: patch.scheduleTz });
      } catch {
        return res.status(400).json({ error: 'Invalid timezone' });
      }
    }

    if (patch.scheduleDays !== undefined) {
      if (!Array.isArray(patch.scheduleDays)) {
        return res.status(400).json({ error: 'scheduleDays must be an array' });
      }
      const validDays = patch.scheduleDays.every(d => Number.isInteger(d) && d >= 1 && d <= 7);
      if (!validDays) {
        return res.status(400).json({ error: 'scheduleDays must contain values 1-7' });
      }
    }

    manageStore.setWpConfig(chatId, {
      ...currentConfig,
      enabled: patch.enabled !== undefined ? patch.enabled : currentConfig.enabled,
      autoPublish: patch.autoPublish !== undefined ? patch.autoPublish : currentConfig.autoPublish,
      announceTelegram: patch.announceTelegram !== undefined ? patch.announceTelegram : currentConfig.announceTelegram,
      useKnowledgeBase: patch.useKnowledgeBase !== undefined ? patch.useKnowledgeBase : currentConfig.useKnowledgeBase,
      scheduleTime: patch.scheduleTime || currentConfig.scheduleTime,
      scheduleTz: patch.scheduleTz || currentConfig.scheduleTz,
      scheduleDays: patch.scheduleDays || currentConfig.scheduleDays,
      dailyLimit: patch.dailyLimit || currentConfig.dailyLimit,
      minIntervalHours: patch.minIntervalHours || currentConfig.minIntervalHours
    });

    return res.json({ ok: true, config: manageStore.getWpConfig(chatId) });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// GET /api/content/wordpress/categories — получить категории WordPress (прокси)
router.get('/wordpress/categories', async (req, res) => {
  const chatId = normalizeChatId(req.query.chat_id);
  if (!chatId) {
    return res.status(400).json({ error: 'chat_id is required' });
  }

  try {
    const wpConfig = manageStore.getWpConfig(chatId);
    if (!wpConfig || !wpConfig.baseUrl) {
      return res.status(400).json({ error: 'WordPress not configured' });
    }

    const categories = await wordpressMvpService.getCategories(chatId);
    return res.json({ categories });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// POST /api/content/wordpress/run-now — запустить генерацию сейчас
router.post('/wordpress/run-now', async (req, res) => {
  const chatId = normalizeChatId(req.body.chat_id);
  if (!chatId) {
    return res.status(400).json({ error: 'chat_id is required' });
  }

  try {
    const wpConfig = manageStore.getWpConfig(chatId);
    if (!wpConfig || !wpConfig.enabled) {
      return res.status(400).json({ error: 'WordPress is not enabled' });
    }

    // Проверяем дневной лимит
    const today = new Intl.DateTimeFormat('sv-SE', { timeZone: wpConfig.scheduleTz || 'Europe/Moscow' }).format(new Date());
    const quotaCheck = await contentLimits.checkQuota(chatId, contentLimits.QUOTA_TYPES.BLOG_GENERATION, {
      dateStr: today,
      tz: wpConfig.scheduleTz || 'Europe/Moscow',
      settings: { blogDailyQuota: wpConfig.dailyLimit }
    });

    if (!quotaCheck.allowed) {
      return res.status(429).json({ error: quotaCheck.reason });
    }

    // Ищем следующую тему
    const topicRow = await contentRepo.withClient(chatId, async (client) => {
      const result = await client.query(
        `SELECT id, topic, keywords, tech_doc_id
         FROM content_topics
         WHERE used_at IS NULL
         ORDER BY priority DESC, created_at ASC
         LIMIT 1`
      );
      return result.rows[0] || null;
    });

    if (!topicRow) {
      return res.status(400).json({ error: 'No available topics in queue' });
    }

    // Запускаем генерацию
    const article = await blogGenerator.generate(chatId, {
      topic: topicRow.topic,
      keywords: topicRow.keywords,
      techDocId: topicRow.tech_doc_id
    });

    // Загружаем изображение в WordPress
    const mediaResult = await wordpressMvpService.uploadMedia(chatId, {
      buffer: article.imageBuffer,
      filename: article.imageFilename,
      mimeType: article.imageMime,
      altText: article.seoTitle,
      title: article.seoTitle
    });

    // Создаём черновик
    const draftResult = await wordpressMvpService.createDraft(chatId, {
      title: article.seoTitle,
      content: article.bodyHtml,
      excerpt: article.metaDesc,
      featured_media: mediaResult.id,
      slug: article.slug
    });

    // Сохраняем пост
    const postId = await wpRepo.createDraftPost(chatId, {
      bodyHtml: article.bodyHtml,
      seoTitle: article.seoTitle,
      metaDesc: article.metaDesc,
      featuredImageUrl: mediaResult.source_url,
      wpMediaId: mediaResult.id,
      wpPostId: draftResult.id,
      wpPermalink: draftResult.link,
      wpPreviewUrl: draftResult.preview_link,
      publishStatus: wpConfig.autoPublish ? 'approved' : 'ready'
    });

    // Отмечаем тему
    await contentRepo.withClient(chatId, async (client) => {
      await client.query(
        `UPDATE content_topics SET used_at = NOW() WHERE id = $1`,
        [topicRow.id]
      );
    });

    // Если авто-публикация — публикуем сразу
    if (wpConfig.autoPublish) {
      await wordpressMvpService.publishPost(chatId, draftResult.id);
      await wpRepo.markPublished(chatId, postId);
    }

    return res.json({
      ok: true,
      postId,
      wpPostId: draftResult.id,
      previewUrl: draftResult.preview_link,
      topic: topicRow.topic
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// POST /api/content/topics — создать тему
router.post('/topics', async (req, res) => {
  const chatId = normalizeChatId(req.body.chat_id);
  if (!chatId) {
    return res.status(400).json({ error: 'chat_id is required' });
  }

  try {
    const { topic, keywords, techDocId, priority } = req.body || {};
    if (!topic) {
      return res.status(400).json({ error: 'topic is required' });
    }

    const result = await contentRepo.withClient(chatId, async (client) => {
      const res = await client.query(
        `INSERT INTO content_topics (chat_id, topic, keywords, tech_doc_id, priority)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [
          chatId,
          topic.trim(),
          keywords || null,
          techDocId ? parseInt(techDocId, 10) : null,
          priority ? parseInt(priority, 10) : 5
        ]
      );
      return res.rows[0];
    });

    return res.status(201).json({ topic: result });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// GET /api/content/topics — список тем
router.get('/topics', async (req, res) => {
  const chatId = normalizeChatId(req.query.chat_id);
  if (!chatId) {
    return res.status(400).json({ error: 'chat_id is required' });
  }

  try {
    const includeUsed = req.query.include_used === 'true';
    const limit = Math.min(toPositiveInt(req.query.limit, 100), 500);

    const topics = await contentRepo.withClient(chatId, async (client) => {
      const where = includeUsed ? '' : 'WHERE used_at IS NULL';
      const result = await client.query(
        `SELECT * FROM content_topics
         ${where}
         ORDER BY
           CASE WHEN used_at IS NULL THEN 0 ELSE 1 END,
           priority DESC,
           created_at ASC
         LIMIT $1`,
        [limit]
      );
      return result.rows;
    });

    return res.json({ topics });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// DELETE /api/content/topics/:id — удалить тему
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
    await contentRepo.withClient(chatId, async (client) => {
      await client.query(
        `DELETE FROM content_topics WHERE id = $1 AND chat_id = $2`,
        [topicId, chatId]
      );
    });
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// POST /api/content/knowledge — добавить технический документ
router.post('/knowledge', async (req, res) => {
  const chatId = normalizeChatId(req.body.chat_id);
  if (!chatId) {
    return res.status(400).json({ error: 'chat_id is required' });
  }

  try {
    const { title, body, tags } = req.body || {};
    if (!title) {
      return res.status(400).json({ error: 'title is required' });
    }

    const result = await contentRepo.withClient(chatId, async (client) => {
      const tagsStr = Array.isArray(tags) ? tags.join(',') : (tags || '');
      const res = await client.query(
        `INSERT INTO content_knowledge_base (chat_id, title, body, tags)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [chatId, title.trim(), body || '', tagsStr]
      );
      return res.rows[0];
    });

    return res.status(201).json({ knowledge: result });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// GET /api/content/knowledge — список технических документов
router.get('/knowledge', async (req, res) => {
  const chatId = normalizeChatId(req.query.chat_id);
  if (!chatId) {
    return res.status(400).json({ error: 'chat_id is required' });
  }

  try {
    const docs = await contentRepo.withClient(chatId, async (client) => {
      const result = await client.query(
        `SELECT * FROM content_knowledge_base
         ORDER BY created_at DESC`,
        []
      );
      return result.rows;
    });
    return res.json({ knowledge: docs });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// DELETE /api/content/knowledge/:id — удалить технический документ
router.delete('/knowledge/:id', async (req, res) => {
  const chatId = normalizeChatId(req.body.chat_id || req.query.chat_id);
  const docId = parseInt(req.params.id, 10);
  if (!chatId) {
    return res.status(400).json({ error: 'chat_id is required' });
  }
  if (!Number.isFinite(docId) || docId <= 0) {
    return res.status(400).json({ error: 'invalid document id' });
  }

  try {
    await contentRepo.withClient(chatId, async (client) => {
      await client.query(
        `DELETE FROM content_knowledge_base WHERE id = $1 AND chat_id = $2`,
        [docId, chatId]
      );
    });
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// GET /api/content/wordpress/posts — список блог-постов
router.get('/wordpress/posts', async (req, res) => {
  const chatId = normalizeChatId(req.query.chat_id);
  if (!chatId) {
    return res.status(400).json({ error: 'chat_id is required' });
  }

  try {
    const status = req.query.status ? String(req.query.status).trim().toLowerCase() : null;
    const limit = Math.min(toPositiveInt(req.query.limit, 50), 200);

    let posts;
    if (status) {
      posts = await wpRepo.findByStatus(chatId, status);
    } else {
      posts = await wpRepo.getRecentPosts(chatId, limit);
    }

    return res.json({ posts });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// POST /api/content/wordpress/posts/:id/approve — одобрить пост
router.post('/wordpress/posts/:id/approve', async (req, res) => {
  const chatId = normalizeChatId(req.body.chat_id);
  const postId = parseInt(req.params.id, 10);
  if (!chatId) {
    return res.status(400).json({ error: 'chat_id is required' });
  }
  if (!Number.isFinite(postId) || postId <= 0) {
    return res.status(400).json({ error: 'invalid post id' });
  }

  try {
    await wpRepo.markApproved(chatId, postId);
    return res.json({ ok: true, message: 'Post approved' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// POST /api/content/wordpress/posts/:id/reject — отклонить пост
router.post('/wordpress/posts/:id/reject', async (req, res) => {
  const chatId = normalizeChatId(req.body.chat_id);
  const postId = parseInt(req.params.id, 10);
  if (!chatId) {
    return res.status(400).json({ error: 'chat_id is required' });
  }
  if (!Number.isFinite(postId) || postId <= 0) {
    return res.status(400).json({ error: 'invalid post id' });
  }

  try {
    const post = await wpRepo.getPostById(chatId, postId);
    if (post && post.wp_post_id) {
      await wordpressMvpService.deletePost(chatId, post.wp_post_id);
    }
    await wpRepo.markRejected(chatId, postId);
    return res.json({ ok: true, message: 'Post rejected and deleted from WP' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

module.exports = router;
