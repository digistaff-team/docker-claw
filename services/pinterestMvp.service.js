/**
 * Pinterest MVP Service — генерация, модерация, публикация пинов
 * Самостоятельный пайплайн, не зависит от contentMvp.service.js
 */
const path = require('path');
const os = require('os');
const fs = require('fs').promises;
const fetch = require('node-fetch');
const config = require('../config');
const aiRouterService = require('./ai_router_service');
const manageStore = require('../manage/store');
const sessionService = require('./session.service');
const dockerService = require('./docker.service');
const storageService = require('./storage.service');
const pinterestService = require('./pinterest.service');
const imageService = require('./image.service');
const pinterestRepo = require('./content/pinterest.repository');

const contentModules = require('./content/index');
const {
  generateCorrelationId,
  repository,
  queueRepo,
  worker
} = contentModules;

const SCHEDULE_TZ = process.env.CONTENT_MVP_TZ || 'Europe/Moscow';
const MAX_IMAGE_ATTEMPTS = 3;
const MAX_REJECT_ATTEMPTS = 3;
const DAILY_PIN_LIMIT = parseInt(process.env.PINTEREST_DAILY_LIMIT || '10', 10);
const PROFILE_FILES = ['IDENTITY.md', 'SOUL.md'];

let schedulerHandle = null;
let botsGetter = null;

// ============================================
// Утилиты
// ============================================

function getNowInTz(tz) {
  const p = new Intl.DateTimeFormat('sv-SE', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  }).formatToParts(new Date());
  const get = (t) => p.find((x) => x.type === t)?.value;
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    time: `${get('hour')}:${get('minute')}`
  };
}

function getPinterestSettings(chatId) {
  const cfg = manageStore.getPinterestConfig(chatId);
  return {
    isActive: !!cfg?.is_active,
    autoPublish: !!cfg?.auto_publish,
    boardRotation: cfg?.board_rotation || 'random',
    boards: Array.isArray(cfg?.boards) ? cfg.boards : [],
    boardId: cfg?.board_id || null,
    boardName: cfg?.board_name || null,
    websiteUrl: cfg?.website_url || '',
    lastBoardIndex: cfg?.last_board_index || 0,
    scheduleTime: cfg?.schedule_time || '10:00',
    publishIntervalHours: Number.isFinite(cfg?.publish_interval_hours) ? cfg.publish_interval_hours : 4,
    stats: cfg?.stats || { total_pins: 0, pins_today: 0, last_pin_date: null }
  };
}

// ============================================
// Ротация досок (Фаза 6)
// ============================================

function selectNextBoard(chatId) {
  const cfg = manageStore.getPinterestConfig(chatId);
  if (!cfg) return null;

  const boards = Array.isArray(cfg.boards) ? cfg.boards : [];

  if (boards.length === 0) {
    if (cfg.board_id) {
      return { board_id: cfg.board_id, board_name: cfg.board_name || '', keywords: '', link: cfg.website_url || '' };
    }
    return null;
  }

  if (cfg.board_rotation === 'round_robin') {
    const idx = (cfg.last_board_index || 0) % boards.length;
    manageStore.setPinterestConfig(chatId, { last_board_index: idx + 1 });
    return boards[idx];
  }

  // random
  const idx = Math.floor(Math.random() * boards.length);
  return boards[idx];
}

// ============================================
// Загрузка контента пользователя
// ============================================

async function loadMaterialsText(chatId, limit = 10) {
  await repository.ensureSchema(chatId);
  const materials = await repository.loadMaterials(chatId, limit);
  const parts = [];
  for (const item of materials) {
    const content = String(item.content || '').trim();
    if (!content) continue;
    parts.push(`### ${item.title}\n${content.slice(0, 4000)}`);
  }
  return parts.join('\n\n').slice(0, 20000);
}

