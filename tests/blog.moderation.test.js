/**
 * Blog Moderation Tests
 * Тесты FSM-переходов статусов блог-постов
 */
const assert = require('assert');

// ============================================
// Моки
// ============================================

const mockQueries = [];

// Мокаем pg.Client до загрузки репозитория
class MockPgClient {
  constructor() {}
  async connect() {}
  async end() {}
  async query(text, params) {
    mockQueries.push({ text, params });
    return { rows: [{ id: 1, chat_id: 'testChat', publish_status: 'draft' }], rowCount: 1 };
  }
}

require.cache[require.resolve('pg')] = {
  id: require.resolve('pg'),
  filename: require.resolve('pg'),
  loaded: true,
  exports: { Client: MockPgClient, Pool: MockPgClient }
};

const mockWpRepo = require('../services/content/wordpress.repository');

// ============================================
// Тесты
// ============================================

async function testDraftToReady() {
  console.log('Test: draft → ready (post generation complete)');
  mockQueries.length = 0;

  await mockWpRepo.markReady('testChat', 1);

  assert.ok(mockQueries.length > 0, 'Should execute query');
  const lastQ = mockQueries[mockQueries.length - 1];
  assert.ok(lastQ.text.includes('publish_status'), 'Should update publish_status');
  assert.strictEqual(lastQ.params[0], 'ready', 'Status should be ready');
  console.log('✓ draft → ready passed\n');
}

async function testReadyToApproved() {
  console.log('Test: ready → approved (moderator approved)');
  mockQueries.length = 0;

  await mockWpRepo.markApproved('testChat', 1);

  const lastQ = mockQueries[mockQueries.length - 1];
  assert.strictEqual(lastQ.params[0], 'approved', 'Status should be approved');
  console.log('✓ ready → approved passed\n');
}

async function testApprovedToPublished() {
  console.log('Test: approved → published (published in WP)');
  mockQueries.length = 0;

  await mockWpRepo.markPublished('testChat', 1);

  const lastQ = mockQueries[mockQueries.length - 1];
  assert.strictEqual(lastQ.params[0], 'published', 'Status should be published');
  console.log('✓ approved → published passed\n');
}

async function testReadyToDraftWithNote() {
  console.log('Test: ready → draft (moderator requested rewrite with note)');
  mockQueries.length = 0;

  await mockWpRepo.markDraft('testChat', 1, 'Добавить примеры кода');

  const lastQ = mockQueries[mockQueries.length - 1];
  assert.strictEqual(lastQ.params[0], 'draft', 'Status should be draft');
  assert.ok(lastQ.text.includes('moderator_note'), 'Should update moderator_note');
  assert.strictEqual(lastQ.params[1], 'Добавить примеры кода', 'Note should be saved');
  console.log('✓ ready → draft with note passed\n');
}

async function testReadyToRejected() {
  console.log('Test: ready → rejected (moderator rejected)');
  mockQueries.length = 0;

  await mockWpRepo.markRejected('testChat', 1);

  const lastQ = mockQueries[mockQueries.length - 1];
  assert.strictEqual(lastQ.params[0], 'rejected', 'Status should be rejected');
  console.log('✓ ready → rejected passed\n');
}

async function testReadyToError() {
  console.log('Test: ready → error (generation/publish failed)');
  mockQueries.length = 0;

  await mockWpRepo.markError('testChat', 1, 'WordPress API timeout');

  const lastQ = mockQueries[mockQueries.length - 1];
  assert.strictEqual(lastQ.params[0], 'error', 'Status should be error');
  assert.strictEqual(lastQ.params[1], 'WordPress API timeout', 'Error message should be saved');
  console.log('✓ ready → error passed\n');
}

async function testAttachModeratorNote() {
  console.log('Test: attachModeratorNote() saves note');
  mockQueries.length = 0;

  await mockWpRepo.attachModeratorNote('testChat', 1, 'Нужно улучшить введение');

  const lastQuery = mockQueries[mockQueries.length - 1].text;
  const lastParams = mockQueries[mockQueries.length - 1].params;
  assert.ok(lastQuery.includes('moderator_note'), 'Should update moderator_note');
  assert.strictEqual(lastParams[0], 'Нужно улучшить введение', 'Note should match');
  console.log('✓ attachModeratorNote passed\n');
}

