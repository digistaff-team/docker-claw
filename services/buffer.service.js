/**
 * Buffer API клиент для публикации в Instagram
 * Упрощённая альтернатива Instagram Graph API
 * 
 * Документация: https://buffer.com/developers/api
 * Требуется: BUFFER_API_KEY в .env
 */
const https = require('https');
const fetch = require('node-fetch');

const BUFFER_API_BASE = 'https://api.bufferapp.com/1';
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 2000;

// --- HTTP helpers ---

async function request(url, options = {}) {
    const response = await fetch(url, {
        ...options,
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            ...(options.headers || {})
        },
        timeout: 30000
    });

    const text = await response.text();
    let json;
    try { json = JSON.parse(text); } catch { json = null; }

    return {
        status: response.status,
        headers: response.headers,
        body: text,
        json
    };
}

async function retryRequest(url, options, retries = MAX_RETRIES) {
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const res = await request(url, options);
            // Rate limit: HTTP 429
            if (res.status === 429 && attempt < retries) {
                const delay = RETRY_BASE_MS * Math.pow(2, attempt);
                console.log(`[Buffer] Rate limited, retry in ${delay}ms`);
                await new Promise(r => setTimeout(r, delay));
                continue;
            }
            return res;
        } catch (e) {
            if (attempt >= retries) throw e;
            const delay = RETRY_BASE_MS * Math.pow(2, attempt);
            await new Promise(r => setTimeout(r, delay));
        }
    }
}

/**
 * Получить информацию о профиле (Instagram аккаунте)
 * @param {string} accessToken - Buffer API access token
 * @returns {Array} - список подключенных профилей
 */
async function getProfiles(accessToken) {
    const url = `${BUFFER_API_BASE}/profiles.json`;
    const res = await retryRequest(url, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${accessToken}` }
    });

    if (res.json?.error) {
        throw new Error(`Buffer API error: ${res.json.error}`);
    }

    return res.json || [];
}

/**
 * Создать пост (update) в Buffer
 * @param {string} accessToken - Buffer API access token
 * @param {Object} params - { profileIds, text, mediaIds, scheduled_at, now }
 * @returns {Object} - { id, profile_ids, text, media, scheduled_at }
 */
async function createShare(accessToken, params) {
    const url = `${BUFFER_API_BASE}/shares/create.json`;

    const formData = new URLSearchParams();

    // Текст поста (caption)
    if (params.text) formData.append('text', params.text);

    // ID профилей для публикации (массив)
    const profileIds = Array.isArray(params.profileIds)
        ? params.profileIds
        : [params.profileIds];

    for (const profileId of profileIds) {
        formData.append('profile_ids[]', profileId);
    }

    // ID медиа (изображения/видео)
    if (params.mediaIds && Array.isArray(params.mediaIds)) {
        for (const mediaId of params.mediaIds) {
            formData.append('media_ids[]', mediaId);
        }
    }

    // Публикация сейчас или по расписанию
    if (params.now === true) {
        formData.append('now', 'true');
    } else if (params.scheduled_at) {
        formData.append('scheduled_at', params.scheduled_at);
    }

    // Top (приоритетная публикация)
    if (params.top === true) {
        formData.append('top', 'true');
    }

    console.log(`[Buffer] createShare: profiles=${profileIds.join(',')}, text="${(params.text || '').slice(0, 50)}..."`);

    const res = await retryRequest(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: formData
    });

    if (res.json?.error) {
        const err = res.json.error;
        console.error(`[Buffer-API] createShare error: ${err}`);
        throw new Error(`Buffer API error: ${err}`);
    }

    return res.json;
}

/**
 * Загрузить медиа (изображение) в Buffer
 * @param {string} accessToken - Buffer API access token
 * @param {string} imageUrl - публичный URL изображения
 * @param {string} altText - альтернативный текст (accessibility)
 * @returns {{ id: string, url: string }} - media ID и URL
 */
async function uploadMedia(accessToken, imageUrl, altText = '') {
    const url = `${BUFFER_API_BASE}/media.json`;

    const formData = new URLSearchParams();
    formData.append('url', imageUrl);
    if (altText) formData.append('alt_text', altText);

    console.log(`[Buffer] uploadMedia: url=${imageUrl.substring(0, 60)}...`);

    const res = await retryRequest(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: formData
    });

    if (res.json?.error) {
        throw new Error(`Buffer API upload error: ${res.json.error}`);
    }

    return res.json;
}

/**
 * Получить информацию о share (посте)
 * @param {string} accessToken
 * @param {string} shareId - ID поста
 * @returns {Object} - информация о посте
 */
async function getShare(accessToken, shareId) {
    const url = `${BUFFER_API_BASE}/shares/${shareId}.json`;

    const res = await retryRequest(url, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${accessToken}` }
    });

    if (res.json?.error) {
        throw new Error(`Buffer API error: ${res.json.error}`);
    }

    return res.json;
}

