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
const storageService = require('./storage.service');
const inputImageContext = require('./inputImageContext.service');

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
const CHANNEL_ID = process.env.CHANNEL_ID || null; // Должен быть указан в настройках пользователя
const MODERATOR_USER_ID = process.env.CONTENT_MVP_MODERATOR_USER_ID || '128247430';
const DAILY_LIMIT = parseInt(process.env.CONTENT_MVP_DAILY_LIMIT || '1', 10);
const MAX_IMAGE_ATTEMPTS = parseInt(process.env.CONTENT_MVP_MAX_IMAGE_ATTEMPTS || '3', 10);

// TASK-015: Video configuration
const DEFAULT_CONTENT_TYPE = process.env.CONTENT_MVP_CONTENT_TYPE || 'text+image'; // 'text+image' | 'text+video'
const VIDEO_FALLBACK_ENABLED = process.env.VIDEO_FALLBACK_ENABLED !== 'false';
const PROFILE_FILES = ['IDENTITY.md', 'SOUL.md', 'USER.md', 'MEMORY.md'];
const PROFILE_FILE_SET = new Set(PROFILE_FILES);
const PROFILE_TEMPLATES = {
  'IDENTITY.md': `# Личность AI\n\n## Имя\n\n## Роль\n\n## Бэкграунд\n`,
  'SOUL.md': `# Tone of Voice\n\n## Стиль общения\n\n## Запрещенные темы\n\n## Принципы\n`,
  'USER.md': `# Целевая аудитория\n\n## Кто эти люди\n\n## Их задачи\n\n## Что для них важно\n`,
  'MEMORY.md': `# Контекст\n\n## Важные ссылки\n\n## Дополнительные источники\n\n## Заметки\n`
};

let schedulerHandle = null;
let botsGetter = null;
let cwBot = null; // Центральный бот премодерации (CW_BOT_TOKEN)

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
    contentType: cfg?.contentType || DEFAULT_CONTENT_TYPE, // TASK-015: 'text+image' | 'text+video'
    publishIntervalHours: Number.isFinite(cfg?.publishIntervalHours) ? cfg.publishIntervalHours : 24,
    allowedWeekdays: Array.isArray(cfg?.allowedWeekdays) ? cfg.allowedWeekdays : [1, 2, 3, 4, 5],
    randomPublish: !!cfg?.randomPublish,
    premoderationEnabled: cfg?.premoderationEnabled !== false
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
  if (Array.isArray(v)) {
    return v.map((s) => String(s || '').trim()).filter(Boolean).slice(0, 5);
  }

  const raw = String(v || '').trim();
  if (!raw) return [];

  if (raw.startsWith('[')) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.map((s) => String(s || '').trim()).filter(Boolean).slice(0, 5);
      }
    } catch {
      // fall back to plain split
    }
  }

  return String(v || '')
    .split(/[,\n;]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 5);
}

