const fs = require('fs').promises;
const path = require('path');
const storageService = require('./storage.service');

/**
 * Получает путь к директории планов пользователя
 */
async function getPlansDir(chatId) {
    const userDir = await storageService.ensureUserDir(chatId);
    const plansDir = path.join(userDir, 'plans');
    await fs.mkdir(plansDir, { recursive: true });
    return plansDir;
}

/**
 * Создает новый план
 */
async function createPlan(chatId, goal, steps) {
    const plansDir = await getPlansDir(chatId);
    const planId = Date.now().toString();
    const planPath = path.join(plansDir, `plan_${planId}.md`);
    
    const date = new Date().toISOString();
    
    let content = `# Plan ID: ${planId}\n`;
    content += `**Date:** ${date}\n`;
    content += `**Goal:** ${goal}\n`;
    content += `**Status:** IN_PROGRESS\n\n`;
    
    content += `## Steps\n`;
    steps.forEach((step, index) => {
        content += `${index + 1}. [ ] ${step}\n`;
    });
    
    content += `\n## Debug Log\n`;
    
    await fs.writeFile(planPath, content, 'utf8');
    return planId;
}

/**
 * Читает содержимое плана
 */
async function readPlan(chatId, planId) {
    const plansDir = await getPlansDir(chatId);
    const planPath = path.join(plansDir, `plan_${planId}.md`);
    
    try {
        const content = await fs.readFile(planPath, 'utf8');
        return content;
    } catch (error) {
        if (error.code === 'ENOENT') {
            throw new Error(`Plan ${planId} not found`);
        }
        throw error;
    }
}

/**
 * Обновляет статус шага в плане
 */
async function updateStepStatus(chatId, planId, stepIndex, status, notes) {
    const plansDir = await getPlansDir(chatId);
    const planPath = path.join(plansDir, `plan_${planId}.md`);
    
    let content;
    try {
        content = await fs.readFile(planPath, 'utf8');
    } catch (error) {
        throw new Error(`Plan ${planId} not found`);
    }
    
    const lines = content.split('\n');
    let inSteps = false;
    let currentStepIndex = 0;
    let stepUpdated = false;
    
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith('## Steps')) {
            inSteps = true;
            continue;
        }
        if (inSteps && lines[i].startsWith('## Debug Log')) {
            break;
        }
        
        if (inSteps) {
            // Ищем строки вида "1. [ ] Описание" или "1.1. [ ] Описание"
            const match = lines[i].match(/^(\s*\d+(?:\.\d+)*\.)\s+\[(.)\]\s+(.*)$/);
            if (match) {
                currentStepIndex++;
                if (currentStepIndex === parseInt(stepIndex)) {
                    let statusChar = ' ';
                    if (status === 'IN_PROGRESS') statusChar = '~';
                    else if (status === 'DONE') statusChar = 'x';
                    else if (status === 'FAILED') statusChar = '!';
                    
                    lines[i] = `${match[1]} [${statusChar}] ${match[3]}`;
                    stepUpdated = true;
                    break;
                }
            }
        }
    }
    
    if (!stepUpdated) {
        throw new Error(`Step ${stepIndex} not found in plan ${planId}`);
    }
    
    // Добавляем заметки в Debug Log
    if (notes) {
        const date = new Date().toISOString();
        lines.push(`\n### Step ${stepIndex} Update (${date})`);
        lines.push(`**Status:** ${status}`);
        lines.push(`**Notes:** ${notes}`);
    }
    
    // Проверяем, все ли шаги выполнены
    const allStepsDone = lines.filter(l => l.match(/^\s*\d+(?:\.\d+)*\.\s+\[(.)\]/)).every(l => l.includes('[x]'));
    if (allStepsDone) {
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].startsWith('**Status:**')) {
                lines[i] = '**Status:** DONE';
                break;
            }
        }
    } else if (status === 'FAILED') {
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].startsWith('**Status:**')) {
                lines[i] = '**Status:** PAUSED';
                break;
            }
        }
    } else {
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].startsWith('**Status:**')) {
                lines[i] = '**Status:** IN_PROGRESS';
                break;
            }
        }
    }
    
    await fs.writeFile(planPath, lines.join('\n'), 'utf8');
    return lines.join('\n');
}

/**
 * Добавляет подшаг в план
 */
async function addSubstep(chatId, planId, parentStepIndex, description) {
    const plansDir = await getPlansDir(chatId);
    const planPath = path.join(plansDir, `plan_${planId}.md`);
    
    let content;
    try {
        content = await fs.readFile(planPath, 'utf8');
    } catch (error) {
        throw new Error(`Plan ${planId} not found`);
    }
    
    const lines = content.split('\n');
    let inSteps = false;
    let currentStepIndex = 0;
    let parentLineIndex = -1;
    let parentPrefix = '';
    
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith('## Steps')) {
            inSteps = true;
            continue;
        }
        if (inSteps && lines[i].startsWith('## Debug Log')) {
            break;
        }
        
        if (inSteps) {
            const match = lines[i].match(/^(\s*)(\d+(?:\.\d+)*)\.\s+\[(.)\]\s+(.*)$/);
            if (match) {
                currentStepIndex++;
                if (currentStepIndex === parseInt(parentStepIndex)) {
                    parentLineIndex = i;
                    parentPrefix = match[2];
                    break;
                }
            }
        }
    }
    
    if (parentLineIndex === -1) {
        throw new Error(`Parent step ${parentStepIndex} not found in plan ${planId}`);
    }
    
    // Ищем последний подшаг этого родителя
    let lastSubstepNum = 0;
    let insertIndex = parentLineIndex + 1;
    
    for (let i = parentLineIndex + 1; i < lines.length; i++) {
        if (lines[i].startsWith('## Debug Log')) break;
        
        const match = lines[i].match(new RegExp(`^\\s*${parentPrefix}\\.(\\d+)\\.\\s+\\[.\\]`));
        if (match) {
            lastSubstepNum = Math.max(lastSubstepNum, parseInt(match[1]));
            insertIndex = i + 1;
        } else if (lines[i].match(/^\s*\d+(?:\.\d+)*\.\s+\[.\]/)) {
            // Начался следующий шаг того же или более высокого уровня
            break;
        }
    }
    
    const newSubstepNum = lastSubstepNum + 1;
    const indent = '  '; // Отступ для подшага
    const newSubstepLine = `${indent}${parentPrefix}.${newSubstepNum}. [ ] ${description}`;
    
    lines.splice(insertIndex, 0, newSubstepLine);
    
    await fs.writeFile(planPath, lines.join('\n'), 'utf8');
    return lines.join('\n');
}

