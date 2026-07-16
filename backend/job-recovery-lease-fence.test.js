import { describe, it, expect, beforeEach, afterAll } from 'vitest';

const config = require('./config');
const db = require('./pgDatabase');

const CONFIGURED = config.hasPostgresConnection();

async function waitUntilAfter(timestamp, marginMs = 1500) {
  const deadline = new Date(`${timestamp.replace(' ', 'T')}Z`).getTime() + marginMs;
  const remaining = Math.max(0, deadline - Date.now());
  await new Promise((resolve) => setTimeout(resolve, remaining));
}

beforeEach(async () => {
  if (CONFIGURED) await db.resetSchemaForTests();
});

afterAll(async () => {
  if (CONFIGURED) await db.close();
});

describe.skipIf(!CONFIGURED)('committed-output recovery lease fencing', () => {
  it('cannot complete with a claim that expires while durable output is being verified', async () => {
    const user = await db.createUser(
      'expired-recovery-claim@example.com',
      'password123',
      'Expired recovery claim'
    );
    const organization = await db.createOrganizationForUser(user.id, { name: 'Recovery fence org' });
    const project = await db.createProjectForUser(user.id, {
      organizationId: organization.id,
      name: 'Recovery fence project',
    });
    const object = await db.createProjectAnalysisObject(user.id, project.id, {
      objectType: 'seurat',
    });
    const job = await db.createProjectJob(user.id, project.id, {
      jobType: 'deg.find_markers.v1',
      analysisObjectId: object.id,
      parameters: {},
    });
    const workerId = 'worker-expiring-recovery';
    const claim = await db.claimNextJob(workerId, { leaseSeconds: 5 });

    await db.completeDegFindMarkersResultByWorker(
      job.id,
      workerId,
      claim.claimToken,
      {
        markersArtifact: {
          artifactType: 'deg_markers',
          storageKind: 'local_internal',
          internalStorageKey: `projects/${project.id}/artifacts/${job.id}/markers.csv`,
          checksumSha256: 'a'.repeat(64),
          sizeBytes: 42,
          metadata: {},
        },
        summaryArtifact: {
          artifactType: 'deg_summary',
          storageKind: 'metadata_only',
          metadata: {},
        },
      }
    );

    await expect(db.resumeCommittedJobByWorker(
      job.id,
      workerId,
      claim.claimToken,
      {
        inspectStorageObject: async () => {
          await waitUntilAfter(claim.leaseExpiresAt);
          return { sizeBytes: 42, checksumSha256: 'a'.repeat(64) };
        },
      }
    )).rejects.toMatchObject({ code: 'CLAIM_LOST' });

    await expect(db.getWorkerJob(job.id)).resolves.toMatchObject({
      status: 'running',
      claimToken: claim.claimToken,
    });
  }, 15000);
});
