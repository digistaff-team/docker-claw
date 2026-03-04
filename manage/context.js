const sessionService = require('../services/session.service');
const dockerService = require('../services/docker.service');

const PERSONA_FILES = ['IDENTITY.md', 'SOUL.md', 'USER.md', 'MEMORY.md'];

// MySQL API для получения навыков
const MYSQL_API_URL = 'https://ai.memory.api.atiks.org/mysql_full_proxy_api';
const MYSQL_API_KEY = 'mysql-VTJGc2RHVmtYMS9PQ09iSlgycDZrRWVWVWt5bWR1azQ4bkVqK0JkeXlvSjhpMGg0UW1YSUFlbjRycmM3ZWIzZmkxOVZ1bDNQZ2NITVVtZE9iWGp2R0FiSFRUKzU3YjJEdzMvKzRoR0VaM0htNWtsM2pCOU5rK29VcElGZHRFaXpaa0N5UGVmN2hwdk9aeWdZMkIrcnNCVnRpdWFyaDV1RXVFSFpTK2JJM0hZeHBwZ2dEUGgrQ0pJV3Biem9RdHBGQlhOZ0hkbXhkZDRHSCtXUkpUTnQxYjI5T3VuQklVbUJPdE91Z1VYdm02K2lsL3lHSUpacCtSOWlzQ0xBcktLUQ==';

/**
 * Загружает выбранные навыки пользователя из MySQL
 */
async function getUserSkills(userEmail) {
    if (!userEmail) return [];
    
    try {
        const fetch = require('node-fetch');
        const response = await fetch(MYSQL_API_URL, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${MYSQL_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                sql: `SELECT s.* FROM ai_skills s 
                      INNER JOIN user_selected_skills us ON s.id = us.skill_id 
                      WHERE us.user_email = %s AND s.is_active = 1`,
                params: [userEmail]
            })
        });
        
        if (!response.ok) {
            console.error('[SKILLS-LOAD-ERROR]', response.status);
            return [];
        }
        
        const result = await response.json();
        if (result.error) {
            console.error('[SKILLS-LOAD-ERROR]', result.error);
            return [];
        }
        
        console.log('[SKILLS-LOAD-OK]', userEmail, 'found:', (result.data || []).length, 'skills');
        return result.data || [];
    } catch (e) {
        console.error('[SKILLS-LOAD-ERROR]', e.message);
        return [];
    }
}

/**
 * Собирает контекст окружения для ответа бота: последние команды, структура файлов, персона.
 */
async function buildContext(chatId) {
    const session = sessionService.getSession(chatId);
    if (!session) return 'Сессия не найдена. Создайте сессию в панели.';

    const parts = [];
    const manageStore = require('./store');
    const projectCacheService = require('../services/projectCache.service');
    
    // Получаем настройки контекста
    const settings = manageStore.getContextSettings(chatId);

    const lastCommands = manageStore.getLastCommands(chatId, settings.maxCommands);
    if (lastCommands.length > 0) {
        parts.push('📋 Последние команды:');
        lastCommands.forEach((c, i) => {
            parts.push(`  ${i + 1}. ${c.command}`);
            if (settings.includeStdout && c.stdout) {
                parts.push(`     out: ${c.stdout.trim().slice(0, settings.stdoutMaxChars)}`);
            }
            if (settings.includeStderr && c.stderr) {
                parts.push(`     err: ${c.stderr.trim().slice(0, settings.stderrMaxChars)}`);
            }
        });
        parts.push('');
    }

    // Используем кэш проекта вместо прямого сканирования
    try {
        const cache = await projectCacheService.getProjectCache(chatId);
        if (cache && !cache._incomplete) {
            parts.push(projectCacheService.formatCacheForContext(cache, settings.maxFiles));
            parts.push('');
        } else {
            // Fallback на быстрый find с исключениями (без stat)
            const result = await dockerService.executeInContainer(
                session.containerId,
                `find /workspace -maxdepth ${settings.maxDepth} ` +
                `-not -path '*/node_modules/*' ` +
                `-not -path '*/.git/*' ` +
                `-not -path '*/__pycache__/*' ` +
                `-not -path '*/.venv/*' ` +
                `\\( -type f -o -type d \\) 2>/dev/null | head -${settings.maxFiles}`
            );
            const lines = (result.stdout || '').trim().split('\n').filter(Boolean);
            if (lines.length > 0) {
                parts.push(`📁 Файлы (до ${settings.maxFiles}):`);
                parts.push(lines.slice(0, settings.maxFileLines).join('\n'));
                if (lines.length > settings.maxFileLines) parts.push(`... и ещё ${lines.length - settings.maxFileLines}`);
                parts.push('');
            }
        }
    } catch (e) {
        console.error('[CONTEXT] Cache error:', e.message);
        parts.push('(список файлов недоступен)\n');
    }

    parts.push('🎭 Файлы персонализации в /workspace: ' + PERSONA_FILES.join(', '));
    return parts.join('\n');
}

