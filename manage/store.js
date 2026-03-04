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
    // Заменяем недопустимые символы в chatId для имени файла
    const safeChatId = String(chatId).replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(STATE_DIR, `${STATE_FILE_PREFIX}${safeChatId}${STATE_FILE_SUFFIX}`);
}

// Функция для получения пути к бэкапу
function getBackupFilePath(chatId) {
    return getStateFilePath(chatId) + '.bak';
}

// Настройки контекста ИИ по умолчанию
const DEFAULT_CONTEXT_SETTINGS = {
    maxCommands: 5,           // Сколько последних команд показывать
    maxFiles: 80,             // Максимум файлов в списке
    maxDepth: 3,              // Глубина поиска файлов
    maxFileLines: 30,         // Сколько строк файлов показывать
    personaLines: 20,         // Строк на файл персонализации
    personaChars: 500,        // Максимум символов на файл персонализации
    includeStdout: true,      // Включать stdout в контекст
    includeStderr: true,      // Включать stderr в контекст
    stdoutMaxChars: 200,      // Максимум символов stdout
    stderrMaxChars: 200       // Максимум символов stderr
};

// Отслеживание процессов сохранения
const persistingChatIds = new Set();

/**
 * Сохраняет состояние конкретного chatId в отдельный файл с бэкапом
 */
async function persist(chatId) {
    if (!chatId) {
        console.error('[MANAGE] persist called without chatId');
        return;
    }
    
    // Предотвращаем параллельную запись одного файла
    if (persistingChatIds.has(chatId)) {
        // Перезапланируем сохранение
        setImmediate(() => persist(chatId));
        return;
    }
    
    persistingChatIds.add(chatId);
    
    try {
        const stateFile = getStateFilePath(chatId);
        const backupFile = getBackupFilePath(chatId);
        
        // Создаём директорию если нет
        await fs.mkdir(STATE_DIR, { recursive: true });
        
        // Формируем данные для сохранения
        const data = statesCache[chatId] || {};
        const toSave = {
            chatId,
            data,
            savedAt: Date.now()
        };
        
        // Создаём бэкап существующего файла
        try {
            await fs.access(stateFile);
            await fs.copyFile(stateFile, backupFile);
        } catch (e) {
            // Файл не существует - это нормально для нового chatId
        }
        
        // Записываем во временный файл, затем переименовываем
        const tmpFile = `${stateFile}.tmp.${Date.now()}`;
        await fs.writeFile(tmpFile, JSON.stringify(toSave, null, 2), 'utf8');
        await fs.rename(tmpFile, stateFile);
        
    } catch (err) {
        console.error(`[MANAGE] persist error for ${chatId}:`, err.message);
    } finally {
        persistingChatIds.delete(chatId);
    }
}

/**
 * Загружает состояние конкретного chatId из файла
 */
