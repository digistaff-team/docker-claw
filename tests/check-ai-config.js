/**
 * Проверка настроек AI для пользователя
 */
const manageStore = require('./manage/store');

async function checkAIConfig(chatId) {
  await manageStore.load();
  const state = manageStore.getState(chatId);
  
  console.log('=== AI CONFIGURATION ===');
  console.log(`chatId: ${chatId}`);
  console.log(`aiProvider: ${state?.aiProvider || 'NOT SET'}`);
  console.log(`aiModel: ${state?.aiModel || 'NOT SET'}`);
  console.log(`aiCustomApiKey: ${state?.aiCustomApiKey ? state.aiCustomApiKey.substring(0, 15) + '...' : 'NOT SET'}`);
  console.log(`aiAuthToken: ${state?.aiAuthToken ? state.aiAuthToken.substring(0, 15) + '...' : 'NOT SET'}`);
  console.log(`aiUserEmail: ${state?.aiUserEmail || 'NOT SET'}`);
  
  // Проверка через getProviderConfig
  const aiRouterService = require('./services/ai_router_service');
  // getProviderConfig не экспортируется, поэтому проверим вручную
  const provider = state?.aiProvider || 'protalk';
  console.log(`\n=== EFFECTIVE PROVIDER ===`);
  console.log(`Provider: ${provider}`);
  
  if (provider === 'openai') {
    console.log('✅ Should use direct OpenAI API');
    console.log(`   URL: https://api.openai.com/v1/chat/completions`);
  } else if (provider === 'openrouter') {
    console.log('✅ Should use OpenRouter API');
    console.log(`   URL: https://openrouter.ai/api/v1/chat/completions`);
  } else {
    console.log('⚠️  Using ProTalk (AI Router)');
    console.log(`   URL: https://ai.pro-talk.ru/api/router`);
  }
}

const chatId = process.argv[2] || '128247430';
checkAIConfig(chatId).catch(console.error);
