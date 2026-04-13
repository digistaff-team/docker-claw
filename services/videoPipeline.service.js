/**
 * Video Pipeline Service
 *
 * Отдельный пайплайн генерации видео для переиспользования каналами.
 *
 * Процесс:
 * 1. Берёт случайное фото товара из /workspace/input
 * 2. Берёт случайное описание интерьера из БД
 * 3. KIE.ai: фото товара + интерьер → сцена (image-to-image)
 * 4. KIE.ai Veo 3.1: сцена → видео (image-to-video, 9:16)
 * 5. Сохраняет во временную папку
 * 6. Каналы (YouTube, TikTok, Instagram) забирают видео по своему расписанию
 * 7. Все 3 метки → таймер 60 мин → удаление
 */

const path = require('path');
const os = require('os');
const fs = require('fs').promises;
const fetch = require('node-fetch');
const config = require('../config');
const aiRouterService = require('./ai_router_service');
const dockerService = require('./docker.service');
const storageService = require('./storage.service');
const imageService = require('./image.service');
const sessionService = require('./session.service');
const manageStore = require('../manage/store');
const vpRepo = require('./content/videoPipeline.repository');

// ============================================
// Константы
// ============================================

const VIDEO_TEMP_ROOT = process.env.VIDEO_TEMP_ROOT || path.join(config.DATA_ROOT, '.video-temp');
const VIDEO_MODEL = process.env.VIDEO_MODEL || 'veo3.1';
const VIDEO_ASPECT_RATIO = process.env.VIDEO_ASPECT_RATIO || '9:16';
const VIDEO_POLL_INTERVAL_SEC = parseInt(process.env.VIDEO_POLL_INTERVAL_SEC || '25', 10);
const VIDEO_TIMEOUT_SEC = parseInt(process.env.VIDEO_TIMEOUT_SEC || '600', 10);
const SCENE_IMAGE_WIDTH = 1080;
const SCENE_IMAGE_HEIGHT = 1920;
const MAX_SCENE_ATTEMPTS = 3;
const MAX_VIDEO_ATTEMPTS = 3;

let cleanupHandle = null;

// Защита от конкурентной генерации — in-memory lock по chatId
const generatingLocks = new Set();

// Ожидающие webhook-коллбэки от KIE.ai (для Seedance/Grok)
// Ключ: videoId (число), значение: { resolve, reject, timeoutHandle }
const pendingCallbacks = new Map();

// ============================================
// Инициализация
// ============================================

async function init() {
  // Создаём временную папку
  await fs.mkdir(VIDEO_TEMP_ROOT, { recursive: true });
  console.log(`[VIDEO-PIPELINE] Temp folder initialized: ${VIDEO_TEMP_ROOT}`);

  // Запускаем планировщик очистки
  startCleanupScheduler();
}

// ============================================
// Управление изображениями товаров
// ============================================

/**
 * Получить список изображений из /workspace/input пользователя
 */
