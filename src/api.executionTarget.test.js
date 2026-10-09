import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { electronAPI } from './api';
import * as privateR from './executions/privateKernelApi';
import { workflowRequest } from './pipelines/workflowApi';
import { importArtifactVersion } from './artifacts/artifactApi';

const target = { id: 'lab', status: 'connected', endpoint: 'https://selected.example.test', sshTunnel: { state: 'connected' } };
beforeEach(() => { vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ id: 'accepted' }) }))); });
afterEach(() => { delete window.desktopShell; vi.unstubAllGlobals(); });

it('blocks guided jobs, recipes, private R, and artifact imports without a fallback request while disconnected', async () => {
  window.desktopShell = { getCurrentTarget: vi.fn(async () => ({ ...target, sshTunnel: { state: 'disconnected' } })) };
  await expect(electronAPI.createProjectJob('project', { jobType: 'explore.summarize.v1' })).rejects.toMatchObject({ code: 'TARGET_DISCONNECTED' });
  await expect(workflowRequest('project', 'instances/recipe/run', 'POST', {})).rejects.toMatchObject({ code: 'TARGET_DISCONNECTED' });
  await expect(privateR.executePrivateRKernel('project', 'kernel', { source: 'cat(42)' })).rejects.toMatchObject({ code: 'TARGET_DISCONNECTED' });
  await expect(importArtifactVersion('project', { file: new File(['x'], 'input.csv') })).rejects.toMatchObject({ code: 'TARGET_DISCONNECTED' });
  const result = await electronAPI.apiRequest('/normalize', { method: 'POST', body: '{}' });
  expect(result).toMatchObject({ code: 'TARGET_DISCONNECTED', error: expect.stringContaining('Reconnect through Connection details') });
  expect(fetch).not.toHaveBeenCalled();
});

it('marks a dispatched private R command unconfirmed on connection loss without reissuing source', async () => {
  let notify; let finish; let started;
  const began = new Promise(resolve => { started = resolve; });
  window.desktopShell = { getCurrentTarget: async () => target, onTargetStatus: listener => { notify = listener; return () => {}; } };
  fetch.mockImplementation(() => { started(); return new Promise(resolve => { finish = resolve; }); });
  const result = privateR.executePrivateRKernel('project', 'kernel', { requestId: 'exact-request', source: 'cat(42)' });
  await began;
  notify({ ...target, sshTunnel: { state: 'disconnected' } });
  await expect(result).rejects.toMatchObject({ code: 'TARGET_EXECUTION_UNCONFIRMED' });
  finish({ ok: true, json: async () => ({ id: 'later-confirmed' }) });
  await Promise.resolve();
  expect(fetch).toHaveBeenCalledOnce();
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ requestId: 'exact-request', source: 'cat(42)' });
});
