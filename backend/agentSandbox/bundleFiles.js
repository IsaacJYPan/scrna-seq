'use strict';

// Reads one named file out of an Expert R output bundle (a gzip'd tar written
// by the sandbox broker). The bundle is opened through the storage provider's
// verified read, so a bundle whose bytes no longer match its record is refused.
// Only regular files are returned and their size is bounded.

const zlib = require('zlib');
const { codedError } = require('../policy/agentCapabilities');

const TEXT_TYPES = Object.freeze({
  '.txt': 'text/plain', '.csv': 'text/csv', '.tsv': 'text/tab-separated-values', '.json': 'application/json',
});
const IMAGE_TYPES = Object.freeze({ '.png': 'image/png', '.svg': 'image/svg+xml' });
const BINARY_TYPES = Object.freeze({ '.pdf': 'application/pdf', '.rds': 'application/octet-stream' });
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,159}$/;

function extensionOf(name) {
  const match = /\.[A-Za-z0-9]+$/.exec(name);
  return match ? match[0].toLowerCase() : '';
}

function fileKind(name) {
  const ext = extensionOf(name);
  if (TEXT_TYPES[ext]) return { kind: 'text', mimeType: TEXT_TYPES[ext] };
  if (IMAGE_TYPES[ext]) return { kind: 'image', mimeType: IMAGE_TYPES[ext] };
  if (BINARY_TYPES[ext]) return { kind: 'binary', mimeType: BINARY_TYPES[ext] };
  return null;
}

function validFileName(name) {
  return typeof name === 'string' && FILE_NAME.test(name)
    && !name.split('/').some((part) => part === '' || part === '.' || part === '..');
}

function normalizeEntryName(raw) {
  return String(raw || '').replace(/^\.\//, '').replace(/\/+$/, '');
}

function headerString(block, offset, length) {
  const slice = block.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString('utf8');
}

function headerSize(block) {
  // GNU base-256 encoding for very large files; such files are never returned.
  if (block[124] & 0x80) return Number.MAX_SAFE_INTEGER;
  return parseInt(headerString(block, 124, 12).trim() || '0', 8);
}

function paxPath(buffer) {
  const text = buffer.toString('utf8');
  let index = 0;
  while (index < text.length) {
    const space = text.indexOf(' ', index);
    if (space === -1) break;
    const length = Number(text.slice(index, space));
    if (!Number.isSafeInteger(length) || length <= 0) break;
    const record = text.slice(space + 1, index + length - 1);
    if (record.startsWith('path=')) return record.slice(5);
    index += length;
  }
  return null;
}

// Streams the tar and resolves with the wanted file's bytes, or null.
function extractFromTarStream(stream, wantedName, maxBytes) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    let state = { mode: 'header' };
    let longName = null;
    let done = false;
    const finish = (error, value) => {
      if (done) return;
      done = true;
      stream.destroy();
      if (error) reject(error); else resolve(value);
    };
    stream.on('error', () => finish(codedError('BUNDLE_UNREADABLE', 'The output bundle could not be read.', 500)));
    stream.on('end', () => finish(null, null));
    stream.on('data', (chunk) => {
      if (done) return;
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
      while (!done) {
        if (state.mode === 'header') {
          if (buffer.length < 512) return;
          const block = buffer.subarray(0, 512);
          buffer = buffer.subarray(512);
          if (block.every((byte) => byte === 0)) { finish(null, null); return; }
          const size = headerSize(block);
          const type = String.fromCharCode(block[156] || 48);
          const prefix = headerString(block, 345, 155);
          const base = headerString(block, 0, 100);
          const name = normalizeEntryName(longName || (prefix ? `${prefix}/${base}` : base));
          longName = null;
          const padded = Math.ceil(size / 512) * 512;
          if (type === 'L' || type === 'x') {
            if (size > 65536) { finish(codedError('BUNDLE_UNREADABLE', 'The output bundle could not be read.', 500)); return; }
            state = { mode: 'meta', type, size, padded, parts: [], received: 0 };
          } else if ((type === '0' || type === '\0') && name === wantedName) {
            if (size > maxBytes) { finish(codedError('FILE_TOO_LARGE', 'That file is too large to read here.', 413)); return; }
            state = { mode: 'want', size, padded, parts: [], received: 0 };
          } else {
            state = { mode: 'skip', remaining: padded };
          }
        } else if (state.mode === 'skip') {
          const take = Math.min(state.remaining, buffer.length);
          buffer = buffer.subarray(take);
          state.remaining -= take;
          if (state.remaining > 0) return;
          state = { mode: 'header' };
        } else {
          const take = Math.min(state.padded - state.received, buffer.length);
          const keep = Math.max(0, Math.min(take, state.size - state.received));
          if (keep) state.parts.push(buffer.subarray(0, keep));
          buffer = buffer.subarray(take);
          state.received += take;
          if (state.received < state.padded) return;
          const content = Buffer.concat(state.parts);
          if (state.mode === 'want') { finish(null, content); return; }
          if (state.type === 'L') longName = headerString(content, 0, content.length);
          else longName = paxPath(content);
          state = { mode: 'header' };
        }
      }
    });
  });
}

const cache = new Map();
const CACHE_LIMIT = 32;

async function readBundleFile(provider, bundle, name, { maxBytes = 2 * 1024 * 1024 } = {}) {
  if (!validFileName(name)) throw codedError('NOT_FOUND', 'File not found.', 404);
  const kind = fileKind(name);
  if (!kind) throw codedError('UNSUPPORTED_FILE_TYPE', 'This file type cannot be read here.', 415);
  const listed = (bundle.files || []).find((file) => file.name === name);
  if (!listed) throw codedError('NOT_FOUND', 'File not found.', 404);
  if (listed.sizeBytes > maxBytes) throw codedError('FILE_TOO_LARGE', 'That file is too large to read here.', 413);
  const cacheKey = `${bundle.checksumSha256}:${name}`;
  if (cache.has(cacheKey)) return { ...kind, name, content: cache.get(cacheKey) };
  const opened = await provider.openVerifiedRead(bundle.internalStorageKey, {
    sizeBytes: bundle.sizeBytes, checksumSha256: bundle.checksumSha256,
  });
  let content;
  try {
    const gunzip = zlib.createGunzip();
    opened.handle.createReadStream({ start: 0, autoClose: false }).on('error', (e) => gunzip.destroy(e)).pipe(gunzip);
    content = await extractFromTarStream(gunzip, name, maxBytes);
  } finally {
    await opened.handle.close();
  }
  if (!content) throw codedError('NOT_FOUND', 'File not found.', 404);
  if (content.length !== listed.sizeBytes) throw codedError('BUNDLE_UNREADABLE', 'The output bundle could not be read.', 500);
  cache.set(cacheKey, content);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
  return { ...kind, name, content };
}

module.exports = { readBundleFile, fileKind, validFileName, extractFromTarStream };
