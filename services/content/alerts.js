/**
 * TASK-014: Алерты на критические сбои
 */
const repository = require('./repository');

// Пороги для алертов
const ALERT_THRESHOLDS = {
  consecutiveFailures: 3, // N подряд фейлов → алерт
  noSuccessHours: 24, // N часов без успешных публикаций → алерт
  queueBacklog: 10, // N задач в очереди → предупреждение
  stuckJobsHours: 1, // N часов "застрявших" задач → алерт
  // Facebook-specific пороги
  facebookConsecutiveFailures: 3,
  facebookQueueBacklog: 10,
  facebookRateLimit: 1
};

// Кэш состояния для отслеживания подряд идущих фейлов
const failureCache = new Map(); // chatId -> { count, lastAlertAt }

/**
 * Проверить состояние и сгенерировать алерты
 * @param {string} chatId
 * @param {object} options
 * @param {object} options.bot - Telegram bot instance
 * @param {string} options.moderatorUserId - ID модератора для отправки алертов
 * @returns {Promise<{alerts: Array, warnings: Array}>}
 */
async function checkAndAlert(chatId, options = {}) {
  const { bot, moderatorUserId } = options;
  const alerts = [];
  const warnings = [];

  // 1. Проверка подряд идущих фейлов
  const failuresResult = await checkConsecutiveFailures(chatId);
  if (failuresResult.count >= ALERT_THRESHOLDS.consecutiveFailures) {
    const alert = {
      type: 'consecutive_failures',
      severity: 'critical',
      message: `${failuresResult.count} подряд неудачных попыток публикации`,
      details: failuresResult.lastErrors
    };
    alerts.push(alert);

    // Отправляем уведомление модератору
    if (bot && moderatorUserId) {
      await sendAlertToModerator(bot, moderatorUserId, alert);
    }
  }

  // 2. Проверка длительного отсутствия успешных публикаций
  const noSuccessResult = await checkNoSuccessPeriod(chatId);
  if (noSuccessResult.hours >= ALERT_THRESHOLDS.noSuccessHours) {
    const alert = {
      type: 'no_success_period',
      severity: 'warning',
      message: `Нет успешных публикаций ${noSuccessResult.hours} часов`,
      lastSuccessAt: noSuccessResult.lastSuccessAt
    };
    alerts.push(alert);

    if (bot && moderatorUserId) {
      await sendAlertToModerator(bot, moderatorUserId, alert);
    }
  }

  // 3. Проверка очереди
  const queueResult = await checkQueueBacklog(chatId);
  if (queueResult.backlog >= ALERT_THRESHOLDS.queueBacklog) {
    warnings.push({
      type: 'queue_backlog',
      message: `В очереди ${queueResult.backlog} задач`,
      details: queueResult.stats
    });
  }

  // 4. Проверка "застрявших" задач
  const stuckResult = await checkStuckJobs(chatId);
  if (stuckResult.count > 0) {
    const alert = {
      type: 'stuck_jobs',
      severity: 'warning',
      message: `${stuckResult.count} задач "застряли" в processing`,
      details: stuckResult.jobs
    };
    warnings.push(alert);
  }

  // 5. Facebook-specific проверки
  const fbFailuresResult = await checkFacebookConsecutiveFailures(chatId);
  if (fbFailuresResult.count >= ALERT_THRESHOLDS.facebookConsecutiveFailures) {
    const alert = {
      type: 'facebook_consecutive_failures',
      severity: 'critical',
      message: `Facebook: ${fbFailuresResult.count} подряд неудачных публикаций`,
      details: fbFailuresResult.lastErrors
    };
    alerts.push(alert);

    if (bot && moderatorUserId) {
      await sendAlertToModerator(bot, moderatorUserId, alert);
    }
  }

  const fbQueueResult = await checkFacebookQueueBacklog(chatId);
  if (fbQueueResult.backlog >= ALERT_THRESHOLDS.facebookQueueBacklog) {
    warnings.push({
      type: 'facebook_queue_backlog',
      message: `Facebook: в очереди ${fbQueueResult.backlog} задач`,
      details: fbQueueResult.stats
    });
  }

  const fbRateLimitResult = await checkFacebookRateLimit(chatId);
  if (fbRateLimitResult.rateLimited) {
    warnings.push({
      type: 'facebook_rate_limit',
      message: 'Facebook: Rate limit от Buffer API',
      details: { resetAt: fbRateLimitResult.resetAt }
    });
  }

  return { alerts, warnings };
}

