#!/usr/bin/env node

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Client } = require('pg');
const config = require('../backend/config');
const { validateNewPassword } = require('../backend/passwordPolicy');

const DATABASE_PREFIX = 'scrna_deploy_smoke_';
const R_TOKEN = '7d2a9f4c1e6b8035a8c2f7d1e4b6903c5a8f2d7e1b4c69035a8d2f7e1c4b6903';
const SESSION_SECRET = '3a8f1d6c9b2e5074f1a8d3c6b9e2057f4a1d8c3b6e9f20574a1d8c3b6e9f2057';
const SESSION_EPOCH = '4f8c2a6e1d9b3075c4e8a2f6d1b93570';
const FRONTEND_ORIGIN = 'https://app.example.test';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function configuredDatabaseUrl() {
  if (config.databaseUrl()) return config.databaseUrl();
  const host = String(process.env.PGHOST || '').trim();
  const database = String(process.env.PGDATABASE || '').trim();
  const user = String(process.env.PGUSER || '').trim();
  if (!host || !database || !user) {
    throw new Error('Set DATABASE_URL or PGHOST, PGUSER, and PGDATABASE before deployment smoke.');
  }
  const url = new URL('postgres://localhost/');
  url.hostname = host;
  url.port = String(process.env.PGPORT || '5432');
  url.username = user;
  if (process.env.PGPASSWORD !== undefined) url.password = String(process.env.PGPASSWORD);
  url.pathname = `/${database}`;
  return url.toString();
}

function databaseUrlFor(baseUrl, databaseName) {
  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function quotedDatabase(name) {
  if (!new RegExp(`^${DATABASE_PREFIX}[a-z0-9_]+$`).test(name)) {
    throw new Error('Refusing to operate outside the deployment-smoke database namespace.');
  }
  return `"${name}"`;
}

async function unusedPort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitFor(check, { timeoutMs = 15000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw lastError || new Error('Timed out waiting for deployment smoke condition.');
}

function captureChild(child) {
  const state = { stdout: '', stderr: '' };
  child.stdout?.on('data', (chunk) => { state.stdout = `${state.stdout}${chunk}`.slice(-32768); });
  child.stderr?.on('data', (chunk) => { state.stderr = `${state.stderr}${chunk}`.slice(-32768); });
  return state;
}

function redactedChildOutput(output, secrets = []) {
  let value = `${output?.stdout || ''}\n${output?.stderr || ''}`;
  for (const secret of secrets) {
    if (secret) value = value.split(String(secret)).join('[redacted]');
  }
  return value.trim().slice(-4000);
}

function waitForExit(child, timeoutMs = 15000) {
  if (child.exitCode !== null) return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('A deployment-smoke child did not exit in time.')), timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function spawnWeb(env) {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    cwd: path.join(__dirname, '..'),
    env,
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  return { child, output: captureChild(child) };
}

async function runAccountAdmin(env, { email, displayName, password }) {
  const child = spawn(
    process.execPath,
    [
      path.join(__dirname, 'account-admin.js'),
      'create', '--email', email, '--display-name', displayName, '--password-stdin',
    ],
    {
      cwd: path.join(__dirname, '..'),
      env,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    }
  );
  const output = captureChild(child);
  child.stdin.end(password);
  const exit = await waitForExit(child);
  return { ...exit, output };
}

function stopWeb(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32' && child.connected) {
    child.send({ type: 'traceomics:shutdown' });
  } else {
    child.kill('SIGTERM');
  }
}

async function request(baseUrl, route, options = {}) {
  const headers = {
    ...(options.forwarded === false ? {} : { 'X-Forwarded-Proto': 'https' }),
    ...(options.origin === false ? {} : { Origin: FRONTEND_ORIGIN }),
    ...(options.cookie ? { Cookie: options.cookie } : {}),
    ...(options.headers || {}),
  };
  let body;
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }
  let response;
  try {
    response = await fetch(`${baseUrl}${route}`, {
      method: options.method || 'GET',
      headers,
      body,
      redirect: 'manual',
    });
  } catch (error) {
    const cause = error?.cause?.code || error?.cause?.message || error?.message || 'unknown transport error';
    throw new Error(`${options.method || 'GET'} ${route} transport failed (${cause}).`);
  }
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { response, status: response.status, data };
}

function sessionCookie(response) {
  const values = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie') || ''];
  const value = values.find((entry) => entry.startsWith('__Host-traceomics_session='));
  return value ? value.split(';')[0] : '';
}

