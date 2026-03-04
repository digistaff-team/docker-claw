// --- CHAT ---
const TOOL_READ_FILE = {
  name: "read_file",
  description: "Прочитать содержимое файла в /workspace",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Полный путь к файлу" }
    },
    required: ["path"]
  }
};

const TOOL_LIST_DIR = {
  name: "list_dir",
  description: "Получить список файлов и папок в директории",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Путь к директории (по умолчанию /workspace)" }
    },
    required: []
  }
};

// --- WORKSPACE ---

/**
 * request_context — фаза исследования перед планированием.
 *
 * Агент декларирует: какие файлы ему нужны и зачем.
 * Инструмент возвращает дерево проекта + содержимое всех запрошенных файлов за один вызов.
 * Это заменяет N отдельных read_file и принуждает модель сначала думать, потом читать.
 *
 * Поле need_more — явный сигнал петли понимания:
 *   true  → агент ещё не готов к планированию, нужно ещё читать
 *   false → контекста достаточно, следующий шаг — create_plan
 */
const TOOL_REQUEST_CONTEXT = {
  name: "request_context",
  description: [
    "ШАГ 1 (ОБЯЗАТЕЛЕН ПЕРВЫМ при работе с существующим проектом).",
    "Получить дерево проекта и прочитать нужные файлы за один вызов.",
    "Используй ВМЕСТО отдельных list_dir + read_file × N.",
    "Укажи только файлы, реально нужные для задачи — не читай всё подряд.",
    "После вызова реши: need_more=true если нужно ещё читать, need_more=false если готов к create_plan.",
    "НЕЛЬЗЯ вызывать patch_file или write_file до create_plan.",
  ].join(" "),
  parameters: {
    type: "object",
    properties: {
      files: {
        type: "array",
        items: { type: "string" },
        description: "Список путей к файлам для чтения (только нужные для задачи, не более 7)"
      },
      reason: {
        type: "string",
        description: "Зачем нужны эти файлы — одно предложение"
      },
      need_more: {
        type: "boolean",
        description: "true — нужно ещё читать файлы; false — контекста достаточно, перехожу к create_plan"
      }
    },
    required: ["files", "reason", "need_more"]
  }
};

const TOOL_CREATE_PLAN = {
  name: "create_plan",
  description: "Создать план действий перед внесением изменений. ОБЯЗАТЕЛЕН перед write_file и patch_file.",
  parameters: {
    type: "object",
    properties: {
      steps:         { type: "array", items: { type: "string" }, description: "Список шагов" },
      affectedFiles: { type: "array", items: { type: "string" }, description: "Файлы которые будут изменены или созданы" }
    },
    required: ["steps", "affectedFiles"]
  }
};

const TOOL_PATCH_FILE = {
  name: "patch_file",
  description: "Точечно изменить часть файла. ПРИОРИТЕТНЫЙ инструмент для правок. Использует поиск и замену текстового блока.",
  parameters: {
    type: "object",
    properties: {
      path:        { type: "string", description: "Путь к файлу" },
      search_str:  { type: "string", description: "Точный фрагмент который нужно найти (включая отступы)" },
      replace_str: { type: "string", description: "Новый код/текст который заменит найденный фрагмент" }
    },
    required: ["path", "search_str", "replace_str"]
  }
};

const TOOL_WRITE_FILE = {
  name: "write_file",
  description: "Создать НОВЫЙ файл или полностью перезаписать существующий. Используй только для новых файлов.",
  parameters: {
    type: "object",
    properties: {
      path:    { type: "string", description: "Полный путь к файлу" },
      content: { type: "string", description: "Полное содержимое файла" }
    },
    required: ["path", "content"]
  }
};

const TOOL_UNDO_EDIT = {
  name: "undo_edit",
  description: "Отменить последнее изменение файла. Восстанавливает снапшот до последнего patch_file или write_file. По умолчанию откатывает на 1 шаг, но можно указать steps=N для отката на N версий назад.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Путь к файлу для отката" },
      steps: { type: "number", description: "На сколько шагов назад откатиться (по умолчанию 1)" }
    },
    required: ["path"]
  }
};

