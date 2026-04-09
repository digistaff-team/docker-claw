const path = require('path');
const { execFile } = require('child_process');
const config = require('../config');
const { createUserDatabase, getDatabaseInfo } = require('./postgres.service');
const storageService = require('./storage.service');

function execFileCommand(file, args, options) {
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

function shEscape(arg) {
    return "'" + String(arg).replace(/'/g, "'\"'\"") + "'";
}

function normalizeDockerBindPath(inputPath) {
    if (!inputPath) return inputPath;
    const m = String(inputPath).match(/^[A-Za-z]:\\mnt\\([A-Za-z])(.*)$/);
    if (!m) return inputPath;
    return '/mnt/' + m[1].toLowerCase() + (m[2] || '').replace(/\\/g, '/');
}

function toDockerCpLocalPath(localPath) {
    const abs = path.resolve(String(localPath || ''));
    const m = abs.match(/^([A-Za-z]):\\(.*)$/);
    if (m) {
        return '/mnt/' + m[1].toLowerCase() + '/' + m[2].replace(/\\/g, '/');
    }
    return abs.replace(/\\/g, '/');
}

async function execDocker(args, options) {
    const cmd = ['docker'].concat(args || []).map(shEscape).join(' ');
    return execFileCommand('bash', ['-lc', cmd], options);
}

/**
 * Выполняет docker команду с прямой передачей аргументов (без shEscape/join)
 * Это важно для команд с complex quoting (find -printf, etc.)
 */
async function execDockerDirect(args, options) {
    return execFileCommand('docker', args, options);
}

async function isContainerAlive(containerId) {
    try {
        const res = await execDocker(['inspect', '-f', '{{.State.Running}}', containerId]);
        return (res.stdout || '').trim() === 'true';
    } catch {
        return false;
    }
}

async function getContainerIdByName(name) {
    try {
        const res = await execDocker(['ps', '-a', '-q', '-f', 'name=' + name]);
        return (res.stdout || '').trim() || null;
    } catch {
        return null;
    }
}

async function getContainerStatus(containerId) {
    try {
        const res = await execDocker(['inspect', '-f', '{{.State.Status}}', containerId]);
        return (res.stdout || '').trim();
    } catch {
        return 'unknown';
    }
}

/**
 * Получить список всех пользовательских контейнеров
 */
async function getAllUserContainers() {
    try {
        // Сначала получаем список ID контейнеров через -q (только ID, без format)
        console.log('[DOCKER] Getting user containers...');
        const psRes = await execDocker(['ps', '-a', '--filter', 'name=sandbox-user-', '-q']);
        console.log('[DOCKER] ps stdout:', psRes.stdout?.substring(0, 200));
        console.log('[DOCKER] ps stderr:', psRes.stderr?.substring(0, 200));
        
        const containerIds = (psRes.stdout || '').trim().split('\n').filter(Boolean);
        console.log('[DOCKER] Found container IDs:', containerIds.length);

        const containers = [];
        for (const containerId of containerIds) {
            if (!containerId) continue;

            // Получаем JSON информацию о контейнере
            const inspectRes = await execDocker(['inspect', containerId]);
            const inspectData = JSON.parse(inspectRes.stdout || '[]');

            if (inspectData && inspectData[0]) {
                const data = inspectData[0];
                const name = data.Name || '';
                const state = data.State || {};
                const labels = data.Config?.Labels || {};

                const chatId = labels.chat_id || name.replace('/sandbox-user-', '');
                containers.push({
                    containerId: containerId,
                    containerName: name.replace('/', ''),
                    chatId,
                    status: state.Running ? 'running' : 'stopped',
                    rawStatus: state.Status,
                    uptime: state.Running ? 'up' : null
                });
            }
        }
        console.log('[DOCKER] Returning', containers.length, 'containers');
        return containers;
    } catch (e) {
        console.error('[DOCKER] Failed to get user containers:', e.message);
        console.error('[DOCKER] Error details:', e);
        
        // Fallback: получаем контейнеры из активных сессий
        try {
            const sessionService = require('./session.service');
            const sessions = sessionService.getAllSessions();
            console.log('[DOCKER] Fallback: got', sessions.length, 'sessions');
            
            const containers = sessions.map(s => ({
                containerId: s.containerId || 'unknown',
                containerName: `sandbox-user-${s.chatId}`,
                chatId: s.chatId,
                status: s.containerId ? 'running' : 'stopped',
                rawStatus: s.containerId ? 'running' : 'exited',
                uptime: s.containerId ? 'up' : null
            }));
            
            console.log('[DOCKER] Fallback: returning', containers.length, 'containers from sessions');
            return containers;
        } catch (fallbackErr) {
            console.error('[DOCKER] Fallback also failed:', fallbackErr.message);
            return [];
        }
    }
}

async function waitForContainer(containerId, timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 15000);
    while (Date.now() < deadline) {
        if (await isContainerAlive(containerId)) {
            console.log('[DOCKER] Container ' + containerId + ' is running');
            return;
        }
        await new Promise(r => setTimeout(r, 200));
    }
    throw new Error('Container ' + containerId + ' did not start within ' + timeoutMs + 'ms');
}

