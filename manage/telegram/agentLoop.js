const aiRouterService = require('../../services/ai_router_service');
const { dispatchTool } = require('./toolHandlers');
const manageStore = require('../store');

/**
 * Санитизирует массив сообщений перед отправкой в API.
 *
 * Anthropic/Bedrock требует строгого соответствия структуры диалога:
 *   - каждый role:'tool' (tool_result) должен иметь предшествующий role:'assistant' с tool_calls
 *   - каждый role:'assistant' с tool_calls должен иметь следующий role:'tool' с тем же tool_call_id
 *
 * Эта функция удаляет «осиротевшие» сообщения, которые нарушают эти правила.
 * Такие сообщения появляются когда история обрезается по лимиту MAX_AI_MESSAGES.
 */
function sanitizeMessagesForAPI(messages) {
    // Шаг 1: собираем множество tool_call_id из всех assistant-сообщений
    const knownToolCallIds = new Set();
    for (const m of messages) {
        if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
            for (const tc of m.tool_calls) {
                if (tc.id) knownToolCallIds.add(tc.id);
            }
        }
    }

    // Шаг 2: фильтруем tool-сообщения без соответствующего assistant
    let filtered = messages.filter(m => {
        if (m.role === 'tool') {
            if (!m.tool_call_id || !knownToolCallIds.has(m.tool_call_id)) {
                console.warn('[SANITIZE] Removing orphan tool message, tool_call_id:', m.tool_call_id);
                return false;
            }
        }
        return true;
    });

    // Шаг 3: собираем множество tool_call_id из оставшихся tool-сообщений
    const answeredToolCallIds = new Set();
    for (const m of filtered) {
        if (m.role === 'tool' && m.tool_call_id) {
            answeredToolCallIds.add(m.tool_call_id);
        }
    }

    // Шаг 4: удаляем assistant+tool_calls у которых нет ни одного ответного tool-сообщения.
    // ВАЖНО: если assistant удаляется — каскадно удаляем и все его tool-ответы,
    // иначе они станут «осиротевшими» и снова сломают историю.
    const removedAssistantToolCallIds = new Set();
    filtered = filtered.filter((m, idx) => {
        if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
            const isLast = idx === filtered.length - 1;
            if (isLast) return true; // последний — ок, ответ ещё не пришёл
            // Проверяем, есть ли хотя бы один ответ на любой из tool_calls этого сообщения
            const hasAnswer = m.tool_calls.some(tc => tc.id && answeredToolCallIds.has(tc.id));
            if (!hasAnswer) {
                console.warn('[SANITIZE] Removing unanswered assistant tool_calls at idx:', idx);
                // Запоминаем все tool_call_id этого assistant для каскадного удаления
                for (const tc of m.tool_calls) {
                    if (tc.id) removedAssistantToolCallIds.add(tc.id);
                }
                return false;
            }
        }
        return true;
    });

    // Шаг 4б: каскадно удаляем tool-ответы удалённых assistant-сообщений
    if (removedAssistantToolCallIds.size > 0) {
        filtered = filtered.filter(m => {
            if (m.role === 'tool' && m.tool_call_id && removedAssistantToolCallIds.has(m.tool_call_id)) {
                console.warn('[SANITIZE] Cascade-removing tool reply for removed assistant, tool_call_id:', m.tool_call_id);
                return false;
            }
            return true;
        });
    }

    // Шаг 5: первое сообщение не должно быть role:'tool' — сдвигаем до первого user/assistant
    while (filtered.length > 0 && filtered[0].role === 'tool') {
        console.warn('[SANITIZE] Removing leading tool message');
        filtered.shift();
    }

    return filtered;
}

async function summarize(messages, reason) {
    return { summary: `[Прервано: ${reason}]\n\nПожалуйста, уточните задачу.`, filesToSend: [] };
}

/**
 * Анализирует историю сообщений и определяет, нужна ли проверка связности.
 *
 * Детектирует:
 *   - write_file с basename пути равным 'webhook_handler.js' или 'webhook_handler.py'
 *     (точное совпадение basename, а не includes — исключает ложные срабатывания
 *      на backup-файлы вроде 'old_webhook_handler.js')
 *   - create_nodejs_app — создание Node.js-приложения; собирает имена всех созданных
 *     приложений в nodeAppNames[] для подстановки реальных портов в подсказки
 *
 * Возвращает { needsConnectivityCheck, hasWebhookHandler, hasNodeApp, nodeAppNames }
 */
