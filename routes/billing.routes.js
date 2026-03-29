/**
 * Billing Routes - YooKassa Payment Integration
 * 
 * Handles:
 * - Payment webhook notifications
 * - Payment link creation
 * - Balance and transaction history API
 */
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const TokenBilling = require('../manage/tokenBilling');
const manageStore = require('../manage/store');
const config = require('../config');

const YOOKASSA_SHOP_ID = process.env.YOOKASSA_SHOP_ID || '';
const YOOKASSA_SECRET_KEY = process.env.YOOKASSA_SECRET_KEY || '';

/**
 * YooKassa payment webhook
 * Handles payment notifications and credits tokens
 * 
 * @route POST /api/billing/yookassa-webhook
 */
router.post('/yookassa-webhook', async (req, res) => {
    const signature = req.headers['x-signature'];
    const event = req.body;

    console.log('[BILLING-WEBHOOK] Received event:', event.type);

    // Verify signature (YooKassa-specific)
    const payload = JSON.stringify(event);
    const expectedSignature = crypto
        .createHmac('sha256', YOOKASSA_SECRET_KEY)
        .update(payload)
        .digest('hex');

    if (signature !== expectedSignature) {
        console.warn('[BILLING-WEBHOOK] Invalid signature');
        return res.status(401).json({ error: 'Invalid signature' });
    }

    try {
        const { type, object } = event;

        if (type === 'payment.succeeded' || type === 'payment.waiting_for_capture') {
            const { amount, metadata, id: paymentId } = object;

            const telegramId = metadata?.telegram_id;
            const tokens = metadata?.tokens || Math.floor(amount.value * 1000 / 30); // 30 rub = 1M tokens

            if (!telegramId) {
                console.error('[BILLING-WEBHOOK] No telegram_id in metadata');
                return res.status(400).json({ error: 'No telegram_id in metadata' });
            }

            // Check if payment already processed (idempotency)
            const existingTransaction = await TokenBilling.getTransactions(telegramId, 100);
            const alreadyProcessed = existingTransaction.some(
                t => t.reason?.includes(`Payment: ${paymentId}`)
            );

            if (alreadyProcessed) {
                console.log(`[BILLING-WEBHOOK] Payment ${paymentId} already processed`);
                return res.status(200).json({ status: 'ok', message: 'Already processed' });
            }

            // Credit tokens
            await TokenBilling.addTokens(telegramId, tokens, `Payment: ${paymentId}`);

            // Notify user via bot
            const state = manageStore.getState(telegramId);
            if (state && state.botInstance) {
                const balance = await TokenBilling.getBalance(telegramId);
                await state.botInstance.sendMessage(telegramId,
                    `✅ **Платёж успешен!**\n\n` +
                    `Зачислено: ${tokens.toLocaleString()} токенов\n` +
                    `Сумма: ${amount.value} ${amount.currency}\n` +
                    `Новый баланс: ${balance.balance_tokens.toLocaleString()} токенов\n\n` +
                    `План: ${balance.plan_id}\n` +
                    `Ежемесячно: ${balance.monthly_included_tokens.toLocaleString()} токенов`,
                    { parse_mode: 'Markdown' }
                );
            }

            console.log(`[BILLING-WEBHOOK] Payment ${paymentId} processed: ${tokens} tokens for telegram_id ${telegramId}`);
        }

        res.status(200).json({ status: 'ok' });
    } catch (error) {
        console.error('[BILLING-WEBHOOK] Error:', error);
        res.status(500).json({ error: 'Internal error' });
    }
});

/**
 * Create payment link for user
 * 
 * @route POST /api/billing/create-payment
 * @body {number} telegramId - User's Telegram ID
 * @body {number} amount - Payment amount in RUB
 * @body {number} [tokens] - Number of tokens (calculated if not provided)
 */
