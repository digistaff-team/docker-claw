const fs = require('fs').promises;
const path = require('path');
const config = require('../config');
const sessionService = require('./session.service');
const dockerService = require('./docker.service');

/**
 * Постоянная карта проекта с инвалидацией по mtime
 * Хранится в /workspace/.project/map.json
 */

const CACHE_FILE = 'map.json';
const CACHE_DIR = config.PROJECT_CACHE_DIR;

/**
 * Получить путь к файлу кэша в контейнере
 */
function getCachePath() {
    return `/workspace/${CACHE_DIR}/${CACHE_FILE}`;
}

/**
 * Получить путь к директории кэша в контейнере
 */
function getCacheDir() {
    return `/workspace/${CACHE_DIR}`;
}

/**
 * Проверяет, существует ли кэш в контейнере
 */
async function cacheExists(chatId) {
    const session = sessionService.getSession(chatId);
    if (!session) return false;
    
    try {
        const result = await dockerService.executeInContainer(
            session.containerId,
            `test -f ${getCachePath()} && echo "exists"`
        );
        return result.stdout.trim() === 'exists';
    } catch (e) {
        return false;
    }
}

/**
 * Читает кэш из контейнера
 */
async function readCache(chatId) {
    const session = sessionService.getSession(chatId);
    if (!session) return null;
    
    try {
        const result = await dockerService.executeInContainer(
            session.containerId,
            `cat ${getCachePath()} 2>/dev/null`
        );
        
        if (!result.stdout || !result.stdout.trim()) {
            return null;
        }
        
        const cache = JSON.parse(result.stdout);
        console.log(`[PROJECT-CACHE] Loaded for ${chatId}, files: ${Object.keys(cache.tree || {}).length}`);
        return cache;
    } catch (e) {
        console.log(`[PROJECT-CACHE] Read error for ${chatId}: ${e.message}`);
        return null;
    }
}

/**
 * Сохраняет кэш в контейнер
 */
async function writeCache(chatId, cache) {
    const session = sessionService.getSession(chatId);
    if (!session) return false;
    
    try {
        // Создаём директорию если нет
        await dockerService.executeInContainer(
            session.containerId,
            `mkdir -p ${getCacheDir()}`
        );
        
        // Записываем кэш
        const cacheJson = JSON.stringify(cache, null, 2);
        const tempFile = `/tmp/cache-${Date.now()}.json`;
        
        // Записываем во временный файл на хосте
        await fs.writeFile(tempFile, cacheJson, 'utf8');
        
        // Копируем в контейнер
        await dockerService.copyToContainer(tempFile, session.containerId, getCachePath());
        
        // Удаляем временный файл
        await fs.unlink(tempFile).catch(() => {});
        
        console.log(`[PROJECT-CACHE] Saved for ${chatId}`);
        return true;
    } catch (e) {
        console.error(`[PROJECT-CACHE] Write error for ${chatId}: ${e.message}`);
        return false;
    }
}

/**
 * Сканирует файловую систему и строит дерево файлов
 * Использует find -printf вместо find -exec stat для скорости (в 10-100 раз быстрее)
 */
async function scanFileTree(chatId, maxDepth = 5, maxFiles = 5000) {
    const session = sessionService.getSession(chatId);
    if (!session) return {};
    
    try {
        // Быстрый find с -printf (без отдельных процессов stat)
        // %y = тип файла: f=file, d=directory
        // %p = полный путь
        // %s = размер в байтах
        // %T@ = mtime в секундах (unix timestamp)
        // Исключаем node_modules, .git, __pycache__, .venv и другие тяжёлые директории
        const result = await dockerService.executeInContainer(
            session.containerId,
            `find /workspace -maxdepth ${maxDepth} ` +
            `-not -path '*/node_modules/*' ` +
            `-not -path '*/.git/*' ` +
            `-not -path '*/__pycache__/*' ` +
            `-not -path '*/.venv/*' ` +
            `-not -path '*/venv/*' ` +
            `-not -path '*/.npm/*' ` +
            `-not -path '*/dist/*' ` +
            `-not -path '*/build/*' ` +
            `\\( -type f -o -type d \\) ` +
            `-printf "%y|%p|%s|%T@\\n" 2>/dev/null | head -${maxFiles}`
        );
        
        const lines = (result.stdout || '').trim().split('\n').filter(Boolean);
        const tree = {};
        
        for (const line of lines) {
            const parts = line.split('|');
            if (parts.length < 4) continue;
            
            const [fileType, filepath, size, mtime] = parts;
            if (!filepath || filepath === '/workspace') continue;
            
            const relPath = filepath.replace('/workspace/', '');
            // %y возвращает 'f' для file, 'd' для directory
            const isDir = fileType === 'd';
            
            tree[relPath] = {
                type: isDir ? 'dir' : 'file',
                size: parseInt(size) || 0,
                mtime: Math.floor(parseFloat(mtime) * 1000) || Date.now(), // конвертируем в ms
                path: filepath
            };
        }
        
        console.log(`[PROJECT-CACHE] Scanned ${Object.keys(tree).length} items for ${chatId}`);
        return tree;
    } catch (e) {
        console.error(`[PROJECT-CACHE] Scan error for ${chatId}: ${e.message}`);
        return {};
    }
}

