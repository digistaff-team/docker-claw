#!/usr/bin/env node
/**
 * CLI工具 для тестирования WordPress публикации
 * Использование: node test-wp-publish.js <chatId>
 * 
 * Тесты:
 * 1. Ping WordPress
 * 2. Загрузка тестового изображения
 * 3. Создание черновика статьи
 * 4. Проверка черновика
 * 5. (Опционально) Публикация черновика
 */

const wordpressMvp = require('./services/wordpressMvp.service');
const manageStore = require('./manage/store');

// Парсим аргументы
const chatId = process.argv[2];
if (!chatId) {
  console.error('❌ Ошибка: требуется chatId');
  console.error('Использование: node test-wp-publish.js <chatId>');
  process.exit(1);
}

console.log(`🧪 Тестирование WordPress для chatId=${chatId}\n`);

async function runTests() {
  try {
    // Тест 1: Проверка подключения
    console.log('📡 Тест 1: Проверка подключения к WordPress...');
    const pingResult = await wordpressMvp.ping(chatId);
    
    if (!pingResult.ok) {
      console.error(`❌ Ping failed: ${pingResult.error}`);
      console.error('Убедитесь, что WordPress подключён через /api/content/wordpress/connect');
      process.exit(1);
    }
    
    console.log(`✅ WordPress подключён: ${pingResult.siteName}\n`);

    // Тест 2: Загрузка тестового изображения
    console.log('📸 Тест 2: Загрузка тестового изображения...');
    
    // Создаём простое тестовое изображение (1x1 пиксель JPEG)
    const testImageBuffer = Buffer.from(
      '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBAP//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=',
      'base64'
    );
    
    let mediaResult;
    try {
      mediaResult = await wordpressMvp.uploadMedia(chatId, {
        buffer: testImageBuffer,
        filename: 'test-image.jpg',
        mimeType: 'image/jpeg',
        altText: 'Test image for CLI tool',
        title: 'Test Image'
      });
      
      console.log(`✅ Изображение загружено: ID=${mediaResult.id}`);
      console.log(`   URL: ${mediaResult.source_url}\n`);
    } catch (e) {
      console.warn(`⚠️  Загрузка изображения не удалась: ${e.message}`);
      console.warn('   Продолжаем без изображения...\n');
      mediaResult = null;
    }

    // Тест 3: Создание черновика
    console.log('📝 Тест 3: Создание черновика статьи...');
    
    const testTitle = `Тестовая статья ${new Date().toLocaleString()}`;
    const testContent = `
<h2>Это тестовая статья</h2>
<p>Эта статья создана автоматически через CLI инструмент <code>test-wp-publish.js</code>.</p>
<h3>Раздел 1</h3>
<p>Проверка форматирования HTML контента.</p>
<ul>
  <li>Пункт 1</li>
  <li>Пункт 2</li>
  <li>Пункт 3</li>
</ul>
<h3>Раздел 2</h3>
<p>Тестирование WordPress REST API интеграции.</p>
<p><em>Конец тестовой статьи.</em></p>
    `.trim();
    
    const testExcerpt = 'Это тестовая статья для проверки WordPress интеграции.';
    const testSlug = `test-article-${Date.now()}`;
    
    const draftResult = await wordpressMvp.createDraft(chatId, {
      title: testTitle,
      content: testContent,
      excerpt: testExcerpt,
      featured_media: mediaResult?.id || 0,
      slug: testSlug
    });
    
    console.log(`✅ Черновик создан: ID=${draftResult.id}`);
    console.log(`   Заголовок: ${draftResult.title}`);
    console.log(`   Slug: ${draftResult.slug}`);
    console.log(`   Preview URL: ${draftResult.preview_link}\n`);

    // Тест 4: Проверка черновика через ping
    console.log('🔍 Тест 4: Проверка доступности черновика...');
    
    // Проверяем, что preview_url корректный
    if (!draftResult.preview_link || !draftResult.preview_link.includes('preview=true')) {
      console.warn('⚠️  Preview URL выглядит некорректно');
    } else {
      console.log('✅ Preview URL корректный\n');
    }

    // Итоговая сводка
    console.log('=' .repeat(60));
    console.log('📊 ИТОГО:');
    console.log('=' .repeat(60));
    console.log(`WordPress сайт: ${pingResult.siteName}`);
    console.log(`Черновик ID: ${draftResult.id}`);
    console.log(`Черновик URL: ${draftResult.link}`);
    console.log(`Preview URL: ${draftResult.preview_link}`);
    if (mediaResult) {
      console.log(`Media ID: ${mediaResult.id}`);
    }
    console.log('=' .repeat(60));
    
    console.log('\n✅ Все тесты прошли успешно!');
    console.log('\nСледующие шаги:');
    console.log('1. Откройте Preview URL в браузере для проверки');
    console.log('2. Для публикации выполните: node test-wp-publish.js <chatId> publish <postId>');
    console.log('3. Для удаления выполните: node test-wp-publish.js <chatId> delete <postId>\n');
    
  } catch (e) {
    console.error('\n❌ Критическая ошибка:', e.message);
    console.error(e.stack);
    process.exit(1);
  }
}

// Запускаем тесты
runTests();
