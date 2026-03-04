const fs = require('fs').promises;
const path = require('path');
const { exec } = require('child_process');
const config = require('../config');

/**
 * Безопасное имя директории из chat_id (без /, .., спецсимволов)
 */
function sanitizeChatIdForPath(chatId) {
    if (!chatId || typeof chatId !== 'string') return 'default';
    return chatId.replace(/[^a-z0-9_-]/gi, '_').toLowerCase() || 'default';
}

/**
 * Возвращает абсолютный путь к директории данных пользователя (единый для контейнера и бэкапов)
 */
function getDataDir(chatId) {
    const base = path.resolve(config.DATA_ROOT);
    return path.join(base, sanitizeChatIdForPath(chatId));
}

/**
 * Создает директорию для хранения данных пользователя и возвращает абсолютный путь
 */
async function ensureUserDir(chatId) {
    const userDir = getDataDir(chatId);
    await fs.mkdir(userDir, { recursive: true });
    return userDir;
}

/**
 * Инициализирует корневые директории
 */
async function initStorage() {
    await fs.mkdir(config.DATA_ROOT, { recursive: true });
    await fs.mkdir(config.BACKUP_ROOT, { recursive: true });
    console.log(`[STORAGE] Data root: ${config.DATA_ROOT}`);
    console.log(`[STORAGE] Backup root: ${config.BACKUP_ROOT}`);
}

/**
 * Создает бэкап данных пользователя
 */
async function backupUserData(chatId) {
    const sourceDir = getDataDir(chatId);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupDir = path.join(config.BACKUP_ROOT, `${chatId}_${timestamp}`);
    
    try {
        await fs.access(sourceDir);
        await fs.mkdir(backupDir, { recursive: true });
        
        return new Promise((resolve, reject) => {
            exec(`cp -r ${sourceDir}/* ${backupDir}/`, (error) => {
                if (error) {
                    console.log(`[BACKUP] Failed for ${chatId}: ${error.message}`);
                    reject(error);
                } else {
                    console.log(`[BACKUP] Created: ${backupDir}`);
                    resolve(backupDir);
                }
            });
        });
    } catch {
        // Директория не существует
        return null;
    }
}

/**
 * Бэкап всех пользователей
 */
async function backupAllUsers(chatIds) {
    console.log(`[BACKUP] Starting backup for ${chatIds.length} users...`);
    const results = [];
    
    for (const chatId of chatIds) {
        try {
            const backupPath = await backupUserData(chatId);
            if (backupPath) results.push({ chatId, backupPath });
        } catch (error) {
            console.log(`[BACKUP] Error for ${chatId}: ${error.message}`);
        }
    }
    
    return results;
}

/**
 * Очистка старых бэкапов (старше 7 дней)
 */
async function cleanOldBackups() {
    const maxAge = 7 * 24 * 60 * 60 * 1000; // 7 дней
    const now = Date.now();
    
    try {
        const backups = await fs.readdir(config.BACKUP_ROOT);
        
        for (const backup of backups) {
            const backupPath = path.join(config.BACKUP_ROOT, backup);
            const stat = await fs.stat(backupPath);
            
            if (now - stat.mtimeMs > maxAge) {
                await fs.rm(backupPath, { recursive: true });
                console.log(`[BACKUP] Removed old: ${backup}`);
            }
        }
    } catch (error) {
        console.log(`[BACKUP] Cleanup error: ${error.message}`);
    }
}

/**
 * Получает размер директории пользователя
 */
async function getUserDataSize(chatId) {
    const userDir = getDataDir(chatId);
    
    return new Promise((resolve) => {
        exec(`du -sh ${userDir} 2>/dev/null | cut -f1`, (error, stdout) => {
            resolve(error ? '0' : stdout.trim());
        });
    });
}

module.exports = {
    sanitizeChatIdForPath,
    getDataDir,
    ensureUserDir,
    initStorage,
    backupUserData,
    backupAllUsers,
    cleanOldBackups,
    getUserDataSize
};
