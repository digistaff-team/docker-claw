# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## Project Overview

**Docker-Claw (Клиент Завод) v3.0.0** — AI-платформа для управления изолированными Docker-контейнерами. Каждый пользователь получает персональный контейнер (Node.js-среда), персональную PostgreSQL БД и Telegram-бота. Система автоматически генерирует и публикует контент в Telegram, ВКонтакте, Одноклассники, Pinterest, Instagram (фото + Reels), TikTok, YouTube, Facebook, WordPress (+ Яндекс.Дзен через RSS), а также VK Video.

**Стек:** Node.js 18 + Express.js, PostgreSQL 15, MySQL 8 (навыки), Docker, Telegraf (Telegram Bot API), nodemailer/imap-simple/imapflow (Email), Sharp (обработка изображений), Buffer API (кросс-постинг в Pinterest/Instagram/YouTube), YouTube Data API, WordPress REST API, KIE.ai API (генерация видео). Фронтенд — статические HTML/CSS/JS файлы (без фреймворка). Playwright для E2E-тестов.

---

## Commands

```bash
npm install          # Установить зависимости
npm run dev          # Development: nodemon + auto-reload
npm start            # Production: node server.js

# Тесты (используют встроенный assert Node.js, без тестового раннера)
npm test                                    # Запускает все unit-тесты из package.json (8 файлов)
node tests/content.status.test.js           # Машина состояний контента
node tests/validators.extended.test.js      # Валидация контента
node tests/wordpress.publisher.test.js      # WordPress публикация
node tests/blog.generator.test.js           # Генерация блог-контента
node tests/blog.moderation.test.js          # Модерация блог-контента
node tests/video.pipeline.test.js           # Видео-пайплайн (VK Video, TikTok, CHANNELS count)
node tests/inputImageContext.test.js        # Парсинг файлов input/ для видео-пайплайна
node tests/channel.topics.test.js           # normalizeChannel + фильтрация тем по каналу

# Тесты, не входящие в npm test (запускать отдельно при работе с этими сервисами)
node tests/vk.moderation.test.js            # VK модерация
node tests/vk.publisher.test.js             # VK публикация
node tests/youtube.mvp.test.js              # YouTube MVP

# E2E тесты (Playwright)
npm run test:e2e                            # Все E2E тесты (specs: critical-path, onboarding, channels, content-flow)
npm run test:e2e:smoke                      # Только critical path (0-critical-path.spec.js)

# Docker
docker-compose restart app     # Перезапуск приложения (применяет изменения кода)
docker-compose up -d           # Запустить все сервисы (postgres, nginx, app)
docker-compose logs -f app     # Логи приложения
docker-compose down            # Остановить все
```

Сервер работает на порту `3015`. Конфигурация: `.env` + `.env.local` (`.env.local` переопределяет `.env`). Все переменные централизованы в `config.js`.

**Важно:** сервер запускается через `node server.js` (без nodemon в production). При изменении любого backend-файла необходим `docker-compose restart app`.

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
Пользователь управляет контейнером через Telegram-бота / Web UI / Email / Webhook
    ↓
AI агент (agentLoop) обрабатывает сообщения через LLM с tool-calling
    ↓
