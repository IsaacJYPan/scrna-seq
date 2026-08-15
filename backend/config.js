/**
 * Centralized runtime configuration + environment boundaries.
 *
 * This module is the single, documented place that reads process.env for the
 * hosted-service configuration surface: Postgres connection, session /
 * cookie settings, allowed browser origins, the internal R backend URL, the job
 * worker knobs, storage roots, and upload limits. It exists so hosted deployment
 * behavior is legible and validated in ONE place instead of being scattered
 * through server.js.
 *
 * Boundaries this module enforces / encodes:
 *  - Secrets (SESSION_SECRET, DATABASE_URL credentials) are never returned by
 *    summary() and never logged. Only presence booleans are surfaced.
 *  - Required production-like vars are validated by validateProductionConfig();
 *    a misconfigured production process should fail fast, not boot insecurely.
 *  - The internal R backend URL and storage roots are server-only and are not
 *    part of any client-facing projection.
 *
 * Values are read through functions (not cached constants) so tests can mutate
 * process.env deterministically between cases, mirroring the existing pattern in
 * server.js (authRateLimit*, parseJobWorkerConfig).
 */

'use strict';

const path = require('path');
const rRuntime = require('./rRuntime');

const ALLOWED_NODE_ENVS = new Set(['development', 'test', 'production']);
const ALLOWED_DEPLOYMENT_MODES = new Set(['private', 'byoc', 'shared-private', 'demo', 'public']);
const EXPERT_R_DEPLOYMENT_MODES = new Set(['private', 'byoc', 'shared-private']);
const MIN_SESSION_SECRET_LENGTH = 32;
const SESSION_EPOCH_PATTERN = /^[0-9a-f]{32}$/;
const DEVELOPMENT_SESSION_EPOCH = '00000000000000000000000000000000';
const SESSION_TTL_MIN_SECONDS = 5 * 60;
const SESSION_TTL_MAX_SECONDS = 24 * 60 * 60;
const LEGACY_SESSION_COOKIE_NAME = 'traceomics_session';
const PRODUCTION_SESSION_COOKIE_NAME = '__Host-traceomics_session';
const ALLOWED_DATABASE_URL_QUERY_KEYS = new Set(['sslmode', 'sslrootcert', 'sslcert', 'sslkey']);
const ALLOWED_POSTGRES_SSL_MODES = new Set(['disable', 'prefer', 'require', 'verify-ca', 'verify-full', 'no-verify']);

function trimmed(raw) {
  return raw === undefined || raw === null ? '' : String(raw).trim();
}

function looksLikeGeneratedHex(value, length) {
  if (typeof value !== 'string' || value.length !== length || !/^[0-9a-f]+$/.test(value)) return false;
  if (new Set(value).size < 8) return false;
  if (/(.)\1{7}/.test(value)) return false;
  if (value.includes('0123456789abcdef') || value.includes('fedcba9876543210')) return false;
  for (let period = 1; period <= Math.floor(value.length / 2); period += 1) {
    if (value.length % period === 0 && value === value.slice(0, period).repeat(value.length / period)) return false;
  }
  return true;
}

function isStrongSecretValue(raw, minimumLength = 32) {
  const value = trimmed(raw);
  // Production examples use `openssl rand -hex 32`. Requiring that exact
  // encoding is auditable and rejects varied-looking phrases/sequences without
  // pretending that character variety proves entropy.
  return minimumLength <= 64 && looksLikeGeneratedHex(value, 64);
}

/**
 * Parse a positive integer env override, falling back to a safe default. A
 * malformed value (non-numeric, NaN/Infinity, non-integer, or <= 0) falls back
 * rather than silently disabling a limit — mirrors positiveIntFromEnv in
 * server.js so config parsing is consistent across the app.
 */
function positiveIntFromEnv(rawValue, fallback) {
  if (rawValue === undefined || rawValue === null || String(rawValue).trim() === '') return fallback;
  const n = Number(rawValue);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return fallback;
  return n;
}

