const { SEL, TEST_VERIFY_CODE, TIMEOUT_ANIMATION } = require('../fixtures/constants');

/**
 * Intercept window.open() to prevent opening external tabs
 * @param {import('@playwright/test').Page} page
 */
async function interceptWindowOpen(page) {
  await page.addInitScript(() => {
    const calls = [];
    window._windowOpenCalls = calls;
    window.open = (url, target) => {
      calls.push({ url, target });
      return {
        closed: false,
        close: () => {},
        focus: () => {},
      };
    };
  });
}

/**
 * Click connectBotBtn and verify window.open was called with t.me URL
 * @param {import('@playwright/test').Page} page
 * @param {import('@playwright/test').Expect} expect
 */
async function clickConnectBotAndVerify(page, expect) {
  await page.click(SEL.CONNECT_BOT_BTN);
  await page.waitForTimeout(TIMEOUT_ANIMATION);
  const openCalls = await page.evaluate(() => window._windowOpenCalls);
  expect(openCalls.length).toBeGreaterThanOrEqual(1);
  expect(openCalls[0].url).toContain('t.me/');
}

/**
 * Enter verification code and click submit
 * @param {import('@playwright/test').Page} page
 * @param {string} [code] verification code
 */
async function verifyCode(page, code = TEST_VERIFY_CODE) {
  await page.fill(SEL.VERIFY_CODE_INPUT, code);
  await page.click(SEL.VERIFY_CODE_BTN);
  await page.waitForSelector(`${SEL.VERIFY_STATUS}:has-text("✅")`, {
    state: 'visible',
  });
}

/**
 * Complete full onboarding flow: verify code + save
 * @param {import('@playwright/test').Page} page
 * @param {import('@playwright/test').Expect} expect
 */
async function completeOnboarding(page, expect) {
  await verifyCode(page);
  await expect(page.locator(SEL.SAVE_BTN)).toBeEnabled();
  await page.click(SEL.SAVE_BTN);
  await page.waitForURL('**/channels.html', { timeout: 5_000 });
}

module.exports = { interceptWindowOpen, clickConnectBotAndVerify, verifyCode, completeOnboarding };
