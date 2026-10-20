#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { _electron: electron } = require('playwright');
const { systemExecutable, scannedHostKeys } = require('../desktop/sshConnection.cjs');

const root = path.resolve(__dirname, '..');
function assert(value, message) { if (!value) throw new Error(message); }
function command(program, args, { timeout = 120000, includeStderr = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', value => { stdout += value; });
    child.stderr.on('data', value => { stderr += value; });
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
async function runDesktopSshAcceptance({ artifactDirectory } = {}) {
  const output = path.resolve(artifactDirectory || path.join(root, 'playwright', 'report',
    'desktop-ssh-' + new Date().toISOString().replace(/[:.]/g, '-')));
  assert(output.startsWith(path.join(root, 'playwright', 'report') + path.sep), 'SSH fixture files must remain in ignored report storage.');
  const stamp = Date.now().toString(36), container = 'traceomics-ssh-acceptance-' + stamp;
  const image = 'traceomics-ssh-acceptance:' + stamp;
  const userData = path.join(output, 'user-data'), key = path.join(output, 'researcher_identity');
  const encryptedKey = path.join(output, 'encrypted_identity'), authorizedKeys = path.join(output, 'authorized_keys');
  fs.mkdirSync(userData, { recursive: true });
  const dockerfile = [
    'FROM alpine:3.21',
    'RUN apk add --no-cache openssh-server && adduser -D researcher && echo researcher:disabled-password-fixture | chpasswd',
    'COPY sshd_config /fixture/sshd_config',
    'CMD ["/bin/sh", "-ec", "mkdir -p /home/researcher/.ssh /run/sshd; cp /fixture/authorized_key /home/researcher/.ssh/authorized_keys; chown -R researcher:researcher /home/researcher/.ssh; chmod 700 /home/researcher/.ssh; chmod 600 /home/researcher/.ssh/authorized_keys; ssh-keygen -A; exec /usr/sbin/sshd -D -e -f /fixture/sshd_config"]',
  ].join('\n') + '\n';
  fs.writeFileSync(path.join(output, 'Dockerfile'), dockerfile);
  fs.writeFileSync(path.join(output, '.dockerignore'), '*\n!Dockerfile\n!sshd_config\n');
  fs.writeFileSync(path.join(output, 'sshd_config'), [
    'Port 2222', 'ListenAddress 0.0.0.0', 'HostKey /etc/ssh/ssh_host_ed25519_key',
    'PubkeyAuthentication yes', 'PasswordAuthentication no', 'KbdInteractiveAuthentication no',
    'PermitRootLogin no', 'AllowUsers researcher', 'AllowTcpForwarding no', 'PermitTTY no',
    'AllowAgentForwarding no', 'X11Forwarding no', 'LogLevel DEBUG3', 'PerSourcePenalties no',
  ].join('\n') + '\n');
  const port = await unusedPort(), checks = [];
  let application, started = false;
  async function start() {
    await command('docker', ['run', '-d', '--rm', '--name', container,
      '-p', `127.0.0.1:${port}:2222`, '--mount', `type=bind,source=${authorizedKeys},target=/fixture/authorized_key,readonly`, image]);
    started = true;
    let discoveryError = '';
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        const publicKey = await command('docker', ['exec', container, 'cat', '/etc/ssh/ssh_host_ed25519_key.pub']);
        const keys = scannedHostKeys('fixture ' + publicKey.split(/\s+/).slice(0, 2).join(' '));
        if (keys.length) return keys[0];
      } catch (error) { discoveryError = error.message; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const logs = await command('docker', ['logs', container], { includeStderr: true }).catch(error => error.message);
    fs.writeFileSync(path.join(output, 'sshd-startup.txt'), logs + '\n' + discoveryError);
    throw new Error('The disposable SSH daemon did not become ready: ' + discoveryError);
  }
  async function stop() { if (started) { await command('docker', ['rm', '-f', container]); started = false; } }
  try {
    await command(systemExecutable('ssh-keygen'), ['-t', 'ed25519', '-N', '', '-C', '', '-f', key]);
    await command(systemExecutable('ssh-keygen'), ['-t', 'ed25519', '-N', 'ephemeral-fixture-passphrase', '-C', '', '-f', encryptedKey]);
    fs.writeFileSync(authorizedKeys, fs.readFileSync(key + '.pub', 'utf8') + fs.readFileSync(encryptedKey + '.pub', 'utf8'));
    await command('docker', ['build', '-t', image, output], { timeout: 180000 });
    const expectedKey = await start();
    const nativeOpenSshVersion = await command(systemExecutable('ssh'), ['-V'], { includeStderr: true });
    const keyscanDiagnostic = await command(systemExecutable('ssh-keyscan'), ['-T', '2', '-p', String(port), '-t', 'ed25519', '127.0.0.1']).catch(error => error.message);
    fs.writeFileSync(path.join(output, 'native-keyscan-compatibility.txt'), nativeOpenSshVersion + '\n' + keyscanDiagnostic + '\n');
    const profile = { id: 'disposable-ssh', name: 'Disposable research SSH', kind: 'ssh',
      ssh: { host: '127.0.0.1', username: 'researcher', port, remoteHost: '127.0.0.1', remotePort: 3000, identityFile: key } };
    const encryptedProfile = { ...profile, id: 'encrypted-ssh', name: 'Encrypted native identity', ssh: { ...profile.ssh, identityFile: encryptedKey } };
    const settingsFile = path.join(userData, 'desktop-settings.json');
    fs.writeFileSync(settingsFile, JSON.stringify({ schemaVersion: 1, selectedProfileId: profile.id, profiles: [profile, encryptedProfile] }));
    const videoDirectory = path.join(output, 'video');
    fs.mkdirSync(videoDirectory, { recursive: true });
    application = await electron.launch({ args: [root, `--user-data-dir=${userData}`],
      env: { ...process.env, TRACEOMICS_DESKTOP_URL: '' }, artifactsDir: output,
      recordVideo: { dir: videoDirectory, size: { width: 1000, height: 1400 },
        showActions: { duration: 700, position: 'bottom-right', fontSize: 16 } }, timeout: 60000 });
    const page = await application.firstWindow();
    await page.getByRole('heading', { name: 'Choose your research server', exact: true }).waitFor();
    await page.locator('#saved-target').selectOption('');
    await page.getByLabel('Target name', { exact: true }).fill('Walkthrough draft');
    await page.getByLabel('Connection type', { exact: true }).selectOption('ssh');
    assert(await page.locator('#ssh-host').evaluate(element => element.validity.valueMissing),
      'Blank SSH host validation did not identify the required host field.');
    await page.getByRole('button', { name: 'Verify SSH access', exact: true }).click();
    assert(await page.locator('#ssh-host').evaluate(element => element.matches(':invalid')),
      'Blank SSH verification advanced without a required host.');
    await page.screenshot({ path: path.join(output, 'blank-ssh-validation.png'), fullPage: true });
    await page.locator('#ssh-host').fill('compute.example.org');
    await page.locator('#ssh-advanced summary').click();
    await page.locator('#remote-host').fill('');
    await page.locator('#ssh-advanced summary').click();
    await page.getByRole('button', { name: 'Verify SSH access', exact: true }).click();
    assert(await page.locator('#ssh-advanced').evaluate(element => element.open),
      'Invalid advanced SSH fields remained hidden after form validation.');
    await page.locator('#remote-host').fill('127.0.0.1');
    await page.locator('#ssh-advanced').evaluate(element => { element.open = false; });
    for (const kind of ['https', 'local', 'ssh']) {
      await page.getByLabel('Connection type', { exact: true }).selectOption(kind);
      assert((await page.locator('#ssh-fields').isVisible()) === (kind === 'ssh'),
        'Changing connection type did not reveal only the matching SSH settings.');
      assert((await page.locator('#server-url').evaluate(element => element.required)) === (kind !== 'ssh'),
        'Changing connection type left the wrong server-address requirement.');
    }
    const advancedSummary = page.locator('#ssh-advanced summary');
    await page.locator('#target-kind').focus();
    for (let index = 0; index < 12 && !(await advancedSummary.evaluate(element => document.activeElement === element)); index++) {
      await page.keyboard.press('Tab');
    }
    assert(await advancedSummary.evaluate(element => document.activeElement === element),
      'The advanced-options disclosure is missing from keyboard navigation.');
    assert(await advancedSummary.evaluate(element => getComputedStyle(element).outlineStyle === 'solid'),
      'The advanced-options disclosure has no visible keyboard focus state.');
    await advancedSummary.press('Enter');
    assert(await page.locator('#ssh-advanced').evaluate(element => element.open),
      'The advanced-options disclosure cannot be opened from the keyboard.');
    await advancedSummary.press('Enter');
    assert(await page.locator('#ssh-advanced').evaluate(element => !element.open),
      'The advanced-options disclosure cannot be closed from the keyboard.');
    const verifyButton = page.getByRole('button', { name: 'Verify SSH access', exact: true });
    const defaultButtonColor = await verifyButton.evaluate(element => getComputedStyle(element).backgroundColor);
    await verifyButton.hover();
    assert(await verifyButton.evaluate(element => getComputedStyle(element).backgroundColor) !== defaultButtonColor,
      'The primary SSH action has no visible hover state.');
    checks.push('blank required-field validation and repeated HTTPS/local/SSH type switching preserve a coherent form');
    await page.setViewportSize({ width: 390, height: 844 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      'The connection form overflows at a narrow viewport.');
    await page.screenshot({ path: path.join(output, 'narrow-ssh-form.png'), fullPage: true });
    await page.setViewportSize({ width: 900, height: 700 });
    await page.locator('#saved-target').selectOption(encryptedProfile.id);
    assert(await page.locator('#ssh-identity').inputValue() === encryptedKey,
      'Switching profiles did not load the selected native identity reference.');
    await page.locator('#saved-target').selectOption(profile.id);
    assert(await page.locator('#ssh-identity').inputValue() === key, 'The native identity reference did not restore.');
    assert((await page.evaluate(() => window.desktopShell.getCurrentTarget())).status === 'configuration_only',
      'A saved SSH profile was mislabeled application-connected.');
    checks.push('saved native key reference restores without application connection or key material');
    await page.getByRole('button', { name: 'Verify SSH access', exact: true }).click();
    await page.locator('#ssh-host-verification').waitFor({ state: 'visible' });
    assert(await page.locator('#ssh-fingerprints').textContent() === expectedKey.algorithm + expectedKey.fingerprint,
      'The first-use fingerprint differs from the real daemon host key.');
    assert(await page.getByRole('button', { name: 'Trust this fingerprint and verify SSH', exact: true }).isDisabled(),
      'An unverified fingerprint can be trusted without acknowledgment.');
    assert(await page.locator('#ssh-host').isDisabled(), 'Connection fields remain editable during a pending host decision.');
    assert(!fs.existsSync(path.join(userData, 'ssh_known_hosts')), 'Discovery silently trusted a host.');
    assert(!fs.readdirSync(userData).some(name => name.includes('.discovery-')), 'Public key discovery left a quarantine file behind.');
    await page.screenshot({ path: path.join(output, 'first-use-host-verification.png'), fullPage: true });
    checks.push('first-use host key matches actual sshd and requires independent verification');
    await page.locator('#ssh-host-verified').check();
    await page.getByRole('button', { name: 'Trust this fingerprint and verify SSH', exact: true }).click();
    await page.getByText(/SSH authentication verified for researcher@127\.0\.0\.1/).waitFor();
    const current = await page.evaluate(() => window.desktopShell.getCurrentTarget());
    assert(current.sshAuthentication?.state === 'authenticated' && current.status === 'configuration_only'
      && current.sshAuthentication.applicationConnected === false && current.endpoint === null,
    'Authentication did not remain separate from the project service connection.');
    assert(!JSON.stringify(current).includes(key), 'Public target metadata disclosed the native identity reference.');
    assert(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length) === 1,
      'SSH authentication opened an application-service window.');
    assert(fs.readFileSync(path.join(userData, 'ssh_known_hosts'), 'utf8').includes(expectedKey.publicKey), 'The verified public host key was not saved.');
    assert(!fs.readFileSync(settingsFile, 'utf8').includes('PRIVATE KEY'), 'Native profile settings contain key material.');
    await page.screenshot({ path: path.join(output, 'ssh-authentication-verified.png'), fullPage: true });
    checks.push('real OpenSSH key authentication succeeds with strict host checking and no tunnel');
    await page.getByRole('button', { name: 'Verify SSH access', exact: true }).click();
    await page.getByText(/SSH authentication verified for researcher@127\.0\.0\.1/).waitFor();
    assert(await page.locator('#ssh-host-verification').isHidden(), 'A trusted host asks for first-use trust again.');
    checks.push('reconnection uses the explicitly trusted public host key');
    await page.locator('#ssh-user').fill('missinguser');
    await page.getByRole('button', { name: 'Save profile', exact: true }).click();
    await page.getByText(/SSH configuration saved\. Verify SSH access/).waitFor();
    assert((await page.evaluate(() => window.desktopShell.getTargetProfiles())).sshStatuses[profile.id].state === 'unverified',
      'An edited SSH identity retained a previous authentication status.');
    await page.getByRole('button', { name: 'Verify SSH access', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: /server rejected SSH authentication/i }).waitFor();
    await page.screenshot({ path: path.join(output, 'ssh-authentication-rejected.png'), fullPage: true });
    checks.push('profile edits revoke prior verification and a wrong account fails authentication');
    await page.locator('#ssh-user').fill('researcher');
    await page.getByRole('button', { name: 'Verify SSH access', exact: true }).click();
    await page.getByText(/SSH authentication verified for researcher@127\.0\.0\.1/).waitFor();
    await page.locator('#saved-target').selectOption(encryptedProfile.id);
    await page.getByRole('button', { name: 'Verify SSH access', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: /selected identity is encrypted/i }).waitFor();
    assert(await page.getByRole('button', { name: 'Unlock with OpenSSH', exact: true }).isEnabled(), 'Encrypted identities do not offer the native unlock flow.');
    assert(await page.locator('input[type="password"]').count() === 0, 'Native SSH passphrases can enter a renderer form.');
    assert(!fs.readFileSync(settingsFile, 'utf8').includes('ephemeral-fixture-passphrase'), 'An encrypted-key passphrase entered persisted settings.');
    await page.screenshot({ path: path.join(output, 'encrypted-identity-native-flow.png'), fullPage: true });
    checks.push('real encrypted identity fails with native-unlock guidance and no renderer passphrase field');
    await page.locator('#saved-target').selectOption(profile.id);
    const sockets = new Set(), stalled = net.createServer(socket => {
      sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {}); socket.resume();
    });
    await new Promise(resolve => stalled.listen(0, '127.0.0.1', resolve));
    try {
      await page.locator('#ssh-port').fill(String(stalled.address().port));
      await page.getByRole('button', { name: 'Verify SSH access', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('#cancel-ssh').hidden === false);
      for (let attempt = 0; attempt < 100 && !sockets.size; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
      assert(sockets.size > 0, 'The stalled fixture did not receive an actual native SSH connection.');
      await page.getByRole('button', { name: 'Cancel SSH check', exact: true }).click();
      await page.getByRole('alert').filter({ hasText: /SSH verification was canceled/i }).waitFor();
      for (let attempt = 0; attempt < 100 && sockets.size; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
      assert(sockets.size === 0, 'Canceling native SSH left its connection running.');
      assert(await page.locator('#ssh-port').isEnabled(), 'Canceling SSH did not unlock connection controls.');
      await page.screenshot({ path: path.join(output, 'ssh-check-canceled.png'), fullPage: true });
      checks.push('native UI cancellation closes the owned real SSH process and restores editable controls');
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => stalled.close(resolve));
    }
    await page.locator('#ssh-port').fill(String(port));
    await page.getByRole('button', { name: 'Verify SSH access', exact: true }).click();
    await page.getByText(/SSH authentication verified for researcher@127\.0\.0\.1/).waitFor();
    await stop();
    const rotatedKey = await start();
    assert(rotatedKey.fingerprint !== expectedKey.fingerprint, 'The controlled server did not rotate its host identity.');
    await page.getByRole('button', { name: 'Verify SSH access', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: /server host key has changed/i }).waitFor();
    assert(await page.locator('#ssh-host-verification').isHidden(), 'Changed host keys offer a new first-use trust prompt.');
    assert(!fs.readFileSync(path.join(userData, 'ssh_known_hosts'), 'utf8').includes(rotatedKey.publicKey), 'A changed host key was trusted.');
    assert((await page.evaluate(() => window.desktopShell.getTargetProfiles())).sshStatuses[profile.id].state === 'unverified',
      'Host-key failure retained authenticated status.');
    await page.screenshot({ path: path.join(output, 'changed-host-key-rejected.png'), fullPage: true });
    checks.push('actual changed daemon host key fails closed and preserves previous trust');
    const closingSockets = new Set(), closingServer = net.createServer(socket => {
      closingSockets.add(socket); socket.on('close', () => closingSockets.delete(socket)); socket.on('error', () => {}); socket.resume();
    });
    await new Promise(resolve => closingServer.listen(0, '127.0.0.1', resolve));
    try {
      await page.locator('#ssh-port').fill(String(closingServer.address().port));
      await page.getByRole('button', { name: 'Verify SSH access', exact: true }).click();
      for (let attempt = 0; attempt < 100 && !closingSockets.size; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
      assert(closingSockets.size > 0, 'The window-close fixture did not receive a real SSH process connection.');
      const closed = application.waitForEvent('close', { timeout: 10000 });
      await page.close();
      await closed; application = null;
      for (let attempt = 0; attempt < 100 && closingSockets.size; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
      assert(closingSockets.size === 0, 'Closing native settings left an owned SSH process running.');
      checks.push('closing native settings cancels its actual SSH check and exits the desktop cleanly');
    } finally {
      for (const socket of closingSockets) socket.destroy();
      await new Promise(resolve => closingServer.close(resolve));
    }
    const videos = fs.readdirSync(videoDirectory).filter(name => name.endsWith('.webm'));
    const result = { completedAt: new Date().toISOString(), sshPort: port, nativeOpenSshVersion,
      video: videos[0] ? path.join('video', videos[0]) : null,
      screenshots: fs.readdirSync(output).filter(name => name.endsWith('.png')).length, checks };
    fs.writeFileSync(path.join(output, 'acceptance.json'), JSON.stringify(result, null, 2) + '\n');
    return { artifactDirectory: output, ...result };
  } catch (error) {
    fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ error: error.message, checks }, null, 2) + '\n');
    if (application) { const page = application.windows()[0]; if (page) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {}); }
    throw error;
  } finally {
    if (application) await application.close().catch(() => {});
    await stop().catch(() => {});
    await command('docker', ['image', 'rm', image]).catch(() => {});
    // The ephemeral client private key is unnecessary after this drill; reports
    // retain only screenshots, public host trust, and a nonsecret file reference.
    fs.rmSync(key, { force: true });
    fs.rmSync(encryptedKey, { force: true });
  }
}

module.exports = { runDesktopSshAcceptance };
if (require.main === module) runDesktopSshAcceptance().then(result => console.log(JSON.stringify(result, null, 2)))
  .catch(error => { console.error(error.message); process.exitCode = 1; });
