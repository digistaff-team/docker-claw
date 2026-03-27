# Token Billing System — Task Specification

**Version:** 1.0  
**Date:** March 27, 2026  
**Priority:** High  
**Estimated Effort:** 3-5 days  

---

## Overview

Implement a centralized token billing system for the **Docker-Claw (Клиент Завод)** multi-tenant SaaS platform. The system tracks LLM token consumption across all users, manages balances, supports monthly resets, and integrates with payment providers.

**Key Principle:** Tokens are spent **only on LLM calls** (Agent Loop + Content Pipeline). Docker, per-user DB, MySQL skills, and file operations do NOT consume tokens.

---

## Architecture Context

### Current System (from CLAUDE.md)

- **Multi-tenant SaaS** with full isolation:
  - Docker container per user: `sandbox-user-{chatId}`
  - PostgreSQL DB per user: `db_{chatId}`
  - Central MySQL for AI skills: `ai_skills_db`
  - Central PostgreSQL: `clientzavod` (shared)

- **Token Consumption Points:**
  1. **Agent Loop** (`manage/telegram/agentLoop.js`) — main consumer (LLM + tool-calling)
  2. **Content Pipeline** (`services/contentMvp.service.js`, `vkMvp.service.js`, `okMvp.service.js`, `pinterestMvp.service.js`) — draft generation

- **AI Router** (`services/ai_router_service.js`) — unified interface for ProTalk/OpenAI/OpenRouter

---

## Task Breakdown

### Phase 1: Database Schema (Day 1)

#### 1.1 Migration Scripts for Central PostgreSQL (`clientzavod`)

**File:** `migrations/001_add_billing_tables.sql`

```sql
-- Add billing columns to users table (or create if not exists)
ALTER TABLE users 
ADD COLUMN IF NOT EXISTS balance_tokens BIGINT DEFAULT 0,
ADD COLUMN IF NOT EXISTS monthly_included_tokens BIGINT DEFAULT 0,
ADD COLUMN IF NOT EXISTS plan_id VARCHAR(20) DEFAULT 'free',
ADD COLUMN IF NOT EXISTS next_reset_date DATE,
ADD COLUMN IF NOT EXISTS stripe_subscription_id VARCHAR(100),
ADD COLUMN IF NOT EXISTS yookassa_subscription_id VARCHAR(100);

-- Token transactions table (central ledger)
CREATE TABLE IF NOT EXISTS token_transactions (
    id SERIAL PRIMARY KEY,
    user_id BIGINT,
    telegram_id BIGINT NOT NULL,
    amount BIGINT NOT NULL,  -- can be negative
    reason TEXT NOT NULL,    -- e.g., "agent_loop: gpt-4o 124 in + 856 out"
    model VARCHAR(50),
    prompt_tokens INTEGER,
    completion_tokens INTEGER,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_token_transactions_telegram_id ON token_transactions(telegram_id);
CREATE INDEX IF NOT EXISTS idx_token_transactions_created_at ON token_transactions(created_at);
CREATE INDEX IF NOT EXISTS idx_users_telegram_id ON users(telegram_id);

-- Plans table (optional, for flexibility)
CREATE TABLE IF NOT EXISTS billing_plans (
    id SERIAL PRIMARY KEY,
    plan_id VARCHAR(20) UNIQUE NOT NULL,
    name VARCHAR(50) NOT NULL,
    monthly_price_rub INTEGER NOT NULL,
    monthly_included_tokens BIGINT NOT NULL,
    overage_rate_per_million INTEGER NOT NULL,  -- rubles per 1M tokens
    is_active BOOLEAN DEFAULT true
);

-- Seed default plans
INSERT INTO billing_plans (plan_id, name, monthly_price_rub, monthly_included_tokens, overage_rate_per_million) VALUES
('free', 'Free', 0, 100000, 30),
('basic', 'Basic', 490, 1000000, 30),
('business', 'Business', 990, 3000000, 25),
('profi', 'Profi', 2900, 15000000, 20)
ON CONFLICT (plan_id) DO NOTHING;
```

