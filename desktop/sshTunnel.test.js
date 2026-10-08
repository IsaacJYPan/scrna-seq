import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import tunnel from './sshTunnel.cjs';
import snapshots from './sshConfigurationSnapshot.cjs';
import connections from './sshConnection.cjs';
import config from './desktopConfig.cjs';

const cleanups = [];
const profile = { id: 'lab', name: 'Lab', kind: 'ssh', endpoint: 'https://analysis.example.org',
  ssh: { host: 'lab_compute', remoteHost: '127.0.0.1', remotePort: 8443 } };
afterEach(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); cleanups.length = 0; });
async function directory() {
  const base = path.resolve('playwright/report'); await fs.mkdir(base, { recursive: true });
  const result = await fs.mkdtemp(path.join(base, 'ssh-tunnel-unit-'));
  cleanups.push(() => fs.rm(result, { recursive: true, force: true })); return result;
}
async function fixtureServer(callback) {
  const sockets = new Set();
  const server = net.createServer(socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); callback(socket); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  return server.address().port;
}
async function proxyRequest(port, text) {
  const socket = net.connect(port, '127.0.0.1');
  const result = await new Promise((resolve, reject) => { socket.on('error', reject); socket.once('data', chunk => resolve(chunk.toString())); socket.once('connect', () => socket.write(text)); });
  socket.destroy(); return result;
}
function fakeSpawn(handler) {
  const children = [];
  const implementation = vi.fn((_program, args) => {
    const child = new EventEmitter(); child.stderr = new PassThrough(); child.exitCode = null; child.pid = null; child.kill = vi.fn();
    children.push(child); setImmediate(() => handler(child, args)); return child;
  });
  cleanups.push(() => { for (const child of children) { child.exitCode = 0; child.emit('close', 0); } });
  return implementation;
}
function lease() { return { profile, args: ['-F', '/owned/config', '-oStrictHostKeyChecking=yes'], configuration: { routeNodes: [] } }; }
const testTunnel = (value, options) => tunnel.createSshTunnel(value, { verifyListener: async () => true, ...options });

