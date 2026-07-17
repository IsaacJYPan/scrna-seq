#!/usr/bin/env node

'use strict';

const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const composeFile = path.join(root, 'deploy', 'compose.single-host.yml');
const smokeOverride = path.join(root, 'deploy', 'compose.test-smoke.yml');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'benchone-compose-drill-'));
const backupRoot = path.join(tempRoot, 'backups');
const sourceEnv = path.join(tempRoot, 'source.env');
const targetEnv = path.join(tempRoot, 'target.env');
const suffix = `${process.pid}${crypto.randomBytes(4).toString('hex')}`.toLowerCase();
const sourceProject = `b7ops${suffix}src`;
const targetProject = `b7ops${suffix}dst`;
const secrets = [];

function randomSecret() {
  const value = crypto.randomBytes(32).toString('hex');
  secrets.push(value);
  return value;
}

function randomSessionEpoch() {
  return crypto.randomBytes(16).toString('hex');
}

function safeProject(value) {
  if (!/^b7ops[0-9a-f]+(?:src|dst)$/.test(value)) throw new Error('Unsafe disposable Compose project name.');
  return value;
}

function redact(value) {
  let output = String(value || '');
  for (const secret of secrets) output = output.split(secret).join('[redacted]');
  return output.slice(-6000);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
    timeout: 240000,
    ...options,
  });
  if (result.error) {
    throw new Error(`${path.basename(command)} step could not complete. ${redact(result.error.message)}`);
  }
  if (result.status !== 0) {
    throw new Error(`${path.basename(command)} step failed. ${redact(result.stderr)} ${redact(result.stdout)}`.trim());
  }
  return result.stdout;
}

function compose(project, envFile, args, options = {}) {
  safeProject(project);
  return run('docker', [
    'compose', '-p', project,
    '--env-file', envFile,
    '-f', composeFile,
    '-f', smokeOverride,
    ...args,
  ], options);
}

function unusedPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function writeEnvironment(file, port, credentials) {
  const portableBackupRoot = backupRoot.replace(/\\/g, '/');
  fs.writeFileSync(file, [
    'FRONTEND_ORIGIN=https://compose-smoke.example.test',
    `WEB_PORT=${port}`,
    'TRUST_PROXY_HOPS=1',
    'COOKIE_SAMESITE=Lax',
    `SESSION_SECRET=${credentials.sessionSecret}`,
    `SESSION_EPOCH=${credentials.sessionEpoch}`,
    `R_API_TOKEN=${credentials.rToken}`,
    `POSTGRES_PASSWORD=${credentials.databasePassword}`,
    'POSTGRES_USER=benchone',
    'POSTGRES_DB=benchone',
    'APP_IMAGE=scrna-seq-workbench:ci',
    'OPS_IMAGE=scrna-seq-operations:ci',
    'R_IMAGE=scrna-seq-workbench:ci',
    'NAMESPACE_IMAGE=alpine:3.21',
    'POSTGRES_IMAGE=postgres:16-alpine',
    `BACKUP_HOST_PATH=${portableBackupRoot}`,
    'APP_UID=10001',
    'APP_GID=10001',
    'POSTGRES_MEMORY_LIMIT=512m',
    'POSTGRES_CPU_LIMIT=1',
    'POSTGRES_SHM_SIZE=128m',
    'R_MEMORY_LIMIT=512m',
    'R_CPU_LIMIT=1',
    'WEB_MEMORY_LIMIT=512m',
    'WEB_CPU_LIMIT=1',
    'WORKER_MEMORY_LIMIT=512m',
    'WORKER_CPU_LIMIT=1',
    'OPS_MEMORY_LIMIT=512m',
    'OPS_CPU_LIMIT=1',
    'JOB_WORKER_MIN_FREE_MEMORY_MB=1',
    '',
  ].join('\n'), { encoding: 'utf8', mode: 0o600 });
}

async function waitForReady(port, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let lastFailure = 'no response';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/readyz`, {
        // Production accepts plaintext only behind the configured same-host
        // proxy. This host-side probe emulates that single trusted hop.
        headers: {
          'X-Forwarded-Proto': 'https',
          'X-Forwarded-For': '127.0.0.1',
        },
      });
      if (response.ok) return response.json();
      lastFailure = `HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`;
    } catch (error) {
      lastFailure = error && error.message ? error.message : 'connection failed';
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Compose web readiness timed out (${lastFailure}).`);
}

function assertPublishedPort(project, envFile, expectedPort) {
  const published = compose(project, envFile, ['port', 'namespace-anchor', '3000']).trim();
  assert.match(published, new RegExp(`^127\\.0\\.0\\.1:${expectedPort}$`), 'Compose ingress did not publish the reserved loopback port');
}

function down(project, envFile) {
  try {
    compose(project, envFile, ['down', '--volumes', '--remove-orphans', '--timeout', '20']);
  } catch {
    // Preserve the primary failure. The unique project name fences cleanup.
  }
}

function printDiagnostics(project, envFile) {
  for (const args of [
    ['ps', '--all'],
    ['logs', '--no-color', '--tail', '200'],
  ]) {
    try {
      console.error(redact(compose(project, envFile, args)));
    } catch (error) {
      console.error(`[compose-operations-drill] diagnostic failed: ${redact(error.message)}`);
    }
  }
}

