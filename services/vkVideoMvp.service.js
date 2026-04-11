/**
 * VK Video MVP Service — генерация, модерация, публикация VK видео
 * Использует общий видео-пайплайн для получения видео
 * Публикация через VK API: video.save → upload → wall.post
 */
const path = require('path');
const fs = require('fs').promises;
const https = require('https');
const http = require('http');
const fetch = require('node-fetch');
const config = require('../config');
const aiRouterService = require('./ai_router_service');
const manageStore = require('../manage/store');
const storageService = require('./storage.service');
const videoPipeline = require('./videoPipeline.service');

let cwBot = null;

const SCHEDULE_TZ = process.env.CONTENT_MVP_TZ || 'Europe/Moscow';
const DAILY_VK_VIDEO_LIMIT = parseInt(process.env.VK_VIDEO_DAILY_LIMIT || '3', 10);
const PROFILE_FILES = ['IDENTITY.md', 'SOUL.md'];
const VK_API = 'https://api.vk.com/method';
const VK_API_VERSION = '5.199';

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
  try { Intl.DateTimeFormat(undefined, { timeZone: tz }); return true; } catch { return false; }
}

function getVkVideoSettings(chatId) {
  const cfg = manageStore.getVkVideoConfig?.(chatId) || {};
  return {
    isActive: !!cfg?.is_active,
    autoPublish: !!cfg?.auto_publish,
    scheduleTime: cfg?.schedule_time || '13:00',
    scheduleTz: isValidTz(cfg?.schedule_tz) ? cfg.schedule_tz : SCHEDULE_TZ,
    dailyLimit: Number.isFinite(cfg?.daily_limit) ? cfg.daily_limit : DAILY_VK_VIDEO_LIMIT,
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
  try {
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
  } catch { return ''; }
}

async function loadUserPersona(chatId) {
  const storageDir = storageService.getDataDir(String(chatId));
  let persona = '';
  for (const file of PROFILE_FILES) {
    try {
      const content = await fs.readFile(path.join(storageDir, file), 'utf-8');
      persona += content + '\n\n';
    } catch { }
  }
  return persona.trim().slice(0, 5000);
}

// ============================================
// Генерация текста для VK видео
// ============================================

async function generateVkVideoContent(chatId, topic, materialsText, personaText) {
  const systemPrompt = `Ты — профессиональный VK копирайтер. Создай привлекательное описание для видео ВКонтакте.

Формат ответа (JSON):
{
  "title": "Заголовок видео (до 100 символов)",
  "description": "Описание видео (до 500 символов)",
  "tags": ["тег1", "тег2"]
}

Правила:
- Заголовок цепляющий, без кликбейта
- Описание информативное, с призывом к действию
- 3-7 релевантных тегов без #
- На русском языке`;

  const userPrompt = `Тема: ${topic.topic}
Фокус: ${topic.focus || ''}

Материалы:
${materialsText.slice(0, 3000)}

Персона:
${personaText.slice(0, 2000)}

Создай описание для VK видео.`;

  const response = await aiRouterService.chatCompletion(chatId, [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt }
  ], { temperature: 0.8, max_tokens: 400 });

  if (!response?.content) throw new Error('AI response is empty');

  let parsed;
  try {
    const jsonMatch = response.content.match(/\{[\s\S]*\}/);
    parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
  } catch { parsed = null; }

  if (!parsed) {
    return {
      title: 'Наш новый ролик',
      description: response.content.slice(0, 500),
      tags: ['видео', 'товар']
    };
  }

  return {
    title: String(parsed.title || '').slice(0, 100),
    description: String(parsed.description || '').slice(0, 500),
    tags: Array.isArray(parsed.tags) ? parsed.tags.slice(0, 10) : []
  };
}

// ============================================
// Draft management
// ============================================

function getVkVideoDrafts(chatId) {
  const data = manageStore.getState(chatId) || {};
  return data.vkVideoDrafts || {};
}

async function setVkVideoDraft(chatId, draftId, draft) {
  const states = manageStore.getAllStates();
  if (!states[chatId]) states[chatId] = {};
  states[chatId].vkVideoDrafts = states[chatId].vkVideoDrafts || {};
  states[chatId].vkVideoDrafts[draftId] = draft;
  return manageStore.persist(chatId);
}

async function removeVkVideoDraft(chatId, draftId) {
  const data = manageStore.getState(chatId) || {};
  if (data.vkVideoDrafts && data.vkVideoDrafts[draftId]) {
    delete data.vkVideoDrafts[draftId];
    await manageStore.persist(chatId);
  }
}

// ============================================
// VK API helpers
// ============================================

