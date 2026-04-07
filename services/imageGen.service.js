/**
 * Image Generation Service — генерация обложек для статей
 * Адаптер: Kie.ai (приоритет) или OpenAI Images (fallback)
 * Кэширование сгенерированных изображений
 */
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
const fetch = require('node-fetch');
const config = require('../config');

const DATA_ROOT = process.env.DATA_ROOT || '/var/sandbox-data';
const LEGACY_CACHE_DIR = process.env.IMAGE_CACHE_DIR || '/tmp/blog-image-cache';

function resolveCacheDir(chatId) {
  if (chatId) return path.join(DATA_ROOT, String(chatId), 'blog-cache');
  return LEGACY_CACHE_DIR;
}
const KIE_API_ENDPOINT = 'https://kie.ai/api/v1/generate';
const OPENAI_IMAGE_ENDPOINT = 'https://api.openai.com/v1/images/generations';

// ============================================
// Утилиты
// ============================================

/**
 * Создать хэш для кэширования на основе промпта и параметров
 */
function createImageHash(prompt, aspectRatio = '16:9', style = 'realistic') {
  const raw = `${prompt}|${aspectRatio}|${style}`;
  return crypto.createHash('md5').update(raw).digest('hex');
}

/**
 * Получить путь к кэшированному изображению
 */
function getCachedImagePath(hash, ext = 'png', chatId = null) {
  return path.join(resolveCacheDir(chatId), `${hash}.${ext}`);
}

/**
 * Проверить, есть ли изображение в кэше
 */
async function getCachedImage(prompt, aspectRatio, style, chatId = null) {
  const hash = createImageHash(prompt, aspectRatio, style);
  const cachedPath = getCachedImagePath(hash, 'png', chatId);

  try {
    await fs.access(cachedPath);
    const buffer = await fs.readFile(cachedPath);
    const ext = path.extname(cachedPath).slice(1);
    const mimeType = `image/${ext === 'jpg' ? 'jpeg' : ext}`;
    return { buffer, mimeType, filename: `${hash}.${ext}`, cached: true };
  } catch {
    return null; // не в кэше
  }
}

/**
 * Сохранить изображение в кэш
 */
async function cacheImage(buffer, prompt, aspectRatio, style, ext = 'png', chatId = null) {
  const hash = createImageHash(prompt, aspectRatio, style);
  const cachedPath = getCachedImagePath(hash, ext, chatId);

  await fs.mkdir(resolveCacheDir(chatId), { recursive: true });
  await fs.writeFile(cachedPath, buffer);

  return cachedPath;
}

// ============================================
// Kie.ai адаптер
// ============================================

/**
 * Сгенерировать изображение через Kie.ai
 */
async function generateWithKie(prompt, aspectRatio = '16:9') {
  if (!config.KIE_API_KEY) {
    throw new Error('KIE_API_KEY not configured');
  }

  const response = await fetch(KIE_API_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.KIE_API_KEY}`
    },
    body: JSON.stringify({
      prompt,
      aspect_ratio: aspectRatio,
      model: 'kie-v1' // или другая модель по умолчанию
    }),
    timeout: 120000
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`Kie.ai error (${response.status}): ${errorText}`);
  }

  const data = await response.json();

  // Kie.ai может вернуть URL или base64
  if (data.image_url) {
    // Скачиваем изображение
    const imgResponse = await fetch(data.image_url);
    if (!imgResponse.ok) {
      throw new Error('Failed to download generated image from Kie.ai');
    }
    const buffer = Buffer.from(await imgResponse.arrayBuffer());
    return { buffer, mimeType: imgResponse.headers.get('content-type') || 'image/png' };
  }

  if (data.image_base64) {
    const base64Data = data.image_base64.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');
    return { buffer, mimeType: data.mime_type || 'image/png' };
  }

  throw new Error('Kie.ai returned no image data');
}

// ============================================
// OpenAI Images адаптер
// ============================================

/**
 * Сгенерировать изображение через OpenAI Images API
 */
async function generateWithOpenAI(prompt, apiKey, size = '1024x1024') {
  const response = await fetch(OPENAI_IMAGE_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      prompt,
      n: 1,
      size,
      response_format: 'b64_json' // получаем base64
    }),
    timeout: 120000
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`OpenAI Images error (${response.status}): ${errorText}`);
  }

  const data = await response.json();

  if (data.data && data.data[0]) {
    const base64Data = data.data[0].b64_json;
    const buffer = Buffer.from(base64Data, 'base64');
    return { buffer, mimeType: 'image/png' };
  }

  throw new Error('OpenAI returned no image data');
}

// ============================================
// Публичный API
// ============================================

/**
 * Сгенерировать обложку для статьи
 * @param {object} params
 * @param {string} params.prompt — промпт для генерации
 * @param {string} [params.aspectRatio='16:9'] — соотношение сторон
 * @param {string} [params.style='realistic'] — стиль
 * @returns {Promise<{buffer: Buffer, mimeType: string, filename: string}>}
 */
async function generateCover({ prompt, aspectRatio = '16:9', style = 'realistic', chatId = null }) {
  // 1. Проверяем кэш
  const cached = await getCachedImage(prompt, aspectRatio, style, chatId);
  if (cached) {
    return cached;
  }

  // 2. Пробуем Kie.ai
  if (config.KIE_API_KEY) {
    try {
      const result = await generateWithKie(prompt, aspectRatio);
      const ext = result.mimeType === 'image/jpeg' ? 'jpg' : 'png';
      const filename = `cover_${createImageHash(prompt, aspectRatio, style)}.${ext}`;

      // Кэшируем
      await cacheImage(result.buffer, prompt, aspectRatio, style, ext, chatId);

      return { ...result, filename, cached: false };
    } catch (err) {
      console.warn('[IMAGE-GEN] Kie.ai failed, falling back to OpenAI:', err.message);
      // Продолжаем к OpenAI
    }
  }

  // 3. Fallback: OpenAI Images (если есть API ключ)
  // Ключ может быть в ai_router_service или в состоянии пользователя
  // Для блог-генератора передаётся отдельно — здесь проверяем глобальный
  if (process.env.OPENAI_API_KEY) {
    try {
      const result = await generateWithOpenAI(prompt, process.env.OPENAI_API_KEY);
      const filename = `cover_${createImageHash(prompt, aspectRatio, style)}.png`;

      // Кэшируем
      await cacheImage(result.buffer, prompt, aspectRatio, style, 'png', chatId);

      return { ...result, filename, cached: false };
    } catch (err) {
      console.error('[IMAGE-GEN] OpenAI Images also failed:', err.message);
    }
  }

  // 4. Если ничего не сработало
  throw new Error(
    'Image generation failed: neither Kie.ai nor OpenAI Images could generate the image. ' +
    'Set KIE_API_KEY or OPENAI_API_KEY in environment.'
  );
}

module.exports = {
  generateCover,
  getCachedImage,
  cacheImage,
  createImageHash
};
