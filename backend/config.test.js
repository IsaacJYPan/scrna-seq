/**
 * Config module contract (unit-only). Verifies environment boundaries:
 * Postgres-only database selection, cookie/secure defaults, allowed-origin parsing, the
 * production validation gate, and that summary() never leaks secrets.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
const config = require('./config');
const { Client } = require('pg');

const VALID_R_API_TOKEN = '9f2c1a7e4b8d6035c7e91f2a4d6b8c0e13579bdf2468ace05731d9fb62e4a8c5';
const VALID_SESSION_SECRET = 'a3f91c7e5b2d8046f8a1c3e597b2d4f6081a3c5e7f9b2d4a6c8e0f13579bdf24';
const VALID_SESSION_EPOCH = '4f8c2a6e1d9b3075c4e8a2f6d1b93570';

const SAVED = {};
const KEYS = [
  'NODE_ENV', 'DATABASE_BACKEND', 'DATABASE_URL', 'PGHOST', 'PGDATABASE',
  'SESSION_SECRET', 'SESSION_EPOCH', 'SESSION_TTL_SECONDS', 'COOKIE_SECURE', 'COOKIE_SAMESITE',
  'FRONTEND_ORIGIN', 'FRONTEND_URL', 'R_RUNTIME_MODE', 'R_BACKEND_URL',
  'R_BACKEND_ALLOWED_HOSTS', 'R_API_TOKEN', 'PLUMBER_PORT',
  'STORAGE_ROOT', 'VAULT_ROOT', 'MAX_UPLOAD_BYTES', 'MAX_UPLOAD_FILES',
  'R_PROXY_TIMEOUT_MS', 'R_PROXY_MAX_RESPONSE_BYTES',
  'R_PROXY_RATE_LIMIT_WINDOW_MS', 'R_PROXY_RATE_LIMIT_MAX',
  'R_PROXY_MAX_CONCURRENT', 'PGSSLMODE', 'PG_POOL_MAX',
  'PG_CONNECT_TIMEOUT_MS', 'PG_IDLE_TIMEOUT_MS', 'PORT', 'WEB_HOST',
  'TRUST_PROXY_HOPS', 'WEB_SHUTDOWN_TIMEOUT_MS', 'WEB_DRAIN_DELAY_MS'
  , 'APP_DEPLOYMENT_MODE', 'DEMO_GUEST_TTL_SECONDS', 'DEMO_TEMPLATE_PROJECT_ID',
  'EXPERT_R_ENABLED', 'EXPERT_R_SANDBOX_URL', 'EXPERT_R_SANDBOX_TOKEN'
];

function setValidProduction(overrides = {}) {
  Object.assign(process.env, {
    NODE_ENV: 'production',
    APP_DEPLOYMENT_MODE: 'private',
    SESSION_SECRET: VALID_SESSION_SECRET,
    SESSION_EPOCH: VALID_SESSION_EPOCH,
    DATABASE_URL: 'postgres://u:p@localhost:5432/db',
    FRONTEND_ORIGIN: 'https://app.example.com',
    R_RUNTIME_MODE: 'external',
    R_BACKEND_URL: 'http://127.0.0.1:8000',
    TRUST_PROXY_HOPS: '1',
    STORAGE_ROOT: path.resolve('deployment-storage'),
    VAULT_ROOT: path.resolve('deployment-vault'),
    ...overrides,
  });
}

beforeEach(() => {
  KEYS.forEach((k) => { SAVED[k] = process.env[k]; delete process.env[k]; });
  process.env.R_API_TOKEN = VALID_R_API_TOKEN;
});
afterEach(() => { KEYS.forEach((k) => { if (SAVED[k] === undefined) delete process.env[k]; else process.env[k] = SAVED[k]; }); });

describe('database backend selection', () => {
  it('defaults to postgres with no config', () => {
    expect(config.databaseBackend()).toBe('postgres');
    expect(config.hasPostgresConnection()).toBe(false);
  });
  it('infers postgres when DATABASE_URL is present', () => {
    process.env.DATABASE_URL = 'postgres://u:p@localhost:5432/db';
    expect(config.databaseBackend()).toBe('postgres');
    expect(config.hasPostgresConnection()).toBe(true);
  });
  it('ignores legacy DATABASE_BACKEND=sqlite even with a URL', () => {
    process.env.DATABASE_URL = 'postgres://u:p@localhost:5432/db';
    process.env.DATABASE_BACKEND = 'sqlite';
    expect(config.databaseBackend()).toBe('postgres');
    expect(config.hasPostgresConnection()).toBe(true);
  });
  it('builds a pg config from PG* vars when no URL is set', () => {
    process.env.PGHOST = 'db.internal';
    process.env.PGDATABASE = 'scrna';
    const cfg = config.postgresConfig();
    expect(cfg.host).toBe('db.internal');
    expect(cfg.database).toBe('scrna');
    expect(cfg.connectionString).toBeUndefined();
  });
});

describe('cookie + origin boundaries', () => {
  it('keeps production registration operator-only', () => {
    process.env.NODE_ENV = 'development';
    expect(config.registrationEnabled()).toBe(true);
    process.env.NODE_ENV = 'test';
    expect(config.registrationEnabled()).toBe(true);
    process.env.NODE_ENV = 'production';
    expect(config.registrationEnabled()).toBe(false);
    expect(config.summary().registrationMode).toBe('operator-only');
  });
  it('disables ordinary registration in demo mode outside production too', () => {
    process.env.NODE_ENV = 'development';
    process.env.APP_DEPLOYMENT_MODE = 'demo';
    expect(config.demoMode()).toBe(true);
    expect(config.registrationEnabled()).toBe(false);
  });
  it('defaults cookies to non-secure in dev and secure in production', () => {
    expect(config.cookieSecure()).toBe(false);
    process.env.NODE_ENV = 'production';
    expect(config.cookieSecure()).toBe(true);
  });
  it('defaults SameSite to Lax and accepts overrides', () => {
    expect(config.cookieSameSite()).toBe('Lax');
    process.env.COOKIE_SAMESITE = 'strict';
    expect(config.cookieSameSite()).toBe('Strict');
  });
  it('rejects SameSite=None without Secure cookies even outside production', () => {
    process.env.COOKIE_SAMESITE = 'none';
    process.env.COOKIE_SECURE = 'false';
    const errors = config.validateCookieConfig();
    expect(errors.join(' ')).toMatch(/COOKIE_SAMESITE=None/);
  });
  it('allows SameSite=None outside production when Secure cookies are enabled', () => {
    process.env.COOKIE_SAMESITE = 'none';
    process.env.COOKIE_SECURE = 'true';
    expect(config.validateCookieConfig()).toEqual([]);
  });
  it('parses a comma-separated origin allowlist and strips trailing slashes', () => {
    process.env.FRONTEND_ORIGIN = 'https://app.example.com/, https://admin.example.com';
    expect(config.allowedOrigins()).toEqual(['https://app.example.com', 'https://admin.example.com']);
    expect(config.isAllowedOrigin('https://app.example.com')).toBe(true);
    expect(config.isAllowedOrigin('https://evil.example.com')).toBe(false);
    expect(config.isAllowedOrigin(undefined)).toBe(false);
  });
});

describe('production validation gate', () => {
  it('passes in development regardless of missing vars', () => {
    expect(config.validateProductionConfig()).toEqual([]);
  });
  it('requires session secret, db connection, origin, and secure cookies in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.DATABASE_URL = 'postgres://u:p@localhost:5432/db'; // -> postgres backend
    process.env.COOKIE_SECURE = 'false';
    const errors = config.validateProductionConfig();
    expect(errors.join(' ')).toMatch(/SESSION_SECRET/);
    expect(errors.join(' ')).toMatch(/FRONTEND_ORIGIN/);
    expect(errors.join(' ')).toMatch(/Secure/);
  });
  it('requires a dedicated strong R service token in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.SESSION_SECRET = 'a-strong-secret';
    process.env.DATABASE_URL = 'postgres://u:p@localhost:5432/db';
    process.env.FRONTEND_ORIGIN = 'https://app.example.com';
    delete process.env.R_API_TOKEN;
    expect(config.validateProductionConfig().join(' ')).toMatch(/R_API_TOKEN/);
  });
  it('rejects long but predictable repeated session and R secrets', () => {
    setValidProduction({
      SESSION_SECRET: '0123456789abcdef'.repeat(2),
      R_API_TOKEN: 'abcdef0123456789'.repeat(2),
    });
    const errors = config.validateProductionConfig().join(' ');
    expect(errors).toMatch(/SESSION_SECRET/);
    expect(errors).toMatch(/R_API_TOKEN/);
  });
  it('rejects varied-looking sequences and uppercase encodings as generated secrets', () => {
    setValidProduction({
      SESSION_SECRET: 'abcdefghijklmnopqrstuvwxyz012345',
      R_API_TOKEN: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ012345',
    });
    const errors = config.validateProductionConfig().join(' ');
    expect(errors).toMatch(/SESSION_SECRET/);
    expect(errors).toMatch(/R_API_TOKEN/);
  });
  it('rejects uniform or periodic hex values and the development epoch sentinel', () => {
    setValidProduction({
      SESSION_SECRET: '0'.repeat(64),
      R_API_TOKEN: '0123456789abcdef'.repeat(4),
      SESSION_EPOCH: '0'.repeat(32),
    });
    const errors = config.validateProductionConfig().join(' ');
    expect(errors).toMatch(/SESSION_SECRET/);
    expect(errors).toMatch(/R_API_TOKEN/);
    expect(errors).toMatch(/SESSION_EPOCH/);
  });
  it('requires a canonical deployment session epoch in production', () => {
    setValidProduction({ SESSION_EPOCH: '' });
    expect(config.validateProductionConfig().join(' ')).toMatch(/SESSION_EPOCH/);
    process.env.SESSION_EPOCH = 'ABCDEF0123456789ABCDEF0123456789';
    expect(config.validateProductionConfig().join(' ')).toMatch(/lowercase hexadecimal/);
  });
  it('is satisfied when production vars are all present and safe', () => {
    setValidProduction();
    expect(config.validateProductionConfig()).toEqual([]);
  });
  it('rejects SameSite=None without Secure cookies (cross-origin misconfiguration)', () => {
    process.env.NODE_ENV = 'production';
    process.env.SESSION_SECRET = 'a-strong-secret';
    process.env.DATABASE_URL = 'postgres://u:p@localhost:5432/db';
    process.env.FRONTEND_ORIGIN = 'https://app.example.com';
    process.env.COOKIE_SAMESITE = 'none';
    process.env.COOKIE_SECURE = 'false';
    const errors = config.validateProductionConfig();
    expect(errors.join(' ')).toMatch(/COOKIE_SAMESITE=None/);
  });
  it('allows SameSite=None when Secure cookies are enabled', () => {
    setValidProduction({ COOKIE_SAMESITE: 'none' });
    expect(config.validateProductionConfig()).toEqual([]);
  });
  it('rejects SameSite=None with non-HTTPS frontend origins in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.SESSION_SECRET = 'a-strong-secret';
    process.env.DATABASE_URL = 'postgres://u:p@localhost:5432/db';
    process.env.FRONTEND_ORIGIN = 'http://app.example.com';
    process.env.COOKIE_SAMESITE = 'none';
    process.env.COOKIE_SECURE = 'true';
    const errors = config.validateProductionConfig();
    expect(errors.join(' ')).toMatch(/https:\/\/ in production/);
  });
  it('rejects malformed upload limit overrides in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.SESSION_SECRET = 'a-strong-secret';
    process.env.DATABASE_URL = 'postgres://u:p@localhost:5432/db';
    process.env.FRONTEND_ORIGIN = 'https://app.example.com';
    process.env.MAX_UPLOAD_BYTES = '0';
    process.env.MAX_UPLOAD_FILES = 'many';
    const errors = config.validateProductionConfig();
    expect(errors.join(' ')).toMatch(/MAX_UPLOAD_BYTES/);
    expect(errors.join(' ')).toMatch(/MAX_UPLOAD_FILES/);
  });
  it('uses bounded R proxy defaults and rejects malformed production overrides', () => {
    expect(config.rProxyTimeoutMs()).toBe(120000);
    expect(config.rProxyMaxResponseBytes()).toBe(8 * 1024 * 1024);
    expect(config.rProxyRateLimitWindowMs()).toBe(60000);
    expect(config.rProxyRateLimitMax()).toBe(60);
    expect(config.rProxyMaxConcurrent()).toBe(1);

    process.env.NODE_ENV = 'production';
    process.env.SESSION_SECRET = 'a-strong-secret';
    process.env.DATABASE_URL = 'postgres://u:p@localhost:5432/db';
    process.env.FRONTEND_ORIGIN = 'https://app.example.com';
    process.env.R_PROXY_TIMEOUT_MS = 'never';
    process.env.R_PROXY_MAX_RESPONSE_BYTES = '0';
    process.env.R_PROXY_MAX_CONCURRENT = '2';
    expect(config.validateProductionConfig().join(' ')).toMatch(/R_PROXY_TIMEOUT_MS/);
    expect(config.validateProductionConfig().join(' ')).toMatch(/R_PROXY_MAX_RESPONSE_BYTES/);
    expect(config.validateProductionConfig().join(' ')).toMatch(/R_PROXY_MAX_CONCURRENT/);
  });
  it('rejects overlapping storage and vault roots in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.SESSION_SECRET = 'a-strong-secret';
    process.env.DATABASE_URL = 'postgres://u:p@localhost:5432/db';
    process.env.FRONTEND_ORIGIN = 'https://app.example.com';
    process.env.STORAGE_ROOT = './data';
    process.env.VAULT_ROOT = './data/vault';
    const errors = config.validateProductionConfig();
    expect(errors.join(' ')).toMatch(/STORAGE_ROOT and VAULT_ROOT/);
  });

  it('rejects weak secrets, unsafe TTLs, malformed ports, and missing proxy trust', () => {
    setValidProduction({
      SESSION_SECRET: 'change-me',
      SESSION_TTL_SECONDS: '86401',
      PORT: '70000',
      TRUST_PROXY_HOPS: '',
    });
    const errors = config.validateProductionConfig().join(' ');
    expect(errors).toMatch(/SESSION_SECRET/);
    expect(errors).toMatch(/SESSION_TTL_SECONDS/);
    expect(errors).toMatch(/PORT/);
    expect(errors).toMatch(/TRUST_PROXY_HOPS/);
  });

  it('requires valid HTTPS browser origins and explicit persistent roots', () => {
    setValidProduction({
      FRONTEND_ORIGIN: 'https://app.example.com/path',
      STORAGE_ROOT: 'relative-data',
      VAULT_ROOT: 'relative-vault',
    });
    const errors = config.validateProductionConfig().join(' ');
    expect(errors).toMatch(/FRONTEND_ORIGIN/);
    expect(errors).toMatch(/STORAGE_ROOT/);
    expect(errors).toMatch(/VAULT_ROOT/);
  });

  it('requires an external shared R service for production roles', () => {
    setValidProduction({ R_RUNTIME_MODE: 'owned', R_BACKEND_URL: '' });
    expect(config.validateProductionConfig().join(' ')).toMatch(/R_RUNTIME_MODE=external/);
  });

  it('rejects unauthenticated TLS modes for a non-loopback Postgres host', () => {
    setValidProduction({
      DATABASE_URL: 'postgres://u:p@db.example.com:5432/db',
      PGSSLMODE: 'require',
    });
    const errors = config.validateProductionConfig().join(' ');
    expect(errors).toMatch(/Non-loopback Postgres/);
    expect(errors).toMatch(/Production Postgres sslmode/);
    process.env.PGSSLMODE = 'verify-full';
    expect(config.validateProductionConfig()).toEqual([]);
  });

  it('rejects conflicting, duplicate, and redirecting DATABASE_URL query options', () => {
    setValidProduction({
      DATABASE_URL: 'postgres://u:p@db.example.com:5432/db?sslmode=no-verify',
      PGSSLMODE: 'verify-full',
    });
    expect(config.validateProductionConfig().join(' ')).toMatch(/must not conflict/);

    process.env.DATABASE_URL = 'postgres://u:p@db.example.com:5432/db?sslmode=verify-full&host=attacker.example';
    delete process.env.PGSSLMODE;
    expect(config.validateProductionConfig().join(' ')).toMatch(/option host is not supported/);
    expect(() => config.postgresConfig()).toThrow(/unsupported connection options/);

    process.env.DATABASE_URL = 'postgres://u:p@db.example.com:5432/db?sslmode=verify-full&sslmode=no-verify';
    expect(config.validateProductionConfig().join(' ')).toMatch(/unique lowercase names/);
  });

  it('uses one authoritative verify-full mode for remote Postgres', () => {
    setValidProduction({
      DATABASE_URL: 'postgres://u:p@db.example.com:5432/db?sslmode=verify-full',
      PGSSLMODE: '',
    });
    expect(config.validateProductionConfig()).toEqual([]);
    const client = new Client(config.postgresConfig());
    expect(client.connectionParameters.ssl).not.toBe(false);
    expect(client.connectionParameters.ssl?.rejectUnauthorized).not.toBe(false);
  });

  it('rejects a one-connection pool because the topology lock reserves one client', () => {
    process.env.PG_POOL_MAX = '1';
    expect(config.validateProductionConfig().join(' ')).toMatch(/between 2 and 20/);
    setValidProduction({ PG_POOL_MAX: '1' });
    expect(config.validateProductionConfig().join(' ')).toMatch(/topology locks reserve one/);
  });

  it('validates the worker role without requiring browser/session settings', () => {
    setValidProduction();
    delete process.env.SESSION_SECRET;
    delete process.env.FRONTEND_ORIGIN;
    expect(config.validateProductionConfig({ role: 'worker' })).toEqual([]);
  });

  it('requires a bounded, Expert-R-free curated public demo configuration', () => {
    setValidProduction({
      APP_DEPLOYMENT_MODE: 'demo',
      DEMO_TEMPLATE_PROJECT_ID: 'proj_curated123',
      DEMO_GUEST_TTL_SECONDS: '7200',
      SESSION_TTL_SECONDS: '7200',
      EXPERT_R_ENABLED: 'false',
    });
    expect(config.validateProductionConfig()).toEqual([]);
    process.env.EXPERT_R_ENABLED = 'true';
    process.env.EXPERT_R_SANDBOX_URL = 'http://127.0.0.1:8090';
    process.env.EXPERT_R_SANDBOX_TOKEN = 'a'.repeat(64);
    expect(config.validateProductionConfig().join(' ')).toMatch(/must be false in public demo/i);
    process.env.EXPERT_R_ENABLED = 'false';
    process.env.DEMO_TEMPLATE_PROJECT_ID = '';
    expect(config.validateProductionConfig().join(' ')).toMatch(/DEMO_TEMPLATE_PROJECT_ID/);
  });

  it('fails closed for unknown deployment modes and non-loopback Expert R brokers', () => {
    setValidProduction({ APP_DEPLOYMENT_MODE: 'unexpected' });
    expect(config.validateProductionConfig().join(' ')).toMatch(/APP_DEPLOYMENT_MODE/);

    setValidProduction({
      EXPERT_R_ENABLED: 'true',
      EXPERT_R_SANDBOX_URL: 'http://broker.example:8090',
      EXPERT_R_SANDBOX_TOKEN: 'a'.repeat(64),
    });
    expect(config.validateProductionConfig().join(' ')).toMatch(/internal loopback/);

    process.env.EXPERT_R_SANDBOX_URL = 'http://127.0.0.1:8090';
    expect(config.validateProductionConfig()).toEqual([]);
  });
});

describe('summary() secret hygiene', () => {
  it('reports presence booleans but never the secret values', () => {
    process.env.SESSION_SECRET = 'top-secret-value';
    process.env.DATABASE_URL = 'postgres://user:password@host:5432/db';
    const s = config.summary();
    const serialized = JSON.stringify(s);
    expect(s.hasSessionSecret).toBe(true);
    expect(s.hasDatabaseUrl).toBe(true);
    expect(s.hasRApiToken).toBe(true);
    expect(serialized).not.toContain('top-secret-value');
    expect(serialized).not.toContain('password');
  });
});
