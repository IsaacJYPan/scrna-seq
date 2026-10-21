#!/usr/bin/env node
'use strict';

// Production HTTPS/auth/PostgreSQL/storage acceptance. CSV inputs are synthetic;
// no R analysis, scientific runtime, endpoint-success mock or fake receipt is used.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require('playwright');
const { Client } = require('pg');
const { createDesktopTunnelServiceFixture } = require('./desktop-tunnel-service-fixture.cjs');

const root = path.resolve(__dirname, '..');
const assert = (value, message) => { if (!value) throw new Error(message); };
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const escaped = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const original = Buffer.from('sample,condition,note\r\nsample-1,control,"one, two"\r\nsample-2,treated,"line 1\nline 2"\r\n');
const revised = Buffer.from('sample,condition,note\r\nsample-1,control,revised immutable version\r\n');
const retried = Buffer.from('sample,condition,note\r\nsample-1,control,explicit original retry\r\n');
const unrelated = Buffer.from('sample,condition,note\r\nreference-1,reference,keep selected inspection\r\n');
const late = Buffer.from('sample,condition,note\r\nlate-1,treated,late accepted acknowledgement\r\n');
const dropped = Buffer.from('sample,condition,note\r\nlost-1,treated,accepted reply lost\r\n');

async function until(check, message, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 75)); }
  throw new Error(message);
}

