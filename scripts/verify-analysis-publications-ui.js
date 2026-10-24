#!/usr/bin/env node
'use strict';

// Real pinned R producer, production HTTPS/auth/PG, and two real app accounts.
// Synthetic counts prove transport/retention, not scientific generality.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Client } = require('pg');
const { chromium } = require('playwright');
const { createAnalysisSharingRuntimeFixture, produceSharingFindings } = require('./analysis-sharing-runtime-fixture.cjs');
const { createTypedSharingProducer } = require('./analysis-typed-sharing-fixture.cjs');
const root = path.resolve(__dirname, '..');
const assert = (value, message) => { if (!value) throw new Error(message); };
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
async function until(test, message, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await test()) return; await new Promise(resolve => setTimeout(resolve, 75)); }
  throw new Error(message);
}
async function main({ linkedResults = false, typedResults = false, capturedResults = false, embeddingResults = false, inertResults = false, sharedLinks = false } = {}) {
  embeddingResults ||= inertResults;
  capturedResults ||= embeddingResults;
  typedResults ||= capturedResults;
  linkedResults ||= typedResults;
  const directory = path.join(root, 'playwright', 'report', (sharedLinks ? 'analysis-shared-links-' : inertResults ? 'analysis-inert-publications-' : embeddingResults ? 'analysis-embedding-publications-' : capturedResults ? 'analysis-workflow-publications-' : typedResults ? 'analysis-typed-publications-' : linkedResults ? 'analysis-linked-publications-' : 'analysis-publications-') + Date.now()); fs.mkdirSync(directory, { recursive: true });
  const frozen = new Map(fs.readdirSync(path.join(root, 'dist/assets')).map(name => [name, sha(fs.readFileSync(path.join(root, 'dist/assets', name)))]));
  const checks = [], screenshots = [], profiles = [], requests = [], browserErrors = [], consoleErrors = [], assetReads = [], faults = [], restarts = [];
  const httpFailures = [], failureReads = [], scopedReadDenials = [], pageIds = new WeakMap(); let nextPageId = 0;
  const compiledAssets = {}, accounts = {}, expected = new Set(), faultPaths = new Set();
  const intentionalRuntimeResponses = [];
  const expectRuntime = (status, pathname, reason) => {
    intentionalRuntimeResponses.push({ status, pathname, reason, from: Date.now() });
  };
  const check = message => { checks.push(message); console.log('PASS: ' + message); };
  let service, database, browser, page, study, findings, linkedInfo, typedFindings, visibleTarget, sharedLinkEvidence;
  const typedProducer = typedResults ? createTypedSharingProducer(process.env.EXPERT_R_SANDBOX_IMAGE) : null;
  const findingCaption = name => `Exact ${capturedResults ? 'captured' : 'typed'} workflow ${name}`;
  const intercept = input => service.interceptNextResponse({ ...input, ...(capturedResults ? { maximumBytes: 512 * 1024 } : {}) });
  let producersStopped = false;
  async function stopProducers() {
    if (producersStopped) return;
    await findings.stop(); await service.stopCompute();
    if (typedProducer) for (const pathname of ['/api/r/session-id', '/api/r/pipeline-state', '/api/r/health']) {
      expectRuntime(502, pathname, 'The actual R orchestration service is deliberately stopped before retained reads.');
    }
    await typedProducer?.stop(); producersStopped = true;
  }
  let selectedAnalysisVersion = 1, latestAnalysisVersion = 1;
  const analysisPath = () => `/api/projects/${service.project.id}/analyses/${study.id}`;
  const prepPath = () => analysisPath() + '/snapshot-preparations', publicationPath = () => analysisPath() + '/snapshot-publications';
  const prep = target => target.getByRole('region', { name: 'Private snapshot preparations', exact: true });
  const panel = target => target.getByRole('region', { name: 'Published analysis snapshots', exact: true });
  const detail = target => panel(target).getByRole('region', { name: 'Published snapshot review', exact: true });
  const writes = () => requests.filter(item => item.actor === 'owner' && item.method === 'POST' && item.pathname === publicationPath());
  async function api(target, pathname, { method = 'GET', body, status = 200 } = {}) {
    if (status >= 400) expected.add(`${status} ${pathname}`);
    const response = await target.evaluate(async ({ pathname, method, body }) => {
      const result = await fetch(pathname, { method, credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-Traceomics-Csrf': '1' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: result.status, value: await result.json() };
    }, { pathname, method, body });
    assert(response.status === status, 'A genuine sharing API returned unexpected status ' + response.status + ' for ' + pathname); return response.value;
  }
  async function importFixture(target, name, filename, text) {
    const response = await target.evaluate(async ({ projectId, name, filename, text, requestId }) => {
      const body = new FormData(); body.append('file', new File([text], filename)); body.append('name', name); body.append('requestId', requestId);
      const result = await fetch(`/api/artifact-versions/${projectId}`, { method: 'POST', credentials: 'include', headers: { 'X-Traceomics-Csrf': '1' }, body });
      return { status: result.status, value: await result.json() };
    }, { projectId: service.project.id, name, filename, text, requestId: crypto.randomUUID() });
    assert(response.status === 201, 'A genuine linked prerequisite import did not succeed.'); return response.value;
  }
  async function launch() {
    const leaf = new crypto.X509Certificate(fs.readFileSync(service.certificatePath));
    return chromium.launch({ headless: true, args: ['--host-resolver-rules=MAP ' + new URL(service.endpoint).hostname + ' 127.0.0.1',
      '--ignore-certificate-errors-spki-list=' + crypto.createHash('sha256').update(leaf.publicKey.export({ type: 'spki', format: 'der' })).digest('base64')] });
  }
  function registerPage(target, actor = 'owner') {
    const pageId = ++nextPageId; pageIds.set(target, pageId);
    visibleTarget = target;
    target.on('pageerror', error => browserErrors.push(error.message));
    target.on('console', value => { if (value.type() === 'error') consoleErrors.push({ text: value.text(), url: value.location().url, at: Date.now(), actor, pageId }); });
    target.on('request', request => {
      const address = new URL(request.url()), pathname = address.pathname; if (!pathname.startsWith('/api/')) return;
      requests.push({ actor, method: request.method(), pathname, ...(pathname.endsWith('/snapshot-preparations/options')
        ? { optionKind: address.searchParams.get('kind'), optionAnalysisVersion: address.searchParams.get('analysisVersion') } : {}),
      ...(request.method() === 'POST' && /\/(?:snapshot-preparations|snapshot-publications(?:\/aspub_[a-f0-9]{24}\/withdrawals)?)$/.test(pathname) ? { input: request.postDataJSON() } : {}) });
    });
    target.on('response', response => {
      const pathname = new URL(response.url()).pathname;
      if (response.status() === 404 && pathname.startsWith('/api/')) {
        const observed = { actor, pageId, pathname, status: 404, at: Date.now(), code: null };
        failureReads.push((async () => {
          try {
            const bytes = await response.body();
            if (bytes.length <= 16 * 1024) { const code = JSON.parse(bytes.toString('utf8')).code;
              if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)) observed.code = code; }
          } catch { /* An unreadable denial cannot satisfy the scoped expectation. */ }
          httpFailures.push(observed);
        })());
      }
      if (!response.ok() || !pathname.startsWith('/assets/') || !pathname.endsWith('.js')) return;
      assetReads.push((async () => { const actual = sha(await response.body()); compiledAssets[pathname] = actual; assert(frozen.get(pathname.split('/').at(-1)) === actual, 'Production assets changed during sharing acceptance.'); })().catch(error => browserErrors.push(error.message)));
    });
    return target;
  }
  async function login(actor = 'owner') {
    const context = await browser.newContext({ viewport: { width: 1366, height: 768 } }); const target = registerPage(await context.newPage(), actor);
    await target.goto(service.endpoint); await target.getByPlaceholder('researcher@lab.edu').fill(accounts[actor].email);
    await target.getByLabel('Password', { exact: true }).fill(service.account.password); await target.getByRole('button', { name: /Open Workbench/ }).click();
    await target.getByText('Connection details', { exact: true }).waitFor(); return target;
  }
  async function nav(target, name) {
    const expand = target.getByRole('button', { name: 'Expand sidebar', exact: true }); if (await expand.isVisible()) await expand.click();
    await target.getByRole('button', { name, exact: typeof name === 'string' }).click();
  }
  async function openAnalysis(target, selectedStudy = study) {
    await nav(target, /^Data workspace,/); await target.getByRole('button', { name: new RegExp('^' + escape(service.project.name) + '(?:$|\\s)') }).click();
    await nav(target, 'Analyses');
    if (await panel(target).isVisible()) await panel(target).getByRole('button', { name: /Back to (?:analysis|private preparation)/ }).click();
    if (await prep(target).isVisible()) await prep(target).getByRole('button', { name: 'Back to analysis', exact: true }).click();
    const all = target.getByRole('button', { name: 'All analyses', exact: true }); if (await all.isVisible()) await all.click();
    await target.getByRole('list', { name: 'Analysis list', exact: true }).getByRole('button', { name: new RegExp('^' + escape(selectedStudy.name)) }).click();
    await target.getByRole('region', { name: 'Selected analysis', exact: true }).waitFor();
  }
  async function openPublications(target, selectedStudy = study) { await openAnalysis(target, selectedStudy); await target.getByRole('button', { name: 'Published snapshots', exact: true }).click(); await panel(target).waitFor(); }
  async function openPublic(target) {
    await panel(target).getByRole('button', { name: 'Browse published snapshots', exact: true }).click();
    await panel(target).getByRole('button', { name: 'Open published snapshot', exact: true }).first().click();
    await detail(target).getByRole('heading', { name: 'Published to this project', exact: true }).waitFor();
  }
  async function restart() {
    await Promise.all(assetReads); const previous = browser; await previous.close(); assert(!previous.isConnected(), 'Previous Chromium did not terminate.');
    browser = await launch(); restarts.push({ previousClosed: true, replacementConnected: browser.isConnected() }); page = await login(); return page;
  }
  async function theme(target, name) {
    const current = await target.evaluate(() => document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'); if (current === name) return;
    const expand = target.getByRole('button', { name: 'Expand sidebar', exact: true }); if (await expand.isVisible()) await expand.click();
    await target.getByRole('button', { name: `Switch to ${name} mode`, exact: true }).click();
    const collapse = target.getByRole('button', { name: 'Collapse sidebar', exact: true }); if (await collapse.isVisible()) await collapse.click();
    await until(async () => await target.evaluate(() => document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light') === name, 'Rendered theme did not settle.');
  }
  async function capture(target, name) {
    await target.waitForTimeout(350);
    const graphs = target.locator('.js-plotly-plot');
    for (let index = 0; index < await graphs.count(); index++) {
      const graph = graphs.nth(index);
      if (await graph.isVisible()) await until(async () => graph.evaluate(element => element.getBoundingClientRect().height >= 390
        && element._fullLayout?.height >= 390 && Math.abs(element.getBoundingClientRect().width - element._fullLayout.width) <= 2), 'The retained plot collapsed or failed to resize in the actual sharing layout.');
    }
    assert(await target.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Sharing created whole-page horizontal overflow.');
    await target.screenshot({ path: path.join(directory, name + '.png'), fullPage: true }); screenshots.push(name + '.png');
    profiles.push({ filename: name + '.png', viewport: target.viewportSize(), theme: await target.evaluate(() => document.documentElement.dataset.theme || 'light') });
  }
  async function matrix(target, prefix, focus) {
    for (const [width, height] of [[1366, 768], [1440, 900], [390, 844]]) {
      await target.setViewportSize({ width, height });
      for (const name of ['light', 'dark']) { await theme(target, name); if (focus) await focus(); await capture(target, `${prefix}-${name}-${width}`); }
      if (width === 1366) { const expand = target.getByRole('button', { name: 'Expand sidebar', exact: true }); if (await expand.isVisible()) await expand.click(); if (focus) await focus(); await capture(target, `${prefix}-dark-${width}-expanded-sidebar`); }
    }
  }
  async function refresh(target) {
    const response = target.waitForResponse(value => value.request().method() === 'GET' && new URL(value.url()).pathname === publicationPath());
    await panel(target).getByRole('button', { name: 'Refresh sharing access', exact: true }).click(); await response;
    await until(() => panel(target).getByRole('button', { name: 'Refresh sharing access', exact: true }).isEnabled(), 'Sharing refresh did not settle.');
  }
  try {
    service = await createAnalysisSharingRuntimeFixture({ artifactDirectory: directory, configureEnvironment: typedProducer?.configureEnvironment, configureProjectEnvironment: async ({ env, account, project }) => {
      const client = new Client({ connectionString: env.DATABASE_URL }); await client.connect();
      try {
        const owner = (await client.query('SELECT * FROM users WHERE email=$1', [account.email])).rows[0]; accounts.owner = { id: Number(owner.id), email: account.email };
        const org = (await client.query('SELECT organization_id FROM projects WHERE id=$1', [project.id])).rows[0].organization_id;
        const email = 'sharing-reader-' + crypto.randomBytes(7).toString('hex') + '@example.invalid';
        const reader = (await client.query('INSERT INTO users(email,password_hash,salt,display_name) VALUES($1,$2,$3,$4) RETURNING id', [email, owner.password_hash, owner.salt, 'Sharing colleague'])).rows[0];
        accounts.colleague = { id: Number(reader.id), email };
        await client.query("INSERT INTO organization_members(organization_id,user_id,role) VALUES($1,$2,'member')", [org, reader.id]);
        await client.query("INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,'viewer')", [project.id, reader.id]);
      } finally { await client.end(); } return {};
    } });
    if (typedResults) {
      // The genuine Plumber service starts without a standard pipeline session.
      // Sharing/private workflows do not create that unrelated standard state.
      expectRuntime(404, '/api/r/pipeline-state', 'No standard pipeline state was opened in this sharing fixture.');
      expectRuntime(403, '/api/r/pipeline-state', 'A project viewer has no standard pipeline execution access.');
    }
    database = new Client({ connectionString: service.databaseUrl }); await database.connect(); browser = await launch(); page = await login();
    findings = await produceSharingFindings((pathname, options) => api(page, pathname, options), service.project.id, service.environment);
    if (typedProducer) typedFindings = await typedProducer.produce({ database, service, owner: accounts.owner, colleague: accounts.colleague,
      api: (pathname, options) => api(page, pathname, options), capture: capturedResults, embedding: embeddingResults });
    const reference = version => ({ kind: 'artifact-version', versionId: version.versionId, sha256: version.sha256 });
    const typedReferences = typedFindings ? ['values', 'summary', 'figure'].map(name => typedFindings.outputs[name]).map(output => ({ kind: 'artifact-version', versionId: output.id, sha256: output.sha256 })) : [];
    if (linkedResults) {
      const opaque = await importFixture(page, 'Owned opaque prerequisite', 'opaque-prerequisite.bin', 'An inert opaque prerequisite.\n');
      await database.query("UPDATE project_members SET role='analyst' WHERE project_id=$1 AND user_id=$2", [service.project.id, accounts.colleague.id]);
      const other = await login('colleague');
      const restricted = await importFixture(other, 'PRIVATE_UNSELECTED_SOURCE_LABEL', 'private-unselected-source.csv', 'private,value\nnot-disclosed,19\n');
      study = (await api(other, `/api/projects/${service.project.id}/analyses`, { method: 'POST', status: 201, body: { requestId: crypto.randomUUID(),
        name: 'Shared condition findings', description: 'Compare the two synthetic conditions without sharing a live session.', references: [reference(restricted)] } })).analysis;
      await other.context().close();
      await database.query("UPDATE project_members SET role='viewer' WHERE project_id=$1 AND user_id=$2", [service.project.id, accounts.colleague.id]);
      const refs = [reference(restricted), reference(findings.table), reference(findings.figure), reference(opaque), ...(capturedResults ? [typedFindings.snapshotReference] : typedReferences),
        ...(embeddingResults ? [{ kind: 'artifact-version', versionId: typedFindings.outputs.embedding.id, sha256: typedFindings.outputs.embedding.sha256 }] : [])];
      study = (await api(page, analysisPath(), { method: 'PATCH', body: { expectedVersion: 1, references: refs } })).analysis;
      selectedAnalysisVersion = study.version;
      study = (await api(page, analysisPath(), { method: 'PATCH', body: { expectedVersion: study.version, references: refs.filter(item => item.versionId !== findings.table.versionId) } })).analysis;
      latestAnalysisVersion = study.version; linkedInfo = { opaque, restricted };
    } else study = (await api(page, `/api/projects/${service.project.id}/analyses`, { method: 'POST', status: 201, body: { requestId: crypto.randomUUID(), name: 'Shared condition findings', description: 'Compare the two synthetic conditions without sharing a live session.' } })).analysis;
    const attached = [];
    for (const [version, caption] of [[findings.table, 'Six control and six treated cells'], [findings.figure, 'Computed condition counts figure']]) {
      if (linkedResults && version === findings.figure) { attached.push({ caption }); continue; }
      attached.push((await api(page, analysisPath() + '/attachments', { method: 'POST', status: 201, body: { requestId: crypto.randomUUID(),
        reference: { kind: 'artifact-version', versionId: version.versionId, sha256: version.sha256 }, caption,
        suppliedOrigin: { origin: 'Explicitly saved synthetic R output; producing-source linkage is not established by this attachment.' } } })).acceptedRevision);
    }
    const { importScriptDocument } = await import('../shared/scriptDocument.mjs');
    const content = importScriptDocument({ filename: 'synthetic-conditions.R', bytes: Buffer.from(findings.source), cellId: 'conditions_r' });
    const saved = (await api(page, analysisPath() + '/documents', { method: 'POST', status: 201, body: { requestId: crypto.randomUUID(), title: 'Supplied condition method', content } })).document;
    const scientificCount = (await database.query('SELECT COUNT(*)::int AS n FROM private_r_executions')).rows[0].n;
    const jobCount = (await database.query('SELECT COUNT(*)::int AS n FROM jobs')).rows[0].n;
    if (capturedResults) {
      await stopProducers();
      const object = (await database.query('SELECT storage_key FROM workflow_artifacts WHERE id=$1', [typedFindings.outputs.object.id])).rows[0];
      for (const filename of [typedFindings.checkpointFilename, path.resolve(service.storageRoot, ...object.storage_key.split('/'))]) {
        assert(filename.startsWith(path.resolve(service.storageRoot) + path.sep), 'Unrelated capture source removal escaped the owned fixture.'); fs.unlinkSync(filename);
      }
      check('Two genuine completed R runs reuse exact output identities under later recorded false/zero/settings/seed and a distinct environment job; compute and unrelated root/opaque source files are gone before captured-output preparation.');
    }
    await openAnalysis(page); await page.getByRole('textbox', { name: 'Research question or notes', exact: true }).fill('An unsaved interpretation stays outside the published snapshot.');
    await page.getByRole('button', { name: 'Prepare sharing', exact: true }).click();
    const choices = prep(page).getByRole('form', { name: 'Prepare private snapshot', exact: true });
    for (const item of linkedResults ? attached.slice(0, 1) : attached) {
      await choices.getByRole('region', { name: 'Choose retained findings', exact: true }).getByRole('listitem').filter({ has: page.getByText(item.caption, { exact: true }) }).getByRole('button', { name: /^(?:Add table excerpt|Add figure)$/ }).click();
    }
    if (linkedResults) {
      const selectVersion = version => choices.getByRole('radio', { name: new RegExp(`Saved version ${version} ·`) }).check();
      await selectVersion(selectedAnalysisVersion);
      let linked = choices.getByRole('region', { name: `Linked in saved analysis ${selectedAnalysisVersion}`, exact: true });
      await linked.getByRole('list', { name: 'Linked saved references' }).getByRole('listitem').filter({ has: page.getByText(findings.table.name, { exact: true }) }).getByRole('button', { name: 'Add linked table excerpt', exact: true }).click();
      await linked.getByRole('textbox', { name: 'Caption for linked finding 1', exact: true }).fill('A deliberate treated-cell excerpt from the older saved analysis');
      await linked.getByRole('spinbutton', { name: 'First data row for linked finding 1', exact: true }).fill('2');
      await linked.getByRole('spinbutton', { name: 'Rows to include for linked finding 1', exact: true }).fill('1');
      await selectVersion(latestAnalysisVersion);
      await choices.getByRole('region', { name: `Linked in saved analysis ${latestAnalysisVersion}`, exact: true }).waitFor();
      assert(!(await choices.getByRole('textbox', { name: 'Caption for linked finding 1', exact: true }).count()), 'An older version selection leaked into the later saved version.');
      await selectVersion(selectedAnalysisVersion);
      linked = choices.getByRole('region', { name: `Linked in saved analysis ${selectedAnalysisVersion}`, exact: true });
      assert(await linked.getByRole('textbox', { name: 'Caption for linked finding 1', exact: true }).inputValue() === 'A deliberate treated-cell excerpt from the older saved analysis'
        && await linked.getByRole('spinbutton', { name: 'First data row for linked finding 1', exact: true }).inputValue() === '2', 'Returning to the older saved version lost its deliberate caption or table window.');
      await linked.getByRole('list', { name: 'Linked saved references' }).getByRole('listitem').filter({ has: page.getByText(findings.figure.name, { exact: true }) }).getByRole('button', { name: 'Add linked figure', exact: true }).click();
      await linked.getByRole('textbox', { name: 'Caption for linked finding 2', exact: true }).fill(attached[1].caption);
      if (typedFindings && !capturedResults) {
        for (const [position, name, button] of [[3, 'values', 'Add linked table excerpt'], [4, 'summary', 'Add linked metrics'], [5, 'figure', 'Add linked figure']]) {
          const option = linked.getByRole('list', { name: 'Linked saved references' }).getByRole('listitem').filter({ hasText: typedFindings.outputs[name].id });
          await option.getByRole('button', { name: button, exact: true }).click();
          await linked.getByRole('textbox', { name: `Caption for linked finding ${position}`, exact: true }).fill(findingCaption(name));
          if (name === 'values') await linked.getByRole('spinbutton', { name: `Rows to include for linked finding ${position}`, exact: true }).fill('2');
        }
        assert(await linked.getByText('Recorded typed metrics · declared meaning retained', { exact: true }).count() === 1, 'Typed linked choices duplicated their flat metadata card.');
        const metricsOption = linked.getByRole('list', { name: 'Linked saved references' }).getByRole('listitem').filter({ hasText: typedFindings.outputs.summary.id });
        await matrix(page, 'typed-linked-choices-with-recorded-meaning', () => metricsOption.scrollIntoViewIfNeeded());
      }
      if (capturedResults) {
        const card = linked.getByRole('list', { name: 'Linked saved references' }).getByRole('listitem').filter({ hasText: typedFindings.snapshotReference.snapshotId });
        await card.getByRole('button', { name: 'Inspect captured outputs', exact: true }).click();
        const captured = card.getByRole('region', { name: `Captured outputs from ${typedFindings.snapshotReference.snapshotId}`, exact: true });
        for (const [position, name, button] of [[3, 'values', 'Add captured table excerpt'], [4, 'summary', 'Add captured metrics'], [5, 'figure', 'Add captured figure']]) {
          const option = captured.getByRole('list', { name: 'Recorded workflow outputs' }).getByRole('listitem').filter({ hasText: typedFindings.outputs[name].id });
          await option.getByRole('button', { name: button, exact: true }).click();
          await linked.getByRole('textbox', { name: `Caption for linked finding ${position}`, exact: true }).fill(findingCaption(name));
          if (name === 'values') await linked.getByRole('spinbutton', { name: `Rows to include for linked finding ${position}`, exact: true }).fill('2');
        }
        const context = linked.getByRole('group', { name: 'Recorded context for linked finding 3', exact: true });
        await context.getByRole('checkbox', { name: /^Include recorded method/ }).check();
        for (const key of ['minimum', 'normalize', 'mode']) await context.getByRole('checkbox', { name: `Include ${key} for linked finding 3`, exact: true }).check();
        await context.getByRole('checkbox', { name: /^Include recorded seed/ }).check();
        await context.getByRole('checkbox', { name: /^Include recorded environment reference/ }).check();
        assert(!(await linked.getByText('PRIVATE_UNSELECTED_CAPTURE_NOTE', { exact: true }).count()) && !(await linked.getByText('../PRIVATE_CAPTURE_PATH', { exact: true }).count()), 'Private recorded parameters escaped the captured chooser.');
        await captured.getByRole('list', { name: 'Recorded workflow outputs' }).getByRole('listitem').filter({ hasText: typedFindings.outputs.object.id })
          .getByRole('button', { name: 'Include captured reference only', exact: true }).click();
        if (embeddingResults) {
          const direct = linked.getByRole('list', { name: 'Linked saved references' }).getByRole('listitem').filter({ hasText: typedFindings.outputs.embedding.id });
          await direct.getByRole('button', { name: 'Add linked embedding', exact: true }).click();
          await linked.getByRole('textbox', { name: 'Caption for linked finding 6', exact: true }).fill('Five exact PCA points linked to this saved analysis');
          await linked.getByRole('spinbutton', { name: 'Maximum included points for linked finding 6', exact: true }).fill('5');
          await captured.getByRole('list', { name: 'Recorded workflow outputs' }).getByRole('listitem').filter({ hasText: typedFindings.outputs.embedding.id })
            .getByRole('button', { name: 'Add captured embedding', exact: true }).click();
          await linked.getByRole('textbox', { name: 'Caption for linked finding 7', exact: true }).fill('Nine exact PCA points from the saved workflow capture');
          await linked.getByRole('spinbutton', { name: 'Maximum included points for linked finding 7', exact: true }).fill('9');
          await matrix(page, 'embedding-explicit-direct-and-captured-bounds', () => linked.getByRole('spinbutton', { name: 'Maximum included points for linked finding 7', exact: true }).scrollIntoViewIfNeeded());
        }
        await matrix(page, 'captured-output-choices-and-opaque-reference', () => captured.scrollIntoViewIfNeeded());
        await matrix(page, 'captured-explicit-recorded-settings-review', () => context.scrollIntoViewIfNeeded());
      }
      for (const version of [linkedInfo.opaque, linkedInfo.restricted]) {
        await linked.getByRole('list', { name: 'Linked saved references' }).getByRole('listitem').filter({ hasText: version.versionId }).getByRole('button', { name: 'Include reference only', exact: true }).click();
      }
      assert(!(await choices.getByText('PRIVATE_UNSELECTED_SOURCE_LABEL', { exact: true }).count()), 'The linked chooser disclosed a restricted source label.');
      await matrix(page, 'linked-older-version-caption-and-window', () => linked.getByRole('list', { name: 'Selected linked findings' }).scrollIntoViewIfNeeded());
      await matrix(page, 'linked-reference-only-prerequisites', () => linked.getByRole('region', { name: 'Selected reference-only prerequisites' }).scrollIntoViewIfNeeded());
    }
    await choices.getByRole('checkbox', { name: /Supplied condition method/ }).check();
    const retainedA = linkedResults ? intercept({ method: 'POST', pathname: prepPath(), mode: 'hold' }) : null;
    if (retainedA) faults.push(retainedA);
    await choices.getByRole('button', { name: 'Prepare private preview', exact: true }).click();
    if (retainedA) {
      await until(() => retainedA.observation(), 'The genuine v2 preparation acceptance was not held.');
      const acceptance = retainedA.observation();
      assert(acceptance.status === 201 && acceptance.value?.state === 'ready' && acceptance.value?.recipe?.schema === 'traceomics.analysis-snapshot-preparation.v2',
        `The genuine preparation did not return its expected bounded ready v2 acceptance (status ${acceptance.status}, ${acceptance.bytes} bytes).`);
      await restart(); retainedA.release(); await openAnalysis(page); await page.getByRole('button', { name: 'Prepare sharing', exact: true }).click();
      await prep(page).getByRole('button', { name: 'Saved preparations', exact: true }).click(); await prep(page).getByRole('button', { name: 'Open private preparation', exact: true }).click();
    }
    await prep(page).getByRole('heading', { name: 'Ready for private review', exact: true }).waitFor();
    const candidate = (await api(page, prepPath())).items[0]; const originalA = await api(page, prepPath() + '/' + candidate.preparationId);
    const packageSha = originalA.snapshotSha256, physical = (await database.query('SELECT COUNT(*)::int AS n FROM research_analysis_snapshot_blobs WHERE preparation_id=$1', [candidate.preparationId])).rows[0].n;
    assert(physical === (embeddingResults ? 9 : typedResults ? 7 : linkedResults ? 4 : 3), 'The computed findings and saved source were not independently retained, or a reference-only prerequisite retained bytes.');
    if (typedFindings) {
      const selected = originalA.package.results.filter(item => item.origin.kind === (capturedResults ? 'captured-workflow-output' : 'typed-analysis-reference') && item.view.family !== 'embedding');
      assert(selected.length === 3 && selected.every(item => item.view.schema === 'traceomics.fixed-result-view.v3'
        && item.view.descriptorSha256 === originalA.recipe.results.find(choice => choice.kind === item.origin.kind && choice.reference.versionId === item.source.versionId)?.descriptorSha256), 'The retained typed descriptors changed after actual R production or original preparation recovery.');
      if (capturedResults) {
        const context = selected.find(item => item.source.versionId === typedFindings.outputs.values.id).origin.context;
        assert(context.parameters[0].value === 0 && context.parameters[1].value === false && context.parameters[2].value === 'counts' && context.seed === 0
          && context.environment && !/PRIVATE_UNSELECTED_CAPTURE_NOTE|PRIVATE_CAPTURE_PATH|write_output/.test(JSON.stringify(originalA.package)), 'Captured retained context was substituted, coerced or exposed private method contents.');
      }
    }
    if (linkedResults) {
      assert(originalA.package.schema === 'traceomics.analysis-snapshot-package.v2' && originalA.package.analysis.version === selectedAnalysisVersion
        && originalA.package.prerequisites.items.length === (capturedResults ? 3 : 2) && originalA.package.results.filter(item => item.origin.kind === 'analysis-reference').length === 2
        && !JSON.stringify(originalA.package).includes('PRIVATE_UNSELECTED_SOURCE_LABEL'), 'The exact mixed v2 preparation or safe prerequisite projection changed.');
      await prep(page).getByRole('button', { name: 'Back to analysis', exact: true }).click();
      await page.getByRole('textbox', { name: 'Research question or notes', exact: true }).fill('An unsaved interpretation stays outside the published snapshot.');
      await page.getByRole('button', { name: 'Prepare sharing', exact: true }).click();
      check('An older exact saved analysis keeps separate linked captions/windows and safe opaque/restricted reference-only prerequisites; the genuine mixed v2 preparation survives a lost accepted reply and real browser restart without retaining prerequisite bytes.');
    }
    await prep(page).getByRole('button', { name: 'Publish to project', exact: true }).click();
    const confirmation = panel(page).getByRole('region', { name: 'Confirm exact snapshot publication', exact: true });
    await confirmation.getByRole('button', { name: 'Publish to project', exact: true }).waitFor();
    await panel(page).getByRole('button', { name: 'Back to private preparation', exact: true }).click();
    await until(() => prep(page).getByRole('button', { name: 'Publish to project', exact: true }).evaluate(node => node === document.activeElement), 'Back from confirmation did not restore the private review action focus.');
    await prep(page).getByRole('button', { name: 'Back to analysis', exact: true }).click();
    assert(await page.getByRole('textbox', { name: 'Research question or notes', exact: true }).inputValue() === 'An unsaved interpretation stays outside the published snapshot.'
      && (await database.query('SELECT version FROM research_analyses WHERE id=$1', [study.id])).rows[0].version === latestAnalysisVersion,
    'Publication navigation discarded or silently saved the independent overview draft.');
    await page.getByRole('button', { name: 'Prepare sharing', exact: true }).click(); await prep(page).getByRole('button', { name: 'Publish to project', exact: true }).click();
    await until(() => confirmation.getByRole('button', { name: 'Publish to project', exact: true }).isEnabled(), 'The same acknowledged private snapshot did not reopen for publication.');
    await matrix(page, 'sharing-exact-publication-confirmation', () => confirmation.getByRole('heading').scrollIntoViewIfNeeded());
    let interrupted = false; const interrupt = async route => { if (!interrupted && route.request().method() === 'POST') { interrupted = true; await route.abort('failed'); } else await route.continue(); };
    faultPaths.add(publicationPath()); await page.route('**' + publicationPath(), interrupt);
    await confirmation.getByRole('button', { name: 'Publish to project', exact: true }).click(); await until(() => writes().length === 1, 'The interrupted original publication was not observed.');
    const intent = writes()[0].input; assert(intent.preparationId === candidate.preparationId && intent.snapshotSha256 === packageSha, 'Publication changed the acknowledged exact private snapshot.');
    expected.add(`404 ${publicationPath()}/requests/${intent.requestId}`);
    const recovery = panel(page).getByRole('region', { name: 'Original sharing request', exact: true }); await recovery.getByRole('button', { name: 'Check original sharing request', exact: true }).click();
    await recovery.getByRole('button', { name: 'Retry original publication', exact: true }).waitFor(); await page.unroute('**' + publicationPath(), interrupt);
    const held = intercept({ method: 'POST', pathname: publicationPath(), mode: 'hold' }); faults.push(held);
    await recovery.getByRole('button', { name: 'Retry original publication', exact: true }).click(); await until(() => held.observation(), 'The genuine committed publication response was not held.');
    const accepted = held.observation().value, publicationId = accepted.acceptance.publicationId;
    assert(accepted.current.snapshotSha256 === packageSha && JSON.stringify(writes()[1].input) === JSON.stringify(intent), 'The explicit retry changed its recipe or was not really accepted.');
    await restart(); held.release(); await openPublications(page); await panel(page).getByRole('button', { name: 'Your sharing activity', exact: true }).click();
    await panel(page).getByRole('button', { name: 'Check accepted sharing action', exact: true }).click();
    await panel(page).getByRole('heading', { name: 'Publication accepted', exact: true }).waitFor();
    assert(writes().length === 2, 'Accepted private activity recovery published again after restart.');
    await matrix(page, 'sharing-original-acceptance-after-restart', () => panel(page).getByRole('region', { name: 'Accepted sharing action', exact: true }).scrollIntoViewIfNeeded());
    check('Explicit publication is bound to the reviewed snapshot SHA; pre-upstream failure permits only deliberate identical retry, and genuine accepted lost acknowledgement is rediscovered from actor-private activity after a real browser restart without another publication.');

    await stopProducers();
    assert((await database.query('SELECT status FROM private_r_kernels WHERE id=$1', [findings.kernel.id])).rows[0].status === 'stopped', 'The genuine producing kernel was not stopped.');
    for (const version of [findings.table, findings.figure]) {
      const row = (await database.query('SELECT storage_key FROM managed_artifact_versions WHERE id=$1', [version.versionId])).rows[0];
      const filename = path.resolve(service.storageRoot, ...row.storage_key.split('/')); assert(filename.startsWith(path.resolve(service.storageRoot) + path.sep), 'Source removal escaped the owned fixture.'); fs.unlinkSync(filename);
    }
    if (typedFindings) for (const name of ['values', 'summary', 'figure', ...(embeddingResults ? ['embedding'] : [])]) {
      const output = typedFindings.outputs[name];
      const row = (await database.query('SELECT storage_key FROM workflow_artifacts WHERE id=$1', [output.id])).rows[0];
      const filename = path.resolve(service.storageRoot, ...row.storage_key.split('/'));
      assert(filename.startsWith(path.resolve(service.storageRoot) + path.sep), 'Typed source removal escaped the owned fixture.'); fs.unlinkSync(filename);
    }
    if (capturedResults) {
      const artifact = (await database.query('SELECT storage_uri FROM job_artifacts WHERE id=$1 AND created_by_user_id=$2', [typedFindings.environmentArtifact.id, accounts.owner.id])).rows[0];
      const filename = path.resolve(service.storageRoot, ...artifact.storage_uri.split('/'));
      assert(filename.startsWith(path.resolve(service.storageRoot) + path.sep), 'Recorded manifest removal escaped the owned fixture.'); fs.unlinkSync(filename);
      // Simulate historical source loss in this one owned disposable fixture.
      // Ordinary linked-capture deletion remains protected by production guards.
      try {
        await database.query('BEGIN'); await database.query("SET LOCAL session_replication_role='replica'");
        await database.query('DELETE FROM workflow_snapshots WHERE id=$1 AND owner_user_id=$2', [typedFindings.snapshotReference.snapshotId, accounts.owner.id]); await database.query('COMMIT');
      } catch (error) { await database.query('ROLLBACK'); throw error; }
    }
    await openAnalysis(page); await page.getByRole('button', { name: 'Prepare sharing', exact: true }).click(); await prep(page).getByRole('button', { name: 'Saved preparations', exact: true }).click();
    await prep(page).getByRole('button', { name: 'Open private preparation', exact: true }).click(); await prep(page).getByRole('button', { name: 'Remove private preparation', exact: true }).click();
    await prep(page).getByRole('button', { name: 'Remove private preparation', exact: true }).click(); await prep(page).getByRole('heading', { name: 'Private preparation removed', exact: true }).waitFor();
    const tombstone = await api(page, prepPath() + '/' + candidate.preparationId);
    assert(tombstone.recipe === null && tombstone.package === null && (await database.query('SELECT COUNT(*)::int AS n FROM research_analysis_snapshot_blobs WHERE preparation_id=$1', [candidate.preparationId])).rows[0].n === physical, 'Private deletion erased shared bytes or kept private payload authority.');
    await api(page, analysisPath(), { method: 'PATCH', body: { expectedVersion: latestAnalysisVersion, description: 'A later saved interpretation must not change the published findings.' } });
    const newer = structuredClone(content); newer.cells[0].source = 'stop("A later method is separate from the retained source")\n';
    await api(page, `${analysisPath()}/documents/${saved.id}`, { method: 'PUT', body: { requestId: crypto.randomUUID(), expectedVersion: saved.version, title: saved.title, content: newer } });
    const colleague = await login('colleague'); await openPublications(colleague); await openPublic(colleague);
    await detail(colleague).getByRole('cell', { name: 'control', exact: true }).waitFor(); await detail(colleague).getByRole('cell', { name: 'treated', exact: true }).waitFor();
    await matrix(colleague, 'sharing-colleague-fixed-counts-producer-stopped', () => detail(colleague).getByRole('table').scrollIntoViewIfNeeded());
    if (linkedResults) {
      await detail(colleague).getByRole('list', { name: 'Retained finding selection', exact: true }).getByRole('button').filter({ hasText: 'A deliberate treated-cell excerpt from the older saved analysis' }).click();
      await detail(colleague).getByRole('cell', { name: 'treated', exact: true }).waitFor();
      assert(!(await detail(colleague).getByRole('cell', { name: 'control', exact: true }).count()), 'The direct linked table expanded its fixed one-row excerpt.');
      const referenceOnly = detail(colleague).getByRole('region', { name: 'Reference-only prerequisites', exact: true });
      await referenceOnly.getByText('Contents not included. Integrity not checked. Data access not granted.', { exact: true }).waitFor();
      assert(await referenceOnly.locator('details').count() === (capturedResults ? 3 : 2) && !(await referenceOnly.locator('img,table,pre').count())
        && !JSON.stringify(await api(colleague, `${publicationPath()}/${publicationId}`)).includes('PRIVATE_UNSELECTED_SOURCE_LABEL'), 'A reference-only prerequisite disclosed original contents or restricted source metadata.');
      await matrix(colleague, 'linked-colleague-fixed-direct-excerpt', () => detail(colleague).getByRole('table').scrollIntoViewIfNeeded());
      await matrix(colleague, 'linked-colleague-reference-only-prerequisites', () => referenceOnly.scrollIntoViewIfNeeded());
      check('A colleague reads the exact direct one-row excerpt and both inert prerequisite identities with producer stopped, newer heads and original files gone; no private source label or prerequisite contents are disclosed.');
    }
    if (typedFindings) {
      const selection = detail(colleague).getByRole('list', { name: 'Retained finding selection', exact: true });
      await selection.getByRole('button').filter({ hasText: findingCaption('values') }).click();
      const table = detail(colleague).getByRole('table'); await table.getByRole('cell', { name: 'false', exact: true }).waitFor();
      for (const value of ['true', '0', 'null', 'empty string']) assert(await table.getByRole('cell', { name: value, exact: true }).count() > 0, 'The typed table lost an exact scalar distinction: ' + value);
      await detail(colleague).getByText(typedFindings.meaning.values.title, { exact: true }).waitFor();
      await matrix(colleague, 'typed-colleague-table-scalars-producer-stopped', () => table.scrollIntoViewIfNeeded());
      if (capturedResults) {
        const context = detail(colleague).locator('details[aria-label="Recorded workflow context"]'); await context.locator('summary').first().click();
        await context.getByText('Recorded environment reference checked when prepared; current runtime availability not checked.', { exact: true }).waitFor();
        await context.getByText('Optional normalization', { exact: true }).waitFor();
        for (const value of ['0', 'false', 'counts']) assert(await context.getByText(value, { exact: true }).count() > 0, 'The colleague lost a selected recorded scalar setting.');
        assert(!(await context.getByText('PRIVATE_UNSELECTED_CAPTURE_NOTE', { exact: true }).count()), 'A private annotation appeared in retained context.');
        await matrix(colleague, 'captured-colleague-recorded-settings-after-capture-loss', () => context.scrollIntoViewIfNeeded());
      }
      await selection.getByRole('button').filter({ hasText: findingCaption('summary') }).click();
      const metrics = detail(colleague).locator('dl[aria-label="Saved scalar metrics"]');
      await detail(colleague).getByText('Retained cells (cells)', { exact: true }).waitFor();
      await detail(colleague).getByText(typedFindings.meaning.summary.title, { exact: true }).waitFor();
      for (const value of ['false', '0', 'null', 'empty string']) assert(await metrics.getByText(value, { exact: true }).count() > 0, 'The typed metrics lost a scalar: ' + value);
      await detail(colleague).getByText('Measured features (features)', { exact: true }).waitFor();
      await matrix(colleague, 'typed-colleague-metrics-labels-units-producer-stopped', () => detail(colleague).getByText('Retained cells (cells)', { exact: true }).scrollIntoViewIfNeeded());
      await selection.getByRole('button').filter({ hasText: findingCaption('figure') }).click();
      await detail(colleague).getByText(typedFindings.meaning.figure.title, { exact: true }).waitFor();
      const typedImage = detail(colleague).getByRole('img');
      await until(async () => await typedImage.count() && await typedImage.evaluate(node => node.complete && node.naturalWidth > 0), 'The retained semantic R figure did not decode.');
      await matrix(colleague, 'typed-colleague-semantic-figure-producer-stopped', () => typedImage.scrollIntoViewIfNeeded());
      for (const reference of typedReferences) await api(colleague, `/api/artifact-versions/${service.project.id}/${reference.versionId}`, { status: 404 });
      check('Actual completed R workflow tables, metrics and PNG retain exact scalar types, labels, units, declared meaning and descriptor identities for a separate colleague after worker/runtime shutdown, original file deletion and private preparation removal.');
    }
    if (embeddingResults) {
      const selected = originalA.package.results.filter(item => item.view.family === 'embedding');
      assert(selected.length === 2 && selected[0].view.spec.pointLimit === 5 && selected[1].view.spec.pointLimit === 9
        && selected[0].origin.kind === 'typed-analysis-reference' && selected[1].origin.kind === 'captured-workflow-output', 'The exact direct/captured embedding bounds or origins changed.');
      const bodies = [];
      for (const result of selected) {
        const body = await api(colleague, `${publicationPath()}/${publicationId}/views/${result.viewId}`);
        const source = { artifactId: result.source.artifactId, versionId: result.source.versionId, projectId: service.project.id, sha256: result.source.sha256 };
        const expectedBody = require('../backend/retainedTypedPreviews').projectRetainedEmbedding({ source, value: typedFindings.embeddingSource,
          pointLimit: result.view.spec.pointLimit, semantics: result.view.semantics });
        const { canonicalSnapshotJson } = await import('../shared/analysisSnapshotPreparationDispatch.mjs');
        assert(canonicalSnapshotJson(body) === canonicalSnapshotJson(expectedBody), 'The retained embedding differs from the actual completed PCA source and established deterministic sampler.');
        for (let index = 0; index < body.sourceIndices.length; index++) {
          const original = body.sourceIndices[index];
          assert(body.ids[index] === typedFindings.embeddingSource.ids[original] && body.x[index] === typedFindings.embeddingSource.x[original]
            && body.y[index] === typedFindings.embeddingSource.y[original] && body.groups[index] === typedFindings.embeddingSource.groups[original], 'The retained PCA point identity/coordinates/group lost alignment.');
        }
        await api(colleague, `${publicationPath()}/${publicationId}/views/${result.viewId}?pointLimit=5000`, { status: 400 });
        bodies.push(body);
        await detail(colleague).getByRole('list', { name: 'Retained finding selection', exact: true }).getByRole('button').filter({ hasText: result.origin.caption }).click();
        const plot = detail(colleague).getByRole('img', { name: `Retained coordinate plot with ${result.view.spec.pointLimit} displayed source points`, exact: true });
        await plot.locator('.main-svg').first().waitFor();
        await detail(colleague).getByText(`Showing ${result.view.spec.pointLimit} of 12 source points.`, { exact: true }).waitFor();
        assert(!(await detail(colleague).getByRole('combobox', { name: 'Maximum points', exact: true }).count()), 'Published inspection offered source resampling.');
        const before = requests.length;
        const graph = plot.locator('.js-plotly-plot'); await graph.scrollIntoViewIfNeeded();
        const point = await graph.locator('.scatterlayer .point').first().boundingBox();
        assert(point, 'The real retained PCA point had no interactive geometry.');
        await colleague.mouse.move(point.x + point.width / 2, point.y + point.height / 2); await graph.locator('.hoverlayer .hovertext').waitFor();
        const range = () => graph.evaluate(element => [...element._fullLayout.xaxis.range]);
        const initialRange = await range();
        await graph.locator('.modebar-btn[data-title="Zoom in"]').click();
        await until(async () => JSON.stringify(await range()) !== JSON.stringify(initialRange), 'The retained PCA zoom did not change the local view.');
        const zoomed = await range(); await graph.locator('.modebar-btn[data-title="Pan"]').click();
        const drag = await graph.locator('.nsewdrag').boundingBox(); assert(drag, 'The retained plot had no local pan surface.');
        await colleague.mouse.move(drag.x + drag.width * .4, drag.y + drag.height * .5); await colleague.mouse.down();
        await colleague.mouse.move(drag.x + drag.width * .6, drag.y + drag.height * .5, { steps: 8 }); await colleague.mouse.up();
        await until(async () => JSON.stringify(await range()) !== JSON.stringify(zoomed), 'The retained PCA pan did not change the local view.');
        await detail(colleague).getByRole('button', { name: 'Reset plot view', exact: true }).focus(); await colleague.keyboard.press('Enter');
        await until(async () => (await range()).every((value, index) => Math.abs(value - initialRange[index]) < 1e-8 * Math.max(1, Math.abs(initialRange[index]))), 'Keyboard reset did not restore the fixed retained plot.');
        const download = colleague.waitForEvent('download'); await detail(colleague).getByRole('button', { name: 'Export plot PNG', exact: true }).focus(); await colleague.keyboard.press('Enter');
        const exported = await download; const filename = path.join(directory, `retained-pca-${result.view.spec.pointLimit}.png`); await exported.saveAs(filename);
        assert(fs.readFileSync(filename).subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'The retained PCA export was not a genuine PNG.');
        const backgroundReads = new Set(['/api/r/session-id', '/api/r/pipeline-state', '/api/r/health', '/api/runtime/compute-status', '/api/jobs']);
        const unexpectedPlotRequests = requests.slice(before).filter(item => item.method !== 'GET' || !backgroundReads.has(item.pathname));
        assert(unexpectedPlotRequests.length === 0, 'Local retained plot controls read original or scientific source data: '
          + unexpectedPlotRequests.map(item => `${item.method} ${item.pathname}`).join(', '));
        await matrix(colleague, `embedding-colleague-fixed-${result.view.spec.pointLimit}-pca-points-producer-stopped`, () => plot.scrollIntoViewIfNeeded());
      }
      assert(JSON.stringify(bodies[0].ids) === JSON.stringify(bodies[1].ids.slice(0, 5)), 'Distinct PCA sample bounds lost the established stable sample prefix.');
      check('Real Seurat PCA coordinates from twelve synthetic cells retain distinct direct/captured five/nine-point samples with aligned identifiers/groups/axes, exact stable sampling and source-free local reset/PNG export; published queries cannot enlarge either fixed disclosure.');
    }
    await detail(colleague).getByRole('list', { name: 'Retained finding selection', exact: true }).getByRole('button').filter({ hasText: attached[1].caption }).click();
    const image = detail(colleague).getByRole('img', { name: /Computed condition figure/ }); await until(async () => await image.count() && await image.evaluate(node => node.complete && node.naturalWidth > 0), 'The genuine retained R figure did not decode for the colleague.');
    await matrix(colleague, 'sharing-colleague-real-r-figure-producer-stopped', () => image.scrollIntoViewIfNeeded());
    const source = detail(colleague).getByRole('region', { name: 'Prepared supporting source', exact: true }); await source.getByRole('button', { name: 'View supporting source', exact: true }).click();
    await source.getByText('Saved supporting source checksum verified', { exact: true }).waitFor(); assert((await source.locator('pre[aria-label="Retained saved source"]').textContent()).includes('set.seed(1919)'), 'The colleague saw a newer or incorrect supporting source.');
    await matrix(colleague, 'sharing-colleague-exact-supporting-source', () => source.scrollIntoViewIfNeeded());
    const publicValue = await api(colleague, `${publicationPath()}/${publicationId}`), publicList = await api(colleague, publicationPath());
    assert(publicValue.snapshotSha256 === packageSha && publicValue.package.analysis.version === selectedAnalysisVersion && !JSON.stringify(publicList).includes(intent.requestId), 'Public discovery leaked a private UUID or advanced the retained snapshot.');
    if (capturedResults) {
      const audit = (await database.query("SELECT * FROM project_audit_events WHERE project_id=$1 AND action LIKE 'snapshot.%'", [service.project.id])).rows;
      for (const exposed of [JSON.stringify(publicValue), JSON.stringify(publicList), JSON.stringify(audit)]) {
        assert(!exposed.includes('PRIVATE_UNSELECTED_CAPTURE_NOTE') && !exposed.includes('PRIVATE_CAPTURE_PATH')
          && !exposed.includes(typedFindings.source) && !exposed.includes('internalStorageKey'), 'A publication or audit exposed private captured source, bindings or excluded settings.');
      }
      await api(colleague, `/api/projects/${service.project.id}/analyses/workflow-snapshots/${typedFindings.snapshotReference.snapshotId}`, { status: 404 });
    }
    await api(colleague, `${prepPath()}/requests/${originalA.requestId}`, { status: 404 }); await api(colleague, `${publicationPath()}/requests/${intent.requestId}`, { status: 404 });
    await api(colleague, `/api/artifact-versions/${service.project.id}/${findings.table.versionId}`, { status: 404 });
    await api(colleague, `/api/private-r-kernels/${service.project.id}/${findings.kernel.id}/executions/${findings.executionId}`, { status: 404 });
    assert(!(await detail(colleague).getByRole('button', { name: 'Withdraw from project', exact: true }).count()), 'An unrelated current reader gained withdrawal authority.');
    check('A real colleague inspects actual R-produced CSV, PNG and exact saved supporting source after the producer kernel and broker stop, original files are removed, private preparation is deleted and live heads advance. Private sources, original action UUIDs and execution history remain denied.');

    if (sharedLinks) sharedLinkEvidence = await require('./analysis-shared-links-ui.cjs').verifySharedLinks({ service, database, page, accounts, api, login,
      openPublications, openPublic, panel, detail, matrix, capture, intercept, faults, faultPaths, expected, requests, check, until,
      publicationId, packageSha, study, attached, directory, browser, registerPage, baselineColleague: colleague });

    const heldRead = intercept({ method: 'GET', pathname: `${publicationPath()}/${publicationId}`, mode: 'hold' }); faults.push(heldRead);
    await detail(colleague).getByRole('button', { name: 'Check current snapshot access', exact: true }).click(); await until(() => heldRead.observation(), 'The genuine authorized colleague read was not held.');
    const tableAfterReopen = sharedLinks && publicValue.package.results.find(item => item.view.family === 'table');
    const scopedDenial = tableAfterReopen ? { actor: 'colleague', pageId: pageIds.get(colleague), status: 404,
      pathname: `${publicationPath()}/${publicationId}/views/${tableAfterReopen.viewId}`, code: 'ANALYSIS_SNAPSHOT_SCOPE_NOT_FOUND',
      from: Date.now(), through: null, reason: 'An in-flight table read rechecks current membership during deliberate baseline revocation.' } : null;
    if (scopedDenial) scopedReadDenials.push(scopedDenial);
    await database.query('DELETE FROM project_members WHERE project_id=$1 AND user_id=$2', [service.project.id, accounts.colleague.id]); expected.add(`404 ${publicationPath()}?limit=30`);
    if (scopedDenial) {
      const rawDenied = await colleague.evaluate(async pathname => {
        const response = await fetch(pathname, { credentials: 'include' });
        const body = await response.json(); return { status: response.status, code: body.code };
      }, scopedDenial.pathname);
      assert(rawDenied.status === scopedDenial.status && rawDenied.code === scopedDenial.code,
        'The exact retained table did not deny its currently revoked reader with the authoritative scope code.');
    }
    await refresh(colleague); await until(async () => !(await detail(colleague).getByRole('heading', { name: 'Published to this project', exact: true }).count()), 'Membership revocation retained protected publication content.');
    heldRead.release(); await colleague.waitForTimeout(200); assert(!(await detail(colleague).getByText(attached[1].caption, { exact: true }).count()), 'An older held success restored publication content after scope denial.');
    await matrix(colleague, 'sharing-colleague-revoked-held-response-fenced', () => panel(colleague).scrollIntoViewIfNeeded());
    await database.query("INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,'viewer')", [service.project.id, accounts.colleague.id]); await refresh(colleague); await openPublic(colleague);
    if (scopedDenial) scopedDenial.through = Date.now();
    check('Actual reader membership revocation clears protected publication content and fences a previously authorized held reply; explicit restored access opens the original retained identity.');
    const broken = publicValue.package.results.find(item => item.view.family === 'image');
    expected.add(`409 ${publicationPath()}/${publicationId}/views/${broken.viewId}`);
    try {
      await database.query('BEGIN'); await database.query("SET LOCAL session_replication_role='replica'");
      await database.query('UPDATE research_analysis_snapshot_blobs SET content=set_byte(content,0,(get_byte(content,0)+1)%256) WHERE preparation_id=$1 AND id=$2', [candidate.preparationId, broken.viewId]); await database.query('COMMIT');
    } catch (error) { await database.query('ROLLBACK'); throw error; }
    await detail(colleague).getByRole('button', { name: 'Check current snapshot access', exact: true }).click();
    await detail(colleague).getByRole('list', { name: 'Retained finding selection', exact: true }).getByRole('button').filter({ hasText: attached[1].caption }).click();
    await detail(colleague).getByText('This retained view is unavailable. Its exact saved identity is kept and has not been regenerated.', { exact: true }).waitFor();
    assert(!(await detail(colleague).getByRole('img').count()), 'Corrupt retained PNG bytes left a verified figure visible.');
    await matrix(colleague, 'sharing-corrupt-retained-figure-no-regeneration', () => detail(colleague).getByRole('region', { name: 'Retained prepared finding', exact: true }).scrollIntoViewIfNeeded());
    check('Actual retained byte corruption removes the figure while preserving publication acceptance and other intact findings; no original source fallback or regeneration occurs.');

    await database.query("UPDATE project_members SET role='viewer' WHERE project_id=$1 AND user_id=$2", [service.project.id, accounts.owner.id]);
    await restart(); await openPublications(page); await openPublic(page);
    assert(await detail(page).getByRole('button', { name: 'Withdraw from project', exact: true }).isEnabled(), 'A downgraded publisher could not withdraw their own disclosure.');
    const reader = await login('colleague'); await openPublications(reader); await openPublic(reader);
    const older = intercept({ method: 'GET', pathname: `${publicationPath()}/${publicationId}`, mode: 'hold' }); faults.push(older);
    await detail(reader).getByRole('button', { name: 'Check current snapshot access', exact: true }).click(); await until(() => older.observation(), 'The pre-withdrawal read was not genuinely authorized and held.');
    await detail(page).getByRole('button', { name: 'Withdraw from project', exact: true }).click();
    const confirmationWithdraw = panel(page).getByRole('region', { name: 'Confirm snapshot withdrawal', exact: true }); await matrix(page, 'sharing-reader-publisher-withdrawal-confirmation', () => confirmationWithdraw.scrollIntoViewIfNeeded());
    const drop = intercept({ method: 'POST', pathname: `${publicationPath()}/${publicationId}/withdrawals`, mode: 'drop' }); faults.push(drop); faultPaths.add(`${publicationPath()}/${publicationId}/withdrawals`);
    await confirmationWithdraw.getByRole('button', { name: 'Confirm withdrawal', exact: true }).click(); await until(() => drop.observation(), 'The committed withdrawal reply was not interrupted.');
    assert(drop.observation().value.current.policy.state === 'withdrawn', 'The genuine withdrawal was not accepted.');
    await refresh(reader); older.release(); await reader.waitForTimeout(200);
    await detail(reader).getByRole('heading', { name: 'Snapshot withdrawn', exact: true }).waitFor(); assert(!(await detail(reader).getByRole('table').count()) && !(await detail(reader).getByRole('img').count()), 'An older pre-withdrawal reply restored selected scientific content.');
    await panel(page).getByRole('region', { name: 'Original sharing request', exact: true }).getByRole('button', { name: 'Check original sharing request', exact: true }).click();
    await panel(page).getByRole('heading', { name: 'Withdrawal accepted', exact: true }).waitFor();
    await matrix(page, 'sharing-original-withdrawal-recovered', () => panel(page).getByRole('region', { name: 'Accepted sharing action', exact: true }).scrollIntoViewIfNeeded());
    await matrix(reader, 'sharing-colleague-withdrawn-tombstone', () => detail(reader).scrollIntoViewIfNeeded());
    assert(!(await database.query('SELECT 1 FROM research_analysis_snapshot_blobs WHERE preparation_id=$1', [candidate.preparationId])).rowCount, 'Last active publication withdrawal did not release unneeded shared bytes after private deletion.');
    const replay = await api(page, publicationPath(), { method: 'POST', body: intent });
    assert(replay.acceptance.publicationId === publicationId && replay.current.policy.state === 'withdrawn' && replay.current.package === null, 'The original publish retry reactivated withdrawn content or lost acceptance.');
    assert((await database.query('SELECT COUNT(*)::int AS n FROM research_analysis_snapshot_publications')).rows[0].n === 1
      && (await database.query('SELECT COUNT(*)::int AS n FROM private_r_executions')).rows[0].n === scientificCount
      && (await database.query('SELECT COUNT(*)::int AS n FROM jobs')).rows[0].n === jobCount, 'Sharing duplicated publication or ran additional science.');
    const storage = await page.evaluate(() => Object.values(localStorage).concat(Object.values(sessionStorage)).join('\n'));
    assert(!storage.includes(intent.requestId) && !storage.includes(originalA.requestId) && !storage.includes(findings.source)
      && !storage.includes('PRIVATE_UNSELECTED_CAPTURE_NOTE') && !storage.includes('PRIVATE_CAPTURE_PATH'), 'Scientific source, private recorded values or original sharing intent entered Web Storage.');
    if (linkedResults) assert(requests.filter(item => item.method === 'POST' && item.pathname === prepPath()).length === 1, 'The original v2 preparation was repeated after acceptance/restart.');
    check('A publisher downgraded to reader explicitly withdraws; a real committed lost reply recovers its original acceptance, older active colleague replies cannot restore content, last-reference bytes are released, and original publication replay never reactivates it or runs science.');
    if (sharedLinks) await require('./analysis-shared-links-ui.cjs').verifyWithdrawnSharedLink({ ...sharedLinkEvidence,
      browser, service, accounts, registerPage, capture, check, page });
    if (inertResults) {
      await require('./analysis-inert-sharing-ui.cjs').verifyInertSharing({ service, database, page, accounts, api, importFixture, login, restart,
        openAnalysis, openPublications, openPublic, prep, panel, detail, matrix, intercept, faults, faultPaths, expected, requests, check, until });
      assert((await database.query('SELECT COUNT(*)::int AS n FROM private_r_executions')).rows[0].n === scientificCount
        && (await database.query('SELECT COUNT(*)::int AS n FROM jobs')).rows[0].n === jobCount, 'Inert source sharing dispatched additional science.');
    }
    await Promise.all([...assetReads, ...failureReads]);
    const unexpected = consoleErrors.filter(entry => {
      let url; try { url = new URL(entry.url); } catch { return true; }
      const status = /status of (\d+)/.exec(entry.text)?.[1];
      if (status === '401' && url.pathname === '/api/auth/session' || status === '404' && url.pathname === '/api/r/session-id' || expected.has(`${status} ${url.pathname}${url.search}`) || expected.has(`${status} ${url.pathname}`)) return false;
      if (intentionalRuntimeResponses.some(value => String(value.status) === status && value.pathname === url.pathname && entry.at >= value.from)) return false;
      if (scopedReadDenials.some(value => {
        if (String(value.status) !== status || value.pathname !== url.pathname || entry.pageId !== value.pageId
            || entry.at < value.from || value.through === null || entry.at > value.through) return false;
        const observed = httpFailures.filter(item => item.pageId === value.pageId && item.pathname === value.pathname
          && item.status === value.status && item.at >= value.from && item.at <= value.through);
        return observed.length > 0 && observed.every(item => item.code === value.code);
      })) return false;
      return !(/^Failed to load resource: net::ERR_(?:FAILED|CONTENT_LENGTH_MISMATCH|EMPTY_RESPONSE|INCOMPLETE_CHUNKED_ENCODING|CONNECTION_CLOSED|CONNECTION_RESET)/.test(entry.text) && faultPaths.has(url.pathname));
    });
    assert(browserErrors.length === 0 && unexpected.length === 0, 'Unexpected production sharing browser errors occurred: ' + unexpected.map(value => value.text + ' ' + new URL(value.url).pathname).join('; '));
    check('All sharing journeys used frozen production assets, genuine authenticated accounts and real retained R outputs without unexpected browser errors, extra scientific execution or scientific browser persistence.');
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ passed: true, checks, screenshots, profiles, browserRestarts: restarts, compiledAssets, browserErrors, consoleErrors, requests, intentionalRuntimeResponses, scopedReadDenials, httpFailures,
      image: service.image, environment: service.environment.id, producerStopped: true, typedWorkerCompleted: typedFindings?.workerCompleted || false,
      ...(sharedLinks ? { sharedLink: sharedLinkEvidence } : {}),
      fixture: 'Disposable actual R kernel+managed serializers' + (typedFindings ? '+completed typed workflow worker' : '') + '/HTTPS/auth/PG/private storage; synthetic20genes12cells; '
        + (inertResults ? 'TXT/JSON source fixtures separately imported, not produced by the workflow; ' : '') + 'no general scientific correctness, SSH or reference-hardware claim.' }, null, 2));
    console.log('Analysis publication acceptance: ' + directory);
  } catch (error) {
    await (visibleTarget || page)?.screenshot({ path: path.join(directory, 'failure.png'), fullPage: true }).catch(() => {});
    const tree = await (visibleTarget || page)?.locator('main').ariaSnapshot().catch(() => null); if (tree) fs.writeFileSync(path.join(directory, 'failure-accessibility.txt'), tree);
    let message = error.message; for (const secret of [service?.databaseUrl, service?.storageRoot, service?.account.password, ...Object.values(accounts).map(value => value.email)].filter(Boolean)) message = message.split(secret).join('[private fixture]');
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ passed: false, checks, screenshots, compiledAssets, error: message, browserErrors, consoleErrors, requests, intentionalRuntimeResponses, scopedReadDenials, httpFailures }, null, 2)); throw new Error(message);
  } finally { for (const fault of faults) fault.release(); await browser?.close(); await database?.end(); await typedProducer?.stop(); await service?.stop(); }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
