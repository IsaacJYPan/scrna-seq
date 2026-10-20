#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const https = require('node:https');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { _electron: electron } = require('playwright');
const { systemExecutable, scannedHostKeys } = require('../desktop/sshConnection.cjs');
const { createDesktopTunnelServiceFixture } = require('./desktop-tunnel-service-fixture.cjs');
const root = path.resolve(__dirname, '..');
function assert(value, message) { if (!value) throw new Error(message); }
function command(program, args, { timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = ''; child.stdout.on('data', value => { output = (output + value).slice(-1024 * 1024); }); child.stderr.on('data', value => { errors = (errors + value).slice(-1024 * 1024); });
    const timer = setTimeout(() => child.kill(), timeout);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); if (code === 0) resolve((output + errors).trim()); else reject(new Error('Disposable native fixture command failed: ' + errors.slice(-1500))); });
  });
}
async function portAvailable() { const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port; }
async function isListening(port) { return new Promise(resolve => { const socket = net.connect(port, '127.0.0.1'); socket.once('connect', () => { socket.destroy(); resolve(true); }); socket.once('error', () => resolve(false)); socket.setTimeout(300, () => { socket.destroy(); resolve(false); }); }); }
function digest(filename) { return fs.existsSync(filename) ? createHash('sha256').update(fs.readFileSync(filename)).digest('hex') : null; }
function quoted(value) { return '"' + value.replace(/\\/g, '/').replace(/"/g, '\\"') + '"'; }
async function waitFor(check, message, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(message);
}
async function secureFixtureDirectory(directory, output) {
  if (process.platform !== 'win32') { fs.chmodSync(directory, 0o700); return; }
  const helper = path.join(output, 'fixture-private-permissions.ps1');
  fs.writeFileSync(helper, [
    'param([string]$TargetDirectory)', "$ErrorActionPreference = 'Stop'",
    '$owner=[System.Security.Principal.WindowsIdentity]::GetCurrent().User',
    '$acl=[System.Security.AccessControl.DirectorySecurity]::new()', '$acl.SetOwner($owner)', '$acl.SetAccessRuleProtection($true,$false)',
    "foreach($sid in @($owner.Value,'S-1-5-18','S-1-5-32-544')){",
    " $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]::new($sid),'FullControl','ContainerInherit,ObjectInherit','None','Allow'))", '}',
    '[System.IO.Directory]::SetAccessControl($TargetDirectory,$acl)',
  ].join('\n'));
  await command(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', helper, directory]);
}
async function runDesktopTunnelAcceptance({ artifactDirectory,
  serviceFactory = createDesktopTunnelServiceFixture, exerciseWorkspace } = {}) {
  const output = path.resolve(artifactDirectory || path.join(root, 'playwright', 'report', 'desktop-tunnel-' + new Date().toISOString().replace(/[:.]/g, '-')));
  assert(output.startsWith(path.join(root, 'playwright', 'report') + path.sep), 'Reports must stay in ignored workspace storage.'); fs.mkdirSync(output, { recursive: true });
  const privateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'traceomics-tunnel-'));
  const userData = path.join(privateDirectory, 'Native desktop state'), nativeConfigFile = path.join(privateDirectory, 'Native SSH config'), nativeKnownHosts = path.join(privateDirectory, 'Native known hosts');
  const originalFiles = ['config', 'known_hosts', 'known_hosts2'].map(name => path.join(os.homedir(), '.ssh', name)), originalHashes = originalFiles.map(digest);
  const stamp = Date.now().toString(36), prefix = 'traceomics-tunnel-' + stamp, network = prefix + '-network', image = prefix + ':fixture';
  const names = [prefix + '-gate', prefix + '-compute'], accounts = ['gatekeeper', 'researcher'], aliases = ['tunnel_gate', 'tunnel_compute'];
  const identities = accounts.map(account => path.join(privateDirectory, account + ' identity')), publicFiles = accounts.map(account => path.join(privateDirectory, account + '_authorized_keys'));
  const hostPort = await portAvailable(), extraLocalPort = await portAvailable(), extraDynamicPort = await portAvailable();
  const checks = [], started = new Set(); let networkCreated = false, application, service;
  const videoDirectory = path.join(output, 'video');
  const windowRecords = [];
  fs.mkdirSync(videoDirectory, { recursive: true });
  fs.mkdirSync(userData, { recursive: true });
  await secureFixtureDirectory(privateDirectory, output);
  async function recordWindows(checkpoint) {
    if (!application) return;
    const record = { checkpoint, recordedAt: new Date().toISOString(), windows: [] };
    for (const [index, page] of application.windows().entries()) {
      const nativeWindow = await application.browserWindow(page).catch(() => null);
      let native = null;
      if (nativeWindow) {
        native = await nativeWindow.evaluate(window => ({ bounds: window.getBounds(), visible: window.isVisible(), title: window.getTitle() })).catch(() => null);
        await nativeWindow.dispose().catch(() => {});
      }
      record.windows.push({ index, title: await page.title().catch(() => ''), url: page.url(),
        viewport: page.viewportSize(), native });
    }
    windowRecords.push(record);
    fs.writeFileSync(path.join(output, 'window-records.json'), JSON.stringify(windowRecords, null, 2) + '\n');
  }
  function saveSettings(profile, selected = null) { fs.writeFileSync(path.join(userData, 'desktop-settings.json'), JSON.stringify({ schemaVersion: 1, selectedProfileId: selected, profiles: [profile] })); }
  const profile = { id: 'tunneled-lab', name: 'Tunneled lab', kind: 'ssh',
    ssh: { host: aliases[1], remoteHost: '127.0.0.1', remotePort: 8443 } };
  async function launch({ trustFixtureCa = true, forcePortConflict = false, direct = false, restoreSelected = false } = {}) {
    const launcher = path.join(privateDirectory, 'native-launcher.cjs');
    const ca = service.caCertificatePath;
    fs.writeFileSync(launcher, [
      "const fs=require('node:fs'); const {X509Certificate}=require('node:crypto'); const {app,session}=require('electron');",
      ...(direct ? ['app.commandLine.appendSwitch("host-resolver-rules","MAP analysis.tunnel.test 127.0.0.1");'] : []),
      'const connection=require(' + JSON.stringify(path.join(root, 'desktop/sshConnection.cjs')) + '); const original=connection.createSshConnectionManager;',
      'connection.createSshConnectionManager=options=>original({...options,nativeConfigFile:' + JSON.stringify(nativeConfigFile) + '});',
      'const transport=require(' + JSON.stringify(path.join(root, 'desktop/sshTunnel.cjs')) + '); const openTunnel=transport.createSshTunnel;',
      'transport.createSshTunnel=async(lease,options)=>{let blocker;let attempts=0;let occupied;try{',
      ...(forcePortConflict ? ['if(!globalThis.__fixturePortConflictRetried){blocker=require("node:net").createServer();await new Promise(resolve=>blocker.listen(0,"127.0.0.1",resolve));occupied=blocker.address().port;options={...options,allocatePort:async()=>++attempts===1?occupied:transport.availablePort()};}'] : []),
      'const tunnel=await openTunnel(lease,options);if(blocker)globalThis.__fixturePortConflictRetried=attempts>1&&tunnel.port!==occupied;globalThis.__fixtureTunnelPort=tunnel.port;return tunnel;}finally{if(blocker)await new Promise(resolve=>blocker.close(resolve));}};',
      ...(trustFixtureCa ? [
        '// Strict trust belongs only to this disposable test launcher, never production desktop code.',
        'const ca=new X509Certificate(fs.readFileSync(' + JSON.stringify(ca) + ')); const fromPartition=session.fromPartition.bind(session); const checked=new Set();globalThis.__fixtureCertificateRejections=[];',
        'session.fromPartition=(...args)=>{ const target=fromPartition(...args); if(!checked.has(target)){checked.add(target);target.setCertificateVerifyProc((request,done)=>{',
        'try{const leaf=new X509Certificate(request.certificate.data); const current=Date.now(); const host=leaf.checkHost(request.hostname);',
        'const accepted=ca.ca&&!leaf.ca&&host&&leaf.issuer===ca.subject&&leaf.verify(ca.publicKey)&&current>=Date.parse(leaf.validFrom)&&current<=Date.parse(leaf.validTo)&&current>=Date.parse(ca.validFrom)&&current<=Date.parse(ca.validTo)&&leaf.keyUsage?.includes("1.3.6.1.5.5.7.3.1");if(!accepted)globalThis.__fixtureCertificateRejections.push({hostname:request.hostname,hostMatches:Boolean(host),expired:current>Date.parse(leaf.validTo),authorityMatches:leaf.issuer===ca.subject&&leaf.verify(ca.publicKey)});done(accepted?0:-2);}catch{done(-2);}});}return target;};',
      ] : []),
      'require(' + JSON.stringify(path.join(root, 'desktop/main.cjs')) + ');',
    ].join('\n'));
    application = await electron.launch({ args: [launcher, '--user-data-dir=' + userData],
      env: { ...process.env, TRACEOMICS_DESKTOP_URL: '' }, artifactsDir: output,
      recordVideo: { dir: videoDirectory, size: { width: 1200, height: 900 },
        showActions: { duration: 700, position: 'bottom-right', fontSize: 16 } }, timeout: 60000 });
    application.process().stderr.on('data', chunk => fs.appendFileSync(path.join(output, 'electron-diagnostics.txt'), chunk.toString().split(privateDirectory).join('[private fixture]')));
    const setup = await application.firstWindow();
    if (restoreSelected) {
      await setup.waitForURL(service.endpoint + '**', { timeout: 30_000 });
      await setup.locator('[aria-label="Execution target"]').getByText('SSH tunnel connected', { exact: true }).waitFor({ timeout: 30_000 });
      await recordWindows('restored-tunneled-workspace');
      return setup;
    }
    await setup.getByRole('heading', { name: 'Choose your research server', exact: true }).waitFor();
    await setup.locator('#saved-target').selectOption(direct ? 'direct-lab' : profile.id);
    await recordWindows(direct ? 'direct-connection-settings' : 'ssh-connection-settings');
    return setup;
  }
  async function connect(setup) {
    const waiting = application.waitForEvent('window'); await setup.getByRole('button', { name: 'Connect HTTPS service', exact: true }).click();
    const page = await waiting; await page.waitForURL(service.endpoint + '**', { timeout: 30000 });
    await recordWindows('opened-project-service'); return page;
  }
  async function openSettings(page) { const waiting = application.waitForEvent('window'); await page.evaluate(() => window.desktopShell.openTargetSettings()); const setup = await waiting; await setup.locator('#saved-target').selectOption(profile.id); await recordWindows('opened-connection-settings'); return setup; }
  async function setRemoteServicePort(setup, port) {
    const disclosure = setup.locator('#ssh-advanced');
    if (!(await disclosure.evaluate(element => element.open))) await disclosure.locator('summary').click();
    await setup.locator('#remote-port').fill(String(port));
  }
  async function restartWorkspace() {
    const previousPort = await application.evaluate(() => globalThis.__fixtureTunnelPort);
    await application.close(); application = null;
    await waitFor(async () => !(await isListening(previousPort)), 'Closing the complete desktop app left its native forward listening.');
    await waitFor(async () => !fs.readdirSync(userData).some(name => name.startsWith('.ssh-route-') || name.startsWith('.ssh-policy-')),
      'Closing the complete desktop app left an owned SSH policy snapshot behind.');
    const workspace = await launch({ restoreSelected: true });
    assert((await workspace.evaluate(async () => (await fetch('/api/auth/session')).status)) === 200,
      'Reopening the complete desktop app did not restore the authenticated target partition.');
    return { workspace, application };
  }
  async function createPeerWorkspace(page) {
    // Production desktop opens one work window. This disposable second
    // renderer shares that real SSH/TLS session to certify the browser ledger.
    // Its preload copies only the already-verified readonly target descriptor;
    // it cannot invoke native connection controls or change production policy.
    const target = await page.evaluate(() => window.desktopShell.getCurrentTarget());
    const preload = path.join(privateDirectory, 'readonly-peer-preload.cjs');
    fs.writeFileSync(preload, "const {contextBridge}=require('electron');contextBridge.exposeInMainWorld('desktopShell',Object.freeze({getCurrentTarget:async()=>("
      + JSON.stringify(target) + '),onTargetStatus:()=>()=>{}}));\n');
    const nativeWindow = await application.browserWindow(page);
    const opening = application.waitForEvent('window');
    try {
      const sourceId = await nativeWindow.evaluate(source => source.id);
      await application.evaluate(({ BrowserWindow }, { sourceId, preload, endpoint }) => {
        const source = BrowserWindow.fromId(sourceId);
        const peer = new BrowserWindow({ width: 1440, height: 960, show: false,
          webPreferences: { session: source.webContents.session,
            contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, preload } });
        if (peer.webContents.session !== source.webContents.session) {
          peer.destroy(); throw new Error('The disposable peer did not share the original native session.');
        }
        void peer.loadURL(endpoint);
      }, { sourceId, preload, endpoint: service.endpoint });
    } finally { await nativeWindow.dispose(); }
    const peer = await opening;
    await peer.waitForURL(service.endpoint + '**', { timeout: 30_000 });
    await peer.locator('[aria-label="Execution target"]').getByText('SSH tunnel connected', { exact: true }).waitFor({ timeout: 30_000 });
    assert((await peer.evaluate(async () => (await fetch('/api/auth/session')).status)) === 200,
      'The disposable peer did not share the actual authenticated HTTPS target partition.');
    await recordWindows('shared-session-peer-window');
    return peer;
  }
  async function failedConnect(setup, expression) { await setup.getByRole('button', { name: 'Connect HTTPS service', exact: true }).click(); await setup.getByRole('alert').filter({ hasText: expression }).waitFor({ timeout: 30000 }); }
  try {
    service = await serviceFactory({ artifactDirectory: output }); profile.endpoint = service.endpoint;
    fs.writeFileSync(path.join(output, 'Dockerfile'), [
      'FROM alpine:3.21', 'RUN apk add --no-cache openssh-server socat && for account in gatekeeper researcher; do adduser -D "$account"; echo "$account:disabled-fixture-password" | chpasswd; done',
      'COPY sshd_config /fixture/sshd_config',
      'CMD ' + JSON.stringify(['/bin/sh', '-ec', 'mkdir -p /home/$FIXTURE_USER/.ssh /run/sshd; cp /fixture/authorized_key /home/$FIXTURE_USER/.ssh/authorized_keys; chown -R $FIXTURE_USER:$FIXTURE_USER /home/$FIXTURE_USER/.ssh; chmod 700 /home/$FIXTURE_USER/.ssh; chmod 600 /home/$FIXTURE_USER/.ssh/authorized_keys; ssh-keygen -A; if [ -n "$HTTPS_PORT" ]; then socat TCP-LISTEN:8443,bind=127.0.0.1,reuseaddr,fork TCP:host.docker.internal:$HTTPS_PORT & socat TCP-LISTEN:8444,bind=127.0.0.1,reuseaddr,fork TCP:host.docker.internal:$HTTPS_PORT & fi; exec /usr/sbin/sshd -D -e -f /fixture/sshd_config']),
    ].join('\n') + '\n');
    fs.writeFileSync(path.join(output, '.dockerignore'), '*\n!Dockerfile\n!sshd_config\n');
    fs.writeFileSync(path.join(output, 'sshd_config'), [
      'Port 2222', 'ListenAddress 0.0.0.0', 'HostKey /etc/ssh/ssh_host_ed25519_key', 'PubkeyAuthentication yes', 'PasswordAuthentication no', 'KbdInteractiveAuthentication no',
      'PermitRootLogin no', 'AllowUsers gatekeeper researcher', 'AllowTcpForwarding yes', 'PermitTTY no', 'AllowAgentForwarding no', 'X11Forwarding no', 'LogLevel DEBUG3', 'PerSourcePenalties no',
    ].join('\n') + '\n');
    for (let index = 0; index < identities.length; index++) { await command(systemExecutable('ssh-keygen'), ['-t', 'ed25519', '-N', '', '-C', '', '-f', identities[index]]); fs.copyFileSync(identities[index] + '.pub', publicFiles[index]); }
    await command('docker', ['build', '-t', image, output], { timeout: 180000 }); await command('docker', ['network', 'create', network]); networkCreated = true;
    const hostKeys = [];
    for (let index = 0; index < names.length; index++) {
      await command('docker', ['run', '-d', '--rm', '--name', names[index], '--network', network, '--add-host', 'host.docker.internal:host-gateway',
        ...(index === 0 ? ['-p', `127.0.0.1:${hostPort}:2222`] : ['-e', 'HTTPS_PORT=' + service.httpsPort]), '-e', 'FIXTURE_USER=' + accounts[index],
        '--mount', `type=bind,source=${publicFiles[index]},target=/fixture/authorized_key,readonly`, image]); started.add(names[index]);
      await waitFor(async () => { try { const value = await command('docker', ['exec', names[index], 'cat', '/etc/ssh/ssh_host_ed25519_key.pub']); const keys = scannedHostKeys('fixture ' + value.split(/\s+/).slice(0, 2).join(' ')); if (keys.length) { hostKeys[index] = keys[0]; return true; } } catch { /* Daemon startup. */ } return false; }, 'Disposable SSH daemon did not start.');
    }
    fs.writeFileSync(nativeKnownHosts, hostKeys.map((key, index) => `tunnel-pin-${index} ${key.algorithm} ${key.publicKey}\n`).join(''));
    const includedFile = path.join(privateDirectory, 'Native included settings');
    fs.writeFileSync(includedFile, ['Host *', ' IdentityAgent none', ' IdentitiesOnly yes', ' GlobalKnownHostsFile none', ' UserKnownHostsFile ' + quoted(nativeKnownHosts),
      ` LocalForward 127.0.0.1:${extraLocalPort} 127.0.0.1:5432`, ` DynamicForward 127.0.0.1:${extraDynamicPort}`, ' RemoteForward 9999 127.0.0.1:6311',
    ].join('\n') + '\n');
    fs.writeFileSync(nativeConfigFile, ['Include ' + quoted(includedFile), ...aliases.flatMap((alias, index) => [
      'Host ' + alias, ' HostName ' + (index === 0 ? '127.0.0.1' : names[1]), ' Port ' + (index === 0 ? hostPort : 2222),
      ' User ' + accounts[index], ' IdentityFile ' + quoted(identities[index]), ' HostKeyAlias tunnel-pin-' + index, ...(index ? [' ProxyJump ' + aliases[0]] : []),
    ])].join('\n') + '\n');
    const nativeHash = digest(nativeConfigFile), trustHash = digest(nativeKnownHosts), includeHash = digest(includedFile);
    const directProfile = { id: 'direct-lab', name: 'Direct lab', kind: 'https', endpoint: service.endpoint };
    saveSettings(directProfile);
    let setup = await launch({ trustFixtureCa: false, direct: true });
    await setup.getByRole('button', { name: 'Save and connect', exact: true }).click();
    await setup.getByRole('alert').filter({ hasText: /certificate was rejected/i }).waitFor();
    await application.close(); application = null;
    setup = await launch({ direct: true });
    const openingDirect = application.waitForEvent('window');
    await setup.getByRole('button', { name: 'Save and connect', exact: true }).click();
    const directWorkspace = await openingDirect;
    await directWorkspace.getByRole('button', { name: 'Open Workbench', exact: true }).waitFor();
    const directTarget = await directWorkspace.evaluate(() => window.desktopShell.getCurrentTarget());
    assert(directTarget.kind === 'https' && directTarget.status === 'connected'
      && directTarget.serviceCompatibility?.product === 'TraceOmics' && !directTarget.sshTunnel && !directTarget.capabilities,
    'Actual direct HTTPS did not retain verified compatibility separately from SSH and compute capability.');
    assert(new URL(directWorkspace.url()).origin === service.endpoint
      && (await directWorkspace.evaluate(async () => (await fetch('/api/runtime/readiness')).status)) === 401,
    'Direct HTTPS rewrote the original browser authority or disclosed authenticated readiness.');
    await directWorkspace.screenshot({ path: path.join(output, 'direct-https-compatible-login.png') });
    await application.close(); application = null;
    checks.push('actual direct HTTPS uses the isolated Chromium transport, rejects an untrusted certificate, verifies the public service API and opens sign-in without claiming compute readiness');
    saveSettings(profile);
    setup = await launch({ trustFixtureCa: false });
    await failedConnect(setup, /certificate was rejected/i);
    await setup.screenshot({ path: path.join(output, 'native-untrusted-certificate-rejected.png'), fullPage: true });
    assert(!(await isListening(extraLocalPort)) && !(await isListening(extraDynamicPort)), 'Inherited native forwarding opened another service.');
    await application.close(); application = null;
    checks.push('actual Chromium rejects a disposable untrusted certificate without any production trust bypass; native forwarding rules stay inactive');
    setup = await launch({ forcePortConflict: true }); let workspace = await connect(setup);
    assert(await application.evaluate(() => globalThis.__fixturePortConflictRetried), 'A real native local-forward conflict did not safely allocate another port.');
    checks.push('a real occupied local port fails native forwarding and retries with a fresh app-owned loopback port');
    await workspace.getByRole('button', { name: 'Open Workbench', exact: true }).waitFor();
    const preloginReadiness = await workspace.evaluate(async () => {
      const response = await fetch('/api/runtime/readiness'); return { status: response.status, data: await response.json() };
    });
    assert(preloginReadiness.status === 401 && !preloginReadiness.data.guided && !preloginReadiness.data.storage,
      'Prelogin SSH application connectivity disclosed authenticated runtime readiness.');
    await workspace.getByLabel('Email', { exact: true }).fill(service.account.email);
    await workspace.getByLabel('Password', { exact: true }).fill(service.account.password);
    await workspace.getByRole('button', { name: 'Open Workbench', exact: true }).click();
    const indicator = workspace.locator('[aria-label="Execution target"]');
    const connectionSummary = indicator.locator('summary').filter({ hasText: 'Connection details' });
    await connectionSummary.click();
    const connectionPanelId = await connectionSummary.getAttribute('aria-controls');
    const connectionPanel = workspace.locator('[id=' + JSON.stringify(connectionPanelId) + ']');
    await connectionPanel.getByText('Server: Tunneled lab', { exact: true }).waitFor({ timeout: 30000 });
    await indicator.getByText('SSH tunnel connected', { exact: true }).waitFor();
    assert(await connectionPanel.getByText(service.endpoint, { exact: true }).isVisible(), 'The original HTTPS endpoint is missing.');
    assert(new URL(workspace.url()).origin === service.endpoint, 'The native tunnel rewrote the browser origin.');
    const target = await workspace.evaluate(() => window.desktopShell.getCurrentTarget());
    assert(target.status === 'connected' && target.sshTunnel.state === 'connected' && target.sshAuthentication.host === names[1] && target.sshAuthentication.applicationConnected === true, 'A real verified application tunnel was not reported accurately.');
    assert(target.serviceCompatibility?.product === 'TraceOmics' && !target.capabilities,
      'The connected native target did not retain verified API compatibility separately from compute readiness.');
    assert(!identities.some(file => JSON.stringify(target).includes(file)), 'The remote page saw a native identity path.');
    const cookies = await application.evaluate(async ({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().startsWith('https:')).webContents.session.cookies.get({}));
    const sessionCookie = cookies.find(cookie => cookie.httpOnly);
    assert(sessionCookie?.secure && sessionCookie.sameSite === 'lax' && sessionCookie.domain === new URL(service.endpoint).hostname, 'The authenticated session lost Secure/HttpOnly/SameSite or its original cookie authority.');
    const auth = await workspace.evaluate(async () => { const response = await fetch('/api/auth/session'); return { status: response.status, data: await response.json(), visible: document.cookie }; });
    assert(auth.status === 200 && !auth.visible.includes(sessionCookie.value), 'Authentication did not use an inaccessible HttpOnly cookie.');
    const projects = await workspace.evaluate(async () => { const response = await fetch('/api/projects'); return { status: response.status, data: await response.json() }; });
    assert(projects.status === 200 && JSON.stringify(projects.data).includes(service.project.id), 'The production project API did not authorize the real PG-backed account.');
    if (!exerciseWorkspace) {
    const readiness = await workspace.evaluate(async () => {
      const response = await fetch('/api/runtime/readiness'); return { status: response.status, data: await response.json() };
    });
    assert(readiness.status === 200 && readiness.data.schema === 'traceomics.runtime-readiness.v1'
      && readiness.data.service.state === 'ready' && readiness.data.guided.state !== 'ready'
      && readiness.data.guided.packages.every(pkg => pkg.state === 'unknown')
      && readiness.data.workers.state === 'unknown' && readiness.data.privateR.environment === null,
    'Real authenticated readiness fabricated packages, worker liveness or private environment access.');
    await connectionPanel.getByRole('button', { name: 'Check server readiness', exact: true }).click();
    const readinessDialog = workspace.getByRole('dialog', { name: 'Server readiness', exact: true });
    await readinessDialog.getByText('This server supports the current application.', { exact: false }).waitFor();
    await readinessDialog.getByRole('heading', { name: 'Queued analysis worker', exact: true }).waitFor();
    assert(await readinessDialog.getByText('No current queued-worker observation is available.', { exact: false }).isVisible(),
      'The native readiness dialog hides the missing durable-worker observation.');
    assert(!String(await readinessDialog.textContent()).includes(service.storageRoot), 'Readiness leaked a raw server storage path.');
    await workspace.screenshot({ path: path.join(output, 'authenticated-native-server-readiness.png') });
    service.setRuntimeHealth({ status: 'ok', r_version: '4.5.2', packages: {
      Seurat: false, dplyr: true, plumber: true, jsonlite: true, ggplot2: true,
    } });
    await waitFor(async () => workspace.evaluate(async () => {
      const response = await fetch('/api/runtime/readiness');
      return response.ok && (await response.json()).guided.state === 'missing-packages';
    }), 'Authenticated readiness did not renew a controlled missing-package observation.', 15000);
    await readinessDialog.getByRole('button', { name: 'Check again', exact: true }).click();
    await readinessDialog.getByText('Required packages missing', { exact: true }).waitFor();
    await readinessDialog.locator('summary').filter({ hasText: 'Required and optional packages' }).click();
    await readinessDialog.getByText('Seurat: Missing', { exact: true }).waitFor();
    await workspace.screenshot({ path: path.join(output, 'native-readiness-missing-package.png') });
    service.setRuntimeHealth({ status: 'ok' });
    await readinessDialog.getByRole('button', { name: 'Close server readiness', exact: true }).click();
    checks.push('prelogin compatibility exposes no compute details; authenticated HTTPS/PG readiness and its actual React dialog report unknown packages/worker honestly and conceal inaccessible private environments');
    checks.push('a controlled guided-service missing-package observation renews after the cache bound and the actual native dialog reports Seurat missing separately from transport and application authentication');
    }
    await workspace.screenshot({ path: path.join(output, 'authenticated-production-workspace.png') });
    checks.push('real production Express/PG login and project access work through distinct native SSH identities while original HTTPS origin, SNI and Secure/HttpOnly/Lax cookies remain intact');
    checks.push('actual React execution-target indicator reports the verified HTTPS application tunnel without exposing native credential references');
    const denied = await workspace.evaluate(async () => { try { await window.desktopShell.disconnectTarget(); return false; } catch { return true; } });
    assert(denied, 'A remote renderer could manage the native tunnel.');
    assert(await workspace.evaluate(async () => { try { await fetch('https://other.tunnel.test/api/auth/policy'); return false; } catch { return true; } }), 'The session proxy permitted another authority.');
    assert(!(await isListening(extraLocalPort)) && !(await isListening(extraDynamicPort)), 'A saved unrelated forwarding mode became active.');
    checks.push('remote renderer cannot disconnect or edit native transport; partition requests cannot escape the configured authority; native local/dynamic/remote forwards are stripped');
    const forwardPort = await application.evaluate(() => globalThis.__fixtureTunnelPort);
    const csrf = await new Promise((resolve, reject) => {
      const request = https.request({ hostname: '127.0.0.1', port: forwardPort, servername: new URL(service.endpoint).hostname,
        ca: fs.readFileSync(service.caCertificatePath), method: 'POST', path: '/api/auth/logout',
        headers: { Host: new URL(service.endpoint).host, Origin: 'https://attacker.invalid', Cookie: sessionCookie.name + '=' + sessionCookie.value } }, response => { response.resume(); resolve(response.statusCode); });
      request.on('error', reject); request.end();
    });
    assert(csrf === 403, 'Production CSRF/origin validation accepted a foreign origin through the tunnel.');
    checks.push('actual production cookie-auth mutation rejects a foreign origin through the same TLS/SSH transport');
    if (exerciseWorkspace) workspace = await exerciseWorkspace({ workspace, application, service, openSettings, connect, restartWorkspace, createPeerWorkspace }) || workspace;
    await workspace.evaluate(() => localStorage.setItem('tunnel-selected-project', 'original-project-selection'));
    setup = await openSettings(workspace);
    const savedBeforeApiFailure = fs.readFileSync(path.join(userData, 'desktop-settings.json'), 'utf8');
    service.setCompatibilityResponse({ product: 'TraceOmics', serviceApiVersion: 2, minimumClientApiVersion: 2 });
    await failedConnect(setup, /service API is incompatible/i);
    assert(fs.readFileSync(path.join(userData, 'desktop-settings.json'), 'utf8') === savedBeforeApiFailure
      && (await workspace.evaluate(async () => (await fetch('/api/auth/session')).status)) === 200,
    'A freshly incompatible same-target API displaced the old authenticated SSH workspace.');
    service.setCompatibilityResponse({ error: 'Legacy application.' }, 404);
    await failedConnect(setup, /does not publish a TraceOmics compatibility descriptor/i);
    assert((await workspace.evaluate(() => window.desktopShell.getCurrentTarget())).status === 'connected',
      'A missing same-target API descriptor tore down an existing verified tunnel.');
    service.setCompatibilityResponse(null);
    await setup.screenshot({ path: path.join(output, 'incompatible-api-preserves-workspace.png'), fullPage: true });
    checks.push('same-target native SSH reconnect rechecks the public API and rejects incompatible/legacy service responses while preserving authenticated work and saved connection settings');
    await setup.locator('#server-url').fill(service.endpoint.replace('analysis.tunnel.test', 'wrong.tunnel.test'));
    await failedConnect(setup, /certificate was rejected|could not reach/i);
    assert(await application.evaluate(() => globalThis.__fixtureCertificateRejections.some(rejection => rejection.hostname === 'wrong.tunnel.test' && !rejection.hostMatches)), 'Wrong-host rejection did not come from strict TLS hostname validation.');
    assert(await workspace.evaluate(() => localStorage.getItem('tunnel-selected-project')) === 'original-project-selection', 'A failed certificate switch destroyed the current workspace.');
    assert((await workspace.evaluate(async () => (await fetch('/api/auth/session')).status)) === 200, 'Failed certificate switching disconnected the old authenticated tunnel.');
    await setup.screenshot({ path: path.join(output, 'wrong-authority-preserves-workspace.png'), fullPage: true });
    checks.push('actual certificate hostname mismatch rejects the candidate and preserves the old authenticated workspace and native tunnel');
    await setup.locator('#server-url').fill(service.endpoint); await setRemoteServicePort(setup, 1);
    await failedConnect(setup, /could not reach|could not forward|canceled/i);
    assert((await workspace.evaluate(async () => (await fetch('/api/auth/session')).status)) === 200, 'Failed destination forwarding displaced the current tunnel.');
    checks.push('actual refused loopback service forwarding fails before switching and preserves the existing session');
    await setRemoteServicePort(setup, 8444);
    const openssl = process.platform === 'win32' && fs.existsSync('C:\\Program Files\\Git\\usr\\bin\\openssl.exe') ? 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe' : 'openssl';
    const tlsDirectory = path.dirname(service.caCertificatePath), expiredCertificate = path.join(privateDirectory, 'expired-leaf.pem');
    await command(openssl, ['x509', '-req', '-in', path.join(tlsDirectory, 'leaf.csr'), '-CA', service.caCertificatePath,
      '-CAkey', path.join(tlsDirectory, 'ca-key.pem'), '-set_serial', '8193', '-days', '-1', '-sha256',
      '-extfile', path.join(tlsDirectory, 'leaf.ext'), '-out', expiredCertificate]);
    service.setTlsCertificate({ certificatePath: expiredCertificate, privateKeyPath: service.privateKeyPath });
    await failedConnect(setup, /certificate was rejected|could not reach/i);
    assert(await application.evaluate(() => globalThis.__fixtureCertificateRejections.some(rejection => rejection.expired && rejection.authorityMatches && rejection.hostMatches)), 'Expired certificate was not independently rejected by the strict fixture verifier.');
    const unrelatedCertificate = path.join(privateDirectory, 'unrelated-leaf.pem'), unrelatedKey = path.join(privateDirectory, 'unrelated-key.pem');
    await command(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '2',
      '-subj', '/CN=analysis.tunnel.test', '-addext', 'subjectAltName=DNS:analysis.tunnel.test', '-addext', 'extendedKeyUsage=serverAuth',
      '-keyout', unrelatedKey, '-out', unrelatedCertificate]);
    service.setTlsCertificate({ certificatePath: unrelatedCertificate, privateKeyPath: unrelatedKey });
    await failedConnect(setup, /certificate was rejected|could not reach/i);
    assert(await application.evaluate(() => globalThis.__fixtureCertificateRejections.some(rejection => !rejection.authorityMatches && rejection.hostMatches && !rejection.expired)), 'An unrelated certificate authority was not independently rejected.');
    service.setTlsCertificate({ certificatePath: service.certificatePath, privateKeyPath: service.privateKeyPath });
    assert((await workspace.evaluate(async () => (await fetch('/api/auth/session')).status)) === 200, 'Rejected expired/untrusted candidates displaced the existing authenticated workspace.');
    checks.push('expired and unrelated-authority certificates fail strict TLS validation over actual SSH while the original authenticated workspace remains available');
    const switching = application.waitForEvent('window'); await setup.getByRole('button', { name: 'Connect HTTPS service', exact: true }).click(); const alternate = await switching;
    await alternate.getByRole('button', { name: 'Open Workbench', exact: true }).waitFor({ timeout: 30000 });
    const alternateState = await alternate.evaluate(async () => ({ remembered: localStorage.getItem('tunnel-selected-project'), status: (await fetch('/api/auth/session')).status }));
    assert(alternateState.remembered === null && alternateState.status === 401, 'Switching resolved service identities carried project selection or session credentials.');
    checks.push('switching another SSH loopback service creates an isolated cookie/storage partition even with the same HTTPS authority');
    setup = await openSettings(alternate); await setRemoteServicePort(setup, 8443); const returning = application.waitForEvent('window'); await setup.getByRole('button', { name: 'Connect HTTPS service', exact: true }).click(); const restored = await returning;
    await restored.locator('[aria-label="Execution target"]').getByText('SSH tunnel connected', { exact: true }).waitFor({ timeout: 30000 });
    assert(await restored.evaluate(() => localStorage.getItem('tunnel-selected-project')) === 'original-project-selection', 'The original service partition did not restore.');
    checks.push('returning to the original resolved service restores only its own authenticated session and workspace selection');
    setup = await openSettings(restored);
    await setup.screenshot({ path: path.join(output, 'native-tunnel-connected-settings.png'), fullPage: true });
    const closedPort = await application.evaluate(() => globalThis.__fixtureTunnelPort);
    await setup.getByRole('button', { name: 'Disconnect SSH tunnel', exact: true }).click();
    await restored.locator('[aria-label="Execution target"]').getByText('SSH tunnel disconnected', { exact: true }).waitFor();
    await waitFor(async () => !(await isListening(closedPort)), 'Explicit native disconnect left its owned forward listening.');
    assert((await restored.evaluate(() => window.desktopShell.getCurrentTarget())).sshAuthentication.applicationConnected === false, 'Disconnect kept authenticated application connectivity in metadata.');
    await setup.screenshot({ path: path.join(output, 'native-tunnel-disconnected-settings.png'), fullPage: true });
    await recordWindows('explicitly-disconnected');
    const reconnecting = application.waitForEvent('window'); await setup.getByRole('button', { name: 'Connect HTTPS service', exact: true }).click(); const reconnected = await reconnecting;
    await reconnected.locator('[aria-label="Execution target"]').getByText('SSH tunnel connected', { exact: true }).waitFor({ timeout: 30000 });
    assert(await reconnected.evaluate(() => localStorage.getItem('tunnel-selected-project')) === 'original-project-selection', 'Native reconnect lost the original service selection.');
    await reconnected.screenshot({ path: path.join(output, 'native-tunnel-reconnected-workspace.png') });
    await recordWindows('explicitly-reconnected');
    checks.push('explicit native disconnect removes only the owned forward and an explicit reconnect restores the same isolated authenticated workspace');
    await command('docker', ['stop', names[1]]); started.delete(names[1]);
    await reconnected.locator('[aria-label="Execution target"]').getByText('SSH tunnel disconnected', { exact: true }).waitFor({ timeout: 20000 });
    assert((await reconnected.evaluate(() => window.desktopShell.getCurrentTarget())).status === 'disconnected', 'Native transport loss still claimed application connectivity.');
    assert(await reconnected.evaluate(async () => { try { await fetch('/api/auth/session'); return false; } catch { return true; } }), 'Transport loss silently used a direct or local service.');
    await reconnected.screenshot({ path: path.join(output, 'native-tunnel-loss-workspace.png') });
    await recordWindows('ssh-daemon-lost');
    checks.push('actual SSH daemon loss updates the existing React workspace, disables remote requests and never falls back to another service');
    await application.close(); application = null;
    await waitFor(async () => !fs.readdirSync(userData).some(name => name.startsWith('.ssh-route-') || name.startsWith('.ssh-policy-')), 'Closing desktop left an owned native policy behind.');
    assert(digest(nativeConfigFile) === nativeHash && digest(nativeKnownHosts) === trustHash && digest(includedFile) === includeHash, 'Tunneling modified user-owned native SSH policy.');
    for (let index = 0; index < originalFiles.length; index++) assert(digest(originalFiles[index]) === originalHashes[index], 'Acceptance modified the real user SSH configuration or trust.');
    checks.push('window shutdown cleans owned route snapshots and tunnel descendants while user SSH policy, trust, keys and agents remain untouched');
    const videos = fs.readdirSync(videoDirectory).filter(name => name.endsWith('.webm')).sort();
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ ok: true, checks, endpoint: service.endpoint,
      videoFiles: videos.map(name => path.join('video', name)), windowRecordCount: windowRecords.length,
      screenshots: fs.readdirSync(output).filter(name => name.endsWith('.png')).length }, null, 2) + '\n');
    return { ok: true, checks: checks.length, videos: videos.length, windows: windowRecords.length,
      screenshots: fs.readdirSync(output).filter(name => name.endsWith('.png')).length, artifactDirectory: output };
  } catch (error) {
    if (application) { for (const [index, page] of application.windows().entries()) await page.screenshot({ path: path.join(output, 'failure-' + index + '.png'), fullPage: true }).catch(() => {}); }
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ ok: false, checks, error: error.message }, null, 2) + '\n'); throw error;
  } finally {
    if (application) await application.close().catch(() => {});
    for (const name of started) await command('docker', ['rm', '-f', name]).catch(() => {});
    if (networkCreated) await command('docker', ['network', 'rm', network]).catch(() => {});
    await command('docker', ['image', 'rm', image]).catch(() => {});
    await service?.stop();
    assert(path.dirname(path.resolve(privateDirectory)) === path.resolve(os.tmpdir()) && path.basename(privateDirectory).startsWith('traceomics-tunnel-'), 'Unsafe native fixture cleanup.');
    await fs.promises.rm(privateDirectory, { recursive: true, force: true });
  }
}
if (require.main === module) runDesktopTunnelAcceptance().then(result => process.stdout.write(JSON.stringify(result) + '\n')).catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
module.exports = { runDesktopTunnelAcceptance };
