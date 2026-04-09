/**
 * TASK-012: Лимиты стоимости и дневные квоты
 */
const repository = require('./repository');
const { generateCorrelationId } = require('./status');

// Дефолтные лимиты
const DEFAULT_SOFT_LIMIT = 5; // Предупреждение
const DEFAULT_HARD_LIMIT = 10; // Блокировка
const DEFAULT_DAILY_LIMIT = 10; // Максимум публикаций в день
const DEFAULT_BLOG_DAILY_LIMIT = 3; // Лимит статей в день

// Квоты по типам операций
const QUOTA_TYPES = {
  TEXT_GENERATION: 'text_generation',
  IMAGE_GENERATION: 'image_generation',
  VIDEO_GENERATION: 'video_generation', // TASK-015
  PUBLICATION: 'publication',
  BLOG_GENERATION: 'blog_generation',
  FACEBOOK_PUBLICATION: 'facebook_publication'
};

/**
 * Получить лимиты для чата
 * @param {string} chatId
 * @param {object} settings - настройки из getContentSettings
 * @returns {object}
 */
function getLimits(chatId, settings = {}) {
  return {
    softLimit: settings.softLimit || DEFAULT_SOFT_LIMIT,
    hardLimit: settings.hardLimit || DEFAULT_HARD_LIMIT,
    dailyLimit: settings.dailyLimit || DEFAULT_DAILY_LIMIT,
    textQuota: settings.textQuota || 50, // текстовых генераций в день
    imageQuota: settings.imageQuota || 20, // генераций изображений в день
    videoQuota: settings.videoQuota || 10, // TASK-015: генераций видео в день
    blogDailyQuota: settings.blogDailyQuota || DEFAULT_BLOG_DAILY_LIMIT // статей в день
  };
}

/**
 * Получить использование за сегодня
 * @param {string} chatId
 * @param {string} dateStr - дата в формате YYYY-MM-DD
 * @param {string} tz - часовой пояс
 * @returns {Promise<{published: number, textGenerated: number, imageGenerated: number, videoGenerated: number}>}
 */
async function getTodayUsage(chatId, dateStr, tz = 'Europe/Moscow') {
  return repository.withClient(chatId, async (client) => {
    // Публикации
    const publishedRes = await client.query(
      `SELECT COUNT(*)::int AS c FROM publish_logs
       WHERE status = 'published'
         AND to_char(created_at AT TIME ZONE $1, 'YYYY-MM-DD') = $2`,
      [tz, dateStr]
    );

    // Генерации текста (по количеству созданных jobs)
    const textRes = await client.query(
      `SELECT COUNT(*)::int AS c FROM content_jobs
       WHERE draft_text IS NOT NULL
         AND to_char(created_at AT TIME ZONE $1, 'YYYY-MM-DD') = $2`,
      [tz, dateStr]
    );

    // Генерации изображений (по количеству assets типа image)
    const imageRes = await client.query(
      `SELECT COUNT(*)::int AS c FROM content_assets a
       JOIN content_jobs j ON j.id = a.job_id
       WHERE a.asset_type = 'image'
         AND to_char(a.created_at AT TIME ZONE $1, 'YYYY-MM-DD') = $2`,
      [tz, dateStr]
    );

    // TASK-015: Генерации видео
    const videoRes = await client.query(
      `SELECT COUNT(*)::int AS c FROM content_assets a
       JOIN content_jobs j ON j.id = a.job_id
       WHERE a.asset_type = 'video'
         AND to_char(a.created_at AT TIME ZONE $1, 'YYYY-MM-DD') = $2`,
      [tz, dateStr]
    );

    // WordPress blog generation
    const blogRes = await client.query(
      `SELECT COUNT(*)::int AS c FROM content_posts
       WHERE content_type = 'blog'
         AND to_char(created_at AT TIME ZONE $1, 'YYYY-MM-DD') = $2`,
      [tz, dateStr]
    );

    return {
      published: publishedRes.rows[0]?.c || 0,
      textGenerated: textRes.rows[0]?.c || 0,
      imageGenerated: imageRes.rows[0]?.c || 0,
      videoGenerated: videoRes.rows[0]?.c || 0,
      blogGenerated: blogRes.rows[0]?.c || 0,
      facebookPublished: 0 // TODO: добавить Facebook после миграции
    };
  });
}

/**
 * Проверить, можно ли выполнять операцию
 * @param {string} chatId
 * @param {string} operationType - тип операции из QUOTA_TYPES
 * @param {object} options
 * @param {string} options.dateStr - дата сегодня
 * @param {string} options.tz - часовой пояс
 * @param {object} options.settings - настройки чата
 * @returns {Promise<{allowed: boolean, reason?: string, warning?: string}>}
 */
