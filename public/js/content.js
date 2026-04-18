const API_CONTENT = `${window.location.origin}/api/content`;
const API_MANAGE = `${window.location.origin}/api/manage`;
let selectedJobId = null;
let editingTopicId = null;
let editingMaterialId = null;

const STATUS_RU = {
    pending: 'В очереди',
    used: 'Публикуется',
    completed: 'Опубликована',
    ready: 'Готов',
    approved: 'Одобрен',
    published: 'Опубликован',
    failed: 'Ошибка',
    draft: 'Черновик'
};
function statusRu(s) { return STATUS_RU[s] || s || '-'; }

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

function shorten(text, max = 180) {
    const value = String(text || '').trim();
    if (!value) return '-';
    if (value.length <= max) return value;
    return `${value.slice(0, max)}...`;
}

function parseMaybeJsonArray(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (!raw.startsWith('[')) return raw;
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.join(', ') : raw;
    } catch {
        return raw;
    }
}

async function fetchJson(url, options = {}) {
    const res = await fetch(url, options);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        throw new Error(data.error || 'Request failed');
    }
    return data;
}

async function loadDashboard() {
    await Promise.all([
        loadTopics(),
        loadMaterials(),
        loadJobs(),
        loadInteriors()
    ]);
}

// ============================================
// Interiors
// ============================================

async function loadInteriors() {
    const container = document.getElementById('interiorsList');
    if (!container) return;
    try {
        const chatId = getChatId();
        const resp = await fetch(`/api/video/interiors?chat_id=${encodeURIComponent(chatId)}&limit=50`);
        const data = await resp.json();
        if (!data.interiors || data.interiors.length === 0) {
            container.innerHTML = '<div style="color: #999; font-size: 13px;">Нет интерьеров. Добавьте первый.</div>';
            return;
        }
        container.innerHTML = data.interiors.map(interior => `
            <div style="display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid #f0f0f0;">
                <div>
                    <strong style="font-size: 13px;">${interior.style || 'Без стиля'}</strong>
                    <div style="color: #666; font-size: 12px;">${interior.description.slice(0, 100)}${interior.description.length > 100 ? '...' : ''}</div>
                    <div style="color: #999; font-size: 11px;">${new Date(interior.created_at).toLocaleString('ru')}</div>
                </div>
                <button onclick="deleteInterior(${interior.id})" style="background: #dc3545; color: #fff; border: none; padding: 4px 10px; border-radius: 4px; cursor: pointer; font-size: 12px; flex-shrink: 0;">Удалить</button>
            </div>
        `).join('');
    } catch (e) {
        console.error('Load interiors error:', e);
    }
}

async function addInterior() {
    const chatId = getChatId();
    const desc = document.getElementById('interiorDesc').value.trim();
    const style = document.getElementById('interiorStyle').value.trim();
    if (!desc) { alert('Введите описание интерьера'); return; }
    try {
        const resp = await fetch('/api/video/interiors', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, description: desc, style })
        });
        const data = await resp.json();
        if (data.success) {
            document.getElementById('interiorDesc').value = '';
            document.getElementById('interiorStyle').value = '';
            loadInteriors();
        } else {
            alert('Ошибка: ' + (data.error || 'Неизвестная'));
        }
    } catch (e) {
        alert('Ошибка: ' + e.message);
    }
}

async function deleteInterior(id) {
    if (!confirm('Удалить этот интерьер?')) return;
    const chatId = getChatId();
    try {
        const resp = await fetch(`/api/video/interiors/${id}?chat_id=${encodeURIComponent(chatId)}`, { method: 'DELETE' });
        const data = await resp.json();
        if (data.success) {
            loadInteriors();
        } else {
            alert('Ошибка: ' + (data.error || 'Неизвестная'));
        }
    } catch (e) {
        alert('Ошибка: ' + e.message);
    }
}


