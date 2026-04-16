const fs = require('fs').promises;
const path = require('path');
const config = require('../config');

const STATE_DIR = config.DATA_ROOT;
const STATE_FILE_PREFIX = 'manage-state-';
const STATE_FILE_SUFFIX = '.json';
const OLD_STATE_FILE = path.join(config.DATA_ROOT, 'manage-state.json');

const CODE_EXPIRY_MS = 10 * 60 * 1000; // 10 минут
const MAX_LAST_COMMANDS = 50;
const MAX_AI_MESSAGES = 100; // Максимум сообщений в истории переписки с AI
const MAX_AI_ROUTER_LOGS = 200; // Максимум записей в логе AI Router

// Кеш состояний в памяти: chatId -> state object
let statesCache = {};

// Функция для получения пути к файлу состояния по chatId
function getStateFilePath(chatId) {
    const safeChatId = String(chatId).replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(STATE_DIR, `${STATE_FILE_PREFIX}${safeChatId}${STATE_FILE_SUFFIX}`);
}

// Функция для получения пути к бэкапу
function getBackupFilePath(chatId) {
    return getStateFilePath(chatId) + '.bak';
}

const DEFAULT_CONTEXT_SETTINGS = {
    maxCommands: 5,
    maxFiles: 80,
    maxDepth: 3,
    maxFileLines: 30,
    personaLines: 20,
    personaChars: 500,
    includeStdout: true,
    includeStderr: true,
    stdoutMaxChars: 200,
    stderrMaxChars: 200
};

const persistingChatIds = new Set();

async function persist(chatId) {
    if (!chatId) {
        console.error('[MANAGE] persist called without chatId');
        return;
    }
    
    if (persistingChatIds.has(chatId)) {
        setImmediate(() => persist(chatId));
        return;
    }
    
    persistingChatIds.add(chatId);
    
    try {
        const stateFile = getStateFilePath(chatId);
        const backupFile = getBackupFilePath(chatId);
        
        await fs.mkdir(STATE_DIR, { recursive: true });
        
        const data = statesCache[chatId] || {};
        const toSave = { chatId, data, savedAt: Date.now() };
        
        try {
            await fs.access(stateFile);
            await fs.copyFile(stateFile, backupFile);
        } catch (e) {}
        
        const tmpFile = `${stateFile}.tmp.${Date.now()}`;
        await fs.writeFile(tmpFile, JSON.stringify(toSave, null, 2), 'utf8');
        await fs.rename(tmpFile, stateFile);
        
    } catch (err) {
        console.error(`[MANAGE] persist error for ${chatId}:`, err.message);
    } finally {
        persistingChatIds.delete(chatId);
    }
}

async function loadChatState(chatId) {
    const stateFile = getStateFilePath(chatId);
    
    try {
        const raw = await fs.readFile(stateFile, 'utf8');
        const parsed = JSON.parse(raw);
        statesCache[chatId] = parsed.data || {};
        return statesCache[chatId];
    } catch (err) {
        if (err.code === 'ENOENT') {
            statesCache[chatId] = {};
            return statesCache[chatId];
        }
        console.error(`[MANAGE] loadChatState parse error for ${chatId}:`, err.message);
        
        const backupFile = getBackupFilePath(chatId);
        try {
            const backupRaw = await fs.readFile(backupFile, 'utf8');
            const backupParsed = JSON.parse(backupRaw);
            statesCache[chatId] = backupParsed.data || {};
            console.log(`[MANAGE] Restored ${chatId} from backup`);
            return statesCache[chatId];
        } catch (backupErr) {
            console.error(`[MANAGE] Backup also failed for ${chatId}:`, backupErr.message);
            statesCache[chatId] = {};
            return statesCache[chatId];
        }
    }
}

async function load() {
    const stackTrace = new Error().stack.split('\n').slice(1, 6).join('\n');
    console.log('[MANAGE] load() called from:\n' + stackTrace);
    
    try {
        await fs.mkdir(STATE_DIR, { recursive: true });
    } catch (e) {}
    
    try {
        const oldRaw = await fs.readFile(OLD_STATE_FILE, 'utf8');
        const oldParsed = JSON.parse(oldRaw);
        
        if (oldParsed.byChatId && Object.keys(oldParsed.byChatId).length > 0) {
            console.log('[MANAGE] Migrating from old single-file format...');
            
            for (const [chatId, data] of Object.entries(oldParsed.byChatId)) {
                statesCache[chatId] = data;
                await persist(chatId);
            }
            
            const migratedFile = `${OLD_STATE_FILE}.migrated.${Date.now()}`;
            await fs.rename(OLD_STATE_FILE, migratedFile);
            console.log(`[MANAGE] Migration complete. Old file moved to ${migratedFile}`);
        }
    } catch (err) {
        if (err.code !== 'ENOENT') {
            console.error('[MANAGE] Old file migration error:', err.message);
        }
    }
    
    try {
        const files = await fs.readdir(STATE_DIR);
        const stateFiles = files.filter(f => 
            f.startsWith(STATE_FILE_PREFIX) && 
            f.endsWith(STATE_FILE_SUFFIX) &&
            !f.endsWith('.bak') &&
            !f.endsWith('.tmp')
        );
        
        for (const file of stateFiles) {
            const match = file.match(new RegExp(`^${STATE_FILE_PREFIX}(.+)\\.json$`));
            if (match) {
                const chatId = match[1];
                await loadChatState(chatId);
            }
        }
        
        console.log(`[MANAGE] Loaded ${Object.keys(statesCache).length} chat states`);
    } catch (err) {
        console.error('[MANAGE] load error:', err.message);
    }
}

function getState(chatId) {
    return statesCache[chatId] || null;
}

function getAllStates() {
    return statesCache;
}

function getByToken(token) {
    for (const [cid, data] of Object.entries(statesCache)) {
        if (data.token === token) return cid;
    }
    return null;
}

function getByVerifiedTelegramId(telegramId) {
    for (const [cid, data] of Object.entries(statesCache)) {
        if (String(data.verifiedTelegramId) === String(telegramId)) return cid;
    }
    return null;
}

/**
 * Найти chatId по токену бота и Telegram ID пользователя
 * Используется для callback handler'ов чтобы найти правильную сессию
 */
function getByTokenAndTelegramId(token, telegramId) {
    for (const [cid, data] of Object.entries(statesCache)) {
        if (data.token === token && String(data.verifiedTelegramId) === String(telegramId)) {
            return cid;
        }
    }
    // Если не найдено по комбинации, ищем просто по токену
    return getByToken(token);
}

function setToken(chatId, token) {
    if (!statesCache[chatId]) statesCache[chatId] = {};
    statesCache[chatId].token = token;
    statesCache[chatId].verifiedTelegramId = null;
    statesCache[chatId].verifiedUsername = null;
    statesCache[chatId].pending = null;
    return persist(chatId);
}

function setBotUsername(chatId, botUsername) {
    if (!statesCache[chatId]) statesCache[chatId] = {};
    statesCache[chatId].botUsername = botUsername;
    return persist(chatId);
}

function setOnboardingComplete(chatId, complete) {
    if (!statesCache[chatId]) statesCache[chatId] = {};
    statesCache[chatId].onboardingComplete = !!complete;
    return persist(chatId);
}

