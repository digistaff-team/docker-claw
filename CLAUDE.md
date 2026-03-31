# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## Project Overview

**Docker-Claw (Клиент Завод) v3.0.0** — AI-платформа для управления изолированными Docker-контейнерами. Каждый пользователь получает персональный контейнер (Node.js-среда), персональную PostgreSQL БД и Telegram-бота. Система автоматически генерирует и публикует контент в Telegram, ВКонтакте, Одноклассники, Pinterest.

**Стек:** Node.js 18 + Express.js, PostgreSQL 15, MySQL 8 (навыки), Docker, Telegraf (Telegram Bot API), nodemailer/imap-simple (Email). Фронтенд — статические HTML/CSS/JS файлы (без фреймворка).

---

## Commands

```bash
npm install          # Установить зависимости
npm run dev          # Development: nodemon + auto-reload
npm start            # Production: node server.js

# Тесты
node tests/content.status.test.js       # Тест машины состояний
node tests/validators.extended.test.js  # Тест валидации контента

# Docker
docker-compose up -d           # Запустить все сервисы (postgres, nginx, app)
docker-compose logs -f app     # Логи приложения
docker-compose down            # Остановить все
```

Сервер работает на порту `3015` по умолчанию. Конфигурация загружается из `.env` + `.env.local` (`.env.local` переопределяет `.env`).

---

## Architecture

### Общий поток данных

```
Telegram auth bot → one-time token → /auth.html → сессия создана
    ↓
Docker container spawned (sandbox-user-{chatId})
    ↓
Per-user PostgreSQL DB auto-provisioned (db_{chatId})
    ↓
Пользователь управляет контейнером через Telegram-бота
    ↓
AI агент (agentLoop) обрабатывает сообщения через LLM с tool-calling
    ↓
Контент генерируется и публикуется в Telegram/VK/OK/Pinterest по расписанию
```

---

## Key Subsystems

### 1. Session & Container Management

**`services/session.service.js`** — центральный менеджер сессий. Хранит in-memory Map `sessions` (chatId → объект сессии). Каждая сессия содержит `containerId`, `dataDir`, объект PostgreSQL-подключения, счётчик команд, время создания и последней активности. Ключевые функции:
- `createSession(chatId)` — создаёт Docker-контейнер, инициализирует PostgreSQL БД, монтирует `/var/sandbox-data/{chatId}/` как `/workspace` внутри контейнера. Инициализация рабочих директорий (yarn, pnpm, nodemon, TypeScript) происходит асинхронно в фоне.
- `getOrCreateSession(chatId)` — атомарная операция: вернуть существующую или создать новую.
- `destroySession(chatId)` — останавливает и удаляет контейнер, делает DROP DATABASE, удаляет из памяти.
- `removeSession(chatId)` — только убирает из памяти, не трогая контейнер и БД (используется в мягком Delete в admin).
- `recoverAllSessions()` — вызывается при старте сервера, восстанавливает сессии из работающих контейнеров.
- `cleanupIdleSessions()` — удаляет сессии неактивные дольше `SESSION_MAX_IDLE_MS` (24 часа).

**`services/docker.service.js`** — прямое взаимодействие с Docker CLI через `child_process.spawn`. Ключевые функции:
- `createUserContainer(chatId, options)` — создаёт контейнер с именем `sandbox-user-{chatId}`. Параметры: образ `node:20-bookworm`, память 256m, CPU 2.0, bind-mount данных, tmpfs на /tmp. Передаёт переменные окружения: PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD, DATABASE_URL.
- `executeInContainer(containerId, command, timeout)` — выполняет bash-команду через `docker exec`. Блокирует опасные команды (`rm -rf /`, `dd if=`, `mkfs` и т.п.).
- `initializeWorkspaceStructure(containerId, onStep)` — устанавливает yarn/pnpm, nodemon/pm2, TypeScript/ESLint/Prettier, Vite. Создаёт директории `/workspace/{input,output,work,log,apps,tmp}`.
- `getAllUserContainers()` — возвращает список всех контейнеров с именем `sandbox-user-*`.
- `resetContainerWorkspace(containerId)` — очищает `/workspace` и переинициализирует.

**`services/storage.service.js`** — работа с файловой системой пользователей. `getDataDir(chatId)` возвращает `DATA_ROOT/{sanitized_chatId}`, где sanitization убирает все символы кроме `[a-z0-9_-]`. `backupUserData(chatId)` копирует директорию в `BACKUP_ROOT/{chatId}_{timestamp}`. `cleanOldBackups()` удаляет бэкапы старше 7 дней.

**`services/postgres.service.js`** — управление PostgreSQL. `createUserDatabase(chatId)` создаёт БД `db_{chatId}` и вызывает `contentRepository.ensureSchema()` для инициализации таблиц. `deleteUserDatabase(chatId)` терминирует все активные подключения к БД (`pg_terminate_backend`) и выполняет `DROP DATABASE IF EXISTS`.

---

### 2. Хранилище состояния пользователей

**`manage/store.js`** — персистентное in-memory хранилище. В памяти: `statesCache` (chatId → объект). На диске: `{DATA_ROOT}/manage-state-{chatId}.json` (+ `.bak` бэкап). Запись атомарна через `.tmp` файл с последующим `rename`. Загружается при старте сервера через `load()`.

