const FOLDER_LABELS = {
    input: { icon: '📥', title: 'input', desc: 'Входные файлы' },
    output: { icon: '📤', title: 'output', desc: 'Итоговые результаты' },
    work: { icon: '🔧', title: 'work', desc: 'Рабочие файлы' },
    log: { icon: '📋', title: 'log', desc: 'Логи' },
    tmp: { icon: '🗑️', title: 'tmp', desc: 'Временные' }
};

async function onLoginSuccess() {
    await Promise.all([loadFiles(), loadDiskStats()]);
}

function buildFolderTree(paths) {
    const rootFiles = [];
    const folders = {};

    // Инициализируем стандартные папки
    for (const key of Object.keys(FOLDER_LABELS)) {
        folders[key] = { files: [], subfolders: {} };
    }

    for (const item of paths) {
        if (!item.path || item.path === '/workspace') continue;
        const rel = item.path.replace(/^\/workspace\/?/, '');
        if (!rel) continue;
        const parts = rel.split('/');
        
        if (parts.length === 1) {
            if (item.type === 'f') {
                rootFiles.push({ path: item.path, name: parts[0] });
            } else if (item.type === 'd') {
                if (!folders[parts[0]]) {
                    folders[parts[0]] = { files: [], subfolders: {} };
                }
            }
        } else {
            const rootFolder = parts[0];
            if (!folders[rootFolder]) {
                folders[rootFolder] = { files: [], subfolders: {} };
            }
            
            let currentLevel = folders[rootFolder];
            for (let i = 1; i < parts.length - 1; i++) {
                if (!currentLevel.subfolders[parts[i]]) {
                    currentLevel.subfolders[parts[i]] = { files: [], subfolders: {} };
                }
                currentLevel = currentLevel.subfolders[parts[i]];
            }
            
            if (item.type === 'f') {
                currentLevel.files.push({ path: item.path, name: parts[parts.length - 1] });
            } else if (item.type === 'd') {
                if (!currentLevel.subfolders[parts[parts.length - 1]]) {
                    currentLevel.subfolders[parts[parts.length - 1]] = { files: [], subfolders: {} };
                }
            }
        }
    }
    return { rootFiles, folders };
}

function renderTree(node, isPersonFileCheck = false) {
    let html = '';
    
    // Сначала рендерим папки
    for (const [folderName, folderData] of Object.entries(node.subfolders)) {
        html += `
            <div class="tree-folder">
                <div class="tree-folder-header" onclick="this.parentElement.classList.toggle('open')">
                    <span class="folder-icon">▶</span>
                    📁 ${escapeHtml(folderName)}
                </div>
                <div class="tree-folder-content">
                    ${renderTree(folderData, isPersonFileCheck)}
                </div>
            </div>
        `;
    }
    
    // Затем файлы
    for (const file of node.files) {
        const isPersonFile = isPersonFileCheck && ['IDENTITY.md', 'SOUL.md', 'USER.md', 'MEMORY.md'].includes(file.name);
        html += renderFileItem(file.path, file.name, isPersonFile);
    }
    
    return html;
}