async function loadUserPersona(chatId) {
  const storageDir = storageService.getDataDir(String(chatId));
  const repoDir = path.resolve(__dirname, '..', 'data', `user_${chatId}`);
  const dirs = [repoDir, storageDir];
  const sections = [];

  for (const fileName of PROFILE_FILES) {
    for (const dir of dirs) {
      try {
        const text = await fs.readFile(path.join(dir, fileName), 'utf8');
        if (text.trim()) {
          sections.push(`## ${fileName.replace(/\.md$/i, '')}\n${text.trim().slice(0, 4000)}`);
          break;
        }
      } catch { /* next */ }
    }
  }

  return sections.join('\n\n').slice(0, 16000);
}

// ============================================
// AI-генерация для Pinterest
// ============================================

async function generatePinText(chatId, topic, board, materialsText, personaText) {
  const data = manageStore.getState(chatId);
  const hasApiKey = data?.aiCustomApiKey || data?.aiAuthToken;
  if (!hasApiKey || !data?.aiModel) {
    throw new Error('AI model is not configured');
  }

  const boardContext = board ? `Доска Pinterest: "${board.board_name || ''}". Ключевые слова доски: ${board.keywords || 'нет'}.` : '';
  const prompt = `Ты Pinterest-маркетолог. Создай контент для пина.

Тема: ${topic.topic}
${topic.focus ? `Фокус: ${topic.focus}` : ''}
${boardContext}

${personaText ? `--- ПЕРСОНА ---\n${personaText}\n---` : ''}
${materialsText ? `--- МАТЕРИАЛЫ ---\n${materialsText}\n---` : ''}

Ответь строго в формате JSON:
{
  "pinTitle": "заголовок пина (максимум 100 символов, привлекательный, с ключевыми словами)",
  "pinDescription": "описание пина (максимум 500 символов, с CTA и ключевыми словами для SEO)",
  "seoKeywords": ["ключевое1", "ключевое2", "ключевое3"]
}

Требования:
- pinTitle: до 100 символов, цепляющий, содержит основное ключевое слово
- pinDescription: до 500 символов, информативный, содержит призыв к действию
- seoKeywords: 3-5 релевантных ключевых слов для Pinterest SEO
- Язык: русский
- Не используй эмодзи в заголовке`;

  const messages = [
    { role: 'system', content: 'Ты Pinterest-маркетолог. Отвечай только JSON.' },
    { role: 'user', content: prompt }
  ];

  const authToken = data.aiCustomApiKey || data.aiAuthToken;
  const resp = await aiRouterService.callAI(chatId, authToken, data.aiModel, messages, null, data.aiUserEmail);
  const content = resp?.choices?.[0]?.message?.content || '';

  // Парсим JSON из ответа
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('AI did not return valid JSON');
  }

  const parsed = JSON.parse(jsonMatch[0]);
  return {
    pinTitle: String(parsed.pinTitle || '').slice(0, 100),
    pinDescription: String(parsed.pinDescription || '').slice(0, 500),
    seoKeywords: Array.isArray(parsed.seoKeywords) ? parsed.seoKeywords.slice(0, 5) : []
  };
}

async function generatePinImage(topic, pinTitle) {
  const apiKey = process.env.KIE_API_KEY;
  if (!apiKey) throw new Error('KIE_API_KEY is not set');

  const prompt = `Pinterest pin image. Topic: ${topic.topic}. Title: ${pinTitle}. Style: vertical, aesthetic, clean, visually appealing, no text overlay, no logos, professional photography style.`.slice(0, 800);

  const createResp = await fetch('https://api.kie.ai/api/v1/jobs/createTask', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'grok-imagine/text-to-image',
      input: {
        prompt,
        aspect_ratio: '2:3',
        nsfw_checker: true
      }
    }),
    timeout: 30000
  });

  if (!createResp.ok) {
    const err = await createResp.text();
    throw new Error(`Image API createTask failed: ${createResp.status} ${err.slice(0, 300)}`);
  }
  const createData = await createResp.json();
  if (createData.code !== 200) {
    throw new Error(`Image API createTask error: ${createData.msg}`);
  }
  const taskId = createData?.data?.taskId;
  if (!taskId) throw new Error('Image API: no taskId');

  // Polling (max 90 sec)
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
      if (!imageUrl) throw new Error('Image API: no result URL');
      const imgResp = await fetch(imageUrl, { timeout: 30000 });
      if (!imgResp.ok) throw new Error(`Image download failed: ${imgResp.status}`);
      return await imgResp.buffer();
    }
    if (state === 'fail') {
      throw new Error(`Image generation failed: ${pollData.data.failMsg || 'unknown'}`);
    }
  }
  throw new Error('Image generation timeout');
}