async function vkApiCall(method, params) {
  const url = new URL(`${VK_API}/${method}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  url.searchParams.set('v', VK_API_VERSION);

  const resp = await fetch(url.toString(), { timeout: 30000 });
  if (!resp.ok) throw new Error(`VK API HTTP ${resp.status}`);
  const data = await resp.json();
  if (data.error) throw new Error(`VK API error ${data.error.error_code}: ${data.error.error_msg}`);
  return data.response;
}

/**
 * Загрузка видео на VK через multipart/form-data
 * Реализовано без внешних зависимостей — только native https/http
 */
function uploadVideoToVk(uploadUrl, videoBuffer, filename) {
  return new Promise((resolve, reject) => {
    const boundary = `----VKUpload${Date.now()}`;
    const CRLF = '\r\n';

    const header = Buffer.from(
      `--${boundary}${CRLF}` +
      `Content-Disposition: form-data; name="video_file"; filename="${filename}"${CRLF}` +
      `Content-Type: video/mp4${CRLF}` +
      `${CRLF}`
    );
    const footer = Buffer.from(`${CRLF}--${boundary}--${CRLF}`);
    const body = Buffer.concat([header, videoBuffer, footer]);

    const url = new URL(uploadUrl);
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;

    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length
      },
      timeout: 120000
    };

    const req = lib.request(options, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        try {
          const json = JSON.parse(Buffer.concat(chunks).toString());
          resolve(json);
        } catch (e) {
          reject(new Error(`VK upload: invalid JSON response: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('VK upload timeout')); });
    req.write(body);
    req.end();
  });
}

// ============================================
// Основной обработчик генерации
// ============================================

async function handleVkVideoGenerateJob(chatId, queueJob, bot, correlationId) {
  const settings = getVkVideoSettings(chatId);

  // Дневной лимит
  const vpRepo = require('./content/videoPipeline.repository');
  await vpRepo.ensureSchema(chatId);
  const publishedToday = await vpRepo.withClient(chatId, async (client) => {
    const r = await client.query(
      `SELECT COUNT(*) as cnt FROM video_channel_usage
       WHERE channel_type = 'vk' AND used_at::date = CURRENT_DATE`
    );
    return parseInt(r.rows[0]?.cnt || 0);
  });

  if (publishedToday >= settings.dailyLimit) {
    return { success: false, error: `Дневной лимит VK Video исчерпан (${publishedToday}/${settings.dailyLimit})`, retry: false };
  }

  // Проверяем VK credentials
  const vkConfig = manageStore.getVkConfig?.(chatId);
  if (!vkConfig?.service_key || !vkConfig?.group_id) {
    return { success: false, error: 'VK не настроен: отсутствует service_key или group_id', retry: false };
  }

  // Получаем видео из общего пула или генерируем
  let videoPath = '';
  let videoId = null;

  try {
    const claimResult = await videoPipeline.claimVideo(chatId, 'vk');
    if (claimResult.success) {
      videoPath = claimResult.videoPath;
      videoId = claimResult.videoId;
      console.log(`[VK-VIDEO-MVP] Using shared video: videoId=${videoId}`);
    } else {
      console.log(`[VK-VIDEO-MVP] No shared video, generating new one`);
      const genResult = await videoPipeline.generateVideo(chatId, 'vk');
      if (!genResult.success) {
        return { success: false, error: `Video generation failed: ${genResult.error}`, retry: true };
      }
      videoPath = genResult.videoPath;
      videoId = genResult.videoId;
    }
  } catch (e) {
    return { success: false, error: `Video pipeline failed: ${e.message}`, retry: true };
  }

  // Генерация контента
  let vkContent;
  try {
    const [materialsText, personaText] = await Promise.all([
      loadMaterialsText(chatId, 10),
      loadUserPersona(chatId)
    ]);
    const topic = queueJob?.topic || { topic: 'Демонстрация товара', focus: '' };
    vkContent = await generateVkVideoContent(chatId, topic, materialsText, personaText);
  } catch (e) {
    console.error(`[VK-VIDEO-MVP] Content generation failed: ${e.message}`);
    vkContent = { title: 'Наш новый ролик', description: '', tags: ['видео'] };
  }

  const jobId = Date.now();
  const draft = {
    jobId,
    videoId,
    videoPath,
    title: vkContent.title,
    description: vkContent.description,
    tags: vkContent.tags,
    correlationId: queueJob?.correlationId || `vkvideo_${jobId}`,
    rejectedCount: 0,
    status: 'ready'
  };

  if (settings.autoPublish) {
    await setVkVideoDraft(chatId, String(jobId), draft);
    await publishVkVideoPost(chatId, bot, jobId);
  } else {
    await sendVkVideoToModerator(chatId, bot, draft);
  }

  return { success: true, data: { jobId } };
}

