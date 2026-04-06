/**
 * Video provider — KIE.ai Veo 3 API
 *
 * Генерация видео через KIE.ai (Veo 3 / Veo 3 Fast).
 * Поддерживает:
 * - Асинхронную генерацию с polling
 * - Настраиваемый timeout с fallback
 * - Хранение состояния в БД
 *
 * API Docs: https://docs.kie.ai/veo3-api/
 */

const fetch = require('node-fetch');
const { generateCorrelationId } = require('./status');
const repository = require('./repository');

// Конфигурация
const KIE_API_URL = 'https://api.kie.ai';
const VIDEO_TIMEOUT_SEC = parseInt(process.env.VIDEO_TIMEOUT_SEC || '600', 10); // 10 минут (Veo медленнее изображений)
const VIDEO_POLL_INTERVAL_SEC = parseInt(process.env.VIDEO_POLL_INTERVAL_SEC || '25', 10);
const VIDEO_FALLBACK_ENABLED = process.env.VIDEO_FALLBACK_ENABLED !== 'false';
const VIDEO_MODEL = process.env.VIDEO_MODEL || 'veo3_fast'; // veo3 | veo3_fast

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
 * KIE.ai Veo 3 провайдер
 */
class KieVideoProvider {
  constructor() {
    this.apiKey = process.env.KIE_API_KEY;
    this.baseUrl = KIE_API_URL;
    this.name = 'kie-veo3';
  }

  getName() {
    return this.name;
  }

  /**
   * Запустить генерацию видео
   * @param {object} options
   * @param {string} options.prompt - промпт для генерации
   * @param {object} [options.params] - дополнительные параметры
   * @returns {Promise<{generationId: string, status: string}>}
   */
  async generate(options) {
    if (!this.apiKey) {
      throw new Error('KIE_API_KEY is not set');
    }

    const params = options.params || {};
    const body = {
      prompt: options.prompt,
      model: params.model || VIDEO_MODEL,
      aspect_ratio: params.aspectRatio || params.ratio || '9:16', // Shorts по умолчанию
      generationType: params.generationType || 'TEXT_2_VIDEO',
      enableTranslation: params.enableTranslation !== undefined ? params.enableTranslation : true
    };

    // Опциональные параметры
    if (params.seed) body.seeds = params.seed;
    if (params.imageUrls && Array.isArray(params.imageUrls)) body.imageUrls = params.imageUrls;
    if (params.watermark) body.watermark = params.watermark;
    if (params.callBackUrl) body.callBackUrl = params.callBackUrl;

    const resp = await fetch(`${this.baseUrl}/api/v1/veo/generate`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
      timeout: 30000
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`KIE Veo API failed: ${resp.status} ${err.slice(0, 300)}`);
    }

    const data = await resp.json();

    if (data.code !== 200) {
      // Специфичные ошибки KIE
      if (data.code === 402) throw new Error('KIE: Insufficient credits');
      if (data.code === 422) throw new Error(`KIE: Validation error — ${data.msg}`);
      if (data.code === 429) throw new Error('KIE: Rate limited');
      throw new Error(`KIE Veo createTask error: ${data.msg} (code ${data.code})`);
    }

    const taskId = data?.data?.taskId;
    if (!taskId) {
      throw new Error('KIE Veo: no taskId in response');
    }

    return {
      generationId: taskId,
      status: VIDEO_STATUS.PENDING
    };
  }

  /**
   * Получить статус генерации (проверяет готовность 1080p версии)
   * @param {string} generationId - taskId
   * @param {number} [index=0] - индекс видео (0-based)
   * @returns {Promise<{status: string, progress?: number, videoUrl?: string, error?: string}>}
   */
  async getStatus(generationId, index = 0) {
    if (!this.apiKey) {
      throw new Error('KIE_API_KEY is not set');
    }

    const resp = await fetch(
      `${this.baseUrl}/api/v1/veo/get-1080p-video?taskId=${encodeURIComponent(generationId)}&index=${index}`,
      {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`
        },
        timeout: 30000
      }
    );

    if (!resp.ok) {
      // 400 = 1080p ещё обрабатывается, 500 = ошибка
      if (resp.status === 400) {
        return {
          status: VIDEO_STATUS.PROCESSING,
          progress: 50,
          videoUrl: null,
          error: null
        };
      }
      const err = await resp.text();
      throw new Error(`KIE Veo 1080p status check failed: ${resp.status} ${err.slice(0, 200)}`);
    }

    const data = await resp.json();

    // code: 200 = 1080p готово
    if (data.code === 200 && data.data?.resultUrl) {
      return {
        status: VIDEO_STATUS.COMPLETED,
        progress: 100,
        videoUrl: data.data.resultUrl,
        error: null
      };
    }

    // code 400 = "1080P is processing, check back shortly"
    if (data.code === 400) {
      return {
        status: VIDEO_STATUS.PROCESSING,
        progress: data.data?.progress || 50,
        videoUrl: null,
        error: null
      };
    }

    // Ошибки
    if (data.code === 500 || data.code === 501) {
      return {
        status: VIDEO_STATUS.FAILED,
        videoUrl: null,
        error: data.msg || '1080p generation failed'
      };
    }

    // Неожиданный код — считаем processing
    return {
      status: VIDEO_STATUS.PROCESSING,
      progress: 0,
      videoUrl: null,
      error: null
    };
  }

  /**
   * Отменить генерацию
   * KIE API не поддерживает отмену задач.
   * @param {string} generationId
   * @returns {Promise<boolean>}
   */
  async cancel(generationId) {
    // KIE не поддерживает отменой — просто помечаем локально
    return false;
  }
}

/**
 * Фабрика провайдеров
 */
function getProvider() {
  return new KieVideoProvider();
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
 * @param {string} [options.provider] - игнорируется (всегда KIE)
 * @returns {Promise<{generationId: string, status: string}>}
 */
async function startVideoGeneration(chatId, options) {
  const provider = getProvider();
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
  const provider = getProvider();
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
  const resp = await fetch(videoUrl, { timeout: 120000 });
  if (!resp.ok) {
    throw new Error(`Video download failed: ${resp.status}`);
  }
  return await resp.buffer();
}

/**
 * Отменить генерацию видео
 * KIE не поддерживает отмену, поэтому просто помечаем как cancelled локально.
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

  // KIE не поддерживает отмену задач на сервере
  // Помечаем локально как cancelled
  await repository.withClient(chatId, async (client) => {
    await client.query(
      `UPDATE video_generations SET status = $1, updated_at = NOW() WHERE generation_id = $2`,
      [VIDEO_STATUS.CANCELLED, generationId]
    );
  });

  return true;
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
  VIDEO_MODEL,
  KieVideoProvider,
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
