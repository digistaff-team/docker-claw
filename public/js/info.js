const API_MANAGE = `${window.location.origin}/api/manage`;

async function onLoginSuccess() {
    await loadSessionInfo();
    await loadConfigPath();
    await loadAIRouterLogs();
}

async function loadConfigPath() {
    const chatId = getChatId();
    if (!chatId) return;
    try {
        const res = await fetch(`${API_MANAGE}/config-path?chat_id=${encodeURIComponent(chatId)}`);
        const data = await res.json();
        const el = document.getElementById('configPath');
        if (el && data.configPath) {
            el.textContent = data.configPath;
        }
    } catch (e) {
        console.error('loadConfigPath', e);
    }
}

async function loadSessionInfo() {
    const chatId = getChatId();
    if (!chatId) return;
    const el = document.getElementById('sessionInfo');
    if (!el) return;
    try {
        const response = await fetch(`${API_URL}/session/${chatId}`);
        const data = await response.json();
        if (data.exists) {
            el.innerHTML = `
                <div><strong>Chat ID:</strong> ${data.chat_id}</div>
                <div><strong>Session ID:</strong> ${data.sessionId}</div>
                <div><strong>Container ID:</strong> ${data.containerId}</div>
                <div><strong>Создана:</strong> ${new Date(data.created).toLocaleString('ru-RU')}</div>
                <div><strong>Возраст:</strong> ${data.age}</div>
                <div><strong>Команд выполнено:</strong> ${data.commandCount}</div>
                <div><strong>Статус:</strong> ${data.containerAlive ? '🟢 Активна' : '🔴 Неактивна'}</div>
            `;
        }
    } catch (e) {
        console.error('Error loading session info', e);
    }
}

async function refreshAll() {
    await loadSessionInfo();
    await loadConfigPath();
    showToast('Обновлено', 'success');
}

async function resetEnvironment() {
    if (!confirm('Удалить все файлы? База данных будет сохранена.')) return;
    const chatId = getChatId();
    if (!chatId) return;
    try {
        const response = await fetch(`${API_URL}/session/reset`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId })
        });
        if (response.ok) showToast('Файлы удалены', 'success');
        else showToast('Ошибка очистки', 'error');
    } catch (e) {
        showToast('Ошибка очистки', 'error');
    }
}

async function destroySession() {
    if (!confirm('Удалить ВСЁ включая базу данных? Это действие необратимо!')) return;
    const chatId = getChatId();
    if (!chatId) return;
    try {
        const response = await fetch(`${API_URL}/session/destroy`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId })
        });
        if (response.ok) {
            showToast('Сессия удалена', 'success');
            localStorage.removeItem('chatId');
            setTimeout(() => location.reload(), 1500);
        } else {
            showToast('Ошибка удаления', 'error');
        }
    } catch (e) {
        showToast('Ошибка удаления', 'error');
    }
}

async function loadAIRouterLogs() {
    const chatId = getChatId();
    if (!chatId) return;
    
    const statsEl = document.getElementById('aiRouterStats');
    const logsEl = document.getElementById('aiRouterLogs');
    if (!logsEl) return;
    
    try {
        const res = await fetch(`${API_MANAGE}/ai/router-logs?chat_id=${encodeURIComponent(chatId)}`);
        const data = await res.json();
        
        // Обновляем статистику
        if (statsEl && data.stats) {
            const s = data.stats;
            statsEl.innerHTML = `
                <strong>Статистика:</strong> 
                Запросов: ${s.totalRequests} | 
                Токенов: ${s.totalTokens} | 
                Успешно: ${s.successCount} | 
                Ошибок: ${s.errorCount}
            `;
        }
        
        // Форматируем логи
        if (data.logs && data.logs.length > 0) {
            const lines = data.logs.map(log => {
                const date = new Date(log.at).toLocaleString('ru-RU');
                const status = log.success ? '✅' : '❌';
                const usage = log.usage 
                    ? `tokens: ${log.usage.prompt_tokens || 0}+${log.usage.completion_tokens || 0}` 
                    : 'no usage';
                const duration = `${log.durationMs}ms`;
                const model = log.responseModel || log.model;
                
                let line = `[${date}] ${status} ${model} | ${usage} | ${duration}`;
                if (log.error) {
                    line += ` | ERROR: ${log.error}`;
                }
                return line;
            });
            logsEl.value = lines.join('\n');
        } else {
            logsEl.value = 'Логи пусты. Запросы к AI Router будут отображаться здесь.';
        }
    } catch (e) {
        console.error('loadAIRouterLogs', e);
        logsEl.value = 'Ошибка загрузки логов: ' + e.message;
    }
}

async function clearAIRouterLogs() {
    if (!confirm('Очистить все логи AI Router?')) return;
    const chatId = getChatId();
    if (!chatId) return;
    
    try {
        const res = await fetch(`${API_MANAGE}/ai/router-logs?chat_id=${encodeURIComponent(chatId)}`, {
            method: 'DELETE'
        });
        const data = await res.json();
        if (data.success) {
            showToast('Логи очищены', 'success');
            await loadAIRouterLogs();
        } else {
            showToast('Ошибка очистки', 'error');
        }
    } catch (e) {
        showToast('Ошибка очистки', 'error');
    }
}
