/**
 * Настройка AI провайдера на OpenAI для пользователя
 */
const manageStore = require('./manage/store');

async function setupOpenAI(chatId) {
  await manageStore.load();
  
  const state = manageStore.getState(chatId) || {};
  
  // Настраиваем на прямой OpenAI API
  state.aiProvider = 'openai';
  state.aiModel = 'gpt-4o-mini'; // Более дешёвая модель для тестов
  state.aiCustomApiKey = process.env.OPENAI_API_KEY;
  state.aiAuthToken = null; // Очищаем ProTalk токен
  state.aiUserEmail = null; // Не нужно для прямого API
  
  // Сохраняем
  const allStates = manageStore.getAllStates();
  allStates[chatId] = state;
  await manageStore.persist(chatId);
  
  console.log('✅ AI провайдер настроен:');
  console.log(`   Provider: ${state.aiProvider}`);
  console.log(`   Model: ${state.aiModel}`);
  console.log(`   API Key: ${state.aiCustomApiKey?.substring(0, 15)}...`);
  
  return state;
}

// Запуск
const chatId = process.argv[2] || '128247430';
console.log(`🔧 Настройка AI провайдера для chatId: ${chatId}\n`);

setupOpenAI(chatId)
  .then(() => {
    console.log('\n✅ Готово! Теперь можно запустить генерацию.');
    console.log('\nКоманда для запуска:');
    console.log(`   curl -X POST "https://clientzavod.ru/api/content/run-now" \\`);
    console.log(`     -H "Content-Type: application/json" \\`);
    console.log(`     -H "Authorization: Bearer 8092697980" \\`);
    console.log(`     -d '{"chat_id":"${chatId}","reason":"manual_openai_test"}'`);
  })
  .catch(console.error);