async function startFakeR() {
  const server = http.createServer((req, res) => {
    if (req.url === '/health' && req.method === 'GET') {
      if (req.headers['x-api-token'] !== R_TOKEN) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', mode: 'deployment-smoke', r_version: '4.5.3' }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server;
}

async function closeServer(server) {
  if (!server?.listening) return;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function main() {
  const baseDatabaseUrl = configuredDatabaseUrl();
  const suffix = `${process.pid}_${crypto.randomBytes(5).toString('hex')}`;
  const databaseName = `${DATABASE_PREFIX}${suffix}`;
  const adminUrl = databaseUrlFor(baseDatabaseUrl, 'postgres');
  const databaseUrl = databaseUrlFor(baseDatabaseUrl, databaseName);
  const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'scrna-deploy-smoke-'));
  const storageRoot = path.join(temp, 'storage');
  const vaultRoot = path.join(temp, 'vault');
  const weakRoot = path.join(temp, 'must-not-be-created');
  const webPort = await unusedPort();
  const secondPort = await unusedPort();
  const admin = new Client({ connectionString: adminUrl });
  let fakeR = null;
  let primary = null;
  let secondary = null;
  let databaseCreated = false;
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${quotedDatabase(databaseName)}`);
    databaseCreated = true;
    const schemaAdmin = new Client({ connectionString: databaseUrl });
    await schemaAdmin.connect();
    try {
      await schemaAdmin.query(fs.readFileSync(
        path.join(__dirname, '..', 'backend', 'pg', 'schema.sql'), 'utf8'
      ));
    } finally {
      await schemaAdmin.end();
    }
    fakeR = await startFakeR();
    const rPort = fakeR.address().port;
    const commonEnv = {
      ...process.env,
      NODE_ENV: 'production',
      APP_DEPLOYMENT_MODE: 'private',
      DATABASE_URL: databaseUrl,
      DATABASE_SCHEMA_MANAGED_EXTERNALLY: 'true',
      SESSION_SECRET,
      SESSION_EPOCH,
      SESSION_TTL_SECONDS: '3600',
      FRONTEND_ORIGIN,
      COOKIE_SECURE: 'true',
      COOKIE_SAMESITE: 'Lax',
      WEB_HOST: '127.0.0.1',
      TRUST_PROXY_HOPS: '1',
      STORAGE_ROOT: storageRoot,
      VAULT_ROOT: vaultRoot,
      R_RUNTIME_MODE: 'external',
      R_BACKEND_URL: `http://127.0.0.1:${rPort}`,
      R_API_TOKEN: R_TOKEN,
      R_PROXY_MAX_CONCURRENT: '1',
      ENABLE_JOB_WORKER: 'false',
      WEB_DRAIN_DELAY_MS: '1200',
      WEB_SHUTDOWN_TIMEOUT_MS: '10000',
    };

    const weak = spawnWeb({
      ...commonEnv,
      PORT: String(await unusedPort()),
      SESSION_SECRET: 'change-me',
      STORAGE_ROOT: weakRoot,
    });
    const weakExit = await waitForExit(weak.child);
    assert(weakExit.code === 1, 'Weak production configuration did not fail startup.');
    assert(!fs.existsSync(weakRoot), 'Fail-fast configuration created runtime storage before refusing startup.');
    assert(/SESSION_SECRET/.test(weak.output.stderr), 'Fail-fast output did not identify the invalid variable.');
    assert(!weak.output.stderr.includes('change-me'), 'Fail-fast output echoed a rejected secret.');

    primary = spawnWeb({ ...commonEnv, PORT: String(webPort) });
    const baseUrl = `http://127.0.0.1:${webPort}`;
    try {
      await waitFor(async () => {
        const live = await request(baseUrl, '/livez', { forwarded: false, origin: false });
        return live.status === 200;
      });
    } catch (error) {
      const diagnostics = redactedChildOutput(primary.output, [databaseUrl, SESSION_SECRET, SESSION_EPOCH, R_TOKEN]);
      throw new Error(`Production web did not become live. ${error.message}${diagnostics ? `\n${diagnostics}` : ''}`);
    }
    const ready = await waitFor(async () => {
      const result = await request(baseUrl, '/readyz', { forwarded: false, origin: false });
      return result.status === 200 ? result : null;
    });
    assert(ready.data?.status === 'ready', 'Web readiness did not report ready.');
    assert(ready.data?.components?.database === 'ready', 'Web readiness did not verify Postgres.');
    assert(ready.data?.components?.rCompute === 'ready', 'Web readiness did not verify R compute.');

    const plaintext = await request(baseUrl, '/api/auth/session', {
      forwarded: false,
      origin: false,
    });
    assert(plaintext.status === 426, 'Production accepted a non-health request without trusted HTTPS forwarding.');

    const email = `deploy-${suffix}@example.invalid`;
    const displayName = 'Deployment Smoke';
    const password = 'amber circuit meadows 47';
    const passwordValidation = validateNewPassword(password, { email, displayName });
    assert(!passwordValidation.error,
      `Deployment smoke credential violates the production password policy: ${passwordValidation.error}`);
    const policy = await request(baseUrl, '/api/auth/policy');
    assert(policy.status === 200 && policy.data?.registrationEnabled === false,
      'Production auth policy did not close public registration.');
    assert(policy.data?.legacyLocalImportsEnabled === false
      && policy.data?.legacyLiveMutationToolsEnabled === false
      && policy.data?.serverFigureExportEnabled === false,
    'Production UI policy exposed a server-blocked legacy action.');
    const signup = await request(baseUrl, '/api/auth/signup', {
      method: 'POST',
      body: {
        email,
        password,
        displayName,
      },
    });
    assert(signup.status === 403, 'Production accepted network-facing account registration.');

    const provisioned = await runAccountAdmin(commonEnv, {
      email,
      password,
      displayName,
    });
    assert(provisioned.code === 0, 'Operator account provisioning failed.');
    assert(!`${provisioned.output.stdout}${provisioned.output.stderr}`.includes(password),
      'Operator account provisioning exposed its password.');

    const login = await request(baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { email, password },
    });
    assert(login.status === 200, 'Provisioned production account could not log in.');
    assert(login.data?.user?.email === email, 'Login did not return the public user projection.');
    assert(login.data?.token === undefined, 'Login exposed a bearer credential to JavaScript.');
    const cookie = sessionCookie(login.response);
    assert(cookie.startsWith('__Host-traceomics_session='), 'Production did not issue a __Host session cookie.');
    const allCookies = login.response.headers.getSetCookie();
    const hostCookie = allCookies.find((entry) => entry.startsWith('__Host-traceomics_session='));
    assert(/; Secure/i.test(hostCookie) && /; HttpOnly/i.test(hostCookie) && /; Path=\//i.test(hostCookie),
      'Production session cookie flags are incomplete.');
    assert(!/; Domain=/i.test(hostCookie), '__Host session cookie unexpectedly set Domain.');
    assert(login.response.headers.get('strict-transport-security')?.includes('max-age='),
      'Production response did not set HSTS behind the trusted proxy.');
    assert(login.response.headers.get('x-content-type-options') === 'nosniff',
      'Production response did not set nosniff.');
    assert(login.response.headers.get('x-frame-options') === 'DENY',
      'Production response did not deny framing.');
    assert(login.response.headers.get('content-security-policy')?.includes("object-src 'none'"),
      'Production response did not set the reviewed content security policy.');

    const restored = await request(baseUrl, '/api/auth/session', { cookie });
    assert(restored.status === 200 && restored.data?.user?.email === login.data.user.email,
      'Cookie session restore failed.');
    const bearerOnly = await request(baseUrl, '/api/auth/session', {
      headers: { Authorization: `Bearer ${cookie.split('=')[1]}` },
    });
    assert(bearerOnly.status === 401, 'Removed bearer transport still authenticated.');

    const legacyUpload = await request(baseUrl, '/api/upload', {
      method: 'POST',
      cookie,
      body: {},
    });
    assert(legacyUpload.status === 403, 'Production accepted a legacy private-vault upload.');

    const noOrigin = await request(baseUrl, '/api/organizations', {
      method: 'POST',
      cookie,
      origin: false,
      body: { name: 'Must Not Exist' },
    });
    assert(noOrigin.status === 403, 'Cookie mutation without Origin bypassed CSRF enforcement.');
    const organization = await request(baseUrl, '/api/organizations', {
      method: 'POST',
      cookie,
      body: { name: 'Deployment Smoke' },
    });
    assert(organization.status === 201 && organization.data?.id, 'Authenticated metadata mutation failed.');
    const project = await request(baseUrl, '/api/projects', {
      method: 'POST',
      cookie,
      body: {
        organizationId: organization.data.id,
        name: 'Deployment Smoke Project',
        description: 'production process smoke',
      },
    });
    assert(project.status === 201 && project.data?.id, 'Authenticated project creation failed.');

    secondary = spawnWeb({ ...commonEnv, PORT: String(secondPort) });
    const secondExit = await waitForExit(secondary.child);
    assert(secondExit.code === 1, 'A second production web process bypassed the singleton topology fence.');
    assert(/WEB_TOPOLOGY_LOCKED/.test(secondary.output.stderr),
      'Second-web refusal did not report the stable topology code.');
    secondary = null;

    await closeServer(fakeR);
    fakeR = null;
    const degraded = await waitFor(async () => {
      const result = await request(baseUrl, '/readyz', { forwarded: false, origin: false });
      return result.status === 200 && result.data?.computeDegraded === true ? result : null;
    });
    assert(degraded.data.components.rCompute === 'unavailable', 'R outage was not visible in readiness.');

    const logout = await request(baseUrl, '/api/auth/logout', { method: 'POST', cookie });
    assert(logout.status === 200 && logout.data?.allSessionsRevoked === true,
      'Logout did not confirm server-side revocation.');
    const revoked = await request(baseUrl, '/api/auth/session', { cookie });
    assert(revoked.status === 401, 'A revoked cookie remained usable.');

    // Terminate the reserved advisory-lock session without polling readiness.
    // The independent watchdog must make lock loss fatal; merely becoming
    // unhealthy would let Compose keep an unsafe old web process alive.
    const target = new Client({ connectionString: databaseUrl });
    await target.connect();
    try {
      const owner = await target.query(
        `SELECT pid
           FROM pg_locks
          WHERE locktype = 'advisory'
            AND classid = $1 AND objid = $2 AND granted = true`,
        [0x5343524e, 700]
      );
      assert(owner.rowCount === 1, 'Web topology lock owner was not uniquely observable.');
      await target.query('SELECT pg_terminate_backend($1)', [owner.rows[0].pid]);
      const lockLossExit = await waitForExit(primary.child, 15000);
      assert(lockLossExit.code === 1, 'Web topology lock loss did not force a nonzero process exit.');
      const lockLossOutput = `${primary.output.stdout}\n${primary.output.stderr}`;
      assert(/WEB_TOPOLOGY_LOCK_LOST/.test(lockLossOutput), 'Lock-loss exit omitted its stable code.');
      assert(!lockLossOutput.includes(SESSION_SECRET), 'Web output exposed SESSION_SECRET.');
      assert(!lockLossOutput.includes(databaseUrl), 'Web output exposed DATABASE_URL.');
      primary = null;

      // A replacement may start only after the unsafe process has exited. Then
      // prove the ordinary signal path still becomes non-ready and exits zero.
      primary = spawnWeb({ ...commonEnv, PORT: String(webPort) });
      await waitFor(async () => {
        const result = await request(baseUrl, '/readyz', { forwarded: false, origin: false });
        return result.status === 200 ? result : null;
      });
      stopWeb(primary.child);
      const draining = await waitFor(async () => {
        const result = await request(baseUrl, '/readyz', { forwarded: false, origin: false });
        return result.status === 503 ? result : null;
      }, { timeoutMs: 5000, intervalMs: 25 });
      assert(draining.data?.status === 'not_ready', 'Web did not become non-ready before shutdown.');
      const primaryExit = await waitForExit(primary.child, 15000);
      assert(primaryExit.code === 0, 'Production web did not exit cleanly after drain.');
      primary = null;

      const lock = await target.query(
        'SELECT pg_try_advisory_lock($1, $2) AS acquired',
        [0x5343524e, 700]
      );
      assert(lock.rows[0]?.acquired === true, 'Web topology lock was not released on shutdown.');
      await target.query('SELECT pg_advisory_unlock($1, $2)', [0x5343524e, 700]);
    } finally {
      await target.end();
    }
    console.log('[deployment-smoke] passed: fail-fast config, health, TLS ingress, cookie auth, CSRF, singleton web, fatal lock loss, R degradation, and graceful drain');
  } finally {
    if (secondary) {
      stopWeb(secondary.child);
      try { await waitForExit(secondary.child, 5000); } catch { secondary.child.kill(); }
    }
    if (primary) {
      stopWeb(primary.child);
      try { await waitForExit(primary.child, 5000); } catch { primary.child.kill(); }
    }
    await closeServer(fakeR);
    if (databaseCreated) {
      await admin.query(
        `SELECT pg_terminate_backend(pid)
           FROM pg_stat_activity
          WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [databaseName]
      );
      await admin.query(`DROP DATABASE IF EXISTS ${quotedDatabase(databaseName)}`);
    }
    await admin.end();
    await fs.promises.rm(temp, { recursive: true, force: true });
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[deployment-smoke] failed:', error && error.message ? error.message : 'unknown error');
    process.exitCode = 1;
  });
}

module.exports = { main };
