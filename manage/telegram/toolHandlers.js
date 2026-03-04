const sessionService = require('../../services/session.service');
const planService = require('../../services/plan.service');
const snapshotService = require('../../services/snapshot.service');
const depsService = require('../../services/deps.service');
const projectCacheService = require('../../services/projectCache.service');
const manageStore = require('../store');
const https = require('https');
const http = require('http');
const { URL } = require('url');

/**
 * Проверяет, является ли URL приватным (SSRF protection)
 */
function isPrivateIP(hostname) {
  // localhost
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
    return true;
  }
  
  // Частные диапазоны
  const privateRanges = [
    /^10\./,                    // 10.0.0.0/8
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./, // 172.16.0.0/12
    /^192\.168\./,              // 192.168.0.0/16
    /^169\.254\./,              // Link-local
    /^0\.0\.0\.0/,              // All interfaces
  ];
  
  return privateRanges.some(regex => regex.test(hostname));
}

/**
 * Выполняет HTTP-запрос с хоста (не из контейнера)
 */
async function handleHttpRequest(chatId, args) {
  const { method = 'GET', url, headers = {}, body, timeout = 15, follow_redirects = true } = args;
  
  // Валидация
  if (!url) {
    return { ok: false, error: 'URL обязателен' };
  }
  
  const timeoutMs = Math.min(Math.max(timeout, 1), 60) * 1000;
  
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch (e) {
    return { ok: false, error: `Некорректный URL: ${e.message}` };
  }
  
  // SSRF защита
  if (isPrivateIP(parsedUrl.hostname)) {
    return { ok: false, error: 'Запросы к приватным IP-адресам запрещены (SSRF protection)' };
  }
  
  const startTime = Date.now();
  
  return new Promise((resolve) => {
    const requestOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: method.toUpperCase(),
      headers: {},
      timeout: timeoutMs
    };
    
    // Добавляем заголовки (кроме Authorization для логов)
    for (const [key, value] of Object.entries(headers)) {
      requestOptions.headers[key] = value;
    }
    
    // Автоматический Content-Type для JSON body
    let bodyStr = '';
    if (body !== undefined && body !== null) {
      if (typeof body === 'object') {
        bodyStr = JSON.stringify(body);
        if (!requestOptions.headers['content-type']) {
          requestOptions.headers['content-type'] = 'application/json';
        }
      } else {
        bodyStr = String(body);
      }
      if (bodyStr) {
        requestOptions.headers['content-length'] = Buffer.byteLength(bodyStr);
      }
    }
    
    const protocol = parsedUrl.protocol === 'https:' ? https : http;
    
    const req = protocol.request(requestOptions, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const elapsed_ms = Date.now() - startTime;
        
        // Редиректы
        if (follow_redirects && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return resolve(handleHttpRequest(chatId, {
            method,
            url: res.headers.location,
            headers,
            body,
            timeout: timeout - elapsed_ms / 1000,
            follow_redirects: true
          }));
        }
        
        // Парсим JSON
        let parsedBody;
        let body_raw = data;
        if (data.length > 10000) {
          body_raw = data.slice(0, 10000) + '\n[...truncated]';
        }
        
        try {
          parsedBody = JSON.parse(data);
        } catch {
          parsedBody = body_raw;
        }
        
        // Логируем (без Authorization)
        const safeHeaders = { ...headers };
        delete safeHeaders['authorization'];
        delete safeHeaders['Authorization'];
        console.log(`[HTTP-REQUEST] ${chatId} ${method} ${url} → ${res.statusCode} ${elapsed_ms}ms`);
        
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          status_text: res.statusMessage,
          headers: res.headers,
          body: parsedBody,
          body_raw,
          elapsed_ms,
          url_resolved: url
        });
      });
    });
    
    req.on('error', (e) => {
      const elapsed_ms = Date.now() - startTime;
      console.error(`[HTTP-REQUEST] ${chatId} ${method} ${url} → ERROR: ${e.message}`);
      resolve({
        ok: false,
        error: e.code || 'REQUEST_ERROR',
        error_message: e.message,
        elapsed_ms
      });
    });
    
    req.on('timeout', () => {
      req.destroy();
      const elapsed_ms = Date.now() - startTime;
      resolve({
        ok: false,
        error: 'ETIMEDOUT',
        error_message: `Request timed out after ${timeoutMs}ms`,
        elapsed_ms
      });
    });
    
    if (bodyStr) {
      req.write(bodyStr);
    }
    req.end();
  });
}

/**
 * Запускает тесты в контейнере и возвращает структурированный результат
 */
async function handleRunTests(chatId, args) {
  const { path: testPath = '', framework = 'auto', timeout = 60 } = args;
  
  // Определяем фреймворк
  let detectedFramework = framework;
  if (framework === 'auto') {
    // Проверяем наличие pytest
    const pytestCheck = await sessionService.executeCommand(chatId, 'which pytest 2>/dev/null || which py.test 2>/dev/null', 5);
    if (pytestCheck.exitCode === 0) {
      detectedFramework = 'pytest';
    } else {
      // Проверяем jest для .js файлов
      const jestCheck = await sessionService.executeCommand(chatId, 'which npx 2>/dev/null && test -f package.json', 5);
      if (jestCheck.exitCode === 0) {
        detectedFramework = 'jest';
      } else {
        detectedFramework = 'unittest'; // fallback
      }
    }
  }
  
  const startTime = Date.now();
  let result;
  
  if (detectedFramework === 'pytest') {
    // pytest с JSON-отчётом (если плагин установлен) или парсинг stdout
    const pytestCmd = testPath 
      ? `pytest "${testPath}" --tb=short -q 2>&1`
      : `pytest --tb=short -q 2>&1`;
    
    result = await sessionService.executeCommand(chatId, pytestCmd, timeout);
    
    // Парсим вывод pytest
    const output = result.stdout + '\n' + result.stderr;
    const passed = [];
    const failed = [];
    
    // Паттерны: PASSED test_file.py::test_name, FAILED test_file.py::test_name
    const passedMatch = output.match(/PASSED\s+([^\s]+)/g) || [];
    const failedMatch = output.match(/FAILED\s+([^\s]+)/g) || [];
    
    passedMatch.forEach(m => {
      const testName = m.replace('PASSED ', '');
      passed.push(testName);
    });
    
    failedMatch.forEach(m => {
      const testName = m.replace('FAILED ', '');
      failed.push({
        test: testName,
        error_type: 'AssertionError',
        message: 'Test failed',
        traceback: ''
      });
    });
    
    // Извлекаем traceback для failed тестов
    const failedSections = output.split('FAILED');
    for (let i = 1; i < failedSections.length && i <= failed.length; i++) {
      const section = failedSections[i];
      const lines = section.split('\n').slice(0, 20);
      failed[i - 1].traceback = lines.join('\n').slice(0, 500);
    }
    
    const total = passed.length + failed.length;
    const elapsed_sec = (Date.now() - startTime) / 1000;
    
    return {
      ok: failed.length === 0 && result.exitCode === 0,
      framework: 'pytest',
      summary: {
        total,
        passed: passed.length,
        failed: failed.length,
        errors: 0,
        skipped: 0,
        duration_sec: elapsed_sec
      },
      passed,
      failed,
      stdout_tail: output.slice(-500)
    };
  }
  
  if (detectedFramework === 'jest') {
    const jestCmd = testPath 
      ? `npx jest "${testPath}" --json 2>&1 || true`
      : `npx jest --json 2>&1 || true`;
    
    result = await sessionService.executeCommand(chatId, jestCmd, timeout);
    
    // Парсим JSON от jest
    try {
      const jsonMatch = result.stdout.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const jestResult = JSON.parse(jsonMatch[0]);
        const passed = [];
        const failed = [];
        
        if (jestResult.success) {
          jestResult.testResults.forEach(tr => {
            tr.assertionResults.forEach(ar => {
              if (ar.status === 'passed') {
                passed.push(`${tr.name}::${ar.title}`);
              } else if (ar.status === 'failed') {
                failed.push({
                  test: `${tr.name}::${ar.title}`,
                  error_type: 'AssertionError',
                  message: ar.failureMessages.join('\n').slice(0, 200),
                  traceback: ar.failureMessages.join('\n').slice(0, 500)
                });
              }
            });
          });
        }
        
        const elapsed_sec = (Date.now() - startTime) / 1000;
        
        return {
          ok: jestResult.success,
          framework: 'jest',
          summary: {
            total: jestResult.numTotalTests,
            passed: jestResult.numPassedTests,
            failed: jestResult.numFailedTests,
            errors: 0,
            skipped: jestResult.numPendingTests,
            duration_sec: elapsed_sec
          },
          passed,
          failed,
          stdout_tail: result.stdout.slice(-500)
        };
      }
    } catch (e) {
      // Fallback — парсинг stdout
    }
    
    // Если JSON не найден, возвращаем сырой вывод
    return {
      ok: result.exitCode === 0,
      framework: 'jest',
      summary: { total: 0, passed: 0, failed: 0, errors: 0, skipped: 0, duration_sec: 0 },
      passed: [],
      failed: [],
      stdout_tail: result.stdout.slice(-500),
      error: 'Не удалось распарсить вывод Jest'
    };
  }
  
  // unittest fallback
  const unittestCmd = testPath 
    ? `python -m unittest "${testPath}" -v 2>&1`
    : `python -m unittest discover -v 2>&1`;
  
  result = await sessionService.executeCommand(chatId, unittestCmd, timeout);
  
  const output = result.stdout + '\n' + result.stderr;
  
  // Парсим финальную строку unittest: "Ran N tests in Xs" + "OK" или "FAILED (failures=N)"
  let total = 0, passed = 0, failed = 0, errors = 0;
  
  const ranMatch = output.match(/Ran (\d+) test/);
  if (ranMatch) {
    total = parseInt(ranMatch[1]);
  }
  
  // Ищем финальный статус
  if (output.includes('\nOK\n') || output.endsWith('\nOK')) {
    passed = total;
  } else {
    // FAILED (failures=2, errors=1) или FAILED (failures=3)
    const failedMatch = output.match(/FAILED.*failures=(\d+)/);
    const errorsMatch = output.match(/FAILED.*errors=(\d+)/);
    
    if (failedMatch) failed = parseInt(failedMatch[1]);
    if (errorsMatch) errors = parseInt(errorsMatch[1]);
    
    // passed = total - failed - errors
    passed = Math.max(0, total - failed - errors);
  }
  
  const elapsed_sec = (Date.now() - startTime) / 1000;
  
  return {
    ok: result.exitCode === 0,
    framework: 'unittest',
    summary: {
      total,
      passed,
      failed,
      errors,
      skipped: 0,
      duration_sec: elapsed_sec
    },
    passed: [],
    failed: [],
    stdout_tail: output.slice(-500)
  };
}

