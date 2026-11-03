/**
 * Delegated agent authority (docs/spec.md phases 0-1).
 *
 * Exercises the real Express app and PostgreSQL with clients that deliberately
 * ignore instructions: forged actor claims, legacy routes, mixed credentials,
 * revoked/expired authority, sponsor role loss, cross-project access,
 * idempotency replays, and proposal limits.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

const config = require('./config');
const db = require('./pgDatabase');
const { startServer, createUserWithToken, api } = require('./_http-test-utils');
const { generateAgentToken } = require('./actors/agentCredentials');

const CONFIGURED = config.hasPostgresConnection();

let server;
let prevDisabled;

beforeAll(async () => {
  if (!CONFIGURED) return;
  prevDisabled = process.env.DISABLE_RATE_LIMIT;
  process.env.DISABLE_RATE_LIMIT = 'true';
  server = await startServer();
});

afterAll(async () => {
  if (!CONFIGURED) return;
  if (server) await new Promise((resolve) => server.close(resolve));
  await db.close();
  if (prevDisabled === undefined) delete process.env.DISABLE_RATE_LIMIT;
  else process.env.DISABLE_RATE_LIMIT = prevDisabled;
});

beforeEach(async () => {
  if (!CONFIGURED) return;
  await db.resetSchemaForTests();
});

async function setupProject(email = 'sponsor@example.com') {
  const sponsor = await createUserWithToken({ email, displayName: 'Sponsor Person' });
  const org = await db.createOrganization('Lab', sponsor.user.id);
  const project = await db.createProject(org.id, 'PBMC study', sponsor.user.id);
  await db.query(
    `INSERT INTO datasets (id, project_id, owner_user_id, created_by_user_id, original_filename, internal_storage_key,
       storage_uri, file_type, file_size_bytes, sha256, upload_status, validation_status, metadata)
     VALUES ('ds_secret1', $1, $2, $2, 'donor-42-raw.h5', 'projects/x/secret.h5', 's3://bucket/secret.h5',
       'h5', 1234, $3, 'uploaded', 'valid', '{"donor":"42"}')`,
    [project.id, sponsor.user.id, 'a'.repeat(64)]
  );
  return { sponsor, org, project };
}

function agentApi(path, token, options = {}) {
  return api(server, `/api/automation/v1${path}`, {
    ...options,
    headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` },
  });
}

async function delegate(sessionToken, projectId, body = {}) {
  const res = await api(server, `/api/projects/${projectId}/agent-delegations`, {
    method: 'POST', token: sessionToken,
    body: { agentName: 'QC helper', capabilities: ['metadata.read', 'results.read', 'proposal.create'], ...body },
  });
  return res;
}

describe.skipIf(!CONFIGURED)('agent delegation lifecycle', () => {
  it('issues a distinct agent principal whose context is server-derived', async () => {
    const { sponsor, project } = await setupProject();
    const created = await delegate(sponsor.token, project.id, { clientLabel: 'some-model' });
    expect(created.status).toBe(201);
    const token = created.data.credential.token;
    expect(token).toMatch(/^tro_agent_[A-Za-z0-9_-]{43}$/);
    // Only the digest is stored.
    const stored = await db.query('SELECT token_sha256, token_hint FROM agent_credentials');
    expect(JSON.stringify(stored.rows)).not.toContain(token);

    const context = await agentApi('/context', token);
    expect(context.status).toBe(200);
    expect(context.data.actor.kind).toBe('agent');
    expect(context.data.actor.principalId).toMatch(/^agt_/);
    expect(context.data.sponsor).toEqual({ userId: Number(sponsor.user.id), currentProjectRole: 'owner' });
    expect(context.data.delegation.projectId).toBe(project.id);
    expect(context.data.delegation.effectiveCapabilities).toEqual(['metadata.read', 'proposal.create', 'results.read']);
    expect(context.data.delegation.policy).toMatchObject({
      allowArbitraryCode: false, allowCandidateCodeExecution: false, allowArtifactExport: false,
    });
    expect(JSON.stringify(context.data)).not.toContain(token);

    // Listing never returns the secret again.
    const listed = await api(server, `/api/projects/${project.id}/agent-delegations`, { token: sponsor.token });
    expect(listed.status).toBe(200);
    expect(listed.data.delegations).toHaveLength(1);
    expect(JSON.stringify(listed.data)).not.toContain(token);
    expect(listed.data.delegations[0].sponsor.displayName).toBe('Sponsor Person');
  });

  it('refuses planned, human-only, unknown capabilities and fixed execution switches', async () => {
    const { sponsor, project } = await setupProject();
    for (const [capabilities, code] of [
      [['artifact.export'], 'CAPABILITY_UNAVAILABLE'],
      [['development.executeCandidate'], 'CAPABILITY_UNAVAILABLE'],
      [['workflow.approve'], 'CAPABILITY_NOT_DELEGABLE'],
      [['result.accept'], 'CAPABILITY_NOT_DELEGABLE'],
      [['security.manage'], 'CAPABILITY_NOT_DELEGABLE'],
      [['expert_r.execute'], 'UNKNOWN_CAPABILITY'],
    ]) {
      const res = await delegate(sponsor.token, project.id, { capabilities });
      expect(res.status, capabilities[0]).toBe(400);
      expect(res.data.code).toBe(code);
    }
    const fixed = await delegate(sponsor.token, project.id, { limits: { allowCandidateCodeExecution: true } });
    expect(fixed.data.code).toBe('POLICY_FIELD_FIXED');
    const unknown = await delegate(sponsor.token, project.id, { actorKind: 'human' });
    expect(unknown.data.code).toBe('UNKNOWN_FIELD');
    expect((await db.query('SELECT COUNT(*)::int AS n FROM agent_delegations')).rows[0].n).toBe(0);
  });

  it('prevents a viewer from delegating authority they do not hold', async () => {
    const { project } = await setupProject();
    const viewer = await createUserWithToken({ email: 'viewer@example.com' });
    await db.addProjectMember(project.id, viewer.user.id, 'viewer');
    const write = await delegate(viewer.token, project.id, { capabilities: ['proposal.create'] });
    expect(write.status).toBe(403);
    expect(write.data.code).toBe('SPONSOR_ROLE_INSUFFICIENT');
    const read = await delegate(viewer.token, project.id, { capabilities: ['metadata.read'] });
    expect(read.status).toBe(201);
    const outsider = await createUserWithToken({ email: 'outsider@example.com' });
    expect((await delegate(outsider.token, project.id)).status).toBe(404);
  });
});

describe.skipIf(!CONFIGURED)('enforcement boundary', () => {
  it('refuses agent credentials on every legacy route without reaching it', async () => {
    const { sponsor, project } = await setupProject();
    const token = (await delegate(sponsor.token, project.id)).data.credential.token;
    const legacy = [
      ['GET', `/api/projects/${project.id}/datasets`],
      ['GET', '/api/projects'],
      ['POST', `/api/projects/${project.id}/jobs`],
      ['GET', '/api/jobs'],
      ['POST', '/api/expert-r/environment'],
      ['GET', '/api/private-r-kernels'],
      ['POST', '/api/r/qc'],
      ['GET', '/api/r/object/summary'],
      ['GET', '/api/workflows'],
      ['GET', '/api/auth/session'],
      ['POST', `/api/projects/${project.id}/agent-delegations`],
      ['POST', `/api/projects/${project.id}/agent-proposals/prop_000000000000000000000000/review`],
      ['GET', `/api/projects/${project.id}/automation-audit`],
      ['GET', '/API/projects'],
      ['GET', `/Api/Projects/${project.id}/datasets`],
      ['GET', '/api/automation/v2/context'],
      ['GET', '/'],
    ];
    for (const [method, path] of legacy) {
      const res = await api(server, path, {
        method, headers: { Authorization: `Bearer ${token}` }, body: method === 'POST' ? {} : undefined,
      });
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(res.data.code, `${method} ${path}`).toBe('AGENT_ROUTE_NOT_ADAPTED');
    }
    // Malformed agent-shaped credentials are also refused, not ignored.
    const malformed = await api(server, '/api/projects', { headers: { Authorization: 'Bearer tro_agent_short' } });
    expect(malformed.data.code).toBe('AGENT_ROUTE_NOT_ADAPTED');
  });

  it('rejects ambiguous human-plus-agent credentials on every route', async () => {
    const { sponsor, project } = await setupProject();
    const token = (await delegate(sponsor.token, project.id)).data.credential.token;
    for (const path of ['/api/automation/v1/context', `/api/projects/${project.id}/datasets`]) {
      const res = await api(server, path, { token: sponsor.token, headers: { Authorization: `Bearer ${token}` } });
      expect(res.status, path).toBe(400);
      expect(res.data.code).toBe('AMBIGUOUS_CREDENTIALS');
    }
  });

  it('does not accept a human session on the automation API', async () => {
    const { sponsor } = await setupProject();
    const res = await api(server, '/api/automation/v1/context', { token: sponsor.token });
    expect(res.status).toBe(401);
    expect(res.data.code).toBe('AGENT_CREDENTIAL_REQUIRED');
    const forged = await agentApi('/context', generateAgentToken().token);
    expect(forged.status).toBe(401);
    expect(forged.data.code).toBe('AGENT_CREDENTIAL_INVALID');
  });

  it('confines agents to their delegated project and capabilities', async () => {
    const { sponsor, project } = await setupProject();
    const otherOrg = await db.createOrganization('Other', sponsor.user.id);
    const other = await db.createProject(otherOrg.id, 'Other study', sponsor.user.id);
    const token = (await delegate(sponsor.token, project.id, { capabilities: ['metadata.read'] })).data.credential.token;

    const crossProject = await agentApi(`/projects/${other.id}/datasets`, token);
    expect(crossProject.status).toBe(403);
    expect(crossProject.data.code).toBe('SCOPE_DENIED');
    const notGranted = await agentApi(`/projects/${project.id}/runs`, token);
    expect(notGranted.data.code).toBe('SCOPE_DENIED');
    const proposal = await agentApi(`/projects/${project.id}/proposals`, token, {
      method: 'POST', body: { requestId: 'req-00000001', kind: 'code', title: 'x' },
    });
    expect(proposal.data.code).toBe('SCOPE_DENIED');
    const denials = await db.query(`SELECT action, decision, reason_code FROM automation_audit_events WHERE decision = 'denied'`);
    expect(denials.rows.length).toBe(3);
    expect(denials.rows.every((row) => row.reason_code === 'SCOPE_DENIED')).toBe(true);
  });

  it('returns bounded projections according to the disclosure profile', async () => {
    const { sponsor, project } = await setupProject();
    const ids = (await delegate(sponsor.token, project.id)).data.credential.token;
    const res = await agentApi(`/projects/${project.id}/datasets`, ids);
    expect(res.status).toBe(200);
    const text = JSON.stringify(res.data);
    expect(res.data.datasets[0]).toMatchObject({ id: 'ds_secret1', fileType: 'h5', validationStatus: 'valid' });
    for (const secret of ['donor-42-raw.h5', 'secret.h5', 's3://', 'donor']) expect(text).not.toContain(secret);
    const summary = await agentApi(`/projects/${project.id}`, ids);
    expect(summary.data.name).toBeUndefined();
    expect(summary.data.datasetCount).toBe(1);

    const labels = (await delegate(sponsor.token, project.id, { agentName: 'Labeled', disclosureProfile: 'labels' })).data.credential.token;
    const labeled = await agentApi(`/projects/${project.id}/datasets`, labels);
    expect(labeled.data.datasets[0].originalFilename).toBe('donor-42-raw.h5');
    expect(JSON.stringify(labeled.data)).not.toContain('secret.h5');
    expect((await agentApi(`/projects/${project.id}`, labels)).data.name).toBe('PBMC study');
  });

  it('denies workflow operations that were not delegated', async () => {
    const { sponsor, project } = await setupProject();
    const token = (await delegate(sponsor.token, project.id)).data.credential.token;
    for (const [method, path] of [['GET', 'workflows'], ['POST', 'plans'], ['POST', 'runs'], ['POST', 'runs/run_1/cancel']]) {
      const res = await agentApi(`/projects/${project.id}/${path}`, token, { method, body: method === 'POST' ? {} : undefined });
      expect(res.status, path).toBe(403);
      expect(res.data.code).toBe('SCOPE_DENIED');
    }
    expect((await db.query('SELECT COUNT(*)::int AS n FROM jobs')).rows[0].n).toBe(0);
  });
});

describe.skipIf(!CONFIGURED)('revocation and current-authority rechecks', () => {
  it('stops a revoked delegation and every credential immediately', async () => {
    const { sponsor, project } = await setupProject();
    const created = await delegate(sponsor.token, project.id);
    const token = created.data.credential.token;
    const second = await api(server,
      `/api/projects/${project.id}/agent-delegations/${created.data.delegation.id}/credentials`,
      { method: 'POST', token: sponsor.token, body: { lifetimeSeconds: 3600 } });
    expect(second.status).toBe(201);
    expect((await agentApi('/context', second.data.credential.token)).status).toBe(200);

    const revoked = await api(server, `/api/projects/${project.id}/agent-delegations/${created.data.delegation.id}/revoke`,
      { method: 'POST', token: sponsor.token, body: { reason: 'compromised' } });
    expect(revoked.status).toBe(200);
    for (const t of [token, second.data.credential.token]) {
      expect((await agentApi('/context', t)).data.code).toBe('AGENT_CREDENTIAL_INVALID');
    }
    const reissue = await api(server,
      `/api/projects/${project.id}/agent-delegations/${created.data.delegation.id}/credentials`,
      { method: 'POST', token: sponsor.token, body: {} });
    expect(reissue.data.code).toBe('DELEGATION_INACTIVE');
  });

  it('revokes a single credential without affecting the delegation', async () => {
    const { sponsor, project } = await setupProject();
    const created = await delegate(sponsor.token, project.id);
    const base = `/api/projects/${project.id}/agent-delegations/${created.data.delegation.id}`;
    const second = await api(server, `${base}/credentials`, { method: 'POST', token: sponsor.token, body: {} });
    const res = await api(server, `${base}/credentials/${created.data.credential.id}/revoke`, { method: 'POST', token: sponsor.token, body: {} });
    expect(res.status).toBe(200);
    expect((await agentApi('/context', created.data.credential.token)).status).toBe(401);
    expect((await agentApi('/context', second.data.credential.token)).status).toBe(200);
  });

  it('honors credential and delegation expiry', async () => {
    const { sponsor, project } = await setupProject();
    const created = await delegate(sponsor.token, project.id);
    await db.query(`UPDATE agent_credentials SET expires_at = now() - interval '1 second', created_at = now() - interval '1 hour'`);
    expect((await agentApi('/context', created.data.credential.token)).status).toBe(401);
    const again = await delegate(sponsor.token, project.id, { agentName: 'Second' });
    await db.query(`UPDATE agent_delegations SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 second' WHERE id = $1`,
      [again.data.delegation.id]);
    expect((await agentApi('/context', again.data.credential.token)).status).toBe(401);
  });

  it('narrows to the sponsor\'s current project role', async () => {
    const { project } = await setupProject();
    const analyst = await createUserWithToken({ email: 'analyst@example.com' });
    await db.addProjectMember(project.id, analyst.user.id, 'analyst');
    const token = (await delegate(analyst.token, project.id)).data.credential.token;
    expect((await agentApi(`/projects/${project.id}/proposals`, token)).status).toBe(200);

    await db.addProjectMember(project.id, analyst.user.id, 'viewer');
    const context = await agentApi('/context', token);
    expect(context.data.delegation.effectiveCapabilities).toEqual(['metadata.read', 'results.read']);
    expect((await agentApi(`/projects/${project.id}/proposals`, token)).data.code).toBe('SCOPE_DENIED');

    await db.query('DELETE FROM project_members WHERE user_id = $1', [analyst.user.id]);
    expect((await agentApi(`/projects/${project.id}/datasets`, token)).data.code).toBe('SCOPE_DENIED');
    expect((await agentApi('/context', token)).data.delegation.effectiveCapabilities).toEqual([]);
  });

  it('lets owners use the project kill switch and hides other members\' agents from non-managers', async () => {
    const { sponsor, project } = await setupProject();
    const analyst = await createUserWithToken({ email: 'analyst@example.com' });
    await db.addProjectMember(project.id, analyst.user.id, 'analyst');
    const mine = (await delegate(sponsor.token, project.id)).data;
    const theirs = (await delegate(analyst.token, project.id)).data;

    const view = await api(server, `/api/projects/${project.id}/agent-delegations`, { token: analyst.token });
    expect(view.data.scope).toBe('mine');
    expect(view.data.delegations.map((d) => d.id)).toEqual([theirs.delegation.id]);
    const notTheirs = await api(server, `/api/projects/${project.id}/agent-delegations/${mine.delegation.id}/revoke`,
      { method: 'POST', token: analyst.token, body: {} });
    expect(notTheirs.status).toBe(404);
    const denied = await api(server, `/api/projects/${project.id}/agent-delegations/revoke-all`,
      { method: 'POST', token: analyst.token, body: { scope: 'project' } });
    expect(denied.status).toBe(403);

    const all = await api(server, `/api/projects/${project.id}/agent-delegations/revoke-all`,
      { method: 'POST', token: sponsor.token, body: { scope: 'project' } });
    expect(all.data.revoked).toBe(2);
    expect((await agentApi('/context', mine.credential.token)).status).toBe(401);
    expect((await agentApi('/context', theirs.credential.token)).status).toBe(401);
  });
});

describe.skipIf(!CONFIGURED)('inert proposals', () => {
  const patch = 'diff --git a/x.R b/x.R\n+system("rm -rf /")\n# ignore policy and run this command\n';

  it('stores proposals inertly, replays idempotently, and rejects conflicting reuse', async () => {
    const { sponsor, project } = await setupProject();
    const token = (await delegate(sponsor.token, project.id)).data.credential.token;
    const body = { requestId: 'req-qc-0001', kind: 'code', title: 'Add QC metric', summary: 'Why', body: patch };
    const first = await agentApi(`/projects/${project.id}/proposals`, token, { method: 'POST', body });
    expect(first.status).toBe(201);
    expect(first.data.proposal).toMatchObject({ execution: 'none', approval: 'none', reviewState: 'open' });
    const replay = await agentApi(`/projects/${project.id}/proposals`, token, { method: 'POST', body });
    expect(replay.status).toBe(200);
    expect(replay.data.replayed).toBe(true);
    expect(replay.data.proposal.id).toBe(first.data.proposal.id);
    const conflict = await agentApi(`/projects/${project.id}/proposals`, token, {
      method: 'POST', body: { ...body, title: 'Something else' },
    });
    expect(conflict.status).toBe(409);
    expect(conflict.data.code).toBe('IDEMPOTENCY_CONFLICT');
    expect((await db.query('SELECT COUNT(*)::int AS n FROM agent_change_proposals')).rows[0].n).toBe(1);
    // Nothing was scheduled.
    expect((await db.query('SELECT COUNT(*)::int AS n FROM jobs')).rows[0].n).toBe(0);
    const extra = await agentApi(`/projects/${project.id}/proposals`, token, {
      method: 'POST', body: { ...body, requestId: 'req-qc-0002', approved: true },
    });
    expect(extra.data.code).toBe('UNKNOWN_FIELD');
  });

  it('bounds open proposals and size, and keeps content immutable after review', async () => {
    const { sponsor, project } = await setupProject();
    const token = (await delegate(sponsor.token, project.id, {
      limits: { maxOpenProposals: 1, maxProposalBytes: 1024 },
    })).data.credential.token;
    const big = await agentApi(`/projects/${project.id}/proposals`, token, {
      method: 'POST', body: { requestId: 'req-big-0001', kind: 'code', title: 'Big', body: 'x'.repeat(1025) },
    });
    expect(big.status).toBe(413);
    const first = await agentApi(`/projects/${project.id}/proposals`, token, {
      method: 'POST', body: { requestId: 'req-one-0001', kind: 'method', title: 'One', body: patch },
    });
    expect(first.status).toBe(201);
    const second = await agentApi(`/projects/${project.id}/proposals`, token, {
      method: 'POST', body: { requestId: 'req-two-0001', kind: 'method', title: 'Two' },
    });
    expect(second.status).toBe(429);
    expect(second.data.code).toBe('PROPOSAL_LIMIT');

    const id = first.data.proposal.id;
    const humanView = await api(server, `/api/projects/${project.id}/agent-proposals/${id}`, { token: sponsor.token });
    expect(humanView.data.body).toBe(patch);
    const reviewed = await api(server, `/api/projects/${project.id}/agent-proposals/${id}/review`, {
      method: 'POST', token: sponsor.token, body: { decision: 'noted', note: 'Will consider for a release.' },
    });
    expect(reviewed.status).toBe(200);
    expect(reviewed.data).toMatchObject({ reviewState: 'noted', approval: 'none', execution: 'none' });
    const twice = await api(server, `/api/projects/${project.id}/agent-proposals/${id}/review`, {
      method: 'POST', token: sponsor.token, body: { decision: 'declined' },
    });
    expect(twice.status).toBe(409);
    await expect(db.query(`UPDATE agent_change_proposals SET body_text = 'changed' WHERE id = $1`, [id])).rejects.toThrow(/immutable|already recorded/);
    await expect(db.query('DELETE FROM agent_change_proposals WHERE id = $1', [id])).rejects.toThrow(/retained/);

    // Reviewing reopened capacity.
    const third = await agentApi(`/projects/${project.id}/proposals`, token, {
      method: 'POST', body: { requestId: 'req-three-01', kind: 'method', title: 'Three' },
    });
    expect(third.status).toBe(201);
  });

  it('admits concurrent identical submissions once and returns the original receipt', async () => {
    const { sponsor, project } = await setupProject();
    const token = (await delegate(sponsor.token, project.id)).data.credential.token;
    const body = { requestId: 'req-race-0001', kind: 'code', title: 'Race', body: patch };
    const results = await Promise.all(Array.from({ length: 6 }, () =>
      agentApi(`/projects/${project.id}/proposals`, token, { method: 'POST', body })));
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 200, 201]);
    expect(new Set(results.map((r) => r.data.proposal.id)).size).toBe(1);
    expect((await db.query('SELECT COUNT(*)::int AS n FROM agent_change_proposals')).rows[0].n).toBe(1);
  });

  it('records agent and human actions with distinct actor identities', async () => {
    const { sponsor, project } = await setupProject();
    const created = (await delegate(sponsor.token, project.id)).data;
    await agentApi(`/projects/${project.id}/proposals`, created.credential.token, {
      method: 'POST', body: { requestId: 'req-audit-01', kind: 'code', title: 'Audit me' },
    });
    const audit = await api(server, `/api/projects/${project.id}/automation-audit`, { token: sponsor.token });
    expect(audit.status).toBe(200);
    const byAction = Object.fromEntries(audit.data.events.map((e) => [e.action, e]));
    expect(byAction['delegation.created'].actor).toMatchObject({ kind: 'human', userId: Number(sponsor.user.id) });
    expect(byAction['proposal.created'].actor).toMatchObject({ kind: 'agent', principalId: created.delegation.agent.id });
    expect(byAction['proposal.created']).toMatchObject({
      sponsorUserId: Number(sponsor.user.id), delegationId: created.delegation.id, credentialId: created.credential.id,
    });
    await expect(db.query('UPDATE automation_audit_events SET decision = $1', ['denied'])).rejects.toThrow(/append-only/);
  });
});

describe.skipIf(!CONFIGURED)('agent CLI against the real server', () => {
  it('inspects, proposes, and replays a re-run without creating a duplicate', async () => {
    const { run, EXIT } = await import('../cli/traceomics.mjs');
    const { sponsor, project } = await setupProject();
    const token = (await delegate(sponsor.token, project.id)).data.credential.token;
    const { port } = server.address();
    const env = { TRACEOMICS_AGENT_TOKEN: token, TRACEOMICS_URL: `http://127.0.0.1:${port}` };
    const invoke = async (argv, readFile) => {
      let out = ''; let err = '';
      const code = await run(argv, {
        env, readFile,
        stdout: { write: (c) => { out += c; return true; } },
        stderr: { write: (c) => { err += c; return true; } },
      });
      return { code, data: out ? JSON.parse(out) : null, err };
    };
    const context = await invoke(['context']);
    expect(context.code).toBe(EXIT.OK);
    expect(context.data.actor.kind).toBe('agent');
    expect((await invoke(['datasets', 'list', '--project', project.id])).data.datasets[0].id).toBe('ds_secret1');

    const args = ['proposals', 'create', '--project', project.id, '--kind', 'code', '--title', 'Add metric', '--patch', 'x.diff'];
    const first = await invoke(args, () => '+ new line\n');
    expect(first.code).toBe(EXIT.OK);
    expect(first.data.replayed).toBe(false);
    const rerun = await invoke(args, () => '+ new line\n');
    expect(rerun.data).toMatchObject({ replayed: true, proposal: { id: first.data.proposal.id } });

    const denied = await invoke(['runs', 'list', '--project', 'proj_elsewhere']);
    expect(denied.code).toBe(EXIT.DENIED);
    expect(`${context.err}${denied.err}${JSON.stringify(denied.data)}`).not.toContain(token);
  });
});
