/**
 * Buffer GraphQL API — публикация через Buffer.com
 * Используется для Pinterest (и Instagram).
 * Документация: https://developers.buffer.com/guides/getting-started.html
 */
const fetch = require('node-fetch');

const BUFFER_GRAPHQL_URL = 'https://api.buffer.com/graphql';

/**
 * Создаёт пост в Buffer (режим shareNow).
 * @param {string} apiKey - Bearer токен Buffer API
 * @param {string} channelId - ID канала в Buffer (Pinterest/Instagram channel)
 * @param {object} options
 * @param {string} options.text - Текст поста
 * @param {string} options.imageUrl - Публичный URL изображения
 * @returns {Promise<{postId: string}>}
 * @throws {Error} если Buffer вернул ошибку
 */
async function createPost(apiKey, channelId, { text, imageUrl }) {
  const query = `
    mutation CreatePost($input: CreatePostInput!) {
      createPost(input: $input) {
        post {
          id
          status
        }
        errors {
          message
          code
        }
      }
    }
  `;

  const variables = {
    input: {
      channelId,
      text,
      schedulingType: 'automatic',
      mode: 'shareNow',
      assets: {
        images: [{ url: imageUrl }]
      }
    }
  };

  const response = await fetch(BUFFER_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ query, variables })
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Buffer API HTTP error ${response.status}: ${body}`);
  }

  const data = await response.json();

  // GraphQL ошибки на уровне схемы
  if (data.errors && data.errors.length > 0) {
    const msg = data.errors.map((e) => e.message).join('; ');
    throw new Error(`Buffer GraphQL error: ${msg}`);
  }

  // MutationError внутри ответа
  const mutationErrors = data?.data?.createPost?.errors;
  if (mutationErrors && mutationErrors.length > 0) {
    const msg = mutationErrors.map((e) => e.message).join('; ');
    throw new Error(`Buffer createPost error: ${msg}`);
  }

  const postId = data?.data?.createPost?.post?.id;
  if (!postId) {
    throw new Error('Buffer createPost: no post id in response');
  }

  return { postId };
}

module.exports = { createPost };