async function saveImageToContainer(chatId, buffer, jobId) {
  const session = await sessionService.getOrCreateSession(chatId);
  const localTmp = path.join(os.tmpdir(), `pin-image-${chatId}-${jobId}.png`);
  await fs.writeFile(localTmp, buffer);
  const containerPath = `/workspace/output/content/pin_${jobId}.png`;
  await sessionService.executeCommand(chatId, 'mkdir -p /workspace/output/content', 10);
  await dockerService.copyToContainer(localTmp, session.containerId, containerPath);
  await fs.unlink(localTmp).catch(() => {});
  return containerPath;
}

// ============================================
// Draft Management (in-memory)
// ============================================

function getDrafts(chatId) {
  const data = manageStore.getState(chatId) || {};
  return data.pinterestDrafts || {};
}

function setDraft(chatId, draftId, draft) {
  const data = manageStore.getState(chatId) || {};
  data.pinterestDrafts = data.pinterestDrafts || {};
  data.pinterestDrafts[draftId] = draft;
  if (!manageStore.getState(chatId)) {
    manageStore.getAllStates()[chatId] = data;
  }
  return manageStore.persist(chatId);
}

async function removeDraft(chatId, draftId) {
  const data = manageStore.getState(chatId) || {};
  if (data.pinterestDrafts && data.pinterestDrafts[draftId]) {
    delete data.pinterestDrafts[draftId];
    await manageStore.persist(chatId);
  }
}

// ============================================
// Генерация пина
// ============================================

