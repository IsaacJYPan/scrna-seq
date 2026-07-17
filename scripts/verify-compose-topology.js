#!/usr/bin/env node

'use strict';

const assert = require('assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const composeFile = path.join(root, 'deploy', 'compose.single-host.yml');
const envFile = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(root, 'deploy', 'single-host.env.example');
function renderCompose(extraEnvironment = {}) {
  const rendered = spawnSync(
    'docker',
    ['compose', '--env-file', envFile, '--profile', 'operations', '-f', composeFile, 'config', '--format', 'json'],
    {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, ...extraEnvironment },
    }
  );
  if (rendered.status !== 0) throw new Error('Docker Compose could not render the supported topology.');
  try {
    return JSON.parse(rendered.stdout);
  } catch {
    throw new Error('Docker Compose returned an invalid JSON model.');
  }
}

const model = renderCompose();
const services = model.services || {};

function durationMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value / 1_000_000;
  const match = String(value || '').match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$/);
  assert(match, `invalid Compose duration: ${value}`);
  return Number(match[1] || 0) * 3_600_000
    + Number(match[2] || 0) * 60_000
    + Number(match[3] || 0) * 1000;
}
assert.deepEqual(
  Object.keys(services).sort(),
  ['namespace-anchor', 'operations', 'postgres', 'r', 'restore-operations', 'web', 'worker'],
  'supported service set changed without updating the topology contract'
);
assert.notEqual(model.networks?.['private-backend']?.external, true, 'backend network must remain project-scoped');

const anchorPorts = services['namespace-anchor'].ports || [];
assert.equal(anchorPorts.length, 1, 'exactly one host port may be published');
assert.equal(anchorPorts[0].host_ip, '127.0.0.1', 'web ingress must bind only to host loopback');
assert.equal(Number(anchorPorts[0].target), 3000, 'only the web listener may be published');

for (const [name, service] of Object.entries(services)) {
  if (name !== 'namespace-anchor') {
    assert.equal((service.ports || []).length, 0, `${name} must not publish a host port`);
    assert.equal(service.network_mode, 'service:namespace-anchor', `${name} must share the private namespace`);
  }
  assert.equal(service.deploy?.replicas, 1, `${name} must remain a single replica`);
  assert.equal(service.read_only, true, `${name} root filesystem must be read-only`);
  assert(service.cap_drop?.includes('ALL'), `${name} must drop Linux capabilities`);
  assert(service.security_opt?.includes('no-new-privileges:true'), `${name} must disable privilege escalation`);
}

function isNonRootIdentity(identityValue) {
  const identity = String(identityValue || '').trim();
  if (!identity) return false;
  const [user, group] = identity.toLowerCase().split(':');
  if (user === 'root' || (/^\d+$/.test(user) && Number(user) === 0)) return false;
  if (group === 'root' || (/^\d+$/.test(group) && Number(group) === 0)) return false;
  return true;
}

function isCanonicalNumericIdentity(identityValue) {
  const [user, group, extra] = String(identityValue || '').trim().split(':');
  if (extra !== undefined || !/^[1-9][0-9]{0,9}$/.test(user || '') || !/^[1-9][0-9]{0,9}$/.test(group || '')) {
    return false;
  }
  return Number(user) <= 2147483647 && Number(group) <= 2147483647;
}

function assertNonRootUser(name) {
  const identity = services[name].user;
  assert(identity, `${name} must declare an explicit user`);
  assert(isNonRootIdentity(identity), `${name} must run with a non-root user and group`);
}

for (const name of ['namespace-anchor', 'r', 'web', 'worker', 'operations', 'restore-operations']) {
  assertNonRootUser(name);
  assert(isCanonicalNumericIdentity(services[name].user), `${name} must use canonical positive numeric UID:GID values`);
  assert.equal(services[name].init, true, `${name} must have an init process`);
}
assertNonRootUser('postgres');

for (const name of ['namespace-anchor', 'postgres', 'r', 'web', 'worker', 'operations', 'restore-operations']) {
  const service = services[name];
  assert(Number(service.mem_limit) > 0, `${name} must have a memory limit`);
  assert(Number(service.cpus) > 0, `${name} must have a CPU limit`);
  assert(Number(service.pids_limit) > 0, `${name} must have a PID limit`);
}
for (const name of ['postgres', 'r', 'web', 'worker']) {
  assert(services[name].healthcheck, `${name} must have a health check`);
}

