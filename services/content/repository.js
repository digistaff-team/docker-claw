/**
 * TASK-005: Репозиторий для работы с content_jobs, content_posts, publish_logs
 */
const { Client } = require('pg');
const config = require('../../config');
const { JOB_STATUS, POST_STATUS, PUBLISH_LOG_STATUS, validateJobStatusTransition } = require('./status');

// Функция для генерации имени БД (дублируем здесь, чтобы избежать циклической зависимости)
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
  // База данных создаётся автоматически при создании сессии в session.service.js
  // Здесь только подключаемся к уже существующей БД
  
  const client = getDbClient(chatId);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * Создать/обновить схему БД
 */
async function ensureSchema(chatId) {
  return withClient(chatId, async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS content_topics (
        id SERIAL PRIMARY KEY,
        topic VARCHAR(500) NOT NULL,
        focus VARCHAR(255),
        secondary VARCHAR(255),
        lsi VARCHAR(255),
        status VARCHAR(50) NOT NULL DEFAULT 'pending',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        used_at TIMESTAMPTZ
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS content_materials (
        id SERIAL PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        content TEXT NOT NULL,
        source_type VARCHAR(50),
        source_url VARCHAR(500),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS content_config (
        key VARCHAR(100) PRIMARY KEY,
        value TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS content_jobs (
        id BIGSERIAL PRIMARY KEY,
        chat_id TEXT NOT NULL,
        sheet_row INT NOT NULL,
        sheet_topic TEXT NOT NULL,
        content_type TEXT NOT NULL DEFAULT 'text+image',
        status TEXT NOT NULL,
        error_text TEXT,
        image_attempts INT NOT NULL DEFAULT 0,
        rejected_count INT NOT NULL DEFAULT 0,
        draft_text TEXT,
        image_path TEXT,
        video_path TEXT,
        correlation_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS content_assets (
        id BIGSERIAL PRIMARY KEY,
        job_id BIGINT NOT NULL REFERENCES content_jobs(id) ON DELETE CASCADE,
        asset_type TEXT NOT NULL,
        file_path TEXT NOT NULL,
        source TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS content_posts (
        id BIGSERIAL PRIMARY KEY,
        job_id BIGINT NOT NULL REFERENCES content_jobs(id) ON DELETE CASCADE,
        body_text TEXT NOT NULL,
        hashtags TEXT,
        content_type TEXT NOT NULL DEFAULT 'text+image',
        publish_status TEXT NOT NULL DEFAULT 'ready',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS publish_logs (
        id BIGSERIAL PRIMARY KEY,
        post_id BIGINT REFERENCES content_posts(id) ON DELETE SET NULL,
        channel_id TEXT NOT NULL,
        telegram_message_id TEXT,
        status TEXT NOT NULL,
        error_text TEXT,
        correlation_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS content_sheet_state (
        sheet_row INT PRIMARY KEY,
        local_status TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        note TEXT
      );
    `);

    // Миграция старых статусов
    await client.query(`
      UPDATE content_jobs
      SET status = CASE UPPER(status)
        WHEN 'DRAFT_READY' THEN 'ready'
        WHEN 'DRAFT' THEN 'draft'
        WHEN 'APPROVED' THEN 'approved'
        WHEN 'PUBLISHED' THEN 'published'
        WHEN 'FAILED' THEN 'failed'
        WHEN 'FAILED_RETRY' THEN 'failed'
        ELSE LOWER(status)
      END
      WHERE status IS NOT NULL;
    `);
    await client.query(`
      UPDATE content_posts
      SET publish_status = CASE UPPER(publish_status)
        WHEN 'DRAFT_READY' THEN 'ready'
        WHEN 'DRAFT' THEN 'draft'
        WHEN 'APPROVED' THEN 'approved'
        WHEN 'PUBLISHED' THEN 'published'
        WHEN 'FAILED' THEN 'failed'
        WHEN 'FAILED_RETRY' THEN 'failed'
        ELSE LOWER(publish_status)
      END
      WHERE publish_status IS NOT NULL;
    `);
    await client.query(`
      UPDATE publish_logs
      SET status = LOWER(status)
      WHERE status IS NOT NULL;
    `);
    await client.query(`ALTER TABLE content_posts ALTER COLUMN publish_status SET DEFAULT 'ready';`);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_publish_logs_post_published
      ON publish_logs(post_id)
      WHERE status='published';
    `);
    await client.query(`ALTER TABLE content_jobs ADD COLUMN IF NOT EXISTS content_type TEXT NOT NULL DEFAULT 'text+image';`);
    await client.query(`ALTER TABLE content_jobs ADD COLUMN IF NOT EXISTS video_path TEXT;`);
    await client.query(`ALTER TABLE content_posts ADD COLUMN IF NOT EXISTS content_type TEXT NOT NULL DEFAULT 'text+image';`);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_content_topics_status_created_at
      ON content_topics(status, created_at, id);
    `);

    // Pinterest tables
    await client.query(`
      CREATE TABLE IF NOT EXISTS pinterest_jobs (
        id BIGSERIAL PRIMARY KEY,
        chat_id TEXT NOT NULL,
        topic TEXT NOT NULL,
        board_id TEXT,
        board_name TEXT,
        pin_title TEXT,
        pin_description TEXT,
        seo_keywords TEXT,
        image_prompt TEXT,
        image_path TEXT,
        link TEXT,
        status TEXT NOT NULL DEFAULT 'draft',
        error_text TEXT,
        image_attempts INT NOT NULL DEFAULT 0,
        rejected_count INT NOT NULL DEFAULT 0,
        correlation_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS pinterest_publish_logs (
        id BIGSERIAL PRIMARY KEY,
        job_id BIGINT REFERENCES pinterest_jobs(id) ON DELETE SET NULL,
        board_id TEXT NOT NULL,
        pin_id TEXT,
        status TEXT NOT NULL,
        error_text TEXT,
        correlation_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_pinterest_jobs_status
      ON pinterest_jobs(status, created_at);
    `);

    // VK tables
    await client.query(`
      CREATE TABLE IF NOT EXISTS vk_jobs (
        id BIGSERIAL PRIMARY KEY,
        chat_id TEXT NOT NULL,
        topic TEXT NOT NULL,
        group_id TEXT,
        post_text TEXT,
        hook_text TEXT,
        image_prompt TEXT,
        image_path TEXT,
        video_path TEXT,
        vk_content_type TEXT NOT NULL DEFAULT 'photo' CHECK (vk_content_type IN ('photo', 'video', 'story')),
        link TEXT,
        status TEXT NOT NULL DEFAULT 'draft',
        error_text TEXT,
        image_attempts INT NOT NULL DEFAULT 0,
        rejected_count INT NOT NULL DEFAULT 0,
        vk_post_id TEXT,
        correlation_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS vk_publish_logs (
        id BIGSERIAL PRIMARY KEY,
        job_id BIGINT REFERENCES vk_jobs(id) ON DELETE SET NULL,
        group_id TEXT NOT NULL,
        vk_post_id TEXT,
        status TEXT NOT NULL,
        error_text TEXT,
        correlation_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_vk_jobs_status
      ON vk_jobs(status, created_at);
    `);

    // OK (Odnoklassniki) tables
    await client.query(`
      CREATE TABLE IF NOT EXISTS ok_jobs (
        id BIGSERIAL PRIMARY KEY,
        chat_id TEXT NOT NULL,
        topic TEXT NOT NULL,
        community_id TEXT,
        post_text TEXT,
        hook_text TEXT,
        image_prompt TEXT,
        image_path TEXT,
        video_path TEXT,
        ok_content_type TEXT NOT NULL DEFAULT 'photo' CHECK (ok_content_type IN ('photo', 'video')),
        link TEXT,
        status TEXT NOT NULL DEFAULT 'draft',
        error_text TEXT,
        image_attempts INT NOT NULL DEFAULT 0,
        rejected_count INT NOT NULL DEFAULT 0,
        ok_post_id TEXT,
        correlation_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS ok_publish_logs (
        id BIGSERIAL PRIMARY KEY,
        job_id BIGINT REFERENCES ok_jobs(id) ON DELETE SET NULL,
        community_id TEXT NOT NULL,
        ok_post_id TEXT,
        status TEXT NOT NULL,
        error_text TEXT,
        correlation_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_ok_jobs_status
      ON ok_jobs(status, created_at);
    `);
  });
}

/**
 * Создать новый job
 */
async function createJob(chatId, data) {
  return withClient(chatId, async (client) => {
    const result = await client.query(
      `INSERT INTO content_jobs
        (chat_id, sheet_row, sheet_topic, content_type, status, image_attempts, draft_text, image_path, video_path, correlation_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [
        chatId,
        data.sheetRow,
        data.topic,
        data.contentType || 'text+image',
        data.status || JOB_STATUS.READY,
        data.imageAttempts || 0,
        data.text || null,
        data.imagePath || null,
        data.videoPath || null,
        data.correlationId || null
      ]
    );
    return result.rows[0].id;
  });
}

/**
 * Обновить статус job с валидацией перехода
 */
async function updateJobStatus(chatId, jobId, newStatus, errorText = null) {
  return withClient(chatId, async (client) => {
    // Получаем текущий статус
    const current = await client.query(
      `SELECT status FROM content_jobs WHERE id = $1`,
      [jobId]
    );
    if (!current.rows[0]) {
      throw new Error(`Job ${jobId} not found`);
    }

    const fromStatus = current.rows[0].status;
    
    // Валидация перехода
    const validation = validateJobStatusTransition(fromStatus, newStatus);
    if (!validation.valid) {
      console.error(`[CONTENT-REPO] Invalid status transition: ${validation.reason}`);
      // Логируем, но не блокируем для обратной совместимости
    }

    await client.query(
      `UPDATE content_jobs
       SET status = $1, error_text = $2, updated_at = NOW()
       WHERE id = $3`,
      [newStatus, errorText, jobId]
    );
    
    return { previousStatus: fromStatus, newStatus };
  });
}

/**
 * Обновить job
 */
async function updateJob(chatId, jobId, data) {
  return withClient(chatId, async (client) => {
    const fields = [];
    const values = [];
    let paramIndex = 1;

    if (data.status !== undefined) {
      fields.push(`status = $${paramIndex++}`);
      values.push(data.status);
    }
    if (data.errorText !== undefined) {
      fields.push(`error_text = $${paramIndex++}`);
      values.push(data.errorText);
    }
    if (data.draftText !== undefined) {
      fields.push(`draft_text = $${paramIndex++}`);
      values.push(data.draftText);
    }
    if (data.imagePath !== undefined) {
      fields.push(`image_path = $${paramIndex++}`);
      values.push(data.imagePath);
    }
    if (data.videoPath !== undefined) {
      fields.push(`video_path = $${paramIndex++}`);
      values.push(data.videoPath);
    }
    if (data.contentType !== undefined) {
      fields.push(`content_type = $${paramIndex++}`);
      values.push(data.contentType);
    }
    if (data.imageAttempts !== undefined) {
      fields.push(`image_attempts = $${paramIndex++}`);
      values.push(data.imageAttempts);
    }
    if (data.rejectedCount !== undefined) {
      fields.push(`rejected_count = $${paramIndex++}`);
      values.push(data.rejectedCount);
    }
    if (data.correlationId !== undefined) {
      fields.push(`correlation_id = $${paramIndex++}`);
      values.push(data.correlationId);
    }

    if (fields.length === 0) return;

    fields.push(`updated_at = NOW()`);
    values.push(jobId);

    await client.query(
      `UPDATE content_jobs SET ${fields.join(', ')} WHERE id = $${paramIndex}`,
      values
    );
  });
}

/**
 * Получить job по ID
 */
async function getJobById(chatId, jobId) {
  return withClient(chatId, async (client) => {
    const result = await client.query(
      `SELECT * FROM content_jobs WHERE id = $1`,
      [jobId]
    );
    return result.rows[0] || null;
  });
}

/**
 * Создать post для job
 */
async function createPost(chatId, jobId, bodyText, hashtags = '', contentType = 'text+image') {
  return withClient(chatId, async (client) => {
    const result = await client.query(
      `INSERT INTO content_posts (job_id, body_text, hashtags, content_type, publish_status)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [jobId, bodyText, hashtags, contentType, POST_STATUS.READY]
    );
    return result.rows[0].id;
  });
}

/**
 * Обновить post
 */
async function updatePost(chatId, postId, data) {
  return withClient(chatId, async (client) => {
    const fields = [];
    const values = [];
    let paramIndex = 1;

    if (data.bodyText !== undefined) {
      fields.push(`body_text = $${paramIndex++}`);
      values.push(data.bodyText);
    }
    if (data.hashtags !== undefined) {
      fields.push(`hashtags = $${paramIndex++}`);
      values.push(data.hashtags);
    }
    if (data.publishStatus !== undefined) {
      fields.push(`publish_status = $${paramIndex++}`);
      values.push(data.publishStatus);
    }
    if (data.contentType !== undefined) {
      fields.push(`content_type = $${paramIndex++}`);
      values.push(data.contentType);
    }

    if (fields.length === 0) return;

    fields.push(`updated_at = NOW()`);
    values.push(postId);

    await client.query(
      `UPDATE content_posts SET ${fields.join(', ')} WHERE id = $${paramIndex}`,
      values
    );
  });
}

/**
 * Получить post по job_id
 */
async function getPostByJobId(chatId, jobId) {
  return withClient(chatId, async (client) => {
    const result = await client.query(
      `SELECT * FROM content_posts WHERE job_id = $1 LIMIT 1`,
      [jobId]
    );
    return result.rows[0] || null;
  });
}

/**
 * Создать asset
 */
async function createAsset(chatId, jobId, assetType, filePath, source = null) {
  return withClient(chatId, async (client) => {
    const result = await client.query(
      `INSERT INTO content_assets (job_id, asset_type, file_path, source)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [jobId, assetType, filePath, source]
    );
    return result.rows[0].id;
  });
}

/**
 * Добавить запись в publish_logs
 */
async function addPublishLog(chatId, data) {
  return withClient(chatId, async (client) => {
    const result = await client.query(
      `INSERT INTO publish_logs
        (post_id, channel_id, telegram_message_id, status, error_text, correlation_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        data.postId,
        data.channelId,
        data.telegramMessageId || null,
        data.status,
        data.errorText || null,
        data.correlationId || null
      ]
    );
    return result.rows[0].id;
  });
}

/**
 * Проверить, был ли пост уже опубликован
 */
async function isPostPublished(chatId, postId) {
  return withClient(chatId, async (client) => {
    const result = await client.query(
      `SELECT id FROM publish_logs
       WHERE post_id = $1 AND status = $2
       LIMIT 1`,
      [postId, PUBLISH_LOG_STATUS.PUBLISHED]
    );
    return result.rowCount > 0;
  });
}

/**
 * Обновить sheet state
 */
async function setSheetState(chatId, sheetRow, status, note = '') {
  return withClient(chatId, async (client) => {
    await client.query(
      `INSERT INTO content_sheet_state (sheet_row, local_status, note)
       VALUES ($1, $2, $3)
       ON CONFLICT (sheet_row) DO UPDATE SET
         local_status = EXCLUDED.local_status,
         note = EXCLUDED.note,
         updated_at = NOW()`,
      [sheetRow, status, note || null]
    );
  });
}

/**
 * Получить sheet state
 */
async function getSheetState(chatId, sheetRow) {
  return withClient(chatId, async (client) => {
    const result = await client.query(
      `SELECT * FROM content_sheet_state WHERE sheet_row = $1`,
      [sheetRow]
    );
    return result.rows[0] || null;
  });
}

/**
 * Список jobs с фильтрацией
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
      where = `WHERE LOWER(j.status) = $${params.length}`;
    }
    params.push(limit);
    const limitPos = params.length;
    params.push(offset);
    const offsetPos = params.length;

    const sql = `
      SELECT
        j.id, j.chat_id, j.sheet_row, j.sheet_topic, j.status, j.error_text,
        j.content_type, j.image_attempts, j.rejected_count, j.draft_text, j.image_path, j.video_path,
        j.correlation_id, j.created_at, j.updated_at,
        p.id AS post_id, p.content_type AS post_content_type, p.publish_status, p.hashtags,
        pl.status AS last_publish_status, pl.error_text AS last_publish_error,
        pl.telegram_message_id AS last_telegram_message_id, pl.created_at AS last_publish_at
      FROM content_jobs j
      LEFT JOIN content_posts p ON p.job_id = j.id
      LEFT JOIN LATERAL (
        SELECT status, error_text, telegram_message_id, created_at
        FROM publish_logs
        WHERE post_id = p.id
        ORDER BY created_at DESC
        LIMIT 1
      ) pl ON TRUE
      ${where}
      ORDER BY j.created_at DESC
      LIMIT $${limitPos} OFFSET $${offsetPos}
    `;
    const rows = await client.query(sql, params);
    const totalRes = await client.query(
      `SELECT COUNT(*)::int AS total FROM content_jobs ${where}`,
      status ? [status] : []
    );
    return {
      total: totalRes.rows[0]?.total || 0,
      items: rows.rows
    };
  });
}

/**
 * Получить job с полной информацией
 */
async function getJobWithDetails(chatId, jobId) {
  return withClient(chatId, async (client) => {
    const r = await client.query(
      `SELECT
        j.*,
        p.id AS post_id, p.content_type AS post_content_type, p.publish_status, p.body_text, p.hashtags
      FROM content_jobs j
      LEFT JOIN content_posts p ON p.job_id = j.id
      WHERE j.id = $1
      LIMIT 1`,
      [jobId]
    );
    if (!r.rows[0]) return null;

    const logs = await client.query(
      `SELECT id, channel_id, telegram_message_id, status, error_text, correlation_id, created_at
       FROM publish_logs
       WHERE post_id = $1
       ORDER BY created_at DESC`,
      [r.rows[0].post_id || null]
    );
    return {
      ...r.rows[0],
      publish_logs: logs.rows
    };
  });
}

/**
 * Подсчет опубликованных за день
 */
async function countPublishedToday(chatId, dateStr, tz = 'Europe/Moscow') {
  return withClient(chatId, async (client) => {
    const result = await client.query(
      `SELECT COUNT(*)::int AS c
       FROM publish_logs
       WHERE status = $1
         AND to_char(created_at AT TIME ZONE $2, 'YYYY-MM-DD') = $3`,
      [PUBLISH_LOG_STATUS.PUBLISHED, tz, dateStr]
    );
    return result.rows[0]?.c || 0;
  });
}

/**
 * Транзакция с блокировкой поста
 */
async function withLockedPost(chatId, jobId, fn) {
  return withClient(chatId, async (client) => {
    await client.query('BEGIN');
    try {
      const postRes = await client.query(
        `SELECT id, publish_status FROM content_posts WHERE job_id = $1 FOR UPDATE`,
        [jobId]
      );
      const post = postRes.rows[0];
      if (!post) {
        await client.query('ROLLBACK');
        throw new Error(`Post for job ${jobId} not found`);
      }
      
      const result = await fn(client, post);
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    }
  });
}

// ============================================
// TASK-015: Video-specific methods
// ============================================

/**
 * Получить jobs со статусом MEDIA_GENERATING (для polling видео)
 * @param {string} chatId
 * @param {number} [limit=10]
 * @returns {Promise<Array>}
 */
async function getPendingMediaJobs(chatId, limit = 10) {
  return withClient(chatId, async (client) => {
    const result = await client.query(
      `SELECT id, chat_id, sheet_row, sheet_topic, content_type, status, 
              draft_text, image_path, video_path, correlation_id, created_at
       FROM content_jobs
       WHERE status = $1
       ORDER BY created_at ASC
       LIMIT $2`,
      [JOB_STATUS.MEDIA_GENERATING, limit]
    );
    return result.rows;
  });
}

/**
 * Получить video asset для job
 * @param {string} chatId
 * @param {number} jobId
 * @returns {Promise<object|null>}
 */
async function getVideoAssetByJobId(chatId, jobId) {
  return withClient(chatId, async (client) => {
    const result = await client.query(
      `SELECT * FROM content_assets 
       WHERE job_id = $1 AND asset_type = 'video'
       ORDER BY created_at DESC
       LIMIT 1`,
      [jobId]
    );
    return result.rows[0] || null;
  });
}

/**
 * Обновить video_path для job
 * @param {string} chatId
 * @param {number} jobId
 * @param {string} videoPath
 * @param {string} [source]
 */
async function updateJobVideoPath(chatId, jobId, videoPath, source = null) {
  return withClient(chatId, async (client) => {
    await client.query(
      `UPDATE content_jobs SET video_path = $1, updated_at = NOW() WHERE id = $2`,
      [videoPath, jobId]
    );
    
    // Создаём или обновляем asset
    if (source) {
      const existingAsset = await client.query(
        `SELECT id FROM content_assets WHERE job_id = $1 AND asset_type = 'video'`,
        [jobId]
      );
      
      if (existingAsset.rows[0]) {
        await client.query(
          `UPDATE content_assets SET file_path = $1, source = $2 WHERE id = $3`,
          [videoPath, source, existingAsset.rows[0].id]
        );
      } else {
        await client.query(
          `INSERT INTO content_assets (job_id, asset_type, file_path, source) VALUES ($1, $2, $3, $4)`,
          [jobId, 'video', videoPath, source]
        );
      }
    }
  });
}

/**
 * Получить статистику генераций видео за день
 * @param {string} chatId
 * @param {string} dateStr
 * @param {string} [tz='Europe/Moscow']
 * @returns {Promise<number>}
 */
async function countVideoGeneratedToday(chatId, dateStr, tz = 'Europe/Moscow') {
  return withClient(chatId, async (client) => {
    const result = await client.query(
      `SELECT COUNT(*)::int AS c FROM content_assets a
       JOIN content_jobs j ON j.id = a.job_id
       WHERE a.asset_type = 'video'
         AND to_char(a.created_at AT TIME ZONE $1, 'YYYY-MM-DD') = $2`,
      [tz, dateStr]
    );
    return result.rows[0]?.c || 0;
  });
}

async function reserveNextTopic(chatId) {
  return withClient(chatId, async (client) => {
    await client.query('BEGIN');
    try {
      const result = await client.query(
        `SELECT id, topic, focus, secondary, lsi, status, created_at, used_at
         FROM content_topics
         WHERE status = 'pending'
         ORDER BY created_at ASC, id ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1`
      );
      const row = result.rows[0];
      if (!row) {
        await client.query('COMMIT');
        return null;
      }

      await client.query(
        `UPDATE content_topics
         SET status = 'used', used_at = NOW()
         WHERE id = $1`,
        [row.id]
      );

      await client.query('COMMIT');
      return row;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
  });
}

async function listTopics(chatId, options = {}) {
  const status = options.status ? String(options.status).trim().toLowerCase() : null;
  const limit = Math.min(Math.max(parseInt(options.limit, 10) || 100, 1), 500);
  const offset = Math.max(parseInt(options.offset, 10) || 0, 0);

  return withClient(chatId, async (client) => {
    const params = [];
    const where = [];

    if (status) {
      params.push(status);
      where.push(`LOWER(status) = $${params.length}`);
    }

    params.push(limit);
    const limitPos = params.length;
    params.push(offset);
    const offsetPos = params.length;

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const result = await client.query(
      `SELECT id, topic, focus, secondary, lsi, status, created_at, used_at
       FROM content_topics
       ${whereSql}
       ORDER BY created_at DESC, id DESC
       LIMIT $${limitPos} OFFSET $${offsetPos}`,
      params
    );
    const totalResult = await client.query(
      `SELECT COUNT(*)::int AS total
       FROM content_topics
       ${whereSql}`,
      status ? [status] : []
    );

    return {
      total: totalResult.rows[0]?.total || 0,
      items: result.rows
    };
  });
}

async function createTopic(chatId, data) {
  return withClient(chatId, async (client) => {
    const result = await client.query(
      `INSERT INTO content_topics (topic, focus, secondary, lsi, status)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, topic, focus, secondary, lsi, status, created_at, used_at`,
      [
        data.topic,
        data.focus || null,
        data.secondary || null,
        data.lsi || null,
        data.status || 'pending'
      ]
    );
    return result.rows[0];
  });
}

async function getTopicById(chatId, topicId) {
  return withClient(chatId, async (client) => {
    const result = await client.query(
      `SELECT id, topic, focus, secondary, lsi, status, created_at, used_at
       FROM content_topics
       WHERE id = $1
       LIMIT 1`,
      [topicId]
    );
    return result.rows[0] || null;
  });
}

async function updateTopic(chatId, topicId, data) {
  return withClient(chatId, async (client) => {
    const fields = [];
    const values = [];
    let paramIndex = 1;

    if (data.topic !== undefined) {
      fields.push(`topic = $${paramIndex++}`);
      values.push(data.topic);
    }
    if (data.focus !== undefined) {
      fields.push(`focus = $${paramIndex++}`);
      values.push(data.focus);
    }
    if (data.secondary !== undefined) {
      fields.push(`secondary = $${paramIndex++}`);
      values.push(data.secondary);
    }
    if (data.lsi !== undefined) {
      fields.push(`lsi = $${paramIndex++}`);
      values.push(data.lsi);
    }
    if (data.status !== undefined) {
      fields.push(`status = $${paramIndex++}::text`);
      values.push(data.status);
      fields.push(`used_at = CASE WHEN $${paramIndex - 1}::text = 'pending' THEN NULL ELSE COALESCE(used_at, NOW()) END`);
    }

    if (!fields.length) {
      // Нет полей для обновления - просто возвращаем текущее значение
      return getTopicById(chatId, topicId);
    }

    values.push(topicId);
    const result = await client.query(
      `UPDATE content_topics
       SET ${fields.join(', ')}
       WHERE id = $${paramIndex}
       RETURNING id, topic, focus, secondary, lsi, status, created_at, used_at`,
      values
    );
    return result.rows[0] || null;
  });
}

async function deleteTopic(chatId, topicId) {
  return withClient(chatId, async (client) => {
    const result = await client.query(
      `DELETE FROM content_topics
       WHERE id = $1
       RETURNING id`,
      [topicId]
    );
    return result.rows[0] || null;
  });
}

async function updateTopicStatus(chatId, topicId, status, note = null) {
  return withClient(chatId, async (client) => {
    const result = await client.query(
      `UPDATE content_topics
       SET status = $1::text,
           used_at = CASE
             WHEN $1::text = 'pending' THEN NULL
             ELSE COALESCE(used_at, NOW())
           END
       WHERE id = $2
       RETURNING id, topic, focus, secondary, lsi, status, created_at, used_at`,
      [status, topicId]
    );

    if (note !== null) {
      await client.query(
        `INSERT INTO content_sheet_state (sheet_row, local_status, note)
         VALUES ($1, $2, $3)
         ON CONFLICT (sheet_row) DO UPDATE SET
           local_status = EXCLUDED.local_status,
           note = EXCLUDED.note,
           updated_at = NOW()`,
        [topicId, status, note || null]
      );
    }

    return result.rows[0] || null;
  });
}

async function listMaterials(chatId, options = {}) {
  const limit = Math.min(Math.max(parseInt(options.limit, 10) || 100, 1), 500);
  const offset = Math.max(parseInt(options.offset, 10) || 0, 0);

  return withClient(chatId, async (client) => {
    const result = await client.query(
      `SELECT id, title, content, source_type, source_url, created_at
       FROM content_materials
       ORDER BY created_at DESC, id DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    const totalResult = await client.query(`SELECT COUNT(*)::int AS total FROM content_materials`);

    return {
      total: totalResult.rows[0]?.total || 0,
      items: result.rows
    };
  });
}

async function createMaterial(chatId, data) {
  return withClient(chatId, async (client) => {
    const result = await client.query(
      `INSERT INTO content_materials (title, content, source_type, source_url)
       VALUES ($1, $2, $3, $4)
       RETURNING id, title, content, source_type, source_url, created_at`,
      [
        data.title,
        data.content,
        data.sourceType || null,
        data.sourceUrl || null
      ]
    );
    return result.rows[0];
  });
}

async function getMaterialById(chatId, materialId) {
  return withClient(chatId, async (client) => {
    const result = await client.query(
      `SELECT id, title, content, source_type, source_url, created_at
       FROM content_materials
       WHERE id = $1
       LIMIT 1`,
      [materialId]
    );
    return result.rows[0] || null;
  });
}

async function updateMaterial(chatId, materialId, data) {
  return withClient(chatId, async (client) => {
    const fields = [];
    const values = [];
    let paramIndex = 1;

    if (data.title !== undefined) {
      fields.push(`title = $${paramIndex++}`);
      values.push(data.title);
    }
    if (data.content !== undefined) {
      fields.push(`content = $${paramIndex++}`);
      values.push(data.content);
    }
    if (data.sourceType !== undefined) {
      fields.push(`source_type = $${paramIndex++}`);
      values.push(data.sourceType);
    }
    if (data.sourceUrl !== undefined) {
      fields.push(`source_url = $${paramIndex++}`);
      values.push(data.sourceUrl);
    }

    if (!fields.length) {
      return getMaterialById(chatId, materialId);
    }

    values.push(materialId);
    const result = await client.query(
      `UPDATE content_materials
       SET ${fields.join(', ')}
       WHERE id = $${paramIndex}
       RETURNING id, title, content, source_type, source_url, created_at`,
      values
    );
    return result.rows[0] || null;
  });
}

async function deleteMaterial(chatId, materialId) {
  return withClient(chatId, async (client) => {
    const result = await client.query(
      `DELETE FROM content_materials
       WHERE id = $1
       RETURNING id`,
      [materialId]
    );
    return result.rows[0] || null;
  });
}

async function loadMaterials(chatId, limit = 12) {
  return withClient(chatId, async (client) => {
    const result = await client.query(
      `SELECT id, title, content, source_type, source_url, created_at
       FROM content_materials
       ORDER BY created_at DESC, id DESC
       LIMIT $1`,
      [limit]
    );
    return result.rows;
  });
}

// ============================================
// Channel Management
// ============================================

/**
 * Получить значение из content_config
 */
async function getConfig(chatId, key) {
  return withClient(chatId, async (client) => {
    const result = await client.query(
      `SELECT value FROM content_config WHERE key = $1`,
      [key]
    );
    return result.rows[0]?.value || null;
  });
}

/**
 * Сохранить значение в content_config
 */
async function setConfig(chatId, key, value) {
  return withClient(chatId, async (client) => {
    await client.query(
      `INSERT INTO content_config (key, value, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET
         value = EXCLUDED.value,
         updated_at = NOW()`,
      [key, value]
    );
  });
}

/**
 * Получить список включённых каналов
 * @returns {Promise<string[]>} ['telegram', 'vk', ...]
 */
async function getEnabledChannels(chatId) {
  const json = await getConfig(chatId, 'enabled_channels');
  if (!json) return [];
  try {
    return JSON.parse(json);
  } catch {
    return [];
  }
}

/**
 * Сохранить список включённых каналов
 */
async function setEnabledChannels(chatId, channels) {
  await setConfig(chatId, 'enabled_channels', JSON.stringify(channels || []));
}

/**
 * Создать таблицы для конкретного канала
 */
async function ensureChannelSchema(chatId, channelName) {
  return withClient(chatId, async (client) => {
    if (channelName === 'vk') {
      await client.query(`
        CREATE TABLE IF NOT EXISTS vk_jobs (
          id BIGSERIAL PRIMARY KEY,
          chat_id TEXT NOT NULL,
          topic TEXT NOT NULL,
          group_id TEXT,
          post_text TEXT,
          hook_text TEXT,
          image_prompt TEXT,
          image_path TEXT,
          video_path TEXT,
          vk_content_type TEXT NOT NULL DEFAULT 'photo'
            CHECK (vk_content_type IN ('photo', 'video', 'story')),
          link TEXT,
          status TEXT NOT NULL DEFAULT 'draft',
          error_text TEXT,
          image_attempts INT NOT NULL DEFAULT 0,
          rejected_count INT NOT NULL DEFAULT 0,
          vk_post_id TEXT,
          correlation_id TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS vk_publish_logs (
          id BIGSERIAL PRIMARY KEY,
          job_id BIGINT REFERENCES vk_jobs(id) ON DELETE SET NULL,
          group_id TEXT NOT NULL,
          vk_post_id TEXT,
          status TEXT NOT NULL,
          error_text TEXT,
          correlation_id TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_vk_jobs_status ON vk_jobs(status, created_at)`);
    } else if (channelName === 'ok') {
      await client.query(`
        CREATE TABLE IF NOT EXISTS ok_jobs (
          id BIGSERIAL PRIMARY KEY,
          chat_id TEXT NOT NULL,
          topic TEXT NOT NULL,
          community_id TEXT,
          post_text TEXT,
          hook_text TEXT,
          image_prompt TEXT,
          image_path TEXT,
          video_path TEXT,
          ok_content_type TEXT NOT NULL DEFAULT 'photo'
            CHECK (ok_content_type IN ('photo', 'video')),
          link TEXT,
          status TEXT NOT NULL DEFAULT 'draft',
          error_text TEXT,
          image_attempts INT NOT NULL DEFAULT 0,
          rejected_count INT NOT NULL DEFAULT 0,
          ok_post_id TEXT,
          correlation_id TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ok_publish_logs (
          id BIGSERIAL PRIMARY KEY,
          job_id BIGINT REFERENCES ok_jobs(id) ON DELETE SET NULL,
          community_id TEXT NOT NULL,
          ok_post_id TEXT,
          status TEXT NOT NULL,
          error_text TEXT,
          correlation_id TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_ok_jobs_status ON ok_jobs(status, created_at)`);
    } else if (channelName === 'pinterest') {
      await client.query(`
        CREATE TABLE IF NOT EXISTS pinterest_jobs (
          id BIGSERIAL PRIMARY KEY,
          chat_id TEXT NOT NULL,
          topic TEXT NOT NULL,
          board_id TEXT,
          board_name TEXT,
          pin_title TEXT,
          pin_description TEXT,
          seo_keywords TEXT,
          image_prompt TEXT,
          image_path TEXT,
          link TEXT,
          status TEXT NOT NULL DEFAULT 'draft',
          error_text TEXT,
          image_attempts INT NOT NULL DEFAULT 0,
          rejected_count INT NOT NULL DEFAULT 0,
          correlation_id TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS pinterest_publish_logs (
          id BIGSERIAL PRIMARY KEY,
          job_id BIGINT REFERENCES pinterest_jobs(id) ON DELETE SET NULL,
          board_id TEXT NOT NULL,
          pin_id TEXT,
          status TEXT NOT NULL,
          error_text TEXT,
          correlation_id TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_pinterest_jobs_status ON pinterest_jobs(status, created_at)`);
    } else if (channelName === 'instagram') {
      const igRepo = require('./instagram.repository');
      await igRepo.ensureSchema(chatId);
    } else if (channelName === 'youtube') {
      // Stub: таблицы ещё не определены
    } else if (channelName === 'email') {
      // Stub: таблицы ещё не определены
    }
  });
}

module.exports = {
  withClient,
  ensureSchema,
  createJob,
  updateJob,
  updateJobStatus,
  getJobById,
  createPost,
  updatePost,
  getPostByJobId,
  createAsset,
  addPublishLog,
  isPostPublished,
  setSheetState,
  getSheetState,
  listJobs,
  getJobWithDetails,
  countPublishedToday,
  withLockedPost,
  // TASK-015: Video methods
  getPendingMediaJobs,
  getVideoAssetByJobId,
  updateJobVideoPath,
  countVideoGeneratedToday,
  reserveNextTopic,
  listTopics,
  createTopic,
  getTopicById,
  updateTopic,
  deleteTopic,
  updateTopicStatus,
  listMaterials,
  createMaterial,
  getMaterialById,
  updateMaterial,
  deleteMaterial,
  loadMaterials,
  // Channel management
  getConfig,
  setConfig,
  getEnabledChannels,
  setEnabledChannels,
  ensureChannelSchema
};
