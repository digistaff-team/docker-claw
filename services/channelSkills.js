/**
 * channelSkills.js — загружает system_prompt навыка для конкретного канала из MySQL.
 * Кеш TTL 10 минут, чтобы изменения навыков применялись без перезапуска.
 */

const mysqlService = require('./mysql.service');

const CACHE_TTL = 10 * 60 * 1000; // 10 минут

// Map<slug, { prompt: string, ts: number }>
const _cache = new Map();

/**
 * Возвращает system_prompt навыка по slug.
 * Если навык не найден — возвращает null.
 */
async function getSkillPrompt(slug) {
    const cached = _cache.get(slug);
    if (cached && Date.now() - cached.ts < CACHE_TTL) {
        return cached.prompt;
    }
    try {
        const skill = await mysqlService.getSkillBySlug(slug);
        const prompt = skill?.system_prompt || null;
        _cache.set(slug, { prompt, ts: Date.now() });
        return prompt;
    } catch (e) {
        console.error(`[CHANNEL-SKILLS] getSkillPrompt(${slug}) error:`, e.message);
        return null;
    }
}

/**
 * Формирует системный промпт: навык (если есть) + хвостовой суффикс.
 * Суффикс обычно содержит инструкцию "Отвечай только JSON." и т.п.
 *
 * @param {string} slug         — slug навыка (e.g. 'vk-copywriter')
 * @param {string} fallback     — строка, используемая если навык не найден
 * @param {string} [suffix=''] — дополнение, которое всегда добавляется в конец
 */
async function buildSystemPrompt(slug, fallback, suffix = '') {
    const skillPrompt = await getSkillPrompt(slug);
    const base = skillPrompt || fallback;
    return suffix ? `${base}\n\n${suffix}` : base;
}

module.exports = { getSkillPrompt, buildSystemPrompt };
