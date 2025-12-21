import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration for Inky Soup e2e tests.
 * @see https://playwright.dev/docs/test-configuration
 */
export default defineConfig({
  testDir: './e2e',

  // Run tests in parallel.
  fullyParallel: true,

  // Fail the build on CI if you accidentally left test.only in the source code.
  forbidOnly: !!process.env.CI,

  // Retry on CI only.
  retries: process.env.CI ? 2 : 0,

  // Limit parallel workers on CI.
  workers: process.env.CI ? 1 : undefined,

  // Reporter to use.
  reporter: 'html',

  // Shared settings for all projects.
  use: {
    // Base URL for navigation actions like `await page.goto('/')`.
    baseURL: 'http://localhost:8000',

    // Collect trace when retrying the failed test.
    trace: 'on-first-retry',

    // Capture screenshot on failure.
    screenshot: 'only-on-failure',

    // Default timeout for each action (2 seconds for fast failure).
    actionTimeout: 2000,
  },

  // Global test timeout (30 seconds for entire test).
  timeout: 30000,

  // Configure projects for major browsers.
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    // Uncomment to test on more browsers:
    // {
    //   name: 'firefox',
    //   use: { ...devices['Desktop Firefox'] },
    // },
    // {
    //   name: 'webkit',
    //   use: { ...devices['Desktop Safari'] },
    // },
  ],

  // Run local dev server before starting the tests.
  webServer: {
    command: 'RUST_LOG=debug LOCK_DURATION_SECS=3 cargo run 2>&1 | tee /tmp/e2e-server.log',
    url: 'http://localhost:8000',
    reuseExistingServer: false, // Always start fresh for clean test environment.
    timeout: 120 * 1000, // Cargo build can be slow.
  },
});
