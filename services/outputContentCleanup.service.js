/**
 * Output/Content Folder Cleanup Scheduler
 *
 * Automatically cleans the /workspace/output/content folder every day at 05:00 Moscow time.
 */

const dockerService = require('./docker.service');
const sessionService = require('./session.service');

let scheduledTimeout = null;

/**
 * Calculate delay until next 05:00 Moscow time
 */
function getNextCleanupTime() {
    const now = new Date();
    // Moscow time is UTC+3
    const moscowOffset = 3 * 60; // minutes
    const utcNow = now.getTime() + now.getTimezoneOffset() * 60000;
    const moscowNow = new Date(utcNow + moscowOffset * 60000);

    // Create target time: today at 05:00 Moscow
    const target = new Date(moscowNow);
    target.setHours(5, 0, 0, 0);

    // If it's already past 05:00 today, schedule for tomorrow
    if (moscowNow >= target) {
        target.setDate(target.getDate() + 1);
    }

    // Convert back to local time for setTimeout
    const targetUtc = target.getTime() - moscowOffset * 60000;
    const targetLocal = new Date(targetUtc - now.getTimezoneOffset() * 60000);

    return targetLocal;
}

/**
 * Clean output/content folder for a specific user
 * @param {string} chatId - User chat ID
 * @returns {Promise<{success: boolean, removed?: number, error?: string}>}
 */
async function cleanOutputContent(chatId) {
    const session = sessionService.getSession(chatId);
    if (!session) {
        return { success: false, error: 'Session not found' };
    }

    try {
        const folderPath = '/workspace/output/content';
        const result = await dockerService.executeInContainer(
            session.containerId,
            `rm -rf ${folderPath}/* 2>/dev/null; rm -rf ${folderPath}/.* 2>/dev/null; mkdir -p ${folderPath}; echo "done"`
        );

        console.log(`[OUTPUT-CLEANUP] ✅ Cleaned /workspace/output/content for chatId=${chatId}`);
        return { success: true };
    } catch (error) {
        console.error(`[OUTPUT-CLEANUP] ❌ Failed for chatId=${chatId}:`, error.message);
        return { success: false, error: error.message };
    }
}

/**
 * Clean output/content for all active users
 * @returns {Promise<{total: number, success: number, failed: number}>}
 */
async function cleanAllUsers() {
    const sessions = sessionService.getAllSessions();
    const results = await Promise.allSettled(
        sessions.map(s => cleanOutputContent(s.chatId))
    );

    const success = results.filter(r => r.status === 'fulfilled' && r.value.success).length;
    const failed = results.length - success;

    console.log(`[OUTPUT-CLEANUP] Completed: ${success} succeeded, ${failed} failed out of ${results.length} users`);
    return { total: results.length, success, failed };
}

/**
 * Schedule the daily cleanup job
 * Runs every day at 05:00 Moscow time
 */
function scheduleDailyCleanup() {
    const nextRun = getNextCleanupTime();
    const delay = nextRun.getTime() - Date.now();

    const hoursUntil = Math.round(delay / 1000 / 60 / 60);
    console.log(`[OUTPUT-CLEANUP] Next cleanup scheduled in ${hoursUntil} hours (${nextRun.toLocaleString()})`);

    // Clear any existing timeout
    if (scheduledTimeout) {
        clearTimeout(scheduledTimeout);
    }

    scheduledTimeout = setTimeout(async () => {
        try {
            console.log('[OUTPUT-CLEANUP] Starting scheduled cleanup of /workspace/output/content...');
            const result = await cleanAllUsers();
            console.log(`[OUTPUT-CLEANUP] Scheduled cleanup completed: ${result.success}/${result.total} users`);
        } catch (error) {
            console.error('[OUTPUT-CLEANUP] Scheduled cleanup failed:', error);
        } finally {
            // Schedule next day
            scheduleDailyCleanup();
        }
    }, delay);
}

/**
 * Initialize the cleanup scheduler
 * Call this on server startup
 */
function initCleanupScheduler() {
    console.log('[OUTPUT-CLEANUP] Initializing daily cleanup scheduler (05:00 Moscow)...');
    scheduleDailyCleanup();
}

/**
 * Stop the scheduler
 * Call this on server shutdown
 */
function stopCleanupScheduler() {
    if (scheduledTimeout) {
        clearTimeout(scheduledTimeout);
        scheduledTimeout = null;
        console.log('[OUTPUT-CLEANUP] Scheduler stopped');
    }
}

/**
 * Manually trigger cleanup (for testing/admin use)
 * @param {string} [chatId] - Optional specific user, if not provided cleans all users
 * @returns {Promise<object>} Result object
 */
async function triggerCleanup(chatId = null) {
    console.log('[OUTPUT-CLEANUP] Manual cleanup triggered');
    if (chatId) {
        const result = await cleanOutputContent(chatId);
        scheduleDailyCleanup(); // Reschedule
        return result;
    } else {
        const result = await cleanAllUsers();
        scheduleDailyCleanup(); // Reschedule
        return result;
    }
}

module.exports = {
    initCleanupScheduler,
    stopCleanupScheduler,
    triggerCleanup,
    cleanOutputContent,
    cleanAllUsers
};
