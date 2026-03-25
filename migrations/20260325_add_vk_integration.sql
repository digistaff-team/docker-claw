-- =====================================================
-- VK INTEGRATION MIGRATION
-- 2026-03-25
-- =====================================================

-- =====================================================
-- Per-user DB (db_{chatId}) — выполняется через ensureSchema()
-- Таблицы vk_jobs и vk_publish_logs создаются автоматически
-- при вызове repository.ensureSchema(chatId)
-- =====================================================

-- =====================================================
-- Центральная БД (clientzavod) — выполнить вручную
-- =====================================================

-- Расширение content_channels для VK-специфичных полей
ALTER TABLE content_channels ADD COLUMN IF NOT EXISTS vk_group_id BIGINT;
ALTER TABLE content_channels ADD COLUMN IF NOT EXISTS vk_upload_method VARCHAR(20) DEFAULT 'wall';
ALTER TABLE content_channels ADD COLUMN IF NOT EXISTS vk_publish_location VARCHAR(20) DEFAULT 'group';
ALTER TABLE content_channels ADD COLUMN IF NOT EXISTS vk_signed BOOLEAN DEFAULT true;
ALTER TABLE content_channels ADD COLUMN IF NOT EXISTS vk_primary_attachments_mode VARCHAR(20) DEFAULT 'carousel';