/**
 * Остановить контейнер (без удаления)
 */
async function stopContainer(containerId) {
    await execDocker(['stop', '-t', '10', containerId]);
}

/**
 * Запустить остановленный контейнер (без пере-инициализации)
 */
async function startContainer(containerId) {
    await execDocker(['start', containerId]);
    await waitForContainer(containerId, 15000);
}

async function createUserContainer(chatId, options) {
    const containerName = 'sandbox-user-' + chatId;
    const allowNetwork = options && options.allowNetwork !== false;
    const networkMode = allowNetwork ? 'bridge' : 'none';

    let dbInfo = null;
    try {
        await createUserDatabase(chatId);
        dbInfo = await getDatabaseInfo(chatId);
    } catch (e) {
        console.log('[DOCKER] DB creation failed:', e.message);
    }

    const dataDir = path.resolve(await storageService.ensureUserDir(chatId));
    const dockerDataDir = normalizeDockerBindPath(dataDir);

    const existingId = await getContainerIdByName(containerName);
    if (existingId) {
        console.log('[DOCKER] Removing existing container:', containerName);
        await removeContainer(existingId);
    }

    const envVars = [];
    if (dbInfo) {
        envVars.push('PGHOST', String(dbInfo.host));
        envVars.push('PGPORT', String(dbInfo.port));
        envVars.push('PGDATABASE', String(dbInfo.database));
        envVars.push('PGUSER', String(dbInfo.user));
        envVars.push('PGPASSWORD', String(dbInfo.password));
        envVars.push('DATABASE_URL', 'postgresql://' + dbInfo.host + ':' + dbInfo.port + '/' + dbInfo.database);
    }

    const runArgs = [
        'run', '-d',
        '--name', containerName,
        '--memory', String(config.CONTAINER_MEMORY),
        '--cpus', String(config.CONTAINER_CPUS),
        '--pids-limit', '200',
        '--user', 'root',
        '--tmpfs', '/tmp:rw,exec,nosuid,size=512m',
        '-v', dockerDataDir + ':/workspace',
        '--network', networkMode,
        '--label', 'chat_id=' + chatId
    ];

    for (let i = 0; i < envVars.length; i += 2) {
        runArgs.push('--env', envVars[i] + '=' + envVars[i + 1]);
    }

    runArgs.push('node:20-bookworm', 'bash', '-c', 'corepack enable && sleep infinity');

    console.log('[DOCKER] Creating container:', containerName);

    let stdout;
    try {
        const res = await execDocker(runArgs);
        stdout = res.stdout;
    } catch (e) {
        const msg = e && (e.error && e.error.message || e.message) || 'docker run failed';
        console.error('[DOCKER] docker run failed:', msg);
        throw new Error(msg);
    }

    const containerId = (stdout || '').trim();
    await waitForContainer(containerId, 15000);

    console.log('[DOCKER] Created container:', containerName);
    if (dbInfo) {
        console.log('[DOCKER] PostgreSQL env vars set: PGHOST=' + dbInfo.host);
    }

    return { containerId: containerId, containerName: containerName, dataDir: dataDir, database: dbInfo };
}