async function getInputImages(chatId) {
  const session = await sessionService.getOrCreateSession(chatId);
  const inputDir = path.join(session.dataDir, 'input');

  try {
    const entries = await fs.readdir(inputDir);
    const files = [];
    for (const entry of entries) {
      const fullPath = path.join(inputDir, entry);
      const stat = await fs.stat(fullPath);
      if (stat.isFile() && /\.(jpg|jpeg|png|webp)$/i.test(entry)) {
        files.push({
          filename: entry,
          filepath: fullPath,
          size: stat.size,
          modifiedAt: stat.mtime
        });
      }
    }
    return files;
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

/**
 * Выбрать случайное изображение товара
 */
async function getRandomProductImage(chatId) {
  const images = await getInputImages(chatId);
  if (images.length === 0) return null;
  return images[Math.floor(Math.random() * images.length)];
}

// ============================================
// Управление интерьерами
// ============================================

/**
 * Получить случайное описание интерьера
 */
async function getRandomInterior(chatId) {
  await vpRepo.ensureSchema(chatId);
  return vpRepo.getRandomInterior(chatId);
}

async function addInterior(chatId, { description, style }) {
  await vpRepo.ensureSchema(chatId);
  return vpRepo.addInterior(chatId, { description, style });
}

async function getInteriors(chatId, options) {
  await vpRepo.ensureSchema(chatId);
  return vpRepo.getInteriors(chatId, options);
}

async function deleteInterior(chatId, interiorId) {
  return vpRepo.deleteInterior(chatId, interiorId);
}

// ============================================
// Генерация сцены (image-to-image)
// ============================================

/**
 * Сгенерировать сцену: товар в интерьере
 * Использует KIE.ai или OpenAI для генерации изображения
 *
 * @param {string} chatId
 * @param {object} productImage - { filename, filepath }
 * @param {object} interior - { description, style }
 * @param {string} correlationId
 * @returns {Promise<{ imagePath, imageUrl }> }
 */
async function generateScene(chatId, productImage, interior, correlationId) {
  const style = interior.style || 'modern interior';
  const description = interior.description || `${style} room with professional lighting`;

  const prompt = `Professional product photography: Place the product naturally in a ${style} interior setting. ${description}. ` +
    `Soft natural lighting, shallow depth of field, commercial quality, photorealistic, 4K resolution, ` +
    `vertical format 9:16, clean composition, no text, no logos, no watermarks.`;

  console.log(`[VIDEO-PIPELINE] Scene generation: chatId=${chatId}, style=${style}, corr=${correlationId}`);

  // Загружаем изображение товара
  const imageBuffer = await fs.readFile(productImage.filepath);
  const base64Image = imageBuffer.toString('base64');

  // Используем AI для создания промпта сцены
  let enhancedPrompt = prompt;
  try {
    const aiResponse = await aiRouterService.chatCompletion(
      chatId,
      [
        {
          role: 'system',
          content: 'You are a professional product photography director. Given a product filename and interior description, create a detailed image generation prompt for placing the product in the interior.'
        },
        {
          role: 'user',
          content: `Product: ${productImage.filename}\nInterior: ${description}\nStyle: ${style}\n\nCreate a detailed image generation prompt (max 200 chars) for placing this product in the described interior. Focus on composition, lighting, and mood. No text, no logos.`
        }
      ],
      { temperature: 0.7, max_tokens: 200 }
    );

    if (aiResponse?.content) {
      enhancedPrompt = aiResponse.content.trim().slice(0, 500);
      console.log(`[VIDEO-PIPELINE] Enhanced prompt: ${enhancedPrompt}`);
    }
  } catch (e) {
    console.warn(`[VIDEO-PIPELINE] AI prompt enhancement failed: ${e.message}, using default`);
  }

  // Генерируем сцену через KIE.ai
  // Создаём публичный URL для изображения товара через специальный endpoint
  // /api/video/input/:chatId/:filename — отдаёт файлы из input/ (в отличие от /api/files/public который отдаёт из output/content)
  const productPublicUrl = `${config.APP_URL}/api/video/input/${chatId}/${productImage.filename}`;
  console.log(`[VIDEO-PIPELINE] Product public URL: ${productPublicUrl}`);

  for (let attempt = 1; attempt <= MAX_SCENE_ATTEMPTS; attempt++) {
    try {
      const sceneResult = await generateImageViaKIE(chatId, enhancedPrompt, productPublicUrl, correlationId, attempt);
      if (sceneResult) {
        return sceneResult;
      }
    } catch (e) {
      console.warn(`[VIDEO-PIPELINE] Scene attempt ${attempt} failed: ${e.message}`);
      if (attempt === MAX_SCENE_ATTEMPTS) {
        throw new Error(`Scene generation failed after ${MAX_SCENE_ATTEMPTS} attempts: ${e.message}`);
      }
      await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }

  throw new Error('Scene generation failed');
}

/**
 * Генерация изображения через KIE.ai
 * @param {string} chatId
 * @param {string} prompt
 * @param {string} productImageUrl - публичный URL изображения товара
 * @param {string} correlationId
 * @param {number} attempt
 */
async function generateImageViaKIE(chatId, prompt, productImageUrl, correlationId, attempt) {
  const apiKey = process.env.KIE_API_KEY;
  if (!apiKey) throw new Error('KIE_API_KEY is not set');

  const body = {
    prompt,
    model: process.env.KIE_IMAGE_MODEL || 'kie-image-v1',
    aspect_ratio: '9:16',
    n: 1,
    enableTranslation: true
  };

  // Если есть URL изображения товара — передаём в imageUrls
  if (productImageUrl) {
    body.imageUrls = [productImageUrl];
  }

  const resp = await fetch('https://api.kie.ai/api/v1/image/generate', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body),
    timeout: 60000
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`KIE image API failed: ${resp.status} ${errText.slice(0, 300)}`);
  }

  const data = await resp.json();

  if (data.code !== 200) {
    if (data.code === 402) throw new Error('KIE: Insufficient credits');
    if (data.code === 422) throw new Error(`KIE: Validation error — ${data.msg}`);
    if (data.code === 429) throw new Error('KIE: Rate limited');
    throw new Error(`KIE image error: ${data.msg} (code ${data.code})`);
  }

  const taskId = data?.data?.taskId;
  if (!taskId) throw new Error('KIE: no taskId in response');

  // Polling
  const maxPollAttempts = 30;
  const pollInterval = 3000;

  for (let i = 0; i < maxPollAttempts; i++) {
    await new Promise(r => setTimeout(r, pollInterval));

    const statusResp = await fetch(`https://api.kie.ai/api/v1/image/tasks/${taskId}`, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
      timeout: 30000
    });

    if (!statusResp.ok) continue;
    const statusData = await statusResp.json();

    if (statusData.code === 200 && statusData.data?.resultUrl) {
      // Скачиваем изображение
      const imgResp = await fetch(statusData.data.resultUrl, { timeout: 60000 });
      if (!imgResp.ok) throw new Error('Failed to download scene image');

      const buffer = await imgResp.buffer();

      // Сохраняем
      const filename = `scene_${correlationId}_${attempt}.png`;
      const chatTempDir = path.join(VIDEO_TEMP_ROOT, chatId);
      await fs.mkdir(chatTempDir, { recursive: true });
      const filepath = path.join(chatTempDir, filename);
      await fs.writeFile(filepath, buffer);

      console.log(`[VIDEO-PIPELINE] Scene saved: ${filepath} (${buffer.length} bytes)`);
      return { imagePath: filepath, imageUrl: statusData.data.resultUrl };
    }

    if (statusData.code === 500 || statusData.code === 501) {
      throw new Error(`KIE image failed: ${statusData.msg}`);
    }
  }

  throw new Error('KIE image generation timeout');
}

