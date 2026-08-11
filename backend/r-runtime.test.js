import { describe, it, expect } from 'vitest';

const {
  MIN_EXTERNAL_TOKEN_LENGTH,
  STORAGE_PROBE_CONTENT,
  parseRBackendUrl,
  resolveRRuntimeConfig,
  buildRChildEnv,
} = require('./rRuntime');

describe('R runtime configuration boundary', () => {
  it('accepts loopback/private targets and explicitly allowlisted internal DNS only', () => {
    expect(parseRBackendUrl('http://127.0.0.1:8000').origin).toBe('http://127.0.0.1:8000');
    expect(parseRBackendUrl('http://10.0.4.8:8000').hostname).toBe('10.0.4.8');
    expect(parseRBackendUrl('http://r-compute.internal:8000', {
      R_BACKEND_ALLOWED_HOSTS: 'r-compute.internal',
    }).hostname).toBe('r-compute.internal');
    expect(() => parseRBackendUrl('https://example.com')).toThrow(/private|allowlisted/i);
    for (const deceptivePublicName of [
      'http://10.attacker.example:8000',
      'http://192.168.attacker.example:8000',
      'http://fc-public.example:8000',
    ]) {
      expect(() => parseRBackendUrl(deceptivePublicName)).toThrow(/private|allowlisted/i);
    }
  });

  it('rejects credentials, paths, query strings, fragments, and non-HTTP schemes', () => {
    for (const value of [
      'ftp://127.0.0.1/a',
      'http://user:pass@127.0.0.1:8000',
      'http://127.0.0.1:8000/private',
      'http://127.0.0.1:8000/?token=x',
      'http://127.0.0.1:8000/#x',
    ]) {
      expect(() => parseRBackendUrl(value)).toThrow();
    }
  });

  it('generates an ephemeral token only for an owned R runtime', () => {
    const owned = resolveRRuntimeConfig({ PLUMBER_PORT: '8123' }, { role: 'web' });
    expect(owned.mode).toBe('owned');
    expect(owned.baseUrl).toBe('http://127.0.0.1:8123');
    expect(owned.token.length).toBeGreaterThanOrEqual(MIN_EXTERNAL_TOKEN_LENGTH);
  });

  it('requires a strong, separate token for external/standalone R access', () => {
    expect(() => resolveRRuntimeConfig({
      R_RUNTIME_MODE: 'external',
      R_BACKEND_URL: 'http://127.0.0.1:8000',
    }, { role: 'worker' })).toThrow(/R_API_TOKEN/);
    expect(() => resolveRRuntimeConfig({
      R_RUNTIME_MODE: 'external',
      R_BACKEND_URL: 'http://127.0.0.1:8000',
      R_API_TOKEN: 'short',
    }, { role: 'worker' })).toThrow(/at least/);
    expect(() => resolveRRuntimeConfig({}, { role: 'worker' })).toThrow(/external/);

    const external = resolveRRuntimeConfig({
      R_RUNTIME_MODE: 'external',
      R_BACKEND_URL: 'http://127.0.0.1:8000',
      R_API_TOKEN: 'x'.repeat(MIN_EXTERNAL_TOKEN_LENGTH),
    }, { role: 'worker' });
    expect(external.mode).toBe('external');
    expect(external.token).toBe('x'.repeat(MIN_EXTERNAL_TOKEN_LENGTH));
  });

  it('requires transport protection for non-loopback production R services', () => {
    const base = {
      NODE_ENV: 'production',
      R_RUNTIME_MODE: 'external',
      R_BACKEND_ALLOWED_HOSTS: 'r-compute.internal',
      R_API_TOKEN: 'x'.repeat(MIN_EXTERNAL_TOKEN_LENGTH),
    };
    expect(() => resolveRRuntimeConfig({
      ...base,
      R_BACKEND_URL: 'http://r-compute.internal:8000',
    }, { role: 'worker' })).toThrow(/HTTPS/);
    expect(resolveRRuntimeConfig({
      ...base,
      R_BACKEND_URL: 'https://r-compute.internal',
    }, { role: 'worker' }).protocol).toBe('https:');
    expect(resolveRRuntimeConfig({
      ...base,
      R_BACKEND_URL: 'http://r-compute.internal:8000',
      R_BACKEND_ALLOW_INSECURE_PRIVATE_HTTP: 'true',
    }, { role: 'worker' }).protocol).toBe('http:');
  });
});