// ============================================
// Публикация VK видео
// ============================================

async function publishVkVideoPost(chatId, bot, jobId) {
  const drafts = getVkVideoDrafts(chatId);
  const draft = drafts[String(jobId)];
  if (!draft) throw new Error(`VK Video draft ${jobId} not found`);

  const vkConfig = manageStore.getVkConfig?.(chatId);
  if (!vkConfig?.service_key || !vkConfig?.group_id) {
    throw new Error('VK не настроен: service_key или group_id отсутствует');
  }

  const accessToken = vkConfig.service_key;
  const groupId = vkConfig.group_id;
  const ownerId = `-${groupId}`;

  // Шаг 1: video.save
  const saveResp = await vkApiCall('video.save', {
    access_token: accessToken,
    name: draft.title,
    description: draft.description,
    group_id: groupId,
    wallpost: 0
  });

  const uploadUrl = saveResp.upload_url;
  const videoVkId = saveResp.video_id;
  const ownVkId = saveResp.owner_id;

  if (!uploadUrl) throw new Error('VK video.save: upload_url не получен');

  console.log(`[VK-VIDEO-MVP] Got upload_url, video_id=${videoVkId}`);

  // Шаг 2: загружаем MP4
  if (!draft.videoPath) {
    throw new Error('[VK-VIDEO] videoPath is missing in draft, cannot publish');
  }

  const videoFullPath = path.join(videoPipeline.VIDEO_TEMP_ROOT, chatId, draft.videoPath);
  const videoBuffer = await fs.readFile(videoFullPath);

  try {
    const uploadResult = await uploadVideoToVk(uploadUrl, videoBuffer, `video_${draft.videoId}.mp4`);

    if (!uploadResult?.video_id && !uploadResult?.video_hash) {
      throw new Error(`VK upload failed: ${JSON.stringify(uploadResult)}`);
    }

    console.log(`[VK-VIDEO-MVP] Video uploaded successfully`);

    // Шаг 3: wall.post
    const attachment = `video${ownVkId}_${videoVkId}`;
    const message = [
      draft.description,
      draft.tags.length ? draft.tags.map(t => `#${t}`).join(' ') : ''
    ].filter(Boolean).join('\n\n');

    await vkApiCall('wall.post', {
      access_token: accessToken,
      owner_id: ownerId,
      message,
      attachments: attachment
    });

    console.log(`[VK-VIDEO-MVP] Published to wall: ${attachment}`);

    draft.status = 'published';
    draft.publishedAt = new Date().toISOString();
    await setVkVideoDraft(chatId, String(jobId), draft);

    if (bot?.telegram) {
      await bot.telegram.sendMessage(
        chatId,
        `✅ VK Видео опубликовано!\n\n📹 ${draft.title}\n📝 ${draft.description}`
      ).catch(() => {});
    }
  } catch (e) {
    draft.status = 'failed';
    draft.errorText = e.message;
    await setVkVideoDraft(chatId, String(jobId), draft);
    throw e; // rethrow so the outer catch in handleVkVideoGenerateJob also sees it
  }
}

// ============================================
// Модерация
// ============================================

async function sendVkVideoToModerator(chatId, bot, draft) {
  if (!cwBot?.telegram) {
    console.error('[VK-VIDEO-MVP] CW bot не доступен');
    return;
  }

  const settings = getVkVideoSettings(chatId);
  const moderatorId = settings.moderatorUserId || process.env.CONTENT_MVP_MODERATOR_USER_ID;

  if (!moderatorId) {
    console.warn('[VK-VIDEO-MVP] Модератор не настроен, публикуем автоматически');
    await setVkVideoDraft(chatId, String(draft.jobId), draft);
    await publishVkVideoPost(chatId, bot, draft.jobId);
    return;
  }

  const caption = [
    `🎬 VK Видео — черновик для модерации`,
    ``,
    `📹 ${draft.title}`,
    `📝 ${draft.description}`,
    ``,
    `🏷 ${draft.tags.join(', ')}`,
    ``,
    `Job ID: ${draft.jobId}`
  ].join('\n');

  await setVkVideoDraft(chatId, String(draft.jobId), draft);

  try {
    const videoFullPath = path.join(videoPipeline.VIDEO_TEMP_ROOT, chatId, draft.videoPath);
    try {
      await cwBot.telegram.sendVideo(moderatorId, { source: videoFullPath }, {
        caption,
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✅ Одобрить', callback_data: `vk_vid_mod:${draft.jobId}:approve` },
              { text: '❌ Отклонить', callback_data: `vk_vid_mod:${draft.jobId}:reject` }
            ],
            [
              { text: '🔄 Перегенерировать текст', callback_data: `vk_vid_mod:${draft.jobId}:regen_text` }
            ]
          ]
        }
      });
    } catch {
      await cwBot.telegram.sendMessage(moderatorId, caption + `\n\n⚠️ Видео не доступно`, {
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✅ Одобрить', callback_data: `vk_vid_mod:${draft.jobId}:approve` },
              { text: '❌ Отклонить', callback_data: `vk_vid_mod:${draft.jobId}:reject` }
            ]
          ]
        }
      });
    }
  } catch (e) {
    console.error(`[VK-VIDEO-MVP] Ошибка отправки модератору: ${e.message}`);
  }
}

