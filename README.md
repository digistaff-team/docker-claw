# 🦞 Docker Claw

Платформа для запуска изолированных Docker-контейнеров под каждого пользователя. Управляй своим окружением через веб-интерфейс, Telegram, Email или HTTP-вебхуки — с AI-агентом, который сам выполняет команды, читает контекст и отвечает осмысленно.

---

## ✨ Возможности

- **Изолированный sandbox на пользователя** — каждый получает отдельный Docker-контейнер с ограничением CPU и памяти
- **AI-агент в цикле** — агент сам решает, какие команды запустить, проверяет результаты и формирует осмысленный ответ
- **Мультиканальное управление** — Telegram-бот, Email (IMAP/SMTP), HTTP-вебхуки
- **Веб-интерфейс** — панель для сессий, файлов, задач, приложений, каналов и настроек AI
- **Персистентное хранилище** — данные выживают при перезапуске через bind-mount и PostgreSQL на пользователя
- **Снапшоты** — многоуровневый undo для файлов, старые снапшоты чистятся автоматически
- **Авто-бэкап и восстановление** — периодические бэкапы с настраиваемым retention; все сессии восстанавливаются при старте сервера
- **Персонализация** — личность AI и контекст пользователя хранятся в файлах `IDENTITY.md`, `SOUL.md`, `USER.md`, `MEMORY.md` внутри контейнера
- **Кэш проекта** — постоянная карта файлового дерева для быстрого построения контекста AI
- **Вебхуки** — входящие вебхуки запускают задачи агента; пользовательские хуки доступны на `/hook/:id`

---

## 🏗️ Архитектура

```
┌──────────────────────────────────────────────────────┐
│                    Express Server                    │
│  /api/session  /api/execute  /api/files  /api/db     │
│  /api/manage   /api/plans    /api/apps   /sandbox    │
│  /webhook      /hook/:id                             │
└─────────────┬───────────────────────┬────────────────┘
              │                       │
     ┌────────▼────────┐    ┌─────────▼──────────┐
     │  Docker Service │    │  PostgreSQL Service │
     │  (контейнер     │    │  (БД на пользов.,  │
     │   на юзера)     │    │  авто-провижн)     │
     └────────┬────────┘    └────────────────────┘
              │
     ┌────────▼──────────────────────────────────┐
     │              manage/                      │
     │  Telegram Bot  │  Email Poller  │  Hooks  │
     │  (Telegraf)    │  (IMAP cron)   │         │
     └────────────────┴────────────────┴─────────┘
              │
     ┌────────▼─────────┐
     │   Agent Loop     │  ← LLM + tool calls (executeCommand)
     │  (agentLoop.js)  │
     └──────────────────┘
```

---

## 🐳 Docker-образ для sandbox

Проект использует официальный образ Microsoft Dev Containers:

```
mcr.microsoft.com/devcontainers/javascript-node:20-bookworm
```

Это образ на базе **Debian 12 (Bookworm)** с предустановленным **Node.js 20**. Никаких дополнительных действий не нужно — образ скачается автоматически при первом старте сессии.

При создании контейнера сервер автоматически доустанавливает внутрь:

| Инструмент | Назначение |
|---|---|
| `yarn`, `pnpm` | Менеджеры пакетов |
| `nodemon`, `pm2` | Запуск и мониторинг процессов |
| `typescript`, `ts-node` | TypeScript |
| `eslint`, `prettier` | Линтинг и форматирование |
| `vite` | Сборка фронтенда |

Также создаётся структура рабочих папок внутри `/workspace`:

```
/workspace/
├── input/    ← входные данные
├── output/   ← результаты работы
├── work/     ← основная рабочая директория
├── log/      ← логи
├── apps/     ← установленные приложения
└── tmp/      ← временные файлы
```

### Использование кастомного образа

Если нужен другой стек (Python, Go и т.д.), задай свой образ в `.env`:

```env
DOCKER_IMAGE=my-custom-image:latest
```

Минимальные требования к образу: наличие `bash` и `sleep`.

Пример минимального Dockerfile:

```dockerfile
FROM ubuntu:22.04
RUN apt-get update && apt-get install -y bash python3 python3-pip curl git
WORKDIR /workspace
CMD ["bash"]
```

```bash
docker build -t my-custom-image:latest .
```

---

## 🚀 Установка

### Требования