async function testClearModeratorNote() {
  console.log('Test: clearModeratorNote() removes note');
  mockQueries.length = 0;

  await mockWpRepo.clearModeratorNote('testChat', 1);

  const lastQuery = mockQueries[mockQueries.length - 1].text;
  assert.ok(lastQuery.includes('moderator_note'), 'Should touch moderator_note');
  assert.strictEqual(lastQuery.includes('NULL'), true || lastQuery.includes('null'), 'Should set to NULL');
  console.log('✓ clearModeratorNote passed\n');
}

async function testUpdateWpIds() {
  console.log('Test: updateWpIds() saves WordPress IDs');
  mockQueries.length = 0;

  await mockWpRepo.updateWpIds('testChat', 1, {
    wpMediaId: 100,
    wpPostId: 200,
    wpPermalink: 'https://example.com/post/',
    wpPreviewUrl: 'https://example.com/?p=200&preview=true',
    seoTitle: 'SEO Title',
    metaDesc: 'Meta description'
  });

  const lastQuery = mockQueries[mockQueries.length - 1].text;
  assert.ok(lastQuery.includes('wp_media_id'), 'Should update wp_media_id');
  assert.ok(lastQuery.includes('wp_post_id'), 'Should update wp_post_id');
  assert.ok(lastQuery.includes('wp_permalink'), 'Should update wp_permalink');
  assert.ok(lastQuery.includes('wp_preview_url'), 'Should update wp_preview_url');
  assert.ok(lastQuery.includes('seo_title'), 'Should update seo_title');
  assert.ok(lastQuery.includes('meta_desc'), 'Should update meta_desc');
  console.log('✓ updateWpIds passed\n');
}

async function testCreateDraftPost() {
  console.log('Test: createDraftPost() creates post with all fields');
  mockQueries.length = 0;

  // Мокаем ответ через переопределение MockPgClient.prototype
  MockPgClient.prototype.query = async function (text, params) {
    mockQueries.push({ text, params });
    if (text.includes('RETURNING')) {
      return { rows: [{ id: 999 }], rowCount: 1 };
    }
    return { rows: [{ id: 1 }], rowCount: 1 };
  };

  const postId = await mockWpRepo.createDraftPost('testChat', {
    bodyHtml: '<h2>Test</h2>',
    seoTitle: 'Test Post',
    metaDesc: 'Test description',
    featuredImageUrl: 'https://example.com/image.jpg',
    wpMediaId: 100,
    wpPostId: 200,
    wpPermalink: 'https://example.com/post/',
    wpPreviewUrl: 'https://example.com/?p=200&preview=true',
    publishStatus: 'draft'
  });

  const insertQuery = mockQueries[0].text;
  assert.ok(insertQuery.includes('body_html'), 'Should insert body_html');
  assert.ok(insertQuery.includes('seo_title'), 'Should insert seo_title');
  assert.ok(insertQuery.includes('meta_desc'), 'Should insert meta_desc');
  assert.ok(insertQuery.includes('featured_image_url'), 'Should insert featured_image_url');
  assert.ok(insertQuery.includes('wp_media_id'), 'Should insert wp_media_id');
  assert.ok(insertQuery.includes('wp_post_id'), 'Should insert wp_post_id');
  assert.ok(insertQuery.includes('wp_permalink'), 'Should insert wp_permalink');
  assert.ok(insertQuery.includes('wp_preview_url'), 'Should insert wp_preview_url');

  console.log('✓ createDraftPost passed\n');
}

// ============================================
// Запуск
// ============================================

async function runTests() {
  console.log('=== Blog Moderation FSM Tests ===\n');
  let passed = 0;
  let failed = 0;

  const tests = [
    testDraftToReady,
    testReadyToApproved,
    testApprovedToPublished,
    testReadyToDraftWithNote,
    testReadyToRejected,
    testReadyToError,
    testAttachModeratorNote,
    testClearModeratorNote,
    testUpdateWpIds,
    testCreateDraftPost
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
