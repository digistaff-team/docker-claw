# Instagram Reels MVP — Design Spec
**Дата:** 2026-04-10  
**Статус:** Approved

---

## Контекст

Существующий `instagramMvp.service.js` публикует статические изображения 1:1 через Buffer API. Instagram Reels (вертикальное видео 9:16) — отдельный пайплайн. Видео берётся из общего `videoPipeline.service.js`, который уже используется YouTube Shorts и TikTok-ready архитектурой.

---

## Цель

Добавить публикацию Instagram Reels как равноправного участника видео-пайплайна: Reels потребляет общее видео через `claimVideo('instagram')`, генерирует caption+hashtags+audioPrompt через AI, публикует через Buffer API с поддержкой модерации через CW bot.

---

## Архитектура

### Новые файлы

| Файл | Назначение |
|------|-----------|
| `services/instagramReelsMvp.service.js` | Основной пайплайн Reels — зеркало `youtubeMvp.service.js` |
| `services/content/instagramReels.repository.js` | Таблицы `instagram_reels_jobs` + `instagram_reels_publish_logs` |

### Обновляемые файлы

| Файл | Изменение |
|------|-----------|
| `manage/store.js` | `getInstagramConfig` возвращает reels-поля; `setInstagramConfig` принимает патч |
| `manage/telegram/runner.js` | Регистрация `reels_mod:` callback + start/stop Reels scheduler |
| `manage/prompts.js` | Промпт `reels-copywriter` для генерации caption/hashtags/audioPrompt |
| `public/channels.html` | UI настроек Reels в панели Instagram |
| `services/content/index.js` | Экспорт `instagramReelsRepo` |
| `services/content/videoPipeline.repository.js` | Per-user CHANNELS (параметр `activeChannels`) |
| `services/videoPipeline.service.js` | Пробрасывает `activeChannels` из аргументов в repo-вызовы |

---

## Поток данных

```
Scheduler (60 сек) → tickReelsSchedule(chatId, bot)
  → проверить reels_enabled, время, день недели, дневной лимит
  → enqueue('reels_publish')

worker.registerJobHandler('reels_publish') → handleReelsGenerateJob()
  → reserveNextTopic()
  → generateReelsContent() → { caption, hashtags, audioPrompt }
  → claimVideo(chatId, 'instagram')
      ↳ нашли → использовать
      ↳ не нашли → generateVideo(chatId, 'instagram') → видео в пуле
  → createReelsJob() в instagram_reels_jobs
  → reels_auto_publish?
      ↳ да → publishReelsPost()
      ↳ нет → sendReelsToModerator() → CW bot

CW bot callback reels_mod:approve|rewrite|reject:{jobId}
  → approve → publishReelsPost()
  → rewrite → generateReelsContent() заново (до MAX_REJECT_ATTEMPTS)
  → reject  → status = 'failed'

publishReelsPost()
  → проверить существование видеофайла
  → videoUrl = APP_URL/api/video/temp/{chatId}/{filename}
  → text = caption + '\n\n' + hashtags
  → bufferService.createPost(apiKey, channelId, { text, videoUrl })
  → updateJob(status: 'published')
  → markVideoUsedById(chatId, videoId, 'instagram')  ← уже вызван через claimVideo
  → обновить статистику в instagramConfig
```

---

## Схема БД

### `instagram_reels_jobs`

