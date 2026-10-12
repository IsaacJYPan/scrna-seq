import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as recovery from './privateSubmissionRecovery';
import * as common from './submissionRecovery';
import { subscribeExecutionTarget } from '../runtime/executionTarget';

const installation = { schema: 'traceomics.installation.v1', installationId: `svc_${'a'.repeat(32)}`, userId: 1 };
const kernelId = `pk_${'1'.repeat(24)}`;
const generation = '2'.repeat(64);
const executionId = `pex_${'3'.repeat(24)}`;
const publicationId = `pub_${'4'.repeat(24)}`;
const restartId = `prst_${'5'.repeat(24)}`;
const replacementKernelId = `pk_${'6'.repeat(24)}`;
const versionId = `av_${'7'.repeat(24)}`;
const response = value => ({ ok: true, headers: new Headers(), json: async () => value });
const denied = status => ({ ok: false, status, headers: new Headers() });
const stored = () => JSON.parse(localStorage.getItem(recovery.PRIVATE_RECOVERY_STORAGE_KEY));
const deferred = () => { let resolve; const promise = new Promise(finish => { resolve = finish; }); return { promise, resolve }; };
const environment = { id: `renv_${'8'.repeat(64)}`, manifestSha256: '8'.repeat(64), profileId: 'test.r.v1', snapshotScope: 'container-userspace',
  imageDigest: `sha256:${'9'.repeat(64)}`, imageId: `sha256:${'a'.repeat(64)}`, rVersion: '4.5.1', bioconductor: '3.21' };
const inputs = {
  start: { workspaceId: 'workspace_one', environment, inputs: [], analysisObjectId: null },
  execution: { source: 'α <- 1\ncat(α)' },
  publication: { type: 'table', name: ' Saved table ', binding: 'private_binding' },
  restart: { generation },
};
function receipt(record, extras = {}) {
  return { schema: 'traceomics.private-r-submission.v1', kind: record.kind, requestId: record.requestId,
    projectId: record.projectId, workspaceId: record.workspaceId, requestHash: record.requestHash, kernelId, generation,
    status: record.kind === 'start' ? 'ready' : 'completed', completionKnown: true,
    ...(record.kind === 'execution' ? { executionId, order: 1 } : {}),
    ...(record.kind === 'publication' ? { publicationId, sourceExecutionId: executionId, order: 1, versionId } : {}),
    ...(record.kind === 'restart' ? { restartId, replacementKernelId } : {}), ...extras };
}
const action = (kind = 'execution', { helper = recovery, projectId = 'proj_one', workspaceId = 'workspace_one', input, post, ...options } = {}) =>
  helper.submitPrivateWithRecovery(projectId, kind, { ...inputs[kind], ...input }, { workspaceId, kernelId: kind === 'start' ? undefined : kernelId,
    generation: kind === 'start' ? undefined : generation, userId: 1, post: post || (async body => ({ submission: receipt(stored().records.find(item => item.requestId === body.requestId)) })), ...options });
const lose = (kind = 'execution', options = {}) => expect(action(kind, { ...options, post: async () => { throw new TypeError('Lost response'); } }))
  .rejects.toMatchObject({ code: 'PRIVATE_SUBMISSION_UNCONFIRMED' });
const peers = [];
async function peer() { vi.resetModules(); const helper = await import('./privateSubmissionRecovery'); peers.push(helper); await helper.ensurePrivateRecovery({ userId: 1 }); return helper; }
const storageChanged = () => window.dispatchEvent(new StorageEvent('storage', { key: recovery.PRIVATE_RECOVERY_STORAGE_KEY }));

beforeEach(async () => {
  await recovery.clearPrivateRecovery(); localStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async url => response(url === '/api/auth/installation' ? installation : { id: 'proj_one' })));
});
afterEach(async () => {
  vi.restoreAllMocks(); for (const helper of peers.splice(0)) await helper.clearPrivateRecovery();
  await recovery.clearPrivateRecovery(); delete window.desktopShell; vi.unstubAllGlobals(); vi.useRealTimers();
});