function setPending(chatId, code, fromId, username) {
    if (!statesCache[chatId]) statesCache[chatId] = { token: '' };
    statesCache[chatId].pending = {
        code: String(code),
        fromId,
        username: username || null,
        expiry: Date.now() + CODE_EXPIRY_MS
    };
    return persist(chatId);
}

function verify(chatId, code) {
    const data = statesCache[chatId];
    if (!data || !data.pending) return { ok: false, reason: 'no_pending' };
    if (Date.now() > data.pending.expiry) {
        data.pending = null;
        persist(chatId);
        return { ok: false, reason: 'expired' };
    }
    if (String(data.pending.code) !== String(code).trim()) {
        return { ok: false, reason: 'wrong_code' };
    }
    data.verifiedTelegramId = data.pending.fromId;
    data.verifiedUsername = data.pending.username;
    data.pending = null;
    persist(chatId);
    return { ok: true };
}

function setAI(chatId, botId, botToken, userEmail, model, balanceCheck = null) {
    if (!statesCache[chatId]) statesCache[chatId] = {};
    statesCache[chatId].aiBotId = botId;
    statesCache[chatId].aiBotToken = botToken;
    statesCache[chatId].aiUserEmail = userEmail;
    statesCache[chatId].aiAuthToken = `${botId}_${botToken}`;
    statesCache[chatId].aiModel = model;
    
    if (balanceCheck) {
        statesCache[chatId].aiBalance = balanceCheck.balance;
        statesCache[chatId].aiBalanceExpired = balanceCheck.expired;
        statesCache[chatId].aiBlocked = !balanceCheck.canUse;
        statesCache[chatId].aiBlockReason = balanceCheck.reason || null;
    }
    
    return persist(chatId);
}

function setAIProvider(chatId, provider, apiKey, model = null) {
    if (!statesCache[chatId]) statesCache[chatId] = {};
    statesCache[chatId].aiProvider = provider;
    
    if (provider === 'openai' || provider === 'openrouter') {
        statesCache[chatId].aiCustomApiKey = apiKey;
        if (model) {
            statesCache[chatId].aiModel = model;
        }
    }
    
    return persist(chatId);
}

function getAIProvider(chatId) {
    const data = statesCache[chatId];
    if (!data) return { provider: 'protalk' };
    
    return {
        provider: data.aiProvider || 'protalk',
        apiKey: data.aiCustomApiKey || null,
        model: data.aiModel || null,
        botId: data.aiBotId || null,
        botToken: data.aiBotToken || null,
        userEmail: data.aiUserEmail || null
    };
}

function getContextSettings(chatId) {
    const data = statesCache[chatId];
    if (!data || !data.contextSettings) {
        return { ...DEFAULT_CONTEXT_SETTINGS };
    }
    return { ...DEFAULT_CONTEXT_SETTINGS, ...data.contextSettings };
}

function setContextSettings(chatId, settings) {
    if (!statesCache[chatId]) statesCache[chatId] = {};
    const sanitized = {
        maxCommands: Math.min(Math.max(parseInt(settings.maxCommands) || 5, 1), 50),
        maxFiles: Math.min(Math.max(parseInt(settings.maxFiles) || 80, 10), 500),
        maxDepth: Math.min(Math.max(parseInt(settings.maxDepth) || 3, 1), 10),
        maxFileLines: Math.min(Math.max(parseInt(settings.maxFileLines) || 30, 5), 100),
        personaLines: Math.min(Math.max(parseInt(settings.personaLines) || 20, 5), 100),
        personaChars: Math.min(Math.max(parseInt(settings.personaChars) || 500, 100), 5000),
        includeStdout: settings.includeStdout !== false,
        includeStderr: settings.includeStderr !== false,
        stdoutMaxChars: Math.min(Math.max(parseInt(settings.stdoutMaxChars) || 200, 50), 2000),
        stderrMaxChars: Math.min(Math.max(parseInt(settings.stderrMaxChars) || 200, 50), 2000)
    };
    statesCache[chatId].contextSettings = sanitized;
    return persist(chatId);
}

function clearAI(chatId) {
    if (statesCache[chatId]) {
        delete statesCache[chatId].aiBotId;
        delete statesCache[chatId].aiBotToken;
        delete statesCache[chatId].aiUserEmail;
        delete statesCache[chatId].aiAuthToken;
        delete statesCache[chatId].aiModel;
        delete statesCache[chatId].aiBalance;
        delete statesCache[chatId].aiBalanceExpired;
        delete statesCache[chatId].aiBlocked;
        delete statesCache[chatId].aiBlockReason;
        persist(chatId);
    }
}

function clearToken(chatId) {
    if (statesCache[chatId]) {
        delete statesCache[chatId].aiAuthToken;
        delete statesCache[chatId].aiModel;
    }
    delete statesCache[chatId];
    
    const stateFile = getStateFilePath(chatId);
    fs.unlink(stateFile).catch(() => {});
    
    const backupFile = getBackupFilePath(chatId);
    fs.unlink(backupFile).catch(() => {});
}

function setEmail(chatId, emailConfig) {
    if (!statesCache[chatId]) statesCache[chatId] = {};
    statesCache[chatId].email = {
        active: true,
        imapHost: emailConfig.imapHost,
        imapPort: emailConfig.imapPort,
        imapUser: emailConfig.imapUser,
        imapPass: emailConfig.imapPass,
        smtpHost: emailConfig.smtpHost,
        smtpPort: emailConfig.smtpPort,
        smtpUser: emailConfig.smtpUser,
        smtpPass: emailConfig.smtpPass,
        pollIntervalMinutes: emailConfig.pollIntervalMinutes || 5,
        lastPollTime: emailConfig.lastPollTime || 0,
        processedMessageIds: emailConfig.processedMessageIds || []
    };
    return persist(chatId);
}

function getEmailStatus(chatId) {
    const data = statesCache[chatId];
    if (!data || !data.email) return { hasEmail: false };
    const lastPollAgoMinutes = data.email.lastPollTime ? Math.floor((Date.now() - data.email.lastPollTime) / 60000) : 0;
    
    return {
        hasEmail: true,
        active: data.email.active !== false,
        config: {
            imapHost: data.email.imapHost,
            imapPort: data.email.imapPort,
            imapUser: data.email.imapUser,
            imapPass: data.email.imapPass,
            smtpHost: data.email.smtpHost,
            smtpPort: data.email.smtpPort,
            smtpUser: data.email.smtpUser,
            smtpPass: data.email.smtpPass
        },
        processedCount: (data.email.processedMessageIds || []).length,
        pollIntervalMinutes: data.email.pollIntervalMinutes || 5,
        lastPollAgoMinutes
    };
}

function clearEmail(chatId) {
    if (statesCache[chatId]) {
        delete statesCache[chatId].email;
        persist(chatId);
    }
}

function addCommand(chatId, command, stdout, stderr, exitCode) {
    if (!statesCache[chatId]) statesCache[chatId] = {};
    if (!statesCache[chatId].lastCommands) statesCache[chatId].lastCommands = [];
    
    statesCache[chatId].lastCommands.unshift({
        command,
        stdout: (stdout || '').slice(0, 2000),
        stderr: (stderr || '').slice(0, 2000),
        exitCode,
        at: Date.now()
    });
    statesCache[chatId].lastCommands = statesCache[chatId].lastCommands.slice(0, MAX_LAST_COMMANDS);
    return persist(chatId);
}