async function handlePinterestGenerateJob(chatId, queueJob, bot, correlationId) {
  const settings = getPinterestSettings(chatId);

  await repository.ensureSchema(chatId);

  // Дневной лимит
  const publishedToday = await pinterestRepo.countPublishedToday(chatId, SCHEDULE_TZ);
  if (publishedToday >= DAILY_PIN_LIMIT) {
    return { success: false, error: `Дневной лимит пинов исчерпан (${publishedToday}/${DAILY_PIN_LIMIT})`, retry: false };
  }

  // Выбор доски
  const board = selectNextBoard(chatId);
  if (!board) {
    return { success: false, error: 'Нет настроенных досок Pinterest', retry: false };
  }

  // Выбор темы
  const topicRow = await repository.reserveNextTopic(chatId);
  if (!topicRow) {
    return { success: false, error: 'Нет доступных тем', retry: false };
  }
  const topic = {
    sheetRow: topicRow.id,
    topic: topicRow.topic,
    focus: topicRow.focus || '',
    secondary: topicRow.secondary || '',
    lsi: topicRow.lsi || ''
  };

  // Загрузка материалов и персоны
  const [materialsText, personaText] = await Promise.all([
    loadMaterialsText(chatId, 12),
    loadUserPersona(chatId)
  ]);

  // Генерация текста пина
  let pinText;
  try {
    pinText = await generatePinText(chatId, topic, board, materialsText, personaText);
  } catch (e) {
    await repository.updateTopicStatus(chatId, topic.sheetRow, 'pending', `pin_text_failed: ${e.message}`);
    return { success: false, error: `Pin text generation failed: ${e.message}`, retry: true };
  }

  // Генерация изображения (портрет 2:3)
  let imagePath = '';
  let imageAttempts = 0;
  let imageErr = '';
  for (let i = 1; i <= MAX_IMAGE_ATTEMPTS; i++) {
    try {
      imageAttempts = i;
      const imageBuffer = await generatePinImage(topic, pinText.pinTitle);
      // Создаём временный job id для сохранения
      const tempId = `${topic.sheetRow}_${Date.now()}`;
      imagePath = await saveImageToContainer(chatId, imageBuffer, tempId);
      imageErr = '';
      break;
    } catch (e) {
      imageErr = e?.message || String(e);
    }
  }
  if (!imagePath) {
    await repository.updateTopicStatus(chatId, topic.sheetRow, 'pending', `pin_image_failed: ${imageErr}`);
    return { success: false, error: `Pin image generation failed: ${imageErr}`, retry: true };
  }

  // Запись в БД
  const link = board.link || settings.websiteUrl || '';
  const jobId = await pinterestRepo.createJob(chatId, {
    topic: topic.topic,
    boardId: board.board_id,
    boardName: board.board_name || '',
    pinTitle: pinText.pinTitle,
    pinDescription: pinText.pinDescription,
    seoKeywords: JSON.stringify(pinText.seoKeywords),
    imagePath,
    link,
    status: 'ready',
    imageAttempts,
    correlationId
  });

  const draft = {
    jobId,
    topic,
    board,
    pinTitle: pinText.pinTitle,
    pinDescription: pinText.pinDescription,
    seoKeywords: pinText.seoKeywords,
    imagePath,
    link,
    correlationId,
    rejectedCount: 0
  };

  // Маршрутизация
  if (settings.autoPublish) {
    await setDraft(chatId, String(jobId), draft);
    await publishPin(chatId, bot, jobId, correlationId);
  } else {
    await sendPinToModerator(chatId, bot, draft);
  }

  return { success: true, data: { jobId } };
}

// ============================================
// Публикация пина
// ============================================

async function publishPin(chatId, bot, jobId, correlationId) {
  const corrId = correlationId || generateCorrelationId();
  const job = await pinterestRepo.getJobById(chatId, jobId);
  if (!job) throw new Error(`Pinterest job ${jobId} not found`);

  const cfg = manageStore.getPinterestConfig(chatId);
  if (!cfg) throw new Error('Pinterest не настроен');

  // Копируем изображение из контейнера
  const session = await sessionService.getOrCreateSession(chatId);
  const tempPath = path.join(os.tmpdir(), `pin-publish-${chatId}-${jobId}.png`);
  await dockerService.copyFromContainer(session.containerId, job.image_path, tempPath);

  let imageBuffer = await fs.readFile(tempPath);
  await fs.unlink(tempPath).catch(() => {});

  // Водяной знак
  const logoPath = '/workspace/brand/logo.png';
  const logoLocalPath = path.join(os.tmpdir(), `pin-logo-${chatId}.png`);
  try {
    await dockerService.copyFromContainer(session.containerId, logoPath, logoLocalPath);
    imageBuffer = await imageService.overlayWatermark(imageBuffer, logoLocalPath);
    await fs.unlink(logoLocalPath).catch(() => {});
  } catch (e) {
    console.log(`[PINTEREST-MVP] Watermark skipped: ${e.message}`);
  }

  // Получаем токен
  const accessToken = await pinterestService.getValidToken(chatId, cfg);

  // Создаём пин через API
  const imageBase64 = imageBuffer.toString('base64');
  const result = await pinterestService.createPin(accessToken, {
    boardId: job.board_id,
    title: job.pin_title,
    description: job.pin_description,
    link: job.link || undefined,
    mediaSource: {
      source_type: 'image_base64',
      content_type: 'image/png',
      data: imageBase64
    }
  });

  // Запись в лог
  await pinterestRepo.addPublishLog(chatId, {
    jobId,
    boardId: job.board_id,
    pinId: result.id || null,
    status: 'published',
    correlationId: corrId
  });

  // Обновить статус джобы
  await pinterestRepo.updateJob(chatId, jobId, { status: 'published' });

  // Обновить статистику
  const stats = cfg.stats || {};
  const today = getNowInTz(SCHEDULE_TZ).date;
  const pinsToday = stats.last_pin_date === today ? (stats.pins_today || 0) + 1 : 1;
  await manageStore.setPinterestConfig(chatId, {
    stats: {
      total_pins: (stats.total_pins || 0) + 1,
      pins_today: pinsToday,
      last_pin_date: today
    }
  });

  // Удалить черновик
  await removeDraft(chatId, String(jobId));

  // Уведомление в бот
  if (bot?.telegram) {
    const msg = `📌 Пин опубликован!\n${job.pin_title}\n→ Доска: ${job.board_name || job.board_id}`;
    await bot.telegram.sendMessage(chatId, msg).catch(() => {});
  }

  return result;
}

