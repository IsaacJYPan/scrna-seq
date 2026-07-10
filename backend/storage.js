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

  function inspect(key, expected = {}) {
    const absolutePath = resolveKey(key);
    if (!fs.existsSync(absolutePath)) {
      throw storageError('STORAGE_OBJECT_MISSING', 'Durable storage object is missing.');
    }
    const stat = assertOrdinaryPathEntry(absolutePath);
    if (expected.sizeBytes !== undefined && expected.sizeBytes !== null
        && Number(expected.sizeBytes) !== stat.size) {
      throw storageError('STORAGE_SIZE_MISMATCH', 'Durable storage object size does not match its record.');
    }
    const checksumSha256 = hashFileSync(absolutePath);
    if (expected.checksumSha256
        && String(expected.checksumSha256).toLowerCase() !== checksumSha256) {
      throw storageError('STORAGE_CHECKSUM_MISMATCH', 'Durable storage object checksum does not match its record.');
    }
    return { key, sizeBytes: stat.size, checksumSha256 };
  }

  function remove(key) {
    if (!isProjectStorageKey(key)) {
      throw storageError('INVALID_STORAGE_KEY', 'Durable removal requires a project-scoped storage key.');
    }
    const absolutePath = resolveKey(key);
    if (!fs.existsSync(absolutePath)) return false;
    assertOrdinaryPathEntry(absolutePath);
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
    remove,
  });
}

function resolveStoragePath(key) {
  return createLocalStorageProvider().resolveKey(key);
}

module.exports = {
  PROJECT_STORAGE_KINDS,
  vaultRoot,
  storageRoot,
  isSafeKeySegment,
  assertSafeStorageKey,
  projectStorageKey,
  projectStorageFileKey,
  parseProjectStorageKey,
  isProjectStorageKey,
  createLocalStorageProvider,
  resolveStoragePath,
};
