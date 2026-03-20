/**
 * TASK-017: Тесты критического контура
 * Простой тестовый runner без внешних зависимостей
 */

const assert = require('assert');
const path = require('path');

// Цвета для вывода
const colors = {
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  reset: '\x1b[0m'
};

let passed = 0;
let failed = 0;
const errors = [];

function test(name, fn) {
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
// Загрузка модулей
// ============================================

const {
  JOB_STATUS,
  POST_STATUS,
  QUEUE_STATUS,
  PUBLISH_LOG_STATUS,
  JOB_STATUS_TRANSITIONS,
  validateJobStatusTransition,
  isTerminalStatus,
  generateCorrelationId
} = require('../services/content/status');

const {
  validatePostLength,
  validateHashtags,
  validateForbiddenTopics,
  validatePostForPublish,
  autoCorrectPost,
  MAX_POST_LENGTH,
  MIN_POST_LENGTH
} = require('../services/content/validators');

const {
  getLimits,
  QUOTA_TYPES,
  DEFAULT_SOFT_LIMIT,
  DEFAULT_HARD_LIMIT
} = require('../services/content/limits');

// ============================================
// TASK-001: Тесты статусов и переходов
// ============================================

group('Status Module: JOB_STATUS enum');

test('should have DRAFT status', () => {
  assert.strictEqual(JOB_STATUS.DRAFT, 'draft');
});

test('should have MEDIA_GENERATING status', () => {
  assert.strictEqual(JOB_STATUS.MEDIA_GENERATING, 'media_generating');
});

test('should have READY status', () => {
  assert.strictEqual(JOB_STATUS.READY, 'ready');
});

test('should have APPROVED status', () => {
  assert.strictEqual(JOB_STATUS.APPROVED, 'approved');
});

test('should have PUBLISHED status', () => {
  assert.strictEqual(JOB_STATUS.PUBLISHED, 'published');
});

test('should have FAILED status', () => {
  assert.strictEqual(JOB_STATUS.FAILED, 'failed');
});

group('Status Module: validateJobStatusTransition');

test('should allow draft -> ready', () => {
  const result = validateJobStatusTransition('draft', 'ready');
  assert.strictEqual(result.valid, true);
});

test('should allow ready -> approved', () => {
  const result = validateJobStatusTransition('ready', 'approved');
  assert.strictEqual(result.valid, true);
});

test('should allow approved -> published', () => {
  const result = validateJobStatusTransition('approved', 'published');
  assert.strictEqual(result.valid, true);
});

test('should allow failed -> ready (retry)', () => {
  const result = validateJobStatusTransition('failed', 'ready');
  assert.strictEqual(result.valid, true);
});

test('should block published -> ready', () => {
  const result = validateJobStatusTransition('published', 'ready');
  assert.strictEqual(result.valid, false);
  assert.ok(result.reason.includes('Invalid transition'));
});

test('should block draft -> published (skip steps)', () => {
  const result = validateJobStatusTransition('draft', 'published');
  assert.strictEqual(result.valid, false);
});

test('should block transition from terminal state', () => {
  const result = validateJobStatusTransition('published', 'failed');
  assert.strictEqual(result.valid, false);
});

test('should handle invalid source status', () => {
  const result = validateJobStatusTransition('invalid', 'ready');
  assert.strictEqual(result.valid, false);
  assert.ok(result.reason.includes('Invalid source status'));
});

test('should handle invalid target status', () => {
  const result = validateJobStatusTransition('draft', 'invalid');
  assert.strictEqual(result.valid, false);
  assert.ok(result.reason.includes('Invalid target status'));
});

group('Status Module: isTerminalStatus');

test('should return true for published', () => {
  assert.strictEqual(isTerminalStatus('published'), true);
});

test('should return false for draft', () => {
  assert.strictEqual(isTerminalStatus('draft'), false);
});

test('should return false for ready', () => {
  assert.strictEqual(isTerminalStatus('ready'), false);
});

test('should return false for failed', () => {
  assert.strictEqual(isTerminalStatus('failed'), false);
});

group('Status Module: generateCorrelationId');

test('should generate unique IDs', () => {
  const id1 = generateCorrelationId();
  const id2 = generateCorrelationId();
  assert.notStrictEqual(id1, id2);
});

test('should have corr_ prefix', () => {
  const id = generateCorrelationId();
  assert.ok(id.startsWith('corr_'));
});

test('should contain timestamp and random parts', () => {
  const id = generateCorrelationId();
  const parts = id.split('_');
  assert.ok(parts.length >= 3);
});

// ============================================
// TASK-011: Тесты валидации контента
// ============================================

group('Validators: validatePostLength');

test('should fail for empty text', () => {
  const result = validatePostLength('');
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('пуст')));
});

test('should warn for short text', () => {
  const result = validatePostLength('Короткий текст');
  assert.strictEqual(result.valid, true);
  assert.ok(result.warnings.length > 0);
});

test('should fail for too long text', () => {
  const longText = 'a'.repeat(1100);
  const result = validatePostLength(longText);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('слишком длинный')));
});

