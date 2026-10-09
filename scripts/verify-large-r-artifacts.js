'use strict';

// Disposable pinned-image acceptance: stream a genuine RDS larger than the
// entire private scratch tmpfs, then reopen its exact checksum-pinned version.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createPrivateKernelRuntime, runCommand, PRIVATE_KERNEL_LABEL: LABEL } = require('../backend/privateKernelRuntime');
const { discoverExpertRuntimeEnvironment } = require('../backend/expertSandboxBroker');
const { summarizeEnvironmentManifest, environmentBytes } = require('../backend/rEnvironment');
const { generatePrivateKernelExportSource } = require('../backend/privateKernelExports');
const { createLocalStorageProvider } = require('../backend/storage');

const image = String(process.env.EXPERT_R_SANDBOX_IMAGE || '');
if (!/^(?:[^\s@]+@)?sha256:[0-9a-f]{64}$/.test(image)) throw new Error('Set an immutable reviewed R image.');
const id = prefix => prefix + crypto.randomBytes(12).toString('hex');
const directory = path.resolve('playwright/report', `large-r-artifacts-${Date.now()}`);
const env = { ...process.env, NODE_ENV: 'test', PRIVATE_R_KERNEL_ENABLED: 'true',
  EXPERT_R_SANDBOX_IMAGE: image, EXPERT_R_SANDBOX_WORK_ROOT: path.join(directory, 'work') };
const runtimes = [], checks = [];
let peakBrokerRss = 0;
const sample = setInterval(() => { peakBrokerRss = Math.max(peakBrokerRss, process.memoryUsage().rss); }, 25);
sample.unref();
const check = name => { checks.push(name); console.log(`PASS ${checks.length}: ${name}`); };

