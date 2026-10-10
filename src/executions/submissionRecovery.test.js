import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  RECOVERY_STORAGE_KEY, checkSubmissionReceipt, clearSubmissionRecovery, ensureSubmissionRecovery,
  forgetSubmission, getSubmissionRecoverySnapshot, reconcileSubmissions, selectRecoveredRun, submitWithRecovery,
} from './submissionRecovery';
import { electronAPI } from '../api';
import { workflowRequest } from '../pipelines/workflowApi';
import { subscribeExecutionTarget } from '../runtime/executionTarget';

const installation = { schema: 'traceomics.installation.v1', installationId: `svc_${'a'.repeat(32)}`, userId: 1 };
const requestId = '00000000-0000-4000-8000-000000000001';
const receipt = { schema: 'traceomics.job-submission.v1', requestId, projectId: 'proj_one', jobId: 'job_exact', requestHash: 'b'.repeat(64) };
const response = value => ({ ok: true, headers: new Headers(), json: async () => value });
const stored = () => JSON.parse(localStorage.getItem(RECOVERY_STORAGE_KEY));
const admitted = overrides => ({ ...receipt, ...overrides });
const submit = (overrides = {}) => submitWithRecovery({ projectId: 'proj_one', requestId, submit: async () => ({ submission: receipt }), ...overrides });
beforeEach(async () => {
  await clearSubmissionRecovery(); localStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async url => response(url === '/api/auth/installation' ? installation : receipt)));
});
afterEach(async () => { await clearSubmissionRecovery(); delete window.desktopShell; vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

it('persists a UUID before dispatch and stores only bounded identities, never scientific or transport data', async () => {
  await submit({ submit: async id => {
    const saved = stored();
    expect(saved.records).toEqual([{ kind: 'job', projectId: 'proj_one', requestId: id, state: 'pending', createdAt: expect.any(String) }]);
    return { parameters: { source: 'secret scientific script', inputPath: '/private/input.rds', token: 'private-cookie' }, submission: { ...receipt, source: 'discard me' } };
  } });
  expect(stored()).toMatchObject({ version: 1, scope: { installationId: installation.installationId, userId: 1, targetHash: expect.stringMatching(/^[a-f0-9]{64}$/) } });
  // The authenticated descriptor's schema is not part of the local scope.
  expect(stored().scope).not.toHaveProperty('schema');
  expect(stored().records[0]).toMatchObject({ state: 'accepted', jobId: 'job_exact', requestHash: receipt.requestHash });
  expect(JSON.stringify(stored())).not.toMatch(/scientific|source|inputPath|cookie|endpoint|parameters|confirmed/);
});

it('keeps a lost acknowledgement pending, blocks another dispatch and recovers exactly through GET', async () => {
  await expect(submit({ submit: async () => { throw new TypeError('Failed to fetch'); } })).rejects.toMatchObject({ code: 'SUBMISSION_UNCONFIRMED' });
  const another = vi.fn();
  await expect(submit({ requestId: crypto.randomUUID(), submit: another })).rejects.toMatchObject({ code: 'SUBMISSION_RECOVERY_REQUIRED' });
  expect(another).not.toHaveBeenCalled();
  await reconcileSubmissions();
  expect(getSubmissionRecoverySnapshot().records[0]).toMatchObject({ requestId, jobId: 'job_exact', confirmed: true });
  expect(getSubmissionRecoverySnapshot().selection).toEqual({ projectId: 'proj_one', runId: 'job_exact' });
  expect(fetch.mock.calls.every(([, options]) => !options.method || options.method === 'GET')).toBe(true);
});

it('reopens with identifiers only and requires an authoritative receipt before more work', async () => {
  await submit();
  const saved = localStorage.getItem(RECOVERY_STORAGE_KEY);
  const generation = stored().generation;
  await clearSubmissionRecovery(); localStorage.setItem('traceomics_submission_recovery_v1_generation', generation); localStorage.setItem(RECOVERY_STORAGE_KEY, saved);
  await ensureSubmissionRecovery({ userId: 1 });
  expect(getSubmissionRecoverySnapshot().records[0].confirmed).toBe(false);
  const another = vi.fn();
  await expect(submit({ requestId: crypto.randomUUID(), submit: another })).rejects.toMatchObject({ code: 'SUBMISSION_RECOVERY_REQUIRED' });
  expect(another).not.toHaveBeenCalled();
  await reconcileSubmissions();
  expect(getSubmissionRecoverySnapshot().records[0].confirmed).toBe(true);
  expect(getSubmissionRecoverySnapshot().selection.runId).toBe('job_exact');
});

it.each([
  { ...installation, userId: 2 },
  { ...installation, installationId: `svc_${'c'.repeat(32)}` },
])('invalidates old private locators when the authenticated account or installation changes', async changed => {
  await submit();
  fetch.mockResolvedValue(response(changed));
  await ensureSubmissionRecovery({ userId: changed.userId, force: true });
  expect(stored().records).toEqual([]);
  expect(stored().selection).toBeNull();
  expect(getSubmissionRecoverySnapshot().scope).toMatchObject({ userId: changed.userId, installationId: changed.installationId });
});

it('keeps the target partition stable across changing SSH tunnel ports and invalidates another target', async () => {
  let target = { id: 'lab', serviceIdentity: 'ssh-account-partition', endpoint: 'https://127.0.0.1:41001', status: 'connected', sshTunnel: { state: 'connected' } };
  window.desktopShell = { getCurrentTarget: async () => target };
  await submit();
  const saved = localStorage.getItem(RECOVERY_STORAGE_KEY);
  const hash = stored().scope.targetHash;
  const generation = stored().generation;
  await clearSubmissionRecovery(); localStorage.setItem('traceomics_submission_recovery_v1_generation', generation); localStorage.setItem(RECOVERY_STORAGE_KEY, saved);
  target = { ...target, endpoint: 'https://127.0.0.1:41002' };
  await ensureSubmissionRecovery({ userId: 1, force: true });
  expect(stored().scope.targetHash).toBe(hash);
  expect(stored().records).toHaveLength(1);
  target = { ...target, serviceIdentity: 'different-route-partition' };
  await ensureSubmissionRecovery({ userId: 1, force: true });
  expect(stored().scope.targetHash).not.toBe(hash);
  expect(stored().records).toEqual([]);
});

it('requires an explicit forget decision after a missing receipt, while checking project access first', async () => {
  await expect(submit({ submit: async () => { throw new Error('Lost reply'); } })).rejects.toThrow('unconfirmed');
  fetch.mockImplementation(async url => url.includes('job-submissions') ? { ok: false, status: 404 } : response(url === '/api/auth/installation' ? installation : { id: 'proj_one' }));
  await checkSubmissionReceipt(requestId);
  expect(getSubmissionRecoverySnapshot().records[0].state).toBe('missing');
  await expect(submit({ requestId: crypto.randomUUID() })).rejects.toThrow('earlier submission');
  expect(fetch).toHaveBeenCalledWith('/api/projects/proj_one', expect.objectContaining({ credentials: 'include' }));
  await forgetSubmission(requestId);
  expect(stored().records).toEqual([]);
});

it.each([403, 404])('clears private project locators when project access is authoritatively denied (%i)', async status => {
  await submit();
  fetch.mockResolvedValue({ ok: false, status });
  await checkSubmissionReceipt(requestId);
  expect(getSubmissionRecoverySnapshot().records).toEqual([]);
  expect(getSubmissionRecoverySnapshot().selection).toBeNull();
});

it('clears all locators on session expiry and explicit logout storage cleanup', async () => {
  await submit();
  fetch.mockResolvedValue({ ok: false, status: 401 });
  await checkSubmissionReceipt(requestId);
  expect(localStorage.getItem(RECOVERY_STORAGE_KEY)).toBeNull();
  expect(getSubmissionRecoverySnapshot().scope).toBeNull();
  fetch.mockResolvedValue(response(installation));
  await ensureSubmissionRecovery();
  const api = await import('../api');
  await api.clearAuthSessionStorage();
  expect(getSubmissionRecoverySnapshot().scope).toBeNull();
});

it('never dispatches work if the local pending identifier cannot be durably written', async () => {
  await ensureSubmissionRecovery();
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Quota exceeded', 'QuotaExceededError'); });
  const action = vi.fn();
  await expect(submit({ submit: action })).rejects.toMatchObject({ code: 'SUBMISSION_STORAGE_UNAVAILABLE' });
  expect(action).not.toHaveBeenCalled();
});

it('ignores a late scientific reply after logout and retains no stale private state', async () => {
  let finish; let began;
  const started = new Promise(resolve => { began = resolve; });
  const result = submit({ submit: () => { began(); return new Promise(resolve => { finish = resolve; }); } });
  await started;
  await clearSubmissionRecovery();
  finish({ submission: receipt });
  await result;
  expect(getSubmissionRecoverySnapshot().records).toEqual([]);
  expect(localStorage.getItem(RECOVERY_STORAGE_KEY)).toBeNull();
});

it('rejects receipts for another exact job or input hash without replacing retained identities', async () => {
  await submit();
  fetch.mockResolvedValue(response({ ...receipt, jobId: 'job_other', requestHash: 'c'.repeat(64) }));
  await checkSubmissionReceipt(requestId);
  expect(stored().records[0]).toMatchObject({ jobId: 'job_exact', requestHash: receipt.requestHash });
  expect(getSubmissionRecoverySnapshot().error).toMatch(/could not confirm/);
});

it('bounds retained accepted identifiers and leaves no scientific payload at the limit', async () => {
  for (let index = 0; index < 26; index += 1) {
    const id = crypto.randomUUID();
    await submit({ requestId: id, submit: async () => ({ submission: admitted({ requestId: id, jobId: `job_${index}` }) }) });
  }
  expect(stored().records).toHaveLength(24);
  expect(localStorage.getItem(RECOVERY_STORAGE_KEY).length).toBeLessThan(16384);
  expect(stored().selection.runId).toBe('job_25');
});

it('rejects explicit UUID reuse before dispatch without corrupting the saved ledger', async () => {
  await submit();
  const action = vi.fn();
  await expect(submit({ submit: action })).rejects.toMatchObject({ code: 'SUBMISSION_RECOVERY_REQUIRED' });
  await expect(submit({ projectId: 'proj_other', submit: action })).rejects.toMatchObject({ code: 'SUBMISSION_RECOVERY_REQUIRED' });
  expect(action).not.toHaveBeenCalled();
  expect(stored().records).toHaveLength(1);
  const saved = localStorage.getItem(RECOVERY_STORAGE_KEY);
  const generation = stored().generation;
  await clearSubmissionRecovery(); localStorage.setItem('traceomics_submission_recovery_v1_generation', generation); localStorage.setItem(RECOVERY_STORAGE_KEY, saved);
  await ensureSubmissionRecovery();
  expect(getSubmissionRecoverySnapshot().records[0]).toMatchObject({ requestId, jobId: 'job_exact' });
});

it('admits only one overlapping project submission before a receipt is confirmed', async () => {
  let finish; let began;
  const started = new Promise(resolve => { began = resolve; });
  const first = submit({ submit: () => { began(); return new Promise(resolve => { finish = resolve; }); } });
  await started;
  const another = vi.fn();
  await expect(submit({ requestId: crypto.randomUUID(), submit: another })).rejects.toMatchObject({ code: 'SUBMISSION_RECOVERY_REQUIRED' });
  expect(another).not.toHaveBeenCalled();
  finish({ submission: receipt });
  await first;
  expect(stored().records).toHaveLength(1);
});

it('ignores corrupt or oversized local state rather than rendering private injected fields', async () => {
  localStorage.setItem(RECOVERY_STORAGE_KEY, JSON.stringify({ version: 1, scope: installation, records: [{ source: 'injected', requestId: '../private' }] }));
  await ensureSubmissionRecovery();
  expect(stored().records).toEqual([]);
  expect(localStorage.getItem(RECOVERY_STORAGE_KEY)).not.toContain('injected');
  await clearSubmissionRecovery();
  localStorage.setItem(RECOVERY_STORAGE_KEY, 'x'.repeat(40000));
  await ensureSubmissionRecovery();
  expect(stored().records).toEqual([]);
});

it('never substitutes cached user metadata for authenticated installation evidence', async () => {
  localStorage.setItem('traceomics_auth_user', JSON.stringify({ id: 1, email: 'cached@example.test' }));
  fetch.mockResolvedValue(response({ ...installation, userId: 2 }));
  await expect(ensureSubmissionRecovery({ userId: 1 })).rejects.toMatchObject({ code: 'SUBMISSION_RECOVERY_REQUIRED' });
  expect(getSubmissionRecoverySnapshot().scope).toBeNull();
});

it('bounds a stalled receipt read to ten seconds without deleting its unresolved UUID', async () => {
  await expect(submit({ submit: async () => { throw new Error('Lost'); } })).rejects.toThrow('unconfirmed');
  vi.useFakeTimers();
  fetch.mockImplementation((_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  }));
  const checked = checkSubmissionReceipt(requestId);
  await vi.advanceTimersByTimeAsync(10000);
  await checked;
  expect(getSubmissionRecoverySnapshot().records[0].requestId).toBe(requestId);
  expect(getSubmissionRecoverySnapshot().records[0].state).toBe('pending');
});

it('bounds receipt reads and keeps unresolved identifiers when the server response is oversized', async () => {
  await expect(submit({ submit: async () => { throw new Error('Lost'); } })).rejects.toThrow('unconfirmed');
  fetch.mockResolvedValue({ ok: true, headers: new Headers({ 'content-length': '20000' }), json: vi.fn() });
  await checkSubmissionReceipt(requestId);
  expect(getSubmissionRecoverySnapshot().records[0].state).toBe('pending');
  expect(getSubmissionRecoverySnapshot().error).toMatch(/could not confirm/);
});

it('runs bounded receipt checks without duplicating an overlapping check', async () => {
  await submit();
  let finish;
  fetch.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const first = checkSubmissionReceipt(requestId);
  const second = checkSubmissionReceipt(requestId);
  finish(response(receipt));
  await Promise.all([first, second]);
  expect(fetch).toHaveBeenCalledTimes(2); // One installation read, one receipt read.
});

it('records exact monitor selections only inside an authenticated recovery scope', async () => {
  await selectRecoveredRun('proj_one', 'job_exact');
  expect(stored()).toBeNull();
  await ensureSubmissionRecovery();
  await selectRecoveredRun('proj_one', 'pex_console');
  expect(stored().selection).toEqual({ projectId: 'proj_one', runId: 'pex_console' });
  await selectRecoveredRun('proj_one', '/private/path');
  expect(stored().selection.runId).toBe('pex_console');
});

it('tracks general scientific project wrappers through one funnel before their POST', async () => {
  const methods = [
    () => electronAPI.createProjectJob('proj_one', { jobType: 'expert.r.v1', parameters: { script: 'secret source' } }),
    () => electronAPI.createExploratoryAnalysisJob('proj_one', 'ao_one', { assay: 'RNA' }),
    () => electronAPI.createMultiSampleSeuratPipelineJob('proj_one', { samples: [{ datasetId: 'ds_one', sampleId: 's1' }] }),
  ];
  fetch.mockImplementation(async (url, options) => {
    if (url === '/api/auth/installation') return response(installation);
    const body = JSON.parse(options.body);
    expect(stored().records.at(-1).requestId).toBe(body.requestId);
    return response({ id: 'job_exact', submission: admitted({ requestId: body.requestId }) });
  });
  for (const method of methods) await method();
  expect(fetch.mock.calls.filter(([, options]) => options.method === 'POST')).toHaveLength(3);
  expect(new Set(stored().records.map(record => record.requestId)).size).toBe(3);
  expect(localStorage.getItem(RECOVERY_STORAGE_KEY)).not.toMatch(/source|assay|datasetId|samples/);
});

it('tracks recipe submissions and recovers the original job independently of newer instance state', async () => {
  const workflowReceipt = { ...receipt, schema: 'traceomics.workflow-submission.v1', instanceId: 'wfi_one' };
  fetch.mockImplementation(async (url, options) => {
    if (url === '/api/auth/installation') return response(installation);
    if (options.method === 'POST') {
      expect(stored().records[0]).toMatchObject({ state: 'pending', kind: 'workflow', instanceId: 'wfi_one' });
      return response({ id: 'wfi_one', state: { active: { jobId: 'job_newer' } }, submission: workflowReceipt });
    }
    return response(workflowReceipt);
  });
  await workflowRequest('proj_one', 'instances/wfi_one/run', 'POST', { requestId, stepId: 'qc', parameters: { minimum: 20 }, seed: 1 });
  await checkSubmissionReceipt(requestId);
  expect(stored().records[0].jobId).toBe('job_exact');
  expect(fetch).toHaveBeenCalledWith(`/api/workflows/proj_one/instances/wfi_one/submissions/${requestId}`, expect.objectContaining({ credentials: 'include' }));
  expect(localStorage.getItem(RECOVERY_STORAGE_KEY)).not.toMatch(/minimum|parameters|stepId|seed/);
});

it('invalidates confirmations after same-target disconnect/reconnect and never replays a POST', async () => {
  let notify;
  const target = { id: 'lab', serviceIdentity: 'stable-lab', status: 'connected', sshTunnel: { state: 'connected' } };
  window.desktopShell = { getCurrentTarget: async () => target, onTargetStatus: listener => { notify = listener; return () => {}; } };
  const release = subscribeExecutionTarget(() => {});
  try {
    await submit();
    notify({ ...target, sshTunnel: { state: 'disconnected' } });
    notify(target);
    await ensureSubmissionRecovery({ userId: 1, force: true });
    expect(getSubmissionRecoverySnapshot().records[0].confirmed).toBe(false);
    await reconcileSubmissions();
    expect(getSubmissionRecoverySnapshot().records[0].confirmed).toBe(true);
  } finally { release(); }
  expect(fetch.mock.calls.every(([, options]) => !options.method)).toBe(true);
});
