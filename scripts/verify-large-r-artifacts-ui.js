#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { chromium } = require('playwright');
const { Client } = require('pg');
const { createDesktopTunnelServiceFixture } = require('./desktop-tunnel-service-fixture.cjs');

const root = path.resolve(__dirname, '..');
const assert = (value, message) => { if (!value) throw new Error(message); };
const payloadBytes = 224 * 1024 ** 2;
const artifactPolicy = {
  PRIVATE_R_MAX_OUTPUT_BYTES: String(256 * 1024 ** 2),
  PRIVATE_R_MANAGED_QUOTA_BYTES: String(320 * 1024 ** 2),
  PRIVATE_R_MAX_INPUT_FILE_BYTES: String(512 * 1024 ** 2),
  PRIVATE_R_MAX_INPUT_TOTAL_BYTES: String(1024 ** 3),
  PRIVATE_R_DISK_RESERVE_BYTES: String(1024 ** 3),
  PRIVATE_R_TRANSFER_TIMEOUT_SECONDS: '900',
};

async function freePort() {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function digestFile(filename) {
  const hash = crypto.createHash('sha256');
  let sizeBytes = 0;
  for await (const chunk of fs.createReadStream(filename, { highWaterMark: 256 * 1024 })) {
    sizeBytes += chunk.length;
    hash.update(chunk);
  }
  return { sizeBytes, sha256: hash.digest('hex') };
}

function ownedStoragePath(storageRoot, storageKey) {
  const storage = path.resolve(storageRoot);
  const filename = path.resolve(storage, ...storageKey.split('/'));
  assert(filename.startsWith(storage + path.sep), 'The saved artifact is outside the disposable storage root.');
  return filename;
}

async function main() {
  const image = process.env.EXPERT_R_SANDBOX_IMAGE;
  assert(/^(?:[^\s@]+@)?sha256:[a-f0-9]{64}$/.test(image || ''),
    'Set EXPERT_R_SANDBOX_IMAGE to the reviewed immutable persistent-kernel image.');
  const directory = path.join(root, 'playwright', 'report', 'large-r-artifacts-' + Date.now());
  fs.mkdirSync(directory, { recursive: true });
  const port = await freePort();
  const token = crypto.randomBytes(32).toString('hex');
  const checks = [], errors = [], browserResponses = [], browserTasks = [], timings = {};
  const check = message => { checks.push(message); console.log('PASS: ' + message); };
  let service, broker, database, browser, page;
  try {
    service = await createDesktopTunnelServiceFixture({ artifactDirectory: directory,
      webEnvironment: { ...artifactPolicy, EXPERT_R_ENABLED: 'true', EXPERT_R_ACCESS_POLICY: 'project-roles',
        EXPERT_R_SANDBOX_URL: `http://127.0.0.1:${port}`, EXPERT_R_SANDBOX_TOKEN: token } });
    process.env.STORAGE_ROOT = service.storageRoot;
    database = new Client({ connectionString: service.databaseUrl });
    await database.connect();
    const environment = { ...process.env, ...artifactPolicy, NODE_ENV: 'test',
      EXPERT_R_SANDBOX_TOKEN: token, EXPERT_R_SANDBOX_IMAGE: image,
      EXPERT_R_SANDBOX_WORK_ROOT: path.join(directory, 'broker-work'),
      PRIVATE_R_KERNEL_ENABLED: 'true', PRIVATE_R_KERNEL_IDLE_SECONDS: '900' };
    broker = require('../backend/expertSandboxBroker').createExpertSandboxBroker(environment);
    await broker.startReconciliation();
    await new Promise(resolve => broker.listen(port, '127.0.0.1', resolve));
    const capability = await fetch(`http://127.0.0.1:${port}/capabilities`, {
      headers: { Authorization: 'Bearer ' + token } }).then(response => response.json());
    assert(capability.persistentKernel === true && capability.persistentKernelPublications === true,
      'The immutable image did not pass the independent kernel and publication probes.');

    const certificate = new crypto.X509Certificate(fs.readFileSync(service.certificatePath));
    const authority = new crypto.X509Certificate(fs.readFileSync(service.caCertificatePath));
    assert(certificate.verify(authority.publicKey) && certificate.checkHost(new URL(service.endpoint).hostname),
      'The disposable HTTPS certificate does not match its authority and hostname.');
    const spki = crypto.createHash('sha256').update(certificate.publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
    // This browser trusts only the disposable fixture's leaf key. The app keeps
    // normal production TLS validation, which has separate native acceptance.
    browser = await chromium.launch({ headless: true, args: [
      '--host-resolver-rules=MAP ' + new URL(service.endpoint).hostname + ' 127.0.0.1',
      '--ignore-certificate-errors-spki-list=' + spki,
    ] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => {
      const pathname = new URL(response.url()).pathname;
      if (!/^\/api\/(?:private-r-kernels|artifact-versions)\//.test(pathname)) return;
      const task = (async () => {
        const contentType = response.headers()['content-type'] || '';
        assert(!/application\/(?:x-r-rds|octet-stream)/i.test(contentType), 'The browser received a full RDS object.');
        const declaredBytes = Number(response.headers()['content-length']);
        assert(Number.isSafeInteger(declaredBytes) && declaredBytes >= 0 && declaredBytes <= 256 * 1024,
          'An artifact response did not declare a bounded metadata/preview length.');
        const data = await response.body();
        browserResponses.push({ pathname, status: response.status(), sizeBytes: data.length });
        assert(data.length <= 256 * 1024, 'A browser artifact response exceeded the bounded metadata/preview envelope.');
      })().catch(error => { errors.push(error.message); });
      browserTasks.push(task);
    });
    await page.goto(service.endpoint);
    await page.getByPlaceholder('researcher@lab.edu').fill(service.account.email);
    await page.getByLabel('Password', { exact: true }).fill(service.account.password);
    await page.getByRole('button', { name: /Open Workbench/ }).click();
    await page.getByRole('button', { name: /^Advanced analysis,/ }).click();
    await page.getByRole('button', { name: 'Interactive console', exact: true }).click();
    const consoleUi = page.getByRole('region', { name: 'Private R console', exact: true });
    const limits = consoleUi.getByLabel('Private R artifact limits');
    await limits.getByText(/256.0 MiB per saved file/).waitFor();
    assert((await limits.innerText()).includes('Managed artifact quota: 320.0 MiB'), 'The console shows a fabricated default quota.');
    check('Authenticated production UI shows the actual configured large-artifact ceilings and quota.');
    const started = Date.now();
    await consoleUi.getByRole('button', { name: 'Start private session', exact: true }).click();
    await consoleUi.getByText('Session ready · unsaved memory available', { exact: true }).waitFor({ timeout: 125_000 });
    timings.kernelStartMs = Date.now() - started;
    const firstKernel = (await database.query('SELECT * FROM private_r_kernels ORDER BY created_at DESC LIMIT 1')).rows[0];
    assert(firstKernel?.status === 'ready', 'The UI did not start a genuine ready R kernel.');

    const output = consoleUi.getByRole('region', { name: 'R command output' });
    async function run(source, order) {
      await consoleUi.getByLabel('R console source').fill(source);
      await consoleUi.getByRole('button', { name: 'Run R cell', exact: true }).click();
      await output.getByText('Command ' + order + ' · completed', { exact: true }).waitFor({ timeout: 125_000 });
    }
    let began = Date.now();
    await run(`set.seed(2026)
entropy_chunk <- as.raw(sample.int(256L, 1024L * 1024L, replace=TRUE) - 1L)
large_object <- list(payload=rep(entropy_chunk, 224L), label="Exact large private artifact")
rm(entropy_chunk)
stopifnot(length(large_object$payload)==${payloadBytes}L)
invisible(gc())
cat("Payload bytes:",length(large_object$payload),"; label:",large_object$label)`, 1);
    timings.createObjectMs = Date.now() - began;
    assert((await output.getByLabel('R stdout').innerText()).includes('Payload bytes: ' + payloadBytes),
      'The actual R binding did not exceed the former 200 MiB ceiling.');
    check('Free R creates a genuine 224 MiB entropy payload inside the private isolated kernel.');

    async function save(name, previousVersionId = '') {
      await consoleUi.getByLabel('R output type', { exact: true }).selectOption('object');
      await consoleUi.getByLabel('Existing R binding', { exact: true }).fill('large_object');
      await consoleUi.getByLabel('Saved output name', { exact: true }).fill(name);
      await consoleUi.getByLabel('Version to extend', { exact: true }).selectOption(previousVersionId);
      const pending = page.waitForResponse(response => response.request().method() === 'POST'
        && new URL(response.url()).pathname.endsWith('/publications'), { timeout: 950_000 });
      await consoleUi.getByRole('button', { name: 'Save object', exact: true }).click();
      if (!previousVersionId) {
        await consoleUi.getByRole('button', { name: 'Saving object…', exact: true }).waitFor();
        await consoleUi.getByRole('form', { name: 'Save R output', exact: true }).screenshot({ path: path.join(directory, 'large-rds-save-in-progress.png') });
      }
      const response = await pending;
      return { response, value: await response.json() };
    }
    began = Date.now();
    const saved = await save('Large private payload');
    timings.saveObjectMs = Date.now() - began;
    assert(saved.response.ok() && saved.value.publication?.status === 'completed' && saved.value.version?.reference,
      'Saving the full large binding did not yield a completed durable publication.');
    const version = saved.value.version;
    const savedPreview = consoleUi.getByRole('region', { name: 'Saved R artifact preview', exact: true });
    await savedPreview.getByRole('heading', { name: 'Large private payload · v1', exact: true }).waitFor();
    await savedPreview.getByText('Checksum verified for this saved version', { exact: true }).waitFor();
    assert(version.sizeBytes > 200 * 1024 ** 2 && version.sizeBytes <= 256 * 1024 ** 2,
      'The saved RDS bytes do not satisfy the actual configured large-object envelope.');
    assert((await savedPreview.innerText()).includes(version.sizeBytes.toLocaleString() + ' bytes'),
      'The saved preview does not show the exact physical byte size.');
    assert((await savedPreview.innerText()).includes('The full RDS object stays in server storage'),
      'The metadata-only RDS preview does not explain where its full contents remain.');
    const row = (await database.query('SELECT * FROM managed_artifact_versions WHERE id=$1', [version.versionId])).rows[0];
    assert(row && row.checksum_sha256 === version.sha256 && Number(row.size_bytes) === version.sizeBytes
      && version.reference.sha256 === version.sha256, 'PostgreSQL metadata and the retained version reference disagree.');
    const filename = ownedStoragePath(service.storageRoot, row.storage_key);
    began = Date.now();
    const physical = await digestFile(filename);
    timings.verifySavedBytesMs = Date.now() - began;
    assert(physical.sha256 === version.sha256 && physical.sizeBytes === version.sizeBytes,
      'The immutable saved RDS bytes differ from their size/checksum reference.');
    await savedPreview.screenshot({ path: path.join(directory, 'large-rds-verified-metadata.png') });
    check('Explicit UI save persists full RDS bytes above 200 MiB with matching physical size, streamed SHA-256, PostgreSQL lineage, and exact saved reference.');

    const light = page.getByRole('button', { name: 'Switch to light mode', exact: true });
    if (await light.isVisible()) await light.click();
    await consoleUi.getByLabel('Private R artifact limits').screenshot({ path: path.join(directory, 'large-artifact-limits-light.png') });
    await page.getByRole('button', { name: 'Switch to dark mode', exact: true }).click();
    await savedPreview.screenshot({ path: path.join(directory, 'large-rds-metadata-dark.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await savedPreview.scrollIntoViewIfNeeded();
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'The large artifact console overflows the narrow viewport.');
    await savedPreview.screenshot({ path: path.join(directory, 'large-rds-metadata-narrow.png') });
    await page.setViewportSize({ width: 1440, height: 1000 });
    check('Large saved size, checksum, policy and reopening instructions remain usable in light, dark and 390-pixel layouts.');

    const rejected = await save('Large private payload', version.versionId);
    assert(!rejected.response.ok() || rejected.value.publication?.status === 'failed',
      'A replacement exceeding the configured retained-version quota succeeded.');
    const quotaMessage = rejected.value.error || rejected.value.publication?.message || '';
    assert(/quota|capacity|space|limit/i.test(quotaMessage), 'The rejected save did not explain its capacity or quota limit.');
    await consoleUi.getByText(quotaMessage, { exact: true }).waitFor();
    const versions = (await database.query('SELECT * FROM managed_artifact_versions WHERE artifact_id=$1', [version.artifactId])).rows;
    assert(versions.length === 1 && versions[0].id === version.versionId,
      'A failed replacement created a partial version or changed the original version identity.');
    const afterFailure = await digestFile(filename);
    assert(afterFailure.sha256 === physical.sha256 && afterFailure.sizeBytes === physical.sizeBytes,
      'The failed replacement changed immutable saved bytes.');
    await consoleUi.getByRole('button', { name: 'Inspect Large private payload · v1', exact: true }).click();
    await savedPreview.getByText('Checksum verified for this saved version', { exact: true }).waitFor();
    await savedPreview.screenshot({ path: path.join(directory, 'large-rds-retained-after-quota-failure.png') });
    check('A real quota rejection explains the failure and preserves the original complete RDS version, checksum and inspectable metadata.');

    await consoleUi.getByRole('button', { name: 'Stop session', exact: true }).click();
    await consoleUi.getByRole('button', { name: 'Stop and discard unsaved memory', exact: true }).click();
    await consoleUi.getByText('Session stopped · unsaved memory lost', { exact: true }).waitFor();
    await consoleUi.getByRole('checkbox', { name: 'Use Large private payload', exact: true }).check();
    began = Date.now();
    await consoleUi.getByRole('button', { name: 'Start private session', exact: true }).click();
    await consoleUi.getByText('Session ready · unsaved memory available', { exact: true }).waitFor({ timeout: 950_000 });
    timings.reopenKernelMs = Date.now() - began;
    const reopenedKernel = (await database.query('SELECT * FROM private_r_kernels ORDER BY created_at DESC LIMIT 1')).rows[0];
    assert(reopenedKernel.id !== firstKernel.id && reopenedKernel.runtime_generation !== firstKernel.runtime_generation
      && reopenedKernel.inputs_json.some(input => input.versionId === version.versionId
        && input.checksumSha256 === version.sha256 && Number(input.sizeBytes) === version.sizeBytes),
    'The fresh generation did not pin the exact saved RDS version, checksum and size.');
    began = Date.now();
    await run(`stopifnot(!exists("large_object"))
reopened <- read_input(${JSON.stringify(version.versionId)})
stopifnot(identical(reopened$label,"Exact large private artifact"), length(reopened$payload)==${payloadBytes}L)
set.seed(2026)
expected_chunk <- as.raw(sample.int(256L,1024L*1024L,replace=TRUE)-1L)
for (chunk_number in seq_len(224L)) {
  offset <- (chunk_number-1L)*length(expected_chunk)
  stopifnot(identical(reopened$payload[offset+seq_along(expected_chunk)], expected_chunk))
}
cat("Verified every saved payload byte:",length(reopened$payload),"; exact version:",${JSON.stringify(version.versionId)})`, 1);
    timings.reopenAndVerifyRMs = Date.now() - began;
    assert((await output.getByLabel('R stdout').innerText()).includes('Verified every saved payload byte: ' + payloadBytes),
      'The fresh R generation did not verify the full saved content.');
    await output.screenshot({ path: path.join(directory, 'large-rds-fresh-session-content-verified.png') });
    check('A fresh private R generation reopens the exact immutable version and verifies every one of its 234,881,024 payload bytes without inheriting previous variables.');

    await database.query('DELETE FROM project_members WHERE project_id=$1 AND user_id=$2',
      [service.project.id, firstKernel.owner_user_id]);
    await consoleUi.getByRole('button', { name: 'Refresh session status', exact: true }).click();
    await consoleUi.getByRole('alert').waitFor();
    assert(await consoleUi.getByRole('region', { name: 'R command output' }).count() === 0
      && await consoleUi.getByRole('region', { name: 'Saved R artifact preview' }).count() === 0
      && await consoleUi.getByLabel('R command journal').count() === 0,
    'Revoked project membership retained private saved metadata or R content in the console.');
    check('Membership revocation denies live saved-artifact access and clears the retained private R content and metadata from the UI.');

    await Promise.all(browserTasks);
    assert(errors.length === 0, 'The compiled production browser raised an application or artifact-transfer error: ' + errors.join('; '));
    assert(browserResponses.length > 0 && browserResponses.every(response => response.sizeBytes <= 256 * 1024),
      'The browser response envelope was not observed or exceeded bounded metadata sizes.');
    check('Observed browser APIs carry only bounded metadata/console previews; full large RDS bytes stay between the service, broker disk and isolated R runtime.');
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ passed: true, checks,
      browserErrors: errors, image, payloadBytes, reference: version.reference,
      savedBytes: physical, timings, maximumBrowserResponseBytes: Math.max(...browserResponses.map(response => response.sizeBytes)),
      browserResponses }, null, 2));
    console.log('Large R artifact UI acceptance passed; report: ' + directory);
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(directory, 'failure.png'), fullPage: true }).catch(() => {});
    throw error;
  } finally {
    await browser?.close();
    await database?.end();
    if (broker?.listening) await new Promise((resolve, reject) => broker.close(error => error ? reject(error) : resolve()));
    await service?.stop();
    const work = path.resolve(directory, 'broker-work');
    assert(work.startsWith(path.resolve(directory) + path.sep), 'Invalid owned kernel-work cleanup target.');
    await fs.promises.rm(work, { recursive: true, force: true });
  }
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
