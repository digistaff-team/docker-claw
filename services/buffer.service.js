/**
 * Buffer GraphQL API — публикация через Buffer.com
 * Используется для Pinterest, Instagram и YouTube.
 * Документация: https://developers.buffer.com/guides/getting-started.html
 */
const fetch = require('node-fetch');

const BUFFER_GRAPHQL_URL = 'https://api.buffer.com/graphql';

/**
 * Создаёт пост в Buffer (режим shareNow).
 * @param {string} apiKey - Bearer токен Buffer API
 * @param {string} channelId - ID канала в Buffer (Pinterest/Instagram/YouTube channel)
 * @param {object} options
 * @param {string} options.text - Текст поста
 * @param {string} [options.imageUrl] - Публичный URL изображения (Pinterest, Instagram)
 * @param {string} [options.videoUrl] - Публичный URL видео (YouTube)
 * @param {string} [options.thumbnailUrl] - Публичный URL превью для YouTube
 * @param {string} [options.boardServiceId] - Pinterest board serviceId (обязателен для Pinterest)
 * @param {string} [options.youtubeTitle] - Заголовок YouTube видео (обязателен для YouTube)
 * @param {string} [options.youtubeCategoryId] - ID категории YouTube (обязателен для YouTube, default '24' Entertainment)
 * @returns {Promise<{postId: string}>}
 * @throws {Error} если Buffer вернул ошибку
 */
const MAX_RETRIES = 3;
const BACKOFF_MS = [15000, 30000, 60000];

async function createPost(apiKey, channelId, { text, imageUrl, videoUrl, thumbnailUrl, boardServiceId, youtubeTitle, youtubeCategoryId }) {
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
    assets: {}
  };

  // Видео-ассет (YouTube) — Buffer API: videos: [VideoAssetInput!]
  if (videoUrl) {
    const videoAsset = { url: videoUrl };
    if (thumbnailUrl) {
      videoAsset.thumbnailUrl = thumbnailUrl;
    }
    input.assets.videos = [videoAsset];
  }
  // Изображения (Pinterest, Instagram)
  else if (imageUrl) {
    input.assets.images = [{ url: imageUrl }];
  }

  if (boardServiceId) {
    input.metadata = { pinterest: { boardServiceId } };
  }

  // YouTube metadata (title и categoryId обязательны)
  if (youtubeTitle) {
    input.metadata = {
      ...input.metadata,
      youtube: {
        title: youtubeTitle,
        categoryId: youtubeCategoryId || '24'
      }
    };
  }

  const variables = { input };
  console.log('[BUFFER] createPost input:', JSON.stringify(input));

  let lastError = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const response = await fetch(BUFFER_GRAPHQL_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ query, variables })
    });

    // Handle 429 Rate Limit with retry
    if (response.status === 429 && attempt < MAX_RETRIES) {
      const retryAfter = parseInt(response.headers.get('retry-after'), 10);
      const delayMs = retryAfter ? retryAfter * 1000 : BACKOFF_MS[attempt];
      console.log(`[BUFFER] Rate limited, retry ${attempt + 1}/${MAX_RETRIES} in ${delayMs}ms`);
      await new Promise(r => setTimeout(r, delayMs));
      lastError = new Error(`Buffer API rate limited (429), retried ${attempt + 1}/${MAX_RETRIES} times`);
      continue;
    }

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

  // All retries exhausted
  throw lastError || new Error('Buffer API rate limited, all retries exhausted');
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

/**
 * Получает список всех каналов из Buffer API.
 * @param {string} apiKey - Bearer токен Buffer API
 * @returns {Promise<Array<{id: string, name: string, service: string, serviceId: string}>>}
 */
async function getChannels(apiKey) {
  if (!apiKey) {
    throw new Error('buffer_api_key обязателен');
  }

  const query = `
    query {
      account {
        channels {
          id
          name
          service
          serviceId
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
    body: JSON.stringify({ query })
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

  const channels = data?.data?.account?.channels;
  if (!channels) {
    throw new Error('Buffer API: не удалось получить список каналов');
  }

  return channels;
}

module.exports = { createPost, testConnection, getPinterestBoards, getChannels };