async function checkQuota(chatId, operationType, options = {}) {
  const { dateStr, tz = 'Europe/Moscow', settings = {} } = options;
  const limits = getLimits(chatId, settings);
  const usage = await getTodayUsage(chatId, dateStr, tz);

  switch (operationType) {
    case QUOTA_TYPES.PUBLICATION: {
      if (usage.published >= limits.hardLimit) {
        return {
          allowed: false,
          reason: `Достигнут hard-лимит публикаций: ${usage.published}/${limits.hardLimit}`
        };
      }
      if (usage.published >= limits.softLimit) {
        return {
          allowed: true,
          warning: `Приближение к лимиту публикаций: ${usage.published}/${limits.hardLimit}`
        };
      }
      return { allowed: true };
    }

    case QUOTA_TYPES.TEXT_GENERATION: {
      if (usage.textGenerated >= limits.textQuota) {
        return {
          allowed: false,
          reason: `Достигнут лимит генераций текста: ${usage.textGenerated}/${limits.textQuota}`
        };
      }
      if (usage.textGenerated >= limits.textQuota * 0.8) {
        return {
          allowed: true,
          warning: `Приближение к лимиту генераций текста: ${usage.textGenerated}/${limits.textQuota}`
        };
      }
      return { allowed: true };
    }

    case QUOTA_TYPES.IMAGE_GENERATION: {
      if (usage.imageGenerated >= limits.imageQuota) {
        return {
          allowed: false,
          reason: `Достигнут лимит генераций изображений: ${usage.imageGenerated}/${limits.imageQuota}`
        };
      }
      if (usage.imageGenerated >= limits.imageQuota * 0.8) {
        return {
          allowed: true,
          warning: `Приближение к лимиту генераций изображений: ${usage.imageGenerated}/${limits.imageQuota}`
        };
      }
      return { allowed: true };
    }

    // TASK-015: Квота на генерацию видео
    case QUOTA_TYPES.VIDEO_GENERATION: {
      if (usage.videoGenerated >= limits.videoQuota) {
        return {
          allowed: false,
          reason: `Достигнут лимит генераций видео: ${usage.videoGenerated}/${limits.videoQuota}`
        };
      }
      if (usage.videoGenerated >= limits.videoQuota * 0.8) {
        return {
          allowed: true,
          warning: `Приближение к лимиту генераций видео: ${usage.videoGenerated}/${limits.videoQuota}`
        };
      }
      return { allowed: true };
    }

    // WordPress blog generation
    case QUOTA_TYPES.BLOG_GENERATION: {
      if (usage.blogGenerated >= limits.blogDailyQuota) {
        return {
          allowed: false,
          reason: `Достигнут лимит генераций статей: ${usage.blogGenerated}/${limits.blogDailyQuota}`
        };
      }
      if (usage.blogGenerated >= limits.blogDailyQuota * 0.8) {
        return {
          allowed: true,
          warning: `Приближение к лимиту генераций статей: ${usage.blogGenerated}/${limits.blogDailyQuota}`
        };
      }
      return { allowed: true };
    }

    // Facebook publication
    case QUOTA_TYPES.FACEBOOK_PUBLICATION: {
      const fbDailyLimit = 10; // TODO: брать из настроек Facebook
      if (usage.facebookPublished >= fbDailyLimit) {
        return {
          allowed: false,
          reason: `Достигнут дневной лимит Facebook публикаций: ${usage.facebookPublished}/${fbDailyLimit}`
        };
      }
      if (usage.facebookPublished >= fbDailyLimit * 0.8) {
        return {
          allowed: true,
          warning: `Приближение к лимиту Facebook публикаций: ${usage.facebookPublished}/${fbDailyLimit}`
        };
      }
      return { allowed: true };
    }

    default:
      return { allowed: true };
  }
}

/**
 * Получить статистику использования для отображения
 * @param {string} chatId
 * @param {string} dateStr
 * @param {string} tz
 * @returns {Promise<object>}
 */
async function getUsageStats(chatId, dateStr, tz = 'Europe/Moscow') {
  const usage = await getTodayUsage(chatId, dateStr, tz);

  return {
    today: {
      published: usage.published,
      textGenerated: usage.textGenerated,
      imageGenerated: usage.imageGenerated,
      videoGenerated: usage.videoGenerated, // TASK-015
      blogGenerated: usage.blogGenerated
    },
    limits: {
      softLimit: DEFAULT_SOFT_LIMIT,
      hardLimit: DEFAULT_HARD_LIMIT,
      dailyLimit: DEFAULT_DAILY_LIMIT,
      textQuota: 50,
      imageQuota: 20,
      videoQuota: 10, // TASK-015
      blogDailyQuota: DEFAULT_BLOG_DAILY_LIMIT
    },
    percentages: {
      published: Math.round((usage.published / DEFAULT_HARD_LIMIT) * 100),
      text: Math.round((usage.textGenerated / 50) * 100),
      image: Math.round((usage.imageGenerated / 20) * 100),
      video: Math.round((usage.videoGenerated / 10) * 100), // TASK-015
      blog: Math.round((usage.blogGenerated / DEFAULT_BLOG_DAILY_LIMIT) * 100),
      facebook: Math.round((usage.facebookPublished / 10) * 100)
    }
  };
}

/**
 * Middleware для проверки квоты перед операцией
 * @param {string} operationType
 * @param {Function} getSettings - функция для получения настроек чата
 * @returns {Function}
 */
function createQuotaMiddleware(operationType, getSettings) {
  return async (chatId, dateStr, tz) => {
    const settings = getSettings ? getSettings(chatId) : {};
    return checkQuota(chatId, operationType, { dateStr, tz, settings });
  };
}

module.exports = {
  getLimits,
  getTodayUsage,
  checkQuota,
  getUsageStats,
  createQuotaMiddleware,
  QUOTA_TYPES,
  DEFAULT_SOFT_LIMIT,
  DEFAULT_HARD_LIMIT,
  DEFAULT_DAILY_LIMIT,
  DEFAULT_BLOG_DAILY_LIMIT
};
