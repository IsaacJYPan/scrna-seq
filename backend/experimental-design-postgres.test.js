import { afterAll, beforeEach, describe, expect, it } from 'vitest';

const config = require('./config');
const db = require('./pgDatabase');
const design = require('./experimentalDesign');
const { startServer, createUserWithToken, api } = require('./_http-test-utils');

const CONFIGURED = config.hasPostgresConnection();

async function seed() {
  const owner = await db.createUser('design-owner@example.com', 'password123', 'Owner');
  const viewer = await db.createUser('design-viewer@example.com', 'password123', 'Viewer');
  const org = await db.createOrganizationForUser(owner.id, { name: 'Design lab' });
  const project = await db.createProjectForUser(owner.id, { organizationId: org.id, name: 'Replicated study' });
  await db.addProjectMemberByEmail(project.id, viewer.email, 'viewer', 'owner');
  const object = await db.createProjectAnalysisObject(owner.id, project.id, { objectType: 'seurat', displayName: 'Merged samples' });
  return { owner, viewer, project, object };
}

afterAll(async () => { if (CONFIGURED) await db.close(); });

describe.skipIf(!CONFIGURED)('Postgres experimental design', () => {
  beforeEach(async () => { await db.resetSchemaForTests(); });

  it('snapshots explicit object-bound biological replicates into a contrast', async () => {
    const { owner, viewer, project, object } = await seed();
    const treated = await design.createCondition(owner.id, project.id, { name: 'treated' });
    const control = await design.createCondition(owner.id, project.id, { name: 'control' });
    for (const [condition, prefix] of [[treated, 't'], [control, 'c']]) {
      for (let index = 1; index <= 3; index += 1) {
        const sample = await design.createSample(owner.id, project.id, {
          name: `${prefix}${index}`, conditionId: condition.id, donorCode: `d${index}`,
        });
        await design.bindSample(owner.id, project.id, object.id, {
          sampleId: sample.id, cellMetadataColumn: 'orig.ident', cellMetadataValue: `${prefix}${index}`,
        });
      }
    }
    const contrast = await design.createContrast(owner.id, project.id, {
      name: 'treated-v-control', analysisObjectId: object.id,
      numeratorConditionId: treated.id, denominatorConditionId: control.id,
      unitOfReplication: 'donor', paired: true,
    });
    expect(contrast.status).toBe('valid');
    expect(contrast.validation.counts).toEqual({
      numeratorSamples: 3, denominatorSamples: 3, numeratorUnits: 3, denominatorUnits: 3,
    });
    expect(contrast.modelFormula).toBe('~ donor + condition');
    await expect(design.createContrast(owner.id, project.id, {
      name: 'unsupported-adjustment', analysisObjectId: object.id,
      numeratorConditionId: treated.id, denominatorConditionId: control.id,
      unitOfReplication: 'sample', blockingFactor: 'batch', covariates: ['percent.mt'],
    })).rejects.toMatchObject({ code: 'UNSUPPORTED_CONDITION_MODEL' });
    expect(await design.listContrasts(viewer.id, project.id)).toHaveLength(1);
    await expect(design.createSample(viewer.id, project.id, {
      name: 'forbidden', conditionId: control.id,
    })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('enforces authenticated HTTP fields and project isolation', async () => {
    const { owner, project } = await seed();
    const server = await startServer();
    try {
      const session = await createUserWithToken({ email: 'http-owner@example.com' });
      const ownOrg = await db.createOrganizationForUser(session.user.id, { name: 'HTTP lab' });
      const ownProject = await db.createProjectForUser(session.user.id, { organizationId: ownOrg.id, name: 'HTTP design' });
      const created = await api(server, `/api/projects/${ownProject.id}/conditions`, {
        method: 'POST', token: session.token, body: { name: 'control' },
      });
      expect(created.status).toBe(201);
      expect(created.data.name).toBe('control');
      const injected = await api(server, `/api/projects/${ownProject.id}/conditions`, {
        method: 'POST', token: session.token, body: { name: 'treated', projectId: project.id },
      });
      expect(injected.status).toBe(400);
      const hidden = await api(server, `/api/projects/${project.id}/conditions`, { token: session.token });
      expect(hidden.status).toBe(404);
      expect(owner.id).toBeTruthy();
    } finally { await new Promise((resolve) => server.close(resolve)); }
  });
});