// ============================================
// Генерация видео (image-to-video)
// ============================================

/**
 * Диспетчер генерации видео — выбирает адаптер по модели.
 *
 * @param {string} chatId
 * @param {number} videoId     - ID ассета в БД (нужен для webhook-адаптеров)
 * @param {string} sceneImagePath
 * @param {string} correlationId
 * @param {string} model       - 'veo3.1' | 'seedance-2' | 'grok-imagine'
 * @returns {Promise<{ videoBuffer, duration }>}
 */
async function generateVideoFromScene(chatId, videoId, sceneImagePath, correlationId, model) {
  const apiKey = process.env.KIE_API_KEY;
  if (!apiKey) throw new Error('KIE_API_KEY is not set');

  const sceneFilename = path.basename(sceneImagePath);
  const scenePublicUrl = `${config.APP_URL}/api/video/temp/${chatId}/${sceneFilename}`;
  console.log(`[VIDEO-PIPELINE] Scene public URL: ${scenePublicUrl}, model=${model}`);

  if (model === 'seedance-2') {
    return generateVideoSeedance(chatId, videoId, scenePublicUrl, apiKey);
  }
  if (model === 'grok-imagine') {
    return generateVideoGrok(chatId, videoId, scenePublicUrl, apiKey);
  }

  // Дефолт: Veo 3.1 (polling)
  return generateVideoVeo(chatId, scenePublicUrl, correlationId, apiKey);
}

/**
 * Veo 3.1 — image-to-video через polling.
 */
