/**
 * Content MVP Service - Фасад для генерации и публикации контента
 * 
 * TASK-001: Нормализованные статусы с валидацией переходов
 * TASK-004: Correlation ID для трассировки
 * TASK-006: БД-очередь вместо in-memory lock
 * TASK-007: Планировщик через enqueue
 * TASK-015: Асинхронный video provider
 */
const fetch = require('node-fetch');
const path = require('path');
const os = require('os');
const fs = require('fs').promises;
const config = require('../config');
const aiRouterService = require('./ai_router_service');
const manageStore = require('../manage/store');
const sessionService = require('./session.service');
const dockerService = require('./docker.service');

// Новые модули
const contentModules = require('./content/index');
const {
  STATUS,
  JOB_STATUS,
  QUEUE_STATUS,
  PUBLISH_LOG_STATUS,
  validateJobStatusTransition,
  generateCorrelationId,
  repository,
  queueRepo,
  worker,
  validators,
  limits,
  alerts,
  videoService, // TASK-015
  VIDEO_STATUS // TASK-015
} = contentModules;

const SCHEDULE_TIME = process.env.CONTENT_MVP_TIME || '09:00';
const SCHEDULE_TZ = process.env.CONTENT_MVP_TZ || 'Europe/Moscow';
const CHANNEL_ID = process.env.CHANNEL_ID || '-1002263032027';
const MODERATOR_USER_ID = process.env.CONTENT_MVP_MODERATOR_USER_ID || '128247430';
const DAILY_LIMIT = parseInt(process.env.CONTENT_MVP_DAILY_LIMIT || '1', 10);
const MAX_IMAGE_ATTEMPTS = parseInt(process.env.CONTENT_MVP_MAX_IMAGE_ATTEMPTS || '3', 10);

// TASK-015: Video configuration
const DEFAULT_CONTENT_TYPE = process.env.CONTENT_MVP_CONTENT_TYPE || 'text+image'; // 'text+image' | 'text+video'
const VIDEO_FALLBACK_ENABLED = process.env.VIDEO_FALLBACK_ENABLED !== 'false';

const SHEET_URL = process.env.CONTENT_MVP_SHEET_URL || 'https://docs.google.com/spreadsheets/d/1klEWbBtbr1Ym-i4Xez76-egXpjBVD8ikiQAfVNyrUjg/edit?usp=sharing';
const SHEET_GID = process.env.CONTENT_MVP_SHEET_GID || '164844003';
const DRIVE_FOLDER_URL = process.env.CONTENT_MVP_DRIVE_FOLDER_URL || 'https://drive.google.com/drive/folders/1Vo7ZmMUR4j2ksZw3LZusPp8oKdmXnO9u?usp=sharing';

let schedulerHandle = null;
let botsGetter = null;

// ============================================
// Конфигурация
// ============================================

function getContentSettings(chatId) {
  const cfg = manageStore.getContentSettings ? manageStore.getContentSettings(chatId) : null;
  return {
    channelId: cfg?.channelId || CHANNEL_ID,
    moderatorUserId: cfg?.moderatorUserId || MODERATOR_USER_ID,
    scheduleTime: cfg?.scheduleTime || SCHEDULE_TIME,
    scheduleTz: cfg?.scheduleTz || SCHEDULE_TZ,
    dailyLimit: Number.isFinite(cfg?.dailyLimit) ? cfg.dailyLimit : DAILY_LIMIT,
    contentType: cfg?.contentType || DEFAULT_CONTENT_TYPE // TASK-015: 'text+image' | 'text+video'
  };
}

async function setContentSettings(chatId, patch = {}) {
  if (!manageStore.setContentSettings) throw new Error('Content settings are not supported');
  await manageStore.setContentSettings(chatId, patch);
  return getContentSettings(chatId);
}

// ============================================
// Утилиты
// ============================================

function getNowInTz(tz) {
  const p = new Intl.DateTimeFormat('sv-SE', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).formatToParts(new Date());
  const get = (t) => p.find((x) => x.type === t)?.value;
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    time: `${get('hour')}:${get('minute')}`
  };
}

function splitKeywords(v) {
  return String(v || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 5);
}

