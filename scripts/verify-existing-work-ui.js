#!/usr/bin/env node
'use strict';

// Saved-work organization uses real auth/storage; no scientific code is dispatched.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require('playwright');
const { Client } = require('pg');
const { createDesktopTunnelServiceFixture } = require('./desktop-tunnel-service-fixture.cjs');
const { seedSavedMaterial } = require('./verify-research-analyses-ui');
const root = path.resolve(__dirname, '..');
const assert = (value, message) => { if (!value) throw new Error(message); };
const id = prefix => prefix + '_' + crypto.randomBytes(12).toString('hex');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const rowName = value => new RegExp('^' + escape(value) + '(?:$|\\s)');
async function until(check, message, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 75)); }
  throw new Error(message);
}

async function main({ artifactDirectory } = {}) {
  const image = process.env.EXPERT_R_SANDBOX_IMAGE;
  assert(/^(?:[^\s@]+@)?sha256:[a-f0-9]{64}$/.test(image || ''), 'Set EXPERT_R_SANDBOX_IMAGE to an existing reviewed immutable R image for the tiny saved checkpoint.');
  const directory = path.resolve(artifactDirectory || path.join(root, 'playwright/report', 'existing-work-' + Date.now()));
  assert(directory.startsWith(path.join(root, 'playwright/report') + path.sep), 'Existing-work evidence must remain in ignored report storage.');
  assert(fs.existsSync(path.join(root, 'dist/index.html')), 'A coordinated production build is required.');
  fs.mkdirSync(directory, { recursive: true });
  const expectedAssets = new Map(fs.readdirSync(path.join(root, 'dist/assets')).map(name => [name, sha(fs.readFileSync(path.join(root, 'dist/assets', name)))]));
  const checks = [], screenshots = [], profiles = [], requests = [], errors = [], assets = {}, measurements = {}, users = {};
  const check = value => { checks.push(value); console.log('PASS: ' + value); };
  let service, database, browser, page, material, secondProject, unsavedObject, colleagueObject, colleagueCheckpoint, readerCsv, missingCsv;
  const base = () => `/api/projects/${service.project.id}/analyses`;
  const catalog = (project = service.project.id) => `/api/projects/${project}/analyses/existing-work`;
  const work = target => target.getByRole('region', { name: 'Existing saved work', exact: true });
  const workList = target => work(target).getByRole('list', { name: 'Saved work list', exact: true });
  const analyses = target => target.getByRole('region', { name: 'Project analyses', exact: true });
  const selected = target => target.getByRole('region', { name: 'Selected analysis', exact: true });
  const form = target => work(target).getByRole('form', { name: 'Start from saved work', exact: true });
  const preview = target => work(target).getByRole('region', { name: 'Retained result', exact: true });
  const creates = () => requests.filter(value => value.method === 'POST' && value.pathname === base());
  async function api(target, url, { method = 'GET', body } = {}) {
    return target.evaluate(async ({ url, method, body }) => {
      const response = await fetch(url, { method, credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-Traceomics-Csrf': '1' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, value: await response.json() };
    }, { url, method, body });
  }
  async function login(account, viewport = { width: 1366, height: 768 }) {
    const context = await browser.newContext({ viewport });
    const target = await context.newPage();
    target.on('pageerror', error => errors.push(error.message));
    target.on('request', request => {
      const pathname = new URL(request.url()).pathname;
      if (!pathname.startsWith('/api/')) return;
      const record = { pathname, method: request.method() };
      if (record.method === 'POST' && pathname === base()) {
        try { const input = request.postDataJSON(); record.requestId = input.requestId; record.payloadSha256 = sha(JSON.stringify(input)); } catch { /* Invalid requests fail elsewhere. */ }
      }
      requests.push(record);
    });
    target.on('response', async response => {
      const pathname = new URL(response.url()).pathname;
      if (!/^\/assets\/.*\.js$/.test(pathname) || !response.ok()) return;
      try {
        const digest = sha(await response.body()); assets[pathname] = digest;
        if (expectedAssets.get(pathname.split('/').at(-1)) !== digest) errors.push('Compiled assets changed during saved-work acceptance.');
      } catch { /* Page loading must also finish successfully. */ }
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
  async function openAnalyses(target, project = service.project) {
    await navigation(target, /^Data workspace,/);
    await target.getByRole('button', { name: rowName(project.name) }).click();
    await navigation(target, 'Analyses');
    await target.getByRole('heading', { name: 'Analyses', exact: true }).waitFor();
    await analyses(target).getByRole('combobox', { name: 'Analysis status', exact: true }).waitFor();
    await until(async () => !(await analyses(target).getByText('Loading analyses…', { exact: true }).isVisible()), 'The project analysis list did not load.');
  }
  async function openAnalysis(target, name) {
    if (!(await analyses(target).isVisible())) await selected(target).getByRole('button', { name: 'All analyses', exact: true }).click();
    await analyses(target).getByRole('button', { name: rowName(name) }).click();
    await selected(target).getByLabel('Analysis name', { exact: true }).waitFor();
  }
  async function bring(target) {
    await target.getByRole('button', { name: 'Bring saved work', exact: true }).click();
    await work(target).getByRole('heading', { name: 'Bring saved work into an analysis', exact: true }).waitFor();
    await until(async () => !(await work(target).getByText('Finding saved work…', { exact: true }).isVisible()), 'The saved-work catalog did not load.');
  }
  async function showList(target) {
    const back = work(target).getByRole('button', { name: 'All saved work', exact: true });
    if (!(await workList(target).isVisible())) await back.click();
  }
  async function category(target, kind) {
    await showList(target);
    const control = work(target).getByRole('combobox', { name: 'Saved work category', exact: true });
    if (await control.inputValue() === kind) return;
    const waiting = target.waitForResponse(response => new URL(response.url()).pathname === catalog()
      && new URL(response.url()).searchParams.get('kind') === kind && response.ok());
    await control.selectOption(kind); await waiting;
    await until(async () => !(await work(target).getByText('Finding saved work…', { exact: true }).isVisible()), 'The selected saved-work category did not settle.');
  }
  async function allRows(target) {
    await showList(target);
    const more = work(target).getByRole('button', { name: 'More saved work', exact: true });
    for (let count = 0; count < 5 && await more.isVisible(); count++) {
      const waiting = target.waitForResponse(response => new URL(response.url()).pathname === catalog() && response.ok());
      await more.click(); await waiting;
      await until(async () => !(await work(target).getByText('Finding saved work…', { exact: true }).isVisible()), 'The next saved-work page did not settle.');
    }
  }
  async function choose(target, label) {
    await showList(target); const row = workList(target).getByRole('button', { name: rowName(label) });
    if (!(await row.count())) await allRows(target);
    await row.click(); await work(target).getByRole('heading', { name: label, exact: true }).waitFor();
  }
  async function inspect(target, { metadataOnly = false } = {}) {
    const open = work(target).getByRole('button', { name: 'Inspect saved version', exact: true });
    if (await open.isVisible()) await open.click();
    if (metadataOnly) {
      await preview(target).getByText('This saved artifact has no supported browser preview. Only its saved metadata is shown; its contents have not been read or verified here.', { exact: true }).waitFor();
      assert(!(await preview(target).getByText('Saved checksum verified · preview from this exact version', { exact: true }).count()), 'An opaque checkpoint claimed browser byte verification.');
    } else await preview(target).getByText('Saved checksum verified · preview from this exact version', { exact: true }).waitFor();
  }
  async function adopt(target, name) {
    await form(target).getByLabel('Adopted analysis name', { exact: true }).fill(name);
    const waiting = target.waitForResponse(response => new URL(response.url()).pathname === base()
      && response.request().method() === 'POST' && response.status() === 201);
    await form(target).getByRole('button', { name: 'Start analysis with this saved version', exact: true }).click();
    const saved = (await (await waiting).json()).analysis;
    await until(async () => (await selected(target).getByLabel('Analysis name', { exact: true }).inputValue()) === name, 'Adoption did not select the newly created analysis.');
    return saved;
  }
  async function setTheme(target, theme) {
    const current = await target.evaluate(() => document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
    if (current !== theme) {
      const toggle = target.getByRole('button', { name: `Switch to ${theme} mode`, exact: true });
      let opened = false;
      if (!(await toggle.isVisible())) { await target.getByRole('button', { name: 'Expand sidebar', exact: true }).click(); opened = true; }
      await toggle.click();
      await until(async () => (await target.evaluate(() => document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light')) === theme, 'The rendered theme did not change.');
      if (opened) await target.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
    }
    await target.waitForTimeout(350); // Existing navigation/palette transition; not a latency measurement.
  }
  async function capture(target, name, theme) {
    const actual = await target.evaluate(() => document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
    if (theme) assert(actual === theme, 'A saved-work capture has the wrong actual rendered theme.');
    const filename = name + '.png'; await target.screenshot({ path: path.join(directory, filename), fullPage: true });
    screenshots.push(filename); profiles.push({ filename, theme: actual, viewport: target.viewportSize() });
  }
  async function retainedCsv(owner, label, content) {
    const versionId = id('av'), key = `projects/${service.project.id}/artifacts/${versionId}/source.csv`;
    const filename = path.resolve(service.storageRoot, ...key.split('/')), bytes = Buffer.from(content);
    assert(filename.startsWith(path.resolve(service.storageRoot) + path.sep), 'CSV fixture escaped its owned storage.');
    fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, bytes);
    await database.query("INSERT INTO managed_artifact_versions(id,artifact_id,project_id,owner_user_id,name,version_number,artifact_type,format_json,mime_type,checksum_sha256,size_bytes,storage_key) VALUES($1,$2,$3,$4,$5,1,'table',$6,'text/csv',$7,$8,$9)",
      [versionId, id('af'), service.project.id, owner.id, label, { id: 'org.ietf.csv', version: '1' }, sha(bytes), bytes.length, key]);
    return { label, reference: { kind: 'artifact-version', versionId, sha256: sha(bytes) }, sizeBytes: bytes.length };
  }
  async function visibleBounds(locator) {
    return locator.evaluate(element => {
      const box = element.getBoundingClientRect(); let top = 0, bottom = innerHeight;
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        if (/(auto|scroll|hidden|clip)/.test(getComputedStyle(parent).overflowY)) { const rect = parent.getBoundingClientRect(); top = Math.max(top, rect.top); bottom = Math.min(bottom, rect.bottom); }
      }
      return { top: box.top, bottom: box.bottom, clipTop: top, clipBottom: bottom, visible: box.top >= top && box.bottom <= bottom };
    });
  }
  try {
    service = await createDesktopTunnelServiceFixture({ artifactDirectory: directory, webEnvironment: { AUTH_RATE_LIMIT_MAX: '100' },
      configureProjectEnvironment: async ({ env, project, account }) => {
        const seed = new Client({ connectionString: env.DATABASE_URL }); await seed.connect();
        try {
          const owner = (await seed.query('SELECT * FROM users WHERE email=$1', [account.email])).rows[0];
          users.owner = { id: Number(owner.id), email: account.email };
          const org = (await seed.query('SELECT organization_id FROM projects WHERE id=$1', [project.id])).rows[0].organization_id;
          for (const role of ['analyst', 'viewer', 'outsider']) {
            const email = role + '-' + crypto.randomBytes(8).toString('hex') + '@example.invalid';
            const accountRow = (await seed.query('INSERT INTO users(email,password_hash,salt,display_name) VALUES($1,$2,$3,$4) RETURNING id',
              [email, owner.password_hash, owner.salt, 'Saved-work acceptance ' + role])).rows[0];
            users[role] = { id: Number(accountRow.id), email };
            if (role !== 'outsider') {
              await seed.query("INSERT INTO organization_members(organization_id,user_id,role) VALUES($1,$2,'member')", [org, accountRow.id]);
              await seed.query('INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,$3)', [project.id, accountRow.id, role]);
            }
          }
          secondProject = { id: id('proj'), name: 'Independent source project' };
          await seed.query('INSERT INTO projects(id,organization_id,name,created_by_user_id) VALUES($1,$2,$3,$4)', [secondProject.id, org, secondProject.name, owner.id]);
          await seed.query("INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,'owner')", [secondProject.id, owner.id]);
        } finally { await seed.end(); }
        return {};
      } });
    database = new Client({ connectionString: service.databaseUrl }); await database.connect();
    material = await seedSavedMaterial(database, service, users.owner, users.analyst, image);
    unsavedObject = { id: id('ao'), label: 'Unsaved metadata object' };
    colleagueObject = { id: id('ao'), label: 'Colleague metadata object' };
    for (const [object, owner] of [[unsavedObject, users.owner], [colleagueObject, users.analyst]]) {
      await database.query("INSERT INTO analysis_objects(id,owner_user_id,project_id,object_type,display_name,metadata_json) VALUES($1,$2,$3,'seurat',$4,'{}')",
        [object.id, owner.id, service.project.id, object.label]);
    }
    const colleagueJob = id('job'), privateVersion = id('art');
    const privateKey = `projects/${service.project.id}/checkpoints/${colleagueJob}/checkpoint.rds`;
    const privatePath = path.resolve(service.storageRoot, ...privateKey.split('/'));
    assert(privatePath.startsWith(path.resolve(service.storageRoot) + path.sep), 'Private checkpoint fixture escaped its storage.');
    fs.mkdirSync(path.dirname(privatePath), { recursive: true }); fs.copyFileSync(material.checkpoint.filename, privatePath);
    await database.query("INSERT INTO jobs(id,owner_user_id,project_id,analysis_object_id,result_analysis_object_id,job_type,status,started_at,completed_at) VALUES($1,$2,$3,$4,$4,'checkpoint.noop','completed',NOW(),NOW())", [colleagueJob, users.analyst.id, service.project.id, colleagueObject.id]);
    await database.query("INSERT INTO job_artifacts(id,project_id,job_id,result_analysis_object_id,created_by_user_id,artifact_type,name,mime_type,storage_kind,storage_uri,checksum_sha256,size_bytes,status) VALUES($1,$2,$3,$4,$5,'checkpoint','Colleague private checkpoint','application/x-r-rds','local_internal',$6,$7,$8,'available')",
      [privateVersion, service.project.id, colleagueJob, colleagueObject.id, users.analyst.id, privateKey, material.checkpoint.reference.sha256, material.checkpoint.sizeBytes]);
    colleagueCheckpoint = privateVersion;
    readerCsv = await retainedCsv(users.viewer, 'Reader-owned quality table', 'sample,cells\nReader1,12\n');
    missingCsv = await retainedCsv(users.owner, 'Removed saved-result fixture', 'sample,status\nRemoved1,original\n');
    for (let index = 1; index <= 32; index++) {
      await database.query("INSERT INTO analysis_objects(id,owner_user_id,project_id,object_type,display_name,metadata_json) VALUES($1,$2,$3,'seurat',$4,'{}')",
        [id('ao'), users.owner.id, service.project.id, 'Catalog continuity object ' + String(index).padStart(2, '0')]);
    }
    await database.query("UPDATE analysis_objects SET created_at=NOW()-INTERVAL '2 days' WHERE id=$1", [material.checkpoint.reference.analysisObjectId]);
    const initialJobCount = Number((await database.query('SELECT count(*) AS n FROM jobs')).rows[0].n);
    const leaf = new crypto.X509Certificate(fs.readFileSync(service.certificatePath));
    const authority = new crypto.X509Certificate(fs.readFileSync(service.caCertificatePath));
    assert(leaf.verify(authority.publicKey) && leaf.checkHost(new URL(service.endpoint).hostname), 'The actual disposable HTTPS identity could not be verified.');
    browser = await chromium.launch({ headless: true, args: [
      '--host-resolver-rules=MAP ' + new URL(service.endpoint).hostname + ' 127.0.0.1',
      '--ignore-certificate-errors-spki-list=' + Buffer.from(sha(leaf.publicKey.export({ type: 'spki', format: 'der' })), 'hex').toString('base64'),
    ] });
    page = await login(users.owner); await openAnalyses(page);
    const created = await api(page, base(), { method: 'POST', body: { requestId: crypto.randomUUID(), name: 'Unrelated research question', description: 'Saved baseline interpretation.' } });
    assert(created.status === 201, 'The unrelated analysis fixture could not be created.'); const unrelated = created.value.analysis;
    await analyses(page).getByRole('button', { name: 'Refresh analyses', exact: true }).click(); await openAnalysis(page, unrelated.name);
    const dirtyName = 'Unrelated interpretation draft', dirtyNotes = 'Unsaved notes must survive inspecting and adopting other work.';
    await selected(page).getByLabel('Analysis name', { exact: true }).fill(dirtyName);
    await selected(page).getByRole('textbox', { name: /^Research question or notes/ }).fill(dirtyNotes);
    const beforeDiscovery = creates().length;
    await bring(page); await allRows(page);
    const ownerCatalog = await api(page, catalog() + '?kind=objects');
    assert(ownerCatalog.status === 200 && ownerCatalog.value.items.length === 30 && ownerCatalog.value.nextCursor, 'The real saved-object catalog did not page its long project list.');
    await choose(page, colleagueObject.label);
    assert((await work(page).innerText()).includes('Private source access required') || (await work(page).innerText()).includes('source belongs to a colleague'), 'Colleague source was not clearly restricted.');
    assert(!(await work(page).getByRole('button', { name: 'Inspect saved version', exact: true }).count()) && !(await form(page).count()), 'Colleague source exposed inspection/adoption controls.');
    const nextCatalog = await api(page, catalog() + '?kind=objects&cursor=' + encodeURIComponent(ownerCatalog.value.nextCursor));
    assert(nextCatalog.status === 200, 'The saved-object catalog continuation could not be read.');
    const catalogItems = [...ownerCatalog.value.items, ...nextCatalog.value.items];
    const publicColleague = catalogItems.find(item => item.id === colleagueObject.id);
    assert(publicColleague && publicColleague.reference === null && publicColleague.origin === null && publicColleague.savedState === 'restricted'
      && !JSON.stringify(catalogItems).includes(colleagueCheckpoint) && !JSON.stringify(catalogItems).includes('Colleague private checkpoint'), 'The catalog disclosed a colleague private checkpoint.');
    await capture(page, 'colleague-source-restricted-light-1366', 'light');
    await choose(page, unsavedObject.label);
    assert((await work(page).innerText()).includes('No usable saved version is recorded') && !(await form(page).count())
      && !(await work(page).getByRole('button', { name: 'Inspect saved version', exact: true }).count()), 'An unsaved object pretended to have reusable source.');
    await capture(page, 'object-without-saved-version-light-1366', 'light');
    await choose(page, 'Small saved Seurat object');
    await work(page).getByText('Recorded origin', { exact: true }).click();
    await work(page).getByText(/Live compute state has not been checked/).waitFor();
    await work(page).getByText(/No notebook source is linked here/).waitFor();
    await inspect(page, { metadataOnly: true });
    assert(creates().length === beforeDiscovery, 'Browsing or inspecting existing work created an analysis before confirmation.');
    await preview(page).getByText(material.checkpoint.reference.sha256, { exact: true }).waitFor();
    await capture(page, 'exact-checkpoint-inspection-light-1366', 'light');
    check('Real paged saved objects distinguish owner checkpoints, colleague-private metadata and no-saved objects; opaque checkpoint inspection shows exact recorded metadata without claiming byte verification or creating code/compute.');

    const beforeHistory = requests.length;
    await work(page).getByRole('button', { name: 'Open original object history', exact: true }).click();
    await page.getByRole('heading', { name: 'Runs & Results', exact: true }).waitFor();
    await until(async () => {
      for (const label of await page.getByText('Small saved Seurat object', { exact: true }).all()) if (await label.isVisible()) return true;
      return false;
    }, 'The original object history did not identify the selected saved object.');
    assert(!requests.slice(beforeHistory).some(value => value.method === 'POST' && (/^\/api\/r\//.test(value.pathname) || /\/jobs$/.test(value.pathname))), 'Opening original object history dispatched scientific work.');
    await capture(page, 'original-object-history-without-compute-light-1366', 'light');
    await navigation(page, 'Analyses'); await selected(page).getByLabel('Analysis name', { exact: true }).waitFor();
    assert((await selected(page).getByLabel('Analysis name', { exact: true }).inputValue()) === dirtyName
      && (await selected(page).getByRole('textbox', { name: /^Research question or notes/ }).inputValue()) === dirtyNotes, 'Original history navigation discarded an unrelated interpretation draft.');
    await bring(page); await choose(page, 'Small saved Seurat object');
    const adoptedObject = await adopt(page, 'Continue exact saved checkpoint');
    assert(adoptedObject.references.length === 1 && JSON.stringify(adoptedObject.references[0].reference) === JSON.stringify(material.checkpoint.reference), 'Object adoption changed its exact checkpoint reference.');
    await bring(page); await category(page, 'results'); await choose(page, material.ownerCsv.label); await inspect(page);
    await preview(page).getByRole('table').getByText('S1', { exact: true }).waitFor();
    await preview(page).getByText(material.ownerCsv.reference.sha256, { exact: true }).waitFor();
    await preview(page).scrollIntoViewIfNeeded(); await capture(page, 'exact-table-inspection-light-1366', 'light');
    const adoptedResult = await adopt(page, 'Continue exact donor manifest');
    assert(adoptedResult.references.length === 1 && JSON.stringify(adoptedResult.references[0].reference) === JSON.stringify(material.ownerCsv.reference), 'Result adoption changed its version/checksum or object kind.');
    await openAnalysis(page, unrelated.name);
    assert((await selected(page).getByLabel('Analysis name', { exact: true }).inputValue()) === dirtyName
      && (await selected(page).getByRole('textbox', { name: /^Research question or notes/ }).inputValue()) === dirtyNotes, 'Adoption erased another analysis draft.');
    assert((await api(page, base() + '/' + unrelated.id)).value.analysis.name === unrelated.name, 'Browsing/adoption silently saved another draft.');
    check('Original object history opens without loading a scientific runtime; exact checkpoint and real CSV adoption retain original references and unrelated unsaved name/notes.');

    await bring(page); await category(page, 'results'); await choose(page, missingCsv.label);
    const beforeMissing = Number((await database.query('SELECT count(*) AS n FROM research_analyses')).rows[0].n);
    await database.query('DELETE FROM managed_artifact_versions WHERE id=$1', [missingCsv.reference.versionId]);
    const missingReply = page.waitForResponse(response => new URL(response.url()).pathname === base()
      && response.request().method() === 'POST' && response.status() === 404);
    await form(page).getByRole('button', { name: 'Start analysis with this saved version', exact: true }).click(); await missingReply;
    await work(page).getByRole('alert').getByText('This saved source is no longer available. Refresh saved work or choose another source.', { exact: true }).waitFor();
    await until(async () => !(await form(page).getByLabel('Adopted analysis name', { exact: true }).isDisabled()), 'An explicit pre-admission missing-source rejection left its mutation payload frozen.');
    assert(Number((await database.query('SELECT count(*) AS n FROM research_analyses')).rows[0].n) === beforeMissing, 'A missing source created a partial analysis.');
    await capture(page, 'missing-source-rejected-before-admission-light-1366', 'light');
    await choose(page, material.ownerCsv.label);
    assert(await form(page).getByRole('button', { name: 'Start analysis with this saved version', exact: true }).isEnabled(), 'The researcher could not choose a different valid saved source after explicit rejection.');
    check('A real missing-source404 before admission creates no partial analysis and releases selection so another exact source can be chosen.');

    const lostCatalog = service.interceptNextResponse({ method: 'GET', pathname: catalog(), mode: 'drop' });
    await work(page).getByRole('button', { name: 'Refresh saved work', exact: true }).click();
    await until(() => Boolean(lostCatalog.observation()), 'The catalog transport interruption was not observed.');
    await work(page).getByRole('alert').waitFor();
    assert((await form(page).getByLabel('Adopted analysis name', { exact: true }).inputValue()) === 'Continue exact donor manifest', 'A lost catalog read discarded the selected source name.');
    await capture(page, 'saved-work-read-interrupted-light-1366', 'light');
    const reread = page.waitForResponse(response => new URL(response.url()).pathname === catalog() && response.ok());
    await work(page).getByRole('button', { name: 'Refresh saved work', exact: true }).click(); await reread;
    await until(async () => !(await work(page).getByRole('alert').isVisible()), 'The catalog did not recover after its transport was restored.');
    assert(await form(page).getByRole('button', { name: 'Start analysis with this saved version', exact: true }).isEnabled(), 'Catalog recovery lost the available saved source.');
    check('A genuinely dropped catalog response retains the selected source/name and offers a working refresh after transport recovery.');

    for (const viewport of [{ width: 1366, height: 768 }, { width: 1440, height: 900 }, { width: 1024, height: 768 }]) {
      await page.setViewportSize(viewport);
      const expand = page.getByRole('button', { name: 'Expand sidebar', exact: true });
      if (await expand.isVisible()) await expand.click();
      for (const theme of ['light', 'dark']) {
        await setTheme(page, theme);
        const heading = work(page).getByRole('heading', { name: material.ownerCsv.label, exact: true }); await heading.scrollIntoViewIfNeeded();
        measurements[`${theme}-${viewport.width}`] = await visibleBounds(heading);
        assert(measurements[`${theme}-${viewport.width}`].visible, 'The selected saved-work heading is outside its independently scrolled detail.');
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Existing work causes page-wide horizontal overflow.');
        if (viewport.width === 1024) assert(await page.locator('aside[aria-label="Workspace navigation"]').isVisible(), 'The narrow laptop profile did not keep its actual sidebar expanded.');
        await capture(page, `existing-work-${theme}-${viewport.width}`, theme);
      }
    }
    await page.setViewportSize({ width: 390, height: 844 }); await setTheme(page, 'light'); await category(page, 'objects'); await allRows(page);
    const originalRow = workList(page).getByRole('button', { name: rowName('Small saved Seurat object') });
    await workList(page).hover();
    for (let count = 0; count < 12 && !(await visibleBounds(originalRow)).visible; count++) { await page.mouse.wheel(0, 600); await page.waitForTimeout(75); }
    assert((await visibleBounds(originalRow)).visible, 'The actual paged object could not be reached by natural narrow-list scrolling.');
    const beforeScroll = await workList(page).evaluate(element => element.scrollTop); await originalRow.click();
    const back = work(page).getByRole('button', { name: 'All saved work', exact: true });
    await until(async () => back.evaluate(element => element === document.activeElement), 'Narrow selection did not focus its visible return control.');
    measurements.mobileSelection = await visibleBounds(work(page).getByRole('heading', { name: 'Small saved Seurat object', exact: true }));
    assert(measurements.mobileSelection.visible && !(await workList(page).isVisible()), 'Narrow natural selection leaves the chosen saved-work detail below its list.');
    await capture(page, 'existing-work-mobile-natural-detail-light', 'light');
    await back.focus(); await page.keyboard.press('Enter');
    await until(async () => originalRow.evaluate(element => element === document.activeElement), 'Returning to saved work lost selected-row focus.');
    measurements.mobileReturn = { beforeScroll, afterScroll: await workList(page).evaluate(element => element.scrollTop) };
    assert(Math.abs(measurements.mobileReturn.afterScroll - beforeScroll) <= 2, 'Returning to the long saved-work list lost its scroll position.');
    await capture(page, 'existing-work-mobile-list-return-light', 'light');
    await page.keyboard.press('Enter'); await setTheme(page, 'dark'); await capture(page, 'existing-work-mobile-detail-dark', 'dark');
    check('Genuine light/dark1366/1440/expanded-sidebar1024 profiles remain contained; natural390 list→detail→keyboard-back retains visible heading, row focus and long-list scroll.');

    const reader = await login(users.viewer); await openAnalyses(reader); await bring(reader); await category(reader, 'results'); await choose(reader, readerCsv.label); await inspect(reader);
    await preview(reader).getByRole('table').getByText('Reader1', { exact: true }).waitFor();
    assert(!(await form(reader).count()), 'An owned source exposed fresh adoption controls to a reader.');
    assert((await api(reader, base(), { method: 'POST', body: { requestId: crypto.randomUUID(), name: 'Forbidden reader adoption', references: [readerCsv.reference] } })).status === 403, 'A reader could create an analysis through the service.');
    const readerCatalog = await api(reader, catalog() + '?kind=results');
    assert(!JSON.stringify(readerCatalog.value).includes(material.ownerCsv.reference.versionId) && !JSON.stringify(readerCatalog.value).includes(colleagueCheckpoint), 'Reader result discovery exposed another owner private version.');
    await capture(reader, 'reader-owned-source-inspection-light-1366', 'light');
    await database.query('DELETE FROM project_members WHERE project_id=$1 AND user_id=$2', [service.project.id, users.viewer.id]);
    const deniedCatalog = reader.waitForResponse(response => new URL(response.url()).pathname === catalog() && response.status() === 404);
    await work(reader).getByRole('button', { name: 'Refresh saved work', exact: true }).click(); await deniedCatalog;
    await work(reader).getByRole('alert').waitFor();
    await until(async () => (await workList(reader).getByRole('button').count()) === 0 && !(await preview(reader).count()), 'Fresh membership denial retained a cached private source projection.');
    assert(!(await work(reader).getByText('No saved results or files yet', { exact: true }).count()), 'Denied source access was presented as an authoritative empty catalog.');
    await capture(reader, 'revoked-source-cleared-light-1366', 'light');
    const outsider = await login(users.outsider);
    for (const url of [catalog(), catalog() + '?kind=results', `/api/artifact-versions/${service.project.id}/${material.ownerCsv.reference.versionId}/preview`]) assert((await api(outsider, url)).status === 404, 'A nonmember discovered project saved source.');
    const boundary = await login(users.owner); await openAnalyses(boundary, secondProject); await bring(boundary);
    await work(boundary).getByText('No analysis objects yet', { exact: true }).waitFor();
    assert((await api(boundary, `/api/artifact-versions/${secondProject.id}/${material.ownerCsv.reference.versionId}/preview`)).status === 404, 'An authorized other project granted access to the original project source.');
    await capture(boundary, 'separate-project-no-source-leak-light-1366', 'light');
    check('A project reader inspects only their own saved CSV without adoption; colleague/private versions, nonmembers and other project namespaces retain their actual access boundaries.');

    await page.setViewportSize({ width: 1366, height: 768 }); await setTheme(page, 'light');
    await category(page, 'results'); await choose(page, material.ownerCsv.label); await form(page).getByLabel('Adopted analysis name', { exact: true }).fill('Recovered exact saved-work adoption');
    const beforePending = creates().length, drop = service.interceptNextResponse({ method: 'POST', pathname: base(), mode: 'drop' });
    await form(page).getByRole('button', { name: 'Start analysis with this saved version', exact: true }).click();
    await until(() => Boolean(drop.observation()?.value?.analysis?.id), 'The dropped saved-work creation was not actually committed.');
    const admitted = drop.observation().value.analysis;
    await form(page).getByRole('button', { name: 'Retry analysis creation', exact: true }).waitFor();
    assert(await form(page).getByLabel('Adopted analysis name', { exact: true }).isDisabled()
      && await work(page).getByRole('combobox', { name: 'Saved work category', exact: true }).isDisabled(), 'Unconfirmed adoption allowed the admitted source/payload to change.');
    await database.query("UPDATE project_members SET role='viewer' WHERE project_id=$1 AND user_id=$2", [service.project.id, users.owner.id]);
    await capture(page, 'adoption-reply-unknown-after-downgrade-light-1366', 'light');
    const retry = page.waitForResponse(response => new URL(response.url()).pathname === base() && response.request().method() === 'POST' && response.status() === 200);
    await form(page).getByRole('button', { name: 'Retry analysis creation', exact: true }).click(); const recovered = (await (await retry).json()).analysis;
    assert(recovered.id === admitted.id && recovered.version === admitted.version && JSON.stringify(recovered.references) === JSON.stringify(admitted.references), 'Recovery duplicated or changed the admitted analysis.');
    const admissions = creates().slice(beforePending);
    assert(admissions.length === 2 && admissions[0].requestId === admissions[1].requestId && admissions[0].payloadSha256 === admissions[1].payloadSha256, 'Lost-reply recovery changed the saved-work UUID or payload.');
    const downgraded = await login(users.owner); await openAnalyses(downgraded); await bring(downgraded); await category(downgraded, 'results'); await choose(downgraded, material.ownerCsv.label);
    assert(!(await form(downgraded).count()), 'A freshly loaded downgraded reader still had fresh adoption controls.');
    assert((await api(downgraded, base(), { method: 'POST', body: { requestId: crypto.randomUUID(), name: 'Fresh forbidden adoption', references: [material.ownerCsv.reference] } })).status === 403, 'Receipt replay accidentally granted a downgraded writer new create access.');
    assert(Number((await database.query('SELECT count(*) AS n FROM research_analyses WHERE id=$1', [admitted.id])).rows[0].n) === 1, 'Uncertain adoption created duplicate identities.');
    check('An actually committed lost adoption reply retries the exact UUID/body after service-role downgrade; current reader recovery does not authorize any fresh create.');

    assert(sha(fs.readFileSync(material.checkpoint.filename)) === material.checkpoint.reference.sha256
      && sha(fs.readFileSync(material.ownerCsv.filename)) === material.ownerCsv.reference.sha256, 'Discovery/adoption changed original retained scientific bytes.');
    assert(Number((await database.query('SELECT count(*) AS n FROM research_documents')).rows[0].n) === 0, 'Adoption invented notebook source.');
    const dispatches = requests.filter(value => value.method === 'POST' && (/^\/api\/r\//.test(value.pathname) || /^\/api\/private-r-kernels(?:\/|$)/.test(value.pathname) || /^\/api\/projects\/[^/]+\/jobs$/.test(value.pathname) || /\/instances\/[^/]+\/run$/.test(value.pathname)));
    assert(dispatches.length === 0 && Number((await database.query('SELECT count(*) AS n FROM jobs')).rows[0].n) === initialJobCount
      && Number((await database.query('SELECT count(*) AS n FROM private_r_kernels')).rows[0].n) === 0, 'Saved-work organization started new scientific computation.');
    assert(errors.length === 0, 'The actual saved-work UI raised an uncaught browser error or changed compiled assets.');
    check('Exact saved source bytes and original histories remain unchanged; no notebook source, scientific dispatch, new job, kernel or browser error is introduced.');
    const report = { passed: true, checks, screenshots, profiles, measurements, compiledAssets: assets, browserErrors: errors,
      scientificDispatchCount: dispatches.length, admittedAnalysisId: admitted.id,
      sourceVersions: [material.checkpoint, material.ownerCsv, readerCsv].map(value => ({ reference: value.reference, ...(value.sizeBytes === undefined ? {} : { sizeBytes: value.sizeBytes }) })),
      fixture: 'Owned disposable production HTTPS/auth/PostgreSQL/storage; cached isolated R image generates one tiny synthetic checkpoint; health-only application R substitute',
      exclusions: ['Scientific runtime execution through the app', 'SSH transport', 'reconstructed notebook or code history', 'pending adoption after whole-app closure', 'representative researcher usability observation'] };
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(report, null, 2) + '\n');
    console.log('Existing saved work UI acceptance passed; report: ' + directory); return report;
  } catch (failure) {
    await page?.screenshot({ path: path.join(directory, 'failure.png'), fullPage: true }).catch(() => {});
    const snapshot = await page?.locator('main').ariaSnapshot().catch(() => null); if (snapshot) fs.writeFileSync(path.join(directory, 'failure-accessibility.txt'), snapshot);
    let message = failure.message;
    for (const secret of [service?.databaseUrl, service?.storageRoot, service?.account?.password, ...Object.values(users).map(user => user.email)].filter(Boolean)) message = message.split(secret).join('[private fixture]');
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ passed: false, checks, screenshots, profiles, measurements, error: message, compiledAssets: assets, browserErrors: errors }, null, 2) + '\n');
    throw new Error(message);
  } finally { await browser?.close(); await database?.end(); await service?.stop(); }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
