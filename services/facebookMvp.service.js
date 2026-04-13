/**
 * Facebook MVP Service — генерация, модерация, публикация Facebook-постов
 * Публикация через Buffer GraphQL API (аналогично Instagram/Pinterest)
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
const bufferService = require('./buffer.service');
const fbRepo = require('./content/facebook.repository');
const inputImageContext = require('./inputImageContext.service');

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
const DAILY_FB_LIMIT = parseInt(process.env.FACEBOOK_DAILY_LIMIT || '10', 10);
const PROFILE_FILES = ['IDENTITY.md', 'SOUL.md'];
const FB_MODERATION_TIMEOUT_HOURS = parseInt(process.env.FACEBOOK_MODERATION_TIMEOUT_HOURS || '24', 10);

// Соотношение сторон для Facebook (рекомендуется 1.91:1)
const FB_IMAGE_ASPECT_RATIO = '1.91:1';
const FB_IMAGE_WIDTH = 1200;
const FB_IMAGE_HEIGHT = 630;

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

function getFacebookSettings(chatId) {
  const cfg = manageStore.getFacebookConfig(chatId);
  return {
    isActive: !!cfg?.is_active,
    autoPublish: !!cfg?.auto_publish,
    bufferApiKey: cfg?.buffer_api_key || null,
    bufferChannelId: cfg?.buffer_channel_id || null,
    pageName: cfg?.page_name || null,
    scheduleTime: cfg?.schedule_time || '10:00',
    scheduleEndTime: cfg?.schedule_end_time || null,
    scheduleTz: isValidTz(cfg?.schedule_tz) ? cfg.schedule_tz : SCHEDULE_TZ,
    dailyLimit: Number.isFinite(cfg?.daily_limit) ? cfg.daily_limit : DAILY_FB_LIMIT,
    publishIntervalHours: Number.isFinite(cfg?.publish_interval_hours) ? cfg.publish_interval_hours : 4,
    randomPublish: !!cfg?.random_publish,
    allowedWeekdays: Array.isArray(cfg?.allowed_weekdays) ? cfg.allowed_weekdays : [0, 1, 2, 3, 4, 5, 6],
    moderatorUserId: cfg?.moderator_user_id || null,
    stats: cfg?.stats || { total_posts: 0, posts_today: 0, last_post_date: null }
  };
}

// ============================================
// Загрузка контента пользователя
// ============================================

async function loadMaterialsText(chatId, limit = 10) {
  await fbRepo.ensureSchema(chatId);
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
// AI-генерация для Facebook
// ============================================

async function generateFbPostText(chatId, topic, materialsText, personaText) {
  const data = manageStore.getState(chatId);
  const hasApiKey = data?.aiCustomApiKey || data?.aiAuthToken;
  if (!hasApiKey || !data?.aiModel) {
    throw new Error('AI model is not configured');
  }

  const prompt = `Ты SMM-маркетолог Facebook. Создай контент для поста на Facebook страницу.

Тема: ${topic.topic}
${topic.focus ? `Фокус: ${topic.focus}` : ''}

${personaText ? `--- ПЕРСОНА ---\n${personaText}\n---` : ''}
${materialsText ? `--- МАТЕРИАЛЫ ---\n${materialsText}\n---` : ''}

Ответь строго в формате JSON:
{
  "postText": "текст поста для Facebook (100-500 символов, первая строка — хук, CTA в конце)",
  "hashtags": ["#хештег1", "#хештег2", "#хештег3"],
  "imagePrompt": "промпт для генерации изображения на английском (соотношение 1.91:1, профессиональный Facebook стиль, без текста на изображении)"
}

Требования:
- postText: 100-500 символов оптимально, вовлекающий, без канцелярита
- hashtags: 3-5 релевантных хештегов в конце текста
- imagePrompt: на английском, описание визуала, 1.91:1, без текста на изображении
- Стиль: разговорный, профессиональный, CTA в конце
- Язык: русский (кроме imagePrompt)`;

  const messages = [
    { role: 'system', content: 'Ты SMM-маркетолог Facebook. Отвечай только JSON.' },
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
    postText: String(parsed.postText || '').slice(0, 500),
    hashtags: Array.isArray(parsed.hashtags) ? parsed.hashtags.slice(0, 5) : [],
    imagePrompt: String(parsed.imagePrompt || '').slice(0, 800)
  };
}

async function generateFbImage(chatId, topic, imagePrompt, jobId) {
  const basePrompt = (imagePrompt || `Facebook post image about ${topic.topic}. Style: professional, engaging, social media optimized, no text overlay.`).slice(0, 800);
  return inputImageContext.generateImage(chatId, basePrompt, '1:1', 'grok-imagine/text-to-image');
}

async function saveImageToContainer(chatId, imageBuffer, jobId) {
  const session = await sessionService.getOrCreateSession(chatId);
  const containerPath = `/workspace/cache/images/facebook/fb_${jobId}.png`;
  const hostDir = path.join(storageService.getDataDir(chatId), 'cache', 'images', 'facebook');

  await fs.mkdir(hostDir, { recursive: true });
  const hostPath = path.join(hostDir, `fb_${jobId}.png`);
  await fs.writeFile(hostPath, imageBuffer);

  // Копирование в контейнер
  await dockerService.copyToContainer(session.containerId, hostPath, containerPath);

  return containerPath;
}

// ============================================
// Worker handlers
// ============================================

async function handleFacebookGenerateJob(chatId, queueJob, bot, correlationId) {
  console.log(`[FB] handleFacebookGenerateJob for ${chatId}, job ${queueJob.id}`);

  // Получаем тему
  await repository.ensureSchema(chatId);
  await fbRepo.ensureSchema(chatId);

  const topic = await repository.pickTopic(chatId);
  if (!topic) {
    console.log(`[FB] No topic available for ${chatId}`);
    await fbRepo.addPublishLog(chatId, {
      bufferChannelId: getFacebookSettings(chatId).bufferChannelId,
      status: 'skipped',
      errorText: 'No topic available',
      correlationId
    });
    return;
  }

  // Создаём задачу
  const jobId = await fbRepo.createJob(chatId, {
    topic: topic.topic,
    focus: topic.focus,
    status: 'draft',
    correlationId
  });

  console.log(`[FB] Created job ${jobId} for topic: ${topic.topic}`);

  // Обновляем тему как использованную
  await repository.markTopicUsed(chatId, topic.id);

  // Генерация текста
  try {
    const personaText = await loadUserPersona(chatId);
    const materialsText = await loadMaterialsText(chatId, 10);

    const aiResult = await generateFbPostText(chatId, topic, materialsText, personaText);

    // Объединяем текст и хештеги
    const fullPostText = `${aiResult.postText}\n\n${aiResult.hashtags.join(' ')}`;

    await fbRepo.updateJob(chatId, jobId, {
      postText: fullPostText,
      imagePrompt: aiResult.imagePrompt,
      status: 'media_generating'
    });

    console.log(`[FB] Text generated for job ${jobId}`);

    // Генерация изображения
    let imageAttempts = 0;
    let imageBuffer = null;
    let imagePath = null;

    while (imageAttempts < MAX_IMAGE_ATTEMPTS && !imageBuffer) {
      imageAttempts++;
      try {
        console.log(`[FB] Image generation attempt ${imageAttempts}/${MAX_IMAGE_ATTEMPTS}`);
        imageBuffer = await generateFbImage(chatId, topic, aiResult.imagePrompt, jobId);
        imagePath = await saveImageToContainer(chatId, imageBuffer, jobId);
        console.log(`[FB] Image saved to ${imagePath}`);
      } catch (e) {
        console.error(`[FB] Image attempt ${imageAttempts} failed:`, e.message);
        if (imageAttempts >= MAX_IMAGE_ATTEMPTS) {
          throw e;
        }
        await new Promise(r => setTimeout(r, 3000));
      }
    }

    await fbRepo.updateJob(chatId, jobId, {
      imagePath,
      imageAttempts,
      status: 'ready'
    });

    console.log(`[FB] Job ${jobId} ready for moderation`);

    // Определяем следующее действие
    const settings = getFacebookSettings(chatId);
    if (settings.autoPublish) {
      // Автопубликация
      await publishFbPost(chatId, bot, jobId, correlationId);
    } else {
      // Отправка на модерацию
      await sendFbToModerator(chatId, bot, { ...topic, jobId, postText: fullPostText, imagePath });
    }

  } catch (e) {
    console.error(`[FB] Error in job ${jobId}:`, e);
    await fbRepo.updateJob(chatId, jobId, {
      status: 'failed',
      errorText: e.message
    });
  }
}

async function publishFbPost(chatId, bot, jobId, correlationId) {
  console.log(`[FB] publishFbPost for ${chatId}, job ${jobId}`);

  const job = await fbRepo.getJobById(chatId, jobId);
  if (!job) {
    throw new Error(`Job ${jobId} not found`);
  }

  const settings = getFacebookSettings(chatId);
  if (!settings.bufferApiKey || !settings.bufferChannelId) {
    throw new Error('Facebook buffer_api_key or buffer_channel_id is not configured');
  }

  try {
    // Получаем изображение из контейнера
    const session = await sessionService.getOrCreateSession(chatId);
    const hostPath = path.join(storageService.getDataDir(chatId), 'cache', 'images', 'facebook', `fb_${jobId}.png`);

    // Копируем из контейнера, если изображение там
    try {
      await dockerService.copyFromContainer(session.containerId, job.image_path, hostPath);
    } catch (e) {
      console.warn(`[FB] Could not copy image from container:`, e.message);
    }

    // Проверяем, есть ли файл
    let imageBuffer = null;
    let publicImageUrl = null;

    try {
      const stat = await fs.stat(hostPath);
      if (stat.size > 0) {
        imageBuffer = await fs.readFile(hostPath);
      }
    } catch (e) {
      console.warn(`[FB] Image file not found:`, e.message);
    }

    // Если нет изображения, пропускаем публикацию
    if (!imageBuffer) {
      throw new Error('Image not available for publication');
    }

    // Публикация через Buffer (вместе с изображением)
    // Для Buffer нам нужен публичный URL изображения
    // Если нет хостинга изображений, используем текстовый пост
    const result = await bufferService.createPost(
      settings.bufferApiKey,
      settings.bufferChannelId,
      {
        text: job.post_text,
        imageUrl: publicImageUrl // Если null, Buffer может работать только с текстом
      }
    );

    console.log(`[FB] Buffer post created: ${result.postId}`);

    // Обновляем задачу
    await fbRepo.markPublished(chatId, jobId, result.postId, settings.bufferChannelId);

    // Обновляем статистику
    const stats = { ...settings.stats };
    stats.total_posts++;
    stats.posts_today++;
    stats.last_post_date = new Date().toISOString();

    manageStore.setFacebookConfig(chatId, { stats });

    console.log(`[FB] Job ${jobId} published successfully`);

    // Уведомление пользователю
    try {
      const message = `✅ Facebook пост опубликован!\n\n${job.post_text}`;
      if (bot && bot.telegram) {
        await bot.telegram.sendMessage(chatId, message);
      }
    } catch (e) {
      console.warn('[FB] Could not send notification:', e.message);
    }

  } catch (e) {
    console.error(`[FB] Publication failed for job ${jobId}:`, e);

    await fbRepo.updateJob(chatId, jobId, {
      status: 'failed',
      errorText: e.message
    });

    await fbRepo.addPublishLog(chatId, {
      bufferChannelId: settings.bufferChannelId,
      status: 'failed',
      errorText: e.message,
      correlationId
    });

    throw e;
  }
}

async function sendFbToModerator(chatId, bot, draft) {
  console.log(`[FB] sendFbToModerator for ${chatId}, job ${draft.jobId}`);

  const settings = getFacebookSettings(chatId);
  const moderatorId = settings.moderatorUserId || chatId;

  const caption = (draft.postText || '').slice(0, 1000);

  // Клавиатура для модерации
  const keyboard = {
    inline_keyboard: [
      [
        { text: '✅ Одобрить', callback_data: `fb_approve_${draft.jobId}` },
        { text: '🔄 Текст', callback_data: `fb_regen_text_${draft.jobId}` }
      ],
      [
        { text: '🖼️ Картинка', callback_data: `fb_regen_image_${draft.jobId}` },
        { text: '❌ Отклонить', callback_data: `fb_reject_${draft.jobId}` }
      ]
    ]
  };

  const message = `📘 Facebook пост на модерацию

📝 Тема: ${draft.topic}
${draft.focus ? `🎯 Фокус: ${draft.focus}` : ''}

📄 Текст:
${caption}

Выберите действие:`;

  try {
    if (cwBot && cwBot.telegram) {
      await cwBot.telegram.sendMessage(moderatorId, message, { reply_markup: keyboard });
    } else if (bot && bot.telegram) {
      await bot.telegram.sendMessage(moderatorId, message, { reply_markup: keyboard });
    }
  } catch (e) {
    console.error('[FB] Failed to send to moderator:', e);
  }
}

async function handleFacebookModerationAction(chatId, bot, jobId, action) {
  console.log(`[FB] handleFacebookModerationAction ${action} for job ${jobId}`);

  const job = await fbRepo.getJobById(chatId, jobId);
  if (!job) {
    return { ok: false, message: 'Задача не найдена' };
  }

  const settings = getFacebookSettings(chatId);

  if (action === 'approve') {
    await publishFbPost(chatId, bot, jobId, job.correlation_id);
    return { ok: true, message: 'Facebook пост опубликован' };
  }

  if (action === 'regen_text') {
    // Перегенерация текста
    const topic = { topic: job.topic, focus: job.focus };
    const personaText = await loadUserPersona(chatId);
    const materialsText = await loadMaterialsText(chatId, 10);

    const aiResult = await generateFbPostText(chatId, topic, materialsText, personaText);
    const fullPostText = `${aiResult.postText}\n\n${aiResult.hashtags.join(' ')}`;

    await fbRepo.updateJob(chatId, jobId, {
      postText: fullPostText,
      imagePrompt: aiResult.imagePrompt,
      status: 'ready'
    });

    // Отправка на модерацию
    await sendFbToModerator(chatId, bot, { ...topic, jobId, postText: fullPostText, imagePath: job.image_path });

    return { ok: true, message: 'Текст перегенерирован и отправлен на модерацию' };
  }

  if (action === 'regen_image') {
    // Перегенерация изображения
    const topic = { topic: job.topic, focus: job.focus };
    const currentAttempts = job.image_attempts || 0;

    if (currentAttempts >= MAX_IMAGE_ATTEMPTS) {
      await fbRepo.updateJob(chatId, jobId, {
        status: 'failed',
        errorText: 'Maximum image generation attempts reached'
      });
      return { ok: false, message: 'Достигнут лимит попыток генерации изображения' };
    }

    try {
      const imageBuffer = await generateFbImage(chatId, topic, job.image_prompt, jobId);
      const imagePath = await saveImageToContainer(chatId, imageBuffer, jobId);

      await fbRepo.updateJob(chatId, jobId, {
        imagePath,
        imageAttempts: currentAttempts + 1,
        status: 'ready'
      });

      // Отправка на модерацию
      await sendFbToModerator(chatId, bot, { ...topic, jobId, postText: job.post_text, imagePath });

      return { ok: true, message: 'Изображение перегенерировано' };
    } catch (e) {
      await fbRepo.updateJob(chatId, jobId, {
        status: 'failed',
        errorText: e.message,
        imageAttempts: currentAttempts + 1
      });
      return { ok: false, message: `Ошибка генерации изображения: ${e.message}` };
    }
  }

  if (action === 'reject') {
    const rejectedCount = (job.rejected_count || 0) + 1;

    if (rejectedCount >= MAX_REJECT_ATTEMPTS) {
      await fbRepo.updateJob(chatId, jobId, {
        status: 'failed',
        errorText: 'Maximum rejection attempts reached',
        rejectedCount
      });
      return { ok: false, message: 'Задача отклонена окончательно' };
    }

    // Полная перегенерация
    await fbRepo.updateJob(chatId, jobId, {
      status: 'draft',
      rejectedCount,
      postText: null,
      imagePath: null,
      imagePrompt: null
    });

    // Повторная постановка в очередь
    await queueRepo.enqueue(chatId, {
      jobType: 'facebook_generate',
      priority: 0,
      payload: { reason: 'regenerate_after_reject', rejectedCount }
    });

    return { ok: true, message: 'Задача отправлена на полную перегенерацию' };
  }

  return { ok: false, message: 'Неизвестное действие' };
}

// ============================================
// Планировщик
// ============================================

async function tickFacebookSchedule(chatId, bot) {
  console.log(`[FB] tickFacebookSchedule for ${chatId}`);

  const settings = getFacebookSettings(chatId);

  if (!settings.isActive) {
    console.log(`[FB] Not active for ${chatId}`);
    return;
  }

  const now = getNowInTz(settings.scheduleTz);
  const currentWeekday = new Date().getDay(); // 0 = Sunday
  const currentMinutes = parseInt(now.time.split(':')[0], 10) * 60 + parseInt(now.time.split(':')[1], 10);

  // Проверка дня недели
  if (!settings.allowedWeekdays.includes(currentWeekday)) {
    console.log(`[FB] Today ${currentWeekday} is not in allowed weekdays`);
    return;
  }

  // Проверка дневного лимита
  const publishedToday = await fbRepo.countPublishedToday(chatId, settings.scheduleTz);
  if (publishedToday >= settings.dailyLimit) {
    console.log(`[FB] Daily limit reached for ${chatId}: ${publishedToday}/${settings.dailyLimit}`);
    return;
  }

  // Расчёт времени публикации
  const [startH, startM] = settings.scheduleTime.split(':').map(Number);
  const startMinutes = startH * 60 + startM;

  if (settings.scheduleEndTime) {
    const [endH, endM] = settings.scheduleEndTime.split(':').map(Number);
    if (currentMinutes >= endH * 60 + endM) return;
  }
  const intervalMinutes = settings.publishIntervalHours * 60;

  // Найдём последний слот для публикации
  const startOfDay = startMinutes;
  const slotsSinceStart = Math.floor((currentMinutes - startOfDay) / intervalMinutes);
  const nextSlotStart = startOfDay + (slotsSinceStart + 1) * intervalMinutes;

  let targetMinutes;

  if (settings.randomPublish) {
    // Рандомный режим: 85-100% от интервала
    const randomOffset = Math.floor(intervalMinutes * 0.15 * Math.random());
    targetMinutes = nextSlotStart + randomOffset;
  } else {
    // Фиксированный режим
    targetMinutes = nextSlotStart;
  }

  // Проверяем, наступило ли время
  if (currentMinutes >= targetMinutes) {
    console.log(`[FB] Time to publish for ${chatId}`);

    // Проверяем, не было ли публикации в этом слоте
    const lastPostDate = settings.stats?.last_post_date;
    if (lastPostDate) {
      const lastPostTime = new Date(lastPostDate).getTime();
      const slotTime = Date.now() - (currentMinutes - targetMinutes) * 60000;
      if (lastPostTime > slotTime) {
        console.log(`[FB] Already published in this slot for ${chatId}`);
        return;
      }
    }

    // Постановка в очередь
    const correlationId = generateCorrelationId();
    await queueRepo.enqueue(chatId, {
      jobType: 'facebook_generate',
      priority: 0,
      payload: { reason: 'schedule', correlationId }
    });

    console.log(`[FB] Enqueued facebook_generate for ${chatId}`);
  }
}

async function runNow(chatId, bot, reason = 'api') {
  console.log(`[FB] runNow for ${chatId}, reason: ${reason}`);

  const settings = getFacebookSettings(chatId);
  if (!settings.isActive) {
    throw new Error('Facebook channel is not active');
  }

  // Проверка дневного лимита
  const publishedToday = await fbRepo.countPublishedToday(chatId, settings.scheduleTz);
  if (publishedToday >= settings.dailyLimit) {
    throw new Error(`Daily limit reached: ${publishedToday}/${settings.dailyLimit}`);
  }

  const correlationId = generateCorrelationId();
  await queueRepo.enqueue(chatId, {
    jobType: 'facebook_generate',
    priority: 10, // Высокий приоритет для ручного запуска
    payload: { reason, correlationId }
  });

  return { ok: true, message: 'Facebook генерация запущена', correlationId };
}

// ============================================
// Инициализация и старт планировщика
// ============================================

function startScheduler(getBots) {
  console.log('[FB] Starting Facebook scheduler');

  botsGetter = getBots;

  if (!schedulerHandle) {
    schedulerHandle = setInterval(async () => {
      try {
        const bots = botsGetter();
        if (bots?.cwBot) {
          cwBot = bots.cwBot;
        }

        // Получаем все активные чаты с Facebook
        const states = manageStore.getAllStates();
        for (const [chatIdStr, data] of Object.entries(states)) {
          const chatId = parseInt(chatIdStr, 10);
          if (!Number.isFinite(chatId)) continue;

          const fbConfig = data?.facebookConfig;
          if (!fbConfig?.is_active) continue;

          // Получаем бота для пользователя
          const entry = bots.bots?.get(String(chatId));
          const bot = entry?.bot || null;

          await tickFacebookSchedule(chatId, bot);
        }
      } catch (e) {
        console.error('[FB] Scheduler error:', e);
      }
    }, 60000); // Каждую минуту
  }
}

function stopScheduler() {
  if (schedulerHandle) {
    clearInterval(schedulerHandle);
    schedulerHandle = null;
    console.log('[FB] Scheduler stopped');
  }
}

// ============================================
// Регистрация обработчиков в worker
// ============================================

function registerWorkerHandlers() {
  worker.registerJobHandler('facebook_generate', handleFacebookGenerateJob);
  worker.registerJobHandler('facebook_publish', publishFbPost);
  console.log('[FB] Worker handlers registered');
}

// ============================================
// Экспорт
// ============================================

module.exports = {
  getFacebookSettings,
  generateFbPostText,
  generateFbImage,
  saveImageToContainer,
  handleFacebookGenerateJob,
  publishFbPost,
  sendFbToModerator,
  handleFacebookModerationAction,
  tickFacebookSchedule,
  runNow,
  startScheduler,
  stopScheduler,
  registerWorkerHandlers
};
