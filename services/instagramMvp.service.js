/**
 * Instagram MVP Service — генерация, модерация, публикация Instagram-постов
 * По аналогии с vkMvp.service.js
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
const instagramService = require('./instagram.service');
const imageService = require('./image.service');
const igRepo = require('./content/instagram.repository');

const contentModules = require('./content/index');
const {
  generateCorrelationId,
  repository,
  queueRepo,
  worker
} = contentModules;

let cwBot = null; // Центральный бот премодерации (CW_BOT_TOKEN)

const SCHEDULE_TZ = process.env.CONTENT_MVP_TZ || 'Europe/Moscow';
const MAX_IMAGE_ATTEMPTS = 3;
const MAX_REJECT_ATTEMPTS = 3;
const DAILY_IG_LIMIT = parseInt(process.env.INSTAGRAM_DAILY_LIMIT || '3', 10);
const PROFILE_FILES = ['IDENTITY.md', 'SOUL.md'];
const IG_MODERATION_TIMEOUT_HOURS = parseInt(process.env.INSTAGRAM_MODERATION_TIMEOUT_HOURS || '24', 10);

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

function isValidTz(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch { return false; }
}

function getIgSettings(chatId) {
  const cfg = manageStore.getInstagramConfig(chatId);
  return {
    isActive: !!cfg?.is_active,
    igUserId: cfg?.ig_user_id || null,
    accessToken: cfg?.access_token || null,
    fbPageId: cfg?.fb_page_id || null,
    igUsername: cfg?.ig_username || null,
    scheduleTime: cfg?.schedule_time || '10:00',
    scheduleTz: isValidTz(cfg?.schedule_tz) ? cfg.schedule_tz : SCHEDULE_TZ,
    dailyLimit: cfg?.daily_limit || DAILY_IG_LIMIT,
    publishIntervalHours: Number.isFinite(cfg?.publish_interval_hours) ? cfg.publish_interval_hours : 4,
    premoderationEnabled: cfg?.premoderation_enabled !== false, // по умолчанию включена
    contentType: cfg?.is_reel ? 'reel' : 'photo',
    autoPublish: !!cfg?.auto_publish,
    locationId: cfg?.location_id || null,
    allowedWeekdays: Array.isArray(cfg?.allowed_weekdays) ? cfg.allowed_weekdays : [0, 1, 2, 3, 4, 5, 6],
    moderator_user_id: cfg?.moderator_user_id || null,
    stats: cfg?.stats || { total_posts: 0, posts_today: 0, last_post_date: null }
  };
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
// AI-генерация для Instagram
// ============================================

async function generateIgPostText(chatId, topic, materialsText, personaText) {
  const data = manageStore.getState(chatId);
  const hasApiKey = data?.aiCustomApiKey || data?.aiAuthToken;
  if (!hasApiKey || !data?.aiModel) {
    throw new Error('AI model is not configured');
  }

  const prompt = `Ты SMM-маркетолог Instagram. Создай контент для поста в Instagram.

Тема: ${topic.topic}
${topic.focus ? `Фокус: ${topic.focus}` : ''}

${personaText ? `--- ПЕРСОНА ---\n${personaText}\n---` : ''}
${materialsText ? `--- МАТЕРИАЛЫ ---\n${materialsText}\n---` : ''}

Ответь строго в формате JSON:
{
  "caption": "подпись к посту для Instagram (150–2200 символов, вовлекающая, с хэштегами в конце)",
  "hookText": "хук — цепляющая фраза 4-6 слов для наложения на изображение",
  "imagePrompt": "промпт для генерации изображения на английском (стиль: яркий, Instagram-формат, без текста)"
}

Требования:
- caption: 300–500 символов оптимально, первая строка — хук (цепляет внимание), 5–15 хэштегов в конце, эмодзи как маркеры (2–4), CTA в конце
- hookText: короткая цепляющая фраза для наложения на картинку (4-6 слов, русский)
- imagePrompt: на английском, описание визуала, Instagram-стиль (яркий, квадратный формат 1:1), без текста на изображении
- Стиль: живой, разговорный, без канцелярита
- Язык: русский (кроме imagePrompt)`;

  const messages = [
    { role: 'system', content: 'Ты SMM-маркетолог Instagram. Отвечай только JSON.' },
    { role: 'user', content: prompt }
  ];

  const authToken = data.aiCustomApiKey || data.aiAuthToken;
  const resp = await aiRouterService.callAI(chatId, authToken, data.aiModel, messages, null, data.aiUserEmail);
  const content = resp?.choices?.[0]?.message?.content || '';

  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('AI did not return valid JSON');
  }

  const parsed = JSON.parse(jsonMatch[0]);
  return {
    caption: String(parsed.caption || '').slice(0, 2200),
    hookText: String(parsed.hookText || '').slice(0, 100),
    imagePrompt: String(parsed.imagePrompt || '').slice(0, 800)
  };
}

async function generateIgImage(topic, imagePrompt) {
  const apiKey = process.env.KIE_API_KEY;
  if (!apiKey) throw new Error('KIE_API_KEY is not set');

  const prompt = (imagePrompt || `Instagram post image. Topic: ${topic.topic}. Style: bright, vibrant, Instagram-optimized, square format, no text overlay.`).slice(0, 800);

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
        aspect_ratio: '1:1',
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
  const localTmp = path.join(os.tmpdir(), `ig-image-${chatId}-${jobId}.png`);
  await fs.writeFile(localTmp, buffer);
  const containerPath = `/workspace/output/content/ig_${jobId}.png`;
  await sessionService.executeCommand(chatId, 'mkdir -p /workspace/output/content', 10);
  await dockerService.copyToContainer(localTmp, session.containerId, containerPath);
  await fs.unlink(localTmp).catch(() => {});
  return containerPath;
}

/**
 * Загрузить изображение из контейнера на публичный хостинг
 * Instagram API требует публично доступный URL для image_url
 */
