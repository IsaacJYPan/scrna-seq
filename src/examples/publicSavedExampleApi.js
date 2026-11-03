import { PUBLIC_QC_RETENTION_V1 as catalog, PUBLIC_SAVED_EXAMPLE_LIMITS as limits,
  normalizePublicSavedExampleManifest, canonicalPublicSavedExampleManifest, publicSavedExampleFinding,
  canonicalPublicSavedExampleView, normalizePublicSavedExampleTable, normalizePublicSavedExampleSource,
  normalizePublicSavedExamplePng } from '../../shared/publicSavedExample.mjs';

const DEADLINE = 10_000, errors = new WeakSet();
const aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get;
const addListener = AbortSignal.prototype.addEventListener, removeListener = AbortSignal.prototype.removeEventListener;
const arrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const arrayName = Object.getOwnPropertyDescriptor(arrayPrototype, Symbol.toStringTag).get;
const arrayLength = Object.getOwnPropertyDescriptor(arrayPrototype, 'byteLength').get;
function failure(code, message) { const value = Object.assign(new Error(message), { code }); errors.add(value); return value; }
const invalid = () => failure('INVALID_PUBLIC_SAVED_EXAMPLE', 'This public example file could not be verified. Try this item again.');
const unavailable = () => failure('PUBLIC_SAVED_EXAMPLE_UNAVAILABLE', 'This public example file is unavailable. Check the connection and try this item again.');
const canceled = () => new DOMException('The public example request was canceled.', 'AbortError');
function capture(action) { try { return action(); } catch { throw invalid(); } }
function signalFrom(input) {
  return capture(() => {
    if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw invalid();
    const descriptors = Object.getOwnPropertyDescriptors(input);
    if (Reflect.ownKeys(descriptors).some(key => key !== 'signal' || !descriptors[key].enumerable || !Object.hasOwn(descriptors[key], 'value'))) throw invalid();
    const value = descriptors.signal?.value;
    if (value !== undefined) aborted.call(value);
    return value;
  });
}
async function scoped(input, action) {
  const caller = signalFrom(input);
  if (caller && aborted.call(caller)) throw canceled();
  const controller = new AbortController(); let rejectStop;
  const stopped = new Promise((_, reject) => { rejectStop = reject; });
  const stop = () => { controller.abort(); rejectStop(canceled()); };
  if (caller) addListener.call(caller, 'abort', stop, { once: true });
  const timer = setTimeout(() => { controller.abort(); rejectStop(unavailable()); }, DEADLINE);
  const check = () => {
    if (caller && aborted.call(caller)) throw canceled();
    if (controller.signal.aborted) throw unavailable();
  };
  try {
    return await Promise.race([Promise.resolve().then(() => { check(); return action(controller.signal, check); }), stopped]);
  } catch (error) {
    if (caller && aborted.call(caller)) throw canceled();
    if (errors.has(error)) throw error;
    throw unavailable();
  } finally { clearTimeout(timer); if (caller) removeListener.call(caller, 'abort', stop); }
}
function assetUrl(file) {
  return capture(() => {
    const current = new URL(window.location.href), base = new URL('./', current);
    const address = new URL(catalog.assetBase + file, base);
    if (!['http:', 'https:'].includes(current.protocol) || current.username || current.password
      || address.origin !== current.origin || address.username || address.password || address.search || address.hash) throw invalid();
    return address.href;
  });
}
function decode(bytes) {
  return capture(() => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
}
async function digest(bytes, check) {
  check();
  if (!globalThis.crypto?.subtle) throw unavailable();
  const value = await crypto.subtle.digest('SHA-256', bytes); check();
  return Array.from(new Uint8Array(value), byte => byte.toString(16).padStart(2, '0')).join('');
}
async function manifestPin(manifest, check) {
  if (await digest(new TextEncoder().encode(canonicalPublicSavedExampleManifest(manifest)), check) !== catalog.manifest.sha256) throw invalid();
}
async function cancel(body) { try { await body?.cancel(); } catch { /* Keep the original safe failure. */ } }
function mime(value, expected) {
  if (expected === 'image/png') return /^image\/png\s*$/i.test(value);
  const name = expected === 'text/csv' ? 'text/csv' : 'application/json';
  return new RegExp(`^${name}(?:\\s*;\\s*charset\\s*=\\s*(?:utf-8|"utf-8"))?\\s*$`, 'i').test(value);
}
async function bytesFrom(response, expected, maximum, check) {
  const length = response.headers.get('Content-Length'), encoding = (response.headers.get('Content-Encoding') || '').trim().toLowerCase();
  if (length !== null && (!/^[0-9]+$/.test(length) || Number(length) > maximum
      || (!encoding || encoding === 'identity') && Number(length) !== expected.bytes)) {
    await cancel(response.body); throw invalid();
  }
  // A whole-body fallback cannot enforce the cap before allocating that body.
  if (!response.body?.getReader) { await cancel(response.body); throw invalid(); }
  const reader = response.body.getReader(), chunks = []; let size = 0, bytes;
  try {
    for (;;) {
      const part = await reader.read(); check(); if (part.done) break;
      if (!ArrayBuffer.isView(part.value) || arrayName.call(part.value) !== 'Uint8Array') throw invalid();
      const length = arrayLength.call(part.value); size += length;
      if (size > expected.bytes) throw invalid();
      const copy = new Uint8Array(length); Uint8Array.prototype.set.call(copy, part.value); chunks.push(copy);
    }
    if (size !== expected.bytes) throw invalid();
    bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  } catch (error) { await cancel(reader); throw error; }
  finally { reader.releaseLock(); }
  if (await digest(bytes, check) !== expected.sha256) throw invalid();
  return bytes;
}
async function read(address, expected, maximum, signal, check) {
  check();
  const response = await fetch(address, { method: 'GET', credentials: 'omit', mode: 'same-origin', redirect: 'error',
    cache: 'default', referrerPolicy: 'no-referrer', signal, headers: { Accept: expected.mediaType } });
  try { check(); } catch (error) { await cancel(response.body); throw error; }
  if (response.status !== 200 || response.redirected || ['opaque', 'opaqueredirect', 'error'].includes(response.type)
      || response.url && response.url !== address || !mime(response.headers.get('Content-Type') || '', expected.mediaType)) {
    await cancel(response.body); throw invalid();
  }
  return bytesFrom(response, expected, maximum, check);
}

export async function loadPublicExampleManifest(input = {}) {
  const address = assetUrl(catalog.manifest.file);
  return scoped(input, async (signal, check) => {
    const bytes = await read(address, catalog.manifest, limits.manifestBytes, signal, check);
    const manifest = capture(() => normalizePublicSavedExampleManifest(JSON.parse(decode(bytes))));
    await manifestPin(manifest, check);
    for (const finding of manifest.findings) {
      if (await digest(new TextEncoder().encode(canonicalPublicSavedExampleView(manifest, finding.id)), check) !== finding.viewSha256) throw invalid();
    }
    return manifest;
  });
}
export async function readPublicExampleFinding(input, findingId, options = {}) {
  const manifest = capture(() => normalizePublicSavedExampleManifest(input));
  const finding = capture(() => publicSavedExampleFinding(manifest, findingId)), address = assetUrl(finding.asset.file);
  return scoped(options, async (signal, check) => {
    await manifestPin(manifest, check);
    if (await digest(new TextEncoder().encode(canonicalPublicSavedExampleView(manifest, findingId)), check) !== finding.viewSha256) throw invalid();
    const bytes = await read(address, finding.asset, finding.family === 'table' ? limits.tableBytes : limits.imageBytes, signal, check);
    if (finding.family === 'table') return { preview: capture(() => normalizePublicSavedExampleTable(JSON.parse(decode(bytes)))), type: 'application/json' };
    return { preview: capture(() => normalizePublicSavedExamplePng(bytes, finding)), type: 'image/png', imageBytes: bytes };
  });
}
export async function readPublicExampleSource(input, options = {}) {
  const manifest = capture(() => normalizePublicSavedExampleManifest(input)), address = assetUrl(manifest.source.file);
  return scoped(options, async (signal, check) => {
    await manifestPin(manifest, check);
    const bytes = await read(address, manifest.source, limits.sourceBytes, signal, check);
    return { text: capture(() => normalizePublicSavedExampleSource(decode(bytes))), type: 'text/csv', sha256: manifest.source.sha256, bytes: bytes.byteLength };
  });
}
