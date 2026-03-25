/**
 * Создать базу данных и схему content_queue для пользователя
 * 
 * Использование:
 *   node create-user-db.js <chatId>
 * 
 * Пример:
 *   node create-user-db.js 8092697980
 */

const { Client } = require('pg');
const config = require('./config');

const chatId = process.argv[2];

if (!chatId) {
  console.log('Использование: node create-user-db.js <chatId>');
  console.log('Пример: node create-user-db.js 8092697980');
  process.exit(1);
}

const dbName = `db_${String(chatId).replace(/[^a-z0-9_]/gi, '_').toLowerCase()}`;

async function createDatabase() {
  console.log(`🔧 Создание базы данных для пользователя ${chatId}...`);
  console.log(`📁 Имя БД: ${dbName}`);
  
  // Подключаемся к postgres для создания БД
  const adminClient = new Client({
    host: config.PG_ADMIN_HOST || config.PG_HOST,
    port: config.PG_PORT,
    user: config.PG_USER,
    password: config.PG_PASSWORD,
    database: 'postgres',
    ssl: false,
    connectionTimeoutMillis: 5000
  });
  
  try {
    await adminClient.connect();
    console.log('✅ Подключено к PostgreSQL');
    
    // Проверяем, существует ли БД
    const checkResult = await adminClient.query(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      [dbName]
    );
    
    if (checkResult.rows.length > 0) {
      console.log(`ℹ️  База данных ${dbName} уже существует`);
    } else {
      // Создаём БД
      await adminClient.query(`CREATE DATABASE ${dbName}`);
      console.log(`✅ База данных ${dbName} создана`);
    }
    
    await adminClient.end();
    
    // Подключаемся к новой БД и создаём таблицу
    const dbClient = new Client({
      host: config.PG_ADMIN_HOST || config.PG_HOST,
      port: config.PG_PORT,
      user: config.PG_USER,
      password: config.PG_PASSWORD,
      database: dbName,
      ssl: false,
      connectionTimeoutMillis: 5000
    });
    
    await dbClient.connect();
    console.log('✅ Подключено к новой базе данных');
    
    // Создаём таблицу content_job_queue
    await dbClient.query(`
      CREATE TABLE IF NOT EXISTS content_job_queue (
        id BIGSERIAL PRIMARY KEY,
        chat_id TEXT NOT NULL,
        job_type TEXT NOT NULL,
        job_id BIGINT,
        priority INT NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'queued',
        attempts INT NOT NULL DEFAULT 0,
        max_attempts INT NOT NULL DEFAULT 5,
        next_run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        started_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        error_text TEXT,
        payload JSONB,
        correlation_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    console.log('✅ Таблица content_job_queue создана');
    
    // Создаём индексы
    await dbClient.query(`
      CREATE INDEX IF NOT EXISTS idx_content_job_queue_poll
      ON content_job_queue (chat_id, status, next_run_at)
      WHERE status = 'queued';
    `);
    console.log('✅ Индексы созданы');
    
    // Создаём таблицу content_jobs
    await dbClient.query(`
      CREATE TABLE IF NOT EXISTS content_jobs (
        id BIGSERIAL PRIMARY KEY,
        chat_id TEXT NOT NULL,
        sheet_row BIGINT,
        sheet_topic TEXT,
        status TEXT NOT NULL DEFAULT 'draft',
        error_text TEXT,
        content_type TEXT DEFAULT 'text+image',
        image_attempts INT DEFAULT 0,
        rejected_count INT DEFAULT 0,
        draft_text TEXT,
        image_path TEXT,
        video_path TEXT,
        correlation_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    console.log('✅ Таблица content_jobs создана');
    
    // Создаём таблицу content_posts
    await dbClient.query(`
      CREATE TABLE IF NOT EXISTS content_posts (
        id BIGSERIAL PRIMARY KEY,
        job_id BIGINT REFERENCES content_jobs(id),
        body_text TEXT,
        hashtags TEXT,
        content_type TEXT DEFAULT 'text+image',
        publish_status TEXT DEFAULT 'draft',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    console.log('✅ Таблица content_posts создана');
    
    // Создаём таблицу content_topics
    await dbClient.query(`
      CREATE TABLE IF NOT EXISTS content_topics (
        id SERIAL PRIMARY KEY,
        topic VARCHAR(500) NOT NULL,
        focus VARCHAR(255),
        secondary VARCHAR(255),
        lsi VARCHAR(255),
        status VARCHAR(50) NOT NULL DEFAULT 'pending',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        used_at TIMESTAMPTZ
      );
    `);
    console.log('✅ Таблица content_topics создана');
    
    // Создаём таблицу content_materials
    await dbClient.query(`
      CREATE TABLE IF NOT EXISTS content_materials (
        id SERIAL PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        content TEXT NOT NULL,
        source_type VARCHAR(50),
        source_url VARCHAR(500),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    console.log('✅ Таблица content_materials создана');
    
    // Создаём таблицу publish_logs
    await dbClient.query(`
      CREATE TABLE IF NOT EXISTS publish_logs (
        id BIGSERIAL PRIMARY KEY,
        post_id BIGINT REFERENCES content_posts(id),
        channel_id TEXT,
        telegram_message_id TEXT,
        status TEXT NOT NULL,
        error_text TEXT,
        correlation_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    console.log('✅ Таблица publish_logs создана');
    
    await dbClient.end();
    
    console.log('\n' + '='.repeat(60));
    console.log('✅ БАЗА ДАННЫХ ГОТОВА');
    console.log('='.repeat(60));
    console.log(`Chat ID: ${chatId}`);
    console.log(`Database: ${dbName}`);
    console.log('Таблицы:');
    console.log('  - content_job_queue');
    console.log('  - content_jobs');
    console.log('  - content_posts');
    console.log('  - content_topics');
    console.log('  - content_materials');
    console.log('  - publish_logs');
    console.log('='.repeat(60));
    
  } catch (e) {
    console.error('\n❌ Ошибка:', e.message);
    console.error(e.stack);
    process.exit(1);
  }
}

createDatabase();
