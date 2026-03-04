const { Client } = require('pg');
const config = require('../config');

/**
 * Создает клиента PostgreSQL с SSL
 */
function createClient(database = 'postgres') {
    return new Client({
        host: config.PG_HOST,
        port: config.PG_PORT,
        user: config.PG_USER,
        password: config.PG_PASSWORD,
        database,
        ssl: { rejectUnauthorized: false } // SSL подключение
    });
}

/**
 * Создает имя базы данных из chatId
 */
function getDbName(chatId) {
    return `db_${chatId.replace(/[^a-z0-9_]/gi, '_').toLowerCase()}`;
}

/**
 * Создает базу данных для пользователя
 */
async function createUserDatabase(chatId) {
    const dbName = getDbName(chatId);
    const client = createClient('postgres');
    
    try {
        await client.connect();
        
        // Проверяем существование
        const checkResult = await client.query(
            'SELECT 1 FROM pg_database WHERE datname = $1',
            [dbName]
        );
        
        if (checkResult.rows.length === 0) {
            await client.query(`CREATE DATABASE ${dbName}`);
            console.log(`[DB] Created database: ${dbName}`);
        }
        
        await client.end();
        return dbName;
    } catch (error) {
        await client.end();
        throw error;
    }
}

/**
 * Удаляет базу данных пользователя
 */
async function deleteUserDatabase(chatId) {
    const dbName = getDbName(chatId);
    const client = createClient('postgres');
    
    try {
        await client.connect();
        
        // Отключаем все соединения
        await client.query(`
            SELECT pg_terminate_backend(pg_stat_activity.pid)
            FROM pg_stat_activity
            WHERE pg_stat_activity.datname = $1
            AND pid <> pg_backend_pid()
        `, [dbName]);
        
        await client.query(`DROP DATABASE IF EXISTS ${dbName}`);
        console.log(`[DB] Deleted database: ${dbName}`);
        
        await client.end();
    } catch (error) {
        await client.end();
        throw error;
    }
}

/**
 * Возвращает информацию о подключении к БД
 */
async function getDatabaseInfo(chatId) {
    const dbName = getDbName(chatId);
    
    return {
        host: config.PG_HOST,
        port: config.PG_PORT,
        database: dbName,
        user: config.PG_USER,
        password: config.PG_PASSWORD,
        connectionString: `postgresql://${config.PG_USER}:${config.PG_PASSWORD}@${config.PG_HOST}:${config.PG_PORT}/${dbName}`
    };
}

/**
 * Проверяет существование базы
 */
async function databaseExists(chatId) {
    const dbName = getDbName(chatId);
    const client = createClient('postgres');
    
    try {
        await client.connect();
        const result = await client.query(
            'SELECT 1 FROM pg_database WHERE datname = $1',
            [dbName]
        );
        await client.end();
        return result.rows.length > 0;
    } catch {
        await client.end();
        return false;
    }
}

module.exports = {
    createUserDatabase,
    deleteUserDatabase,
    getDatabaseInfo,
    databaseExists,
    getDbName
};
