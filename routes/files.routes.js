const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const sessionService = require('../services/session.service');
const dockerService = require('../services/docker.service');
const projectCacheService = require('../services/projectCache.service');
const config = require('../config');

// Multer для загрузки файлов
const storage = multer.diskStorage({
    destination: async (req, file, cb) => {
        const uploadDir = '/tmp/uploads';
        await fs.mkdir(uploadDir, { recursive: true });
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueName = `${Date.now()}-${file.originalname}`;
        cb(null, uniqueName);
    }
});

const upload = multer({ 
    storage,
    limits: { fileSize: config.MAX_FILE_SIZE }
});

// Список файлов
router.get('/:chat_id', async (req, res) => {
    const { chat_id } = req.params;
    const { directory = '/workspace' } = req.query;
    
    const session = sessionService.getSession(chat_id);
    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }
    
    try {
        // Сначала получаем корневые папки (глубина 1), потом содержимое каждой папки отдельно
        // Это гарантирует что input/output/work будут в списке первыми
        
        // 1. Корневые папки и файлы (глубина 1)
        const rootResult = await dockerService.executeInContainer(
            session.containerId,
            `find ${directory} -maxdepth 1 \\( -type d -o -type f \\) -exec sh -c 'if [ -d "$1" ]; then echo "d|$1"; else echo "f|$1"; fi' _ {} \\; 2>/dev/null`
        );
        
        // 2. Содержимое рабочих папок (input, output, work, log, tmp, apps, plans)
        const foldersResult = await dockerService.executeInContainer(
            session.containerId,
            `for dir in input output work log tmp apps plans; do find ${directory}/$dir -maxdepth 4 \\( -type d -o -type f \\) -exec sh -c 'if [ -d "$1" ]; then echo "d|$1"; else echo "f|$1"; fi' _ {} \\; 2>/dev/null; done`
        );
        
        // 3. Модули - только первый уровень
        const modulesResult = await dockerService.executeInContainer(
            session.containerId,
            `find ${directory}/modules -maxdepth 2 -type d -exec echo "d|{}" \\; 2>/dev/null`
        );
        
        // Объединяем результаты
        const allLines = [
            rootResult.stdout.trim(),
            foldersResult.stdout.trim(),
            modulesResult.stdout.trim()
        ].filter(s => s).join('\n');
        
        const files = allLines.split('\n').filter(f => f).map(line => {
            const separatorIndex = line.indexOf('|');
            if (separatorIndex === -1) return null;
            const type = line.substring(0, separatorIndex);
            const path = line.substring(separatorIndex + 1);
            return { type, path };
        }).filter(f => f);
        
        res.json({ files });
    } catch (error) {
        console.error('[FILES] Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Скачать файл
router.get('/:chat_id/download', async (req, res) => {
    const { chat_id } = req.params;
    const { filepath } = req.query;
    
    if (!filepath) {
        return res.status(400).json({ error: 'filepath is required' });
    }
    
    const session = sessionService.getSession(chat_id);
    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }
    
    try {
        const tempFile = `/tmp/download-${Date.now()}-${path.basename(filepath)}`;
        await dockerService.copyFromContainer(session.containerId, filepath, tempFile);
        
        const content = await fs.readFile(tempFile);
        await fs.unlink(tempFile).catch(() => {});
        
        res.setHeader('Content-Disposition', `attachment; filename="${path.basename(filepath)}"`);
        res.send(content);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Загрузить файл
router.post('/:chat_id/upload', upload.single('file'), async (req, res) => {
    const { chat_id } = req.params;
    const { destination = '/workspace/input' } = req.body;
    
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
    }
    
    const session = sessionService.getSession(chat_id);
    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }
    
    try {
        // Use POSIX path for container destinations regardless of host OS.
        const remotePath = path.posix.join(destination, req.file.originalname);
        await dockerService.copyToContainer(req.file.path, session.containerId, remotePath);
        await fs.unlink(req.file.path).catch(() => {});
        
        // Обновляем файл в кэше
        await projectCacheService.updateFileInCache(chat_id, remotePath);
        
        res.json({
            success: true,
            filename: req.file.originalname,
            destination: remotePath
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Статистика диска и топ файлов
router.get('/:chat_id/stats', async (req, res) => {
    const { chat_id } = req.params;
    
    const session = sessionService.getSession(chat_id);
    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }
    
    try {
        // Получаем общую статистику диска
        const dfResult = await dockerService.executeInContainer(
            session.containerId,
            `df -h /workspace | tail -1`
        );
        
        // Парсим df вывод: Filesystem Size Used Avail Use% Mounted
        const dfLines = dfResult.stdout.trim().split(/\s+/);
        const diskStats = {
            total: dfLines[1] || 'N/A',
            used: dfLines[2] || 'N/A',
            available: dfLines[3] || 'N/A',
            usedPercent: dfLines[4] || 'N/A'
        };
        
        // Получаем топ 10 файлов по размеру
        const topFilesResult = await dockerService.executeInContainer(
            session.containerId,
            `find /workspace -type f -exec du -h {} + 2>/dev/null | sort -rh | head -10`
        );
        
        const topFiles = topFilesResult.stdout.trim().split('\n')
            .filter(line => line)
            .map(line => {
                const match = line.match(/^(\S+)\s+(.+)$/);
                if (match) {
                    return { size: match[1], path: match[2] };
                }
                return null;
            })
            .filter(f => f);
        
        res.json({ diskStats, topFiles });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Получить содержимое файла
router.get('/:chat_id/content', async (req, res) => {
    const { chat_id } = req.params;
    const { filepath } = req.query;
    
    if (!filepath) {
        return res.status(400).json({ error: 'filepath is required' });
    }
    
    const session = sessionService.getSession(chat_id);
    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }
    
    try {
        const result = await dockerService.executeInContainer(
            session.containerId,
            `cat ${filepath}`
        );
        
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.send(result.stdout);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Проверка безопасности для операций с папками
function validateFolderName(folder) {
    if (!folder) {
        return { valid: false, error: 'folder is required' };
    }
    
    // Проверка безопасности: только имя папки без пути (нет /, .., и т.д.)
    if (folder.includes('/') || folder.includes('\\') || folder.includes('..') || folder !== path.basename(folder)) {
        return { valid: false, error: 'Invalid folder name' };
    }
    
    // Запрещаем операции с системными папками
    const forbiddenFolders = ['bin', 'etc', 'usr', 'var', 'lib', 'root', 'home', 'opt', 'srv', 'proc', 'sys', 'dev'];
    if (forbiddenFolders.includes(folder)) {
        return { valid: false, error: 'Cannot modify system folder' };
    }
    
    return { valid: true };
}

// Очистить папку (удалить содержимое, но оставить папку)
router.delete('/:chat_id/folder', async (req, res) => {
    const { chat_id } = req.params;
    const { folder } = req.body;
    
    const validation = validateFolderName(folder);
    if (!validation.valid) {
        return res.status(400).json({ error: validation.error });
    }
    
    const session = sessionService.getSession(chat_id);
    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }
    
    try {
        const folderPath = `/workspace/${folder}`;
        await dockerService.executeInContainer(
            session.containerId,
            `rm -rf ${folderPath}/* 2>/dev/null; rm -rf ${folderPath}/.* 2>/dev/null; true`
        );
        res.json({ success: true, cleared: folder });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Удалить папку целиком со всем содержимым
router.delete('/:chat_id/folder/remove', async (req, res) => {
    const { chat_id } = req.params;
    const { folder } = req.body;
    
    const validation = validateFolderName(folder);
    if (!validation.valid) {
        return res.status(400).json({ error: validation.error });
    }
    
    const session = sessionService.getSession(chat_id);
    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }
    
    try {
        const folderPath = `/workspace/${folder}`;
        await dockerService.executeInContainer(
            session.containerId,
            `rm -rf ${folderPath}`
        );
        res.json({ success: true, removed: folder });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Удалить файл
router.delete('/:chat_id', async (req, res) => {
    const { chat_id } = req.params;
    const { filepath } = req.body;
    
    if (!filepath) {
        return res.status(400).json({ error: 'filepath is required' });
    }
    
    const session = sessionService.getSession(chat_id);
    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }
    
    try {
        await dockerService.executeInContainer(session.containerId, `rm -rf ${filepath}`);
        
        // Инвалидируем файл в кэше
        await projectCacheService.invalidateFile(chat_id, filepath);
        
        res.json({ success: true, deleted: filepath });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Инвалидировать кэш проекта
router.post('/:chat_id/cache/invalidate', async (req, res) => {
    const { chat_id } = req.params;
    const { filepath, rebuild = false } = req.body;
    
    const session = sessionService.getSession(chat_id);
    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }
    
    try {
        if (filepath) {
            // Инвалидируем конкретный файл
            const success = await projectCacheService.invalidateFile(chat_id, filepath);
            res.json({ success, invalidated: filepath });
        } else if (rebuild) {
            // Полный пересчёт кэша
            const cache = await projectCacheService.buildProjectCache(chat_id, { forceRebuild: true });
            res.json({ 
                success: true, 
                rebuilt: true,
                stats: cache.stats
            });
        } else {
            // Полная инвалидация
            const success = await projectCacheService.invalidateCache(chat_id);
            res.json({ success, invalidated: 'all' });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Получить кэш проекта
router.get('/:chat_id/cache', async (req, res) => {
    const { chat_id } = req.params;
    const { rebuild = false } = req.query;
    
    const session = sessionService.getSession(chat_id);
    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }
    
    try {
        const cache = await projectCacheService.getProjectCache(chat_id, { forceRebuild: rebuild === 'true' });
        res.json({ cache });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