Структура объекта состояния пользователя (ключевые поля):
```javascript
{
  token: "TG_BOT_TOKEN",           // Токен Telegram-бота пользователя
  botUsername: "czcw_bot",         // Username бота (из getMe())
  verifiedUsername: "@user",       // Telegram username после верификации кодом
  verifiedTelegramId: 12345678,    // Telegram user ID после верификации
  onboardingComplete: true,

  // AI провайдер
  aiProvider: "protalk",           // "protalk" | "openai" | "openrouter"
  aiModel: "google/gemini-2.5-pro-preview",
  aiAuthToken: "...",              // Токен для ProTalk
  aiCustomApiKey: "...",           // Ключ для OpenAI/OpenRouter
  aiUserEmail: "user@example.com", // Email для ProTalk

  // Контент Telegram
  contentSettings: {
    channelId: "-100XXXXXXXXXX",
    moderatorUserId: "128247430",
    scheduleTime: "09:00",
    scheduleTz: "Europe/Moscow",
    dailyLimit: 1,
    contentType: "text+image",     // "text+image" | "text+video"
    publishIntervalHours: 24,
    allowedWeekdays: [1,2,3,4,5],
    premoderationEnabled: true
  },

  // ВКонтакте
  vkConfig: {
    is_active: true,
    group_id: "123456",
    access_token: "vk1.a...",
    schedule_time: "10:00"
  },

  // Одноклассники
  okConfig: {
    is_active: true,
    group_id: "789",
    access_token: "...",
    schedule_time: "11:00"
  },

  // Pinterest
  pinterestConfig: {
    is_active: true,
    access_token: "...",
    board_ids: ["board1"]
  },

  // Контекстные настройки AI
  contextSettings: {
    maxCommands: 5, maxFiles: 80, maxDepth: 3,
    maxFileLines: 30, includeStdout: true, includeStderr: true,
    stdoutMaxChars: 200, stderrMaxChars: 200
  },

  lastCommands: [...],    // Max 50 последних bash-команд
  aiMessages: [...],      // Max 100 сообщений в диалоге с AI
  aiRouterLogs: [...]     // Max 200 записей вызовов AI Router
}
```

Ключевые функции `clearToken(chatId)` — удаляет из `statesCache` и удаляет оба файла (`.json` + `.bak`).

---

### 3. Telegram Bot (двух-бот система)

**`manage/telegram/authBot.js`** — центральный бот аутентификации (`AUTH_BOT_TOKEN`), один на всю систему. Принимает `/start` от пользователей, через `POST /api/auth/telegram-login` выдаёт одноразовый login-токен (hex, TTL 10 минут) и редиректит на `/auth.html?tg_login_token=<hex>`. Является авторитетным источником для получения `username` пользователя по его `chatId` (все пользователи системы проходят через него).

**`manage/telegram/runner.js`** (57 KB) — per-user бот. Запускается через `startBot(chatId, token)`, хранит все запущенные боты в Map `bots`. Обрабатывает:
- Команды: `/start`, `/mode` (CHAT/WORKSPACE/TERMINAL), `/help`, `/skills`, `/channels`, `/content`, `/settings`
- Текстовые сообщения → передаёт в `agentLoop`
- Callback query (inline кнопки) — переключение режима, выбор навыков, модерация контента
- Модерацию постов: кнопки `✅ Опубликовать`, `🔁 Переделать`, `❌ Отклонить` для Telegram, VK, OK контента
- `sanitizeHtmlForTelegram(html)` — нормализует HTML перед отправкой в Telegram API (допустимы только `<b>`, `<i>`, `<u>`, `<s>`, `<code>`, `<pre>`, `<a>`)

**`manage/telegram/agentLoop.js`** (47 KB) — цикл рассуждений AI. `executeAgentLoop(chatId, userMessage, mode, onStep)` строит контекст, вызывает LLM, обрабатывает `tool_calls` через `toolHandlers`, итерирует пока AI не вызовет `task_completed`. Поддерживает прерывание через флаг `interrupted`.

**`manage/telegram/toolHandlers.js`** (77 KB) — реализация всех инструментов AI:
- Файловые: `readFile`, `writeFile`, `patchFile` (unified diff формат), `listDir`, `createFolder`, `deleteFile`, `sendFile`
- Системные: `executeCommand` (bash в контейнере), `interrupt`
- Планирование: `createPlan`, `updateStepStatus`, `taskCompleted`
- Контекст: `requestContext` (загружает содержимое файла/папки в контекст)

**`manage/telegram/tools.js`** (24 KB) — JSON-определения инструментов, передаваемых в LLM. Три набора: `TOOLS_CHAT`, `TOOLS_WORKSPACE`, `TOOLS_TERMINAL`.

---

### 4. AI Context & Prompts

**`manage/context.js`** — собирает структурированный контекст для LLM. `buildFullContextStructured(chatId)` возвращает: историю команд, дерево файлов (из `projectCacheService`), persona-файлы (IDENTITY.md, SOUL.md, USER.md, MEMORY.md), активные навыки, информацию о БД, список приложений, активные планы, резюме сессий.