/**
 * Вычисляет детерминированный порт для приложения на основе chatId и имени.
 * Диапазон 3100–3999 (900 портов), не пересекается с основным сервером (3015).
 */
function getAppPort(chatId, appName) {
  let hash = 0;
  const str = `${chatId}:${appName}`;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return 3100 + (Math.abs(hash) % 900);
}

async function handleCreateNodejsApp(chatId, { name, type, description }, agentCtx) {
  const safeName = name.replace(/[^a-z0-9-_]/g, '').toLowerCase();
  const appDir = `/workspace/apps/${safeName}`;
  const publicDir = `${appDir}/public`;
  const appPort = getAppPort(chatId, safeName);

  // ──────────────────────────────────────────────
  // 1. Специализированные шаблоны по типу приложения
  // ──────────────────────────────────────────────

  // --- app.js: chat ---
  const appJsChat = `
const express = require('express');
const path = require('path');
const app = express();
const port = parseInt(process.env.PORT) || ${appPort};

app.use(express.json());
app.use(express.static('public'));

// Хранилище сообщений в памяти
const messages = [];

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/ping', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString(), app: '${safeName}' });
});

// Получить историю сообщений (polling)
app.get('/api/messages', (req, res) => {
  const since = parseInt(req.query.since) || 0;
  res.json(messages.filter(m => m.id > since));
});

// Отправить сообщение
app.post('/api/messages', (req, res) => {
  const text = (req.body.text || '').trim();
  const author = (req.body.author || 'Аноним').trim();
  if (!text) return res.status(400).json({ error: 'Пустое сообщение' });
  const msg = { id: Date.now(), author, text, time: new Date().toISOString() };
  messages.push(msg);
  if (messages.length > 200) messages.shift(); // ограничение истории
  res.json(msg);
});

app.listen(port, '0.0.0.0', () => {
  console.log(\`Chat app ${safeName} running on port \${port}\`);
});
  `.trim();

  // --- index.html: chat ---
  const indexHtmlChat = `
<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${safeName} — Чат</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: #f0f2f5; height: 100vh; display: flex; flex-direction: column; }
    header { background: #075e54; color: white; padding: 1rem 1.5rem; font-size: 1.1rem; font-weight: bold; }
    #chat { flex: 1; overflow-y: auto; padding: 1rem; display: flex; flex-direction: column; gap: 0.5rem; }
    .msg { max-width: 70%; padding: 0.5rem 0.8rem; border-radius: 12px; line-height: 1.4; word-break: break-word; }
    .msg.mine { background: #dcf8c6; align-self: flex-end; border-bottom-right-radius: 3px; }
    .msg.other { background: white; align-self: flex-start; border-bottom-left-radius: 3px; box-shadow: 0 1px 2px rgba(0,0,0,.1); }
    .msg .author { font-size: 0.75rem; font-weight: bold; color: #075e54; margin-bottom: 2px; }
    .msg .time { font-size: 0.7rem; color: #999; text-align: right; margin-top: 2px; }
    #form { display: flex; gap: 0.5rem; padding: 0.75rem 1rem; background: #f0f2f5; border-top: 1px solid #ddd; }
    #name { width: 110px; padding: 0.6rem; border: 1px solid #ccc; border-radius: 20px; font-size: 0.9rem; }
    #text { flex: 1; padding: 0.6rem 1rem; border: 1px solid #ccc; border-radius: 20px; font-size: 0.95rem; outline: none; }
    #text:focus { border-color: #075e54; }
    button { padding: 0.6rem 1.2rem; background: #075e54; color: white; border: none; border-radius: 20px; cursor: pointer; font-size: 0.95rem; }
    button:hover { background: #128c7e; }
  </style>
</head>
<body>
  <header>💬 ${safeName}</header>
  <div id="chat"></div>
  <div id="form">
    <input id="name" type="text" placeholder="Ваше имя" value="Гость" maxlength="20">
    <input id="text" type="text" placeholder="Сообщение..." maxlength="500" autocomplete="off">
    <button onclick="send()">➤</button>
  </div>
  <script>
    let lastId = 0;
    const myName = () => document.getElementById('name').value.trim() || 'Гость';

    function addMsg(m, mine) {
      const chat = document.getElementById('chat');
      const d = document.createElement('div');
      d.className = 'msg ' + (mine ? 'mine' : 'other');
      const t = new Date(m.time).toLocaleTimeString('ru', {hour:'2-digit',minute:'2-digit'});
      d.innerHTML = \`<div class="author">\${m.author}</div><div>\${m.text}</div><div class="time">\${t}</div>\`;
      chat.appendChild(d);
      chat.scrollTop = chat.scrollHeight;
    }

    async function poll() {
      try {
        const r = await fetch(\`api/messages?since=\${lastId}\`);
        const msgs = await r.json();
        msgs.forEach(m => { addMsg(m, m.author === myName()); lastId = Math.max(lastId, m.id); });
      } catch(e) {}
    }

    async function send() {
      const input = document.getElementById('text');
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      try {
        const r = await fetch('api/messages', {
          method: 'POST',
          headers: {'Content-Type':'application/json'},
          body: JSON.stringify({ text, author: myName() })
        });
        const m = await r.json();
        addMsg(m, true);
        lastId = Math.max(lastId, m.id);
      } catch(e) { alert('Ошибка отправки'); }
    }

    document.getElementById('text').addEventListener('keydown', e => { if (e.key === 'Enter') send(); });
    poll();
    setInterval(poll, 2000);
  </script>
</body>
</html>
  `.trim();

  // --- app.js: todo ---
  const appJsTodo = `
const express = require('express');
const path = require('path');
const app = express();
const port = parseInt(process.env.PORT) || ${appPort};

app.use(express.json());
app.use(express.static('public'));

let todos = [];
let nextId = 1;

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/api/ping', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));
app.get('/api/todos', (req, res) => res.json(todos));
app.post('/api/todos', (req, res) => {
  const text = (req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Пустая задача' });
  const todo = { id: nextId++, text, done: false, created: new Date().toISOString() };
  todos.push(todo);
  res.json(todo);
});
app.patch('/api/todos/:id', (req, res) => {
  const todo = todos.find(t => t.id === parseInt(req.params.id));
  if (!todo) return res.status(404).json({ error: 'Не найдено' });
  if (req.body.done !== undefined) todo.done = req.body.done;
  if (req.body.text) todo.text = req.body.text;
  res.json(todo);
});
app.delete('/api/todos/:id', (req, res) => {
  todos = todos.filter(t => t.id !== parseInt(req.params.id));
  res.json({ ok: true });
});

app.listen(port, '0.0.0.0', () => console.log(\`Todo app ${safeName} on port \${port}\`));
  `.trim();

  // --- index.html: todo ---
  const indexHtmlTodo = `
<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${safeName} — Задачи</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: system-ui, sans-serif; max-width: 600px; margin: 2rem auto; padding: 0 1rem; background: #f8f9fa; }
    h1 { color: #2c3e50; margin-bottom: 1.5rem; }
    #add-form { display: flex; gap: 0.5rem; margin-bottom: 1.5rem; }
    #new-todo { flex: 1; padding: 0.7rem 1rem; border: 2px solid #ddd; border-radius: 8px; font-size: 1rem; }
    #new-todo:focus { border-color: #3498db; outline: none; }
    button.add { padding: 0.7rem 1.2rem; background: #3498db; color: white; border: none; border-radius: 8px; cursor: pointer; font-size: 1rem; }
    button.add:hover { background: #2980b9; }
    .todo { display: flex; align-items: center; gap: 0.75rem; background: white; padding: 0.75rem 1rem; border-radius: 8px; margin-bottom: 0.5rem; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
    .todo input[type=checkbox] { width: 18px; height: 18px; cursor: pointer; }
    .todo .text { flex: 1; font-size: 1rem; }
    .todo.done .text { text-decoration: line-through; color: #aaa; }
    .todo button.del { background: none; border: none; color: #e74c3c; cursor: pointer; font-size: 1.2rem; padding: 0 0.3rem; }
    .todo button.del:hover { color: #c0392b; }
    #stats { color: #888; font-size: 0.9rem; margin-bottom: 1rem; }
  </style>
</head>
<body>
  <h1>✅ ${safeName}</h1>
  <div id="add-form">
    <input id="new-todo" type="text" placeholder="Новая задача..." maxlength="200">
    <button class="add" onclick="addTodo()">Добавить</button>
  </div>
  <div id="stats"></div>
  <div id="list"></div>
  <script>
    async function load() {
      const todos = await fetch('api/todos').then(r => r.json());
      const list = document.getElementById('list');
      const done = todos.filter(t => t.done).length;
      document.getElementById('stats').textContent = \`Всего: \${todos.length}, выполнено: \${done}\`;
      list.innerHTML = '';
      todos.forEach(t => {
        const d = document.createElement('div');
        d.className = 'todo' + (t.done ? ' done' : '');
        d.innerHTML = \`<input type="checkbox" \${t.done?'checked':''} onchange="toggle(\${t.id},this.checked)">
          <span class="text">\${t.text}</span>
          <button class="del" onclick="del(\${t.id})">✕</button>\`;
        list.appendChild(d);
      });
    }
    async function addTodo() {
      const inp = document.getElementById('new-todo');
      const text = inp.value.trim();
      if (!text) return;
      await fetch('api/todos', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({text}) });
      inp.value = '';
      load();
    }
    async function toggle(id, done) {
      await fetch(\`api/todos/\${id}\`, { method:'PATCH', headers:{'Content-Type':'application/json'}, body: JSON.stringify({done}) });
      load();
    }
    async function del(id) {
      await fetch(\`api/todos/\${id}\`, { method:'DELETE' });
      load();
    }
    document.getElementById('new-todo').addEventListener('keydown', e => { if (e.key==='Enter') addTodo(); });
    load();
  </script>
</body>
</html>
  `.trim();

  // --- app.js: generic (dashboard / api / custom) ---
  const appJsGeneric = `
const express = require('express');
const path = require('path');
const app = express();
const port = parseInt(process.env.PORT) || ${appPort};

app.use(express.json());
app.use(express.static('public'));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/ping', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString(), app: '${safeName}' });
});

// TODO: добавить маршруты под конкретный тип приложения

app.listen(port, '0.0.0.0', () => {
  console.log(\`App ${safeName} running on port \${port}\`);
});
  `.trim();

  // --- index.html: generic ---
  const indexHtmlGeneric = `
<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${safeName} — ${type}</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 2rem; background: #f8f9fa; }
    h1 { color: #2c3e50; }
    #status { font-family: monospace; background: #e9ecef; padding: 1rem; border-radius: 6px; }
    button { padding: 0.6rem 1.2rem; background: #007bff; color: white; border: none; border-radius: 6px; cursor: pointer; }
    button:hover { background: #0056b3; }
  </style>
</head>
<body>
  <h1>Приложение «${safeName}» (${type})</h1>
  <p>Статус сервера:</p>
  <div id="status">Проверка соединения...</div>
  <button onclick="testApi()">Проверить /api/ping</button>
  <script>
    async function testApi() {
      try {
        const r = await fetch('api/ping');
        const data = await r.json();
        document.getElementById('status').innerHTML = '<pre>' + JSON.stringify(data, null, 2) + '</pre>';
      } catch (e) {
        document.getElementById('status').textContent = 'Ошибка: ' + e.message;
      }
    }
    testApi();
  </script>
</body>
</html>
  `.trim();

  // Выбираем шаблон по типу
  let appJsTemplate, indexHtmlTemplate;
  if (type === 'chat') {
    appJsTemplate = appJsChat;
    indexHtmlTemplate = indexHtmlChat;
  } else if (type === 'todo') {
    appJsTemplate = appJsTodo;
    indexHtmlTemplate = indexHtmlTodo;
  } else {
    // dashboard, api, custom — базовый шаблон, агент доработает через write_file
    appJsTemplate = appJsGeneric;
    indexHtmlTemplate = indexHtmlGeneric;
  }

  // ──────────────────────────────────────────────
  // 2. Полный скрипт создания + установка + запуск + проверка
  // ──────────────────────────────────────────────
  const creationScript = `
set -e

# Контейнер работает от root — mkdir и chmod не требуют sudo
mkdir -p "${publicDir}"

# Пишем app.js
cat > "${appDir}/app.js" << 'EOF_APP'
${appJsTemplate}
EOF_APP

# Пишем index.html
cat > "${publicDir}/index.html" << 'EOF_HTML'
${indexHtmlTemplate}
EOF_HTML

# Устанавливаем зависимости
cd "${appDir}"
npm init -y --quiet
npm install express --save --quiet

# Удаляем старый процесс, если был
pm2 delete app-${safeName} 2>/dev/null || true

# Запускаем с фиксированным портом через env
PORT=${appPort} pm2 start "${appDir}/app.js" --name "app-${safeName}" --cwd "${appDir}"

# Даём 3 секунды на старт
sleep 3

# Проверяем статус
pm2 list | grep "app-${safeName}" || echo "Процесс не запущен!"

# Сохраняем список процессов для pm2 resurrect после рестарта контейнера
pm2 save --force 2>/dev/null || true

# Проверяем доступность через curl внутри контейнера
curl -sf http://localhost:${appPort}/api/ping && echo "OK: port ${appPort} responding" || echo "WARN: port ${appPort} not responding yet"
  `;

  const result = await sessionService.executeCommand(chatId, creationScript, 60);

  // Получаем реальный порт из pm2 jlist для надёжности
  let realPort = appPort;
  try {
    const pm2Info = await sessionService.executeCommand(
      chatId,
      `pm2 jlist 2>/dev/null | python3 -c "import sys,json; procs=json.load(sys.stdin); p=[x for x in procs if x.get('name')=='app-${safeName}']; print(p[0]['pm2_env'].get('env',{}).get('PORT','${appPort}') if p else '${appPort}')"`,
      10
    );
    const parsed = parseInt(pm2Info.stdout.trim());
    if (!isNaN(parsed) && parsed > 0) realPort = parsed;
  } catch (_) { /* используем appPort */ }

  const url = `https://claw.pro-talk.ru/sandbox/${chatId}/app/${safeName}`;

  // Регистрируем приложение (сохраняем порт для прокси)
  manageStore.addOrUpdateApp(chatId, {
    name: safeName,
    type,
    port: realPort,
    description: description || `Создано ${new Date().toISOString()}`,
    status: result.exitCode === 0 ? 'running' : 'error',
    url,
    lastCheck: Date.now(),
    logs: result.stdout + '\n---\n' + result.stderr
  });

  let message = `🚀 Приложение <b>${safeName}</b> (${type}) создано и запущено!\n\n`;
  message += `🔗 <a href="${url}">Открыть в браузере</a>\n\n`;

  if (result.exitCode !== 0) {
    message += `<b>⚠️ Обнаружены проблемы при создании:</b>\n<pre>${result.stderr.slice(0, 800)}</pre>\n`;
    message += `Попробую исправить автоматически на следующем шаге.`;
  } else {
    message += `Статус: работает. Тестовый эндпоинт <code>/api/ping</code> уже доступен.`;
  }

  // Отправляем красивое сообщение пользователю, если доступен контекст агента
  if (agentCtx && agentCtx.sendHtmlMessage) {
      let htmlMsg;
      if (result.exitCode !== 0) {
          htmlMsg = `<b>&#9888;&#65039; Ошибка при создании</b> приложения <code>${safeName}</code>\n\n`;
          htmlMsg += `<pre>${result.stderr.slice(0, 800).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</pre>\n\n`;
          htmlMsg += `Попробую исправить автоматически.`;
      } else {
          // Экранируем URL для href (амперсанды и спецсимволы)
          const safeUrl = url.replace(/&/g, '&amp;');
          htmlMsg = `<b>&#127881; Готово!</b> Приложение <code>${safeName}</code> запущено\n\n`;
          htmlMsg += `&#128279; <a href="${safeUrl}">Открыть в браузере</a>\n\n`;
          htmlMsg += `<i>Тестируй прямо сейчас:</i>\n`;
          htmlMsg += `&#8226; GET / &#8212; приветствие\n`;
          htmlMsg += `&#8226; POST с JSON &#8212; получишь эхо\n\n`;
      }
      await agentCtx.sendHtmlMessage(htmlMsg);
  }

  return {
    ok: result.exitCode === 0,
    // Поле error обязательно при неудаче — agentLoop.js использует его для errorCount
    ...(result.exitCode !== 0 && { error: `Ошибка создания приложения ${safeName}: ${result.stderr.slice(0, 300)}` }),
    message,
    details: result
  };
}

