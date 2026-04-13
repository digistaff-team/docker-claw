/**
 * Video Pipeline UI
 */

let currentChatId = null;
let selectedModel = 'veo3.1';

// ============================================
// Init
// ============================================

document.addEventListener('DOMContentLoaded', async () => {
    currentChatId = await resolveChatId();
    if (!currentChatId) {
        showError('Не удалось определить chat_id. Авторизуйтесь.');
        return;
    }
    loadModelSettings();
    loadInteriors();
    loadProductImages();
    loadVideos();
    loadStats();
});

// ============================================
// Generation
// ============================================

// ============================================
// Model Settings
// ============================================

async function loadModelSettings() {
    try {
        const resp = await fetch(`/api/video/settings?chat_id=${encodeURIComponent(currentChatId)}`);
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
    try {
        const resp = await fetch('/api/video/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: currentChatId, model: modelId })
        });
        const data = await resp.json();
        if (data.success) {
            selectedModel = modelId;
            // Обновить визуал карточек
            document.querySelectorAll('.model-card').forEach(el => {
                el.classList.toggle('model-card--active', el.querySelector('.model-card__name')?.textContent === getModelName(modelId));
            });
            await loadModelSettings(); // перерисовать с актуальным состоянием
            const status = document.getElementById('modelSaveStatus');
            if (status) { status.style.display = 'inline'; setTimeout(() => status.style.display = 'none', 2000); }
        }
    } catch (e) {
        console.error('Model save error:', e);
    }
}

function getModelName(id) {
    const map = { 'veo3.1': 'Veo 3.1', 'seedance-2': 'Seedance 2.0', 'grok-imagine': 'Grok Imagine' };
    return map[id] || id;
}

// ============================================
// Generation
// ============================================

async function startGeneration() {
    const channel = document.getElementById('initiatingChannel').value;
    const btn = document.getElementById('btnGenerate');
    const statusDiv = document.getElementById('generationStatus');
    const statusText = document.getElementById('generationText');

    btn.disabled = true;
    btn.textContent = 'Генерация...';
    statusDiv.style.display = 'block';
    statusText.textContent = 'Запуск генерации видео...';

    try {
        const resp = await fetch('/api/video/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: currentChatId, channel, model: selectedModel })
        });

        const data = await resp.json();

        if (data.success) {
            statusText.textContent = `✅ Видео генерируется (ID: ${data.videoId}). Статус обновляется автоматически.`;
            // Polling статуса
            pollVideoStatus(data.videoId);
        } else {
            statusText.textContent = `❌ Ошибка: ${data.error || data.message}`;
            btn.disabled = false;
            btn.textContent = 'Сгенерировать видео';
        }
    } catch (e) {
        statusText.textContent = `❌ Ошибка: ${e.message}`;
        btn.disabled = false;
        btn.textContent = 'Сгенерировать видео';
    }
}

async function pollVideoStatus(videoId) {
    const statusText = document.getElementById('generationText');
    const btn = document.getElementById('btnGenerate');
    const maxAttempts = 60;
    let attempts = 0;

    const interval = setInterval(async () => {
        attempts++;
        try {
            const resp = await fetch(`/api/video/assets/${videoId}?chat_id=${currentChatId}`);
            const data = await resp.json();

            if (data.success) {
                const status = data.video.status;
                statusText.textContent = `Статус: ${translateStatus(status)} (попытка ${attempts}/${maxAttempts})`;

                if (['video_ready', 'published'].includes(status)) {
                    clearInterval(interval);
                    statusText.textContent = `✅ Видео готово! ID: ${videoId}`;
                    btn.disabled = false;
                    btn.textContent = 'Сгенерировать видео';
                    loadVideos();
                    loadStats();
                } else if (status === 'failed') {
                    clearInterval(interval);
                    statusText.textContent = `❌ Генерация не удалась`;
                    btn.disabled = false;
                    btn.textContent = 'Сгенерировать видео';
                }
            }
        } catch (e) {
            console.error('Poll error:', e);
        }

        if (attempts >= maxAttempts) {
            clearInterval(interval);
            statusText.textContent = `⏳ Таймаут генерации. Проверьте библиотеку видео.`;
            btn.disabled = false;
            btn.textContent = 'Сгенерировать видео';
            loadVideos();
        }
    }, 10000); // каждые 10 секунд
}

