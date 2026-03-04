/* ─── Страница "Задачи" ───────────────────────────────────────────────────── */

let tasksAutoTimer    = null;
let tasksFirstLoad    = true;
let lastTasksData     = [];       // кэш для тихого обновления
let currentFilter     = 'all';    // all | active | done | failed
let currentDebugPlan  = null;     // id плана в открытом модале

// ─── Утилиты ─────────────────────────────────────────────────────────────────

function taskStatusLabel(status) {
    const map = {
        IN_PROGRESS: 'В работе',
        DONE:        'Завершено',
        FAILED:      'Ошибка',
        PAUSED:      'Пауза',
    };
    return map[status] || status;
}

function taskStatusIcon(status) {
    const map = { IN_PROGRESS: '🔄', DONE: '✅', FAILED: '❌', PAUSED: '⏸' };
    return map[status] || '❓';
}

function taskStatusClass(status) {
    const map = { IN_PROGRESS: 'in-progress', DONE: 'done', FAILED: 'failed', PAUSED: 'paused' };
    return map[status] || 'unknown';
}

function formatTaskDate(iso) {
    if (!iso) return '—';
    try {
        return new Date(iso).toLocaleString('ru-RU', {
            day: '2-digit', month: '2-digit', year: 'numeric',
            hour: '2-digit', minute: '2-digit'
        });
    } catch { return iso; }
}

// ─── Парсинг содержимого плана ────────────────────────────────────────────────

function parsePlanContent(content) {
    const lines    = content.split('\n');
    const steps    = [];
    let debugLog   = '';
    let inDebug    = false;
    let inSteps    = false;

    for (const line of lines) {
        if (line.startsWith('## Debug Log')) { inDebug = true; inSteps = false; continue; }
        if (line.startsWith('## Steps'))    { inSteps = true;  inDebug = false; continue; }
        if (line.startsWith('## ') && inSteps) { inSteps = false; }

        if (inDebug) { debugLog += line + '\n'; continue; }

        if (inSteps) {
            const m = line.match(/^(\s*)(\d+(?:\.\d+)*)\.?\s+\[(.)\]\s+(.*)$/);
            if (m) {
                steps.push({
                    prefix:     m[2],
                    statusChar: m[3],
                    text:       m[4],
                    depth:      m[1].length,   // глубина вложенности
                });
            }
        }
    }

    return { steps, debugLog: debugLog.trim() };
}

// ─── Рендер одной карточки ────────────────────────────────────────────────────

