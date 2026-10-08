'use strict';

// Disposable production application fixture for native SSH/HTTPS acceptance.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { Client } = require('pg');
const exec = promisify(execFile);
const root = path.resolve(__dirname, '..');

async function command(executable, args, options = {}) {
  try {
    return await exec(executable, args, { cwd: root, windowsHide: true, timeout: 30_000,
      maxBuffer: 128 * 1024, ...options });
  } catch {
    // Arguments may contain disposable credentials. Keep them out of reports.
    throw new Error('A disposable tunnel service setup command failed.');
  }
}
async function listen(server, port = 0, hostname = '127.0.0.1') {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, hostname, resolve);
  });
  return server.address().port;
}
async function closeServer(server) {
  if (!server?.listening) return;
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
}
async function waitFor(check, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await check()) return; } catch { /* Startup only. */ }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('The disposable tunnel service did not become ready.');
}
async function reservePort() {
  const server = http.createServer();
  const port = await listen(server);
  await closeServer(server);
  return port;
}
async function seed(env, account) {
  const source = `const db=require('./backend/pgDatabase'); let raw='';
    process.stdin.on('data', chunk=>raw+=chunk);
    process.stdin.on('end', async()=>{try {
      const account=JSON.parse(raw); await db.initSchema();
      const user=await db.createUser(account.email,account.password,'Tunnel researcher');
      const org=await db.createOrganizationForUser(user.id,{name:'Tunnel research lab'});
      const project=await db.createProjectForUser(user.id,{organizationId:org.id,name:'Tunnel research project'});
      process.stdout.write(JSON.stringify({id:project.id,name:project.name}));
    } catch {process.exitCode=1;} finally {await db.close();}});`;
  const child = spawn(process.execPath, ['-e', source], { cwd: root, env, windowsHide: true,
    shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', chunk => { output = (output + chunk).slice(-8192); });
  child.stderr.resume();
  child.stdin.end(JSON.stringify(account));
  const timer = setTimeout(() => child.kill(), 30_000);
  const code = await new Promise((resolve, reject) => {
    child.once('exit', resolve); child.once('error', reject);
  }).finally(() => clearTimeout(timer));
  if (code !== 0) throw new Error('Could not seed the disposable tunnel research account.');
  return JSON.parse(output);
}

async function createDesktopTunnelServiceFixture({ artifactDirectory,
  hostname = 'analysis.tunnel.test', httpsPort = 0, webEnvironment = {} } = {}) {
  const reportRoot = path.join(root, 'playwright', 'report') + path.sep;
  const output = path.resolve(artifactDirectory || '');
  if (!output.startsWith(reportRoot) || !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/i.test(hostname)) {
    throw new Error('Tunnel fixtures require a disposable workspace report and a valid test hostname.');
  }
  const privateDirectory = path.join(output, 'service-private-' + crypto.randomBytes(6).toString('hex'));
  const databaseName = 'traceomics-tunnel-' + process.pid + '-' + crypto.randomBytes(5).toString('hex');
  const password = crypto.randomBytes(24).toString('hex');
  const account = { email: 'tunnel-' + crypto.randomBytes(5).toString('hex') + '@example.invalid',
    password: 'River-tunnel-' + crypto.randomBytes(12).toString('hex') };
  let databaseStarted = false, web, fakeR, ingress;
  let stopped = false;
  fs.mkdirSync(privateDirectory, { recursive: true });
  const stop = async () => {
    if (stopped) return; stopped = true;
    await closeServer(ingress);
    if (web && web.exitCode === null) {
      const exited = new Promise(resolve => web.once('exit', resolve));
      if (process.platform === 'win32' && web.connected) web.send({ type: 'traceomics:shutdown' });
      else web.kill('SIGTERM');
      let timer;
      await Promise.race([exited, new Promise(resolve => {
        timer = setTimeout(() => { web.kill(); resolve(); }, 12_000);
      })]);
      clearTimeout(timer);
    }
    await closeServer(fakeR);
    if (databaseStarted) await command('docker', ['stop', databaseName]);
    const resolved = path.resolve(privateDirectory);
    if (!resolved.startsWith(output + path.sep) || !resolved.startsWith(reportRoot)) {
      throw new Error('Refusing cleanup outside the disposable tunnel fixture.');
    }
    await fs.promises.rm(resolved, { recursive: true, force: true });
  };
  try {
    const openssl = process.platform === 'win32'
      && fs.existsSync('C:\\Program Files\\Git\\usr\\bin\\openssl.exe')
      ? 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe' : 'openssl';
    const caCertificatePath = path.join(privateDirectory, 'ca.pem');
    const caKeyPath = path.join(privateDirectory, 'ca-key.pem');
    const certificatePath = path.join(privateDirectory, 'leaf.pem');
    const privateKeyPath = path.join(privateDirectory, 'leaf-key.pem');
    const requestPath = path.join(privateDirectory, 'leaf.csr');
    const extensionsPath = path.join(privateDirectory, 'leaf.ext');
    fs.writeFileSync(extensionsPath, `subjectAltName=DNS:${hostname}\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n`);
    await command(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '2',
      '-subj', '/CN=Disposable tunnel acceptance authority', '-addext', 'basicConstraints=critical,CA:TRUE',
      '-keyout', caKeyPath, '-out', caCertificatePath]);
    await command(openssl, ['req', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-subj', '/CN=' + hostname,
      '-keyout', privateKeyPath, '-out', requestPath]);
    await command(openssl, ['x509', '-req', '-in', requestPath, '-CA', caCertificatePath, '-CAkey', caKeyPath,
      '-CAcreateserial', '-days', '2', '-sha256', '-extfile', extensionsPath, '-out', certificatePath]);
    const appPort = await reservePort();
    fakeR = http.createServer((req, res) => {
      res.writeHead(req.url === '/health' ? 200 : 404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(req.url === '/health' ? { status: 'ok' } : { error: 'Unavailable in this acceptance fixture.' }));
    });
    const rPort = await listen(fakeR);
    ingress = https.createServer({ key: fs.readFileSync(privateKeyPath), cert: fs.readFileSync(certificatePath) }, (req, res) => {
      const headers = { ...req.headers, 'x-forwarded-proto': 'https', 'x-forwarded-for': '127.0.0.1',
        'x-forwarded-host': req.headers.host };
      const upstream = http.request({ hostname: '127.0.0.1', port: appPort, method: req.method,
        path: req.url, headers }, response => {
        res.writeHead(response.statusCode, response.headers); response.pipe(res);
      });
      upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      req.on('aborted', () => upstream.destroy()); req.pipe(upstream);
    });
    const selectedHttpsPort = await listen(ingress, httpsPort, '0.0.0.0');
    const endpoint = `https://${hostname}:${selectedHttpsPort}`;
    await command('docker', ['run', '--rm', '-d', '--name', databaseName,
      '--label', 'traceomics.review=desktop-tunnel', '-e', 'POSTGRES_DB=tunnel_review',
      '-e', 'POSTGRES_USER=tunnel_review', '-e', 'POSTGRES_PASSWORD=' + password,
      '-p', '127.0.0.1::5432', 'postgres:16-alpine', '-c', 'fsync=off']);
    databaseStarted = true;
    const { stdout } = await command('docker', ['inspect', '--format',
      '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}', databaseName]);
    const databaseUrl = `postgresql://tunnel_review:${password}@127.0.0.1:${stdout.trim()}/tunnel_review`;
    await waitFor(async () => {
      const client = new Client({ connectionString: databaseUrl });
      try { await client.connect(); return true; } finally { await client.end(); }
    });
    const env = { ...process.env, ...webEnvironment, NODE_ENV: 'production', APP_DEPLOYMENT_MODE: 'private',
      DATABASE_URL: databaseUrl, SESSION_SECRET: crypto.randomBytes(32).toString('hex'),
      SESSION_EPOCH: crypto.randomBytes(16).toString('hex'), SESSION_TTL_SECONDS: '3600',
      FRONTEND_ORIGIN: endpoint, COOKIE_SECURE: 'true', COOKIE_SAMESITE: 'Lax',
      WEB_HOST: '127.0.0.1', PORT: String(appPort), TRUST_PROXY_HOPS: '1',
      STORAGE_ROOT: path.join(privateDirectory, 'storage'), VAULT_ROOT: path.join(privateDirectory, 'vault'),
      R_RUNTIME_MODE: 'external', R_BACKEND_URL: `http://127.0.0.1:${rPort}`,
      R_API_TOKEN: crypto.randomBytes(32).toString('hex'), ENABLE_JOB_WORKER: 'false',
      WEB_DRAIN_DELAY_MS: '20', WEB_SHUTDOWN_TIMEOUT_MS: '10000',
      DATABASE_SCHEMA_MANAGED_EXTERNALLY: 'true' };
    const project = await seed({ ...env, NODE_ENV: 'test', DATABASE_SCHEMA_MANAGED_EXTERNALLY: 'false' }, account);
    web = spawn(process.execPath, [path.join(root, 'server.js')], { cwd: root, env, shell: false,
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let diagnostics = '';
    const collect = chunk => { diagnostics = (diagnostics + chunk).slice(-8192); };
    web.stdout.on('data', collect); web.stderr.on('data', collect);
    try {
      await waitFor(async () => {
        if (web.exitCode !== null) throw new Error('Disposable application exited during startup.');
        const response = await fetch(`http://127.0.0.1:${appPort}/api/auth/policy`, {
          headers: { 'X-Forwarded-Proto': 'https', Origin: endpoint },
        });
        return response.ok && (await response.json()).registrationEnabled === false;
      });
    } catch {
      for (const secret of [databaseUrl, password, account.password, env.SESSION_SECRET,
        env.SESSION_EPOCH, env.R_API_TOKEN, env.EXPERT_R_SANDBOX_TOKEN, privateDirectory].filter(Boolean)) {
        diagnostics = diagnostics.split(secret).join('[redacted]');
      }
      throw new Error('Disposable application startup failed: ' + diagnostics.trim().slice(-2000));
    }
    return { endpoint, httpsPort: selectedHttpsPort, caCertificatePath, certificatePath, privateKeyPath,
      account, project, databaseUrl, storageRoot: env.STORAGE_ROOT, stop,
      setTlsCertificate({ certificatePath: nextCertificate, privateKeyPath: nextKey }) {
        ingress.setSecureContext({ cert: fs.readFileSync(nextCertificate), key: fs.readFileSync(nextKey) });
      } };
  } catch (error) { await stop(); throw error; }
}

module.exports = { createDesktopTunnelServiceFixture };
