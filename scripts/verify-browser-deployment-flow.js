#!/usr/bin/env node

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Client } = require('pg');
const { chromium } = require('playwright');
const config = require('../backend/config');

const DATABASE_PREFIX = 'scrna_browser_smoke_';
const R_TOKEN = 'browser-smoke-r-token-0000000000000000000000000000';
const SESSION_SECRET = 'browser-smoke-session-secret-000000000000000000000';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function configuredDatabaseUrl() {
  if (config.databaseUrl()) return config.databaseUrl();
  const host = String(process.env.PGHOST || '').trim();
  const database = String(process.env.PGDATABASE || '').trim();
  const user = String(process.env.PGUSER || '').trim();
  if (!host || !database || !user) {
    throw new Error('Set DATABASE_URL or PGHOST, PGUSER, and PGDATABASE before browser smoke.');
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
    throw new Error('Refusing to operate outside the browser-smoke database namespace.');
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

async function waitFor(check, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw lastError || new Error('Timed out waiting for the browser-smoke runtime.');
}

function waitForExit(child, timeoutMs = 10000) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Browser-smoke web process did not exit.')), timeoutMs);
    child.once('exit', (code) => { clearTimeout(timer); resolve(code); });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
  });
}

function stopWeb(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32' && child.connected) child.send({ type: 'benchone:shutdown' });
  else child.kill('SIGTERM');
}

async function closeServer(server) {
  if (!server?.listening) return;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function startFakeR() {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://r.internal').pathname;
    if (req.headers['x-api-token'] !== R_TOKEN) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    if (req.method === 'GET' && pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', mode: 'browser-smoke', r_version: '4.5.3' }));
      return;
    }
    if (req.method === 'GET' && pathname === '/session-id') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sessionId: 'browser-smoke-r-session' }));
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

async function signUp(page, { name, email, password }) {
  await page.getByRole('button', { name: 'Sign Up', exact: true }).click();
  await page.getByPlaceholder('Dr. Jane Doe').fill(name);
  await page.getByPlaceholder('researcher@lab.edu').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole('button', { name: /Create Account/ }).click();
  await page.getByRole('button', { name: 'Log out' }).waitFor({ state: 'visible', timeout: 15000 });
}

async function logIn(page, { email, password }) {
  await page.getByRole('button', { name: 'Log In', exact: true }).click();
  await page.getByPlaceholder('researcher@lab.edu').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole('button', { name: /Open Workbench/ }).click();
  await page.getByRole('button', { name: 'Log out' }).waitFor({ state: 'visible', timeout: 15000 });
}

