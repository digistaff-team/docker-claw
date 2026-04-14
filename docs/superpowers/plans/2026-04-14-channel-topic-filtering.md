# Channel Topic Filtering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each publishing channel fetches only topics assigned to it from `content_topics`; topics with no channel are universal and available to all.

**Architecture:** Add optional `channel` param to `reserveNextTopic` in the repository — SQL filters by `channel = $1 OR channel IS NULL`. Each service passes its canonical channel name. Video-pipeline schedulers (TikTok, VK Video, YouTube) reserve a topic before enqueuing. Instagram Reels gets a new scheduler. Google Sheets import parses the `channel` column.

**Tech Stack:** Node.js, PostgreSQL (pg), existing service patterns in `services/*Mvp.service.js`

---

## File Map

| File | Change |
|---|---|
| `services/content/repository.js` | Add `channel` param to `reserveNextTopic` |
| `services/telegramMvp.service.js` | Add `normalizeChannel`; pass `'telegram'`; parse `channel` in import |
| `services/vkMvp.service.js` | Pass `'vk'` |
| `services/okMvp.service.js` | Pass `'ok'` |
| `services/instagramMvp.service.js` | Pass `'instagram'`; add Reels scheduler |
| `services/facebookMvp.service.js` | Fix `pickTopic` bug → `reserveNextTopic(chatId, 'facebook')` |
| `services/pinterestMvp.service.js` | Pass `'pinterest'` |
| `services/youtubeMvp.service.js` | Pass `'youtube'` |
| `services/content/worker.js` | Pass `'wordpress'` |
| `services/tiktokMvp.service.js` | Reserve topic in scheduler before enqueue |
| `services/vkVideoMvp.service.js` | Reserve topic in scheduler before enqueue |
| `tests/channel.topics.test.js` | New: unit tests for `normalizeChannel` |

---

## Task 1: Add `normalizeChannel` helper and unit tests

**Files:**
- Modify: `services/telegramMvp.service.js`
- Create: `tests/channel.topics.test.js`

The set of valid channel names is the canonical list. Anything outside it → `null` (universal).

- [ ] **Step 1: Write the failing test**

Create `tests/channel.topics.test.js`:

```js
'use strict';

const assert = require('assert');

// Mock all heavy dependencies before requiring the module
const Module = require('module');
const originalLoad = Module._load;
Module._load = function (request, ...args) {
  if (request === 'node-fetch') return () => Promise.resolve({ ok: true, text: async () => '' });
  if (request === 'pg') return { Pool: class { query() {} end() {} } };
  if (request === '../config') return { DATA_ROOT: '/tmp', APP_URL: 'http://localhost' };
  if (request === '../manage/store') return { getState: () => ({}), getAllStates: () => ({}) };
  if (request === './ai_router_service') return { callAI: async () => '' };
  if (request === './content/repository') return {};
  if (request === './content/index') return { repository: {}, queueRepo: {}, generateCorrelationId: () => 'x', worker: { registerJobHandler: () => {} } };
  if (request === './session.service') return {};
  if (request === './storage.service') return {};
  if (request === './inputImageContext.service') return {};
  if (request === './image.service') return {};
  if (request === './imageGen.service') return {};
  return originalLoad.call(this, request, ...args);
};

const { normalizeChannel } = require('../services/telegramMvp.service');
Module._load = originalLoad;

const colors = { green: '\x1b[32m', red: '\x1b[31m', reset: '\x1b[0m' };
let passed = 0, failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ${colors.green}✓${colors.reset} ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ${colors.red}✗${colors.reset} ${name}: ${e.message}`);
    failed++;
  }
}

console.log('\nnormalizeChannel');

test('lowercase known channel returned as-is', () => {
  assert.strictEqual(normalizeChannel('telegram'), 'telegram');
  assert.strictEqual(normalizeChannel('vk'), 'vk');
  assert.strictEqual(normalizeChannel('vk_video'), 'vk_video');
  assert.strictEqual(normalizeChannel('ok'), 'ok');
  assert.strictEqual(normalizeChannel('instagram'), 'instagram');
  assert.strictEqual(normalizeChannel('instagram_reels'), 'instagram_reels');
  assert.strictEqual(normalizeChannel('facebook'), 'facebook');
  assert.strictEqual(normalizeChannel('pinterest'), 'pinterest');
  assert.strictEqual(normalizeChannel('youtube'), 'youtube');
  assert.strictEqual(normalizeChannel('wordpress'), 'wordpress');
  assert.strictEqual(normalizeChannel('tiktok'), 'tiktok');
});

