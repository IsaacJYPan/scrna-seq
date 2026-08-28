'use strict';

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

async function verifyServerConnection(serverUrl, { fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  const normalized = normalizeServerUrl(serverUrl);
  const policyUrl = new URL('/api/auth/policy', normalized);
  let response;
  try {
    response = await fetchImpl(policyUrl, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new Error('TraceOmics could not reach that server. Check the address, network connection, and server status.');
  }

  if (!response.ok) {
    throw new Error('That server did not accept the TraceOmics connection check.');
  }
  let policy;
  try {
    policy = await response.json();
  } catch {
    throw new Error('That address did not return a valid TraceOmics response.');
  }
  if (!policy || typeof policy.registrationEnabled !== 'boolean') {
    throw new Error('That address is not a compatible TraceOmics server.');
  }
  return normalized;
}

module.exports = { isAllowedNavigation, normalizeServerUrl, verifyServerConnection };