async function uploadImageForInstagram(chatId, imagePath, jobId) {
  const session = await sessionService.getOrCreateSession(chatId);
  const tempPath = path.join(os.tmpdir(), `ig-upload-${chatId}-${jobId}.png`);
  await dockerService.copyFromContainer(session.containerId, imagePath, tempPath);
  const imageBuffer = await fs.readFile(tempPath);
  await fs.unlink(tempPath).catch(() => {});

  // Загрузка через imgbb или другой сервис
  // Используем встроенный сервер как прокси — создаём временный файл в public
  const publicDir = path.resolve(__dirname, '..', 'public', 'tmp');
  await fs.mkdir(publicDir, { recursive: true });
  const publicFileName = `ig_${chatId}_${jobId}_${Date.now()}.png`;
  const publicPath = path.join(publicDir, publicFileName);
  await fs.writeFile(publicPath, imageBuffer);

  // Формируем URL (используем домен из config или fallback)
  const baseUrl = process.env.PUBLIC_URL || process.env.BASE_URL || `http://localhost:${config.PORT || 3015}`;
  const imageUrl = `${baseUrl}/tmp/${publicFileName}`;

  // Запланировать удаление через 10 минут
  setTimeout(async () => {
    try { await fs.unlink(publicPath); } catch { /* ok */ }
  }, 10 * 60 * 1000);

  return imageUrl;
}

// ============================================
// Draft Management (in-memory)
// ============================================

function getDrafts(chatId) {
  const data = manageStore.getState(chatId) || {};
  return data.igDrafts || {};
}

function setDraft(chatId, draftId, draft) {
  const states = manageStore.getAllStates();
  let data = states[chatId];
  if (!data) {
    data = {};
    states[chatId] = data;
  }
  data.igDrafts = data.igDrafts || {};
  data.igDrafts[draftId] = draft;
  return manageStore.persist(chatId);
}

async function removeDraft(chatId, draftId) {
  const data = manageStore.getState(chatId) || {};
  if (data.igDrafts && data.igDrafts[draftId]) {
    delete data.igDrafts[draftId];
    await manageStore.persist(chatId);
  }
}

// ============================================
// Генерация Instagram поста
// ============================================