function extractHashtags(text) {
  return (String(text || '').match(/#[\p{L}\p{N}_]+/gu) || []).join(' ');
}

// ============================================
// User Content Providers
// ============================================
function getProfileCandidateDirs(chatId) {
  const repoDataDir = path.resolve(__dirname, '..', 'data', `user_${chatId}`);
  const storageDir = storageService.getDataDir(String(chatId));
  return [...new Set([
    repoDataDir,
    path.join(storageDir, `user_${chatId}`),
    storageDir,
    path.resolve(__dirname, '..', 'data', String(chatId))
  ])];
}

function getPrimaryProfileDir(chatId) {
  return storageService.getDataDir(String(chatId));
}

async function readFirstExistingFile(paths) {
  for (const filePath of paths) {
    try {
      const text = await fs.readFile(filePath, 'utf8');
      return { filePath, text: String(text || '').trim() };
    } catch {
      // try next path
    }
  }
  return null;
}

function normalizeStatusValue(value, fallback = 'pending') {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return fallback;
  if (normalized === 'used' || normalized === 'in progress' || normalized === 'processing') return 'used';
  if (normalized === 'completed' || normalized === 'published' || normalized === 'done') return 'completed';
  if (normalized === 'pending' || normalized === 'new') return 'pending';
  return fallback;
}

function parseSheetId(sheetUrl) {
  const match = String(sheetUrl || '').match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return match ? match[1] : null;
}

function parseSheetGid(sheetUrl, explicitGid = null) {
  if (explicitGid !== null && explicitGid !== undefined && String(explicitGid).trim() !== '') {
    return String(explicitGid).trim();
  }

  const url = String(sheetUrl || '');
  const match = url.match(/[?#&]gid=([0-9]+)/);
  return match ? match[1] : '0';
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

function findHeaderIndex(header, variants) {
  for (const variant of variants) {
    const index = header.indexOf(variant);
    if (index >= 0) return index;
  }
  return -1;
}

function normalizeImportMode(value) {
  const mode = String(value || 'topics').trim().toLowerCase();
  if (mode === 'materials' || mode === 'material') return 'materials';
  return 'topics';
}

async function loadTopicsFromTable(chatId, options = {}) {
  await repository.ensureSchema(chatId);
  return repository.listTopics(chatId, options);
}

async function loadMaterialsText(chatId, limit = 10) {
  await repository.ensureSchema(chatId);
  const materials = await repository.loadMaterials(chatId, limit);
  const parts = [];
  for (const item of materials) {
    const content = String(item.content || '').trim();
    if (!content) continue;
    const meta = [
      item.source_type ? `source_type=${item.source_type}` : '',
      item.source_url ? `source_url=${item.source_url}` : ''
    ].filter(Boolean).join(', ');
    parts.push(`### ${item.title}${meta ? ` (${meta})` : ''}\n${content.slice(0, 4000)}`);
  }
  return parts.join('\n\n').slice(0, 20000);
}

async function loadUserPersona(chatId) {
  const dirs = getProfileCandidateDirs(chatId);
  const sections = {};
  let sourceDir = null;

  for (const fileName of PROFILE_FILES) {
    const entry = await readFirstExistingFile(dirs.map((dir) => path.join(dir, fileName)));
    if (entry?.text) {
      sections[fileName.replace(/\.md$/i, '')] = entry.text;
      sourceDir = sourceDir || path.dirname(entry.filePath);
    }
  }

  const text = PROFILE_FILES
    .map((fileName) => fileName.replace(/\.md$/i, ''))
    .filter((key) => sections[key])
    .map((key) => `## ${key}\n${sections[key].slice(0, 4000)}`)
    .join('\n\n')
    .slice(0, 16000);

  return {
    sourceDir,
    sections,
    text
  };
}

async function getProfileFiles(chatId) {
  const dirs = getProfileCandidateDirs(chatId);
  const primaryDir = getPrimaryProfileDir(chatId);
  await fs.mkdir(primaryDir, { recursive: true });

  const files = {};
  for (const fileName of PROFILE_FILES) {
    const entry = await readFirstExistingFile(dirs.map((dir) => path.join(dir, fileName)));
    files[fileName] = {
      content: entry?.text || '',
      exists: Boolean(entry?.text),
      path: entry?.filePath || path.join(primaryDir, fileName),
      template: PROFILE_TEMPLATES[fileName] || ''
    };
  }

  return {
    directory: primaryDir,
    files
  };
}

async function saveProfileFiles(chatId, payload = {}) {
  const primaryDir = getPrimaryProfileDir(chatId);
  await fs.mkdir(primaryDir, { recursive: true });

  const written = {};
  for (const [fileName, content] of Object.entries(payload)) {
    if (!PROFILE_FILE_SET.has(fileName)) {
      throw new Error(`Unsupported profile file: ${fileName}`);
    }
    const filePath = path.join(primaryDir, fileName);
    await fs.writeFile(filePath, String(content || ''), 'utf8');
    written[fileName] = filePath;
  }

  return getProfileFiles(chatId);
}

async function importTopicsFromGoogleSheet(chatId, data = {}) {
  return importContentFromGoogleSheet(chatId, { ...data, mode: 'topics' });
}

// ============================================
// Pinterest Boards Import
// ============================================

async function previewPinterestBoardsImport(chatId, data = {}) {
  const { rows, sheetId, gid } = await loadGoogleSheetRows(data);
  const existing = await getBoardsFromDb(chatId);

  const preview = [];
  let skippedEmpty = 0;
  let skippedDuplicates = 0;

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const boardId = String(row.board_id || '').trim();
    const boardName = String(row.board_name || '').trim();
    const idea = row.idea || null;
    const focus = row.focus || null;
    const purpose = row.purpose || null;
    const keywords = row.keywords || null;
    const link = row.link || null;

    if (!boardId) {
      skippedEmpty++;
      continue;
    }

    const duplicate = existing.some(b => b.board_id && b.board_id.toLowerCase() === boardId.toLowerCase());
    if (duplicate) skippedDuplicates++;

    preview.push({
      row: i + 1,
      board_id: boardId,
      board_name: boardName,
      idea,
      focus,
      purpose,
      keywords,
      link,
      duplicate
    });
  }

  return { mode: 'boards', sheetId, gid, totalRows: rows.length, preview, skippedEmpty, skippedDuplicates };
}

async function importPinterestBoardsFromSheet(chatId, data = {}) {
  await repository.ensureSchema(chatId);
  const previewData = await previewPinterestBoardsImport(chatId, data);
  const mode = previewData.mode;
  const { preview } = previewData;

  let imported = 0;
  for (const item of preview) {
    if (item.duplicate) continue;

    await pinterestRepo.saveBoards(chatId, [{
      board_id: item.board_id,
      board_name: item.board_name,
      idea: item.idea,
      focus: item.focus,
      purpose: item.purpose,
      keywords: item.keywords,
      link: item.link
    }]);
    imported++;
  }

  return {
    mode,
    imported,
    skippedDuplicates: previewData.skippedDuplicates,
    skippedEmpty: previewData.skippedEmpty,
    totalRows: previewData.totalRows
  };
}

async function loadGoogleSheetRows(data = {}) {
  const sheetUrl = String(data.sheet_url || data.sheetUrl || '').trim();
  if (!sheetUrl) {
    throw new Error('sheet_url is required');
  }

  const sheetId = parseSheetId(sheetUrl);
  if (!sheetId) {
    throw new Error('Invalid Google Sheets URL');
  }

  const gid = parseSheetGid(sheetUrl, data.gid);
  const exportUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&gid=${encodeURIComponent(gid)}`;
  const response = await fetch(exportUrl, {
    timeout: 20000,
    redirect: 'follow',
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; DockerClaw/3.0)',
      'Accept': 'text/csv, text/plain, */*'
    }
  });
  if (!response.ok) {
    throw new Error(`Google Sheets import failed: ${response.status}. Убедитесь, что таблица открыта по ссылке (доступ "Все, у кого есть ссылка")`);
  }

  const csv = await response.text();
  const rows = csvToRows(csv);
  return { rows, sheetId, gid };
}

async function previewContentImport(chatId, data = {}) {
  await repository.ensureSchema(chatId);

  const mode = normalizeImportMode(data.mode);
  const { rows, sheetId, gid } = await loadGoogleSheetRows(data);
  if (!rows.length) {
    return { mode, sheetId, gid, totalRows: 0, preview: [], skippedEmpty: 0, skippedDuplicates: 0 };
  }

  const header = rows[0].map(normalizeHeader);
  if (mode === 'materials') {
    const idx = {
      title: findHeaderIndex(header, ['title', 'название', 'заголовок', 'material']),
      content: findHeaderIndex(header, ['content', 'text', 'текст', 'материал']),
      sourceType: findHeaderIndex(header, ['source_type', 'source type', 'тип источника']),
      sourceUrl: findHeaderIndex(header, ['source_url', 'source url', 'ссылка', 'url'])
    };
    if (idx.title < 0) idx.title = 0;
    if (idx.content < 0) idx.content = 1;

    const existing = await repository.withClient(chatId, async (client) => {
      const result = await client.query(`SELECT LOWER(TRIM(title)) AS title FROM content_materials`);
      return new Set(result.rows.map((row) => row.title).filter(Boolean));
    });

    const preview = [];
    let skippedEmpty = 0;
    let skippedDuplicates = 0;
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const title = String(row[idx.title] || '').trim();
      const content = String(row[idx.content] || '').trim();
      if (!title || !content) {
        skippedEmpty++;
        continue;
      }
      const duplicate = existing.has(title.toLowerCase());
      if (duplicate) skippedDuplicates++;
      preview.push({
        row: i + 1,
        title,
        content: content.slice(0, 300),
        source_type: idx.sourceType >= 0 ? String(row[idx.sourceType] || '').trim() : '',
        source_url: idx.sourceUrl >= 0 ? String(row[idx.sourceUrl] || '').trim() : '',
        duplicate
      });
    }

    return { mode, sheetId, gid, totalRows: Math.max(rows.length - 1, 0), preview, skippedEmpty, skippedDuplicates };
  }

  const idx = {
    topic: findHeaderIndex(header, ['тема', 'topic', 'title', 'subject']),
    focus: findHeaderIndex(header, ['фокусный ключ', 'focus', 'focus keyword', 'keyword']),
    secondary: findHeaderIndex(header, ['вторичные ключи', 'secondary', 'secondary keywords']),
    lsi: findHeaderIndex(header, ['lsi-ключи', 'lsi', 'lsi keywords']),
    status: findHeaderIndex(header, ['статус', 'status'])
  };
  if (idx.topic < 0) idx.topic = 0;

  const existingTopics = await repository.withClient(chatId, async (client) => {
    const result = await client.query(`SELECT LOWER(TRIM(topic)) AS topic FROM content_topics`);
    return new Set(result.rows.map((row) => row.topic).filter(Boolean));
  });

  const preview = [];
  let skippedEmpty = 0;
  let skippedDuplicates = 0;
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const topic = String(row[idx.topic] || '').trim();
    if (!topic) {
      skippedEmpty++;
      continue;
    }
    const duplicate = existingTopics.has(topic.toLowerCase());
    if (duplicate) skippedDuplicates++;
    preview.push({
      row: i + 1,
      topic,
      focus: idx.focus >= 0 ? String(row[idx.focus] || '').trim() : '',
      secondary: idx.secondary >= 0 ? String(row[idx.secondary] || '').trim() : '',
      lsi: idx.lsi >= 0 ? String(row[idx.lsi] || '').trim() : '',
      status: idx.status >= 0 ? normalizeStatusValue(row[idx.status], 'pending') : 'pending',
      duplicate
    });
  }

  return { mode, sheetId, gid, totalRows: Math.max(rows.length - 1, 0), preview, skippedEmpty, skippedDuplicates };
}

async function importContentFromGoogleSheet(chatId, data = {}) {
  await repository.ensureSchema(chatId);
  const previewData = await previewContentImport(chatId, data);
  const mode = previewData.mode;

  let imported = 0;
  for (const item of previewData.preview) {
    if (item.duplicate) continue;
    if (mode === 'materials') {
      await repository.createMaterial(chatId, {
        title: item.title,
        content: item.content,
        sourceType: item.source_type || null,
        sourceUrl: item.source_url || null
      });
    } else {
      await repository.createTopic(chatId, {
        topic: item.topic,
        focus: item.focus || null,
        secondary: item.secondary || null,
        lsi: item.lsi || null,
        status: item.status || 'pending'
      });
    }
    imported++;
  }

  return {
    mode,
    imported,
    skippedDuplicates: previewData.skippedDuplicates,
    skippedEmpty: previewData.skippedEmpty,
    totalRows: previewData.totalRows,
    sheetId: previewData.sheetId,
    gid: previewData.gid
  };
}

// ============================================
// Generation Service
// ============================================

function buildTextPrompt(topic, materialsText, personaText = '') {
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
- Следуй контексту персонажа из блока "Профиль".
- Используй только факты из блока "Материалы" и допустимые сведения из блока "Профиль".
- Добавь в конце 2-3 релевантных хэштега.
- Вместо длинных тире используй запятые или глагольные связки.
- Вместо антитезы формата «Это не X — это Y» перепиши смысл фразы без противопоставления.
- Вместо трёх прилагательных подряд — оставь одно, самое точное
- Пиши предложения короче: если больше 20 слов — раздели на два
- Вместо списка с нумерацией или буллитам ты должен написать тот же смысл связным текстом

Тема: ${topic.topic}
Фокусный ключ: ${topic.focus || 'нет'}
Вторичные ключи: ${secondary.join(', ') || 'нет'}
LSI-ключи: ${lsi.join(', ') || 'нет'}
Рекомендованные хэштеги: ${hashtags.join(' ') || 'по контексту'}

Профиль:
${personaText || 'Профиль пользователя не заполнен'}

Материалы:
${materialsText || 'Материалы недоступны'}
`.trim();
}

async function generatePostText(chatId, topic, materialsText, personaText = '') {
  const data = manageStore.getState(chatId);
  // Проверка конфигурации AI: OpenAI (aiCustomApiKey) и ProTalk (aiAuthToken)
  const hasApiKey = data.aiCustomApiKey || data.aiAuthToken;
  if (!data || !hasApiKey || !data.aiModel) {
    throw new Error('AI model is not configured for chat');
  }
  const messages = [
    { role: 'system', content: 'Ты маркетинговый редактор Telegram-канала. Пиши кратко, фактически и без выдумок.' },
    { role: 'user', content: buildTextPrompt(topic, materialsText, personaText) }
  ];
  // Передаём aiCustomApiKey для OpenAI или aiAuthToken для ProTalk
  const authToken = data.aiCustomApiKey || data.aiAuthToken;
  const call = () => aiRouterService.callAI(chatId, authToken, data.aiModel, messages, null, data.aiUserEmail);
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

// ============================================
// Image Generation
// ============================================

// Генерация изображения с помощью сервиса Kie.ai
async function generateImage(chatId, topic, text) {
  const basePrompt = `Image for Telegram post. Topic: ${topic.topic}. ` +
    `You are an advanced AI image generation assistant. Your purpose is to create high-quality, ` +
    `visually compelling images based on user requests. CORE PRINCIPLES: 1) Quality First - always aim ` +
    `for highest artistic and technical quality. 2) Safety - never generate harmful, illegal, explicit, ` +
    `or dangerous content. 3) Respect - create inclusive, non-discriminatory content. 4) Accuracy - ` +
    `represent subjects truthfully. 5) Creativity - interpret requests creatively while staying true to ` +
    `user intent. TECHNICAL SPECS: Default aspect ratio 1:1, highest quality, photorealistic or artistic ` +
    `based on context. OUTPUT: Generate detailed optimized prompt including main subject, lighting, ` +
    `atmosphere, color scheme, quality level.`;

  return inputImageContext.generateImage(chatId, basePrompt, '1:1', 'nano-banana-2');
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
  await repository.ensureSchema(chatId);
  const topic = await repository.reserveNextTopic(chatId);
  if (!topic) return null;
  return {
    sheetRow: topic.id,
    topic: topic.topic,
    focus: topic.focus || '',
    secondary: topic.secondary || '',
    lsi: topic.lsi || '',
    status: topic.status || 'used'
  };
}

async function releaseTopic(chatId, topic, note = 'generation_failed') {
  if (!topic?.sheetRow) return;
  await repository.updateTopicStatus(chatId, topic.sheetRow, 'pending', note);
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
  const states = manageStore.getAllStates();
  if (!states[chatId]) {
    states[chatId] = data;
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

  const [materialsText, persona] = await Promise.all([
    loadMaterialsText(chatId, 12),
    loadUserPersona(chatId)
  ]);
  let text;
  try {
    text = await generatePostText(chatId, topic, materialsText, persona.text);
  } catch (e) {
    await releaseTopic(chatId, topic, `text_generation_failed: ${e.message}`);
    return { success: false, error: `Text generation failed: ${e.message}`, retry: true };
  }

  let imagePath = '';
  let imageAttempts = 0;
  let imageErr = '';
  for (let i = 1; i <= MAX_IMAGE_ATTEMPTS; i++) {
    try {
      imageAttempts = i;
      const imageBuffer = await generateImage(chatId, topic, text);
      imagePath = await saveImageToUserWorkspace(chatId, imageBuffer, `${topic.sheetRow}_${Date.now()}`);
      imageErr = '';
      break;
    } catch (e) {
      imageErr = e?.message || String(e);
    }
  }
  if (!imagePath) {
    await releaseTopic(chatId, topic, `image_generation_failed: ${imageErr}`);
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
  await repository.createAsset(chatId, jobId, 'image', imagePath, 'kie:kie-image-1');

  // Обновляем sheet state
  await repository.setSheetState(chatId, topic.sheetRow, STATUS.READY, reason);

  // Отправляем модератору или сразу публикуем
  const draft = { jobId, topic, text, imagePath, correlationId };
  await routeDraft(chatId, bot, draft);

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

  const [materialsText, persona] = await Promise.all([
    loadMaterialsText(chatId, 12),
    loadUserPersona(chatId)
  ]);
  let text;
  try {
    text = await generatePostText(chatId, topic, materialsText, persona.text);
  } catch (e) {
    await releaseTopic(chatId, topic, `text_generation_failed: ${e.message}`);
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
          const imageBuffer = await generateImage(chatId, topic, text);
          imagePath = await saveImageToUserWorkspace(chatId, imageBuffer, `${topic.sheetRow}_${Date.now()}`);
          break;
        } catch (imgErr) {
          imageErr = imgErr?.message || String(imgErr);
        }
      }

      if (imagePath) {
        await repository.updateJob(chatId, jobId, { imagePath, status: STATUS.READY });
        await repository.createAsset(chatId, jobId, 'image', imagePath, 'kie:kie-image-1');
        await repository.setSheetState(chatId, topic.sheetRow, STATUS.READY, `${reason}_fallback`);

        const draft = { jobId, topic, text, imagePath, correlationId, contentType: 'text+image' };
        await routeDraft(chatId, bot, draft);

        return { success: true, data: { jobId, fallbackUsed: true } };
      }
    }

    await releaseTopic(chatId, topic, `video_generation_start_failed: ${e.message}`);
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
            const imageBuffer = await generateImage(chatId, topic, draft_text);
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
          await repository.createAsset(chatId, jobId, 'image', imagePath, 'kie:kie-image-1');
          await repository.setSheetState(chatId, sheet_row, STATUS.READY, 'video_fallback');
          
          const draft = { jobId, topic, text: draft_text, imagePath, correlationId: correlation_id, contentType: 'text+image' };
          await routeDraft(chatId, bot, draft);
          return;
        }
      } catch (e) {
        console.error(`[CONTENT-MVP] Image fallback failed:`, e.message);
      }
    }
    
    await releaseTopic(chatId, topic, `video_generation_failed: ${videoResult.error}`);
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
    
    // Отправляем модератору или сразу публикуем
    await routeDraft(chatId, bot, draft);
    
    console.log(`[CONTENT-MVP] Video job ${jobId} completed successfully`);
  } catch (e) {
    console.error(`[CONTENT-MVP] Failed to save video for job ${jobId}:`, e.message);
    await releaseTopic(chatId, topic, `video_save_failed: ${e.message}`);
    await repository.updateJobStatus(chatId, jobId, STATUS.FAILED, e.message);
  }
}

/**
 * Отправить видео-черновик модератору
 */
async function sendVideoDraftToModerator(chatId, bot, draft) {
  const settings = getContentSettings(chatId);
  const caption = [
    `🎬 Видео-черновик #${draft.jobId} для Telegram`,
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

  const [materialsText, persona] = await Promise.all([
    loadMaterialsText(chatId, 12),
    loadUserPersona(chatId)
  ]);
  let text;
  try {
    text = await generatePostText(chatId, topic, materialsText, persona.text);
  } catch (error) {
    await releaseTopic(chatId, topic, `text_generation_failed: ${error.message}`);
    throw error;
  }

  let imagePath = '';
  let imageAttempts = 0;
  let imageErr = '';
  for (let i = 1; i <= MAX_IMAGE_ATTEMPTS; i++) {
    try {
      imageAttempts = i;
      const imageBuffer = await generateImage(chatId, topic, text);
      imagePath = await saveImageToUserWorkspace(chatId, imageBuffer, `${topic.sheetRow}_${Date.now()}`);
      imageErr = '';
      break;
    } catch (e) {
      imageErr = e?.message || String(e);
    }
  }
  if (!imagePath) {
    await releaseTopic(chatId, topic, `image_generation_failed: ${imageErr}`);
    throw new Error(`Image generation failed: ${imageErr}`);
  }

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
  await repository.createAsset(chatId, jobId, 'image', imagePath, 'kie:kie-image-1');
  await repository.setSheetState(chatId, topic.sheetRow, STATUS.READY, reason);

  return { ok: true, jobId, topic, text, imagePath, correlationId: corrId };
}

/**
 * Маршрутизация черновика: при включённой премодерации — модератору,
 * при выключенной — сразу публикация в канал.
 */
async function routeDraft(chatId, bot, draft) {
  const settings = getContentSettings(chatId);
  if (settings.premoderationEnabled) {
    if (draft.contentType === 'text+video') {
      await sendVideoDraftToModerator(chatId, bot, draft);
    } else {
      await sendDraftToModerator(chatId, bot, draft);
    }
  } else {
    // Без премодерации — сразу публикуем
    await setDraft(chatId, String(draft.jobId), {
      ...draft,
      rejectedCount: draft.rejectedCount || 0
    });
    const correlationId = draft.correlationId || generateCorrelationId();
    await publishDraft(chatId, bot, draft, correlationId);
  }
}

async function sendDraftToModerator(chatId, bot, draft) {
  const settings = getContentSettings(chatId);
  const caption = [
    `📝 Черновик #${draft.jobId} для Telegram`,
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
  
  // Используем cwBot если он есть и у пользователя нет своего бота
  const moderatorBot = cwBot && cwBot.token !== bot?.token ? cwBot : bot;
  const sent = await moderatorBot.telegram.sendPhoto(settings.moderatorUserId, { source: tempPath }, { caption, reply_markup: kb });
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

  // Проверка наличия channelId перед публикацией
  if (!settings.channelId) {
    throw new Error(`Telegram канал не настроен для пользователя ${chatId}. Укажите channel_id в настройках контента.`);
  }

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

      // Проверяем, не опубликован ли уже (используем client чтобы избежать FK-дедлока)
      const publishLogCheck = await client.query(
        `SELECT id FROM publish_logs WHERE post_id = $1 AND status = $2 LIMIT 1`,
        [postId, PUBLISH_LOG_STATUS.PUBLISHED]
      );
      const alreadyPublished = publishLogCheck.rowCount > 0;
      if (publishStatus === STATUS.PUBLISHED || alreadyPublished) {
        // Используем client для INSERT в publish_logs (FK→content_posts держит блокировку)
        await client.query(
          `INSERT INTO publish_logs (post_id, channel_id, status, error_text, correlation_id) VALUES ($1, $2, $3, $4, $5)`,
          [postId, settings.channelId, PUBLISH_LOG_STATUS.SKIPPED_DUPLICATE_PUBLISH, 'already_published', corrId]
        );
        return;
      }

      // Переход через approved (требует state machine: ready -> approved -> published)
      await repository.updateJobStatus(chatId, draft.jobId, STATUS.APPROVED);
      await repository.updateJobStatus(chatId, draft.jobId, STATUS.PUBLISHED);
      // Используем уже открытый client (держит блокировку строки) чтобы избежать дедлока
      await client.query(
        `UPDATE content_posts SET publish_status = $1, updated_at = NOW() WHERE id = $2`,
        [STATUS.PUBLISHED, postId]
      );

      // Для media group сохраняем все message_id
      const messageIds = Array.isArray(sent)
        ? sent.map(s => String(s.message_id)).join(',')
        : String(sent.message_id);

      // Используем client для INSERT в publish_logs (FK→content_posts держит блокировку)
      await client.query(
        `INSERT INTO publish_logs (post_id, channel_id, telegram_message_id, status, error_text, correlation_id) VALUES ($1, $2, $3, $4, $5, $6)`,
        [postId, settings.channelId, messageIds, PUBLISH_LOG_STATUS.PUBLISHED, null, corrId]
      );
    });

    await repository.updateTopicStatus(chatId, draft.topic.sheetRow, 'completed', STATUS.PUBLISHED);
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
        supports_streaming: true
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
        caption
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
      caption: i === 0 ? caption : undefined
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
    const [materialsText, persona] = await Promise.all([
      loadMaterialsText(chatId, 12),
      loadUserPersona(chatId)
    ]);
    const text = await generatePostText(chatId, topic, materialsText, persona.text);
    draft.text = text;
  } else if (part === 'image') {
    const imageBuffer = await generateImage(chatId, topic, draft.text);
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
          const imageBuffer = await generateImage(chatId, topic, draft.text);
          draft.imagePath = await saveImageToUserWorkspace(chatId, imageBuffer, `${topic.sheetRow}_${Date.now()}`);
          draft.contentType = 'text+image';
        }
        break;
      }

      await new Promise(r => setTimeout(r, videoService.VIDEO_POLL_INTERVAL_SEC * 1000));
    }

    // Если таймаут — fallback
    if (!draft.videoPath && !draft.imagePath && VIDEO_FALLBACK_ENABLED) {
      const imageBuffer = await generateImage(chatId, topic, draft.text);
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

  // При ручном запуске выполняем генерацию напрямую, минуя очередь,
  // чтобы не зависеть от worker'а и расписания бота
  if (reason !== 'schedule') {
    try {
      const result = await handleGenerateJob(chatId, {
        payload: { reason },
        correlation_id: correlationId
      }, bot, correlationId);

      if (result.success) {
        return { ok: true, message: 'Генерация выполнена успешно.', correlationId };
      } else {
        return { ok: false, message: result.error || 'Генерация не удалась.', correlationId };
      }
    } catch (e) {
      return { ok: false, message: `Ошибка генерации: ${e.message}`, correlationId };
    }
  }

  // Для запуска по расписанию — ставим в очередь для worker'а
  const queueJobId = await queueRepo.enqueue(chatId, {
    jobType: 'generate',
    priority: 0,
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
  // Загружаем состояние пользователя, если ещё не загружено
  if (!manageStore.getState(chatId)) {
    await manageStore.loadChatState(chatId);
  }
  const settings = getContentSettings(chatId);
  const now = getNowInTz(settings.scheduleTz);

  // Проверяем день недели (0=Вс, 1=Пн, ..., 6=Сб)
  const dateObj = new Date(now.date + 'T' + now.time + ':00');
  const weekday = dateObj.getDay();
  if (!settings.allowedWeekdays.includes(weekday)) return;

  const [startH, startM] = (settings.scheduleTime || '12:00').split(':').map(Number);
  const [nowH, nowM] = now.time.split(':').map(Number);
  const startMinutes = startH * 60 + startM;
  const nowMinutes = nowH * 60 + nowM;
  const intervalMinutes = Math.round((settings.publishIntervalHours || 24) * 60);

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

    const slotKey = `contentRandomSlot:${currentSlot}`;
    const runKey = `contentRandomRun:${currentSlot}`;

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
      const targetMinute = (currentSlot + randomOffset) % 1440;
      data[slotKey] = `${now.date}|${targetMinute}`;
      const states = manageStore.getAllStates();
      if (!states[chatId]) states[chatId] = data;
      if (chatId) await manageStore.persist(chatId);
      const tgtH = Math.floor(targetMinute / 60);
      const tgtM = targetMinute % 60;
      console.log(`[CONTENT-SCHEDULE-RANDOM] ${chatId} target set to ${String(tgtH).padStart(2,'0')}:${String(tgtM).padStart(2,'0')} for slot ${currentSlot}`);
    }

    const targetMinute = parseInt(data[slotKey].split('|')[1], 10);

    // Логируем ожидание раз в 10 минут (аналогично фиксированному режиму)
    if (nowMinutes < targetMinute) {
      if (nowMinutes % 10 === 0) {
        const tgtH = Math.floor(targetMinute / 60);
        const tgtM = targetMinute % 60;
        console.log(`[CONTENT-SCHEDULE-RANDOM] ${chatId} waiting: now=${now.time}, target=${String(tgtH).padStart(2,'0')}:${String(tgtM).padStart(2,'0')}, interval=${settings.publishIntervalHours}h`);
      }
      return;
    }

    // Время наступило — публикуем
    data[runKey] = now.date;
    const states2 = manageStore.getAllStates();
    if (!states2[chatId]) states2[chatId] = data;
    if (chatId) await manageStore.persist(chatId);
  } else {
    // Фиксированный режим: публикация строго по слотам
    let isSlot = false;
    for (let slot = startMinutes; slot < 24 * 60; slot += intervalMinutes) {
      if (nowMinutes === slot) { isSlot = true; break; }
    }
    if (!isSlot) {
      // Логируем раз в 10 минут, чтобы не засорять
      if (nowMinutes % 10 === 0) {
        console.log(`[TG-SCHEDULE] ${chatId} waiting: now=${now.time}, start=${settings.scheduleTime}, interval=${settings.publishIntervalHours}h`);
      }
      return;
    }

    const key = `contentLastRun:${now.time}`;
    if (data[key] === now.date) return;

    data[key] = now.date;
    const states3 = manageStore.getAllStates();
    if (!states3[chatId]) states3[chatId] = data;
    if (chatId) await manageStore.persist(chatId);
  }

  console.log(`[TG-SCHEDULE] ${chatId} slot matched ${now.time}, enqueueing content_generate`);
  await runNow(chatId, bot, 'schedule');
}