describe('owned R child environment isolation', () => {
  it('passes only required OS/runtime fields and excludes control-plane secrets', () => {
    const child = buildRChildEnv({
      PATH: 'safe-path',
      TEMP: 'safe-temp',
      SESSION_SECRET: 'session-canary',
      DATABASE_URL: 'postgres://db-canary',
      PGPASSWORD: 'pg-canary',
      AWS_SECRET_ACCESS_KEY: 'cloud-canary',
      UNRELATED_CANARY_SECRET: 'other-canary',
      NODE_ENV: 'test',
    }, {
      token: 'r-token',
      port: 8123,
      storageRoot: process.cwd(),
      analysisRoot: process.cwd(),
    });

    expect(child.PATH).toBe('safe-path');
    expect(child.API_TOKEN).toBe('r-token');
    expect(child.PLUMBER_PORT).toBe('8123');
    expect(child.NODE_ENV).toBe('test');
    expect(JSON.stringify(child)).not.toMatch(/session-canary|db-canary|pg-canary|cloud-canary|other-canary/);
    expect(child).not.toHaveProperty('SESSION_SECRET');
    expect(child).not.toHaveProperty('DATABASE_URL');
    expect(child).not.toHaveProperty('PGPASSWORD');
    expect(child).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
  });

  it('pins the shared-storage probe content to a non-secret stable marker', () => {
    expect(STORAGE_PROBE_CONTENT).toBe('traceomics-shared-storage-v1\n');
  });

  it('passes the controlled Seurat delay only with non-production test diagnostics', () => {
    const options = {
      token: 'r-token', port: 8123, storageRoot: process.cwd(), analysisRoot: process.cwd(),
    };
    expect(buildRChildEnv({
      NODE_ENV: 'test', ENABLE_R_TEST_DIAGNOSTICS: 'true', R_TEST_SEURAT_DELAY_MS: '16000',
    }, options)).toMatchObject({
      ENABLE_R_TEST_DIAGNOSTICS: 'true', R_TEST_SEURAT_DELAY_MS: '16000',
    });
    expect(buildRChildEnv({
      NODE_ENV: 'production', ENABLE_R_TEST_DIAGNOSTICS: 'true', R_TEST_SEURAT_DELAY_MS: '16000',
    }, options)).not.toHaveProperty('R_TEST_SEURAT_DELAY_MS');
    expect(buildRChildEnv({
      NODE_ENV: 'test', ENABLE_R_TEST_DIAGNOSTICS: 'true', R_TEST_SEURAT_DELAY_MS: '999999',
    }, options)).not.toHaveProperty('R_TEST_SEURAT_DELAY_MS');
  });

  it('passes the controlled DEG delay only with non-production test diagnostics', () => {
    const options = {
      token: 'r-token', port: 8123, storageRoot: process.cwd(), analysisRoot: process.cwd(),
    };
    expect(buildRChildEnv({
      NODE_ENV: 'test', ENABLE_R_TEST_DIAGNOSTICS: 'true', R_TEST_DEG_DELAY_MS: '16000',
    }, options)).toMatchObject({
      ENABLE_R_TEST_DIAGNOSTICS: 'true', R_TEST_DEG_DELAY_MS: '16000',
    });
    expect(buildRChildEnv({
      NODE_ENV: 'production', ENABLE_R_TEST_DIAGNOSTICS: 'true', R_TEST_DEG_DELAY_MS: '16000',
    }, options)).not.toHaveProperty('R_TEST_DEG_DELAY_MS');
    expect(buildRChildEnv({
      NODE_ENV: 'test', ENABLE_R_TEST_DIAGNOSTICS: 'true', R_TEST_DEG_DELAY_MS: '999999',
    }, options)).not.toHaveProperty('R_TEST_DEG_DELAY_MS');
  });

  it('passes only validated live-session cache limits to an owned R child', () => {
    const options = {
      token: 'r-token', port: 8123, storageRoot: process.cwd(), analysisRoot: process.cwd(),
    };
    const child = buildRChildEnv({
      R_MAX_ACTIVE_SESSIONS: '8',
      R_MAX_ACTIVE_SESSIONS_PER_USER: '4',
      R_MAX_ACTIVE_SESSION_BYTES: '4294967296',
      R_MAX_ACTIVE_SESSION_BYTES_PER_USER: '2147483648',
      R_MAX_ACTIVE_SESSION_BYTES_PER_SESSION: '1073741824',
      R_UNRELATED_SECRET: 'must-not-cross',
    }, options);
    expect(child).toMatchObject({
      R_MAX_ACTIVE_SESSIONS: '8',
      R_MAX_ACTIVE_SESSIONS_PER_USER: '4',
      R_MAX_ACTIVE_SESSION_BYTES: '4294967296',
      R_MAX_ACTIVE_SESSION_BYTES_PER_USER: '2147483648',
      R_MAX_ACTIVE_SESSION_BYTES_PER_SESSION: '1073741824',
    });
    expect(JSON.stringify(child)).not.toContain('must-not-cross');
    for (const value of ['0', '-1', '1.5', 'not-a-number', '9999999999999999']) {
      expect(() => buildRChildEnv({ R_MAX_ACTIVE_SESSIONS: value }, options))
        .toThrow(/positive safe integer/i);
    }
  });
});