/**
 * Проверка подряд идущих фейлов
 */
async function checkConsecutiveFailures(chatId) {
  return repository.withClient(chatId, async (client) => {
    const result = await client.query(
      `SELECT status, error_text, created_at
       FROM publish_logs
       WHERE created_at >= NOW() - INTERVAL '24 hours'
       ORDER BY created_at DESC
       LIMIT 20`
    );

    let count = 0;
    const lastErrors = [];

    for (const row of result.rows) {
      if (row.status === 'failed') {
        count++;
        if (lastErrors.length < 3) {
          lastErrors.push({
            error: row.error_text,
            at: row.created_at
          });
        }
      } else if (row.status === 'published') {
        break; // Прерываем серию фейлов
      }
    }

    return { count, lastErrors };
  });
}

/**
 * Проверка периода без успешных публикаций
 */
async function checkNoSuccessPeriod(chatId) {
  return repository.withClient(chatId, async (client) => {
    const result = await client.query(
      `SELECT created_at
       FROM publish_logs
       WHERE status = 'published'
       ORDER BY created_at DESC
       LIMIT 1`
    );

    if (result.rows.length === 0) {
      // Успешных публикаций никогда не было — возвращаем 0 часов
      // (чтобы не триггерить алерт сразу, даём время на первую публикацию)
      return { hours: 0, lastSuccessAt: null };
    }

    const lastSuccessAt = result.rows[0].created_at;
    const hoursSince = (Date.now() - new Date(lastSuccessAt).getTime()) / (1000 * 60 * 60);

    return {
      hours: Math.round(hoursSince),
      lastSuccessAt
    };
  });
}

/**
 * Проверка backlog очереди
 */
async function checkQueueBacklog(chatId) {
  const queueRepo = require('./queue.repository');
  
  try {
    const stats = await queueRepo.getQueueStats(chatId);
    return {
      backlog: stats.queued + stats.processing,
      stats
    };
  } catch (e) {
    return { backlog: 0, stats: {} };
  }
}

/**
 * Проверка застрявших задач
 */
async function checkStuckJobs(chatId) {
  const queueRepo = require('./queue.repository');

  try {
    const jobs = await queueRepo.getStuckJobs(chatId, ALERT_THRESHOLDS.stuckJobsHours);
    return {
      count: jobs.length,
      jobs: jobs.slice(0, 5).map(j => ({
        id: j.id,
        type: j.job_type,
        startedAt: j.started_at
      }))
    };
  } catch (e) {
    return { count: 0, jobs: [] };
  }
}

/**
 * Проверка подряд идущих Facebook-фейлов
 */
async function checkFacebookConsecutiveFailures(chatId) {
  try {
    const fbRepo = require('./facebook.repository');
    const consecutive = await fbRepo.getConsecutiveFailures(chatId);

    // Получаем последние ошибки
    const lastErrors = await repository.withClient(chatId, async (client) => {
      const result = await client.query(
        `SELECT error_text, created_at
         FROM facebook_publish_logs
         WHERE status = 'failed'
         ORDER BY created_at DESC
         LIMIT 3`
      );
      return result.rows.map(r => ({
        error: r.error_text,
        at: r.created_at
      }));
    });

    return { count: consecutive, lastErrors };
  } catch (e) {
    console.error('[ALERTS] checkFacebookConsecutiveFailures:', e);
    return { count: 0, lastErrors: [] };
  }
}