/**
 * Запускает линтер для файла и возвращает результат
 */
async function runLinter(chatId, filePath) {
  const ext = filePath.split('.').pop().toLowerCase();
  let lintCmd = '';
  let timeout = 10;
  
  // Определяем линтер по расширению
  if (ext === 'js' || ext === 'ts' || ext === 'jsx' || ext === 'tsx') {
    // Проверяем наличие eslint
    const eslintCheck = await sessionService.executeCommand(chatId, 'which eslint 2>/dev/null || which npx 2>/dev/null', 5);
    if (eslintCheck.exitCode === 0) {
      lintCmd = `npx eslint --no-eslintrc --parser-options=ecmaVersion:2020 "${filePath}" 2>&1 || true`;
      timeout = 15;
    } else {
      // Fallback: базовая синтаксическая проверка через node
      lintCmd = `node --check "${filePath}" 2>&1 || true`;
      timeout = 5;
    }
  } else if (ext === 'py') {
    // Python: pyflakes или pylint, fallback на python -m py_compile
    const pyflakesCheck = await sessionService.executeCommand(chatId, 'which pyflakes 2>/dev/null || which python3 2>/dev/null', 5);
    if (pyflakesCheck.exitCode === 0 && pyflakesCheck.stdout.includes('pyflakes')) {
      lintCmd = `pyflakes "${filePath}" 2>&1 || true`;
    } else {
      lintCmd = `python3 -m py_compile "${filePath}" 2>&1 || true`;
    }
    timeout = 10;
  } else {
    // Неподдерживаемое расширение
    return { ok: true, skipped: true, message: `Линтер для .${ext} не поддерживается` };
  }
  
  const result = await sessionService.executeCommand(chatId, lintCmd, timeout);
  const output = (result.stdout || '') + '\n' + (result.stderr || '');
  
  // Проверяем наличие ошибок
  const hasErrors = output.toLowerCase().includes('error') || 
                    output.includes('SyntaxError') ||
                    output.includes('IndentationError') ||
                    (result.exitCode !== 0 && output.trim().length > 0);
  
  return {
    ok: !hasErrors,
    linter: ext === 'py' ? 'python' : 'eslint/node',
    output: output.trim().slice(0, 500),
    errors: hasErrors ? output.trim().split('\n').slice(0, 5) : []
  };
}

