# Дизайн: фильтрация тем по каналу

**Дата:** 2026-04-14  
**Статус:** Согласован

---

## Цель

Каждый канал публикаций должен брать из таблицы `content_topics` только темы, предназначенные для него. Темы без указанного канала считаются универсальными и доступны всем каналам.

---

## Секция 1 — База данных и `reserveNextTopic`

Колонка `channel VARCHAR(50) DEFAULT NULL` и индексы `idx_content_topics_channel`, `idx_content_topics_status_channel` уже существуют в `content_topics`. Миграция не требуется.

Изменяется функция `reserveNextTopic` в `services/content/repository.js`:

```js
async function reserveNextTopic(chatId, channel = null)
```

SQL-запрос выборки:

```sql
SELECT id, topic, focus, secondary, lsi, status, created_at, used_at
FROM content_topics
WHERE status = 'pending'
  AND ($1::text IS NULL OR channel = $1 OR channel IS NULL)
ORDER BY created_at ASC, id ASC
FOR UPDATE SKIP LOCKED
LIMIT 1
```

- Если `channel` передан: берётся тема с совпадающим каналом ИЛИ с `channel IS NULL` (универсальная)
- Если `channel` не передан (null): берётся любая `pending` тема (обратная совместимость)
- Порядок: хронологический (`created_at ASC`) — канальные и универсальные темы смешаны в одну очередь

---

## Секция 2 — Текстовые каналы

Семь сервисов получают обновлённый вызов с передачей канального идентификатора:

| Файл | Было | Стало |
|---|---|---|
| `services/telegramMvp.service.js` | `reserveNextTopic(chatId)` | `reserveNextTopic(chatId, 'telegram')` |
| `services/vkMvp.service.js` | `reserveNextTopic(chatId)` | `reserveNextTopic(chatId, 'vk')` |
| `services/okMvp.service.js` | `reserveNextTopic(chatId)` | `reserveNextTopic(chatId, 'ok')` |
| `services/instagramMvp.service.js` | `reserveNextTopic(chatId)` | `reserveNextTopic(chatId, 'instagram')` |
| `services/facebookMvp.service.js` | `repository.pickTopic(chatId)` *(баг)* | `repository.reserveNextTopic(chatId, 'facebook')` |
| `services/pinterestMvp.service.js` | `reserveNextTopic(chatId)` | `reserveNextTopic(chatId, 'pinterest')` |
| `services/content/worker.js` (WordPress) | `reserveNextTopic(chatId)` | `reserveNextTopic(chatId, 'wordpress')` |

Попутно исправляется баг Facebook: `repository.pickTopic` не существует → заменяется на `repository.reserveNextTopic`.

---

## Секция 3 — Интеграция TikTok в систему тем

TikTok сейчас не использует `content_topics` — тема приходит из `queueJob.payload.topic` с хардкодным fallback `{ topic: 'Product showcase' }`.

Изменяется планировщик TikTok в `services/tiktokMvp.service.js`:

```
Было:  планировщик → enqueueJob({ topic: hardcoded })
Стало: планировщик → reserveNextTopic(chatId, 'tiktok')
                   → если тем нет — пропустить итерацию
                   → enqueueJob({ topic: reservedTopic, ... })
```

`handleTiktokGenerateJob` не меняется — он уже читает тему из `queueJob.payload.topic`.

При ошибке генерации вызывается `releaseTopic()` для возврата темы в `pending`.

---

## Секция 4 — Импорт из Google Sheets

В `previewContentImport` (режим `topics`) в `services/telegramMvp.service.js` добавляется разбор колонки `channel`:

```js
channel: findHeaderIndex(header, ['канал', 'channel'])
```

Значение нормализуется к нижнему регистру. Допустимые значения:

| Значение в таблице | Канал |
|---|---|
| `telegram` | Telegram посты |
| `vk` | ВКонтакте посты |
| `vk_video` | VK Video |
| `ok` | Одноклассники |
| `instagram` | Instagram фото-посты |
| `instagram_reels` | Instagram Reels (видео) |
| `facebook` | Facebook посты |
| `pinterest` | Pinterest пины |
| `youtube` | YouTube Shorts (видео) |
| `wordpress` | WordPress блог |
| `tiktok` | TikTok видео |

Любое другое значение или пустая ячейка → `NULL` (универсальная тема, доступна всем каналам).

В объект превью добавляется поле `channel` для отображения до подтверждения импорта.

**Пример таблицы:**

| тема | фокусный ключ | вторичные ключи | lsi-ключи | канал | статус |
|---|---|---|---|---|---|
| Как выбрать диван | диван купить | мягкая мебель | интерьер | vk | |
| Обзор новинок | новинки 2025 | коллекция | стиль | instagram | |
| Видео распаковка | распаковка товара | | | tiktok | |
| Акция на столы | столы со скидкой | | | | pending |

---

## Секция 5 — Видео-каналы (общий пайплайн)

Четыре канала используют общий видео-пайплайн и интегрируются по единой схеме через планировщик:

**Каналы:** TikTok, VK Video, Instagram Reels, YouTube Shorts

**Схема:**
```
планировщик → reserveNextTopic(chatId, '<channel_topics_name>')
            → если тем нет — пропустить итерацию
            → enqueueJob({ topic: reservedTopic, ... })
            → handleJob читает topic из payload (без изменений)
            → при ошибке → releaseTopic() → status='pending'
```

**Маппинг** идентификатора `content_topics.channel` → идентификатор внутри видео-пайплайна:

```js
const VIDEO_CHANNEL_MAP = {
  'instagram_reels': 'instagram',
  'vk_video':        'vk',
  'youtube':         'youtube',
  'tiktok':          'tiktok'
};
```

`instagram_reels` и `vk_video` маппятся на `instagram` и `vk` при передаче в `videoPipeline.claimVideo` / `videoPipeline.generateVideo` — это прозрачно для пользователя.

**YouTube переходит на общий пайплайн:** `youtubeMvp.service.js` перестаёт делать прямой вызов KIE.ai Veo 3 API с polling'ом и начинает использовать `videoPipeline.claimVideo` / `videoPipeline.generateVideo`, как TikTok и VK Video.

---

## Затронутые файлы

| Файл | Тип изменения |
|---|---|
| `services/content/repository.js` | Добавить параметр `channel` в `reserveNextTopic` |
| `services/telegramMvp.service.js` | Передать `'telegram'` + добавить `channel` в импорт |
| `services/vkMvp.service.js` | Передать `'vk'` |
| `services/okMvp.service.js` | Передать `'ok'` |
| `services/instagramMvp.service.js` | Передать `'instagram'` для фото-постов; добавить отдельный планировщик `instagram_reels` через видео-пайплайн |
| `services/facebookMvp.service.js` | Исправить баг `pickTopic` → `reserveNextTopic(chatId, 'facebook')` |
| `services/pinterestMvp.service.js` | Передать `'pinterest'` |
| `services/content/worker.js` | Передать `'wordpress'` |
| `services/tiktokMvp.service.js` | Интегрировать `reserveNextTopic` в планировщик |
| `services/vkVideoMvp.service.js` | Интегрировать `reserveNextTopic` в планировщик |
| `services/youtubeMvp.service.js` | Переключить на общий видео-пайплайн + `reserveNextTopic` в планировщик |
