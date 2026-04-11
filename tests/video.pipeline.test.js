/**
 * Video Pipeline Tests
 */
const assert = require('assert');
const vpRepo = require('../services/content/videoPipeline.repository');

console.log('🧪 Running Video Pipeline Tests...\n');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✅ ${name}`);
    passed++;
  } catch (e) {
    console.error(`❌ ${name}`);
    console.error(`   Error: ${e.message}`);
    failed++;
  }
}

// Test 1: Repository exports
test('videoPipeline.repository.js exports all functions', () => {
  assert.strictEqual(typeof vpRepo.ensureSchema, 'function');
  assert.strictEqual(typeof vpRepo.addInterior, 'function');
  assert.strictEqual(typeof vpRepo.getInteriors, 'function');
  assert.strictEqual(typeof vpRepo.getRandomInterior, 'function');
  assert.strictEqual(typeof vpRepo.deleteInterior, 'function');
  assert.strictEqual(typeof vpRepo.createVideoAsset, 'function');
  assert.strictEqual(typeof vpRepo.getVideoById, 'function');
  assert.strictEqual(typeof vpRepo.updateVideoStatus, 'function');
  assert.strictEqual(typeof vpRepo.getAvailableVideoForChannel, 'function');
  assert.strictEqual(typeof vpRepo.listVideos, 'function');
  assert.strictEqual(typeof vpRepo.getVideoStats, 'function');
  assert.strictEqual(typeof vpRepo.markVideoUsed, 'function');
  assert.strictEqual(typeof vpRepo.markVideoUsedById, 'function');
  assert.strictEqual(typeof vpRepo.getVideoUsageMarks, 'function');
  assert.strictEqual(typeof vpRepo.cancelDeletionSchedule, 'function');
  assert.strictEqual(typeof vpRepo.getExpiredVideos, 'function');
  assert.strictEqual(typeof vpRepo.getExpiredVideosForChat, 'function');
  assert.strictEqual(typeof vpRepo.markVideoExpired, 'function');
  assert.strictEqual(typeof vpRepo.deleteVideoAsset, 'function');
  assert.strictEqual(typeof vpRepo.withClient, 'function');
  assert.strictEqual(typeof vpRepo.withTransaction, 'function');
  assert.ok(Array.isArray(vpRepo.CHANNELS));
  assert.strictEqual(vpRepo.CHANNELS.length, 4);
});

// Test 2: CHANNELS constant
test('CHANNELS contains youtube, tiktok, instagram', () => {
  assert.ok(vpRepo.CHANNELS.includes('youtube'), 'CHANNELS must include youtube');
  assert.ok(vpRepo.CHANNELS.includes('tiktok'), 'CHANNELS must include tiktok');
  assert.ok(vpRepo.CHANNELS.includes('instagram'), 'CHANNELS must include instagram');
});

// Test 3: Video Pipeline Service
test('videoPipeline.service.js exports all functions', () => {
  const videoPipeline = require('../services/videoPipeline.service');
  assert.strictEqual(typeof videoPipeline.init, 'function');
  assert.strictEqual(typeof videoPipeline.getInputImages, 'function');
  assert.strictEqual(typeof videoPipeline.getRandomProductImage, 'function');
  assert.strictEqual(typeof videoPipeline.addInterior, 'function');
  assert.strictEqual(typeof videoPipeline.getInteriors, 'function');
  assert.strictEqual(typeof videoPipeline.getRandomInterior, 'function');
  assert.strictEqual(typeof videoPipeline.deleteInterior, 'function');
  assert.strictEqual(typeof videoPipeline.generateVideo, 'function');
  assert.strictEqual(typeof videoPipeline.claimVideo, 'function');
  assert.strictEqual(typeof videoPipeline.markVideoUsed, 'function');
  assert.strictEqual(typeof videoPipeline.getVideoById, 'function');
  assert.strictEqual(typeof videoPipeline.listVideos, 'function');
  assert.strictEqual(typeof videoPipeline.getVideoStats, 'function');
  assert.strictEqual(typeof videoPipeline.getVideoUsageMarks, 'function');
  assert.strictEqual(typeof videoPipeline.cleanupExpiredVideos, 'function');
  assert.strictEqual(typeof videoPipeline.startCleanupScheduler, 'function');
  assert.strictEqual(typeof videoPipeline.stopCleanupScheduler, 'function');
  assert.strictEqual(typeof videoPipeline.VIDEO_TEMP_ROOT, 'string');
});

// Test 4: Video Routes
test('video.routes.js exports router', () => {
  const videoRoutes = require('../routes/video.routes');
  assert.ok(videoRoutes);
  assert.strictEqual(typeof videoRoutes, 'function'); // express router
});

// Test 5: TikTok MVP Service
test('tiktokMvp.service.js exports all functions', () => {
  const tiktokMvp = require('../services/tiktokMvp.service');
  assert.strictEqual(typeof tiktokMvp.handleTiktokGenerateJob, 'function');
  assert.strictEqual(typeof tiktokMvp.handleTiktokModerationAction, 'function');
  assert.strictEqual(typeof tiktokMvp.startScheduler, 'function');
  assert.strictEqual(typeof tiktokMvp.stopScheduler, 'function');
  assert.strictEqual(typeof tiktokMvp.setTiktokCwBot, 'function');
  assert.strictEqual(typeof tiktokMvp.getTiktokSettings, 'function');
  assert.strictEqual(typeof tiktokMvp.publishTiktokPost, 'function');
});

// Test 6: Manage Store TikTok functions
test('manageStore has TikTok functions', () => {
  const manageStore = require('../manage/store');
  assert.strictEqual(typeof manageStore.getTiktokConfig, 'function');
  assert.strictEqual(typeof manageStore.setTiktokConfig, 'function');
  assert.strictEqual(typeof manageStore.clearTiktokConfig, 'function');
});

// Test 7: Video status constants
test('Video statuses are defined correctly in migration', () => {
  const fs = require('fs');
  const migration = fs.readFileSync('./migrations/20260410_add_video_pipeline.sql', 'utf-8');

  // Check status constraint
  assert.ok(migration.includes("'pending'"));
  assert.ok(migration.includes("'scene_generating'"));
  assert.ok(migration.includes("'scene_ready'"));
  assert.ok(migration.includes("'video_generating'"));
  assert.ok(migration.includes("'video_ready'"));
  assert.ok(migration.includes("'published'"));
  assert.ok(migration.includes("'expired'"));
  assert.ok(migration.includes("'failed'"));

  // Check channel constraint
  assert.ok(migration.includes("'youtube'"));
  assert.ok(migration.includes("'tiktok'"));
  assert.ok(migration.includes("'instagram'"));
});

// Test 8: Environment variables
test('.env.example has video pipeline variables', () => {
  const fs = require('fs');
  const envExample = fs.readFileSync('./.env.example', 'utf-8');

  assert.ok(envExample.includes('VIDEO_TEMP_ROOT'));
  assert.ok(envExample.includes('VIDEO_CLEANUP_INTERVAL_MS'));
  assert.ok(envExample.includes('VIDEO_DELETION_DELAY_MIN'));
  assert.ok(envExample.includes('VIDEO_MODEL'));
  assert.ok(envExample.includes('VIDEO_ASPECT_RATIO'));
  assert.ok(envExample.includes('TIKTOK_DAILY_LIMIT'));
  assert.ok(envExample.includes('TIKTOK_MODERATION_TIMEOUT_HOURS'));
});

// Test 9: CHANNELS contains vk
test('CHANNELS contains youtube, tiktok, instagram, vk', () => {
  assert.deepStrictEqual(vpRepo.CHANNELS, ['youtube', 'tiktok', 'instagram', 'vk']);
  assert.strictEqual(vpRepo.CHANNELS.length, 4);
});

// Test 10: VK Video MVP Service
test('vkVideoMvp.service.js exports all functions', () => {
  const vkVideoMvp = require('../services/vkVideoMvp.service');
  assert.strictEqual(typeof vkVideoMvp.handleVkVideoGenerateJob, 'function');
  assert.strictEqual(typeof vkVideoMvp.handleVkVideoModerationAction, 'function');
  assert.strictEqual(typeof vkVideoMvp.startScheduler, 'function');
  assert.strictEqual(typeof vkVideoMvp.stopScheduler, 'function');
  assert.strictEqual(typeof vkVideoMvp.setVkVideoCwBot, 'function');
  assert.strictEqual(typeof vkVideoMvp.getVkVideoSettings, 'function');
  assert.strictEqual(typeof vkVideoMvp.publishVkVideoPost, 'function');
});

// Test 11: manageStore VK Video functions
test('manageStore has VK Video functions', () => {
  const manageStore = require('../manage/store');
  assert.strictEqual(typeof manageStore.getVkVideoConfig, 'function');
  assert.strictEqual(typeof manageStore.setVkVideoConfig, 'function');
  assert.strictEqual(typeof manageStore.clearVkVideoConfig, 'function');
});

// Test 12: Migration contains vk
test('Video migration contains vk channel', () => {
  const fs = require('fs');
  const migration = fs.readFileSync('./migrations/20260411_add_vk_video_channel.sql', 'utf-8');
  assert.ok(migration.includes("'vk'"), "Migration must include 'vk' in channel constraints");
});

// Test 13: ENV has VK Video variables
test('.env.example has VK Video pipeline variables', () => {
  const fs = require('fs');
  const envExample = fs.readFileSync('./.env.example', 'utf-8');
  assert.ok(envExample.includes('VK_VIDEO_DAILY_LIMIT'));
  assert.ok(envExample.includes('VK_VIDEO_MODERATION_TIMEOUT_HOURS'));
  assert.ok(envExample.includes('vk'), 'VIDEO_CHANNELS must include vk');
});

// Summary
console.log('\n' + '='.repeat(50));
console.log(`Tests: ${passed} passed, ${failed} failed, ${passed + failed} total`);

if (failed > 0) {
  console.log('\n❌ Some tests failed');
  process.exit(1);
} else {
  console.log('\n✅ All tests passed');
  process.exit(0);
}
