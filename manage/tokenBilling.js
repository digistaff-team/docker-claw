const { Pool } = require('pg');
const config = require('../config');

/**
 * Token Billing Service - Centralized token management for Docker-Claw SaaS
 * 
 * Tracks LLM token consumption across all users, manages balances,
 * supports monthly resets, and integrates with payment providers.
 * 
 * Key Principle: Tokens are spent ONLY on LLM calls (Agent Loop + Content Pipeline).
 * Docker, per-user DB, MySQL skills, and file operations do NOT consume tokens.
 */

// Central PostgreSQL pool (clientzavod database)
const pool = new Pool({
    host: config.PG_HOST,
    port: config.PG_PORT,
    user: config.PG_USER,
    password: config.PG_PASSWORD,
    database: 'clientzavod',
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000
});

class TokenBilling {
    /**
     * Get user balance and plan info
     * @param {number|string} telegramId
     * @returns {Promise<{balance_tokens: number, monthly_included_tokens: number, plan_id: string, next_reset_date: Date}>}
     */
    static async getBalance(telegramId) {
        const res = await pool.query(
            'SELECT balance_tokens, monthly_included_tokens, plan_id, next_reset_date FROM users WHERE telegram_id = $1',
            [telegramId]
        );
        return res.rows[0] || {
            balance_tokens: 0,
            monthly_included_tokens: 0,
            plan_id: 'free',
            next_reset_date: null
        };
    }

    /**
     * Spend tokens from user balance
     * @param {number|string} telegramId
     * @param {number} promptTokens
     * @param {number} completionTokens
     * @param {string} model
     * @param {string} reason
     * @returns {Promise<number>} total tokens spent
     * @throws {Error} with code 'NOT_ENOUGH_TOKENS' if insufficient balance
     */
    static async spendTokens(telegramId, promptTokens, completionTokens, model, reason) {
        // Apply 15% buffer for tool-calling overhead (like pro-talk.ru)
        const total = Math.ceil(promptTokens + completionTokens * 1.15);

        const balance = await this.getBalance(telegramId);

        if (balance.balance_tokens < total) {
            const error = new Error('NOT_ENOUGH_TOKENS');
            error.code = 'NOT_ENOUGH_TOKENS';
            error.balance = balance.balance_tokens;
            error.required = total;
            throw error;
        }

        // Deduct from balance using transaction for atomicity
        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            // Deduct from balance
            await client.query(`
                UPDATE users
                SET balance_tokens = balance_tokens - $2
                WHERE telegram_id = $1
            `, [telegramId, total]);

            // Record transaction
            await client.query(`
                INSERT INTO token_transactions
                (telegram_id, amount, reason, model, prompt_tokens, completion_tokens)
                VALUES ($1, $2, $3, $4, $5, $6)
            `, [telegramId, -total, reason, model, promptTokens, completionTokens]);

            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }

