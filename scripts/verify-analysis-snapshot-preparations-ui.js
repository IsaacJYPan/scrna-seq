#!/usr/bin/env node
'use strict';

// Actual private preparation through production auth/PG/UI. These tiny outside
// results are synthetic; this does not certify scientific execution or sharing.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { PNG } = require('pngjs');
const { main: verifyAttachments } = require('./verify-analysis-attachments-ui');
const root = path.resolve(__dirname, '..');
const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAUDBAQEAwUEBAQFBQUGBwwIBwcHBw8LCwkMEQ8SEhEPERETFhwXExQaFRERGCEYGh0dHx8fExciJCIeJBweHx7/2wBDAQUFBQcGBw4ICA4eFBEUHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh7/wAARCAACAAMDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDm9bllj1W4jjkdEVtqqrEAADgAUUUV9HhP93h6L8j8wzH/AHyr/il+bP/Z', 'base64');

async function verifyPreparations(env) {
  const { service, database, study, otherStudy, accounts, requests, faults, api, importFile, openAnalysis, login,
    matrix, capture, theme, until, assert, check, attachmentPath, expectedDiagnostics, faultPaths, restartBrowser, analysisVersion } = env;
  let page;
  const prepPath = attachmentPath().replace(/\/attachments$/, '/snapshot-preparations');
  const analysisPath = attachmentPath().replace(/\/attachments$/, ''), documentPath = analysisPath + '/documents';
  const panel = target => target.getByRole('region', { name: 'Private snapshot preparations', exact: true });
  const form = target => panel(target).getByRole('form', { name: 'Prepare private snapshot', exact: true });
  const review = target => panel(target).getByRole('region', { name: 'Private preparation review', exact: true });
  const writes = () => requests.filter(item => item.actor === 'owner' && item.method === 'POST' && item.pathname === prepPath);
  const role = value => database.query('UPDATE project_members SET role=$3 WHERE project_id=$1 AND user_id=$2', [service.project.id, accounts.owner.id, value]);
  async function open(target = page, analysis = study) {
    await openAnalysis(target, analysis);
    await target.getByRole('button', { name: /^(?:Prepare sharing|Saved preparations)$/ }).click(); await panel(target).waitFor();
    await until(() => panel(target).getByRole('button', { name: 'Refresh access and saved preparations', exact: true }).isEnabled(), 'Preparation metadata did not settle.');
  }
  async function restart() { page = await restartBrowser(); await open(); }
  async function refresh() {
    await panel(page).getByRole('button', { name: 'Refresh access and saved preparations', exact: true }).click();
    await until(() => panel(page).getByRole('button', { name: 'Refresh access and saved preparations', exact: true }).isEnabled(), 'Preparation access refresh did not settle.');
  }
  async function original(recipe) { return api(page, prepPath + '/requests/' + recipe.requestId); }
  async function openSaved() {
    await panel(page).getByRole('button', { name: 'Saved preparations', exact: true }).click();
    await panel(page).getByRole('button', { name: 'Open private preparation', exact: true }).first().click();
    await review(page).getByRole('heading', { name: 'Ready for private review', exact: true }).waitFor();
  }
  async function checkOriginal() {
    await review(page).getByRole('button', { name: 'Check original preparation', exact: true }).click();
    await until(() => review(page).getByRole('button', { name: 'Check original preparation', exact: true }).isEnabled(), 'Original preparation check did not settle.');
  }
  await role('owner'); await restart();
  const png = new PNG({ width: 64, height: 32 }); png.data.fill(100); for (let index = 3; index < png.data.length; index += 4) png.data[index] = 255;
  const fixtures = [
    { name: 'Private CSV result', filename: 'private-summary.csv', mime: 'text/csv', bytes: Buffer.from('sample,cells\n' + Array.from({ length: 10 }, (_, index) => `donor-${index + 1},${index + 11}`).join('\n') + '\n'), caption: 'Fixed CSV excerpt for a private sharing preview' },
    { name: 'Private TSV result', filename: 'private-markers.tsv', mime: 'text/tab-separated-values', bytes: Buffer.from('gene\tscore\nGeneA\t1.5\nGeneB\t2.5\n'), caption: 'TSV markers retained in a private preview' },
    { name: 'Private PNG result', filename: 'private-figure.png', mime: 'image/png', bytes: PNG.sync.write(png), caption: 'PNG figure retained in a private preview' },
    { name: 'Private JPEG result', filename: 'private-figure.jpeg', mime: 'image/jpeg', bytes: jpeg, caption: 'JPEG figure retained in a private preview' },
  ];
  for (const fixture of fixtures) {
    fixture.version = await importFile(page, fixture.bytes, fixture.name, fixture.filename, fixture.mime);
    fixture.attachment = (await api(page, attachmentPath(), { method: 'POST', expected: 201, body: { requestId: crypto.randomUUID(),
      reference: { kind: 'artifact-version', versionId: fixture.version.versionId, sha256: fixture.version.sha256 }, caption: fixture.caption, suppliedOrigin: { origin: 'Synthetic supplied result; no run reconstructed.' } } })).acceptedRevision;
  }
  const { importScriptDocument } = await import('../shared/scriptDocument.mjs');
  const method = 'ncol(obj)\r\n# Supplied supporting source, not a captured producing run.\r\n';
  const source = importScriptDocument({ filename: 'supporting-method.R', bytes: Buffer.from(method), cellId: 'supporting_r' });
  const saved = (await api(page, documentPath, { method: 'POST', expected: 201, body: { requestId: crypto.randomUUID(), title: 'Supplied R method', content: source } })).document;
  await panel(page).getByRole('button', { name: 'Back to analysis', exact: true }).click();
  const dirty = 'Unsubmitted overview notes remain separate from private snapshot preparation.';
  await page.getByRole('textbox', { name: 'Research question or notes', exact: true }).fill(dirty);
  await page.getByRole('button', { name: 'Prepare sharing', exact: true }).click();
  await form(page).getByText('Unsaved overview edits are excluded from this preview.', { exact: true }).waitFor();
  await form(page).getByRole('region', { name: 'Choose retained findings', exact: true }).getByRole('button', { name: 'Refresh saved choices', exact: true }).click();
  await form(page).getByRole('region', { name: 'Choose supporting saved source', exact: true }).getByRole('button', { name: 'Refresh saved choices', exact: true }).click();
  for (const fixture of fixtures) {
    const card = form(page).getByRole('region', { name: 'Choose retained findings', exact: true }).getByRole('listitem').filter({ has: page.getByText(fixture.caption, { exact: true }) });
    await card.getByRole('button', { name: /^(?:Add table excerpt|Add figure)$/ }).click();
  }
  await form(page).getByRole('spinbutton', { name: 'First data row for finding 1', exact: true }).fill('3');
  await form(page).getByRole('spinbutton', { name: 'Rows to include for finding 1', exact: true }).fill('2');
  await form(page).getByRole('checkbox', { name: /Supplied R method/ }).check();
  await form(page).locator('summary').filter({ hasText: /^Notes and reproduction prerequisites/ }).click();
  await form(page).getByRole('textbox', { name: 'Summary (optional)', exact: true }).fill('Private exact preview with four supplied result formats.');
  await form(page).getByRole('button', { name: 'Return to save changes', exact: true }).click();
  await until(() => page.getByRole('button', { name: 'Save changes', exact: true }).evaluate(node => node === document.activeElement), 'Returning to save did not restore the overview save focus.');
  assert(await page.getByRole('textbox', { name: 'Research question or notes', exact: true }).inputValue() === dirty, 'Preparing discarded the unsaved overview.');
  await openAnalysis(page, otherStudy); await page.getByRole('button', { name: 'Prepare sharing', exact: true }).click();
  await form(page).waitFor();
  assert(!(await form(page).getByRole('button', { name: 'Remove finding 1', exact: true }).count()), 'Another analysis inherited this private selection.');
  await panel(page).getByRole('button', { name: 'Back to analysis', exact: true }).click();
  await openAnalysis(page, study); await page.getByRole('button', { name: 'Prepare sharing', exact: true }).click();
  await until(() => form(page).getByRole('button', { name: 'Prepare private preview', exact: true }).isEnabled(), 'The preserved preparation draft did not recover current access.');
  assert(await form(page).getByRole('spinbutton', { name: 'First data row for finding 1', exact: true }).inputValue() === '3'
    && await form(page).getByRole('textbox', { name: 'Summary (optional)', exact: true }).inputValue() === 'Private exact preview with four supplied result formats.'
    && await form(page).getByRole('checkbox', { name: /Supplied R method/ }).isChecked(), 'Ordinary analysis navigation discarded or changed the private preparation draft.');
  check('Ordinary back/save focus and navigation to another analysis preserve the unsent exact selection and overview draft without saving or leaking the selection to another analysis.');
  await matrix(page, 'snapshot-choose-saved-material', () => form(page).getByRole('heading', { name: '1. Choose a saved analysis version', exact: true }).scrollIntoViewIfNeeded());
  await matrix(page, 'snapshot-prepare-private-action', () => form(page).getByRole('button', { name: 'Prepare private preview', exact: true }).scrollIntoViewIfNeeded());
  let aborted = false;
  const interrupt = async route => { if (!aborted && route.request().method() === 'POST') { aborted = true; await route.abort('failed'); } else await route.continue(); };
  faultPaths.add(prepPath); await page.route('**' + prepPath, interrupt);
  await form(page).getByRole('button', { name: 'Prepare private preview', exact: true }).click();
  await until(() => writes().length === 1, 'The deliberately interrupted private preparation was not observed.');
  const recipe = writes()[0].input; assert(recipe?.requestId && recipe.analysisVersion === analysisVersion && recipe.results.length === 4, 'Preparation did not freeze the exact saved version and selected findings.');
  expectedDiagnostics.add(`404 ${prepPath}/requests/${recipe.requestId}`); await checkOriginal(); await page.unroute('**' + prepPath, interrupt);
  assert(!(await database.query('SELECT 1 FROM research_analysis_snapshot_preparations WHERE request_id=$1', [recipe.requestId])).rowCount, 'A pre-upstream abort invented an admitted preparation.');
  const held = service.interceptNextResponse({ method: 'POST', pathname: prepPath, mode: 'hold' }); faults.push(held);
  await review(page).getByRole('button', { name: 'Retry original preparation', exact: true }).click(); await until(() => held.observation(), 'The genuine accepted ready response was not held.');
  assert(held.observation().value.state === 'ready' && JSON.stringify(writes()[1].input) === JSON.stringify(recipe), 'A deliberate retry changed the original recipe or did not really commit a private ready package.');
  await restart(); held.release(); await openSaved();
  const retained = await original(recipe), packageSha = retained.snapshotSha256;
  assert(retained.state === 'ready' && retained.package.results.length === 4 && retained.package.documents[0].versionId === saved.versionId && writes().length === 2, 'Reopening rebuilt, duplicated or changed the accepted private selection.');
  await review(page).getByRole('cell', { name: 'donor-3', exact: true }).waitFor(); await review(page).getByRole('cell', { name: 'donor-4', exact: true }).waitFor();
  assert(!(await review(page).getByRole('cell', { name: 'donor-1', exact: true }).count()) && !(await review(page).getByRole('button', { name: 'Next rows', exact: true }).count()), 'A fixed retained excerpt exposed source pagination or unselected rows.');
  await matrix(page, 'snapshot-reopened-exact-fixed-csv', () => review(page).getByRole('table').scrollIntoViewIfNeeded());
  check('A pre-upstream preparation failure permits only deliberate identical retry; a real accepted ready reply is lost across a Chromium restart, and private discovery opens the same fixed CSV excerpt without another build or source pagination.');

  for (const fixture of fixtures.slice(1)) {
    await review(page).getByRole('list', { name: 'Retained finding selection', exact: true }).getByRole('button').filter({ hasText: fixture.caption }).click();
    if (fixture.mime.startsWith('image/')) {
      const image = review(page).getByRole('img', { name: new RegExp(fixture.name) }); await image.waitFor();
      assert(await image.evaluate(node => node.complete && node.naturalWidth > 0), 'A retained raster did not genuinely decode in Chromium.');
      await matrix(page, fixture.mime === 'image/jpeg' ? 'snapshot-checked-jpeg' : 'snapshot-checked-png', () => image.scrollIntoViewIfNeeded());
    } else { await review(page).getByRole('cell', { name: 'GeneB', exact: true }).waitFor(); await matrix(page, 'snapshot-fixed-tsv', () => review(page).getByRole('table').scrollIntoViewIfNeeded()); }
  }
  check('Actual retained TSV values and PNG/JPEG bytes are inspected through the same fixed renderer; one finding loads at a time without a source-file preview request.');
  const supporting = review(page).getByRole('region', { name: 'Prepared supporting source', exact: true });
  const sourcePath = `${prepPath}/${retained.preparationId}/documents/${retained.package.documents[0].viewId}`;
  assert(!requests.some(item => item.pathname === sourcePath), 'Supporting source was eagerly fetched without a deliberate view action.');
  await supporting.getByRole('button', { name: 'View supporting source', exact: true }).click();
  await supporting.getByText('Saved supporting source checksum verified', { exact: true }).waitFor();
  assert((await supporting.locator('pre[aria-label="Retained saved source"]').textContent()).includes('ncol(obj)'), 'The exact retained R source did not render as escaped text.');
  await matrix(page, 'snapshot-retained-supporting-r-source', () => supporting.scrollIntoViewIfNeeded());
  check('The exact retained R script loads only after an explicit supporting-source action and is inspected as read-only text with a verified saved checksum.');

  const newer = await api(page, analysisPath, { method: 'PATCH', body: { expectedVersion: analysisVersion, description: 'A later saved question is separate from the retained preview.' } });
  const newerSource = structuredClone(source); newerSource.cells[0].source = 'stop("Newer supporting source must not replace the retained version")\n';
  await api(page, `${documentPath}/${saved.id}`, { method: 'PUT', body: { requestId: crypto.randomUUID(), expectedVersion: saved.version, title: saved.title, content: newerSource } });
  await api(page, `${attachmentPath()}/${fixtures[0].attachment.attachmentId}/revisions`, { method: 'POST', expected: 201, body: {
    requestId: crypto.randomUUID(), expectedHeadRevisionId: fixtures[0].attachment.id, reference: fixtures[0].attachment.reference,
    caption: 'Newer source context does not alter the retained snapshot.', suppliedOrigin: fixtures[0].attachment.suppliedOrigin,
  } });
  const originalFile = (await database.query('SELECT storage_key FROM managed_artifact_versions WHERE id=$1', [fixtures[0].version.versionId])).rows[0];
  const absolute = path.resolve(service.storageRoot, ...originalFile.storage_key.split('/'));
  assert(absolute.startsWith(path.resolve(service.storageRoot) + path.sep), 'Synthetic original file cleanup escaped owned fixture storage.'); fs.unlinkSync(absolute);
  await checkOriginal(); const unchanged = await original(recipe);
  assert(unchanged.snapshotSha256 === packageSha && unchanged.package.analysis.version === analysisVersion && unchanged.package.results[0].attachment.revisionId === fixtures[0].attachment.id && unchanged.availability.status === 'available', 'A later head or original source loss changed the ready package or retained availability.');
  const colleague = await login('colleague');
  await api(colleague, `${prepPath}/requests/${recipe.requestId}`, { expected: 404 }); assert((await api(colleague, prepPath)).items.length === 0, 'Another account discovered a private candidate.');
  await api(colleague, `${prepPath}/${retained.preparationId}/views/${retained.package.results[0].viewId}`, { expected: 404 });
  await api(page, `${attachmentPath(otherStudy).replace(/\/attachments$/, '/snapshot-preparations')}/${retained.preparationId}`, { expected: 404 });
  check('New analysis/document/attachment heads and actual original-source removal do not replace the retained package; real second-account and analysis isolation hold without broadening source or publication access.');

  await role('viewer'); await restart(); await openSaved();
  assert(await review(page).getByRole('button', { name: 'Remove private preparation', exact: true }).isEnabled(), 'A current reader could not remove their own unshared copies.');
  assert(!(await review(page).getByRole('button', { name: 'Resume original preparation', exact: true }).count()), 'A current reader gained build authority.');
  await matrix(page, 'snapshot-reader-private-review', () => review(page).getByRole('heading', { name: 'Ready for private review', exact: true }).scrollIntoViewIfNeeded());
  const heldRead = service.interceptNextResponse({ method: 'GET', pathname: prepPath + '/requests/' + recipe.requestId, mode: 'hold' }); faults.push(heldRead);
  await review(page).getByRole('button', { name: 'Check original preparation', exact: true }).click(); await until(() => heldRead.observation(), 'The genuine authorized private preparation read was not held.');
  await database.query('DELETE FROM project_members WHERE project_id=$1 AND user_id=$2', [service.project.id, accounts.owner.id]);
  expectedDiagnostics.add(`404 ${prepPath}?limit=30`); await refresh();
  await until(async () => !(await review(page).getByRole('heading', { name: 'Ready for private review', exact: true }).count()), 'Scope revocation retained protected preparation metadata.');
  heldRead.release(); await page.waitForTimeout(200);
  assert(!(await review(page).getByText(fixtures[0].caption, { exact: true }).count()), 'An older authorized response restored private metadata after newer scope denial.');
  await matrix(page, 'snapshot-scope-denial-fences-older-read', () => review(page).scrollIntoViewIfNeeded());
  await database.query("INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,'viewer')", [service.project.id, accounts.owner.id]);
  await refresh(); await openSaved();
  check('Actual membership revocation clears private preparation content and fences a held previously authorized read; restored reader access explicitly recovers the original package without building.');
  const missingView = retained.package.results[3];
  // Real fixture-only byte loss via the same privileged demo-cleanup mechanism
  // tested by lifecycle cleanup. Normal immutable production writes stay blocked.
  try {
    await database.query('BEGIN'); await database.query("SET LOCAL app.demo_cleanup='on'");
    await database.query('DELETE FROM research_analysis_snapshot_blobs WHERE preparation_id=$1 AND id=$2', [retained.preparationId, missingView.viewId]);
    await database.query('COMMIT');
  } catch (error) { await database.query('ROLLBACK'); throw error; }
  await checkOriginal();
  await review(page).getByRole('list', { name: 'Retained finding selection', exact: true }).getByRole('button').filter({ hasText: fixtures[3].caption }).click();
  await review(page).getByText('This retained view is unavailable. Its exact saved identity is kept and has not been regenerated.', { exact: true }).waitFor();
  assert(!(await review(page).getByRole('img').count()), 'Actual retained byte loss left a stale verified image visible.');
  const missing = await original(recipe);
  assert(missing.state === 'ready' && missing.snapshotSha256 === packageSha && missing.availability.status === 'unavailable' && !missing.canResume, 'Missing retained bytes changed acceptance or enabled silent regeneration.');
  await api(page, `${prepPath}/${retained.preparationId}/views/${missingView.viewId}`, { expected: 409 });
  await matrix(page, 'snapshot-retained-bytes-unavailable', () => review(page).getByRole('region', { name: 'Retained prepared finding', exact: true }).scrollIntoViewIfNeeded());
  check('Actual retained JPEG byte loss preserves the immutable ready package and exact identity, removes the image, and reports unavailability without regeneration or source fallback.');
  await review(page).getByRole('button', { name: 'Remove private preparation', exact: true }).click();
  const dropDelete = service.interceptNextResponse({ method: 'DELETE', pathname: `${prepPath}/${retained.preparationId}`, mode: 'drop' }); faults.push(dropDelete); faultPaths.add(`${prepPath}/${retained.preparationId}`);
  await review(page).getByRole('button', { name: 'Remove private preparation', exact: true }).click(); await until(() => dropDelete.observation(), 'The accepted deletion reply was not interrupted.');
  assert(dropDelete.observation().status === 200 && dropDelete.observation().value.state === 'deleted', 'The genuine private deletion was not accepted.'); await checkOriginal();
  await review(page).getByRole('heading', { name: 'Private preparation removed', exact: true }).waitFor();
  const tombstone = await original(recipe);
  assert(tombstone.state === 'deleted' && tombstone.recipe === null && tombstone.package === null && tombstone.snapshotSha256 === packageSha && !(await database.query('SELECT 1 FROM research_analysis_snapshot_blobs WHERE preparation_id=$1', [retained.preparationId])).rowCount, 'Reader deletion failed to atomically remove only retained bytes while preserving original acceptance.');
  await matrix(page, 'snapshot-original-deletion-tombstone', () => review(page).scrollIntoViewIfNeeded());
  assert((await database.query('SELECT COUNT(*)::int AS n FROM research_analysis_snapshot_preparations WHERE analysis_id=$1', [study.id])).rows[0].n === 1 && writes().length === 2, 'Recovery or deletion duplicated the original private preparation.');
  const persisted = await page.evaluate(() => Object.values(localStorage).concat(Object.values(sessionStorage)).join('\n'));
  assert(!persisted.includes(recipe.requestId) && !persisted.includes('donor-3') && !persisted.includes(method), 'A private preparation or scientific source entered Web Storage.');
  check('A reader retains private inspection/deletion access without build authority; a genuinely committed lost DELETE reply resolves to the original source-free tombstone, zero retained blob rows, no rebuilt copy and no scientific browser persistence.');
  await page.setViewportSize({ width: 390, height: 844 }); await theme(page, 'dark'); await capture(page, 'snapshot-deleted-natural-phone');
  return { extraRevisions: 5, analysisVersion: newer.analysis.version };
}

async function main() { return verifyAttachments({ artifactDirectory: path.join(root, 'playwright/report', 'analysis-snapshot-preparations-' + Date.now()), verifyPreparations }); }
if (require.main === module) main().catch(failure => { console.error(failure.message); process.exitCode = 1; });
module.exports = { main, verifyPreparations };
