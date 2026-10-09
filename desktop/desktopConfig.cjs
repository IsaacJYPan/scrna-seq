'use strict';

const { createHash, randomUUID } = require('node:crypto');
const { isIP } = require('node:net');
const path = require('node:path');
const { checkServiceCompatibility } = require('./serviceCompatibility.cjs');

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function normalizeServerUrl(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('Enter the address of your TraceOmics server.');
  }

  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error('Enter a complete server address, such as https://analysis.example.org.');
  }

  if (!['https:', 'http:'].includes(parsed.protocol)) {
    throw new Error('The server address must use HTTPS, or HTTP only for a local server.');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('The server address cannot include credentials, a query, or a fragment.');
  }
  if (parsed.protocol === 'http:' && !LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new Error('Use HTTPS for a remote server. HTTP is allowed only for localhost.');
  }

  parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
  return parsed.toString().replace(/\/$/, '');
}

function isAllowedNavigation(targetUrl, serverUrl) {
  try {
    const target = new URL(targetUrl);
    const server = new URL(serverUrl);
    return target.origin === server.origin;
  } catch {
    return false;
  }
}

async function verifyServerConnection(serverUrl, options = {}) {
  const normalized = normalizeServerUrl(serverUrl);
  await checkServiceCompatibility(normalized, options);
  return normalized;
}

async function verifyServiceCompatibility(serverUrl, options = {}) {
  return checkServiceCompatibility(normalizeServerUrl(serverUrl), options);
}

function requireAllowedFields(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => !allowed.includes(key))) {
    throw new Error('Target profiles can contain only the documented connection settings.');
  }
}

function normalizedLabel(value, field, maximum = 80) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maximum || /\p{Cc}/u.test(value)) {
    throw new Error(`Enter a valid ${field} of up to ${maximum} characters.`);
  }
  return value.trim();
}

function normalizedHost(value, field, allowAlias = false) {
  const host = normalizedLabel(value, field, 253);
  const address = host.replace(/^\[|\]$/g, '');
  if (!isIP(address) && !(allowAlias ? /^[a-z0-9](?:[a-z0-9_.-]*[a-z0-9])?$/i : /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i).test(host)) {
    throw new Error(`Enter a hostname or IP address for ${field}.`);
  }
  return isIP(address) === 6 ? `[${address.toLowerCase()}]` : address.toLowerCase();
}

function normalizedPort(value, fallback, field) {
  const number = value === '' || value == null ? fallback : Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 65535) throw new Error(`Enter a valid ${field} from 1 to 65535.`);
  return number;
}

