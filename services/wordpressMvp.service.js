/**
 * WordPress MVP Service — публикация статей в WordPress
 * REST API v2 клиент с Basic Auth (Application Passwords)
 */
const fetch = require('node-fetch');
const config = require('../config');
const manageStore = require('../manage/store');

// ============================================
// Вспомогательные функции
// ============================================

/**
 * Получить конфигурацию WordPress для пользователя
 */
function getWpConfig(chatId) {
  return manageStore.getWpConfig(chatId);
}

/**
 * Создать заголовок Basic Auth для WordPress Application Passwords
 */
function getAuthHeader(chatId) {
  const wpConfig = getWpConfig(chatId);
  if (!wpConfig || !wpConfig.baseUrl || !wpConfig.username || !wpConfig.appPassword) {
    throw new Error('WordPress not configured for this chat. Call connect() first.');
  }

  const credentials = `${wpConfig.username}:${wpConfig.appPassword}`;
  const base64 = Buffer.from(credentials).toString('base64');
  return `Basic ${base64}`;
}

/**
 * Выполнить HTTP запрос с проверкой статуса
 */
async function wpRequest(chatId, method, path, options = {}) {
  const wpConfig = getWpConfig(chatId);
  const baseUrl = wpConfig.baseUrl.replace(/\/+$/, ''); // убрать trailing slashes
  const url = `${baseUrl}${path}`;
  const authHeader = getAuthHeader(chatId);

  const fetchOptions = {
    method,
    headers: {
      'Authorization': authHeader,
      'Content-Type': 'application/json',
      ...options.headers
    },
    timeout: options.timeout || 30000
  };

  if (options.body) {
    fetchOptions.body = JSON.stringify(options.body);
  }

  const response = await fetch(url, fetchOptions);

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`WordPress API error (${response.status}): ${errorText}`);
  }

  return response;
}

// ============================================
// Публичные методы
// ============================================

/**
 * Проверить подключение к WordPress
 * GET /wp-json
 */
