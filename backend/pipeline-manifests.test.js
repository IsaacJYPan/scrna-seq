import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

const config = require('./config');
const db = require('./pgDatabase');
const {
  createOrganizationForUser,
  createProjectForUser,
  addProjectMemberByEmail,
  setPipelineRegistryPublisherByEmail,
  query,
} = db;
const { startServer, createUserWithToken, api } = require('./_http-test-utils');
const { DEFAULT_PIPELINE_ID, validatePipelineManifest } = require('./pipelineManifests');

const CONFIGURED = config.hasPostgresConnection();
const COOKIE_NAME = config.SESSION_COOKIE_NAME;

let server;

beforeAll(async () => {
  if (!CONFIGURED) return;
  server = await startServer();
});

afterAll(async () => {
  if (!CONFIGURED) return;
  if (server) await new Promise((resolve) => server.close(resolve));
  await db.close();
});

beforeEach(async () => {
  if (!CONFIGURED) return;
  await db.resetSchemaForTests();
});

async function user(email, displayName = email.split('@')[0]) {
  return createUserWithToken({ email, displayName });
}

async function seedProject(ownerUserId, name = 'Project X') {
  const org = await createOrganizationForUser(ownerUserId, { name: `${name} Org` });
  return createProjectForUser(ownerUserId, { organizationId: org.id, name });
}

function addMember(projectId, email, role) {
  return addProjectMemberByEmail(projectId, email, role, 'owner');
}

function manifest(overrides = {}) {
  return {
    schemaVersion: 1,
    id: 'trusted-inspection-view',
    name: 'Trusted Inspection View',
    description: 'A presentation-only composition of registered modules.',
    modality: 'scrna',
    tabs: [{ id: 'inspect', label: 'Inspect', moduleKey: 'inspectObject' }],
    ...overrides,
  };
}

async function grantPublisher(account) {
  return setPipelineRegistryPublisherByEmail(account.user.email, true);
}

async function publish(account, body = { manifest: manifest() }) {
  return api(server, '/api/pipeline-registry/definitions', {
    method: 'POST',
    token: account.token,
    body,
  });
}

describe.skipIf(!CONFIGURED)('trusted platform pipeline registry authorization', () => {
  it('does not derive platform publication from any project role and removes the old project upload route', async () => {
    const owner = await user('owner@example.com');
    const admin = await user('admin@example.com');
    const analyst = await user('analyst@example.com');
    const viewer = await user('viewer@example.com');
    const project = await seedProject(owner.user.id);
    await addMember(project.id, admin.user.email, 'admin');
    await addMember(project.id, analyst.user.email, 'analyst');
    await addMember(project.id, viewer.user.email, 'viewer');

    expect((await api(server, '/api/pipeline-registry/capabilities')).status).toBe(401);
    expect((await api(server, '/api/pipeline-registry/definitions', {
      method: 'POST', body: { manifest: manifest() },
    })).status).toBe(401);

    for (const [index, account] of [owner, admin, analyst, viewer].entries()) {
      const capability = await api(server, '/api/pipeline-registry/capabilities', { token: account.token });
      expect(capability.status).toBe(200);
      expect(capability.data).toEqual({ canPublishPipelineManifests: false });

      const denied = await publish(account, {
        manifest: manifest({ id: `role-cannot-publish-${index}` }),
      });
      expect(denied.status).toBe(403);
      expect(denied.data.error).toMatch(/not permitted/i);
    }

    const retiredRoute = await api(server, `/api/projects/${project.id}/pipeline-definitions`, {
      method: 'POST',
      token: owner.token,
      body: { manifest: manifest(), visibility: 'project' },
    });
    expect(retiredRoute.status).toBe(404);
  });

  it('applies out-of-band grant and revocation immediately to an existing session and keeps cookie CSRF enforcement', async () => {
    const developer = await user('developer@example.com');

    expect((await api(server, '/api/pipeline-registry/capabilities', {
      token: developer.token,
    })).data.canPublishPipelineManifests).toBe(false);

    await grantPublisher(developer);
    expect((await api(server, '/api/pipeline-registry/capabilities', {
      token: developer.token,
    })).data.canPublishPipelineManifests).toBe(true);

    const csrfDenied = await api(server, '/api/pipeline-registry/definitions', {
      method: 'POST',
      headers: { Cookie: `${COOKIE_NAME}=${encodeURIComponent(developer.token)}` },
      body: { manifest: manifest({ id: 'csrf-must-not-publish' }) },
    });
    expect(csrfDenied.status).toBe(403);

    const sameOrigin = `http://127.0.0.1:${server.address().port}`;
    const cookieCreated = await api(server, '/api/pipeline-registry/definitions', {
      method: 'POST',
      headers: {
        Cookie: `${COOKIE_NAME}=${encodeURIComponent(developer.token)}`,
        Origin: sameOrigin,
      },
      body: { manifest: manifest() },
    });
    expect(cookieCreated.status).toBe(201);

    await setPipelineRegistryPublisherByEmail(developer.user.email, false);
    expect((await api(server, '/api/pipeline-registry/capabilities', {
      token: developer.token,
    })).data.canPublishPipelineManifests).toBe(false);

    const revoked = await publish(developer, {
      manifest: manifest({ id: 'revoked-developer-view' }),
    });
    expect(revoked.status).toBe(403);
  });
});

