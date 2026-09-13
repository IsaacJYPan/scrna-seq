#!/usr/bin/env node

'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const composeFile = path.join(root, 'deploy', 'compose.single-host.yml');
const demoComposeFile = path.join(root, 'deploy', 'compose.demo.yml');
const demoFreeTierComposeFile = path.join(root, 'deploy', 'compose.demo-free-tier.yml');
const demoFreeTierCaddyfile = path.join(root, 'deploy', 'Caddyfile.demo-free-tier');
const envFile = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(root, 'deploy', 'single-host.env.example');
function renderCompose(extraEnvironment = {}, profiles = ['operations']) {
  const rendered = spawnSync(
    'docker',
    ['compose', '--env-file', envFile,
      ...profiles.flatMap((profile) => ['--profile', profile]),
      '-f', composeFile, 'config', '--format', 'json'],
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

function renderDemoCompose() {
  const rendered = spawnSync(
    'docker',
    ['compose', '--env-file', envFile, '--profile', 'demo-ops',
      '-f', composeFile, '-f', demoComposeFile, 'config', '--format', 'json'],
    {
      cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, DEMO_TEMPLATE_PROJECT_ID: 'proj_curated123' },
    }
  );
  if (rendered.status !== 0) throw new Error('Docker Compose could not render the public demo topology.');
  return JSON.parse(rendered.stdout);
}

function renderDemoFreeTierCompose() {
  const rendered = spawnSync(
    'docker',
    ['compose', '--env-file', envFile, '--profile', 'demo-ops', '--profile', 'demo-bootstrap',
      '-f', composeFile, '-f', demoComposeFile, '-f', demoFreeTierComposeFile,
      'config', '--format', 'json'],
    {
      cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 3 * 1024 * 1024,
      env: {
        ...process.env,
        DEMO_TEMPLATE_PROJECT_ID: 'proj_curated123',
        PUBLIC_HOST: 'demo.example.invalid',
        FRONTEND_ORIGIN: 'https://demo.example.invalid',
      },
    }
  );
  if (rendered.status !== 0) throw new Error('Docker Compose could not render the free-tier demo topology.');
  return JSON.parse(rendered.stdout);
}

const model = renderCompose();
const services = model.services || {};
const demoModel = renderDemoCompose();
const demoServices = demoModel.services || {};
const demoFreeTierModel = renderDemoFreeTierCompose();
const demoFreeTierServices = demoFreeTierModel.services || {};
assert.equal(demoServices.web.environment?.APP_DEPLOYMENT_MODE, 'demo');
assert.equal(demoServices.web.environment?.EXPERT_R_ENABLED, 'false');
assert.equal(demoServices.web.environment?.MAX_UPLOAD_BYTES, '1');
assert.equal(demoServices['worker-compute-1'].environment?.EXPERT_R_ENABLED, 'false');
assert.equal(demoServices['worker-compute-2'].environment?.EXPERT_R_ENABLED, 'false');
assert(demoServices['demo-cleanup'], 'demo topology must include opt-in expiry cleanup');
assert(demoServices['demo-cleanup'].profiles?.includes('demo-ops'), 'demo cleanup must remain opt-in');
assert.equal((demoServices['demo-cleanup'].ports || []).length, 0, 'demo cleanup must not publish ports');
assert.equal(demoServices['demo-cleanup'].read_only, true, 'demo cleanup root must be read-only');
const caddy = demoFreeTierServices.caddy;
assert(caddy, 'free-tier demo must include its TLS edge');
assert.equal(caddy.read_only, true, 'free-tier TLS edge root must be read-only');
assert(caddy.cap_drop?.includes('ALL'), 'free-tier TLS edge must drop ambient capabilities');
assert.deepEqual(caddy.cap_add, ['NET_BIND_SERVICE'], 'free-tier TLS edge may add only bind-service capability');
assert(caddy.security_opt?.includes('no-new-privileges:true'), 'free-tier TLS edge must disable privilege escalation');
assert.deepEqual((caddy.ports || []).map(port => (
  `${Number(port.published)}:${Number(port.target)}/${port.protocol}`
)).sort(), ['443:443/tcp', '443:443/udp', '80:80/tcp']);
assert((caddy.volumes || []).some(volume => volume.target === '/data' && volume.type === 'volume'),
  'free-tier TLS certificate data must be persistent');
assert.equal(demoFreeTierServices.web.environment?.APP_DEPLOYMENT_MODE, 'demo');
assert.equal(demoFreeTierServices.web.environment?.MAX_UPLOAD_BYTES, '1');
for (const name of ['demo-template-prepare', 'demo-template-r', 'demo-template-finalize']) {
  const service = demoFreeTierServices[name];
  assert(service?.profiles?.includes('demo-bootstrap'), `${name} must remain operator-only`);
  assert.equal((service.ports || []).length, 0, `${name} must not publish ports`);
  assert.equal(service.read_only, true, `${name} root must be read-only`);
  assert(service.cap_drop?.includes('ALL'), `${name} must drop capabilities`);
  assert(service.security_opt?.includes('no-new-privileges:true'), `${name} must disable privilege escalation`);
}
const runningFreeTierServices = [
  'namespace-anchor', 'postgres', 'storage-init', 'r', 'r-compute-1', 'r-compute-2',
  'web', 'worker', 'worker-compute-1', 'worker-compute-2', 'caddy',
];
const totalMemoryLimit = runningFreeTierServices.reduce(
  (total, name) => total + Number(demoFreeTierServices[name]?.mem_limit || 0), 0
);
assert(totalMemoryLimit <= 10.5 * 1024 * 1024 * 1024,
  'free-tier steady-state container memory limits must leave host/Docker headroom on a 12-GB VM');
assert.equal(Number(demoFreeTierServices['r-compute-1'].mem_limit), 2560 * 1024 * 1024);
assert.equal(Number(demoFreeTierServices['r-compute-2'].mem_limit), 2560 * 1024 * 1024);
assert.equal(demoFreeTierServices.worker.environment?.JOB_WORKER_MIN_FREE_MEMORY_MB, '256');
const caddyfile = fs.readFileSync(demoFreeTierCaddyfile, 'utf8');
assert(caddyfile.includes('path /livez /readyz /api/auth/signup'),
  'free-tier edge must hide health routes and the disabled signup route');
assert(caddyfile.includes('reverse_proxy namespace-anchor:3000'),
  'free-tier edge must proxy only to the private web namespace');
const expertModel = renderCompose({}, ['operations', 'expert-r']);
const expertBroker = expertModel.services?.['expert-r-broker'];
assert(expertBroker, 'Expert R profile must define its isolated broker');
assert.equal((expertBroker.ports || []).length, 0, 'Expert R broker must not publish a host port');
assert(expertBroker.profiles?.includes('expert-r'), 'Expert R broker must remain opt-in');
assert.equal(expertBroker.read_only, true, 'Expert R broker root must be read-only');
assert(expertBroker.cap_drop?.includes('ALL'), 'Expert R broker must drop capabilities');
assert(expertBroker.security_opt?.includes('no-new-privileges:true'), 'Expert R broker must disable privilege escalation');
assert.equal(expertBroker.network_mode, 'service:namespace-anchor', 'Expert R broker must use the private shared namespace');
assert.equal(expertBroker.environment?.EXPERT_R_SANDBOX_HOST, '127.0.0.1', 'Expert R broker must bind only to private loopback');
assert.equal(expertBroker.environment?.EXPERT_R_RUNTIME_ISOLATION, 'dedicated-rootless');
assert.equal(expertBroker.environment?.DOCKER_HOST, 'unix:///run/expert-runtime/docker.sock');
assert(!(expertBroker.volumes || []).some((mount) => mount.source === '/var/run/docker.sock'), 'Expert R broker must not receive the system Docker socket');
assert((expertBroker.volumes || []).some((mount) => mount.source === '/run/user/10001/docker.sock'
  && mount.target === '/run/expert-runtime/docker.sock'), 'Expert R broker requires its dedicated rootless runtime socket');
assert((expertBroker.volumes || []).some((mount) => mount.target === expertBroker.environment.EXPERT_R_SANDBOX_WORK_ROOT), 'Expert R broker work root must use the same host/container path');

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
  [
    'namespace-anchor', 'operations', 'postgres', 'r', 'r-compute-1', 'r-compute-2',
    'restore-operations', 'schema-init', 'storage-init', 'web', 'worker', 'worker-compute-1',
    'worker-compute-2',
  ],
  'supported service set changed without updating the topology contract'
);
const databaseOwner = services.postgres.environment?.POSTGRES_USER;
const runtimeDatabaseUser = services['schema-init'].environment?.APP_DATABASE_USER;
assert(databaseOwner && runtimeDatabaseUser, 'database owner and runtime roles must be configured');
assert.notEqual(runtimeDatabaseUser, databaseOwner, 'the runtime database role must not own the database');
for (const name of ['web', 'worker', 'worker-compute-1', 'worker-compute-2']) {
  assert.equal(services[name].environment?.PGUSER, runtimeDatabaseUser, `${name} must use the non-owner runtime database role`);
}
assert.equal(services.web.environment?.DATABASE_SCHEMA_MANAGED_EXTERNALLY, 'true');
assert.equal(services['schema-init'].environment?.PGUSER, databaseOwner, 'schema-init must receive the database owner role');
assert.equal(services['schema-init'].restart, 'no');
assert.equal(services.operations.environment?.PGUSER, databaseOwner, 'offline operations require the owner role');
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

