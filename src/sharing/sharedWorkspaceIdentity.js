import { apiUrl } from '../api';
import { withExecutionTarget } from '../runtime/executionTarget';

const MAXIMUM = 4096, DEADLINE = 10_000, SERVICE = /^svc_[a-f0-9]{32}$/;
const schema = 'traceomics.installation.v1', keys = ['schema', 'installationId', 'userId'];
const aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get;
const addListener = AbortSignal.prototype.addEventListener, removeListener = AbortSignal.prototype.removeEventListener;
const arrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const arrayName = Object.getOwnPropertyDescriptor(arrayPrototype, Symbol.toStringTag).get;
const arrayLength = Object.getOwnPropertyDescriptor(arrayPrototype, 'byteLength').get;
const invalid = () => Object.assign(new Error('The signed-in workspace identity could not be verified. Check the connection and try again.'), { code: 'INVALID_SHARED_WORKSPACE_IDENTITY' });
const unreachable = () => Object.assign(new Error('The workspace service could not be reached. Reconnect to the intended workspace and try again.'), { code: 'SHARED_WORKSPACE_UNREACHABLE' });

function optionsCopy(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(input), actual = Reflect.ownKeys(descriptors);
  if (actual.some(key => key !== 'signal' || !descriptors[key].enumerable || !Object.hasOwn(descriptors[key], 'value'))) throw invalid();
  const signal = descriptors.signal?.value;
  if (signal !== undefined) { try { aborted.call(signal); } catch { throw invalid(); } }
  return signal;
}

// This endpoint is a closed flat object. Read its original tokens so duplicate
// keys and rounded/exponent user IDs cannot authenticate a different identity.
function identity(text, expectedUserId) {
  let offset = 0;
  const whitespace = () => { while (offset < text.length && [9, 10, 13, 32].includes(text.charCodeAt(offset))) offset++; };
  const string = () => {
    if (text[offset] !== '"') throw invalid();
    const start = offset++;
    while (offset < text.length) {
      const character = text[offset++];
      if (character === '"') { try { return JSON.parse(text.slice(start, offset)); } catch { throw invalid(); } }
      if (character === '\\') offset++;
    }
    throw invalid();
  };
  const result = Object.create(null), seen = new Set();
  whitespace(); if (text[offset++] !== '{') throw invalid();
  for (;;) {
    whitespace(); const key = string();
    if (!keys.includes(key) || seen.has(key)) throw invalid(); seen.add(key);
    whitespace(); if (text[offset++] !== ':') throw invalid(); whitespace();
    if (text[offset] === '"') result[key] = string();
    else {
      const match = /^[1-9][0-9]*/.exec(text.slice(offset));
      if (!match) throw invalid(); result[key] = Number(match[0]); offset += match[0].length;
    }
    whitespace(); const separator = text[offset++];
    if (separator === '}') break;
    if (separator !== ',' || seen.size >= keys.length) throw invalid();
  }
  whitespace();
  if (offset !== text.length || seen.size !== keys.length || result.schema !== schema || typeof result.installationId !== 'string'
      || !SERVICE.test(result.installationId) || !Number.isSafeInteger(result.userId) || result.userId !== expectedUserId) throw invalid();
  return { installationId: result.installationId, userId: result.userId };
}

async function boundedIdentity(response, expectedUserId) {
  const type = response.headers.get('Content-Type') || '', length = response.headers.get('Content-Length');
  const encoding = (response.headers.get('Content-Encoding') || '').trim().toLowerCase();
  if (!/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(type)
      || length !== null && (!/^[0-9]+$/.test(length) || Number(length) > MAXIMUM)) {
    await response.body?.cancel().catch(() => {}); throw invalid();
  }
  let bytes;
  if (!response.body?.getReader) {
    bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAXIMUM) throw invalid();
  } else {
    const reader = response.body.getReader(), chunks = []; let size = 0;
    try {
      for (;;) {
        const part = await reader.read(); if (part.done) break;
        if (!ArrayBuffer.isView(part.value) || arrayName.call(part.value) !== 'Uint8Array') throw invalid();
        const length = arrayLength.call(part.value); size += length;
        if (size > MAXIMUM) throw invalid();
        const copy = new Uint8Array(length); Uint8Array.prototype.set.call(copy, part.value); chunks.push(copy);
      }
      bytes = new Uint8Array(size); let position = 0;
      for (const chunk of chunks) { bytes.set(chunk, position); position += chunk.byteLength; }
    } catch (error) { await reader.cancel().catch(() => {}); throw error; }
    finally { reader.releaseLock(); }
  }
  // Fetch exposes decoded bytes but may retain the compressed wire length.
  // Both declared wire size and decoded streaming size stay independently bounded.
  if (length !== null && (!encoding || encoding === 'identity') && bytes.byteLength !== Number(length)) throw invalid();
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { throw invalid(); }
  return identity(text, expectedUserId);
}

export async function readSharedWorkspaceIdentity(expectedUserId, input = {}) {
  if (!Number.isSafeInteger(expectedUserId) || expectedUserId < 1) throw invalid();
  const signal = optionsCopy(input), owner = expectedUserId;
  if (signal && aborted.call(signal)) throw new DOMException('The workspace check was canceled.', 'AbortError');
  return withExecutionTarget(async () => {
    if (signal && aborted.call(signal)) throw new DOMException('The workspace check was canceled.', 'AbortError');
    const controller = new AbortController(), abort = () => controller.abort();
    if (signal) addListener.call(signal, 'abort', abort, { once: true });
    const timer = setTimeout(abort, DEADLINE);
    try {
      let response;
      try { response = await fetch(apiUrl('/api/auth/installation'), { method: 'GET', credentials: 'include', cache: 'no-store', signal: controller.signal, headers: { Accept: 'application/json' } }); }
      catch (error) { if (signal && aborted.call(signal)) throw new DOMException('The workspace check was canceled.', 'AbortError'); if (error.name === 'AbortError' && !controller.signal.aborted) throw error; throw unreachable(); }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw Object.assign(new Error(response.status === 401 ? 'Sign in to the intended workspace to open this shared snapshot.' : 'The signed-in workspace identity is unavailable. Try again.'),
          { code: response.status === 401 ? 'SHARED_WORKSPACE_AUTH_REQUIRED' : 'SHARED_WORKSPACE_UNAVAILABLE', status: response.status });
      }
      const result = await boundedIdentity(response, owner);
      if (signal && aborted.call(signal)) throw new DOMException('The workspace check was canceled.', 'AbortError');
      if (controller.signal.aborted) throw unreachable();
      return result;
    } catch (error) {
      if (signal && aborted.call(signal)) throw new DOMException('The workspace check was canceled.', 'AbortError');
      if (['INVALID_SHARED_WORKSPACE_IDENTITY', 'SHARED_WORKSPACE_UNREACHABLE', 'SHARED_WORKSPACE_AUTH_REQUIRED', 'SHARED_WORKSPACE_UNAVAILABLE'].includes(error.code)) throw error;
      throw unreachable();
    } finally { clearTimeout(timer); if (signal) removeListener.call(signal, 'abort', abort); }
  }, { mutation: false });
}
