import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import routing from './sshRouting.cjs';
import connections from './sshConnection.cjs';
import desktopConfig from './desktopConfig.cjs';

const { jumpSpecifications, commandArgument, diagnosticStage, configValue } = routing;
const { createSshConnectionManager } = connections;
const artifactRoot = path.resolve('playwright/report');
let directory;
const managers = new Set();
const profile = { id: 'lab', name: 'Lab compute', kind: 'ssh',
  ssh: { host: 'lab_compute', remoteHost: '127.0.0.1', remotePort: 3000 } };
const good = { code: 0, stdout: '', stderr: '' };
const nativeUnknown = host => ({ code: 255, stdout: '', stderr: `No ED25519 host key is known for [${host}]:2222 and you have requested strict checking.\nHost key verification failed.` });
function configuration(host, user, proxyjump = 'none', extra = '') {
  return `hostname ${host}\nport 2222\nuser ${user}\nproxyjump ${proxyjump}\nproxycommand none\nhostkeyalias none\nidentitiesonly yes\nidentityfile /native/${user}_identity\n${extra}`;
}
const algorithm = Buffer.from('ssh-ed25519'), size = Buffer.alloc(4), keyLength = Buffer.alloc(4);
size.writeUInt32BE(algorithm.length); keyLength.writeUInt32BE(32);
const publicBytes = Buffer.concat([size, algorithm, keyLength, Buffer.alloc(32, 7)]);
const publicKey = publicBytes.toString('base64');
const fingerprint = 'SHA256:' + createHash('sha256').update(publicBytes).digest('base64').replace(/=+$/, '');

async function fixture() {
  const state = { configs: {
    lab_compute: configuration('compute.internal', 'researcher', 'lab_gate,lab_inner'),
    lab_gate: configuration('gateway.example.org', 'gatekeeper'),
    lab_inner: configuration('inner.internal', 'inner_user'),
  }, failures: {}, traces: [], generated: [] };
  const knownHostsFile = path.join(directory, 'Private native files', 'trusted_hosts');
  const nativeConfigFile = path.join(directory, 'Native user config');
  await fs.writeFile(nativeConfigFile, '# Native user-owned fixture\n');
  const run = vi.fn(async (program, args) => {
    if (program !== 'ssh') throw new Error('Jump routes must not run keyscan or keygen.');
    if (args.includes('-G')) return { ...good, stdout: state.configs[args.at(-1)] };
    const filename = args[args.indexOf('-F') + 1];
    const contents = await fs.readFile(filename, 'utf8');
    state.generated.push({ filename, contents });
    const alias = args.includes('-N') ? args.at(-1) : args.at(-2);
    state.traces.push(alias);
    if (state.failures[alias]) return state.failures[alias];
    const trustArg = args.find(arg => arg.startsWith('-oUserKnownHostsFile='));
    if (args.includes('-N')) {
      const quarantine = trustArg.slice('-oUserKnownHostsFile='.length).replace(/^"|"$/g, '');
      await fs.writeFile(quarantine, `[compute.internal]:2222 ssh-ed25519 ${publicKey}\n`);
      return { code: 255, stdout: '', stderr: 'Permission denied (publickey).' };
    }
    if (alias !== 'lab_compute') return good;
    const trusted = trustArg && (await fs.readFile(knownHostsFile, 'utf8').catch(() => '')).includes(publicKey);
    return trusted ? good : nativeUnknown('compute.internal');
  });
  const manager = createSshConnectionManager({ knownHostsFile, run, nativeConfigFile });
  managers.add(manager);
  return { state, manager, run, knownHostsFile, nativeConfigFile };
}
beforeEach(async () => {
  await fs.mkdir(artifactRoot, { recursive: true });
  directory = await fs.mkdtemp(path.join(artifactRoot, 'ssh-route-unit-'));
});
afterEach(async () => {
  for (const manager of managers) manager.dispose();
  managers.clear();
  if (path.dirname(path.resolve(directory)) !== artifactRoot || !path.basename(directory).startsWith('ssh-route-unit-')) throw new Error('Unsafe route fixture cleanup.');
  await fs.rm(directory, { recursive: true, force: true });
});

