#!/usr/bin/env node
'use strict';

// Real granted files, durable admissions, copies and exact attachments. Tiny
// synthetic CSV/PNG fixtures do not certify scientific or large-file results.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { PNG } = require('pngjs');
const { main: verifyAttachments } = require('./verify-analysis-attachments-ui');
const { verifyIntakes: verifyLocalIntakes } = require('./verify-analysis-local-intake-ui');
const root = path.resolve(__dirname, '..');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const assertOwned = (value, message) => { if (!value) throw new Error(message); };

async function main() {
  const directory = path.join(root, 'playwright/report', 'analysis-server-intake-' + Date.now());
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'traceomics-analysis-server-intake-'));
  const dataRoot = path.join(temporary, 'study'); fs.mkdirSync(dataRoot);
  const csv = Buffer.from('sample,condition,cells\nserver-control,control,12\nserver-treated,treated,19\n');
  const png = new PNG({ width: 64, height: 32 }); png.data.fill(150); for (let index = 3; index < png.data.length; index += 4) png.data[index] = 255;
  const figure = PNG.sync.write(png);
  fs.writeFileSync(path.join(dataRoot, 'summary.csv'), csv); fs.writeFileSync(path.join(dataRoot, 'figure.png'), figure);
  fs.writeFileSync(path.join(dataRoot, 'fenced.csv'), 'sample,cells\nfenced,23\n');
  fs.writeFileSync(path.join(dataRoot, 'unavailable.csv'), 'sample,cells\nunavailable,17\n');
  let grants;
  try {
    return await verifyAttachments({ artifactDirectory: directory,
      configureServerData: async ({ project, accounts }) => {
        grants = [{ id: 'study-data', label: 'Study results', path: dataRoot, grants: [{ projectId: project.id, ownerUserId: accounts.owner.id }] }];
        return { SERVER_DATA_IMPORT_ROOTS: JSON.stringify(grants) };
      },
      verifyIntakes: async env => {
        const local = await verifyLocalIntakes(env);
        const server = await verifyServerIntakes({ ...env, analysisVersion: local.analysisVersion }, { csv, figure, dataRoot, grants });
        return { extraRevisions: local.extraRevisions + server.extraRevisions, analysisVersion: server.analysisVersion };
      },
    });
  } finally {
    const resolved = path.resolve(temporary);
    assertOwned(path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('traceomics-analysis-server-intake-'), 'Unsafe disposable analysis source cleanup target.');
    await fs.promises.rm(resolved, { recursive: true, force: true });
  }
}