router.post('/create-payment', async (req, res) => {
    const { telegramId, amount, tokens } = req.body;

    if (!telegramId || !amount) {
        return res.status(400).json({ error: 'telegramId and amount required' });
    }

    if (amount < 10) {
        return res.status(400).json({ error: 'Minimum amount is 10 RUB' });
    }

    try {
        // Calculate tokens if not provided (30 RUB = 1M tokens)
        const tokenCount = tokens || Math.floor(amount * 1000 / 30);

        // Create YooKassa payment
        const paymentData = {
            amount: {
                value: amount.toString(),
                currency: 'RUB'
            },
            capture: true,
            confirmation: {
                type: 'redirect',
                return_url: `${config.APP_URL}/billing/success`
            },
            description: `Пополнение токенов для Telegram ID ${telegramId}`,
            metadata: {
                telegram_id: telegramId.toString(),
                tokens: tokenCount.toString()
            }
        };

        const response = await fetch('https://api.yookassa.ru/v3/payments', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Basic ${Buffer.from(`${YOOKASSA_SHOP_ID}:${YOOKASSA_SECRET_KEY}`).toString('base64')}`
            },
            body: JSON.stringify(paymentData)
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error('[BILLING] YooKassa API error:', response.status, errorText);
            return res.status(500).json({ error: 'Failed to create payment' });
        }

        const payment = await response.json();

        console.log(`[BILLING] Payment created: ${payment.id} for ${amount} RUB (${tokenCount} tokens)`);

        res.json({
            success: true,
            paymentUrl: payment.confirmation.confirmation_url,
            paymentId: payment.id,
            amount: amount,
            tokens: tokenCount
        });
    } catch (error) {
        console.error('[BILLING] Create payment error:', error);
        res.status(500).json({ error: error.message || 'Internal error' });
    }
});

/**
 * Get current user balance
 * 
 * @route GET /api/billing/balance
 * @query {number} telegram_id - User's Telegram ID
 */
router.get('/balance', async (req, res) => {
    const telegramId = req.query.telegram_id || req.session?.telegramId;
    
    if (!telegramId) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
        const balance = await TokenBilling.getBalance(telegramId);
        const plans = await TokenBilling.getAllPlans();
        
        res.json({
            ...balance,
            plans: plans,
            billing_enabled: TokenBilling.isBillingEnabled()
        });
    } catch (error) {
        console.error('[BILLING] Get balance error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * Get transaction history
 * 
 * @route GET /api/billing/transactions
 * @query {number} telegram_id - User's Telegram ID
 * @query {number} [limit=50] - Number of transactions to return
 */
router.get('/transactions', async (req, res) => {
    const telegramId = req.query.telegram_id || req.session?.telegramId;
    const limit = parseInt(req.query.limit || '50', 10);
    
    if (!telegramId) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
        const transactions = await TokenBilling.getTransactions(telegramId, limit);
        res.json(transactions);
    } catch (error) {
        console.error('[BILLING] Get transactions error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * Get available billing plans
 * 
 * @route GET /api/billing/plans
 */
router.get('/plans', async (req, res) => {
    try {
        const plans = await TokenBilling.getAllPlans();
        res.json(plans);
    } catch (error) {
        console.error('[BILLING] Get plans error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * Upgrade user plan
 * 
 * @route POST /api/billing/upgrade-plan
 * @body {number} telegram_id - User's Telegram ID
 * @body {string} plan_id - Plan ID to upgrade to
 */
router.post('/upgrade-plan', async (req, res) => {
    const { telegram_id, plan_id } = req.body;
    
    if (!telegram_id || !plan_id) {
        return res.status(400).json({ error: 'telegram_id and plan_id required' });
    }

    try {
        const plan = await TokenBilling.getPlan(plan_id);
        if (!plan) {
            return res.status(404).json({ error: 'Plan not found' });
        }

        await TokenBilling.updatePlan(telegram_id, plan_id, plan.monthly_included_tokens);
        
        const balance = await TokenBilling.getBalance(telegram_id);
        
        res.json({
            success: true,
            message: `Plan upgraded to ${plan.name}`,
            balance
        });
    } catch (error) {
        console.error('[BILLING] Upgrade plan error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * Get token usage statistics
 * 
 * @route GET /api/billing/usage
 * @query {number} telegram_id - User's Telegram ID
 * @query {string} [period=7d] - Period: 1d, 7d, 30d
 */
router.get('/usage', async (req, res) => {
    const telegramId = req.query.telegram_id || req.session?.telegramId;
    const period = req.query.period || '7d';
    
    if (!telegramId) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
        const now = new Date();
        let startDate;
        
        switch (period) {
            case '1d': startDate = new Date(now.getTime() - 24 * 60 * 60 * 1000); break;
            case '7d': startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000); break;
            case '30d': startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000); break;
            default: startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        }

        const usage = await TokenBilling.getTokenUsage(telegramId, startDate, now);
        const balance = await TokenBilling.getBalance(telegramId);

        res.json({
            period,
            startDate: startDate.toISOString(),
            endDate: now.toISOString(),
            ...usage,
            current_balance: balance.balance_tokens,
            monthly_included: balance.monthly_included_tokens,
            next_reset: balance.next_reset_date
        });
    } catch (error) {
        console.error('[BILLING] Get usage error:', error);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