async function loadMetrics() {
    const chatId = getChatId();
    if (!chatId) return;
    try {
        const data = await fetchJson(`${API_CONTENT}/metrics?chat_id=${encodeURIComponent(chatId)}`);
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

async function loadTopics() {
    const chatId = getChatId();
    if (!chatId) return;
    const status = document.getElementById('topicsStatusFilter')?.value || '';
    const qs = new URLSearchParams({ chat_id: chatId, limit: '200' });
    if (status) qs.set('status', status);
    try {
        const data = await fetchJson(`${API_CONTENT}/topics?${qs.toString()}`);
        renderTopicsTable(data.items || []);
    } catch (e) {
        setApiStatus(`Темы: ${e.message}`, 'error');
    }
}

function renderTopicsTable(items) {
    const body = document.getElementById('topicsTableBody');
    if (!body) return;
    if (!items.length) {
        body.innerHTML = '<tr><td colspan="8" class="content-empty-cell">Темы не найдены</td></tr>';
        return;
    }

    body.innerHTML = items.map((item) => {
        const isEditing = editingTopicId == item.id;
        return `
            <tr>
                <td>${item.id}</td>
                <td>${isEditing
                    ? `<input type="text" id="topic-edit-topic-${item.id}" value="${escapeHtml(item.topic || '')}" class="content-inline-input">`
                    : escapeHtml(item.topic || '-')}</td>
                <td>${isEditing
                    ? `<input type="text" id="topic-edit-focus-${item.id}" value="${escapeHtml(item.focus || '')}" class="content-inline-input">`
                    : escapeHtml(item.focus || '-')}</td>
                <td>${isEditing
                    ? `
                        <div class="content-inline-stack">
                            <input type="text" id="topic-edit-secondary-${item.id}" value="${escapeHtml(parseMaybeJsonArray(item.secondary) || '')}" class="content-inline-input" placeholder="Secondary">
                            <input type="text" id="topic-edit-lsi-${item.id}" value="${escapeHtml(parseMaybeJsonArray(item.lsi) || '')}" class="content-inline-input" placeholder="LSI">
                        </div>
                    `
                    : escapeHtml([parseMaybeJsonArray(item.secondary), parseMaybeJsonArray(item.lsi)].filter(Boolean).join(' | ') || '-')}</td>
                <td>${isEditing
                    ? `
                        <select id="topic-edit-channel-${item.id}" class="content-inline-input">
                            <option value="">Все</option>
                            <option value="telegram" ${item.channel === 'telegram' ? 'selected' : ''}>Telegram</option>
                            <option value="vk" ${item.channel === 'vk' ? 'selected' : ''}>ВКонтакте</option>
                            <option value="ok" ${item.channel === 'ok' ? 'selected' : ''}>Одноклассники</option>
                            <option value="instagram" ${item.channel === 'instagram' ? 'selected' : ''}>Instagram</option>
                            <option value="instagram_reels" ${item.channel === 'instagram_reels' ? 'selected' : ''}>Instagram Reels</option>
                            <option value="facebook" ${item.channel === 'facebook' ? 'selected' : ''}>Facebook</option>
                            <option value="pinterest" ${item.channel === 'pinterest' ? 'selected' : ''}>Pinterest</option>
                            <option value="wordpress" ${item.channel === 'wordpress' ? 'selected' : ''}>WP-блог</option>
                            <option value="youtube" ${item.channel === 'youtube' ? 'selected' : ''}>YouTube Shorts</option>
                            <option value="tiktok" ${item.channel === 'tiktok' ? 'selected' : ''}>TikTok</option>
                            <option value="vk_video" ${item.channel === 'vk_video' ? 'selected' : ''}>VK Видео</option>
                        </select>
                    `
                    : escapeHtml(item.channel || '—')}</td>
                <td>${isEditing
                    ? `
                        <select id="topic-edit-status-${item.id}" class="content-inline-input">
                            <option value="pending" ${item.status === 'pending' ? 'selected' : ''}>В очереди</option>
                            <option value="used" ${item.status === 'used' ? 'selected' : ''}>Публикуется</option>
                            <option value="completed" ${item.status === 'completed' ? 'selected' : ''}>Опубликована</option>
                        </select>
                    `
                    : `<span class="content-status-badge">${escapeHtml(statusRu(item.status))}</span>`}</td>
                <td>${fmtDate(item.created_at)}</td>
                <td>
                    <div class="content-actions">
                        ${isEditing
                            ? `
                                <button class="btn btn-success" onclick="saveTopicInline(${item.id})">Сохранить</button>
                                <button class="btn btn-secondary" onclick="cancelTopicInline()">Отмена</button>
                            `
                            : `<button class="btn btn-secondary" onclick="editTopicInline(${item.id})">Редактировать</button>`}
                        <button class="btn btn-danger" onclick="deleteTopic(${item.id})">Удалить</button>
                    </div>
                </td>
            </tr>
        `;
    }).join('');
}

async function createTopic() {
    const chatId = getChatId();
    if (!chatId) return;
    try {
        await fetchJson(`${API_CONTENT}/topics`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                topic: document.getElementById('topicTitle')?.value.trim(),
                focus: document.getElementById('topicFocus')?.value.trim(),
                secondary: document.getElementById('topicSecondary')?.value.trim(),
                lsi: document.getElementById('topicLsi')?.value.trim(),
                channel: document.getElementById('topicChannel')?.value || null
            })
        });
        showToast('Тема добавлена', 'success');
        ['topicTitle', 'topicFocus', 'topicSecondary', 'topicLsi', 'topicChannel'].forEach((id) => {
            const el = document.getElementById(id);
            if (el) el.value = '';
        });
        await loadTopics();
    } catch (e) {
        showToast(e.message, 'error');
        setApiStatus(`Тема: ${e.message}`, 'error');
    }
}

