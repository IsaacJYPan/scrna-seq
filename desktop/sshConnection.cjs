'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { normalizeTargetProfile } = require('./desktopConfig.cjs');

function failure(code, message) { return Object.assign(new Error(message), { code }); }
function systemExecutable(name) {
  return process.platform === 'win32'
    ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH', `${name}.exe`) : name;
}

function createNativeSshRunner() {
  const processes = new Set();
  function stop(child) {
    if (!processes.has(child) || child.exitCode !== null || !child.pid) return;
    if (process.platform === 'win32') {
      const terminator = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      terminator.on('error', () => child.kill());
      terminator.on('exit', code => { if (code !== 0) child.kill(); });
    } else { try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill(); } }
  }
  async function run(program, args, { timeoutMs = 12000, signal } = {}) {
    if (signal?.aborted) throw failure('SSH_CANCELLED', 'SSH verification was canceled.');
    return new Promise((resolve, reject) => {
      const child = spawn(systemExecutable(program), args, { shell: false, windowsHide: true,
        detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
      processes.add(child);
      let stdout = '', stderr = '', size = 0, terminalError = null, finished = false, terminationTimer;
      const terminate = error => {
        terminalError = error; stop(child);
        if (!terminationTimer) terminationTimer = setTimeout(() => { child.kill(); finish(); reject(error); }, 2000);
      };
      const collect = stream => chunk => {
        size += chunk.length;
        if (size > 65536) terminate(failure('SSH_RESPONSE_LIMIT', 'The SSH client returned too much diagnostic output. Review its configuration.'));
        else if (stream === 'stdout') stdout += chunk.toString('utf8'); else stderr += chunk.toString('utf8');
      };
      child.stdout.on('data', collect('stdout')); child.stderr.on('data', collect('stderr'));
      const cancel = () => terminate(failure('SSH_CANCELLED', 'SSH verification was canceled.'));
      signal?.addEventListener('abort', cancel, { once: true });
      const timer = setTimeout(() => terminate(failure('SSH_TIMEOUT', 'SSH verification timed out. Check the host, port, network, and agent, then retry.')), timeoutMs);
      const finish = () => { finished = true; clearTimeout(timer); clearTimeout(terminationTimer); signal?.removeEventListener('abort', cancel); processes.delete(child); };
      child.once('error', error => { if (finished) return; finish(); reject(failure(error.code === 'ENOENT' ? 'SSH_NOT_INSTALLED' : 'SSH_CLIENT_FAILED',
        error.code === 'ENOENT' ? 'System OpenSSH is unavailable. Install the operating system OpenSSH client, then retry.' : 'The system SSH client could not start.')); });
      child.once('close', code => { if (finished) return; finish(); if (terminalError) reject(terminalError); else resolve({ code, stdout, stderr }); });
    });
  }
  return { run, dispose() { for (const child of processes) stop(child); } };
}

function sshProfileArgs(profile) {
  const ssh = normalizeTargetProfile(profile).ssh;
  const args = [];
  if (ssh.port) args.push('-p', String(ssh.port));
  if (ssh.username) args.push('-l', ssh.username);
  if (ssh.identityFile) args.push('-i', ssh.identityFile);
  return args;
}
function parseSshConfiguration(text) {
  const settings = {};
  for (const line of String(text).split(/\r?\n/)) {
    const match = /^([a-z]+) (.+)$/i.exec(line);
    if (match && !Object.hasOwn(settings, match[1].toLowerCase())) settings[match[1].toLowerCase()] = match[2];
  }
  settings.sourceDigest = createHash('sha256').update(String(text)).digest('hex');
  if (!/^[A-Za-z0-9_.:[\]-]+$/.test(settings.hostname || '') || settings.hostname.startsWith('-')
      || !Number.isInteger(Number(settings.port)) || Number(settings.port) < 1 || Number(settings.port) > 65535
      || !settings.user || /[\r\n\0]/.test(settings.user)) {
    throw failure('SSH_CONFIGURATION_INVALID', 'OpenSSH did not resolve a valid host, port, and username. Review your SSH configuration.');
  }
  if (settings.hostkeyalias && !/^[A-Za-z0-9_.:[\]-]+$/.test(settings.hostkeyalias)) {
    throw failure('SSH_CONFIGURATION_INVALID', 'This host-key alias cannot be managed by the desktop. Verify the host through your OpenSSH configuration.');
  }
  return settings;
}
function hostLookup(configuration) {
  if (configuration.hostkeyalias && configuration.hostkeyalias !== 'none') return configuration.hostkeyalias;
  const host = configuration.hostname.replace(/^\[|\]$/g, '');
  return Number(configuration.port) === 22 ? host : `[${host}]:${configuration.port}`;
}
function scannedHostKeys(text) {
  const keys = [];
  for (const line of String(text).split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length !== 3 || !/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521))$/.test(parts[1])
        || !/^[A-Za-z0-9+/]+={0,2}$/.test(parts[2]) || parts[2].length > 8192) continue;
    const bytes = Buffer.from(parts[2], 'base64');
    if (bytes.toString('base64') !== parts[2] || bytes.length < 8) continue;
    const length = bytes.readUInt32BE(0);
    if (length > 100 || bytes.subarray(4, 4 + length).toString('utf8') !== parts[1]) continue;
    const fingerprint = 'SHA256:' + createHash('sha256').update(bytes).digest('base64').replace(/=+$/, '');
    if (!keys.some(key => key.fingerprint === fingerprint)) keys.push({ algorithm: parts[1], publicKey: parts[2], fingerprint });
  }
  return keys;
}
function classifySshFailure(result, { hasExplicitIdentity = false } = {}) {
  const text = result.stderr || '';
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Offending .* key|Host key for .* has changed/i.test(text)) {
    return failure('SSH_HOST_CHANGED', 'The server host key has changed. Verify the change with its administrator before editing the trusted-host file and retrying.');
  }
  if (/No .* host key is known|No host key is known/i.test(text)) return failure('SSH_HOST_UNKNOWN', 'The SSH host identity needs verification.');
  if (/bad permissions|UNPROTECTED PRIVATE KEY FILE|Load key .*|identity file .* not accessible/i.test(text)) {
    return failure('SSH_IDENTITY_UNAVAILABLE', 'OpenSSH could not use the selected identity. Check its permissions or unlock it in your native SSH agent.');
  }
  if (/could not resolve hostname|connection refused|no route to host|network is unreachable|connection timed out/i.test(text)) {
    return failure('SSH_UNREACHABLE', 'The SSH host could not be reached. Check its address, port, and network connection.');
  }
  if (/Host key verification failed/i.test(text)) return failure('SSH_HOST_REJECTED', 'OpenSSH rejected the host identity. Review the trusted-host records and SSH configuration.');
  if (/Permission denied|Too many authentication failures|no supported authentication methods/i.test(text)) {
    if (/agent refused operation|communication with agent failed/i.test(text)) return failure('SSH_AGENT_UNAVAILABLE', 'Your native SSH agent could not sign the authentication request. Unlock the identity in the agent and retry.');
    if (/agent contains no identities/i.test(text)) return failure('SSH_AGENT_EMPTY', 'Your native SSH agent has no loaded identities. Load the correct key with native OpenSSH, or choose its identity file, and check your username.');
    if (!hasExplicitIdentity && /ssh_get_authentication_socket:|could not open a connection to your authentication agent/i.test(text)) {
      return failure('SSH_AGENT_UNAVAILABLE', 'Your native SSH agent is unavailable. Start or unlock it through OpenSSH, or choose an identity file, and check the configured identity and username.');
    }
    return failure('SSH_AUTHENTICATION_FAILED', 'The server rejected SSH authentication. Load the correct identity into your native SSH agent or choose its identity file, and check your username.');
  }
  return failure('SSH_VERIFICATION_FAILED', 'SSH access could not be verified. The server must allow a noninteractive authentication check; review its SSH policy and retry.');
}

