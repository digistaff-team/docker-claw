# VK Video Channel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Добавить VK Video как четвёртый канал видеопайплайна — полный цикл от claimVideo до публикации через VK API с модерацией через CW Bot.

**Architecture:** Новый `vkVideoMvp.service.js` по образцу `tiktokMvp.service.js`. Видео забирается из общего пула через `videoPipeline.claimVideo`. Публикация через VK API (video.save → multipart upload → wall.post). Модерация через CW Bot с callback `vk_vid_mod:`. Планировщик стартует в `server.js` по аналогии с TikTok.

**Tech Stack:** Node.js, native `https` (для multipart VK upload), VK API v5.199, Telegraf (CW Bot callbacks), PostgreSQL per-user (через `videoPipeline.repository.js`)

---

## Карта файлов

| Действие | Файл | Что меняется |
|----------|------|-------------|
| Create | `migrations/20260411_add_vk_video_channel.sql` | ALTER TABLE — добавляет 'vk' в CHECK constraints |
| Modify | `services/content/videoPipeline.repository.js` | CHANNELS default + ensureSchema CHECK constraints |
| Modify | `manage/store.js` | getVkVideoConfig, setVkVideoConfig, clearVkVideoConfig + экспорт |
| Create | `services/vkVideoMvp.service.js` | Весь VK Video сервис |
| Modify | `server.js` | cwBot vk_vid_mod: callback + setCwBot + startScheduler |
| Modify | `.env.example` | VK_VIDEO_DAILY_LIMIT, VK_VIDEO_MODERATION_TIMEOUT_HOURS, VIDEO_CHANNELS |
| Modify | `tests/video.pipeline.test.js` | Обновить тесты CHANNELS, добавить тесты VK Video |

---

## Task 1: Написать падающие тесты

**Files:**
- Modify: `tests/video.pipeline.test.js`

- [ ] **Step 1: Добавить падающие тесты в конец файла**

Открыть `tests/video.pipeline.test.js` и добавить перед финальным блоком `// Summary`:

```js
// Test 9: CHANNELS contains vk
test('CHANNELS contains youtube, tiktok, instagram, vk', () => {
  assert.deepStrictEqual(vpRepo.CHANNELS, ['youtube', 'tiktok', 'instagram', 'vk']);
  assert.strictEqual(vpRepo.CHANNELS.length, 4);
});

// Test 10: VK Video MVP Service
test('vkVideoMvp.service.js exports all functions', () => {
  const vkVideoMvp = require('../services/vkVideoMvp.service');
  assert.strictEqual(typeof vkVideoMvp.handleVkVideoGenerateJob, 'function');
  assert.strictEqual(typeof vkVideoMvp.handleVkVideoModerationAction, 'function');
  assert.strictEqual(typeof vkVideoMvp.startScheduler, 'function');
  assert.strictEqual(typeof vkVideoMvp.stopScheduler, 'function');
  assert.strictEqual(typeof vkVideoMvp.setVkVideoCwBot, 'function');
  assert.strictEqual(typeof vkVideoMvp.getVkVideoSettings, 'function');
  assert.strictEqual(typeof vkVideoMvp.publishVkVideoPost, 'function');
});

// Test 11: manageStore VK Video functions
test('manageStore has VK Video functions', () => {
  const manageStore = require('../manage/store');
  assert.strictEqual(typeof manageStore.getVkVideoConfig, 'function');
  assert.strictEqual(typeof manageStore.setVkVideoConfig, 'function');
  assert.strictEqual(typeof manageStore.clearVkVideoConfig, 'function');
});

// Test 12: Migration contains vk
test('Video migration contains vk channel', () => {
  const fs = require('fs');
  const migration = fs.readFileSync('./migrations/20260411_add_vk_video_channel.sql', 'utf-8');
  assert.ok(migration.includes("'vk'"), "Migration must include 'vk' in channel constraints");
});

// Test 13: ENV has VK Video variables
test('.env.example has VK Video pipeline variables', () => {
  const fs = require('fs');
  const envExample = fs.readFileSync('./.env.example', 'utf-8');
  assert.ok(envExample.includes('VK_VIDEO_DAILY_LIMIT'));
  assert.ok(envExample.includes('VK_VIDEO_MODERATION_TIMEOUT_HOURS'));
  assert.ok(envExample.includes('vk'), 'VIDEO_CHANNELS must include vk');
});
```

