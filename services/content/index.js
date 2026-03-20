/**
 * TASK-005: Фасад для контентного сервиса
 * Объединяет все модули и обеспечивает совместимость с runner.js
 */
const repository = require('./repository');
const queueRepo = require('./queue.repository');
const worker = require('./worker');
const validators = require('./validators');
const limits = require('./limits');
const alerts = require('./alerts');
const videoService = require('./video.service'); // TASK-015
const {
  JOB_STATUS,
  POST_STATUS,
  QUEUE_STATUS,
  PUBLISH_LOG_STATUS,
  validateJobStatusTransition,
  isTerminalStatus,
  generateCorrelationId
} = require('./status');

// Экспорт статусов для совместимости
const STATUS = JOB_STATUS;

module.exports = {
  // Статусы
  STATUS,
  JOB_STATUS,
  POST_STATUS,
  QUEUE_STATUS,
  PUBLISH_LOG_STATUS,
  
  // Валидация
  validateJobStatusTransition,
  isTerminalStatus,
  generateCorrelationId,
  
  // Репозиторий данных
  repository,
  
  // Очередь
  queueRepo,
  
  // Worker
  worker,
  
  // Валидаторы (TASK-011)
  validators,
  validatePostForPublish: validators.validatePostForPublish,
  autoCorrectPost: validators.autoCorrectPost,
  
  // Лимиты (TASK-012)
  limits,
  checkQuota: limits.checkQuota,
  getUsageStats: limits.getUsageStats,
  
  // Алерты (TASK-014)
  alerts,
  checkAndAlert: alerts.checkAndAlert,
  
  // Удобные алиасы
  ensureSchema: repository.ensureSchema,
  withClient: repository.withClient,
  createJob: repository.createJob,
  updateJob: repository.updateJob,
  updateJobStatus: repository.updateJobStatus,
  getJobById: repository.getJobById,
  createPost: repository.createPost,
  updatePost: repository.updatePost,
  getPostByJobId: repository.getPostByJobId,
  createAsset: repository.createAsset,
  addPublishLog: repository.addPublishLog,
  isPostPublished: repository.isPostPublished,
  setSheetState: repository.setSheetState,
  getSheetState: repository.getSheetState,
  listJobs: repository.listJobs,
  getJobWithDetails: repository.getJobWithDetails,
  countPublishedToday: repository.countPublishedToday,
  withLockedPost: repository.withLockedPost,
  
  // Очередь
  ensureQueueSchema: queueRepo.ensureQueueSchema,
  enqueue: queueRepo.enqueue,
  pollNextJobs: queueRepo.pollNextJobs,
  markDone: queueRepo.markDone,
  markFailed: queueRepo.markFailed,
  getQueueStats: queueRepo.getQueueStats,
  
  // Worker
  startWorker: worker.startWorker,
  stopWorker: worker.stopWorker,
  registerJobHandler: worker.registerJobHandler,
  registerVideoCallback: worker.registerVideoCallback, // TASK-015
  enqueueJob: worker.enqueueJob,
  
  // Video (TASK-015)
  videoService,
  VIDEO_STATUS: videoService.VIDEO_STATUS,
  VIDEO_TIMEOUT_SEC: videoService.VIDEO_TIMEOUT_SEC,
  VIDEO_FALLBACK_ENABLED: videoService.VIDEO_FALLBACK_ENABLED
};
