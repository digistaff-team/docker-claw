/**
 * YouTube Shorts MVP Service — генерация, модерация, публикация
 * Самостоятельный пайплайн, не зависит от telegramMvp.service.js
 *
 * Тип контента: только YouTube Shorts (9:16)
 * Видео: KIE.ai Veo 3 API (через video.service.js)
 * Публикация: Buffer GraphQL API
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
const videoService = require('./content/video.service');
const videoPipeline = require('./videoPipeline.service');
const youtubeRepo = require('./content/youtube.repository');
const bufferService = require('./buffer.service');

const contentModules = require('./content/index');
const {
  generateCorrelationId,
  repository,
  queueRepo,
  worker
} = contentModules;

let cwBot = null; // Центральный бот премодерации (CW_BOT_TOKEN)

const SCHEDULE_TZ = process.env.CONTENT_MVP_TZ || 'Europe/Moscow';
const MAX_REJECT_ATTEMPTS = 3;
const DAILY_YT_LIMIT = parseInt(process.env.YOUTUBE_DAILY_LIMIT || '5', 10);
const VIDEO_POLL_TIMEOUT_SEC = parseInt(process.env.YOUTUBE_VIDEO_TIMEOUT_SEC || '900', 10); // 15 мин
const VIDEO_POLL_INTERVAL_SEC = parseInt(process.env.YOUTUBE_VIDEO_POLL_SEC || '25', 10);

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

function getYoutubeSettings(chatId) {
  const cfg = manageStore.getYoutubeConfig(chatId);
  return {
    isActive: !!cfg?.is_active,
    autoPublish: !!cfg?.auto_publish,
    scheduleTime: cfg?.schedule_time || '10:00',
    scheduleEndTime: cfg?.schedule_end_time || null,
    publishIntervalHours: Number.isFinite(cfg?.publish_interval_hours) ? cfg.publish_interval_hours : 24,
    randomPublish: !!cfg?.random_publish,
    moderatorUserId: cfg?.moderator_user_id || null,
    scheduleTz: cfg?.schedule_tz || SCHEDULE_TZ,
    dailyLimit: Number.isFinite(cfg?.daily_limit) ? cfg.daily_limit : DAILY_YT_LIMIT,
    allowedWeekdays: Array.isArray(cfg?.allowed_weekdays) ? cfg.allowed_weekdays : [0, 1, 2, 3, 4, 5, 6],
    stats: cfg?.stats || { total_posts: 0, posts_today: 0, last_post_date: null }
  };
}

async function loadMaterialsText(chatId, limit = 12) {
  try {
    const files = await repository.getFiles(chatId, 'materials');
    const selected = (files || []).slice(0, limit);
    if (!selected.length) return '';
    return selected.map(f => `# ${f.name}\n${f.content}`).join('\n\n');
  } catch {
    return '';
  }
}

async function loadUserPersona(chatId) {
  try {
    const files = await repository.getFiles(chatId, 'persona');
    if (!files?.length) return '';
    return files.map(f => f.content).join('\n\n');
  } catch {
    return '';
  }
}

// ============================================
// AI генерация контента YouTube Shorts
// ============================================

async function generateYoutubeContent(chatId, topic, materialsText, personaText) {
  const data = manageStore.getContentSettings(chatId) || {};

  const prompt = `Ты YouTube-маркетолог и сценарист для YouTube Shorts.

Тема: ${topic.topic}
${topic.focus ? `Фокус: ${topic.focus}` : ''}

${personaText ? `--- ПЕРСОНА ---\n${personaText}\n---` : ''}
${materialsText ? `--- МАТЕРИАЛЫ ---\n${materialsText}\n---` : ''}

Ответь строго в формате JSON:
{
  "videoTitle": "заголовок видео (максимум 60 символов, цепляющий, с ключевыми словами)",
  "videoDescription": "описание видео (максимум 300 символов, с CTA и ключевыми словами для SEO)",
  "tags": ["тег1", "тег2", "тег3", "тег4", "тег5"]
}

ВАЖНО: общая длина videoTitle + videoDescription НЕ ДОЛЖНА превышать 380 символов.

Требования:
- videoTitle: до 60 символов, цепляющий, содержит основное ключевое слово в начале
- videoDescription: до 300 символов, информативный, содержит призыв к подписке
- tags: 5-10 релевантных хэштегов/тегов для YouTube SEO
- Язык: русский
- Не используй эмодзи в заголовке`;

  const messages = [
    { role: 'system', content: 'Ты YouTube-маркетолог. Отвечай только JSON.' },
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
  let videoTitle = String(parsed.videoTitle || '').slice(0, 60);
  let videoDescription = String(parsed.videoDescription || '').slice(0, 300);
  const total = videoTitle.length + 2 + videoDescription.length;
  if (total > 380) {
    videoDescription = videoDescription.slice(0, 380 - videoTitle.length - 2);
  }

  return {
    videoTitle,
    videoDescription,
    tags: Array.isArray(parsed.tags) ? parsed.tags.slice(0, 10) : []
  };
}

// ============================================
// Генерация видео через KIE Veo 3 (синхронно с polling)
// ============================================

async function generateVideo(chatId, prompt, jobId) {
  const apiKey = process.env.KIE_API_KEY;
  if (!apiKey) throw new Error('KIE_API_KEY is not set');

  // Создаём задачу
  const createResp = await fetch('https://api.kie.ai/api/v1/veo/generate', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      prompt: prompt.slice(0, 1000),
      model: process.env.VIDEO_MODEL || 'veo3_fast',
      aspect_ratio: '9:16', // Shorts
      generationType: 'TEXT_2_VIDEO',
      enableTranslation: true
    }),
    timeout: 30000
  });

  if (!createResp.ok) {
    const err = await createResp.text();
    throw new Error(`KIE Veo generate failed: ${createResp.status} ${err.slice(0, 300)}`);
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

  console.log(`[YOUTUBE-MVP] Video generation started: taskId=${taskId}`);

  // Polling 1080p версии (двухэтапный процесс: генерация → upscale до 1080p)
  const pollUrl = `https://api.kie.ai/api/v1/veo/get-1080p-video?taskId=${encodeURIComponent(taskId)}&index=0`;
  const pollHeaders = { Authorization: `Bearer ${apiKey}` };
  const maxAttempts = Math.ceil(VIDEO_POLL_TIMEOUT_SEC / VIDEO_POLL_INTERVAL_SEC);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise(r => setTimeout(r, VIDEO_POLL_INTERVAL_SEC * 1000));

    const pollResp = await fetch(pollUrl, { headers: pollHeaders, timeout: 30000 });
    if (!pollResp.ok) continue;
    const pollData = await pollResp.json();

    if (pollData.code === 200 && pollData.data?.resultUrl) {
      console.log(`[YOUTUBE-MVP] Video generation completed: ${pollData.data.resultUrl}`);
      // Скачиваем видео
      const videoResp = await fetch(pollData.data.resultUrl, { timeout: 120000 });
      if (!videoResp.ok) {
        throw new Error(`Video download failed: ${videoResp.status}`);
      }
      return await videoResp.buffer();
    }

    if (pollData.code === 501) {
      throw new Error(`Video generation failed: ${pollData.msg || 'unknown'}`);
    }

    // code 400 = processing, продолжаем polling
    if (attempt % 4 === 0) {
      console.log(`[YOUTUBE-MVP] Video still processing... attempt ${attempt + 1}/${maxAttempts}`);
    }
  }

  throw new Error('Video generation timeout');
}

// ============================================
// Сохранение файлов
// ============================================

async function saveVideoToHost(chatId, buffer, jobId) {
  const hostDir = path.join(storageService.getDataDir(chatId), 'output', 'content');
  await fs.mkdir(hostDir, { recursive: true });
  const filename = `yt_video_${jobId}.mp4`;
  const filepath = path.join(hostDir, filename);
  await fs.writeFile(filepath, buffer);
  return { filename, filepath };
}

// ============================================
// Draft management (in-memory)
// ============================================

function getYtDrafts(chatId) {
  const data = manageStore.getState(chatId) || {};
  return data.youtubeDrafts || {};
}

function setYtDraft(chatId, draftId, draft) {
  const states = manageStore.getAllStates();
  let data = states[chatId];
  if (!data) {
    data = {};
    states[chatId] = data;
  }
  data.youtubeDrafts = data.youtubeDrafts || {};
  data.youtubeDrafts[draftId] = draft;
  return manageStore.persist(chatId);
}

async function removeYtDraft(chatId, draftId) {
  const data = manageStore.getState(chatId) || {};
  if (data.youtubeDrafts && data.youtubeDrafts[draftId]) {
    delete data.youtubeDrafts[draftId];
    await manageStore.persist(chatId);
  }
}

// ============================================
// Основной обработчик генерации
// ============================================

async function handleYoutubeGenerateJob(chatId, queueJob, bot, correlationId) {
  const settings = getYoutubeSettings(chatId);

  await youtubeRepo.ensureSchema(chatId);

  // Дневной лимит
  const publishedToday = await youtubeRepo.countPublishedToday(chatId, SCHEDULE_TZ);
  if (publishedToday >= DAILY_YT_LIMIT) {
    return { success: false, error: `Дневной лимит YouTube исчерпан (${publishedToday}/${DAILY_YT_LIMIT})`, retry: false };
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

  // Генерация контента (title, description, tags)
  let ytContent;
  try {
    ytContent = await generateYoutubeContent(chatId, topic, materialsText, personaText);
  } catch (e) {
    await repository.updateTopicStatus(chatId, topic.sheetRow, 'pending', `yt_content_failed: ${e.message}`);
    return { success: false, error: `Content generation failed: ${e.message}`, retry: true };
  }

  // Получение видео из общего пайплайна или генерация нового
  let videoPath = '';
  let videoErr = '';

  try {
    // Сначала пробуем забрать готовое видео из общего пула
    const claimResult = await videoPipeline.claimVideo(chatId, 'youtube');

    if (claimResult.success) {
      // Нашли готовое видео — используем его
      videoPath = claimResult.videoPath;
      console.log(`[YOUTUBE-MVP] Using shared video: videoId=${claimResult.videoId}, path=${videoPath}`);

      // Если это первое использование (все каналы ещё не использовали) — видео готово
      // Если уже кто-то использовал — просто берём путь
    } else {
      // Нет доступного видео — генерируем новое
      console.log(`[YOUTUBE-MVP] No shared video available, generating new one`);

      const genResult = await videoPipeline.generateVideo(chatId, 'youtube');
      if (!genResult.success) {
        await repository.updateTopicStatus(chatId, topic.sheetRow, 'pending', `yt_video_failed: ${genResult.error}`);
        return { success: false, error: `Video generation failed: ${genResult.error}`, retry: true };
      }

      videoPath = genResult.videoPath;
      console.log(`[YOUTUBE-MVP] New video generated: videoId=${genResult.videoId}, path=${videoPath}`);
    }
  } catch (e) {
    videoErr = e?.message || String(e);
    console.error(`[YOUTUBE-MVP] Video pipeline failed: ${videoErr}`);
    await repository.updateTopicStatus(chatId, topic.sheetRow, 'pending', `yt_video_failed: ${videoErr}`);
    return { success: false, error: `Video pipeline failed: ${videoErr}`, retry: true };
  }

  // Запись в БД
  const jobId = await youtubeRepo.createJob(chatId, {
    topic: topic.topic,
    videoTitle: ytContent.videoTitle,
    videoDescription: ytContent.videoDescription,
    tags: ytContent.tags,
    videoPath,
    videoUrl: null, // будет заполнено при публикации
    link: '',
    status: 'ready',
    correlationId
  });

  const draft = {
    jobId,
    topic,
    videoTitle: ytContent.videoTitle,
    videoDescription: ytContent.videoDescription,
    tags: ytContent.tags,
    videoPath,
    correlationId,
    rejectedCount: 0
  };

  // Маршрутизация: автопубликация или модерация
  if (settings.autoPublish) {
    await setYtDraft(chatId, String(jobId), draft);
    await publishYoutubePost(chatId, bot, jobId, correlationId);
  } else {
    await sendYtToModerator(chatId, bot, draft);
  }

  return { success: true, data: { jobId } };
}

// ============================================
// Публикация через Buffer
// ============================================

async function publishYoutubePost(chatId, bot, jobId, correlationId) {
  const corrId = correlationId || generateCorrelationId();
  const job = await youtubeRepo.getJobById(chatId, jobId);
  if (!job) throw new Error(`YouTube job ${jobId} not found`);

  const cfg = manageStore.getYoutubeConfig(chatId);
  if (!cfg) throw new Error('YouTube не настроен');
  if (!cfg.buffer_api_key || !cfg.buffer_channel_id) {
    throw new Error('Buffer API key или channel_id не настроены');
  }

  // Формируем публичные URL
  const videoUrl = job.video_path
    ? `${config.APP_URL}/api/files/public/${chatId}/${job.video_path}`
    : null;

  if (!videoUrl) {
    throw new Error('video_url не задан для YouTube job');
  }

  // Формируем текст (лимит Buffer ~500 символов)
  let text = [job.video_title, '', job.video_description].filter(Boolean).join('\n');
  if (job.tags && Array.isArray(job.tags)) {
    const tagsStr = job.tags.map(t => `#${t}`).join(' ');
    text += '\n\n' + tagsStr;
  }
  if (text.length > 500) {
    text = text.slice(0, 497) + '...';
  }

  // Публикация через Buffer
  const bufferResult = await bufferService.createPost(cfg.buffer_api_key, cfg.buffer_channel_id, {
    text,
    videoUrl,
    youtubeTitle: job.video_title || 'YouTube Short',
    youtubeCategoryId: '24'
  });

  console.log(`[YOUTUBE-MVP] Published via Buffer, postId=${bufferResult.postId}`);

  // Лог публикации
  await youtubeRepo.addPublishLog(chatId, {
    jobId,
    bufferPostId: bufferResult.postId,
    status: 'published',
    correlationId: corrId
  });

  // Обновить статус
  await youtubeRepo.updateJob(chatId, jobId, { status: 'published' });

  // Обновить статистику
  const stats = cfg.stats || {};
  const today = getNowInTz(SCHEDULE_TZ).date;
  const postsToday = stats.last_post_date === today ? (stats.posts_today || 0) + 1 : 1;
  await manageStore.setYoutubeConfig(chatId, {
    stats: {
      total_posts: (stats.total_posts || 0) + 1,
      posts_today: postsToday,
      last_post_date: today
    }
  });

  // Удалить черновик
  await removeYtDraft(chatId, String(jobId));

  // Уведомление в бот
  if (bot?.telegram) {
    const msg = `📹 YouTube Short опубликован!\n${job.video_title}`;
    await bot.telegram.sendMessage(chatId, msg).catch(() => {});
  }

  return { id: bufferResult.postId };
}

// ============================================
// Модерация
// ============================================

async function sendYtToModerator(chatId, bot, draft) {
  const settings = getYoutubeSettings(chatId);
  const globalSettings = manageStore.getContentSettings?.(chatId);

  // Иерархия: модератор канала → глобальный модератор → chatId
  const moderatorId = settings.moderatorUserId ||
                      globalSettings?.moderatorUserId ||
                      chatId;

  const tagsText = draft.tags?.length ? draft.tags.map(t => `#${t}`).join(' ') : '';
  const caption = [
    `📹 Черновик для YouTube Shorts #${draft.jobId}`,
    '',
    `Название: ${draft.videoTitle}`,
    '',
    draft.videoDescription,
    tagsText ? tagsText : '',
    draft.correlationId ? `📋 ${draft.correlationId}` : ''
  ].filter(Boolean).join('\n').slice(0, 1024);

  const callbackBase = `yt_mod:${draft.jobId}`;
  const kb = {
    inline_keyboard: [
      [
        { text: '✅ Опубликовать', callback_data: `${callbackBase}:approve` },
        { text: '❌ Отклонить', callback_data: `${callbackBase}:reject` }
      ],
      [
        { text: '🔁 Текст', callback_data: `${callbackBase}:regen_text` }
      ]
    ]
  };

  // Отправляем видео модератору
  const videoLocalPath = path.join(storageService.getDataDir(chatId), 'output', 'content', draft.videoPath);

  const moderatorBot = cwBot && cwBot.token !== bot?.token ? cwBot : bot;

  try {
    const sent = await moderatorBot.telegram.sendVideo(moderatorId, { source: videoLocalPath }, { caption, reply_markup: kb });
    await setYtDraft(chatId, String(draft.jobId), {
      ...draft,
      moderationMessageId: sent.message_id
    });
  } catch (e) {
    // Если видео недоступ — отправляем только текст
    console.warn(`[YOUTUBE-MVP] Video send failed, sending text only: ${e.message}`);
    const sent = await moderatorBot.telegram.sendMessage(moderatorId, caption, { reply_markup: kb });
    await setYtDraft(chatId, String(draft.jobId), {
      ...draft,
      moderationMessageId: sent.message_id
    });
  }
}

async function handleYtModerationAction(chatId, bot, jobId, action) {
  const draft = getYtDrafts(chatId)[String(jobId)];
  if (!draft) return { ok: false, message: 'Черновик YouTube не найден.' };

  const correlationId = draft.correlationId || generateCorrelationId();

  if (action === 'approve') {
    try {
      await publishYoutubePost(chatId, bot, jobId, correlationId);
      return { ok: true, message: `📹 YouTube Short #${jobId} опубликован.` };
    } catch (e) {
      const isRateLimit = e.message && (e.message.includes('429') || e.message.includes('rate limited') || e.message.includes('Rate limited'));

      if (isRateLimit) {
        // Не помечаем как failed — оставляем в текущем статусе
        await youtubeRepo.addPublishLog(chatId, {
          jobId, status: 'rate_limited',
          errorText: e.message, correlationId
        });
        return { ok: false, message: `⏳ Buffer API перегружен (rate limit). Попробуйте нажать "Опубликовать" через 15-30 минут. Ошибка: ${e.message}` };
      }

      await youtubeRepo.addPublishLog(chatId, {
        jobId, status: 'failed',
        errorText: e.message, correlationId
      });
      await youtubeRepo.updateJob(chatId, jobId, { status: 'failed', errorText: e.message });
      return { ok: false, message: `Ошибка публикации: ${e.message}` };
    }
  }

  if (action === 'regen_text') {
    try {
      const [materialsText, personaText] = await Promise.all([
        loadMaterialsText(chatId, 12),
        loadUserPersona(chatId)
      ]);
      const content = await generateYoutubeContent(chatId, draft.topic, materialsText, personaText);
      draft.videoTitle = content.videoTitle;
      draft.videoDescription = content.videoDescription;
      draft.tags = content.tags;
      await youtubeRepo.updateJob(chatId, jobId, {
        videoTitle: content.videoTitle,
        videoDescription: content.videoDescription,
        tags: content.tags
      });
      await sendYtToModerator(chatId, bot, draft);
      return { ok: true, message: 'Текст YouTube перегенерирован.' };
    } catch (e) {
      return { ok: false, message: `Ошибка перегенерации текста: ${e.message}` };
    }
  }

  if (action === 'reject') {
    draft.rejectedCount = (draft.rejectedCount || 0) + 1;
    await setYtDraft(chatId, String(jobId), draft);

    if (draft.rejectedCount >= MAX_REJECT_ATTEMPTS) {
      await youtubeRepo.updateJob(chatId, jobId, { status: 'failed', errorText: 'Rejected 3 times' });
      await removeYtDraft(chatId, String(jobId));
      return { ok: true, message: `YouTube отклонен ${MAX_REJECT_ATTEMPTS} раза. Задача закрыта.` };
    }

    // Полная перегенерация
    try {
      const [materialsText, personaText] = await Promise.all([
        loadMaterialsText(chatId, 12),
        loadUserPersona(chatId)
      ]);
      const content = await generateYoutubeContent(chatId, draft.topic, materialsText, personaText);

      draft.videoTitle = content.videoTitle;
      draft.videoDescription = content.videoDescription;
      draft.tags = content.tags;

      await youtubeRepo.updateJob(chatId, jobId, {
        videoTitle: content.videoTitle,
        videoDescription: content.videoDescription,
        tags: content.tags,
        rejectedCount: draft.rejectedCount
      });

      await sendYtToModerator(chatId, bot, draft);
      return { ok: true, message: `YouTube перегенерирован (${draft.rejectedCount}/${MAX_REJECT_ATTEMPTS}).` };
    } catch (e) {
      return { ok: false, message: `Ошибка перегенерации: ${e.message}` };
    }
  }

  return { ok: false, message: 'Неизвестное действие.' };
}

// ============================================
// Планировщик
// ============================================

async function tickYoutubeSchedule(chatId, bot) {
  const cfg = manageStore.getYoutubeConfig(chatId);
  if (!cfg || !cfg.is_active) return;

  const settings = getYoutubeSettings(chatId);
  const now = getNowInTz(settings.scheduleTz);

  // Проверка разрешённых дней недели
  const dayOfWeek = new Date().getDay();
  if (!settings.allowedWeekdays.includes(dayOfWeek)) return;

  // Дневной лимит
  const publishedToday = await youtubeRepo.countPublishedToday(chatId, settings.scheduleTz);
  if (publishedToday >= settings.dailyLimit) return;

  const [startH, startM] = (settings.scheduleTime || '10:00').split(':').map(Number);
  const [nowH, nowM] = now.time.split(':').map(Number);
  const startMinutes = startH * 60 + startM;
  const nowMinutes = nowH * 60 + nowM;

  if (settings.scheduleEndTime) {
    const [endH, endM] = settings.scheduleEndTime.split(':').map(Number);
    if (nowMinutes >= endH * 60 + endM) return;
  }

  const intervalMinutes = Math.round((settings.publishIntervalHours || 24) * 60);

  const data = manageStore.getState(chatId) || {};

  if (settings.randomPublish) {
    // Рандомный режим
    let currentSlot = -1;
    for (let slot = startMinutes; slot < 24 * 60; slot += intervalMinutes) {
      if (nowMinutes >= slot) currentSlot = slot;
    }
    if (currentSlot < 0) return;

    const slotKey = `youtubeRandomSlot:${currentSlot}`;
    const runKey = `youtubeRandomRun:${currentSlot}`;

    if (data[runKey] === now.date) return;

    let needRegenerate = !data[slotKey] || data[slotKey].split('|')[0] !== now.date;
    if (!needRegenerate && data[slotKey]) {
      const existingTarget = parseInt(data[slotKey].split('|')[1], 10);
      const minAllowed = currentSlot + Math.round(intervalMinutes * 0.85);
      const maxAllowed = currentSlot + intervalMinutes;
      if (existingTarget < minAllowed || existingTarget > maxAllowed) {
        needRegenerate = true;
      }
    }
    if (needRegenerate) {
      const minOffset = Math.round(intervalMinutes * 0.85);
      const randomOffset = minOffset + Math.floor(Math.random() * (intervalMinutes - minOffset + 1));
      const targetMinute = currentSlot + randomOffset;
      data[slotKey] = `${now.date}|${targetMinute}`;
      await manageStore.persist(chatId);
    }

    const targetMinute = parseInt(data[slotKey].split('|')[1], 10);
    if (nowMinutes < targetMinute) {
      if (nowMinutes % 10 === 0) {
        const tgtH = Math.floor(targetMinute / 60);
        const tgtM = targetMinute % 60;
        console.log(`[YOUTUBE-SCHEDULE-RANDOM] ${chatId} waiting: now=${now.time}, target=${String(tgtH).padStart(2,'0')}:${String(tgtM).padStart(2,'0')}`);
      }
      return;
    }

    data[runKey] = now.date;
    await manageStore.persist(chatId);
    console.log(`[YOUTUBE-SCHEDULE-RANDOM] ${chatId} random time reached ${now.time}, enqueueing youtube_generate`);
  } else {
    // Фиксированный режим
    let isSlot = false;
    for (let slot = startMinutes; slot < 24 * 60; slot += intervalMinutes) {
      if (nowMinutes === slot) { isSlot = true; break; }
    }
    if (!isSlot) {
      if (nowMinutes % 10 === 0) {
        console.log(`[YOUTUBE-SCHEDULE] ${chatId} waiting: now=${now.time}, start=${settings.scheduleTime}, interval=${settings.publishIntervalHours}h`);
      }
      return;
    }

    const key = `youtubeLastRun:${now.time}`;
    if (data[key] === now.date) return;

    data[key] = now.date;
    await manageStore.persist(chatId);
    console.log(`[YOUTUBE-SCHEDULE] ${chatId} slot matched ${now.time}, enqueueing youtube_generate`);
  }

  // Ставим в очередь
  await queueRepo.ensureQueueSchema(chatId);
  await queueRepo.enqueue(chatId, {
    jobType: 'youtube_generate',
    priority: 0,
    payload: { reason: 'schedule' },
    correlationId: generateCorrelationId()
  });
}

async function runNow(chatId, bot, reason = 'manual') {
  await youtubeRepo.ensureSchema(chatId);

  const settings = getYoutubeSettings(chatId);
  const publishedToday = await youtubeRepo.countPublishedToday(chatId, settings.scheduleTz);
  if (publishedToday >= settings.dailyLimit) {
    return { ok: false, message: `Дневной лимит YouTube исчерпан (${publishedToday}/${settings.dailyLimit}).` };
  }

  const correlationId = generateCorrelationId();

  if (reason !== 'schedule') {
    try {
      const result = await handleYoutubeGenerateJob(chatId, {
        payload: { reason },
        correlation_id: correlationId
      }, bot, correlationId);
      if (result.success) {
        return { ok: true, message: 'YouTube Short сгенерирован.', correlationId };
      } else {
        return { ok: false, message: result.error || 'Генерация не удалась.', correlationId };
      }
    } catch (e) {
      return { ok: false, message: `Ошибка: ${e.message}`, correlationId };
    }
  }

  await queueRepo.ensureQueueSchema(chatId);
  const queueJobId = await queueRepo.enqueue(chatId, {
    jobType: 'youtube_generate',
    priority: 0,
    payload: { reason },
    correlationId
  });

  return { ok: true, message: `YouTube-задача #${queueJobId} в очереди.`, queueJobId, correlationId };
}

// ============================================
// Scheduler & Worker Registration
// ============================================

function startScheduler(getBots) {
  botsGetter = getBots;

  // Регистрируем обработчики задач YouTube
  worker.registerJobHandler('youtube_generate', handleYoutubeGenerateJob);
  worker.registerJobHandler('youtube_publish', async (chatId, queueJob, bot, correlationId) => {
    const jobId = queueJob.job_id || queueJob.payload?.jobId;
    if (!jobId) return { success: false, error: 'No jobId', retry: false };
    try {
      await publishYoutubePost(chatId, bot, jobId, correlationId);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message, retry: true };
    }
  });

  // Запускаем worker с поддержкой CW_BOT_TOKEN
  worker.startWorker(getBots, () => cwBot);

  // Планировщик YouTube (раз в минуту)
  if (schedulerHandle) clearInterval(schedulerHandle);
  schedulerHandle = setInterval(async () => {
    try {
      const bots = getBots();
      for (const [chatId, entry] of bots.entries()) {
        try {
          await tickYoutubeSchedule(chatId, entry.bot);
        } catch (e) {
          console.error(`[YOUTUBE-MVP-SCHEDULER] Error for ${chatId}:`, e.message);
        }
      }
    } catch (e) {
      console.error('[YOUTUBE-MVP-SCHEDULER]', e.message);
    }
  }, 60 * 1000);

  console.log('[YOUTUBE-MVP] Scheduler and worker started');
}

function stopScheduler() {
  if (schedulerHandle) {
    clearInterval(schedulerHandle);
    schedulerHandle = null;
  }
  console.log('[YOUTUBE-MVP] Scheduler stopped');
}

// ============================================
// Exports
// ============================================

module.exports = {
  startScheduler,
  stopScheduler,
  runNow,
  handleYoutubeGenerateJob,
  publishYoutubePost,
  sendYtToModerator,
  handleYtModerationAction,
  tickYoutubeSchedule,
  getYoutubeSettings,
  listJobs: (chatId, opts) => youtubeRepo.listJobs(chatId, opts),
  getJobById: (chatId, jobId) => youtubeRepo.getJobById(chatId, jobId),
  setYtCwBot: (bot) => { cwBot = bot; },
  getYtCwBot: () => cwBot
};
