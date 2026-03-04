/* Консоль Bash - интерактивный терминал */

let commandHistory = [];
let historyIndex = -1;
let isExecuting = false;
let commandCount = 0;
let currentDir = '/workspace'; // Текущая директория по умолчанию
let currentTheme = 'light'; // Тема по умолчанию

// Инициализация после успешного входа
async function onLoginSuccess() {
    initTerminal();
}

// Инициализация терминала
function initTerminal() {
    const input = document.getElementById('terminalInput');
    if (!input) return;
    
    // Загружаем историю из localStorage
    loadCommandHistory();
    
    // Загружаем тему из localStorage
    loadTheme();
    
    // Фокус на input
    input.focus();
    
    // Обработчики событий
    input.addEventListener('keydown', handleKeyDown);
    
    // Клик по терминалу - фокус на input
    const terminal = document.getElementById('terminal');
    if (terminal) {
        terminal.addEventListener('click', () => {
            const selection = window.getSelection();
            if (selection.toString().length === 0) {
                input.focus();
            }
        });
    }
    
    // Обновляем счетчик команд
    updateCommandCount();
    
    // Обновляем prompt
    updatePrompt();
    
    // Получаем реальную текущую директорию с сервера
    fetchCurrentDir();
}

// Загрузка темы из localStorage
function loadTheme() {
    const saved = localStorage.getItem(`console_theme_${getChatId()}`);
    if (saved === 'dark' || saved === 'light') {
        currentTheme = saved;
    } else {
        currentTheme = 'light'; // По умолчанию светлая
    }
    applyTheme();
}

// Применение темы
function applyTheme() {
    const terminal = document.getElementById('terminal');
    const container = document.querySelector('.terminal-container');
    
    if (currentTheme === 'dark') {
        terminal?.classList.add('dark-theme');
        container?.classList.add('dark-theme');
    } else {
        terminal?.classList.remove('dark-theme');
        container?.classList.remove('dark-theme');
    }
    
    // Обновляем кнопку переключения темы
    const themeBtn = document.getElementById('themeToggleBtn');
    if (themeBtn) {
        themeBtn.textContent = currentTheme === 'dark' ? '☀️ Светлая' : '🌙 Тёмная';
    }
}

// Переключение темы
function toggleTheme() {
    currentTheme = currentTheme === 'dark' ? 'light' : 'dark';
    localStorage.setItem(`console_theme_${getChatId()}`, currentTheme);
    applyTheme();
}

// Получение текущей директории с сервера
async function fetchCurrentDir() {
    try {
        const response = await fetch(`${API_URL}/execute`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: getChatId(),
                command: 'pwd',
                timeout: 10
            })
        });
        const result = await response.json();
        if (response.ok && result.stdout) {
            currentDir = result.stdout.trim();
            updatePrompt();
        }
    } catch (e) {
        console.error('Failed to fetch current dir', e);
    }
}

// Обновление prompt
function updatePrompt() {
    const prompt = document.getElementById('terminalPrompt');
    if (prompt) {
        // Сокращаем путь, если он начинается с /workspace
        let displayDir = currentDir;
        if (displayDir === '/workspace') {
            displayDir = '~';
        } else if (displayDir.startsWith('/workspace/')) {
            displayDir = '~/' + displayDir.substring('/workspace/'.length);
        }
        prompt.innerHTML = `<span class="prompt-user">user@container</span>:<span class="prompt-dir">${displayDir}</span>$ `;
    }
}

// Загрузка истории команд из localStorage
function loadCommandHistory() {
    const saved = localStorage.getItem(`console_history_${getChatId()}`);
    if (saved) {
        try {
            commandHistory = JSON.parse(saved);
        } catch (e) {
            commandHistory = [];
        }
    }
}

// Сохранение истории команд
function saveCommandHistory() {
    const maxHistory = 100;
    const toSave = commandHistory.slice(-maxHistory);
    localStorage.setItem(`console_history_${getChatId()}`, JSON.stringify(toSave));
}