- [ ] **Step 2: Запустить тесты — убедиться что все новые падают**

```bash
node tests/video.pipeline.test.js
```

Ожидаемый результат: тесты 1–8 проходят, тесты 9–13 падают с ошибками типа `AssertionError` или `Cannot find module`.

---

## Task 2: Миграция + обновление CHANNELS

**Files:**
- Create: `migrations/20260411_add_vk_video_channel.sql`
- Modify: `services/content/videoPipeline.repository.js`

- [ ] **Step 1: Создать файл миграции**

Создать `migrations/20260411_add_vk_video_channel.sql`:

```sql
-- Migration: 20260411_add_vk_video_channel
-- Adds 'vk' to channel CHECK constraints in video pipeline tables
-- Apply per-user: run against each db_{chatId} database
-- Run: psql -U postgres -d db_{chatId} -f migrations/20260411_add_vk_video_channel.sql

-- video_assets.initiating_channel: drop old constraint, add new with 'vk'
DO $$
BEGIN
  -- Drop old constraint if exists
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'video_assets_channel_check'
  ) THEN
    ALTER TABLE video_assets DROP CONSTRAINT video_assets_channel_check;
  END IF;

  -- Add updated constraint
  ALTER TABLE video_assets
    ADD CONSTRAINT video_assets_channel_check
    CHECK (initiating_channel IN ('youtube','tiktok','instagram','vk'));
END$$;

-- video_channel_usage.channel_type: drop old constraint, add new with 'vk'
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'video_channel_usage_channel_check'
  ) THEN
    ALTER TABLE video_channel_usage DROP CONSTRAINT video_channel_usage_channel_check;
  END IF;

  ALTER TABLE video_channel_usage
    ADD CONSTRAINT video_channel_usage_channel_check
    CHECK (channel_type IN ('youtube','tiktok','instagram','vk'));
END$$;
```

- [ ] **Step 2: Обновить CHANNELS константу в репозитории**

В `services/content/videoPipeline.repository.js`, строка 9:

```js
// Было:
const CHANNELS = (process.env.VIDEO_CHANNELS || 'youtube,tiktok,instagram').split(',').map(s => s.trim().toLowerCase());

// Стало:
const CHANNELS = (process.env.VIDEO_CHANNELS || 'youtube,tiktok,instagram,vk').split(',').map(s => s.trim().toLowerCase());
```

- [ ] **Step 3: Обновить ensureSchema — CHECK constraints в таблицах**

В `services/content/videoPipeline.repository.js`, функция `ensureSchema`, найти строку с `video_assets_channel_check` и заменить:

```js
// Было:
  CONSTRAINT video_assets_channel_check CHECK (
    initiating_channel IN ('youtube','tiktok','instagram')
  )

// Стало:
  CONSTRAINT video_assets_channel_check CHECK (
    initiating_channel IN ('youtube','tiktok','instagram','vk')
  )
```

Там же найти `video_channel_usage_channel_check`:

```js
// Было:
  CONSTRAINT video_channel_usage_channel_check CHECK (
    channel_type IN ('youtube','tiktok','instagram')
  )

// Стало:
  CONSTRAINT video_channel_usage_channel_check CHECK (
    channel_type IN ('youtube','tiktok','instagram','vk')
  )
```

- [ ] **Step 4: Запустить тесты — тесты 9 и 12 должны пройти**

```bash
node tests/video.pipeline.test.js
```

Ожидаемый результат: тесты 9 и 12 проходят. Тесты 10, 11, 13 всё ещё падают.

- [ ] **Step 5: Коммит**

```bash
git add migrations/20260411_add_vk_video_channel.sql services/content/videoPipeline.repository.js
git commit -m "feat: add vk to video pipeline channel constraints and CHANNELS constant"
```

---

## Task 3: manageStore — VkVideoConfig

**Files:**
- Modify: `manage/store.js`

- [ ] **Step 1: Добавить функции VK Video конфига в store.js**

В `manage/store.js` найти блок `// === TikTok Config ===` (строка ~702) и добавить после блока `clearTiktokConfig` (строка ~734) новый блок:

```js
// === VK Video Config ===

function getVkVideoConfig(chatId) {
    const data = statesCache[chatId];
    return data?.vkVideoConfig || null;
}

function setVkVideoConfig(chatId, patch = {}) {
    if (!statesCache[chatId]) statesCache[chatId] = {};
    const current = statesCache[chatId].vkVideoConfig || {};
    const next = { ...current };

    if (patch.is_active !== undefined) next.is_active = !!patch.is_active;
    if (patch.auto_publish !== undefined) next.auto_publish = !!patch.auto_publish;
    if (patch.schedule_time !== undefined) next.schedule_time = patch.schedule_time || null;
    if (patch.schedule_tz !== undefined) next.schedule_tz = patch.schedule_tz || null;
    if (patch.daily_limit !== undefined) next.daily_limit = Number.isFinite(patch.daily_limit) ? patch.daily_limit : 3;
    if (patch.publish_interval_hours !== undefined) next.publish_interval_hours = Number.isFinite(patch.publish_interval_hours) ? patch.publish_interval_hours : 6;
    if (patch.random_publish !== undefined) next.random_publish = !!patch.random_publish;
    if (patch.allowed_weekdays !== undefined && Array.isArray(patch.allowed_weekdays)) next.allowed_weekdays = patch.allowed_weekdays;
    if (patch.moderator_user_id !== undefined) next.moderator_user_id = String(patch.moderator_user_id || '').trim() || null;
    if (patch.stats !== undefined) next.stats = { ...(next.stats || {}), ...patch.stats };

    statesCache[chatId].vkVideoConfig = next;
    return persist(chatId);
}

function clearVkVideoConfig(chatId) {
    if (statesCache[chatId]) {
        delete statesCache[chatId].vkVideoConfig;
        return persist(chatId);
    }
}
```

- [ ] **Step 2: Добавить экспорт в конец module.exports**

В `manage/store.js` найти строку с `clearTiktokConfig,` в `module.exports` и после неё добавить:

```js
    getVkVideoConfig,
    setVkVideoConfig,
    clearVkVideoConfig,
```

- [ ] **Step 3: Запустить тесты — тест 11 должен пройти**

```bash
node tests/video.pipeline.test.js
```

Ожидаемый результат: тесты 9, 11, 12 проходят. Тесты 10, 13 всё ещё падают.

- [ ] **Step 4: Коммит**

```bash
git add manage/store.js
git commit -m "feat: add getVkVideoConfig/setVkVideoConfig/clearVkVideoConfig to manageStore"
```

---

## Task 4: Создать vkVideoMvp.service.js

**Files:**
- Create: `services/vkVideoMvp.service.js`

- [ ] **Step 1: Создать файл сервиса**

Создать `services/vkVideoMvp.service.js`:

```js
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
const VK_VIDEO_MODERATION_TIMEOUT_HOURS = parseInt(process.env.VK_VIDEO_MODERATION_TIMEOUT_HOURS || '24', 10);
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

/**
 * Вызов VK API метода
 */
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
  const stats = await vpRepo.getVideoStats(chatId);
  const usageRes = await vpRepo.withClient(chatId, async (client) => {
    const r = await client.query(
      `SELECT COUNT(*) as cnt FROM video_channel_usage
       WHERE channel_type = 'vk' AND used_at::date = CURRENT_DATE`
    );
    return parseInt(r.rows[0]?.cnt || 0);
  });
  const publishedToday = usageRes;
  if (publishedToday >= settings.dailyLimit) {
    return { success: false, error: `Дневной лимит VK Video исчерпан (${publishedToday}/${settings.dailyLimit})`, retry: false };
  }

  // Получаем VK credentials
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
  const ownerId = `-${groupId}`; // отрицательный ID для группы

  // Шаг 1: video.save — получаем upload_url
  const saveResp = await vkApiCall('video.save', {
    access_token: accessToken,
    name: draft.title,
    description: draft.description,
    group_id: groupId,
    wallpost: 0  // публикуем через wall.post отдельно
  });

  const uploadUrl = saveResp.upload_url;
  const videoVkId = saveResp.video_id;
  const ownVkId = saveResp.owner_id;

  if (!uploadUrl) throw new Error('VK video.save: upload_url не получен');

  console.log(`[VK-VIDEO-MVP] Got upload_url, video_id=${videoVkId}`);

  // Шаг 2: загружаем MP4 файл
  const videoFullPath = path.join(videoPipeline.VIDEO_TEMP_ROOT, chatId, draft.videoPath);
  const videoBuffer = await fs.readFile(videoFullPath);
  const uploadResult = await uploadVideoToVk(uploadUrl, videoBuffer, `video_${draft.videoId}.mp4`);

  if (!uploadResult?.video_id && !uploadResult?.video_hash) {
    throw new Error(`VK upload failed: ${JSON.stringify(uploadResult)}`);
  }

  console.log(`[VK-VIDEO-MVP] Video uploaded successfully`);

  // Шаг 3: публикуем на стену
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

  // Обновляем статус черновика
  draft.status = 'published';
  draft.publishedAt = new Date().toISOString();
  await setVkVideoDraft(chatId, String(jobId), draft);

  // Уведомляем пользователя
  if (bot?.telegram) {
    await bot.telegram.sendMessage(
      chatId,
      `✅ VK Видео опубликовано!\n\n` +
      `📹 ${draft.title}\n` +
      `📝 ${draft.description}`
    ).catch(() => {});
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
  const now = new Date();

  for (const [chatId] of Object.entries(allStates)) {
    try {
      const settings = getVkVideoSettings(chatId);
      if (!settings.isActive) continue;

      const { time: nowTime } = getNowInTz(settings.scheduleTz);
      if (nowTime !== settings.scheduleTime) continue;

      const dayOfWeek = now.getDay();
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
```