function isValidPositiveIntOverride(rawValue) {
  if (rawValue === undefined || rawValue === null || String(rawValue).trim() === '') return true;
  const n = Number(rawValue);
  return Number.isFinite(n) && Number.isInteger(n) && n > 0;
}

function nodeEnv() {
  return trimmed(process.env.NODE_ENV) || 'development';
}

function isProduction() {
  return nodeEnv() === 'production';
}

function isLoopbackHost(value) {
  const host = trimmed(value).toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

// ── Database backend selection ──────────────────────────────────────────────
// The app runtime is Postgres-only. DATABASE_BACKEND is accepted for readable
// summaries, but any value resolves to Postgres; SQLite is no longer a runtime
// option.
function databaseBackend() {
  const raw = trimmed(process.env.DATABASE_BACKEND).toLowerCase();
  if (raw === 'postgres' || raw === 'postgresql' || raw === 'pg') return 'postgres';
  return 'postgres';
}

function databaseUrl() {
  return trimmed(process.env.DATABASE_URL);
}

function inspectDatabaseUrl() {
  const raw = databaseUrl();
  if (!raw) return { parsed: null, sslMode: '', errors: [] };
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return { parsed: null, sslMode: '', errors: ['DATABASE_URL must be a valid Postgres URL.'] };
  }
  const errors = [];
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)
      || !parsed.hostname || !parsed.username
      || !parsed.pathname || parsed.pathname === '/') {
    errors.push('DATABASE_URL must include a Postgres host, user, and database name.');
  }
  const seen = new Set();
  let sslMode = '';
  for (const [rawName, value] of parsed.searchParams) {
    const name = rawName.toLowerCase();
    if (rawName !== name || seen.has(name)) {
      errors.push('DATABASE_URL query options must use unique lowercase names.');
      continue;
    }
    seen.add(name);
    if (!ALLOWED_DATABASE_URL_QUERY_KEYS.has(name)) {
      errors.push(`DATABASE_URL option ${name} is not supported.`);
      continue;
    }
    if (name === 'sslmode') {
      sslMode = trimmed(value).toLowerCase();
      if (!ALLOWED_POSTGRES_SSL_MODES.has(sslMode)) {
        errors.push('DATABASE_URL sslmode is invalid.');
      }
    }
  }
  return { parsed, sslMode, errors };
}

/**
 * Build a node-postgres client/pool config from DATABASE_URL if present, else
 * from explicit PG* vars (PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE), which the
 * pg library also understands. SSL is enabled when PGSSLMODE=require (hosted
 * providers) — never for a plain localhost dev/CI database.
 */
function postgresConfig() {
  const cfg = {
    application_name: 'traceomics',
    max: postgresPoolMax(),
    connectionTimeoutMillis: postgresConnectTimeoutMs(),
    idleTimeoutMillis: postgresIdleTimeoutMs(),
  };
  const url = databaseUrl();
  if (url) {
    const inspected = inspectDatabaseUrl();
    if (!inspected.parsed || inspected.errors.length > 0) {
      throw new Error('DATABASE_URL is invalid or contains unsupported connection options.');
    }
    cfg.connectionString = inspected.parsed.toString();
  } else {
    if (trimmed(process.env.PGHOST)) cfg.host = trimmed(process.env.PGHOST);
    if (trimmed(process.env.PGPORT)) cfg.port = positiveIntFromEnv(process.env.PGPORT, 5432);
    if (trimmed(process.env.PGUSER)) cfg.user = trimmed(process.env.PGUSER);
    if (process.env.PGPASSWORD !== undefined) cfg.password = String(process.env.PGPASSWORD);
    if (trimmed(process.env.PGDATABASE)) cfg.database = trimmed(process.env.PGDATABASE);
  }
  const sslMode = postgresSslMode();
  if (sslMode === 'require') {
    // Development compatibility only. Production validation rejects this mode
    // because encryption without certificate authentication is vulnerable to a
    // database MITM.
    cfg.ssl = { rejectUnauthorized: false };
  } else if (sslMode === 'verify-ca' || sslMode === 'verify-full') {
    cfg.ssl = { rejectUnauthorized: true };
  }
  return cfg;
}

