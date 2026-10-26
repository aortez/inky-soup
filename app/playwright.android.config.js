import {defineConfig} from '@playwright/test';

export default defineConfig({
  outputDir: 'test-results/android-web',
  testDir: './tests', testMatch: ['android-shell.spec.js', 'android-setup.spec.js', 'android-reconnect.spec.js'], timeout: 60000,
  workers: 2, reporter: 'list',
  use: {baseURL: 'http://127.0.0.1:4174', viewport: {width: 390, height: 844}},
  webServer: {
    command: 'npm run preview -- --outDir dist-android --host 127.0.0.1 --port 4174 --strictPort',
    url: 'http://127.0.0.1:4174', reuseExistingServer: false,
  },
});