- [ ] **Step 2: Запустить тесты — тест 10 должен пройти**

```bash
node tests/video.pipeline.test.js
```

Ожидаемый результат: тесты 9, 10, 11, 12 проходят. Тест 13 всё ещё падает.

- [ ] **Step 3: Коммит**

```bash
git add services/vkVideoMvp.service.js
git commit -m "feat: add vkVideoMvp.service.js with VK API video publish and moderation"
```

---

## Task 5: Интеграция в server.js

**Files:**
- Modify: `server.js`

- [ ] **Step 1: Добавить vk_vid_mod: callback в CW Bot**

В `server.js` найти блок TikTok moderation (строка ~504) и добавить после него (`// API endpoint для получения username CW бота`):

```js
        // VK Video moderation callbacks for CW_BOT_TOKEN users
        cwBot.action(/^vk_vid_mod:(\d+):(approve|reject|regen_text)$/, async (ctx) => {
            const fromId = String(ctx.from?.id || '');
            const jobId = Number(ctx.match?.[1]);
            const action = ctx.match?.[2];

            console.log(`[CW-BOT-VK-VID] ${action} job ${jobId} (fromId=${fromId})`);

            // Находим chatId по черновику
            let resolvedChatId = null;
            const allStatesVkVid = manageStore.getAllStates();
            for (const [cid, data] of Object.entries(allStatesVkVid)) {
                const drafts = data.vkVideoDrafts || {};
                if (!drafts[String(jobId)]) continue;

                const vkVidSettings = manageStore.getVkVideoConfig?.(cid) || {};
                const globalSettings = data.contentSettings || {};
                const channelModeratorId = vkVidSettings.moderator_user_id ||
                                           globalSettings.moderatorUserId ||
                                           process.env.CONTENT_MVP_MODERATOR_USER_ID;
                const ownerTgId = String(data.verifiedTelegramId || '');
                const allowedIds = new Set([ownerTgId, channelModeratorId].filter(Boolean));

                if (allowedIds.has(fromId)) {
                    resolvedChatId = cid;
                    break;
                }
            }

            if (!resolvedChatId) {
                await ctx.answerCbQuery('Черновик не найден').catch(() => {});
                return;
            }

            try {
                const vkVideoMvpService = require('./services/vkVideoMvp.service');
                const result = await vkVideoMvpService.handleVkVideoModerationAction(resolvedChatId, { telegram: ctx.telegram }, jobId, action);
                await ctx.answerCbQuery(result?.ok ? 'Готово' : 'Ошибка').catch(() => {});
                await ctx.reply(result?.message || 'Операция выполнена.').catch(() => {});
            } catch (e) {
                console.error(`[CW-BOT-VK-VID] Error:`, e);
                await ctx.answerCbQuery('Ошибка').catch(() => {});
                await ctx.reply(`Ошибка модерации VK Video: ${e.message}`).catch(() => {});
            }
        });
```

