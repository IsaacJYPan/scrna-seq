'use strict';

const crypto = require('node:crypto');

const ENVIRONMENT_SCHEMA = 'traceomics.r-environment.v1';
const MAX_ENVIRONMENT_BYTES = 256 * 1024;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const HASH = /^[0-9a-f]{64}$/;
const REFERENCE_KEYS = ['id', 'manifestSha256', 'profileId', 'rVersion', 'bioconductor', 'imageDigest', 'imageId', 'snapshotScope'];
const PROFILE_ID = /^[a-z][a-z0-9.-]{0,99}$/;
function error(code, message) { return Object.assign(new Error(message), { code, publicSafeHandlerError: true }); }
function record(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) {
    throw error('R_ENVIRONMENT_INVALID', 'The recorded R environment is invalid.');
  }
}
function text(value, maximum = 200) {
  if (typeof value !== 'string' || !value || value.length > maximum || /[\p{Cc}]/u.test(value)) {
    throw error('R_ENVIRONMENT_INVALID', 'The recorded R environment contains invalid version data.');
  }
  return value;
}
function version(value, maximum = 120) {
  const result = text(value, maximum);
  if (!/^\d[A-Za-z0-9.+~:_-]*$/.test(result)) throw error('R_ENVIRONMENT_INVALID', 'The recorded package version is invalid.');
  return result;
}
function identifier(value, maximum = 80) {
  const result = text(value,maximum);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.+-]*$/.test(result)) throw error('R_ENVIRONMENT_INVALID','The recorded runtime identifier is invalid.');
  return result;
}
function publicUrl(value) {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw error('R_ENVIRONMENT_INVALID', 'The recorded package origin is invalid.');
  }
  return text(url.toString(), 512);
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
function environmentBytes(manifest) { return Buffer.from(JSON.stringify(canonical(manifest)) + '\n', 'utf8'); }
function validateEnvironmentManifest(raw) {
  record(raw, ['schema', 'profileId', 'runtime', 'r', 'packages', 'systemPackages', 'lock']);
  if (raw.schema !== ENVIRONMENT_SCHEMA) throw error('R_ENVIRONMENT_INVALID', 'The R environment format is unsupported.');
  const profileId = text(raw.profileId, 100);
  if (!PROFILE_ID.test(profileId)) throw error('R_ENVIRONMENT_INVALID', 'The R environment profile is invalid.');
  record(raw.runtime, ['imageReference', 'imageDigest', 'imageId', 'os', 'architecture', 'distribution', 'snapshotScope', 'kernel']);
  if (!SHA256.test(raw.runtime.imageDigest) || !SHA256.test(raw.runtime.imageId)
      || !/^(?:(?:[A-Za-z0-9._-]+(?::\d{1,5})?\/)?(?:[a-z0-9][a-z0-9._-]*\/)*[a-z0-9][a-z0-9._-]*@)?sha256:[0-9a-f]{64}$/.test(raw.runtime.imageReference || '')
      || raw.runtime.imageReference.slice(raw.runtime.imageReference.lastIndexOf('sha256:')) !== raw.runtime.imageDigest
      || (!raw.runtime.imageReference.includes('@') && raw.runtime.imageDigest !== raw.runtime.imageId)
      || raw.runtime.snapshotScope !== 'container-userspace' || raw.runtime.kernel !== 'worker-host'
      || raw.runtime.os !== 'linux' || !['amd64', 'arm64'].includes(raw.runtime.architecture)) {
    throw error('R_ENVIRONMENT_INVALID', 'The immutable R runtime identity is invalid.');
  }
  record(raw.runtime.distribution, ['id', 'version']);
  record(raw.r, ['version', 'platform', 'bioconductor']);
  if (!/^\d+\.\d+\.\d+$/.test(raw.r.version || '') || !/^\d+\.\d+$/.test(raw.r.bioconductor || '')) {
    throw error('R_ENVIRONMENT_INVALID', 'The exact R and Bioconductor versions are missing.');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_.+-]{0,100}$/.test(raw.r.platform || '')) throw error('R_ENVIRONMENT_INVALID', 'The recorded R platform is invalid.');
  const r = { version: raw.r.version, platform: raw.r.platform, bioconductor: raw.r.bioconductor };
  record(raw.lock, ['format', 'sourceArchivesIncluded']);
  if (raw.lock.format !== 'installed-package-inventory.v1' || raw.lock.sourceArchivesIncluded !== false) throw error('R_ENVIRONMENT_INVALID', 'The installed package lock is invalid.');
  if (!Array.isArray(raw.packages) || !raw.packages.length || raw.packages.length > 1000
      || !Array.isArray(raw.systemPackages) || !raw.systemPackages.length || raw.systemPackages.length > 2000) throw error('R_ENVIRONMENT_INVALID', 'The environment package lock is incomplete.');
  const names = new Set();
  const packages = raw.packages.map(pkg => {
    record(pkg, ['name', 'version', 'built', 'priority', 'source']);
    if (!/^[A-Za-z][A-Za-z0-9.]{0,100}$/.test(pkg.name || '') || names.has(pkg.name)) throw error('R_ENVIRONMENT_INVALID', 'The R package lock contains duplicate or invalid names.');
    names.add(pkg.name);
    record(pkg.source, ['kind', 'repository', 'url', 'remoteType', 'remoteHost', 'remoteOwner', 'remoteRepo', 'remoteRef', 'remoteSha', 'gitUrl', 'gitBranch', 'gitCommit']);
    if (!['r-distribution', 'recorded', 'unrecorded'].includes(pkg.source.kind)) throw error('R_ENVIRONMENT_INVALID', 'The package source format is invalid.');
    const source = { kind: pkg.source.kind };
    for (const [key, value] of Object.entries(pkg.source)) {
      if (key === 'kind') continue;
      source[key] = ['url', 'gitUrl'].includes(key) ? publicUrl(value) : text(value, 200);
      if (['repository', 'remoteHost', 'remoteOwner', 'remoteRepo', 'remoteRef'].includes(key)
          && (!/^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(value) || value.includes('..'))) {
        throw error('R_ENVIRONMENT_INVALID', 'The package source metadata contains an unsupported reference.');
      }
      if (['remoteSha', 'gitCommit'].includes(key) && !/^[0-9a-f]{7,64}$/i.test(value)) throw error('R_ENVIRONMENT_INVALID', 'The package source revision is invalid.');
      if (key === 'gitBranch' && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$/.test(value)) throw error('R_ENVIRONMENT_INVALID', 'The package source branch is invalid.');
      if (key === 'remoteType' && !['github', 'git', 'gitlab', 'cran', 'bioc', 'standard'].includes(value)) throw error('R_ENVIRONMENT_INVALID', 'The package source type is unsupported.');
    }
    if (pkg.built && !/^\d+\.\d+\.\d+$/.test(pkg.built)) throw error('R_ENVIRONMENT_INVALID', 'The package build R version is invalid.');
    if (pkg.priority && !['base', 'recommended'].includes(pkg.priority)) throw error('R_ENVIRONMENT_INVALID', 'The package priority is invalid.');
    return { name: pkg.name, version: version(pkg.version, 80), ...(pkg.built ? { built: pkg.built } : {}),
      ...(pkg.priority ? { priority: pkg.priority } : {}), source };
  }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const systemNames = new Set();
  const systemPackages = raw.systemPackages.map(pkg => {
    record(pkg, ['name', 'version', 'architecture']);
    const name = text(pkg.name, 120), architecture = identifier(pkg.architecture, 40);
    if (!/^[a-z0-9][a-z0-9+.:_-]*$/.test(name) || systemNames.has(name + ':' + architecture)) throw error('R_ENVIRONMENT_INVALID', 'The system package lock contains invalid names.');
    systemNames.add(name + ':' + architecture);
    return { name, version: version(pkg.version, 120), architecture };
  }).sort((a, b) => (a.name + a.architecture).localeCompare(b.name + b.architecture, 'en'));
  const result = { schema: ENVIRONMENT_SCHEMA, profileId, runtime: { ...raw.runtime,
    distribution: { id: identifier(raw.runtime.distribution.id, 80), version: version(raw.runtime.distribution.version, 80) } },
  r, packages, systemPackages, lock: { format: 'installed-package-inventory.v1', sourceArchivesIncluded: false } };
  if (environmentBytes(result).length > MAX_ENVIRONMENT_BYTES) throw error('R_ENVIRONMENT_INVALID', 'The recorded R environment exceeds its size limit.');
  return canonical(result);
}
function summarizeEnvironmentManifest(raw) {
  const manifest = validateEnvironmentManifest(raw);
  const manifestSha256 = crypto.createHash('sha256').update(environmentBytes(manifest)).digest('hex');
  return { id: 'renv_' + manifestSha256, manifestSha256, profileId: manifest.profileId,
    rVersion: manifest.r.version, bioconductor: manifest.r.bioconductor,
    imageDigest: manifest.runtime.imageDigest, imageId: manifest.runtime.imageId, snapshotScope: 'container-userspace' };
}
function validateEnvironmentReference(raw) {
  record(raw, REFERENCE_KEYS);
  if (!HASH.test(raw.manifestSha256 || '') || raw.id !== 'renv_' + raw.manifestSha256
      || !SHA256.test(raw.imageDigest || '') || !SHA256.test(raw.imageId || '')
      || raw.snapshotScope !== 'container-userspace' || !/^\d+\.\d+\.\d+$/.test(raw.rVersion || '')
      || !/^\d+\.\d+$/.test(raw.bioconductor || '')) throw error('R_ENVIRONMENT_INVALID', 'The immutable R environment reference is invalid.');
  if (!PROFILE_ID.test(raw.profileId || '')) throw error('R_ENVIRONMENT_INVALID', 'The R environment profile is invalid.');
  return { ...raw };
}
function assertEnvironmentMatches(expected, actual) {
  const left = validateEnvironmentReference(expected), right = validateEnvironmentReference(actual);
  if (REFERENCE_KEYS.some(key => left[key] !== right[key])) throw error('R_ENVIRONMENT_MISMATCH', 'The exact R environment for this run is unavailable. Restore its pinned runtime image and package lock before retrying.');
  return right;
}
function pinExpertREnvironment(parameters, manifest) {
  const environment = summarizeEnvironmentManifest(manifest);
  if (parameters.profileId !== environment.profileId) throw error('R_ENVIRONMENT_MISMATCH', 'The selected R profile does not match the available exact environment.');
  if (parameters.environment) assertEnvironmentMatches(parameters.environment, environment);
  return { ...parameters, environment };
}
async function readEnvironmentArtifact(provider, descriptor, expected) {
  if (!descriptor || typeof descriptor.internalStorageKey !== 'string'
      || !HASH.test(descriptor.checksumSha256 || '') || !Number.isSafeInteger(descriptor.sizeBytes)
      || descriptor.sizeBytes < 1 || descriptor.sizeBytes > MAX_ENVIRONMENT_BYTES) {
    throw error('R_ENVIRONMENT_INVALID', 'The recorded R environment artifact is invalid.');
  }
  const opened = await provider.openVerifiedRead(descriptor.internalStorageKey, descriptor);
  try {
    const buffer = Buffer.alloc(descriptor.sizeBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = await opened.handle.read(buffer,length,buffer.length-length,length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    const bytes = buffer.subarray(0, length);
    if (bytes.length !== descriptor.sizeBytes || bytes.length > MAX_ENVIRONMENT_BYTES) throw error('R_ENVIRONMENT_INVALID', 'The recorded R environment artifact is invalid.');
    // Only interpretation of the bounded, verified manifest is classified here.
    // Storage acquisition, reads and close remain outside this pure boundary.
    try {
      const manifest = validateEnvironmentManifest(JSON.parse(bytes.toString('utf8')));
      const reference = summarizeEnvironmentManifest(manifest);
      if (reference.manifestSha256 !== descriptor.checksumSha256 || !bytes.equals(environmentBytes(manifest))) throw error('R_ENVIRONMENT_INVALID', 'The recorded R environment checksum is invalid.');
      assertEnvironmentMatches(expected, reference);
      return manifest;
    } catch (failure) {
      if (failure instanceof SyntaxError || failure instanceof TypeError) throw error('R_ENVIRONMENT_INVALID', 'The recorded R environment manifest is invalid.');
      throw failure;
    }
  } finally { await opened.handle.close(); }
}
module.exports = { ENVIRONMENT_SCHEMA, MAX_ENVIRONMENT_BYTES, environmentBytes,
  validateEnvironmentManifest, summarizeEnvironmentManifest, validateEnvironmentReference,
  assertEnvironmentMatches, pinExpertREnvironment, readEnvironmentArtifact };
