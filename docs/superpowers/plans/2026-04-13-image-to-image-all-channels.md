# Image-to-Image для всех каналов публикаций — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Создать общий модуль `inputImageContext.service.js`, который читает файлы из `/workspace/input` пользователя и использует найденные картинки как референс для image-to-image генерации через Kie.ai во всех MVP-каналах.

**Architecture:** Новый модуль инкапсулирует чтение input-файлов и выбор endpoint (i2i vs t2i). Каждый MVP-сервис заменяет прямые вызовы Kie.ai на единый `inputImageContext.generateImage(chatId, prompt, aspectRatio, model)`. VK/OK/Instagram/Pinterest получают новый первый параметр `chatId` в функциях генерации изображений.

**Tech Stack:** Node.js, Kie.ai API (`/api/v1/image/generate` для i2i, `/api/v1/jobs/createTask` для t2i), встроенный `assert` для тестов.

---

## Структура файлов

| Файл | Действие | Ответственность |
|------|----------|-----------------|
| `services/inputImageContext.service.js` | **Создать** | Чтение input-файлов, ветвление i2i/t2i, вызовы Kie.ai |
| `tests/inputImageContext.test.js` | **Создать** | Unit-тесты чистой функции `_parseFiles` |
| `services/telegramMvp.service.js` | Изменить | Убрать дублирующий код, делегировать в модуль |
| `services/vkMvp.service.js` | Изменить | Добавить `chatId`, делегировать в модуль |
| `services/okMvp.service.js` | Изменить | Добавить `chatId`, делегировать в модуль |
| `services/instagramMvp.service.js` | Изменить | Добавить `chatId`, делегировать в модуль |
| `services/pinterestMvp.service.js` | Изменить | Добавить `chatId`, делегировать в модуль |
| `services/facebookMvp.service.js` | Изменить | Делегировать в модуль (chatId уже есть) |

---

## Task 1: Создать `inputImageContext.service.js` и тесты

**Files:**
- Create: `services/inputImageContext.service.js`
- Create: `tests/inputImageContext.test.js`

- [ ] **Step 1: Написать тест для `_parseFiles`**

```javascript
// tests/inputImageContext.test.js
'use strict';

const assert = require('assert');

// Мок модулей до require сервиса
process.env.APP_URL = 'https://example.com';
process.env.KIE_API_KEY = 'test-key';

// Патчим зависимости с реальными путями до require
const Module = require('module');
const originalLoad = Module._load;
Module._load = function (request, ...args) {
  if (request === './session.service') return { getOrCreateSession: async () => ({ containerId: 'c1' }) };
  if (request === './docker.service') return { executeInContainer: async () => ({ stdout: '' }) };
  if (request === '../config') return { APP_URL: 'https://example.com', DATA_ROOT: '/tmp' };
  return originalLoad.call(this, request, ...args);
};

const { _parseFiles } = require('../services/inputImageContext.service');

Module._load = originalLoad;

const colors = { green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', reset: '\x1b[0m' };
let passed = 0, failed = 0;
const errors = [];

function test(name, fn) {
  try {
    fn();
    console.log(`  ${colors.green}✓${colors.reset} ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ${colors.red}✗${colors.reset} ${name}: ${e.message}`);
    errors.push({ name, error: e.message });
    failed++;
  }
}

function group(name) { console.log(`\n${colors.yellow}${name}${colors.reset}`); }

group('_parseFiles: нет файлов');
test('пустой список → null/null', () => {
  const r = _parseFiles([], new Map());
  assert.strictEqual(r.textPrompt, null);
  assert.strictEqual(r.imageFile, null);
});

group('_parseFiles: только текстовые файлы');
test('.txt файл с содержимым → textPrompt заполнен', () => {
  const files = [{ name: 'desc.txt', ext: '.txt' }];
  const contents = new Map([['desc.txt', 'Описание товара']]);
  const r = _parseFiles(files, contents);
  assert.strictEqual(r.textPrompt, 'Описание товара');
  assert.strictEqual(r.imageFile, null);
});
test('.txt файл пустой → textPrompt null', () => {
  const files = [{ name: 'empty.txt', ext: '.txt' }];
  const contents = new Map([['empty.txt', '   ']]);
  const r = _parseFiles(files, contents);
  assert.strictEqual(r.textPrompt, null);
});
test('текст обрезается до 500 символов', () => {
  const files = [{ name: 'long.txt', ext: '.txt' }];
  const contents = new Map([['long.txt', 'x'.repeat(600)]]);
  const r = _parseFiles(files, contents);
  assert.strictEqual(r.textPrompt.length, 500);
});

group('_parseFiles: только изображения');
test('одно изображение → imageFile заполнен', () => {
  const files = [{ name: 'photo.jpg', ext: '.jpg' }];
  const r = _parseFiles(files, new Map());
  assert.strictEqual(r.imageFile, 'photo.jpg');
  assert.strictEqual(r.textPrompt, null);
});
test('все расширения изображений распознаются', () => {
  for (const ext of ['.png', '.jpg', '.jpeg', '.webp', '.gif']) {
    const files = [{ name: `img${ext}`, ext }];
    const r = _parseFiles(files, new Map());
    assert.strictEqual(r.imageFile, `img${ext}`, `ext ${ext} not recognized`);
  }
});
test('несколько изображений → возвращается одно (случайное)', () => {
  const files = [
    { name: 'a.png', ext: '.png' },
    { name: 'b.jpg', ext: '.jpg' },
    { name: 'c.webp', ext: '.webp' },
  ];
  const results = new Set();
  for (let i = 0; i < 30; i++) {
    const r = _parseFiles(files, new Map());
    results.add(r.imageFile);
  }
  assert.ok(results.size > 1, 'должен быть случайный выбор из нескольких изображений');
});

group('_parseFiles: текст + изображение');
test('оба типа → textPrompt и imageFile заполнены', () => {
  const files = [
    { name: 'desc.txt', ext: '.txt' },
    { name: 'photo.jpg', ext: '.jpg' },
  ];
  const contents = new Map([['desc.txt', 'Описание']]);
  const r = _parseFiles(files, contents);
  assert.strictEqual(r.textPrompt, 'Описание');
  assert.strictEqual(r.imageFile, 'photo.jpg');
});

group('_parseFiles: нераспознанные файлы');
test('.pdf файл игнорируется в обоих полях', () => {
  const files = [{ name: 'doc.pdf', ext: '.pdf' }];
  const r = _parseFiles(files, new Map());
  assert.strictEqual(r.textPrompt, null);
  assert.strictEqual(r.imageFile, null);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (errors.length) { console.error(errors); process.exit(1); }
```