- [ ] **Step 2: Передать cwBot в vkVideoMvp и запустить планировщик**

В `server.js` найти строку `youtubeMvpService.setYtCwBot(cwBot);` (строка ~615) и добавить после неё:

```js
    const vkVideoMvpService = require('./services/vkVideoMvp.service');
    vkVideoMvpService.setVkVideoCwBot(cwBot);
```

Затем найти блок `// Запуск TikTok-планировщика` (строка ~659) и добавить после него:

```js
    // Запуск VK Video-планировщика
    vkVideoMvpService.startScheduler(() => telegramRunner.bots);
```

- [ ] **Step 3: Добавить stopScheduler в shutdown**

В `server.js` найти строку `try { require('./services/tiktokMvp.service').stopScheduler(); } catch (_) {}` (строка ~743) и добавить после неё:

```js
        try { require('./services/vkVideoMvp.service').stopScheduler(); } catch (_) {}
```

- [ ] **Step 4: Коммит**

```bash
git add server.js
git commit -m "feat: integrate vkVideoMvp into server.js — cwBot, moderation callback, scheduler"
```

---

## Task 6: ENV и финальные тесты

**Files:**
- Modify: `.env.example`
- Modify: `tests/video.pipeline.test.js`

- [ ] **Step 1: Добавить VK Video переменные в .env.example**

В `.env.example` найти строку `TIKTOK_MODERATION_TIMEOUT_HOURS=24` (строка ~214) и добавить после неё:

```env

# ===========================================
# VK Video Integration
# ===========================================
# Daily VK Video post limit
VK_VIDEO_DAILY_LIMIT=3

# Moderation timeout in hours (auto-reject after)
VK_VIDEO_MODERATION_TIMEOUT_HOURS=24
```

Затем найти строку `VIDEO_CHANNELS=youtube,tiktok,instagram` (строка ~255) и заменить:

```env
VIDEO_CHANNELS=youtube,tiktok,instagram,vk
```

- [ ] **Step 2: Запустить все тесты — все должны пройти**

```bash
node tests/video.pipeline.test.js
```

Ожидаемый результат:
```
✅ videoPipeline.repository.js exports all functions
✅ CHANNELS contains youtube, tiktok, instagram
✅ videoPipeline.service.js exports all functions
✅ video.routes.js exports router
✅ tiktokMvp.service.js exports all functions
✅ manageStore has TikTok functions
✅ Video statuses are defined correctly in migration
✅ .env.example has video pipeline variables
✅ CHANNELS contains youtube, tiktok, instagram, vk
✅ vkVideoMvp.service.js exports all functions
✅ manageStore has VK Video functions
✅ Video migration contains vk channel
✅ .env.example has VK Video pipeline variables

Tests: 13 passed, 0 failed, 13 total
✅ All tests passed
```

- [ ] **Step 3: Финальный коммит**

```bash
git add .env.example tests/video.pipeline.test.js
git commit -m "feat: add VK Video env vars and update tests — all 13 passing"
```

---

## Self-Review

**Покрытие спека:**
- ✅ 1.1 Создать vkVideoMvp.service.js — Task 4
- ✅ 1.2 publishVkVideoPost через VK API (video.save → upload → wall.post) — Task 4
- ✅ 1.3 Модерация vk_vid_mod: в CW Bot — Task 5
- ✅ 1.4 Добавить 'vk' в CHECK constraints — Task 2
- ✅ 1.5 Обновить CHANNELS — Task 2
- ✅ 1.6 getVkVideoConfig/setVkVideoConfig — Task 3
- ✅ Тесты 9–13 — Tasks 1, 2, 3, 4, 6

**Проверка типов:**
- `handleVkVideoModerationAction(chatId, bot, jobId, action)` — jobId это `Number`, передаётся из `ctx.match?.[1]` → `Number(...)` ✅
- `publishVkVideoPost(chatId, bot, jobId)` — jobId это `Number`, в drafts ключ это `String(jobId)` ✅
- `videoPipeline.VIDEO_TEMP_ROOT` используется в Task 4 — экспортируется из videoPipeline.service.js ✅
- `manageStore.getVkConfig(chatId)` возвращает `{ service_key, group_id }` — проверено в store.js ✅
