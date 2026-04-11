-- =====================================================
-- VIDEO PIPELINE MIGRATION
-- 2026-04-10
-- =====================================================
-- Отдельный пайплайн генерации видео для переиспользования каналами
-- YouTube, TikTok, Instagram используют одно видео, добавляя свои тексты/теги
-- =====================================================

-- =====================================================
-- Per-user DB (db_{chatId}) — создаётся через ensureSchema() в repository
-- =====================================================

-- -------------------------------------------
-- Таблица интерьеров
-- -------------------------------------------
CREATE TABLE IF NOT EXISTS interiors (
  id BIGSERIAL PRIMARY KEY,
  chat_id TEXT NOT NULL,
  description TEXT NOT NULL,
  style VARCHAR(100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_interiors_chat ON interiors(chat_id);
CREATE INDEX IF NOT EXISTS idx_interiors_chat_style ON interiors(chat_id, style);

-- -------------------------------------------
-- Таблица видео-ассетов
-- -------------------------------------------
CREATE TABLE IF NOT EXISTS video_assets (
  id BIGSERIAL PRIMARY KEY,
  chat_id TEXT NOT NULL,
  product_image_path TEXT NOT NULL,
  interior_id BIGINT,
  scene_image_path TEXT,
  video_path TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  provider TEXT DEFAULT 'kie-veo3.1',
  video_duration INT,
  file_size BIGINT,
  correlation_id TEXT,
  initiating_channel TEXT,
  error_text TEXT,
  all_channels_marked_at TIMESTAMPTZ,
  scheduled_deletion_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_video_interior FOREIGN KEY (interior_id) REFERENCES interiors(id) ON DELETE SET NULL,
  CONSTRAINT video_assets_status_check CHECK (
    status IN (
      'pending',
      'scene_generating',
      'scene_ready',
      'video_generating',
      'video_ready',
      'published',
      'expired',
      'failed'
    )
  ),
  CONSTRAINT video_assets_channel_check CHECK (
    initiating_channel IN ('youtube', 'tiktok', 'instagram')
  )
);

CREATE INDEX IF NOT EXISTS idx_video_assets_chat_status ON video_assets(chat_id, status);
CREATE INDEX IF NOT EXISTS idx_video_assets_deletion
  ON video_assets(scheduled_deletion_at)
  WHERE scheduled_deletion_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_video_assets_chat_created
  ON video_assets(chat_id, created_at DESC);

-- -------------------------------------------
-- Таблица меток использования видео каналами
-- -------------------------------------------
CREATE TABLE IF NOT EXISTS video_channel_usage (
  id BIGSERIAL PRIMARY KEY,
  video_id BIGINT,
  channel_type TEXT NOT NULL,
  used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_usage_video FOREIGN KEY (video_id) REFERENCES video_assets(id) ON DELETE CASCADE,
  CONSTRAINT video_channel_usage_unique UNIQUE(video_id, channel_type),
  CONSTRAINT video_channel_usage_channel_check CHECK (
    channel_type IN ('youtube', 'tiktok', 'instagram')
  )
);

CREATE INDEX IF NOT EXISTS idx_video_channel_usage_video ON video_channel_usage(video_id);
CREATE INDEX IF NOT EXISTS idx_video_channel_usage_channel ON video_channel_usage(channel_type);