describe('managed HTTPS SSH transport', () => {
  it('accepts the original HTTPS authority and isolates resolved native account, host, endpoint and remote port', () => {
    expect(config.normalizeTargetProfile(profile)).toEqual(profile);
    for (const endpoint of ['http://localhost:8443', 'https://user:password@analysis.example.org', 'https://analysis.example.org?token=x']) expect(() => config.normalizeTargetProfile({ ...profile, endpoint })).toThrow();
    expect(() => config.normalizeTargetProfile({ ...profile, ssh: { ...profile.ssh, remoteHost: 'r.internal' } })).toThrow(/loopback/);
    const resolved = { host: 'compute.internal', username: 'DOMAIN\\researcher', port: 2222 };
    expect(config.targetSessionPartition(profile, resolved)).not.toBe(config.targetSessionPartition(profile));
    for (const override of [{ host: 'other.internal' }, { username: 'other' }, { port: 2223 }]) expect(config.targetSessionPartition(profile, { ...resolved, ...override })).not.toBe(config.targetSessionPartition(profile, resolved));
    expect(config.targetSessionPartition(profile, resolved)).not.toBe(config.targetSessionPartition({ ...profile, endpoint: 'https://other.example.org' }, resolved));
    expect(config.targetSessionPartition(profile, resolved)).not.toBe(config.targetSessionPartition({ ...profile, ssh: { ...profile.ssh, remotePort: 8444 } }, resolved));
  });
  it('waits for actual authentication and the owned listener, then remains alive beyond its startup deadline', async () => {
    const spawn = fakeSpawn(child => child.stderr.write('Authenticated to compute.internal.\nLocal forwarding listening on 127.0.0.1 port 49100.\n'));
    const lost = vi.fn(); const result = await testTunnel(lease(), { spawnImpl: spawn, allocatePort: async () => 49100, startupMs: 20, onLost: lost });
    await new Promise(resolve => setTimeout(resolve, 35));
    expect(result.port).toBe(49100); expect(lost).not.toHaveBeenCalled();
    const args = spawn.mock.calls[0][1];
    expect(args.filter(value => value === '-L')).toHaveLength(1);
    expect(args).toContain('127.0.0.1:49100:[127.0.0.1]:8443');
    expect(args).toContain('-oExitOnForwardFailure=yes'); expect(args).toContain('-oServerAliveCountMax=2');
    expect(spawn.mock.calls[0][2]).toMatchObject({ shell: false, windowsHide: true });
  });
  it('never declares connection from a listener before SSH authentication', async () => {
    const spawn = fakeSpawn(child => child.stderr.write('Local forwarding listening on 127.0.0.1 port 49100.\n'));
    await expect(testTunnel(lease(), { spawnImpl: spawn, allocatePort: async () => 49100, startupMs: 15 })).rejects.toMatchObject({ code: 'SSH_TIMEOUT' });
  });
  it('retries bounded local port conflicts and does not retry authentication failures', async () => {
    let attempt = 0;
    const spawn = fakeSpawn(child => { if (++attempt < 3) child.stderr.write('bind [127.0.0.1]:49100: Address already in use\n'); else child.stderr.write('Authenticated to compute.internal.\nLocal forwarding listening on 127.0.0.1 port 49100.\n'); });
    await testTunnel(lease(), { spawnImpl: spawn, allocatePort: async () => 49100 }); expect(spawn).toHaveBeenCalledTimes(3);
    const rejected = fakeSpawn(child => { child.stderr.write('researcher@compute.internal: Permission denied (publickey).'); child.exitCode = 255; child.emit('close', 255); });
    await expect(testTunnel(lease(), { spawnImpl: rejected, allocatePort: async () => 49100 })).rejects.toMatchObject({ code: 'SSH_AUTHENTICATION_FAILED' });
    expect(rejected).toHaveBeenCalledTimes(1);
  });
  it('refuses a native readiness banner when the local listener belongs to another process', async () => {
    const spawn = fakeSpawn(child => child.stderr.write('Authenticated to compute.internal.\nLocal forwarding listening on 127.0.0.1 port 49100.\n'));
    const ownership = vi.fn(async () => false);
    await expect(testTunnel(lease(), { spawnImpl: spawn, allocatePort: async () => 49100, verifyListener: ownership })).rejects.toMatchObject({ code: 'SSH_LOCAL_PORT_CONFLICT' });
    expect(spawn).toHaveBeenCalledTimes(3); expect(ownership).toHaveBeenCalledTimes(3);
  });
  it.skipIf(process.platform !== 'win32')('checks actual Windows listener ownership before accepting a native forward', async () => {
    const port = await fixtureServer(socket => socket.resume());
    expect(await tunnel.ownsLocalListener({ port, pid: process.pid })).toBe(true);
    expect(await tunnel.ownsLocalListener({ port, pid: process.pid + 1000000 })).toBe(false);
  });
  it('reports native transport loss once with safe forwarding remediation', async () => {
    let child;
    const spawn = fakeSpawn(value => { child = value; value.stderr.write('Authenticated to compute.internal.\nLocal forwarding listening on 127.0.0.1 port 49100.\n'); });
    const lost = vi.fn(); await testTunnel(lease(), { spawnImpl: spawn, allocatePort: async () => 49100, onLost: lost });
    child.stderr.write('channel 0: open failed: administratively prohibited: open failed\n'); child.exitCode = 255; child.emit('close', 255);
    expect(lost).toHaveBeenCalledTimes(1); expect(lost.mock.calls[0][0]).toMatchObject({ code: 'SSH_FORWARD_FAILED' });
    expect(lost.mock.calls[0][0].message).not.toContain('channel 0');
  });
  it('bounds diagnostic output and supports cancellation during startup', async () => {
    const excessive = fakeSpawn(child => child.stderr.write(Buffer.alloc(270000, 65)));
    await expect(testTunnel(lease(), { spawnImpl: excessive, allocatePort: async () => 49100 })).rejects.toMatchObject({ code: 'SSH_RESPONSE_LIMIT' });
    const controller = new AbortController(); const stalled = fakeSpawn(() => controller.abort());
    await expect(testTunnel(lease(), { spawnImpl: stalled, allocatePort: async () => 49100, signal: controller.signal })).rejects.toMatchObject({ code: 'SSH_CANCELLED' });
  });
  it('forwards actual bytes only after CONNECT to the exact original authority', async () => {
    let connections = 0;
    const forwardPort = await fixtureServer(socket => { connections++; socket.on('data', data => socket.write(data)); });
    const proxy = await tunnel.createHttpsConnectProxy({ endpoint: profile.endpoint, forwardPort }); cleanups.push(() => proxy.dispose());
    for (const request of ['GET / HTTP/1.1\r\n\r\n', 'CONNECT other.example.org:443 HTTP/1.1\r\n\r\n', 'CONNECT analysis.example.org:444 HTTP/1.1\r\n\r\n', 'CONNECT user@analysis.example.org:443 HTTP/1.1\r\n\r\n']) expect(await proxyRequest(proxy.port, request)).toMatch(/405|403/);
    expect(connections).toBe(0);
    const socket = net.connect(proxy.port, '127.0.0.1'); cleanups.push(() => socket.destroy());
    const response = new Promise(resolve => socket.once('data', chunk => resolve(chunk.toString())));
    socket.write('CONNECT ANALYSIS.EXAMPLE.ORG:443 HTTP/1.1\r\nHost: analysis.example.org:443\r\n\r\n');
    expect(await response).toContain('200 Connection Established');
    const bytes = new Promise(resolve => socket.once('data', chunk => resolve(chunk.toString()))); socket.write('opaque TLS bytes'); expect(await bytes).toBe('opaque TLS bytes'); expect(connections).toBe(1);
  });
  it('bounds oversized and stalled CONNECT requests and destroys active sockets on cleanup', async () => {
    const forwardPort = await fixtureServer(socket => socket.resume());
    const proxy = await tunnel.createHttpsConnectProxy({ endpoint: profile.endpoint, forwardPort, connectTimeoutMs: 25 }); cleanups.push(() => proxy.dispose());
    expect(await proxyRequest(proxy.port, 'CONNECT analysis.example.org:443 HTTP/1.1\r\nX: ' + 'x'.repeat(17000))).toContain('431');
    const socket = net.connect(proxy.port, '127.0.0.1'); const closed = new Promise(resolve => socket.once('close', resolve)); await closed;
    const active = net.connect(proxy.port, '127.0.0.1'); active.write('CONNECT analysis.example.org:443 HTTP/1.1\r\n\r\n'); await new Promise(resolve => active.once('data', resolve));
    const activeClosed = new Promise(resolve => active.once('close', resolve)); await proxy.dispose(); await activeClosed;
  });
});

