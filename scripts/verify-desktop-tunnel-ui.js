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
async function runDesktopTunnelAcceptance({ artifactDirectory } = {}) {
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
  fs.mkdirSync(userData, { recursive: true });
  await secureFixtureDirectory(privateDirectory, output);
  function saveSettings(profile, selected = null) { fs.writeFileSync(path.join(userData, 'desktop-settings.json'), JSON.stringify({ schemaVersion: 1, selectedProfileId: selected, profiles: [profile] })); }
  const profile = { id: 'tunneled-lab', name: 'Tunneled lab', kind: 'ssh',
    ssh: { host: aliases[1], remoteHost: '127.0.0.1', remotePort: 8443 } };
  async function launch({ trustFixtureCa = true, forcePortConflict = false } = {}) {
    const launcher = path.join(privateDirectory, 'native-launcher.cjs');
    const ca = service.caCertificatePath;
    fs.writeFileSync(launcher, [
      "const fs=require('node:fs'); const {X509Certificate}=require('node:crypto'); const {session}=require('electron');",
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
    application = await electron.launch({ args: [launcher, '--user-data-dir=' + userData], env: { ...process.env, TRACEOMICS_DESKTOP_URL: '' }, timeout: 60000 });
    application.process().stderr.on('data', chunk => fs.appendFileSync(path.join(output, 'electron-diagnostics.txt'), chunk.toString().split(privateDirectory).join('[private fixture]')));
    const setup = await application.firstWindow(); await setup.getByRole('heading', { name: 'Choose your research server', exact: true }).waitFor();
    await setup.locator('#saved-target').selectOption(profile.id); return setup;
  }
  async function connect(setup) {
    const waiting = application.waitForEvent('window'); await setup.getByRole('button', { name: 'Connect HTTPS service', exact: true }).click();
    const page = await waiting; await page.waitForURL(service.endpoint + '**', { timeout: 30000 }); return page;
  }
  async function openSettings(page) { const waiting = application.waitForEvent('window'); await page.evaluate(() => window.desktopShell.openTargetSettings()); const setup = await waiting; await setup.locator('#saved-target').selectOption(profile.id); return setup; }
  async function failedConnect(setup, expression) { await setup.getByRole('button', { name: 'Connect HTTPS service', exact: true }).click(); await setup.getByRole('alert').filter({ hasText: expression }).waitFor({ timeout: 30000 }); }
  try {
    service = await createDesktopTunnelServiceFixture({ artifactDirectory: output }); profile.endpoint = service.endpoint;
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
    saveSettings(profile);
    let setup = await launch({ trustFixtureCa: false });
    await failedConnect(setup, /certificate was rejected/i);
    await setup.screenshot({ path: path.join(output, 'native-untrusted-certificate-rejected.png'), fullPage: true });
    assert(!(await isListening(extraLocalPort)) && !(await isListening(extraDynamicPort)), 'Inherited native forwarding opened another service.');
    await application.close(); application = null;
    checks.push('actual Chromium rejects a disposable untrusted certificate without any production trust bypass; native forwarding rules stay inactive');
    setup = await launch({ forcePortConflict: true }); const workspace = await connect(setup);
    assert(await application.evaluate(() => globalThis.__fixturePortConflictRetried), 'A real native local-forward conflict did not safely allocate another port.');
    checks.push('a real occupied local port fails native forwarding and retries with a fresh app-owned loopback port');
    await workspace.getByRole('button', { name: 'Open Workbench', exact: true }).waitFor();
    await workspace.getByLabel('Email', { exact: true }).fill(service.account.email);
    await workspace.getByLabel('Password', { exact: true }).fill(service.account.password);
    await workspace.getByRole('button', { name: 'Open Workbench', exact: true }).click();
    const indicator = workspace.locator('[aria-label="Execution target"]');
    await indicator.getByText('Server: Tunneled lab', { exact: true }).waitFor({ timeout: 30000 });
    await indicator.getByText('SSH tunnel connected', { exact: true }).waitFor();
    assert(await indicator.getByText(service.endpoint, { exact: true }).isVisible(), 'The original HTTPS endpoint is missing.');
    assert(new URL(workspace.url()).origin === service.endpoint, 'The native tunnel rewrote the browser origin.');
    const target = await workspace.evaluate(() => window.desktopShell.getCurrentTarget());
    assert(target.status === 'connected' && target.sshTunnel.state === 'connected' && target.sshAuthentication.host === names[1] && target.sshAuthentication.applicationConnected === true, 'A real verified application tunnel was not reported accurately.');
    assert(!identities.some(file => JSON.stringify(target).includes(file)), 'The remote page saw a native identity path.');
    const cookies = await application.evaluate(async ({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().startsWith('https:')).webContents.session.cookies.get({}));
    const sessionCookie = cookies.find(cookie => cookie.httpOnly);
    assert(sessionCookie?.secure && sessionCookie.sameSite === 'lax' && sessionCookie.domain === new URL(service.endpoint).hostname, 'The authenticated session lost Secure/HttpOnly/SameSite or its original cookie authority.');
    const auth = await workspace.evaluate(async () => { const response = await fetch('/api/auth/session'); return { status: response.status, data: await response.json(), visible: document.cookie }; });
    assert(auth.status === 200 && !auth.visible.includes(sessionCookie.value), 'Authentication did not use an inaccessible HttpOnly cookie.');
    const projects = await workspace.evaluate(async () => { const response = await fetch('/api/projects'); return { status: response.status, data: await response.json() }; });
    assert(projects.status === 200 && JSON.stringify(projects.data).includes(service.project.id), 'The production project API did not authorize the real PG-backed account.');
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
    await workspace.evaluate(() => localStorage.setItem('tunnel-selected-project', 'original-project-selection'));
    setup = await openSettings(workspace); await setup.locator('#server-url').fill(service.endpoint.replace('analysis.tunnel.test', 'wrong.tunnel.test'));
    await failedConnect(setup, /certificate was rejected|could not reach/i);
    assert(await application.evaluate(() => globalThis.__fixtureCertificateRejections.some(rejection => rejection.hostname === 'wrong.tunnel.test' && !rejection.hostMatches)), 'Wrong-host rejection did not come from strict TLS hostname validation.');
    assert(await workspace.evaluate(() => localStorage.getItem('tunnel-selected-project')) === 'original-project-selection', 'A failed certificate switch destroyed the current workspace.');
    assert((await workspace.evaluate(async () => (await fetch('/api/auth/session')).status)) === 200, 'Failed certificate switching disconnected the old authenticated tunnel.');
    await setup.screenshot({ path: path.join(output, 'wrong-authority-preserves-workspace.png'), fullPage: true });
    checks.push('actual certificate hostname mismatch rejects the candidate and preserves the old authenticated workspace and native tunnel');
    await setup.locator('#server-url').fill(service.endpoint); await setup.locator('#remote-port').fill('1');
    await failedConnect(setup, /could not reach|could not forward|canceled/i);
    assert((await workspace.evaluate(async () => (await fetch('/api/auth/session')).status)) === 200, 'Failed destination forwarding displaced the current tunnel.');
    checks.push('actual refused loopback service forwarding fails before switching and preserves the existing session');
    await setup.locator('#remote-port').fill('8444');
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
    setup = await openSettings(alternate); await setup.locator('#remote-port').fill('8443'); const returning = application.waitForEvent('window'); await setup.getByRole('button', { name: 'Connect HTTPS service', exact: true }).click(); const restored = await returning;
    await restored.locator('[aria-label="Execution target"]').getByText('SSH tunnel connected', { exact: true }).waitFor({ timeout: 30000 });
    assert(await restored.evaluate(() => localStorage.getItem('tunnel-selected-project')) === 'original-project-selection', 'The original service partition did not restore.');
    checks.push('returning to the original resolved service restores only its own authenticated session and workspace selection');
    setup = await openSettings(restored); const closedPort = await application.evaluate(() => globalThis.__fixtureTunnelPort);
    await setup.getByRole('button', { name: 'Disconnect SSH tunnel', exact: true }).click();
    await restored.locator('[aria-label="Execution target"]').getByText('SSH tunnel disconnected · reconnect through server settings', { exact: true }).waitFor();
    await waitFor(async () => !(await isListening(closedPort)), 'Explicit native disconnect left its owned forward listening.');
    assert((await restored.evaluate(() => window.desktopShell.getCurrentTarget())).sshAuthentication.applicationConnected === false, 'Disconnect kept authenticated application connectivity in metadata.');
    const reconnecting = application.waitForEvent('window'); await setup.getByRole('button', { name: 'Connect HTTPS service', exact: true }).click(); const reconnected = await reconnecting;
    await reconnected.locator('[aria-label="Execution target"]').getByText('SSH tunnel connected', { exact: true }).waitFor({ timeout: 30000 });
    assert(await reconnected.evaluate(() => localStorage.getItem('tunnel-selected-project')) === 'original-project-selection', 'Native reconnect lost the original service selection.');
    checks.push('explicit native disconnect removes only the owned forward and an explicit reconnect restores the same isolated authenticated workspace');
    await command('docker', ['stop', names[1]]); started.delete(names[1]);
    await reconnected.locator('[aria-label="Execution target"]').getByText('SSH tunnel disconnected · reconnect through server settings', { exact: true }).waitFor({ timeout: 20000 });
    assert((await reconnected.evaluate(() => window.desktopShell.getCurrentTarget())).status === 'disconnected', 'Native transport loss still claimed application connectivity.');
    assert(await reconnected.evaluate(async () => { try { await fetch('/api/auth/session'); return false; } catch { return true; } }), 'Transport loss silently used a direct or local service.');
    await reconnected.screenshot({ path: path.join(output, 'native-tunnel-loss-workspace.png') });
    checks.push('actual SSH daemon loss updates the existing React workspace, disables remote requests and never falls back to another service');
    await application.close(); application = null;
    await waitFor(async () => !fs.readdirSync(userData).some(name => name.startsWith('.ssh-route-') || name.startsWith('.ssh-policy-')), 'Closing desktop left an owned native policy behind.');
    assert(digest(nativeConfigFile) === nativeHash && digest(nativeKnownHosts) === trustHash && digest(includedFile) === includeHash, 'Tunneling modified user-owned native SSH policy.');
    for (let index = 0; index < originalFiles.length; index++) assert(digest(originalFiles[index]) === originalHashes[index], 'Acceptance modified the real user SSH configuration or trust.');
    checks.push('window shutdown cleans owned route snapshots and tunnel descendants while user SSH policy, trust, keys and agents remain untouched');
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ ok: true, checks, endpoint: service.endpoint }, null, 2) + '\n');
    return { ok: true, checks: checks.length, artifactDirectory: output };
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
