const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: '../scripts',
  testMatch: '**/test_visual_ux.js',

  fullyParallel: false,
  retries: 0,
  workers: 1,

  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright/report', open: 'never' }],
  ],

  use: {
    baseURL: 'http://localhost:5173',
    headless: true,
    viewport: { width: 1440, height: 900 },
    snapshotDir: 'playwright/snapshots',
    expect: {
      toHaveScreenshot: {
        maxDiffPixelRatio: 0.001,
        threshold: 0.2,
      },
    },
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    trace: 'retain-on-failure',
  },
});
