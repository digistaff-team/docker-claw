/**
 * Pinterest service — DB-операции с досками.
 * Публикация осуществляется через Buffer API (см. buffer.service.js).
 */
const repo = require('./content/pinterest.repository');

module.exports = {
    getBoards: repo.getBoards,
    getBoard: repo.getBoard,
    saveBoardsToDb: repo.saveBoards,
    getBoardsFromDb: repo.getBoards,
    updateBoard: repo.updateBoard,
    deleteBoard: repo.deleteBoard
};
