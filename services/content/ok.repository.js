/**
 * Репозиторий для ok_jobs и ok_publish_logs
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

async function createJob(chatId, data) {
  return withClient(chatId, async (client) => {
    const result = await client.query(
      `INSERT INTO ok_jobs
        (chat_id, topic, community_id, post_text, hook_text, image_prompt, image_path, video_path, ok_content_type, link, status, image_attempts, correlation_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING id`,
      [
        chatId,
        data.topic,
        data.communityId || null,
        data.postText || null,
        data.hookText || null,
        data.imagePrompt || null,
        data.imagePath || null,
        data.videoPath || null,
        data.okContentType || 'photo',
        data.link || null,
        data.status || 'draft',
        data.imageAttempts || 0,
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
      topic: 'topic', communityId: 'community_id', postText: 'post_text',
      hookText: 'hook_text', imagePrompt: 'image_prompt',
      imagePath: 'image_path', videoPath: 'video_path',
      okContentType: 'ok_content_type', link: 'link', status: 'status',
      errorText: 'error_text', imageAttempts: 'image_attempts',
      rejectedCount: 'rejected_count', okPostId: 'ok_post_id',
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
      `UPDATE ok_jobs SET ${fields.join(', ')} WHERE id = $${idx}`,
      values
    );
  });
}

async function getJobById(chatId, jobId) {
  return withClient(chatId, async (client) => {
    const result = await client.query(
      'SELECT * FROM ok_jobs WHERE id = $1',
      [jobId]
    );
    return result.rows[0] || null;
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
      `SELECT * FROM ok_jobs ${where}
       ORDER BY created_at DESC
       LIMIT $${limitPos} OFFSET $${offsetPos}`,
      params
    );
    const totalRes = await client.query(
      `SELECT COUNT(*)::int AS total FROM ok_jobs ${where}`,
      status ? [status] : []
    );
    return {
      total: totalRes.rows[0]?.total || 0,
      items: rows.rows
    };
  });
}

async function addPublishLog(chatId, data) {
  return withClient(chatId, async (client) => {
    const result = await client.query(
      `INSERT INTO ok_publish_logs
        (job_id, community_id, ok_post_id, status, error_text, correlation_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        data.jobId || null,
        data.communityId,
        data.okPostId || null,
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
       FROM ok_publish_logs
       WHERE status = 'published'
         AND to_char(created_at AT TIME ZONE $1, 'YYYY-MM-DD') = $2`,
      [tz, dateStr]
    );
    return result.rows[0]?.c || 0;
  });
}

async function getJobsByStatus(chatId, status, limit = 10) {
  return withClient(chatId, async (client) => {
    const result = await client.query(
      `SELECT * FROM ok_jobs WHERE status = $1 ORDER BY updated_at ASC LIMIT $2`,
      [status, limit]
    );
    return result.rows;
  });
}

module.exports = {
  withClient,
  createJob,
  updateJob,
  getJobById,
  listJobs,
  addPublishLog,
  countPublishedToday,
  getJobsByStatus
};