function renderFileItem(path, name, isPersonFile) {
    const safePath = escapeHtml(path).replace(/"/g, '&quot;');
    return `
        <div class="file-item" data-filepath="${safePath}">
            <div class="file-info">
                <input type="checkbox" class="file-checkbox" data-filepath="${safePath}" onclick="toggleFileSelection(this)" />
                <span class="file-icon">📄</span>
                <span class="file-name">${escapeHtml(name)}${isPersonFile ? ' 🎭' : ''}</span>
            </div>
            <div class="file-actions">
                <button class="btn btn-primary" onclick="downloadFile(this.closest('.file-item').dataset.filepath)">⬇️</button>
                <button class="btn btn-success" onclick="viewFile(this.closest('.file-item').dataset.filepath)">👁️</button>
                <button class="btn btn-danger" onclick="deleteFile(this.closest('.file-item').dataset.filepath)">🗑️</button>
            </div>
        </div>
    `;
}

function toggleAccordion(element) {
    const accordion = element.closest('.file-accordion');
    if (accordion) accordion.classList.toggle('open');
}

async function loadFiles() {
    const chatId = getChatId();
    if (!chatId) return;
    const fileList = document.getElementById('fileList');
    if (!fileList) return;

    try {
        const response = await fetch(`${API_URL}/files/${chatId}?directory=/workspace`);
        const data = await response.json();

        if (!data.files || data.files.length === 0) {
            fileList.innerHTML = '<div style="text-align: center; padding: 40px; color: #999;">Нет файлов</div>';
            return;
        }

        const { rootFiles, folders } = buildFolderTree(data.files);
        const personFiles = ['IDENTITY.md', 'SOUL.md', 'USER.md', 'MEMORY.md'];
        const emptyFolderHints = {
            output: 'Пусто — сюда сохраняются итоговые файлы (Excel, отчёты). Если задача не выполнена, файлов не будет.'
        };

        let html = `
            <div class="file-accordion">
                <div class="accordion-header" onclick="toggleAccordion(this)">
                    <span class="folder-label">
                        <span class="folder-icon">▶</span>
                        <span>📁 Корень /workspace</span>
                    </span>
                    <span class="badge">${rootFiles.length}</span>
                </div>
                <div class="accordion-content">
                    <div class="accordion-inner">
                        ${rootFiles.length === 0
                            ? '<div class="empty-folder">Нет файлов в корне</div>'
                            : rootFiles.map(f => renderFileItem(f.path, f.name, personFiles.includes(f.name))).join('')}
                    </div>
                </div>
            </div>
        `;

        for (const key of Object.keys(folders).sort()) {
            const label = FOLDER_LABELS[key] || { icon: '📁', title: key, desc: 'Пользовательская папка' };
            const folderData = folders[key];
            const emptyText = emptyFolderHints[key] || 'Пусто';
            
            // Считаем общее количество файлов в папке и подпапках
            let totalFiles = 0;
            const countFiles = (node) => {
                totalFiles += node.files.length;
                for (const sub of Object.values(node.subfolders)) {
                    countFiles(sub);
                }
            };
            countFiles(folderData);

            // Определяем, можно ли удалить папку (не стандартную)
            const isStandardFolder = FOLDER_LABELS[key] !== undefined;
            
            html += `
                <div class="file-accordion" data-folder="${key}">
                    <div class="accordion-header" onclick="toggleAccordion(this)">
                        <span class="folder-label">
                            <span class="folder-icon">▶</span>
                            <span>${label.icon} ${label.title}</span>
                        </span>
                        <div class="header-actions">
                            <span class="badge">${totalFiles}</span>
                            ${totalFiles > 0 ? `<button class="btn-clear-folder" onclick="event.stopPropagation(); clearFolder('${key}')" title="Очистить папку (оставить пустую)">🗑️</button>` : ''}
                            ${!isStandardFolder ? `<button class="btn-remove-folder" onclick="event.stopPropagation(); removeFolder('${key}')" title="Удалить папку целиком">❌</button>` : ''}
                        </div>
                    </div>
                    <div class="accordion-content">
                        <div class="accordion-inner">
                            ${totalFiles === 0
                                ? `<div class="empty-folder">${emptyText}</div>`
                                : renderTree(folderData, false)}
                        </div>
                    </div>
                </div>
            `;
        }
        fileList.innerHTML = html;
    } catch (e) {
        console.error('Error loading files', e);
        fileList.innerHTML = '<div style="text-align: center; padding: 40px; color: #999;">Ошибка загрузки списка файлов</div>';
    }
}

const uploadZone = document.getElementById('uploadZone');
if (uploadZone) {
    uploadZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        uploadZone.style.borderColor = '#667eea';
        uploadZone.style.background = '#f0f0f0';
    });
    uploadZone.addEventListener('dragleave', () => {
        uploadZone.style.borderColor = '#ddd';
        uploadZone.style.background = '';
    });
    uploadZone.addEventListener('drop', (e) => {
        e.preventDefault();
        uploadZone.style.borderColor = '#ddd';
        uploadZone.style.background = '';
        uploadFiles(e.dataTransfer.files);
    });
}

