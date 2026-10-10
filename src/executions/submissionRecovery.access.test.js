import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  RECOVERY_STORAGE_KEY, checkSubmissionReceipt, clearProjectSubmissionRecovery, clearSubmissionRecovery,
  ensureSubmissionRecovery, forgetSubmission, getSubmissionRecoverySnapshot, submitWithRecovery,
} from './submissionRecovery';
import { workflowRequest } from '../pipelines/workflowApi';

const installation = { schema: 'traceomics.installation.v1', installationId: `svc_${'a'.repeat(32)}`, userId: 1 };
const response = value => ({ ok: true, headers: new Headers(), json: async () => value });
const denied = status => ({ ok: false, status, headers: new Headers() });
const deferred = () => { let resolve; const promise = new Promise(finish => { resolve = finish; }); return { promise, resolve }; };
const receipt = (requestId, projectId = 'proj_one') => ({ schema: 'traceomics.job-submission.v1', requestId, projectId,
  jobId: `job_${projectId}`, requestHash: 'b'.repeat(64) });
const stored = () => JSON.parse(localStorage.getItem(RECOVERY_STORAGE_KEY));
const action = (requestId, projectId = 'proj_one', submit) => submitWithRecovery({ requestId, projectId,
  submit: submit || (async id => ({ submission: receipt(id, projectId) })) });
const ambiguous = (requestId, projectId = 'proj_one') => expect(action(requestId, projectId, async () => { throw new TypeError('Lost reply'); }))
  .rejects.toMatchObject({ code: 'SUBMISSION_UNCONFIRMED' });

beforeEach(async () => {
  await clearSubmissionRecovery(); localStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async () => response(installation)));
});
afterEach(async () => {
  vi.restoreAllMocks(); await clearSubmissionRecovery(); delete window.desktopShell;
  vi.unstubAllGlobals(); vi.useRealTimers();
});

it('keeps the expected owner after an identity mismatch so a second stale click cannot adopt another session', async () => {
  await ensureSubmissionRecovery({ userId: 1 });
  await action(crypto.randomUUID());
  fetch.mockResolvedValue(response({ ...installation, userId: 2 }));
  const submit = vi.fn();
  for (let click = 0; click < 2; click += 1) {
    await expect(action(crypto.randomUUID(), 'proj_one', submit)).rejects.toMatchObject({ code: 'SUBMISSION_RECOVERY_REQUIRED' });
    expect(getSubmissionRecoverySnapshot().scope).toBeNull();
    expect(stored()).toBeNull();
  }
  expect(submit).not.toHaveBeenCalled();
  await ensureSubmissionRecovery({ userId: 2, force: true });
  await action(crypto.randomUUID());
  expect(stored().scope.userId).toBe(2);
  expect(stored().records).toHaveLength(1);
});

it.each([
  ['missing receipt', () => undefined],
  ['wrong schema', value => ({ ...value, schema: 'traceomics.workflow-submission.v1' })],
  ['wrong request', value => ({ ...value, requestId: crypto.randomUUID() })],
  ['wrong project', value => ({ ...value, projectId: 'proj_other' })],
  ['invalid job', value => ({ ...value, jobId: 'not_a_job' })],
  ['invalid hash', value => ({ ...value, requestHash: 'short' })],
])('keeps a %s POST response unconfirmed with its original pending UUID', async (_label, modify) => {
  const id = crypto.randomUUID(); const submit = vi.fn(async () => ({ id: 'job_unproved', submission: modify(receipt(id)) }));
  await expect(action(id, 'proj_one', submit)).rejects.toMatchObject({ code: 'SUBMISSION_UNCONFIRMED' });
  expect(submit).toHaveBeenCalledOnce();
  expect(stored().records).toEqual([expect.objectContaining({ requestId: id, state: 'pending' })]);
  expect(stored().records[0]).not.toHaveProperty('jobId');
  expect(getSubmissionRecoverySnapshot().records[0].confirmed).toBe(false);
  expect(getSubmissionRecoverySnapshot().selection).toBeNull();
  const next = vi.fn();
  await expect(action(crypto.randomUUID(), 'proj_one', next)).rejects.toThrow('earlier submission');
  expect(next).not.toHaveBeenCalled();
});

