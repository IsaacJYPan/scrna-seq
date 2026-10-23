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
const root = path.resolve(__dirname, '..');
const assert = (value, message) => { if (!value) throw new Error(message); };
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
async function until(test, message, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await test()) return; await new Promise(resolve => setTimeout(resolve, 75)); }
  throw new Error(message);
}
async function main() {
  const directory = path.join(root, 'playwright', 'report', 'analysis-publications-' + Date.now()); fs.mkdirSync(directory, { recursive: true });
  const frozen = new Map(fs.readdirSync(path.join(root, 'dist/assets')).map(name => [name, sha(fs.readFileSync(path.join(root, 'dist/assets', name)))]));
  const checks = [], screenshots = [], profiles = [], requests = [], browserErrors = [], consoleErrors = [], assetReads = [], faults = [], restarts = [];
  const compiledAssets = {}, accounts = {}, expected = new Set(), faultPaths = new Set();
  const check = message => { checks.push(message); console.log('PASS: ' + message); };
  let service, database, browser, page, study, findings;
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
  async function launch() {
    const leaf = new crypto.X509Certificate(fs.readFileSync(service.certificatePath));
    return chromium.launch({ headless: true, args: ['--host-resolver-rules=MAP ' + new URL(service.endpoint).hostname + ' 127.0.0.1',
      '--ignore-certificate-errors-spki-list=' + crypto.createHash('sha256').update(leaf.publicKey.export({ type: 'spki', format: 'der' })).digest('base64')] });
  }
  async function login(actor = 'owner') {
    const context = await browser.newContext({ viewport: { width: 1366, height: 768 } }); const target = await context.newPage();
    target.on('pageerror', error => browserErrors.push(error.message));
    target.on('console', value => { if (value.type() === 'error') consoleErrors.push({ text: value.text(), url: value.location().url }); });
    target.on('request', request => {
      const pathname = new URL(request.url()).pathname; if (!pathname.startsWith('/api/')) return;
      requests.push({ actor, method: request.method(), pathname, ...(request.method() === 'POST' && /\/snapshot-publications(?:\/aspub_[a-f0-9]{24}\/withdrawals)?$/.test(pathname) ? { input: request.postDataJSON() } : {}) });
    });
    target.on('response', response => {
      const pathname = new URL(response.url()).pathname;
      if (!response.ok() || !pathname.startsWith('/assets/') || !pathname.endsWith('.js')) return;
      assetReads.push((async () => { const actual = sha(await response.body()); compiledAssets[pathname] = actual; assert(frozen.get(pathname.split('/').at(-1)) === actual, 'Production assets changed during sharing acceptance.'); })().catch(error => browserErrors.push(error.message)));
    });
    await target.goto(service.endpoint); await target.getByPlaceholder('researcher@lab.edu').fill(accounts[actor].email);
    await target.getByLabel('Password', { exact: true }).fill(service.account.password); await target.getByRole('button', { name: /Open Workbench/ }).click();
    await target.getByText('Connection details', { exact: true }).waitFor(); return target;
  }
  async function nav(target, name) {
    const expand = target.getByRole('button', { name: 'Expand sidebar', exact: true }); if (await expand.isVisible()) await expand.click();
    await target.getByRole('button', { name, exact: typeof name === 'string' }).click();
  }
  async function openAnalysis(target) {
    await nav(target, /^Data workspace,/); await target.getByRole('button', { name: new RegExp('^' + escape(service.project.name) + '(?:$|\\s)') }).click();
    await nav(target, 'Analyses');
    if (await panel(target).isVisible()) await panel(target).getByRole('button', { name: /Back to (?:analysis|private preparation)/ }).click();
    if (await prep(target).isVisible()) await prep(target).getByRole('button', { name: 'Back to analysis', exact: true }).click();
    const all = target.getByRole('button', { name: 'All analyses', exact: true }); if (await all.isVisible()) await all.click();
    await target.getByRole('list', { name: 'Analysis list', exact: true }).getByRole('button', { name: new RegExp('^' + escape(study.name)) }).click();
    await target.getByRole('region', { name: 'Selected analysis', exact: true }).waitFor();
  }
  async function openPublications(target) { await openAnalysis(target); await target.getByRole('button', { name: 'Published snapshots', exact: true }).click(); await panel(target).waitFor(); }
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
    service = await createAnalysisSharingRuntimeFixture({ artifactDirectory: directory, configureProjectEnvironment: async ({ env, account, project }) => {
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
    database = new Client({ connectionString: service.databaseUrl }); await database.connect(); browser = await launch(); page = await login();
    findings = await produceSharingFindings((pathname, options) => api(page, pathname, options), service.project.id, service.environment);
    study = (await api(page, `/api/projects/${service.project.id}/analyses`, { method: 'POST', status: 201, body: { requestId: crypto.randomUUID(), name: 'Shared condition findings', description: 'Compare the two synthetic conditions without sharing a live session.' } })).analysis;
    const attached = [];
    for (const [version, caption] of [[findings.table, 'Six control and six treated cells'], [findings.figure, 'Computed condition counts figure']]) {
      attached.push((await api(page, analysisPath() + '/attachments', { method: 'POST', status: 201, body: { requestId: crypto.randomUUID(),
        reference: { kind: 'artifact-version', versionId: version.versionId, sha256: version.sha256 }, caption,
        suppliedOrigin: { origin: 'Explicitly saved synthetic R output; producing-source linkage is not established by this attachment.' } } })).acceptedRevision);
    }
    const { importScriptDocument } = await import('../shared/scriptDocument.mjs');
    const content = importScriptDocument({ filename: 'synthetic-conditions.R', bytes: Buffer.from(findings.source), cellId: 'conditions_r' });
    const saved = (await api(page, analysisPath() + '/documents', { method: 'POST', status: 201, body: { requestId: crypto.randomUUID(), title: 'Supplied condition method', content } })).document;
    const scientificCount = (await database.query('SELECT COUNT(*)::int AS n FROM private_r_executions')).rows[0].n;
    await openAnalysis(page); await page.getByRole('textbox', { name: 'Research question or notes', exact: true }).fill('An unsaved interpretation stays outside the published snapshot.');
    await page.getByRole('button', { name: 'Prepare sharing', exact: true }).click();
    const choices = prep(page).getByRole('form', { name: 'Prepare private snapshot', exact: true });
    for (const item of attached) {
      await choices.getByRole('region', { name: 'Choose retained findings', exact: true }).getByRole('listitem').filter({ has: page.getByText(item.caption, { exact: true }) }).getByRole('button', { name: /^(?:Add table excerpt|Add figure)$/ }).click();
    }
    await choices.getByRole('checkbox', { name: /Supplied condition method/ }).check(); await choices.getByRole('button', { name: 'Prepare private preview', exact: true }).click();
    await prep(page).getByRole('heading', { name: 'Ready for private review', exact: true }).waitFor();
    const candidate = (await api(page, prepPath())).items[0]; const originalA = await api(page, prepPath() + '/' + candidate.preparationId);
    const packageSha = originalA.snapshotSha256, physical = (await database.query('SELECT COUNT(*)::int AS n FROM research_analysis_snapshot_blobs WHERE preparation_id=$1', [candidate.preparationId])).rows[0].n;
    assert(physical === 3, 'The two computed findings and saved source were not independently retained.');
    await prep(page).getByRole('button', { name: 'Publish to project', exact: true }).click();
    const confirmation = panel(page).getByRole('region', { name: 'Confirm exact snapshot publication', exact: true });
    await confirmation.getByRole('button', { name: 'Publish to project', exact: true }).waitFor();
    await panel(page).getByRole('button', { name: 'Back to private preparation', exact: true }).click();
    await until(() => prep(page).getByRole('button', { name: 'Publish to project', exact: true }).evaluate(node => node === document.activeElement), 'Back from confirmation did not restore the private review action focus.');
    await prep(page).getByRole('button', { name: 'Back to analysis', exact: true }).click();
    assert(await page.getByRole('textbox', { name: 'Research question or notes', exact: true }).inputValue() === 'An unsaved interpretation stays outside the published snapshot.'
      && (await database.query('SELECT version FROM research_analyses WHERE id=$1', [study.id])).rows[0].version === 1,
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
    const held = service.interceptNextResponse({ method: 'POST', pathname: publicationPath(), mode: 'hold' }); faults.push(held);
    await recovery.getByRole('button', { name: 'Retry original publication', exact: true }).click(); await until(() => held.observation(), 'The genuine committed publication response was not held.');
    const accepted = held.observation().value, publicationId = accepted.acceptance.publicationId;
    assert(accepted.current.snapshotSha256 === packageSha && JSON.stringify(writes()[1].input) === JSON.stringify(intent), 'The explicit retry changed its recipe or was not really accepted.');
    await restart(); held.release(); await openPublications(page); await panel(page).getByRole('button', { name: 'Your sharing activity', exact: true }).click();
    await panel(page).getByRole('button', { name: 'Check accepted sharing action', exact: true }).click();
    await panel(page).getByRole('heading', { name: 'Publication accepted', exact: true }).waitFor();
    assert(writes().length === 2, 'Accepted private activity recovery published again after restart.');
    await matrix(page, 'sharing-original-acceptance-after-restart', () => panel(page).getByRole('region', { name: 'Accepted sharing action', exact: true }).scrollIntoViewIfNeeded());
    check('Explicit publication is bound to the reviewed snapshot SHA; pre-upstream failure permits only deliberate identical retry, and genuine accepted lost acknowledgement is rediscovered from actor-private activity after a real browser restart without another publication.');

    await findings.stop(); await service.stopCompute();
    assert((await database.query('SELECT status FROM private_r_kernels WHERE id=$1', [findings.kernel.id])).rows[0].status === 'stopped', 'The genuine producing kernel was not stopped.');
    for (const version of [findings.table, findings.figure]) {
      const row = (await database.query('SELECT storage_key FROM managed_artifact_versions WHERE id=$1', [version.versionId])).rows[0];
      const filename = path.resolve(service.storageRoot, ...row.storage_key.split('/')); assert(filename.startsWith(path.resolve(service.storageRoot) + path.sep), 'Source removal escaped the owned fixture.'); fs.unlinkSync(filename);
    }
    await openAnalysis(page); await page.getByRole('button', { name: 'Prepare sharing', exact: true }).click(); await prep(page).getByRole('button', { name: 'Saved preparations', exact: true }).click();
    await prep(page).getByRole('button', { name: 'Open private preparation', exact: true }).click(); await prep(page).getByRole('button', { name: 'Remove private preparation', exact: true }).click();
    await prep(page).getByRole('button', { name: 'Remove private preparation', exact: true }).click(); await prep(page).getByRole('heading', { name: 'Private preparation removed', exact: true }).waitFor();
    const tombstone = await api(page, prepPath() + '/' + candidate.preparationId);
    assert(tombstone.recipe === null && tombstone.package === null && (await database.query('SELECT COUNT(*)::int AS n FROM research_analysis_snapshot_blobs WHERE preparation_id=$1', [candidate.preparationId])).rows[0].n === physical, 'Private deletion erased shared bytes or kept private payload authority.');
    await api(page, analysisPath(), { method: 'PATCH', body: { expectedVersion: 1, description: 'A later saved interpretation must not change the published findings.' } });
    const newer = structuredClone(content); newer.cells[0].source = 'stop("A later method is separate from the retained source")\n';
    await api(page, `${analysisPath()}/documents/${saved.id}`, { method: 'PUT', body: { requestId: crypto.randomUUID(), expectedVersion: saved.version, title: saved.title, content: newer } });
    const colleague = await login('colleague'); await openPublications(colleague); await openPublic(colleague);
    await detail(colleague).getByRole('cell', { name: 'control', exact: true }).waitFor(); await detail(colleague).getByRole('cell', { name: 'treated', exact: true }).waitFor();
    await matrix(colleague, 'sharing-colleague-fixed-counts-producer-stopped', () => detail(colleague).getByRole('table').scrollIntoViewIfNeeded());
    await detail(colleague).getByRole('list', { name: 'Retained finding selection', exact: true }).getByRole('button').filter({ hasText: attached[1].caption }).click();
    const image = detail(colleague).getByRole('img', { name: /Computed condition figure/ }); await until(async () => await image.count() && await image.evaluate(node => node.complete && node.naturalWidth > 0), 'The genuine retained R figure did not decode for the colleague.');
    await matrix(colleague, 'sharing-colleague-real-r-figure-producer-stopped', () => image.scrollIntoViewIfNeeded());
    const source = detail(colleague).getByRole('region', { name: 'Prepared supporting source', exact: true }); await source.getByRole('button', { name: 'View supporting source', exact: true }).click();
    await source.getByText('Saved supporting source checksum verified', { exact: true }).waitFor(); assert((await source.locator('pre[aria-label="Retained saved source"]').textContent()).includes('set.seed(1919)'), 'The colleague saw a newer or incorrect supporting source.');
    await matrix(colleague, 'sharing-colleague-exact-supporting-source', () => source.scrollIntoViewIfNeeded());
    const publicValue = await api(colleague, `${publicationPath()}/${publicationId}`), publicList = await api(colleague, publicationPath());
    assert(publicValue.snapshotSha256 === packageSha && publicValue.package.analysis.version === 1 && !JSON.stringify(publicList).includes(intent.requestId), 'Public discovery leaked a private UUID or advanced the retained snapshot.');
    await api(colleague, `${prepPath()}/requests/${originalA.requestId}`, { status: 404 }); await api(colleague, `${publicationPath()}/requests/${intent.requestId}`, { status: 404 });
    await api(colleague, `/api/artifact-versions/${service.project.id}/${findings.table.versionId}`, { status: 404 });
    await api(colleague, `/api/private-r-kernels/${service.project.id}/${findings.kernel.id}/executions/${findings.executionId}`, { status: 404 });
    assert(!(await detail(colleague).getByRole('button', { name: 'Withdraw from project', exact: true }).count()), 'An unrelated current reader gained withdrawal authority.');
    check('A real colleague inspects actual R-produced CSV, PNG and exact saved supporting source after the producer kernel and broker stop, original files are removed, private preparation is deleted and live heads advance. Private sources, original action UUIDs and execution history remain denied.');

    const heldRead = service.interceptNextResponse({ method: 'GET', pathname: `${publicationPath()}/${publicationId}`, mode: 'hold' }); faults.push(heldRead);
    await detail(colleague).getByRole('button', { name: 'Check current snapshot access', exact: true }).click(); await until(() => heldRead.observation(), 'The genuine authorized colleague read was not held.');
    await database.query('DELETE FROM project_members WHERE project_id=$1 AND user_id=$2', [service.project.id, accounts.colleague.id]); expected.add(`404 ${publicationPath()}?limit=30`);
    await refresh(colleague); await until(async () => !(await detail(colleague).getByRole('heading', { name: 'Published to this project', exact: true }).count()), 'Membership revocation retained protected publication content.');
    heldRead.release(); await colleague.waitForTimeout(200); assert(!(await detail(colleague).getByText(attached[1].caption, { exact: true }).count()), 'An older held success restored publication content after scope denial.');
    await matrix(colleague, 'sharing-colleague-revoked-held-response-fenced', () => panel(colleague).scrollIntoViewIfNeeded());
    await database.query("INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,'viewer')", [service.project.id, accounts.colleague.id]); await refresh(colleague); await openPublic(colleague);
    check('Actual reader membership revocation clears protected publication content and fences a previously authorized held reply; explicit restored access opens the original retained identity.');
    const broken = publicValue.package.results[1];
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
    const older = service.interceptNextResponse({ method: 'GET', pathname: `${publicationPath()}/${publicationId}`, mode: 'hold' }); faults.push(older);
    await detail(reader).getByRole('button', { name: 'Check current snapshot access', exact: true }).click(); await until(() => older.observation(), 'The pre-withdrawal read was not genuinely authorized and held.');
    await detail(page).getByRole('button', { name: 'Withdraw from project', exact: true }).click();
    const confirmationWithdraw = panel(page).getByRole('region', { name: 'Confirm snapshot withdrawal', exact: true }); await matrix(page, 'sharing-reader-publisher-withdrawal-confirmation', () => confirmationWithdraw.scrollIntoViewIfNeeded());
    const drop = service.interceptNextResponse({ method: 'POST', pathname: `${publicationPath()}/${publicationId}/withdrawals`, mode: 'drop' }); faults.push(drop); faultPaths.add(`${publicationPath()}/${publicationId}/withdrawals`);
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
      && (await database.query('SELECT COUNT(*)::int AS n FROM jobs')).rows[0].n === 0, 'Sharing duplicated publication or ran additional science.');
    const storage = await page.evaluate(() => Object.values(localStorage).concat(Object.values(sessionStorage)).join('\n'));
    assert(!storage.includes(intent.requestId) && !storage.includes(findings.source), 'Scientific source or original sharing intent entered Web Storage.');
    check('A publisher downgraded to reader explicitly withdraws; a real committed lost reply recovers its original acceptance, older active colleague replies cannot restore content, last-reference bytes are released, and original publication replay never reactivates it or runs science.');
    await Promise.all(assetReads);
    const unexpected = consoleErrors.filter(entry => {
      let url; try { url = new URL(entry.url); } catch { return true; }
      const status = /status of (\d+)/.exec(entry.text)?.[1];
      if (status === '401' && url.pathname === '/api/auth/session' || status === '404' && url.pathname === '/api/r/session-id' || expected.has(`${status} ${url.pathname}${url.search}`) || expected.has(`${status} ${url.pathname}`)) return false;
      return !(/^Failed to load resource: net::ERR_(?:FAILED|CONTENT_LENGTH_MISMATCH|EMPTY_RESPONSE|INCOMPLETE_CHUNKED_ENCODING|CONNECTION_CLOSED|CONNECTION_RESET)/.test(entry.text) && faultPaths.has(url.pathname));
    });
    assert(browserErrors.length === 0 && unexpected.length === 0, 'Unexpected production sharing browser errors occurred.');
    check('All sharing journeys used frozen production assets, genuine authenticated accounts and real retained R outputs without unexpected browser errors, extra scientific execution or scientific browser persistence.');
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ passed: true, checks, screenshots, profiles, browserRestarts: restarts, compiledAssets, browserErrors, consoleErrors, requests,
      image: service.image, environment: service.environment.id, producerStopped: true, fixture: 'Disposable actual R kernel+managed serializers/HTTPS/auth/PG/private storage; synthetic20genes12cells; no general scientific correctness, SSH or reference-hardware claim.' }, null, 2));
    console.log('Analysis publication acceptance: ' + directory);
  } catch (error) {
    await page?.screenshot({ path: path.join(directory, 'failure.png'), fullPage: true }).catch(() => {});
    const tree = await page?.locator('main').ariaSnapshot().catch(() => null); if (tree) fs.writeFileSync(path.join(directory, 'failure-accessibility.txt'), tree);
    let message = error.message; for (const secret of [service?.databaseUrl, service?.storageRoot, service?.account.password, ...Object.values(accounts).map(value => value.email)].filter(Boolean)) message = message.split(secret).join('[private fixture]');
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ passed: false, checks, screenshots, error: message, browserErrors, consoleErrors, requests }, null, 2)); throw new Error(message);
  } finally { for (const fault of faults) fault.release(); await browser?.close(); await database?.end(); await service?.stop(); }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
