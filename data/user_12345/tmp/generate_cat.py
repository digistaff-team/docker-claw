import requests, time, random, string, re, os

def run_function_api_long(f_id, bot_id, token, args, host="api.pro-talk.ru", timeout=300):
    task_id = f"f{f_id}_task_{''.join(random.choices(string.ascii_lowercase+string.digits, k=9))}"
    start = time.time()
    try:
        requests.post("https://eu1.account.dialog.ai.atiks.org/proxy/tasks", json={
            "bot_id": bot_id, "bot_token": token, "task_type": "api_call", "repeat": "Once",
            "trigger_id": str(int(time.time()*1000)),
            "parameters": {"api_url": f"https://{host}/api/v1.0/run_function", "method": "POST",
                           "payload": {"function_id": f_id, "functions_base_id": "appkq3HrzrxYxoAV8",
                                       "bot_id": bot_id, "bot_token": token,
                                       "arguments": {"task_id": task_id, **args}}}}).raise_for_status()
    except Exception as e:
        return {"success": False, "error": f"task_create_failed: {e}", "task_id": task_id}
    
    while time.time() - start < timeout:
        time.sleep(8)
        try:
            r = requests.post(f"https://{host}/api/v1.0/get_function_result", json={
                "task_id": task_id, "bot_id": bot_id, "bot_token": token, "dialogs_api_host": host}).json()
        except:
            continue
        s = r.get("status")
        if s == "done":
            return {"success": True, "result": r, "task_id": task_id}
        if s == "error":
            return {"success": False, "error": r.get("error"), "task_id": task_id}
    return {"success": False, "error": "timeout", "task_id": task_id}

# Генерация изображения
f_id = 15
bot_id = 23141
token = '6MlW32uxn2Kjd94tm9KYyIM9HgCyXD11'
args = {'query': 'кот в военной форме'}

print(f"[INFO] Запуск генерации: {args['query']}")
result = run_function_api_long(f_id, bot_id, token, args)

if result['success']:
    print("[SUCCESS] Изображение сгенерировано")
    # Ищем URL в результате
    result_text = str(result['result'])
    url_match = re.search(r'URL\s*:\s*(https?://[^\s"\'<>;,]+)', result_text)
    
    if url_match:
        img_url = url_match.group(1)
        print(f"[INFO] URL изображения: {img_url}")
        
        # Скачиваем изображение
        os.makedirs('/workspace/output', exist_ok=True)
        output_path = '/workspace/output/cat_military.jpg'
        
        for attempt in range(3):
            try:
                img_data = requests.get(img_url, timeout=30).content
                with open(output_path, 'wb') as f:
                    f.write(img_data)
                print(f"[SUCCESS] Изображение сохранено: {output_path}")
                break
            except Exception as e:
                print(f"[WARN] Попытка {attempt+1} не удалась: {e}")
                time.sleep(2)
        else:
            print("[ERROR] Не удалось скачать изображение")
    else:
        print("[ERROR] URL не найден в ответе")
        print(f"[DEBUG] Ответ: {result_text[:500]}")
else:
    print(f"[ERROR] {result.get('error')}")
