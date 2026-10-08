import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';

const { EXPERT_R_PROFILE, EXPERT_R_RESOURCE_POLICY_VERSION, expertRSandboxEnabled } = require('./expertR');
const { expertRAccessPolicy, expertRAccessSql, probeExpertRRuntime, expertRStatus } = require('./expertRAccess');
const { assertExpertRuntimeImage } = require('./expertSandboxBroker');
const servers = [];
afterEach(async () => {
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
async function runtimeServer(handler) {
  const server = http.createServer(handler); servers.push(server);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { APP_DEPLOYMENT_MODE: 'private', EXPERT_R_ENABLED: 'true',
    EXPERT_R_SANDBOX_URL: `http://127.0.0.1:${server.address().port}`, EXPERT_R_SANDBOX_TOKEN: 'a'.repeat(64) };
}
describe('private R access policy and runtime readiness', () => {
  it('refuses a missing image or unsupported package profile before advertising runtime readiness', async () => {
    const env = { EXPERT_R_SANDBOX_IMAGE: `sha256:${'a'.repeat(64)}` };
    await expect(assertExpertRuntimeImage(env, async () => ({ stdout: 'unavailable' }))).rejects.toThrow(/unavailable/);
    await expect(assertExpertRuntimeImage(env, async (_command, args) => ({
      stdout: args.includes('inspect') ? `sha256:${'b'.repeat(64)}` : 'unsupported-profile',
    }))).rejects.toThrow(/supported package profile/);
    const calls = [];
    await expect(assertExpertRuntimeImage(env, async (_command, args) => {
      calls.push(args);
      return { stdout: args.includes('inspect') ? `sha256:${'b'.repeat(64)}` : 'private-r-profile-ok' };
    })).resolves.toBe(true);
    expect(calls[1]).toEqual(expect.arrayContaining(['none', '--read-only', '10001:10001']));
  });
  it('keeps existing explicit-account setup and rejects unknown policies', () => {
    expect(expertRAccessPolicy({})).toBe('approved-accounts');
    expect(expertRAccessPolicy({ EXPERT_R_ACCESS_POLICY: 'project-roles' })).toBe('project-roles');
    expect(expertRAccessPolicy({ EXPERT_R_ACCESS_POLICY: 'all-users' })).toBe('disabled');
    expect(expertRSandboxEnabled({ APP_DEPLOYMENT_MODE: 'private', EXPERT_R_ENABLED: 'true',
      EXPERT_R_SANDBOX_URL: 'http://127.0.0.1:8090', EXPERT_R_SANDBOX_TOKEN: 'a'.repeat(64), EXPERT_R_ACCESS_POLICY: 'all-users' })).toBe(false);
    const sql = expertRAccessSql('$1', '$2', { EXPERT_R_ACCESS_POLICY: 'project-roles' });
    expect(sql).toContain("expert_deny.capability = 'expert_r.denied'");
    expect(sql).toContain('expert_user.is_demo_guest = FALSE');
    expect(sql).toContain('expert_pm.project_id = $2');
    expect(sql).not.toContain("'viewer'");
  });
  it('uses authenticated compatible runtime capabilities and projects only public identity', async () => {
    const env = await runtimeServer((req, res) => {
      expect(req.url).toBe('/capabilities'); expect(req.headers.authorization).toBe(`Bearer ${'a'.repeat(64)}`);
      res.end(JSON.stringify({ status: 'ok', profileId: EXPERT_R_PROFILE.id,
        sandboxImageDigest: `sha256:${'b'.repeat(64)}`, resourcePolicyVersion: EXPERT_R_RESOURCE_POLICY_VERSION,
        privatePath: '/operator/secrets' }));
    });
    const runtime = await probeExpertRRuntime(env);
    expect(runtime).toMatchObject({ state: 'ready', imageDigest: `sha256:${'b'.repeat(64)}` });
    expect(runtime).not.toHaveProperty('privatePath');
    expect(expertRStatus({ canExecuteExpertR: false, runtime, revoked: true, env }).state).toBe('access-revoked');
    expect(expertRStatus({ canExecuteExpertR: true, runtime, demoMode: true, env }).state).toBe('demo-disabled');
  });
  it('bounds response bytes and the entire request lifetime', async () => {
    const oversized = await runtimeServer((_req, res) => res.end('x'.repeat(20000)));
    expect((await probeExpertRRuntime(oversized, { timeoutMs: 200 })).state).not.toBe('ready');
    const stalled = await runtimeServer(() => {});
    const started = Date.now();
    expect(await probeExpertRRuntime(stalled, { timeoutMs: 50 })).toEqual({ state: 'unreachable' });
    expect(Date.now() - started).toBeLessThan(1000);
  });
  it('distinguishes invalid, incompatible and unconfigured services', async () => {
    expect(await probeExpertRRuntime({})).toEqual({ state: 'not-configured' });
    const invalid = await runtimeServer((_req, res) => res.end('invalid'));
    expect(await probeExpertRRuntime(invalid)).toEqual({ state: 'incompatible' });
    const wrongProfile = await runtimeServer((_req, res) => res.end(JSON.stringify({ status: 'ok', profileId: 'other' })));
    expect(await probeExpertRRuntime(wrongProfile)).toEqual({ state: 'incompatible' });
  });
});