async function generateVideoVeo(chatId, scenePublicUrl, correlationId, apiKey) {
  const prompt = `Smooth cinematic pan, slow motion product showcase, professional commercial quality, ` +
    `vertical format, elegant camera movement, natural lighting transitions, 8 seconds duration.`;

  console.log(`[VIDEO-PIPELINE][VEO] Starting, corr=${correlationId}`);

  const createResp = await fetch('https://api.kie.ai/api/v1/veo/generate', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      prompt,
      model: VIDEO_MODEL,
      aspect_ratio: VIDEO_ASPECT_RATIO,
      generationType: 'IMAGE_2_VIDEO',
      imageUrls: [scenePublicUrl],
      enableTranslation: true
    }),
    timeout: 30000
  });

  if (!createResp.ok) {
    const errText = await createResp.text();
    throw new Error(`KIE Veo generate failed: ${createResp.status} ${errText.slice(0, 300)}`);
  }

  const createData = await createResp.json();
  if (createData.code !== 200) {
    if (createData.code === 402) throw new Error('KIE: Insufficient credits');
    if (createData.code === 422) throw new Error(`KIE: Validation error — ${createData.msg}`);
    if (createData.code === 429) throw new Error('KIE: Rate limited');
    throw new Error(`KIE Veo error: ${createData.msg} (code ${createData.code})`);
  }

  const taskId = createData?.data?.taskId;
  if (!taskId) throw new Error('KIE Veo: no taskId');

  console.log(`[VIDEO-PIPELINE][VEO] Task created: taskId=${taskId}`);

  const maxAttempts = Math.ceil(VIDEO_TIMEOUT_SEC / VIDEO_POLL_INTERVAL_SEC);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise(r => setTimeout(r, VIDEO_POLL_INTERVAL_SEC * 1000));

    const pollResp = await fetch(
      `https://api.kie.ai/api/v1/veo/get-1080p-video?taskId=${encodeURIComponent(taskId)}&index=0`,
      {
        headers: { 'Authorization': `Bearer ${apiKey}` },
        timeout: 30000
      }
    );

    if (!pollResp.ok) continue;

    const pollData = await pollResp.json();

    if (pollData.code === 200 && pollData.data?.resultUrl) {
      console.log(`[VIDEO-PIPELINE][VEO] Video ready: ${pollData.data.resultUrl}`);
      const videoResp = await fetch(pollData.data.resultUrl, { timeout: 120000 });
      if (!videoResp.ok) throw new Error(`Video download failed: ${videoResp.status}`);
      const videoBuffer = await videoResp.buffer();
      return { videoBuffer, duration: 8 };
    }

    if (pollData.code === 501) {
      throw new Error(`Video generation failed: ${pollData.msg || 'unknown'}`);
    }

    if (attempt % 6 === 0) {
      console.log(`[VIDEO-PIPELINE][VEO] Still processing... attempt ${attempt + 1}/${maxAttempts}`);
    }
  }

  throw new Error('Video generation timeout');
}

/**
 * Seedance 2.0 — image-to-video через webhook (callBackUrl).
 */
async function generateVideoSeedance(chatId, videoId, scenePublicUrl, apiKey) {
  const callBackUrl = `${config.APP_URL}/api/video/callback/${chatId}/${videoId}`;

  console.log(`[VIDEO-PIPELINE][SEEDANCE] Starting videoId=${videoId}, callBackUrl=${callBackUrl}`);

  const createResp = await fetch('https://api.kie.ai/api/v1/jobs/createTask', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'bytedance/seedance-2',
      callBackUrl,
      input: {
        first_frame_url: scenePublicUrl,
        web_search: false,
        aspect_ratio: '9:16',
        duration: 8
      }
    }),
    timeout: 30000
  });

  if (!createResp.ok) {
    const errText = await createResp.text();
    throw new Error(`KIE Seedance createTask failed: ${createResp.status} ${errText.slice(0, 300)}`);
  }

  const createData = await createResp.json();
  if (createData.code !== 200) {
    if (createData.code === 402) throw new Error('KIE: Insufficient credits');
    if (createData.code === 422) throw new Error(`KIE: Validation error — ${createData.msg}`);
    if (createData.code === 429) throw new Error('KIE: Rate limited');
    throw new Error(`KIE Seedance error: ${createData.msg} (code ${createData.code})`);
  }

  const taskId = createData?.data?.taskId;
  if (!taskId) throw new Error('KIE Seedance: no taskId in response');

  console.log(`[VIDEO-PIPELINE][SEEDANCE] Task created: taskId=${taskId}, waiting for webhook...`);

  // Ждём коллбэк от KIE.ai
  const payload = await waitForCallback(videoId);

  // Скачиваем видео
  const resultUrl = payload?.data?.resultUrl || payload?.resultUrl;
  if (!resultUrl) throw new Error('KIE Seedance callback: no resultUrl in payload');

  console.log(`[VIDEO-PIPELINE][SEEDANCE] Video ready: ${resultUrl}`);
  const videoResp = await fetch(resultUrl, { timeout: 120000 });
  if (!videoResp.ok) throw new Error(`Seedance video download failed: ${videoResp.status}`);
  const videoBuffer = await videoResp.buffer();
  return { videoBuffer, duration: 8 };
}