describe('private native policy snapshots', () => {
  it('preserves native account, identity and trust text while recursively removing every inherited forwarding mode', async () => {
    const dir = await directory(); const nativeFile = path.join(dir, 'Native user config'); const child = path.join(dir, 'Native included config');
    const original = 'Host lab_compute\n User DOMAIN\\researcher\n IdentityFile "C:/Native private identity"\n UserKnownHostsFile "C:/Native known hosts"\n Include "' + child.replace(/\\/g, '/') + '"\nLocalForward=1234 localhost:5432\nRemoteForward 4321 localhost:6311\nDynamicForward 1080\nClearAllForwardings yes\n';
    await fs.writeFile(nativeFile, original); await fs.writeFile(child, 'Host *\nLocalForward 9999 127.0.0.1:6311\nIdentitiesOnly yes\n');
    const copy = await snapshots.snapshotNativeConfiguration({ directory: dir, nativeConfigFile: nativeFile }); cleanups.push(() => copy.dispose());
    const text = (await Promise.all((await fs.readdir(copy.directory)).map(file => fs.readFile(path.join(copy.directory, file), 'utf8')))).join('\n');
    expect(text).not.toMatch(/LocalForward|RemoteForward|DynamicForward|ClearAllForwardings/i);
    expect(text).toContain('User DOMAIN\\researcher'); expect(text).toContain('UserKnownHostsFile "C:/Native known hosts"'); expect(text).toContain('IdentitiesOnly yes');
    expect(await fs.readFile(nativeFile, 'utf8')).toBe(original);
  });
  it('expands deterministic glob Includes and rejects cycles, token expansion, bracket globs and oversized policy', async () => {
    const dir = await directory(), nativeFile = path.join(dir, 'config');
    await fs.writeFile(path.join(dir, 'b.inc'), 'IdentityFile b\n'); await fs.writeFile(path.join(dir, 'a.inc'), 'IdentityFile a\n');
    await fs.writeFile(nativeFile, 'Include ' + dir.replace(/\\/g, '/') + '/*.inc\n');
    const copy = await snapshots.snapshotNativeConfiguration({ directory: dir, nativeConfigFile: nativeFile }); await copy.dispose();
    for (const source of ['Include "' + nativeFile.replace(/\\/g, '/') + '"\n', 'Include ${HOME}/config\n', 'Include "' + dir.replace(/\\/g, '/') + '/[ab].inc"\n', 'X'.repeat(1024 * 1024 + 1)]) {
      await fs.writeFile(nativeFile, source); await expect(snapshots.snapshotNativeConfiguration({ directory: dir, nativeConfigFile: nativeFile })).rejects.toMatchObject({ code: 'SSH_CONFIGURATION_UNSUPPORTED' });
      expect((await fs.readdir(dir)).some(name => name.startsWith('.ssh-policy-'))).toBe(false);
    }
  });
  it('retains only verified owned route files until the lease closes and preserves hop identity policy', async () => {
    const dir = await directory(); const nativeFile = path.join(dir, 'config'); await fs.writeFile(nativeFile, 'Host *\n LocalForward 1000 127.0.0.1:5432\n');
    const run = vi.fn(async (program, args) => {
      if (args.includes('-G')) return { code: 0, stdout: 'hostname compute.internal\nport 2222\nuser researcher\nproxyjump none\nproxycommand none\n', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    });
    const manager = connections.createSshConnectionManager({ knownHostsFile: path.join(dir, 'trusted'), nativeConfigFile: nativeFile, run }); cleanups.push(() => manager.dispose());
    const prepared = await manager.prepareLease(profile, 'setup');
    expect(prepared.status).toMatchObject({ host: 'compute.internal', port: 2222, username: 'researcher', applicationConnected: false });
    const text = await fs.readFile(prepared.configuration.managedConfigFile, 'utf8'); expect(text).toContain('ClearAllForwardings no'); expect(text).toContain('StrictHostKeyChecking yes');
    expect(prepared.args).not.toContain('-oClearAllForwardings=yes');
    expect(run.mock.calls.filter(([, args]) => !args.includes('-G'))[0][1]).toContain('-oClearAllForwardings=yes');
    await prepared.dispose(); expect((await fs.readdir(dir)).some(name => name.startsWith('.ssh-route-') || name.startsWith('.ssh-policy-'))).toBe(false);
  });
});
