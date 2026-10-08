#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('../backend/config');
const db = require('../backend/pgDatabase');
const branches = require('../backend/analysisBranches');
const design = require('../backend/experimentalDesign');
const storage = require('../backend/storage');

const PENDING_FILE = '.demo-template-bootstrap.json';
const dataset = process.env.DEMO_DATASET || 'synthetic';
if (!['synthetic', 'pbmc3k'].includes(dataset)) throw new Error('Unsupported demo dataset.');
const pbmc = dataset === 'pbmc3k';
const sourceType = pbmc ? 'pbmc3k_demo' : 'synthetic_pbmc_demo';
const tutorialUrl = 'https://satijalab.org/seurat/articles/pbmc3k_tutorial';

function fail(message) {
  throw new Error(message);
}

function pendingPath() {
  return path.join(config.storageRoot(), PENDING_FILE);
}

function validatePending(value) {
  if (!value || typeof value !== 'object'
      || !/^proj_[A-Za-z0-9_-]{3,128}$/.test(value.projectId || '')
      || !/^ao_[A-Za-z0-9_-]{3,128}$/.test(value.objectId || '')
      || !/^job_[A-Za-z0-9_-]{3,128}$/.test(value.jobId || '')
      || !Number.isInteger(Number(value.ownerUserId))
      || typeof value.checkpointKey !== 'string'
      || value.checkpointKey !== storage.projectStorageFileKey(
        value.projectId, 'checkpoints', value.jobId, 'checkpoint.rds'
      ) || ((value.dataset || 'synthetic') !== dataset)) {
    fail('The pending demo-template bootstrap record is invalid.');
  }
  return value;
}

async function prepare() {
  if (fs.existsSync(pendingPath())) {
    fail(`A pending bootstrap already exists at ${pendingPath()}; resume generation/finalization before preparing another template.`);
  }
  await db.initSchema();
  const stamp = `${Date.now()}-${crypto.randomBytes(5).toString('hex')}`;
  const owner = await db.createUser(
    `demo-template-${stamp}@invalid.example`,
    crypto.randomBytes(32).toString('base64url'),
    'TraceOmics Demo Template'
  );
  if (owner.error) fail('Could not create the non-login template owner.');
  const organization = await db.createOrganizationForUser(owner.id, {
    name: 'TraceOmics public demo templates',
  });
  const project = await db.createProjectForUser(owner.id, {
    organizationId: organization.id,
    name: pbmc ? 'TraceOmics PBMC3k tutorial' : 'TraceOmics synthetic PBMC demo',
    description: pbmc ? 'Public 10x PBMC3k reference, processed with the Seurat tutorial. Single sample; no treatment comparison.' : 'Privacy-safe synthetic PBMC-like data for the public demonstration service.',
  });
  const object = await db.createProjectAnalysisObject(owner.id, project.id, {
    objectType: 'seurat',
    displayName: pbmc ? 'PBMC3k · Seurat tutorial' : 'Synthetic PBMC-like tutorial',
    metadata: {
      sourceType,
      synthetic: !pbmc,
      scientific_output: pbmc,
      ...(pbmc ? { tutorialUrl, dataset: 'pbmc3k', singleSample: true,
        sourceUrl: 'https://cf.10xgenomics.com/samples/cell/pbmc3k/pbmc3k_filtered_gene_bc_matrices.tar.gz',
        sourceSha256: '847d6ebd9a1ec9a768f2be7e40ca42cbfe75ebeb6d76a4c24167041699dc28b5' } : {}),
      summary: pbmc ? { cells: 2638, features: 13714 } : { cells: 800, features: 200 },
    },
  });
  if (pbmc) {
    const reference = await design.createCondition(owner.id, project.id, { name: 'Reference sample' });
    const sample = await design.createSample(owner.id, project.id, {
      name: '10x PBMC3k', conditionId: reference.id, organism: 'human', modality: 'scrna',
    });
    await design.bindSample(owner.id, project.id, object.id, {
      sampleId: sample.id, cellMetadataColumn: 'sample_id', cellMetadataValue: 'PBMC3k',
    });
  } else {
  const control = await design.createCondition(owner.id, project.id, { name: 'control' });
  const treated = await design.createCondition(owner.id, project.id, { name: 'treated' });
  const sampleSpecs = [
    [control, 'Control replicate 1', 'C1'], [control, 'Control replicate 2', 'C2'],
    [treated, 'Treated replicate 1', 'T1'], [treated, 'Treated replicate 2', 'T2'],
  ];
  for (const [condition, name, code] of sampleSpecs) {
    const sample = await design.createSample(owner.id, project.id, {
      name, conditionId: condition.id, donorCode: code, replicateLabel: code,
      organism: 'human', modality: 'scrna',
    });
    await design.bindSample(owner.id, project.id, object.id, {
      sampleId: sample.id, cellMetadataColumn: 'sample_id', cellMetadataValue: code,
    });
  }
  await design.createContrast(owner.id, project.id, {
    name: 'treated-versus-control', analysisObjectId: object.id,
    numeratorConditionId: treated.id, denominatorConditionId: control.id,
    unitOfReplication: 'sample', paired: false, cellTypeColumn: 'cell_type',
  });
  }
  const job = await db.createProjectJob(owner.id, project.id, {
    jobType: 'checkpoint.noop', analysisObjectId: object.id,
  });
  await db.updateJobStatusForUser(owner.id, job.id, 'running');
  const pending = {
    version: 1,
    dataset,
    ownerUserId: Number(owner.id),
    projectId: project.id,
    objectId: object.id,
    jobId: job.id,
    checkpointKey: storage.projectStorageFileKey(project.id, 'checkpoints', job.id, 'checkpoint.rds'),
  };
  fs.writeFileSync(pendingPath(), `${JSON.stringify(pending, null, 2)}\n`, {
    flag: 'wx', mode: 0o600,
  });
  process.stdout.write(`${JSON.stringify({
    action: 'prepared', projectId: project.id, objectId: object.id,
    next: 'run demo-template-r, then demo-template-finalize',
  })}\n`);
}