async function loadChatState(chatId) {
    const stateFile = getStateFilePath(chatId);
    
    try {
        const raw = await fs.readFile(stateFile, 'utf8');
        const parsed = JSON.parse(raw);
        statesCache[chatId] = parsed.data || {};
        return statesCache[chatId];
    } catch (err) {
        if (err.code === 'ENOENT') {
            // Файл не существует - создаём пустое состояние
            statesCache[chatId] = {};
            return statesCache[chatId];
        }
        // Ошибка парсинга - пробуем загрузить из бэкапа
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

/**
 * Загружает все состояния при старте
 * Также выполняет миграцию со старого единого файла
 */
async function load() {
    try {
        await fs.mkdir(STATE_DIR, { recursive: true });
    } catch (e) {}
    
    // Проверяем наличие старого файла для миграции
    try {
        const oldRaw = await fs.readFile(OLD_STATE_FILE, 'utf8');
        const oldParsed = JSON.parse(oldRaw);
        
        if (oldParsed.byChatId && Object.keys(oldParsed.byChatId).length > 0) {
            console.log('[MANAGE] Migrating from old single-file format...');
            
            // Мигрируем каждый chatId в отдельный фа��л
            for (const [chatId, data] of Object.entries(oldParsed.byChatId)) {
                statesCache[chatId] = data;
                await persist(chatId);
            }
            
            // Бэкапим старый файл и переименовываем
            const migratedFile = `${OLD_STATE_FILE}.migrated.${Date.now()}`;
            await fs.rename(OLD_STATE_FILE, migratedFile);
            console.log(`[MANAGE] Migration complete. Old file moved to ${migratedFile}`);
        }
    } catch (err) {
        if (err.code !== 'ENOENT') {
            console.error('[MANAGE] Old file migration error:', err.message);
        }
    }
    
    // Загружаем все файлы manage-state-*.json
    try {
        const files = await fs.readdir(STATE_DIR);
        const stateFiles = files.filter(f => 
            f.startsWith(STATE_FILE_PREFIX) && 
            f.endsWith(STATE_FILE_SUFFIX) &&
            !f.endsWith('.bak') &&
            !f.endsWith('.tmp')
        );
        
        for (const file of stateFiles) {
            // Извлекаем chatId из имени файла
            const match = file.match(new RegExp(`^${STATE_FILE_PREFIX}(.+)${STATE_FILE_SUFFIX}$`));
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

// ============ API функции ============

function getState(chatId) {
    return statesCache[chatId] || null;
}

function getByToken(token) {
    for (const [cid, data] of Object.entries(statesCache)) {
        if (data.token === token) return cid;
    }
    return null;
}

function setToken(chatId, token) {
    if (!statesCache[chatId]) statesCache[chatId] = {};
    statesCache[chatId].token = token;
    statesCache[chatId].verifiedTelegramId = null;
    statesCache[chatId].verifiedUsername = null;
    statesCache[chatId].pending = null;
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
    
    // Сохраняем информацию о балансе
    if (balanceCheck) {
        statesCache[chatId].aiBalance = balanceCheck.balance;
        statesCache[chatId].aiBalanceExpired = balanceCheck.expired;
        statesCache[chatId].aiBlocked = !balanceCheck.canUse;
        statesCache[chatId].aiBlockReason = balanceCheck.reason || null;
    }
    
    return persist(chatId);
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
    // Валидация и санитизация
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
    
    // Удаляем файл состояния
    const stateFile = getStateFilePath(chatId);
    fs.unlink(stateFile).catch(() => {});
    
    // Удаляем бэкап
    const backupFile = getBackupFilePath(chatId);
    fs.unlink(backupFile).catch(() => {});
}

function setEmail(chatId, emailConfig) {
    if (!statesCache[chatId]) statesCache[chatId] = {};
    statesCache[chatId].email = {
        active: true, // Email активен по умолчанию при сохранении
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
    
    // Возвращаем полные пароли (пользователь авторизован по Chat ID)
    return {
        hasEmail: true,
        active: data.email.active !== false, // true по умолчанию
        config: {
            imapHost: data.email.imapHost,
            imapPort: data.email.imapPort,
            imapUser: data.email.imapUser,
            imapPass: data.email.imapPass, // Полный пароль
            smtpHost: data.email.smtpHost,
            smtpPort: data.email.smtpPort,
            smtpUser: data.email.smtpUser,
            smtpPass: data.email.smtpPass // Полный пароль
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
    // Для обратной совместимости возвращаем директорию
    return STATE_DIR;
}

/**
 * Добавляет сообщение в историю переписки с AI
 */
function addAIMessage(chatId, channel = 'telegram', role, content) {
    const key = `${chatId}:${channel}`;
    if (!statesCache[chatId]) statesCache[chatId] = {};
    if (!statesCache[chatId].aiMessages) statesCache[chatId].aiMessages = {};
    if (!statesCache[chatId].aiMessages[key]) statesCache[chatId].aiMessages[key] = [];
    
    statesCache[chatId].aiMessages[key].push({
        role,
        content: (content || '').slice(0, 10000), // Ограничиваем размер сообщения
        at: Date.now()
    });
    // Ограничиваем историю
    if (statesCache[chatId].aiMessages[key].length > MAX_AI_MESSAGES) {
        statesCache[chatId].aiMessages[key] = statesCache[chatId].aiMessages[key].slice(-MAX_AI_MESSAGES);
    }
    return persist(chatId);
}

/**
 * Получает историю переписки с AI
 */
function getAIMessages(chatId, channel = 'telegram', limit = 50) {
    const key = `${chatId}:${channel}`;
    const data = statesCache[chatId];
    if (!data || !data.aiMessages || !data.aiMessages[key]) return [];
    return data.aiMessages[key].slice(-limit);
}

/**
 * Очищает историю переписки с AI
 */
function clearAIMessages(chatId, channel = 'telegram') {
    const key = `${chatId}:${channel}`;
    if (statesCache[chatId] && statesCache[chatId].aiMessages) {
        statesCache[chatId].aiMessages[key] = [];
        return persist(chatId);
    }
}

/**
 * Устанавливает полную историю сообщений (для обновления после tool calls)
 */
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
    // Ограничиваем историю
    if (statesCache[chatId].aiMessages[key].length > MAX_AI_MESSAGES) {
        statesCache[chatId].aiMessages[key] = statesCache[chatId].aiMessages[key].slice(-MAX_AI_MESSAGES);
    }
    return persist(chatId);
}

/**
 * Получает текущий режим агента
 */
function getAgentMode(chatId) {
    const data = statesCache[chatId];
    return data?.agentMode || 'TERMINAL';
}

/**
 * Устанавливает режим агента
 */
function setAgentMode(chatId, mode) {
    if (!statesCache[chatId]) statesCache[chatId] = {};
    statesCache[chatId].agentMode = mode;
    return persist(chatId);
}

/**
 * Возвращает путь к файлу бэкапа для chatId
 */
function getBackupPath(chatId) {
    return getBackupFilePath(chatId);
}

// ====================== NODE.JS APPS REGISTRY ======================
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
    return `https://claw.pro-talk.ru/sandbox/${chatId}/app/${name}`;
}

/**
 * Очищает удалённые и остановленные приложения из реестра
 * Возвращает количество удалённых записей
 */
function cleanupDeletedApps(chatId) {
    if (!statesCache[chatId]?.apps) return 0;
    
    const before = statesCache[chatId].apps.length;
    
    // Оставляем только работающие приложения (status === 'running')
    statesCache[chatId].apps = statesCache[chatId].apps.filter(app => {
        return app.status === 'running';
    });
    
    const after = statesCache[chatId].apps.length;
    const deleted = before - after;
    
    if (deleted > 0) {
        persist(chatId);
    }
    
    return deleted;
}

// ====================== PYTHON MODULES REGISTRY ======================
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

// ====================== SESSION SUMMARY ======================
/**
 * Сохраняет резюме завершённой сессии
 */
function addSessionSummary(chatId, summary) {
    if (!statesCache[chatId]) statesCache[chatId] = {};
    if (!statesCache[chatId].sessionSummaries) statesCache[chatId].sessionSummaries = [];
    
    statesCache[chatId].sessionSummaries.unshift({
        summary: summary.slice(0, 2000),
        at: Date.now(),
        date: new Date().toISOString()
    });
    
    // Храним последние 20 резюме
    if (statesCache[chatId].sessionSummaries.length > 20) {
        statesCache[chatId].sessionSummaries = statesCache[chatId].sessionSummaries.slice(0, 20);
    }
    
    return persist(chatId);
}

/**
 * Получает последние резюме сессий
 */
function getSessionSummaries(chatId, limit = 5) {
    const data = statesCache[chatId];
    if (!data || !data.sessionSummaries) return [];
    return data.sessionSummaries.slice(0, limit);
}

// ====================== AI ROUTER LOGS ======================
/**
 * Добавляет запись в лог AI Router
 */
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
    
    // Ограничиваем размер лога
    if (statesCache[chatId].aiRouterLogs.length > MAX_AI_ROUTER_LOGS) {
        statesCache[chatId].aiRouterLogs = statesCache[chatId].aiRouterLogs.slice(0, MAX_AI_ROUTER_LOGS);
    }
    
    persist(chatId);
    return entry;
}

/**
 * Получает лог AI Router
 */
function getAIRouterLogs(chatId, limit = 50) {
    const data = statesCache[chatId];
    if (!data || !data.aiRouterLogs) return [];
    return data.aiRouterLogs.slice(0, limit);
}

/**
 * Очищает лог AI Router
 */
function clearAIRouterLogs(chatId) {
    if (statesCache[chatId]) {
        statesCache[chatId].aiRouterLogs = [];
        return persist(chatId);
    }
}

/**
 * Получает статистику использования AI Router
 */
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
    setToken,
    setPending,
    verify,
    clearToken,
    setAI,
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
    getAIRouterStats
};
