// playwright/playwright.config.js
// ============================================================
// Playwright configuration for the scRNA-seq Dashboard
// visual/UX automated test suite.
// ============================================================

const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  // Where to find the test files
  testDir: '../scripts',
  testMatch: '**/test_visual_ux.js',

  // Fail fast: don't keep running after first failure
  // (set to 0 to run all tabs regardless)
  fullyParallel: false,
  retries: 0,
  workers: 1,

  // Reporter: pretty terminal + HTML report
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright/report', open: 'never' }],
  ],

  use: {
    baseURL: 'http://localhost:5173',
    headless: true,
    viewport: { width: 1440, height: 900 },
    // Screenshot baseline directory
    snapshotDir: 'playwright/snapshots',
    // Pixel diff threshold: 0.1% of pixels may differ
    expect: {
      toHaveScreenshot: {
        maxDiffPixelRatio: 0.001,
        threshold: 0.2,
      },
    },
    // Capture on failure
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    trace: 'retain-on-failure',
  },
});
