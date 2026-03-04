/**
 * Сервис анализа зависимостей проекта
 * 
 * Парсит импорты/экспорты для JS/TS/Python файлов и строит двунаправленный граф зависимостей.
 * Граф сохраняется в /workspace/.project/deps.json и обновляется при изменении файлов.
 */

const fs = require('fs').promises;
const path = require('path');
const dockerService = require('./docker.service');

// Кэш графа зависимостей: chatId -> { graph, timestamp }
const depsCache = new Map();

// TTL кэша в миллисекундах (30 минут)
const DEPS_CACHE_TTL_MS = 30 * 60 * 1000;

// Расширения файлов для анализа
const ANALYZABLE_EXTENSIONS = new Set([
    '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
    '.py', '.pyw'
]);

/**
 * Проверяет, нужно ли анализировать файл по расширению
 */
function isAnalyzable(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    return ANALYZABLE_EXTENSIONS.has(ext);
}

/**
 * Извлекает импорты из JS/TS файла (regex-based, без AST)
 * 
 * Поддерживаемые паттерны:
 * - require('...'), require("...")
 * - require(`...`) — только литеральные строки
 * - import ... from '...'
 * - import '...'
 * - export ... from '...'
 * - export * from '...'
 */
function extractJsImports(content) {
    const imports = new Set();
    
    // require('...'), require("...")
    const requireRegex = /require\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g;
    let match;
    while ((match = requireRegex.exec(content)) !== null) {
        imports.add(match[1]);
    }
    
    // import ... from '...'
    // import '...'
    // export ... from '...'
    // export * from '...'
    const es6Regex = /(?:import|export)\s+(?:[\w*{},\s]+\s+from\s+)?['"`]([^'"`]+)['"`]/g;
    while ((match = es6Regex.exec(content)) !== null) {
        imports.add(match[1]);
    }
    
    // dynamic import: import('...') — только литеральные строки
    const dynamicImportRegex = /import\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g;
    while ((match = dynamicImportRegex.exec(content)) !== null) {
        imports.add(match[1]);
    }
    
    return Array.from(imports);
}

/**
 * Извлекает импорты из Python файла
 * 
 * Поддерживаемые паттерны:
 * - import module
 * - import module as alias
 * - from module import name
 * - from module import name as alias
 */
function extractPythonImports(content) {
    const imports = new Set();
    
    // import module
    // import module as alias
    // import module1, module2
    const importRegex = /^import\s+([^\s#]+)(?:\s+as\s+\w+)?/gm;
    let match;
    while ((match = importRegex.exec(content)) !== null) {
        // Берём только первый модуль (до запятой)
        const module = match[1].split(',')[0].trim();
        imports.add(module);
    }
    
    // import module1, module2, ...
    const multiImportRegex = /^import\s+([^\n#]+)/gm;
    while ((match = multiImportRegex.exec(content)) !== null) {
        const modules = match[1].split(',').map(m => m.trim().split(/\s+as\s+/)[0].trim());
        modules.forEach(m => {
            if (m && !m.startsWith('#')) {
                imports.add(m);
            }
        });
    }
    
    // from module import name
    // from module import name as alias
    // from .module import name (relative)
    const fromImportRegex = /^from\s+([^\s#]+)\s+import\s+/gm;
    while ((match = fromImportRegex.exec(content)) !== null) {
        imports.add(match[1]);
    }
    
    return Array.from(imports);
}

/**
 * Извлекает импорты из файла по расширению
 */
function extractImports(filePath, content) {
    const ext = path.extname(filePath).toLowerCase();
    
    if (['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'].includes(ext)) {
        return extractJsImports(content);
    }
    
    if (['.py', '.pyw'].includes(ext)) {
        return extractPythonImports(content);
    }
    
    return [];
}

/**
 * Разрешает относительный путь импорта в абсолютный
 * 
 * @param {string} fromFile - файл, из которого делается импорт
 * @param {string} importPath - путь импорта (относительный или абсолютный)
 * @param {string} projectRoot - корень проекта (/workspace)
 * @returns {string|null} - абсолютный путь или null если не удалось разрешить
 */
function resolveImportPath(fromFile, importPath, projectRoot = '/workspace') {
    // Пропускаем node_modules и встроенные модули
    if (!importPath.startsWith('.') && !importPath.startsWith('/')) {
        // Это внешний модуль (npm пакет или встроенный)
        // Пытаемся найти в node_modules
        const nodeModulesPath = path.join(projectRoot, 'node_modules', importPath);
        // Возвращаем как есть — не анализируем внешние зависимости
        return null;
    }
    
    // Абсолютный путь (редко, но бывает)
    if (importPath.startsWith('/')) {
        return importPath;
    }
    
    // Относительный путь
    const fromDir = path.dirname(fromFile);
    const resolved = path.resolve(fromDir, importPath);
    
    // Добавляем расширения если не указаны
    const extensions = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.json', '.py'];
    
    // Проверяем как есть (если расширение уже указано)
    if (path.extname(resolved)) {
        return resolved;
    }
    
    // Возвращаем первый вариант с расширением
    // (проверка существования делается позже при построении графа)
    // Важно: возвращаем .ts/.tsx для TypeScript файлов, .py для Python
    const ext = path.extname(fromFile).toLowerCase();
    
    // Если исходный файл — TypeScript, приоритет .ts/.tsx
    if (ext === '.ts' || ext === '.tsx') {
        return resolved + '.ts';
    }
    
    // Если исходный файл — Python, приоритет .py
    if (ext === '.py' || ext === '.pyw') {
        return resolved + '.py';
    }
    
    // Для JS файлов — стандартный приоритет
    return resolved + '.js';
}

/**
 * Анализирует один файл и извлекает его зависимости
 * 
 * @param {string} filePath - абсолютный путь к файлу
 * @param {string} content - содержимое файла (опционально, для оптимизации)
 * @param {string} projectRoot - корень проекта
 * @returns {Object} - { imports: string[], exports: string[] }
 */
function analyzeFile(filePath, content = null, projectRoot = '/workspace') {
    if (!isAnalyzable(filePath)) {
        return { imports: [], exports: [], resolvedImports: [] };
    }
    
    // Если контент не передан, читаем файл (но в контексте контейнера это делается через sessionService)
    // Здесь предполагаем, что контент уже передан
    if (!content) {
        return { imports: [], exports: [], resolvedImports: [] };
    }
    
    const imports = extractImports(filePath, content);
    
    // Разрешаем импорты в абсолютные пути
    const resolvedImports = imports
        .map(imp => resolveImportPath(filePath, imp, projectRoot))
        .filter(p => p !== null);
    
    return {
        imports,
        resolvedImports,
        exports: [] // TODO: можно добавить анализ экспортов
    };
}

/**
 * Строит граф зависимостей для проекта
 * 
 * @param {Object} sessionService - сервис сессий для выполнения команд
 * @param {string} chatId - ID чата
 * @param {string} projectRoot - корень проекта (по умолчанию /workspace)
 * @returns {Object} - граф зависимостей
 */
async function buildDepsGraph(sessionService, chatId, projectRoot = '/workspace') {
    console.log(`[DEPS] Building dependency graph for ${chatId}...`);
    
    // 1. Получаем список всех файлов проекта
    const findCmd = `find "${projectRoot}" -type f \\( -name "*.js" -o -name "*.jsx" -o -name "*.ts" -o -name "*.tsx" -o -name "*.py" \\) -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/__pycache__/*" -not -path "*/.venv/*" 2>/dev/null | head -500`;
    
    const findResult = await sessionService.executeCommand(chatId, findCmd, 30);
    
    if (findResult.exitCode !== 0 || !findResult.stdout) {
        console.warn(`[DEPS] Failed to list files: ${findResult.stderr}`);
        return { files: {}, reverse: {}, timestamp: Date.now() };
    }
    
    const files = findResult.stdout.trim().split('\n').filter(f => f);
    console.log(`[DEPS] Found ${files.length} files to analyze`);
    
    // 2. Читаем и анализируем каждый файл
    const graph = {
        files: {},      // filePath -> { imports, resolvedImports }
        reverse: {},    // filePath -> [кто импортирует этот файл]
        timestamp: Date.now()
    };
    
    // Инициализируем reverse для всех файлов
    files.forEach(f => {
        graph.reverse[f] = [];
    });
    
    // Читаем файлы батчами по 20 штук
    const batchSize = 20;
    for (let i = 0; i < files.length; i += batchSize) {
        const batch = files.slice(i, i + batchSize);
        
        // Читаем все файлы батча одной командой
        const readPromises = batch.map(async (filePath) => {
            const catResult = await sessionService.executeCommand(
                chatId, 
                `cat "${filePath}" 2>/dev/null || echo ""`, 
                10
            );
            return { filePath, content: catResult.stdout || '' };
        });
        
        const batchResults = await Promise.all(readPromises);
        
        // Анализируем каждый файл
        for (const { filePath, content } of batchResults) {
            if (!content) continue;
            
            const analysis = analyzeFile(filePath, content, projectRoot);
            graph.files[filePath] = analysis;
            
            // Обновляем reverse-граф
            for (const resolvedImport of analysis.resolvedImports) {
                if (!graph.reverse[resolvedImport]) {
                    graph.reverse[resolvedImport] = [];
                }
                if (!graph.reverse[resolvedImport].includes(filePath)) {
                    graph.reverse[resolvedImport].push(filePath);
                }
            }
        }
    }
    
    console.log(`[DEPS] Graph built: ${Object.keys(graph.files).length} files analyzed`);
    
    // 3. Сохраняем граф в файл через temp-файл + copyToContainer (надёжно)
    const depsPath = path.join(projectRoot, '.project', 'deps.json');
    const depsDir = path.dirname(depsPath);
    
    try {
        // Получаем сессию для доступа к containerId
        const session = sessionService.getSession(chatId);
        if (!session) {
            console.warn(`[DEPS] No session for ${chatId}, skip saving graph`);
            return graph;
        }
        
        // Создаём директорию в контейнере
        await sessionService.executeCommand(chatId, `mkdir -p "${depsDir}"`, 10);
        
        // Записываем во временный файл на хосте
        const tempFile = `/tmp/deps-${chatId}-${Date.now()}.json`;
        await fs.writeFile(tempFile, JSON.stringify(graph, null, 2), 'utf-8');
        
        // Копируем в контейнер
        await dockerService.copyToContainer(tempFile, session.containerId, depsPath);
        
        // Удаляем временный файл
        await fs.unlink(tempFile).catch(() => {});
        
        console.log(`[DEPS] Graph saved to ${depsPath}`);
    } catch (e) {
        console.error(`[DEPS] Failed to save graph: ${e.message}`);
    }
    
    // Кэшируем
    depsCache.set(chatId, { graph, timestamp: Date.now() });
    
    return graph;
}

/**
 * Получает смежные файлы для списка изменяемых файлов
 * 
 * @param {Object} graph - граф зависимостей
 * @param {string[]} affectedFiles - список изменяемых файлов
 * @returns {Object} - { adjacent: string[], details: Object }
 */
function getAdjacentFiles(graph, affectedFiles) {
    const adjacent = new Set();
    const details = {};
    
    for (const file of affectedFiles) {
        // Нормализуем путь
        const normalizedFile = file.startsWith('/workspace') ? file : `/workspace/${file}`;
        
        // Кто импортирует этот файл? (reverse dependencies)
        const importers = graph.reverse[normalizedFile] || [];
        importers.forEach(imp => {
            if (!affectedFiles.includes(imp) && !affectedFiles.includes(imp.replace('/workspace/', ''))) {
                adjacent.add(imp);
            }
        });
        
        details[normalizedFile] = {
            importedBy: importers
        };
    }
    
    return {
        adjacent: Array.from(adjacent),
        details
    };
}

/**
 * Обновляет граф зависимостей для конкретного файла
 * (вызывается после write_file / patch_file)
 * 
 * @param {Object} sessionService - сервис сессий
 * @param {string} chatId - ID чата
 * @param {string} filePath - путь к изменённому файлу
 * @param {string} content - новое содержимое файла
 * @param {string} projectRoot - корень проекта
 */
async function updateFileDeps(sessionService, chatId, filePath, content, projectRoot = '/workspace') {
    // Получаем текущий граф из кэша или загружаем
    let cached = depsCache.get(chatId);
    
    if (!cached || Date.now() - cached.timestamp > DEPS_CACHE_TTL_MS) {
        // Кэш устарел или отсутствует — перестраиваем полностью
        return await buildDepsGraph(sessionService, chatId, projectRoot);
    }
    
    const graph = cached.graph;
    
    // Удаляем старые reverse-связи для этого файла
    const oldAnalysis = graph.files[filePath];
    if (oldAnalysis && oldAnalysis.resolvedImports) {
        for (const oldImport of oldAnalysis.resolvedImports) {
            if (graph.reverse[oldImport]) {
                graph.reverse[oldImport] = graph.reverse[oldImport].filter(f => f !== filePath);
            }
        }
    }
    
    // Анализируем файл заново
    const newAnalysis = analyzeFile(filePath, content, projectRoot);
    graph.files[filePath] = newAnalysis;
    
    // Добавляем новые reverse-связи
    for (const newImport of newAnalysis.resolvedImports) {
        if (!graph.reverse[newImport]) {
            graph.reverse[newImport] = [];
        }
        if (!graph.reverse[newImport].includes(filePath)) {
            graph.reverse[newImport].push(filePath);
        }
    }
    
    // Обновляем timestamp
    cached.timestamp = Date.now();
    
    // Сохраняем обновлённый граф через temp-файл + copyToContainer
    const depsPath = path.join(projectRoot, '.project', 'deps.json');
    
    try {
        // Получаем сессию для доступа к containerId
        const session = sessionService.getSession(chatId);
        if (!session) {
            console.warn(`[DEPS] No session for ${chatId}, skip saving updated graph`);
            return graph;
        }
        
        // Создаём директорию в контейнере
        await sessionService.executeCommand(chatId, `mkdir -p "${path.dirname(depsPath)}"`, 10);
        
        // Записываем во временный файл на хосте
        const tempFile = `/tmp/deps-${chatId}-${Date.now()}.json`;
        await fs.writeFile(tempFile, JSON.stringify(graph, null, 2), 'utf-8');
        
        // Копируем в контейнер
        await dockerService.copyToContainer(tempFile, session.containerId, depsPath);
        
        // Удаляем временный файл
        await fs.unlink(tempFile).catch(() => {});
    } catch (e) {
        console.error(`[DEPS] Failed to save updated graph: ${e.message}`);
    }
    
    return graph;
}

/**
 * Загружает граф зависимостей из файла
 */
async function loadDepsGraph(sessionService, chatId, projectRoot = '/workspace') {
    // Проверяем кэш
    const cached = depsCache.get(chatId);
    if (cached && Date.now() - cached.timestamp < DEPS_CACHE_TTL_MS) {
        return cached.graph;
    }
    
    // Загружаем из файла
    const depsPath = path.join(projectRoot, '.project', 'deps.json');
    const loadResult = await sessionService.executeCommand(
        chatId,
        `cat "${depsPath}" 2>/dev/null || echo "{}"`,
        10
    );
    
    try {
        const graph = JSON.parse(loadResult.stdout);
        depsCache.set(chatId, { graph, timestamp: Date.now() });
        return graph;
    } catch (e) {
        console.warn(`[DEPS] Failed to load graph: ${e.message}`);
        return null;
    }
}

/**
 * Форматирует граф зависимостей для отображения агенту
 */
function formatDepsForAgent(graph, maxFiles = 50) {
    if (!graph || !graph.files) {
        return 'Граф зависимостей пуст. Запустите analyze_deps() для построения.';
    }
    
    const fileCount = Object.keys(graph.files).length;
    let result = `📊 Граф зависимостей: ${fileCount} файлов проанализировано\n\n`;
    
    // Показываем файлы с наибольшим количеством зависимостей
    const sortedByDeps = Object.entries(graph.files)
        .map(([file, data]) => ({
            file: file.replace('/workspace/', ''),
            imports: data.imports?.length || 0,
            resolved: data.resolvedImports?.length || 0
        }))
        .sort((a, b) => b.imports - a.imports)
        .slice(0, maxFiles);
    
    result += 'Файлы с наибольшим количеством импортов:\n';
    sortedByDeps.forEach((item, idx) => {
        result += `  ${idx + 1}. ${item.file} (${item.imports} imports)\n`;
    });
    
    // Показываем файлы, которые импортируются чаще всего
    const sortedByReverse = Object.entries(graph.reverse)
        .map(([file, importers]) => ({
            file: file.replace('/workspace/', ''),
            importedBy: importers.length
        }))
        .filter(item => item.importedBy > 0)
        .sort((a, b) => b.importedBy - a.importedBy)
        .slice(0, 20);
    
    if (sortedByReverse.length > 0) {
        result += '\nФайлы, которые импортируются чаще всего:\n';
        sortedByReverse.forEach((item, idx) => {
            result += `  ${idx + 1}. ${item.file} (импортируется ${item.importedBy} раз)\n`;
        });
    }
    
    return result;
}

module.exports = {
    isAnalyzable,
    extractJsImports,
    extractPythonImports,
    analyzeFile,
    buildDepsGraph,
    getAdjacentFiles,
    updateFileDeps,
    loadDepsGraph,
    formatDepsForAgent
};
