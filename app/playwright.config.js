import {defineConfig} from '@playwright/test';

export default defineConfig({
  outputDir: 'test-results/web',
  testDir: './tests', testIgnore: ['**/frame-pwa.spec.js', '**/android-shell.spec.js', '**/android-setup.spec.js', '**/android-reconnect.spec.js'],
  fullyParallel: true, forbidOnly: !!process.env.CI, retries: process.env.CI ? 2 : 0,
  workers: 2, reporter: 'list',
  use: {baseURL: 'http://127.0.0.1:8080', trace: 'retain-on-failure'},
  webServer: {command: 'npm run dev', url: 'http://127.0.0.1:8080/frame/', reuseExistingServer: false},
});
