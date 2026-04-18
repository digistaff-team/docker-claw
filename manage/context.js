const sessionService = require('../services/session.service');
const dockerService = require('../services/docker.service');
const mysqlService = require('../services/mysql.service');
const manageStore = require('./store');

const PERSONA_FILES = ['IDENTITY.md', 'SOUL.md', 'USER.md', 'MEMORY.md'];

/**
 * Загружает выбранные навыки пользователя из MySQL
 */
async function getUserSkills(userEmail) {
    if (!userEmail) return [];

    try {
        const skills = await mysqlService.getUserSkills(userEmail);
        console.log('[SKILLS-LOAD-OK]', userEmail, 'found:', skills.length, 'skills');
        return skills;
    } catch (e) {
        console.error('[SKILLS-LOAD-ERROR]', e.message);
        return [];
    }
}

/**
 * Проверяет, подключён ли канал OK (Одноклассники)
 * @param {string} chatId - ID чата
 * @returns {boolean}
 */
function isOkChannelActive(chatId) {
    const okConfig = manageStore.getOkConfig(chatId);
    return !!(okConfig?.is_active && okConfig?.group_id && okConfig?.access_token);
}

/**
 * Проверяет, подключён ли канал VK (ВКонтакте)
 * @param {string} chatId - ID чата
 * @returns {boolean}
 */
function isVkChannelActive(chatId) {
    const vkConfig = manageStore.getVkConfig(chatId);
    return !!(vkConfig?.is_active && vkConfig?.group_id && vkConfig?.access_token);
}

/**
 * Получает навык "Копирайтер для Одноклассников" автоматически
 * @returns {Promise<Object|null>}
 */
async function getAutoOkCopywriterSkill() {
    try {
        const skill = await mysqlService.getSkillBySlug('ok-copywriter');
        if (skill) {
            console.log('[AUTO-SKILL-OK] Found OK copywriter skill:', skill.name);
        }
        return skill || null;
    } catch (e) {
        console.error('[AUTO-SKILL-OK] Error:', e.message);
        return null;
    }
}

/**
 * Проверяет, подключён ли Telegram-канал для публикации контента
 * @param {string} chatId - ID чата
 * @returns {boolean}
 */
function isTelegramChannelActive(chatId) {
    const settings = manageStore.getContentSettings(chatId);
    return !!(settings?.channelId);
}

/**
 * Получает навык "Копирайтер для Telegram" автоматически
 * @returns {Promise<Object|null>}
 */
async function getAutoTelegramCopywriterSkill() {
    try {
        const skill = await mysqlService.getSkillBySlug('tg-copywriter');
        if (skill) {
            console.log('[AUTO-SKILL-TG] Found Telegram copywriter skill:', skill.name);
        }
        return skill || null;
    } catch (e) {
        console.error('[AUTO-SKILL-TG] Error:', e.message);
        return null;
    }
}

/**
 * Получает навык "Копирайтер для ВКонтакте" автоматически
 * @returns {Promise<Object|null>}
 */
async function getAutoVkCopywriterSkill() {
    try {
        const skill = await mysqlService.getSkillBySlug('vk-copywriter');
        if (skill) {
            console.log('[AUTO-SKILL-VK] Found VK copywriter skill:', skill.name);
        }
        return skill || null;
    } catch (e) {
        console.error('[AUTO-SKILL-VK] Error:', e.message);
        return null;
    }
}

/**
 * Проверяет, подключён ли канал Instagram
 * @param {string} chatId - ID чата
 * @returns {boolean}
 */
function isInstagramChannelActive(chatId) {
    const igConfig = manageStore.getInstagramConfig(chatId);
    return !!(igConfig?.is_active && igConfig?.buffer_channel_id);
}

function isInstagramReelsChannelActive(chatId) {
    const cfg = manageStore.getInstagramReelsConfig(chatId);
    return !!(cfg?.is_active && cfg?.buffer_channel_id);
}

function isFacebookChannelActive(chatId) {
    const cfg = manageStore.getFacebookConfig ? manageStore.getFacebookConfig(chatId) : null;
    return !!(cfg?.is_active && cfg?.buffer_channel_id);
}

function isPinterestChannelActive(chatId) {
    const cfg = manageStore.getPinterestConfig ? manageStore.getPinterestConfig(chatId) : null;
    return !!(cfg?.buffer_channel_id);
}

function isTiktokChannelActive(chatId) {
    const cfg = manageStore.getTiktokConfig ? manageStore.getTiktokConfig(chatId) : null;
    return !!(cfg?.is_active && cfg?.buffer_channel_id);
}

function isVkVideoChannelActive(chatId) {
    const cfg = manageStore.getVkVideoConfig ? manageStore.getVkVideoConfig(chatId) : null;
    return !!(cfg?.is_active);
}

function isBlogChannelActive(chatId) {
    const cfg = manageStore.getWpConfig ? manageStore.getWpConfig(chatId) : null;
    return !!(cfg?.base_url && cfg?.is_active);
}

/**
 * Получает навык копирайтера по slug автоматически
 */
async function getAutoSkill(slug, tag) {
    try {
        const skill = await mysqlService.getSkillBySlug(slug);
        if (skill) console.log(`[AUTO-SKILL-${tag}] Found:`, skill.name);
        return skill || null;
    } catch (e) {
        console.error(`[AUTO-SKILL-${tag}] Error:`, e.message);
        return null;
    }
}

