const API_MANAGE = `${window.location.origin}/api/manage`;

// MySQL API конфигурация
const MYSQL_API_URL = 'https://ai.memory.api.atiks.org/mysql_full_proxy_api';
const MYSQL_API_KEY = 'mysql-VTJGc2RHVmtYMS9PQ09iSlgycDZrRWVWVWt5bWR1azQ4bkVqK0JkeXlvSjhpMGg0UW1YSUFlbjRycmM3ZWIzZmkxOVZ1bDNQZ2NITVVtZE9iWGp2R0FiSFRUKzU3YjJEdzMvKzRoR0VaM0htNWtsM2pCOU5rK29VcElGZHRFaXpaa0N5UGVmN2hwdk9aeWdZMkIrcnNCVnRpdWFyaDV1RXVFSFpTK2JJM0hZeHBwZ2dEUGgrQ0pJV3Biem9RdHBGQlhOZ0hkbXhkZDRHSCtXUkpUTnQxYjI5T3VuQklVbUJPdE91Z1VYdm02K2lsL3lHSUpacCtSOWlzQ0xBcktLUQ==';

let currentUserEmail = null;

async function mysqlQuery(sql, params = []) {
    const response = await fetch(MYSQL_API_URL, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${MYSQL_API_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ sql, params })
    });
    
    if (!response.ok) {
        throw new Error(`MySQL API error: ${response.status}`);
    }
    
    const result = await response.json();
    if (result.error) {
        throw new Error(result.error);
    }
    return result;
}

