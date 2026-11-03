import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash, webcrypto } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { loadPublicExampleManifest, readPublicExampleFinding, readPublicExampleSource } from './publicSavedExampleApi';

const directory = path.join(process.cwd(), 'public/examples/qc-retention/v1');
const assets = Object.fromEntries(['manifest.json', 'table.json', 'figure.png', 'counts.csv'].map(file => [file, readFileSync(path.join(directory, file))]));
const manifest = () => JSON.parse(assets['manifest.json'].toString('utf8'));
const types = { 'manifest.json': 'application/json', 'table.json': 'application/json', 'figure.png': 'image/png', 'counts.csv': 'text/csv' };
const invalid = { code: 'INVALID_PUBLIC_SAVED_EXAMPLE' }, unavailable = { code: 'PUBLIC_SAVED_EXAMPLE_UNAVAILABLE' };
const sourceSha = '9a99e0f8ad73055902fcb3ef9c75d46cf51a70cde206ee6b17488b4bd61e8285';
const sourceText = 'sample,input_cells,retained_cells\nSample A,1000,850\nSample B,1200,900\nSample C,800,720\n';
const gate = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
function response(file, { body = assets[file], headers = {}, status = 200 } = {}) {
  return new Response(body, { status, headers: { 'Content-Type': types[file], 'Content-Length': String(body.byteLength ?? new TextEncoder().encode(body).byteLength), ...headers } });
}
function actual() { fetch.mockImplementation(async address => response(new URL(address).pathname.split('/').at(-1))); }
const table = () => readPublicExampleFinding(manifest(), 'retention-table');
function holdDigest() {
  const held = gate(), entered = gate(); let first = true;
  vi.stubGlobal('crypto', { subtle: { digest: vi.fn(async (algorithm, bytes) => {
    if (first) { first = false; entered.release(); await held.promise; }
    return webcrypto.subtle.digest(algorithm, bytes);
  }) } });
  return { held, entered };
}
beforeEach(() => { window.history.replaceState(null, '', '/'); vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('fetch', vi.fn()); actual(); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); window.history.replaceState(null, '', '/'); });

it('loads only the pinned public manifest, then only deliberately selected findings and optional public CSV', async () => {
  const value = await loadPublicExampleManifest();
  expect(value).toEqual(manifest()); expect(value).not.toBe(manifest()); expect(fetch).toHaveBeenCalledTimes(1);
  expect(value.source.sha256).toBe(sourceSha); expect(value.provenance).toMatchObject({ synthetic: true, kind: 'authored-illustration', license: 'CC0-1.0' });
  const result = await readPublicExampleFinding(value, 'retention-table');
  expect(result).toEqual({ type: 'application/json', preview: { columns: ['Sample', 'Input cells', 'Retained cells'], family: 'table', hasMore: false,
    limit: 3, offset: 0, rows: [['Sample A', 1000, 850], ['Sample B', 1200, 900], ['Sample C', 800, 720]], scannedRows: 3, truncated: false } });
  const figure = await readPublicExampleFinding(value, 'retention-figure');
  expect(figure.preview).toEqual({ family: 'image', width: 960, height: 600 }); expect(figure.type).toBe('image/png');
  expect(figure.imageBytes.byteLength).toBe(44517);
  expect(createHash('sha256').update(figure.imageBytes).digest('hex')).toBe('be4e96cc6f4b422c9d2650d0fdc1a2293c913df6ccde8325ed9c3316801d0fd6');
  expect(fetch.mock.calls.map(([address]) => new URL(address).pathname)).toEqual(['/examples/qc-retention/v1/manifest.json', '/examples/qc-retention/v1/table.json', '/examples/qc-retention/v1/figure.png']);
  expect(await readPublicExampleSource(value)).toEqual({ text: sourceText, type: 'text/csv', sha256: sourceSha, bytes: 87 });
  expect(fetch).toHaveBeenCalledTimes(4);
});
it('uses fixed same-origin credential-free static GETs without a private API, request body, auth header or compute target', async () => {
  window.desktopShell = { getCurrentTarget: vi.fn(() => { throw new Error('Private target must not be consulted'); }) };
  try {
    const value = await loadPublicExampleManifest(); await readPublicExampleFinding(value, 'retention-figure'); await readPublicExampleSource(value);
    for (const [address, options] of fetch.mock.calls) {
      expect(new URL(address).origin).toBe(location.origin); expect(new URL(address).search).toBe(''); expect(new URL(address).hash).toBe('');
      expect(options).toEqual({ method: 'GET', credentials: 'omit', mode: 'same-origin', redirect: 'error', cache: 'default', referrerPolicy: 'no-referrer', signal: expect.any(AbortSignal), headers: { Accept: types[new URL(address).pathname.split('/').at(-1)] } });
    }
    expect(window.desktopShell.getCurrentTarget).not.toHaveBeenCalled();
  } finally { delete window.desktopShell; }
});
it.each(['/lab/trace/', '/lab/trace/index.html'])('preserves the served deployment directory at %s without copying URL query/hash into static requests', async current => {
  window.history.replaceState(null, '', current + '?private=discarded#/shared-snapshots/invalid'); await loadPublicExampleManifest();
  expect(fetch.mock.calls[0][0]).toBe(location.origin + '/lab/trace/examples/qc-retention/v1/manifest.json');
});
it('captures the deployment base and exact manifest before held hashing rather than following later navigation or mutation', async () => {
  window.history.replaceState(null, '', '/first/index.html'); const value = manifest(), { held, entered } = holdDigest();
  const result = readPublicExampleFinding(value, 'retention-table'); await entered.promise;
  value.findings[0].asset.file = 'https://private.example/steal'; value.title = 'A different example';
  window.history.replaceState(null, '', '/later/index.html'); held.release();
  expect((await result).preview.rows[0]).toEqual(['Sample A', 1000, 850]);
  expect(fetch.mock.calls[0][0]).toBe(location.origin + '/first/examples/qc-retention/v1/table.json');
});
it('does not read, write or grant authority from private storage', async () => {
  const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Private storage unavailable'); });
  const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Private storage unavailable'); });
  const value = await loadPublicExampleManifest(); await readPublicExampleFinding(value, 'retention-table');
  expect(get).not.toHaveBeenCalled(); expect(set).not.toHaveBeenCalled();
});

