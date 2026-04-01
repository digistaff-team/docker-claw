// Скрипт для проверки настроек модератора VK
const manageStore = require('./manage/store');

async function checkModeratorSettings() {
    await manageStore.load();
    
    const allStates = manageStore.getAllStates();
    console.log('=== Все chatId в системе ===');
    console.log(Object.keys(allStates));
    console.log('');
    
    for (const [chatId, data] of Object.entries(allStates)) {
        const vkSettings = manageStore.getVkSettings?.(chatId) || {};
        const contentSettings = data.contentSettings || {};
        const verifiedTelegramId = data.verifiedTelegramId;
        
        console.log(`=== chatId: ${chatId} ===`);
        console.log(`  verifiedTelegramId: ${verifiedTelegramId}`);
        console.log(`  vkSettings.moderatorUserId: ${vkSettings.moderatorUserId}`);
        console.log(`  vkSettings.moderator_user_id: ${vkSettings.moderator_user_id}`);
        console.log(`  contentSettings.moderatorUserId: ${contentSettings.moderatorUserId}`);
        console.log(`  vkDrafts: ${JSON.stringify(Object.keys(data.vkDrafts || {}))}`);
        console.log('');
    }
    
    // Проверка для конкретного пользователя из логов
    const moderatorId = '399444307';
    console.log(`=== Поиск где модератор ${moderatorId} имеет доступ ===`);
    
    for (const [chatId, data] of Object.entries(allStates)) {
        const vkSettings = manageStore.getVkSettings?.(chatId) || {};
        const contentSettings = data.contentSettings || {};
        const channelModeratorId = vkSettings.moderatorUserId || contentSettings.moderatorUserId;
        const ownerTgId = String(data.verifiedTelegramId || '');
        const allowedIds = new Set([ownerTgId, channelModeratorId].filter(Boolean));
        
        if (allowedIds.has(moderatorId)) {
            console.log(`  ✓ chatId=${chatId} (owner=${ownerTgId}, moderator=${channelModeratorId})`);
        }
    }
    
    process.exit(0);
}

checkModeratorSettings().catch(err => {
    console.error('Error:', err);
    process.exit(1);
});
