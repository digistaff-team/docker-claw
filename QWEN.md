# Клиент Завод (Docker-Claw) — Project Context

## Project Overview

**Клиент Завод** (Client Factory) is a multi-tenant SaaS platform that provides isolated Docker containers for each user, managed through a web interface, Telegram bots, Email, or HTTP webhooks. The platform features an AI agent that autonomously executes commands, reads context, and provides meaningful responses.

### Core Capabilities

- **Per-user isolated sandbox** — Each user gets a separate Docker container with CPU and memory limits
- **AI agent in the loop** — Agent decides which commands to run, checks results, and forms responses
- **Multi-channel management** — Telegram bot, Email (IMAP/SMTP), HTTP webhooks
- **Web interface** — Dashboard for sessions, files, tasks, apps, channels, and AI settings
- **Persistent storage** — Data survives restarts via bind-mount and per-user PostgreSQL
- **Snapshots** — Multi-level undo for files, old snapshots auto-cleaned
- **Auto-backup & restore** — Periodic backups with configurable retention
- **Personalization** — AI personality and user context stored in `IDENTITY.md`, `SOUL.md`, `USER.md`, `MEMORY.md`
- **Project cache** — Persistent file tree map for fast AI context building
- **Content scheduler** — Generate and publish posts (text + image/video) to Telegram channels on schedule
- **Admin panel** — `/admin` zone for managing all containers: start, stop, restart, delete, logs, direct command execution
- **Telegram authorization** — Central auth bot (@clientzavod_bot) for user login via Telegram ID

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Runtime** | Node.js 18+ |
| **Framework** | Express.js |
| **Database** | PostgreSQL 15 (per-user DBs + central `clientzavod`) |
| **MySQL** | MySQL 8 (skills database `ai_skills_db`) |
| **Containerization** | Docker (dynamic container creation per user) |
| **Bot Framework** | Telegraf (Telegram) |
| **Email** | imapflow, nodemailer, mailparser |
| **AI Integration** | ProTalk router, OpenAI, OpenRouter |
| **Image Generation** | Kie.ai API |
| **Video Generation** | RunwayML, Pika (optional) |
| **Social Media** | VK, OK (Odnoklassniki), Pinterest, Instagram APIs |
| **Session Management** | express-session + FileStore |

## Project Structure

```
/root/docker-claw/
├── server.js                  # Main entry point
├── config.js                  # Centralized configuration
├── package.json               # Dependencies and scripts
├── docker-compose.yml         # Docker Compose configuration
├── Dockerfile                 # Production Docker image
├── .env.example               # Environment variables template
│
├── routes/                    # Express route handlers
│   ├── admin.routes.js        # Admin panel APIs
│   ├── apps.routes.js         # App management
│   ├── auth.routes.js         # Authentication
│   ├── billing.routes.js      # Token billing & payments
│   ├── content.routes.js      # Content generation
│   ├── database.routes.js     # Per-user DB management
│   ├── execute.routes.js      # Command execution
│   ├── files.routes.js        # File operations
│   ├── plans.routes.js        # Task plans
│   ├── sandbox.routes.js      # Sandbox proxy endpoints
│   ├── session.routes.js      # Session management
│   ├── user_hooks.routes.js   # User webhooks
│   └── webhook.routes.js      # Incoming webhooks
│
├── services/                  # Business logic layer
│   ├── ai_router_service.js   # LLM routing (ProTalk/OpenAI/OpenRouter)
│   ├── balance.service.js     # Balance checking
│   ├── buffer.service.js      # Buffer social media API
│   ├── contentMvp.service.js  # Content generation & publishing (Telegram)
│   ├── deps.service.js        # Dependency graph
│   ├── docker.service.js      # Container lifecycle management
│   ├── image.service.js       # Image processing
│   ├── instagram*.service.js  # Instagram publishing
│   ├── mysql.service.js       # MySQL skills DB
│   ├── ok*.service.js         # Odnoklassniki publishing
│   ├── pinterest*.service.js  # Pinterest publishing
│   ├── plan.service.js        # Task plans
│   ├── postgres.service.js    # Per-user PostgreSQL provisioning
│   ├── projectCache.service.js # Project file tree cache
│   ├── session.service.js     # Session management
│   ├── snapshot.service.js    # File snapshots (undo)
│   ├── storage.service.js     # File storage & backups
│   └── vk*.service.js         # VKontakte publishing
│
├── manage/                    # Channel integrations & AI agent
│   ├── telegram/              # Telegram bot implementation
│   │   ├── runner.js          # Bot polling & command handlers
│   │   ├── agentLoop.js       # AI agent execution loop
│   │   └── toolHandlers.js    # Tool call implementations
│   ├── email/                 # Email integration
│   │   ├── processor.js       # IMAP polling & SMTP sending
│   │   └── ...
│   ├── agentQueue.js          # Per-user agent queue
│   ├── context.js             # Context builder for AI
│   ├── prompts.js             # System prompts
│   ├── routes.js              # /api/manage endpoints
│   ├── store.js               # Persistent channel state
│   └── tokenBilling.js        # Token billing system
│
├── public/                    # Web interface (HTML + JS + CSS)
│   ├── admin/                 # Admin panel pages
│   ├── css/                   # Stylesheets
│   ├── js/                    # Frontend JavaScript
│   ├── auth.html              # Login page
│   ├── files.html             # File manager
│   ├── channels.html          # Channel configuration
│   ├── content.html           # Content scheduler
│   ├── ai.html                # AI settings
│   ├── tasks.html             # Task management
│   ├── apps.html              # App registry
│   ├── console.html           # Web console
│   └── info.html              # System info
│
├── migrations/                # Database migration scripts
├── tests/                     # Test files
└── documents/                 # Documentation
```

