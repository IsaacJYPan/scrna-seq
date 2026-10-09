'use strict';

const CLIENT_API_VERSION = 1;
const MAX_DESCRIPTOR_BYTES = 1024;

function failure(code, message) { return Object.assign(new Error(message), { code }); }

function validateServiceCompatibility(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.product !== 'TraceOmics'
      || !Number.isInteger(value.serviceApiVersion) || value.serviceApiVersion < 1 || value.serviceApiVersion > 1000
      || !Number.isInteger(value.minimumClientApiVersion) || value.minimumClientApiVersion < 1
      || value.minimumClientApiVersion > value.serviceApiVersion) {
    throw failure('DESKTOP_SERVICE_INVALID', 'That address is not a compatible TraceOmics server. Ask its administrator to update the service.');
  }
  if (value.minimumClientApiVersion > CLIENT_API_VERSION || value.serviceApiVersion < CLIENT_API_VERSION) {
    throw failure('DESKTOP_SERVICE_UPGRADE_REQUIRED', 'The TraceOmics service API is incompatible with this desktop. Update the desktop or ask the server administrator to install a compatible service.');
  }
  // The public descriptor verifies only API compatibility. Do not retain any
  // unrelated fields a server might send, including authenticated diagnostics.
  return { product: 'TraceOmics', serviceApiVersion: value.serviceApiVersion,
    minimumClientApiVersion: value.minimumClientApiVersion };
}

async function checkServiceCompatibility(endpoint, { fetchImpl = fetch, timeoutMs = 8000,
  signal, now = Date.now } = {}) {
  const controller = new AbortController();
  let reader, timer;
  const cancelled = () => failure('DESKTOP_CONNECTION_CANCELLED', 'The TraceOmics connection check was canceled.');
  let rejectCancellation;
  const cancellation = new Promise((_, reject) => { rejectCancellation = reject; });
  const cancel = () => { controller.abort(); rejectCancellation(cancelled()); };
  if (signal?.aborted) throw cancelled();
  signal?.addEventListener('abort', cancel, { once: true });
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(failure('DESKTOP_SERVICE_TIMEOUT', 'The TraceOmics connection check timed out. Check the server and retry.'));
    }, timeoutMs);
  });
  async function verify() {
    let response;
    try {
      response = await fetchImpl(new URL('/api/service/compatibility', endpoint), {
        method: 'GET', redirect: 'error', credentials: 'omit',
        headers: { Accept: 'application/json' }, signal: controller.signal,
      });
    } catch (error) {
      if (error.code === 'DESKTOP_TLS_REJECTED') throw error;
      if (signal?.aborted) throw cancelled();
      throw failure('DESKTOP_SERVICE_UNREACHABLE', 'TraceOmics could not reach that server. Check the address, network connection, and server status.');
    }
    if (response.status === 404) throw failure('DESKTOP_SERVICE_UPGRADE_REQUIRED',
      'This server does not publish a TraceOmics compatibility descriptor. Ask its administrator to update the service before connecting.');
    if (!response.ok) throw failure('DESKTOP_SERVICE_REJECTED', 'That server did not accept the TraceOmics compatibility check. Ask its administrator to check the public service endpoint.');
    let value;
    try {
      if (Number(response.headers?.get('content-length')) > MAX_DESCRIPTOR_BYTES) throw new Error('response limit');
      const contentType = response.headers?.get('content-type');
      if (contentType && !/^application\/json(?:\s*;|$)/i.test(contentType)) throw new Error('response type');
      if (response.body?.getReader) {
        reader = response.body.getReader();
        const chunks = []; let size = 0;
        for (;;) {
          const { value: chunk, done } = await reader.read();
          if (done) break;
          size += chunk.byteLength;
          if (size > MAX_DESCRIPTOR_BYTES) throw new Error('response limit');
          chunks.push(Buffer.from(chunk));
        }
        value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } else {
        value = await response.json();
        if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_DESCRIPTOR_BYTES) throw new Error('response limit');
      }
    } catch {
      throw failure('DESKTOP_SERVICE_INVALID', 'That address did not return a valid TraceOmics compatibility response.');
    }
    return { ...validateServiceCompatibility(value), checkedAt: new Date(now()).toISOString() };
  }
  try { return await Promise.race([verify(), deadline, cancellation]); }
  finally {
    clearTimeout(timer); signal?.removeEventListener('abort', cancel);
    controller.abort(); if (reader) void reader.cancel().catch(() => {});
  }
}

module.exports = { CLIENT_API_VERSION, MAX_DESCRIPTOR_BYTES, validateServiceCompatibility, checkServiceCompatibility };
