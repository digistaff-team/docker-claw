const fetch = require('node-fetch');

const BALANCE_API_ENDPOINT = 'https://eu1.account.dialog.ai.atiks.org/get_user_balance';

/**
 * Проверить баланс пользователя
 * @param {string} email - email пользователя
 * @returns {Promise<{balance: number, expired: string|null, valid: boolean}>}
 */
async function checkUserBalance(email) {
    if (!email) {
        return { balance: 0, expired: null, valid: false, error: 'Email не указан' };
    }

    try {
        const response = await fetch(BALANCE_API_ENDPOINT, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ email })
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errText}`);
        }

        const reply = await response.json();
        
        // Проверяем баланс и срок действия
        const balance = parseFloat(reply.result) || 0;
        const expired = reply.expired || null;
        
        // Проверяем, не истёк ли срок
        let isExpired = false;
        if (expired) {
            const expiredDate = new Date(expired);
            const now = new Date();
            isExpired = expiredDate < now;
        }
        
        const valid = balance >= 0 && !isExpired;
        
        console.log('[BALANCE-CHECK]', email, {
            balance,
            expired,
            isExpired,
            valid
        });
        
        return {
            balance,
            expired,
            valid,
            isExpired
        };
    } catch (error) {
        console.error('[BALANCE-CHECK-ERROR]', email, error.message);
        // При ошибке API считаем баланс валидным, чтобы не блокировать пользователя
        return { 
            balance: 0, 
            expired: null, 
            valid: true, 
            error: error.message 
        };
    }
}

/**
 * Проверить, может ли пользователь использовать AI
 * @param {string} email - email пользователя
 * @returns {Promise<{canUse: boolean, balance: number, expired: string|null, reason: string}>}
 */
async function checkAICanUse(email) {
    const result = await checkUserBalance(email);
    
    if (result.error && !result.valid) {
        return {
            canUse: false,
            balance: result.balance,
            expired: result.expired,
            reason: 'Ошибка проверки баланса: ' + result.error
        };
    }
    
    if (result.balance < 0) {
        return {
            canUse: false,
            balance: result.balance,
            expired: result.expired,
            reason: 'Баланс отрицательный. Продлите Ваш тариф.'
        };
    }
    
    if (result.isExpired) {
        return {
            canUse: false,
            balance: result.balance,
            expired: result.expired,
            reason: 'Срок действия тарифа истёк. Продлите Ваш тариф.'
        };
    }
    
    return {
        canUse: true,
        balance: result.balance,
        expired: result.expired,
        reason: null
    };
}

module.exports = {
    checkUserBalance,
    checkAICanUse
};