it('rejects a workflow POST receipt for another instance without losing the pending UUID', async () => {
  const id = crypto.randomUUID();
  await expect(submitWithRecovery({ projectId: 'proj_one', instanceId: 'wfi_one', kind: 'workflow', requestId: id,
    submit: async () => ({ submission: { ...receipt(id), schema: 'traceomics.workflow-submission.v1', instanceId: 'wfi_other' } }),
  })).rejects.toMatchObject({ code: 'SUBMISSION_UNCONFIRMED' });
  expect(stored().records[0]).toMatchObject({ requestId: id, instanceId: 'wfi_one', kind: 'workflow', state: 'pending' });
  expect(getSubmissionRecoverySnapshot().selection).toBeNull();
});

it('retains the durable pending UUID when a valid POST confirmation cannot be persisted', async () => {
  const id = crypto.randomUUID();
  await expect(action(id, 'proj_one', async () => {
    expect(stored().records[0].state).toBe('pending');
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Storage full', 'QuotaExceededError'); });
    return { submission: receipt(id) };
  })).rejects.toMatchObject({ code: 'SUBMISSION_UNCONFIRMED' });
  expect(stored().records[0]).toMatchObject({ requestId: id, state: 'pending' });
  expect(getSubmissionRecoverySnapshot().records[0]).toMatchObject({ requestId: id, state: 'pending', confirmed: false });
  expect(getSubmissionRecoverySnapshot().selection).toBeNull();
});

it('returns no confirmed GET receipt when saving its confirmation fails', async () => {
  const id = crypto.randomUUID(); await ambiguous(id);
  fetch.mockResolvedValue(response(receipt(id)));
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Storage full', 'QuotaExceededError'); });
  await expect(checkSubmissionReceipt(id)).resolves.toBeNull();
  expect(stored().records[0]).toMatchObject({ requestId: id, state: 'pending' });
  expect(getSubmissionRecoverySnapshot().records[0]).toMatchObject({ state: 'pending', confirmed: false });
  expect(getSubmissionRecoverySnapshot().selection).toBeNull();
});

it('revokes an accepted confirmation when the receipt disappears but project access remains valid', async () => {
  const id = crypto.randomUUID(); await action(id);
  fetch.mockImplementation(async url => url.includes('/job-submissions/') ? denied(404)
    : response(url === '/api/auth/installation' ? installation : { id: 'proj_one' }));
  await expect(checkSubmissionReceipt(id)).resolves.toBeNull();
  expect(getSubmissionRecoverySnapshot().records[0]).toMatchObject({ requestId: id, state: 'missing', confirmed: false, jobId: 'job_proj_one' });
  expect(stored().records[0]).toMatchObject({ state: 'missing', requestHash: 'b'.repeat(64) });
  const submit = vi.fn();
  await expect(action(crypto.randomUUID(), 'proj_one', submit)).rejects.toThrow('earlier submission');
  expect(submit).not.toHaveBeenCalled();
});

it('does not replace a newer POST confirmation with a GET missing response begun while the POST was pending', async () => {
  const id = crypto.randomUUID(); const began = deferred(); const finish = deferred();
  const posted = action(id, 'proj_one', () => { began.resolve(); return finish.promise; }); await began.promise;
  const reading = deferred(); const missing = deferred();
  fetch.mockImplementation(async url => {
    if (url.includes('/job-submissions/')) { reading.resolve(); return missing.promise; }
    return response({ id: 'proj_one' });
  });
  const checked = checkSubmissionReceipt(id); await reading.promise;
  finish.resolve({ submission: receipt(id) }); await posted;
  missing.resolve(denied(404)); await checked;
  expect(getSubmissionRecoverySnapshot().records[0]).toMatchObject({ requestId: id, state: 'accepted', confirmed: true, jobId: 'job_proj_one' });
  expect(stored().records[0].state).toBe('accepted');
});

it('clears only the denied POST project and preserves another unresolved request', async () => {
  const firstId = crypto.randomUUID(); await ambiguous(firstId);
  const deniedId = crypto.randomUUID();
  await expect(action(deniedId, 'proj_two', async () => { throw Object.assign(new Error('Forbidden'), { status: 403 }); }))
    .rejects.toMatchObject({ status: 403 });
  expect(stored().records).toEqual([expect.objectContaining({ requestId: firstId, projectId: 'proj_one', state: 'pending' })]);
  const submit = vi.fn();
  await expect(action(crypto.randomUUID(), 'proj_one', submit)).rejects.toThrow('earlier submission');
  expect(submit).not.toHaveBeenCalled();
});

