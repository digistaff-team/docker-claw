/**
 * TASK-011: Препаблиш-проверки контента
 */

const MAX_POST_LENGTH = 1024; // Telegram limit for caption
const MIN_POST_LENGTH = 50;
const MAX_HASHTAGS = 10;

// Запрещённые темы (ключевые слова)
const FORBIDDEN_TOPICS = [
  // Война и политика
  'война', 'военн', 'армия', 'солдат', 'оружие', 'путин', 'зеленск', 'спецопераци',
  'политик', 'выборы', 'партия', 'депутат', 'госдум', 'санкци',
  // Религия
  'религиоз', 'православ', 'ислам', 'христиан', 'церковь', 'мечеть', 'бог', 'аллах',
  // Секс
  'секс', 'порн', 'эрот', 'интим', '18+', 'xxx',
  // Преступность
  'преступлен', 'убийств', 'насилие', 'наркотик', 'террор', 'экстремиз'
];

/**
 * Результат валидации
 * @typedef {Object} ValidationResult
 * @property {boolean} valid
 * @property {string[]} errors
 * @property {string[]} warnings
 */

/**
 * Проверка длины поста
 * @param {string} text
 * @returns {ValidationResult}
 */
function validatePostLength(text) {
  const errors = [];
  const warnings = [];
  const length = (text || '').length;

  if (length === 0) {
    errors.push('Текст поста пуст');
  } else if (length < MIN_POST_LENGTH) {
    warnings.push(`Текст поста слишком короткий (${length} символов, минимум ${MIN_POST_LENGTH})`);
  } else if (length > MAX_POST_LENGTH) {
    errors.push(`Текст поста слишком длинный (${length} символов, максимум ${MAX_POST_LENGTH})`);
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Проверка хэштегов
 * @param {string} text
 * @returns {ValidationResult}
 */
function validateHashtags(text) {
  const errors = [];
  const warnings = [];
  const hashtags = (text || '').match(/[\p{L}\p{N}_]+/gu) || [];

  if (hashtags.length === 0) {
    warnings.push('В посте нет хэштегов');
  } else if (hashtags.length > MAX_HASHTAGS) {
    warnings.push(`Слишком много хэштегов (${hashtags.length}, максимум ${MAX_HASHTAGS})`);
  }

  // Проверка на кириллические хэштеги (должны быть читаемыми)
  for (const tag of hashtags) {
    const content = tag.slice(1);
    if (/[\u0400-\u04FF]/.test(content)) {
      // Кириллический хэштег — проверяем на подчёркивания
      if (content.includes('__')) {
        warnings.push(`Хэштег ${tag} содержит двойные подчёркивания`);
      }
    }
  }

  return { valid: true, errors, warnings };
}

/**
 * Проверка на запрещённые темы
 * @param {string} text
 * @returns {ValidationResult}
 */
function validateForbiddenTopics(text) {
  const errors = [];
  const warnings = [];
  const lowerText = (text || '').toLowerCase();

  const found = [];
  for (const keyword of FORBIDDEN_TOPICS) {
    if (lowerText.includes(keyword)) {
      found.push(keyword);
    }
  }

  if (found.length > 0) {
    errors.push(`Обнаружены запрещённые темы: ${found.join(', ')}`);
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Проверка эмодзи
 * @param {string} text
 * @returns {ValidationResult}
 */
function validateEmojiBalance(text) {
  const errors = [];
  const warnings = [];
  
  // Подсчёт эмодзи
  const emojiMatches = (text || '').match(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu) || [];
  const textLength = (text || '').replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, '').length;
  
  if (emojiMatches.length > 0 && textLength > 0) {
    const ratio = emojiMatches.length / textLength;
    if (ratio > 0.1) {
      warnings.push(`Слишком много эмодзи (${emojiMatches.length} на ${textLength} символов текста)`);
    }
  }

  return { valid: true, errors, warnings };
}

/**
 * Проверка медиа-файла
 * @param {object} imageInfo
 * @param {number} [imageInfo.size] - размер в байтах
 * @param {string} [imageInfo.path] - путь к файлу
 * @returns {ValidationResult}
 */
function validateMedia(imageInfo) {
  const errors = [];
  const warnings = [];

  if (!imageInfo) {
    errors.push('Медиа-файл отсутствует');
    return { valid: false, errors, warnings };
  }

  if (!imageInfo.path) {
    errors.push('Путь к медиа-файлу не указан');
  }

  if (imageInfo.size !== undefined) {
    const maxSize = 10 * 1024 * 1024; // 10 MB
    if (imageInfo.size === 0) {
      errors.push('Медиа-файл пуст');
    } else if (imageInfo.size > maxSize) {
      errors.push(`Медиа-файл слишком большой (${Math.round(imageInfo.size / 1024 / 1024)} MB, максимум 10 MB)`);
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

// ============================================
// TASK-015: Video validation
// ============================================

// TASK-016: Лимиты для разных типов контента
const MAX_VIDEO_SIZE = 50 * 1024 * 1024; // 50 MB (Telegram bot API limit)
const MAX_VIDEO_SIZE_PREMIUM = 2 * 1024 * 1024 * 1024; // 2 GB (Telegram Premium)
const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10 MB (Telegram bot API limit)
const MAX_VIDEO_DURATION_SEC = 60; // 60 секунд (рекомендация)
const MAX_CAPTION_LENGTH = 1024; // Для фото/видео
const MAX_TEXT_LENGTH = 4096; // Для text-only сообщений
const MAX_MEDIA_GROUP_SIZE = 10; // Максимум элементов в media group
const SUPPORTED_VIDEO_FORMATS = ['mp4', 'mov', 'webm', 'gif'];
const SUPPORTED_IMAGE_FORMATS = ['jpg', 'jpeg', 'png', 'gif', 'webp'];

/**
 * Проверка видео-файла
 * @param {object} videoInfo
 * @param {number} [videoInfo.size] - размер в байтах
 * @param {string} [videoInfo.path] - путь к файлу
 * @param {string} [videoInfo.format] - формат файла
 * @param {number} [videoInfo.duration] - длительность в секундах
 * @returns {ValidationResult}
 */
function validateVideo(videoInfo) {
  const errors = [];
  const warnings = [];

  if (!videoInfo) {
    errors.push('Видео-файл отсутствует');
    return { valid: false, errors, warnings };
  }

  if (!videoInfo.path) {
    errors.push('Путь к видео-файлу не указан');
  }

  // Проверка размера
  if (videoInfo.size !== undefined) {
    if (videoInfo.size === 0) {
      errors.push('Видео-файл пуст');
    } else if (videoInfo.size > MAX_VIDEO_SIZE) {
      errors.push(`Видео-файл слишком большой (${Math.round(videoInfo.size / 1024 / 1024)} MB, максимум ${MAX_VIDEO_SIZE / 1024 / 1024} MB)`);
    }
  }

  // Проверка формата
  if (videoInfo.format || videoInfo.path) {
    const ext = videoInfo.format || videoInfo.path.split('.').pop()?.toLowerCase();
    if (ext && !SUPPORTED_VIDEO_FORMATS.includes(ext)) {
      warnings.push(`Формат видео "${ext}" может не поддерживаться Telegram. Рекомендуется: ${SUPPORTED_VIDEO_FORMATS.join(', ')}`);
    }
  }

  // Проверка длительности
  if (videoInfo.duration !== undefined) {
    if (videoInfo.duration > MAX_VIDEO_DURATION_SEC) {
      warnings.push(`Длительность видео (${videoInfo.duration} сек) превышает рекомендуемую (${MAX_VIDEO_DURATION_SEC} сек)`);
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Комплексная валидация поста перед публикацией
 * @param {object} draft
 * @param {string} draft.text - текст поста
 * @param {string} [draft.imagePath] - путь к изображению
 * @param {string} [draft.videoPath] - путь к видео (TASK-015)
 * @param {object} [draft.imageInfo] - информация об изображении
 * @param {object} [draft.videoInfo] - информация о видео (TASK-015)
 * @param {string} [draft.contentType] - тип контента ('text+image' | 'text+video')
 * @returns {ValidationResult}
 */
function validatePostForPublish(draft) {
  const allErrors = [];
  const allWarnings = [];
  const contentType = draft?.contentType || 'text+image';

  // Проверка текста
  const lengthResult = validatePostLength(draft?.text);
  allErrors.push(...lengthResult.errors);
  allWarnings.push(...lengthResult.warnings);

  const hashtagsResult = validateHashtags(draft?.text);
  allErrors.push(...hashtagsResult.errors);
  allWarnings.push(...hashtagsResult.warnings);

  const topicsResult = validateForbiddenTopics(draft?.text);
  allErrors.push(...topicsResult.errors);
  allWarnings.push(...topicsResult.warnings);

  const emojiResult = validateEmojiBalance(draft?.text);
  allErrors.push(...emojiResult.errors);
  allWarnings.push(...emojiResult.warnings);

  // Проверка медиа в зависимости от типа контента
  if (contentType === 'text+video') {
    // Для видео — проверяем видео, изображение опционально (fallback)
    const videoResult = validateVideo({ path: draft?.videoPath, ...draft?.videoInfo });
    allErrors.push(...videoResult.errors);
    allWarnings.push(...videoResult.warnings);
    
    // Если видео нет, проверяем есть ли fallback изображение
    if (!draft?.videoPath && !draft?.imagePath) {
      allErrors.push('Видео-файл отсутствует и нет fallback изображения');
    }
  } else {
    // Стандартный text+image
    const mediaPath = draft?.videoPath || draft?.imagePath;
    const mediaResult = validateMedia({ path: mediaPath, ...draft?.imageInfo });
    allErrors.push(...mediaResult.errors);
    allWarnings.push(...mediaResult.warnings);
  }

  return {
    valid: allErrors.length === 0,
    errors: allErrors,
    warnings: allWarnings
  };
}

/**
 * Автокоррекция поста (если возможно)
 * @param {string} text
 * @returns {string} - скорректированный текст
 */
function autoCorrectPost(text) {
  if (!text) return text;

  let corrected = text;

  // Обрезка до максимальной длины с сохранением целостности предложения
  if (corrected.length > MAX_POST_LENGTH) {
    corrected = corrected.slice(0, MAX_POST_LENGTH);
    // Пытаемся найти конец последнего предложения
    const lastDot = corrected.lastIndexOf('.');
    const lastBang = corrected.lastIndexOf('!');
    const lastQuestion = corrected.lastIndexOf('?');
    const lastSentenceEnd = Math.max(lastDot, lastBang, lastQuestion);
    
    if (lastSentenceEnd > MAX_POST_LENGTH * 0.7) {
      corrected = corrected.slice(0, lastSentenceEnd + 1);
    }
  }

  // Убираем множественные пробелы
  corrected = corrected.replace(/\s{2,}/g, ' ');

  // Убираем множественные переносы строк
  corrected = corrected.replace(/\n{3,}/g, '\n\n');

  return corrected.trim();
}

module.exports = {
  validatePostLength,
  validateHashtags,
  validateForbiddenTopics,
  validateEmojiBalance,
  validateMedia,
  validateVideo,
  validatePostForPublish,
  autoCorrectPost,
  // Константы для текста
  MAX_POST_LENGTH,
  MIN_POST_LENGTH,
  MAX_HASHTAGS,
  // TASK-016: Константы для медиа
  MAX_VIDEO_SIZE,
  MAX_VIDEO_SIZE_PREMIUM,
  MAX_IMAGE_SIZE,
  MAX_VIDEO_DURATION_SEC,
  MAX_CAPTION_LENGTH,
  MAX_TEXT_LENGTH,
  MAX_MEDIA_GROUP_SIZE,
  SUPPORTED_VIDEO_FORMATS,
  SUPPORTED_IMAGE_FORMATS,
  FORBIDDEN_TOPICS
};
