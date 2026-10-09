import { describe, expect, it, vi } from 'vitest';
import config from './desktopConfig.cjs';

const { normalizeTargetProfile, normalizeTargetSettings, profileForServerUrl,
  targetServiceIdentity, targetSessionPartition, verifyServerConnection } = config;
const local = (endpoint = 'http://localhost:3000') => ({ id: 'local-test', name: 'Local analysis', kind: 'local', endpoint });
const ssh = () => ({ id: 'ssh-test', name: 'Lab compute', kind: 'ssh',
  ssh: { host: 'compute.example.org', username: 'researcher', port: 22, remoteHost: '127.0.0.1', remotePort: 3000 } });

describe('execution target profiles', () => {
  it('migrates the legacy URL into a selected named profile without copying unrelated fields', () => {
    const settings = normalizeTargetSettings({ serverUrl: 'https://analysis.example.org/', obsoleteToken: 'do-not-copy' });
    expect(settings).toEqual({ schemaVersion: 1, selectedProfileId: settings.profiles[0].id,
      profiles: [expect.objectContaining({ name: 'Saved server', kind: 'https', endpoint: 'https://analysis.example.org' })] });
    expect(JSON.stringify(settings)).not.toContain('do-not-copy');
    expect(normalizeTargetSettings(settings)).toEqual(settings);
  });

  it('normalizes service identity while isolating different loopback ports and service paths', () => {
    expect(targetSessionPartition(local('http://LOCALHOST:3000/'))).toBe(targetSessionPartition(local()));
    expect(targetSessionPartition(local())).not.toBe(targetSessionPartition(local('http://localhost:3001')));
    expect(targetSessionPartition(local())).not.toBe(targetSessionPartition(local('http://localhost:3000/other-service')));
    expect(targetSessionPartition({ ...local(), id: 'other-name', name: 'Same project service' })).toBe(targetSessionPartition(local()));
    expect(targetSessionPartition(local())).toMatch(/^persist:traceomics-service-[a-f0-9]{64}$/);
  });

  it('separates SSH identities without relying on temporary local tunnel ports', () => {
    expect(targetServiceIdentity(ssh())).toBe('ssh:researcher@compute.example.org:22/127.0.0.1:3000');
    expect(targetSessionPartition(ssh())).not.toBe(targetSessionPartition({ ...ssh(), ssh: { ...ssh().ssh, username: 'other-user' } }));
    expect(normalizeTargetProfile(ssh())).not.toHaveProperty('endpoint');
  });

  it('accepts only documented nonsecret configuration fields', () => {
    for (const field of ['password', 'token', 'privateKey', 'command', 'proxyCommand']) {
      expect(() => normalizeTargetProfile({ ...ssh(), [field]: 'sensitive' })).toThrow(/documented connection settings/);
      expect(() => normalizeTargetProfile({ ...ssh(), ssh: { ...ssh().ssh, [field]: 'sensitive' } })).toThrow(/documented connection settings/);
    }
    expect(() => normalizeTargetProfile({ ...ssh(), identityFile: 'C:\\Users\\researcher\\.ssh\\id_ed25519' })).toThrow(/documented connection settings/);
    expect(() => normalizeTargetProfile({ ...local(), endpoint: 'https://user:password@example.org' })).toThrow(/credentials/);
    expect(() => normalizeTargetProfile({ ...ssh(), ssh: { ...ssh().ssh, host: '-oProxyCommand=unsafe' } })).toThrow(/hostname/);
    expect(() => normalizeTargetProfile({ ...ssh(), ssh: { ...ssh().ssh, username: 'user; command' } })).toThrow(/username/);
  });

  it('stores only an absolute native identity reference without copying credentials', () => {
    for (const identityFile of ['C:\\Users\\researcher\\.ssh\\lab key', '/home/researcher/.ssh/id_ed25519']) {
      const profile = normalizeTargetProfile({ ...ssh(), ssh: { ...ssh().ssh, identityFile } });
      expect(profile.ssh.identityFile).toBe(identityFile);
      expect(Object.keys(profile.ssh).sort()).toEqual(['host', 'identityFile', 'port', 'remoteHost', 'remotePort', 'username']);
    }
    for (const identityFile of ['id_ed25519', '~/.ssh/id_ed25519', 'C:\\keys\\id\n-oProxyCommand=invalid', 42]) {
      expect(() => normalizeTargetProfile({ ...ssh(), ssh: { ...ssh().ssh, identityFile } })).toThrow(/native file picker/);
    }
  });

  it('leaves an omitted SSH port and username to native OpenSSH configuration', () => {
    for (const port of ['', undefined, null]) {
      const profile = normalizeTargetProfile({ ...ssh(), ssh: { ...ssh().ssh, port, username: '' } });
      expect(profile.ssh).not.toHaveProperty('port');
      expect(profile.ssh).not.toHaveProperty('username');
      expect(targetServiceIdentity(profile)).toBe('ssh:@compute.example.org:config/127.0.0.1:3000');
      expect(normalizeTargetProfile(profile)).toEqual(profile);
    }
    expect(normalizeTargetProfile(ssh()).ssh.port).toBe(22);
  });

  it('validates target type, profile names, and SSH ports', () => {
    expect(() => normalizeTargetProfile({ ...local(), endpoint: 'https://remote.example.org' })).toThrow(/loopback/);
    expect(() => normalizeTargetProfile({ ...local(), kind: 'https' })).toThrow(/HTTPS/);
    expect(() => normalizeTargetProfile({ ...local(), name: '\ninvalid' })).toThrow(/target name/);
    expect(() => normalizeTargetProfile({ ...ssh(), ssh: { ...ssh().ssh, port: 65536 } })).toThrow(/SSH port/);
    expect(() => normalizeTargetProfile({ ...ssh(), endpoint: 'http://localhost:3000' })).toThrow(/local tunnel address/);
  });

  it('rejects unknown versions, duplicate profiles, and missing selected targets', () => {
    expect(() => normalizeTargetSettings({ schemaVersion: 2, profiles: [] })).toThrow(/not supported/);
    expect(() => normalizeTargetSettings({ schemaVersion: 1, profiles: [local(), local()] })).toThrow(/unique/);
    expect(() => normalizeTargetSettings({ schemaVersion: 1, selectedProfileId: 'missing', profiles: [local()] })).toThrow(/no longer present/);
    expect(normalizeTargetSettings(null)).toEqual({ schemaVersion: 1, selectedProfileId: null, profiles: [] });
    expect(profileForServerUrl('http://localhost:3000')).toMatchObject({ kind: 'local', endpoint: 'http://localhost:3000' });
  });

  it('rejects redirects during the service identity check', async () => {
    await expect(verifyServerConnection('https://analysis.example.org', { fetchImpl: async (_url, options) => {
      expect(options.redirect).toBe('error');
      throw new Error('redirected elsewhere');
    } })).rejects.toThrow(/could not reach/);
  });

  it('rejects a native compatibility response over 1 KiB before accepting the service', async () => {
    const body = JSON.stringify({ product: 'TraceOmics', serviceApiVersion: 1, minimumClientApiVersion: 1, details: 'oversized-private-diagnostic'.repeat(1024) });
    const pending = verifyServerConnection('https://analysis.example.org', {
      fetchImpl: async () => new Response(body, { headers: { 'Content-Type': 'application/json' } }),
    });
    await expect(pending).rejects.toThrow(/TraceOmics/);
    await expect(pending).rejects.not.toThrow(/oversized-private-diagnostic/);
  });

  it('retains the connection deadline while reading a trickling response body', async () => {
    const encoder = new TextEncoder();
    let stopped = false, timer;
    const chunks = ['{"product":"TraceOmics",', '"serviceApiVersion":1,', '"minimumClientApiVersion":1}'];
    const cancel = vi.fn(() => { stopped = true; clearTimeout(timer); });
    const body = new ReadableStream({
      async pull(controller) {
        await new Promise(resolve => { timer = setTimeout(resolve, 50); });
        if (stopped) return;
        controller.enqueue(encoder.encode(chunks.shift()));
        if (!chunks.length) controller.close();
      },
      cancel,
    });
    try {
      await expect(verifyServerConnection('https://analysis.example.org', {
        timeoutMs: 20, fetchImpl: async () => new Response(body),
      })).rejects.toThrow(/TraceOmics/);
      expect(cancel).toHaveBeenCalled();
    } finally { stopped = true; clearTimeout(timer); }
  });

  it('reports malformed native response JSON without echoing its contents', async () => {
    const pending = verifyServerConnection('https://analysis.example.org', {
      fetchImpl: async () => new Response('private-service-error{bad-json'),
    });
    await expect(pending).rejects.toThrow(/valid TraceOmics compatibility response/);
    await expect(pending).rejects.not.toThrow(/private-service-error/);
  });
});