it('quarantines private memory after an authoritative project denial cannot be persisted while preserving unrelated pending identifiers', async () => {
  const deniedId = crypto.randomUUID(); await action(deniedId);
  const otherId = crypto.randomUUID(); await ambiguous(otherId, 'proj_two');
  const saved = localStorage.getItem(RECOVERY_STORAGE_KEY);
  fetch.mockImplementation(async url => url === '/api/auth/installation' ? response(installation) : denied(403));
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Storage full', 'QuotaExceededError'); });
  await expect(checkSubmissionReceipt(deniedId)).resolves.toBeNull();
  expect(getSubmissionRecoverySnapshot().scope).toBeNull();
  expect(getSubmissionRecoverySnapshot().selection).toBeNull();
  expect(getSubmissionRecoverySnapshot().records).toEqual([]);
  expect(localStorage.getItem(RECOVERY_STORAGE_KEY)).toBe(saved);
  expect(stored().records).toContainEqual(expect.objectContaining({ requestId: otherId, projectId: 'proj_two', state: 'pending' }));
  const submit = vi.fn();
  await expect(action(crypto.randomUUID(), 'proj_two', submit)).rejects.toBeInstanceOf(Error);
  expect(submit).not.toHaveBeenCalled();
  expect(getSubmissionRecoverySnapshot().scope).toBeNull();
  expect(getSubmissionRecoverySnapshot().records).toEqual([]);
  expect(localStorage.getItem(RECOVERY_STORAGE_KEY)).toBe(saved);
});

it('clears all locators when a missing receipt fallback discovers an expired session', async () => {
  const ids = [crypto.randomUUID(), crypto.randomUUID()];
  await ambiguous(ids[0]); await ambiguous(ids[1], 'proj_two');
  fetch.mockImplementation(async url => denied(url.includes('/job-submissions/') ? 404 : 401));
  await expect(checkSubmissionReceipt(ids[0])).resolves.toBeNull();
  expect(fetch).toHaveBeenCalledWith('/api/projects/proj_one', expect.objectContaining({ credentials: 'include' }));
  expect(getSubmissionRecoverySnapshot().scope).toBeNull();
  expect(getSubmissionRecoverySnapshot().records).toEqual([]);
  expect(stored()).toBeNull();
});

it('fences a late POST after a permission-denied receipt without erasing another project', async () => {
  const otherId = crypto.randomUUID(); await ambiguous(otherId, 'proj_two');
  const id = crypto.randomUUID(); const began = deferred(); const finish = deferred();
  const posted = action(id, 'proj_one', () => { began.resolve(); return finish.promise; }); await began.promise;
  fetch.mockResolvedValue(denied(403)); await checkSubmissionReceipt(id);
  finish.resolve({ submission: receipt(id) }); await posted;
  expect(stored().records).toEqual([expect.objectContaining({ requestId: otherId, projectId: 'proj_two', state: 'pending' })]);
  expect(getSubmissionRecoverySnapshot().selection).toBeNull();
});

it.each(['forget', 'project access'])('fences a late receipt after %s removes its original locator', async mode => {
  const id = crypto.randomUUID(); await ambiguous(id);
  const reading = deferred(); const finish = deferred();
  fetch.mockImplementation(() => { reading.resolve(); return finish.promise; });
  const checked = checkSubmissionReceipt(id); await reading.promise;
  if (mode === 'forget') await forgetSubmission(id); else await clearProjectSubmissionRecovery('proj_one');
  finish.resolve(response(receipt(id))); await expect(checked).resolves.toBeNull();
  expect(stored().records).toEqual([]);
  expect(stored().selection).toBeNull();
  expect(getSubmissionRecoverySnapshot().records).toEqual([]);
});

it.each([401, 403])('preserves workflow HTTP %i status when an error response is not JSON', async status => {
  const otherId = crypto.randomUUID(); await ambiguous(otherId, 'proj_two');
  fetch.mockImplementation(async url => url === '/api/auth/installation' ? response(installation) : {
    ...denied(status), json: async () => { throw new SyntaxError('Unexpected HTML response'); },
  });
  const id = crypto.randomUUID();
  await expect(workflowRequest('proj_one', 'instances/wfi_one/run', 'POST', { requestId: id, stepId: 'qc' }))
    .rejects.toMatchObject({ status });
  expect(getSubmissionRecoverySnapshot().records.some(record => record.requestId === id)).toBe(false);
  if (status === 401) {
    expect(stored()).toBeNull(); expect(getSubmissionRecoverySnapshot().scope).toBeNull();
  } else {
    expect(stored().records).toEqual([expect.objectContaining({ requestId: otherId, state: 'pending' })]);
    expect(getSubmissionRecoverySnapshot().scope.userId).toBe(1);
  }
});
