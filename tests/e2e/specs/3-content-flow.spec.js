const { test, expect } = require('@playwright/test');
const { setupMocks } = require('../helpers/api');
const { setAuthInLocalStorage } = require('../helpers/auth');
const { navigateToChannels } = require('../helpers/channels');
const { SEL, TEST_CHAT_ID } = require('../fixtures/constants');
const { apiPatterns, mockResponses } = require('../fixtures/testData');

test.describe('Генерация контента', () => {

  test.beforeEach(async ({ page }) => {
    await setupMocks(page, { setupStatus: 'done' });
    await setAuthInLocalStorage(page);
    await navigateToChannels(page);
    await expect(page.locator(SEL.CHANNEL_PANEL('telegram'))).toBeVisible();
  });

  test('Telegram панель содержит Channel ID и Moderator User ID', async ({ page }) => {
    await expect(page.locator(SEL.CONTENT_CHANNEL_ID)).toBeVisible();
    await expect(page.locator(SEL.CONTENT_MODERATOR_ID)).toBeVisible();
  });

  test('Moderator User ID заполнен chatId из loadContentSettings', async ({ page }) => {
    const moderatorInput = page.locator(SEL.CONTENT_MODERATOR_ID);
    await expect(moderatorInput).toHaveValue(TEST_CHAT_ID, { timeout: 5_000 });
  });

  test('кнопка "Сгенерировать сейчас" видна и активна', async ({ page }) => {
    const runBtn = page.locator(SEL.TELEGRAM_RUN_NOW_BTN);
    await expect(runBtn).toBeVisible();
    await expect(runBtn).toBeEnabled();
  });

  test('нажатие "Сгенерировать сейчас" делает POST запрос и показывает toast', async ({ page }) => {
    let capturedRequest = null;
    await page.route(apiPatterns.contentRunNow, async (route, request) => {
      capturedRequest = request;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockResponses.runNow),
      });
    });

    await page.click(SEL.TELEGRAM_RUN_NOW_BTN);

    await expect(page.locator('.toast')).toBeVisible({ timeout: 5_000 });

    expect(capturedRequest).not.toBeNull();
    expect(capturedRequest.method()).toBe('POST');
  });

  test('во время запроса кнопка disabled и показывает "⏳ Генерация..."', async ({ page }) => {
    await page.route(apiPatterns.contentRunNow, async (route) => {
      await new Promise(resolve => setTimeout(resolve, 800));
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockResponses.runNow),
      });
    });

    const runBtn = page.locator(SEL.TELEGRAM_RUN_NOW_BTN);

    await page.click(SEL.TELEGRAM_RUN_NOW_BTN);
    await expect(runBtn).toBeDisabled();
    await expect(runBtn).toContainText('Генерация');

    await expect(runBtn).toBeEnabled({ timeout: 5_000 });
    await expect(runBtn).toContainText('Сгенерировать');
  });

  test('toast исчезает через 3 секунды', async ({ page }) => {
    await page.click(SEL.TELEGRAM_RUN_NOW_BTN);
    const toast = page.locator('.toast');
    await expect(toast).toBeVisible({ timeout: 3_000 });
    await expect(toast).toBeHidden({ timeout: 5_000 });
  });

});
