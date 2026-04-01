const { test, expect } = require('@playwright/test');
const { setupMocks } = require('../helpers/api');
const { setAuthInLocalStorage } = require('../helpers/auth');
const { navigateToChannels, switchToChannelTab, connectVkChannel } = require('../helpers/channels');
const { SEL } = require('../fixtures/constants');
const { apiPatterns, mockResponses } = require('../fixtures/testData');

test.describe('Каналы', () => {

  test.beforeEach(async ({ page }) => {
    await setupMocks(page, { setupStatus: 'done', vkConnected: false });
    await setAuthInLocalStorage(page);
    await navigateToChannels(page);
  });

  test('страница загружается и Telegram таб виден', async ({ page }) => {
    const telegramTab = page.locator(SEL.CHANNEL_TAB('telegram'));
    await expect(telegramTab).toBeVisible();
  });

  test('Telegram панель видна после загрузки', async ({ page }) => {
    await expect(page.locator(SEL.CHANNEL_PANEL('telegram'))).toBeVisible();
  });

  test('переключение на VK таб (если VK включён) показывает VK панель', async ({ page }) => {
    await page.unroute(apiPatterns.enabledChannels);
    await page.route(apiPatterns.enabledChannels, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockResponses.enabledChannelsWithVk),
      });
    });

    await navigateToChannels(page);
    await switchToChannelTab(page, 'vk');
    await expect(page.locator(SEL.CHANNEL_PANEL('vk'))).toBeVisible();
  });

  test('VK панель содержит форму ввода Group ID и Service Key', async ({ page }) => {
    await page.unroute(apiPatterns.enabledChannels);
    await page.route(apiPatterns.enabledChannels, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockResponses.enabledChannelsWithVk),
      });
    });

    await navigateToChannels(page);
    await switchToChannelTab(page, 'vk');

    await expect(page.locator(SEL.VK_GROUP_ID)).toBeVisible();
    await expect(page.locator(SEL.VK_SERVICE_KEY)).toBeVisible();
  });

  test('сохранение VK токена отображает статус подключения', async ({ page }) => {
    await page.unroute(apiPatterns.enabledChannels);
    await page.unroute(apiPatterns.vkChannel);

    let vkConnected = false;
    await page.route(apiPatterns.enabledChannels, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockResponses.enabledChannelsWithVk),
      });
    });

    await page.route(apiPatterns.vkChannel, async (route, request) => {
      if (request.method() === 'POST') {
        vkConnected = true;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(mockResponses.saveVkToken),
        });
      } else if (request.method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(
            vkConnected ? mockResponses.vkConnected : mockResponses.vkNotConnected
          ),
        });
      } else {
        await route.continue();
      }
    });

    await navigateToChannels(page);
    await switchToChannelTab(page, 'vk');
    await connectVkChannel(page, expect);

    await expect(page.locator(SEL.VK_SETTINGS_BLOCK)).toBeVisible({ timeout: 5_000 });
  });

  test('кнопка "+" открывает channelPickerOverlay', async ({ page }) => {
    await page.click(SEL.ADD_CHANNEL_BTN);
    await expect(page.locator(SEL.CHANNEL_PICKER_OVERLAY)).toBeVisible();
  });

  test('закрытие channelPickerOverlay по клику на оверлей', async ({ page }) => {
    await page.click(SEL.ADD_CHANNEL_BTN);
    await expect(page.locator(SEL.CHANNEL_PICKER_OVERLAY)).toBeVisible();

    await page.locator(SEL.CHANNEL_PICKER_OVERLAY).click({ position: { x: 5, y: 5 } });
    await expect(page.locator(SEL.CHANNEL_PICKER_OVERLAY)).toBeHidden();
  });

});