function extractHashtags(text) {
  return (String(text || '').match(/#[\p{L}\p{N}_]+/gu) || []).join(' ');
}

// ============================================
// Google Sheets Provider
// ============================================

function parseSheetId(sheetUrl) {
  const m = String(sheetUrl).match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return m ? m[1] : null;
}

function csvToRows(csv) {
  const rows = [];
  let cur = '';
  let row = [];
  let inQuotes = false;
  for (let i = 0; i < csv.length; i++) {
    const ch = csv[i];
    const next = csv[i + 1];
    if (ch === '"' && inQuotes && next === '"') {
      cur += '"';
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (ch === ',' && !inQuotes) {
      row.push(cur);
      cur = '';
      continue;
    }
    if ((ch === '\n' || ch === '\r') && !inQuotes) {
      if (ch === '\r' && next === '\n') i++;
      row.push(cur);
      cur = '';
      if (row.some((c) => c !== '')) rows.push(row);
      row = [];
      continue;
    }
    cur += ch;
  }
  row.push(cur);
  if (row.some((c) => c !== '')) rows.push(row);
  return rows;
}

function normalizeHeader(name) {
  return String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

async function readTopicsFromSheet() {
  const sheetId = parseSheetId(SHEET_URL);
  if (!sheetId) throw new Error('Invalid sheet URL');
  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${encodeURIComponent(SHEET_GID)}`;
  const resp = await fetch(url, { timeout: 20000 });
  if (!resp.ok) throw new Error(`Sheet fetch failed: ${resp.status}`);
  const csv = await resp.text();
  const rows = csvToRows(csv);
  if (rows.length < 2) return [];

  const header = rows[0].map(normalizeHeader);
  const idx = {
    topic: header.indexOf('тема'),
    focus: header.indexOf('фокусный ключ'),
    secondary: header.indexOf('вторичные ключи'),
    lsi: header.indexOf('lsi-ключи'),
    status: header.indexOf('статус')
  };
  if (idx.topic === -1) throw new Error('Missing "Тема" column');

  const topics = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    topics.push({
      sheetRow: i + 1,
      topic: (r[idx.topic] || '').trim(),
      focus: idx.focus >= 0 ? (r[idx.focus] || '').trim() : '',
      secondary: idx.secondary >= 0 ? (r[idx.secondary] || '').trim() : '',
      lsi: idx.lsi >= 0 ? (r[idx.lsi] || '').trim() : '',
      status: idx.status >= 0 ? (r[idx.status] || '').trim() : ''
    });
  }
  return topics.filter((t) => t.topic);
}

// ============================================
// Google Drive Provider
// ============================================

function extractDriveFolderId(url) {
  const m = String(url).match(/\/folders\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

function decodeHexEscapes(str) {
  return str.replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

async function listDriveDocs() {
  const folderId = extractDriveFolderId(DRIVE_FOLDER_URL);
  if (!folderId) return [];
  const resp = await fetch(DRIVE_FOLDER_URL, { timeout: 20000 });
  if (!resp.ok) return [];
  const html = await resp.text();
  const m = html.match(/window\['_DRIVE_ivd'\]\s*=\s*'([^']+)'/);
  if (!m) return [];
  const decoded = decodeHexEscapes(m[1]);
  const re = new RegExp(`"([a-zA-Z0-9_-]{20,})",\\["${folderId}"\\],"([^"]*)","([^"]*)"`, 'g');
  const out = [];
  let mm;
  while ((mm = re.exec(decoded)) !== null) {
    out.push({ id: mm[1], name: mm[2], mime: mm[3] });
  }
  return out;
}

async function loadDriveMaterialsText(limit = 10) {
  const docs = await listDriveDocs();
  const parts = [];
  for (const doc of docs.slice(0, limit)) {
    if (doc.mime !== 'application/vnd.google-apps.document') continue;
    const exportUrl = `https://docs.google.com/document/d/${doc.id}/export?format=txt`;
    try {
      const r = await fetch(exportUrl, { timeout: 20000 });
      if (!r.ok) continue;
      const txt = (await r.text()).trim();
      if (!txt) continue;
      parts.push(`### ${doc.name}\n${txt.slice(0, 4000)}`);
    } catch {
      // ignore single document errors
    }
  }
  return parts.join('\n\n').slice(0, 20000);
}

// ============================================
// Generation Service
// ============================================

function buildTextPrompt(topic, materialsText) {
  const secondary = splitKeywords(topic.secondary);
  const lsi = splitKeywords(topic.lsi);
  const keywordTagHints = [topic.focus, ...secondary].filter(Boolean).slice(0, 3);
  const hashtags = keywordTagHints.map((k) => `#${k.toLowerCase().replace(/[^a-zа-я0-9]+/gi, '_').replace(/^_+|_+$/g, '')}`);
  return `
Сгенерируй Telegram-пост на русском языке.
Требования:
- Тон: дружелюбно-продающий.
- Длина: до 600 символов.
- Эмодзи: умеренно.
- CTA: уместный по контексту.
- Запрещены темы: война, политика, религия, секс, преступность.
- Используй только факты из блока "Материалы".
- Добавь в конце 2-3 релевантных хэштега.

Тема: ${topic.topic}
Фокусный ключ: ${topic.focus || 'нет'}
Вторичные ключи: ${secondary.join(', ') || 'нет'}
LSI-ключи: ${lsi.join(', ') || 'нет'}
Рекомендованные хэштеги: ${hashtags.join(' ') || 'по контексту'}

Материалы:
${materialsText || 'Материалы недоступны'}
`.trim();
}

async function generatePostText(chatId, topic, materialsText) {
  const data = manageStore.getState(chatId);
  if (!data || !data.aiAuthToken || !data.aiModel) {
    throw new Error('AI model is not configured for chat');
  }
  const messages = [
    { role: 'system', content: 'Ты маркетинговый редактор Telegram-канала. Пиши кратко, фактически и без выдумок.' },
    { role: 'user', content: buildTextPrompt(topic, materialsText) }
  ];
  const call = () => aiRouterService.callAI(chatId, data.aiAuthToken, data.aiModel, messages, null, data.aiUserEmail);
  let resp;
  try {
    resp = await call();
  } catch (e) {
    const msg = e?.message || String(e);
    const isRateLimited = /\b429\b/.test(msg);
    if (!isRateLimited) throw e;
    const retryMatch = msg.match(/retry_after_seconds["']?\s*[:=]\s*(\d+)/i);
    const retrySec = retryMatch ? Math.min(parseInt(retryMatch[1], 10), 90) : 60;
    await new Promise((r) => setTimeout(r, retrySec * 1000));
    resp = await call();
  }
  const content = resp?.choices?.[0]?.message?.content || '';
  return String(content).trim().slice(0, 4000);
}

async function generateImage(topic, text) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set');
  const prompt = `Сгенерируй изображение для поста Telegram. Тема: ${topic.topic}. Текст поста: ${text}. Стиль: чисто, коммерчески, без текста на изображении.`;
  const resp = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'gpt-image-1',
      prompt,
      size: '1024x1024'
    }),
    timeout: 45000
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Image API failed: ${resp.status} ${err.slice(0, 300)}`);
  }
  const data = await resp.json();
  const item = data?.data?.[0];
  if (!item) throw new Error('Empty image response');
  if (item.b64_json) return Buffer.from(item.b64_json, 'base64');
  if (item.url) {
    const r = await fetch(item.url, { timeout: 30000 });
    if (!r.ok) throw new Error(`Image download failed: ${r.status}`);
    return await r.buffer();
  }
  throw new Error('Unsupported image response shape');
}

async function saveImageToUserWorkspace(chatId, buffer, jobId) {
  const session = await sessionService.getOrCreateSession(chatId);
  const localTmp = path.join(os.tmpdir(), `content-image-${chatId}-${jobId}.png`);
  await fs.writeFile(localTmp, buffer);
  const containerPath = `/workspace/output/content/post_${jobId}.png`;
  await sessionService.executeCommand(chatId, 'mkdir -p /workspace/output/content', 10);
  await dockerService.copyToContainer(localTmp, session.containerId, containerPath);
  await fs.unlink(localTmp).catch(() => {});
  return containerPath;
}

// ============================================
// Topic Selection
// ============================================

async function pickNextTopic(chatId) {
  const topics = await readTopicsFromSheet();
  return repository.withClient(chatId, async (client) => {
    for (const t of topics) {
      if (String(t.status || '').trim() !== '') continue;
      const st = await client.query('SELECT local_status FROM content_sheet_state WHERE sheet_row=$1', [t.sheetRow]);
      const localStatus = st.rows[0]?.local_status;
      if (!localStatus || localStatus === 'NEW' || localStatus === 'FAILED_RETRY') {
        return t;
      }
    }
    return null;
  });
}

// ============================================
// Draft Management (in-memory для совместимости)
// ============================================

function getDrafts(chatId) {
  const data = manageStore.getState(chatId) || {};
  return data.contentDrafts || {};
}

function setDraft(chatId, draftId, draft) {
  const data = manageStore.getState(chatId) || {};
  data.contentDrafts = data.contentDrafts || {};
  data.contentDrafts[draftId] = draft;
  if (!manageStore.getState(chatId)) {
    manageStore.getAllStates()[chatId] = data;
  }
  return manageStore.persist(chatId);
}

async function removeDraft(chatId, draftId) {
  const data = manageStore.getState(chatId) || {};
  if (data.contentDrafts && data.contentDrafts[draftId]) {
    delete data.contentDrafts[draftId];
    await manageStore.persist(chatId);
  }
}

// ============================================
// TASK-006: Job Handlers для Worker
// ============================================

/**
 * Обработчик задачи генерации контента
 * TASK-015: Поддерживает contentType из настроек
 */
async function handleGenerateJob(chatId, queueJob, bot, correlationId) {
  const { payload } = queueJob;
  const reason = payload?.reason || 'queue';
  const settings = getContentSettings(chatId);
  
  // TASK-015: Проверяем тип контента
  const contentType = payload?.contentType || settings.contentType || 'text+image';
  
  // Если тип контента — видео, перенаправляем на видео-генерацию
  if (contentType === 'text+video') {
    return handleVideoGenerateJob(chatId, queueJob, bot, correlationId);
  }

  await repository.ensureSchema(chatId);

  // TASK-012: Проверка квот
  const now = getNowInTz(settings.scheduleTz);
  const textQuota = await limits.checkQuota(chatId, limits.QUOTA_TYPES.TEXT_GENERATION, {
    dateStr: now.date,
    tz: settings.scheduleTz,
    settings
  });
  if (!textQuota.allowed) {
    return { success: false, error: textQuota.reason, retry: false };
  }

  const imageQuota = await limits.checkQuota(chatId, limits.QUOTA_TYPES.IMAGE_GENERATION, {
    dateStr: now.date,
    tz: settings.scheduleTz,
    settings
  });
  if (!imageQuota.allowed) {
    return { success: false, error: imageQuota.reason, retry: false };
  }

  const topic = await pickNextTopic(chatId);
  if (!topic) {
    return { success: false, error: 'Нет доступных тем со статусом "".', retry: false };
  }

  const materialsText = await loadDriveMaterialsText(12);
  let text;
  try {
    text = await generatePostText(chatId, topic, materialsText);
  } catch (e) {
    return { success: false, error: `Text generation failed: ${e.message}`, retry: true };
  }

  let imagePath = '';
  let imageAttempts = 0;
  let imageErr = '';
  for (let i = 1; i <= MAX_IMAGE_ATTEMPTS; i++) {
    try {
      imageAttempts = i;
      const imageBuffer = await generateImage(topic, text);
      imagePath = await saveImageToUserWorkspace(chatId, imageBuffer, `${topic.sheetRow}_${Date.now()}`);
      imageErr = '';
      break;
    } catch (e) {
      imageErr = e?.message || String(e);
    }
  }
  if (!imagePath) {
    return { success: false, error: `Image generation failed: ${imageErr}`, retry: true };
  }

  // Создаём job в БД
  const jobId = await repository.createJob(chatId, {
    sheetRow: topic.sheetRow,
    topic: topic.topic,
    status: STATUS.READY,
    imageAttempts,
    text,
    imagePath,
    correlationId
  });

  // Создаём post
  await repository.createPost(chatId, jobId, text, extractHashtags(text));

  // Создаём asset
  await repository.createAsset(chatId, jobId, 'image', imagePath, 'openai:gpt-image-1');

  // Обновляем sheet state
  await repository.setSheetState(chatId, topic.sheetRow, STATUS.READY, reason);

  // Отправляем модератору
  const draft = { jobId, topic, text, imagePath, correlationId };
  await sendDraftToModerator(chatId, bot, draft);

  return { success: true, data: { jobId } };
}

/**
 * Обработчик задачи публикации
 */
async function handlePublishJob(chatId, queueJob, bot, correlationId) {
  const { payload, job_id } = queueJob;
  const jobId = job_id || payload?.jobId;
  
  if (!jobId) {
    return { success: false, error: 'No jobId provided', retry: false };
  }

  const draft = getDrafts(chatId)[String(jobId)];
  if (!draft) {
    return { success: false, error: 'Черновик не найден.', retry: false };
  }

  try {
    await publishDraft(chatId, bot, draft, correlationId);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message, retry: true };
  }
}

// ============================================
// TASK-015: Video Generation Handlers
// ============================================

/**
 * Сохранить видео в workspace пользователя
 */
async function saveVideoToUserWorkspace(chatId, videoBuffer, jobId) {
  const session = await sessionService.getOrCreateSession(chatId);
  const localTmp = path.join(os.tmpdir(), `content-video-${chatId}-${jobId}.mp4`);
  await fs.writeFile(localTmp, videoBuffer);
  const containerPath = `/workspace/output/content/post_${jobId}.mp4`;
  await sessionService.executeCommand(chatId, 'mkdir -p /workspace/output/content', 10);
  await dockerService.copyToContainer(localTmp, session.containerId, containerPath);
  await fs.unlink(localTmp).catch(() => {});
  return containerPath;
}

/**
 * Обработчик задачи генерации видео-контента
 */
async function handleVideoGenerateJob(chatId, queueJob, bot, correlationId) {
  const { payload } = queueJob;
  const reason = payload?.reason || 'queue';
  const settings = getContentSettings(chatId);

  await repository.ensureSchema(chatId);
  await videoService.ensureVideoSchema(chatId);

  // Проверка квот
  const now = getNowInTz(settings.scheduleTz);
  const textQuota = await limits.checkQuota(chatId, limits.QUOTA_TYPES.TEXT_GENERATION, {
    dateStr: now.date,
    tz: settings.scheduleTz,
    settings
  });
  if (!textQuota.allowed) {
    return { success: false, error: textQuota.reason, retry: false };
  }

  const videoQuota = await limits.checkQuota(chatId, limits.QUOTA_TYPES.VIDEO_GENERATION, {
    dateStr: now.date,
    tz: settings.scheduleTz,
    settings
  });
  if (!videoQuota.allowed) {
    // Если квота видео исчерпана — fallback на image
    if (VIDEO_FALLBACK_ENABLED) {
      console.log(`[CONTENT-MVP] Video quota exceeded, falling back to image for chat ${chatId}`);
      return handleGenerateJob(chatId, { ...queueJob, payload: { ...payload, contentType: 'text+image' } }, bot, correlationId);
    }
    return { success: false, error: videoQuota.reason, retry: false };
  }

  const topic = await pickNextTopic(chatId);
  if (!topic) {
    return { success: false, error: 'Нет доступных тем со статусом "".', retry: false };
  }

  const materialsText = await loadDriveMaterialsText(12);
  let text;
  try {
    text = await generatePostText(chatId, topic, materialsText);
  } catch (e) {
    return { success: false, error: `Text generation failed: ${e.message}`, retry: true };
  }

  // Создаём job в статусе MEDIA_GENERATING
  const jobId = await repository.createJob(chatId, {
    sheetRow: topic.sheetRow,
    topic: topic.topic,
    contentType: 'text+video',
    status: STATUS.MEDIA_GENERATING,
    text,
    correlationId
  });

  // Создаём post
  await repository.createPost(chatId, jobId, text, extractHashtags(text), 'text+video');

  // Запускаем генерацию видео
  try {
    const videoPrompt = `Сгенерируй короткое видео для Telegram-поста. Тема: ${topic.topic}. Текст поста: ${text}. Стиль: динамичный, коммерческий, без текста на видео.`;
    
    const generation = await videoService.startVideoGeneration(chatId, {
      prompt: videoPrompt,
      correlationId,
      params: {
        duration: 5,
        ratio: '16:9'
      }
    });

    // Связываем генерацию с job
    await videoService.linkGenerationToJob(chatId, generation.generationId, jobId);

    console.log(`[CONTENT-MVP] Video generation started: ${generation.generationId} for job ${jobId}`);
    
    // Job останется в статусе MEDIA_GENERATING до завершения polling'а
    return { success: true, data: { jobId, generationId: generation.generationId, async: true } };
  } catch (e) {
    // При ошибке запуска видео — fallback на image
    console.error(`[CONTENT-MVP] Video generation start failed: ${e.message}`);
    
    if (VIDEO_FALLBACK_ENABLED) {
      console.log(`[CONTENT-MVP] Falling back to image generation for job ${jobId}`);
      
      // Обновляем contentType на text+image
      await repository.updateJob(chatId, jobId, { contentType: 'text+image' });
      
      // Генерируем изображение
      let imagePath = '';
      let imageErr = '';
      for (let i = 1; i <= MAX_IMAGE_ATTEMPTS; i++) {
        try {
          const imageBuffer = await generateImage(topic, text);
          imagePath = await saveImageToUserWorkspace(chatId, imageBuffer, `${topic.sheetRow}_${Date.now()}`);
          break;
        } catch (imgErr) {
          imageErr = imgErr?.message || String(imgErr);
        }
      }
      
      if (imagePath) {
        await repository.updateJob(chatId, jobId, { imagePath, status: STATUS.READY });
        await repository.createAsset(chatId, jobId, 'image', imagePath, 'openai:gpt-image-1');
        await repository.setSheetState(chatId, topic.sheetRow, STATUS.READY, `${reason}_fallback`);
        
        const draft = { jobId, topic, text, imagePath, correlationId, contentType: 'text+image' };
        await sendDraftToModerator(chatId, bot, draft);
        
        return { success: true, data: { jobId, fallbackUsed: true } };
      }
    }
    
    await repository.updateJobStatus(chatId, jobId, STATUS.FAILED, e.message);
    return { success: false, error: e.message, retry: true };
  }
}

/**
 * Callback при завершении генерации видео (регистрируется в worker)
 */
async function handleVideoGenerationComplete(chatId, job, bot, videoResult) {
  const { id: jobId, sheet_row, sheet_topic, draft_text, correlation_id } = job;
  const topic = { sheetRow: sheet_row, topic: sheet_topic };
  
  if (!videoResult.success) {
    console.error(`[CONTENT-MVP] Video generation failed for job ${jobId}: ${videoResult.error}`);
    
    // Fallback на изображение
    if (VIDEO_FALLBACK_ENABLED && !videoResult.timedOut) {
      console.log(`[CONTENT-MVP] Falling back to image for failed video job ${jobId}`);
      
      try {
        let imagePath = '';
        for (let i = 1; i <= MAX_IMAGE_ATTEMPTS; i++) {
          try {
            const imageBuffer = await generateImage(topic, draft_text);
            imagePath = await saveImageToUserWorkspace(chatId, imageBuffer, `${sheet_row}_${Date.now()}`);
            break;
          } catch (e) {
            console.error(`[CONTENT-MVP] Image fallback attempt ${i} failed:`, e.message);
          }
        }
        
        if (imagePath) {
          await repository.updateJob(chatId, jobId, { 
            imagePath, 
            contentType: 'text+image',
            status: STATUS.READY 
          });
          await repository.createAsset(chatId, jobId, 'image', imagePath, 'openai:gpt-image-1');
          await repository.setSheetState(chatId, sheet_row, STATUS.READY, 'video_fallback');
          
          const draft = { jobId, topic, text: draft_text, imagePath, correlationId: correlation_id, contentType: 'text+image' };
          await sendDraftToModerator(chatId, bot, draft);
          return;
        }
      } catch (e) {
        console.error(`[CONTENT-MVP] Image fallback failed:`, e.message);
      }
    }
    
    await repository.updateJobStatus(chatId, jobId, STATUS.FAILED, videoResult.error);
    return;
  }
  
  // Видео успешно сгенерировано
  try {
    const videoPath = await saveVideoToUserWorkspace(chatId, videoResult.videoBuffer, jobId);
    
    await repository.updateJob(chatId, jobId, { 
      videoPath, 
      status: STATUS.READY 
    });
    await repository.createAsset(chatId, jobId, 'video', videoPath, videoResult.generationId);
    await repository.setSheetState(chatId, sheet_row, STATUS.READY, 'video_generated');
    
    // Создаём thumbnail из видео (опционально)
    const draft = { 
      jobId, 
      topic, 
      text: draft_text, 
      videoPath, 
      correlationId: correlation_id, 
      contentType: 'text+video' 
    };
    
    // Для модератора отправляем текст + уведомление о видео
    await sendVideoDraftToModerator(chatId, bot, draft);
    
    console.log(`[CONTENT-MVP] Video job ${jobId} completed successfully`);
  } catch (e) {
    console.error(`[CONTENT-MVP] Failed to save video for job ${jobId}:`, e.message);
    await repository.updateJobStatus(chatId, jobId, STATUS.FAILED, e.message);
  }
}

/**
 * Отправить видео-черновик модератору
 */
async function sendVideoDraftToModerator(chatId, bot, draft) {
  const settings = getContentSettings(chatId);
  const caption = [
    `🎬 Видео-черновик #${draft.jobId}`,
    `Тема: ${draft.topic.topic}`,
    draft.correlationId ? `📋 ${draft.correlationId}` : '',
    '',
    draft.text
  ].filter(Boolean).join('\n').slice(0, 1024);

  const callbackBase = `content:${draft.jobId}`;
  const kb = {
    inline_keyboard: [
      [
        { text: '✅ Approve', callback_data: `${callbackBase}:approve` },
        { text: '🔁 Regenerate Text', callback_data: `${callbackBase}:regen_text` }
      ],
      [
        { text: '🎬 Regenerate Video', callback_data: `${callbackBase}:regen_video` },
        { text: '❌ Reject', callback_data: `${callbackBase}:reject` }
      ]
    ]
  };

  // Для видео отправляем текстовое сообщение с кнопками
  const sent = await bot.telegram.sendMessage(settings.moderatorUserId, caption, { 
    reply_markup: kb,
    parse_mode: 'HTML'
  });

  await setDraft(chatId, String(draft.jobId), {
    ...draft,
    moderationMessageId: sent.message_id,
    rejectedCount: draft.rejectedCount || 0
  });
}

// ============================================
// Core Operations
// ============================================

async function generateDraft(chatId, reason = 'manual', correlationId = null) {
  const corrId = correlationId || generateCorrelationId();
  await repository.ensureSchema(chatId);
  const topic = await pickNextTopic(chatId);
  if (!topic) return { ok: false, message: 'Нет доступных тем со статусом "".' };

  const materialsText = await loadDriveMaterialsText(12);
  const text = await generatePostText(chatId, topic, materialsText);

  let imagePath = '';
  let imageAttempts = 0;
  let imageErr = '';
  for (let i = 1; i <= MAX_IMAGE_ATTEMPTS; i++) {
    try {
      imageAttempts = i;
      const imageBuffer = await generateImage(topic, text);
      imagePath = await saveImageToUserWorkspace(chatId, imageBuffer, `${topic.sheetRow}_${Date.now()}`);
      imageErr = '';
      break;
    } catch (e) {
      imageErr = e?.message || String(e);
    }
  }
  if (!imagePath) throw new Error(`Image generation failed: ${imageErr}`);

  const jobId = await repository.createJob(chatId, {
    sheetRow: topic.sheetRow,
    topic: topic.topic,
    status: STATUS.READY,
    imageAttempts,
    text,
    imagePath,
    correlationId: corrId
  });

  await repository.createPost(chatId, jobId, text, extractHashtags(text));
  await repository.createAsset(chatId, jobId, 'image', imagePath, 'openai:gpt-image-1');
  await repository.setSheetState(chatId, topic.sheetRow, STATUS.READY, reason);

  return { ok: true, jobId, topic, text, imagePath, correlationId: corrId };
}

async function sendDraftToModerator(chatId, bot, draft) {
  const settings = getContentSettings(chatId);
  const caption = [
    `📝 Черновик #${draft.jobId}`,
    `Тема: ${draft.topic.topic}`,
    draft.correlationId ? `📋 ${draft.correlationId}` : '',
    '',
    draft.text
  ].filter(Boolean).join('\n').slice(0, 1024);

  const callbackBase = `content:${draft.jobId}`;
  const kb = {
    inline_keyboard: [
      [
        { text: '✅ Approve', callback_data: `${callbackBase}:approve` },
        { text: '🔁 Regenerate Text', callback_data: `${callbackBase}:regen_text` }
      ],
      [
        { text: '🖼 Regenerate Image', callback_data: `${callbackBase}:regen_image` },
        { text: '❌ Reject', callback_data: `${callbackBase}:reject` }
      ]
    ]
  };

  const session = await sessionService.getOrCreateSession(chatId);
  const tempPath = path.join(os.tmpdir(), `draft-${chatId}-${draft.jobId}.png`);
  await dockerService.copyFromContainer(session.containerId, draft.imagePath, tempPath);
  const sent = await bot.telegram.sendPhoto(settings.moderatorUserId, { source: tempPath }, { caption, reply_markup: kb });
  await fs.unlink(tempPath).catch(() => {});

  await setDraft(chatId, String(draft.jobId), {
    ...draft,
    moderationMessageId: sent.message_id,
    rejectedCount: draft.rejectedCount || 0
  });
}

async function publishDraft(chatId, bot, draft, correlationId = null) {
  const corrId = correlationId || draft.correlationId || generateCorrelationId();
  const settings = getContentSettings(chatId);

  // TASK-011: Валидация перед публикацией
  const validation = validators.validatePostForPublish(draft);
  if (!validation.valid) {
    const errorMsg = validation.errors.join('; ');
    await repository.addPublishLog(chatId, {
      postId: (await repository.getPostByJobId(chatId, draft.jobId))?.id,
      channelId: settings.channelId,
      status: PUBLISH_LOG_STATUS.FAILED,
      errorText: `Validation failed: ${errorMsg}`,
      correlationId: corrId
    });
    throw new Error(`Post validation failed: ${errorMsg}`);
  }

  // Логируем предупреждения
  if (validation.warnings.length > 0) {
    console.log(`[CONTENT-MVP] Warnings for job ${draft.jobId}:`, validation.warnings);
  }

  const session = await sessionService.getOrCreateSession(chatId);
  const contentType = draft.contentType || 'text+image';
  
  // TASK-016: Подготовка медиа-файлов в зависимости от типа контента
  const tempFiles = []; // Для очистки после публикации
  
  try {
    // Определяем caption в зависимости от типа контента
    const caption = draft.text.slice(0, validators.MAX_CAPTION_LENGTH);
    
    let sent;
    
    if (contentType === 'text+video') {
      // TASK-016: Публикация видео с улучшенной обработкой
      sent = await publishVideo(chatId, bot, draft, session, settings.channelId, caption, tempFiles);
    } else if (contentType === 'text+gallery' && draft.images?.length > 0) {
      // TASK-016: Публикация медиа-группы (галерея)
      sent = await publishMediaGroup(chatId, bot, draft, session, settings.channelId, caption, tempFiles);
    } else if (contentType === 'text-only' || (!draft.imagePath && !draft.videoPath)) {
      // TASK-016: Публикация только текста
      sent = await bot.telegram.sendMessage(settings.channelId, draft.text.slice(0, validators.MAX_TEXT_LENGTH));
    } else {
      // Стандартная публикация изображения
      sent = await publishImage(chatId, bot, draft, session, settings.channelId, caption, tempFiles);
    }

    // Обновляем статусы
    await repository.withLockedPost(chatId, draft.jobId, async (client, post) => {
      const postId = post.id;
      const publishStatus = String(post.publish_status || '').toLowerCase();

      // Проверяем, не опубликован ли уже
      const alreadyPublished = await repository.isPostPublished(chatId, postId);
      if (publishStatus === STATUS.PUBLISHED || alreadyPublished) {
        await repository.addPublishLog(chatId, {
          postId,
          channelId: settings.channelId,
          status: PUBLISH_LOG_STATUS.SKIPPED_DUPLICATE_PUBLISH,
          errorText: 'already_published',
          correlationId: corrId
        });
        return;
      }

      await repository.updateJobStatus(chatId, draft.jobId, STATUS.PUBLISHED);
      await repository.updatePost(chatId, postId, { publishStatus: STATUS.PUBLISHED });
      
      // Для media group сохраняем все message_id
      const messageIds = Array.isArray(sent) 
        ? sent.map(s => String(s.message_id)).join(',')
        : String(sent.message_id);
      
      await repository.addPublishLog(chatId, {
        postId,
        channelId: settings.channelId,
        telegramMessageId: messageIds,
        status: PUBLISH_LOG_STATUS.PUBLISHED,
        correlationId: corrId
      });
    });

    await repository.setSheetState(chatId, draft.topic.sheetRow, STATUS.PUBLISHED);
    await removeDraft(chatId, String(draft.jobId));
    
  } catch (e) {
    console.error(`[CONTENT-MVP] Publish failed for job ${draft.jobId}:`, e.message);
    throw e;
  } finally {
    // Очищаем временные файлы
    for (const tempPath of tempFiles) {
      await fs.unlink(tempPath).catch(() => {});
    }
  }
}

// ============================================
// TASK-016: Вспомогательные функции публикации
// ============================================

/**
 * Публикация видео с проверкой размера и retry
 */
async function publishVideo(chatId, bot, draft, session, channelId, caption, tempFiles) {
  const tempPath = path.join(os.tmpdir(), `publish-${chatId}-${draft.jobId}.mp4`);
  tempFiles.push(tempPath);
  
  await dockerService.copyFromContainer(session.containerId, draft.videoPath, tempPath);
  
  // Проверяем размер файла
  const stats = await fs.stat(tempPath);
  if (stats.size > validators.MAX_VIDEO_SIZE) {
    throw new Error(`Video file too large: ${Math.round(stats.size / 1024 / 1024)} MB (max ${validators.MAX_VIDEO_SIZE / 1024 / 1024} MB)`);
  }
  
  // Публикация с retry
  const maxRetries = 3;
  let lastError;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const sent = await bot.telegram.sendVideo(channelId, { source: tempPath }, {
        caption,
        supports_streaming: true,
        parse_mode: 'Markdown'
      });
      console.log(`[CONTENT-MVP] Video published for job ${draft.jobId}`);
      return sent;
    } catch (e) {
      lastError = e;
      console.error(`[CONTENT-MVP] Video publish attempt ${attempt} failed:`, e.message);
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, 2000 * attempt)); // Exponential backoff
      }
    }
  }
  
  throw lastError;
}

