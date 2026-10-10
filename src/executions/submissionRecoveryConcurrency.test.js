import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as recovery from './submissionRecovery';
import { subscribeExecutionTarget } from '../runtime/executionTarget';

const installation = { schema: 'traceomics.installation.v1', installationId: `svc_${'a'.repeat(32)}`, userId: 1 };
const response = value => ({ ok: true, headers: new Headers(), json: async () => value });
const deferred = () => { let resolve; const promise = new Promise(finish => { resolve = finish; }); return { promise, resolve }; };
const receipt = (requestId, projectId = 'proj_one') => ({ schema: 'traceomics.job-submission.v1', requestId, projectId, jobId: `job_${projectId}`, requestHash: 'b'.repeat(64) });
const stored = () => JSON.parse(localStorage.getItem(recovery.RECOVERY_STORAGE_KEY));
const action = (helper = recovery, projectId = 'proj_one', submit, requestId = crypto.randomUUID()) => helper.submitWithRecovery({ projectId, requestId,
  submit: submit || (async id => ({ submission: receipt(id, projectId) })) });
const peers = [];
async function peer() {
  vi.resetModules();
  const helper = await import('./submissionRecovery');
  peers.push(helper); await helper.ensureSubmissionRecovery({ userId: 1 }); return helper;
}
function storageChanged() { window.dispatchEvent(new StorageEvent('storage', { key: recovery.RECOVERY_STORAGE_KEY })); }
beforeEach(async () => {
  await recovery.clearSubmissionRecovery(); localStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async () => response(installation)));
});
afterEach(async () => {
  for (const helper of peers.splice(0)) await helper.clearSubmissionRecovery();
  await recovery.clearSubmissionRecovery(); delete window.desktopShell;
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

it('merges a peer receipt against the latest ledger without losing a later ambiguous submission', async () => {
  const oldId = crypto.randomUUID(); await action(recovery, 'proj_one', undefined, oldId);
  const other = await peer(); const reading = deferred(); const finish = deferred();
  fetch.mockImplementation(async url => {
    if (url === '/api/auth/installation') return response(installation);
    reading.resolve(); return finish.promise;
  });
  const checking = other.checkSubmissionReceipt(oldId); await reading.promise;
  const nextId = crypto.randomUUID();
  await expect(action(recovery, 'proj_one', async () => { throw new Error('Lost reply'); }, nextId)).rejects.toMatchObject({ code: 'SUBMISSION_UNCONFIRMED' });
  finish.resolve(response(receipt(oldId))); await checking;
  expect(stored().records.map(record => record.requestId)).toEqual([oldId, nextId]);
  expect(other.getSubmissionRecoverySnapshot().records.find(record => record.requestId === nextId).state).toBe('pending');
  const submit = vi.fn();
  await expect(action(other, 'proj_one', submit)).rejects.toThrow('earlier submission');
  expect(submit).not.toHaveBeenCalled();
});

it('serializes competing same-project admissions while keeping HTTP outside the lock', async () => {
  await recovery.ensureSubmissionRecovery({ userId: 1 }); const other = await peer();
  const began = deferred(); const finish = deferred(); const firstId = crypto.randomUUID();
  const first = action(recovery, 'proj_one', () => { began.resolve(); return finish.promise; }, firstId);
  await began.promise;
  const second = vi.fn(); await expect(action(other, 'proj_one', second)).rejects.toThrow('earlier submission');
  expect(second).not.toHaveBeenCalled(); expect(stored().records).toHaveLength(1);
  finish.resolve({ submission: receipt(firstId) }); await first;
});

it('preserves independent projects across overlapping peer submissions and confirmations', async () => {
  await recovery.ensureSubmissionRecovery({ userId: 1 }); const other = await peer();
  const ids = [crypto.randomUUID(), crypto.randomUUID()]; const began = deferred(); const finish = deferred();
  const first = action(recovery, 'proj_one', () => { began.resolve(); return finish.promise; }, ids[0]); await began.promise;
  await action(other, 'proj_two', undefined, ids[1]);
  expect(stored().records).toEqual(expect.arrayContaining([expect.objectContaining({ requestId: ids[0], state: 'pending' }), expect.objectContaining({ requestId: ids[1], state: 'accepted' })]));
  finish.resolve({ submission: receipt(ids[0]) }); await first;
  expect(stored().records).toHaveLength(2);
  expect(stored().records.every(record => record.state === 'accepted')).toBe(true);
});

it.each(['logout', 'scope'])('invalidates a peer on a %s storage event and fences a late receipt', async mode => {
  const id = crypto.randomUUID(); await action(recovery, 'proj_one', undefined, id); const other = await peer();
  const reading = deferred(); const finish = deferred(); fetch.mockImplementation(async () => { reading.resolve(); return finish.promise; });
  const checking = other.checkSubmissionReceipt(id); await reading.promise;
  if (mode === 'logout') await recovery.clearSubmissionRecovery();
  else { const value = stored(); value.scope.userId = 2; localStorage.setItem(recovery.RECOVERY_STORAGE_KEY, JSON.stringify(value)); }
  storageChanged(); expect(other.getSubmissionRecoverySnapshot().scope).toBeNull();
  const saved = localStorage.getItem(recovery.RECOVERY_STORAGE_KEY);
  finish.resolve(response(receipt(id))); await checking;
  expect(localStorage.getItem(recovery.RECOVERY_STORAGE_KEY)).toBe(saved);
  expect(other.getSubmissionRecoverySnapshot().selection).toBeNull();
});

it.each(['forget', 'project'])('does not restore a removed request or selection after peer %s', async mode => {
  const id = crypto.randomUUID(); await action(recovery, 'proj_one', undefined, id); const other = await peer();
  const reading = deferred(); const finish = deferred(); fetch.mockImplementation(async () => { reading.resolve(); return finish.promise; });
  const checking = recovery.checkSubmissionReceipt(id); await reading.promise;
  if (mode === 'forget') await other.forgetSubmission(id); else await other.clearProjectSubmissionRecovery('proj_one');
  finish.resolve(response(receipt(id))); await checking;
  expect(stored().records).toEqual([]); expect(stored().selection).toBeNull();
  expect(recovery.getSubmissionRecoverySnapshot().selection).toBeNull();
});

it('fences a queued monitor selection after a project access clear', async () => {
  await action(); const began = deferred(); const release = deferred();
  const held = navigator.locks.request(recovery.RECOVERY_STORAGE_KEY, {}, () => { began.resolve(); return release.promise; }); await began.promise;
  const clear = recovery.clearProjectSubmissionRecovery('proj_one');
  const selection = recovery.selectRecoveredRun('proj_one', 'job_proj_one');
  release.resolve(); await Promise.all([held, clear, selection]);
  expect(stored().records).toEqual([]); expect(stored().selection).toBeNull();
  await recovery.selectRecoveredRun('proj_one', 'job_proj_one', { requestId: crypto.randomUUID() });
  expect(stored().selection).toBeNull();
});

it('does not admit work queued before a peer clears project access', async () => {
  await recovery.ensureSubmissionRecovery({ userId: 1 }); const other = await peer();
  const queued = deferred(); const release = deferred(); const request = navigator.locks.request.bind(navigator.locks); let calls = 0;
  vi.spyOn(navigator.locks, 'request').mockImplementation((...args) => {
    calls += 1;
    if (calls === 2) { queued.resolve(); return release.promise.then(() => request(...args)); }
    return request(...args);
  });
  const submit = vi.fn(); const pending = action(recovery, 'proj_one', submit);
  const rejected = expect(pending).rejects.toMatchObject({ code: 'SUBMISSION_RECOVERY_CHANGED' });
  await queued.promise; await other.clearProjectSubmissionRecovery('proj_one'); release.resolve(); await rejected;
  expect(submit).not.toHaveBeenCalled(); expect(stored().records).toEqual([]);
});

it('fails closed when same-origin coordination is unavailable', async () => {
  Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined }); const submit = vi.fn();
  await expect(action(recovery, 'proj_one', submit)).rejects.toMatchObject({ code: 'SUBMISSION_COORDINATION_UNAVAILABLE' });
  expect(submit).not.toHaveBeenCalled(); expect(stored()).toBeNull();
});

