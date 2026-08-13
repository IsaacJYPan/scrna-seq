'use strict';

const crypto = require('crypto');
const http = require('http');
const https = require('https');
const net = require('net');
const path = require('path');

const DEFAULT_R_PORT = 8000;
const MIN_EXTERNAL_TOKEN_LENGTH = 32;
const STORAGE_PROBE_PREFIX = '.traceomics-worker-storage-probe-';
const STORAGE_PROBE_CONTENT = 'traceomics-shared-storage-v1\n';

function trimmed(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function isLoopbackHost(hostname) {
  const h = trimmed(hostname).toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '127.0.0.1' || h === '::1';
}

function isPrivateIpLiteral(hostname) {
  const h = trimmed(hostname).toLowerCase().replace(/^\[|\]$/g, '');
  const family = net.isIP(h);
  if (family === 4) {
    const octets = h.split('.').map(Number);
    if (octets[0] === 10 || octets[0] === 127) return true;
    if (octets[0] === 192 && octets[1] === 168) return true;
    if (octets[0] === 169 && octets[1] === 254) return true;
    return octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31;
  }
  if (family === 6) {
    return h === '::1' || h.startsWith('fc') || h.startsWith('fd')
      || /^fe[89ab][0-9a-f]:/.test(h);
  }
  return false;
}

function allowedRHosts(env = {}) {
  return new Set(trimmed(env.R_BACKEND_ALLOWED_HOSTS)
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean));
}

function parseRBackendUrl(raw, env = {}) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('R_BACKEND_URL must be a valid absolute URL.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('R_BACKEND_URL must use http:// or https://.');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('R_BACKEND_URL must not contain credentials, a query, or a fragment.');
  }
  if (parsed.pathname && parsed.pathname !== '/') {
    throw new Error('R_BACKEND_URL must not contain a path.');
  }
  const host = parsed.hostname.toLowerCase();
  if (!isLoopbackHost(host) && !isPrivateIpLiteral(host) && !allowedRHosts(env).has(host)) {
    throw new Error('R_BACKEND_URL host must be loopback/private or explicitly allowlisted by R_BACKEND_ALLOWED_HOSTS.');
  }
  parsed.pathname = '';
  return parsed;
}

function resolveRRuntimeConfig(env = process.env, options = {}) {
  const modeRaw = trimmed(env.R_RUNTIME_MODE).toLowerCase();
  const mode = modeRaw || (trimmed(env.R_BACKEND_URL) ? 'external' : 'owned');
  if (mode !== 'owned' && mode !== 'external') {
    throw new Error('R_RUNTIME_MODE must be "owned" or "external".');
  }
  if (options.role === 'worker' && mode !== 'external') {
    throw new Error('The standalone worker requires R_RUNTIME_MODE=external so web and worker share one private R service.');
  }

  const configuredPort = Number(trimmed(env.PLUMBER_PORT) || DEFAULT_R_PORT);
  if (!Number.isInteger(configuredPort) || configuredPort <= 0 || configuredPort > 65535) {
    throw new Error('PLUMBER_PORT must be an integer between 1 and 65535.');
  }
  const defaultUrl = `http://127.0.0.1:${configuredPort}`;
  const url = parseRBackendUrl(trimmed(env.R_BACKEND_URL) || defaultUrl, env);
  const insecurePrivateHttpAllowed = env.R_BACKEND_ALLOW_INSECURE_PRIVATE_HTTP === 'true';
  if (trimmed(env.NODE_ENV).toLowerCase() === 'production'
      && mode === 'external'
      && url.protocol !== 'https:'
      && !isLoopbackHost(url.hostname)
      && !insecurePrivateHttpAllowed) {
    throw new Error(
      'Production R_BACKEND_URL must use HTTPS outside loopback; set '
      + 'R_BACKEND_ALLOW_INSECURE_PRIVATE_HTTP=true only for a reviewed encrypted service mesh.'
    );
  }
  const token = trimmed(env.R_API_TOKEN)
    || (mode === 'owned' ? crypto.randomBytes(32).toString('hex') : '');
  if (!token) {
    throw new Error('R_API_TOKEN is required when R_RUNTIME_MODE=external.');
  }
  if (mode === 'external' && token.length < MIN_EXTERNAL_TOKEN_LENGTH) {
    throw new Error(`R_API_TOKEN must be at least ${MIN_EXTERNAL_TOKEN_LENGTH} characters for an external R runtime.`);
  }
  if (/\r|\n/.test(token)) {
    throw new Error('R_API_TOKEN contains invalid characters.');
  }

  const port = url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80);
  return Object.freeze({
    mode,
    baseUrl: url.origin,
    protocol: url.protocol,
    hostname: url.hostname,
    port,
    token,
  });
}

// Explicit environment boundary for a locally-owned R child. In particular, this
// excludes SESSION_SECRET, DATABASE_URL/PG*, cloud credentials, and unrelated
// operator secrets from the scientific runtime.
const R_CHILD_OS_ENV_ALLOWLIST = Object.freeze([
  'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC',
  'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
  'R_HOME', 'R_USER', 'R_LIBS', 'R_LIBS_USER', 'R_LIBS_SITE',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ',
]);
const R_SESSION_LIMIT_ENV_NAMES = Object.freeze([
  'R_MAX_ACTIVE_SESSIONS',
  'R_MAX_ACTIVE_SESSIONS_PER_USER',
  'R_MAX_ACTIVE_SESSION_BYTES',
  'R_MAX_ACTIVE_SESSION_BYTES_PER_USER',
  'R_MAX_ACTIVE_SESSION_BYTES_PER_SESSION',
]);

