/**
 * R diagnostic-path gate normalization tests (audit finding 2).
 *
 * The old gate used `req.path.startsWith('/__test')`, which a double slash
 * (`//__test`) or an encoded slash (`%2F__test`) could slip past, reaching the
 * proxy/R even when diagnostics are disabled. These tests cover the normalizing
 * helper directly and prove that all spellings of the diagnostic prefix return
 * 404 before proxying when diagnostics are disabled or in production.
 *
 * Would fail before the fix: the `//__test` and `%2F__test` variants were not
 * recognized as diagnostic and so were not gated.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';

const { initDatabase, closeDatabase } = require('./database');
const { startServer, createUserWithToken, api } = require('./_http-test-utils');
const serverModule = require('../server.js');

const { isDiagnosticRProxyPath, isProductionDiagnosticRProxyPath } = serverModule.default || serverModule;

describe('isDiagnosticRProxyPath (normalized helper)', () => {
  it('recognizes the canonical diagnostic prefix', () => {
    expect(isDiagnosticRProxyPath('/__test')).toBe(true);
    expect(isDiagnosticRProxyPath('/__test/state-key')).toBe(true);
  });

  it('recognizes double-slash and encoded-slash variants', () => {
    expect(isDiagnosticRProxyPath('//__test')).toBe(true);
    expect(isDiagnosticRProxyPath('//__test/state-key')).toBe(true);
    expect(isDiagnosticRProxyPath('/%2F__test/state-key')).toBe(true);
    expect(isDiagnosticRProxyPath('/%2f__test')).toBe(true);
    expect(isDiagnosticRProxyPath('\\__test\\state-key')).toBe(true);
  });

  it('does not flag real analysis endpoints', () => {
    expect(isDiagnosticRProxyPath('/load-rds')).toBe(false);
    expect(isDiagnosticRProxyPath('/health')).toBe(false);
    expect(isDiagnosticRProxyPath('/__testing-not-diagnostic')).toBe(false);
  });

  it('respects production gating', () => {
    const prev = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      expect(isProductionDiagnosticRProxyPath('//__test/state-key')).toBe(true);
      expect(isProductionDiagnosticRProxyPath('/%2F__test')).toBe(true);
      expect(isProductionDiagnosticRProxyPath('/load-rds')).toBe(false);
      process.env.NODE_ENV = 'test';
      expect(isProductionDiagnosticRProxyPath('//__test/state-key')).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prev;
    }
  });
});

describe('R diagnostic gate (HTTP) returns 404 for all variants when disabled', () => {
  let server;
  let prevDiag;
  let prevNodeEnv;
  let token;

  beforeAll(async () => {
    prevDiag = process.env.ENABLE_R_TEST_DIAGNOSTICS;
    prevNodeEnv = process.env.NODE_ENV;
    server = await startServer();
  });

  afterAll(() => {
    if (server) server.close();
    if (prevDiag === undefined) delete process.env.ENABLE_R_TEST_DIAGNOSTICS; else process.env.ENABLE_R_TEST_DIAGNOSTICS = prevDiag;
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prevNodeEnv;
  });

  beforeEach(() => {
    initDatabase(':memory:');
    token = createUserWithToken({ email: 'diag@example.com', displayName: 'Diag' }).token;
  });
  afterEach(() => closeDatabase());

  const variants = [
    '/api/r/__test/state-key',
    '/api/r//__test/state-key',
    '/api/r/%2F__test/state-key'
  ];

  it.each(variants)('404s %s when diagnostics are disabled', async (path) => {
    process.env.ENABLE_R_TEST_DIAGNOSTICS = 'false';
    delete process.env.NODE_ENV;
    const res = await api(server, path, { token });
    expect(res.status).toBe(404);
  });

  it.each(variants)('404s %s in production even when diagnostics are enabled', async (path) => {
    process.env.ENABLE_R_TEST_DIAGNOSTICS = 'true';
    process.env.NODE_ENV = 'production';
    const res = await api(server, path, { token });
    expect(res.status).toBe(404);
  });
});
