import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import { readSharedWorkspaceIdentity } from './sharedWorkspaceIdentity';
import { subscribeExecutionTarget } from '../runtime/executionTarget';

vi.mock('../api', () => ({ apiUrl: value => value }));
const serviceId = 'svc_' + 'a'.repeat(32), current = () => ({ schema: 'traceomics.installation.v1', installationId: serviceId, userId: 7 });
const response = (value = current(), headers = {}) => new Response(typeof value === 'string' || value instanceof Uint8Array ? value : JSON.stringify(value),
  { headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });
const invalid = { code: 'INVALID_SHARED_WORKSPACE_IDENTITY' };
const target = { id: 'lab', serviceIdentity: 'native-profile-identity', status: 'connected', sshTunnel: { state: 'connected' } };
const gate = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
function native(initial = target) {
  let notify;
  window.desktopShell = { getCurrentTarget: vi.fn(async () => initial), onTargetStatus: vi.fn(listener => { notify = listener; return vi.fn(); }) };
  return value => notify(value);
}
beforeEach(() => { vi.stubGlobal('fetch', vi.fn(async () => response())); });
afterEach(() => { delete window.desktopShell; vi.useRealTimers(); vi.unstubAllGlobals(); });

it('performs only a no-store cookie-authenticated bounded installation GET and returns a separate scientific service identity', async () => {
  expect(await readSharedWorkspaceIdentity(7)).toEqual({ installationId: serviceId, userId: 7 });
  expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/auth/installation', expect.objectContaining({ method: 'GET', credentials: 'include', cache: 'no-store', signal: expect.any(AbortSignal), headers: { Accept: 'application/json' } }));
  const [, options] = fetch.mock.calls[0]; expect(options.body).toBeUndefined(); expect(options.headers.Authorization).toBeUndefined();
});
it('accepts reordered flat fields/JSON whitespace but no guessed defaults', async () => {
  fetch.mockResolvedValue(response(' \n { "userId" : 7, "installationId" : "' + serviceId + '", "schema":"traceomics.installation.v1" }\r\n'));
  expect(await readSharedWorkspaceIdentity(7)).toEqual({ installationId: serviceId, userId: 7 });
});
it.each([
  ['different account', value => { value.userId = 17; }],
  ['missing account', value => { delete value.userId; }],
  ['string account', value => { value.userId = '7'; }],
  ['unsafe account', value => { value.userId = Number.MAX_SAFE_INTEGER + 1; }],
  ['zero account', value => { value.userId = 0; }],
  ['wrong schema', value => { value.schema = 'traceomics.installation.v2'; }],
  ['wrong service', value => { value.installationId = 'https://outside.example.org'; }],
  ['connection profile instead of service', value => { value.installationId = 'native-profile-identity'; }],
  ['uppercase service', value => { value.installationId = 'svc_' + 'A'.repeat(32); }],
  ['private source metadata', value => { value.storagePath = '/private/source'; }],
  ['nested identity', value => { value.installationId = { id: serviceId }; }],
])('rejects a closed-identity mismatch without reading any project: %s', async (_name, change) => {
  const value = current(); change(value); fetch.mockResolvedValue(response(value));
  await expect(readSharedWorkspaceIdentity(7)).rejects.toMatchObject(invalid);
  expect(fetch).toHaveBeenCalledTimes(1);
});
it.each([
  '{}', '[]', 'null', 'true', '7', '{"schema":"traceomics.installation.v1"}',
  JSON.stringify(current()).replace('"userId":7', '"userId":7,"userId":17'),
  JSON.stringify(current()).replace('"userId":7', '"userId":7,"user\\u0049d":7'),
  JSON.stringify(current()).replace('"userId":7', '"userId":7.0000000000000001'),
  JSON.stringify(current()).replace('"userId":7', '"userId":7e0'),
  JSON.stringify(current()).replace('"userId":7', '"userId":-0'),
  JSON.stringify(current()).replace('"userId":7', '"userId":07'),
  JSON.stringify(current()) + 'true', '\ufeff' + JSON.stringify(current()), JSON.stringify(current()).slice(0, -1) + ',}',
  JSON.stringify(current()).replace('traceomics.installation.v1', 'traceomics.installation.\ud800'),
  JSON.stringify(current()).replace('"userId":7', '"__proto__":7,"userId":7'),
])('rejects malformed, duplicated or rounded identity tokens: %s', async value => {
  fetch.mockResolvedValue(response(value)); await expect(readSharedWorkspaceIdentity(7)).rejects.toMatchObject(invalid);
});
it.each(['text/html', 'text/plain', 'application/problem+json', 'application/json; charset=iso-8859-1', 'application/json; boundary=x'])('rejects an unexpected response MIME before returning identity: %s', async type => {
  fetch.mockResolvedValue(response(current(), { 'Content-Type': type })); await expect(readSharedWorkspaceIdentity(7)).rejects.toMatchObject(invalid);
});
it.each(['APPLICATION/JSON', 'application/json; charset="UTF-8"'])('accepts the known UTF8 JSON MIME without source-type inference: %s', async type => {
  fetch.mockResolvedValue(response(current(), { 'Content-Type': type })); expect(await readSharedWorkspaceIdentity(7)).toEqual({ installationId: serviceId, userId: 7 });
});
it.each(['-1', 'four', '4097', '90071992547409999999999999999', '1.5', '10'])('rejects an oversized or inconsistent declared body length: %s', async length => {
  fetch.mockResolvedValue(response(current(), { 'Content-Length': length })); await expect(readSharedWorkspaceIdentity(7)).rejects.toMatchObject(invalid);
});
it.each(['gzip', 'br', 'deflate', ' GZip ', 'gzip, br'])('accepts bounded native Fetch-decoded %s without comparing decoded bytes to compressed wire length', async encoding => {
  fetch.mockResolvedValue(response(current(), { 'Content-Encoding': encoding, 'Content-Length': '80' }));
  expect(await readSharedWorkspaceIdentity(7)).toEqual({ installationId: serviceId, userId: 7 });
});
it.each(['identity', ' Identity ', 'IDENTITY'])('keeps exact length checks for normalized %s encoding', async encoding => {
  fetch.mockResolvedValue(response(current(), { 'Content-Encoding': encoding, 'Content-Length': '80' }));
  await expect(readSharedWorkspaceIdentity(7)).rejects.toMatchObject(invalid);
});
it.each(['gzip', 'br'])('retains declared wire-size and decoded-size bounds independently with %s compression', async encoding => {
  fetch.mockResolvedValueOnce(response(current(), { 'Content-Encoding': encoding, 'Content-Length': '4097' }))
    .mockResolvedValueOnce(response(JSON.stringify(current()) + ' '.repeat(4096), { 'Content-Encoding': encoding, 'Content-Length': '80' }));
  await expect(readSharedWorkspaceIdentity(7)).rejects.toMatchObject(invalid);
  await expect(readSharedWorkspaceIdentity(7)).rejects.toMatchObject(invalid);
});
it.each(['scope', 'duplicate keys', 'UTF8'])('keeps closed identity and fatal UTF8 checks on decoded compressed %s', async mismatch => {
  const body = mismatch === 'scope' ? JSON.stringify({ ...current(), userId: 17 })
    : mismatch === 'duplicate keys' ? JSON.stringify(current()).replace('"userId":7', '"userId":7,"userId":17') : new Uint8Array([0xc3, 0x28]);
  fetch.mockResolvedValue(response(body, { 'Content-Encoding': 'gzip', 'Content-Length': '80' }));
  await expect(readSharedWorkspaceIdentity(7)).rejects.toMatchObject(invalid);
});
it('accepts an exact 4096-byte bounded response and rejects one extra streamed byte', async () => {
  const body = JSON.stringify(current()), exact = body + ' '.repeat(4096 - body.length);
  fetch.mockResolvedValueOnce(response(exact, { 'Content-Length': '4096' })).mockResolvedValueOnce(response(exact + ' '));
  expect(await readSharedWorkspaceIdentity(7)).toEqual({ installationId: serviceId, userId: 7 });
  await expect(readSharedWorkspaceIdentity(7)).rejects.toMatchObject(invalid); expect(fetch).toHaveBeenCalledTimes(2);
});
it('fails fatal UTF8 without replacement decoding or publishing a partial identity', async () => {
  fetch.mockResolvedValue(response(new Uint8Array([0xc3, 0x28]))); await expect(readSharedWorkspaceIdentity(7)).rejects.toMatchObject(invalid);
});
it('uses native cross-realm byte facts without invoking a chunk constructor, iterator or slice getter', async () => {
  const bytes = runInNewContext('new Uint8Array(' + JSON.stringify(Array.from(new TextEncoder().encode(JSON.stringify(current())))) + ')');
  const getter = vi.fn(() => { throw new Error('untrusted byte hook'); });
  Object.defineProperties(bytes, { constructor: { get: getter }, slice: { get: getter }, [Symbol.iterator]: { get: getter } });
  let sent = false;
  fetch.mockResolvedValue({ ok: true, headers: new Headers({ 'Content-Type': 'application/json' }), body: { getReader: () => ({
    read: async () => sent ? { done: true } : (sent = true, { done: false, value: bytes }), cancel: vi.fn(async () => {}), releaseLock: vi.fn(),
  }) } });
  expect(await readSharedWorkspaceIdentity(7)).toEqual({ installationId: serviceId, userId: 7 }); expect(getter).not.toHaveBeenCalled();
});
it('stops an oversized stream before reading more chunks and releases its reader', async () => {
  const cancel = vi.fn(async () => {}), releaseLock = vi.fn(), read = vi.fn()
    .mockResolvedValueOnce({ done: false, value: new Uint8Array(2500) }).mockResolvedValueOnce({ done: false, value: new Uint8Array(1700) });
  fetch.mockResolvedValue({ ok: true, headers: new Headers({ 'Content-Type': 'application/json' }), body: { getReader: () => ({ read, cancel, releaseLock }) } });
  await expect(readSharedWorkspaceIdentity(7)).rejects.toMatchObject(invalid);
  expect(read).toHaveBeenCalledTimes(2); expect(cancel).toHaveBeenCalledOnce(); expect(releaseLock).toHaveBeenCalledOnce();
});
it.each([new Uint16Array(8), new DataView(new ArrayBuffer(8)), [123, 125], { byteLength: 3 }])('refuses a non-byte stream view without trusting its length: %s', async value => {
  const cancel = vi.fn(async () => {}), releaseLock = vi.fn();
  fetch.mockResolvedValue({ ok: true, headers: new Headers({ 'Content-Type': 'application/json' }), body: { getReader: () => ({ read: async () => ({ done: false, value }), cancel, releaseLock }) } });
  await expect(readSharedWorkspaceIdentity(7)).rejects.toMatchObject(invalid); expect(cancel).toHaveBeenCalledOnce(); expect(releaseLock).toHaveBeenCalledOnce();
});
it('keeps streamed transport failures safe while still releasing its bounded reader', async () => {
  const cancel = vi.fn(async () => {}), releaseLock = vi.fn();
  fetch.mockResolvedValue({ ok: true, headers: new Headers({ 'Content-Type': 'application/json' }), body: { getReader: () => ({ read: async () => { throw new TypeError('private socket path'); }, cancel, releaseLock }) } });
  const error = await readSharedWorkspaceIdentity(7).catch(value => value);
  expect(error.code).toBe('SHARED_WORKSPACE_UNREACHABLE'); expect(error.message).not.toContain('private socket path');
  expect(cancel).toHaveBeenCalledOnce(); expect(releaseLock).toHaveBeenCalledOnce();
});
it.each([false, true])('checks a bounded arrayBuffer fallback without skipping the current-user assertion (oversized: %s)', async oversized => {
  const value = new TextEncoder().encode(oversized ? ' '.repeat(4097) : JSON.stringify(current()));
  fetch.mockResolvedValue({ ok: true, headers: new Headers({ 'Content-Type': 'application/json' }), arrayBuffer: async () => value.buffer });
  if (oversized) await expect(readSharedWorkspaceIdentity(7)).rejects.toMatchObject(invalid);
  else expect(await readSharedWorkspaceIdentity(7)).toEqual({ installationId: serviceId, userId: 7 });
});
it('does not let cleanup rejection replace an authoritative MIME or HTTP failure', async () => {
  const body = { cancel: vi.fn(async () => { throw new Error('private cleanup'); }) };
  fetch.mockResolvedValueOnce({ ok: true, headers: new Headers({ 'Content-Type': 'text/html' }), body })
    .mockResolvedValueOnce({ ok: false, status: 401, body });
  await expect(readSharedWorkspaceIdentity(7)).rejects.toMatchObject(invalid);
  await expect(readSharedWorkspaceIdentity(7)).rejects.toMatchObject({ code: 'SHARED_WORKSPACE_AUTH_REQUIRED', status: 401 });
});
it.each([401, 403, 404, 429, 500, 503])('preserves safe HTTP status %i without exposing its body or retrying', async status => {
  fetch.mockResolvedValue(new Response('private/source/path and database credentials', { status }));
  const error = await readSharedWorkspaceIdentity(7).catch(value => value);
  expect(error.status).toBe(status); expect(error.code).toBe(status === 401 ? 'SHARED_WORKSPACE_AUTH_REQUIRED' : 'SHARED_WORKSPACE_UNAVAILABLE');
  expect(error.message).not.toMatch(/private|database|credentials/); expect(fetch).toHaveBeenCalledTimes(1);
});
it('distinguishes a workspace outage from sign-out without retaining raw network errors', async () => {
  fetch.mockRejectedValue(new TypeError('private tunnel host or socket')); const error = await readSharedWorkspaceIdentity(7).catch(value => value);
  expect(error).toMatchObject({ code: 'SHARED_WORKSPACE_UNREACHABLE' }); expect(error.status).toBeUndefined(); expect(error.message).not.toMatch(/private|socket/);
});
it('aborts its bounded identity observation after ten seconds without automatic retry or logout', async () => {
  vi.useFakeTimers(); fetch.mockImplementation((_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('fetch aborted', 'AbortError')))));
  const pending = readSharedWorkspaceIdentity(7), check = expect(pending).rejects.toMatchObject({ code: 'SHARED_WORKSPACE_UNREACHABLE' });
  await vi.advanceTimersByTimeAsync(10_001); await check; expect(fetch).toHaveBeenCalledTimes(1);
});
it.each([undefined, null, '7', 0, -0, -1, 7.1, Number.MAX_SAFE_INTEGER + 1, {}, []])('requires an exact positive expected cookie user ID before any request: %s', async value => {
  await expect(readSharedWorkspaceIdentity(value)).rejects.toMatchObject(invalid); expect(fetch).not.toHaveBeenCalled();
});
it('does not invoke getters or conversions in malformed input/options', async () => {
  const getter = vi.fn(() => { throw new Error('private input getter'); }), accessor = {};
  Object.defineProperty(accessor, 'signal', { enumerable: true, get: getter });
  const hidden = {}; Object.defineProperty(hidden, 'signal', { value: undefined });
  const values = [accessor, hidden, { arbitraryHost: 'https://outside' }, { signal: { get aborted() { return getter(); } } }, Object.create({ signal: undefined }), []];
  for (const input of values) await expect(readSharedWorkspaceIdentity(7, input)).rejects.toMatchObject(invalid);
  await expect(readSharedWorkspaceIdentity({ valueOf: getter })).rejects.toMatchObject(invalid);
  expect(fetch).not.toHaveBeenCalled(); expect(getter).not.toHaveBeenCalled();
});
it('uses native abort subscriptions without evaluating caller-owned signal method getters', async () => {
  const controller = new AbortController(), getter = vi.fn(() => { throw new Error('private signal hook'); });
  Object.defineProperties(controller.signal, { addEventListener: { get: getter }, removeEventListener: { get: getter }, aborted: { get: getter } });
  expect(await readSharedWorkspaceIdentity(7, { signal: controller.signal })).toEqual({ installationId: serviceId, userId: 7 });
  expect(getter).not.toHaveBeenCalled();
});
it('cancels a caller-aborted observation before or during a network request', async () => {
  const before = new AbortController(); before.abort(); await expect(readSharedWorkspaceIdentity(7, { signal: before.signal })).rejects.toMatchObject({ name: 'AbortError' }); expect(fetch).not.toHaveBeenCalled();
  const during = new AbortController(), began = gate(); fetch.mockImplementation((_url, options) => { began.release(); return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('fetch aborted', 'AbortError')))); });
  const pending = readSharedWorkspaceIdentity(7, { signal: during.signal }); await began.promise; during.abort(); await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
});

