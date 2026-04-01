/**
 * Pinterest API v5 клиент
 * OAuth2, управление досками, создание пинов
 */
const https = require('https');
const manageStore = require('../manage/store');
const { getBoards: getBoardsFromDb, saveBoards, updateBoard, deleteBoard } = require('./content/pinterest.repository');

const PINTEREST_API = 'https://api.pinterest.com/v5';
const TOKEN_URL = 'https://api.pinterest.com/v5/oauth/token';
const TOKEN_REFRESH_MARGIN_MS = 24 * 60 * 60 * 1000; // обновлять за 24ч до истечения
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
            if (res.status === 429 && attempt < retries) {
                const delay = RETRY_BASE_MS * Math.pow(2, attempt);
                console.log(`[PINTEREST] Rate limited, retry in ${delay}ms`);
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

// --- OAuth2 ---

async function exchangeCodeForToken(appId, appSecret, code, redirectUri) {
    const credentials = Buffer.from(`${appId}:${appSecret}`).toString('base64');
    const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri
    }).toString();

    const res = await retryRequest(TOKEN_URL, {
        method: 'POST',
        headers: {
            'Authorization': `Basic ${credentials}`,
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body
    });

    if (res.status !== 200 || !res.json?.access_token) {
        throw new Error(`Pinterest OAuth failed: ${res.body}`);
    }

    return {
        access_token: res.json.access_token,
        refresh_token: res.json.refresh_token,
        expires_in: res.json.expires_in,
        token_type: res.json.token_type
    };
}

async function refreshAccessToken(appId, appSecret, refreshToken) {
    const credentials = Buffer.from(`${appId}:${appSecret}`).toString('base64');
    const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken
    }).toString();

    const res = await retryRequest(TOKEN_URL, {
        method: 'POST',
        headers: {
            'Authorization': `Basic ${credentials}`,
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body
    });

    if (res.status !== 200 || !res.json?.access_token) {
        throw new Error(`Pinterest token refresh failed: ${res.body}`);
    }

    return {
        access_token: res.json.access_token,
        refresh_token: res.json.refresh_token || refreshToken,
        expires_in: res.json.expires_in
    };
}

/**
 * Получить действующий access_token, обновив при необходимости
 */
async function getValidToken(chatId, config) {
    if (!config) config = manageStore.getPinterestConfig(chatId);
    if (!config || !config.access_token) {
        throw new Error('Pinterest access_token отсутствует');
    }

    // Проверяем срок действия
    if (config.access_token_expires) {
        const expiresAt = new Date(config.access_token_expires).getTime();
        const now = Date.now();
        if (now + TOKEN_REFRESH_MARGIN_MS > expiresAt && config.refresh_token && config.app_id && config.app_secret) {
            console.log('[PINTEREST] Refreshing access token...');
            try {
                const result = await refreshAccessToken(config.app_id, config.app_secret, config.refresh_token);
                const newExpires = new Date(Date.now() + (result.expires_in || 2592000) * 1000).toISOString();
                await manageStore.setPinterestConfig(chatId, {
                    access_token: result.access_token,
                    refresh_token: result.refresh_token,
                    access_token_expires: newExpires
                });
                return result.access_token;
            } catch (e) {
                console.error('[PINTEREST] Token refresh failed:', e.message);
                // Если текущий токен ещё не истёк — используем его
                if (Date.now() < expiresAt) return config.access_token;
                throw e;
            }
        }
    }

    return config.access_token;
}

// --- Boards ---

/**
 * Получить доски Pinterest для chatId
 * Сначала берём из БД (сохранённые с настройками), затем из API
 */
async function getBoards(chatId, accessToken) {
    // Сначала пробуем получить из локальной БД
    try {
        const dbBoards = await getBoardsFromDb(chatId);
        if (dbBoards && dbBoards.length > 0) {
            console.log(`[PINTEREST] Loaded ${dbBoards.length} boards from DB`);
            return dbBoards.map(b => ({
                id: b.board_id,
                name: b.board_name,
                description: b.idea || b.focus || b.purpose || '',
                privacy: 'public',
                _dbId: b.id,
                idea: b.idea,
                focus: b.focus,
                purpose: b.purpose,
                keywords: b.keywords,
                link: b.link
            }));
        }
    } catch (e) {
        console.error(`[PINTEREST] Error loading boards from DB:`, e.message);
        return [];
    }
}

// --- Pins ---

async function createPin(accessToken, { boardId, title, description, link, mediaSource }) {
    if (!boardId) throw new Error('boardId is required');
    if (!mediaSource) throw new Error('mediaSource is required');

    const pinData = {
        board_id: boardId,
        media_source: mediaSource
    };
    if (title) pinData.title = String(title).slice(0, 100);
    if (description) pinData.description = String(description).slice(0, 500);
    if (link) pinData.link = link;

    const body = JSON.stringify(pinData);

    const res = await retryRequest(`${PINTEREST_API}/pins`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
        },
        body
    });

    if (res.status !== 201 && res.status !== 200) {
        throw new Error(`Pinterest createPin failed (${res.status}): ${res.body}`);
    }

    return {
        id: res.json?.id,
        link: res.json?.link,
        title: res.json?.title,
        board_id: res.json?.board_id
    };
}

/**
 * Построить URL для OAuth-авторизации
 */
function getOAuthUrl(appId, redirectUri, scopes = ['boards:read', 'pins:read', 'pins:write']) {
    const params = new URLSearchParams({
        client_id: appId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: scopes.join(',')
    });
    return `https://www.pinterest.com/oauth/?${params}`;
}

module.exports = {
    exchangeCodeForToken,
    refreshAccessToken,
    getValidToken,
    getBoards,
    createPin,
    getOAuthUrl,
    // Board CRUD from DB
    saveBoardsToDb: saveBoards,
    getBoardsFromDb: getBoardsFromDb,
    updateBoard,
    deleteBoard
};
