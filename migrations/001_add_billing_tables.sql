-- =====================================================
-- BILLING SYSTEM MIGRATION
-- 2026-03-27
-- Central PostgreSQL Database: clientzavod
-- =====================================================

-- =====================================================
-- 1. Add billing columns to users table
-- =====================================================
ALTER TABLE users
ADD COLUMN IF NOT EXISTS balance_tokens BIGINT DEFAULT 0,
ADD COLUMN IF NOT EXISTS monthly_included_tokens BIGINT DEFAULT 0,
ADD COLUMN IF NOT EXISTS plan_id VARCHAR(20) DEFAULT 'free',
ADD COLUMN IF NOT EXISTS next_reset_date DATE,
ADD COLUMN IF NOT EXISTS stripe_subscription_id VARCHAR(100),
ADD COLUMN IF NOT EXISTS yookassa_subscription_id VARCHAR(100);

-- =====================================================
-- 2. Token transactions table (central ledger)
-- =====================================================
CREATE TABLE IF NOT EXISTS token_transactions (
    id SERIAL PRIMARY KEY,
    user_id BIGINT,
    telegram_id BIGINT NOT NULL,
    amount BIGINT NOT NULL,  -- can be negative (spent) or positive (added)
    reason TEXT NOT NULL,    -- e.g., "agent_loop: gpt-4o 124 in + 856 out"
    model VARCHAR(50),
    prompt_tokens INTEGER,
    completion_tokens INTEGER,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- 3. Indexes for performance
-- =====================================================
CREATE INDEX IF NOT EXISTS idx_token_transactions_telegram_id ON token_transactions(telegram_id);
CREATE INDEX IF NOT EXISTS idx_token_transactions_created_at ON token_transactions(created_at);
CREATE INDEX IF NOT EXISTS idx_token_transactions_amount ON token_transactions(amount);
CREATE INDEX IF NOT EXISTS idx_users_telegram_id ON users(telegram_id);

-- =====================================================
-- 4. Plans table (for flexibility)
-- =====================================================
CREATE TABLE IF NOT EXISTS billing_plans (
    id SERIAL PRIMARY KEY,
    plan_id VARCHAR(20) UNIQUE NOT NULL,
    name VARCHAR(50) NOT NULL,
    monthly_price_rub INTEGER NOT NULL,
    monthly_included_tokens BIGINT NOT NULL,
    overage_rate_per_million INTEGER NOT NULL,  -- rubles per 1M tokens
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- 5. Seed default plans
-- =====================================================
INSERT INTO billing_plans (plan_id, name, monthly_price_rub, monthly_included_tokens, overage_rate_per_million) VALUES
('free', 'Free', 0, 100000, 30),
('basic', 'Basic', 490, 1000000, 30),
('business', 'Business', 990, 3000000, 25),
('profi', 'Profi', 2900, 15000000, 20)
ON CONFLICT (plan_id) DO UPDATE SET
    name = EXCLUDED.name,
    monthly_price_rub = EXCLUDED.monthly_price_rub,
    monthly_included_tokens = EXCLUDED.monthly_included_tokens,
    overage_rate_per_million = EXCLUDED.overage_rate_per_million,
    updated_at = NOW();

-- =====================================================
-- 6. Initialize existing users with default free plan
-- =====================================================
-- Set default free tokens for users who don't have billing info yet
UPDATE users
SET 
    balance_tokens = COALESCE(balance_tokens, 100000),
    monthly_included_tokens = COALESCE(monthly_included_tokens, 100000),
    plan_id = COALESCE(plan_id, 'free'),
    next_reset_date = COALESCE(next_reset_date, CURRENT_DATE + INTERVAL '1 month')
WHERE plan_id IS NULL;

-- =====================================================
-- Migration complete
-- =====================================================
