import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import sshConnection from './sshConnection.cjs';

const { createNativeSshRunner, createSshConnectionManager, sshProfileArgs, parseSshConfiguration,
  hostLookup, scannedHostKeys, classifySshFailure, addTrustedHost } = sshConnection;
const artifactRoot = path.resolve('playwright/report');
const managers = new Set();
let directory;

const profile = (ssh = {}) => ({ id: 'lab-server', name: 'Lab compute', kind: 'ssh',
  ssh: { host: 'lab-compute', remoteHost: '127.0.0.1', remotePort: 3000, ...ssh } });
const configuration = (extra = '') => `hostname 127.0.0.1\nport 22022\nuser researcher\nhostkeyalias none\nproxyjump none\nproxycommand none\n${extra}`;
const unknownHost = { code: 255, stdout: '', stderr: 'No ED25519 host key is known for [127.0.0.1]:22022 and you have requested strict checking.\nHost key verification failed.' };
const changedHost = { code: 255, stdout: '', stderr: '@@@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@@@\nOffending ED25519 key in a private native path.' };
const authenticated = { code: 0, stdout: '', stderr: '' };
function publicKey(fill = 1) {
  const algorithm = Buffer.from('ssh-ed25519');
  const header = Buffer.alloc(4), size = Buffer.alloc(4);
  header.writeUInt32BE(algorithm.length); size.writeUInt32BE(32);
  const bytes = Buffer.concat([header, algorithm, size, Buffer.alloc(32, fill)]);
  return { algorithm: 'ssh-ed25519', publicKey: bytes.toString('base64'),
    fingerprint: 'SHA256:' + createHash('sha256').update(bytes).digest('base64').replace(/=+$/, '') };
}

function fixture({ nativeResult = unknownHost, appResult, config = configuration(), key = publicKey() } = {}) {
  const state = { nativeResult, appResult, config, key };
  const knownHostsFile = path.join(directory, 'Native user folder', 'trusted_hosts');
  const run = vi.fn(async (program, args) => {
    if (program === 'ssh-keyscan') return { code: 0, stdout: `# server diagnostic\n[127.0.0.1]:22022 ${state.key.algorithm} ${state.key.publicKey}\n`, stderr: '' };
    if (program === 'ssh' && args[0] === '-G') return { code: 0, stdout: state.config, stderr: '' };
    if (program !== 'ssh') throw new Error(`Unexpected native program ${program}`);
    const usesAppTrust = args.some(arg => arg.startsWith('-oUserKnownHostsFile='));
    if (!usesAppTrust) return state.nativeResult;
    if (state.appResult) return state.appResult;
    const contents = await fs.readFile(knownHostsFile, 'utf8').catch(() => '');
    return contents.includes(state.key.publicKey) ? authenticated : unknownHost;
  });
  const manager = createSshConnectionManager({ knownHostsFile, run });
  managers.add(manager);
  return { manager, state, run, knownHostsFile };
}

function discoveryFixture({ scanError = 'choose_kex: unsupported KEX method sntrup761x25519-sha512@openssh.com',
  scanOutput = '', discoveryError, quarantineContent = `127.0.0.1 ssh-ed25519 ${publicKey().publicKey}\n` } = {}) {
  const result = fixture();
  const originalRun = result.run.getMockImplementation();
  const quarantineFiles = [];
  result.run.mockImplementation(async (program, args, options) => {
    if (program === 'ssh-keyscan') return { code: 1, stdout: scanOutput, stderr: scanError };
    if (program === 'ssh' && args.includes('-N')) {
      const quarantine = args.find(arg => arg.startsWith('-oUserKnownHostsFile=')).slice('-oUserKnownHostsFile='.length).replace(/^"|"$/g, '');
      quarantineFiles.push(quarantine);
      if (quarantineContent !== null) await fs.writeFile(quarantine, quarantineContent);
      if (discoveryError) throw Object.assign(new Error('Controlled native discovery failure'), { code: discoveryError });
      return { code: 255, stdout: '', stderr: 'Permission denied (publickey).' };
    }
    return originalRun(program, args, options);
  });
  return { ...result, quarantineFiles };
}

