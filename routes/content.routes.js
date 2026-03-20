const express = require('express');
const router = express.Router();

const contentMvpService = require('../services/contentMvp.service');
const telegramRunner = require('../manage/telegram/runner');

function normalizeChatId(chatId) {
  return String(chatId || '').trim();
}

function getBotFacade(chatId) {
  const entry = telegramRunner.bots.get(normalizeChatId(chatId));
  if (!entry || !entry.bot || !entry.bot.telegram) return null;
  return { telegram: entry.bot.telegram };
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
  const bot = getBotFacade(chatId);
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

  const bot = getBotFacade(chatId);
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

module.exports = router;
