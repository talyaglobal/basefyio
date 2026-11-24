import { defineConfig, devices } from '@playwright/test';

/**
 * Runs against a configurable base URL (a local stack or a deployed environment):
 *
 *   E2E_BASE_URL=https://app.basefyio.com E2E_EMAIL=… E2E_PASSWORD=… npm test
 *
 * Two projects:
 * - `public` — pages that need no account (the login page, the redirect of
 *   /dashboard). Always runs.
 * - `authenticated` — the route inventory, the critical flows and the
 *   screenshot sweep, signed in as the e2e account that global-setup.ts
 *   creates a storage state for. Skipped when E2E_EMAIL / E2E_PASSWORD are
 *   unset, so the suite stays green on a machine without credentials.
 *
 * - `tours` — the guided-tours spec; needs its own account, see tests/tours.spec.ts.
 *
 * Tags: @critical (must stay green before any PR merges), @gated (needs an
 * explicit opt-in: creates data or takes minutes), @screenshots (SCREENSHOTS=1).
 */
export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  globalSetup: require.resolve('./global-setup'),
  use: {
    baseURL: process.env.E2E_BASE_URL || process.env.BASE_URL || 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    viewport: { width: 1280, height: 800 },
  },
  projects: [
    {
      name: 'public',
      testMatch: /smoke\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'authenticated',
      testMatch: /(routes|critical|screenshots|responsive)\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], storageState: '.auth/state.json' },
    },
    {
      // Guided tours: a dedicated account (E2E_TOURS_EMAIL / E2E_TOURS_PASSWORD) that signs
      // in inside the spec itself, so it never uses the shared storage state. Skips itself
      // without the account or without the guided_tours flag.
      name: 'tours',
      testMatch: /tours\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