async function ping(chatId) {
  try {
    const wpConfig = getWpConfig(chatId);
    if (!wpConfig || !wpConfig.baseUrl) {
      return { ok: false, error: 'WordPress baseUrl not configured' };
    }

    const response = await wpRequest(chatId, 'GET', '/wp-json');
    const data = await response.json();

    // Проверяем, что это действительно WordPress
    if (data.name || data.namespaces) {
      return { ok: true, siteName: data.name || 'WordPress' };
    }

    return { ok: false, error: 'Invalid WordPress response' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Загрузить медиафайл в WordPress
 * POST /wp-json/wp/v2/media
 * multipart/form-data
 */
async function uploadMedia(chatId, { buffer, filename, mimeType, altText, title }) {
  const wpConfig = getWpConfig(chatId);
  const baseUrl = wpConfig.baseUrl.replace(/\/+$/, '');
  const url = `${baseUrl}/wp-json/wp/v2/media`;
  const authHeader = getAuthHeader(chatId);

  // Формируем multipart/form-data вручную через边界 (boundary)
  const boundary = `----WordPressFormBoundary${Date.now()}`;
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\n`),
    Buffer.from(`Content-Disposition: form-data; name="file"; filename="${filename}"\r\n`),
    Buffer.from(`Content-Type: ${mimeType || 'image/jpeg'}\r\n\r\n`),
    buffer,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ]);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': authHeader,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Disposition': `attachment; filename="${filename}"`
    },
    body,
    timeout: 60000
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`WordPress media upload failed (${response.status}): ${errorText}`);
  }

  const media = await response.json();

  // Если передан altText, обновляем мета-данные изображения
  if (altText && media.id) {
    await wpRequest(chatId, 'POST', `/wp-json/wp/v2/media/${media.id}`, {
      body: { alt_text: altText, title: title || filename }
    });
  }

  return {
    id: media.id,
    source_url: media.source_url,
    link: media.link,
    mimeType: media.media_details?.mime_type || mimeType,
    filename: media.media_details?.file || filename
  };
}

/**
 * Создать черновик статьи
 * POST /wp-json/wp/v2/posts со status='draft'
 */
async function createDraft(chatId, { title, content, excerpt, categories, featured_media, slug }) {
  const wpConfig = getWpConfig(chatId);

  const body = {
    title: title || 'Untitled',
    content: content || '',
    excerpt: excerpt || '',
    status: 'draft',
    slug: slug || null,
    categories: categories || [],
    featured_media: featured_media || 0
  };

  // Если категория не указана, используем defaultCategoryId
  if (!body.categories || body.categories.length === 0) {
    if (wpConfig.defaultCategoryId) {
      body.categories = [wpConfig.defaultCategoryId];
    }
  }

  const response = await wpRequest(chatId, 'POST', '/wp-json/wp/v2/posts', { body });
  const post = await response.json();

  // Формируем preview URL для модерации
  const previewUrl = `${post.link}?preview=true&preview_id=${post.id}`;

  return {
    id: post.id,
    link: post.link,
    preview_link: previewUrl,
    status: post.status,
    title: post.title?.rendered || title,
    slug: post.slug
  };
}

/**
 * Опубликовать черновик
 * POST /wp-json/wp/v2/posts/{id} со status='publish'
 */
async function publishPost(chatId, wpPostId) {
  const response = await wpRequest(chatId, 'POST', `/wp-json/wp/v2/posts/${wpPostId}`, {
    body: { status: 'publish' }
  });
  const post = await response.json();

  return {
    id: post.id,
    link: post.link,
    status: post.status,
    title: post.title?.rendered
  };
}

/**
 * Удалить пост (для rollback при rewrite)
 * DELETE /wp-json/wp/v2/posts/{id}?force=true
 */
async function deletePost(chatId, wpPostId) {
  const response = await wpRequest(chatId, 'DELETE', `/wp-json/wp/v2/posts/${wpPostId}?force=true`);

  // DELETE может вернуть 200 с { deleted: true } или просто 200
  try {
    const data = await response.json();
    return { deleted: true, data };
  } catch {
    return { deleted: response.ok };
  }
}

/**
 * Обновить черновик (PATCH) — используется при rewrite
 * POST /wp-json/wp/v2/posts/{id}
 */
async function updateDraft(chatId, wpPostId, { title, content, excerpt, featured_media } = {}) {
  const body = {};
  if (title !== undefined) body.title = title;
  if (content !== undefined) body.content = content;
  if (excerpt !== undefined) body.excerpt = excerpt;
  if (featured_media !== undefined) body.featured_media = featured_media;

  if (Object.keys(body).length === 0) {
    throw new Error('No fields to update');
  }

  const response = await wpRequest(chatId, 'POST', `/wp-json/wp/v2/posts/${wpPostId}`, { body });
  const post = await response.json();

  return {
    id: post.id,
    link: post.link,
    status: post.status,
    title: post.title?.rendered
  };
}

/**
 * Получить категории WordPress (для UI выбора категории по умолчанию)
 * GET /wp-json/wp/v2/categories
 */
async function getCategories(chatId) {
  const response = await wpRequest(chatId, 'GET', '/wp-json/wp/v2/categories?per_page=100');
  const categories = await response.json();

  return categories.map(cat => ({
    id: cat.id,
    name: cat.name,
    slug: cat.slug,
    count: cat.count || 0
  }));
}

// ============================================
// Регистрация обработчиков задач в worker
// ============================================

/**
 * Инициализация WordPress worker handlers
 */
function initWorkerHandlers() {
  const worker = require('./content/worker');

  // Обработчик генерации статей
  worker.registerJobHandler('wordpress_generate', async (chatId, job, bot, correlationId) => {
    const { handleWordPressGeneration } = require('./content/worker');
    return handleWordPressGeneration(chatId, job, bot);
  });

  // Обработчик публикации постов
  worker.registerJobHandler('wordpress_publish', async (chatId, job, bot, correlationId) => {
    const { handleWordPressPublish } = require('./content/worker');
    return handleWordPressPublish(chatId, job, bot);
  });

  console.log('[WP-MVP] Worker handlers registered');
}

module.exports = {
  ping,
  uploadMedia,
  createDraft,
  publishPost,
  deletePost,
  updateDraft,
  getCategories,
  initWorkerHandlers
};