function editTopicInline(topicId) {
    editingMaterialId = null;
    editingTopicId = topicId;
    loadTopics();
}

function cancelTopicInline() {
    editingTopicId = null;
    loadTopics();
}

async function saveTopicInline(topicId) {
    const chatId = getChatId();
    if (!chatId) return;
    
    // Собираем только изменённые поля
    const payload = {
        chat_id: chatId
    };
    
    const topicEl = document.getElementById(`topic-edit-topic-${topicId}`);
    const focusEl = document.getElementById(`topic-edit-focus-${topicId}`);
    const secondaryEl = document.getElementById(`topic-edit-secondary-${topicId}`);
    const lsiEl = document.getElementById(`topic-edit-lsi-${topicId}`);
    const statusEl = document.getElementById(`topic-edit-status-${topicId}`);
    
    if (topicEl) {
        const val = topicEl.value.trim();
        if (val) payload.topic = val;
    }
    if (focusEl) {
        const val = focusEl.value.trim();
        if (val) payload.focus = val;
    }
    if (secondaryEl) {
        const val = secondaryEl.value.trim();
        if (val) payload.secondary = val;
    }
    if (lsiEl) {
        const val = lsiEl.value.trim();
        if (val) payload.lsi = val;
    }
    const channelEl = document.getElementById(`topic-edit-channel-${topicId}`);
    if (channelEl) {
        payload.channel = channelEl.value || null;
    }
    if (statusEl) {
        const val = statusEl.value.trim();
        if (val && ['pending', 'used', 'completed'].includes(val)) {
            payload.status = val;
        }
    }
    
    try {
        await fetchJson(`${API_CONTENT}/topics/${topicId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        editingTopicId = null;
        showToast('Тема обновлена', 'success');
        await loadTopics();
    } catch (e) {
        showToast(e.message, 'error');
    }
}

async function deleteTopic(topicId) {
    const chatId = getChatId();
    if (!chatId) return;
    if (!confirm('Удалить тему?')) return;
    try {
        await fetchJson(`${API_CONTENT}/topics/${topicId}?chat_id=${encodeURIComponent(chatId)}`, {
            method: 'DELETE'
        });
        showToast('Тема удалена', 'success');
        editingTopicId = null;
        await loadTopics();
    } catch (e) {
        showToast(e.message, 'error');
    }
}

function getImportPrefix(mode) {
    if (mode === 'materials') return 'materials';
    if (mode === 'interiors') return 'interiors';
    return 'topics';
}

function getImportPayload(mode) {
    const prefix = getImportPrefix(mode);
    return {
        chat_id: getChatId(),
        mode,
        sheet_url: document.getElementById(`${prefix}SheetUrl`)?.value.trim(),
        gid: document.getElementById(`${prefix}SheetGid`)?.value.trim()
    };
}

function renderImportPreview(data, mode) {
    const prefix = getImportPrefix(mode);
    const wrap = document.getElementById(`${prefix}ImportPreviewWrap`);
    const head = document.getElementById(`${prefix}ImportPreviewHead`);
    const body = document.getElementById(`${prefix}ImportPreviewBody`);
    const meta = document.getElementById(`${prefix}ImportPreviewMeta`);
    if (!wrap || !head || !body || !meta) return;

    wrap.style.display = 'block';
    meta.textContent = `rows: ${data.totalRows}, duplicates: ${data.skippedDuplicates}, empty: ${data.skippedEmpty}`;

    const previewRows = (data.preview || []).slice(0, 5);

    if (mode === 'materials') {
        head.innerHTML = '<tr><th>Row</th><th>Title</th><th>Source</th><th>Content</th><th>Duplicate</th></tr>';
        body.innerHTML = previewRows.map((item) => `
            <tr>
                <td>${item.row}</td>
                <td>${escapeHtml(item.title || '-')}</td>
                <td>${escapeHtml([item.source_type, item.source_url].filter(Boolean).join(' | ') || '-')}</td>
                <td>${escapeHtml(shorten(item.content, 180))}</td>
                <td>${item.duplicate ? 'yes' : 'no'}</td>
            </tr>
        `).join('') || '<tr><td colspan="5" class="content-empty-cell">Нет строк для импорта</td></tr>';
    } else if (mode === 'interiors') {
        head.innerHTML = '<tr><th>Row</th><th>Description</th><th>Style</th><th>Duplicate</th></tr>';
        body.innerHTML = previewRows.map((item) => `
            <tr>
                <td>${item.row}</td>
                <td>${escapeHtml(item.description || '-')}</td>
                <td>${escapeHtml(item.style || '-')}</td>
                <td>${item.duplicate ? 'yes' : 'no'}</td>
            </tr>
        `).join('') || '<tr><td colspan="4" class="content-empty-cell">Нет строк для импорта</td></tr>';
    } else {
        head.innerHTML = '<tr><th>Row</th><th>Topic</th><th>Focus</th><th>Status</th><th>Duplicate</th></tr>';
        body.innerHTML = previewRows.map((item) => `
            <tr>
                <td>${item.row}</td>
                <td>${escapeHtml(item.topic || '-')}</td>
                <td>${escapeHtml(item.focus || '-')}</td>
                <td>${escapeHtml(statusRu(item.status))}</td>
                <td>${item.duplicate ? 'yes' : 'no'}</td>
            </tr>
        `).join('') || '<tr><td colspan="5" class="content-empty-cell">Нет строк для импорта</td></tr>';
    }
}

async function previewSheetImport(mode) {
    const chatId = getChatId();
    if (!chatId) return;
    const prefix = getImportPrefix(mode);
    const statusEl = document.getElementById(`${prefix}ImportStatus`);
    if (statusEl) {
        statusEl.textContent = 'Собираем предпросмотр...';
        statusEl.className = 'content-status-line';
    }
    try {
        const data = await fetchJson(`${API_CONTENT}/import-google-sheet/preview`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(getImportPayload(mode))
        });
        renderImportPreview(data, mode);
        if (statusEl) {
            statusEl.textContent = `Предпросмотр готов: ${data.preview?.length || 0} строк`;
            statusEl.className = 'content-status-line ok';
        }
        showToast('Предпросмотр готов', 'success');
    } catch (e) {
        if (statusEl) {
            statusEl.textContent = e.message;
            statusEl.className = 'content-status-line error';
        }
        showToast(e.message, 'error');
    }
}

async function applySheetImport(mode) {
    const chatId = getChatId();
    if (!chatId) return;
    const prefix = getImportPrefix(mode);
    const statusEl = document.getElementById(`${prefix}ImportStatus`);
    if (statusEl) {
        statusEl.textContent = 'Импортируем данные...';
        statusEl.className = 'content-status-line';
    }
    try {
        const data = await fetchJson(`${API_CONTENT}/import-google-sheet`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(getImportPayload(mode))
        });
        if (statusEl) {
            statusEl.textContent = `Импортировано: ${data.imported}, дубликаты: ${data.skippedDuplicates}, пустые строки: ${data.skippedEmpty}`;
            statusEl.className = 'content-status-line ok';
        }
        showToast('Импорт завершён', 'success');
        const previewWrap = document.getElementById(`${prefix}ImportPreviewWrap`);
        if (previewWrap) previewWrap.style.display = 'none';
        if (mode === 'materials') {
            await loadMaterials();
        } else if (mode === 'interiors') {
            await loadInteriors();
        } else {
            await loadTopics();
        }
    } catch (e) {
        if (statusEl) {
            statusEl.textContent = e.message;
            statusEl.className = 'content-status-line error';
        }
        showToast(e.message, 'error');
    }
}

async function loadMaterials() {
    const chatId = getChatId();
    if (!chatId) return;
    try {
        const data = await fetchJson(`${API_CONTENT}/materials?chat_id=${encodeURIComponent(chatId)}&limit=100`);
        renderMaterialsTable(data.items || []);
    } catch (e) {
        setApiStatus(`Материалы: ${e.message}`, 'error');
    }
}

function renderMaterialsTable(items) {
    const body = document.getElementById('materialsTableBody');
    if (!body) return;
    if (!items.length) {
        body.innerHTML = '<tr><td colspan="6" class="content-empty-cell">Материалы не найдены</td></tr>';
        return;
    }

    body.innerHTML = items.map((item) => {
        const isEditing = editingMaterialId === item.id;
        return `
            <tr>
                <td>${item.id}</td>
                <td>${isEditing
                    ? `<input type="text" id="material-edit-title-${item.id}" value="${escapeHtml(item.title || '')}" class="content-inline-input">`
                    : escapeHtml(item.title || '-')}</td>
                <td>${isEditing
                    ? `
                        <div class="content-inline-stack">
                            <input type="text" id="material-edit-source-type-${item.id}" value="${escapeHtml(item.source_type || '')}" class="content-inline-input" placeholder="Source type">
                            <input type="text" id="material-edit-source-url-${item.id}" value="${escapeHtml(item.source_url || '')}" class="content-inline-input" placeholder="Source URL">
                        </div>
                    `
                    : escapeHtml([item.source_type, item.source_url].filter(Boolean).join(' | ') || '-')}</td>
                <td>${isEditing
                    ? `<textarea id="material-edit-content-${item.id}" class="content-inline-textarea">${escapeHtml(item.content || '')}</textarea>`
                    : escapeHtml(shorten(item.content, 220))}</td>
                <td>${fmtDate(item.created_at)}</td>
                <td>
                    <div class="content-actions">
                        ${isEditing
                            ? `
                                <button class="btn btn-success" onclick="saveMaterialInline(${item.id})">Сохранить</button>
                                <button class="btn btn-secondary" onclick="cancelMaterialInline()">Отмена</button>
                            `
                            : `<button class="btn btn-secondary" onclick="editMaterialInline(${item.id})">Редактировать</button>`}
                        <button class="btn btn-danger" onclick="deleteMaterial(${item.id})">Удалить</button>
                    </div>
                </td>
            </tr>
        `;
    }).join('');
}

async function createMaterial() {
    const chatId = getChatId();
    if (!chatId) return;
    try {
        await fetchJson(`${API_CONTENT}/materials`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                title: document.getElementById('materialTitle')?.value.trim(),
                source_type: document.getElementById('materialSourceType')?.value.trim(),
                source_url: document.getElementById('materialSourceUrl')?.value.trim(),
                content: document.getElementById('materialContent')?.value.trim()
            })
        });
        showToast('Материал сохранён', 'success');
        ['materialTitle', 'materialSourceType', 'materialSourceUrl', 'materialContent'].forEach((id) => {
            const el = document.getElementById(id);
            if (el) el.value = '';
        });
        await loadMaterials();
    } catch (e) {
        showToast(e.message, 'error');
        setApiStatus(`Материал: ${e.message}`, 'error');
    }
}

function editMaterialInline(materialId) {
    editingTopicId = null;
    editingMaterialId = materialId;
    loadMaterials();
}

function cancelMaterialInline() {
    editingMaterialId = null;
    loadMaterials();
}

async function saveMaterialInline(materialId) {
    const chatId = getChatId();
    if (!chatId) return;
    try {
        await fetchJson(`${API_CONTENT}/materials/${materialId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                title: document.getElementById(`material-edit-title-${materialId}`).value.trim(),
                source_type: document.getElementById(`material-edit-source-type-${materialId}`).value.trim(),
                source_url: document.getElementById(`material-edit-source-url-${materialId}`).value.trim(),
                content: document.getElementById(`material-edit-content-${materialId}`).value.trim()
            })
        });
        editingMaterialId = null;
        showToast('Материал обновлён', 'success');
        await loadMaterials();
    } catch (e) {
        showToast(e.message, 'error');
    }
}