it.each(['start', 'execution', 'publication', 'restart'])('durably saves %s identity before POST and survives reopening with GET-only recovery', async kind => {
  await lose(kind);
  const saved = stored().records[0];
  expect(saved).toMatchObject({ kind, state: 'pending', requestHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect(JSON.stringify(stored())).not.toMatch(/source|binding|environment|private_binding|Saved table|parameters|credentials|token|outputs/);
  const other = await peer();
  expect(other.getPrivateRecoverySnapshot().records[0]).toMatchObject({ requestId: saved.requestId, confirmed: false });
  fetch.mockImplementation(async url => response(url === '/api/auth/installation' ? installation : receipt(saved)));
  const another = vi.fn(); await expect(action(kind, { helper: other, post: another })).rejects.toThrow('earlier private R');
  expect(another).not.toHaveBeenCalled();
  await other.reconcilePrivateSubmissions({ projectId: 'proj_one', workspaceId: 'workspace_one' });
  expect(other.getPrivateRecoverySnapshot().records[0]).toMatchObject({ state: 'accepted', confirmed: true, kernelId, requestId: saved.requestId });
  expect(fetch.mock.calls.every(([, options]) => !options.method || options.method === 'GET')).toBe(true);
  const route = kind === 'start' || kind === 'restart' ? `/api/private-r-kernels/proj_one/${kind}-submissions/${saved.requestId}`
    : `/api/private-r-kernels/proj_one/${kernelId}/${kind}-submissions/${saved.requestId}`;
  expect(fetch).toHaveBeenCalledWith(route, expect.objectContaining({ credentials: 'include' }));
});

it.each(['start', 'execution', 'publication', 'restart'])('checks the existing server %s hash contract before dispatch', async kind => {
  let body;
  await action(kind, { post: async value => {
    body = value; const record = stored().records[0]; let normalized;
    if (kind === 'start') normalized = { requestId: body.requestId, workspaceId: body.workspaceId, analysisObjectId: null, environment, inputs: [] };
    if (kind === 'execution') normalized = body.source;
    if (kind === 'publication') normalized = { requestId: body.requestId, name: 'Saved table', type: 'table', binding: 'private_binding', previousVersionId: null };
    if (kind === 'restart') normalized = { requestId: body.requestId, generation, kernelId };
    expect(record.requestHash).toBe(createHash('sha256').update(typeof normalized === 'string' ? normalized : JSON.stringify(normalized)).digest('hex'));
    return { submission: receipt(record), privateSource: body.source };
  } });
  expect(stored().records[0]).toMatchObject({ state: 'accepted', requestId: body.requestId });
  expect(stored().records[0]).not.toHaveProperty('confirmed');
});

it('does not dispatch if the initial pending write fails', async () => {
  await recovery.ensurePrivateRecovery({ userId: 1 });
  const write = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (key, value) {
    if (key === recovery.PRIVATE_RECOVERY_STORAGE_KEY && JSON.parse(value).records.length) throw new DOMException('Full', 'QuotaExceededError');
    return write.call(this, key, value);
  });
  const post = vi.fn(); await expect(action('execution', { post })).rejects.toMatchObject({ code: 'PRIVATE_SUBMISSION_STORAGE_UNAVAILABLE' });
  expect(post).not.toHaveBeenCalled(); expect(stored().records).toEqual([]);
});

it('keeps the original pending UUID when an accepted confirmation cannot be written', async () => {
  await expect(action('execution', { post: async body => {
    const record = stored().records[0]; expect(record.requestId).toBe(body.requestId);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Full', 'QuotaExceededError'); });
    return { submission: receipt(record) };
  } })).rejects.toMatchObject({ code: 'PRIVATE_SUBMISSION_UNCONFIRMED' });
  expect(stored().records[0].state).toBe('pending');
  expect(recovery.getPrivateRecoverySnapshot().records[0]).toMatchObject({ state: 'pending', confirmed: false });
});

it.each(['requestId', 'requestHash', 'projectId', 'workspaceId', 'kernelId', 'generation'])('rejects a mismatched %s while retaining the original pending identity', async field => {
  const values = { requestId: crypto.randomUUID(), requestHash: 'b'.repeat(64), projectId: 'proj_other', workspaceId: 'workspace_other', kernelId: replacementKernelId, generation: 'c'.repeat(64) };
  await expect(action('execution', { post: async () => ({ submission: receipt(stored().records[0], { [field]: values[field] }) }) }))
    .rejects.toMatchObject({ code: 'PRIVATE_SUBMISSION_UNCONFIRMED' });
  expect(stored().records[0].state).toBe('pending');
});

it('accepts a running exact receipt but does not release another scientific mutation', async () => {
  await action('execution', { post: async () => ({ submission: receipt(stored().records[0], { status: 'running', completionKnown: false }) }) });
  const post = vi.fn(); await expect(action('publication', { post })).rejects.toThrow('earlier private R');
  expect(post).not.toHaveBeenCalled();
  const record = stored().records[0]; fetch.mockImplementation(async url => response(url === '/api/auth/installation' ? installation : receipt(record)));
  await recovery.checkPrivateSubmissionReceipt(record.requestId);
  await action('publication'); expect(stored().records).toHaveLength(2);
});

it('keeps a missing UUID fenced after verifying project access and never substitutes a generic ready session', async () => {
  await lose(); const record = stored().records[0];
  fetch.mockImplementation(async url => url.includes('execution-submissions') ? denied(404) : response(url === '/api/auth/installation' ? installation : { id: kernelId, status: 'ready' }));
  await recovery.checkPrivateSubmissionReceipt(record.requestId);
  expect(stored().records[0]).toMatchObject({ requestId: record.requestId, state: 'missing' });
  const post = vi.fn(); await expect(action('execution', { post })).rejects.toThrow('earlier private R'); expect(post).not.toHaveBeenCalled();
  expect(fetch).toHaveBeenCalledWith('/api/projects/proj_one', expect.any(Object));
});

it('deduplicates overlapping checks and caps independent checks at four', async () => {
  for (let index = 0; index < 7; index += 1) await lose('execution', { projectId: `proj_${index}` });
  const waiting = []; let active = 0; let maximum = 0;
  fetch.mockImplementation(async url => {
    const record = stored().records.find(item => url.endsWith(item.requestId));
    active += 1; maximum = Math.max(maximum, active);
    const gate = deferred(); waiting.push(() => { active -= 1; gate.resolve(response(receipt(record))); });
    return gate.promise;
  });
  const checked = recovery.reconcilePrivateSubmissions();
  await vi.waitFor(() => expect(waiting).toHaveLength(4));
  const same = recovery.checkPrivateSubmissionReceipt(stored().records[0].requestId);
  expect(waiting).toHaveLength(4);
  while (waiting.length) { waiting.shift()(); await Promise.resolve(); await Promise.resolve(); }
  await vi.waitFor(() => expect(waiting).toHaveLength(3));
  for (const finish of waiting.splice(0)) finish(); await Promise.all([checked, same]);
  expect(maximum).toBe(4); expect(fetch).toHaveBeenCalledTimes(14); // Seven installation reads + seven exact receipts.
});

it.each(['timeout', 'header', 'stream'])('retains an unresolved UUID after a receipt %s limit', async limit => {
  await lose(); const record = stored().records[0];
  if (limit === 'timeout') {
    vi.useFakeTimers(); fetch.mockImplementation((_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))));
    const checked = recovery.checkPrivateSubmissionReceipt(record.requestId); await vi.advanceTimersByTimeAsync(10000); await checked;
  } else {
    const reader = { read: vi.fn().mockResolvedValue({ done: false, value: new Uint8Array(16385) }), cancel: vi.fn().mockResolvedValue() };
    fetch.mockResolvedValue({ ok: true, headers: new Headers(limit === 'header' ? { 'content-length': '16385' } : {}), body: limit === 'stream' ? { getReader: () => reader } : undefined });
    await recovery.checkPrivateSubmissionReceipt(record.requestId);
  }
  expect(stored().records[0]).toMatchObject({ requestId: record.requestId, state: 'pending' });
  expect(recovery.getPrivateRecoverySnapshot().error).toMatch(/could not confirm/);
});