// ============================================
// API Methods
// ============================================

async function listJobs(chatId, options = {}) {
  await repository.ensureSchema(chatId);
  return repository.listJobs(chatId, options);
}

async function listTopics(chatId, options = {}) {
  return loadTopicsFromTable(chatId, options);
}

async function createTopic(chatId, data = {}) {
  await repository.ensureSchema(chatId);
  const topic = String(data.topic || '').trim();
  const status = String(data.status || 'pending').trim().toLowerCase() || 'pending';
  const allowedStatuses = new Set(['pending', 'used', 'completed']);
  if (!topic) {
    throw new Error('topic is required');
  }
  if (!allowedStatuses.has(status)) {
    throw new Error('invalid topic status');
  }

  return repository.createTopic(chatId, {
    topic,
    focus: String(data.focus || '').trim() || null,
    secondary: Array.isArray(data.secondary)
      ? JSON.stringify(data.secondary)
      : String(data.secondary || '').trim() || null,
    lsi: Array.isArray(data.lsi)
      ? JSON.stringify(data.lsi)
      : String(data.lsi || '').trim() || null,
    status
  });
}

async function updateTopic(chatId, topicId, data = {}) {
  await repository.ensureSchema(chatId);
  
  const topic = data.topic ? String(data.topic).trim() : undefined;
  const status = data.status ? String(data.status).trim().toLowerCase() : undefined;
  const allowedStatuses = new Set(['pending', 'used', 'completed']);

  if (topic !== undefined && !topic) {
    throw new Error('topic cannot be empty');
  }
  if (status !== undefined && !allowedStatuses.has(status)) {
    throw new Error(`invalid status: ${data.status}. Allowed: pending, used, completed`);
  }

  const updated = await repository.updateTopic(chatId, topicId, {
    topic,
    focus: data.focus ? String(data.focus).trim() : undefined,
    secondary: Array.isArray(data.secondary)
      ? JSON.stringify(data.secondary)
      : (data.secondary ? String(data.secondary).trim() : undefined),
    lsi: Array.isArray(data.lsi)
      ? JSON.stringify(data.lsi)
      : (data.lsi ? String(data.lsi).trim() : undefined),
    status
  });

  if (!updated) {
    throw new Error('topic not found');
  }
  return updated;
}

