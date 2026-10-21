#!/usr/bin/env node
'use strict';

const { waitFor, unusedPort: freePort } = require('./browser-helpers');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require('playwright');
const { Client } = require('pg');
const { createDesktopTunnelServiceFixture } = require('./desktop-tunnel-service-fixture.cjs');
const { prepareRetainedTypedFixture } = require('./retained-typed-ui-fixture.cjs');
const root = path.resolve(__dirname, '..');
const assert = (value, message) => { if (!value) throw new Error(message); };
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');



async function main() {
  const image = process.env.EXPERT_R_SANDBOX_IMAGE;
  const checkpoint = path.resolve(process.env.RETAINED_PBMC_CHECKPOINT || path.join(root, 'scratch/guided-demo-local-1791760118078/pbmc-template/checkpoint.rds'));
  const directory = path.join(root, 'playwright/report', 'retained-typed-' + Date.now()); fs.mkdirSync(directory, { recursive: true });
  const port = await freePort(), brokerToken = crypto.randomBytes(32).toString('hex');
  const checks = [], screenshots = [], themes = {}, errors = [], requests = [], assets = {}, responses = [], imageResponses = [], uiMeasurements = {};
  let service, database, browser, page, broker, material, ownerId;
  const check = message => { checks.push(message); console.log('PASS: ' + message); };
  const inspector = () => page.getByRole('region', { name: 'Artifact versions', exact: true });
  const viewer = () => inspector().getByRole('region', { name: 'Retained result', exact: true });
  async function nav(name) {
    const expand = page.getByRole('button', { name: 'Expand sidebar', exact: true }); if (await expand.isVisible()) await expand.click();
    await page.getByRole('button', { name, exact: typeof name === 'string' }).click();
  }
  async function capture(name, expectedTheme) {
    const theme = await page.evaluate(() => document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
    if (expectedTheme) assert(theme === expectedTheme, 'A screenshot theme did not match the actual document theme.');
    themes[name] = { theme, viewport: page.viewportSize() };
    const filename = name + '.png'; await page.screenshot({ path: path.join(directory, filename), fullPage: true }); screenshots.push(filename);
  }
  async function setTheme(theme) {
    if (await page.evaluate(() => document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light') === theme) return;
    const toggle = page.getByRole('button', { name: 'Switch to ' + theme + ' mode', exact: true }); let opened = false;
    if (!await toggle.isVisible()) { await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click(); opened = true; }
    await toggle.click(); await waitFor(async () => await page.evaluate(() => document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light') === theme, 'The actual theme did not change.');
    if (opened) await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
  }
  async function openInspector() { await nav('Runs & Results'); await page.getByText('Inspect or import artifact files', { exact: true }).click(); await inspector().getByRole('heading', { name: 'Artifact versions', exact: true }).waitFor(); }
  async function select(output) { await inspector().getByRole('button').filter({ hasText: output.id }).click(); await viewer().getByText('Saved checksum verified · preview from this exact version', { exact: true }).waitFor(); }
  const graph = scope => scope.locator('.js-plotly-plot');
  async function chartReady(scope) {
    await graph(scope).scrollIntoViewIfNeeded();
    await waitFor(async () => {
      const state = await graph(scope).evaluate(element => {
      if (!element._fullLayout || !element._fullData?.length) return false;
      // Plotly briefly exposes default layout ranges while a new react/resize
      // is still calculating. Source arrays alone do not certify a ready plot.
      return Object.fromEntries(['x', 'y'].map(axis => {
        const values = element.data.flatMap(trace => Array.from(trace[axis] || [])), range = element._fullLayout[axis + 'axis'].range;
        return [axis, { count: values.length, minimum: Math.min(...values), maximum: Math.max(...values), range, auto: element._fullLayout[axis + 'axis'].autorange,
          ticks: Array.from(element.querySelectorAll('.' + axis + 'tick text')).map(text => text.textContent) }];
      }));
    }).catch(() => false);
      uiMeasurements.readyProbe = state;
      return state && ['x', 'y'].every(axis => state[axis].count && state[axis].range?.length === 2 && state[axis].range[0] <= state[axis].minimum && state[axis].range[1] >= state[axis].maximum);
    }, 'The real retained Plotly figure did not finish calculating its source coordinate ranges.');
  }
  try {
    service = await createDesktopTunnelServiceFixture({ artifactDirectory: directory,
      webEnvironment: { EXPERT_R_ENABLED: 'true', EXPERT_R_ACCESS_POLICY: 'project-roles', EXPERT_R_SANDBOX_URL: `http://127.0.0.1:${port}`, EXPERT_R_SANDBOX_TOKEN: brokerToken },
      configureProjectEnvironment: async ({ env, project, account }) => {
        const seed = new Client({ connectionString: env.DATABASE_URL }); await seed.connect();
        try { ownerId = Number((await seed.query('SELECT id FROM users WHERE email=$1', [account.email])).rows[0].id);
          await seed.query("INSERT INTO users(email,password_hash,salt,display_name) SELECT $1,password_hash,salt,'Other retained owner' FROM users WHERE id=$2", ['retained-other-' + crypto.randomBytes(6).toString('hex') + '@example.invalid', ownerId]);
          const other = (await seed.query("SELECT id FROM users WHERE display_name='Other retained owner'")).rows[0];
          await seed.query("INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,'owner')", [project.id, other.id]);
        } finally { await seed.end(); }
        return {};
      } });
    database = new Client({ connectionString: service.databaseUrl }); await database.connect();
    material = await prepareRetainedTypedFixture({ database, service, ownerId, directory, image, checkpoint });
    broker = require('../backend/expertSandboxBroker').createExpertSandboxBroker({ ...process.env, NODE_ENV: 'test', EXPERT_R_SANDBOX_TOKEN: brokerToken,
      EXPERT_R_SANDBOX_IMAGE: image, EXPERT_R_SANDBOX_WORK_ROOT: path.join(directory, 'broker-work') });
    await broker.startReconciliation(); await new Promise(resolve => broker.listen(port, '127.0.0.1', resolve));
    const capability = await fetch(`http://127.0.0.1:${port}/capabilities`, { headers: { Authorization: 'Bearer ' + brokerToken } }).then(response => response.json());
    assert(capability.status === 'ok', 'The actual cached runtime capability probe failed.');
    const certificate = new crypto.X509Certificate(fs.readFileSync(service.certificatePath)), authority = new crypto.X509Certificate(fs.readFileSync(service.caCertificatePath));
    assert(certificate.verify(authority.publicKey) && certificate.checkHost(new URL(service.endpoint).hostname), 'The disposable HTTPS identity did not verify.');
    const spki = crypto.createHash('sha256').update(certificate.publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
    browser = await chromium.launch({ headless: true, args: ['--host-resolver-rules=MAP ' + new URL(service.endpoint).hostname + ' 127.0.0.1', '--ignore-certificate-errors-spki-list=' + spki] });
    page = await browser.newPage({ viewport: { width: 1366, height: 768 }, acceptDownloads: true });
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => requests.push({ method: request.method(), path: new URL(request.url()).pathname }));
    page.on('response', async response => {
      const pathname = new URL(response.url()).pathname;
      if (/^\/assets\/.*\.js$/.test(pathname) && response.ok()) { try { assets[pathname] = sha(await response.body()); } catch { /* Checked through browser errors. */ } }
      if (/\/preview$/.test(pathname) && response.ok()) { try { const body = await response.body(); const parsed = JSON.parse(body); responses.push({ path: pathname, bytes: body.length, sha256: parsed.preview.source?.sha256, sampling: parsed.preview.sampling, semantics: parsed.preview.semantics,
        metricDescriptors: parsed.preview.items?.map(({ key, label, unit }) => ({ key, label, unit })) }); } catch { /* Navigation can cancel a body. */ } }
      if (/\/image$/.test(pathname) && response.ok()) { try { const body = await response.body(); imageResponses.push({ path: pathname, sha256: sha(body), sizeBytes: body.length }); } catch { /* Navigation can cancel a body. */ } }
    });
    await page.goto(service.endpoint); await page.getByPlaceholder('researcher@lab.edu').fill(service.account.email); await page.getByLabel('Password', { exact: true }).fill(service.account.password); await page.getByRole('button', { name: /Open Workbench/ }).click();
    await page.getByText('Connection details', { exact: true }).waitFor(); await nav(/^Data workspace,/); await page.getByRole('button', { name: new RegExp('^' + service.project.name) }).click();
    await openInspector(); await select(material.outputs.metrics);
    await viewer().getByText('2638', { exact: true }).waitFor(); await viewer().getByText('13714', { exact: true }).waitFor();
    await viewer().getByText('Diagnostic', { exact: true }).waitFor(); await viewer().getByRole('heading', { name: 'PBMC3k retained dataset summary', exact: true }).waitFor();
    await viewer().getByText('Retained cells (cells)', { exact: true }).waitFor(); await viewer().getByText('Measured features (features)', { exact: true }).waitFor();
    await capture('measured-pbmc-metrics'); check('Actual measured PBMC3k scalar counts render from authorized exact retained bytes without a kernel.');
    for (const viewport of [{ width: 1366, height: 768 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      for (const theme of ['light', 'dark']) { await setTheme(theme); await viewer().getByLabel('Declared result meaning').scrollIntoViewIfNeeded();
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Declared metric meaning overflows the viewport.');
        await capture(`declared-metrics-${theme}-${viewport.width}`, theme);
      }
    }
    await page.setViewportSize({ width: 1366, height: 768 }); await setTheme('light');
    await select(material.outputs.embedding); await chartReady(viewer()); await viewer().getByText('Showing 2,000 of 2,638 source points.', { exact: true }).waitFor();
    await viewer().getByText('Primary result', { exact: true }).waitFor(); await viewer().getByRole('heading', { name: 'PBMC3k cell UMAP', exact: true }).waitFor();
    await viewer().getByText(/Points represent cells/).waitFor();
    assert(await graph(viewer()).evaluate(element => element._fullLayout.xaxis.title.text === 'UMAP 1' && element._fullLayout.yaxis.title.text === 'UMAP 2'), 'Declared saved UMAP axes did not reach the actual chart.');
    const retainedGraph = await graph(viewer()).elementHandle();
    const sameGraph = async () => graph(viewer()).evaluate((element, original) => element === original && original.isConnected, retainedGraph);
    assert(await graph(viewer()).evaluate(element => element._fullData.every(trace => trace.type === 'scatter')), 'The bounded chart did not use its SVG renderer.');
    const displayed = await graph(viewer()).evaluate(element => element.data.flatMap(trace => trace.text));
    const source = JSON.parse(fs.readFileSync(path.join(directory, 'measured-pbmc/embedding.json'), 'utf8'));
    assert(displayed.length === 2000 && displayed.every(value => source.ids.includes(value)), 'The figure invented or changed source identifiers.');
    await graph(viewer()).scrollIntoViewIfNeeded(); const point = graph(viewer()).locator('.scatterlayer .point').first(); const bounds = await point.boundingBox();
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await graph(viewer()).locator('.hoverlayer .hovertext').waitFor(); await capture('measured-pbmc-hover');
    const reset = viewer().getByRole('button', { name: 'Reset plot view', exact: true });
    await chartReady(viewer());
    const chartState = () => graph(viewer()).evaluate(element => ({ range: [...element._fullLayout.xaxis.range], yRange: [...element._fullLayout.yaxis.range], width: element._fullLayout.width, height: element._fullLayout.height, revision: element.layout.uirevision, autorange: element._fullLayout.xaxis.autorange }));
    uiMeasurements.beforeZoom = await chartState(); const baselineRange = uiMeasurements.beforeZoom.range;
    const sameRange = range => range.every((value, index) => Math.abs(value - baselineRange[index]) <= 1e-8 * Math.max(1, Math.abs(baselineRange[index])));
    await graph(viewer()).locator('.modebar-btn[data-title="Zoom in"]').click();
    await waitFor(async () => JSON.stringify(await graph(viewer()).evaluate(element => element._fullLayout.xaxis.range)) !== JSON.stringify(baselineRange), 'Actual plot zoom did not change the view.');
    uiMeasurements.afterZoom = await chartState();
    await reset.focus(); await page.keyboard.press('Enter');
    await waitFor(async () => { uiMeasurements.afterReset = await chartState(); return uiMeasurements.afterReset.autorange === true && sameRange(uiMeasurements.afterReset.range); }, 'The keyboard reset did not restore the retained view.');
    uiMeasurements.sameGraphAfterReset = await sameGraph(); assert(uiMeasurements.sameGraphAfterReset, 'Reset replaced the initialized retained graph.');
    const download = page.waitForEvent('download'); await viewer().getByRole('button', { name: 'Export plot PNG', exact: true }).focus(); await page.keyboard.press('Enter');
    const exported = await download, exportPath = path.join(directory, 'retained-pbmc-export.png'); await exported.saveAs(exportPath);
    const png = fs.readFileSync(exportPath); assert(png.subarray(1, 4).toString() === 'PNG' && png.readUInt32BE(16) === 1000 && png.readUInt32BE(20) === 700, 'The actual downloaded plot is not the requested bounded PNG.');
    uiMeasurements.sameGraphAfterExport = await sameGraph(); assert(uiMeasurements.sameGraphAfterExport, 'Export replaced the initialized retained graph.');
    check('Real Plotly hover, SVG rendering, zoom, keyboard reset and keyboard PNG export retain the actual PBMC source identifiers.');
    for (const viewport of [{ width: 1366, height: 768 }, { width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      for (const theme of ['light', 'dark']) { await setTheme(theme); await graph(viewer()).scrollIntoViewIfNeeded();
        await waitFor(async () => graph(viewer()).evaluate((element) => Math.abs(element.getBoundingClientRect().width - element._fullLayout.width) <= 2), 'The retained plot did not resize to its actual container.');
        await waitFor(async () => {
          uiMeasurements.themeProbe = await graph(viewer()).evaluate((element, expected) => {
            const normalize = value => { const text = document.createElement('span'); text.style.color = value; return text.style.color; };
            return { requested: expected, actualDocument: document.documentElement.dataset.theme || 'light', raw: element._fullLayout.paper_bgcolor,
              normalized: normalize(element._fullLayout.paper_bgcolor), expectedNormalized: normalize(expected === 'dark' ? '#111827' : '#ffffff'),
              visibleSvgBackground: getComputedStyle(element.querySelector('.main-svg')).backgroundColor };
          }, theme);
          return uiMeasurements.themeProbe.normalized === uiMeasurements.themeProbe.expectedNormalized;
        }, 'The retained plot did not adopt the actual theme.');
        await chartReady(viewer()); assert(await sameGraph(), 'Theme or container resize replaced the initialized retained graph.');
        await waitFor(async () => {
          const geometry = await graph(viewer()).evaluate(element => {
            const title = element.querySelector('.xtitle')?.getBoundingClientRect();
            const labels = Array.from(element.querySelectorAll('.legend .legendtext')).map(label => label.getBoundingClientRect());
            return title && labels.length ? { titleBottom: title.bottom, firstLegendTop: Math.min(...labels.map(label => label.top)), gap: Math.min(...labels.map(label => label.top)) - title.bottom } : null;
          });
          uiMeasurements.legendChecks ||= {}; uiMeasurements.legendChecks[`${theme}-${viewport.width}`] = geometry;
          return geometry && geometry.gap >= 4;
        }, 'The retained plot axis title overlaps its legend or has no readable separation.');
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'The retained plot overflows the viewport.'); await capture(`measured-pbmc-${theme}-${viewport.width}x${viewport.height}`, theme);
      }
    }
    await page.setViewportSize({ width: 1366, height: 768 }); await setTheme('light');
    await select(material.stress); await chartReady(viewer()); await viewer().getByText('Showing 2,000 of 10,000 source points.', { exact: true }).waitFor();
    await viewer().getByText(/Point entity type is not declared/).waitFor(); assert(await viewer().getByLabel('Declared result meaning').count() === 0, 'An undeclared result was assigned a role or title.');
    assert(await graph(viewer()).evaluate(element => element._fullLayout.xaxis.title.text === 'Coordinate 1' && element._fullLayout.yaxis.title.text === 'Coordinate 2'), 'Legacy unknown axes were inferred from data shape.');
    await viewer().getByRole('combobox', { name: 'Maximum points', exact: true }).selectOption('500'); await viewer().getByText('Showing 500 of 10,000 source points.', { exact: true }).waitFor();
    await viewer().getByRole('combobox', { name: 'Maximum points', exact: true }).selectOption('5000'); await viewer().getByText('Showing 5,000 of 10,000 source points.', { exact: true }).waitFor(); await chartReady(viewer());
    assert(responses.filter(value => value.sampling).every(value => value.bytes <= 256 * 1024), 'A typed preview exceeded its whole response byte envelope.'); await capture('synthetic-10k-bounded-stress');
    check('Persisted declared role/title, metric labels/units and cell/UMAP meaning reach actual views; undeclared stress metadata stays unknown within bounded projections.');
    await select(material.outputs.figure); await waitFor(async () => viewer().getByRole('img').evaluate(element => element.complete && element.naturalWidth === 1000 && element.naturalHeight === 650), 'The actual readable retained PBMC figure did not render.');
    for (const viewport of [{ width: 1366, height: 768 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      for (const theme of ['light', 'dark']) { await setTheme(theme); await viewer().getByRole('img').scrollIntoViewIfNeeded();
        assert(await viewer().getByRole('img').evaluate(element => element.getBoundingClientRect().width <= element.parentElement.getBoundingClientRect().width), 'The retained scientific image overflows its viewer.');
        await capture(`measured-pbmc-readable-figure-${theme}-${viewport.width}`, theme);
      }
    }
    const imageReadsBeforePopup = requests.filter(value => value.path === `/api/artifact-versions/${service.project.id}/${material.outputs.figure.id}/image`).length;
    const verifiedBlobUrl = await viewer().getByRole('img').getAttribute('src');
    assert(verifiedBlobUrl?.startsWith('blob:') && await viewer().getByRole('link', { name: 'Open full-size image', exact: true }).getAttribute('href') === verifiedBlobUrl, 'The full-size action does not use its already verified image Blob.');
    const popupOpening = page.context().waitForEvent('page');
    await viewer().getByRole('link', { name: 'Open full-size image', exact: true }).click();
    const popup = await popupOpening; await popup.waitForLoadState(); await popup.setViewportSize({ width: 390, height: 844 });
    const fullImage = popup.locator('img');
    await waitFor(async () => fullImage.evaluate(element => element.complete && element.naturalWidth === 1000 && element.naturalHeight === 650), 'The verified full-size Blob image did not open at its actual dimensions.');
    // A native image document cannot fetch its Blob under the application's
    // restrictive CSP. Bind it to the exact already-verified Blob identity and
    // independently hash the actual authenticated image response instead.
    const popupEvidence = await popup.evaluate(() => ({ href: location.href, imageSrc: document.querySelector('img').src, openerIsNull: window.opener === null }));
    const bytesEvidence = imageResponses.find(value => value.path === `/api/artifact-versions/${service.project.id}/${material.outputs.figure.id}/image`);
    assert(bytesEvidence?.sha256 === material.outputs.figure.sha256 && bytesEvidence.sizeBytes === material.outputs.figure.sizeBytes
      && popupEvidence.href === verifiedBlobUrl && popupEvidence.imageSrc === verifiedBlobUrl && popupEvidence.openerIsNull, 'The full-size image lost its verified source bytes or safe new-tab boundary.');
    const fittedWidth = await fullImage.evaluate(element => element.getBoundingClientRect().width);
    assert(fittedWidth < 1000, 'The mobile browser did not offer its fitted image view.');
    await fullImage.click(); await waitFor(async () => fullImage.evaluate(element => element.getBoundingClientRect().width === 1000), 'Native image zoom did not expose the full-resolution pixels.');
    uiMeasurements.fullSizeImage = { ...bytesEvidence, sameVerifiedBlob: true, openerIsNull: popupEvidence.openerIsNull, width: 1000, height: 650, fittedWidth, zoomedWidth: await fullImage.evaluate(element => element.getBoundingClientRect().width) };
    await popup.screenshot({ path: path.join(directory, 'verified-full-size-mobile-zoom.png'), fullPage: false }); screenshots.push('verified-full-size-mobile-zoom.png'); await popup.close();
    assert(requests.filter(value => value.path === `/api/artifact-versions/${service.project.id}/${material.outputs.figure.id}/image`).length === imageReadsBeforePopup, 'The full-size image fetched its source bytes again.');
    check('An explicit safe full-size image tab retains exact verified Blob bytes and native mobile pixel zoom without another source read.');
    await page.setViewportSize({ width: 1366, height: 768 }); await setTheme('light');
    await nav(/^Data workspace,/); await page.getByRole('group', { name: 'Saved analysis Retained PBMC3k input. Press Enter or Space to select.', exact: true }).focus(); await page.keyboard.press('Enter');
    await nav(/^Pipelines,/); const library = page.getByRole('region', { name: 'Workflow pipelines', exact: true });
    const recipeFile = path.join(directory, 'retained-review.pipeline.json'); fs.writeFileSync(recipeFile, JSON.stringify(material.recipe));
    await library.getByLabel('Workflow package file', { exact: true }).setInputFiles(recipeFile); await library.getByRole('button', { name: 'Install Retained PBMC3k review', exact: true }).click();
    await library.getByRole('button', { name: 'Open Retained PBMC3k review', exact: true }).click();
    await page.getByRole('heading', { name: 'Retained measured results', exact: true }).waitFor(); await page.getByText('Showing 2,000 of 2,638 source points.', { exact: true }).waitFor();
    assert(await page.getByRole('region', { name: 'Retained result', exact: true }).count() === 3, 'Workflow results did not reuse the common exact retained viewer.');
    assert(requests.every(value => value.method !== 'GET' || !/^\/api\/workflows\/[^/]+\/artifacts\//.test(value.path)), 'Workflow reading fetched complete legacy artifact JSON.');
    await new Promise(resolve => broker.close(resolve)); broker = null;
    await page.getByRole('combobox', { name: 'Maximum points', exact: true }).selectOption('500'); await page.getByText('Showing 500 of 2,638 source points.', { exact: true }).waitFor();
    await capture('workflow-common-retained-runtime-off');
    const workflowViews = page.getByRole('region', { name: 'Retained result', exact: true });
    const workflowMetrics = workflowViews.filter({ has: page.getByRole('heading', { name: /^Workflow metrics/ }) });
    await workflowMetrics.getByRole('heading', { name: 'PBMC3k retained dataset summary', exact: true }).waitFor();
    await workflowMetrics.getByText('2638', { exact: true }).scrollIntoViewIfNeeded(); await capture('workflow-metrics-runtime-off');
    const workflowEmbedding = workflowViews.filter({ has: page.getByRole('combobox', { name: 'Maximum points', exact: true }) });
    await chartReady(workflowEmbedding); await capture('workflow-embedding-runtime-off');
    const workflowFigure = workflowViews.filter({ has: page.getByRole('img', { name: /^Preview of Workflow figure/ }) });
    await workflowFigure.getByRole('img').scrollIntoViewIfNeeded(); await capture('workflow-figure-runtime-off');
    check('Actual workflow UI reuses exact bounded metrics/embedding/figure viewers and still refreshes retained points after its runtime broker stops.');
    const jobCount = Number((await database.query('SELECT count(*) AS count FROM jobs')).rows[0].count);
    const scientific = requests.filter(value => value.method === 'POST' && (/^\/api\/r\//.test(value.path) || /^\/api\/private-r-kernels\//.test(value.path) || /^\/api\/projects\/[^/]+\/jobs$/.test(value.path) || /\/instances\/[^/]+\/run$/.test(value.path)));
    assert(scientific.length === 0 && Number((await database.query('SELECT count(*) AS count FROM private_r_kernels')).rows[0].count) === 0 && jobCount === 1, 'Retained viewing dispatched scientific execution.');
    assert(errors.length === 0, 'An uncaught browser error occurred.');
    const report = { passed: true, checks, screenshots, themes, compiledAssets: assets, browserErrors: errors, responses, uiMeasurements, scientificDispatchCount: scientific.length,
      fixture: 'Own disposable production HTTPS/auth/PostgreSQL/storage; actual measured PBMC3k checkpoint extracted in a no-network/read-only immutable R container; separate synthetic 10k stress fixture; inserted retained records are not app-captured runs',
      origin: material.manifest, resultDigests: material.resultDigests, exclusions: ['app scientific execution', 'SSH', 'researcher usability observation'] };
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(report, null, 2) + '\n'); console.log('Typed retained UI acceptance passed; report: ' + directory); return report;
  } catch (failure) {
    await page?.screenshot({ path: path.join(directory, 'failure.png'), fullPage: true }).catch(() => {});
    let message = failure.message; for (const secret of [service?.databaseUrl, service?.account?.email, service?.account?.password, service?.storageRoot].filter(Boolean)) message = message.split(secret).join('[private fixture]');
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ passed: false, error: message, checks, screenshots, themes, uiMeasurements, compiledAssets: assets, browserErrors: errors }, null, 2) + '\n'); throw new Error(message);
  } finally { await browser?.close(); if (broker?.listening) await new Promise(resolve => broker.close(resolve)); await database?.end(); await service?.stop(); }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