function renderTaskCard(plan) {
    const { steps, debugLog } = parsePlanContent(plan.content || '');

    const total     = steps.length;
    const done      = steps.filter(s => s.statusChar === 'x').length;
    const inProg    = steps.filter(s => s.statusChar === '~').length;
    const failed    = steps.filter(s => s.statusChar === '!').length;
    const pct       = total > 0 ? Math.round((done / total) * 100) : 0;

    const sc        = taskStatusClass(plan.status);
    const hasDebug  = debugLog.length > 0;

    // Прогресс-бар цвет
    const barColor  = plan.status === 'FAILED'  ? '#ff6b6b'
                    : plan.status === 'DONE'     ? '#51cf66'
                    : plan.status === 'PAUSED'   ? '#ffd43b'
                    : '#667eea';

    // Текущий активный шаг
    const activeStep = steps.find(s => s.statusChar === '~');
    const activeHint = activeStep
        ? `<div class="task-active-step">▶ ${escapeHtml(activeStep.text)}</div>`
        : '';

    // Краткий список шагов (первые 5 верхнего уровня)
    const topSteps = steps.filter(s => s.depth === 0).slice(0, 5);
    const stepsHtml = topSteps.map(s => {
        const icon = s.statusChar === 'x' ? '✓'
                   : s.statusChar === '~' ? '◉'
                   : s.statusChar === '!' ? '✕'
                   : '○';
        const cls  = s.statusChar === 'x' ? 'tsc-done'
                   : s.statusChar === '~' ? 'tsc-progress'
                   : s.statusChar === '!' ? 'tsc-failed'
                   : 'tsc-pending';
        return `<div class="task-step-row">
            <span class="task-step-icon ${cls}">${icon}</span>
            <span class="task-step-text">${escapeHtml(s.text)}</span>
        </div>`;
    }).join('');

    const moreCount = steps.filter(s => s.depth === 0).length - topSteps.length;
    const moreHtml  = moreCount > 0
        ? `<div class="task-steps-more">+${moreCount} шагов…</div>`
        : '';

    return `
    <div class="task-card-new status-${sc}" id="task-card-${plan.id}">

        <!-- Шапка -->
        <div class="task-card-header">
            <div class="task-card-title-wrap">
                <span class="task-status-badge ${sc}">
                    ${taskStatusIcon(plan.status)} ${taskStatusLabel(plan.status)}
                </span>
                <div class="task-card-goal" title="${escapeHtml(plan.goal)}">${escapeHtml(plan.goal)}</div>
            </div>
            <div class="task-card-meta">
                <span class="task-date">${formatTaskDate(plan.date)}</span>
            </div>
        </div>

        <!-- Прогресс -->
        <div class="task-progress-wrap">
            <div class="task-progress-bg">
                <div class="task-progress-fill" style="width:${pct}%; background:${barColor}"></div>
            </div>
            <span class="task-progress-pct">${pct}%</span>
        </div>

        <!-- Метрики -->
        <div class="task-metrics">
            <div class="task-metric">
                <div class="task-metric-label">Всего</div>
                <div class="task-metric-value">${total}</div>
            </div>
            <div class="task-metric">
                <div class="task-metric-label">Готово</div>
                <div class="task-metric-value" style="color:#2f9e44">${done}</div>
            </div>
            <div class="task-metric">
                <div class="task-metric-label">В работе</div>
                <div class="task-metric-value" style="color:#1971c2">${inProg}</div>
            </div>
            <div class="task-metric">
                <div class="task-metric-label">Ошибок</div>
                <div class="task-metric-value" style="color:${failed > 0 ? '#e03131' : '#868e96'}">${failed}</div>
            </div>
        </div>

        <!-- Активный шаг -->
        ${activeHint}

        <!-- Краткий список шагов -->
        ${total > 0 ? `
        <div class="task-steps-preview">
            ${stepsHtml}
            ${moreHtml}
        </div>` : ''}

        <!-- Кнопки -->
        <div class="task-actions-row">
            <button class="task-btn task-btn-steps" onclick="openTaskSteps('${plan.id}')">
                📋 Все шаги
            </button>
            ${hasDebug ? `
            <button class="task-btn task-btn-log" onclick="openTaskLog('${plan.id}')">
                🪵 Debug Log
            </button>` : `
            <button class="task-btn task-btn-log" disabled title="Лог пуст">
                🪵 Debug Log
            </button>`}
            <button class="task-btn task-btn-delete" onclick="confirmDeleteTask('${plan.id}')" title="Удалить задачу">
                🗑 Удалить
            </button>
        </div>
    </div>`;
}

// ─── Тихое обновление карточки (без перерисовки DOM) ─────────────────────────

