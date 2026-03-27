/**
 * MySQL Service для работы с базой навыков AI
 * Прямое подключение к MySQL без HTTP прослойки
 */

const mysql = require('mysql2/promise');
const config = require('../config');

let pool = null;

/**
 * Инициализация пула подключений к MySQL
 */
function initPool() {
    if (pool) {
        return pool;
    }

    const mysqlConfig = config.mysql || {
        host: process.env.MYSQL_SKILLS_HOST || 'localhost',
        port: process.env.MYSQL_SKILLS_PORT || 3306,
        user: process.env.MYSQL_SKILLS_USER || 'ai_skills',
        password: process.env.MYSQL_SKILLS_PASSWORD || '',
        database: process.env.MYSQL_SKILLS_DATABASE || 'ai_skills_db',
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0,
        enableKeepAlive: true,
        keepAliveInitialDelay: 0
    };

    pool = mysql.createPool(mysqlConfig);

    // Обработка ошибок пула
    pool.on('error', (err) => {
        console.error('[MYSQL] Unexpected error on idle client', err);
        if (err.code === 'PROTOCOL_CONNECTION_LOST') {
            console.error('[MYSQL] Connection lost, pool will reconnect on next query');
        }
    });

    console.log('[MYSQL] Pool initialized:', mysqlConfig.host + ':' + mysqlConfig.port + '/' + mysqlConfig.database);

    // Авто-сидирование: запускаем асинхронно, не блокируем инициализацию
    seedInitialSkillsIfEmpty().catch(e => console.error('[MYSQL] Seed error:', e.message));

    return pool;
}

/**
 * Выполнение SQL запроса
 * @param {string} sql - SQL запрос с плейсхолдерами ?
 * @param {array} params - Параметры для запроса
 * @returns {Promise<{data: array, insert_id?: number}>}
 */
async function query(sql, params = []) {
    try {
        const connectionPool = initPool();
        const [rows] = await connectionPool.execute(sql, params);

        // Для INSERT возвращаем lastInsertId
        let result = { data: rows };
        if (rows.affectedRows !== undefined && connectionPool.lastInsertId) {
            result.insert_id = connectionPool.lastInsertId;
        }

        return result;
    } catch (e) {
        console.error('[MYSQL] Query error:', e.message);
        console.error('[MYSQL] SQL:', sql);
        console.error('[MYSQL] Params:', params);
        throw e;
    }
}

/**
 * Получить навыки пользователя
 * @param {string} userEmail - Идентификатор пользователя (chat_{chatId})
 * @returns {Promise<Array>}
 */
async function getUserSkills(userEmail) {
    if (!userEmail) {
        return [];
    }

    try {
        const result = await query(
            `SELECT s.* FROM ai_skills s
             INNER JOIN user_selected_skills us ON s.id = us.skill_id
             WHERE us.user_email = ? AND s.is_active = 1
             ORDER BY s.category_slug, s.name`,
            [userEmail]
        );
        return result.data || [];
    } catch (e) {
        console.error('[MYSQL] getUserSkills error:', e.message);
        return [];
    }
}

/**
 * Получить все активные публичные навыки
 * @returns {Promise<Array>}
 */
async function getAllPublicSkills() {
    try {
        const result = await query(
            `SELECT * FROM ai_skills
             WHERE is_active = 1 AND is_public = 1
             ORDER BY usage_count DESC, name ASC`
        );
        return result.data || [];
    } catch (e) {
        console.error('[MYSQL] getAllPublicSkills error:', e.message);
        return [];
    }
}

/**
 * Получить навыки конкретного пользователя (включая личные)
 * @param {string} userEmail - Идентификатор пользователя
 * @returns {Promise<Array>}
 */
async function getUserPrivateSkills(userEmail) {
    if (!userEmail) {
        return [];
    }

    try {
        const result = await query(
            `SELECT * FROM ai_skills
             WHERE is_active = 1 AND (is_public = 1 OR user_email = ?)
             ORDER BY category_slug, name`,
            [userEmail]
        );
        return result.data || [];
    } catch (e) {
        console.error('[MYSQL] getUserPrivateSkills error:', e.message);
        return [];
    }
}

/**
 * Выбрать навык пользователем
 * @param {string} userEmail - Идентификатор пользователя
 * @param {number} skillId - ID навыка
 */
