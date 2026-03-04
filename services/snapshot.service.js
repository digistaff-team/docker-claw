const fs = require('fs').promises;
const path = require('path');
const config = require('../config');
const sessionService = require('./session.service');
const dockerService = require('./docker.service');

/**
 * Сервис для персистентного хранения снапшотов файлов.
 * 
 * Структура хранения:
 * /workspace/.snapshots/
 *   {chatId}/
 *     {escapedFilePath}/
 *       {timestamp}.snap
 *       {timestamp}.snap
 * 
 * Глубина стека: последние N версий (по умолчанию 10)
 * TTL: снапшоты старше 7 дней удаляются автоматически
 */

/**
 * Экранирует путь файла для использования как имя директории
 * Пример: /workspace/apps/myapp/app.js -> _workspace_apps_myapp_app.js
 */
function escapeFilePath(filePath) {
    if (!filePath || typeof filePath !== 'string') return 'unknown';
    // Удаляем ведущий слеш и заменяем остальные слеши на подчёркивания
    return filePath
        .replace(/^\//, '')
        .replace(/\//g, '_')
        .replace(/[^a-zA-Z0-9_.-]/g, '_')
        .slice(0, 200); // Ограничение длины
}

/**
 * Возвращает путь к директории снапшотов для файла
 */
function getSnapshotDir(chatId, filePath) {
    const escaped = escapeFilePath(filePath);
    return path.join(config.SNAPSHOT_ROOT, String(chatId), escaped);
}

/**
 * Инициализирует корневую директорию снапшотов
 */
async function initSnapshots() {
    await fs.mkdir(config.SNAPSHOT_ROOT, { recursive: true });
    console.log(`[SNAPSHOT] Root: ${config.SNAPSHOT_ROOT}`);
    console.log(`[SNAPSHOT] Max depth: ${config.SNAPSHOT_MAX_DEPTH}`);
    console.log(`[SNAPSHOT] TTL: ${config.SNAPSHOT_TTL_DAYS} days`);
}

/**
 * Сохраняет снапшот файла
 * @param {string} chatId - ID чата
 * @param {string} filePath - Путь к файлу
 * @param {string} content - Содержимое файла
 * @returns {Promise<{ok: boolean, snapshotPath: string, timestamp: number}>}
 */
async function saveSnapshot(chatId, filePath, content) {
    try {
        const snapshotDir = getSnapshotDir(chatId, filePath);
        await fs.mkdir(snapshotDir, { recursive: true });
        
        const timestamp = Date.now();
        const snapshotPath = path.join(snapshotDir, `${timestamp}.snap`);
        
        // Сохраняем снапшот
        await fs.writeFile(snapshotPath, content, 'utf-8');
        
        // Обрезаем стек до максимальной глубины
        await pruneStack(chatId, filePath, config.SNAPSHOT_MAX_DEPTH);
        
        console.log(`[SNAPSHOT] Saved: ${snapshotPath}`);
        
        return {
            ok: true,
            snapshotPath,
            timestamp
        };
    } catch (error) {
        console.error(`[SNAPSHOT] Save error: ${error.message}`);
        return {
            ok: false,
            error: error.message
        };
    }
}

/**
 * Получает список снапшотов для файла
 * @param {string} chatId - ID чата
 * @param {string} filePath - Путь к файлу
 * @returns {Promise<Array<{timestamp: number, date: string, size: number}>>}
 */
async function listSnapshots(chatId, filePath) {
    try {
        const snapshotDir = getSnapshotDir(chatId, filePath);
        
        // Проверяем существование директории
        try {
            await fs.access(snapshotDir);
        } catch {
            return [];
        }
        
        const files = await fs.readdir(snapshotDir);
        const snapshots = [];
        
        for (const file of files) {
            if (!file.endsWith('.snap')) continue;
            
            const timestamp = parseInt(file.replace('.snap', ''));
            if (isNaN(timestamp)) continue;
            
            const snapshotPath = path.join(snapshotDir, file);
            const stat = await fs.stat(snapshotPath);
            
            snapshots.push({
                timestamp,
                date: new Date(timestamp).toISOString(),
                size: stat.size,
                path: snapshotPath
            });
        }
        
        // Сортируем по убыванию времени (новые первые)
        snapshots.sort((a, b) => b.timestamp - a.timestamp);
        
        return snapshots;
    } catch (error) {
        console.error(`[SNAPSHOT] List error: ${error.message}`);
        return [];
    }
}

/**
 * Получает содержимое конкретного снапшота
 * @param {string} chatId - ID чата
 * @param {string} filePath - Путь к файлу
 * @param {number} stepsBack - На сколько шагов назад (1 = последний снапшот)
 * @returns {Promise<{ok: boolean, content?: string, snapshot?: object}>}
 */
async function getSnapshot(chatId, filePath, stepsBack = 1) {
    try {
        const snapshots = await listSnapshots(chatId, filePath);
        
        if (snapshots.length === 0) {
            return {
                ok: false,
                error: 'Снапшоты не найдены'
            };
        }
        
        const index = stepsBack - 1; // stepsBack=1 → index=0 (последний)
        
        if (index < 0 || index >= snapshots.length) {
            return {
                ok: false,
                error: `Снапшот на ${stepsBack} шагов назад не найден. Доступно: ${snapshots.length}`
            };
        }
        
        const snapshot = snapshots[index];
        const content = await fs.readFile(snapshot.path, 'utf-8');
        
        return {
            ok: true,
            content,
            snapshot
        };
    } catch (error) {
        console.error(`[SNAPSHOT] Get error: ${error.message}`);
        return {
            ok: false,
            error: error.message
        };
    }
}

/**
 * Восстанавливает файл из снапшота
 * @param {string} chatId - ID чата
 * @param {string} filePath - Путь к файлу
 * @param {number} stepsBack - На сколько шагов назад (по умолчанию 1)
 * @returns {Promise<{ok: boolean, message?: string, snapshot?: object}>}
 */
async function restoreSnapshot(chatId, filePath, stepsBack = 1) {
    try {
        const result = await getSnapshot(chatId, filePath, stepsBack);
        
        if (!result.ok) {
            return result;
        }
        
        // Получаем сессию для записи в контейнер
        const session = sessionService.getSession(chatId);
        if (!session) {
            return {
                ok: false,
                error: 'Сессия не найдена'
            };
        }
        
        // Создаём временный файл на хосте
        const tempFile = `/tmp/restore-${Date.now()}.tmp`;
        await fs.writeFile(tempFile, result.content, 'utf-8');
        
        // Копируем в контейнер
        await dockerService.copyToContainer(tempFile, session.containerId, filePath);
        
        // Удаляем временный файл
        await fs.unlink(tempFile).catch(() => {});
        
        console.log(`[SNAPSHOT] Restored: ${filePath} from ${result.snapshot.date}`);
        
        return {
            ok: true,
            message: `Файл ${filePath} восстановлен из снапшота от ${result.snapshot.date}`,
            snapshot: result.snapshot
        };
    } catch (error) {
        console.error(`[SNAPSHOT] Restore error: ${error.message}`);
        return {
            ok: false,
            error: error.message
        };
    }
}

/**
 * Удаляет снапшоты старше TTL
 */
async function cleanOldSnapshots() {
    const ttlMs = config.SNAPSHOT_TTL_DAYS * 24 * 60 * 60 * 1000;
    const cutoffTime = Date.now() - ttlMs;
    
    let removedCount = 0;
    let totalSize = 0;
    
    try {
        // Проверяем существование корневой директории
        try {
            await fs.access(config.SNAPSHOT_ROOT);
        } catch {
            return { removed: 0, size: 0 };
        }
        
        // Проходим по всем chatId
        const chatDirs = await fs.readdir(config.SNAPSHOT_ROOT);
        
        for (const chatId of chatDirs) {
            const chatPath = path.join(config.SNAPSHOT_ROOT, chatId);
            const chatStat = await fs.stat(chatPath);
            
            if (!chatStat.isDirectory()) continue;
            
            // Проходим по всем файлам
            const fileDirs = await fs.readdir(chatPath);
            
            for (const fileDir of fileDirs) {
                const filePath = path.join(chatPath, fileDir);
                const fileStat = await fs.stat(filePath);
                
                if (!fileStat.isDirectory()) continue;
                
                // Проходим по всем снапшотам
                const snapshots = await fs.readdir(filePath);
                
                for (const snapshot of snapshots) {
                    if (!snapshot.endsWith('.snap')) continue;
                    
                    const timestamp = parseInt(snapshot.replace('.snap', ''));
                    if (isNaN(timestamp)) continue;
                    
                    if (timestamp < cutoffTime) {
                        const snapshotPath = path.join(filePath, snapshot);
                        const snapStat = await fs.stat(snapshotPath);
                        
                        await fs.unlink(snapshotPath);
                        removedCount++;
                        totalSize += snapStat.size;
                    }
                }
                
                // Удаляем пустую директорию файла
                const remaining = await fs.readdir(filePath);
                if (remaining.length === 0) {
                    await fs.rmdir(filePath);
                }
            }
            
            // Удаляем пустую директорию chatId
            const remainingChat = await fs.readdir(chatPath);
            if (remainingChat.length === 0) {
                await fs.rmdir(chatPath);
            }
        }
        
        if (removedCount > 0) {
            console.log(`[SNAPSHOT] Cleaned ${removedCount} old snapshots (${(totalSize / 1024).toFixed(2)} KB)`);
        }
        
        return { removed: removedCount, size: totalSize };
    } catch (error) {
        console.error(`[SNAPSHOT] Cleanup error: ${error.message}`);
        return { removed: 0, size: 0, error: error.message };
    }
}

/**
 * Обрезает стек снапшотов до максимальной глубины
 * @param {string} chatId - ID чата
 * @param {string} filePath - Путь к файлу
 * @param {number} maxDepth - Максимальное количество снапшотов
 */
async function pruneStack(chatId, filePath, maxDepth) {
    try {
        const snapshots = await listSnapshots(chatId, filePath);
        
        if (snapshots.length <= maxDepth) {
            return;
        }
        
        // Удаляем старые снапшоты (в конце списка после сортировки)
        const toRemove = snapshots.slice(maxDepth);
        
        for (const snapshot of toRemove) {
            await fs.unlink(snapshot.path);
        }
        
        console.log(`[SNAPSHOT] Pruned ${toRemove.length} old snapshots for ${filePath}`);
    } catch (error) {
        console.error(`[SNAPSHOT] Prune error: ${error.message}`);
    }
}

/**
 * Получает статистику по снапшотам пользователя
 * @param {string} chatId - ID чата
 */
async function getSnapshotStats(chatId) {
    try {
        const chatPath = path.join(config.SNAPSHOT_ROOT, String(chatId));
        
        try {
            await fs.access(chatPath);
        } catch {
            return { files: 0, snapshots: 0, size: 0 };
        }
        
        let totalSnapshots = 0;
        let totalSize = 0;
        let filesCount = 0;
        
        const fileDirs = await fs.readdir(chatPath);
        
        for (const fileDir of fileDirs) {
            const filePath = path.join(chatPath, fileDir);
            const fileStat = await fs.stat(filePath);
            
            if (!fileStat.isDirectory()) continue;
            
            filesCount++;
            const snapshots = await fs.readdir(filePath);
            
            for (const snapshot of snapshots) {
                if (!snapshot.endsWith('.snap')) continue;
                
                totalSnapshots++;
                const snapPath = path.join(filePath, snapshot);
                const snapStat = await fs.stat(snapPath);
                totalSize += snapStat.size;
            }
        }
        
        return {
            files: filesCount,
            snapshots: totalSnapshots,
            size: totalSize
        };
    } catch (error) {
        console.error(`[SNAPSHOT] Stats error: ${error.message}`);
        return { files: 0, snapshots: 0, size: 0, error: error.message };
    }
}

module.exports = {
    initSnapshots,
    saveSnapshot,
    listSnapshots,
    getSnapshot,
    restoreSnapshot,
    cleanOldSnapshots,
    pruneStack,
    getSnapshotStats,
    escapeFilePath,
    getSnapshotDir
};
