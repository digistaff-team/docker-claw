let currentPersonFile = null;
let currentUserEmail = null;

async function mysqlQuery(sql, params = []) {
    const response = await fetch(`${window.location.origin}/api/manage/mysql/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql, params })
    });
    if (!response.ok) {
        const error = await response.text();
        throw new Error(`MySQL API error: ${response.status} - ${error}`);
    }
    const result = await response.json();
    if (result.error) throw new Error(result.error);
    return result;
}

const TEMPLATES = {
    'IDENTITY.md': `# Персона AI агента

## Имя
[Выберите имя для AI, например: Алекс, Джарвис, Помощник]

## Роль
[Например: Персональный помощник, Копирайтер]

## Специализация
[В чем эксперт, например: Python, веб-разработка, анализ данных]

## Язык общения
[Русский, English, или оба]`,

    'SOUL.md': `# Характер и душа AI агента

## Стиль общения
[Формальный, дружелюбный, профессиональный, с юмором]

## Личностные черты
- [Например: Внимательный к деталям]
- [Например: Терпеливый]
- [Например: Креативный]

## Принципы работы
- [Например: Всегда объясняю что делаю]
- [Например: Проверяю результаты]
- [Например: Предлагаю несколько решений]

## Что я ценю
[Например: Чистый код, эффективность, обучение]`,

    'USER.md': `# Информация о пользователе

## Аватар пользователя
[Возраст, профессия, интересы]

## Цели, проблемы пользователя
[Чего он хочет достичь, и что ему в этом мешает]

## Предпочтения
- Язык общения: [Русский, English или другой]
- Стиль общения: [Деловой, дружеский, профессиональный или другой]
- Комментарии: [Подробные, краткие, без комментариев]

## Важная информация
[Что AI должен всегда помнить]`
};

async function onLoginSuccess() {
    await loadPersonalizationStatus();
    await loadSystemContext();
}

async function loadPersonalizationStatus() {
    const chatId = getChatId();
    if (!chatId) return;
    const files = ['IDENTITY.md', 'SOUL.md', 'USER.md'];
    for (const file of files) {
        try {
            const response = await fetch(
                `${API_URL}/files/${chatId}/content?filepath=/workspace/${file}`
            );
            const card = document.getElementById(`card-${file}`);
            const status = document.getElementById(`status-${file}`);
            if (!status) continue;
            if (response.ok) {
                const content = await response.text();
                if (content.trim()) {
                    status.textContent = 'Заполнено';
                    status.className = 'status filled';
                } else {
                    status.textContent = 'Не заполнено';
                    status.className = 'status empty';
                }
            } else {
                status.textContent = 'Не заполнено';
                status.className = 'status empty';
            }
        } catch (e) {
            console.error('Error loading ' + file, e);
        }
    }
}

async function selectPersonFile(filename) {
    currentPersonFile = filename;
    const chatId = getChatId();
    if (!chatId) return;

    document.querySelectorAll('.person-card').forEach(c => c.classList.remove('active'));
    const card = document.getElementById('card-' + filename);
    if (card) card.classList.add('active');

    document.getElementById('editorContainer').style.display = 'block';
    document.getElementById('editorTitle').textContent = filename;

    try {
        const response = await fetch(
            `${API_URL}/files/${chatId}/content?filepath=/workspace/${filename}`
        );
        const editor = document.getElementById('personEditor');
        if (response.ok) {
            const content = await response.text();
            editor.value = content || TEMPLATES[filename];
        } else {
            editor.value = TEMPLATES[filename];
        }
    } catch (e) {
        document.getElementById('personEditor').value = TEMPLATES[filename];
    }

    const hints = {
        'IDENTITY.md': 'Опишите имя, роль и специализацию вашего AI агента',
        'SOUL.md': 'Определите характер, стиль общения и принципы работы',
        'USER.md': 'Расскажите о себе, ваших целях и предпочтениях',
        'MEMORY.md': 'Сохраните важные токены, пароли и регламенты'
    };
    const helpEl = document.getElementById('templateHelp');
    if (helpEl) helpEl.textContent = '💡 ' + (hints[filename] || '');
}

async function savePersonFile() {
    if (!currentPersonFile) return;
    const chatId = getChatId();
    if (!chatId) return;

    const content = document.getElementById('personEditor').value;
    const blob = new Blob([content], { type: 'text/plain' });
    const formData = new FormData();
    formData.append('file', blob, currentPersonFile);
    formData.append('destination', '/workspace');

    try {
        const response = await fetch(`${API_URL}/files/${chatId}/upload`, {
            method: 'POST',
            body: formData
        });
        if (response.ok) {
            showToast(currentPersonFile + ' сохранен', 'success');
            await loadPersonalizationStatus();
        } else {
            const err = await response.json().catch(() => ({}));
            showToast(err.error || 'Ошибка сохранения', 'error');
        }
    } catch (e) {
        showToast('Ошибка сохранения', 'error');
    }
}

function closeEditor() {
    document.getElementById('editorContainer').style.display = 'none';
    document.querySelectorAll('.person-card').forEach(c => c.classList.remove('active'));
    currentPersonFile = null;
}

// === Системный контекст ===

async function loadSystemContext() {
    const chatId = getChatId();
    if (!chatId) return;
    try {
        const res = await fetch(`${window.location.origin}/api/manage/ai/status?chat_id=${encodeURIComponent(chatId)}`);
        const data = await res.json();
        currentUserEmail = data.aiUserEmail || null;
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
    if (skillsListEl) skillsListEl.innerHTML = '<span style="color: #999; font-size: 13px;">Загрузка...</span>';

    try {
        let selectedSkills = [];
        const chatId = getChatId();
        if (chatId) {
            try {
                const r = await fetch(`/api/manage/ai/active-skills?chat_id=${encodeURIComponent(chatId)}`);
                if (r.ok) {
                    const data = await r.json();
                    selectedSkills = data.skills || [];
                }
            } catch (e) {
                console.warn('active-skills fetch error:', e);
            }
        }

        let personaFiles = {};
        for (const fname of ['IDENTITY.md', 'SOUL.md', 'USER.md', 'MEMORY.md']) {
            try {
                const r = await fetch(`/api/files/${encodeURIComponent(chatId)}/content?filepath=${encodeURIComponent('/workspace/' + fname)}`);
                if (r.ok) {
                    const content = await r.text();
                    if (content && content.trim()) personaFiles[fname] = content.trim();
                }
            } catch (e) { /* файл отсутствует */ }
        }

        let systemPrompt = '=== БАЗОВАЯ РОЛЬ ===\n';
        systemPrompt += 'Ты - AI-ассистент для bash-команд в изолированном Docker-контейнере. ';
        systemPrompt += 'Ты помогаешь пользователю выполнять команды, анализировать результаты и решать задачи. ';
        systemPrompt += 'Всегда объясняй свои действия и результаты.\n\n';

        if (personaFiles['IDENTITY.md'] || personaFiles['SOUL.md'] || personaFiles['USER.md'] || personaFiles['MEMORY.md']) {
            systemPrompt += '=== ПЕРСОНАЛИЗАЦИЯ ===\n';
            for (const fname of ['IDENTITY.md', 'SOUL.md', 'USER.md', 'MEMORY.md']) {
                if (personaFiles[fname]) systemPrompt += `--- ${fname} ---\n${personaFiles[fname]}\n\n`;
            }
        }

        if (selectedSkills.length > 0) {
            systemPrompt += '=== АКТИВНЫЕ НАВЫКИ ===\nТы имеешь следующие активные навыки:\n\n';
            selectedSkills.forEach((skill, idx) => {
                systemPrompt += `--- НАВЫК ${idx + 1}: ${skill.name} ---\n${skill.system_prompt}\n\n`;
            });
        }

        systemPrompt += '=== ИНСТРУКЦИИ ПО ВЫПОЛНЕНИЮ ===\n';
        systemPrompt += '1. Анализируй запрос пользователя\n';
        systemPrompt += '2. Если нужно выполнить команду - выполняй её через bash\n';
        systemPrompt += '3. Объясняй результаты и предлагай улучшения\n';
        systemPrompt += '4. Если запрос неясен - уточняй\n';
        systemPrompt += '5. Используй свои навыки для решения специфических задач\n';

        outputEl.value = systemPrompt;

        if (skillsListEl) {
            skillsListEl.innerHTML = selectedSkills.length > 0
                ? selectedSkills.map(s => `<span class="skill-tag" style="background: #d0ebff; color: #1971c2;">${s.name}</span>`).join('')
                : '<span style="color: #999; font-size: 13px;">Нет выбранных навыков</span>';
        }
    } catch (e) {
        console.error('refreshSystemContext error:', e);
        outputEl.value = 'Ошибка загрузки системного контекста: ' + e.message;
        if (skillsListEl) skillsListEl.innerHTML = '<span style="color: #ff6b6b; font-size: 13px;">Ошибка загрузки навыков</span>';
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
    }).catch(() => {
        showToast('Ошибка копирования', 'error');
    });
}
