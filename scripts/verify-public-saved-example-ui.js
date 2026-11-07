#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { chromium } = require('playwright');
const { Client } = require('pg');
const { createDesktopTunnelServiceFixture } = require('./desktop-tunnel-service-fixture.cjs');
const root = path.resolve(__dirname, '..');
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const route = '#/examples/qc-retention/v1';
const sourceText = 'sample,input_cells,retained_cells\nSample A,1000,850\nSample B,1200,900\nSample C,800,720\n';
const isApiPath = pathname => /(?:^|\/)api(?:\/|$)/.test(pathname);
const main = page => page.getByRole('main', { name: 'Public saved example', exact: true });
async function until(test, message) {
  const end = Date.now() + 30000;
  while (Date.now() < end) { if (await test()) return; await new Promise(resolve => setTimeout(resolve, 60)); }
  throw new Error(message);
}

async function run() {
  const directory = path.join(root, 'playwright/report/public-saved-example-' + Date.now()); fs.mkdirSync(directory, { recursive: true });
  const frozen = new Map(fs.readdirSync(path.join(root, 'dist/assets')).map(file => [file, sha(fs.readFileSync(path.join(root, 'dist/assets', file)))]));
  const checks = [], screenshots = [], profiles = [], requests = [], assets = {}, assetReads = [], browserErrors = [], consoleErrors = [], httpFailures = [], faults = [];
  let service, browser, staticServer, database, activePage;
  const check = value => { checks.push(value); console.log('PASS: ' + value); };
  const readCounts = async () => (await database.query(`SELECT
    (SELECT count(*)::int FROM jobs) AS jobs,
    (SELECT count(*)::int FROM private_r_kernels) AS kernels,
    (SELECT count(*)::int FROM private_r_executions) AS executions`)).rows[0];
  function watch(page, label, { forbidApi = false } = {}) {
    activePage = page;
    page.on('pageerror', error => browserErrors.push({ label, message: error.message }));
    page.on('console', value => { if (value.type() === 'error') consoleErrors.push({ label, text: value.text(), url: value.location().url }); });
    page.on('request', request => {
      const url = new URL(request.url());
      requests.push({ label, method: request.method(), pathname: url.pathname, isApi: isApiPath(url.pathname), forbidApi });
    });
    page.on('response', response => {
      const pathname = new URL(response.url()).pathname;
      if (!response.ok()) httpFailures.push({ label, pathname, status: response.status() });
      if (!response.ok() || !pathname.includes('/assets/') || !pathname.endsWith('.js')) return;
      assetReads.push((async () => {
        const file = pathname.split('/').at(-1), value = sha(await response.body());
        assert(frozen.get(file) === value, 'A served production script differs from the frozen public-example build.'); assets['/assets/' + file] = value;
      })().catch(error => browserErrors.push({ label, message: error.message })));
    });
    return page;
  }
  async function blockApi(page) { await page.route('**/api/**', intercepted => intercepted.abort()); }
  async function capture(page, name) {
    await page.waitForTimeout(180);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'The public example caused whole-page horizontal overflow.');
    await page.screenshot({ path: path.join(directory, name + '.png'), fullPage: true }); screenshots.push(name + '.png');
    profiles.push({ filename: name + '.png', viewport: page.viewportSize(), theme: await page.evaluate(() => document.documentElement.dataset.theme || 'light') });
  }
  async function matrix(page, name, focus) {
    for (const [width, height] of [[1366, 768], [1440, 900], [390, 844]]) {
      await page.setViewportSize({ width, height });
      for (const theme of ['light', 'dark']) {
        const actual = await page.evaluate(() => document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
        if (actual !== theme) await page.getByRole('button', { name: `Switch to ${theme} mode`, exact: true }).click();
        if (focus) await focus(); await capture(page, `${name}-${theme}-${width}`);
      }
    }
  }
  async function tableReady(page) {
    await main(page).getByRole('heading', { level: 1, name: 'Synthetic QC retention', exact: true }).waitFor();
    await main(page).getByRole('cell', { name: 'Sample A', exact: true }).waitFor();
    for (const count of ['1000', '850', '1200', '900', '800', '720']) await main(page).getByRole('cell', { name: count, exact: true }).waitFor();
  }
  async function figureReady(page) {
    await main(page).getByRole('button', { name: /^2\. Paired count figure/ }).click();
    const image = main(page).getByRole('img', { name: /^Preview of / });
    await until(async () => await image.count() && await image.evaluate(element => element.complete && element.naturalWidth === 960 && element.naturalHeight === 600), 'The verified public PNG did not decode to its saved dimensions.');
    return image;
  }
  async function publicPage(url, label, context) {
    const profile = context || await browser.newContext({ viewport: { width: 1366, height: 768 } });
    const page = watch(await profile.newPage(), label, { forbidApi: true }); await blockApi(page); await page.goto(url); return { page, profile };
  }
  try {
    service = await createDesktopTunnelServiceFixture({ artifactDirectory: directory });
    database = new Client({ connectionString: service.databaseUrl }); await database.connect();
    const initialCounts = await readCounts();
    const leaf = new crypto.X509Certificate(fs.readFileSync(service.certificatePath));
    browser = await chromium.launch({ headless: true, args: ['--host-resolver-rules=MAP ' + new URL(service.endpoint).hostname + ' 127.0.0.1',
      '--ignore-certificate-errors-spki-list=' + crypto.createHash('sha256').update(leaf.publicKey.export({ type: 'spki', format: 'der' })).digest('base64')] });
    const publicUrl = service.endpoint + '/' + route;
    const anonymous = await publicPage(publicUrl, 'anonymous-public');
    assert((await anonymous.profile.cookies()).length === 0, 'The cold public reader acquired an authenticated or guest cookie.');
    await tableReady(anonymous.page);
    assert(!requests.some(value => value.label === 'anonymous-public' && /figure\.png|counts\.csv/.test(value.pathname)), 'The public reader eagerly fetched a figure or optional source.');
    assert((await anonymous.page.locator('body').textContent()).includes('CC0-1.0'), 'The public example omitted its explicit public license.');
    await matrix(anonymous.page, 'public-example-cold-question-and-table', () => main(anonymous.page).getByRole('heading', { level: 1 }).scrollIntoViewIfNeeded());
    const image = await figureReady(anonymous.page);
    await matrix(anonymous.page, 'public-example-invented-count-figure', () => image.scrollIntoViewIfNeeded());
    const fullImagePage = anonymous.profile.waitForEvent('page'); await main(anonymous.page).getByRole('link', { name: 'Open full-size image', exact: true }).click();
    const full = await fullImagePage; await until(async () => full.locator('img').evaluate(element => element.complete && element.naturalWidth === 960), 'The explicit full-size public PNG could not be inspected.'); await full.close();
    const source = main(anonymous.page).getByRole('region', { name: 'Public example CSV source', exact: true });
    await source.getByRole('button', { name: 'View CSV source', exact: true }).focus(); await anonymous.page.keyboard.press('Enter');
    const csv = source.locator('pre[aria-label="Verified public CSV source"]');
    await until(async () => await csv.count() && await csv.textContent() === sourceText, 'The optional public source changed its exact authored CSV bytes.');
    await matrix(anonymous.page, 'public-example-explicit-verified-source', () => source.scrollIntoViewIfNeeded());
    await anonymous.page.reload(); await tableReady(anonymous.page);
    assert(!(await main(anonymous.page).locator('pre[aria-label="Verified public CSV source"]').count()), 'Reload reopened optional source without an explicit request.');
    check('A genuinely signed-out visitor inspects the deliberately public authored table, matching PNG and explicit exact CSV in both themes/laptop/390, including keyboard/full-size inspection and reload, with all API requests blocked.');

    const loginContext = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    const login = watch(await loginContext.newPage(), 'real-login'); await login.goto(service.endpoint);
    await login.getByPlaceholder('researcher@lab.edu').fill(service.account.email);
    const offered = login.getByRole('link', { name: 'Inspect a public saved example', exact: true });
    const offeredPage = new Promise(resolve => loginContext.once('page', page => resolve(watch(page, 'sign-in-public-link', { forbidApi: true }))));
    await offered.click(); const offeredReader = await offeredPage;
    await tableReady(offeredReader); assert(offeredReader.url() === publicUrl, 'Sign-in did not offer the explicit versioned public example.');
    assert(await login.getByPlaceholder('researcher@lab.edu').inputValue() === service.account.email, 'Opening a public example erased the sign-in form.'); await offeredReader.close();
    await login.getByLabel('Password', { exact: true }).fill(service.account.password); await login.getByRole('button', { name: /Open workbench/ }).click();
    await login.getByText('Connection details', { exact: true }).waitFor();
    const signedIn = await login.evaluate(async () => { const response = await fetch('/api/auth/session', { credentials: 'include' }); const body = await response.json(); return { status: response.status, id: body.user?.id }; });
    assert(signedIn.status === 200 && Number.isSafeInteger(Number(signedIn.id)), 'The populated-profile public check did not begin with an actual authenticated cookie.');
    await login.evaluate(() => { localStorage.setItem('private-public-example-check', 'PRIVATE_CACHE_MUST_NOT_APPEAR'); sessionStorage.setItem('private-public-example-check', 'PRIVATE_CACHE_MUST_NOT_APPEAR'); });
    const authenticated = await publicPage(publicUrl, 'authenticated-public', loginContext); await tableReady(authenticated.page); await figureReady(authenticated.page);
    assert(!(await authenticated.page.locator('body').textContent()).includes('PRIVATE_CACHE_MUST_NOT_APPEAR'), 'A public example rendered private cached account/project state.');
    await capture(authenticated.page, 'public-example-actual-authenticated-profile-remains-public');
    check('The real deployment sign-in offers an explicit separate public-example tab without erasing the form; an actual authenticated profile reads the same public bytes without consulting its account API or displaying private cached state.');

    const staticFaults = new Map(), staticRequests = [], mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.csv': 'text/csv', '.png': 'image/png', '.woff2': 'font/woff2' };
    staticServer = http.createServer(async (request, response) => {
      const pathname = new URL(request.url, 'http://127.0.0.1').pathname; staticRequests.push(pathname);
      const prefix = '/lab/'; if (!pathname.startsWith(prefix)) { response.writeHead(404); response.end(); return; }
      let relative;
      try { relative = decodeURIComponent(pathname.slice(prefix.length)); }
      catch { response.writeHead(400); response.end(); return; }
      let filename = path.resolve(root, 'dist', relative || 'index.html');
      if (!filename.startsWith(path.join(root, 'dist') + path.sep)) { response.writeHead(403); response.end(); return; }
      if (!fs.existsSync(filename) || fs.statSync(filename).isDirectory()) filename = path.join(root, 'dist/index.html');
      const fault = staticFaults.get(pathname); if (fault) { staticFaults.delete(pathname); fault.observed = true; if (fault.kind === 'hold') await fault.gate; }
      if (response.destroyed) return;
      let bytes = fs.readFileSync(filename), type = mime[path.extname(filename)] || 'application/octet-stream';
      if (fault?.kind === 'html') { bytes = fs.readFileSync(path.join(root, 'dist/index.html')); type = 'text/html'; }
      if (fault?.kind === 'corrupt') { bytes = Buffer.from(bytes); bytes[0] ^= 1; }
      response.writeHead(200, { 'Content-Type': type, 'Content-Length': bytes.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); response.end(bytes);
    });
    await new Promise(resolve => staticServer.listen(0, '127.0.0.1', resolve));
    const staticBase = `http://127.0.0.1:${staticServer.address().port}/lab/`, staticUrl = staticBase + route;
    const detached = await publicPage(staticUrl, 'static-subpath-public'); await tableReady(detached.page);
    assert(!staticRequests.some(value => isApiPath(value) || !value.startsWith('/lab/')), 'The public example lost its served app subpath or called an API.');
    const figurePath = '/lab/examples/qc-retention/v1/figure.png'; staticFaults.set(figurePath, { kind: 'corrupt' });
    await main(detached.page).getByRole('button', { name: /^2\. Paired count figure/ }).click();
    await main(detached.page).getByRole('button', { name: 'Retry finding', exact: true }).waitFor();
    assert(!(await main(detached.page).getByRole('img').count()), 'A corrupt public PNG was displayed as a verified image.'); await capture(detached.page, 'public-example-corrupt-figure-local-no-auth-fallback');
    await main(detached.page).getByRole('button', { name: /^1\. Count table/ }).click(); await tableReady(detached.page);
    await main(detached.page).getByRole('button', { name: /^2\. Paired count figure/ }).click();
    await main(detached.page).getByRole('button', { name: 'Retry finding', exact: true }).click();
    const recovered = main(detached.page).getByRole('img', { name: /^Preview of / }); await until(async () => await recovered.count() && await recovered.evaluate(element => element.complete && element.naturalWidth === 960), 'Explicit public finding retry failed to recover the fixed valid asset.');
    const sourcePath = '/lab/examples/qc-retention/v1/counts.csv'; staticFaults.set(sourcePath, { kind: 'html' });
    const detachedSource = main(detached.page).getByRole('region', { name: 'Public example CSV source', exact: true });
    await detachedSource.getByRole('button', { name: 'View CSV source', exact: true }).click(); await detachedSource.getByRole('button', { name: 'Retry CSV source', exact: true }).waitFor();
    assert(await recovered.count(), 'An unavailable optional source erased the permitted figure.'); await capture(detached.page, 'public-example-missing-source-stays-local');
    await detachedSource.getByRole('button', { name: 'Retry CSV source', exact: true }).click(); await detachedSource.locator('pre[aria-label="Verified public CSV source"]').waitFor();
    check('The frozen production distribution also runs from a standalone static /lab/ origin without any backend; corrupt figure and HTML source fallback stay local, preserve permitted findings and recover only through explicit public actions.');

    staticFaults.set('/lab/examples/qc-retention/v1/manifest.json', { kind: 'html' }); await detached.page.reload();
    await main(detached.page).getByRole('button', { name: 'Retry saved example', exact: true }).waitFor();
    assert(!(await main(detached.page).getByRole('table').count()) && !(await main(detached.page).getByRole('img').count()), 'An unverified public manifest displayed findings.'); await capture(detached.page, 'public-example-manifest-html-fallback-unavailable');
    await main(detached.page).getByRole('button', { name: 'Retry saved example', exact: true }).click(); await tableReady(detached.page);
    let release; const delayed = { kind: 'hold', gate: new Promise(resolve => { release = resolve; }), release: () => release() }; faults.push(delayed);
    staticFaults.set('/lab/examples/qc-retention/v1/manifest.json', delayed); await detached.page.reload({ waitUntil: 'domcontentloaded' });
    await until(() => delayed.observed, 'The actual public manifest was not held before route change.');
    await detached.page.evaluate(() => { location.hash = '#/examples/qc-retention/v99'; });
    await detached.page.getByRole('heading', { name: 'This public example link could not be read', exact: true }).waitFor(); delayed.release(); await detached.page.waitForTimeout(120);
    assert(!(await detached.page.getByRole('heading', { name: 'Synthetic QC retention', exact: true }).count()), 'A held public response restored an obsolete route.');
    await capture(detached.page, 'public-example-held-manifest-future-route-fenced');
    await detached.page.goto(staticBase + '#/shared-snapshots/v99/invalid-private-link');
    await detached.page.getByRole('heading', { name: 'This shared snapshot link could not be read', exact: true }).waitFor();
    assert(!(await detached.page.getByRole('heading', { name: 'Synthetic QC retention', exact: true }).count()), 'A failed private snapshot link silently became a public example.');
    check('Unknown versions, unverified manifest assets and held responses cannot select an example or private analysis implicitly; a malformed private link retains its own private-link error.');

    await Promise.all(assetReads);
    assert(requests.filter(value => value.forbidApi && value.isApi).length === 0, 'A public example attempted authentication, project, guest or compute API access.');
    assert(JSON.stringify(await readCounts()) === JSON.stringify(initialCounts), 'Public inspection initialized a scientific kernel, execution or job.');
    for (const profile of browser.contexts()) for (const page of profile.pages()) {
      const persisted = await page.evaluate(() => Object.values(localStorage).concat(Object.values(sessionStorage)).join('\n')).catch(() => '');
      assert(!persisted.includes(sourceText) && !persisted.includes('Paired bars display the same input'), 'Public scientific payload entered browser storage.');
    }
    assert(browserErrors.length === 0, 'Unexpected production public-example page errors occurred.');
    const unexpectedConsoleErrors = consoleErrors.filter(entry => {
      let pathname;
      try { pathname = new URL(entry.url).pathname; } catch { return true; }
      const status = Number(entry.text.match(/Failed to load resource: the server responded with a status of (\d+)/)?.[1]);
      const expected = entry.label === 'real-login' && (status === 401 && pathname === '/api/auth/session' || status === 404 && pathname === '/api/r/session-id');
      return !expected || !httpFailures.some(failure => failure.label === entry.label && failure.pathname === pathname && failure.status === status);
    });
    assert(unexpectedConsoleErrors.length === 0, 'Unexpected production public-example console errors occurred.');
    check('All public pages use frozen compiled scripts and versioned intentional public assets, with zero auth/project/runtime API attempts, scientific dispatches, private-cache-derived display or scientific browser persistence.');
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ passed: true, checks, screenshots, profiles, compiledAssets: assets,
      browserErrors, consoleErrors, unexpectedConsoleErrors, httpFailures, requests, staticRequests, fixture: 'Production Express/HTTPS/cookie/Postgres plus standalone static subpath; newly authored CC0 synthetic counts, no scientific runtime or real dataset.' }, null, 2));
    console.log('Public saved example acceptance: ' + directory);
  } catch (error) {
    await activePage?.screenshot({ path: path.join(directory, 'failure.png'), fullPage: true }).catch(() => {});
    const tree = await activePage?.locator('main').ariaSnapshot().catch(() => null); if (tree) fs.writeFileSync(path.join(directory, 'failure-accessibility.txt'), tree);
    let message = error.message; for (const secret of [service?.databaseUrl, service?.account.password, service?.storageRoot].filter(Boolean)) message = message.split(secret).join('[private fixture]');
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ passed: false, checks, screenshots, error: message, compiledAssets: assets, browserErrors, consoleErrors, httpFailures, requests }, null, 2)); throw new Error(message);
  } finally {
    for (const fault of faults) fault.release(); await browser?.close();
    if (staticServer) { staticServer.closeAllConnections(); await new Promise(resolve => staticServer.close(resolve)); }
    await database?.end(); await service?.stop();
  }
}
run().catch(error => { console.error(error.message); process.exitCode = 1; });