it.each([
  ['question', value => { value.question = 'Changed after manifest verification'; }],
  ['caption', value => { value.findings[0].caption = 'An unpinned caption'; }],
  ['source checksum', value => { value.source.sha256 = 'a'.repeat(64); }],
  ['payload checksum', value => { value.findings[0].asset.sha256 = 'a'.repeat(64); }],
  ['view checksum', value => { value.findings[0].viewSha256 = 'a'.repeat(64); }],
  ['future version', value => { value.version = 2; }],
  ['remote asset', value => { value.findings[0].asset.file = 'https://outside.example/table.json'; }],
  ['encoded path', value => { value.source.file = '%2e%2e/private.csv'; }],
  ['duplicate finding', value => { value.findings[1] = value.findings[0]; }],
  ['reordered findings', value => { value.findings.reverse(); }],
  ['project authority', value => { value.projectId = 'proj_' + 'a'.repeat(24); }],
])('independently refuses a supplied manifest with changed %s before any finding/source request', async (_name, change) => {
  const value = manifest(); change(value);
  await expect(readPublicExampleFinding(value, 'retention-table')).rejects.toMatchObject(invalid);
  await expect(readPublicExampleSource(value)).rejects.toMatchObject(invalid); expect(fetch).not.toHaveBeenCalled();
});
it.each(['retention-table?source=private', 'retention-source', 'retention-figure/../table.json', 'retention-%74able', '', null, { toString() { throw new Error('Do not coerce'); } }].map((id, index) => [index, id]))('rejects unknown finding selection %i without fetching any fallback', async (_index, id) => {
  await expect(readPublicExampleFinding(manifest(), id)).rejects.toMatchObject(invalid); expect(fetch).not.toHaveBeenCalled();
});
it.each(['manifest getter', 'nested getter', 'hidden extra', 'prototype', 'options getter', 'options extra'])('rejects closed-input %s without invoking it', async kind => {
  const value = manifest(), options = {}; let invoked = 0;
  const getter = () => { invoked++; throw new Error('Secret path'); };
  if (kind === 'manifest getter') Object.defineProperty(value, 'title', { enumerable: true, get: getter });
  if (kind === 'nested getter') Object.defineProperty(value.findings[0].asset, 'file', { enumerable: true, get: getter });
  if (kind === 'hidden extra') Object.defineProperty(value, 'private', { value: 'secret' });
  if (kind === 'prototype') Object.setPrototypeOf(value, { private: true });
  if (kind === 'options getter') Object.defineProperty(options, 'signal', { enumerable: true, get: getter });
  if (kind === 'options extra') options.headers = { Authorization: 'private' };
  await expect(readPublicExampleFinding(value, 'retention-table', options)).rejects.toMatchObject(invalid);
  expect(invoked).toBe(0); expect(fetch).not.toHaveBeenCalled();
});