function getLastCommands(chatId, n = 10) {
    const data = statesCache[chatId];
    if (!data || !data.lastCommands) return [];
    return data.lastCommands.slice(0, n);
}

function clearLastCommands(chatId) {
    if (statesCache[chatId]) {
        statesCache[chatId].lastCommands = [];
        return persist(chatId);
    }
}

function getAllTokens() {
    return Object.entries(statesCache)
        .filter(([, data]) => data.token)
        .map(([chatId, data]) => ({ chatId, token: data.token }));
}

function getAllChatIds() {
    return Object.keys(statesCache);
}

function getAllStates() {
    return statesCache;
}

function setEmailPoll(chatId, minutes) {
    if (statesCache[chatId] && statesCache[chatId].email) {
        statesCache[chatId].email.pollIntervalMinutes = parseInt(minutes) || 5;
        persist(chatId);
    }
}

function hasAnyEmailActive() {
    return Object.values(statesCache).some(data => data?.email);
}

function getCronStatus(chatId) {
    const emailStatus = getEmailStatus(chatId);
    return {
        hasCronTasks: emailStatus.hasEmail,
        globalCronActive: hasAnyEmailActive(),
        tasks: emailStatus.hasEmail ? [{
            type: 'email-polling',
            pollIntervalMinutes: emailStatus.pollIntervalMinutes,
            lastPollAgoMinutes: emailStatus.lastPollAgoMinutes,
            processedCount: emailStatus.processedCount,
            config: emailStatus.config
        }] : []
    };
}

const MAX_CRON_LOGS = 50;

function addCronLog(chatId, logObj) {
    logObj.at = Date.now();
    if (!statesCache[chatId]) statesCache[chatId] = {};
    if (!statesCache[chatId].cronLogs) statesCache[chatId].cronLogs = [];
    statesCache[chatId].cronLogs.unshift(logObj);
    statesCache[chatId].cronLogs = statesCache[chatId].cronLogs.slice(0, MAX_CRON_LOGS);
    persist(chatId);
}

function getCronLogs(chatId, limit = 10) {
    const data = statesCache[chatId];
    if (!data || !data.cronLogs) return [];
    return data.cronLogs.slice(0, limit);
}

function getConfigPath(chatId) {
    if (chatId) {
        return getStateFilePath(chatId);
    }
    return STATE_DIR;
}

function getContentSettings(chatId) {
    const data = statesCache[chatId];
    return data?.contentSettings || null;
}

function setContentSettings(chatId, patch = {}) {
    if (!statesCache[chatId]) statesCache[chatId] = {};
    const current = statesCache[chatId].contentSettings || {};
    const next = { ...current };

    if (patch.channelId !== undefined) {
        next.channelId = String(patch.channelId || '').trim() || null;
    }
    if (patch.moderatorUserId !== undefined) {
        next.moderatorUserId = String(patch.moderatorUserId || '').trim() || null;
    }
    if (patch.scheduleTime !== undefined) {
        const scheduleTime = String(patch.scheduleTime || '').trim();
        if (scheduleTime && !/^\d{2}:\d{2}$/.test(scheduleTime)) {
            throw new Error('scheduleTime must be in HH:MM format');
        }
        next.scheduleTime = scheduleTime || null;
    }
    if (patch.scheduleEndTime !== undefined) {
        const scheduleEndTime = String(patch.scheduleEndTime || '').trim();
        if (scheduleEndTime && !/^\d{2}:\d{2}$/.test(scheduleEndTime)) {
            throw new Error('scheduleEndTime must be in HH:MM format');
        }
        next.scheduleEndTime = scheduleEndTime || null;
    }
    if (patch.scheduleTz !== undefined) {
        next.scheduleTz = String(patch.scheduleTz || '').trim() || null;
    }
    if (patch.dailyLimit !== undefined) {
        if (patch.dailyLimit === null || patch.dailyLimit === '') {
            next.dailyLimit = null;
        } else {
            const parsedLimit = parseInt(patch.dailyLimit, 10);
            if (!Number.isFinite(parsedLimit) || parsedLimit <= 0) {
                throw new Error('dailyLimit must be a positive integer');
            }
            next.dailyLimit = parsedLimit;
        }
    }

    if (patch.randomPublish !== undefined) {
        next.randomPublish = !!patch.randomPublish;
    }
    if (patch.premoderationEnabled !== undefined) {
        next.premoderationEnabled = !!patch.premoderationEnabled;
    }
    if (patch.publishIntervalHours !== undefined) {
        const allowed = [0.5, 1, 3, 5, 12, 24];
        const val = parseFloat(patch.publishIntervalHours);
        if (!allowed.includes(val)) {
            throw new Error('publishIntervalHours must be one of: ' + allowed.join(', '));
        }
        next.publishIntervalHours = val;
    }
    if (patch.allowedWeekdays !== undefined) {
        if (!Array.isArray(patch.allowedWeekdays)) {
            throw new Error('allowedWeekdays must be an array');
        }
        const days = patch.allowedWeekdays
            .map(d => parseInt(d, 10))
            .filter(d => Number.isFinite(d) && d >= 0 && d <= 6);
        next.allowedWeekdays = [...new Set(days)].sort();
    }

    statesCache[chatId].contentSettings = next;
    return persist(chatId);
}

// === Integration Settings (global) ===

function getIntegrationSettings(chatId) {
    const data = statesCache[chatId];
    return data?.integrationSettings || null;
}

function setIntegrationSettings(chatId, patch = {}) {
    if (!statesCache[chatId]) statesCache[chatId] = {};
    const current = statesCache[chatId].integrationSettings || {};
    const next = { ...current };
    if (patch.buffer_api_key !== undefined) next.buffer_api_key = patch.buffer_api_key || null;
    if (patch.moderator_user_id !== undefined) next.moderator_user_id = String(patch.moderator_user_id || '').trim() || null;
    statesCache[chatId].integrationSettings = next;
    return persist(chatId);
}

function migrateIntegrationSettings(chatId) {
    const data = statesCache[chatId];
    if (!data) return;
    const current = data.integrationSettings || {};

    const patch = {};
    if (!current.buffer_api_key) {
        for (const key of ['pinterestConfig', 'instagramConfig', 'youtubeConfig', 'facebookConfig', 'tiktokConfig']) {
            if (data[key]?.buffer_api_key) { patch.buffer_api_key = data[key].buffer_api_key; break; }
        }
    }
    if (!current.moderator_user_id) {
        for (const key of ['pinterestConfig', 'instagramConfig', 'youtubeConfig', 'facebookConfig', 'tiktokConfig', 'vkVideoConfig']) {
            if (data[key]?.moderator_user_id) { patch.moderator_user_id = data[key].moderator_user_id; break; }
        }
    }
    if (Object.keys(patch).length > 0) setIntegrationSettings(chatId, patch);
}

// === Pinterest Config ===

function getPinterestConfig(chatId) {
    const data = statesCache[chatId];
    return data?.pinterestConfig || null;
}

