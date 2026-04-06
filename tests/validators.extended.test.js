/**
 * Extended tests for validators and video service pure functions
 */

const assert = require('assert');

const colors = {
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  reset: '\x1b[0m'
};

let passed = 0;
let failed = 0;
const errors = [];
const asyncTests = [];

function test(name, fn) {
  if (fn.constructor.name === 'AsyncFunction') {
    asyncTests.push({ name, fn });
    return;
  }
  try {
    fn();
    console.log(`  ${colors.green}✓${colors.reset} ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ${colors.red}✗${colors.reset} ${name}`);
    console.log(`    ${colors.red}Error: ${e.message}${colors.reset}`);
    errors.push({ name, error: e.message });
    failed++;
  }
}

function group(name) {
  console.log(`\n${colors.yellow}${name}${colors.reset}`);
}

// ============================================
// Load modules
// ============================================

const {
  validatePostLength,
  validateHashtags,
  validateForbiddenTopics,
  validateEmojiBalance,
  validateMedia,
  validateVideo,
  validatePostForPublish,
  autoCorrectPost,
  MAX_POST_LENGTH,
  MIN_POST_LENGTH,
  MAX_HASHTAGS,
  MAX_VIDEO_SIZE,
  MAX_IMAGE_SIZE,
  MAX_VIDEO_DURATION_SEC,
  SUPPORTED_VIDEO_FORMATS,
  SUPPORTED_IMAGE_FORMATS
} = require('../services/content/validators');

const {
  VIDEO_STATUS,
  KieVideoProvider,
  getProvider
} = require('../services/content/video.service');

// ============================================
// validateHashtags — bug fix verification
// ============================================

group('validateHashtags: only #words count as hashtags');

test('text with no hashtags should warn "no hashtags"', () => {
  const result = validateHashtags('Hello world no hashtags here');
  assert.ok(result.warnings.some(w => w.includes('хэштег')),
    'Expected warning about missing hashtags, got: ' + JSON.stringify(result.warnings));
});

test('text with exactly one hashtag should not warn about too many', () => {
  const result = validateHashtags('Some text with #one hashtag');
  assert.ok(!result.warnings.some(w => w.includes('много')));
  assert.ok(!result.warnings.some(w => w.includes('нет хэштегов')));
});

test('text with 11 actual hashtags should warn about too many', () => {
  const text = Array(11).fill(null).map((_, i) => `#tag${i}`).join(' ');
  const result = validateHashtags(text);
  assert.ok(result.warnings.some(w => w.includes('много')));
});

test('15-word plain text should NOT warn about too many hashtags', () => {
  const text = 'This is a long sentence with many different words and no actual hashtags at all';
  const result = validateHashtags(text);
  assert.ok(!result.warnings.some(w => w.includes('много')),
    'Plain words must not be counted as hashtags');
});

test('empty string should warn about no hashtags', () => {
  const result = validateHashtags('');
  assert.ok(result.warnings.some(w => w.includes('хэштег')));
  assert.strictEqual(result.valid, true);
});

test('Cyrillic hashtag with double underscores should warn', () => {
  const result = validateHashtags('#тест__тег');
  assert.ok(result.warnings.some(w => w.includes('двойные подчёркивания')));
});

test('Cyrillic hashtag without double underscores should not warn', () => {
  const result = validateHashtags('#хороший_тег');
  assert.ok(!result.warnings.some(w => w.includes('двойные подчёркивания')));
});

// ============================================
// validateMedia
// ============================================

group('validateMedia');

test('null input should fail', () => {
  const result = validateMedia(null);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('отсутствует')));
});

test('missing path should fail', () => {
  const result = validateMedia({});
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('Путь')));
});

test('size=0 should fail', () => {
  const result = validateMedia({ path: '/img.png', size: 0 });
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('пуст')));
});

test('size over 10MB should fail', () => {
  const result = validateMedia({ path: '/img.png', size: MAX_IMAGE_SIZE + 1 });
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('слишком большой')));
});

test('valid image info should pass', () => {
  const result = validateMedia({ path: '/img.png', size: 1024 * 1024 });
  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.errors.length, 0);
});

test('path without size should pass', () => {
  const result = validateMedia({ path: '/img.png' });
  assert.strictEqual(result.valid, true);
});

// ============================================
// validateVideo
// ============================================

group('validateVideo');

test('null input should fail', () => {
  const result = validateVideo(null);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('отсутствует')));
});

test('missing path should fail', () => {
  const result = validateVideo({});
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('Путь')));
});

test('size=0 should fail', () => {
  const result = validateVideo({ path: '/video.mp4', size: 0 });
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('пуст')));
});

