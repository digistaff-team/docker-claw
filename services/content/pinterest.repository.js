/**
 * Репозиторий для pinterest_jobs, pinterest_publish_logs и boards
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
      `INSERT INTO pinterest_jobs
        (chat_id, topic, board_id, board_name, pin_title, pin_description, seo_keywords, image_prompt, image_path, link, status, image_attempts, correlation_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING id`,
      [
        chatId,
        data.topic,
        data.boardId || null,
        data.boardName || null,
        data.pinTitle || null,
        data.pinDescription || null,
        data.seoKeywords || null,
        data.imagePrompt || null,
        data.imagePath || null,
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
      topic: 'topic', boardId: 'board_id', boardName: 'board_name',
      pinTitle: 'pin_title', pinDescription: 'pin_description',
      seoKeywords: 'seo_keywords', imagePrompt: 'image_prompt',
      imagePath: 'image_path', link: 'link', status: 'status',
      errorText: 'error_text', imageAttempts: 'image_attempts',
      rejectedCount: 'rejected_count', correlationId: 'correlation_id'
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
      `UPDATE pinterest_jobs SET ${fields.join(', ')} WHERE id = $${idx}`,
      values
    );
  });
}

async function getJobById(chatId, jobId) {
  return withClient(chatId, async (client) => {
    const result = await client.query(
      'SELECT * FROM pinterest_jobs WHERE id = $1',
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
      `SELECT * FROM pinterest_jobs ${where}
       ORDER BY created_at DESC
       LIMIT $${limitPos} OFFSET $${offsetPos}`,
      params
    );
    const totalRes = await client.query(
      `SELECT COUNT(*)::int AS total FROM pinterest_jobs ${where}`,
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
      `INSERT INTO pinterest_publish_logs
        (job_id, board_id, pin_id, status, error_text, correlation_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        data.jobId || null,
        data.boardId,
        data.pinId || null,
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
       FROM pinterest_publish_logs
       WHERE status = 'published'
         AND to_char(created_at AT TIME ZONE $1, 'YYYY-MM-DD') = $2`,
      [tz, dateStr]
    );
    return result.rows[0]?.c || 0;
  });
}

// ============================================
// Pinterest Boards
// ============================================

async function ensureBoardsSchema(chatId) {
  return withClient(chatId, async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS pinterest_boards (
        id SERIAL PRIMARY KEY,
        board_id VARCHAR(100) NOT NULL UNIQUE,
        board_name VARCHAR(500) NOT NULL,
        idea TEXT,
        focus TEXT,
        purpose TEXT,
        keywords TEXT,
        link TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_pinterest_boards_board_id ON pinterest_boards(board_id)
    `);
  });
}

async function saveBoards(chatId, boards) {
  return withClient(chatId, async (client) => {
    await ensureBoardsSchema(chatId);
    const result = await client.query(`
      INSERT INTO pinterest_boards (board_id, board_name, idea, focus, purpose, keywords, link)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (board_id) DO UPDATE SET
        board_name = EXCLUDED.board_name,
        idea = EXCLUDED.idea,
        focus = EXCLUDED.focus,
        purpose = EXCLUDED.purpose,
        keywords = EXCLUDED.keywords,
        link = EXCLUDED.link,
        updated_at = NOW()
      RETURNING *
    `, boards.map(b => [
      b.id,
      b.name,
      b.description || null,
      null,  // idea
      null,  // focus
      null,  // purpose
      null,  // keywords
      b.link || null
    ]).flat());
    return result.rows;
  });
}

async function getBoards(chatId) {
  return withClient(chatId, async (client) => {
    await ensureBoardsSchema(chatId);
    const result = await client.query(`
      SELECT id, board_id, board_name, idea, focus, purpose, keywords, link, created_at, updated_at
      FROM pinterest_boards
      ORDER BY created_at DESC
    `);
    return result.rows;
  });
}

async function getBoard(chatId, boardId) {
  return withClient(chatId, async (client) => {
    await ensureBoardsSchema(chatId);
    const result = await client.query(`
      SELECT * FROM pinterest_boards WHERE board_id = $1
    `, [boardId]);
    return result.rows[0] || null;
  });
}

async function updateBoard(chatId, boardId, data) {
  return withClient(chatId, async (client) => {
    const fields = [];
    const values = [];
    let idx = 1;

    const map = {
      idea: 'idea', focus: 'focus', purpose: 'purpose',
      keywords: 'keywords', link: 'link'
    };

    for (const [jsKey, dbCol] of Object.entries(map)) {
      if (data[jsKey] !== undefined) {
        fields.push(`${dbCol} = $${idx++}`);
        values.push(data[jsKey]);
      }
    }

    if (fields.length === 0) return;

    fields.push('updated_at = NOW()');
    values.push(boardId);

    await client.query(
      `UPDATE pinterest_boards SET ${fields.join(', ')} WHERE board_id = $${idx}`,
      values
    );
  });
}

async function deleteBoard(chatId, boardId) {
  return withClient(chatId, async (client) => {
    const result = await client.query(`
      DELETE FROM pinterest_boards WHERE board_id = $1 RETURNING id
    `, [boardId]);
    return result.rows[0]?.id || null;
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
  // Boards
  ensureBoardsSchema,
  saveBoards,
  getBoards,
  getBoard,
  updateBoard,
  deleteBoard
};