assert.equal(services.web.environment?.NODE_ENV, 'production');
assert.equal(services.web.environment?.COOKIE_SECURE, 'true');
assert.equal(services.web.environment?.ENABLE_JOB_WORKER, 'false');
assert.equal(services.worker.environment?.ENABLE_JOB_WORKER, 'true');
assert.equal(services.worker.environment?.JOB_WORKER_CONCURRENCY, '1');
assert.equal(services.web.environment?.R_RUNTIME_MODE, 'external');
assert.equal(services.worker.environment?.R_RUNTIME_MODE, 'external');
assert.equal(services.r.environment?.PLUMBER_HOST, '127.0.0.1');
assert.equal(services.operations.restart, 'no');
assert.equal(services['restore-operations'].restart, 'no');
assert(services.operations.profiles?.includes('operations'), 'operations must remain opt-in');
assert(services['restore-operations'].profiles?.includes('operations'), 'restore operations must remain opt-in');
assert(!Object.hasOwn(services.web.depends_on || {}, 'r'), 'web metadata availability must not depend on R health');
assert(
  (services.postgres.tmpfs || []).some((entry) => String(entry).startsWith('/var/run/postgresql:') && String(entry).includes('mode=1777')),
  'Postgres bootstrap socket must use a sticky writable container-private tmpfs'
);
assert(
  services.postgres.command?.join(' ').includes('listen_addresses=127.0.0.1'),
  'Postgres must listen only inside the shared loopback namespace'
);
assert(services.postgres.healthcheck?.test?.join(' ').includes('-h 127.0.0.1'), 'Postgres health must use private TCP');

const backupMount = (services.operations.volumes || []).find((volume) => volume.target === '/app/backups');
assert.equal(backupMount?.type, 'bind', 'backups must leave application-managed volumes');
assert.notEqual(backupMount?.read_only, true, 'backup operations need a writable destination');
const restoreBackupMount = (services['restore-operations'].volumes || [])
  .find((volume) => volume.target === '/app/backups');
assert.equal(restoreBackupMount?.type, 'bind', 'restore input must use the operator backup bind');
assert.equal(restoreBackupMount?.read_only, true, 'restore input must be mounted read-only');
assert.equal(restoreBackupMount?.source, backupMount?.source, 'backup and restore must use the same operator path');

function isPortableAbsolute(value) {
  return path.posix.isAbsolute(value) || path.win32.isAbsolute(value);
}

function isPortableFilesystemRoot(value) {
  if (path.win32.isAbsolute(value)) return path.win32.normalize(value) === path.win32.parse(value).root;
  if (path.posix.isAbsolute(value)) return path.posix.normalize(value) === path.posix.parse(value).root;
  return false;
}

function pathWithin(parent, child, pathApi) {
  const relative = pathApi.relative(pathApi.resolve(parent), pathApi.resolve(child));
  return relative === '' || (!relative.startsWith(`..${pathApi.sep}`) && relative !== '..' && !pathApi.isAbsolute(relative));
}

function isSafeBackupHostPath(value) {
  const source = String(value || '');
  if (!isPortableAbsolute(source) || isPortableFilesystemRoot(source)) return false;
  if (path.win32.isAbsolute(source) && path.win32.isAbsolute(root) && pathWithin(root, source, path.win32)) return false;
  if (path.posix.isAbsolute(source) && path.posix.isAbsolute(root) && pathWithin(root, source, path.posix)) return false;
  return true;
}

assert(isSafeBackupHostPath(backupMount?.source), 'BACKUP_HOST_PATH must be an absolute non-root path outside the repository');

for (const name of ['r', 'web', 'worker', 'operations', 'restore-operations']) {
  for (const [envName, mountTarget] of [
    ['STORAGE_ROOT', '/app/storage-volume'],
    ['VAULT_ROOT', '/app/vault-volume'],
  ]) {
    const root = services[name].environment?.[envName];
    const mount = (services[name].volumes || []).find((volume) => volume.target === mountTarget);
    assert(mount && mount.type === 'volume', `${name} ${envName} parent must be a named volume`);
    assert(root?.startsWith(`${mountTarget}/`), `${name} ${envName} must be a child of its volume mount`);
    assert.notEqual(root, mountTarget, `${name} ${envName} must not be the unrenameable mount root`);
  }
}
assert(durationMs(services.web.stop_grace_period) >= 150_000, 'web stop grace must cover its drain budget');
assert(durationMs(services.worker.stop_grace_period) >= 630_000, 'worker stop grace must cover its drain budget');
assert(durationMs(services.r.stop_grace_period) >= durationMs(services.worker.stop_grace_period), 'R must outlive worker drain');

const rootUidModel = renderCompose({ APP_UID: '0' });
assert.equal(isNonRootIdentity(rootUidModel.services.web.user), false, 'root APP_UID must be detected');
const rootGidModel = renderCompose({ APP_GID: '0' });
assert.equal(isNonRootIdentity(rootGidModel.services.web.user), false, 'root APP_GID must be detected');
const namedUidModel = renderCompose({ APP_UID: 'not-a-user' });
assert.equal(isCanonicalNumericIdentity(namedUidModel.services.web.user), false, 'nonnumeric APP_UID must be detected');

console.log('[compose-topology] passed: private single-host namespace, loopback-only ingress, root override rejection, non-root/read-only services, restorable volume layout, resource limits, and drain ordering');