const TOOL_LIST_SNAPSHOTS = {
  name: "list_snapshots",
  description: "Показать список доступных версий файла с временными метками. Используй перед undo_edit чтобы узнать, на сколько шагов можно откатиться.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Путь к файлу" }
    },
    required: ["path"]
  }
};

const TOOL_CREATE_FOLDER = {
  name: "create_folder",
  description: "Создать новую папку в /workspace",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Путь к новой папке" }
    },
    required: ["path"]
  }
};

const TOOL_DELETE_FILE = {
  name: "delete_file",
  description: "Удалить файл из /workspace. ОПАСНОЕ ДЕЙСТВИЕ — требует подтверждения пользователя.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Путь к файлу" }
    },
    required: ["path"]
  }
};

const TOOL_SEND_FILE = {
  name: "send_file",
  description: "Отправить файл пользователю в Telegram",
  parameters: {
    type: "object",
    properties: {
      path:    { type: "string", description: "Путь к файлу в /workspace" },
      caption: { type: "string", description: "Подпись к файлу (опционально)" }
    },
    required: ["path"]
  }
};

// --- NODE.JS INTERACTIVE APPS ---
const TOOL_CREATE_NODEJS_APP = {
  name: "create_nodejs_app",
  description: [
    "Создать ЗАГОТОВКУ (scaffold) Node.js/Express приложения и запустить её через PM2.",
    "ВАЖНО: инструмент создаёт только минимальный шаблон — заглушку с /api/ping.",
    "После вызова ОБЯЗАТЕЛЬНО нужно доработать файлы приложения через patch_file/write_file:",
    "  - /workspace/apps/{name}/app.js — серверная логика (маршруты, WebSocket, БД и т.д.)",
    "  - /workspace/apps/{name}/public/index.html — полноценный UI под конкретный тип.",
    "Для type='chat': реализуй чат-интерфейс с историей сообщений и polling или WebSocket.",
    "Для type='todo': реализуй список задач с добавлением/удалением/отметкой выполнения.",
    "Для type='dashboard': реализуй дашборд с графиками/таблицами и данными.",
    "После доработки файлов перезапусти приложение: exec_command 'pm2 restart app-{name}'.",
    "Пути в fetch() ВСЕГДА без ведущего слэша: fetch('api/data'), НЕ fetch('/api/data')."
  ].join(" "),
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Имя приложения (только a-z0-9-_)" },
      type: { type: "string", enum: ["chat", "todo", "dashboard", "api", "custom"], description: "Тип приложения" },
      description: { type: "string", description: "Что должно уметь приложение" }
    },
    required: ["name", "type", "description"]
  }
};

const TOOL_LIST_APPS = {
  name: "list_nodejs_apps",
  description: "Список всех созданных Node.js приложений с ссылками"
};

const TOOL_START_APP = {
  name: "start_nodejs_app",
  description: "Запустить/перезапустить приложение",
  parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] }
};

const TOOL_STOP_APP = {
  name: "stop_nodejs_app",
  description: "Остановить приложение",
  parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] }
};

const TOOL_GET_APP_LOGS = {
  name: "get_app_logs",
  description: "Последние 30 строк логов приложения",
  parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] }
};

// --- TERMINAL ---
const TOOL_EXEC_COMMAND = {
  name: "exec_command",
  description: "Выполнить bash-команду в Docker-контейнере (npm, pip, git, ls, python, и т.д.)",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "Команда для выполнения" },
      cwd:     { type: "string", description: "Рабочая директория (по умолчанию /workspace)" },
      timeout: { type: "number", description: "Таймаут в секундах (по умолчанию 30, максимум 120)" }
    },
    required: ["command"]
  }
};

