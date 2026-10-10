import { afterEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
const { createDispatchObserver, createRunResourceObservers } = require('./runMonitoringResources');
const { unavailable } = require('./containerObservation');
const servers = [];
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } });
const now = Date.parse('2030-01-01T00:00:00Z');
const observation = { state: 'observed', scope: 'r-container', observedAt: new Date(now).toISOString(), memoryBytes: 42, memoryLimitBytes: 1024, cpuPercent: 123, cpuLimit: 2 };
const token = 'f'.repeat(64);
const scope = { jobId: 'job_' + 'a'.repeat(16), projectId: 'proj_monitor', ownerUserId: 1, dispatchId: 'b'.repeat(64) };
async function listener(handler) {
  const server = http.createServer(handler); servers.push(server);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

describe('read-only runtime observation clients', () => {
  it('sends only the exact retained scope to the authenticated observe route', async () => {
    let received;
    const baseUrl = await listener(async (request, response) => {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      received = { path: request.url, method: request.method, auth: request.headers.authorization, body: JSON.parse(Buffer.concat(chunks)) };
      response.end(JSON.stringify({ ok: true, ...scope, observation: { ...observation, privatePath: '/private/data' } }));
    });
    const observe = createDispatchObserver({ baseUrl, token, now: () => now });
    expect(await observe({ ...scope, source: 'never transmitted' })).toEqual(observation);
    expect(received).toEqual({ path: '/observe', method: 'POST', auth: `Bearer ${token}`, body: scope });
  });
  it.each(['owner', 'dispatch', 'oversized', 'malformed', 'forbidden', 'stale'])('rejects %s replies without private diagnostics', async mode => {
    const baseUrl = await listener((_request, response) => {
      let raw = { ok: true, ...scope, observation };
      if (mode === 'owner') raw.ownerUserId = 2;
      if (mode === 'dispatch') raw.dispatchId = 'c'.repeat(64);
      if (mode === 'stale') raw.observation = { ...observation, observedAt: new Date(now - 15001).toISOString() };
      if (mode === 'forbidden') response.statusCode = 403;
      response.end(mode === 'oversized' ? 'x'.repeat(4097) : mode === 'malformed' ? 'private error' : JSON.stringify(raw));
    });
    expect(await createDispatchObserver({ baseUrl, token, now: () => now })(scope)).toEqual(unavailable());
  });
  it('bounds the entire observation request rather than resetting its deadline for incoming bytes', async () => {
    const baseUrl = await listener((_request, response) => response.write('{'));
    const before = Date.now();
    expect(await createDispatchObserver({ baseUrl, token, timeoutMs: 30 })(scope)).toEqual(unavailable());
    expect(Date.now() - before).toBeLessThan(1000);
  });
  it('rejects invalid configurations and scopes before making a request', async () => {
    expect(await createDispatchObserver({ baseUrl: 'https://untrusted.example', token })(scope)).toEqual(unavailable());
    expect(await createDispatchObserver({ baseUrl: 'http://127.0.0.1:1', token })({ ...scope, ownerUserId: 0 })).toEqual(unavailable());
  });
  it('observes only active sandbox dispatches and exact private kernel generations', async () => {
    const observeDispatch = vi.fn(async () => observation), kernelClient = { observe: vi.fn(async () => ({ ok: true, kernelId: 'pk_' + 'c'.repeat(24), generation: 'd'.repeat(64), observation })) };
    const observers = createRunResourceObservers({ observeDispatch, kernelClient, now: () => now });
    const row = { id: scope.jobId, project_id: scope.projectId, owner_user_id: 1, status: 'running' };
    const receipt = { dispatchId: scope.dispatchId, target: { runtimeKind: 'sandbox-r' } };
    expect(await observers.observeJob(row, receipt)).toEqual(observation);
    expect(observeDispatch).toHaveBeenCalledWith(scope);
    expect(await observers.observeJob({ ...row, status: 'completed' }, receipt)).toEqual(unavailable());
    expect(await observers.observeJob(row, { ...receipt, target: { runtimeKind: 'guided-r' } })).toEqual(unavailable());
    expect(observeDispatch).toHaveBeenCalledTimes(1);
    const kernel = { id: 'pk_' + 'c'.repeat(24), runtime_generation: 'd'.repeat(64), kernel_status: 'running', owner_user_id: 1, project_id: scope.projectId, workspace_id: 'workspace1' };
    expect(await observers.observeKernel(kernel)).toEqual(observation);
    expect(kernelClient.observe).toHaveBeenCalledWith({ ownerUserId: 1, projectId: scope.projectId, workspaceId: 'workspace1', generation: kernel.runtime_generation }, kernel.id);
    kernelClient.observe.mockResolvedValue({ ok: true, kernelId: kernel.id, generation: 'e'.repeat(64), observation });
    expect(await observers.observeKernel(kernel)).toEqual(unavailable());
    expect(await observers.observeKernel({ ...kernel, kernel_status: 'stopped' })).toEqual(unavailable());
  });
});
