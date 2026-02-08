import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for testing against deployed or Docker server.
 *
 * Usage:
 *   npx playwright test --config=playwright.remote.config.js
 *   REMOTE_URL=http://localhost:8000 npx playwright test --config=playwright.remote.config.js
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: 'line',

  use: {
    // Default to Pi, override with REMOTE_URL for Docker testing.
    baseURL: process.env.REMOTE_URL || 'http://inky-soup.local:8000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    actionTimeout: 5000,
  },

  timeout: 60000,

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  // No webServer - we're hitting an external server.
});