function setPinterestConfig(chatId, patch = {}) {
    if (!statesCache[chatId]) statesCache[chatId] = {};
    const current = statesCache[chatId].pinterestConfig || {};
    const next = { ...current };

    if (patch.board_id !== undefined) next.board_id = String(patch.board_id || '').trim() || null;
    if (patch.board_name !== undefined) next.board_name = String(patch.board_name || '').trim() || null;
    if (patch.website_url !== undefined) next.website_url = String(patch.website_url || '').trim() || null;
    if (patch.is_active !== undefined) next.is_active = !!patch.is_active;
    if (patch.auto_publish !== undefined) next.auto_publish = !!patch.auto_publish;
    if (patch.boards !== undefined && Array.isArray(patch.boards)) next.boards = patch.boards;
    if (patch.buffer_api_key !== undefined) next.buffer_api_key = patch.buffer_api_key || null;
    if (patch.buffer_channel_id !== undefined) next.buffer_channel_id = String(patch.buffer_channel_id || '').trim() || null;
    if (patch.board_rotation !== undefined) next.board_rotation = patch.board_rotation || 'random';
    if (patch.last_board_index !== undefined) next.last_board_index = parseInt(patch.last_board_index, 10) || 0;
    if (patch.schedule_time !== undefined) next.schedule_time = patch.schedule_time || null;
    if (patch.schedule_end_time !== undefined) next.schedule_end_time = patch.schedule_end_time || null;
    if (patch.schedule_tz !== undefined) next.schedule_tz = patch.schedule_tz || null;
    if (patch.daily_limit !== undefined) next.daily_limit = parseInt(patch.daily_limit, 10) || null;
    if (patch.publish_interval_hours !== undefined) next.publish_interval_hours = parseFloat(patch.publish_interval_hours) || null;
    if (patch.allowed_weekdays !== undefined && Array.isArray(patch.allowed_weekdays)) next.allowed_weekdays = patch.allowed_weekdays;
    if (patch.random_publish !== undefined) next.random_publish = !!patch.random_publish;
    if (patch.premoderation_enabled !== undefined) next.premoderation_enabled = !!patch.premoderation_enabled;
    if (patch.moderator_user_id !== undefined) next.moderator_user_id = String(patch.moderator_user_id || '').trim() || null;
    if (patch.stats !== undefined) next.stats = { ...(next.stats || {}), ...patch.stats };

    statesCache[chatId].pinterestConfig = next;
    return persist(chatId);
}

function clearPinterestConfig(chatId) {
    if (statesCache[chatId]) {
        delete statesCache[chatId].pinterestConfig;
        return persist(chatId);
    }
}

function getInstagramConfig(chatId) {
    const data = statesCache[chatId];
    return data?.instagramConfig || null;
}

function setInstagramConfig(chatId, patch = {}) {
    if (!statesCache[chatId]) statesCache[chatId] = {};
    const current = statesCache[chatId].instagramConfig || {};
    const next = { ...current };

    if (patch.buffer_api_key !== undefined) next.buffer_api_key = patch.buffer_api_key || null;
    if (patch.buffer_channel_id !== undefined) next.buffer_channel_id = String(patch.buffer_channel_id || '').trim() || null;
    if (patch.is_active !== undefined) next.is_active = !!patch.is_active;
    if (patch.auto_publish !== undefined) next.auto_publish = !!patch.auto_publish;
    if (patch.schedule_time !== undefined) next.schedule_time = patch.schedule_time || null;
    if (patch.schedule_end_time !== undefined) next.schedule_end_time = patch.schedule_end_time || null;
    if (patch.schedule_tz !== undefined) next.schedule_tz = patch.schedule_tz || null;
    if (patch.daily_limit !== undefined) next.daily_limit = Math.min(Math.max(parseInt(patch.daily_limit, 10) || 3, 1), 25);
    if (patch.publish_interval_hours !== undefined) next.publish_interval_hours = parseFloat(patch.publish_interval_hours) || 4;
    if (patch.allowed_weekdays !== undefined && Array.isArray(patch.allowed_weekdays)) next.allowed_weekdays = patch.allowed_weekdays;
    if (patch.random_publish !== undefined) next.random_publish = !!patch.random_publish;
    if (patch.moderator_user_id !== undefined) next.moderator_user_id = String(patch.moderator_user_id || '').trim() || null;
    if (patch.stats !== undefined) next.stats = { ...(next.stats || {}), ...patch.stats };

    statesCache[chatId].instagramConfig = next;
    return persist(chatId);
}

function clearInstagramConfig(chatId) {
    if (statesCache[chatId]) {
        delete statesCache[chatId].instagramConfig;
        return persist(chatId);
    }
}

// === YouTube Config ===

function getYoutubeConfig(chatId) {
    const data = statesCache[chatId];
    return data?.youtubeConfig || null;
}

function setYoutubeConfig(chatId, patch = {}) {
    if (!statesCache[chatId]) statesCache[chatId] = {};
    const current = statesCache[chatId].youtubeConfig || {};
    const next = { ...current };

    if (patch.buffer_api_key !== undefined) next.buffer_api_key = patch.buffer_api_key || null;
    if (patch.buffer_channel_id !== undefined) next.buffer_channel_id = String(patch.buffer_channel_id || '').trim() || null;
    if (patch.is_active !== undefined) next.is_active = !!patch.is_active;
    if (patch.auto_publish !== undefined) next.auto_publish = !!patch.auto_publish;
    if (patch.schedule_time !== undefined) next.schedule_time = patch.schedule_time || null;
    if (patch.schedule_end_time !== undefined) next.schedule_end_time = patch.schedule_end_time || null;
    if (patch.schedule_tz !== undefined) next.schedule_tz = patch.schedule_tz || null;
    if (patch.daily_limit !== undefined) next.daily_limit = parseInt(patch.daily_limit, 10) || 1;
    if (patch.publish_interval_hours !== undefined) next.publish_interval_hours = parseInt(patch.publish_interval_hours, 10) || 24;
    if (patch.allowed_weekdays !== undefined && Array.isArray(patch.allowed_weekdays)) next.allowed_weekdays = patch.allowed_weekdays;
    if (patch.moderator_user_id !== undefined) next.moderator_user_id = String(patch.moderator_user_id || '').trim() || null;
    if (patch.random_publish !== undefined) next.random_publish = !!patch.random_publish;
    if (patch.stats !== undefined) next.stats = { ...(next.stats || {}), ...patch.stats };

    statesCache[chatId].youtubeConfig = next;
    return persist(chatId);
}

function clearYoutubeConfig(chatId) {
    if (statesCache[chatId]) {
        delete statesCache[chatId].youtubeConfig;
        return persist(chatId);
    }
}

// === Facebook Config ===

function getFacebookConfig(chatId) {
    const data = statesCache[chatId];
    return data?.facebookConfig || null;
}