async function main() {
  assert(fs.existsSync(path.join(__dirname, '..', 'dist', 'index.html')),
    'Build the frontend before running browser deployment smoke.');
  const baseDatabaseUrl = configuredDatabaseUrl();
  const suffix = `${process.pid}_${crypto.randomBytes(5).toString('hex')}`;
  const databaseName = `${DATABASE_PREFIX}${suffix}`;
  const adminUrl = databaseUrlFor(baseDatabaseUrl, 'postgres');
  const databaseUrl = databaseUrlFor(baseDatabaseUrl, databaseName);
  const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'scrna-browser-smoke-'));
  const port = await unusedPort();
  const origin = `http://127.0.0.1:${port}`;
  const admin = new Client({ connectionString: adminUrl });
  let databaseCreated = false;
  let fakeR = null;
  let web = null;
  let browser = null;
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${quotedDatabase(databaseName)}`);
    databaseCreated = true;
    fakeR = await startFakeR();
    const rPort = fakeR.address().port;
    web = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      cwd: path.join(__dirname, '..'),
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DATABASE_URL: databaseUrl,
        SESSION_SECRET,
        FRONTEND_ORIGIN: origin,
        COOKIE_SECURE: 'false',
        WEB_HOST: '127.0.0.1',
        PORT: String(port),
        STORAGE_ROOT: path.join(temp, 'storage'),
        VAULT_ROOT: path.join(temp, 'vault'),
        R_RUNTIME_MODE: 'external',
        R_BACKEND_URL: `http://127.0.0.1:${rPort}`,
        R_API_TOKEN: R_TOKEN,
        ENABLE_JOB_WORKER: 'false',
        DISABLE_RATE_LIMIT: 'true',
        WEB_DRAIN_DELAY_MS: '0',
        WEB_SHUTDOWN_TIMEOUT_MS: '10000',
      },
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let webOutput = '';
    web.stdout.on('data', (chunk) => { webOutput = `${webOutput}${chunk}`.slice(-32768); });
    web.stderr.on('data', (chunk) => { webOutput = `${webOutput}${chunk}`.slice(-32768); });
    await waitFor(async () => {
      const response = await fetch(`${origin}/readyz`);
      return response.ok;
    });

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    const consoleErrors = [];
    const pageErrors = [];
    const serverErrors = [];
    const requestFailures = [];
    const responseStatusByRequest = new WeakMap();
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('response', (response) => {
      responseStatusByRequest.set(response.request(), response.status());
      if (response.status() >= 500) serverErrors.push(`${response.status()} ${response.url()}`);
    });
    page.on('requestfailed', (request) => {
      requestFailures.push({
        method: request.method(),
        url: request.url(),
        error: request.failure()?.errorText || 'failed',
        responseStatus: responseStatusByRequest.get(request) || null,
      });
    });

    const second = {
      name: 'Browser Analyst',
      email: `analyst-${suffix}@example.invalid`,
      password: 'analyst-browser-password',
    };
    const owner = {
      name: 'Browser Owner',
      email: `owner-${suffix}@example.invalid`,
      password: 'owner-browser-password',
    };
    const projectName = `Browser Project ${suffix}`;

    await page.goto(origin, { waitUntil: 'networkidle' });
    await signUp(page, second);
    await page.getByRole('button', { name: 'Log out' }).click();
    await page.getByRole('button', { name: /Open Workbench/ }).waitFor({ state: 'visible' });

    await signUp(page, owner);
    await page.getByText('No backend projects', { exact: true }).waitFor({ state: 'visible' });
    await page.getByRole('button', { name: 'Create Project', exact: true }).click();
    await page.getByPlaceholder('Project Name').fill(projectName);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByText(projectName, { exact: true }).first().waitFor({ state: 'visible', timeout: 15000 });

    await page.getByRole('button', { name: /Collaborators, Project RBAC/ }).click();
    await page.getByRole('heading', { name: 'Collaborators' }).waitFor({ state: 'visible' });
    await page.getByLabel('Account email').fill(second.email);
    await page.locator('form').filter({ hasText: 'Add existing user' }).locator('select').selectOption('viewer');
    await page.getByRole('button', { name: /Add member/ }).click();
    await page.getByText(second.email, { exact: true }).waitFor({ state: 'visible' });
    const roleSelect = page.getByLabel(`Role for ${second.email}`);
    await roleSelect.selectOption('analyst');
    await waitFor(async () => (await roleSelect.inputValue()) === 'analyst');

    await page.getByRole('button', { name: `Remove ${second.email}` }).click();
    await page.getByRole('button', { name: `Confirm remove ${second.email} from ${projectName}` })
      .waitFor({ state: 'visible' });
    await page.getByRole('button', { name: `Keep ${second.email}` }).click();
    await page.getByText(second.email, { exact: true }).waitFor({ state: 'visible' });

    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Log out' }).waitFor({ state: 'visible' });
    assert(await page.getByText(projectName, { exact: true }).count() > 0,
      'Cookie restore did not reload the durable project.');
    assert(await page.evaluate(() => localStorage.getItem('benchone_auth_token')) === null,
      'Browser stored a bearer credential in localStorage.');
    const ownerCookie = (await context.cookies()).find((cookie) => cookie.name === 'benchone_session');
    assert(ownerCookie?.httpOnly === true, 'Browser session cookie is not HttpOnly.');

    await page.getByRole('button', { name: 'Log out' }).click();
    await logIn(page, second);
    await page.getByText(projectName, { exact: true }).first().waitFor({ state: 'visible', timeout: 15000 });
    await page.getByRole('button', { name: /Collaborators, Project RBAC/ }).click();
    await page.getByText('Your role: analyst', { exact: true }).waitFor({ state: 'visible' });
    assert(await page.getByLabel('Account email').count() === 0,
      'Analyst unexpectedly received membership-management controls.');
    assert(await page.getByLabel(`Role for ${second.email}`).isDisabled(),
      'Analyst unexpectedly received an editable role control.');

    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Log out' }).waitFor({ state: 'visible' });
    await page.getByRole('button', { name: 'Log out' }).click();
    await page.getByRole('button', { name: /Open Workbench/ }).waitFor({ state: 'visible' });
    assert(!(await context.cookies()).some((cookie) => cookie.name === 'benchone_session'),
      'Logout did not clear the browser session cookie.');

    const unexpectedConsole = consoleErrors.filter((message) => (
      !/Failed to load resource: the server responded with a status of 401 \(Unauthorized\)/i.test(message)
    ));
    // Chromium can abandon an unread response body after the SPA has already
    // received a successful status and changed screens (notably logout). Keep
    // auditing failures with no response or an error response; completed 2xx/3xx
    // headers followed by ERR_ABORTED are an intentional client-side discard.
    const unexpectedFailures = requestFailures.filter((failure) => !(
      failure.error === 'net::ERR_ABORTED' && (
        (Number.isInteger(failure.responseStatus)
          && failure.responseStatus >= 200
          && failure.responseStatus < 400)
        || (failure.responseStatus === 401
          && new URL(failure.url).pathname === '/api/auth/session')
      )
    ));
    assert(serverErrors.length === 0, `Browser observed server errors: ${serverErrors.join(' | ')}`);
    assert(unexpectedFailures.length === 0, `Browser observed request failures: ${unexpectedFailures.map((failure) => (
      `${failure.method} ${failure.url} ${failure.error} status=${failure.responseStatus || 'none'}`
    )).join(' | ')}`);
    assert(pageErrors.length === 0, `Browser page errors: ${pageErrors.join(' | ')}`);
    assert(unexpectedConsole.length === 0, `Browser console errors: ${unexpectedConsole.join(' | ')}`);
    assert(!webOutput.includes(databaseUrl), 'Web process output exposed DATABASE_URL during browser smoke.');
    console.log('[browser-deployment-smoke] passed: real Chromium signup, project creation, collaborators RBAC, cookie reload, role view, logout, and 5xx/console audit');
  } finally {
    if (browser) await browser.close();
    if (web) {
      stopWeb(web);
      try { await waitForExit(web); } catch { web.kill(); }
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
    console.error('[browser-deployment-smoke] failed:', error && error.message ? error.message : 'unknown error');
    process.exitCode = 1;
  });
}

module.exports = { main };