/**
 * Проверка backlog очереди Facebook
 */
async function checkFacebookQueueBacklog(chatId) {
  try {
    const fbRepo = require('./facebook.repository');
    const backlog = await fbRepo.getQueueBacklog(chatId);
    return {
      backlog,
      stats: { queued: backlog, platform: 'facebook' }
    };
  } catch (e) {
    console.error('[ALERTS] checkFacebookQueueBacklog:', e);
    return { backlog: 0, stats: {} };
  }
}

/**
 * Проверка Rate Limit для Facebook (проверка по ошибкам)
 */
async function checkFacebookRateLimit(chatId) {
  try {
    const fbRepo = require('./facebook.repository');
    const lastErrors = await repository.withClient(chatId, async (client) => {
      const result = await client.query(
        `SELECT error_text, created_at
         FROM facebook_publish_logs
         WHERE status = 'failed'
           AND (error_text ILIKE '%rate%' OR error_text ILIKE '%429%')
         ORDER BY created_at DESC
         LIMIT 1`
      );
      return result.rows;
    });

    if (lastErrors.length > 0) {
      const lastError = lastErrors[0];
      const minutesSince = (Date.now() - new Date(lastError.created_at).getTime()) / (1000 * 60);
      // Rate limit действует обычно 15-60 минут
      if (minutesSince < 60) {
        return {
          rateLimited: true,
          resetAt: new Date(new Date(lastError.created_at).getTime() + 15 * 60 * 1000).toISOString()
        };
      }
    }

    return { rateLimited: false };
  } catch (e) {
    console.error('[ALERTS] checkFacebookRateLimit:', e);
    return { rateLimited: false };
  }
}

/**
 * Отправить алерт модератору
 */
async function sendAlertToModerator(bot, moderatorUserId, alert) {
  const cacheKey = `${moderatorUserId}:${alert.type}`;
  const cached = failureCache.get(cacheKey);
  
  // Не спамим — отправляем не чаще раза в час
  if (cached && Date.now() - cached.lastAlertAt < 60 * 60 * 1000) {
    return;
  }

  const severityEmoji = alert.severity === 'critical' ? '🚨' : '⚠️';
  const message = [
    `${severityEmoji} <b>Алерт контент-пайплайна</b>`,
    '',
    `<b>Тип:</b> ${alert.type}`,
    `<b>Сообщение:</b> ${alert.message}`
  ];

  if (alert.details && Array.isArray(alert.details) && alert.details.length > 0) {
    message.push('', '<b>Последние ошибки:</b>');
    for (const d of alert.details.slice(0, 3)) {
      message.push(`• ${d.error || 'нет описания'}`);
    }
  }

  try {
    await bot.telegram.sendMessage(moderatorUserId, message.join('\n'), { parse_mode: 'HTML' });
    failureCache.set(cacheKey, { lastAlertAt: Date.now() });
  } catch (e) {
    console.error('[CONTENT-ALERTS] Failed to send alert:', e.message);
  }
}

/**
 * Сбросить кэш алертов (для тестирования)
 */
function resetAlertCache() {
  failureCache.clear();
}

/**
 * Записать событие для мониторинга
 */
async function recordEvent(chatId, eventType, data = {}) {
  // Можно расширить для записи в отдельную таблицу мониторинга
  console.log(`[CONTENT-MONITOR] ${chatId} ${eventType}:`, JSON.stringify(data));
}

module.exports = {
  checkAndAlert,
  checkConsecutiveFailures,
  checkNoSuccessPeriod,
  checkQueueBacklog,
  checkStuckJobs,
  checkFacebookConsecutiveFailures,
  checkFacebookQueueBacklog,
  checkFacebookRateLimit,
  sendAlertToModerator,
  resetAlertCache,
  recordEvent,
  ALERT_THRESHOLDS
};
