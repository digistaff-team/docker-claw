-- Миграция: добавление поля channel в таблицу content_topics
-- Позволяет привязывать темы к конкретным каналам (telegram, vk, facebook, wordpress, instagram, pinterest)

-- Добавить колонку channel
ALTER TABLE content_topics ADD COLUMN IF NOT EXISTS channel VARCHAR(50) DEFAULT NULL;

-- Индекс для фильтрации по каналу
CREATE INDEX IF NOT EXISTS idx_content_topics_channel ON content_topics(channel);

-- Составной индекс для часто используемых запросов (status + channel + created_at)
CREATE INDEX IF NOT EXISTS idx_content_topics_status_channel ON content_topics(status, channel, created_at, id);