for (const name of [
  'namespace-anchor', 'storage-init', 'r', 'r-compute-1', 'r-compute-2', 'web', 'worker',
  'worker-compute-1', 'worker-compute-2', 'operations', 'restore-operations',
]) {
  assertNonRootUser(name);
  assert(isCanonicalNumericIdentity(services[name].user), `${name} must use canonical positive numeric UID:GID values`);
  assert.equal(services[name].init, true, `${name} must have an init process`);
}
assertNonRootUser('postgres');

for (const name of [
  'namespace-anchor', 'postgres', 'storage-init', 'r', 'r-compute-1', 'r-compute-2', 'web', 'worker',
  'worker-compute-1', 'worker-compute-2', 'operations', 'restore-operations',
]) {
  const service = services[name];
  assert(Number(service.mem_limit) > 0, `${name} must have a memory limit`);
  assert(Number(service.cpus) > 0, `${name} must have a CPU limit`);
  assert(Number(service.pids_limit) > 0, `${name} must have a PID limit`);
}
for (const name of ['postgres', 'r', 'r-compute-1', 'r-compute-2', 'web', 'worker', 'worker-compute-1', 'worker-compute-2']) {
  assert(services[name].healthcheck, `${name} must have a health check`);
}

assert.equal(services.web.environment?.NODE_ENV, 'production');
assert.equal(services.web.environment?.COOKIE_SECURE, 'true');
assert.equal(services.web.environment?.ENABLE_JOB_WORKER, 'false');
assert(['private', 'byoc', 'shared-private', 'demo'].includes(services.web.environment?.APP_DEPLOYMENT_MODE), 'a supported deployment mode is required');
assert.equal(services.web.environment?.EXPERT_R_SANDBOX_URL, 'http://127.0.0.1:8090');
for (const name of ['worker', 'worker-compute-1', 'worker-compute-2']) {
  assert.equal(services[name].environment?.JOB_WORKER_CONCURRENCY, '1');
  assert.equal(services[name].environment?.ENABLE_JOB_WORKER, 'true');
}
assert.equal(services.web.environment?.R_RUNTIME_MODE, 'external');
assert.equal(services.worker.environment?.R_RUNTIME_MODE, 'external');
for (const name of ['r', 'r-compute-1', 'r-compute-2']) {
  assert.equal(services[name].environment?.PLUMBER_HOST, '127.0.0.1');
}
assert.equal(services.operations.restart, 'no');
assert.equal(services['restore-operations'].restart, 'no');
assert.equal(services['storage-init'].restart, 'no');
assert(services.operations.profiles?.includes('operations'), 'operations must remain opt-in');
assert(services['restore-operations'].profiles?.includes('operations'), 'restore operations must remain opt-in');
assert(!Object.hasOwn(services.web.depends_on || {}, 'r'), 'web metadata availability must not depend on R health');
for (const name of [
  'r', 'r-compute-1', 'r-compute-2', 'web', 'worker', 'worker-compute-1',
  'worker-compute-2', 'operations', 'restore-operations',
]) {
  assert.equal(
    services[name].depends_on?.['storage-init']?.condition,
    'service_completed_successfully',
    `${name} must wait for the single shared-volume initializer`
  );
}
assert.equal(
  demoServices['demo-cleanup'].depends_on?.['storage-init']?.condition,
  'service_completed_successfully',
  'demo cleanup must wait for the shared-volume initializer'
);
for (const target of ['/app/storage-volume', '/app/vault-volume']) {
  const mount = (services['storage-init'].volumes || []).find((volume) => volume.target === target);
  assert(mount && mount.type === 'volume', `storage initializer must mount ${target}`);
}
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

