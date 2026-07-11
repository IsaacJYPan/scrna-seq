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

function trimmed(raw) {
  return raw === undefined || raw === null ? '' : String(raw).trim();
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

/**
 * Build a node-postgres client/pool config from DATABASE_URL if present, else
 * from explicit PG* vars (PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE), which the
 * pg library also understands. SSL is enabled when PGSSLMODE=require (hosted
 * providers) — never for a plain localhost dev/CI database.
 */
function postgresConfig() {
  const cfg = {};
  const url = databaseUrl();
  if (url) {
    cfg.connectionString = url;
  } else {
    if (trimmed(process.env.PGHOST)) cfg.host = trimmed(process.env.PGHOST);
    if (trimmed(process.env.PGPORT)) cfg.port = positiveIntFromEnv(process.env.PGPORT, 5432);
    if (trimmed(process.env.PGUSER)) cfg.user = trimmed(process.env.PGUSER);
    if (process.env.PGPASSWORD !== undefined) cfg.password = String(process.env.PGPASSWORD);
    if (trimmed(process.env.PGDATABASE)) cfg.database = trimmed(process.env.PGDATABASE);
  }
  if (trimmed(process.env.PGSSLMODE).toLowerCase() === 'require') {
    cfg.ssl = { rejectUnauthorized: false };
  }
  return cfg;
}

/** True when enough Postgres connection info exists to attempt a connection. */
function hasPostgresConnection() {
  return !!(databaseUrl() || trimmed(process.env.PGHOST) || trimmed(process.env.PGDATABASE));
}

// ── Session / cookie auth ───────────────────────────────────────────────────
const SESSION_COOKIE_NAME = 'benchone_session';

function sessionTtlSeconds() {
  return positiveIntFromEnv(process.env.SESSION_TTL_SECONDS, 12 * 60 * 60);
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
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

function isAllowedOrigin(origin) {
  if (!origin) return false;
  const normalized = String(origin).trim().replace(/\/+$/, '');
  return allowedOrigins().includes(normalized);
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
    sessionTtlSeconds: sessionTtlSeconds(),
    cookieSecure: cookieSecure(),
    cookieSameSite: cookieSameSite(),
    allowedOrigins: allowedOrigins(),
    supportedRTarget: supportedRTarget()
  };
}

/**
 * Validate runtime configuration. Cookie invariants are enforced in every
 * environment because browsers reject unsafe SameSite=None cookies regardless of
 * NODE_ENV; the remaining hosted-service requirements are production-only.
 * Returns an array of human-readable error strings (empty === OK). Never echoes
 * secret values — only names the missing/invalid variable.
 */
function validateProductionConfig() {
  const errors = validateCookieConfig();
  if (!isProduction()) return errors;

  if (!trimmed(process.env.SESSION_SECRET)) {
    errors.push('SESSION_SECRET must be set in production.');
  }
  if (!hasPostgresConnection()) {
    errors.push('DATABASE_URL (or PGHOST/PGDATABASE) must be set for the Postgres backend.');
  }
  if (!trimmed(process.env.FRONTEND_ORIGIN) && !trimmed(process.env.FRONTEND_URL)) {
    errors.push('FRONTEND_ORIGIN must be set in production so CORS/CSRF are not left at the dev default.');
  }
  if (!cookieSecure()) {
    errors.push('Session cookies must be Secure in production (do not set COOKIE_SECURE=false).');
  }
  if (cookieSameSite() === 'None') {
    const insecureOrigins = allowedOrigins().filter((origin) => {
      try {
        return new URL(origin).protocol !== 'https:';
      } catch {
        return true;
      }
    });
    if (insecureOrigins.length > 0) {
      errors.push('COOKIE_SAMESITE=None is for cross-site cookie deployments and requires every FRONTEND_ORIGIN to use https:// in production.');
    }
  }
  if (!isValidPositiveIntOverride(process.env.MAX_UPLOAD_BYTES)) {
    errors.push('MAX_UPLOAD_BYTES must be a positive integer when set.');
  }
  if (!isValidPositiveIntOverride(process.env.MAX_UPLOAD_FILES)) {
    errors.push('MAX_UPLOAD_FILES must be a positive integer when set.');
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
  SESSION_COOKIE_NAME,
  sessionTtlSeconds,
  cookieSecure,
  cookieSameSite,
  validateCookieConfig,
  allowedOrigins,
  isAllowedOrigin,
  plumberPort,
  rBackendUrl,
  storageRoot,
  vaultRoot,
  maxUploadBytes,
  maxUploadFiles,
  supportedRTarget,
  summary,
  validateProductionConfig
};