/**
 * Обновить пост (изменить текст или расписание)
 * @param {string} accessToken
 * @param {string} shareId - ID поста
 * @param {Object} params - { text, scheduled_at, media_ids }
 */
async function updateShare(accessToken, shareId, params) {
    const url = `${BUFFER_API_BASE}/shares/${shareId}/update.json`;

    const formData = new URLSearchParams();
    if (params.text) formData.append('text', params.text);
    if (params.scheduled_at) formData.append('scheduled_at', params.scheduled_at);
    if (params.media_ids && Array.isArray(params.media_ids)) {
        for (const id of params.media_ids) {
            formData.append('media_ids[]', id);
        }
    }

    console.log(`[Buffer] updateShare: id=${shareId}`);

    const res = await retryRequest(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: formData
    });

    if (res.json?.error) {
        throw new Error(`Buffer API error: ${res.json.error}`);
    }

    return res.json;
}

/**
 * Удалить пост из очереди
 * @param {string} accessToken
 * @param {string} shareId - ID поста
 */
async function deleteShare(accessToken, shareId) {
    const url = `${BUFFER_API_BASE}/shares/${shareId}/destroy.json`;

    console.log(`[Buffer] deleteShare: id=${shareId}`);

    const res = await retryRequest(url, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${accessToken}` }
    });

    if (res.json?.error) {
        throw new Error(`Buffer API error: ${res.json.error}`);
    }

    return res.json;
}

/**
 * Высокоуровневая: опубликовать пост в Instagram через Buffer
 * @param {Object} params
 * @param {string} params.accessToken - Buffer API access token
 * @param {string} params.profileId - Instagram profile ID из getProfiles()
 * @param {string} params.imageUrl - публичный URL изображения
 * @param {string} params.caption - текст поста
 * @param {string} params.altText - альтернативный текст (опционально)
 * @param {boolean} params.now - опубликовать сейчас (true) или по расписанию
 * @param {string} params.scheduledAt - ISO 8601 timestamp (если now=false)
 * @returns {{ shareId: string, profileId: string }}
 */
async function publishToInstagram({
    accessToken,
    profileId,
    imageUrl,
    caption,
    altText = '',
    now = true,
    scheduledAt = null
}) {
    if (!accessToken) throw new Error('Buffer access_token отсутствует');
    if (!profileId) throw new Error('profileId отсутствует');
    if (!imageUrl) throw new Error('imageUrl обязателен');
    if (!caption) throw new Error('caption обязателен');

    console.log(`[Buffer] publishToInstagram: profileId=${profileId}, now=${now}`);

    // Шаг 1: Загрузка медиа
    const media = await uploadMedia(accessToken, imageUrl, altText);
    const mediaId = media.id;

    if (!mediaId) {
        throw new Error('Buffer API: не получен media_id');
    }
    console.log(`[Buffer] Media uploaded: ${mediaId}`);

    // Шаг 2: Создание поста
    const share = await createShare(accessToken, {
        profileIds: [profileId],
        text: caption,
        mediaIds: [mediaId],
        now,
        scheduled_at: scheduledAt
    });

    console.log(`[Buffer] Post created: shareId=${share?.id}`);

    return {
        shareId: share?.id,
        profileId,
        mediaId,
        scheduledAt: share?.scheduled_at
    };
}

/**
 * Валидация параметров Buffer
 */
function validateBufferParams({ accessToken, profileId, caption }) {
    const errors = [];
    if (!accessToken) errors.push('access_token обязателен');
    if (!profileId) errors.push('profileId обязателен');
    if (caption && caption.length > 2200) errors.push('Подпись слишком длинная (макс. 2200 символов)');
    return { valid: errors.length === 0, errors };
}

module.exports = {
    getProfiles,
    createShare,
    uploadMedia,
    getShare,
    updateShare,
    deleteShare,
    publishToInstagram,
    validateBufferParams
};