/**
 * Читает содержимое файла персонализации из контейнера (кратко для контекста).
 */
async function getPersonaSummary(chatId) {
    const session = sessionService.getSession(chatId);
    if (!session) return '';

    const manageStore = require('./store');
    const settings = manageStore.getContextSettings(chatId);

    const lines = [];
    for (const name of PERSONA_FILES) {
        try {
            const r = await dockerService.executeInContainer(
                session.containerId,
                `cat /workspace/${name} 2>/dev/null | head -${settings.personaLines}`
            );
            if (r.stdout && r.stdout.trim()) {
                lines.push(`--- ${name} ---`);
                lines.push(r.stdout.trim().slice(0, settings.personaChars));
            }
        } catch (e) {
            // ignore
        }
    }
    return lines.join('\n\n');
}

/**
 * Проверяет наличие webhook_handler.js или webhook_handler.py в контейнере.
 * В��звращает 'js', 'py', или false.
 *
 * Проверяем оба варианта одной командой, чтобы не делать два round-trip к Docker.
 * Формат вывода: "js", "py", или пустая строка (не найден).
 */
async function checkWebhookHandlerExists(chatId) {
    const session = sessionService.getSession(chatId);
    if (!session) return false;
    try {
        const r = await dockerService.executeInContainer(
            session.containerId,
            // Проверяем .js первым — он приоритетнее; если нет — проверяем .py
            'if [ -f /workspace/webhook_handler.js ]; then echo "js"; elif [ -f /workspace/webhook_handler.py ]; then echo "py"; fi'
        );
        const out = (r.stdout || '').trim();
        if (out === 'js') return 'js';
        if (out === 'py') return 'py';
        return false;
    } catch (e) {
        return false;
    }
}

/**
 * Проверяет и очищает реестр приложений, удаляя несуществующие.
 * Проверяет: наличие папки /workspace/apps/{name} и статус PM2.
 * Возвращает актуальный список приложений.
 */
async function verifyAppsRegistry(chatId) {
    const manageStore = require('./store');
    const session = sessionService.getSession(chatId);
    
    if (!session) {
        return [];
    }
    
    const apps = manageStore.getApps(chatId) || [];
    if (apps.length === 0) {
        return [];
    }
    
    const validApps = [];
    let changed = false;
    
    for (const app of apps) {
        try {
            // Проверяем наличие папки приложения
            const checkDir = await dockerService.executeInContainer(
                session.containerId,
                `test -d /workspace/apps/${app.name} && echo "exists" || echo "missing"`
            );
            
            const dirExists = (checkDir.stdout || '').trim() === 'exists';
            
            // Проверяем статус в PM2
            const checkPm2 = await dockerService.executeInContainer(
                session.containerId,
                `pm2 jlist 2>/dev/null | grep -o '"name":"app-${app.name}"' || echo "not_found"`
            );
            
            const pm2Running = (checkPm2.stdout || '').includes(`"name":"app-${app.name}"`);
            
            if (dirExists || pm2Running) {
                // Приложение существует - обновляем статус
                validApps.push({
                    ...app,
                    status: pm2Running ? 'running' : 'stopped'
                });
            } else {
                // Приложение не существует - удаляем из реестра
                console.log(`[APPS-REGISTRY] Removing dead app: ${app.name}`);
                manageStore.removeApp(chatId, app.name);
                changed = true;
            }
        } catch (e) {
            console.error(`[APPS-REGISTRY] Error checking app ${app.name}:`, e.message);
            // При ошибке оставляем приложение в списке
            validApps.push(app);
        }
    }
    
    return validApps;
}

