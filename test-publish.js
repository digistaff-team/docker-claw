/**
 * Тестовый скрипт для проверки процесса ручной публикации в Telegram
 * 
 * Использование:
 *   node test-publish.js <chatId>
 * 
 * Пример:
 *   node test-publish.js 128247430
 */

const fetch = require('node-fetch');

const API_URL = 'https://clientzavod.ru';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '8092697980';

// Получаем chatId из аргументов командной строки
const chatId = process.argv[2];

if (!chatId) {
  console.error('❌ Ошибка: Не указан chatId');
  console.error('Использование: node test-publish.js <chatId>');
  console.error('Пример: node test-publish.js 128247430');
  process.exit(1);
}

console.log('🧪 Тестирование процесса ручной публикации в Telegram');
console.log('='.repeat(60));
console.log(`Chat ID: ${chatId}`);
console.log(`API URL: ${API_URL}`);
console.log('='.repeat(60));

async function testStep(name, fn) {
  console.log(`\n📍 Шаг: ${name}`);
  try {
    const result = await fn();
    console.log(`✅ Успешно`);
    return result;
  } catch (e) {
    console.error(`❌ Ошибка: ${e.message}`);
    throw e;
  }
}

async function main() {
  const results = {};

  // Шаг 1: Проверка доступности API
  await testStep('Проверка доступности API', async () => {
    const res = await fetch(`${API_URL}/api/health`);
    if (!res.ok) {
      throw new Error(`API недоступен (status: ${res.status})`);
    }
    console.log('   API доступен');
  });

  // Шаг 2: Проверка состояния контейнера пользователя
  results.containerInfo = await testStep('Проверка состояния контейнера', async () => {
    const res = await fetch(`${API_URL}/admin/container/${chatId}/info`, {
      headers: {
        'Authorization': `Bearer ${ADMIN_PASSWORD}`
      }
    });
    
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Failed to get container info: ${err}`);
    }
    
    const info = await res.json();
    console.log(`   Статус контейнера: ${info.status}`);
    console.log(`   Container ID: ${info.containerId?.substring(0, 12) || 'N/A'}`);
    console.log(`   Python3: ${info.session?.hasPython3 ? '✅' : '❌'}`);
    
    if (info.status !== 'running') {
      console.warn('   ⚠️  Контейнер не запущен!');
    }
    
    return info;
  });

  // Шаг 3: Проверка наличия тем для публикаций
  results.topics = await testStep('Проверка наличия тем', async () => {
    const res = await fetch(`${API_URL}/api/content/topics?chat_id=${chatId}&status=pending&limit=5`);
    
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Failed to get topics: ${err}`);
    }
    
    const data = await res.json();
    const topics = data.topics || [];
    console.log(`   Найдено тем: ${topics.length}`);
    
    if (topics.length > 0) {
      console.log('   Доступные темы:');
      topics.forEach((t, i) => {
        console.log(`     ${i + 1}. ${t.topic}`);
      });
    } else {
      console.warn('   ⚠️  Нет доступных тем со статусом "pending"');
    }
    
    return topics;
  });

  // Шаг 4: Проверка наличия материалов
  results.materials = await testStep('Проверка наличия материалов', async () => {
    const res = await fetch(`${API_URL}/api/content/materials?chat_id=${chatId}&limit=5`);
    
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Failed to get materials: ${err}`);
    }
    
    const data = await res.json();
    const materials = data.materials || [];
    console.log(`   Найдено материалов: ${materials.length}`);
    
    if (materials.length > 0) {
      materials.forEach((m, i) => {
        console.log(`     ${i + 1}. ${m.title || m.content?.substring(0, 50) + '...'}`);
      });
    } else {
      console.warn('   ⚠️  Нет материалов для генерации постов');
    }
    
    return materials;
  });

  // Шаг 5: Проверка метрик (вместо limits)
  results.metrics = await testStep('Проверка метрик', async () => {
    const res = await fetch(`${API_URL}/api/content/metrics?chat_id=${chatId}`);
    
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Failed to get metrics: ${err}`);
    }
    
    const data = await res.json();
    const pub24h = data.windows?.last24h || {};
    console.log(`   Публикаций за 24ч: ${pub24h.published || 0}`);
    console.log(`   Failed за 24ч: ${pub24h.failed || 0}`);
    console.log(`   Success rate: ${pub24h.success_rate ? (pub24h.success_rate * 100).toFixed(1) + '%' : 'N/A'}`);
    
    return data;
  });

  // Шаг 6: Запуск ручной публикации
  console.log('\n📍 Шаг: Запуск ручной публикации');
  console.log('   Отправка задачи генерации в очередь...');
  
  try {
    const res = await fetch(`${API_URL}/api/content/run-now`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ADMIN_PASSWORD}`
      },
      body: JSON.stringify({
        chat_id: chatId,
        reason: 'manual_test'
      })
    });
    
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Failed to run now: ${err}`);
    }
    
    const result = await res.json();
    console.log(`✅ Задача поставлена в очередь`);
    console.log(`   Queue Job ID: ${result.queueJobId}`);
    console.log(`   Correlation ID: ${result.correlationId}`);
    console.log(`   Message: ${result.message}`);
    
    results.runNow = result;
  } catch (e) {
    console.error(`❌ Ошибка запуска: ${e.message}`);
    results.runNow = { error: e.message };
  }

  // Шаг 7: Проверка очереди задач
  results.jobs = await testStep('Проверка очереди задач', async () => {
    const res = await fetch(`${API_URL}/api/content/jobs?chat_id=${chatId}&status=pending&limit=5`);
    
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Failed to get jobs: ${err}`);
    }
    
    const data = await res.json();
    const jobs = data.jobs || [];
    console.log(`   Задач в очереди: ${jobs.length}`);
    
    if (jobs.length > 0) {
      jobs.forEach((j, i) => {
        console.log(`     ${i + 1}. Job #${j.id} - ${j.job_type} (status: ${j.status})`);
      });
    }
    
    return jobs;
  });

  // Шаг 8: Проверка логов публикаций (последние 5)
  results.logs = await testStep('Проверка логов публикаций', async () => {
    const res = await fetch(`${API_URL}/admin/container/${chatId}/logs?lines=50`);
    
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Failed to get logs: ${err}`);
    }
    
    const data = await res.json();
    const logs = data.stdout || data.stderr || '';
    
    if (logs) {
      console.log('   Последние логи контейнера:');
      const logLines = logs.split('\n').slice(-5);
      logLines.forEach(line => {
        if (line.trim()) console.log(`     ${line}`);
      });
    }
    
    return logs;
  });

  // Итоговый отчёт
  console.log('\n' + '='.repeat(60));
  console.log('📊 ИТОГОВЫЙ ОТЧЁТ');
  console.log('='.repeat(60));
  console.log(`Контейнер: ${results.containerInfo?.status || 'unknown'}`);
  console.log(`Темы: ${results.topics?.length || 0} доступных`);
  console.log(`Материалы: ${results.materials?.length || 0} доступных`);
  console.log(`Квоты: публикаций ${results.limits?.published || 0}/${results.limits?.dailyLimit || 1}`);
  console.log(`Задача генерации: ${results.runNow?.error ? '❌ ' + results.runNow.error : '✅ запущена'}`);
  console.log(`Задач в очереди: ${results.jobs?.length || 0}`);
  console.log('='.repeat(60));

  // Рекомендации
  console.log('\n📋 РЕКОМЕНДАЦИИ:');
  
  if (!results.containerInfo || results.containerInfo.status !== 'running') {
    console.log('   ⚠️  Запустите контейнер через админ-панель');
  }
  
  if (!results.topics || results.topics.length === 0) {
    console.log('   ⚠️  Добавьте темы для публикаций через /api/content/topics');
  }
  
  if (!results.materials || results.materials.length === 0) {
    console.log('   ⚠️  Добавьте материалы через /api/content/materials');
  }
  
  if (results.runNow?.error) {
    console.log('   ⚠️  Ошибка запуска:', results.runNow.error);
  } else {
    console.log('   ✅ Ожидайте завершения задачи генерации (30-60 секунд)');
    console.log('   ✅ Проверьте черновик в Telegram (сообщение от бота)');
  }
  
  console.log('\n💡 Для проверки статуса задачи выполните:');
  console.log(`   curl "${API_URL}/api/content/jobs?chat_id=${chatId}&limit=5"`);
}

main().catch(e => {
  console.error('\n💥 Тест прерван:', e.message);
  process.exit(1);
});
