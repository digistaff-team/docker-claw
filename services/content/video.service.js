/**
 * TASK-015: Асинхронный video provider
 * 
 * Поддерживает:
 * - Polling асинхронной генерации видео
 * - Настраиваемый timeout с fallback на image
 * - Хранение состояния в БД
 */

const fetch = require('node-fetch');
const { generateCorrelationId } = require('./status');
const repository = require('./repository');

// Конфигурация
const VIDEO_TIMEOUT_SEC = parseInt(process.env.VIDEO_TIMEOUT_SEC || '300', 10); // 5 минут
const VIDEO_POLL_INTERVAL_SEC = parseInt(process.env.VIDEO_POLL_INTERVAL_SEC || '10', 10);
const VIDEO_FALLBACK_ENABLED = process.env.VIDEO_FALLBACK_ENABLED !== 'false';
const VIDEO_PROVIDER = process.env.VIDEO_PROVIDER || 'runway';

/**
 * Статусы генерации видео
 */
const VIDEO_STATUS = Object.freeze({
  PENDING: 'pending',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  FAILED: 'failed',
  TIMEOUT: 'timeout',
  CANCELLED: 'cancelled'
});

/**
 * Базовый интерфейс video-провайдера
 */
class VideoProvider {
  /**
   * Запустить генерацию видео
   * @param {object} options
   * @param {string} options.prompt - промпт для генерации
   * @param {object} [options.params] - дополнительные параметры
   * @returns {Promise<{generationId: string, status: string}>}
   */
  async generate(options) {
    throw new Error('Not implemented');
  }

  /**
   * Получить статус генерации
   * @param {string} generationId
   * @returns {Promise<{status: string, progress?: number, videoUrl?: string, error?: string}>}
   */
  async getStatus(generationId) {
    throw new Error('Not implemented');
  }

  /**
   * Отменить генерацию
   * @param {string} generationId
   * @returns {Promise<boolean>}
   */
  async cancel(generationId) {
    throw new Error('Not implemented');
  }

  /**
   * Получить имя провайдера
   * @returns {string}
   */
  getName() {
    return 'base';
  }
}

/**
 * RunwayML провайдер
 * Docs: https://docs.runwayml.com/
 */
class RunwayProvider extends VideoProvider {
  constructor() {
    super();
    this.apiKey = process.env.RUNWAY_API_KEY;
    this.baseUrl = 'https://api.runwayml.com/v1';
  }

  getName() {
    return 'runway';
  }

  async generate(options) {
    if (!this.apiKey) {
      throw new Error('RUNWAY_API_KEY is not set');
    }

    const resp = await fetch(`${this.baseUrl}/generations`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gen3a_turbo',
        prompt: options.prompt,
        duration: options.params?.duration || 5,
        ratio: options.params?.ratio || '16:9',
        seed: options.params?.seed
      }),
      timeout: 30000
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Runway API failed: ${resp.status} ${err.slice(0, 300)}`);
    }

    const data = await resp.json();
    return {
      generationId: data.id,
      status: VIDEO_STATUS.PENDING
    };
  }

  async getStatus(generationId) {
    if (!this.apiKey) {
      throw new Error('RUNWAY_API_KEY is not set');
    }

    const resp = await fetch(`${this.baseUrl}/generations/${generationId}`, {
      headers: {
        'Authorization': `Bearer ${this.apiKey}`
      },
      timeout: 15000
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Runway status check failed: ${resp.status} ${err.slice(0, 200)}`);
    }

    const data = await resp.json();
    
    // Маппинг статусов Runway -> наши статусы
    const statusMap = {
      'pending': VIDEO_STATUS.PENDING,
      'queued': VIDEO_STATUS.PENDING,
      'running': VIDEO_STATUS.PROCESSING,
      'processing': VIDEO_STATUS.PROCESSING,
      'succeeded': VIDEO_STATUS.COMPLETED,
      'completed': VIDEO_STATUS.COMPLETED,
      'failed': VIDEO_STATUS.FAILED,
      'cancelled': VIDEO_STATUS.CANCELLED
    };

    const status = statusMap[data.status] || data.status;
    
    return {
      status,
      progress: data.progress || 0,
      videoUrl: data.output?.[0] || data.videoUrl || null,
      error: data.error || null
    };
  }

  async cancel(generationId) {
    if (!this.apiKey) return false;

    try {
      const resp = await fetch(`${this.baseUrl}/generations/${generationId}/cancel`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`
        },
        timeout: 10000
      });
      return resp.ok;
    } catch {
      return false;
    }
  }
}

/**
 * Pika Labs провайдер (заглушка для будущего расширения)
 */
class PikaProvider extends VideoProvider {
  constructor() {
    super();
    this.apiKey = process.env.PIKA_API_KEY;
    this.baseUrl = 'https://api.pika.art/v1';
  }

  getName() {
    return 'pika';
  }

  async generate(options) {
    if (!this.apiKey) {
      throw new Error('PIKA_API_KEY is not set');
    }
    // TODO: Реализовать при получении доступа к API
    throw new Error('Pika provider not implemented yet');
  }

  async getStatus(generationId) {
    throw new Error('Pika provider not implemented yet');
  }

  async cancel(generationId) {
    return false;
  }
}

/**
 * Mock провайдер для тестирования
 */
class MockVideoProvider extends VideoProvider {
  getName() {
    return 'mock';
  }

  async generate(options) {
    return {
      generationId: `mock_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      status: VIDEO_STATUS.PENDING
    };
  }

  async getStatus(generationId) {
    // Имитируем прогресс
    const parts = generationId.split('_');
    const elapsed = Date.now() - parseInt(parts[1] || '0');
    
    if (elapsed < 5000) {
      return { status: VIDEO_STATUS.PENDING, progress: 10 };
    } else if (elapsed < 15000) {
      return { status: VIDEO_STATUS.PROCESSING, progress: 50 };
    } else {
      return {
        status: VIDEO_STATUS.COMPLETED,
        progress: 100,
        videoUrl: 'https://example.com/mock-video.mp4'
      };
    }
  }

  async cancel(generationId) {
    return true;
  }
}