describe('native SSH aliases and managed bastion routes', () => {
  it('accepts ordinary SSH aliases while keeping remote service addresses constrained to hostnames and IPs', () => {
    expect(desktopConfig.normalizeTargetProfile(profile).ssh.host).toBe('lab_compute');
    for (const host of ['-F', 'host; command', 'user@host', 'host\nProxyCommand bad']) {
      expect(() => desktopConfig.normalizeTargetProfile({ ...profile, ssh: { ...profile.ssh, host } })).toThrow();
    }
    expect(() => desktopConfig.normalizeTargetProfile({ ...profile, ssh: { ...profile.ssh, remoteHost: 'service_alias' } })).toThrow();
    expect(() => desktopConfig.normalizeTargetProfile({ ...profile, ssh: { ...profile.ssh, configFile: '/native/config' } })).toThrow();
  });
  it('parses native per-hop accounts and ports with a bounded route and rejects command fragments', () => {
    expect(jumpSpecifications('gate_user@lab_gate:2224,inner@[::1]:2200')).toEqual([
      { host: 'lab_gate', username: 'gate_user', port: 2224 }, { host: '[::1]', username: 'inner', port: 2200 },
    ]);
    for (const value of ['-oProxyCommand=bad', 'host;bad', 'a:0', 'a:65536', 'a,b,c,d,e', 'a\nHost *', 'a,']) {
      expect(() => jumpSpecifications(value)).toThrow();
    }
    expect(() => commandArgument('C:/percent%/path', 'win32')).toThrow();
    expect(commandArgument('C:/Native user/path', 'win32')).toBe('"C:/Native user/path"');
    expect(commandArgument("/native/user's path", 'linux')).toBe("'/native/user'\"'\"'s path'");
  });
  it('quotes native config values while preserving backslashes and literal quotes in account names', () => {
    expect(configValue('DOMAIN\\researcher')).toBe('"DOMAIN\\\\researcher"');
    expect(configValue('account"researcher')).toBe('"account\\"researcher"');
    expect(configValue('DOMAIN\\account"researcher')).toBe('"DOMAIN\\\\account\\"researcher"');
    for (const value of ['account\nProxyCommand bad', 'account\rHost *', 'account\0']) expect(() => configValue(value)).toThrow();
  });
  it('verifies each native identity before discovering the destination through the actual route, then cleans transient policies', async () => {
    const { manager, state, run, knownHostsFile, nativeConfigFile } = await fixture();
    const pending = await manager.verify(profile, 'setup');
    expect(pending).toMatchObject({ state: 'verify-host', route: ['lab_gate', 'lab_inner', 'lab_compute'],
      fingerprints: [{ algorithm: 'ssh-ed25519', fingerprint }] });
    expect(state.traces).toEqual(['lab_gate', 'lab_inner', 'lab_compute', 'lab_compute', 'lab_compute']);
    expect(run.mock.calls.every(([program]) => program === 'ssh')).toBe(true);
    const generated = state.generated[0].contents;
    for (const setting of ['StrictHostKeyChecking yes', 'ForwardAgent no', 'ControlMaster no', 'PermitLocalCommand no']) expect(generated).toContain(setting);
    expect(generated).toContain('Include "' + nativeConfigFile.replace(/\\/g, '/') + '"');
    expect(generated).not.toContain('IdentityFile');
    expect(generated).not.toContain('UserKnownHostsFile');
    expect(generated).toContain('ProxyCommand none');
    expect(generated.match(/ProxyCommand /g)).toHaveLength(3);
    await expect(fs.stat(knownHostsFile)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(state.generated[0].filename)).rejects.toMatchObject({ code: 'ENOENT' });
    const status = await manager.confirm(pending.challengeId, fingerprint, 'setup');
    expect(status.stages).toEqual([
      { kind: 'jump', alias: 'lab_gate', host: 'gateway.example.org', port: 2222, username: 'gatekeeper', state: 'authenticated' },
      { kind: 'jump', alias: 'lab_inner', host: 'inner.internal', port: 2222, username: 'inner_user', state: 'authenticated' },
      { kind: 'destination', alias: 'lab_compute', host: 'compute.internal', port: 2222, username: 'researcher', state: 'authenticated' },
    ]);
    expect(status.applicationConnected).toBe(false);
    expect(JSON.stringify(status)).not.toContain('_identity');
    expect(await fs.readFile(nativeConfigFile, 'utf8')).toBe('# Native user-owned fixture\n');
    for (const trace of state.generated) await expect(fs.stat(trace.filename)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it.each([
    ['lab_gate', nativeUnknown('gateway.example.org'), 'SSH_PROXY_HOST_UNKNOWN', 1],
    ['lab_inner', { code: 255, stderr: 'inner_user@inner.internal: Permission denied (publickey).' }, 'SSH_AUTHENTICATION_FAILED', 2],
    ['lab_gate', { code: 255, stderr: 'Host key for [gateway.example.org]:2222 has changed.\nREMOTE HOST IDENTIFICATION HAS CHANGED' }, 'SSH_HOST_CHANGED', 1],
    ['lab_gate', { code: 255, stderr: 'ssh: connect to host gateway.example.org port 2222: Connection refused' }, 'SSH_UNREACHABLE', 1],
  ])('stops at the failing native stage %s without scanning or offering destination trust', async (alias, result, code, index) => {
    const { manager, state, knownHostsFile } = await fixture();
    state.failures[alias] = result;
    await expect(manager.verify(profile, 'setup')).rejects.toMatchObject({ code, stage: { kind: 'jump', alias, index } });
    expect(state.traces).not.toContain('lab_compute');
    expect(manager.status(profile).state).toBe('unverified');
    await expect(fs.stat(knownHostsFile)).rejects.toMatchObject({ code: 'ENOENT' });
    for (const trace of state.generated) await expect(fs.stat(trace.filename)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('binds destination trust to every resolved jump policy and never writes trust after a native config edit', async () => {
    const { manager, state, knownHostsFile } = await fixture();
    const pending = await manager.verify(profile, 'setup');
    state.configs.lab_inner += 'identityagent /native/different-agent\n';
    await expect(manager.confirm(pending.challengeId, fingerprint, 'setup')).rejects.toMatchObject({ code: 'SSH_CONFIGURATION_CHANGED' });
    await expect(fs.stat(knownHostsFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('removes the owned route policy on cancellation before a pending native check finishes stopping', async () => {
    const { manager, run } = await fixture();
    const originalRun = run.getMockImplementation();
    let policy, nativePending = false;
    run.mockImplementation(async (program, args, options) => {
      if (args.includes('-G')) return originalRun(program, args, options);
      policy = args[args.indexOf('-F') + 1]; nativePending = true;
      return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => {
        setTimeout(() => { nativePending = false; reject(Object.assign(new Error('SSH verification was canceled.'), { code: 'SSH_CANCELLED' })); }, 100);
      }, { once: true }));
    });
    const check = manager.verify(profile, 'settings');
    const rejection = expect(check).rejects.toMatchObject({ code: 'SSH_CANCELLED' });
    await vi.waitFor(() => expect(nativePending).toBe(true));
    manager.cancel('settings');
    await expect(fs.stat(policy)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(nativePending).toBe(true);
    await rejection;
  });
  it('expands a first alias’s native jump chain but ignores a later explicit alias’s proxy settings', async () => {
    const { manager, state } = await fixture();
    state.configs.lab_compute = configuration('compute.internal', 'researcher', 'lab_inner,lab_last');
    state.configs.lab_inner = configuration('inner.internal', 'inner_user', 'lab_gate');
    state.configs.lab_last = configuration('last.internal', 'last_user', 'unrelated_native_proxy');
    const pending = await manager.verify(profile, 'setup');
    expect(pending.route).toEqual(['lab_gate', 'lab_inner', 'lab_last', 'lab_compute']);
    expect(state.traces.slice(0, 3)).toEqual(['lab_gate', 'lab_inner', 'lab_last']);
  });
  it('rejects cycles, duplicate aliases and unsupported opaque first-hop proxies before any network check', async () => {
    const { manager, state } = await fixture();
    state.configs.lab_inner = configuration('inner.internal', 'inner_user', 'lab_compute');
    state.configs.lab_compute = configuration('compute.internal', 'researcher', 'lab_inner');
    await expect(manager.verify(profile, 'setup')).rejects.toMatchObject({ code: 'SSH_ROUTE_INVALID' });
    state.configs.lab_compute = configuration('compute.internal', 'researcher', 'lab_gate,lab_gate');
    await expect(manager.verify(profile, 'setup')).rejects.toMatchObject({ code: 'SSH_ROUTE_INVALID' });
    state.configs.lab_compute = configuration('compute.internal', 'researcher', 'lab_gate,LAB_GATE');
    await expect(manager.verify(profile, 'setup')).rejects.toMatchObject({ code: 'SSH_ROUTE_INVALID' });
    state.configs.lab_compute = configuration('compute.internal', 'researcher', 'lab_gate');
    state.configs.lab_gate = configuration('gateway.example.org', 'gatekeeper').replace('proxycommand none', 'proxycommand native-proxy');
    await expect(manager.verify(profile, 'setup')).rejects.toMatchObject({ code: 'SSH_ROUTE_UNSUPPORTED' });
    expect(state.traces).toEqual([]);
  });
  it('bounds nested alias configuration discovery before resolving more than four jump hosts', async () => {
    const { manager, state, run } = await fixture();
    state.configs.lab_compute = configuration('compute.internal', 'researcher', 'jump1');
    for (let index = 1; index <= 6; index++) state.configs['jump' + index] = configuration('jump' + index + '.internal', 'jump_user', 'jump' + (index + 1));
    await expect(manager.verify(profile, 'setup')).rejects.toMatchObject({ code: 'SSH_ROUTE_LIMIT' });
    expect(run.mock.calls.filter(([, args]) => args.includes('-G'))).toHaveLength(5);
    expect(state.traces).toEqual([]);
  });
  it('attributes an earlier hop’s actual diagnostics when its key changes during the destination attempt', async () => {
    const { manager, state } = await fixture();
    state.failures.lab_compute = { code: 255, stderr: 'Host key for [inner.internal]:2222 has changed.\nREMOTE HOST IDENTIFICATION HAS CHANGED\nkex_exchange_identification: Connection closed by remote host' };
    await expect(manager.verify(profile, 'setup')).rejects.toMatchObject({ code: 'SSH_HOST_CHANGED', stage: { kind: 'jump', alias: 'lab_inner', index: 2 } });
    expect(state.traces).toEqual(['lab_gate', 'lab_inner', 'lab_compute']);
  });
  it('attributes a late jump authentication failure before probing an unrelated encrypted destination key', async () => {
    const { manager, state, run } = await fixture();
    const identityFile = path.join(directory, 'Encrypted destination identity');
    await fs.writeFile(identityFile, 'Opaque native identity fixture');
    const selected = { ...profile, ssh: { ...profile.ssh, identityFile } };
    const originalRun = run.getMockImplementation();
    run.mockImplementation(async (program, args, options) => {
      if (program === 'ssh-keygen') return { code: 255, stdout: '', stderr: 'incorrect passphrase supplied to decrypt private key' };
      return originalRun(program, args, options);
    });
    state.failures.lab_compute = { code: 255, stderr: 'inner_user@inner.internal: Permission denied (publickey).\nkex_exchange_identification: Connection closed by remote host' };
    await expect(manager.verify(selected, 'setup')).rejects.toMatchObject({ code: 'SSH_AUTHENTICATION_FAILED', stage: { kind: 'jump', alias: 'lab_inner', index: 2 } });
    expect(run.mock.calls.filter(([program]) => program === 'ssh-keygen')).toEqual([]);
    expect(state.traces).toEqual(['lab_gate', 'lab_inner', 'lab_compute']);
  });
  it('never mistakes an authenticated proxy banner for the failing destination or exposes diagnostic paths', () => {
    const nodes = [{ profile: { ssh: { host: 'gate' } }, configuration: { hostname: 'gate.internal', user: 'gate_user', port: '2222' } },
      { profile, configuration: { hostname: 'compute.internal', user: 'researcher', port: '2222' } }];
    expect(diagnosticStage('Authenticated to gate.internal\nssh: connect to host compute.internal port 2222: Connection refused', nodes))
      .toMatchObject({ index: null, node: { profile } });
    expect(diagnosticStage('debug1: /native/secret/path\nkex_exchange_identification: Connection closed by remote host', nodes)).toBeNull();
  });
});
