/**
 * OK (Odnoklassniki) API клиент
 * Публикация постов в группу, загрузка фото
 */
const https = require('https');
const crypto = require('crypto');
const config = require('../config');
const manageStore = require('../manage/store');

const OK_API_URL = 'https://api.ok.ru/fb.do';
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

        console.log(`[OK-HTTP] Sending ${reqOptions.method} to ${urlObj.hostname}${reqOptions.path}, body_len=${options.body?.length || 0}`);

        const req = https.request(reqOptions, (res) => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                const body = Buffer.concat(chunks).toString();
                let json;
                try { json = JSON.parse(body); } catch { json = null; }
                console.log(`[OK-HTTP] Response: status=${res.statusCode}, body_len=${body.length}`);
                resolve({ status: res.statusCode, headers: res.headers, body, json });
            });
        });

        req.on('error', (e) => {
            console.error(`[OK-HTTP] Request error: ${e.message}`);
            reject(e);
        });
        req.on('timeout', () => { 
            console.error(`[OK-HTTP] Request timeout`);
            req.destroy(); 
            reject(new Error('Request timeout')); 
        });

        if (options.body) req.write(options.body);
        req.end();
    });
}

async function retryRequest(url, options, retries = MAX_RETRIES) {
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            console.log(`[OK-RETRY] Attempt ${attempt + 1}/${retries + 1} to ${url}`);
            const res = await request(url, options);
            // OK rate limit check
            if (res.json?.error_code === 2 && attempt < retries) {
                const delay = RETRY_BASE_MS * Math.pow(2, attempt);
                console.log(`[OK] Rate limited, retry in ${delay}ms`);
                await new Promise(r => setTimeout(r, delay));
                continue;
            }
            return res;
        } catch (e) {
            console.error(`[OK-RETRY] Attempt ${attempt + 1} failed: ${e.message}`);
            if (attempt >= retries) throw e;
            const delay = RETRY_BASE_MS * Math.pow(2, attempt);
            await new Promise(r => setTimeout(r, delay));
        }
    }
}

// --- OK API signature ---

/**
 * Подпись запроса по спецификации ОК API:
 * 
 * Для EXTERNAL приложений (OAuth 2.0):
 * sig = MD5(sorted_params_string + session_secret)
 * access_token передаётся отдельно, НЕ участвует в подписи
 * 
 * Для INTERNAL приложений (server_key):
 * sig = MD5(sorted_params_string + secret_key)
 * access_token НЕ используется, вместо него server_key
 * 
 * @param {Object} params - Параметры запроса (без sig и access_token)
 * @param {string} sessionSecret - session_secret для EXTERNAL или secret_key для INTERNAL
 * @param {boolean} includeAccessToken - true если access_token будет добавлен (для EXTERNAL)
 */
function signRequest(params, sessionSecret, includeAccessToken = false) {
    const filtered = { ...params };
    delete filtered.sig;
    
    // Для INTERNAL приложений access_token не используется вообще
    // Для EXTERNAL — добавляется после подписи
    if (!includeAccessToken) {
        delete filtered.access_token;
    }

    const sortedStr = Object.keys(filtered)
        .sort()
        .map(key => `${key}=${filtered[key]}`)
        .join('');

    return crypto
        .createHash('md5')
        .update(sortedStr + sessionSecret)
        .digest('hex')
        .toLowerCase();
}

// --- OK API credentials resolution ---

function getCredentials(chatId) {
    const userCfg = chatId ? manageStore.getOkConfig(chatId) : null;
    return {
        appId: userCfg?.app_id || config.OK_APP_ID,
        publicKey: userCfg?.public_key || config.OK_PUBLIC_KEY,
        secretKey: userCfg?.secret_key || config.OK_SECRET_KEY,
        accessToken: userCfg?.access_token || config.OK_ACCESS_TOKEN,
        sessionSecret: userCfg?.session_secret || config.OK_SESSION_SECRET,
        groupId: userCfg?.group_id || config.OK_GROUP_ID
    };
}

// --- OK API methods ---

/**
 * Вызов OK API метода
 * 
 * Поддерживает два режима:
 * 1. EXTERNAL приложение (OAuth 2.0) — используется access_token + session_secret
 * 2. INTERNAL приложение (server_key) — используется secret_key без access_token
 * 
 * @param {string} method - Метод API (например, 'mediatopic.post')
 * @param {Object} params - Параметры метода
 * @param {string} chatId - ID чата пользователя
 */
async function callOkApi(method, params, chatId) {
    const creds = getCredentials(chatId);
    
    // Базовые параметры
    const allParams = {
        method,
        application_key: creds.publicKey,
        ...params
    };

    // Определяем тип приложения по наличию session_secret
    const isExternal = !!creds.sessionSecret;
    
    if (isExternal) {
        // EXTERNAL приложение: подписываем без access_token, затем добавляем его
        // sig = MD5(sorted_params + session_secret)
        allParams.sig = signRequest(allParams, creds.sessionSecret, false);
        allParams.access_token = creds.accessToken;
        console.log(`[OK-API] EXTERNAL mode: method=${method}, app_key=${creds.publicKey.substring(0, 16)}..., access_token=${creds.accessToken ? 'present' : 'missing'}`);
    } else {
        // INTERNAL приложение: используем secret_key для подписи, access_token не нужен
        // sig = MD5(sorted_params + secret_key)
        allParams.sig = signRequest(allParams, creds.secretKey, false);
        console.log(`[OK-API] INTERNAL mode: method=${method}, app_key=${creds.publicKey.substring(0, 16)}..., using secret_key`);
    }

    const body = new URLSearchParams(allParams).toString();

    const res = await retryRequest(OK_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body
    });

    console.log(`[OK-API] ${method} response:`, JSON.stringify(res.json).substring(0, 200));

    if (res.json?.error_code) {
        const err = res.json;
        console.error(`[OK-API] ${method} error: code=${err.error_code}, msg="${err.error_msg}", params=${JSON.stringify(params)}`);
        throw new Error(`OK API ${method} error ${err.error_code}: ${err.error_msg}`);
    }

    return res.json;
}