for (const name of [
  'r', 'r-compute-1', 'r-compute-2', 'web', 'worker', 'worker-compute-1',
  'worker-compute-2', 'operations', 'restore-operations',
]) {
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
for (const name of ['r', 'r-compute-1', 'r-compute-2']) {
  assert(durationMs(services[name].stop_grace_period) >= durationMs(services.worker.stop_grace_period), `${name} must outlive interactive worker drain`);
  assert(durationMs(services[name].stop_grace_period) >= durationMs(services['worker-compute-1'].stop_grace_period), `${name} must outlive compute worker drain`);
}

const rootUidModel = renderCompose({ APP_UID: '0' });
assert.equal(isNonRootIdentity(rootUidModel.services.web.user), false, 'root APP_UID must be detected');
const rootGidModel = renderCompose({ APP_GID: '0' });
assert.equal(isNonRootIdentity(rootGidModel.services.web.user), false, 'root APP_GID must be detected');
const namedUidModel = renderCompose({ APP_UID: 'not-a-user' });
assert.equal(isCanonicalNumericIdentity(namedUidModel.services.web.user), false, 'nonnumeric APP_UID must be detected');

console.log('[compose-topology] passed: private single-host namespace, loopback-only ingress, root override rejection, non-root/read-only services, restorable volume layout, resource limits, and drain ordering');
