/**
 * Репозиторий для блог-постов WordPress
 * CRUD операции для постов, статусы, модерация
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
 * Создать запись для блог-поста в content_posts
 */
async function createDraftPost(chatId, data) {
  return withClient(chatId, async (client) => {
    const result = await client.query(
      `INSERT INTO content_posts
        (job_id, body_text, body_html, seo_title, meta_desc, featured_image_url,
         wp_media_id, wp_post_id, wp_permalink, wp_preview_url, moderator_note,
         content_type, publish_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING id`,
      [
        data.jobId || null,
        data.bodyText || '',
        data.bodyHtml || null,
        data.seoTitle || null,
        data.metaDesc || null,
        data.featuredImageUrl || null,
        data.wpMediaId || null,
        data.wpPostId || null,
        data.wpPermalink || null,
        data.wpPreviewUrl || null,
        data.moderatorNote || null,
        data.contentType || 'blog',
        data.publishStatus || 'draft'
      ]
    );
    return result.rows[0].id;
  });
}

/**
 * Обновить WordPress IDs и URLs для поста
 */
async function updateWpIds(chatId, postId, { wpMediaId, wpPostId, wpPermalink, wpPreviewUrl, bodyHtml, seoTitle, metaDesc, featuredImageUrl } = {}) {
  return withClient(chatId, async (client) => {
    const fields = [];
    const values = [];
    let idx = 1;

    if (wpMediaId !== undefined) {
      fields.push(`wp_media_id = $${idx++}`);
      values.push(wpMediaId);
    }
    if (wpPostId !== undefined) {
      fields.push(`wp_post_id = $${idx++}`);
      values.push(wpPostId);
    }
    if (wpPermalink !== undefined) {
      fields.push(`wp_permalink = $${idx++}`);
      values.push(wpPermalink);
    }
    if (wpPreviewUrl !== undefined) {
      fields.push(`wp_preview_url = $${idx++}`);
      values.push(wpPreviewUrl);
    }
    if (bodyHtml !== undefined) {
      fields.push(`body_html = $${idx++}`);
      values.push(bodyHtml);
    }
    if (seoTitle !== undefined) {
      fields.push(`seo_title = $${idx++}`);
      values.push(seoTitle);
    }
    if (metaDesc !== undefined) {
      fields.push(`meta_desc = $${idx++}`);
      values.push(metaDesc);
    }
    if (featuredImageUrl !== undefined) {
      fields.push(`featured_image_url = $${idx++}`);
      values.push(featuredImageUrl);
    }

    if (fields.length === 0) return;

    fields.push(`updated_at = NOW()`);
    values.push(postId);

    await client.query(
      `UPDATE content_posts SET ${fields.join(', ')} WHERE id = $${idx}`,
      values
    );
  });
}

/**
 * Обновить статус поста
 */
async function updatePostStatus(chatId, postId, status, errorText = null) {
  return withClient(chatId, async (client) => {
    const fields = ['publish_status = $1', 'updated_at = NOW()'];
    const values = [status];

    if (errorText !== null) {
      fields.push(`moderator_note = $${values.length + 1}`);
      values.push(errorText);
    }

    values.push(postId);

    await client.query(
      `UPDATE content_posts SET ${fields.join(', ')} WHERE id = $${values.length}`,
      values
    );
  });
}

/**
 * Отметить пост как готовый к модерации
 */
async function markReady(chatId, postId) {
  return updatePostStatus(chatId, postId, 'ready');
}

/**
 * Отметить пост как одобренный
 */
async function markApproved(chatId, postId) {
  return updatePostStatus(chatId, postId, 'approved');
}

/**
 * Отметить пост как опубликованный
 */
async function markPublished(chatId, postId, permalink = null) {
  if (permalink) {
    // Обновляем permalink перед сменой статуса
    await updateWpIds(chatId, postId, { wpPermalink: permalink });
  }
  return updatePostStatus(chatId, postId, 'published');
}

/**
 * Отметить пост с ошибкой
 */
async function markError(chatId, postId, errorText) {
  return updatePostStatus(chatId, postId, 'error', errorText);
}

/**
 * Вернуть пост в draft (для rewrite)
 */
async function markDraft(chatId, postId, moderatorNote = null) {
  return updatePostStatus(chatId, postId, 'draft', moderatorNote);
}

/**
 * Отметить пост как отклонённый
 */
async function markRejected(chatId, postId) {
  return updatePostStatus(chatId, postId, 'rejected');
}

/**
 * Прикрепить заметку модератора
 */
async function attachModeratorNote(chatId, postId, note) {
  return withClient(chatId, async (client) => {
    await client.query(
      `UPDATE content_posts SET moderator_note = $1, updated_at = NOW() WHERE id = $2`,
      [note, postId]
    );
  });
}

/**
 * Очистить заметку модератора
 */
async function clearModeratorNote(chatId, postId) {
  return withClient(chatId, async (client) => {
    await client.query(
      `UPDATE content_posts SET moderator_note = NULL, updated_at = NOW() WHERE id = $1`,
      [postId]
    );
  });
}