**Автоматические навыки-копирайтеры** добавляются в контекст при активном канале:
- `isTelegramChannelActive(chatId)` → `contentSettings.channelId` задан → добавляется `tg-copywriter`
- `isVkChannelActive(chatId)` → `vkConfig.is_active && group_id && access_token` → добавляется `vk-copywriter`
- `isOkChannelActive(chatId)` → `okConfig.is_active && group_id && access_token` → добавляется `ok-copywriter`

**`manage/prompts.js`** — `getSystemInstruction(mode, structuredContext, channel, enabledChannels)`. Формирует системный промпт: личность AI, режим работы (CHAT/WORKSPACE/TERMINAL), доступные инструменты, URL входящего webhook, параметры PostgreSQL, активные навыки (из context), краткие инструкции для каждого подключённого канала публикации. Для каждого канала в `enabledChannels` включает специфику: Telegram (HTML-теги, длина, хэштеги), VK (разговорный стиль, 300–800 симв.), OK (аудитория 35+, 400–600 симв.), Pinterest (SEO, 100–300 симв.), Instagram, YouTube, Email, Дзен, TikTok.

---

### 5. MySQL — навыки AI (ai_skills_db)

**`services/mysql.service.js`** — работа с MySQL через пул `mysql2`. База `ai_skills_db`.

**Таблицы:**
- `ai_skills` — каталог навыков. Поля: `user_email` ("system" для встроенных, "chat_{chatId}" для личных), `slug` (уникальный идентификатор), `system_prompt` (LONGTEXT — основная инструкция для AI), `is_public`, `is_active`, `usage_count`.
- `user_selected_skills` — выбранные пользователем навыки (user_email + skill_id).

**Встроенные навыки (11 штук, slug → назначение):**
1. `python-developer` — Python + type hints, PEP 8, asyncio
2. `javascript-nodejs-developer` — ES6+, async/await, Clean Code
3. `seo-specialist` — ключевые слова, meta-теги, H1-H6
4. `copywriter` — AIDA/PAS, CTA, продающие тексты
5. `data-analyst` — статистика, визуализация, инсайты
6. `postgresql-expert` — оптимизация запросов, EXPLAIN ANALYZE
7. `devops-engineer` — bash, CI/CD, мониторинг
8. `telegram-bot-developer` — Bot API, FSM, callback query
9. `email-marketer` — subject line, сегментация, A/B
10. `linux-sysadmin` — systemd, journalctl, firewall
11. `tg-copywriter` — **копирайтер для Telegram-каналов**: HTML-форматирование (`<b>`, `<i>`, `<code>` и др.), структура поста (превью уведомления ~60 симв.), длина (300–800 / до 1024 для медиа), эмодзи как маркеры, хэштеги 1–4, стиль без воды, специфика для информационных / коммерческих / развлекательных каналов.

`seedInitialSkillsIfEmpty()` — срабатывает при пустой таблице. **Для существующих установок** `tg-copywriter` нужно добавить вручную через `/admin/skills`.

---

### 6. Content MVP — многоканальная публикация

Контент-пайплайн построен по единой схеме для каждого канала:

**`services/contentMvp.service.js`** (74 KB) — публикация в **Telegram**. Оркестрирует генерацию, модерацию и публикацию. `runNow(chatId, botFacade, reason)` запускает немедленную генерацию. Планировщик вызывается каждые 60 секунд через `setInterval` в `server.js`, проверяет расписание (`SCHEDULE_TIME`, `SCHEDULE_TZ`) и суточный лимит (`DAILY_LIMIT = 1`).

**`services/vkMvp.service.js`** (29 KB) — публикация в **ВКонтакте**. `DAILY_VK_LIMIT = 5`, `VK_MODERATION_TIMEOUT_HOURS = 24`. Использует `services/vk.service.js` (VK API v5.199).

**`services/okMvp.service.js`** (32 KB) — публикация в **Одноклассники**. `OK_DAILY_LIMIT = 5`. Использует `services/ok.service.js`. Требует: `OK_APP_ID`, `OK_PUBLIC_KEY`, `OK_SECRET_KEY`.

**`services/pinterestMvp.service.js`** (27 KB) — публикация в **Pinterest**. SEO-ориентированный контент. Использует `services/pinterest.service.js`.

**Модули `services/content/`:**
- `repository.js` — CRUD для контента в PostgreSQL per-user БД
- `queue.repository.js` — очередь задач: FIFO, статусы `queued/processing/done/failed`, exponential backoff retry
- `worker.js` — воркер для обработки очереди публикаций
- `status.js` — машина состояний контента: `draft → ready → approved → published` (+ `error/failed`)
- `validators.js` — валидация контента (запрещённые темы, длина, формат)
- `limits.js` — суточные лимиты публикаций
- `video.service.js` — асинхронная генерация видео (Runway/другой провайдер), polling статуса, fallback на изображение если видео не готово

**Поток публикации:**
```
AI генерирует черновик (correlationId)
    ↓
premoderationEnabled = true?
    ├─ ДА: отправить черновик moderatorUserId → ждать кнопку ✅/❌/🔁
    └─ НЕТ: сразу в очередь → worker → публикация в канал
```

