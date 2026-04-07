/**
 * Blog Generator Service — генерация статей для WordPress/Дзен
 * Prompt chain: формат → промпт картинки → imageGen → статья → SEO
 */
const config = require('../config');
const aiRouterService = require('./ai_router_service');
const imageGenService = require('./imageGen.service');
const tokenBilling = require('../manage/tokenBilling');
const wpRepo = require('./content/wordpress.repository');
const contentRepo = require('./content/repository');

// Промпты вынесены в manage/prompts.js, импортируем отсюда
const {
  BLOG_PROMPT_FORMAT,
  BLOG_PROMPT_IMAGE,
  BLOG_PROMPT_WRITE,
  BLOG_PROMPT_SEO_TITLE,
  BLOG_PROMPT_SEO_DESC,
  BLOG_PROMPT_SEO_SLUG
} = require('../manage/prompts');

// Оценка токенов для проверки баланса (приблизительно)
const ESTIMATED_TOKENS_PER_ARTICLE = 15000; // ~15k tokens на полную генерацию

class InsufficientBalanceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InsufficientBalanceError';
  }
}

/**
 * Загрузить технический документ из базы знаний
 */
async function loadKnowledge(chatId, techDocId) {
  if (!techDocId) return null;

  return contentRepo.withClient(chatId, async (client) => {
    const result = await client.query(
      'SELECT title, body, tags FROM content_knowledge_base WHERE id = $1',
      [techDocId]
    );
    return result.rows[0] || null;
  });
}

/**
 * Вызвать AI router с проверкой баланса
 */
async function aiChat(chatId, systemPrompt, userPrompt) {
  // Используем aiRouterService напрямую
  // Передаём messages в формате OpenAI
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt }
  ];

  // Создаём временную "сессию" для AI router
  const result = await aiRouterService.processMessage(
    chatId,
    { messages, model: null }, // модель возьмётся из настроек пользователя
    null // bot — не требуется для прямой генерации
  );

  return result.reply || result.text || result;
}

/**
 * Основная функция генерации статьи
 * @param {string} chatId
 * @param {object} params
 * @param {string} params.topic — тема статьи
 * @param {string} params.keywords — ключевые слова (через запятую)
 * @param {number} [params.techDocId] — ID технического документа (опционально)
 * @param {string} [params.moderatorNote] — заметки модератора (для rewrite)
 * @returns {Promise<{bodyHtml: string, seoTitle: string, metaDesc: string, slug: string, imageBuffer: Buffer, imageMime: string, imageFilename: string}>}
 */
async function generate(chatId, { topic, keywords, techDocId, moderatorNote }) {
  // 0. Проверка баланса
  const balanceCheck = await tokenBilling.hasBalance(chatId, ESTIMATED_TOKENS_PER_ARTICLE);
  if (!balanceCheck.canUse) {
    throw new InsufficientBalanceError(
      `Insufficient token balance for article generation. ${balanceCheck.reason || ''}`
    );
  }

  // 1. Загрузка базы знаний (если указана)
  const knowledgeDoc = await loadKnowledge(chatId, techDocId);
  const knowledgeContext = knowledgeDoc
    ? `=== ТЕХНИЧЕСКИЙ ДОКУМЕНТ ===\nНазвание: ${knowledgeDoc.title}\nСодержимое:\n${knowledgeDoc.body}\nТеги: ${knowledgeDoc.tags || 'нет'}\n\n`
    : '';

  // Заметки модератора (для rewrite)
  const moderatorNoteSection = moderatorNote
    ? `\n=== ЗАМЕЧАНИЯ МОДЕРАТОРА (ОБЯЗАТЕЛЬНО УЧТИ) ===\n${moderatorNote}\n\n`
    : '';

  // 2. Format: определяем структуру статьи
  const formatResult = await aiChat(
    chatId,
    BLOG_PROMPT_FORMAT,
    `Тема: ${topic}\nКлючевые слова: ${keywords}${moderatorNoteSection}`
  );

  // Парсим JSON из ответа
  let formatData;
  try {
    // Ищем JSON в ответе
    const jsonMatch = formatResult.match(/\{[\s\S]*\}/);
    formatData = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
  } catch (err) {
    console.warn('[BLOG-GEN] Failed to parse format JSON, using defaults:', err.message);
    formatData = {
      target_audience: 'широкая аудитория',
      structure: 'введение, основная часть, заключение'
    };
  }

  // 3. Image prompt: генерируем промпт для обложки
  const imagePromptText = await aiChat(
    chatId,
    BLOG_PROMPT_IMAGE,
    `Структура статьи:\n${JSON.stringify(formatData, null, 2)}\nТема: ${topic}`
  );

  // 4. Генерация изображения
  const imageResult = await imageGenService.generateCover({
    prompt: imagePromptText.trim(),
    aspectRatio: '16:9',
    style: 'realistic',
    chatId
  });

  // 5. Генерация статьи в HTML
  const articleHtml = await aiChat(
    chatId,
    BLOG_PROMPT_WRITE,
    `Структура: ${JSON.stringify(formatData, null, 2)}\n${knowledgeContext}Тема: ${topic}\nКлючевые слова: ${keywords}${moderatorNoteSection}Правила SEO: используй ключевые слова естественно, добавь H2/H3 подзаголовки, списки где уместно`
  );

  // 6. SEO: параллельно генерируем title, description, slug
  const [seoTitle, metaDesc, slug] = await Promise.all([
    aiChat(chatId, BLOG_PROMPT_SEO_TITLE, `Тема: ${topic}\nКлючевые слова: ${keywords}`),
    aiChat(chatId, BLOG_PROMPT_SEO_DESC, `Тема: ${topic}\nСтатья:\n${articleHtml.substring(0, 2000)}`),
    aiChat(chatId, BLOG_PROMPT_SEO_SLUG, `Тема: ${topic}`)
  ]);

  // Очищаем slug от лишних символов
  const cleanSlug = slug.trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .substring(0, 100) || topic.toLowerCase().replace(/\s+/g, '-').substring(0, 100);

  return {
    bodyHtml: articleHtml.trim(),
    seoTitle: seoTitle.trim().substring(0, 70), // SEO title limit
    metaDesc: metaDesc.trim().substring(0, 160), // Meta description limit
    slug: cleanSlug,
    imageBuffer: imageResult.buffer,
    imageMime: imageResult.mimeType,
    imageFilename: imageResult.filename
  };
}

module.exports = {
  generate,
  InsufficientBalanceError,
  ESTIMATED_TOKENS_PER_ARTICLE
};
