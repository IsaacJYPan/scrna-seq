/**
 * Config module contract (unit-only). Verifies environment boundaries:
 * backend selection, cookie/secure defaults, allowed-origin parsing, the
 * production validation gate, and that summary() never leaks secrets.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
const config = require('./config');

const SAVED = {};
const KEYS = [
  'NODE_ENV', 'DATABASE_BACKEND', 'DATABASE_URL', 'PGHOST', 'PGDATABASE',
  'SESSION_SECRET', 'SESSION_TTL_SECONDS', 'COOKIE_SECURE', 'COOKIE_SAMESITE',
  'FRONTEND_ORIGIN', 'FRONTEND_URL', 'R_BACKEND_URL', 'PLUMBER_PORT'
];

beforeEach(() => { KEYS.forEach((k) => { SAVED[k] = process.env[k]; delete process.env[k]; }); });
afterEach(() => { KEYS.forEach((k) => { if (SAVED[k] === undefined) delete process.env[k]; else process.env[k] = SAVED[k]; }); });

describe('database backend selection', () => {
  it('defaults to sqlite with no config', () => {
    expect(config.databaseBackend()).toBe('sqlite');
  });
  it('infers postgres when DATABASE_URL is present', () => {
    process.env.DATABASE_URL = 'postgres://u:p@localhost:5432/db';
    expect(config.databaseBackend()).toBe('postgres');
    expect(config.hasPostgresConnection()).toBe(true);
  });
  it('honors an explicit DATABASE_BACKEND=sqlite even with a URL', () => {
    process.env.DATABASE_URL = 'postgres://u:p@localhost:5432/db';
    process.env.DATABASE_BACKEND = 'sqlite';
    expect(config.databaseBackend()).toBe('sqlite');
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
  it('is satisfied when production vars are all present and safe', () => {
    process.env.NODE_ENV = 'production';
    process.env.SESSION_SECRET = 'a-strong-secret';
    process.env.DATABASE_URL = 'postgres://u:p@localhost:5432/db';
    process.env.FRONTEND_ORIGIN = 'https://app.example.com';
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
    process.env.NODE_ENV = 'production';
    process.env.SESSION_SECRET = 'a-strong-secret';
    process.env.DATABASE_URL = 'postgres://u:p@localhost:5432/db';
    process.env.FRONTEND_ORIGIN = 'https://app.example.com';
    process.env.COOKIE_SAMESITE = 'none';
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
    expect(serialized).not.toContain('top-secret-value');
    expect(serialized).not.toContain('password');
  });
});