async function handlePatchFile(chatId, { path, search_str, replace_str }, workflowState = {}) {
  const session = sessionService.getSession(chatId);
  if (session && session.hasPython3 === false) {
      return { ok: false, error: "python3 не установлен в контейнере. Инструмент patch_file недоступен. Используйте sed или другие утилиты через exec_command." };
  }

  // === WORKFLOW VALIDATION ===
  // Проверяем, был ли create_plan в этой сессии
  if (!workflowState.planCreated) {
    return { 
      ok: false, 
      error: "Нарушен workflow: сначала вызови create_plan с описанием изменений.",
      requires_plan: true,
      hint: "patch_file можно использовать только после create_plan. Это защита от случайных изменений."
    };
  }

  // Сохраняем снапшот для undo_edit (персистентное хранение)
  const current = await sessionService.executeCommand(chatId, `cat "${path}"`, 10);
  if (current.exitCode === 0 && current.stdout) {
    await snapshotService.saveSnapshot(chatId, path, current.stdout);
  }

  // Используем Python для надёжного поиска и замены с fuzzy matching
  // Алгоритм:
  // 1. Точный поиск (как раньше)
  // 2. Если не найден — нормализация (trim строк + collapse пробелов)
  // 3. Поиск нормализованного блока → применение к оригиналу
  // 4. Генерация unified diff для визуализации изменений
  const script = `
import sys, json
import re
import difflib
import os

path    = ${JSON.stringify(path)}
search  = ${JSON.stringify(search_str)}
replace = ${JSON.stringify(replace_str)}

def normalize_text(text):
    """Нормализация для fuzzy matching: trim строк + collapse пробелов."""
    lines = text.split('\\n')
    normalized_lines = []
    for line in lines:
        # Trim строки
        trimmed = line.strip()
        # Collapse внутренних пробелов (множественные → один)
        collapsed = re.sub(r'[ \\t]+', ' ', trimmed)
        normalized_lines.append(collapsed)
    return '\\n'.join(normalized_lines)

def find_fuzzy_match(content, search):
    """Поиск с fuzzy matching. Возвращает (start_pos, end_pos, matched_fragment) или None."""
    # 1. Точный поиск
    if search in content:
        start = content.find(search)
        return (start, start + len(search), search, False)
    
    # 2. Fuzzy поиск через нормализацию
    normalized_content = normalize_text(content)
    normalized_search = normalize_text(search)
    
    if normalized_search not in normalized_content:
        return None
    
    # Находим позицию в нормализованном контенте
    norm_start = normalized_content.find(normalized_search)
    norm_end = norm_start + len(normalized_search)
    
    # Восстанавливаем позицию в оригинальном контенте
    # Считаем символы до norm_start в нормализованном контенте
    char_count = 0
    orig_pos = 0
    norm_pos = 0
    
    lines = content.split('\\n')
    norm_lines = normalized_content.split('\\n')
    
    start_line = 0
    start_char_in_line = 0
    end_line = 0
    end_char_in_line = 0
    
    # Находим строку и позицию начала
    current_norm_pos = 0
    for i, norm_line in enumerate(norm_lines):
        line_start_norm = current_norm_pos
        line_end_norm = current_norm_pos + len(norm_line)
        
        if line_start_norm <= norm_start < line_end_norm:
            start_line = i
            # Позиция внутри строки (с учётом нормализации)
            norm_char_in_line = norm_start - line_start_norm
            # Примерно восстанавливаем позицию в оригинале
            orig_line = lines[i] if i < len(lines) else ''
            # Ищем соответствующий символ
            orig_pos_in_line = 0
            norm_pos_in_line = 0
            in_space = False
            for j, ch in enumerate(orig_line):
                if ch in ' \\t':
                    if not in_space:
                        in_space = True
                    # Пропускаем пробелы в нормализации
                else:
                    if in_space:
                        norm_pos_in_line += 1  # Один пробел в нормализации
                        in_space = False
                    if norm_pos_in_line == norm_char_in_line:
                        start_char_in_line = j
                        break
                    norm_pos_in_line += 1
            break
        current_norm_pos = line_end_norm + 1  # +1 за \\n
    
    # Находим строку и позицию конца
    current_norm_pos = 0
    for i, norm_line in enumerate(norm_lines):
        line_start_norm = current_norm_pos
        line_end_norm = current_norm_pos + len(norm_line)
        
        if line_start_norm < norm_end <= line_end_norm:
            end_line = i
            # Позиция внутри строки
            norm_char_in_line = norm_end - line_start_norm
            orig_line = lines[i] if i < len(lines) else ''
            # Восстанавливаем позицию
            orig_pos_in_line = 0
            norm_pos_in_line = 0
            in_space = False
            for j, ch in enumerate(orig_line):
                if ch in ' \\t':
                    if not in_space:
                        in_space = True
                else:
                    if in_space:
                        norm_pos_in_line += 1
                        in_space = False
                    if norm_pos_in_line >= norm_char_in_line:
                        end_char_in_line = j
                        break
                    norm_pos_in_line += 1
            else:
                end_char_in_line = len(orig_line)
            break
        current_norm_pos = line_end_norm + 1
    
    # Извлекаем найденный фрагмент из оригинала
    # Собираем строки от start_line до end_line
    matched_lines = []
    for i in range(start_line, end_line + 1):
        if i >= len(lines):
            break
        line = lines[i]
        if i == start_line and i == end_line:
            matched_lines.append(line[start_char_in_line:end_char_in_line])
        elif i == start_line:
            matched_lines.append(line[start_char_in_line:])
        elif i == end_line:
            matched_lines.append(line[:end_char_in_line])
        else:
            matched_lines.append(line)
    
    matched_fragment = '\\n'.join(matched_lines)
    
    # Вычисляем точные позиции в оригинальном контенте
    start_pos = sum(len(lines[i]) + 1 for i in range(start_line)) + start_char_in_line
    end_pos = sum(len(lines[i]) + 1 for i in range(end_line)) + end_char_in_line
    
    return (start_pos, end_pos, matched_fragment, True)

def generate_unified_diff(old_content, new_content, filepath, max_lines=50):
    """Генерирует unified diff между старым и новым содержимым."""
    old_lines = old_content.splitlines(keepends=True)
    new_lines = new_content.splitlines(keepends=True)
    
    # Генерируем unified diff
    diff = difflib.unified_diff(
        old_lines,
        new_lines,
        fromfile=f'a/{os.path.basename(filepath)}',
        tofile=f'b/{os.path.basename(filepath)}',
        lineterm=''
    )
    
    diff_lines = list(diff)
    
    # Ограничиваем вывод до max_lines
    if len(diff_lines) > max_lines:
        truncated_diff = diff_lines[:max_lines]
        truncated_diff.append(f'\\n[...truncated ({len(diff_lines) - max_lines} more lines)]\\n')
        return ''.join(truncated_diff)
    
    return ''.join(diff_lines)

try:
    content = open(path, 'r', encoding='utf-8').read()
    
    result = find_fuzzy_match(content, search)
    
    if result is None:
        print(json.dumps({"ok": False, "error": "search_str не найден в файле (даже с fuzzy matching)"}))
        sys.exit(0)
    
    start_pos, end_pos, matched_fragment, is_fuzzy = result
    
    # Применяем замену
    new_content = content[:start_pos] + replace + content[end_pos:]
    open(path, 'w', encoding='utf-8').write(new_content)
    
    # Генерируем unified diff
    diff = generate_unified_diff(content, new_content, path, max_lines=50)
    
    response = {
        "ok": True,
        "replacements": 1,
        "total_occurrences": 1,
        "diff": diff
    }
    
    if is_fuzzy:
        response["fuzzy"] = True
        response["matched_fragment"] = matched_fragment
        response["message"] = "Патч применён с fuzzy matching. Проверьте matched_fragment и diff."
    
    print(json.dumps(response))
    
except Exception as e:
    print(json.dumps({"ok": False, "error": str(e)}))
`.trim();

  const result = await sessionService.executeCommand(
    chatId,
    `python3 -c ${JSON.stringify(script)}`,
    15
  );

  try {
    const patchResult = JSON.parse(result.stdout);
    
    // === AUTOMATIC LINT AFTER PATCH ===
    // Если патч успешен — запускаем линтер в фоне
    if (patchResult.ok) {
      const lintResult = await runLinter(chatId, path);
      patchResult.lint = lintResult;
      
      // Если линтер нашёл ошибки — добавляем предупреждение
      if (!lintResult.ok && !lintResult.skipped) {
        patchResult.requires_review = true;
        patchResult.message = `Патч применён, но обнаружены синтаксические ошибки. Рекомендуется вызвать undo_edit или исправить ошибки.`;
      }
    }
    
    // Обновляем граф зависимостей если патч успешен
    if (patchResult.ok && depsService.isAnalyzable(path)) {
      // Читаем обновлённое содержимое файла
      const updatedContent = await sessionService.executeCommand(chatId, `cat "${path}"`, 10);
      if (updatedContent.exitCode === 0 && updatedContent.stdout) {
        // Обновляем граф в фоне (не блокируем ответ)
        depsService.updateFileDeps(sessionService, chatId, path, updatedContent.stdout).catch(e => {
          console.warn(`[PATCH_FILE] Failed to update deps graph: ${e.message}`);
        });
      }
    }
    
    return patchResult;
  } catch (e) {
    return { ok: false, error: "Ошибка парсинга ответа от Python скрипта", stdout: result.stdout, stderr: result.stderr };
  }
}