async function deleteTopic(chatId, topicId) {
  await repository.ensureSchema(chatId);
  const deleted = await repository.deleteTopic(chatId, topicId);
  if (!deleted) {
    throw new Error('topic not found');
  }
  return deleted;
}

async function listMaterials(chatId, options = {}) {
  await repository.ensureSchema(chatId);
  return repository.listMaterials(chatId, options);
}

async function createMaterial(chatId, data = {}) {
  await repository.ensureSchema(chatId);
  const title = String(data.title || '').trim();
  const content = String(data.content || '').trim();
  if (!title) {
    throw new Error('title is required');
  }
  if (!content) {
    throw new Error('content is required');
  }

  return repository.createMaterial(chatId, {
    title,
    content,
    sourceType: String(data.source_type || data.sourceType || '').trim() || null,
    sourceUrl: String(data.source_url || data.sourceUrl || '').trim() || null
  });
}

async function updateMaterial(chatId, materialId, data = {}) {
  await repository.ensureSchema(chatId);
  const title = String(data.title || '').trim();
  const content = String(data.content || '').trim();
  if (!title) {
    throw new Error('title is required');
  }
  if (!content) {
    throw new Error('content is required');
  }

  const updated = await repository.updateMaterial(chatId, materialId, {
    title,
    content,
    sourceType: String(data.source_type || data.sourceType || '').trim() || null,
    sourceUrl: String(data.source_url || data.sourceUrl || '').trim() || null
  });
  if (!updated) {
    throw new Error('material not found');
  }
  return updated;
}