function translateStatus(status) {
    const map = {
        pending: 'Ожидает',
        scene_generating: 'Генерация сцены...',
        scene_ready: 'Сцена готова',
        video_generating: 'Генерация видео...',
        video_ready: 'Видео готово',
        published: 'Опубликовано',
        expired: 'Удалено',
        failed: 'Ошибка'
    };
    return map[status] || status;
}

// ============================================
// Interiors
// ============================================

async function loadInteriors() {
    try {
        const resp = await fetch(`/api/video/interiors?chat_id=${currentChatId}&limit=50`);
        const data = await resp.json();

        const container = document.getElementById('interiorsList');

        if (!data.interiors || data.interiors.length === 0) {
            container.innerHTML = '<div class="empty-state">Нет интерьеров. Добавьте первый.</div>';
            return;
        }

        container.innerHTML = data.interiors.map(interior => `
            <div class="interior-item">
                <div>
                    <strong>${interior.style || 'Без стиля'}</strong>
                    <div style="color: #666; font-size: 13px;">${interior.description.slice(0, 100)}${interior.description.length > 100 ? '...' : ''}</div>
                    <div style="color: #999; font-size: 11px;">${new Date(interior.created_at).toLocaleString('ru')}</div>
                </div>
                <button onclick="deleteInterior(${interior.id})" style="background: #dc3545; color: #fff; border: none; padding: 4px 10px; border-radius: 4px; cursor: pointer; font-size: 12px;">Удалить</button>
            </div>
        `).join('');
    } catch (e) {
        console.error('Load interiors error:', e);
    }
}