/**
 * Grok Imagine — image-to-video через webhook (callBackUrl).
 */
async function generateVideoGrok(chatId, videoId, scenePublicUrl, apiKey) {
  const callBackUrl = `${config.APP_URL}/api/video/callback/${chatId}/${videoId}`;

  console.log(`[VIDEO-PIPELINE][GROK] Starting videoId=${videoId}, callBackUrl=${callBackUrl}`);

  const createResp = await fetch('https://api.kie.ai/api/v1/jobs/createTask', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'grok-imagine/image-to-video',
      callBackUrl,
      input: {
        image_urls: [scenePublicUrl],
        duration: '8',
        mode: 'normal',
        aspect_ratio: '9:16'
      }
    }),
    timeout: 30000
  });

  if (!createResp.ok) {
    const errText = await createResp.text();
    throw new Error(`KIE Grok createTask failed: ${createResp.status} ${errText.slice(0, 300)}`);
  }

  const createData = await createResp.json();
  if (createData.code !== 200) {
    if (createData.code === 402) throw new Error('KIE: Insufficient credits');
    if (createData.code === 422) throw new Error(`KIE: Validation error — ${createData.msg}`);
    if (createData.code === 429) throw new Error('KIE: Rate limited');
    throw new Error(`KIE Grok error: ${createData.msg} (code ${createData.code})`);
  }

  const taskId = createData?.data?.taskId;
  if (!taskId) throw new Error('KIE Grok: no taskId in response');

  console.log(`[VIDEO-PIPELINE][GROK] Task created: taskId=${taskId}, waiting for webhook...`);

  const payload = await waitForCallback(videoId);

  const resultUrl = payload?.data?.resultUrl || payload?.resultUrl;
  if (!resultUrl) throw new Error('KIE Grok callback: no resultUrl in payload');

  console.log(`[VIDEO-PIPELINE][GROK] Video ready: ${resultUrl}`);
  const videoResp = await fetch(resultUrl, { timeout: 120000 });
  if (!videoResp.ok) throw new Error(`Grok video download failed: ${videoResp.status}`);
  const videoBuffer = await videoResp.buffer();
  return { videoBuffer, duration: 8 };
}

/**
 * Ожидать webhook-коллбэк от KIE.ai для данного videoId.
 * Регистрирует запись в pendingCallbacks и возвращает Promise,
 * который разрешается когда KIE.ai вызовет resolveVideoCallback().
 *
 * @param {number} videoId
 * @returns {Promise<object>} payload из тела коллбэка
 */
function waitForCallback(videoId) {
  return new Promise((resolve, reject) => {
    const timeoutHandle = setTimeout(() => {
      pendingCallbacks.delete(videoId);
      reject(new Error(`Webhook callback timeout for videoId=${videoId} after ${VIDEO_TIMEOUT_SEC}s`));
    }, VIDEO_TIMEOUT_SEC * 1000);

    pendingCallbacks.set(videoId, { resolve, reject, timeoutHandle });
  });
}

/**
 * Вызывается из route-обработчика POST /api/video/callback/:chatId/:videoId
 * когда KIE.ai присылает результат генерации.
 *
 * @param {number} videoId
 * @param {object} payload - тело запроса от KIE.ai
 */
function resolveVideoCallback(videoId, payload) {
  const cb = pendingCallbacks.get(videoId);
  if (!cb) {
    console.warn(`[VIDEO-PIPELINE] Received callback for unknown videoId=${videoId}`);
    return;
  }

  clearTimeout(cb.timeoutHandle);
  pendingCallbacks.delete(videoId);

  // Проверяем статус из payload
  const code = payload?.code;
  if (code === 501 || payload?.status === 'failed') {
    cb.reject(new Error(`KIE callback error: ${payload?.msg || 'failed'}`));
  } else {
    cb.resolve(payload);
  }

  console.log(`[VIDEO-PIPELINE] Callback resolved for videoId=${videoId}, code=${code}`);
}

// ============================================
// Сохранение видео
// ============================================

