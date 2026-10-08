import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { digest } from './workflowRuntime';

const db = require('./pgDatabase');
const configured = Boolean(process.env.DATABASE_URL);
const settings = ['APP_DEPLOYMENT_MODE', 'EXPERT_R_ENABLED', 'EXPERT_R_SANDBOX_URL', 'EXPERT_R_SANDBOX_TOKEN', 'EXPERT_R_ACCESS_POLICY'];
let server, http, user, token, project, savedSettings, v2;
const legacy = {
  format: 'traceomics-workflow', schemaVersion: 1, id: 'summary', name: 'Summary', version: '1.0.0', description: 'Count cells.',
  runtime: { language: 'r', profileId: 'scrna-r-4.5-bioconductor-3.22-v1' }, files: { 'summary.R': 'write_output("summary", list(cells = ncol(inputs$analysis)))' },
  steps: [{ id: 'summary', label: 'Summary', entry: 'summary.R', inputs: { analysis: { from: 'input.analysis', type: 'rds' } }, parameters: [], outputs: { summary: { type: 'metrics', label: 'Cell count' } } }],
  tabs: [{ id: 'summary', label: 'Summary', step: 'summary', plots: [] }],
};

describe.skipIf(!configured)('recipe HTTP admission with PostgreSQL', () => {
  beforeAll(async () => {
    savedSettings = Object.fromEntries(settings.map(key => [key, process.env[key]]));
    Object.assign(process.env, { APP_DEPLOYMENT_MODE: 'private', EXPERT_R_ENABLED: 'true', EXPERT_R_SANDBOX_URL: 'http://127.0.0.1:8090', EXPERT_R_SANDBOX_TOKEN: 'a'.repeat(64), EXPERT_R_ACCESS_POLICY: 'project-roles' });
    v2 = JSON.parse(await readFile(new URL('../examples/analysis-model/tissue-image-inspection.json', import.meta.url), 'utf8')).recipe;
    http = require('./_http-test-utils');
    server = await http.startServer();
  });
  beforeEach(async () => {
    vi.restoreAllMocks();
    await db.resetSchemaForTests();
    ({ user, token } = await http.createUserWithToken({ email: 'recipe-admission@example.test' }));
    const organization = await db.createOrganizationForUser(user.id, { name: 'Recipe lab' });
    project = await db.createProjectForUser(user.id, { organizationId: organization.id, name: 'Recipe study' });
  });
  afterAll(async () => {
    if (!configured) return;
    vi.restoreAllMocks();
    if (server) await new Promise(resolve => server.close(resolve));
    for (const [key, value] of Object.entries(savedSettings)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await db.close();
  });
  const open = (source, analysisObjectId = 'no-checkpoint') => http.api(server, `/api/workflows/${project.id}/open`, {
    method: 'POST', token, headers: { 'X-Traceomics-Csrf': '1' }, body: { source: typeof source === 'string' ? source : JSON.stringify(source), analysisObjectId },
  });

  it('returns useful 422 capabilities before checkpoint lookup, instance creation or job admission', async () => {
    const checkpoint = vi.spyOn(db, 'getLoadableCheckpointForAnalysisObject');
    const response = await open(v2);
    expect(response.status).toBe(422);
    expect(response.data).toMatchObject({ code: 'WORKFLOW_EXECUTOR_UNAVAILABLE', details: { schemaVersion: 2 } });
    expect(response.data.error).toContain('recipe is valid');
    expect(response.data.details.missing).toEqual(expect.arrayContaining([
      expect.objectContaining({ capability: 'schema:2' }),
      expect.objectContaining({ capability: 'operation:tool', stepId: 'preview-image' }),
      expect.objectContaining({ capability: 'operation:human', stepId: 'mark-region' }),
    ]));
    expect(checkpoint).not.toHaveBeenCalled();
    expect((await db.query('SELECT COUNT(*)::int AS count FROM workflow_instances')).rows[0].count).toBe(0);
    expect((await db.query('SELECT COUNT(*)::int AS count FROM jobs')).rows[0].count).toBe(0);
    expect(JSON.stringify(response.data)).not.toContain('SANDBOX_TOKEN');
    expect(JSON.stringify(response.data)).not.toContain('/work/');
  });
  it.each(['future-schema', 'missing-binding', 'duplicate-json'])('rejects %s before checkpoint or queue access', async mode => {
    const source = JSON.parse(JSON.stringify(v2));
    if (mode === 'future-schema') source.schemaVersion = 99;
    if (mode === 'missing-binding') source.steps[1].bindings.image.port = 'missing';
    const checkpoint = vi.spyOn(db, 'getLoadableCheckpointForAnalysisObject');
    const response = await open(mode === 'duplicate-json' ? '{"schemaVersion":1,"schemaVersion":2}' : source);
    expect(response.status).toBe(400);
    expect(response.data.error).toMatch(mode === 'future-schema' ? /supported versions are 1 and 2/ : mode === 'missing-binding' ? /root input missing/ : /Duplicate JSON key/);
    expect(checkpoint).not.toHaveBeenCalled();
    expect((await db.query('SELECT COUNT(*)::int AS count FROM jobs')).rows[0].count).toBe(0);
  });
  it('retains authenticated project authorization before revealing admission diagnostics', async () => {
    const outsider = await http.createUserWithToken({ email: 'unrelated-researcher@example.test' });
    const response = await http.api(server, `/api/workflows/${project.id}/open`, {
      method: 'POST', token: outsider.token, headers: { 'X-Traceomics-Csrf': '1' }, body: { source: JSON.stringify(v2), analysisObjectId: 'no-checkpoint' },
    });
    expect(response.status).toBe(404);
    expect(response.data.code).not.toBe('WORKFLOW_EXECUTOR_UNAVAILABLE');
    expect(response.data.details).toBeUndefined();
  });
  it('opens the original version-1 package against an exact saved checkpoint', async () => {
    const object = await db.createProjectAnalysisObject(user.id, project.id, { objectType: 'seurat', displayName: 'Saved input' });
    const seed = await db.createProjectJob(user.id, project.id, { jobType: 'generic', analysisObjectId: object.id });
    await db.query("UPDATE jobs SET status='completed' WHERE id=$1", [seed.id]);
    const artifactId = db.genId('art');
    const bytes = Buffer.from('opaque checkpoint placeholder; admission does not deserialize it');
    await db.query("INSERT INTO job_artifacts (id,project_id,job_id,created_by_user_id,artifact_type,result_analysis_object_id,storage_kind,storage_uri,checksum_sha256,size_bytes,status) VALUES ($1,$2,$3,$4,'checkpoint',$5,'local_internal',$6,$7,$8,'available')", [artifactId, project.id, seed.id, user.id, object.id, 'projects/' + project.id + '/checkpoints/' + seed.id + '/input.rds', digest(bytes), bytes.length]);
    const response = await open(legacy, object.id);
    expect(response.status).toBe(200);
    expect(response.data.package).toEqual(legacy);
    expect(response.data.state.root).toMatchObject({ id: artifactId, sha256: digest(bytes), type: 'rds' });
    expect(response.data.state.active).toBeNull();
    expect((await db.query('SELECT COUNT(*)::int AS count FROM workflow_instances')).rows[0].count).toBe(1);
    expect((await db.query('SELECT COUNT(*)::int AS count FROM jobs')).rows[0].count).toBe(1);
  });
});