async function handleUndoEdit(chatId, { path, steps = 1 }) {
  // Используем персистентный сервис снапшотов
  const result = await snapshotService.restoreSnapshot(chatId, path, steps);
  
  if (!result.ok) {
    return result;
  }
  
  return { 
    ok: true, 
    message: result.message,
    snapshot: result.snapshot
  };
}

/**
 * Получает список доступных снапшотов для файла
 */
async function handleListSnapshots(chatId, { path }) {
  const snapshots = await snapshotService.listSnapshots(chatId, path);
  
  if (snapshots.length === 0) {
    return { 
      ok: true, 
      snapshots: [],
      message: 'Снапшоты не найдены для этого файла' 
    };
  }
  
  return {
    ok: true,
    snapshots: snapshots.map((s, index) => ({
      step: index + 1,
      timestamp: s.timestamp,
      date: s.date,
      size: s.size
    })),
    message: `Найдено ${snapshots.length} версий. Используйте undo_edit(path, steps=N) для отката на N шагов назад.`
  };
}

async function handleDeleteWithConfirm(chatId, path, agentCtx) {
  if (agentCtx && agentCtx.confirm) {
    const confirmed = await agentCtx.confirm(`Удалить файл ${path}? Это действие необратимо.`);
    if (confirmed !== true) return { ok: false, message: 'Удаление отменено пользователем' };
  }
  const result = await sessionService.executeCommand(chatId, `rm -f "${path}"`, 10);
  if (result.exitCode === 0) {
      return { ok: true, message: `Файл ${path} удален` };
  } else {
      return { ok: false, error: `Ошибка удаления: ${result.stderr}` };
  }
}

/**
 * Создаёт scaffold Python-модуля
 */