function silentUpdateTaskCard(plan) {
    const card = document.getElementById(`task-card-${plan.id}`);
    if (!card) return false;

    const { steps } = parsePlanContent(plan.content || '');
    const total  = steps.length;
    const done   = steps.filter(s => s.statusChar === 'x').length;
    const inProg = steps.filter(s => s.statusChar === '~').length;
    const failed = steps.filter(s => s.statusChar === '!').length;
    const pct    = total > 0 ? Math.round((done / total) * 100) : 0;
    const sc     = taskStatusClass(plan.status);

    // Класс карточки
    card.className = `task-card-new status-${sc}`;

    // Бейдж статуса
    const badge = card.querySelector('.task-status-badge');
    if (badge) {
        badge.className = `task-status-badge ${sc}`;
        badge.textContent = `${taskStatusIcon(plan.status)} ${taskStatusLabel(plan.status)}`;
    }

    // Прогресс-бар
    const fill = card.querySelector('.task-progress-fill');
    const pctEl = card.querySelector('.task-progress-pct');
    const barColor = plan.status === 'FAILED' ? '#ff6b6b'
                   : plan.status === 'DONE'   ? '#51cf66'
                   : plan.status === 'PAUSED' ? '#ffd43b'
                   : '#667eea';
    if (fill)  { fill.style.width = pct + '%'; fill.style.background = barColor; }
    if (pctEl) pctEl.textContent = pct + '%';

    // Метрики
    const vals = card.querySelectorAll('.task-metric-value');
    if (vals.length >= 4) {
        vals[0].textContent = total;
        vals[1].textContent = done;
        vals[2].textContent = inProg;
        vals[3].textContent = failed;
        vals[3].style.color = failed > 0 ? '#e03131' : '#868e96';
    }

    return true;
}

// ─── Загрузка / обновление списка ────────────────────────────────────────────

async function loadPlans(silent = false) {
    const chatId = getChatId();
    if (!chatId) return;

    const grid  = document.getElementById('tasksGrid');
    const badge = document.getElementById('tasksCountBadge');

    if (tasksFirstLoad && !silent) {
        grid.innerHTML = `
            <div class="apps-empty" style="grid-column:1/-1">
                <span class="apps-empty-icon">⏳</span><p>Загрузка…</p>
            </div>`;
    }

    try {
        // Один запрос — получаем всё (список + содержимое каждого плана)
        const res  = await fetch(`${API_URL}/plans/summary`, {
            headers: { 'Authorization': `Bearer ${chatId}` }
        });

        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!data.success) throw new Error(data.error || 'Ошибка загрузки');

        const plans = data.plans || [];

        // Сортировка: IN_PROGRESS → PAUSED → FAILED → DONE, внутри — по дате убыв.
        const order = { IN_PROGRESS: 0, PAUSED: 1, FAILED: 2, DONE: 3 };
        plans.sort((a, b) => {
            const od = (order[a.status] ?? 9) - (order[b.status] ?? 9);
            if (od !== 0) return od;
            return new Date(b.date) - new Date(a.date);
        });

        // Фильтрация
        const filtered = filterPlans(plans);

        // Счётчики в тулбаре
        updateCounters(plans);
        if (badge) badge.textContent = `${plans.length} задач`;

        if (filtered.length === 0) {
            grid.innerHTML = `
                <div class="apps-empty" style="grid-column:1/-1">
                    <span class="apps-empty-icon">📋</span>
                    <p>${plans.length === 0 ? 'Нет задач' : 'Нет задач по выбранному фильтру'}</p>
                    <small>Задачи создаются автоматически, когда ИИ выполняет многошаговые запросы</small>
                </div>`;
            tasksFirstLoad = false;
            lastTasksData  = plans;
            return;
        }

        // Проверяем: изменился ли набор id?
        const newIds  = filtered.map(p => p.id).sort().join(',');
        const prevIds = lastTasksData.filter(p => matchFilter(p)).map(p => p.id).sort().join(',');

        if (!tasksFirstLoad && newIds === prevIds) {
            // Тихое обновление — только данные
            filtered.forEach(p => silentUpdateTaskCard(p));
        } else {
            grid.innerHTML = filtered.map(renderTaskCard).join('');
        }

        lastTasksData  = plans;
        tasksFirstLoad = false;

        // Авто-обновление только если есть активные задачи
        const hasActive = plans.some(p => p.status === 'IN_PROGRESS');
        scheduleAutoUpdate(hasActive);

    } catch (err) {
        if (!silent) {
            grid.innerHTML = `
                <div class="apps-empty" style="grid-column:1/-1">
                    <span class="apps-empty-icon">⚠️</span>
                    <p style="color:#ff6b6b">Ошибка загрузки</p>
                    <small style="color:#aaa">${escapeHtml(err.message)}</small>
                </div>`;
            if (badge) badge.textContent = '— задач';
        }
    }
}

