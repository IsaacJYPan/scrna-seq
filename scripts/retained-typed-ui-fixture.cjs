'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);
const { digest } = require('../backend/workflowRuntime');
const { EXPERT_R_PROFILE } = require('../backend/expertR');
const { validateWorkflowOutput } = require('../backend/workflowOutputs');
const storage = require('../backend/storage');
const id = prefix => `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function assert(value, message) { if (!value) throw new Error(message); }
async function fileHash(filename) {
  const hash = crypto.createHash('sha256');
  for await (const bytes of fs.createReadStream(filename)) hash.update(bytes);
  return hash.digest('hex');
}
function ownedPath(root, key) {
  const destination = path.resolve(root, ...key.split('/'));
  assert(destination.startsWith(path.resolve(root) + path.sep), 'Retained fixture storage escaped its owned root.');
  return destination;
}

// Extract actual measured values from a previously verified PBMC3k checkpoint.
// No analysis is recomputed, no source input is mutated, and fixture insertion
// below is explicitly not an app-captured scientific execution.
async function prepareRetainedTypedFixture({ database, service, ownerId, directory, image, checkpoint }) {
  assert(/^(?:[^\s@]+@)?sha256:[a-f0-9]{64}$/.test(image || ''), 'Use a cached reviewed immutable R image for retained fixture extraction.');
  const manifest = JSON.parse(fs.readFileSync(path.join(path.dirname(checkpoint), 'manifest.json'), 'utf8'));
  const inputHash = await fileHash(checkpoint);
  assert(inputHash === manifest.checksumSha256 && manifest.synthetic === false && manifest.cells === 2638, 'The retained PBMC3k checkpoint does not match its measured manifest.');
  const output = path.join(directory, 'measured-pbmc'); fs.mkdirSync(output, { recursive: true }); fs.chmodSync(output, 0o777);
  const producer = 'traceomics-retained-plot-' + process.pid + '-' + crypto.randomBytes(5).toString('hex');
  const source = `suppressPackageStartupMessages({library(Seurat);library(jsonlite)})
    saved<-readRDS('/source/checkpoint.rds'); obj<-saved$global
    stopifnot(identical(obj@misc$traceomics_demo$synthetic,FALSE),ncol(obj)==2638L)
    coordinates<-Embeddings(obj,'umap'); groups<-paste('Cluster',as.character(Idents(obj)))
    stopifnot(all(is.finite(coordinates)),identical(rownames(coordinates),colnames(obj)))
    write_json(list(x=unname(coordinates[,1]),y=unname(coordinates[,2]),ids=colnames(obj),groups=groups),'/output/embedding.json',auto_unbox=TRUE,digits=NA)
    write_json(list(cells=ncol(obj),features=nrow(obj),clusters=length(unique(groups))),'/output/metrics.json',auto_unbox=TRUE,digits=NA)
    png('/output/figure.png',width=1000,height=650,res=100)
    par(mar=c(4.5,4.5,4,1));plot(coordinates[,1],coordinates[,2],col=as.integer(factor(groups)),pch=16,cex=.65,
      xlab='Retained UMAP coordinate 1',ylab='Retained UMAP coordinate 2',main='PBMC3k: retained measured coordinates')
    legend('topright',legend=sort(unique(groups)),col=seq_along(unique(groups)),pch=16,cex=.65,bty='n');dev.off()`;
  try {
    await execute('docker', ['run', '--rm', '--name', producer, '--pull', 'never', '--label', 'traceomics.review=retained-typed-ui',
      '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', '10001:10001',
      '--pids-limit', '128', '--memory', '3g', '--cpus', '2', '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=128m',
      '--mount', `type=bind,source=${path.dirname(checkpoint)},target=/source,readonly`, '--mount', `type=bind,source=${output},target=/output`,
      '--entrypoint', 'Rscript', image, '--vanilla', '-e', source], { windowsHide: true, timeout: 120000, maxBuffer: 65536 });
  } catch { throw new Error('The cached immutable R image could not extract actual retained PBMC3k values. No image or data is downloaded by this harness.'); }
  finally { fs.chmodSync(output, 0o755); await execute('docker', ['rm', '-f', producer], { windowsHide: true, timeout: 15000 }).catch(() => {}); }
  assert(await fileHash(checkpoint) === inputHash, 'The source PBMC3k checkpoint changed during read-only extraction.');
  const objectId = id('ao'), jobId = id('job'), checkpointId = id('art'), projectId = service.project.id;
  await database.query("INSERT INTO analysis_objects(id,owner_user_id,project_id,object_type,display_name,metadata_json) VALUES($1,$2,$3,'seurat','Retained PBMC3k input',$4)", [objectId, ownerId, projectId, { acceptanceFixture: true, synthetic: false, cells: manifest.cells, origin: 'Previously measured checkpoint; no app execution in this acceptance' }]);
  await database.query("INSERT INTO jobs(id,owner_user_id,project_id,analysis_object_id,job_type,status) VALUES($1,$2,$3,$4,'generic','queued')", [jobId, ownerId, projectId, objectId]);
  const checkpointKey = storage.projectStorageFileKey(projectId, 'checkpoints', jobId, 'checkpoint.rds');
  const checkpointDestination = ownedPath(service.storageRoot, checkpointKey); fs.mkdirSync(path.dirname(checkpointDestination), { recursive: true }); fs.copyFileSync(checkpoint, checkpointDestination);
  await database.query("INSERT INTO job_artifacts(id,project_id,job_id,result_analysis_object_id,created_by_user_id,artifact_type,name,storage_kind,storage_uri,checksum_sha256,size_bytes,status) VALUES($1,$2,$3,$4,$5,'checkpoint','Retained PBMC3k checkpoint','local_internal',$6,$7,$8,'available')", [checkpointId, projectId, jobId, objectId, ownerId, checkpointKey, inputHash, manifest.sizeBytes]);
  const provider = storage.createLocalStorageProvider({ root: service.storageRoot });
  const outputs = {};
  for (const [port, type, filename] of [['metrics', 'metrics', 'metrics.json'], ['embedding', 'scatter', 'embedding.json'], ['figure', 'figure', 'figure.png']]) {
    const bytes = fs.readFileSync(path.join(output, filename));
    const versionId = id('eri'), key = storage.projectStorageFileKey(projectId, 'artifacts', jobId, versionId + '.' + filename.split('.').pop());
    const descriptor = { id: versionId, type, sha256: sha(bytes), sizeBytes: bytes.length, profileId: EXPERT_R_PROFILE.id };
    fs.writeFileSync(provider.prepareWrite(key), bytes); await validateWorkflowOutput(provider, key, descriptor);
    await database.query('INSERT INTO workflow_artifacts(id,owner_user_id,project_id,job_id,descriptor_json,storage_key) VALUES($1,$2,$3,$4,$5,$6)', [versionId, ownerId, projectId, jobId, descriptor, key]);
    outputs[port] = descriptor;
  }
  const stress = { x: [], y: [], ids: [], groups: [] };
  for (let index = 0; index < 10000; index++) { stress.x.push(index % 101); stress.y.push(Math.floor(index / 101)); stress.ids.push('synthetic-point-' + index); stress.groups.push(index % 2 ? 'Synthetic A' : 'Synthetic B'); }
  const bytes = Buffer.from(JSON.stringify(stress)), stressId = id('eri'), stressKey = storage.projectStorageFileKey(projectId, 'artifacts', jobId, stressId + '.json');
  const stressDescriptor = { id: stressId, type: 'scatter', sha256: sha(bytes), sizeBytes: bytes.length };
  fs.writeFileSync(provider.prepareWrite(stressKey), bytes); await validateWorkflowOutput(provider, stressKey, stressDescriptor);
  await database.query('INSERT INTO workflow_artifacts(id,owner_user_id,project_id,job_id,descriptor_json,storage_key) VALUES($1,$2,$3,$4,$5,$6)', [stressId, ownerId, projectId, jobId, stressDescriptor, stressKey]);
  const recipe = { format: 'traceomics-workflow', schemaVersion: 1, id: 'retained-pbmc-review', name: 'Retained PBMC3k review', version: '1.0.0',
    description: 'Read-only acceptance of previously measured PBMC3k results; no app execution is claimed.', runtime: { language: 'r', profileId: EXPERT_R_PROFILE.id }, files: { 'review.R': '# Retained fixture only. Do not execute.' },
    steps: [{ id: 'review', label: 'Retained measured results', entry: 'review.R', inputs: { analysis: { from: 'input.analysis', type: 'rds' } }, parameters: [],
      outputs: { metrics: { type: 'metrics', label: 'Measured summary' }, embedding: { type: 'scatter', label: 'Measured embedding' }, figure: { type: 'figure', label: 'Measured figure' } } }], tabs: [{ id: 'review', label: 'Review', step: 'review', plots: [] }] };
  const { parseLegacyExecutableWorkflowPackage } = await import('../shared/recipePackage.mjs');
  const workflow = parseLegacyExecutableWorkflowPackage(recipe, { environmentProfiles: [EXPERT_R_PROFILE.id] });
  const state = { generation: 1, root: { id: checkpointId, sha256: inputHash, sizeBytes: manifest.sizeBytes, type: 'rds', profileId: EXPERT_R_PROFILE.id, root: true }, active: null,
    results: { review: { parameters: {}, seed: 1, inputs: {}, outputs } } };
  await database.query('INSERT INTO workflow_instances(id,owner_user_id,project_id,analysis_object_id,package_digest,package_json,state_json) VALUES($1,$2,$3,$4,$5,$6,$7)', [id('wfi'), ownerId, projectId, objectId, digest(workflow), workflow, state]);
  return { outputs, stress: stressDescriptor, recipe: workflow, objectId, manifest: { checkpointSha256: inputHash, sourceSha256: manifest.source.sourceSha256, cells: manifest.cells, features: manifest.features, synthetic: false },
    resultDigests: Object.fromEntries(Object.entries(outputs).map(([port, value]) => [port, value.sha256])) };
}
module.exports = { prepareRetainedTypedFixture };