async function handleIgGenerateJob(chatId, queueJob, bot, correlationId) {
  console.log(`[IG-GENERATE] ${chatId} starting generation, corr=${correlationId}`);
  const settings = getIgSettings(chatId);

  await repository.ensureSchema(chatId);
  await igRepo.ensureSchema(chatId);

  // Дневной лимит
  const publishedToday = await igRepo.countPublishedToday(chatId, settings.scheduleTz);
  if (publishedToday >= settings.dailyLimit) {
    return { success: false, error: `Дневной лимит Instagram-постов исчерпан (${publishedToday}/${settings.dailyLimit})`, retry: false };
  }

  // Проверка дня недели
  const now = new Date();
  let dayOfWeek;
  try {
    const weekdayStr = new Intl.DateTimeFormat('en-US', { timeZone: settings.scheduleTz, weekday: 'short' }).format(now);
    const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    dayOfWeek = weekdayMap[weekdayStr] ?? now.getDay();
  } catch {
    dayOfWeek = now.getDay();
  }
  if (!settings.allowedWeekdays.includes(dayOfWeek)) {
    return { success: false, error: `Публикация не разрешена в этот день недели (${dayOfWeek})`, retry: false };
  }

  // Выбор темы
  console.log(`[IG-GENERATE] ${chatId} selecting topic...`);
  const topicRow = await repository.reserveNextTopic(chatId);
  if (!topicRow) {
    console.log(`[IG-GENERATE] ${chatId} no pending topics available`);
    return { success: false, error: 'Нет доступных тем', retry: false };
  }
  console.log(`[IG-GENERATE] ${chatId} topic selected: id=${topicRow.id}, "${topicRow.topic}"`);
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

  // Генерация текста
  console.log(`[IG-GENERATE] ${chatId} generating text...`);
  let igText;
  try {
    igText = await generateIgPostText(chatId, topic, materialsText, personaText);
    console.log(`[IG-GENERATE] ${chatId} text generated (${(igText.caption || '').length} chars)`);
  } catch (e) {
    console.error(`[IG-GENERATE] ${chatId} text generation failed: ${e.message}`);
    await repository.updateTopicStatus(chatId, topic.sheetRow, 'pending', `ig_text_failed: ${e.message}`);
    return { success: false, error: `IG text generation failed: ${e.message}`, retry: true };
  }

  // Генерация изображения
  console.log(`[IG-GENERATE] ${chatId} generating image...`);
  let imagePath = '';
  let imageAttempts = 0;
  let imageErr = '';
  for (let i = 1; i <= MAX_IMAGE_ATTEMPTS; i++) {
    try {
      imageAttempts = i;
      const imageBuffer = await generateIgImage(topic, igText.imagePrompt);
      const tempId = `${topic.sheetRow}_${Date.now()}`;
      imagePath = await saveImageToContainer(chatId, imageBuffer, tempId);
      imageErr = '';
      break;
    } catch (e) {
      imageErr = e?.message || String(e);
    }
  }
  if (!imagePath) {
    console.error(`[IG-GENERATE] ${chatId} image generation failed after ${imageAttempts} attempts: ${imageErr}`);
    await repository.updateTopicStatus(chatId, topic.sheetRow, 'pending', `ig_image_failed: ${imageErr}`);
    return { success: false, error: `IG image generation failed: ${imageErr}`, retry: true };
  }
  console.log(`[IG-GENERATE] ${chatId} image saved: ${imagePath} (attempts: ${imageAttempts})`);

  // Запись в БД
  const jobId = await igRepo.createJob(chatId, {
    topic: topic.topic,
    igUserId: settings.igUserId,
    caption: igText.caption,
    hookText: igText.hookText,
    imagePrompt: igText.imagePrompt,
    imagePath,
    igContentType: settings.contentType,
    status: 'ready',
    imageAttempts,
    correlationId
  });

  const draft = {
    jobId,
    topic,
    igUserId: settings.igUserId,
    caption: igText.caption,
    hookText: igText.hookText,
    imagePrompt: igText.imagePrompt,
    imagePath,
    correlationId,
    rejectedCount: 0
  };

  // Маршрутизация: модерация или автопубликация
  if (!settings.premoderationEnabled) {
    await setDraft(chatId, String(jobId), draft);
    await publishIgPost(chatId, bot, jobId, correlationId);
  } else {
    await sendIgToModerator(chatId, bot, draft);
  }

  return { success: true, data: { jobId } };
}

// ============================================
// Публикация Instagram поста
// ============================================

