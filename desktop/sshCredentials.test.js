import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import credentials from './sshCredentials.cjs';

const { unlockNativeIdentity } = credentials;
const identityFile = 'C:\\Users\\researcher\\.ssh\\lab identity';
const launchError = 'The native SSH credential window could not open. Use ssh-add in your terminal, then retry.';

function launcher(event = 'spawn') {
  const child = new EventEmitter();
  child.unref = vi.fn();
  const spawnImpl = vi.fn(() => {
    queueMicrotask(() => child.emit(event, event === 'error' ? new Error('private native diagnostic') : undefined));
    return child;
  });
  return { child, spawnImpl };
}

// Decode only the deliberately restricted command grammar: all invocation
// arguments must be PowerShell single-quoted literals, followed by Read-Host.
function literalArguments(script) {
  const match = /^& ((?:'(?:[^'\u2018-\u201B]|''|\u2018\u2018|\u2019\u2019|\u201A\u201A|\u201B\u201B)*'\s*)+); Read-Host 'Press Enter to close'$/.exec(script);
  if (!match) throw new Error('The credential script contains executable text outside its fixed command.');
  return [...match[1].matchAll(/'((?:[^'\u2018-\u201B]|''|\u2018\u2018|\u2019\u2019|\u201A\u201A|\u201B\u201B)*)'/g)]
    .map(value => value[1].replace(/(['\u2018-\u201B])\1/g, '$1'));
}

describe('native SSH identity unlock', () => {
  it('opens an absolute system PowerShell console with an encoded native ssh-add command and one-hour expiry', async () => {
    const { spawnImpl, child } = launcher();
    const showInstructions = vi.fn();
    await expect(unlockNativeIdentity(identityFile, { platform: 'win32', spawnImpl, showInstructions })).resolves.toBe(true);
    expect(spawnImpl).toHaveBeenCalledOnce();
    const [program, args, options] = spawnImpl.mock.calls[0];
    expect(path.win32.isAbsolute(program)).toBe(true);
    expect(program).toMatch(/\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/i);
    expect(args.slice(0, 2)).toEqual(['-NoProfile', '-EncodedCommand']);
    expect(args).toHaveLength(3);
    const script = Buffer.from(args[2], 'base64').toString('utf16le');
    const command = literalArguments(script);
    expect(path.win32.isAbsolute(command[0])).toBe(true);
    expect(command[0]).toMatch(/\\System32\\OpenSSH\\ssh-add\.exe$/i);
    expect(command.slice(1)).toEqual(['-t', '3600', identityFile]);
    expect(options).toEqual({ detached: true, stdio: 'ignore', windowsHide: false, shell: false });
    expect(child.unref).toHaveBeenCalledOnce();
    expect(showInstructions).not.toHaveBeenCalled();
  });

  it.each([
    "C:\\Users\\researcher's keys\\lab identity",
    "C:\\keys\\$(Write-Output 'injected'); & test",
    'C:\\keys\\$env:USERPROFILE `$(native) & semi;colon',
    "\\\\lab-storage\\keys\\team's identity",
    'C:\\keys\\researcher\u2018s identity; $(expanded)',
    'C:\\keys\\researcher\u2019s identity; $(expanded)',
    'C:\\keys\\researcher\u201As identity; $(expanded)',
    'C:\\keys\\researcher\u201Bs identity; $(expanded)',
  ])('keeps special path characters in the single literal identity argument: %s', async reference => {
    const { spawnImpl } = launcher();
    await unlockNativeIdentity(reference, { platform: 'win32', spawnImpl });
    const script = Buffer.from(spawnImpl.mock.calls[0][1][2], 'base64').toString('utf16le');
    const command = literalArguments(script);
    expect(command).toHaveLength(4);
    expect(command[3]).toBe(reference);
  });

  it('handles native spawn failure with safe recovery instructions and no private diagnostic echo', async () => {
    const { spawnImpl, child } = launcher('error');
    const pending = unlockNativeIdentity(identityFile, { platform: 'win32', spawnImpl });
    await expect(pending).rejects.toThrow(launchError);
    await expect(pending).rejects.not.toThrow(/private native diagnostic/);
    expect(child.unref).not.toHaveBeenCalled();
  });

  it('handles a synchronous launcher failure through the same safe error', async () => {
    const spawnImpl = vi.fn(() => { throw new Error('private native diagnostic'); });
    await expect(unlockNativeIdentity(identityFile, { platform: 'win32', spawnImpl })).rejects.toThrow(launchError);
  });

  it.each(['linux', 'darwin'])('shows native agent instructions on %s without starting a process', async platform => {
    const spawnImpl = vi.fn();
    const showInstructions = vi.fn(async () => undefined);
    await expect(unlockNativeIdentity('/home/researcher/.ssh/lab identity', { platform, spawnImpl, showInstructions })).resolves.toBe(true);
    expect(spawnImpl).not.toHaveBeenCalled();
    expect(showInstructions).toHaveBeenCalledWith(expect.objectContaining({ type: 'info', title: 'Unlock your SSH identity' }));
    expect(showInstructions.mock.calls[0][0].detail).toMatch(/Run ssh-add.*Passphrases remain with OpenSSH/);
    expect(JSON.stringify(showInstructions.mock.calls)).not.toContain('/home/researcher/.ssh/lab identity');
  });

  it.each(['relative-identity', '', 'C:\\keys\\identity\0file', 'C:\\keys\\identity\nfile', 'C:\\keys\\identity\rfile', 42])(
    'rejects an invalid native identity reference without launching', async reference => {
      const spawnImpl = vi.fn(), showInstructions = vi.fn();
      await expect(unlockNativeIdentity(reference, { platform: 'win32', spawnImpl, showInstructions })).rejects.toThrow(/Choose an identity reference/);
      expect(spawnImpl).not.toHaveBeenCalled();
      expect(showInstructions).not.toHaveBeenCalled();
    });
});
