// Загрузка переменных окружения: сначала .env, затем .env.local (переопределяет)
require('dotenv').config();
require('dotenv').config({ path: '.env.local', override: true });

const path = require('path');

module.exports = {
    // Server
    PORT: process.env.PORT || 3015,

    // PostgreSQL
    PG_HOST: process.env.PG_HOST || '172.17.0.1',
    // Host used by this Node.js process for admin actions (CREATE/DROP DB)
    PG_ADMIN_HOST: process.env.PG_ADMIN_HOST || process.env.PG_HOST || '172.17.0.1',
    // Host passed into sandbox containers via PGHOST/DATABASE_URL
    PG_SANDBOX_HOST: process.env.PG_SANDBOX_HOST || process.env.PG_HOST || '172.17.0.1',
    PG_PORT: process.env.PG_PORT || 5432,
    PG_USER: process.env.PG_USER || 'postgres',
    PG_PASSWORD: process.env.PG_PASSWORD || 'XXXXXXXXXXXXXXXXXXX',

    // MySQL (Skills Database)
    MYSQL_SKILLS_HOST: process.env.MYSQL_SKILLS_HOST || 'localhost',
    MYSQL_SKILLS_PORT: parseInt(process.env.MYSQL_SKILLS_PORT) || 3306,
    MYSQL_SKILLS_USER: process.env.MYSQL_SKILLS_USER || 'ai_skills',
    MYSQL_SKILLS_PASSWORD: process.env.MYSQL_SKILLS_PASSWORD || '',
    MYSQL_SKILLS_DATABASE: process.env.MYSQL_SKILLS_DATABASE || 'ai_skills_db',

    // MySQL connection pool settings
    mysql: {
        host: process.env.MYSQL_SKILLS_HOST || 'localhost',
        port: process.env.MYSQL_SKILLS_PORT || 3306,
        user: process.env.MYSQL_SKILLS_USER || 'ai_skills',
        password: process.env.MYSQL_SKILLS_PASSWORD || '',
        database: process.env.MYSQL_SKILLS_DATABASE || 'ai_skills_db',
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0,
        enableKeepAlive: true,
        keepAliveInitialDelay: 0
    },

    // Storage (абсолютные пути для надёжного монтирования в Docker)
    DATA_ROOT: path.resolve(process.env.DATA_ROOT || '/var/sandbox-data'),
    BACKUP_ROOT: path.resolve(process.env.BACKUP_ROOT || '/var/sandbox-backups'),
    BACKUP_INTERVAL_HOURS: parseInt(process.env.BACKUP_INTERVAL_HOURS) || 168, // 7 дней

    // Docker
    DOCKER_IMAGE: process.env.DOCKER_IMAGE || 'sandbox-python:latest',
    CONTAINER_MEMORY: process.env.CONTAINER_MEMORY || '256m', // Лимит для sandbox-user-* контейнеров
    CONTAINER_CPUS: process.env.CONTAINER_CPUS || '2.0',
    CONTAINER_TIMEOUT: parseInt(process.env.CONTAINER_TIMEOUT) || 86400,

    // Session
    SESSION_MAX_IDLE_MS: parseInt(process.env.SESSION_MAX_IDLE_MS) || 86400000, // 24 hours
    CLEANUP_INTERVAL_MS: parseInt(process.env.CLEANUP_INTERVAL_MS) || 300000, // 5 min

    // Security
    MAX_COMMAND_TIMEOUT: 30,
    MAX_FILE_SIZE: 100 * 1024 * 1024, // 100MB

    // Snapshots (многоуровневый undo)
    SNAPSHOT_ROOT: path.resolve(process.env.SNAPSHOT_ROOT || '/var/sandbox-snapshots'),
    SNAPSHOT_MAX_DEPTH: parseInt(process.env.SNAPSHOT_MAX_DEPTH) || 10, // глубина стека на файл
    SNAPSHOT_TTL_DAYS: parseInt(process.env.SNAPSHOT_TTL_DAYS) || 7, // время жизни снапшота


    // App URL (для Telegram inline keyboard — должен быть https://)
    // Используйте ngrok или другой туннель для локальной разработки:
    // ngrok http 3015 -> получаете https://xxx.ngrok-free.app
    APP_URL: process.env.APP_URL || 'https://clientzavod.ru',

    // Project Cache (постоянная карта проекта)
    PROJECT_CACHE_DIR: process.env.PROJECT_CACHE_DIR || '.project',
    PROJECT_CACHE_MAX_FILES: parseInt(process.env.PROJECT_CACHE_MAX_FILES) || 5000, // макс. файлов в дереве
    PROJECT_CACHE_MAX_SUMMARY_SIZE: parseInt(process.env.PROJECT_CACHE_MAX_SUMMARY_SIZE) || 50000, // макс. размер summary
    PROJECT_CACHE_TTL_DAYS: parseInt(process.env.PROJECT_CACHE_TTL_DAYS) || 30, // время жизни кэша

    // VK Integration
    VK_API_VERSION: process.env.VK_API_VERSION || '5.199',
    VK_DEFAULT_GROUP_ID: process.env.VK_DEFAULT_GROUP_ID || '',
    VK_DAILY_LIMIT: parseInt(process.env.VK_DAILY_LIMIT) || 5,
    VK_MODERATION_TIMEOUT_HOURS: parseInt(process.env.VK_MODERATION_TIMEOUT_HOURS) || 24,

    // OK (Odnoklassniki) Integration
    OK_APP_ID: process.env.OK_APP_ID || '',
    OK_PUBLIC_KEY: process.env.OK_PUBLIC_KEY || '',
    OK_SECRET_KEY: process.env.OK_SECRET_KEY || '',
    OK_ACCESS_TOKEN: process.env.OK_ACCESS_TOKEN || '',
    OK_SESSION_SECRET: process.env.OK_SESSION_SECRET || '',
    OK_GROUP_ID: process.env.OK_GROUP_ID || '',
    OK_DAILY_LIMIT: parseInt(process.env.OK_DAILY_LIMIT) || 5,
    OK_MODERATION_TIMEOUT_HOURS: parseInt(process.env.OK_MODERATION_TIMEOUT_HOURS) || 24,

    // Central Moderation Bot (CW Bot) — один на всю систему
    CW_BOT_TOKEN: process.env.CW_BOT_TOKEN || '',
    CW_BOT_USERNAME: process.env.CW_BOT_USERNAME || '',
    CW_BOT_WEBHOOK_URL: process.env.CW_BOT_WEBHOOK_URL || '',

    // Telegram Bot Webhook URL
    WEBHOOK_URL: process.env.WEBHOOK_URL || '',
};