`moderatorUserId` по умолчанию = `CONTENT_MVP_MODERATOR_USER_ID` из `.env`. Если не задан и премодерация включена — ошибка при отправке. **Alerts отключены** — `checkAndAlert()` удалён из планировщика, автоматические уведомления об ошибках не отправляются.

---

### 7. AI Router

**`services/ai_router_service.js`** — `callAI(chatId, authToken, model, messages, tools, userEmail)`. Определяет провайдера из `manageStore` и маршрутизирует:
- **ProTalk** (по умолчанию): `https://ai.pro-talk.ru/api/router`
- **OpenAI**: `https://api.openai.com/v1`
- **OpenRouter**: `https://openrouter.ai/api/v1`

Логирует `usage` (токены), время выполнения, обрабатывает ошибки 401/402/429. Поддерживает function calling (tools в JSON Schema формате).

---

### 8. Онбординг

**`public/setup.html`** + **`public/js/setup.js`** — страница первоначальной настройки. Появляется при первом входе (`onboardingComplete = false`).

Шаги:
1. **Подключение к боту Копирайтер** — пользователь нажимает кнопку **Подключить**, которая открывает `https://t.me/{cwBotUsername}` (username получается через `GET /api/manage/cw-bot-info`). Пользователь пишет боту любое сообщение → cwBot присылает 6-значный код (`server.js`: `cwBot.on('text', ...)`), код сохраняется в `state.pending` через `manageStore.setPending()`. Пользователь вводит код на странице → `POST /api/manage/telegram/verify` → `manageStore.verify()` проверяет код и устанавливает `state.verifiedTelegramId`. Кнопка **Сохранить** становится активной только после успешного подтверждения.

   Этот шаг обязателен: Telegram запрещает ботам писать пользователю первыми — без `/start` или первого сообщения отправка черновиков на модерацию невозможна.

2. **Выбор каналов публикации** — чекбоксы: Telegram (включён по умолчанию, нельзя снять), VK, OK, Pinterest, Instagram, Email, YouTube, Дзен, TikTok. Сохраняются в `content_config` таблицу через `setEnabledChannels(chatId, channels)`.

3. После сохранения: `onboardingComplete = true`, редирект на `/channels.html`.

Токен Telegram-бота пользователю вводить не нужно — система автоматически привязывает его к центральному боту `CW_BOT_TOKEN` при первой авторизации (см. "Полный цикл авторизации пользователя").

---

### 9. Admin Panel

**`routes/admin.routes.js`** + страницы в **`public/admin/`**.

Требует авторизации через `ADMIN_PASSWORD` (Bearer токен, query param `password`, заголовок `x-admin-password`, или session cookie).

**Страницы:**
- `login.html` — форма входа
- `containers.html` — список всех контейнеров (`sandbox-user-*`) со статусом, кнопками управления
- `container-manage.html` — детальная страница контейнера: информация (Chat ID, User Name из Telegram API, Container ID, Status, Session Created, Last Activity, Commands Executed, Python3), terminal (bash exec), кнопки Start/Stop/Restart
- `skills.html` — CRUD навыков в MySQL `ai_skills` таблице
- `chat.html` — чат с пользователем

**Ключевые API маршруты:**

| Метод | Endpoint | Описание |
|-------|----------|----------|
| GET | `/admin/containers-api` | Список контейнеров (JSON) |
| GET | `/admin/container/:chatId/info` | Информация + username через AUTH_BOT_TOKEN `getChat()` |
| POST | `/admin/container/:chatId/exec` | Выполнить bash в контейнере |
| DELETE | `/admin/container/:chatId` | Мягкое удаление: только контейнер + сессия из памяти |
| **DELETE** | **`/admin/container/:chatId/kill`** | **Полное удаление пользователя** (см. ниже) |

**Kill operation** — `DELETE /admin/container/:chatId/kill` — последовательно удаляет 8 слоёв данных, каждый в отдельном `try/catch` (ошибка одного шага не прерывает остальные):
1. Docker-контейнер (`stop` + `removeContainer`)
2. PostgreSQL БД (`deleteUserDatabase` → `DROP DATABASE`)
3. Файлы пользователя (`fs.rm` `/var/sandbox-data/{chatId}/`, recursive)
4. State-файлы (`manageStore.clearToken` → удаляет `.json` + `.bak`)
5. Бэкапы (`fs.readdir` `BACKUP_ROOT`, удалить все `{chatId}_*`)
6. Снапшоты (`fs.rm` `SNAPSHOT_ROOT/{chatId}/`, recursive)
7. MySQL записи (`DELETE FROM user_selected_skills WHERE user_email = 'chat_{chatId}'` + аналогично `ai_skills`)
8. Сессия из памяти (`sessionService.removeSession`)

Возвращает `{ success: true, chatId, results: ["container: removed", "postgres: dropped", ...] }`. Фронтенд требует ввод `chatId` в `prompt()` для подтверждения (защита от случайного нажатия).

