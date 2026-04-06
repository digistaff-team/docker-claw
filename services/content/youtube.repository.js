/**
 * Репозиторий для youtube_jobs и youtube_publish_logs
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

async function ensureSchema(chatId) {
  return withClient(chatId, async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS youtube_jobs (
        id BIGSERIAL PRIMARY KEY,
        chat_id TEXT NOT NULL,
        topic TEXT NOT NULL,
        video_title TEXT,
        video_description TEXT,
        tags TEXT,
        thumbnail_prompt TEXT,
        thumbnail_path TEXT,
        video_path TEXT,
        video_url TEXT,
        link TEXT,
        status TEXT NOT NULL DEFAULT 'draft',
        error_text TEXT,
        thumbnail_attempts INT NOT NULL DEFAULT 0,
        rejected_count INT NOT NULL DEFAULT 0,
        correlation_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_youtube_jobs_status ON youtube_jobs(status)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_youtube_jobs_chat_id ON youtube_jobs(chat_id)
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS youtube_publish_logs (
        id BIGSERIAL PRIMARY KEY,
        job_id BIGINT REFERENCES youtube_jobs(id) ON DELETE SET NULL,
        buffer_post_id TEXT,
        status TEXT NOT NULL,
        error_text TEXT,
        correlation_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  });
}

async function createJob(chatId, data) {
  return withClient(chatId, async (client) => {
    const result = await client.query(
      `INSERT INTO youtube_jobs
        (chat_id, topic, video_title, video_description, tags, thumbnail_prompt,
         thumbnail_path, video_path, video_url, link, status, thumbnail_attempts,
         rejected_count, correlation_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING id`,
      [
        chatId,
        data.topic,
        data.videoTitle || null,
        data.videoDescription || null,
        data.tags ? JSON.stringify(data.tags) : null,
        data.thumbnailPrompt || null,
        data.thumbnailPath || null,
        data.videoPath || null,
        data.videoUrl || null,
        data.link || null,
        data.status || 'draft',
        data.thumbnailAttempts || 0,
        data.rejectedCount || 0,
        data.correlationId || null
      ]
    );
    return result.rows[0].id;
  });
}

async function updateJob(chatId, jobId, data) {
  return withClient(chatId, async (client) => {
    const fields = [];
    const values = [];
    let idx = 1;

    const map = {
      topic: 'topic',
      videoTitle: 'video_title',
      videoDescription: 'video_description',
      tags: 'tags',
      thumbnailPrompt: 'thumbnail_prompt',
      thumbnailPath: 'thumbnail_path',
      videoPath: 'video_path',
      videoUrl: 'video_url',
      link: 'link',
      status: 'status',
      errorText: 'error_text',
      thumbnailAttempts: 'thumbnail_attempts',
      rejectedCount: 'rejected_count',
      correlationId: 'correlation_id'
    };

    for (const [jsKey, dbCol] of Object.entries(map)) {
      if (data[jsKey] !== undefined) {
        // tags — JSON, сохраняем как есть если это уже строка
        let val = data[jsKey];
        if (jsKey === 'tags' && Array.isArray(val)) {
          val = JSON.stringify(val);
        }
        fields.push(`${dbCol} = $${idx++}`);
        values.push(val);
      }
    }

    if (fields.length === 0) return;

    fields.push('updated_at = NOW()');
    values.push(jobId);

    await client.query(
      `UPDATE youtube_jobs SET ${fields.join(', ')} WHERE id = $${idx}`,
      values
    );
  });
}

async function getJobById(chatId, jobId) {
  return withClient(chatId, async (client) => {
    const result = await client.query(
      'SELECT * FROM youtube_jobs WHERE id = $1',
      [jobId]
    );
    const row = result.rows[0] || null;
    if (row && row.tags && typeof row.tags === 'string') {
      try { row.tags = JSON.parse(row.tags); } catch { /* leave as string */ }
    }
    return row;
  });
}

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
      `SELECT * FROM youtube_jobs ${where}
       ORDER BY created_at DESC
       LIMIT $${limitPos} OFFSET $${offsetPos}`,
      params
    );
    const totalRes = await client.query(
      `SELECT COUNT(*)::int AS total FROM youtube_jobs ${where}`,
      status ? [status] : []
    );

    const items = rows.rows.map(row => {
      if (row.tags && typeof row.tags === 'string') {
        try { row.tags = JSON.parse(row.tags); } catch { /* leave as string */ }
      }
      return row;
    });

    return {
      total: totalRes.rows[0]?.total || 0,
      items
    };
  });
}

async function addPublishLog(chatId, data) {
  return withClient(chatId, async (client) => {
    const result = await client.query(
      `INSERT INTO youtube_publish_logs
        (job_id, buffer_post_id, status, error_text, correlation_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [
        data.jobId || null,
        data.bufferPostId || null,
        data.status,
        data.errorText || null,
        data.correlationId || null
      ]
    );
    return result.rows[0].id;
  });
}

async function countPublishedToday(chatId, tz = 'Europe/Moscow') {
  const dateStr = new Intl.DateTimeFormat('sv-SE', { timeZone: tz }).format(new Date());
  return withClient(chatId, async (client) => {
    const result = await client.query(
      `SELECT COUNT(*)::int AS c
       FROM youtube_publish_logs
       WHERE status = 'published'
         AND to_char(created_at AT TIME ZONE $1, 'YYYY-MM-DD') = $2`,
      [tz, dateStr]
    );
    return result.rows[0]?.c || 0;
  });
}

async function getPool(chatId) {
  // Возвращаем функцию-фабрику для совместимости с некоторыми паттернами
  return {
    query: (text, params) => {
      const client = getDbClient(chatId);
      return client.connect().then(() =>
        client.query(text, params).finally(() => client.end().catch(() => {}))
      );
    }
  };
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
  getPool
};