/**
 * Публикация изображения с retry
 */
async function publishImage(chatId, bot, draft, session, channelId, caption, tempFiles) {
  const tempPath = path.join(os.tmpdir(), `publish-${chatId}-${draft.jobId}.png`);
  tempFiles.push(tempPath);
  
  await dockerService.copyFromContainer(session.containerId, draft.imagePath, tempPath);
  
  // Проверяем размер файла
  const stats = await fs.stat(tempPath);
  if (stats.size > validators.MAX_IMAGE_SIZE) {
    throw new Error(`Image file too large: ${Math.round(stats.size / 1024 / 1024)} MB (max ${validators.MAX_IMAGE_SIZE / 1024 / 1024} MB)`);
  }
  
  // Публикация с retry
  const maxRetries = 3;
  let lastError;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const sent = await bot.telegram.sendPhoto(channelId, { source: tempPath }, {
        caption,
        parse_mode: 'Markdown'
      });
      console.log(`[CONTENT-MVP] Image published for job ${draft.jobId}`);
      return sent;
    } catch (e) {
      lastError = e;
      console.error(`[CONTENT-MVP] Image publish attempt ${attempt} failed:`, e.message);
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, 2000 * attempt));
      }
    }
  }
  
  throw lastError;
}

/**
 * Публикация медиа-группы (галерея)
 * TASK-016: Поддержка до 10 фото/видео в одном посте
 */