/**
 * Проверка валидности токена
 */
async function validateToken(chatId) {
    try {
        const result = await callOkApi('users.getCurrentUser', {}, chatId);
        return { valid: true, user: result };
    } catch (error) {
        return { valid: false, error: error.message };
    }
}

/**
 * Получить URL для загрузки фото в группу
 */
async function getPhotoUploadUrl(chatId, groupId) {
    const creds = getCredentials(chatId);
    const gid = groupId || creds.groupId;
    return callOkApi('photosV2.getUploadUrl', { gid }, chatId);
}

/**
 * Загрузить фото на сервер ОК (multipart/form-data)
 */
async function uploadPhoto(uploadUrl, imageBuffer, filename = 'photo.png') {
    const boundary = '----OkFormBoundary' + Date.now().toString(36);
    const contentType = filename.endsWith('.jpg') || filename.endsWith('.jpeg')
        ? 'image/jpeg' : 'image/png';

    const header = Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="pic1"; filename="${filename}"\r\n` +
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
        throw new Error(`OK photo upload failed: ${res.body?.slice(0, 300)}`);
    }

    return res.json;
}

/**
 * Опубликовать пост в группу ОК с фото
 * Используем mediatopic.post с attachment JSON
 */
async function publishPhotoPost({ chatId, groupId, text, imageBuffer, params = {} }) {
    console.log(`[OK-PUBLISH] Starting publishPhotoPost for chatId=${chatId}, gid=${groupId || 'unknown'}`);
    const creds = getCredentials(chatId);
    const gid = groupId || creds.groupId;

    if (!gid) throw new Error('OK group_id отсутствует');
    if (!creds.accessToken) throw new Error('OK access_token отсутствует');

    let photoToken = null;
    let photoSkipReason = null;

    if (imageBuffer) {
        try {
            // Шаг 1: Получить URL для загрузки
            console.log(`[OK-PHOTO] Step 1: photosV2.getUploadUrl for gid=${gid}`);
            const uploadData = await getPhotoUploadUrl(chatId, gid);
            const uploadUrl = uploadData.upload_url || uploadData;

            if (!uploadUrl || typeof uploadUrl !== 'string') {
                throw new Error('No upload_url returned from OK API');
            }
            console.log(`[OK-PHOTO] Step 1 OK: upload_url=${String(uploadUrl).substring(0, 60)}...`);

            // Шаг 2: Загрузить фото
            console.log(`[OK-PHOTO] Step 2: uploading photo...`);
            const uploadResult = await uploadPhoto(uploadUrl, imageBuffer);
            console.log(`[OK-PHOTO] Step 2 OK: ${JSON.stringify(uploadResult).substring(0, 200)}`);

            // Извлечь photo token из ответа
            const photos = uploadResult.photos;
            if (photos && typeof photos === 'object') {
                const keys = Object.keys(photos);
                if (keys.length > 0) {
                    photoToken = photos[keys[0]].token;
                }
            }
            if (!photoToken && uploadResult.token) {
                photoToken = uploadResult.token;
            }
        } catch (e) {
            console.error(`[OK] Photo upload failed: ${e.message}`);
            photoSkipReason = `Фото не прикреплено: ${e.message}`;
        }
    }

    // Шаг 3: Публикация через mediatopic.post
    const attachment = { media: [] };

    if (photoToken) {
        attachment.media.push({
            type: 'photo',
            list: [{ id: photoToken }]
        });
    }

    attachment.media.push({
        type: 'text',
        text: text || ''
    });

    const postParams = {
        gid,
        type: 'GROUP_THEME',
        attachment: JSON.stringify(attachment)
    };

    console.log(`[OK] mediatopic.post: gid=${gid}, hasPhoto=${!!photoToken}`);
    const result = await callOkApi('mediatopic.post', postParams, chatId);
    console.log(`[OK-PUBLISH] Publish completed, result=${JSON.stringify(result).substring(0, 50)}`);

    return {
        post_id: result,
        full_id: `${gid}_${result}`,
        hasPhoto: !!photoToken,
        photoSkipReason
    };
}

/**
 * Получить информацию о группе
 */
async function getGroupInfo(chatId, groupId) {
    const creds = getCredentials(chatId);
    const gid = groupId || creds.groupId;
    const result = await callOkApi('group.getInfo', {
        uids: gid,
        fields: 'name,description,photo_id,members_count'
    }, chatId);
    return Array.isArray(result) ? result[0] : result;
}

/**
 * Валидация OK параметров
 */
function validateOkParams({ groupId, accessToken, text }) {
    const errors = [];
    if (!groupId) errors.push('group_id обязателен');
    if (!accessToken) errors.push('access_token обязателен');
    if (text && text.length > 5000) errors.push('Текст поста слишком длинный (макс. 5000 символов)');
    return { valid: errors.length === 0, errors };
}

/**
 * Получить credentials для пользователя
 */
function getAccessToken(chatId) {
    const creds = getCredentials(chatId);
    if (!creds.accessToken) {
        throw new Error('OK access_token не настроен');
    }
    return creds.accessToken;
}

module.exports = {
    callOkApi,
    signRequest,
    validateToken,
    getPhotoUploadUrl,
    uploadPhoto,
    publishPhotoPost,
    getGroupInfo,
    validateOkParams,
    getAccessToken,
    getCredentials
};