async function deleteMaterial(materialId) {
    const chatId = getChatId();
    if (!chatId) return;
    if (!confirm('Удалить материал?')) return;
    try {
        await fetchJson(`${API_CONTENT}/materials/${materialId}?chat_id=${encodeURIComponent(chatId)}`, {
            method: 'DELETE'
        });
        showToast('Материал удалён', 'success');
        editingMaterialId = null;
        await loadMaterials();
    } catch (e) {
        showToast(e.message, 'error');
    }
}

async function loadJobs() {
    const chatId = getChatId();
    if (!chatId) return;
    const status = document.getElementById('jobsStatusFilter')?.value || '';
    const qs = new URLSearchParams({ chat_id: chatId, limit: '100' });
    if (status) qs.set('status', status);
    try {
        const data = await fetchJson(`${API_CONTENT}/jobs?${qs.toString()}`);
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
            <td><span class="content-status-badge">${escapeHtml(statusRu(item.status))}</span></td>
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
        const data = await fetchJson(`${API_CONTENT}/jobs/${jobId}?chat_id=${encodeURIComponent(chatId)}`);
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
        const data = await fetchJson(`${API_CONTENT}/jobs/${selectedJobId}/${action}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId })
        });
        showToast(data.message || 'Действие выполнено', 'success');
        await openJobDetails(selectedJobId);
        await loadJobs();
        await loadMetrics();
    } catch (e) {
        showToast(e.message, 'error');
        setApiStatus(e.message, 'error');
    }
}