- [ ] **Step 2: Запустить тест — убедиться что падает**

```bash
node tests/inputImageContext.test.js
```

Ожидаемый результат: `Error: Cannot find module '../services/inputImageContext.service'`

- [ ] **Step 3: Создать `services/inputImageContext.service.js`**

```javascript
// services/inputImageContext.service.js
'use strict';

const path = require('path');
const sessionService = require('./session.service');
const dockerService = require('./docker.service');
const config = require('../config');

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const TEXT_EXTS = new Set(['.txt', '.md']);

/**
 * Чистая функция: разбирает список файлов и возвращает контекст.
 * Экспортируется для тестирования.
 * @param {Array<{name: string, ext: string}>} files
 * @param {Map<string, string>} textContents  имя файла → содержимое
 * @returns {{ textPrompt: string|null, imageFile: string|null }}
 */
function _parseFiles(files, textContents) {
  let textPrompt = null;
  for (const f of files) {
    if (!TEXT_EXTS.has(f.ext)) continue;
    const content = textContents.get(f.name);
    if (content && content.trim()) {
      textPrompt = content.trim().slice(0, 500);
      break;
    }
  }

  const imageFiles = files.filter(f => IMAGE_EXTS.has(f.ext));
  const imageFile = imageFiles.length > 0
    ? imageFiles[Math.floor(Math.random() * imageFiles.length)].name
    : null;

  return { textPrompt, imageFile };
}

async function _getInputFiles(chatId) {
  try {
    const session = await sessionService.getOrCreateSession(chatId);
    const result = await dockerService.executeInContainer(
      session.containerId,
      "find /workspace/input -maxdepth 1 -type f -printf '%p\\n' 2>/dev/null"
    );
    return result.stdout.trim().split('\n').filter(Boolean).map(filepath => ({
      path: filepath,
      name: path.basename(filepath),
      ext: path.extname(filepath).toLowerCase()
    }));
  } catch (e) {
    console.warn(`[IMAGE-CTX] getInputFiles error for ${chatId}: ${e.message}`);
    return [];
  }
}

async function _readFileContent(chatId, filepath) {
  try {
    const session = await sessionService.getOrCreateSession(chatId);
    const result = await dockerService.executeInContainer(
      session.containerId,
      `cat "${filepath.replace(/"/g, '\\"')}"`
    );
    return result.stdout;
  } catch (e) {
    return null;
  }
}

