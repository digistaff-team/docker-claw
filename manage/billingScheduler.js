/**
 * Monthly Token Reset Scheduler
 * 
 * Automatically resets token balances for all users on the 1st of each month
 * based on their plan's monthly_included_tokens.
 */

const TokenBilling = require('./tokenBilling');

let scheduledTimeout = null;

/**
 * Schedule the monthly reset job
 * Runs on the 1st of each month at 00:00
 */
function scheduleMonthlyReset() {
    const now = new Date();
    
    // Calculate next 1st of month
    const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1, 0, 0, 0, 0);
    const delay = nextMonth.getTime() - now.getTime();
    
    const hoursUntil = Math.round(delay / 1000 / 60 / 60);
    console.log(`[BILLING-SCHEDULER] Next monthly reset scheduled in ${hoursUntil} hours (${nextMonth.toISOString()})`);
    
    // Clear any existing timeout
    if (scheduledTimeout) {
        clearTimeout(scheduledTimeout);
    }
    
    scheduledTimeout = setTimeout(async () => {
        try {
            console.log('[BILLING-SCHEDULER] Running monthly reset...');
            const updatedCount = await TokenBilling.monthlyReset();
            console.log(`[BILLING-SCHEDULER] Monthly reset completed: ${updatedCount} users updated`);
        } catch (error) {
            console.error('[BILLING-SCHEDULER] Monthly reset failed:', error);
        } finally {
            // Schedule next month
            scheduleMonthlyReset();
        }
    }, delay);
}

/**
 * Initialize the monthly reset scheduler
 * Call this on server startup
 */
function initMonthlyResetScheduler() {
    if (!TokenBilling.isBillingEnabled()) {
        console.log('[BILLING-SCHEDULER] Billing is disabled, scheduler not started');
        return;
    }
    
    console.log('[BILLING-SCHEDULER] Initializing monthly reset scheduler...');
    scheduleMonthlyReset();
}

/**
 * Stop the scheduler
 * Call this on server shutdown
 */
function stopMonthlyResetScheduler() {
    if (scheduledTimeout) {
        clearTimeout(scheduledTimeout);
        scheduledTimeout = null;
        console.log('[BILLING-SCHEDULER] Scheduler stopped');
    }
}

/**
 * Manually trigger monthly reset (for testing/admin use)
 * @returns {Promise<number>} Number of users updated
 */
async function triggerMonthlyReset() {
    console.log('[BILLING-SCHEDULER] Manual monthly reset triggered');
    const updatedCount = await TokenBilling.monthlyReset();
    // Reschedule after manual trigger
    scheduleMonthlyReset();
    return updatedCount;
}

module.exports = {
    initMonthlyResetScheduler,
    stopMonthlyResetScheduler,
    triggerMonthlyReset
};