/**
 * Найти посты по статусу
 */
async function findByStatus(chatId, status) {
  return withClient(chatId, async (client) => {
    const result = await client.query(
      `SELECT * FROM content_posts
       WHERE publish_status = $1
       ORDER BY created_at DESC`,
      [status]
    );
    return result.rows;
  });
}

/**
 * Найти посты, ожидаующие модерации
 */
async function findPendingModeration(chatId) {
  return withClient(chatId, async (client) => {
    const result = await client.query(
      `SELECT id, job_id, seo_title, meta_desc, featured_image_url,
              wp_post_id, wp_preview_url, wp_permalink, moderator_note,
              created_at, updated_at
       FROM content_posts
       WHERE publish_status = 'ready' AND wp_post_id IS NOT NULL
       ORDER BY created_at ASC`
    );
    return result.rows;
  });
}

/**
 * Найти пост по ID
 */
async function getPostById(chatId, postId) {
  return withClient(chatId, async (client) => {
    const result = await client.query(
      `SELECT * FROM content_posts WHERE id = $1`,
      [postId]
    );
    return result.rows[0] || null;
  });
}

/**
 * Получить последние N постов
 */
async function getRecentPosts(chatId, limit = 10) {
  return withClient(chatId, async (client) => {
    const result = await client.query(
      `SELECT id, seo_title, wp_permalink, wp_preview_url, publish_status,
              featured_image_url, created_at, updated_at
       FROM content_posts
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit]
    );
    return result.rows;
  });
}

/**
 * Подсчитать опубликованные посты за день
 */
async function countPublishedToday(chatId, tz = 'Europe/Moscow') {
  const dateStr = new Intl.DateTimeFormat('sv-SE', { timeZone: tz }).format(new Date());
  return withClient(chatId, async (client) => {
    const result = await client.query(
      `SELECT COUNT(*)::int AS c
       FROM content_posts
       WHERE publish_status = 'published'
         AND to_char(updated_at AT TIME ZONE $1, 'YYYY-MM-DD') = $2`,
      [tz, dateStr]
    );
    return result.rows[0]?.c || 0;
  });
}

/**
 * Инкрементировать счётчик попыток генерации
 */
async function incrementGenerationAttempts(chatId, postId) {
  return withClient(chatId, async (client) => {
    // Для блог-постов используем content_jobs.image_attempts как счётчик
    await client.query(
      `UPDATE content_jobs
       SET image_attempts = image_attempts + 1, updated_at = NOW()
       WHERE id = (SELECT job_id FROM content_posts WHERE id = $1)`,
      [postId]
    );
  });
}

/**
 * Получить посты для публикации (approved, ждут отправки в WP)
 */
async function findReadyToPublish(chatId) {
  return withClient(chatId, async (client) => {
    const result = await client.query(
      `SELECT id, job_id, seo_title, meta_desc, body_html,
              featured_image_url, wp_post_id, wp_media_id
       FROM content_posts
       WHERE publish_status = 'approved' AND wp_post_id IS NOT NULL
       ORDER BY created_at ASC`
    );
    return result.rows;
  });
}

/**
 * Получить статистику постов по статусам
 */
async function getStatusStats(chatId) {
  return withClient(chatId, async (client) => {
    const result = await client.query(
      `SELECT publish_status, COUNT(*) AS count
       FROM content_posts
       GROUP BY publish_status
       ORDER BY count DESC`
    );
    const stats = {};
    for (const row of result.rows) {
      stats[row.publish_status] = parseInt(row.count, 10);
    }
    return stats;
  });
}

/**
 * Получить посты с ошибками
 */
async function findErrorPosts(chatId, limit = 20) {
  return withClient(chatId, async (client) => {
    const result = await client.query(
      `SELECT id, seo_title, moderator_note, wp_post_id, wp_preview_url,
              created_at, updated_at
       FROM content_posts
       WHERE publish_status = 'error'
       ORDER BY updated_at DESC
       LIMIT $1`,
      [limit]
    );
    return result.rows;
  });
}

/**
 * Связать пост с topic и отметить тему как использованную
 */
async function markTopicUsed(chatId, topicId, postId) {
  return withClient(chatId, async (client) => {
    await client.query('BEGIN');
    try {
      // Обновляем content_posts
      await client.query(
        `UPDATE content_posts SET updated_at = NOW() WHERE id = $1`,
        [postId]
      );

      // Отмечаем тему как использованную
      await client.query(
        `UPDATE content_topics SET used_at = NOW() WHERE id = $1`,
        [topicId]
      );

      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    }
  });
}

module.exports = {
  withClient,
  createDraftPost,
  updateWpIds,
  updatePostStatus,
  markReady,
  markApproved,
  markPublished,
  markError,
  markDraft,
  markRejected,
  attachModeratorNote,
  clearModeratorNote,
  findByStatus,
  findPendingModeration,
  getPostById,
  getRecentPosts,
  countPublishedToday,
  incrementGenerationAttempts,
  findReadyToPublish,
  getStatusStats,
  findErrorPosts,
  markTopicUsed
};