function buildRChildEnv(env = process.env, options = {}) {
  const child = {};
  for (const name of R_CHILD_OS_ENV_ALLOWLIST) {
    if (env[name] !== undefined) child[name] = String(env[name]);
  }
  const storageRoot = path.resolve(options.storageRoot || env.STORAGE_ROOT || path.join(process.cwd(), 'data'));
  child.API_TOKEN = String(options.token || '');
  child.PLUMBER_PORT = String(options.port || DEFAULT_R_PORT);
  child.STORAGE_ROOT = storageRoot;
  child.ANALYSIS_ROOT = path.resolve(options.analysisRoot || process.cwd());
  child.NODE_ENV = trimmed(env.NODE_ENV) || 'development';
  for (const name of R_SESSION_LIMIT_ENV_NAMES) {
    const value = trimmed(env[name]);
    if (!value) continue;
    if (!/^[1-9][0-9]{0,15}$/.test(value) || !Number.isSafeInteger(Number(value))) {
      throw new Error(`${name} must be a positive safe integer when set.`);
    }
    child[name] = value;
  }
  if (env.ENABLE_R_TEST_DIAGNOSTICS === 'true' && child.NODE_ENV !== 'production') {
    child.ENABLE_R_TEST_DIAGNOSTICS = 'true';
    const delay = trimmed(env.R_TEST_SEURAT_DELAY_MS);
    if (/^[1-9][0-9]{0,5}$/.test(delay) && Number(delay) <= 600000) {
      child.R_TEST_SEURAT_DELAY_MS = delay;
    }
    const degDelay = trimmed(env.R_TEST_DEG_DELAY_MS);
    if (/^[1-9][0-9]{0,5}$/.test(degDelay) && Number(degDelay) <= 600000) {
      child.R_TEST_DEG_DELAY_MS = degDelay;
    }
  }
  if (env.ALLOW_TRUSTED_RDS_LOAD === 'true') child.ALLOW_TRUSTED_RDS_LOAD = 'true';
  return child;
}

function requestRJson(runtime, requestPath, options = {}) {
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 1000;
  const maxResponseBytes = Number(options.maxResponseBytes) > 0
    ? Number(options.maxResponseBytes)
    : 256 * 1024;
  const transport = runtime.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    let settled = false;
    let req;
    let deadline = null;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      if (error) reject(error);
      else resolve(value);
    };
    try {
      req = transport.request({
        protocol: runtime.protocol,
        hostname: runtime.hostname,
        port: runtime.port,
        method: 'GET',
        path: requestPath,
        headers: {
          ...(options.headers || {}),
          'X-API-Token': runtime.token,
          Accept: 'application/json',
        },
      }, (res) => {
        const chunks = [];
        let bytes = 0;
        res.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > maxResponseBytes) {
            req.destroy();
            finish(Object.assign(new Error('R readiness response exceeded its limit.'), { code: 'R_RESPONSE_TOO_LARGE' }));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          if (settled) return;
          let body;
          try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            finish(Object.assign(new Error('R readiness response was invalid.'), { code: 'R_INVALID_RESPONSE' }));
            return;
          }
          if (res.statusCode < 200 || res.statusCode >= 300) {
            finish(Object.assign(new Error('R readiness check failed.'), { code: 'R_NOT_READY' }));
            return;
          }
          finish(null, body);
        });
      });
    } catch {
      finish(Object.assign(new Error('R runtime is unreachable.'), { code: 'R_UNREACHABLE' }));
      return;
    }
    deadline = setTimeout(() => {
      req.destroy();
      finish(Object.assign(new Error('R readiness check timed out.'), { code: 'R_TIMEOUT' }));
    }, timeoutMs);
    if (typeof deadline.unref === 'function') deadline.unref();
    req.on('error', () => finish(Object.assign(new Error('R runtime is unreachable.'), { code: 'R_UNREACHABLE' })));
    req.end();
  });
}

async function probeRHealth(runtime, options = {}) {
  return requestRJson(runtime, '/health', options);
}

async function probeWorkerRReadiness(runtime, options = {}) {
  const nonce = trimmed(options.storageProbeNonce).toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(nonce)) {
    throw Object.assign(new Error('Worker storage challenge is invalid.'), { code: 'R_STORAGE_PROBE_INVALID' });
  }
  const body = await requestRJson(runtime, '/internal/worker-readiness', {
    ...options,
    headers: { 'X-Storage-Probe-Nonce': nonce },
  });
  if (!body || body.status !== 'ok' || body.storage_shared !== true) {
    throw Object.assign(new Error('R runtime cannot see the worker durable storage root.'), { code: 'R_STORAGE_NOT_SHARED' });
  }
  if (typeof body.runtime_session_id !== 'string'
      || !/^[A-Za-z0-9._-]{8,128}$/.test(body.runtime_session_id)) {
    throw Object.assign(new Error('R runtime instance identity is unavailable.'), {
      code: 'R_RUNTIME_INSTANCE_MISSING',
    });
  }
  const capabilities = body.capabilities && typeof body.capabilities === 'object'
    ? body.capabilities
    : {};
  body.capabilities = {
    pathwayEnrichment: capabilities.pathway_enrichment === true,
    cellChat: capabilities.cellchat === true,
  };
  return body;
}

module.exports = {
  DEFAULT_R_PORT,
  MIN_EXTERNAL_TOKEN_LENGTH,
  STORAGE_PROBE_PREFIX,
  STORAGE_PROBE_CONTENT,
  R_CHILD_OS_ENV_ALLOWLIST,
  R_SESSION_LIMIT_ENV_NAMES,
  isLoopbackHost,
  isPrivateIpLiteral,
  parseRBackendUrl,
  resolveRRuntimeConfig,
  buildRChildEnv,
  requestRJson,
  probeRHealth,
  probeWorkerRReadiness,
};
