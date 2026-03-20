const API_CONTENT = `${window.location.origin}/api/content`;
const API_MANAGE = `${window.location.origin}/api/manage`;

let selectedJobId = null;

async function onLoginSuccess() {
    await loadDashboard();
}

function fmtDate(v) {
    if (!v) return '-';
    try {
        return new Date(v).toLocaleString('ru-RU');
    } catch {
        return v;
    }
}

function setApiStatus(msg, type = 'info') {
    const el = document.getElementById('apiStatusLine');
    if (!el) return;
    el.textContent = msg || '';
    el.className = `content-status-line ${type}`;
}

async function loadDashboard() {
    await Promise.all([
        loadContentSettings(),
        loadMetrics(),
        loadJobs()
    ]);
}

/**
 * Обновить скрытое поле scheduleTime на основе выбора часа и минут
 */
function updateScheduleTime() {
    const hour = document.getElementById('contentScheduleHour')?.value || '00';
    const minute = document.getElementById('contentScheduleMinute')?.value || '00';
    const timeField = document.getElementById('contentScheduleTime');
    if (timeField) {
        timeField.value = `${hour}:${minute.padStart(2, '0')}`;
    }
}

/**
 * Валидация ввода минут (только цифры, 00-59)
 */
function validateMinutes() {
    const minuteInput = document.getElementById('contentScheduleMinute');
    if (!minuteInput) return;
    
    // Удаляем нецифровые символы
    let val = minuteInput.value.replace(/[^0-9]/g, '');
    
    // Ограничиваем до 2 символов
    if (val.length > 2) {
        val = val.slice(0, 2);
    }
    
    // Ограничиваем максимум 59
    if (val !== '' && parseInt(val, 10) > 59) {
        val = '59';
    }
    
    minuteInput.value = val;
    updateScheduleTime();
}

/**
 * Установить значения часа и минуты из строки времени HH:MM
 */
function setScheduleTimeInputs(timeValue) {
    if (!timeValue) return;
    
    const parts = timeValue.split(':');
    if (parts.length >= 2) {
        const hourSelect = document.getElementById('contentScheduleHour');
        const minuteInput = document.getElementById('contentScheduleMinute');
        
        if (hourSelect) {
            hourSelect.value = parts[0].padStart(2, '0');
        }
        if (minuteInput) {
            minuteInput.value = parts[1].padStart(2, '0');
        }
        updateScheduleTime();
    }
}

/**
 * Обновить поле timezone (вызывается при изменении select)
 */
function updateScheduleTz() {
    // Функция для совместимости, значение берётся напрямую из select
}

/**
 * Установить значение timezone в select
 */
function setScheduleTzInput(tzValue) {
    const tzSelect = document.getElementById('contentScheduleTz');
    if (!tzSelect || !tzValue) return;
    
    // Проверяем, есть ли такой часовой пояс в списке
    const optionExists = Array.from(tzSelect.options).some(opt => opt.value === tzValue);
    if (optionExists) {
        tzSelect.value = tzValue;
    } else {
        // Если такого пояса нет, добавляем его как первый опцион
        const newOption = document.createElement('option');
        newOption.value = tzValue;
        newOption.text = `${tzValue} (custom)`;
        newOption.selected = true;
        tzSelect.insertBefore(newOption, tzSelect.firstChild);
    }
}

async function runNow() {
    const chatId = getChatId();
    if (!chatId) return;
    const btn = document.getElementById('runNowBtn');
    if (btn) btn.disabled = true;
    setApiStatus('Запуск генерации...', 'info');
    try {
        const res = await fetch(`${API_CONTENT}/run-now`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, reason: 'ui_manual' })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'run-now failed');
        showToast(data.message || 'Запуск выполнен', 'success');
        setApiStatus(data.message || 'OK', 'ok');
        await loadJobs();
    } catch (e) {
        showToast(e.message, 'error');
        setApiStatus(e.message, 'error');
    } finally {
        if (btn) btn.disabled = false;
    }
}

async function loadMetrics() {
    const chatId = getChatId();
    if (!chatId) return;
    try {
        const res = await fetch(`${API_CONTENT}/metrics?chat_id=${encodeURIComponent(chatId)}`);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'metrics failed');
        const w24 = data?.windows?.last24h || {};
        const w7 = data?.windows?.last7d || {};
        document.getElementById('metricPublished24h').textContent = w24.published ?? '-';
        document.getElementById('metricFailed24h').textContent = w24.failed ?? '-';
        document.getElementById('metricPublished7d').textContent = w7.published ?? '-';
        document.getElementById('metricSuccess24h').textContent = w24.success_rate == null
            ? '-'
            : `${Math.round(Number(w24.success_rate) * 100)}%`;
    } catch (e) {
        setApiStatus(`Метрики: ${e.message}`, 'error');
    }
}

async function loadJobs() {
    const chatId = getChatId();
    if (!chatId) return;
    const status = document.getElementById('jobsStatusFilter')?.value || '';
    const qs = new URLSearchParams({ chat_id: chatId, limit: '100' });
    if (status) qs.set('status', status);
    try {
        const res = await fetch(`${API_CONTENT}/jobs?${qs.toString()}`);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'jobs failed');
        renderJobsTable(data.items || []);
    } catch (e) {
        setApiStatus(`Jobs: ${e.message}`, 'error');
    }
}

