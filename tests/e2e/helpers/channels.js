const { SEL, TEST_VK_GROUP_ID, TEST_VK_SERVICE_KEY } = require('../fixtures/constants');

/**
 * Navigate to channels.html and wait for tabs to load
 * @param {import('@playwright/test').Page} page
 */
async function navigateToChannels(page) {
  await page.goto('/channels.html');
  await page.waitForSelector('.channel-tab:not([style*="display: none"])', {
    state: 'visible',
    timeout: 8_000,
  });
}

/**
 * Switch to channel tab and wait for panel to show
 * @param {import('@playwright/test').Page} page
 * @param {string} channelName channel name
 */
async function switchToChannelTab(page, channelName) {
  await page.click(SEL.CHANNEL_TAB(channelName));
  await page.waitForSelector(SEL.CHANNEL_PANEL(channelName), { state: 'visible' });
}

/**
 * Fill VK form and save token
 * @param {import('@playwright/test').Page} page
 * @param {import('@playwright/test').Expect} expect
 */
async function connectVkChannel(page, expect, options = {}) {
  const {
    groupId = TEST_VK_GROUP_ID,
    serviceKey = TEST_VK_SERVICE_KEY,
  } = options;

  await page.fill(SEL.VK_GROUP_ID, groupId);
  await page.fill(SEL.VK_SERVICE_KEY, serviceKey);
  await page.click('button:has-text("Сохранить токен")');

  await page.waitForSelector('.toast:has-text("VK подключён")', { state: 'visible', timeout: 5_000 });
}

module.exports = { navigateToChannels, switchToChannelTab, connectVkChannel };
