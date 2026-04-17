'use strict';

const path = require('path');
const fetch = require('node-fetch');
const sessionService = require('./session.service');
const dockerService = require('./docker.service');
const config = require('../config');
const vpRepo = require('./content/videoPipeline.repository');

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const TEXT_EXTS = new Set(['.txt', '.md']);

/**
 * Чистая функция: разбирает список файлов и возвращает контекст.
 * Экспортируется для тестирования.
 * @param {Array<{name: string, ext: string}>} files
 * @param {Map<string, string>} textContents  имя файла → содержимое
 * @returns {{ textPrompt: string|null, imageFile: string|null }}
 */
function _parseFiles(files, textContents) {
  let textPrompt = null;
  for (const f of files) {
    if (!TEXT_EXTS.has(f.ext)) continue;
    const content = textContents.get(f.name);
    if (content && content.trim()) {
      textPrompt = content.trim().slice(0, 500);
      break;
    }
  }

  const imageFiles = files.filter(f => IMAGE_EXTS.has(f.ext));
  const imageFile = imageFiles.length > 0
    ? imageFiles[Math.floor(Math.random() * imageFiles.length)].name
    : null;

  return { textPrompt, imageFile };
}

async function _getInputFiles(chatId) {
  try {
    const session = await sessionService.getOrCreateSession(chatId);
    const result = await dockerService.executeInContainer(
      session.containerId,
      "find /workspace/input -maxdepth 1 -type f -printf '%p\\n' 2>/dev/null"
    );
    return result.stdout.trim().split('\n').filter(Boolean).map(filepath => ({
      path: filepath,
      name: path.basename(filepath),
      ext: path.extname(filepath).toLowerCase()
    }));
  } catch (e) {
    console.warn(`[IMAGE-CTX] getInputFiles error for ${chatId}: ${e.message}`);
    return [];
  }
}

async function _readFileContent(chatId, filepath) {
  try {
    const session = await sessionService.getOrCreateSession(chatId);
    const result = await dockerService.executeInContainer(
      session.containerId,
      `cat "${filepath.replace(/"/g, '\\"')}"`
    );
    return result.stdout;
  } catch (e) {
    console.warn(`[IMAGE-CTX] readFileContent error ${filepath}: ${e.message}`);
    return null;
  }
}

/**
 * Читает /workspace/input пользователя и возвращает контекст для генерации.
 * @param {string} chatId
 * @returns {Promise<{ textPrompt: string|null, imageFile: string|null }>}
 */
async function getInputContext(chatId) {
  const files = await _getInputFiles(chatId);
  if (files.length === 0) return { textPrompt: null, imageFile: null };

  const textContents = new Map();
  for (const f of files) {
    if (!TEXT_EXTS.has(f.ext)) continue;
    const content = await _readFileContent(chatId, f.path);
    if (content) textContents.set(f.name, content);
  }

  return _parseFiles(files, textContents);
}

// Схемы i2i по моделям: поле для изображения + дополнительные обязательные параметры
const I2I_SCHEMAS = {
  'nano-banana-2':             { imageField: 'image_input' },
  'seedream/4.5-edit':         { imageField: 'image_urls',  extra: { quality: 'basic' } },
  'flux-2/pro-image-to-image': { imageField: 'input_urls',  extra: { resolution: '1K' } },
};
const I2I_DEFAULT_SCHEMA = { imageField: 'imageUrls' };

// Модели, которые не поддерживают t2i — при отсутствии фото используем fallback
const I2I_ONLY_MODELS = new Set(['flux-2/pro-image-to-image']);

/**
 * Image-to-image через /api/v1/jobs/createTask.
 * Каждая модель использует свой формат поля для референсного изображения:
 * - grok-imagine/text-to-image → imageUrls: [url]
 * - nano-banana-2              → image_input: [url]
 * - seedream/4.5-edit          → image_urls: [url], quality: 'basic'
 */
