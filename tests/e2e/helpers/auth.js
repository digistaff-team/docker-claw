const { TEST_TOKEN, TEST_CHAT_ID, TEST_TELEGRAM_ID, SEL, TIMEOUT_REDIRECT } = require('../fixtures/constants');

/**
 * Login via tg_login_token URL parameter
 * @param {import('@playwright/test').Page} page
 * @param {object} [options]
 * @param {boolean} [options.expectRedirectToSetup] expect redirect to setup
 */
async function loginWithToken(page, options = {}) {
  const { expectRedirectToSetup = false } = options;

  await page.goto(`/auth.html?tg_login_token=${TEST_TOKEN}`);

  if (expectRedirectToSetup) {
    await page.waitForURL('**/setup.html', { timeout: TIMEOUT_REDIRECT });
  } else {
    await page.waitForSelector(SEL.MAIN_CONTENT, { state: 'visible' });
  }
}

/**
 * Set auth in localStorage directly (faster, no auth flow)
 * @param {import('@playwright/test').Page} page
 */
async function setAuthInLocalStorage(page, chatId = TEST_CHAT_ID, telegramId = TEST_TELEGRAM_ID) {
  await page.goto('/');
  await page.evaluate(([cId, tId]) => {
    localStorage.setItem('chatId', cId);
    localStorage.setItem('telegramId', tId);
  }, [chatId, telegramId]);
}

module.exports = { loginWithToken, setAuthInLocalStorage };
