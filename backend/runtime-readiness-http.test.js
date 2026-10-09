import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
const config = require('./config');
const db = require('./pgDatabase');
const { startServer, createUserWithToken, api } = require('./_http-test-utils');
const { environmentFixture } = require('./_r-environment-test-utils');
const { EXPERT_R_RESOURCE_POLICY_VERSION } = require('./expertR');
const { brokerResourceLimits } = require('./expertRuntimeReadiness');
const configured = config.hasPostgresConnection();
const names = ['APP_DEPLOYMENT_MODE', 'EXPERT_R_ENABLED', 'EXPERT_R_SANDBOX_URL', 'EXPERT_R_SANDBOX_TOKEN', 'EXPERT_R_ACCESS_POLICY'];
const original = Object.fromEntries(names.map(name => [name, process.env[name]]));
let server, broker;
beforeAll(async () => {
  if (!configured) return;
  const { reference } = environmentFixture();
  broker = http.createServer((req, res) => {
    if (req.url !== '/readiness' || req.headers.authorization !== `Bearer ${'a'.repeat(64)}`) {
      res.statusCode = 401; res.end('{}'); return;
    }
    res.end(JSON.stringify({ status: 'ok', profileId: reference.profileId, sandboxImageDigest: reference.imageDigest,
      environment: reference, resourcePolicyVersion: EXPERT_R_RESOURCE_POLICY_VERSION, persistentKernel: true,
      persistentKernelInterrupt: true, persistentKernelPublications: true,
      readiness: { state: 'ready', checkedAt: new Date().toISOString(),
        resources: brokerResourceLimits({}, { timeoutMs: 600000, maxConcurrent: 2, persistentKernel: true }),
        storage: { work: { state: 'ready', writable: true, freeBytes: 2 ** 32, minFreeBytes: 2 ** 30, reservedBytes: 0 } } } }));
  });
  await new Promise(resolve => broker.listen(0, '127.0.0.1', resolve));
  Object.assign(process.env, { APP_DEPLOYMENT_MODE: 'private', EXPERT_R_ENABLED: 'true',
    EXPERT_R_SANDBOX_URL: `http://127.0.0.1:${broker.address().port}`, EXPERT_R_SANDBOX_TOKEN: 'a'.repeat(64),
    EXPERT_R_ACCESS_POLICY: 'project-roles' });
  server = await startServer();
});
beforeEach(async () => { if (configured) await db.resetSchemaForTests(); });
afterAll(async () => {
  for (const name of names) if (original[name] === undefined) delete process.env[name]; else process.env[name] = original[name];
  if (server) await new Promise(resolve => server.close(resolve));
  if (broker) await new Promise(resolve => broker.close(resolve));
  if (configured) await db.close();
});
async function ownerProject(email) {
  const owner = await createUserWithToken({ email });
  const organization = await db.createOrganizationForUser(owner.user.id, { name: 'Readiness lab' });
  const project = await db.createProjectForUser(owner.user.id, { organizationId: organization.id, name: 'Readiness project' });
  return { ...owner, project };
}
describe.skipIf(!configured)('authenticated server readiness HTTP', () => {
  it('publishes only protocol metadata before login and protects all readiness observations', async () => {
    const publicResult = await api(server, '/api/service/compatibility');
    expect(publicResult.status).toBe(200);
    expect(publicResult.data).toEqual({ product: 'TraceOmics', serviceApiVersion: 1, minimumClientApiVersion: 1 });
    expect(publicResult.res.headers.get('cache-control')).toBe('no-store');
    expect((await api(server, '/api/runtime/readiness')).status).toBe(401);
  });
  it('checks project membership and execution role freshly despite cached shared probes', async () => {
    const owner = await ownerProject('readiness-owner@example.com');
    const analyst = await createUserWithToken({ email: 'readiness-analyst@example.com' });
    const outsider = await createUserWithToken({ email: 'readiness-outsider@example.com' });
    await db.addProjectMemberByEmail(owner.project.id, analyst.user.email, 'analyst', { userId: owner.user.id });
    const endpoint = `/api/runtime/readiness?projectId=${owner.project.id}`;
    const initial = await api(server, endpoint, { token: analyst.token });
    expect(initial.status).toBe(200);
    expect(initial.data).toMatchObject({ schema: 'traceomics.runtime-readiness.v1',
      privateR: { state: 'ready', accessState: 'allowed', environment: environmentFixture().reference } });
    expect(initial.res.headers.get('cache-control')).toBe('no-store');
    await db.updateProjectMemberRole(owner.project.id, analyst.user.id, 'viewer', { userId: owner.user.id });
    const viewer = await api(server, endpoint, { token: analyst.token });
    expect(viewer.data).toMatchObject({ privateR: { accessState: 'access-required', environment: null,
      resources: { oneShot: null, kernel: null }, storage: { work: { freeBytes: null } } } });
    expect(viewer.data.checkedAt).toBe(initial.data.checkedAt);
    expect((await api(server, endpoint, { token: outsider.token })).status).toBe(404);
    await db.removeProjectMember(owner.project.id, analyst.user.id, { userId: owner.user.id });
    expect((await api(server, endpoint, { token: analyst.token })).status).toBe(404);
  });
  it('applies an audited account denial immediately and rejects malformed project selectors', async () => {
    const owner = await ownerProject('readiness-revoked@example.com');
    const endpoint = `/api/runtime/readiness?projectId=${owner.project.id}`;
    expect((await api(server, endpoint, { token: owner.token })).data.privateR.accessState).toBe('allowed');
    await db.setExpertRExecutorByEmail(owner.user.email, false);
    const revoked = await api(server, endpoint, { token: owner.token });
    expect(revoked.data.privateR).toMatchObject({ accessState: 'access-revoked', environment: null });
    expect(JSON.stringify(revoked.data)).not.toContain(environmentFixture().reference.id);
    expect((await api(server, '/api/runtime/readiness?projectId=../secret', { token: owner.token })).status).toBe(400);
    expect((await api(server, '/api/runtime/readiness?projectId=proj_one&projectId=proj_two', { token: owner.token })).status).toBe(400);
  });
});