async function _generateI2I(prompt, imagePublicUrl, aspectRatio, model) {
  const apiKey = process.env.KIE_API_KEY;
  if (!apiKey) throw new Error('KIE_API_KEY is not set');

  const schema = I2I_SCHEMAS[model] || I2I_DEFAULT_SCHEMA;
  const input = {
    prompt: prompt.slice(0, 800),
    aspect_ratio: aspectRatio,
    nsfw_checker: true,
    ...(schema.extra || {}),
    [schema.imageField]: [imagePublicUrl]
  };

  const createResp = await fetch('https://api.kie.ai/api/v1/jobs/createTask', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input }),
    timeout: 30000
  });

  if (!createResp.ok) {
    const err = await createResp.text();
    throw new Error(`KIE i2i createTask failed: ${createResp.status} ${err.slice(0, 300)}`);
  }
  const createData = await createResp.json();
  if (createData.code !== 200) throw new Error(`KIE i2i error: ${createData.msg}`);
  const taskId = createData?.data?.taskId;
  if (!taskId) throw new Error('KIE i2i: no taskId');

  const pollUrl = `https://api.kie.ai/api/v1/jobs/recordInfo?taskId=${taskId}`;
  const pollHeaders = { Authorization: `Bearer ${apiKey}` };

  for (let attempt = 0; attempt < 18; attempt++) {
    await new Promise(r => setTimeout(r, 5000));
    const pollResp = await fetch(pollUrl, { headers: pollHeaders, timeout: 15000 });
    if (!pollResp.ok) continue;
    const pollData = await pollResp.json();
    const state = pollData?.data?.state;
    if (state === 'success') {
      const resultJson = JSON.parse(pollData.data.resultJson || '{}');
      const imageUrl = resultJson?.resultUrls?.[0];
      if (!imageUrl) throw new Error('KIE i2i: no result URL');
      const imgResp = await fetch(imageUrl, { timeout: 30000 });
      if (!imgResp.ok) throw new Error(`KIE i2i download failed: ${imgResp.status}`);
      return await imgResp.buffer();
    }
    if (state === 'fail') {
      throw new Error(`KIE i2i failed: ${pollData.data.failMsg || 'unknown'}`);
    }
  }
  throw new Error('KIE i2i timeout');
}

/**
 * Text-to-image через /api/v1/jobs/createTask
 */
// Дополнительные обязательные параметры для t2i по моделям
const T2I_EXTRAS = {
  'seedream/4.5-edit': { quality: 'basic', image_urls: [] },
};

async function _generateT2I(prompt, aspectRatio, model) {
  const apiKey = process.env.KIE_API_KEY;
  if (!apiKey) throw new Error('KIE_API_KEY is not set');

  const input = {
    prompt: prompt.slice(0, 800),
    aspect_ratio: aspectRatio,
    nsfw_checker: true,
    ...(T2I_EXTRAS[model] || {})
  };

  const createResp = await fetch('https://api.kie.ai/api/v1/jobs/createTask', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input }),
    timeout: 30000
  });
  if (!createResp.ok) {
    const err = await createResp.text();
    throw new Error(`Image t2i createTask failed: ${createResp.status} ${err.slice(0, 300)}`);
  }
  const createData = await createResp.json();
  if (createData.code !== 200) throw new Error(`Image t2i error: ${createData.msg}`);
  const taskId = createData?.data?.taskId;
  if (!taskId) throw new Error('Image t2i: no taskId');

  const pollUrl = `https://api.kie.ai/api/v1/jobs/recordInfo?taskId=${taskId}`;
  const pollHeaders = { Authorization: `Bearer ${apiKey}` };

  for (let attempt = 0; attempt < 18; attempt++) {
    await new Promise(r => setTimeout(r, 5000));
    const pollResp = await fetch(pollUrl, { headers: pollHeaders, timeout: 15000 });
    if (!pollResp.ok) continue;
    const pollData = await pollResp.json();
    const state = pollData?.data?.state;
    if (state === 'success') {
      const resultJson = JSON.parse(pollData.data.resultJson || '{}');
      const imageUrl = resultJson?.resultUrls?.[0];
      if (!imageUrl) throw new Error('Image t2i: no result URL');
      const imgResp = await fetch(imageUrl, { timeout: 30000 });
      if (!imgResp.ok) throw new Error(`Image download failed: ${imgResp.status}`);
      return await imgResp.buffer();
    }
    if (state === 'fail') {
      throw new Error(`Image t2i failed: ${pollData.data.failMsg || 'unknown'}`);
    }
  }
  throw new Error('Image t2i timeout');
}

const LIGHTING_VARIANTS = [
  'soft diffused natural light from a large window',
  'warm golden hour sunlight, long shadows',
  'bright studio strobe, white background rim light',
  'moody low-key lighting, single side light source',
  'overcast daylight, even shadowless illumination',
  'candlelight-warm ambient glow, soft bokeh',
  'cool north-window light, neutral tones',
  'backlit silhouette light, glowing edges',
];