const TOOL_HTTP_REQUEST = {
  name: "http_request",
  description: "Выполнить HTTP-запрос к внешнему API или локальному сервису. Возвращает статус, заголовки, тело ответа и время выполнения. Используй вместо curl через exec_command для тестирования API.",
  parameters: {
    type: "object",
    properties: {
      method:  { type: "string", enum: ["GET","POST","PUT","PATCH","DELETE","HEAD"], description: "HTTP-метод" },
      url:     { type: "string", description: "Полный URL запроса" },
      headers: { type: "object", description: "Заголовки запроса (ключ-значение)" },
      body:    { type: ["string","object"], description: "Тело запроса. Объект будет сериализован в JSON автоматически." },
      timeout: { type: "number", description: "Таймаут в секундах (по умолчанию 15, максимум 60)" },
      follow_redirects: { type: "boolean", description: "Следовать редиректам (по умолчанию true)" }
    },
    required: ["method", "url"]
  }
};

const TOOL_RUN_TESTS = {
  name: "run_tests",
  description: "Запустить тесты в контейнере и получить структурированный результат. Поддерживает pytest (Python) и Jest (Node.js). Используй после написания кода для верификации перед task_completed.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Путь к файлу или папке с тестами (относительно /workspace). По умолчанию — auto-detect."
      },
      framework: {
        type: "string",
        enum: ["pytest", "unittest", "jest", "auto"],
        description: "Фреймворк (auto — определить автоматически по наличию pytest/jest)"
      },
      timeout: {
        type: "number",
        description: "Максимальное время выполнения в секундах (по умолчанию 60)"
      }
    },
    required: []
  }
};

const TOOL_CREATE_PYTHON_MODULE = {
  name: "create_python_module",
  description: "Создать scaffold Python-модуля в /workspace/modules/{name}/. Создаёт структуру проекта, базовый модуль, requirements.txt и тестовый файл. После вызова дорабатывай логику через patch_file/write_file.",
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Имя модуля (только a-z0-9_). Будет именем папки и Python-пакета."
      },
      type: {
        type: "string",
        enum: ["api_client", "data_processor", "bot", "cli", "library", "custom"],
        description: "Тип модуля — определяет шаблон кода"
      },
      description: {
        type: "string",
        description: "Что делает модуль — используется в README и docstring"
      }
    },
    required: ["name", "type", "description"]
  }
};

const TOOL_INSTALL_PACKAGES = {
  name: "install_packages",
  description: "Установить пакеты в контейнере через pip или npm. Автоматически применяет нужные флаги. Возвращает статус установки по каждому пакету.",
  parameters: {
    type: "object",
    properties: {
      packages: {
        type: "array",
        items: { type: "string" },
        description: "Список пакетов для установки. Можно указывать версии: ['requests==2.31.0', 'flask']"
      },
      manager: {
        type: "string",
        enum: ["pip", "npm", "npm-global", "auto"],
        description: "Менеджер пакетов. auto — определить по контексту (наличие package.json)"
      },
      cwd: {
        type: "string",
        description: "Рабочая директория для npm install (по умолчанию /workspace)"
      },
      save: {
        type: "boolean",
        description: "Для npm: добавить в package.json как зависимость (--save). По умолчанию true."
      }
    },
    required: ["packages"]
  }
};

const TOOL_SCHEDULE_CRON = {
  name: "schedule_cron",
  description: "Запланировать задачу для самого себя (ИИ-агента) по расписанию cron. В указанное время система 'разбудит' тебя и передаст prompt.",
  parameters: {
    type: "object",
    properties: {
      cron_expression: { type: "string", description: "Расписание в формате cron (например, '0 9 * * *' для 9:00 каждый день)" },
      prompt: { type: "string", description: "Текстовая задача, которую ты должен будешь выполнить, когда сработает cron (например, 'Собери логи и отправь пользователю')" }
    },
    required: ["cron_expression", "prompt"]
  }
};