it.each(['text/html', 'text/plain', 'application/problem+json', 'application/json; charset=iso-8859-1', 'application/json; boundary=x'])('rejects manifest MIME %s, including an SPA fallback, before parsing', async type => {
  fetch.mockResolvedValue(response('manifest.json', { headers: { 'Content-Type': type } }));
  await expect(loadPublicExampleManifest()).rejects.toMatchObject(invalid); expect(fetch).toHaveBeenCalledTimes(1);
});
it.each(['APPLICATION/JSON', 'application/json; charset=UTF-8', 'application/json; charset="utf-8"'])('accepts known JSON MIME %s', async type => {
  fetch.mockResolvedValue(response('manifest.json', { headers: { 'Content-Type': type } })); expect(await loadPublicExampleManifest()).toEqual(manifest());
});
it.each([204, 206, 301, 401, 403, 404, 429, 500, 503])('keeps HTTP %s local to the public item and exposes no server exception or auth action', async status => {
  fetch.mockResolvedValue(new Response(status === 204 ? null : 'PRIVATE_PATH /vault/source', { status, headers: { 'Content-Type': 'text/html' } }));
  const error = await loadPublicExampleManifest().catch(value => value);
  expect(error).toMatchObject(invalid); expect(error.message).not.toContain('PRIVATE_PATH'); expect(fetch).toHaveBeenCalledTimes(1);
});
it.each(['redirected', 'wrong origin', 'wrong file', 'opaque'])('refuses a %s response even if its payload bytes are otherwise pinned', async kind => {
  const result = response('manifest.json');
  if (kind === 'redirected') Object.defineProperty(result, 'redirected', { value: true });
  if (kind === 'wrong origin') Object.defineProperty(result, 'url', { value: 'https://outside.example/manifest.json' });
  if (kind === 'wrong file') Object.defineProperty(result, 'url', { value: location.origin + '/other/manifest.json' });
  if (kind === 'opaque') Object.defineProperty(result, 'type', { value: 'opaque' });
  fetch.mockResolvedValue(result); await expect(loadPublicExampleManifest()).rejects.toMatchObject(invalid);
});
it('reports network failure safely without falling through to an authenticated or alternate asset route', async () => {
  fetch.mockRejectedValue(new TypeError('https://private.example/vault'));
  const error = await table().catch(value => value); expect(error).toMatchObject(unavailable); expect(error.message).not.toContain('private'); expect(fetch).toHaveBeenCalledTimes(1);
});
it.each(['-1', '1.5', '1e3', 'huge', '16385', '9007199254740999999999', '1966', '1968'])('rejects malformed, overbound or identity-inconsistent manifest Content-Length %s', async length => {
  fetch.mockResolvedValue(response('manifest.json', { headers: { 'Content-Length': length } })); await expect(loadPublicExampleManifest()).rejects.toMatchObject(invalid);
});
it.each(['gzip', 'br', 'deflate', ' GZip ', 'gzip, br'])('supports independently bounded native Fetch-decoded %s without comparing it to compressed wire size', async encoding => {
  fetch.mockResolvedValue(response('manifest.json', { headers: { 'Content-Encoding': encoding, 'Content-Length': '300' } }));
  expect(await loadPublicExampleManifest()).toEqual(manifest());
});
it.each(['identity', ' Identity ', 'IDENTITY'])('retains exact declared size for normalized %s encoding', async encoding => {
  fetch.mockResolvedValue(response('manifest.json', { headers: { 'Content-Encoding': encoding, 'Content-Length': '300' } })); await expect(loadPublicExampleManifest()).rejects.toMatchObject(invalid);
});
it('allows compression overhead larger than a tiny decoded CSV while retaining the source wire hard bound', async () => {
  fetch.mockResolvedValue(response('counts.csv', { headers: { 'Content-Encoding': 'gzip', 'Content-Length': '110' } }));
  expect(await readPublicExampleSource(manifest())).toEqual({ text: sourceText, type: 'text/csv', sha256: sourceSha, bytes: 87 });
  fetch.mockResolvedValue(response('counts.csv', { headers: { 'Content-Encoding': 'gzip', 'Content-Length': '4097' } }));
  await expect(readPublicExampleSource(manifest())).rejects.toMatchObject(invalid);
});
it.each(['manifest.json', 'table.json', 'figure.png', 'counts.csv'])('refuses mismatching exact %s bytes and never fetches another asset as a fallback', async file => {
  const bad = Buffer.from(assets[file]); bad[Math.floor(bad.length / 2)] ^= 1;
  fetch.mockResolvedValue(response(file, { body: bad }));
  const operation = file === 'manifest.json' ? loadPublicExampleManifest() : file === 'counts.csv' ? readPublicExampleSource(manifest()) : readPublicExampleFinding(manifest(), file === 'table.json' ? 'retention-table' : 'retention-figure');
  await expect(operation).rejects.toMatchObject(invalid); expect(fetch).toHaveBeenCalledTimes(1);
});
it('rejects a changed manifest checksum before JSON parsing rather than trusting hashes inside that response', async () => {
  const body = Buffer.from(assets['manifest.json']); body[body.length - 2] ^= 1;
  fetch.mockResolvedValue(response('manifest.json', { body })); const parse = vi.spyOn(JSON, 'parse');
  await expect(loadPublicExampleManifest()).rejects.toMatchObject(invalid); expect(parse).not.toHaveBeenCalled();
});
it.each(['duplicate JSON keys', 'unsafe numeric literal', 'fatal UTF8', 'outer BOM', 'different CSV line ending'])('checks the real byte hash before admitting altered %s', async kind => {
  const file = kind === 'different CSV line ending' ? 'counts.csv' : 'table.json'; let body = assets[file];
  if (kind === 'duplicate JSON keys') body = Buffer.from(assets[file].toString().replace('"offset":0', '"offset":0,"offset":0'));
  if (kind === 'unsafe numeric literal') body = Buffer.from(assets[file].toString().replace('1000', '9007199254740993'));
  if (kind === 'fatal UTF8') { body = Buffer.from(body); body[0] = 255; }
  if (kind === 'outer BOM') body = Buffer.concat([Buffer.from([239, 187, 191]), body]);
  if (kind === 'different CSV line ending') body = Buffer.from(sourceText.replaceAll('\n', '\r\n'));
  fetch.mockResolvedValue(response(file, { body, headers: { 'Content-Encoding': 'gzip', 'Content-Length': '30' } }));
  await expect(file === 'counts.csv' ? readPublicExampleSource(manifest()) : table()).rejects.toMatchObject(invalid);
});
it('cancels an overlong decoded stream at the independently pinned length before buffering or hashing the remainder', async () => {
  const cancel = vi.fn(async () => {}), releaseLock = vi.fn(), read = vi.fn(async () => ({ done: false, value: new Uint8Array(1968) }));
  fetch.mockResolvedValue({ status: 200, headers: new Headers({ 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'Content-Length': '40' }), body: { getReader: () => ({ read, cancel, releaseLock }) } });
  await expect(loadPublicExampleManifest()).rejects.toMatchObject(invalid); expect(read).toHaveBeenCalledTimes(1); expect(cancel).toHaveBeenCalledTimes(1); expect(releaseLock).toHaveBeenCalledTimes(1);
});
it('copies native cross-realm byte chunks without invoking their iterator or constructor getters', async () => {
  const chunk = runInNewContext('new Uint8Array(input)', { input: Array.from(assets['manifest.json']) });
  for (const key of ['constructor', Symbol.iterator]) Object.defineProperty(chunk, key, { get() { throw new Error('Do not invoke'); } });
  let first = true; const releaseLock = vi.fn();
  fetch.mockResolvedValue({ status: 200, headers: new Headers({ 'Content-Type': 'application/json' }), body: { getReader: () => ({ read: async () => first ? (first = false, { done: false, value: chunk }) : { done: true }, cancel: async () => {}, releaseLock }) } });
  expect(await loadPublicExampleManifest()).toEqual(manifest()); expect(releaseLock).toHaveBeenCalledTimes(1);
});
it('rejects DataView stream chunks rather than inferring byte length or calling a custom conversion', async () => {
  const cancel = vi.fn(async () => {}), releaseLock = vi.fn();
  fetch.mockResolvedValue({ status: 200, headers: new Headers({ 'Content-Type': 'application/json' }), body: { getReader: () => ({ read: async () => ({ done: false, value: new DataView(new ArrayBuffer(1967)) }), cancel, releaseLock }) } });
  await expect(loadPublicExampleManifest()).rejects.toMatchObject(invalid); expect(cancel).toHaveBeenCalledTimes(1); expect(releaseLock).toHaveBeenCalledTimes(1);
});
it('rejects a nonstream body without allocating an unbounded whole-body fallback', async () => {
  const arrayBuffer = vi.fn(async () => Uint8Array.from(assets['manifest.json']).buffer);
  fetch.mockResolvedValue({ status: 200, headers: new Headers({ 'Content-Type': 'application/json' }), arrayBuffer });
  await expect(loadPublicExampleManifest()).rejects.toMatchObject(invalid); expect(arrayBuffer).not.toHaveBeenCalled();
});
it('keeps one unavailable figure or optional source local while an independently checked table remains usable', async () => {
  const value = await loadPublicExampleManifest(), first = await readPublicExampleFinding(value, 'retention-table');
  fetch.mockResolvedValueOnce(new Response('Missing file', { status: 404 })); await expect(readPublicExampleFinding(value, 'retention-figure')).rejects.toMatchObject(invalid);
  fetch.mockResolvedValueOnce(new Response('Missing source', { status: 404 })); await expect(readPublicExampleSource(value)).rejects.toMatchObject(invalid);
  expect(first.preview.rows[2]).toEqual(['Sample C', 800, 720]); expect((await readPublicExampleFinding(value, 'retention-table')).preview).toEqual(first.preview);
  expect(fetch.mock.calls.map(([address]) => new URL(address).pathname.split('/').at(-1))).toEqual(['manifest.json', 'table.json', 'figure.png', 'counts.csv', 'table.json']);
});