// ============================================
// Модерация
// ============================================

async function sendPinToModerator(chatId, bot, draft) {
  const settings = getPinterestSettings(chatId);
  const moderatorId = manageStore.getContentSettings?.(chatId)?.moderatorUserId || chatId;

  const caption = [
    `📌 Pinterest → ${draft.board?.board_name || 'Board'}`,
    '',
    `Заголовок: ${draft.pinTitle}`,
    '',
    draft.pinDescription,
    '',
    draft.link ? `🔗 ${draft.link}` : '',
    draft.correlationId ? `📋 ${draft.correlationId}` : ''
  ].filter(Boolean).join('\n').slice(0, 1024);

  const callbackBase = `pin_mod:${draft.jobId}`;
  const kb = {
    inline_keyboard: [
      [
        { text: '✅ Одобрить', callback_data: `${callbackBase}:approve` },
        { text: '❌ Отклонить', callback_data: `${callbackBase}:reject` }
      ],
      [
        { text: '🔁 Текст', callback_data: `${callbackBase}:regen_text` },
        { text: '🖼 Фото', callback_data: `${callbackBase}:regen_image` }
      ]
    ]
  };

  const session = await sessionService.getOrCreateSession(chatId);
  const tempPath = path.join(os.tmpdir(), `pin-mod-${chatId}-${draft.jobId}.png`);
  await dockerService.copyFromContainer(session.containerId, draft.imagePath, tempPath);
  const sent = await bot.telegram.sendPhoto(moderatorId, { source: tempPath }, { caption, reply_markup: kb });
  await fs.unlink(tempPath).catch(() => {});

  await setDraft(chatId, String(draft.jobId), {
    ...draft,
    moderationMessageId: sent.message_id
  });
}