        return total;
    }

    /**
     * Add tokens (payment, monthly reset, bonus)
     * @param {number|string} telegramId
     * @param {number} amount
     * @param {string} reason
     */
    static async addTokens(telegramId, amount, reason) {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            // Add to balance
            await client.query(`
                UPDATE users
                SET balance_tokens = balance_tokens + $2
                WHERE telegram_id = $1
            `, [telegramId, amount]);

            // Record transaction
            await client.query(`
                INSERT INTO token_transactions
                (telegram_id, amount, reason)
                VALUES ($1, $2, $3)
            `, [telegramId, amount, reason]);

            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    }

    /**
     * Monthly token reset for all users
     * Call via scheduler on the 1st of each month
     * @returns {Promise<number>} number of users updated
     */
    static async monthlyReset() {
        const result = await pool.query(`
            UPDATE users
            SET balance_tokens = monthly_included_tokens,
                next_reset_date = CURRENT_DATE + INTERVAL '1 month'
            WHERE next_reset_date <= CURRENT_DATE
              AND monthly_included_tokens > 0
        `);

        console.log(`[BILLING] Monthly reset completed: ${result.rowCount} users updated`);
        return result.rowCount;
    }

    /**
     * Get transaction history for user
     * @param {number|string} telegramId
     * @param {number} limit
     * @returns {Promise<Array>}
     */
    static async getTransactions(telegramId, limit = 50) {
        const res = await pool.query(`
            SELECT id, amount, reason, model, prompt_tokens, completion_tokens, created_at
            FROM token_transactions
            WHERE telegram_id = $1
            ORDER BY created_at DESC
            LIMIT $2
        `, [telegramId, limit]);

        return res.rows;
    }

    /**
     * Update user plan
     * @param {number|string} telegramId
     * @param {string} planId
     * @param {number} monthlyTokens
     */
    static async updatePlan(telegramId, planId, monthlyTokens) {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            await client.query(`
                UPDATE users
                SET plan_id = $2,
                    monthly_included_tokens = $3,
                    next_reset_date = CURRENT_DATE + INTERVAL '1 month'
                WHERE telegram_id = $1
            `, [telegramId, planId, monthlyTokens]);

            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }

        // Reset balance to new plan's included tokens
        await this.addTokens(telegramId, monthlyTokens, `Plan upgrade to ${planId}`);
    }

    /**
     * Check if user can spend tokens (without deducting)
     * @param {number|string} telegramId
     * @param {number} requiredTokens
     * @returns {Promise<boolean>}
     */
    static async canAfford(telegramId, requiredTokens) {
        const balance = await this.getBalance(telegramId);
        return balance.balance_tokens >= requiredTokens;
    }

    /**
     * Estimate tokens for a prompt (simple approximation)
     * For production accuracy, integrate tiktoken library
     * @param {string} text
     * @param {string} model
     * @returns {number}
     */
    static estimateTokens(text, model = 'gpt-4o') {
        // Rough estimate: 1 token ≈ 4 characters for English, 1.5 for Russian
        const charCount = text.length;
        const avgTokenLength = model.includes('gpt') ? 4 : 3.5;
        return Math.ceil(charCount / avgTokenLength);
    }

    /**
     * Get billing plan details
     * @param {string} planId
     * @returns {Promise<{plan_id: string, name: string, monthly_price_rub: number, monthly_included_tokens: number, overage_rate_per_million: number}>}
     */
    static async getPlan(planId) {
        const res = await pool.query(
            'SELECT plan_id, name, monthly_price_rub, monthly_included_tokens, overage_rate_per_million FROM billing_plans WHERE plan_id = $1 AND is_active = true',
            [planId]
        );
        return res.rows[0] || null;
    }

    /**
     * Get all available billing plans
     * @returns {Promise<Array>}
     */
    static async getAllPlans() {
        const res = await pool.query(
            'SELECT plan_id, name, monthly_price_rub, monthly_included_tokens, overage_rate_per_million FROM billing_plans WHERE is_active = true ORDER BY monthly_price_rub'
        );
        return res.rows;
    }

    /**
     * Get total tokens spent by user in a date range
     * @param {number|string} telegramId
     * @param {Date} startDate
     * @param {Date} endDate
     * @returns {Promise<{total_spent: number, transaction_count: number}>}
     */
    static async getTokenUsage(telegramId, startDate, endDate) {
        const res = await pool.query(`
            SELECT 
                COALESCE(SUM(ABS(amount)), 0) as total_spent,
                COUNT(*) as transaction_count
            FROM token_transactions
            WHERE telegram_id = $1
              AND amount < 0
              AND created_at >= $2
              AND created_at <= $3
        `, [telegramId, startDate, endDate]);

        return res.rows[0] || { total_spent: 0, transaction_count: 0 };
    }

    /**
     * Check if billing is enabled via environment variable
     * @returns {boolean}
     */
    static isBillingEnabled() {
        return process.env.BILLING_ENABLED === 'true';
    }

    /**
     * Get default free tokens from environment variable
     * @returns {number}
     */
    static getDefaultFreeTokens() {
        return parseInt(process.env.DEFAULT_FREE_TOKENS || '100000', 10);
    }
}

module.exports = TokenBilling;
