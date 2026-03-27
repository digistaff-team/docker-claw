/**
 * Instagram Graph API клиент (v19.0)
 * Публикация фото и Reels через Facebook Graph API
 */
const https = require('https');

const IG_GRAPH_API = 'https://graph.facebook.com';
const IG_API_VERSION = process.env.INSTAGRAM_GRAPH_VERSION || 'v19.0';
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 2000;
const REEL_POLL_INTERVAL_MS = 5000;
const REEL_POLL_MAX_ATTEMPTS = 60; // 5 мин макс

// --- HTTP helpers ---

function request(url, options = {}) {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(url);
        const reqOptions = {
            hostname: urlObj.hostname,
            port: urlObj.port || 443,
            path: urlObj.pathname + urlObj.search,
            method: options.method || 'GET',
            headers: options.headers || {},
            timeout: options.timeout || 30000
        };

        const req = https.request(reqOptions, (res) => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                const body = Buffer.concat(chunks).toString();
                let json;
                try { json = JSON.parse(body); } catch { json = null; }
                resolve({ status: res.statusCode, headers: res.headers, body, json });
            });
        });

        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });

        if (options.body) req.write(options.body);
        req.end();
    });
}

async function retryRequest(url, options, retries = MAX_RETRIES) {
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const res = await request(url, options);
            // Instagram/Facebook rate limit: HTTP 429 or error code 4/17/32
            const errCode = res.json?.error?.code;
            if ((res.status === 429 || errCode === 4 || errCode === 17 || errCode === 32) && attempt < retries) {
                const delay = RETRY_BASE_MS * Math.pow(2, attempt);
                console.log(`[IG] Rate limited (code=${errCode}), retry in ${delay}ms`);
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

// --- Instagram Graph API methods ---

/**
 * Вызов Instagram/Facebook Graph API
 */
async function callInstagramApi(endpoint, params, accessToken) {
    const allParams = { ...params, access_token: accessToken };
    const body = new URLSearchParams(allParams).toString();
    const url = `${IG_GRAPH_API}/${IG_API_VERSION}${endpoint}`;

    const res = await retryRequest(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body
    });

    if (res.json?.error) {
        const err = res.json.error;
        console.error(`[IG-API] ${endpoint} error: code=${err.code}, type="${err.type}", msg="${err.message}"`);
        throw new Error(`Instagram API error ${err.code}: ${err.message}`);
    }

    return res.json;
}

/**
 * Вызов GET-запроса к Graph API
 */
async function callInstagramApiGet(endpoint, params, accessToken) {
    const allParams = { ...params, access_token: accessToken };
    const qs = new URLSearchParams(allParams).toString();
    const url = `${IG_GRAPH_API}/${IG_API_VERSION}${endpoint}?${qs}`;

    const res = await retryRequest(url, { method: 'GET', timeout: 15000 });

    if (res.json?.error) {
        const err = res.json.error;
        console.error(`[IG-API-GET] ${endpoint} error: code=${err.code}, msg="${err.message}"`);
        throw new Error(`Instagram API error ${err.code}: ${err.message}`);
    }

    return res.json;
}

/**
 * Создать медиа-контейнер (шаг 1 публикации)
 * @param {string} igUserId - Instagram Business Account ID
 * @param {string} accessToken - Facebook Page Access Token
 * @param {Object} opts - { imageUrl, videoUrl, caption, mediaType, thumbnailUrl }
 * @returns {{ id: string }} - creation_id
 */
async function createMediaContainer(igUserId, accessToken, opts = {}) {
    const params = {};

    if (opts.caption) params.caption = opts.caption;

    if (opts.mediaType === 'REELS' || opts.mediaType === 'reel') {
        params.media_type = 'REELS';
        if (opts.videoUrl) params.video_url = opts.videoUrl;
        if (opts.thumbnailUrl) params.thumb_offset = '0';
        params.share_to_feed = 'true';
    } else {
        // Photo (default)
        if (opts.imageUrl) params.image_url = opts.imageUrl;
    }

    if (opts.locationId) params.location_id = opts.locationId;

    console.log(`[IG-API] createMediaContainer: igUserId=${igUserId}, type=${opts.mediaType || 'IMAGE'}`);
    return callInstagramApi(`/${igUserId}/media`, params, accessToken);
}

/**
 * Опубликовать медиа-контейнер (шаг 2 публикации)
 * @param {string} igUserId
 * @param {string} accessToken
 * @param {string} creationId - ID из createMediaContainer
 * @returns {{ id: string }} - media_id
 */
async function publishMedia(igUserId, accessToken, creationId) {
    console.log(`[IG-API] publishMedia: igUserId=${igUserId}, creationId=${creationId}`);
    return callInstagramApi(`/${igUserId}/media_publish`, {
        creation_id: creationId
    }, accessToken);
}

/**
 * Проверить статус медиа-контейнера (для Reels/видео)
 * @param {string} mediaId - creation_id
 * @param {string} accessToken
 * @returns {{ status_code: string, status: string }}
 */
async function checkMediaStatus(mediaId, accessToken) {
    return callInstagramApiGet(`/${mediaId}`, {
        fields: 'status_code,status'
    }, accessToken);
}

/**
 * Получить информацию об Instagram-аккаунте
 */
async function getAccountInfo(igUserId, accessToken) {
    return callInstagramApiGet(`/${igUserId}`, {
        fields: 'biography,followers_count,username,profile_picture_url,media_count'
    }, accessToken);
}

/**
 * Высокоуровневая: опубликовать фото-пост
 * createMediaContainer → publishMedia
 */
async function publishPhotoPost({ accessToken, igUserId, imageUrl, caption, locationId }) {
    if (!accessToken) throw new Error('Instagram access_token отсутствует');
    if (!igUserId) throw new Error('Instagram ig_user_id отсутствует');
    if (!imageUrl) throw new Error('imageUrl обязателен для фото-поста');

    console.log(`[IG] publishPhotoPost: igUserId=${igUserId}, imageUrl=${imageUrl.substring(0, 60)}...`);

    // Шаг 1: Создание контейнера
    const container = await createMediaContainer(igUserId, accessToken, {
        imageUrl,
        caption,
        mediaType: 'IMAGE',
        locationId
    });

    if (!container?.id) {
        throw new Error('Instagram API: не получен creation_id');
    }
    console.log(`[IG] Container created: ${container.id}`);

    // Шаг 2: Публикация
    const result = await publishMedia(igUserId, accessToken, container.id);
    console.log(`[IG] Photo published: media_id=${result?.id}`);

    return { media_id: result?.id };
}

/**
 * Высокоуровневая: опубликовать Reel
 * createMediaContainer → polling checkMediaStatus → publishMedia
 */
async function publishReelPost({ accessToken, igUserId, videoUrl, caption, thumbnailUrl, locationId }) {
    if (!accessToken) throw new Error('Instagram access_token отсутствует');
    if (!igUserId) throw new Error('Instagram ig_user_id отсутствует');
    if (!videoUrl) throw new Error('videoUrl обязателен для Reel');

    console.log(`[IG] publishReelPost: igUserId=${igUserId}, videoUrl=${videoUrl.substring(0, 60)}...`);

    // Шаг 1: Создание контейнера
    const container = await createMediaContainer(igUserId, accessToken, {
        videoUrl,
        caption,
        mediaType: 'REELS',
        thumbnailUrl,
        locationId
    });

    if (!container?.id) {
        throw new Error('Instagram API: не получен creation_id для Reel');
    }
    console.log(`[IG] Reel container created: ${container.id}`);

    // Шаг 2: Polling статуса (видео требует обработки)
    for (let attempt = 0; attempt < REEL_POLL_MAX_ATTEMPTS; attempt++) {
        await new Promise(r => setTimeout(r, REEL_POLL_INTERVAL_MS));

        const status = await checkMediaStatus(container.id, accessToken);
        const code = status?.status_code;
        console.log(`[IG] Reel status poll #${attempt + 1}: ${code}`);

        if (code === 'FINISHED') {
            break;
        }
        if (code === 'ERROR') {
            throw new Error(`Instagram Reel processing failed: ${status?.status || 'unknown error'}`);
        }
        // IN_PROGRESS — продолжаем ждать
    }

    // Шаг 3: Публикация
    const result = await publishMedia(igUserId, accessToken, container.id);
    console.log(`[IG] Reel published: media_id=${result?.id}`);

    return { media_id: result?.id };
}

/**
 * Валидация параметров Instagram
 */
function validateInstagramParams({ igUserId, accessToken, caption }) {
    const errors = [];
    if (!igUserId) errors.push('ig_user_id обязателен');
    if (!accessToken) errors.push('access_token обязателен');
    if (caption && caption.length > 2200) errors.push('Подпись слишком длинная (макс. 2200 символов)');
    return { valid: errors.length === 0, errors };
}

module.exports = {
    callInstagramApi,
    callInstagramApiGet,
    createMediaContainer,
    publishMedia,
    checkMediaStatus,
    getAccountInfo,
    publishPhotoPost,
    publishReelPost,
    validateInstagramParams
};
