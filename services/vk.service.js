/**
 * VK API v5.199 клиент
 * Публикация на стену группы, загрузка фото, Stories
 */
const https = require('https');
const manageStore = require('../manage/store');

// Утилита: удалить Markdown-разметку
function stripMarkdown(text) {
  if (!text) return '';
  return text
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[-*+]\s+/gm, '')
    .replace(/^\d+\.\s+/gm, '')
    .replace(/^>\s+/gm, '')
    .trim();
}

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
 * Нормализовать group_id: убрать минус, преобразовать в число
 */
function normalizeGroupId(groupId) {
    const id = Math.abs(parseInt(String(groupId).replace(/[^0-9-]/g, ''), 10));
    if (!id || !Number.isFinite(id)) throw new Error(`Invalid group_id: ${groupId}`);
    return id;
}

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
        console.error(`[VK-API] ${method} error: code=${err.error_code}, msg="${err.error_msg}", params=${JSON.stringify(params)}`);
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

    console.log(`[VK-PHOTO] Upload request: body length=${body.length}, boundary=${boundary}`);

    const res = await retryRequest(uploadUrl, {
        method: 'POST',
        headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': body.length
        },
        body,
        timeout: 60000
    });

    console.log(`[VK-PHOTO] Upload response:`, JSON.stringify(res.json, null, 2).substring(0, 500));

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
 * Загрузить фото через стандартный flow:
 * getWallUploadServer → upload → saveWallPhoto
 */
async function uploadWallPhoto(serviceKey, groupId, imageBuffer) {
    const gid = normalizeGroupId(groupId);
    console.log(`[VK-PHOTO] uploadWallPhoto: group_id=${gid} (type=${typeof gid}), imageSize=${imageBuffer.length}`);

    console.log(`[VK-PHOTO] Step 1: photos.getWallUploadServer...`);
    const server = await getWallUploadServer(serviceKey, gid);
    console.log(`[VK-PHOTO] Step 1 OK: upload_url=${server.upload_url?.substring(0, 60)}...`);

    console.log(`[VK-PHOTO] Step 2: uploading photo to VK server...`);
    const uploadResult = await uploadPhoto(server.upload_url, imageBuffer);
    console.log(`[VK-PHOTO] Step 2 OK: server=${uploadResult.server}, photo=${(uploadResult.photo || '').substring(0, 30)}..., hash=${uploadResult.hash}`);

    console.log(`[VK-PHOTO] Step 3: photos.saveWallPhoto...`);
    const saved = await saveWallPhoto(serviceKey, gid, uploadResult);
    console.log(`[VK-PHOTO] Step 3 OK: saved=${JSON.stringify(saved?.[0] ? { owner_id: saved[0].owner_id, id: saved[0].id } : null)}`);

    if (saved && saved.length > 0) {
        const attachment = `photo${saved[0].owner_id}_${saved[0].id}`;
        console.log(`[VK-PHOTO] Result: ${attachment}`);
        return attachment;
    }
    return '';
}

/**
 * Опубликовать пост на стене группы с фото
 * Стандартный flow: getWallUploadServer → upload → saveWallPhoto → wall.post
 */
async function publishPhotoPost({ serviceKey, groupId, text, imageBuffer, params = {} }) {
    if (!serviceKey) throw new Error('VK service_key отсутствует');
    if (!groupId) throw new Error('VK group_id отсутствует');

    const gid = normalizeGroupId(groupId);
    let attachments = '';
    let photoSkipReason = null;

    if (imageBuffer) {
        try {
            attachments = await uploadWallPhoto(serviceKey, gid, imageBuffer);
        } catch (e) {
            console.error(`[VK] Photo upload failed: ${e.message}`);
            photoSkipReason = `Фото не прикреплено: ${e.message}`;
        }
    }

    // Опубликовать пост (удаляем Markdown-разметку)
    const postParams = {
        owner_id: `-${gid}`,
        from_group: 1,
        message: stripMarkdown(text) || '',
    };

    if (attachments) postParams.attachments = attachments;
    if (params.signed) postParams.signed = 1;

    console.log(`[VK] wall.post: owner_id=${postParams.owner_id}, attachments="${attachments || 'none'}"`);
    const result = await callVkApi('wall.post', postParams, serviceKey);
    return {
        post_id: result?.post_id,
        full_id: `-${gid}_${result?.post_id}`,
        hasPhoto: !!attachments,
        photoSkipReason
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
    normalizeGroupId,
    getWallUploadServer,
    uploadPhoto,
    saveWallPhoto,
    uploadWallPhoto,
    publishPhotoPost,
    getGroupInfo,
    validateVkParams,
    getServiceKey
};
