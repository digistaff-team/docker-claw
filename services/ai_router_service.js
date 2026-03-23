const fetch = require('node-fetch');

const AI_ROUTER_URL = 'https://ai.pro-talk.ru/api/router';

/**
 * Определяет провайдера по настройкам пользователя
 */
function getProviderConfig(chatId, data) {
    const provider = data.aiProvider || 'protalk';
    
    const config = {
        provider,
        base_url: null,
        authToken: null,
        model: data.aiModel || 'gpt-4o',
        userEmail: data.aiUserEmail || null
    };
    
    switch (provider) {
        case 'openai':
            // Прямой OpenAI API
            config.base_url = 'https://api.openai.com/v1';
            config.authToken = data.aiCustomApiKey;
            config.model = data.aiModel || 'gpt-4o';
            break;
            
        case 'openrouter':
            // OpenRouter - прокси с множеством моделей
            config.base_url = 'https://openrouter.ai/api/v1';
            config.authToken = data.aiCustomApiKey;
            config.model = data.aiModel || 'anthropic/claude-3-haiku';
            break;
            
        case 'protalk':
        default:
            // ProTalk через AI Router
            config.base_url = 'https://openrouter.ai/api/v1';
            config.authToken = data.aiAuthToken;
            config.model = data.aiModel || 'gpt-4o';
            break;
    }
    
    return config;
}

/**
 * Выполняет запрос к AI-провайдеру
 */
async function callAI(chatId, authToken, model, messages, tools, userEmail) {
    // Получаем настройки провайдера из хранилища
    const manageStore = require('../manage/store');
    const state = manageStore.getState(chatId);

    let providerConfig;
    if (state) {
        providerConfig = getProviderConfig(chatId, state);
    } else {
        // Fallback на ProTalk для обратной совместимости
        providerConfig = {
            provider: 'protalk',
            base_url: 'https://openrouter.ai/api/v1',
            authToken: authToken,
            model: model,
            userEmail: userEmail
        };
    }

    const { provider, base_url, authToken: effectiveAuthToken, model: effectiveModel } = providerConfig;

    // DEBUG LOG
    console.log(`[AI-ROUTER] Provider: ${provider}, Model: ${effectiveModel}, URL: ${base_url}`);

    const payload = {
        model: effectiveModel,
        messages: messages,
        temperature: 0.1,
        max_tokens: 4096,
        stream: false
    };

    // Добавляем tools только для ProTalk и OpenRouter (поддерживают function calling)
    if (tools && tools.length > 0 && (provider === 'protalk' || provider === 'openrouter')) {
        payload.tools = tools;
        payload.tool_choice = "auto";
    }

    const startTime = Date.now();

    let response;

    if (provider === 'openai') {
        // Прямой OpenAI API
        console.log(`[AI-ROUTER] Calling OpenAI API: ${base_url}/chat/completions`);
        response = await fetch(`${base_url}/chat/completions`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${effectiveAuthToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });
    } else {
        // ProTalk и OpenRouter - используют AI Router или напрямую
        const headers = {
            'Authorization': `Bearer ${effectiveAuthToken}`,
            'Content-Type': 'application/json'
        };

        // Добавляем дополнительные заголовки для OpenRouter
        if (provider === 'openrouter') {
            headers['HTTP-Referer'] = 'https://docker-claw.pro-talk.ru';
            headers['X-Title'] = 'Docker-Claw';
        }

        // Для ProTalk используем их API, для OpenRouter - напрямую
        const apiUrl = provider === 'protalk'
            ? AI_ROUTER_URL
            : `${base_url}/chat/completions`;

        console.log(`[AI-ROUTER] Calling ${provider} API: ${apiUrl}`);

        const requestPayload = provider === 'protalk'
            ? {
                base_url: base_url,
                platform: 'ProTalk',
                user_email: userEmail,
                ...payload,
                no_cost: true
            }
            : payload;

        response = await fetch(apiUrl, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(requestPayload)
        });
    }
    
    if (!response.ok) {
        const errText = await response.text();
        
        // Логируем ошибку
        manageStore.addAIRouterLog(chatId, {
            model: effectiveModel,
            userEmail,
            success: false,
            error: `HTTP ${response.status}: ${errText.slice(0, 500)}`,
            durationMs: Date.now() - startTime,
            inputMessages: messages.length,
            provider
        });
        
        // Специфичные ошибки для разных провайдеров
        if (response.status === 401) {
            throw new Error(`Неверный API-ключ. Проверьте настройки ${provider === 'openai' ? 'OpenAI' : provider === 'openrouter' ? 'OpenRouter' : 'ProTalk'}.`);
        }
        if (response.status === 402) {
            throw new Error('Недостаточно средств на счёте.');
        }
        if (response.status === 429) {
            throw new Error('Превышен лимит запросов. Попробуйте позже.');
        }
        
        throw new Error(`HTTP ${response.status}: ${errText}`);
    }
    
    const result = await response.json();
    
    // Логируем успешный запрос с usage данными
    manageStore.addAIRouterLog(chatId, {
        model: effectiveModel,
        userEmail,
        success: true,
        usage: result.usage || null,
        durationMs: Date.now() - startTime,
        inputMessages: messages.length,
        hasTools: !!(tools && tools.length > 0),
        responseModel: result.model || effectiveModel,
        provider
    });
    
    return result;
}

module.exports = { callAI };