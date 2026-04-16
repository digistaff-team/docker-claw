const API_MANAGE = `${window.location.origin}/api/manage`;

let selectedModel = 'veo3.1';

async function onLoginSuccess() {
    await loadAIProviderStatus();
    await loadAIStatus();
    await Promise.all([loadModelSettings(), loadImageModelSettings()]);
}

// === Модель генерации видео ===

async function loadModelSettings() {
    const chatId = getChatId();
    if (!chatId) return;
    try {
        const resp = await fetch(`/api/video/settings?chat_id=${encodeURIComponent(chatId)}`);
        const data = await resp.json();
        if (!data.success) return;
        selectedModel = data.settings?.model || 'veo3.1';
        renderModelGrid(data.availableModels || [], selectedModel);
    } catch (e) {
        console.error('Model settings load error:', e);
    }
}

function renderModelGrid(models, activeModel) {
    const grid = document.getElementById('modelGrid');
    if (!grid) return;
    grid.innerHTML = models.map(m => `
        <div class="model-card ${m.id === activeModel ? 'model-card--active' : ''} ${!m.available ? 'model-card--disabled' : ''}"
             onclick="${m.available ? `selectModel('${m.id}')` : ''}">
            <div class="model-card__name">${m.name}</div>
            <div class="model-card__provider">${m.provider}</div>
            <span class="model-card__badge ${m.available ? 'badge-available' : 'badge-soon'}">
                ${m.available ? 'Доступно' : 'Скоро'}
            </span>
        </div>
    `).join('');
}

async function selectModel(modelId) {
    if (modelId === selectedModel) return;
    const chatId = getChatId();
    if (!chatId) return;
    try {
        const resp = await fetch('/api/video/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, model: modelId })
        });
        const data = await resp.json();
        if (data.success) {
            selectedModel = modelId;
            await loadModelSettings();
            const status = document.getElementById('modelSaveStatus');
            if (status) { status.style.display = 'inline'; setTimeout(() => status.style.display = 'none', 2000); }
        }
    } catch (e) {
        console.error('Model save error:', e);
    }
}

// === Модель генерации изображений ===

let selectedImageModel = 'grok-imagine/text-to-image';

async function loadImageModelSettings() {
    const chatId = getChatId();
    if (!chatId) return;
    try {
        const resp = await fetch(`/api/video/image-settings?chat_id=${encodeURIComponent(chatId)}`);
        const data = await resp.json();
        if (!data.success) return;
        selectedImageModel = data.settings?.model || 'grok-imagine/text-to-image';
        renderImageModelGrid(data.availableModels || [], selectedImageModel);
    } catch (e) {
        console.error('Image model settings load error:', e);
    }
}

function renderImageModelGrid(models, activeModel) {
    const grid = document.getElementById('imageModelGrid');
    if (!grid) return;
    grid.innerHTML = models.map(m => `
        <div class="model-card ${m.id === activeModel ? 'model-card--active' : ''} ${!m.available ? 'model-card--disabled' : ''}"
             onclick="${m.available ? `selectImageModel('${m.id}')` : ''}">
            <div class="model-card__name">${m.name}</div>
            <div class="model-card__provider">${m.provider}</div>
            <span class="model-card__badge ${m.available ? 'badge-available' : 'badge-soon'}">
                ${m.available ? 'Доступно' : 'Скоро'}
            </span>
        </div>
    `).join('');
}

async function selectImageModel(modelId) {
    if (modelId === selectedImageModel) return;
    const chatId = getChatId();
    if (!chatId) return;
    try {
        const resp = await fetch('/api/video/image-settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, model: modelId })
        });
        const data = await resp.json();
        if (data.success) {
            selectedImageModel = modelId;
            await loadImageModelSettings();
            const status = document.getElementById('imageModelSaveStatus');
            if (status) { status.style.display = 'inline'; setTimeout(() => status.style.display = 'none', 2000); }
        }
    } catch (e) {
        console.error('Image model save error:', e);
    }
}

/**
 * Переключает видимость полей в зависимости от выбранного провайдера
 */