it('refuses corrupt and oversized same-scope envelopes without destroying unresolved evidence', async () => {
  await recovery.ensurePrivateRecovery({ userId: 1 });
  const raw = JSON.stringify({ ...stored(), records: [{ source: 'injected private scientific data' }] });
  localStorage.setItem(recovery.PRIVATE_RECOVERY_STORAGE_KEY, raw);
  const post = vi.fn(); await expect(action('execution', { post })).rejects.toMatchObject({ code: 'PRIVATE_SUBMISSION_STORAGE_UNAVAILABLE' });
  expect(post).not.toHaveBeenCalled(); expect(localStorage.getItem(recovery.PRIVATE_RECOVERY_STORAGE_KEY)).toBe(raw);
  await recovery.clearPrivateRecovery(); await recovery.ensurePrivateRecovery({ userId: 1 });
  localStorage.setItem(recovery.PRIVATE_RECOVERY_STORAGE_KEY, 'x'.repeat(40000));
  await expect(action('execution', { post })).rejects.toMatchObject({ code: 'PRIVATE_SUBMISSION_STORAGE_UNAVAILABLE' });
});

it('evicts only confirmed unselected terminal receipts at the 24-record cap', async () => {
  for (let index = 0; index < 26; index += 1) await action('execution');
  expect(stored().records).toHaveLength(24); expect(localStorage.getItem(recovery.PRIVATE_RECOVERY_STORAGE_KEY).length).toBeLessThan(32768);
  const other = await peer(); const post = vi.fn();
  await expect(action('execution', { helper: other, projectId: 'proj_other', post })).rejects.toThrow('saved private R request limit');
  expect(post).not.toHaveBeenCalled(); expect(stored().records).toHaveLength(24);
});