async function selectSkill(userEmail, skillId) {
    try {
        await query(
            `INSERT INTO user_selected_skills (user_email, skill_id)
             VALUES (?, ?)
             ON DUPLICATE KEY UPDATE selected_at = CURRENT_TIMESTAMP`,
            [userEmail, skillId]
        );
        return true;
    } catch (e) {
        console.error('[MYSQL] selectSkill error:', e.message);
        throw e;
    }
}

/**
 * Отменить выбор навыка
 * @param {string} userEmail - Идентификатор пользователя
 * @param {number} skillId - ID навыка
 */
async function deselectSkill(userEmail, skillId) {
    try {
        await query(
            `DELETE FROM user_selected_skills
             WHERE user_email = ? AND skill_id = ?`,
            [userEmail, skillId]
        );
        return true;
    } catch (e) {
        console.error('[MYSQL] deselectSkill error:', e.message);
        throw e;
    }
}

/**
 * Получить выбранные навыки пользователя (только ID)
 * @param {string} userEmail - Идентификатор пользователя
 * @returns {Promise<Array<number>>}
 */
async function getSelectedSkillIds(userEmail) {
    if (!userEmail) {
        return [];
    }

    try {
        const result = await query(
            `SELECT skill_id FROM user_selected_skills WHERE user_email = ?`,
            [userEmail]
        );
        return (result.data || []).map(row => row.skill_id);
    } catch (e) {
        console.error('[MYSQL] getSelectedSkillIds error:', e.message);
        return [];
    }
}

/**
 * Сохранить навык (создать или обновить)
 * @param {Object} skillData - Данные навыка
 */