/**
 * Извлекает экспорты из JS/Python файла (упрощённый анализ)
 */
async function extractExports(chatId, filepath) {
    const session = sessionService.getSession(chatId);
    if (!session) return null;
    
    const ext = path.extname(filepath);
    if (!['.js', '.ts', '.py'].includes(ext)) return null;
    
    try {
        const result = await dockerService.executeInContainer(
            session.containerId,
            `head -100 ${filepath} 2>/dev/null`
        );
        
        const content = result.stdout || '';
        const exports = [];
        
        if (ext === '.js' || ext === '.ts') {
            // Ищем module.exports, exports., export function/const
            const exportMatches = content.match(/(?:module\.exports\s*=\s*|exports\.(\w+)\s*=|export\s+(?:async\s+)?function\s+(\w+)|export\s+const\s+(\w+))/g);
            if (exportMatches) {
                exportMatches.forEach(m => {
                    const nameMatch = m.match(/(?:exports\.|function\s+|const\s+)(\w+)/);
                    if (nameMatch) exports.push(nameMatch[1]);
                });
            }
        } else if (ext === '.py') {
            // Ищем def и class
            const defMatches = content.match(/(?:def\s+(\w+)|class\s+(\w+))/g);
            if (defMatches) {
                defMatches.forEach(m => {
                    const nameMatch = m.match(/(?:def\s+|class\s+)(\w+)/);
                    if (nameMatch) exports.push(nameMatch[1]);
                });
            }
        }
        
        return exports.length > 0 ? exports : null;
    } catch (e) {
        return null;
    }
}

/**
 * Строит summary для файла
 */
async function buildFileSummary(chatId, filepath, fileStat) {
    const session = sessionService.getSession(chatId);
    if (!session) return null;
    
    try {
        const exports = await extractExports(chatId, filepath);
        
        return {
            exports: exports || [],
            mtime: fileStat.mtime,
            size: fileStat.size,
            updatedAt: Date.now()
        };
    } catch (e) {
        return null;
    }
}

/**
 * Внутренняя функция построения кэша (без таймаута)
 */
async function _buildProjectCacheInternal(chatId, options = {}) {
    const {
        maxDepth = 5,
        maxFiles = config.PROJECT_CACHE_MAX_FILES,
        forceRebuild = false
    } = options;
    
    console.log(`[PROJECT-CACHE] Building for ${chatId}, force: ${forceRebuild}`);
    
    // Сканируем файловую систему
    const tree = await scanFileTree(chatId, maxDepth, maxFiles);
    
    // Читаем старый кэш если есть
    const oldCache = forceRebuild ? null : await readCache(chatId);
    const oldSummaries = oldCache?.summaries || {};
    
    // Строим summaries только для изменённых файлов
    const summaries = {};
    const summaryPromises = [];
    
    for (const [relPath, fileStat] of Object.entries(tree)) {
        if (fileStat.type === 'dir') continue;
        
        const oldSummary = oldSummaries[relPath];
        
        // Если файл не менялся, берём старый summary
        if (oldSummary && oldSummary.mtime === fileStat.mtime) {
            summaries[relPath] = oldSummary;
        } else {
            // Иначе строим новый summary
            summaryPromises.push(
                buildFileSummary(chatId, fileStat.path, fileStat).then(summary => {
                    if (summary) summaries[relPath] = summary;
                })
            );
        }
    }
    
    // Ждём построения всех summaries (с лимитом параллельности)
    const batchSize = 10;
    for (let i = 0; i < summaryPromises.length; i += batchSize) {
        await Promise.all(summaryPromises.slice(i, i + batchSize));
    }
    
    // Строим граф зависимостей (пока пустой, будет в п.4)
    const deps = {};
    
    const cache = {
        updatedAt: Date.now(),
        tree,
        deps,
        summaries,
        stats: {
            totalFiles: Object.keys(tree).filter(k => tree[k].type === 'file').length,
            totalDirs: Object.keys(tree).filter(k => tree[k].type === 'dir').length,
            cacheHits: 0,
            cacheMisses: summaryPromises.length
        }
    };
    
    // Сохраняем кэш
    await writeCache(chatId, cache);
    
    return cache;
}