**Execution:** Run manually or via migration runner:
```bash
psql -h <PG_HOST> -U <PG_USER> -d clientzavod -f migrations/001_add_billing_tables.sql
```

---

### Phase 2: Core Billing Module (Day 1-2)

#### 2.1 Create Token Billing Service

**File:** `manage/tokenBilling.js`

```javascript
const { Pool } = require('pg');
const config = require('../config');

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
     * @param {number} telegramId 
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
     * @param {number} telegramId 
     * @param {number} promptTokens 
     * @param {number} completionTokens 
     * @param {string} model 
     * @param {string} reason 
     * @returns {Promise<number>} total tokens spent
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

        // Deduct from balance
        await pool.query(`
            UPDATE users 
            SET balance_tokens = balance_tokens - $2 
            WHERE telegram_id = $1
        `, [telegramId, total]);

        // Record transaction
        await pool.query(`
            INSERT INTO token_transactions 
            (telegram_id, amount, reason, model, prompt_tokens, completion_tokens)
            VALUES ($1, $2, $3, $4, $5, $6)
        `, [telegramId, -total, reason, model, promptTokens, completionTokens]);

        return total;
    }

    /**
     * Add tokens (payment, monthly reset, bonus)
     * @param {number} telegramId 
     * @param {number} amount 
     * @param {string} reason 
     */
    static async addTokens(telegramId, amount, reason) {
        await pool.query(`
            UPDATE users 
            SET balance_tokens = balance_tokens + $2 
            WHERE telegram_id = $1
        `, [telegramId, amount]);

        await pool.query(`
            INSERT INTO token_transactions 
            (telegram_id, amount, reason)
            VALUES ($1, $2, $3)
        `, [telegramId, amount, reason]);
    }

    /**
     * Monthly token reset for all users
     * Call via scheduler on the 1st of each month
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
     * @param {number} telegramId 
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
     * @param {number} telegramId 
     * @param {string} planId 
     * @param {number} monthlyTokens 
     */
    static async updatePlan(telegramId, planId, monthlyTokens) {
        await pool.query(`
            UPDATE users 
            SET plan_id = $2,
                monthly_included_tokens = $3,
                next_reset_date = CURRENT_DATE + INTERVAL '1 month'
            WHERE telegram_id = $1
        `, [telegramId, planId, monthlyTokens]);

        // Reset balance to new plan's included tokens
        await this.addTokens(telegramId, monthlyTokens, `Plan upgrade to ${planId}`);
    }

    /**
     * Check if user can spend tokens (without deducting)
     * @param {number} telegramId 
     * @param {number} requiredTokens 
     * @returns {Promise<boolean>}
     */
    static async canAfford(telegramId, requiredTokens) {
        const balance = await this.getBalance(telegramId);
        return balance.balance_tokens >= requiredTokens;
    }

    /**
     * Estimate tokens for a prompt (simple approximation)
     * Use tiktoken for production accuracy
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
}

module.exports = TokenBilling;
```

---

### Phase 3: Agent Loop Integration (Day 2-3)

#### 3.1 Wrap AI Router Calls

**File:** `manage/telegram/agentLoop.js`

**Changes:**