const fileInput = document.getElementById('fileInput');
if (fileInput) {
    fileInput.addEventListener('change', function() {
        if (this.files && this.files.length) uploadFiles(this.files);
    });
}

async function uploadFiles(files) {
    const chatId = getChatId();
    if (!chatId) return;
    for (const file of files) {
        const formData = new FormData();
        formData.append('file', file);
        formData.append('destination', '/workspace/input');
        try {
            const response = await fetch(`${API_URL}/files/${chatId}/upload`, { method: 'POST', body: formData });
            if (response.ok) showToast('✅ ' + file.name + ' загружен', 'success');
            else showToast('❌ Ошибка загрузки ' + file.name, 'error');
        } catch (e) {
            showToast('❌ Ошибка загрузки ' + file.name, 'error');
        }
    }
    loadFiles();
}

function downloadFile(filepath) {
    const chatId = getChatId();
    if (!chatId) return;
    window.open(`${API_URL}/files/${chatId}/download?filepath=${encodeURIComponent(filepath)}`, '_blank');
}

async function viewFile(filepath) {
    const chatId = getChatId();
    if (!chatId) return;
    try {
        // Определяем тип файла по расширению
        const ext = filepath.split('.').pop().toLowerCase();
        const textExtensions = ['md', 'txt', 'json', 'js', 'ts', 'html', 'css', 'xml', 'yaml', 'yml', 'py', 'sh', 'sql', 'csv', 'log', 'ini', 'conf', 'cfg'];
        
        // Для текстовых файлов открываем в новой вкладке с форматированием
        if (textExtensions.includes(ext)) {
            const response = await fetch(`${API_URL}/files/${chatId}/content?filepath=${encodeURIComponent(filepath)}`);
            const content = await response.text();
            const w = window.open('', '_blank');
            w.document.write(`
                <html><head><title>${filepath}</title>
                <style>body { font-family: 'Courier New', monospace; padding: 20px; } pre { white-space: pre-wrap; word-wrap: break-word; }</style></head>
                <body><h2>${filepath}</h2><pre>${content}</pre></body></html>
            `);
            w.document.close();
        } else {
            // Для бинарных файлов (изображения, видео и т.д.) открываем через preview endpoint
            const url = `${API_URL}/files/${chatId}/preview?filepath=${encodeURIComponent(filepath)}`;
            window.open(url, '_blank');
        }
    } catch (e) {
        showToast('Ошибка просмотра файла', 'error');
    }
}

async function deleteFile(filepath) {
    if (!confirm('Удалить ' + filepath + '?')) return;
    const chatId = getChatId();
    if (!chatId) return;
    
    // Находим элемент файла в DOM
    const fileItem = document.querySelector(`.file-item[data-filepath="${filepath}"]`);
    
    try {
        const response = await fetch(`${API_URL}/files/${chatId}`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filepath })
        });
        
        if (response.ok) {
            showToast('Файл удален', 'success');
            
            // Удаляем элемент из DOM без перезагрузки
            if (fileItem) {
                fileItem.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
                fileItem.style.opacity = '0';
                fileItem.style.transform = 'scale(0.95)';
                setTimeout(() => {
                    fileItem.remove();
                    updateFolderBadges();
                }, 300);
            }
        } else {
            const error = await response.json();
            showToast(`Ошибка: ${error.error}`, 'error');
        }
    } catch (e) {
        showToast('Ошибка удаления', 'error');
    }
}

