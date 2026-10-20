'use strict';

// Production-browser acceptance. The service persists real source;
// the disposable ingress loses selected completed replies. No science executes.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require('playwright');
const { Client } = require('pg');
const { createDesktopTunnelServiceFixture } = require('./desktop-tunnel-service-fixture.cjs');
const root = path.resolve(__dirname, '..');
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const escaped = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const exact = value => new RegExp('^' + escaped(value) + '(?:$|\\s)');
const row = value => new RegExp('^' + escaped(value) + '\\s+(?:Script|(?:R|Python) script|\\d+\\s+cells?)\\b');
async function until(check, message, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 75)); }
  throw new Error(message);
}
async function main() {
  const directory = path.join(root, 'playwright/report', 'notebook-pending-' + Date.now());
  assert(fs.existsSync(path.join(root, 'dist/index.html')), 'A coordinated production build is required.');
  fs.mkdirSync(directory, { recursive: true });
  const frozen = new Map(fs.readdirSync(path.join(root, 'dist/assets')).map(name => [name, sha(fs.readFileSync(path.join(root, 'dist/assets', name)))]));
  const checks = [], screenshots = [], errors = [], requests = [], assets = {}, accounts = {}, operations = [];
  let service, database, browser, page, launchOptions;
  const check = message => { checks.push(message); console.log('PASS: ' + message); };
  const analysesPath = () => `/api/projects/${service.project.id}/analyses`;
  const documentsPath = analysis => `${analysesPath()}/${analysis.id}/documents`;
  const documentPath = (analysis, doc) => documentsPath(analysis) + '/' + doc.id;
  const createJournalPath = analysis => documentsPath(analysis) + '/pending/create';
  const saveJournalPath = (analysis, doc) => documentPath(analysis, doc) + '/pending';
  const outline = target => target.getByRole('navigation', { name: 'Documents and sections', exact: true });
  const importPanel = target => target.getByRole('form', { name: 'Import script', exact: true });
  async function api(target, url, { method = 'GET', body } = {}) {
    return target.evaluate(async ({ url, method, body }) => {
      const response = await fetch(url, { method, credentials: 'include', headers: { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, value: await response.json() };
    }, { url, method, body });
  }
  async function login(account = accounts.owner, viewport = { width: 1366, height: 768 }) {
    const context = await browser.newContext({ viewport, acceptDownloads: true });
    const target = await context.newPage();
    target.on('pageerror', error => errors.push(error.message));
    target.on('request', request => {
      const pathname = new URL(request.url()).pathname;
      if (!pathname.startsWith('/api/')) return;
      const item = { method: request.method(), pathname };
      if (['POST', 'PUT', 'DELETE'].includes(item.method) && pathname.includes('/documents')) {
        try { const body = request.postDataJSON(); item.requestId = body?.payload?.requestId || body?.requestId;
          item.bodySha256 = sha(JSON.stringify(body)); item.admittedVersion = body?.admittedVersion; } catch { /* Transport failures remain observable. */ }
      }
      requests.push(item);
    });
    target.on('response', async response => {
      const pathname = new URL(response.url()).pathname;
      if (!response.ok() || !pathname.startsWith('/assets/') || !pathname.endsWith('.js')) return;
      try { const digest = sha(await response.body()); assets[pathname] = digest;
        if (frozen.get(pathname.split('/').at(-1)) !== digest) errors.push('Production assets changed during independent acceptance.');
      } catch { /* Page loads also have to succeed. */ }
    });
    await target.goto(service.endpoint);
    await target.getByPlaceholder('researcher@lab.edu').fill(account.email);
    await target.getByLabel('Password', { exact: true }).fill(service.account.password);
    await target.getByRole('button', { name: /Open Workbench/ }).click();
    await target.getByText('Connection details', { exact: true }).waitFor();
    return target;
  }
  async function restart(account = accounts.owner) {
    await browser.close(); browser = await chromium.launch(launchOptions); page = await login(account); return page;
  }
  async function navigate(target, name) {
    const expand = target.getByRole('button', { name: 'Expand sidebar', exact: true });
    if (await expand.isVisible()) await expand.click();
    await target.getByRole('button', { name, exact: typeof name === 'string' }).click();
  }
  async function openDocuments(target, analysis) {
    await navigate(target, /^Data workspace,/);
    await target.getByRole('button', { name: exact(service.project.name) }).click();
    await navigate(target, 'Analyses');
    const overview = target.getByRole('button', { name: 'Analysis overview', exact: true });
    if (await overview.isVisible()) await overview.click();
    const list = target.getByRole('region', { name: 'Project analyses', exact: true });
    await list.getByRole('button', { name: 'Refresh analyses', exact: true }).click();
    if (analysis.status === 'archived') await list.getByLabel('Analysis status', { exact: true }).selectOption('archived');
    await list.getByRole('button', { name: exact(analysis.name) }).click();
    await target.getByRole('region', { name: 'Selected analysis', exact: true }).getByRole('button', { name: 'Open documents', exact: true }).click();
    await target.getByRole('region', { name: 'Document work area', exact: true }).waitFor();
  }
  async function ensureOutline(target) {
    await until(async () => {
      if (await outline(target).isVisible()) return true;
      const summary = target.locator('summary:visible').filter({ hasText: 'Documents and sections' });
      if (await summary.count()) await summary.click({ timeout: 500 }).catch(() => {});
      return outline(target).isVisible();
    }, 'The document outline did not become usable.');
  }
  async function select(target, title, script = false) {
    await ensureOutline(target); await outline(target).getByRole('button', { name: row(title) }).click();
    await until(async () => (await target.getByLabel(script ? 'Script title' : 'Notebook title', { exact: true }).inputValue()) === title, 'Saved source selection did not settle.');
  }
  async function capture(target, name) {
    await target.waitForTimeout(250);
    const theme = await target.evaluate(() => document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light');
    const widths = await target.evaluate(() => ({ viewport: innerWidth, page: document.documentElement.scrollWidth }));
    assert(widths.page <= widths.viewport + 1, 'Shared-source recovery causes whole-page horizontal overflow.');
    const filename = name + '.png'; await target.screenshot({ path: path.join(directory, filename), fullPage: true });
    screenshots.push({ filename, theme, viewport: target.viewportSize() });
  }
  async function theme(target, desired) {
    if (await target.evaluate(() => document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light') === desired) return;
    const expand = target.getByRole('button', { name: 'Expand sidebar', exact: true }); if (await expand.isVisible()) await expand.click();
    await target.getByRole('button', { name: `Switch to ${desired} mode`, exact: true }).click();
    const collapse = target.getByRole('button', { name: 'Collapse sidebar', exact: true }); if (await collapse.isVisible()) await collapse.click();
  }
  async function createAnalysis(name) {
    const result = await api(page, analysesPath(), { method: 'POST', body: { requestId: crypto.randomUUID(), name } });
    assert(result.status === 201, 'Could not prepare an analysis.'); return result.value.analysis;
  }
  async function originalOperation(analysis, path, expectedState) {
    const result = await api(page, path);
    assert(result.status === 200 && result.value.journal?.requestId, 'Private admitted operation could not be recovered.');
    if (expectedState) assert(result.value.journal.state === expectedState, 'Private operation had the wrong authoritative state.');
    const journal = result.value.journal;
    assert(journal.analysisId === analysis.id && journal.visibility === 'private', 'Recovered operation crossed its private analysis scope.');
    operations.push({ analysisId: analysis.id, action: journal.action, requestId: journal.requestId, state: journal.state, admittedVersion: journal.admittedVersion });
    return journal;
  }
  async function noSourceStorage(target, sources) {
    const leaked = await target.evaluate(sources => {
      const strings = [], visit = (value, depth = 0) => {
        if (depth > 8) return;
        if (typeof value === 'string') {
          strings.push(value); try { const parsed = JSON.parse(value); if (parsed !== value) visit(parsed, depth + 1); } catch { /* Ordinary scalar browser setting. */ }
        } else if (value && typeof value === 'object') Object.values(value).forEach(item => visit(item, depth + 1));
      };
      for (const storage of [localStorage, sessionStorage]) for (let index = 0; index < storage.length; index += 1) visit(storage.getItem(storage.key(index)));
      return sources.some(source => strings.some(value => value.includes(source) || value.includes(JSON.stringify(source).slice(1, -1))));
    }, sources);
    assert(!leaked, 'Scientific source leaked into browser storage.');
  }
  async function newNotebook(target, title) {
    await ensureOutline(target); await outline(target).getByRole('button', { name: 'New notebook', exact: true }).click();
    const form = target.getByRole('form', { name: 'New notebook', exact: true });
    await form.getByLabel('New notebook title', { exact: true }).fill(title);
    return form;
  }
  async function retry(target, names) {
    const button = target.getByRole('button', { name: names, exact: typeof names === 'string' });
    await button.waitFor(); await button.click();
  }
  try {
    service = await createDesktopTunnelServiceFixture({ artifactDirectory: directory, webEnvironment: { AUTH_RATE_LIMIT_MAX: '100' }, configureProjectEnvironment: async ({ env, account, project }) => {
      const seed = new Client({ connectionString: env.DATABASE_URL }); await seed.connect();
      try {
        const owner = (await seed.query('SELECT * FROM users WHERE email=$1', [account.email])).rows[0];
        accounts.owner = { email: account.email, id: Number(owner.id) };
        const organization = (await seed.query('SELECT organization_id FROM projects WHERE id=$1', [project.id])).rows[0];
        for (const role of ['analyst', 'viewer', 'outsider']) {
          const email = 'pending-' + role + '-' + crypto.randomBytes(8).toString('hex') + '@example.invalid';
          const user = (await seed.query('INSERT INTO users(email,password_hash,salt,display_name) VALUES($1,$2,$3,$4) RETURNING id', [email, owner.password_hash, owner.salt, 'Source recovery ' + role])).rows[0];
          accounts[role] = { email, id: Number(user.id) };
          if (role !== 'outsider') {
            await seed.query("INSERT INTO organization_members(organization_id,user_id,role) VALUES($1,$2,'member')", [organization.organization_id, user.id]);
            await seed.query('INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,$3)', [project.id, user.id, role]);
          }
        }
      } finally { await seed.end(); }
      return {};
    } });
    database = new Client({ connectionString: service.databaseUrl }); await database.connect();
    const leaf = new crypto.X509Certificate(fs.readFileSync(service.certificatePath));
    const ca = new crypto.X509Certificate(fs.readFileSync(service.caCertificatePath));
    assert(leaf.verify(ca.publicKey) && leaf.checkHost(new URL(service.endpoint).hostname), 'Disposable HTTPS identity could not be verified.');
    launchOptions = { headless: true, args: ['--host-resolver-rules=MAP ' + new URL(service.endpoint).hostname + ' 127.0.0.1',
      '--ignore-certificate-errors-spki-list=' + Buffer.from(sha(leaf.publicKey.export({ type: 'spki', format: 'der' })), 'hex').toString('base64')] };
    browser = await chromium.launch(launchOptions); page = await login();

    const scriptAnalysis = await createAnalysis('Resume an imported lab script');
    await openDocuments(page, scriptAnalysis); await ensureOutline(page);
    await outline(page).getByRole('button', { name: 'Import script', exact: true }).click();
    const scriptSource = '# Donor inspection \u03b2\r\nsource("helpers/counts.R")\r\nstopifnot(ncol(counts) > 0)\r\n';
    const scriptBytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(scriptSource)]);
    const scriptFile = path.join(directory, 'donor-inspection.R'); fs.writeFileSync(scriptFile, scriptBytes);
    await importPanel(page).getByLabel('Script file', { exact: true }).setInputFiles(scriptFile);
    await importPanel(page).getByLabel('Script document title', { exact: true }).fill('Donor script from outside');
    const lostAdmission = service.interceptNextResponse({ method: 'PUT', pathname: createJournalPath(scriptAnalysis), mode: 'drop' });
    await importPanel(page).getByRole('button', { name: 'Import script', exact: true }).click();
    await until(() => Boolean(lostAdmission.observation()), 'The lost private admission did not reach the real service.');
    const admittedScript = await originalOperation(scriptAnalysis, createJournalPath(scriptAnalysis), 'pending');
    assert(admittedScript.payload.title === 'Donor script from outside' && admittedScript.payload.content.cells[0].source === scriptSource, 'Private admission changed imported source.');
    assert((await api(page, documentsPath(scriptAnalysis))).value.documents.length === 0, 'An unconfirmed admission dispatched shared creation.');
    await noSourceStorage(page, [scriptSource]);
    await restart(); await openDocuments(page, scriptAnalysis);
    await importPanel(page).getByRole('button', { name: 'Retry import', exact: true }).waitFor();
    assert((await importPanel(page).innerText()).includes('donor-inspection.R'), 'Reopening lost the admitted filename or presented a blank import.');
    await capture(page, 'reopened-admitted-script-light-1366');
    const pendingBeforeRetry = requests.filter(item => item.pathname === createJournalPath(scriptAnalysis) + '/submit' && item.method === 'POST').length;
    assert(pendingBeforeRetry === 0, 'Opening recovered analysis automatically submitted shared source.');
    await retry(page, 'Retry import');
    await until(async () => (await api(page, documentsPath(scriptAnalysis))).value.documents.length === 1, 'Exact admitted script did not finish.');
    const scriptHead = (await api(page, documentsPath(scriptAnalysis))).value.documents[0];
    const script = (await api(page, documentPath(scriptAnalysis, scriptHead))).value.document;
    assert(script.documentKind === 'script' && script.content.cells[0].source === scriptSource && script.content.metadata.traceomics.script.bom === true, 'Script identity, source or BOM changed on restart.');
    const scriptSubmits = requests.filter(item => item.pathname === createJournalPath(scriptAnalysis) + '/submit' && item.method === 'POST');
    assert(scriptSubmits.length === 1 && scriptSubmits[0].requestId === admittedScript.requestId, 'Restart did not submit the original shared UUID.');
    assert(Number((await database.query('SELECT COUNT(*) AS n FROM research_document_revisions WHERE document_id=$1', [script.id])).rows[0].n) === 1, 'Script restart created duplicate retained versions.');
    check('Lost durable admission before shared dispatch survives a full browser restart, preserves exact imported R/CRLF/BOM/filename and submits the original UUID once only after explicit retry.');

    const createAnalysisRecord = await createAnalysis('Recover a completed create reply');
    await openDocuments(page, createAnalysisRecord); const form = await newNotebook(page, 'Notebook whose reply was lost');
    const lostCreate = service.interceptNextResponse({ method: 'POST', pathname: createJournalPath(createAnalysisRecord) + '/submit', mode: 'drop' });
    await form.getByRole('button', { name: 'Create notebook', exact: true }).click();
    await until(() => Boolean(lostCreate.observation()?.value?.result?.document), 'The lost shared create was not actually committed.');
    const committedCreate = lostCreate.observation().value.result.document;
    const createOperation = await originalOperation(createAnalysisRecord, createJournalPath(createAnalysisRecord), 'succeeded');
    assert(createOperation.payload === null, 'Successful journal retained another private source copy.');
    await restart(); await openDocuments(page, createAnalysisRecord);
    const sharedRecovery = target => target.getByRole('region', { name: 'Shared source recovery', exact: true });
    await sharedRecovery(page).getByRole('button', { name: 'Review saved result', exact: true }).click();
    await select(page, committedCreate.title);
    const rereadCreate = (await api(page, documentPath(createAnalysisRecord, committedCreate))).value.document;
    assert(rereadCreate.versionId === committedCreate.versionId, 'Committed create recovery replaced the original version.');
    const createSubmits = requests.filter(item => item.pathname === createJournalPath(createAnalysisRecord) + '/submit' && item.method === 'POST');
    assert(createSubmits.length === 2 && createSubmits.every(item => item.requestId === createOperation.requestId), 'Committed create retry changed its original UUID.');
    assert(Number((await database.query('SELECT COUNT(*) AS n FROM research_document_revisions WHERE document_id=$1', [committedCreate.id])).rows[0].n) === 1, 'Lost create reply duplicated shared source.');
    await capture(page, 'committed-create-recovered-light-1366');
    check('An actually committed create with a lost response survives complete browser closure; explicit same-UUID recovery reopens the exact original shared version without duplication.');

    const submittedSource = '# Submitted original source\nsubmitted_cells <- 2638L';
    const firstCell = page.getByRole('region', { name: 'R cell 1', exact: true });
    await firstCell.getByRole('button', { name: 'Edit source', exact: true }).click();
    await page.getByRole('textbox', { name: 'R cell 1 source', exact: true }).fill(submittedSource);
    const privatePath = documentPath(createAnalysisRecord, committedCreate) + '/draft';
    await until(async () => (await api(page, privatePath)).value.draft?.content.cells[0].source === submittedSource, 'Submitted source did not first reach the private checkpoint.');
    const lostSave = service.interceptNextResponse({ method: 'POST', pathname: saveJournalPath(createAnalysisRecord, committedCreate) + '/submit', mode: 'drop' });
    await page.getByRole('button', { name: 'Save notebook', exact: true }).click();
    await until(() => Boolean(lostSave.observation()?.value?.result?.document), 'The lost source save was not actually committed.');
    const committedSave = lostSave.observation().value.result.document;
    assert(committedSave.version === 2 && committedSave.content.cells[0].source === submittedSource, 'The committed save differed from its exact source.');
    const saveOperation = await originalOperation(createAnalysisRecord, saveJournalPath(createAnalysisRecord, committedCreate), 'succeeded');
    const privateA = (await api(page, privatePath)).value.draft;
    assert(privateA && saveOperation.confirmedDraftVersion === privateA.draftVersion, 'Lost save did not retain the captured private checkpoint identity.');
    const privateNewerSource = '# Later owner-private work\nprivate_cells <- 3001L';
    const privateNewerContent = structuredClone(committedSave.content); privateNewerContent.cells[0].source = privateNewerSource;
    const ownerOtherWindow = await login();
    const privateB = await api(ownerOtherWindow, privatePath, { method: 'PUT', body: { requestId: crypto.randomUUID(), expectedDraftVersion: privateA.draftVersion,
      baseVersion: committedSave.version, baseVersionId: committedSave.versionId, title: committedSave.title, content: privateNewerContent,
      uiState: { activeCellId: privateNewerContent.cells[0].id, scrollTop: 0 } } });
    assert(privateB.status === 200, 'Could not prepare a genuinely newer owner-private working copy.');
    const analyst = await login(accounts.analyst);
    const newerSharedSource = '# Colleague newer shared source\nshared_cells <- 999L';
    const newerSharedContent = structuredClone(committedSave.content); newerSharedContent.cells[0].source = newerSharedSource;
    const colleagueSave = await api(analyst, documentPath(createAnalysisRecord, committedSave), { method: 'PUT', body: { requestId: crypto.randomUUID(), expectedVersion: 2,
      title: committedSave.title, content: newerSharedContent } });
    assert(colleagueSave.status === 200 && colleagueSave.value.document.version === 3, 'Could not prepare a newer shared head independently of the lost receipt.');
    await noSourceStorage(page, [submittedSource, privateNewerSource]);
    await restart(); await openDocuments(page, createAnalysisRecord); await select(page, committedSave.title);
    await sharedRecovery(page).getByRole('button', { name: 'Review saved result', exact: true }).waitFor();
    const beforeSaveRecovery = requests.filter(item => item.pathname === saveJournalPath(createAnalysisRecord, committedSave) + '/submit' && item.method === 'POST');
    assert(beforeSaveRecovery.length === 1, 'Opening a succeeded source operation automatically replayed a mutation.');
    await sharedRecovery(page).getByRole('button', { name: 'Review saved result', exact: true }).click();
    await until(() => requests.filter(item => item.pathname === saveJournalPath(createAnalysisRecord, committedSave) + '/submit' && item.method === 'POST').length === 2, 'Explicit saved-result review did not check its original receipt.');
    await until(async () => (await api(page, privatePath)).value.draft?.draftVersion === privateB.value.draft.draftVersion, 'Recovering an older successful save removed a newer private working copy.');
    assert((await api(page, documentPath(createAnalysisRecord, committedSave))).value.document.versionId === colleagueSave.value.document.versionId, 'Recovering an older save replaced the current shared head.');
    const exactSubmitted = await api(page, documentPath(createAnalysisRecord, committedSave) + '/versions/' + committedSave.versionId);
    assert(exactSubmitted.value.document.content.cells[0].source === submittedSource, 'The exact retained older submission was lost.');
    const saveSubmits = requests.filter(item => item.pathname === saveJournalPath(createAnalysisRecord, committedSave) + '/submit' && item.method === 'POST');
    assert(saveSubmits.every(item => item.requestId === saveOperation.requestId && item.admittedVersion === saveOperation.admittedVersion), 'Recovering a committed save changed original UUID or admission version.');
    assert(Number((await database.query('SELECT COUNT(*) AS n FROM research_document_revisions WHERE document_id=$1', [committedSave.id])).rows[0].n) === 3, 'Committed save recovery appended a duplicate revision.');
    await page.getByRole('button', { name: 'Review private draft', exact: true }).click();
    const privateDialog = page.locator('dialog[open]').filter({ has: page.getByRole('heading', { name: 'Private draft', exact: true }) }); await privateDialog.waitFor();
    assert((await privateDialog.innerText()).includes(privateNewerSource), 'Newer private working copy was not available for explicit inspection after old save recovery.');
    await capture(page, 'recovered-save-newer-private-inspector-light-1366');
    await page.getByRole('button', { name: 'Close inspector', exact: true }).click();
    for (const viewport of [{ width: 1366, height: 768 }, { width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      for (const palette of ['light', 'dark']) { await theme(page, palette); await capture(page, `recovered-save-${palette}-${viewport.width}`); }
    }
    check('Lost committed shared-save response survives full browser restart; the original UUID resolves exact version 2 separately from colleague head version 3, while captured-CAS cleanup preserves newer private source.');

    const permissionsAnalysis = await createAnalysis('Recover after project role changes');
    page = await login(accounts.analyst); await openDocuments(page, permissionsAnalysis);
    const blockedForm = await newNotebook(page, 'Pending role-limited creation');
    const blockedAdmission = service.interceptNextResponse({ method: 'PUT', pathname: createJournalPath(permissionsAnalysis), mode: 'drop' });
    await blockedForm.getByRole('button', { name: 'Create notebook', exact: true }).click();
    await until(() => Boolean(blockedAdmission.observation()), 'Role-limited source admission was not committed.');
    const roleOperation = await originalOperation(permissionsAnalysis, createJournalPath(permissionsAnalysis), 'pending');
    await database.query("UPDATE project_members SET role='viewer' WHERE project_id=$1 AND user_id=$2", [service.project.id, accounts.analyst.id]);
    await restart(accounts.analyst); await openDocuments(page, permissionsAnalysis);
    await page.getByRole('button', { name: 'Retry create', exact: true }).waitFor();
    const downgradeSubmission = page.waitForResponse(response => new URL(response.url()).pathname === createJournalPath(permissionsAnalysis) + '/submit' && response.request().method() === 'POST');
    await retry(page, 'Retry create'); assert((await downgradeSubmission).status() === 403, 'Downgraded project reader could submit new shared source.');
    assert((await api(page, createJournalPath(permissionsAnalysis))).value.journal.requestId === roleOperation.requestId, 'Role block discarded or replaced the admitted source.');
    await capture(page, 'downgraded-pending-create-light-1366');
    const viewer = await login(accounts.viewer);
    const otherList = await api(viewer, documentsPath(permissionsAnalysis) + '/pending');
    const otherSlot = await api(viewer, createJournalPath(permissionsAnalysis));
    assert(otherList.status === 200 && otherList.value.journals.length === 0 && otherSlot.value.journal === null, 'A project reader discovered another account private pending source.');
    const outsider = await login(accounts.outsider);
    assert((await api(outsider, documentsPath(permissionsAnalysis) + '/pending')).status === 404 && (await api(outsider, createJournalPath(permissionsAnalysis))).status === 404, 'Nonmember discovered private pending source scope.');
    await database.query("UPDATE project_members SET role='analyst' WHERE project_id=$1 AND user_id=$2", [service.project.id, accounts.analyst.id]);
    const ownerArchive = await login();
    const archived = await api(ownerArchive, analysesPath() + '/' + permissionsAnalysis.id, { method: 'PATCH', body: { expectedVersion: permissionsAnalysis.version, status: 'archived' } });
    assert(archived.status === 200, 'Could not archive analysis through its authorized source service.');
    const archivedAttempt = await api(page, createJournalPath(permissionsAnalysis) + '/submit', { method: 'POST', body: { requestId: roleOperation.requestId, admittedVersion: roleOperation.admittedVersion } });
    assert(archivedAttempt.status === 409 && archivedAttempt.value.code === 'ANALYSIS_ARCHIVED', 'Archived analysis admitted pending shared source.');
    assert((await api(page, documentsPath(permissionsAnalysis))).value.documents.length === 0, 'Role/archive blocking created source despite rejection.');
    const restored = await api(ownerArchive, analysesPath() + '/' + permissionsAnalysis.id, { method: 'PATCH', body: { expectedVersion: archived.value.analysis.version, status: 'active' } });
    assert(restored.status === 200, 'Could not restore analysis through its authorized source service.');
    await restart(accounts.analyst); await openDocuments(page, permissionsAnalysis); await retry(page, 'Retry create');
    await until(async () => (await api(page, documentsPath(permissionsAnalysis))).value.documents.length === 1, 'Restoring role/analysis did not permit explicit original operation recovery.');
    await database.query('DELETE FROM project_members WHERE project_id=$1 AND user_id=$2', [service.project.id, accounts.analyst.id]);
    assert((await api(page, createJournalPath(permissionsAnalysis))).status === 404, 'Project membership revocation left private pending source readable.');
    check('Current role, archive and membership checks govern every recovery; temporary blocks preserve original pending source, other accounts see no private journal, and restored access permits explicit original-UUID retry.');

    await database.query("INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,'analyst')", [service.project.id, accounts.analyst.id]);
    await restart(); const conflictAnalysis = await createAnalysis('Preserve an exact rejected submission');
    const sourceContent = { schema: 'traceomics.notebook.v1', defaultLanguage: 'R', cells: [{ id: 'original', type: 'code', language: 'R', source: '# First shared source\ninitial_cells <- 10L' }] };
    const prepared = await api(page, documentsPath(conflictAnalysis), { method: 'POST', body: { requestId: crypto.randomUUID(), title: 'Parallel biological alternatives', content: sourceContent } });
    assert(prepared.status === 201, 'Could not prepare a version-conflict notebook.'); const conflictDocument = prepared.value.document;
    await openDocuments(page, conflictAnalysis); await select(page, conflictDocument.title);
    await page.getByRole('region', { name: 'R cell 1', exact: true }).getByRole('button', { name: 'Edit source', exact: true }).click();
    const alternativeSource = '# Original submitted alternative\nalternative_cells <- 21L';
    await page.getByRole('textbox', { name: 'R cell 1 source', exact: true }).fill(alternativeSource);
    const conflictPrivatePath = documentPath(conflictAnalysis, conflictDocument) + '/draft';
    await until(async () => (await api(page, conflictPrivatePath)).value.draft?.content.cells[0].source === alternativeSource, 'Conflict alternative did not checkpoint privately.');
    const conflictAdmission = service.interceptNextResponse({ method: 'PUT', pathname: saveJournalPath(conflictAnalysis, conflictDocument), mode: 'drop' });
    await page.getByRole('button', { name: 'Save notebook', exact: true }).click();
    await until(() => Boolean(conflictAdmission.observation()), 'Exact shared save was not privately admitted.');
    const conflictOperation = await originalOperation(conflictAnalysis, saveJournalPath(conflictAnalysis, conflictDocument), 'pending');
    const sameAccountWindow = await login(); await openDocuments(sameAccountWindow, conflictAnalysis); await select(sameAccountWindow, conflictDocument.title);
    await sameAccountWindow.getByRole('button', { name: 'Retry save', exact: true }).waitFor();
    const otherWindowOperation = (await api(sameAccountWindow, saveJournalPath(conflictAnalysis, conflictDocument))).value.journal;
    assert(otherWindowOperation.requestId === conflictOperation.requestId && otherWindowOperation.payload.content.cells[0].source === alternativeSource, 'A second session replaced the admitted same-account save.');
    assert(requests.filter(item => item.pathname === saveJournalPath(conflictAnalysis, conflictDocument) && item.method === 'PUT').length === 1, 'Opening a second session admitted another source operation.');
    await capture(sameAccountWindow, 'same-account-pending-shared-save-light-1366');
    const colleague = await login(accounts.analyst); const colleagueContent = structuredClone(sourceContent); colleagueContent.cells[0].source = '# Colleague accepted alternative\ncolleague_cells <- 31L';
    const changed = await api(colleague, documentPath(conflictAnalysis, conflictDocument), { method: 'PUT', body: { requestId: crypto.randomUUID(), expectedVersion: 1, title: conflictDocument.title, content: colleagueContent } });
    assert(changed.status === 200, 'Could not prepare a genuine competing shared save.');
    await restart(); await openDocuments(page, conflictAnalysis); await select(page, conflictDocument.title); await retry(page, 'Retry save');
    await until(async () => (await api(page, saveJournalPath(conflictAnalysis, conflictDocument))).value.journal?.state === 'rejected', 'Conflicting exact submitted source was not marked definitively rejected.');
    const rejected = (await api(page, saveJournalPath(conflictAnalysis, conflictDocument))).value.journal;
    assert(rejected.requestId === conflictOperation.requestId && rejected.payload.content.cells[0].source === alternativeSource && rejected.failure.code === 'NOTEBOOK_VERSION_CONFLICT', 'Definitive CAS rejection lost the submitted scientific alternative.');
    assert(!await page.getByRole('button', { name: 'Save my draft as a new notebook', exact: true }).isVisible(), 'Recovery mislabeled the clean current shared source as a private draft alternative.');
    await sharedRecovery(page).getByRole('button', { name: 'Review submitted source', exact: true }).click();
    const submittedInspector = page.locator('dialog[open]').filter({ has: page.getByRole('heading', { name: 'Submitted source', exact: true }) }); await submittedInspector.waitFor();
    assert((await submittedInspector.innerText()).includes(alternativeSource), 'Submitted-source review showed current source in place of rejected original.');
    await capture(page, 'definitively-rejected-original-inspector-light-1366');
    await page.getByRole('button', { name: 'Close inspector', exact: true }).click();
    await retry(page, 'Copy submitted source as a new document');
    await until(async () => (await api(page, documentsPath(conflictAnalysis))).value.documents.length === 2, 'Explicit preserve-both action did not create a separate document.');
    const copiedHeads = (await api(page, documentsPath(conflictAnalysis))).value.documents;
    const copyHead = copiedHeads.find(item => item.id !== conflictDocument.id);
    const copiedDocument = (await api(page, documentPath(conflictAnalysis, copyHead))).value.document;
    assert(copiedDocument.content.cells[0].source === alternativeSource, 'Explicit copy did not use the exact rejected submitted source.');
    assert((await api(page, documentPath(conflictAnalysis, conflictDocument))).value.document.versionId === changed.value.document.versionId, 'Copying rejected source replaced the colleague current head.');
    check('Two sessions recover the same admitted UUID without a second admission; genuine concurrent shared CAS rejection retains exact private submitted source for inspection and explicit preserve-both copy.');
    await restart(); const lateAnalysis = await createAnalysis('Keep newer pending source across a delayed reply');
    const lateContent = { schema: 'traceomics.notebook.v1', defaultLanguage: 'R', cells: [{ id: 'late_source', type: 'code', language: 'R', source: '# Saved initial source' }] };
    const lateCreated = await api(page, documentsPath(lateAnalysis), { method: 'POST', body: { requestId: crypto.randomUUID(), title: 'Sequential source in two windows', content: lateContent } });
    assert(lateCreated.status === 201, 'Could not prepare the delayed-reply document.'); const lateDocument = lateCreated.value.document;
    await openDocuments(page, lateAnalysis); await select(page, lateDocument.title);
    await page.getByRole('region', { name: 'R cell 1', exact: true }).getByRole('button', { name: 'Edit source', exact: true }).click();
    const sourceA = '# First admitted shared source A\nfirst_A <- 11L', sourceB = '# Newer admitted shared source B\nnext_B <- 22L';
    await page.getByRole('textbox', { name: 'R cell 1 source', exact: true }).fill(sourceA);
    const latePrivatePath = documentPath(lateAnalysis, lateDocument) + '/draft';
    await until(async () => (await api(page, latePrivatePath)).value.draft?.content.cells[0].source === sourceA, 'First delayed source was not privately checkpointed.');
    const heldReply = service.interceptNextResponse({ method: 'POST', pathname: saveJournalPath(lateAnalysis, lateDocument) + '/submit', mode: 'hold' });
    await page.getByRole('button', { name: 'Save notebook', exact: true }).click();
    await until(() => Boolean(heldReply.observation()?.value?.result?.document), 'First save did not actually commit before its reply was held.');
    const firstOutcome = heldReply.observation().value, latePrivateA = (await api(page, latePrivatePath)).value.draft;
    const nextWindow = await login(), latePayloadB = { requestId: crypto.randomUUID(), title: lateDocument.title, expectedVersion: 2, content: structuredClone(firstOutcome.result.document.content) };
    latePayloadB.content.cells[0].source = sourceB;
    const latePrivateB = await api(nextWindow, latePrivatePath, { method: 'PUT', body: { requestId: crypto.randomUUID(), expectedDraftVersion: latePrivateA.draftVersion,
      baseVersion: 2, baseVersionId: firstOutcome.result.document.versionId, title: lateDocument.title, content: latePayloadB.content, uiState: {} } });
    assert(latePrivateB.status === 200, 'Second window could not checkpoint its later private source.');
    const lateAdmissionB = await api(nextWindow, saveJournalPath(lateAnalysis, lateDocument), { method: 'PUT', body: {
      expectedJournalVersion: firstOutcome.journalVersion, payload: latePayloadB, confirmedDraftVersion: latePrivateB.value.draftVersion,
    } });
    assert(lateAdmissionB.status === 200, 'Second window could not admit its next shared save.');
    // Opening the document checks its journal before reading the private copy.
    // Seeing this later GET proves B was observed before A's reply is released.
    const observedNewerSlot = page.waitForResponse(response => new URL(response.url()).pathname === latePrivatePath && response.request().method() === 'GET');
    await select(page, lateDocument.title); await (await observedNewerSlot).finished(); heldReply.release();
    await page.getByRole('button', { name: 'Retry save', exact: true }).waitFor();
    assert((await api(page, latePrivatePath)).value.draft?.draftVersion === latePrivateB.value.draftVersion, 'Older reply cleared the newer private checkpoint.');
    await sharedRecovery(page).getByRole('button', { name: 'Review submitted source', exact: true }).click();
    const laterInspector = page.locator('dialog[open]').filter({ has: page.getByRole('heading', { name: 'Submitted source', exact: true }) });
    assert((await laterInspector.textContent()).includes(sourceB), 'Older reply hid or replaced the newer admitted payload.');
    await capture(page, 'newer-pending-save-survives-older-reply-light-1366');
    await page.getByRole('button', { name: 'Close inspector', exact: true }).click(); await retry(page, 'Retry save');
    await until(async () => (await api(page, documentPath(lateAnalysis, lateDocument))).value.document.version === 3, 'Explicit next save did not retain its newer admitted source.');
    assert((await api(page, documentPath(lateAnalysis, lateDocument))).value.document.content.cells[0].source === sourceB, 'Next shared save used the older source.');
    await until(async () => page.getByRole('button', { name: 'Save notebook', exact: true }).isDisabled(), 'Confirmed source stayed mislabeled as an edited draft after database JSON reordering.');
    assert(Number((await database.query('SELECT COUNT(*) AS n FROM research_document_revisions WHERE document_id=$1', [lateDocument.id])).rows[0].n) === 3, 'Delayed reply handling duplicated a source revision.');
    check('An older successful reply cannot clear a newer observed pending save or its private checkpoint; explicit retry uses the newer original UUID and retains exactly one next revision.');

    await restart(); const admissionRace = await createAnalysis('Resolve competing document admissions');
    await openDocuments(page, admissionRace); await ensureOutline(page);
    await outline(page).getByRole('button', { name: 'Import script', exact: true }).click();
    const unsubmittedSource = '# My unadmitted source B\r\nlocal_B <- 42L\r\n';
    const unsubmittedFile = path.join(directory, 'local-unsubmitted.R'); fs.writeFileSync(unsubmittedFile, unsubmittedSource);
    await importPanel(page).getByLabel('Script file', { exact: true }).setInputFiles(unsubmittedFile);
    await importPanel(page).getByLabel('Script document title', { exact: true }).fill('My unadmitted document B');
    // B has observed an empty slot; another authenticated session admits A
    // before B presses Import. B's source must survive its definite CAS refusal.
    await until(async () => !(await page.getByText('Checking previous shared submissions…', { exact: true }).isVisible()), 'Initial admission lookup did not settle.');
    const windowA = await login();
    const payloadA = { requestId: crypto.randomUUID(), title: 'Other window admitted A', content: { schema: 'traceomics.notebook.v1', defaultLanguage: 'R',
      cells: [{ id: 'source_A', type: 'code', language: 'R', source: '# Original admitted A\nsource_A <- 10L' }] } };
    const admittedA = await api(windowA, createJournalPath(admissionRace), { method: 'PUT', body: { expectedJournalVersion: 0, payload: payloadA, confirmedDraftVersion: null } });
    assert(admittedA.status === 200, 'Another window did not privately admit A.');
    const refusal = page.waitForResponse(response => new URL(response.url()).pathname === createJournalPath(admissionRace) && response.request().method() === 'PUT');
    await importPanel(page).getByRole('button', { name: 'Import script', exact: true }).click();
    assert((await refusal).status() === 409, 'Stale window B did not receive a genuine admission CAS refusal.');
    await sharedRecovery(page).getByRole('button', { name: 'Review unsubmitted source', exact: true }).click();
    const unsubmittedInspector = page.locator('dialog[open]').filter({ has: page.getByRole('heading', { name: 'Unsubmitted source', exact: true }) });
    assert((await unsubmittedInspector.textContent()).includes(unsubmittedSource), 'Definite admission refusal lost unsubmitted B.');
    await capture(page, 'two-window-unsubmitted-source-light-1366');
    await page.getByRole('button', { name: 'Close inspector', exact: true }).click();
    await sharedRecovery(page).getByRole('button', { name: 'Check original submission', exact: true }).click();
    await until(async () => (await api(page, documentsPath(admissionRace))).value.documents.length === 1, 'Original admitted A could not resolve from stale window B.');
    await sharedRecovery(page).getByRole('button', { name: 'Save unsubmitted source as a new document', exact: true }).click();
    await until(async () => (await api(page, documentsPath(admissionRace))).value.documents.length === 2, 'Explicit preserve-both action did not retain unadmitted B.');
    const raceHeads = (await api(page, documentsPath(admissionRace))).value.documents;
    for (const [title, source] of [[payloadA.title, payloadA.content.cells[0].source], ['My unadmitted document B', unsubmittedSource]]) {
      const head = raceHeads.find(item => item.title === title); assert(head, 'A distinct admission alternative was lost.');
      assert((await api(page, documentPath(admissionRace, head))).value.document.content.cells[0].source === source, 'A competing admission source was silently replaced.');
    }
    await noSourceStorage(page, [unsubmittedSource, payloadA.content.cells[0].source]);
    check('A genuine two-window admission conflict exposes original admitted A and preserves unadmitted script B for explicit separate saving without a stale-CAS retry trap.');

    const scientific = requests.filter(item => item.method === 'POST' && (/^\/api\/r\//.test(item.pathname) || /^\/api\/private-r-kernels(?:\/|$)/.test(item.pathname) || /^\/api\/projects\/[^/]+\/jobs$/.test(item.pathname)));
    assert(scientific.length === 0 && Number((await database.query('SELECT COUNT(*) AS n FROM jobs')).rows[0].n) === 0 && Number((await database.query('SELECT COUNT(*) AS n FROM private_r_kernels')).rows[0].n) === 0, 'Source recovery started scientific computation.');
    assert(errors.length === 0, 'The production UI raised an uncaught error or changed compiled assets.');
    check('Production source recovery starts zero scientific jobs/kernels, stores no source in browser storage, and serves unchanged frozen assets.');
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ passed: true, checks, screenshots, operations, compiledAssets: assets, browserErrors: errors, scientificDispatchCount: scientific.length,
      fixture: 'Owned disposable HTTPS/auth/PostgreSQL; reply faults occur after real service completion; health-only R stub and no science execution.' }, null, 2) + '\n');
    console.log('Pending-source acceptance: ' + directory);
  } catch (error) {
    await page?.screenshot({ path: path.join(directory, 'failure.png'), fullPage: true }).catch(() => {});
    const snapshot = await page?.locator('main').ariaSnapshot().catch(() => null); if (snapshot) fs.writeFileSync(path.join(directory, 'failure-accessibility.txt'), snapshot);
    let message = error.message;
    for (const secret of [service?.databaseUrl, service?.storageRoot, service?.account?.password, ...Object.values(accounts).map(account => account.email)].filter(Boolean)) message = message.split(secret).join('[private fixture]');
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ passed: false, checks, screenshots, operations, error: message, browserErrors: errors, compiledAssets: assets }, null, 2) + '\n');
    throw new Error(message);
  } finally { await browser?.close(); await database?.end(); await service?.stop(); }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
