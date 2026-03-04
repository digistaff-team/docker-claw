def bash_task_ai(arguments):
    """
    AI агент v4 с поддержкой персонализации через файлы:
    - SOUL.md - личность AI агента
    - USER.md - контекст работы с пользователем
    - IDENTITY.md - имя и персональные данные AI
    - MEMORY.md - пароли, токены, регламенты
    """
    from typing import Dict, Any, List
    import requests
    from openai import OpenAI
    import json
    
    # Получаем параметры
    task = arguments.get('task', '')
    chat_id = arguments.get('chat_id', '')
    max_attempts = arguments.get('max_attempts', 10)
    if max_attempts > 15:
        max_attempts = 15
    
    api_key = arguments.get('api_key', "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")
    model = arguments.get('ai_model', 'x-ai/grok-4.1-fast')
    server_url = arguments.get('server_url', 'https://ai.bash.atiks.org')
    
    # Валидация
    if not task:
        return {
            "result": "❌ Ошибка: задача не указана (параметр 'task')",
            "status": "error",
            "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0, "api_calls": 0}
        }
    
    if not chat_id:
        return {
            "result": "❌ Ошибка: не указан chat_id пользователя",
            "status": "error",
            "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0, "api_calls": 0}
        }
    
    client = OpenAI(api_key=api_key, base_url="https://openrouter.ai/api/v1")
    command_history = []
    usage_stats = {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0, "api_calls": 0}
    
    session_info = {"chat_id": chat_id, "session_id": None, "is_new": False, "database": None}
    
    def _safe_json_response(response, default=None):
        """Безопасный разбор JSON: при пустом/не-JSON ответе возвращаем default или описание ошибки."""
        if default is None:
            default = {}
        try:
            if not response.text or not response.text.strip():
                return {**default, "error": f"Пустой ответ сервера (HTTP {response.status_code})"}
            if response.status_code != 200:
                return {**default, "error": f"HTTP {response.status_code}: {response.text[:200]}"}
            return response.json()
        except json.JSONDecodeError as e:
            return {**default, "error": f"Ответ не JSON (HTTP {response.status_code}): {response.text[:150]}"}
        except Exception as e:
            return {**default, "error": str(e)}
    
    # Специальные файлы для персонализации
    PERSONALIZATION_FILES = {
        "SOUL.md": "Личность и характер AI агента",
        "USER.md": "Контекст работы с пользователем",
        "IDENTITY.md": "Имя и персональные данные AI",
        "MEMORY.md": "Пароли, токены, регламенты"
    }
    
    def get_session_info() -> Dict[str, Any]:
        """Получить информацию о сессии"""
        try:
            response = requests.get(f"{server_url}/api/session/{chat_id}", timeout=5)
            out = _safe_json_response(response, default={"exists": False})
            if "error" in out:
                out["exists"] = False
            return out
        except requests.exceptions.RequestException as e:
            return {"exists": False, "error": f"Сеть: {str(e)}"}
        except Exception as e:
            return {"exists": False, "error": str(e)}
    
    def get_database_info() -> Dict[str, Any]:
        """Получить информацию о базе данных"""
        try:
            response = requests.get(f"{server_url}/api/database/{chat_id}", timeout=5)
            return _safe_json_response(response)
        except requests.exceptions.RequestException as e:
            return {"error": f"Сеть: {str(e)}"}
        except Exception as e:
            return {"error": str(e)}
    
    def read_personalization_file(filename: str) -> str:
        """Прочитать файл персонализации"""
        try:
            response = requests.get(
                f"{server_url}/api/files/{chat_id}/content",
                params={"filepath": f"/workspace/{filename}"},
                timeout=5
            )
            if response.status_code == 200:
                content = response.text.strip()
                return content if content else ""
            return ""
        except Exception:
            return ""
    
    def load_personalization() -> Dict[str, str]:
        """Загрузить все файлы персонализации"""
        personalization = {}
        for filename in PERSONALIZATION_FILES.keys():
            content = read_personalization_file(filename)
            if content:
                personalization[filename] = content
        return personalization
    
    def execute_bash(command: str) -> Dict[str, Any]:
        """Выполнение bash команды"""
        try:
            payload = {
                "command": command,
                "timeout": 30,
                "chat_id": chat_id
            }
            response = requests.post(
                f"{server_url}/api/execute",
                json=payload,
                timeout=35
            )
            result = _safe_json_response(response)
            if "error" in result:
                return {
                    "success": False,
                    "stdout": "",
                    "stderr": result["error"],
                    "exit_code": -1
                }
            if "sessionId" in result:
                session_info["session_id"] = result["sessionId"]
            return {
                "success": result.get("exitCode") == 0,
                "stdout": result.get("stdout", "").strip(),
                "stderr": result.get("stderr", "").strip(),
                "exit_code": result.get("exitCode", -1),
                "command_number": result.get("commandNumber", 0),
            }
        except requests.exceptions.RequestException as e:
            return {
                "success": False,
                "stdout": "",
                "stderr": f"Сеть/таймаут: {str(e)}",
                "exit_code": -1,
            }
        except Exception as e:
            return {
                "success": False,
                "stdout": "",
                "stderr": str(e),
                "exit_code": -1,
            }
    
    # Проверяем сессию
    existing_session = get_session_info()
    db_info = get_database_info()
    
    # Загружаем персонализацию
    personalization = load_personalization()
    
    if existing_session.get('exists'):
        session_info['is_new'] = False
        session_info['session_id'] = existing_session.get('sessionId')
        session_info['database'] = db_info
        
        session_context = f"""
🔄 ПРОДОЛЖЕНИЕ РАБОТЫ

У вас есть существующее окружение с сохраненными данными.

📊 Информация о сессии:
- ID сессии: {existing_session.get('sessionId')}
- Создана: {existing_session.get('created')}
- Выполнено команд: {existing_session.get('commandCount', 0)}
- Возраст: {existing_session.get('age')}

🗄️ База данных PostgreSQL:
- Database: {db_info.get('database', 'N/A')}
- Host: {db_info.get('host', 'N/A')}:{db_info.get('port', 'N/A')}
- Переменные окружения настроены: $DATABASE_URL, $PGHOST, $PGPORT, $PGDATABASE

⚠️ ВАЖНО:
1. Проверь существующие файлы: ls -la /workspace
2. Проверь структуру папок: ls -la /workspace/*/
3. Проверь таблицы в БД: psql -c "\\dt"
"""
    else:
        session_info['is_new'] = True
        session_info['database'] = db_info
        
        session_context = f"""
🆕 НОВОЕ ОКРУЖЕНИЕ

Создается новое окружение со всеми инструментами.

🗄️ База данных PostgreSQL:
- Database: {db_info.get('database', 'N/A')}
- Переменные окружения: $DATABASE_URL, $PGHOST, $PGUSER, $PGPASSWORD
- Подключение: psql (без параметров)

🐍 Доступно:
- Python 3.11 + pip
- PostgreSQL client (psql)
- Библиотеки: pandas, numpy, psycopg2, sqlalchemy, requests
- Утилиты: curl, wget, git, vim, nano

📁 Структура директорий в /workspace:
- /workspace/input - для входных файлов (загруженных пользователем)
- /workspace/output - для итоговых результатов (только финальные файлы)
- /workspace/work - для рабочих файлов (скрипты, промежуточные данные)
- /workspace/log - для логов и отладочной информации
- /workspace/tmp - для временных файлов
- /tmp - системная временная директория
"""
    
    # Формируем персонализированный контекст
    personalization_context = ""
    
    if personalization:
        personalization_context = "\n" + "=" * 80 + "\n"
        personalization_context += "📋 ПЕРСОНАЛИЗАЦИЯ АГЕНТА\n"
        personalization_context += "=" * 80 + "\n\n"
        
        if "IDENTITY.md" in personalization:
            personalization_context += f"👤 ТВОЯ ЛИЧНОСТЬ:\n{personalization['IDENTITY.md']}\n\n"
        
        if "SOUL.md" in personalization:
            personalization_context += f"💫 ТВОЙ ХАРАКТЕР И ДУША:\n{personalization['SOUL.md']}\n\n"
        
        if "USER.md" in personalization:
            personalization_context += f"🤝 О ПОЛЬЗОВАТЕЛЕ:\n{personalization['USER.md']}\n\n"
        
        if "MEMORY.md" in personalization:
            personalization_context += f"🔐 ВАЖНАЯ ИНФОРМАЦИЯ (токены, пароли, регламенты):\n{personalization['MEMORY.md']}\n\n"
        
        personalization_context += "=" * 80 + "\n"
        personalization_context += "⚠️ Эту информацию ты ВСЕГДА должен учитывать в работе!\n"
        personalization_context += "💡 Ты можешь обновлять эти файлы командами:\n"
        personalization_context += "   cat > /workspace/SOUL.md <<'EOF' ... EOF\n"
        personalization_context += "   cat > /workspace/USER.md <<'EOF' ... EOF\n"
        personalization_context += "=" * 80 + "\n"
    
    tools = [{
        "type": "function",
        "function": {
            "name": "execute_bash_command",
            "description": "Выполняет bash команду в персональном окружении с Python, PostgreSQL и всеми инструментами",
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {
                        "type": "string",
                        "description": "Bash команда для выполнения"
                    },
                    "reasoning": {
                        "type": "string",
                        "description": "Зачем выполняется эта команда"
                    }
                },
                "required": ["command", "reasoning"]
            }
        }
    }]
    
    system_prompt = f"""{personalization_context}

{session_context}

🎯 ТВОЯ ЗАДАЧА: {task}

📋 КЛЮЧЕВЫЕ ПРАВИЛА:

1. **СТРУКТУРА ПАПОК И СОЗДАНИЕ ФАЙЛОВ:**
   📁 Используй правильные директории:
   - /workspace/input - входные файлы (загруженные пользователем)
   - /workspace/output - ТОЛЬКО итоговые результаты (Excel, PDF, финальные отчеты)
   - /workspace/work - рабочие скрипты и промежуточные файлы
   - /workspace/log - логи, отладочная информация
   - /workspace/tmp - временные файлы
   
   ✅ Примеры:
   - Скрипт: cat > /workspace/work/script.py <<'EOF' ... EOF
   - Результат: /workspace/output/report.xlsx
   - Логи: echo "Debug info" >> /workspace/log/debug.log
   
   ❌ НЕ создавай файлы в корне /workspace (кроме SOUL.md, USER.md и т.д.)
   ❌ НЕ используй echo для сложного содержимого

2. **РАБОТА С ПЕРСОНАЛИЗАЦИЕЙ:**
   - Файлы SOUL.md, USER.md, IDENTITY.md, MEMORY.md - это ТВОЯ личность
   - Всегда учитывай информацию из этих файлов
   - Можешь обновлять их по запросу пользователя
   - Примеры обновления:
     cat > /workspace/SOUL.md <<'EOF'
     Я добрый и отзывчивый помощник...
     EOF

3. **РАБОТА С POSTGRESQL:**
   - Подключение: psql (настроено автоматически)
   - Python: import psycopg2; conn = psycopg2.connect(os.environ['DATABASE_URL'])
   - Создание таблиц, запросы, анализ данных

4. **РАБОТА С ФАЙЛАМИ:**
   - Пользователь может загружать файлы через веб-интерфейс (попадают в /workspace/input)
   - Проверяй входные файлы: ls -la /workspace/input
   - Итоговые результаты сохраняй в /workspace/output
   - Рабочие скрипты создавай в /workspace/work
   - Всегда указывай в финальном отчете путь к результатам: /workspace/output/...

5. **PYTHON + БИБЛИОТЕКИ:**
   - Python 3.11, pip доступен
   - Предустановлены: pandas, numpy, requests, psycopg2, sqlalchemy
   - Установка новых: pip install library

6. **ПРОВЕРКА РЕЗУЛЬТАТОВ:**
   - После создания файла ОБЯЗАТЕЛЬНО проверь его наличие: ls -la /workspace/output (или путь к файлу)
   - Если ls показывает пустую папку или файла нет — НЕ пиши «ЗАДАЧА ВЫПОЛНЕНА», пиши «ЗАДАЧА НЕ ВЫПОЛНЕНА»
   - После SQL: psql -c "\\dt"
   - Всегда проверяй что сделал перед финальным отчётом

7. **ФИНАЛЬНЫЙ ОТЧЕТ:**
   "ЗАДАЧА ВЫПОЛНЕНА: [что сделано, где файлы, какие таблицы]" — только если файл реально создан (проверено через ls)
   или
   "ЗАДАЧА НЕ ВЫПОЛНЕНА: [причина]"

Начинай работу!"""
    
    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": f"Выполни задачу: {task}"}
    ]
    
    attempt = 0
    final_report = ""
    task_status = "in_progress"
    
    try:
        while attempt < max_attempts and task_status == "in_progress":
            attempt += 1
            
            response = client.chat.completions.create(
                model=model,
                messages=messages,
                tools=tools,
                temperature=0.0
            )
            
            if response.usage:
                usage_stats["prompt_tokens"] += response.usage.prompt_tokens
                usage_stats["completion_tokens"] += response.usage.completion_tokens
                usage_stats["total_tokens"] += response.usage.total_tokens
                usage_stats["api_calls"] += 1
            
            message = response.choices[0].message
            
            if message.tool_calls:
                messages.append({
                    "role": "assistant",
                    "content": message.content,
                    "tool_calls": [
                        {
                            "id": tc.id,
                            "type": tc.type,
                            "function": {
                                "name": tc.function.name,
                                "arguments": tc.function.arguments
                            }
                        }
                        for tc in message.tool_calls
                    ]
                })
                
                for tool_call in message.tool_calls:
                    if tool_call.function.name == "execute_bash_command":
                        function_args = json.loads(tool_call.function.arguments)
                        command = function_args.get('command', '')
                        reasoning = function_args.get('reasoning', '')
                        
                        result = execute_bash(command)
                        
                        command_history.append({
                            "attempt": attempt,
                            "command": command,
                            "reasoning": reasoning,
                            "result": result
                        })
                        
                        if result['success']:
                            if result['stdout']:
                                function_response = f"✅ Команда выполнена (#{result.get('command_number', '?')})\n\n{result['stdout']}"
                            else:
                                function_response = f"✅ Команда выполнена (#{result.get('command_number', '?')})"
                        else:
                            error_msg = result['stderr'] if result['stderr'] else "Неизвестная ошибка"
                            function_response = f"❌ Ошибка (exit code: {result['exit_code']})\n\n{error_msg}"
                        
                        messages.append({
                            "role": "tool",
                            "tool_call_id": tool_call.id,
                            "content": function_response
                        })
            
            elif message.content:
                content = message.content.strip()
                
                if "ЗАДАЧА ВЫПОЛНЕНА:" in content or "ЗАДАЧА ВЫПОЛНЕНА." in content:
                    final_report = content
                    task_status = "done"
                elif "ЗАДАЧА НЕ ВЫПОЛНЕНА:" in content:
                    final_report = content
                    task_status = "failed"
                else:
                    messages.append({"role": "assistant", "content": content})
        
        if task_status == "in_progress":
            messages.append({
                "role": "user",
                "content": f"Достигнут лимит команд ({max_attempts}). Подведи итоги."
            })
            
            response = client.chat.completions.create(
                model=model,
                messages=messages,
                temperature=0.0
            )
            
            if response.usage:
                usage_stats["prompt_tokens"] += response.usage.prompt_tokens
                usage_stats["completion_tokens"] += response.usage.completion_tokens
                usage_stats["total_tokens"] += response.usage.total_tokens
                usage_stats["api_calls"] += 1
            
            final_report = response.choices[0].message.content
            task_status = "done" if "ЗАДАЧА ВЫПОЛНЕНА:" in final_report else "failed"
    
    except Exception as e:
        final_report = f"❌ КРИТИЧЕСКАЯ ОШИБКА: {str(e)}"
        task_status = "error"
    
    # Финальная информация
    final_session = get_session_info()
    
    report_lines = [
        "=" * 80,
        "🤖 AI BASH AGENT v4 - ПЕРСОНАЛИЗИРОВАННЫЙ ПОМОЩНИК",
        "=" * 80,
        f"\n👤 Пользователь: {chat_id}",
        f"🆔 Сессия: {session_info.get('session_id', 'N/A')}",
        f"🗄️  База данных: {db_info.get('database', 'N/A')}",
    ]
    
    if personalization:
        report_lines.append("\n📋 Активная персонализация:")
        for filename, description in PERSONALIZATION_FILES.items():
            if filename in personalization:
                report_lines.append(f"   ✅ {filename} - {description}")
    
    report_lines.extend([
        f"\n📋 Задача: {task}",
        f"⚙️  Модель: {model}",
        f"\n📊 Статистика:",
        f"   • Команд выполнено: {len(command_history)}/{max_attempts}",
        f"   • Всего в сессии: {final_session.get('commandCount', 'N/A')}",
        f"\n💰 Использование API:",
        f"   • Запросов: {usage_stats['api_calls']}",
        f"   • Токенов: {usage_stats['total_tokens']:,}",
    ])
    
    if len(command_history) > 0:
        report_lines.extend([
            "\n" + "=" * 80,
            "📝 ИСТОРИЯ КОМАНД:",
            "=" * 80
        ])
        
        for i, cmd in enumerate(command_history, 1):
            status_icon = "✅" if cmd['result']['success'] else "❌"
            report_lines.append(f"\n[{i}] {status_icon} Попытка #{cmd['attempt']}")
            report_lines.append(f"    💭 {cmd['reasoning']}")
            report_lines.append(f"    ⚡ {cmd['command']}")
            
            if cmd['result']['success']:
                if cmd['result']['stdout']:
                    output = cmd['result']['stdout']
                    preview = output[:300] + "..." if len(output) > 300 else output
                    report_lines.append(f"    📤 Вывод:\n{preview}")
            else:
                error = cmd['result']['stderr']
                preview = error[:300] + "..." if len(error) > 300 else error
                report_lines.append(f"    ⚠️  Ошибка:\n{preview}")
    
    report_lines.extend([
        "\n" + "=" * 80,
        "🎯 ИТОГОВЫЙ РЕЗУЛЬТАТ:",
        "=" * 80,
        final_report,
        "\n" + "=" * 80,
        "\n💡 ПОЛЕЗНАЯ ИНФОРМАЦИЯ:",
        f"   • Окружение: {chat_id}",
        f"   • Файлы: раздел «Файлы» в интерфейсе (https://ai.bash.atiks.org) — там папка /workspace/output; если задача не выполнена, файлов там не будет.",
        f"   • База данных: {db_info.get('database', 'N/A')}",
    ])
    
    if personalization:
        report_lines.append("\n📋 Персонализация активна:")
        for filename in PERSONALIZATION_FILES.keys():
            if filename in personalization:
                report_lines.append(f"   • {filename} ✓")
    
    report_lines.append("=" * 80)
    
    return {
        "result": "\n".join(report_lines),
        "status": task_status,
        "usage": usage_stats,
        "session": {
            "chat_id": chat_id,
            "session_id": session_info.get('session_id'),
            "is_new": session_info.get('is_new'),
            "database": db_info,
            "personalization": list(personalization.keys()),
            "total_commands": final_session.get('commandCount', 0)
        },
        "commands_executed": len(command_history)
    }