async function publishMediaGroup(chatId, bot, draft, session, channelId, caption, tempFiles) {
  if (!draft.images || draft.images.length === 0) {
    throw new Error('No images provided for media group');
  }
  
  // Ограничиваем количество элементов (Telegram max = 10)
  const images = draft.images.slice(0, validators.MAX_MEDIA_GROUP_SIZE);
  
  // Скачиваем все изображения из контейнера
  const mediaItems = [];
  
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    const ext = img.path?.split('.').pop()?.toLowerCase() || 'png';
    const tempPath = path.join(os.tmpdir(), `publish-${chatId}-${draft.jobId}-${i}.${ext}`);
    tempFiles.push(tempPath);
    
    await dockerService.copyFromContainer(session.containerId, img.path, tempPath);
    
    // Проверяем размер
    const stats = await fs.stat(tempPath);
    if (stats.size > validators.MAX_IMAGE_SIZE) {
      console.warn(`[CONTENT-MVP] Image ${i} too large, skipping: ${Math.round(stats.size / 1024 / 1024)} MB`);
      continue;
    }
    
    // Определяем тип медиа
    const isVideo = ['mp4', 'mov', 'webm', 'gif'].includes(ext);
    const mediaType = isVideo ? 'video' : 'photo';
    
    mediaItems.push({
      type: mediaType,
      media: { source: tempPath },
      // Caption только для первого элемента
      caption: i === 0 ? caption : undefined,
      parse_mode: i === 0 ? 'Markdown' : undefined
    });
  }
  
  if (mediaItems.length === 0) {
    throw new Error('No valid media items for gallery');
  }
  
  // Публикация с retry
  const maxRetries = 3;
  let lastError;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const sent = await bot.telegram.sendMediaGroup(channelId, mediaItems);
      console.log(`[CONTENT-MVP] Media group published for job ${draft.jobId} (${mediaItems.length} items)`);
      return sent;
    } catch (e) {
      lastError = e;
      console.error(`[CONTENT-MVP] Media group publish attempt ${attempt} failed:`, e.message);
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, 2000 * attempt));
      }
    }
  }
  
  throw lastError;
}