function detectConnectivityContext(messages) {
    // Точные имена файлов webhook-обработчиков
    const WEBHOOK_HANDLER_NAMES = new Set(['webhook_handler.js', 'webhook_handler.py']);

    let hasWebhookHandler = false;
    let hasNodeApp = false;
    const nodeAppNames = []; // имена всех созданных приложений (для поиска портов)

    for (const m of messages) {
        if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
            for (const tc of m.tool_calls) {
                const name = tc.function?.name;
                if (name === 'write_file') {
                    try {
                        const args = JSON.parse(tc.function.arguments || '{}');
                        if (args.path) {
                            // Берём только имя файла (basename) — без пути
                            const basename = args.path.split('/').pop();
                            if (WEBHOOK_HANDLER_NAMES.has(basename)) {
                                hasWebhookHandler = true;
                            }
                        }
                    } catch (_) {}
                }
                if (name === 'create_nodejs_app') {
                    hasNodeApp = true;
                    try {
                        const args = JSON.parse(tc.function.arguments || '{}');
                        if (args.name && !nodeAppNames.includes(args.name)) {
                            nodeAppNames.push(args.name);
                        }
                    } catch (_) {}
                }
            }
        }
    }

    return {
        needsConnectivityCheck: hasWebhookHandler || hasNodeApp,
        hasWebhookHandler,
        hasNodeApp,
        nodeAppNames // ['myapp', 'chat', ...] — для поиска портов в реестре
    };
}

/**
 * Анализирует историю сообщений и определяет, создавались ли тестовые файлы.
 *
 * Детектирует:
 *   - write_file с путём, соответствующим шаблону test_*.py или *_test.py
 *   - write_file с путём, соответствующим шаблону *.test.js или *.spec.js
 *
 * Возвращает { hasTestFiles, testFilePaths }
 */
function detectTestContext(messages) {
    const testFilePaths = [];

    for (const m of messages) {
        if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
            for (const tc of m.tool_calls) {
                const name = tc.function?.name;
                if (name === 'write_file') {
                    try {
                        const args = JSON.parse(tc.function.arguments || '{}');
                        if (args.path) {
                            const basename = args.path.split('/').pop();
                            // Python: test_*.py или *_test.py
                            if (/^test_.*\.py$/.test(basename) || /.*_test\.py$/.test(basename)) {
                                testFilePaths.push(args.path);
                            }
                            // JavaScript: *.test.js или *.spec.js
                            if (/.*\.test\.js$/.test(basename) || /.*\.spec\.js$/.test(basename)) {
                                testFilePaths.push(args.path);
                            }
                        }
                    } catch (_) {}
                }
            }
        }
    }

    return {
        hasTestFiles: testFilePaths.length > 0,
        testFilePaths
    };
}

/**
 * Обрабатывает вызов task_completed.
 *
 * chatId передаётся для подстановки в curl-подсказки рефлексии.
 * connectivityChecked — флаг из замыкания executeAgentLoop: была ли уже
 * проведена connectivity-проверка (чтобы не требовать её повторно при
 * verified=true если агент пропустил шаг verified=false).
 */