it('removes private locators on logout even when quota prevents updating its generation tombstone', async () => {
  await action(); const set = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (key, value) {
    if (key === recovery.RECOVERY_GENERATION_KEY) throw new DOMException('Quota exhausted', 'QuotaExceededError');
    return set.call(this, key, value);
  });
  await recovery.clearSubmissionRecovery();
  expect(stored()).toBeNull(); expect(recovery.getSubmissionRecoverySnapshot().scope).toBeNull();
});

it('keeps a failed project-clear quarantine until a peer proves that exact project was removed', async () => {
  const deniedId = crypto.randomUUID(); await action(recovery, 'proj_one', undefined, deniedId); const other = await peer();
  const pendingId = crypto.randomUUID();
  await expect(action(recovery, 'proj_two', async () => { throw new Error('Lost reply'); }, pendingId)).rejects.toThrow('unconfirmed');
  fetch.mockImplementation(async url => url === '/api/auth/installation' ? response(installation) : ({ ok: false, status: url.includes('proj_one') ? 403 : 503 }));
  const writes = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage unavailable'); });
  await recovery.checkSubmissionReceipt(deniedId); writes.mockRestore();
  expect(recovery.getSubmissionRecoverySnapshot().scope).toBeNull();
  await other.selectRecoveredRun('proj_two', 'job_other'); storageChanged();
  const submit = vi.fn();
  await expect(action(recovery, 'proj_three', submit)).rejects.toMatchObject({ code: 'SUBMISSION_STORAGE_UNAVAILABLE' });
  expect(submit).not.toHaveBeenCalled(); expect(recovery.getSubmissionRecoverySnapshot().scope).toBeNull();
  await other.clearProjectSubmissionRecovery('proj_one'); storageChanged();
  await vi.waitFor(() => expect(recovery.getSubmissionRecoverySnapshot().scope?.userId).toBe(1));
  expect(stored().records).toEqual([expect.objectContaining({ projectId: 'proj_two', requestId: pendingId, state: 'pending' })]);
  expect(recovery.getSubmissionRecoverySnapshot().records).not.toEqual(expect.arrayContaining([expect.objectContaining({ projectId: 'proj_one' })]));
  await expect(action(recovery, 'proj_two', submit)).rejects.toThrow('earlier submission'); expect(submit).not.toHaveBeenCalled();
});

