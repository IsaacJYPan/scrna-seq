'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');

const LAUNCH_ERROR = 'The native SSH credential window could not open. Use ssh-add in your terminal, then retry.';
const INSTRUCTIONS = {
  type: 'info', title: 'Unlock your SSH identity',
  message: 'Load the identity through your native SSH agent.',
  detail: 'Run ssh-add in your terminal with the selected identity file, then retry SSH verification. Passphrases remain with OpenSSH and never enter this application.',
};

async function showNativeInstructions(options) {
  await require('electron').dialog.showMessageBox(options);
}

async function unlockNativeIdentity(identityFile, { platform = process.platform,
  spawnImpl = spawn, showInstructions = showNativeInstructions } = {}) {
  if (typeof identityFile !== 'string' || !identityFile || identityFile.length > 4096
      || /[\0\r\n]/.test(identityFile)
      || !(path.isAbsolute(identityFile) || path.win32.isAbsolute(identityFile))) {
    throw new Error('Choose an identity reference first.');
  }
  if (platform !== 'win32') {
    await showInstructions({ ...INSTRUCTIONS });
    return true;
  }

  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const powershell = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const sshAdd = path.win32.join(systemRoot, 'System32', 'OpenSSH', 'ssh-add.exe');
  // PowerShell also treats typographic single quotes as string delimiters.
  const quote = value => "'" + value.replace(/['\u2018-\u201B]/g, character => character + character) + "'";
  const script = `& ${quote(sshAdd)} '-t' '3600' ${quote(identityFile)}; Read-Host 'Press Enter to close'`;
  await new Promise((resolve, reject) => {
    let terminal;
    try {
      terminal = spawnImpl(powershell, ['-NoProfile', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
        { detached: true, stdio: 'ignore', windowsHide: false, shell: false });
    } catch { reject(new Error(LAUNCH_ERROR)); return; }
    terminal.once('error', () => reject(new Error(LAUNCH_ERROR)));
    terminal.once('spawn', () => { terminal.unref(); resolve(); });
  });
  return true;
}

module.exports = { unlockNativeIdentity };
