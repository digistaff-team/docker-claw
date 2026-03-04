// Конфигурация MySQL API
const MYSQL_API_URL = 'https://ai.memory.api.atiks.org/mysql_full_proxy_api';
const MYSQL_API_KEY = 'mysql-VTJGc2RHVmtYMS9PQ09iSlgycDZrRWVWVWt5bWR1azQ4bkVqK0JkeXlvSjhpMGg0UW1YSUFlbjRycmM3ZWIzZmkxOVZ1bDNQZ2NITVVtZE9iWGp2R0FiSFRUKzU3YjJEdzMvKzRoR0VaM0htNWtsM2pCOU5rK29VcElGZHRFaXpaa0N5UGVmN2hwdk9aeWdZMkIrcnNCVnRpdWFyaDV1RXVFSFpTK2JJM0hZeHBwZ2dEUGgrQ0pJV3Biem9RdHBGQlhOZ0hkbXhkZDRHSCtXUkpUTnQxYjI5T3VuQklVbUJPdE91Z1VYdm02K2lsL3lHSUpacCtSOWlzQ0xBcktLUQ==';

let allSkills = [];
let userSelectedSkills = new Set();
let currentUserEmail = null;

// === MySQL API Helpers ===
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

// === Инициализация ===
async function onLoginSuccess() {
    // Получаем email пользователя из настроек AI
    await loadUserEmail();
    await loadSkills();
    // Важно: перерисовать после загрузки выбранных навыков
    await loadUserSelectedSkills();
    renderSkills(); // Перерисовываем с учётом выбранных навыков
}

async function loadUserEmail() {
    const chatId = getChatId();
    if (!chatId) return;
    
    try {
        const res = await fetch(`/api/manage/ai/status?chat_id=${encodeURIComponent(chatId)}`);
        const data = await res.json();
        currentUserEmail = data.aiUserEmail || null;
    } catch (e) {
        console.error('loadUserEmail error:', e);
    }
}

// === Работа с навыками ===
async function loadSkills() {
    try {
        // Загружаем все публичные и личные навыки
        const result = await mysqlQuery(
            `SELECT * FROM ai_skills WHERE is_active = 1 ORDER BY usage_count DESC, name ASC`
        );
        
        allSkills = result.data || [];
        renderSkills();
    } catch (e) {
        console.error('loadSkills error:', e);
        document.getElementById('skillsGrid').innerHTML = `
            <div style="text-align: center; padding: 40px; color: #ff6b6b;">
                Ошибка загрузки навыков: ${e.message}
            </div>
        `;
    }
}

