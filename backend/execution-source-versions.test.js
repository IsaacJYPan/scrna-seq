import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';

const db = require('./pgDatabase');
const { environmentFixture } = require('./_r-environment-test-utils');
const keys = ['APP_DEPLOYMENT_MODE', 'EXPERT_R_ENABLED', 'EXPERT_R_SANDBOX_URL', 'EXPERT_R_SANDBOX_TOKEN', 'EXPERT_R_ACCESS_POLICY'];
const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
let user, project, object;
describe.skipIf(!process.env.DATABASE_URL)('creator-private source versions on real PostgreSQL', () => {
  beforeEach(async () => {
    process.env.APP_DEPLOYMENT_MODE = 'private'; process.env.EXPERT_R_ENABLED = 'true';
    process.env.EXPERT_R_SANDBOX_URL = 'http://127.0.0.1:8090'; process.env.EXPERT_R_SANDBOX_TOKEN = 'a'.repeat(64);
    process.env.EXPERT_R_ACCESS_POLICY = 'project-roles';
    await db.resetSchemaForTests();
    user = await db.createUser('source-owner@example.test', 'password123', 'Source owner');
    const organization = await db.createOrganizationForUser(user.id, { name: 'Source lab' });
    project = await db.createProjectForUser(user.id, { organizationId: organization.id, name: 'Recorded source' });
    object = await db.createProjectAnalysisObject(user.id, project.id, { objectType: 'seurat', displayName: 'Selected checkpoint' });
  });
  afterAll(async () => {
    for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    await db.close();
  });
  const source = 'write_table(data.frame(cells=ncol(object)), "cells.csv")';
  const create = (script = source) => db.createProjectJob(user.id, project.id, {
    analysisObjectId: object.id, jobType: 'expert.r.v1',
    parameters: { profileId: environmentFixture().reference.profileId, script, environment: environmentFixture().reference },
  });

  it('retains exact source and its creator identity atomically with the queued job', async () => {
    const job = await create();
    const { rows } = await db.query('SELECT * FROM execution_source_versions WHERE job_id=$1', [job.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'src_' + job.id, project_id: project.id, owner_user_id: String(user.id),
      job_id: job.id, language: 'R', source_code: source, source_sha256: createHash('sha256').update(source).digest('hex') });
  });

  it('keeps immutable source and environment after terminal transport script erasure', async () => {
    const job = await create(); await db.cancelProjectJob(user.id, project.id, job.id);
    const canceled = await db.getProjectJob(user.id, project.id, job.id);
    expect(canceled.status).toBe('canceled'); expect(canceled.parameters.script).toBeUndefined();
    expect(canceled.parameters.environment).toEqual(environmentFixture().reference);
    expect(canceled.parameters.scriptSha256).toBe(createHash('sha256').update(source).digest('hex'));
    const { rows } = await db.query('SELECT source_code FROM execution_source_versions WHERE job_id=$1', [job.id]);
    expect(rows[0].source_code).toBe(source);
    await expect(db.query('UPDATE execution_source_versions SET source_code=$1 WHERE job_id=$2', ['changed source', job.id]))
      .rejects.toMatchObject({ code: '55000' });
  });

  it('rolls back the queued job if private source retention fails', async () => {
    await db.query("ALTER TABLE execution_source_versions ADD CONSTRAINT review_source_failure CHECK (source_code <> 'stop(1)')");
    try {
      await expect(create('stop(1)')).rejects.toMatchObject({ code: '23514' });
      expect((await db.query('SELECT id FROM jobs WHERE project_id=$1', [project.id])).rows).toHaveLength(0);
      expect((await db.query('SELECT id FROM execution_source_versions WHERE project_id=$1', [project.id])).rows).toHaveLength(0);
    } finally { await db.query('ALTER TABLE execution_source_versions DROP CONSTRAINT review_source_failure'); }
  });
});
