const { test, expect } = require('@playwright/test');
const { setupMocks } = require('../helpers/api');
const { interceptWindowOpen } = require('../helpers/setup');
const { SEL, TEST_TOKEN, TIMEOUT_REDIRECT } = require('../fixtures/constants');

test('critical path: auth -> onboarding -> channels -> content generation', async ({ page }) => {
  await interceptWindowOpen(page);
  await setupMocks(page, { setupStatus: 'pending' });

  // Step 1: Login via Telegram token
  await page.goto(`/auth.html?tg_login_token=${TEST_TOKEN}`);
  await page.waitForURL('**/setup.html', { timeout: TIMEOUT_REDIRECT });

  // Step 2: Onboarding - verify code
  await page.fill(SEL.VERIFY_CODE_INPUT, '123456');
  await page.click(SEL.VERIFY_CODE_BTN);
  await page.waitForSelector(`${SEL.VERIFY_STATUS}:has-text("✅")`);

  // Step 3: Save onboarding settings
  await expect(page.locator(SEL.SAVE_BTN)).toBeEnabled();
  await page.click(SEL.SAVE_BTN);
  await page.waitForURL('**/channels.html', { timeout: 5_000 });

  // Step 4: Verify channels.html loaded
  await page.waitForSelector('.channel-tab:not([style*="display: none"])', { state: 'visible' });
  await expect(page.locator(SEL.CHANNEL_PANEL('telegram'))).toBeVisible();

  // Step 5: Generate content
  await page.click(SEL.TELEGRAM_RUN_NOW_BTN);
  await expect(page.locator('.toast')).toBeVisible({ timeout: 5_000 });
});
