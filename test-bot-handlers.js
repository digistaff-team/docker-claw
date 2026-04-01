// Тест для проверки работы CW-бота и обработчиков callback
require('dotenv').config();
const manageStore = require('./manage/store');

async function testBotHandlers() {
    await manageStore.load();
    
    const cwBotToken = process.env.CW_BOT_TOKEN;
    console.log('=== Проверка CW-бота ===');
    console.log('CW_BOT_TOKEN:', cwBotToken ? cwBotToken.substring(0, 20) + '...' : 'NOT SET');
    
    if (!cwBotToken) {
        console.log('❌ CW_BOT_TOKEN не настроен');
        process.exit(1);
    }
    
    // Проверка состояния пользователя
    const userId = '399444307';
    const state = manageStore.getState(userId);
    console.log('\n=== Состояние пользователя', userId, '===');
    console.log('token:', state?.token ? state.token.substring(0, 20) + '...' : 'NOT SET');
    console.log('verifiedTelegramId:', state?.verifiedTelegramId);
    console.log('vkDrafts:', Object.keys(state?.vkDrafts || {}));
    
    // Проверка настроек VK
    const vkSettings = manageStore.getVkSettings?.(userId);
    console.log('\n=== Настройки VK ===');
    console.log('moderatorUserId:', vkSettings?.moderatorUserId);
    console.log('premoderationEnabled:', vkSettings?.premoderationEnabled);
    
    // Проверка: совпадает ли токен пользователя с CW_BOT_TOKEN
    const userToken = state?.token;
    const isCwBotUser = userToken === cwBotToken;
    console.log('\n=== Проверка типа бота ===');
    console.log('Пользователь использует CW-бота:', isCwBotUser ? '✅ ДА' : '❌ НЕТ');
    
    // Проверка: имеет ли модератор доступ к черновикам
    const moderatorId = '399444307';
    const drafts = state?.vkDrafts || {};
    const hasDrafts = Object.keys(drafts).length > 0;
    
    console.log('\n=== Проверка доступа модератора ===');
    console.log('Модератор ID:', moderatorId);
    console.log('Есть черновики:', hasDrafts ? '✅ ДА (' + Object.keys(drafts).length + ')' : '❌ НЕТ');
    
    if (hasDrafts) {
        console.log('ID черновиков:', Object.keys(drafts));
        
        // Проверка доступа для каждого черновика
        for (const [jobId, draft] of Object.entries(drafts)) {
            const channelModeratorId = vkSettings?.moderatorUserId || state?.contentSettings?.moderatorUserId;
            const ownerTgId = String(state?.verifiedTelegramId || '');
            const allowedIds = new Set([ownerTgId, channelModeratorId].filter(Boolean));
            const hasAccess = allowedIds.has(moderatorId);
            
            console.log(`  - jobId=${jobId}: доступ=${hasAccess ? '✅' : '❌'} (owner=${ownerTgId}, moderator=${channelModeratorId})`);
        }
    }
    
    console.log('\n=== ВЫВОД ===');
    if (isCwBotUser && hasDrafts) {
        console.log('✅ Все условия выполнены:');
        console.log('   1. Пользователь использует CW-бота');
        console.log('   2. Черновики есть в памяти');
        console.log('   3. Модератор имеет доступ');
        console.log('\nЕсли модератор нажал "Одобрить", но публикация не вышла,');
        console.log('проверьте логи CW-бота после нажатия кнопки.');
        console.log('\nИщите строки:');
        console.log('   [CW-BOT-VK] approve job 23');
        console.log('   [CW-BOT-VK] Searching in');
        console.log('   [VK-MODERATION-ACTION]');
    } else {
        console.log('❌ Проблема найдена!');
        if (!isCwBotUser) {
            console.log('   - Пользователь НЕ использует CW-бота');
            console.log('   - Обработчик может быть в runner.js, а не в server.js');
        }
        if (!hasDrafts) {
            console.log('   - Черновики ОТСУТСТВУЮТ в памяти');
            console.log('   - Состояние не загрузилось из файла');
        }
    }
    
    process.exit(0);
}

testBotHandlers().catch(err => {
    console.error('Error:', err);
    process.exit(1);
});