async function executeInContainer(containerId, command, timeout) {
    const dangerous = [
        /rm\s+-rf\s+\/(?!tmp|workspace)/,
        /:\(\)\{\s*:\|:&\s*\};:/,
        />\s*\/dev\/sd[a-z]/,
        /dd\s+if=.*of=\/dev/,
        /mkfs/,
        /chmod\s+000\s+\//
    ];

    for (const p of dangerous) {
        if (p.test(command)) {
            return { success: false, stdout: '', stderr: 'Blocked', exitCode: 126, executionTime: 0 };
        }
    }

    const start = Date.now();
    try {
        // Используем прямую передачу аргументов для правильной работы с quoting
        const res = await execDockerDirect(['exec', containerId, 'bash', '-c', command], {
            timeout: (timeout || 30) * 1000,
            maxBuffer: 10 * 1024 * 1024
        });
        return {
            success: true,
            stdout: res.stdout || '',
            stderr: res.stderr || '',
            exitCode: 0,
            executionTime: Math.round((Date.now() - start) / 100) / 10
        };
    } catch (e) {
        return {
            success: false,
            stdout: e && e.stdout || '',
            stderr: e && (e.stderr || e.error && e.error.message) || '',
            exitCode: e && e.error && e.error.code || 1,
            executionTime: Math.round((Date.now() - start) / 100) / 10
        };
    }
}

async function execAsRoot(containerId, command, timeout) {
    try {
        const res = await execDocker(['exec', '-u', 'root', containerId, 'bash', '-c', command], {
            timeout: (timeout || 60) * 1000,
            maxBuffer: 10 * 1024 * 1024
        });
        return { success: true, stdout: res.stdout || '', stderr: res.stderr || '', exitCode: 0 };
    } catch (e) {
        return { success: false, stdout: e && e.stdout || '', stderr: e && (e.stderr || e.error && e.error.message) || '', exitCode: e && e.error && e.error.code || 1 };
    }
}

async function removeContainer(containerId) {
    try {
        await execDocker(['rm', '-f', containerId]);
        console.log('[DOCKER] Removed container:', containerId);
    } catch (e) {
        console.log('[DOCKER] Remove failed:', e.message);
    }
}

async function copyFromContainer(containerId, containerPath, localPath) {
    const local = toDockerCpLocalPath(localPath);
    await execDocker(['cp', containerId + ':' + containerPath, local]);
}

async function copyToContainer(localPath, containerId, containerPath) {
    const local = toDockerCpLocalPath(localPath);
    await execDocker(['cp', local, containerId + ':' + containerPath]);
}