async function saveSkill(skillData) {
    const {
        id,
        user_email,
        name,
        slug,
        category_slug,
        category_name,
        short_desc,
        system_prompt,
        examples_text,
        tags,
        metadata_text,
        is_public
    } = skillData;

    try {
        if (id) {
            // Обновление
            await query(
                `UPDATE ai_skills SET
                    name = ?, slug = ?, category_slug = ?, category_name = ?,
                    short_desc = ?, system_prompt = ?, examples_text = ?,
                    tags = ?, metadata_text = ?, is_public = ?
                 WHERE id = ? AND user_email = ?`,
                [name, slug, category_slug, category_name, short_desc, system_prompt,
                    examples_text, tags, metadata_text, is_public ? 1 : 0, id, user_email]
            );
            return { id, updated: true };
        } else {
            // Создание
            const result = await query(
                `INSERT INTO ai_skills (
                    user_email, name, slug, category_slug, category_name,
                    short_desc, system_prompt, examples_text, tags, metadata_text, is_public
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [user_email, name, slug, category_slug, category_name,
                    short_desc, system_prompt, examples_text, tags, metadata_text, is_public ? 1 : 0]
            );
            return { id: result.insert_id || result.data?.insertId, created: true };
        }
    } catch (e) {
        console.error('[MYSQL] saveSkill error:', e.message);
        throw e;
    }
}

/**
 * Удалить навык
 * @param {number} skillId - ID навыка
 * @param {string} userEmail - Идентификатор пользователя
 */
async function deleteSkill(skillId, userEmail) {
    try {
        await query(
            `DELETE FROM ai_skills WHERE id = ? AND user_email = ?`,
            [skillId, userEmail]
        );
        return true;
    } catch (e) {
        console.error('[MYSQL] deleteSkill error:', e.message);
        throw e;
    }
}

/**
 * Проверка подключения к MySQL
 * @returns {Promise<boolean>}
 */
async function checkConnection() {
    try {
        const result = await query('SELECT 1 as test');
        return result.data && result.data[0] && result.data[0].test === 1;
    } catch (e) {
        console.error('[MYSQL] Connection check failed:', e.message);
        return false;
    }
}

/**
 * Закрыть пул подключений
 */
async function closePool() {
    if (pool) {
        await pool.end();
        pool = null;
        console.log('[MYSQL] Pool closed');
    }
}

/**
 * Авто-сидирование начальных навыков при первом подключении
 */
async function seedInitialSkillsIfEmpty() {
    try {
        const connectionPool = initPool();
        const [rows] = await connectionPool.execute('SELECT COUNT(*) as cnt FROM ai_skills');
        if (rows[0].cnt > 0) return; // уже есть данные

        console.log('[MYSQL] Seeding initial skills...');
        const seeds = [
            ['system', 'Python разработчик', 'python-developer', 'development', 'Разработка и код', 'Навыки программирования на Python', 'Ты — опытный Python разработчик. Пиши чистый, поддерживаемый код с type hints. Используй лучшие практики: PEP 8, DRY, KISS. Предпочитай явный код неявному. Всегда добавляй docstrings для функций и классов. Используй asyncio для асинхронных операций.'],
            ['system', 'JavaScript/Node.js разработчик', 'javascript-nodejs-developer', 'nodejs_dev', 'Node.js Разработка', 'Навыки разработки на Node.js', 'Ты — опытный JavaScript/Node.js разработчик. Пиши современный код с использованием ES6+ синтаксиса. Используй async/await для асинхронности. Применяй модульную архитектуру. Добавляй JSDoc комментарии. Следуй принципам Clean Code.'],
            ['system', 'SEO специалист', 'seo-specialist', 'marketing_seo', 'Маркетинг и SEO', 'Оптимизация для поисковых систем', 'Ты — профессиональный SEO специалист. Оптимизируй контент для поисковых систем. Используй ключевые слова естественно. Создавай мета-теги (title, description). Структурируй контент с заголовками H1-H6. Рекомендуй внутреннюю перелинковку.'],
            ['system', 'Копирайтер', 'copywriter', 'marketing_seo', 'Маркетинг и SEO', 'Создание продающих текстов', 'Ты — профессиональный копирайтер. Пиши продающие, вовлекающие тексты. Используй формулы AIDA, PAS. Адаптируй тон под целевую аудиторию. Добавляй призывы к действию (CTA). Избегай клише и воды.'],
            ['system', 'Аналитик данных', 'data-analyst', 'data_analysis', 'Анализ данных', 'Анализ и визуализация данных', 'Ты — опытный аналитик данных. Анализируй данные системно. Используй статистику для выводов. Визуализируй результаты (графики, таблицы). Объясняй инсайты простым языком. Рекомендуй действия на основе данных.'],
            ['system', 'PostgreSQL эксперт', 'postgresql-expert', 'database', 'Работа с базами данных', 'Проектирование и оптимизация БД', 'Ты — эксперт по PostgreSQL. Пиши оптимизированные SQL запросы. Используй индексы правильно. Проектируй нормализованную схему БД. Применяй EXPLAIN ANALYZE для отладки. Рекомендуй best practices для производительности.'],
            ['system', 'DevOps инженер', 'devops-engineer', 'sysadmin', 'Системное администрирование', 'Автоматизация и инфраструктура', 'Ты — опытный DevOps инженер. Автоматизируй рутинные задачи. Пиши bash скрипты. Настраивай CI/CD пайплайны. Мониторь системы. Обеспечивай безопасность и отказоустойчивость.'],
            ['system', 'Telegram бот разработчик', 'telegram-bot-developer', 'tg_management', 'Управление Telegram', 'Создание и управление ботами', 'Ты — разработчик Telegram ботов. Используй Telegram Bot API. Создавай интерактивные клавиатуры. Обрабатывай команды и callback query. Реализуй состояния (FSM). Интегрируй с внешними API.'],
            ['system', 'E-mail маркетолог', 'email-marketer', 'email_automation', 'Email-автоматизация', 'Email рассылки и автоматизация', 'Ты — профессиональный email маркетолог. Пиши цепляющие subject line. Создавай персонализированные письма. Сегментируй аудиторию. A/B тестируй варианты. Оптимизируй для мобильных устройств.'],
            ['system', 'Системный администратор Linux', 'linux-sysadmin', 'sysadmin', 'Системное администрирование', 'Администрирование Linux серверов', 'Ты — опытный Linux системный администратор. Управляй серверами через bash. Настраивай службы (systemd). Мониторь ресурсы (top, htop, iotop). Анализируй логи (journalctl, /var/log). Обеспечивай безопасность (firewall, ssh).'],
            ['system', 'Копирайтер для Instagram', 'instagram-copywriter', 'marketing_seo', 'Маркетинг и SEO', 'Создание постов для Instagram', 'Ты — эксперт по Instagram-маркетингу. Создавай вовлекающие подписи с:\n\nФОРМАТ ПОДПИСИ:\n• Длина: 150–2200 символов (оптимально 300–500)\n• Первая строка — хук (цепляет внимание, интрига или вопрос)\n• 5–15 релевантных хэштегов в конце поста\n• Эмодзи как маркеры абзацев (2–4 на пост)\n• CTA в конце (призыв к действию: лайк, коммент, сохрани, подпишись)\n\nСТИЛЬ:\n• Живой, разговорный, без канцелярита\n• Короткие абзацы (2–3 предложения)\n• Личный тон, обращение на «ты»\n• Без кликбейта, но с интригой\n\nСПЕЦИФИКА КОНТЕНТА:\n• Для Reels: акцент на динамику, тренды, музыку, движение\n• Для фото: акцент на визуал, детали, атмосферу, настроение\n• Для карусели: структурированный контент, шаг за шагом\n\nХЭШТЕГИ:\n• Микс: 3–5 популярных (100K+), 5–7 средних (10K–100K), 2–3 нишевых\n• Релевантные теме поста\n• Без запрещённых и спамных тегов'],
            ['system', 'Копирайтер для Telegram', 'tg-copywriter', 'marketing_seo', 'Маркетинг и SEО', 'Создание постов для Telegram-каналов', 'Ты — профессиональный копирайтер для Telegram-каналов.\n\nФОРМАТИРОВАНИЕ (только разрешённые HTML-теги):\n• <b>жирный</b> — для заголовков и акцентов\n• <i>курсив</i> — для цитат и второстепенного\n• <u>подчёркнутый</u> — редко, для важных деталей\n• <code>моноширинный</code> — для кодов, команд, ссылок\n• <pre>блок кода</pre> — для многострочного кода\n• <a href="URL">текст</a> — для ссылок\n• НЕ используй Markdown (* _ #), он не работает в Telegram\n\nСТРУКТУРА ПОСТА:\n• Начинай с цепляющего первого предложения (превью в уведомлении — ~60 симв.)\n• Абзацы разделяй пустой строкой\n• Используй эмодзи как визуальные маркеры (умеренно, 3–7 на пост)\n• Хэштеги: 1–4 в конце, только если релевантны для навигации канала\n\nДЛИНА:\n• Обычный пост: 300–800 символов\n• Детальный материал: до 2000 символов\n• Медиапост (с фото/видео): подпись 100–400 символов (лимит caption = 1024)\n• Очень длинный материал: порекомендуй Telegra.ph\n\nАУДИТОРИЯ И СТИЛЬ:\n• Telegram-аудитория: технически грамотная, ценит конкретику и экспертизу\n• Без воды и вступлений вида "Сегодня я хочу рассказать вам..."\n• Разговорный, но профессиональный тон\n• Призыв к действию или вопрос в конце — для вовлечённости\n\nСПЕЦИФИКА КАНАЛОВ:\n• Для информационных каналов: факты + структура + ссылки\n• Для коммерческих: польза → проблема → решение → CTA\n• Для развлекательных: живой язык, юмор, личный опыт'],
        ];

        for (const row of seeds) {
            await connectionPool.execute(
                `INSERT IGNORE INTO ai_skills (user_email, name, slug, category_slug, category_name, short_desc, system_prompt, is_public, is_active)
                 VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1)`,
                row
            );
        }
        console.log(`[MYSQL] Seeded ${seeds.length} initial skills`);
    } catch (e) {
        console.error('[MYSQL] seedInitialSkillsIfEmpty error:', e.message);
    }
}

/**
 * Получить навык по slug
 * @param {string} slug - Slug навыка
 * @returns {Promise<Object|null>}
 */
async function getSkillBySlug(slug) {
    try {
        const result = await query(
            `SELECT * FROM ai_skills WHERE slug = ? AND is_active = 1 LIMIT 1`,
            [slug]
        );
        return (result.data && result.data.length > 0) ? result.data[0] : null;
    } catch (e) {
        console.error('[MYSQL] getSkillBySlug error:', e.message);
        return null;
    }
}

module.exports = {
    initPool,
    query,
    getUserSkills,
    getAllPublicSkills,
    getUserPrivateSkills,
    selectSkill,
    deselectSkill,
    getSelectedSkillIds,
    saveSkill,
    deleteSkill,
    checkConnection,
    closePool,
    getSkillBySlug
};
