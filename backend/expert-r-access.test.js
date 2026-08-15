import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const config = require('./config');
const db = require('./pgDatabase');
const analysisBranches = require('./analysisBranches');
const researchExports = require('./researchExports');
const { EXPERT_R_PROFILE, allocateExpertRInputStorageKey } = require('./expertR');
const { startServer, createUserWithToken, api } = require('./_http-test-utils');

const CONFIGURED = config.hasPostgresConnection();
const ORIGINAL_ENV = {
  APP_DEPLOYMENT_MODE: process.env.APP_DEPLOYMENT_MODE,
  EXPERT_R_ENABLED: process.env.EXPERT_R_ENABLED,
  EXPERT_R_SANDBOX_URL: process.env.EXPERT_R_SANDBOX_URL,
  EXPERT_R_SANDBOX_TOKEN: process.env.EXPERT_R_SANDBOX_TOKEN,
};

let server;

function enablePrivateExpertR() {
  process.env.APP_DEPLOYMENT_MODE = 'private';
  process.env.EXPERT_R_ENABLED = 'true';
  process.env.EXPERT_R_SANDBOX_URL = 'http://127.0.0.1:8090';
  process.env.EXPERT_R_SANDBOX_TOKEN = 'a'.repeat(64);
}

function restoreEnv() {
  for (const [name, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

async function seedOwnerProject(email = 'expert-owner@example.com') {
  const account = await createUserWithToken({ email, displayName: 'Expert Owner' });
  const organization = await db.createOrganizationForUser(account.user.id, { name: 'Expert Lab' });
  const project = await db.createProjectForUser(account.user.id, {
    organizationId: organization.id,
    name: 'Expert Project',
  });
  const object = await db.createProjectAnalysisObject(account.user.id, project.id, {
    objectType: 'seurat',
    displayName: 'Private saved analysis',
  });
  return { ...account, project, object };
}

function expertJobBody(objectId, script = 'write_table(data.frame(cells=1), "summary.csv")') {
  return {
    jobType: 'expert.r.v1',
    analysisObjectId: objectId,
    parameters: { profileId: EXPERT_R_PROFILE.id, script },
  };
}

beforeAll(async () => {
  if (!CONFIGURED) return;
  enablePrivateExpertR();
  server = await startServer();
});

beforeEach(async () => {
  if (!CONFIGURED) return;
  enablePrivateExpertR();
  await db.resetSchemaForTests();
});

afterAll(async () => {
  restoreEnv();
  if (!CONFIGURED) return;
  if (server) await new Promise((resolve) => server.close(resolve));
  await db.close();
});

describe.skipIf(!CONFIGURED)('Expert R approved-account access', () => {
  it('keeps imported tabular inputs creator-private and resolves paths only for the claimed worker', async () => {
    const owner = await seedOwnerProject('expert-input-owner@example.com');
    const collaborator = await createUserWithToken({
      email: 'expert-input-collaborator@example.com', displayName: 'Input Collaborator',
    });
    await db.addProjectMemberByEmail(
      owner.project.id, collaborator.user.email, 'analyst', { userId: owner.user.id }
    );
    await db.setExpertRExecutorByEmail(owner.user.email, true);
    await db.setExpertRExecutorByEmail(collaborator.user.email, true);

    const inputId = `eri_${'a'.repeat(24)}`;
    const key = allocateExpertRInputStorageKey(owner.project.id, inputId, 'metadata.csv');
    const createdInput = await db.createExpertRPrivateInput(owner.user.id, owner.project.id, {
      id: inputId,
      originalFilename: 'metadata.csv',
      internalStorageKey: key,
      mimeType: 'text/csv',
      sizeBytes: 123,
      checksumSha256: 'b'.repeat(64),
    });
    expect(createdInput).toMatchObject({ id: inputId, originalFilename: 'metadata.csv', sizeBytes: 123 });
    expect(createdInput).not.toHaveProperty('internalStorageKey');
    expect(await db.listExpertRPrivateInputs(owner.user.id, owner.project.id)).toHaveLength(1);
    expect(await db.listExpertRPrivateInputs(collaborator.user.id, owner.project.id)).toEqual([]);

    const job = await db.createProjectJob(owner.user.id, owner.project.id, {
      ...expertJobBody(owner.object.id),
      parameters: {
        ...expertJobBody(owner.object.id).parameters,
        inputIds: [inputId],
      },
    });
    const claim = await db.claimNextJob('expert-input-worker', {
      allowedJobTypes: ['expert.r.v1'], leaseSeconds: 30,
    });
    expect(claim.id).toBe(job.id);
    expect(await db.getExpertRPrivateInputsForJobByWorker(
      job.id, 'expert-input-worker', claim.claimToken
    )).toEqual([expect.objectContaining({ id: inputId, internalStorageKey: key })]);

    const collaboratorObject = await db.createProjectAnalysisObject(
      collaborator.user.id, owner.project.id, { objectType: 'seurat', displayName: 'Collaborator analysis' }
    );
    await expect(db.createProjectJob(collaborator.user.id, owner.project.id, {
      ...expertJobBody(collaboratorObject.id),
      parameters: { ...expertJobBody(collaboratorObject.id).parameters, inputIds: [inputId] },
    })).rejects.toMatchObject({ code: 'EXPERT_R_INPUT_NOT_FOUND' });
  });

  it('keeps public policy closed and requires an audited account grant', async () => {
    const owner = await seedOwnerProject();

    const publicPolicy = await api(server, '/api/auth/policy');
    expect(publicPolicy.status).toBe(200);
    expect(publicPolicy.data).toMatchObject({ expertREnabled: false, expertRProfile: null });
    expect((await api(server, '/api/expert-r/capabilities')).status).toBe(401);

    const unavailable = await api(server, '/api/expert-r/capabilities', { token: owner.token });
    expect(unavailable.status).toBe(200);
    expect(unavailable.data).toEqual({ expertREnabled: false, expertRProfile: null });

    const denied = await api(server, `/api/projects/${owner.project.id}/jobs`, {
      method: 'POST', token: owner.token, body: expertJobBody(owner.object.id),
    });
    expect(denied.status).toBe(403);

    const grant = await db.setExpertRExecutorByEmail(owner.user.email, true);
    expect(grant).toEqual(expect.objectContaining({
      canExecuteExpertR: true,
      capability: 'expert_r.execute',
      auditEventId: expect.any(String),
    }));
    const available = await api(server, '/api/expert-r/capabilities', { token: owner.token });
    expect(available.status).toBe(200);
    expect(available.data).toEqual({ expertREnabled: true, expertRProfile: EXPERT_R_PROFILE });

    const source = 'write_table(data.frame(cells=1), "summary.csv")';
    const created = await api(server, `/api/projects/${owner.project.id}/jobs`, {
      method: 'POST', token: owner.token, body: expertJobBody(owner.object.id, source),
    });
    expect(created.status).toBe(201);
    expect(created.data.parameters).toEqual({
      profileId: EXPERT_R_PROFILE.id,
      inputIds: [],
      scriptSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(JSON.stringify(created.data)).not.toContain(source);

    const stored = await db.query('SELECT parameters_json FROM jobs WHERE id = $1', [created.data.id]);
    expect(JSON.parse(stored.rows[0].parameters_json)).toEqual({
      profileId: EXPERT_R_PROFILE.id,
      script: source,
      inputIds: [],
      scriptSha256: created.data.parameters.scriptSha256,
    });
  });

  it('cancels a queued request before handler contact when the grant is revoked', async () => {
    const owner = await seedOwnerProject('revoked-expert@example.com');
    await db.setExpertRExecutorByEmail(owner.user.email, true);
    const created = await db.createProjectJob(owner.user.id, owner.project.id, expertJobBody(owner.object.id));

    await db.setExpertRExecutorByEmail(owner.user.email, false);
    const claimed = await db.claimNextJob('expert-worker', {
      allowedJobTypes: ['expert.r.v1'],
      leaseSeconds: 30,
    });
    expect(claimed).toBeNull();

    const stored = await db.query(
      'SELECT status, error_json, parameters_json FROM jobs WHERE id = $1',
      [created.id]
    );
    expect(stored.rows[0].status).toBe('canceled');
    expect(JSON.parse(stored.rows[0].error_json)).toMatchObject({ code: 'EXPERT_R_ACCESS_REVOKED' });
    expect(JSON.parse(stored.rows[0].parameters_json)).toEqual({
      profileId: EXPERT_R_PROFILE.id,
      inputIds: [],
      scriptSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it('scrubs source after a claimed request reaches a terminal state', async () => {
    const owner = await seedOwnerProject('terminal-expert@example.com');
    await db.setExpertRExecutorByEmail(owner.user.email, true);
    const created = await db.createProjectJob(owner.user.id, owner.project.id, expertJobBody(owner.object.id));
    const claimed = await db.claimNextJob('terminal-expert-worker', {
      allowedJobTypes: ['expert.r.v1'],
      leaseSeconds: 30,
    });
    expect(claimed.id).toBe(created.id);
    expect(claimed.parameters.script).toMatch(/write_table/);

    await db.failJobByWorker(
      claimed.id,
      'terminal-expert-worker',
      claimed.claimToken,
      { code: 'TEST_FAILURE', message: 'Expected test failure.' }
    );
    const stored = await db.query('SELECT parameters_json FROM jobs WHERE id = $1', [created.id]);
    expect(JSON.parse(stored.rows[0].parameters_json)).toEqual({
      profileId: EXPERT_R_PROFILE.id,
      inputIds: [],
      scriptSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it('keeps results private to the creator until an explicit branch publish', async () => {
    const owner = await seedOwnerProject('private-expert@example.com');
    const collaborator = await createUserWithToken({
      email: 'expert-collaborator@example.com',
      displayName: 'Collaborator',
    });
    await db.addProjectMemberByEmail(
      owner.project.id,
      collaborator.user.email,
      'analyst',
      { userId: owner.user.id }
    );

    const checkpointJob = await db.createProjectJob(owner.user.id, owner.project.id, {
      jobType: 'generic',
      analysisObjectId: owner.object.id,
    });
    const checkpointClaim = await db.claimNextJob('checkpoint-seed-worker', {
      allowedJobTypes: ['generic'], leaseSeconds: 30,
    });
    const checkpointArtifact = await db.createCheckpointArtifactForJobByWorker(
      checkpointJob.id,
      'checkpoint-seed-worker',
      checkpointClaim.claimToken,
      {
        artifactType: 'checkpoint',
        resultAnalysisObjectId: owner.object.id,
        internalStorageKey: `projects/${owner.project.id}/checkpoints/${checkpointJob.id}/checkpoint.rds`,
        checksumSha256: 'c'.repeat(64),
        sizeBytes: 2048,
      }
    );
    await db.completeJobByWorker(
      checkpointJob.id,
      'checkpoint-seed-worker',
      checkpointClaim.claimToken
    );

    await db.setExpertRExecutorByEmail(owner.user.email, true);
    const expertJob = await db.createProjectJob(
      owner.user.id,
      owner.project.id,
      expertJobBody(owner.object.id)
    );
    const expertClaim = await db.claimNextJob('private-expert-worker', {
      allowedJobTypes: ['expert.r.v1'], leaseSeconds: 30,
    });
    const provenance = {
      packageProfileId: EXPERT_R_PROFILE.id,
      sandboxImageDigest: `sha256:${'d'.repeat(64)}`,
      resourcePolicyVersion: 'expert-r-sandbox-policy.v2',
      scriptSha256: expertClaim.parameters.scriptSha256,
      input: {
        analysisObjectId: owner.object.id,
        checkpointArtifactId: checkpointArtifact.id,
        checkpointChecksumSha256: checkpointArtifact.checksumSha256,
        checkpointSizeBytes: checkpointArtifact.sizeBytes,
      },
    };
    const files = [{ name: 'summary.csv', sizeBytes: 10, checksumSha256: 'f'.repeat(64) }];
    const completion = await db.completeExpertRResultByWorker(
      expertJob.id,
      'private-expert-worker',
      expertClaim.claimToken,
      {
        result: {
          objectType: 'generic',
          displayName: 'Private Expert R result',
          metadata: {
            analysisKind: 'expert_r',
            ...provenance,
            outputBundleChecksumSha256: 'e'.repeat(64),
            nFiles: 1,
          },
        },
        bundleArtifact: {
          artifactType: 'expert_r_bundle',
          storageKind: 'local_internal',
          internalStorageKey: `projects/${owner.project.id}/artifacts/${expertJob.id}/expert-r-outputs.tar.gz`,
          checksumSha256: 'e'.repeat(64),
          sizeBytes: 100,
          metadata: { ...provenance, nFiles: 1, outputBytes: 10, files },
        },
        summaryArtifact: {
          artifactType: 'expert_r_summary',
          storageKind: 'metadata_only',
          metadata: {
            ...provenance,
            outputBundleChecksumSha256: 'e'.repeat(64),
            outputBundleSizeBytes: 100,
            nFiles: 1,
            files,
            downloadable: false,
          },
        },
      }
    );
    await db.completeJobByWorker(
      expertJob.id,
      'private-expert-worker',
      expertClaim.claimToken,
      { resultAnalysisObjectId: completion.resultObject.id }
    );

    expect(await db.getProjectAnalysisObject(
      owner.user.id, owner.project.id, completion.resultObject.id
    )).toBeTruthy();
    expect(await db.getProjectAnalysisObject(
      collaborator.user.id, owner.project.id, completion.resultObject.id
    )).toBeNull();
    expect(await db.getProjectJob(
      collaborator.user.id, owner.project.id, expertJob.id
    )).toBeNull();
    expect(await db.getProjectArtifact(
      collaborator.user.id, owner.project.id, completion.bundleArtifact.id
    )).toBeNull();
    expect((await db.listProjectAnalysisObjectChildren(
      collaborator.user.id, owner.project.id, owner.object.id
    )).map((edge) => edge.childAnalysisObjectId)).not.toContain(completion.resultObject.id);
    await expect(researchExports.authorizeArtifactDownload(
      collaborator.user.id, owner.project.id, completion.bundleArtifact.id
    )).rejects.toMatchObject({ code: 'ARTIFACT_NOT_DOWNLOADABLE' });

    const branch = await analysisBranches.createBranch(owner.user.id, owner.project.id, {
      name: 'expert-r/reviewed-output',
      baseAnalysisObjectId: completion.resultObject.id,
    });
    await analysisBranches.publishBranch(owner.user.id, owner.project.id, branch.id);

    expect(await db.getProjectAnalysisObject(
      collaborator.user.id, owner.project.id, completion.resultObject.id
    )).toBeTruthy();
    expect(await db.getProjectJob(
      collaborator.user.id, owner.project.id, expertJob.id
    )).toBeTruthy();
    expect(await db.getProjectArtifact(
      collaborator.user.id, owner.project.id, completion.bundleArtifact.id
    )).toBeTruthy();
    await expect(researchExports.authorizeArtifactDownload(
      collaborator.user.id, owner.project.id, completion.bundleArtifact.id
    )).resolves.toMatchObject({ filename: expect.stringMatching(/expert_r_bundle/) });
  });
});
