# Instagram: миграция на публикацию через Buffer

**Дата:** 2026-04-09
**Статус:** Утверждён

## Цель

Перевести публикацию Instagram-постов с прямого Instagram Graph API на Buffer GraphQL API. Убрать весь код прямого API. Привести Instagram к единообразию с Pinterest (эталон Buffer-интеграции).

## Scope

### Изменяемые файлы

| Файл | Что меняется |
|------|-------------|
| `manage/store.js` | `setInstagramConfig` — новые поля (Buffer), удаление полей прямого API |
| `manage/routes.js` | Instagram endpoints: Buffer-поля, новый `test-buffer`, удаление `accounts` |
| `services/instagramMvp.service.js` | `publishIgPost` через Buffer, удаление прямого API, упрощение `getIgSettings` и `generateIgPostText` |
| `services/content/instagram.repository.js` | Новая схема таблиц без полей прямого API |
| `server.js` | Замена заглушки `ig_mod:` на полноценную обработку модерации |

### Удаляемые файлы

| Файл | Причина |
|------|---------|
| `services/instagram.service.js` | Прямой Instagram Graph API клиент, больше не используется |

### Неизменяемые части

- Планировщик (`tickIgSchedule`, `startScheduler`, `stopScheduler`)
- Генерация изображений (`generateIgImage` через KIE API)
- `saveImageToContainer`
- Worker-регистрация
- Черновики (`igDrafts` в store)

---

## 1. Конфигурация (`manage/store.js`)

### `setInstagramConfig(chatId, patch)` — новые поля

```
buffer_api_key        — Bearer токен Buffer API (string|null)
buffer_channel_id     — ID канала Instagram в Buffer (string|null)
is_active             — включён ли канал (boolean)
auto_publish          — публикация без премодерации (boolean)
schedule_time         — время первой публикации, напр. "10:00" (string)
schedule_tz           — таймзона (string)
daily_limit           — лимит постов в день (int, 1-25, default 3)
publish_interval_hours — интервал между публикациями (float)
allowed_weekdays      — разрешённые дни недели (int[], 0-6)
random_publish        — рандомизация внутри слота (boolean)
moderator_user_id     — Telegram ID модератора (string|null)
stats                 — статистика { total_posts, posts_today, last_post_date }
```

### Удаляемые поля

`app_id`, `app_secret`, `access_token`, `fb_page_id`, `fb_page_name`, `ig_user_id`, `ig_username`, `default_alt_text`, `location_id`, `is_reel`, `posting_hours`.

---

## 2. API-маршруты (`manage/routes.js`)

### Изменяемые endpoints

**`GET /api/manage/channels/instagram`**
Возвращает Buffer-конфиг. Маскировка `buffer_api_key` (первые 6 символов + `***`).

**`POST /api/manage/channels/instagram`**
Принимает: `chat_id`, `buffer_api_key`, `buffer_channel_id`, `is_active`, `auto_publish`, `schedule_time`, `schedule_tz`, `daily_limit`, `publish_interval_hours`, `allowed_weekdays`, `random_publish`, `moderator_user_id`.

**`DELETE /api/manage/channels/instagram`**
Без изменений.

### Новые endpoints

**`POST /api/manage/channels/instagram/test-buffer`**
Принимает: `buffer_api_key`, `buffer_channel_id`.
Вызывает `bufferService.testConnection()`.
Валидирует что `service === 'instagram'`.

### Удаляемые endpoints

**`GET /api/manage/channels/instagram/accounts`**
Запрос Facebook Pages — больше не нужен.

---

## 3. Сервис публикации (`instagramMvp.service.js`)

### `getIgSettings(chatId)` — новая структура

Читает из конфига:
```js
{
  isActive, bufferApiKey, bufferChannelId,
  autoPublish, premoderationEnabled,
  scheduleTime, scheduleTz, dailyLimit,
  publishIntervalHours, randomPublish,
  allowedWeekdays, moderator_user_id, stats
}
```

### `publishIgPost(chatId, bot, jobId, correlationId)` — переписан

Алгоритм (по образцу `publishPin` из Pinterest):

1. Получить job из БД
2. Получить Buffer-конфиг (`buffer_api_key`, `buffer_channel_id`)
3. Проверить наличие Buffer-ключей
4. Скопировать изображение из контейнера на хост: `{DATA_ROOT}/{chatId}/output/content/ig_{jobId}.png`
5. Опционально наложить водяной знак (`/workspace/brand/logo.png`)
6. Сформировать публичный URL: `${config.APP_URL}/api/files/public/${chatId}/ig_{jobId}.png`
7. Составить текст из `caption` (обрезка до 2200 символов)
8. Вызвать `bufferService.createPost(apiKey, channelId, { text, imageUrl })`
9. Записать в `instagram_publish_logs` с `method: 'buffer'`, `buffer_post_id`
10. Обновить статус job на `published`, записать `buffer_post_id`
11. Обновить статистику в store
12. Удалить черновик
13. Отправить уведомление в Telegram

### `generateIgPostText(chatId, topic, materialsText, personaText)` — упрощён

Убираем `hookText` из промпта. Возвращаем: `{ caption, imagePrompt }`.

### Удаляемые функции

- `uploadImageForInstagram` — временные файлы в `public/tmp/` больше не нужны
- Вся логика Reels/видео
- Импорт `instagramService`

### Новые зависимости

- `const bufferService = require('./buffer.service')`
- `const imageService = require('./image.service')` (для водяного знака)

---

## 4. Репозиторий (`services/content/instagram.repository.js`)

### Таблица `instagram_jobs` — новая схема

```sql
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
```

Удалённые колонки: `ig_user_id`, `hook_text`, `video_path`, `ig_content_type`, `ig_media_id`.
Добавленные колонки: `buffer_post_id`.

### Таблица `instagram_publish_logs` — новая схема

```sql
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
```

Удалённые колонки: `ig_user_id`, `ig_media_id`.
Добавленные колонки: `buffer_post_id`, `method`.

### Методы — обновлённый маппинг

`createJob`: убираем `igUserId`, `hookText`, `videoPath`, `igContentType`. Добавляем `bufferPostId`.
`updateJob`: аналогично обновляем маппинг JS→DB полей.
`addPublishLog`: убираем `igUserId`, `igMediaId`. Добавляем `bufferPostId`, `method`.

---

## 5. Модерация CW Bot (`server.js`)

### Замена заглушки `ig_mod:` (строки 358-365)

Полноценная обработка по образцу `vk_mod:`, `ok_mod:`, `pin_mod:`:

1. Получить `fromId`, `jobId`, `action` из callback
2. Найти `chatId` по черновику в `igDrafts` во всех states
3. Проверить доступ: владелец (`verifiedTelegramId`) или модератор (`moderator_user_id` / `globalSettings.moderatorUserId`)
4. Вызвать `instagramMvpService.handleInstagramModerationAction(chatId, { telegram: ctx.telegram }, jobId, action)`
5. Ответить пользователю результатом

---

## 6. Удаляемый файл

### `services/instagram.service.js`

Прямой Instagram Graph API клиент (277 строк). Полностью удаляется — все функции (`publishPhotoPost`, `publishReelPost`, `createMediaContainer`, `publishMedia`, `checkMediaStatus`, `getAccountInfo`, `validateInstagramParams`) больше не используются.
