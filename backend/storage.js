/**
 * Storage roots + durable project-scoped storage key conventions.
 *
 * Hybrid storage posture:
 *  - user-private vault (VAULT_ROOT): transient live-R / session state. Private,
 *    per-user, NOT project-shared. Untouched by this module beyond exposing the
 *    root; live-R state keying stays server-derived in server.js / rWorkerBridge.
 *  - durable project-scoped storage: datasets, artifacts, checkpoints, reports,
 *    reproducibility bundles. These get a SERVER-GENERATED, project-scoped
 *    INTERNAL key via projectStorageKey(). The key is never client-supplied and
 *    never returned in a public API projection (the artifact/dataset serializers
 *    already strip storage_uri / internal_storage_key).
 *
 * This is a local-filesystem convention today. The key format is deliberately a
 * relative, provider-agnostic path ("projects/<projectId>/<kind>/<id>") so a
 * FUTURE object-storage backend (S3/GCS) can adopt the SAME key as an object
 * key under a bucket without changing callers. No object-storage provider,
 * no download surface, and no public path exposure are introduced here.
 */

'use strict';

const path = require('path');

function resolveRoot(envValue, fallbackSegments) {
  const raw = envValue === undefined || envValue === null ? '' : String(envValue).trim();
  if (raw) return path.resolve(raw);
  return path.join(process.cwd(), ...fallbackSegments);
}

// Per-user private vault (transient live-R state, uploaded working files).
function vaultRoot() {
  return resolveRoot(process.env.VAULT_ROOT, ['vault']);
}

// Durable data root (uploads and, via projectStorageKey, durable project
// resources). Defaults to ./data.
function storageRoot() {
  return resolveRoot(process.env.STORAGE_ROOT, ['data']);
}

// Allow-list of durable, project-scoped resource kinds. Anything else is
// rejected so a caller cannot invent an arbitrary key namespace.
const PROJECT_STORAGE_KINDS = new Set([
  'datasets', 'artifacts', 'checkpoints', 'reports', 'bundles', 'figures'
]);

function isSafeKeySegment(value) {
  if (typeof value !== 'string' || value === '') return false;
  if (value.includes('\0')) return false;
  if (value.includes('%')) return false;
  // Server-generated ids are lowercase-hex-prefixed tokens (ds_/art_/ao_/job_/
  // proj_...). Confine key segments to that safe alphabet so a key can never
  // carry a path-traversal segment or separator even if a caller passes junk.
  return /^[A-Za-z0-9._-]+$/.test(value) && value !== '.' && value !== '..';
}

function assertSafeStorageKey(key) {
  if (typeof key !== 'string' || key === '' || key.includes('\0')) {
    throw new Error('Invalid storage key.');
  }
  if (key.includes('%')) {
    throw new Error('Invalid storage key.');
  }
  if (/^([/\\]|[A-Za-z]:|\\\\)/.test(key)) {
    throw new Error('Storage key must be relative.');
  }
  if (key.includes('\\')) {
    throw new Error('Storage key must use POSIX separators.');
  }

  const segments = key.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error('Storage key contains an unsafe path segment.');
  }
}

/**
 * Build the INTERNAL, server-owned storage key for a durable project resource.
 * Throws on an unknown kind or an unsafe id/projectId segment. The returned key
 * is a relative POSIX-style path with no leading slash and no traversal, safe to
 * use as a filesystem sub-path OR a future object key. It must NEVER be returned
 * to a client.
 */
function projectStorageKey(projectId, kind, id) {
  if (!PROJECT_STORAGE_KINDS.has(kind)) {
    throw new Error(`Unknown project storage kind: ${kind}`);
  }
  if (!isSafeKeySegment(projectId)) {
    throw new Error('Invalid projectId for storage key.');
  }
  if (!isSafeKeySegment(id)) {
    throw new Error('Invalid resource id for storage key.');
  }
  return `projects/${projectId}/${kind}/${id}`;
}

/**
 * Resolve a storage key to an absolute filesystem path under storageRoot(),
 * verifying the result stays confined (defense-in-depth against traversal). The
 * absolute path is server-internal and must not be exposed in a response.
 */
function resolveStoragePath(key) {
  assertSafeStorageKey(key);
  const root = storageRoot();
  const abs = path.resolve(root, key);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (abs !== root && !abs.startsWith(rootWithSep)) {
    throw new Error('Resolved storage path escapes the storage root.');
  }
  return abs;
}

module.exports = {
  PROJECT_STORAGE_KINDS,
  vaultRoot,
  storageRoot,
  isSafeKeySegment,
  projectStorageKey,
  assertSafeStorageKey,
  resolveStoragePath
};
