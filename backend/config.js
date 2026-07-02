/**
 * Centralized runtime configuration + environment boundaries.
 *
 * This module is the single, documented place that reads process.env for the
 * hosted-service configuration surface: database backend selection, session /
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

function nodeEnv() {
  return trimmed(process.env.NODE_ENV) || 'development';
}

function isProduction() {
  return nodeEnv() === 'production';
}

// ── Database backend selection ──────────────────────────────────────────────
// The app is mid-migration from SQLite (local/test) to Postgres (hosted). The
// backend is chosen explicitly by DATABASE_BACKEND, else inferred: a present
// DATABASE_URL implies Postgres, otherwise SQLite. SQLite remains the default
// so local dev / the existing SQLite backend test suite are unaffected unless a
// deployment opts into Postgres.
function databaseBackend() {
  const raw = trimmed(process.env.DATABASE_BACKEND).toLowerCase();
  if (raw === 'postgres' || raw === 'postgresql' || raw === 'pg') return 'postgres';
  if (raw === 'sqlite') return 'sqlite';
  if (trimmed(process.env.DATABASE_URL)) return 'postgres';
  return 'sqlite';
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
 * Validate required production-like configuration. Returns an array of
 * human-readable error strings (empty === OK). server.js calls this at startup
 * and refuses to boot in production if it is non-empty. Never echoes secret
 * values — only names the missing/invalid variable.
 */
function validateProductionConfig() {
  const errors = [];
  if (!isProduction()) return errors;

  if (!trimmed(process.env.SESSION_SECRET)) {
    errors.push('SESSION_SECRET must be set in production.');
  }
  if (databaseBackend() === 'postgres' && !hasPostgresConnection()) {
    errors.push('DATABASE_URL (or PGHOST/PGDATABASE) must be set for the Postgres backend.');
  }
  if (!trimmed(process.env.FRONTEND_ORIGIN) && !trimmed(process.env.FRONTEND_URL)) {
    errors.push('FRONTEND_ORIGIN must be set in production so CORS/CSRF are not left at the dev default.');
  }
  if (!cookieSecure()) {
    errors.push('Session cookies must be Secure in production (do not set COOKIE_SECURE=false).');
  }
  if (cookieSameSite() === 'None' && !cookieSecure()) {
    errors.push('COOKIE_SAMESITE=None requires Secure cookies (COOKIE_SECURE must not be false) — browsers reject None cookies without Secure.');
  }
  return errors;
}

module.exports = {
  positiveIntFromEnv,
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
  allowedOrigins,
  isAllowedOrigin,
  plumberPort,
  rBackendUrl,
  supportedRTarget,
  summary,
  validateProductionConfig
};
