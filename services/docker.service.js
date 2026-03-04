const path = require('path');
const { exec } = require('child_process');
const config = require('../config');
const postgresService = require('./postgres.service');
const storageService = require('./storage.service');

/**
 * Выполняет shell команду
 */
function execCommand(command, options = {}) {
    return new Promise((resolve, reject) => {
        exec(command, options, (error, stdout, stderr) => {
            if (error) {
                reject({ error, stdout, stderr });
            } else {
                resolve({ stdout, stderr });
            }
        });
    });
}

/**
 * Проверяет, жив ли контейнер
 */
async function isContainerAlive(containerId) {
    try {
        const { stdout } = await execCommand(
            `docker inspect -f '{{.State.Running}}' ${containerId}`
        );
        return stdout.trim() === 'true';
    } catch {
        return false;
    }
}

/**
 * Получает ID контейнера по имени
 */
async function getContainerIdByName(containerName) {
    try {
        const { stdout } = await execCommand(
            `docker ps -a -q -f "name=${containerName}"`
        );
        return stdout.trim() || null;
    } catch {
        return null;
    }
}

/**
 * Получает статус контейнера
 */
async function getContainerStatus(containerId) {
    try {
        const { stdout } = await execCommand(
            `docker inspect -f '{{.State.Status}}' ${containerId}`
        );
        return stdout.trim();
    } catch {
        return 'unknown';
    }
}

/**
 * Ожидает, пока контейнер перейдёт в состояние running.
 * Делает polling каждые 200ms, максимум timeoutMs (по умолчанию 15 сек).
 * Выбрасывает ошибку, если контейнер не поднялся за отведённое время.
 */
async function waitForContainer(containerId, timeoutMs = 15000) {
    const interval = 200;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        const alive = await isContainerAlive(containerId);
        if (alive) {
            console.log(`[DOCKER] Container ${containerId} is running`);
            return;
        }
        await new Promise(r => setTimeout(r, interval));
    }

    throw new Error(`Container ${containerId} did not start within ${timeoutMs}ms`);
}

/**
 * Запускает остановленный контейнер и ждёт его готовности
 */
async function startContainer(containerId) {
    await execCommand(`docker start ${containerId}`);
    // Ждём, пока контейнер реально перейдёт в running, прежде чем слать exec
    await waitForContainer(containerId, 15000);
    // Убеждаемся, что структура папок существует (для старых контейнеров)
    await initializeWorkspaceStructure(containerId);
}

/**
 * Создает Docker контейнер для пользователя
 */
