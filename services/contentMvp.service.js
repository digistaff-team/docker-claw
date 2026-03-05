const { Client } = require('pg');
const fetch = require('node-fetch');
const path = require('path');
const os = require('os');
const fs = require('fs').promises;
const config = require('../config');
const aiRouterService = require('./ai_router_service');
const manageStore = require('../manage/store');
const sessionService = require('./session.service');
const dockerService = require('./docker.service');

const SCHEDULE_TIME = process.env.CONTENT_MVP_TIME || '09:00';
const SCHEDULE_TZ = process.env.CONTENT_MVP_TZ || 'Europe/Moscow';
const CHANNEL_ID = process.env.CHANNEL_ID || '-1002263032027';
const MODERATOR_USER_ID = process.env.CONTENT_MVP_MODERATOR_USER_ID || '128247430';
const DAILY_LIMIT = parseInt(process.env.CONTENT_MVP_DAILY_LIMIT || '1', 10);
const MAX_IMAGE_ATTEMPTS = parseInt(process.env.CONTENT_MVP_MAX_IMAGE_ATTEMPTS || '3', 10);

const SHEET_URL = process.env.CONTENT_MVP_SHEET_URL || 'https://docs.google.com/spreadsheets/d/1klEWbBtbr1Ym-i4Xez76-egXpjBVD8ikiQAfVNyrUjg/edit?usp=sharing';
const SHEET_GID = process.env.CONTENT_MVP_SHEET_GID || '164844003';
const DRIVE_FOLDER_URL = process.env.CONTENT_MVP_DRIVE_FOLDER_URL || 'https://drive.google.com/drive/folders/1Vo7ZmMUR4j2ksZw3LZusPp8oKdmXnO9u?usp=sharing';

let schedulerHandle = null;
const locks = new Map();

function getDbName(chatId) {
  return `db_${String(chatId).replace(/[^a-z0-9_]/gi, '_').toLowerCase()}`;
}

function getDbClient(chatId) {
  return new Client({
    host: config.PG_ADMIN_HOST || config.PG_HOST,
    port: config.PG_PORT,
    user: config.PG_USER,
    password: config.PG_PASSWORD,
    database: getDbName(chatId),
    ssl: false,
    connectionTimeoutMillis: 5000
  });
}

async function withClient(chatId, fn) {
  const client = getDbClient(chatId);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}