const ANGLE_VARIANTS = [
  'front view, eye-level, centered composition',
  'three-quarter angle, slight elevation, dynamic perspective',
  'top-down flat lay, overhead shot',
  'low angle, looking up, dramatic perspective',
  'side profile, clean background, minimalist framing',
  'close-up macro, sharp detail, extreme shallow depth of field',
  'diagonal composition, 45-degree angle, lifestyle context',
  'birds-eye view, symmetrical flat lay arrangement',
];

/**
 * Собирает структурированный промпт:
 * [Интерьер] + [Товар/Контекст] + [Освещение] + [Ракурс/Композиция] + [Стиль рендера]
 *
 * @param {string} productContext - описание товара или тема поста (из .txt файла или basePrompt канала)
 * @param {object|null} interior  - { style, description } из таблицы interiors, или null
 * @param {string} [lighting]     - конкретный вариант освещения (для тестов); если не передан — случайный
 * @param {string} [angle]        - конкретный ракурс (для тестов); если не передан — случайный
 * @returns {string}
 */
function _buildPrompt(productContext, interior, lighting, angle) {
  const parts = ['Professional product photography'];

  if (interior) {
    const style = interior.style || 'modern interior';
    const desc = String(interior.description || '').trim();
    parts.push(`Interior: ${style}${desc ? `, ${desc}` : ''}`);
  }

  parts.push(productContext);

  const light = lighting || LIGHTING_VARIANTS[Math.floor(Math.random() * LIGHTING_VARIANTS.length)];
  parts.push(light);

  const shot = angle || ANGLE_VARIANTS[Math.floor(Math.random() * ANGLE_VARIANTS.length)];
  parts.push(shot);

  parts.push('no text, no logos, no watermarks');
  parts.push('photorealistic, commercial photography, 4K');

  return parts.join('. ').slice(0, 800);
}

/**
 * Генерирует изображение: i2i если в /workspace/input есть картинка, иначе t2i.
 * Структурированный промпт: интерьер из БД + товар (textPrompt из .txt или basePrompt канала).
 * При i2i: textPrompt из .txt/.md используется как описание товара, не заменяет весь промпт.
 * При сбое i2i — fallback на t2i.
 *
 * @param {string} chatId
 * @param {string} basePrompt  - промпт канала (topic-based)
 * @param {string} aspectRatio - '1:1' | '2:3'
 * @param {string} t2iModel    - модель для t2i ('nano-banana-2' | 'grok-imagine/text-to-image')
 * @returns {Promise<Buffer>}
 */
async function generateImage(chatId, basePrompt, aspectRatio, t2iModel) {
  const [{ textPrompt, imageFile }, interior] = await Promise.all([
    getInputContext(chatId),
    vpRepo.ensureSchema(chatId)
      .then(() => vpRepo.getRandomInterior(chatId))
      .catch(e => { console.warn(`[IMAGE-CTX] Interior fetch skipped: ${e.message}`); return null; })
  ]);

  const productContext = textPrompt || basePrompt;
  const prompt = _buildPrompt(productContext, interior);
  console.log(`[IMAGE-CTX] prompt: ${prompt}`);

  if (interior) {
    console.log(`[IMAGE-CTX] Interior: style="${interior.style || 'n/a'}" id=${interior.id}`);
  }

  if (imageFile && I2I_SCHEMAS[t2iModel]) {
    const imagePublicUrl = `${config.APP_URL}/api/video/input/${chatId}/${encodeURIComponent(imageFile)}`;
    console.log(`[IMAGE-CTX] i2i: chatId=${chatId} file=${imageFile} model=${t2iModel}`);
    try {
      return await _generateI2I(prompt, imagePublicUrl, aspectRatio, t2iModel);
    } catch (e) {
      console.warn(`[IMAGE-CTX] i2i failed, fallback t2i: ${e.message}`);
    }
  }

  const effectiveT2iModel = I2I_ONLY_MODELS.has(t2iModel) ? 'grok-imagine/text-to-image' : t2iModel;
  console.log(`[IMAGE-CTX] t2i: chatId=${chatId} model=${effectiveT2iModel}`);
  return await _generateT2I(prompt, aspectRatio, effectiveT2iModel);
}

module.exports = { getInputContext, generateImage, _parseFiles, _buildPrompt, LIGHTING_VARIANTS, ANGLE_VARIANTS };