// ─── Фильтрация ───────────────────────────────────────────────────────────────

function matchFilter(plan) {
    if (currentFilter === 'all')    return true;
    if (currentFilter === 'active') return plan.status === 'IN_PROGRESS' || plan.status === 'PAUSED';
    if (currentFilter === 'done')   return plan.status === 'DONE';
    if (currentFilter === 'failed') return plan.status === 'FAILED';
    return true;
}

function filterPlans(plans) {
    return plans.filter(matchFilter);
}

function setFilter(f) {
    currentFilter = f;
    // Обновляем активную кнопку
    document.querySelectorAll('.tasks-filter-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.filter === f);
    });
    // Перерисовываем из кэша (без запроса)
    if (lastTasksData.length > 0) {
        tasksFirstLoad = true;
        renderFromCache();
    }
}

function renderFromCache() {
    const grid = document.getElementById('tasksGrid');
    const order = { IN_PROGRESS: 0, PAUSED: 1, FAILED: 2, DONE: 3 };
    const sorted = [...lastTasksData].sort((a, b) => {
        const od = (order[a.status] ?? 9) - (order[b.status] ?? 9);
        if (od !== 0) return od;
        return new Date(b.date) - new Date(a.date);
    });
    const filtered = filterPlans(sorted);

    if (filtered.length === 0) {
        grid.innerHTML = `
            <div class="apps-empty" style="grid-column:1/-1">
                <span class="apps-empty-icon">📋</span>
                <p>Нет задач по выбранному фильтру</p>
            </div>`;
    } else {
        grid.innerHTML = filtered.map(renderTaskCard).join('');
    }
    tasksFirstLoad = false;
}

function updateCounters(plans) {
    const counts = {
        all:    plans.length,
        active: plans.filter(p => p.status === 'IN_PROGRESS' || p.status === 'PAUSED').length,
        done:   plans.filter(p => p.status === 'DONE').length,
        failed: plans.filter(p => p.status === 'FAILED').length,
    };
    document.querySelectorAll('.tasks-filter-btn').forEach(btn => {
        const f = btn.dataset.filter;
        const countEl = btn.querySelector('.filter-count');
        if (countEl && counts[f] !== undefined) countEl.textContent = counts[f];
    });
}

// ─── Авто-обновление (только когда есть активные задачи) ─────────────────────

function scheduleAutoUpdate(hasActive) {
    if (tasksAutoTimer) { clearTimeout(tasksAutoTimer); tasksAutoTimer = null; }
    if (hasActive) {
        tasksAutoTimer = setTimeout(() => loadPlans(true), 5000);
    }
}

// ─── Модальное окно «Все шаги» ────────────────────────────────────────────────

function openTaskSteps(planId) {
    const plan = lastTasksData.find(p => p.id === planId);
    if (!plan) return;

    const { steps } = parsePlanContent(plan.content || '');

    const stepsHtml = steps.map(s => {
        const icon = s.statusChar === 'x' ? '✓'
                   : s.statusChar === '~' ? '◉'
                   : s.statusChar === '!' ? '✕'
                   : '○';
        const cls  = s.statusChar === 'x' ? 'tsc-done'
                   : s.statusChar === '~' ? 'tsc-progress'
                   : s.statusChar === '!' ? 'tsc-failed'
                   : 'tsc-pending';
        const indent = s.depth * 20;
        return `<div class="task-step-row modal-step" style="padding-left:${indent + 12}px">
            <span class="task-step-icon ${cls}">${icon}</span>
            <span class="task-step-text">${escapeHtml(s.text)}</span>
        </div>`;
    }).join('') || '<div style="color:#aaa;padding:20px;text-align:center">Шаги не найдены</div>';

    _openTaskModal(
        `📋 Шаги задачи`,
        `<div class="task-modal-goal">${escapeHtml(plan.goal)}</div>
         <div class="task-modal-steps">${stepsHtml}</div>`,
        planId
    );
}