const TOOL_ANALYZE_DEPS = {
  name: "analyze_deps",
  description: [
    "Построить граф зависимостей проекта.",
    "Анализирует импорты/экспорты в JS/TS/Python файлах и строит двунаправленный граф:",
    "  - файл → [что импортирует]",
    "  - файл → [кто его импортирует]",
    "Граф сохраняется в /workspace/.project/deps.json.",
    "Используй перед create_plan чтобы понять, какие файлы затронут изменения.",
    "Результат содержит список файлов с наибольшим количеством зависимостей."
  ].join(" "),
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Путь к папке для анализа (по умолчанию /workspace)"
      }
    },
    required: []
  }
};

const TOOL_INVALIDATE_PROJECT_CACHE = {
  name: "invalidate_project_cache",
  description: [
    "Сбросить кэш структуры проекта.",
    "Используй после git pull, git checkout, npm install или других операций,",
    "которые меняют файлы без участия агента.",
    "Кэш автоматически перестроится при следующем request_context.",
    "Опционально можно указать rebuild=true для немедленного перестроения."
  ].join(" "),
  parameters: {
    type: "object",
    properties: {
      rebuild: {
        type: "boolean",
        description: "true — немедленно перестроить кэш; false — только удалить (по умолчанию false)"
      }
    },
    required: []
  }
};

// --- TASK & PLAN MANAGEMENT ---
const TOOL_CREATE_TASK_PLAN = {
  name: "create_task_plan",
  description: "Создать новый план для сложной/многошаговой задачи. Возвращает ID плана.",
  parameters: {
    type: "object",
    properties: {
      goal: { type: "string", description: "Главная цель задачи" },
      steps: { type: "array", items: { type: "string" }, description: "Список шагов для выполнения" }
    },
    required: ["goal", "steps"]
  }
};

const TOOL_READ_PLAN = {
  name: "read_plan",
  description: "Прочитать содержимое плана по его ID.",
  parameters: {
    type: "object",
    properties: {
      plan_id: { type: "string", description: "ID плана" }
    },
    required: ["plan_id"]
  }
};

const TOOL_UPDATE_STEP_STATUS = {
  name: "update_step_status",
  description: "Обновить статус шага в плане.",
  parameters: {
    type: "object",
    properties: {
      plan_id: { type: "string", description: "ID плана" },
      step_index: { type: "string", description: "Номер шага (например, '1' или '2.1')" },
      status: { type: "string", enum: ["IN_PROGRESS", "DONE", "FAILED"], description: "Новый статус шага" },
      notes: { type: "string", description: "Заметки, логи или описание ошибки (опционально)" }
    },
    required: ["plan_id", "step_index", "status"]
  }
};

const TOOL_ADD_SUBSTEP = {
  name: "add_substep",
  description: "Добавить подшаг к существующему шагу в плане (например, если возникла ошибка и нужен дополнительный шаг для исправления).",
  parameters: {
    type: "object",
    properties: {
      plan_id: { type: "string", description: "ID плана" },
      parent_step_index: { type: "string", description: "Номер родительского шага (например, '2')" },
      description: { type: "string", description: "Описание нового подшага" }
    },
    required: ["plan_id", "parent_step_index", "description"]
  }
};

const TOOL_LIST_ACTIVE_PLANS = {
  name: "list_active_plans",
  description: "Получить список всех активных планов пользователя.",
  parameters: {
    type: "object",
    properties: {},
    required: []
  }
};

// --- ОБЩИЙ ---
const TOOL_TASK_COMPLETED = {
  name: "task_completed",
  description: "Завершить задачу. Используй verified=true ТОЛЬКО после самопроверки.",
  parameters: {
    type: "object",
    properties: {
      summary:  { type: "string", description: "Краткий отчёт о выполненном (для логов)" },
      html_report: { type: "string", description: "Финальный красивый отчет для пользователя с использованием HTML-тегов (<b>, <i>, <code>, <pre>). БЕЗ технических терминов." },
      files:    { type: "array", items: { type: "string" }, description: "Пути к файлам для отправки в Telegram" },
      verified: { type: "boolean", description: "true — только после самопроверки что всё корректно" }
    },
    required: ["summary", "html_report"]
  }
};

