#!/usr/bin/env node
'use strict';

// Actual private text-checkpoint recovery. Scientific runtimes are never started.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require('playwright');
const { Client } = require('pg');
const { createDesktopTunnelServiceFixture } = require('./desktop-tunnel-service-fixture.cjs');
const root = path.resolve(__dirname, '..');
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const escaped = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
async function until(check, message, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 75)); }
  throw new Error(message);
}

async function main({ artifactDirectory } = {}) {
  const directory = path.resolve(artifactDirectory || path.join(root, 'playwright/report', 'notebook-drafts-' + Date.now()));
  assert(directory.startsWith(path.join(root, 'playwright/report') + path.sep), 'Private draft evidence must stay in ignored report storage.');
  assert(fs.existsSync(path.join(root, 'dist/index.html')), 'A frozen production build is required.');
  fs.mkdirSync(directory, { recursive: true });
  const expected = new Map(fs.readdirSync(path.join(root, 'dist/assets')).map(name => [name, sha(fs.readFileSync(path.join(root, 'dist/assets', name)))]));
  const checks = [], screenshots = [], assets = {}, requests = [], errors = [];
  const check = message => { checks.push(message); console.log('PASS: ' + message); };
  let service, database, browser, page, analysis, original, viewerAccount;
  const analysesPath = () => `/api/projects/${service.project.id}/analyses`;
  const documentsPath = () => `${analysesPath()}/${analysis.id}/documents`;
  const documentPath = () => `${documentsPath()}/${original.id}`;
  const draftPath = () => `${documentPath()}/draft`;
  const recovery = target => target.getByRole('region', { name: 'Private draft recovery', exact: true });
  const outline = target => target.getByRole('navigation', { name: 'Documents and sections', exact: true });
  const inspector = (target, title) => target.locator('dialog').filter({ has: target.getByRole('heading', { name: title, exact: true }) });
  async function api(target, url, { method = 'GET', body } = {}) {
    return target.evaluate(async ({ url, method, body }) => {
      const response = await fetch(url, { method, credentials: 'include', headers: { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, value: await response.json() };
    }, { url, method, body });
  }
  async function login(account) {
    const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    const target = await context.newPage();
    target.on('pageerror', error => errors.push(error.message));
    target.on('request', request => {
      const pathname = new URL(request.url()).pathname;
      if (!pathname.startsWith('/api/')) return;
      const record = { method: request.method(), pathname };
      if (record.method === 'PUT' && pathname.endsWith('/draft')) {
        try { const body = request.postDataJSON(); record.requestId = body.requestId; record.payloadSha256 = sha(JSON.stringify(body)); } catch { /* Invalid transport is observable through the UI. */ }
      }
      requests.push(record);
    });
    target.on('response', async response => {
      const pathname = new URL(response.url()).pathname;
      if (response.ok() && pathname.startsWith('/assets/') && pathname.endsWith('.js')) {
        try { const value = sha(await response.body()); assets[pathname] = value;
          if (expected.get(pathname.split('/').at(-1)) !== value) errors.push('Compiled assets changed during private-draft acceptance.');
        } catch { /* Actual load failures fail the UI flow. */ }
      }
    });
    await target.goto(service.endpoint);
    await target.getByPlaceholder('researcher@lab.edu').fill(account.email);
    await target.getByLabel('Password', { exact: true }).fill(service.account.password);
    await target.getByRole('button', { name: /Open Workbench/ }).click();
    await target.getByText('Connection details', { exact: true }).waitFor();
    return target;
  }
  async function navigation(target, name) {
    const expand = target.getByRole('button', { name: 'Expand sidebar', exact: true }); if (await expand.isVisible()) await expand.click();
    await target.getByRole('button', { name, exact: typeof name === 'string' }).click();
  }
  async function openDocuments(target) {
    await navigation(target, /^Data workspace,/);
    await target.getByRole('button', { name: new RegExp('^' + escaped(service.project.name) + '(?:$|\\s)') }).click();
    await navigation(target, 'Analyses');
    const list = target.getByRole('region', { name: 'Project analyses', exact: true });
    if (analysis.status === 'archived') await list.getByLabel('Analysis status', { exact: true }).selectOption('archived');
    await list.getByRole('button', { name: new RegExp('^' + escaped(analysis.name) + '(?:$|\\s)') }).click();
    await target.getByRole('region', { name: 'Selected analysis', exact: true }).getByRole('button', { name: 'Open documents', exact: true }).click();
    await selectDocument(target, original.title);
  }
  async function selectDocument(target, title) {
    await until(async () => {
      if (await outline(target).isVisible()) return true;
      const disclosure = target.locator('summary:visible').filter({ hasText: 'Documents and sections' });
      if (await disclosure.count()) await disclosure.click({ timeout: 500 }).catch(() => {});
      return outline(target).isVisible();
    }, 'Document outline did not become usable.');
    await outline(target).getByRole('button', { name: new RegExp('^' + escaped(title) + '\\s+\\d+\\s+cells?\\b') }).click();
    await until(async () => (await target.getByLabel('Notebook title', { exact: true }).inputValue()) === title, 'Document selection did not settle.');
  }
  async function edit(target, source) {
    const region = target.getByRole('region', { name: 'R cell 1', exact: true });
    await region.getByRole('button', { name: 'Edit source', exact: true }).click();
    const editor = target.getByRole('textbox', { name: 'R cell 1 source', exact: true }); await editor.fill(source); return editor;
  }
  async function checkpointed(target, source) {
    await until(async () => {
      const result = await api(target, draftPath());
      return result.status === 200 && result.value.draft?.content.cells[0].source === source;
    }, 'Exact private source did not reach the authorized workspace.');
    await until(async () => (await target.getByRole('status').allTextContents()).some(value => value.includes('Private draft checkpointed.')), 'Private checkpoint was not confirmed in the UI.');
  }
  async function capture(target, name, theme) {
    await target.waitForTimeout(350); // Finish existing navigation/palette CSS transitions for visual evidence, not a performance sample.
    const actual = await target.evaluate(() => document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light');
    if (theme) assert(theme === actual, 'Capture theme is not the actual rendered theme.');
    const widths = await target.evaluate(() => ({ viewport: innerWidth, page: document.documentElement.scrollWidth }));
    assert(widths.page <= widths.viewport + 1, 'Private recovery layout causes whole-page horizontal overflow.');
    const filename = name + '.png'; await target.screenshot({ path: path.join(directory, filename), fullPage: true });
    screenshots.push({ filename, theme: actual, viewport: target.viewportSize() });
  }
  async function theme(target, desired) {
    const current = await target.evaluate(() => document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light');
    if (current === desired) return;
    const expand = target.getByRole('button', { name: 'Expand sidebar', exact: true }); if (await expand.isVisible()) await expand.click();
    await target.getByRole('button', { name: `Switch to ${desired} mode`, exact: true }).click();
    const collapse = target.getByRole('button', { name: 'Collapse sidebar', exact: true }); if (await collapse.isVisible()) await collapse.click();
  }
  try {
    service = await createDesktopTunnelServiceFixture({ artifactDirectory: directory, configureProjectEnvironment: async ({ env, account, project }) => {
      const client = new Client({ connectionString: env.DATABASE_URL }); await client.connect();
      try {
        const owner = (await client.query('SELECT * FROM users WHERE email=$1', [account.email])).rows[0];
        const email = 'draft-viewer-' + crypto.randomBytes(8).toString('hex') + '@example.invalid';
        const viewer = (await client.query('INSERT INTO users(email,password_hash,salt,display_name) VALUES($1,$2,$3,$4) RETURNING id',
          [email, owner.password_hash, owner.salt, 'Private draft reader'])).rows[0]; viewerAccount = { email, id: Number(viewer.id) };
        const organization = (await client.query('SELECT organization_id FROM projects WHERE id=$1', [project.id])).rows[0];
        await client.query("INSERT INTO organization_members(organization_id,user_id,role) VALUES($1,$2,'member')", [organization.organization_id, viewer.id]);
        await client.query("INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,'viewer')", [project.id, viewer.id]);
      } finally { await client.end(); }
      return {};
    } });
    database = new Client({ connectionString: service.databaseUrl }); await database.connect();
    const leaf = new crypto.X509Certificate(fs.readFileSync(service.certificatePath)), ca = new crypto.X509Certificate(fs.readFileSync(service.caCertificatePath));
    assert(leaf.verify(ca.publicKey) && leaf.checkHost(new URL(service.endpoint).hostname), 'Fixture HTTPS identity was not verified.');
    browser = await chromium.launch({ headless: true, args: ['--host-resolver-rules=MAP ' + new URL(service.endpoint).hostname + ' 127.0.0.1',
      '--ignore-certificate-errors-spki-list=' + Buffer.from(sha(leaf.publicKey.export({ type: 'spki', format: 'der' })), 'hex').toString('base64')] });
    page = await login(service.account);
    const created = await api(page, analysesPath(), { method: 'POST', body: { requestId: crypto.randomUUID(), name: 'Recover scientific writing' } });
    assert(created.status === 201, 'Could not prepare the shared analysis.'); analysis = created.value.analysis;
    const savedSource = '# Confirmed shared source\nshared_cells <- 100L';
    const content = { schema: 'traceomics.notebook.v1', defaultLanguage: 'R', cells: [{ id: 'inspect', type: 'code', language: 'R', source: savedSource },
      ...Array.from({ length: 12 }, (_, index) => ({ id: 'note-' + index, type: 'markdown', source: `## Evidence ${index + 1}\n\nKeep donor replication explicit.` }))] };
    const result = await api(page, documentsPath(), { method: 'POST', body: { requestId: crypto.randomUUID(), title: 'Private recovery evidence', content } });
    assert(result.status === 201, 'Could not prepare the saved notebook.'); original = result.value.document;
    await openDocuments(page);
    const privateA = '# My private alternative\nprivate_cells <- 2638L'; await edit(page, privateA); await checkpointed(page, privateA);
    const acceptedA = (await api(page, draftPath())).value.draft;
    assert((await api(page, documentPath())).value.document.content.cells[0].source === savedSource, 'Private autosave changed shared saved source.');
    assert(Number((await database.query('SELECT COUNT(*) AS n FROM research_document_revisions')).rows[0].n) === 1, 'Private typing appended immutable saved versions.');
    await capture(page, 'confirmed-private-draft-light-1366', 'light');
    await page.context().close(); page = await login(service.account); await openDocuments(page);
    await recovery(page).waitFor(); assert((await api(page, draftPath())).value.draft.sha256 === acceptedA.sha256, 'Whole-app reopening changed the confirmed private snapshot.');
    await page.getByRole('button', { name: 'Review private draft', exact: true }).click();
    const privateDialog = inspector(page, 'Private draft'); await privateDialog.waitFor();
    assert((await privateDialog.innerText()).includes(privateA), 'Private inspector did not show exact checkpointed source.');
    await capture(page, 'reopened-private-inspector-light-1366', 'light'); await page.getByRole('button', { name: 'Close inspector', exact: true }).click();
    await page.getByRole('button', { name: 'Restore private draft', exact: true }).click();
    await page.getByRole('button', { name: 'Saved source', exact: true }).click();
    const savedDialog = inspector(page, 'Saved source'); await savedDialog.waitFor();
    assert((await savedDialog.innerText()).includes(savedSource) && !(await savedDialog.innerText()).includes(privateA), 'Saved-source inspector showed private working code.');
    await page.getByRole('button', { name: 'Close inspector', exact: true }).click();
    check('Exact private source survives a fresh authenticated application context; explicit review/restore stays separate from immutable shared saved source.');

    const dropped = service.interceptNextResponse({ method: 'PUT', pathname: draftPath(), mode: 'drop' });
    const privateB = '# Checkpoint B\nprivate_value <- 2L'; await edit(page, privateB);
    await until(() => Boolean(dropped.observation()), 'The deliberately lost checkpoint did not commit.');
    await page.getByRole('button', { name: 'Retry private autosave', exact: true }).waitFor();
    const admitted = requests.filter(request => request.pathname === draftPath() && request.method === 'PUT').at(-1);
    const publishC = '# Shared source C\nprivate_value <- 3L'; await edit(page, publishC);
    const sharing = page.waitForResponse(response => new URL(response.url()).pathname === documentPath() && response.request().method() === 'PUT');
    await page.getByRole('button', { name: 'Save notebook', exact: true }).click(); assert((await sharing).status() === 200, 'Shared save did not await confirmed private source.');
    await until(async () => (await api(page, documentPath())).value.document.content.cells[0].source === publishC, 'The chosen current source was not saved.');
    await until(async () => (await api(page, draftPath())).value.draft === null, 'The exact published private checkpoint did not clear.');
    const repeats = requests.filter(request => request.requestId === admitted.requestId);
    assert(repeats.length === 2 && repeats.every(request => request.payloadSha256 === admitted.payloadSha256), 'Uncertain private recovery changed its UUID or admitted payload.');
    check('A lost actual private checkpoint reply retries its original UUID, then confirms newer text before sharing; shared history and private cleanup remain separate.');

    const navigationReply = await api(page, documentsPath(), { method: 'POST', body: { requestId: crypto.randomUUID(), title: 'Navigation checkpoint',
      content: { schema: 'traceomics.notebook.v1', defaultLanguage: 'R', cells: [{ id: 'navigation', type: 'code', language: 'R', source: 'navigation_source <- TRUE' }] } } });
    assert(navigationReply.status === 201, 'Could not prepare independent document navigation.');
    const navigationDocument = navigationReply.value.document;
    await page.getByRole('button', { name: 'Refresh documents', exact: true }).click();
    const secondWindow = await login(service.account); await openDocuments(secondWindow);
    const firstWindowSource = '# Window A private source\nwindow_value <- "A"';
    await edit(page, firstWindowSource); await checkpointed(page, firstWindowSource);
    const secondWindowSource = '# Window B alternative\nwindow_value <- "B"'; await edit(secondWindow, secondWindowSource);
    await recovery(secondWindow).waitFor();
    assert((await secondWindow.getByRole('textbox', { name: 'R cell 1 source', exact: true }).innerText()) === secondWindowSource, 'Private CAS replaced this window alternative.');
    assert((await api(secondWindow, draftPath())).value.draft.content.cells[0].source === firstWindowSource, 'Private CAS overwrote the previously confirmed other window.');
    await secondWindow.getByRole('button', { name: 'Review private draft', exact: true }).click();
    assert((await inspector(secondWindow, 'Private draft').innerText()).includes(firstWindowSource), 'Private conflict review lost the competing source.');
    await secondWindow.getByRole('button', { name: 'Close inspector', exact: true }).click();
    await theme(secondWindow, 'dark'); await secondWindow.setViewportSize({ width: 1440, height: 900 }); await capture(secondWindow, 'two-window-private-conflict-dark-1440', 'dark');
    await secondWindow.setViewportSize({ width: 390, height: 844 }); await capture(secondWindow, 'private-recovery-dark-390', 'dark');
    await theme(secondWindow, 'light'); await capture(secondWindow, 'private-recovery-light-390', 'light');
    const copying = secondWindow.waitForResponse(response => new URL(response.url()).pathname === documentsPath() && response.request().method() === 'POST');
    await secondWindow.getByRole('button', { name: 'Save current edits as a new document', exact: true }).click();
    const copyReply = await copying; assert(copyReply.status() === 201, 'Explicit preserve-both action did not create a separate document.');
    const copy = (await copyReply.json()).document;
    assert(copy.id !== original.id && copy.content.cells[0].source === secondWindowSource, 'Explicit copy changed or lost the local alternative.');
    await selectDocument(secondWindow, original.title); await recovery(secondWindow).waitFor();
    await secondWindow.getByRole('button', { name: 'Keep current source', exact: true }).click(); await checkpointed(secondWindow, secondWindowSource);
    assert((await api(secondWindow, documentPath())).value.document.content.cells[0].source === publishC, 'Private conflict resolution replaced shared saved source.');
    check('Two real sessions for the same account reject stale private CAS; review/copy/discard choices retain both scientific alternatives without last-write-wins replacement.');

    await selectDocument(page, navigationDocument.title); await selectDocument(page, original.title); await recovery(page).waitFor();
    const stillLocal = page.getByRole('textbox', { name: 'R cell 1 source', exact: true });
    if (!await stillLocal.count()) await page.getByRole('region', { name: 'R cell 1', exact: true }).getByRole('button', { name: 'Edit source', exact: true }).click();
    assert((await stillLocal.innerText()) === firstWindowSource, 'Ordinary document reopen replaced the retained local copy.');
    const writesBefore = requests.filter(request => request.method === 'PUT' && request.pathname === draftPath()).length;
    const localZ = '# Reopened local source Z\nwindow_value <- "Z"'; await edit(page, localZ);
    await page.getByRole('button', { name: 'Save notebook', exact: true }).click();
    await page.waitForTimeout(1200); // Exercise the real autosave debounce after the competing private read.
    assert(requests.filter(request => request.method === 'PUT' && request.pathname === draftPath()).length === writesBefore,
      'Ordinary reopen silently advanced CAS and overwrote an unseen other-window draft.');
    assert((await api(page, draftPath())).value.draft.content.cells[0].source === secondWindowSource, 'Unseen competing private source was overwritten.');
    await capture(page, 'reopen-unseen-private-copy-light-1366', 'light');
    await page.getByRole('button', { name: 'Keep current source', exact: true }).click(); await checkpointed(page, localZ);
    const beforeClear = (await api(secondWindow, draftPath())).value;
    const cleared = await api(secondWindow, draftPath(), { method: 'DELETE', body: { requestId: crypto.randomUUID(), expectedDraftVersion: beforeClear.draftVersion } });
    assert(cleared.status === 200 && cleared.value.draft === null, 'Other-window private removal did not commit.');
    await selectDocument(page, navigationDocument.title); await selectDocument(page, original.title);
    await page.getByRole('button', { name: 'Retry private autosave', exact: true }).waitFor();
    const afterClearCount = requests.filter(request => request.method === 'PUT' && request.pathname === draftPath()).length;
    const localAfterClear = localZ + '\n# Not checkpointed after remote removal'; await edit(page, localAfterClear); await page.waitForTimeout(1200);
    assert((await api(page, draftPath())).value.draft === null && requests.filter(request => request.method === 'PUT' && request.pathname === draftPath()).length === afterClearCount,
      'Local editing silently recreated another window private-draft removal.');
    await capture(page, 'remote-clear-unconfirmed-light-1366', 'light');
    await page.getByRole('button', { name: 'Retry private autosave', exact: true }).click(); await checkpointed(page, localAfterClear);
    check('Document-away/back detects unseen newer private source and remote removal, preserving local edits and requiring an explicit choice before any new checkpoint.');

    const viewer = await login(viewerAccount); await openDocuments(viewer);
    assert(!(await recovery(viewer).count()), 'Project viewer discovered another account private recovery.');
    assert((await api(viewer, draftPath())).value.draft === null, 'Private source leaked through viewer API.');
    const privateWrite = await api(viewer, draftPath(), { method: 'PUT', body: { requestId: crypto.randomUUID(), expectedDraftVersion: 0,
      baseVersion: original.version, baseVersionId: original.versionId, title: 'Forbidden copy', content: original.content } });
    assert(privateWrite.status === 403, 'Project viewer admitted a private source write.');
    await capture(viewer, 'viewer-no-private-source-light-1366', 'light');
    await page.getByRole('button', { name: 'Analysis overview', exact: true }).click();
    const selected = page.getByRole('region', { name: 'Selected analysis', exact: true });
    const archiving = page.waitForResponse(response => new URL(response.url()).pathname === analysesPath() + '/' + analysis.id && response.request().method() === 'PATCH');
    await selected.getByRole('button', { name: 'Archive', exact: true }).click(); assert((await archiving).status() === 200, 'Analysis archive did not persist.');
    analysis = { ...analysis, status: 'archived' }; await page.context().close(); page = await login(service.account); await openDocuments(page);
    await recovery(page).waitFor(); await page.getByRole('button', { name: 'Restore private draft', exact: true }).click();
    const view = page.getByRole('region', { name: 'R cell 1', exact: true }); await view.getByRole('button', { name: 'View source', exact: true }).click();
    assert((await page.getByRole('textbox', { name: 'R cell 1 source', exact: true }).getAttribute('contenteditable')) === 'false', 'Archived private recovery became writable.');
    assert(!(await page.getByRole('button', { name: 'Save notebook', exact: true }).count()), 'Archived analysis exposed new source commits.');
    await capture(page, 'archived-private-recovery-light-1366', 'light');
    check('Private source is hidden from another project account; archived analyses retain owner-only read recovery while editing is disabled.');
    const owner = (await database.query('SELECT id FROM users WHERE email=$1', [service.account.email])).rows[0];
    await database.query('DELETE FROM project_members WHERE project_id=$1 AND user_id=$2', [service.project.id, owner.id]);
    assert((await api(page, draftPath())).status === 404 && (await api(page, documentPath())).status === 404,
      'Revoked membership retained access to private or shared source.');
    check('Current membership is checked again after revocation; prior private recovery does not preserve a source-access grant.');

    const scientific = requests.filter(request => request.method === 'POST' && (/^\/api\/r\//.test(request.pathname)
      || /^\/api\/private-r-kernels(?:\/|$)/.test(request.pathname) || /^\/api\/projects\/[^/]+\/jobs$/.test(request.pathname)));
    assert(scientific.length === 0 && Number((await database.query('SELECT COUNT(*) AS n FROM jobs')).rows[0].n) === 0
      && Number((await database.query('SELECT COUNT(*) AS n FROM private_r_kernels')).rows[0].n) === 0, 'Text autosave started scientific computation.');
    assert(errors.length === 0, 'Private recovery raised an uncaught browser error or changed compiled assets.');
    check('Autosave, restart recovery and conflict resolution start zero scientific jobs/kernels and produce no uncaught browser errors.');
    const report = { passed: true, checks, screenshots, compiledAssets: assets, browserErrors: errors, scientificDispatchCount: scientific.length,
      fixture: 'Owned disposable production HTTPS/auth/PostgreSQL/storage; health-only R service, no scientific runtime',
      exclusions: ['Pending shared create/save UUID recovery after full application closure (NB-04b)', 'Offline source persistence', 'Notebook execution', 'Physical Linux/SSH performance', 'Full editor undo history after application closure (NB-08)'] };
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(report, null, 2) + '\n');
    console.log('Private draft UI acceptance passed; report: ' + directory); return report;
  } catch (error) {
    await page?.screenshot({ path: path.join(directory, 'failure.png'), fullPage: true }).catch(() => {});
    const snapshot = await page?.locator('main').ariaSnapshot().catch(() => null); if (snapshot) fs.writeFileSync(path.join(directory, 'failure-accessibility.txt'), snapshot);
    let message = error.message;
    for (const secret of [service?.databaseUrl, service?.storageRoot, service?.account?.password, viewerAccount?.email].filter(Boolean)) message = message.split(secret).join('[private fixture]');
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ passed: false, checks, screenshots, error: message, browserErrors: errors, compiledAssets: assets }, null, 2) + '\n');
    throw new Error(message);
  } finally { await browser?.close(); await database?.end(); await service?.stop(); }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