```javascript
// At the top of agentLoop.js
const TokenBilling = require('../tokenBilling');

// ... existing imports

async function executeAgentLoop(chatId, userMessage, mode, onStep) {
    const manageStore = require('../store');
    const state = manageStore.getState(chatId);
    
    // ... existing setup code

    try {
        // Build context and messages
        const messages = await buildMessages(context, userMessage, mode);
        const model = state.aiModel || 'gpt-4o-mini';

        // === BILLING: Check balance before expensive call ===
        const estimatedPromptTokens = TokenBilling.estimateTokens(
            JSON.stringify(messages), 
            model
        );
        
        const canAfford = await TokenBilling.canAfford(chatId, estimatedPromptTokens + 1000); // buffer for response
        if (!canAfford) {
            await bot.sendMessage(chatId, 
                '⛔ **Токены закончились**\n\n' +
                'Пополните баланс в личном кабинете или напишите /pay\n' +
                `Текущий баланс: ${(await TokenBilling.getBalance(chatId)).balance_tokens.toLocaleString()} токенов`
            );
            return;
        }

        // Make AI call (existing code)
        const response = await aiRouterService.callAI(
            chatId,
            state.aiAuthToken,
            model,
            messages,
            tools,
            state.aiUserEmail
        );

        // === BILLING: Deduct tokens after successful response ===
        const usage = response.usage || { prompt_tokens: estimatedPromptTokens, completion_tokens: 0 };
        const promptTokens = usage.prompt_tokens || estimatedPromptTokens;
        const completionTokens = usage.completion_tokens || TokenBilling.estimateTokens(response.choices[0].message.content || '', model);

        const totalSpent = await TokenBilling.spendTokens(
            chatId,
            promptTokens,
            completionTokens,
            model,
            `agent_loop: ${mode} mode`
        );

        console.log(`[BILLING] Spent ${totalSpent} tokens for chatId ${chatId} (${promptTokens} in, ${completionTokens} out)`);

        // Continue with existing response processing...
        
    } catch (error) {
        if (error.code === 'NOT_ENOUGH_TOKENS') {
            await bot.sendMessage(chatId, 
                '⛔ **Недостаточно токенов**\n\n' +
                `Требуется: ${error.required.toLocaleString()}, Доступно: ${error.balance.toLocaleString()}\n` +
                'Пополните баланс: /pay'
            );
            return;
        }
        throw error;
    }
}
```

---

### Phase 4: Content Pipeline Integration (Day 3)

#### 4.1 Wrap Content Generation Calls

Update each content service to bill tokens:

**File:** `services/contentMvp.service.js` (Telegram)

```javascript
// At the top
const TokenBilling = require('./tokenBilling');

// In the draft generation function (around line 177 equivalent)
async function generateDraft(chatId, topic, channel) {
    const manageStore = require('../manage/store');
    const state = manageStore.getState(chatId);
    
    const messages = buildContentMessages(topic, channel);
    const model = state.aiModel || 'gpt-4o-mini';

    try {
        // Estimate cost
        const estimatedTokens = TokenBilling.estimateTokens(JSON.stringify(messages), model);
        
        if (!(await TokenBilling.canAfford(chatId, estimatedTokens + 500))) {
            throw new Error('NOT_ENOUGH_TOKENS_FOR_CONTENT');
        }

        // Generate draft
        const response = await aiRouterService.callAI(
            chatId,
            state.aiAuthToken,
            model,
            messages,
            null,
            state.aiUserEmail
        );

        // Bill tokens
        const usage = response.usage || { prompt_tokens: estimatedTokens, completion_tokens: 0 };
        const totalSpent = await TokenBilling.spendTokens(
            chatId,
            usage.prompt_tokens,
            usage.completion_tokens || TokenBilling.estimateTokens(response.choices[0].message.content || '', model),
            model,
            `content_pipeline: telegram draft`
        );

        console.log(`[BILLING] Content draft: ${totalSpent} tokens spent for chatId ${chatId}`);

        return response;
    } catch (error) {
        if (error.code === 'NOT_ENOUGH_TOKENS' || error.message === 'NOT_ENOUGH_TOKENS_FOR_CONTENT') {
            // Queue alert to moderator/user
            await queueContentAlert(chatId, 'Недостаточно токенов для генерации контента. Пополните баланс.');
            throw error;
        }
        throw error;
    }
}
```

**Repeat for:**
- `services/vkMvp.service.js` (line ~157)
- `services/okMvp.service.js` (line ~175)
- `services/pinterestMvp.service.js` (line ~177)

**Change reason string accordingly:**
- `content_pipeline: vk draft`
- `content_pipeline: ok draft`
- `content_pipeline: pinterest draft`

---

### Phase 5: Payment Integration (Day 3-4)

#### 5.1 YooKassa Webhook (Recommended for Russia)

**File:** `routes/billing.routes.js` (new)

