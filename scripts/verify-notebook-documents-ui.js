#!/usr/bin/env node
'use strict';

// Actual production HTTPS/auth/PostgreSQL source-authoring acceptance. No R code executes.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require('playwright');
const { Client } = require('pg');
const { createDesktopTunnelServiceFixture } = require('./desktop-tunnel-service-fixture.cjs');
const root = path.resolve(__dirname, '..');
const assert = (value, message) => { if (!value) throw new Error(message); };
const checksum = value => crypto.createHash('sha256').update(value).digest('hex');
const exact = value => new RegExp('^' + value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:$|\\s)');
const notebookTitle = value => new RegExp('^' + value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s+\\d+\\s+cells?\\b');
async function waitFor(check, message, timeout = 30000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 75)); }
  throw new Error(message);
}
async function main({ artifactDirectory } = {}) {
  const directory = path.resolve(artifactDirectory || path.join(root, 'playwright/report', 'notebook-documents-' + Date.now()));
  assert(directory.startsWith(path.join(root, 'playwright/report') + path.sep), 'Notebook evidence must stay inside ignored report storage.');
  assert(fs.existsSync(path.join(root, 'dist/index.html')), 'Build the production UI before notebook acceptance.');
  fs.mkdirSync(directory, { recursive: true });
  const expectedAssets = new Map(fs.readdirSync(path.join(root, 'dist/assets')).map(name => [name, checksum(fs.readFileSync(path.join(root, 'dist/assets', name)))]));
  const checks = [], screenshots = [], errors = [], requests = [], assets = {}, profiles = [], users = {};
  const check = message => { checks.push(message); console.log('PASS: ' + message); };
  let service, database, browser, page, currentAnalysis, currentDocument;
  const analysisPath = () => `/api/projects/${service.project.id}/analyses`;
  const documentsPath = (analysis = currentAnalysis) => `${analysisPath()}/${analysis.id}/documents`;
  const documentPath = (document = currentDocument, analysis = currentAnalysis) => documentsPath(analysis) + '/' + document.id;
  const selectedAnalysis = target => target.getByRole('region', { name: 'Selected analysis', exact: true });
  const analysisList = target => target.getByRole('region', { name: 'Project analyses', exact: true });
  const outline = target => target.getByRole('navigation', { name: 'Documents and sections', exact: true });
  const cell = (target, label) => target.getByRole('region', { name: label, exact: true });
  async function api(target, url, { method = 'GET', body } = {}) {
    return target.evaluate(async ({ url, method, body }) => {
      const response = await fetch(url, { method, credentials: 'include', headers: { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, value: await response.json() };
    }, { url, method, body });
  }
  async function login(account, viewport = { width: 1440, height: 900 }) {
    const context = await browser.newContext({ viewport });
    const target = await context.newPage();
    target.on('pageerror', error => errors.push(error.message));
    target.on('request', request => {
      const pathname = new URL(request.url()).pathname;
      if (pathname.startsWith('/api/')) {
        const record = { pathname, method: request.method() };
        if (['POST', 'PUT'].includes(record.method) && /\/documents(?:\/[^/]+)?$/.test(pathname)) {
          try { const input = request.postDataJSON(); record.requestId = input.requestId; record.payloadSha256 = checksum(JSON.stringify(input)); } catch { /* Invalid transport remains visible to the UI. */ }
        }
        requests.push(record);
      }
    });
    target.on('response', async response => {
      const pathname = new URL(response.url()).pathname;
      if (pathname.startsWith('/assets/') && pathname.endsWith('.js') && response.ok()) {
        try { const name = pathname.split('/').at(-1); const sha = checksum(await response.body());
          if (expectedAssets.get(name) !== sha) errors.push('Compiled assets changed during notebook acceptance.');
          assets[pathname] = sha;
        } catch { /* An incomplete asset load also fails the actual flow. */ }
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
  async function openAnalysis(target, name) {
    if (!(await analysisList(target).isVisible())) await selectedAnalysis(target).getByRole('button', { name: 'All analyses', exact: true }).click();
    await analysisList(target).getByRole('button', { name: exact(name) }).click();
    await waitFor(async () => (await selectedAnalysis(target).getByLabel('Analysis name', { exact: true }).inputValue()) === name, 'Analysis did not reopen.');
  }
  async function openNotebooks(target, analysis) {
    await openAnalysis(target, analysis.name);
    await selectedAnalysis(target).getByRole('button', { name: 'Open notebooks', exact: true }).click();
    await target.getByRole('region', { name: 'Document work area', exact: true }).waitFor();
  }
  async function ensureOutline(target) {
    await waitFor(async () => {
      if (await outline(target).isVisible()) return true;
      const summary = target.locator('summary:visible').filter({ hasText: 'Documents and sections' });
      if (await summary.count()) await summary.click({ timeout: 500 }).catch(() => {});
      return outline(target).isVisible();
    }, 'The notebook outline or its responsive disclosure did not become usable.');
  }
  async function selectNotebook(target, title) {
    await ensureOutline(target); await outline(target).getByRole('button', { name: notebookTitle(title) }).click();
    await waitFor(async () => (await target.getByLabel('Notebook title', { exact: true }).inputValue()) === title, 'Notebook did not reopen.');
  }
  async function newNotebook(target, title, language = 'R') {
    await ensureOutline(target); await outline(target).getByRole('button', { name: 'New notebook', exact: true }).click();
    const form = target.getByRole('form', { name: 'New notebook', exact: true });
    await form.getByText('Source in this notebook is shared with project members. Saving does not execute code.', { exact: true }).waitFor();
    await form.getByLabel('New notebook title', { exact: true }).fill(title);
    await form.getByLabel('New notebook language', { exact: true }).selectOption(language);
    const response = target.waitForResponse(value => new URL(value.url()).pathname.endsWith('/documents') && value.request().method() === 'POST');
    await form.getByRole('button', { name: 'Create notebook', exact: true }).click();
    const reply = await response; assert(reply.status() === 201, 'A fresh notebook was not created.');
    const doc = (await reply.json()).document;
    await waitFor(async () => (await target.getByLabel('Notebook title', { exact: true }).inputValue()) === title, 'Created notebook source was not selected.');
    return doc;
  }
  async function editCode(target, label, source) {
    await cell(target, label).getByRole('button', { name: 'Edit source', exact: true }).click();
    const editor = target.getByRole('textbox', { name: `${label} source`, exact: true });
    await editor.waitFor(); await editor.fill(source); return editor;
  }
  async function save(target, doc = currentDocument, analysis = currentAnalysis, expected = 200) {
    const waiting = target.waitForResponse(value => new URL(value.url()).pathname === documentPath(doc, analysis) && value.request().method() === 'PUT');
    await target.getByRole('button', { name: 'Save notebook', exact: true }).click();
    const reply = await waiting; assert(reply.status() === expected, 'A notebook save returned an unexpected status.');
    const value = await reply.json(); if (expected === 200 && target === page) currentDocument = value.document; return value;
  }
  async function capture(target, name, theme) {
    const rendered = await target.evaluate(() => document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light');
    if (theme) assert(rendered === theme, 'Screenshot theme does not match the actual rendered theme.');
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
  }
  const sourceIds = target => target.locator('[id^="notebook-cell-"]').evaluateAll(nodes => nodes.map(node => node.id.slice('notebook-cell-'.length)));
  try {
    service = await createDesktopTunnelServiceFixture({ artifactDirectory: directory,
      configureProjectEnvironment: async ({ env, project, account }) => {
        const seed = new Client({ connectionString: env.DATABASE_URL }); await seed.connect();
        try {
          const owner = (await seed.query('SELECT * FROM users WHERE email=$1', [account.email])).rows[0];
          users.owner = { id: Number(owner.id), email: account.email };
          const projectRow = (await seed.query('SELECT organization_id FROM projects WHERE id=$1', [project.id])).rows[0];
          for (const role of ['analyst', 'viewer', 'outsider']) {
            const email = role + '-' + crypto.randomBytes(8).toString('hex') + '@example.invalid';
            const user = (await seed.query('INSERT INTO users(email,password_hash,salt,display_name) VALUES($1,$2,$3,$4) RETURNING id',
              [email, owner.password_hash, owner.salt, 'Notebook acceptance ' + role])).rows[0];
            users[role] = { id: Number(user.id), email };
            if (role !== 'outsider') {
              await seed.query("INSERT INTO organization_members(organization_id,user_id,role) VALUES($1,$2,'member')", [projectRow.organization_id, user.id]);
              await seed.query('INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,$3)', [project.id, user.id, role]);
            }
          }
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
    page = await login(users.owner, { width: 1366, height: 768 }); await openAnalyses(page);
    const createAnalysis = async name => {
      const result = await api(page, analysisPath(), { method: 'POST', body: { requestId: crypto.randomUUID(), name } });
      assert(result.status === 201, 'Could not prepare a real research analysis.'); return result.value.analysis;
    };
    currentAnalysis = await createAnalysis('Donor responses'); const secondAnalysis = await createAnalysis('Cell annotation');
    // Refresh through the actual UI after API fixture preparation.
    await analysisList(page).getByRole('button', { name: 'Refresh analyses', exact: true }).click();
    await openNotebooks(page, currentAnalysis);
    currentDocument = await newNotebook(page, 'Cell composition across donors');
    const originalDocumentId = currentDocument.id;
    check('An ordinary project-shared R notebook is created from Analyses → Open notebooks with explicit source visibility and no pipeline requirement.');
    await cell(page, 'R cell 1').getByRole('button', { name: 'Edit source', exact: true }).click();
    const editor = page.getByRole('textbox', { name: 'R cell 1 source', exact: true });
    await editor.pressSequentially('# Inspect cells'); await editor.press('Enter');
    await editor.pressSequentially('cells <- 2638L'); await editor.press('Enter');
    await editor.pressSequentially('summary(cells)');
    const originalSource = '# Inspect cells\ncells <- 2638L\nsummary(cells)';
    await page.waitForTimeout(550); // Separate ordinary undo groups; not a performance sample.
    await editor.pressSequentially(' # temporary'); await editor.press('Control+z');
    assert((await editor.innerText()).replace(/\r/g, '') === originalSource, 'Native editor undo did not restore exact typed source.');
    await editor.press('Tab'); assert(!(await editor.evaluate(el => el === document.activeElement)), 'Tab trapped keyboard focus inside source.');
    await cell(page, 'R cell 1').getByRole('button', { name: 'Edit source', exact: true }).click();
    await editor.press('Escape');
    await waitFor(() => cell(page, 'R cell 1').getByRole('button', { name: 'Edit source', exact: true }).evaluate(el => el === document.activeElement), 'Escape did not return to the source-entry control.', 1000);
    await page.keyboard.press('Enter'); await editor.waitFor();
    check('Actual CodeMirror typing, ordinary undo, Tab escape and explicit keyboard reentry work without execution.');

    await page.getByRole('button', { name: 'Add Markdown', exact: true }).click();
    const markdown = page.getByRole('textbox', { name: 'Markdown cell 2 source', exact: true });
    await markdown.fill('## Retained finding\n\nKeep donor replication explicit.\n<script>window.__notebookPwned = true</script>\n![external](https://invalid.example/image.png)');
    await cell(page, 'Markdown cell 2').getByRole('button', { name: 'Preview text', exact: true }).click();
    await page.getByRole('heading', { name: 'Retained finding', exact: true }).waitFor();
    await cell(page, 'R cell 1').getByRole('button', { name: 'Edit source', exact: true }).click();
    await page.getByRole('heading', { name: 'Retained finding', exact: true }).waitFor();
    assert(await page.evaluate(() => window.__notebookPwned !== true && !document.querySelector('.notebook-narrative script, .notebook-narrative img')), 'Markdown executed HTML or loaded external image content.');
    await page.getByLabel('Notebook default language', { exact: true }).selectOption('python');
    await page.getByRole('button', { name: 'Add code cell', exact: true }).click();
    const python = page.getByRole('textbox', { name: 'Python cell 3 source', exact: true }); await python.fill('len(cells)\n');
    const beforeIds = await sourceIds(page);
    await page.getByRole('button', { name: 'Move cell 3 up', exact: true }).click();
    const movedIds = await sourceIds(page); assert(movedIds[0] === beforeIds[0] && movedIds[1] === beforeIds[2] && movedIds[2] === beforeIds[1], 'Cell move changed stable identity.');
    await page.getByRole('button', { name: 'Duplicate cell 2', exact: true }).click();
    const copiedIds = await sourceIds(page); assert(copiedIds.length === 4 && new Set(copiedIds).size === 4 && copiedIds[2] !== beforeIds[2], 'Duplicating source did not create a distinct stable cell ID.');
    await page.getByRole('button', { name: 'Remove cell 3', exact: true }).click();
    await page.getByRole('button', { name: 'Undo removal', exact: true }).click();
    assert(JSON.stringify(await sourceIds(page)) === JSON.stringify(copiedIds), 'Undo remove did not restore the removed stable cell ID/order.');
    await page.getByRole('button', { name: 'Hide R cell 1 source', exact: true }).click();
    await page.getByRole('button', { name: 'Show R cell 1 source', exact: true }).click();
    await save(page);
    assert(currentDocument.content.cells[0].source === originalSource && currentDocument.content.cells[1].source === 'len(cells)\n'
      && currentDocument.content.cells[2].source === 'len(cells)\n' && currentDocument.content.defaultLanguage === 'python', 'Saved source/language differs from the authored cells.');
    const retainedFirst = currentDocument;
    check('Markdown is rendered inertly; R/Python tags, default language, move/duplicate/remove/undo and collapse preserve exact source and stable IDs through a real save.');
    await capture(page, 'authored-notebook-light-1366', 'light');

    await page.reload(); await page.getByText('Connection details', { exact: true }).waitFor(); await openAnalyses(page); await openNotebooks(page, currentAnalysis);
    await selectNotebook(page, retainedFirst.title);
    const reopened = await api(page, documentPath(retainedFirst));
    assert(reopened.value.document.sha256 === retainedFirst.sha256 && JSON.stringify(reopened.value.document.content) === JSON.stringify(retainedFirst.content), 'Reload changed exact saved source.');
    const originalVersion = await api(page, documentPath(retainedFirst) + '/versions/' + retainedFirst.versionId);
    assert(originalVersion.status === 200 && originalVersion.value.document.sha256 === retainedFirst.sha256, 'The exact saved version did not reopen.');
    currentDocument = retainedFirst;
    const secondDocument = await newNotebook(page, 'Alternative annotations', 'python');
    await editCode(page, 'Python cell 1', 'draft_annotation = "alternative"\n');
    await selectNotebook(page, retainedFirst.title);
    const draftEditor = await editCode(page, 'R cell 1', originalSource);
    await page.waitForTimeout(550); await draftEditor.press('Control+End'); await draftEditor.pressSequentially(' # navigation draft');
    await selectNotebook(page, secondDocument.title);
    await cell(page, 'Python cell 1').getByRole('button', { name: 'Edit source', exact: true }).click();
    assert((await page.getByRole('textbox', { name: 'Python cell 1 source', exact: true }).innerText()).includes('draft_annotation'), 'The second document draft was lost.');
    await page.getByRole('button', { name: 'Analysis overview', exact: true }).click(); await openNotebooks(page, secondAnalysis);
    const thirdDocument = await newNotebook(page, 'Cluster evidence');
    await page.getByRole('button', { name: 'Remove cell 1', exact: true }).click();
    await page.getByRole('button', { name: 'Add Markdown', exact: true }).click();
    const narrativeOnly = page.getByRole('textbox', { name: 'Markdown cell 1 source', exact: true });
    await narrativeOnly.fill('## Evidence question\n\nA Markdown-only document remains readable.');
    await cell(page, 'Markdown cell 1').getByRole('button', { name: 'Preview text', exact: true }).click();
    await page.getByRole('heading', { name: 'Evidence question', exact: true }).waitFor();
    await cell(page, 'Markdown cell 1').getByRole('button', { name: 'Edit text', exact: true }).click();
    await narrativeOnly.press('Escape'); await page.getByRole('heading', { name: 'Evidence question', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Analysis overview', exact: true }).click(); await openNotebooks(page, currentAnalysis);
    await selectNotebook(page, retainedFirst.title);
    await cell(page, 'R cell 1').getByRole('button', { name: 'Edit source', exact: true }).click();
    const returnedEditor = page.getByRole('textbox', { name: 'R cell 1 source', exact: true });
    assert((await returnedEditor.innerText()).includes('# navigation draft'), 'Analysis/document navigation lost the first source draft.');
    await returnedEditor.press('Control+z'); assert((await returnedEditor.innerText()) === originalSource, 'Ordinary editor undo history did not survive document/analysis navigation.');
    check('Multiple documents/analyses retain independent drafts and editor undo state; full reload reopens the exact confirmed source.');

    await ensureOutline(page); await outline(page).getByRole('button', { name: 'New notebook', exact: true }).click();
    const newForm = page.getByRole('form', { name: 'New notebook', exact: true });
    await newForm.getByLabel('New notebook title', { exact: true }).fill('Recovered notebook');
    const droppedCreate = service.interceptNextResponse({ method: 'POST', pathname: documentsPath(), mode: 'drop' });
    await newForm.getByRole('button', { name: 'Create notebook', exact: true }).click();
    await waitFor(() => Boolean(droppedCreate.observation()), 'Lost create did not reach the real service.');
    const admitted = droppedCreate.observation().value; assert(admitted?.document?.id, 'Lost create was not a real committed document.');
    await newForm.getByRole('button', { name: 'Retry create', exact: true }).waitFor();
    assert(await newForm.getByLabel('New notebook title', { exact: true }).isDisabled(), 'Unknown creation allowed payload editing.');
    await capture(page, 'unconfirmed-create');
    await page.getByRole('button', { name: 'Analysis overview', exact: true }).click(); await openNotebooks(page, secondAnalysis);
    await ensureOutline(page); await outline(page).getByRole('button', { name: 'New notebook', exact: true }).click();
    await newForm.getByLabel('New notebook title', { exact: true }).fill('Different analysis form');
    await newForm.getByLabel('New notebook language', { exact: true }).selectOption('python');
    await page.getByRole('button', { name: 'Analysis overview', exact: true }).click(); await openNotebooks(page, currentAnalysis);
    await newForm.getByRole('button', { name: 'Retry create', exact: true }).waitFor();
    assert((await newForm.getByLabel('New notebook title', { exact: true }).inputValue()) === 'Recovered notebook'
      && (await newForm.getByLabel('New notebook language', { exact: true }).inputValue()) === 'R', 'Another analysis form mislabeled the frozen pending creation.');
    const retryCreate = page.waitForResponse(value => new URL(value.url()).pathname === documentsPath() && value.request().method() === 'POST' && value.status() === 200);
    await newForm.getByRole('button', { name: 'Retry create', exact: true }).click();
    currentDocument = (await (await retryCreate).json()).document;
    assert(currentDocument.id === admitted.document.id && currentDocument.versionId === admitted.document.versionId, 'Creation retry replaced the original exact admission.');
    await editCode(page, 'R cell 1', '# Pending save\npending_value <- 7L');
    const pendingPath = documentPath();
    const droppedSave = service.interceptNextResponse({ method: 'PUT', pathname: pendingPath, mode: 'drop' });
    await page.getByRole('button', { name: 'Save notebook', exact: true }).click();
    await page.getByRole('button', { name: 'Retry save', exact: true }).waitFor();
    const lostSave = droppedSave.observation()?.value;
    assert(lostSave?.document?.version === 2, 'The lost save reply was not a real committed second version.');
    assert(await page.getByRole('textbox', { name: 'R cell 1 source', exact: true }).getAttribute('contenteditable') === 'false', 'Unknown save allowed admitted source editing.');
    const retrySave = page.waitForResponse(value => new URL(value.url()).pathname === pendingPath && value.request().method() === 'PUT' && value.status() === 200);
    await page.getByRole('button', { name: 'Retry save', exact: true }).click();
    currentDocument = (await (await retrySave).json()).document;
    assert(currentDocument.versionId === lostSave.document.versionId, 'Save recovery appended a duplicate revision.');
    const retryRequests = requests.filter(request => request.requestId && (request.pathname === documentsPath() || request.pathname === pendingPath));
    for (const [pathname, method] of [[documentsPath(), 'POST'], [pendingPath, 'PUT']]) {
      const relevant = retryRequests.filter(request => request.pathname === pathname && request.method === method).slice(-2);
      assert(relevant.length === 2 && relevant[0].requestId === relevant[1].requestId && relevant[0].payloadSha256 === relevant[1].payloadSha256, 'A recovery retry changed its UUID or admitted payload.');
    }
    assert(Number((await database.query('SELECT COUNT(*) AS n FROM research_document_revisions WHERE document_id=$1', [currentDocument.id])).rows[0].n) === 2, 'Unknown replies created duplicate retained versions.');
    check('Lost real create/save replies recover the identical UUID/payload and exact original version; admitted source stays frozen and no duplicate revision is created.');

    const analyst = await login(users.analyst); await openAnalyses(analyst); await openNotebooks(analyst, currentAnalysis); await selectNotebook(analyst, currentDocument.title);
    const ownerAlternative = '# My alternative\nowner_value <- 42L'; await editCode(page, 'R cell 1', ownerAlternative);
    await analyst.getByRole('button', { name: 'Remove cell 1', exact: true }).click();
    await analyst.getByRole('button', { name: 'Add code cell', exact: true }).click();
    const colleagueSource = '# Colleague retained evidence\ncolleague_value <- 9L'; await editCode(analyst, 'R cell 1', colleagueSource);
    const colleague = (await save(analyst)).document;
    const conflict = await save(page, currentDocument, currentAnalysis, 409);
    assert(conflict.code === 'NOTEBOOK_VERSION_CONFLICT' && conflict.currentHead.version === colleague.version, 'Genuine concurrent editors did not receive CAS conflict metadata.');
    assert((await page.getByRole('textbox', { name: 'R cell 1 source', exact: true }).innerText()) === ownerAlternative, 'A colleague save replaced the local scientific alternative.');
    await page.getByRole('button', { name: 'Review latest saved source', exact: true }).click();
    await page.getByRole('heading', { name: 'Saved source', exact: true }).waitFor();
    assert((await page.locator('dialog').filter({ has: page.getByRole('heading', { name: 'Saved source', exact: true }) }).innerText()).includes(colleagueSource), 'Latest source inspection showed dirty code or lost the changed-cell snapshot.');
    await page.getByRole('button', { name: 'Close inspector', exact: true }).click();
    const droppedCopy = service.interceptNextResponse({ method: 'POST', pathname: documentsPath(), mode: 'drop' });
    await page.getByRole('button', { name: 'Save my draft as a new notebook', exact: true }).click();
    await waitFor(() => Boolean(droppedCopy.observation()), 'The conflict copy did not reach the service.');
    const copyForm = page.getByRole('form', { name: 'New notebook', exact: true });
    await copyForm.getByRole('button', { name: 'Retry create', exact: true }).waitFor();
    assert((await copyForm.getByLabel('New notebook title', { exact: true }).inputValue()) === currentDocument.title + ' (copy)', 'Unconfirmed conflict copy did not display its actual admitted title.');
    const copyResponse = page.waitForResponse(value => new URL(value.url()).pathname === documentsPath() && value.request().method() === 'POST' && value.status() === 200);
    await copyForm.getByRole('button', { name: 'Retry create', exact: true }).click();
    const copy = (await (await copyResponse).json()).document;
    assert(copy.id !== currentDocument.id && copy.content.cells[0].source === ownerAlternative, 'Conflict copy dropped or rewrote the local source.');
    const colleagueRead = await api(page, documentPath(currentDocument));
    assert(colleagueRead.value.document.versionId === colleague.versionId && colleagueRead.value.document.content.cells[0].source === colleagueSource, 'Copy creation replaced the colleague head.');
    await selectNotebook(page, currentDocument.title);
    await cell(page, 'R cell 1').getByRole('button', { name: 'Edit source', exact: true }).click();
    assert((await page.getByRole('textbox', { name: 'R cell 1 source', exact: true }).innerText()) === ownerAlternative, 'Copy creation discarded the original recoverable dirty draft.');
    check('Two real accounts produce CAS conflict; exact latest-source inspection handles removed cell IDs, and explicit copy preserves both colleague source and the original dirty alternative.');

    await selectNotebook(page, copy.title);
    for (const viewport of [{ width: 1366, height: 768 }, { width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      for (const theme of ['light', 'dark']) {
        await setTheme(page, theme);
        await ensureOutline(page); await outline(page).getByRole('button', { name: notebookTitle(copy.title) }).click();
        if (viewport.width === 390) {
          assert(!(await outline(page).isVisible()), 'Mobile document selection left the outline open over the source.');
          await page.getByRole('button', { name: 'Saved source', exact: true }).click();
          const dialog = page.getByRole('dialog', { name: 'Saved source', exact: true }); await dialog.waitFor();
          assert(await page.getByRole('button', { name: 'Close inspector', exact: true }).evaluate(el => el === document.activeElement), 'Native source inspector did not take keyboard focus.');
          await capture(page, `source-inspector-${theme}-${viewport.width}`, theme);
          await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
          assert(await page.getByRole('button', { name: 'Saved source', exact: true }).evaluate(el => el === document.activeElement), 'Inspector Escape did not restore its opener focus.');
        }
        const width = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, viewport: innerWidth }));
        assert(width.scroll <= width.viewport + 1, 'Notebook layout caused whole-page horizontal overflow.');
        await capture(page, `notebook-${theme}-${viewport.width}`, theme);
      }
    }
    check('Both real themes at1366/1440/390 retain a usable notebook layout; mobile outline closes, native inspector focuses and Escape returns to its opener.');

    await page.setViewportSize({ width: 1440, height: 900 });
    await selectNotebook(page, retainedFirst.title); await setTheme(page, 'dark');
    await capture(page, 'mixed-r-python-markdown-dark-1440', 'dark');

    const viewer = await login(users.viewer); await openAnalyses(viewer); await openNotebooks(viewer, currentAnalysis); await selectNotebook(viewer, copy.title);
    assert(!(await viewer.getByRole('button', { name: 'Save notebook', exact: true }).count()), 'Viewer UI exposed new saves.');
    await cell(viewer, 'R cell 1').getByRole('button', { name: 'View source', exact: true }).click();
    assert(await viewer.getByRole('textbox', { name: 'R cell 1 source', exact: true }).getAttribute('contenteditable') === 'false', 'Viewer source became writable.');
    assert((await api(viewer, documentPath(copy))).status === 200, 'Project readers could not read explicitly shared source.');
    assert((await api(viewer, documentPath(copy), { method: 'PUT', body: { requestId: crypto.randomUUID(), expectedVersion: copy.version, title: copy.title, content: copy.content } })).status === 403, 'Viewer API admitted a write.');
    await capture(viewer, 'viewer-read-only-source');
    const outsider = await login(users.outsider);
    for (const url of [documentsPath(), documentPath(copy), documentPath(copy) + '/versions/' + copy.versionId]) assert((await api(outsider, url)).status === 404, 'Nonmember discovered notebook source or identity.');
    check('Shared source is readable by project viewers, editing stays disabled in UI/API, and nonmembers receive existence-neutral404s.');

    await page.getByRole('button', { name: 'Analysis overview', exact: true }).click();
    const archiveReply = page.waitForResponse(value => new URL(value.url()).pathname === analysisPath() + '/' + currentAnalysis.id && value.request().method() === 'PATCH');
    await selectedAnalysis(page).getByRole('button', { name: 'Archive', exact: true }).click();
    assert((await archiveReply).status() === 200, 'Analysis archive did not persist.');
    await selectedAnalysis(page).getByRole('button', { name: 'Restore analysis', exact: true }).waitFor();
    await selectedAnalysis(page).getByRole('button', { name: 'Open notebooks', exact: true }).click();
    await selectNotebook(page, copy.title);
    assert(!(await page.getByRole('button', { name: 'Save notebook', exact: true }).count()), 'Archived analysis exposed notebook writes.');
    assert((await api(page, documentPath(copy), { method: 'PUT', body: { requestId: crypto.randomUUID(), expectedVersion: copy.version, title: copy.title, content: copy.content } })).status === 409, 'Archived analysis admitted a new source save.');
    await capture(page, 'archived-analysis-notebook-dark-1440', 'dark');
    check('Archiving through the actual analysis UI retains notebook source while new source saves are disabled and rejected by the service.');

    const { canonicalNotebookContent } = await import('../shared/notebookDocument.mjs');
    const revisions = (await database.query('SELECT id,document_id,version,sha256,content_json FROM research_document_revisions ORDER BY document_id,version')).rows;
    for (const version of revisions) assert(checksum(canonicalNotebookContent(version.content_json)) === version.sha256, 'A retained source checksum did not match canonical source/structure.');
    const heads = (await database.query('SELECT id,version FROM research_documents')).rows;
    for (const head of heads) assert(revisions.filter(version => version.document_id === head.id).length === head.version, 'A retained notebook version was lost or duplicated.');
    await database.query('UPDATE research_document_revisions SET title=$1 WHERE id=$2', ['Forbidden mutation', retainedFirst.versionId]).then(() => { throw new Error('Saved source version was mutable.'); }, error => { assert(error.code === '55000', 'Immutable source protection failed unexpectedly.'); });
    const scientific = requests.filter(request => request.method === 'POST' && (/^\/api\/r\//.test(request.pathname)
      || /^\/api\/private-r-kernels(?:\/|$)/.test(request.pathname) || /^\/api\/projects\/[^/]+\/jobs$/.test(request.pathname)));
    assert(scientific.length === 0 && Number((await database.query('SELECT COUNT(*) AS n FROM private_r_kernels')).rows[0].n) === 0
      && Number((await database.query('SELECT COUNT(*) AS n FROM jobs')).rows[0].n) === 0, 'Notebook authoring unexpectedly started scientific computation.');
    assert(errors.length === 0, 'The production notebook UI raised an uncaught error or changed compiled assets.');
    check('Every retained version has its exact canonical checksum and database immutability; authoring starts zero scientific jobs or kernels.');
    const report = { passed: true, checks, screenshots, profiles, browserErrors: errors, compiledAssets: assets,
      documents: heads.length, retainedVersions: revisions.length, originalDocumentId, secondaryAnalysisDocumentId: thirdDocument.id,
      scientificDispatchCount: scientific.length, fixture: 'Owned disposable production HTTPS/auth/PostgreSQL/storage; fake health-only R service, no R image or scientific execution',
      exclusions: ['SSH transport', 'kernel execution', 'notebook import/export', 'full-app unconfirmed draft recovery', 'physical Linux performance', 'representative researcher observation'] };
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(report, null, 2) + '\n');
    console.log('Notebook UI acceptance passed; report: ' + directory); return report;
  } catch (error) {
    await page?.screenshot({ path: path.join(directory, 'failure.png'), fullPage: true }).catch(() => {});
    const snapshot = await page?.locator('main').ariaSnapshot().catch(() => null); if (snapshot) fs.writeFileSync(path.join(directory, 'failure-accessibility.txt'), snapshot);
    let message = error.message;
    for (const secret of [service?.databaseUrl, service?.storageRoot, service?.account?.password, ...Object.values(users).map(user => user.email)].filter(Boolean)) message = message.split(secret).join('[private fixture]');
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ passed: false, checks, screenshots, profiles, error: message, browserErrors: errors, compiledAssets: assets }, null, 2) + '\n');
    throw new Error(message);
  } finally { await browser?.close(); await database?.end(); await service?.stop(); }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
