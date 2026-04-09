/**
 * Репозиторий для facebook_jobs, facebook_publish_logs
 */
const { Client } = require('pg');
const config = require('../../config');

function getDbName(chatId) {
  return `db_${String(chatId).replace(/[^a-z0-9_]/gi, '_').toLowerCase()}`;
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
 * Создать/обновить схему БД для Facebook
 */
async function ensureSchema(chatId) {
  return withClient(chatId, async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS facebook_jobs (
        id BIGSERIAL PRIMARY KEY,
        chat_id TEXT NOT NULL,
        topic TEXT NOT NULL,
        focus TEXT,
        post_text TEXT,
        image_prompt TEXT,
        image_path TEXT,
        status TEXT NOT NULL DEFAULT 'draft',
        error_text TEXT,
        image_attempts INT NOT NULL DEFAULT 0,
        rejected_count INT NOT NULL DEFAULT 0,
        buffer_post_id TEXT,
        buffer_channel_id TEXT,
        correlation_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT facebook_jobs_status_check CHECK (
          status IN ('draft', 'media_generating', 'ready', 'approved', 'published', 'failed')
        )
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_facebook_jobs_status
      ON facebook_jobs(status, created_at)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_facebook_jobs_chat_id
      ON facebook_jobs(chat_id, created_at DESC)
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS facebook_publish_logs (
        id BIGSERIAL PRIMARY KEY,
        job_id BIGINT REFERENCES facebook_jobs(id) ON DELETE SET NULL,
        buffer_channel_id TEXT NOT NULL,
        buffer_post_id TEXT,
        status TEXT NOT NULL,
        error_text TEXT,
        correlation_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_fb_logs_job_id
      ON facebook_publish_logs(job_id)
    `);
  });
}

/**
 * Создать задачу Facebook
 */
async function createJob(chatId, data) {
  return withClient(chatId, async (client) => {
    const result = await client.query(
      `INSERT INTO facebook_jobs
        (chat_id, topic, focus, post_text, image_prompt, image_path, status, image_attempts, rejected_count, correlation_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [
        chatId,
        data.topic || '',
        data.focus || null,
        data.postText || null,
        data.imagePrompt || null,
        data.imagePath || null,
        data.status || 'draft',
        data.imageAttempts || 0,
        data.rejectedCount || 0,
        data.correlationId || null
      ]
    );
    return result.rows[0].id;
  });
}

/**
 * Обновить задачу Facebook
 */
async function updateJob(chatId, jobId, data) {
  return withClient(chatId, async (client) => {
    const fields = [];
    const values = [];
    let idx = 1;

    const map = {
      topic: 'topic',
      focus: 'focus',
      postText: 'post_text',
      imagePrompt: 'image_prompt',
      imagePath: 'image_path',
      status: 'status',
      errorText: 'error_text',
      imageAttempts: 'image_attempts',
      rejectedCount: 'rejected_count',
      bufferPostId: 'buffer_post_id',
      bufferChannelId: 'buffer_channel_id',
      correlationId: 'correlation_id'
    };

    for (const [jsKey, dbCol] of Object.entries(map)) {
      if (data[jsKey] !== undefined) {
        fields.push(`${dbCol} = $${idx++}`);
        values.push(data[jsKey]);
      }
    }

    if (fields.length === 0) return;

    fields.push('updated_at = NOW()');
    values.push(jobId);

    await client.query(
      `UPDATE facebook_jobs SET ${fields.join(', ')} WHERE id = $${idx}`,
      values
    );
  });
}

/**
 * Получить задачу по ID
 */
async function getJobById(chatId, jobId) {
  return withClient(chatId, async (client) => {
    const result = await client.query(
      'SELECT * FROM facebook_jobs WHERE id = $1',
      [jobId]
    );
    return result.rows[0] || null;
  });
}

/**
 * Список задач с фильтрацией
 */
async function listJobs(chatId, options = {}) {
  const status = options.status ? String(options.status).trim().toLowerCase() : null;
  const limit = Math.min(Math.max(parseInt(options.limit, 10) || 50, 1), 200);
  const offset = Math.max(parseInt(options.offset, 10) || 0, 0);

  return withClient(chatId, async (client) => {
    const params = [];
    let where = '';
    if (status) {
      params.push(status);
      where = `WHERE LOWER(status) = $${params.length}`;
    }
    params.push(limit);
    const limitPos = params.length;
    params.push(offset);
    const offsetPos = params.length;

    const rows = await client.query(
      `SELECT * FROM facebook_jobs ${where}
       ORDER BY created_at DESC
       LIMIT $${limitPos} OFFSET $${offsetPos}`,
      params
    );
    const totalRes = await client.query(
      `SELECT COUNT(*)::int AS total FROM facebook_jobs ${where}`,
      status ? [status] : []
    );
    return {
      total: totalRes.rows[0]?.total || 0,
      items: rows.rows
    };
  });
}

/**
 * Добавить лог публикации
 */
async function addPublishLog(chatId, data) {
  return withClient(chatId, async (client) => {
    const result = await client.query(
      `INSERT INTO facebook_publish_logs
        (job_id, buffer_channel_id, buffer_post_id, status, error_text, correlation_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        data.jobId || null,
        data.bufferChannelId || null,
        data.bufferPostId || null,
        data.status,
        data.errorText || null,
        data.correlationId || null
      ]
    );
    return result.rows[0].id;
  });
}

/**
 * Посчитать опубликованные сегодня
 */
async function countPublishedToday(chatId, tz = 'Europe/Moscow') {
  const dateStr = new Intl.DateTimeFormat('sv-SE', { timeZone: tz }).format(new Date());
  return withClient(chatId, async (client) => {
    const result = await client.query(
      `SELECT COUNT(*)::int AS c
       FROM facebook_publish_logs
       WHERE status = 'published'
         AND to_char(created_at AT TIME ZONE $1, 'YYYY-MM-DD') = $2`,
      [tz, dateStr]
    );
    return result.rows[0]?.c || 0;
  });
}

/**
 * Отметить задачу как опубликованную
 */
async function markPublished(chatId, jobId, postId, bufferChannelId) {
  return withClient(chatId, async (client) => {
    await client.query(
      `UPDATE facebook_jobs
       SET status = 'published', buffer_post_id = $1, buffer_channel_id = $2, updated_at = NOW()
       WHERE id = $3`,
      [postId || null, bufferChannelId || null, jobId]
    );
    await client.query(
      `INSERT INTO facebook_publish_logs
        (job_id, buffer_channel_id, buffer_post_id, status, created_at)
       VALUES ($1, $2, $3, 'published', NOW())`,
      [jobId, bufferChannelId || null, postId || null]
    );
  });
}

/**
 * Получить последние неудачные задачи подряд
 */
async function getConsecutiveFailures(chatId) {
  return withClient(chatId, async (client) => {
    const result = await client.query(
      `SELECT id, status, error_text, created_at
       FROM facebook_jobs
       WHERE chat_id = $1
       ORDER BY created_at DESC
       LIMIT 10`,
      [chatId]
    );

    let consecutive = 0;
    for (const job of result.rows) {
      if (job.status === 'failed') {
        consecutive++;
      } else {
        break;
      }
    }
    return consecutive;
  });
}

/**
 * Получить количество задач в очереди (статус не failed/published)
 */
async function getQueueBacklog(chatId) {
  return withClient(chatId, async (client) => {
    const result = await client.query(
      `SELECT COUNT(*)::int AS c
       FROM facebook_jobs
       WHERE chat_id = $1
         AND status NOT IN ('failed', 'published')`,
      [chatId]
    );
    return result.rows[0]?.c || 0;
  });
}

module.exports = {
  withClient,
  ensureSchema,
  createJob,
  updateJob,
  getJobById,
  listJobs,
  addPublishLog,
  countPublishedToday,
  markPublished,
  getConsecutiveFailures,
  getQueueBacklog
};
