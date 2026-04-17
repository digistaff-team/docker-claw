'use strict';

/**
 * Определяет, заблокировал ли пользователь бота.
 */
function isBotBlockedError(e) {
  return (
    e?.response?.error_code === 403 ||
    e?.code === 403 ||
    (typeof e?.message === 'string' && (
      e.message.includes('bot was blocked by the user') ||
      e.message.includes('user is deactivated')
    ))
  );
}

/**
 * Безопасная отправка сообщения модератору через Telegram.
 * При ошибке "bot was blocked by the user" уведомляет владельца канала (chatId).
 * Всегда пробрасывает ошибку дальше, чтобы не ломать внешние try/catch.
 *
 * @param {object} opts
 * @param {Function}      opts.sendFn      — функция отправки, возвращает Promise с результатом
 * @param {string}        opts.chatId      — Telegram ID владельца канала (получает уведомление)
 * @param {string|number} opts.moderatorId — Telegram ID модератора
 * @param {object}        opts.notifyBot   — бот, через который уведомить владельца
 */
async function safeSendToModerator({ sendFn, chatId, moderatorId, notifyBot }) {
  try {
    return await sendFn();
  } catch (e) {
    if (isBotBlockedError(e)) {
      console.warn(`[MODERATION] Moderator ${moderatorId} blocked the bot (owner chatId: ${chatId}): ${e.message}`);
      if (notifyBot && String(chatId) !== String(moderatorId)) {
        const msg =
          `⚠️ Черновик не был доставлен модератору (ID: <code>${moderatorId}</code>) — ` +
          `пользователь заблокировал @czcw_bot.\n\n` +
          `Попросите модератора разблокировать бота и повторите отправку.`;
        await notifyBot.telegram.sendMessage(String(chatId), msg, { parse_mode: 'HTML' }).catch(() => {});
      }
    }
    throw e;
  }
}

module.exports = { safeSendToModerator, isBotBlockedError };
