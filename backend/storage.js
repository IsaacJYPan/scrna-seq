/**
 * Internal durable storage.
 *
 * Durable project files use opaque relative keys such as:
 *   projects/<projectId>/checkpoints/<jobId>/<token>.rds
 *
 * Keys and absolute paths are server-owned. Public API responses must never
 * include either one.
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function storageError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function resolveRoot(envValue, fallbackSegments) {
  const raw = envValue === undefined || envValue === null ? '' : String(envValue).trim();
  if (raw) return path.resolve(raw);
  return path.join(process.cwd(), ...fallbackSegments);
}

function vaultRoot() {
  return resolveRoot(process.env.VAULT_ROOT, ['vault']);
}

function storageRoot() {
  return resolveRoot(process.env.STORAGE_ROOT, ['data']);
}

const PROJECT_STORAGE_KINDS = new Set([
  'datasets', 'artifacts', 'checkpoints', 'reports', 'bundles', 'figures'
]);
const COMPLETION_RECEIPT_VERSION = 1;
const COMPLETION_RECEIPT_MAX_BYTES = 128 * 1024;
const COMPLETION_RECEIPT_FILE_NAME = 'completion-receipt.json';

function isSafeKeySegment(value) {
  if (typeof value !== 'string' || value === '') return false;
  if (value.includes('\0') || value.includes('%')) return false;
  return /^[A-Za-z0-9._-]+$/.test(value) && value !== '.' && value !== '..';
}

function assertSafeStorageKey(key) {
  if (typeof key !== 'string' || key === '' || key.includes('\0') || key.includes('%')) {
    throw storageError('INVALID_STORAGE_KEY', 'Invalid storage key.');
  }
  if (/^([/\\]|[A-Za-z]:|\\\\)/.test(key)) {
    throw storageError('INVALID_STORAGE_KEY', 'Storage key must be relative.');
  }
  if (key.includes('\\')) {
    throw storageError('INVALID_STORAGE_KEY', 'Storage key must use POSIX separators.');
  }
  const segments = key.split('/');
  if (segments.some((segment) => !isSafeKeySegment(segment))) {
    throw storageError('INVALID_STORAGE_KEY', 'Storage key contains an unsafe path segment.');
  }
  return segments;
}

function projectStorageKey(projectId, kind, id) {
  if (!PROJECT_STORAGE_KINDS.has(kind)) {
    throw storageError('INVALID_STORAGE_KIND', `Unknown project storage kind: ${kind}`);
  }
  if (!isSafeKeySegment(projectId)) {
    throw storageError('INVALID_STORAGE_KEY', 'Invalid projectId for storage key.');
  }
  if (!isSafeKeySegment(id)) {
    throw storageError('INVALID_STORAGE_KEY', 'Invalid resource id for storage key.');
  }
  return `projects/${projectId}/${kind}/${id}`;
}

function projectStorageFileKey(projectId, kind, id, fileName) {
  if (!isSafeKeySegment(fileName)) {
    throw storageError('INVALID_STORAGE_KEY', 'Invalid file name for storage key.');
  }
  return `${projectStorageKey(projectId, kind, id)}/${fileName}`;
}

function completionReceiptKey(projectId, jobId) {
  return projectStorageFileKey(
    String(projectId),
    'artifacts',
    String(jobId),
    COMPLETION_RECEIPT_FILE_NAME
  );
}

function parseProjectStorageKey(key) {
  let segments;
  try {
    segments = assertSafeStorageKey(key);
  } catch {
    return null;
  }
  if (segments.length < 4 || segments[0] !== 'projects') return null;
  if (!PROJECT_STORAGE_KINDS.has(segments[2])) return null;
  return {
    projectId: segments[1],
    kind: segments[2],
    resourceId: segments[3],
    fileName: segments.length > 4 ? segments.slice(4).join('/') : null,
  };
}

function isProjectStorageKey(key, { projectId, kind } = {}) {
  const parsed = parseProjectStorageKey(key);
  if (!parsed) return false;
  if (projectId !== undefined && parsed.projectId !== String(projectId)) return false;
  if (kind !== undefined && parsed.kind !== kind) return false;
  return true;
}

function isInsideRoot(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

function hashFileSync(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

// Recovery can inspect multi-gigabyte checkpoints while a worker claim is live.
// Hashing those files with readSync blocks the Node event loop, which also blocks
// the worker's lease-renewal timer. Stream the file instead so heartbeat timers and
// cancellation/claim-loss handling can continue while integrity is verified.
async function hashFileHandle(handle) {
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let position = 0;
  while (true) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) break;
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return hash.digest('hex');
}

function assertOrdinaryPathEntry(entryPath, { directory = false } = {}) {
  const stat = fs.lstatSync(entryPath);
  if (stat.isSymbolicLink()) {
    throw storageError('UNSAFE_STORAGE_PATH', 'Durable storage cannot traverse a symbolic link or junction.');
  }
  if (directory ? !stat.isDirectory() : !stat.isFile()) {
    throw storageError('UNSAFE_STORAGE_PATH', directory
      ? 'Durable storage path contains a non-directory entry.'
      : 'Durable storage object is not a regular file.');
  }
  return stat;
}

function createLocalStorageProvider(options = {}) {
  const root = path.resolve(options.root || storageRoot());

  function resolveKey(key) {
    const segments = assertSafeStorageKey(key);
    const absolutePath = path.resolve(root, ...segments);
    if (!isInsideRoot(root, absolutePath) || absolutePath === root) {
      throw storageError('INVALID_STORAGE_KEY', 'Resolved storage path escapes the storage root.');
    }
    return absolutePath;
  }

  function ensureRoot() {
    fs.mkdirSync(root, { recursive: true });
    assertOrdinaryPathEntry(root, { directory: true });
  }

  function ensureSafeParent(key) {
    ensureRoot();
    const absolutePath = resolveKey(key);
    const parent = path.dirname(absolutePath);
    const relativeParent = path.relative(root, parent);
    let cursor = root;
    for (const segment of relativeParent.split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor, segment);
      if (!fs.existsSync(cursor)) fs.mkdirSync(cursor);
      assertOrdinaryPathEntry(cursor, { directory: true });
    }
    if (fs.existsSync(absolutePath)) assertOrdinaryPathEntry(absolutePath);
    return absolutePath;
  }

  function prepareWrite(key) {
    if (!isProjectStorageKey(key)) {
      throw storageError('INVALID_STORAGE_KEY', 'Durable writes require a project-scoped storage key.');
    }
    return ensureSafeParent(key);
  }

  async function openSafeDescendantFile(absolutePath, missingMessage) {
    let rootEntry;
    try {
      rootEntry = await fs.promises.lstat(root);
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        throw storageError('STORAGE_OBJECT_MISSING', missingMessage);
      }
      throw error;
    }
    if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory()) {
      throw storageError('UNSAFE_STORAGE_PATH', 'Durable storage root is unsafe.');
    }

    const relative = path.relative(root, absolutePath);
    const segments = relative.split(path.sep).filter(Boolean);
    let cursor = root;
    let finalEntry = null;
    for (let index = 0; index < segments.length; index += 1) {
      cursor = path.join(cursor, segments[index]);
      let entry;
      try {
        entry = await fs.promises.lstat(cursor);
      } catch (error) {
        if (error && error.code === 'ENOENT') {
          throw storageError('STORAGE_OBJECT_MISSING', missingMessage);
        }
        throw error;
      }
      if (entry.isSymbolicLink()) {
        throw storageError('UNSAFE_STORAGE_PATH', 'Durable storage cannot traverse a symbolic link or junction.');
      }
      if (index < segments.length - 1 && !entry.isDirectory()) {
        throw storageError('UNSAFE_STORAGE_PATH', 'Durable storage path contains a non-directory entry.');
      }
      if (index === segments.length - 1) {
        if (!entry.isFile()) {
          throw storageError('UNSAFE_STORAGE_PATH', 'Durable storage object is not a regular file.');
        }
        finalEntry = entry;
      }
    }

    let handle;
    try {
      const noFollow = Number.isInteger(fs.constants.O_NOFOLLOW) ? fs.constants.O_NOFOLLOW : 0;
      handle = await fs.promises.open(absolutePath, fs.constants.O_RDONLY | noFollow);
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        throw storageError('STORAGE_OBJECT_MISSING', missingMessage);
      }
      if (error && error.code === 'ELOOP') {
        throw storageError('UNSAFE_STORAGE_PATH', 'Durable storage object is a symbolic link.');
      }
      throw error;
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) {
        throw storageError('UNSAFE_STORAGE_PATH', 'Durable storage object is not a regular file.');
      }
      // Bind the opened handle to the exact final entry inspected above. This
      // closes the final-component lstat/open replacement race even where
      // O_NOFOLLOW is unavailable (notably Windows).
      if (finalEntry && Number.isFinite(finalEntry.dev) && Number.isFinite(finalEntry.ino)
          && (finalEntry.dev !== stat.dev || finalEntry.ino !== stat.ino)) {
        throw storageError('UNSAFE_STORAGE_PATH', 'Durable storage object changed during inspection.');
      }
      return { handle, stat };
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  function putFileFromPath(sourcePath, key) {
    const sourceStat = assertOrdinaryPathEntry(sourcePath);
    const destination = prepareWrite(key);
    if (fs.existsSync(destination)) {
      throw storageError('STORAGE_OBJECT_EXISTS', 'Durable storage object already exists.');
    }

    const partial = `${destination}.partial-${crypto.randomBytes(8).toString('hex')}`;
    try {
      fs.copyFileSync(sourcePath, partial, fs.constants.COPYFILE_EXCL);
      const fd = fs.openSync(partial, 'r+');
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      const checksumSha256 = hashFileSync(partial);
      fs.linkSync(partial, destination);
      fs.unlinkSync(partial);
      fs.unlinkSync(sourcePath);
      return {
        key,
        checksumSha256,
        sizeBytes: sourceStat.size,
      };
    } catch (error) {
      try { if (fs.existsSync(partial)) fs.unlinkSync(partial); } catch { /* best effort */ }
      throw error;
    }
  }

  async function inspect(key, expected = {}) {
    const absolutePath = resolveKey(key);
    const opened = await openSafeDescendantFile(
      absolutePath,
      'Durable storage object is missing.'
    );
    const { handle, stat } = opened;
    try {
      if (expected.sizeBytes !== undefined && expected.sizeBytes !== null
          && Number(expected.sizeBytes) !== stat.size) {
        throw storageError('STORAGE_SIZE_MISMATCH', 'Durable storage object size does not match its record.');
      }
      const checksumSha256 = await hashFileHandle(handle);
      if (expected.checksumSha256
          && String(expected.checksumSha256).toLowerCase() !== checksumSha256) {
        throw storageError('STORAGE_CHECKSUM_MISMATCH', 'Durable storage object checksum does not match its record.');
      }
      return { key, sizeBytes: stat.size, checksumSha256 };
    } finally {
      await handle.close();
    }
  }

  async function readCompletionReceipt(key) {
    if (!isProjectStorageKey(key, { kind: 'artifacts' })
        || !String(key).endsWith(`/${COMPLETION_RECEIPT_FILE_NAME}`)) {
      throw storageError('INVALID_STORAGE_KEY', 'Invalid completion receipt key.');
    }
    const absolutePath = resolveKey(key);
    const { handle, stat } = await openSafeDescendantFile(
      absolutePath,
      'Completion receipt is missing.'
    );
    try {
      if (stat.size <= 0 || stat.size > COMPLETION_RECEIPT_MAX_BYTES) {
        throw storageError('RECEIPT_SIZE_INVALID', 'Completion receipt exceeds its safe size limit.');
      }
      // Read at most cap+1 from the already-open handle. This keeps the bound even
      // if the path is replaced or the file grows after the stat call.
      const bytes = Buffer.allocUnsafe(COMPLETION_RECEIPT_MAX_BYTES + 1);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(
          bytes,
          offset,
          bytes.length - offset,
          offset
        );
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      if (offset === 0 || offset > COMPLETION_RECEIPT_MAX_BYTES) {
        throw storageError('RECEIPT_SIZE_INVALID', 'Completion receipt exceeds its safe size limit.');
      }
      const raw = bytes.subarray(0, offset);
      const text = raw.toString('utf8');
      if (!Buffer.from(text, 'utf8').equals(raw)) {
        throw storageError('RECEIPT_JSON_INVALID', 'Completion receipt is not valid UTF-8 JSON.');
      }
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw storageError('RECEIPT_JSON_INVALID', 'Completion receipt is not valid JSON.');
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
          || Object.getPrototypeOf(parsed) !== Object.prototype) {
        throw storageError('RECEIPT_JSON_INVALID', 'Completion receipt must be a JSON object.');
      }
      return parsed;
    } finally {
      await handle.close();
    }
  }

  function remove(key) {
    if (!isProjectStorageKey(key)) {
      throw storageError('INVALID_STORAGE_KEY', 'Durable removal requires a project-scoped storage key.');
    }
    const absolutePath = resolveKey(key);
    let rootEntry;
    try {
      rootEntry = fs.lstatSync(root);
    } catch (error) {
      if (error && error.code === 'ENOENT') return false;
      throw error;
    }
    if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory()) {
      throw storageError('UNSAFE_STORAGE_PATH', 'Durable storage root is unsafe.');
    }
    const relative = path.relative(root, absolutePath);
    let cursor = root;
    const segments = relative.split(path.sep).filter(Boolean);
    for (let index = 0; index < segments.length; index += 1) {
      cursor = path.join(cursor, segments[index]);
      let entry;
      try {
        entry = fs.lstatSync(cursor);
      } catch (error) {
        if (error && error.code === 'ENOENT') return false;
        throw error;
      }
      if (entry.isSymbolicLink()) {
        throw storageError('UNSAFE_STORAGE_PATH', 'Durable removal cannot traverse a symbolic link or junction.');
      }
      if (index < segments.length - 1 && !entry.isDirectory()) {
        throw storageError('UNSAFE_STORAGE_PATH', 'Durable storage path contains a non-directory entry.');
      }
      if (index === segments.length - 1 && !entry.isFile()) {
        throw storageError('UNSAFE_STORAGE_PATH', 'Durable storage object is not a regular file.');
      }
    }
    fs.unlinkSync(absolutePath);
    return true;
  }

  return Object.freeze({
    kind: 'local',
    root,
    resolveKey,
    prepareWrite,
    putFileFromPath,
    inspect,
    readCompletionReceipt,
    remove,
  });
}

function resolveStoragePath(key) {
  return createLocalStorageProvider().resolveKey(key);
}

module.exports = {
  PROJECT_STORAGE_KINDS,
  COMPLETION_RECEIPT_VERSION,
  COMPLETION_RECEIPT_MAX_BYTES,
  COMPLETION_RECEIPT_FILE_NAME,
  vaultRoot,
  storageRoot,
  isSafeKeySegment,
  assertSafeStorageKey,
  projectStorageKey,
  projectStorageFileKey,
  completionReceiptKey,
  parseProjectStorageKey,
  isProjectStorageKey,
  createLocalStorageProvider,
  resolveStoragePath,
};