async function addTrustedHost(filename, host, key, { signal } = {}) {
  const checkCancellation = () => { if (signal?.aborted) throw failure('SSH_CANCELLED', 'SSH verification was canceled.'); };
  checkCancellation();
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const lockname = filename + '.lock';
  let lock;
  const deadline = Date.now() + 2000;
  while (!lock) {
    checkCancellation();
    try { lock = await fs.open(lockname, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw failure('SSH_TRUST_BUSY', 'Another desktop instance is updating host trust. Close it or wait, then retry.');
      await new Promise(resolve => setTimeout(resolve, 40));
    }
  }
  const temporary = filename + '.' + randomUUID() + '.tmp';
  try {
    checkCancellation();
    let previous = '';
    try {
      const stat = await fs.lstat(filename);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw failure('SSH_TRUST_INVALID', 'The desktop trusted-host file cannot be safely updated. Review it before retrying.');
      previous = await fs.readFile(filename, 'utf8');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const entries = previous.split(/\r?\n/).map(line => line.trim().split(/\s+/));
    const matches = entries.filter(parts => parts[0] === host && parts[1] === key.algorithm);
    if (matches.some(parts => parts[2] !== key.publicKey)) throw failure('SSH_HOST_CHANGED', 'A different key was trusted while you were verifying this host. Check with the server administrator, then retry.');
    if (matches.some(parts => parts[2] === key.publicKey)) return;
    const contents = previous.replace(/\s*$/, '') + (previous.trim() ? '\n' : '') + `${host} ${key.algorithm} ${key.publicKey}\n`;
    const output = await fs.open(temporary, 'wx', 0o600);
    try { await output.writeFile(contents); await output.sync(); } finally { await output.close(); }
    checkCancellation();
    await fs.rename(temporary, filename);
  } finally { await fs.rm(temporary, { force: true }); await lock.close(); await fs.rm(lockname, { force: true }); }
}

function createSshConnectionManager({ knownHostsFile, run, now = Date.now } = {}) {
  if (!path.isAbsolute(knownHostsFile || '') || /["\r\n\0]/.test(knownHostsFile)) throw new Error('A private native trusted-host path is required.');
  const native = run ? null : createNativeSshRunner();
  const execute = run || native.run;
  const challenges = new Map(), operations = new Map(), statuses = new Map();
  async function configuration(profile, signal) {
    if (profile.ssh.identityFile) {
      try { if (!(await fs.stat(profile.ssh.identityFile)).isFile()) throw new Error('not a file'); }
      catch { throw failure('SSH_IDENTITY_UNAVAILABLE', 'The selected identity file is unavailable. Choose an existing private-key file through the native picker.'); }
    }
    const result = await execute('ssh', ['-G', ...sshProfileArgs(profile), profile.ssh.host.replace(/^\[|\]$/g, '')], { signal });
    if (result.code !== 0) throw failure('SSH_CONFIGURATION_INVALID', 'OpenSSH could not read this connection’s configuration. Review your system SSH settings.');
    return parseSshConfiguration(result.stdout);
  }
  async function authenticate(profile, config, signal, appTrust = false) {
    const result = await execute('ssh', ['-T', '-v', '-oBatchMode=yes', '-oStrictHostKeyChecking=yes',
      '-oUpdateHostKeys=no', '-oControlMaster=no', '-oControlPath=none', '-oClearAllForwardings=yes',
      '-oForwardAgent=no', '-oForwardX11=no', '-oTunnel=no', '-oPermitLocalCommand=no',
      '-oRequestTTY=no', '-oRemoteCommand=none', '-oConnectTimeout=8',
      '-oConnectionAttempts=1', ...(appTrust ? [`-oUserKnownHostsFile="${knownHostsFile.replace(/\\/g, '/')}"`] : []), ...sshProfileArgs(profile),
      profile.ssh.host.replace(/^\[|\]$/g, ''), 'true'], { signal });
    if (result.code !== 0) {
      const error = classifySshFailure(result, { hasExplicitIdentity: Boolean(profile.ssh.identityFile) });
      if (profile.ssh.identityFile && ['SSH_AUTHENTICATION_FAILED', 'SSH_AGENT_EMPTY', 'SSH_IDENTITY_UNAVAILABLE'].includes(error.code)) {
        const key = await execute('ssh-keygen', ['-y', '-P', '', '-f', profile.ssh.identityFile], { signal });
        if (key.code !== 0 && /incorrect passphrase|encrypted|passphrase/i.test(key.stderr || '')) {
          throw failure('SSH_IDENTITY_LOCKED', 'The selected identity is encrypted. Use Unlock with OpenSSH to load it into your native agent, then retry.');
        }
      }
      throw error;
    }
    const status = { state: 'authenticated', profileId: profile.id, host: config.hostname,
      port: Number(config.port), username: config.user, verifiedAt: new Date(now()).toISOString(), applicationConnected: false };
    statuses.set(profile.id, { profileDigest: createHash('sha256').update(JSON.stringify(profile)).digest('hex'), status }); return status;
  }
  async function authenticateWithTrust(profile, config, signal) {
    // Preserve native known-host files and their quoting/configuration. Only an
    // unknown host falls back to the separate, explicitly verified app file.
    try { return await authenticate(profile, config, signal); }
    catch (error) { if (error.code !== 'SSH_HOST_UNKNOWN') throw error; }
    return authenticate(profile, config, signal, true);
  }
  async function discoverHostKeys(profile, config, signal) {
    const scan = await execute('ssh-keyscan', ['-T', '5', '-p', config.port, '-t', 'ed25519,ecdsa,rsa', config.hostname.replace(/^\[|\]$/g, '')], { signal });
    const keys = scannedHostKeys(scan.stdout);
    if (keys.length || !/choose_kex: unsupported KEX method/i.test(scan.stderr || '')) return keys;
    // Some Windows OpenSSH clients advertise a keyscan KEX they cannot use.
    // Discover through ssh.exe without offering any authentication, executing
    // a command, or treating the quarantined public key as trusted.
    const quarantine = knownHostsFile + '.discovery-' + randomUUID();
    await fs.mkdir(path.dirname(quarantine), { recursive: true, mode: 0o700 });
    try {
      try {
        await execute('ssh', ['-N', '-T', '-oBatchMode=yes', '-oStrictHostKeyChecking=accept-new',
          `-oUserKnownHostsFile="${quarantine.replace(/\\/g, '/')}"`, '-oGlobalKnownHostsFile=none',
          '-oKnownHostsCommand=none', '-oHashKnownHosts=no', '-oUpdateHostKeys=no',
          '-oIdentityAgent=none', '-oIdentityFile=none',
          '-oPubkeyAuthentication=no', '-oPasswordAuthentication=no', '-oKbdInteractiveAuthentication=no',
          '-oGSSAPIAuthentication=no', '-oHostbasedAuthentication=no', '-oPreferredAuthentications=none',
          '-oControlMaster=no', '-oControlPath=none', '-oClearAllForwardings=yes', '-oForwardAgent=no',
          '-oForwardX11=no', '-oTunnel=no', '-oPermitLocalCommand=no',
          '-oRequestTTY=no', '-oRemoteCommand=none', '-oConnectTimeout=8', '-oConnectionAttempts=1',
          ...(profile.ssh.port ? ['-p', String(profile.ssh.port)] : []), '-l', 'traceomics-host-verification',
          profile.ssh.host.replace(/^\[|\]$/g, '')], { signal });
      } catch (error) { if (error.code !== 'SSH_TIMEOUT') throw error; }
      if (signal?.aborted) throw failure('SSH_CANCELLED', 'SSH verification was canceled.');
      const stat = await fs.stat(quarantine).catch(() => null);
      return stat?.isFile() && stat.size <= 65536 ? scannedHostKeys(await fs.readFile(quarantine, 'utf8')) : [];
    } finally { await fs.rm(quarantine, { force: true }); }
  }
  async function operation(scope, callback) {
    if (operations.has(scope)) throw failure('SSH_BUSY', 'An SSH check is already in progress. Cancel it or wait, then retry.');
    const controller = new AbortController(); operations.set(scope, controller);
    try { return await callback(controller.signal); } finally { operations.delete(scope); }
  }
  return {
    async verify(value, scope) {
      const profile = normalizeTargetProfile(value);
      if (profile.kind !== 'ssh') throw failure('SSH_PROFILE_REQUIRED', 'Choose an SSH target.');
      statuses.delete(profile.id);
      for (const [id, challenge] of challenges) if (challenge.scope === scope || challenge.expiresAt < now()) challenges.delete(id);
      return operation(scope, async signal => {
        const config = await configuration(profile, signal);
        try { return await authenticateWithTrust(profile, config, signal); }
        catch (error) {
          statuses.delete(profile.id);
          if (error.code !== 'SSH_HOST_UNKNOWN') throw error;
          if ((config.proxyjump && config.proxyjump !== 'none') || (config.proxycommand && config.proxycommand !== 'none')) {
            throw failure('SSH_PROXY_HOST_UNKNOWN', 'This connection uses your SSH proxy configuration. Verify its hosts through native OpenSSH first, then retry.');
          }
          const keys = await discoverHostKeys(profile, config, signal);
          if (!keys.length) throw failure('SSH_HOST_DISCOVERY_FAILED', 'The SSH server did not provide a supported host key. Check its address and port.');
          const id = randomUUID(); challenges.set(id, { profile, config, keys, scope, expiresAt: now() + 120000 });
          return { state: 'verify-host', profileId: profile.id, challengeId: id, host: config.hostname, port: Number(config.port),
            username: config.user, fingerprints: keys.map(({ algorithm, fingerprint }) => ({ algorithm, fingerprint })) };
        }
      });
    },
    async confirm(challengeId, fingerprint, scope) {
      const challenge = challenges.get(challengeId);
      if (!challenge || challenge.scope !== scope || challenge.expiresAt < now()) throw failure('SSH_CHALLENGE_EXPIRED', 'The host verification expired. Check SSH access again.');
      const key = challenge.keys.find(candidate => candidate.fingerprint === fingerprint);
      if (!key) throw failure('SSH_FINGERPRINT_REQUIRED', 'Choose the fingerprint you verified with the server administrator.');
      challenges.delete(challengeId);
      return operation(scope, async signal => {
        const config = await configuration(challenge.profile, signal);
        if (config.sourceDigest !== challenge.config.sourceDigest || hostLookup(config) !== hostLookup(challenge.config) || config.hostname !== challenge.config.hostname
            || config.port !== challenge.config.port || config.user !== challenge.config.user) {
          throw failure('SSH_CONFIGURATION_CHANGED', 'Your SSH configuration changed during host verification. Check SSH access again.');
        }
        await addTrustedHost(knownHostsFile, hostLookup(config), key, { signal });
        return authenticateWithTrust(challenge.profile, config, signal);
      });
    },
    status(value) {
      const profile = typeof value === 'string' ? null : normalizeTargetProfile(value);
      const id = profile?.id || value;
      const saved = statuses.get(id);
      if (saved && profile && saved.profileDigest === createHash('sha256').update(JSON.stringify(profile)).digest('hex')) return saved.status;
      return { state: 'unverified', profileId: id, applicationConnected: false };
    },
    invalidate(id) {
      statuses.delete(id);
      for (const [key, challenge] of challenges) if (challenge.profile.id === id) challenges.delete(key);
    },
    cancel(scope) {
      operations.get(scope)?.abort();
      for (const [id, challenge] of challenges) if (challenge.scope === scope) challenges.delete(id);
    },
    dispose() { for (const scope of operations.keys()) this.cancel(scope); challenges.clear(); native?.dispose(); },
  };
}
module.exports = { createNativeSshRunner, createSshConnectionManager, sshProfileArgs,
  parseSshConfiguration, hostLookup, scannedHostKeys, classifySshFailure, addTrustedHost, systemExecutable };
