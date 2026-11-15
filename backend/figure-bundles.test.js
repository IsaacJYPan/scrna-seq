import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

const config = require('./config');
const db = require('./pgDatabase');
const { createOrganizationForUser, createProjectForUser, addProjectMemberByEmail, createLineageEdge } = db;
const { startServer, createUserWithToken, api } = require('./_http-test-utils');

const CONFIGURED = config.hasPostgresConnection();
let server;

beforeAll(async () => { if (!CONFIGURED) return; server = await startServer(); });
afterAll(async () => { if (!CONFIGURED) return; if (server) await new Promise((resolve) => server.close(resolve)); await db.close(); });
beforeEach(async () => { if (!CONFIGURED) return; await db.resetSchemaForTests(); });

async function setup() {
  const alice = await createUserWithToken({ email: 'alice@example.com', displayName: 'Alice' });
  const bob = await createUserWithToken({ email: 'bob@example.com', displayName: 'Bob' });
  const vera = await createUserWithToken({ email: 'vera@example.com', displayName: 'Vera' });
  const org = await createOrganizationForUser(alice.user.id, { name: 'Lab' });
  const project = await createProjectForUser(alice.user.id, { organizationId: org.id, name: 'Atlas' });
  await addProjectMemberByEmail(project.id, 'bob@example.com', 'analyst', 'owner');
  await addProjectMemberByEmail(project.id, 'vera@example.com', 'viewer', 'owner');
  return { alice, bob, vera, project };
}

const post = (path, token, body) => api(server, path, { method: 'POST', token, body });

async function step(projectId, token, analysisObjectId, operation, script = `# ${operation}\n`) {
  const res = await post(`/api/projects/${projectId}/provenance`, token, {
    analysisObjectId, operation, script, language: 'R',
  });
  expect(res.status).toBe(201);
  // Keep server timestamps strictly ordered.
  await new Promise((resolve) => setTimeout(resolve, 5));
  return res.data;
}