async function onLoginSuccess() {
    await loadAIProviderStatus();
    await loadAIStatus();
    await loadContextSettings();
    await loadSystemContext();
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
            // Форматируем баланс
            let balanceInfo = '';
            if (data.balance !== null && data.balance !== undefined) {
                const balanceClass = data.balance < 0 ? 'color: #d00;' : 'color: #0a0;';
                const expiredInfo = data.balanceExpired ? ` (до ${data.balanceExpired})` : '';
                balanceInfo = `<br><span style="font-size: 12px; ${balanceClass}">💰 Баланс: ${Math.round(data.balance).toLocaleString()} токенов, ${expiredInfo}</span>`;
            }
            
            // Проверяем заблокирован ли AI
            if (data.aiBlocked) {
                statusEl.innerHTML = `<span style="color: #d00;">⚠️ ИИ ассистент ЗАБЛОКИРОВАН</span>${balanceInfo}<br><span style="font-size: 13px; color: #666;">Модель: ${data.aiModel}. Продлите тариф для разблокировки.</span>`;
            } else {
                statusEl.innerHTML = `<span style="color: #0a0;">✅ ИИ ассистент активен: <strong>${data.aiModel}</strong></span>${balanceInfo}`;
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

// === Системный контекст с навыками ===

async function loadSystemContext() {
    // Загружаем email пользователя
    const chatId = getChatId();
    if (!chatId) return;
    
    try {
        const res = await fetch(`${API_MANAGE}/ai/status?chat_id=${encodeURIComponent(chatId)}`);
        const data = await res.json();
        currentUserEmail = data.aiUserEmail || null;
        
        // Автоматически обновляем контекст
        await refreshSystemContext();
    } catch (e) {
        console.error('loadSystemContext', e);
    }
}

async function refreshSystemContext() {
    const outputEl = document.getElementById('systemContextOutput');
    const skillsListEl = document.getElementById('activeSkillsList');
    
    if (!outputEl) return;
    
    outputEl.value = 'Загрузка...';
    skillsListEl.innerHTML = '<span style="color: #999; font-size: 13px;">Загрузка...</span>';
    
    try {
        // 1. Загружаем выбранные навыки
        let selectedSkills = [];
        if (currentUserEmail) {
            const result = await mysqlQuery(
                `SELECT s.* FROM ai_skills s 
                 INNER JOIN user_selected_skills us ON s.id = us.skill_id 
                 WHERE us.user_email = %s AND s.is_active = 1`,
                [currentUserEmail]
            );
            selectedSkills = result.data || [];
        }
        
        // 2. Загружаем файлы персонализации из /workspace/
        const chatId = getChatId();
        let personaFiles = {};
        const personaFilesList = ['IDENTITY.md', 'SOUL.md', 'USER.md', 'MEMORY.md'];
        
        for (const fname of personaFilesList) {
            try {
                // Читаем файл напрямую из /workspace/ через правильный API
                const contentRes = await fetch(`/api/files/${encodeURIComponent(chatId)}/content?filepath=${encodeURIComponent('/workspace/' + fname)}`);
                if (contentRes.ok) {
                    const content = await contentRes.text();
                    if (content && content.trim()) {
                        personaFiles[fname] = content.trim();
                    }
                }
            } catch (e) {
                console.log(`Файл ${fname} не найден или ошибка чтения:`, e.message);
            }
        }
        
        console.log('Загруженные файлы персоны:', personaFiles);
        
        // 3. Формируем системный контекст
        let systemPrompt = '';
        
        // Базовые инструкции
        systemPrompt += `=== БАЗОВАЯ РОЛЬ ===\n`;
        systemPrompt += `Ты - AI-ассистент для bash-команд в изолированном Docker-контейнере. `;
        systemPrompt += `Ты помогаешь пользователю выполнять команды, анализировать результаты и решать задачи. `;
        systemPrompt += `Всегда объясняй свои действия и результаты.\n\n`;
        
        // Персонализация
        if (personaFiles['IDENTITY.md'] || personaFiles['SOUL.md'] || personaFiles['USER.md'] || personaFiles['MEMORY.md']) {
            systemPrompt += `=== ПЕРСОНАЛИЗАЦИЯ ===\n`;
            if (personaFiles['IDENTITY.md']) {
                systemPrompt += `--- IDENTITY.md ---\n${personaFiles['IDENTITY.md']}\n\n`;
            }
            if (personaFiles['SOUL.md']) {
                systemPrompt += `--- SOUL.md ---\n${personaFiles['SOUL.md']}\n\n`;
            }
            if (personaFiles['USER.md']) {
                systemPrompt += `--- USER.md ---\n${personaFiles['USER.md']}\n\n`;
            }
            if (personaFiles['MEMORY.md']) {
                systemPrompt += `--- MEMORY.md ---\n${personaFiles['MEMORY.md']}\n\n`;
            }
        }
        
        // Навыки
        if (selectedSkills.length > 0) {
            systemPrompt += `=== АКТИВНЫЕ НАВЫКИ ===\n`;
            systemPrompt += `Ты имеешь следующие активные навыки:\n\n`;
            
            selectedSkills.forEach((skill, idx) => {
                systemPrompt += `--- НАВЫК ${idx + 1}: ${skill.name} ---\n${skill.system_prompt}\n\n`;
            });
        }
        
        // Дополнительные инструкции
        systemPrompt += `=== ИНСТРУКЦИИ ПО ВЫПОЛНЕНИЮ ===\n`;
        systemPrompt += `1. Анализируй запрос пользователя\n`;
        systemPrompt += `2. Если нужно выполнить команду - выполняй её через bash\n`;
        systemPrompt += `3. Объясняй результаты и предлагай улучшения\n`;
        systemPrompt += `4. Если запрос неясен - уточняй\n`;
        systemPrompt += `5. Используй свои навыки для решения специфических задач\n`;
        
        outputEl.value = systemPrompt;
        
        // Отображаем список навыков
        if (selectedSkills.length > 0) {
            skillsListEl.innerHTML = selectedSkills.map(s => 
                `<span class="skill-tag" style="background: #d0ebff; color: #1971c2;">${s.name}</span>`
            ).join('');
        } else {
            skillsListEl.innerHTML = '<span style="color: #999; font-size: 13px;">Нет выбранных навыков</span>';
        }
        
    } catch (e) {
        console.error('refreshSystemContext error:', e);
        outputEl.value = 'Ошибка загрузки системного контекста: ' + e.message;
        skillsListEl.innerHTML = '<span style="color: #ff6b6b; font-size: 13px;">Ошибка загрузки навыков</span>';
    }
}

function copySystemContext() {
    const outputEl = document.getElementById('systemContextOutput');
    if (!outputEl) return;
    
    navigator.clipboard.writeText(outputEl.value).then(() => {
        const statusEl = document.getElementById('contextCopyStatus');
        if (statusEl) {
            statusEl.style.display = 'inline';
            setTimeout(() => { statusEl.style.display = 'none'; }, 2000);
        }
        showToast('Системный контекст скопирован', 'success');
    }).catch(err => {
        showToast('Ошибка копирования', 'error');
    });
}