it('does not fetch if its original caller signal is already aborted', async () => {
  const controller = new AbortController(); controller.abort();
  await expect(loadPublicExampleManifest({ signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' }); expect(fetch).not.toHaveBeenCalled();
});
it('captures the original signal before awaits and fences a held digest after cancellation', async () => {
  const controller = new AbortController(), options = { signal: controller.signal }, { held, entered } = holdDigest();
  const operation = readPublicExampleFinding(manifest(), 'retention-table', options); await entered.promise;
  options.signal = new AbortController().signal; controller.abort();
  await expect(operation).rejects.toMatchObject({ name: 'AbortError' }); held.release(); await Promise.resolve(); expect(fetch).not.toHaveBeenCalled();
});
it('fences a held successful fetch after caller cancellation without leaking its late body', async () => {
  const held = gate(), controller = new AbortController(); fetch.mockImplementation(() => held.promise);
  const operation = loadPublicExampleManifest({ signal: controller.signal }); await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1)); controller.abort();
  await expect(operation).rejects.toMatchObject({ name: 'AbortError' }); const result = response('manifest.json'), cancel = vi.spyOn(result.body, 'cancel');
  held.release(result); await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
});
it('cancels a held streamed body, releases its reader and never admits its later successful bytes', async () => {
  const held = gate(), entered = gate(), controller = new AbortController(), releaseLock = vi.fn(), cancel = vi.fn(async () => {});
  fetch.mockResolvedValue({ status: 200, headers: new Headers({ 'Content-Type': 'application/json' }), body: { getReader: () => ({ read: () => { entered.release(); return held.promise; }, cancel, releaseLock }) } });
  const operation = loadPublicExampleManifest({ signal: controller.signal }); await entered.promise; controller.abort();
  await expect(operation).rejects.toMatchObject({ name: 'AbortError' }); held.release({ done: false, value: Uint8Array.from(assets['manifest.json']) });
  await vi.waitFor(() => expect(releaseLock).toHaveBeenCalledTimes(1)); expect(cancel).toHaveBeenCalledTimes(1);
});
it('bounds a stalled request by its deadline and forwards cancellation to the native request', async () => {
  vi.useFakeTimers(); fetch.mockImplementation(() => new Promise(() => {}));
  const operation = loadPublicExampleManifest(), observed = expect(operation).rejects.toMatchObject(unavailable);
  await vi.advanceTimersByTimeAsync(10_000); await observed; expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
});
it('requires available WebCrypto before a supplied manifest can authorize a finding request', async () => {
  vi.stubGlobal('crypto', {}); await expect(table()).rejects.toMatchObject(unavailable); expect(fetch).not.toHaveBeenCalled();
});