describe.skipIf(!CONFIGURED)('trusted platform pipeline registry publication', () => {
  it('stores and returns only normalized declarative fields without execution or owner internals', async () => {
    const developer = await user('developer@example.com');
    await grantPublisher(developer);

    const created = await publish(developer, {
      manifest: manifest({
        id: 'trusted-deg-review',
        name: 'Trusted DEG Review',
        tabs: [{
          id: 'deg',
          label: 'Differential Expression',
          moduleKey: 'differentialExpression',
          parameterSchema: [
            { key: 'method', type: 'enum', label: 'Method', options: ['wilcox', 'lr'], default: 'wilcox' },
            { key: 'threshold', type: 'number', min: 0, max: 1, step: 0.05, default: 0.25 },
            { key: 'minimum-cells', type: 'integer', min: 1, max: 100, step: 1, default: 3 },
            { key: 'positive-only', type: 'boolean', default: true },
          ],
          resultArtifactTypes: ['deg_summary', 'deg_markers'],
          resultViews: [
            { type: 'summaryMetrics', title: 'Run summary' },
            { type: 'artifactTable', title: 'Marker table', artifactType: 'deg_markers' },
            'jobLogs',
          ],
        }],
      }),
    });

    expect(created.status).toBe(201);
    expect(created.data).toEqual(expect.objectContaining({
      id: expect.stringMatching(/^pipe_[0-9a-f]+$/),
      projectId: null,
      visibility: 'platform',
      manifestId: 'trusted-deg-review',
      name: 'Trusted DEG Review',
    }));
    expect(created.data).not.toHaveProperty('ownerUserId');
    expect(created.data).not.toHaveProperty('owner_user_id');
    expect(created.data).not.toHaveProperty('manifest_json');
    expect(created.data.manifest.tabs[0]).toEqual(expect.objectContaining({
      id: 'deg',
      moduleKey: 'differentialExpression',
      resultArtifactTypes: ['deg_summary', 'deg_markers'],
    }));
    for (const field of ['routeId', 'componentKey', 'jobType', 'executable', 'endpoint', 'code']) {
      expect(created.data.manifest.tabs[0]).not.toHaveProperty(field);
    }
  });

  it('serializes concurrent duplicate manifest ids and stores exactly one definition', async () => {
    const developer = await user('developer@example.com');
    await grantPublisher(developer);

    const attempts = await Promise.all([
      publish(developer, {
        manifest: manifest({ id: 'stable-manifest-id', name: 'First Candidate' }),
      }),
      publish(developer, {
        manifest: manifest({ id: 'stable-manifest-id', name: 'Second Candidate' }),
      }),
    ]);
    expect(attempts.map((attempt) => attempt.status).sort()).toEqual([201, 409]);
    expect(attempts.find((attempt) => attempt.status === 409).data.error).toMatch(/already exists/i);
    const winner = attempts.find((attempt) => attempt.status === 201);

    const stored = await query(
      'SELECT name, count(*)::int AS count FROM pipeline_definitions WHERE manifest_id = $1 GROUP BY name',
      ['stable-manifest-id']
    );
    expect(stored.rows).toEqual([{ name: winner.data.name, count: 1 }]);
  });

  it('enforces the bounded registry size under the publication lock', async () => {
    const developer = await user('developer@example.com');
    await grantPublisher(developer);
    const normalized = validatePipelineManifest(manifest({ id: 'seed-template' }));

    await query(
      `INSERT INTO pipeline_definitions
         (id, project_id, owner_user_id, visibility, manifest_id, name, manifest_json)
       SELECT
         'pipe_' || lpad(to_hex(n), 12, '0'),
         NULL,
         $1,
         'platform',
         'seed-manifest-' || n,
         'Seed Manifest ' || n,
         jsonb_set(
           jsonb_set($2::jsonb, '{id}', to_jsonb('seed-manifest-' || n)),
           '{name}', to_jsonb('Seed Manifest ' || n)
         )::text
       FROM generate_series(1, 200) AS n`,
      [developer.user.id, JSON.stringify(normalized)]
    );

    const full = await publish(developer, {
      manifest: manifest({ id: 'one-too-many' }),
    });
    expect(full.status).toBe(409);
    expect(full.data.error).toMatch(/reached its configured limit/i);
  });

  it('rejects unknown, unsafe, nested, oversized, and module-incompatible manifest declarations', async () => {
    const developer = await user('developer@example.com');
    await grantPublisher(developer);

    const qcTab = (extra = {}) => ({
      id: 'qc', label: 'Quality Control', moduleKey: 'seuratQc', ...extra,
    });
    const cases = [
      ['wrapper field', { manifest: manifest(), visibility: 'platform' }],
      ['manifest field', { manifest: manifest({ endpoint: '/api/r/deg' }) }],
      ['reserved id', { manifest: manifest({ id: DEFAULT_PIPELINE_ID }) }],
      ['tab endpoint', { manifest: manifest({ tabs: [{ id: 'inspect', label: 'Inspect', moduleKey: 'inspectObject', endpoint: '/api/r/deg' }] }) }],
      ['tab code', { manifest: manifest({ tabs: [{ id: 'inspect', label: 'Inspect', moduleKey: 'inspectObject', code: 'system("env")' }] }) }],
      ['tab job type', { manifest: manifest({ tabs: [{ id: 'inspect', label: 'Inspect', moduleKey: 'inspectObject', jobType: 'generic' }] }) }],
      ['unregistered module', { manifest: manifest({ tabs: [{ id: 'custom', label: 'Custom', moduleKey: 'uploadedR' }] }) }],
      ['route mismatch', { manifest: manifest({ tabs: [{ id: 'custom-qc', label: 'QC', moduleKey: 'seuratQc' }] }) }],
      ['module parameter mismatch', { manifest: manifest({ tabs: [{ id: 'inspect', label: 'Inspect', moduleKey: 'inspectObject', parameterSchema: [{ key: 'gene', type: 'text' }] }] }) }],
      ['nested parameter default', { manifest: manifest({ tabs: [qcTab({ parameterSchema: [{ key: 'enabled', type: 'boolean', default: { value: true } }] })] }) }],
      ['parameter count', { manifest: manifest({ tabs: [qcTab({ parameterSchema: Array.from({ length: 25 }, (_, i) => ({ key: `p${i}`, type: 'number' })) })] }) }],
      ['duplicate parameter key', { manifest: manifest({ tabs: [qcTab({ parameterSchema: [{ key: 'minimum', type: 'integer' }, { key: 'minimum', type: 'integer' }] })] }) }],
      ['numeric bounds', { manifest: manifest({ tabs: [qcTab({ parameterSchema: [{ key: 'threshold', type: 'number', min: 2, max: 1 }] })] }) }],
      ['enum option count', { manifest: manifest({ tabs: [{ id: 'normalize', label: 'Normalize', moduleKey: 'seuratNormalize', parameterSchema: [{ key: 'method', type: 'enum', options: Array.from({ length: 41 }, (_, i) => `option-${i}`) }] }] }) }],
      ['text bound', { manifest: manifest({ tabs: [qcTab({ parameterSchema: [{ key: 'notes', type: 'text', maxLength: 2001 }] })] }) }],
      ['artifact mismatch', { manifest: manifest({ tabs: [qcTab({ resultArtifactTypes: ['deg_markers'] })] }) }],
      ['view mismatch', { manifest: manifest({ tabs: [qcTab({ resultViews: ['artifactTable'] })] }) }],
      ['nested view field', { manifest: manifest({ tabs: [qcTab({ resultViews: [{ type: 'summaryMetrics', options: { raw: true } }] })] }) }],
      ['tab count', { manifest: manifest({ tabs: Array.from({ length: 41 }, () => ({ id: 'inspect', label: 'Inspect', moduleKey: 'inspectObject' })) }) }],
      ['manifest byte limit', { manifest: manifest({ description: 'x'.repeat(66_000) }) }],
    ];

    for (const [label, body] of cases) {
      const response = await publish(developer, body);
      expect(response.status, label).toBe(400);
      expect(response.data.error, label).toBeTypeOf('string');
    }

    const stored = await query('SELECT count(*)::int AS count FROM pipeline_definitions');
    expect(stored.rows[0].count).toBe(0);
  });

  it('rejects missing and parser-oversized bodies before registry mutation', async () => {
    const developer = await user('developer@example.com');
    await grantPublisher(developer);

    const missing = await api(server, '/api/pipeline-registry/definitions', {
      method: 'POST', token: developer.token,
    });
    expect(missing.status).toBe(400);

    const tooLarge = await publish(developer, {
      manifest: manifest({ description: 'x'.repeat(72_000) }),
    });
    expect(tooLarge.status).toBe(413);

    const stored = await query('SELECT count(*)::int AS count FROM pipeline_definitions');
    expect(stored.rows[0].count).toBe(0);
  });
});