async function main() {
  await fs.mkdir(directory, { recursive: true });
  const manifest = await discoverExpertRuntimeEnvironment(env, runCommand), environment = summarizeEnvironmentManifest(manifest);
  await fs.writeFile(path.join(directory, 'environment.json'), environmentBytes(manifest));
  const provider = createLocalStorageProvider({ root: path.join(directory, 'storage') });
  const runtime = createPrivateKernelRuntime({ env, provider, environmentManifest: manifest }); runtimes.push(runtime);
  assert.equal((await runtime.initialize()).streamedPublications, true);
  const scope = { ownerUserId: 1201, projectId: 'large_r_acceptance', workspaceId: 'large_workspace' }, kernelId = id('pk_');
  const started = await runtime.start({ ...scope, kernelId, environment, inputs: [] });
  const exact = { ...scope, generation: started.generation };
  let order = 0;
  const execute = source => runtime.execute(exact, kernelId, { executionId: id('pex_'), order: ++order, source });
  const created = await execute('large_object <- lapply(seq_len(224L), function(k) as.raw((seq_len(1048576L) + k) %% 256L)); cat(sum(lengths(large_object)))');
  assert.equal(created.status, 'completed', JSON.stringify(created)); assert.match(created.stdout, /234881024/);
  check('genuine isolated R creates a 224 MiB object while broker receives only bounded console output');
  const publicationId = id('pub_'), versionId = id('av_');
  const spec = { publicationId, generation: started.generation, type: 'object', binding: 'large_object', stream: true,
    maxBytes: 256 * 1024 ** 2, executionId: id('pex_'), order: ++order,
    internalStorageKey: `projects/${scope.projectId}/artifacts/${versionId}/content.rds` };
  spec.source = generatePrivateKernelExportSource(spec);
  const before = process.memoryUsage().rss, began = Date.now();
  const saved = await runtime.export(exact, kernelId, spec);
  const publicationMs = Date.now() - began;
  assert.equal(saved.status, 'completed', JSON.stringify(saved)); assert.ok(saved.file.sizeBytes > 200 * 1024 ** 2);
  assert.ok(saved.file.sizeBytes < spec.maxBytes); await provider.inspect(saved.file.internalStorageKey, saved.file);
  assert.deepEqual((await runtime.export(exact, kernelId, spec)).file, saved.file);
  check('named RDS streams to durable private disk over 200 MiB, verifies checksum, and reuses its immutable receipt');
  const names = (await runCommand('docker', ['ps', '--filter', `label=${LABEL}.kernel=${kernelId}`, '--format', '{{.Names}}'])).stdout.trim();
  const host = JSON.parse((await runCommand('docker', ['inspect', names, '--format', '{{json .HostConfig}}'])).stdout);
  assert.equal(host.ReadonlyRootfs, true); assert.equal(host.NetworkMode, 'none'); assert.equal(host.Privileged, false);
  assert.match(host.Tmpfs['/work'], /size=200m/); assert.equal(host.Binds?.length || 0, 0);
  const usedScratch = (await runCommand('docker', ['exec', '--user', '10001:10001', names, 'du', '-s', '-B1', '/work'])).stdout;
  assert.ok(Number(usedScratch.trim().split(/\s+/)[0]) < 2 * 1024 ** 2);
  check('large publication leaves scratch bounded at 200 MiB and uses no writable host storage mount');
  const tooSmall = { ...spec, publicationId: id('pub_'), executionId: id('pex_'), order: ++order,
    maxBytes: 1024 ** 2, internalStorageKey: `projects/${scope.projectId}/artifacts/${id('av_')}/content.rds` };
  tooSmall.source = generatePrivateKernelExportSource(tooSmall);
  const refused = await runtime.export(exact, kernelId, tooSmall);
  assert.equal(refused.status, 'failed', JSON.stringify(refused)); assert.equal(refused.file, undefined);
  assert.equal(refused.result.error.code, 'PRIVATE_KERNEL_PUBLICATION_LIMIT');
  await assert.rejects(provider.inspect(tooSmall.internalStorageKey));
  assert.equal((await execute('cat(length(large_object), lengths(large_object)[224L])')).status, 'completed');
  await provider.inspect(saved.file.internalStorageKey, saved.file);
  check('hard stream byte cutoff removes partial files, preserves the existing version and keeps prior R variables usable');
  await runtime.stop(exact, kernelId);
  const reopenedId = id('pk_');
  const reopened = await runtime.start({ ...scope, kernelId: reopenedId, environment, inputs: [{
    id: 'saved_large_object', versionId, name: 'large object', type: 'object', format: 'rds', role: 'input',
    ...saved.file, checksumSha256: saved.file.checksumSha256,
  }] });
  const validated = await runtime.execute({ ...scope, generation: reopened.generation }, reopenedId, {
    executionId: id('pex_'), order: 1,
    source: 'restored <- read_input("saved_large_object"); stopifnot(length(restored)==224L); for (k in seq_len(224L)) stopifnot(identical(restored[[k]], as.raw((seq_len(1048576L)+k) %% 256L))); cat("all 234881024 bytes verified")',
  });
  assert.equal(validated.status, 'completed', JSON.stringify(validated)); assert.match(validated.stdout, /all 234881024 bytes verified/);
  check('fresh isolated R session reopens the exact artifact version and verifies every original byte');
  const reopenedScope={...scope,generation:reopened.generation};
  const active=await runtime.execute(reopenedScope,reopenedId,{executionId:id('pex_'),order:2,
    source:'makeActiveBinding("slow_stream", function(value) { Sys.sleep(100); data.frame(count=1L) }, .GlobalEnv)'});
  assert.equal(active.status,'completed');
  function slowSave(generation,nextOrder) {
    const value={publicationId:id('pub_'),generation,type:'table',binding:'slow_stream',stream:true,maxBytes:1048576,
      executionId:id('pex_'),order:nextOrder,internalStorageKey:`projects/${scope.projectId}/artifacts/${id('av_')}/content.csv`};
    value.source=generatePrivateKernelExportSource(value);return value;
  }
  const interruptedSpec=slowSave(reopened.generation,3),pendingInterrupted=runtime.export(reopenedScope,reopenedId,interruptedSpec);
  await new Promise(resolve=>setTimeout(resolve,500));
  const interrupted=await runtime.interrupt(reopenedScope,reopenedId,{executionId:interruptedSpec.executionId,order:3,requestId:crypto.randomUUID()});
  assert.equal(interrupted.outcome,'interrupted',JSON.stringify(interrupted));assert.equal(interrupted.status,'ready');
  assert.equal((await pendingInterrupted).status,'failed');await assert.rejects(provider.inspect(interruptedSpec.internalStorageKey));
  check('interrupting a streamed save confirms R idle, removes its reader and partial bytes, and retains the session');
  const stoppedSpec=slowSave(reopened.generation,4),pendingStop=runtime.export(reopenedScope,reopenedId,stoppedSpec);
  await new Promise(resolve=>setTimeout(resolve,500));await runtime.stop(reopenedScope,reopenedId);
  assert.equal((await pendingStop).status,'unknown');await assert.rejects(provider.inspect(stoppedSpec.internalStorageKey));
  assert.equal((await runtime.export(reopenedScope,reopenedId,stoppedSpec)).status,'unknown');await provider.inspect(saved.file.internalStorageKey,saved.file);
  check('stopping a streamed save removes its owned producer and preserves the old artifact without replay');
  const deadlineRuntime=createPrivateKernelRuntime({env:{...env,PRIVATE_R_TRANSFER_TIMEOUT_SECONDS:'1'},provider,environmentManifest:manifest});runtimes.push(deadlineRuntime);
  await deadlineRuntime.initialize();const deadlineId=id('pk_'),deadlineStarted=await deadlineRuntime.start({...scope,kernelId:deadlineId,environment,inputs:[]});
  const deadlineScope={...scope,generation:deadlineStarted.generation};
  await deadlineRuntime.execute(deadlineScope,deadlineId,{executionId:id('pex_'),order:1,source:'makeActiveBinding("slow_stream", function(value) { Sys.sleep(100); data.frame(count=1L) }, .GlobalEnv)'});
  const deadlineSpec=slowSave(deadlineStarted.generation,2),deadlineBegan=Date.now();
  const expired=await deadlineRuntime.export(deadlineScope,deadlineId,deadlineSpec);
  assert.equal(expired.status,'unknown');assert.ok(Date.now()-deadlineBegan<10000);assert.equal((await deadlineRuntime.inspect(deadlineScope,deadlineId)).status,'unknown');
  await assert.rejects(provider.inspect(deadlineSpec.internalStorageKey));await provider.inspect(saved.file.internalStorageKey,saved.file);
  check('an independent transfer deadline promptly removes a blocked producer and preserves earlier versions');
  const unsafeId=id('pk_'),unsafe=await runtime.start({...scope,kernelId:unsafeId,environment,inputs:[]}),unsafeScope={...scope,generation:unsafe.generation};
  await runtime.execute(unsafeScope,unsafeId,{executionId:id('pex_'),order:1,
    source:'value <- data.frame(x=1L); unlink("/work/export", recursive=TRUE); stopifnot(file.symlink("/work/input", "/work/export"))'});
  const unsafeSpec={...slowSave(unsafe.generation,2),binding:'value'};unsafeSpec.source=generatePrivateKernelExportSource(unsafeSpec);
  const rejected=await runtime.export(unsafeScope,unsafeId,unsafeSpec);
  assert.equal(rejected.status,'failed');assert.match(rejected.result.error.message,/source was not executed/);
  await assert.rejects(provider.inspect(unsafeSpec.internalStorageKey));await runtime.stop(unsafeScope,unsafeId);
  check('a replaced export-directory symlink is rejected before scientific source runs and cannot redirect the disk stream');
  assert.ok(peakBrokerRss-before<128*1024**2,'The broker retained too much of the 224 MiB artifact in memory.');
  await fs.writeFile(path.join(directory, 'result.json'), JSON.stringify({ passed: true, checks, image, environment,
    benchmark: { inputBytes: 224 * 1024 ** 2, artifactBytes: saved.file.sizeBytes, checksumSha256: saved.file.checksumSha256,
      publicationMs, brokerRssBeforeBytes: before, peakBrokerRssBytes: peakBrokerRss },
  }, null, 2));
  console.log(`Report: ${directory}`);
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  clearInterval(sample); for (const runtime of runtimes) await runtime.close().catch(() => {});
  await fs.rm(path.join(directory, 'work'), { recursive: true, force: true }).catch(() => {});
  await fs.rm(path.join(directory, 'storage'), { recursive: true, force: true }).catch(() => {});
});
