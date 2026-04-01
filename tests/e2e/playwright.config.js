const { defineConfig, devices } = require('@playwright/test');

const isMockMode = process.env.E2E_MODE !== 'real';
const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:3015';

module.exports = defineConfig({
  testDir: './specs',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: '../../playwright-report' }],
  ],
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
  },
  projects: [
    {
      name: isMockMode ? 'mock' : 'real',
      use: {
        ...devices['Desktop Chrome'],
        storageState: undefined,
      },
    },
  ],
  webServer: !isMockMode
    ? {
        command: 'node server.js',
        url: BASE_URL,
        reuseExistingServer: !process.env.CI,
        timeout: 30_000,
        cwd: require('path').resolve(__dirname, '../..'),
      }
    : undefined,
});