/**
 * Возвращает список только АКТИВНЫХ планов пользователя (IN_PROGRESS)
 * Используется для формирования контекста ИИ агента
 */
async function listActivePlans(chatId) {
    const plansDir = await getPlansDir(chatId);
    try {
        const files = await fs.readdir(plansDir);
        const plans = [];
        
        for (const file of files) {
            if (file.startsWith('plan_') && file.endsWith('.md')) {
                const content = await fs.readFile(path.join(plansDir, file), 'utf8');
                const planId = file.replace('plan_', '').replace('.md', '');
                
                let goal = '';
                let status = '';
                let date = '';
                
                const lines = content.split('\n');
                for (const line of lines) {
                    if (line.startsWith('**Goal:**')) goal = line.replace('**Goal:**', '').trim();
                    if (line.startsWith('**Status:**')) status = line.replace('**Status:**', '').trim();
                    if (line.startsWith('**Date:**')) date = line.replace('**Date:**', '').trim();
                }
                
                // Возвращаем только активные (IN_PROGRESS) планы
                if (status === 'IN_PROGRESS') {
                    plans.push({ id: planId, goal, status, date });
                }
            }
        }
        
        return plans;
    } catch (error) {
        if (error.code === 'ENOENT') {
            return [];
        }
        throw error;
    }
}

/**
 * Возвращает список всех планов с полным содержимым за один проход
 * (избегаем N+1 запросов к ФС)
 */
async function getPlansSummary(chatId) {
    const plansDir = await getPlansDir(chatId);
    try {
        const files = await fs.readdir(plansDir);
        const plans = [];

        for (const file of files) {
            if (!file.startsWith('plan_') || !file.endsWith('.md')) continue;

            const filePath = path.join(plansDir, file);
            const content  = await fs.readFile(filePath, 'utf8');
            const planId   = file.replace('plan_', '').replace('.md', '');

            let goal   = '';
            let status = '';
            let date   = '';

            for (const line of content.split('\n')) {
                if (line.startsWith('**Goal:**'))   goal   = line.replace('**Goal:**', '').trim();
                if (line.startsWith('**Status:**')) status = line.replace('**Status:**', '').trim();
                if (line.startsWith('**Date:**'))   date   = line.replace('**Date:**', '').trim();
            }

            plans.push({ id: planId, goal, status, date, content });
        }

        return plans;
    } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
    }
}

/**
 * Удаляет план пользователя по ID
 */
async function deletePlan(chatId, planId) {
    const plansDir = await getPlansDir(chatId);
    const planPath = path.join(plansDir, `plan_${planId}.md`);

    try {
        await fs.unlink(planPath);
    } catch (error) {
        if (error.code === 'ENOENT') {
            throw new Error(`Plan ${planId} not found`);
        }
        throw error;
    }
}

/**
 * Удаляет все завершённые (DONE) и отменённые (PAUSED) планы
 * Возвращает количество удалённых планов
 */
async function cleanupCompletedPlans(chatId) {
    const plansDir = await getPlansDir(chatId);
    console.log(`[CLEANUP] Starting cleanup for ${chatId}, plans dir: ${plansDir}`);
    
    try {
        const files = await fs.readdir(plansDir);
        console.log(`[CLEANUP] Found ${files.length} files in plans dir`);
        
        let deletedCount = 0;
        
        for (const file of files) {
            if (!file.startsWith('plan_') || !file.endsWith('.md')) continue;
            
            const filePath = path.join(plansDir, file);
            const content = await fs.readFile(filePath, 'utf8');
            
            // Ищем статус плана (используем тот же метод, что и в getPlansSummary)
            let status = '';
            for (const line of content.split('\n')) {
                if (line.startsWith('**Status:**')) {
                    status = line.replace('**Status:**', '').trim();
                    break;
                }
            }
            
            console.log(`[CLEANUP] File ${file}, status: "${status}"`);
            
            // Удаляем завершённые или приостановленные планы
            if (status === 'DONE' || status === 'PAUSED') {
                console.log(`[CLEANUP] Deleting ${file} with status ${status}`);
                try {
                    await fs.unlink(filePath);
                    deletedCount++;
                } catch (err) {
                    console.error(`[CLEANUP] Error deleting ${file}:`, err.message);
                }
            }
        }
        
        console.log(`[CLEANUP] Deleted ${deletedCount} plans for ${chatId}`);
        return deletedCount;
    } catch (error) {
        console.error(`[CLEANUP] Error for ${chatId}:`, error);
        if (error.code === 'ENOENT') return 0;
        throw error;
    }
}

module.exports = {
    createPlan,
    readPlan,
    updateStepStatus,
    addSubstep,
    listActivePlans,
    getPlansSummary,
    deletePlan,
    cleanupCompletedPlans,
};