async function regenerateDraftPart(chatId, draft, part, correlationId = null) {
  const corrId = correlationId || draft.correlationId || generateCorrelationId();
  const topic = draft.topic;
  
  if (part === 'text') {
    const materialsText = await loadDriveMaterialsText(12);
    const text = await generatePostText(chatId, topic, materialsText);
    draft.text = text;
  } else if (part === 'image') {
    const imageBuffer = await generateImage(topic, draft.text);
    draft.imagePath = await saveImageToUserWorkspace(chatId, imageBuffer, `${topic.sheetRow}_${Date.now()}`);
  } else if (part === 'video') {
    // TASK-015: Регенерация видео
    const videoPrompt = `Сгенерируй короткое видео для Telegram-поста. Тема: ${topic.topic}. Текст поста: ${draft.text}. Стиль: динамичный, коммерческий, без текста на видео.`;
    
    const generation = await videoService.startVideoGeneration(chatId, {
      prompt: videoPrompt,
      correlationId: corrId,
      params: { duration: 5, ratio: '16:9' }
    });
    
    // Ждём завершения генерации (синхронно для простоты)
    const startTime = Date.now();
    const timeout = videoService.VIDEO_TIMEOUT_SEC * 1000;
    
    while (Date.now() - startTime < timeout) {
      const status = await videoService.checkVideoStatus(chatId, generation.generationId);
      
      if (status.status === VIDEO_STATUS.COMPLETED && status.videoUrl) {
        const videoBuffer = await videoService.downloadVideo(status.videoUrl);
        draft.videoPath = await saveVideoToUserWorkspace(chatId, videoBuffer, `${topic.sheetRow}_${Date.now()}`);
        break;
      } else if (status.status === VIDEO_STATUS.FAILED || status.status === VIDEO_STATUS.TIMEOUT) {
        // Fallback на изображение
        if (VIDEO_FALLBACK_ENABLED) {
          const imageBuffer = await generateImage(topic, draft.text);
          draft.imagePath = await saveImageToUserWorkspace(chatId, imageBuffer, `${topic.sheetRow}_${Date.now()}`);
          draft.contentType = 'text+image';
        }
        break;
      }
      
      await new Promise(r => setTimeout(r, videoService.VIDEO_POLL_INTERVAL_SEC * 1000));
    }
    
    // Если таймаут — fallback
    if (!draft.videoPath && !draft.imagePath && VIDEO_FALLBACK_ENABLED) {
      const imageBuffer = await generateImage(topic, draft.text);
      draft.imagePath = await saveImageToUserWorkspace(chatId, imageBuffer, `${topic.sheetRow}_${Date.now()}`);
      draft.contentType = 'text+image';
    }
  }

  await repository.updateJob(chatId, draft.jobId, {
    draftText: draft.text,
    imagePath: draft.imagePath,
    videoPath: draft.videoPath,
    contentType: draft.contentType,
    correlationId: corrId
  });
  await repository.updatePost(chatId, (await repository.getPostByJobId(chatId, draft.jobId))?.id, {
    bodyText: draft.text,
    hashtags: extractHashtags(draft.text)
  });

  await setDraft(chatId, String(draft.jobId), draft);
  return draft;
}

