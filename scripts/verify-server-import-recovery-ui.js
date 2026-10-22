#!/usr/bin/env node
'use strict';

// Actual production HTTPS/auth/PostgreSQL and ordinary server files. The CSV
// fixtures prove transfer/recovery and checked rendering, not scientific validity.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { main: verifyArtifactImports } = require('./verify-artifact-import-recovery-ui');
const root = path.resolve(__dirname, '..');
const assert = (value, message) => { if (!value) throw new Error(message); };
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const sourceBytes = Buffer.from('sample,condition,cells\nserver-control,control,12\nserver-treated,treated,19\n');
const retryBytes = Buffer.from('sample,condition,cells\nexplicit-retry,treated,23\n');
const lostBytes = Buffer.from('sample,condition,cells\nrestart-recovery,treated,29\n');
const fenceBytes = Buffer.from('sample,condition,cells\nfenced-recovery,control,31\n');

async function main() {
  const artifactDirectory = path.join(root, 'playwright/report', 'server-import-recovery-' + Date.now());
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'traceomics-server-recovery-'));
  const dataRoot = path.join(temporary, 'granted-study'); fs.mkdirSync(dataRoot);
  for (const [name, bytes] of [['summary.csv', sourceBytes], ['retry.csv', retryBytes], ['lost.csv', lostBytes], ['fence.csv', fenceBytes]]) fs.writeFileSync(path.join(dataRoot, name), bytes);
  try {
    return await verifyArtifactImports({ artifactDirectory,
      configureServerData: async ({ project, accounts }) => ({ SERVER_DATA_IMPORT_ROOTS: JSON.stringify([
        { id: 'study-data', label: 'Granted study data', path: dataRoot, grants: [{ projectId: project.id, ownerUserId: accounts.owner.id }] },
      ]) }),
      verifyServerImports: async context => verifyRecovery(context, dataRoot),
    });
  } finally {
    const target = path.resolve(temporary);
    assert(path.dirname(target) === path.resolve(os.tmpdir()) && path.basename(target).startsWith('traceomics-server-recovery-'), 'Unsafe disposable server source cleanup target.');
    await fs.promises.rm(target, { recursive: true, force: true });
  }
}

