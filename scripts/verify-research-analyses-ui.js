#!/usr/bin/env node
'use strict';

const { waitFor } = require('./browser-helpers');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { chromium } = require('playwright');
const { Client } = require('pg');
const { createDesktopTunnelServiceFixture } = require('./desktop-tunnel-service-fixture.cjs');
const root = path.resolve(__dirname, '..');
const executeFile = promisify(execFile);
const assert = (value, message) => { if (!value) throw new Error(message); };
const identity = prefix => prefix + '_' + crypto.randomBytes(12).toString('hex');
const checksum = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const regex = value => new RegExp('^' + value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

function ownedPath(storageRoot, key) {
  const directory = path.resolve(storageRoot);
  const filename = path.resolve(directory, ...key.split('/'));
  assert(filename.startsWith(directory + path.sep), 'A fixture file escaped its owned storage.');
  return filename;
}
async function seedSavedMaterial(database, service, owner, analyst, image) {
  const projectId = service.project.id;
  const objectId = identity('ao'), jobId = identity('job'), checkpointId = identity('art');
  const checkpointKey = `projects/${projectId}/checkpoints/${jobId}/checkpoint.rds`;
  const checkpointPath = ownedPath(service.storageRoot, checkpointKey);
  const directory = path.dirname(checkpointPath);
  fs.mkdirSync(directory, { recursive: true });
  fs.chmodSync(directory, 0o777);
  const producer = 'traceomics-analysis-seed-' + process.pid + '-' + crypto.randomBytes(5).toString('hex');
  try {
    await executeFile('docker', ['run', '--rm', '--name', producer, '--pull', 'never',
      '--label', 'traceomics.review=research-analyses-ui', '--network', 'none', '--read-only',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', '10001:10001',
      '--pids-limit', '128', '--memory', '1g', '--cpus', '1',
      '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=128m',
      '--mount', `type=bind,source=${directory},target=/fixture`, '--entrypoint', 'Rscript', image,
      '--vanilla', '-e', `suppressPackageStartupMessages({library(Seurat);library(Matrix)})
        set.seed(1919); counts<-matrix(rpois(20L*12L,3),nrow=20L,ncol=12L)
        rownames(counts)<-paste0('Gene',seq_len(nrow(counts)));colnames(counts)<-paste0('Cell',seq_len(ncol(counts)))
        obj<-CreateSeuratObject(Matrix(counts,sparse=TRUE));obj$condition<-rep(c('control','treated'),each=6L)
        stopifnot(ncol(obj)==12L,nrow(obj)==20L);saveRDS(list(global=obj,raw=obj),'/fixture/checkpoint.rds')`],
    { cwd: root, windowsHide: true, timeout: 90000, maxBuffer: 65536 });
  } catch { throw new Error('The cached reviewed R image could not produce the tiny disposable checkpoint. No image is pulled or built by this harness.'); }
  finally {
    fs.chmodSync(directory, 0o755);
    await executeFile('docker', ['rm', '-f', producer], { windowsHide: true, timeout: 15000 }).catch(() => {});
  }
  const bytes = fs.readFileSync(checkpointPath);
  await database.query(`INSERT INTO analysis_objects(id,owner_user_id,project_id,object_type,display_name,metadata_json)
    VALUES($1,$2,$3,'seurat','Small saved Seurat object',$4)`,
  [objectId, owner.id, projectId, { acceptanceFixture: true, synthetic: true, cells: 12, genes: 20 }]);
  await database.query(`INSERT INTO jobs(id,owner_user_id,project_id,analysis_object_id,result_analysis_object_id,job_type,status,started_at,completed_at)
    VALUES($1,$2,$3,$4,$4,'checkpoint.noop','completed',NOW(),NOW())`, [jobId, owner.id, projectId, objectId]);
  await database.query(`INSERT INTO job_artifacts(id,project_id,job_id,result_analysis_object_id,created_by_user_id,artifact_type,name,mime_type,storage_kind,storage_uri,checksum_sha256,size_bytes,status,metadata_json)
    VALUES($1,$2,$3,$4,$5,'checkpoint','Small Seurat checkpoint','application/x-r-rds','local_internal',$6,$7,$8,'available',$9)`,
  [checkpointId, projectId, jobId, objectId, owner.id, checkpointKey, checksum(bytes), bytes.length, { acceptanceFixture: true, synthetic: true }]);
  async function csv(userId, label, content) {
    const versionId = identity('av'), artifactId = identity('af');
    const key = `projects/${projectId}/artifacts/${versionId}/source.csv`;
    const filename = ownedPath(service.storageRoot, key);
    const bytes = Buffer.from(content);
    fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, bytes);
    await database.query(`INSERT INTO managed_artifact_versions(id,artifact_id,project_id,owner_user_id,name,version_number,artifact_type,format_json,mime_type,checksum_sha256,size_bytes,storage_key)
      VALUES($1,$2,$3,$4,$5,1,'table',$6,'text/csv',$7,$8,$9)`,
    [versionId, artifactId, projectId, userId, label, { id: 'org.ietf.csv', version: '1' }, checksum(bytes), bytes.length, key]);
    return { label, reference: { kind: 'artifact-version', versionId, sha256: checksum(bytes) }, filename, sizeBytes: bytes.length };
  }
  const ownerCsv = await csv(owner.id, 'Donor sample sheet', 'sample,donor,condition\nS1,D1,control\nS2,D2,treated\n');
  const analystCsv = await csv(analyst.id, 'Colleague condition manifest', 'condition,display\ncontrol,Control\ntreated,Treated\n');
  return { ownerCsv, analystCsv, checkpoint: { label: 'Small Seurat checkpoint',
    reference: { kind: 'analysis-object', analysisObjectId: objectId, checkpointVersionId: checkpointId, sha256: checksum(bytes) },
    filename: checkpointPath, sizeBytes: bytes.length } };
}
async function main({ artifactDirectory } = {}) {
  const image = process.env.EXPERT_R_SANDBOX_IMAGE;
  assert(/^(?:[^\s@]+@)?sha256:[a-f0-9]{64}$/.test(image || ''), 'Set EXPERT_R_SANDBOX_IMAGE to an existing reviewed immutable R image for the tiny checkpoint fixture.');
  const directory = path.resolve(artifactDirectory || path.join(root, 'playwright', 'report', 'research-analyses-' + Date.now()));
  assert(directory.startsWith(path.join(root, 'playwright', 'report') + path.sep), 'UI evidence must remain inside ignored workspace report storage.');
  assert(fs.existsSync(path.join(root, 'dist', 'index.html')), 'Build the production application before this acceptance run.');
  fs.mkdirSync(directory, { recursive: true });
  const checks = [], errors = [], screenshots = [], requests = [], compiledAssets = {}, creationRequests = [], usabilityFindings = [], uiMeasurements = {};
  const check = message => { checks.push(message); console.log('PASS: ' + message); };
  let service, database, browser, page, currentAnalysis;
  const users = {};
  let secondProject;
  const basePath = () => `/api/projects/${service.project.id}/analyses`;
  const exactPath = () => basePath() + '/' + currentAnalysis.id;
  const selected = target => target.getByRole('region', { name: 'Selected analysis', exact: true });
  const list = target => target.getByRole('region', { name: 'Project analyses', exact: true });
  async function browserApi(target, url, { method = 'GET', body } = {}) {
    return target.evaluate(async ({ url, method, body }) => {
      const response = await fetch(url, { method, credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-Traceomics-Csrf': '1' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, value: await response.json() };
    }, { url, method, body });
  }
  async function nav(target, name) {
    const expand = target.getByRole('button', { name: 'Expand sidebar', exact: true });
    if (await expand.isVisible()) await expand.click();
    await target.getByRole('button', { name, exact: typeof name === 'string' }).click();
  }
  async function openAnalyses(target, project = service.project) {
    await nav(target, /^Data workspace,/);
    await target.getByRole('button', { name: regex(project.name) }).click();
    await nav(target, 'Analyses');
    await target.getByRole('heading', { name: 'Analyses', exact: true }).waitFor();
    await list(target).getByRole('combobox').waitFor();
    await waitFor(async () => !(await list(target).getByText('Loading analyses…', { exact: true }).isVisible()), 'Project analyses did not finish loading.');
  }
  async function openAnalysis(target, name) {
    if (!(await list(target).isVisible())) {
      await selected(target).getByRole('button', { name: 'All analyses', exact: true }).click();
      await list(target).waitFor({ state: 'visible' });
    }
    await list(target).getByRole('button', { name: regex(name) }).click();
    await waitFor(async () => (await selected(target).getByLabel('Analysis name', { exact: true }).inputValue()) === name, 'The selected analysis name did not reopen.');
  }
  async function login(account, viewport = { width: 1440, height: 900 }) {
    const context = await browser.newContext({ viewport });
    const target = await context.newPage();
    target.on('pageerror', error => errors.push(error.message));
    target.on('request', request => {
      const pathname = new URL(request.url()).pathname;
      if (/^\/api\//.test(pathname)) requests.push({ pathname, method: request.method() });
      if (request.method() === 'POST' && pathname === basePath()) {
        try { creationRequests.push(request.postDataJSON().requestId); } catch { /* Malformed input fails elsewhere. */ }
      }
    });
    target.on('response', async response => {
      const pathname = new URL(response.url()).pathname;
      if (/^\/assets\/.*\.js$/.test(pathname) && response.ok()) {
        try { compiledAssets[pathname] = checksum(await response.body()); } catch { /* Failed assets also raise a browser error. */ }
      }
    });
    await target.goto(service.endpoint);
    await target.getByPlaceholder('researcher@lab.edu').fill(account.email);
    await target.getByLabel('Password', { exact: true }).fill(service.account.password);
    await target.getByRole('button', { name: /Open Workbench/ }).click();
    await target.getByText('Connection details', { exact: true }).waitFor();
    return target;
  }
  async function capture(target, name, expectedTheme) {
    const actualTheme = await target.evaluate(() => document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light');
    if (expectedTheme) assert(actualTheme === expectedTheme, 'A themed screenshot did not match the actual rendered document theme.');
    uiMeasurements.screenshotThemes ||= {};
    uiMeasurements.screenshotThemes[name] = { theme: actualTheme, viewport: target.viewportSize() };
    const filename = name + '.png';
    await target.screenshot({ path: path.join(directory, filename), fullPage: true }); screenshots.push(filename);
  }
  async function boundsInViewport(locator) {
    return locator.evaluate(element => {
      const bounds = element.getBoundingClientRect();
      let clipTop = 0, clipBottom = window.innerHeight;
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        if (/(auto|scroll|hidden|clip)/.test(getComputedStyle(parent).overflowY)) {
          const clipping = parent.getBoundingClientRect();
          clipTop = Math.max(clipTop, clipping.top); clipBottom = Math.min(clipBottom, clipping.bottom);
        }
      }
      return { top: bounds.top, bottom: bounds.bottom, viewportHeight: window.innerHeight, clipTop, clipBottom,
        visible: bounds.top >= clipTop && bounds.bottom <= clipBottom };
    });
  }
  async function settleReply(target, request) {
    const response = await request.response();
    if (response) await response.finished();
    await target.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  }
  async function save(target, expected = 200) {
    const response = target.waitForResponse(value => new URL(value.url()).pathname === exactPath() && value.request().method() === 'PATCH');
    await selected(target).getByRole('button', { name: 'Save changes', exact: true }).click();
    const result = await response;
    assert(result.status() === expected, 'An analysis save returned an unexpected status.');
    const body = await result.json();
    if (expected === 200) currentAnalysis = body.analysis;
    return body;
  }
  async function setTheme(target, theme) {
    const actual = await target.evaluate(() => document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light');
    if (actual === theme) return;
    const button = target.getByRole('button', { name: 'Switch to ' + theme + ' mode', exact: true });
    let openedNavigation = false;
    if (!(await button.isVisible())) {
      await target.getByRole('button', { name: 'Expand sidebar', exact: true }).click();
      openedNavigation = true;
    }
    await button.click();
    await waitFor(async () => (await target.evaluate(() => document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light')) === theme, 'The theme toggle did not change the rendered document theme.');
    if (openedNavigation) {
      await target.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
      await waitFor(async () => (await target.locator('aside[aria-label="Workspace navigation"]').getAttribute('aria-hidden')) === 'true', 'Theme selection did not close the navigation opened to reach its toggle.');
    }
  }
  try {
    service = await createDesktopTunnelServiceFixture({ artifactDirectory: directory,
      configureProjectEnvironment: async ({ env, project, account }) => {
        const seed = new Client({ connectionString: env.DATABASE_URL }); await seed.connect();
        try {
          const owner = (await seed.query('SELECT * FROM users WHERE email=$1', [account.email])).rows[0];
          users.owner = { id: Number(owner.id), email: account.email };
          const projectRow = (await seed.query('SELECT * FROM projects WHERE id=$1', [project.id])).rows[0];
          for (const role of ['analyst', 'viewer', 'outsider']) {
            const email = role + '-' + crypto.randomBytes(8).toString('hex') + '@example.invalid';
            const user = (await seed.query('INSERT INTO users(email,password_hash,salt,display_name) VALUES($1,$2,$3,$4) RETURNING id',
              [email, owner.password_hash, owner.salt, 'Acceptance ' + role])).rows[0];
            users[role] = { id: Number(user.id), email };
            if (role !== 'outsider') {
              await seed.query("INSERT INTO organization_members(organization_id,user_id,role) VALUES($1,$2,'member')", [projectRow.organization_id, user.id]);
              await seed.query('INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,$3)', [project.id, user.id, role]);
            }
          }
          secondProject = { id: identity('proj'), name: 'Independent study' };
          await seed.query('INSERT INTO projects(id,organization_id,name,created_by_user_id) VALUES($1,$2,$3,$4)', [secondProject.id, projectRow.organization_id, secondProject.name, owner.id]);
          await seed.query("INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,'owner')", [secondProject.id, owner.id]);
        } finally { await seed.end(); }
        return {};
      } });
    database = new Client({ connectionString: service.databaseUrl }); await database.connect();
    const material = await seedSavedMaterial(database, service, users.owner, users.analyst, image);
    const leaf = new crypto.X509Certificate(fs.readFileSync(service.certificatePath));
    const authority = new crypto.X509Certificate(fs.readFileSync(service.caCertificatePath));
    assert(leaf.verify(authority.publicKey) && leaf.checkHost(new URL(service.endpoint).hostname), 'Disposable HTTPS identity could not be verified.');
    const spki = checksum(leaf.publicKey.export({ type: 'spki', format: 'der' }));
    browser = await chromium.launch({ headless: true, args: [
      '--host-resolver-rules=MAP ' + new URL(service.endpoint).hostname + ' 127.0.0.1',
      '--ignore-certificate-errors-spki-list=' + Buffer.from(spki, 'hex').toString('base64'),
    ] });
    page = await login(users.owner, { width: 1366, height: 768 });
    await openAnalyses(page);
    await page.getByText('No analyses yet', { exact: true }).waitFor();
    const newButton = page.getByRole('button', { name: 'New analysis', exact: true });
    await newButton.focus(); await page.keyboard.press('Enter');
    const form = page.getByRole('form', { name: 'New analysis', exact: true });
    await form.getByLabel('Analysis name', { exact: true }).fill('Treatment response across donors');
    await page.keyboard.press('Tab');
    assert(await form.getByRole('textbox', { name: /^Research question or notes/ }).evaluate(element => element === document.activeElement), 'Keyboard navigation skipped the research question.');
    const originalNotes = 'Does treatment change the response across donors?\n\nUse donor-level replication and retain the sample manifest.';
    await form.getByRole('textbox', { name: /^Research question or notes/ }).fill(originalNotes);
    const drop = service.interceptNextResponse({ method: 'POST', pathname: basePath(), mode: 'drop' });
    await form.getByRole('button', { name: 'Create analysis', exact: true }).click();
    await waitFor(() => Boolean(drop.observation()), 'The original analysis admission was not observed.');
    assert(drop.observation().status === 201 && drop.observation().value?.analysis?.id, 'The dropped reply did not follow a real admitted analysis.');
    const admittedId = drop.observation().value.analysis.id;
    await form.getByRole('button', { name: 'Retry create', exact: true }).waitFor();
    assert(await form.getByLabel('Analysis name', { exact: true }).isDisabled(), 'Unconfirmed creation allowed its original payload to change.');
    await capture(page, 'create-reply-unconfirmed');
    const retryResponse = page.waitForResponse(response => new URL(response.url()).pathname === basePath() && response.request().method() === 'POST' && response.status() === 200);
    await form.getByRole('button', { name: 'Retry create', exact: true }).click();
    currentAnalysis = (await (await retryResponse).json()).analysis;
    assert(currentAnalysis.id === admittedId && creationRequests.length === 2 && creationRequests[0] === creationRequests[1], 'UI recovery did not preserve the original creation request and analysis identity.');
    await selected(page).getByRole('textbox', { name: /^Research question or notes/ }).waitFor();
    assert((await selected(page).getByRole('textbox', { name: /^Research question or notes/ }).inputValue()) === originalNotes, 'Research notes did not survive uncertain creation.');
    assert(Number((await database.query('SELECT count(*) AS n FROM research_analyses WHERE project_id=$1', [service.project.id])).rows[0].n) === 1, 'Retry created duplicate analyses.');
    check('Keyboard creation traverses real HTTPS/auth/PostgreSQL; a dropped admitted reply is recovered with the same UUID and exactly one analysis.');

    const renamed = 'Treatment response and donor effects';
    await selected(page).getByLabel('Analysis name', { exact: true }).fill(renamed);
    await selected(page).getByRole('textbox', { name: /^Research question or notes/ }).fill(originalNotes + '\nRecord the chosen contrast before running.');
    await save(page);
    await page.reload(); await page.getByText('Connection details', { exact: true }).waitFor();
    await openAnalyses(page); await openAnalysis(page, renamed);
    assert((await browserApi(page, exactPath())).value.analysis.id === admittedId, 'Full reload changed the analysis identity.');
    await selected(page).getByRole('button', { name: 'Link saved material', exact: true }).click();
    await selected(page).getByRole('checkbox', { name: new RegExp(material.ownerCsv.label) }).check();
    await selected(page).getByRole('checkbox', { name: new RegExp(material.checkpoint.label) }).check();
    await capture(page, 'saved-material-picker');
    await save(page);
    assert(currentAnalysis.references.length === 2 && currentAnalysis.references.every(item => item.access === 'available'), 'The two exact owned saved versions were not linked.');
    assert(currentAnalysis.references.some(item => item.reference.sha256 === checksum(fs.readFileSync(material.checkpoint.filename))), 'The linked checkpoint checksum differs from actual saved RDS bytes.');
    assert(currentAnalysis.references.some(item => item.reference.sha256 === checksum(fs.readFileSync(material.ownerCsv.filename))), 'The linked CSV checksum differs from actual saved bytes.');
    const csvPreview = await browserApi(page, `/api/artifact-versions/${service.project.id}/${material.ownerCsv.reference.versionId}/preview`);
    assert(csvPreview.status === 200 && csvPreview.value.integrityVerified === true && csvPreview.value.preview.family === 'table'
      && csvPreview.value.preview.rows.length === 2, 'The saved CSV could not be integrity-verified and inspected through its real byte API.');
    const checkpointPreview = await browserApi(page, `/api/artifact-versions/${service.project.id}/${material.checkpoint.reference.checkpointVersionId}/preview`);
    assert(checkpointPreview.status === 200 && checkpointPreview.value.integrityVerified === true, 'The selected checkpoint does not resolve to verified stored bytes.');
    check('Name and multiline notes survive reload; the picker links real CSV and a tiny valid Seurat checkpoint without copying or executing them.');

    // A held pre-save read must not replace a later successful local save.
    const heldSelection = service.interceptNextResponse({ method: 'GET', pathname: exactPath(), mode: 'hold' });
    const oldSelectionRequest = page.waitForRequest(value => new URL(value.url()).pathname === exactPath() && value.method() === 'GET');
    await list(page).getByRole('button', { name: regex(renamed) }).click();
    const selectedRead = await oldSelectionRequest;
    await waitFor(() => Boolean(heldSelection.observation()), 'The stale selected-analysis response was not held.');
    const latestName = 'Treatment response with retained evidence';
    await selected(page).getByLabel('Analysis name', { exact: true }).fill(latestName);
    await save(page); const savedVersion = currentAnalysis.version;
    heldSelection.release();
    await settleReply(page, selectedRead);
    await waitFor(async () => (await selected(page).getByLabel('Analysis name', { exact: true }).inputValue()) === latestName, 'A stale selected read replaced the newer saved name.');
    const heldList = service.interceptNextResponse({ method: 'GET', pathname: basePath(), mode: 'hold' });
    const oldListRequest = page.waitForRequest(value => new URL(value.url()).pathname === basePath() && value.method() === 'GET');
    await list(page).getByRole('button', { name: 'Refresh analyses', exact: true }).click();
    const listRead = await oldListRequest;
    await waitFor(() => Boolean(heldList.observation()), 'The stale list response was not held.');
    await selected(page).getByRole('textbox', { name: /^Research question or notes/ }).fill(originalNotes + '\nEvidence is retained with exact versions.');
    await save(page); heldList.release(); await settleReply(page, listRead);
    assert(currentAnalysis.version > savedVersion && (await selected(page).getByLabel('Analysis name', { exact: true }).inputValue()) === latestName, 'A delayed list/read regressed the selected draft.');
    check('Held real pre-save detail and list replies cannot overwrite a newer successful save.');

    for (let index = 1; index <= 12; index++) {
      const result = await browserApi(page, basePath(), { method: 'POST', body: { requestId: crypto.randomUUID(),
        name: 'Mobile selection study ' + String(index).padStart(2, '0'), description: 'Persisted analysis used to check a realistic long project list.' } });
      assert(result.status === 201, 'A real many-analysis navigation fixture could not be created.');
    }
    await list(page).getByRole('button', { name: 'Refresh analyses', exact: true }).click();
    await list(page).getByRole('button', { name: regex('Mobile selection study 12') }).waitFor();

    await page.setViewportSize({ width: 1366, height: 768 });
    const oldestRow = list(page).getByRole('button', { name: regex(latestName) });
    const listBounds = await list(page).boundingBox();
    await page.mouse.move(listBounds.x + Math.min(80, listBounds.width / 2), 600);
    for (let attempt = 0; attempt < 12; attempt++) {
      const rowBounds = await boundsInViewport(oldestRow);
      if (rowBounds.visible) break;
      await page.mouse.wheel(0, rowBounds.top < rowBounds.clipTop ? -400 : 400);
      await page.waitForTimeout(100);
    }
    assert((await boundsInViewport(oldestRow)).visible, 'The oldest desktop analysis row could not be reached by ordinary list scrolling.');
    await oldestRow.click();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const desktopSelection = {
      name: await boundsInViewport(selected(page).getByLabel('Analysis name', { exact: true })),
      notes: await boundsInViewport(selected(page).getByRole('textbox', { name: /^Research question or notes/ })),
      save: await boundsInViewport(selected(page).getByRole('button', { name: 'Save changes', exact: true })),
      archive: await boundsInViewport(selected(page).getByRole('button', { name: 'Archive', exact: true })),
    };
    uiMeasurements.desktopNaturalSelection = desktopSelection;
    await capture(page, 'desktop-many-analyses-natural-selection');
    if (!desktopSelection.name.visible) {
      usabilityFindings.push({ severity: 'High', location: 'Analyses on a desktop with many project analyses',
        problem: 'Scrolling to and selecting the oldest project analysis leaves its selected name outside the visible detail area.',
        recommendation: 'Keep the selected detail independently visible or return its heading and primary editor to view after list selection.',
        bounds: desktopSelection, screenshot: 'desktop-many-analyses-natural-selection.png' });
      console.log('FINDING: A natural desktop long-list selection leaves the selected editor outside the viewport.');
    }

    for (const viewport of [{ width: 1366, height: 768 }, { width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      for (const theme of ['light', 'dark']) {
        await setTheme(page, theme);
        await selected(page).getByLabel('Analysis name', { exact: true }).scrollIntoViewIfNeeded();
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'The analysis view overflows the viewport horizontally.');
        assert(await selected(page).evaluate(element => element.scrollWidth <= element.clientWidth), 'Linked material overflows its analysis column.');
        await capture(page, `analysis-${theme}-${viewport.width}x${viewport.height}`, theme);
      }
    }
    await openAnalysis(page, 'Mobile selection study 12');
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const mobileSelection = await selected(page).getByLabel('Analysis name', { exact: true }).evaluate(element => {
      const bounds = element.getBoundingClientRect();
      return { top: bounds.top, bottom: bounds.bottom, viewportHeight: window.innerHeight,
        visible: bounds.top >= 0 && bounds.top < window.innerHeight && bounds.bottom > 0 };
    });
    uiMeasurements.mobileNaturalSelection = mobileSelection;
    await capture(page, 'mobile-many-analyses-natural-selection');
    if (!mobileSelection.visible) {
      usabilityFindings.push({ severity: 'High', location: 'Analyses on a narrow screen with many project analyses',
        problem: 'Selecting a visible analysis leaves its selected question and editor below the long list, outside the viewport.',
        recommendation: 'Provide a mobile list/detail transition or move focus and scroll to the selected analysis with a clear return-to-list control.',
        bounds: mobileSelection, screenshot: 'mobile-many-analyses-natural-selection.png' });
      console.log('FINDING: A natural mobile selection leaves the chosen question below the long project list.');
    }
    const mobileBack = selected(page).getByRole('button', { name: 'All analyses', exact: true });
    assert(await mobileBack.isVisible() && !(await list(page).isVisible()), 'The narrow detail view lacks a clear return to its project list.');
    assert(await mobileBack.evaluate(element => element === document.activeElement), 'Natural mobile selection did not place keyboard focus at the detail return control.');
    const mobileDraft = 'An unsaved interpretation survives returning to the project list.';
    await selected(page).getByRole('textbox', { name: /^Research question or notes/ }).fill(mobileDraft);
    await mobileBack.focus(); await page.keyboard.press('Enter');
    await list(page).waitFor({ state: 'visible' });
    const selectedMobileRow = list(page).getByRole('button', { name: regex('Mobile selection study 12') });
    assert(await selectedMobileRow.evaluate(element => element === document.activeElement), 'Returning to the mobile list did not restore focus to the selected row.');
    assert(!(await selected(page).isVisible()), 'The narrow list view still displays the selected editor below its rows.');
    await capture(page, 'mobile-return-to-project-list');
    await page.keyboard.press('Enter');
    await selected(page).getByLabel('Analysis name', { exact: true }).waitFor();
    assert((await selected(page).getByRole('textbox', { name: /^Research question or notes/ }).inputValue()) === mobileDraft, 'Mobile list navigation discarded an unsaved draft.');
    await openAnalysis(page, latestName);
    const expand = page.getByRole('button', { name: 'Expand sidebar', exact: true });
    await expand.click();
    const navigation = page.locator('aside[aria-label="Workspace navigation"]');
    await navigation.waitFor({ state: 'visible' }); await page.keyboard.press('Tab');
    assert(await navigation.evaluate(element => element.contains(document.activeElement)), 'Keyboard focus escaped the mobile navigation overlay.');
    await capture(page, 'mobile-navigation-overlay'); await page.keyboard.press('Escape');
    assert(await expand.evaluate(element => element === document.activeElement), 'Escape did not return focus to the mobile navigation opener.');
    await page.setViewportSize({ width: 1440, height: 900 }); await setTheme(page, 'light');
    check('Both themes fit 1366×768, 1440×900 and 390×844; natural mobile detail/list transitions retain drafts and keyboard focus, and the navigation overlay traps and returns focus.');

    let response = page.waitForResponse(value => new URL(value.url()).pathname === exactPath() && value.request().method() === 'PATCH');
    await selected(page).getByRole('button', { name: 'Archive', exact: true }).click();
    currentAnalysis = (await (await response).json()).analysis;
    assert(currentAnalysis.status === 'archived', 'Archive did not persist.');
    await list(page).getByRole('combobox').selectOption('archived');
    await openAnalysis(page, latestName);
    assert(await selected(page).getByLabel('Analysis name', { exact: true }).getAttribute('readonly') !== null, 'An archived analysis still exposes a writable field.');
    await capture(page, 'archived-analysis');
    response = page.waitForResponse(value => new URL(value.url()).pathname === exactPath() && value.request().method() === 'PATCH');
    await selected(page).getByRole('button', { name: 'Restore analysis', exact: true }).click();
    currentAnalysis = (await (await response).json()).analysis;
    assert(currentAnalysis.status === 'active', 'Restore did not persist.');
    await list(page).getByRole('combobox').selectOption('active');
    await openAnalysis(page, latestName);
    check('Archive keeps an inspectable immutable history and read-only editor; restoring returns the same analysis identity to the active list.');

    const colleague = await login(users.analyst);
    await openAnalyses(colleague); await openAnalysis(colleague, latestName);
    const localNotes = 'Owner interpretation retained through a concurrent colleague update.\nCompare each donor before a scientific conclusion.';
    await selected(page).getByRole('textbox', { name: /^Research question or notes/ }).fill(localNotes);
    const checkpointRow = selected(page).getByRole('region', { name: 'Linked material', exact: true }).getByRole('listitem')
      .filter({ hasText: material.checkpoint.reference.checkpointVersionId.slice(-8) });
    await checkpointRow.getByRole('button', { name: /^Unlink/ }).click();
    const colleagueName = 'Colleague reviewed donor response';
    await selected(colleague).getByLabel('Analysis name', { exact: true }).fill(colleagueName);
    await selected(colleague).getByRole('button', { name: 'Link saved material', exact: true }).click();
    await selected(colleague).getByRole('checkbox', { name: new RegExp(material.analystCsv.label) }).check();
    await save(colleague);
    const conflict = await save(page, 409);
    assert(conflict.analysis.name === colleagueName && (await selected(page).getByRole('textbox', { name: /^Research question or notes/ }).inputValue()) === localNotes, 'A real concurrent-edit conflict discarded the local draft.');
    await selected(page).getByRole('region', { name: 'Newer saved version', exact: true }).waitFor();
    await capture(page, 'concurrent-edit-conflict');
    await selected(page).getByRole('button', { name: 'Keep my edits with latest saved work', exact: true }).click();
    assert((await selected(page).getByLabel('Analysis name', { exact: true }).inputValue()) === colleagueName, 'Rebase overwrote the colleague name with an untouched stale field.');
    await save(page);
    const finalReferences = currentAnalysis.references.map(item => item.reference);
    assert(currentAnalysis.description === localNotes && finalReferences.length === 2
      && finalReferences.some(ref => ref.versionId === material.ownerCsv.reference.versionId)
      && finalReferences.some(ref => ref.versionId === material.analystCsv.reference.versionId)
      && !finalReferences.some(ref => ref.checkpointVersionId === material.checkpoint.reference.checkpointVersionId), 'Three-way review lost a colleague addition, owner removal, or local notes.');
    await capture(page, 'concurrent-edit-rebased');
    check('Two real accounts produce 409; local notes survive and review merges the colleague name/link while preserving an intentional local unlink.');

    const viewer = await login(users.viewer);
    await openAnalyses(viewer); await openAnalysis(viewer, colleagueName);
    assert(await selected(viewer).getByLabel('Analysis name', { exact: true }).getAttribute('readonly') !== null, 'Viewer name editing is enabled.');
    assert(await selected(viewer).getByRole('button', { name: 'Save changes', exact: true }).count() === 0
      && await viewer.getByRole('button', { name: 'New analysis', exact: true }).count() === 0, 'Viewer mutation controls are visible.');
    const viewerRead = await browserApi(viewer, exactPath());
    assert(viewerRead.status === 200 && viewerRead.value.analysis.references.every(item => item.access === 'restricted'), 'Project readability incorrectly broadened private source access.');
    const visibleViewer = await selected(viewer).innerText();
    for (const privateValue of [material.ownerCsv.label, material.analystCsv.label, service.storageRoot, service.databaseUrl]) {
      assert(!JSON.stringify(viewerRead.value).includes(privateValue) && !visibleViewer.includes(privateValue), 'Restricted source metadata leaked into a shared container.');
    }
    assert((await browserApi(viewer, exactPath(), { method: 'PATCH', body: { expectedVersion: currentAnalysis.version, name: 'Viewer mutation' } })).status === 403, 'The viewer API allowed an edit.');
    assert((await browserApi(viewer, `/api/artifact-versions/${service.project.id}/${material.ownerCsv.reference.versionId}/preview`)).status === 404, 'A shared container granted private CSV-byte access.');
    await capture(viewer, 'viewer-read-only-restricted-sources');
    const outsider = await login(users.outsider);
    for (const url of [basePath(), exactPath(), basePath() + '/reference-options']) assert((await browserApi(outsider, url)).status === 404, 'A nonmember could discover project analysis data.');
    check('A viewer can read shared notes but cannot edit or read private sources; a nonmember receives 404 from list/detail/reference APIs.');

    const otherPath = `/api/projects/${secondProject.id}/analyses`;
    const secondary = await browserApi(page, otherPath, { method: 'POST', body: { requestId: crypto.randomUUID(), name: 'Independent study notes', description: 'A separate project with no linked source.' } });
    assert(secondary.status === 201, 'The second project fixture could not create its independent analysis.');
    const heldPicker = service.interceptNextResponse({ method: 'GET', pathname: basePath() + '/reference-options', mode: 'hold' });
    const oldPickerRequest = page.waitForRequest(value => new URL(value.url()).pathname === basePath() + '/reference-options' && value.method() === 'GET');
    await selected(page).getByRole('button', { name: 'Link saved material', exact: true }).click();
    const pickerRead = await oldPickerRequest;
    await waitFor(() => Boolean(heldPicker.observation()), 'The old project picker response was not held.');
    await openAnalyses(page, secondProject); await openAnalysis(page, 'Independent study notes');
    heldPicker.release(); await settleReply(page, pickerRead);
    assert((await selected(page).getByLabel('Analysis name', { exact: true }).inputValue()) === 'Independent study notes', 'An old project reply changed the new project selection.');
    assert(!(await selected(page).innerText()).includes(material.ownerCsv.label), 'An old project picker populated another project.');
    assert((await browserApi(page, `/api/projects/${secondProject.id}/analyses/${admittedId}`)).status === 404, 'The same analysis ID was readable through a different authorized project.');
    await capture(page, 'separate-project-late-picker-fence');
    check('Switching projects fences an actual held picker reply; exact analysis identity cannot be read through another authorized project.');

    const retained = (await database.query('SELECT version,name,description,references_json FROM research_analyses WHERE id=$1', [admittedId])).rows[0];
    const revisions = (await database.query('SELECT version,snapshot_json FROM research_analysis_revisions WHERE analysis_id=$1 ORDER BY version', [admittedId])).rows;
    assert(revisions.length === Number(retained.version) && revisions[0].snapshot_json.description === originalNotes, 'The original research question or an intermediate draft revision was lost.');
    assert(checksum(fs.readFileSync(material.ownerCsv.filename)) === material.ownerCsv.reference.sha256
      && checksum(fs.readFileSync(material.checkpoint.filename)) === material.checkpoint.reference.sha256, 'Container edits mutated scientific source bytes.');
    const dispatches = requests.filter(request => request.method === 'POST' && (/^\/api\/r\//.test(request.pathname)
      || /^\/api\/private-r-kernels\//.test(request.pathname) || /^\/api\/projects\/[^/]+\/jobs$/.test(request.pathname)));
    assert(dispatches.length === 0 && Number((await database.query('SELECT count(*) AS n FROM private_r_kernels')).rows[0].n) === 0, 'Organizing research analyses started scientific computation.');
    assert(errors.length === 0, 'The production application raised an uncaught browser error.');
    check('All draft revisions and original source checksums remain; analysis organization starts no scientific job or private kernel.');
    assert(usabilityFindings.length === 0, 'Natural analysis selection needs a usable list-to-detail transition; see the recorded screenshots and bounds.');
    const report = { passed: true, checks, screenshots, browserErrors: errors, compiledAssets,
      analysisId: admittedId, savedVersions: Number(retained.version), retainedRevisionCount: revisions.length,
      sourceVersions: [material.ownerCsv, material.analystCsv, material.checkpoint].map(value => ({ reference: value.reference, sizeBytes: value.sizeBytes })),
      usabilityFindings, uiMeasurements, scientificDispatchCount: dispatches.length, fixture: 'Own disposable production HTTPS/auth/PostgreSQL/storage; tiny synthetic RDS generated by cached reviewed image',
      exclusions: ['scientific execution through the application', 'SSH transport', 'remote executor separation', 'real researcher usability observation'] };
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(report, null, 2) + '\n');
    console.log('Research analyses UI acceptance passed; report: ' + directory);
    return report;
  } catch (failure) {
    await page?.screenshot({ path: path.join(directory, 'failure.png'), fullPage: true }).catch(() => {});
    if (page) {
      const snapshot = await page.locator('main').ariaSnapshot().catch(() => null);
      if (snapshot) fs.writeFileSync(path.join(directory, 'failure-accessibility.txt'), snapshot);
    }
    const secrets = [service?.databaseUrl, service?.storageRoot, service?.account?.password, ...Object.values(users).map(user => user.email)].filter(Boolean);
    let message = failure.message;
    for (const secret of secrets) message = message.split(secret).join('[private fixture]');
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ passed: false, checks, screenshots, usabilityFindings, uiMeasurements, error: message, browserErrors: errors, compiledAssets }, null, 2) + '\n');
    throw new Error(message);
  } finally { await browser?.close(); await database?.end(); await service?.stop(); }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main, seedSavedMaterial };