it('rejects UUID reuse and keeps unrelated workspaces available', async () => {
  await lose(); const record = stored().records[0]; const post = vi.fn();
  await expect(action('execution', { workspaceId: 'workspace_two', input: { requestId: record.requestId }, post })).rejects.toThrow('earlier private R');
  expect(post).not.toHaveBeenCalled();
  await action('execution', { workspaceId: 'workspace_two', kernelId: replacementKernelId,
    post: async body => ({ submission: receipt(stored().records.find(item => item.requestId === body.requestId), { kernelId: replacementKernelId }) }) });
  expect(stored().records).toHaveLength(2);
});

it('clears both stores on logout and ignores delayed scientific replies', async () => {
  const began = deferred(); const finish = deferred(); let record;
  const posted = action('execution', { post: () => { record = stored().records[0]; began.resolve(); return finish.promise; } });
  const rejected = expect(posted).rejects.toMatchObject({ code: 'PRIVATE_SUBMISSION_UNCONFIRMED' });
  await began.promise; await common.clearSubmissionRecovery(); finish.resolve({ submission: receipt(record) }); await rejected;
  expect(recovery.getPrivateRecoverySnapshot().scope).toBeNull(); expect(stored()).toBeNull();
  expect(localStorage.getItem(common.RECOVERY_STORAGE_KEY)).toBeNull();
});

it.each([401, 403])('coherently clears private and scientific locators on non-JSON HTTP %i', async status => {
  await lose('execution'); await lose('execution', { projectId: 'proj_two' });
  await common.submitWithRecovery({ projectId: 'proj_two', submit: async () => { throw new TypeError('Lost'); } }).catch(() => {});
  const first = stored().records[0]; fetch.mockResolvedValue(denied(status)); await recovery.checkPrivateSubmissionReceipt(first.requestId);
  if (status === 401) { expect(stored()).toBeNull(); expect(recovery.getPrivateRecoverySnapshot().scope).toBeNull(); }
  else {
    expect(stored().records).toEqual([expect.objectContaining({ projectId: 'proj_two', state: 'pending' })]);
    expect(JSON.parse(localStorage.getItem(common.RECOVERY_STORAGE_KEY)).records).toHaveLength(1);
  }
});

