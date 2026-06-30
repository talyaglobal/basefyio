import { defineConfig, devices } from '@playwright/test';

/**
 * Runs against a configurable BASE_URL (a local stack or a deployed environment).
 *   BASE_URL=https://app.basefyio.com npm test
 * Defaults to the local Admin UI.
 */
export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.BASE_URL || 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