describe.skipIf(!CONFIGURED)('project access to approved pipeline definitions', () => {
  it('makes approved definitions globally visible/selectable while keeping selection user-project scoped', async () => {
    const developer = await user('developer@example.com');
    const alice = await user('alice@example.com');
    const bob = await user('bob@example.com');
    const carol = await user('carol@example.com');
    await grantPublisher(developer);
    const created = await publish(developer);
    expect(created.status).toBe(201);

    const projectA = await seedProject(alice.user.id, 'Project A');
    const projectB = await seedProject(carol.user.id, 'Project B');
    await addMember(projectA.id, bob.user.email, 'viewer');

    const bobDefinitions = await api(server, `/api/projects/${projectA.id}/pipeline-definitions`, { token: bob.token });
    const carolDefinitions = await api(server, `/api/projects/${projectB.id}/pipeline-definitions`, { token: carol.token });
    expect(bobDefinitions.status).toBe(200);
    expect(carolDefinitions.status).toBe(200);
    expect(bobDefinitions.data.map((entry) => entry.id)).toEqual([DEFAULT_PIPELINE_ID, created.data.id]);
    expect(carolDefinitions.data.map((entry) => entry.id)).toEqual([DEFAULT_PIPELINE_ID, created.data.id]);

    const selected = await api(server, `/api/projects/${projectA.id}/pipeline-selection`, {
      method: 'PUT', token: bob.token, body: { pipelineId: created.data.id },
    });
    expect(selected.status).toBe(200);
    expect(selected.data.pipelineId).toBe(created.data.id);
    expect(selected.data.selectionUnavailable).toBe(false);

    const aliceSelection = await api(server, `/api/projects/${projectA.id}/pipeline-selection`, { token: alice.token });
    const carolSelection = await api(server, `/api/projects/${projectB.id}/pipeline-selection`, { token: carol.token });
    expect(aliceSelection.data.pipelineId).toBe(DEFAULT_PIPELINE_ID);
    expect(carolSelection.data.pipelineId).toBe(DEFAULT_PIPELINE_ID);
  });

  it('returns 404 for every project pipeline operation by a non-member', async () => {
    const alice = await user('alice@example.com');
    const outsider = await user('outsider@example.com');
    const project = await seedProject(alice.user.id);

    expect((await api(server, `/api/projects/${project.id}/pipeline-definitions`, {
      token: outsider.token,
    })).status).toBe(404);
    expect((await api(server, `/api/projects/${project.id}/pipeline-selection`, {
      token: outsider.token,
    })).status).toBe(404);
    expect((await api(server, `/api/projects/${project.id}/pipeline-selection`, {
      method: 'PUT', token: outsider.token, body: { pipelineId: DEFAULT_PIPELINE_ID },
    })).status).toBe(404);
  });

  it('quarantines legacy project definitions, falls stale selections back, and preserves stored history', async () => {
    const alice = await user('alice@example.com');
    const project = await seedProject(alice.user.id);
    const legacyId = 'pipe_a1b2c3d4';
    const legacyManifest = validatePipelineManifest(manifest({ id: 'legacy-project-view' }));
    await query(
      `INSERT INTO pipeline_definitions
         (id, project_id, owner_user_id, visibility, name, manifest_json)
       VALUES ($1, $2, $3, 'project', $4, $5)`,
      [legacyId, project.id, alice.user.id, legacyManifest.name, JSON.stringify(legacyManifest)]
    );
    await query(
      'INSERT INTO project_pipeline_selections (project_id, user_id, pipeline_id) VALUES ($1, $2, $3)',
      [project.id, alice.user.id, legacyId]
    );

    const definitions = await api(server, `/api/projects/${project.id}/pipeline-definitions`, { token: alice.token });
    expect(definitions.status).toBe(200);
    expect(definitions.data.map((entry) => entry.id)).toEqual([DEFAULT_PIPELINE_ID]);

    const selection = await api(server, `/api/projects/${project.id}/pipeline-selection`, { token: alice.token });
    expect(selection.status).toBe(200);
    expect(selection.data.pipelineId).toBe(DEFAULT_PIPELINE_ID);
    expect(selection.data.selectionUnavailable).toBe(true);

    const cannotReselect = await api(server, `/api/projects/${project.id}/pipeline-selection`, {
      method: 'PUT', token: alice.token, body: { pipelineId: legacyId },
    });
    expect(cannotReselect.status).toBe(404);

    const retained = await query('SELECT project_id, visibility FROM pipeline_definitions WHERE id = $1', [legacyId]);
    expect(retained.rows).toEqual([{ project_id: project.id, visibility: 'project' }]);
  });

  it('revalidates stored platform rows and omits corrupt definitions from lists and selections', async () => {
    const developer = await user('developer@example.com');
    const alice = await user('alice@example.com');
    const project = await seedProject(alice.user.id);
    const malformedId = 'pipe_bad00001';
    const invalidId = 'pipe_bad00002';
    const invalidRowId = 'invalid-platform-row-id';
    const validManifestWithInvalidRowId = validatePipelineManifest(manifest({
      id: 'invalid-row-id-view',
      name: 'Invalid Row ID View',
    }));

    await query(
      `INSERT INTO pipeline_definitions
         (id, project_id, owner_user_id, visibility, manifest_id, name, manifest_json)
       VALUES
         ($1, NULL, $3, 'platform', 'malformed-platform-view', 'Malformed Platform View', '{not-json'),
         ($2, NULL, $3, 'platform', 'invalid-platform-view', 'Invalid Platform View', $4),
         ($5, NULL, $3, 'platform', $6, $7, $8)`,
      [
        malformedId,
        invalidId,
        developer.user.id,
        JSON.stringify(manifest({
          id: 'invalid-platform-view',
          name: 'Invalid Platform View',
          tabs: [{ id: 'inspect', label: 'Inspect', moduleKey: 'inspectObject', endpoint: '/api/r/deg' }],
        })),
        invalidRowId,
        validManifestWithInvalidRowId.id,
        validManifestWithInvalidRowId.name,
        JSON.stringify(validManifestWithInvalidRowId),
      ]
    );
    await query(
      'INSERT INTO project_pipeline_selections (project_id, user_id, pipeline_id) VALUES ($1, $2, $3)',
      [project.id, alice.user.id, invalidId]
    );

    const definitions = await api(server, `/api/projects/${project.id}/pipeline-definitions`, { token: alice.token });
    expect(definitions.status).toBe(200);
    expect(definitions.data.map((entry) => entry.id)).toEqual([DEFAULT_PIPELINE_ID]);

    const selection = await api(server, `/api/projects/${project.id}/pipeline-selection`, { token: alice.token });
    expect(selection.data.pipelineId).toBe(DEFAULT_PIPELINE_ID);
    expect(selection.data.selectionUnavailable).toBe(true);

    for (const pipelineId of [malformedId, invalidId, invalidRowId]) {
      const directSelection = await api(server, `/api/projects/${project.id}/pipeline-selection`, {
        method: 'PUT', token: alice.token, body: { pipelineId },
      });
      expect(directSelection.status).toBe(404);
    }
  });
});