it('quarantines all private observations if project access removal cannot be persisted', async () => {
  await action(); await lose('execution', { projectId: 'proj_two' }); const raw = localStorage.getItem(recovery.PRIVATE_RECOVERY_STORAGE_KEY);
  const record = stored().records[0]; fetch.mockResolvedValue(denied(403));
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Full', 'QuotaExceededError'); });
  await recovery.checkPrivateSubmissionReceipt(record.requestId);
  expect(recovery.getPrivateRecoverySnapshot().scope).toBeNull(); expect(common.getSubmissionRecoverySnapshot().scope).toBeNull();
  expect(localStorage.getItem(recovery.PRIVATE_RECOVERY_STORAGE_KEY)).toBe(raw);
  const post = vi.fn(); await expect(action('execution', { projectId: 'proj_two', post })).rejects.toMatchObject({ code: 'SUBMISSION_STORAGE_UNAVAILABLE' });
  expect(post).not.toHaveBeenCalled();
});

it('fences old-account and changed-installation replies and requires the expected owner on repeated clicks', async () => {
  await lose(); const record = stored().records[0]; const waiting = deferred();
  fetch.mockImplementation(async url => url === '/api/auth/installation' ? response(installation) : waiting.promise);
  const checked = recovery.checkPrivateSubmissionReceipt(record.requestId);
  fetch.mockResolvedValue(response({ ...installation, userId: 2 }));
  for (let index = 0; index < 2; index += 1) await expect(action()).rejects.toThrow('authenticated server identity');
  waiting.resolve(response(receipt(record))); await checked; expect(stored()).toBeNull();
  fetch.mockResolvedValue(response({ ...installation, installationId: `svc_${'b'.repeat(32)}` }));
  await recovery.ensurePrivateRecovery({ userId: 1, force: true }); expect(stored().records).toEqual([]);
});

it('removes only exact discarded kernel-generation locators and never a kernel-less pending start', async () => {
  await lose('start'); await lose('execution', { workspaceId: 'workspace_two' });
  const records = stored().records; expect(records).toHaveLength(2);
  await recovery.clearKernelPrivateRecovery('proj_one', kernelId, generation);
  expect(stored().records).toEqual([expect.objectContaining({ kind: 'start', requestId: records[0].requestId })]);
});

it('blocks a competing window and preserves its new pending UUID when a delayed old GET completes', async () => {
  await action(); const old = stored().records[0]; const other = await peer();
  fetch.mockImplementation(async url => response(url === '/api/auth/installation' ? installation : receipt(old)));
  await other.reconcilePrivateSubmissions();
  const began = deferred(); const finish = deferred();
  fetch.mockImplementation(async url => url === '/api/auth/installation' ? response(installation) : (began.resolve(), finish.promise));
  const checked = recovery.checkPrivateSubmissionReceipt(old.requestId); await began.promise;
  await lose('execution', { helper: other }); const next = stored().records[1];
  finish.resolve(response(receipt(old))); await checked; storageChanged();
  expect(stored().records[1]).toMatchObject({ requestId: next.requestId, state: 'pending' });
  const post = vi.fn(); await expect(action('execution', { post })).rejects.toThrow('earlier private R'); expect(post).not.toHaveBeenCalled();
});

it('does not resurrect a forgotten record or selection from a delayed peer receipt', async () => {
  await lose(); const record = stored().records[0]; const other = await peer();
  const began = deferred(); const finish = deferred(); fetch.mockImplementation(() => (began.resolve(), finish.promise));
  const checked = recovery.checkPrivateSubmissionReceipt(record.requestId); await began.promise;
  await other.forgetPrivateSubmission(record.requestId); finish.resolve(response(receipt(record))); await checked;
  expect(stored().records).toEqual([]); expect(stored().selection).toBeNull();
});