it.each([null, { ...target, status: 'disconnected' }])('does not dispatch against an unconfirmed/disconnected native workspace: %s', async value => {
  native(value); await expect(readSharedWorkspaceIdentity(7)).rejects.toMatchObject({ code: value ? 'TARGET_DISCONNECTED' : 'TARGET_UNAVAILABLE' }); expect(fetch).not.toHaveBeenCalled();
});
it('keeps backend service identity distinct from native profile identity and never connects a host from the response', async () => {
  native(); expect(await readSharedWorkspaceIdentity(7)).toEqual({ installationId: serviceId, userId: 7 });
  expect(Object.keys(window.desktopShell).sort()).toEqual(['getCurrentTarget', 'onTargetStatus']); expect(fetch.mock.calls[0][0]).toBe('/api/auth/installation');
});
it('captures options before native confirmation and does not adopt a later caller signal replacement', async () => {
  const first = new AbortController(), second = new AbortController(), ready = gate(); second.abort(); native(); window.desktopShell.getCurrentTarget.mockImplementation(() => ready.promise);
  const options = { signal: first.signal }, pending = readSharedWorkspaceIdentity(7, options); options.signal = second.signal; ready.release(target);
  expect(await pending).toEqual({ installationId: serviceId, userId: 7 });
});
it('does not dispatch when its original caller cancels while native target confirmation is held', async () => {
  const controller = new AbortController(), ready = gate(); native(); window.desktopShell.getCurrentTarget.mockImplementation(() => ready.promise);
  const pending = readSharedWorkspaceIdentity(7, { signal: controller.signal }); controller.abort(); ready.release(target);
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' }); expect(fetch).not.toHaveBeenCalled();
});
it.each(['disconnect', 'switch', 'reconnect'])('fences a held original identity response after native %s without reissuing it', async change => {
  const notify = native(), reached = gate(), finish = gate(), keep = subscribeExecutionTarget(() => {});
  fetch.mockImplementation(() => { reached.release(); return finish.promise; }); const pending = readSharedWorkspaceIdentity(7); await reached.promise;
  if (change === 'switch') notify({ ...target, serviceIdentity: 'different-workspace' });
  else { notify({ ...target, status: 'disconnected' }); if (change === 'reconnect') notify(target); }
  const checked = expect(pending).rejects.toMatchObject({ code: 'TARGET_CHANGED' }); finish.release(response()); await checked; keep();
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('does not share account assertions across simultaneous current-workspace observations', async () => {
  const first = gate(), second = gate(); fetch.mockResolvedValueOnce(first.promise).mockResolvedValueOnce(second.promise);
  const alice = readSharedWorkspaceIdentity(7), bob = readSharedWorkspaceIdentity(17);
  first.release(response({ ...current(), userId: 17 })); second.release(response({ ...current(), userId: 17 }));
  await expect(alice).rejects.toMatchObject(invalid); expect(await bob).toEqual({ installationId: serviceId, userId: 17 });
  expect(fetch).toHaveBeenCalledTimes(2);
});
it('does not accept a held body after its original caller cancels', async () => {
  const controller = new AbortController(), began = gate(), finish = gate(); let first = true;
  const bytes = new TextEncoder().encode(JSON.stringify(current())), releaseLock = vi.fn();
  fetch.mockResolvedValue({ ok: true, headers: new Headers({ 'Content-Type': 'application/json' }), body: { getReader: () => ({
    read: async () => { if (first) { first = false; began.release(); await finish.promise; return { done: false, value: bytes }; } return { done: true }; },
    cancel: vi.fn(async () => {}), releaseLock,
  }) } });
  const pending = readSharedWorkspaceIdentity(7, { signal: controller.signal }); await began.promise; controller.abort(); finish.release();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' }); expect(releaseLock).toHaveBeenCalledOnce();
});