async function saveVideoToTemp(chatId, videoBuffer, videoId) {
  const chatTempDir = path.join(VIDEO_TEMP_ROOT, chatId);
  await fs.mkdir(chatTempDir, { recursive: true });

  const filename = `video_${videoId}.mp4`;
  const filepath = path.join(chatTempDir, filename);
  await fs.writeFile(filepath, videoBuffer);

  console.log(`[VIDEO-PIPELINE] Video saved: ${filepath} (${videoBuffer.length} bytes)`);
  return { filename, filepath };
}

async function saveSceneToTemp(chatId, sceneBuffer, videoId) {
  const chatTempDir = path.join(VIDEO_TEMP_ROOT, chatId);
  await fs.mkdir(chatTempDir, { recursive: true });

  const filename = `video_${videoId}_scene.png`;
  const filepath = path.join(chatTempDir, filename);
  await fs.writeFile(filepath, sceneBuffer);

  return { filename, filepath };
}

// ============================================
// Основной пайплайн генерации
// ============================================

/**
 * Полный цикл генерации видео:
 * 1. Выбрать случайное изображение товара
 * 2. Выбрать случайный интерьер
 * 3. Сгенерировать сцену
 * 4. Сгенерировать видео
 * 5. Сохранить
 * 6. Поставить метку initiatingChannel
 *
 * @param {string} chatId
 * @param {string} initiatingChannel - 'youtube' | 'tiktok' | 'instagram'
 * @param {string} [correlationId]
 * @returns {Promise<{ success, videoId, videoPath, error }> }
 */