async function addInterior() {
    const desc = document.getElementById('interiorDesc').value.trim();
    const style = document.getElementById('interiorStyle').value.trim();

    if (!desc) {
        alert('Введите описание интерьера');
        return;
    }

    try {
        const resp = await fetch('/api/video/interiors', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: currentChatId, description: desc, style })
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

    try {
        const resp = await fetch(`/api/video/interiors/${id}?chat_id=${currentChatId}`, {
            method: 'DELETE'
        });

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

// ============================================
// Product Images
// ============================================

async function loadProductImages() {
    try {
        const resp = await fetch(`/api/video/product-images?chat_id=${currentChatId}`);
        const data = await resp.json();

        const container = document.getElementById('productImages');

        if (!data.images || data.images.length === 0) {
            container.innerHTML = '<div class="empty-state">Нет изображений. Загрузите файлы в /workspace/input</div>';
            return;
        }

        container.innerHTML = data.images.map(img => `
            <div class="image-item">
                <span>📷</span>
                <span>${img.filename}</span>
                <span style="color: #999; font-size: 12px;">(${formatBytes(img.size)})</span>
            </div>
        `).join('');
    } catch (e) {
        console.error('Load product images error:', e);
    }
}

// ============================================
// Video Library
// ============================================

async function loadVideos() {
    const status = document.getElementById('statusFilter').value;
    let url = `/api/video/assets?chat_id=${currentChatId}&limit=50`;
    if (status) url += `&status=${status}`;

    try {
        const resp = await fetch(url);
        const data = await resp.json();

        const container = document.getElementById('videoLibrary');

        if (!data.videos || data.videos.length === 0) {
            container.innerHTML = '<div class="empty-state">Нет видео. Сгенерируйте первое.</div>';
            return;
        }

        container.innerHTML = '<div class="video-grid">' + data.videos.map(video => {
            const marks = video.usage_marks || [];
            const channels = ['youtube', 'tiktok', 'instagram'];
            const marksMap = {};
            marks.forEach(m => marksMap[m.channel_type] = true);

            const videoUrl = video.video_path
                ? `/api/files/public/${currentChatId}/.video-temp/${currentChatId}/${video.video_path}`
                : null;

            const countdownHtml = video.scheduled_deletion_at
                ? `<div class="countdown" data-deletion="${video.scheduled_deletion_at}">⏰ <span class="countdown-value"></span></div>`
                : '';

            return `
                <div class="video-card" data-id="${video.id}">
                    ${videoUrl ? `<video src="${videoUrl}" muted preload="metadata" controls></video>` : '<div style="aspect-ratio:9/16;background:#333;display:flex;align-items:center;justify-content:center;color:#666;">Нет видео</div>'}
                    <div class="info">
                        <h4>Video #${video.id}</h4>
                        <span class="status-badge status-${video.status}">${translateStatus(video.status)}</span>
                        <div class="channel-marks">
                            ${channels.map(ch => `
                                <span class="channel-mark ${marksMap[ch] ? 'channel-used' : 'channel-free'}">
                                    ${ch.charAt(0).toUpperCase() + ch.slice(1)} ${marksMap[ch] ? '✓' : '—'}
                                </span>
                            `).join('')}
                        </div>
                        ${video.interior_style ? `<div style="font-size:11px;color:#999;margin-top:4px;">🏠 ${video.interior_style}</div>` : ''}
                        ${video.initiating_channel ? `<div style="font-size:11px;color:#999;">📺 ${video.initiating_channel}</div>` : ''}
                        ${countdownHtml}
                    </div>
                </div>
            `;
        }).join('') + '</div>';

        // Start countdown timers
        startCountdowns();
    } catch (e) {
        console.error('Load videos error:', e);
    }
}

function startCountdowns() {
    document.querySelectorAll('.countdown').forEach(el => {
        const deletionTime = new Date(el.dataset.deletion).getTime();
        const valueEl = el.querySelector('.countdown-value');

        const update = () => {
            const now = Date.now();
            const diff = deletionTime - now;

            if (diff <= 0) {
                valueEl.textContent = 'Удалено';
                return;
            }

            const minutes = Math.floor(diff / 60000);
            const seconds = Math.floor((diff % 60000) / 1000);
            valueEl.textContent = `${minutes}м ${seconds}с`;
        };

        update();
        setInterval(update, 1000);
    });
}

// ============================================
// Stats
// ============================================

async function loadStats() {
    try {
        const resp = await fetch(`/api/video/stats?chat_id=${currentChatId}`);
        const data = await resp.json();

        const container = document.getElementById('videoStats');

        if (!data.stats) {
            container.innerHTML = '<div class="empty-state">Нет данных</div>';
            return;
        }

        const stats = data.stats;
        container.innerHTML = `
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 12px;">
                <div style="text-align:center;padding:12px;background:#f8f9fa;border-radius:8px;">
                    <div style="font-size:24px;font-weight:bold;color:#007bff;">${stats.total || 0}</div>
                    <div style="font-size:12px;color:#666;">Всего</div>
                </div>
                <div style="text-align:center;padding:12px;background:#f8f9fa;border-radius:8px;">
                    <div style="font-size:24px;font-weight:bold;color:#28a745;">${stats.video_ready || 0}</div>
                    <div style="font-size:12px;color:#666;">Готово</div>
                </div>
                <div style="text-align:center;padding:12px;background:#f8f9fa;border-radius:8px;">
                    <div style="font-size:24px;font-weight:bold;color:#17a2b8;">${stats.published || 0}</div>
                    <div style="font-size:12px;color:#666;">Использовано</div>
                </div>
                <div style="text-align:center;padding:12px;background:#f8f9fa;border-radius:8px;">
                    <div style="font-size:24px;font-weight:bold;color:#dc3545;">${stats.expired || 0}</div>
                    <div style="font-size:12px;color:#666;">Удалено</div>
                </div>
            </div>
        `;
    } catch (e) {
        console.error('Load stats error:', e);
    }
}

// ============================================
// Helpers
// ============================================

function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function showError(message) {
    document.querySelector('.container').innerHTML = `
        <div style="text-align:center;padding:40px;color:#dc3545;">
            <h2>⚠️ Ошибка</h2>
            <p>${message}</p>
        </div>
    `;
}

async function resolveChatId() {
    // Try from session or URL params
    const params = new URLSearchParams(window.location.search);
    if (params.get('chat_id')) return params.get('chat_id');

    // Try from common.js
    if (window.currentChatId) return window.currentChatId;

    // Try from auth
    try {
        const resp = await fetch('/api/session/current');
        const data = await resp.json();
        return data.chatId || null;
    } catch (e) {
        return null;
    }
}