async function deleteMaterial(chatId, materialId) {
  await repository.ensureSchema(chatId);
  const deleted = await repository.deleteMaterial(chatId, materialId);
  if (!deleted) {
    throw new Error('material not found');
  }
  return deleted;
}

async function getProfile(chatId) {
  return getProfileFiles(chatId);
}

async function saveProfile(chatId, files = {}) {
  return saveProfileFiles(chatId, files);
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

  // Запускаем worker для обработки очереди (передаём getCwBot для пользователей с CW_BOT_TOKEN)
  worker.startWorker(getBots, () => cwBot);
  
  // Запускаем планировщик
  if (schedulerHandle) clearInterval(schedulerHandle);
  schedulerHandle = setInterval(async () => {
    try {
      const bots = getBots();
      for (const [chatId, entry] of bots.entries()) {
        try {
          await tickScheduleForChat(chatId, entry.bot);
        } catch (e) {
          console.error(`[CONTENT-MVP-SCHEDULER] Error for ${chatId}:`, e.message);
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

/**
 * Поставить в очередь анонс блог-статьи в Telegram-канал пользователя.
 * Используется WordPress-каналом после успешной публикации статьи в WP.
 *
 * @param {string} chatId
 * @param {object} params
 * @param {string} params.text — готовый текст анонса
 * @param {Buffer} [params.imageBuffer] — обложка статьи
 * @param {string} [params.imageMime]
 * @param {string} [params.source='blog'] — источник для логов
 * @param {number} [params.sourceRefId] — id записи в content_posts
 * @returns {Promise<{ok: boolean, queueJobId?: number, message: string}>}
 */
async function enqueueAnnouncement(chatId, params = {}) {
  const { text, imageBuffer, imageMime, source = 'blog', sourceRefId } = params;
  if (!text || typeof text !== 'string') {
    return { ok: false, message: 'enqueueAnnouncement: text is required' };
  }

  // Сохраняем картинку во временное место воркспейса, чтобы worker мог её прочитать
  let imagePath = null;
  if (imageBuffer && Buffer.isBuffer(imageBuffer)) {
    try {
      const path = require('path');
      const fs = require('fs').promises;
      const dir = path.join(config.DATA_ROOT || '/var/sandbox-data', String(chatId), 'blog-announcements');
      await fs.mkdir(dir, { recursive: true });
      const ext = (imageMime && imageMime.includes('png')) ? 'png' : 'jpg';
      imagePath = path.join(dir, `announce_${Date.now()}.${ext}`);
      await fs.writeFile(imagePath, imageBuffer);
    } catch (e) {
      console.warn('[BLOG-ANNOUNCE] failed to save image:', e.message);
      imagePath = null;
    }
  }

  const correlationId = generateCorrelationId();
  const queueJobId = await queueRepo.enqueue(chatId, {
    jobType: 'announce',
    priority: 5,
    payload: {
      text,
      imagePath,
      source,
      sourceRefId,
      channel: 'telegram'
    },
    correlationId
  });

  return {
    ok: true,
    queueJobId,
    message: `Анонс #${queueJobId} поставлен в очередь`
  };
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
  listTopics,
  createTopic,
  updateTopic,
  deleteTopic,
  listMaterials,
  createMaterial,
  updateMaterial,
  deleteMaterial,
  getProfile,
  saveProfile,
  previewContentImport,
  importContentFromGoogleSheet,
  importTopicsFromGoogleSheet,
  // Pinterest Boards
  previewPinterestBoardsImport,
  importPinterestBoardsFromSheet,
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

  // Очередь (для прямого доступа)
  enqueue: queueRepo.enqueue,
  getQueueStats: queueRepo.getQueueStats,

  // Анонс блог-статьи в Telegram-канал пользователя
  enqueueAnnouncement,

  // Центральный бот премодерации
  setContentBot: (bot) => { cwBot = bot; },
  getContentBot: () => cwBot,

  // TASK-015: Video
  videoService,
  VIDEO_STATUS,
  VIDEO_FALLBACK_ENABLED,
  handleVideoGenerateJob,
  handleVideoGenerationComplete
};
