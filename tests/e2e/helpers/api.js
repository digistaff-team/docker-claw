const { mockResponses, apiPatterns } = require('../fixtures/testData');

const IS_MOCK = process.env.E2E_MODE !== 'real';

/**
 * Mock HTTP route with pattern matching
 * @param {import('@playwright/test').Page} page
 * @param {string} pattern URL pattern (glob)
 * @param {object|Function} response mock response object or function
 * @param {string} [method] HTTP method
 */
async function mockRoute(page, pattern, response, method) {
  if (!IS_MOCK) return;

  await page.route(pattern, async (route, request) => {
    if (method && request.method() !== method) {
      return route.continue();
    }

    if (typeof response === 'function') {
      return response(route, request);
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(response),
    });
  });
}

/**
 * Setup all common mocks for test pages
 * @param {import('@playwright/test').Page} page
 * @param {object} options
 * @param {'pending'|'done'} [options.setupStatus='done'] onboarding status
 * @param {boolean} [options.vkConnected=false] is VK connected
 */
async function setupMocks(page, options = {}) {
  if (!IS_MOCK) return;

  const { setupStatus = 'done', vkConnected = false } = options;

  // Auth routes

  await mockRoute(
    page,
    apiPatterns.authTelegramWebLogin,
    mockResponses.authTelegramWebLogin,
    'GET'
  );

  await mockRoute(
    page,
    apiPatterns.authCheck,
    mockResponses.authCheck,
    'GET'
  );

  await mockRoute(page, apiPatterns.authCreateSession, { success: true }, 'POST');

  await mockRoute(
    page,
    apiPatterns.sessionInitStatus,
    mockResponses.sessionInitStatus,
    'GET'
  );

  // Onboarding routes

  await mockRoute(
    page,
    apiPatterns.setupStatus,
    setupStatus === 'pending'
      ? mockResponses.setupStatusPending
      : mockResponses.setupStatusDone,
    'GET'
  );

  await mockRoute(
    page,
    apiPatterns.setupStatus,
    mockResponses.setupSave,
    'POST'
  );

  await mockRoute(
    page,
    apiPatterns.cwBotInfo,
    mockResponses.cwBotInfo,
    'GET'
  );

  await mockRoute(
    page,
    apiPatterns.telegramVerify,
    mockResponses.telegramVerify,
    'POST'
  );

  // Channel routes

  await mockRoute(
    page,
    apiPatterns.enabledChannels,
    vkConnected
      ? mockResponses.enabledChannelsWithVk
      : mockResponses.enabledChannels
  );

  await mockRoute(
    page,
    apiPatterns.contentSettings,
    mockResponses.contentSettings
  );

  await mockRoute(
    page,
    apiPatterns.adminCheckAuth,
    mockResponses.adminCheckAuth,
    'GET'
  );

  await mockRoute(
    page,
    apiPatterns.vkChannel,
    vkConnected ? mockResponses.vkConnected : mockResponses.vkNotConnected,
    'GET'
  );

  await mockRoute(
    page,
    apiPatterns.vkChannel,
    mockResponses.saveVkToken,
    'POST'
  );

  await mockRoute(
    page,
    apiPatterns.vkChannel,
    { success: true },
    'DELETE'
  );

  // Content routes

  await mockRoute(
    page,
    apiPatterns.contentRunNow,
    mockResponses.runNow,
    'POST'
  );
}

module.exports = { mockRoute, setupMocks, IS_MOCK };