async function generateVideo(chatId, initiatingChannel, correlationId) {
  await vpRepo.ensureSchema(chatId);

  const corrId = correlationId || `vp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  console.log(`[VIDEO-PIPELINE] Starting generation: chatId=${chatId}, channel=${initiatingChannel}, corr=${corrId}`);

  // Ранние проверки до создания записи
  // Проверка на конкурентную генерацию
  if (generatingLocks.has(chatId)) {
    return { success: false, error: 'Generation already in progress for this user. Please wait.', videoId: null, videoPath: null };
  }

  const productImage = await getRandomProductImage(chatId);
  if (!productImage) {
    return { success: false, error: 'No product images found in /workspace/input. Upload images first.', videoId: null, videoPath: null };
  }
  console.log(`[VIDEO-PIPELINE] Selected product image: ${productImage.filename}`);

  const interior = await getRandomInterior(chatId);
  if (!interior) {
    return { success: false, error: 'No interiors configured. Add interiors first.', videoId: null, videoPath: null };
  }
  console.log(`[VIDEO-PIPELINE] Selected interior: ${interior.style} (${interior.description.slice(0, 50)}...)`);

  let videoId = null;
  generatingLocks.add(chatId);

  try {
    // Шаг 3: Создать запись видео-ассета
    const videoAsset = await vpRepo.createVideoAsset(chatId, {
      productImagePath: productImage.filename,
      interiorId: interior.id,
      correlationId: corrId,
      initiatingChannel
    });
    videoId = videoAsset.id;

    // Обновляем статус: scene_generating
    await vpRepo.updateVideoStatus(chatId, videoId, 'scene_generating');

    // Шаг 4: Сгенерировать сцену
    const sceneResult = await generateScene(chatId, productImage, interior, corrId);

    // Обновляем статус: scene_ready
    await vpRepo.updateVideoStatus(chatId, videoId, 'scene_ready', {
      sceneImagePath: sceneResult.imagePath
    });
    console.log(`[VIDEO-PIPELINE] Scene ready: ${sceneResult.imagePath}`);

    // Шаг 5: Обновляем статус: video_generating
    await vpRepo.updateVideoStatus(chatId, videoId, 'video_generating');

    // Шаг 6: Сгенерировать видео
    const settings = manageStore.getVideoPipelineSettings(chatId);
    const model = settings.model || VIDEO_MODEL;
    console.log(`[VIDEO-PIPELINE] Using model: ${model}`);
    const videoResult = await generateVideoFromScene(chatId, videoId, sceneResult.imagePath, corrId, model);

    // Шаг 7: Сохранить видео
    const saved = await saveVideoToTemp(chatId, videoResult.videoBuffer, videoId);

    // Шаг 8: Обновить статус: video_ready
    await vpRepo.updateVideoStatus(chatId, videoId, 'video_ready', {
      videoPath: saved.filename,
      videoDuration: videoResult.duration,
      fileSize: videoResult.videoBuffer.length
    });

    // Шаг 9: Поставить метку initiatingChannel
    await vpRepo.markVideoUsedById(chatId, videoId, initiatingChannel);

    console.log(`[VIDEO-PIPELINE] Video generated successfully: videoId=${videoId}, path=${saved.filepath}`);

    return {
      success: true,
      videoId,
      videoPath: saved.filepath,
      filename: saved.filename,
      correlationId: corrId
    };

  } catch (e) {
    console.error(`[VIDEO-PIPELINE] Generation failed: ${e.message}`, e);

    // Обновляем статус на failed если запись уже создана
    if (videoId) {
      try {
        await vpRepo.updateVideoStatus(chatId, videoId, 'failed', { errorText: e.message });
        console.log(`[VIDEO-PIPELINE] Video ${videoId} marked as failed`);
      } catch (updateErr) {
        console.error(`[VIDEO-PIPELINE] Failed to update status to failed: ${updateErr.message}`);
      }
    }

    return { success: false, error: e.message, videoId, videoPath: null };
  } finally {
    generatingLocks.delete(chatId);
  }
}

// ============================================
// Claim Video — канал забирает видео
// ============================================

/**
 * Канал забирает доступное видео
 * Если нет доступного — возвращает ошибку (канал должен инициировать генерацию)
 *
 * @param {string} chatId
 * @param {string} channelType - 'youtube' | 'tiktok' | 'instagram'
 * @returns {Promise<{ videoId, videoPath, video, error }> }
 */
async function claimVideo(chatId, channelType) {
  await vpRepo.ensureSchema(chatId);

  try {
    const video = await vpRepo.getAvailableVideoForChannel(chatId, channelType);
    if (!video) {
      // Проверяем, идёт ли генерация
      const stats = await vpRepo.getVideoStats(chatId);
      const inProgress = (stats.scene_generating || 0) + (stats.video_generating || 0);

      return {
        success: false,
        error: 'No available videos for this channel.',
        video: null,
        needsGeneration: true,
        generationInProgress: inProgress > 0,
        generatingStats: stats
      };
    }

    // Ставим метку использования
    const markResult = await vpRepo.markVideoUsedById(chatId, video.id, channelType);

    console.log(`[VIDEO-PIPELINE] Video claimed: videoId=${video.id}, channel=${channelType}, allUsed=${markResult.allUsed}`);

    return {
      success: true,
      videoId: video.id,
      videoPath: video.video_path,
      video,
      allChannelsUsed: markResult.allUsed,
      remainingChannels: markResult.remainingChannels
    };
  } catch (e) {
    console.error(`[VIDEO-PIPELINE] Claim failed: ${e.message}`);
    return { success: false, error: e.message, video: null };
  }
}

/**
 * Поставить метку использования вручную (если видео уже использовано)
 */
async function markVideoUsed(chatId, videoId, channelType) {
  await vpRepo.ensureSchema(chatId);
  return vpRepo.markVideoUsedById(chatId, videoId, channelType);
}

// ============================================
// Получение информации
// ============================================

async function getVideoById(chatId, videoId) {
  await vpRepo.ensureSchema(chatId);
  return vpRepo.getVideoById(chatId, videoId);
}

async function listVideos(chatId, options) {
  await vpRepo.ensureSchema(chatId);
  return vpRepo.listVideos(chatId, options);
}

async function getVideoStats(chatId) {
  await vpRepo.ensureSchema(chatId);
  return vpRepo.getVideoStats(chatId);
}

async function getVideoUsageMarks(chatId, videoId) {
  await vpRepo.ensureSchema(chatId);
  return vpRepo.getVideoUsageMarks(chatId, videoId);
}

/**
 * Получить полную информацию о пайплайне для мониторинга
 */
async function getPipelineStatus(chatId) {
  await vpRepo.ensureSchema(chatId);
  const stats = await vpRepo.getVideoStats(chatId);
  const videos = await vpRepo.listVideos(chatId, { limit: 10 });
  const images = await getInputImages(chatId);
  const interiors = await vpRepo.getInteriors(chatId, { limit: 50 });

  return {
    stats,
    recentVideos: videos,
    productImagesCount: images.length,
    interiorsCount: interiors.length,
    generating: generatingLocks.has(chatId)
  };
}

/**
 * Отправить уведомление пользователю о результате генерации
 */
async function notifyUser(chatId, bot, message) {
  if (!bot?.telegram) {
    console.log(`[VIDEO-PIPELINE] Notification (no bot): ${message}`);
    return;
  }

  try {
    await bot.telegram.sendMessage(chatId, message);
  } catch (e) {
    console.error(`[VIDEO-PIPELINE] Failed to send notification: ${e.message}`);
  }
}

// ============================================
// Cleanup Scheduler
// ============================================

function startCleanupScheduler() {
  if (cleanupHandle) return;

  const intervalMs = parseInt(process.env.VIDEO_CLEANUP_INTERVAL_MS || '300000', 10); // 5 min

  cleanupHandle = setInterval(async () => {
    try {
      const cleaned = await cleanupExpiredVideos();
      if (cleaned > 0) {
        console.log(`[VIDEO-CLEANUP] Removed ${cleaned} expired videos`);
      }
    } catch (e) {
      console.error(`[VIDEO-CLEANUP] Error: ${e.message}`);
    }
  }, intervalMs);

  console.log(`[VIDEO-PIPELINE] Cleanup scheduler started (every ${intervalMs / 1000}s)`);
}

function stopCleanupScheduler() {
  if (cleanupHandle) {
    clearInterval(cleanupHandle);
    cleanupHandle = null;
    console.log('[VIDEO-PIPELINE] Cleanup scheduler stopped');
  }
}

/**
 * Удалить все видео с истёкшим scheduled_deletion_at
 * Проходит по всем активным сессиям и чистит их БД
 */
async function cleanupExpiredVideos() {
  let totalCleaned = 0;

  // Получаем все активные сессии
  const sessions = sessionService.getAllSessions();
  const chatIds = [...new Set(sessions.map(s => s.chatId))];

  // Также проверяем состояния из manageStore (могут быть неактивные сессии с видео)
  const allStates = manageStore.getAllStates();
  const allChatIds = [...new Set([...chatIds, ...Object.keys(allStates)])];

  for (const chatId of allChatIds) {
    try {
      const expiredVideos = await vpRepo.getExpiredVideosForChat(chatId);

      for (const video of expiredVideos) {
        console.log(`[VIDEO-CLEANUP] Deleting expired video: id=${video.id}, chatId=${chatId}`);

        // Удаляем файлы
        if (video.video_path) {
          const videoFile = path.join(VIDEO_TEMP_ROOT, chatId, video.video_path);
          try {
            await fs.unlink(videoFile);
            console.log(`[VIDEO-CLEANUP] Deleted video file: ${videoFile}`);
          } catch (e) {
            console.warn(`[VIDEO-CLEANUP] Failed to delete video file: ${e.message}`);
          }
        }

        if (video.scene_image_path) {
          try {
            await fs.unlink(video.scene_image_path);
            console.log(`[VIDEO-CLEANUP] Deleted scene file: ${video.scene_image_path}`);
          } catch (e) {
            console.warn(`[VIDEO-CLEANUP] Failed to delete scene file: ${e.message}`);
          }
        }

        // Обновляем статус и удаляем запись
        await vpRepo.markVideoExpired(chatId, video.id);
        await vpRepo.deleteVideoAsset(chatId, video.id);

        totalCleaned++;
      }
    } catch (e) {
      // БД может не существовать для некоторых chatId
      if (!e.message.includes('does not exist')) {
        console.error(`[VIDEO-CLEANUP] Error cleaning chat ${chatId}: ${e.message}`);
      }
    }
  }

  return totalCleaned;
}

// ============================================
// Exports
// ============================================

module.exports = {
  // Init
  init,

  // Product images
  getInputImages,
  getRandomProductImage,

  // Interiors
  addInterior,
  getInteriors,
  getRandomInterior,
  deleteInterior,

  // Main pipeline
  generateVideo,

  // Claim
  claimVideo,
  markVideoUsed,

  // Info
  getVideoById,
  listVideos,
  getVideoStats,
  getVideoUsageMarks,
  getPipelineStatus,

  // Notifications
  notifyUser,

  // Cleanup
  cleanupExpiredVideos,
  startCleanupScheduler,
  stopCleanupScheduler,

  // Temp folder
  VIDEO_TEMP_ROOT,

  // Webhook callbacks (Seedance / Grok)
  resolveVideoCallback,

  // Internal (for testing)
  generatingLocks,
  pendingCallbacks
};
