import { afterAll, beforeEach, describe, expect, it } from 'vitest';

const crypto = require('crypto');
const fs = require('fs');
const config = require('./config');
const db = require('./pgDatabase');
const branches = require('./analysisBranches');
const design = require('./experimentalDesign');
const storage = require('./storage');
const { startServer, api } = require('./_http-test-utils');

const CONFIGURED = config.hasPostgresConnection();

describe.skipIf(!CONFIGURED)('isolated public demo lifecycle', () => {
  let server;
  let savedMode;
  let savedTemplate;

  beforeEach(async () => {
    await db.resetSchemaForTests();
    savedMode = process.env.APP_DEPLOYMENT_MODE;
    savedTemplate = process.env.DEMO_TEMPLATE_PROJECT_ID;
    process.env.APP_DEPLOYMENT_MODE = 'demo';
    if (!server) server = await startServer();
  });

  afterAll(async () => {
    if (savedMode === undefined) delete process.env.APP_DEPLOYMENT_MODE;
    else process.env.APP_DEPLOYMENT_MODE = savedMode;
    if (savedTemplate === undefined) delete process.env.DEMO_TEMPLATE_PROJECT_ID;
    else process.env.DEMO_TEMPLATE_PROJECT_ID = savedTemplate;
    if (server) await new Promise((resolve) => server.close(resolve));
    await db.close();
  });

  async function seedTemplate() {
    const owner = await db.createUser('demo-template@example.com', 'password123', 'Template Owner');
    const org = await db.createOrganizationForUser(owner.id, { name: 'Demo templates' });
    const project = await db.createProjectForUser(owner.id, {
      organizationId: org.id, name: 'Reviewed demo template',
    });
    const object = await db.createProjectAnalysisObject(owner.id, project.id, {
      objectType: 'seurat', displayName: 'Curated PBMC demo',
      metadata: { sourceType:'synthetic_pbmc_demo', summary:{cells:800,features:200}, operatorPrivateNote:'must not be cloned' },
    });
    const control = await design.createCondition(owner.id, project.id, { name: 'control' });
    const treated = await design.createCondition(owner.id, project.id, { name: 'treated' });
    for (const [condition, name, sampleCode] of [
      [control, 'Control 1', 'C1'], [control, 'Control 2', 'C2'],
      [treated, 'Treated 1', 'T1'], [treated, 'Treated 2', 'T2'],
    ]) {
      const sample = await design.createSample(owner.id, project.id, {
        name, conditionId: condition.id, donorCode: sampleCode,
        modality: 'scrna', metadata: { cohort: 'synthetic' },
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
    const provider = storage.createLocalStorageProvider({ root: config.storageRoot() });
    const key = storage.projectStorageFileKey(project.id, 'checkpoints', job.id, 'checkpoint.rds');
    const destination = provider.prepareWrite(key);
    const bytes = Buffer.from('operator-reviewed-curated-checkpoint');
    fs.writeFileSync(destination, bytes, { flag: 'wx', mode: 0o600 });
    await db.createArtifact(completed, {
      artifactType: 'checkpoint', storageKind: 'local_internal', storageUri: key,
      checksumSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      sizeBytes: bytes.length, resultAnalysisObjectId: object.id,
    });
    const branch = await branches.createBranch(owner.id, project.id, {
      name: 'template/reviewed', baseAnalysisObjectId: object.id,
    });
    await branches.publishBranch(owner.id, project.id, branch.id);
    const review = await branches.requestReview(owner.id, project.id, branch.id, {
      title: 'Demo template review',
    });
    await branches.decideReview(owner.id, project.id, review.id, { status: 'approved' });
    await branches.promoteBranch(owner.id, project.id, branch.id, { reviewId: review.id });
    process.env.DEMO_TEMPLATE_PROJECT_ID = project.id;
    return { project, object, key };
  }

  it('provisions an expiring guest checkpoint, enforces compute quota, and cleans it up', async () => {
    const template = await seedTemplate();
    const created = await api(server, '/api/auth/demo-guest', {
      method: 'POST', headers: { Origin: 'http://localhost:5173' },
    });
    expect(created.status).toBe(201);
    expect(created.data.analysisObject.metadata).toMatchObject({ curatedDemo:true, sourceType:'synthetic_pbmc_demo', synthetic:true, summary:{cells:800,features:200} });
    expect(created.data.analysisObject.metadata).not.toHaveProperty('operatorPrivateNote');
    const setCookie = created.res.headers.get('set-cookie') || '';
    const cookieValue = setCookie.match(/(?:__Host-traceomics_session|traceomics_session)=([^;]+)/)?.[1];
    expect(cookieValue).toBeTruthy();
    const token = decodeURIComponent(cookieValue);

    const [conditions, samples, bindings, contrasts] = await Promise.all([
      api(server, `/api/projects/${created.data.project.id}/conditions`, { token }),
      api(server, `/api/projects/${created.data.project.id}/samples`, { token }),
      api(server, `/api/projects/${created.data.project.id}/analysis-objects/${created.data.analysisObject.id}/sample-bindings`, { token }),
      api(server, `/api/projects/${created.data.project.id}/contrasts`, { token }),
    ]);
    expect(conditions.status).toBe(200);
    expect(samples.status).toBe(200);
    expect(bindings.status).toBe(200);
    expect(contrasts.status).toBe(200);
    expect(conditions.data.map((row) => row.name).sort()).toEqual(['control', 'treated']);
    expect(samples.data).toHaveLength(4);
    expect(samples.data.every((row) => row.datasetId === null)).toBe(true);
    expect(bindings.data).toHaveLength(4);
    expect(bindings.data.every((row) => row.analysisObjectId === created.data.analysisObject.id)).toBe(true);
    expect(contrasts.data).toHaveLength(1);
    expect(contrasts.data[0]).toMatchObject({
      name: 'treated-versus-control', status: 'warning', cellTypeColumn: 'cell_type',
    });
    expect(contrasts.data[0].analysisObjectId).toBe(created.data.analysisObject.id);
    const sourceIds = await db.query(
      `SELECT id FROM study_conditions WHERE project_id = $1
       UNION ALL SELECT id FROM biological_samples WHERE project_id = $1
       UNION ALL SELECT id FROM condition_contrasts WHERE project_id = $1`,
      [template.project.id]
    );
    const guestIds = new Set([
      ...conditions.data.map((row) => row.id), ...samples.data.map((row) => row.id),
      ...contrasts.data.map((row) => row.id),
    ]);
    expect(sourceIds.rows.some((row) => guestIds.has(row.id))).toBe(false);

    const first = await api(server, `/api/projects/${created.data.project.id}/jobs`, {
      method: 'POST', token,
      body: {
        jobType: 'explore.summarize.v1',
        analysisObjectId: created.data.analysisObject.id,
        parameters: { recipe: 'overview' },
      },
    });
    expect(first.status).toBe(201);
    const second = await api(server, `/api/projects/${created.data.project.id}/jobs`, {
      method: 'POST', token,
      body: {
        jobType: 'explore.summarize.v1',
        analysisObjectId: created.data.analysisObject.id,
        parameters: { recipe: 'overview' },
      },
    });
    expect(second.status).toBe(429);

    await db.query('UPDATE users SET expires_at = now() - interval \'1 second\' WHERE id = $1', [created.data.user.id]);
    const expired = await db.listExpiredDemoGuests();
    expect(expired.map((guest) => guest.userId)).toContain(created.data.user.id);
    const provider = storage.createLocalStorageProvider({ root: config.storageRoot() });
    for (const key of expired.find((guest) => guest.userId === created.data.user.id).storageKeys) {
      if (storage.isProjectStorageKey(key)) provider.remove(key);
    }
    expect(await db.deleteExpiredDemoGuest(created.data.user.id)).toBe(true);
    expect((await api(server, '/api/auth/session', { token })).status).toBe(401);
  });
});
