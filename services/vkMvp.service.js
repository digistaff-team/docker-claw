/**
 * VK MVP Service — генерация, модерация, публикация VK-постов
 * Самостоятельный пайплайн, аналог pinterestMvp.service.js
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
const vkService = require('./vk.service');
const imageService = require('./image.service');
const vkRepo = require('./content/vk.repository');

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
const DAILY_VK_LIMIT = parseInt(process.env.VK_DAILY_LIMIT || '5', 10);
const PROFILE_FILES = ['IDENTITY.md', 'SOUL.md'];
const VK_MODERATION_TIMEOUT_HOURS = parseInt(process.env.VK_MODERATION_TIMEOUT_HOURS || '24', 10);

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

function getVkSettings(chatId) {
  const cfg = manageStore.getVkConfig(chatId);
  const settings = manageStore.getVkSettings(chatId) || {};
  return {
    isActive: !!cfg?.is_active,
    groupId: cfg?.group_id || null,
    serviceKey: cfg?.service_key || null,
    scheduleTime: settings.schedule_time || '10:00',
    scheduleTz: settings.schedule_tz || SCHEDULE_TZ,
    dailyLimit: settings.daily_limit || DAILY_VK_LIMIT,
    publishIntervalHours: Number.isFinite(settings.publish_interval_hours) ? settings.publish_interval_hours : 4,
    randomPublish: !!settings.random_publish,
    premoderationEnabled: settings.premoderation_enabled !== false, // по умолчанию включена
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
// AI-генерация для VK
// ============================================

async function generateVkPostText(chatId, topic, materialsText, personaText) {
  const data = manageStore.getState(chatId);
  const hasApiKey = data?.aiCustomApiKey || data?.aiAuthToken;
  if (!hasApiKey || !data?.aiModel) {
    throw new Error('AI model is not configured');
  }

  const prompt = `Ты SMM-маркетолог ВКонтакте. Создай контент для поста в группе VK.

Тема: ${topic.topic}
${topic.focus ? `Фокус: ${topic.focus}` : ''}

${personaText ? `--- ПЕРСОНА ---\n${personaText}\n---` : ''}
${materialsText ? `--- МАТЕРИАЛЫ ---\n${materialsText}\n---` : ''}

Ответь строго в формате JSON:
{
  "postText": "текст поста для VK (до 2000 символов, вовлекающий, с абзацами)",
  "hookText": "хук — цепляющая фраза 4-6 слов для наложения на изображение",
  "imagePrompt": "промпт для генерации изображения на английском (стиль: яркий, профессиональный, без текста)"
}

Требования:
- postText: до 2000 символов, информативный, с призывом к действию, с эмодзи
- hookText: короткая цепляющая фраза для наложения на картинку (4-6 слов, русский)
- imagePrompt: на английском, описание визуала для поста, без текста на изображении
- Язык: русский (кроме imagePrompt)`;

  const messages = [
    { role: 'system', content: 'Ты SMM-маркетолог ВКонтакте. Отвечай только JSON.' },
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
    postText: String(parsed.postText || '').slice(0, 2000),
    hookText: String(parsed.hookText || '').slice(0, 100),
    imagePrompt: String(parsed.imagePrompt || '').slice(0, 800)
  };
}

async function generateVkImage(topic, imagePrompt) {
  const apiKey = process.env.KIE_API_KEY;
  if (!apiKey) throw new Error('KIE_API_KEY is not set');

  const prompt = (imagePrompt || `VK post image. Topic: ${topic.topic}. Style: bright, professional, eye-catching, no text overlay, social media optimized.`).slice(0, 800);

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
  const localTmp = path.join(os.tmpdir(), `vk-image-${chatId}-${jobId}.png`);
  await fs.writeFile(localTmp, buffer);
  const containerPath = `/workspace/output/content/vk_${jobId}.png`;
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
  return data.vkDrafts || {};
}

function setDraft(chatId, draftId, draft) {
  const data = manageStore.getState(chatId) || {};
  data.vkDrafts = data.vkDrafts || {};
  data.vkDrafts[draftId] = draft;
  if (!manageStore.getState(chatId)) {
    manageStore.getAllStates()[chatId] = data;
  }
  return manageStore.persist(chatId);
}

async function removeDraft(chatId, draftId) {
  const data = manageStore.getState(chatId) || {};
  if (data.vkDrafts && data.vkDrafts[draftId]) {
    delete data.vkDrafts[draftId];
    await manageStore.persist(chatId);
  }
}

// ============================================
// Генерация VK поста
// ============================================

async function handleVkGenerateJob(chatId, queueJob, bot, correlationId) {
  console.log(`[VK-GENERATE] ${chatId} starting generation, corr=${correlationId}`);
  const settings = getVkSettings(chatId);

  await repository.ensureSchema(chatId);

  // Дневной лимит
  const publishedToday = await vkRepo.countPublishedToday(chatId, settings.scheduleTz);
  if (publishedToday >= settings.dailyLimit) {
    return { success: false, error: `Дневной лимит VK-постов исчерпан (${publishedToday}/${settings.dailyLimit})`, retry: false };
  }

  // Проверка дня недели (с учётом таймзоны)
  const now = new Date();
  const weekdayStr = new Intl.DateTimeFormat('en-US', { timeZone: settings.scheduleTz, weekday: 'short' }).format(now);
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dayOfWeek = weekdayMap[weekdayStr] ?? now.getDay();
  if (!settings.allowedWeekdays.includes(dayOfWeek)) {
    return { success: false, error: `Публикация не разрешена в этот день недели (${dayOfWeek})`, retry: false };
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

  // Генерация текста поста
  let vkText;
  try {
    vkText = await generateVkPostText(chatId, topic, materialsText, personaText);
  } catch (e) {
    await repository.updateTopicStatus(chatId, topic.sheetRow, 'pending', `vk_text_failed: ${e.message}`);
    return { success: false, error: `VK text generation failed: ${e.message}`, retry: true };
  }

  // Генерация изображения
  let imagePath = '';
  let imageAttempts = 0;
  let imageErr = '';
  for (let i = 1; i <= MAX_IMAGE_ATTEMPTS; i++) {
    try {
      imageAttempts = i;
      const imageBuffer = await generateVkImage(topic, vkText.imagePrompt);
      const tempId = `${topic.sheetRow}_${Date.now()}`;
      imagePath = await saveImageToContainer(chatId, imageBuffer, tempId);
      imageErr = '';
      break;
    } catch (e) {
      imageErr = e?.message || String(e);
    }
  }
  if (!imagePath) {
    await repository.updateTopicStatus(chatId, topic.sheetRow, 'pending', `vk_image_failed: ${imageErr}`);
    return { success: false, error: `VK image generation failed: ${imageErr}`, retry: true };
  }

  // Запись в БД
  const jobId = await vkRepo.createJob(chatId, {
    topic: topic.topic,
    groupId: settings.groupId,
    postText: vkText.postText,
    hookText: vkText.hookText,
    imagePrompt: vkText.imagePrompt,
    imagePath,
    vkContentType: 'photo',
    status: 'ready',
    imageAttempts,
    correlationId
  });

  const draft = {
    jobId,
    topic,
    groupId: settings.groupId,
    postText: vkText.postText,
    hookText: vkText.hookText,
    imagePrompt: vkText.imagePrompt,
    imagePath,
    correlationId,
    rejectedCount: 0
  };

  // Маршрутизация: модерация или автопубликация
  if (!settings.premoderationEnabled) {
    await setDraft(chatId, String(jobId), draft);
    await publishVkPost(chatId, bot, jobId, correlationId);
  } else {
    await sendVkToModerator(chatId, bot, draft);
  }

  return { success: true, data: { jobId } };
}

// ============================================
// Публикация VK поста
// ============================================

async function publishVkPost(chatId, bot, jobId, correlationId) {
  const corrId = correlationId || generateCorrelationId();
  const job = await vkRepo.getJobById(chatId, jobId);
  if (!job) throw new Error(`VK job ${jobId} not found`);

  const cfg = manageStore.getVkConfig(chatId);
  if (!cfg) throw new Error('VK не настроен');

  const groupId = job.group_id || cfg.group_id;
  const serviceKey = cfg.service_key;

  if (!groupId || !serviceKey) {
    throw new Error('VK group_id или service_key не настроен');
  }

  // Копируем изображение из контейнера
  let imageBuffer = null;
  if (job.image_path) {
    const session = await sessionService.getOrCreateSession(chatId);
    const tempPath = path.join(os.tmpdir(), `vk-publish-${chatId}-${jobId}.png`);
    await dockerService.copyFromContainer(session.containerId, job.image_path, tempPath);
    imageBuffer = await fs.readFile(tempPath);
    await fs.unlink(tempPath).catch(() => {});

    // Водяной знак
    const logoPath = '/workspace/brand/logo.png';
    const logoLocalPath = path.join(os.tmpdir(), `vk-logo-${chatId}.png`);
    try {
      await dockerService.copyFromContainer(session.containerId, logoPath, logoLocalPath);
      imageBuffer = await imageService.overlayWatermark(imageBuffer, logoLocalPath);
      await fs.unlink(logoLocalPath).catch(() => {});
    } catch (e) {
      console.log(`[VK-MVP] Watermark skipped: ${e.message}`);
    }
  }

  // Публикация через VK API
  const result = await vkService.publishPhotoPost({
    serviceKey,
    groupId,
    text: job.post_text || '',
    imageBuffer,
    params: { signed: true }
  });

  // Запись в лог
  await vkRepo.addPublishLog(chatId, {
    jobId,
    groupId,
    vkPostId: result.post_id ? String(result.post_id) : null,
    status: 'published',
    correlationId: corrId
  });

  // Обновить статус
  await vkRepo.updateJob(chatId, jobId, {
    status: 'published',
    vkPostId: result.full_id || String(result.post_id || '')
  });

  // Обновить статистику
  const stats = cfg.stats || {};
  const today = getNowInTz(SCHEDULE_TZ).date;
  const postsToday = stats.last_post_date === today ? (stats.posts_today || 0) + 1 : 1;
  await manageStore.setVkConfig(chatId, {
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
    const postUrl = `https://vk.com/wall${result.full_id}`;
    const msg = `📢 VK пост опубликован!\n${(job.post_text || '').slice(0, 100)}...\n→ ${postUrl}`;
    await bot.telegram.sendMessage(chatId, msg).catch(() => {});
  }

  return result;
}

// ============================================
// Модерация
// ============================================

async function sendVkToModerator(chatId, bot, draft) {
  const moderatorId = manageStore.getContentSettings?.(chatId)?.moderatorUserId || chatId;

  const caption = [
    `📢 VK → Группа ${draft.groupId || '?'}`,
    '',
    `🪝 Хук: ${draft.hookText || '—'}`,
    '',
    (draft.postText || '').slice(0, 800),
    '',
    draft.correlationId ? `📋 ${draft.correlationId}` : ''
  ].filter(Boolean).join('\n').slice(0, 1024);

  const callbackBase = `vk_mod:${draft.jobId}`;
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
    const tempPath = path.join(os.tmpdir(), `vk-mod-${chatId}-${draft.jobId}.png`);
    await dockerService.copyFromContainer(session.containerId, draft.imagePath, tempPath);
    const sent = await bot.telegram.sendPhoto(moderatorId, { source: tempPath }, { caption, reply_markup: kb });
    await fs.unlink(tempPath).catch(() => {});

    await setDraft(chatId, String(draft.jobId), {
      ...draft,
      moderationMessageId: sent.message_id
    });
  } else {
    const sent = await bot.telegram.sendMessage(moderatorId, caption, { reply_markup: kb });
    await setDraft(chatId, String(draft.jobId), {
      ...draft,
      moderationMessageId: sent.message_id
    });
  }
}

async function handleVkModerationAction(chatId, bot, jobId, action) {
  const draft = getDrafts(chatId)[String(jobId)];
  if (!draft) return { ok: false, message: 'Черновик VK-поста не найден.' };

  const correlationId = draft.correlationId || generateCorrelationId();

  if (action === 'approve') {
    try {
      await publishVkPost(chatId, bot, jobId, correlationId);
      return { ok: true, message: `📢 VK пост #${jobId} опубликован.` };
    } catch (e) {
      await vkRepo.addPublishLog(chatId, {
        jobId, groupId: draft.groupId || '', status: 'failed',
        errorText: e.message, correlationId
      });
      await vkRepo.updateJob(chatId, jobId, { status: 'failed', errorText: e.message });
      return { ok: false, message: `Ошибка публикации VK: ${e.message}` };
    }
  }

  if (action === 'regen_text') {
    try {
      const [materialsText, personaText] = await Promise.all([
        loadMaterialsText(chatId, 12),
        loadUserPersona(chatId)
      ]);
      const vkText = await generateVkPostText(chatId, draft.topic, materialsText, personaText);
      draft.postText = vkText.postText;
      draft.hookText = vkText.hookText;
      draft.imagePrompt = vkText.imagePrompt;
      await vkRepo.updateJob(chatId, jobId, {
        postText: vkText.postText,
        hookText: vkText.hookText,
        imagePrompt: vkText.imagePrompt
      });
      await sendVkToModerator(chatId, bot, draft);
      return { ok: true, message: 'Текст VK-поста перегенерирован.' };
    } catch (e) {
      return { ok: false, message: `Ошибка перегенерации текста: ${e.message}` };
    }
  }

  if (action === 'regen_image') {
    try {
      const imageBuffer = await generateVkImage(draft.topic, draft.imagePrompt);
      const imagePath = await saveImageToContainer(chatId, imageBuffer, `${jobId}_regen_${Date.now()}`);
      draft.imagePath = imagePath;
      await vkRepo.updateJob(chatId, jobId, { imagePath });
      await sendVkToModerator(chatId, bot, draft);
      return { ok: true, message: 'Изображение VK-поста перегенерировано.' };
    } catch (e) {
      return { ok: false, message: `Ошибка перегенерации изображения: ${e.message}` };
    }
  }

  if (action === 'reject') {
    draft.rejectedCount = (draft.rejectedCount || 0) + 1;
    await setDraft(chatId, String(jobId), draft);

    if (draft.rejectedCount >= MAX_REJECT_ATTEMPTS) {
      await vkRepo.updateJob(chatId, jobId, { status: 'failed', errorText: `Rejected ${MAX_REJECT_ATTEMPTS} times` });
      await removeDraft(chatId, String(jobId));
      return { ok: true, message: `VK-пост отклонен ${MAX_REJECT_ATTEMPTS} раза. Задача закрыта.` };
    }

    // Полная перегенерация
    try {
      const [materialsText, personaText] = await Promise.all([
        loadMaterialsText(chatId, 12),
        loadUserPersona(chatId)
      ]);
      const vkText = await generateVkPostText(chatId, draft.topic, materialsText, personaText);
      const imageBuffer = await generateVkImage(draft.topic, vkText.imagePrompt);
      const imagePath = await saveImageToContainer(chatId, imageBuffer, `${jobId}_reject_${Date.now()}`);

      draft.postText = vkText.postText;
      draft.hookText = vkText.hookText;
      draft.imagePrompt = vkText.imagePrompt;
      draft.imagePath = imagePath;

      await vkRepo.updateJob(chatId, jobId, {
        postText: vkText.postText,
        hookText: vkText.hookText,
        imagePrompt: vkText.imagePrompt,
        imagePath,
        rejectedCount: draft.rejectedCount
      });

      await sendVkToModerator(chatId, bot, draft);
      return { ok: true, message: `VK-пост перегенерирован (${draft.rejectedCount}/${MAX_REJECT_ATTEMPTS}).` };
    } catch (e) {
      return { ok: false, message: `Ошибка перегенерации: ${e.message}` };
    }
  }

  return { ok: false, message: 'Неизвестное действие.' };
}

// ============================================
// Планировщик
// ============================================

async function tickVkSchedule(chatId, bot) {
  const cfg = manageStore.getVkConfig(chatId);
  if (!cfg || !cfg.is_active) return;

  const settings = getVkSettings(chatId);
  const tz = settings.scheduleTz;
  const now = getNowInTz(tz);

  // Дневной лимит
  const publishedToday = await vkRepo.countPublishedToday(chatId, tz);
  if (publishedToday >= settings.dailyLimit) {
    console.log(`[VK-SCHEDULE] ${chatId} skip: daily limit reached (${publishedToday}/${settings.dailyLimit})`);
    return;
  }

  // День недели
  const dayOfWeek = new Date().getDay();
  if (!settings.allowedWeekdays.includes(dayOfWeek)) {
    console.log(`[VK-SCHEDULE] ${chatId} skip: weekday ${dayOfWeek} not in allowed ${JSON.stringify(settings.allowedWeekdays)}`);
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
    // Логируем раз в 10 минут, чтобы не засорять
    if (nowMinutes % 10 === 0) {
      console.log(`[VK-SCHEDULE] ${chatId} waiting: now=${now.time}, start=${settings.scheduleTime}, interval=${settings.publishIntervalHours}h`);
    }
    return;
  }

  const key = `vkLastRun:${now.time}`;
  if (data[key] === now.date) return;

  data[key] = now.date;
  if (!manageStore.getState(chatId)) {
    manageStore.getAllStates()[chatId] = data;
  }
  await manageStore.persist(chatId);

  console.log(`[VK-SCHEDULE] ${chatId} slot matched ${now.time}, enqueueing vk_generate`);

  // Ставим в очередь
  await queueRepo.ensureQueueSchema(chatId);
  await queueRepo.enqueue(chatId, {
    jobType: 'vk_generate',
    priority: 0,
    payload: { reason: 'schedule' },
    correlationId: generateCorrelationId()
  });
}

async function runNow(chatId, bot, reason = 'manual') {
  await repository.ensureSchema(chatId);

  const settings = getVkSettings(chatId);
  const publishedToday = await vkRepo.countPublishedToday(chatId, settings.scheduleTz);
  if (publishedToday >= settings.dailyLimit) {
    return { ok: false, message: `Дневной лимит VK-постов исчерпан (${publishedToday}/${settings.dailyLimit}).` };
  }

  const correlationId = generateCorrelationId();

  if (reason !== 'schedule') {
    try {
      const result = await handleVkGenerateJob(chatId, {
        payload: { reason },
        correlation_id: correlationId
      }, bot, correlationId);
      if (result.success) {
        return { ok: true, message: 'VK-пост сгенерирован.', correlationId };
      } else {
        return { ok: false, message: result.error || 'Генерация не удалась.', correlationId };
      }
    } catch (e) {
      return { ok: false, message: `Ошибка: ${e.message}`, correlationId };
    }
  }

  await queueRepo.ensureQueueSchema(chatId);
  const queueJobId = await queueRepo.enqueue(chatId, {
    jobType: 'vk_generate',
    priority: 0,
    payload: { reason },
    correlationId
  });

  return { ok: true, message: `VK-задача #${queueJobId} в очереди.`, queueJobId, correlationId };
}

// ============================================
// Scheduler & Worker Registration
// ============================================

function startScheduler(getBots) {
  botsGetter = getBots;

  // Регистрируем обработчики задач VK
  worker.registerJobHandler('vk_generate', handleVkGenerateJob);
  worker.registerJobHandler('vk_publish', async (chatId, queueJob, bot, correlationId) => {
    const jobId = queueJob.job_id || queueJob.payload?.jobId;
    if (!jobId) return { success: false, error: 'No jobId', retry: false };
    try {
      await publishVkPost(chatId, bot, jobId, correlationId);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message, retry: true };
    }
  });

  // Планировщик VK (раз в минуту)
  if (schedulerHandle) clearInterval(schedulerHandle);
  schedulerHandle = setInterval(async () => {
    try {
      const bots = getBots();
      for (const [chatId, entry] of bots.entries()) {
        await tickVkSchedule(chatId, entry.bot);
      }
    } catch (e) {
      console.error('[VK-MVP-SCHEDULER]', e.message);
    }
  }, 60 * 1000);

  console.log('[VK-MVP] Scheduler started');
}

function stopScheduler() {
  if (schedulerHandle) {
    clearInterval(schedulerHandle);
    schedulerHandle = null;
  }
  console.log('[VK-MVP] Scheduler stopped');
}

// ============================================
// Exports
// ============================================

module.exports = {
  startScheduler,
  stopScheduler,
  runNow,
  handleVkGenerateJob,
  publishVkPost,
  sendVkToModerator,
  handleVkModerationAction,
  tickVkSchedule,
  getVkSettings,
  listJobs: (chatId, opts) => vkRepo.listJobs(chatId, opts),
  getJobById: (chatId, jobId) => vkRepo.getJobById(chatId, jobId)
};