function toggleProviderFields() {
    const provider = document.querySelector('input[name="aiProvider"]:checked')?.value || 'protalk';
    
    const protalkFields = document.getElementById('protalkFields');
    const customApiFields = document.getElementById('customApiFields');
    const protalkModels = document.getElementById('protalkModels');
    const openaiModels = document.getElementById('openaiModels');
    const openrouterModels = document.getElementById('openrouterModels');
    
    if (provider === 'protalk') {
        if (protalkFields) protalkFields.style.display = 'block';
        if (customApiFields) customApiFields.style.display = 'none';
        if (protalkModels) protalkModels.style.display = 'block';
        if (openaiModels) openaiModels.style.display = 'none';
        if (openrouterModels) openrouterModels.style.display = 'none';
    } else if (provider === 'openai') {
        if (protalkFields) protalkFields.style.display = 'none';
        if (customApiFields) customApiFields.style.display = 'block';
        if (protalkModels) protalkModels.style.display = 'none';
        if (openaiModels) openaiModels.style.display = 'block';
        if (openrouterModels) openrouterModels.style.display = 'none';
    } else if (provider === 'openrouter') {
        if (protalkFields) protalkFields.style.display = 'none';
        if (customApiFields) customApiFields.style.display = 'block';
        if (protalkModels) protalkModels.style.display = 'none';
        if (openaiModels) openaiModels.style.display = 'none';
        if (openrouterModels) openrouterModels.style.display = 'block';
    }
}

/**
 * Загружает статус AI-провайдера
 */
async function loadAIProviderStatus() {
    const chatId = getChatId();
    if (!chatId) return;
    
    try {
        const res = await fetch(`${API_MANAGE}/ai/provider?chat_id=${encodeURIComponent(chatId)}`);
        const data = await res.json();
        
        // Устанавливаем выбранный провайдер
        const providerRadio = document.querySelector(`input[name="aiProvider"][value="${data.provider || 'protalk'}"]`);
        if (providerRadio) {
            providerRadio.checked = true;
        }
        
        // Переключаем поля
        toggleProviderFields();
        
        // Заполняем API ключ если есть (только звездочки показываем)
        const apiKeyInput = document.getElementById('aiApiKey');
        if (apiKeyInput && data.hasApiKey) {
            apiKeyInput.placeholder = '•••••••••••••••• (установлен)';
        }
        
    } catch (e) {
        console.error('loadAIProviderStatus', e);
        toggleProviderFields(); // По умолчанию показываем ProTalk
    }
}

/**
 * Сохраняет настройки AI-провайдера
 */
async function saveAIProvider() {
    const chatId = getChatId();
    if (!chatId) return;
    
    const provider = document.querySelector('input[name="aiProvider"]:checked')?.value || 'protalk';
    const modelSelect = document.getElementById('aiModel');
    const model = modelSelect?.value;
    
    let apiKey = null;
    let botId = null;
    let botToken = null;
    let userEmail = null;
    
    if (provider === 'protalk') {
        // ProTalk - нужны данные бота
        const botIdInput = document.getElementById('aiBotId');
        const botTokenInput = document.getElementById('aiBotToken');
        const userEmailInput = document.getElementById('aiUserEmail');
        
        botId = (botIdInput?.value || '').trim();
        botToken = (botTokenInput?.value || '').trim();
        userEmail = (userEmailInput?.value || '').trim();
        
        if (!botId || !botToken || !userEmail) {
            showToast('Введите Bot ID, Bot Token и Email для ProTalk', 'error');
            return;
        }
        
        // Сохраняем через старый endpoint для ProTalk
        try {
            const res = await fetch(`${API_MANAGE}/ai`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    chat_id: chatId, 
                    bot_id: botId, 
                    bot_token: botToken, 
                    user_email: userEmail, 
                    model 
                })
            });
            const data = await res.json().catch(() => ({}));
            
            if (res.ok) {
                // Также сохраняем провайдер
                await fetch(`${API_MANAGE}/ai/provider`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ chat_id: chatId, provider: 'protalk', model })
                });
                
                if (data.balanceWarning && data.balanceWarning.aiBlocked) {
                    showToast('Настройки сохранены, но ИИ заблокирован: ' + data.balanceWarning.reason, 'warning');
                } else {
                    showToast('ProTalk AI настроен', 'success');
                }
            } else {
                showToast(data.error || 'Ошибка сохранения', 'error');
                return;
            }
        } catch (e) {
            showToast('Ошибка сети', 'error');
            return;
        }
        
    } else {
        // OpenAI или OpenRouter - нужен API ключ
        const apiKeyInput = document.getElementById('aiApiKey');
        apiKey = (apiKeyInput?.value || '').trim();
        
        if (!apiKey) {
            showToast('Введите API-ключ для ' + (provider === 'openai' ? 'OpenAI' : 'OpenRouter'), 'error');
            return;
        }
        
        if (!apiKey.startsWith('sk-')) {
            showToast('API-ключ должен начинаться с "sk-"', 'error');
            return;
        }
        
        try {
            const res = await fetch(`${API_MANAGE}/ai/provider`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    chat_id: chatId, 
                    provider, 
                    api_key: apiKey,
                    model 
                })
            });
            const data = await res.json().catch(() => ({}));
            
            if (res.ok) {
                showToast((provider === 'openai' ? 'OpenAI' : 'OpenRouter') + ' настроен', 'success');
                // Очищаем поле ввода ключа после сохранения
                if (apiKeyInput) apiKeyInput.value = '';
            } else {
                showToast(data.error || 'Ошибка сохранения', 'error');
            }
        } catch (e) {
            showToast('Ошибка сети', 'error');
            return;
        }
    }
    
    // Перезагружаем статус
    await loadAIProviderStatus();
    await loadAIStatus();
}