test('should pass for valid length', () => {
  const result = validatePostLength('a'.repeat(500));
  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.errors.length, 0);
});

group('Validators: validateHashtags');

test('should pass with hashtags', () => {
  const result = validateHashtags('Text with #tag #example');
  assert.strictEqual(result.valid, true);
});

test('should warn for too many hashtags', () => {
  const text = 'Text ' + Array(15).fill('#tag').join(' ');
  const result = validateHashtags(text);
  assert.strictEqual(result.valid, true);
  assert.ok(result.warnings.length > 0);
});

group('Validators: validateForbiddenTopics');

// Note: Using Buffer to ensure UTF-8 encoding for Cyrillic keywords
test('should detect war keyword', () => {
  // 'война' in UTF-8
  const warWord = Buffer.from([0xD0, 0xB2, 0xD0, 0xBE, 0xD0, 0xB9, 0xD0, 0xBD, 0xD0, 0xB0]).toString('utf8');
  const result = validateForbiddenTopics(`News about ${warWord}`);
  assert.strictEqual(result.valid, false);
});

test('should detect politics keyword', () => {
  // 'политик' in UTF-8
  const politicsWord = Buffer.from([0xD0, 0xBF, 0xD0, 0xBE, 0xD0, 0xBB, 0xD0, 0xB8, 0xD1, 0x82, 0xD0, 0xB8, 0xD0, 0xBA]).toString('utf8');
  const result = validateForbiddenTopics(`${politicsWord} news`);
  assert.strictEqual(result.valid, false);
});

test('should detect religion keyword', () => {
  // 'религиоз' in UTF-8
  const religionWord = Buffer.from([0xD1, 0x80, 0xD0, 0xB5, 0xD0, 0xBB, 0xD0, 0xB8, 0xD0, 0xB3, 0xD0, 0xB8, 0xD0, 0xBE, 0xD0, 0xB7]).toString('utf8');
  const result = validateForbiddenTopics(`${religionWord} content`);
  assert.strictEqual(result.valid, false);
});

test('should pass for safe content', () => {
  const result = validateForbiddenTopics('New recipes and desserts');
  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.errors.length, 0);
});

test('should pass for cooking content', () => {
  const result = validateForbiddenTopics('How to cook a delicious dinner');
  assert.strictEqual(result.valid, true);
});

group('Validators: validatePostForPublish');

test('should fail for invalid draft (no text)', () => {
  const result = validatePostForPublish({ text: '' });
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.length > 0);
});

test('should fail for forbidden topic', () => {
  // 'война' in UTF-8
  const warWord = Buffer.from([0xD0, 0xB2, 0xD0, 0xBE, 0xD0, 0xB9, 0xD0, 0xBD, 0xD0, 0xB0]).toString('utf8');
  const result = validatePostForPublish({
    text: `News about ${warWord} #news`.padEnd(100, '.'),
    imagePath: '/path/to/image.png'
  });
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.length > 0);
});

test('should pass for valid draft', () => {
  const result = validatePostForPublish({
    text: 'Good post about cooking with recipes #recipes #food'.padEnd(100, '.'),
    imagePath: '/path/to/image.png'
  });
  assert.strictEqual(result.valid, true);
});

group('Validators: autoCorrectPost');

test('should trim to max length', () => {
  const longText = 'a'.repeat(1100);
  const corrected = autoCorrectPost(longText);
  assert.ok(corrected.length <= MAX_POST_LENGTH);
});

test('should remove multiple spaces', () => {
  const result = autoCorrectPost('Текст  с   лишними    пробелами');
  assert.ok(!result.includes('  '));
});

test('should remove multiple newlines', () => {
  const result = autoCorrectPost('Строка1\n\n\n\n\nСтрока2');
  assert.ok(!result.includes('\n\n\n'));
});

// ============================================
// TASK-012: Тесты лимитов
// ============================================

group('Limits Module: getLimits');

test('should return default limits', () => {
  const limits = getLimits('test-chat');
  assert.strictEqual(limits.softLimit, DEFAULT_SOFT_LIMIT);
  assert.strictEqual(limits.hardLimit, DEFAULT_HARD_LIMIT);
});

test('should accept custom limits', () => {
  const limits = getLimits('test-chat', { softLimit: 3, hardLimit: 5 });
  assert.strictEqual(limits.softLimit, 3);
  assert.strictEqual(limits.hardLimit, 5);
});

test('should have textQuota and imageQuota', () => {
  const limits = getLimits('test-chat');
  assert.ok(limits.textQuota > 0);
  assert.ok(limits.imageQuota > 0);
});

group('Limits Module: QUOTA_TYPES');

test('should have TEXT_GENERATION type', () => {
  assert.ok(QUOTA_TYPES.TEXT_GENERATION);
});

test('should have IMAGE_GENERATION type', () => {
  assert.ok(QUOTA_TYPES.IMAGE_GENERATION);
});

test('should have PUBLICATION type', () => {
  assert.ok(QUOTA_TYPES.PUBLICATION);
});

// ============================================
// Итоги
// ============================================

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
