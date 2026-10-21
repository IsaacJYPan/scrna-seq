#!/usr/bin/env node
'use strict';

// Real workflow execution/save/open/fork acceptance. No scientific success is simulated.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { chromium } = require('playwright');
const { Client } = require('pg');
const { createDesktopTunnelServiceFixture } = require('./desktop-tunnel-service-fixture.cjs');
const { seedSavedMaterial } = require('./verify-research-analyses-ui');
const execute = promisify(execFile), root = path.resolve(__dirname, '..');
const assert = (value, message) => { if (!value) throw new Error(message); };
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const identity = prefix => prefix + '_' + crypto.randomBytes(12).toString('hex');
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
async function until(check, message, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(message);
}
async function port() { const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve)); const value = socket.address().port; await new Promise(resolve => socket.close(resolve)); return value; }

async function main({ artifactDirectory } = {}) {
  const image = process.env.EXPERT_R_SANDBOX_IMAGE;
  assert(/^(?:[^\s@]+@)?sha256:[a-f0-9]{64}$/.test(image || ''), 'Use an existing reviewed immutable full R image. No image is pulled or built here.');
  const directory = path.resolve(artifactDirectory || path.join(root, 'playwright/report', 'retained-workflows-' + Date.now()));
  assert(directory.startsWith(path.join(root, 'playwright/report') + path.sep), 'Workflow evidence must remain in ignored report storage.');
  assert(fs.existsSync(path.join(root, 'dist/index.html')), 'The coordinated production build is required.');
  fs.mkdirSync(directory, { recursive: true });
  const assetsBefore = new Map(fs.readdirSync(path.join(root, 'dist/assets')).map(name => [name, sha(fs.readFileSync(path.join(root, 'dist/assets', name)))]));
  const rPort = await port(), brokerPort = await port(), brokerToken = crypto.randomBytes(32).toString('hex');
  const container = 'traceomics-retained-workflow-' + process.pid + '-' + crypto.randomBytes(5).toString('hex');
  const previousStorage = process.env.STORAGE_ROOT;
  const checks = [], captures = [], profiles = [], requests = [], errors = [], assets = {}, workers = [], users = {};
  let service, database, broker, browser, page, loginPage, workerEnvironment, rStarted = false, material, snapshot, instance, otherObject;
  const check = message => { checks.push(message); console.log('PASS: ' + message); };
  const projectPath = () => `/api/projects/${service.project.id}/analyses`;
  const workflowPath = () => `/api/workflows/${service.project.id}`;
  const snapshotPath = value => `${projectPath()}/workflow-snapshots/${value.id}`;
  const existing = target => target.getByRole('region', { name: 'Existing saved work', exact: true });
  const retained = target => target.getByRole('region', { name: 'Retained workflow snapshot', exact: true });
  const row = name => new RegExp('^' + escape(name) + '(?:$|\\s)');
  async function api(target, url, { method = 'GET', body } = {}) {
    return target.evaluate(async ({ url, method, body }) => {
      const response = await fetch(url, { method, credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-Traceomics-Csrf': '1' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, value: await response.json() };
    }, { url, method, body });
  }
  async function login(account) {
    const context = await browser.newContext({ viewport: { width: 1366, height: 768 } }); const target = await context.newPage(); loginPage = target;
    target.on('pageerror', error => errors.push(error.message));
    target.on('request', request => {
      const pathname = new URL(request.url()).pathname; if (!pathname.startsWith('/api/')) return;
      const record = { method: request.method(), pathname };
      if (record.method === 'POST' && /\/workflow-snapshots\/[^/]+\/open$/.test(pathname)) {
        try { const body = request.postDataJSON(); record.requestId = body.requestId; record.payloadSha256 = sha(JSON.stringify(body)); } catch { /* Invalid bodies fail elsewhere. */ }
      }
      requests.push(record);
    });
    target.on('response', async response => {
      const pathname = new URL(response.url()).pathname; if (!/^\/assets\/.*\.js$/.test(pathname) || !response.ok()) return;
      try { const value = sha(await response.body()); assets[pathname] = value; if (assetsBefore.get(pathname.split('/').at(-1)) !== value) errors.push('Compiled assets changed during workflow acceptance.'); } catch { /* Page loading also must succeed. */ }
    });
    await target.goto(service.endpoint); await target.getByPlaceholder('researcher@lab.edu').fill(account.email);
    await target.getByLabel('Password', { exact: true }).fill(service.account.password); await target.getByRole('button', { name: /Open Workbench/ }).click();
    await target.getByText('Connection details', { exact: true }).waitFor(); return target;
  }
  async function nav(target, name) {
    const expand = target.getByRole('button', { name: 'Expand sidebar', exact: true }); if (await expand.isVisible()) await expand.click();
    await target.getByRole('button', { name: typeof name === 'string' ? new RegExp('^' + escape(name) + '(?:$|,)') : name }).click();
  }
  async function selectObject(target, label = 'Small saved Seurat object') {
    await nav(target, /^Data workspace,/); await target.getByRole('button', { name: row(service.project.name) }).click();
    const object = target.getByRole('group', { name: `Saved analysis ${label}. Press Enter or Space to select.`, exact: true });
    await object.focus(); await target.keyboard.press('Enter');
  }
  async function capture(target, name, expectedTheme) {
    const theme = await target.evaluate(() => document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
    if (expectedTheme) assert(theme === expectedTheme, 'The actual workflow capture theme is incorrect.');
    const filename = name + '.png'; await target.screenshot({ path: path.join(directory, filename), fullPage: true }); captures.push(filename); profiles.push({ filename, theme, viewport: target.viewportSize() });
  }
  async function theme(target, value) {
    if (await target.evaluate(() => document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light') !== value) {
      const control = target.getByRole('button', { name: `Switch to ${value} mode`, exact: true }); let opened = false;
      if (!(await control.isVisible())) { await target.getByRole('button', { name: 'Expand sidebar', exact: true }).click(); opened = true; }
      await control.click(); if (opened) await target.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
    }
    await target.waitForTimeout(350); // Settle existing palette/navigation CSS; no latency claim.
  }
  async function oneWorker(jobId) {
    let result;
    try {
      result = await execute(process.execPath, ['--require', './scripts/enable-job-worker.cjs', 'worker.js', '--once'], {
        cwd: root, windowsHide: true, timeout: 180000, maxBuffer: 65536,
        env: { ...workerEnvironment, ENABLE_JOB_WORKER: 'true', JOB_WORKER_HEALTH_PORT: '0', JOB_WORKER_MIN_FREE_MEMORY_MB: '1', JOB_WORKER_STARTUP_TIMEOUT_MS: '30000' },
      });
    } catch (failure) { throw new Error('The actual one-shot worker failed (' + String(failure.code || 'worker').replace(/[^A-Za-z0-9_-]/g, '') + '). No scientific success is substituted.'); }
    const job = (await database.query('SELECT id,job_type,status,result_analysis_object_id,error_json FROM jobs WHERE id=$1', [jobId])).rows[0];
    workers.push({ jobId, status: job?.status, jobType: job?.job_type, workerReportedCompleted: /one-shot result: completed/.test(result.stdout) });
    assert(job?.status === 'completed', 'The real worker did not complete the scientific job: ' + (job?.status || 'missing'));
    return job;
  }
  async function openLibrary(target, filename) {
    await nav(target, 'Pipelines'); const library = target.getByRole('region', { name: 'Workflow pipelines', exact: true });
    await library.getByLabel('Workflow package file', { exact: true }).setInputFiles(filename);
    await library.getByRole('button', { name: 'Install Retained round-trip method', exact: true }).click();
    const waiting = target.waitForResponse(response => new URL(response.url()).pathname === workflowPath() + '/open' && response.request().method() === 'POST' && response.ok());
    await library.getByRole('button', { name: 'Open Retained round-trip method', exact: true }).click(); const opened = await (await waiting).json();
    await target.getByRole('heading', { name: 'Retained round-trip method', exact: true }).waitFor(); return opened;
  }
  async function runMetric(target, opened, offset) {
    const step = target.getByRole('region', { name: 'Measure saved cells', exact: true });
    await step.getByLabel('Count offset', { exact: true }).fill(String(offset));
    const waiting = target.waitForResponse(response => new URL(response.url()).pathname === `${workflowPath()}/instances/${opened.id}/run` && response.request().method() === 'POST' && response.ok());
    await step.getByRole('button', { name: 'Run Measure saved cells', exact: true }).click(); const submitted = await (await waiting).json();
    assert(submitted.state.active?.id, 'The UI did not admit an actual queued workflow step.'); await oneWorker(submitted.state.active.id);
    await until(async () => {
      const current = await api(target, `${workflowPath()}/instances/${opened.id}`);
      return current.status === 200 && !current.value.state.active && current.value.state.results.measure?.parameters.offset === offset;
    }, 'The actual workflow output was not retained after its worker completed.');
    const current = (await api(target, `${workflowPath()}/instances/${opened.id}`)).value;
    await step.getByRole('region', { name: 'Retained result', exact: true }).getByText(String(12 + offset), { exact: true }).waitFor();
    return current;
  }
  async function browse(target, name = snapshot.name) {
    await nav(target, 'Analyses');
    if (!(await existing(target).isVisible())) await target.getByRole('button', { name: 'Bring saved work', exact: true }).click();
    const back = existing(target).getByRole('button', { name: 'All saved work', exact: true });
    const category = existing(target).getByRole('combobox', { name: 'Saved work category', exact: true });
    await until(async () => await category.isVisible() || await back.isVisible(), 'The saved-work list or detail navigation did not become visible.');
    if (!(await category.isVisible())) {
      try { await back.click({ timeout: 1500 }); }
      catch (failure) { if (!(await category.isVisible())) throw failure; }
    }
    await category.waitFor({ state: 'visible' });
    await category.selectOption('workflows');
    await existing(target).getByRole('list', { name: 'Saved work list', exact: true }).getByRole('button', { name: row(name) }).click();
    const inspect = existing(target).getByRole('button', { name: 'Inspect saved version', exact: true }); if (await inspect.isVisible()) await inspect.click();
    await retained(target).getByText('Captured source checksum verified', { exact: true }).waitFor(); return retained(target);
  }
  async function reveal(target) {
    const view = retained(target);
    for (const label of ['Saved workflow identity', 'Captured method source', 'Saved settings and results']) {
      const summary = view.getByText(label, { exact: true }); if (!(await summary.evaluate(element => element.parentElement.open))) await summary.click();
    }
    const source = view.getByText('measure.R', { exact: true }); if (!(await source.evaluate(element => element.parentElement.open))) await source.click();
  }
  async function reopen(target) {
    const view = retained(target), replace = view.getByRole('checkbox', { name: 'Replace this identified working workflow', exact: true });
    if (await replace.isVisible()) await replace.check();
    const waiting = target.waitForResponse(response => new URL(response.url()).pathname === snapshotPath(snapshot) + '/open' && response.request().method() === 'POST' && response.ok());
    await view.getByRole('button', { name: 'Open saved workflow', exact: true }).click(); return (await (await waiting).json());
  }
  try {
    service = await createDesktopTunnelServiceFixture({ artifactDirectory: directory,
      webEnvironment: { AUTH_RATE_LIMIT_MAX: '100', EXPERT_R_ENABLED: 'true', EXPERT_R_ACCESS_POLICY: 'project-roles', EXPERT_R_SANDBOX_URL: `http://127.0.0.1:${brokerPort}`, EXPERT_R_SANDBOX_TOKEN: brokerToken },
      configureEnvironment: async ({ env }) => {
        fs.mkdirSync(env.STORAGE_ROOT, { recursive: true }); fs.mkdirSync(env.VAULT_ROOT, { recursive: true });
        await execute('docker', ['run', '-d', '--rm', '--pull', 'never', '--name', container, '--label', 'traceomics.review=retained-workflows',
          '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--read-only', '--user', '10001:10001', '--pids-limit', '256', '--memory', '2g', '--cpus', '1',
          '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m', '-p', `127.0.0.1:${rPort}:8000`, '-e', 'PLUMBER_HOST=0.0.0.0', '-e', 'API_TOKEN=' + env.R_API_TOKEN,
          '-e', 'STORAGE_ROOT=/service/storage', '-e', 'VAULT_ROOT=/service/vault', '--mount', `type=bind,source=${env.STORAGE_ROOT},target=/service/storage`,
          '--mount', `type=bind,source=${env.VAULT_ROOT},target=/service/vault`, '--mount', `type=bind,source=${path.join(root, 'r-backend')},target=/app,readonly`,
          '--entrypoint', 'Rscript', image, '/app/run.R'], { cwd: root, windowsHide: true, timeout: 30000 }); rStarted = true;
        await until(async () => { try { return (await fetch(`http://127.0.0.1:${rPort}/health`, { headers: { 'X-API-Token': env.R_API_TOKEN } })).ok; } catch { return false; } }, 'The genuine Plumber service did not become ready.', 90000);
        return { R_BACKEND_URL: `http://127.0.0.1:${rPort}` };
      },
      configureProjectEnvironment: async ({ env, account, project }) => {
        workerEnvironment = { ...env }; const seed = new Client({ connectionString: env.DATABASE_URL }); await seed.connect();
        try {
          const owner = (await seed.query('SELECT * FROM users WHERE email=$1', [account.email])).rows[0]; users.owner = { id: Number(owner.id), email: account.email };
          const organization = (await seed.query('SELECT organization_id FROM projects WHERE id=$1', [project.id])).rows[0].organization_id;
          for (const role of ['analyst', 'viewer', 'outsider']) {
            const email = role + '-' + crypto.randomBytes(7).toString('hex') + '@example.invalid';
            const user = (await seed.query('INSERT INTO users(email,password_hash,salt,display_name) VALUES($1,$2,$3,$4) RETURNING id', [email, owner.password_hash, owner.salt, 'Workflow acceptance ' + role])).rows[0]; users[role] = { id: Number(user.id), email };
            if (role !== 'outsider') { await seed.query("INSERT INTO organization_members(organization_id,user_id,role) VALUES($1,$2,'member')", [organization, user.id]); await seed.query('INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,$3)', [project.id, user.id, role]); }
          }
        } finally { await seed.end(); } return {};
      } });
    database = new Client({ connectionString: service.databaseUrl }); await database.connect();
    material = await seedSavedMaterial(database, service, users.owner, users.analyst, image);
    otherObject = { id: identity('ao'), label: 'Separate ordinary object' };
    await database.query("INSERT INTO analysis_objects(id,owner_user_id,project_id,object_type,display_name,metadata_json) VALUES($1,$2,$3,'seurat',$4,'{}')", [otherObject.id, users.owner.id, service.project.id, otherObject.label]);
    process.env.STORAGE_ROOT = service.storageRoot;
    broker = require('../backend/expertSandboxBroker').createExpertSandboxBroker({ ...process.env, NODE_ENV: 'test', EXPERT_R_SANDBOX_IMAGE: image,
      EXPERT_R_SANDBOX_TOKEN: brokerToken, EXPERT_R_SANDBOX_WORK_ROOT: path.join(directory, 'broker-work'), EXPERT_R_MEMORY_LIMIT: '2g', EXPERT_R_CPU_LIMIT: '1' });
    await broker.startReconciliation(); await new Promise(resolve => broker.listen(brokerPort, '127.0.0.1', resolve));
    const capability = await fetch(`http://127.0.0.1:${brokerPort}/capabilities`, { headers: { Authorization: 'Bearer ' + brokerToken } }).then(response => response.json());
    assert(capability.status === 'ok' && capability.environment, 'The actual pinned R sandbox capability/environment probe failed.');
    const { EXPERT_R_PROFILE } = require('../backend/expertR');
    const workflow = { format: 'traceomics-workflow', schemaVersion: 1, id: 'retained-round-trip', name: 'Retained round-trip method', version: '1.0.0', description: 'Tiny real saved-source acceptance; count a12-cell fixture explicitly.',
      runtime: { language: 'r', profileId: EXPERT_R_PROFILE.id }, files: { 'measure.R': 'write_output("summary", list(cells=ncol(inputs$analysis)+params$offset, features=nrow(inputs$analysis)))\n' },
      steps: [{ id: 'measure', label: 'Measure saved cells', entry: 'measure.R', inputs: { analysis: { from: 'input.analysis', type: 'rds' } },
        parameters: [{ key: 'offset', type: 'integer', label: 'Count offset', default: 0, min: 0, max: 20 }], outputs: { summary: { type: 'metrics', label: 'Actual cell summary' } } }],
      tabs: [{ id: 'measure', label: 'Measured result', step: 'measure', plots: [] }] };
    const workflowFile = path.join(directory, 'round-trip.pipeline.json'); fs.writeFileSync(workflowFile, JSON.stringify(workflow));
    const { parseLegacyExecutableWorkflowPackage } = await import('../shared/recipePackage.mjs'); parseLegacyExecutableWorkflowPackage(workflow, { environmentProfiles: [EXPERT_R_PROFILE.id] });
    const leaf = new crypto.X509Certificate(fs.readFileSync(service.certificatePath)), authority = new crypto.X509Certificate(fs.readFileSync(service.caCertificatePath));
    assert(leaf.verify(authority.publicKey) && leaf.checkHost(new URL(service.endpoint).hostname), 'The disposable HTTPS certificate did not verify.');
    browser = await chromium.launch({ headless: true, args: ['--host-resolver-rules=MAP ' + new URL(service.endpoint).hostname + ' 127.0.0.1', '--ignore-certificate-errors-spki-list=' + crypto.createHash('sha256').update(leaf.publicKey.export({ type: 'spki', format: 'der' })).digest('base64')] });
    page = await login(users.owner); await selectObject(page); instance = await openLibrary(page, workflowFile); instance = await runMetric(page, instance, 0);
    const output = instance.state.results.measure.outputs.summary;
    assert(output.sha256 && output.id && output.type === 'metrics', 'A genuine metric artifact was not captured.');
    await page.getByLabel('Snapshot name', { exact: true }).fill('Saved actual cell-count workflow');
    const save = page.waitForResponse(response => new URL(response.url()).pathname === `${workflowPath()}/instances/${instance.id}/save` && response.request().method() === 'POST' && response.ok());
    await page.getByRole('button', { name: 'Save workflow', exact: true }).click(); const saved = await (await save).json();
    snapshot = (await api(page, snapshotPath(saved))).value.snapshot;
    assert(snapshot.support.supported && snapshot.state.results.measure.outputs.summary.id === output.id, 'A saved actual workflow did not retain exact outputs/support.');
    const unsupportedId = identity('wfs'), unavailableId = identity('wfs');
    const unsupportedPackage = { ...snapshot.package, schemaVersion: 99 };
    const unavailableState = structuredClone(snapshot.state); unavailableState.root.id = identity('art');
    for (const result of Object.values(unavailableState.results)) {
      for (const input of Object.values(result.inputs)) if (input.id === snapshot.state.root.id) input.id = unavailableState.root.id;
    }
    for (const [snapshotId, name, capturedPackage, state] of [[unsupportedId, 'Unsupported captured method fixture', unsupportedPackage, snapshot.state],
      [unavailableId, 'Missing exact input fixture', snapshot.package, unavailableState]]) {
      await database.query('INSERT INTO workflow_snapshots(id,owner_user_id,project_id,analysis_object_id,name,package_digest,package_json,state_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [snapshotId, users.owner.id, service.project.id, snapshot.analysisObjectId, name, snapshot.packageDigest, capturedPackage, state]);
    }
    await capture(page, 'actual-workflow-run-and-save');
    check('Actual UI workflow import/open/run passes through the genuine isolated R broker and standalone worker; saved snapshot captures exact produced metrics and source.');

    const beforeReview = workers.length;
    await page.getByText('Recent saved workflows for this analysis', { exact: true }).click();
    const savedRow = page.getByRole('listitem').filter({ has: page.getByText(snapshot.name, { exact: true }) }); await savedRow.getByRole('button', { name: 'Open', exact: true }).click();
    await retained(page).getByText('Captured source checksum verified', { exact: true }).waitFor(); await reveal(page);
    await retained(page).getByRole('button', { name: 'Inspect saved summary', exact: true }).click(); await retained(page).getByRole('region', { name: 'Retained result', exact: true }).getByText('12', { exact: true }).waitFor();
    assert(workers.length === beforeReview, 'Reviewing a legacy saved workflow executed another step.');
    await capture(page, 'legacy-open-reviews-exact-source');
    await retained(page).getByRole('checkbox', { name: 'Replace this identified working workflow', exact: true }).check();
    await retained(page).getByRole('button', { name: 'Open saved workflow', exact: true }).click();
    await until(async () => (await api(page, snapshotPath(snapshot))).value.snapshot.workingInstance.generation > instance.state.generation, 'The guarded legacy saved-workflow Open did not restore a new generation.');
    await selectObject(page, otherObject.label); await browse(page); await reveal(page);
    const beforeOpenJobs = Number((await database.query('SELECT count(*) AS n FROM jobs')).rows[0].n);
    const opened = await reopen(page);
    await page.getByRole('heading', { name: 'Retained round-trip method', exact: true }).waitFor();
    await page.getByRole('region', { name: 'Measure saved cells', exact: true }).getByText('12', { exact: true }).waitFor();
    await page.waitForTimeout(250);
    assert(await page.getByRole('heading', { name: 'Retained round-trip method', exact: true }).isVisible()
      && opened.currentInstance.analysisObjectId === material.checkpoint.reference.analysisObjectId, 'Object-context change redirected the captured workflow or selected the wrong source.');
    assert(Number((await database.query('SELECT count(*) AS n FROM jobs')).rows[0].n) === beforeOpenJobs, 'Reopening a captured workflow silently reran a scientific step.');
    await capture(page, 'snapshot-open-after-other-object-selection');
    check('Legacy saved-workflow Open first reviews retained source; guarded reopening switches from a different ordinary object into the exact captured workflow without rerunning or redirecting away.');

    await browse(page); const adopt = existing(page).getByRole('form', { name: 'Start from saved work', exact: true });
    await adopt.getByLabel('Adopted analysis name', { exact: true }).fill('Research question with captured workflow');
    const adoption = page.waitForResponse(response => new URL(response.url()).pathname === projectPath() && response.request().method() === 'POST' && response.status() === 201);
    await adopt.getByRole('button', { name: 'Start analysis with this saved version', exact: true }).click(); const analysis = (await (await adoption).json()).analysis;
    assert(analysis.references[0].reference.kind === 'workflow-snapshot' && analysis.references[0].reference.snapshotId === snapshot.id && analysis.references[0].reference.sha256 === snapshot.sha256, 'Adoption lost the exact snapshot identity/checksum.');
    await page.getByRole('region', { name: 'Selected analysis', exact: true }).getByRole('button', { name: 'Open documents', exact: true }).click();
    const outline = page.getByRole('navigation', { name: 'Documents and sections', exact: true });
    const outlineToggle = page.locator('summary:visible').filter({ hasText: 'Documents and sections' });
    await until(async () => await outline.isVisible() || await outlineToggle.isVisible(), 'The document outline did not become available.');
    if (!(await outline.isVisible())) {
      try { await outlineToggle.click({ timeout: 1500 }); }
      catch (failure) { if (!(await outline.isVisible())) throw failure; }
    }
    await outline.getByRole('button', { name: 'Linked material (1)', exact: true }).click();
    await page.getByRole('button', { name: 'Inspect saved version', exact: true }).click();
    await retained(page).getByText('Captured source checksum verified', { exact: true }).waitFor(); await capture(page, 'analysis-linked-common-snapshot-inspector');
    await page.getByRole('button', { name: 'Analysis overview', exact: true }).click(); await browse(page);
    await reveal(page);
    for (const viewport of [{ width: 1366, height: 768 }, { width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      for (const value of ['light', 'dark']) {
        await theme(page, value); await retained(page).getByText('Captured source checksum verified', { exact: true }).scrollIntoViewIfNeeded();
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Captured workflow source causes page overflow.');
        await capture(page, `snapshot-${value}-${viewport.width}`, value);
        await retained(page).getByText(snapshot.package.files['measure.R'], { exact: true }).scrollIntoViewIfNeeded();
        await capture(page, `snapshot-source-${value}-${viewport.width}`, value);
      }
    }
    check('Exact snapshot adoption opens the common linked-material inspector; real light/dark laptop/mobile source views remain contained without computation.');

    await page.setViewportSize({ width: 1366, height: 768 }); await theme(page, 'light');
    const beforeUnsupported = Number((await database.query('SELECT count(*) AS n FROM jobs')).rows[0].n);
    for (const [name, code, label] of [['Unsupported captured method fixture', 'WORKFLOW_SOURCE_UNSUPPORTED', 'unsupported-captured-source'],
      ['Missing exact input fixture', 'WORKFLOW_ROOT_UNAVAILABLE', 'unavailable-exact-input']]) {
      await browse(page, name); await reveal(page);
      assert(!(await retained(page).getByRole('button', { name: 'Open saved workflow', exact: true }).count()), 'Unsupported or unavailable source exposed a replacement action.');
      const item = (await api(page, projectPath() + '/existing-work?kind=workflows')).value.items.find(item => item.label === name);
      const inspected = await api(page, `${projectPath()}/workflow-snapshots/${item.id}`);
      assert(inspected.value.snapshot.support.code === code && !inspected.value.snapshot.support.supported, 'The source limitation was not reported honestly.');
      await capture(page, label);
    }
    assert(Number((await database.query('SELECT count(*) AS n FROM jobs')).rows[0].n) === beforeUnsupported, 'Source limitation inspection recreated scientific output.');
    check('Explicit unsupported-package and unavailable-root fixture records remain inspectable and inert; neither can silently substitute source or run missing results.');
    await browse(page); await retained(page).getByRole('button', { name: 'Refresh workflow details', exact: true }).click();
    await retained(page).getByText('Captured source checksum verified', { exact: true }).waitFor();
    const replace = retained(page).getByRole('checkbox', { name: 'Replace this identified working workflow', exact: true }); await replace.check();
    const unknownPath = snapshotPath(snapshot) + '/open', start = requests.length;
    const fault = service.interceptNextResponse({ method: 'POST', pathname: unknownPath, mode: 'drop' });
    await retained(page).getByRole('button', { name: 'Open saved workflow', exact: true }).click();
    await until(() => !!fault.observation()?.value?.restoration, 'The actually admitted restoration reply was not dropped.'); const admitted = fault.observation().value.restoration;
    await retained(page).getByRole('button', { name: 'Check original open request', exact: true }).waitFor();
    const otherWindow = await login(users.owner); await selectObject(otherWindow); let newer = await openLibrary(otherWindow, workflowFile); newer = await runMetric(otherWindow, newer, 7);
    assert(newer.state.generation > admitted.generation, 'The second real run did not advance the restored working state.');
    await database.query("UPDATE project_members SET role='viewer' WHERE project_id=$1 AND user_id=$2", [service.project.id, users.owner.id]);
    const replay = page.waitForResponse(response => new URL(response.url()).pathname === unknownPath && response.request().method() === 'POST' && response.ok());
    await retained(page).getByRole('button', { name: 'Check original open request', exact: true }).click(); const replayed = await (await replay).json();
    const attempts = requests.slice(start).filter(value => value.method === 'POST' && value.pathname === unknownPath);
    assert(replayed.replayed && replayed.restoration.generation === admitted.generation && replayed.currentInstance.state.generation === newer.state.generation
      && replayed.currentInstance.state.results.measure.outputs.summary.id === newer.state.results.measure.outputs.summary.id
      && attempts.length === 2 && attempts[0].requestId === attempts[1].requestId && attempts[0].payloadSha256 === attempts[1].payloadSha256, 'Unknown restoration replay reapplied old state or changed UUID/body.');
    assert(replayed.canEditWorking === false, 'Downgraded receipt recovery incorrectly advertised working-copy edit access.');
    await retained(page).getByText('The original open is confirmed. Your current project role allows inspection only; the working workflow was kept.', { exact: true }).waitFor();
    await retained(page).getByText('Newer working state kept', { exact: true }).click();
    await retained(page).getByRole('button', { name: 'Inspect current saved summary', exact: true }).click();
    await retained(page).getByText('19', { exact: true }).waitFor();
    assert(!(await retained(page).getByRole('button', { name: 'Open saved workflow', exact: true }).count()), 'The recovered reader was offered an editable working view.');
    await capture(page, 'unknown-open-keeps-newer-real-result-after-downgrade');
    const freshReader = await login(users.owner); await selectObject(freshReader); await browse(freshReader);
    assert(!(await retained(freshReader).getByRole('button', { name: 'Open saved workflow', exact: true }).count()), 'A current reader was offered fresh restoration.');
    const denied = await api(freshReader, unknownPath, { method: 'POST', body: { requestId: crypto.randomUUID(), sha256: snapshot.sha256, expectedInstance: { id: newer.id, generation: newer.state.generation }, replace: true } });
    assert(denied.status === 403, 'Accepted receipt replay granted new reader restoration rights.');
    for (const role of ['viewer', 'outsider']) {
      const account = await login(users[role]);
      assert((await api(account, snapshotPath(snapshot))).status === 404, 'Another account discovered the private saved workflow source.');
      if (role === 'viewer') { const list = await api(account, projectPath() + '/existing-work?kind=workflows'); assert(list.status === 200 && list.value.items.length === 0, 'Colleague workflow discovery leaked private snapshot metadata.'); }
    }
    check('A genuine lost restoration reply resolves the original UUID/body after a newer actual run and owner downgrade, keeping the newer result while denying fresh reader opens and colleague/private-source discovery.');

    await database.query("UPDATE project_members SET role='owner' WHERE project_id=$1 AND user_id=$2", [service.project.id, users.owner.id]);
    const branchPage = await login(users.owner); await selectObject(branchPage); await nav(branchPage, 'Runs & Results');
    await branchPage.getByRole('heading', { name: 'Runs & Results', exact: true }).waitFor();
    const branchReply = branchPage.waitForResponse(response => response.request().method() === 'POST' && /\/jobs$/.test(new URL(response.url()).pathname) && response.ok());
    await branchPage.getByRole('button', { name: 'Create branch from this version', exact: true }).first().click(); const branchAdmission = await (await branchReply).json();
    const branchJob = branchAdmission.job || branchAdmission;
    const completedBranch = await oneWorker(branchJob.id);
    assert(completedBranch.result_analysis_object_id && completedBranch.result_analysis_object_id !== material.checkpoint.reference.analysisObjectId, 'Actual fork did not create a distinct object.');
    await branchPage.getByRole('button', { name: 'Open branch', exact: true }).waitFor({ timeout: 30000 }); await capture(branchPage, 'actual-checkpoint-branch-completed');
    const unchanged = (await api(branchPage, snapshotPath(snapshot))).value.snapshot;
    assert(unchanged.sha256 === snapshot.sha256 && JSON.stringify(unchanged.state) === JSON.stringify(snapshot.state)
      && sha(fs.readFileSync(material.checkpoint.filename)) === material.checkpoint.reference.sha256, 'Execution/open/fork mutated immutable captured source or original checkpoint.');
    assert(workers.length === 3 && workers.every(value => value.status === 'completed') && errors.length === 0
      && Number((await database.query('SELECT count(*) AS n FROM jobs')).rows[0].n) === 4, 'The workflow acceptance has a missing/extra execution or browser failure.');
    check('A real ProjectHistory branch job runs through genuine Plumber and worker, creates a distinct object and preserves original snapshot/checkpoint bytes.');
    const report = { passed: true, checks, screenshots: captures, profiles, compiledAssets: assets, browserErrors: errors, workers,
      snapshot: { id: snapshot.id, sha256: snapshot.sha256, outputId: output.id, outputSha256: output.sha256 },
      fixture: 'Owned production HTTPS/auth/PostgreSQL/storage, cached immutable real Plumber and isolated sandbox broker, real one-shot worker; tiny synthetic input checkpoint and two unsupported/unavailable records explicitly seeded',
      exclusions: ['SSH transport', 'large-data performance', 'representative researcher usability observation'] };
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(report, null, 2) + '\n'); console.log('Retained workflow acceptance passed; report: ' + directory); return report;
  } catch (failure) {
    const diagnostic = page || loginPage;
    await diagnostic?.screenshot({ path: path.join(directory, 'failure.png'), fullPage: true }).catch(() => {});
    const snapshot = await diagnostic?.locator('body').ariaSnapshot().catch(() => null); if (snapshot) fs.writeFileSync(path.join(directory, 'failure-accessibility.txt'), snapshot);
    let message = failure.message;
    for (const secret of [service?.databaseUrl, service?.storageRoot, service?.account?.password, ...Object.values(users).map(user => user.email), brokerToken].filter(Boolean)) message = message.split(secret).join('[private fixture]');
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ passed: false, checks, screenshots: captures, profiles, workers, error: message, browserErrors: errors, compiledAssets: assets }, null, 2) + '\n'); throw new Error(message);
  } finally {
    await browser?.close(); if (broker?.listening) await new Promise(resolve => broker.close(resolve)); await database?.end();
    if (rStarted) await execute('docker', ['rm', '-f', container], { windowsHide: true, timeout: 30000 }).catch(() => {});
    await service?.stop(); if (previousStorage === undefined) delete process.env.STORAGE_ROOT; else process.env.STORAGE_ROOT = previousStorage;
  }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