it('requires Web Locks and never dispatches while coordination is unavailable', async () => {
  const locks = navigator.locks;
  Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
  try { const post = vi.fn(); await expect(action('execution', { post })).rejects.toMatchObject({ code: 'SUBMISSION_COORDINATION_UNAVAILABLE' }); expect(post).not.toHaveBeenCalled(); }
  finally { Object.defineProperty(navigator, 'locks', { configurable: true, value: locks }); }
});

it('recovers a lost second command as the selected exact execution after an earlier selected command', async () => {
  await action('execution'); const first = stored().records[0];
  expect(stored().selection).toMatchObject({ requestId: first.requestId, executionId });
  await lose('execution', { input: { source: 'second_value <- 2' } }); const second = stored().records[1];
  expect(stored().selection).toMatchObject({ requestId: second.requestId, kernelId });
  expect(stored().selection).not.toHaveProperty('executionId');
  const other = await peer(); const secondExecutionId = `pex_${'9'.repeat(24)}`;
  fetch.mockImplementation(async url => response(url === '/api/auth/installation' ? installation
    : url.endsWith(second.requestId) ? receipt(second, { executionId: secondExecutionId, order: 2 }) : receipt(first)));
  await other.reconcilePrivateSubmissions();
  expect(stored().selection).toMatchObject({ requestId: second.requestId, executionId: secondExecutionId, kernelId });
});

it('clears the previous selection before a new start and recovers its exact new kernel', async () => {
  await action('execution'); expect(stored().selection.kernelId).toBe(kernelId);
  await lose('start'); expect(stored().selection).toBeNull(); const record = stored().records[1];
  fetch.mockResolvedValue(response(receipt(record, { kernelId: replacementKernelId })));
  await recovery.checkPrivateSubmissionReceipt(record.requestId);
  expect(stored().selection).toMatchObject({ requestId: record.requestId, kernelId: replacementKernelId });
});

it('keeps a peer selection when an inspection selection write waited behind another window', async () => {
  await action(); const expectedSelection = stored().selection; const other = await peer();
  const queued = deferred(); const release = deferred(); const request = navigator.locks.request.bind(navigator.locks); let count = 0; let drained;
  vi.spyOn(navigator.locks, 'request').mockImplementation((...args) => {
    count += 1; if (count === 1) { queued.resolve(); drained = release.promise.then(() => request(...args)); return drained; }
    return request(...args);
  });
  const pending = recovery.selectPrivateRecoveredSession({ projectId: 'proj_one', workspaceId: 'workspace_one', kernelId }, { expectedSelection });
  await queued.promise;
  const peerSelection = { projectId: 'proj_one', workspaceId: 'workspace_one', kernelId: replacementKernelId };
  await other.selectPrivateRecoveredSession(peerSelection);
  release.resolve(); await drained; await expect(pending).resolves.toBeNull();
  expect(stored().selection).toEqual(peerSelection);
});

it('admits only one simultaneous mutation across two windows before either acknowledgement', async () => {
  await recovery.ensurePrivateRecovery({ userId: 1 }); const other = await peer();
  const began = deferred(); const finish = deferred(); let record;
  const first = action('execution', { post: () => { record = stored().records[0]; began.resolve(); return finish.promise; } });
  await began.promise;
  const post = vi.fn(); await expect(action('publication', { helper: other, post })).rejects.toThrow('earlier private R');
  expect(post).not.toHaveBeenCalled(); expect(stored().records).toHaveLength(1);
  finish.resolve({ submission: receipt(record) }); await first;
});

it('does not demote a newly confirmed terminal POST with an earlier running GET response', async () => {
  const began = deferred(); const finishPost = deferred(); let record;
  const posted = action('execution', { post: () => { record = stored().records[0]; began.resolve(); return finishPost.promise; } });
  await began.promise;
  const reading = deferred(); const finishGet = deferred(); fetch.mockImplementation(() => (reading.resolve(), finishGet.promise));
  const checked = recovery.checkPrivateSubmissionReceipt(record.requestId); await reading.promise;
  finishPost.resolve({ submission: receipt(record) }); await posted;
  finishGet.resolve(response(receipt(record, { status: 'running', completionKnown: false }))); await checked;
  expect(recovery.getPrivateRecoverySnapshot().records[0]).toMatchObject({ status: 'completed', completionKnown: true, confirmed: true });
});

