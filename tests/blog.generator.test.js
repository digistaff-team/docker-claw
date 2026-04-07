/**
 * Blog Generator Tests
 * Тесты для blogGenerator.service.js с моками ai_router_service и imageGen
 */
const assert = require('assert');

// ============================================
// Моки зависимостей
// ============================================

// Мокаем ai_router_service
const aiRouterCalls = [];
const mockAiRouterService = {
  processMessage: async (chatId, payload) => {
    aiRouterCalls.push({ chatId, payload });
    const systemMsg = payload.messages?.[0]?.content || '';
    const userMsg = payload.messages?.[1]?.content || '';

    // Имитируем ответы на основе промпта
    if (systemMsg.includes('планировщик') || systemMsg.includes('редактор')) {
      return {
        reply: JSON.stringify({
          target_audience: 'начинающие разработчики',
          structure: 'введение, 3 раздела, заключение',
          key_points: ['точка 1', 'точка 2', 'точка 3'],
          tone: 'технический'
        })
      };
    }
    if (systemMsg.includes('визуальным') || systemMsg.includes('изображения')) {
      return { reply: 'A modern tech illustration with computers and code' };
    }
    if (systemMsg.includes('автор статей') || systemMsg.includes('SEO')) {
      return { reply: '<h2>Introduction</h2><p>Article body here</p><h2>Conclusion</h2>' };
    }
    if (systemMsg.includes('SEO-специалист') && systemMsg.includes('заголовок')) {
      return { reply: 'Как выбрать инструмент: полное руководство' };
    }
    if (systemMsg.includes('SEO-специалист') && systemMsg.includes('описание')) {
      return { reply: 'Подробное руководство по выбору инструментов с примерами.' };
    }
    if (systemMsg.includes('URL-slug') || systemMsg.includes('веб-разработчик')) {
      return { reply: 'kak-vybrat-instrument' };
    }

    return { reply: 'default response' };
  }
};

require.cache[require.resolve('../services/ai_router_service')] = {
  id: require.resolve('../services/ai_router_service'),
  filename: require.resolve('../services/ai_router_service'),
  loaded: true,
  exports: mockAiRouterService
};

// Мокаем imageGen.service
const mockImageGenService = {
  generateCover: async ({ prompt }) => ({
    buffer: Buffer.from('fakeimagedata'),
    mimeType: 'image/png',
    filename: 'cover_test123.png'
  })
};

require.cache[require.resolve('../services/imageGen.service')] = {
  id: require.resolve('../services/imageGen.service'),
  filename: require.resolve('../services/imageGen.service'),
  loaded: true,
  exports: mockImageGenService
};

// Мокаем tokenBilling
const mockTokenBilling = {
  hasBalance: async () => ({ canUse: true, balance: 10000 })
};

require.cache[require.resolve('../manage/tokenBilling')] = {
  id: require.resolve('../manage/tokenBilling'),
  filename: require.resolve('../manage/tokenBilling'),
  loaded: true,
  exports: mockTokenBilling
};

// Мокаем wordpress.repository (пустой)
require.cache[require.resolve('../services/content/wordpress.repository')] = {
  id: require.resolve('../services/content/wordpress.repository'),
  filename: require.resolve('../services/content/wordpress.repository'),
  loaded: true,
  exports: {}
};

// Мокаем content/repository
require.cache[require.resolve('../services/content/repository')] = {
  id: require.resolve('../services/content/repository'),
  filename: require.resolve('../services/content/repository'),
  loaded: true,
  exports: {
    withClient: async (chatId, fn) => fn({ query: async () => ({ rows: [] }) })
  }
};

// Импортируем генератор
const blogGenerator = require('../services/blogGenerator.service');

// ============================================
// Тесты
// ============================================

async function testGenerateReturnsCorrectShape() {
  console.log('Test: generate() returns correct object shape');
  aiRouterCalls.length = 0;

  const result = await blogGenerator.generate('testChat', {
    topic: 'Как выбрать фрезер',
    keywords: 'фрезер, выбор, инструмент'
  });

  assert.ok(result.bodyHtml, 'bodyHtml should exist');
  assert.ok(result.seoTitle, 'seoTitle should exist');
  assert.ok(result.metaDesc, 'metaDesc should exist');
  assert.ok(result.slug, 'slug should exist');
  assert.ok(result.imageBuffer, 'imageBuffer should exist');
  assert.ok(result.imageMime, 'imageMime should exist');
  assert.ok(result.imageFilename, 'imageFilename should exist');

  assert.strictEqual(typeof result.bodyHtml, 'string', 'bodyHtml should be string');
  assert.strictEqual(typeof result.seoTitle, 'string', 'seoTitle should be string');
  assert.ok(result.seoTitle.length <= 70, 'seoTitle should be <= 70 chars');
  assert.ok(result.metaDesc.length <= 160, 'metaDesc should be <= 160 chars');

  console.log('✓ generate() shape passed\n');
}