test('uppercase input is normalised to lowercase', () => {
  assert.strictEqual(normalizeChannel('VK'), 'vk');
  assert.strictEqual(normalizeChannel('INSTAGRAM_REELS'), 'instagram_reels');
  assert.strictEqual(normalizeChannel('Telegram'), 'telegram');
});

test('whitespace is trimmed', () => {
  assert.strictEqual(normalizeChannel('  vk  '), 'vk');
  assert.strictEqual(normalizeChannel('\ttiktok\n'), 'tiktok');
});

test('empty / blank string returns null', () => {
  assert.strictEqual(normalizeChannel(''), null);
  assert.strictEqual(normalizeChannel('   '), null);
  assert.strictEqual(normalizeChannel(null), null);
  assert.strictEqual(normalizeChannel(undefined), null);
});

test('unknown value returns null', () => {
  assert.strictEqual(normalizeChannel('twitter'), null);
  assert.strictEqual(normalizeChannel('vk-video'), null); // dash not underscore
  assert.strictEqual(normalizeChannel('all'), null);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
node tests/channel.topics.test.js
```

Expected: `TypeError: normalizeChannel is not a function` (not exported yet)

- [ ] **Step 3: Add `normalizeChannel` to `services/telegramMvp.service.js`**

Find the block of helper functions near `normalizeStatusValue` (around line 172) and add after it:

```js
const VALID_CHANNELS = new Set([
  'telegram', 'vk', 'vk_video', 'ok',
  'instagram', 'instagram_reels', 'facebook',
  'pinterest', 'youtube', 'wordpress', 'tiktok'
]);

function normalizeChannel(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return null;
  return VALID_CHANNELS.has(normalized) ? normalized : null;
}
```

Then add `normalizeChannel` to the `module.exports` at the bottom of the file (find the exports object and add the entry).

- [ ] **Step 4: Run test to confirm it passes**

```bash
node tests/channel.topics.test.js
```

Expected:
```
normalizeChannel
  ✓ lowercase known channel returned as-is
  ✓ uppercase input is normalised to lowercase
  ✓ whitespace is trimmed
  ✓ empty / blank string returns null
  ✓ unknown value returns null

5 passed, 0 failed
```

- [ ] **Step 5: Commit**

```bash
git add services/telegramMvp.service.js tests/channel.topics.test.js
git commit -m "feat: add normalizeChannel helper with unit tests"
```

---

## Task 2: Update `reserveNextTopic` to filter by channel

**Files:**
- Modify: `services/content/repository.js` (line ~895)

- [ ] **Step 1: Replace `reserveNextTopic` in `services/content/repository.js`**

Replace the existing function (lines 895–927):

```js
async function reserveNextTopic(chatId, channel = null) {
  return withClient(chatId, async (client) => {
    await client.query('BEGIN');
    try {
      const result = await client.query(
        `SELECT id, topic, focus, secondary, lsi, status, created_at, used_at
         FROM content_topics
         WHERE status = 'pending'
           AND ($1::text IS NULL OR channel = $1 OR channel IS NULL)
         ORDER BY created_at ASC, id ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1`,
        [channel]
      );
      const row = result.rows[0];
      if (!row) {
        await client.query('COMMIT');
        return null;
      }

      await client.query(
        `UPDATE content_topics
         SET status = 'used', used_at = NOW()
         WHERE id = $1`,
        [row.id]
      );

      await client.query('COMMIT');
      return row;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
  });
}
```

- [ ] **Step 2: Run existing tests to confirm nothing is broken**

```bash
npm test
```

Expected: all tests pass (this change is backwards-compatible — `channel = null` keeps old behaviour).

- [ ] **Step 3: Commit**

```bash
git add services/content/repository.js
git commit -m "feat: reserveNextTopic accepts optional channel filter"
```

---

## Task 3: Pass channel name in all text channel services

**Files:**
- Modify: `services/telegramMvp.service.js` (line ~684)
- Modify: `services/vkMvp.service.js` (line ~273)
- Modify: `services/okMvp.service.js` (line ~309)
- Modify: `services/instagramMvp.service.js` (line ~251)
- Modify: `services/pinterestMvp.service.js` (line ~294)
- Modify: `services/youtubeMvp.service.js` (line ~293)
- Modify: `services/content/worker.js` (line ~417)

- [ ] **Step 1: Update `telegramMvp.service.js` — `pickNextTopic`**

In `pickNextTopic` (line ~684), change:
```js
const topic = await repository.reserveNextTopic(chatId);
```
to:
```js
const topic = await repository.reserveNextTopic(chatId, 'telegram');
```

- [ ] **Step 2: Update `vkMvp.service.js`**

In `handleVkGenerateJob` (line ~273), change:
```js
const topicRow = await repository.reserveNextTopic(chatId);
```
to:
```js
const topicRow = await repository.reserveNextTopic(chatId, 'vk');
```

- [ ] **Step 3: Update `okMvp.service.js`**

In `handleOkGenerateJob` (line ~309), change:
```js
const topicRow = await repository.reserveNextTopic(chatId);
```
to:
```js
const topicRow = await repository.reserveNextTopic(chatId, 'ok');
```

- [ ] **Step 4: Update `instagramMvp.service.js`**

In `handleIgGenerateJob` (line ~251), change:
```js
const topicRow = await repository.reserveNextTopic(chatId);
```
to:
```js
const topicRow = await repository.reserveNextTopic(chatId, 'instagram');
```

- [ ] **Step 5: Update `pinterestMvp.service.js`**

In `handlePinterestGenerateJob` (line ~294), change:
```js
const topicRow = await repository.reserveNextTopic(chatId);
```
to:
```js
const topicRow = await repository.reserveNextTopic(chatId, 'pinterest');
```

- [ ] **Step 6: Update `youtubeMvp.service.js`**

In `handleYoutubeGenerateJob` (line ~293), change:
```js
const topicRow = await repository.reserveNextTopic(chatId);
```
to:
```js
const topicRow = await repository.reserveNextTopic(chatId, 'youtube');
```

- [ ] **Step 7: Update `services/content/worker.js`**

In `scheduleBlogGeneration` (line ~417), change:
```js
const topic = await contentRepo.reserveNextTopic(chatId);
```
to:
```js
const topic = await contentRepo.reserveNextTopic(chatId, 'wordpress');
```

- [ ] **Step 8: Run tests**

```bash
npm test
```

Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add services/telegramMvp.service.js services/vkMvp.service.js services/okMvp.service.js \
        services/instagramMvp.service.js services/pinterestMvp.service.js \
        services/youtubeMvp.service.js services/content/worker.js
git commit -m "feat: text channels pass their name to reserveNextTopic"
```

---

## Task 4: Fix Facebook `pickTopic` bug

**Files:**
- Modify: `services/facebookMvp.service.js` (line ~213)

`repository.pickTopic` does not exist — calling it throws `TypeError: repository.pickTopic is not a function` and Facebook never publishes.

- [ ] **Step 1: Fix the call in `handleFacebookGenerateJob`**

In `services/facebookMvp.service.js`, around line 213, replace:

```js
const topic = await repository.pickTopic(chatId);
```

with:

```js
const topicRow = await repository.reserveNextTopic(chatId, 'facebook');
if (!topicRow) {
  console.log(`[FB] No topic available for ${chatId}`);
  await fbRepo.addPublishLog(chatId, {
    bufferChannelId: getFacebookSettings(chatId).bufferChannelId,
    status: 'skipped',
    errorText: 'No topic available',
    correlationId
  });
  return;
}
const topic = {
  sheetRow: topicRow.id,
  topic: topicRow.topic,
  focus: topicRow.focus || '',
  secondary: topicRow.secondary || '',
  lsi: topicRow.lsi || ''
};
```

Remove the now-dead `if (!topic)` block that follows (lines 214–223) since the early return is now inside the new block above.

- [ ] **Step 2: Run tests**

```bash
npm test
```

Expected: all pass.

- [ ] **Step 3: Commit**

```bash
git add services/facebookMvp.service.js
git commit -m "fix: replace missing pickTopic with reserveNextTopic in Facebook service"
```

---

## Task 5: TikTok scheduler — reserve topic before enqueue

**Files:**
- Modify: `services/tiktokMvp.service.js` (line ~472, `publishScheduledPosts`)

Currently the scheduler calls `handleTiktokGenerateJob(chatId, {}, ...)` with an empty job object, causing the service to fall back to `{ topic: 'Product showcase' }`. Now it must reserve a real topic first.

- [ ] **Step 1: Add repository import at top of `tiktokMvp.service.js`**

Find the `require` block at the top of the file. Add:

```js
const repository = require('./content/repository');
```

- [ ] **Step 2: Update `publishScheduledPosts` in `tiktokMvp.service.js`**

Replace the inner loop body (currently around line 495–502):

```js
// Запускаем генерацию
const bot = botsGetter?.()?.get(chatId);
if (!bot?.bot) continue;

await handleTiktokGenerateJob(chatId, {}, bot.bot, `tiktok_schedule_${Date.now()}`);
```

with:

```js
const bot = botsGetter?.()?.get(chatId);
if (!bot?.bot) continue;

// Резервируем тему для TikTok
const topicRow = await repository.reserveNextTopic(chatId, 'tiktok');
if (!topicRow) {
  console.log(`[TIKTOK-MVP] No pending topics for ${chatId}, skipping`);
  continue;
}

const corrId = `tiktok_schedule_${Date.now()}`;
try {
  await handleTiktokGenerateJob(
    chatId,
    { topic: { sheetRow: topicRow.id, topic: topicRow.topic, focus: topicRow.focus || '', secondary: topicRow.secondary || '', lsi: topicRow.lsi || '' } },
    bot.bot,
    corrId
  );
} catch (e) {
  // Вернуть тему в очередь при ошибке
  await repository.updateTopicStatus(chatId, topicRow.id, 'pending', `tiktok_schedule_failed: ${e.message}`).catch(() => {});
  throw e;
}
```

- [ ] **Step 3: Run tests**

```bash
npm test
```

Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add services/tiktokMvp.service.js
git commit -m "feat: TikTok scheduler reserves topic from content_topics"
```

---

## Task 6: VK Video scheduler — reserve topic before enqueue

**Files:**
- Modify: `services/vkVideoMvp.service.js` (line ~577, `publishScheduledPosts`)

Same pattern as TikTok. Currently calls `handleVkVideoGenerateJob(chatId, {}, ...)` with empty job, falling back to `{ topic: 'Демонстрация товара' }`.

- [ ] **Step 1: Add repository import at top of `vkVideoMvp.service.js`**

Find the `require` block at the top. Add:

```js
const repository = require('./content/repository');
```

- [ ] **Step 2: Update `publishScheduledPosts` in `vkVideoMvp.service.js`**

Replace the inner call (currently around line 596):

```js
await handleVkVideoGenerateJob(chatId, {}, bot.bot, `vkvideo_schedule_${Date.now()}`);
```

with:

```js
// Резервируем тему для VK Video
const topicRow = await repository.reserveNextTopic(chatId, 'vk_video');
if (!topicRow) {
  console.log(`[VK-VIDEO-MVP] No pending topics for ${chatId}, skipping`);
  continue;
}

const corrId = `vkvideo_schedule_${Date.now()}`;
try {
  await handleVkVideoGenerateJob(
    chatId,
    { topic: { sheetRow: topicRow.id, topic: topicRow.topic, focus: topicRow.focus || '', secondary: topicRow.secondary || '', lsi: topicRow.lsi || '' } },
    bot.bot,
    corrId
  );
} catch (e) {
  await repository.updateTopicStatus(chatId, topicRow.id, 'pending', `vkvideo_schedule_failed: ${e.message}`).catch(() => {});
  throw e;
}
```

- [ ] **Step 3: Run tests**

```bash
npm test
```

Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add services/vkVideoMvp.service.js
git commit -m "feat: VK Video scheduler reserves topic from content_topics"
```

---

## Task 7: Instagram Reels scheduler

**Files:**
- Modify: `services/instagramMvp.service.js`

Add a `tickIgReelsSchedule` function that runs alongside the existing `tickIgSchedule` inside the scheduler interval. It reserves a topic with `'instagram_reels'`, claims/generates video via the shared pipeline (mapping `instagram_reels` → `'instagram'`), generates a caption, creates a moderation draft and sends it through the existing `sendIgToModerator` flow.

- [ ] **Step 1: Add `videoPipeline` import at top of `instagramMvp.service.js`**

`repository` is already available (imported via `content/index` on line 19). Only `videoPipeline` needs to be added. Find the require block at the top and add:

```js
const videoPipeline = require('./videoPipeline.service');
```

- [ ] **Step 2: Add `tickIgReelsSchedule` function**

Add this function after the existing `tickIgSchedule` function (before the `// Scheduler & Worker Registration` comment):

```js
async function tickIgReelsSchedule(chatId, bot) {
  const cfg = manageStore.getInstagramConfig(chatId);
  // Reels активны только если явно включены отдельным флагом
  if (!cfg || !cfg.reels_is_active) return;

  const tz = cfg.schedule_tz && isValidTz(cfg.schedule_tz) ? cfg.schedule_tz : SCHEDULE_TZ;
  const now = getNowInTz(tz);

  // Дневной лимит (reels_daily_limit или fallback 1)
  // Используем общий счётчик instagram_jobs за сегодня — Reels делят лимит с фото-постами
  const reelsDailyLimit = Number.isFinite(cfg.reels_daily_limit) ? cfg.reels_daily_limit : 1;
  const reelsPublishedToday = await igRepo.countPublishedToday(chatId, tz).catch(() => 0);
  if (reelsPublishedToday >= reelsDailyLimit) return;

  // Проверка времени расписания (reels_schedule_time или '14:00')
  const scheduleTime = cfg.reels_schedule_time || '14:00';
  if (now.time !== scheduleTime) return;

  // Дедупликация запусков в рамках одной минуты
  const runKey = `igReelsLastRun:${now.time}`;
  const allStates = manageStore.getAllStates();
  const data = allStates[chatId] || {};
  if (data[runKey] === now.date) return;
  data[runKey] = now.date;
  if (!allStates[chatId]) allStates[chatId] = data;
  await manageStore.persist(chatId);

  console.log(`[IG-REELS] ${chatId} scheduling reels generation at ${now.time}`);

  // Резервируем тему
  const topicRow = await repository.reserveNextTopic(chatId, 'instagram_reels');
  if (!topicRow) {
    console.log(`[IG-REELS] ${chatId} no pending topics for instagram_reels`);
    return;
  }

  const topic = {
    sheetRow: topicRow.id,
    topic: topicRow.topic,
    focus: topicRow.focus || '',
    secondary: topicRow.secondary || '',
    lsi: topicRow.lsi || ''
  };

  // Получаем видео из общего пайплайна (канал 'instagram')
  let videoPath = '';
  let videoId = null;
  try {
    const claimResult = await videoPipeline.claimVideo(chatId, 'instagram');
    if (claimResult.success) {
      videoPath = claimResult.videoPath;
      videoId = claimResult.videoId;
      console.log(`[IG-REELS] ${chatId} claimed shared video videoId=${videoId}`);
    } else {
      const genResult = await videoPipeline.generateVideo(chatId, 'instagram');
      if (!genResult.success) {
        await repository.updateTopicStatus(chatId, topicRow.id, 'pending', `ig_reels_video_failed: ${genResult.error}`);
        console.error(`[IG-REELS] ${chatId} video generation failed: ${genResult.error}`);
        return;
      }
      videoPath = genResult.videoPath;
      videoId = genResult.videoId;
      console.log(`[IG-REELS] ${chatId} generated new video videoId=${videoId}`);
    }
  } catch (e) {
    await repository.updateTopicStatus(chatId, topicRow.id, 'pending', `ig_reels_video_failed: ${e.message}`);
    console.error(`[IG-REELS] ${chatId} video pipeline error: ${e.message}`);
    return;
  }

  // Генерируем подпись
  let igText;
  try {
    const [materialsText, personaText] = await Promise.all([
      loadMaterialsText(chatId, 12),
      loadUserPersona(chatId)
    ]);
    igText = await generateIgPostText(chatId, topic, materialsText, personaText);
  } catch (e) {
    await repository.updateTopicStatus(chatId, topicRow.id, 'pending', `ig_reels_text_failed: ${e.message}`);
    console.error(`[IG-REELS] ${chatId} text generation failed: ${e.message}`);
    return;
  }

  // Создаём черновик и отправляем на модерацию
  // igRepo.createJob не имеет поля contentType — используем стандартные поля
  const reelsCorrelationId = `ig_reels_${Date.now()}`;
  const jobId = await igRepo.createJob(chatId, {
    topic: topic.topic,
    caption: igText.caption,
    imagePrompt: igText.imagePrompt || '',
    imagePath: videoPath,
    imageAttempts: 0,
    status: 'ready',
    correlationId: reelsCorrelationId
  });

  const draft = {
    jobId,
    topic,
    caption: igText.caption,
    imagePath: videoPath,
    imagePrompt: igText.imagePrompt || '',
    correlationId: reelsCorrelationId
  };

  await sendIgToModerator(chatId, bot, draft);
  console.log(`[IG-REELS] ${chatId} draft ${jobId} sent to moderation`);
}
```

- [ ] **Step 3: Call `tickIgReelsSchedule` from the scheduler loop**

In the `startScheduler` function, find the interval block that calls `tickIgSchedule` (around line 749):

```js
await tickIgSchedule(chatId, entry.bot);
```

Add the Reels call immediately after:

```js
await tickIgSchedule(chatId, entry.bot);
await tickIgReelsSchedule(chatId, entry.bot);
```

- [ ] **Step 4: Run tests**

```bash
npm test
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add services/instagramMvp.service.js
git commit -m "feat: Instagram Reels scheduler uses content_topics via video pipeline"
```

---

## Task 8: Google Sheets import — parse `channel` column

**Files:**
- Modify: `services/telegramMvp.service.js` (`previewContentImport`, `importContentFromGoogleSheet`)

- [ ] **Step 1: Update `idx` block in `previewContentImport` (topics mode)**

In `previewContentImport` around line 500, find the `idx` object for topics mode:

```js
const idx = {
  topic: findHeaderIndex(header, ['тема', 'topic', 'title', 'subject']),
  focus: findHeaderIndex(header, ['фокусный ключ', 'focus', 'focus keyword', 'keyword']),
  secondary: findHeaderIndex(header, ['вторичные ключи', 'secondary', 'secondary keywords']),
  lsi: findHeaderIndex(header, ['lsi-ключи', 'lsi', 'lsi keywords']),
  status: findHeaderIndex(header, ['статус', 'status'])
};
```

Replace with:

```js
const idx = {
  topic: findHeaderIndex(header, ['тема', 'topic', 'title', 'subject']),
  focus: findHeaderIndex(header, ['фокусный ключ', 'focus', 'focus keyword', 'keyword']),
  secondary: findHeaderIndex(header, ['вторичные ключи', 'secondary', 'secondary keywords']),
  lsi: findHeaderIndex(header, ['lsi-ключи', 'lsi', 'lsi keywords']),
  status: findHeaderIndex(header, ['статус', 'status']),
  channel: findHeaderIndex(header, ['канал', 'channel'])
};
```

- [ ] **Step 2: Add `channel` field to the `preview.push(...)` call in topics mode**

Find the `preview.push({...})` call in topics mode (around line 526):

```js
preview.push({
  row: i + 1,
  topic,
  focus: idx.focus >= 0 ? String(row[idx.focus] || '').trim() : '',
  secondary: idx.secondary >= 0 ? String(row[idx.secondary] || '').trim() : '',
  lsi: idx.lsi >= 0 ? String(row[idx.lsi] || '').trim() : '',
  status: idx.status >= 0 ? normalizeStatusValue(row[idx.status], 'pending') : 'pending',
  duplicate
});
```

Replace with:

```js
preview.push({
  row: i + 1,
  topic,
  focus: idx.focus >= 0 ? String(row[idx.focus] || '').trim() : '',
  secondary: idx.secondary >= 0 ? String(row[idx.secondary] || '').trim() : '',
  lsi: idx.lsi >= 0 ? String(row[idx.lsi] || '').trim() : '',
  status: idx.status >= 0 ? normalizeStatusValue(row[idx.status], 'pending') : 'pending',
  channel: idx.channel >= 0 ? normalizeChannel(row[idx.channel]) : null,
  duplicate
});
```

- [ ] **Step 3: Pass `channel` when creating topics in `importContentFromGoogleSheet`**

In `importContentFromGoogleSheet` (around line 556), find the `repository.createTopic` call:

```js
await repository.createTopic(chatId, {
  topic: item.topic,
  focus: item.focus || null,
  secondary: item.secondary || null,
  lsi: item.lsi || null,
  status: item.status || 'pending'
});
```

Replace with:

```js
await repository.createTopic(chatId, {
  topic: item.topic,
  focus: item.focus || null,
  secondary: item.secondary || null,
  lsi: item.lsi || null,
  status: item.status || 'pending',
  channel: item.channel || null
});
```

- [ ] **Step 4: Verify `createTopic` in `repository.js` already accepts `channel`**

Open `services/content/repository.js` and find `createTopic` (around line 971). Confirm the INSERT already includes `channel`:

```js
`INSERT INTO content_topics (topic, focus, secondary, lsi, status, channel)
 VALUES ($1, $2, $3, $4, $5, $6)
 RETURNING ...`
```

If it doesn't include `channel` in the INSERT, add it:

```js
async function createTopic(chatId, data) {
  return withClient(chatId, async (client) => {
    const result = await client.query(
      `INSERT INTO content_topics (topic, focus, secondary, lsi, status, channel)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, topic, focus, secondary, lsi, status, channel, created_at, used_at`,
      [
        data.topic,
        data.focus || null,
        data.secondary || null,
        data.lsi || null,
        data.status || 'pending',
        data.channel || null
      ]
    );
    return result.rows[0];
  });
}
```

- [ ] **Step 5: Add import channel test to `tests/channel.topics.test.js`**

Open `tests/channel.topics.test.js` and add these tests after the existing `normalizeChannel` tests:

```js
console.log('\nnormalizeChannel — import values');

test('valid channel values from spreadsheet cells', () => {
  // Typical spreadsheet input: mixed case, spaces
  assert.strictEqual(normalizeChannel('VK'), 'vk');
  assert.strictEqual(normalizeChannel(' Instagram_Reels '), 'instagram_reels');
  assert.strictEqual(normalizeChannel('WORDPRESS'), 'wordpress');
  assert.strictEqual(normalizeChannel('Facebook'), 'facebook');
});

test('invalid/empty spreadsheet cells become null (universal)', () => {
  assert.strictEqual(normalizeChannel(''), null);
  assert.strictEqual(normalizeChannel('-'), null);
  assert.strictEqual(normalizeChannel('все каналы'), null);
});
```

- [ ] **Step 6: Run all tests**

```bash
npm test && node tests/channel.topics.test.js
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add services/telegramMvp.service.js services/content/repository.js tests/channel.topics.test.js
git commit -m "feat: Google Sheets import reads channel column and stores it in content_topics"
```

---

## Task 9: Add `channel.topics.test.js` to `npm test` suite

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add the test to the `test` script in `package.json`**

Find the `"test"` script in `package.json`:

```json
"test": "node tests/content.status.test.js && node tests/validators.extended.test.js && ... && node tests/inputImageContext.test.js"
```

Append `&& node tests/channel.topics.test.js` at the end:

```json
"test": "node tests/content.status.test.js && node tests/validators.extended.test.js && node tests/wordpress.publisher.test.js && node tests/blog.generator.test.js && node tests/blog.moderation.test.js && node tests/video.pipeline.test.js && node tests/inputImageContext.test.js && node tests/channel.topics.test.js"
```

- [ ] **Step 2: Run `npm test` to confirm the new test is included**

```bash
npm test
```

Expected: all tests pass, including `channel.topics.test.js`.

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "chore: add channel.topics.test.js to npm test suite"
```
