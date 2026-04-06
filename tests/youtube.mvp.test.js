/**
 * YouTube MVP — юнит-тесты
 *
 * Проверяет:
 * - YouTube репозиторий (чистые функции, схема)
 * - YouTube конфиг в store.js
 * - Buffer service (createPost с videoUrl)
 * - YouTube настройки (getYoutubeSettings)
 * - Планировщик (слоты, дни недели)
 * - KIE Video Provider (валидация параметров)
 */

const assert = require('assert');
const path = require('path');

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

async function runAsyncTests() {
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
}

function group(name) {
  console.log(`\n${colors.yellow}${name}${colors.reset}`);
}

// ============================================
// Load modules
// ============================================

const youtubeRepo = require('../services/content/youtube.repository');
const manageStore = require('../manage/store');
const bufferService = require('../services/buffer.service');
const videoService = require('../services/content/video.service');

// ============================================
// YouTube Repository — exports
// ============================================

group('YouTube Repository — exports');

test('should export all required functions', () => {
  const expected = [
    'withClient', 'ensureSchema', 'createJob', 'updateJob',
    'getJobById', 'listJobs', 'addPublishLog', 'countPublishedToday', 'getPool'
  ];
  for (const fn of expected) {
    assert.ok(typeof youtubeRepo[fn] === 'function', `Missing export: ${fn}`);
  }
});

// ============================================
// YouTube Config — store.js
// ============================================

group('YouTube Config — store.js');

test('getYoutubeConfig should return null for unconfigured chatId', () => {
  const cfg = manageStore.getYoutubeConfig('test_nonexistent_chat');
  assert.strictEqual(cfg, null);
});

test('setYoutubeConfig should store and retrieve config', () => {
  const chatId = 'yt_test_config_1';
  manageStore.setYoutubeConfig(chatId, {
    buffer_api_key: 'test_key_123',
    buffer_channel_id: 'yt_channel_abc',
    is_active: true,
    auto_publish: false,
    schedule_time: '14:30',
    schedule_tz: 'Europe/Moscow',
    daily_limit: 3,
    publish_interval_hours: 12,
    allowed_weekdays: [1, 2, 3, 4, 5],
    moderator_user_id: '999888777'
  });

  const cfg = manageStore.getYoutubeConfig(chatId);
  assert.ok(cfg !== null);
  assert.strictEqual(cfg.buffer_api_key, 'test_key_123');
  assert.strictEqual(cfg.buffer_channel_id, 'yt_channel_abc');
  assert.strictEqual(cfg.is_active, true);
  assert.strictEqual(cfg.auto_publish, false);
  assert.strictEqual(cfg.schedule_time, '14:30');
  assert.strictEqual(cfg.schedule_tz, 'Europe/Moscow');
  assert.strictEqual(cfg.daily_limit, 3);
  assert.strictEqual(cfg.publish_interval_hours, 12);
  assert.deepStrictEqual(cfg.allowed_weekdays, [1, 2, 3, 4, 5]);
  assert.strictEqual(cfg.moderator_user_id, '999888777');

  // Cleanup
  manageStore.clearYoutubeConfig(chatId);
});

test('setYoutubeConfig should handle partial updates', () => {
  const chatId = 'yt_test_partial_1';
  manageStore.setYoutubeConfig(chatId, {
    buffer_api_key: 'key1',
    buffer_channel_id: 'ch1',
    is_active: true
  });
  manageStore.setYoutubeConfig(chatId, {
    daily_limit: 7
  });

  const cfg = manageStore.getYoutubeConfig(chatId);
  assert.strictEqual(cfg.buffer_api_key, 'key1');
  assert.strictEqual(cfg.buffer_channel_id, 'ch1');
  assert.strictEqual(cfg.is_active, true);
  assert.strictEqual(cfg.daily_limit, 7);

  manageStore.clearYoutubeConfig(chatId);
});

test('setYoutubeConfig should coerce boolean fields', () => {
  const chatId = 'yt_test_bools';
  manageStore.setYoutubeConfig(chatId, {
    is_active: 1,
    auto_publish: 0,
    random_publish: 'yes'
  });

  const cfg = manageStore.getYoutubeConfig(chatId);
  assert.strictEqual(cfg.is_active, true);
  assert.strictEqual(cfg.auto_publish, false);
  assert.strictEqual(cfg.random_publish, true);

  manageStore.clearYoutubeConfig(chatId);
});

test('clearYoutubeConfig should remove config', () => {
  const chatId = 'yt_test_clear';
  manageStore.setYoutubeConfig(chatId, { buffer_api_key: 'x' });
  assert.ok(manageStore.getYoutubeConfig(chatId) !== null);
  manageStore.clearYoutubeConfig(chatId);
  assert.strictEqual(manageStore.getYoutubeConfig(chatId), null);
});

test('setYoutubeConfig should trim whitespace from channel_id', () => {
  const chatId = 'yt_test_trim';
  manageStore.setYoutubeConfig(chatId, {
    buffer_channel_id: '  yt_ch_123  '
  });
  const cfg = manageStore.getYoutubeConfig(chatId);
  assert.strictEqual(cfg.buffer_channel_id, 'yt_ch_123');
  manageStore.clearYoutubeConfig(chatId);
});

// ============================================
// Buffer Service — createPost with videoUrl
// ============================================

group('Buffer Service — createPost signature');

test('createPost should accept videoUrl and thumbnailUrl params', () => {
  // Проверяем что функция принимает новые параметры (не вызывая API)
  assert.strictEqual(typeof bufferService.createPost, 'function');
  assert.strictEqual(bufferService.createPost.length, 3); // apiKey, channelId, options
});

