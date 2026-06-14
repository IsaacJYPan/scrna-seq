const { chromium } = require('playwright');
const { exec } = require('child_process');

(async () => {
  const viteProcess = exec('npx vite');
  await new Promise(r => setTimeout(r, 4000));

  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on('console', msg => console.log('BROWSER CONSOLE:', msg.text()));
  page.on('pageerror', err => console.log('BROWSER ERROR:', err.message));
  await page.goto('http://localhost:5173');
  await page.waitForTimeout(2000);
  
  // Click Lineage tab
  const tabs = await page.$$('button');
  for(let t of tabs) {
    const text = await t.textContent();
    if (text && text.includes('Lineage')) {
      await t.click();
      break;
    }
  }
  
  await page.waitForTimeout(3000);
  await browser.close();
  viteProcess.kill();
  process.exit(0);
})();