async function handleModerationAction(chatId, bot, action, jobId) {
  const draft = getDrafts(chatId)[String(jobId)];
  if (!draft) return { ok: false, message: 'Черновик не найден.' };

  const correlationId = draft.correlationId || generateCorrelationId();

  if (action === 'approve') {
    // TASK-007: Ставим задачу публикации в очередь
    await queueRepo.ensureQueueSchema(chatId);
    await queueRepo.enqueue(chatId, {
      jobType: 'publish',
      jobId: draft.jobId,
      priority: 10, // Высокий приоритет для approve
      payload: { jobId: draft.jobId, reason: 'approve' },
      correlationId
    });
    return { ok: true, message: `Пост #${jobId} поставлен в очередь на публикацию.` };
  }
  
  if (action === 'regen_text') {
    const refreshed = await regenerateDraftPart(chatId, draft, 'text', correlationId);
    await sendDraftToModerator(chatId, bot, refreshed);
    return { ok: true, message: 'Текст перегенерирован и повторно отправлен на согласование.' };
  }
  
  if (action === 'regen_image') {
    const refreshed = await regenerateDraftPart(chatId, draft, 'image', correlationId);
    await sendDraftToModerator(chatId, bot, refreshed);
    return { ok: true, message: 'Изображение перегенерировано и повторно отправлено на согласование.' };
  }
  
  // TASK-015: Regenerate video
  if (action === 'regen_video') {
    const refreshed = await regenerateDraftPart(chatId, draft, 'video', correlationId);
    await sendVideoDraftToModerator(chatId, bot, refreshed);
    return { ok: true, message: 'Видео перегенерировано и повторно отправлено на согласование.' };
  }
  
  if (action === 'reject') {
    draft.rejectedCount = (draft.rejectedCount || 0) + 1;
    if (draft.rejectedCount >= 3) {
      await repository.setSheetState(chatId, draft.topic.sheetRow, 'MANUAL_REWORK_REQUIRED', 'Rejected 3 times');
      await setDraft(chatId, String(jobId), draft);
      return { ok: true, message: 'Черновик отклонен 3 раза. Нужна ручная переработка.' };
    }
    const refreshed = await regenerateDraftPart(chatId, draft, 'text', correlationId);
    await regenerateDraftPart(chatId, refreshed, draft.contentType === 'text+video' ? 'video' : 'image', correlationId);
    if (draft.contentType === 'text+video') {
      await sendVideoDraftToModerator(chatId, bot, refreshed);
    } else {
      await sendDraftToModerator(chatId, bot, refreshed);
    }
    await setDraft(chatId, String(jobId), draft);
    return { ok: true, message: `Черновик отклонен. Автоперегенерация выполнена и отправлена на согласование (${draft.rejectedCount}/3).` };
  }
  
  return { ok: false, message: 'Неизвестное действие.' };
}

