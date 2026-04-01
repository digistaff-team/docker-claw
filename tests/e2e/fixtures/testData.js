const { TEST_CHAT_ID, TEST_TELEGRAM_ID } = require('./constants');

module.exports = {
  mockResponses: {
    authTelegramWebLogin: {
      success: true,
      chatId: TEST_CHAT_ID,
      telegramId: TEST_TELEGRAM_ID,
    },

    authCheck: {
      authorized: true,
      chatId: TEST_CHAT_ID,
    },

    sessionInitStatus: {
      status: 'ready',
    },

    setupStatusPending: {
      onboardingComplete: false,
    },

    setupStatusDone: {
      onboardingComplete: true,
    },

    cwBotInfo: {
      username: 'testcwbot',
    },

    telegramVerify: {
      success: true,
    },

    setupSave: {
      success: true,
    },

    enabledChannels: {
      channels: ['telegram'],
    },

    enabledChannelsWithVk: {
      channels: ['telegram', 'vk'],
    },

    contentSettings: {
      settings: {
        channelId: '',
        moderatorUserId: TEST_CHAT_ID,
        scheduleTime: '09:00',
        scheduleTz: 'Europe/Moscow',
        dailyLimit: 5,
        publishIntervalHours: 24,
        randomPublish: false,
        premoderationEnabled: true,
        allowedWeekdays: [1, 2, 3, 4, 5],
      },
    },

    adminCheckAuth: {
      isAdmin: false,
    },

    vkNotConnected: {
      connected: false,
    },

    vkConnected: {
      connected: true,
      config: {
        group_id: '987654321',
        service_key: 'mock_vk_service_key_test',
      },
      settings: {
        schedule_time: '10:00',
        daily_limit: 3,
        premoderation_enabled: true,
        allowed_weekdays: [1, 2, 3, 4, 5],
        publish_interval_hours: 24,
      },
    },

    saveVkToken: {
      success: true,
    },

    runNow: {
      success: true,
      jobId: 42,
      message: 'Задача генерации контента запущена',
    },
  },

  apiPatterns: {
    authTelegramWebLogin: '**/api/auth/telegram-web-login**',
    authCheck: '**/api/auth/check**',
    authCreateSession: '**/api/auth/create-session',
    sessionInitStatus: '**/api/session/init-status/**',
    setupStatus: '**/api/manage/setup**',
    cwBotInfo: '**/api/manage/cw-bot-info**',
    telegramVerify: '**/api/manage/telegram/verify',
    enabledChannels: '**/api/manage/enabled-channels**',
    contentSettings: '**/api/manage/content/settings**',
    adminCheckAuth: '**/api/admin/check-auth**',
    vkChannel: '**/api/manage/channels/vk**',
    contentRunNow: '**/api/content/run-now',
  },
};