beforeEach(async () => {
  await fs.mkdir(artifactRoot, { recursive: true });
  directory = await fs.mkdtemp(path.join(artifactRoot, 'ssh-unit-'));
});
afterEach(async () => {
  for (const manager of managers) manager.dispose();
  managers.clear();
  const resolved = path.resolve(directory);
  if (path.dirname(resolved) !== artifactRoot || !path.basename(resolved).startsWith('ssh-unit-')) throw new Error('Refusing unsafe fixture cleanup.');
  await fs.rm(resolved, { recursive: true, force: true });
});

describe('native OpenSSH configuration and public host identity', () => {
  it('leaves agent, alias, username and port selection to native config unless explicitly chosen', () => {
    expect(sshProfileArgs(profile())).toEqual([]);
    expect(sshProfileArgs(profile({ username: 'researcher', port: 22022, identityFile: 'C:\\Users\\researcher\\.ssh\\lab key' })))
      .toEqual(['-p', '22022', '-l', 'researcher', '-i', 'C:\\Users\\researcher\\.ssh\\lab key']);
    const resolved = parseSshConfiguration(configuration('identityfile C:/Users/researcher/.ssh/lab key\nuserknownhostsfile C:/Users/researcher/trusted hosts\n'));
    expect(resolved).toMatchObject({ hostname: '127.0.0.1', port: '22022', user: 'researcher' });
    expect(resolved.sourceDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(hostLookup(resolved)).toBe('[127.0.0.1]:22022');
    expect(hostLookup({ hostname: '[::1]', port: '22' })).toBe('::1');
    expect(hostLookup({ hostname: '127.0.0.1', port: '22022', hostkeyalias: 'lab-verified' })).toBe('lab-verified');
  });

  it('rejects malformed or option-bearing resolved hosts, ports, usernames and aliases', () => {
    for (const text of ['hostname -oProxyCommand=bad\nport 22\nuser researcher\n', 'hostname -v\nport 22\nuser researcher\n',
      'hostname example.org\nport 65536\nuser researcher\n', 'hostname example.org\nport 22\nuser bad\0name\n',
      'hostname [example.org]\nport 22\nuser researcher\n', 'hostname ::1]\nport 22\nuser researcher\n',
      'hostname 2001:db8:::1\nport 22\nuser researcher\n', 'hostname example.org\nport 22\nuser bad\tname\n',
      configuration('hostkeyalias invalid alias\n').replace('hostkeyalias none\n', '')]) {
      expect(() => parseSshConfiguration(text)).toThrow(/OpenSSH|host-key alias/);
    }
    expect(parseSshConfiguration('hostname 2001:db8::42\nport 2222\nuser DOMAIN\\researcher\n')).toMatchObject({ hostname: '2001:db8::42', user: 'DOMAIN\\researcher' });
    expect(parseSshConfiguration('hostname [::1]\nport 2222\nuser researcher@lab.example.org\n')).toMatchObject({ hostname: '[::1]', user: 'researcher@lab.example.org' });
  });

  it('derives SHA256 fingerprints from supported public key bytes and omits malformed scan entries', () => {
    const key = publicKey();
    const result = scannedHostKeys(`# comment\nserver ${key.algorithm} ${key.publicKey}\nserver ${key.algorithm} ${key.publicKey}\nserver ssh-dss ${key.publicKey}\nserver ssh-rsa ${key.publicKey}\nserver ssh-ed25519 invalid%%%\nserver ssh-ed25519 YQ==\n`);
    expect(result).toEqual([key]);
  });

  it.each([
    [changedHost.stderr, 'SSH_HOST_CHANGED'], [unknownHost.stderr, 'SSH_HOST_UNKNOWN'],
    ['WARNING: UNPROTECTED PRIVATE KEY FILE!', 'SSH_IDENTITY_UNAVAILABLE'],
    ['Bad owner or permissions on /native/user/config', 'SSH_CONFIGURATION_INVALID'],
    ['Load key "a native identity": bad permissions', 'SSH_IDENTITY_UNAVAILABLE'],
    ['connect to host example port 22: Connection refused', 'SSH_UNREACHABLE'],
    ['Could not resolve hostname unknown: Name or service not known', 'SSH_UNREACHABLE'],
    ['kex_exchange_identification: Connection closed by remote host', 'SSH_UNREACHABLE'],
    ['channel 0: open failed: connect failed: Name does not resolve\nstdio forwarding failed', 'SSH_UNREACHABLE'],
    ['Host key verification failed.', 'SSH_HOST_REJECTED'],
    ['researcher@example: Permission denied (publickey).', 'SSH_AUTHENTICATION_FAILED'],
    ['sign_and_send_pubkey: signing failed: agent refused operation\nPermission denied (publickey).', 'SSH_AGENT_UNAVAILABLE'],
    ['get_agent_identities: agent contains no identities\nPermission denied (publickey).', 'SSH_AGENT_EMPTY'],
    ['get_agent_identities: ssh_get_authentication_socket: No such file or directory\nPermission denied (publickey).', 'SSH_AGENT_UNAVAILABLE'],
    ['administratively prohibited session command', 'SSH_VERIFICATION_FAILED'],
  ])('classifies %s without exposing native diagnostic content', (stderr, code) => {
    const error = classifySshFailure({ code: 255, stderr });
    expect(error.code).toBe(code);
    expect(error.message).not.toContain('a native identity');
    expect(error.message).not.toContain('private native path');
  });

  it('keeps a selected-file authentication rejection distinct from an absent optional native agent', () => {
    const error = classifySshFailure({ code: 255,
      stderr: 'get_agent_identities: ssh_get_authentication_socket: No such file or directory\nPermission denied (publickey).' },
    { hasExplicitIdentity: true });
    expect(error.code).toBe('SSH_AUTHENTICATION_FAILED');
  });
});

describe('host discovery with incompatible native keyscan KEX', () => {
  it('uses isolated authentication-free discovery only after strict verification found an unknown host', async () => {
    const { manager, run, knownHostsFile, quarantineFiles } = discoveryFixture();
    const identityFile = path.join(directory, 'native identity');
    await fs.writeFile(identityFile, 'opaque native identity fixture');
    const pending = await manager.verify(profile({ username: 'researcher', port: 22022, identityFile }), 'setup-a');
    expect(pending).toMatchObject({ state: 'verify-host', fingerprints: [{ algorithm: 'ssh-ed25519', fingerprint: publicKey().fingerprint }] });
    expect(manager.status(profile())).toMatchObject({ state: 'unverified', applicationConnected: false });
    const nativeCalls = run.mock.calls;
    expect(nativeCalls[0][1][0]).toBe('-G');
    expect(nativeCalls[1][1]).toContain('-oStrictHostKeyChecking=yes');
    expect(nativeCalls[2][1]).toContain('-oStrictHostKeyChecking=yes');
    expect(nativeCalls[3][0]).toBe('ssh-keyscan');
    const discoveryArgs = nativeCalls[4][1];
    expect(discoveryArgs).toEqual(expect.arrayContaining(['-N', '-T', '-oBatchMode=yes', '-oStrictHostKeyChecking=accept-new',
      '-oGlobalKnownHostsFile=none', '-oKnownHostsCommand=none', '-oHashKnownHosts=no', '-oUpdateHostKeys=no',
      '-oIdentityAgent=none', '-oIdentityFile=none',
      '-oPubkeyAuthentication=no', '-oPasswordAuthentication=no', '-oKbdInteractiveAuthentication=no',
      '-oGSSAPIAuthentication=no', '-oHostbasedAuthentication=no', '-oPreferredAuthentications=none',
      '-oControlMaster=no', '-oControlPath=none', '-oClearAllForwardings=yes', '-oForwardAgent=no',
      '-oForwardX11=no', '-oTunnel=no', '-oPermitLocalCommand=no', '-oRequestTTY=no', '-oRemoteCommand=none']));
    expect(discoveryArgs.slice(-5)).toEqual(['-p', '22022', '-l', 'traceomics-host-verification', 'lab-compute']);
    expect(discoveryArgs).not.toContain('-i');
    expect(discoveryArgs).not.toContain(identityFile);
    expect(discoveryArgs).not.toContain('true');
    for (const forwarding of ['-L', '-R', '-D', '-w']) expect(discoveryArgs).not.toContain(forwarding);
    expect(quarantineFiles).toHaveLength(1);
    expect(quarantineFiles[0]).not.toBe(knownHostsFile);
    await expect(fs.stat(knownHostsFile)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(quarantineFiles[0])).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readdir(path.dirname(knownHostsFile))).toEqual([]);
  });

  it.each(['SSH_CANCELLED', 'SSH_CLIENT_FAILED', 'SSH_RESPONSE_LIMIT'])(
    'removes quarantine host data when native discovery fails with %s', async discoveryError => {
      const { manager, knownHostsFile, quarantineFiles } = discoveryFixture({ discoveryError });
      await expect(manager.verify(profile(), 'setup-a')).rejects.toMatchObject({ code: discoveryError });
      expect(manager.status(profile())).toMatchObject({ state: 'unverified', applicationConnected: false });
      expect(quarantineFiles).toHaveLength(1);
      await expect(fs.stat(quarantineFiles[0])).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.stat(knownHostsFile)).rejects.toMatchObject({ code: 'ENOENT' });
    });

  it('can display an already discovered public identity after bounded native timeout without trusting it', async () => {
    const { manager, knownHostsFile, quarantineFiles } = discoveryFixture({ discoveryError: 'SSH_TIMEOUT' });
    const pending = await manager.verify(profile(), 'setup-a');
    expect(pending.state).toBe('verify-host');
    expect(manager.status(profile()).state).toBe('unverified');
    await expect(fs.stat(knownHostsFile)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(quarantineFiles[0])).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([null, 'unsupported host data', 'x'.repeat(65537)])(
    'rejects absent, malformed or oversized quarantined public keys', async quarantineContent => {
      const { manager, knownHostsFile, quarantineFiles } = discoveryFixture({ quarantineContent });
      await expect(manager.verify(profile(), 'setup-a')).rejects.toMatchObject({ code: 'SSH_HOST_DISCOVERY_FAILED' });
      expect(manager.status(profile()).state).toBe('unverified');
      await expect(fs.stat(knownHostsFile)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.stat(quarantineFiles[0])).rejects.toMatchObject({ code: 'ENOENT' });
    });

  it('does not relax strict verification for ordinary discovery errors', async () => {
    const { manager, run, knownHostsFile } = discoveryFixture({ scanError: 'connection refused' });
    await expect(manager.verify(profile(), 'setup-a')).rejects.toMatchObject({ code: 'SSH_HOST_DISCOVERY_FAILED' });
    expect(run.mock.calls.some(([, args]) => args.includes('-oStrictHostKeyChecking=accept-new'))).toBe(false);
    await expect(fs.stat(knownHostsFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('uses supported keyscan keys directly even if another key negotiation reports an unsupported KEX', async () => {
    const { manager, run, knownHostsFile } = discoveryFixture({ scanOutput: `127.0.0.1 ssh-ed25519 ${publicKey().publicKey}\n` });
    expect((await manager.verify(profile(), 'setup-a')).state).toBe('verify-host');
    expect(run.mock.calls.some(([, args]) => args.includes('-oStrictHostKeyChecking=accept-new'))).toBe(false);
    await expect(fs.stat(knownHostsFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('SSH authentication without opening the project service', () => {
  it('honors an already trusted native host without replacing native known_hosts settings', async () => {
    const { manager, run } = fixture({ nativeResult: authenticated });
    const result = await manager.verify(profile(), 'setup-a');
    expect(result).toMatchObject({ state: 'authenticated', host: '127.0.0.1', port: 22022,
      username: 'researcher', applicationConnected: false });
    expect(manager.status(profile())).toEqual(result);
    expect(manager.status(profile().id)).toMatchObject({ state: 'unverified', applicationConnected: false });
    expect(run.mock.calls).toHaveLength(2);
    const authenticationArgs = run.mock.calls[1][1];
    expect(authenticationArgs).toEqual(expect.arrayContaining(['-T', '-oBatchMode=yes', '-oStrictHostKeyChecking=yes',
      '-oControlMaster=no', '-oControlPath=none', '-oClearAllForwardings=yes', '-oForwardAgent=no', '-oRemoteCommand=none']));
    expect(authenticationArgs.slice(-2)).toEqual(['lab-compute', 'true']);
    expect(authenticationArgs.some(arg => arg.startsWith('-oUserKnownHostsFile='))).toBe(false);
    expect(authenticationArgs).not.toContain('-L');
    expect(authenticationArgs).not.toContain('-R');
    expect(authenticationArgs).not.toContain('-D');
  });

  it('requires independently verified fingerprint confirmation before saving first-use trust', async () => {
    const { manager, run, knownHostsFile } = fixture();
    const pending = await manager.verify(profile(), 'setup-a');
    expect(pending).toMatchObject({ state: 'verify-host', host: '127.0.0.1', port: 22022,
      username: 'researcher', fingerprints: [{ algorithm: 'ssh-ed25519', fingerprint: publicKey().fingerprint }] });
    expect(JSON.stringify(pending)).not.toContain(publicKey().publicKey);
    expect(pending).not.toHaveProperty('identityFile');
    expect(manager.status(profile()).state).toBe('unverified');
    await expect(fs.stat(knownHostsFile)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(manager.confirm(pending.challengeId, 'SHA256:unverified', 'setup-a')).rejects.toMatchObject({ code: 'SSH_FINGERPRINT_REQUIRED' });
    const verified = await manager.confirm(pending.challengeId, pending.fingerprints[0].fingerprint, 'setup-a');
    expect(verified).toMatchObject({ state: 'authenticated', applicationConnected: false });
    expect(await fs.readFile(knownHostsFile, 'utf8')).toBe(`[127.0.0.1]:22022 ssh-ed25519 ${publicKey().publicKey}\n`);
    const appTrustArgs = run.mock.calls.filter(([, args]) => args.some(arg => arg.startsWith('-oUserKnownHostsFile=')));
    expect(appTrustArgs.every(([, args]) => args.includes(`-oUserKnownHostsFile="${knownHostsFile.replace(/\\/g, '/')}"`))).toBe(true);
    await expect(manager.confirm(pending.challengeId, pending.fingerprints[0].fingerprint, 'setup-a')).rejects.toMatchObject({ code: 'SSH_CHALLENGE_EXPIRED' });
    expect((await manager.verify(profile(), 'setup-a')).state).toBe('authenticated');
  });

  it.each(['native', 'app'])('fails closed for a changed %s trusted host key without offering replacement', async which => {
    const { manager, run, knownHostsFile } = fixture(which === 'native'
      ? { nativeResult: changedHost } : { appResult: changedHost });
    await expect(manager.verify(profile(), 'setup-a')).rejects.toMatchObject({ code: 'SSH_HOST_CHANGED' });
    expect(manager.status(profile())).toMatchObject({ state: 'unverified', applicationConnected: false });
    expect(run.mock.calls.some(([program]) => program === 'ssh-keyscan')).toBe(false);
    expect(run.mock.calls.filter(([, args]) => args.some(arg => arg.startsWith('-oUserKnownHostsFile=')))).toHaveLength(which === 'native' ? 0 : 1);
    await expect(fs.stat(knownHostsFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not turn an authentication failure or misleading server banner into success', async () => {
    const { manager, run } = fixture({ nativeResult: { code: 255, stdout: '',
      stderr: 'Authenticated to lab-compute.\nresearcher@lab-compute: Permission denied (publickey).' } });
    await expect(manager.verify(profile(), 'setup-a')).rejects.toMatchObject({ code: 'SSH_AUTHENTICATION_FAILED' });
    expect(manager.status(profile()).state).toBe('unverified');
    expect(run.mock.calls.some(([program]) => program === 'ssh-keyscan')).toBe(false);
    expect(run.mock.calls.some(([, args]) => args.some(arg => arg.startsWith('-oUserKnownHostsFile=')))).toBe(false);
  });

  it('rejects a missing explicit identity before connecting instead of silently choosing another key', async () => {
    const { manager, run } = fixture({ nativeResult: authenticated });
    await expect(manager.verify(profile({ identityFile: path.join(directory, 'missing-key') }), 'setup-a'))
      .rejects.toMatchObject({ code: 'SSH_IDENTITY_UNAVAILABLE' });
    expect(run).not.toHaveBeenCalled();
    expect(manager.status(profile()).state).toBe('unverified');
  });

  it('diagnoses a locked selected identity through native keygen without asking the renderer for its passphrase', async () => {
    const identityFile = path.join(directory, 'encrypted native identity');
    await fs.writeFile(identityFile, 'opaque native key fixture');
    const run = vi.fn(async (program, args) => {
      if (program === 'ssh' && args[0] === '-G') return { code: 0, stdout: configuration(), stderr: '' };
      if (program === 'ssh') return { code: 255, stdout: '', stderr: 'Permission denied (publickey).' };
      if (program === 'ssh-keygen') return { code: 255, stdout: '', stderr: `Load key "${identityFile}": incorrect passphrase supplied to decrypt private key` };
      throw new Error('Unexpected native program');
    });
    const manager = createSshConnectionManager({ knownHostsFile: path.join(directory, 'trusted_hosts'), run });
    managers.add(manager);
    const pending = manager.verify(profile({ identityFile }), 'setup-a');
    await expect(pending).rejects.toMatchObject({ code: 'SSH_IDENTITY_LOCKED' });
    await expect(pending).rejects.toThrow(/Unlock with OpenSSH/);
    expect(run.mock.calls.find(([program]) => program === 'ssh-keygen')[1]).toEqual(['-y', '-P', '', '-f', identityFile]);
    expect(manager.status(profile({ identityFile }))).toMatchObject({ state: 'unverified', applicationConnected: false });
  });

  it('keeps a usable selected identity and wrong username distinct from encrypted-key diagnosis', async () => {
    const identityFile = path.join(directory, 'native identity');
    await fs.writeFile(identityFile, 'opaque native key fixture');
    const run = vi.fn(async (program, args) => {
      if (program === 'ssh' && args[0] === '-G') return { code: 0, stdout: configuration(), stderr: '' };
      if (program === 'ssh') return { code: 255, stdout: '', stderr: 'Permission denied (publickey).' };
      if (program === 'ssh-keygen') return { code: 0, stdout: publicKey().publicKey, stderr: '' };
      throw new Error('Unexpected native program');
    });
    const manager = createSshConnectionManager({ knownHostsFile: path.join(directory, 'trusted_hosts'), run });
    managers.add(manager);
    await expect(manager.verify(profile({ identityFile }), 'setup-a')).rejects.toMatchObject({ code: 'SSH_AUTHENTICATION_FAILED' });
    expect(manager.status(profile()).state).toBe('unverified');
  });

  it('requires native host verification for unknown proxy hosts without scanning the destination directly', async () => {
    const { manager, run } = fixture({ config: configuration().replace('proxycommand none', 'proxycommand native-user-owned-proxy') });
    await expect(manager.verify(profile(), 'setup-a')).rejects.toMatchObject({ code: 'SSH_PROXY_HOST_UNKNOWN' });
    expect(run.mock.calls.some(([program]) => program === 'ssh-keyscan')).toBe(false);
  });

  it('binds authenticated state to the complete normalized profile and clears it after failure or invalidation', async () => {
    const { manager, state } = fixture({ nativeResult: authenticated });
    await manager.verify(profile(), 'setup-a');
    for (const edited of [profile({ host: 'different-server' }), profile({ port: 2222 }),
      profile({ username: 'different-user' }), profile({ remotePort: 4000 }),
      profile({ identityFile: path.join(directory, 'another-identity') }), { ...profile(), name: 'Changed name' }]) {
      expect(manager.status(edited)).toMatchObject({ state: 'unverified', applicationConnected: false });
    }
    manager.invalidate(profile().id);
    expect(manager.status(profile()).state).toBe('unverified');
    await manager.verify(profile(), 'setup-a');
    state.nativeResult = changedHost;
    await expect(manager.verify(profile(), 'setup-a')).rejects.toMatchObject({ code: 'SSH_HOST_CHANGED' });
    expect(manager.status(profile()).state).toBe('unverified');
  });
});

describe('native host verification lifetime and ownership', () => {
  it('binds a first-use challenge to its owning setup window', async () => {
    const { manager, knownHostsFile } = fixture();
    const pending = await manager.verify(profile(), 'setup-a');
    await expect(manager.confirm(pending.challengeId, pending.fingerprints[0].fingerprint, 'setup-b')).rejects.toMatchObject({ code: 'SSH_CHALLENGE_EXPIRED' });
    await expect(fs.stat(knownHostsFile)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await manager.confirm(pending.challengeId, pending.fingerprints[0].fingerprint, 'setup-a')).state).toBe('authenticated');
  });

  it('expires first-use confirmation after two minutes', async () => {
    const { run, knownHostsFile } = fixture();
    let currentTime = 1000;
    const manager = createSshConnectionManager({ knownHostsFile, run, now: () => currentTime });
    managers.add(manager);
    const pending = await manager.verify(profile(), 'setup-a');
    currentTime += 120001;
    await expect(manager.confirm(pending.challengeId, pending.fingerprints[0].fingerprint, 'setup-a')).rejects.toMatchObject({ code: 'SSH_CHALLENGE_EXPIRED' });
    await expect(fs.stat(knownHostsFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['identityfile /native/changed/key\n', 'proxyjump new-gateway\n', 'hostname changed.example.org\n'])(
    'rejects changed native configuration %s during fingerprint review', async changed => {
      const { manager, state, knownHostsFile } = fixture();
      const pending = await manager.verify(profile(), 'setup-a');
      state.config = configuration() + changed;
      await expect(manager.confirm(pending.challengeId, pending.fingerprints[0].fingerprint, 'setup-a')).rejects.toMatchObject({ code: 'SSH_CONFIGURATION_CHANGED' });
      await expect(fs.stat(knownHostsFile)).rejects.toMatchObject({ code: 'ENOENT' });
    });

  it.each(['cancel', 'invalidate', 'replace'])('removes an old challenge after %s', async action => {
    const { manager, knownHostsFile } = fixture();
    const pending = await manager.verify(profile(), 'setup-a');
    if (action === 'cancel') manager.cancel('setup-a');
    if (action === 'invalidate') manager.invalidate(profile().id);
    if (action === 'replace') await manager.verify(profile(), 'setup-a');
    await expect(manager.confirm(pending.challengeId, pending.fingerprints[0].fingerprint, 'setup-a')).rejects.toMatchObject({ code: 'SSH_CHALLENGE_EXPIRED' });
    await expect(fs.stat(knownHostsFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('allows only one operation per setup window and releases it when canceled', async () => {
    let began;
    const started = new Promise(resolve => { began = resolve; });
    let hold = true;
    const run = vi.fn(async (_program, args, { signal }) => {
      if (args[0] === '-G') return { code: 0, stdout: configuration(), stderr: '' };
      if (!hold) return authenticated;
      began();
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
        reject(Object.assign(new Error('Canceled native process'), { code: 'SSH_CANCELLED' }));
      }, { once: true }));
    });
    const manager = createSshConnectionManager({ knownHostsFile: path.join(directory, 'trusted_hosts'), run });
    managers.add(manager);
    const pending = manager.verify(profile(), 'setup-a');
    const rejected = expect(pending).rejects.toMatchObject({ code: 'SSH_CANCELLED' });
    await started;
    await expect(manager.verify(profile(), 'setup-a')).rejects.toMatchObject({ code: 'SSH_BUSY' });
    manager.cancel('setup-a');
    await rejected;
    expect(manager.status(profile()).state).toBe('unverified');
    hold = false;
    expect((await manager.verify(profile(), 'setup-a')).state).toBe('authenticated');
  });
});

describe('atomic native host trust storage', () => {
  it('preserves existing hosts and serializes simultaneous confirmations without duplicate lines', async () => {
    const filename = path.join(directory, 'trusted_hosts');
    await fs.writeFile(filename, '# administrator note\nexisting.example ssh-ed25519 existingPublicKey\n');
    await Promise.all([addTrustedHost(filename, 'lab.example', publicKey()),
      addTrustedHost(filename, 'lab.example', publicKey()), addTrustedHost(filename, 'other.example', publicKey(2))]);
    const lines = (await fs.readFile(filename, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(4);
    expect(lines).toContain('# administrator note');
    expect(lines).toContain('existing.example ssh-ed25519 existingPublicKey');
    expect(lines.filter(line => line.startsWith('lab.example '))).toHaveLength(1);
    expect(await fs.readdir(directory)).toEqual(['trusted_hosts']);
  });

  it('rejects simultaneous different keys for the same host without replacing the winner', async () => {
    const filename = path.join(directory, 'trusted_hosts');
    const keys = [publicKey(), publicKey(2)];
    const results = await Promise.allSettled(keys.map(key => addTrustedHost(filename, 'lab.example', key)));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(result => result.status === 'rejected').reason.code).toBe('SSH_HOST_CHANGED');
    const winner = results.findIndex(result => result.status === 'fulfilled');
    expect(await fs.readFile(filename, 'utf8')).toBe(`lab.example ssh-ed25519 ${keys[winner].publicKey}\n`);
    expect(await fs.readdir(directory)).toEqual(['trusted_hosts']);
  });

  it('rejects unsafe existing trust files while cleaning up its own lock', async () => {
    const filename = path.join(directory, 'trusted_hosts');
    await fs.mkdir(filename);
    await expect(addTrustedHost(filename, 'lab.example', publicKey())).rejects.toMatchObject({ code: 'SSH_TRUST_INVALID' });
    expect(await fs.readdir(directory)).toEqual(['trusted_hosts']);
  });

  it('does not persist trust after cancellation before acquiring its lock', async () => {
    const filename = path.join(directory, 'trusted_hosts');
    const controller = new AbortController();
    controller.abort();
    await expect(addTrustedHost(filename, 'lab.example', publicKey(), { signal: controller.signal }))
      .rejects.toMatchObject({ code: 'SSH_CANCELLED' });
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it('does not persist trust when canceled while another instance holds the lock', async () => {
    const filename = path.join(directory, 'trusted_hosts');
    const lockname = filename + '.lock';
    const lock = await fs.open(lockname, 'wx');
    const controller = new AbortController();
    const pending = addTrustedHost(filename, 'lab.example', publicKey(), { signal: controller.signal });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'SSH_CANCELLED' });
    controller.abort();
    await rejected;
    await expect(fs.stat(filename)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readdir(directory)).toEqual(['trusted_hosts.lock']);
    await lock.close();
    await fs.rm(lockname);
  });
});

describe('owned system OpenSSH process lifetime', () => {
  it.each(['cancel', 'timeout'])('closes its native SSH connection after %s', async action => {
    const sockets = new Set();
    const socketErrors = [];
    const server = net.createServer(socket => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', error => socketErrors.push(error.code));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const runner = createNativeSshRunner();
    const controller = new AbortController();
    try {
      const connected = once(server, 'connection');
      const pending = runner.run('ssh', ['-F', 'none', '-T', '-oBatchMode=yes', '-oStrictHostKeyChecking=yes',
        '-oConnectTimeout=10', '-p', String(server.address().port), '127.0.0.1', 'true'],
      { signal: controller.signal, timeoutMs: action === 'timeout' ? 1000 : 8000 });
      const rejected = expect(pending).rejects.toMatchObject({ code: action === 'timeout' ? 'SSH_TIMEOUT' : 'SSH_CANCELLED' });
      const [socket] = await connected;
      const closed = new Promise(resolve => socket.once('close', resolve));
      socket.resume();
      if (action === 'cancel') controller.abort();
      await rejected;
      await closed;
      expect(sockets.size).toBe(0);
      expect(socketErrors.every(code => code === 'ECONNRESET')).toBe(true);
    } finally {
      runner.dispose();
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    }
  }, 10000);
});
