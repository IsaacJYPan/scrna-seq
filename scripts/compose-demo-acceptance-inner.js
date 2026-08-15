#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('/app/backend/config');
const db = require('/app/backend/pgDatabase');
const branches = require('/app/backend/analysisBranches');
const design = require('/app/backend/experimentalDesign');
const storage = require('/app/backend/storage');

const action = process.env.ACCEPTANCE_ACTION;
const input = process.env.ACCEPTANCE_INPUT ? JSON.parse(process.env.ACCEPTANCE_INPUT) : {};
const origin = process.env.FRONTEND_ORIGIN;

function emit(value) {
  process.stdout.write(`ACCEPTANCE_JSON=${JSON.stringify(value)}\n`);
}

async function seedTemplate() {
  await db.initSchema();
  const owner = await db.createUser(
    `demo-template-${Date.now()}@accept.invalid`, crypto.randomBytes(24).toString('base64url'),
    'Acceptance Template Owner'
  );
  if (owner.error) throw new Error(owner.error);
  const organization = await db.createOrganizationForUser(owner.id, { name: 'Acceptance demo templates' });
  const project = await db.createProjectForUser(owner.id, {
    organizationId: organization.id,
    name: 'Reviewed acceptance demo template',
  });
  const object = await db.createProjectAnalysisObject(owner.id, project.id, {
    objectType: 'seurat', displayName: 'Curated PBMC acceptance demo',
  });
  const control = await design.createCondition(owner.id, project.id, { name: 'control' });
  const treated = await design.createCondition(owner.id, project.id, { name: 'treated' });
  for (const [condition, name, sampleCode] of [
    [control, 'Control 1', 'C1'], [control, 'Control 2', 'C2'],
    [treated, 'Treated 1', 'T1'], [treated, 'Treated 2', 'T2'],
  ]) {
    const sample = await design.createSample(owner.id, project.id, {
      name, conditionId: condition.id, donorCode: sampleCode, modality: 'scrna',
      metadata: { cohort: 'synthetic' },
    });
    await design.bindSample(owner.id, project.id, object.id, {
      sampleId: sample.id, cellMetadataColumn: 'sample_id', cellMetadataValue: sampleCode,
    });
  }
  await design.createContrast(owner.id, project.id, {
    name: 'treated-versus-control', analysisObjectId: object.id,
    numeratorConditionId: treated.id, denominatorConditionId: control.id,
    unitOfReplication: 'sample', cellTypeColumn: 'cell_type',
  });
  const job = await db.createProjectJob(owner.id, project.id, {
    jobType: 'checkpoint.noop', analysisObjectId: object.id,
  });
  await db.updateJobStatusForUser(owner.id, job.id, 'running');
  const completed = await db.updateJobStatusForUser(owner.id, job.id, 'completed', {
    resultAnalysisObjectId: object.id,
  });

  const bytes = Buffer.from('operator-reviewed-demo-checkpoint-v1');
  const key = storage.projectStorageFileKey(project.id, 'checkpoints', job.id, 'checkpoint.rds');
  const provider = storage.createLocalStorageProvider({ root: config.storageRoot() });
  const destination = provider.prepareWrite(key);
  fs.writeFileSync(destination, bytes, { flag: 'wx', mode: 0o600 });
  const checksum = crypto.createHash('sha256').update(bytes).digest('hex');
  await db.createArtifact(completed, {
    artifactType: 'checkpoint', storageKind: 'local_internal', storageUri: key,
    checksumSha256: checksum, sizeBytes: bytes.length, resultAnalysisObjectId: object.id,
  });

  const branch = await branches.createBranch(owner.id, project.id, {
    name: 'template/reviewed', baseAnalysisObjectId: object.id,
  });
  await branches.publishBranch(owner.id, project.id, branch.id);
  const review = await branches.requestReview(owner.id, project.id, branch.id, {
    title: 'Acceptance demo template review',
  });
  await branches.decideReview(owner.id, project.id, review.id, { status: 'approved' });
  await branches.promoteBranch(owner.id, project.id, branch.id, { reviewId: review.id });
  emit({ projectId: project.id, key, checksum, sizeBytes: bytes.length });
}

function cookieFrom(response) {
  const raw = response.headers.get('set-cookie') || '';
  const match = raw.match(/(?:__Host-traceomics_session|traceomics_session)=([^;]+)/);
  assert(match, 'demo guest response must set the HttpOnly session cookie');
  return `${config.sessionCookieName()}=${match[1]}`;
}

