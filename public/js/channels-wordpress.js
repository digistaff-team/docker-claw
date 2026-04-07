// WordPress channel — UI handlers
// Использует общие константы API_CONTENT и getChatId() из channels.js / common.js

(function () {
  const API = `${window.location.origin}/api/content`;

  function $(id) { return document.getElementById(id); }
  function setStatus(html, color) {
    const el = $('wordpressSettingsStatus');
    if (el) el.innerHTML = `<span style="color:${color || '#666'}">${html}</span>`;
  }
  function setConnStatus(html, color) {
    const el = $('wordpressStatus');
    if (el) el.innerHTML = `<span style="color:${color || '#666'}">${html}</span>`;
  }
  function chat() {
    return (typeof getChatId === 'function') ? getChatId() : localStorage.getItem('chatId');
  }
  async function jfetch(url, opts) {
    const res = await fetch(url, opts);
    let data = null;
    try { data = await res.json(); } catch (e) {}
    if (!res.ok) throw new Error((data && (data.error || data.message)) || `HTTP ${res.status}`);
    return data || {};
  }

  // ===== Connect / Disconnect =====
  window.saveWordpressConnect = async function () {
    const chatId = chat();
    if (!chatId) return setConnStatus('Сначала войдите', '#c00');
    const baseUrl = $('wordpressBaseUrl').value.trim();
    const username = $('wordpressUsername').value.trim();
    const appPassword = $('wordpressAppPassword').value.trim();
    if (!baseUrl || !username || !appPassword) return setConnStatus('Заполните все поля', '#c00');
    setConnStatus('Подключение...', '#666');
    try {
      const r = await jfetch(`${API}/wordpress/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId, baseUrl, username, appPassword })
      });
      setConnStatus(`✅ Подключено: ${r.siteName || baseUrl}`, '#0a0');
      $('wordpressSettingsBlock').style.display = 'block';
      $('disconnectWordpressBtn').style.display = 'inline-block';
      await loadWordpressConfig();
      await loadWordpressCategories();
      await loadWordpressTopics();
      await loadWordpressKnowledge();
      await loadWordpressRecentPosts();
    } catch (e) {
      setConnStatus(`❌ ${e.message}`, '#c00');
    }
  };

  window.disconnectWordpress = async function () {
    const chatId = chat();
    if (!chatId) return;
    if (!confirm('Отключить WordPress блог?')) return;
    try {
      await jfetch(`${API}/wordpress/disconnect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId })
      });
      setConnStatus('Отключено', '#666');
      $('wordpressSettingsBlock').style.display = 'none';
      $('disconnectWordpressBtn').style.display = 'none';
      $('wordpressBaseUrl').value = '';
      $('wordpressUsername').value = '';
      $('wordpressAppPassword').value = '';
    } catch (e) {
      setConnStatus(`❌ ${e.message}`, '#c00');
    }
  };

  // ===== Config load/save =====
  async function loadWordpressConfig() {
    const chatId = chat();
    if (!chatId) return;
    try {
      const r = await jfetch(`${API}/wordpress/config?chatId=${encodeURIComponent(chatId)}`);
      const c = r.config || {};
      $('wordpressEnabled').checked = !!c.enabled;
      $('wordpressAutoPublish').checked = !!c.autoPublish;
      $('wordpressAnnounceTelegram').checked = c.announceTelegram !== false;
      $('wordpressUseKnowledgeBase').checked = c.useKnowledgeBase !== false;
      const time = (c.scheduleTime || '09:00').split(':');
      $('wordpressScheduleHour').value = time[0] || '09';
      $('wordpressScheduleMinute').value = time[1] || '00';
      $('wordpressScheduleTime').value = c.scheduleTime || '09:00';
      $('wordpressScheduleTz').value = c.scheduleTz || 'Europe/Moscow';
      $('wordpressDailyLimit').value = c.dailyLimit || 1;
      $('wordpressMinIntervalHours').value = c.minIntervalHours || 6;
      const days = Array.isArray(c.scheduleDays) ? c.scheduleDays : [1, 2, 3, 4, 5];
      [0, 1, 2, 3, 4, 5, 6].forEach(d => {
        const el = $(`wordpressWeekday${d}`);
        if (el) el.checked = days.includes(d);
      });
      if (c.defaultCategoryId) $('wordpressDefaultCategoryId').value = c.defaultCategoryId;
    } catch (e) {
      console.warn('loadWordpressConfig:', e.message);
    }
  }
  window.loadWordpressConfig = loadWordpressConfig;

  window.saveWordpressConfig = async function () {
    const chatId = chat();
    if (!chatId) return;
    const days = [0, 1, 2, 3, 4, 5, 6].filter(d => $(`wordpressWeekday${d}`)?.checked);
    const cfg = {
      enabled: $('wordpressEnabled').checked,
      autoPublish: $('wordpressAutoPublish').checked,
      announceTelegram: $('wordpressAnnounceTelegram').checked,
      useKnowledgeBase: $('wordpressUseKnowledgeBase').checked,
      scheduleTime: $('wordpressScheduleTime').value || '09:00',
      scheduleTz: $('wordpressScheduleTz').value,
      scheduleDays: days,
      dailyLimit: parseInt($('wordpressDailyLimit').value, 10) || 1,
      minIntervalHours: parseInt($('wordpressMinIntervalHours').value, 10) || 6,
      defaultCategoryId: parseInt($('wordpressDefaultCategoryId').value, 10) || null
    };
    setStatus('Сохранение...', '#666');
    try {
      await jfetch(`${API}/wordpress/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId, config: cfg })
      });
      setStatus('✅ Сохранено', '#0a0');
    } catch (e) {
      setStatus(`❌ ${e.message}`, '#c00');
    }
  };

  // ===== Time helpers =====
  window.updateWordpressScheduleTime = function () {
    const h = $('wordpressScheduleHour').value;
    const m = ($('wordpressScheduleMinute').value || '00').padStart(2, '0');
    $('wordpressScheduleTime').value = `${h}:${m}`;
  };
  window.validateWordpressMinutes = function () {
    const el = $('wordpressScheduleMinute');
    let v = el.value.replace(/\D/g, '').slice(0, 2);
    if (v && parseInt(v, 10) > 59) v = '59';
    el.value = v;
    updateWordpressScheduleTime();
  };

  // ===== Categories =====
  async function loadWordpressCategories() {
    const chatId = chat();
    if (!chatId) return;
    try {
      const r = await jfetch(`${API}/wordpress/categories?chatId=${encodeURIComponent(chatId)}`);
      const sel = $('wordpressDefaultCategoryId');
      const cats = r.categories || [];
      sel.innerHTML = '<option value="">— Без категории —</option>' +
        cats.map(c => `<option value="${c.id}">${c.name} (${c.count || 0})</option>`).join('');
    } catch (e) {
      console.warn('loadWordpressCategories:', e.message);
    }
  }
  window.loadWordpressCategories = loadWordpressCategories;

  // ===== Run now =====
  window.runWordpressNow = async function () {
    const chatId = chat();
    if (!chatId) return;
    setStatus('Постановка задачи...', '#666');
    try {
      const r = await jfetch(`${API}/wordpress/run-now`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId })
      });
      setStatus(`✅ ${r.message || 'Задача поставлена'}`, '#0a0');
      setTimeout(loadWordpressRecentPosts, 2000);
    } catch (e) {
      setStatus(`❌ ${e.message}`, '#c00');
    }
  };

  // ===== Topics CRUD =====
  async function loadWordpressTopics() {
    const chatId = chat();
    if (!chatId) return;
    try {
      const r = await jfetch(`${API}/topics?chatId=${encodeURIComponent(chatId)}&include_used=true&limit=50`);
      const list = r.topics || [];
      const el = $('wordpressTopicsList');
      if (!list.length) { el.innerHTML = '<em style="color:#999">Темы пока не добавлены</em>'; return; }
      el.innerHTML = list.map(t => `
        <div style="display:flex; justify-content:space-between; align-items:center; padding:6px 0; border-bottom:1px solid #f0f0f0;">
          <div>
            <strong>${escapeHtml(t.topic)}</strong>
            <span style="color:#666; font-size:12px;"> · ${escapeHtml(t.keywords || '')}</span>
            ${t.used_at ? `<span style="color:#999; font-size:11px;"> · использована</span>` : ''}
          </div>
          <button class="btn btn-secondary" style="padding:4px 8px; font-size:12px;" onclick="deleteWordpressTopic(${t.id})">✕</button>
        </div>
      `).join('');
    } catch (e) {
      console.warn('loadWordpressTopics:', e.message);
    }
  }
  window.loadWordpressTopics = loadWordpressTopics;

  window.addWordpressTopic = async function () {
    const chatId = chat();
    if (!chatId) return;
    const topic = $('wordpressNewTopic').value.trim();
    const keywords = $('wordpressNewKeywords').value.trim();
    const priority = parseInt($('wordpressNewPriority').value, 10) || 1;
    if (!topic) return setStatus('Введите тему', '#c00');
    try {
      await jfetch(`${API}/topics`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId, topic, keywords, priority, channel: 'wordpress' })
      });
      $('wordpressNewTopic').value = '';
      $('wordpressNewKeywords').value = '';
      await loadWordpressTopics();
    } catch (e) {
      setStatus(`❌ ${e.message}`, '#c00');
    }
  };

  window.deleteWordpressTopic = async function (id) {
    const chatId = chat();
    if (!chatId || !confirm('Удалить тему?')) return;
    try {
      await jfetch(`${API}/topics/${id}?chatId=${encodeURIComponent(chatId)}`, { method: 'DELETE' });
      await loadWordpressTopics();
    } catch (e) {
      setStatus(`❌ ${e.message}`, '#c00');
    }
  };

  // ===== Knowledge CRUD =====
  async function loadWordpressKnowledge() {
    const chatId = chat();
    if (!chatId) return;
    try {
      const r = await jfetch(`${API}/knowledge?chatId=${encodeURIComponent(chatId)}`);
      const list = r.documents || r.items || [];
      const el = $('wordpressKnowledgeList');
      if (!list.length) { el.innerHTML = '<em style="color:#999">Документы пока не добавлены</em>'; return; }
      el.innerHTML = list.map(d => `
        <div style="display:flex; justify-content:space-between; align-items:center; padding:6px 0; border-bottom:1px solid #f0f0f0;">
          <div>
            <strong>${escapeHtml(d.title)}</strong>
            <span style="color:#666; font-size:12px;"> · ${(d.body || '').length} симв.</span>
          </div>
          <button class="btn btn-secondary" style="padding:4px 8px; font-size:12px;" onclick="deleteWordpressKnowledge(${d.id})">✕</button>
        </div>
      `).join('');
    } catch (e) {
      console.warn('loadWordpressKnowledge:', e.message);
    }
  }
  window.loadWordpressKnowledge = loadWordpressKnowledge;

  window.addWordpressKnowledge = async function () {
    const chatId = chat();
    if (!chatId) return;
    const title = $('wordpressKnowledgeTitle').value.trim();
    const body = $('wordpressKnowledgeBody').value.trim();
    if (!title || !body) return setStatus('Заполните название и содержимое', '#c00');
    try {
      await jfetch(`${API}/knowledge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId, title, body })
      });
      $('wordpressKnowledgeTitle').value = '';
      $('wordpressKnowledgeBody').value = '';
      await loadWordpressKnowledge();
    } catch (e) {
      setStatus(`❌ ${e.message}`, '#c00');
    }
  };

  window.deleteWordpressKnowledge = async function (id) {
    const chatId = chat();
    if (!chatId || !confirm('Удалить документ?')) return;
    try {
      await jfetch(`${API}/knowledge/${id}?chatId=${encodeURIComponent(chatId)}`, { method: 'DELETE' });
      await loadWordpressKnowledge();
    } catch (e) {
      setStatus(`❌ ${e.message}`, '#c00');
    }
  };

  // ===== Recent posts =====
  async function loadWordpressRecentPosts() {
    const chatId = chat();
    if (!chatId) return;
    try {
      const r = await jfetch(`${API}/wordpress/posts?chatId=${encodeURIComponent(chatId)}&limit=10`);
      const list = r.posts || [];
      const el = $('wordpressRecentPosts');
      if (!list.length) { el.innerHTML = '<em style="color:#999">Статей пока нет</em>'; return; }
      el.innerHTML = list.map(p => {
        const link = p.wp_permalink || p.wp_preview_url;
        const status = p.publish_status || 'draft';
        const color = status === 'published' ? '#0a0' : status === 'error' || status === 'rejected' ? '#c00' : '#888';
        return `<div style="padding:6px 0; border-bottom:1px solid #f0f0f0;">
          <div><strong>${escapeHtml(p.seo_title || 'Без заголовка')}</strong> <span style="color:${color}; font-size:11px;">[${status}]</span></div>
          ${link ? `<div style="font-size:11px;"><a href="${link}" target="_blank">${escapeHtml(link)}</a></div>` : ''}
        </div>`;
      }).join('');
    } catch (e) {
      console.warn('loadWordpressRecentPosts:', e.message);
    }
  }
  window.loadWordpressRecentPosts = loadWordpressRecentPosts;

  // ===== Status (auto on tab open) =====
  async function loadWordpressStatus() {
    const chatId = chat();
    if (!chatId) return;
    try {
      const r = await jfetch(`${API}/wordpress/status?chatId=${encodeURIComponent(chatId)}`);
      if (r.connected) {
        setConnStatus(`✅ Подключено: ${r.config?.baseUrl || ''}`, '#0a0');
        $('wordpressSettingsBlock').style.display = 'block';
        $('disconnectWordpressBtn').style.display = 'inline-block';
        if (r.config?.baseUrl) $('wordpressBaseUrl').value = r.config.baseUrl;
        if (r.config?.username) $('wordpressUsername').value = r.config.username;
        await loadWordpressConfig();
        await loadWordpressCategories();
        await loadWordpressTopics();
        await loadWordpressKnowledge();
        await loadWordpressRecentPosts();
      } else {
        setConnStatus('Не подключено', '#888');
      }
    } catch (e) {
      console.warn('loadWordpressStatus:', e.message);
    }
  }
  window.loadWordpressStatus = loadWordpressStatus;

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  // Авто-загрузка при открытии вкладки
  document.addEventListener('click', (ev) => {
    const t = ev.target;
    if (t && t.matches('button.channel-tab[data-channel="blog"]')) {
      setTimeout(loadWordpressStatus, 100);
    }
  });

  // Если вкладка blog уже активна на загрузке — подгрузим
  window.addEventListener('load', () => {
    if (chat()) setTimeout(loadWordpressStatus, 500);
  });
})();
