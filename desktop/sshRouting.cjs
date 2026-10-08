'use strict';

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const { randomUUID, createHash } = require('node:crypto');

const MAX_JUMP_HOSTS = 4;
function routingError(code, message) { return Object.assign(new Error(message), { code }); }
function jumpSpecifications(value) {
  if (!value || value === 'none') return [];
  const entries = String(value).split(',');
  if (entries.length > MAX_JUMP_HOSTS) throw routingError('SSH_ROUTE_LIMIT', 'Managed SSH supports up to four jump hosts. Simplify the native ProxyJump route.');
  return entries.map(entry => {
    const match = /^(?:([a-z_][a-z0-9_.-]{0,63})@)?(\[[0-9a-f:]+\]|[a-z0-9][a-z0-9_.-]*)(?::([0-9]{1,5}))?$/i.exec(entry);
    if (!match || (match[3] && (Number(match[3]) < 1 || Number(match[3]) > 65535))) {
      throw routingError('SSH_ROUTE_INVALID', 'The native ProxyJump route contains an unsupported host, account, or port. Use ordinary SSH aliases and port settings.');
    }
    return { host: match[2], ...(match[1] ? { username: match[1] } : {}), ...(match[3] ? { port: Number(match[3]) } : {}) };
  });
}
function configValue(value) {
  if (typeof value !== 'string' || /[\r\n\0]/.test(value)) throw routingError('SSH_ROUTE_INVALID', 'The native SSH route contains an invalid setting.');
  // These are OpenSSH configuration values, not filesystem paths. Native
  // account names can contain backslashes (for example DOMAIN\\researcher).
  return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}
function nativePath(value) { return process.platform === 'win32' ? value.replace(/\\/g, '/') : value; }
function commandArgument(value, platform = process.platform) {
  const text = String(value);
  // Percent expansion belongs to OpenSSH ProxyCommand. Generated commands do
  // not accept expansion tokens or shell syntax from the renderer.
  if (/[\r\n\0%]/.test(text)) throw routingError('SSH_ROUTE_INVALID', 'This native SSH path cannot be used in a managed jump route.');
  if (platform !== 'win32') return "'" + text.replace(/'/g, "'\"'\"'") + "'";
  return '"' + text.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"';
}
async function nativeConfigurationFiles(override) {
  if (override) return [override];
  const files = [path.join(os.homedir(), '.ssh', 'config'), process.platform === 'win32'
    ? path.join(process.env.ProgramData || 'C:\\ProgramData', 'ssh', 'ssh_config') : '/etc/ssh/ssh_config'];
  const present = [];
  for (const file of files) {
    try { if ((await fs.stat(file)).isFile()) present.push(file); }
    catch (error) { if (error.code !== 'ENOENT') throw routingError('SSH_CONFIGURATION_INVALID', 'The native SSH configuration cannot be read. Review its permissions.'); }
  }
  return present;
}
const ROUTE_SAFETY = ['BatchMode yes', 'StrictHostKeyChecking yes', 'UpdateHostKeys no',
  'ControlMaster no', 'ControlPath none', 'ClearAllForwardings yes', 'ForwardAgent no',
  'ForwardX11 no', 'Tunnel no', 'PermitLocalCommand no', 'RequestTTY no',
  'RemoteCommand none', 'ConnectTimeout 8', 'ConnectionAttempts 1'];

async function createManagedRouteConfiguration({ directory, profile, configuration, route, executable, nativeConfigFile, tunnel = false }) {
  const filename = path.join(directory, '.ssh-route-' + randomUUID() + '.conf');
  const includeFiles = await nativeConfigurationFiles(nativeConfigFile);
  const nodes = [...route, { profile, configuration }];
  const safety = ROUTE_SAFETY.map(value => tunnel && value === 'ClearAllForwardings yes' ? 'ClearAllForwardings no' : value);
  const lines = ['# Temporary native route policy. Original SSH configuration remains user-owned.', 'Host *', ...safety.map(value => '  ' + value)];
  for (const [index, node] of nodes.entries()) {
    const config = node.configuration;
    lines.push('Host ' + configValue(node.profile.ssh.host.replace(/^\[|\]$/g, '')),
      '  HostName ' + configValue(config.hostname.replace(/^\[|\]$/g, '')),
      '  Port ' + config.port, '  User ' + configValue(config.user));
    if (index === 0) lines.push('  ProxyCommand none');
    else {
      const previous = nodes[index - 1];
      const args = [executable, '-F', nativePath(filename), '-T', '-v', '-oClearAllForwardings=yes', '-W',
        '[' + config.hostname.replace(/^\[|\]$/g, '') + ']:' + config.port,
        previous.profile.ssh.host.replace(/^\[|\]$/g, '')];
      lines.push('  ProxyCommand ' + args.map(value => commandArgument(value)).join(' '));
    }
  }
  lines.push('Host *', ...includeFiles.map(file => '  Include ' + configValue(nativePath(file))));
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.writeFile(filename, lines.join('\n') + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return filename;
}
function routeDigest(route) {
  return createHash('sha256').update(JSON.stringify(route.map(node => ({ ssh: node.profile.ssh, digest: node.configuration.sourceDigest })))).digest('hex');
}
function stageDescription(profile, index) {
  return index == null ? `Destination (${profile.ssh.host})` : `Jump host ${index + 1} (${profile.ssh.host})`;
}
function annotateStage(error, profile, index) {
  if (error.code === 'SSH_CANCELLED' || error.stage) return error;
  return Object.assign(new Error(stageDescription(profile, index) + ': ' + error.message),
    { code: error.code, stage: { kind: index == null ? 'destination' : 'jump', alias: profile.ssh.host, index: index == null ? null : index + 1 } });
}
function diagnosticStage(stderr, nodes) {
  // Inspect only OpenSSH's actual failing-host lines. Its final destination
  // banner can follow a proxy failure and must never be used to blame a host.
  const lines = String(stderr).split(/\r?\n/);
  for (const line of lines) {
    const match = /No .* host key is known for (.+?) and you have requested strict checking/i.exec(line)
      || /Host key for (.+?) has changed/i.exec(line)
      || /connect to host (\S+) port (\d+):/i.exec(line)
      || /Could not resolve hostname (\S+):/i.exec(line)
      || /^(?:ssh: )?([^\s@]+)@(\S+): Permission denied/i.exec(line);
    if (!match) continue;
    const denied = line.includes('Permission denied');
    const host = (denied ? match[2] : match[1]).toLowerCase();
    const found = nodes.findIndex(node => {
      const config = node.configuration;
      const candidates = [node.profile.ssh.host, config.hostname, config.hostkeyalias,
        Number(config.port) === 22 ? config.hostname : '[' + config.hostname.replace(/^\[|\]$/g, '') + ']:' + config.port];
      return candidates.some(candidate => candidate?.toLowerCase() === host)
        && (!denied || config.user === match[1])
        && (!line.includes('connect to host') || config.port === match[2]);
    });
    if (found >= 0) return { node: nodes[found], index: found === nodes.length - 1 ? null : found };
  }
  return null;
}

module.exports = { MAX_JUMP_HOSTS, jumpSpecifications, createManagedRouteConfiguration,
  routeDigest, stageDescription, annotateStage, diagnosticStage, commandArgument, configValue };