// ─── Модальное окно «Debug Log» ───────────────────────────────────────────────

function openTaskLog(planId) {
    const plan = lastTasksData.find(p => p.id === planId);
    if (!plan) return;

    const { debugLog } = parsePlanContent(plan.content || '');
    currentDebugPlan = planId;

    _openTaskModal(
        `🪵 Debug Log`,
        `<div class="task-modal-goal">${escapeHtml(plan.goal)}</div>
         <div class="task-debug-body" id="taskDebugBody">${escapeHtml(debugLog) || '(лог пуст)'}</div>`,
        planId,
        /* showRefresh */ true
    );

    // Скролл вниз
    setTimeout(() => {
        const body = document.getElementById('taskDebugBody');
        if (body) body.scrollTop = body.scrollHeight;
    }, 50);
}

async function refreshTaskLog() {
    if (!currentDebugPlan) return;
    const chatId = getChatId();
    if (!chatId) return;

    const body = document.getElementById('taskDebugBody');
    if (body) body.textContent = 'Обновление…';

    try {
        const res  = await fetch(`${API_URL}/plans/${encodeURIComponent(currentDebugPlan)}`, {
            headers: { 'Authorization': `Bearer ${chatId}` }
        });
        const data = await res.json();
        if (data.success) {
            const { debugLog } = parsePlanContent(data.content || '');
            if (body) {
                body.textContent = debugLog || '(лог пуст)';
                body.scrollTop   = body.scrollHeight;
            }
            // Обновляем кэш
            const idx = lastTasksData.findIndex(p => p.id === currentDebugPlan);
            if (idx !== -1) lastTasksData[idx].content = data.content;
        }
    } catch (err) {
        if (body) body.textContent = `Ошибка: ${err.message}`;
    }
}

// ─── Общий механизм модального окна задач ────────────────────────────────────

function _openTaskModal(title, bodyHtml, planId, showRefresh = false) {
    let overlay = document.getElementById('taskModalOverlay');
    if (overlay) overlay.remove();

    overlay = document.createElement('div');
    overlay.id = 'taskModalOverlay';
    overlay.className = 'task-modal-overlay';
    overlay.innerHTML = `
        <div class="task-modal">
            <div class="task-modal-header">
                <span class="task-modal-title">${title}</span>
                <div class="task-modal-controls">
                    ${showRefresh ? `<button class="task-modal-ctrl-btn" onclick="refreshTaskLog()" title="Обновить">↺</button>` : ''}
                    <button class="task-modal-ctrl-btn task-modal-close" onclick="closeTaskModal()">✕</button>
                </div>
            </div>
            <div class="task-modal-body">${bodyHtml}</div>
        </div>`;

    overlay.addEventListener('click', e => { if (e.target === overlay) closeTaskModal(); });
    document.addEventListener('keydown', _taskModalEsc);
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('visible'));
}

function _taskModalEsc(e) {
    if (e.key === 'Escape') closeTaskModal();
}

function closeTaskModal() {
    const overlay = document.getElementById('taskModalOverlay');
    if (!overlay) return;
    overlay.classList.remove('visible');
    setTimeout(() => { overlay.remove(); currentDebugPlan = null; }, 250);
    document.removeEventListener('keydown', _taskModalEsc);
}

// ─── Удаление задачи ─────────────────────────────────────────────────────────