// ============================================
// TASK-007: Scheduler через enqueue
// ============================================

async function runNow(chatId, bot, reason = 'manual') {
  await repository.ensureSchema(chatId);
  await queueRepo.ensureQueueSchema(chatId);

  const settings = getContentSettings(chatId);
  const now = getNowInTz(settings.scheduleTz);
  const publishedToday = await repository.countPublishedToday(chatId, now.date, settings.scheduleTz);
  
  if (publishedToday >= settings.dailyLimit) {
    return { ok: false, message: `Лимит публикаций на сегодня исчерпан (${publishedToday}/${settings.dailyLimit}).` };
  }

  const correlationId = generateCorrelationId();

  // TASK-007: Ставим задачу в очередь вместо синхронного выполнения
  const queueJobId = await queueRepo.enqueue(chatId, {
    jobType: 'generate',
    priority: reason === 'schedule' ? 0 : 5, // Выше приоритет для ручного запуска
    payload: { reason },
    correlationId
  });

  return { 
    ok: true, 
    message: `Задача генерации #${queueJobId} поставлена в очередь.`, 
    queueJobId,
    correlationId 
  };
}

async function tickScheduleForChat(chatId, bot) {
  const settings = getContentSettings(chatId);
  const now = getNowInTz(settings.scheduleTz);
  
  if (now.time !== settings.scheduleTime) return;

  const data = manageStore.getState(chatId) || {};
  const key = `contentLastRunDate:${settings.scheduleTime}`;
  
  if (data[key] === now.date) return;
  
  data[key] = now.date;
  if (!manageStore.getState(chatId)) {
    manageStore.getAllStates()[chatId] = data;
  }
  await manageStore.persist(chatId);
  
  await runNow(chatId, bot, 'schedule');
}

