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
 * @param {string} [options.boardServiceId] - Pinterest board serviceId (обязателен для Pinterest)
 * @returns {Promise<{postId: string}>}
 * @throws {Error} если Buffer вернул ошибку
 */
async function createPost(apiKey, channelId, { text, imageUrl, boardServiceId }) {
  const query = `
    mutation CreatePost($input: CreatePostInput!) {
      createPost(input: $input) {
        __typename
        ... on PostActionSuccess {
          post {
            id
            status
          }
        }
        ... on UnexpectedError { message }
        ... on NotFoundError { message }
        ... on InvalidInputError { message }
        ... on UnauthorizedError { message }
        ... on RestProxyError { message }
        ... on LimitReachedError { message }
      }
    }
  `;

  const input = {
    channelId,
    text,
    schedulingType: 'automatic',
    mode: 'shareNow',
    assets: {
      images: [{ url: imageUrl }]
    }
  };

  if (boardServiceId) {
    input.metadata = { pinterest: { boardServiceId } };
  }

  const variables = { input };
  console.log('[BUFFER] createPost input:', JSON.stringify(input));

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

  const result = data?.data?.createPost;
  console.log('[BUFFER] createPost response:', JSON.stringify(result));

  if (result?.__typename && result.__typename !== 'PostActionSuccess') {
    throw new Error(`Buffer API: ${result.message || result.__typename}`);
  }

  const postId = result?.post?.id;
  if (!postId) {
    throw new Error('Buffer createPost: no post id in response');
  }

  return { postId };
}

/**
 * Проверяет соединение с Buffer API.
 * Делает запрос channel(id) для валидации apiKey и channelId.
 * @param {string} apiKey - Bearer токен Buffer API
 * @param {string} channelId - ID канала в Buffer
 * @returns {Promise<{ok: boolean, channelName?: string, service?: string}>}
 */
async function testConnection(apiKey, channelId) {
  if (!apiKey || !channelId) {
    throw new Error('buffer_api_key и buffer_channel_id обязательны');
  }

  const query = `
    query GetChannel($channelId: ChannelId!) {
      channel(input: { id: $channelId }) {
        id
        name
        service
      }
    }
  `;

  const response = await fetch(BUFFER_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ query, variables: { channelId } })
  });

  if (!response.ok) {
    if (response.status === 429) {
      return { ok: true, channelName: channelId, service: 'pinterest', rateLimited: true };
    }
    const body = await response.text().catch(() => '');
    throw new Error(`Buffer API HTTP error ${response.status}: ${body}`);
  }

  const data = await response.json();

  if (data.errors && data.errors.length > 0) {
    const msg = data.errors.map((e) => e.message).join('; ');
    throw new Error(`Buffer GraphQL error: ${msg}`);
  }

  const channel = data?.data?.channel;
  if (!channel) {
    throw new Error(`Канал ${channelId} не найден в Buffer`);
  }

  return { ok: true, channelName: channel.name, service: channel.service };
}

/**
 * Получает список досок Pinterest через Buffer API.
 * @param {string} apiKey - Bearer токен Buffer API
 * @param {string} channelId - ID канала Pinterest в Buffer
 * @returns {Promise<Array<{id: string, serviceId: string, name: string, url: string}>>}
 */
async function getPinterestBoards(apiKey, channelId) {
  if (!apiKey || !channelId) {
    throw new Error('buffer_api_key и buffer_channel_id обязательны');
  }

  const query = `
    query GetPinterestBoards($channelId: ChannelId!) {
      channel(input: { id: $channelId }) {
        id
        name
        service
        metadata {
          ... on PinterestMetadata {
            boards {
              id
              serviceId
              name
              url
              description
              avatar
            }
          }
        }
      }
    }
  `;

  const response = await fetch(BUFFER_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ query, variables: { channelId } })
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Buffer API HTTP error ${response.status}: ${body}`);
  }

  const data = await response.json();

  if (data.errors && data.errors.length > 0) {
    const msg = data.errors.map((e) => e.message).join('; ');
    throw new Error(`Buffer GraphQL error: ${msg}`);
  }

  const metadata = data?.data?.channel?.metadata;
  if (!metadata || !metadata.boards) {
    throw new Error('Канал не содержит данных Pinterest или не является Pinterest-каналом');
  }

  return metadata.boards;
}

module.exports = { createPost, testConnection, getPinterestBoards };
