-- Migration: 20260411_add_vk_video_channel
-- Adds 'vk' to channel CHECK constraints in video pipeline tables
-- Apply per-user: run against each db_{chatId} database
-- Run: psql -U postgres -d db_{chatId} -f migrations/20260411_add_vk_video_channel.sql

-- video_assets.initiating_channel: drop old constraint, add new with 'vk'
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'video_assets_channel_check'
  ) THEN
    ALTER TABLE video_assets DROP CONSTRAINT video_assets_channel_check;
  END IF;

  ALTER TABLE video_assets
    ADD CONSTRAINT video_assets_channel_check
    CHECK (initiating_channel IN ('youtube','tiktok','instagram','vk'));
END$$;

-- video_channel_usage.channel_type: drop old constraint, add new with 'vk'
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'video_channel_usage_channel_check'
  ) THEN
    ALTER TABLE video_channel_usage DROP CONSTRAINT video_channel_usage_channel_check;
  END IF;

  ALTER TABLE video_channel_usage
    ADD CONSTRAINT video_channel_usage_channel_check
    CHECK (channel_type IN ('youtube','tiktok','instagram','vk'));
END$$;