test('size over 50MB should fail', () => {
  const result = validateVideo({ path: '/video.mp4', size: MAX_VIDEO_SIZE + 1 });
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('слишком большой')));
});

test('unsupported format should warn', () => {
  const result = validateVideo({ path: '/video.avi', size: 1024 });
  assert.strictEqual(result.valid, true);
  assert.ok(result.warnings.some(w => w.includes('avi')));
});

test('mp4 format should not warn', () => {
  const result = validateVideo({ path: '/video.mp4', size: 1024 });
  assert.strictEqual(result.valid, true);
  assert.ok(!result.warnings.some(w => w.includes('формат')));
});

test('duration over limit should warn', () => {
  const result = validateVideo({ path: '/video.mp4', duration: MAX_VIDEO_DURATION_SEC + 1 });
  assert.strictEqual(result.valid, true);
  assert.ok(result.warnings.some(w => w.toLowerCase().includes('длительность')));
});

test('duration within limit should not warn', () => {
  const result = validateVideo({ path: '/video.mp4', duration: 30 });
  assert.strictEqual(result.valid, true);
  assert.ok(!result.warnings.some(w => w.toLowerCase().includes('длительность')));
});

test('valid video should pass', () => {
  const result = validateVideo({ path: '/video.mp4', size: 5 * 1024 * 1024, duration: 10 });
  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.errors.length, 0);
});

// ============================================
// validateEmojiBalance
// ============================================

group('validateEmojiBalance');

test('plain text should pass with no warnings', () => {
  const result = validateEmojiBalance('Normal text without emojis here');
  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.warnings.length, 0);
});

test('empty text should pass', () => {
  const result = validateEmojiBalance('');
  assert.strictEqual(result.valid, true);
});

test('always returns valid=true (warnings only)', () => {
  const result = validateEmojiBalance('😀'.repeat(100));
  assert.strictEqual(result.valid, true);
});

// ============================================
// validatePostForPublish — text+video content type
// ============================================

group('validatePostForPublish: text+video content type');

test('text+video with no video and no image should fail', () => {
  const result = validatePostForPublish({
    text: 'Valid post text for video content'.padEnd(100, '.'),
    contentType: 'text+video'
  });
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('fallback') || e.includes('Видео')));
});

test('text+video with videoPath should not error about missing video', () => {
  const result = validatePostForPublish({
    text: 'Valid post about technology'.padEnd(100, '.'),
    videoPath: '/path/to/video.mp4',
    contentType: 'text+video'
  });
  assert.ok(!result.errors.some(e => e.includes('fallback')));
});

test('text+video with imagePath fallback should not error about missing video/image', () => {
  const result = validatePostForPublish({
    text: 'Valid post about cooking recipes'.padEnd(100, '.'),
    imagePath: '/path/to/image.png',
    contentType: 'text+video'
  });
  assert.ok(!result.errors.some(e => e.includes('fallback')));
});

// ============================================
// autoCorrectPost edge cases
// ============================================

group('autoCorrectPost edge cases');

test('null should return null', () => {
  assert.strictEqual(autoCorrectPost(null), null);
});

test('undefined should return undefined', () => {
  assert.strictEqual(autoCorrectPost(undefined), undefined);
});

test('should trim surrounding whitespace', () => {
  const result = autoCorrectPost('  Hello world  ');
  assert.strictEqual(result, 'Hello world');
});

test('short text should remain unchanged', () => {
  const result = autoCorrectPost('Short text');
  assert.strictEqual(result, 'Short text');
});

test('very long text should be cut to MAX_POST_LENGTH', () => {
  const result = autoCorrectPost('a'.repeat(MAX_POST_LENGTH + 500));
  assert.ok(result.length <= MAX_POST_LENGTH);
});

test('should cut at sentence boundary if late enough', () => {
  const mainPart = 'A'.repeat(Math.floor(MAX_POST_LENGTH * 0.8)) + '.';
  const extra = 'B'.repeat(MAX_POST_LENGTH);
  const result = autoCorrectPost(mainPart + extra);
  assert.ok(result.endsWith('.'));
  assert.ok(result.length <= MAX_POST_LENGTH);
});

// ============================================
// validatePostLength edge cases
// ============================================

group('validatePostLength edge cases');

test('text at exactly MIN_POST_LENGTH should pass with no warnings', () => {
  const result = validatePostLength('a'.repeat(MIN_POST_LENGTH));
  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.warnings.length, 0);
});

test('text at exactly MAX_POST_LENGTH should pass', () => {
  const result = validatePostLength('a'.repeat(MAX_POST_LENGTH));
  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.errors.length, 0);
});