async function handleCreatePythonModule(chatId, { name, type, description }, agentCtx) {
  const safeName = name.replace(/[^a-z0-9_]/g, '').toLowerCase();
  const moduleDir = `/workspace/modules/${safeName}`;
  const packageDir = `${moduleDir}/${safeName}`;
  const testsDir = `${moduleDir}/tests`;

  // Шаблоны по типу модуля
  const templates = {
    api_client: {
      mainFile: 'client.py',
      mainContent: `"""
${description}
"""
import os
import requests
from dotenv import load_dotenv

load_dotenv()

class ${safeName.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('')}Client:
    """API клиент для ${description}"""
    
    def __init__(self, base_url=None, api_token=None):
        self.base_url = base_url or os.getenv('API_BASE_URL', 'https://api.example.com')
        self.api_token = api_token or os.getenv('API_TOKEN')
        self.session = requests.Session()
        if self.api_token:
            self.session.headers.update({'Authorization': f'Bearer {self.api_token}'})
    
    def get(self, endpoint, params=None):
        """GET запрос"""
        response = self.session.get(f'{self.base_url}{endpoint}', params=params)
        response.raise_for_status()
        return response.json()
    
    def post(self, endpoint, data=None):
        """POST запрос"""
        response = self.session.post(f'{self.base_url}{endpoint}', json=data)
        response.raise_for_status()
        return response.json()
    
    def put(self, endpoint, data=None):
        """PUT запрос"""
        response = self.session.put(f'{self.base_url}{endpoint}', json=data)
        response.raise_for_status()
        return response.json()
    
    def delete(self, endpoint):
        """DELETE запрос"""
        response = self.session.delete(f'{self.base_url}{endpoint}')
        response.raise_for_status()
        return response.status_code == 204
`,
      requirements: ['requests', 'python-dotenv'],
      envExample: 'API_BASE_URL=https://api.example.com\nAPI_TOKEN=your_token_here'
    },
    
    data_processor: {
      mainFile: 'processor.py',
      mainContent: `"""
${description}
"""
import pandas as pd
from typing import List, Dict, Any

class DataProcessor:
    """Обработчик данных для ${description}"""
    
    def __init__(self):
        self.data = None
    
    def load(self, source: str) -> pd.DataFrame:
        """Загрузка данных из файла"""
        if source.endswith('.csv'):
            self.data = pd.read_csv(source)
        elif source.endswith('.xlsx'):
            self.data = pd.read_excel(source)
        elif source.endswith('.json'):
            self.data = pd.read_json(source)
        else:
            raise ValueError(f"Неподдерживаемый формат: {source}")
        return self.data
    
    def process(self, operations: List[Dict[str, Any]]) -> pd.DataFrame:
        """Применение операций к данным"""
        if self.data is None:
            raise ValueError("Данные не загружены. Сначала вызовите load()")
        
        for op in operations:
            op_type = op.get('type')
            if op_type == 'filter':
                self.data = self.data.query(op['query'])
            elif op_type == 'select':
                self.data = self.data[op['columns']]
            elif op_type == 'groupby':
                self.data = self.data.groupby(op['by']).agg(op['agg'])
        
        return self.data
    
    def export(self, output_path: str, format: str = 'csv') -> str:
        """Экспорт данных в файл"""
        if self.data is None:
            raise ValueError("Данные не загружены")
        
        if format == 'csv':
            self.data.to_csv(output_path, index=False)
        elif format == 'xlsx':
            self.data.to_excel(output_path, index=False)
        elif format == 'json':
            self.data.to_json(output_path, orient='records')
        
        return output_path
`,
      requirements: ['pandas', 'openpyxl', 'python-dotenv'],
      envExample: ''
    },
    
    bot: {
      mainFile: 'bot.py',
      mainContent: `"""
${description}
"""
import os
import logging
from telegram import Update
from telegram.ext import Application, CommandHandler, MessageHandler, filters, ContextTypes
from dotenv import load_dotenv

load_dotenv()

logging.basicConfig(
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    level=logging.INFO
)
logger = logging.getLogger(__name__)

BOT_TOKEN = os.getenv('BOT_TOKEN')

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Обработчик команды /start"""
    await update.message.reply_text(
        f'Привет! Я бот для ${description}.\\n'
        'Доступные команды:\\n'
        '/start - начать работу\\n'
        '/help - справка'
    )

async def help_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Обработчик команды /help"""
    await update.message.reply_text('Справка по использованию бота...')

async def echo(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Обработчик текстовых сообщений"""
    await update.message.reply_text(update.message.text)

def main():
    """Запуск бота"""
    if not BOT_TOKEN:
        raise ValueError("BOT_TOKEN не указан в .env")
    
    application = Application.builder().token(BOT_TOKEN).build()
    
    application.add_handler(CommandHandler("start", start))
    application.add_handler(CommandHandler("help", help_command))
    application.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, echo))
    
    application.run_polling(allowed_updates=Update.ALL_TYPES)

if __name__ == '__main__':
    main()
`,
      requirements: ['python-telegram-bot', 'python-dotenv'],
      envExample: 'BOT_TOKEN=your_bot_token_here'
    },
    
    cli: {
      mainFile: 'cli.py',
      mainContent: `"""
${description}
"""
import argparse
import sys

def main():
    parser = argparse.ArgumentParser(description='${description}')
    parser.add_argument('command', choices=['run', 'status', 'config'], help='Команда для выполнения')
    parser.add_argument('--input', '-i', help='Входной файл')
    parser.add_argument('--output', '-o', help='Выходной файл')
    parser.add_argument('--verbose', '-v', action='store_true', help='Подробный вывод')
    
    args = parser.parse_args()
    
    if args.verbose:
        print(f"Выполняю команду: {args.command}")
    
    if args.command == 'run':
        print("Выполнение основной задачи...")
        # TODO: реализовать логику
    elif args.command == 'status':
        print("Статус: OK")
    elif args.command == 'config':
        print("Конфигурация: ...")

if __name__ == '__main__':
    main()
`,
      requirements: ['click'],
      envExample: ''
    },
    
    library: {
      mainFile: '__init__.py',
      mainContent: `"""
${description}
"""

__version__ = '0.1.0'

# TODO: добавить основную логику библиотеки
`,
      requirements: [],
      envExample: ''
    },
    
    custom: {
      mainFile: 'main.py',
      mainContent: `"""
${description}
"""

def main():
    """Точка входа"""
    print("Hello from ${safeName}!")
    # TODO: реализовать логику

if __name__ == '__main__':
    main()
`,
      requirements: [],
      envExample: ''
    }
  };

  const template = templates[type] || templates.custom;
  const className = safeName.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('');

  // Скрипт создания структуры
  const creationScript = `
set -e

# Создаём директории
mkdir -p "${packageDir}"
mkdir -p "${testsDir}"

# __init__.py для пакета
cat > "${packageDir}/__init__.py" << 'EOF'
"""
${description}
"""
from .${template.mainFile.replace('.py', '')} import *

__version__ = '0.1.0'
EOF

# Основной файл модуля
cat > "${packageDir}/${template.mainFile}" << 'EOF_MAIN'
${template.mainContent}
EOF_MAIN

# tests/__init__.py
touch "${testsDir}/__init__.py"

# tests/test_${safeName}.py
cat > "${testsDir}/test_${safeName}.py" << 'EOF_TEST'
"""
Тесты для ${safeName}
"""
import pytest

def test_placeholder():
    """Заглушка теста"""
    assert True

# TODO: добавить реальные тесты
EOF_TEST

# requirements.txt
cat > "${moduleDir}/requirements.txt" << 'EOF_REQ'
${template.requirements.join('\n')}
EOF_REQ

# README.md
cat > "${moduleDir}/README.md" << 'EOF_README'
# ${safeName}

${description}

## Установка

\`\`\`bash
pip install -r requirements.txt
\`\`\`

## Использование

\`\`\`python
from ${safeName} import *

# TODO: пример использования
\`\`\`

## Тесты

\`\`\`bash
pytest tests/
\`\`\`
EOF_README

# .env.example (если есть)
${template.envExample ? `cat > "${moduleDir}/.env.example" << 'EOF_ENV'
${template.envExample}
EOF_ENV` : '# .env не требуется'}
`;

  const result = await sessionService.executeCommand(chatId, creationScript, 30);

  const filesCreated = [
    `${packageDir}/__init__.py`,
    `${packageDir}/${template.mainFile}`,
    `${testsDir}/__init__.py`,
    `${testsDir}/test_${safeName}.py`,
    `${moduleDir}/requirements.txt`,
    `${moduleDir}/README.md`
  ];

  if (template.envExample) {
    filesCreated.push(`${moduleDir}/.env.example`);
  }

  // Регистрируем модуль в store
  manageStore.addModule(chatId, {
    name: safeName,
    type,
    description,
    path: moduleDir,
    createdAt: Date.now()
  });

  if (result.exitCode === 0) {
    return {
      ok: true,
      module_name: safeName,
      module_dir: moduleDir,
      files_created: filesCreated,
      next_steps: `Дополни ${packageDir}/${template.mainFile} реальной логикой. Установи зависимости: install_packages(${JSON.stringify(template.requirements)}). Запусти тесты: run_tests('tests/').`
    };
  } else {
    return {
      ok: false,
      error: `Ошибка создания модуля: ${result.stderr}`,
      stdout: result.stdout,
      stderr: result.stderr
    };
  }
}

/**
 * Устанавливает пакеты через pip или npm
 */
