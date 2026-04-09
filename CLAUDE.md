# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## Project Overview

**Docker-Claw (Клиент Завод) v3.0.0** — AI-платформа для управления изолированными Docker-контейнерами. Каждый пользователь получает персональный контейнер (Node.js-среда), персональную PostgreSQL БД и Telegram-бота. Система автоматически генерирует и публикует контент в Telegram, ВКонтакте, Одноклассники, Pinterest, Instagram, YouTube, WordPress (+ Яндекс.Дзен через RSS).

**Стек:** Node.js 18 + Express.js, PostgreSQL 15, MySQL 8 (навыки), Docker, Telegraf (Telegram Bot API), nodemailer/imap-simple/imapflow (Email), Sharp (обработка изображений), Buffer API (кросс-постинг в Pinterest/Instagram/YouTube), YouTube Data API, WordPress REST API. Фронтенд — статические HTML/CSS/JS файлы (без фреймворка). Playwright для E2E-тестов.

Дополнительно поддерживаются: публикация в YouTube (Shorts/видео) через YouTube API, кросс-постинг через Buffer (`services/buffer.service.js`), генерация видео (`services/content/video.service.js`), блог-контент с генерацией изображений (`services/blogGenerator.service.js`, `services/imageGen.service.js`).

---

## Commands

```bash
npm install          # Установить зависимости
npm run dev          # Development: nodemon + auto-reload
npm start            # Production: node server.js

# Тесты (используют встроенный assert Node.js, без тестового раннера)
npm test                                    # Запускает content.status + validators + wordpress + blog тесты
node tests/content.status.test.js           # Машина состояний контента
node tests/validators.extended.test.js      # Валидация контента
node tests/vk.moderation.test.js            # VK модерация
node tests/vk.publisher.test.js             # VK публикация
node tests/youtube.mvp.test.js              # YouTube MVP
node tests/wordpress.publisher.test.js      # WordPress публикация
node tests/blog.generator.test.js           # Генерация блог-контента
node tests/blog.moderation.test.js          # Модерация блог-контента

# E2E тесты (Playwright)
npm run test:e2e                            # Все E2E тесты (specs: critical-path, onboarding, channels, content-flow)
npm run test:e2e:smoke                      # Только critical path (0-critical-path.spec.js)

# Docker
docker-compose up -d           # Запустить все сервисы (postgres, nginx, app)
docker-compose logs -f app     # Логи приложения
docker-compose down            # Остановить все
```

Сервер работает на порту `3015`. Конфигурация: `.env` + `.env.local` (`.env.local` переопределяет `.env`). Все переменные централизованы в `config.js`.

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
- **CW Bot** (`CW_BOT_TOKEN`) — центральный бот модерации для всех пользователей. Обрабатывает верификацию и модерацию контента для всех каналов. Callback-паттерны: `content:` (TG), `vk_mod:` (VK), `ok_mod:` (OK), `ig_mod:` (Instagram, заглушка), `yt_mod:` (YouTube), `pin_mod:` (Pinterest), `wp_mod:` (WordPress). Поддерживает webhook (через `CW_BOT_WEBHOOK_URL` или `WEBHOOK_URL/cw`) и long polling (fallback)
- Режимы работы пользовательского бота: CHAT, WORKSPACE, TERMINAL

### Трёхуровневая БД

1. **Центральная PostgreSQL** (`clientzavod`) — `content_queue`, `content_channels`, `content_analytics`, `content_templates`, `content_assets`, `content_workflow`, `content_import_sources`
2. **Per-user PostgreSQL** (`db_{chatId}`) — создаётся автоматически через `repository.ensureSchema()`. Таблицы: `content_jobs`, `content_posts`, `content_job_queue`, `publish_logs`, `content_topics`, `content_config`, `content_knowledge_base`, `vk_jobs`, `ok_jobs`, `pinterest_jobs`, `video_generations`
3. **MySQL** (`ai_skills_db`) — каталог AI навыков (`ai_skills`), выбранные навыки (`user_selected_skills`). Инициализация: `services/mysql/init.sql`

### Ключевые подсистемы