describe.skipIf(!CONFIGURED)('figure bundles', () => {
  it('exports only what selected figures need, in dependency order, with a script', async () => {
    const { alice, vera, project } = await setup();
    const base = `/api/projects/${project.id}`;
    const root = (await post(`${base}/analysis-objects`, alice.token, { objectType: 'seurat' })).data;
    const load = await step(project.id, alice.token, root.id, 'load', 'obj <- Read10X_h5("pbmc.h5")\n');
    const norm = await step(project.id, alice.token, root.id, 'normalize', 'obj <- NormalizeData(obj)\n');
    const pca = await step(project.id, alice.token, root.id, 'pca', 'obj <- RunPCA(obj)\n');
    const child = (await post(`${base}/analysis-objects`, alice.token, { objectType: 'seurat' })).data;
    await createLineageEdge(alice.user.id, { parentObjectId: root.id, childObjectId: child.id, edgeType: 'checkpoint' });
    const cluster = await step(project.id, alice.token, child.id, 'cluster', 'obj <- FindClusters(obj)\n');
    const umap = await step(project.id, alice.token, child.id, 'umap', 'obj <- RunUMAP(obj, dims = 1:10)\n');
    const umapFig = (await post(`${base}/figures`, alice.token, {
      analysisObjectId: child.id, plotType: 'UMAP', title: 'Clusters',
      params: { group_by: 'seurat_clusters', pt_size: 0.5 }, collection: 'Figure 1', tags: ['main', 'umap'],
    })).data;
    expect(umapFig.collection).toBe('Figure 1');
    expect(umapFig.tags).toEqual(['main', 'umap']);
    // Work after the figure, and an unrelated marker step, must not be kept.
    const deg = await step(project.id, alice.token, child.id, 'deg', 'markers <- FindAllMarkers(obj)\n');

    const res = await post(`${base}/figures/bundles`, vera.token, { figureIds: [umapFig.id] });
    expect(res.status).toBe(200);
    const bundle = res.data;
    expect(bundle.schema).toBe('traceomics.figure-bundle');
    const stepIds = bundle.order.filter((node) => node.kind === 'step').map((node) => node.id);
    expect(stepIds).toEqual([load.id, norm.id, pca.id, cluster.id, umap.id]);
    expect(bundle.omittedSteps.map((s) => s.id)).toEqual([deg.id]);
    expect(bundle.objects.map((o) => o.id)).toEqual([root.id, child.id]);
    expect(bundle.summary.kept.steps).toBe(5);
    expect(bundle.script.indexOf('Read10X_h5')).toBeLessThan(bundle.script.indexOf('RunPCA'));
    expect(bundle.script.indexOf('RunPCA')).toBeLessThan(bundle.script.indexOf('FindClusters'));
    expect(bundle.script).toContain('DimPlot(obj, reduction = "umap"');
    expect(bundle.script).not.toContain('FindAllMarkers');

    const script = await api(server, `${base}/figures/bundles?format=r`, {
      method: 'POST', token: vera.token, body: { figureIds: [umapFig.id] },
    });
    expect(script.status).toBe(200);

    const audit = await db.query(
      `SELECT action, details_json FROM project_audit_events WHERE project_id = $1 AND action = 'figure.bundle_exported'`,
      [project.id]
    );
    expect(audit.rows.length).toBe(2);
    expect(JSON.parse(audit.rows[0].details_json).stepCount).toBe(5);
  });

  it('rejects empty, malformed and foreign selections', async () => {
    const { alice, project } = await setup();
    const base = `/api/projects/${project.id}`;
    expect((await post(`${base}/figures/bundles`, alice.token, {})).status).toBe(400);
    expect((await post(`${base}/figures/bundles`, alice.token, { figureIds: ['../x'] })).status).toBe(400);
    expect((await post(`${base}/figures/bundles`, alice.token, { figureIds: ['fig_deadbeef'] })).status).toBe(404);
    const outsider = await createUserWithToken({ email: 'eve@example.com', displayName: 'Eve' });
    expect((await post(`${base}/figures/bundles`, outsider.token, { analysisObjectIds: ['ao_deadbeef'] })).status).toBe(404);
  });

  it('lets the author or an owner organise figures, and viewers only read', async () => {
    const { alice, bob, vera, project } = await setup();
    const base = `/api/projects/${project.id}/figures`;
    const fig = (await post(base, bob.token, { plotType: 'DotPlot', title: 'Markers' })).data;
    const patch = (token, body, id = fig.id) => api(server, `${base}/${id}`, { method: 'PATCH', token, body });

    const edited = await patch(bob.token, { title: '  Marker dot plot ', collection: 'Figure 2', tags: ['Main', 'main', ' dot '] });
    expect(edited.status).toBe(200);
    expect(edited.data).toMatchObject({ title: 'Marker dot plot', collection: 'Figure 2', tags: ['Main', 'dot'] });
    expect(edited.data.updatedAt).toBeTruthy();

    expect((await patch(vera.token, { title: 'x' })).status).toBe(403);
    expect((await patch(bob.token, { plotType: 'UMAP' })).status).toBe(400);
    expect((await patch(bob.token, { tags: 'nope' })).status).toBe(400);
    expect((await patch(alice.token, { notes: 'Panel B of the revision.' })).status).toBe(200);

    const aliceFig = (await post(base, alice.token, { plotType: 'UMAP' })).data;
    expect((await patch(bob.token, { title: 'mine now' }, aliceFig.id)).status).toBe(403);
    expect((await api(server, `${base}/${aliceFig.id}`, { method: 'DELETE', token: bob.token })).status).toBe(403);
    expect((await api(server, `${base}/${aliceFig.id}`, { method: 'DELETE', token: alice.token })).status).toBe(204);
    expect((await api(server, `${base}/${aliceFig.id}`, { token: alice.token })).status).toBe(404);
  });
});
