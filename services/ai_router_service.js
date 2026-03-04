const fetch = require('node-fetch');

const AI_ROUTER_URL = 'https://ai.pro-talk.ru/api/router';

async function callAI(chatId, authToken, model, messages, tools, userEmail) {
    const payload = {
        base_url: "https://openrouter.ai/api/v1/chat/completions",
        platform: "ProTalk",
        user_email: userEmail,
        model: model,
        messages: messages,
        temperature: 0.1,
        max_tokens: 4096,
        stream: false,
        no_cost: true // Токены AI Router не учитываются в расходе по проекту
    };

    if (tools && tools.length > 0) {
        payload.tools = tools;
        payload.tool_choice = "auto";
    }

    const startTime = Date.now();
    
    try {
        const response = await fetch(AI_ROUTER_URL, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${authToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const errText = await response.text();
            // Логируем ошибку
            const manageStore = require('../manage/store');
            manageStore.addAIRouterLog(chatId, {
                model,
                userEmail,
                success: false,
                error: `HTTP ${response.status}: ${errText.slice(0, 500)}`,
                durationMs: Date.now() - startTime,
                inputMessages: messages.length
            });
            throw new Error(`HTTP ${response.status}: ${errText}`);
        }

        const result = await response.json();
        
        // Логируем успешный запрос с usage данными
        const manageStore = require('../manage/store');
        manageStore.addAIRouterLog(chatId, {
            model,
            userEmail,
            success: true,
            usage: result.usage || null,
            durationMs: Date.now() - startTime,
            inputMessages: messages.length,
            hasTools: !!(tools && tools.length > 0),
            responseModel: result.model || model
        });
        
        return result;
    } catch (error) {
        console.error('[AI-ROUTER]', chatId, error.message);
        throw error;
    }
}

module.exports = { callAI };
