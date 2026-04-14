/**
 * TikTok MVP Service — генерация, модерация, публикация TikTok видео
 * Использует общий видео-пайплайн для получения видео
 * Публикация через TikTok API (или Buffer если поддерживается)
 */
const path = require('path');
const fs = require('fs').promises;
const fetch = require('node-fetch');
const config = require('../config');
const aiRouterService = require('./ai_router_service');
const manageStore = require('../manage/store');
const sessionService = require('./session.service');
const storageService = require('./storage.service');
const FormData = require('form-data');
const videoPipeline = require('./videoPipeline.service');
const repository = require('./content/repository');

let cwBot = null; // Центральный бот премодерации

const SCHEDULE_TZ = process.env.CONTENT_MVP_TZ || 'Europe/Moscow';
const DAILY_TIKTOK_LIMIT = parseInt(process.env.TIKTOK_DAILY_LIMIT || '3', 10);
const TIKTOK_MODERATION_TIMEOUT_HOURS = parseInt(process.env.TIKTOK_MODERATION_TIMEOUT_HOURS || '24', 10);
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

function isValidTz(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch { return false; }
}

function getTiktokSettings(chatId) {
  const cfg = manageStore.getTiktokConfig?.(chatId) || {};
  return {
    isActive: !!cfg?.is_active,
    autoPublish: !!cfg?.auto_publish,
    scheduleTime: cfg?.schedule_time || '12:00',
    scheduleTz: isValidTz(cfg?.schedule_tz) ? cfg.schedule_tz : SCHEDULE_TZ,
    dailyLimit: Number.isFinite(cfg?.daily_limit) ? cfg.daily_limit : DAILY_TIKTOK_LIMIT,
    publishIntervalHours: Number.isFinite(cfg?.publish_interval_hours) ? cfg.publish_interval_hours : 6,
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
  const contentModules = require('./content/index');
  const { repository } = contentModules;
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
  let persona = '';
  for (const file of PROFILE_FILES) {
    try {
      const filePath = path.join(storageDir, file);
      const content = await fs.readFile(filePath, 'utf-8');
      persona += content + '\n\n';
    } catch (e) {
      // ignore
    }
  }
  return persona.trim().slice(0, 5000);
}

async function loadBrandDna(chatId) {
  const storageDir = storageService.getDataDir(String(chatId));
  try {
    return await fs.readFile(path.join(storageDir, 'input', 'brand', 'dna.md'), 'utf-8');
  } catch {}
  try {
    return await fs.readFile(path.join(storageDir, 'IDENTITY.md'), 'utf-8');
  } catch {}
  return '';
}

async function loadBrandTov(chatId) {
  const storageDir = storageService.getDataDir(String(chatId));
  try {
    return await fs.readFile(path.join(storageDir, 'input', 'brand', 'tov.md'), 'utf-8');
  } catch {}
  try {
    return await fs.readFile(path.join(storageDir, 'SOUL.md'), 'utf-8');
  } catch {}
  return '';
}

// ============================================
// Генерация TikTok контента (текст + хештеги)
// ============================================

async function generateTiktokContent(chatId, topic, dna, tov) {
  const { TIKTOK_CAPTION_SYSTEM } = require('../manage/prompts');

  const contextParts = [];
  if (dna) contextParts.push(`Бренд-ДНК:\n${dna.slice(0, 2000)}`);
  if (tov) contextParts.push(`Tone of Voice:\n${tov.slice(0, 1000)}`);

  const userMessage = [
    ...contextParts,
    `Тема: ${topic.topic || topic}`,
    topic.focus ? `Фокус: ${topic.focus}` : null
  ].filter(Boolean).join('\n\n');

  const response = await aiRouterService.chatCompletion(chatId, [
    { role: 'system', content: TIKTOK_CAPTION_SYSTEM },
    { role: 'user', content: userMessage }
  ], { temperature: 1, max_tokens: 512 });

  if (!response?.content) throw new Error('AI response is empty');

  let parsed;
  try {
    const jsonMatch = response.content.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    parsed = { caption: response.content.slice(0, 150), hashtags: [] };
  }

  return {
    caption: String(parsed.caption || '').slice(0, 150),
    hashtags: Array.isArray(parsed.hashtags) ? parsed.hashtags.slice(0, 5) : []
  };
}

// ============================================
// Draft management (in-memory)
// ============================================

function getTiktokDrafts(chatId) {
  const data = manageStore.getState(chatId) || {};
  return data.tiktokDrafts || {};
}

function setTiktokDraft(chatId, draftId, draft) {
  const states = manageStore.getAllStates();
  let data = states[chatId];
  if (!data) {
    data = {};
    states[chatId] = data;
  }
  data.tiktokDrafts = data.tiktokDrafts || {};
  data.tiktokDrafts[draftId] = draft;
  return manageStore.persist(chatId);
}

async function removeTiktokDraft(chatId, draftId) {
  const data = manageStore.getState(chatId) || {};
  if (data.tiktokDrafts && data.tiktokDrafts[draftId]) {
    delete data.tiktokDrafts[draftId];
    await manageStore.persist(chatId);
  }
}

// ============================================
// Основной обработчик генерации
// ============================================

async function handleTiktokGenerateJob(chatId, queueJob, bot, correlationId) {
  const settings = getTiktokSettings(chatId);

  // Дневной лимит
  // TODO: реализовать подсчёт опубликованных сегодня
  const publishedToday = 0;
  if (publishedToday >= DAILY_TIKTOK_LIMIT) {
    return { success: false, error: `Дневной лимит TikTok исчерпан (${publishedToday}/${DAILY_TIKTOK_LIMIT})`, retry: false };
  }

  // Получаем видео из общего пайплайна или генерируем новое
  let videoPath = '';
  let videoId = null;

  try {
    // Сначала пробуем забрать готовое видео из общего пула
    const claimResult = await videoPipeline.claimVideo(chatId, 'tiktok');

    if (claimResult.success) {
      videoPath = claimResult.videoPath;
      if (videoPath && !path.isAbsolute(videoPath)) {
        videoPath = path.join(videoPipeline.VIDEO_TEMP_ROOT, String(chatId), videoPath);
      }
      videoId = claimResult.videoId;
      console.log(`[TIKTOK-MVP] Using shared video: videoId=${videoId}, path=${videoPath}`);
    } else {
      // Нет доступного видео — генерируем новое
      console.log(`[TIKTOK-MVP] No shared video available, generating new one`);

      const genResult = await videoPipeline.generateVideo(chatId, 'tiktok');
      if (!genResult.success) {
        return { success: false, error: `Video generation failed: ${genResult.error}`, retry: true };
      }

      videoPath = genResult.videoPath;
      if (videoPath && !path.isAbsolute(videoPath)) {
        videoPath = path.join(videoPipeline.VIDEO_TEMP_ROOT, String(chatId), videoPath);
      }
      videoId = genResult.videoId;
      console.log(`[TIKTOK-MVP] New video generated: videoId=${videoId}, path=${videoPath}`);
    }
  } catch (e) {
    console.error(`[TIKTOK-MVP] Video pipeline failed: ${e.message}`);
    return { success: false, error: `Video pipeline failed: ${e.message}`, retry: true };
  }

  // Генерация контента (caption + hashtags) с ДНК/TOV
  const topic = queueJob?.topic || { topic: 'Product showcase', focus: '' };
  let tiktokContent;
  try {
    const [dna, tov] = await Promise.all([
      loadBrandDna(chatId),
      loadBrandTov(chatId)
    ]);
    tiktokContent = await generateTiktokContent(chatId, topic, dna, tov);
  } catch (e) {
    console.error(`[TIKTOK-MVP] Content generation failed: ${e.message}`);
    tiktokContent = { caption: topic.topic || 'Check this out!', hashtags: [] };
  }

  // Создаём черновик
  const jobId = Date.now();
  const draft = {
    jobId,
    videoId,
    videoPath,
    caption: tiktokContent.caption,
    hashtags: tiktokContent.hashtags,
    title: topic.topic || tiktokContent.caption,  // для upload-post.com
    topic: topic,                                  // для regen_text в модерации
    topicId: topic.id || null,                     // для updateTopicStatus после публикации
    correlationId: queueJob?.correlationId || `tiktok_${jobId}`,
    rejectedCount: 0,
    status: 'ready'
  };

  // Маршрутизация: автопубликация или модерация
  if (settings.autoPublish) {
    await setTiktokDraft(chatId, String(jobId), draft);
    await publishTiktokPost(chatId, bot, jobId);
  } else {
    await sendTiktokToModerator(chatId, bot, draft);
  }

  return { success: true, data: { jobId } };
}

// ============================================
// Публикация TikTok
// ============================================

async function publishTiktokPost(chatId, bot, jobId) {
  const drafts = getTiktokDrafts(chatId);
  const draft = drafts[String(jobId)];
  if (!draft) {
    throw new Error(`TikTok draft ${jobId} not found`);
  }

  // Публикация через upload-post.com
  await publishViaUploadPost(draft.videoPath, draft.title || draft.caption);

  // Завершаем жизненный цикл топика
  if (draft.topicId) {
    await repository.updateTopicStatus(chatId, draft.topicId, 'completed').catch(() => {});
  }

  // Обновляем статус
  draft.status = 'published';
  draft.publishedAt = new Date().toISOString();
  await setTiktokDraft(chatId, String(jobId), draft);
  await removeTiktokDraft(chatId, String(jobId));

  // Уведомляем пользователя
  if (bot?.telegram) {
    await bot.telegram.sendMessage(
      chatId,
      `✅ TikTok видео опубликовано!\n\n` +
      `📝 ${draft.caption}\n` +
      `${draft.hashtags.join(' ')}`
    ).catch(() => {});
  }
}

async function publishViaUploadPost(videoPath, title) {
  const jwt = process.env.UPLOAD_POST_JWT;
  const user = process.env.UPLOAD_POST_USER;

  if (!jwt || !user) {
    throw new Error('UPLOAD_POST_JWT или UPLOAD_POST_USER не заданы в .env.local');
  }

  const videoBuffer = await fs.readFile(videoPath);
  const videoFilename = path.basename(videoPath);

  const form = new FormData();
  form.append('title', title);
  form.append('user', user);
  form.append('platform[]', 'tiktok');
  form.append('video', videoBuffer, { filename: videoFilename, contentType: 'video/mp4' });

  const resp = await fetch('https://api.upload-post.com/api/upload', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${jwt}`,
      ...form.getHeaders()
    },
    body: form,
    timeout: 120000
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`upload-post.com error: ${resp.status} ${errText.slice(0, 300)}`);
  }

  const data = await resp.json().catch(() => ({}));
  console.log(`[TIKTOK-MVP][UPLOAD-POST] Published:`, JSON.stringify(data));
  return data;
}

// ============================================
// Модерация
// ============================================

async function sendTiktokToModerator(chatId, bot, draft) {
  if (!cwBot?.telegram) {
    console.error('[TIKTOK-MVP] CW bot is not available');
    return;
  }

  const settings = getTiktokSettings(chatId);
  const moderatorId = settings.moderatorUserId || process.env.CONTENT_MVP_MODERATOR_USER_ID;

  if (!moderatorId) {
    console.warn('[TIKTOK-MVP] No moderator configured, auto-publishing');
    await setTiktokDraft(chatId, String(draft.jobId), draft);
    await publishTiktokPost(chatId, bot, draft.jobId);
    return;
  }

  // Формируем сообщение для модератора
  const caption = [
    `🎬 TikTok — черновик для модерации`,
    ``,
    `📝 ${draft.caption}`,
    ``,
    `🏷 ${draft.hashtags.join(' ')}`,
    ``,
    `Job ID: ${draft.jobId}`
  ].filter(line => line !== null).join('\n');

  try {
    // Отправляем видео (если есть)
    if (draft.videoPath) {
      const videoFullPath = draft.videoPath;
      try {
        await cwBot.telegram.sendVideo(moderatorId, { source: videoFullPath }, {
          caption,
          reply_markup: {
            inline_keyboard: [
              [
                { text: '✅ Одобрить', callback_data: `tt_mod:${draft.jobId}:approve` },
                { text: '❌ Отклонить', callback_data: `tt_mod:${draft.jobId}:reject` }
              ],
              [
                { text: '🔄 Перегенерировать текст', callback_data: `tt_mod:${draft.jobId}:regen_text` }
              ]
            ]
          }
        });
      } catch (e) {
        // Если не можем отправить видео — отправляем только текст
        await cwBot.telegram.sendMessage(moderatorId, caption + `\n\n⚠️ Видео не доступно`, {
          reply_markup: {
            inline_keyboard: [
              [
                { text: '✅ Одобрить', callback_data: `tt_mod:${draft.jobId}:approve` },
                { text: '❌ Отклонить', callback_data: `tt_mod:${draft.jobId}:reject` }
              ]
            ]
          }
        });
      }
    }
  } catch (e) {
    console.error(`[TIKTOK-MVP] Failed to send to moderator: ${e.message}`);
  }
}

async function handleTiktokModerationAction(chatId, bot, jobId, action) {
  const drafts = getTiktokDrafts(chatId);
  const draft = drafts[String(jobId)];

  if (!draft) {
    return { ok: false, message: 'Черновик не найден' };
  }

  console.log(`[TIKTOK-MVP] Moderation action: ${action} for job ${jobId}`);

  switch (action) {
    case 'approve':
      draft.status = 'approved';
      await setTiktokDraft(chatId, String(jobId), draft);
      await publishTiktokPost(chatId, bot, jobId);
      return { ok: true, message: '✅ Одобрено и опубликовано' };

    case 'reject':
      draft.status = 'rejected';
      await setTiktokDraft(chatId, String(jobId), draft);
      await removeTiktokDraft(chatId, String(jobId));
      if (draft.topicId) {
        await repository.releaseTopic(chatId, draft.topicId).catch(() => {});
      }
      return { ok: true, message: '❌ Отклонено' };

    case 'regen_text':
      try {
        // Проверяем лимит ДО генерации
        if ((draft.rejectedCount || 0) >= 2) {
          await removeTiktokDraft(chatId, String(jobId));
          return { ok: false, message: 'Превышен лимит перегенераций' };
        }

        const [dna, tov] = await Promise.all([
          loadBrandDna(chatId),
          loadBrandTov(chatId)
        ]);
        const topic = draft.topic || { topic: 'Product showcase', focus: '' };
        const newContent = await generateTiktokContent(chatId, topic, dna, tov);
        draft.caption = newContent.caption;
        draft.hashtags = newContent.hashtags;
        draft.rejectedCount = (draft.rejectedCount || 0) + 1;

        await setTiktokDraft(chatId, String(jobId), draft);
        return { ok: true, message: '🔄 Текст перегенерирован' };
      } catch (e) {
        return { ok: false, message: `Ошибка перегенерации: ${e.message}` };
      }

    default:
      return { ok: false, message: 'Неизвестное действие' };
  }
}

// ============================================
// Планировщик
// ============================================

function startScheduler(botsGetterFn) {
  if (schedulerHandle) {
    console.log('[TIKTOK-MVP] Scheduler already running');
    return;
  }

  botsGetter = botsGetterFn;
  console.log('[TIKTOK-MVP] Scheduler started');

  schedulerHandle = setInterval(async () => {
    try {
      await publishScheduledPosts();
    } catch (e) {
      console.error(`[TIKTOK-MVP] Scheduler error: ${e.message}`);
    }
  }, 60000); // каждую минуту
}

function stopScheduler() {
  if (schedulerHandle) {
    clearInterval(schedulerHandle);
    schedulerHandle = null;
    console.log('[TIKTOK-MVP] Scheduler stopped');
  }
}

async function publishScheduledPosts() {
  const allStates = manageStore.getAllStates();
  const now = new Date();

  for (const [chatId, data] of Object.entries(allStates)) {
    try {
      const settings = getTiktokSettings(chatId);
      if (!settings.isActive) continue;

      const { time: nowTime } = getNowInTz(settings.scheduleTz);
      if (nowTime !== settings.scheduleTime) continue;

      const dayOfWeek = now.getDay();
      if (!settings.allowedWeekdays.includes(dayOfWeek)) continue;

      // Проверяем дневной лимит
      if (settings.stats.posts_today >= settings.dailyLimit) continue;

      // Публикуем случайный пост если включён randomPublish
      if (settings.randomPublish) {
        // TODO: реализовать случайную публикацию
      }

      // Резервируем тему из content_topics
      const topic = await repository.reserveNextTopic(chatId, 'tiktok');
      if (!topic) continue;

      // Запускаем генерацию
      const bot = botsGetter?.()?.get(chatId);
      if (!bot?.bot) {
        await repository.releaseTopic(chatId, topic.id);
        continue;
      }

      let jobResult;
      try {
        jobResult = await handleTiktokGenerateJob(chatId, { topic }, bot.bot, `tiktok_schedule_${Date.now()}`);
      } catch (jobErr) {
        await repository.releaseTopic(chatId, topic.id);
        continue;
      }
      if (!jobResult?.success) {
        await repository.releaseTopic(chatId, topic.id);
      }
    } catch (e) {
      console.error(`[TIKTOK-MVP] Failed to publish for ${chatId}: ${e.message}`);
    }
  }
}

// ============================================
// CW Bot integration
// ============================================

function setTiktokCwBot(bot) {
  cwBot = bot;
}

// ============================================
// Exports
// ============================================

module.exports = {
  handleTiktokGenerateJob,
  handleTiktokModerationAction,
  startScheduler,
  stopScheduler,
  setTiktokCwBot,
  getTiktokSettings,
  publishTiktokPost
};
