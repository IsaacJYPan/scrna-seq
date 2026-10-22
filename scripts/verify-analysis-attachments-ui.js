#!/usr/bin/env node
'use strict';

// Actual production HTTPS/auth/PostgreSQL/storage. Imported figures and tables
// are explicitly synthetic; no scientific execution or SSH behavior is claimed.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require('playwright');
const { Client } = require('pg');
const { PNG } = require('pngjs');
const { createDesktopTunnelServiceFixture } = require('./desktop-tunnel-service-fixture.cjs');

const root = path.resolve(__dirname, '..');
const assert = (value, message) => { if (!value) throw new Error(message); };
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const csv = Buffer.from('sample,condition,note\r\nsample-1,control,"one, two"\r\nsample-2,treated,"line 1\nline 2"\r\n');
async function until(check, message, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 75)); }
  throw new Error(message);
}
function syntheticFigure() {
  const png = new PNG({ width: 480, height: 240 });
  for (let y = 0; y < png.height; y++) for (let x = 0; x < png.width; x++) {
    const offset = (png.width * y + x) * 4;
    const value = Math.floor(x / 60) + Math.floor(y / 40);
    png.data[offset] = 25 + value * 10; png.data[offset + 1] = 100 + value * 5;
    png.data[offset + 2] = 210 - value * 7; png.data[offset + 3] = 255;
  }
  return PNG.sync.write(png);
}

