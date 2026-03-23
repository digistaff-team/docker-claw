/**
 * Проверка очереди content_queue напрямую через БД
 */
const { Client } = require('pg');

const config = {
  host: process.env.PG_HOST || '172.17.0.1',
  port: process.env.PG_PORT || 5432,
  user: process.env.PG_USER || 'postgres',
  password: process.env.PG_PASSWORD || '6/RVWbQVRumeOBW8oOEUZAY1/R529KaZ4+7zt3Kvm6M=',
  database: 'user_128247430'
};

async function checkQueue() {
  const client = new Client(config);
  
  try {
    await client.connect();
    console.log('Connected to database');
    
    // Check queue
    console.log('\n=== CONTENT QUEUE ===');
    const queueRes = await client.query(`
      SELECT id, job_type, status, priority, payload, correlation_id, created_at, started_at
      FROM content_queue
      ORDER BY created_at DESC
      LIMIT 10
    `);
    
    if (queueRes.rows.length === 0) {
      console.log('Queue is empty');
    } else {
      queueRes.rows.forEach(r => {
        console.log(`  Queue #${r.id}: ${r.job_type} - ${r.status} (priority: ${r.priority})`);
        console.log(`    Payload: ${JSON.stringify(r.payload)}`);
        console.log(`    Created: ${r.created_at}`);
      });
    }
    
    // Check jobs
    console.log('\n=== CONTENT JOBS ===');
    const jobsRes = await client.query(`
      SELECT id, sheet_row, status, error_text, draft_text, image_path, created_at, updated_at
      FROM content_jobs
      ORDER BY created_at DESC
      LIMIT 10
    `);
    
    if (jobsRes.rows.length === 0) {
      console.log('No jobs found');
    } else {
      jobsRes.rows.forEach(r => {
        const textPreview = r.draft_text ? r.draft_text.substring(0, 50) + '...' : 'N/A';
        console.log(`  Job #${r.id}: ${r.status} - Row #${r.sheet_row}`);
        console.log(`    Error: ${r.error_text || 'none'}`);
        console.log(`    Text: ${textPreview}`);
        console.log(`    Updated: ${r.updated_at}`);
      });
    }
    
    // Check posts
    console.log('\n=== CONTENT POSTS ===');
    const postsRes = await client.query(`
      SELECT id, job_id, body_text, publish_status, created_at
      FROM content_posts
      ORDER BY created_at DESC
      LIMIT 10
    `);
    
    if (postsRes.rows.length === 0) {
      console.log('No posts found');
    } else {
      postsRes.rows.forEach(r => {
        const textPreview = r.body_text ? r.body_text.substring(0, 50) + '...' : 'N/A';
        console.log(`  Post #${r.id} (Job #${r.job_id}): ${r.publish_status}`);
        console.log(`    Text: ${textPreview}`);
      });
    }
    
    // Check publish logs
    console.log('\n=== PUBLISH LOGS ===');
    const logsRes = await client.query(`
      SELECT id, post_id, status, error_text, created_at
      FROM publish_logs
      ORDER BY created_at DESC
      LIMIT 10
    `);
    
    if (logsRes.rows.length === 0) {
      console.log('No publish logs found');
    } else {
      logsRes.rows.forEach(r => {
        console.log(`  Log #${r.id} (Post #${r.post_id}): ${r.status}`);
        console.log(`    Error: ${r.error_text || 'none'}`);
      });
    }
    
    // Check topics
    console.log('\n=== CONTENT TOPICS ===');
    const topicsRes = await client.query(`
      SELECT id, topic, status, used_at
      FROM content_topics
      WHERE status = 'pending'
      ORDER BY id DESC
      LIMIT 5
    `);
    
    if (topicsRes.rows.length === 0) {
      console.log('No pending topics found');
    } else {
      topicsRes.rows.forEach(r => {
        console.log(`  Topic #${r.id}: ${r.topic?.substring(0, 40)}...`);
      });
    }
    
    // Check materials
    console.log('\n=== CONTENT MATERIALS ===');
    const materialsRes = await client.query(`
      SELECT id, title, content_type, created_at
      FROM content_materials
      ORDER BY created_at DESC
      LIMIT 5
    `);
    
    if (materialsRes.rows.length === 0) {
      console.log('No materials found');
    } else {
      materialsRes.rows.forEach(r => {
        console.log(`  Material #${r.id}: ${r.title || 'no title'} (${r.content_type})`);
      });
    }
    
  } catch (e) {
    console.error('Error:', e.message);
    console.error('Code:', e.code);
    console.error('Address:', e.address);
  } finally {
    await client.end();
  }
}

checkQueue();
