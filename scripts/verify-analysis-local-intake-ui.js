#!/usr/bin/env node
'use strict';

// Real file admission/upload/attachment receipts across genuine Chromium
// process restarts. Scientific inputs here are explicitly synthetic fixtures.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { PNG } = require('pngjs');

async function verifyIntakes(env) {
  const { service, database, study, otherStudy, accounts, requests, faults, region, details, api, login, openAnalysis, openOutside,
    closeDetails, theme, capture, matrix, until, assert, check, attachmentPath, expectedDiagnostics, faultPaths, restartBrowser, analysisVersion } = env;
  let page = env.page;
  const intakePath = `${attachmentPath()}/local-intakes`, uploadPath = `/api/artifact-versions/${service.project.id}`;
  const panel = target => region(target).getByRole('region', { name: 'Local result intake', exact: true });
  const saved = target => panel(target).getByRole('region', { name: 'Saved local import request', exact: true });
  const intakeForm = target => panel(target).getByRole('form', { name: 'Import local evidence', exact: true });
  const library = target => panel(target).getByRole('region', { name: 'Your saved local imports', exact: true });
  const card = (target, name) => library(target).getByRole('listitem').filter({ has: target.getByText(name, { exact: true }) });
  const acceptedRevisions = new Set();
  const csv = Buffer.from('sample,condition,note\r\nsample-a,control,"local, quoted"\r\nsample-b,treated,"line one\nline two"\r\n');
  const file = { name: 'local-result.csv', mimeType: 'text/csv', buffer: csv };
  const uploads = () => requests.filter(item => item.actor === 'owner' && item.method === 'POST' && item.pathname === uploadPath);
  const admissions = () => requests.filter(item => item.actor === 'owner' && item.method === 'POST' && item.pathname === intakePath);
  const latestRecipe = () => admissions().at(-1)?.input;
  async function openPanel(target) {
    await closeDetails(target);
    if (!(await panel(target).count()) || !(await panel(target).isVisible())) await region(target).getByRole('button', { name: /^(?:Import files|Saved imports)$/ }).click();
    await until(() => library(target).getByRole('button', { name: 'Refresh import requests', exact: true }).isEnabled(), 'Saved import discovery did not settle.');
  }
  async function restart() {
    page = await restartBrowser(); await openAnalysis(page, study); await openOutside(page); await openPanel(page); return page;
  }
  async function openSaved(name) {
    await card(page, name).getByRole('button', { name: 'Open saved import request', exact: true }).click();
    await saved(page).getByRole('heading', { name, exact: true }).waitFor();
    await until(() => saved(page).getByRole('button', { name: 'Check saved import request', exact: true }).isEnabled(), 'The exact saved request did not settle.');
  }
  async function refresh() {
    const waiting = page.waitForResponse(response => response.request().method() === 'GET' && new URL(response.url()).pathname === intakePath);
    await library(page).getByRole('button', { name: 'Refresh import requests', exact: true }).click(); await waiting;
    await until(() => library(page).getByRole('button', { name: 'Refresh import requests', exact: true }).isEnabled(), 'Refreshing import discovery left loading stuck.');
  }
  async function checkSaved(recipe) {
    const waiting = page.waitForResponse(response => response.request().method() === 'GET' && new URL(response.url()).pathname === `${intakePath}/${recipe.requestId}`);
    await saved(page).getByRole('button', { name: 'Check saved import request', exact: true }).click(); const result = await (await waiting).json();
    await until(() => saved(page).getByRole('button', { name: 'Check saved import request', exact: true }).isEnabled(), 'The original intake check did not settle.'); return result;
  }
  async function prepare(name, caption, source = file) {
    if (await saved(page).count()) await saved(page).getByRole('button', { name: 'Prepare another import', exact: true }).click();
    await intakeForm(page).getByLabel('Local result file', { exact: true }).setInputFiles(source);
    await intakeForm(page).getByRole('textbox', { name: 'Saved file name', exact: true }).fill(name);
    await intakeForm(page).getByRole('textbox', { name: 'Result caption', exact: true }).fill(caption);
  }
  async function importFile() {
    await intakeForm(page).getByRole('button', { name: 'Import local file', exact: true }).click();
    await saved(page).getByText('Accepted · saved file recorded', { exact: true }).waitFor();
    await until(() => saved(page).getByRole('button', { name: 'Check saved import request', exact: true }).isEnabled(), 'The import confirmation did not settle.'); return latestRecipe();
  }

  await database.query("UPDATE project_members SET role='owner' WHERE project_id=$1 AND user_id=$2", [service.project.id, accounts.owner.id]);
  await region(page).getByRole('button', { name: 'Refresh results', exact: true }).click();
  await region(page).getByRole('button', { name: 'Import files', exact: true }).waitFor(); await openPanel(page);
  const firstName = 'Laptop summary retained across admission restart';
  const firstCaption = 'Local intake original evidence with quoted multiline notes.';
  await prepare(firstName, firstCaption);
  await intakeForm(page).locator('summary').click();
  await intakeForm(page).getByRole('textbox', { name: 'Where this result came from', exact: true }).fill('Synthetic laptop result; no execution was reconstructed.');
  const heldAdmission = service.interceptNextResponse({ method: 'POST', pathname: intakePath, mode: 'hold' }); faults.push(heldAdmission); faultPaths.add(intakePath);
  const beforeAdmissionUploads = uploads().length;
  await intakeForm(page).getByRole('button', { name: 'Import local file', exact: true }).click();
  await until(() => heldAdmission.observation(), 'The actual committed admission reply was not held.');
  const firstRecipe = latestRecipe(); assert(firstRecipe?.requestId && firstRecipe.attachment.requestId !== firstRecipe.requestId, 'Admission did not preserve separately frozen transfer and attachment UUIDs.');
  assert(uploads().length === beforeAdmissionUploads, 'File bytes were uploaded before exact admission acknowledgement.');
  await restart(); heldAdmission.release();
  assert(uploads().length === beforeAdmissionUploads, 'Reopening automatically uploaded the original file.');
  await openSaved(firstName);
  assert(await saved(page).getByText(firstCaption, { exact: true }).isVisible(), 'The frozen caption did not survive actual process restart.');
  assert(await saved(page).getByRole('button', { name: 'Upload original file', exact: true }).isDisabled(), 'Reopened intake retained browser file bytes or uploaded without explicit reselection.');
  await matrix(page, 'reopened-admission-before-file-reselection', () => saved(page).scrollIntoViewIfNeeded());
  await saved(page).getByLabel('Original file', { exact: true }).scrollIntoViewIfNeeded(); await capture(page, 'reopened-original-file-picker-390');
  const wrong = Buffer.from(csv); wrong[0] = wrong[0] === 115 ? 116 : 115;
  await saved(page).getByLabel('Original file', { exact: true }).setInputFiles({ ...file, buffer: wrong });
  await saved(page).getByRole('button', { name: 'Upload original file', exact: true }).click();
  await panel(page).getByRole('alert').filter({ hasText: 'Choose the original file with the same filename, size and SHA-256 checksum.' }).waitFor();
  assert(uploads().length === beforeAdmissionUploads, 'A mismatched reselected file reached the transfer service.');
  await saved(page).getByLabel('Original file', { exact: true }).setInputFiles(file);
  await saved(page).getByRole('button', { name: 'Upload original file', exact: true }).click();
  await saved(page).getByText('Accepted · saved file recorded', { exact: true }).waitFor();
  const originalUpload = await api(page, `${intakePath}/${firstRecipe.requestId}`);
  assert(uploads().length === beforeAdmissionUploads + 1 && originalUpload.importOutcome.status === 'accepted'
    && originalUpload.importOutcome.receipt.requestId === firstRecipe.requestId
    && Object.entries(firstRecipe.importRequest).every(([key, value]) => originalUpload.importOutcome.receipt.request[key] === value), 'The single deliberate upload did not accept the exact original import UUID and canonical file settings.');
  assert(!(await saved(page).getByRole('button', { name: 'Inspect original attached result', exact: true }).count()), 'Upload completion automatically attached the file.');
  check('An actual committed admission reply is lost across a genuine browser-process restart without uploading; private discovery retains the frozen recipe, wrong bytes are refused before transfer, and deliberate original-file reselection uploads with the same UUID.');

  const lostAttachment = service.interceptNextResponse({ method: 'POST', pathname: attachmentPath(), mode: 'drop' }); faults.push(lostAttachment);
  await saved(page).getByRole('button', { name: 'Attach imported result', exact: true }).click(); await until(() => lostAttachment.observation(), 'The genuine accepted intake attachment reply was not dropped.');
  const originalAccepted = await api(page, `${intakePath}/${firstRecipe.requestId}`), firstRevision = originalAccepted.attachmentOutcome.receipt.acceptedRevision;
  acceptedRevisions.add(firstRevision.id);
  const newer = await api(page, `${attachmentPath()}/${firstRevision.attachmentId}/revisions`, { method: 'POST', body: { requestId: crypto.randomUUID(),
    expectedHeadRevisionId: firstRevision.id, reference: firstRevision.reference, caption: 'Newer context is current after the lost local-intake attachment acknowledgement.', suppliedOrigin: firstRevision.suppliedOrigin }, expected: 201 });
  acceptedRevisions.add(newer.acceptedRevision.id);
  const beforeRestartWrites = requests.length;
  await restart(); await openSaved(firstName);
  assert(requests.slice(beforeRestartWrites).filter(item => item.method === 'POST' && (item.pathname === uploadPath || /\/attachments(?:$|\/)/.test(item.pathname))).length === 0, 'Restart automatically transferred bytes, re-admitted an intake or attached a result.');
  await saved(page).getByText('A newer attachment revision is current. This request confirms the original saved revision.', { exact: true }).waitFor();
  await matrix(page, 'reopened-original-attachment-newer-head', () => saved(page).scrollIntoViewIfNeeded());
  await saved(page).getByRole('button', { name: 'Inspect original attached result', exact: true }).click();
  await details(page).getByRole('heading', { name: firstCaption, exact: true }).waitFor(); await details(page).getByRole('cell', { name: 'local, quoted', exact: true }).waitFor();
  await matrix(page, 'reopened-original-intake-verified-table', () => details(page).getByRole('table').scrollIntoViewIfNeeded());
  assert((await api(page, `${intakePath}/${firstRecipe.requestId}`)).attachmentOutcome.receipt.attachment.headRevisionId === newer.acceptedRevision.id, 'Original intake recovery rolled evidence backwards.');
  check('A genuinely accepted lost attachment is recovered after another browser restart and a newer exact correction; the original accepted caption/source opens with checked CSV bytes without moving the newer head or repeating the attachment.');

  await closeDetails(page);
  const orphanName = 'Accepted private import with later missing source'; await prepare(orphanName, 'An imported file may be accepted independently of its later availability.');
  const lostUpload = service.interceptNextResponse({ method: 'POST', pathname: uploadPath, mode: 'drop' }); faults.push(lostUpload); faultPaths.add(uploadPath);
  await intakeForm(page).getByRole('button', { name: 'Import local file', exact: true }).click(); await until(() => lostUpload.observation(), 'The actual accepted upload acknowledgement was not dropped.');
  const orphanRecipe = latestRecipe(), beforeReopenUploads = uploads().length;
  await database.query("UPDATE project_members SET role='viewer' WHERE project_id=$1 AND user_id=$2", [service.project.id, accounts.owner.id]);
  await restart(); await openSaved(orphanName);
  await saved(page).getByText('Accepted · saved file recorded', { exact: true }).waitFor();
  assert(await saved(page).getByRole('button', { name: 'Attach imported result', exact: true }).isDisabled(), 'A recovered current-reader import gained attachment write access.');
  assert(uploads().length === beforeReopenUploads, 'Current-reader recovery retried an accepted upload.');
  await matrix(page, 'reopened-reader-accepted-local-upload', () => saved(page).scrollIntoViewIfNeeded());
  const orphanReceipt = await api(page, `${intakePath}/${orphanRecipe.requestId}`), version = orphanReceipt.importOutcome.receipt.acceptance.versionId;
  const source = (await database.query('SELECT storage_key FROM managed_artifact_versions WHERE id=$1', [version])).rows[0];
  const absolute = path.resolve(service.storageRoot, ...source.storage_key.split('/'));
  assert(absolute.startsWith(path.resolve(service.storageRoot) + path.sep), 'Owned synthetic source deletion escaped the fixture storage root.');
  await database.query('DELETE FROM managed_artifact_versions WHERE id=$1', [version]); fs.unlinkSync(absolute);
  const unavailable = await checkSaved(orphanRecipe);
  assert(unavailable.importOutcome.status === 'accepted' && unavailable.importOutcome.receipt.availability === 'unavailable' && unavailable.importOutcome.receipt.version === null, 'Source loss erased original import acceptance.');
  await saved(page).getByText('Accepted · original file unavailable', { exact: true }).waitFor();
  assert(!(await saved(page).getByRole('button', { name: 'Inspect imported file', exact: true }).count()), 'Unavailable source still offered file inspection.');
  await matrix(page, 'retained-local-import-missing-source', () => saved(page).scrollIntoViewIfNeeded());
  check('A third real browser restart recovers a genuinely accepted lost upload under current reader authority; source-row/byte loss preserves the immutable acceptance without a new upload, attachment grant or false file preview.');

  await database.query("UPDATE project_members SET role='owner' WHERE project_id=$1 AND user_id=$2", [service.project.id, accounts.owner.id]);
  // Refresh the app-level membership snapshot loaded during the reader login.
  await restart(); await region(page).getByRole('button', { name: 'Attach outside result', exact: true }).waitFor();
  await panel(page).getByRole('button', { name: 'Close import panel', exact: true }).click();
  const currentCard = region(page).getByRole('list', { name: 'Attached outside results', exact: true }).getByRole('listitem').filter({ has: page.getByText(newer.acceptedRevision.caption, { exact: true }) });
  await currentCard.getByRole('button', { name: 'Correct caption or source', exact: true }).click();
  const correction = region(page).getByRole('form', { name: 'Correct outside result', exact: true });
  const imageCaption = 'Deliberate local PNG source correction retains the original CSV and discussion.';
  await correction.getByRole('textbox', { name: 'Result caption', exact: true }).fill(imageCaption);
  await correction.getByRole('button', { name: 'Import local file instead', exact: true }).click();
  await until(async () => await intakeForm(page).getByRole('textbox', { name: 'Result caption', exact: true }).inputValue() === imageCaption, 'Opening local replacement intake lost the parent correction draft.');
  const png = new PNG({ width: 64, height: 32 }); png.data.fill(180);
  for (let index = 3; index < png.data.length; index += 4) png.data[index] = 255;
  await intakeForm(page).getByLabel('Local result file', { exact: true }).setInputFiles({ name: 'local-figure.png', mimeType: 'image/png', buffer: PNG.sync.write(png) });
  await intakeForm(page).getByRole('textbox', { name: 'Saved file name', exact: true }).fill('Laptop PNG replacement');
  const imageRecipe = await importFile();
  assert(imageRecipe.attachment.action === 'correct' && imageRecipe.attachment.attachmentId === firstRevision.attachmentId && imageRecipe.attachment.expectedHeadRevisionId === newer.acceptedRevision.id, 'Local source correction did not freeze the exact intended predecessor.');
  await saved(page).getByRole('button', { name: 'Save original source correction', exact: true }).click();
  await saved(page).getByRole('button', { name: 'Inspect original attached result', exact: true }).waitFor();
  const imageAccepted = (await api(page, `${intakePath}/${imageRecipe.requestId}`)).attachmentOutcome.receipt.acceptedRevision; acceptedRevisions.add(imageAccepted.id);
  await saved(page).getByRole('button', { name: 'Inspect original attached result', exact: true }).click();
  await details(page).getByRole('heading', { name: imageCaption, exact: true }).waitFor();
  const image = details(page).getByRole('img', { name: /Laptop PNG replacement/ }); await image.waitFor(); assert(await image.evaluate(node => node.complete && node.naturalWidth === 64 && node.naturalHeight === 32), 'The exact locally uploaded PNG did not decode.');
  await matrix(page, 'local-source-correction-verified-image', () => image.scrollIntoViewIfNeeded());
  const history = details(page).locator('summary').filter({ hasText: /^Saved revisions$/ }); await history.click();
  await details(page).getByRole('button', { name: 'Open revision 1', exact: true }).click();
  await details(page).getByRole('heading', { name: firstCaption, exact: true }).waitFor();
  await details(page).getByRole('cell', { name: 'local, quoted', exact: true }).waitFor();
  assert((await api(page, `${intakePath}/${imageRecipe.requestId}`)).attachmentOutcome.receipt.attachment.headRevisionId === imageAccepted.id, 'Inspecting the original CSV after local source correction changed the accepted current head.');
  await matrix(page, 'local-source-correction-retains-original-csv', () => details(page).getByRole('table').scrollIntoViewIfNeeded());
  check('Local intake also replaces an exact existing source with a genuine PNG upload, keeping the researcher caption and expected predecessor; final inspection decodes the accepted raster while original CSV history remains retained.');

  await closeDetails(page); await prepare('Metadata admitted before a current-reader fence', 'This request must never upload after a newer read-only observation.');
  const held = service.interceptNextResponse({ method: 'POST', pathname: intakePath, mode: 'hold' }); faults.push(held);
  const beforeFence = uploads().length;
  await intakeForm(page).getByRole('button', { name: 'Import local file', exact: true }).click(); await until(() => held.observation(), 'The final admission acknowledgement was not genuinely held.');
  const fencedRecipe = latestRecipe();
  await database.query("UPDATE project_members SET role='viewer' WHERE project_id=$1 AND user_id=$2", [service.project.id, accounts.owner.id]);
  await refresh(); held.release(); await page.waitForTimeout(350);
  assert(uploads().length === beforeFence, 'An older admission acknowledgement uploaded after a fresh current-reader observation.');
  const fenced = await checkSaved(fencedRecipe); assert(fenced.canUpload === false && fenced.importOutcome.status === 'unconfirmed', 'Read-only admission recovery falsely reported file acceptance.');
  await matrix(page, 'current-reader-fences-local-admission-reply', () => saved(page).scrollIntoViewIfNeeded());
  check('A fresh real reader downgrade fences an older committed admission reply before any bytes are uploaded, while its original saved request remains discoverable and explicitly recoverable.');

  const colleague = await login('colleague'); await openAnalysis(colleague, study); await openOutside(colleague); await openPanel(colleague);
  await library(colleague).getByText('No saved import requests are available here.', { exact: true }).waitFor();
  await api(colleague, `${intakePath}/${firstRecipe.requestId}`, { expected: 404 });
  await openAnalysis(page, otherStudy); await openOutside(page); await openPanel(page);
  await library(page).getByText('No saved import requests are available here.', { exact: true }).waitFor();
  await api(page, `${attachmentPath(otherStudy)}/local-intakes/${firstRecipe.requestId}`, { expected: 404 });
  await openAnalysis(page, study); await openOutside(page); await openPanel(page); await openSaved(firstName);
  await matrix(page, 'private-intake-discovery-current-reader', () => library(page).scrollIntoViewIfNeeded());
  const persistence = await page.evaluate(() => Object.values(localStorage).concat(Object.values(sessionStorage)).join('\n'));
  assert(!persistence.includes(firstRecipe.requestId) && !persistence.includes(firstCaption) && !persistence.includes('local, quoted'), 'Private recipe or scientific bytes leaked into browser persistence.');
  const rows = (await database.query('SELECT request_id FROM research_analysis_local_intakes WHERE analysis_id=$1', [study.id])).rows;
  assert(rows.length === 4 && acceptedRevisions.size === 3, 'Intake recovery duplicated an admission or accepted scientific revision.');
  assert((await database.query('SELECT version FROM research_analyses WHERE id=$1', [study.id])).rows[0].version === analysisVersion, 'Local intake mutated the independent analysis draft.');
  check('Private intake discovery is isolated from another account and analysis, all four recipes and three accepted revisions remain unique, and reopened recovery stores neither scientific bytes nor private recipe bodies in browser persistence.');

  const heldRead = service.interceptNextResponse({ method: 'GET', pathname: `${intakePath}/${firstRecipe.requestId}`, mode: 'hold' }); faults.push(heldRead); faultPaths.add(`${intakePath}/${firstRecipe.requestId}`);
  await saved(page).getByRole('button', { name: 'Check saved import request', exact: true }).click();
  await until(() => heldRead.observation(), 'The authorized original intake read was not genuinely held.');
  await database.query('DELETE FROM project_members WHERE project_id=$1 AND user_id=$2', [service.project.id, accounts.owner.id]);
  expectedDiagnostics.add(`404 ${intakePath}?limit=30`);
  await library(page).getByRole('button', { name: 'Refresh import requests', exact: true }).click();
  await until(async () => !(await saved(page).count()) && !(await library(page).getByText(firstName, { exact: true }).count()), 'A fresh membership denial retained protected intake metadata.');
  heldRead.release(); await page.waitForTimeout(350);
  assert(!(await panel(page).getByText(firstName, { exact: true }).count()), 'An older authorized intake response restored private metadata after scope denial.');
  await page.setViewportSize({ width: 390, height: 844 }); await theme(page, 'dark'); await capture(page, 'intake-membership-denied-390');
  await database.query("INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,'viewer')", [service.project.id, accounts.owner.id]);
  await region(page).getByRole('button', { name: 'Refresh results', exact: true }).click();
  await until(() => library(page).getByRole('button', { name: 'Refresh import requests', exact: true }).isEnabled(), 'Restored current-reader scope did not permit intake discovery.');
  await refresh(); await openSaved(firstName);
  await saved(page).getByRole('button', { name: 'Inspect original attached result', exact: true }).waitFor();
  await matrix(page, 'restored-reader-original-local-intake', () => saved(page).scrollIntoViewIfNeeded());
  check('Actual membership revocation clears protected private intake metadata and fences a held authorized read; restored current-reader membership permits explicit discovery of the same accepted original without new writes.');
  await closeDetails(page); await page.setViewportSize({ width: 1366, height: 768 }); await theme(page, 'light');
  return { extraRevisions: acceptedRevisions.size, analysisVersion };
}

if (require.main === module) require('./verify-analysis-attachments-ui').main({ verifyIntakes }).catch(failure => { console.error(failure.message); process.exitCode = 1; });
module.exports = { verifyIntakes };