async function main({ artifactDirectory, verifyCorrections, verifyIntakes, verifyPreparations, configureServerData } = {}) {
  const directory = path.resolve(artifactDirectory || path.join(root, 'playwright/report', 'analysis-attachments-' + Date.now()));
  assert(directory.startsWith(path.join(root, 'playwright/report') + path.sep), 'Evidence must stay in ignored report storage.');
  assert(fs.existsSync(path.join(root, 'dist/index.html')), 'Build production assets before attachment acceptance.');
  fs.mkdirSync(directory, { recursive: true });
  const frozen = new Map(fs.readdirSync(path.join(root, 'dist/assets')).map(name => [name, sha(fs.readFileSync(path.join(root, 'dist/assets', name)))]));
  const checks = [], screenshots = [], profiles = [], requests = [], browserErrors = [], consoleErrors = [], assets = {}, assetReads = [], accounts = {}, faults = [];
  const expectedDiagnostics = new Set(), responses = [];
  const faultPaths = new Set();
  const browserRestarts = [];
  let service, database, browser, page, study, otherStudy, table, figure;
  let extraRevisions = 0, expectedAnalysisVersion = 1;
  const base = () => `/api/projects/${service.project.id}/analyses`;
  const attachmentPath = (analysis = study) => `${base()}/${analysis.id}/attachments`;
  const region = target => target.getByRole('region', { name: 'Outside results', exact: true });
  const form = target => region(target).getByRole('form', { name: 'Attach outside result', exact: true });
  const details = target => region(target).getByRole('region', { name: 'Outside result details', exact: true });
  const check = message => { checks.push(message); console.log('PASS: ' + message); };
  async function api(target, pathname, { method = 'GET', body, expected = 200 } = {}) {
    if (expected >= 400) expectedDiagnostics.add(`${expected} ${pathname}`);
    const value = await target.evaluate(async ({ pathname, method, body }) => {
      const result = await fetch(pathname, { method, credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-Traceomics-Csrf': '1' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: result.status, value: await result.json() };
    }, { pathname, method, body });
    assert(value.status === expected, 'A real attachment API boundary returned an unexpected status.'); return value.value;
  }
  async function login(actor = 'owner') {
    const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    const target = await context.newPage();
    target.on('pageerror', failure => browserErrors.push(failure.message));
    target.on('console', value => { if (value.type() === 'error') consoleErrors.push({ text: value.text(), url: value.location().url }); });
    target.on('request', request => {
      const pathname = new URL(request.url()).pathname;
      if (!pathname.startsWith('/api/')) return;
      const record = { actor, method: request.method(), pathname };
      if (record.method === 'POST' && (/\/attachments(?:\/(?:local|server)-intakes|\/raa_[a-f0-9]{24}\/revisions(?:\/rar_[a-f0-9]{24}\/comments)?)?$/.test(pathname)
        || /^\/api\/server-data\/[^/]+\/imports$/.test(pathname) || /\/snapshot-preparations(?:\/asp_[a-f0-9]{24}\/resume)?$/.test(pathname))) record.input = request.postDataJSON();
      requests.push(record);
    });
    target.on('response', response => {
      const pathname = new URL(response.url()).pathname;
      if (!response.ok() || !pathname.startsWith('/assets/') || !pathname.endsWith('.js')) return;
      assetReads.push((async () => { const digest = sha(await response.body()); assets[pathname] = digest; assert(frozen.get(pathname.split('/').at(-1)) === digest, 'Compiled assets changed during acceptance.'); })().catch(failure => browserErrors.push(failure.message)));
    });
    await target.goto(service.endpoint);
    await target.getByPlaceholder('researcher@lab.edu').fill(accounts[actor].email);
    await target.getByLabel('Password', { exact: true }).fill(service.account.password);
    await target.getByRole('button', { name: /Open Workbench/ }).click();
    await target.getByText('Connection details', { exact: true }).waitFor();
    return target;
  }
  async function nav(target, name) {
    const expand = target.getByRole('button', { name: 'Expand sidebar', exact: true });
    if (await expand.isVisible()) await expand.click();
    await target.getByRole('button', { name, exact: typeof name === 'string' }).click();
  }
  async function openAnalysis(target, analysis = study) {
    await nav(target, /^Data workspace,/);
    await target.getByRole('button', { name: new RegExp('^' + escape(service.project.name) + '(?:$|\\s)') }).click();
    await nav(target, 'Analyses');
    const outside = region(target);
    if (await outside.isVisible()) await outside.getByRole('button', { name: 'Back to analysis', exact: true }).click();
    const all = target.getByRole('button', { name: 'All analyses', exact: true }); if (await all.isVisible()) await all.click();
    await target.getByRole('list', { name: 'Analysis list', exact: true }).getByRole('button', { name: new RegExp('^' + escape(analysis.name)) }).click();
    await target.getByRole('region', { name: 'Selected analysis', exact: true }).waitFor();
  }
  async function openOutside(target) { await target.getByRole('button', { name: 'Outside results', exact: true }).click(); await region(target).waitFor(); await until(() => region(target).getByRole('button', { name: 'Refresh results', exact: true }).isEnabled(), 'Outside results did not finish loading.'); }
  async function importFile(target, bytes, name, filename, mime) {
    const value = await target.evaluate(async ({ pathname, bytes, name, filename, mime, requestId }) => {
      const body = new FormData(); body.append('file', new Blob([new Uint8Array(bytes)], { type: mime }), filename); body.append('name', name); body.append('requestId', requestId);
      const response = await fetch(pathname, { method: 'POST', credentials: 'include', headers: { 'X-Traceomics-Csrf': '1' }, body });
      return { status: response.status, value: await response.json() };
    }, { pathname: `/api/artifact-versions/${service.project.id}`, bytes: [...bytes], name, filename, mime, requestId: crypto.randomUUID() });
    assert(value.status === 201 && value.value.sha256 === sha(bytes), 'A genuine seed import did not retain exact synthetic bytes.'); return value.value;
  }
  async function prepare(target, version, caption, supplied = {}) {
    if (!(await form(target).count())) await region(target).getByRole('button', { name: 'Attach outside result', exact: true }).click();
    await form(target).getByRole('button', { name: 'Choose saved file', exact: true }).click();
    const label = form(target).locator('label').filter({ has: target.locator('input[type=radio]') }).filter({ hasText: version.name });
    await label.getByRole('radio').check();
    await form(target).getByLabel('Result caption', { exact: true }).fill(caption);
    if (Object.keys(supplied).length) {
      const summary = form(target).locator('summary'); if (!(await summary.locator('..').evaluate(node => node.open))) await summary.click();
      for (const [label, value] of Object.entries(supplied)) await form(target).getByLabel(label, { exact: true }).fill(value);
    }
  }
  async function submit(target) {
    const waiting = target.waitForResponse(response => new URL(response.url()).pathname === attachmentPath() && response.request().method() === 'POST');
    await form(target).getByRole('button', { name: 'Attach result', exact: true }).click();
    const response = await waiting, value = await response.json();
    assert(response.ok() && value.acceptedRevision, 'The actual attachment was not accepted.'); responses.push(value);
    await region(target).getByRole('region', { name: 'Attachment confirmed', exact: true }).waitFor(); return value;
  }
  async function closeDetails(target) {
    const button = details(target).getByRole('button', { name: /^(?:Back to outside results|Close details)$/ }); if (await button.count()) await button.click();
  }
  async function theme(target, value) {
    const state = await target.evaluate(() => document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
    if (state === value) return;
    const expand = target.getByRole('button', { name: 'Expand sidebar', exact: true }); if (await expand.isVisible()) await expand.click();
    await target.getByRole('button', { name: `Switch to ${value} mode`, exact: true }).click();
    const collapse = target.getByRole('button', { name: 'Collapse sidebar', exact: true }); if (await collapse.isVisible()) await collapse.click();
    await until(async () => await target.evaluate(() => document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light') === value, 'Rendered theme did not settle.');
  }
  async function capture(target, name) {
    await target.waitForTimeout(350); // Existing sidebar/theme transition only.
    const measure = await target.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
    assert(measure.scroll <= measure.width + 1, 'Outside results created whole-page horizontal overflow.');
    await target.screenshot({ path: path.join(directory, name + '.png'), fullPage: true }); screenshots.push(name + '.png'); profiles.push({ filename: name + '.png', viewport: target.viewportSize(), theme: await target.evaluate(() => document.documentElement.dataset.theme || 'light') });
  }
  async function matrix(target, prefix, focus) {
    for (const [width, height] of [[1366, 768], [1440, 900], [390, 844]]) {
      await target.setViewportSize({ width, height });
      for (const value of ['light', 'dark']) { await theme(target, value); if (focus) await focus(); await capture(target, `${prefix}-${value}-${width}`); }
      if (width === 1366) { const expand = target.getByRole('button', { name: 'Expand sidebar', exact: true }); if (await expand.isVisible()) await expand.click(); if (focus) await focus(); await capture(target, `${prefix}-dark-${width}-expanded-sidebar`); }
    }
  }
  async function launchBrowser() {
    const leaf = new crypto.X509Certificate(fs.readFileSync(service.certificatePath));
    return chromium.launch({ headless: true, args: ['--host-resolver-rules=MAP ' + new URL(service.endpoint).hostname + ' 127.0.0.1', '--ignore-certificate-errors-spki-list=' + Buffer.from(sha(leaf.publicKey.export({ type: 'spki', format: 'der' })), 'hex').toString('base64')] });
  }
  async function restartBrowser() {
    await Promise.all(assetReads); const previous = browser; await previous.close();
    assert(!previous.isConnected(), 'The previous browser process remained connected.');
    browser = await launchBrowser(); assert(browser.isConnected(), 'The replacement browser process failed to start.');
    browserRestarts.push({ previousClosed: true, replacementConnected: true }); page = await login(); return page;
  }
  try {
    service = await createDesktopTunnelServiceFixture({ artifactDirectory: directory, webEnvironment: { AUTH_RATE_LIMIT_MAX: '100' }, configureProjectEnvironment: async ({ env, account, project }) => {
      const client = new Client({ connectionString: env.DATABASE_URL }); await client.connect();
      try {
        const owner = (await client.query('SELECT * FROM users WHERE email=$1', [account.email])).rows[0]; accounts.owner = { id: Number(owner.id), email: account.email };
        const organization = (await client.query('SELECT organization_id FROM projects WHERE id=$1', [project.id])).rows[0];
        const colleague = (await client.query('INSERT INTO users(email,password_hash,salt,display_name) VALUES($1,$2,$3,$4) RETURNING id', ['attachment-reader-' + crypto.randomBytes(6).toString('hex') + '@example.invalid', owner.password_hash, owner.salt, 'Attachment colleague'])).rows[0];
        accounts.colleague = { id: Number(colleague.id), email: 'unused' }; accounts.colleague.email = (await client.query('SELECT email FROM users WHERE id=$1', [colleague.id])).rows[0].email;
        await client.query("INSERT INTO organization_members(organization_id,user_id,role) VALUES($1,$2,'member')", [organization.organization_id, colleague.id]);
        await client.query("INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,'viewer')", [project.id, colleague.id]);
        if (configureServerData) return await configureServerData({ env, account, project, accounts, database: client });
      } finally { await client.end(); } return {};
    } });
    database = new Client({ connectionString: service.databaseUrl }); await database.connect();
    const leaf = new crypto.X509Certificate(fs.readFileSync(service.certificatePath)), ca = new crypto.X509Certificate(fs.readFileSync(service.caCertificatePath));
    assert(leaf.verify(ca.publicKey) && leaf.checkHost(new URL(service.endpoint).hostname), 'The owned fixture TLS identity failed verification.');
    browser = await launchBrowser();
    page = await login();
    study = (await api(page, base(), { method: 'POST', body: { requestId: crypto.randomUUID(), name: 'Outside evidence study', description: 'Keep the research question separate from attachment saves.' }, expected: 201 })).analysis;
    otherStudy = (await api(page, base(), { method: 'POST', body: { requestId: crypto.randomUUID(), name: 'Unrelated draft study', description: '' }, expected: 201 })).analysis;
    table = await importFile(page, csv, 'Synthetic sample summary', 'sample-summary.csv', 'text/csv');
    figure = await importFile(page, syntheticFigure(), 'Synthetic supplied heatmap', 'synthetic-heatmap.png', 'image/png');
    await openAnalysis(page); const notes = page.getByRole('region', { name: 'Selected analysis', exact: true }).getByLabel('Research question or notes', { exact: true });
    const dirtyNotes = 'Unsubmitted scientific question draft must remain exactly here.'; await notes.fill(dirtyNotes); await openOutside(page);
    await prepare(page, table, 'Synthetic sample summary: retain condition and quoted notes.', { 'Where this result came from': 'Supplied outside analysis; synthetic acceptance fixture.', 'Code or method reference': 'Researcher supplied method citation; not a verified run.', 'Environment reference': 'Unknown package versions; not reconstructed.' });
    await region(page).getByRole('button', { name: 'Back to analysis', exact: true }).click();
    const chooseAnalysis = async analysis => {
      const all = page.getByRole('button', { name: 'All analyses', exact: true }); if (await all.isVisible()) await all.click();
      await page.getByRole('list', { name: 'Analysis list', exact: true }).getByRole('button', { name: new RegExp('^' + escape(analysis.name)) }).click();
    };
    await chooseAnalysis(otherStudy); await openOutside(page);
    await region(page).getByRole('button', { name: 'Attach outside result', exact: true }).click();
    await form(page).getByLabel('Result caption', { exact: true }).fill('Independent caption draft for the other analysis.');
    await region(page).getByRole('button', { name: 'Back to analysis', exact: true }).click(); await chooseAnalysis(study); await openOutside(page);
    assert(await form(page).getByLabel('Result caption', { exact: true }).inputValue() === 'Synthetic sample summary: retain condition and quoted notes.', 'Navigating analyses discarded a caption draft.');
    const first = await submit(page); assert(first.acceptedRevision.reference.versionId === table.versionId && first.acceptedRevision.reference.sha256 === sha(csv), 'The attachment lost exact original table identity.');
    await region(page).getByRole('button', { name: 'Inspect attached result', exact: true }).click();
    await details(page).getByRole('cell', { name: 'one, two', exact: true }).waitFor();
    await details(page).locator('summary').filter({ hasText: 'Supplied context and exact version' }).click();
    await matrix(page, 'attached-table-and-context');
    await details(page).locator('summary').filter({ hasText: 'Supplied context and exact version' }).click();
    await matrix(page, 'verified-attached-table', () => details(page).getByRole('table').scrollIntoViewIfNeeded());
    await closeDetails(page); await region(page).getByRole('button', { name: 'Back to analysis', exact: true }).click();
    assert(await notes.inputValue() === dirtyNotes, 'Attaching or inspecting overwrote unrelated analysis notes.');
    assert((await api(page, `${base()}/${study.id}`)).analysis.version === 1, 'Attaching rewrote the analysis metadata revision.');
    check('A real owned exact CSV attachment retains supplied context, uses checked bounded inspection and preserves unrelated unsaved analysis notes and metadata revisions.');

    await openOutside(page); await prepare(page, figure, 'Synthetic figure: imported evidence, with unknown execution context.');
    await submit(page); await region(page).getByRole('button', { name: 'Inspect attached result', exact: true }).click();
    const image = details(page).getByRole('img', { name: /Preview of Synthetic supplied heatmap/ }); await image.waitFor();
    assert(await image.evaluate(node => node.complete && node.naturalWidth === 480 && node.naturalHeight === 240), 'Actual saved PNG bytes did not decode at their exact dimensions.');
    await matrix(page, 'attached-raster', () => image.scrollIntoViewIfNeeded()); check('Actual imported PNG bytes decode through the common private retained-result viewer in both themes and laptop/natural phone layouts.');

    if (verifyCorrections) {
      const extension = await verifyCorrections({ service, database, page, study, table, figure, accounts, requests, faults, baselineAttachment: first,
        region, form, details, api, login, openAnalysis, openOutside, prepare, submit, closeDetails, theme, capture, matrix, until, assert, check, attachmentPath, expectedDiagnostics, faultPaths });
      extraRevisions = typeof extension === 'number' ? extension : extension.extraRevisions;
      expectedAnalysisVersion = typeof extension === 'number' ? 1 : extension.analysisVersion;
      assert(Number.isSafeInteger(extraRevisions) && extraRevisions >= 0 && Number.isSafeInteger(expectedAnalysisVersion) && expectedAnalysisVersion >= 1, 'The extension did not account for its intended evidence and explicit analysis edits.');
    }

    await closeDetails(page); await page.setViewportSize({ width: 1366, height: 768 }); await theme(page, 'light');
    await prepare(page, figure, 'Actual held acknowledgement must preserve the selected table.');
    const held = service.interceptNextResponse({ method: 'POST', pathname: attachmentPath(), mode: 'hold' }); faults.push(held);
    await form(page).getByRole('button', { name: 'Attach result', exact: true }).click(); await until(() => held.observation(), 'Actual accepted attachment acknowledgement was not held.');
    await region(page).getByRole('list', { name: 'Attached outside results', exact: true }).getByRole('listitem').filter({ hasText: first.acceptedRevision.caption }).getByRole('button', { name: 'Inspect result and context', exact: true }).click();
    await details(page).getByRole('cell', { name: 'one, two', exact: true }).waitFor(); held.release();
    await region(page).getByRole('region', { name: 'Attachment confirmed', exact: true }).waitFor();
    assert(await details(page).getByRole('cell', { name: 'one, two', exact: true }).isVisible(), 'A late accepted reply redirected the later selected table.');
    await capture(page, 'late-accepted-reply-preserves-selected-table'); await closeDetails(page);
    check('A genuinely accepted held reply preserves a later selected result, and navigating analyses retains their independent caption drafts.');

    await prepare(page, table, 'Frozen original attachment request after a pre-upstream failure.');
    let aborted = false;
    await page.route('**/attachments', async route => { if (!aborted && route.request().method() === 'POST' && new URL(route.request().url()).pathname === attachmentPath()) { aborted = true; await route.abort('failed'); } else await route.continue(); });
    await form(page).getByRole('button', { name: 'Attach result', exact: true }).click();
    const recovery = region(page).getByRole('region', { name: 'Attachment recovery', exact: true });
    await until(async () => aborted && await recovery.getByRole('button', { name: 'Check attachment outcome', exact: true }).isEnabled(), 'Pre-upstream failure did not expose deliberate attachment recovery.');
    await page.unroute('**/attachments'); const originalRequest = requests.filter(item => item.method === 'POST' && item.pathname === attachmentPath()).at(-1).input;
    expectedDiagnostics.add(`404 ${attachmentPath()}/requests/${originalRequest.requestId}`);
    await recovery.getByRole('button', { name: 'Check attachment outcome', exact: true }).click(); await recovery.getByRole('button', { name: 'Retry original attachment', exact: true }).waitFor();
    assert(await form(page).getByLabel('Result caption', { exact: true }).isDisabled(), 'An unconfirmed attachment allowed its caption to change.');
    const beforeRetry = requests.filter(item => item.method === 'POST' && item.pathname === attachmentPath()).length;
    await matrix(page, 'unconfirmed-attachment'); assert(requests.filter(item => item.method === 'POST' && item.pathname === attachmentPath()).length === beforeRetry, 'Attachment status or viewing retried automatically.');
    await recovery.getByRole('button', { name: 'Retry original attachment', exact: true }).click(); await region(page).getByRole('region', { name: 'Attachment confirmed', exact: true }).waitFor();
    assert(JSON.stringify(requests.filter(item => item.method === 'POST' && item.pathname === attachmentPath()).at(-1).input) === JSON.stringify(originalRequest), 'Explicit retry changed original normalized attachment content or UUID.');
    check('A real pre-upstream failure stays unconfirmed after receipt404; exact caption/context/source/UUID freeze and only deliberate retry creates one attachment.');

    await page.setViewportSize({ width: 1366, height: 768 }); await prepare(page, figure, 'Accepted original attachment whose actual reply was lost.');
    const lost = service.interceptNextResponse({ method: 'POST', pathname: attachmentPath(), mode: 'drop' }); faults.push(lost);
    await form(page).getByRole('button', { name: 'Attach result', exact: true }).click();
    await until(() => lost.observation(), 'The actual accepted attachment reply was not intercepted.');
    const lostRequest = requests.filter(item => item.method === 'POST' && item.pathname === attachmentPath()).at(-1).input;
    await until(() => recovery.getByRole('button', { name: 'Check attachment outcome', exact: true }).isEnabled(), 'The lost reply did not preserve its original pending attachment.');
    await database.query("UPDATE project_members SET role='viewer' WHERE project_id=$1 AND user_id=$2", [service.project.id, accounts.owner.id]);
    await recovery.getByRole('button', { name: 'Check attachment outcome', exact: true }).click(); await region(page).getByRole('region', { name: 'Attachment confirmed', exact: true }).waitFor();
    await until(async () => !(await region(page).getByRole('button', { name: 'Attach outside result', exact: true }).count()), 'The current reader regained a fresh writer control.');
    const accepted = await api(page, `${attachmentPath()}/requests/${lostRequest.requestId}`); assert(accepted.canWrite === false && accepted.acceptedRevision.caption === lostRequest.caption, 'Owner reader did not recover exact original acceptance.');
    await capture(page, 'reader-recovered-accepted-request');
    check('An actual accepted lost reply is recovered under current reader authority, with original identity and no new write permission or duplicate attachment.');

    const colleague = await login('colleague'); await openAnalysis(colleague); await openOutside(colleague);
    const privatePosts = requests.filter(item => item.actor === 'colleague' && /\/artifact-versions\//.test(item.pathname)).length;
    await region(colleague).getByRole('list', { name: 'Attached outside results', exact: true }).getByRole('button', { name: 'Inspect result and context', exact: true }).first().click();
    await details(colleague).getByText('This source remains private to its owner. The attachment has not granted access to the file.', { exact: true }).waitFor();
    assert(requests.filter(item => item.actor === 'colleague' && /\/artifact-versions\//.test(item.pathname)).length === privatePosts, 'A restricted attachment attempted a private source read.');
    await matrix(colleague, 'restricted-colleague-context');
    await api(colleague, `${attachmentPath()}/requests/${lostRequest.requestId}`, { expected: 404 });
    await api(colleague, attachmentPath(), { method: 'POST', body: { ...lostRequest, requestId: crypto.randomUUID() }, expected: 403 });
    check('A real second account reads project captions/context while private source bytes, filenames and owner-scoped acceptance receipts remain inaccessible; current reader writes are denied.');

    const owned = (await database.query('SELECT storage_key FROM managed_artifact_versions WHERE id=$1 AND project_id=$2 AND owner_user_id=$3', [figure.versionId, service.project.id, accounts.owner.id])).rows[0];
    const ownedRoot = path.resolve(service.storageRoot), ownedFile = path.resolve(ownedRoot, ...owned.storage_key.split('/'));
    assert(owned.storage_key.startsWith(`projects/${service.project.id}/artifacts/${figure.versionId}/`) && ownedFile.startsWith(ownedRoot + path.sep) && fs.lstatSync(ownedFile).isFile() && !fs.lstatSync(ownedFile).isSymbolicLink(), 'Missing-source fixture escaped its owned exact file.'); fs.unlinkSync(ownedFile);
    const unavailable = await api(page, `${attachmentPath()}/requests/${lostRequest.requestId}`); assert(unavailable.attachment.sourceAccess === 'unavailable' && unavailable.acceptedRevision.id === accepted.acceptedRevision.id, 'Missing source erased immutable attachment acceptance.');
    await region(page).getByRole('button', { name: 'Refresh results', exact: true }).click();
    await until(async () => /Original source is unavailable/.test(await region(page).innerText()), 'The actual missing source was not explained.');
    await page.setViewportSize({ width: 390, height: 844 }); await capture(page, 'missing-source-context-retained');
    await database.query("UPDATE project_members SET role='owner' WHERE project_id=$1 AND user_id=$2", [service.project.id, accounts.owner.id]);
    await region(page).getByRole('button', { name: 'Refresh results', exact: true }).click();
    await region(page).getByRole('button', { name: 'Attach outside result', exact: true }).waitFor();
    await prepare(page, table, 'Accepted held result must not restore revoked project access.');
    const revoked = service.interceptNextResponse({ method: 'POST', pathname: attachmentPath(), mode: 'hold' }); faults.push(revoked);
    await form(page).getByRole('button', { name: 'Attach result', exact: true }).click(); await until(() => revoked.observation(), 'A real pre-revocation acceptance was not held.');
    const revokeRequest = requests.filter(item => item.method === 'POST' && item.pathname === attachmentPath()).at(-1).input;
    await database.query('DELETE FROM project_members WHERE project_id=$1 AND user_id=$2', [service.project.id, accounts.owner.id]);
    expectedDiagnostics.add(`404 ${attachmentPath()}?limit=30`);
    await region(page).getByRole('button', { name: 'Refresh results', exact: true }).click();
    await until(async () => await region(page).getByRole('list', { name: 'Attached outside results', exact: true }).getByRole('listitem').count() === 0, 'Revocation left protected attachment material visible.');
    await until(() => recovery.getByRole('button', { name: 'Check attachment outcome', exact: true }).isEnabled(), 'Scope denial did not leave the original request recoverable.');
    revoked.release(); await page.waitForTimeout(400); // Let the deliberately held old acknowledgement finish at the proxy.
    assert(!(await region(page).getByRole('button', { name: 'Attach outside result', exact: true }).count()) && !(await region(page).getByRole('region', { name: 'Attachment confirmed', exact: true }).count())
      && await region(page).getByRole('list', { name: 'Attached outside results', exact: true }).getByRole('listitem').count() === 0, 'A late acceptance restored source material or writer controls after current access denial.');
    assert((await recovery.innerText()).includes(revokeRequest.caption), 'Current denial discarded the original uncertain request.');
    assert(!(await region(page).getByText('No outside results attached', { exact: true }).count()), 'An access denial was presented as an empty attachment collection.');
    await recovery.scrollIntoViewIfNeeded();
    await capture(page, 'scope-denied-late-acceptance-390');
    await page.setViewportSize({ width: 1366, height: 768 }); await theme(page, 'dark'); await capture(page, 'scope-denied-late-acceptance-dark-1366');
    check('Missing original bytes retain acceptance and context; a fresh membership denial fences a genuine held accepted reply so old success cannot restore protected source material or write controls.');

    await database.query("INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,'viewer')", [service.project.id, accounts.owner.id]);
    let blockedRefreshes = 0;
    const abortRefresh = async route => {
      const request = route.request();
      if (request.method() === 'GET' && new URL(request.url()).pathname === attachmentPath()) { blockedRefreshes += 1; await route.abort('failed'); }
      else await route.continue();
    };
    await page.route('**/attachments?**', abortRefresh);
    await recovery.getByRole('button', { name: 'Check attachment outcome', exact: true }).click();
    await region(page).getByRole('region', { name: 'Attachment confirmed', exact: true }).waitFor();
    await until(() => blockedRefreshes > 0, 'The deliberate post-recovery catalog outage did not occur.');
    await until(async () => await region(page).getByRole('button', { name: 'Refresh results', exact: true }).isEnabled(), 'The catalog outage left its loading control stuck.');
    await region(page).getByRole('alert').filter({ hasText: /Outside results could not be (?:loaded|refreshed)/ }).waitFor();
    assert(await region(page).getByRole('list', { name: 'Attached outside results', exact: true }).getByRole('listitem').count() === 0, 'The catalog outage allowed a successful collection response before the recovery capture.');
    assert(!(await region(page).getByText(/Access to this analysis could not be confirmed/).count()), 'A fresh authorized receipt retained stale access-denial copy after a separate catalog outage.');
    assert(!(await region(page).getByRole('button', { name: 'Attach outside result', exact: true }).count()), 'Recovering a restored current reader request enabled new attachment writes.');
    await capture(page, 'restored-reader-original-receipt-catalog-offline'); await page.unroute('**/attachments?**', abortRefresh);
    check('After access is restored, an authenticated original receipt clears stale denial while a separate catalog outage preserves the confirmed result and current reader limits.');

    for (const verify of [verifyIntakes, verifyPreparations].filter(Boolean)) {
      const extension = await verify({ service, database, page, study, otherStudy, table, figure, accounts, requests, faults, importFile,
        region, details, api, login, openAnalysis, openOutside, closeDetails, theme, capture, matrix, until, assert, check, attachmentPath,
        expectedDiagnostics, faultPaths, restartBrowser, analysisVersion: expectedAnalysisVersion });
      assert(Number.isSafeInteger(extension.extraRevisions) && extension.extraRevisions >= 0, 'The intake extension did not account for its genuine accepted revisions.');
      extraRevisions += extension.extraRevisions;
      expectedAnalysisVersion = extension.analysisVersion;
    }

    const count = (await database.query('SELECT COUNT(*)::int AS n FROM research_analysis_attachment_revisions')).rows[0].n;
    assert(count === 6 + extraRevisions, 'Attachment admission or recovery duplicated immutable revisions.');
    assert((await database.query('SELECT version FROM research_analyses WHERE id=$1', [study.id])).rows[0].version === expectedAnalysisVersion, 'Attachments mutated unrelated analysis revisions beyond the explicit versioned archive/restoration actions.');
    for (const tableName of ['jobs', 'private_r_kernels', 'private_r_executions']) assert(Number((await database.query(`SELECT COUNT(*) AS n FROM ${tableName}`)).rows[0].n) === 0, 'An attachment operation executed science.');
    assert(sha(fs.readFileSync(path.resolve(service.storageRoot, ...(await database.query('SELECT storage_key FROM managed_artifact_versions WHERE id=$1', [table.versionId])).rows[0].storage_key.split('/')))) === sha(csv), 'Attachment operations changed the original table bytes.');
    await Promise.all(assetReads);
    const unexpectedConsole = consoleErrors.filter(entry => {
      let url; try { url = new URL(entry.url); } catch { return true; }
      const status = /status of (\d+)/.exec(entry.text)?.[1];
      if (status === '401' && url.pathname === '/api/auth/session' || status === '404' && url.pathname === '/api/r/session-id' || expectedDiagnostics.has(`${status} ${url.pathname}${url.search}`) || expectedDiagnostics.has(`${status} ${url.pathname}`)) return false;
      if (/^Failed to load resource: net::ERR_(?:FAILED|CONTENT_LENGTH_MISMATCH|EMPTY_RESPONSE|INCOMPLETE_CHUNKED_ENCODING|CONNECTION_CLOSED|CONNECTION_RESET)/.test(entry.text) && (url.pathname === attachmentPath() || faultPaths.has(url.pathname))) return false;
      return true;
    });
    assert(browserErrors.length === 0 && unexpectedConsole.length === 0, 'Unexpected production UI error occurred.');
    check('All journeys used frozen production assets and genuine private storage/auth with no scientific jobs, kernels, execution or unexpected browser errors.');
    const result = { passed: true, checks, screenshots, profiles, compiledAssets: assets, responses, requests, browserRestarts, browserErrors, consoleErrors, fixture: 'Owned disposable production HTTPS/auth/PostgreSQL/storage; health-only R stub, synthetic table/PNG, deliberate upstream abort and genuine accepted lost reply.', limitations: ['No real scientific execution, remote SSH or large-file performance claim.', 'Captions and context are project metadata; private source permission is checked separately.'] };
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result, null, 2) + '\n'); console.log('Analysis attachments acceptance: ' + directory); return result;
  } catch (failure) {
    await page?.screenshot({ path: path.join(directory, 'failure.png'), fullPage: true }).catch(() => {});
    const tree = await page?.locator('main').ariaSnapshot().catch(() => null); if (tree) fs.writeFileSync(path.join(directory, 'failure-accessibility.txt'), tree);
    let message = failure.message; for (const secret of [service?.databaseUrl, service?.storageRoot, service?.account.password, ...Object.values(accounts).map(value => value.email)].filter(Boolean)) message = message.split(secret).join('[private fixture]');
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ passed: false, checks, screenshots, profiles, error: message, browserErrors, consoleErrors, compiledAssets: assets, requests }, null, 2) + '\n'); throw new Error(message);
  } finally { for (const fault of faults) fault.release(); await browser?.close(); await database?.end(); await service?.stop(); }
}
if (require.main === module) main().catch(failure => { console.error(failure.message); process.exitCode = 1; });
module.exports = { main };