async function loadUserSelectedSkills() {
    if (!currentUserEmail) return;
    
    try {
        // Проверяем существование таблицы
        await mysqlQuery(`
            CREATE TABLE IF NOT EXISTS user_selected_skills (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_email VARCHAR(255) NOT NULL,
                skill_id INT UNSIGNED NOT NULL,
                selected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY uk_user_skill (user_email, skill_id),
                FOREIGN KEY (skill_id) REFERENCES ai_skills(id) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);
        
        // Загружаем выбранные навыки
        const result = await mysqlQuery(
            `SELECT skill_id FROM user_selected_skills WHERE user_email = %s`,
            [currentUserEmail]
        );
        
        userSelectedSkills = new Set((result.data || []).map(row => row.skill_id));
        updateSelectedCount();
    } catch (e) {
        console.error('loadUserSelectedSkills error:', e);
    }
}

function renderSkills() {
    const grid = document.getElementById('skillsGrid');
    const filterCategory = document.getElementById('filterCategory').value;
    const searchText = document.getElementById('searchSkills').value.toLowerCase();
    const showOnlySelected = document.getElementById('showOnlySelected').checked;
    
    let filtered = allSkills;
    
    // Фильтр по категории
    if (filterCategory) {
        filtered = filtered.filter(s => s.category_slug === filterCategory);
    }
    
    // Фильтр по поиску
    if (searchText) {
        filtered = filtered.filter(s => 
            s.name.toLowerCase().includes(searchText) ||
            (s.short_desc && s.short_desc.toLowerCase().includes(searchText)) ||
            (s.tags && s.tags.toLowerCase().includes(searchText))
        );
    }
    
    // Фильтр по выбранным
    if (showOnlySelected) {
        filtered = filtered.filter(s => userSelectedSkills.has(s.id));
    }
    
    if (filtered.length === 0) {
        grid.innerHTML = `
            <div style="text-align: center; padding: 40px; color: #666;">
                Навыки не найдены. Попробуйте изменить фильтры или добавьте свой навык.
            </div>
        `;
        return;
    }
    
    // Разделяем на свои и чужие навыки
    const mySkills = filtered.filter(s => currentUserEmail && s.user_email === currentUserEmail);
    const otherSkills = filtered.filter(s => !currentUserEmail || s.user_email !== currentUserEmail);
    
    // Сортируем по usage_count (DESC)
    mySkills.sort((a, b) => (b.usage_count || 0) - (a.usage_count || 0));
    otherSkills.sort((a, b) => (b.usage_count || 0) - (a.usage_count || 0));
    
    let html = '';
    
    // Свои навыки (если есть)
    if (mySkills.length > 0) {
        html += `
            <div class="skills-category" style="margin-bottom: 30px;">
                <h3 class="category-title" style="color: #7c3aed; border-bottom-color: #7c3aed;">
                    👤 Мои навыки (${mySkills.length})
                </h3>
                <div class="skills-grid-inner">
        `;
        
        mySkills.forEach(skill => {
            html += renderSkillCard(skill, true);
        });
        
        html += `
                </div>
            </div>
        `;
    }
    
    // Остальные навыки
    if (otherSkills.length > 0) {
        // Группируем по категориям
        const grouped = {};
        otherSkills.forEach(skill => {
            const cat = skill.category_name || 'Без категории';
            if (!grouped[cat]) grouped[cat] = [];
            grouped[cat].push(skill);
        });
        
        for (const [category, skills] of Object.entries(grouped)) {
            html += `
                <div class="skills-category">
                    <h3 class="category-title">${getCategoryIcon(category)}${category}</h3>
                    <div class="skills-grid-inner">
            `;
            
            skills.forEach(skill => {
                html += renderSkillCard(skill, false);
            });
            
            html += `
                    </div>
                </div>
            `;
        }
    }
    
    grid.innerHTML = html;
}

function renderSkillCard(skill, isOwner) {
    const isSelected = userSelectedSkills.has(skill.id);
    
    return `
        <div class="skill-card ${isSelected ? 'selected' : ''}" data-skill-id="${skill.id}">
            <div class="skill-header">
                <label class="skill-checkbox-wrapper">
                    <input type="checkbox" class="skill-select-checkbox" 
                        ${isSelected ? 'checked' : ''} 
                        onchange="toggleSkillSelection(${skill.id})" />
                </label>
                <h4 class="skill-name">${escapeHtml(skill.name)}</h4>
            </div>
            <p class="skill-desc">${escapeHtml(skill.short_desc || 'Нет описания')}</p>
            
            <div class="skill-meta">
                <div class="skill-meta-item">
                    <span class="skill-meta-label">Категория:</span>
                    <span class="skill-meta-value">${escapeHtml(skill.category_name)}</span>
                </div>
                <div class="skill-meta-item">
                    <span class="skill-meta-label">Slug:</span>
                    <code class="skill-meta-value">${escapeHtml(skill.slug)}</code>
                </div>
                <div class="skill-meta-item">
                    <span class="skill-meta-label">Версия:</span>
                    <span class="skill-meta-value">${escapeHtml(skill.version || '1.0.0')}</span>
                </div>
                <div class="skill-meta-item">
                    <span class="skill-meta-label">Использований:</span>
                    <span class="skill-meta-value" style="color: #667eea; font-weight: 600;">${skill.usage_count || 0}</span>
                </div>
                ${skill.user_email ? `
                <div class="skill-meta-item">
                    <span class="skill-meta-label">Автор:</span>
                    <span class="skill-meta-value">${escapeHtml(skill.user_email)}</span>
                </div>
                ` : ''}
            </div>
            
            <div class="skill-tags">
                ${(skill.tags || '').split(',').filter(t => t.trim()).map(tag => 
                    `<span class="skill-tag">${escapeHtml(tag.trim())}</span>`
                ).join('')}
            </div>
            
            ${skill.system_prompt ? `
            <div class="skill-prompt-preview">
                <strong>Системный промпт:</strong>
                <p>${escapeHtml(skill.system_prompt.substring(0, 150))}${skill.system_prompt.length > 150 ? '...' : ''}</p>
            </div>
            ` : ''}
            
            <div class="skill-footer">
                <span class="skill-visibility ${skill.is_public ? 'public' : 'private'}">
                    ${skill.is_public ? '🌐 Публичный' : '🔒 Личный'}
                </span>
                ${isOwner ? '<span class="skill-owner">👤 Ваш</span>' : ''}
                <div class="skill-actions">
                    <button class="btn-view" onclick="viewSkill(${skill.id})" title="Просмотр">👁️</button>
                    ${isOwner ? `
                        <button class="btn-edit" onclick="editSkill(${skill.id})" title="Редактировать">✏️</button>
                        <button class="btn-delete" onclick="deleteSkill(${skill.id})" title="Удалить">🗑️</button>
                    ` : ''}
                </div>
            </div>
        </div>
    `;
}

function getCategoryIcon(category) {
    const icons = {
        'Программирование': '💻 ',
        'Копирайтинг и маркетинг': '✍️ ',
        'Работа с данными': '📊 ',
        'Личная продуктивность': '⚡ ',
        'Креатив и идеи': '🎨 ',
        'Языки и перевод': '🌍 ',
        'Обучение и мышление': '🧠 ',
        'Другое': '📌 '
    };
    return icons[category] || '📌 ';
}

function updateSelectedCount() {
    const count = userSelectedSkills.size;
    const info = document.getElementById('selectedSkillsInfo');
    const countEl = document.getElementById('selectedCount');
    
    if (info) {
        info.style.display = count > 0 ? 'block' : 'none';
    }
    if (countEl) {
        countEl.textContent = count;
    }
}

// === Выбор навыков ===
async function toggleSkillSelection(skillId) {
    if (!currentUserEmail) {
        showToast('Сначала настройте email в разделе ИИ', 'error');
        await loadSkills(); // Перерисовать
        return;
    }
    
    try {
        if (userSelectedSkills.has(skillId)) {
            // Удаляем выбор
            await mysqlQuery(
                `DELETE FROM user_selected_skills WHERE user_email = %s AND skill_id = %s`,
                [currentUserEmail, skillId]
            );
            userSelectedSkills.delete(skillId);
            showToast('Навык убран из выбранных', 'success');
        } else {
            // Добавляем выбор
            await mysqlQuery(
                `INSERT INTO user_selected_skills (user_email, skill_id) VALUES (%s, %s)`,
                [currentUserEmail, skillId]
            );
            userSelectedSkills.add(skillId);
            showToast('Навык добавлен в контекст AI', 'success');
        }
        
        updateSelectedCount();
        renderSkills();
    } catch (e) {
        console.error('toggleSkillSelection error:', e);
        showToast('Ошибка сохранения: ' + e.message, 'error');
        await loadSkills();
    }
}

// === Просмотр навыка ===
let currentViewingSkill = null;

function viewSkill(skillId) {
    const skill = allSkills.find(s => s.id === skillId);
    if (!skill) return;
    
    currentViewingSkill = skill;
    
    document.getElementById('viewSkillTitle').textContent = skill.name;
    document.getElementById('viewSkillCategory').textContent = skill.category_name;
    document.getElementById('viewSkillDesc').textContent = skill.short_desc || 'Нет описания';
    
    // Теги
    const tagsEl = document.getElementById('viewSkillTags');
    if (skill.tags) {
        tagsEl.innerHTML = skill.tags.split(',').filter(t => t.trim()).map(tag => 
            `<span class="skill-tag">${escapeHtml(tag.trim())}</span>`
        ).join(' ');
    } else {
        tagsEl.innerHTML = '<span style="color: #999;">Нет тегов</span>';
    }
    
    // Системный промпт
    document.getElementById('viewSkillPrompt').textContent = skill.system_prompt || 'Нет промпта';
    
    // Примеры
    const examplesEl = document.getElementById('viewSkillExamples');
    const examplesTextEl = document.getElementById('viewSkillExamplesText');
    if (skill.examples_text) {
        examplesEl.style.display = 'block';
        examplesTextEl.textContent = skill.examples_text;
    } else {
        examplesEl.style.display = 'none';
    }
    
    // Кнопка редактирования
    const isOwner = currentUserEmail && skill.user_email === currentUserEmail;
    const editBtn = document.getElementById('editFromViewBtn');
    editBtn.style.display = isOwner ? 'inline-block' : 'none';
    editBtn.onclick = () => {
        closeViewModal();
        editSkill(skillId);
    };
    
    document.getElementById('viewSkillModal').style.display = 'block';
}

function closeViewModal() {
    document.getElementById('viewSkillModal').style.display = 'none';
    currentViewingSkill = null;
}

// === Добавление/редактирование навыка ===
function openAddSkillModal() {
    if (!currentUserEmail) {
        showToast('Сначала настройте email в разделе ИИ', 'error');
        return;
    }
    
    document.getElementById('skillForm').reset();
    document.getElementById('skillId').value = '';
    document.getElementById('modalTitle').textContent = '➕ Добавить навык';
    document.getElementById('skillModal').style.display = 'block';
}

function editSkill(skillId) {
    const skill = allSkills.find(s => s.id === skillId);
    if (!skill) return;
    
    // Проверяем права
    if (currentUserEmail !== skill.user_email) {
        showToast('Вы можете редактировать только свои навыки', 'error');
        return;
    }
    
    document.getElementById('skillId').value = skill.id;
    document.getElementById('skillName').value = skill.name;
    document.getElementById('skillSlug').value = skill.slug;
    document.getElementById('skillCategory').value = skill.category_slug;
    document.getElementById('skillShortDesc').value = skill.short_desc || '';
    document.getElementById('skillSystemPrompt').value = skill.system_prompt || '';
    document.getElementById('skillExamples').value = skill.examples_text || '';
    document.getElementById('skillTags').value = skill.tags || '';
    document.getElementById('skillMetadata').value = skill.metadata_text || '';
    document.getElementById('skillIsPublic').checked = skill.is_public === 1;
    
    document.getElementById('modalTitle').textContent = '✏️ Редактировать навык';
    document.getElementById('skillModal').style.display = 'block';
}

function closeSkillModal() {
    document.getElementById('skillModal').style.display = 'none';
    document.getElementById('skillForm').reset();
}

async function saveSkill(event) {
    event.preventDefault();
    
    if (!currentUserEmail) {
        showToast('Сначала настройте email в разделе ИИ', 'error');
        return;
    }
    
    const skillId = document.getElementById('skillId').value;
    const name = document.getElementById('skillName').value.trim();
    const slug = document.getElementById('skillSlug').value.trim().toLowerCase();
    const categorySlug = document.getElementById('skillCategory').value;
    const categoryName = document.getElementById('skillCategory').options[document.getElementById('skillCategory').selectedIndex].text;
    const shortDesc = document.getElementById('skillShortDesc').value.trim();
    const systemPrompt = document.getElementById('skillSystemPrompt').value.trim();
    const examplesText = document.getElementById('skillExamples').value.trim();
    const tags = document.getElementById('skillTags').value.trim();
    const metadataText = document.getElementById('skillMetadata').value.trim();
    const isPublic = document.getElementById('skillIsPublic').checked ? 1 : 0;
    
    try {
        if (skillId) {
            // Обновление
            await mysqlQuery(`
                UPDATE ai_skills SET 
                    name = %s, slug = %s, category_slug = %s, category_name = %s,
                    short_desc = %s, system_prompt = %s, examples_text = %s,
                    tags = %s, metadata_text = %s, is_public = %s
                WHERE id = %s AND user_email = %s
            `, [name, slug, categorySlug, categoryName, shortDesc, systemPrompt, 
                examplesText, tags, metadataText, isPublic, skillId, currentUserEmail]);
            
            showToast('Навык обновлён', 'success');
        } else {
            // Создание
            const result = await mysqlQuery(`
                INSERT INTO ai_skills (
                    user_email, name, slug, category_slug, category_name,
                    short_desc, system_prompt, examples_text, tags, metadata_text, is_public
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            `, [currentUserEmail, name, slug, categorySlug, categoryName, 
                shortDesc, systemPrompt, examplesText, tags, metadataText, isPublic]);
            
            showToast('Навык создан (ID: ' + result.insert_id + ')', 'success');
        }
        
        closeSkillModal();
        await loadSkills();
    } catch (e) {
        console.error('saveSkill error:', e);
        showToast('Ошибка сохранения: ' + e.message, 'error');
    }
}

// === Фильтрация ===
function filterSkills() {
    renderSkills();
}

// === Удаление навыка ===
async function deleteSkill(skillId) {
    const skill = allSkills.find(s => s.id === skillId);
    if (!skill) return;
    
    // Подтверждение удаления
    if (!confirm(`Вы уверены, что хотите удалить навык "${skill.name}"?\n\nЭто действие нельзя отменить.`)) {
        return;
    }
    
    try {
        await mysqlQuery(
            `DELETE FROM ai_skills WHERE id = %s AND user_email = %s`,
            [skillId, currentUserEmail]
        );
        
        showToast('Навык удалён', 'success');
        
        // Убираем из выбранных, если был
        if (userSelectedSkills.has(skillId)) {
            await mysqlQuery(
                `DELETE FROM user_selected_skills WHERE user_email = %s AND skill_id = %s`,
                [currentUserEmail, skillId]
            );
            userSelectedSkills.delete(skillId);
            updateSelectedCount();
        }
        
        // Перезагружаем список
        await loadSkills();
    } catch (e) {
        console.error('deleteSkill error:', e);
        showToast('Ошибка удаления: ' + e.message, 'error');
    }
}

// === Закрытие модальных окон при клике вне ===
window.onclick = function(event) {
    const skillModal = document.getElementById('skillModal');
    const viewModal = document.getElementById('viewSkillModal');
    
    if (event.target === skillModal) {
        closeSkillModal();
    }
    if (event.target === viewModal) {
        closeViewModal();
    }
}

// === Экранирование HTML ===
function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}