## Building and Running

### Prerequisites

- Linux server (Ubuntu 20.04+)
- Docker Engine (not Docker Desktop)
- Node.js 18+ and npm
- PostgreSQL 14+

### Installation

```bash
# 1. Install Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
newgrp docker

# 2. Install PostgreSQL
sudo apt update
sudo apt install -y postgresql postgresql-contrib
sudo systemctl enable --now postgresql

# 3. Clone and install dependencies
git clone https://github.com/atiksorg/docker-claw.git
cd docker-claw
npm install

# 4. Create .env from .env.example
cp .env.example .env
# Edit .env with your values

# 5. Create storage directories
sudo mkdir -p /var/sandbox-data /var/sandbox-backups /var/sandbox-snapshots
sudo chown -R $USER:$USER /var/sandbox-data /var/sandbox-backups /var/sandbox-snapshots
```

### Running

```bash
# Development (auto-reload)
npm run dev

# Production
npm start

# Via systemd (recommended for production)
sudo systemctl enable --now docker-claw
```

Server runs on `http://localhost:3015` by default.

### Docker Compose (Optional)

```bash
# Start all services (PostgreSQL, MySQL, Nginx, app)
docker-compose up -d
```

## Key Configuration Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3015` | HTTP server port |
| `PG_HOST` | `172.17.0.1` | PostgreSQL host |
| `PG_PASSWORD` | — | PostgreSQL password |
| `DATA_ROOT` | `/var/sandbox-data` | User data storage root |
| `DOCKER_IMAGE` | `mcr.microsoft.com/devcontainers/javascript-node:20-bookworm` | Sandbox container image |
| `CONTAINER_MEMORY` | `256m` | Memory limit per user container |
| `CONTAINER_CPUS` | `0.5` | CPU limit per user container |
| `KIE_API_KEY` | — | Kie.ai API key for image generation |
| `BOT_TOKEN` | — | Telegram bot token |
| `CONTENT_MVP_TIME` | `09:00` | Scheduled content publish time |
| `CHANNEL_ID` | — | Telegram channel ID for publishing |

## API Endpoints

All routes prefixed with `/api`.

| Route | Description |
|-------|-------------|
| `GET /api/health` | Health check, active session count |
| `/api/session/*` | Create/get/delete sessions |
| `/api/execute/*` | Execute commands in container |
| `/api/files/*` | Upload/download/list files |
| `/api/database/*` | Per-user PostgreSQL management |
| `/api/manage/*` | Channel (Telegram/Email) & AI settings |
| `/api/content/*` | Content generation & publishing |
| `/api/plans/*` | Task plan management |
| `/api/apps/*` | App registry |
| `/api/billing/*` | Token billing & payments |
| `/sandbox/*` | Proxy to sandbox endpoints |
| `/webhook` | Incoming webhook → agent task |
| `/hook/:id` | User-defined webhooks |
| `/admin/*` | Admin panel APIs |

## Development Conventions

### Code Style

- **JavaScript**: ES2020+ with CommonJS modules (`require`/`module.exports`)
- **Async/Await**: Preferred over callbacks for async operations
- **Error Handling**: Try-catch with descriptive error messages
- **Logging**: `console.log` with `[SERVICE]` prefix for namespacing

### Testing

```bash
# Run tests
npm test
```

Tests are located in `tests/` directory and cover:
- Content status tracking
- Extended validators
- VK moderation and publishing
- Service-level unit tests

### Service Architecture

Each service module follows a consistent pattern:

```javascript
const config = require('../config');
const dockerService = require('./docker.service');
const sessionService = require('./session.service');

async function someFunction(chatId, options) {
    const session = await sessionService.getOrCreateSession(chatId);
    const result = await dockerService.executeInContainer(
        session.containerId,
        'command to execute'
    );
    return result;
}

module.exports = {
    someFunction
};
```

### Key Design Patterns

1. **Session-per-user**: Each user has a session with `containerId`, `dataDir`, etc.
2. **Container isolation**: `sandbox-user-{chatId}` naming convention
3. **Bind-mount storage**: User data persisted to `/var/sandbox-data/{chatId}`
4. **Per-user PostgreSQL**: Database named `db_{chatId}` auto-provisioned
5. **Agent loop**: Tool-calling pattern for AI autonomy

## Recent Changes (April 2026)

### Image Generation with User Input Files

The `contentMvp.service.js` was updated to use files from `/workspace/input` for image generation prompts:

- Added `getInputFiles(chatId)` — list files in user's input folder
- Added `readInputFile(chatId, filepath)` — read file contents
- Added `getImageContext(chatId)` — determine context from files (text descriptions > image references)
- Modified `generateImage(chatId, topic, text)` — now accepts `chatId` and incorporates user files into Kie.ai prompts

All 7 call sites of `generateImage()` were updated to pass `chatId`.

## Troubleshooting

### Container Creation Fails

```bash
# Check Docker is running
docker ps

# Check image exists
docker images | grep sandbox

# Pull image manually
docker pull mcr.microsoft.com/devcontainers/javascript-node:20-bookworm
```

### PostgreSQL Connection Issues

```bash
# Check PostgreSQL is running
sudo systemctl status postgresql

# Test connection
psql -h 172.17.0.1 -U postgres -d clientzavod
```

### Bot Not Responding

1. Check bot token is valid in `.env`
2. Verify webhook URL if using webhooks
3. Check logs: `docker logs bash-executor` or `journalctl -u docker-claw`

## Related Documentation

- `README.md` — Full user guide and setup instructions
- `TASKS_BILLING.md` — Token billing system specification
- `MYSQL_MIGRATION.md` — MySQL migration guide
- `manage/telegram/README.md` — Telegram bot documentation
