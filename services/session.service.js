const config = require('../config');
const dockerService = require('./docker.service');
const { databaseExists, createUserDatabase, getDatabaseInfo, deleteUserDatabase } = require('./postgres.service');
const storageService = require('./storage.service');

// Хранилище сессий в памяти
const sessions = new Map();

// Статусы инициализации контейнеров: chatId -> { status, step, stepIndex, total, error }
const initStatuses = new Map();

/**
 * Проверяет наличие python3 в контейнере и создаёт БД пользователя
 */
async function verifyContainerDeps(chatId) {
    const result = await executeCommand(chatId, 'which python3 && python3 --version', 5);
    const session = sessions.get(chatId);
    if (session) {
        if (!result.stdout.includes('python3')) {
            console.warn(`[SESSION] python3 не найден в контейнере ${chatId} — patch_file будет недоступен`);
            session.hasPython3 = false;
        } else {
            session.hasPython3 = true;
        }
    }
    
    // Создаём БД пользователя для контента
    try {
        const dbExists = await databaseExists(chatId);
        if (!dbExists) {
            await createUserDatabase(chatId);
            console.log(`[SESSION] База данных создана для chatId: ${chatId}`);
        }
    } catch (err) {
        console.error(`[SESSION] Ошибка создания БД для ${chatId}:`, err.message);
    }
}

/**
 * Создает новую сессию.
 * Контейнер создаётся синхронно, инициализация (npm install и т.п.) — в фоне.
 * Прогресс доступен через getInitStatus(chatId).
 */
async function createSession(chatId, options = {}) {
    // Выставляем статус "создаём контейнер" до запуска
    initStatuses.set(chatId, { status: 'pending', step: 'Создание контейнера', stepIndex: 0, total: 7, error: null });

    const { containerId, containerName, dataDir, database } =
        await dockerService.createUserContainer(chatId, options);

    const session = {
        chatId,
        sessionId: chatId,
        containerId,
        containerName,
        dataDir,
        database,
        created: Date.now(),
        lastActivity: Date.now(),
        commandCount: 0,
        allowNetwork: options.allowNetwork !== false,
        hasPython3: true
    };

    sessions.set(chatId, session);

    // Запускаем инициализацию в фоне — не блокируем ответ клиенту
    initStatuses.set(chatId, { status: 'initializing', step: 'Запуск инициализации', stepIndex: 0, total: 7, error: null });

    dockerService.initializeWorkspaceStructure(containerId, (stepName, stepIndex, total) => {
        initStatuses.set(chatId, { status: 'initializing', step: stepName, stepIndex, total, error: null });
    }).then(() => {
        initStatuses.set(chatId, { status: 'ready', step: 'Готово', stepIndex: 7, total: 7, error: null });
        // Проверяем зависимости
        verifyContainerDeps(chatId).catch(err =>
            console.error(`[SESSION] Error verifying deps for ${chatId}:`, err.message)
        );
    }).catch(err => {
        console.error(`[SESSION] Init failed for ${chatId}:`, err.message);
        initStatuses.set(chatId, { status: 'error', step: 'Ошибка инициализации', stepIndex: 0, total: 7, error: err.message });
    });

    return session;
}

/**
 * Возвращает текущий статус инициализации контейнера
 */
function getInitStatus(chatId) {
    return initStatuses.get(chatId) || { status: 'unknown', step: '', stepIndex: 0, total: 0, error: null };
}

/**
 * Восстанавливает сессию после перезапуска сервера
 */
async function recoverSession(chatId) {
    const containerName = `sandbox-user-${chatId}`;
    const containerId = await dockerService.getContainerIdByName(containerName);

    if (!containerId) {
        return null;
    }

    console.log(`[SESSION] Recovering session: ${chatId}`);

    // Проверяем и запускаем контейнер если остановлен
    const status = await dockerService.getContainerStatus(containerId);
    if (status !== 'running') {
        console.log(`[SESSION] Starting stopped container: ${containerName} (status: ${status})`);
        try {
            await dockerService.startContainer(containerId);
        } catch (err) {
            console.error(`[SESSION] Failed to start container ${containerName}: ${err.message}`);
            console.log(`[SESSION] Container will be recreated on next getOrCreateSession`);
            return null;
        }
    }

    const dbInfo = await getDatabaseInfo(chatId);
    const dataDir = storageService.getDataDir(chatId);

    const session = {
        chatId,
        sessionId: chatId,
        containerId,
        containerName,
        dataDir,
        database: dbInfo,
        created: Date.now(),
        lastActivity: Date.now(),
        commandCount: 0,
        allowNetwork: true,
        recovered: true
    };

    sessions.set(chatId, session);

    // Восстанавливаем pm2-процессы после рестарта контейнера.
    // pm2 resurrect читает ~/.pm2/dump.pm2 — файл создаётся командой `pm2 save`.
    // Если dump не существует — команда просто ничего не делает (не падает).
    dockerService.executeInContainer(
        containerId,
        'pm2 resurrect 2>/dev/null || true',
        15
    ).then(r => {
        if (r.stdout && r.stdout.includes('Resurrecting')) {
            console.log(`[SESSION] pm2 resurrect OK for ${chatId}`);
        }
    }).catch(() => { /* ignore */ });

    return session;
}