- Linux-сервер (Ubuntu 20.04+)
- [Docker Engine](https://docs.docker.com/engine/install/ubuntu/) (не Docker Desktop)
- Node.js 18+ и npm
- PostgreSQL 14+

### 1. Установка Docker

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
newgrp docker

# Проверка
docker --version
docker run hello-world
```

### 2. Установка PostgreSQL

```bash
sudo apt update
sudo apt install -y postgresql postgresql-contrib
sudo systemctl enable --now postgresql

# Задаём пароль для пользователя postgres
sudo -u postgres psql -c "ALTER USER postgres WITH PASSWORD 'your_password';"
```

### 3. Клонирование и зависимости

```bash
git clone https://github.com/atiksorg/docker-claw.git
cd docker-claw
npm install
```

### 4. Конфигурация `.env`

```env
PORT=3015

# PostgreSQL
PG_HOST=172.17.0.1
PG_PORT=5432
PG_USER=postgres
PG_PASSWORD=your_password

# Пути для хранения данных (должны быть доступны для записи)
DATA_ROOT=/var/sandbox-data
BACKUP_ROOT=/var/sandbox-backups
SNAPSHOT_ROOT=/var/sandbox-snapshots

# Docker sandbox
DOCKER_IMAGE=mcr.microsoft.com/devcontainers/javascript-node:20-bookworm
CONTAINER_MEMORY=1g
CONTAINER_CPUS=2.0
CONTAINER_TIMEOUT=86400

# Расписание бэкапов (часы)
BACKUP_INTERVAL_HOURS=168
```

Создать рабочие директории:

```bash
sudo mkdir -p /var/sandbox-data /var/sandbox-backups /var/sandbox-snapshots
sudo chown -R $USER:$USER /var/sandbox-data /var/sandbox-backups /var/sandbox-snapshots
```

### 5. Запуск

```bash
# Продакшн
npm start

# Разработка (авто-перезагрузка)
npm run dev
```

Сервер доступен на `http://localhost:3015`.

---

### Запуск через systemd (рекомендуется)

```ini
# /etc/systemd/system/docker-claw.service
[Unit]
Description=ProTalk Claw
After=network.target docker.service postgresql.service

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/docker-claw
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=10
EnvironmentFile=/home/ubuntu/docker-claw/.env

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now docker-claw
sudo systemctl status docker-claw
```

---

## 🤝 Интеграция с ProTalk

[ProTalk](https://pro-talk.ru) — платформа, через которую подключается AI-ассистент. Для активации агента нужны два параметра: **Bot ID** и **Bot Token**.

### Как получить Bot ID и Bot Token

1. Зарегистрируйся на [pro-talk.ru](https://pro-talk.ru)
2. Создай бота в личном кабинете
3. Скопируй выданные `bot_id` и `bot_token`

### Настройка в интерфейсе

1. Открой раздел **ИИ** в веб-панели
2. Заполни поля:

| Поле | Описание |
|---|---|
| **Bot ID** | Идентификатор бота из личного кабинета ProTalk |
| **Bot Token** | Секретный токен бота из личного кабинета ProTalk |
| **Email** | Email аккаунта на ProTalk (используется для проверки баланса) |
| **Модель** | Выбери LLM-модель для агента |

3. Нажми **Сохранить** — сервер проверит баланс и переключит Telegram-бот (или Email-канал) в режим AI-агента

### Что меняется после подключения

Без ProTalk — команды из Telegram / Email выполняются напрямую в контейнере и возвращают сырой вывод.

После подключения — каждое сообщение обрабатывается AI-агентом: он получает контекст окружения, сам решает какие команды запустить, анализирует результаты и отвечает осмысленно. Агент также может отправлять файлы из контейнера прямо в чат.

### Проверка баланса

При сохранении настроек сервер автоматически проверяет баланс аккаунта на ProTalk. Если баланс исчерпан или истёк срок подписки — настройки сохраняются, но AI-режим отключается с предупреждением. После пополнения баланса достаточно пересохранить настройки.

---

## ⚙️ Справочник переменных окружения

| Переменная | По умолчанию | Описание |
|---|---|---|
| `PORT` | `3015` | Порт HTTP-сервера |
| `PG_HOST` | `172.17.0.1` | Хост PostgreSQL |
| `PG_PORT` | `5432` | Порт PostgreSQL |
| `PG_USER` | `postgres` | Пользователь PostgreSQL |
| `PG_PASSWORD` | — | Пароль PostgreSQL |
| `DATA_ROOT` | `/var/sandbox-data` | Корень хранилища пользователей |
| `BACKUP_ROOT` | `/var/sandbox-backups` | Директория бэкапов |
| `SNAPSHOT_ROOT` | `/var/sandbox-snapshots` | Директория снапшотов |
| `DOCKER_IMAGE` | `mcr.microsoft.com/devcontainers/javascript-node:20-bookworm` | Образ sandbox-контейнера |
| `CONTAINER_MEMORY` | `1g` | Лимит памяти на контейнер |
| `CONTAINER_CPUS` | `2.0` | Лимит CPU на контейнер |
| `CONTAINER_TIMEOUT` | `86400` | Время жизни контейнера (сек) |
| `SESSION_MAX_IDLE_MS` | `86400000` | Таймаут простоя сессии (24ч) |
| `BACKUP_INTERVAL_HOURS` | `168` | Интервал авто-бэкапа (7 дней) |
| `SNAPSHOT_MAX_DEPTH` | `10` | Максимальная глубина undo на файл |
| `SNAPSHOT_TTL_DAYS` | `7` | Срок хранения снапшота (дни) |
| `PROJECT_CACHE_MAX_FILES` | `5000` | Макс. файлов в кэше проекта |
| `PROJECT_CACHE_TTL_DAYS` | `30` | Срок жизни кэша проекта (дни) |

---

## 📡 API

Все маршруты с префиксом `/api`.

| Маршрут | Описание |
|---|---|
| `GET /api/health` | Health-check, количество активных сессий |
| `/api/session/*` | Создание / получение / удаление сессий |
| `/api/execute/*` | Выполнение команд внутри контейнера |
| `/api/files/*` | Загрузка, скачивание, листинг файлов |
| `/api/database/*` | Управление PostgreSQL-базой пользователя |
| `/api/manage/*` | Настройка каналов (Telegram/Email) и AI |
| `/api/plans/*` | Управление планами задач |
| `/api/apps/*` | Реестр установленных приложений |
| `/sandbox/*` | Прокси к sandbox-эндпоинтам |
| `/webhook` | Входящий вебхук → задача агента |
| `/hook/:id` | Пользовательские вебхуки |

---

## 📱 Каналы управления

### Telegram

1. Открой страницу **Каналы** в веб-интерфейсе
2. Вставь токен бота (от [@BotFather](https://t.me/BotFather))
3. Сервер запустит бота и отправит одноразовый код первому написавшему
4. Введи код в интерфейсе для привязки аккаунта

### Email (IMAP / SMTP)

1. Открой страницу **Каналы** и заполни IMAP + SMTP-настройки
2. Сервер будет опрашивать почту по заданному интервалу (по умолчанию — каждые 5 минут)
3. Каждое письмо запускает агента; ответ отправляется обратно отправителю

---

## 📁 Структура проекта

```
├── server.js                  # Точка входа
├── config.js                  # Централизованная конфигурация
├── routes/                    # Express-маршруты
│   ├── session.routes.js
│   ├── execute.routes.js
│   ├── files.routes.js
│   ├── database.routes.js
│   ├── plans.routes.js
│   ├── apps.routes.js
│   ├── sandbox.routes.js
│   ├── webhook.routes.js
│   └── user_hooks.routes.js
├── services/                  # Бизнес-логика
│   ├── docker.service.js      # Жизненный цикл контейнеров
│   ├── session.service.js     # Управление сессиями
│   ├── storage.service.js     # Хранилище файлов и бэкапы
│   ├── snapshot.service.js    # Многоуровневый undo
│   ├── postgres.service.js    # Провижн БД на пользователя
│   ├── ai_router_service.js   # Роутинг к LLM
│   ├── plan.service.js        # Планы задач
│   ├── balance.service.js
│   ├── deps.service.js
│   └── projectCache.service.js
├── manage/                    # Интеграции каналов и AI
│   ├── telegram/              # Telegraf-бот (runner, agent, tools)
│   ├── email/                 # IMAP-опросчик и SMTP-отправитель
│   ├── agentQueue.js          # Очередь на пользователя
│   ├── context.js             # Построитель контекста
│   ├── prompts.js             # Системные промпты
│   ├── routes.js              # /api/manage эндпоинты
│   └── store.js               # Персистентное состояние каналов
├── public/                    # Веб-интерфейс (HTML + JS + CSS)
└── bash_ai_external_call.py   # Внешний вызов AI-агента
```

---

## 🔒 Безопасность

- Каждый контейнер изолирован Docker с лимитами памяти, CPU и PID (`--pids-limit=200`)
- Доступ к сессии контролируется по `chatId`; Telegram-канал требует одноразовую верификацию
- Опасные команды (`rm -rf /`, fork-bomb, запись в блочные устройства) заблокированы на уровне сервиса
- Лимит на выполнение команды — 30 секунд; лимит на загрузку файла — 100 МБ
- Рекомендуется запускать сервер за обратным прокси (nginx / Caddy) с TLS

---

## 📝 Лицензия

MIT