function normalizeTargetProfile(value) {
  requireAllowedFields(value, ['id', 'name', 'kind', 'endpoint', 'ssh']);
  const id = value.id || randomUUID();
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error('The target identifier is invalid.');
  const name = normalizedLabel(value.name, 'target name');
  const kind = value.kind;
  if (!['local', 'https', 'ssh'].includes(kind)) throw new Error('Choose a local, HTTPS, or SSH target.');
  if (kind === 'ssh') {
    let endpoint;
    if (value.endpoint != null) {
      endpoint = normalizeServerUrl(value.endpoint);
      if (new URL(endpoint).protocol !== 'https:') throw new Error('An SSH target requires the original HTTPS server address, never a local tunnel address.');
    }
    requireAllowedFields(value.ssh, ['host', 'username', 'port', 'remoteHost', 'remotePort', 'identityFile']);
    const ssh = {
      host: normalizedHost(value.ssh.host, 'SSH host', true),
      remoteHost: normalizedHost(value.ssh.remoteHost || '127.0.0.1', 'remote service host'),
      remotePort: normalizedPort(value.ssh.remotePort, 3000, 'remote service port'),
    };
    if (value.ssh.port !== '' && value.ssh.port != null) ssh.port = normalizedPort(value.ssh.port, 22, 'SSH port');
    if (value.ssh.identityFile) {
      if (typeof value.ssh.identityFile !== 'string' || value.ssh.identityFile.length > 4096
          || /[\0\r\n]/.test(value.ssh.identityFile)
          || !(path.isAbsolute(value.ssh.identityFile) || path.win32.isAbsolute(value.ssh.identityFile))) {
        throw new Error('Choose an existing identity file through the native file picker.');
      }
      ssh.identityFile = value.ssh.identityFile;
    }
    if (value.ssh.username) {
      if (typeof value.ssh.username !== 'string' || !/^[a-z_][a-z0-9_.-]{0,63}$/i.test(value.ssh.username)) {
        throw new Error('Enter an SSH username without command options or whitespace.');
      }
      ssh.username = value.ssh.username;
    }
    if (endpoint && !LOOPBACK_HOSTS.has(ssh.remoteHost)) throw new Error('Managed HTTPS tunnels forward only a loopback service on the SSH destination.');
    return { id, name, kind, ssh, ...(endpoint ? { endpoint } : {}) };
  }
  if (value.ssh != null) throw new Error('SSH settings belong only to SSH profiles.');
  const endpoint = normalizeServerUrl(value.endpoint);
  const url = new URL(endpoint);
  if (kind === 'local' && !LOOPBACK_HOSTS.has(url.hostname)) throw new Error('A local target must use a loopback address.');
  if (kind === 'https' && url.protocol !== 'https:') throw new Error('A direct remote target must use HTTPS.');
  return { id, name, kind, endpoint };
}

function targetServiceIdentity(value, resolved) {
  const profile = normalizeTargetProfile(value);
  if (profile.kind !== 'ssh') return `service:${profile.endpoint}`;
  const ssh = profile.ssh;
  const identity = `ssh:${resolved?.username || ssh.username || ''}@${resolved?.host || ssh.host}:${resolved?.port || ssh.port || 'config'}/${ssh.remoteHost}:${ssh.remotePort}`;
  return profile.endpoint ? identity + '/' + profile.endpoint : identity;
}

function targetSessionPartition(value, resolved) {
  const digest = createHash('sha256').update(targetServiceIdentity(value, resolved)).digest('hex');
  return `persist:traceomics-service-${digest}`;
}

function profileForServerUrl(value, name = 'Saved server') {
  const endpoint = normalizeServerUrl(value);
  const digest = createHash('sha256').update(endpoint).digest('hex').slice(0, 24);
  return normalizeTargetProfile({ id: `target-${digest}`, name,
    kind: LOOPBACK_HOSTS.has(new URL(endpoint).hostname) ? 'local' : 'https', endpoint });
}

function normalizeTargetSettings(value) {
  if (value?.serverUrl && value.schemaVersion == null && value.profiles == null) {
    const profile = profileForServerUrl(value.serverUrl);
    return { schemaVersion: 1, selectedProfileId: profile.id, profiles: [profile] };
  }
  if (value == null) return { schemaVersion: 1, selectedProfileId: null, profiles: [] };
  requireAllowedFields(value, ['schemaVersion', 'selectedProfileId', 'profiles']);
  if (value.schemaVersion !== 1 || !Array.isArray(value.profiles) || value.profiles.length > 50) {
    throw new Error('The saved target settings are not supported.');
  }
  const profiles = value.profiles.map(normalizeTargetProfile);
  if (new Set(profiles.map(profile => profile.id)).size !== profiles.length) throw new Error('Saved target identifiers must be unique.');
  const selectedProfileId = value.selectedProfileId || null;
  if (selectedProfileId && !profiles.some(profile => profile.id === selectedProfileId)) {
    throw new Error('The selected target is no longer present.');
  }
  return { schemaVersion: 1, selectedProfileId, profiles };
}

module.exports = { isAllowedNavigation, normalizeServerUrl, verifyServerConnection, verifyServiceCompatibility,
  normalizeTargetProfile, normalizeTargetSettings, profileForServerUrl,
  targetServiceIdentity, targetSessionPartition };