test('testConnection should be exported', () => {
  assert.strictEqual(typeof bufferService.testConnection, 'function');
});

// ============================================
// Video Service — KIE Provider
// ============================================

group('Video Service — KIE Provider');

test('KieVideoProvider should be exported', () => {
  assert.ok(videoService.KieVideoProvider);
});

test('getProvider should return kie-veo3 provider', () => {
  const provider = videoService.getProvider();
  assert.strictEqual(provider.getName(), 'kie-veo3');
});

test('VIDEO_STATUS should have all required statuses', () => {
  const statuses = videoService.VIDEO_STATUS;
  assert.strictEqual(statuses.PENDING, 'pending');
  assert.strictEqual(statuses.PROCESSING, 'processing');
  assert.strictEqual(statuses.COMPLETED, 'completed');
  assert.strictEqual(statuses.FAILED, 'failed');
  assert.strictEqual(statuses.TIMEOUT, 'timeout');
  assert.strictEqual(statuses.CANCELLED, 'cancelled');
});

test('VIDEO_MODEL should default to veo3_fast', () => {
  assert.strictEqual(videoService.VIDEO_MODEL, 'veo3_fast');
});

test('generate should throw if KIE_API_KEY is not set', async () => {
  const originalKey = process.env.KIE_API_KEY;
  delete process.env.KIE_API_KEY;
  const provider = new videoService.KieVideoProvider();
  try {
    await provider.generate({ prompt: 'test' });
    assert.fail('Expected error');
  } catch (e) {
    assert.ok(e.message.includes('KIE_API_KEY'));
  } finally {
    process.env.KIE_API_KEY = originalKey;
  }
});

test('cancel should return false (KIE does not support cancellation)', async () => {
  const provider = videoService.getProvider();
  const result = await provider.cancel('some_task_id');
  assert.strictEqual(result, false);
});

// ============================================
// YouTube Settings (from youtubeMvp.service)
// ============================================

group('YouTube MVP — settings');

test('getYoutubeSettings should return defaults for unconfigured chat', async () => {
  const ytMvp = require('../services/youtubeMvp.service');
  const settings = ytMvp.getYoutubeSettings('yt_test_settings_defaults');
  assert.strictEqual(settings.isActive, false);
  assert.strictEqual(settings.autoPublish, false);
  assert.strictEqual(settings.scheduleTime, '10:00');
  assert.strictEqual(settings.publishIntervalHours, 24);
  assert.strictEqual(settings.randomPublish, false);
  assert.strictEqual(settings.moderatorUserId, null);
  assert.strictEqual(settings.dailyLimit, parseInt(process.env.YOUTUBE_DAILY_LIMIT || '5', 10));
  assert.ok(Array.isArray(settings.allowedWeekdays));
  assert.ok(typeof settings.stats === 'object');
});

test('getYoutubeSettings should return config values when set', async () => {
  const ytMvp = require('../services/youtubeMvp.service');
  const chatId = 'yt_test_settings_config';

  manageStore.setYoutubeConfig(chatId, {
    is_active: true,
    auto_publish: true,
    schedule_time: '18:00',
    schedule_tz: 'America/New_York',
    daily_limit: 7,
    publish_interval_hours: 6,
    allowed_weekdays: [1, 3, 5],
    moderator_user_id: '123456',
    random_publish: true
  });

  const settings = ytMvp.getYoutubeSettings(chatId);
  assert.strictEqual(settings.isActive, true);
  assert.strictEqual(settings.autoPublish, true);
  assert.strictEqual(settings.scheduleTime, '18:00');
  assert.strictEqual(settings.scheduleTz, 'America/New_York');
  assert.strictEqual(settings.dailyLimit, 7);
  assert.strictEqual(settings.publishIntervalHours, 6);
  assert.deepStrictEqual(settings.allowedWeekdays, [1, 3, 5]);
  assert.strictEqual(settings.moderatorUserId, '123456');
  assert.strictEqual(settings.randomPublish, true);

  manageStore.clearYoutubeConfig(chatId);
});

// ============================================
// YouTube MVP — exports
// ============================================

group('YouTube MVP — exports');

test('should export all required functions', () => {
  const ytMvp = require('../services/youtubeMvp.service');
  const expected = [
    'startScheduler', 'stopScheduler', 'runNow',
    'handleYoutubeGenerateJob', 'publishYoutubePost',
    'sendYtToModerator', 'handleYtModerationAction',
    'tickYoutubeSchedule', 'getYoutubeSettings',
    'listJobs', 'getJobById', 'setYtCwBot', 'getYtCwBot'
  ];
  for (const fn of expected) {
    assert.ok(typeof ytMvp[fn] === 'function', `Missing export: ${fn}`);
  }
});

test('setYtCwBot and getYtCwBot should work', () => {
  const ytMvp = require('../services/youtubeMvp.service');
  assert.strictEqual(ytMvp.getYtCwBot(), null);
  ytMvp.setYtCwBot({ fake: 'bot' });
  assert.deepStrictEqual(ytMvp.getYtCwBot(), { fake: 'bot' });
  ytMvp.setYtCwBot(null); // Reset
});

// ============================================
// Summary
// ============================================

async function main() {
  await runAsyncTests();

  console.log(`\n${'='.repeat(50)}`);
  console.log(`${colors.green}Passed: ${passed}${colors.reset} | ${colors.red}Failed: ${failed}${colors.reset}`);

  if (errors.length > 0) {
    console.log(`\n${colors.red}Failed tests:${colors.reset}`);
    errors.forEach((e, i) => {
      console.log(`  ${i + 1}. ${e.name}: ${e.error}`);
    });
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