async function handlePinModerationAction(chatId, bot, jobId, action) {
  const draft = getDrafts(chatId)[String(jobId)];
  if (!draft) return { ok: false, message: 'Черновик пина не найден.' };

  const correlationId = draft.correlationId || generateCorrelationId();

  if (action === 'approve') {
    try {
      await publishPin(chatId, bot, jobId, correlationId);
      return { ok: true, message: `📌 Пин #${jobId} опубликован на Pinterest.` };
    } catch (e) {
      await pinterestRepo.addPublishLog(chatId, {
        jobId, boardId: draft.board?.board_id || '', status: 'failed',
        errorText: e.message, correlationId
      });
      await pinterestRepo.updateJob(chatId, jobId, { status: 'failed', errorText: e.message });
      return { ok: false, message: `Ошибка публикации: ${e.message}` };
    }
  }

  if (action === 'regen_text') {
    try {
      const [materialsText, personaText] = await Promise.all([
        loadMaterialsText(chatId, 12),
        loadUserPersona(chatId)
      ]);
      const pinText = await generatePinText(chatId, draft.topic, draft.board, materialsText, personaText);
      draft.pinTitle = pinText.pinTitle;
      draft.pinDescription = pinText.pinDescription;
      draft.seoKeywords = pinText.seoKeywords;
      await pinterestRepo.updateJob(chatId, jobId, {
        pinTitle: pinText.pinTitle,
        pinDescription: pinText.pinDescription,
        seoKeywords: JSON.stringify(pinText.seoKeywords)
      });
      await sendPinToModerator(chatId, bot, draft);
      return { ok: true, message: 'Текст пина перегенерирован.' };
    } catch (e) {
      return { ok: false, message: `Ошибка перегенерации текста: ${e.message}` };
    }
  }

  if (action === 'regen_image') {
    try {
      const imageBuffer = await generatePinImage(draft.topic, draft.pinTitle);
      const imagePath = await saveImageToContainer(chatId, imageBuffer, `${jobId}_regen_${Date.now()}`);
      draft.imagePath = imagePath;
      await pinterestRepo.updateJob(chatId, jobId, { imagePath });
      await sendPinToModerator(chatId, bot, draft);
      return { ok: true, message: 'Изображение пина перегенерировано.' };
    } catch (e) {
      return { ok: false, message: `Ошибка перегенерации изображения: ${e.message}` };
    }
  }

  if (action === 'reject') {
    draft.rejectedCount = (draft.rejectedCount || 0) + 1;
    await setDraft(chatId, String(jobId), draft);

    if (draft.rejectedCount >= MAX_REJECT_ATTEMPTS) {
      await pinterestRepo.updateJob(chatId, jobId, { status: 'failed', errorText: 'Rejected 3 times' });
      await removeDraft(chatId, String(jobId));
      return { ok: true, message: `Пин отклонен ${MAX_REJECT_ATTEMPTS} раза. Задача закрыта.` };
    }

    // Полная перегенерация
    try {
      const [materialsText, personaText] = await Promise.all([
        loadMaterialsText(chatId, 12),
        loadUserPersona(chatId)
      ]);
      const pinText = await generatePinText(chatId, draft.topic, draft.board, materialsText, personaText);
      const imageBuffer = await generatePinImage(draft.topic, pinText.pinTitle);
      const imagePath = await saveImageToContainer(chatId, imageBuffer, `${jobId}_reject_${Date.now()}`);

      draft.pinTitle = pinText.pinTitle;
      draft.pinDescription = pinText.pinDescription;
      draft.seoKeywords = pinText.seoKeywords;
      draft.imagePath = imagePath;

      await pinterestRepo.updateJob(chatId, jobId, {
        pinTitle: pinText.pinTitle,
        pinDescription: pinText.pinDescription,
        seoKeywords: JSON.stringify(pinText.seoKeywords),
        imagePath,
        rejectedCount: draft.rejectedCount
      });

      await sendPinToModerator(chatId, bot, draft);
      return { ok: true, message: `Пин перегенерирован (${draft.rejectedCount}/${MAX_REJECT_ATTEMPTS}).` };
    } catch (e) {
      return { ok: false, message: `Ошибка перегенерации: ${e.message}` };
    }
  }

  return { ok: false, message: 'Неизвестное действие.' };
}

// ============================================
// Планировщик
// ============================================

async function tickPinterestSchedule(chatId, bot) {
  const cfg = manageStore.getPinterestConfig(chatId);
  if (!cfg || !cfg.is_active) return;

  const settings = getPinterestSettings(chatId);
  const now = getNowInTz(SCHEDULE_TZ);

  // Дневной лимит
  const publishedToday = await pinterestRepo.countPublishedToday(chatId, SCHEDULE_TZ);
  if (publishedToday >= DAILY_PIN_LIMIT) return;

  const [startH, startM] = (settings.scheduleTime || '10:00').split(':').map(Number);
  const [nowH, nowM] = now.time.split(':').map(Number);
  const startMinutes = startH * 60 + startM;
  const nowMinutes = nowH * 60 + nowM;
  const intervalMinutes = Math.round((settings.publishIntervalHours || 4) * 60);

  const data = manageStore.getState(chatId) || {};

  // Фиксированный режим
  let isSlot = false;
  for (let slot = startMinutes; slot < 24 * 60; slot += intervalMinutes) {
    if (nowMinutes === slot) { isSlot = true; break; }
  }
  if (!isSlot) return;

  const key = `pinterestLastRun:${now.time}`;
  if (data[key] === now.date) return;

  data[key] = now.date;
  if (!manageStore.getState(chatId)) {
    manageStore.getAllStates()[chatId] = data;
  }
  await manageStore.persist(chatId);

  // Ставим в очередь
  await queueRepo.ensureQueueSchema(chatId);
  await queueRepo.enqueue(chatId, {
    jobType: 'pinterest_generate',
    priority: 0,
    payload: { reason: 'schedule' },
    correlationId: generateCorrelationId()
  });
}