async function main() {
  fs.mkdirSync(backupRoot, { mode: 0o777 });
  try { fs.chmodSync(backupRoot, 0o777); } catch { /* Docker Desktop bind semantics */ }
  const credentials = {
    sessionSecret: randomSecret(),
    rToken: randomSecret(),
    databasePassword: randomSecret(),
  };
  const sourcePort = await unusedPort();
  const targetPort = await unusedPort();
  writeEnvironment(sourceEnv, sourcePort, { ...credentials, sessionEpoch: randomSessionEpoch() });
  writeEnvironment(targetEnv, targetPort, { ...credentials, sessionEpoch: randomSessionEpoch() });

  try {
    compose(sourceProject, sourceEnv, [
      'up', '-d', '--no-build', '--wait', '--wait-timeout', '120',
      'namespace-anchor', 'postgres', 'r', 'web', 'worker',
    ]);
    assertPublishedPort(sourceProject, sourceEnv, sourcePort);
    const sourceReady = await waitForReady(sourcePort);
    assert.equal(sourceReady.status, 'ready');
    assert.equal(sourceReady.computeDegraded, false);

    const operatorPassword = randomSecret();
    const created = compose(sourceProject, sourceEnv, [
      '--profile', 'operations', 'run', '-T', '--rm', '--no-deps', 'operations',
      'scripts/account-admin.js', 'create',
      '--email', 'restore-operator@example.invalid',
      '--display-name', 'Restore Operator',
      '--password-stdin',
    ], { input: operatorPassword });
    assert(!created.includes(operatorPassword), 'operations account CLI exposed its password');
    const granted = compose(sourceProject, sourceEnv, [
      '--profile', 'operations', 'run', '-T', '--rm', '--no-deps', 'operations',
      'scripts/manage-platform-developer.js', 'grant', 'restore-operator@example.invalid',
    ]);
    assert.match(granted, /pipeline_registry\.publish=granted audit_event=\d+/,
      'operations capability CLI did not report its audit event');

    compose(sourceProject, sourceEnv, [
      'exec', '-T', 'web', 'node', '-e',
      "require('fs').writeFileSync(require('path').join(process.env.STORAGE_ROOT,'compose-sentinel.txt'),'compose-restore-v1')",
    ]);
    compose(sourceProject, sourceEnv, ['stop', '--timeout', '30', 'web', 'worker', 'r']);
    compose(sourceProject, sourceEnv, [
      '--profile', 'operations', 'run', '--rm', '--no-deps', 'operations',
      'scripts/backup-runtime.js',
      '--destination', '/app/backups/source-backup',
      '--confirm-offline', 'I_CONFIRM_WRITES_ARE_STOPPED',
    ]);

    compose(targetProject, targetEnv, [
      'up', '-d', '--no-build', '--wait', '--wait-timeout', '120',
      'namespace-anchor', 'postgres',
    ]);
    assertPublishedPort(targetProject, targetEnv, targetPort);
    compose(targetProject, targetEnv, [
      '--profile', 'operations', 'run', '--rm', '--no-deps', 'restore-operations',
      'scripts/restore-runtime.js',
      '--backup', '/app/backups/source-backup',
      '--storage-root', '/app/storage-volume/data',
      '--vault-root', '/app/vault-volume/vault',
      '--confirm-offline', 'I_CONFIRM_WRITES_ARE_STOPPED',
    ]);
    compose(targetProject, targetEnv, [
      '--profile', 'operations', 'run', '--rm', '--no-deps', 'restore-operations',
      'scripts/verify-backup-restore.js',
      '--backup', '/app/backups/source-backup',
      '--storage-root', '/app/storage-volume/data',
      '--vault-root', '/app/vault-volume/vault',
    ]);
    const restoredCapability = compose(targetProject, targetEnv, [
      '--profile', 'operations', 'run', '-T', '--rm', '--no-deps', 'operations',
      'scripts/manage-platform-developer.js', 'status', 'restore-operator@example.invalid',
    ]);
    assert.match(restoredCapability, /pipeline_registry\.publish=granted/,
      'restored platform capability was not available to the operations image');
    compose(targetProject, targetEnv, [
      'up', '-d', '--no-build', '--wait', '--wait-timeout', '120', 'r', 'web', 'worker',
    ]);
    const targetReady = await waitForReady(targetPort);
    assert.equal(targetReady.status, 'ready');
    const sentinel = compose(targetProject, targetEnv, [
      'exec', '-T', 'web', 'node', '-e',
      "process.stdout.write(require('fs').readFileSync(require('path').join(process.env.STORAGE_ROOT,'compose-sentinel.txt'),'utf8'))",
    ]);
    assert.equal(sentinel, 'compose-restore-v1');
    console.log('[compose-operations-drill] passed: actual non-root Compose boot, operator account/capability audit, healthy Postgres/web/worker, offline backup, read-only-input restore, exact verification, and restored restart');
  } catch (error) {
    printDiagnostics(sourceProject, sourceEnv);
    printDiagnostics(targetProject, targetEnv);
    throw error;
  } finally {
    down(targetProject, targetEnv);
    down(sourceProject, sourceEnv);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[compose-operations-drill] failed:', error && error.message ? error.message : 'unknown error');
    process.exitCode = 1;
  });
}

module.exports = { main };