/**
 * Создаёт или обновляет кэш проекта с таймаутом
 */
async function buildProjectCache(chatId, options = {}) {
    const timeoutMs = options.timeoutMs || 8000; // 8 секунд по умолчанию
    
    const timeout = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Cache build timeout')), timeoutMs)
    );
    
    try {
        return await Promise.race([
            _buildProjectCacheInternal(chatId, options),
            timeout
        ]);
    } catch (e) {
        console.error(`[PROJECT-CACHE] Build failed or timed out for ${chatId}: ${e.message}`);
        // Возвращаем минимальный кэш чтобы не блокировать агента
        return {
            updatedAt: Date.now(),
            tree: {},
            deps: {},
            summaries: {},
            stats: { error: e.message },
            _incomplete: true
        };
    }
}

/**
 * Получает кэш проекта, создаёт если не существует
 */
async function getProjectCache(chatId, options = {}) {
    const { forceRebuild = false } = options;
    
    // Если принудительный пересчёт
    if (forceRebuild) {
        return await buildProjectCache(chatId, { ...options, forceRebuild: true });
    }
    
    // Пытаемся прочитать существующий кэш
    const cache = await readCache(chatId);
    
    if (cache) {
        // Проверяем TTL
        const age = Date.now() - cache.updatedAt;
        const maxAge = config.PROJECT_CACHE_TTL_DAYS * 24 * 60 * 60 * 1000;
        
        if (age < maxAge) {
            return cache;
        }
        
        console.log(`[PROJECT-CACHE] Cache expired for ${chatId}, rebuilding...`);
    }
    
    // Строим новый кэш
    return await buildProjectCache(chatId, options);
}

/**
 * Инвалидирует кэш для конкретного файла
 */
async function invalidateFile(chatId, filepath) {
    const cache = await readCache(chatId);
    if (!cache) return false;
    
    const relPath = filepath.replace('/workspace/', '');
    
    // Удаляем из tree и summaries
    delete cache.tree[relPath];
    delete cache.summaries[relPath];
    
    // Обновляем статистику
    cache.stats = cache.stats || {};
    cache.stats.lastInvalidation = Date.now();
    cache.stats.invalidatedFile = relPath;
    
    // Сохраняем
    await writeCache(chatId, cache);
    
    console.log(`[PROJECT-CACHE] Invalidated file ${relPath} for ${chatId}`);
    return true;
}

/**
 * Обновляет информацию о файле в кэше
 */
async function updateFileInCache(chatId, filepath) {
    const session = sessionService.getSession(chatId);
    if (!session) return false;
    
    const cache = await readCache(chatId);
    if (!cache) {
        // Если кэша нет, строим полный
        await buildProjectCache(chatId);
        return true;
    }
    
    const relPath = filepath.replace('/workspace/', '');
    
    try {
        // Получаем stat файла
        const result = await dockerService.executeInContainer(
            session.containerId,
            `stat -c "%s|%Y" ${filepath} 2>/dev/null`
        );
        
        if (!result.stdout || !result.stdout.trim()) {
            // Файл не существует - удаляем из кэша
            delete cache.tree[relPath];
            delete cache.summaries[relPath];
            await writeCache(chatId, cache);
            return true;
        }
        
        const [size, mtime] = result.stdout.trim().split('|');
        
        // Обновляем tree
        cache.tree[relPath] = {
            type: 'file',
            size: parseInt(size) || 0,
            mtime: parseInt(mtime) * 1000 || Date.now(),
            path: filepath
        };
        
        // Строим новый summary
        const summary = await buildFileSummary(chatId, filepath, cache.tree[relPath]);
        if (summary) {
            cache.summaries[relPath] = summary;
        }
        
        // Обновляем статистику
        cache.updatedAt = Date.now();
        cache.stats = cache.stats || {};
        cache.stats.lastUpdate = Date.now();
        cache.stats.updatedFile = relPath;
        
        await writeCache(chatId, cache);
        
        console.log(`[PROJECT-CACHE] Updated file ${relPath} for ${chatId}`);
        return true;
    } catch (e) {
        console.error(`[PROJECT-CACHE] Update error for ${chatId}: ${e.message}`);
        return false;
    }
}

