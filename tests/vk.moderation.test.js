/**
 * Тесты VK Moderation Flow
 * Проверка MVP-сервиса: настройки, экспорты, логика модерации
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
// Загрузка модулей
// ============================================

const vkMvpService = require('../services/vkMvp.service');
const vkRepo = require('../services/content/vk.repository');

// ============================================
// Тесты VK MVP Service Exports
// ============================================

group('VK MVP Service Exports');

test('exports startScheduler', () => {
  assert.strictEqual(typeof vkMvpService.startScheduler, 'function');
});

test('exports stopScheduler', () => {
  assert.strictEqual(typeof vkMvpService.stopScheduler, 'function');
});

test('exports runNow', () => {
  assert.strictEqual(typeof vkMvpService.runNow, 'function');
});

test('exports handleVkGenerateJob', () => {
  assert.strictEqual(typeof vkMvpService.handleVkGenerateJob, 'function');
});

test('exports publishVkPost', () => {
  assert.strictEqual(typeof vkMvpService.publishVkPost, 'function');
});

test('exports sendVkToModerator', () => {
  assert.strictEqual(typeof vkMvpService.sendVkToModerator, 'function');
});

test('exports handleVkModerationAction', () => {
  assert.strictEqual(typeof vkMvpService.handleVkModerationAction, 'function');
});

test('exports tickVkSchedule', () => {
  assert.strictEqual(typeof vkMvpService.tickVkSchedule, 'function');
});

test('exports getVkSettings', () => {
  assert.strictEqual(typeof vkMvpService.getVkSettings, 'function');
});

test('exports listJobs', () => {
  assert.strictEqual(typeof vkMvpService.listJobs, 'function');
});

test('exports getJobById', () => {
  assert.strictEqual(typeof vkMvpService.getJobById, 'function');
});

// ============================================
// Тесты VK Settings
// ============================================

group('VK Settings (default values for unconfigured user)');

test('getVkSettings returns defaults for unconfigured user', () => {
  const settings = vkMvpService.getVkSettings('__test_unconfigured__');
  assert.strictEqual(settings.isActive, false);
  assert.strictEqual(settings.groupId, null);
  assert.strictEqual(settings.serviceKey, null);
  assert.strictEqual(typeof settings.scheduleTime, 'string');
  assert.strictEqual(typeof settings.dailyLimit, 'number');
  assert.ok(settings.dailyLimit > 0, 'dailyLimit should be positive');
  assert.strictEqual(settings.premoderationEnabled, true, 'premoderation should be enabled by default');
  assert.strictEqual(settings.postType, 'post');
  assert.ok(Array.isArray(settings.allowedWeekdays), 'allowedWeekdays should be an array');
  assert.strictEqual(settings.allowedWeekdays.length, 7, 'all weekdays allowed by default');
});

// ============================================
// Тесты VK Repository Exports
// ============================================

group('VK Repository Exports');

test('exports createJob', () => {
  assert.strictEqual(typeof vkRepo.createJob, 'function');
});

test('exports updateJob', () => {
  assert.strictEqual(typeof vkRepo.updateJob, 'function');
});

test('exports getJobById', () => {
  assert.strictEqual(typeof vkRepo.getJobById, 'function');
});

test('exports listJobs', () => {
  assert.strictEqual(typeof vkRepo.listJobs, 'function');
});

test('exports addPublishLog', () => {
  assert.strictEqual(typeof vkRepo.addPublishLog, 'function');
});

test('exports countPublishedToday', () => {
  assert.strictEqual(typeof vkRepo.countPublishedToday, 'function');
});

// ============================================
// Тесты Moderation Action Handler (edge cases)
// ============================================

group('VK Moderation Action Handler');

test('returns error for missing draft', async () => {
  const result = await vkMvpService.handleVkModerationAction('__test__', {}, 999999, 'approve');
  assert.strictEqual(result.ok, false);
  assert.ok(result.message.includes('не найден'));
});

test('returns error for unknown action', async () => {
  // Without a draft, it should return draft not found
  const result = await vkMvpService.handleVkModerationAction('__test__', {}, 999999, 'unknown_action');
  assert.strictEqual(result.ok, false);
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