async function handleInstallPackages(chatId, { packages, manager = 'auto', cwd = '/workspace', save = true }) {
  if (!packages || packages.length === 0) {
    return { ok: false, error: 'Список пакетов пуст' };
  }

  const startTime = Date.now();

  // Определяем менеджер пакетов
  let detectedManager = manager;
  if (manager === 'auto') {
    const packageJsonCheck = await sessionService.executeCommand(chatId, `test -f "${cwd}/package.json" && echo "npm" || echo "pip"`, 5);
    detectedManager = packageJsonCheck.stdout.trim() === 'npm' ? 'npm' : 'pip';
  }

  let command;
  let timeout = 120;

  if (detectedManager === 'pip') {
    // pip с флагом --break-system-packages для контейнеров без venv
    command = `pip install ${packages.join(' ')} --break-system-packages -q 2>&1`;
  } else if (detectedManager === 'npm') {
    const saveFlag = save ? '--save' : '--no-save';
    command = `cd "${cwd}" && npm install ${packages.join(' ')} ${saveFlag} 2>&1`;
  } else if (detectedManager === 'npm-global') {
    command = `npm install -g ${packages.join(' ')} 2>&1`;
  } else {
    return { ok: false, error: `Неизвестный менеджер пакетов: ${detectedManager}` };
  }

  const result = await sessionService.executeCommand(chatId, command, timeout);
  const output = result.stdout + '\n' + result.stderr;
  const elapsed_sec = (Date.now() - startTime) / 1000;

  // Парсим результат
  const installed = [];
  const alreadyInstalled = [];
  const failed = [];

  if (detectedManager === 'pip') {
    // Парсинг вывода pip
    const successMatch = output.match(/Successfully installed ([^\n]+)/);
    if (successMatch) {
      const pkgs = successMatch[1].split(' ').map(p => p.trim());
      installed.push(...pkgs);
    }

    const alreadyMatch = output.match(/Requirement already satisfied: ([^\n]+)/g);
    if (alreadyMatch) {
      alreadyMatch.forEach(m => {
        const pkg = m.replace('Requirement already satisfied: ', '').split(' ')[0];
        alreadyInstalled.push(pkg);
      });
    }

    const errorMatch = output.match(/ERROR: ([^\n]+)/g);
    if (errorMatch) {
      errorMatch.forEach(m => {
        const errorMsg = m.replace('ERROR: ', '');
        // Пытаемся извлечь имя пакета
        const pkgMatch = errorMsg.match(/No matching distribution found for ([^\s]+)/);
        if (pkgMatch) {
          failed.push({ package: pkgMatch[1], error: errorMsg });
        } else {
          failed.push({ package: 'unknown', error: errorMsg });
        }
      });
    }
  } else if (detectedManager === 'npm' || detectedManager === 'npm-global') {
    // Парсинг вывода npm
    if (result.exitCode === 0) {
      // npm обычно пишет список добавленных пакетов
      const addedMatch = output.match(/added (\d+) packages/);
      if (addedMatch) {
        installed.push(`${addedMatch[1]} packages`);
      }
    } else {
      // Ошибки npm
      const errMatch = output.match(/npm ERR! ([^\n]+)/g);
      if (errMatch) {
        failed.push({ package: 'npm', error: errMatch.map(m => m.replace('npm ERR! ', '')).join('; ') });
      }
    }
  }

  const hasErrors = failed.length > 0 || result.exitCode !== 0;

  return {
    ok: !hasErrors,
    manager: detectedManager,
    installed,
    already_installed: alreadyInstalled,
    failed,
    duration_sec: elapsed_sec,
    ...(hasErrors && { error: 'Некоторые пакеты не установлены', stdout_tail: output.slice(-500) })
  };
}

