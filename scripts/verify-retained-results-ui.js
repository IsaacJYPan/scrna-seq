#!/usr/bin/env node
'use strict';

const { waitFor } = require('./browser-helpers');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require('playwright');
const { Client } = require('pg');
const { createDesktopTunnelServiceFixture } = require('./desktop-tunnel-service-fixture.cjs');
const root = path.resolve(__dirname, '..');
const assert = (value, message) => { if (!value) throw new Error(message); };
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const prefix = value => new RegExp('^' + value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));


async function main() {
  const directory = path.join(root, 'playwright', 'report', 'retained-results-' + Date.now());
  fs.mkdirSync(directory, { recursive: true });
  const inputs = path.join(directory, 'inputs'); fs.mkdirSync(inputs);
  const files = {
    csv: path.join(inputs, 'donor-scores.csv'), revised: path.join(inputs, 'revised.csv'),
    text: path.join(inputs, 'notes.txt'), image: path.join(inputs, 'figure.png'), opaque: path.join(inputs, 'opaque.bin'),
  };
  fs.writeFileSync(files.csv, 'gene,score\n' + Array.from({ length: 30 }, (_, index) => `Gene${index + 1},${index + 1}`).join('\n') + '\n');
  fs.writeFileSync(files.revised, 'gene,score\nGene1,99\n');
  fs.writeFileSync(files.text, '<script>window.retainedTextExecuted = true</script>\nA retained interpretation, shown as inert text.\n');
  fs.writeFileSync(files.image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGOQS7nzHwAEYAJeiHDUBAAAAABJRU5ErkJggg==', 'base64'));
  fs.writeFileSync(files.opaque, 'Opaque fixture bytes. This is not a serialized scientific object.\n');
  const checks = [], screenshots = [], errors = [], requests = [], compiledAssets = {}, themes = {}, versions = [];
  const check = message => { checks.push(message); console.log('PASS: ' + message); };
  let service, database, browser, page, ownerId, otherProject;
  const inspector = () => page.getByRole('region', { name: 'Artifact versions', exact: true });
  const viewer = () => inspector().getByRole('region', { name: 'Retained result', exact: true });
  async function capture(name, expectedTheme) {
    const theme = await page.evaluate(() => document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light');
    if (expectedTheme) assert(theme === expectedTheme, 'The actual rendered theme differs from its screenshot label.');
    themes[name] = { theme, viewport: page.viewportSize() };
    const filename = name + '.png'; await page.screenshot({ path: path.join(directory, filename), fullPage: true }); screenshots.push(filename);
  }
  async function nav(name) {
    const expand = page.getByRole('button', { name: 'Expand sidebar', exact: true });
    if (await expand.isVisible()) await expand.click();
    await page.getByRole('button', { name, exact: typeof name === 'string' }).click();
  }
  async function openProject(project) {
    await nav(/^Data workspace,/); await page.getByRole('button', { name: prefix(project.name) }).click();
    await nav('Runs & Results'); await page.getByText('Inspect or import artifact files', { exact: true }).click();
    await inspector().getByRole('heading', { name: 'Artifact versions', exact: true }).waitFor();
  }
  async function select(name, number = 1) {
    await inspector().getByRole('button', { name: prefix(name + ' · v' + number) }).click();
    await viewer().getByRole('heading', { name: name + ' · v' + number, exact: true }).waitFor();
  }
  async function importFile(filename, name, replacement = false) {
    const form = inspector().getByRole('form', { name: 'Import artifact version', exact: true });
    await form.getByLabel('Artifact file', { exact: true }).setInputFiles(filename);
    await form.getByLabel('Artifact name', { exact: true }).fill(name);
    if (replacement) await form.getByRole('checkbox', { name: 'New version of selected artifact', exact: true }).check();
    const response = page.waitForResponse(value => new URL(value.url()).pathname.startsWith('/api/artifact-versions/' + service.project.id)
      && value.request().method() === 'POST');
    await form.getByRole('button', { name: replacement ? 'Save new artifact version' : 'Import artifact', exact: true }).click();
    const result = await response; assert(result.status() === 201, 'A real UI artifact import failed.');
    const version = await result.json(); versions.push(version);
    assert(version.sha256 === sha256(fs.readFileSync(filename)), 'Imported metadata does not match the actual uploaded bytes.');
    await viewer().getByRole('heading', { name: name + ' · v' + version.versionNumber, exact: true }).waitFor();
    return version;
  }
  async function setTheme(theme) {
    if (await page.evaluate(() => document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light') === theme) return;
    const toggle = page.getByRole('button', { name: 'Switch to ' + theme + ' mode', exact: true });
    let opened = false;
    if (!(await toggle.isVisible())) { await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click(); opened = true; }
    await toggle.click();
    await waitFor(async () => (await page.evaluate(() => document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light')) === theme, 'The rendered theme did not change.');
    if (opened) { await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click(); }
  }
  try {
    service = await createDesktopTunnelServiceFixture({ artifactDirectory: directory,
      configureProjectEnvironment: async ({ env, project, account }) => {
        const seed = new Client({ connectionString: env.DATABASE_URL }); await seed.connect();
        try {
          const owner = (await seed.query('SELECT * FROM users WHERE email=$1', [account.email])).rows[0]; ownerId = Number(owner.id);
          const row = (await seed.query('SELECT * FROM projects WHERE id=$1', [project.id])).rows[0];
          const colleague = (await seed.query('INSERT INTO users(email,password_hash,salt,display_name) VALUES($1,$2,$3,$4) RETURNING id',
            ['retained-' + crypto.randomBytes(8).toString('hex') + '@example.invalid', owner.password_hash, owner.salt, 'Fixture colleague'])).rows[0];
          await seed.query("INSERT INTO organization_members(organization_id,user_id,role) VALUES($1,$2,'member')", [row.organization_id, colleague.id]);
          await seed.query("INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,'owner')", [project.id, colleague.id]);
          otherProject = { id: 'proj_' + crypto.randomBytes(12).toString('hex'), name: 'Unrelated retained project' };
          await seed.query('INSERT INTO projects(id,organization_id,name,created_by_user_id) VALUES($1,$2,$3,$4)', [otherProject.id, row.organization_id, otherProject.name, owner.id]);
          await seed.query("INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,'owner')", [otherProject.id, owner.id]);
        } finally { await seed.end(); }
        return {};
      } });
    database = new Client({ connectionString: service.databaseUrl }); await database.connect();
    const leaf = new crypto.X509Certificate(fs.readFileSync(service.certificatePath));
    const authority = new crypto.X509Certificate(fs.readFileSync(service.caCertificatePath));
    assert(leaf.verify(authority.publicKey) && leaf.checkHost(new URL(service.endpoint).hostname), 'The disposable HTTPS identity could not be verified.');
    const spki = crypto.createHash('sha256').update(leaf.publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
    browser = await chromium.launch({ headless: true, args: ['--host-resolver-rules=MAP ' + new URL(service.endpoint).hostname + ' 127.0.0.1', '--ignore-certificate-errors-spki-list=' + spki] });
    page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => requests.push({ method: request.method(), pathname: new URL(request.url()).pathname }));
    page.on('response', async response => {
      const pathname = new URL(response.url()).pathname;
      if (/^\/assets\/.*\.js$/.test(pathname) && response.ok()) { try { compiledAssets[pathname] = sha256(await response.body()); } catch { /* A failed asset also raises a browser error. */ } }
    });
    await page.goto(service.endpoint); await page.getByPlaceholder('researcher@lab.edu').fill(service.account.email);
    await page.getByLabel('Password', { exact: true }).fill(service.account.password); await page.getByRole('button', { name: /Open Workbench/ }).click();
    await page.getByText('Connection details', { exact: true }).waitFor(); await openProject(service.project);
    const csv = await importFile(files.csv, 'Donor scores');
    await viewer().getByRole('columnheader', { name: 'gene' }).waitFor();
    const next = viewer().getByRole('button', { name: 'Next rows', exact: true }); await next.focus(); await page.keyboard.press('Enter');
    await viewer().getByText('Rows 26–30', { exact: true }).waitFor();
    await viewer().getByRole('button', { name: 'Previous rows', exact: true }).click(); await viewer().getByText('Rows 1–25', { exact: true }).waitFor();
    check('Real UI imports retain exact checksums; bounded table pages and keyboard paging use authorized saved bytes.');
    const revised = await importFile(files.revised, 'Donor scores', true);
    assert(revised.artifactId === csv.artifactId && revised.versionNumber === 2 && revised.versionId !== csv.versionId, 'Replacement did not create an immutable second version.');
    await select('Donor scores', 1); await viewer().getByRole('cell', { name: 'Gene1', exact: true }).waitFor();
    assert(await viewer().getByRole('cell', { name: '1', exact: true }).count() === 1, 'Opening the original version returned replacement contents.');
    check('Managed replacement creates a second version and the original table remains inspectable unchanged.');
    await importFile(files.text, 'Inert notes'); await viewer().getByText(/window.retainedTextExecuted = true/).waitFor();
    assert(await page.evaluate(() => window.retainedTextExecuted === undefined), 'Retained text executed as a script.'); await capture('retained-inert-text');
    const image = await importFile(files.image, 'Retained raster');
    await waitFor(async () => viewer().getByRole('img').evaluate(element => element.complete && element.naturalWidth === 1), 'The actual saved PNG could not be displayed.');
    assert((await viewer().getByRole('img').getAttribute('src')).startsWith('blob:'), 'The image bypassed fenced verified Blob delivery.'); await capture('retained-verified-image');
    await importFile(files.opaque, 'Opaque saved file'); await viewer().getByText(/contents have not been read or verified/).waitFor();
    assert(await viewer().getByText(/Saved checksum verified/).count() === 0, 'Opaque metadata falsely claimed byte inspection.'); await capture('retained-opaque-fallback');
    check('Text is inert, real PNG bytes render only through a verified Blob, and opaque files use honest metadata-only fallback.');
    await select('Donor scores'); await viewer().getByRole('table').waitFor();
    for (const viewport of [{ width: 1366, height: 768 }, { width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      for (const theme of ['light', 'dark']) {
        await setTheme(theme);
        await viewer().locator('[aria-label="Saved table preview"]').evaluate(element => element.scrollIntoView({ block: 'center', inline: 'nearest' }));
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'The retained view overflows its viewport.');
        await capture(`retained-${theme}-${viewport.width}x${viewport.height}`, theme);
      }
    }
    await page.setViewportSize({ width: 1366, height: 768 }); await setTheme('light');
    const imageRow = (await database.query('SELECT storage_key FROM managed_artifact_versions WHERE id=$1', [image.versionId])).rows[0];
    const storedImage = path.resolve(service.storageRoot, ...imageRow.storage_key.split('/'));
    assert(storedImage.startsWith(path.resolve(service.storageRoot) + path.sep), 'The fixture corruption target escaped its owned storage.');
    fs.writeFileSync(storedImage, 'Owned fixture corruption used only to test integrity denial.');
    await select('Retained raster'); await viewer().getByRole('alert').filter({ hasText: 'could not be verified' }).waitFor();
    assert(await viewer().getByRole('img').count() === 0, 'The corrupted raster still has a displayed image.'); await capture('retained-integrity-denial');
    fs.copyFileSync(files.image, storedImage); await viewer().getByRole('button', { name: 'Retry saved result', exact: true }).click();
    await waitFor(async () => viewer().getByRole('img').evaluate(element => element.complete && element.naturalWidth === 1), 'Restored exact bytes could not be reopened.');
    check('Actual managed-storage corruption denies the preview; restoring exact bytes permits explicit retry without computation.');
    const held = service.interceptNextResponse({ method: 'GET', pathname: `/api/artifact-versions/${service.project.id}/${csv.versionId}`, mode: 'hold' });
    const oldRead = page.waitForRequest(request => new URL(request.url()).pathname === `/api/artifact-versions/${service.project.id}/${csv.versionId}` && request.method() === 'GET');
    await inspector().getByRole('button', { name: prefix('Donor scores · v1') }).click();
    const pendingRead = await oldRead;
    await waitFor(() => Boolean(held.observation()), 'The exact old-project metadata reply was not held.');
    await openProject(otherProject); held.release();
    const reply = await pendingRead.response(); if (reply) await reply.finished();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert(await inspector().getByRole('region', { name: 'Retained result' }).count() === 0, 'A late reply populated a different project.');
    await openProject(service.project); await select('Retained raster'); await viewer().getByRole('img').waitFor();
    await database.query('DELETE FROM project_members WHERE project_id=$1 AND user_id=$2', [service.project.id, ownerId]);
    await inspector().getByRole('button', { name: prefix('Retained raster · v1') }).click();
    await viewer().getByRole('alert').filter({ hasText: 'access is restricted' }).waitFor();
    assert(await viewer().getByRole('img').count() === 0 && await viewer().getByRole('heading').count() === 0, 'Revoked access retained source details or bytes.'); await capture('retained-access-revoked');
    check('An actual held reply cannot cross project boundaries; actual membership revocation clears selected source details and bytes.');
    const science = requests.filter(value => value.method === 'POST' && (/^\/api\/r\//.test(value.pathname) || /^\/api\/private-r-kernels\//.test(value.pathname) || /^\/api\/projects\/[^/]+\/jobs$/.test(value.pathname)));
    assert(science.length === 0 && Number((await database.query('SELECT count(*) AS count FROM private_r_kernels')).rows[0].count) === 0, 'Retained inspection started scientific execution.');
    assert(errors.length === 0, 'The application raised an uncaught browser error.');
    const report = { passed: true, checks, screenshots, themes, compiledAssets, browserErrors: errors, scientificDispatchCount: science.length,
      versions: versions.map(value => ({ versionId: value.versionId, sha256: value.sha256, sizeBytes: value.sizeBytes })),
      fixture: 'Own disposable production HTTPS/auth/PostgreSQL/storage; real UI file imports; scientific runtimes remain off',
      exclusions: ['kernel execution', 'SSH', 'metrics/embedding typed previews', 'researcher usability observation'] };
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(report, null, 2) + '\n'); console.log('Retained result UI acceptance passed; report: ' + directory);
    return report;
  } catch (error) {
    await page?.screenshot({ path: path.join(directory, 'failure.png'), fullPage: true }).catch(() => {});
    let message = error.message;
    for (const secret of [service?.databaseUrl, service?.account?.password, service?.account?.email, service?.storageRoot].filter(Boolean)) message = message.split(secret).join('[private fixture]');
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ passed: false, error: message, checks, screenshots, themes, compiledAssets, browserErrors: errors }, null, 2) + '\n');
    throw new Error(message);
  } finally { await browser?.close(); await database?.end(); await service?.stop(); }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