function setFacebookConfig(chatId, patch = {}) {
    if (!statesCache[chatId]) statesCache[chatId] = {};
    const current = statesCache[chatId].facebookConfig || {};
    const next = { ...current };

    if (patch.buffer_api_key !== undefined) next.buffer_api_key = patch.buffer_api_key || null;
    if (patch.buffer_channel_id !== undefined) next.buffer_channel_id = String(patch.buffer_channel_id || '').trim() || null;
    if (patch.page_name !== undefined) next.page_name = String(patch.page_name || '').trim() || null;
    if (patch.is_active !== undefined) next.is_active = !!patch.is_active;
    if (patch.auto_publish !== undefined) next.auto_publish = !!patch.auto_publish;
    if (patch.schedule_time !== undefined) next.schedule_time = patch.schedule_time || null;
    if (patch.schedule_end_time !== undefined) next.schedule_end_time = patch.schedule_end_time || null;
    if (patch.schedule_tz !== undefined) next.schedule_tz = patch.schedule_tz || null;
    if (patch.daily_limit !== undefined) next.daily_limit = Number.isFinite(patch.daily_limit) ? patch.daily_limit : 10;
    if (patch.publish_interval_hours !== undefined) next.publish_interval_hours = Number.isFinite(patch.publish_interval_hours) ? patch.publish_interval_hours : 4;
    if (patch.random_publish !== undefined) next.random_publish = !!patch.random_publish;
    if (patch.allowed_weekdays !== undefined && Array.isArray(patch.allowed_weekdays)) next.allowed_weekdays = patch.allowed_weekdays;
    if (patch.moderator_user_id !== undefined) next.moderator_user_id = String(patch.moderator_user_id || '').trim() || null;
    if (patch.stats !== undefined) next.stats = { ...(next.stats || {}), ...patch.stats };

    statesCache[chatId].facebookConfig = next;
    return persist(chatId);
}

function clearFacebookConfig(chatId) {
    if (statesCache[chatId]) {
        delete statesCache[chatId].facebookConfig;
        return persist(chatId);
    }
}

// === TikTok Config ===

function getTiktokConfig(chatId) {
    const data = statesCache[chatId];
    return data?.tiktokConfig || null;
}

function setTiktokConfig(chatId, patch = {}) {
    if (!statesCache[chatId]) statesCache[chatId] = {};
    const current = statesCache[chatId].tiktokConfig || {};
    const next = { ...current };

    if (patch.buffer_api_key !== undefined) next.buffer_api_key = patch.buffer_api_key || null;
    if (patch.buffer_channel_id !== undefined) next.buffer_channel_id = String(patch.buffer_channel_id || '').trim() || null;
    if (patch.is_active !== undefined) next.is_active = !!patch.is_active;
    if (patch.auto_publish !== undefined) next.auto_publish = !!patch.auto_publish;
    if (patch.schedule_time !== undefined) next.schedule_time = patch.schedule_time || null;
    if (patch.schedule_end_time !== undefined) next.schedule_end_time = patch.schedule_end_time || null;
    if (patch.schedule_tz !== undefined) next.schedule_tz = patch.schedule_tz || null;
    if (patch.daily_limit !== undefined) next.daily_limit = Number.isFinite(patch.daily_limit) ? patch.daily_limit : 3;
    if (patch.publish_interval_hours !== undefined) next.publish_interval_hours = Number.isFinite(patch.publish_interval_hours) ? patch.publish_interval_hours : 6;
    if (patch.random_publish !== undefined) next.random_publish = !!patch.random_publish;
    if (patch.allowed_weekdays !== undefined && Array.isArray(patch.allowed_weekdays)) next.allowed_weekdays = patch.allowed_weekdays;
    if (patch.moderator_user_id !== undefined) next.moderator_user_id = String(patch.moderator_user_id || '').trim() || null;
    if (patch.stats !== undefined) next.stats = { ...(next.stats || {}), ...patch.stats };

    statesCache[chatId].tiktokConfig = next;
    return persist(chatId);
}

function clearTiktokConfig(chatId) {
    if (statesCache[chatId]) {
        delete statesCache[chatId].tiktokConfig;
        return persist(chatId);
    }
}

// === VK Video Config ===

function getVkVideoConfig(chatId) {
    const data = statesCache[chatId];
    return data?.vkVideoConfig || null;
}

function setVkVideoConfig(chatId, patch = {}) {
    if (!statesCache[chatId]) statesCache[chatId] = {};
    const current = statesCache[chatId].vkVideoConfig || {};
    const next = { ...current };

    if (patch.is_active !== undefined) next.is_active = !!patch.is_active;
    if (patch.auto_publish !== undefined) next.auto_publish = !!patch.auto_publish;
    if (patch.schedule_time !== undefined) next.schedule_time = patch.schedule_time || null;
    if (patch.schedule_end_time !== undefined) next.schedule_end_time = patch.schedule_end_time || null;
    if (patch.schedule_tz !== undefined) next.schedule_tz = patch.schedule_tz || null;
    if (patch.daily_limit !== undefined) next.daily_limit = Number.isFinite(patch.daily_limit) ? patch.daily_limit : 3;
    if (patch.publish_interval_hours !== undefined) next.publish_interval_hours = Number.isFinite(patch.publish_interval_hours) ? patch.publish_interval_hours : 6;
    if (patch.random_publish !== undefined) next.random_publish = !!patch.random_publish;
    if (patch.allowed_weekdays !== undefined && Array.isArray(patch.allowed_weekdays)) next.allowed_weekdays = patch.allowed_weekdays;
    if (patch.moderator_user_id !== undefined) next.moderator_user_id = String(patch.moderator_user_id || '').trim() || null;
    if (patch.stats !== undefined) next.stats = { ...(next.stats || {}), ...patch.stats };

    statesCache[chatId].vkVideoConfig = next;
    return persist(chatId);
}

function clearVkVideoConfig(chatId) {
    if (statesCache[chatId]) {
        delete statesCache[chatId].vkVideoConfig;
        return persist(chatId);
    }
}

// === Video Pipeline Settings ===

const ALLOWED_VIDEO_MODELS = ['veo3.1', 'seedance-2', 'grok-imagine'];

function getVideoPipelineSettings(chatId) {
    return statesCache[chatId]?.videoPipelineSettings || { model: 'veo3.1' };
}

function setVideoPipelineSettings(chatId, patch = {}) {
    if (!statesCache[chatId]) statesCache[chatId] = {};
    const current = statesCache[chatId].videoPipelineSettings || {};
    const next = { ...current };
    if (patch.model !== undefined) {
        next.model = ALLOWED_VIDEO_MODELS.includes(patch.model) ? patch.model : 'veo3.1';
    }
    statesCache[chatId].videoPipelineSettings = next;
    return persist(chatId);
}

// === Image Gen Settings ===

const ALLOWED_IMAGE_MODELS = ['google/nano-banana-2', 'seedream/4.5-text-to-image', 'grok-imagine/text-to-image'];

function getImageGenSettings(chatId) {
    return statesCache[chatId]?.imageGenSettings || { model: 'grok-imagine/text-to-image' };
}

function setImageGenSettings(chatId, patch = {}) {
    if (!statesCache[chatId]) statesCache[chatId] = {};
    const current = statesCache[chatId].imageGenSettings || {};
    const next = { ...current };
    if (patch.model !== undefined) {
        next.model = ALLOWED_IMAGE_MODELS.includes(patch.model) ? patch.model : 'grok-imagine/text-to-image';
    }
    statesCache[chatId].imageGenSettings = next;
    return persist(chatId);
}

// === VK Config ===