async function dispatchTool(chatId, toolName, toolArgs, pendingFiles, agentCtx, workflowState = {}) {
  switch (toolName) {
    case 'request_context': {
      // Фаза исследования: дерево проекта + содержимое запрошенных файлов за один вызов.
      // Агент декларирует что ему нужно и зачем — принуждает думать до чтения.
      const { files = [], reason = '', need_more = false, _cachedProjectTree = null } = toolArgs;

      // 1. Дерево проекта — берём из кэша если уже запрашивали (экономим ~200 строк токенов).
      //    _cachedProjectTree передаётся из executeAgentLoop через toolArgs при повторных вызовах.
      let tree;
      if (_cachedProjectTree) {
        tree = _cachedProjectTree;
      } else {
        const treeResult = await sessionService.executeCommand(
          chatId,
          `find /workspace -not -path '*/node_modules/*' -not -path '*/.git/*' -not -name '*.pyc' | sort | head -200`,
          10
        );
        tree = treeResult.stdout || '(пусто)';
      }

      // 2. Читаем каждый запрошенный файл (не более 7, каждый обрезаем до 3000 символов)
      const fileContents = [];
      const filesToRead = files.slice(0, 7);
      for (const filePath of filesToRead) {
        const r = await sessionService.executeCommand(chatId, `cat "${filePath}" 2>/dev/null || echo "[файл не найден: ${filePath}]"`, 10);
        const content = (r.stdout || '').slice(0, 3000);
        fileContents.push(`\n--- FILE: ${filePath} ---\n${content}\n--- END FILE ---`);
      }

      const result = {
        ok: true,
        // При повторном вызове (need_more=true → false) дерево уже есть в контексте —
        // заменяем на маркер, чтобы не дублировать ~200 строк в каждом tool-result.
        project_tree: _cachedProjectTree
          ? '[дерево проекта уже загружено в предыдущем вызове — используй его]'
          : tree,
        files_read: filesToRead,
        file_contents: fileContents.join('\n'),
        need_more,
        next_step: need_more
          ? 'Прочитай ещё нужные файлы через request_context(need_more: false) когда будешь готов к планированию.'
          : 'Контекст собран. Следующий шаг — create_plan.'
      };

      return result;
    }

    case 'read_file':
      return await sessionService.executeCommand(chatId, `cat "${toolArgs.path}"`, 10);

    case 'list_dir': {
      const p = toolArgs.path || '/workspace';
      return await sessionService.executeCommand(chatId, `ls -la "${p}"`, 10);
    }

    case 'exec_command': {
      const cwd = toolArgs.cwd || '/workspace';
      const cmd = `cd "${cwd}" && ${toolArgs.command}`;
      return await sessionService.executeCommand(
        chatId, cmd, toolArgs.timeout || 30
      );
    }

    case 'patch_file':
      return await handlePatchFile(chatId, toolArgs, workflowState);

    case 'write_file': {
      // === WORKFLOW VALIDATION ===
      // Проверяем, был ли create_plan в этой сессии
      if (!workflowState.planCreated) {
        return { 
          ok: false, 
          error: "Нарушен workflow: сначала вызови create_plan с описанием изменений.",
          requires_plan: true,
          hint: "write_file можно использовать только после create_plan. Это защита от случайных изменений."
        };
      }
      
      // Сохраняем снапшот для undo_edit если файл уже существует
      const existingFile = await sessionService.executeCommand(chatId, `cat "${toolArgs.path}" 2>/dev/null`, 10);
      if (existingFile.exitCode === 0 && existingFile.stdout) {
        await snapshotService.saveSnapshot(chatId, toolArgs.path, existingFile.stdout);
      }
      
      const script = `
import os, json
path = ${JSON.stringify(toolArgs.path)}
content = ${JSON.stringify(toolArgs.content)}
try:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    open(path, 'w', encoding='utf-8').write(content)
    print(json.dumps({"ok": True, "message": f"Файл {path} успешно записан"}))
except Exception as e:
    print(json.dumps({"ok": False, "error": str(e)}))
`.trim();
      const result = await sessionService.executeCommand(chatId, `python3 -c ${JSON.stringify(script)}`, 10);
      try {
          const writeResult = JSON.parse(result.stdout);
          
          // === AUTOMATIC LINT AFTER WRITE ===
          if (writeResult.ok) {
            const lintResult = await runLinter(chatId, toolArgs.path);
            writeResult.lint = lintResult;
            
            if (!lintResult.ok && !lintResult.skipped) {
              writeResult.requires_review = true;
              writeResult.message = `Файл записан, но обнаружены синтаксические ошибки. Рекомендуется исправить.`;
            }
          }
          
          // Обновляем граф зависимостей если запись успешна
          if (writeResult.ok && depsService.isAnalyzable(toolArgs.path)) {
            // Обновляем граф в фоне (не блокируем ответ)
            depsService.updateFileDeps(sessionService, chatId, toolArgs.path, toolArgs.content).catch(e => {
              console.warn(`[WRITE_FILE] Failed to update deps graph: ${e.message}`);
            });
          }
          
          return writeResult;
      } catch (e) {
          return { ok: false, error: "Ошибка парсинга ответа от Python скрипта", stdout: result.stdout, stderr: result.stderr };
      }
    }

    case 'undo_edit':
      return await handleUndoEdit(chatId, toolArgs);

    case 'list_snapshots':
      return await handleListSnapshots(chatId, toolArgs);

    case 'create_folder':
      return await sessionService.executeCommand(chatId, `mkdir -p "${toolArgs.path}"`, 10);

    case 'delete_file':
      return await handleDeleteWithConfirm(chatId, toolArgs.path, agentCtx);

    case 'send_file':
      // Помечаем файл для отправки, реальная отправка после завершения loop
      pendingFiles.push(toolArgs.path);
      return { ok: true, message: `Файл ${toolArgs.path} будет отправлен после завершения задачи` };

    case 'create_nodejs_app':
      return await handleCreateNodejsApp(chatId, toolArgs, agentCtx);

    case 'list_nodejs_apps':
      return await sessionService.executeCommand(chatId, 'pm2 list | grep app- || echo "Приложений пока нет"', 10);

    case 'start_nodejs_app':
      return await sessionService.executeCommand(chatId, `pm2 start app-${toolArgs.name}`, 10);

    case 'stop_nodejs_app':
      return await sessionService.executeCommand(chatId, `pm2 stop app-${toolArgs.name}`, 10);

    case 'get_app_logs':
      return await sessionService.executeCommand(chatId, `pm2 logs app-${toolArgs.name} --lines 30 --nostream`, 10);

    case 'schedule_cron': {
      const { cron_expression, prompt } = toolArgs;
      const data = manageStore.getState(chatId);
      if (!data || !data.aiAuthToken) {
        return { ok: false, error: "AI не настроен, невозможно запланировать задачу." };
      }
      
      // Формируем curl-запрос на внутренний webhook
      const webhookUrl = `https://claw.pro-talk.ru/${chatId}/internal_cron`;
      
      // Экранируем prompt для JSON
      const safePrompt = prompt.replace(/"/g, '\\"').replace(/\n/g, '\\n');
      
      // Создаем скрипт, который будет выполняться по cron
      const scriptName = `/workspace/cron_${Date.now()}.sh`;
      const scriptContent = `#!/bin/bash
curl -X POST "${webhookUrl}" \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer ${data.aiAuthToken}" \\
  -d '{"prompt": "${safePrompt}"}'
`;
      
      // Записываем скрипт, делаем исполняемым и добавляем в crontab
      const setupCmd = `
cat > ${scriptName} << 'EOF'
${scriptContent}
EOF
chmod +x ${scriptName}
(crontab -l 2>/dev/null; echo "${cron_expression} ${scriptName} >> /workspace/cron.log 2>&1") | crontab -
service cron start || true
`;
      
      const result = await sessionService.executeCommand(chatId, setupCmd, 10);
      if (result.exitCode === 0) {
        return { ok: true, message: `Задача успешно запланирована: ${cron_expression}` };
      } else {
        return { ok: false, error: `Ошибка при настройке cron: ${result.stderr}` };
      }
    }

    case 'analyze_deps': {
      try {
        const projectRoot = toolArgs.path || '/workspace';
        const graph = await depsService.buildDepsGraph(sessionService, chatId, projectRoot);
        const formatted = depsService.formatDepsForAgent(graph);
        
        return {
          ok: true,
          graph_summary: formatted,
          files_analyzed: Object.keys(graph.files).length,
          graph_path: `${projectRoot}/.project/deps.json`,
          message: `Граф зависимостей построен и сохранён в ${projectRoot}/.project/deps.json`
        };
      } catch (e) {
        return { ok: false, error: `Ошибка анализа зависимостей: ${e.message}` };
      }
    }

    case 'invalidate_project_cache': {
      try {
        const { rebuild = false } = toolArgs;
        
        if (rebuild) {
          // Немедленно перестраиваем кэш
          const cache = await projectCacheService.buildProjectCache(chatId, { forceRebuild: true });
          return {
            ok: true,
            message: 'Кэш проекта перестроен',
            stats: cache.stats
          };
        } else {
          // Только удаляем кэш
          const deleted = await projectCacheService.invalidateCache(chatId);
          return {
            ok: deleted,
            message: deleted 
              ? 'Кэш проекта удалён. Будет перестроен при следующем request_context.'
              : 'Не удалось удалить кэш (возможно, его не было)'
          };
        }
      } catch (e) {
        return { ok: false, error: `Ошибка инвалидации кэша: ${e.message}` };
      }
    }

    case 'create_plan': {
      if (agentCtx && agentCtx.setSteps) {
        await agentCtx.setSteps(toolArgs.steps);
      }
      
      // Анализируем зависимости и добавляем смежные файлы
      let adjacentFiles = [];
      let depsDetails = {};
      
      if (toolArgs.affectedFiles && toolArgs.affectedFiles.length > 0) {
        try {
          // Загружаем граф зависимостей (из кэша или файла)
          const graph = await depsService.loadDepsGraph(sessionService, chatId);
          
          if (graph) {
            const adjacentResult = depsService.getAdjacentFiles(graph, toolArgs.affectedFiles);
            adjacentFiles = adjacentResult.adjacent;
            depsDetails = adjacentResult.details;
          }
        } catch (e) {
          console.warn(`[CREATE_PLAN] Failed to analyze deps: ${e.message}`);
        }
      }
      
      // === АВТОМАТИЧЕСКОЕ ОБНАРУЖЕНИЕ ТЕСТОВ ===
      // Проверяем, есть ли тесты для затрагиваемых файлов
      let testFiles = [];
      if (toolArgs.affectedFiles && toolArgs.affectedFiles.length > 0) {
        for (const file of toolArgs.affectedFiles) {
          const basename = file.split('/').pop();
          const dir = file.substring(0, file.lastIndexOf('/'));
          
          // Python: test_*.py или *_test.py
          const pythonTestPatterns = [
            `${dir}/test_${basename.replace('.py', '')}.py`,
            `${dir}/${basename.replace('.py', '')}_test.py`,
            `${dir}/tests/test_${basename.replace('.py', '')}.py`
          ];
          
          // JavaScript: *.test.js или *.spec.js
          const jsTestPatterns = [
            file.replace('.js', '.test.js'),
            file.replace('.js', '.spec.js'),
            `${dir}/__tests__/${basename.replace('.js', '.test.js')}`
          ];
          
          const allPatterns = [...pythonTestPatterns, ...jsTestPatterns];
          
          for (const testPath of allPatterns) {
            const checkResult = await sessionService.executeCommand(chatId, `test -f "${testPath}" && echo "EXISTS" || echo "NOT_FOUND"`, 5);
            if (checkResult.stdout && checkResult.stdout.includes('EXISTS')) {
              testFiles.push(testPath);
            }
          }
        }
      }
      
      // Если найдены тесты — добавляем шаг в план
      let steps = toolArgs.steps || [];
      if (testFiles.length > 0) {
        const testStep = `Запустить тесты: run_tests() для файлов ${testFiles.map(f => f.split('/').pop()).join(', ')}`;
        // Добавляем шаг тестов перед финальным шагом (если он есть)
        if (steps.length > 0 && !steps.some(s => s.toLowerCase().includes('тест') || s.toLowerCase().includes('test'))) {
          steps = [...steps.slice(0, -1), testStep, steps[steps.length - 1]];
        }
      }
      
      return { 
        ok: true, 
        plan: steps, 
        affectedFiles: toolArgs.affectedFiles,
        adjacentFiles,
        depsDetails,
        testFiles,
        message: adjacentFiles.length > 0 
          ? `План создан. Внимание: изменения затронут ${adjacentFiles.length} смежных файлов.`
          : 'План создан.'
      };
    }

    case 'create_task_plan': {
      try {
        const planId = await planService.createPlan(chatId, toolArgs.goal, toolArgs.steps);
        // Показываем шаги плана в прогресс-блоке Telegram
        if (agentCtx && agentCtx.setSteps && Array.isArray(toolArgs.steps)) {
          await agentCtx.setSteps(toolArgs.steps);
        }
        return { ok: true, plan_id: planId, message: `План успешно создан. ID: ${planId}` };
      } catch (e) {
        return { ok: false, error: `Ошибка создания плана: ${e.message}` };
      }
    }

    case 'read_plan': {
      try {
        const content = await planService.readPlan(chatId, toolArgs.plan_id);
        return { ok: true, content };
      } catch (e) {
        return { ok: false, error: `Ошибка чтения плана: ${e.message}` };
      }
    }

    case 'update_step_status': {
      try {
        const content = await planService.updateStepStatus(chatId, toolArgs.plan_id, toolArgs.step_index, toolArgs.status, toolArgs.notes);
        return { ok: true, message: `Статус шага ${toolArgs.step_index} обновлен на ${toolArgs.status}`, current_plan: content };
      } catch (e) {
        return { ok: false, error: `Ошибка обновления статуса: ${e.message}` };
      }
    }

    case 'add_substep': {
      try {
        const content = await planService.addSubstep(chatId, toolArgs.plan_id, toolArgs.parent_step_index, toolArgs.description);
        return { ok: true, message: `Подшаг добавлен к шагу ${toolArgs.parent_step_index}`, current_plan: content };
      } catch (e) {
        return { ok: false, error: `Ошибка добавления подшага: ${e.message}` };
      }
    }

    case 'list_active_plans': {
      try {
        const plans = await planService.listActivePlans(chatId);
        return { ok: true, plans };
      } catch (e) {
        return { ok: false, error: `Ошибка получения списка планов: ${e.message}` };
      }
    }

    case 'http_request':
      return await handleHttpRequest(chatId, toolArgs);

    case 'run_tests':
      return await handleRunTests(chatId, toolArgs);

    case 'create_python_module':
      return await handleCreatePythonModule(chatId, toolArgs, agentCtx);

    case 'install_packages':
      return await handleInstallPackages(chatId, toolArgs);

    default:
      return { error: `Неизвестный инструмент: ${toolName}` };
  }
}

module.exports = {
  dispatchTool,
  handlePatchFile,
  handleUndoEdit,
  handleListSnapshots,
  runLinter
};
