#!/usr/bin/env node
'use strict';

// Actual production source-only acceptance with isolated HTTPS/auth/PostgreSQL.
// The imported JPEG is a synthetic 3 x 2 Pillow fixture, not scientific data.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');
const { chromium } = require('playwright');
const { Client } = require('pg');
const { createDesktopTunnelServiceFixture } = require('./desktop-tunnel-service-fixture.cjs');
const root = path.resolve(__dirname, '..');
const assert = (value, message) => { if (!value) throw new Error(message); };
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const escaped = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const row = value => new RegExp('^' + escaped(value) + '(?:$|\\s)');
const forbiddenHost = 'notebook-import-should-not-load.invalid';
const jpeg = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAUDBAQEAwUEBAQFBQUGBwwIBwcHBw8LCwkMEQ8SEhEPERETFhwXExQaFRERGCEYGh0dHx8fExciJCIeJBweHx7/2wBDAQUFBQcGBw4ICA4eFBEUHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh7/wAARCAACAAMDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDm9bllj1W4jjkdEVtqqrEAADgAUUUV9HhP93h6L8j8wzH/AHyr/il+bP/Z';
function rNotebook() {
  return { nbformat: 4, nbformat_minor: 5, metadata: { kernelspec: { name: 'ir', display_name: 'R', language: 'R' },
    language_info: { name: 'R', version: '4.4.0' }, unknown_lab_metadata: { investigator: 'Synthetic example', conditions: ['control', 'treated'], exact: true } },
  cells: [
    { id: 'context_R', cell_type: 'markdown', metadata: { tags: ['study context'], unknown: { preserve: true } },
      source: ['# Donor notebook from outside\r\n', '![tiny attachment](attachment:tiny.jpeg)\n',
        '![unsafe attachment](attachment:unsafe.svg)\n', `![outside image](https://${forbiddenHost}/markdown.png)\n`,
        '<script>window.__notebookImportedExecuted = true</script>\n'],
      attachments: { 'tiny.jpeg': { 'image/jpeg': jpeg }, 'unsafe.svg': { 'image/svg+xml': `<svg onload="window.__notebookImportedExecuted=true"><image href="https://${forbiddenHost}/svg.png"/></svg>` } } },
    { id: 'inspect_R', cell_type: 'code', metadata: { tags: ['inspection'], unknown: { original: 'cell metadata' } }, execution_count: 42,
      source: ['  ncol(object)\r\n', '# retained source with trailing spaces  \n'], outputs: [
        { output_type: 'stream', name: 'stdout', text: ['Historical stdout\r\n', 'No new execution\n'] },
        { output_type: 'execute_result', execution_count: 42, metadata: { unknown_result_metadata: { keep: true } }, data: {
          'text/plain': ['Historical cells: ', '12'], 'text/html': `<script>window.__notebookImportedExecuted=true;fetch('https://${forbiddenHost}/html')</script>`,
          'application/javascript': `window.__notebookImportedExecuted=true;fetch('https://${forbiddenHost}/javascript')`,
          'application/vnd.jupyter.widget-view+json': { version_major: 2, version_minor: 0, model_id: 'inert-historical-widget' } } },
        { output_type: 'display_data', metadata: {}, data: { 'image/jpeg': jpeg } },
        { output_type: 'error', ename: 'HistoricalWarning', evalue: 'An old warning retained from the file', traceback: ['old_call()', 'historical frame'] },
      ] },
    { id: 'raw_R', cell_type: 'raw', metadata: { format: 'text/latex', unknown_raw: { preserved: true } }, source: '\\begin{equation} x=1 \\end{equation}\r\n' },
  ] };
}
function pythonNotebook() {
  return { nbformat: 4, nbformat_minor: 5, metadata: { kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python' },
    language_info: { name: 'python', version: '3.12.0' }, custom_python_metadata: ['untouched', { declared_only: true }] }, cells: [
    { id: 'context_python', cell_type: 'markdown', metadata: {}, source: '# Ordinary Python notebook\r\n' },
    { id: 'inspect_python', cell_type: 'code', metadata: { tags: ['outside code'] }, source: ['# Original Python source\r\n', 'values = [1, 2, 3]\r\n', 'len(values)\n'], execution_count: 7,
      outputs: [{ output_type: 'execute_result', execution_count: 7, metadata: {}, data: { 'text/plain': '3', 'application/json': { historical: true, count: 3 } } }] },
  ] };
}
const joined = value => Array.isArray(value) ? value.join('') : value;
function expectedExport(original, edits = {}) {
  return { ...structuredClone(original), nbformat_minor: 5, cells: original.cells.map(cell => ({ ...structuredClone(cell),
    source: Object.hasOwn(edits, cell.id) ? edits[cell.id] : joined(cell.source),
    ...(cell.outputs ? { outputs: cell.outputs.map(output => ({ ...structuredClone(output), ...(output.output_type === 'stream' ? { text: joined(output.text) } : {}) })) } : {}) })) };
}
async function until(check, message, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 75)); }
  throw new Error(message);
}
function externalValidator() {
  const executable = process.env.NOTEBOOK_VALIDATOR_PYTHON;
  if (!executable) return null;
  const modules = process.env.NOTEBOOK_VALIDATOR_MODULES || '';
  const probe = spawnSync(executable, ['-c', 'import sys; sys.path.insert(0,sys.argv[1]); import nbformat; print(nbformat.__version__)', modules],
    { windowsHide: true, timeout: 10000, encoding: 'utf8' });
  assert(probe.status === 0, 'The explicitly supplied external notebook validator is unavailable.');
  return { executable, modules, version: probe.stdout.trim() };
}
async function main({ artifactDirectory } = {}) {
  const directory = path.resolve(artifactDirectory || path.join(root, 'playwright/report', 'notebook-interchange-' + Date.now()));
  assert(directory.startsWith(path.join(root, 'playwright/report') + path.sep), 'Acceptance evidence must remain in ignored report storage.');
  assert(fs.existsSync(path.join(root, 'dist/index.html')), 'A coordinated production build is required before acceptance.');
  fs.mkdirSync(directory, { recursive: true });
  const frozenAssets = new Map(fs.readdirSync(path.join(root, 'dist/assets')).map(name => [name, sha(fs.readFileSync(path.join(root, 'dist/assets', name)))]));
  const checks = [], screenshots = [], profiles = [], errors = [], consoleErrors = [], requests = [], assetRequests = [], forbiddenRequests = [], downloads = [], operations = [], assets = {}, accounts = {};
  const validator = externalValidator(), externalValidation = { available: !!validator, version: validator?.version || null, files: [],
    limitation: validator ? null : 'No external validator was supplied; no nbformat.validate result is claimed.' };
  const check = message => { checks.push(message); console.log('PASS: ' + message); };
  let service, database, browser, page, launchOptions;
  const analysesPath = () => `/api/projects/${service.project.id}/analyses`;
  const documentsPath = analysis => `${analysesPath()}/${analysis.id}/documents`;
  const documentPath = (analysis, doc) => documentsPath(analysis) + '/' + doc.id;
  const journalPath = analysis => documentsPath(analysis) + '/pending/create';
  const outline = target => target.getByRole('navigation', { name: 'Documents and sections', exact: true });
  const importForm = target => target.getByRole('form', { name: 'Import notebook', exact: true });
  const cell = (target, name) => target.getByRole('region', { name, exact: true });
  const recovery = target => target.getByRole('region', { name: 'Shared source recovery', exact: true });
  async function api(target, url, { method = 'GET', body } = {}) {
    return target.evaluate(async ({ url, method, body }) => {
      const response = await fetch(url, { method, credentials: 'include', headers: { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, value: await response.json() };
    }, { url, method, body });
  }
  async function login() {
    const context = await browser.newContext({ viewport: { width: 1366, height: 768 }, acceptDownloads: true });
    await context.route(`**/*${forbiddenHost}/**`, route => route.abort());
    const target = await context.newPage();
    target.on('pageerror', error => errors.push(error.message));
    target.on('console', item => { if (item.type() === 'error') consoleErrors.push({ text: item.text(), url: item.location().url }); });
    target.on('request', request => {
      const url = new URL(request.url());
      if (url.pathname.startsWith('/assets/')) assetRequests.push(url.pathname);
      if (url.hostname === forbiddenHost) forbiddenRequests.push({ pathname: url.pathname, resource: request.resourceType() });
      if (!url.pathname.startsWith('/api/')) return;
      const item = { method: request.method(), pathname: url.pathname };
      if (['POST', 'PUT', 'DELETE'].includes(item.method) && url.pathname.includes('/documents')) {
        try { const body = request.postDataJSON(); item.requestId = body?.payload?.requestId || body?.requestId;
          item.bodySha256 = sha(JSON.stringify(body)); item.admittedVersion = body?.admittedVersion; } catch { /* A rejected transport remains visible to the UI. */ }
      }
      requests.push(item);
    });
    target.on('response', async response => {
      const pathname = new URL(response.url()).pathname;
      if (!response.ok() || !pathname.startsWith('/assets/') || !pathname.endsWith('.js')) return;
      try { const digest = sha(await response.body()); assets[pathname] = digest;
        if (frozenAssets.get(pathname.split('/').at(-1)) !== digest) errors.push('Compiled assets changed during acceptance.');
      } catch { /* The actual page must still load successfully. */ }
    });
    await target.goto(service.endpoint);
    await target.getByPlaceholder('researcher@lab.edu').fill(accounts.owner.email);
    await target.getByLabel('Password', { exact: true }).fill(service.account.password);
    await target.getByRole('button', { name: /Open Workbench/ }).click();
    await target.getByText('Connection details', { exact: true }).waitFor();
    return target;
  }
  async function restart() { await browser.close(); browser = await chromium.launch(launchOptions); page = await login(); }
  async function nav(target, name) {
    const expand = target.getByRole('button', { name: 'Expand sidebar', exact: true });
    if (await expand.isVisible()) await expand.click();
    await target.getByRole('button', { name, exact: typeof name === 'string' }).click();
  }
  async function openDocuments(target, analysis) {
    await nav(target, /^Data workspace,/);
    await target.getByRole('button', { name: row(service.project.name) }).click();
    await nav(target, 'Analyses');
    const overview = target.getByRole('button', { name: 'Analysis overview', exact: true }); if (await overview.isVisible()) await overview.click();
    const list = target.getByRole('region', { name: 'Project analyses', exact: true });
    await list.getByRole('button', { name: 'Refresh analyses', exact: true }).click();
    await list.getByRole('button', { name: row(analysis.name) }).click();
    await target.getByRole('region', { name: 'Selected analysis', exact: true }).getByRole('button', { name: 'Open documents', exact: true }).click();
    await target.getByRole('region', { name: 'Document work area', exact: true }).waitFor();
  }
  async function ensureOutline(target) {
    await until(async () => {
      if (await outline(target).isVisible()) return true;
      const control = target.locator('summary:visible').filter({ hasText: 'Documents and sections' });
      if (await control.count()) await control.click({ timeout: 500 }).catch(() => {});
      return outline(target).isVisible();
    }, 'The responsive document outline did not become usable.');
  }
  async function select(target, title) {
    await ensureOutline(target); await outline(target).getByRole('button', { name: row(title) }).click();
    await until(async () => (await target.getByLabel('Notebook title', { exact: true }).inputValue()) === title, 'The imported document did not become selected.');
  }
  async function beginImport(target, filename, title) {
    await ensureOutline(target); await outline(target).getByRole('button', { name: 'Import notebook', exact: true }).click();
    await importForm(target).getByLabel('Notebook file', { exact: true }).setInputFiles(filename);
    await target.getByRole('region', { name: 'Notebook import preview', exact: true }).waitFor();
    if (title) await importForm(target).getByLabel('Notebook document title', { exact: true }).fill(title);
  }
  async function finishImport(target, analysis) {
    const waiting = target.waitForResponse(response => new URL(response.url()).pathname === journalPath(analysis) + '/submit' && response.request().method() === 'POST');
    await importForm(target).getByRole('button', { name: 'Import notebook', exact: true }).click();
    const response = await waiting, result = await response.json();
    assert(response.ok() && result.result?.document?.content?.schema === 'traceomics.notebook.v2', 'The actual shared imported document was not saved.');
    const doc = result.result.document;
    await until(async () => (await target.getByLabel('Notebook title', { exact: true }).inputValue()) === doc.title, 'The imported shared document did not open.');
    return doc;
  }
  async function setTheme(target, desired) {
    if (await target.evaluate(() => document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light') === desired) return;
    const expand = target.getByRole('button', { name: 'Expand sidebar', exact: true }); if (await expand.isVisible()) await expand.click();
    await target.getByRole('button', { name: `Switch to ${desired} mode`, exact: true }).click();
    const collapse = target.getByRole('button', { name: 'Collapse sidebar', exact: true }); if (await collapse.isVisible()) await collapse.click();
    await until(async () => (await target.evaluate(() => document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light')) === desired, 'Theme did not settle.');
  }
  async function capture(target, name) {
    await target.waitForTimeout(350); // Existing sidebar/palette transitions must finish before visual evidence.
    const width = await target.evaluate(() => ({ viewport: innerWidth, page: document.documentElement.scrollWidth }));
    assert(width.page <= width.viewport + 1, 'Notebook interchange creates whole-page horizontal overflow.');
    const filename = name + '.png'; await target.screenshot({ path: path.join(directory, filename), fullPage: true });
    screenshots.push(filename); profiles.push({ filename, theme: await target.evaluate(() => document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'), viewport: target.viewportSize() });
  }
  async function download(target, expected, name, control = 'Export notebook') {
    const waiting = target.waitForEvent('download'); await target.getByRole('button', { name: control, exact: true }).click();
    const received = await waiting, filename = path.join(directory, name + '.ipynb'); await received.saveAs(filename);
    assert(!(await received.failure()), 'The browser could not download the conventional notebook.');
    const bytes = fs.readFileSync(filename), decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    assert(isDeepStrictEqual(decoded, expected), 'Downloaded notebook changed source, stable cell IDs, unknown metadata, attachments or historical outputs.');
    if (validator) {
      const validated = spawnSync(validator.executable, ['-c', 'import sys; sys.path.insert(0,sys.argv[1]); import nbformat; nbformat.validate(nbformat.read(sys.argv[2],as_version=4)); print("validated")', validator.modules, filename],
        { windowsHide: true, timeout: 15000, encoding: 'utf8' });
      assert(validated.status === 0, 'External nbformat.validate rejected the actual downloaded notebook.');
      externalValidation.files.push(path.basename(filename));
    }
    downloads.push({ filename: path.basename(filename), suggestedFilename: received.suggestedFilename(), sha256: sha(bytes), bytes: bytes.length, externalNbformatValidated: !!validator });
    return decoded;
  }
  async function assertInert(target) {
    assert(await target.evaluate(() => window.__notebookImportedExecuted !== true
      && !document.querySelector('.notebook-narrative script, .notebook-narrative iframe, [aria-label="Imported historical results"] script, [aria-label="Imported historical results"] iframe')), 'Imported HTML, JavaScript or a widget executed in the page.');
    assert(forbiddenRequests.length === 0, 'Imported contents attempted to fetch an external resource.');
  }
  async function expandResults(target) {
    const source = cell(target, 'R cell 2'), results = source.getByRole('region', { name: 'Imported historical results', exact: true });
    const open = async summary => { if (!(await summary.locator('..').evaluate(node => node.open))) await summary.click(); };
    await open(results.locator('summary').filter({ hasText: /^Imported results ·/ }));
    for (const name of ['Output 1 · stream', 'Output 2 · execute_result', 'Output 3 · display_data', 'Output 4 · error']) await open(results.locator('summary').filter({ hasText: new RegExp('^' + escaped(name) + '$') }));
    await results.getByText('Historical cells: 12', { exact: true }).waitFor();
    const image = results.getByRole('img', { name: 'Imported image', exact: true });
    await until(() => image.evaluate(node => node.complete && node.naturalWidth === 3 && node.naturalHeight === 2), 'The actual browser did not decode the retained JPEG.');
    return results;
  }
  async function assertNoSourceStorage(target, source) {
    const leaked = await target.evaluate(source => {
      const strings = [], visit = (value, depth = 0) => {
        if (depth > 8) return;
        if (typeof value === 'string') { strings.push(value); try { const parsed = JSON.parse(value); if (parsed !== value) visit(parsed, depth + 1); } catch { /* Ordinary setting. */ } }
        else if (value && typeof value === 'object') Object.values(value).forEach(item => visit(item, depth + 1));
      };
      for (const storage of [localStorage, sessionStorage]) for (let i = 0; i < storage.length; i++) visit(storage.getItem(storage.key(i)));
      return strings.some(value => value.includes(source) || value.includes(JSON.stringify(source).slice(1, -1)));
    }, source);
    assert(!leaked, 'Imported scientific source was copied into browser storage.');
  }
  try {
    service = await createDesktopTunnelServiceFixture({ artifactDirectory: directory, webEnvironment: { AUTH_RATE_LIMIT_MAX: '100' }, configureProjectEnvironment: async ({ env, account, project }) => {
      const seed = new Client({ connectionString: env.DATABASE_URL }); await seed.connect();
      try {
        const owner = (await seed.query('SELECT * FROM users WHERE email=$1', [account.email])).rows[0];
        accounts.owner = { id: Number(owner.id), email: account.email };
        const org = (await seed.query('SELECT organization_id FROM projects WHERE id=$1', [project.id])).rows[0];
        const email = 'notebook-reader-' + crypto.randomBytes(8).toString('hex') + '@example.invalid';
        const viewer = (await seed.query('INSERT INTO users(email,password_hash,salt,display_name) VALUES($1,$2,$3,$4) RETURNING id', [email, owner.password_hash, owner.salt, 'Notebook reader'])).rows[0];
        accounts.viewer = { id: Number(viewer.id), email };
        await seed.query("INSERT INTO organization_members(organization_id,user_id,role) VALUES($1,$2,'member')", [org.organization_id, viewer.id]);
        await seed.query("INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,'viewer')", [project.id, viewer.id]);
      } finally { await seed.end(); }
      return {};
    } });
    database = new Client({ connectionString: service.databaseUrl }); await database.connect();
    const leaf = new crypto.X509Certificate(fs.readFileSync(service.certificatePath)), ca = new crypto.X509Certificate(fs.readFileSync(service.caCertificatePath));
    assert(leaf.verify(ca.publicKey) && leaf.checkHost(new URL(service.endpoint).hostname), 'The disposable HTTPS identity could not be verified.');
    launchOptions = { headless: true, args: ['--host-resolver-rules=MAP ' + new URL(service.endpoint).hostname + ' 127.0.0.1',
      '--ignore-certificate-errors-spki-list=' + Buffer.from(sha(leaf.publicKey.export({ type: 'spki', format: 'der' })), 'hex').toString('base64')] };
    browser = await chromium.launch(launchOptions); page = await login();
    assert(!assetRequests.some(name => /^\/assets\/notebook-editor-/.test(name)), 'Editor libraries were requested before the document workspace was opened.');
    const analysis = (await api(page, analysesPath(), { method: 'POST', body: { requestId: crypto.randomUUID(), name: 'Conventional notebooks from the lab' } })).value.analysis;
    assert(analysis?.id, 'Could not prepare a genuine analysis for source import.');
    const rFile = path.join(directory, 'Donor lab R.ipynb'), pyFile = path.join(directory, 'Cell lab Python.ipynb');
    const originalR = rNotebook(), originalPython = pythonNotebook();
    fs.writeFileSync(rFile, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(originalR))]));
    fs.writeFileSync(pyFile, JSON.stringify(originalPython));
    await openDocuments(page, analysis); await beginImport(page, rFile, 'Imported donor R study');
    await importForm(page).getByText('Embedded HTML, scripts and widgets are kept inert.', { exact: false }).waitFor();
    assert((await api(page, documentsPath(analysis))).value.documents.length === 0, 'Preparing a local import shared source before explicit confirmation.');
    await importForm(page).locator('summary').filter({ hasText: 'Review notebook source' }).click();
    await importForm(page).locator('summary').filter({ hasText: 'Cell 1 · Markdown' }).click();
    await importForm(page).getByLabel('Notebook import cell 1 source', { exact: true }).waitFor({ state: 'visible' });
    await capture(page, 'r-import-preview-light-1366');
    const rDoc = await finishImport(page, analysis);
    assert(rDoc.content.cells[2].type === 'raw' && rDoc.content.cells[2].source === originalR.cells[2].source, 'Import changed the raw cell or exact CRLF source.');
    const raw = cell(page, 'Raw text cell 3'); await raw.getByRole('button', { name: 'Edit source', exact: true }).click();
    const rawEditor = page.getByRole('textbox', { name: 'Raw text cell 3 source', exact: true }); await rawEditor.waitFor();
    assert((await rawEditor.inputValue()) === originalR.cells[2].source.replace(/\r\n/g, '\n') && await raw.locator('.cm-editor').count() === 0, 'Raw imported text was converted into a highlighted executable code cell.');
    await raw.scrollIntoViewIfNeeded(); await capture(page, 'raw-source-light-1366');
    await download(page, expectedExport(originalR), 'r-first-roundtrip');
    await assertInert(page);
    check('A real R notebook import retains exact IDs, mixed line endings, raw text, unknown metadata, attachments and historical outputs; first download round-trips every retained field.');

    await page.getByRole('button', { name: 'Preview imported attachment: tiny attachment', exact: true }).click();
    const attachment = page.getByRole('img', { name: 'tiny attachment', exact: true });
    await until(() => attachment.evaluate(node => node.complete && node.naturalWidth === 3 && node.naturalHeight === 2), 'The actual browser did not decode the Markdown attachment JPEG.');
    await page.getByRole('button', { name: 'Preview imported attachment: unsafe attachment', exact: true }).click();
    const results = await expandResults(page); await results.scrollIntoViewIfNeeded();
    await assertInert(page); await capture(page, 'historical-results-light-1366');
    await setTheme(page, 'dark'); await capture(page, 'historical-results-dark-1366');
    await page.setViewportSize({ width: 1440, height: 900 }); await capture(page, 'historical-results-dark-1440');
    await setTheme(page, 'light'); await capture(page, 'historical-results-light-1440');
    await page.setViewportSize({ width: 390, height: 844 }); await results.scrollIntoViewIfNeeded(); await capture(page, 'historical-results-light-390-natural');
    await setTheme(page, 'dark'); await results.scrollIntoViewIfNeeded(); await capture(page, 'historical-results-dark-390-natural');
    check('Expanded historical streams, errors, safe text, actual decoded JPEG output/attachment and inert HTML/JS/widgets work in both themes at1366/1440/390 widths without external-resource requests.');

    await page.setViewportSize({ width: 1440, height: 900 }); await setTheme(page, 'light');
    const rCell = cell(page, 'R cell 2'); await rCell.getByRole('button', { name: 'Edit source', exact: true }).click();
    const changedSource = '# Deliberately edited after import\nretained_cells <- 12L\n';
    await page.getByRole('textbox', { name: 'R cell 2 source', exact: true }).fill(changedSource);
    const waitingSave = page.waitForResponse(response => new URL(response.url()).pathname === documentPath(analysis, rDoc) + '/pending/submit' && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Save notebook', exact: true }).click();
    const saved = (await (await waitingSave).json()).result.document;
    assert(saved.version === 2 && saved.content.cells[1].source === changedSource, 'Source editing did not create the expected exact retained version.');
    await page.reload(); await page.getByText('Connection details', { exact: true }).waitFor(); await openDocuments(page, analysis); await select(page, rDoc.title);
    const reread = (await api(page, documentPath(analysis, rDoc))).value.document;
    assert(isDeepStrictEqual(reread.content, saved.content), 'Reopening changed imported source, attachments, raw cells or historical outputs.');
    await download(page, expectedExport(originalR, { inspect_R: changedSource }), 'r-edited-reopened');
    await page.getByRole('button', { name: 'Saved source', exact: true }).click();
    await page.getByRole('button', { name: 'Export saved notebook', exact: true }).waitFor();
    await download(page, expectedExport(originalR, { inspect_R: changedSource }), 'r-exact-saved-source', 'Export saved notebook');
    await capture(page, 'exact-saved-source-light-1440');
    await page.setViewportSize({ width: 390, height: 844 });
    const savedModal = page.getByRole('dialog', { name: 'Saved source', exact: true }); await savedModal.waitFor({ state: 'visible' });
    await download(page, expectedExport(originalR, { inspect_R: changedSource }), 'r-exact-saved-source-mobile', 'Export saved notebook');
    await savedModal.getByRole('status', { name: 'Notebook export notes', exact: true }).waitFor({ state: 'visible' });
    assert(await page.getByRole('status', { name: 'Notebook export notes', exact: true }).count() === 1, 'Saved-version export feedback was duplicated behind the inspector.');
    await capture(page, 'exact-saved-source-light-390-modal');
    await page.getByRole('button', { name: 'Close inspector', exact: true }).click(); await setTheme(page, 'dark');
    await page.getByRole('button', { name: 'Saved source', exact: true }).click(); await savedModal.waitFor({ state: 'visible' });
    await download(page, expectedExport(originalR, { inspect_R: changedSource }), 'r-exact-saved-source-mobile-dark', 'Export saved notebook');
    await savedModal.getByRole('status', { name: 'Notebook export notes', exact: true }).waitFor({ state: 'visible' });
    await capture(page, 'exact-saved-source-dark-390-modal');
    await page.getByRole('button', { name: 'Close inspector', exact: true }).click();
    await page.setViewportSize({ width: 1440, height: 900 }); await setTheme(page, 'light');
    check('Editing source saves an immutable v2 version, preserves historical imported outputs, reloads exactly, and supports both draft and exact saved-version exports.');

    await beginImport(page, pyFile, 'Imported Python cell inspection'); const pyDoc = await finishImport(page, analysis);
    assert(pyDoc.defaultLanguage === 'python' && pyDoc.content.cells[1].language === 'python', 'Declared Python notebook source was mislabeled.');
    await download(page, expectedExport(originalPython), 'python-roundtrip');
    await cell(page, 'Python cell 2').getByRole('button', { name: 'Edit source', exact: true }).click();
    await page.getByRole('textbox', { name: 'Python cell 2 source', exact: true }).waitFor();
    await capture(page, 'python-source-light-1440'); await setTheme(page, 'dark'); await capture(page, 'python-source-dark-1440');
    check('An ordinary Python notebook opens in the Python editor and exports exact cell IDs, source, kernel metadata and historical results without needing a pipeline or kernel.');

    await select(page, rDoc.title); await cell(page, 'R cell 2').getByRole('button', { name: 'Edit source', exact: true }).click();
    const dirty = '# Unsaved work must survive invalid imports\nlocal_inspection <- 99L\n';
    await page.getByRole('textbox', { name: 'R cell 2 source', exact: true }).fill(dirty);
    await until(async () => (await api(page, documentPath(analysis, rDoc) + '/draft')).value.draft?.content.cells[1].source === dirty, 'The private edited draft was not checkpointed.');
    const invalidFiles = [
      ['Malformed.ipynb', Buffer.from('{"nbformat":4,"cells":['), /valid JSON/i],
      ['Invalid UTF8.ipynb', Buffer.from([0xc3, 0x28]), /valid UTF-8/i],
      ['Oversized.ipynb', Buffer.alloc(2 * 1024 * 1024 + 1, 32), /2 MiB/i],
    ];
    const sharedBefore = requests.filter(item => item.method === 'PUT' && item.pathname === journalPath(analysis)).length;
    for (const [name, bytes, expected] of invalidFiles) {
      const filename = path.join(directory, name); fs.writeFileSync(filename, bytes);
      await ensureOutline(page); await outline(page).getByRole('button', { name: 'Import notebook', exact: true }).click();
      await importForm(page).getByLabel('Notebook file', { exact: true }).setInputFiles(filename);
      await until(async () => expected.test(await importForm(page).getByRole('alert').innerText()), 'Invalid notebook input did not receive its useful local error.');
      assert(await importForm(page).getByRole('button', { name: 'Import notebook', exact: true }).isDisabled(), 'An invalid file became importable.');
      assert((await page.getByLabel('Notebook title', { exact: true }).inputValue()) === rDoc.title, 'Invalid import changed the selected edited notebook.');
      await capture(page, 'invalid-' + name.split('.')[0].toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-dark-1440');
      await importForm(page).getByRole('button', { name: 'Cancel', exact: true }).click();
      const visibleSource = (await page.getByRole('textbox', { name: 'R cell 2 source', exact: true }).innerText()).replace(/\r/g, '').trimEnd();
      const privateSource = (await api(page, documentPath(analysis, rDoc) + '/draft')).value.draft?.content.cells[1].source;
      assert(visibleSource === dirty.trimEnd() && privateSource === dirty, 'Invalid import replaced the selected dirty source or its exact private checkpoint.');
    }
    assert(requests.filter(item => item.method === 'PUT' && item.pathname === journalPath(analysis)).length === sharedBefore, 'Invalid file preparation admitted shared source.');
    assert((await api(page, documentPath(analysis, rDoc))).value.document.version === 2, 'Invalid imports changed the saved head.');
    await download(page, expectedExport(originalR, { inspect_R: dirty }), 'r-preserved-dirty-draft');
    check('Malformed JSON, invalid UTF-8 and oversized files receive useful local errors while the selected dirty source, private checkpoint and saved head stay intact.');

    const recoveryAnalysis = (await api(page, analysesPath(), { method: 'POST', body: { requestId: crypto.randomUUID(), name: 'Recover an exact notebook import' } })).value.analysis;
    await openDocuments(page, recoveryAnalysis); await beginImport(page, rFile, 'Notebook import whose replies were lost');
    const lostAdmission = service.interceptNextResponse({ method: 'PUT', pathname: journalPath(recoveryAnalysis), mode: 'drop' });
    await importForm(page).getByRole('button', { name: 'Import notebook', exact: true }).click();
    await until(() => !!lostAdmission.observation(), 'The exact private admission did not reach the real service.');
    const admitted = (await api(page, journalPath(recoveryAnalysis))).value.journal;
    assert(admitted?.state === 'pending' && admitted.payload.content.schema === 'traceomics.notebook.v2', 'The durable admitted import is missing.');
    assert((await api(page, documentsPath(recoveryAnalysis))).value.documents.length === 0, 'Shared source was dispatched before admission acknowledgement.');
    const originalPayloadHash = sha((await import('../shared/notebookPending.mjs')).canonicalNotebookPendingRequest({ action: 'create', projectId: service.project.id, analysisId: recoveryAnalysis.id, payload: admitted.payload }));
    assert(originalPayloadHash === admitted.requestSha256, 'The admitted request checksum does not bind the complete imported payload.');
    await assertNoSourceStorage(page, joined(originalR.cells[1].source));
    await restart(); await openDocuments(page, recoveryAnalysis);
    await importForm(page).getByRole('button', { name: 'Retry import', exact: true }).waitFor();
    assert((await importForm(page).innerText()).includes('Donor lab R.ipynb'), 'Restart lost the admitted notebook filename.');
    assert(await importForm(page).getByLabel('Notebook document title', { exact: true }).isDisabled(), 'Recovered admitted title was editable.');
    const reopened = (await api(page, journalPath(recoveryAnalysis))).value.journal;
    assert(reopened.requestId === admitted.requestId && reopened.requestSha256 === originalPayloadHash && isDeepStrictEqual(reopened.payload, admitted.payload), 'Restart replaced the frozen UUID, raw source or imported payload.');
    assert(requests.filter(item => item.method === 'POST' && item.pathname === journalPath(recoveryAnalysis) + '/submit').length === 0, 'Restart automatically submitted recovered notebook source.');
    await page.setViewportSize({ width: 390, height: 844 }); await capture(page, 'recovered-import-light-390-natural');
    await page.setViewportSize({ width: 1366, height: 768 }); await setTheme(page, 'dark'); await capture(page, 'recovered-import-dark-1366');
    const lostSubmit = service.interceptNextResponse({ method: 'POST', pathname: journalPath(recoveryAnalysis) + '/submit', mode: 'drop' });
    await importForm(page).getByRole('button', { name: 'Retry import', exact: true }).click();
    await until(() => !!lostSubmit.observation()?.value?.result?.document, 'The admitted import did not actually commit before its response was lost.');
    const committed = lostSubmit.observation().value.result.document;
    await database.query("UPDATE project_members SET role='viewer' WHERE project_id=$1 AND user_id=$2", [service.project.id, accounts.owner.id]);
    await restart(); await openDocuments(page, recoveryAnalysis);
    const receiptReply = page.waitForResponse(response => new URL(response.url()).pathname === journalPath(recoveryAnalysis) + '/submit' && response.request().method() === 'POST');
    await recovery(page).getByRole('button', { name: 'Review saved result', exact: true }).click();
    const replayResponse = await receiptReply, replay = await replayResponse.json();
    assert(replayResponse.ok() && replay.result.document.versionId === committed.versionId, 'A current project reader could not recover the exact original accepted import receipt.');
    await select(page, committed.title); await download(page, expectedExport(originalR), 'reader-recovered-original-import');
    assert(!(await page.getByRole('button', { name: 'Save notebook', exact: true }).count()), 'Current reader recovery exposed shared mutation controls.');
    const submits = requests.filter(item => item.method === 'POST' && item.pathname === journalPath(recoveryAnalysis) + '/submit');
    assert(submits.length === 2 && submits.every(item => item.requestId === admitted.requestId && item.admittedVersion === admitted.admittedVersion), 'Unknown-reply recovery changed the accepted UUID/version or duplicated dispatch.');
    assert(Number((await database.query('SELECT COUNT(*) AS n FROM research_document_revisions WHERE document_id=$1', [committed.id])).rows[0].n) === 1, 'Lost imported create replies duplicated immutable source versions.');
    operations.push({ analysisId: recoveryAnalysis.id, requestId: admitted.requestId, requestSha256: originalPayloadHash, documentId: committed.id, versionId: committed.versionId, recoveredAsRole: 'viewer' });
    await capture(page, 'reader-original-import-light-1366');
    check('Lost v2 admission survives complete browser closure with exact frozen UUID/payload; a later committed/lost reply resolves under the current reader role without duplicate source or renewed write authority.');

    await assertInert(page); await assertNoSourceStorage(page, joined(originalR.cells[1].source));
    for (const table of ['jobs', 'private_r_kernels', 'private_r_executions', 'managed_artifact_versions']) assert(Number((await database.query(`SELECT COUNT(*) AS n FROM ${table}`)).rows[0].n) === 0, 'Notebook import/export created scientific execution or published artifact records.');
    const scientific = requests.filter(item => item.method === 'POST' && (/^\/api\/r\//.test(item.pathname) || /^\/api\/private-r-kernels(?:\/|$)/.test(item.pathname) || /^\/api\/projects\/[^/]+\/jobs$/.test(item.pathname)));
    assert(scientific.length === 0, 'Notebook import/export dispatched scientific computation.');
    const expectedTransport = /^Failed to load resource: net::ERR_(?:EMPTY_RESPONSE|INCOMPLETE_CHUNKED_ENCODING|CONNECTION_CLOSED|CONNECTION_RESET|CONTENT_LENGTH_MISMATCH)/;
    const normalAuthRead = entry => entry.url && new URL(entry.url).pathname === '/api/auth/session'
      && /^Failed to load resource: the server responded with a status of 401 /.test(entry.text);
    const healthOnlyFixtureRead = entry => entry.url && new URL(entry.url).pathname === '/api/r/session-id'
      && /^Failed to load resource: the server responded with a status of 404 /.test(entry.text);
    const unexpectedConsole = consoleErrors.filter(entry => !expectedTransport.test(entry.text) && !normalAuthRead(entry) && !healthOnlyFixtureRead(entry));
    assert(consoleErrors.filter(entry => expectedTransport.test(entry.text)).length <= 2, 'Unexpected transport errors occurred outside the two deliberate lost-reply checks.');
    assert(errors.length === 0 && unexpectedConsole.length === 0, 'The production UI raised a browser/React boundary error or served changed assets.');
    check('All source-only flows use unchanged production assets, create zero jobs/kernels/executions/publications, and raise no uncaught or React boundary errors.');
    const result = { passed: true, checks, screenshots, profiles, downloads, operations, compiledAssets: assets, assetRequests, browserErrors: errors, consoleErrors, forbiddenRequests,
      externalNbformatValidation: externalValidation, scientificDispatchCount: scientific.length,
      fixture: 'Owned disposable HTTPS/auth/PostgreSQL/storage, health-only R stub, tiny synthetic JPEG and notebook files; no scientific execution.' };
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result, null, 2) + '\n');
    console.log('Notebook interchange acceptance: ' + directory); return result;
  } catch (failure) {
    await page?.screenshot({ path: path.join(directory, 'failure.png'), fullPage: true }).catch(() => {});
    const snapshot = await page?.locator('main').ariaSnapshot().catch(() => null); if (snapshot) fs.writeFileSync(path.join(directory, 'failure-accessibility.txt'), snapshot);
    let message = failure.message;
    for (const secret of [service?.databaseUrl, service?.storageRoot, service?.account?.password, ...Object.values(accounts).map(account => account.email)].filter(Boolean)) message = message.split(secret).join('[private fixture]');
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ passed: false, checks, screenshots, profiles, downloads, operations, error: message,
      browserErrors: errors, consoleErrors, forbiddenRequests, compiledAssets: assets, externalNbformatValidation: externalValidation }, null, 2) + '\n');
    throw new Error(message);
  } finally { await browser?.close(); await database?.end(); await service?.stop(); }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