async function handleVkVideoModerationAction(chatId, bot, jobId, action) {
  const drafts = getVkVideoDrafts(chatId);
  const draft = drafts[String(jobId)];

  if (!draft) return { ok: false, message: 'Черновик не найден' };

  console.log(`[VK-VIDEO-MVP] Moderation action: ${action} for job ${jobId}`);

  switch (action) {
    case 'approve':
      if (draft.status === 'approved' || draft.status === 'published') {
        await bot.telegram.sendMessage(chatId, `[VK Video] Пост уже ${draft.status}, пропускаем.`).catch(() => {});
        return { ok: true, message: `Пост уже ${draft.status}` };
      }
      draft.status = 'approved';
      await setVkVideoDraft(chatId, String(jobId), draft);
      await publishVkVideoPost(chatId, bot, jobId);
      await removeVkVideoDraft(chatId, String(jobId));
      return { ok: true, message: '✅ Одобрено и опубликовано' };

    case 'reject':
      await removeVkVideoDraft(chatId, String(jobId));
      return { ok: true, message: '❌ Отклонено' };

    case 'regen_text':
      try {
        const [materialsText, personaText] = await Promise.all([
          loadMaterialsText(chatId, 10),
          loadUserPersona(chatId)
        ]);
        const topic = draft.topic || { topic: 'Демонстрация товара', focus: '' };
        const newContent = await generateVkVideoContent(chatId, topic, materialsText, personaText);
        draft.title = newContent.title;
        draft.description = newContent.description;
        draft.tags = newContent.tags;
        draft.rejectedCount = (draft.rejectedCount || 0) + 1;

        if (draft.rejectedCount >= 3) {
          await removeVkVideoDraft(chatId, String(jobId));
          return { ok: false, message: 'Превышен лимит перегенераций' };
        }

        await setVkVideoDraft(chatId, String(jobId), draft);
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
    console.log('[VK-VIDEO-MVP] Scheduler already running');
    return;
  }

  botsGetter = botsGetterFn;
  console.log('[VK-VIDEO-MVP] Scheduler started');

  schedulerHandle = setInterval(async () => {
    try {
      await publishScheduledPosts();
    } catch (e) {
      console.error(`[VK-VIDEO-MVP] Scheduler error: ${e.message}`);
    }
  }, 60000);
}

function stopScheduler() {
  if (schedulerHandle) {
    clearInterval(schedulerHandle);
    schedulerHandle = null;
    console.log('[VK-VIDEO-MVP] Scheduler stopped');
  }
}

async function publishScheduledPosts() {
  const allStates = manageStore.getAllStates();

  for (const [chatId] of Object.entries(allStates)) {
    try {
      const settings = getVkVideoSettings(chatId);
      if (!settings.isActive) continue;

      const { date, time: nowTime } = getNowInTz(settings.scheduleTz);
      if (nowTime !== settings.scheduleTime) continue;

      const dayOfWeek = new Date(date + 'T00:00:00').getDay(); // date is in user's TZ, so this gives correct day
      if (!settings.allowedWeekdays.includes(dayOfWeek)) continue;

      if (settings.stats.posts_today >= settings.dailyLimit) continue;

      const bot = botsGetter?.()?.get(chatId);
      if (!bot?.bot) continue;

      await handleVkVideoGenerateJob(chatId, {}, bot.bot, `vkvideo_schedule_${Date.now()}`);
    } catch (e) {
      console.error(`[VK-VIDEO-MVP] Failed to publish for ${chatId}: ${e.message}`);
    }
  }
}

// ============================================
// CW Bot
// ============================================

function setVkVideoCwBot(bot) {
  cwBot = bot;
}

// ============================================
// Exports
// ============================================

module.exports = {
  handleVkVideoGenerateJob,
  handleVkVideoModerationAction,
  startScheduler,
  stopScheduler,
  setVkVideoCwBot,
  getVkVideoSettings,
  publishVkVideoPost
};