/**
 * Читает /workspace/input пользователя и возвращает контекст для генерации.
 * @param {string} chatId
 * @returns {Promise<{ textPrompt: string|null, imageFile: string|null }>}
 */
async function getInputContext(chatId) {
  const files = await _getInputFiles(chatId);
  if (files.length === 0) return { textPrompt: null, imageFile: null };

  const textContents = new Map();
  for (const f of files) {
    if (!TEXT_EXTS.has(f.ext)) continue;
    const content = await _readFileContent(chatId, f.path);
    if (content) textContents.set(f.name, content);
  }

  return _parseFiles(files, textContents);
}

/**
 * Image-to-image через /api/v1/image/generate
 */
async function _generateI2I(prompt, imagePublicUrl, aspectRatio) {
  const apiKey = process.env.KIE_API_KEY;
  if (!apiKey) throw new Error('KIE_API_KEY is not set');

  const resp = await fetch('https://api.kie.ai/api/v1/image/generate', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: prompt.slice(0, 800),
      model: process.env.KIE_IMAGE_MODEL || 'kie-image-v1',
      aspect_ratio: aspectRatio,
      imageUrls: [imagePublicUrl],
      n: 1,
      enableTranslation: true
    }),
    timeout: 60000
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`KIE i2i API failed: ${resp.status} ${errText.slice(0, 300)}`);
  }
  const data = await resp.json();
  if (data.code !== 200) throw new Error(`KIE i2i error: ${data.msg} (code ${data.code})`);
  const taskId = data?.data?.taskId;
  if (!taskId) throw new Error('KIE i2i: no taskId');

  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const statusResp = await fetch(`https://api.kie.ai/api/v1/image/tasks/${taskId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      timeout: 30000
    });
    if (!statusResp.ok) continue;
    const statusData = await statusResp.json();
    if (statusData.code === 200 && statusData.data?.resultUrl) {
      const imgResp = await fetch(statusData.data.resultUrl, { timeout: 60000 });
      if (!imgResp.ok) throw new Error('Failed to download i2i image');
      return await imgResp.buffer();
    }
    if (statusData.code === 500 || statusData.code === 501) {
      throw new Error(`KIE i2i failed: ${statusData.msg}`);
    }
  }
  throw new Error('KIE i2i timeout');
}

/**
 * Text-to-image через /api/v1/jobs/createTask
 */
async function _generateT2I(prompt, aspectRatio, model) {
  const apiKey = process.env.KIE_API_KEY;
  if (!apiKey) throw new Error('KIE_API_KEY is not set');

  const createResp = await fetch('https://api.kie.ai/api/v1/jobs/createTask', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      input: { prompt: prompt.slice(0, 800), aspect_ratio: aspectRatio, nsfw_checker: true }
    }),
    timeout: 30000
  });
  if (!createResp.ok) {
    const err = await createResp.text();
    throw new Error(`Image t2i createTask failed: ${createResp.status} ${err.slice(0, 300)}`);
  }
  const createData = await createResp.json();
  if (createData.code !== 200) throw new Error(`Image t2i error: ${createData.msg}`);
  const taskId = createData?.data?.taskId;
  if (!taskId) throw new Error('Image t2i: no taskId');

  const pollUrl = `https://api.kie.ai/api/v1/jobs/recordInfo?taskId=${taskId}`;
  const pollHeaders = { Authorization: `Bearer ${apiKey}` };

  for (let attempt = 0; attempt < 18; attempt++) {
    await new Promise(r => setTimeout(r, 5000));
    const pollResp = await fetch(pollUrl, { headers: pollHeaders, timeout: 15000 });
    if (!pollResp.ok) continue;
    const pollData = await pollResp.json();
    const state = pollData?.data?.state;
    if (state === 'success') {
      const resultJson = JSON.parse(pollData.data.resultJson || '{}');
      const imageUrl = resultJson?.resultUrls?.[0];
      if (!imageUrl) throw new Error('Image t2i: no result URL');
      const imgResp = await fetch(imageUrl, { timeout: 30000 });
      if (!imgResp.ok) throw new Error(`Image download failed: ${imgResp.status}`);
      return await imgResp.buffer();
    }
    if (state === 'fail') {
      throw new Error(`Image t2i failed: ${pollData.data.failMsg || 'unknown'}`);
    }
  }
  throw new Error('Image t2i timeout');
}

