-- =====================================================
-- FACEBOOK INTEGRATION MIGRATION
-- 2026-04-06
-- =====================================================

-- =====================================================
-- Per-user DB (db_{chatId}) — выполняется через ensureSchema()
-- Таблицы facebook_jobs и facebook_publish_logs создаются автоматически
-- при вызове facebookRepo.ensureSchema(chatId)
-- =====================================================

-- =====================================================
-- Центральная БД (clientzavod) — выполнить вручную
-- =====================================================

-- Расширение content_channels для Facebook-специфичных полей
ALTER TABLE content_channels ADD COLUMN IF NOT EXISTS fb_buffer_channel_id VARCHAR(100);
ALTER TABLE content_channels ADD COLUMN IF NOT EXISTS fb_page_name VARCHAR(255);
ALTER TABLE content_channels ADD COLUMN IF NOT EXISTS fb_buffer_api_key VARCHAR(500);

-- Индекс для оптимизации запросов по Facebook каналам
CREATE INDEX IF NOT EXISTS idx_content_channels_fb ON content_channels(fb_buffer_channel_id) WHERE fb_buffer_channel_id IS NOT NULL;

-- ============================================
-- Алерты: пороги для Facebook
-- Обновить в services/content/alerts.js
-- ============================================
-- Добавить в ALERT_THRESHOLDS:
--   facebookConsecutiveFailures: 3
--   facebookQueueBacklog: 10
--   facebookRateLimit: 1
-- ============================================

-- ============================================
-- Лимиты: константы для Facebook
-- Обновить в services/content/limits.js
-- ============================================
-- Добавить в QUOTA_TYPES:
--   FACEBOOK_PUBLICATION: 'facebook_publication'
-- Добавить константу:
--   FACEBOOK_DAILY_LIMIT = 10
-- ============================================
