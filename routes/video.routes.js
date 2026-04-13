const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const videoPipeline = require('../services/videoPipeline.service');
const manageStore = require('../manage/store');

const ALLOWED_VIDEO_MODELS = ['veo3.1', 'seedance-2', 'grok-imagine'];

function normalizeChatId(chatId) {
  return String(chatId || '').trim();
}

// ============================================
// Video Generation
// ============================================

/**
 * POST /api/video/generate
 * Запустить генерацию нового видео
 * Body: { chat_id, channel: 'youtube'|'tiktok'|'instagram' }
 */
router.post('/generate', async (req, res) => {
  const chatId = normalizeChatId(req.body.chat_id);
  const channel = String(req.body.channel || 'youtube').toLowerCase();
  const model = req.body.model ? String(req.body.model).trim() : null;

  if (!chatId) {
    return res.status(400).json({ error: 'chat_id is required' });
  }

  if (!['youtube', 'tiktok', 'instagram', 'vk'].includes(channel)) {
    return res.status(400).json({ error: 'channel must be youtube, tiktok, instagram, or vk' });
  }

  // Сохраняем выбор модели если передан
  if (model && ALLOWED_VIDEO_MODELS.includes(model)) {
    await manageStore.setVideoPipelineSettings(chatId, { model });
  }

  try {
    const result = await videoPipeline.generateVideo(chatId, channel);

    if (result.success) {
      return res.json({
        success: true,
        videoId: result.videoId,
        videoPath: result.videoPath,
        filename: result.filename,
        correlationId: result.correlationId,
        message: 'Video generation started'
      });
    } else {
      return res.status(400).json({
        success: false,
        error: result.error,
        message: result.error
      });
    }
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// ============================================
// Video Assets
// ============================================

/**
 * GET /api/video/assets
 * Список видео-ассетов
 * Query: { chat_id, status?, limit?, offset? }
 */
router.get('/assets', async (req, res) => {
  const chatId = normalizeChatId(req.query.chat_id);
  if (!chatId) {
    return res.status(400).json({ error: 'chat_id is required' });
  }

  const status = req.query.status ? String(req.query.status).trim() : null;
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

  try {
    const videos = await videoPipeline.listVideos(chatId, { status, limit, offset });
    return res.json({ success: true, videos, total: videos.length });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/video/assets/:id
 * Конкретное видео + метки каналов
 */
router.get('/assets/:id', async (req, res) => {
  const chatId = normalizeChatId(req.query.chat_id);
  const videoId = parseInt(req.params.id, 10);

  if (!chatId || !Number.isFinite(videoId)) {
    return res.status(400).json({ error: 'chat_id and video id are required' });
  }

  try {
    const video = await videoPipeline.getVideoById(chatId, videoId);
    if (!video) {
      return res.status(404).json({ error: 'Video not found' });
    }

    const marks = await videoPipeline.getVideoUsageMarks(chatId, videoId);

    return res.json({
      success: true,
      video,
      usageMarks: marks
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/video/stats
 * Статистика по видео
 * Query: { chat_id }
 */
router.get('/stats', async (req, res) => {
  const chatId = normalizeChatId(req.query.chat_id);
  if (!chatId) {
    return res.status(400).json({ error: 'chat_id is required' });
  }

  try {
    const stats = await videoPipeline.getVideoStats(chatId);
    return res.json({ success: true, stats });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/video/pipeline-status
 * Полная информация о пайплайне для мониторинга
 * Query: { chat_id }
 */
router.get('/pipeline-status', async (req, res) => {
  const chatId = normalizeChatId(req.query.chat_id);
  if (!chatId) {
    return res.status(400).json({ error: 'chat_id is required' });
  }

  try {
    const status = await videoPipeline.getPipelineStatus(chatId);
    return res.json({ success: true, status });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// ============================================
// Claim Video
// ============================================

/**
 * POST /api/video/claim
 * Канал забирает доступное видео
 * Body: { chat_id, channel: 'youtube'|'tiktok'|'instagram' }
 */
router.post('/claim', async (req, res) => {
  const chatId = normalizeChatId(req.body.chat_id);
  const channel = String(req.body.channel || 'youtube').toLowerCase();

  if (!chatId) {
    return res.status(400).json({ error: 'chat_id is required' });
  }

  if (!['youtube', 'tiktok', 'instagram'].includes(channel)) {
    return res.status(400).json({ error: 'channel must be youtube, tiktok, or instagram' });
  }

  try {
    const result = await videoPipeline.claimVideo(chatId, channel);

    if (result.success) {
      return res.json({
        success: true,
        videoId: result.videoId,
        videoPath: result.videoPath,
        allChannelsUsed: result.allChannelsUsed,
        remainingChannels: result.remainingChannels,
        message: 'Video claimed successfully'
      });
    } else {
      return res.status(404).json({
        success: false,
        error: result.error,
        message: result.error
      });
    }
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/video/assets/:id/use
 * Поставить метку использования
 * Body: { channel: 'youtube'|'tiktok'|'instagram' }
 */
router.post('/assets/:id/use', async (req, res) => {
  const chatId = normalizeChatId(req.body.chat_id);
  const videoId = parseInt(req.params.id, 10);
  const channel = String(req.body.channel || '').toLowerCase();

  if (!chatId || !Number.isFinite(videoId)) {
    return res.status(400).json({ error: 'chat_id and video id are required' });
  }

  if (!['youtube', 'tiktok', 'instagram'].includes(channel)) {
    return res.status(400).json({ error: 'channel must be youtube, tiktok, or instagram' });
  }

  try {
    const result = await videoPipeline.markVideoUsed(chatId, videoId, channel);

    return res.json({
      success: true,
      allUsed: result.allUsed,
      markedChannels: result.markedChannels,
      remainingChannels: result.remainingChannels,
      message: result.allUsed ? 'All channels used. Video scheduled for deletion in 60 minutes.' : 'Mark added'
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// ============================================
// Interiors
// ============================================

/**
 * POST /api/video/interiors
 * Добавить описание интерьера
 * Body: { chat_id, description, style? }
 */
router.post('/interiors', async (req, res) => {
  const chatId = normalizeChatId(req.body.chat_id);
  const description = String(req.body.description || '').trim();
  const style = req.body.style ? String(req.body.style).trim() : null;

  if (!chatId) {
    return res.status(400).json({ error: 'chat_id is required' });
  }

  if (!description) {
    return res.status(400).json({ error: 'description is required' });
  }

  try {
    const interior = await videoPipeline.addInterior(chatId, { description, style });
    return res.json({ success: true, interior });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/video/interiors
 * Список интерьеров
 * Query: { chat_id, limit?, offset? }
 */
router.get('/interiors', async (req, res) => {
  const chatId = normalizeChatId(req.query.chat_id);
  if (!chatId) {
    return res.status(400).json({ error: 'chat_id is required' });
  }

  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

  try {
    const interiors = await videoPipeline.getInteriors(chatId, { limit, offset });
    return res.json({ success: true, interiors, total: interiors.length });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

/**
 * DELETE /api/video/interiors/:id
 * Удалить интерьер
 */
router.delete('/interiors/:id', async (req, res) => {
  const chatId = normalizeChatId(req.query.chat_id);
  const interiorId = parseInt(req.params.id, 10);

  if (!chatId || !Number.isFinite(interiorId)) {
    return res.status(400).json({ error: 'chat_id and interior id are required' });
  }

  try {
    const deleted = await videoPipeline.deleteInterior(chatId, interiorId);
    if (deleted) {
      return res.json({ success: true, message: 'Interior deleted' });
    } else {
      return res.status(404).json({ error: 'Interior not found' });
    }
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// ============================================
// Product Images
// ============================================

/**
 * GET /api/video/product-images
 * Список изображений товаров из /workspace/input
 * Query: { chat_id }
 */
router.get('/product-images', async (req, res) => {
  const chatId = normalizeChatId(req.query.chat_id);
  if (!chatId) {
    return res.status(400).json({ error: 'chat_id is required' });
  }

  try {
    const images = await videoPipeline.getInputImages(chatId);
    return res.json({ success: true, images, total: images.length });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// ============================================
// Временные файлы видео (для KIE.ai API)
// ============================================

/**
 * GET /api/video/temp/:chatId/:filename
 * Отдает файл из временной папки видео-пайплайна.
 * Используется KIE.ai API для получения URL сцены при image-to-video.
 * Также используется UI для превью видео.
 */
router.get('/temp/:chatId/:filename', (req, res) => {
  const { chatId, filename } = req.params;

  // Защита от path traversal
  const safeChatId = String(chatId).replace(/[^a-zA-Z0-9_-]/g, '_');
  const safeFilename = path.basename(filename);

  const filePath = path.join(videoPipeline.VIDEO_TEMP_ROOT, safeChatId, safeFilename);

  // Проверяем что файл существует
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }

  // Определяем Content-Type
  const ext = path.extname(safeFilename).toLowerCase();
  const contentTypes = {
    '.mp4': 'video/mp4',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp'
  };

  res.setHeader('Content-Type', contentTypes[ext] || 'application/octet-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Access-Control-Allow-Origin', '*');

  res.sendFile(filePath);
});

/**
 * GET /api/video/input/:chatId/:filename
 * Отдает изображение товара из /workspace/input пользователя.
 * Используется KIE.ai API при генерации сцены (image-to-image).
 * В отличие от /api/files/public/:chatId/:filename (который отдаёт из output/content),
 * этот endpoint отдаёт файлы из input/ директории.
 */
router.get('/input/:chatId/:filename', async (req, res) => {
  const { chatId, filename } = req.params;

  // Защита от path traversal
  const safeChatId = String(chatId).replace(/[^a-zA-Z0-9_-]/g, '_');
  const safeFilename = path.basename(filename);

  // Получаем dataDir пользователя
  const sessionService = require('../services/session.service');
  const storageService = require('../services/storage.service');

  try {
    const session = await sessionService.getOrCreateSession(safeChatId);
    const inputDir = path.join(session.dataDir, 'input');
    const filePath = path.join(inputDir, safeFilename);

    // Проверяем что файл существует и находится внутри input/
    const realPath = path.resolve(filePath);
    const realInputDir = path.resolve(inputDir);
    if (!realPath.startsWith(realInputDir)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found' });
    }

    // Определяем Content-Type
    const ext = path.extname(safeFilename).toLowerCase();
    const contentTypes = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp'
    };

    if (!contentTypes[ext]) {
      return res.status(400).json({ error: 'File type not allowed. Only images.' });
    }

    res.setHeader('Content-Type', contentTypes[ext]);
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Access-Control-Allow-Origin', '*');

    res.sendFile(filePath);
  } catch (e) {
    console.error(`[VIDEO-INPUT] Error serving file: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// ============================================
// KIE.ai Webhook Callback (Seedance / Grok)
// ============================================

/**
 * POST /api/video/callback/:chatId/:videoId
 * KIE.ai вызывает этот endpoint когда завершает задачу (для моделей с callBackUrl).
 */
router.post('/callback/:chatId/:videoId', (req, res) => {
  const videoId = parseInt(req.params.videoId, 10);

  if (!Number.isFinite(videoId)) {
    return res.status(400).json({ error: 'Invalid videoId' });
  }

  console.log(`[VIDEO-CALLBACK] Received callback for videoId=${videoId}, body=${JSON.stringify(req.body).slice(0, 300)}`);

  // Передаём payload в сервис — он разрешит ожидающий Promise
  videoPipeline.resolveVideoCallback(videoId, req.body);

  // KIE.ai ожидает 200 OK
  return res.json({ ok: true });
});

// ============================================
// Pipeline Settings
// ============================================

/**
 * GET /api/video/settings
 * Настройки видео-пайплайна пользователя (выбранная модель и т.д.)
 */
router.get('/settings', (req, res) => {
  const chatId = normalizeChatId(req.query.chat_id);
  if (!chatId) return res.status(400).json({ error: 'chat_id is required' });

  const settings = manageStore.getVideoPipelineSettings(chatId);
  return res.json({
    success: true,
    settings: {
      model: settings.model || (process.env.VIDEO_MODEL || 'veo3.1'),
    },
    availableModels: [
      { id: 'veo3.1',       name: 'Veo 3.1',       provider: 'Google / KIE.ai',    available: true },
      { id: 'seedance-2',   name: 'Seedance 2.0',   provider: 'ByteDance / KIE.ai', available: true },
      { id: 'grok-imagine', name: 'Grok Imagine',   provider: 'xAI / KIE.ai',       available: true },
    ]
  });
});

/**
 * POST /api/video/settings
 * Сохранить настройки видео-пайплайна
 * Body: { chat_id, model }
 */
router.post('/settings', async (req, res) => {
  const chatId = normalizeChatId(req.body.chat_id);
  if (!chatId) return res.status(400).json({ error: 'chat_id is required' });

  const model = String(req.body.model || '').trim();
  if (!ALLOWED_VIDEO_MODELS.includes(model)) {
    return res.status(400).json({ error: `model must be one of: ${ALLOWED_VIDEO_MODELS.join(', ')}` });
  }

  await manageStore.setVideoPipelineSettings(chatId, { model });
  return res.json({ success: true, settings: { model } });
});

module.exports = router;