async function publishIgPost(chatId, bot, jobId, correlationId) {
  const corrId = correlationId || generateCorrelationId();
  const job = await igRepo.getJobById(chatId, jobId);
  if (!job) throw new Error(`Instagram job ${jobId} not found`);

  const cfg = manageStore.getInstagramConfig(chatId);
  if (!cfg) throw new Error('Instagram не настроен');

  const igUserId = job.ig_user_id || cfg.ig_user_id;
  const accessToken = cfg.access_token;

  if (!igUserId || !accessToken) {
    throw new Error('Instagram ig_user_id или access_token не настроен');
  }

  // Загрузить изображение на публичный URL
  let imageUrl = null;
  if (job.image_path) {
    imageUrl = await uploadImageForInstagram(chatId, job.image_path, jobId);
  }

  // Публикация через Instagram API
  let result;
  if (job.ig_content_type === 'reel' && job.video_path) {
    result = await instagramService.publishReelPost({
      accessToken,
      igUserId,
      videoUrl: job.video_path, // Предполагается публичный URL
      caption: job.caption || '',
      locationId: cfg.location_id
    });
  } else {
    if (!imageUrl) throw new Error('Нет изображения для публикации');
    result = await instagramService.publishPhotoPost({
      accessToken,
      igUserId,
      imageUrl,
      caption: job.caption || '',
      locationId: cfg.location_id
    });
  }

  // Запись в лог
  await igRepo.addPublishLog(chatId, {
    jobId,
    igUserId,
    igMediaId: result.media_id ? String(result.media_id) : null,
    status: 'published',
    correlationId: corrId
  });

  // Обновить статус
  await igRepo.updateJob(chatId, jobId, {
    status: 'published',
    igMediaId: result.media_id ? String(result.media_id) : ''
  });

  // Обновить статистику
  const stats = cfg.stats || {};
  const today = getNowInTz(SCHEDULE_TZ).date;
  const postsToday = stats.last_post_date === today ? (stats.posts_today || 0) + 1 : 1;
  await manageStore.setInstagramConfig(chatId, {
    stats: {
      total_posts: (stats.total_posts || 0) + 1,
      posts_today: postsToday,
      last_post_date: today
    }
  });

  // Удалить черновик
  await removeDraft(chatId, String(jobId));

  // Уведомление
  if (bot?.telegram) {
    const igUsername = cfg.ig_username || igUserId;
    let msg = `📷 Instagram пост опубликован!\n${(job.caption || '').slice(0, 100)}...\n→ https://instagram.com/${igUsername}`;
    await bot.telegram.sendMessage(chatId, msg).catch(() => {});
  }

  return result;
}

// ============================================
// Модерация
// ============================================

async function sendIgToModerator(chatId, bot, draft) {
  const igSettings = getIgSettings(chatId);
  const globalSettings = manageStore.getContentSettings?.(chatId);
  
  // Иерархия: модератор канала → глобальный модератор → chatId
  const moderatorId = igSettings?.moderator_user_id || 
                      globalSettings?.moderatorUserId || 
                      chatId;

  const caption = [
    `📷 Черновик для Instagram #${draft.jobId}`,
    `Аккаунт: @${draft.igUserId || '?'}`,
    '',
    `🪝 Хук: ${draft.hookText || '—'}`,
    '',
    (draft.caption || '').slice(0, 800),
    '',
    draft.correlationId ? `📋 ${draft.correlationId}` : ''
  ].filter(Boolean).join('\n').slice(0, 1024);

  const callbackBase = `ig_mod:${draft.jobId}`;
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

  if (draft.imagePath) {
    const session = await sessionService.getOrCreateSession(chatId);
    const tempPath = path.join(os.tmpdir(), `ig-mod-${chatId}-${draft.jobId}.png`);
    await dockerService.copyFromContainer(session.containerId, draft.imagePath, tempPath);
    
    // Используем cwBot если он есть и у пользователя нет своего бота
    const moderatorBot = cwBot && cwBot.token !== bot?.token ? cwBot : bot;
    const sent = await moderatorBot.telegram.sendPhoto(moderatorId, { source: tempPath }, { caption, reply_markup: kb });
    await fs.unlink(tempPath).catch(() => {});

    await setDraft(chatId, String(draft.jobId), {
      ...draft,
      moderationMessageId: sent.message_id
    });
  } else {
    // Используем cwBot если он есть и у пользователя нет своего бота
    const moderatorBot = cwBot && cwBot.token !== bot?.token ? cwBot : bot;
    const sent = await moderatorBot.telegram.sendMessage(moderatorId, caption, { reply_markup: kb });
    await setDraft(chatId, String(draft.jobId), {
      ...draft,
      moderationMessageId: sent.message_id
    });
  }
}

