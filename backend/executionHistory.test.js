import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const db = require('./pgDatabase'); const storage = require('./storage');
const { createExecutionHistoryService } = require('./executionHistory');
const { seedExecutionHistory, seedRetainedExpertSource, sha } = require('./_executionHistoryFixtures');
const configured = Boolean(process.env.DATABASE_URL);
let directory, savedRoot, provider, service, http, server, owner, viewer, outsider, project, fixtures;
describe.skipIf(!configured)('execution history through actual authenticated HTTP/PostgreSQL/storage', () => {
  beforeAll(async () => {
    savedRoot = process.env.STORAGE_ROOT; directory = await mkdtemp(path.join(os.tmpdir(), 'traceomics-history-')); process.env.STORAGE_ROOT = directory;
    provider = { ...storage.createLocalStorageProvider() }; service = createExecutionHistoryService(db, provider);
    http = require('./_http-test-utils'); server = await http.startServer();
  });
  beforeEach(async () => {
    vi.restoreAllMocks(); await db.resetSchemaForTests();
    owner = await http.createUserWithToken({ email: 'history-owner@example.test', displayName: 'History researcher' });
    viewer = await http.createUserWithToken({ email: 'history-viewer@example.test', displayName: 'History viewer' });
    outsider = await http.createUserWithToken({ email: 'history-outsider@example.test' });
    const organization = await db.createOrganizationForUser(owner.user.id, { name: 'History lab' });
    project = await db.createProjectForUser(owner.user.id, { organizationId: organization.id, name: 'Recorded analyses' });
    await db.addProjectMemberByEmail(project.id, viewer.user.email, 'viewer', { userId: owner.user.id });
    fixtures = await seedExecutionHistory(db, provider, owner.user.id, project.id);
  });
  afterAll(async () => { vi.restoreAllMocks(); if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } await db.close(); if (savedRoot === undefined) delete process.env.STORAGE_ROOT; else process.env.STORAGE_ROOT = savedRoot; if (directory) await rm(directory, { recursive: true, force: true }); });
  const base = () => `/api/execution-history/${project.id}`;
  const get = (suffix = '', token = owner.token) => http.api(server, base() + suffix, { token });

  it('requires current project membership for listing and every private detail/manifest', async () => {
    expect((await get('', null)).status).toBe(401);
    expect((await get('', outsider.token)).status).toBe(404);
    expect((await get('/' + fixtures.guided.id, outsider.token)).status).toBe(404);
    expect((await get('/' + fixtures.expert.id + '/environment', outsider.token)).status).toBe(404);
    const listed = await get(); expect(listed.status).toBe(200);
    expect(new Set(listed.data.items.map(item => item.kind))).toEqual(new Set(['guided', 'workflow', 'expert-r', 'live-r', 'provenance']));
  });
  it('links recorded resolved parameters and output hashes without inventing exact consumed checkpoints', async () => {
    const { data: detail, status } = await get('/' + fixtures.guided.id); expect(status).toBe(200);
    expect(detail.parameters).toMatchObject({ precision: 'recorded-resolved', values: { dims: 10, minPct: 0.1 } });
    expect(detail.source).toMatchObject({ code: 'FindAllMarkers(object, min.pct = 0.1)', precision: 'exact-retained' });
    expect(detail.inputs[0]).toMatchObject({ analysisObjectId: fixtures.object.id, precision: 'identity-only', reference: null });
    expect(detail.outputs[0]).toMatchObject({ versionId: fixtures.result.id, sha256: fixtures.result.sha256, inspectable: true });
    expect(detail.replay.issues.map(issue => issue.code)).toContain('inputs-not-versioned');
    expect(detail.replay.issues.map(issue => issue.code)).toContain('source-provenance-unverified');
    expect(detail.kernel).toMatchObject({ available: false }); expect(detail.timestamps.startedAt).toBeTruthy();
  });
  it('distinguishes server-journal kernel order/result revision from unverified imported provenance', async () => {
    const live = (await get('/' + fixtures.live.id)).data;
    expect(live).toMatchObject({ origin: 'server-live-r', source: { code: 'object <- RunPCA(object, npcs = 10)' }, parameters: { precision: 'recorded-resolved', values: { npcs: 10 } }, kernel: { available: true, generation: 'c'.repeat(64), order: 7, resultLiveRevision: 3 } });
    expect(live.environment.observed.packages).toEqual([{ name: 'Seurat', version: '5.3.0' }]);
    const imported = (await get('/' + fixtures.imported.id)).data;
    expect(imported.origin).toBe('imported-provenance'); expect(imported.kernel.available).toBe(false);
    expect(imported.replay.issues.map(issue => issue.code)).toContain('imported-provenance');
  });
  it('shares job activity summaries while protecting collaborator code/parameters/inputs/manifests', async () => {
    const list = (await get('', viewer.token)).data;
    expect(list.items).toHaveLength(3); expect(list.items.every(item => !item.detailAvailable)).toBe(true);
    expect(JSON.stringify(list)).not.toContain('FindAllMarkers'); expect(JSON.stringify(list)).not.toContain('source');
    for (const id of [fixtures.guided.id, fixtures.expert.id, fixtures.workflow.id, fixtures.live.id, fixtures.imported.id]) expect((await get('/' + id, viewer.token)).status).toBe(404);
    expect((await get('/' + fixtures.expert.id + '/environment', viewer.token)).status).toBe(404);
  });
  it('omits transport credentials, native paths and raw worker failure details even from owner inspection', async () => {
    await db.query('UPDATE jobs SET parameters_json=$2,error_json=$3,worker_id=$4,claim_token=$5 WHERE id=$1', [fixtures.guided.id, JSON.stringify({ password: 'private-password', innocent: 'postgresql://user:private-password@server/db', nested: { storage_key: '/mnt/private/input.rds' } }), JSON.stringify({ message: 'C:\\private\\worker\\failure' }), 'worker-private', 'claim-private']);
    await db.query('DELETE FROM job_artifacts WHERE job_id=$1', [fixtures.guided.id]);
    await db.query('UPDATE provenance SET script=$2 WHERE job_id=$1', [fixtures.guided.id, 'input <- readRDS("/home/private/object.rds"); token = "private-secret"']);
    const { data: detail } = await get('/' + fixtures.guided.id);
    const text = JSON.stringify(detail);
    for (const privateValue of ['private-password', '/mnt/private', '/home/private', 'private-secret', 'worker-private', 'claim-private', 'C:\\private']) expect(text).not.toContain(privateValue);
    expect(detail.source).toMatchObject({ code: null, precision: 'withheld', sha256: sha('input <- readRDS("/home/private/object.rds"); token = "private-secret"') });
    expect(detail.replay.issues.map(issue => issue.code)).toContain('parameters-redacted');
  });
  it('uses only matching workflow results, preserving exact inputs/seed/source and disclosing replaced historical state', async () => {
    const detail = (await get('/' + fixtures.workflow.id)).data;
    expect(detail.kind).toBe('workflow'); expect(detail.source.precision).toBe('exact-retained');
    expect(detail.source.package.stepId).toBe('summary'); expect(detail.parameters).toMatchObject({ precision: 'resolved-snapshot', values: { threshold: 2 }, seed: 42 });
    expect(detail.inputs[0].reference.sha256).toBe(fixtures.checkpoint.sha256); expect(detail.kernel.available).toBe(false);
    const state = structuredClone(fixtures.workflow.state); state.results.summary.parameters.threshold = 99; state.results.summary.outputs.summary.id = 'eri_' + 'd'.repeat(24);
    await db.query('UPDATE workflow_instances SET state_json=$2 WHERE id=$1', [fixtures.workflow.instanceId, state]);
    const later = (await get('/' + fixtures.workflow.id)).data;
    expect(later.parameters.precision).toBe('unavailable'); expect(later.parameters.values).toEqual({}); expect(later.parameters.seed).toBeNull();
    expect(later.replay.issues.map(issue => issue.code)).toContain('workflow-run-snapshot-missing');
  });
  it('retains terminal Expert R source hash and verifies private environment artifact bytes before manifest delivery', async () => {
    const detail = (await get('/' + fixtures.expert.id)).data;
    expect(detail.source).toMatchObject({ precision: 'hash-only', code: null });
    expect(detail.environment).toMatchObject({ precision: 'pinned-reference', reference: fixtures.environment.reference });
    const manifest = await get('/' + fixtures.expert.id + '/environment');
    expect(manifest.status).toBe(200); expect(manifest.data).toMatchObject({ integrityVerified: true, manifest: fixtures.environment.manifest });
    const size = Number((await db.query('SELECT size_bytes FROM job_artifacts WHERE id=$1', [fixtures.environment.id])).rows[0].size_bytes);
    const metadata = { environment: fixtures.environment.reference, environmentArtifact: { id: 'art_' + 'd'.repeat(24), checksumSha256: fixtures.environment.reference.manifestSha256, sizeBytes: size } };
    await db.query('UPDATE job_artifacts SET metadata_json=$2 WHERE id=$1', [fixtures.environment.id, JSON.stringify(metadata)]);
    expect((await get('/' + fixtures.expert.id + '/environment')).status).toBe(409);
    metadata.environmentArtifact.id = fixtures.environment.id;
    await db.query('UPDATE job_artifacts SET metadata_json=$2 WHERE id=$1', [fixtures.environment.id, JSON.stringify(metadata)]);
    await writeFile(provider.resolveKey(fixtures.environment.key), '{"changed":true}');
    expect((await get('/' + fixtures.expert.id + '/environment')).status).toBe(409);
  });
  it('marks altered pinned recipes inconsistent without executing or presenting their source as exact', async () => {
    const recipe = structuredClone(fixtures.workflow.recipe); recipe.files['summary.R'] = 'write_output("summary", list(cells = 999))';
    await db.query('UPDATE workflow_instances SET package_json=$2 WHERE id=$1', [fixtures.workflow.instanceId, JSON.stringify(recipe)]);
    const detail = (await get('/' + fixtures.workflow.id)).data;
    expect(detail.source).toMatchObject({ precision: 'inconsistent', code: null });
    expect(detail.replay.issues.map(issue => issue.code)).toContain('workflow-package-inconsistent');
  });
  it('atomically retains new creator-private source for failed jobs while removing terminal transport code', async () => {
    const job = await seedRetainedExpertSource(db, owner.user.id, project.id, fixtures.object.id, fixtures.environment.reference);
    const row = (await db.query('SELECT parameters_json FROM jobs WHERE id=$1', [job.id])).rows[0];
    expect(row.parameters_json.script).toBeUndefined();
    const result = await get('/' + job.id); expect(result.status).toBe(200);
    expect(result.data.source).toMatchObject({ versionId: job.sourceVersionId, precision: 'exact-retained', code: job.code, sha256: job.sourceSha256 });
    expect(result.data.replay.issues.map(issue => issue.code)).not.toContain('expert-source-retention');
    expect((await get('/' + job.id, viewer.token)).status).toBe(404);
    await expect(db.query('UPDATE execution_source_versions SET source_code=$2 WHERE job_id=$1', [job.id, 'print(999)'])).rejects.toMatchObject({ code: '55000' });
    await db.query("UPDATE jobs SET parameters_json=jsonb_set(parameters_json::jsonb,'{scriptSha256}',to_jsonb($2::text)) WHERE id=$1", [job.id, 'e'.repeat(64)]);
    expect((await get('/' + job.id)).data.source).toMatchObject({ precision: 'inconsistent', code: null });
  });
  it('rechecks access after hashing a manifest and closes private bytes on revocation', async () => {
    const open = provider.openVerifiedRead; let handle;
    vi.spyOn(provider, 'openVerifiedRead').mockImplementation(async (...args) => {
      const verified = await open(...args); handle = verified.handle;
      await db.query('DELETE FROM project_members WHERE project_id=$1 AND user_id=$2', [project.id, owner.user.id]);
      return verified;
    });
    await expect(service.environment(owner.user.id, project.id, fixtures.expert.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(handle.stat()).rejects.toThrow();
  });
  it('paginates mixed-category microsecond ties without omissions and bounds all admission options', async () => {
    await db.query("UPDATE jobs SET created_at='2026-10-08T01:00:00.123001Z' WHERE project_id=$1", [project.id]);
    await db.query("UPDATE provenance SET created_at='2026-10-08T01:00:00.123003Z' WHERE project_id=$1", [project.id]);
    await db.query("UPDATE live_execution_records SET created_at='2026-10-08T01:00:00.123004Z' WHERE project_id=$1", [project.id]);
    const collected = []; let before;
    do { const page = await service.list(owner.user.id, project.id, { limit: 1, before }); collected.push(...page.items.map(item => item.id)); before = page.nextCursor; } while (before);
    expect(collected).toHaveLength(5); expect(new Set(collected).size).toBe(5);
    for (const suffix of ['?limit=51', '?kind=invalid', '?before=' + 'x'.repeat(257)]) expect((await get(suffix)).status).toBe(400);
    expect((await get('/unknown')).status).toBe(404);
  });
});