| Подсистема | Точка входа | Описание |
|-----------|------------|----------|
| Сессии и контейнеры | `services/session.service.js` | In-memory Map sessions (chatId → сессия). `createSession`, `destroySession`, `recoverAllSessions` |
| Docker CLI | `services/docker.service.js` | `child_process.spawn`, контейнеры `sandbox-user-{chatId}`, блокировка опасных команд |
| Состояние пользователей | `manage/store.js` | In-memory `statesCache` + файлы `{DATA_ROOT}/manage-state-{chatId}.json` (атомарная запись через .tmp + rename) |
| AI Agent Loop | `manage/telegram/agentLoop.js` (47 KB) | Цикл рассуждений: контекст → LLM → tool_calls → toolHandlers → iterate до `task_completed` |
| Tool Handlers | `manage/telegram/toolHandlers.js` (77 KB) | Реализация инструментов AI: файлы, bash, планы, контекст |
| AI Tools Schema | `manage/telegram/tools.js` (24 KB) | JSON-определения инструментов для LLM. Три набора: `TOOLS_CHAT`, `TOOLS_WORKSPACE`, `TOOLS_TERMINAL` |
| Telegram Runner | `manage/telegram/runner.js` | Запуск/остановка per-user Telegram-ботов (`bots` Map), обработка команд, интеграция с контент-сервисами |
| AI Context | `manage/context.js` | Собирает контекст для LLM: история, файлы, persona, навыки, планы |
| AI Prompts | `manage/prompts.js` | Системные промпты по режимам, включая инструкции для каждого канала публикации |
| AI Router | `services/ai_router_service.js` | Маршрутизация к ProTalk / OpenAI / OpenRouter |
| Контент Telegram | `services/contentMvp.service.js` (88 KB) | Генерация, модерация, публикация. Планировщик каждые 60 сек |
| Контент — фасад | `services/content/index.js` | Объединяет все модули контента: repository, queue, worker, validators, limits, alerts, video |
| Контент VK | `services/vkMvp.service.js` | VK API v5.199, daily limit 5 |
| Контент OK | `services/okMvp.service.js` | OK API, daily limit 5 |
| Контент Pinterest | `services/pinterestMvp.service.js` | SEO-ориентированный контент |
| Контент Instagram | `services/instagramMvp.service.js` | Instagram Graph API, daily limit 5 |
| Контент YouTube | `services/youtubeMvp.service.js` | YouTube Data API, генерация и публикация Shorts/видео |
| Контент WordPress (блог + Дзен RSS + TG-анонс) | `services/wordpressMvp.service.js`, `services/blogGenerator.service.js`, `services/imageGen.service.js`, `services/content/wordpress.repository.js` | Per-user блог через `manageStore.getWpConfig()`. FSM `draft → ready → approved → published`, модерация через CW_BOT (`wp_mod:approve\|rewrite\|reject:{postId}`). Таблицы `content_topics`, `content_knowledge_base`. Кэш картинок: `${DATA_ROOT}/{chatId}/blog-cache/`. Эндпоинты `/api/content/wordpress/*`, `/api/content/topics`, `/api/content/knowledge`. UI: вкладка «WordPress» в `public/channels.html` + `public/js/channels-wordpress.js`. Дзен подтягивает посты из WP RSS автоматически, анонс в TG — через `contentMvp.enqueueAnnouncement` / `worker.publishBlogAnnouncement` |
| Buffer кросс-постинг | `services/buffer.service.js` | Публикация Pinterest/Instagram/YouTube через Buffer API |
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

### Маршрутизация

Основные API маршруты регистрируются в `routes/index.js` под префиксом `/api`: `/session`, `/execute`, `/files`, `/database`, `/manage`, `/plans`, `/apps`, `/content`, `/auth`, `/health`. Дополнительные роуты монтируются напрямую в `server.js`: `/admin` (password-protected, `routes/admin.routes.js`), `/sandbox` (`routes/sandbox.routes.js`), `/` (`routes/webhook.routes.js` — Telegram webhook), `/hook` (`routes/user_hooks.routes.js`). Маршруты `/api/manage/*` определены в `manage/routes.js` (каналы, AI, email, навыки, настройки). Контент-эндпоинты `/api/content/*` — в `routes/content.routes.js` (jobs, topics, materials, per-channel CRUD, WordPress, import).