Контент генерируется и публикуется в каналы по расписанию (каждые 60 сек)
```

### Двух-бот система Telegram

- **Auth Bot** (`AUTH_BOT_TOKEN`, `manage/telegram/authBot.js`) — один на систему, обрабатывает `/start`, выдаёт одноразовый login-токен
- **CW Bot** (`CW_BOT_TOKEN`) — центральный бот модерации для всех пользователей. Обрабатывает верификацию и модерацию контента. Callback-паттерны: `content:` (TG), `vk_mod:` (VK), `ok_mod:` (OK), `ig_mod:` (Instagram), `yt_mod:` (YouTube), `pin_mod:` (Pinterest), `wp_mod:` (WordPress), `tt_mod:` (TikTok), `vk_vid_mod:` (VK Video). Поддерживает webhook (через `CW_BOT_WEBHOOK_URL` или `WEBHOOK_URL/cw`) и long polling (fallback)
- Режимы работы пользовательского бота: CHAT, WORKSPACE, TERMINAL

### Трёхуровневая БД

1. **Центральная PostgreSQL** (`clientzavod`) — `content_queue`, `content_channels`, `content_analytics`, `content_templates`, `content_assets`, `content_workflow`, `content_import_sources`
2. **Per-user PostgreSQL** (`db_{chatId}`) — создаётся автоматически через `repository.ensureSchema()`. Таблицы: `content_jobs`, `content_posts`, `content_job_queue`, `publish_logs`, `content_topics`, `content_config`, `content_knowledge_base`, `vk_jobs`, `ok_jobs`, `pinterest_jobs`, `facebook_jobs`, `video_assets`, `video_interiors`, `video_usage_marks`
3. **MySQL** (`ai_skills_db`) — каталог AI навыков (`ai_skills`), выбранные навыки (`user_selected_skills`). Инициализация: `services/mysql/init.sql`

### Ключевые подсистемы

| Подсистема | Точка входа | Описание |
|-----------|------------|----------|
| Сессии и контейнеры | `services/session.service.js` | In-memory Map sessions (chatId → сессия). `createSession`, `destroySession`, `recoverAllSessions` |
| Docker CLI | `services/docker.service.js` | `child_process.spawn`, контейнеры `sandbox-user-{chatId}`, блокировка опасных команд |
| Состояние пользователей | `manage/store.js` | In-memory `statesCache` + файлы `{DATA_ROOT}/manage-state-{chatId}.json` (атомарная запись через .tmp + rename). Хранит настройки всех каналов, `videoPipelineSettings` (выбранная модель, дефолт `{ model: 'veo3.1' }`) |
| AI Agent Loop | `manage/telegram/agentLoop.js` (47 KB) | Цикл рассуждений: контекст → LLM → tool_calls → toolHandlers → iterate до `task_completed` |
| Tool Handlers | `manage/telegram/toolHandlers.js` (77 KB) | Реализация инструментов AI: файлы, bash, планы, контекст |
| AI Tools Schema | `manage/telegram/tools.js` (24 KB) | JSON-определения инструментов для LLM. Три набора: `TOOLS_CHAT`, `TOOLS_WORKSPACE`, `TOOLS_TERMINAL` |
| Telegram Runner | `manage/telegram/runner.js` | Запуск/остановка per-user Telegram-ботов (`bots` Map), обработка команд, интеграция с контент-сервисами |
| AI Context | `manage/context.js` | Собирает контекст для LLM: история, файлы, persona, навыки, планы |
| AI Prompts | `manage/prompts.js` | Системные промпты по режимам, включая инструкции для каждого канала публикации |
| AI Router | `services/ai_router_service.js` | Маршрутизация к ProTalk / OpenAI / OpenRouter |
| Контент Telegram | `services/telegramMvp.service.js` | Генерация, модерация, публикация в Telegram. Планировщик каждые 60 сек. Содержит `normalizeChannel` + `VALID_CHANNELS` |
| Контент общий | `services/contentMvp.service.js` (88 KB) | Оркестрация между каналами, enqueueAnnouncement, blog announcements |
| Контент — фасад | `services/content/index.js` | Объединяет все модули: repository, queue, worker, validators, limits, alerts, video |
| Контент VK | `services/vkMvp.service.js` | VK API v5.199, daily limit 5 |
| Контент OK | `services/okMvp.service.js` | OK API, daily limit 5 |
| Контент Pinterest | `services/pinterestMvp.service.js` | SEO-ориентированный контент |
| Контент Instagram | `services/instagramMvp.service.js` | Instagram Graph API, daily limit 5. Фото-посты: `reserveNextTopic(chatId, 'instagram')`. Reels: `tickIgReelsSchedule` → `reserveNextTopic(chatId, 'instagram_reels')` → `handleIgVideoGenerateJob`. Видео-черновики имеют флаг `isVideo: true` для маршрутизации модерации |
| Контент YouTube | `services/youtubeMvp.service.js` | YouTube Data API, генерация и публикация Shorts/видео через общий видео-пайплайн |
| Контент Facebook | `services/facebookMvp.service.js` | Facebook Graph API. `facebook_jobs` содержит `topic_id` для отслеживания жизненного цикла топика. `releaseTopic` вызывается в catch-блоке при ошибках генерации |
| Контент TikTok | `services/tiktokMvp.service.js` | Генерация, модерация (CW Bot `tt_mod:`), публикация TikTok видео. Использует общий видео-пайплайн |
| VK Video | `services/vkVideoMvp.service.js` | VK Video: `video.save` → multipart upload → `wall.post`. Модерация через CW Bot `vk_vid_mod:`. Планировщик + daily limit |
| Видео-пайплайн | `services/videoPipeline.service.js` | Общий пайплайн для TikTok/VK Video/YouTube/Instagram Reels: фото товара → KIE.ai сцена → KIE.ai видео. Три адаптера: Veo 3.1 (polling), Seedance 2.0 (webhook), Grok Imagine (webhook). `pendingCallbacks` Map для async webhook-резолюции |
| Видео репозиторий | `services/content/videoPipeline.repository.js` | Таблицы `video_assets`, `video_interiors`, `video_usage_marks`. Константа `CHANNELS = ['youtube','tiktok','instagram','vk']` |
| Контент WordPress | `services/wordpressMvp.service.js`, `services/blogGenerator.service.js` | Per-user блог. FSM `draft → ready → approved → published`, модерация через CW Bot `wp_mod:`. Кэш картинок: `${DATA_ROOT}/{chatId}/blog-cache/` |
| Buffer кросс-постинг | `services/buffer.service.js` | Публикация Pinterest/Instagram/YouTube через Buffer API |
| Очистка output/content | `services/outputContentCleanup.service.js` | Ежедневная очистка `/workspace/output/content` в 05:00 МСК для всех активных контейнеров |
| Алерты контента | `services/content/alerts.js` | Уведомления о сбоях/лимитах в контент-пайплайне |
| Биллинг | `manage/tokenBilling.js`, `manage/billingScheduler.js` | Баланс ProTalk, авто-отключение AI при исчерпании |
| Баланс API | `services/balance.service.js` | Запрос баланса пользователя через Dialog AI API |
| Email | `manage/email/` (`processor.js`) | IMAP polling (cron) + SMTP отправка |
| Agent Queue | `manage/agentQueue.js` | FIFO очередь AI задач, max 10 на пользователя, 2 сек cooldown |
| Снапшоты | `services/snapshot.service.js` | Многоуровневый undo (10 версий, TTL 7 дней) |
| Project Cache | `services/projectCache.service.js` | Кэш файлового дерева для AI контекста (TTL 30 дней) |
| Хранилище | `services/storage.service.js` | Инициализация DATA_ROOT, бэкапы пользователей, очистка старых бэкапов |
| PostgreSQL | `services/postgres.service.js` | Управление per-user PostgreSQL БД |
| MySQL | `services/mysql.service.js` | Пул соединений MySQL для ai_skills_db |
| Планы | `services/plan.service.js` | Управление пользовательскими планами для AI-агента |
| Зависимости | `services/deps.service.js` | Установка npm/pip зависимостей в контейнере |
| Изображения | `services/image.service.js`, `services/imageGen.service.js` | Утилиты для обработки и генерации изображений |
| Input контекст | `services/inputImageContext.service.js` | Сканирует `/workspace/input` контейнера: выбирает случайное изображение и первый .txt/.md файл (до 500 символов) для подстановки в промпт генерации. Чистая функция `_parseFiles` экспортируется для тестов |

### Маршрутизация

Основные API маршруты регистрируются в `routes/index.js` под префиксом `/api`: `/session`, `/execute`, `/files`, `/database`, `/manage`, `/plans`, `/apps`, `/content`, `/auth`, `/health`. Дополнительные роуты монтируются напрямую в `server.js` (порядок важен):
- `/admin` (password-protected) → `routes/admin.routes.js`
- `/sandbox` → `routes/sandbox.routes.js`
- `/api` → `routes/index.js`
- `/api/video` → `routes/video.routes.js` (регистрируется **до** `'/'` внутри `startServer()`)
- `/hook` → `routes/user_hooks.routes.js`
- `/` → `routes/webhook.routes.js` (регистрируется **последним**, т.к. перехватывает все пути)

Маршруты `/api/manage/*` определены в `manage/routes.js` (каналы, AI, email, навыки, настройки). Включают эндпоинты VK Video: `GET/POST /api/manage/channels/vk-video`, `POST /api/manage/channels/vk-video/run-now`. Контент-эндпоинты `/api/content/*` — в `routes/content.routes.js`.

Файл `routes/billing.routes.js` существует, но в текущей версии **не подключён** в `server.js`.

### Фильтрация тем по каналу

Каждый канал публикаций резервирует топики только для себя через `reserveNextTopic(chatId, channel)` в `services/content/repository.js`. Топики с `channel IS NULL` в таблице `content_topics` считаются универсальными и доступны всем каналам.

**11 допустимых значений `content_topics.channel`:** `telegram`, `vk`, `vk_video`, `ok`, `instagram`, `instagram_reels`, `facebook`, `pinterest`, `youtube`, `wordpress`, `tiktok`.

Валидация и нормализация через `normalizeChannel(value)` + `VALID_CHANNELS` Set в `services/telegramMvp.service.js`. При импорте из Google Sheets колонка `channel` разбирается в `previewContentImport`.

**Жизненный цикл топика:**
- `reserveNextTopic` → `status = 'used'`
- Ошибка генерации → `repository.releaseTopic(chatId, topicId)` → `status = 'pending'`
- Успешная публикация → `repository.updateTopicStatus(chatId, topicId, 'completed')`

Все MVP-сервисы реализуют этот паттерн. Facebook хранит `topic_id` в таблице `facebook_jobs` для вызова `updateTopicStatus` после публикации через модератора.

### Видео-пайплайн (KIE.ai)

Процесс: случайное фото товара из `/workspace/input` + случайный интерьер из БД → KIE.ai image-to-image (сцена) → KIE.ai image-to-video → временная папка → канал забирает по расписанию → все 4 канала использовали → таймер 60 мин → удаление.

Адаптеры `generateVideoFromScene` (диспетчер):
- **Veo 3.1** (`veo3.1`) — `POST /api/v1/veo/generate` + polling `GET /api/v1/veo/get-1080p-video`
- **Seedance 2.0** (`seedance-2`) — `POST /api/v1/jobs/createTask` с `callBackUrl`, webhook-резолюция через `pendingCallbacks` Map
- **Grok Imagine** (`grok-imagine`) — аналогично Seedance, `duration` передаётся строкой `'8'`

Webhook endpoint: `POST /api/video/callback/:chatId/:videoId` → `videoPipeline.resolveVideoCallback(videoId, body)`.

Выбор модели хранится в `manageStore.getVideoPipelineSettings(chatId).model` (дефолт `'veo3.1'`) и выставляется через `GET/POST /api/video/settings`.

Временные файлы: `VIDEO_TEMP_ROOT` (по умолчанию `{DATA_ROOT}/.video-temp/{chatId}/`). Публичные URL для KIE.ai: `/api/video/temp/:chatId/:filename` (сцены) и `/api/video/input/:chatId/:filename` (фото товаров из input/).

### Контент-пайплайн

Машина состояний: `draft → ready → approved → published` (+ `error/failed`).

Поток: AI генерирует черновик → если `premoderationEnabled` → отправка модератору через CW Bot (кнопки ✅/🔁/❌) → очередь → worker → публикация в канал. Модуль `services/content/` содержит: `index.js` (фасад), `repository.js` (CRUD + `reserveNextTopic`/`releaseTopic`), `queue.repository.js` (FIFO с retry), `worker.js`, `status.js` (FSM), `validators.js`, `limits.js`, `video.service.js`, `alerts.js`, плюс per-channel репозитории.

### Прямые сервисы каналов

Помимо MVP-сервисов (генерация + модерация + планировщик), существуют прямые API-обёртки: `services/vk.service.js`, `services/ok.service.js`, `services/instagram.service.js`, `services/pinterest.service.js`. Используются для низкоуровневых операций (проверка токенов, получение списков групп/досок и т.д.).

### Автоматические навыки-копирайтеры

Добавляются в AI-контекст при активном канале: `tg-copywriter` (Telegram), `vk-copywriter` (VK), `ok-copywriter` (OK). Проверка через `isTelegramChannelActive(chatId)` и аналогичные функции в `manage/context.js`.

### Онбординг

`/setup.html` → подключение к CW Bot (верификация 6-значным кодом через `manageStore.setPending/verify`) → выбор каналов публикации → `onboardingComplete = true` → `/channels.html`.

### Admin Panel

`/admin/*` (защита через `ADMIN_PASSWORD`). Страницы: `login.html`, `containers.html`, `container-manage.html`, `chat.html`, `skills.html`, `postgresql.html`, `tasks.html`, `apps.html`. Роуты в `routes/admin.routes.js`.

**Kill operation** (`DELETE /admin/container/:chatId/kill`) — полное удаление 8 слоёв данных (контейнер, PostgreSQL, файлы, state, бэкапы, снапшоты, MySQL, сессия).

### Web UI (public/)

Пользовательские страницы: `index.html` (лендинг), `auth.html` (авторизация), `setup.html` (онбординг), `channels.html` (управление каналами), `content.html` (темы/материалы/очередь), `console.html` (терминал), `files.html` (файлы), `ai.html` (AI-чат), `video.html` (видео-пайплайн), `skills.html` (навыки), `balance.html` (баланс), `info.html` (информация). Страницы `apps.html` и `tasks.html` перенесены в `/admin/`.

Навигационное меню рендерится через `renderMenu(activePath)` в `public/js/common.js`. Каждая страница вызывает `renderMenu('/page.html')` и `initAuth()` внутри `window.addEventListener('load', ...)`.

**Frontend auth pattern:** `common.js` объявляет `let currentChatId` и `getChatId()`. Каждый page-specific JS (например `video.js`, `content.js`) определяет `async function onLoginSuccess()`, которую `common.js` вызывает после успешной авторизации. Не объявлять `let currentChatId` повторно в page-specific JS — это вызовет `SyntaxError: Identifier already been declared`.

### Файловая система

```
/var/sandbox-data/                     # DATA_ROOT
├── manage-state-{chatId}.json         # State пользователя
├── manage-state-{chatId}.json.bak     # Бэкап state
├── .video-temp/{chatId}/              # Временные файлы видео-пайплайна
└── {chatId}/                          # → /workspace в контейнере
    ├── input/                         # Фото товаров для видео-пайплайна
    └── output/content/                # Очищается ежедневно в 05:00 МСК

/var/sandbox-backups/{chatId}_{timestamp}/   # TTL 7 дней
/var/sandbox-snapshots/{chatId}/{path}/{ts}.snap
```

### Авторизация

Auth Bot → `POST /api/auth/telegram-login` → one-time hex token (TTL 10 мин) → `/auth.html` → `initAuth()` в `public/js/common.js` → `chatId` в localStorage. Новый пользователь: авто-привязка к CW Bot (`state.token = CW_BOT_TOKEN`). Также поддерживается admin-авторизация через query-параметры `admin_auth` + `chatId` (одноразовый токен в `state.adminAuthToken`).

### Миграции

SQL-миграции хранятся в `migrations/`: `001_add_billing_tables.sql`, `20260325_add_vk_integration.sql`. Применяются вручную.

### Документация проекта

Каталог `documents/` содержит планы интеграций, описания задач и отчёты о выполнении для каждого канала (VK, OK, Pinterest, Instagram, YouTube, WordPress, Buffer). Дополнительные документы: `KODA.md`, `QWEN.md`, `ROLE.md`, `PROCESSES.md`, `TASKS_BILLING.md`. Спецификации фич: `docs/superpowers/specs/` (например `2026-04-14-channel-topic-filtering-design.md`).
