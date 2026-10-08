import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import routing from './sshRouting.cjs';
import connections from './sshConnection.cjs';

const { createManagedRouteConfiguration } = routing;
const { parseSshConfiguration, systemExecutable } = connections;
const windowsOpenSsh = process.platform === 'win32' && fsSync.existsSync(systemExecutable('ssh'));
function nativeCommand(program, args) {
  const result = spawnSync(program, args, { windowsHide: true, shell: false, encoding: 'utf8', timeout: 10000, maxBuffer: 65536 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('Native account-binding fixture failed: ' + result.stderr);
  return result.stdout;
}
function ownedFixturePath(directory) {
  if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir())
    || !path.basename(directory).startsWith('traceomics-native-accounts-')) throw new Error('Unsafe native account fixture cleanup.');
  return directory;
}
describe('actual Windows OpenSSH native route account binding', () => {
  it.skipIf(!windowsOpenSsh)('preserves domain, UPN and quoted accounts while encoding IPv6 and native file paths safely', async () => {
    const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'traceomics-native-accounts-'));
    const directory = path.join(fixtureRoot, 'Native configuration with spaces');
    await fs.mkdir(directory, { mode: 0o700 });
    const nativeConfigFile = path.join(directory, 'Original native policy');
    const aclHelper = path.join(directory, 'private-fixture-config.ps1');
    try {
      // Literal independent fixtures make a quoting regression observable on
      // both sides of the actual native/managed -G comparison.
      await fs.writeFile(nativeConfigFile, [
        'Host win_domain', '  HostName 2001:db8::23', '  Port 22023', '  User "DOMAIN\\\\researcher"',
        'Host win_upn', '  HostName ::1', '  Port 22024', '  User researcher@lab.example.org',
        'Host win_quote', '  HostName [::1]', '  Port 22025', '  User "lab\\\\quoted\\"researcher"',
        'Host native_gate', '  HostName ::1', '  Port 22022', '  User gatekeeper@lab.example.org',
        'Host *', '  IdentityFile "C:/Native identity references/research key"',
        '  GlobalKnownHostsFile none', '  UserKnownHostsFile none',
      ].join('\n') + '\n', { mode: 0o600 });
      await fs.writeFile(aclHelper, [
        'param([string]$NativeConfig, [string]$ManagedConfig)', "$ErrorActionPreference = 'Stop'",
        '$fixtureOwner = [System.Security.Principal.WindowsIdentity]::GetCurrent().User',
        '$fixtureAcl = [System.Security.AccessControl.FileSecurity]::new()',
        '$fixtureAcl.SetOwner($fixtureOwner)', '$fixtureAcl.SetAccessRuleProtection($true, $false)',
        "foreach ($fixtureSid in @($fixtureOwner.Value, 'S-1-5-18', 'S-1-5-32-544')) {",
        "  $fixtureAcl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]::new($fixtureSid), 'FullControl', 'Allow'))",
        '}', '[System.IO.File]::SetAccessControl($NativeConfig, $fixtureAcl)',
        '[System.IO.File]::SetAccessControl($ManagedConfig, $fixtureAcl)',
      ].join('\n') + '\n');
      const nativePolicy = await fs.readFile(nativeConfigFile, 'utf8');
      const resolved = (filename, alias) => parseSshConfiguration(nativeCommand(systemExecutable('ssh'), ['-F', filename, '-G', alias]));
      const gateProfile = { ssh: { host: 'native_gate' } }, gate = resolved(nativeConfigFile, gateProfile.ssh.host);
      for (const [alias, user, host] of [
        ['win_domain', 'DOMAIN\\researcher', '2001:db8::23'],
        ['win_upn', 'researcher@lab.example.org', '::1'],
        ['win_quote', 'lab\\quoted"researcher', '::1'],
      ]) {
        const original = resolved(nativeConfigFile, alias);
        expect(original.user).toBe(user);
        const managed = await createManagedRouteConfiguration({ directory, profile: { ssh: { host: alias } },
          configuration: original, route: [{ profile: gateProfile, configuration: gate }],
          executable: systemExecutable('ssh'), nativeConfigFile });
        nativeCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', aclHelper,
          '-NativeConfig', nativeConfigFile, '-ManagedConfig', managed]);
        const after = resolved(managed, alias), managedGate = resolved(managed, gateProfile.ssh.host);
        expect(after).toMatchObject({ user: original.user, hostname: host, port: original.port,
          identityfile: original.identityfile, stricthostkeychecking: 'true', forwardagent: 'no' });
        expect(managedGate).toMatchObject({ user: gate.user, hostname: gate.hostname, port: gate.port, identityfile: gate.identityfile });
        expect(after.proxycommand).toContain('[' + host + ']:' + original.port);
      }
      expect(await fs.readFile(nativeConfigFile, 'utf8')).toBe(nativePolicy);
    } finally {
      await fs.rm(ownedFixturePath(fixtureRoot), { recursive: true, force: true });
    }
  }, 15000);
});
