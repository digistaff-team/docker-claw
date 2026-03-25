/**
 * Тесты VK Publisher Service
 * Валидация параметров, структура API-вызовов
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
// Загрузка модуля
// ============================================

const vkService = require('../services/vk.service');

// ============================================
// Тесты
// ============================================

group('VK Parameter Validation');

test('validates missing group_id', () => {
  const result = vkService.validateVkParams({ serviceKey: 'key123', text: 'Hello' });
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('group_id')));
});

test('validates missing service_key', () => {
  const result = vkService.validateVkParams({ groupId: '123', text: 'Hello' });
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('service_key')));
});

test('validates text length limit', () => {
  const longText = 'A'.repeat(20000);
  const result = vkService.validateVkParams({ groupId: '123', serviceKey: 'key', text: longText });
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('16384')));
});

test('passes valid params', () => {
  const result = vkService.validateVkParams({ groupId: '123', serviceKey: 'key', text: 'Hello VK' });
  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.errors.length, 0);
});

test('passes valid params without text', () => {
  const result = vkService.validateVkParams({ groupId: '123', serviceKey: 'key' });
  assert.strictEqual(result.valid, true);
});

test('passes with empty text', () => {
  const result = vkService.validateVkParams({ groupId: '123', serviceKey: 'key', text: '' });
  assert.strictEqual(result.valid, true);
});

group('VK Service Exports');

test('exports all required methods', () => {
  assert.strictEqual(typeof vkService.callVkApi, 'function');
  assert.strictEqual(typeof vkService.getWallUploadServer, 'function');
  assert.strictEqual(typeof vkService.uploadPhoto, 'function');
  assert.strictEqual(typeof vkService.saveWallPhoto, 'function');
  assert.strictEqual(typeof vkService.publishPhotoPost, 'function');
  assert.strictEqual(typeof vkService.getGroupInfo, 'function');
  assert.strictEqual(typeof vkService.validateVkParams, 'function');
  assert.strictEqual(typeof vkService.getServiceKey, 'function');
});

// ============================================
// Итоги
// ============================================

console.log(`\n${colors.yellow}Results:${colors.reset} ${passed} passed, ${failed} failed`);
if (errors.length > 0) {
  console.log(`\n${colors.red}Failures:${colors.reset}`);
  errors.forEach(e => console.log(`  - ${e.name}: ${e.error}`));
}
process.exit(failed > 0 ? 1 : 0);