function postgresSslMode() {
  const explicit = trimmed(process.env.PGSSLMODE).toLowerCase();
  const fromUrl = inspectDatabaseUrl().sslMode;
  return fromUrl || explicit;
}

function postgresHost() {
  const url = databaseUrl();
  if (url) {
    try { return new URL(url).hostname; } catch { return ''; }
  }
  return trimmed(process.env.PGHOST);
}

function postgresPoolMax() {
  return positiveIntFromEnv(process.env.PG_POOL_MAX, 10);
}

function postgresConnectTimeoutMs() {
  return positiveIntFromEnv(process.env.PG_CONNECT_TIMEOUT_MS, 5000);
}

function postgresIdleTimeoutMs() {
  return positiveIntFromEnv(process.env.PG_IDLE_TIMEOUT_MS, 30000);
}

/** True when enough Postgres connection info exists to attempt a connection. */
function hasPostgresConnection() {
  return !!(databaseUrl() || trimmed(process.env.PGHOST) || trimmed(process.env.PGDATABASE));
}

// ── Session / cookie auth ───────────────────────────────────────────────────
const SESSION_COOKIE_NAME = LEGACY_SESSION_COOKIE_NAME;

function sessionCookieName() {
  return isProduction() ? PRODUCTION_SESSION_COOKIE_NAME : LEGACY_SESSION_COOKIE_NAME;
}

function sessionTtlSeconds() {
  return positiveIntFromEnv(process.env.SESSION_TTL_SECONDS, 12 * 60 * 60);
}

function sessionEpoch() {
  return trimmed(process.env.SESSION_EPOCH) || DEVELOPMENT_SESSION_EPOCH;
}

function isValidSessionEpoch(value = sessionEpoch()) {
  const epoch = String(value || '');
  if (epoch === DEVELOPMENT_SESSION_EPOCH) return !isProduction();
  return SESSION_EPOCH_PATTERN.test(epoch) && looksLikeGeneratedHex(epoch, 32);
}

function hasStrongSessionSecret() {
  return isStrongSecretValue(process.env.SESSION_SECRET, MIN_SESSION_SECRET_LENGTH);
}

// Network-facing production registration is deliberately unavailable in the
// supported topology. Accounts are provisioned through the operator-only CLI,
// preventing anonymous account creation from becoming a storage/compute abuse
// primitive. Development and test retain the convenient signup flow.
function registrationEnabled() {
  return !isProduction() && !demoMode();
}

function demoMode() {
  return deploymentMode() === 'demo';
}

function deploymentMode() {
  const mode = trimmed(process.env.APP_DEPLOYMENT_MODE).toLowerCase();
  return ALLOWED_DEPLOYMENT_MODES.has(mode) ? mode : 'unknown';
}

function demoGuestTtlSeconds() {
  return positiveIntFromEnv(process.env.DEMO_GUEST_TTL_SECONDS, 2 * 60 * 60);
}

function demoTemplateProjectId() {
  return trimmed(process.env.DEMO_TEMPLATE_PROJECT_ID);
}

// HttpOnly session cookies are Secure by default in production and non-Secure by
// default in dev (so http://localhost works). COOKIE_SECURE overrides the
// default. A production process that explicitly sets COOKIE_SECURE=false yields
// false here, but validateProductionConfig() then refuses to boot — so the
// insecure setting fails fast rather than silently shipping.
function cookieSecure() {
  const raw = trimmed(process.env.COOKIE_SECURE).toLowerCase();
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return isProduction();
}