test('text at MAX_POST_LENGTH + 1 should fail', () => {
  const result = validatePostLength('a'.repeat(MAX_POST_LENGTH + 1));
  assert.strictEqual(result.valid, false);
});

test('text at MIN_POST_LENGTH - 1 should warn (not fail)', () => {
  const result = validatePostLength('a'.repeat(MIN_POST_LENGTH - 1));
  assert.strictEqual(result.valid, true);
  assert.ok(result.warnings.length > 0);
});

// ============================================
// VIDEO_STATUS enum
// ============================================

group('VIDEO_STATUS enum');

test('should have PENDING', () => { assert.strictEqual(VIDEO_STATUS.PENDING, 'pending'); });
test('should have PROCESSING', () => { assert.strictEqual(VIDEO_STATUS.PROCESSING, 'processing'); });
test('should have COMPLETED', () => { assert.strictEqual(VIDEO_STATUS.COMPLETED, 'completed'); });
test('should have FAILED', () => { assert.strictEqual(VIDEO_STATUS.FAILED, 'failed'); });
test('should have TIMEOUT', () => { assert.strictEqual(VIDEO_STATUS.TIMEOUT, 'timeout'); });
test('should have CANCELLED', () => { assert.strictEqual(VIDEO_STATUS.CANCELLED, 'cancelled'); });
test('should be frozen', () => { assert.ok(Object.isFrozen(VIDEO_STATUS)); });

// ============================================
// getProvider factory
// ============================================

group('getProvider factory');

test('should return kie-veo3 provider', () => {
  assert.strictEqual(getProvider().getName(), 'kie-veo3');
});

// ============================================
// KieVideoProvider (unit tests, no API call)
// ============================================

group('KieVideoProvider (unit)');

test('getName should return "kie-veo3"', async () => {
  const provider = new KieVideoProvider();
  assert.strictEqual(provider.getName(), 'kie-veo3');
});

test('generate should throw if KIE_API_KEY is not set', async () => {
  const originalKey = process.env.KIE_API_KEY;
  delete process.env.KIE_API_KEY;
  const provider = new KieVideoProvider();
  try {
    await provider.generate({ prompt: 'test' });
    assert.fail('Expected error');
  } catch (e) {
    assert.ok(e.message.includes('KIE_API_KEY'));
  } finally {
    process.env.KIE_API_KEY = originalKey;
  }
});

test('cancel should return false (not supported)', async () => {
  const provider = new KieVideoProvider();
  const result = await provider.cancel('some_task_id');
  assert.strictEqual(result, false);
});

// ============================================
// Supported formats constants
// ============================================

group('Supported formats constants');

test('mp4 in SUPPORTED_VIDEO_FORMATS', () => { assert.ok(SUPPORTED_VIDEO_FORMATS.includes('mp4')); });
test('mov in SUPPORTED_VIDEO_FORMATS', () => { assert.ok(SUPPORTED_VIDEO_FORMATS.includes('mov')); });
test('webm in SUPPORTED_VIDEO_FORMATS', () => { assert.ok(SUPPORTED_VIDEO_FORMATS.includes('webm')); });
test('jpg in SUPPORTED_IMAGE_FORMATS', () => { assert.ok(SUPPORTED_IMAGE_FORMATS.includes('jpg')); });
test('png in SUPPORTED_IMAGE_FORMATS', () => { assert.ok(SUPPORTED_IMAGE_FORMATS.includes('png')); });
test('webp in SUPPORTED_IMAGE_FORMATS', () => { assert.ok(SUPPORTED_IMAGE_FORMATS.includes('webp')); });

// ============================================
// Run async tests, then print summary
// ============================================

(async () => {
  for (const { name, fn } of asyncTests) {
    try {
      await fn();
      console.log(`  ${colors.green}✓${colors.reset} ${name}`);
      passed++;
    } catch (e) {
      console.log(`  ${colors.red}✗${colors.reset} ${name}`);
      console.log(`    ${colors.red}Error: ${e.message}${colors.reset}`);
      errors.push({ name, error: e.message });
      failed++;
    }
  }

  console.log('\n' + '='.repeat(50));
  if (failed === 0) {
    console.log(`${colors.green}All tests passed: ${passed}${colors.reset}`);
  } else {
    console.log(`${colors.yellow}Results: ${passed} passed, ${failed} failed${colors.reset}`);
    console.log('\nFailed tests:');
    for (const err of errors) {
      console.log(`  - ${err.name}: ${err.error}`);
    }
  }
  console.log('='.repeat(50));

  process.exit(failed > 0 ? 1 : 0);
})();