async function getAutoInstagramCopywriterSkill()      { return getAutoSkill('instagram-copywriter', 'IG'); }
async function getAutoInstagramReelsCopywriterSkill() { return getAutoSkill('instagram-reels-copywriter', 'REELS'); }
async function getAutoFacebookCopywriterSkill()       { return getAutoSkill('facebook-copywriter', 'FB'); }
async function getAutoPinterestCopywriterSkill()      { return getAutoSkill('pinterest-copywriter', 'PIN'); }
async function getAutoTiktokCopywriterSkill()         { return getAutoSkill('tiktok-copywriter', 'TT'); }
async function getAutoVkVideoCopywriterSkill()        { return getAutoSkill('vkvideo-copywriter', 'VKVID'); }
async function getAutoBlogCopywriterSkill()           { return getAutoSkill('blog-copywriter', 'BLOG'); }

/**
 * Проверяет, подключён ли канал YouTube
 */
function isYoutubeChannelActive(chatId) {
    const ytConfig = manageStore.getYoutubeConfig(chatId);
    return !!(ytConfig?.is_active && ytConfig?.buffer_channel_id);
}

async function getAutoYoutubeCopywriterSkill() { return getAutoSkill('youtube-copywriter', 'YT'); }

/**
 * Собирает контекст окружения для ответа бота: последние команды, структура файлов, персона.
 */
async function buildContext(chatId) {
    const session = sessionService.getSession(chatId);
    if (!session) return 'Сессия не найдена. Создайте сессию в панели.';

    const parts = [];
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

    // === АВТОМАТИЧЕСКОЕ ДОБАВЛЕНИЕ НАВЫКА ПРИ АКТИВНОМ TELEGRAM-КАНАЛЕ ===
    if (isTelegramChannelActive(chatId)) {
        const tgSkill = await getAutoTelegramCopywriterSkill();
        if (tgSkill && !skills.find(s => s.slug === 'tg-copywriter')) {
            skills.push(tgSkill);
            console.log('[AUTO-SKILL-TG] Added Telegram copywriter skill for chat:', chatId);
        }
    }

    // === АВТОМАТИЧЕСКОЕ ДОБАВЛЕНИЕ НАВЫКА ПРИ АКТИВНОМ КАНАЛЕ OK ===
    if (isOkChannelActive(chatId)) {
        const okSkill = await getAutoOkCopywriterSkill();
        if (okSkill && !skills.find(s => s.slug === 'ok-copywriter')) {
            skills.push(okSkill);
            console.log('[AUTO-SKILL-OK] Added OK copywriter skill for chat:', chatId);
        }
    }

    // === АВТОМАТИЧЕСКОЕ ДОБАВЛЕНИЕ НАВЫКА ПРИ АКТИВНОМ КАНАЛЕ VK ===
    if (isVkChannelActive(chatId)) {
        const vkSkill = await getAutoVkCopywriterSkill();
        if (vkSkill && !skills.find(s => s.slug === 'vk-copywriter')) {
            skills.push(vkSkill);
            console.log('[AUTO-SKILL-VK] Added VK copywriter skill for chat:', chatId);
        }
    }

    // === АВТОМАТИЧЕСКОЕ ДОБАВЛЕНИЕ НАВЫКА ПРИ АКТИВНОМ КАНАЛЕ INSTAGRAM ===
    if (isInstagramChannelActive(chatId)) {
        const igSkill = await getAutoInstagramCopywriterSkill();
        if (igSkill && !skills.find(s => s.slug === 'instagram-copywriter')) {
            skills.push(igSkill);
            console.log('[AUTO-SKILL-IG] Added Instagram copywriter skill for chat:', chatId);
        }
    }

    // === АВТОМАТИЧЕСКОЕ ДОБАВЛЕНИЕ НАВЫКА ПРИ АКТИВНОМ КАНАЛЕ YOUTUBE ===
    if (isYoutubeChannelActive(chatId)) {
        const ytSkill = await getAutoYoutubeCopywriterSkill();
        if (ytSkill && !skills.find(s => s.slug === 'youtube-copywriter')) {
            skills.push(ytSkill);
        }
    }

    // === INSTAGRAM REELS ===
    if (isInstagramReelsChannelActive(chatId)) {
        const skill = await getAutoInstagramReelsCopywriterSkill();
        if (skill && !skills.find(s => s.slug === 'instagram-reels-copywriter')) skills.push(skill);
    }

    // === FACEBOOK ===
    if (isFacebookChannelActive(chatId)) {
        const skill = await getAutoFacebookCopywriterSkill();
        if (skill && !skills.find(s => s.slug === 'facebook-copywriter')) skills.push(skill);
    }

    // === PINTEREST ===
    if (isPinterestChannelActive(chatId)) {
        const skill = await getAutoPinterestCopywriterSkill();
        if (skill && !skills.find(s => s.slug === 'pinterest-copywriter')) skills.push(skill);
    }

    // === TIKTOK ===
    if (isTiktokChannelActive(chatId)) {
        const skill = await getAutoTiktokCopywriterSkill();
        if (skill && !skills.find(s => s.slug === 'tiktok-copywriter')) skills.push(skill);
    }

    // === VK VIDEO ===
    if (isVkVideoChannelActive(chatId)) {
        const skill = await getAutoVkVideoCopywriterSkill();
        if (skill && !skills.find(s => s.slug === 'vkvideo-copywriter')) skills.push(skill);
    }

    // === BLOG / ДЗЕН ===
    if (isBlogChannelActive(chatId)) {
        const skill = await getAutoBlogCopywriterSkill();
        if (skill && !skills.find(s => s.slug === 'blog-copywriter')) skills.push(skill);
    }

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
        skills: skills,                              // Активные навыки (включая авто-OK)
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
    isYoutubeChannelActive,
    PERSONA_FILES
};