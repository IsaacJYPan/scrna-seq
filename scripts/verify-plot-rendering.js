'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');

async function main() {
  const { build, preview } = await import('vite');
  const root = path.resolve(__dirname, '..');
  const scratch = path.join(root, 'scratch');
  await fs.mkdir(scratch, { recursive: true });
  const output = await fs.mkdtemp(path.join(scratch, 'plot-check-'));
  let browser;
  let server;
  try {
    await build({
      root,
      logLevel: 'warn',
      build: {
        outDir: output,
        rollupOptions: {
          input: { PlotlyRenderer: path.join(__dirname, 'fixtures', 'plots.html') },
        },
      },
    });
    server = await preview({
      root,
      build: { outDir: output },
      preview: { host: '127.0.0.1', port: 0, strictPort: false },
    });
    browser = await chromium.launch({
      headless: true,
      args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    });
    const page = await browser.newPage({ viewport: { width: 1320, height: 1080 } });
    page.setDefaultTimeout(60000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    const address = server.httpServer.address();
    await page.goto(`http://127.0.0.1:${address.port}/scripts/fixtures/plots.html`);
    await page.waitForFunction(() => Boolean(window.chartAcceptance));
    const types = await page.evaluate(() => window.chartAcceptance);
    assert.equal(types.length, 8);
    assert.deepEqual(errors, [], 'chart rendering must not log browser errors');
    // Reproduce visiting a chart, leaving its tab, resizing the workspace,
    // and returning without another window resize event.
    await page.evaluate(() => {
      const host = document.getElementById('responsive-chart');
      host.style.display = 'none';
      host.style.width = '260px';
      host.style.height = '420px';
    });
    await page.setViewportSize({ width: 900, height: 1080 });
    await page.evaluate(() => { document.getElementById('responsive-chart').style.display = 'block'; });
    await page.waitForFunction(() => {
      const graph = window.responsiveChart;
      return Math.abs(graph?._fullLayout?.width - 260) < 1
        && Math.abs(graph?._fullLayout?.height - 420) < 1;
    }, null, { timeout: 10000 });
    assert.deepEqual(errors, [], 'restoring a resized hidden chart must not log browser errors');
    await page.evaluate(() => window.unmountResponsiveChart());
    await page.setViewportSize({ width: 1320, height: 1080 });
    const report = path.join(root, 'playwright', 'report');
    await fs.mkdir(report, { recursive: true });
    await page.screenshot({ path: path.join(report, 'scientific-charts.png'), fullPage: true });
    console.log(`Passed production rendering, PNG/SVG export, updates, and hidden-tab resizing: ${types.join(', ')}`);
  } finally {
    await browser?.close();
    if (server) await new Promise((resolve) => server.httpServer.close(resolve));
    const relative = path.relative(scratch, output);
    if (
      !relative.startsWith('..') &&
      !path.isAbsolute(relative) &&
      relative.startsWith('plot-check-')
    ) {
      await fs.rm(output, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