```sql
CREATE TABLE IF NOT EXISTS instagram_reels_jobs (
  id               BIGSERIAL PRIMARY KEY,
  chat_id          TEXT NOT NULL,
  topic            TEXT NOT NULL,
  caption          TEXT,
  hashtags         TEXT,
  audio_prompt     TEXT,          -- хранится, не отправляется в API (задел на будущее)
  video_path       TEXT,          -- имя файла из video_assets
  video_asset_id   BIGINT,        -- ссылка на video_assets.id
  status           TEXT NOT NULL DEFAULT 'draft',
  -- draft | ready | approved | published | failed
  error_text       TEXT,
  rejected_count   INT NOT NULL DEFAULT 0,
  buffer_post_id   TEXT,
  correlation_id   TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### `instagram_reels_publish_logs`

```sql
CREATE TABLE IF NOT EXISTS instagram_reels_publish_logs (
  id              BIGSERIAL PRIMARY KEY,
  job_id          BIGINT REFERENCES instagram_reels_jobs(id) ON DELETE SET NULL,
  buffer_post_id  TEXT,
  method          TEXT NOT NULL DEFAULT 'buffer',
  status          TEXT NOT NULL DEFAULT 'published',
  error_text      TEXT,
  correlation_id  TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

---

## Конфигурация (расширение `instagramConfig`)

Новые поля (patch-совместимы, не ломают существующий конфиг):

```js
reels_enabled: false,
reels_schedule_time: '18:00',
reels_daily_limit: 2,
reels_auto_publish: false,          // false = модерация через CW bot
reels_publish_interval_hours: 8,
reels_allowed_weekdays: [0,1,2,3,4,5,6]
```

`buffer_api_key` и `buffer_channel_id` — общие с Instagram-изображениями (один Buffer-канал на аккаунт).

---

## Структура сервиса

```
getReelsSettings(chatId)
generateReelsContent(chatId, topic, materialsText, personaText)
  → returns { caption, hashtags, audioPrompt }

handleReelsGenerateJob(chatId, queueJob, bot, correlationId)
publishReelsPost(chatId, bot, jobId, correlationId)
sendReelsToModerator(chatId, bot, draft)
handleReelsModerationAction(chatId, bot, jobId, action)

tickReelsSchedule(chatId, bot)
startScheduler(getBots)
stopScheduler()
runNow(chatId, bot, reason)       -- ручной запуск
```

---

## Интеграция с видео-пайплайном

Instagram Reels входит в `CHANNELS` видео-пайплайна наравне с YouTube и TikTok.

**Проблема глобального CHANNELS:** если у пользователя `reels_enabled: false`, видео не будет удалено до получения метки 'instagram'. Это заблокирует cleanup.

**Решение:** `markVideoUsedById` и `getAvailableVideoForChannel` в `videoPipeline.repository.js` принимают необязательный параметр `activeChannels`. Если передан — используется он, иначе fallback на глобальный `VIDEO_CHANNELS`. Reels-сервис передаёт список только активных каналов пользователя при вызовах пайплайна.

```js
// getActiveVideoChannels — локальная функция в instagramReelsMvp.service.js
// (аналогичная должна быть в youtubeMvp.service.js при вызовах пайплайна)
function getActiveVideoChannels(chatId) {
  const channels = [];
  if (manageStore.getYoutubeConfig(chatId)?.is_active) channels.push('youtube');
  if (getReelsSettings(chatId).reelsEnabled) channels.push('instagram');
  // TikTok — добавить когда появится tiktokMvp.service.js
  return channels.length > 0 ? channels : ['youtube']; // fallback
}

await videoPipeline.claimVideo(chatId, 'instagram', { activeChannels: getActiveVideoChannels(chatId) });
```

---

## Обработка ошибок

| Сценарий | Поведение |
|----------|-----------|
| Видеофайл удалён до публикации | Проверка `fs.access` перед публикацией → `failed` + retry через `generateVideo` |
| Параллельная генерация | `videoPipeline` уже защищён in-memory локом → retry на следующем тике |
| Buffer API недоступен | Retry с backoff (уже в `bufferService.createPost`) |
| Превышен лимит `rejected_count` | Статус `failed`, тема возвращается в пул |
| `reels_enabled: false` | Scheduler не тикает, канал исключён из CHANNELS для этого пользователя |

---

## `audioPrompt` — хранение без отправки

Buffer API и KIE не поддерживают аудио для Reels. Поле сохраняется в `instagram_reels_jobs.audio_prompt` для будущей интеграции. В логах:
```
[REELS] audioPrompt stored but not sent to API (not yet supported)
```

---

## Модерация

Callback-паттерн в CW bot:
```
reels_mod:approve:{jobId}
reels_mod:rewrite:{jobId}
reels_mod:reject:{jobId}
```

Сообщение модератору содержит: тему, caption, hashtags, audioPrompt, статус видео (videoId). Кнопки: ✅ Опубликовать / 🔁 Переписать / ❌ Отклонить.

---

## UI (`public/channels.html`)

В панели Instagram добавить секцию «Instagram Reels»:
- Toggle `reels_enabled`
- `reels_schedule_time` (time picker)
- `reels_daily_limit` (number input)
- `reels_auto_publish` (toggle)
- `reels_publish_interval_hours` (number input)

---

## Итого

**Новых файлов:** 2  
**Обновлений:** 7  
**Зависимости:** `videoPipeline.service.js`, `bufferService`, CW bot, `instagram.repository.js` (паттерн), `store.js`