function renderJobsTable(items) {
    const body = document.getElementById('jobsTableBody');
    if (!body) return;
    if (!items.length) {
        body.innerHTML = '<tr><td colspan="6" class="content-empty-cell">Jobs не найдены</td></tr>';
        return;
    }
    body.innerHTML = items.map((item) => `
        <tr>
            <td>${item.id}</td>
            <td>${escapeHtml(item.sheet_topic || '-')}</td>
            <td><span class="content-status-badge">${escapeHtml(item.status || '-')}</span></td>
            <td>${escapeHtml(item.publish_status || item.last_publish_status || '-')}</td>
            <td>${fmtDate(item.created_at)}</td>
            <td><button class="btn btn-primary" onclick="openJobDetails(${item.id})">Открыть</button></td>
        </tr>
    `).join('');
}

async function openJobDetails(jobId) {
    const chatId = getChatId();
    if (!chatId) return;
    selectedJobId = jobId;
    try {
        const res = await fetch(`${API_CONTENT}/jobs/${jobId}?chat_id=${encodeURIComponent(chatId)}`);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'job details failed');
        renderJobDetails(data.job);
    } catch (e) {
        showToast(e.message, 'error');
        setApiStatus(e.message, 'error');
    }
}

function renderJobDetails(job) {
    const empty = document.getElementById('jobDetailsEmpty');
    const card = document.getElementById('jobDetailsCard');
    const meta = document.getElementById('jobMeta');
    const bodyText = document.getElementById('jobBodyText');
    const logs = document.getElementById('jobPublishLogs');
    if (!empty || !card || !meta || !bodyText || !logs) return;

    empty.style.display = 'none';
    card.style.display = 'block';
    meta.innerHTML = `
        <div><strong>ID:</strong> ${job.id}</div>
        <div><strong>Тема:</strong> ${escapeHtml(job.sheet_topic || '-')}</div>
        <div><strong>Статус:</strong> ${escapeHtml(job.status || '-')}</div>
        <div><strong>Publish:</strong> ${escapeHtml(job.publish_status || '-')}</div>
        <div><strong>Создано:</strong> ${fmtDate(job.created_at)}</div>
        <div><strong>Обновлено:</strong> ${fmtDate(job.updated_at)}</div>
    `;
    bodyText.value = job.body_text || job.draft_text || '';
    logs.textContent = (job.publish_logs || []).length
        ? JSON.stringify(job.publish_logs, null, 2)
        : 'Логов публикации пока нет';
}

async function moderateSelectedJob(action) {
    const chatId = getChatId();
    if (!chatId || !selectedJobId) {
        showToast('Сначала выберите job', 'error');
        return;
    }
    const ask = action === 'approve' ? 'Подтвердить публикацию?' : `Выполнить действие: ${action}?`;
    if (!confirm(ask)) return;
    try {
        const res = await fetch(`${API_CONTENT}/jobs/${selectedJobId}/${action}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'moderation action failed');
        showToast(data.message || 'Действие выполнено', 'success');
        await openJobDetails(selectedJobId);
        await loadJobs();
        await loadMetrics();
    } catch (e) {
        showToast(e.message, 'error');
        setApiStatus(e.message, 'error');
    }
}

async function loadContentSettings() {
    const chatId = getChatId();
    if (!chatId) return;
    try {
        const res = await fetch(`${API_MANAGE}/content/settings?chat_id=${encodeURIComponent(chatId)}`);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'load content settings failed');
        const s = data.settings || {};
        document.getElementById('contentChannelId').value = s.channelId || '';
        document.getElementById('contentModeratorUserId').value = s.moderatorUserId || '';
        
        // Устанавливаем время через новые инпуты
        const scheduleTime = s.scheduleTime || '';
        document.getElementById('contentScheduleTime').value = scheduleTime;
        if (scheduleTime) {
            setScheduleTimeInputs(scheduleTime);
        }
        
        // Устанавливаем часовой пояс через select
        const scheduleTz = s.scheduleTz || 'Europe/Moscow';
        setScheduleTzInput(scheduleTz);
        
        document.getElementById('contentDailyLimit').value = s.dailyLimit || '';
    } catch (e) {
        setApiStatus(`Settings: ${e.message}`, 'error');
    }
}

async function saveContentSettings() {
    const chatId = getChatId();
    if (!chatId) return;
    
    // Обновляем скрытое поле перед отправкой
    updateScheduleTime();
    
    const payload = {
        chat_id: chatId,
        channel_id: document.getElementById('contentChannelId').value.trim(),
        moderator_user_id: document.getElementById('contentModeratorUserId').value.trim(),
        schedule_time: document.getElementById('contentScheduleTime').value.trim(),
        schedule_tz: document.getElementById('contentScheduleTz').value.trim(),
        daily_limit: document.getElementById('contentDailyLimit').value.trim()
    };
    try {
        const res = await fetch(`${API_MANAGE}/content/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'save content settings failed');
        showToast('Настройки сохранены', 'success');
        setApiStatus('Настройки контента сохранены', 'ok');
        await loadContentSettings();
    } catch (e) {
        showToast(e.message, 'error');
        setApiStatus(e.message, 'error');
    }
}