Файл `routes/billing.routes.js` существует, но в текущей версии **не подключён** в `server.js`.

### Контент-пайплайн

Машина состояний: `draft → ready → approved → published` (+ `error/failed`).

Поток: AI генерирует черновик → если `premoderationEnabled` → отправка модератору через CW Bot (кнопки ✅/🔁/❌) → очередь → worker → публикация в канал. Модуль `services/content/` содержит: `index.js` (фасад), `repository.js` (CRUD), `queue.repository.js` (FIFO с retry), `worker.js`, `status.js` (FSM), `validators.js`, `limits.js`, `video.service.js`, `alerts.js`, плюс per-channel репозитории: `vk.repository.js`, `ok.repository.js`, `pinterest.repository.js`, `instagram.repository.js`, `youtube.repository.js`, `wordpress.repository.js`.

### Прямые сервисы каналов

Помимо MVP-сервисов (генерация + модерация + планировщик), существуют прямые API-обёртки: `services/vk.service.js` (VK API), `services/ok.service.js` (OK API), `services/instagram.service.js` (Instagram Graph API), `services/pinterest.service.js` (Pinterest API). Используются для низкоуровневых операций (проверка токенов, получение списков групп/досок и т.д.).

### Автоматические навыки-копирайтеры

Добавляются в AI-контекст при активном канале: `tg-copywriter` (Telegram), `vk-copywriter` (VK), `ok-copywriter` (OK). Проверка через `isTelegramChannelActive(chatId)` и аналогичные функции в `manage/context.js`.

### Онбординг

`/setup.html` → подключение к CW Bot (верификация 6-значным кодом через `manageStore.setPending/verify`) → выбор каналов публикации → `onboardingComplete = true` → `/channels.html`.

### Admin Panel

`/admin/*` (защита через `ADMIN_PASSWORD`). Управление контейнерами, навыками, чат с пользователями. Страницы: `login.html`, `containers.html`, `container-manage.html`, `chat.html`, `skills.html`. **Kill operation** (`DELETE /admin/container/:chatId/kill`) — полное удаление 8 слоёв данных (контейнер, PostgreSQL, файлы, state, бэкапы, снапшоты, MySQL, сессия).

### Web UI (public/)

Страницы: `index.html` (лендинг), `auth.html` (авторизация), `setup.html` (онбординг), `channels.html` (управление каналами), `content.html` (контент), `console.html` (терминал), `files.html` (файлы), `ai.html` (AI-чат), `apps.html` (приложения), `tasks.html` (задачи), `skills.html` (навыки), `balance.html` (баланс), `info.html` (информация). JS-модули: `public/js/` (common.js, channels.js, channels-wordpress.js, personalization.js и др.).

### Файловая система

```
/var/sandbox-data/                     # DATA_ROOT
├── manage-state-{chatId}.json         # State пользователя
├── manage-state-{chatId}.json.bak     # Бэкап state
└── {chatId}/                          # → /workspace в контейнере

/var/sandbox-backups/{chatId}_{timestamp}/   # TTL 7 дней
/var/sandbox-snapshots/{chatId}/{path}/{ts}.snap
```

### Авторизация

Auth Bot → `POST /api/auth/telegram-login` → one-time hex token (TTL 10 мин) → `/auth.html` → `initAuth()` в `public/js/common.js` → `chatId` в localStorage. Новый пользователь: авто-привязка к CW Bot (`state.token = CW_BOT_TOKEN`). Также поддерживается admin-авторизация через query-параметры `admin_auth` + `chatId` (одноразовый токен в `state.adminAuthToken`).

### Миграции

SQL-миграции хранятся в `migrations/`: `001_add_billing_tables.sql`, `20260325_add_vk_integration.sql`. Применяются вручную.

### Документация проекта

Каталог `documents/` содержит планы интеграций, описания задач и отчёты о выполнении для каждого канала (VK, OK, Pinterest, Instagram, YouTube, WordPress, Buffer). Дополнительные документы: `KODA.md`, `QWEN.md`, `ROLE.md`, `PROCESSES.md`, `TASKS_BILLING.md`.
