/**
 * VK API v5.199 клиент
 * Публикация на стену группы, загрузка фото, Stories
 */
const https = require('https');
const manageStore = require('../manage/store');

const VK_API = 'https://api.vk.com/method';
const VK_API_VERSION = '5.199';
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 2000;

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
            // VK rate limit: error code 6
            if (res.json?.error?.error_code === 6 && attempt < retries) {
                const delay = RETRY_BASE_MS * Math.pow(2, attempt);
                console.log(`[VK] Rate limited, retry in ${delay}ms`);
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

// --- VK API methods ---

/**
 * Вызов VK API метода
 */
async function callVkApi(method, params, serviceKey) {
    const allParams = {
        ...params,
        access_token: serviceKey,
        v: VK_API_VERSION
    };

    const body = new URLSearchParams(allParams).toString();

    const res = await retryRequest(`${VK_API}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body
    });

    if (res.json?.error) {
        const err = res.json.error;
        throw new Error(`VK API ${method} error ${err.error_code}: ${err.error_msg}`);
    }

    return res.json?.response;
}

/**
 * Получить URL для загрузки фото на стену
 */
async function getWallUploadServer(serviceKey, groupId) {
    return callVkApi('photos.getWallUploadServer', {
        group_id: groupId
    }, serviceKey);
}

/**
 * Загрузить фото на сервер VK (multipart/form-data)
 */
async function uploadPhoto(uploadUrl, imageBuffer, filename = 'photo.png') {
    const boundary = '----VkFormBoundary' + Date.now().toString(36);
    const contentType = filename.endsWith('.jpg') || filename.endsWith('.jpeg')
        ? 'image/jpeg' : 'image/png';

    const header = Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="photo"; filename="${filename}"\r\n` +
        `Content-Type: ${contentType}\r\n\r\n`
    );
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([header, imageBuffer, footer]);

    const res = await retryRequest(uploadUrl, {
        method: 'POST',
        headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': body.length
        },
        body,
        timeout: 60000
    });

    if (!res.json || res.json.error) {
        throw new Error(`VK photo upload failed: ${res.body?.slice(0, 300)}`);
    }

    return res.json;
}

/**
 * Сохранить загруженное фото на стене
 */
async function saveWallPhoto(serviceKey, groupId, uploadResult) {
    return callVkApi('photos.saveWallPhoto', {
        group_id: groupId,
        photo: uploadResult.photo,
        server: uploadResult.server,
        hash: uploadResult.hash
    }, serviceKey);
}

/**
 * Опубликовать пост на стене группы с фото
 */
async function publishPhotoPost({ serviceKey, groupId, text, imageBuffer, params = {} }) {
    if (!serviceKey) throw new Error('VK service_key отсутствует');
    if (!groupId) throw new Error('VK group_id отсутствует');

    let attachments = '';

    if (imageBuffer) {
        // 1. Получить upload URL
        const server = await getWallUploadServer(serviceKey, groupId);
        // 2. Загрузить фото
        const uploadResult = await uploadPhoto(server.upload_url, imageBuffer);
        // 3. Сохранить фото
        const saved = await saveWallPhoto(serviceKey, groupId, uploadResult);
        if (saved && saved.length > 0) {
            attachments = `photo${saved[0].owner_id}_${saved[0].id}`;
        }
    }

    // 4. Опубликовать пост
    const postParams = {
        owner_id: `-${groupId}`,
        from_group: 1,
        message: text || '',
    };

    if (attachments) postParams.attachments = attachments;
    if (params.signed) postParams.signed = 1;

    const result = await callVkApi('wall.post', postParams, serviceKey);
    return {
        post_id: result?.post_id,
        full_id: `-${groupId}_${result?.post_id}`
    };
}

/**
 * Получить информацию о группе (для валидации)
 */
async function getGroupInfo(serviceKey, groupId) {
    const result = await callVkApi('groups.getById', {
        group_id: groupId
    }, serviceKey);
    return result?.[0] || result?.groups?.[0] || null;
}

/**
 * Валидация VK параметров
 */
function validateVkParams({ groupId, serviceKey, text }) {
    const errors = [];
    if (!groupId) errors.push('group_id обязателен');
    if (!serviceKey) errors.push('service_key обязателен');
    if (text && text.length > 16384) errors.push('Текст поста слишком длинный (макс. 16384 символов)');
    return { valid: errors.length === 0, errors };
}

/**
 * Получить действующий service_key для пользователя
 */
function getServiceKey(chatId) {
    const cfg = manageStore.getVkConfig(chatId);
    if (!cfg || !cfg.service_key) {
        throw new Error('VK service_key не настроен');
    }
    return cfg.service_key;
}

module.exports = {
    callVkApi,
    getWallUploadServer,
    uploadPhoto,
    saveWallPhoto,
    publishPhotoPost,
    getGroupInfo,
    validateVkParams,
    getServiceKey
};
