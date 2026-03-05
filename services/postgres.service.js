const { Client } = require('pg');
const config = require('../config');

function getAdminHosts() {
    const hosts = [
        config.PG_ADMIN_HOST,
        config.PG_HOST,
        '127.0.0.1',
        'localhost'
    ].filter(Boolean);

    return [...new Set(hosts)];
}

function createClient(host, database = 'postgres') {
    return new Client({
        host,
        port: config.PG_PORT,
        user: config.PG_USER,
        password: config.PG_PASSWORD,
        database,
        ssl: false,
        connectionTimeoutMillis: 5000
    });
}

async function safeEnd(client) {
    try {
        await client.end();
    } catch {
        // ignore
    }
}

async function runWithAdminClient(database, operation) {
    const hosts = getAdminHosts();
    let lastError;

    for (const host of hosts) {
        const client = createClient(host, database);
        try {
            await client.connect();
            if (host !== config.PG_ADMIN_HOST) {
                console.warn(`[DB] Fallback admin host in use: ${host}`);
            }
            return await operation(client);
        } catch (error) {
            lastError = error;
        } finally {
            await safeEnd(client);
        }
    }

    throw lastError || new Error('Failed to connect to PostgreSQL');
}

function getDbName(chatId) {
    return `db_${chatId.replace(/[^a-z0-9_]/gi, '_').toLowerCase()}`;
}

async function createUserDatabase(chatId) {
    const dbName = getDbName(chatId);

    return runWithAdminClient('postgres', async (client) => {
        const checkResult = await client.query(
            'SELECT 1 FROM pg_database WHERE datname = $1',
            [dbName]
        );

        if (checkResult.rows.length === 0) {
            await client.query(`CREATE DATABASE ${dbName}`);
            console.log(`[DB] Created database: ${dbName}`);
        }

        return dbName;
    });
}

async function deleteUserDatabase(chatId) {
    const dbName = getDbName(chatId);

    await runWithAdminClient('postgres', async (client) => {
        await client.query(`
            SELECT pg_terminate_backend(pg_stat_activity.pid)
            FROM pg_stat_activity
            WHERE pg_stat_activity.datname = $1
            AND pid <> pg_backend_pid()
        `, [dbName]);

        await client.query(`DROP DATABASE IF EXISTS ${dbName}`);
        console.log(`[DB] Deleted database: ${dbName}`);
    });
}

async function getDatabaseInfo(chatId) {
    const dbName = getDbName(chatId);
    const dbHost = config.PG_SANDBOX_HOST || config.PG_HOST;
    const dbUrl = new URL('postgresql://localhost');
    dbUrl.username = config.PG_USER;
    dbUrl.password = config.PG_PASSWORD;
    dbUrl.hostname = dbHost;
    dbUrl.port = String(config.PG_PORT);
    dbUrl.pathname = `/${dbName}`;

    return {
        host: dbHost,
        port: config.PG_PORT,
        database: dbName,
        user: config.PG_USER,
        password: config.PG_PASSWORD,
        connectionString: dbUrl.toString()
    };
}

async function databaseExists(chatId) {
    const dbName = getDbName(chatId);

    try {
        const result = await runWithAdminClient('postgres', (client) => client.query(
            'SELECT 1 FROM pg_database WHERE datname = $1',
            [dbName]
        ));

        return result.rows.length > 0;
    } catch {
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