// Обработка нажатий клавиш
function handleKeyDown(event) {
    const input = event.target;
    
    // Enter - выполнить команду
    if (event.key === 'Enter') {
        event.preventDefault();
        executeCommand(input.value);
        return;
    }
    
    // Стрелка вверх - предыдущая команда
    if (event.key === 'ArrowUp') {
        event.preventDefault();
        if (historyIndex < commandHistory.length - 1) {
            historyIndex++;
            input.value = commandHistory[commandHistory.length - 1 - historyIndex];
        }
        return;
    }
    
    // Стрелка вниз - следующая команда
    if (event.key === 'ArrowDown') {
        event.preventDefault();
        if (historyIndex > 0) {
            historyIndex--;
            input.value = commandHistory[commandHistory.length - 1 - historyIndex];
        } else if (historyIndex === 0) {
            historyIndex = -1;
            input.value = '';
        }
        return;
    }
    
    // Ctrl+C - прерывание (очистить текущую строку)
    if (event.ctrlKey && event.key === 'c') {
        event.preventDefault();
        appendOutput('^C', 'error');
        input.value = '';
        historyIndex = -1;
        return;
    }
    
    // Ctrl+L - очистить экран
    if (event.ctrlKey && event.key === 'l') {
        event.preventDefault();
        clearConsole();
        return;
    }
    
    // Tab - автодополнение (базовая реализация)
    if (event.key === 'Tab') {
        event.preventDefault();
        handleAutocomplete(input);
        return;
    }
}

// Автодополнение
async function handleAutocomplete(input) {
    const val = input.value;
    if (!val) return;

    // Ищем последнее слово (аргумент)
    const parts = val.split(' ');
    const lastPart = parts[parts.length - 1];
    
    if (!lastPart) return;

    try {
        // Экранируем кавычки для bash
        const safePrefix = lastPart.replace(/"/g, '\\"');
        
        // Используем compgen для автодополнения файлов/папок
        // Если это первое слово, дополняем команды, иначе файлы
        let compCmd = '';
        if (parts.length === 1) {
            compCmd = `compgen -c "${safePrefix}" | head -n 20`;
        } else {
            compCmd = `cd "${currentDir}" && compgen -f "${safePrefix}" | head -n 20`;
        }

        const response = await fetch(`${API_URL}/execute`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: getChatId(),
                command: compCmd,
                timeout: 5
            })
        });
        
        const result = await response.json();
        if (response.ok && result.stdout) {
            const matches = result.stdout.trim().split('\n').filter(m => m);
            
            if (matches.length === 1) {
                // Одно совпадение - дополняем
                parts[parts.length - 1] = matches[0];
                
                // Проверяем, является ли это директорией (чтобы добавить слэш)
                if (parts.length > 1) {
                    const isDirCmd = `cd "${currentDir}" && [ -d "${matches[0]}" ] && echo "DIR"`;
                    const dirRes = await fetch(`${API_URL}/execute`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ chat_id: getChatId(), command: isDirCmd, timeout: 5 })
                    });
                    const dirData = await dirRes.json();
                    if (dirData.stdout && dirData.stdout.trim() === 'DIR') {
                        parts[parts.length - 1] += '/';
                    } else {
                        parts[parts.length - 1] += ' ';
                    }
                } else {
                    parts[parts.length - 1] += ' ';
                }
                
                input.value = parts.join(' ');
            } else if (matches.length > 1) {
                // Несколько совпадений - показываем их
                appendOutput(`$ ${val}`, 'command');
                
                // Форматируем вывод в колонки
                const formatted = matches.join('  ');
                appendOutput(formatted, 'output');
                
                // Находим общий префикс
                let commonPrefix = matches[0];
                for (let i = 1; i < matches.length; i++) {
                    let j = 0;
                    while (j < commonPrefix.length && j < matches[i].length && commonPrefix[j] === matches[i][j]) {
                        j++;
                    }
                    commonPrefix = commonPrefix.substring(0, j);
                }
                
                if (commonPrefix.length > lastPart.length) {
                    parts[parts.length - 1] = commonPrefix;
                    input.value = parts.join(' ');
                }
            }
        }
    } catch (e) {
        console.error('Autocomplete error', e);
    }
}