/**
 * Генерирует изображение: i2i если в /workspace/input есть картинка, иначе t2i.
 * При i2i: textPrompt из .txt/.md переопределяет basePrompt.
 * При сбое i2i — fallback на t2i.
 *
 * @param {string} chatId
 * @param {string} basePrompt  - промпт канала (topic-based)
 * @param {string} aspectRatio - '1:1' | '2:3'
 * @param {string} t2iModel    - модель для t2i ('nano-banana-2' | 'grok-imagine/text-to-image')
 * @returns {Promise<Buffer>}
 */
async function generateImage(chatId, basePrompt, aspectRatio, t2iModel) {
  const { textPrompt, imageFile } = await getInputContext(chatId);
  const prompt = textPrompt || basePrompt;

  if (imageFile) {
    const imagePublicUrl = `${config.APP_URL}/api/video/input/${chatId}/${encodeURIComponent(imageFile)}`;
    console.log(`[IMAGE-CTX] i2i: chatId=${chatId} file=${imageFile}`);
    try {
      return await _generateI2I(prompt, imagePublicUrl, aspectRatio);
    } catch (e) {
      console.warn(`[IMAGE-CTX] i2i failed, fallback t2i: ${e.message}`);
    }
  }

  console.log(`[IMAGE-CTX] t2i: chatId=${chatId}`);
  return await _generateT2I(prompt, aspectRatio, t2iModel);
}