// SameSite=Lax is the default: it lets top-level navigations carry the session
// (so returning to the app stays logged in) while blocking cross-site POST/PUT/
// DELETE cookies — the first CSRF line of defense, backed by an origin check.
function cookieSameSite() {
  const raw = trimmed(process.env.COOKIE_SAMESITE).toLowerCase();
  if (raw === 'strict' || raw === 'lax' || raw === 'none') {
    return raw.charAt(0).toUpperCase() + raw.slice(1);
  }
  return 'Lax';
}

function validateCookieConfig() {
  const errors = [];
  if (cookieSameSite() === 'None' && !cookieSecure()) {
    errors.push('COOKIE_SAMESITE=None requires Secure cookies (COOKIE_SECURE=true); browsers reject None cookies without Secure.');
  }
  return errors;
}

// ── Allowed browser origins (CORS + CSRF) ───────────────────────────────────
// Comma-separated FRONTEND_ORIGIN (preferred) or legacy FRONTEND_URL. Trailing
// slashes are stripped so an origin compares cleanly against a request Origin
// header. Used both for the CORS allowlist and the cookie-auth CSRF origin check.
function allowedOrigins() {
  const raw = trimmed(process.env.FRONTEND_ORIGIN) || trimmed(process.env.FRONTEND_URL) || 'http://localhost:5173';
  return raw
    .split(',')
    .map((s) => normalizeOrigin(s))
    .filter(Boolean);
}

function normalizeOrigin(value) {
  const raw = trimmed(value).replace(/\/+$/, '');
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    if (!['http:', 'https:'].includes(parsed.protocol)
        || parsed.username || parsed.password
        || (parsed.pathname && parsed.pathname !== '/')
        || parsed.search || parsed.hash) return raw;
    return parsed.origin;
  } catch {
    return raw;
  }
}

function isValidBrowserOrigin(value) {
  const normalized = normalizeOrigin(value);
  if (!normalized) return false;
  try {
    const parsed = new URL(normalized);
    return ['http:', 'https:'].includes(parsed.protocol)
      && !parsed.username && !parsed.password
      && (parsed.pathname === '/' || parsed.pathname === '')
      && !parsed.search && !parsed.hash
      && parsed.origin === normalized;
  } catch {
    return false;
  }
}

function isAllowedOrigin(origin) {
  if (!origin) return false;
  const normalized = normalizeOrigin(origin);
  if (!isValidBrowserOrigin(normalized)) return false;
  return allowedOrigins().includes(normalized);
}

// â”€â”€ Web listener / ingress contract â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function webPort() {
  return positiveIntFromEnv(process.env.PORT, 3000);
}

function webHost() {
  return trimmed(process.env.WEB_HOST) || '127.0.0.1';
}

function trustProxyHops() {
  const raw = trimmed(process.env.TRUST_PROXY_HOPS);
  if (!raw) return 0;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 && value <= 3 ? value : 0;
}

function webShutdownTimeoutMs() {
  return positiveIntFromEnv(process.env.WEB_SHUTDOWN_TIMEOUT_MS, 150000);
}

function webDrainDelayMs() {
  const raw = trimmed(process.env.WEB_DRAIN_DELAY_MS);
  if (!raw) return 1000;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : 1000;
}

// ── Internal R backend (server-only; never exposed to the client) ───────────
function plumberPort() {
  return positiveIntFromEnv(process.env.PLUMBER_PORT, 8000);
}

function rBackendUrl() {
  const explicit = trimmed(process.env.R_BACKEND_URL);
  if (explicit) return explicit.replace(/\/+$/, '');
  return `http://127.0.0.1:${plumberPort()}`;
}

function rRuntimeMode() {
  const explicit = trimmed(process.env.R_RUNTIME_MODE).toLowerCase();
  if (explicit) return explicit;
  return trimmed(process.env.R_BACKEND_URL) ? 'external' : 'owned';
}

function hasRApiToken() {
  return isStrongSecretValue(process.env.R_API_TOKEN, 32);
}

// ── Storage roots + upload limits (server-only; never exposed to clients) ────
function resolveRoot(envValue, fallbackSegments) {
  const raw = trimmed(envValue);
  if (raw) return path.resolve(raw);
  return path.join(process.cwd(), ...fallbackSegments);
}