Кнопка **User Name** на странице `container-manage.html` — получает Telegram username через `AUTH_BOT_TOKEN` (не через токен пользователя), так как auth-бот гарантированно имеет переписку со всеми пользователями системы.

---

### 10. Route Structure

Все API маршруты регистрируются в `routes/index.js`:

| Префикс | Файл | Назначение |
|---------|------|-----------|
| `/api/session/*` | `session.routes.js` | Жизненный цикл контейнера |
| `/api/execute` | `execute.routes.js` | Выполнение bash (legacy) |
| `/api/files/*` | `files.routes.js` | Загрузка/скачивание файлов |
| `/api/content/*` | `content.routes.js` | Контент CRUD и публикация |
| `/api/manage/*` | `manage/routes.js` | Telegram/Email/AI/VK/OK настройки |
| `/api/auth/*` | `auth.routes.js` | Аутентификация |
| `/api/plans/*` | `plans.routes.js` | CRUD планов |
| `/api/database/*` | `database.routes.js` | Операции с PostgreSQL |
| `/admin/*` | `admin.routes.js` | Admin panel (password-protected) |
| `/sandbox/*` | `sandbox.routes.js` | Прокси к контейнеру |
| `/hook/*` | `webhook.routes.js` | Входящие webhook |

---

### 11. Configuration

Все переменные окружения централизованы в `config.js`. Загружаются из `.env`, переопределяются `.env.local`.

Критические переменные:

| Переменная | Назначение |
|-----------|-----------|
| `PORT` | Порт сервера (3015) |
| `PG_HOST`, `PG_PORT`, `PG_USER`, `PG_PASSWORD` | PostgreSQL подключение |
| `PG_ADMIN_HOST` | Хост для операций CREATE/DROP DATABASE |
| `MYSQL_SKILLS_HOST` | MySQL для навыков |
| `DOCKER_IMAGE` | Образ контейнера (node:20-bookworm) |
| `AUTH_BOT_TOKEN` | Центральный auth-бот (один на систему) |
| `BOT_TOKEN` | Дефолтный бот (legacy) |
| `CHANNEL_ID` | ID Telegram-канала по умолчанию |
| `OPENAI_API_KEY`, `KIE_API_KEY` | AI провайдеры |
| `ADMIN_PASSWORD` | Пароль admin-панели |
| `DATA_ROOT` | Корень хранилища (`/var/sandbox-data`) |
| `BACKUP_ROOT` | Бэкапы (`/var/sandbox-backups`) |
| `SNAPSHOT_ROOT` | Снапшоты файлов (`/var/sandbox-snapshots`) |
| `CONTENT_MVP_MODERATOR_USER_ID` | Дефолтный ID модератора контента |

---

### 12. Frontend

Статические файлы в `public/`. Каждая страница — самодостаточный HTML-файл. Общие утилиты в `public/js/common.js` (`initAuth()`, обработка `tg_login_token`). Стили в `public/css/main.css`.

**Ключевые страницы:**
- `index.html` — лендинг (без авторизации)
- `auth.html` — точка входа после Telegram-логина; `initAuth()` обрабатывает `tg_login_token` из URL
- `setup.html` — онбординг (первый вход)
- `channels.html` — настройка каналов публикации, модератора, расписания
- `console.html` — терминал / AI-чат
- `ai.html` — настройки AI провайдера
- `content.html` — управление темами контента
- `skills.html` — выбор AI навыков
- `apps.html` — реестр приложений в контейнере
- `files.html` — файловый менеджер
- `info.html` — статистика контейнера и диска
- `tasks.html` — задачи (plans)

---

## Database Schema

### Трёхуровневая архитектура БД

#### 1. Центральная PostgreSQL БД (`clientzavod`)

Глобальная БД, разделяемая между всеми пользователями:
- `content_queue` — очередь контента. Полный жизненный цикл: `draft → pending → processing → generated → waiting_approval → approved → scheduled → publishing → published`. 50+ колонок, индексы на status/channel/pending/scheduled.
- `content_channels` — конфиги каналов публикации (Telegram, VK, OK, Facebook, Instagram, Pinterest, YouTube, Email). Хранит auth-токены, rate limits, расписание.
- `content_analytics` — метрики: просмотры, лайки, шары, клики, конверсии. Сбор hourly/daily через внешние API.
- `content_templates` — шаблоны контента per channel/content-type.
- `content_assets` — медиафайлы (изображения, видео) с путями хранения (local/S3/GCS).
- `content_workflow` — audit log переходов статусов.
- `content_import_sources` — конфиги импорта из Excel, Google Sheets, CSV, RSS.

#### 2. Пользовательская PostgreSQL БД (`db_{chatId}`)

Создаётся автоматически при первой сессии через `repository.ensureSchema()` (`CREATE TABLE IF NOT EXISTS`):
- `content_jobs` — задания генерации (привязаны к `content_queue` через uuid)
- `content_posts` — сгенерированные посты (draft → ready)
- `content_assets` — медиафайлы заданий
- `content_job_queue` — async очередь с exponential backoff retry (FIFO, статусы: queued/processing/done/failed)
- `publish_logs` — audit trail публикаций по каждому каналу
- `content_topics` — темы/идеи для генерации из импорта
- `content_materials` — исходные материалы
- `content_sheet_state` — состояние строк импортированных таблиц
- `content_config` — key-value конфигурация пользователя
- `pinterest_jobs`, `pinterest_publish_logs` — Pinterest-специфика
- `vk_jobs`, `vk_publish_logs` — VK-специфика
- `ok_jobs`, `ok_publish_logs` — OK-специфика
- `video_generations` — задания генерации видео (Runway), polling статуса (pending/processing/completed/failed/timeout)

