let currentPersonFile = null;

const TEMPLATES = {
    'IDENTITY.md': `# Личность AI агента

## Имя
[Ваше имя для AI, например: Алекс, Джарвис, Помощник]

## Роль
[Ваша роль, например: Персональный помощник программиста]

## Специализация
[В чем вы эксперт, например: Python, веб-разработка, анализ данных]

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

## О вас
[Ваше имя, профессия, интересы]

## Цели работы
[Что вы хотите достичь с помощью AI]

## Предпочтения
- Язык кода: [Python, JavaScript, и т.д.]
- Стиль кода: [PEP8, camelCase, и т.д.]
- Комментарии: [Подробные, краткие]

## Текущие проекты
[Над чем вы сейчас работаете]

## Важная информация
[Что AI должен всегда помнить о вас]`,

    'MEMORY.md': `# Важная информация

## API токены
\`\`\`
[Ваши API ключи, если нужно]
\`\`\`

## Пароли и доступы
\`\`\`
[Пароли к базам данных, сервисам]
\`\`\`

## Регламенты
[Правила и процедуры которые должны соблюдаться]

## Частые команды
[Команды которые вы часто используете]

## Важные пути
[Пути к файлам, директориям]`
};

async function onLoginSuccess() {
    await loadPersonalizationStatus();
}

async function loadPersonalizationStatus() {
    const chatId = getChatId();
    if (!chatId) return;
    const files = ['IDENTITY.md', 'SOUL.md', 'USER.md', 'MEMORY.md'];
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