```javascript
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const TokenBilling = require('../manage/tokenBilling');
const manageStore = require('../manage/store');

const YOOKASSA_SECRET_KEY = process.env.YOOKASSA_SECRET_KEY || '';

/**
 * YooKassa payment webhook
 * Handles payment notifications and credits tokens
 */
router.post('/yookassa-webhook', async (req, res) => {
    const signature = req.headers['x-signature'];
    const event = req.body;

    // Verify signature (YooKassa-specific)
    const payload = JSON.stringify(event);
    const expectedSignature = crypto
        .createHmac('sha256', YOOKASSA_SECRET_KEY)
        .update(payload)
        .digest('hex');

    if (signature !== expectedSignature) {
        return res.status(401).json({ error: 'Invalid signature' });
    }

    try {
        const { type, object } = event;

        if (type === 'payment.succeeded' || type === 'payment.waiting_for_capture') {
            const { amount, metadata } = object;
            
            const telegramId = metadata.telegram_id;
            const tokens = metadata.tokens || Math.floor(amount.value * 1000 / 30); // 30 rub = 1M tokens

            if (!telegramId) {
                return res.status(400).json({ error: 'No telegram_id in metadata' });
            }

            await TokenBilling.addTokens(telegramId, tokens, `Payment: ${object.id}`);

            // Notify user via bot
            const state = manageStore.getState(telegramId);
            if (state && state.botInstance) {
                state.botInstance.sendMessage(telegramId, 
                    `✅ **Платёж успешен!**\n\n` +
                    `Зачислено: ${tokens.toLocaleString()} токенов\n` +
                    `Новый баланс: ${(await TokenBilling.getBalance(telegramId)).balance_tokens.toLocaleString()} токенов`
                );
            }
        }

        res.status(200).json({ status: 'ok' });
    } catch (error) {
        console.error('[BILLING] Webhook error:', error);
        res.status(500).json({ error: 'Internal error' });
    }
});

/**
 * Create payment link for user
 */
router.post('/create-payment', async (req, res) => {
    const { telegramId, amount, tokens } = req.body;

    if (!telegramId || !amount) {
        return res.status(400).json({ error: 'telegramId and amount required' });
    }

    // Create YooKassa payment (use @yookassa/sdk or direct API)
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
            telegram_id: telegramId,
            tokens: tokens || Math.floor(amount * 1000 / 30)
        }
    };

    // Call YooKassa API
    const response = await fetch('https://api.yookassa.ru/v3/payments', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Basic ${Buffer.from(`${process.env.YOOKASSA_SHOP_ID}:${process.env.YOOKASSA_SECRET_KEY}`).toString('base64')}`
        },
        body: JSON.stringify(paymentData)
    });

    const payment = await response.json();

    res.json({ 
        success: true, 
        paymentUrl: payment.confirmation.confirmation_url,
        paymentId: payment.id
    });
});

module.exports = router;
```

**Register route in `routes/index.js`:**
```javascript
const billingRoutes = require('./billing.routes');
app.use('/api/billing', billingRoutes);
```

---

### Phase 6: UI & Bot Commands (Day 4-5)

#### 6.1 Telegram Bot Commands

**File:** `manage/telegram/authBot.js` or `manage/telegram/runner.js`

Add command handlers:

```javascript
// /balance command
bot.command('balance', async (msg) => {
    const chatId = msg.chat.id;
    const balance = await TokenBilling.getBalance(chatId);
    
    await bot.sendMessage(chatId, 
        `💰 **Баланс токенов**\n\n` +
        `Доступно: ${balance.balance_tokens.toLocaleString()}\n` +
        `План: ${balance.plan_id}\n` +
        `Ежемесячно: ${balance.monthly_included_tokens.toLocaleString()}\n` +
        `Следующий ресет: ${balance.next_reset_date ? balance.next_reset_date.toISOString().split('T')[0] : 'Никогда'}\n\n` +
        `Пополнить: /pay`
    );
});

// /pay command
bot.command('pay', async (msg) => {
    const chatId = msg.chat.id;
    
    const keyboard = {
        inline_keyboard: [
            [{ text: '1 млн (30₽)', callback_data: 'pay_30_1000000' }],
            [{ text: '3 млн (75₽)', callback_data: 'pay_75_3000000' }],
            [{ text: '15 млн (300₽)', callback_data: 'pay_300_15000000' }],
            [{ text: 'Другая сумма', callback_data: 'pay_custom' }]
        ]
    };

    await bot.sendMessage(chatId, '💳 **Выберите пакет токенов:**', {
        reply_markup: keyboard,
        parse_mode: 'Markdown'
    });
});

