module.exports = {
  BASE_URL: process.env.E2E_BASE_URL || 'http://localhost:3015',

  TEST_CHAT_ID: 'TEST_CHAT_123',
  TEST_TELEGRAM_ID: 'TEST_TG_456',
  TEST_TOKEN: 'mock-tg-login-token-xyz',
  TEST_VERIFY_CODE: '123456',
  TEST_VK_GROUP_ID: '987654321',
  TEST_VK_SERVICE_KEY: 'mock_vk_service_key_test',

  TIMEOUT_NAVIGATION: 10_000,
  TIMEOUT_ANIMATION: 500,
  TIMEOUT_REDIRECT: 5_000,

  SEL: {
    // auth / common
    AUTH_SECTION: '#authSection',
    MAIN_CONTENT: '#mainContent',
    CHAT_ID_INPUT: '#chatIdInput',
    LOGOUT_BTN: '#logoutButton',

    // setup.html
    CONNECT_BOT_BTN: '#connectBotBtn',
    VERIFY_CODE_INPUT: '#verifyCodeInput',
    VERIFY_CODE_BTN: '#verifyCodeBtn',
    VERIFY_STATUS: '#verifyStatusDiv',
    CH_TELEGRAM: '#ch-telegram',
    CH_VK: '#ch-vk',
    SAVE_BTN: '#saveBtn',
    ERROR_MSG: '#errorMessage',
    SUCCESS_MSG: '#successMessage',

    // channels.html
    CHANNEL_TAB: (name) => `.channel-tab[data-channel="${name}"]`,
    CHANNEL_PANEL: (name) => `#channelPanel-${name}`,
    ADD_CHANNEL_BTN: '#addChannelBtn',
    CHANNEL_PICKER_OVERLAY: '#channelPickerOverlay',
    VK_GROUP_ID: '#vkGroupId',
    VK_SERVICE_KEY: '#vkServiceKey',
    VK_STATUS: '#vkStatus',
    VK_SETTINGS_BLOCK: '#vkSettingsBlock',
    DISCONNECT_VK_BTN: '#disconnectVkBtn',
    CONTENT_CHANNEL_ID: '#contentChannelId',
    CONTENT_MODERATOR_ID: '#contentModeratorUserId',
    TELEGRAM_RUN_NOW_BTN: '#telegramRunNowBtn',
  },
};
