# Спецификация: Видео-пайплайн

**Версия:** 1.0  
**Дата:** 2026-04-11  
**Статус:** Утверждена  
**Каналы:** YouTube Shorts, TikTok, Instagram Reels, VK Video

---

## Содержание

1. [Обзор и архитектура](#1-обзор-и-архитектура)
2. [БД — таблицы и схема](#2-бд--таблицы-и-схема)
3. [Core Pipeline (KIE.ai)](#3-core-pipeline-kieai)
4. [Каналы](#4-каналы)
5. [API эндпоинты](#5-api-эндпоинты)
6. [Хранение и Cleanup](#6-хранение-и-cleanup)
7. [Web UI](#7-web-ui)
8. [Тесты](#8-тесты)
9. [ENV переменные](#9-env-переменные)
10. [Критичные пробелы](#10-критичные-пробелы)

---

## 1. Обзор и архитектура

**Назначение:** Общий видео-пайплайн генерирует вертикальные видео (9:16) из фото товаров и публикует их в четыре канала: YouTube Shorts, TikTok, Instagram Reels, VK Video. Один сгенерированный ролик используется всеми четырьмя каналами, после чего удаляется.

### Машина состояний видео

```
pending → scene_generating → scene_ready → video_generating → video_ready → published → expired
                                                                          ↘ failed
```

| Статус | Описание |
|--------|----------|
| `pending` | Запись создана, ожидает обработки |
| `scene_generating` | KIE.ai генерирует сцену (image-to-image) |
| `scene_ready` | PNG сцены сохранён |
| `video_generating` | KIE.ai генерирует видео (image-to-video) |
| `video_ready` | MP4 сохранён, доступен для каналов |
| `published` | Все каналы использовали, запланировано удаление |
| `expired` | Удалено cleanup scheduler'ом |
| `failed` | Ошибка на любом этапе |

### Поток данных

```
/workspace/input (фото товаров)
         ↓
  [случайный выбор]
         ↓
  interiors (БД) → случайный интерьер
         ↓
  KIE.ai Image API → сцена (1080×1920 PNG)
         ↓
  KIE.ai Video API (Veo 3.1 / Seedance 2.0 / Grok Imagine) → видео (MP4, ~8 сек, 9:16)
         ↓
  VIDEO_TEMP_ROOT/{chatId}/video_{id}.mp4
         ↓
  ┌──────────────────────────────────────┐
  │  YouTube   ← claimVideo()            │  → Buffer API  → YouTube Shorts
  │  TikTok    ← claimVideo()            │  → Buffer API  → TikTok
  │  Instagram ← claimVideo()            │  → Buffer API  → Instagram Reels
  │  VK        ← claimVideo()            │  → VK API      → VK Видео
  └──────────────────────────────────────┘
         ↓ (все четыре использовали)
  scheduled_deletion_at = NOW() + 60 мин
         ↓
  cleanup scheduler → удаление файлов + записей БД
```

### Ключевые принципы

- In-memory `Set generatingLocks` — один активный процесс генерации на `chatId`
- `SELECT FOR UPDATE SKIP LOCKED` в `getAvailableVideoForChannel` — защита от race condition
- Каналы независимы: каждый забирает видео по своему расписанию
- Один ролик используется всеми каналами — экономия на генерации

---

## 2. БД — таблицы и схема

Все три таблицы создаются в per-user PostgreSQL (`db_{chatId}`) через `ensureSchema(chatId)`.

### `interiors` — банк интерьеров

```sql
CREATE TABLE IF NOT EXISTS interiors (
  id          BIGSERIAL PRIMARY KEY,
  chat_id     TEXT NOT NULL,
  description TEXT NOT NULL,       -- "просторная гостиная с панорамными окнами"
  style       VARCHAR(100),        -- "modern", "loft", "scandinavian"
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_interiors_chat       ON interiors(chat_id);
CREATE INDEX IF NOT EXISTS idx_interiors_chat_style ON interiors(chat_id, style);
```

### `video_assets` — сгенерированные видео

```sql
CREATE TABLE IF NOT EXISTS video_assets (
  id                     BIGSERIAL PRIMARY KEY,
  chat_id                TEXT NOT NULL,
  product_image_path     TEXT NOT NULL,
  interior_id            BIGINT,
  scene_image_path       TEXT,
  video_path             TEXT,
  status                 TEXT NOT NULL DEFAULT 'pending',
  provider               TEXT DEFAULT 'kie-veo3.1',
  video_duration         INT,
  file_size              BIGINT,
  correlation_id         TEXT,
  initiating_channel     TEXT,
  error_text             TEXT,
  all_channels_marked_at TIMESTAMPTZ,
  scheduled_deletion_at  TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT video_assets_status_check CHECK (
    status IN ('pending','scene_generating','scene_ready',
               'video_generating','video_ready','published','expired','failed')
  ),
  CONSTRAINT video_assets_channel_check CHECK (
    initiating_channel IN ('youtube','tiktok','instagram','vk')  -- +vk
  )
);

CREATE INDEX IF NOT EXISTS idx_video_assets_chat_status ON video_assets(chat_id, status);
CREATE INDEX IF NOT EXISTS idx_video_assets_deletion    ON video_assets(scheduled_deletion_at)
  WHERE scheduled_deletion_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_video_assets_chat_created ON video_assets(chat_id, created_at DESC);
```

### `video_channel_usage` — метки использования

```sql
CREATE TABLE IF NOT EXISTS video_channel_usage (
  id           BIGSERIAL PRIMARY KEY,
  video_id     BIGINT,
  channel_type TEXT NOT NULL,
  used_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT video_channel_usage_unique        UNIQUE(video_id, channel_type),
  CONSTRAINT video_channel_usage_channel_check CHECK (
    channel_type IN ('youtube','tiktok','instagram','vk')  -- +vk
  )
);

CREATE INDEX IF NOT EXISTS idx_video_channel_usage_video   ON video_channel_usage(video_id);
CREATE INDEX IF NOT EXISTS idx_video_channel_usage_channel ON video_channel_usage(channel_type);
```

### Константа CHANNELS

```js
// services/content/videoPipeline.repository.js
const CHANNELS = (process.env.VIDEO_CHANNELS || 'youtube,tiktok,instagram,vk')
  .split(',').map(s => s.trim().toLowerCase());
// Ожидаемое значение: ['youtube', 'tiktok', 'instagram', 'vk']
```

**Состояние:** реализовано для 3 каналов.  
**Пробел (критично):** добавить `'vk'` в оба CHECK constraint. Требует новой SQL-миграции.

---

## 3. Core Pipeline (KIE.ai)

Файл: `services/videoPipeline.service.js`

### Шаг 1 — Выбор исходных данных

- `getRandomProductImage(chatId)` — случайный файл из `/workspace/input` (jpg/jpeg/png/webp)
- `getRandomInterior(chatId)` — случайная запись из `interiors` через `ORDER BY RANDOM()`
- Ранний выход без создания записи в БД если: нет изображений или нет интерьеров

### Шаг 2 — Генерация сцены (image-to-image)

- AI-роутер улучшает промпт (до 500 символов) по имени файла + стилю интерьера
- `POST https://api.kie.ai/api/v1/image/generate` с `imageUrls: [productPublicUrl]`
- Публичный URL товара: `{APP_URL}/api/video/input/{chatId}/{filename}`
- Polling: каждые 3 сек, максимум 30 попыток
- Результат: PNG 1080×1920, `scene_{corrId}_{attempt}.png`
- До 3 попыток при ошибке, задержка 2/4/6 сек

### Шаг 3 — Генерация видео (image-to-video)

Выбор адаптера определяется per-user настройкой модели (хранится в `manageStore`), с fallback на `VIDEO_MODEL` из ENV.

#### Адаптер: Veo 3.1 (существующий)

```
POST /api/v1/veo/generate
  model: "veo3.1"
  generationType: "IMAGE_2_VIDEO"
  imageUrls: [scenePublicUrl]
  aspect_ratio: "9:16"

Polling: GET /api/v1/veo/get-1080p-video?taskId=...&index=0
  → data.resultUrl при code 200
```

#### Адаптер: Seedance 2.0 (требует реализации)

```
POST /api/v1/jobs/createTask
  model: "bytedance/seedance-2"
  first_frame_url: scenePublicUrl
  aspect_ratio: "9:16"
  duration: 8
  resolution: "720p"
  generate_audio: true

Polling: GET /api/v1/jobs/recordInfo?taskId=...
  → resultJson.resultUrls[0] при status "success"
```

Статусы polling: `waiting` → `queuing` → `generating` → `success` / `fail`

#### Адаптер: Grok Imagine (требует реализации)

```
POST /api/v1/jobs/createTask
  model: "grok-imagine/image-to-video"
  input:
    image_urls: [scenePublicUrl]
    aspect_ratio: "9:16"
    duration: 8
    resolution: "720p"

Polling: GET /api/v1/jobs/recordInfo?taskId=...
  → resultJson.resultUrls[0] при status "success"
```

#### Архитектура адаптеров

```js
generateVideoFromScene(chatId, sceneImagePath, model)
  ├── 'veo3.1'                 → createVeoTask()  + pollVeo()
  ├── 'bytedance/seedance-2'   → createJobsTask() + pollJobs()
  └── 'grok-imagine/image-to-video' → createJobsTask() + pollJobs()
```

`createJobsTask()` и `pollJobs()` — общие для Seedance и Grok, отличается только тело запроса.

### Коды ошибок KIE.ai

| Код | Значение |
|-----|----------|
| 402 | Недостаточно кредитов |
| 422 | Ошибка валидации |
| 429 | Rate limit |
| 500/501 | Генерация провалилась |

### ENV для pipeline

| Переменная | Default | Описание |
|------------|---------|----------|
| `VIDEO_POLL_INTERVAL_SEC` | `25` | Интервал polling (сек) |
| `VIDEO_TIMEOUT_SEC` | `600` | Таймаут генерации (сек) |
| `VIDEO_MODEL` | `veo3.1` | Дефолтная модель |

**Состояние:** реализован только адаптер Veo 3.1.  
**Пробел (критично):** добавить адаптеры Seedance 2.0 и Grok Imagine, рефакторинг `generateVideoFromScene`.

---

## 4. Каналы

### Общая схема для всех каналов

```
claimVideo(chatId, channel) → если нет → generateVideo(chatId, channel)
         ↓
generateContent() — AI генерирует текст/хештеги
         ↓
sendToModerator() или autoPublish()
         ↓
publishPost() → Buffer API / VK API
         ↓
markVideoUsed(chatId, videoId, channel)
```

### YouTube Shorts

- **Файл:** `services/youtubeMvp.service.js`
- **Публикация:** Buffer API
- **Модерация:** CW Bot, callback `yt_mod:approve|rewrite|reject:{postId}`
- **Лимит:** `YOUTUBE_DAILY_LIMIT` (default 5)
- **Состояние:** реализовано полностью, интегрировано с пайплайном
- **Пробелов нет**

### TikTok

- **Файл:** `services/tiktokMvp.service.js`
- **Публикация:** Buffer API
- **Модерация:** CW Bot, callback `tt_mod:{jobId}:approve|reject|regen_text`
- **Лимит:** `TIKTOK_DAILY_LIMIT` (default 3)

**Пробелы (критично):**

| # | Проблема | Решение |
|---|----------|---------|
| 1 | `publishTiktokPost` — только `console.log` | Вызвать `bufferService.createPost(chatId, {type:'video', videoPath, caption, hashtags})` |
| 2 | `publishedToday = 0` захардкожено | Считать `COUNT(*)` из `video_channel_usage` WHERE `channel_type='tiktok'` AND `used_at::date = CURRENT_DATE` |

### Instagram Reels

- **Файл:** `services/instagramMvp.service.js`
- **Публикация:** Buffer API
- **Модерация:** CW Bot, callback `ig_mod:{jobId}:approve|reject|regen_text`
- **Лимит:** `INSTAGRAM_VIDEO_DAILY_LIMIT` (default 3)

**Пробелы (критично):**

| # | Проблема | Решение |
|---|----------|---------|
| 1 | Нет интеграции с видеопайплайном | Добавить видео-ветку: `claimVideo` → `generateVideo` → модерация |
| 2 | Обработчик `ig_mod:` — заглушка | Реализовать по аналогии с `tt_mod:` |
| 3 | Нет счётчика дневного лимита | Считать из `video_channel_usage` как в TikTok |

### VK Video

- **Файл:** `services/vkVideoMvp.service.js` — **не существует**
- **Публикация:** VK API напрямую (не Buffer)
- **Модерация:** CW Bot, callback `vk_vid_mod:{jobId}:approve|reject|regen_text`
- **Лимит:** `VK_VIDEO_DAILY_LIMIT` (default 3)

**VK Video API — последовательность публикации:**

```
1. POST /video.save
   params: name, description, group_id (если публикуем в группу)
   → { upload_url, video_id, owner_id }

2. PUT {upload_url}
   Content-Type: multipart/form-data
   body: файл MP4
   → подтверждение загрузки

3. POST /wall.post
   params: owner_id, message, attachments=video{owner_id}_{video_id}
   → { post_id }
```

**Что нужно создать:**

| # | Компонент | Описание |
|---|-----------|----------|
| 1 | `vkVideoMvp.service.js` | По структуре `tiktokMvp.service.js` |
| 2 | `handleVkVideoGenerateJob` | claimVideo → generateContent → moderator/auto |
| 3 | `publishVkVideoPost` | video.save → upload → wall.post |
| 4 | `handleVkVideoModerationAction` | approve / reject / regen_text |
| 5 | Регистрация `vk_vid_mod:` в CW Bot | `manage/telegram/runner.js` |

---

## 5. API эндпоинты

Файл: `routes/video.routes.js`. Префикс: `/api/video`.  
Аутентификация: `chat_id` через `sessionService` middleware.

### Существующие

| Метод | Путь | Описание |
|-------|------|----------|
| `POST` | `/generate` | Запустить генерацию видео |
| `GET` | `/assets/:videoId` | Получить видео по ID |
| `GET` | `/assets` | Список видео (фильтр `?status=`) |
| `GET` | `/stats` | Статистика по статусам |
| `POST` | `/claim` | Канал забирает доступное видео |
| `GET` | `/pipeline-status` | Полный статус пайплайна |
| `GET` | `/input/:chatId/:filename` | Файл из `/workspace/input` (для KIE.ai) |
| `GET` | `/temp/:chatId/:filename` | Файл из `VIDEO_TEMP_ROOT` (для KIE.ai) |
| `GET` | `/interiors` | Список интерьеров |
| `POST` | `/interiors` | Добавить интерьер |
| `DELETE` | `/interiors/:id` | Удалить интерьер |

### Недостающие (критично)

| Метод | Путь | Описание |
|-------|------|----------|
| `GET` | `/config` | Получить настройки пайплайна |
| `POST` | `/config` | Обновить настройки |

**`POST /config` — тело запроса:**
```json
{
  "videoModel": "bytedance/seedance-2",
  "channels": ["youtube", "tiktok", "instagram", "vk"],
  "deletionDelayMin": 60
}
```

**`POST /generate` — тело запроса:**
```json
{
  "chat_id": "123456",
  "channel": "youtube"
}
```
Ответ: `{ success, videoId, correlationId, error }`

**`POST /claim` — тело запроса:**
```json
{
  "chat_id": "123456",
  "channel": "tiktok"
}
```
Ответ: `{ success, videoId, videoPath, allChannelsUsed, remainingChannels, needsGeneration }`

---

## 6. Хранение и Cleanup

### Файловая структура

```
VIDEO_TEMP_ROOT/                          # default: {DATA_ROOT}/.video-temp
└── {chatId}/
    ├── scene_{corrId}_{attempt}.png      # временная сцена
    └── video_{videoId}.mp4               # итоговое видео
```

### Жизненный цикл файлов

```
Генерация → файлы созданы
     ↓
Все 4 канала использовали видео
     ↓
all_channels_marked_at = NOW()
scheduled_deletion_at  = NOW() + VIDEO_DELETION_DELAY_MIN
     ↓
Cleanup scheduler (каждые VIDEO_CLEANUP_INTERVAL_MS)
  → getExpiredVideosForChat(chatId)  [scheduled_deletion_at < NOW()]
     ↓
fs.unlink(video_path) + fs.unlink(scene_image_path)
     ↓
markVideoExpired() → status = 'expired'
deleteVideoAsset() → удаление записи
```

### ENV

| Переменная | Default | Описание |
|------------|---------|----------|
| `VIDEO_TEMP_ROOT` | `{DATA_ROOT}/.video-temp` | Корень временного хранилища |
| `VIDEO_CLEANUP_INTERVAL_MS` | `300000` | Интервал cleanup (мс) |
| `VIDEO_DELETION_DELAY_MIN` | `60` | Задержка удаления (мин) |

**Состояние:** реализовано полностью.  
**Примечание:** после добавления VK как 4-го канала `CHANNELS.length === 4` — логика `markVideoUsedById` автоматически учтёт VK без изменений.

---

## 7. Web UI

Файлы: `public/video.html`, `public/js/video.js`

### Существующие секции

| Секция | Состояние |
|--------|-----------|
| Генерация видео (выбор канала, кнопка, прогресс) | Реализовано |
| Интерьеры (добавление/удаление) | Реализовано |
| Изображения товаров (список `/workspace/input`) | Реализовано |
| Библиотека видео (фильтр по статусу, grid) | Реализовано |
| Статистика по статусам | Реализовано |

### Недостающие элементы (критично)

**1. Выбор модели генерации**

Добавить в секцию "Генерация видео" перед кнопкой:
```html
<label>Модель:</label>
<select id="videoModel">
  <option value="veo3.1">Veo 3.1</option>
  <option value="bytedance/seedance-2">Seedance 2.0</option>
  <option value="grok-imagine/image-to-video">Grok Imagine</option>
</select>
```

- При загрузке: `GET /api/video/config` → установить выбранное значение
- При изменении: `POST /api/video/config { videoModel }` → сохранить

**2. VK в карточках видео**

В `.channel-marks` добавить метку `vk` по аналогии с существующими тремя.

### Polling статуса

После `POST /generate` → `pollVideoStatus(videoId)`:
- Опрос `GET /api/video/assets/:videoId` каждые ~10 сек
- Максимум 60 попыток (~10 мин)
- При `video_ready` или `published` → обновить библиотеку, разблокировать кнопку

---

## 8. Тесты

Файл: `tests/video.pipeline.test.js`  
Запуск: `node tests/video.pipeline.test.js`

### Существующие тесты (8 шт.)

| # | Тест |
|---|------|
| 1 | `videoPipeline.repository.js` — все функции экспортированы |
| 2 | `CHANNELS` = `['youtube', 'tiktok', 'instagram']` |
| 3 | `videoPipeline.service.js` — все функции экспортированы |
| 4 | `video.routes.js` — возвращает Express router |
| 5 | `tiktokMvp.service.js` — все функции экспортированы |
| 6 | `manageStore` имеет TikTok функции |
| 7 | Миграция содержит все 8 статусов и 3 канала |
| 8 | `.env.example` содержит все видео-переменные |

### Недостающие тесты (критично)

| # | Тест | Что добавить |
|---|------|--------------|
| 9 | `CHANNELS` содержит 4 элемента включая `'vk'` | Обновить тест #2 |
| 10 | Миграция содержит `'vk'` в CHECK constraints | Обновить тест #7 |
| 11 | `vkVideoMvp.service.js` — все функции экспортированы | Новый тест |
| 12 | `manageStore` имеет `getVkVideoConfig`, `setVkVideoConfig` | Новый тест |
| 13 | `.env.example` содержит `VK_VIDEO_*` переменные | Обновить тест #8 |
| 14 | Адаптер Seedance 2.0 — unit тест формирования тела запроса | Новый тест |
| 15 | Адаптер Grok Imagine — unit тест формирования тела запроса | Новый тест |

---

## 9. ENV переменные

### Видеопайплайн

| Переменная | Default | Описание |
|------------|---------|----------|
| `KIE_API_KEY` | — | API ключ KIE.ai (обязательно) |
| `KIE_IMAGE_MODEL` | `kie-image-v1` | Модель генерации сцены |
| `VIDEO_MODEL` | `veo3.1` | Дефолтная модель image-to-video |
| `VIDEO_ASPECT_RATIO` | `9:16` | Соотношение сторон |
| `VIDEO_TEMP_ROOT` | `{DATA_ROOT}/.video-temp` | Папка временных файлов |
| `VIDEO_POLL_INTERVAL_SEC` | `25` | Интервал polling (сек) |
| `VIDEO_TIMEOUT_SEC` | `600` | Таймаут генерации (сек) |
| `VIDEO_CLEANUP_INTERVAL_MS` | `300000` | Интервал cleanup (мс) |
| `VIDEO_DELETION_DELAY_MIN` | `60` | Задержка удаления после публикации (мин) |
| `VIDEO_CHANNELS` | `youtube,tiktok,instagram,vk` | Активные каналы (обновить default) |

### Каналы

| Переменная | Default | Описание |
|------------|---------|----------|
| `TIKTOK_DAILY_LIMIT` | `3` | Лимит TikTok в день |
| `TIKTOK_MODERATION_TIMEOUT_HOURS` | `24` | Таймаут модерации TikTok (ч) |
| `INSTAGRAM_VIDEO_DAILY_LIMIT` | `3` | Лимит Instagram Reels в день |
| `VK_VIDEO_DAILY_LIMIT` | `3` | Лимит VK Video в день |
| `VK_VIDEO_MODERATION_TIMEOUT_HOURS` | `24` | Таймаут модерации VK Video (ч) |

---

## 10. Критичные пробелы

Все пункты блокируют продакшн-запуск.

### Блок 1 — VK Video (новый канал)

| # | Задача | Файл |
|---|--------|------|
| 1.1 | Создать `vkVideoMvp.service.js` | `services/vkVideoMvp.service.js` |
| 1.2 | Реализовать `publishVkVideoPost` (video.save → upload → wall.post) | `services/vkVideoMvp.service.js` |
| 1.3 | Реализовать модерацию `vk_vid_mod:` в CW Bot | `manage/telegram/runner.js` |
| 1.4 | Добавить `'vk'` в CHECK constraints | новая миграция `migrations/` |
| 1.5 | Обновить константу `CHANNELS` | `services/content/videoPipeline.repository.js` |
| 1.6 | Добавить `getVkVideoConfig`/`setVkVideoConfig` | `manage/store.js` |

### Блок 2 — Выбор модели генерации

| # | Задача | Файл |
|---|--------|------|
| 2.1 | Реализовать адаптер Seedance 2.0 | `services/videoPipeline.service.js` |
| 2.2 | Реализовать адаптер Grok Imagine | `services/videoPipeline.service.js` |
| 2.3 | Рефакторинг `generateVideoFromScene` — router по модели | `services/videoPipeline.service.js` |
| 2.4 | Добавить `GET /api/video/config` и `POST /api/video/config` | `routes/video.routes.js` |
| 2.5 | Добавить UI выбора модели | `public/video.html`, `public/js/video.js` |

### Блок 3 — TikTok публикация

| # | Задача | Файл |
|---|--------|------|
| 3.1 | Заменить `console.log` на `bufferService.createPost` | `services/tiktokMvp.service.js` |
| 3.2 | Реализовать подсчёт `publishedToday` через `video_channel_usage` | `services/tiktokMvp.service.js` |

### Блок 4 — Instagram Reels интеграция

| # | Задача | Файл |
|---|--------|------|
| 4.1 | Добавить видео-ветку (claimVideo → generateVideo) | `services/instagramMvp.service.js` |
| 4.2 | Реализовать публикацию Reels через `bufferService` | `services/instagramMvp.service.js` |
| 4.3 | Реализовать обработчик `ig_mod:` в CW Bot | `manage/telegram/runner.js` |
| 4.4 | Реализовать подсчёт `publishedToday` | `services/instagramMvp.service.js` |

### Блок 5 — Тесты

| # | Задача | Файл |
|---|--------|------|
| 5.1 | Обновить тест CHANNELS (4 элемента включая `'vk'`) | `tests/video.pipeline.test.js` |
| 5.2 | Добавить тест `vkVideoMvp` exports | `tests/video.pipeline.test.js` |
| 5.3 | Добавить unit тесты адаптеров Seedance и Grok | `tests/video.pipeline.test.js` |
| 5.4 | Обновить тест ENV переменных | `tests/video.pipeline.test.js` |

---

**Итого: 20 задач в 5 блоках. Все критичны для продакшн-запуска.**