// Handle payment callback
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;

    if (data.startsWith('pay_')) {
        const [_, amountRub, tokens] = data.split('_');
        
        // Create payment link
        const response = await fetch(`${config.APP_URL}/api/billing/create-payment`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                telegramId: chatId,
                amount: parseInt(amountRub),
                tokens: parseInt(tokens)
            })
        });

        const { paymentUrl } = await response.json();

        await bot.sendMessage(chatId, `Перейдите к оплате: ${paymentUrl}`);
    }
});
```

#### 6.2 Web Dashboard Balance Page

**File:** `public/balance.html` (new)

```html
<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Баланс токенов - Клиент Завод</title>
    <link rel="stylesheet" href="/css/main.css">
</head>
<body>
    <div class="container">
        <h1>💰 Баланс токенов</h1>
        
        <div class="balance-card">
            <div class="balance-amount" id="balance">Загрузка...</div>
            <div class="balance-details">
                <p>План: <span id="plan">-</span></p>
                <p>Ежемесячно: <span id="monthly">-</span></p>
                <p>Ресет: <span id="reset">-</span></p>
            </div>
        </div>

        <h2>Пополнить баланс</h2>
        <div class="packages">
            <button class="package-btn" data-amount="30" data-tokens="1000000">
                1 млн токенов — 30₽
            </button>
            <button class="package-btn" data-amount="75" data-tokens="3000000">
                3 млн токенов — 75₽
            </button>
            <button class="package-btn" data-amount="300" data-tokens="15000000">
                15 млн токенов — 300₽
            </button>
        </div>

        <h2>История транзакций</h2>
        <table id="transactions">
            <thead>
                <tr>
                    <th>Дата</th>
                    <th>Тип</th>
                    <th>Модель</th>
                    <th>Входящие</th>
                    <th>Исходящие</th>
                    <th>Сумма</th>
                </tr>
            </thead>
            <tbody></tbody>
        </table>
    </div>

    <script src="/js/common.js"></script>
    <script>
        async function loadBalance() {
            const res = await fetch('/api/billing/balance');
            const data = await res.json();
            
            document.getElementById('balance').textContent = 
                data.balance_tokens.toLocaleString() + ' токенов';
            document.getElementById('plan').textContent = data.plan_id;
            document.getElementById('monthly').textContent = 
                data.monthly_included_tokens.toLocaleString();
            document.getElementById('reset').textContent = 
                data.next_reset_date || 'Никогда';
        }

        async function loadTransactions() {
            const res = await fetch('/api/billing/transactions');
            const transactions = await res.json();
            
            const tbody = document.querySelector('#transactions tbody');
            tbody.innerHTML = transactions.map(t => `
                <tr>
                    <td>${new Date(t.created_at).toLocaleDateString()}</td>
                    <td>${t.amount > 0 ? '➕' : '➖'} ${t.reason}</td>
                    <td>${t.model || '-'}</td>
                    <td>${t.prompt_tokens || '-'}</td>
                    <td>${t.completion_tokens || '-'}</td>
                    <td style="color: ${t.amount > 0 ? 'green' : 'red'}">
                        ${t.amount > 0 ? '+' : ''}${t.amount.toLocaleString()}
                    </td>
                </tr>
            `).join('');
        }

        document.querySelectorAll('.package-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const amount = btn.dataset.amount;
                const tokens = btn.dataset.tokens;
                
                const res = await fetch('/api/billing/create-payment', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ amount: parseInt(amount), tokens: parseInt(tokens) })
                });
                
                const { paymentUrl } = await res.json();
                window.open(paymentUrl, '_blank');
            });
        });

        loadBalance();
        loadTransactions();
    </script>