/**
 * Фабрика провайдеров
 */
function getProvider(providerName = VIDEO_PROVIDER) {
  switch (providerName.toLowerCase()) {
    case 'runway':
      return new RunwayProvider();
    case 'pika':
      return new PikaProvider();
    case 'mock':
      return new MockVideoProvider();
    default:
      console.warn(`[VIDEO] Unknown provider "${providerName}", using mock`);
      return new MockVideoProvider();
  }
}

/**
 * Результат генерации видео
 * @typedef {Object} VideoGenerationResult
 * @property {boolean} success
 * @property {string} [videoUrl] - URL готового видео
 * @property {Buffer} [videoBuffer] - бинарные данные видео
 * @property {string} [error] - ошибка
 * @property {boolean} [fallbackUsed] - был ли использован fallback на image
 * @property {string} [generationId] - ID генерации
 */

/**
 * Запустить асинхронную генерацию видео
 * @param {string} chatId
 * @param {object} options
 * @param {string} options.prompt - промпт для генерации
 * @param {string} [options.correlationId]
 * @param {object} [options.params] - параметры провайдера
 * @param {string} [options.provider] - имя провайдера (override)
 * @returns {Promise<{generationId: string, status: string}>}
 */
async function startVideoGeneration(chatId, options) {
  const provider = getProvider(options.provider);
  const correlationId = options.correlationId || generateCorrelationId();

  console.log(`[VIDEO] Starting generation for chat ${chatId}, provider: ${provider.getName()}, corr: ${correlationId}`);

  const result = await provider.generate({
    prompt: options.prompt,
    params: options.params
  });

  // Сохраняем состояние генерации
  await repository.withClient(chatId, async (client) => {
    await client.query(
      `INSERT INTO video_generations 
        (generation_id, chat_id, provider, prompt, status, correlation_id, params)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (generation_id) DO UPDATE SET
         status = EXCLUDED.status,
         updated_at = NOW()`,
      [
        result.generationId,
        chatId,
        provider.getName(),
        options.prompt,
        result.status,
        correlationId,
        JSON.stringify(options.params || {})
      ]
    );
  });

  return result;
}

/**
 * Проверить статус генерации видео
 * @param {string} chatId
 * @param {string} generationId
 * @returns {Promise<{status: string, progress?: number, videoUrl?: string, error?: string}>}
 */
async function checkVideoStatus(chatId, generationId) {
  // Сначала проверяем в БД
  const dbStatus = await repository.withClient(chatId, async (client) => {
    const result = await client.query(
      `SELECT provider, status, video_url, error_text FROM video_generations WHERE generation_id = $1`,
      [generationId]
    );
    return result.rows[0] || null;
  });

  if (!dbStatus) {
    throw new Error(`Generation ${generationId} not found`);
  }

  // Если уже терминальный статус — возвращаем из БД
  if ([VIDEO_STATUS.COMPLETED, VIDEO_STATUS.FAILED, VIDEO_STATUS.TIMEOUT, VIDEO_STATUS.CANCELLED].includes(dbStatus.status)) {
    return {
      status: dbStatus.status,
      videoUrl: dbStatus.video_url,
      error: dbStatus.error_text
    };
  }

  // Опрашиваем провайдера
  const provider = getProvider(dbStatus.provider);
  const status = await provider.getStatus(generationId);

  // Обновляем статус в БД
  await repository.withClient(chatId, async (client) => {
    const updateFields = ['status = $1', 'updated_at = NOW()'];
    const updateValues = [status.status];
    let paramIndex = 2;

    if (status.videoUrl) {
      updateFields.push(`video_url = $${paramIndex++}`);
      updateValues.push(status.videoUrl);
    }
    if (status.error) {
      updateFields.push(`error_text = $${paramIndex++}`);
      updateValues.push(status.error);
    }
    if (status.progress !== undefined) {
      updateFields.push(`progress = $${paramIndex++}`);
      updateValues.push(status.progress);
    }

    updateValues.push(generationId);
    await client.query(
      `UPDATE video_generations SET ${updateFields.join(', ')} WHERE generation_id = $${paramIndex}`,
      updateValues
    );
  });

  return status;
}

