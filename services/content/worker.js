/**
 * TASK-006, TASK-007: Worker для обработки задач из БД-очереди
 * TASK-015: Polling для асинхронных video-генераций
 */
const queueRepo = require('./queue.repository');
const { generateCorrelationId, JOB_STATUS, QUEUE_STATUS } = require('./status');
const videoService = require('./video.service');

const POLL_INTERVAL_MS = 5000; // 5 секунд
const STUCK_TIMEOUT_MINUTES = 10;
const MAX_CONCURRENT_JOBS = 1; // Максимум параллельных задач на chat
const VIDEO_POLL_INTERVAL_MS = parseInt(process.env.VIDEO_POLL_INTERVAL_MS || '10000', 10); // TASK-015

let workerHandle = null;
let videoPollingHandle = null; // TASK-015
let botsGetter = null;
let jobHandlers = new Map();
let videoCallback = null; // TASK-015: callback при завершении генерации видео

/**
 * Регистрация обработчика для типа задачи
 * @param {string} jobType - тип задачи (generate, approve, publish)
 * @param {Function} handler - async (chatId, job, bot) => { success: boolean, error?: string }
 */
function registerJobHandler(jobType, handler) {
  jobHandlers.set(jobType, handler);
}

/**
 * TASK-015: Регистрация callback'а для завершения генерации видео
 * @param {Function} callback - async (chatId, job, bot, videoResult) => {}
 */
function registerVideoCallback(callback) {
  videoCallback = callback;
}

/**
 * Запуск worker'а
 * @param {Function} getBots - функция, возвращающая Map(chatId -> { bot })
 */
function startWorker(getBots) {
  if (workerHandle) return;
  botsGetter = getBots;
  
  workerHandle = setInterval(async () => {
    try {
      await processAllQueues();
    } catch (e) {
      console.error('[CONTENT-WORKER] Error:', e.message);
    }
  }, POLL_INTERVAL_MS);
  
  // TASK-015: Запуск polling'а для видео
  videoPollingHandle = setInterval(async () => {
    try {
      await pollVideoGenerations();
    } catch (e) {
      console.error('[CONTENT-WORKER-VIDEO] Error:', e.message);
    }
  }, VIDEO_POLL_INTERVAL_MS);
  
  console.log('[CONTENT-WORKER] Started (queue + video polling)');
}

/**
 * Остановить worker
 */
function stopWorker() {
  if (workerHandle) {
    clearInterval(workerHandle);
    workerHandle = null;
  }
  if (videoPollingHandle) {
    clearInterval(videoPollingHandle);
    videoPollingHandle = null;
  }
  console.log('[CONTENT-WORKER] Stopped');
}

/**
 * Обработка очередей всех активных чатов
 */
async function processAllQueues() {
  if (!botsGetter) return;
  
  const bots = botsGetter();
  if (!bots || bots.size === 0) return;
  
  // Сбрасываем застрявшие задачи
  for (const [chatId] of bots) {
    try {
      const resetCount = await queueRepo.resetStuckJobs(chatId, STUCK_TIMEOUT_MINUTES);
      if (resetCount > 0) {
        console.log(`[CONTENT-WORKER] Reset ${resetCount} stuck jobs for chat ${chatId}`);
      }
    } catch (e) {
      console.error(`[CONTENT-WORKER] Failed to reset stuck jobs for ${chatId}:`, e.message);
    }
  }
  
  // Обрабатываем задачи
  for (const [chatId, entry] of bots) {
    try {
      await processQueueForChat(chatId, entry.bot);
    } catch (e) {
      console.error(`[CONTENT-WORKER] Error processing queue for ${chatId}:`, e.message);
    }
  }
}

/**
 * Обработка очереди конкретного чата
 */
async function processQueueForChat(chatId, bot) {
  // Проверяем, есть ли уже задача в обработке
  const stats = await queueRepo.getQueueStats(chatId);
  if (stats.processing >= MAX_CONCURRENT_JOBS) {
    return; // Уже обрабатываем
  }
  
  // Забираем следующую задачу
  const jobs = await queueRepo.pollNextJobs(chatId, MAX_CONCURRENT_JOBS);
  if (!jobs || jobs.length === 0) return;
  
  for (const job of jobs) {
    await processJob(chatId, job, bot);
  }
}

/**
 * Обработка одной задачи
 */