async function main({ artifactDirectory } = {}) {
  const directory = path.resolve(artifactDirectory || path.join(root, 'playwright/report', 'artifact-import-recovery-' + Date.now()));
  assert(directory.startsWith(path.join(root, 'playwright/report') + path.sep), 'Acceptance evidence must stay in ignored report storage.');
  assert(fs.existsSync(path.join(root, 'dist/index.html')), 'A coordinated frozen production build is required.');
  fs.mkdirSync(directory, { recursive: true });
  const frozenAssets = new Map(fs.readdirSync(path.join(root, 'dist/assets')).map(name => [name, sha(fs.readFileSync(path.join(root, 'dist/assets', name)))]));
  const checks = [], screenshots = [], profiles = [], requests = [], uploads = [], browserErrors = [], consoleErrors = [], assets = {}, receipts = [], accounts = {};
  const expectedHttpDiagnostics = new Set(), assetReads = [], faults = [];
  let service, database, browser, page;
  const check = message => { checks.push(message); console.log('PASS: ' + message); };
  const base = () => '/api/artifact-versions/' + service.project.id;
  const receiptPath = requestId => base() + '/imports/' + requestId;
  const region = target => target.getByRole('region', { name: 'Artifact versions', exact: true });
  const recovery = target => target.getByRole('region', { name: 'Artifact import recovery', exact: true });
  const countRows = async table => Number((await database.query(`SELECT COUNT(*) AS n FROM ${table}`)).rows[0].n);

  async function api(target, pathname, { method = 'GET', body, expected } = {}) {
    if (expected && expected >= 400) expectedHttpDiagnostics.add(`${expected} ${pathname}`);
    const response = await target.evaluate(async ({ pathname, method, body }) => {
      const response = await fetch(pathname, { method, credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-Traceomics-Csrf': '1' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, value: await response.json() };
    }, { pathname, method, body });
    if (expected) assert(response.status === expected, 'An exact artifact API boundary returned an unexpected status.');
    return response;
  }
  async function login(actor = 'owner') {
    const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    await context.exposeBinding('__recordOwnedArtifactUpload', (_source, observation) => {
      assert(uuid.test(observation.fields.requestId) && /^[a-f0-9]{64}$/.test(observation.file.sha256), 'The actual upload omitted its frozen UUID or exact file identity.');
      const normalized = { pathname: observation.pathname, fields: Object.fromEntries(Object.entries(observation.fields).sort(([a], [b]) => a.localeCompare(b))), file: observation.file };
      uploads.push({ actor, ...normalized, semanticSha256: sha(JSON.stringify(normalized)) });
    });
    await context.addInitScript(() => {
      const originalFetch = window.fetch;
      window.fetch = function (...args) {
        const [input, options] = args;
        const pathname = new URL(typeof input === 'string' ? input : input.url, location.href).pathname;
        if (options?.method === 'POST' && options.body instanceof FormData && /^\/api\/artifact-versions\/[^/]+(?:\/av_[a-f0-9]+\/versions)?$/.test(pathname)) {
          const form = options.body;
          // Chromium omits File payloads from request.postDataBuffer. Observe
          // the unchanged FormData handed to native fetch; accepted receipts
          // independently prove the exact bytes received by the real service.
          void (async () => {
            const fields = {}, file = form.get('file');
            for (const [key, value] of form.entries()) if (typeof value === 'string') fields[key] = value;
            const bytes = await file.arrayBuffer();
            const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
            await window.__recordOwnedArtifactUpload({ pathname, fields, file: { filename: file.name, sizeBytes: bytes.byteLength, sha256 } });
          })();
        }
        return Reflect.apply(originalFetch, this, args);
      };
    });
    const target = await context.newPage();
    target.on('pageerror', failure => browserErrors.push(failure.message));
    target.on('console', item => { if (item.type() === 'error') consoleErrors.push({ text: item.text(), url: item.location().url }); });
    target.on('request', request => {
      const pathname = new URL(request.url()).pathname;
      if (!pathname.startsWith('/api/')) return;
      requests.push({ actor, method: request.method(), pathname });
    });
    target.on('response', response => {
      const pathname = new URL(response.url()).pathname;
      if (!response.ok() || !pathname.startsWith('/assets/') || !pathname.endsWith('.js')) return;
      assetReads.push((async () => {
        const digest = sha(await response.body()); assets[pathname] = digest;
        assert(frozenAssets.get(pathname.split('/').at(-1)) === digest, 'Production assets changed during artifact recovery acceptance.');
      })().catch(failure => browserErrors.push(failure.message)));
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
  async function openArtifacts(target) {
    await nav(target, /^Data workspace,/);
    await target.getByRole('button', { name: new RegExp('^' + escaped(service.project.name) + '(?:$|\\s)') }).click();
    await nav(target, 'Runs & Results');
    const summary = target.locator('summary').filter({ hasText: /^Inspect or import artifact files$/ });
    await summary.waitFor();
    if (!(await summary.locator('..').evaluate(node => node.open))) await summary.click();
    await region(target).waitFor();
    await until(() => region(target).getByRole('button', { name: 'Refresh artifacts', exact: true }).isEnabled(), 'The actual artifact catalog did not finish loading.');
  }
  async function prepare(target, bytes, name, { filename = 'samples.csv', replace = false } = {}) {
    const area = region(target), file = area.getByLabel('Artifact file', { exact: true });
    await until(() => file.isEnabled(), 'The artifact import form did not become available for a fresh import.');
    await file.setInputFiles({ name: filename, mimeType: 'text/csv', buffer: bytes });
    await area.getByLabel('Artifact name', { exact: true }).fill(name);
    await area.getByLabel('Artifact purpose', { exact: true }).selectOption('sample-sheet');
    const replacement = area.getByLabel('New version of selected artifact', { exact: true });
    if (replace) await replacement.check(); else if (await replacement.count()) await replacement.uncheck();
  }
  async function submit(target, replace = false) {
    await region(target).getByRole('button', { name: replace ? 'Save new artifact version' : 'Import artifact', exact: true }).click();
  }
  async function normalImport(target, bytes, name, options) {
    await prepare(target, bytes, name, options);
    const pathname = options?.previousVersionId ? base() + '/' + options.previousVersionId + '/versions' : base();
    const waiting = target.waitForResponse(response => new URL(response.url()).pathname === pathname && response.request().method() === 'POST');
    await submit(target, !!options?.replace);
    const response = await waiting, version = await response.json();
    assert(response.ok() && version.versionId && version.importRequest?.status === 'succeeded', 'A genuine artifact upload did not return its saved version and exact receipt.');
    receipts.push({ requestId: version.importRequest.requestId, requestSha256: version.importRequest.requestSha256, acceptance: version.importRequest.acceptance });
    await select(target, version);
    return version;
  }
  async function reference(target) {
    const summary = region(target).locator('summary').filter({ hasText: /^Exact artifact reference$/ });
    await summary.waitFor();
    const details = summary.locator('..'), open = await details.evaluate(node => node.open);
    if (!open) await summary.click();
    const value = JSON.parse(await details.locator('pre').innerText());
    if (!open) await summary.click();
    return value;
  }
  async function selectedIs(target, version) {
    const referenceSummary = region(target).locator('summary').filter({ hasText: /^Exact artifact reference$/ });
    if (!(await referenceSummary.isVisible())) return false;
    return (await reference(target)).versionId === version.versionId;
  }
  async function select(target, version) {
    const name = new RegExp('^' + escaped(version.name) + ' · v' + version.versionNumber + '(?:$|\\s)');
    await region(target).getByRole('button', { name }).click();
    await region(target).getByText('Saved checksum verified · preview from this exact version', { exact: true }).waitFor();
    await until(() => selectedIs(target, version), 'Selecting a saved artifact did not inspect its exact identity.');
  }
  async function setTheme(target, desired) {
    if (await target.evaluate(() => document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light') === desired) return;
    const expand = target.getByRole('button', { name: 'Expand sidebar', exact: true }); if (await expand.isVisible()) await expand.click();
    await target.getByRole('button', { name: `Switch to ${desired} mode`, exact: true }).click();
    const collapse = target.getByRole('button', { name: 'Collapse sidebar', exact: true }); if (await collapse.isVisible()) await collapse.click();
    await until(async () => (await target.evaluate(() => document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light')) === desired, 'The rendered theme did not settle.');
  }
  async function capture(target, name, focus = region(target)) {
    await focus.scrollIntoViewIfNeeded();
    await target.waitForTimeout(350); // Existing sidebar/theme transition only.
    const width = await target.evaluate(() => ({ page: document.documentElement.scrollWidth, viewport: innerWidth }));
    assert(width.page <= width.viewport + 1, 'Artifact import recovery creates whole-page horizontal overflow.');
    const filename = name + '.png'; await target.screenshot({ path: path.join(directory, filename), fullPage: true });
    screenshots.push(filename); profiles.push({ filename, theme: await target.evaluate(() => document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'), viewport: target.viewportSize() });
  }
  async function matrix(target, prefix, focus) {
    for (const [width, height] of [[1366, 768], [1440, 900], [390, 844]]) {
      await target.setViewportSize({ width, height });
      for (const theme of ['light', 'dark']) { await setTheme(target, theme); await capture(target, `${prefix}-${theme}-${width}`, focus?.()); }
      if (width === 1366) {
        const expand = target.getByRole('button', { name: 'Expand sidebar', exact: true });
        if (await expand.isVisible()) await expand.click();
        await capture(target, `${prefix}-dark-${width}-expanded-sidebar`, focus?.());
      }
    }
  }
  async function frozenForm(target, expectedName) {
    const area = region(target);
    for (const label of ['Artifact file', 'Artifact name', 'Artifact purpose']) assert(await area.getByLabel(label, { exact: true }).isDisabled(), 'An unconfirmed import allowed its original file or settings to change.');
    assert(await area.getByLabel('Artifact name', { exact: true }).inputValue() === expectedName, 'The pending name no longer matches the frozen original import.');
    assert(await area.getByLabel('Artifact purpose', { exact: true }).inputValue() === 'sample-sheet', 'The pending purpose no longer matches the frozen original import.');
  }
  async function checkOutcome(target, requestId, status) {
    if (status >= 400) expectedHttpDiagnostics.add(`${status} ${receiptPath(requestId)}`);
    const waiting = target.waitForResponse(response => new URL(response.url()).pathname === receiptPath(requestId) && response.request().method() === 'GET');
    await recovery(target).getByRole('button', { name: 'Check import outcome', exact: true }).click();
    const response = await waiting, value = await response.json();
    assert(response.status() === status, 'Checking an exact import outcome returned an unexpected status.');
    return value;
  }
  async function assertNoSourceStorage(target) {
    const leaked = await target.evaluate(values => {
      const strings = [], visit = (value, depth = 0) => {
        if (depth > 8) return;
        if (typeof value === 'string') { strings.push(value); try { const parsed = JSON.parse(value); if (parsed !== value) visit(parsed, depth + 1); } catch { /* Ordinary preference. */ } }
        else if (value && typeof value === 'object') Object.values(value).forEach(item => visit(item, depth + 1));
      };
      for (const store of [localStorage, sessionStorage]) for (let index = 0; index < store.length; index++) visit(store.getItem(store.key(index)));
      return strings.some(text => values.some(value => text.includes(value) || text.includes(JSON.stringify(value).slice(1, -1))));
    }, [original, retried, dropped].map(value => value.toString('utf8')));
    assert(!leaked, 'Uploaded scientific file contents were persisted in browser Web Storage.');
  }

  try {
    service = await createDesktopTunnelServiceFixture({ artifactDirectory: directory, webEnvironment: { AUTH_RATE_LIMIT_MAX: '100' }, configureProjectEnvironment: async ({ env, account, project }) => {
      const seed = new Client({ connectionString: env.DATABASE_URL }); await seed.connect();
      try {
        const owner = (await seed.query('SELECT * FROM users WHERE email=$1', [account.email])).rows[0]; accounts.owner = { id: Number(owner.id), email: account.email };
        const organization = (await seed.query('SELECT organization_id FROM projects WHERE id=$1', [project.id])).rows[0];
        const email = 'artifact-colleague-' + crypto.randomBytes(8).toString('hex') + '@example.invalid';
        const colleague = (await seed.query('INSERT INTO users(email,password_hash,salt,display_name) VALUES($1,$2,$3,$4) RETURNING id', [email, owner.password_hash, owner.salt, 'Artifact colleague'])).rows[0];
        accounts.colleague = { id: Number(colleague.id), email };
        await seed.query("INSERT INTO organization_members(organization_id,user_id,role) VALUES($1,$2,'member')", [organization.organization_id, colleague.id]);
        await seed.query("INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,'viewer')", [project.id, colleague.id]);
      } finally { await seed.end(); }
      return {};
    } });
    database = new Client({ connectionString: service.databaseUrl }); await database.connect();
    const leaf = new crypto.X509Certificate(fs.readFileSync(service.certificatePath)), ca = new crypto.X509Certificate(fs.readFileSync(service.caCertificatePath));
    assert(leaf.verify(ca.publicKey) && leaf.checkHost(new URL(service.endpoint).hostname), 'The owned fixture TLS identity could not be verified.');
    browser = await chromium.launch({ headless: true, args: ['--host-resolver-rules=MAP ' + new URL(service.endpoint).hostname + ' 127.0.0.1',
      '--ignore-certificate-errors-spki-list=' + Buffer.from(sha(leaf.publicKey.export({ type: 'spki', format: 'der' })), 'hex').toString('base64')] });
    page = await login(); await openArtifacts(page);
    const first = await normalImport(page, original, 'Immutable sample sheet');
    assert(await region(page).getByRole('cell', { name: 'one, two', exact: true }).isVisible(), 'Actual quoted CSV bytes did not receive a checked table preview.');
    const second = await normalImport(page, revised, 'Immutable sample sheet', { replace: true, previousVersionId: first.versionId });
    assert(second.artifactId === first.artifactId && second.versionId !== first.versionId && second.previousVersionId === first.versionId, 'Appending an imported file did not retain logical and immutable version identity.');
    await select(page, first);
    assert((await reference(page)).sha256 === sha(original), 'The earlier version no longer binds the original full file bytes.');
    await matrix(page, 'verified-table', () => region(page).getByRole('table'));
    check('Genuine CSV upload and append preserve earlier bytes and exact identity; checked table rendering works in both themes at laptop and natural phone widths.');

    await page.setViewportSize({ width: 1366, height: 768 }); await setTheme(page, 'light');
    const other = await normalImport(page, unrelated, 'Unrelated selected reference');
    await select(page, second); await prepare(page, retried, 'Frozen original append', { replace: true });
    const appendPath = base() + '/' + second.versionId + '/versions';
    let aborted = false;
    const abortUpload = async route => {
      if (!aborted && route.request().method() === 'POST' && new URL(route.request().url()).pathname === appendPath) { aborted = true; await route.abort('failed'); }
      else await route.continue();
    };
    await page.route('**' + appendPath, abortUpload);
    await submit(page, true); await recovery(page).getByRole('button', { name: 'Check import outcome', exact: true }).waitFor();
    await until(() => aborted && uploads.at(-1)?.file.sha256 === sha(retried), 'The owned original upload did not reach its pre-upstream fault.');
    await until(() => recovery(page).getByRole('button', { name: 'Check import outcome', exact: true }).isEnabled(), 'The failed upload did not become available for an explicit outcome check.');
    await page.unroute('**' + appendPath, abortUpload);
    const originalAttempt = uploads.at(-1); assert(aborted && originalAttempt.file.sha256 === sha(retried), 'The original pre-upstream fault did not retain the exact outgoing bytes.');
    assert(await countRows('managed_artifact_versions') === 3, 'The aborted upstream request unexpectedly created a saved version.');
    const missing = await checkOutcome(page, originalAttempt.fields.requestId, 404);
    assert(missing.code === 'ARTIFACT_IMPORT_NOT_FOUND', 'An absent receipt was not identified as an unknown original outcome.');
    await frozenForm(page, 'Frozen original append');
    await select(page, other); await frozenForm(page, 'Frozen original append');
    const dispatchesBeforeReview = uploads.length;
    await matrix(page, 'missing-receipt-frozen', () => recovery(page));
    assert(uploads.length === dispatchesBeforeReview, 'A missing receipt or responsive review automatically dispatched another upload.');
    assert(await selectedIs(page, other), 'Checking an unknown import moved the unrelated selected preview.');
    await assertNoSourceStorage(page);
    await page.setViewportSize({ width: 1366, height: 768 });
    const retryReply = page.waitForResponse(response => new URL(response.url()).pathname === appendPath && response.request().method() === 'POST');
    await recovery(page).getByRole('button', { name: 'Retry original upload', exact: true }).click();
    const retriedResponse = await retryReply, third = await retriedResponse.json();
    assert(retriedResponse.ok() && third.importRequest?.status === 'succeeded', 'The explicit original upload retry did not succeed.');
    const repeated = uploads.at(-1);
    assert(repeated.semanticSha256 === originalAttempt.semanticSha256, 'Retry changed the original UUID, complete byte hash, filename, name, purpose or previous-version pointer.');
    assert(third.artifactId === first.artifactId && third.previousVersionId === second.versionId && third.importRequest.request.previousVersionId === second.versionId, 'Selection during uncertainty redirected the original append into another artifact.');
    await until(() => recovery(page).getByRole('button', { name: 'Inspect imported version', exact: true }).isVisible(), 'Confirmed retry did not expose explicit inspection.');
    assert(await selectedIs(page, other), 'A later successful retry redirected the unrelated selected inspection.');
    await recovery(page).getByRole('button', { name: 'Inspect imported version', exact: true }).click();
    await until(() => selectedIs(page, third), 'Explicit accepted-version inspection did not select its exact version.');
    await capture(page, 'explicit-retry-confirmed', recovery(page));
    receipts.push({ requestId: third.importRequest.requestId, requestSha256: third.importRequest.requestSha256, acceptance: third.importRequest.acceptance });
    check('A real pre-upstream failure followed by receipt404 stays uncertain and frozen; only explicit retry resends identical original bytes/settings/UUID, preserving another selected preview until explicit inspection.');

    await prepare(page, late, 'Late acknowledgement result');
    const held = service.interceptNextResponse({ method: 'POST', pathname: base(), mode: 'hold' }); faults.push(held);
    await submit(page); await until(() => !!held.observation()?.value?.versionId, 'The held upload did not actually commit before its acknowledgement was delayed.');
    await select(page, other); held.release();
    await until(() => recovery(page).getByRole('button', { name: 'Inspect imported version', exact: true }).isVisible(), 'The late actual upload acknowledgement did not become recoverable.');
    assert(await selectedIs(page, other), 'A late accepted upload acknowledgement stole the selected artifact preview.');
    await capture(page, 'late-acknowledgement-keeps-selection', recovery(page));
    check('An actual accepted upload with held acknowledgement does not redirect a newer artifact selection when its real response arrives.');

    await prepare(page, dropped, 'Accepted upload with lost reply', { filename: 'outside-results.csv' });
    const lost = service.interceptNextResponse({ method: 'POST', pathname: base(), mode: 'drop' }); faults.push(lost);
    await submit(page); await until(() => !!lost.observation()?.value?.versionId, 'The real lost-reply upload was not accepted upstream.');
    const accepted = lost.observation().value, acceptedUuid = accepted.importRequest.requestId;
    await recovery(page).getByRole('button', { name: 'Check import outcome', exact: true }).waitFor();
    await frozenForm(page, 'Accepted upload with lost reply');
    await select(page, other);
    const beforeRecovery = uploads.length;
    await database.query("UPDATE project_members SET role='viewer' WHERE project_id=$1 AND user_id=$2", [service.project.id, accounts.owner.id]);
    const confirmed = await checkOutcome(page, acceptedUuid, 200);
    assert(confirmed.status === 'succeeded' && confirmed.canImport === false && confirmed.acceptance.versionId === accepted.versionId
      && confirmed.request.sha256 === sha(dropped) && confirmed.availability === 'recorded', 'Current reader receipt recovery changed or misclassified the original accepted import.');
    assert(uploads.length === beforeRecovery && await selectedIs(page, other), 'Receipt recovery uploaded again or replaced unrelated inspection.');
    const fileControl = region(page).getByLabel('Artifact file', { exact: true });
    assert(!(await fileControl.count()) || await fileControl.isDisabled(), 'An inspection-only receipt restored fresh upload authority.');
    assert(!(await recovery(page).getByRole('button', { name: 'Retry original upload', exact: true }).count()), 'A confirmed accepted import still offered re-upload.');
    await matrix(page, 'reader-accepted-receipt', () => recovery(page));
    await recovery(page).getByRole('button', { name: 'Inspect imported version', exact: true }).click();
    await until(() => selectedIs(page, accepted), 'The reader could not explicitly inspect its accepted original file.');
    assert(await region(page).getByRole('cell', { name: 'accepted reply lost', exact: true }).isVisible(), 'Accepted reader inspection did not verify original bytes.');
    receipts.push({ requestId: acceptedUuid, requestSha256: confirmed.requestSha256, acceptance: confirmed.acceptance });
    await assertNoSourceStorage(page);
    check('A genuinely accepted but lost upload reply is recovered by exact GET receipt after owner-to-reader downgrade, without a second upload, selection theft or renewed writer controls.');

    // Remove exactly one file owned by this disposable fixture. Acceptance and
    // metadata remain; the receipt must never imply checksum verification.
    await select(page, other);
    const stored = (await database.query('SELECT storage_key FROM managed_artifact_versions WHERE id=$1 AND project_id=$2 AND owner_user_id=$3', [accepted.versionId, service.project.id, accounts.owner.id])).rows[0];
    assert(stored && stored.storage_key.startsWith(`projects/${service.project.id}/artifacts/${accepted.versionId}/`), 'The unavailable-source fixture did not identify its own exact accepted file.');
    const ownedRoot = path.resolve(service.storageRoot), ownedFile = path.resolve(ownedRoot, ...stored.storage_key.split('/'));
    assert(ownedFile.startsWith(ownedRoot + path.sep) && fs.lstatSync(ownedFile).isFile() && !fs.lstatSync(ownedFile).isSymbolicLink(), 'The unavailable-source target escaped owned storage.');
    fs.unlinkSync(ownedFile);
    const unavailable = await checkOutcome(page, acceptedUuid, 200);
    assert(unavailable.status === 'succeeded' && unavailable.availability === 'unavailable' && unavailable.version === null
      && unavailable.acceptance.versionId === accepted.versionId && unavailable.acceptance.sha256 === sha(dropped), 'Missing accepted bytes destroyed acceptance or claimed available verified contents.');
    await until(async () => /unavailable/i.test(await recovery(page).innerText()), 'The UI did not explain accepted but unavailable bytes.');
    assert(!(await recovery(page).getByRole('button', { name: 'Retry original upload', exact: true }).count()) && uploads.length === beforeRecovery,
      'Unavailable accepted bytes triggered or offered a duplicate original upload.');
    await capture(page, 'accepted-bytes-unavailable-dark-390', recovery(page));
    assert(await selectedIs(page, other), 'Unavailable receipt recovery redirected an unrelated checked preview.');
    check('Removing only owned accepted fixture bytes leaves immutable acceptance visible as unavailable, without re-upload or a false byte-verification claim.');

    const colleague = await login('colleague');
    await api(colleague, receiptPath(acceptedUuid), { expected: 404 });
    const privateList = await api(colleague, base(), { expected: 200 });
    assert(!privateList.value.items.some(item => item.versionId === accepted.versionId), 'A colleague discovered another account\'s private artifact version.');
    const probeId = crypto.randomUUID(); expectedHttpDiagnostics.add(`403 ${base()}`);
    const freshDenied = await page.evaluate(async ({ pathname, requestId }) => {
      const body = new FormData(); body.append('file', new Blob(['sample,condition\nx,control\n']), 'reader.csv'); body.append('artifactType', 'sample-sheet'); body.append('requestId', requestId);
      const response = await fetch(pathname, { method: 'POST', credentials: 'include', headers: { 'X-Traceomics-Csrf': '1' }, body });
      return { status: response.status, value: await response.json() };
    }, { pathname: base(), requestId: probeId });
    assert(freshDenied.status === 403, 'A current reader imported a fresh artifact through the actual API.');
    await database.query('DELETE FROM project_members WHERE project_id=$1 AND user_id=$2', [service.project.id, accounts.owner.id]);
    await api(page, receiptPath(acceptedUuid), { expected: 404 });
    assert(await countRows('managed_artifact_versions') === 6 && await countRows('managed_artifact_import_receipts') === 6, 'Recovery, denied probes or missing bytes duplicated or deleted immutable artifact records.');
    check('Actual colleague privacy, current-reader fresh-write denial and revoked membership keep accepted private receipts and files within current access boundaries.');

    const firstStored = (await database.query('SELECT storage_key FROM managed_artifact_versions WHERE id=$1', [first.versionId])).rows[0];
    const firstPath = path.resolve(service.storageRoot, ...firstStored.storage_key.split('/'));
    assert(firstPath.startsWith(path.resolve(service.storageRoot) + path.sep) && sha(fs.readFileSync(firstPath)) === sha(original), 'Later uploads or recovery changed original immutable bytes.');
    for (const table of ['jobs', 'private_r_kernels', 'private_r_executions']) assert(await countRows(table) === 0, 'Artifact import recovery admitted scientific execution.');
    const science = requests.filter(item => item.method === 'POST' && (/^\/api\/r\//.test(item.pathname) || /^\/api\/private-r-kernels(?:\/|$)/.test(item.pathname) || /^\/api\/projects\/[^/]+\/jobs$/.test(item.pathname)));
    assert(science.length === 0, 'An artifact recovery operation dispatched scientific computation.');
    await Promise.all(assetReads);
    const faultPaths = new Set([base(), appendPath]);
    const networkFault = entry => /^Failed to load resource: net::ERR_(?:FAILED|CONTENT_LENGTH_MISMATCH|EMPTY_RESPONSE|INCOMPLETE_CHUNKED_ENCODING|CONNECTION_CLOSED|CONNECTION_RESET)/.test(entry.text)
      && faultPaths.has(new URL(entry.url).pathname);
    const allowedHttp = entry => {
      const status = /status of (\d+)/.exec(entry.text)?.[1]; if (!status) return false;
      let pathname; try { pathname = new URL(entry.url).pathname; } catch { return false; }
      return status === '401' && pathname === '/api/auth/session' || status === '404' && pathname === '/api/r/session-id'
        || expectedHttpDiagnostics.has(`${status} ${pathname}`);
    };
    assert(consoleErrors.filter(networkFault).length <= 2, 'Network failures occurred beyond the deliberate upstream abort and accepted lost reply.');
    assert(browserErrors.length === 0 && consoleErrors.every(entry => networkFault(entry) || allowedHttp(entry)), 'The production UI raised an unexpected browser/React/transport error or changed compiled assets.');
    check('All checks use unchanged production assets and real auth/storage; zero scientific jobs, kernels or execution requests and no unexpected browser errors.');
    const result = { passed: true, checks, screenshots, profiles, compiledAssets: assets, receipts, uploads, browserErrors, consoleErrors,
      explicitlyExpectedHttpDiagnostics: [...expectedHttpDiagnostics], scientificDispatchCount: science.length,
      fixture: 'Owned disposable production HTTPS/auth/PostgreSQL/storage with health-only R stub; synthetic CSV files, one pre-upstream browser abort, one real held acknowledgement and one genuine accepted-response drop.',
      limitations: ['No scientific execution, SSH transport or large-file performance claim.', 'Acceptance receipt proves recorded import identity; only separate successful inspection verifies current bytes.'] };
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result, null, 2) + '\n');
    console.log('Artifact import recovery acceptance: ' + directory); return result;
  } catch (failure) {
    await page?.screenshot({ path: path.join(directory, 'failure.png'), fullPage: true }).catch(() => {});
    const tree = await page?.locator('main').ariaSnapshot().catch(() => null); if (tree) fs.writeFileSync(path.join(directory, 'failure-accessibility.txt'), tree);
    let message = failure.message;
    for (const secret of [service?.databaseUrl, service?.storageRoot, service?.account?.password, ...Object.values(accounts).map(account => account.email)].filter(Boolean)) message = message.split(secret).join('[private fixture]');
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ passed: false, checks, screenshots, profiles, error: message, browserErrors, consoleErrors, compiledAssets: assets, receipts, uploads }, null, 2) + '\n');
    throw new Error(message);
  } finally {
    for (const fault of faults) fault.release();
    await browser?.close(); await database?.end(); await service?.stop();
  }
}

if (require.main === module) main().catch(failure => { console.error(failure.message); process.exitCode = 1; });
module.exports = { main };