const TOOLS_CHAT = [
  { type: "function", function: TOOL_CREATE_PLAN },
  { type: "function", function: TOOL_READ_FILE },
  { type: "function", function: TOOL_LIST_DIR },
  { type: "function", function: TOOL_TASK_COMPLETED }
];

const TOOLS_WORKSPACE = [
  { type: "function", function: TOOL_REQUEST_CONTEXT },
  { type: "function", function: TOOL_CREATE_PLAN },
  { type: "function", function: TOOL_PATCH_FILE },
  { type: "function", function: TOOL_WRITE_FILE },
  { type: "function", function: TOOL_UNDO_EDIT },
  { type: "function", function: TOOL_LIST_SNAPSHOTS },
  { type: "function", function: TOOL_CREATE_FOLDER },
  { type: "function", function: TOOL_DELETE_FILE },
  { type: "function", function: TOOL_SEND_FILE },
  { type: "function", function: TOOL_CREATE_NODEJS_APP },
  { type: "function", function: TOOL_LIST_APPS },
  { type: "function", function: TOOL_START_APP },
  { type: "function", function: TOOL_STOP_APP },
  { type: "function", function: TOOL_GET_APP_LOGS },
  { type: "function", function: TOOL_SCHEDULE_CRON },
  { type: "function", function: TOOL_ANALYZE_DEPS },
  { type: "function", function: TOOL_INVALIDATE_PROJECT_CACHE },
  { type: "function", function: TOOL_CREATE_TASK_PLAN },
  { type: "function", function: TOOL_READ_PLAN },
  { type: "function", function: TOOL_UPDATE_STEP_STATUS },
  { type: "function", function: TOOL_ADD_SUBSTEP },
  { type: "function", function: TOOL_LIST_ACTIVE_PLANS },
  { type: "function", function: TOOL_HTTP_REQUEST },
  { type: "function", function: TOOL_RUN_TESTS },
  { type: "function", function: TOOL_CREATE_PYTHON_MODULE },
  { type: "function", function: TOOL_INSTALL_PACKAGES },
  { type: "function", function: TOOL_TASK_COMPLETED }
];

const TOOLS_TERMINAL = [
  { type: "function", function: TOOL_CREATE_PLAN },
  { type: "function", function: TOOL_EXEC_COMMAND },
  { type: "function", function: TOOL_HTTP_REQUEST },
  { type: "function", function: TOOL_RUN_TESTS },
  { type: "function", function: TOOL_CREATE_PYTHON_MODULE },
  { type: "function", function: TOOL_INSTALL_PACKAGES },
  { type: "function", function: TOOL_READ_FILE },
  { type: "function", function: TOOL_SEND_FILE },
  { type: "function", function: TOOL_CREATE_NODEJS_APP },
  { type: "function", function: TOOL_LIST_APPS },
  { type: "function", function: TOOL_START_APP },
  { type: "function", function: TOOL_STOP_APP },
  { type: "function", function: TOOL_GET_APP_LOGS },
  { type: "function", function: TOOL_SCHEDULE_CRON },
  { type: "function", function: TOOL_INVALIDATE_PROJECT_CACHE },
  { type: "function", function: TOOL_CREATE_TASK_PLAN },
  { type: "function", function: TOOL_READ_PLAN },
  { type: "function", function: TOOL_UPDATE_STEP_STATUS },
  { type: "function", function: TOOL_ADD_SUBSTEP },
  { type: "function", function: TOOL_LIST_ACTIVE_PLANS },
  { type: "function", function: TOOL_TASK_COMPLETED }
];

module.exports = {
  TOOLS_CHAT,
  TOOLS_WORKSPACE,
  TOOLS_TERMINAL
};
