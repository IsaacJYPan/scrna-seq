import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { CONTENT_SECURITY_POLICY, securityHeaders } = require('./securityHeaders');

function run({ path = '/api/x', secure = false } = {}) {
  const headers = {};
  const res = {
    statusCode: 200,
    body: null,
    setHeader: (name, value) => { headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  const next = vi.fn();
  securityHeaders({ path, secure }, res, next);
  return { headers, res, next };
}

describe('securityHeaders', () => {
  const originalEnv = process.env.NODE_ENV;
  afterEach(() => { process.env.NODE_ENV = originalEnv; });

  it('sets browser hardening headers without HSTS outside production', () => {
    process.env.NODE_ENV = 'test';
    const { headers, next } = run();
    expect(next).toHaveBeenCalledOnce();
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['X-Frame-Options']).toBe('DENY');
    expect(headers['Referrer-Policy']).toBe('no-referrer');
    expect(headers['Content-Security-Policy']).toBe(CONTENT_SECURITY_POLICY);
    expect(CONTENT_SECURITY_POLICY).toContain("frame-ancestors 'none'");
    expect(CONTENT_SECURITY_POLICY).toContain("script-src 'self'");
    expect(headers['Strict-Transport-Security']).toBeUndefined();
  });

  it('requires HTTPS in production except for health probes, and sends HSTS over HTTPS', () => {
    process.env.NODE_ENV = 'production';
    const plain = run({ secure: false });
    expect(plain.next).not.toHaveBeenCalled();
    expect(plain.res.statusCode).toBe(426);

    const probe = run({ path: '/readyz', secure: false });
    expect(probe.next).toHaveBeenCalledOnce();

    const secure = run({ secure: true });
    expect(secure.next).toHaveBeenCalledOnce();
    expect(secure.headers['Strict-Transport-Security']).toBe('max-age=31536000; includeSubDomains');
  });
});