async function request(pathname, { method = 'GET', cookie, body, requestOrigin = origin, ip = '198.51.100.10' } = {}) {
  const headers = {
    'X-Forwarded-Proto': 'https',
    'X-Forwarded-For': ip,
  };
  if (requestOrigin !== null) headers.Origin = requestOrigin;
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`http://127.0.0.1:3000${pathname}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { response, status: response.status, data };
}

async function createGuest(ip) {
  const result = await request('/api/auth/demo-guest', { method: 'POST', ip });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  assert.equal(result.data.analysisObject.metadata.curatedDemo, true);
  return { ...result.data, cookie: cookieFrom(result.response) };
}

async function acceptDemo() {
  await db.initSchema();
  const policy = await request('/api/auth/policy');
  assert.equal(policy.status, 200);
  assert.deepEqual({
    demoMode: policy.data.demoMode,
    uploads: policy.data.datasetUploadsEnabled,
    expertR: policy.data.expertREnabled,
  }, { demoMode: true, uploads: false, expertR: false });
  assert.equal(policy.data.demoGuestTtlSeconds, config.demoGuestTtlSeconds());

  const evil = await request('/api/auth/demo-guest', {
    method: 'POST', requestOrigin: 'https://evil.accept.invalid', ip: '203.0.113.50',
  });
  assert.equal(evil.status, 403);

  const guests = [];
  for (const [index, ip] of ['198.51.100.11', '198.51.100.12', '198.51.100.13'].entries()) {
    guests.push(await createGuest(ip));
    const session = await request('/api/auth/session', { cookie: guests[index].cookie, ip });
    assert.equal(session.status, 200);
    assert.equal(session.data.user.id, guests[index].user.id);
  }

  const checkpointRows = await db.query(
    `SELECT project_id, storage_uri, checksum_sha256, size_bytes
       FROM job_artifacts WHERE project_id = ANY($1::text[]) AND artifact_type = 'checkpoint'
       ORDER BY project_id`,
    [guests.map((guest) => guest.project.id)]
  );
  assert.equal(checkpointRows.rows.length, 3);
  assert.equal(new Set(checkpointRows.rows.map((row) => row.storage_uri)).size, 3);
  assert.equal(new Set(checkpointRows.rows.map((row) => row.checksum_sha256)).size, 1);
  for (const row of checkpointRows.rows) {
    assert(row.storage_uri.startsWith(`projects/${row.project_id}/checkpoints/`));
    assert(fs.existsSync(path.join(config.storageRoot(), ...row.storage_uri.split('/'))));
  }

  const designRows = await db.query(
    `SELECT project.id AS project_id,
            (SELECT count(*) FROM study_conditions WHERE project_id = project.id)::int AS conditions,
            (SELECT count(*) FROM biological_samples WHERE project_id = project.id)::int AS samples,
            (SELECT count(*) FROM condition_contrasts WHERE project_id = project.id)::int AS contrasts,
            (SELECT count(*) FROM biological_samples
              WHERE project_id = project.id AND dataset_id IS NOT NULL)::int AS dataset_refs
       FROM projects project WHERE project.id = ANY($1::text[]) ORDER BY project.id`,
    [guests.map((guest) => guest.project.id)]
  );
  assert.equal(designRows.rows.length, 3);
  for (const row of designRows.rows) {
    assert.deepEqual({
      conditions: row.conditions, samples: row.samples,
      contrasts: row.contrasts, datasetRefs: row.dataset_refs,
    }, { conditions: 2, samples: 4, contrasts: 1, datasetRefs: 0 });
  }
  const firstDesign = await Promise.all([
    request(`/api/projects/${guests[0].project.id}/conditions`, {
      cookie: guests[0].cookie, ip: '198.51.100.11',
    }),
    request(`/api/projects/${guests[0].project.id}/samples`, {
      cookie: guests[0].cookie, ip: '198.51.100.11',
    }),
    request(`/api/projects/${guests[0].project.id}/contrasts`, {
      cookie: guests[0].cookie, ip: '198.51.100.11',
    }),
  ]);
  assert(firstDesign.every((result) => result.status === 200));
  assert.equal(firstDesign[0].data.length, 2);
  assert.equal(firstDesign[1].data.length, 4);
  assert.equal(firstDesign[2].data.length, 1);
  assert.equal(firstDesign[2].data[0].analysisObjectId, guests[0].analysisObject.id);

  const crossTenant = await request(`/api/projects/${guests[1].project.id}`, {
    cookie: guests[0].cookie, ip: '198.51.100.11',
  });
  assert.equal(crossTenant.status, 404);

  const upload = await request(`/api/projects/${guests[0].project.id}/datasets`, {
    method: 'POST', cookie: guests[0].cookie, ip: '198.51.100.11',
    body: { fileType: 'csv', originalFilename: 'blocked.csv' },
  });
  assert.equal(upload.status, 403);

  const expert = await request(`/api/projects/${guests[0].project.id}/jobs`, {
    method: 'POST', cookie: guests[0].cookie, ip: '198.51.100.11',
    body: { jobType: 'expert.r.v1', analysisObjectId: guests[0].analysisObject.id, parameters: {} },
  });
  assert.equal(expert.status, 403);

  const launch = (guest, ip) => request(`/api/projects/${guest.project.id}/jobs`, {
    method: 'POST', cookie: guest.cookie, ip,
    body: {
      jobType: 'explore.summarize.v1', analysisObjectId: guest.analysisObject.id,
      parameters: { recipe: 'overview' },
    },
  });
  assert.equal((await launch(guests[0], '198.51.100.11')).status, 201);
  const perGuest = await launch(guests[0], '198.51.100.11');
  assert.equal(perGuest.status, 429);
  assert.match(perGuest.data.error, /session already has an active compute job/i);
  assert.equal((await launch(guests[1], '198.51.100.12')).status, 201);
  const global = await launch(guests[2], '198.51.100.13');
  assert.equal(global.status, 429);
  assert.match(global.data.error, /compute pool is currently full/i);

  let limited = null;
  for (let attempt = 0; attempt < 11; attempt += 1) {
    limited = await request('/api/auth/demo-guest', {
      method: 'POST', requestOrigin: 'https://evil.accept.invalid', ip: '203.0.113.99',
    });
  }
  assert.equal(limited.status, 429);
  assert(Number(limited.response.headers.get('retry-after')) >= 1);

  await db.query("UPDATE users SET expires_at = now() - interval '1 second' WHERE id = $1", [guests[0].user.id]);
  emit({
    expiredUserId: guests[0].user.id,
    expiredProjectId: guests[0].project.id,
    activeUserIds: guests.slice(1).map((guest) => guest.user.id),
    activeProjectIds: guests.slice(1).map((guest) => guest.project.id),
    expiredCheckpointKey: checkpointRows.rows.find(
      (row) => row.project_id === guests[0].project.id
    ).storage_uri,
    activeCheckpointKeys: checkpointRows.rows.filter(
      (row) => row.project_id !== guests[0].project.id
    ).map((row) => row.storage_uri),
  });
}

async function verifyCleanup() {
  await db.initSchema();
  const removedUser = await db.query('SELECT id FROM users WHERE id = $1', [Number(input.expiredUserId)]);
  const removedProject = await db.query('SELECT id FROM projects WHERE id = $1', [String(input.expiredProjectId)]);
  assert.equal(removedUser.rows.length, 0);
  assert.equal(removedProject.rows.length, 0);
  assert.equal(fs.existsSync(path.join(config.storageRoot(), ...input.expiredCheckpointKey.split('/'))), false);

  const activeUsers = await db.query('SELECT id FROM users WHERE id = ANY($1::bigint[])', [input.activeUserIds]);
  const activeProjects = await db.query('SELECT id FROM projects WHERE id = ANY($1::text[])', [input.activeProjectIds]);
  assert.equal(activeUsers.rows.length, input.activeUserIds.length);
  assert.equal(activeProjects.rows.length, input.activeProjectIds.length);
  for (const key of input.activeCheckpointKeys) {
    assert.equal(fs.existsSync(path.join(config.storageRoot(), ...key.split('/'))), true);
  }
  const template = await db.getDemoTemplateCheckpoint(config.demoTemplateProjectId());
  assert(template.storageUri.startsWith(`projects/${config.demoTemplateProjectId()}/`));
  emit({
    removedUserId: input.expiredUserId,
    removedProjectId: input.expiredProjectId,
    activeGuestsPreserved: input.activeUserIds.length,
    templateProjectPreserved: config.demoTemplateProjectId(),
  });
}

async function main() {
  if (action === 'seed-template') await seedTemplate();
  else if (action === 'accept-demo') await acceptDemo();
  else if (action === 'verify-cleanup') await verifyCleanup();
  else throw new Error(`Unknown acceptance action: ${action}`);
  await db.close();
}

main().catch(async (error) => {
  console.error(error.stack || error.message);
  try { await db.close(); } catch { /* best effort */ }
  process.exitCode = 1;
});