async function processJob(chatId, job, bot) {
  const { id, job_type, payload, correlation_id } = job;
  const corrId = correlation_id || generateCorrelationId();
  
  console.log(`[CONTENT-WORKER] Processing job ${id} type=${job_type} corr=${corrId}`);
  
  const handler = jobHandlers.get(job_type);
  if (!handler) {
    console.error(`[CONTENT-WORKER] No handler for job type: ${job_type}`);
    await queueRepo.markFailed(chatId, id, `Unknown job type: ${job_type}`, false);
    return;
  }
  
  try {
    const result = await handler(chatId, job, bot, corrId);
    
    if (result.success) {
      await queueRepo.markDone(chatId, id);
      console.log(`[CONTENT-WORKER] Job ${id} completed successfully`);
    } else {
      const errorMsg = result.error || 'Handler returned failure';
      console.error(`[CONTENT-WORKER] Job ${id} failed: ${errorMsg}`);
      await queueRepo.markFailed(chatId, id, errorMsg, result.retry !== false);
    }
  } catch (e) {
    console.error(`[CONTENT-WORKER] Job ${id} threw error:`, e.message);
    await queueRepo.markFailed(chatId, id, e.message, true);
  }
}

/**
 * Поставить задачу в очередь (wrapper для удобства)
 */
async function enqueueJob(chatId, options) {
  await queueRepo.ensureQueueSchema(chatId);
  return queueRepo.enqueue(chatId, {
    ...options,
    correlationId: options.correlationId || generateCorrelationId()
  });
}

// ============================================
// TASK-015: Video polling
// ============================================

/**
 * Polling активных генераций видео
 */
async function pollVideoGenerations() {
  if (!botsGetter) return;
  
  const bots = botsGetter();
  if (!bots || bots.size === 0) return;
  
  for (const [chatId, entry] of bots) {
    try {
      await pollVideoForChat(chatId, entry.bot);
    } catch (e) {
      console.error(`[CONTENT-WORKER-VIDEO] Error polling for ${chatId}:`, e.message);
    }
  }
}

/**
 * Polling генераций для конкретного чата
 */
async function pollVideoForChat(chatId, bot) {
  const repository = require('./repository');
  
  // Получаем jobs в статусе MEDIA_GENERATING
  const pendingJobs = await repository.getPendingMediaJobs(chatId, 5);
  
  for (const job of pendingJobs) {
    // Проверяем, что это видео-генерация
    if (job.content_type !== 'text+video') continue;
    
    // Получаем связанную генерацию
    const generation = await videoService.getGenerationByJobId(chatId, job.id);
    if (!generation) {
      console.warn(`[CONTENT-WORKER-VIDEO] No generation found for job ${job.id}`);
      continue;
    }
    
    // Проверяем таймаут
    const elapsed = Date.now() - new Date(generation.created_at).getTime();
    if (elapsed > videoService.VIDEO_TIMEOUT_SEC * 1000) {
      console.log(`[CONTENT-WORKER-VIDEO] Generation ${generation.generation_id} timed out`);
      await videoService.markGenerationTimeout(chatId, generation.generation_id);
      
      // Вызываем callback с результатом timeout
      if (videoCallback) {
        await videoCallback(chatId, job, bot, {
          success: false,
          timedOut: true,
          error: 'Video generation timed out'
        });
      }
      continue;
    }
    
    // Проверяем статус
    try {
      const status = await videoService.checkVideoStatus(chatId, generation.generation_id);
      
      if (status.status === videoService.VIDEO_STATUS.COMPLETED && status.videoUrl) {
        console.log(`[CONTENT-WORKER-VIDEO] Generation ${generation.generation_id} completed`);
        
        // Скачиваем видео
        const videoBuffer = await videoService.downloadVideo(status.videoUrl);
        
        // Вызываем callback с результатом
        if (videoCallback) {
          await videoCallback(chatId, job, bot, {
            success: true,
            videoUrl: status.videoUrl,
            videoBuffer,
            generationId: generation.generation_id
          });
        }
      } else if (status.status === videoService.VIDEO_STATUS.FAILED) {
        console.error(`[CONTENT-WORKER-VIDEO] Generation ${generation.generation_id} failed:`, status.error);
        
        // Вызываем callback с ошибкой
        if (videoCallback) {
          await videoCallback(chatId, job, bot, {
            success: false,
            error: status.error || 'Video generation failed'
          });
        }
      }
      // Для PENDING/PROCESSING — просто ждём следующий polling
    } catch (e) {
      console.error(`[CONTENT-WORKER-VIDEO] Error checking status for ${generation.generation_id}:`, e.message);
    }
  }
}

module.exports = {
  startWorker,
  stopWorker,
  registerJobHandler,
  registerVideoCallback,
  enqueueJob,
  processAllQueues,
  pollVideoGenerations,
  POLL_INTERVAL_MS,
  MAX_CONCURRENT_JOBS
};