it('permits an explicit restart of an unresolved exact generation and keeps original terminal evidence', async () => {
  await action('execution'); const completed = stored().records[0];
  await lose('publication'); const pending = stored().records[1];
  await action('restart');
  await recovery.clearKernelPrivateRecovery('proj_one', kernelId, generation);
  expect(stored().records).toContainEqual(expect.objectContaining({ requestId: completed.requestId, state: 'accepted' }));
  expect(stored().records.some(item => item.requestId === pending.requestId)).toBe(false);
  expect(stored().records.some(item => item.kind === 'restart')).toBe(true);
});

it('preserves an unresolved restart identity when the original kernel memory has been discarded', async () => {
  await lose('execution'); const command = stored().records[0];
  await lose('restart'); const restart = stored().records[1];
  await recovery.clearKernelPrivateRecovery('proj_one', kernelId, generation);
  expect(stored().records).toEqual([expect.objectContaining({ kind: 'restart', requestId: restart.requestId, state: 'pending' })]);
  expect(stored().records.some(item => item.requestId === command.requestId)).toBe(false);
  expect(stored().selection).toMatchObject({ requestId: restart.requestId, kernelId });
  const other = await peer(); const post = vi.fn();
  await expect(action('restart', { helper: other, post })).rejects.toThrow('earlier private R');
  expect(post).not.toHaveBeenCalled();
  fetch.mockImplementation(async url => response(url === '/api/auth/installation' ? installation : receipt(restart)));
  await other.reconcilePrivateSubmissions();
  expect(stored().selection).toMatchObject({ requestId: restart.requestId, kernelId: replacementKernelId });
});

it('keeps an accepted starting restart receipt after an exact old-kernel discard', async () => {
  await action('restart', { post: async () => ({ submission: receipt(stored().records[0], { status: 'starting', completionKnown: false }) }) });
  const restart = stored().records[0];
  await recovery.clearKernelPrivateRecovery('proj_one', kernelId, generation);
  expect(stored().records).toEqual([expect.objectContaining({ kind: 'restart', requestId: restart.requestId, state: 'accepted', status: 'starting', completionKnown: false })]);
  expect(stored().selection.requestId).toBe(restart.requestId);
});

it('preserves a newer peer pending selection when an old POST acknowledgement arrives late', async () => {
  const began = deferred(); const finish = deferred(); let old;
  const first = action('execution', { post: () => { old = stored().records[0]; began.resolve(); return finish.promise; } });
  await began.promise; const other = await peer();
  fetch.mockImplementation(async url => response(url === '/api/auth/installation' ? installation : receipt(old)));
  await other.reconcilePrivateSubmissions();
  await lose('execution', { helper: other, input: { source: 'newer_value <- 2' } }); const newer = stored().records[1];
  finish.resolve({ submission: receipt(old) }); await first;
  expect(stored().selection).toMatchObject({ requestId: newer.requestId, kernelId });
  expect(stored().records[1]).toMatchObject({ requestId: newer.requestId, state: 'pending' });
});

it('updates only the selected exact restart when its replacement becomes confirmed', async () => {
  await action('restart', { post: async () => ({ submission: receipt(stored().records[0], { status: 'starting', completionKnown: false, replacementKernelId: null }) }) });
  const record = stored().records[0]; expect(stored().selection.kernelId).toBe(kernelId);
  fetch.mockResolvedValue(response(receipt(record))); await recovery.checkPrivateSubmissionReceipt(record.requestId);
  expect(stored().selection).toMatchObject({ requestId: record.requestId, kernelId: replacementKernelId });
});