// ============================================
// API Methods
// ============================================

async function listJobs(chatId, options = {}) {
  await repository.ensureSchema(chatId);
  return repository.listJobs(chatId, options);
}

async function getJobById(chatId, jobId) {
  await repository.ensureSchema(chatId);
  return repository.getJobWithDetails(chatId, jobId);
}

async function getMetrics(chatId) {
  await repository.ensureSchema(chatId);
  
  return repository.withClient(chatId, async (client) => {
    const published24hRes = await client.query(
      `SELECT COUNT(*)::int AS c FROM publish_logs
       WHERE status=$1 AND created_at >= NOW() - INTERVAL '24 hours'`,
      [PUBLISH_LOG_STATUS.PUBLISHED]
    );
    const published7dRes = await client.query(
      `SELECT COUNT(*)::int AS c FROM publish_logs
       WHERE status=$1 AND created_at >= NOW() - INTERVAL '7 days'`,
      [PUBLISH_LOG_STATUS.PUBLISHED]
    );
    const failed24hRes = await client.query(
      `SELECT COUNT(*)::int AS c FROM publish_logs
       WHERE status=$1 AND created_at >= NOW() - INTERVAL '24 hours'`,
      [PUBLISH_LOG_STATUS.FAILED]
    );
    const skipped24hRes = await client.query(
      `SELECT COUNT(*)::int AS c FROM publish_logs
       WHERE status=$1 AND created_at >= NOW() - INTERVAL '24 hours'`,
      [PUBLISH_LOG_STATUS.SKIPPED_DUPLICATE_PUBLISH]
    );
    const pipeline24hRes = await client.query(
      `SELECT COUNT(*)::int AS c FROM content_jobs
       WHERE created_at >= NOW() - INTERVAL '24 hours'`
    );
    const latencyRes = await client.query(
      `SELECT
         COALESCE(AVG(EXTRACT(EPOCH FROM (updated_at - created_at))) FILTER (WHERE status=$1), 0)::int AS published_avg_sec,
         COALESCE(AVG(EXTRACT(EPOCH FROM (updated_at - created_at))) FILTER (WHERE status=$2), 0)::int AS failed_avg_sec
       FROM content_jobs
       WHERE created_at >= NOW() - INTERVAL '7 days'`,
      [STATUS.PUBLISHED, STATUS.FAILED]
    );

    const published24h = published24hRes.rows[0]?.c || 0;
    const failed24h = failed24hRes.rows[0]?.c || 0;
    const totalAttempts24h = published24h + failed24h;
    const successRate24h = totalAttempts24h > 0 ? Number((published24h / totalAttempts24h).toFixed(4)) : null;

    return {
      windows: {
        last24h: {
          pipeline_runs: pipeline24hRes.rows[0]?.c || 0,
          published: published24h,
          failed: failed24h,
          skipped_duplicate_publish: skipped24hRes.rows[0]?.c || 0,
          success_rate: successRate24h
        },
        last7d: {
          published: published7dRes.rows[0]?.c || 0
        }
      },
      latency_seconds: {
        published_avg: latencyRes.rows[0]?.published_avg_sec || 0,
        failed_avg: latencyRes.rows[0]?.failed_avg_sec || 0
      }
    };
  });
}

// ============================================
// Scheduler & Worker Initialization
// ============================================

function startScheduler(getBots) {
  botsGetter = getBots;
  
  // Регистрируем обработчики задач
  worker.registerJobHandler('generate', handleGenerateJob);
  worker.registerJobHandler('publish', handlePublishJob);
  
  // TASK-015: Регистрируем callback для завершения генерации видео
  worker.registerVideoCallback(handleVideoGenerationComplete);
  
  // Запускаем worker для обработки очереди
  worker.startWorker(getBots);
  
  // Запускаем планировщик
  if (schedulerHandle) clearInterval(schedulerHandle);
  schedulerHandle = setInterval(async () => {
    try {
      const bots = getBots();
      for (const [chatId, entry] of bots.entries()) {
        await tickScheduleForChat(chatId, entry.bot);
        
        // TASK-014: Проверка алертов раз в час
        const now = new Date();
        if (now.getMinutes() < 5) { // Первые 5 минут каждого часа
          const settings = getContentSettings(chatId);
          await alerts.checkAndAlert(chatId, {
            bot: entry.bot,
            moderatorUserId: settings.moderatorUserId
          });
        }
      }
    } catch (e) {
      console.error('[CONTENT-MVP-SCHEDULER]', e.message);
    }
  }, 60 * 1000);
  
  console.log('[CONTENT-MVP] Scheduler and worker started');
}

function stopScheduler() {
  if (schedulerHandle) {
    clearInterval(schedulerHandle);
    schedulerHandle = null;
  }
  worker.stopWorker();
  console.log('[CONTENT-MVP] Scheduler and worker stopped');
}

// ============================================
// Exports
// ============================================

module.exports = {
  // Основные методы
  startScheduler,
  stopScheduler,
  runNow,
  handleModerationAction,
  ensureSchema: repository.ensureSchema,
  listJobs,
  getJobById,
  getMetrics,
  
  // Статусы
  STATUS,
  JOB_STATUS,
  QUEUE_STATUS,
  PUBLISH_LOG_STATUS,
  
  // Конфигурация
  getContentSettings,
  setContentSettings,
  
  // Валидация (TASK-001, TASK-011)
  validateJobStatusTransition,
  generateCorrelationId,
  validatePostForPublish: validators.validatePostForPublish,
  autoCorrectPost: validators.autoCorrectPost,
  
  // Лимиты (TASK-012)
  checkQuota: limits.checkQuota,
  getUsageStats: limits.getUsageStats,
  QUOTA_TYPES: limits.QUOTA_TYPES,
  
  // Алерты (TASK-014)
  checkAndAlert: alerts.checkAndAlert,
  
  // Очередь (для прямого доступа)
  enqueue: queueRepo.enqueue,
  getQueueStats: queueRepo.getQueueStats,
  
  // TASK-015: Video
  videoService,
  VIDEO_STATUS,
  VIDEO_FALLBACK_ENABLED,
  handleVideoGenerateJob,
  handleVideoGenerationComplete
};