async function initializeWorkspaceStructure(containerId, onStep) {
    console.log('[INIT] Starting initialization for', containerId);

    const report = function(name, idx, total) {
        if (typeof onStep === 'function') onStep(name, idx, total);
    };

    const NPM_FLAGS = '--loglevel=error --no-fund --no-audit --cache /tmp/npm-cache';

    const checkPackages = async function(packages) {
        const checks = packages.map(function(pkg) {
            return 'command -v ' + pkg + ' >/dev/null 2>&1 && echo "' + pkg + ':ok" || echo "' + pkg + ':missing"';
        }).join(' && ');
        const result = await execAsRoot(containerId, checks, 10);
        const installed = [];
        const missing = [];
        for (let i = 0; i < packages.length; i++) {
            const pkg = packages[i];
            if (result.stdout.indexOf(pkg + ':ok') >= 0) {
                installed.push(pkg);
            } else {
                missing.push(pkg);
            }
        }
        return { installed: installed, missing: missing };
    };

    const steps = [
        {
            name: 'Creating workspace directories',
            cmds: [
                'mkdir -p /workspace/input /workspace/output /workspace/work /workspace/log /workspace/apps /workspace/tmp && chmod 777 /workspace/apps /workspace/tmp',
                'cd /root && rm -f input output work log apps tmp 2>/dev/null; ln -s /workspace/input input; ln -s /workspace/output output; ln -s /workspace/work work; ln -s /workspace/log log; ln -s /workspace/apps apps; ln -s /workspace/tmp tmp'
            ]
        },
        {
            name: 'yarn and pnpm',
            check: async function() {
                const r = await checkPackages(['yarn', 'pnpm']);
                return r.missing.length === 0;
            },
            cmds: ['corepack enable', 'yarn --version && pnpm --version']
        },
        {
            name: 'nodemon and pm2',
            check: async function() {
                const r = await checkPackages(['nodemon', 'pm2']);
                return r.missing.length === 0;
            },
            cmds: ['npm install -g nodemon pm2 ' + NPM_FLAGS, 'nodemon --version && pm2 --version']
        },
        {
            name: 'TypeScript, ESLint, Prettier',
            check: async function() {
                const r = await checkPackages(['tsc', 'eslint', 'prettier']);
                return r.missing.length === 0;
            },
            cmds: ['npm install -g typescript ts-node eslint prettier ' + NPM_FLAGS, 'tsc --version && eslint --version']
        },
        {
            name: 'Vite',
            check: async function() {
                const r = await checkPackages(['vite']);
                return r.missing.length === 0;
            },
            cmds: ['npm install -g vite ' + NPM_FLAGS, 'vite --version']
        }
    ];

    for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        report(step.name, i + 1, steps.length + 1);

        if (step.check) {
            try {
                if (await step.check()) {
                    console.log('[INIT] Skipping ' + step.name + ' - already installed');
                    continue;
                }
            } catch (e) {
                console.log('[INIT] Check failed:', e.message);
            }
        }

        for (let j = 0; j < step.cmds.length; j++) {
            const cmd = step.cmds[j];
            try {
                console.log('[INIT] Running:', cmd);
                const result = await execAsRoot(containerId, cmd, 180);
                if (result.stdout) console.log('[INIT] Result:', result.stdout.trim());
                if (result.stderr && !result.success) console.log('[INIT] Warning:', result.stderr.trim());
            } catch (e) {
                console.log('[INIT] Failed:', cmd, e.message);
            }
        }
    }

    report('Done', steps.length + 1, steps.length + 1);
    console.log('[INIT] Initialization complete');
}

async function resetContainerWorkspace(containerId) {
    await executeInContainer(containerId, 'rm -rf /workspace/*');
    await initializeWorkspaceStructure(containerId);
}

async function getContainerIP(containerId) {
    try {
        const res = await execDocker(['inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', containerId]);
        return (res.stdout || '').trim() || null;
    } catch {
        return null;
    }
}

module.exports = {
    isContainerAlive: isContainerAlive,
    getContainerIdByName: getContainerIdByName,
    getContainerStatus: getContainerStatus,
    getAllUserContainers: getAllUserContainers,
    waitForContainer: waitForContainer,
    stopContainer: stopContainer,
    startContainer: startContainer,
    createUserContainer: createUserContainer,
    executeInContainer: executeInContainer,
    removeContainer: removeContainer,
    copyFromContainer: copyFromContainer,
    copyToContainer: copyToContainer,
    execAsRoot: execAsRoot,
    resetContainerWorkspace: resetContainerWorkspace,
    initializeWorkspaceStructure: initializeWorkspaceStructure,
    getContainerIP: getContainerIP
};