#### 3. MySQL БД (`ai_skills_db`)

Навыки AI — описано выше в разделе "MySQL — навыки AI".

---

## File System Layout

```
/var/sandbox-data/                          # DATA_ROOT
├── manage-state-{chatId}.json              # State пользователя (token, settings, история)
├── manage-state-{chatId}.json.bak          # Бэкап state
└── {chatId}/                               # Файлы пользователя (монтируются в /workspace)
    ├── apps/                               # Node.js приложения
    ├── input/, output/, work/              # Рабочие директории
    ├── log/, tmp/                          # Логи и временные файлы
    └── plans/                              # Markdown планы

/var/sandbox-backups/
└── {chatId}_{ISO_timestamp}/               # Бэкап данных пользователя (TTL 7 дней)

/var/sandbox-snapshots/
└── {chatId}/
    └── {escaped_file_path}/
        └── {timestamp}.snap               # Версии файлов (max 10 на файл, TTL 7 дней)
```

---

## Testing

Тесты в `tests/` используют встроенный `assert` Node.js (без тестового раннера):
- `tests/content.status.test.js` — переходы машины состояний контента
- `tests/validators.extended.test.js` — валидация контента, запрещённые темы, квоты
- `tests/vk.moderation.test.js` — тестирование VK модерации
- `tests/vk.publisher.test.js` — тестирование VK публикации
- `tests/test-openrouter.py` — Python тест для OpenRouter API
- `tests/check-ai-config.js` — проверка конфигурации AI провайдеров
- `tests/check-queue.js` — мониторинг очередей

Запуск одного теста: `node tests/content.status.test.js`

---

## Полный цикл авторизации пользователя

### Этап 1: Вход через auth-бота

**Точка входа:** `@clientzavod_bot` (`AUTH_BOT_TOKEN`) — один на всю систему.

1. Пользователь пишет `/start` боту → auth-бот отправляет кнопку "Войти в аккаунт"
2. Пользователь нажимает → `manage/telegram/authBot.js` делает запрос:
   ```
   POST /api/auth/telegram-login
   { "telegram_id": "123456789", "username": "@user", "first_name": "...", "last_name": "..." }
   ```

**Файлы:** `manage/telegram/authBot.js`, `routes/auth.routes.js`

### Этап 2: Поиск или создание сессии (`routes/auth.routes.js`)

Сервер ищет пользователя последовательно:
1. По `chatId = telegramId` в `manageStore`
2. По `state.verifiedTelegramId === telegramId` (перебор всех состояний)

**Существующий пользователь** — обновляет username если изменился, выдаёт `tg_login_token`.

**Новый пользователь:**
1. `sessionService.getOrCreateSession(telegramId)` — создаёт Docker-контейнер и PostgreSQL БД
2. `state.verifiedTelegramId = telegramId`, `state.verifiedUsername = username`
3. **Автоматическая привязка к боту модерации:** если `CW_BOT_TOKEN` задан и `state.token` пуст — записывает `state.token = CW_BOT_TOKEN` и вызывает `telegramRunner.startBot(telegramId, CW_BOT_TOKEN)`. `startBot()` при совпадении с `CW_BOT_TOKEN` не создаёт новый polling, а добавляет пользователя в `bots` Map через уже запущенный экземпляр cwBot → планировщик начнёт обслуживать пользователя при следующем тике (≤60 сек)
4. `manageStore.persist(telegramId)` → сохраняет состояние в файл
5. Выдаёт `tg_login_token` (hex, TTL 10 мин), редирект на `/auth.html?tg_login_token=<hex>`

### Этап 3: Веб-сессия (`/auth.html`)

`public/js/common.js` → `initAuth()`:
1. Извлекает `tg_login_token` из URL
2. `GET /api/auth/telegram-web-login?token=<hex>` — обменивает одноразовый токен на `chatId`
3. Сохраняет `chatId` в `localStorage`
4. Редирект: `onboardingComplete = false` → `/setup.html`, иначе → `/channels.html`

### Этап 4: Онбординг (`/setup.html`)

1. **Подключение к боту модерации** — пользователь нажимает **Подключить** → открывается `https://t.me/{cwBotUsername}`. Пользователь пишет боту любое сообщение → cwBot генерирует 6-значный код (`Math.floor(100000 + Math.random() * 900000)`), сохраняет в `state.pending` через `manageStore.setPending()`, отправляет код пользователю. Пользователь вводит код на странице → `POST /api/manage/telegram/verify` → `manageStore.verify()`. После подтверждения `state.verifiedTelegramId` обновляется и разблокируется кнопка **Сохранить**.

   Этот шаг обязателен: Telegram запрещает боту писать пользователю первым — без инициации разговора отправка черновиков на модерацию будет завершаться ошибкой.