/**
 * Получает или создает сессию
 */
async function getOrCreateSession(chatId, options = {}) {
    let session = sessions.get(chatId);
    
    // Если сессия в памяти - проверяем контейнер
    if (session) {
        const isAlive = await dockerService.isContainerAlive(session.containerId);
        if (isAlive) {
            session.lastActivity = Date.now();
            return session;
        }
        console.log(`[SESSION] Container dead, removing stale session`);
        sessions.delete(chatId);
    }
    
    // Пробуем восстановить существующий контейнер
    session = await recoverSession(chatId);
    if (session) {
        return session;
    }
    
    // Создаем новую сессию
    console.log(`[SESSION] Creating new session: ${chatId}`);
    return await createSession(chatId, options);
}

/**
 * Получает сессию без создания
 */
function getSession(chatId) {
    return sessions.get(chatId);
}

/**
 * Останавливает сессию (контейнер + сохраняет БД)
 * Вызывается при очистке неактивных сессий.
 * Контейнер останавливается, но НЕ удаляется — быстрый рестарт при следующем обращении.
 */
async function stopSession(chatId) {
    const session = sessions.get(chatId);

    if (session) {
        try {
            console.log(`[SESSION] Stopping container: ${session.containerId}`);
            await dockerService.stopContainer(session.containerId);
            sessions.delete(chatId);
            console.log(`[SESSION] Stopped (not destroyed): ${chatId}`);
        } catch (err) {
            console.warn(`[SESSION] Could not stop container for ${chatId}: ${err.message}`);
            // Если контейнер уже не существует — просто удаляем из памяти
            sessions.delete(chatId);
        }
    }
}

/**
 * Удаляет сессию полностью (контейнер + БД)
 * Используйте только для явного удаления аккаунта.
 */
async function destroySession(chatId) {
    const session = sessions.get(chatId);

    if (session) {
        await dockerService.removeContainer(session.containerId);
        await deleteUserDatabase(chatId);
        sessions.delete(chatId);
        console.log(`[SESSION] Destroyed: ${chatId}`);
    }
}

/**
 * Выполняет команду в сессии
 */
async function executeCommand(chatId, command, timeout = 30) {
    const session = await getOrCreateSession(chatId);
    
    const result = await dockerService.executeInContainer(
        session.containerId, 
        command, 
        timeout
    );
    
    session.commandCount++;
    session.lastActivity = Date.now();
    
    return {
        ...result,
        chatId,
        sessionId: session.sessionId,
        commandNumber: session.commandCount
    };
}

/**
 * Возвращает все сессии
 */
function getAllSessions() {
    return Array.from(sessions.values());
}

/**
 * Очищает неактивные сессии — ОСТАНАВЛИВАЕТ контейнеры вместо удаления
 */
async function cleanupIdleSessions() {
    const now = Date.now();
    const toStop = [];

    for (const [chatId, session] of sessions) {
        const idle = now - session.lastActivity;

        if (idle > config.SESSION_MAX_IDLE_MS) {
            toStop.push(chatId);
        }
    }

    for (const chatId of toStop) {
        console.log(`[CLEANUP] Evicted idle session from memory: ${chatId} (container still running)`);
        sessions.delete(chatId);
    }

    return toStop.length;
}

/**
 * Восстанавливает все контейнеры при старте сервера
 */
async function recoverAllSessions() {
    console.log('[SESSION] Scanning for existing containers...');
    
    const { exec } = require('child_process');
    
    return new Promise((resolve) => {
        exec(
            `docker ps -a -f "name=sandbox-user-" --format "{{.Names}}"`,
            async (error, stdout) => {
                if (error) {
                    resolve(0);
                    return;
                }
                
                const names = stdout.trim().split('\n').filter(n => n);
                let recovered = 0;
                
                for (const name of names) {
                    // sandbox-user-{chatId}
                    const chatId = name.replace('sandbox-user-', '');
                    try {
                        await recoverSession(chatId);
                        recovered++;
                    } catch (err) {
                        console.log(`[SESSION] Failed to recover ${chatId}: ${err.message}`);
                    }
                }
                
                console.log(`[SESSION] Recovered ${recovered} sessions`);
                resolve(recovered);
            }
        );
    });
}

/**
 * Удалить сессию из памяти
 */
function removeSession(chatId) {
    sessions.delete(chatId);
    initStatuses.delete(chatId);
}

module.exports = {
    createSession,
    getOrCreateSession,
    getSession,
    destroySession,
    stopSession,
    executeCommand,
    getAllSessions,
    cleanupIdleSessions,
    recoverAllSessions,
    getInitStatus,
    removeSession,
    sessions
};