async function runNow(chatId, bot, reason = 'manual') {
  await repository.ensureSchema(chatId);

  const publishedToday = await pinterestRepo.countPublishedToday(chatId, SCHEDULE_TZ);
  if (publishedToday >= DAILY_PIN_LIMIT) {
    return { ok: false, message: `Дневной лимит пинов исчерпан (${publishedToday}/${DAILY_PIN_LIMIT}).` };
  }

  const correlationId = generateCorrelationId();

  if (reason !== 'schedule') {
    try {
      const result = await handlePinterestGenerateJob(chatId, {
        payload: { reason },
        correlation_id: correlationId
      }, bot, correlationId);
      if (result.success) {
        return { ok: true, message: 'Пин сгенерирован.', correlationId };
      } else {
        return { ok: false, message: result.error || 'Генерация не удалась.', correlationId };
      }
    } catch (e) {
      return { ok: false, message: `Ошибка: ${e.message}`, correlationId };
    }
  }

  await queueRepo.ensureQueueSchema(chatId);
  const queueJobId = await queueRepo.enqueue(chatId, {
    jobType: 'pinterest_generate',
    priority: 0,
    payload: { reason },
    correlationId
  });

  return { ok: true, message: `Pinterest-задача #${queueJobId} в очереди.`, queueJobId, correlationId };
}

// ============================================
// Scheduler & Worker Registration
// ============================================

function startScheduler(getBots) {
  botsGetter = getBots;

  // Регистрируем обработчики задач Pinterest
  worker.registerJobHandler('pinterest_generate', handlePinterestGenerateJob);
  worker.registerJobHandler('pinterest_publish', async (chatId, queueJob, bot, correlationId) => {
    const jobId = queueJob.job_id || queueJob.payload?.jobId;
    if (!jobId) return { success: false, error: 'No jobId', retry: false };
    try {
      await publishPin(chatId, bot, jobId, correlationId);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message, retry: true };
    }
  });

  // Планировщик Pinterest (раз в минуту)
  if (schedulerHandle) clearInterval(schedulerHandle);
  schedulerHandle = setInterval(async () => {
    try {
      const bots = getBots();
      for (const [chatId, entry] of bots.entries()) {
        await tickPinterestSchedule(chatId, entry.bot);
      }
    } catch (e) {
      console.error('[PINTEREST-MVP-SCHEDULER]', e.message);
    }
  }, 60 * 1000);

  console.log('[PINTEREST-MVP] Scheduler started');
}

function stopScheduler() {
  if (schedulerHandle) {
    clearInterval(schedulerHandle);
    schedulerHandle = null;
  }
  console.log('[PINTEREST-MVP] Scheduler stopped');
}

// ============================================
// Exports
// ============================================

module.exports = {
  startScheduler,
  stopScheduler,
  runNow,
  handlePinterestGenerateJob,
  publishPin,
  sendPinToModerator,
  handlePinModerationAction,
  tickPinterestSchedule,
  selectNextBoard,
  getPinterestSettings,
  listJobs: (chatId, opts) => pinterestRepo.listJobs(chatId, opts),
  getJobById: (chatId, jobId) => pinterestRepo.getJobById(chatId, jobId)
};