/**
 * Полная инвалидация кэша
 */
async function invalidateCache(chatId) {
    const session = sessionService.getSession(chatId);
    if (!session) return false;
    
    try {
        await dockerService.executeInContainer(
            session.containerId,
            `rm -rf ${getCacheDir()}`
        );
        
        console.log(`[PROJECT-CACHE] Invalidated all for ${chatId}`);
        return true;
    } catch (e) {
        console.error(`[PROJECT-CACHE] Invalidate error: ${e.message}`);
        return false;
    }
}

/**
 * Форматирует кэш для контекста агента
 */
function formatCacheForContext(cache, maxFiles = 100) {
    if (!cache) return '(кэш проекта не найден)';
    
    const parts = [];
    
    // Статистика
    parts.push(`📊 Кэш проекта (обновлён: ${new Date(cache.updatedAt).toLocaleString()})`);
    parts.push(`   Файлов: ${cache.stats?.totalFiles || 0}, директорий: ${cache.stats?.totalDirs || 0}`);
    parts.push('');
    
    // Дерево файлов (2-3 уровня, фильтруем node_modules и .git)
    const filteredEntries = Object.entries(cache.tree || {})
        .filter(([path, stat]) => 
            !path.includes('node_modules') && 
            !path.includes('.git') &&
            !path.includes('__pycache__') &&
            !path.includes('.venv')
        )
        .slice(0, maxFiles);
    
    if (filteredEntries.length > 0) {
        parts.push('📁 Структура проекта:');
        
        // Группируем по уровням
        const levels = { root: [], level1: [], level2: [] };
        
        filteredEntries.forEach(([relPath, stat]) => {
            const depth = (relPath.match(/\//g) || []).length;
            
            if (depth === 0) {
                levels.root.push([relPath, stat]);
            } else if (depth === 1) {
                levels.level1.push([relPath, stat]);
            } else if (depth === 2) {
                levels.level2.push([relPath, stat]);
            }
        });
        
        // Показываем root level
        levels.root.forEach(([relPath, stat]) => {
            const icon = stat.type === 'dir' ? '📂' : '📄';
            parts.push(`  ${icon} ${relPath} ${stat.type === 'file' ? `(${formatSize(stat.size)})` : ''}`);
        });
        
        // Показываем level 1 (содержимое папок)
        if (levels.level1.length > 0) {
            parts.push('');
            levels.level1.slice(0, 30).forEach(([relPath, stat]) => {
                const icon = stat.type === 'dir' ? '📂' : '📄';
                const indent = '    ';
                parts.push(`${indent}${icon} ${relPath} ${stat.type === 'file' ? `(${formatSize(stat.size)})` : ''}`);
            });
        }
        
        // Показываем level 2 (только если немного)
        if (levels.level2.length > 0 && levels.level2.length <= 20) {
            parts.push('');
            levels.level2.slice(0, 20).forEach(([relPath, stat]) => {
                const icon = stat.type === 'dir' ? '📂' : '📄';
                const indent = '      ';
                parts.push(`${indent}${icon} ${relPath} ${stat.type === 'file' ? `(${formatSize(stat.size)})` : ''}`);
            });
        } else if (levels.level2.length > 20) {
            parts.push('');
            parts.push(`      ... и ещё ${levels.level2.length} файлов на глубине 2+`);
        }
        
        parts.push('');
    }
    
    // Summaries для ключевых файлов
    const keyFiles = Object.entries(cache.summaries || {})
        .filter(([path]) => !path.includes('node_modules') && !path.includes('.git'))
        .slice(0, 20);
    
    if (keyFiles.length > 0) {
        parts.push('📝 Ключевые файлы:');
        keyFiles.forEach(([relPath, summary]) => {
            const exports = summary.exports && summary.exports.length > 0
                ? ` → [${summary.exports.join(', ')}]`
                : '';
            parts.push(`  ${relPath}${exports}`);
        });
    }
    
    return parts.join('\n');
}

/**
 * Форматирование размера
 */
function formatSize(bytes) {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

module.exports = {
    getProjectCache,
    buildProjectCache,
    invalidateCache,
    invalidateFile,
    updateFileInCache,
    formatCacheForContext,
    cacheExists,
    readCache,
    writeCache
};