function getVkConfig(chatId) {
    const data = statesCache[chatId];
    return data?.vkConfig || null;
}

function setVkConfig(chatId, patch = {}) {
    if (!statesCache[chatId]) statesCache[chatId] = {};
    const current = statesCache[chatId].vkConfig || {};
    const next = { ...current };

    if (patch.group_id !== undefined) next.group_id = String(patch.group_id || '').trim() || null;
    if (patch.service_key !== undefined) next.service_key = patch.service_key || null;
    if (patch.is_active !== undefined) next.is_active = !!patch.is_active;
    if (patch.connected_at !== undefined) next.connected_at = patch.connected_at;

    statesCache[chatId].vkConfig = next;
    return persist(chatId);
}

// === VK Settings ===

function getVkSettings(chatId) {
    const data = statesCache[chatId];
    const settings = data?.vkSettings || null;
    return settings ? {
        ...settings,
        moderatorUserId: settings.moderatorUserId || null,
        moderator_user_id: settings.moderatorUserId || null
    } : null;
}

function setVkSettings(chatId, patch = {}) {
    if (!statesCache[chatId]) statesCache[chatId] = {};
    const current = statesCache[chatId].vkSettings || {};
    const next = { ...current };

    if (patch.schedule_time !== undefined) {
        const scheduleTime = String(patch.schedule_time || '').trim();
        if (scheduleTime && !/^\d{2}:\d{2}$/.test(scheduleTime)) {
            throw new Error('schedule_time must be in HH:MM format');
        }
        next.schedule_time = scheduleTime || null;
    }

    if (patch.schedule_end_time !== undefined) {
        const scheduleEndTime = String(patch.schedule_end_time || '').trim();
        if (scheduleEndTime && !/^\d{2}:\d{2}$/.test(scheduleEndTime)) {
            throw new Error('schedule_end_time must be in HH:MM format');
        }
        next.schedule_end_time = scheduleEndTime || null;
    }

    if (patch.schedule_tz !== undefined) {
        next.schedule_tz = String(patch.schedule_tz || '').trim() || null;
    }

    if (patch.daily_limit !== undefined) {
        if (patch.daily_limit === null || patch.daily_limit === '') {
            next.daily_limit = null;
        } else {
            const parsedLimit = parseInt(patch.daily_limit, 10);
            if (!Number.isFinite(parsedLimit) || parsedLimit <= 0) {
                throw new Error('daily_limit must be a positive integer');
            }
            next.daily_limit = parsedLimit;
        }
    }

    if (patch.random_publish !== undefined) {
        next.random_publish = !!patch.random_publish;
    }

    if (patch.premoderation_enabled !== undefined) {
        next.premoderation_enabled = !!patch.premoderation_enabled;
    }

    if (patch.publish_interval_hours !== undefined) {
        const allowed = [0.5, 1, 3, 5, 12, 24];
        const val = parseFloat(patch.publish_interval_hours);
        if (!allowed.includes(val)) {
            throw new Error('publish_interval_hours must be one of: ' + allowed.join(', '));
        }
        next.publish_interval_hours = val;
    }

    if (patch.allowed_weekdays !== undefined) {
        if (!Array.isArray(patch.allowed_weekdays)) {
            throw new Error('allowed_weekdays must be an array');
        }
        const days = patch.allowed_weekdays
            .map(d => parseInt(d, 10))
            .filter(d => Number.isFinite(d) && d >= 0 && d <= 6);
        next.allowed_weekdays = [...new Set(days)].sort();
    }

    if (patch.post_type !== undefined) {
        const allowedTypes = ['post', 'article', 'video'];
        const postType = String(patch.post_type || '').trim().toLowerCase();
        if (!allowedTypes.includes(postType)) {
            throw new Error('post_type must be one of: ' + allowedTypes.join(', '));
        }
        next.post_type = postType;
    }

    if (patch.moderatorUserId !== undefined) {
        next.moderatorUserId = String(patch.moderatorUserId || '').trim() || null;
    }

    statesCache[chatId].vkSettings = next;
    return persist(chatId);
}

// === OK Config ===

function getOkConfig(chatId) {
    const data = statesCache[chatId];
    return data?.okConfig || null;
}

function setOkConfig(chatId, patch = {}) {
    if (!statesCache[chatId]) statesCache[chatId] = {};
    const current = statesCache[chatId].okConfig || {};
    const next = { ...current };

    if (patch.group_id !== undefined) next.group_id = String(patch.group_id || '').trim() || null;
    if (patch.access_token !== undefined) next.access_token = patch.access_token || null;
    if (patch.session_secret !== undefined) next.session_secret = patch.session_secret || null;
    if (patch.app_id !== undefined) next.app_id = String(patch.app_id || '').trim() || null;
    if (patch.public_key !== undefined) next.public_key = patch.public_key || null;
    if (patch.secret_key !== undefined) next.secret_key = patch.secret_key || null;
    if (patch.is_active !== undefined) next.is_active = !!patch.is_active;
    if (patch.connected_at !== undefined) next.connected_at = patch.connected_at;
    if (patch.stats !== undefined) next.stats = { ...(next.stats || {}), ...patch.stats };

    statesCache[chatId].okConfig = next;
    return persist(chatId);
}

function clearOkConfig(chatId) {
    if (statesCache[chatId]) {
        delete statesCache[chatId].okConfig;
        return persist(chatId);
    }
}

// === OK Settings ===

function getOkSettings(chatId) {
    const data = statesCache[chatId];
    const settings = data?.okSettings || null;
    return settings ? {
        ...settings,
        moderatorUserId: settings.moderatorUserId || null,
        moderator_user_id: settings.moderatorUserId || null
    } : null;
}

function setOkSettings(chatId, patch = {}) {
    if (!statesCache[chatId]) statesCache[chatId] = {};
    const current = statesCache[chatId].okSettings || {};
    const next = { ...current };

    if (patch.schedule_time !== undefined) {
        const scheduleTime = String(patch.schedule_time || '').trim();
        if (scheduleTime && !/^\d{2}:\d{2}$/.test(scheduleTime)) {
            throw new Error('schedule_time must be in HH:MM format');
        }
        next.schedule_time = scheduleTime || null;
    }

    if (patch.schedule_end_time !== undefined) {
        const scheduleEndTime = String(patch.schedule_end_time || '').trim();
        if (scheduleEndTime && !/^\d{2}:\d{2}$/.test(scheduleEndTime)) {
            throw new Error('schedule_end_time must be in HH:MM format');
        }
        next.schedule_end_time = scheduleEndTime || null;
    }

    if (patch.schedule_tz !== undefined) {
        next.schedule_tz = String(patch.schedule_tz || '').trim() || null;
    }

    if (patch.daily_limit !== undefined) {
        if (patch.daily_limit === null || patch.daily_limit === '') {
            next.daily_limit = null;
        } else {
            const parsedLimit = parseInt(patch.daily_limit, 10);
            if (!Number.isFinite(parsedLimit) || parsedLimit <= 0) {
                throw new Error('daily_limit must be a positive integer');
            }
            next.daily_limit = parsedLimit;
        }
    }

    if (patch.random_publish !== undefined) {
        next.random_publish = !!patch.random_publish;
    }

    if (patch.premoderation_enabled !== undefined) {
        next.premoderation_enabled = !!patch.premoderation_enabled;
    }

    if (patch.publish_interval_hours !== undefined) {
        const allowed = [0.5, 1, 3, 5, 12, 24];
        const val = parseFloat(patch.publish_interval_hours);
        if (!allowed.includes(val)) {
            throw new Error('publish_interval_hours must be one of: ' + allowed.join(', '));
        }
        next.publish_interval_hours = val;
    }

    if (patch.allowed_weekdays !== undefined) {
        if (!Array.isArray(patch.allowed_weekdays)) {
            throw new Error('allowed_weekdays must be an array');
        }
        const days = patch.allowed_weekdays
            .map(d => parseInt(d, 10))
            .filter(d => Number.isFinite(d) && d >= 0 && d <= 6);
        next.allowed_weekdays = [...new Set(days)].sort();
    }

    if (patch.post_type !== undefined) {
        const allowedTypes = ['post', 'article', 'video'];
        const postType = String(patch.post_type || '').trim().toLowerCase();
        if (!allowedTypes.includes(postType)) {
            throw new Error('post_type must be one of: ' + allowedTypes.join(', '));
        }
        next.post_type = postType;
    }

    if (patch.moderatorUserId !== undefined) {
        next.moderatorUserId = String(patch.moderatorUserId || '').trim() || null;
    }

    statesCache[chatId].okSettings = next;
    return persist(chatId);
}