async function createUserContainer(chatId, options = {}) {
    const containerName = `sandbox-user-${chatId}`;
    const allowNetwork = options.allowNetwork !== false;
    const networkConfig = allowNetwork ? '--network bridge' : '--network none';

    // Создаем БД
    let dbInfo;
    try {
        await postgresService.createUserDatabase(chatId);
        dbInfo = await postgresService.getDatabaseInfo(chatId);
    } catch (error) {
        console.log(`[DOCKER] DB creation failed: ${error.message}`);
        dbInfo = null;
    }

    // Создаем папку для данных (абсолютный путь для надёжного bind mount)
    const dataDir = path.resolve(await storageService.ensureUserDir(chatId));

    // Проверяем и удаляем существующий контейнер
    const existingContainerId = await getContainerIdByName(containerName);
    if (existingContainerId) {
        console.log(`[DOCKER] Removing existing container: ${containerName}`);
        await removeContainer(existingContainerId);
    }

    // Функция для безопасного экранирования значений env переменных для shell
    const escapeEnvValue = (value) => {
        if (!value) return '';
        const str = String(value);
        return str
            .replace(/\\/g, '\\\\')
            .replace(/"/g, '\\"')
            .replace(/\$/g, '\\$')
            .replace(/`/g, '\\`')
            .replace(/\n/g, '\\n')
            .replace(/\r/g, '\\r');
    };

    // Собираем переменные окружения для PostgreSQL
    const envVars = [];
    if (dbInfo) {
        envVars.push(`--env PGHOST="${escapeEnvValue(dbInfo.host)}"`);
        envVars.push(`--env PGPORT="${escapeEnvValue(dbInfo.port)}"`);
        envVars.push(`--env PGDATABASE="${escapeEnvValue(dbInfo.database)}"`);
        envVars.push(`--env PGUSER="${escapeEnvValue(dbInfo.user)}"`);
        envVars.push(`--env PGPASSWORD="${escapeEnvValue(dbInfo.password)}"`);
        envVars.push(`--env DATABASE_URL="${escapeEnvValue(dbInfo.connectionString)}"`);
    }

    // Контейнер запускается от root — это даёт npm install -g, pm2, chmod без ограничений.
    // Изоляция обеспечивается на уровне Docker (memory, cpus, pids-limit, network).
    const dockerCommandParts = [
        'docker run -d',
        `--name ${containerName}`,
        `--memory="${config.CONTAINER_MEMORY}"`,
        `--cpus="${config.CONTAINER_CPUS}"`,
        '--pids-limit=200',
        '--user root',
        '--tmpfs /tmp:rw,exec,nosuid,size=512m',
        `-v "${dataDir}":/workspace`,
        networkConfig,
        `--label chat_id=${chatId}`,
        ...envVars,
        'mcr.microsoft.com/devcontainers/javascript-node:20-bookworm',
        'bash -c "sleep infinity"'
    ];

    const dockerCommand = dockerCommandParts.join(' ');

    const { stdout } = await execCommand(dockerCommand);
    const containerId = stdout.trim();

    // Ждём, пока контейнер реально перейдёт в running, прежде чем возвращать управление
    await waitForContainer(containerId, 15000);

    console.log(`[DOCKER] Created container: ${containerName}`);
    if (dbInfo) {
        console.log(`[DOCKER] PostgreSQL env vars set: PGHOST=${dbInfo.host}, PGDATABASE=${dbInfo.database}`);
    } else {
        console.log(`[DOCKER] Warning: No database info, PostgreSQL env vars not set`);
    }

    return {
        containerId,
        containerName,
        dataDir,
        database: dbInfo
    };
}

/**
 * Выполняет команду в контейнере
 */
async function executeInContainer(containerId, command, timeout = 30) {
    // Проверка опасных команд
    const dangerousPatterns = [
        /rm\s+-rf\s+\/(?!tmp|workspace)/,
        /:\(\)\{\s*:\|:&\s*\};:/,
        />\s*\/dev\/sd[a-z]/,
        /dd\s+if=.*of=\/dev/,
        /mkfs/,
        /chmod\s+000\s+\//,
    ];

    for (const pattern of dangerousPatterns) {
        if (pattern.test(command)) {
            return {
                success: false,
                stdout: '',
                stderr: '⛔ Команда заблокирована (опасный патт��рн)',
                exitCode: 126,
                executionTime: 0
            };
        }
    }

    const escapedCommand = command
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/`/g, '\\`')
        .replace(/\$/g, '\\$');

    const dockerExec = `docker exec ${containerId} bash -c "${escapedCommand}"`;

    const startTime = Date.now();

    return new Promise((resolve) => {
        exec(dockerExec, {
            timeout: timeout * 1000,
            maxBuffer: 10 * 1024 * 1024
        }, (error, stdout, stderr) => {
            resolve({
                success: !error,
                stdout: stdout || '',
                stderr: stderr || error?.message || '',
                exitCode: error?.code || 0,
                executionTime: Math.round((Date.now() - startTime) / 10) / 100
            });
        });
    });
}

/**
 * Выполняет команду в контейнере от имени root (через docker exec -u root).
 * Используется для операций, требующих привилегий (chown и т.п.).
 */
async function execAsRoot(containerId, command, timeout = 60) {
    const escapedCommand = command
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/`/g, '\\`')
        .replace(/\$/g, '\\$');

    const dockerExec = `docker exec -u root ${containerId} bash -c "${escapedCommand}"`;

    return new Promise((resolve) => {
        exec(dockerExec, {
            timeout: timeout * 1000,
            maxBuffer: 10 * 1024 * 1024
        }, (error, stdout, stderr) => {
            resolve({
                success: !error,
                stdout: stdout || '',
                stderr: stderr || error?.message || '',
                exitCode: error?.code || 0
            });
        });
    });
}

/**
 * Удаляет контейнер
 */
async function removeContainer(containerId) {
    try {
        await execCommand(`docker rm -f ${containerId}`);
        console.log(`[DOCKER] Removed container: ${containerId}`);
    } catch (error) {
        console.log(`[DOCKER] Remove failed: ${error.message}`);
    }
}

/**
 * Копирует файл из контейнера
 */
async function copyFromContainer(containerId, containerPath, localPath) {
    await execCommand(`docker cp ${containerId}:${containerPath} ${localPath}`);
}

/**
 * Копирует файл в контейнер
 */
async function copyToContainer(localPath, containerId, containerPath) {
    await execCommand(`docker cp ${localPath} ${containerId}:${containerPath}`);
}

/**
 * Инициализирует структуру папок и глобальные пакеты в контейнере.
 *
 * @param {string} containerId
 * @param {function} [onStep] - callback(stepName: string, stepIndex: number, total: number)
 *
 * Контейнер запускается от root, поэтому:
 *   - npm install -g выполняется через execAsRoot (docker exec -u root) — гарантированно
 *     имеет доступ к /usr/local/share/npm-global/lib/node_modules/
 *   - mkdir для рабочих папок тоже от root — нет проблем с правами на bind mount
 *   - chown больше не нужен
 */
async function initializeWorkspaceStructure(containerId, onStep) {
    console.log(`[INIT] Начало инициализации контейнера ${containerId}...`);

    const report = (name, idx, total) => {
        if (typeof onStep === 'function') onStep(name, idx, total);
    };

    // npm install -g пишет в /usr/local/share/npm-global — принадлежит root.
    // Запускаем все установки через execAsRoot чтобы гарантировать права.
    const NPM_FLAGS = '--loglevel=error --no-fund --no-audit --cache /tmp/npm-cache';

    const steps = [
        {
            name: 'Создание рабочих папок и симлинков',
            // chmod 777 чтобы любой процесс (node-приложения) мог писать в /workspace/apps
            // Создаём симлинки ~/input -> /workspace/input для удобства работы в консоли
            cmds: [
                'mkdir -p /workspace/input /workspace/output /workspace/work /workspace/log /workspace/apps /workspace/tmp && chmod 777 /workspace/apps /workspace/tmp',
                'cd /root && rm -f input output work log apps tmp 2>/dev/null; ln -s /workspace/input input; ln -s /workspace/output output; ln -s /workspace/work work; ln -s /workspace/log log; ln -s /workspace/apps apps; ln -s /workspace/tmp tmp'
            ]
        },
        {
            name: 'Установка yarn и pnpm',
            cmds: [`npm install -g yarn pnpm ${NPM_FLAGS}`, 'yarn --version && pnpm --version']
        },
        {
            name: 'Установка nodemon и pm2',
            cmds: [`npm install -g nodemon pm2 ${NPM_FLAGS}`, 'nodemon --version && pm2 --version']
        },
        {
            name: 'Установка TypeScript, ESLint, Prettier',
            cmds: [
                `npm install -g typescript ts-node eslint prettier ${NPM_FLAGS}`,
                'tsc --version && ts-node --version && eslint --version && prettier --version'
            ]
        },
        {
            name: 'Установка Vite',
            cmds: [`npm install -g vite ${NPM_FLAGS}`, 'vite --version']
        },
    ];

    for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        report(step.name, i + 1, steps.length + 1);
        for (const cmd of step.cmds) {
            try {
                console.log(`[INIT] Выполняю: ${cmd}`);
                // execAsRoot — docker exec -u root, гарантирует права на глобальные пакеты
                const result = await execAsRoot(containerId, cmd, 240);
                if (result.stdout) {
                    console.log(`[INIT] Результат: ${result.stdout.trim()}`);
                }
                if (result.stderr && !result.success) {
                    console.warn(`[INIT] Ошибка: ${result.stderr.trim()}`);
                }
            } catch (err) {
                console.warn(`[INIT] Команда не выполнена: ${cmd}`, err.message || err);
            }
        }
    }

    report('Готово', steps.length + 1, steps.length + 1);
    console.log(`[INIT] Инициализация завершена!`);
}

/**
 * Сбрасывает окружение в контейнере
 */
async function resetContainerWorkspace(containerId) {
    await executeInContainer(containerId, 'rm -rf /workspace/*');
    // Восстанавливаем структуру папок после очистки
    await initializeWorkspaceStructure(containerId);
}

/**
 * Возвращает IP-адрес контейнера в docker bridge-сети.
 * Используется для HTTP-проксирования запросов к pm2-приложениям.
 */
async function getContainerIP(containerId) {
    try {
        const { stdout } = await execCommand(
            `docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' ${containerId}`
        );
        return stdout.trim() || null;
    } catch {
        return null;
    }
}

module.exports = {
    isContainerAlive,
    getContainerIdByName,
    getContainerStatus,
    waitForContainer,
    startContainer,
    createUserContainer,
    executeInContainer,
    removeContainer,
    copyFromContainer,
    copyToContainer,
    execAsRoot,
    resetContainerWorkspace,
    initializeWorkspaceStructure,
    getContainerIP
};