// Обновление счётчиков файлов в папках без перезагрузки
function updateFolderBadges() {
    document.querySelectorAll('.file-accordion').forEach(accordion => {
        const badge = accordion.querySelector('.badge');
        if (!badge) return;
        
        // Считаем файлы в этой папке
        const files = accordion.querySelectorAll('.file-item');
        const count = files.length;
        
        badge.textContent = count;
        
        // Показываем/скрываем кнопку очистки
        const clearBtn = accordion.querySelector('.btn-clear-folder');
        if (clearBtn) {
            clearBtn.style.display = count > 0 ? '' : 'none';
        }
        
        // Если файлов нет, показываем заглушку
        const inner = accordion.querySelector('.accordion-inner');
        if (inner && count === 0) {
            const folderLabel = accordion.querySelector('.folder-label span:last-child');
            const folderName = folderLabel ? folderLabel.textContent.split(' ').pop() : '';
            const emptyText = FOLDER_LABELS[folderName] ? 
                (folderName === 'output' ? 'Пусто — сюда сохраняются итоговые файлы (Excel, отчёты). Если задача не выполнена, файлов не будет.' : 'Пусто') :
                'Пусто';
            
            // Удаляем старые tree-folder если есть
            inner.querySelectorAll('.tree-folder, .file-item').forEach(el => el.remove());
            
            if (!inner.querySelector('.empty-folder')) {
                inner.innerHTML = `<div class="empty-folder">${emptyText}</div>`;
            }
        }
    });
}

async function clearFolder(folderName) {
    const label = FOLDER_LABELS[folderName] || { icon: '📁', title: folderName, desc: 'Пользовательская папка' };
    const confirmMsg = `⚠️ Вы уверены, что хотите очистить папку "${label.title}"?\n\nВсе файлы в папке будут безвозвратно удалены!`;
    
    if (!confirm(confirmMsg)) return;
    
    const chatId = getChatId();
    if (!chatId) return;
    
    // Находим accordion папки
    const accordions = document.querySelectorAll('.file-accordion');
    let targetAccordion = null;
    
    for (const acc of accordions) {
        const folderLabel = acc.querySelector('.folder-label span:last-child');
        if (folderLabel && folderLabel.textContent.includes(label.title)) {
            targetAccordion = acc;
            break;
        }
    }
    
    // Показываем индикатор загрузки
    if (targetAccordion) {
        const inner = targetAccordion.querySelector('.accordion-inner');
        if (inner) {
            inner.innerHTML = '<div style="text-align:center;padding:20px;color:#667eea;">⏳ Очистка...</div>';
        }
    }
    
    try {
        const response = await fetch(`${API_URL}/files/${chatId}/folder`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ folder: folderName })
        });
        
        if (response.ok) {
            showToast(`✅ Папка ${label.title} очищена`, 'success');
            
            // Обновляем UI без перезагрузки
            if (targetAccordion) {
                const inner = targetAccordion.querySelector('.accordion-inner');
                const badge = targetAccordion.querySelector('.badge');
                const clearBtn = targetAccordion.querySelector('.btn-clear-folder');
                
                // Показываем заглушку
                const emptyText = folderName === 'output' 
                    ? 'Пусто — сюда сохраняются итоговые файлы (Excel, отчёты). Если задача не выполнена, файлов не будет.' 
                    : 'Пусто';
                
                if (inner) {
                    inner.innerHTML = `<div class="empty-folder">${emptyText}</div>`;
                }
                
                // Обновляем счётчик
                if (badge) badge.textContent = '0';
                
                // Скрываем кнопку очистки
                if (clearBtn) clearBtn.style.display = 'none';
            }
            
            // Обновляем статистику диска
            loadDiskStats();
        } else {
            const error = await response.json();
            showToast(`❌ Ошибка: ${error.error}`, 'error');
            // Восстанавливаем содержимое
            if (targetAccordion) {
                loadFiles();
            }
        }
    } catch (e) {
        showToast('❌ Ошибка очистки папки', 'error');
        // Восстанавливаем содержимое при ошибке
        if (targetAccordion) {
            loadFiles();
        }
    }
}