/**
 * Скачать готовое видео
 * @param {string} videoUrl
 * @returns {Promise<Buffer>}
 */
async function downloadVideo(videoUrl) {
  const resp = await fetch(videoUrl, { timeout: 60000 });
  if (!resp.ok) {
    throw new Error(`Video download failed: ${resp.status}`);
  }
  return await resp.buffer();
}

/**
 * Отменить генерацию видео
 * @param {string} chatId
 * @param {string} generationId
 * @returns {Promise<boolean>}
 */
async function cancelVideoGeneration(chatId, generationId) {
  const dbStatus = await repository.withClient(chatId, async (client) => {
    const result = await client.query(
      `SELECT provider, status FROM video_generations WHERE generation_id = $1`,
      [generationId]
    );
    return result.rows[0] || null;
  });

  if (!dbStatus) return false;

  // Если уже терминальный статус — не отменяем
  if ([VIDEO_STATUS.COMPLETED, VIDEO_STATUS.FAILED, VIDEO_STATUS.TIMEOUT, VIDEO_STATUS.CANCELLED].includes(dbStatus.status)) {
    return false;
  }

  const provider = getProvider(dbStatus.provider);
  const cancelled = await provider.cancel(generationId);

  if (cancelled) {
    await repository.withClient(chatId, async (client) => {
      await client.query(
        `UPDATE video_generations SET status = $1, updated_at = NOW() WHERE generation_id = $2`,
        [VIDEO_STATUS.CANCELLED, generationId]
      );
    });
  }

  return cancelled;
}

/**
 * Получить активные генерации для чата
 * @param {string} chatId
 * @returns {Promise<Array>}
 */
async function getActiveGenerations(chatId) {
  return repository.withClient(chatId, async (client) => {
    const result = await client.query(
      `SELECT * FROM video_generations 
       WHERE chat_id = $1 AND status IN ($2, $3)
       ORDER BY created_at DESC`,
      [chatId, VIDEO_STATUS.PENDING, VIDEO_STATUS.PROCESSING]
    );
    return result.rows;
  });
}

/**
 * Отметить генерацию как timeout
 * @param {string} chatId
 * @param {string} generationId
 */
async function markGenerationTimeout(chatId, generationId) {
  await repository.withClient(chatId, async (client) => {
    await client.query(
      `UPDATE video_generations SET status = $1, error_text = $2, updated_at = NOW() WHERE generation_id = $3`,
      [VIDEO_STATUS.TIMEOUT, 'Generation timed out', generationId]
    );
  });
}

/**
 * Создать таблицы для видео-генераций
 * @param {string} chatId
 */
async function ensureVideoSchema(chatId) {
  await repository.withClient(chatId, async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS video_generations (
        id BIGSERIAL PRIMARY KEY,
        generation_id TEXT UNIQUE NOT NULL,
        chat_id TEXT NOT NULL,
        job_id BIGINT,
        provider TEXT NOT NULL,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        progress INT DEFAULT 0,
        video_url TEXT,
        video_path TEXT,
        error_text TEXT,
        correlation_id TEXT,
        params JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_video_generations_chat_status 
      ON video_generations(chat_id, status);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_video_generations_job 
      ON video_generations(job_id);
    `);
  });
}

/**
 * Связать генерацию с job
 * @param {string} chatId
 * @param {string} generationId
 * @param {number} jobId
 */
async function linkGenerationToJob(chatId, generationId, jobId) {
  await repository.withClient(chatId, async (client) => {
    await client.query(
      `UPDATE video_generations SET job_id = $1 WHERE generation_id = $2`,
      [jobId, generationId]
    );
  });
}

/**
 * Получить генерацию по jobId
 * @param {string} chatId
 * @param {number} jobId
 * @returns {Promise<object|null>}
 */
async function getGenerationByJobId(chatId, jobId) {
  return repository.withClient(chatId, async (client) => {
    const result = await client.query(
      `SELECT * FROM video_generations WHERE job_id = $1 LIMIT 1`,
      [jobId]
    );
    return result.rows[0] || null;
  });
}

module.exports = {
  VIDEO_STATUS,
  VIDEO_TIMEOUT_SEC,
  VIDEO_POLL_INTERVAL_SEC,
  VIDEO_FALLBACK_ENABLED,
  VideoProvider,
  RunwayProvider,
  PikaProvider,
  MockVideoProvider,
  getProvider,
  startVideoGeneration,
  checkVideoStatus,
  downloadVideo,
  cancelVideoGeneration,
  getActiveGenerations,
  markGenerationTimeout,
  ensureVideoSchema,
  linkGenerationToJob,
  getGenerationByJobId
};
