const { test, expect } = require('@playwright/test');
const { setupMocks } = require('../helpers/api');
const { loginWithToken, setAuthInLocalStorage } = require('../helpers/auth');
const {
  interceptWindowOpen,
  clickConnectBotAndVerify,
  verifyCode,
  completeOnboarding,
} = require('../helpers/setup');
const { SEL } = require('../fixtures/constants');

test.describe('Онбординг', () => {

  test.beforeEach(async ({ page }) => {
    await interceptWindowOpen(page);
  });

  test('tg_login_token редиректит на setup.html если onboarding не завершён', async ({ page }) => {
    await setupMocks(page, { setupStatus: 'pending' });
    await loginWithToken(page, { expectRedirectToSetup: true });
    await expect(page).toHaveURL(/\/setup\.html/);
    await expect(page.locator(SEL.MAIN_CONTENT)).toBeVisible();
  });

  test('tg_login_token не редиректит если onboarding завершён', async ({ page }) => {
    await setupMocks(page, { setupStatus: 'done' });
    await loginWithToken(page);
    await expect(page.locator(SEL.MAIN_CONTENT)).toBeVisible();
  });

  test('connectBotBtn открывает t.me URL через window.open', async ({ page }) => {
    await setupMocks(page, { setupStatus: 'pending' });
    await loginWithToken(page, { expectRedirectToSetup: true });
    await clickConnectBotAndVerify(page, expect);
  });

  test('верный код активирует кнопку "Сохранить и продолжить"', async ({ page }) => {
    await setupMocks(page, { setupStatus: 'pending' });
    await loginWithToken(page, { expectRedirectToSetup: true });

    await expect(page.locator(SEL.SAVE_BTN)).toBeDisabled();
    await verifyCode(page);
    await expect(page.locator(SEL.SAVE_BTN)).toBeEnabled();
    await expect(page.locator(`${SEL.VERIFY_STATUS}:has-text("✅")`)).toBeVisible();
  });

  test('выбор дополнительного канала не ломает активацию saveBtn', async ({ page }) => {
    await setupMocks(page, { setupStatus: 'pending' });
    await loginWithToken(page, { expectRedirectToSetup: true });

    await verifyCode(page);
    await page.check(SEL.CH_VK);
    await expect(page.locator(SEL.CH_VK)).toBeChecked();
    await expect(page.locator(SEL.SAVE_BTN)).toBeEnabled();
  });

  test('сохранение онбординга редиректит на channels.html', async ({ page }) => {
    await setupMocks(page, { setupStatus: 'pending' });
    await loginWithToken(page, { expectRedirectToSetup: true });
    await completeOnboarding(page, expect);
    await expect(page).toHaveURL(/\/channels\.html/);
  });

  test('Telegram checkbox всегда checked и disabled', async ({ page }) => {
    await setupMocks(page, { setupStatus: 'pending' });
    await loginWithToken(page, { expectRedirectToSetup: true });

    const tgCheckbox = page.locator(SEL.CH_TELEGRAM);
    await expect(tgCheckbox).toBeChecked();
    await expect(tgCheckbox).toBeDisabled();
  });

});