async function testAICallOrder() {
  console.log('Test: AI calls happen in correct order');
  aiRouterCalls.length = 0;

  await blogGenerator.generate('testChat', {
    topic: 'Тестовая тема',
    keywords: 'тест, ключи'
  });

  // Должно быть 5 вызовов: format, image, article, seo_title, seo_desc, seo_slug
  // (seo_* параллельно, но считаются отдельно)
  assert.strictEqual(aiRouterCalls.length, 6, `Expected 6 AI calls, got ${aiRouterCalls.length}`);

  // Проверяем порядок
  assert.ok(aiRouterCalls[0].payload.messages[0].content.includes('редактор'), 'First call should be format prompt');
  assert.ok(aiRouterCalls[1].payload.messages[0].content.includes('визуальным'), 'Second call should be image prompt');
  assert.ok(aiRouterCalls[2].payload.messages[0].content.includes('автор статей'), 'Third call should be article prompt');
  assert.ok(aiRouterCalls[3].payload.messages[0].content.includes('заголовок'), 'Fourth call should be SEO title');
  assert.ok(aiRouterCalls[4].payload.messages[0].content.includes('описание'), 'Fifth call should be SEO desc');
  assert.ok(aiRouterCalls[5].payload.messages[0].content.includes('URL-slug'), 'Sixth call should be SEO slug');

  console.log('✓ AI call order passed\n');
}

async function testImageGenerationCalled() {
  console.log('Test: Image generation is called');
  aiRouterCalls.length = 0;

  let imageGenCalled = false;
  const originalGenerateCover = mockImageGenService.generateCover;
  mockImageGenService.generateCover = async (...args) => {
    imageGenCalled = true;
    return originalGenerateCover(...args);
  };

  await blogGenerator.generate('testChat', {
    topic: 'Тема',
    keywords: 'ключи'
  });

  assert.strictEqual(imageGenCalled, true, 'Image generation should be called');
  mockImageGenService.generateCover = originalGenerateCover;
  console.log('✓ Image generation called passed\n');
}

async function testInsufficientBalance() {
  console.log('Test: InsufficientBalanceError on low balance');

  // Мокаем баланс = 0
  require.cache[require.resolve('../manage/tokenBilling')].exports = {
    hasBalance: async () => ({ canUse: false, reason: 'No tokens' })
  };

  // Перезагружаем модуль чтобы подхватить новый мок
  delete require.cache[require.resolve('../services/blogGenerator.service')];
  const blogGeneratorFresh = require('../services/blogGenerator.service');

  try {
    await blogGeneratorFresh.generate('testChat', { topic: 'Test', keywords: 'keys' });
    assert.fail('Should have thrown InsufficientBalanceError');
  } catch (e) {
    assert.strictEqual(e.name, 'InsufficientBalanceError', 'Should throw InsufficientBalanceError');
    console.log('✓ InsufficientBalanceError passed\n');
  }

  // Восстанавливаем
  require.cache[require.resolve('../manage/tokenBilling')].exports = mockTokenBilling;
}

async function testModeratorNoteInPrompt() {
  console.log('Test: Moderator note is included in prompt');
  aiRouterCalls.length = 0;

  await blogGenerator.generate('testChat', {
    topic: 'Тема',
    keywords: 'ключи',
    moderatorNote: 'Добавь больше примеров'
  });

  // Проверяем что moderatorNote попал в один из промптов
  const allPrompts = aiRouterCalls.map(c => c.payload.messages[1]?.content || '').join('\n');
  assert.ok(allPrompts.includes('Добавь больше примеров'), 'Moderator note should be in prompts');
  console.log('✓ Moderator note in prompt passed\n');
}

async function testSlugSanitization() {
  console.log('Test: Slug is properly sanitized');
  aiRouterCalls.length = 0;

  // Мокаем AI чтобы вернуть "плохой" slug
  require.cache[require.resolve('../services/ai_router_service')].exports.processMessage = async (chatId, payload) => {
    const systemMsg = payload.messages?.[0]?.content || '';
    if (systemMsg.includes('URL-slug')) {
      return { reply: '!!!Test Post/Slug@!!!' };
    }
    return { reply: '{}' };
  };

  const result = await blogGenerator.generate('testChat', { topic: 'Test', keywords: 'keys' });

  assert.ok(!result.slug.includes('!'), 'Slug should not contain !');
  assert.ok(!result.slug.includes('/'), 'Slug should not contain /');
  assert.ok(!result.slug.includes('@'), 'Slug should not contain @');
  assert.ok(result.slug.includes('-'), 'Slug should contain dashes');
  console.log('✓ Slug sanitization passed\n');
}

// ============================================
// Запуск
// ============================================

async function runTests() {
  console.log('=== Blog Generator Tests ===\n');
  let passed = 0;
  let failed = 0;

  const tests = [
    testGenerateReturnsCorrectShape,
    testAICallOrder,
    testImageGenerationCalled,
    testInsufficientBalance,
    testModeratorNoteInPrompt,
    testSlugSanitization
  ];

  for (const testFn of tests) {
    try {
      await testFn();
      passed++;
    } catch (e) {
      console.error(`✗ ${testFn.name} FAILED: ${e.message}`);
      failed++;
    }
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(e => {
  console.error('Test runner error:', e);
  process.exit(1);
});