2. **Выбор каналов публикации** — Telegram (обязателен), VK, OK, Pinterest, Instagram, Email, YouTube, Дзен, TikTok. Сохраняются через `setEnabledChannels(chatId, channels)` в `content_config`.

3. `onboardingComplete = true` → редирект на `/channels.html`.

---

### 13. Billing System

**`manage/tokenBilling.js`** — токен-биллинг для AI-сервисов. Отслеживает баланс ProTalk токенов и автоматически отключает AI при исчерпании.

- **Баланс чекается при каждом вызове AI Router** через `getProTalkBalance(aiAuthToken)` → `/api/balance/check`
- **Токены кэшируются** в statesCache с TTL 1 час
- **Авто-отключение:** если баланс < 0 или подписка истекла, AI режим отключается, остаётся direct command mode
- **Ручная проверка:** доступна через админ-панель (`/admin/chat.html` → кнопка "Проверить баланс")

**`manage/billingScheduler.js`** — периодическая проверка баланса всех пользователей.

- Запускается через `setInterval` в `server.js` (каждые 60 минут)
- Собирает всех пользователей с ProTalk (`aiProvider: "protalk"`)
- Проверяет баланс → обновляет кэш в statesCache
- Отключает AI для пользователей с отрицательным балансом
- Логирует статистику по балансам

**`routes/billing.routes.js`** — API для ручного управления биллингом.

| Метод | Endpoint | Описание |
|-------|----------|----------|
| GET | `/api/balance/check` | Проверить баланс ProTalk (requires chatId) |
| POST | `/api/balance/verify` | Верифицировать новый токен ProTalk |
| POST | `/api/billing/import-users` | Импорт пользователей из Excel (admin only) |

---

### 14. Webhook System

**`routes/webhook.routes.js`** — входящие вебхуки для запуска AI задач.

- Endpoint: `POST /webhook`
- Тело запроса передаётся прямо в agentLoop через `agentQueue.add(chatId, message, mode)`
- Пример использования: внешний сервис может отправлять данные → система автоматически обрабатывает их AI

**`routes/user_hooks.routes.js`** — пользовательские вебхуки `/hook/:chatId/*`.

- Каждому пользователю доступен персональный вебхук: `/hook/<chatId>`
- Входящий запрос передаётся в `/workspace/webhook_handler.js` или `/workspace/webhook_handler.py` внутри контейнера пользователя
- Пример: интеграция с внешними сервисами через уникальные URL

---

### 15. Центральный бот модерации (`CW_BOT_TOKEN`)

Единый Telegram-бот для всех пользователей системы. Используется для отправки черновиков на модерацию и обработки кнопок ✅/🔁/❌ по всем каналам (Telegram, VK, OK, Instagram, Pinterest).

**Переменные окружения:**

| Переменная | Назначение |
|-----------|-----------|
| `CW_BOT_TOKEN` | Токен бота |
| `CW_BOT_USERNAME` | Username бота (отображается в UI на `/setup.html`) |
| `WEBHOOK_URL` | Если задан — бот работает через webhook `{WEBHOOK_URL}/cw`; иначе fallback на long polling |

**Режим webhook** (`WEBHOOK_URL` задан в `.env`):
- `cwBot.telegram.setWebhook(webhookUrl)` устанавливает вебхук при старте
- Endpoint `POST /telegram/webhook/cw` в `server.js` принимает обновления и передаёт в `cwBot.handleUpdate(req.body)`
- Nginx проксирует запросы на app:3015

**Регистрация пользователей в планировщике:**
- При старте сервера: `startAllBots(cwBot)` — все пользователи с `state.token === CW_BOT_TOKEN` добавляются в `telegramRunner.bots` Map с ссылкой на cwBot
- При новой авторизации: `routes/auth.routes.js` автоматически записывает `state.token = CW_BOT_TOKEN` и вызывает `telegramRunner.startBot()`, который регистрирует пользователя без создания дублирующего polling
- Планировщики (Telegram, VK, OK, Pinterest, Instagram) итерируют по `telegramRunner.bots` каждые 60 сек

**Обработчики в `server.js`:**
- `cwBot.on('text', ...)` — генерирует 6-значный код верификации и сохраняет в `state.pending` (онбординг)
- `cwBot.action(/^content:.../)` — модерация Telegram-контента
- `cwBot.action(/^vk:.../)` — модерация VK
- `cwBot.action(/^ok:.../)` — модерация OK
- `cwBot.action(/^ig:.../)` — модерация Instagram
- `cwBot.action(/^pinterest:.../)` — модерация Pinterest

---

### 16. Snapshot Service

**`services/snapshot.service.js`** — многоуровневый undo для файлов.

- **Паттерн:** файл → каталог снапшотов → файлы `.snap`
- **Структура:** `/var/snapshot-root/{chatId}/{escaped_path}/{timestamp}.snap`
- **Автоматическое создание:** при `writeFile`, `patchFile`, `createFolder` (если размер > 10KB)
- **Max depth:** `SNAPSHOT_MAX_DEPTH` (10 версий на файл)
- **TTL:** `SNAPSHOT_TTL_DAYS` (7 дней) → автоматическая очистка
- **Методы:** `createSnapshot(file, content)`, `getSnapshots(file)`, `restoreSnapshot(file, timestamp)`