async function handleTaskCompleted(messages, toolCall, toolArgs, pendingFiles, chatId, connectivityChecked) {
    const { summary, html_report, files = [], verified = false } = toolArgs;

    if (!verified) {
        // Определяем контекст для расширенной рефлексии
        const connectivity = detectConnectivityContext(messages);
        const testContext = detectTestContext(messages);

        const baseChecks = [
            'Хорошо. Перед завершением проведи самопроверку:',
            '1. Все ли пункты плана выполнены?',
            '2. Нет ли ошибок в изменённых файлах? Проверь через request_context(files: ["путь/к/файлу"], reason: "проверка после изменений", need_more: false).',
            '3. Если создавал скрипты — убедись что они синтаксически корректны.',
        ];

        // Проверка тестов — если создавались тестовые файлы
        if (testContext.hasTestFiles) {
            baseChecks.push(
                '4. [TESTS] Обнаружены тестовые файлы. Запусти их через run_tests():',
                `   Тестовые файлы: ${testContext.testFilePaths.join(', ')}`,
                '   Убедись что все тесты проходят. Если есть ошибки — исправь код и повтори.'
            );
        }

        // Расширенный чеклист связности — только если создавался webhook_handler или Node.js-приложение
        if (connectivity.needsConnectivityCheck) {
            if (connectivity.hasWebhookHandler) {
                baseChecks.push(
                    '5. [CONNECTIVITY] webhook_handler создан — протестируй его через exec_command:',
                    `   curl -s -X POST https://claw.pro-talk.ru/hook/${chatId}/test -H 'Content-Type: application/json' -d '{"test":true}'`,
                    '   Если ответ содержит твой вывод — хук работает. Если ошибка — исправь и повтори.'
                );
            }
            if (connectivity.hasNodeApp) {
                // Подставляем реальные порты из реестра приложений вместо плейсхолдера "ПОРТ".
                // nodeAppNames содержит имена всех create_nodejs_app из истории сессии.
                const apps = manageStore.getApps(chatId) || [];
                const appPortLines = connectivity.nodeAppNames.map(appName => {
                    const reg = apps.find(a => a.name === appName);
                    return reg && reg.port
                        // Порт известен — готовая команда
                        ? `   curl -sf http://localhost:${reg.port}/api/ping && echo "OK: ${appName}"`
                        // Порт неизвестен — инструкция по обнаружению
                        : `   pm2 list | grep app-${appName}  # узнай порт, затем: curl -sf http://localhost:ПОРТ/api/ping`;
                });

                baseChecks.push(
                    '5. [CONNECTIVITY] Node.js-приложение создано — проверь что оно отвечает:',
                    '   get_app_logs(ИМЯ) — убедись что нет ошибок запуска.',
                    ...appPortLines,
                    '   Если fetch() в UI использует /api/... с ведущим слэшем — исправь на api/... (без слэша).'
                );
            }
            baseChecks.push(
                '6. Если все проверки прошли — вызови task_completed(verified: true).',
                '   Если нашёл ошибки — исправь их и потом вызови task_completed(verified: true).'
            );
        } else {
            baseChecks.push(
                'Если всё в порядке — вызови task_completed(verified: true).',
                'Если нашёл ошибки — исправь их и потом вызови task_completed(verified: true).'
            );
        }

        // Возвращаем агента на самопроверку.
        // Возвращаем null как сигнал "продолжай цикл", но передаём connectivity
        // через специальный символ чтобы executeAgentLoop не вызывал detectConnectivityContext повторно.
        messages.push({
            role: 'tool',
            content: JSON.stringify({
                status: 'reflection_required',
                connectivity_check_required: connectivity.needsConnectivityCheck,
                test_check_required: testContext.hasTestFiles,
                message: baseChecks.join('\n')
            }),
            tool_call_id: toolCall.id
        });
        // null[0] = connectivity — упаковываем в массив: [null, connectivity]
        // executeAgentLoop проверяет Array.isArray(result) для распаковки
        return [null, connectivity]; // continue loop, connectivity уже вычислен
    }

    // verified: true — но если connectivity-проверка ещё не проводилась,
    // принудительно требуем её (защита от моделей, пропускающих verified=false)
    if (!connectivityChecked) {
        const connectivity = detectConnectivityContext(messages);
        const testContext = detectTestContext(messages);
        
        if (connectivity.needsConnectivityCheck || testContext.hasTestFiles) {
            const forceChecks = [
                '[SYSTEM] Обнаружены созданные сервисы или тесты, требующие проверки.',
                'Перед финальным завершением выполни:',
            ];
            
            if (testContext.hasTestFiles) {
                forceChecks.push(
                    `- run_tests() — запусти тесты: ${testContext.testFilePaths.join(', ')}`,
                    '  Убедись что все тесты проходят.'
                );
            }
            
            if (connectivity.hasWebhookHandler) {
                forceChecks.push(
                    `- curl -s -X POST https://claw.pro-talk.ru/hook/${chatId}/test -H 'Content-Type: application/json' -d '{"test":true}'`,
                    '  Убедись что ответ содержит вывод твоего handler.'
                );
            }
            if (connectivity.hasNodeApp) {
                // Те же реальные порты — без плейсхолдера
                const apps = manageStore.getApps(chatId) || [];
                connectivity.nodeAppNames.forEach(appName => {
                    const reg = apps.find(a => a.name === appName);
                    forceChecks.push(reg && reg.port
                        ? `- curl -sf http://localhost:${reg.port}/api/ping && echo "OK: ${appName}"`
                        : `- pm2 list | grep app-${appName}  # узнай порт, затем curl /api/ping`
                    );
                });
                if (connectivity.nodeAppNames.length === 0) {
                    forceChecks.push('- get_app_logs(ИМЯ) — нет ли ошибок запуска?');
                }
            }
            forceChecks.push('После проверки вызови task_completed(verified: true) снова.');

            messages.push({
                role: 'tool',
                content: JSON.stringify({
                    status: 'connectivity_check_required',
                    message: forceChecks.join('\n')
                }),
                tool_call_id: toolCall.id
            });
            return null; // continue loop — агент должен проверить и вызвать снова
        }
    }

    // Добавляем файлы из аргументов в pendingFiles
    if (Array.isArray(files)) {
        for (const f of files) {
            if (!pendingFiles.includes(f)) pendingFiles.push(f);
        }
    }

    // verified: true + проверки пройдены → реально завершаем
    return { summary, html_report, filesToSend: pendingFiles };
}

