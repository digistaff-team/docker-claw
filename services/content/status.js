/**
 * TASK-001: Единый словарь статусов и карта переходов
 */

const JOB_STATUS = Object.freeze({
  DRAFT: 'draft',
  MEDIA_GENERATING: 'media_generating',
  READY: 'ready',
  APPROVED: 'approved',
  PUBLISHED: 'published',
  FAILED: 'failed'
});

const POST_STATUS = Object.freeze({
  DRAFT: 'draft',
  READY: 'ready',
  APPROVED: 'approved',
  PUBLISHED: 'published',
  FAILED: 'failed'
});

const QUEUE_STATUS = Object.freeze({
  QUEUED: 'queued',
  PROCESSING: 'processing',
  DONE: 'done',
  FAILED: 'failed'
});

const PUBLISH_LOG_STATUS = Object.freeze({
  PUBLISHED: 'published',
  FAILED: 'failed',
  SKIPPED_DUPLICATE_PUBLISH: 'skipped_duplicate_publish'
});

/**
 * Карта допустимых переходов статусов job
 * Ключ: текущий статус -> Set допустных следующих статусов
 */
const JOB_STATUS_TRANSITIONS = Object.freeze({
  [JOB_STATUS.DRAFT]: new Set([
    JOB_STATUS.MEDIA_GENERATING,
    JOB_STATUS.READY,
    JOB_STATUS.FAILED
  ]),
  [JOB_STATUS.MEDIA_GENERATING]: new Set([
    JOB_STATUS.READY,
    JOB_STATUS.FAILED
  ]),
  [JOB_STATUS.READY]: new Set([
    JOB_STATUS.APPROVED,
    JOB_STATUS.FAILED
  ]),
  [JOB_STATUS.APPROVED]: new Set([
    JOB_STATUS.PUBLISHED,
    JOB_STATUS.FAILED
  ]),
  [JOB_STATUS.PUBLISHED]: new Set([]), // Terminal state
  [JOB_STATUS.FAILED]: new Set([
    JOB_STATUS.MEDIA_GENERATING,
    JOB_STATUS.READY
  ])
});

/**
 * Валидация перехода статуса job
 * @param {string} from - текущий статус
 * @param {string} to - новый статус
 * @returns {{ valid: boolean, reason?: string }}
 */
function validateJobStatusTransition(from, to) {
  const fromNorm = String(from || '').toLowerCase();
  const toNorm = String(to || '').toLowerCase();

  if (!Object.values(JOB_STATUS).includes(fromNorm)) {
    return { valid: false, reason: `Invalid source status: ${from}` };
  }
  if (!Object.values(JOB_STATUS).includes(toNorm)) {
    return { valid: false, reason: `Invalid target status: ${to}` };
  }

  const allowed = JOB_STATUS_TRANSITIONS[fromNorm];
  if (!allowed || !allowed.has(toNorm)) {
    return {
      valid: false,
      reason: `Invalid transition: ${from} -> ${to}. Allowed: ${Array.from(allowed || []).join(', ') || 'none'}`
    };
  }

  return { valid: true };
}

/**
 * Проверка терминального статуса
 */
function isTerminalStatus(status) {
  return status === JOB_STATUS.PUBLISHED;
}

/**
 * Генерация correlation ID для трассировки (TASK-004)
 */
function generateCorrelationId() {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `corr_${timestamp}_${random}`;
}

module.exports = {
  JOB_STATUS,
  POST_STATUS,
  QUEUE_STATUS,
  PUBLISH_LOG_STATUS,
  JOB_STATUS_TRANSITIONS,
  validateJobStatusTransition,
  isTerminalStatus,
  generateCorrelationId
};