async function removeFolder(folderName) {
    const label = FOLDER_LABELS[folderName] || { icon: '📁', title: folderName, desc: 'Пользовательская папка' };
    const confirmMsg = `🚨 ВНИМАНИЕ! Вы хотите УДАЛИТЬ папку "${label.title}" целиком?\n\nПапка и ВСЕ файлы в ней будут безвозвратно удалены!`;
    
    if (!confirm(confirmMsg)) return;
    
    const chatId = getChatId();
    if (!chatId) return;
    
    // Находим accordion папки по data-folder
    const targetAccordion = document.querySelector(`.file-accordion[data-folder="${folderName}"]`);
    
    // Показываем индикатор загрузки
    if (targetAccordion) {
        targetAccordion.style.opacity = '0.5';
    }
    
    try {
        const response = await fetch(`${API_URL}/files/${chatId}/folder/remove`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ folder: folderName })
        });
        
        if (response.ok) {
            showToast(`✅ Папка ${label.title} удалена`, 'success');
            
            // Удаляем элемент из DOM с анимацией
            if (targetAccordion) {
                targetAccordion.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
                targetAccordion.style.opacity = '0';
                targetAccordion.style.transform = 'scale(0.95)';
                setTimeout(() => {
                    targetAccordion.remove();
                }, 300);
            }
            
            // Обновляем статистику диска
            loadDiskStats();
        } else {
            const error = await response.json();
            showToast(`❌ Ошибка: ${error.error}`, 'error');
            // Восстанавливаем видимость
            if (targetAccordion) {
                targetAccordion.style.opacity = '1';
            }
        }
    } catch (e) {
        showToast('❌ Ошибка удаления папки', 'error');
        // Восстанавливаем видимость при ошибке
        if (targetAccordion) {
            targetAccordion.style.opacity = '1';
        }
    }
}

async function loadDiskStats() {
    const chatId = getChatId();
    if (!chatId) return;
    const el = document.getElementById('diskStats');
    if (!el) return;
    
    try {
        const response = await fetch(`${API_URL}/files/${chatId}/stats`);
        const data = await response.json();
        
        const { diskStats, subDirs, topFiles } = data;

        // Итого по workspace контейнера
        let html = `
            <div class="stats-grid">
                <div class="stat-item" style="grid-column: 1 / -1;">
                    <div class="stat-label">📦 Занято в /workspace</div>
                    <div class="stat-value" style="font-size: 1.6em;">${diskStats.used}</div>
                </div>
            </div>
        `;

        // Разбивка по папкам
        if (subDirs && subDirs.length > 0) {
            html += `<h4 style="margin: 15px 0 8px 0; color: #333;">📁 По папкам:</h4>
                <div class="top-files-list">`;
            subDirs.forEach(dir => {
                const name = dir.path.replace('/workspace/', '').replace('/workspace', '/');
                const shortName = name.length > 45 ? '...' + name.slice(-42) : name;
                html += `
                    <div class="top-file-item">
                        <span class="top-file-size">${dir.size}</span>
                        <span class="top-file-path" title="${escapeHtml(dir.path)}">${escapeHtml(shortName)}</span>
                    </div>
                `;
            });
            html += `</div>`;
        }

        // Топ 10 файлов
        if (topFiles && topFiles.length > 0) {
            html += `
                <div class="top-files">
                    <h4 style="margin: 15px 0 10px 0; color: #333;">📂 Топ 10 файлов по размеру:</h4>
                    <div class="top-files-list">
            `;

            topFiles.forEach((file, index) => {
                const shortPath = file.path.length > 50
                    ? '...' + file.path.slice(-47)
                    : file.path;
                html += `
                    <div class="top-file-item">
                        <span class="top-file-rank">${index + 1}.</span>
                        <span class="top-file-size">${file.size}</span>
                        <span class="top-file-path" title="${escapeHtml(file.path)}">${escapeHtml(shortPath)}</span>
                    </div>
                `;
            });

            html += `</div></div>`;
        } else {
            html += `
                <div class="top-files">
                    <h4 style="margin: 15px 0 10px 0; color: #333;">📂 Топ 10 файлов по размеру:</h4>
                    <div style="color: #999; font-size: 13px;">Нет файлов</div>
                </div>
            `;
        }
        
        el.innerHTML = html;
    } catch (e) {
        console.error('Error loading disk stats', e);
        el.innerHTML = '<div style="color: #999; padding: 20px;">Ошибка загрузки статистики</div>';
    }
}
