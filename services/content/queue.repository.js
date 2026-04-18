/**
 * TASK-006: Репозиторий для работы с очередью задач в БД
 * OPTIMIZATION: Connection pooling для производительности
 */
const { Client, Pool } = require('pg');
const config = require('../../config');
const { QUEUE_STATUS } = require('./status');

const MAX_ATTEMPTS = 5;
const BACKOFF_BASE_MS = 5000; // 5 сек
const BACKOFF_MAX_MS = 300000; // 5 минут

// Connection pool cache для избежания создания новых соединений
const poolCache = new Map();
const POOL_IDLE_TIMEOUT_MS = 30000; // 30 сек

function getDbName(chatId) {
  return `db_${String(chatId).replace(/[^a-z0-9_]/gi, '_').toLowerCase()}`;
}

/**
 * Получить или создать connection pool для chatId
 */
function getPool(chatId) {
  if (!poolCache.has(chatId)) {
    const pool = new Pool({
      host: config.PG_ADMIN_HOST || config.PG_HOST,
      port: config.PG_PORT,
      user: config.PG_USER,
      password: config.PG_PASSWORD,
      database: getDbName(chatId),
      ssl: false,
      max: 10, // Максимум 10 соединений в пуле
      idleTimeoutMillis: POOL_IDLE_TIMEOUT_MS,
      connectionTimeoutMillis: 5000
    });
    
    // Очистка пула после простоя
    const cleanupTimer = setTimeout(() => {
      if (poolCache.get(chatId) === pool) {
        pool.end().catch(() => {});
        poolCache.delete(chatId);
      }
    }, POOL_IDLE_TIMEOUT_MS * 2);
    cleanupTimer.unref();
    
    poolCache.set(chatId, pool);
  }
  
  return poolCache.get(chatId);
}

function getDbClient(chatId) {
  return new Client({
    host: config.PG_ADMIN_HOST || config.PG_HOST,
    port: config.PG_PORT,
    user: config.PG_USER,
    password: config.PG_PASSWORD,
    database: getDbName(chatId),
    ssl: false,
    connectionTimeoutMillis: 5000
  });
}

