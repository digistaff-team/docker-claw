/**
 * OK MVP Service — генерация, модерация, публикация ОК-постов
 * Самостоятельный пайплайн, аналог vkMvp.service.js
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
const okService = require('./ok.service');
const imageService = require('./image.service');
const okRepo = require('./content/ok.repository');

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
const DAILY_OK_LIMIT = parseInt(process.env.OK_DAILY_LIMIT || '5', 10);
const PROFILE_FILES = ['IDENTITY.md', 'SOUL.md'];
const OK_MODERATION_TIMEOUT_HOURS = parseInt(process.env.OK_MODERATION_TIMEOUT_HOURS || '24', 10);

const OK_RULES = {
  textMin: 400,
  textMax: 600,
  textHardMax: 700,
  emojiMax: 3,
  hashtagMin: 2,
  hashtagMax: 4
};

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

function getOkSettings(chatId) {
  const cfg = manageStore.getOkConfig(chatId);
  const settings = manageStore.getOkSettings(chatId) || {};
  return {
    isActive: !!cfg?.is_active,
    groupId: cfg?.group_id || config.OK_GROUP_ID || null,
    accessToken: cfg?.access_token || config.OK_ACCESS_TOKEN || null,
    scheduleTime: settings.schedule_time || '10:00',
    scheduleTz: isValidTz(settings.schedule_tz) ? settings.schedule_tz : SCHEDULE_TZ,
    dailyLimit: settings.daily_limit || DAILY_OK_LIMIT,
    publishIntervalHours: Number.isFinite(settings.publish_interval_hours) ? settings.publish_interval_hours : 4,
    randomPublish: !!settings.random_publish,
    premoderationEnabled: settings.premoderation_enabled !== false,
    postType: settings.post_type || 'post',
    allowedWeekdays: Array.isArray(settings.allowed_weekdays) ? settings.allowed_weekdays : [0, 1, 2, 3, 4, 5, 6],
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
// AI-генерация для ОК
// ============================================

async function generateOkPostText(chatId, topic, materialsText, personaText) {
  const data = manageStore.getState(chatId);
  const hasApiKey = data?.aiCustomApiKey || data?.aiAuthToken;
  if (!hasApiKey || !data?.aiModel) {
    throw new Error('AI model is not configured');
  }

  const prompt = `Ты — копирайтер, который пишет посты для социальной сети «Одноклассники».

Тема поста: ${topic.topic}
${topic.focus ? `Фокус: ${topic.focus}` : ''}

${personaText ? `--- ПЕРСОНА ---\n${personaText}\n---` : ''}
${materialsText ? `--- МАТЕРИАЛЫ ---\n${materialsText}\n---` : ''}

Ответь строго в формате JSON:
{
  "postText": "текст поста для Одноклассников",
  "hookText": "хук — цепляющая фраза 4-6 слов для наложения на изображение",
  "imagePrompt": "промпт для генерации изображения на английском"
}

Требования к postText:
- Длина: 400–600 символов (не длиннее 700)
- Тон: дружелюбный, человеческий, профессиональный
- Без клише вроде "купите прямо сейчас" и "лучшее на рынке"
- Допускается лёгкий юмор, живой язык, но без жаргона
- В начале: человеческая подача, вопрос, факт или мини-история
- В основной части: естественно подведи к теме
- В конце: мягкий призыв к действию ("Загляните к нам", "Попробуйте сами!", "Сохраняйте идею!")
- Эмодзи: 1-3 штуки, не в начале текста
- Обязательно 2-4 релевантных хештега

Требования к hookText: короткая цепляющая фраза для наложения на картинку (4-6 слов, русский)
Требования к imagePrompt: на английском, описание визуала, формат 1:1, без текста на изображении
Язык: русский (кроме imagePrompt)`;

  const messages = [
    { role: 'system', content: 'Ты копирайтер для Одноклассников. Отвечай только JSON.' },
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
  const postText = String(parsed.postText || '').slice(0, OK_RULES.textHardMax);

  return {
    postText,
    hookText: String(parsed.hookText || '').slice(0, 100),
    imagePrompt: String(parsed.imagePrompt || '').slice(0, 800)
  };
}

/**
 * Валидация текста поста по правилам ОК
 */