function addAIMessage(chatId, channel = 'telegram', role, content) {
    const key = `${chatId}:${channel}`;
    if (!statesCache[chatId]) statesCache[chatId] = {};
    if (!statesCache[chatId].aiMessages) statesCache[chatId].aiMessages = {};
    if (!statesCache[chatId].aiMessages[key]) statesCache[chatId].aiMessages[key] = [];
    
    statesCache[chatId].aiMessages[key].push({
        role,
        content: (content || '').slice(0, 10000),
        at: Date.now()
    });
    if (statesCache[chatId].aiMessages[key].length > MAX_AI_MESSAGES) {
        statesCache[chatId].aiMessages[key] = statesCache[chatId].aiMessages[key].slice(-MAX_AI_MESSAGES);
    }
    return persist(chatId);
}

function getAIMessages(chatId, channel = 'telegram', limit = 50) {
    const key = `${chatId}:${channel}`;
    const data = statesCache[chatId];
    if (!data || !data.aiMessages || !data.aiMessages[key]) return [];
    return data.aiMessages[key].slice(-limit);
}

function clearAIMessages(chatId, channel = 'telegram') {
    const key = `${chatId}:${channel}`;
    if (statesCache[chatId] && statesCache[chatId].aiMessages) {
        statesCache[chatId].aiMessages[key] = [];
        return persist(chatId);
    }
}

function setAIMessages(chatId, channel = 'telegram', messages) {
    const key = `${chatId}:${channel}`;
    if (!statesCache[chatId]) statesCache[chatId] = {};
    if (!statesCache[chatId].aiMessages) statesCache[chatId].aiMessages = {};
    
    statesCache[chatId].aiMessages[key] = messages.map(m => ({
        role: m.role,
        content: (m.content || '').slice(0, 10000),
        tool_calls: m.tool_calls,
        tool_call_id: m.tool_call_id,
        name: m.name,
        at: Date.now()
    }));
    if (statesCache[chatId].aiMessages[key].length > MAX_AI_MESSAGES) {
        statesCache[chatId].aiMessages[key] = statesCache[chatId].aiMessages[key].slice(-MAX_AI_MESSAGES);
    }
    return persist(chatId);
}

function getAgentMode(chatId) {
    const data = statesCache[chatId];
    return data?.agentMode || 'TERMINAL';
}

function setAgentMode(chatId, mode) {
    if (!statesCache[chatId]) statesCache[chatId] = {};
    statesCache[chatId].agentMode = mode;
    return persist(chatId);
}

function getBackupPath(chatId) {
    return getBackupFilePath(chatId);
}

function getApps(chatId) {
    const data = statesCache[chatId] || {};
    return data.apps || [];
}

function addOrUpdateApp(chatId, app) {
    if (!statesCache[chatId]) statesCache[chatId] = {};
    if (!statesCache[chatId].apps) statesCache[chatId].apps = [];

    const idx = statesCache[chatId].apps.findIndex(a => a.name === app.name);
    if (idx >= 0) {
        statesCache[chatId].apps[idx] = { ...statesCache[chatId].apps[idx], ...app, updatedAt: Date.now() };
    } else {
        statesCache[chatId].apps.push({ ...app, createdAt: Date.now(), updatedAt: Date.now() });
    }
    return persist(chatId);
}

function removeApp(chatId, name) {
    if (statesCache[chatId]?.apps) {
        statesCache[chatId].apps = statesCache[chatId].apps.filter(a => a.name !== name);
        return persist(chatId);
    }
}

function getAppUrl(chatId, name) {
    return `https://clientzavod.ru/sandbox/${chatId}/app/${name}`;
}

function cleanupDeletedApps(chatId) {
    if (!statesCache[chatId]?.apps) return 0;
    
    const before = statesCache[chatId].apps.length;
    statesCache[chatId].apps = statesCache[chatId].apps.filter(app => app.status === 'running');
    const after = statesCache[chatId].apps.length;
    const deleted = before - after;
    
    if (deleted > 0) {
        persist(chatId);
    }
    
    return deleted;
}

function getModules(chatId) {
    const data = statesCache[chatId] || {};
    return data.modules || [];
}

function addModule(chatId, module) {
    if (!statesCache[chatId]) statesCache[chatId] = {};
    if (!statesCache[chatId].modules) statesCache[chatId].modules = [];

    const idx = statesCache[chatId].modules.findIndex(m => m.name === module.name);
    if (idx >= 0) {
        statesCache[chatId].modules[idx] = { ...statesCache[chatId].modules[idx], ...module, updatedAt: Date.now() };
    } else {
        statesCache[chatId].modules.push({ ...module, createdAt: Date.now(), updatedAt: Date.now() });
    }
    return persist(chatId);
}

function removeModule(chatId, name) {
    if (statesCache[chatId]?.modules) {
        statesCache[chatId].modules = statesCache[chatId].modules.filter(m => m.name !== name);
        return persist(chatId);
    }
}

function addSessionSummary(chatId, summary) {
    if (!statesCache[chatId]) statesCache[chatId] = {};
    if (!statesCache[chatId].sessionSummaries) statesCache[chatId].sessionSummaries = [];
    
    statesCache[chatId].sessionSummaries.unshift({
        summary: summary.slice(0, 2000),
        at: Date.now(),
        date: new Date().toISOString()
    });
    
    if (statesCache[chatId].sessionSummaries.length > 20) {
        statesCache[chatId].sessionSummaries = statesCache[chatId].sessionSummaries.slice(0, 20);
    }
    
    return persist(chatId);
}

function getSessionSummaries(chatId, limit = 5) {
    const data = statesCache[chatId];
    if (!data || !data.sessionSummaries) return [];
    return data.sessionSummaries.slice(0, limit);
}