// Project-scoped durable files and temporary upload staging.
function storageRoot() {
  return resolveRoot(process.env.STORAGE_ROOT, ['data']);
}

function vaultRoot() {
  return resolveRoot(process.env.VAULT_ROOT, ['vault']);
}

function maxUploadBytes() {
  return positiveIntFromEnv(process.env.MAX_UPLOAD_BYTES, 512 * 1024 * 1024);
}

function maxUploadFiles() {
  return positiveIntFromEnv(process.env.MAX_UPLOAD_FILES, 10000);
}

// The authenticated legacy R proxy is intentionally bounded. Heavy durable
// workflows use the job queue; these limits keep the compatibility/live-state
// path from becoming an unbounded memory or connection sink.
function rProxyTimeoutMs() {
  return positiveIntFromEnv(process.env.R_PROXY_TIMEOUT_MS, 120000);
}

function rProxyMaxResponseBytes() {
  return positiveIntFromEnv(process.env.R_PROXY_MAX_RESPONSE_BYTES, 8 * 1024 * 1024);
}

function rProxyRateLimitWindowMs() {
  return positiveIntFromEnv(process.env.R_PROXY_RATE_LIMIT_WINDOW_MS, 60 * 1000);
}

function rProxyRateLimitMax() {
  return positiveIntFromEnv(process.env.R_PROXY_RATE_LIMIT_MAX, 60);
}

function rProxyMaxConcurrent() {
  return positiveIntFromEnv(process.env.R_PROXY_MAX_CONCURRENT, 1);
}

