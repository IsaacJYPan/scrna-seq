#!/usr/bin/env node
'use strict';

// Production source adoption with real auth/PostgreSQL; scientific code is never run.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require('playwright');
const { Client } = require('pg');
const { createDesktopTunnelServiceFixture } = require('./desktop-tunnel-service-fixture.cjs');
const root = path.resolve(__dirname, '..');
const assert = (value, message) => { if (!value) throw new Error(message); };
const checksum = value => crypto.createHash('sha256').update(value).digest('hex');
const escaped = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const exact = value => new RegExp('^' + escaped(value) + '(?:$|\\s)');
const documentRow = value => new RegExp('^' + escaped(value) + '\\s+(?:Script|(?:R|Python) script|\\d+\\s+cells?)\\b');
async function waitFor(check, message, timeout = 30000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 75)); }
  throw new Error(message);
}

async function main({ artifactDirectory } = {}) {
  const directory = path.resolve(artifactDirectory || path.join(root, 'playwright/report', 'script-documents-' + Date.now()));
  assert(directory.startsWith(path.join(root, 'playwright/report') + path.sep), 'Script evidence must stay in ignored report storage.');
  assert(fs.existsSync(path.join(root, 'dist/index.html')), 'Build the coordinated production UI before script acceptance.');
  fs.mkdirSync(path.join(directory, 'inputs'), { recursive: true });
  fs.mkdirSync(path.join(directory, 'downloads'), { recursive: true });
  const expectedAssets = new Map(fs.readdirSync(path.join(root, 'dist/assets')).map(name => [name, checksum(fs.readFileSync(path.join(root, 'dist/assets', name)))]));
  const checks = [], screenshots = [], profiles = [], errors = [], requests = [], assets = {}, users = {}, downloads = [];
  const check = message => { checks.push(message); console.log('PASS: ' + message); };
  let service, database, browser, page, currentAnalysis, currentDocument, boundaryProject;
  const analysisPath = () => `/api/projects/${service.project.id}/analyses`;
  const documentsPath = (analysis = currentAnalysis) => `${analysisPath()}/${analysis.id}/documents`;
  const documentPath = (document = currentDocument, analysis = currentAnalysis) => documentsPath(analysis) + '/' + document.id;
  const selectedAnalysis = target => target.getByRole('region', { name: 'Selected analysis', exact: true });
  const analysisList = target => target.getByRole('region', { name: 'Project analyses', exact: true });
  const outline = target => target.getByRole('navigation', { name: 'Documents and sections', exact: true });
  const panel = target => target.getByRole('form', { name: 'Import script', exact: true });
  const editor = target => target.getByRole('textbox', { name: 'Script source', exact: true });
  const creates = () => requests.filter(request => request.method === 'POST' && request.pathname === documentsPath());
  async function api(target, url, { method = 'GET', body } = {}) {
    return target.evaluate(async ({ url, method, body }) => {
      const response = await fetch(url, { method, credentials: 'include', headers: { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, value: await response.json() };
    }, { url, method, body });
  }
  async function login(account, viewport = { width: 1366, height: 768 }) {
    const context = await browser.newContext({ viewport, acceptDownloads: true });
    const target = await context.newPage();
    target.on('pageerror', error => errors.push(error.message));
    target.on('request', request => {
      const pathname = new URL(request.url()).pathname;
      if (!pathname.startsWith('/api/')) return;
      const record = { pathname, method: request.method() };
      if (['POST', 'PUT'].includes(record.method) && /\/documents(?:\/[^/]+)?$/.test(pathname)) {
        try { const body = request.postDataJSON(); record.requestId = body.requestId; record.payloadSha256 = checksum(JSON.stringify(body)); } catch { /* The UI handles invalid transport. */ }
      }
      requests.push(record);
    });
    target.on('response', async response => {
      const pathname = new URL(response.url()).pathname;
      if (!pathname.startsWith('/assets/') || !pathname.endsWith('.js') || !response.ok()) return;
      try {
        const sha = checksum(await response.body());
        if (expectedAssets.get(pathname.split('/').at(-1)) !== sha) errors.push('Compiled assets changed during script acceptance.');
        assets[pathname] = sha;
      } catch { /* Actual page loading must also succeed. */ }
    });
    await target.goto(service.endpoint);
    await target.getByPlaceholder('researcher@lab.edu').fill(account.email);
    await target.getByLabel('Password', { exact: true }).fill(service.account.password);
    await target.getByRole('button', { name: /Open Workbench/ }).click();
    await target.getByText('Connection details', { exact: true }).waitFor();
    return target;
  }
  async function navigation(target, name) {
    const expand = target.getByRole('button', { name: 'Expand sidebar', exact: true });
    if (await expand.isVisible()) await expand.click();
    await target.getByRole('button', { name, exact: typeof name === 'string' }).click();
  }
  async function openAnalyses(target) {
    await navigation(target, /^Data workspace,/);
    await target.getByRole('button', { name: exact(service.project.name) }).click();
    await navigation(target, 'Analyses');
    await target.getByRole('heading', { name: 'Analyses', exact: true }).waitFor();
    await waitFor(async () => !(await analysisList(target).getByText('Loading analyses…', { exact: true }).isVisible()), 'Analysis list did not load.');
  }
  async function openDocuments(target, analysis = currentAnalysis) {
    if (!(await analysisList(target).isVisible())) await selectedAnalysis(target).getByRole('button', { name: 'All analyses', exact: true }).click();
    await analysisList(target).getByRole('button', { name: exact(analysis.name) }).click();
    await waitFor(async () => (await selectedAnalysis(target).getByLabel('Analysis name', { exact: true }).inputValue()) === analysis.name, 'Analysis did not reopen.');
    await selectedAnalysis(target).getByRole('button', { name: 'Open documents', exact: true }).click();
    await target.getByRole('region', { name: 'Document work area', exact: true }).waitFor();
  }
  async function ensureOutline(target) {
    await waitFor(async () => {
      if (await outline(target).isVisible()) return true;
      const summary = target.locator('summary:visible').filter({ hasText: 'Documents and sections' });
      if (await summary.count()) await summary.click({ timeout: 500 }).catch(() => {});
      return outline(target).isVisible();
    }, 'The document outline/disclosure did not become usable.');
  }
  async function selectDocument(target, title, script = true) {
    await ensureOutline(target); await outline(target).getByRole('button', { name: documentRow(title) }).click();
    await waitFor(async () => (await target.getByLabel(script ? 'Script title' : 'Notebook title', { exact: true }).inputValue()) === title, 'The selected source document did not open.');
  }
  async function prepareImport(target, file, title) {
    await ensureOutline(target); await outline(target).getByRole('button', { name: 'Import script', exact: true }).click();
    await panel(target).getByText(/Source will be shared with this project's members/).waitFor();
    await panel(target).getByLabel('Script file', { exact: true }).setInputFiles(file);
    await panel(target).getByRole('region', { name: 'Script preview', exact: true }).waitFor();
    await panel(target).getByLabel('Script document title', { exact: true }).fill(title);
  }
  async function confirmImport(target, expected = 201) {
    const waiting = target.waitForResponse(response => new URL(response.url()).pathname === documentsPath() && response.request().method() === 'POST' && response.status() === expected);
    await panel(target).getByRole('button', { name: expected === 201 ? 'Import script' : 'Retry import', exact: true }).click();
    const document = (await (await waiting).json()).document;
    await waitFor(async () => (await target.getByLabel('Script title', { exact: true }).inputValue()) === document.title, 'Imported script was not selected.');
    return document;
  }
  async function exportBytes(target, filename, expected, label) {
    const waiting = target.waitForEvent('download');
    await target.getByRole('button', { name: 'Export script', exact: true }).click();
    const download = await waiting;
    assert(download.suggestedFilename() === filename, 'Script export changed its portable filename.');
    const output = path.join(directory, 'downloads', label + path.extname(filename));
    await download.saveAs(output);
    const bytes = fs.readFileSync(output);
    assert(bytes.equals(expected), 'Downloaded script bytes differ from the current expected source: ' + label);
    downloads.push({ label, filename, bytes: bytes.length, sha256: checksum(bytes) });
  }
  async function capture(target, name, theme) {
    const rendered = await target.evaluate(() => document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light');
    if (theme) assert(rendered === theme, 'Capture theme differs from the actual rendered theme.');
    const file = name + '.png'; await target.screenshot({ path: path.join(directory, file), fullPage: true });
    screenshots.push(file); profiles.push({ file, theme: rendered, viewport: target.viewportSize() });
  }
  async function setTheme(target, theme) {
    const actual = await target.evaluate(() => document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light');
    if (actual === theme) return;
    let expanded = false; const button = target.getByRole('button', { name: `Switch to ${theme} mode`, exact: true });
    if (!(await button.isVisible())) { await target.getByRole('button', { name: 'Expand sidebar', exact: true }).click(); expanded = true; }
    await button.click();
    await waitFor(async () => (await target.evaluate(() => document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light')) === theme, 'Theme did not change.');
    if (expanded) await target.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
    await target.waitForTimeout(200); // Settle the existing 150ms palette transition; not a performance sample.
  }
  try {
    service = await createDesktopTunnelServiceFixture({ artifactDirectory: directory,
      configureProjectEnvironment: async ({ env, project, account }) => {
        const seed = new Client({ connectionString: env.DATABASE_URL }); await seed.connect();
        try {
          const owner = (await seed.query('SELECT * FROM users WHERE email=$1', [account.email])).rows[0];
          users.owner = { id: Number(owner.id), email: account.email };
          const row = (await seed.query('SELECT organization_id FROM projects WHERE id=$1', [project.id])).rows[0];
          for (const role of ['viewer', 'outsider']) {
            const email = role + '-' + crypto.randomBytes(8).toString('hex') + '@example.invalid';
            const user = (await seed.query('INSERT INTO users(email,password_hash,salt,display_name) VALUES($1,$2,$3,$4) RETURNING id', [email, owner.password_hash, owner.salt, 'Script acceptance ' + role])).rows[0];
            users[role] = { id: Number(user.id), email };
            if (role === 'viewer') {
              await seed.query("INSERT INTO organization_members(organization_id,user_id,role) VALUES($1,$2,'member')", [row.organization_id, user.id]);
              await seed.query('INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,$3)', [project.id, user.id, role]);
            }
          }
          boundaryProject = { id: 'proj_' + crypto.randomBytes(12).toString('hex'), name: 'Separate source project' };
          await seed.query('INSERT INTO projects(id,organization_id,name,created_by_user_id) VALUES($1,$2,$3,$4)', [boundaryProject.id, row.organization_id, boundaryProject.name, owner.id]);
          await seed.query("INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,'owner')", [boundaryProject.id, owner.id]);
        } finally { await seed.end(); }
        return {};
      } });
    database = new Client({ connectionString: service.databaseUrl }); await database.connect();
    const leaf = new crypto.X509Certificate(fs.readFileSync(service.certificatePath));
    const authority = new crypto.X509Certificate(fs.readFileSync(service.caCertificatePath));
    assert(leaf.verify(authority.publicKey) && leaf.checkHost(new URL(service.endpoint).hostname), 'Disposable HTTPS identity could not be verified.');
    browser = await chromium.launch({ headless: true, args: [
      '--host-resolver-rules=MAP ' + new URL(service.endpoint).hostname + ' 127.0.0.1',
      '--ignore-certificate-errors-spki-list=' + Buffer.from(checksum(leaf.publicKey.export({ type: 'spki', format: 'der' })), 'hex').toString('base64'),
    ] });
    page = await login(users.owner); await openAnalyses(page);
    const createAnalysis = async name => {
      const result = await api(page, analysisPath(), { method: 'POST', body: { requestId: crypto.randomUUID(), name } });
      assert(result.status === 201, 'A real research analysis could not be prepared.'); return result.value.analysis;
    };
    currentAnalysis = await createAnalysis('Existing script adoption'); const secondAnalysis = await createAnalysis('Companion observations');
    await analysisList(page).getByRole('button', { name: 'Refresh analyses', exact: true }).click(); await openDocuments(page);
    const rSource = '# Existing donor workflow\r\nsource("helpers/qc.R")  \r\nlabel <- "β-cells"\r\ncounts <- Matrix::colSums(counts)\r\n';
    const rBytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(rSource)]);
    const pySource = 'from pathlib import Path\nfrom helpers import qc\nlabel = "μ cells"\nprint(label)\n';
    const pyBytes = Buffer.from(pySource);
    const rFile = path.join(directory, 'inputs', 'donor-analysis.R'), pyFile = path.join(directory, 'inputs', 'donor-summary.py');
    fs.writeFileSync(rFile, rBytes); fs.writeFileSync(pyFile, pyBytes);
    const beforePreview = creates().length;
    await prepareImport(page, rFile, 'Donor QC source');
    assert(creates().length === beforePreview, 'Selecting/previewing a script created shared source before confirmation.');
    assert(await panel(page).getByRole('textbox', { name: 'Script source preview', exact: true }).getAttribute('contenteditable') === 'false', 'Import preview became writable.');
    await capture(page, 'import-r-preview-light-1366', 'light');
    currentDocument = await confirmImport(page); const originalR = currentDocument;
    const { exportScriptDocument, scriptDocumentInfo } = await import('../shared/scriptDocument.mjs');
    assert(scriptDocumentInfo(originalR.content).language === 'R' && Buffer.from(exportScriptDocument(originalR.content).bytes).equals(rBytes), 'R import changed BOM/Unicode/helper paths or line endings.');
    await exportBytes(page, 'donor-analysis.R', rBytes, 'r-original');
    check('Real UI R import previews project-shared source before confirmation and round-trips original BOM/CRLF/Unicode/helper paths byte for byte.');

    await editor(page).click(); await editor(page).press('Control+End');
    await page.waitForTimeout(550); await editor(page).pressSequentially('# temporary note');
    await exportBytes(page, 'donor-analysis.R', Buffer.concat([rBytes, Buffer.from('# temporary note')]), 'r-dirty-current');
    await editor(page).press('Control+z'); await exportBytes(page, 'donor-analysis.R', rBytes, 'r-undo');
    await editor(page).press('Control+End'); await editor(page).pressSequentially('# Reviewed on laptop');
    const editedRSource = rSource + '# Reviewed on laptop';
    const editedRBytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(editedRSource)]);
    const savedReply = page.waitForResponse(response => new URL(response.url()).pathname === documentPath() && response.request().method() === 'PUT' && response.status() === 200);
    await page.getByRole('button', { name: 'Save script', exact: true }).click(); currentDocument = (await (await savedReply).json()).document;
    assert(currentDocument.content.cells[0].source === editedRSource, 'Ordinary script editing changed preserved source structure.');
    const savedR = currentDocument;
    await page.reload(); await page.getByText('Connection details', { exact: true }).waitFor(); await openAnalyses(page); await openDocuments(page); await selectDocument(page, savedR.title);
    await exportBytes(page, 'donor-analysis.R', editedRBytes, 'r-saved-reloaded');
    const retained = await api(page, documentPath(savedR) + '/versions/' + originalR.versionId);
    assert(retained.status === 200 && Buffer.from(exportScriptDocument(retained.value.document.content).bytes).equals(rBytes), 'Saving replaced the immutable imported R source.');
    check('Actual typing/ordinary undo exports the current dirty source; save/reload preserves edited CRLF/BOM and leaves the original version unchanged.');

    await prepareImport(page, pyFile, 'Canceled Python preview'); const beforeCancel = creates().length;
    await panel(page).getByRole('button', { name: 'Cancel', exact: true }).click();
    assert(!(await panel(page).count()) && creates().length === beforeCancel, 'Cancel created source or left the import panel open.');
    await ensureOutline(page); await outline(page).getByRole('button', { name: 'Import script', exact: true }).click();
    for (const [name, bytes, message] of [
      ['not-a-script.ipynb', Buffer.from('{}'), /Choose an R/],
      ['invalid-encoding.R', Buffer.from([0xc3, 0x28]), /not valid UTF-8/],
      ['oversized.py', Buffer.alloc(256 * 1024 + 4, 65), /exceeds the 256 KiB source limit/],
    ]) {
      await panel(page).getByLabel('Script file', { exact: true }).setInputFiles({ name, mimeType: 'text/plain', buffer: bytes });
      await panel(page).getByRole('alert').filter({ hasText: message }).waitFor();
      assert(await panel(page).getByRole('button', { name: 'Import script', exact: true }).isDisabled(), 'Invalid file enabled shared-source creation.');
    }
    await capture(page, 'invalid-script-source-light-1366', 'light');
    await panel(page).getByRole('button', { name: 'Cancel', exact: true }).click();
    assert(creates().length === beforeCancel, 'Malformed/oversized files caused a source mutation.');
    await prepareImport(page, pyFile, 'Python donor summaries'); const pythonDocument = await confirmImport(page);
    assert(scriptDocumentInfo(pythonDocument.content).language === 'python', 'Python source lost its script language.');
    await exportBytes(page, 'donor-summary.py', pyBytes, 'python-original');
    assert(fs.readFileSync(rFile).equals(rBytes) && fs.readFileSync(pyFile).equals(pyBytes), 'Local input fixtures were changed by adoption.');
    check('Python adoption remains ordinary source; cancel, invalid UTF-8, unsupported extensions and oversize files produce no document mutation or file rewrite.');

    await selectDocument(page, savedR.title); await editor(page).press('Control+End'); await editor(page).press('Enter'); await editor(page).pressSequentially('# notebook branch');
    const copiedSource = editedRSource + '\r\n# notebook branch';
    await exportBytes(page, 'donor-analysis.R', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(copiedSource)]), 'r-before-notebook-copy');
    const copyReply = page.waitForResponse(response => new URL(response.url()).pathname === documentsPath() && response.request().method() === 'POST' && response.status() === 201);
    await page.getByRole('button', { name: 'Copy to a notebook', exact: true }).click(); const notebookCopy = (await (await copyReply).json()).document;
    assert(notebookCopy.id !== savedR.id && notebookCopy.content.cells.length === 1 && notebookCopy.content.cells[0].source === copiedSource && !scriptDocumentInfo(notebookCopy.content), 'Explicit notebook copy split or rewrote ordinary source.');
    await selectDocument(page, notebookCopy.title, false);
    assert(!(await page.getByRole('button', { name: 'Export script', exact: true }).count()), 'A notebook copy still claimed ordinary-script export.');
    assert((await api(page, documentPath(savedR))).value.document.versionId === savedR.versionId, 'Copying replaced the original saved script head.');
    await selectDocument(page, savedR.title);
    await exportBytes(page, 'donor-analysis.R', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(copiedSource)]), 'r-dirty-after-notebook-copy');
    check('Explicit copy creates one ordinary code cell in a separate notebook while preserving the script identity, exact saved versions and dirty alternative.');

    const pendingSource = 'from helpers import qc\r\nlabel = "δ cells"\r\n';
    const pendingBytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(pendingSource)]);
    await prepareImport(page, { name: 'pending-analysis.py', mimeType: 'text/plain', buffer: pendingBytes }, 'Recovered Python import');
    const pendingStart = creates().length;
    const dropped = service.interceptNextResponse({ method: 'POST', pathname: documentsPath(), mode: 'drop' });
    await panel(page).getByRole('button', { name: 'Import script', exact: true }).click();
    await waitFor(() => Boolean(dropped.observation()?.value?.document), 'A dropped import was not actually admitted by the service.');
    const admitted = dropped.observation().value.document;
    await panel(page).getByRole('button', { name: 'Retry import', exact: true }).waitFor();
    assert(await panel(page).getByLabel('Script document title', { exact: true }).isDisabled(), 'Unknown import allowed title mutation.');
    await capture(page, 'pending-python-import-light-1366', 'light');
    await page.getByRole('button', { name: 'Analysis overview', exact: true }).click(); await openDocuments(page, secondAnalysis);
    await prepareImport(page, { name: 'other-analysis.R', mimeType: 'text/plain', buffer: Buffer.from('other_source <- 1L\n') }, 'Other analysis local preparation');
    await page.getByRole('button', { name: 'Analysis overview', exact: true }).click(); await openDocuments(page);
    assert((await panel(page).getByLabel('Script document title', { exact: true }).inputValue()) === 'Recovered Python import', 'Another analysis relabeled the admitted import.');
    assert((await panel(page).innerText()).includes('pending-analysis.py') && (await panel(page).innerText()).includes('Python'), 'Pending source lost its true file/language presentation.');
    const recovered = await confirmImport(page, 200);
    assert(recovered.id === admitted.id && recovered.versionId === admitted.versionId, 'Retry appended another imported identity/version.');
    const admissions = creates().slice(pendingStart);
    assert(admissions.length === 2 && admissions[0].requestId === admissions[1].requestId && admissions[0].payloadSha256 === admissions[1].payloadSha256, 'Cross-analysis import recovery changed its UUID/payload.');
    await exportBytes(page, 'pending-analysis.py', pendingBytes, 'python-bom-recovered');
    await page.getByRole('button', { name: 'Analysis overview', exact: true }).click(); await openDocuments(page, secondAnalysis);
    assert((await panel(page).getByLabel('Script document title', { exact: true }).inputValue()) === 'Other analysis local preparation', 'Recovering the first analysis discarded the second local import preview.');
    await panel(page).getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: 'Analysis overview', exact: true }).click(); await openDocuments(page); await selectDocument(page, pythonDocument.title);
    check('A genuinely dropped import reply retains file type/name and independent analysis previews; the exact UUID/payload retry resolves the original admitted Python BOM/CRLF version.');

    for (const viewport of [{ width: 1366, height: 768 }, { width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      for (const theme of ['light', 'dark']) {
        await setTheme(page, theme); await selectDocument(page, pythonDocument.title);
        if (viewport.width === 390) assert(!(await outline(page).isVisible()), 'Narrow source selection left the outline covering the work area.');
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Script caused whole-page horizontal overflow.');
        await capture(page, `script-${theme}-${viewport.width}`, theme);
      }
    }
    check('Actual light/dark laptop and narrow source editors preserve clear context, readable source and compact navigation without page overflow.');

    const viewer = await login(users.viewer); await openAnalyses(viewer); await openDocuments(viewer); await selectDocument(viewer, pythonDocument.title);
    assert(await editor(viewer).getAttribute('contenteditable') === 'false', 'Viewer script source became editable.');
    await ensureOutline(viewer);
    assert(!(await outline(viewer).getByRole('button', { name: 'Import script', exact: true }).count()) && !(await viewer.getByRole('button', { name: 'Save script', exact: true }).count()), 'Viewer authoring actions were visible.');
    await exportBytes(viewer, 'donor-summary.py', pyBytes, 'viewer-python-export');
    assert((await api(viewer, documentPath(pythonDocument), { method: 'PUT', body: { requestId: crypto.randomUUID(), expectedVersion: pythonDocument.version, title: pythonDocument.title, content: pythonDocument.content } })).status === 403, 'Viewer service write was admitted.');
    assert((await api(viewer, documentsPath(), { method: 'POST', body: { requestId: crypto.randomUUID(), title: 'Forbidden source import', content: pythonDocument.content } })).status === 403, 'Viewer service import was admitted.');
    assert((await api(page, documentsPath(secondAnalysis) + '/' + pythonDocument.id)).status === 404, 'Source crossed analysis identity boundaries.');
    assert((await api(page, `/api/projects/${boundaryProject.id}/analyses/${currentAnalysis.id}/documents/${pythonDocument.id}`)).status === 404, 'Source was readable through another authorized project.');
    const outsider = await login(users.outsider);
    for (const url of [documentsPath(), documentPath(pythonDocument), documentPath(pythonDocument) + '/versions/' + pythonDocument.versionId]) assert((await api(outsider, url)).status === 404, 'Nonmember discovered shared script source.');
    await capture(viewer, 'viewer-source-and-export-light-1366', 'light');
    check('Project viewers inspect/export permitted source but cannot save/import; nonmembers and wrong analysis/project namespaces cannot discover source.');

    const { canonicalNotebookContent } = await import('../shared/notebookDocument.mjs');
    const revisions = (await database.query('SELECT id,document_id,version,sha256,content_json FROM research_document_revisions ORDER BY document_id,version')).rows;
    for (const version of revisions) assert(checksum(canonicalNotebookContent(version.content_json)) === version.sha256, 'A source revision lost its canonical checksum.');
    const heads = (await database.query('SELECT id,version FROM research_documents')).rows;
    for (const head of heads) assert(revisions.filter(version => version.document_id === head.id).length === head.version, 'An import/retry lost or duplicated source versions.');
    const scientific = requests.filter(request => request.method === 'POST' && (/^\/api\/r\//.test(request.pathname) || /^\/api\/private-r-kernels(?:\/|$)/.test(request.pathname) || /^\/api\/projects\/[^/]+\/jobs$/.test(request.pathname)));
    assert(scientific.length === 0 && Number((await database.query('SELECT COUNT(*) AS n FROM private_r_kernels')).rows[0].n) === 0 && Number((await database.query('SELECT COUNT(*) AS n FROM jobs')).rows[0].n) === 0, 'Script adoption started scientific computation.');
    assert(errors.length === 0, 'Production script UI raised an uncaught error or changed compiled assets.');
    check('All real source revisions retain their canonical checksums, with zero scientific dispatch/jobs/kernels or browser errors.');
    const report = { passed: true, checks, screenshots, profiles, downloads, browserErrors: errors, compiledAssets: assets, documents: heads.length, retainedVersions: revisions.length,
      scientificDispatchCount: scientific.length, fixture: 'Owned disposable production HTTPS/auth/PostgreSQL/storage; real file picker and browser downloads, health-only R substitute',
      exclusions: ['Script execution', 'SSH transport', 'helper-file bindings', 'notebook interchange', 'representative researcher observation'] };
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(report, null, 2) + '\n');
    console.log('Script source adoption acceptance passed; report: ' + directory); return report;
  } catch (error) {
    await page?.screenshot({ path: path.join(directory, 'failure.png'), fullPage: true }).catch(() => {});
    const snapshot = await page?.locator('main').ariaSnapshot().catch(() => null); if (snapshot) fs.writeFileSync(path.join(directory, 'failure-accessibility.txt'), snapshot);
    let message = error.message;
    for (const secret of [service?.databaseUrl, service?.storageRoot, service?.account?.password, ...Object.values(users).map(user => user.email)].filter(Boolean)) message = message.split(secret).join('[private fixture]');
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ passed: false, checks, screenshots, profiles, downloads, error: message, browserErrors: errors, compiledAssets: assets }, null, 2) + '\n');
    throw new Error(message);
  } finally { await browser?.close(); await database?.end(); await service?.stop(); }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