function addAIRouterLog(chatId, logObj) {
    if (!statesCache[chatId]) statesCache[chatId] = {};
    if (!statesCache[chatId].aiRouterLogs) statesCache[chatId].aiRouterLogs = [];
    
    const entry = {
        at: Date.now(),
        date: new Date().toISOString(),
        model: logObj.model || 'unknown',
        userEmail: logObj.userEmail || null,
        success: logObj.success !== false,
        usage: logObj.usage || null,
        durationMs: logObj.durationMs || 0,
        inputMessages: logObj.inputMessages || 0,
        hasTools: logObj.hasTools || false,
        responseModel: logObj.responseModel || null,
        error: logObj.error || null
    };
    
    statesCache[chatId].aiRouterLogs.unshift(entry);
    
    if (statesCache[chatId].aiRouterLogs.length > MAX_AI_ROUTER_LOGS) {
        statesCache[chatId].aiRouterLogs = statesCache[chatId].aiRouterLogs.slice(0, MAX_AI_ROUTER_LOGS);
    }
    
    persist(chatId);
    return entry;
}

function getAIRouterLogs(chatId, limit = 50) {
    const data = statesCache[chatId];
    if (!data || !data.aiRouterLogs) return [];
    return data.aiRouterLogs.slice(0, limit);
}

function clearAIRouterLogs(chatId) {
    if (statesCache[chatId]) {
        statesCache[chatId].aiRouterLogs = [];
        return persist(chatId);
    }
}

function getAIRouterStats(chatId) {
    const data = statesCache[chatId];
    if (!data || !data.aiRouterLogs || data.aiRouterLogs.length === 0) {
        return { totalRequests: 0, totalTokens: 0, successCount: 0, errorCount: 0 };
    }
    
    const logs = data.aiRouterLogs;
    let totalTokens = 0;
    let successCount = 0;
    let errorCount = 0;
    
    for (const log of logs) {
        if (log.success) {
            successCount++;
            if (log.usage) {
                totalTokens += (log.usage.prompt_tokens || 0) + (log.usage.completion_tokens || 0);
            }
        } else {
            errorCount++;
        }
    }
    
    return {
        totalRequests: logs.length,
        totalTokens,
        successCount,
        errorCount,
        lastRequest: logs[0] || null
    };
}

module.exports = {
    getState,
    getByToken,
    getByVerifiedTelegramId,
    getByTokenAndTelegramId,
    setToken,
    setPending,
    verify,
    clearToken,
    setAI,
    setAIProvider,
    getAIProvider,
    clearAI,
    setEmail,
    setEmailPoll,
    getEmailStatus,
    clearEmail,
    addCommand,
    getLastCommands,
    clearLastCommands,
    getAllTokens,
    getAllChatIds,
    getAllStates,
    load,
    persist,
    CODE_EXPIRY_MS,
    hasAnyEmailActive,
    getCronStatus,
    addCronLog,
    getCronLogs,
    getConfigPath,
    getContentSettings,
    setContentSettings,
    getIntegrationSettings,
    setIntegrationSettings,
    migrateIntegrationSettings,
    getPinterestConfig,
    setPinterestConfig,
    clearPinterestConfig,
    getInstagramConfig,
    setInstagramConfig,
    clearInstagramConfig,
    getYoutubeConfig,
    setYoutubeConfig,
    clearYoutubeConfig,
    getFacebookConfig,
    setFacebookConfig,
    clearFacebookConfig,
    getTiktokConfig,
    setTiktokConfig,
    clearTiktokConfig,
    getVkVideoConfig,
    setVkVideoConfig,
    clearVkVideoConfig,
    getVideoPipelineSettings,
    setVideoPipelineSettings,
    getImageGenSettings,
    setImageGenSettings,
    ALLOWED_IMAGE_MODELS,
    getVkConfig,
    setVkConfig,
    getVkSettings,
    setVkSettings,
    getOkConfig,
    setOkConfig,
    clearOkConfig,
    getOkSettings,
    setOkSettings,
    getContextSettings,
    setContextSettings,
    addAIMessage,
    getAIMessages,
    clearAIMessages,
    setAIMessages,
    getAgentMode,
    setAgentMode,
    getBackupPath,
    getStateFilePath,
    getApps,
    addOrUpdateApp,
    removeApp,
    getAppUrl,
    cleanupDeletedApps,
    getModules,
    addModule,
    removeModule,
    addSessionSummary,
    getSessionSummaries,
    addAIRouterLog,
    getAIRouterLogs,
    clearAIRouterLogs,
    getAIRouterStats,
    setBotUsername,
    setOnboardingComplete,

    // === WordPress Blog Config ===
    getWpConfig(chatId) {
        const data = statesCache[chatId];
        return data?.wordpressConfig || null;
    },

    setWpConfig(chatId, patch = {}) {
        if (!statesCache[chatId]) statesCache[chatId] = {};
        const current = statesCache[chatId].wordpressConfig || {};
        const next = { ...current };

        if (patch.baseUrl !== undefined) next.baseUrl = String(patch.baseUrl || '').trim() || null;
        if (patch.username !== undefined) next.username = String(patch.username || '').trim() || null;
        if (patch.appPassword !== undefined) next.appPassword = patch.appPassword || null;
        if (patch.defaultCategoryId !== undefined) next.defaultCategoryId = patch.defaultCategoryId || null;
        if (patch.enabled !== undefined) next.enabled = !!patch.enabled;
        if (patch.autoPublish !== undefined) next.autoPublish = !!patch.autoPublish;
        if (patch.announceTelegram !== undefined) next.announceTelegram = !!patch.announceTelegram;
        if (patch.useKnowledgeBase !== undefined) next.useKnowledgeBase = !!patch.useKnowledgeBase;
        if (patch.scheduleTime !== undefined) next.scheduleTime = patch.scheduleTime || null;
        if (patch.scheduleEndTime !== undefined) next.scheduleEndTime = patch.scheduleEndTime || null;
        if (patch.scheduleTz !== undefined) next.scheduleTz = patch.scheduleTz || null;
        if (patch.scheduleDays !== undefined) {
            if (Array.isArray(patch.scheduleDays)) {
                next.scheduleDays = patch.scheduleDays.map(d => parseInt(d, 10)).filter(d => d >= 1 && d <= 7);
            }
        }
        if (patch.dailyLimit !== undefined) {
            const limit = parseInt(patch.dailyLimit, 10);
            next.dailyLimit = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 10) : 3;
        }
        if (patch.minIntervalHours !== undefined) {
            const hours = parseInt(patch.minIntervalHours, 10);
            next.minIntervalHours = Number.isFinite(hours) && hours > 0 ? Math.min(hours, 48) : 6;
        }
        if (patch.lastPublishedAt !== undefined) next.lastPublishedAt = patch.lastPublishedAt || null;
        if (patch.consecutiveErrors !== undefined) {
            const errors = parseInt(patch.consecutiveErrors, 10);
            next.consecutiveErrors = Number.isFinite(errors) && errors >= 0 ? errors : 0;
        }
        if (patch.stats !== undefined) next.stats = { ...(next.stats || {}), ...patch.stats };

        statesCache[chatId].wordpressConfig = next;
        return persist(chatId);
    },

    clearWpConfig(chatId) {
        if (statesCache[chatId]) {
            delete statesCache[chatId].wordpressConfig;
            return persist(chatId);
        }
    }
};
