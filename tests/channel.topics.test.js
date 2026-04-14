'use strict';

const assert = require('assert');

// Mock all heavy dependencies before requiring the module
const Module = require('module');
const originalLoad = Module._load;
Module._load = function (request, ...args) {
  if (request === 'node-fetch') return () => Promise.resolve({ ok: true, text: async () => '' });
  if (request === 'pg') return { Pool: class { query() {} end() {} } };
  if (request === '../config') return { DATA_ROOT: '/tmp', APP_URL: 'http://localhost' };
  if (request === '../manage/store') return { getState: () => ({}), getAllStates: () => ({}) };
  if (request === './ai_router_service') return { callAI: async () => '' };
  if (request === './content/repository') return {};
  if (request === './content/index') return {
    repository: {},
    queueRepo: {},
    generateCorrelationId: () => 'x',
    worker: { registerJobHandler: () => {} },
    validators: {
      validatePostForPublish: () => ({}),
      autoCorrectPost: () => ({})
    },
    limits: {
      checkQuota: async () => ({}),
      getUsageStats: async () => ({}),
      QUOTA_TYPES: {}
    },
    STATUS: {},
    JOB_STATUS: {},
    QUEUE_STATUS: {},
    PUBLISH_LOG_STATUS: {},
    validateJobStatusTransition: () => ({}),
    videoService: {},
    VIDEO_STATUS: {}
  };
  if (request === './session.service') return {};
  if (request === './storage.service') return { getDataDir: () => '/tmp' };
  if (request === './inputImageContext.service') return {};
  if (request === './image.service') return {};
  if (request === './imageGen.service') return {};
  return originalLoad.call(this, request, ...args);
};

const { normalizeChannel } = require('../services/telegramMvp.service');
Module._load = originalLoad;

const colors = { green: '\x1b[32m', red: '\x1b[31m', reset: '\x1b[0m' };
let passed = 0, failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ${colors.green}✓${colors.reset} ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ${colors.red}✗${colors.reset} ${name}: ${e.message}`);
    failed++;
  }
}

console.log('\nnormalizeChannel');

test('lowercase known channel returned as-is', () => {
  assert.strictEqual(normalizeChannel('telegram'), 'telegram');
  assert.strictEqual(normalizeChannel('vk'), 'vk');
  assert.strictEqual(normalizeChannel('vk_video'), 'vk_video');
  assert.strictEqual(normalizeChannel('ok'), 'ok');
  assert.strictEqual(normalizeChannel('instagram'), 'instagram');
  assert.strictEqual(normalizeChannel('instagram_reels'), 'instagram_reels');
  assert.strictEqual(normalizeChannel('facebook'), 'facebook');
  assert.strictEqual(normalizeChannel('pinterest'), 'pinterest');
  assert.strictEqual(normalizeChannel('youtube'), 'youtube');
  assert.strictEqual(normalizeChannel('wordpress'), 'wordpress');
  assert.strictEqual(normalizeChannel('tiktok'), 'tiktok');
});

test('uppercase input is normalised to lowercase', () => {
  assert.strictEqual(normalizeChannel('VK'), 'vk');
  assert.strictEqual(normalizeChannel('INSTAGRAM_REELS'), 'instagram_reels');
  assert.strictEqual(normalizeChannel('Telegram'), 'telegram');
});

test('whitespace is trimmed', () => {
  assert.strictEqual(normalizeChannel('  vk  '), 'vk');
  assert.strictEqual(normalizeChannel('\ttiktok\n'), 'tiktok');
});

test('empty / blank string returns null', () => {
  assert.strictEqual(normalizeChannel(''), null);
  assert.strictEqual(normalizeChannel('   '), null);
  assert.strictEqual(normalizeChannel(null), null);
  assert.strictEqual(normalizeChannel(undefined), null);
});

test('unknown value returns null', () => {
  assert.strictEqual(normalizeChannel('twitter'), null);
  assert.strictEqual(normalizeChannel('vk-video'), null); // dash not underscore
  assert.strictEqual(normalizeChannel('all'), null);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
