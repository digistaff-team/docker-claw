const path = require('path');
const { execFile } = require('child_process');
const config = require('../config');
const postgresService = require('./postgres.service');
const storageService = require('./storage.service');

function execFileCommand(file, args = [], options = {}) {
    return new Promise((resolve, reject) => {
        execFile(file, args, options, (error, stdout, stderr) => {
            if (error) {
                reject({ error, stdout, stderr });
            } else {
                resolve({ stdout, stderr });
            }
        });
    });
}

async function findDockerViaShell() {
    try {
        const { stdout } = await execFileCommand('bash', ['-lc', 'command -v docker || true']);
        const bin = String(stdout || '').trim().split(/\r?\n/).pop();
        return bin || null;
    } catch {
        return null;
    }
}

function wslPathToWindows(p) {
    const m = String(p || '').match(/^\/mnt\/([a-zA-Z])\/(.*)$/);
    if (!m) return p;
    const drive = `${m[1].toUpperCase()}:\\`;
    const rest = m[2].replace(/\//g, '\\');
    return drive + rest;
}

function normalizeDockerBindPath(inputPath) {
    if (!inputPath) return inputPath;
    // Convert Windows-translated WSL path (C:\mnt\c\...) to Linux-style (/mnt/c/...)
    const m = String(inputPath).match(/^[A-Za-z]:\\mnt\\([A-Za-z])(\\.*)?$/);
    if (!m) return inputPath;

    const drive = m[1].toLowerCase();
    const tail = (m[2] || '').replace(/\\/g, '/');
    return `/mnt/${drive}${tail}`;
}

function shEscape(arg) {
    return `'${String(arg).replace(/'/g, `'\"'\"'`)}'`;
}

function toDockerCpLocalPath(localPath) {
    const abs = path.resolve(String(localPath || ''));
    const m = abs.match(/^([A-Za-z]):\\(.*)$/);
    if (m) {
        const drive = m[1].toLowerCase();
        const rest = m[2].replace(/\\/g, '/');
        return `/mnt/${drive}/${rest}`;
    }
    return abs.replace(/\\/g, '/');
}

async function execDocker(args = [], options = {}) {
    const cmd = ['docker', ...args].map(shEscape).join(' ');
    return execFileCommand('bash', ['-lc', cmd], options);
}

/**
 * Проверяет, жив ли контейнер
 */
async function isContainerAlive(containerId) {
    try {
        const { stdout } = await execDocker(['inspect', '-f', '{{.State.Running}}', containerId]);
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
        const { stdout } = await execDocker(['ps', '-a', '-q', '-f', `name=${containerName}`]);
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
        const { stdout } = await execDocker(['inspect', '-f', '{{.State.Status}}', containerId]);
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
    await execDocker(['start', containerId]);
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
    const networkMode = allowNetwork ? 'bridge' : 'none';

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
    const dockerDataDir = normalizeDockerBindPath(dataDir);

    // Проверяем и удаляем существующий контейнер
    const existingContainerId = await getContainerIdByName(containerName);
    if (existingContainerId) {
        console.log(`[DOCKER] Removing existing container: ${containerName}`);
        await removeContainer(existingContainerId);
    }

    const envVars = [];
    if (dbInfo) {
        // Keep credentials in PGUSER/PGPASSWORD env vars to avoid URL userinfo parsing edge-cases.
        const databaseUrl = `postgresql://${dbInfo.host}:${dbInfo.port}/${dbInfo.database}`;
        envVars.push('PGHOST', String(dbInfo.host));
        envVars.push('PGPORT', String(dbInfo.port));
        envVars.push('PGDATABASE', String(dbInfo.database));
        envVars.push('PGUSER', String(dbInfo.user));
        envVars.push('PGPASSWORD', String(dbInfo.password));
        envVars.push('DATABASE_URL', databaseUrl);
    }

    const runArgs = [
        'run',
        '-d',
        '--name', containerName,
        '--memory', String(config.CONTAINER_MEMORY),
        '--cpus', String(config.CONTAINER_CPUS),
        '--pids-limit', '200',
        '--user', 'root',
        '--tmpfs', '/tmp:rw,exec,nosuid,size=512m',
        '-v', `${dockerDataDir}:/workspace`,
        '--network', networkMode,
        '--label', `chat_id=${chatId}`
    ];

    for (let i = 0; i < envVars.length; i += 2) {
        runArgs.push('--env', `${envVars[i]}=${envVars[i + 1]}`);
    }

    runArgs.push(
        'mcr.microsoft.com/devcontainers/javascript-node:20-bookworm',
        'bash',
        '-c',
        'sleep infinity'
    );

    const printable = runArgs.map((a) => (/[\s"]/).test(a) ? `"${a.replace(/"/g, '\\"')}"` : a).join(' ');
    console.log(`[DOCKER] Executing: docker ${printable}`);
    let stdout;
    try {
        const res = await execDocker(runArgs);
        stdout = res.stdout;
    } catch (e) {
        const msg = e?.error?.message || e?.message || 'docker run failed';
        console.error(`[DOCKER] docker run failed: ${msg}`);
        if (e?.stderr) {
            console.error(`[DOCKER] stderr: ${String(e.stderr).trim()}`);
        }
        if (e?.stdout) {
            console.error(`[DOCKER] stdout: ${String(e.stdout).trim()}`);
        }
        throw new Error(e?.stderr?.trim() || msg);
    }
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

    const startTime = Date.now();
    try {
        const { stdout, stderr } = await execDocker(
            ['exec', containerId, 'bash', '-c', command],
            { timeout: timeout * 1000, maxBuffer: 10 * 1024 * 1024 }
        );
        return {
            success: true,
            stdout: stdout || '',
            stderr: stderr || '',
            exitCode: 0,
            executionTime: Math.round((Date.now() - startTime) / 10) / 100
        };
    } catch (e) {
        return {
            success: false,
            stdout: e?.stdout || '',
            stderr: e?.stderr || e?.error?.message || '',
            exitCode: e?.error?.code || 1,
            executionTime: Math.round((Date.now() - startTime) / 10) / 100
        };
    }
}

/**
 * Выполняет команду в контейнере от имени root (через docker exec -u root).
 * Используется для операций, требующих привилегий (chown и т.п.).
 */
async function execAsRoot(containerId, command, timeout = 60) {
    try {
        const { stdout, stderr } = await execDocker(
            ['exec', '-u', 'root', containerId, 'bash', '-c', command],
            { timeout: timeout * 1000, maxBuffer: 10 * 1024 * 1024 }
        );
        return {
            success: true,
            stdout: stdout || '',
            stderr: stderr || '',
            exitCode: 0
        };
    } catch (e) {
        return {
            success: false,
            stdout: e?.stdout || '',
            stderr: e?.stderr || e?.error?.message || '',
            exitCode: e?.error?.code || 1
        };
    }
}

/**
 * Удаляет контейнер
 */
async function removeContainer(containerId) {
    try {
        await execDocker(['rm', '-f', containerId]);
        console.log(`[DOCKER] Removed container: ${containerId}`);
    } catch (error) {
        console.log(`[DOCKER] Remove failed: ${error.message}`);
    }
}

/**
 * Копирует файл из контейнера
 */
async function copyFromContainer(containerId, containerPath, localPath) {
    const local = toDockerCpLocalPath(localPath);
    await execDocker(['cp', `${containerId}:${containerPath}`, local]);
}

/**
 * Копирует файл в контейнер
 */
async function copyToContainer(localPath, containerId, containerPath) {
    const local = toDockerCpLocalPath(localPath);
    await execDocker(['cp', local, `${containerId}:${containerPath}`]);
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
        const { stdout } = await execDocker(['inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', containerId]);
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