async function withClient(chatId, fn) {
  const client = getDbClient(chatId);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * Выполнить операцию с использованием connection pool
 */
async function withPoolClient(chatId, fn) {
  const pool = getPool(chatId);
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

/**
 * Создать таблицу очереди, если не существует
 */
async function ensureQueueSchema(chatId) {
  return withClient(chatId, async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS content_job_queue (
        id BIGSERIAL PRIMARY KEY,
        chat_id TEXT NOT NULL,
        job_type TEXT NOT NULL,
        job_id BIGINT,
        priority INT NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'queued',
        attempts INT NOT NULL DEFAULT 0,
        max_attempts INT NOT NULL DEFAULT 5,
        next_run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        started_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        error_text TEXT,
        payload JSONB,
        correlation_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_content_job_queue_poll
      ON content_job_queue (chat_id, status, next_run_at)
      WHERE status = 'queued';
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_content_job_queue_processing
      ON content_job_queue (chat_id, status, started_at)
      WHERE status = 'processing';
    `);
  });
}

/**
 * Поставить задачу в очередь
 * @param {string} chatId
 * @param {object} options
 * @param {string} options.jobType - тип задачи (generate, approve, publish)
 * @param {number} [options.jobId] - ID связанной content_jobs записи
 * @param {number} [options.priority] - приоритет (выше = раньше)
 * @param {object} [options.payload] - дополнительные данные
 * @param {string} [options.correlationId] - ID для трассировки
 * @param {Date} [options.runAt] - когда запустить (default: now)
 */
async function enqueue(chatId, options) {
  const {
    jobType,
    jobId = null,
    priority = 0,
    payload = null,
    correlationId = null,
    runAt = new Date()
  } = options;

  return withPoolClient(chatId, async (client) => {
    const result = await client.query(
      `INSERT INTO content_job_queue
        (chat_id, job_type, job_id, priority, payload, correlation_id, next_run_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [chatId, jobType, jobId, priority, JSON.stringify(payload), correlationId, runAt]
    );
    return result.rows[0].id;
  });
}

/**
 * Забрать следующую задачу из очереди (poll + claim)
 * @param {string} chatId
 * @param {number} [limit] - макс. количество задач за раз
 * @returns {Array<object>} список задач со статусом 'processing'
 */
async function pollNextJobs(chatId, limit = 1) {
  return withPoolClient(chatId, async (client) => {
    await client.query('BEGIN');
    try {
      const result = await client.query(
        `UPDATE content_job_queue
         SET status = $1,
             started_at = NOW(),
             attempts = attempts + 1,
             updated_at = NOW()
         WHERE id IN (
           SELECT id FROM content_job_queue
           WHERE chat_id = $2
             AND status = $3
             AND next_run_at <= NOW()
           ORDER BY priority DESC, created_at ASC
           LIMIT $4
           FOR UPDATE SKIP LOCKED
         )
         RETURNING *`,
        [QUEUE_STATUS.PROCESSING, chatId, QUEUE_STATUS.QUEUED, limit]
      );
      await client.query('COMMIT');
      return result.rows;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    }
  });
}

/**
 * Отметить задачу как выполненную
 */
async function markDone(chatId, queueId) {
  return withPoolClient(chatId, async (client) => {
    await client.query(
      `UPDATE content_job_queue
       SET status = $1,
           completed_at = NOW(),
           updated_at = NOW()
       WHERE id = $2`,
      [QUEUE_STATUS.DONE, queueId]
    );
  });
}

/**
 * Отметить задачу как failed с backoff retry
 */
async function markFailed(chatId, queueId, errorMessage, retry = true) {
  return withPoolClient(chatId, async (client) => {
    const job = await client.query(
      `SELECT attempts, max_attempts FROM content_job_queue WHERE id = $1`,
      [queueId]
    );
    if (!job.rows[0]) return;

    const { attempts, max_attempts } = job.rows[0];
    const canRetry = retry && attempts < max_attempts;

    if (canRetry) {
      // Exponential backoff
      const backoffMs = Math.min(
        BACKOFF_BASE_MS * Math.pow(2, attempts - 1),
        BACKOFF_MAX_MS
      );
      const nextRunAt = new Date(Date.now() + backoffMs);

      await client.query(
        `UPDATE content_job_queue
         SET status = $1,
             error_text = $2,
             next_run_at = $3,
             started_at = NULL,
             updated_at = NOW()
         WHERE id = $4`,
        [QUEUE_STATUS.QUEUED, errorMessage, nextRunAt, queueId]
      );
    } else {
      await client.query(
        `UPDATE content_job_queue
         SET status = $1,
             error_text = $2,
             completed_at = NOW(),
             updated_at = NOW()
         WHERE id = $3`,
        [QUEUE_STATUS.FAILED, errorMessage, queueId]
      );
    }
  });
}

/**
 * Получить "застрявшие" задачи (processing слишком долго)
 */
async function getStuckJobs(chatId, timeoutMinutes = 10) {
  return withPoolClient(chatId, async (client) => {
    const result = await client.query(
      `SELECT * FROM content_job_queue
       WHERE chat_id = $1
         AND status = $2
         AND started_at < NOW() - INTERVAL '${timeoutMinutes} minutes'`,
      [chatId, QUEUE_STATUS.PROCESSING]
    );
    return result.rows;
  });
}

/**
 * Сбросить застрявшие задачи обратно в очередь
 */
async function resetStuckJobs(chatId, timeoutMinutes = 10) {
  return withPoolClient(chatId, async (client) => {
    const result = await client.query(
      `UPDATE content_job_queue
       SET status = $1,
           started_at = NULL,
           error_text = 'Reset after timeout',
           updated_at = NOW()
       WHERE chat_id = $2
         AND status = $3
         AND started_at < NOW() - INTERVAL '${timeoutMinutes} minutes'
       RETURNING id`,
      [QUEUE_STATUS.QUEUED, chatId, QUEUE_STATUS.PROCESSING]
    );
    return result.rowCount;
  });
}

/**
 * Получить статистику очереди
 */
async function getQueueStats(chatId) {
  return withPoolClient(chatId, async (client) => {
    const result = await client.query(
      `SELECT status, COUNT(*)::int as count
       FROM content_job_queue
       WHERE chat_id = $1
       GROUP BY status`,
      [chatId]
    );
    const stats = {
      queued: 0,
      processing: 0,
      done: 0,
      failed: 0
    };
    for (const row of result.rows) {
      if (stats.hasOwnProperty(row.status)) {
        stats[row.status] = row.count;
      }
    }
    return stats;
  });
}

module.exports = {
  ensureQueueSchema,
  enqueue,
  pollNextJobs,
  markDone,
  markFailed,
  getStuckJobs,
  resetStuckJobs,
  getQueueStats,
  withPoolClient,
  withClient,
  MAX_ATTEMPTS,
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS
};
