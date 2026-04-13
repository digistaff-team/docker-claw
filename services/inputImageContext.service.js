'use strict';

const path = require('path');
const fetch = require('node-fetch');
const sessionService = require('./session.service');
const dockerService = require('./docker.service');
const config = require('../config');

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

/**
 * Image-to-image через /api/v1/image/generate
 */
async function _generateI2I(prompt, imagePublicUrl, aspectRatio) {
  const apiKey = process.env.KIE_API_KEY;
  if (!apiKey) throw new Error('KIE_API_KEY is not set');

  const resp = await fetch('https://api.kie.ai/api/v1/image/generate', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: prompt.slice(0, 800),
      model: process.env.KIE_IMAGE_MODEL || 'kie-image-v1',
      aspect_ratio: aspectRatio,
      imageUrls: [imagePublicUrl],
      n: 1,
      enableTranslation: true
    }),
    timeout: 60000
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`KIE i2i API failed: ${resp.status} ${errText.slice(0, 300)}`);
  }
  const data = await resp.json();
  if (data.code !== 200) throw new Error(`KIE i2i error: ${data.msg} (code ${data.code})`);
  const taskId = data?.data?.taskId;
  if (!taskId) throw new Error('KIE i2i: no taskId');

  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const statusResp = await fetch(`https://api.kie.ai/api/v1/image/tasks/${taskId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      timeout: 30000
    });
    if (!statusResp.ok) continue;
    const statusData = await statusResp.json();
    if (statusData.code === 200 && statusData.data?.resultUrl) {
      const imgResp = await fetch(statusData.data.resultUrl, { timeout: 60000 });
      if (!imgResp.ok) throw new Error('Failed to download i2i image');
      return await imgResp.buffer();
    }
    if (statusData.code === 500 || statusData.code === 501) {
      throw new Error(`KIE i2i failed: ${statusData.msg}`);
    }
  }
  throw new Error('KIE i2i timeout');
}

/**
 * Text-to-image через /api/v1/jobs/createTask
 */
async function _generateT2I(prompt, aspectRatio, model) {
  const apiKey = process.env.KIE_API_KEY;
  if (!apiKey) throw new Error('KIE_API_KEY is not set');

  const createResp = await fetch('https://api.kie.ai/api/v1/jobs/createTask', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      input: { prompt: prompt.slice(0, 800), aspect_ratio: aspectRatio, nsfw_checker: true }
    }),
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

/**
 * Генерирует изображение: i2i если в /workspace/input есть картинка, иначе t2i.
 * При i2i: textPrompt из .txt/.md переопределяет basePrompt.
 * При сбое i2i — fallback на t2i.
 *
 * @param {string} chatId
 * @param {string} basePrompt  - промпт канала (topic-based)
 * @param {string} aspectRatio - '1:1' | '2:3'
 * @param {string} t2iModel    - модель для t2i ('nano-banana-2' | 'grok-imagine/text-to-image')
 * @returns {Promise<Buffer>}
 */
async function generateImage(chatId, basePrompt, aspectRatio, t2iModel) {
  const { textPrompt, imageFile } = await getInputContext(chatId);
  const prompt = textPrompt || basePrompt;

  if (imageFile) {
    const imagePublicUrl = `${config.APP_URL}/api/video/input/${chatId}/${encodeURIComponent(imageFile)}`;
    console.log(`[IMAGE-CTX] i2i: chatId=${chatId} file=${imageFile}`);
    try {
      return await _generateI2I(prompt, imagePublicUrl, aspectRatio);
    } catch (e) {
      console.warn(`[IMAGE-CTX] i2i failed, fallback t2i: ${e.message}`);
    }
  }

  console.log(`[IMAGE-CTX] t2i: chatId=${chatId}`);
  return await _generateT2I(prompt, aspectRatio, t2iModel);
}

module.exports = { getInputContext, generateImage, _parseFiles };