it('requires proof that both companion and canonical project data were removed before releasing quarantine', async () => {
  await action(); await lose('execution', { projectId: 'proj_two' });
  const deniedRecord = stored().records[0]; const other = await peer();
  fetch.mockImplementation(async url => url === '/api/auth/installation' ? response(installation) : denied(403));
  const writes = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Full', 'QuotaExceededError'); });
  await recovery.checkPrivateSubmissionReceipt(deniedRecord.requestId); writes.mockRestore();
  expect(recovery.getPrivateRecoverySnapshot().scope).toBeNull();
  // A renderer lacking the companion hook cannot manufacture sufficient proof
  // by changing only the older canonical envelope's access generation.
  const canonical = JSON.parse(localStorage.getItem(common.RECOVERY_STORAGE_KEY));
  canonical.accessGeneration = crypto.randomUUID(); localStorage.setItem(common.RECOVERY_STORAGE_KEY, JSON.stringify(canonical));
  window.dispatchEvent(new StorageEvent('storage', { key: common.RECOVERY_STORAGE_KEY }));
  const post = vi.fn(); await expect(action('execution', { projectId: 'proj_two', post })).rejects.toMatchObject({ code: 'SUBMISSION_STORAGE_UNAVAILABLE' });
  expect(post).not.toHaveBeenCalled();
  await other.clearProjectPrivateRecovery('proj_one');
  window.dispatchEvent(new StorageEvent('storage', { key: common.RECOVERY_STORAGE_KEY }));
  await vi.waitFor(() => expect(common.getSubmissionRecoverySnapshot().scope?.userId).toBe(1));
  await recovery.ensurePrivateRecovery({ userId: 1 });
  expect(stored().records).toEqual([expect.objectContaining({ projectId: 'proj_two', state: 'pending' })]);
});

it('fences a queued admission when the target disconnects before its lock executes', async () => {
  let notify; const target = { id: 'lab', serviceIdentity: 'lab-partition', status: 'connected', sshTunnel: { state: 'connected' } };
  window.desktopShell = { getCurrentTarget: async () => target, onTargetStatus: listener => { notify = listener; return () => {}; } };
  const stop = subscribeExecutionTarget(() => {});
  try {
    await recovery.ensurePrivateRecovery({ userId: 1 });
    const queued = deferred(); const release = deferred(); const request = navigator.locks.request.bind(navigator.locks); let count = 0; let drained;
    vi.spyOn(navigator.locks, 'request').mockImplementation((...args) => {
      count += 1; if (count === 3) { queued.resolve(); drained = release.promise.then(() => request(...args)); return drained; }
      return request(...args);
    });
    const post = vi.fn(); const posted = action('execution', { post });
    const rejected = expect(posted).rejects.toMatchObject({ code: 'TARGET_EXECUTION_UNCONFIRMED' });
    await queued.promise; notify({ ...target, sshTunnel: { state: 'disconnected' } }); await rejected;
    release.resolve(); await drained.catch(() => {});
    expect(post).not.toHaveBeenCalled(); expect(stored().records).toEqual([]);
  } finally { stop(); }
});

it('does not dispatch to a replacement target after source hashing began on the original target', async () => {
  let notify; const target = { id: 'lab', serviceIdentity: 'lab-partition', status: 'connected', sshTunnel: { state: 'connected' } };
  window.desktopShell = { getCurrentTarget: async () => target, onTargetStatus: listener => { notify = listener; return () => {}; } };
  const stop = subscribeExecutionTarget(() => {});
  try {
    await recovery.ensurePrivateRecovery({ userId: 1 });
    const hashing = deferred(); const finish = deferred(); const digest = crypto.subtle.digest.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, 'digest').mockImplementation((...args) => { hashing.resolve(); return finish.promise.then(() => digest(...args)); });
    const post = vi.fn(); const posted = action('execution', { post });
    const rejected = expect(posted).rejects.toMatchObject({ code: 'TARGET_EXECUTION_UNCONFIRMED' });
    await hashing.promise; notify({ ...target, serviceIdentity: 'replacement-lab-partition' }); await rejected;
    finish.resolve(); await new Promise(resolve => setTimeout(resolve, 10));
    expect(post).not.toHaveBeenCalled(); expect(stored().records).toEqual([]);
  } finally { stop(); }
});