async function handleInstagramModerationAction(chatId, bot, jobId, action) {
  const draft = getDrafts(chatId)[String(jobId)];
  if (!draft) return { ok: false, message: 'Черновик Instagram-поста не найден.' };

  const correlationId = draft.correlationId || generateCorrelationId();

  if (action === 'approve') {
    try {
      await publishIgPost(chatId, bot, jobId, correlationId);
      return { ok: true, message: `📷 Instagram пост #${jobId} опубликован.` };
    } catch (e) {
      await igRepo.addPublishLog(chatId, {
        jobId, igUserId: draft.igUserId || '', status: 'failed',
        errorText: e.message, correlationId
      });
      await igRepo.updateJob(chatId, jobId, { status: 'failed', errorText: e.message });
      return { ok: false, message: `Ошибка публикации Instagram: ${e.message}` };
    }
  }

  if (action === 'regen_text') {
    try {
      const [materialsText, personaText] = await Promise.all([
        loadMaterialsText(chatId, 12),
        loadUserPersona(chatId)
      ]);
      const igText = await generateIgPostText(chatId, draft.topic, materialsText, personaText);
      draft.caption = igText.caption;
      draft.hookText = igText.hookText;
      draft.imagePrompt = igText.imagePrompt;
      await igRepo.updateJob(chatId, jobId, {
        caption: igText.caption,
        hookText: igText.hookText,
        imagePrompt: igText.imagePrompt
      });
      await sendIgToModerator(chatId, bot, draft);
      return { ok: true, message: 'Текст Instagram-поста перегенерирован.' };
    } catch (e) {
      return { ok: false, message: `Ошибка перегенерации текста: ${e.message}` };
    }
  }

  if (action === 'regen_image') {
    try {
      const imageBuffer = await generateIgImage(draft.topic, draft.imagePrompt);
      const imagePath = await saveImageToContainer(chatId, imageBuffer, `${jobId}_regen_${Date.now()}`);
      draft.imagePath = imagePath;
      await igRepo.updateJob(chatId, jobId, { imagePath });
      await sendIgToModerator(chatId, bot, draft);
      return { ok: true, message: 'Изображение Instagram-поста перегенерировано.' };
    } catch (e) {
      return { ok: false, message: `Ошибка перегенерации изображения: ${e.message}` };
    }
  }

  if (action === 'reject') {
    draft.rejectedCount = (draft.rejectedCount || 0) + 1;
    await setDraft(chatId, String(jobId), draft);

    if (draft.rejectedCount >= MAX_REJECT_ATTEMPTS) {
      await igRepo.updateJob(chatId, jobId, { status: 'failed', errorText: `Rejected ${MAX_REJECT_ATTEMPTS} times` });
      await removeDraft(chatId, String(jobId));
      return { ok: true, message: `Instagram-пост отклонен ${MAX_REJECT_ATTEMPTS} раза. Задача закрыта.` };
    }

    // Полная перегенерация
    try {
      const [materialsText, personaText] = await Promise.all([
        loadMaterialsText(chatId, 12),
        loadUserPersona(chatId)
      ]);
      const igText = await generateIgPostText(chatId, draft.topic, materialsText, personaText);
      const imageBuffer = await generateIgImage(draft.topic, igText.imagePrompt);
      const imagePath = await saveImageToContainer(chatId, imageBuffer, `${jobId}_reject_${Date.now()}`);

      draft.caption = igText.caption;
      draft.hookText = igText.hookText;
      draft.imagePrompt = igText.imagePrompt;
      draft.imagePath = imagePath;

      await igRepo.updateJob(chatId, jobId, {
        caption: igText.caption,
        hookText: igText.hookText,
        imagePrompt: igText.imagePrompt,
        imagePath,
        rejectedCount: draft.rejectedCount
      });

      await sendIgToModerator(chatId, bot, draft);
      return { ok: true, message: `Instagram-пост перегенерирован (${draft.rejectedCount}/${MAX_REJECT_ATTEMPTS}).` };
    } catch (e) {
      return { ok: false, message: `Ошибка перегенерации: ${e.message}` };
    }
  }

  return { ok: false, message: 'Неизвестное действие.' };
}

// ============================================
// Планировщик
// ============================================

