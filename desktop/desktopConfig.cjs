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

module.exports = { isAllowedNavigation, normalizeServerUrl };
