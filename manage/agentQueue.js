const queues = new Map(); // chatId -> Promise

/**
 * Ставит задачу в очередь per chatId.
 *
 * @param {string} chatId
 * @param {Function} fn  - async функция для выполнения
 * @param {Object}  opts
 * @param {boolean} opts.nested - если true, задача НЕ встаёт в очередь и запускается немедленно.
 *   Используется для вложенных вызовов агента (например, когда Node.js-приложение пользователя
 *   делает POST /webhook изнутри уже выполняющегося агента). Без этого флага возникает deadlock:
 *   внешний агент держит очередь и ждёт ответа от вложенного, который не может запуститься.
 */
async function enqueue(chatId, fn, opts = {}) {
    if (opts.nested) {
        // Вложенный вызов — запускаем немедленно, минуя очередь
        try {
            return await fn();
        } catch (e) {
            return { error: e.message };
        }
    }
    const prev = queues.get(chatId) || Promise.resolve();
    const next = prev.then(() => fn()).catch(e => ({ error: e.message }));
    queues.set(chatId, next);
    return next;
}

module.exports = {
    enqueue
};
