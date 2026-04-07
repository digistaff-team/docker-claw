/**
 * WordPress Publisher Tests
 * Тесты для wordpressMvp.service.js с моком fetch
 */
const assert = require('assert');

// Мокаем node-fetch модуль
const mockFetchResponses = [];
let fetchCallCount = 0;

const mockFetch = async function (url, options) {
  fetchCallCount++;
  const mockResponse = mockFetchResponses.shift();
  if (!mockResponse) {
    throw new Error(`No mock response configured for ${url}`);
  }
  return {
    ok: mockResponse.ok !== false,
    status: mockResponse.status || 200,
    json: async () => mockResponse.body,
    text: async () => mockResponse.error || JSON.stringify(mockResponse.body || {})
  };
};

require.cache[require.resolve('node-fetch')] = {
  id: require.resolve('node-fetch'),
  filename: require.resolve('node-fetch'),
  loaded: true,
  exports: mockFetch
};
global.fetch = mockFetch;

// Мокаем manageStore
const mockWpConfig = {
  baseUrl: 'https://example.com',
  username: 'admin',
  appPassword: 'testpass123',
  defaultCategoryId: 5
};

const mockStore = {
  getWpConfig: () => mockWpConfig,
  setWpConfig: () => {},
  clearWpConfig: () => {}
};

require.cache[require.resolve('../manage/store')] = {
  id: require.resolve('../manage/store'),
  filename: require.resolve('../manage/store'),
  loaded: true,
  exports: mockStore
};

// Теперь импортируем сервис
const wordpressMvp = require('../services/wordpressMvp.service');

// ============================================
// Тесты
// ============================================

async function testPing() {
  console.log('Test: ping() — successful connection');
  mockFetchResponses.push({
    body: { name: 'Test Blog', namespaces: ['wp/v2'] }
  });

  const result = await wordpressMvp.ping('testChat');
  assert.strictEqual(result.ok, true, 'Ping should succeed');
  assert.strictEqual(result.siteName, 'Test Blog', 'Site name should match');
  console.log('✓ ping() passed\n');
}

async function testPingFailure() {
  console.log('Test: ping() — failed connection');
  mockFetchResponses.push({
    ok: false,
    status: 401,
    body: {},
    error: 'Unauthorized'
  });

  const result = await wordpressMvp.ping('testChat');
  assert.strictEqual(result.ok, false, 'Ping should fail');
  console.log('✓ ping() failure passed\n');
}

async function testUploadMedia() {
  console.log('Test: uploadMedia() — successful upload');
  mockFetchResponses.push(
    {
      body: {
        id: 123,
        source_url: 'https://example.com/wp-content/uploads/test.jpg',
        link: 'https://example.com/?attachment_id=123',
        media_details: { mime_type: 'image/jpeg', file: 'test.jpg' }
      }
    },
    {
      body: { id: 123, alt_text: 'Test image', title: { rendered: 'Test' } }
    }
  );

  const result = await wordpressMvp.uploadMedia('testChat', {
    buffer: Buffer.from('fakeimage'),
    filename: 'test.jpg',
    mimeType: 'image/jpeg',
    altText: 'Test image',
    title: 'Test'
  });

  assert.strictEqual(result.id, 123, 'Media ID should match');
  assert.ok(result.source_url, 'Source URL should be present');
  console.log('✓ uploadMedia() passed\n');
}

async function testCreateDraft() {
  console.log('Test: createDraft() — successful draft creation');
  mockFetchResponses.push({
    body: {
      id: 456,
      link: 'https://example.com/?p=456',
      status: 'draft',
      slug: 'test-post',
      title: { rendered: 'Test Post' }
    }
  });

  const result = await wordpressMvp.createDraft('testChat', {
    title: 'Test Post',
    content: '<p>Test content</p>',
    excerpt: 'Test excerpt',
    featured_media: 123,
    slug: 'test-post'
  });

  assert.strictEqual(result.id, 456, 'Post ID should match');
  assert.ok(result.preview_link.includes('preview=true'), 'Preview link should contain preview=true');
  assert.strictEqual(result.status, 'draft', 'Status should be draft');
  console.log('✓ createDraft() passed\n');
}

async function testPublishPost() {
  console.log('Test: publishPost() — successful publish');
  mockFetchResponses.push({
    body: {
      id: 456,
      link: 'https://example.com/test-post/',
      status: 'publish',
      title: { rendered: 'Test Post' }
    }
  });

  const result = await wordpressMvp.publishPost('testChat', 456);
  assert.strictEqual(result.id, 456, 'Post ID should match');
  assert.strictEqual(result.status, 'publish', 'Status should be publish');
  console.log('✓ publishPost() passed\n');
}

async function testDeletePost() {
  console.log('Test: deletePost() — successful deletion');
  mockFetchResponses.push({
    body: { deleted: true }
  });

  const result = await wordpressMvp.deletePost('testChat', 456);
  assert.strictEqual(result.deleted, true, 'Should be deleted');
  console.log('✓ deletePost() passed\n');
}

async function testGetCategories() {
  console.log('Test: getCategories() — fetch categories');
  mockFetchResponses.push({
    body: [
      { id: 1, name: 'Uncategorized', slug: 'uncategorized', count: 5 },
      { id: 5, name: 'Tech', slug: 'tech', count: 10 }
    ]
  });

  const categories = await wordpressMvp.getCategories('testChat');
  assert.strictEqual(categories.length, 2, 'Should have 2 categories');
  assert.strictEqual(categories[0].name, 'Uncategorized', 'First category name');
  assert.strictEqual(categories[1].id, 5, 'Second category ID');
  console.log('✓ getCategories() passed\n');
}

async function testIdempotency() {
  console.log('Test: Idempotency — multiple calls should not create duplicates');
  // Reset counter
  fetchCallCount = 0;

  // Mock two identical draft creations
  mockFetchResponses.push(
    { body: { id: 789, link: 'https://example.com/?p=789', status: 'draft', title: { rendered: 'Test' }, slug: 'test' } },
    { body: { id: 789, link: 'https://example.com/?p=789', status: 'draft', title: { rendered: 'Test' }, slug: 'test' } }
  );

  await wordpressMvp.createDraft('testChat', { title: 'Test', content: 'Content' });
  const callCount1 = fetchCallCount;

  await wordpressMvp.createDraft('testChat', { title: 'Test', content: 'Content' });
  const callCount2 = fetchCallCount;

  assert.strictEqual(callCount2 - callCount1, 1, 'Should make exactly one API call per draft');
  console.log('✓ Idempotency passed\n');
}

// ============================================
// Запуск тестов
// ============================================

async function runTests() {
  console.log('=== WordPress Publisher Tests ===\n');
  let passed = 0;
  let failed = 0;

  const tests = [
    testPing,
    testPingFailure,
    testUploadMedia,
    testCreateDraft,
    testPublishPost,
    testDeletePost,
    testGetCategories,
    testIdempotency
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
