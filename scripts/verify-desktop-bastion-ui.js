#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { _electron: electron } = require('playwright');
const { systemExecutable, scannedHostKeys } = require('../desktop/sshConnection.cjs');

const root = path.resolve(__dirname, '..');
function assert(value, message) { if (!value) throw new Error(message); }
function command(program, args, { timeout = 120000, includeStderr = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', size = 0;
    child.stdout.on('data', value => { size += value.length; if (size > 2 * 1024 * 1024) child.kill(); else stdout += value; });
    child.stderr.on('data', value => { size += value.length; if (size > 2 * 1024 * 1024) child.kill(); else stderr += value; });
    const timer = setTimeout(() => child.kill(), timeout);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); if (code === 0) resolve((stdout + (includeStderr ? stderr : '')).trim()); else reject(new Error(program + ' failed: ' + stderr.trim())); });
  });
}
async function unusedPort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve)); return port;
}
function digest(filename) { return fs.existsSync(filename) ? createHash('sha256').update(fs.readFileSync(filename)).digest('hex') : null; }
function nativeConfigValue(value) { return '"' + value.replace(/\\/g, '/').replace(/"/g, '\\"') + '"'; }
async function runDesktopBastionAcceptance({ artifactDirectory } = {}) {
  const output = path.resolve(artifactDirectory || path.join(root, 'playwright', 'report',
    'desktop-bastion-' + new Date().toISOString().replace(/[:.]/g, '-')));
  assert(output.startsWith(path.join(root, 'playwright', 'report') + path.sep), 'Fixture files must remain in ignored report storage.');
  const stamp = Date.now().toString(36), prefix = 'traceomics-bastion-' + stamp;
  const network = prefix + '-network', image = prefix + ':fixture';
  const names = ['outer', 'inner', 'compute', 'stalled'].map(role => prefix + '-' + role);
  const aliases = ['gate_one', 'gate_two', 'lab_compute'];
  const accounts = ['gatekeeper', 'inner_user', 'researcher'];
  const pins = ['fixture-outer-pin', 'fixture-inner-pin', 'fixture-compute-pin'];
  // Native Include enforces Windows ownership checks. Keep the injected config
  // outside checkout ACLs in an owned disposable OS temp directory.
  const nativeTempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'traceomics-bastion-'));
  const userData = path.join(output, 'Native desktop state'), nativeConfigFile = path.join(nativeTempDirectory, 'Native user config');
  const nativeKnownHosts = path.join(output, 'Native known hosts');
  const identities = accounts.map(account => path.join(output, account + ' private identity'));
  const authorizedFiles = accounts.map(account => path.join(output, account + '_authorized_keys'));
  const userOwnedFiles = ['config', 'known_hosts', 'known_hosts2'].map(name => path.join(os.homedir(), '.ssh', name));
  const userOwnedBefore = userOwnedFiles.map(digest);
  const checks = [], started = new Set();
  const port = await unusedPort();
  let application, networkCreated = false;
  let keys = [];
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(output, 'Dockerfile'), [
    'FROM alpine:3.21',
    'RUN apk add --no-cache openssh-server && for account in gatekeeper inner_user researcher; do adduser -D "$account"; echo "$account:disabled-password-fixture" | chpasswd; done',
    'COPY sshd_config /fixture/sshd_config',
    'CMD ["/bin/sh", "-ec", "mkdir -p /home/$FIXTURE_USER/.ssh /run/sshd; cp /fixture/authorized_key /home/$FIXTURE_USER/.ssh/authorized_keys; chown -R $FIXTURE_USER:$FIXTURE_USER /home/$FIXTURE_USER/.ssh; chmod 700 /home/$FIXTURE_USER/.ssh; chmod 600 /home/$FIXTURE_USER/.ssh/authorized_keys; ssh-keygen -A; exec /usr/sbin/sshd -D -e -f /fixture/sshd_config"]',
  ].join('\n') + '\n');
  fs.writeFileSync(path.join(output, '.dockerignore'), '*\n!Dockerfile\n!sshd_config\n');
  fs.writeFileSync(path.join(output, 'sshd_config'), [
    'Port 2222', 'ListenAddress 0.0.0.0', 'HostKey /etc/ssh/ssh_host_ed25519_key',
    'PubkeyAuthentication yes', 'PasswordAuthentication no', 'KbdInteractiveAuthentication no',
    'PermitRootLogin no', 'AllowUsers gatekeeper inner_user researcher', 'AllowTcpForwarding yes',
    'PermitTTY no', 'AllowAgentForwarding no', 'X11Forwarding no', 'LogLevel DEBUG3', 'PerSourcePenalties no',
  ].join('\n') + '\n');
  async function start(index) {
    await command('docker', ['run', '-d', '--rm', '--name', names[index], '--network', network,
      ...(index === 0 ? ['-p', `127.0.0.1:${port}:2222`] : []), '-e', 'FIXTURE_USER=' + accounts[index],
      '--mount', `type=bind,source=${authorizedFiles[index]},target=/fixture/authorized_key,readonly`, image]);
    started.add(names[index]);
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        const key = await command('docker', ['exec', names[index], 'cat', '/etc/ssh/ssh_host_ed25519_key.pub']);
        const result = scannedHostKeys('fixture ' + key.split(/\s+/).slice(0, 2).join(' '));
        if (result.length) return result[0];
      } catch { /* Daemon boot is asynchronous. */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('A disposable SSH daemon did not become ready.');
  }
  async function stop(index) {
    if (started.has(names[index])) { await command('docker', ['rm', '-f', names[index]]); started.delete(names[index]); }
  }
  async function startStalled() {
    await command('docker', ['run', '-d', '--rm', '--name', names[3], '--network', network, image,
      '/bin/sh', '-ec', 'while true; do nc -l -p 2222 -e /bin/sleep 300; done']);
    started.add(names[3]);
  }
  function writeKnownHosts(includeOuter = true) {
    fs.writeFileSync(nativeKnownHosts, keys.slice(0, 2).map((key, index) => index === 0 && !includeOuter ? ''
      : `${pins[index]} ${key.algorithm} ${key.publicKey}\n`).join(''));
  }
  function writeConfiguration({ outerPort = port, innerUser = accounts[1], innerPort = 2222, innerHost = names[1] } = {}) {
    const lines = ['# Disposable user-owned OpenSSH configuration.', 'Host *',
      '  StrictHostKeyChecking no', '  ForwardAgent yes', // Managed policy must override both on every hop.
      '  IdentityAgent none', '  IdentitiesOnly yes', '  GlobalKnownHostsFile none',
      '  UserKnownHostsFile ' + nativeConfigValue(nativeKnownHosts)];
    for (let index = 0; index < aliases.length; index++) {
      lines.push('Host ' + aliases[index],
        '  HostName ' + (index === 0 ? '127.0.0.1' : index === 1 ? innerHost : names[index]),
        '  Port ' + (index === 0 ? outerPort : index === 1 ? innerPort : 2222),
        '  User ' + (index === 1 ? innerUser : accounts[index]),
        '  IdentityFile ' + nativeConfigValue(identities[index]), '  HostKeyAlias ' + pins[index]);
      if (index === 2) lines.push('  ProxyJump gate_one,gate_two:2222');
    }
    const contents = lines.join('\n') + '\n';
    fs.writeFileSync(nativeConfigFile, contents, { mode: 0o600 });
    fs.writeFileSync(path.join(output, 'Native user config snapshot'), contents);
  }
  async function waitError(page, expression) {
    await page.getByRole('alert').filter({ hasText: expression }).waitFor({ timeout: 30000 });
    assert(await page.locator('#ssh-host-verification').isHidden(), 'A failing jump stage offered destination trust.');
    assert((await page.evaluate(() => window.desktopShell.getCurrentTarget())).sshAuthentication?.state === 'unverified',
      'Failed route verification retained an authenticated status.');
    assert(!fs.readdirSync(userData).some(name => name.startsWith('.ssh-route-') || name.includes('.discovery-')),
      'Route verification left a transient policy or discovery file behind.');
  }
  async function verify(page) { await page.getByRole('button', { name: 'Verify SSH access', exact: true }).click(); }
  try {
    for (let index = 0; index < identities.length; index++) {
      await command(systemExecutable('ssh-keygen'), ['-t', 'ed25519', '-N', '', '-C', '', '-f', identities[index]]);
      fs.copyFileSync(identities[index] + '.pub', authorizedFiles[index]);
    }
    await command('docker', ['build', '-t', image, output], { timeout: 180000 });
    await command('docker', ['network', 'create', network]); networkCreated = true;
    for (let index = 0; index < 3; index++) keys.push(await start(index));
    await startStalled();
    fs.writeFileSync(path.join(output, 'native-openssh-version.txt'), await command(systemExecutable('ssh'), ['-V'], { includeStderr: true }) + '\n');
    writeKnownHosts(false); writeConfiguration();
    if (process.platform === 'win32') {
      // Included Windows OpenSSH configs enforce owner/ACL checks, unlike
      // an explicit -F file. Give only this disposable config private native
      // permissions without changing the user's SSH files or policy.
      const aclHelper = path.join(output, 'fixture-config-permissions.ps1');
      fs.writeFileSync(aclHelper, [
        'param([string]$TargetConfig)',
        "$ErrorActionPreference = 'Stop'",
        '$fixtureOwner = [System.Security.Principal.WindowsIdentity]::GetCurrent().User',
        '$fixtureAcl = [System.Security.AccessControl.FileSecurity]::new()',
        '$fixtureAcl.SetOwner($fixtureOwner)', '$fixtureAcl.SetAccessRuleProtection($true, $false)',
        "foreach ($fixtureSid in @($fixtureOwner.Value, 'S-1-5-18', 'S-1-5-32-544')) {",
        "  $fixtureAcl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]::new($fixtureSid), 'FullControl', 'Allow'))",
        '}', '[System.IO.File]::SetAccessControl($TargetConfig, $fixtureAcl)',
      ].join('\n') + '\n');
      try {
        await command('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', aclHelper,
          '-TargetConfig', nativeConfigFile]);
      } finally { fs.rmSync(aclHelper, { force: true }); }
    }
    const profile = { id: 'bastion-fixture', name: 'Research compute through bastions', kind: 'ssh',
      ssh: { host: aliases[2], remoteHost: '127.0.0.1', remotePort: 3000 } };
    fs.writeFileSync(path.join(userData, 'desktop-settings.json'), JSON.stringify({ schemaVersion: 1, selectedProfileId: profile.id, profiles: [profile] }));
    const launcher = path.join(output, 'native-fixture-launch.cjs');
    // This test-only entry point injects a private manager dependency. The
    // production browser and environment gain no config-file input capability.
    fs.writeFileSync(launcher, [
      "const fs = require('node:fs');",
      'const connection = require(' + JSON.stringify(path.join(root, 'desktop', 'sshConnection.cjs')) + ');',
      'const createManager = connection.createSshConnectionManager;',
      'connection.createSshConnectionManager = options => {',
      '  const runner = connection.createNativeSshRunner(); let sequence = 0;',
      '  const manager = createManager({ ...options, nativeConfigFile: ' + JSON.stringify(nativeConfigFile) + ', run: async (...args) => {',
      '    const result = await runner.run(...args);',
      '    fs.writeFileSync(' + JSON.stringify(path.join(output, 'native-')) + ' + (++sequence) + ".txt", result.stderr || "");',
      '    return result;',
      '  } });',
      '  const dispose = manager.dispose.bind(manager); manager.dispose = () => { dispose(); runner.dispose(); }; return manager;',
      '};',
      'require(' + JSON.stringify(path.join(root, 'desktop', 'main.cjs')) + ');',
    ].join('\n') + '\n');
    application = await electron.launch({ args: [launcher, `--user-data-dir=${userData}`],
      env: { ...process.env, TRACEOMICS_DESKTOP_URL: '' }, timeout: 60000 });
    const page = await application.firstWindow();
    await page.getByRole('heading', { name: 'Choose your research server', exact: true }).waitFor();
    assert(await page.locator('#ssh-host').inputValue() === aliases[2], 'The native alias did not restore.');
    assert(await page.locator('#ssh-port').inputValue() === '' && await page.locator('#ssh-user').inputValue() === '',
      'The profile overrode native alias account or port selection.');
    checks.push('native alias restores with optional account/port left to user-owned OpenSSH configuration');
    const untrustedHash = digest(nativeKnownHosts);
    await verify(page); await waitError(page, /Jump host 1 \(gate_one\).*host identity needs verification/i);
    assert(digest(nativeKnownHosts) === untrustedHash, 'The app silently changed native host trust.');
    await page.screenshot({ path: path.join(output, 'unknown-jump-native-verification.png'), fullPage: true });
    checks.push('strict checking overrides permissive native policy on the first jump without destination trust or native file edits');
    writeKnownHosts();
    const originalNativeHash = digest(nativeKnownHosts);
    await verify(page); await page.locator('#ssh-host-verification').waitFor({ state: 'visible', timeout: 30000 });
    assert(await page.locator('#ssh-fingerprints').textContent() === keys[2].algorithm + keys[2].fingerprint,
      'Destination discovery through two bastions differs from the real host key.');
    const beforeTrustLogs = await command('docker', ['logs', names[2]], { includeStderr: true });
    assert(!/Accepted publickey for researcher/.test(beforeTrustLogs), 'Destination credentials were offered before host verification.');
    assert(!fs.existsSync(path.join(userData, 'ssh_known_hosts')), 'Discovery silently trusted the destination.');
    assert(await page.getByRole('button', { name: 'Trust this fingerprint and verify SSH', exact: true }).isDisabled(),
      'The destination fingerprint needs no acknowledgment.');
    await page.screenshot({ path: path.join(output, 'destination-fingerprint-through-bastions.png'), fullPage: true });
    checks.push('two verified jumps permit authentication-free discovery of an unreachable-from-laptop destination');
    writeConfiguration({ innerUser: 'changed_user' });
    await page.locator('#ssh-host-verified').check();
    await page.getByRole('button', { name: 'Trust this fingerprint and verify SSH', exact: true }).click();
    await waitError(page, /SSH configuration changed during host verification/i);
    assert(!fs.existsSync(path.join(userData, 'ssh_known_hosts')), 'Changing a jump policy still wrote destination trust.');
    checks.push('destination trust confirmation binds every intermediate host’s native configuration');
    writeConfiguration();
    await verify(page); await page.locator('#ssh-host-verification').waitFor({ state: 'visible', timeout: 30000 });
    await page.locator('#ssh-host-verified').check();
    await page.getByRole('button', { name: 'Trust this fingerprint and verify SSH', exact: true }).click();
    await page.getByText(/SSH authentication verified for researcher@/).waitFor({ timeout: 30000 });
    const current = await page.evaluate(() => window.desktopShell.getCurrentTarget());
    assert(current.sshAuthentication?.state === 'authenticated' && current.status === 'configuration_only'
      && current.sshAuthentication.applicationConnected === false && current.endpoint === null,
    'A verified route was incorrectly presented as a connected project service.');
    assert(JSON.stringify(current.sshAuthentication.stages.map(stage => ({ alias: stage.alias, username: stage.username, port: stage.port })))
      === JSON.stringify(aliases.map((alias, index) => ({ alias, username: accounts[index], port: index === 0 ? port : 2222 }))),
    'Native route metadata did not preserve the account and custom port at each host.');
    assert(!identities.some(identity => JSON.stringify(current).includes(identity)), 'Route metadata exposed native identity paths.');
    const clientFingerprints = await Promise.all(identities.map(async identity => scannedHostKeys('fixture ' + fs.readFileSync(identity + '.pub', 'utf8').split(/\s+/).slice(0, 2).join(' '))[0].fingerprint));
    assert(new Set(clientFingerprints).size === 3, 'The fixture did not create distinct client identities.');
    for (let index = 0; index < 3; index++) {
      const logs = await command('docker', ['logs', names[index]], { includeStderr: true });
      assert(logs.includes('Accepted publickey for ' + accounts[index]) && logs.includes(clientFingerprints[index]),
        'A host did not authenticate its own native client identity.');
      fs.writeFileSync(path.join(output, ['outer', 'inner', 'compute'][index] + '-authenticated.txt'), logs + '\n');
    }
    assert(digest(nativeKnownHosts) === originalNativeHash, 'Destination trust modified native known-host files.');
    await page.screenshot({ path: path.join(output, 'verified-native-bastion-chain.png'), fullPage: true });
    checks.push('actual two-bastion chain authenticates three distinct native identities and preserves each alias/account/custom port');
    await verify(page); await page.getByText(/SSH authentication verified for researcher@/).waitFor({ timeout: 30000 });
    assert(await page.locator('#ssh-host-verification').isHidden(), 'A verified bastion route asks for first-use trust again.');
    checks.push('verified route reconnects without recomputation of host trust or opening a project service');
    writeConfiguration({ innerUser: 'missing_user' });
    await verify(page); await waitError(page, /Jump host 2 \(gate_two\).*rejected SSH authentication/i);
    await page.screenshot({ path: path.join(output, 'inner-bastion-authentication-rejected.png'), fullPage: true });
    checks.push('actual second-stage authentication failure identifies the correct alias and gives native identity/account remediation');
    writeConfiguration({ outerPort: await unusedPort() });
    await verify(page); await waitError(page, /Jump host 1 \(gate_one\).*could not be reached/i);
    checks.push('actual first-stage custom-port failure names the unreachable jump and network remediation');
    writeConfiguration({ innerHost: names[3] });
    await verify(page);
    let established = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const sockets = await command('docker', ['exec', names[3], 'cat', '/proc/net/tcp', '/proc/net/tcp6']);
      if (/\S+:08AE\s+\S+\s+01\s/i.test(sockets)) { established = true; break; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert(established, 'The native proxy subprocess did not reach the actual stalled middle host.');
    await page.getByRole('button', { name: 'Cancel SSH check', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: /SSH verification was canceled/i }).waitFor();
    let closed = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      const sockets = await command('docker', ['exec', names[3], 'cat', '/proc/net/tcp', '/proc/net/tcp6']);
      if (!/\S+:08AE\s+\S+\s+01\s/i.test(sockets)) { closed = true; break; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert(closed && await page.locator('#ssh-host').isEnabled(), 'Canceling the native route left a proxy connection running or controls locked.');
    assert(!fs.readdirSync(userData).some(name => name.startsWith('.ssh-route-')), 'Cancellation left a generated policy behind.');
    checks.push('canceling a stalled middle-host connection terminates the actual native proxy subprocess tree and cleans transient policy');
    writeConfiguration();
    await stop(1); keys[1] = await start(1);
    const beforeChangedJumpHash = digest(nativeKnownHosts), beforeChangedDestinationHash = digest(path.join(userData, 'ssh_known_hosts'));
    await verify(page); await waitError(page, /Jump host 2 \(gate_two\).*host key has changed/i);
    assert(digest(nativeKnownHosts) === beforeChangedJumpHash && digest(path.join(userData, 'ssh_known_hosts')) === beforeChangedDestinationHash,
      'A changed jump key rewrote trust or destination identity.');
    await page.screenshot({ path: path.join(output, 'changed-inner-host-key-rejected.png'), fullPage: true });
    checks.push('actual middle-host key rotation fails closed at the correct hop and preserves both trust stores');
    writeKnownHosts();
    await verify(page); await page.getByText(/SSH authentication verified for researcher@/).waitFor({ timeout: 30000 });
    await stop(2); keys[2] = await start(2);
    const beforeChangedTargetHash = digest(path.join(userData, 'ssh_known_hosts'));
    await verify(page); await waitError(page, /Destination \(lab_compute\).*host key has changed/i);
    assert(digest(path.join(userData, 'ssh_known_hosts')) === beforeChangedTargetHash, 'A rotated destination key was silently retrusted.');
    await page.screenshot({ path: path.join(output, 'changed-destination-key-rejected.png'), fullPage: true });
    checks.push('actual destination key rotation through the verified chain fails closed without another first-use trust prompt');
    await stop(3); await startStalled();
    writeConfiguration({ innerHost: names[3] });
    await verify(page);
    let closingConnection = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      const sockets = await command('docker', ['exec', names[3], 'cat', '/proc/net/tcp', '/proc/net/tcp6']);
      if (/\S+:08AE\s+\S+\s+01\s/i.test(sockets)) { closingConnection = true; break; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert(closingConnection, 'The settings-close case did not start a real native proxy connection.');
    await page.close();
    let shutdownClosed = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      const sockets = await command('docker', ['exec', names[3], 'cat', '/proc/net/tcp', '/proc/net/tcp6']);
      if (!/\S+:08AE\s+\S+\s+01\s/i.test(sockets)) { shutdownClosed = true; break; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert(shutdownClosed && !fs.readdirSync(userData).some(name => name.startsWith('.ssh-route-')),
      'Closing settings left a native proxy connection or transient route policy behind.');
    checks.push('closing settings during a real bastion connection cleans the native subprocess tree and policy before desktop exit');
    assert(userOwnedFiles.every((filename, index) => digest(filename) === userOwnedBefore[index]), 'Acceptance changed actual user-owned SSH files.');
    assert(!JSON.stringify(JSON.parse(fs.readFileSync(path.join(userData, 'desktop-settings.json'), 'utf8'))).includes('PRIVATE KEY'),
      'Persisted profile settings contain private key material.');
    fs.writeFileSync(path.join(output, 'acceptance.json'), JSON.stringify({ checks, aliases, customPort: port,
      userOwnedSshFilesUnchanged: true, projectServiceConnected: false }, null, 2) + '\n');
    return { artifactDirectory: output, checks };
  } catch (error) {
    if (application) {
      const page = await application.firstWindow().catch(() => null);
      if (page) {
        await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
        fs.writeFileSync(path.join(output, 'failure-ui.txt'), await page.locator('body').innerText().catch(() => '') + '\n');
      }
    }
    throw error;
  } finally {
    if (application) await application.close().catch(() => {});
    for (const name of [...started]) {
      const logs = await command('docker', ['logs', name], { includeStderr: true }).catch(error => error.message);
      fs.writeFileSync(path.join(output, 'final-' + name.split('-').at(-1) + '.txt'), logs + '\n');
      await command('docker', ['rm', '-f', name]).catch(() => {});
    }
    if (networkCreated) await command('docker', ['network', 'rm', network]).catch(() => {});
    await command('docker', ['image', 'rm', image]).catch(() => {});
    for (const identity of identities) fs.rmSync(identity, { force: true });
    fs.rmSync(path.join(output, 'native-fixture-launch.cjs'), { force: true });
    assert(path.dirname(path.resolve(nativeTempDirectory)) === path.resolve(os.tmpdir())
      && path.basename(nativeTempDirectory).startsWith('traceomics-bastion-'), 'Unsafe native fixture cleanup.');
    fs.rmSync(nativeTempDirectory, { recursive: true, force: true });
  }
}
module.exports = { runDesktopBastionAcceptance };
if (require.main === module) runDesktopBastionAcceptance().then(result => {
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}).catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