---

### 17. Project Cache Service

**`services/projectCache.service.js`** — постоянная карта файлового дерева.

- **Файлы:** `{PROJECT_CACHE_DIR}/{chatId}.json`
- **Структура:** дерево файлов с путями, типами, размерами
- **Использование:** AI контекст → экономит время сканирования контейнера
- **Обновление:** при изменении файлов через файловые API
- **TTL:** `PROJECT_CACHE_TTL_DAYS` (30 дней)
- **Max files:** `PROJECT_CACHE_MAX_FILES` (5000)

---

### 18. Buffer Service & Image Service

**`services/buffer.service.js`** — буферизация контента для генерации.

- **Охлаждение AI запросов:** если предыдущий запрос ещё в обработке, ставит в очередь
- **Rate limiting:** защита от спама AI API
- **Методы:** `shouldAllow(chatId)`, `markProcessing(chatId)`, `markDone(chatId)`

**`services/image.service.js`** — генерация изображений (KIE API).

- Интеграция с `KIE_API_KEY`
- Форматы: PNG, JPEG (указываются в промпте)
- Кэширование результатов в `/workspace/output/images/`

---

### 19. Email Integration

**`manage/email/`** — полный Email-канал.

**Processor** (`processor.js`):
- IMAP опрос почты (каждые 5 минут через cron)
- Парсинг писем → извлечение команд и вложений
- Передача в agentLoop

**Sender** (`sender.js`):
- SMTP отправка ответов
- Поддержка attachments
- Форматирование для email (противоположность Telegram HTML)

**Config**:
```javascript
{
  imap: { host: 'imap.gmail.com', user: '...', password: '...' },
  smtp: { host: 'smtp.gmail.com', user: '...', password: '...' }
}
```

---

### 20. Agent Queue

**`manage/agentQueue.js`** — FIFO очередь AI задач на пользователя.

- **Структура:** Map<chatId, Array<{id, message, mode}>>
- **Ограничения:** max 10 задач на пользователя в очереди
- **Rate limiting:** между запросами — 2 секунды cooldown
- **Методы:** `add(chatId, message, mode)`, `processNext(chatId)`, `clear(chatId)`
- **Интеграция:** используется при переполнении контекста AI или в webhook flow

---

### 21. Instagram Integration

Добавлен в v3.2.0 (но не был документирован).

**`services/instagramMvp.service.js`** — публикация в Instagram.

- `DAILY_INSTAGRAM_LIMIT = 5`
- Использует `services/instagram.service.js` (Instagram Graph API)
- Планировщик запускается в `server.js` (строки 345-346)
- Требует: `INSTAGRAM_ACCESS_TOKEN`, `INSTAGRAM_BUSINESS_ACCOUNT_ID`

**Публикация:**
- Текст + изображение (длина 2200 симв.)
- Hashtags в конце
- Авто-модерация через CW_BOT_TOKEN (кнопки ✅/❌)

---

### 22. Database Schema Updates

Новые таблицы в пользовательских БД:

**content_config** — key-value конфигурация:
```sql
CREATE TABLE content_config (
  key VARCHAR(100) PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```


---

### Summary of Key Subsystems

Все основные компоненты полностью реализованы:

1. **Авторизация** — двух-уровневая схема (auth-бот + веб-сессия), автоматическая привязка к центральному боту модерации
2. **Управление контейнерами** — Docker per-user sandbox, Docker CLI, восстановление сессий при рестарте
3. **Хранилище состояния** — in-memory + файловый бэкап с атомарными операциями
4. **Telegram-боты** — auth-бот (центральный), бот модерации (центральный, webhook/polling), пользовательские боты (опционально)
5. **Планировщики** — единая логика для всех каналов, итерирование по пользователям каждые 60 сек
6. **Content MVP** — многоканальная публикация (Telegram, VK, OK, Pinterest, Instagram), очередь FIFO, машина состояний, модерация
7. **AI Router** — маршрутизация между ProTalk/OpenAI/OpenRouter с логированием и обработкой ошибок
8. **Онбординг** — обязательное подтверждение через код верификации, выбор каналов, автоматическая настройка
9. **Admin Panel** — управление контейнерами, полное удаление пользователей (8 слоёв данных)
10. **Вебхуки** — входящие и пользовательские endpoints с интеграцией в контейнеры
11. **Снапшоты** — многоуровневый undo для файлов (10 версий, TTL 7 дней)
12. **Кэш проекта** — постоянная файловая карта для оптимизации AI контекста
13. **Буферизация** — защита от спама AI запросов и rate limiting
14. **Email интеграция** — IMAP polling и SMTP отправка
15. **Биллинг** — отслеживание баланса ProTalk с авто-отключением
16. **Snapshot Service** — версионирование файлов с TTL
17. **Database Schema** — полная миграция таблиц по каналам

Система готова к продакшену с enterprise-функциями и масштабируемой архитектурой.