// Выполнение команды
async function executeCommand(command) {
    if (!command.trim()) {
        appendOutput('', '');
        return;
    }
    
    if (isExecuting) {
        showToast('Дождитесь выполнения предыдущей команды', 'error');
        return;
    }
    
    // Добавляем в историю
    commandHistory.push(command);
    historyIndex = -1;
    saveCommandHistory();
    
    // Показываем введенную команду с текущим prompt
    const promptHtml = document.getElementById('terminalPrompt').innerHTML;
    appendOutputHtml(`${promptHtml} ${escapeHtml(command)}`, 'command-line');
    
    // Блокируем ввод
    isExecuting = true;
    setStatus('executing');
    const input = document.getElementById('terminalInput');
    input.value = '';
    input.disabled = true;
    
    try {
        // Оборачиваем команду для сохранения контекста директории
        // Если команда содержит cd, мы должны обновить currentDir
        let actualCommand = `cd "${currentDir}" && ${command}`;
        
        // Добавляем pwd в конец, чтобы узнать новую директорию, если была команда cd
        if (command.match(/(^|\s|;|&)cd\s/)) {
            actualCommand += ` && pwd`;
        }
        
        const response = await fetch(`${API_URL}/execute`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: getChatId(),
                command: actualCommand,
                timeout: 60
            })
        });
        
        const result = await response.json();
        
        if (response.ok) {
            let stdout = result.stdout || '';
            
            // Если была команда cd, последний вывод - это новый pwd
            if (command.match(/(^|\s|;|&)cd\s/) && result.exitCode === 0) {
                const lines = stdout.trim().split('\n');
                if (lines.length > 0) {
                    const newDir = lines.pop(); // Забираем последнюю строку (pwd)
                    if (newDir.startsWith('/')) {
                        const oldDir = currentDir;
                        currentDir = newDir;
                        updatePrompt();
                        
                        // Показываем сообщение о смене директории
                        if (oldDir !== currentDir) {
                            appendOutput(`Перешёл в: ${currentDir}`, 'info');
                        }
                    }
                    stdout = lines.join('\n'); // Оставляем остальной вывод
                }
            }
            
            // Показываем вывод
            if (stdout) {
                appendOutput(stdout, 'output');
            }
            if (result.stderr) {
                appendOutput(result.stderr, 'error');
            }
            
            // Обновляем счетчик
            commandCount = result.commandNumber || commandCount + 1;
            updateCommandCount();
            
            // Показываем код возврата если не 0
            if (result.exitCode !== 0) {
                appendOutput(`[Exit code: ${result.exitCode}]`, 'error');
            }
        } else {
            appendOutput(`Ошибка: ${result.error || 'Неизвестная ошибка'}`, 'error');
            if (result.details) {
                appendOutput(result.details, 'error');
            }
        }
    } catch (error) {
        appendOutput(`Ошибка соединения: ${error.message}`, 'error');
    } finally {
        // Разблокируем ввод
        isExecuting = false;
        setStatus('ready');
        input.disabled = false;
        input.focus();
    }
}

// Добавление HTML вывода (для prompt)
function appendOutputHtml(html, type = '') {
    const output = document.getElementById('terminalOutput');
    if (!output) return;
    
    const line = document.createElement('div');
    line.className = `terminal-line ${type}`;
    line.innerHTML = html;
    
    output.appendChild(line);
    scrollToBottom();
}

// Добавление вывода в терминал
function appendOutput(text, type = '') {
    const output = document.getElementById('terminalOutput');
    if (!output) return;
    
    const line = document.createElement('div');
    line.className = `terminal-line ${type}`;
    
    // Экранируем HTML и сохраняем форматирование
    const escaped = escapeHtml(text);
    line.innerHTML = escaped
        .replace(/ /g, '&nbsp;')
        .replace(/\n/g, '<br>');
    
    output.appendChild(line);
    
    // Прокрутка вниз
    scrollToBottom();
}

// Прокрутка вниз
function scrollToBottom() {
    const output = document.getElementById('terminalOutput');
    if (output) {
        output.scrollTop = output.scrollHeight;
    }
}

// Установка статуса
function setStatus(status) {
    const indicator = document.getElementById('statusIndicator');
    if (!indicator) return;
    
    indicator.className = 'status-indicator ' + status;
    
    switch (status) {
        case 'ready':
            indicator.textContent = '● Готов';
            break;
        case 'executing':
            indicator.textContent = '● Выполняется...';
            break;
        case 'error':
            indicator.textContent = '● Ошибка';
            break;
    }
}

// Обновление счетчика команд
function updateCommandCount() {
    const counter = document.getElementById('commandCount');
    if (counter) {
        counter.textContent = `Команд выполнено: ${commandCount}`;
    }
}

// Очистка консоли
function clearConsole() {
    const output = document.getElementById('terminalOutput');
    if (output) {
        output.innerHTML = `
            <div class="welcome-message">
                <div style="color: #868e96;">
                    ═══════════════════════════════════════════════════════════
                    Консоль очищена. Введите команду для продолжения.
                    ═══════════════════════════════════════════════════════════
                </div>
            </div>
        `;
    }
    showToast('Консоль очищена', 'success');
}

// Скачать историю
function downloadHistory() {
    const output = document.getElementById('terminalOutput');
    if (!output) return;
    
    // Собираем текст из терминала
    const lines = [];
    output.querySelectorAll('.terminal-line').forEach(line => {
        lines.push(line.textContent);
    });
    
    const text = lines.join('\n');
    
    // Создаем и скачиваем файл
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `console_history_${getChatId()}_${Date.now()}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    
    showToast('История скачана', 'success');
}