async function verifyServerIntakes(env, sources) {
  const { service, database, study, otherStudy, accounts, requests, faults, region, details, api, login, openAnalysis, openOutside,
    closeDetails, matrix, until, assert, check, attachmentPath, faultPaths, restartBrowser, analysisVersion } = env;
  let page;
  const base = attachmentPath(), admissionPath = base + '/server-intakes', intakePath = base + '/intakes';
  const copyPath = `/api/server-data/${service.project.id}/imports`;
  const panel = target => region(target).getByRole('region', { name: 'Result intake', exact: true });
  const saved = target => panel(target).getByRole('region', { name: 'Saved import request', exact: true });
  const form = target => panel(target).getByRole('form', { name: 'Import evidence', exact: true });
  const library = target => panel(target).getByRole('region', { name: 'Your saved imports', exact: true });
  const copies = () => requests.filter(item => item.actor === 'owner' && item.method === 'POST' && item.pathname === copyPath);
  const admissions = () => requests.filter(item => item.actor === 'owner' && item.method === 'POST' && item.pathname === admissionPath);
  const latest = () => admissions().at(-1)?.input;
  const accepted = new Set();
  const setRole = role => database.query("UPDATE project_members SET role=$3 WHERE project_id=$1 AND user_id=$2", [service.project.id, accounts.owner.id, role]);
  async function openPanel(target) {
    await closeDetails(target);
    if (!(await panel(target).isVisible())) await region(target).getByRole('button', { name: /^(?:Import files|Saved imports)$/ }).click();
    await until(() => library(target).getByRole('button', { name: 'Refresh import requests', exact: true }).isEnabled(), 'Unified intake discovery did not settle.');
  }
  async function restart() { page = await restartBrowser(); await openAnalysis(page, study); await openOutside(page); await openPanel(page); }
  async function openSaved(name) {
    const card = library(page).getByRole('listitem').filter({ has: page.getByText(name, { exact: true }) });
    await card.getByRole('button', { name: 'Open saved import request', exact: true }).click();
    await saved(page).getByRole('heading', { name, exact: true }).waitFor();
    await until(() => saved(page).getByRole('button', { name: 'Check saved import request', exact: true }).isEnabled(), 'The exact server intake check did not settle.');
  }
  async function refresh() {
    const waiting = page.waitForResponse(response => response.request().method() === 'GET' && new URL(response.url()).pathname === intakePath);
    await library(page).getByRole('button', { name: 'Refresh import requests', exact: true }).click(); await waiting;
    await until(() => library(page).getByRole('button', { name: 'Refresh import requests', exact: true }).isEnabled(), 'The unified intake refresh remained busy.');
  }
  async function original(recipe) { return api(page, `${intakePath}/${recipe.requestId}`); }
  async function prepare(filename, name, caption) {
    if (await saved(page).count()) await saved(page).getByRole('button', { name: 'Prepare another import', exact: true }).click();
    await form(page).getByRole('button', { name: 'On server', exact: true }).click();
    await form(page).getByRole('button', { name: 'Select server file ' + filename, exact: true }).click();
    await form(page).getByRole('textbox', { name: 'Saved file name', exact: true }).fill(name);
    await form(page).getByRole('textbox', { name: 'Result caption', exact: true }).fill(caption);
  }
  async function checkSaved() {
    await saved(page).getByRole('button', { name: 'Check saved import request', exact: true }).click();
    await until(() => saved(page).getByRole('button', { name: 'Check saved import request', exact: true }).isEnabled(), 'The current original intake check did not settle.');
  }
  async function copied(recipe) {
    await until(async () => (await database.query('SELECT status FROM server_data_imports WHERE request_id=$1 AND owner_user_id=$2', [recipe.requestId, accounts.owner.id])).rows[0]?.status === 'completed', 'The genuine granted server copy did not complete.', 90000);
  }

  await setRole('owner'); await restart();
  const name = 'Granted server summary after reopening', caption = 'Original server CSV evidence with separately retained attachment context.';
  await prepare('summary.csv', name, caption);
  await matrix(page, 'analysis-server-file-selection', () => form(page).getByRole('group', { name: 'File location', exact: true }).scrollIntoViewIfNeeded());
  await matrix(page, 'analysis-server-intake-caption-and-action', () => form(page).getByRole('button', { name: 'Import server file', exact: true }).scrollIntoViewIfNeeded());
  const held = service.interceptNextResponse({ method: 'POST', pathname: admissionPath, mode: 'hold' }); faults.push(held); faultPaths.add(admissionPath);
  const before = copies().length;
  await form(page).getByRole('button', { name: 'Import server file', exact: true }).click(); await until(() => held.observation(), 'The actual server intake admission response was not held.');
  const recipe = latest(); assert(recipe?.requestId && recipe.requestId === recipe.importRequest.requestId && recipe.requestId !== recipe.attachment.requestId, 'Server admission did not freeze separate transfer and attachment UUIDs.');
  assert(copies().length === before && !(await database.query('SELECT 1 FROM server_data_imports WHERE request_id=$1', [recipe.requestId])).rowCount, 'The server copied file bytes before exact intake admission acknowledgement.');
  await restart(); held.release(); await openSaved(name);
  assert(copies().length === before, 'Reopening an acknowledged server intent automatically copied its source.');
  assert((await original(recipe)).importOutcome.status === 'unconfirmed', 'An admitted server intent pretended a copy was accepted.');
  await matrix(page, 'analysis-server-intent-reopened-before-copy', () => saved(page).scrollIntoViewIfNeeded());
  check('A real server-intake admission acknowledgement is lost across a Chromium process restart without copying; private discovery retains exact signed selection, size and separate attachment intent without inventing a pre-copy checksum.');

  faultPaths.add(copyPath);
  let copyAborted = false;
  const abortFirstCopy = async route => {
    if (!copyAborted && route.request().method() === 'POST') { copyAborted = true; await route.abort('failed'); }
    else await route.continue();
  };
  await page.route('**' + copyPath, abortFirstCopy);
  await saved(page).getByRole('button', { name: 'Copy original server file', exact: true }).click();
  await until(() => copies().length === before + 1, 'The deliberately interrupted first server copy was not observed.');
  await checkSaved();
  await page.unroute('**' + copyPath, abortFirstCopy);
  assert((await original(recipe)).importOutcome.status === 'unconfirmed' && !(await database.query('SELECT 1 FROM server_data_imports WHERE request_id=$1', [recipe.requestId])).rowCount, 'A request aborted before reaching the service invented an accepted copy.');
  const dropped = service.interceptNextResponse({ method: 'POST', pathname: copyPath, mode: 'drop' }); faults.push(dropped);
  await saved(page).getByRole('button', { name: 'Copy original server file', exact: true }).click(); await until(() => dropped.observation(), 'The actual server copy response was not dropped.'); await copied(recipe);
  assert(copies().slice(before).length === 2 && copies().slice(before).every(item => JSON.stringify(item.input) === JSON.stringify(recipe.importRequest)), 'The explicit retry changed the frozen original server request.');
  const terminal = (await database.query('SELECT * FROM server_data_imports WHERE request_id=$1 AND owner_user_id=$2', [recipe.requestId, accounts.owner.id])).rows[0];
  assert(terminal.acceptance_json.sha256 === sha(sources.csv) && terminal.acceptance_json.sizeBytes === sources.csv.length, 'Durable server acceptance does not match the actual selected CSV.');
  await setRole('viewer'); const afterCopy = copies().length; await restart(); await openSaved(name);
  const reader = await original(recipe); assert(reader.importOutcome.status === 'accepted' && !reader.canAttach && !reader.canStartImport, 'Current-reader recovery fabricated write authority or lost the real server acceptance.');
  assert(copies().length === afterCopy, 'A reader reopening recopied the original source.');
  await matrix(page, 'analysis-server-reader-original-copy', () => saved(page).scrollIntoViewIfNeeded());
  fs.unlinkSync(path.join(sources.dataRoot, 'summary.csv'));
  await service.restartServerDataRoots([]); await setRole('owner'); await restart(); await openSaved(name);
  const noGrant = await original(recipe);
  assert(noGrant.canContinue && noGrant.canAttach && !noGrant.canStartImport && noGrant.importOutcome.status === 'accepted' && noGrant.importOutcome.receipt.acceptance.sha256 === sha(sources.csv), 'Removing the source grant incorrectly removed authority to attach an already accepted owned file.');
  await matrix(page, 'analysis-server-owned-copy-without-source-grant', () => saved(page).scrollIntoViewIfNeeded());
  check('A copy interrupted before reaching the service remains unconfirmed; an explicit retry keeps its original UUID and settings. Its genuinely accepted but lost reply survives reader downgrade, process restart, source removal and a real service restart with all source grants removed; a writer can still attach the accepted owned snapshot.');

  const lostAttachment = service.interceptNextResponse({ method: 'POST', pathname: base, mode: 'drop' }); faults.push(lostAttachment);
  await saved(page).getByRole('button', { name: 'Attach imported result', exact: true }).click(); await until(() => lostAttachment.observation(), 'The accepted server-intake attachment reply was not genuinely dropped.');
  const first = (await original(recipe)).attachmentOutcome.receipt.acceptedRevision; accepted.add(first.id);
  const newer = await api(page, `${base}/${first.attachmentId}/revisions`, { method: 'POST', expected: 201, body: {
    requestId: crypto.randomUUID(), expectedHeadRevisionId: first.id, reference: first.reference,
    caption: 'Newer server context remains current during original acknowledgement recovery.', suppliedOrigin: first.suppliedOrigin,
  } }); accepted.add(newer.acceptedRevision.id);
  const note = 'Review this exact CSV before replacing its source with a figure.';
  await api(page, `${base}/${first.attachmentId}/revisions/${first.id}/comments`, { method: 'POST', expected: 201, body: { requestId: crypto.randomUUID(), body: note } });
  await restart(); await openSaved(name);
  const recovered = await original(recipe);
  assert(recovered.attachmentOutcome.receipt.acceptedRevision.id === first.id && recovered.attachmentOutcome.receipt.attachment.headRevisionId === newer.acceptedRevision.id, 'Original attachment recovery replaced the later current revision.');
  await saved(page).getByRole('button', { name: 'Inspect original attached result', exact: true }).click();
  await details(page).getByRole('cell', { name: 'server-treated', exact: true }).waitFor();
  await details(page).getByText(note, { exact: true }).waitFor();
  await matrix(page, 'analysis-server-original-csv-and-discussion', () => details(page).getByRole('table').scrollIntoViewIfNeeded());
  check('A genuinely accepted lost attachment response recovers the exact original revision after a newer context revision; deliberate inspection verifies the saved CSV and its revision discussion without moving the current head.');

  await closeDetails(page);
  await saved(page).getByRole('button', { name: 'Prepare another import', exact: true }).click();
  await form(page).getByRole('button', { name: 'On server', exact: true }).click();
  await form(page).getByText('No allowed server folders are configured for this project. Ask the server administrator to grant access to a data folder.', { exact: true }).waitFor();
  await matrix(page, 'analysis-server-empty-grants-recoverable', () => form(page).getByRole('button', { name: 'Refresh server folders', exact: true }).scrollIntoViewIfNeeded());
  await service.restartServerDataRoots(sources.grants);
  await form(page).getByRole('button', { name: 'Refresh server folders', exact: true }).click();
  await form(page).getByRole('button', { name: 'Select server file figure.png', exact: true }).waitFor();
  await matrix(page, 'analysis-server-restored-folders-after-explicit-refresh', () => form(page).scrollIntoViewIfNeeded());
  check('A draft with genuinely removed server-folder grants explains the missing access and offers direct refresh; restored grants appear after an explicit GET-only refresh without copying or re-admitting.');
  await panel(page).getByRole('button', { name: 'Close import panel', exact: true }).click();
  const currentCard = region(page).getByRole('list', { name: 'Attached outside results', exact: true }).getByRole('listitem').filter({ has: page.getByText(newer.acceptedRevision.caption, { exact: true }) });
  await currentCard.getByRole('button', { name: 'Correct caption or source', exact: true }).click();
  const correction = region(page).getByRole('form', { name: 'Correct outside result', exact: true });
  const imageCaption = 'Server PNG source correction preserves the original CSV evidence and discussion.';
  await correction.getByRole('textbox', { name: 'Result caption', exact: true }).fill(imageCaption);
  await correction.getByRole('button', { name: 'Import a file instead', exact: true }).click();
  await prepare('figure.png', 'Granted server PNG replacement', imageCaption);
  await form(page).getByRole('button', { name: 'Import server file', exact: true }).click();
  await until(() => !!latest() && latest().requestId !== recipe.requestId, 'The PNG correction intake was not admitted.');
  const imageIntent = latest();
  await copied(imageIntent); await checkSaved();
  assert(imageIntent.attachment.action === 'correct' && imageIntent.attachment.attachmentId === first.attachmentId && imageIntent.attachment.expectedHeadRevisionId === newer.acceptedRevision.id, 'The server source correction lost its deliberately chosen predecessor or caption.');
  await saved(page).getByRole('button', { name: 'Save original source correction', exact: true }).click();
  await saved(page).getByRole('button', { name: 'Inspect original attached result', exact: true }).waitFor();
  const imageRevision = (await original(imageIntent)).attachmentOutcome.receipt.acceptedRevision; accepted.add(imageRevision.id);
  await saved(page).getByRole('button', { name: 'Inspect original attached result', exact: true }).click();
  const image = details(page).getByRole('img', { name: /Granted server PNG replacement/ }); await image.waitFor();
  assert(await image.evaluate(node => node.complete && node.naturalWidth === 64 && node.naturalHeight === 32), 'The exact copied server PNG did not decode.');
  await matrix(page, 'analysis-server-source-correction-verified-png', () => image.scrollIntoViewIfNeeded());
  await details(page).locator('summary').filter({ hasText: /^Saved revisions$/ }).click(); await details(page).getByRole('button', { name: 'Open revision 1', exact: true }).click();
  await details(page).getByRole('cell', { name: 'server-treated', exact: true }).waitFor(); await details(page).getByText(note, { exact: true }).waitFor();
  assert((await original(imageIntent)).attachmentOutcome.receipt.attachment.headRevisionId === imageRevision.id, 'Reading retained CSV history moved the accepted PNG head.');
  await matrix(page, 'analysis-server-prior-csv-retained-after-png', () => details(page).getByRole('table').scrollIntoViewIfNeeded());
  check('A real granted PNG becomes an explicit source correction with the exact expected head; checked raster inspection and prior CSV/history/discussion remain usable through the same intake and inspection surfaces.');

  await closeDetails(page); await prepare('unavailable.csv', 'Accepted server copy with unavailable owned bytes', 'Acceptance remains recorded even when its private saved file is later unavailable.');
  await form(page).getByRole('button', { name: 'Import server file', exact: true }).click();
  await until(() => !!latest() && latest().requestId !== imageIntent.requestId, 'The unavailable-file intake was not admitted.');
  const orphan = latest(); await copied(orphan); await checkSaved();
  const orphanReceipt = (await original(orphan)).importOutcome.receipt;
  const source = (await database.query('SELECT storage_key FROM managed_artifact_versions WHERE id=$1', [orphanReceipt.acceptance.versionId])).rows[0];
  const absolute = path.resolve(service.storageRoot, ...source.storage_key.split('/'));
  assert(absolute.startsWith(path.resolve(service.storageRoot) + path.sep), 'Owned server fixture deletion escaped its storage root.');
  await database.query('DELETE FROM managed_artifact_versions WHERE id=$1', [orphanReceipt.acceptance.versionId]); fs.unlinkSync(absolute);
  const beforeUnavailable = copies().length; await checkSaved();
  const unavailable = await original(orphan);
  assert(unavailable.importOutcome.status === 'accepted' && unavailable.importOutcome.receipt.availability === 'unavailable' && unavailable.importOutcome.receipt.version === null && unavailable.importOutcome.receipt.acceptance.sha256 === orphanReceipt.acceptance.sha256, 'Owned server file loss erased or substituted the exact acceptance.');
  await saved(page).getByText('Accepted · original file unavailable', { exact: true }).waitFor();
  assert(!(await saved(page).getByRole('button', { name: 'Inspect imported file', exact: true }).count()) && !(await saved(page).getByRole('button', { name: 'Attach imported result', exact: true }).count()) && copies().length === beforeUnavailable, 'Unavailable accepted server bytes offered an attachment, inspection or automatic copy.');
  await matrix(page, 'analysis-server-accepted-owned-file-unavailable', () => saved(page).scrollIntoViewIfNeeded());
  check('Real saved server-file row and byte loss retains immutable acceptance, with no inferred replacement, false inspection, attachment or automatic recopy.');

  await closeDetails(page); await prepare('fenced.csv', 'Server intent before a reader fence', 'A newer current-reader observation must prevent this source copy.');
  const late = service.interceptNextResponse({ method: 'POST', pathname: admissionPath, mode: 'hold' }); faults.push(late);
  const beforeFence = copies().length;
  await form(page).getByRole('button', { name: 'Import server file', exact: true }).click(); await until(() => late.observation(), 'The fence-case actual server admission was not held.');
  const fenced = latest(); await setRole('viewer'); await refresh(); late.release();
  await until(() => saved(page).getByRole('button', { name: 'Check saved import request', exact: true }).isEnabled(), 'The fenced original intent did not settle.');
  assert(copies().length === beforeFence && !(await database.query('SELECT 1 FROM server_data_imports WHERE request_id=$1', [fenced.requestId])).rowCount, 'An older admission acknowledgement copied after a fresh reader observation.');
  await checkSaved(); await matrix(page, 'analysis-server-current-reader-admission-fence', () => saved(page).scrollIntoViewIfNeeded());
  const colleague = await login('colleague');
  await api(colleague, `${intakePath}/${recipe.requestId}`, { expected: 404 });
  const privateList = await api(colleague, intakePath); assert(privateList.items.length === 0, 'A colleague discovered private server intake recipes.');
  await api(page, `${attachmentPath(otherStudy)}/intakes/${recipe.requestId}`, { expected: 404 });
  const rows = (await database.query("SELECT request_id FROM research_analysis_intakes WHERE analysis_id=$1 AND source_kind='server'", [study.id])).rows;
  assert(rows.length === 4 && accepted.size === 3 && copies().length === before + 4, 'Recovery or source correction duplicated a server recipe, copy or attachment revision.');
  assert((await database.query('SELECT version FROM research_analyses WHERE id=$1', [study.id])).rows[0].version === analysisVersion, 'Server intake mutated the independent analysis draft.');
  const stored = await page.evaluate(() => Object.values(localStorage).concat(Object.values(sessionStorage)).join('\n'));
  assert(!stored.includes(recipe.requestId) && !stored.includes(caption) && !stored.includes('server-treated'), 'Private server recipe or scientific file bytes entered Web Storage.');
  check('Current reader authority fences an older server admission before copying; mixed-source records stay private to their owner and analysis, original requests stay unique, and the independent draft and browser persistence remain unchanged.');
  return { extraRevisions: accepted.size, analysisVersion };
}

if (require.main === module) main().catch(failure => { console.error(failure.message); process.exitCode = 1; });
module.exports = { main };