async function ensureSchema(chatId) {
  await withClient(chatId, async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS content_jobs (
        id BIGSERIAL PRIMARY KEY,
        chat_id TEXT NOT NULL,
        sheet_row INT NOT NULL,
        sheet_topic TEXT NOT NULL,
        status TEXT NOT NULL,
        error_text TEXT,
        image_attempts INT NOT NULL DEFAULT 0,
        rejected_count INT NOT NULL DEFAULT 0,
        draft_text TEXT,
        image_path TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS content_assets (
        id BIGSERIAL PRIMARY KEY,
        job_id BIGINT NOT NULL REFERENCES content_jobs(id) ON DELETE CASCADE,
        asset_type TEXT NOT NULL,
        file_path TEXT NOT NULL,
        source TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS content_posts (
        id BIGSERIAL PRIMARY KEY,
        job_id BIGINT NOT NULL REFERENCES content_jobs(id) ON DELETE CASCADE,
        body_text TEXT NOT NULL,
        hashtags TEXT,
        publish_status TEXT NOT NULL DEFAULT 'DRAFT_READY',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS publish_logs (
        id BIGSERIAL PRIMARY KEY,
        post_id BIGINT REFERENCES content_posts(id) ON DELETE SET NULL,
        channel_id TEXT NOT NULL,
        telegram_message_id TEXT,
        status TEXT NOT NULL,
        error_text TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS content_sheet_state (
        sheet_row INT PRIMARY KEY,
        local_status TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        note TEXT
      );
    `);
  });
}

function parseSheetId(sheetUrl) {
  const m = String(sheetUrl).match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return m ? m[1] : null;
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

async function readTopicsFromSheet() {
  const sheetId = parseSheetId(SHEET_URL);
  if (!sheetId) throw new Error('Invalid sheet URL');
  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${encodeURIComponent(SHEET_GID)}`;
  const resp = await fetch(url, { timeout: 20000 });
  if (!resp.ok) throw new Error(`Sheet fetch failed: ${resp.status}`);
  const csv = await resp.text();
  const rows = csvToRows(csv);
  if (rows.length < 2) return [];

  const header = rows[0].map(normalizeHeader);
  const idx = {
    topic: header.indexOf('тема'),
    focus: header.indexOf('фокусный ключ'),
    secondary: header.indexOf('вторичные ключи'),
    lsi: header.indexOf('lsi-ключи'),
    status: header.indexOf('статус')
  };
  if (idx.topic === -1) throw new Error('Missing "Тема" column');

  const topics = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    topics.push({
      sheetRow: i + 1,
      topic: (r[idx.topic] || '').trim(),
      focus: idx.focus >= 0 ? (r[idx.focus] || '').trim() : '',
      secondary: idx.secondary >= 0 ? (r[idx.secondary] || '').trim() : '',
      lsi: idx.lsi >= 0 ? (r[idx.lsi] || '').trim() : '',
      status: idx.status >= 0 ? (r[idx.status] || '').trim() : ''
    });
  }
  return topics.filter((t) => t.topic);
}

function extractDriveFolderId(url) {
  const m = String(url).match(/\/folders\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

function decodeHexEscapes(str) {
  return str.replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

async function listDriveDocs() {
  const folderId = extractDriveFolderId(DRIVE_FOLDER_URL);
  if (!folderId) return [];
  const resp = await fetch(DRIVE_FOLDER_URL, { timeout: 20000 });
  if (!resp.ok) return [];
  const html = await resp.text();
  const m = html.match(/window\['_DRIVE_ivd'\]\s*=\s*'([^']+)'/);
  if (!m) return [];
  const decoded = decodeHexEscapes(m[1]);
  const re = new RegExp(`"([a-zA-Z0-9_-]{20,})",\\["${folderId}"\\],"([^"]*)","([^"]*)"`, 'g');
  const out = [];
  let mm;
  while ((mm = re.exec(decoded)) !== null) {
    out.push({ id: mm[1], name: mm[2], mime: mm[3] });
  }
  return out;
}

async function loadDriveMaterialsText(limit = 10) {
  const docs = await listDriveDocs();
  const parts = [];
  for (const doc of docs.slice(0, limit)) {
    if (doc.mime !== 'application/vnd.google-apps.document') continue;
    const exportUrl = `https://docs.google.com/document/d/${doc.id}/export?format=txt`;
    try {
      const r = await fetch(exportUrl, { timeout: 20000 });
      if (!r.ok) continue;
      const txt = (await r.text()).trim();
      if (!txt) continue;
      parts.push(`### ${doc.name}\n${txt.slice(0, 4000)}`);
    } catch {
      // ignore single document errors
    }
  }
  return parts.join('\n\n').slice(0, 20000);
}

function splitKeywords(v) {
  return String(v || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 5);
}

function buildTextPrompt(topic, materialsText) {
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
- Используй только факты из блока "Материалы".
- Добавь в конце 2-3 релевантных хэштега.

Тема: ${topic.topic}
Фокусный ключ: ${topic.focus || 'нет'}
Вторичные ключи: ${secondary.join(', ') || 'нет'}
LSI-ключи: ${lsi.join(', ') || 'нет'}
Рекомендованные хэштеги: ${hashtags.join(' ') || 'по контексту'}

Материалы:
${materialsText || 'Материалы недоступны'}
`.trim();
}

async function generatePostText(chatId, topic, materialsText) {
  const data = manageStore.getState(chatId);
  if (!data || !data.aiAuthToken || !data.aiModel) {
    throw new Error('AI model is not configured for chat');
  }
  const messages = [
    { role: 'system', content: 'Ты маркетинговый редактор Telegram-канала. Пиши кратко, фактически и без выдумок.' },
    { role: 'user', content: buildTextPrompt(topic, materialsText) }
  ];
  const call = () => aiRouterService.callAI(chatId, data.aiAuthToken, data.aiModel, messages, null, data.aiUserEmail);
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

async function generateImage(topic, text) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set');
  const prompt = `Сгенерируй изображение для поста Telegram. Тема: ${topic.topic}. Текст поста: ${text}. Стиль: чисто, коммерчески, без текста на изображении.`;
  const resp = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'gpt-image-1',
      prompt,
      size: '1024x1024'
    }),
    timeout: 45000
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Image API failed: ${resp.status} ${err.slice(0, 300)}`);
  }
  const data = await resp.json();
  const item = data?.data?.[0];
  if (!item) throw new Error('Empty image response');
  if (item.b64_json) return Buffer.from(item.b64_json, 'base64');
  if (item.url) {
    const r = await fetch(item.url, { timeout: 30000 });
    if (!r.ok) throw new Error(`Image download failed: ${r.status}`);
    return await r.buffer();
  }
  throw new Error('Unsupported image response shape');
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

async function getPublishedToday(chatId, dateStr) {
  return withClient(chatId, async (client) => {
    const r = await client.query(
      `SELECT COUNT(*)::int AS c
       FROM publish_logs
       WHERE status='PUBLISHED' AND to_char(created_at AT TIME ZONE $1, 'YYYY-MM-DD') = $2`,
      [SCHEDULE_TZ, dateStr]
    );
    return r.rows[0]?.c || 0;
  });
}

async function pickNextTopic(chatId) {
  const topics = await readTopicsFromSheet();
  return withClient(chatId, async (client) => {
    for (const t of topics) {
      if (String(t.status || '').trim() !== '') continue;
      const st = await client.query('SELECT local_status FROM content_sheet_state WHERE sheet_row=$1', [t.sheetRow]);
      const localStatus = st.rows[0]?.local_status;
      if (!localStatus || localStatus === 'NEW' || localStatus === 'FAILED_RETRY') {
        return t;
      }
    }
    return null;
  });
}

async function setLocalSheetState(chatId, sheetRow, status, note = '') {
  return withClient(chatId, async (client) => {
    await client.query(
      `INSERT INTO content_sheet_state (sheet_row, local_status, note)
       VALUES ($1, $2, $3)
       ON CONFLICT (sheet_row) DO UPDATE SET local_status=EXCLUDED.local_status, note=EXCLUDED.note, updated_at=NOW()`,
      [sheetRow, status, note || null]
    );
  });
}

function getDrafts(chatId) {
  const data = manageStore.getState(chatId) || {};
  return data.contentDrafts || {};
}

function setDraft(chatId, draftId, draft) {
  const data = manageStore.getState(chatId) || {};
  data.contentDrafts = data.contentDrafts || {};
  data.contentDrafts[draftId] = draft;
  if (!manageStore.getState(chatId)) {
    // create minimal chat state if missing
    // eslint-disable-next-line no-underscore-dangle
    manageStore.getAllStates()[chatId] = data;
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

function withLock(chatId, fn) {
  const prev = locks.get(chatId) || Promise.resolve();
  const next = prev
    .then(fn)
    .catch((e) => {
      const msg = e?.message || 'Unknown error';
      console.error('[CONTENT-MVP]', chatId, msg);
      return { ok: false, message: `Ошибка контент-пайплайна: ${msg}` };
    })
    .finally(() => {
      if (locks.get(chatId) === next) {
        locks.delete(chatId);
      }
    });
  locks.set(chatId, next);
  return next;
}

async function generateDraft(chatId, reason = 'manual') {
  await ensureSchema(chatId);
  const topic = await pickNextTopic(chatId);
  if (!topic) return { ok: false, message: 'Нет доступных тем со статусом "".' };

  const materialsText = await loadDriveMaterialsText(12);
  const text = await generatePostText(chatId, topic, materialsText);

  let imagePath = '';
  let imageAttempts = 0;
  let imageErr = '';
  for (let i = 1; i <= MAX_IMAGE_ATTEMPTS; i++) {
    try {
      imageAttempts = i;
      const imageBuffer = await generateImage(topic, text);
      imagePath = await saveImageToUserWorkspace(chatId, imageBuffer, `${topic.sheetRow}_${Date.now()}`);
      imageErr = '';
      break;
    } catch (e) {
      imageErr = e?.message || String(e);
    }
  }
  if (!imagePath) throw new Error(`Image generation failed: ${imageErr}`);

  return withClient(chatId, async (client) => {
    const j = await client.query(
      `INSERT INTO content_jobs (chat_id, sheet_row, sheet_topic, status, image_attempts, draft_text, image_path)
       VALUES ($1, $2, $3, 'DRAFT_READY', $4, $5, $6)
       RETURNING id`,
      [chatId, topic.sheetRow, topic.topic, imageAttempts, text, imagePath]
    );
    const jobId = j.rows[0].id;
    await client.query(
      `INSERT INTO content_posts (job_id, body_text, hashtags, publish_status)
       VALUES ($1, $2, $3, 'DRAFT_READY')`,
      [jobId, text, (text.match(/#[\wа-яё_]+/gi) || []).join(' ')]
    );
    await client.query(
      `INSERT INTO content_assets (job_id, asset_type, file_path, source)
       VALUES ($1, 'image', $2, 'openai:gpt-image-1')`,
      [jobId, imagePath]
    );
    await setLocalSheetState(chatId, topic.sheetRow, 'DRAFT_READY', reason);
    return { ok: true, jobId, topic, text, imagePath };
  });
}

async function sendDraftToModerator(chatId, bot, draft) {
  const caption = [
    `📝 Черновик #${draft.jobId}`,
    `Тема: ${draft.topic.topic}`,
    '',
    draft.text
  ].join('\n').slice(0, 1024);

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
  const sent = await bot.telegram.sendPhoto(MODERATOR_USER_ID, { source: tempPath }, { caption, reply_markup: kb });
  await fs.unlink(tempPath).catch(() => {});

  await setDraft(chatId, String(draft.jobId), {
    ...draft,
    moderationMessageId: sent.message_id,
    rejectedCount: draft.rejectedCount || 0
  });
}

async function publishDraft(chatId, bot, draft) {
  const session = await sessionService.getOrCreateSession(chatId);
  const tempPath = path.join(os.tmpdir(), `publish-${chatId}-${draft.jobId}.png`);
  await dockerService.copyFromContainer(session.containerId, draft.imagePath, tempPath);
  const sent = await bot.telegram.sendPhoto(CHANNEL_ID, { source: tempPath }, { caption: draft.text.slice(0, 1024) });
  await fs.unlink(tempPath).catch(() => {});

  await withClient(chatId, async (client) => {
    await client.query(`UPDATE content_jobs SET status='PUBLISHED', updated_at=NOW() WHERE id=$1`, [draft.jobId]);
    await client.query(`UPDATE content_posts SET publish_status='PUBLISHED', updated_at=NOW() WHERE job_id=$1`, [draft.jobId]);
    await client.query(
      `INSERT INTO publish_logs (post_id, channel_id, telegram_message_id, status)
       SELECT id, $1, $2, 'PUBLISHED' FROM content_posts WHERE job_id=$3`,
      [CHANNEL_ID, String(sent.message_id), draft.jobId]
    );
  });
  await setLocalSheetState(chatId, draft.topic.sheetRow, 'PUBLISHED');
  await removeDraft(chatId, String(draft.jobId));
}

async function regenerateDraftPart(chatId, draft, part) {
  const topic = draft.topic;
  if (part === 'text') {
    const materialsText = await loadDriveMaterialsText(12);
    const text = await generatePostText(chatId, topic, materialsText);
    draft.text = text;
  } else if (part === 'image') {
    const imageBuffer = await generateImage(topic, draft.text);
    draft.imagePath = await saveImageToUserWorkspace(chatId, imageBuffer, `${topic.sheetRow}_${Date.now()}`);
  }
  await withClient(chatId, async (client) => {
    await client.query(`UPDATE content_jobs SET draft_text=$1, image_path=$2, updated_at=NOW() WHERE id=$3`, [draft.text, draft.imagePath, draft.jobId]);
    await client.query(`UPDATE content_posts SET body_text=$1, hashtags=$2, updated_at=NOW() WHERE job_id=$3`, [draft.text, (draft.text.match(/#[\wа-яё_]+/gi) || []).join(' '), draft.jobId]);
  });
  await setDraft(chatId, String(draft.jobId), draft);
  return draft;
}

async function handleModerationAction(chatId, bot, action, jobId) {
  const draft = getDrafts(chatId)[String(jobId)];
  if (!draft) return { ok: false, message: 'Черновик не найден.' };

  if (action === 'approve') {
    await publishDraft(chatId, bot, draft);
    return { ok: true, message: `Пост #${jobId} опубликован.` };
  }
  if (action === 'regen_text') {
    const refreshed = await regenerateDraftPart(chatId, draft, 'text');
    await sendDraftToModerator(chatId, bot, refreshed);
    return { ok: true, message: 'Текст перегенерирован и повторно отправлен на согласование.' };
  }
  if (action === 'regen_image') {
    const refreshed = await regenerateDraftPart(chatId, draft, 'image');
    await sendDraftToModerator(chatId, bot, refreshed);
    return { ok: true, message: 'Изображение перегенерировано и повторно отправлено на согласование.' };
  }
  if (action === 'reject') {
    draft.rejectedCount = (draft.rejectedCount || 0) + 1;
    if (draft.rejectedCount >= 3) {
      await setLocalSheetState(chatId, draft.topic.sheetRow, 'MANUAL_REWORK_REQUIRED', 'Rejected 3 times');
      await setDraft(chatId, String(jobId), draft);
      return { ok: true, message: 'Черновик отклонен 3 раза. Нужна ручная переработка.' };
    }
    const refreshed = await regenerateDraftPart(chatId, draft, 'text');
    await regenerateDraftPart(chatId, refreshed, 'image');
    await sendDraftToModerator(chatId, bot, refreshed);
    await setDraft(chatId, String(jobId), draft);
    return { ok: true, message: `Черновик отклонен. Автоперегенерация выполнена и отправлена на согласование (${draft.rejectedCount}/3).` };
  }
  return { ok: false, message: 'Неизвестное действие.' };
}

async function runNow(chatId, bot, reason = 'manual') {
  return withLock(chatId, async () => {
    await ensureSchema(chatId);
    const now = getNowInTz(SCHEDULE_TZ);
    const publishedToday = await getPublishedToday(chatId, now.date);
    if (publishedToday >= DAILY_LIMIT) {
      return { ok: false, message: `Лимит публикаций на сегодня исчерпан (${publishedToday}/${DAILY_LIMIT}).` };
    }
    const draft = await generateDraft(chatId, reason);
    if (!draft.ok) return draft;
    await sendDraftToModerator(chatId, bot, draft);
    return { ok: true, message: `Черновик #${draft.jobId} отправлен на согласование.` };
  });
}

async function tickScheduleForChat(chatId, bot) {
  const now = getNowInTz(SCHEDULE_TZ);
  if (now.time !== SCHEDULE_TIME) return;
  const data = manageStore.getState(chatId) || {};
  const key = `contentLastRunDate:${SCHEDULE_TIME}`;
  if (data[key] === now.date) return;
  data[key] = now.date;
  if (!manageStore.getState(chatId)) {
    // eslint-disable-next-line no-underscore-dangle
    manageStore.getAllStates()[chatId] = data;
  }
  await manageStore.persist(chatId);
  await runNow(chatId, bot, 'schedule');
}

function startScheduler(getBots) {
  if (schedulerHandle) clearInterval(schedulerHandle);
  schedulerHandle = setInterval(async () => {
    try {
      const bots = getBots();
      for (const [chatId, entry] of bots.entries()) {
        await tickScheduleForChat(chatId, entry.bot);
      }
    } catch (e) {
      console.error('[CONTENT-MVP-SCHEDULER]', e.message);
    }
  }, 60 * 1000);
}

function stopScheduler() {
  if (!schedulerHandle) return;
  clearInterval(schedulerHandle);
  schedulerHandle = null;
}

module.exports = {
  startScheduler,
  stopScheduler,
  runNow,
  handleModerationAction,
  ensureSchema
};
