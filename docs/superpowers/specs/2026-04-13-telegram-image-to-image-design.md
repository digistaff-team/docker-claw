# Image-to-Image для всех каналов публикаций

**Дата:** 2026-04-13  
**Статус:** Approved

## Цель

Использовать изображения из `/workspace/input` как визуальный референс при генерации изображений для публикаций во всех каналах через Kie.ai image-to-image API.

## Текущее поведение

Все MVP-сервисы вызывают `POST /api/v1/jobs/createTask` (text-to-image):
- Telegram: модель `nano-banana-2`, картинки из input влияют только через имя файла в промпте
- VK, OK, Instagram, Pinterest, Facebook: модель `grok-imagine/text-to-image`, input-файлы не используются вообще

## Логика ветвления (единая для всех каналов)

```
getInputContext(chatId)
  ├─ есть .txt/.md → читаем содержимое → textPrompt
  ├─ есть картинки → выбираем случайную → imageFile
  └─ возвращаем { textPrompt, imageFile }

generateChannelImage(chatId, basePrompt, aspectRatio)
  ├─ imageFile найден → i2i: POST /api/v1/image/generate + imageUrls
  └─ imageFile не найден → t2i: POST /api/v1/jobs/createTask (без изменений)

Итоговый промпт для i2i:
  ├─ есть textPrompt → использовать textPrompt
  └─ нет textPrompt → использовать basePrompt (topic-based)
```

## Архитектура: общий модуль

Вся shared-логика выносится в **`services/inputImageContext.service.js`**:

```
inputImageContext.service.js
  ├─ getInputContext(chatId)       — читает /workspace/input, возвращает { textPrompt, imageFile }
  ├─ generateImage(chatId, prompt, aspectRatio)  — ветвление i2i/t2i, возвращает Buffer
  ├─ generateImageI2I(prompt, imagePublicUrl, aspectRatio)  — /api/v1/image/generate
  └─ generateImageT2I(prompt, aspectRatio, model)           — /api/v1/jobs/createTask
```

Каждый MVP-сервис импортирует этот модуль вместо прямых вызовов Kie.ai.

## Затрагиваемые файлы

| Файл | Изменение |
|------|-----------|
| `services/inputImageContext.service.js` | **Создать** — общий модуль |
| `services/telegramMvp.service.js` | Заменить inline-логику на вызов модуля; удалить `getInputFiles`, `getImageContext`, `generateImage` |
| `services/vkMvp.service.js` | `generateVkImage(topic, imagePrompt)` → `generateVkImage(chatId, topic, imagePrompt)`; использовать модуль |
| `services/okMvp.service.js` | `generateOkImage(topic, imagePrompt)` → `generateOkImage(chatId, topic, imagePrompt)`; использовать модуль |
| `services/instagramMvp.service.js` | `generateIgImage(topic, imagePrompt)` → `generateIgImage(chatId, topic, imagePrompt)`; использовать модуль |
| `services/pinterestMvp.service.js` | `generatePinImage(topic, pinTitle)` → `generatePinImage(chatId, topic, pinTitle)`; использовать модуль |
| `services/facebookMvp.service.js` | Уже имеет `chatId`; заменить inline-логику на вызов модуля |

## Технические детали

### Endpoint image-to-image (i2i)

```
POST https://api.kie.ai/api/v1/image/generate
{
  prompt: string,
  model: process.env.KIE_IMAGE_MODEL || 'kie-image-v1',
  aspect_ratio: '1:1' | '2:3',   // зависит от канала
  imageUrls: [publicUrl],
  n: 1,
  enableTranslation: true
}
Polling: GET /api/v1/image/tasks/:taskId — каждые 3 сек, макс 30 попыток (90 сек)
```

### Endpoint text-to-image (t2i, без изменений)

```
POST https://api.kie.ai/api/v1/jobs/createTask
Polling: GET /api/v1/jobs/recordInfo?taskId=...
```

### Публичный URL input-изображений

Уже существует: `/api/video/input/:chatId/:filename`  
Отдаёт файлы из `{DATA_ROOT}/{chatId}/input/` = `/workspace/input` в контейнере.

### Aspect ratio по каналам

| Канал | Соотношение |
|-------|-------------|
| Telegram | 1:1 |
| VK | 1:1 |
| OK | 1:1 |
| Instagram | 1:1 |
| Pinterest | 2:3 |
| Facebook | 1:1 |

### Изменения call sites (chatId)

VK, OK, Instagram, Pinterest — функции генерации изображений получают новый первый параметр `chatId`. Все вызывающие места этих функций уже имеют `chatId` в scope (это async-функции с `chatId` из внешнего closure или параметра).

## Не входит в scope

- YouTube, TikTok — используют видео-пайплайн, не генерируют изображения
- VK Video — видео-пайплайн
- WordPress/блог — использует `imageGen.service.js`, отдельная система
- Изменение моделей или промптов — только добавляем i2i поверх существующей логики