/**
 * Возвращает структурированный контекст для формирования системного промпта.
 * Структура идентична тому, что показывается в админке.
 */
async function buildFullContextStructured(chatId) {
    const ctx = await buildContext(chatId);
    const persona = await getPersonaSummary(chatId);
    
    // Получаем email пользователя для загрузки навыков
    const manageStore = require('./store');
    const data = manageStore.getState(chatId);
    const userEmail = data && data.aiUserEmail ? data.aiUserEmail : null;
    
    // Загружаем навыки пользователя
    const skills = await getUserSkills(userEmail);

    // Получаем информацию о персональной базе данных из сессии
    const session = sessionService.getSession(chatId);
    const database = session && session.database ? session.database : null;

    // Реестр созданных приложений из store (с проверкой существования)
    const apps = await verifyAppsRegistry(chatId);

    // Реестр созданных Python-модулей из store
    const modules = manageStore.getModules(chatId) || [];

    // Проверяем наличие webhook_handler.js в контейнере
    const webhookHandlerExists = await checkWebhookHandlerExists(chatId);
    
    // === АВТОМАТИЧЕСКОЕ ВОЗОБНОВЛЕНИЕ ПЛАНОВ ===
    // Загружаем активные планы из planService
    let activePlans = [];
    try {
        const planService = require('../services/plan.service');
        activePlans = await planService.listActivePlans(chatId);
    } catch (e) {
        console.warn('[CONTEXT] Failed to load active plans:', e.message);
    }
    
    // Загружаем последние резюме сессий для пространственной памяти
    const sessionSummaries = manageStore.getSessionSummaries(chatId, 3);
    
    return {
        chatId: chatId,                              // ID чата для формирования ссылок
        environmentContext: ctx,                    // Последние команды, файлы
        persona: persona,                            // Файлы персонализации
        skills: skills,                              // Активные навыки
        database: database,                          // Персональная PostgreSQL БД
        aiAuthToken: data?.aiAuthToken || null,      // Токен для вызова собственного вебхука из приложений
        apps: apps,                                  // Реестр созданных Node.js-приложений
        modules: modules,                            // Реестр созданных Python-модулей
        webhookHandlerExists: webhookHandlerExists,  // Наличие /workspace/webhook_handler.js
        activePlans: activePlans,                    // Активные незавершённые планы
        sessionSummaries: sessionSummaries           // Последние резюме сессий (пространственная память)
    };
}

async function buildFullContext(chatId) {
    const structured = await buildFullContextStructured(chatId);
    
    let result = structured.environmentContext;
    result += '\n\n🎭 Персонализация:\n' + (structured.persona || '(пусто)');
    
    // Добавляем навыки в контекст (формат идентичен ai.js)
    if (structured.skills.length > 0) {
        result += '\n\n=== АКТИВНЫЕ НАВЫКИ ===\n';
        result += 'Ты имеешь следующие активные навыки:\n';
        
        structured.skills.forEach((skill, idx) => {
            result += `\n--- НАВЫК ${idx + 1}: ${skill.name} ---\n`;
            result += `${skill.system_prompt}\n`;
        });
    }
    
    return result;
}

module.exports = {
    buildContext,
    getPersonaSummary,
    buildFullContext,
    buildFullContextStructured,
    getUserSkills,
    verifyAppsRegistry,
    PERSONA_FILES
};