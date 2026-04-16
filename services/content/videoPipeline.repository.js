/**
 * Репозиторий для видео-пайплайна
 * Таблицы: interiors, video_assets, video_channel_usage
 */
const { Client } = require('pg');
const config = require('../../config');

// Настраиваемый список каналов через env
const CHANNELS = (process.env.VIDEO_CHANNELS || 'youtube,tiktok,instagram,vk').split(',').map(s => s.trim().toLowerCase());

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

async function withTransaction(chatId, fn) {
  const client = getDbClient(chatId);
  await client.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    await client.end().catch(() => {});
  }
}

// ============================================
// Schema
// ============================================

async function ensureSchema(chatId) {
  return withClient(chatId, async (client) => {
    // Interiors
    await client.query(`
      CREATE TABLE IF NOT EXISTS interiors (
        id BIGSERIAL PRIMARY KEY,
        chat_id TEXT NOT NULL,
        description TEXT NOT NULL,
        style VARCHAR(100),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_interiors_chat ON interiors(chat_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_interiors_chat_style ON interiors(chat_id, style)`);

    // Video assets
    await client.query(`
      CREATE TABLE IF NOT EXISTS video_assets (
        id BIGSERIAL PRIMARY KEY,
        chat_id TEXT NOT NULL,
        product_image_path TEXT NOT NULL,
        interior_id BIGINT,
        scene_image_path TEXT,
        video_path TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        provider TEXT DEFAULT 'kie-veo3.1',
        video_duration INT,
        file_size BIGINT,
        correlation_id TEXT,
        initiating_channel TEXT,
        error_text TEXT,
        all_channels_marked_at TIMESTAMPTZ,
        scheduled_deletion_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT video_assets_status_check CHECK (
          status IN ('pending','scene_generating','scene_ready','video_generating','video_ready','published','expired','failed')
        ),
        CONSTRAINT video_assets_channel_check CHECK (
          initiating_channel IN ('youtube','tiktok','instagram','vk')
        )
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_video_assets_chat_status ON video_assets(chat_id, status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_video_assets_deletion ON video_assets(scheduled_deletion_at) WHERE scheduled_deletion_at IS NOT NULL`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_video_assets_chat_created ON video_assets(chat_id, created_at DESC)`);

    // Channel usage marks
    await client.query(`
      CREATE TABLE IF NOT EXISTS video_channel_usage (
        id BIGSERIAL PRIMARY KEY,
        video_id BIGINT,
        channel_type TEXT NOT NULL,
        used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT video_channel_usage_unique UNIQUE(video_id, channel_type),
        CONSTRAINT video_channel_usage_channel_check CHECK (
          channel_type IN ('youtube','tiktok','instagram','vk')
        )
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_video_channel_usage_video ON video_channel_usage(video_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_video_channel_usage_channel ON video_channel_usage(channel_type)`);
  });
}

// ============================================
// Interiors
// ============================================

async function addInterior(chatId, { description, style }) {
  return withClient(chatId, async (client) => {
    const res = await client.query(
      `INSERT INTO interiors (chat_id, description, style) VALUES ($1, $2, $3) RETURNING *`,
      [chatId, description, style || null]
    );
    return res.rows[0];
  });
}

async function getInteriors(chatId, { limit = 100, offset = 0 } = {}) {
  return withClient(chatId, async (client) => {
    const res = await client.query(
      `SELECT * FROM interiors WHERE chat_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [chatId, limit, offset]
    );
    return res.rows;
  });
}

async function getRandomInterior(chatId) {
  return withClient(chatId, async (client) => {
    const res = await client.query(
      `SELECT * FROM interiors WHERE chat_id = $1 ORDER BY RANDOM() LIMIT 1`,
      [chatId]
    );
    return res.rows[0] || null;
  });
}

async function deleteInterior(chatId, interiorId) {
  return withClient(chatId, async (client) => {
    const res = await client.query(
      `DELETE FROM interiors WHERE chat_id = $1 AND id = $2 RETURNING id`,
      [chatId, interiorId]
    );
    return res.rowCount > 0;
  });
}

// ============================================
// Video Assets
// ============================================

async function createVideoAsset(chatId, { productImagePath, interiorId, correlationId, initiatingChannel }) {
  return withClient(chatId, async (client) => {
    const res = await client.query(
      `INSERT INTO video_assets
        (chat_id, product_image_path, interior_id, correlation_id, initiating_channel, status)
       VALUES ($1, $2, $3, $4, $5, 'pending')
       RETURNING *`,
      [chatId, productImagePath, interiorId || null, correlationId || null, initiatingChannel]
    );
    return res.rows[0];
  });
}

async function getVideoById(chatId, videoId) {
  return withClient(chatId, async (client) => {
    const res = await client.query(
      `SELECT va.*, i.description as interior_description, i.style as interior_style
       FROM video_assets va
       LEFT JOIN interiors i ON va.interior_id = i.id
       WHERE va.chat_id = $1 AND va.id = $2`,
      [chatId, videoId]
    );
    return res.rows[0] || null;
  });
}

async function updateVideoStatus(chatId, videoId, status, extra = {}) {
  return withClient(chatId, async (client) => {
    const fields = ['status = $1', 'updated_at = NOW()'];
    const values = [status];
    let idx = 2;

    if (extra.sceneImagePath) {
      fields.push(`scene_image_path = $${idx}`);
      values.push(extra.sceneImagePath);
      idx++;
    }
    if (extra.videoPath) {
      fields.push(`video_path = $${idx}`);
      values.push(extra.videoPath);
      idx++;
    }
    if (extra.videoDuration) {
      fields.push(`video_duration = $${idx}`);
      values.push(extra.videoDuration);
      idx++;
    }
    if (extra.fileSize) {
      fields.push(`file_size = $${idx}`);
      values.push(extra.fileSize);
      idx++;
    }
    if (extra.errorText) {
      fields.push(`error_text = $${idx}`);
      values.push(extra.errorText);
      idx++;
    }

    values.push(chatId, videoId);
    const res = await client.query(
      `UPDATE video_assets SET ${fields.join(', ')} WHERE chat_id = $${idx} AND id = $${idx + 1} RETURNING *`,
      values
    );
    return res.rows[0] || null;
  });
}

/**
 * Получить видео, которое ещё НЕ использовано данным каналом.
 * Статус: video_ready или published.
 * Использует SELECT ... FOR UPDATE SKIP LOCKED для конкурентного доступа.
 */
async function getAvailableVideoForChannel(chatId, channelType) {
  return withTransaction(chatId, async (client) => {
    // FOR UPDATE SKIP LOCKED нельзя применять к nullable стороне LEFT JOIN,
    // поэтому сначала блокируем строку в video_assets, затем делаем JOIN отдельно.
    const lockRes = await client.query(
      `SELECT va.id
       FROM video_assets va
       WHERE va.chat_id = $1
         AND va.status IN ('video_ready', 'published')
         AND va.scheduled_deletion_at IS NULL
         AND va.id NOT IN (
           SELECT vcu.video_id FROM video_channel_usage vcu WHERE vcu.channel_type = $2
         )
       ORDER BY va.created_at ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED`,
      [chatId, channelType]
    );
    if (!lockRes.rows[0]) return null;

    const videoId = lockRes.rows[0].id;
    const res = await client.query(
      `SELECT va.*, i.description as interior_description, i.style as interior_style
       FROM video_assets va
       LEFT JOIN interiors i ON va.interior_id = i.id
       WHERE va.id = $1`,
      [videoId]
    );
    return res.rows[0] || null;
  });
}

async function getVideoStats(chatId) {
  return withClient(chatId, async (client) => {
    const res = await client.query(
      `SELECT status, COUNT(*) as count
       FROM video_assets
       WHERE chat_id = $1
       GROUP BY status`,
      [chatId]
    );
    const stats = { total: 0 };
    for (const row of res.rows) {
      stats[row.status] = parseInt(row.count);
      stats.total += parseInt(row.count);
    }
    return stats;
  });
}

async function listVideos(chatId, { status, limit = 100, offset = 0 } = {}) {
  return withClient(chatId, async (client) => {
    let sql = `
      SELECT va.*, i.description as interior_description, i.style as interior_style
      FROM video_assets va
      LEFT JOIN interiors i ON va.interior_id = i.id
      WHERE va.chat_id = $1
    `;
    const params = [chatId];

    if (status) {
      sql += ` AND va.status = $2`;
      params.push(status);
    }

    sql += ` ORDER BY va.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);

    const res = await client.query(sql, params);
    return res.rows;
  });
}

// ============================================
// Channel Usage Marks
// ============================================

/**
 * Legacy-функция — делегирует в markVideoUsedById
 * @deprecated Используйте markVideoUsedById(chatId, videoId, channelType)
 */
async function markVideoUsed(videoId, channelType) {
  throw new Error('markVideoUsed(videoId, channelType) is deprecated. Use markVideoUsedById(chatId, videoId, channelType) instead.');
}

async function getVideoUsageMarks(chatId, videoId) {
  return withClient(chatId, async (client) => {
    const res = await client.query(
      `SELECT channel_type, used_at FROM video_channel_usage WHERE video_id = $1 ORDER BY used_at`,
      [videoId]
    );
    return res.rows;
  });
}

/**
 * Улучшенная версия markVideoUsed — всегда через chatId
 */
async function markVideoUsedById(chatId, videoId, channelType) {
  return withTransaction(chatId, async (client) => {
    // Проверка существования
    const videoCheck = await client.query(
      `SELECT id, status FROM video_assets WHERE chat_id = $1 AND id = $2`,
      [chatId, videoId]
    );
    if (!videoCheck.rows[0]) throw new Error(`Video ${videoId} not found`);

    // Вставляем метку (игнорируем дубликаты)
    await client.query(
      `INSERT INTO video_channel_usage (video_id, channel_type)
       VALUES ($1, $2)
       ON CONFLICT (video_id, channel_type) DO NOTHING`,
      [videoId, channelType]
    );

    // Проверяем полноту
    const marksRes = await client.query(
      `SELECT channel_type FROM video_channel_usage WHERE video_id = $1`,
      [videoId]
    );
    const markedChannels = new Set(marksRes.rows.map(r => r.channel_type));
    const allUsed = CHANNELS.every(ch => markedChannels.has(ch));

    if (allUsed) {
      await client.query(
        `UPDATE video_assets
         SET status = 'published',
             all_channels_marked_at = NOW(),
             scheduled_deletion_at = NOW() + INTERVAL '60 minutes',
             updated_at = NOW()
         WHERE id = $1`,
        [videoId]
      );
    }

    return {
      allUsed,
      markedChannels: Array.from(markedChannels),
      remainingChannels: CHANNELS.filter(ch => !markedChannels.has(ch))
    };
  });
}

async function cancelDeletionSchedule(chatId, videoId) {
  return withClient(chatId, async (client) => {
    await client.query(
      `UPDATE video_assets
       SET scheduled_deletion_at = NULL, updated_at = NOW()
       WHERE chat_id = $1 AND id = $2`,
      [chatId, videoId]
    );
  });
}

// ============================================
// Cleanup
// ============================================

async function getExpiredVideos() {
  // Собираем по всем пользовательским БД — нужно итерироваться снаружи
  // Эта функция возвращает запрос для внешнего итератора
  return {
    query: `
      SELECT va.*, i.description as interior_description, i.style as interior_style
      FROM video_assets va
      LEFT JOIN interiors i ON va.interior_id = i.id
      WHERE va.scheduled_deletion_at IS NOT NULL
        AND va.scheduled_deletion_at < NOW()
        AND va.status != 'expired'
      ORDER BY va.scheduled_deletion_at ASC
    `
  };
}

async function getExpiredVideosForChat(chatId) {
  return withClient(chatId, async (client) => {
    const res = await client.query(
      `SELECT va.*, i.description as interior_description, i.style as interior_style
       FROM video_assets va
       LEFT JOIN interiors i ON va.interior_id = i.id
       WHERE va.chat_id = $1
         AND va.scheduled_deletion_at IS NOT NULL
         AND va.scheduled_deletion_at < NOW()
         AND va.status != 'expired'
       ORDER BY va.scheduled_deletion_at ASC`,
      [chatId]
    );
    return res.rows;
  });
}

async function markVideoExpired(chatId, videoId) {
  return withClient(chatId, async (client) => {
    await client.query(
      `UPDATE video_assets
       SET status = 'expired', updated_at = NOW()
       WHERE chat_id = $1 AND id = $2`,
      [chatId, videoId]
    );
  });
}

async function deleteVideoAsset(chatId, videoId) {
  return withClient(chatId, async (client) => {
    const res = await client.query(
      `DELETE FROM video_assets WHERE chat_id = $1 AND id = $2 RETURNING video_path, scene_image_path`,
      [chatId, videoId]
    );
    return res.rows[0] || null;
  });
}

// ============================================
// Exports
// ============================================

module.exports = {
  ensureSchema,

  // Interiors
  addInterior,
  getInteriors,
  getRandomInterior,
  deleteInterior,

  // Video Assets
  createVideoAsset,
  getVideoById,
  updateVideoStatus,
  getAvailableVideoForChannel,
  listVideos,
  getVideoStats,

  // Channel Usage
  markVideoUsed,          // legacy — через videoId только
  markVideoUsedById,      // рекомендуемая — chatId + videoId
  getVideoUsageMarks,
  cancelDeletionSchedule,

  // Cleanup
  getExpiredVideos,
  getExpiredVideosForChat,
  markVideoExpired,
  deleteVideoAsset,

  // Helpers
  withClient,
  withTransaction,
  CHANNELS
};