function pathContains(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

function isFilesystemRoot(absPath) {
  return path.parse(absPath).root === absPath;
}

// ── Supported R target ──────────────────────────────────────────────────────
function supportedRTarget() {
  return 'R 4.5.x';
}

// ── Non-secret config summary for safe startup logging ──────────────────────
// NEVER include SESSION_SECRET, DATABASE_URL, PGPASSWORD, or any storage key.
function summary() {
  return {
    nodeEnv: nodeEnv(),
    databaseBackend: databaseBackend(),
    hasDatabaseUrl: !!databaseUrl(),
    hasSessionSecret: !!trimmed(process.env.SESSION_SECRET),
    hasStrongSessionSecret: hasStrongSessionSecret(),
    hasSessionEpoch: !!trimmed(process.env.SESSION_EPOCH),
    registrationMode: registrationEnabled() ? 'open-development' : 'operator-only',
    deploymentMode: deploymentMode(),
    sessionTtlSeconds: sessionTtlSeconds(),
    sessionCookieName: sessionCookieName(),
    cookieSecure: cookieSecure(),
    cookieSameSite: cookieSameSite(),
    allowedOrigins: allowedOrigins(),
    webHost: webHost(),
    webPort: webPort(),
    trustProxyHops: trustProxyHops(),
    supportedRTarget: supportedRTarget(),
    rRuntimeMode: rRuntimeMode(),
    hasRApiToken: hasRApiToken()
  };
}

/**
 * Validate runtime configuration. Cookie invariants are enforced in every
 * environment because browsers reject unsafe SameSite=None cookies regardless of
 * NODE_ENV; the remaining hosted-service requirements are production-only.
 * Returns an array of human-readable error strings (empty === OK). Never echoes
 * secret values — only names the missing/invalid variable.
 */
function validateProductionConfig(options = {}) {
  const role = options.role || 'web';
  const errors = validateCookieConfig();
  if (!ALLOWED_NODE_ENVS.has(nodeEnv())) {
    errors.push('NODE_ENV must be development, test, or production.');
  }
  const rawPoolMax = trimmed(process.env.PG_POOL_MAX);
  if (rawPoolMax && (!isValidPositiveIntOverride(rawPoolMax)
      || Number(rawPoolMax) < 2 || Number(rawPoolMax) > 20)) {
    errors.push('PG_POOL_MAX must be between 2 and 20 because topology locks reserve one connection.');
  }
  const rawSessionEpoch = trimmed(process.env.SESSION_EPOCH);
  if (rawSessionEpoch && !isValidSessionEpoch(rawSessionEpoch)) {
    errors.push('SESSION_EPOCH must be exactly 32 lowercase hexadecimal characters.');
  }
  if (!isProduction()) return errors;

  if (deploymentMode() === 'unknown') {
    errors.push('APP_DEPLOYMENT_MODE must be private, byoc, shared-private, demo, or public in production.');
  }

  if (role !== 'web' && role !== 'worker') {
    errors.push('Runtime role must be web or worker.');
  }
  if (role === 'web' && !hasStrongSessionSecret()) {
    errors.push('SESSION_SECRET must be generated as exactly 64 lowercase hexadecimal characters in production (for example, openssl rand -hex 32).');
  }
  if (role === 'web' && (!rawSessionEpoch || !isValidSessionEpoch(rawSessionEpoch))) {
    errors.push('SESSION_EPOCH must be a freshly generated 32-character lowercase hexadecimal deployment identifier in production.');
  }
  if (!hasPostgresConnection()) {
    errors.push('DATABASE_URL (or PGHOST/PGDATABASE) must be set for the Postgres backend.');
  }
  if (role === 'web' && !trimmed(process.env.FRONTEND_ORIGIN) && !trimmed(process.env.FRONTEND_URL)) {
    errors.push('FRONTEND_ORIGIN must be set in production so CORS/CSRF are not left at the dev default.');
  }
  if (!hasRApiToken()) {
    errors.push('R_API_TOKEN must be independently generated as exactly 64 lowercase hexadecimal characters in production.');
  }
  try {
    rRuntime.resolveRRuntimeConfig(process.env, { role });
  } catch (error) {
    errors.push(error && error.message ? error.message : 'R runtime configuration is invalid.');
  }
  if (rRuntimeMode() !== 'external' || !trimmed(process.env.R_BACKEND_URL)) {
    errors.push('Production web and worker processes require R_RUNTIME_MODE=external with an explicit R_BACKEND_URL.');
  }
  if (role === 'web' && !cookieSecure()) {
    errors.push('Session cookies must be Secure in production (do not set COOKIE_SECURE=false).');
  }
  if (role === 'web') {
    const origins = allowedOrigins();
    if (origins.length === 0 || origins.some((origin) => !isValidBrowserOrigin(origin))) {
      errors.push('FRONTEND_ORIGIN must contain only valid absolute HTTP(S) origins without paths, credentials, queries, or fragments.');
    }
    if (origins.some((origin) => {
      try { return new URL(origin).protocol !== 'https:'; } catch { return true; }
    })) {
      errors.push('Every FRONTEND_ORIGIN must use https:// in production.');
    }
    if (!isValidPositiveIntOverride(process.env.SESSION_TTL_SECONDS)
        || sessionTtlSeconds() < SESSION_TTL_MIN_SECONDS
        || sessionTtlSeconds() > SESSION_TTL_MAX_SECONDS) {
      errors.push(`SESSION_TTL_SECONDS must be an integer between ${SESSION_TTL_MIN_SECONDS} and ${SESSION_TTL_MAX_SECONDS} in production.`);
    }
    const rawPort = trimmed(process.env.PORT);
    if (rawPort && (!isValidPositiveIntOverride(rawPort) || webPort() > 65535)) {
      errors.push('PORT must be an integer between 1 and 65535.');
    }
    if (!['127.0.0.1', '::1', '0.0.0.0'].includes(webHost())) {
      errors.push('WEB_HOST must be 127.0.0.1, ::1, or 0.0.0.0.');
    }
    if (!trimmed(process.env.TRUST_PROXY_HOPS) || trustProxyHops() === 0) {
      errors.push('TRUST_PROXY_HOPS must be an integer between 1 and 3 for the production TLS ingress.');
    }
  }
  if (!isValidPositiveIntOverride(process.env.MAX_UPLOAD_BYTES)) {
    errors.push('MAX_UPLOAD_BYTES must be a positive integer when set.');
  }
  if (!isValidPositiveIntOverride(process.env.MAX_UPLOAD_FILES)) {
    errors.push('MAX_UPLOAD_FILES must be a positive integer when set.');
  }
  for (const name of [
    'R_PROXY_TIMEOUT_MS', 'R_PROXY_MAX_RESPONSE_BYTES',
    'R_PROXY_RATE_LIMIT_WINDOW_MS', 'R_PROXY_RATE_LIMIT_MAX',
    'R_PROXY_MAX_CONCURRENT'
  ]) {
    if (!isValidPositiveIntOverride(process.env[name])) {
      errors.push(`${name} must be a positive integer when set.`);
    }
  }
  if (rProxyMaxConcurrent() > 1) {
    errors.push('R_PROXY_MAX_CONCURRENT must be 1 for the supported single-R production topology.');
  }
  if (rProxyTimeoutMs() > 120000) {
    errors.push('R_PROXY_TIMEOUT_MS must not exceed 120000 in production.');
  }
  if (rProxyMaxResponseBytes() > 8 * 1024 * 1024) {
    errors.push('R_PROXY_MAX_RESPONSE_BYTES must not exceed 8388608 in production.');
  }
  for (const [name, min, max] of [
    ['PG_CONNECT_TIMEOUT_MS', 100, 30000],
    ['PG_IDLE_TIMEOUT_MS', 1000, 300000],
  ]) {
    if (!isValidPositiveIntOverride(process.env[name])) {
      errors.push(`${name} must be a positive integer when set.`);
      continue;
    }
    const value = name === 'PG_CONNECT_TIMEOUT_MS' ? postgresConnectTimeoutMs()
        : postgresIdleTimeoutMs();
    if (value < min || value > max) errors.push(`${name} must be between ${min} and ${max} in production.`);
  }
  const dbHost = postgresHost();
  const sslMode = postgresSslMode();
  const databaseInspection = inspectDatabaseUrl();
  errors.push(...databaseInspection.errors);
  const explicitSslMode = trimmed(process.env.PGSSLMODE).toLowerCase();
  if (explicitSslMode && !ALLOWED_POSTGRES_SSL_MODES.has(explicitSslMode)) {
    errors.push('PGSSLMODE is invalid.');
  }
  if (explicitSslMode && databaseInspection.sslMode && explicitSslMode !== databaseInspection.sslMode) {
    errors.push('PGSSLMODE and DATABASE_URL sslmode must not conflict.');
  }
  if (dbHost && !isLoopbackHost(dbHost) && sslMode !== 'verify-full') {
    errors.push('Non-loopback Postgres requires sslmode=verify-full so the database certificate and hostname are authenticated.');
  }
  if (sslMode && !['disable', 'verify-full'].includes(sslMode)) {
    errors.push('Production Postgres sslmode must be disable for loopback or verify-full for authenticated TLS.');
  }
  if (!trimmed(process.env.STORAGE_ROOT) || !path.isAbsolute(trimmed(process.env.STORAGE_ROOT))) {
    errors.push('STORAGE_ROOT must be an explicit absolute persistent path in production.');
  }
  if (!trimmed(process.env.VAULT_ROOT) || !path.isAbsolute(trimmed(process.env.VAULT_ROOT))) {
    errors.push('VAULT_ROOT must be an explicit absolute persistent path in production.');
  }
  const durableRoot = storageRoot();
  const privateRoot = vaultRoot();
  if (isFilesystemRoot(durableRoot)) {
    errors.push('STORAGE_ROOT must not resolve to the filesystem root.');
  }
  if (isFilesystemRoot(privateRoot)) {
    errors.push('VAULT_ROOT must not resolve to the filesystem root.');
  }
  if (pathContains(durableRoot, privateRoot) || pathContains(privateRoot, durableRoot)) {
    errors.push('STORAGE_ROOT and VAULT_ROOT must be separate non-overlapping directories.');
  }
  if (process.env.EXPERT_R_ENABLED === 'true') {
    let sandboxUrl;
    try { sandboxUrl = new URL(trimmed(process.env.EXPERT_R_SANDBOX_URL)); } catch { /* checked below */ }
    if (!sandboxUrl || !['http:', 'https:'].includes(sandboxUrl.protocol)
        || !isLoopbackHost(sandboxUrl.hostname) || sandboxUrl.username || sandboxUrl.password
        || (sandboxUrl.pathname && sandboxUrl.pathname !== '/') || sandboxUrl.search || sandboxUrl.hash) {
      errors.push('EXPERT_R_SANDBOX_URL must be an internal loopback HTTP(S) origin when Expert R is enabled.');
    }
    if (!/^[0-9a-f]{64}$/.test(trimmed(process.env.EXPERT_R_SANDBOX_TOKEN))) {
      errors.push('EXPERT_R_SANDBOX_TOKEN must be 64 lowercase hexadecimal characters when Expert R is enabled.');
    }
    if (!EXPERT_R_DEPLOYMENT_MODES.has(deploymentMode())) {
      errors.push('EXPERT_R_ENABLED requires APP_DEPLOYMENT_MODE=private, byoc, or shared-private.');
    }
  }
  if (demoMode()) {
    if (process.env.EXPERT_R_ENABLED === 'true') {
      errors.push('EXPERT_R_ENABLED must be false in public demo mode.');
    }
    if (demoGuestTtlSeconds() < 900 || demoGuestTtlSeconds() > 86400) {
      errors.push('DEMO_GUEST_TTL_SECONDS must be between 900 and 86400 in demo mode.');
    }
    if (sessionTtlSeconds() > demoGuestTtlSeconds()) {
      errors.push('SESSION_TTL_SECONDS must not exceed DEMO_GUEST_TTL_SECONDS in demo mode.');
    }
    if (!/^proj_[A-Za-z0-9_-]{3,128}$/.test(demoTemplateProjectId())) {
      errors.push('DEMO_TEMPLATE_PROJECT_ID must identify the curated template project in demo mode.');
    }
  }
  return errors;
}

module.exports = {
  positiveIntFromEnv,
  isValidPositiveIntOverride,
  nodeEnv,
  isProduction,
  databaseBackend,
  databaseUrl,
  postgresConfig,
  hasPostgresConnection,
  postgresSslMode,
  postgresHost,
  postgresPoolMax,
  postgresConnectTimeoutMs,
  postgresIdleTimeoutMs,
  SESSION_COOKIE_NAME,
  LEGACY_SESSION_COOKIE_NAME,
  PRODUCTION_SESSION_COOKIE_NAME,
  sessionCookieName,
  sessionTtlSeconds,
  sessionEpoch,
  isValidSessionEpoch,
  hasStrongSessionSecret,
  registrationEnabled,
  deploymentMode,
  demoMode,
  demoGuestTtlSeconds,
  demoTemplateProjectId,
  cookieSecure,
  cookieSameSite,
  validateCookieConfig,
  allowedOrigins,
  normalizeOrigin,
  isValidBrowserOrigin,
  isAllowedOrigin,
  webPort,
  webHost,
  trustProxyHops,
  webShutdownTimeoutMs,
  webDrainDelayMs,
  plumberPort,
  rBackendUrl,
  rRuntimeMode,
  hasRApiToken,
  storageRoot,
  vaultRoot,
  maxUploadBytes,
  maxUploadFiles,
  rProxyTimeoutMs,
  rProxyMaxResponseBytes,
  rProxyRateLimitWindowMs,
  rProxyRateLimitMax,
  rProxyMaxConcurrent,
  supportedRTarget,
  summary,
  validateProductionConfig
};