module.exports = { getInputContext, generateImage, _parseFiles };
```

- [ ] **Step 4: Запустить тест — убедиться что проходит**

```bash
node tests/inputImageContext.test.js
```

Ожидаемый результат: все тесты зелёные, `X passed, 0 failed`

- [ ] **Step 5: Commit**

```bash
git add services/inputImageContext.service.js tests/inputImageContext.test.js
git commit -m "feat: add inputImageContext service with i2i/t2i branching"
```

---

## Task 2: Обновить `telegramMvp.service.js`

**Files:**
- Modify: `services/telegramMvp.service.js`

Удалить функции `getInputFiles`, `readInputFile`, `getImageContext` и внутреннюю логику Kie.ai из `generateImage`. Функция `generateImage(chatId, topic, text)` остаётся с той же сигнатурой — меняется только тело.

- [ ] **Step 1: Добавить импорт в начало файла**

Найти блок `require` в начале `services/telegramMvp.service.js` и добавить строку после последнего `require`:

```javascript
const inputImageContext = require('./inputImageContext.service');
```

- [ ] **Step 2: Удалить `getInputFiles`, `readInputFile`, `getImageContext`**

Удалить функции целиком (строки примерно 654–735):

```javascript
// УДАЛИТЬ: async function getInputFiles(chatId) { ... }
// УДАЛИТЬ: async function readInputFile(chatId, filepath) { ... }
// УДАЛИТЬ: async function getImageContext(chatId) { ... }
```

- [ ] **Step 3: Заменить тело `generateImage`**

Найти `async function generateImage(chatId, topic, text)` и заменить всё тело функции:

```javascript
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
```

- [ ] **Step 4: Запустить существующие тесты**

```bash
npm test
```

Ожидаемый результат: все тесты проходят (нет обращений к удалённым функциям).

- [ ] **Step 5: Commit**

```bash
git add services/telegramMvp.service.js
git commit -m "refactor: telegram generateImage delegates to inputImageContext"
```

---

## Task 3: Обновить `vkMvp.service.js`

**Files:**
- Modify: `services/vkMvp.service.js`

- [ ] **Step 1: Добавить импорт**

В блок `require` файла `services/vkMvp.service.js`:

```javascript
const inputImageContext = require('./inputImageContext.service');
```

- [ ] **Step 2: Заменить `generateVkImage`**

Найти `async function generateVkImage(topic, imagePrompt)` и заменить полностью:

```javascript
async function generateVkImage(chatId, topic, imagePrompt) {
  const basePrompt = (imagePrompt || `VK post image. Topic: ${topic.topic}. Style: bright, professional, eye-catching, no text overlay, social media optimized.`).slice(0, 800);
  return inputImageContext.generateImage(chatId, basePrompt, '1:1', 'grok-imagine/text-to-image');
}
```

- [ ] **Step 3: Обновить все три call site — добавить `chatId`**

Call site 1 (~строка 365):
```javascript
// Было:
const imageBuffer = await generateVkImage(topic, vkText.imagePrompt);
// Стало:
const imageBuffer = await generateVkImage(chatId, topic, vkText.imagePrompt);
```

Call site 2 (~строка 664, regen_image):
```javascript
// Было:
const imageBuffer = await generateVkImage(draft.topic, draft.imagePrompt);
// Стало:
const imageBuffer = await generateVkImage(chatId, draft.topic, draft.imagePrompt);
```

Call site 3 (~строка 692, reject):
```javascript
// Было:
const imageBuffer = await generateVkImage(draft.topic, vkText.imagePrompt);
// Стало:
const imageBuffer = await generateVkImage(chatId, draft.topic, vkText.imagePrompt);
```

- [ ] **Step 4: Запустить тесты**

```bash
npm test
```

Ожидаемый результат: все тесты проходят.

- [ ] **Step 5: Commit**

```bash
git add services/vkMvp.service.js
git commit -m "refactor: vk generateVkImage delegates to inputImageContext"
```

---

## Task 4: Обновить `okMvp.service.js`

**Files:**
- Modify: `services/okMvp.service.js`

- [ ] **Step 1: Добавить импорт**

```javascript
const inputImageContext = require('./inputImageContext.service');
```

- [ ] **Step 2: Заменить `generateOkImage`**

Найти `async function generateOkImage(topic, imagePrompt)` и заменить полностью:

```javascript
async function generateOkImage(chatId, topic, imagePrompt) {
  const basePrompt = (imagePrompt || `OK social media post image. Topic: ${topic.topic}. Style: bright, professional, eye-catching, no text overlay, 1:1 ratio.`).slice(0, 800);
  return inputImageContext.generateImage(chatId, basePrompt, '1:1', 'grok-imagine/text-to-image');
}
```

- [ ] **Step 3: Обновить все три call site — добавить `chatId`**

Call site 1 (~строка 407):
```javascript
// Было:
const imageBuffer = await generateOkImage(topic, okText.imagePrompt);
// Стало:
const imageBuffer = await generateOkImage(chatId, topic, okText.imagePrompt);
```

Call site 2 (~строка 685, regen_image):
```javascript
// Было:
const imageBuffer = await generateOkImage(draft.topic, draft.imagePrompt);
// Стало:
const imageBuffer = await generateOkImage(chatId, draft.topic, draft.imagePrompt);
```

Call site 3 (~строка 713, reject):
```javascript
// Было:
const imageBuffer = await generateOkImage(draft.topic, okText.imagePrompt);
// Стало:
const imageBuffer = await generateOkImage(chatId, draft.topic, okText.imagePrompt);
```

- [ ] **Step 4: Запустить тесты**

```bash
npm test
```

- [ ] **Step 5: Commit**

```bash
git add services/okMvp.service.js
git commit -m "refactor: ok generateOkImage delegates to inputImageContext"
```

---

## Task 5: Обновить `instagramMvp.service.js`

**Files:**
- Modify: `services/instagramMvp.service.js`

- [ ] **Step 1: Добавить импорт**

```javascript
const inputImageContext = require('./inputImageContext.service');
```

- [ ] **Step 2: Заменить `generateIgImage`**

Найти `async function generateIgImage(topic, imagePrompt)` и заменить полностью:

```javascript
async function generateIgImage(chatId, topic, imagePrompt) {
  const basePrompt = (imagePrompt || `Instagram post image. Topic: ${topic.topic}. Style: bright, vibrant, Instagram-optimized, square format, no text overlay.`).slice(0, 800);
  return inputImageContext.generateImage(chatId, basePrompt, '1:1', 'grok-imagine/text-to-image');
}
```

- [ ] **Step 3: Обновить все три call site — добавить `chatId`**

Call site 1 (~строка 343):
```javascript
// Было:
const imageBuffer = await generateIgImage(topic, igText.imagePrompt);
// Стало:
const imageBuffer = await generateIgImage(chatId, topic, igText.imagePrompt);
```

Call site 2 (~строка 568, regen_image):
```javascript
// Было:
const imageBuffer = await generateIgImage(draft.topic, draft.imagePrompt);
// Стало:
const imageBuffer = await generateIgImage(chatId, draft.topic, draft.imagePrompt);
```

Call site 3 (~строка 596, reject):
```javascript
// Было:
const imageBuffer = await generateIgImage(draft.topic, igText.imagePrompt);
// Стало:
const imageBuffer = await generateIgImage(chatId, draft.topic, igText.imagePrompt);
```

- [ ] **Step 4: Запустить тесты**

```bash
npm test
```

- [ ] **Step 5: Commit**

```bash
git add services/instagramMvp.service.js
git commit -m "refactor: instagram generateIgImage delegates to inputImageContext"
```

---

## Task 6: Обновить `pinterestMvp.service.js`

**Files:**
- Modify: `services/pinterestMvp.service.js`

- [ ] **Step 1: Добавить импорт**

```javascript
const inputImageContext = require('./inputImageContext.service');
```

- [ ] **Step 2: Заменить `generatePinImage`**

Найти `async function generatePinImage(topic, pinTitle)` и заменить полностью:

```javascript
async function generatePinImage(chatId, topic, pinTitle) {
  const basePrompt = (`Pinterest pin image. Topic: ${topic.topic}. Title: ${pinTitle || ''}. Style: vertical, aesthetic, clean, visually appealing, no text overlay, no logos, professional photography style.`).slice(0, 800);
  return inputImageContext.generateImage(chatId, basePrompt, '2:3', 'grok-imagine/text-to-image');
}
```

- [ ] **Step 3: Обновить все три call site — добавить `chatId`**

Call site 1 (~строка 380):
```javascript
// Было:
const imageBuffer = await generatePinImage(topic, pinText.pinTitle);
// Стало:
const imageBuffer = await generatePinImage(chatId, topic, pinText.pinTitle);
```

Call site 2 (~строка 616, regen_image):
```javascript
// Было:
const imageBuffer = await generatePinImage(draft.topic, draft.pinTitle);
// Стало:
const imageBuffer = await generatePinImage(chatId, draft.topic, draft.pinTitle);
```

Call site 3 (~строка 644, reject):
```javascript
// Было:
const imageBuffer = await generatePinImage(draft.topic, pinText.pinTitle);
// Стало:
const imageBuffer = await generatePinImage(chatId, draft.topic, pinText.pinTitle);
```

- [ ] **Step 4: Запустить тесты**

```bash
npm test
```

- [ ] **Step 5: Commit**

```bash
git add services/pinterestMvp.service.js
git commit -m "refactor: pinterest generatePinImage delegates to inputImageContext"
```

---

## Task 7: Обновить `facebookMvp.service.js`

**Files:**
- Modify: `services/facebookMvp.service.js`

Facebook уже имеет `chatId` в `generateFbImage(chatId, topic, imagePrompt, jobId)`. Нужно добавить импорт и заменить тело функции.

- [ ] **Step 1: Добавить импорт**

```javascript
const inputImageContext = require('./inputImageContext.service');
```

- [ ] **Step 2: Заменить тело `generateFbImage`**

Найти `async function generateFbImage(chatId, topic, imagePrompt, jobId)` и заменить всё тело:

```javascript
async function generateFbImage(chatId, topic, imagePrompt, jobId) {
  const basePrompt = (imagePrompt || `Facebook post image about ${topic.topic}. Style: professional, engaging, social media optimized, no text overlay.`).slice(0, 800);
  return inputImageContext.generateImage(chatId, basePrompt, '1:1', 'grok-imagine/text-to-image');
}
```

- [ ] **Step 3: Запустить тесты**

```bash
npm test
```

- [ ] **Step 4: Commit**

```bash
git add services/facebookMvp.service.js
git commit -m "refactor: facebook generateFbImage delegates to inputImageContext"
```

---

## Task 8: Добавить тест в `package.json` и финальная проверка

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Добавить тест в npm test**

В `package.json` найти секцию `"scripts"` → `"test"`. Добавить `node tests/inputImageContext.test.js` в список тестов:

```json
"test": "node tests/content.status.test.js && node tests/validators.extended.test.js && node tests/wordpress.publisher.test.js && node tests/blog.generator.test.js && node tests/blog.moderation.test.js && node tests/video.pipeline.test.js && node tests/inputImageContext.test.js"
```

- [ ] **Step 2: Запустить полный тест-сьют**

```bash
npm test
```

Ожидаемый результат: все тесты проходят, включая `inputImageContext.test.js`.

- [ ] **Step 3: Проверить что нет оставшихся прямых вызовов Kie.ai в MVP-сервисах**

```bash
grep -n "api.kie.ai/api/v1/jobs/createTask\|api.kie.ai/api/v1/image/generate" \
  services/telegramMvp.service.js \
  services/vkMvp.service.js \
  services/okMvp.service.js \
  services/instagramMvp.service.js \
  services/pinterestMvp.service.js \
  services/facebookMvp.service.js
```

Ожидаемый результат: пустой вывод (все вызовы переведены в `inputImageContext.service.js`).

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "test: add inputImageContext to npm test suite"
```
