# Instagram Buffer Migration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Перевести публикацию Instagram-постов с прямого Instagram Graph API на Buffer GraphQL API, удалить весь код прямого API, привести к единообразию с Pinterest.

**Architecture:** Публикация через `buffer.service.js` (GraphQL API). Изображения сохраняются на хост и отдаются через `/api/files/public/`. Модерация через CW Bot с callback-паттерном `ig_mod:`.

**Tech Stack:** Node.js, Express, Buffer GraphQL API, PostgreSQL, Telegraf

**Spec:** `docs/superpowers/specs/2026-04-09-instagram-buffer-migration-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `manage/store.js` | Modify | Instagram config: Buffer-поля вместо Graph API |
| `manage/routes.js` | Modify | Instagram API endpoints: Buffer-конфиг, test-buffer |
| `services/instagramMvp.service.js` | Modify | Публикация через Buffer, удаление прямого API |
| `services/content/instagram.repository.js` | Modify | Новая схема БД без полей прямого API |
| `server.js` | Modify | Полноценная модерация `ig_mod:` вместо заглушки |
| `services/instagram.service.js` | Delete | Прямой Graph API клиент больше не нужен |

---

### Task 1: Обновить `manage/store.js` — Instagram config

**Files:**
- Modify: `manage/store.js:600-624`

- [ ] **Step 1: Заменить `setInstagramConfig`**

Заменить текущую функцию `setInstagramConfig` (строки 600-624) на новую версию с Buffer-полями:

```js
function setInstagramConfig(chatId, patch = {}) {
    if (!statesCache[chatId]) statesCache[chatId] = {};
    const current = statesCache[chatId].instagramConfig || {};
    const next = { ...current };

    if (patch.buffer_api_key !== undefined) next.buffer_api_key = patch.buffer_api_key || null;
    if (patch.buffer_channel_id !== undefined) next.buffer_channel_id = String(patch.buffer_channel_id || '').trim() || null;
    if (patch.is_active !== undefined) next.is_active = !!patch.is_active;
    if (patch.auto_publish !== undefined) next.auto_publish = !!patch.auto_publish;
    if (patch.schedule_time !== undefined) next.schedule_time = patch.schedule_time || null;
    if (patch.schedule_tz !== undefined) next.schedule_tz = patch.schedule_tz || null;
    if (patch.daily_limit !== undefined) next.daily_limit = Math.min(Math.max(parseInt(patch.daily_limit, 10) || 3, 1), 25);
    if (patch.publish_interval_hours !== undefined) next.publish_interval_hours = parseFloat(patch.publish_interval_hours) || 4;
    if (patch.allowed_weekdays !== undefined && Array.isArray(patch.allowed_weekdays)) next.allowed_weekdays = patch.allowed_weekdays;
    if (patch.random_publish !== undefined) next.random_publish = !!patch.random_publish;
    if (patch.moderator_user_id !== undefined) next.moderator_user_id = String(patch.moderator_user_id || '').trim() || null;
    if (patch.stats !== undefined) next.stats = { ...(next.stats || {}), ...patch.stats };

    statesCache[chatId].instagramConfig = next;
    return persist(chatId);
}
```

- [ ] **Step 2: Verify no other references to removed fields**

Run:
```bash
grep -rn 'app_id\|app_secret\|fb_page_id\|fb_page_name\|ig_user_id\|ig_username\|default_alt_text\|location_id\|is_reel\|posting_hours' manage/store.js
```
Expected: No matches (all references removed).

- [ ] **Step 3: Commit**

```bash
git add manage/store.js
git commit -m "refactor(instagram): replace direct API config with Buffer fields in store"
```

---

### Task 2: Обновить `manage/routes.js` — Instagram endpoints

**Files:**
- Modify: `manage/routes.js:725-801`

- [ ] **Step 1: Заменить `GET /channels/instagram`** (строки 725-734)

```js
router.get('/channels/instagram', (req, res) => {
    const chatId = req.query.chat_id;
    if (!chatId) return res.status(400).json({ error: 'chat_id is required' });
    const config = manageStore.getInstagramConfig(chatId);
    if (!config) return res.json({ connected: false });
    const safe = { ...config };
    if (safe.buffer_api_key) safe.buffer_api_key = safe.buffer_api_key.slice(0, 6) + '***';
    res.json({ connected: true, config: safe });
});
```

- [ ] **Step 2: Заменить `POST /channels/instagram`** (строки 736-757)

```js
router.post('/channels/instagram', async (req, res) => {
    const chatId = req.body.chat_id;
    if (!chatId) return res.status(400).json({ error: 'chat_id is required' });
    try {
        const patch = {};
        const fields = [
            'buffer_api_key', 'buffer_channel_id',
            'is_active', 'auto_publish',
            'schedule_time', 'schedule_tz', 'daily_limit',
            'publish_interval_hours', 'allowed_weekdays',
            'random_publish', 'moderator_user_id'
        ];
        for (const f of fields) {
            if (req.body[f] !== undefined) patch[f] = req.body[f];
        }
        // Не перезаписывать замаскированный ключ
        if (patch.buffer_api_key && patch.buffer_api_key.endsWith('***')) {
            delete patch.buffer_api_key;
        }
        await manageStore.setInstagramConfig(chatId, patch);
        res.json({ success: true });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});
```

- [ ] **Step 3: Удалить `GET /channels/instagram/accounts`** (строки 770-801)

Удалить весь блок endpoint'а `router.get('/channels/instagram/accounts', ...)`.

- [ ] **Step 4: Добавить `POST /channels/instagram/test-buffer`**

Вставить после `DELETE /channels/instagram` (перед секцией VKontakte):

```js
router.post('/channels/instagram/test-buffer', async (req, res) => {
    const { chat_id: chatId, buffer_api_key, buffer_channel_id } = req.body;
    if (!chatId) return res.status(400).json({ error: 'chat_id is required' });
    if (!buffer_api_key || !buffer_channel_id) {
        return res.status(400).json({ error: 'buffer_api_key и buffer_channel_id обязательны' });
    }
    try {
        const bufferService = require('../services/buffer.service');
        const result = await bufferService.testConnection(buffer_api_key, buffer_channel_id);
        if (result.service !== 'instagram') {
            return res.status(400).json({ error: `Канал является ${result.service}, а не Instagram` });
        }
        res.json({ success: true, ...result });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});
```

- [ ] **Step 5: Commit**

```bash
git add manage/routes.js
git commit -m "refactor(instagram): update routes for Buffer-based config, add test-buffer endpoint"
```

---

### Task 3: Обновить `services/content/instagram.repository.js` — новая схема БД

**Files:**
- Modify: `services/content/instagram.repository.js`

- [ ] **Step 1: Обновить `ensureSchema`**

Заменить CREATE TABLE в `ensureSchema` на новую схему:

```js
async function ensureSchema(chatId) {
  return withClient(chatId, async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS instagram_jobs (
        id BIGSERIAL PRIMARY KEY,
        chat_id TEXT NOT NULL,
        topic TEXT NOT NULL,
        caption TEXT,
        image_prompt TEXT,
        image_path TEXT,
        status TEXT NOT NULL DEFAULT 'draft',
        error_text TEXT,
        image_attempts INT NOT NULL DEFAULT 0,
        rejected_count INT NOT NULL DEFAULT 0,
        buffer_post_id TEXT,
        correlation_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_instagram_jobs_status ON instagram_jobs(status, created_at)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS instagram_publish_logs (
        id BIGSERIAL PRIMARY KEY,
        job_id BIGINT REFERENCES instagram_jobs(id) ON DELETE SET NULL,
        buffer_post_id TEXT,
        method TEXT NOT NULL DEFAULT 'buffer',
        status TEXT NOT NULL,
        error_text TEXT,
        correlation_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
  });
}
```

- [ ] **Step 2: Обновить `createJob`**

```js
async function createJob(chatId, data) {
  return withClient(chatId, async (client) => {
    const result = await client.query(
      `INSERT INTO instagram_jobs
        (chat_id, topic, caption, image_prompt, image_path, status, image_attempts, correlation_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        chatId,
        data.topic,
        data.caption || null,
        data.imagePrompt || null,
        data.imagePath || null,
        data.status || 'draft',
        data.imageAttempts || 0,
        data.correlationId || null
      ]
    );
    return result.rows[0].id;
  });
}
```

- [ ] **Step 3: Обновить `updateJob`**

```js
async function updateJob(chatId, jobId, data) {
  return withClient(chatId, async (client) => {
    const fields = [];
    const values = [];
    let idx = 1;

    const map = {
      topic: 'topic', caption: 'caption',
      imagePrompt: 'image_prompt', imagePath: 'image_path',
      status: 'status', errorText: 'error_text',
      imageAttempts: 'image_attempts', rejectedCount: 'rejected_count',
      bufferPostId: 'buffer_post_id', correlationId: 'correlation_id'
    };

    for (const [jsKey, dbCol] of Object.entries(map)) {
      if (data[jsKey] !== undefined) {
        fields.push(`${dbCol} = $${idx++}`);
        values.push(data[jsKey]);
      }
    }

    if (fields.length === 0) return;

    fields.push('updated_at = NOW()');
    values.push(jobId);

    await client.query(
      `UPDATE instagram_jobs SET ${fields.join(', ')} WHERE id = $${idx}`,
      values
    );
  });
}
```

- [ ] **Step 4: Обновить `addPublishLog`**

```js
async function addPublishLog(chatId, data) {
  return withClient(chatId, async (client) => {
    const result = await client.query(
      `INSERT INTO instagram_publish_logs
        (job_id, buffer_post_id, method, status, error_text, correlation_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        data.jobId || null,
        data.bufferPostId || null,
        data.method || 'buffer',
        data.status,
        data.errorText || null,
        data.correlationId || null
      ]
    );
    return result.rows[0].id;
  });
}
```

- [ ] **Step 5: Commit**

```bash
git add services/content/instagram.repository.js
git commit -m "refactor(instagram): update repository schema for Buffer-based publishing"
```

---

### Task 4: Переписать `services/instagramMvp.service.js` — публикация через Buffer

**Files:**
- Modify: `services/instagramMvp.service.js`

- [ ] **Step 1: Обновить импорты** (строки 1-26)

Заменить блок импортов:

```js
/**
 * Instagram MVP Service — генерация, модерация, публикация Instagram-постов
 * Публикация через Buffer GraphQL API (аналогично Pinterest)
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
const imageService = require('./image.service');
const bufferService = require('./buffer.service');
const igRepo = require('./content/instagram.repository');

const contentModules = require('./content/index');
const {
  generateCorrelationId,
  repository,
  queueRepo,
  worker
} = contentModules;
```

Удалено: `instagramService`. Добавлено: `bufferService`, `imageService`.

- [ ] **Step 2: Переписать `getIgSettings`** (строки 65-86)

```js
function getIgSettings(chatId) {
  const cfg = manageStore.getInstagramConfig(chatId);
  return {
    isActive: !!cfg?.is_active,
    bufferApiKey: cfg?.buffer_api_key || null,
    bufferChannelId: cfg?.buffer_channel_id || null,
    scheduleTime: cfg?.schedule_time || '10:00',
    scheduleTz: isValidTz(cfg?.schedule_tz) ? cfg.schedule_tz : SCHEDULE_TZ,
    dailyLimit: cfg?.daily_limit || DAILY_IG_LIMIT,
    publishIntervalHours: Number.isFinite(cfg?.publish_interval_hours) ? cfg.publish_interval_hours : 4,
    randomPublish: !!cfg?.random_publish,
    premoderationEnabled: cfg?.auto_publish === true ? false : true,
    allowedWeekdays: Array.isArray(cfg?.allowed_weekdays) ? cfg.allowed_weekdays : [0, 1, 2, 3, 4, 5, 6],
    moderator_user_id: cfg?.moderator_user_id || null,
    stats: cfg?.stats || { total_posts: 0, posts_today: 0, last_post_date: null }
  };
}
```

- [ ] **Step 3: Упростить `generateIgPostText`** (строки 129-178)

Убрать `hookText` из промпта и возвращаемого значения:

```js
async function generateIgPostText(chatId, topic, materialsText, personaText) {
  const data = manageStore.getState(chatId);
  const hasApiKey = data?.aiCustomApiKey || data?.aiAuthToken;
  if (!hasApiKey || !data?.aiModel) {
    throw new Error('AI model is not configured');
  }

  const prompt = `Ты SMM-маркетолог Instagram. Создай контент для поста в Instagram.

Тема: ${topic.topic}
${topic.focus ? `Фокус: ${topic.focus}` : ''}

${personaText ? `--- ПЕРСОНА ---\n${personaText}\n---` : ''}
${materialsText ? `--- МАТЕРИАЛЫ ---\n${materialsText}\n---` : ''}

Ответь строго в формате JSON:
{
  "caption": "подпись к посту для Instagram (150–2200 символов, вовлекающая, с хэштегами в конце)",
  "imagePrompt": "промпт для генерации изображения на английском (стиль: яркий, Instagram-формат, без текста)"
}

Требования:
- caption: 300–500 символов оптимально, первая строка — хук (цепляет внимание), 5–15 хэштегов в конце, эмодзи как маркеры (2–4), CTA в конце
- imagePrompt: на английском, описание визуала, Instagram-стиль (яркий, квадратный формат 1:1), без текста на изображении
- Стиль: живой, разговорный, без канцелярита
- Язык: русский (кроме imagePrompt)`;

  const messages = [
    { role: 'system', content: 'Ты SMM-маркетолог Instagram. Отвечай только JSON.' },
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
    caption: String(parsed.caption || '').slice(0, 2200),
    imagePrompt: String(parsed.imagePrompt || '').slice(0, 800)
  };
}
```

- [ ] **Step 4: Удалить `uploadImageForInstagram`** (строки 254-279)

Удалить всю функцию `uploadImageForInstagram`.

- [ ] **Step 5: Переписать `publishIgPost`** (строки 440-520)

```js
async function publishIgPost(chatId, bot, jobId, correlationId) {
  const corrId = correlationId || generateCorrelationId();
  const job = await igRepo.getJobById(chatId, jobId);
  if (!job) throw new Error(`Instagram job ${jobId} not found`);

  const cfg = manageStore.getInstagramConfig(chatId);
  if (!cfg) throw new Error('Instagram не настроен');

  if (!cfg.buffer_api_key || !cfg.buffer_channel_id) {
    throw new Error('Buffer API key или channel_id не настроены для Instagram');
  }

  // Копируем изображение из контейнера на хост
  const session = await sessionService.getOrCreateSession(chatId);
  const tempPath = path.join(os.tmpdir(), `ig-publish-${chatId}-${jobId}.png`);
  await dockerService.copyFromContainer(session.containerId, job.image_path, tempPath);

  let imageBuffer = await fs.readFile(tempPath);
  await fs.unlink(tempPath).catch(() => {});

  // Водяной знак (опционально)
  const logoPath = '/workspace/brand/logo.png';
  const logoLocalPath = path.join(os.tmpdir(), `ig-logo-${chatId}.png`);
  try {
    await dockerService.copyFromContainer(session.containerId, logoPath, logoLocalPath);
    imageBuffer = await imageService.overlayWatermark(imageBuffer, logoLocalPath);
    await fs.unlink(logoLocalPath).catch(() => {});
  } catch (e) {
    console.log(`[IG-MVP] Watermark skipped: ${e.message}`);
  }

  // Сохраняем на хост для публичного доступа
  const hostDir = path.join(storageService.getDataDir(chatId), 'output', 'content');
  await fs.mkdir(hostDir, { recursive: true });
  await fs.writeFile(path.join(hostDir, `ig_${jobId}.png`), imageBuffer);

  // Публикация через Buffer
  const imageUrl = `${config.APP_URL}/api/files/public/${chatId}/ig_${jobId}.png`;
  let text = String(job.caption || '').slice(0, 2200);

  const bufferResult = await bufferService.createPost(cfg.buffer_api_key, cfg.buffer_channel_id, { text, imageUrl });
  console.log(`[IG-MVP] Published via Buffer, postId=${bufferResult.postId}`);

  // Запись в лог
  await igRepo.addPublishLog(chatId, {
    jobId,
    bufferPostId: bufferResult.postId,
    method: 'buffer',
    status: 'published',
    correlationId: corrId
  });

  // Обновить статус job
  await igRepo.updateJob(chatId, jobId, {
    status: 'published',
    bufferPostId: bufferResult.postId
  });

  // Обновить статистику
  const stats = cfg.stats || {};
  const today = getNowInTz(SCHEDULE_TZ).date;
  const postsToday = stats.last_post_date === today ? (stats.posts_today || 0) + 1 : 1;
  await manageStore.setInstagramConfig(chatId, {
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
    const msg = `📷 Instagram пост опубликован через Buffer!\n${text.slice(0, 100)}...`;
    await bot.telegram.sendMessage(chatId, msg).catch(() => {});
  }

  return { postId: bufferResult.postId };
}
```

- [ ] **Step 6: Обновить `handleIgGenerateJob`** (строки 314-434)

Убрать hookText из draft и createJob. Заменить:

В вызове `createJob` (строки 400-411) убрать поля `igUserId`, `hookText`, `igContentType`:
```js
  const jobId = await igRepo.createJob(chatId, {
    topic: topic.topic,
    caption: igText.caption,
    imagePrompt: igText.imagePrompt,
    imagePath,
    status: 'ready',
    imageAttempts,
    correlationId
  });
```

В объекте `draft` (строки 413-423) убрать `igUserId`, `hookText`:
```js
  const draft = {
    jobId,
    topic,
    caption: igText.caption,
    imagePrompt: igText.imagePrompt,
    imagePath,
    correlationId,
    rejectedCount: 0
  };
```

- [ ] **Step 7: Обновить `sendIgToModerator`** (строки 526-583)

Убрать hookText из caption:

```js
async function sendIgToModerator(chatId, bot, draft) {
  const igSettings = getIgSettings(chatId);
  const globalSettings = manageStore.getContentSettings?.(chatId);
  
  const moderatorId = igSettings?.moderator_user_id || 
                      globalSettings?.moderatorUserId || 
                      chatId;

  const caption = [
    `📷 Черновик для Instagram #${draft.jobId}`,
    '',
    (draft.caption || '').slice(0, 800),
    '',
    draft.correlationId ? `📋 ${draft.correlationId}` : ''
  ].filter(Boolean).join('\n').slice(0, 1024);

  const callbackBase = `ig_mod:${draft.jobId}`;
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
    const tempPath = path.join(os.tmpdir(), `ig-mod-${chatId}-${draft.jobId}.png`);
    await dockerService.copyFromContainer(session.containerId, draft.imagePath, tempPath);
    
    const moderatorBot = cwBot && cwBot.token !== bot?.token ? cwBot : bot;
    const sent = await moderatorBot.telegram.sendPhoto(moderatorId, { source: tempPath }, { caption, reply_markup: kb });
    await fs.unlink(tempPath).catch(() => {});

    await setDraft(chatId, String(draft.jobId), {
      ...draft,
      moderationMessageId: sent.message_id
    });
  } else {
    const moderatorBot = cwBot && cwBot.token !== bot?.token ? cwBot : bot;
    const sent = await moderatorBot.telegram.sendMessage(moderatorId, caption, { reply_markup: kb });
    await setDraft(chatId, String(draft.jobId), {
      ...draft,
      moderationMessageId: sent.message_id
    });
  }
}
```

- [ ] **Step 8: Обновить `handleInstagramModerationAction`** (строки 585-681)

В action `regen_text` убрать hookText:

```js
  if (action === 'regen_text') {
    try {
      const [materialsText, personaText] = await Promise.all([
        loadMaterialsText(chatId, 12),
        loadUserPersona(chatId)
      ]);
      const igText = await generateIgPostText(chatId, draft.topic, materialsText, personaText);
      draft.caption = igText.caption;
      draft.imagePrompt = igText.imagePrompt;
      await igRepo.updateJob(chatId, jobId, {
        caption: igText.caption,
        imagePrompt: igText.imagePrompt
      });
      await sendIgToModerator(chatId, bot, draft);
      return { ok: true, message: 'Текст Instagram-поста перегенерирован.' };
    } catch (e) {
      return { ok: false, message: `Ошибка перегенерации текста: ${e.message}` };
    }
  }
```

В action `reject` (полная перегенерация) аналогично убрать hookText:

```js
      const igText = await generateIgPostText(chatId, draft.topic, materialsText, personaText);
      const imageBuffer = await generateIgImage(draft.topic, igText.imagePrompt);
      const imagePath = await saveImageToContainer(chatId, imageBuffer, `${jobId}_reject_${Date.now()}`);

      draft.caption = igText.caption;
      draft.imagePrompt = igText.imagePrompt;
      draft.imagePath = imagePath;

      await igRepo.updateJob(chatId, jobId, {
        caption: igText.caption,
        imagePrompt: igText.imagePrompt,
        imagePath,
        rejectedCount: draft.rejectedCount
      });
```

- [ ] **Step 9: Обновить exports** (строки 883-897)

Убираем `handleInstagramModerationAction` → переименовываем: было `handleInstagramModerationAction`, оставляем как есть (уже экспортируется). Проверяем что `handleIgModerationAction` нигде не вызывается с другим именем.

Exports не меняются — все нужные функции уже экспортируются.

- [ ] **Step 10: Commit**

```bash
git add services/instagramMvp.service.js
git commit -m "refactor(instagram): switch publishing to Buffer API, remove direct Graph API"
```

---

### Task 5: Заменить заглушку модерации в `server.js`

**Files:**
- Modify: `server.js:358-365`

- [ ] **Step 1: Заменить callback `ig_mod:`**

Заменить строки 358-365:

```js
        // Instagram moderation callbacks for CW_BOT_TOKEN users
        cwBot.action(/^ig_mod:(\d+):(approve|reject|regen_text|regen_image)$/, async (ctx) => {
            const fromId = String(ctx.from?.id || '');
            const jobId = Number(ctx.match?.[1]);
            const action = ctx.match?.[2];
            console.log(`[CW-BOT-IG] ${action} job ${jobId} (fromId=${fromId})`);
            await ctx.answerCbQuery('В разработке').catch(() => {});
        });
```

На полноценную обработку:

```js
        // Instagram moderation callbacks for CW_BOT_TOKEN users
        cwBot.action(/^ig_mod:(\d+):(approve|reject|regen_text|regen_image)$/, async (ctx) => {
            const fromId = String(ctx.from?.id || '');
            const jobId = Number(ctx.match?.[1]);
            const action = ctx.match?.[2];

            console.log(`[CW-BOT-IG] ${action} job ${jobId} (fromId=${fromId})`);

            // Находим chatId по черновику
            let resolvedChatId = null;
            const allStatesIg = manageStore.getAllStates();
            for (const [cid, data] of Object.entries(allStatesIg)) {
                const drafts = data.igDrafts || {};
                if (!drafts[String(jobId)]) continue;

                const igConfig = manageStore.getInstagramConfig?.(cid) || {};
                const globalSettings = data.contentSettings || {};
                const channelModeratorId = igConfig.moderator_user_id ||
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
                const result = await instagramMvpService.handleInstagramModerationAction(resolvedChatId, { telegram: ctx.telegram }, jobId, action);
                await ctx.answerCbQuery(result?.ok ? 'Готово' : 'Ошибка').catch(() => {});
                await ctx.reply(result?.message || 'Операция выполнена.').catch(() => {});
            } catch (e) {
                console.error(`[CW-BOT-IG] Error:`, e);
                await ctx.answerCbQuery('Ошибка').catch(() => {});
                await ctx.reply(`Ошибка модерации Instagram: ${e.message}`).catch(() => {});
            }
        });
```

- [ ] **Step 2: Проверить что `instagramMvpService` уже импортирован в `server.js`**

Run:
```bash
grep -n 'instagramMvpService' server.js | head -5
```
Expected: Должен быть `require('./services/instagramMvp.service')` в блоке инициализации (строка ~516).

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat(instagram): implement full moderation via CW Bot, replace stub"
```

---

### Task 6: Удалить `services/instagram.service.js`

**Files:**
- Delete: `services/instagram.service.js`

- [ ] **Step 1: Проверить что файл больше нигде не импортируется**

Run:
```bash
grep -rn "require.*instagram\.service" --include="*.js" .
```
Expected: Нет совпадений (после Task 4 импорт уже удалён из `instagramMvp.service.js`).

- [ ] **Step 2: Удалить файл**

```bash
rm services/instagram.service.js
```

- [ ] **Step 3: Commit**

```bash
git add services/instagram.service.js
git commit -m "chore(instagram): remove direct Instagram Graph API client"
```

---

### Task 7: Проверка и финальный тест

- [ ] **Step 1: Запустить существующие тесты**

```bash
npm test
```
Expected: Все тесты проходят (Instagram-тестов в `npm test` нет, но убеждаемся что ничего не сломано).

- [ ] **Step 2: Проверить отсутствие мёртвых ссылок на удалённые поля**

```bash
grep -rn 'ig_user_id\|ig_username\|ig_content_type\|ig_media_id\|hook_text\|hookText\|instagramService\|instagram\.service' --include="*.js" services/ manage/ server.js
```
Expected: Нет совпадений.

- [ ] **Step 3: Проверить запуск сервера**

```bash
timeout 10 node server.js 2>&1 || true
```
Expected: Сервер стартует без ошибок (будет timeout через 10 секунд — это нормально).

- [ ] **Step 4: Commit (если были финальные правки)**

```bash
git add -A
git commit -m "chore(instagram): final cleanup after Buffer migration"
```