async function tickIgSchedule(chatId, bot) {
  const cfg = manageStore.getInstagramConfig(chatId);
  if (!cfg || !cfg.is_active) return;

  const settings = getIgSettings(chatId);
  const tz = settings.scheduleTz;
  const now = getNowInTz(tz);

  // Дневной лимит
  const publishedToday = await igRepo.countPublishedToday(chatId, tz);
  if (publishedToday >= settings.dailyLimit) return;

  // День недели
  const dayOfWeek = new Date().getDay();
  if (!settings.allowedWeekdays.includes(dayOfWeek)) return;

  const [startH, startM] = (settings.scheduleTime || '10:00').split(':').map(Number);
  const [nowH, nowM] = now.time.split(':').map(Number);
  const startMinutes = startH * 60 + startM;
  const nowMinutes = nowH * 60 + nowM;
  const intervalMinutes = Math.round((settings.publishIntervalHours || 4) * 60);

  const data = manageStore.getState(chatId) || {};

  // Проверка слота
  let isSlot = false;
  for (let slot = startMinutes; slot < 24 * 60; slot += intervalMinutes) {
    if (nowMinutes === slot) { isSlot = true; break; }
  }
  if (!isSlot) return;

  const key = `igLastRun:${now.time}`;
  if (data[key] === now.date) return;

  data[key] = now.date;
  const states = manageStore.getAllStates();
  if (!states[chatId]) states[chatId] = data;
  await manageStore.persist(chatId);

  console.log(`[IG-SCHEDULE] ${chatId} slot matched ${now.time}, enqueueing ig_generate`);

  await queueRepo.ensureQueueSchema(chatId);
  await queueRepo.enqueue(chatId, {
    jobType: 'ig_generate',
    priority: 0,
    payload: { reason: 'schedule' },
    correlationId: generateCorrelationId()
  });
}

async function runNow(chatId, bot, reason = 'manual') {
  await repository.ensureSchema(chatId);
  await igRepo.ensureSchema(chatId);

  const settings = getIgSettings(chatId);
  const publishedToday = await igRepo.countPublishedToday(chatId, settings.scheduleTz);
  if (publishedToday >= settings.dailyLimit) {
    return { ok: false, message: `Дневной лимит Instagram-постов исчерпан (${publishedToday}/${settings.dailyLimit}).` };
  }

  const correlationId = generateCorrelationId();

  await queueRepo.ensureQueueSchema(chatId);
  const queueJobId = await queueRepo.enqueue(chatId, {
    jobType: 'ig_generate',
    priority: 0,
    payload: { reason },
    correlationId
  });

  return { ok: true, message: `Instagram-задача #${queueJobId} в очереди.`, queueJobId, correlationId };
}

// ============================================
// Scheduler & Worker Registration
// ============================================

function startScheduler(getBots) {
  botsGetter = getBots;

  // Регистрируем обработчики задач Instagram
  worker.registerJobHandler('ig_generate', handleIgGenerateJob);
  worker.registerJobHandler('ig_publish', async (chatId, queueJob, bot, correlationId) => {
    const jobId = queueJob.job_id || queueJob.payload?.jobId;
    if (!jobId) return { success: false, error: 'No jobId', retry: false };
    try {
      await publishIgPost(chatId, bot, jobId, correlationId);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message, retry: true };
    }
  });

  // Запускаем worker с поддержкой CW_BOT_TOKEN
  worker.startWorker(getBots, () => cwBot);

  // Планировщик Instagram (раз в минуту)
  if (schedulerHandle) clearInterval(schedulerHandle);
  schedulerHandle = setInterval(async () => {
    try {
      const bots = getBots();
      for (const [chatId, entry] of bots.entries()) {
        await tickIgSchedule(chatId, entry.bot);
      }
    } catch (e) {
      console.error('[IG-MVP-SCHEDULER]', e.message);
    }
  }, 60 * 1000);

  console.log('[IG-MVP] Scheduler and worker started');
}

function stopScheduler() {
  if (schedulerHandle) {
    clearInterval(schedulerHandle);
    schedulerHandle = null;
  }
  console.log('[IG-MVP] Scheduler stopped');
}

// ============================================
// Exports
// ============================================

module.exports = {
  startScheduler,
  stopScheduler,
  runNow,
  handleIgGenerateJob,
  publishIgPost,
  sendIgToModerator,
  handleInstagramModerationAction,
  tickIgSchedule,
  getIgSettings,
  listJobs: (chatId, opts) => igRepo.listJobs(chatId, opts),
  getJobById: (chatId, jobId) => igRepo.getJobById(chatId, jobId),
  setIgCwBot: (bot) => { cwBot = bot; },
  getIgCwBot: () => cwBot
};