async function executeAgentLoop(chatId, data, messages, tools, agentCtx, maxIterations = 15) {
    const pendingFiles = [];
    let errorCount = 0;
    let emptyCount = 0;
    // Счётчик одинаковых вызовов подряд (одинаковый инструмент И одинаковые аргументы)
    let sameCallCount = 0;
    // Счётчик одного инструмента подряд (любые аргументы) — для защиты от бесконечного exec_command
    let sameToolCount = 0;
    let lastTool = null;
    let lastArgs = null;
    // Фазовый контроль: сколько read_file/request_context вызвано до create_plan.
    // Если агент читает больше READ_BEFORE_PLAN_LIMIT файлов без плана — инжектируем hint.
    const READ_BEFORE_PLAN_LIMIT = 5;
    let readBeforePlan = 0;   // счётчик чтений до первого create_plan
    let planCreated = false;  // флаг: create_plan или create_task_plan уже был вызван
    // Workflow state для передачи в dispatchTool (code barriers)
    const workflowState = { planCreated: false };
    // Кэш дерева проекта: вычисляется один раз при первом request_context,
    // при повторных вызовах (need_more=true) передаётся из кэша — экономим ~200 строк токенов.
    let cachedProjectTree = null;
    // Флаг: была ли уже проведена connectivity-проверка в этой сессии.
    // Устанавливается в true после первого task_completed(verified:false) с connectivity-чеклистом,
    // чтобы при verified:true не требовать её повторно.
    let connectivityChecked = false;

    // Счётчики токенов за всю сессию
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    let totalTokens = 0;

    console.log(`\n${'═'.repeat(60)}`);
    console.log(`[AGENT-LOOP] ▶ START  chatId=${chatId}  model=${data.aiModel || '?'}  mode=${agentCtx?.channel || '?'}`);
    console.log(`[AGENT-LOOP]   history=${messages.length} msgs  maxIter=${maxIterations}`);
    console.log(`${'═'.repeat(60)}`);

    for (let i = 0; i < maxIterations; i++) {
        let resp;
        try {
            const before = messages.length;
            const sanitized = sanitizeMessagesForAPI(messages);
            const after = sanitized.length;
            if (before !== after) {
                console.log(`[AGENT-LOOP] [iter ${i+1}] sanitize: ${before} → ${after} msgs (удалено ${before - after} битых)`);
            }

            console.log(`[AGENT-LOOP] [iter ${i+1}/${maxIterations}] → callAI (${sanitized.length} msgs в контексте)`);
            const aiResp = await aiRouterService.callAI(chatId, data.aiAuthToken, data.aiModel, sanitized, tools, data.aiUserEmail);
            resp = aiResp.choices[0].message;

            // Учёт токенов
            if (aiResp.usage) {
                const u = aiResp.usage;
                const iterPrompt = u.prompt_tokens || 0;
                const iterCompletion = u.completion_tokens || 0;
                const iterTotal = u.total_tokens || (iterPrompt + iterCompletion);
                totalPromptTokens += iterPrompt;
                totalCompletionTokens += iterCompletion;
                totalTokens += iterTotal;
                console.log(`[AGENT-LOOP] [iter ${i+1}] tokens: prompt=${iterPrompt} completion=${iterCompletion} total=${iterTotal} | session_total=${totalTokens}`);
                // Обновляем счётчик токенов в UI
                if (agentCtx && agentCtx.updateTokens) {
                    await agentCtx.updateTokens(totalPromptTokens, totalCompletionTokens, totalTokens);
                }
            }
        } catch (e) {
            console.error(`[AGENT-LOOP] [iter ${i+1}] ✗ API error (${errorCount+1}/3): ${e.message}`);
            errorCount++;
            if (errorCount >= 3) {
                console.error(`[AGENT-LOOP] ✗ ABORT: 3 API errors in a row`);
                return { error: 'Критические ошибки API, прерываю.' };
            }
            continue;
        }

        // [A] tool_calls
        if (resp.tool_calls && resp.tool_calls.length > 0) {
            emptyCount = 0;
            errorCount = 0; // Сбрасываем счётчик ошибок API при успешном ответе

            // Добавляем assistant-сообщение в историю ОДИН РАЗ со всеми tool_calls
            messages.push({ role: 'assistant', content: resp.content || '', tool_calls: resp.tool_calls });

            let taskCompletedResult = null;
            let reflectionRequired = false;

            // Обрабатываем ВСЕ tool_calls в цикле
            for (let tcIdx = 0; tcIdx < resp.tool_calls.length; tcIdx++) {
                const toolCall = resp.tool_calls[tcIdx];
                const { name: toolName, arguments: argsStr } = toolCall.function;
                
                let toolArgs = {};
                try {
                    toolArgs = JSON.parse(argsStr || '{}');
                } catch (e) {
                    console.error(`[AGENT-LOOP] [iter ${i+1}] ✗ JSON parse error for tool args:`, argsStr);
                }

                // Краткое описание аргументов для лога
                const argsPreview = (() => {
                    if (toolName === 'exec_command') return `cmd="${(toolArgs.command || '').slice(0, 80)}"`;
                    if (toolName === 'read_file' || toolName === 'write_file' || toolName === 'patch_file' || toolName === 'delete_file' || toolName === 'undo_edit') return `path="${toolArgs.path}"`;
                    if (toolName === 'list_dir') return `path="${toolArgs.path || '/workspace'}"`;
                    if (toolName === 'create_folder') return `path="${toolArgs.path}"`;
                    if (toolName === 'task_completed') return `verified=${toolArgs.verified}`;
                    return argsStr.slice(0, 60);
                })();

                console.log(`[AGENT-LOOP] [iter ${i+1}] ← tool_call [${tcIdx+1}/${resp.tool_calls.length}]: ${toolName}(${argsPreview})  id=${toolCall.id}`);

                // --- Защита: одинаковый вызов (инструмент + аргументы) подряд ---
                if (toolName === lastTool && argsStr === lastArgs) {
                    sameCallCount++;
                } else {
                    sameCallCount = 0;
                }
                sameToolCount = toolName === lastTool ? sameToolCount + 1 : 0;
                lastTool = toolName;
                lastArgs = argsStr;

                if (sameCallCount >= 1) {
                    console.warn(`[AGENT-LOOP] [iter ${i+1}] ⚠ SAME-CALL LOOP: ${toolName}(${argsPreview}) повторяется`);
                    return await summarize(messages, `Зацикливание: инструмент ${toolName} вызван с теми же аргументами повторно.`);
                }
                if (sameToolCount >= 10) {
                    console.warn(`[AGENT-LOOP] [iter ${i+1}] ⚠ SAME-TOOL LOOP: ${toolName} вызван ${sameToolCount+1} раз подряд`);
                    return await summarize(messages, `Зацикливание на инструменте ${toolName}.`);
                }

                // --- Фазовый контроль: считаем чтения до create_plan ---
                if (!planCreated) {
                    if (toolName === 'read_file' || toolName === 'request_context' || toolName === 'list_dir') {
                        readBeforePlan++;
                        if (readBeforePlan > READ_BEFORE_PLAN_LIMIT) {
                            console.warn(`[AGENT-LOOP] [iter ${i+1}] ⚠ READ-BEFORE-PLAN: ${readBeforePlan} чтений без create_plan — инжектируем hint`);
                            // Инжектируем hint в следующий tool-result через флаг — обработается ниже
                        }
                    }
                    if (toolName === 'create_plan' || toolName === 'create_task_plan') {
                        planCreated = true;
                        workflowState.planCreated = true; // Обновляем workflowState для dispatchTool
                        readBeforePlan = 0;
                        console.log(`[AGENT-LOOP] [iter ${i+1}] ✓ ${toolName} вызван — фаза исследования завершена`);
                    }
                }

                // --- Специальный случай: task_completed ---
                if (toolName === 'task_completed') {
                    console.log(`[AGENT-LOOP] [iter ${i+1}] task_completed called, verified=${toolArgs.verified}`);
                    if (agentCtx && agentCtx.updateStatusMessage) {
                        if (!toolArgs.verified) {
                            await agentCtx.updateStatusMessage('🔍 Провожу самопроверку...');
                        } else {
                            await agentCtx.updateStatusMessage('✅ Завершаю задачу...');
                        }
                    }
                    const result = await handleTaskCompleted(messages, toolCall, toolArgs, pendingFiles, chatId, connectivityChecked);

                    // handleTaskCompleted возвращает:
                    //   { summary, ... }      — задача завершена (verified=true, проверки пройдены)
                    //   [null, connectivity]  — рефлексия (verified=false): продолжаем цикл,
                    //                           connectivity уже вычислен — не вызываем повторно
                    //   null                  — форс-чек (verified=true без предшествующей проверки):
                    //                           продолжаем цикл, connectivity не нужен
                    if (Array.isArray(result)) {
                        // verified=false: распаковываем connectivity из ответа
                        const [, connectivity] = result;
                        // Помечаем флаг только если чеклист реально был отправлен
                        if (connectivity && connectivity.needsConnectivityCheck) connectivityChecked = true;
                        console.log(`[AGENT-LOOP] [iter ${i+1}] → reflection required, continuing...`);
                        reflectionRequired = true;
                        // Сбрасываем счётчики повторов — агент должен свободно вызвать
                        // task_completed(verified:true) после выполнения чеклиста
                        lastTool = null; lastArgs = null; sameCallCount = 0; sameToolCount = 0;
                        continue;
                    }
                    if (result !== null) {
                        console.log(`[AGENT-LOOP] ✓ DONE (task_completed verified=true)  iter=${i+1}`);
                        taskCompletedResult = result;
                        break; // Прерываем обработку остальных tool_calls
                    }
                    // result === null: форс-чек отправлен, агент должен проверить и вызвать снова
                    console.log(`[AGENT-LOOP] [iter ${i+1}] → connectivity force-check required, continuing...`);
                    reflectionRequired = true;
                    // Помечаем флаг: форс-чек уже отправлен — следующий verified=true пройдёт без повтора.
                    // БЕЗ этой строки connectivityChecked остаётся false и цикл бесконечен:
                    //   task_completed(verified=true) → форс-чек → curl OK → task_completed(verified=true) → ...
                    connectivityChecked = true;
                    // Сбрасываем счётчики — повторный task_completed(verified:true) не должен
                    // срабатывать как зацикливание (аргументы могут совпасть у слабых моделей)
                    lastTool = null; lastArgs = null; sameCallCount = 0; sameToolCount = 0;
                    continue; // Переходим к следующему tool_call (если есть)
                }

                // Уведомляем пользователя о текущем действии
                if (agentCtx && agentCtx.updateStatusMessage) {
                    let actionMsg = '';
                    switch (toolName) {
                        case 'request_context':   actionMsg = `🔍 Изучаю проект (${(toolArgs.files || []).length} файлов)...`; break;
                        case 'read_file':         actionMsg = `📖 Читаю файл: <code>${toolArgs.path}</code>`; break;
                        case 'list_dir':          actionMsg = `📂 Просматриваю: <code>${toolArgs.path || '/workspace'}</code>`; break;
                        case 'exec_command':      actionMsg = `⚡ Выполняю: <code>${(toolArgs.command || '').slice(0, 80)}</code>`; break;
                        case 'patch_file':        actionMsg = `✏️ Изменяю файл: <code>${toolArgs.path}</code>`; break;
                        case 'write_file':        actionMsg = `📝 Создаю файл: <code>${toolArgs.path}</code>`; break;
                        case 'create_folder':     actionMsg = `📁 Создаю папку: <code>${toolArgs.path}</code>`; break;
                        case 'delete_file':       actionMsg = `🗑 Удаляю файл: <code>${toolArgs.path}</code>`; break;
                        case 'undo_edit':         actionMsg = `↩️ Откатываю: <code>${toolArgs.path}</code>`; break;
                        case 'send_file':         actionMsg = `📤 Подготавливаю файл: <code>${toolArgs.path}</code>`; break;
                        case 'create_nodejs_app': actionMsg = `🚀 Создаю приложение: <code>${toolArgs.name}</code>`; break;
                        case 'start_nodejs_app':  actionMsg = `▶️ Запускаю: <code>${toolArgs.name}</code>`; break;
                        case 'stop_nodejs_app':   actionMsg = `⏹ Останавливаю: <code>${toolArgs.name}</code>`; break;
                        case 'get_app_logs':      actionMsg = `📋 Читаю логи: <code>${toolArgs.name}</code>`; break;
                        case 'list_nodejs_apps':  actionMsg = `📋 Получаю список приложений...`; break;
                        case 'create_plan':       actionMsg = `📋 Составляю план (${(toolArgs.steps || []).length} шагов)...`; break;
                        case 'create_task_plan':  actionMsg = `🗂 Создаю план задачи...`; break;
                        case 'schedule_cron':     actionMsg = `⏰ Настраиваю расписание: <code>${toolArgs.cron_expression}</code>`; break;
                        case 'read_plan':         actionMsg = `📄 Читаю план...`; break;
                        case 'update_step_status':actionMsg = `🔄 Обновляю статус шага ${toolArgs.step_index}...`; break;
                        case 'list_active_plans': actionMsg = `📋 Загружаю активные планы...`; break;
                        case 'http_request':      actionMsg = `🌐 HTTP-запрос: <code>${toolArgs.method} ${toolArgs.url}</code>`; break;
                        case 'run_tests':         actionMsg = `🧪 Запускаю тесты...`; break;
                        case 'create_python_module': actionMsg = `🐍 Создаю модуль: <code>${toolArgs.name}</code>`; break;
                        case 'install_packages':  actionMsg = `📦 Устанавливаю пакеты: <code>${(toolArgs.packages || []).slice(0, 3).join(', ')}${(toolArgs.packages || []).length > 3 ? '...' : ''}</code>`; break;
                    }
                    if (actionMsg) await agentCtx.updateStatusMessage(`⏳ ${actionMsg}`);
                }

                // Выполняем инструмент
                // Для request_context передаём кэш дерева — при повторных вызовах
                // (need_more=true) find не запускается повторно, экономим токены.
                if (toolName === 'request_context') {
                    toolArgs = { ...toolArgs, _cachedProjectTree: cachedProjectTree };
                }
                const toolResult = await dispatchTool(chatId, toolName, toolArgs, pendingFiles, agentCtx, workflowState);
                // Сохраняем дерево в кэш после первого успешного request_context
                if (toolName === 'request_context' && toolResult.ok && toolResult.project_tree) {
                    cachedProjectTree = toolResult.project_tree;
                }

                // Если инструмент успешно выполнен и это не просто чтение, продвигаем шаг плана
                if (toolResult && toolResult.ok !== false && !['read_file', 'list_dir', 'request_context', 'create_plan', 'get_app_logs'].includes(toolName)) {
                    if (agentCtx && agentCtx.markStepDone) {
                        await agentCtx.markStepDone();
                    }
                }

                // Логируем результат
                const resultPreview = (() => {
                    if (toolName === 'exec_command') {
                        const exit = toolResult.exitCode ?? '?';
                        const out = (toolResult.stdout || '').slice(0, 120).replace(/\n/g, '↵');
                        const err = toolResult.stderr ? ` stderr="${toolResult.stderr.slice(0, 60)}"` : '';
                        return `exit=${exit} stdout="${out}"${err}`;
                    }
                    if (toolResult.ok === false) return `✗ error="${toolResult.error || toolResult.message || '(no message)'}"`;
                    if (toolResult.ok === true)  return `✓ ok`;
                    return JSON.stringify(toolResult).slice(0, 100);
                })();
                console.log(`[AGENT-LOOP] [iter ${i+1}] → result [${tcIdx+1}]: ${resultPreview}`);

                // Считаем ошибкой: явное поле error ИЛИ ok === false
                const isToolError = !!(toolResult.error) || toolResult.ok === false;
                if (isToolError) {
                    errorCount++;
                    const errMsg = toolResult.error || toolResult.message || 'ok=false';
                    console.warn(`[AGENT-LOOP] [iter ${i+1}] ⚠ tool error (${errorCount}/3): ${errMsg}`);
                    if (errorCount >= 3) {
                        console.error(`[AGENT-LOOP] ✗ ABORT: 3 tool errors`);
                        return await summarize(messages, 'Слишком много ошибок инструментов, прерываю.');
                    }
                }

                // Сохраняем команду в историю если это exec_command
                if (toolName === 'exec_command') {
                    manageStore.addCommand(
                        chatId,
                        toolArgs.command,
                        toolResult.stdout,
                        toolResult.stderr,
                        toolResult.exitCode != null ? toolResult.exitCode : 0
                    );
                }

                // Форматируем результат для LLM
                let formattedResult = '';
                if (toolName === 'exec_command') {
                    formattedResult = `Выполнена команда: ${toolArgs.command}\n\n` +
                        (toolResult.stdout ? `STDOUT:\n${toolResult.stdout.slice(0, 1500)}\n` : '') +
                        (toolResult.stderr ? `STDERR:\n${toolResult.stderr.slice(0, 800)}\n` : '') +
                        `Exit code: ${toolResult.exitCode || 0}`;
                } else if (toolName === 'read_file') {
                    formattedResult = toolResult.stdout ? `Содержимое файла:\n${toolResult.stdout.slice(0, 3000)}` : (toolResult.stderr || 'Файл пуст или не найден');
                } else if (toolName === 'list_dir') {
                    formattedResult = toolResult.stdout ? `Содержимое директории:\n${toolResult.stdout.slice(0, 2000)}` : (toolResult.stderr || 'Директория пуста или не найдена');
                } else if (toolName === 'create_nodejs_app') {
                    const appName = toolArgs.name;
                    const appType = toolArgs.type;
                    if (toolResult.ok) {
                        formattedResult = [
                            `Scaffold приложения "${appName}" (${appType}) создан и запущен.`,
                            ``,
                            `ВАЖНО: Это только заготовка. Задача НЕ завершена. НЕ ЧИТАЙ файлы — шаблон уже правильный.`,
                            ``,
                            `Выполни СТРОГО по порядку:`,
                            `0. СНАЧАЛА вызови create_task_plan с целью "Создать приложение ${appName} (${appType})" и шагами ниже — чтобы задача появилась в трекере.`,
                            `1. write_file: /workspace/apps/${appName}/app.js — полная серверная логика для типа "${appType}"`,
                            `   (для chat: маршруты GET /api/messages?since=N и POST /api/messages, хранение в массиве)`,
                            `2. write_file: /workspace/apps/${appName}/public/index.html — полный UI для типа "${appType}"`,
                            `   (для chat: интерфейс с историей, полем имени, полем сообщения, polling каждые 2с)`,
                            `   ВАЖНО: fetch('api/...') БЕЗ ведущего слэша!`,
                            `3. exec_command: pm2 restart app-${appName}`,
                            `4. get_app_logs: ${appName} — проверить что нет ошибок`,
                            `5. task_completed(verified: false) → самопроверка → task_completed(verified: true)`,
                            ``,
                            `НЕ вызывай task_completed пока не выполнены шаги 0-4!`,
                        ].join('\n');
                    } else {
                        formattedResult = `Ошибка создания scaffold: ${toolResult.error || 'неизвестная ошибка'}`;
                    }
                } else {
                    formattedResult = JSON.stringify(toolResult);
                }

                // Тихая рефлексия каждые 4 итерации — добавляем подсказку прямо в tool-result
                let reflectionHint = '';
                if (i > 0 && i % 4 === 0 && tcIdx === resp.tool_calls.length - 1) {
                    console.log(`[AGENT-LOOP] [iter ${i+1}] → silent reflection hint injected`);
                    reflectionHint = '\n\n[SYSTEM HINT] Проверь прогресс: все ли шаги плана выполнены? Если нет — продолжай выполнять следующий шаг инструментами. НЕ отвечай текстом — вызывай следующий tool_call.';
                }
                // Фазовый hint: слишком много чтений без create_plan
                if (!planCreated && readBeforePlan > READ_BEFORE_PLAN_LIMIT && tcIdx === resp.tool_calls.length - 1) {
                    console.warn(`[AGENT-LOOP] [iter ${i+1}] → read-before-plan hint injected (${readBeforePlan} reads)`);
                    reflectionHint += `\n\n[SYSTEM HINT] Ты уже прочитал ${readBeforePlan} файлов/директорий. Достаточно ли контекста для решения задачи?\n— Если да → вызови create_plan и переходи к изменениям.\n— Если нет → вызови request_context(need_more: true) с конкретным списком недостающих файлов.\nНЕ читай файлы бесконечно — сформулируй план.`;
                }

                messages.push({
                    role: 'tool',
                    content: formattedResult + reflectionHint,
                    tool_call_id: toolCall.id,
                    name: toolName
                });
            }                    // Если task_completed вернул результат — завершаем цикл
                    if (taskCompletedResult !== null) {
                        // Сохраняем резюме сессии
                        if (taskCompletedResult.summary) {
                            manageStore.addSessionSummary(chatId, taskCompletedResult.summary);
                        }
                        return taskCompletedResult;
                    }

            // Если была рефлексия или просто выполнили инструменты — продолжаем цикл
            continue;
        }

        // [B] Текстовый ответ без tool_calls
        const content = (resp.content || '').trim();
        if (!content) {
            emptyCount++;
            console.warn(`[AGENT-LOOP] [iter ${i+1}] ⚠ empty response (${emptyCount}/3)`);
            if (emptyCount >= 3) {
                console.error(`[AGENT-LOOP] ✗ ABORT: model not responding`);
                return await summarize(messages, 'Модель не отвечает.');
            }
            messages.push({ role: 'user', content: 'Продолжай. Если задача решена — вызови task_completed.' });
            continue;
        }

        // Текстовый ответ = агент решил ответить без инструментов
        console.log(`[AGENT-LOOP] ✓ DONE (text reply, ${content.length} chars)  iter=${i+1}`);
        return { summary: content, filesToSend: pendingFiles };
    }

    // Лимит итераций
    console.warn(`[AGENT-LOOP] ✗ ABORT: max iterations (${maxIterations}) reached`);
    return {
        summary: 'Достигнут лимит шагов. Продолжить выполнение?',
        limitReached: true,
        filesToSend: pendingFiles
    };
}

async function classifyTask(chatId, data, userMessage) {
    try {
        const resp = await aiRouterService.callAI(chatId, data.aiAuthToken, data.aiModel, [
            { role: 'system', content: 'Классифицируй запрос пользователя одним словом: CHAT (просто поболтать, объяснить теорию, ответить на вопрос без действий), WORKSPACE (написать код, создать файлы, изменить файлы, удалить файлы) или TERMINAL (выполнить bash команды, установить пакеты, запустить скрипты, посмотреть логи).' },
            { role: 'user', content: userMessage }
        ], null, data.aiUserEmail);
        
        const content = (resp.choices[0].message.content || '').toUpperCase();
        if (content.includes('WORKSPACE')) return 'WORKSPACE';
        if (content.includes('TERMINAL')) return 'TERMINAL';
        return 'CHAT';
    } catch (e) {
        console.error('[CLASSIFY-TASK-ERROR]', e.message);
        return 'WORKSPACE'; // по умолчанию
    }
}

module.exports = {
    executeAgentLoop,
    classifyTask
};
