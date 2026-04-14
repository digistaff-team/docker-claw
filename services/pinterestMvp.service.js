/**
 * Pinterest MVP Service — генерация, модерация, публикация пинов
 * Самостоятельный пайплайн, не зависит от telegramMvp.service.js
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
const pinterestRepo = require('./content/pinterest.repository');
const bufferService = require('./buffer.service');
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
    scheduleEndTime: cfg?.schedule_end_time || null,
    publishIntervalHours: Number.isFinite(cfg?.publish_interval_hours) ? cfg.publish_interval_hours : 4,
    randomPublish: !!cfg?.random_publish,
    moderatorUserId: cfg?.moderator_user_id || null,
    scheduleTz: cfg?.schedule_tz || SCHEDULE_TZ,
    dailyLimit: Number.isFinite(cfg?.daily_limit) ? cfg.daily_limit : DAILY_PIN_LIMIT,
    allowedWeekdays: Array.isArray(cfg?.allowed_weekdays) ? cfg.allowed_weekdays : [0, 1, 2, 3, 4, 5, 6],
    stats: cfg?.stats || { total_pins: 0, pins_today: 0, last_pin_date: null }
  };
}

// ============================================
// Ротация досок (Фаза 6)
// ============================================

async function selectNextBoard(chatId) {
  const cfg = manageStore.getPinterestConfig(chatId);
  if (!cfg) return null;

  // Сначала пробуем получить доски из БД (с настройками)
  try {
    const dbBoards = await pinterestRepo.getBoards(chatId);
    if (dbBoards && dbBoards.length > 0) {
      const boards = dbBoards.map(b => ({
        board_id: b.board_id,
        board_name: b.board_name,
        service_id: b.service_id,
        idea: b.idea,
        focus: b.focus,
        purpose: b.purpose,
        keywords: b.keywords,
        link: b.link
      }));

      if (cfg.board_rotation === 'round_robin') {
        const idx = (cfg.last_board_index || 0) % boards.length;
        manageStore.setPinterestConfig(chatId, { last_board_index: idx + 1 });
        return boards[idx];
      }

      // random
      const idx = Math.floor(Math.random() * boards.length);
      return boards[idx];
    }
  } catch (e) {
    console.error(`[PINTEREST-MVP] Error loading boards from DB:`, e.message);
  }

  // Fallback: если в БД нет досок, используем фиксированную из конфига
  if (cfg.board_id) {
    return { board_id: cfg.board_id, board_name: cfg.board_name || '', keywords: '', link: cfg.website_url || '' };
  }
  return null;
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
  "pinTitle": "заголовок пина (максимум 80 символов, привлекательный, с ключевыми словами)",
  "pinDescription": "описание пина (максимум 380 символов, с CTA и ключевыми словами для SEO)",
  "seoKeywords": ["ключевое1", "ключевое2", "ключевое3"]
}

ВАЖНО: общая длина pinTitle + pinDescription НЕ ДОЛЖНА превышать 480 символов (лимит Pinterest).

Требования:
- pinTitle: до 80 символов, цепляющий, содержит основное ключевое слово
- pinDescription: до 380 символов, информативный, содержит призыв к действию
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
  let pinTitle = String(parsed.pinTitle || '').slice(0, 80);
  let pinDescription = String(parsed.pinDescription || '').slice(0, 380);
  // Гарантируем общий лимит 480 символов (title + \n\n + description)
  const total = pinTitle.length + 2 + pinDescription.length;
  if (total > 480) {
    pinDescription = pinDescription.slice(0, 480 - pinTitle.length - 2);
  }
  return {
    pinTitle,
    pinDescription,
    seoKeywords: Array.isArray(parsed.seoKeywords) ? parsed.seoKeywords.slice(0, 5) : []
  };
}

async function generatePinImage(chatId, topic, pinTitle) {
  const basePrompt = (`Pinterest pin image. Topic: ${topic.topic}. Title: ${pinTitle || ''}. Style: vertical, aesthetic, clean, visually appealing, no text overlay, no logos, professional photography style.`).slice(0, 800);
  return inputImageContext.generateImage(chatId, basePrompt, '2:3', 'grok-imagine/text-to-image');
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
  const states = manageStore.getAllStates();
  let data = states[chatId];
  if (!data) {
    data = {};
    states[chatId] = data;
  }
  data.pinterestDrafts = data.pinterestDrafts || {};
  data.pinterestDrafts[draftId] = draft;
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
  const board = await selectNextBoard(chatId);
  if (!board) {
    return { success: false, error: 'Нет настроенных досок Pinterest', retry: false };
  }

  // Выбор темы
  const topicRow = await repository.reserveNextTopic(chatId, 'pinterest');
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
      const imageBuffer = await generatePinImage(chatId, topic, pinText.pinTitle);
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

  // Сохраняем финальное изображение на хост для публичного доступа
  const hostDir = path.join(storageService.getDataDir(chatId), 'output', 'content');
  await fs.mkdir(hostDir, { recursive: true });
  await fs.writeFile(path.join(hostDir, `pin_${jobId}.png`), imageBuffer);

  // Публикация через Buffer GraphQL API (единственный режим)
  if (!cfg.buffer_api_key || !cfg.buffer_channel_id) {
    throw new Error('Buffer API key или channel_id не настроены');
  }
  const imageUrl = `${config.APP_URL}/api/files/public/${chatId}/pin_${jobId}.png`;
  let text = [job.pin_title, '', job.pin_description].filter(Boolean).join('\n');
  if (text.length > 500) {
    text = text.slice(0, 497) + '...';
  }

  // Получаем service_id доски для Buffer Pinterest API
  let boardServiceId = null;
  if (job.board_id) {
    const board = await pinterestRepo.getBoard(chatId, job.board_id);
    boardServiceId = board?.service_id || null;
  }

  const bufferResult = await bufferService.createPost(cfg.buffer_api_key, cfg.buffer_channel_id, { text, imageUrl, boardServiceId });
  const result = { id: bufferResult.postId };
  console.log(`[PINTEREST-MVP] Published via Buffer, postId=${bufferResult.postId}`);

  // Запись в лог
  await pinterestRepo.addPublishLog(chatId, {
    jobId,
    boardId: job.board_id,
    pinId: result.id || null,
    status: 'published',
    correlationId: corrId,
    method: 'buffer'
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
  const globalSettings = manageStore.getContentSettings?.(chatId);
  
  // Иерархия: модератор канала → глобальный модератор → chatId
  const moderatorId = settings.moderatorUserId || 
                      globalSettings?.moderatorUserId || 
                      chatId;

  const caption = [
    `📌 Черновик для Pinterest #${draft.jobId}`,
    `Доска: ${draft.board?.board_name || 'Board'}`,
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
  
  // Используем cwBot если он есть и у пользователя нет своего бота
  const moderatorBot = cwBot && cwBot.token !== bot?.token ? cwBot : bot;
  const sent = await moderatorBot.telegram.sendPhoto(moderatorId, { source: tempPath }, { caption, reply_markup: kb });
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
      const imageBuffer = await generatePinImage(chatId, draft.topic, draft.pinTitle);
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
      const imageBuffer = await generatePinImage(chatId, draft.topic, pinText.pinTitle);
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
  const now = getNowInTz(settings.scheduleTz);

  // Проверка разрешённых дней недели
  const dayOfWeek = new Date().getDay();
  if (!settings.allowedWeekdays.includes(dayOfWeek)) return;

  // Дневной лимит
  const publishedToday = await pinterestRepo.countPublishedToday(chatId, settings.scheduleTz);
  if (publishedToday >= settings.dailyLimit) return;

  const [startH, startM] = (settings.scheduleTime || '10:00').split(':').map(Number);
  const [nowH, nowM] = now.time.split(':').map(Number);
  const startMinutes = startH * 60 + startM;
  const nowMinutes = nowH * 60 + nowM;

  if (settings.scheduleEndTime) {
    const [endH, endM] = settings.scheduleEndTime.split(':').map(Number);
    if (nowMinutes >= endH * 60 + endM) return;
  }

  const intervalMinutes = Math.round((settings.publishIntervalHours || 4) * 60);

  const data = manageStore.getState(chatId) || {};

  if (settings.randomPublish) {
    // Рандомный режим: при наступлении каждого слота генерируем случайное
    // время следующей публикации в диапазоне 85%-100% от интервала.
    // Слот используется как «окно», внутри которого срабатывает одна публикация.

    // Определяем текущий слот (ближайший прошедший)
    let currentSlot = -1;
    for (let slot = startMinutes; slot < 24 * 60; slot += intervalMinutes) {
      if (nowMinutes >= slot) currentSlot = slot;
    }
    if (currentSlot < 0) return;

    const slotKey = `pinterestRandomSlot:${currentSlot}`;
    const runKey = `pinterestRandomRun:${currentSlot}`;

    // Если в этом слоте сегодня уже публиковали — пропускаем
    if (data[runKey] === now.date) return;

    // Генерируем случайную минуту для этого слота, если ещё не сгенерирована
    // Также пересчитываем если интервал изменился (targetMinute выходит за пределы допустимого диапазона)
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
      const states = manageStore.getAllStates();
      if (!states[chatId]) states[chatId] = data;
      await manageStore.persist(chatId);
      const tgtH = Math.floor(targetMinute / 60);
      const tgtM = targetMinute % 60;
      console.log(`[PINTEREST-SCHEDULE-RANDOM] ${chatId} target set to ${String(tgtH).padStart(2,'0')}:${String(tgtM).padStart(2,'0')} for slot ${currentSlot}`);
    }

    const targetMinute = parseInt(data[slotKey].split('|')[1], 10);

    // Логируем ожидание раз в 10 минут (аналогично фиксированному режиму)
    if (nowMinutes < targetMinute) {
      if (nowMinutes % 10 === 0) {
        const tgtH = Math.floor(targetMinute / 60);
        const tgtM = targetMinute % 60;
        console.log(`[PINTEREST-SCHEDULE-RANDOM] ${chatId} waiting: now=${now.time}, target=${String(tgtH).padStart(2,'0')}:${String(tgtM).padStart(2,'0')}, interval=${settings.publishIntervalHours}h`);
      }
      return;
    }

    // Время наступило — публикуем
    data[runKey] = now.date;
    const states2 = manageStore.getAllStates();
    if (!states2[chatId]) states2[chatId] = data;
    await manageStore.persist(chatId);

    console.log(`[PINTEREST-SCHEDULE-RANDOM] ${chatId} random time reached ${now.time}, enqueueing pinterest_generate`);
  } else {
    // Фиксированный режим: публикация строго по слотам
    let isSlot = false;
    for (let slot = startMinutes; slot < 24 * 60; slot += intervalMinutes) {
      if (nowMinutes === slot) { isSlot = true; break; }
    }
    if (!isSlot) {
      if (nowMinutes % 10 === 0) {
        console.log(`[PINTEREST-SCHEDULE] ${chatId} waiting: now=${now.time}, start=${settings.scheduleTime}, interval=${settings.publishIntervalHours}h`);
      }
      return;
    }

    const key = `pinterestLastRun:${now.time}`;
    if (data[key] === now.date) return;

    data[key] = now.date;
    const states = manageStore.getAllStates();
    if (!states[chatId]) states[chatId] = data;
    await manageStore.persist(chatId);

    console.log(`[PINTEREST-SCHEDULE] ${chatId} slot matched ${now.time}, enqueueing pinterest_generate`);
  }

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

  const settings = getPinterestSettings(chatId);
  const publishedToday = await pinterestRepo.countPublishedToday(chatId, settings.scheduleTz);
  if (publishedToday >= settings.dailyLimit) {
    return { ok: false, message: `Дневной лимит пинов исчерпан (${publishedToday}/${settings.dailyLimit}).` };
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

  // Запускаем worker с поддержкой CW_BOT_TOKEN
  worker.startWorker(getBots, () => cwBot);

  // Планировщик Pinterest (раз в минуту)
  if (schedulerHandle) clearInterval(schedulerHandle);
  schedulerHandle = setInterval(async () => {
    try {
      const bots = getBots();
      for (const [chatId, entry] of bots.entries()) {
        try {
          await tickPinterestSchedule(chatId, entry.bot);
        } catch (e) {
          console.error(`[PINTEREST-MVP-SCHEDULER] Error for ${chatId}:`, e.message);
        }
      }
    } catch (e) {
      console.error('[PINTEREST-MVP-SCHEDULER]', e.message);
    }
  }, 60 * 1000);

  console.log('[PINTEREST-MVP] Scheduler and worker started');
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
  getJobById: (chatId, jobId) => pinterestRepo.getJobById(chatId, jobId),
  setPinterestCwBot: (bot) => { cwBot = bot; },
  getPinterestCwBot: () => cwBot
};