</body>
</html>
```

**Add API routes in `routes/billing.routes.js`:**

```javascript
// Get current user balance
router.get('/balance', async (req, res) => {
    const telegramId = req.session?.telegramId || req.query.telegram_id;
    if (!telegramId) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    
    const balance = await TokenBilling.getBalance(telegramId);
    res.json(balance);
});

// Get transaction history
router.get('/transactions', async (req, res) => {
    const telegramId = req.session?.telegramId || req.query.telegram_id;
    if (!telegramId) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    
    const transactions = await TokenBilling.getTransactions(telegramId, 100);
    res.json(transactions);
});
```

---

### Phase 7: Scheduler Integration (Day 5)

#### 7.1 Monthly Reset Scheduler

**File:** `server.js` (existing main server file)

Add monthly reset job:

```javascript
const TokenBilling = require('./manage/tokenBilling');

// Run monthly reset on the 1st of each month at 00:00
function scheduleMonthlyReset() {
    const now = new Date();
    const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1, 0, 0, 0);
    const delay = nextMonth.getTime() - now.getTime();

    console.log(`[BILLING] Next monthly reset scheduled in ${delay / 1000 / 60 / 60} hours`);

    setTimeout(async () => {
        try {
            await TokenBilling.monthlyReset();
        } catch (error) {
            console.error('[BILLING] Monthly reset failed:', error);
        }
        // Reschedule for next month
        scheduleMonthlyReset();
    }, delay);
}

// Call on server start
scheduleMonthlyReset();
```

---

## Testing Checklist

### Unit Tests
- [ ] `TokenBilling.getBalance()` — returns correct balance
- [ ] `TokenBilling.spendTokens()` — deducts correctly, throws on insufficient balance
- [ ] `TokenBilling.addTokens()` — adds tokens, records transaction
- [ ] `TokenBilling.monthlyReset()` — resets balances for eligible users

### Integration Tests
- [ ] Agent Loop integration — tokens deducted after LLM call
- [ ] Content Pipeline integration — tokens deducted for each channel draft
- [ ] Payment webhook — tokens credited after successful payment
- [ ] Bot commands — `/balance` and `/pay` work correctly

### E2E Tests
- [ ] User flow: register → get free tokens → use AI → balance decreases → pay → balance increases
- [ ] Monthly reset: simulate date change → verify reset occurs

---

## Environment Variables

Add to `.env.example`:

```bash
# Billing
YOOKASSA_SHOP_ID=your_shop_id
YOOKASSA_SECRET_KEY=your_secret_key
BILLING_ENABLED=true
DEFAULT_FREE_TOKENS=100000
```

---

## Security Considerations

1. **Idempotency:** Payment webhooks must be idempotent (check if payment already processed)
2. **Signature Verification:** Always verify webhook signatures
3. **Rate Limiting:** Limit `/create-payment` to prevent abuse
4. **Audit Trail:** All transactions logged in `token_transactions`
5. **Balance Locking:** Use DB transactions for balance updates to prevent race conditions

---

## Rollout Plan

### Week 1: Core Implementation
- Days 1-2: Database + TokenBilling module
- Days 3-4: Agent Loop + Content Pipeline integration
- Day 5: Testing + bug fixes

### Week 2: Payments + UI
- Days 1-2: YooKassa integration
- Days 3-4: Bot commands + web dashboard
- Day 5: E2E testing + deployment

---

## Success Metrics

- ✅ All LLM calls tracked in `token_transactions`
- ✅ Users blocked when balance < 0
- ✅ Monthly reset works automatically
- ✅ Payments credit tokens correctly
- ✅ Balance visible in bot (`/balance`) and web (`/balance.html`)

---

## Notes

- **Token estimation:** For production accuracy, integrate `tiktoken` library instead of character-based estimation
- **Multi-provider rates:** Different models have different costs (gpt-4 vs gpt-4o-mini). Add model-specific rates if needed.
- **Tool calling overhead:** The 15% buffer accounts for tool definitions in prompts. Adjust based on actual usage data.
- **Free tier:** Consider giving new users 100k free tokens on signup (add in auth flow).

---

**Ready to implement?** Start with Phase 1 (database migrations) and proceed sequentially. Each phase is independently testable.