async function verifyRecovery(context, dataRoot) {
  const { service, database, accounts, requests, faults, api, login, openArtifacts, region, select, selectedIs,
    restartBrowser, capture, matrix, setTheme, expectedHttpDiagnostics, faultPaths, until, assert, check } = context;
  const projectId = service.project.id, ownerId = accounts.owner.id;
  const base = '/api/server-data/' + projectId, importsPath = base + '/imports';
  faultPaths.add(importsPath);
  const importer = target => region(target).getByRole('region', { name: 'Import server data', exact: true });
  const history = target => importer(target).getByRole('region', { name: 'Saved server imports', exact: true });
  const outcome = target => importer(target).getByRole('region', { name: 'Server import outcome', exact: true });
  const copies = () => requests.filter(value => value.method === 'POST' && value.pathname === importsPath);
  const rowFor = async requestId => (await database.query('SELECT * FROM server_data_imports WHERE project_id=$1 AND owner_user_id=$2 AND request_id=$3', [projectId, ownerId, requestId])).rows[0];
  const settled = async requestId => { await until(async () => (await rowFor(requestId))?.status === 'completed', 'The actual server copy did not complete.', 90000); return rowFor(requestId); };
  const membership = role => database.query("INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,$3) ON CONFLICT(project_id,user_id) DO UPDATE SET role=EXCLUDED.role", [projectId, ownerId, role]);
  async function browse(target, filename, name) {
    const browseButton = importer(target).getByRole('button', { name: /^(?:Browse server data|Reload authorized data roots)$/ });
    await browseButton.click();
    await importer(target).getByRole('button', { name: 'Select server file ' + filename, exact: true }).click();
    await importer(target).getByLabel('Server artifact name', { exact: true }).fill(name);
  }
  async function start(target) {
    const before = copies().length;
    await importer(target).getByRole('button', { name: 'Import selected server file', exact: true }).click();
    await until(() => copies().length === before + 1, 'The explicit server import did not send one metadata request.');
    return copies().at(-1).input;
  }
  async function saved(target) {
    if (!(await history(target).isVisible())) await importer(target).getByRole('button', { name: 'Saved server imports', exact: true }).click();
    else await history(target).getByRole('button', { name: 'Refresh saved imports', exact: true }).click();
    await until(() => history(target).getByRole('button', { name: 'Refresh saved imports', exact: true }).isEnabled(), 'Saved server import discovery did not settle.');
  }
  async function openSaved(target, requestId) {
    await saved(target);
    const waiting = target.waitForResponse(value => value.request().method() === 'GET' && new URL(value.url()).pathname === importsPath + '/' + requestId);
    await history(target).getByRole('button').filter({ hasText: requestId }).click();
    const response = await waiting, value = await response.json();
    assert(response.status() === 200 && value.requestId === requestId, 'The selected durable import receipt was not returned.');
    await until(() => importer(target).getByRole('button', { name: 'Check server import status', exact: true }).isEnabled(), 'The selected import check did not settle.');
    return value;
  }
  async function checkStatus(target, requestId, expected = 200) {
    if (expected >= 400) expectedHttpDiagnostics.add(`${expected} ${importsPath}/${requestId}`);
    const waiting = target.waitForResponse(value => value.request().method() === 'GET' && new URL(value.url()).pathname === importsPath + '/' + requestId);
    await importer(target).getByRole('button', { name: 'Check server import status', exact: true }).click();
    const response = await waiting; assert(response.status() === expected, 'The explicit server import check returned an unexpected status.'); return response.json();
  }

  await membership('owner');
  let page = await restartBrowser(); await openArtifacts(page);
  const reference = (await api(page, '/api/artifact-versions/' + projectId, { expected: 200 })).value.items.find(value => value.name === 'Unrelated selected reference');
  assert(reference, 'The existing checked reference is missing.'); await select(page, reference);
  await browse(page, 'summary.csv', 'Server summary with exact acceptance');
  await matrix(page, 'server-source-picker', () => importer(page).getByRole('form', { name: 'Save server file snapshot', exact: true }));
  await page.setViewportSize({ width: 1366, height: 768 }); await setTheme(page, 'light');
  const held = service.interceptNextResponse({ method: 'POST', pathname: importsPath, mode: 'hold' }); faults.push(held);
  const firstRequest = await start(page); await until(() => held.observation()?.value?.requestId === firstRequest.requestId, 'The actual server import acknowledgement was not held.');
  const firstRow = await settled(firstRequest.requestId);
  const firstAccepted = firstRow.acceptance_json;
  assert(firstAccepted?.sha256 === sha(sourceBytes) && firstAccepted.sizeBytes === sourceBytes.length, 'The terminal server acceptance does not match the actual source bytes.');
  await select(page, reference); held.release();
  await outcome(page).getByText('Server file saved as an immutable artifact version.', { exact: true }).waitFor();
  assert(await selectedIs(page, reference), 'A late server import reply stole the selected inspection.');
  const imported = (await api(page, '/api/artifact-versions/' + projectId + '/' + firstAccepted.versionId, { expected: 200 })).value;
  await region(page).getByRole('button', { name: 'Inspect imported server version', exact: true }).click();
  await region(page).getByRole('cell', { name: 'server-treated', exact: true }).waitFor();
  assert(await selectedIs(page, imported), 'The explicit imported-version action did not open its exact verified table.');
  await matrix(page, 'server-accepted-checked-table', () => outcome(page));
  await matrix(page, 'server-verified-table-rows', () => region(page).getByRole('table'));
  check('An actual ordinary server CSV is copied and hashed with a durable exact acceptance; held acknowledgement keeps a later inspection selected and explicit inspection verifies the imported table in both themes and responsive layouts.');

  await page.setViewportSize({ width: 1366, height: 768 }); await setTheme(page, 'light');
  await browse(page, 'retry.csv', 'Explicit original server retry');
  let aborted = false;
  const abort = async route => { if (route.request().method() !== 'POST') return route.continue(); aborted = true; await route.abort('failed'); };
  await page.route('**' + importsPath, abort);
  const retryRequest = await start(page);
  await until(() => aborted, 'The real browser transport did not abort before server admission.');
  await importer(page).getByRole('alert').filter({ hasText: 'No import will be submitted again automatically.' }).waitFor();
  await matrix(page, 'server-unconfirmed-copy', () => importer(page).getByRole('alert'));
  await page.setViewportSize({ width: 1366, height: 768 }); await setTheme(page, 'light');
  await page.unroute('**' + importsPath, abort);
  assert(!(await rowFor(retryRequest.requestId)), 'The deliberately pre-upstream-aborted request unexpectedly reached the service.');
  await checkStatus(page, retryRequest.requestId, 404);
  const beforeRetry = copies().length;
  await importer(page).getByRole('button', { name: 'Retry original server import', exact: true }).click();
  await until(() => copies().length === beforeRetry + 1, 'The deliberate original server retry did not send exactly one request.');
  assert(JSON.stringify(copies().at(-1).input) === JSON.stringify(retryRequest), 'The original server retry changed its UUID, source token or parameters.');
  await settled(retryRequest.requestId);
  await outcome(page).getByText('Server file saved as an immutable artifact version.', { exact: true }).waitFor();
  await capture(page, 'server-original-retry-accepted', outcome(page));
  check('An actual pre-upstream transport loss plus receipt404 stays uncertain and frozen; only the explicit retry resends the original UUID, selection token and normalized parameters.');

  await browse(page, 'lost.csv', 'Durable server import after reopening');
  const dropped = service.interceptNextResponse({ method: 'POST', pathname: importsPath, mode: 'drop' }); faults.push(dropped);
  const lostRequest = await start(page);
  await until(() => dropped.observation()?.value?.requestId === lostRequest.requestId, 'The server import reply was not genuinely dropped.');
  const lostRow = await settled(lostRequest.requestId);
  assert(lostRow.acceptance_json?.sha256 === sha(lostBytes), 'The lost-reply import was not durably accepted.');
  await membership('viewer');
  fs.unlinkSync(path.join(dataRoot, 'lost.csv'));
  const copyCount = copies().length;
  page = await restartBrowser(); await openArtifacts(page); await select(page, reference);
  assert(!(await importer(page).getByRole('button', { name: 'Browse server data', exact: true }).count()), 'A fresh project reader received a new-copy control.');
  const reopened = await openSaved(page, lostRequest.requestId);
  assert(reopened.status === 'succeeded' && reopened.canImport === false && reopened.acceptance.sha256 === sha(lostBytes)
    && reopened.acceptance.versionId === lostRow.version_id && reopened.availability === 'recorded', 'Reopened reader recovery lost original acceptance after the source disappeared.');
  assert(copies().length === copyCount && await selectedIs(page, reference), 'Saved import discovery or recovery recopied data or changed inspection.');
  await matrix(page, 'server-reader-reopened-outcome', () => outcome(page));
  const replay = (await api(page, importsPath, { method: 'POST', body: lostRequest, expected: 200 })).value;
  assert(replay.replayed && !replay.canImport && replay.acceptance.sha256 === sha(lostBytes), 'A current reader could not recover its accepted exact request by replay after source removal.');
  await api(page, importsPath, { method: 'POST', body: { ...lostRequest, name: 'Changed frozen meaning' }, expected: 409 });
  await api(page, importsPath, { method: 'POST', body: { ...lostRequest, requestId: crypto.randomUUID() }, expected: 403 });
  check('A genuine Chromium process restart discovers the owner-private import after writer-to-reader downgrade and source removal; original replay returns acceptance before fresh policy/source checks while changed meaning and fresh copies are denied.');

  const ownedFile = path.resolve(service.storageRoot, ...lostRow.storage_key.split('/'));
  assert(ownedFile.startsWith(path.resolve(service.storageRoot) + path.sep) && fs.lstatSync(ownedFile).isFile() && !fs.lstatSync(ownedFile).isSymbolicLink(), 'The disposable missing-file target escaped owned storage.');
  await database.query('DELETE FROM managed_artifact_versions WHERE id=$1 AND project_id=$2 AND owner_user_id=$3', [lostRow.version_id, projectId, ownerId]);
  fs.unlinkSync(ownedFile);
  const unavailable = await checkStatus(page, lostRequest.requestId);
  assert(unavailable.status === 'succeeded' && unavailable.availability === 'unavailable' && unavailable.version === null
    && unavailable.acceptance.sha256 === sha(lostBytes) && unavailable.acceptance.versionId === lostRow.version_id, 'Loss of mutable managed metadata/bytes erased or fabricated the terminal acceptance.');
  await outcome(page).getByText('The server import was accepted. Its saved file is currently unavailable.', { exact: true }).waitFor();
  await until(async () => !(await region(page).getByRole('button', { name: 'Inspect imported server version', exact: true }).count()), 'A fresh unavailable receipt left a misleading imported-version action.');
  await matrix(page, 'server-accepted-file-unavailable', () => outcome(page));
  assert(!(await importer(page).getByRole('button', { name: 'Retry original server import', exact: true }).count()), 'An accepted missing file offered a duplicate original copy.');
  const colleague = await login('colleague');
  const privateList = (await api(colleague, importsPath, { expected: 200 })).value;
  assert(privateList.items.length === 0, 'Another account discovered owner-private server import metadata.');
  await api(colleague, importsPath + '/' + lostRequest.requestId, { expected: 404 });
  check('Removing only the owned mutable managed row and its bytes leaves exact original acceptance visible as unavailable; current project colleagues cannot discover or open another owner’s requests.');

  await page.setViewportSize({ width: 390, height: 844 });
  const heldRead = service.interceptNextResponse({ method: 'GET', pathname: importsPath + '/' + lostRequest.requestId, mode: 'hold' }); faults.push(heldRead);
  await importer(page).getByRole('button', { name: 'Check server import status', exact: true }).click();
  await until(() => heldRead.observation()?.value?.requestId === lostRequest.requestId, 'The authorized exact server receipt read was not held.');
  await database.query('DELETE FROM project_members WHERE project_id=$1 AND user_id=$2', [projectId, ownerId]);
  expectedHttpDiagnostics.add(`404 ${importsPath}`);
  expectedHttpDiagnostics.add(`404 /api/artifact-versions/${projectId}`);
  await history(page).getByRole('button', { name: 'Refresh saved imports', exact: true }).click();
  await until(async () => !(await outcome(page).count()) && !(await history(page).getByRole('button').filter({ hasText: lostRequest.requestId }).count()), 'Membership denial did not clear protected server import metadata.');
  heldRead.release(); await page.waitForTimeout(250);
  assert(!(await outcome(page).count()), 'An older authorized receipt response repopulated protected metadata after denial.');
  await capture(page, 'server-membership-denied-dark-390', importer(page));
  await membership('viewer'); await saved(page); await openSaved(page, lostRequest.requestId);
  assert(await outcome(page).getByText('The server import was accepted. Its saved file is currently unavailable.', { exact: true }).isVisible(), 'Restored current membership did not recover the unchanged original outcome.');
  check('A fresh membership denial clears discovery and exact receipt details and fences an older held authorized response; explicit discovery after membership restoration recovers the original record.');

  await membership('owner'); page = await restartBrowser(); await openArtifacts(page);
  await browse(page, 'fence.csv', 'Accepted server import with a later reader fence');
  const heldCopy = service.interceptNextResponse({ method: 'POST', pathname: importsPath, mode: 'hold' }); faults.push(heldCopy);
  const fencedRequest = await start(page);
  await until(() => heldCopy.observation()?.value?.requestId === fencedRequest.requestId, 'The fence-case server acknowledgement was not held.'); await settled(fencedRequest.requestId);
  await membership('viewer'); await saved(page);
  await until(async () => !(await importer(page).getByRole('form', { name: 'Save server file snapshot', exact: true }).count()), 'A fresh reader discovery failed to fence the older copy action.');
  heldCopy.release(); await page.waitForTimeout(250);
  assert(!(await outcome(page).count()), 'The fenced old copy response was accepted into current UI state.');
  await checkStatus(page, fencedRequest.requestId);
  await outcome(page).getByText('Server file saved as an immutable artifact version.', { exact: true }).waitFor();
  await capture(page, 'server-fresh-reader-fences-older-copy', outcome(page));
  assert(!(await importer(page).getByText(/No authorized server data roots are configured/).count()), 'A reader downgrade falsely claimed that the still-granted source root was not configured.');
  const rows = (await database.query('SELECT request_id,acceptance_json FROM server_data_imports WHERE project_id=$1 AND owner_user_id=$2', [projectId, ownerId])).rows;
  assert(rows.length === 4 && new Set(rows.map(value => value.request_id)).size === 4 && rows.every(value => value.acceptance_json), 'Recovery duplicated or erased a terminal server import.');
  assert(copies().length === copyCount + 4, 'Unexpected server copy/replay requests occurred during recovery.');
  const leaked = await page.evaluate(values => [localStorage, sessionStorage].some(store => Object.values(store).some(value => values.some(needle => value.includes(needle)))), [sourceBytes, retryBytes, lostBytes, fenceBytes].map(value => value.toString('utf8')));
  assert(!leaked, 'Scientific server source bytes were persisted in browser Web Storage.');
  check('A fresh reader capability response fences an older held copy acknowledgement while preserving its real committed acceptance for explicit recovery; four terminal imports remain unique and no server file payload enters browser persistence.');
  return { networkFaults: 3 };
}

if (require.main === module) main().catch(failure => { console.error(failure.message); process.exitCode = 1; });
module.exports = { main };