async function loadContextSettings() {
    const chatId = getChatId();
    if (!chatId) return;
    try {
        const res = await fetch(`${API_MANAGE}/ai/context-settings?chat_id=${encodeURIComponent(chatId)}`);
        const settings = await res.json();
        
        // Заполняем поля формы
        const fields = {
            ctxMaxCommands: settings.maxCommands,
            ctxMaxFiles: settings.maxFiles,
            ctxMaxDepth: settings.maxDepth,
            ctxMaxFileLines: settings.maxFileLines,
            ctxPersonaLines: settings.personaLines,
            ctxPersonaChars: settings.personaChars,
            ctxStdoutMaxChars: settings.stdoutMaxChars,
            ctxStderrMaxChars: settings.stderrMaxChars
        };
        
        for (const [id, value] of Object.entries(fields)) {
            const el = document.getElementById(id);
            if (el) el.value = value;
        }
        
        const stdoutEl = document.getElementById('ctxIncludeStdout');
        const stderrEl = document.getElementById('ctxIncludeStderr');
        if (stdoutEl) stdoutEl.checked = settings.includeStdout !== false;
        if (stderrEl) stderrEl.checked = settings.includeStderr !== false;
        
    } catch (e) {
        console.error('loadContextSettings', e);
    }
}

async function saveContextSettings() {
    const chatId = getChatId();
    if (!chatId) return;
    
    const settings = {
        maxCommands: parseInt(document.getElementById('ctxMaxCommands')?.value) || 5,
        maxFiles: parseInt(document.getElementById('ctxMaxFiles')?.value) || 80,
        maxDepth: parseInt(document.getElementById('ctxMaxDepth')?.value) || 3,
        maxFileLines: parseInt(document.getElementById('ctxMaxFileLines')?.value) || 30,
        personaLines: parseInt(document.getElementById('ctxPersonaLines')?.value) || 20,
        personaChars: parseInt(document.getElementById('ctxPersonaChars')?.value) || 500,
        stdoutMaxChars: parseInt(document.getElementById('ctxStdoutMaxChars')?.value) || 200,
        stderrMaxChars: parseInt(document.getElementById('ctxStderrMaxChars')?.value) || 200,
        includeStdout: document.getElementById('ctxIncludeStdout')?.checked !== false,
        includeStderr: document.getElementById('ctxIncludeStderr')?.checked !== false
    };
    
    try {
        const res = await fetch(`${API_MANAGE}/ai/context-settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, ...settings })
        });
        const data = await res.json().catch(() => ({}));
        const statusEl = document.getElementById('contextSettingsStatus');
        if (res.ok) {
            if (statusEl) {
                statusEl.innerHTML = '<span style="color: #0a0;">✅ Настройки сохранены</span>';
                setTimeout(() => { statusEl.textContent = ''; }, 3000);
            }
            showToast('Настройки контекста сохранены', 'success');
        } else {
            if (statusEl) {
                statusEl.innerHTML = `<span style="color: #a00;">❌ ${data.error || 'Ошибка'}</span>`;
            }
            showToast(data.error || 'Ошибка сохранения', 'error');
        }
    } catch (e) {
        showToast('Ошибка сети', 'error');
    }
}

async function resetContextSettings() {
    const defaults = {
        maxCommands: 5,
        maxFiles: 80,
        maxDepth: 3,
        maxFileLines: 30,
        personaLines: 20,
        personaChars: 500,
        stdoutMaxChars: 200,
        stderrMaxChars: 200,
        includeStdout: true,
        includeStderr: true
    };
    
    const fields = {
        ctxMaxCommands: defaults.maxCommands,
        ctxMaxFiles: defaults.maxFiles,
        ctxMaxDepth: defaults.maxDepth,
        ctxMaxFileLines: defaults.maxFileLines,
        ctxPersonaLines: defaults.personaLines,
        ctxPersonaChars: defaults.personaChars,
        ctxStdoutMaxChars: defaults.stdoutMaxChars,
        ctxStderrMaxChars: defaults.stderrMaxChars
    };
    
    for (const [id, value] of Object.entries(fields)) {
        const el = document.getElementById(id);
        if (el) el.value = value;
    }
    
    const stdoutEl = document.getElementById('ctxIncludeStdout');
    const stderrEl = document.getElementById('ctxIncludeStderr');
    if (stdoutEl) stdoutEl.checked = true;
    if (stderrEl) stderrEl.checked = true;
    
    showToast('Значения сброшены. Нажмите "Сохранить" для применения.', 'info');
}

async function loadAIStatus() {
    const chatId = getChatId();
    if (!chatId) return;
    try {
        const res = await fetch(`${API_MANAGE}/ai/status?chat_id=${encodeURIComponent(chatId)}`);
        const data = await res.json();
        const statusEl = document.getElementById('aiStatus');
        const disconnectBtn = document.getElementById('disconnectAIBtn');
        const botIdInput = document.getElementById('aiBotId');
        const botTokenInput = document.getElementById('aiBotToken');
        const userEmailInput = document.getElementById('aiUserEmail');
        const modelSelect = document.getElementById('aiModel');
        if (!statusEl) return;

        if (data.hasAI) {
            // Форматируем баланс (только для ProTalk)
            let balanceInfo = '';
            const isProTalk = !data.aiProvider || data.aiProvider === 'protalk';
            if (isProTalk && data.balance !== null && data.balance !== undefined) {
                const balanceClass = data.balance < 0 ? 'color: #d00;' : 'color: #0a0;';
                const expiredInfo = data.balanceExpired ? ` (до ${data.balanceExpired})` : '';
                balanceInfo = `<br><span style="font-size: 12px; ${balanceClass}">💰 Баланс: ${Math.round(data.balance).toLocaleString()} токенов, ${expiredInfo}</span>`;
            }

            // Определяем имя провайдера для отображения
            const providerLabel = data.aiProvider === 'openai' ? 'OpenAI' : data.aiProvider === 'openrouter' ? 'OpenRouter' : 'ProTalk';

            // Проверяем заблокирован ли AI
            if (data.aiBlocked) {
                statusEl.innerHTML = `<span style="color: #d00;">⚠️ ИИ ассистент ЗАБЛОКИРОВАН</span>${balanceInfo}<br><span style="font-size: 13px; color: #666;">Модель: ${data.aiModel}. Продлите тариф для разблокировки.</span>`;
            } else {
                statusEl.innerHTML = `<span style="color: #0a0;">✅ ИИ ассистент активен: <strong>${providerLabel} / ${data.aiModel}</strong></span>${balanceInfo}`;
            }

            if (disconnectBtn) disconnectBtn.style.display = 'inline-block';

            // Заполняем поля формы сохранёнными данными
            if (botIdInput) botIdInput.value = data.aiBotId || '';
            if (botTokenInput) botTokenInput.value = data.aiBotToken || ''; // Уже маскированный токен
            if (userEmailInput) userEmailInput.value = data.aiUserEmail || '';
            if (modelSelect) modelSelect.value = data.aiModel || 'google/gemini-3-pro-preview';
        } else {
            statusEl.textContent = 'ИИ не настроен. Выберите провайдера и введите данные для активации.';
            if (disconnectBtn) disconnectBtn.style.display = 'none';
        }
    } catch (e) {
        console.error('loadAIStatus', e);
        document.getElementById('aiStatus').textContent = 'Ошибка загрузки статуса';
    }
}

async function saveAIToken() {
    // Перенаправляем на новую функцию
    await saveAIProvider();
}

async function disconnectAI() {
    const chatId = getChatId();
    if (!chatId || !confirm('Отключить ИИ ассистента? Telegram вернется к прямому выполнению команд.')) return;
    try {
        const res = await fetch(`${API_MANAGE}/ai?chat_id=${encodeURIComponent(chatId)}`, { method: 'DELETE' });
        if (res.ok) {
            showToast('ИИ отключён', 'success');
            await loadAIProviderStatus();
            await loadAIStatus();
        } else {
            showToast('Ошибка отключения', 'error');
        }
    } catch (e) {
        showToast('Ошибка сети', 'error');
    }
}