it('does not dispatch a scientific POST when the execution target changes while its admission lock is queued', async () => {
  let notify; const target = { id: 'lab', serviceIdentity: 'stable-lab', status: 'connected', sshTunnel: { state: 'connected' } };
  window.desktopShell = { getCurrentTarget: async () => target, onTargetStatus: listener => { notify = listener; return () => {}; } };
  const stop = subscribeExecutionTarget(() => {});
  try {
    await recovery.ensureSubmissionRecovery({ userId: 1 });
    const queued = deferred(); const release = deferred(); const request = navigator.locks.request.bind(navigator.locks); let calls = 0; let drained;
    vi.spyOn(navigator.locks, 'request').mockImplementation((...args) => {
      calls += 1;
      if (calls === 2) { queued.resolve(); drained = release.promise.then(() => request(...args)); return drained; }
      return request(...args);
    });
    const submit = vi.fn(); const pending = action(recovery, 'proj_one', submit);
    const rejected = expect(pending).rejects.toMatchObject({ code: 'TARGET_EXECUTION_UNCONFIRMED' });
    await queued.promise; notify({ ...target, sshTunnel: { state: 'disconnected' } }); await rejected;
    release.resolve(); await drained.catch(() => {});
    expect(submit).not.toHaveBeenCalled(); expect(stored().records).toEqual([]);
  } finally { stop(); }
});
