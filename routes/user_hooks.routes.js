const express = require('express');
const router = express.Router();
const sessionService = require('../services/session.service');
const dockerService = require('../services/docker.service');

// Обработка любых запросов на /hook/:chatId/*
router.all('/:chatId*', async (req, res) => {
    const { chatId } = req.params;
    
    // Проверяем, существует ли сессия (контейнер) для данного chatId
    const session = sessionService.getSession(chatId);
    if (!session) {
        return res.status(404).json({ error: 'Container not found or inactive for this user.' });
    }

    // Собираем данные о запросе
    const requestData = {
        method: req.method,
        path: req.path.replace(`/${chatId}`, '') || '/',
        query: req.query,
        headers: req.headers,
        body: req.body
    };

    const requestJson = JSON.stringify(requestData);
    const base64Data = Buffer.from(requestJson).toString('base64');
    
    // Используем /tmp (tmpfs, rw для node) вместо /workspace/tmp (bind mount, может быть root:root)
    const tmpFileName = `/tmp/req_${Date.now()}_${Math.random().toString(36).substring(7)}.json`;

    try {
        // 1. Сохраняем данные во временный файл в контейнере
        const writeCmd = `echo '${base64Data}' | base64 -d > ${tmpFileName}`;
        const writeResult = await dockerService.executeInContainer(session.containerId, writeCmd, 10);
        
        if (!writeResult.success) {
            console.error(`[USER_HOOK] Failed to write request data: ${writeResult.stderr}`);
            return res.status(500).json({ error: 'Failed to process request data internally.' });
        }

        // 2. Проверяем наличие обработчика (сначала JS, потом PY)
        const checkHandlerCmd = `
            if [ -f /workspace/webhook_handler.js ]; then
                echo "js"
            elif [ -f /workspace/webhook_handler.py ]; then
                echo "py"
            else
                echo "not_found"
            fi
        `;
        const checkResult = await dockerService.executeInContainer(session.containerId, checkHandlerCmd, 5);
        const handlerType = checkResult.stdout.trim();
        
        if (handlerType === 'not_found') {
            return res.status(404).json({ 
                error: 'Webhook handler not found.', 
                message: 'The AI agent has not created /workspace/webhook_handler.js or /workspace/webhook_handler.py yet.' 
            });
        }

        // 3. Выполняем обработчик
        let runCmd = '';
        if (handlerType === 'js') {
            runCmd = `node /workspace/webhook_handler.js ${tmpFileName}`;
        } else {
            runCmd = `python3 /workspace/webhook_handler.py ${tmpFileName}`;
        }
        
        const runResult = await dockerService.executeInContainer(session.containerId, runCmd, 30); // 30 сек таймаут

        // 4. Удаляем временный файл
        await dockerService.executeInContainer(session.containerId, `rm -f ${tmpFileName}`, 5);

        // 5. Формируем ответ
        if (!runResult.success && runResult.exitCode !== 0) {
            console.error(`[USER_HOOK] Handler error: ${runResult.stderr}`);
            return res.status(500).json({ 
                error: 'Webhook handler execution failed.',
                stderr: runResult.stderr,
                stdout: runResult.stdout
            });
        }

        const output = runResult.stdout.trim();
        
        // Пытаемся распарсить как JSON, если получается - отдаем как JSON
        try {
            const jsonOutput = JSON.parse(output);
            return res.json(jsonOutput);
        } catch (e) {
            // Если не JSON, отдаем как обычный текст
            return res.send(output);
        }

    } catch (error) {
        console.error(`[USER_HOOK] Unexpected error:`, error);
        return res.status(500).json({ error: 'Internal server error processing webhook.' });
    }
});

module.exports = router;
