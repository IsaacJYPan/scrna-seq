#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { parseArgs } = require('util');
const { expertRProfileProbeCode } = require('../backend/expertR');

function docker(args) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 90000,
    maxBuffer: 1024 * 1024, windowsHide: true });
  if (result.error || result.status !== 0) {
    throw new Error('The dedicated R runtime preflight failed. Check Docker access, the pinned image, and the documented rootless prerequisites.');
  }
  return result.stdout.trim();
}

function readDeploymentEnv(filename) {
  const values = {};
  for (const line of fs.readFileSync(filename, 'utf8').split(/\r?\n/)) {
    const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (match) values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return values;
}

function validatePrivateROptions(options, deployment) {
  if (!['private', 'byoc', 'shared-private'].includes(deployment.APP_DEPLOYMENT_MODE)) {
    throw new Error('Private R setup requires APP_DEPLOYMENT_MODE=private, byoc, or shared-private in the deployment environment.');
  }
  if (!/^(?:[A-Za-z0-9][A-Za-z0-9._:/-]*@)?sha256:[0-9a-f]{64}$/.test(options.image || '')) {
    throw new Error('Choose an immutable R image digest, such as traceomics-r@sha256:… .');
  }
  for (const [label, value] of [['socket', options.socket], ['work-root', options.workRoot]]) {
    if (typeof value !== 'string' || !path.posix.isAbsolute(value) || value === '/'
        || /[\s\0$#'"`\\]/.test(value) || path.posix.normalize(value) !== value) {
      throw new Error(`The ${label} must be an absolute normalized Linux path without whitespace or shell substitutions.`);
    }
  }
  if (options.socket === '/var/run/docker.sock' || options.socket === '/run/docker.sock') {
    throw new Error('The application Docker socket cannot be used for R execution. Choose the dedicated rootless runtime socket.');
  }
  if (['/etc', '/usr', '/bin', '/sbin', '/proc', '/sys', '/dev', '/run'].some((root) => options.workRoot === root || options.workRoot.startsWith(`${root}/`))) {
    throw new Error('Choose a persistent private work directory outside system/runtime directories.');
  }
}

function preflightPrivateR(options, deployment, { runDocker = docker, filesystem = fs } = {}) {
  validatePrivateROptions(options, deployment);
  const socket = filesystem.lstatSync(options.socket);
  const work = filesystem.lstatSync(options.workRoot);
  if (!socket.isSocket() || socket.isSymbolicLink() || !work.isDirectory() || work.isSymbolicLink()
      || filesystem.realpathSync(options.socket) !== options.socket || filesystem.realpathSync(options.workRoot) !== options.workRoot) {
    throw new Error('The R runtime socket and existing work directory must be real, non-symlinked paths.');
  }
  const appUid = Number(deployment.APP_UID || 10001);
  const appGid = Number(deployment.APP_GID || 10001);
  if (!Number.isSafeInteger(appUid) || appUid <= 0 || !Number.isSafeInteger(appGid) || appGid <= 0) {
    throw new Error('Private R requires a non-root APP_UID and APP_GID.');
  }
  if (socket.uid !== appUid || work.uid !== appUid || work.gid !== appGid || (work.mode & 0o077) !== 0) {
    throw new Error('The rootless daemon and mode-0700 work root must belong to the installation APP_UID/APP_GID. See the private R deployment prerequisites.');
  }
  const host = ['--host', `unix://${options.socket}`];
  let security;
  try { security = JSON.parse(runDocker([...host, 'info', '--format', '{{json .SecurityOptions}}'])); }
  catch { throw new Error('The R runtime security options could not be verified.'); }
  if (!Array.isArray(security) || !security.includes('name=rootless')) {
    throw new Error('The dedicated R runtime must report rootless isolation.');
  }
  const containers = runDocker([...host, 'ps', '-a', '--format', '{{.Label "org.traceomics.expert"}}']);
  if (containers.split(/\r?\n/).some((label) => label && label !== 'true') || containers === '\n') {
    throw new Error('The rootless daemon contains unrelated workloads. Reserve a separate daemon for R.');
  }
  // Inspect every existing container so an empty label cannot hide unrelated work.
  const ids = runDocker([...host, 'ps', '-a', '--format', '{{.ID}}']);
  if (ids && ids.split(/\r?\n/).length !== containers.split(/\r?\n/).filter(Boolean).length) {
    throw new Error('The rootless daemon contains unrelated workloads. Reserve a separate daemon for R.');
  }
  const imageId = runDocker([...host, 'image', 'inspect', options.image, '--format', '{{.Id}}']);
  if (!/^sha256:[0-9a-f]{64}$/.test(imageId)) throw new Error('The pinned image identity could not be verified.');
  const expression = `${expertRProfileProbeCode()}; stopifnot(identical(readLines('/work/input/probe.txt'), 'private-r-read-check')); write.csv(data.frame(cells=3), '/work/output/cell-count.csv', row.names=FALSE); stopifnot(file.exists('/work/output/cell-count.csv')); blocked <- inherits(try(writeLines('changed', '/work/input/probe.txt'), silent=TRUE), 'try-error'); stopifnot(blocked); cat('private-r-profile-ok')`;
  const directory = filesystem.mkdtempSync(path.posix.join(options.workRoot, '.private-r-preflight-'));
  if (!directory.startsWith(`${options.workRoot}/.private-r-preflight-`)
      || filesystem.realpathSync(directory) !== directory) throw new Error('The temporary runtime check directory could not be verified.');
  try {
    filesystem.chmodSync(directory, 0o700);
    const input = path.posix.join(directory, 'input');
    filesystem.mkdirSync(input, { mode: 0o700 });
    filesystem.writeFileSync(path.posix.join(input, 'probe.txt'), 'private-r-read-check\n', { flag: 'wx', mode: 0o444 });
    filesystem.chmodSync(input, 0o555);
    const profile = runDocker([...host, 'run', '--rm', '--network=none', '--read-only',
      '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=256',
      '--memory=4g', '--cpus=1', '--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=512m',
      '--user', '10001:10001', '--mount', `type=bind,src=${input},dst=/work/input,ro`,
      '--tmpfs=/work/output:rw,noexec,nosuid,nodev,size=209715200,nr_inodes=1024,mode=1777',
      '--entrypoint', 'Rscript', options.image, '-e', expression]);
    if (!profile.includes('private-r-profile-ok')) throw new Error('The pinned R image did not pass its profile and private input/output checks.');
  } finally {
    // Only remove the freshly created, verified child of the supplied work root.
    if (filesystem.realpathSync(directory) === directory
        && directory.startsWith(`${options.workRoot}/.private-r-preflight-`)) {
      const input = path.posix.join(directory, 'input');
      if (filesystem.existsSync(input)) filesystem.chmodSync(input, 0o700);
      filesystem.rmSync(directory, { recursive: true, force: true });
    }
  }
  return { uid: appUid, gid: appGid };
}

function privateREnvironment(options, identity) {
  return ['# Private R execution. Keep this generated credential file local.',
    'EXPERT_R_ENABLED=true', 'EXPERT_R_ACCESS_POLICY=project-roles',
    'PRIVATE_R_KERNEL_ENABLED=true',
    `EXPERT_R_SANDBOX_TOKEN=${crypto.randomBytes(32).toString('hex')}`,
    `EXPERT_R_SANDBOX_IMAGE=${options.image}`, `EXPERT_R_RUNTIME_SOCKET=${options.socket}`,
    `EXPERT_R_SANDBOX_HOST_WORK_ROOT=${options.workRoot}`,
    `EXPERT_R_BROKER_UID=${identity.uid}`, `EXPERT_R_BROKER_GID=${identity.gid}`, ''].join('\n');
}

function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: {
    'deployment-env': { type: 'string' }, image: { type: 'string' }, socket: { type: 'string' },
    'work-root': { type: 'string' }, output: { type: 'string', default: 'deploy/private-r.env' }, help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log('Usage: node scripts/configure-private-r.js --deployment-env /private/install.env --image IMAGE@sha256:DIGEST --socket /run/user/10001/docker.sock --work-root /srv/traceomics-expert [--output deploy/private-r.env]');
    console.log('Requires a dedicated Linux rootless Docker daemon, a preloaded pinned R image, and a mode-0700 work root owned by APP_UID/APP_GID. See docs/deployment.md.');
    return;
  }
  if (!values['deployment-env']) throw new Error('Supply the existing private deployment environment with --deployment-env.');
  const options = { image: values.image, socket: values.socket, workRoot: values['work-root'] };
  if (fs.existsSync(values.output)) throw new Error('The output already exists; configuration and credentials will not be replaced.');
  const deployment = readDeploymentEnv(values['deployment-env']);
  const identity = preflightPrivateR(options, deployment);
  fs.writeFileSync(values.output, privateREnvironment(options, identity), { flag: 'wx', mode: 0o600 });
  console.log(`Created ${values.output}. The runtime, package profile and private input/output mounts passed preflight.`);
  console.log('Start the private stack with both environment files and the expert-r profile:');
  console.log('docker compose --env-file <installation.env> --env-file <private-r.env> -f deploy/compose.single-host.yml --profile expert-r up -d');
  console.log('Use the application runtime to start the stack; reserve the dedicated rootless daemon for R workloads.');
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { validatePrivateROptions, preflightPrivateR, privateREnvironment, readDeploymentEnv, main };