function confirmDeleteTask(planId) {
    const plan = lastTasksData.find(p => p.id === planId);
    const goalText = plan ? escapeHtml(plan.goal) : planId;

    let overlay = document.getElementById('taskDeleteConfirmOverlay');
    if (overlay) overlay.remove();

    overlay = document.createElement('div');
    overlay.id = 'taskDeleteConfirmOverlay';
    overlay.className = 'task-modal-overlay';
    overlay.innerHTML = `
        <div class="task-modal" style="max-width:460px">
            <div class="task-modal-header" style="background:linear-gradient(135deg,#ff6b6b 0%,#c92a2a 100%)">
                <span class="task-modal-title">🗑 Удалить задачу?</span>
                <button class="task-modal-ctrl-btn task-modal-close" onclick="_closeDeleteConfirm()">✕</button>
            </div>
            <div class="task-modal-body" style="padding:24px 20px">
                <p style="font-size:14px;color:#333;margin-bottom:12px;line-height:1.5">
                    Вы собираетесь удалить задачу:
                </p>
                <div style="background:#fff5f5;border:1px solid #ffc9c9;border-radius:10px;padding:12px 14px;font-size:13px;color:#c92a2a;font-weight:600;margin-bottom:20px;line-height:1.4">
                    ${goalText}
                </div>
                <p style="font-size:13px;color:#868e96;margin-bottom:24px">
                    Файл плана будет удалён безвозвратно. Это действие нельзя отменить.
                </p>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
                    <button class="task-btn" onclick="_closeDeleteConfirm()" style="border-color:#dee2e6;color:#495057">
                        Отмена
                    </button>
                    <button class="task-btn task-btn-delete-confirm" id="taskDeleteConfirmBtn" onclick="deleteTask('${planId}')">
                        🗑 Удалить
                    </button>
                </div>
            </div>
        </div>`;

    overlay.addEventListener('click', e => { if (e.target === overlay) _closeDeleteConfirm(); });
    document.addEventListener('keydown', _deleteConfirmEsc);
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('visible'));
}

function _deleteConfirmEsc(e) {
    if (e.key === 'Escape') _closeDeleteConfirm();
}

function _closeDeleteConfirm() {
    const overlay = document.getElementById('taskDeleteConfirmOverlay');
    if (!overlay) return;
    overlay.classList.remove('visible');
    setTimeout(() => overlay.remove(), 250);
    document.removeEventListener('keydown', _deleteConfirmEsc);
}

async function deleteTask(planId) {
    const chatId = getChatId();
    if (!chatId) return;

    // Блокируем кнопку подтверждения
    const confirmBtn = document.getElementById('taskDeleteConfirmBtn');
    if (confirmBtn) {
        confirmBtn.disabled = true;
        confirmBtn.textContent = 'Удаление…';
    }

    try {
        const res = await fetch(`${API_URL}/plans/${encodeURIComponent(planId)}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${chatId}` }
        });

        const data = await res.json();
        if (!data.success) throw new Error(data.error || 'Ошибка удаления');

        // Закрываем диалог
        _closeDeleteConfirm();

        // Анимируем исчезновение карточки
        const card = document.getElementById(`task-card-${planId}`);
        if (card) {
            card.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
            card.style.opacity    = '0';
            card.style.transform  = 'scale(0.95)';
            setTimeout(() => card.remove(), 300);
        }

        // Убираем из кэша
        lastTasksData = lastTasksData.filter(p => p.id !== planId);

        // Обновляем счётчики
        updateCounters(lastTasksData);
        const badge = document.getElementById('tasksCountBadge');
        if (badge) badge.textContent = `${lastTasksData.length} задач`;

        // Если сетка опустела — показываем заглушку
        setTimeout(() => {
            const grid = document.getElementById('tasksGrid');
            if (grid && grid.querySelectorAll('.task-card-new').length === 0) {
                const filtered = filterPlans(lastTasksData);
                if (filtered.length === 0) {
                    grid.innerHTML = `
                        <div class="apps-empty" style="grid-column:1/-1">
                            <span class="apps-empty-icon">📋</span>
                            <p>${lastTasksData.length === 0 ? 'Нет задач' : 'Нет задач по выбранному фильтру'}</p>
                            <small>Задачи создаются автоматически, когда ИИ выполняет многошаговые запросы</small>
                        </div>`;
                }
            }
        }, 350);

        showToast('Задача удалена', 'success');

    } catch (err) {
        if (confirmBtn) {
            confirmBtn.disabled = false;
            confirmBtn.textContent = '🗑 Удалить';
        }
        showToast(`Ошибка: ${err.message}`, 'error');
    }
}