async function finalize() {
  await db.initSchema();
  if (!fs.existsSync(pendingPath())) fail('No pending demo-template bootstrap record exists.');
  const pending = validatePending(JSON.parse(fs.readFileSync(pendingPath(), 'utf8')));
  const provider = storage.createLocalStorageProvider({ root: config.storageRoot() });
  const opened = await provider.openVerifiedRead(pending.checkpointKey);
  let sizeBytes = 0;
  const hash = crypto.createHash('sha256');
  try {
    // PBMC3k includes dense scaled expression. Hash the existing open handle
    // incrementally so finalization does not allocate the entire checkpoint.
    for await (const chunk of opened.handle.createReadStream({ autoClose: false })) {
      sizeBytes += chunk.length;
      hash.update(chunk);
    }
  } finally {
    await opened.handle.close();
  }
  if (sizeBytes < 1024) fail('Generated demo checkpoint is unexpectedly small.');
  const checksum = hash.digest('hex');
  const completed = await db.updateJobStatusForUser(
    pending.ownerUserId, pending.jobId, 'completed', { resultAnalysisObjectId: pending.objectId }
  );
  await db.createArtifact(completed, {
    artifactType: 'checkpoint',
    name: pbmc ? 'Reviewed public PBMC3k checkpoint' : 'Reviewed synthetic PBMC demo checkpoint',
    mimeType: 'application/x-r-rds',
    storageKind: 'local_internal',
    storageUri: pending.checkpointKey,
    checksumSha256: checksum,
    sizeBytes,
    resultAnalysisObjectId: pending.objectId,
    metadata: {
      templateKind: sourceType,
      privacySafe: true,
      generatedBy: 'reviewed_demo_bootstrap_v2',
    },
  });
  const branch = await branches.createBranch(pending.ownerUserId, pending.projectId, {
    name: 'template/reviewed', baseAnalysisObjectId: pending.objectId,
  });
  await branches.publishBranch(pending.ownerUserId, pending.projectId, branch.id);
  const review = await branches.requestReview(pending.ownerUserId, pending.projectId, branch.id, {
    title: 'Approve privacy-safe public demo template',
  });
  await branches.decideReview(pending.ownerUserId, pending.projectId, review.id, {
    status: 'approved', summary: pbmc ? 'Public 10x PBMC3k source and Seurat tutorial checkpoint reviewed for demo provisioning; no invented conditions or replicates.' : 'Synthetic data and canonical checkpoint approved for public demo provisioning.',
  });
  await branches.promoteBranch(pending.ownerUserId, pending.projectId, branch.id, {
    reviewId: review.id,
  });
  fs.rmSync(pendingPath());
  process.stdout.write(`${JSON.stringify({
    action: 'finalized',
    demoTemplateProjectId: pending.projectId,
    checkpointSha256: checksum,
    sizeBytes,
    next: `set DEMO_TEMPLATE_PROJECT_ID=${pending.projectId}`,
  })}\n`);
}

async function main() {
  const action = String(process.argv[2] || '').trim().toLowerCase();
  if (action === 'prepare') await prepare();
  else if (action === 'finalize') await finalize();
  else fail('Usage: node scripts/bootstrap-demo-template.js <prepare|finalize>');
}

main().catch(error => {
  console.error(`[demo-template] ${error.message}`);
  process.exitCode = 1;
}).finally(() => db.close());