function validateOkContent(text) {
  const warnings = [];

  if (text.length < OK_RULES.textMin) {
    warnings.push(`Текст короткий: ${text.length} < ${OK_RULES.textMin}`);
  }
  if (text.length > OK_RULES.textHardMax) {
    warnings.push(`Текст длинный: ${text.length} > ${OK_RULES.textHardMax}`);
  }

  const emojiCount = (text.match(/\p{Emoji_Presentation}/gu) || []).length;
  if (emojiCount > OK_RULES.emojiMax) {
    warnings.push(`Эмодзи: ${emojiCount} > ${OK_RULES.emojiMax}`);
  }

  const hashtagCount = (text.match(/#[\wа-яА-ЯёЁ]+/g) || []).length;
  if (hashtagCount < OK_RULES.hashtagMin) {
    warnings.push(`Хештегов мало: ${hashtagCount} < ${OK_RULES.hashtagMin}`);
  }
  if (hashtagCount > OK_RULES.hashtagMax) {
    warnings.push(`Хештегов много: ${hashtagCount} > ${OK_RULES.hashtagMax}`);
  }

  return { valid: warnings.length === 0, warnings };
}

async function generateOkImage(topic, imagePrompt) {
  const apiKey = process.env.KIE_API_KEY;
  if (!apiKey) throw new Error('KIE_API_KEY is not set');

  const prompt = (imagePrompt || `OK social media post image. Topic: ${topic.topic}. Style: bright, professional, eye-catching, no text overlay, 1:1 ratio.`).slice(0, 800);

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
  const localTmp = path.join(os.tmpdir(), `ok-image-${chatId}-${jobId}.png`);
  await fs.writeFile(localTmp, buffer);
  const containerPath = `/workspace/output/content/ok_${jobId}.png`;
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
  return data.okDrafts || {};
}

function setDraft(chatId, draftId, draft) {
  const states = manageStore.getAllStates();
  let data = states[chatId];
  if (!data) {
    data = {};
    states[chatId] = data;
  }
  data.okDrafts = data.okDrafts || {};
  data.okDrafts[draftId] = draft;
  return manageStore.persist(chatId);
}

async function removeDraft(chatId, draftId) {
  const data = manageStore.getState(chatId) || {};
  if (data.okDrafts && data.okDrafts[draftId]) {
    delete data.okDrafts[draftId];
    await manageStore.persist(chatId);
  }
}

// ============================================
// Генерация ОК поста
// ============================================

async function handleOkGenerateJob(chatId, queueJob, bot, correlationId) {
  console.log(`[OK-GENERATE] ${chatId} starting generation, corr=${correlationId}`);
  const settings = getOkSettings(chatId);

  await repository.ensureSchema(chatId);

  // Дневной лимит
  const publishedToday = await okRepo.countPublishedToday(chatId, settings.scheduleTz);
  if (publishedToday >= settings.dailyLimit) {
    return { success: false, error: `Дневной лимит ОК-постов исчерпан (${publishedToday}/${settings.dailyLimit})`, retry: false };
  }

  // Проверка дня недели (с учётом таймзоны)
  const now = new Date();
  let dayOfWeek;
  try {
    const weekdayStr = new Intl.DateTimeFormat('en-US', { timeZone: settings.scheduleTz, weekday: 'short' }).format(now);
    const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    dayOfWeek = weekdayMap[weekdayStr] ?? now.getDay();
  } catch {
    console.warn(`[OK-GENERATE] ${chatId} invalid timezone "${settings.scheduleTz}", fallback to getDay()`);
    dayOfWeek = now.getDay();
  }
  if (!settings.allowedWeekdays.includes(dayOfWeek)) {
    return { success: false, error: `Публикация не разрешена в этот день недели (${dayOfWeek})`, retry: false };
  }

  // Выбор темы
  console.log(`[OK-GENERATE] ${chatId} selecting topic...`);
  const topicRow = await repository.reserveNextTopic(chatId);
  if (!topicRow) {
    console.log(`[OK-GENERATE] ${chatId} no pending topics available`);
    return { success: false, error: 'Нет доступных тем', retry: false };
  }
  console.log(`[OK-GENERATE] ${chatId} topic selected: id=${topicRow.id}, "${topicRow.topic}"`);
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

  // Генерация текста поста
  console.log(`[OK-GENERATE] ${chatId} generating text...`);
  let okText;
  try {
    okText = await generateOkPostText(chatId, topic, materialsText, personaText);
    console.log(`[OK-GENERATE] ${chatId} text generated (${(okText.postText || '').length} chars)`);

    // Валидация контента по правилам ОК
    const validation = validateOkContent(okText.postText);
    if (validation.warnings.length > 0) {
      console.log(`[OK-GENERATE] ${chatId} content warnings: ${validation.warnings.join('; ')}`);
    }
  } catch (e) {
    console.error(`[OK-GENERATE] ${chatId} text generation failed: ${e.message}`);
    await repository.updateTopicStatus(chatId, topic.sheetRow, 'pending', `ok_text_failed: ${e.message}`);
    return { success: false, error: `OK text generation failed: ${e.message}`, retry: true };
  }

  // Генерация изображения
  console.log(`[OK-GENERATE] ${chatId} generating image...`);
  let imagePath = '';
  let imageAttempts = 0;
  let imageErr = '';
  for (let i = 1; i <= MAX_IMAGE_ATTEMPTS; i++) {
    try {
      imageAttempts = i;
      const imageBuffer = await generateOkImage(topic, okText.imagePrompt);
      const tempId = `${topic.sheetRow}_${Date.now()}`;
      imagePath = await saveImageToContainer(chatId, imageBuffer, tempId);
      imageErr = '';
      break;
    } catch (e) {
      imageErr = e?.message || String(e);
    }
  }
  if (!imagePath) {
    console.error(`[OK-GENERATE] ${chatId} image generation failed after ${imageAttempts} attempts: ${imageErr}`);
    await repository.updateTopicStatus(chatId, topic.sheetRow, 'pending', `ok_image_failed: ${imageErr}`);
    return { success: false, error: `OK image generation failed: ${imageErr}`, retry: true };
  }
  console.log(`[OK-GENERATE] ${chatId} image saved: ${imagePath} (attempts: ${imageAttempts})`);

  // Запись в БД
  const jobId = await okRepo.createJob(chatId, {
    topic: topic.topic,
    communityId: settings.groupId,
    postText: okText.postText,
    hookText: okText.hookText,
    imagePrompt: okText.imagePrompt,
    imagePath,
    okContentType: 'photo',
    status: 'ready',
    imageAttempts,
    correlationId
  });

  const draft = {
    jobId,
    topic,
    communityId: settings.groupId,
    postText: okText.postText,
    hookText: okText.hookText,
    imagePrompt: okText.imagePrompt,
    imagePath,
    correlationId,
    rejectedCount: 0
  };

  // Маршрутизация: модерация или автопубликация
  if (!settings.premoderationEnabled) {
    await setDraft(chatId, String(jobId), draft);
    await publishOkPost(chatId, bot, jobId, correlationId);
  } else {
    await sendOkToModerator(chatId, bot, draft);
  }

  return { success: true, data: { jobId } };
}

// ============================================
// Публикация ОК поста
// ============================================

async function publishOkPost(chatId, bot, jobId, correlationId) {
  const corrId = correlationId || generateCorrelationId();
  const job = await okRepo.getJobById(chatId, jobId);
  if (!job) throw new Error(`OK job ${jobId} not found`);

  const cfg = manageStore.getOkConfig(chatId);
  const communityId = job.community_id || cfg?.group_id || config.OK_GROUP_ID;

  if (!communityId) {
    throw new Error('OK group_id не настроен');
  }

  // Копируем изображение из контейнера
  let imageBuffer = null;
  if (job.image_path) {
    const session = await sessionService.getOrCreateSession(chatId);
    const tempPath = path.join(os.tmpdir(), `ok-publish-${chatId}-${jobId}.png`);
    await dockerService.copyFromContainer(session.containerId, job.image_path, tempPath);
    imageBuffer = await fs.readFile(tempPath);
    await fs.unlink(tempPath).catch(() => {});

    // Водяной знак
    const logoPath = '/workspace/brand/logo.png';
    const logoLocalPath = path.join(os.tmpdir(), `ok-logo-${chatId}.png`);
    try {
      await dockerService.copyFromContainer(session.containerId, logoPath, logoLocalPath);
      imageBuffer = await imageService.overlayWatermark(imageBuffer, logoLocalPath);
      await fs.unlink(logoLocalPath).catch(() => {});
    } catch (e) {
      console.log(`[OK-MVP] Watermark skipped: ${e.message}`);
    }
  }

  // Публикация через OK API
  const result = await okService.publishPhotoPost({
    chatId,
    groupId: communityId,
    text: job.post_text || '',
    imageBuffer,
    params: {}
  });

  // Запись в лог
  await okRepo.addPublishLog(chatId, {
    jobId,
    communityId,
    okPostId: result.post_id ? String(result.post_id) : null,
    status: 'published',
    correlationId: corrId
  });

  // Обновить статус
  await okRepo.updateJob(chatId, jobId, {
    status: 'published',
    okPostId: result.full_id || String(result.post_id || '')
  });

  // Обновить статистику
  const stats = cfg?.stats || {};
  const today = getNowInTz(SCHEDULE_TZ).date;
  const postsToday = stats.last_post_date === today ? (stats.posts_today || 0) + 1 : 1;
  await manageStore.setOkConfig(chatId, {
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
    const postUrl = `https://ok.ru/group/${communityId}/topic/${result.post_id}`;
    let msg = `📢 ОК пост опубликован!\n${(job.post_text || '').slice(0, 100)}...\n→ ${postUrl}`;
    if (result.photoSkipReason) {
      msg += `\n\n⚠️ ${result.photoSkipReason}`;
    }
    await bot.telegram.sendMessage(chatId, msg).catch(() => {});
  }

  return result;
}

// ============================================
// Модерация
// ============================================

/**
 * Отправка черновика ОК-поста на модерацию в Telegram
 * @param {string} chatId - ID чата пользователя
 * @param {Object} bot - Экземпляр Telegraf бота
 * @param {Object} draft - Объект черновика
 */
async function sendOkToModerator(chatId, bot, draft) {
  const moderatorId = manageStore.getContentSettings?.(chatId)?.moderatorUserId || chatId;

  console.log(`[OK-MODERATION] Sending draft to moderator ${moderatorId}, jobId=${draft.jobId}, corr=${draft.correlationId || 'n/a'}`);

  const caption = [
    `📢 Черновик для Одноклассников #${draft.jobId}`,
    `Группа: ${draft.communityId || '?'}`,
    '',
    `🪝 Хук: ${draft.hookText || '—'}`,
    '',
    (draft.postText || '').slice(0, 800),
    '',
    draft.correlationId ? `📋 ${draft.correlationId}` : ''
  ].filter(Boolean).join('\n').slice(0, 1024);

  const callbackBase = `ok_mod:${draft.jobId}`;
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

  console.log(`[OK-MODERATION] Caption length: ${caption.length}, hasImage: ${!!draft.imagePath}`);

  if (draft.imagePath) {
    try {
      const session = await sessionService.getOrCreateSession(chatId);
      const tempPath = path.join(os.tmpdir(), `ok-mod-${chatId}-${draft.jobId}.png`);
      
      console.log(`[OK-MODERATION] Copying image from container: ${draft.imagePath} → ${tempPath}`);
      await dockerService.copyFromContainer(session.containerId, draft.imagePath, tempPath);
      
      console.log(`[OK-MODERATION] Sending photo to Telegram...`);
      const sent = await bot.telegram.sendPhoto(moderatorId, { source: tempPath }, { caption, reply_markup: kb });
      console.log(`[OK-MODERATION] Photo sent, messageId=${sent.message_id}`);
      
      await fs.unlink(tempPath).catch(() => {});

      await setDraft(chatId, String(draft.jobId), {
        ...draft,
        moderationMessageId: sent.message_id
      });
      console.log(`[OK-MODERATION] Draft saved with moderationMessageId=${sent.message_id}`);
    } catch (e) {
      console.error(`[OK-MODERATION] Error sending photo: ${e.message}`);
      throw e;
    }
  } else {
    console.log(`[OK-MODERATION] Sending text message to Telegram...`);
    const sent = await bot.telegram.sendMessage(moderatorId, caption, { reply_markup: kb });
    console.log(`[OK-MODERATION] Message sent, messageId=${sent.message_id}`);
    
    await setDraft(chatId, String(draft.jobId), {
      ...draft,
      moderationMessageId: sent.message_id
    });
    console.log(`[OK-MODERATION] Draft saved with moderationMessageId=${sent.message_id}`);
  }
  
  console.log(`[OK-MODERATION] Draft sent to moderator successfully`);
}

async function handleOkModerationAction(chatId, bot, jobId, action) {
  const draft = getDrafts(chatId)[String(jobId)];
  if (!draft) return { ok: false, message: 'Черновик ОК-поста не найден.' };

  const correlationId = draft.correlationId || generateCorrelationId();

  if (action === 'approve') {
    try {
      await publishOkPost(chatId, bot, jobId, correlationId);
      return { ok: true, message: `📢 ОК пост #${jobId} опубликован.` };
    } catch (e) {
      await okRepo.addPublishLog(chatId, {
        jobId, communityId: draft.communityId || '', status: 'failed',
        errorText: e.message, correlationId
      });
      await okRepo.updateJob(chatId, jobId, { status: 'failed', errorText: e.message });
      return { ok: false, message: `Ошибка публикации ОК: ${e.message}` };
    }
  }

  if (action === 'regen_text') {
    try {
      const [materialsText, personaText] = await Promise.all([
        loadMaterialsText(chatId, 12),
        loadUserPersona(chatId)
      ]);
      const okText = await generateOkPostText(chatId, draft.topic, materialsText, personaText);
      draft.postText = okText.postText;
      draft.hookText = okText.hookText;
      draft.imagePrompt = okText.imagePrompt;
      await okRepo.updateJob(chatId, jobId, {
        postText: okText.postText,
        hookText: okText.hookText,
        imagePrompt: okText.imagePrompt
      });
      await sendOkToModerator(chatId, bot, draft);
      return { ok: true, message: 'Текст ОК-поста перегенерирован.' };
    } catch (e) {
      return { ok: false, message: `Ошибка перегенерации текста: ${e.message}` };
    }
  }

  if (action === 'regen_image') {
    try {
      const imageBuffer = await generateOkImage(draft.topic, draft.imagePrompt);
      const imagePath = await saveImageToContainer(chatId, imageBuffer, `${jobId}_regen_${Date.now()}`);
      draft.imagePath = imagePath;
      await okRepo.updateJob(chatId, jobId, { imagePath });
      await sendOkToModerator(chatId, bot, draft);
      return { ok: true, message: 'Изображение ОК-поста перегенерировано.' };
    } catch (e) {
      return { ok: false, message: `Ошибка перегенерации изображения: ${e.message}` };
    }
  }

  if (action === 'reject') {
    draft.rejectedCount = (draft.rejectedCount || 0) + 1;
    await setDraft(chatId, String(jobId), draft);

    if (draft.rejectedCount >= MAX_REJECT_ATTEMPTS) {
      await okRepo.updateJob(chatId, jobId, { status: 'failed', errorText: `Rejected ${MAX_REJECT_ATTEMPTS} times` });
      await removeDraft(chatId, String(jobId));
      return { ok: true, message: `ОК-пост отклонен ${MAX_REJECT_ATTEMPTS} раза. Задача закрыта.` };
    }

    // Полная перегенерация
    try {
      const [materialsText, personaText] = await Promise.all([
        loadMaterialsText(chatId, 12),
        loadUserPersona(chatId)
      ]);
      const okText = await generateOkPostText(chatId, draft.topic, materialsText, personaText);
      const imageBuffer = await generateOkImage(draft.topic, okText.imagePrompt);
      const imagePath = await saveImageToContainer(chatId, imageBuffer, `${jobId}_reject_${Date.now()}`);

      draft.postText = okText.postText;
      draft.hookText = okText.hookText;
      draft.imagePrompt = okText.imagePrompt;
      draft.imagePath = imagePath;

      await okRepo.updateJob(chatId, jobId, {
        postText: okText.postText,
        hookText: okText.hookText,
        imagePrompt: okText.imagePrompt,
        imagePath,
        rejectedCount: draft.rejectedCount
      });

      await sendOkToModerator(chatId, bot, draft);
      return { ok: true, message: `ОК-пост перегенерирован (${draft.rejectedCount}/${MAX_REJECT_ATTEMPTS}).` };
    } catch (e) {
      return { ok: false, message: `Ошибка перегенерации: ${e.message}` };
    }
  }

  return { ok: false, message: 'Неизвестное действие.' };
}

// ============================================
// Планировщик
// ============================================

async function tickOkSchedule(chatId, bot) {
  const cfg = manageStore.getOkConfig(chatId);
  if (!cfg || !cfg.is_active) return;

  const settings = getOkSettings(chatId);
  const tz = settings.scheduleTz;
  const now = getNowInTz(tz);

  // Дневной лимит
  const publishedToday = await okRepo.countPublishedToday(chatId, tz);
  if (publishedToday >= settings.dailyLimit) {
    // Не логируем - это нормальное поведение
    return;
  }

  // День недели
  const dayOfWeek = new Date().getDay();
  if (!settings.allowedWeekdays.includes(dayOfWeek)) {
    // Не логируем - это нормальное поведение (например воскресенье не в разрешённых днях)
    return;
  }

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
  if (!isSlot) {
    if (nowMinutes % 10 === 0) {
      console.log(`[OK-SCHEDULE] ${chatId} waiting: now=${now.time}, start=${settings.scheduleTime}, interval=${settings.publishIntervalHours}h`);
    }
    return;
  }

  const key = `okLastRun:${now.time}`;
  if (data[key] === now.date) return;

  data[key] = now.date;
  const states = manageStore.getAllStates();
  if (!states[chatId]) states[chatId] = data;
  await manageStore.persist(chatId);

  console.log(`[OK-SCHEDULE] ${chatId} slot matched ${now.time}, enqueueing ok_generate`);

  // Ставим в очередь
  await queueRepo.ensureQueueSchema(chatId);
  await queueRepo.enqueue(chatId, {
    jobType: 'ok_generate',
    priority: 0,
    payload: { reason: 'schedule' },
    correlationId: generateCorrelationId()
  });
}

async function runNow(chatId, bot, reason = 'manual') {
  await repository.ensureSchema(chatId);

  const settings = getOkSettings(chatId);
  const publishedToday = await okRepo.countPublishedToday(chatId, settings.scheduleTz);
  if (publishedToday >= settings.dailyLimit) {
    return { ok: false, message: `Дневной лимит ОК-постов исчерпан (${publishedToday}/${settings.dailyLimit}).` };
  }

  const correlationId = generateCorrelationId();

  await queueRepo.ensureQueueSchema(chatId);
  const queueJobId = await queueRepo.enqueue(chatId, {
    jobType: 'ok_generate',
    priority: 0,
    payload: { reason },
    correlationId
  });

  return { ok: true, message: `ОК-задача #${queueJobId} в очереди.`, queueJobId, correlationId };
}

// ============================================
// Scheduler & Worker Registration
// ============================================

function startScheduler(getBots) {
  botsGetter = getBots;

  // Регистрируем обработчики задач OK
  worker.registerJobHandler('ok_generate', handleOkGenerateJob);
  worker.registerJobHandler('ok_publish', async (chatId, queueJob, bot, correlationId) => {
    const jobId = queueJob.job_id || queueJob.payload?.jobId;
    if (!jobId) return { success: false, error: 'No jobId', retry: false };
    try {
      await publishOkPost(chatId, bot, jobId, correlationId);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message, retry: true };
    }
  });

  // Планировщик OK (раз в минуту)
  if (schedulerHandle) clearInterval(schedulerHandle);
  schedulerHandle = setInterval(async () => {
    try {
      const bots = getBots();
      for (const [chatId, entry] of bots.entries()) {
        await tickOkSchedule(chatId, entry.bot);
      }
    } catch (e) {
      console.error('[OK-MVP-SCHEDULER]', e.message);
    }
  }, 60 * 1000);

  console.log('[OK-MVP] Scheduler started');
}

function stopScheduler() {
  if (schedulerHandle) {
    clearInterval(schedulerHandle);
    schedulerHandle = null;
  }
  console.log('[OK-MVP] Scheduler stopped');
}

// ============================================
// Exports
// ============================================

module.exports = {
  startScheduler,
  stopScheduler,
  runNow,
  handleOkGenerateJob,
  publishOkPost,
  sendOkToModerator,
  handleOkModerationAction,
  tickOkSchedule,
  getOkSettings,
  validateOkContent,
  listJobs: (chatId, opts) => okRepo.listJobs(chatId, opts),
  getJobById: (chatId, jobId) => okRepo.getJobById(chatId, jobId)
};