// ─── Массовое удаление завершенных задач ─────────────────────────────────────

async function cleanupCompletedTasks() {
    const chatId = getChatId();
    if (!chatId) return;

    // Подсчитываем количество завершенных и приостановленных задач
    const completedCount = lastTasksData.filter(p => p.status === 'DONE' || p.status === 'PAUSED').length;
    
    if (completedCount === 0) {
        showToast('Нет завершенных задач для удаления', 'info');
        return;
    }

    // Показываем подтверждение
    let overlay = document.getElementById('taskDeleteConfirmOverlay');
    if (overlay) overlay.remove();

    overlay = document.createElement('div');
    overlay.id = 'taskDeleteConfirmOverlay';
    overlay.className = 'task-modal-overlay';
    overlay.innerHTML = `
        <div class="task-modal" style="max-width:460px">
            <div class="task-modal-header" style="background:linear-gradient(135deg,#ff6b6b 0%,#c92a2a 100%)">
                <span class="task-modal-title">🗑 Очистить завершенные задачи?</span>
                <button class="task-modal-ctrl-btn task-modal-close" onclick="_closeDeleteConfirm()">✕</button>
            </div>
            <div class="task-modal-body" style="padding:24px 20px">
                <p style="font-size:14px;color:#333;margin-bottom:12px;line-height:1.5">
                    Будут удалены все завершенные (✅) и приостановленные (⏸) задачи:
                </p>
                <div style="background:#fff5f5;border:1px solid #ffc9c9;border-radius:10px;padding:12px 14px;font-size:16px;color:#c92a2a;font-weight:600;margin-bottom:20px;text-align:center">
                    ${completedCount} задач
                </div>
                <p style="font-size:13px;color:#868e96;margin-bottom:24px">
                    Файлы планов будут удалены безвозвратно. Это действие нельзя отменить.
                </p>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
                    <button class="task-btn" onclick="_closeDeleteConfirm()" style="border-color:#dee2e6;color:#495057">
                        Отмена
                    </button>
                    <button class="task-btn task-btn-delete-confirm" id="taskCleanupConfirmBtn" onclick="confirmCleanupCompleted()">
                        🗑 Удалить
                    </button>
                </div>
            </div>
        </div>`;

    overlay.addEventListener('click', e => { if (e.target === overlay) _closeDeleteConfirm(); });
    document.addEventListener('keydown', _deleteConfirmEsc);
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('visible'));
}

async function confirmCleanupCompleted() {
    const chatId = getChatId();
    if (!chatId) return;

    const confirmBtn = document.getElementById('taskCleanupConfirmBtn');
    if (confirmBtn) {
        confirmBtn.disabled = true;
        confirmBtn.textContent = 'Удаление…';
    }

    try {
        const res = await fetch(`${API_URL}/plans/completed`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${chatId}` }
        });

        const data = await res.json();
        if (!data.success) throw new Error(data.error || 'Ошибка удаления');

        // Закрываем диалог
        _closeDeleteConfirm();

        // Показываем результат
        showToast(`Удалено ${data.deletedCount} задач`, 'success');

        // Перезагружаем список
        tasksFirstLoad = true;
        await loadPlans();

    } catch (err) {
        if (confirmBtn) {
            confirmBtn.disabled = false;
            confirmBtn.textContent = '🗑 Удалить';
        }
        showToast(`Ошибка: ${err.message}`, 'error');
    }
}

// ─── Инициализация ────────────────────────────────────────────────────────────

async function onLoginSuccess() {
    tasksFirstLoad = true;
    await loadPlans();
}
