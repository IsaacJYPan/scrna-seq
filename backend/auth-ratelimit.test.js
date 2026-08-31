/**
 * Auth rate-limiting regression tests (audit finding 1).
 *
 * Proves that POST /api/auth/login and /api/auth/signup eventually return 429
 * under rapid repeated attempts, while normal below-the-limit traffic still
 * works. The limit/window are driven by env vars so the test is deterministic,
 * and each limiter's state is reset between tests so rate-limit state never
 * leaks across cases.
 *
 * Would fail before the fix: without a limiter, repeated attempts never return
 * 429.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';

const config = require('./config');
const db = require('./pgDatabase');
const { startServer, api, serverModule } = require('./_http-test-utils');

const CONFIGURED = config.hasPostgresConnection();
const TEST_PASSWORD = 'violet-harbor-orbits-42';

let server;
let prev;

const MAX = 3;

beforeAll(async () => {
  if (!CONFIGURED) return;
  prev = {
    max: process.env.AUTH_RATE_LIMIT_MAX,
    windowMs: process.env.AUTH_RATE_LIMIT_WINDOW_MS,
    disabled: process.env.DISABLE_RATE_LIMIT
  };
  process.env.AUTH_RATE_LIMIT_MAX = String(MAX);
  // A long window so the limiter never resets mid-test.
  process.env.AUTH_RATE_LIMIT_WINDOW_MS = String(60 * 60 * 1000);
  delete process.env.DISABLE_RATE_LIMIT;
  server = await startServer();
});

afterAll(async () => {
  if (!CONFIGURED) return;
  if (server) await new Promise((resolve) => server.close(resolve));
  await db.close();
  if (prev.max === undefined) delete process.env.AUTH_RATE_LIMIT_MAX; else process.env.AUTH_RATE_LIMIT_MAX = prev.max;
  if (prev.windowMs === undefined) delete process.env.AUTH_RATE_LIMIT_WINDOW_MS; else process.env.AUTH_RATE_LIMIT_WINDOW_MS = prev.windowMs;
  if (prev.disabled === undefined) delete process.env.DISABLE_RATE_LIMIT; else process.env.DISABLE_RATE_LIMIT = prev.disabled;
});

beforeEach(async () => {
  if (!CONFIGURED) return;
  await db.resetSchemaForTests();
  // Clear limiter state so counts never leak between tests.
  serverModule.loginRateLimiter.reset();
  serverModule.signupRateLimiter.reset();
});

function signup(email) {
  return api(server, '/api/auth/signup', {
    method: 'POST',
    body: { email, password: TEST_PASSWORD, displayName: email.split('@')[0] }
  });
}

function login(email, password = TEST_PASSWORD) {
  return api(server, '/api/auth/login', { method: 'POST', body: { email, password } });
}

describe.skipIf(!CONFIGURED)('auth rate limiting', () => {
  it('allows normal signup/login below the limit', async () => {
    const s = await signup('normal@example.com');
    expect(s.status).toBe(201);

    const l = await login('normal@example.com');
    expect(l.status).toBe(200);
    expect(l.data.token).toBeUndefined();
    expect(l.data.user.email).toBe('normal@example.com');
  });

  it('returns 429 once rapid signup attempts exceed the limit', async () => {
    const statuses = [];
    // First MAX attempts pass through to the handler; the next is rate-limited.
    for (let i = 0; i < MAX; i++) {
      statuses.push((await signup(`signup${i}@example.com`)).status);
    }
    const limited = await signup(`signup-overflow@example.com`);
    statuses.push(limited.status);

    expect(statuses.slice(0, MAX).every(s => s === 201)).toBe(true);
    expect(limited.status).toBe(429);
    expect(limited.data.error).toMatch(/too many/i);
  });

  it('returns 429 once rapid login attempts exceed the limit', async () => {
    expect((await signup('victim@example.com')).status).toBe(201);
    serverModule.loginRateLimiter.reset(); // isolate the login budget from any prior call

    const statuses = [];
    for (let i = 0; i < MAX; i++) {
      // Wrong password: still a real attempt that the limiter must count.
      statuses.push((await login('victim@example.com', 'wrong-password')).status);
    }
    const limited = await login('victim@example.com', 'wrong-password');

    expect(statuses.every(s => s === 401)).toBe(true);
    expect(limited.status).toBe(429);
  });

  it('keeps login and signup budgets separate', async () => {
    // sep0 is created on the first (under-limit) signup; later signups overflow.
    for (let i = 0; i <= MAX; i++) await signup(`sep${i}@example.com`);
    expect((await signup('sep-final@example.com')).status).toBe(429);

    // Login is unaffected because it has its own separate limiter budget.
    const l = await login('sep0@example.com');
    expect(l.status).toBe(200);
  });
});

// ── DISABLE_RATE_LIMIT must not take effect in production ────────────────────
// The escape hatch is dev/test-only. Setting it in production must NOT remove
// rate limiting — otherwise a stray env var silently disables a security
// control. Would fail before the fix: the old guard was a bare
// `DISABLE_RATE_LIMIT === 'true'` check with no NODE_ENV gate.
describe.skipIf(!CONFIGURED)('rate-limit disable behavior across environments', () => {
  let prevNodeEnv;
  let prevSessionEpoch;

  beforeEach(() => {
    prevNodeEnv = process.env.NODE_ENV;
    prevSessionEpoch = process.env.SESSION_EPOCH;
  });
  afterEach(() => {
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prevNodeEnv;
    if (prevSessionEpoch === undefined) delete process.env.SESSION_EPOCH; else process.env.SESSION_EPOCH = prevSessionEpoch;
    delete process.env.DISABLE_RATE_LIMIT;
    serverModule.signupRateLimiter.reset();
    serverModule.loginRateLimiter.reset();
  });

  it('ignores DISABLE_RATE_LIMIT in production (still rate-limits)', async () => {
    process.env.NODE_ENV = 'production';
    process.env.SESSION_EPOCH = '4f8c2a6e1d9b3075c4e8a2f6d1b93570';
    process.env.DISABLE_RATE_LIMIT = 'true';
    expect(serverModule.rateLimitDisabled()).toBe(false);
    expect((await signup('production-signup@example.com')).status).toBe(403);

    await db.createUser('prod-victim@example.com', 'password123', 'Prod Victim');
    const statuses = [];
    for (let i = 0; i < MAX; i++) statuses.push((await login('prod-victim@example.com', 'wrong-password')).status);
    const overflow = await login('prod-victim@example.com', 'wrong-password');

    expect(statuses.slice(0, MAX).every(s => s === 401)).toBe(true);
    expect(overflow.status).toBe(429); // production never honors the disable flag
  });

  it('honors DISABLE_RATE_LIMIT outside production (no limiting)', async () => {
    process.env.NODE_ENV = 'development';
    process.env.DISABLE_RATE_LIMIT = 'true';
    expect(serverModule.rateLimitDisabled()).toBe(true);

    const statuses = [];
    // Well past MAX; every attempt should pass because limiting is disabled.
    for (let i = 0; i < MAX + 3; i++) statuses.push((await signup(`dev${i}@example.com`)).status);
    expect(statuses.every(s => s === 201)).toBe(true);
  });
});

// ── Malformed limiter env must fall closed to safe defaults ──────────────────
// A non-numeric / non-positive AUTH_RATE_LIMIT_MAX or _WINDOW_MS must not make
// the limiter no-op (the old `Number(...)` produced NaN → `count > NaN` is
// always false → limiting silently skipped). The parser now falls back to the
// secure defaults. Would fail before the fix (these returned NaN).
describe('malformed rate-limit env falls closed to defaults', () => {
  const DEFAULT_MAX = 10;
  const DEFAULT_WINDOW = 15 * 60 * 1000;
  let prevMax;
  let prevWindow;

  beforeEach(() => {
    prevMax = process.env.AUTH_RATE_LIMIT_MAX;
    prevWindow = process.env.AUTH_RATE_LIMIT_WINDOW_MS;
  });
  afterEach(() => {
    if (prevMax === undefined) delete process.env.AUTH_RATE_LIMIT_MAX; else process.env.AUTH_RATE_LIMIT_MAX = prevMax;
    if (prevWindow === undefined) delete process.env.AUTH_RATE_LIMIT_WINDOW_MS; else process.env.AUTH_RATE_LIMIT_WINDOW_MS = prevWindow;
  });

  const badValues = ['abc', 'NaN', '', '   ', '0', '-5', 'Infinity', '10.5', '1e9999'];

  it.each(badValues)('AUTH_RATE_LIMIT_MAX="%s" falls back to the default', (val) => {
    process.env.AUTH_RATE_LIMIT_MAX = val;
    expect(serverModule.authRateLimitMax()).toBe(DEFAULT_MAX);
  });

  it.each(badValues)('AUTH_RATE_LIMIT_WINDOW_MS="%s" falls back to the default', (val) => {
    process.env.AUTH_RATE_LIMIT_WINDOW_MS = val;
    expect(serverModule.authRateLimitWindowMs()).toBe(DEFAULT_WINDOW);
  });

  it('still honors valid positive-integer overrides', () => {
    process.env.AUTH_RATE_LIMIT_MAX = '4';
    process.env.AUTH_RATE_LIMIT_WINDOW_MS = '1000';
    expect(serverModule.authRateLimitMax()).toBe(4);
    expect(serverModule.authRateLimitWindowMs()).toBe(1000);
  });

  it('an unset override uses the default', () => {
    delete process.env.AUTH_RATE_LIMIT_MAX;
    delete process.env.AUTH_RATE_LIMIT_WINDOW_MS;
    expect(serverModule.authRateLimitMax()).toBe(DEFAULT_MAX);
    expect(serverModule.authRateLimitWindowMs()).toBe(DEFAULT_WINDOW);
  });
});

describe('auth rate-limit key storage', () => {
  it('caps one-off client keys and fails closed for a new address', () => {
    const previousDisabled = process.env.DISABLE_RATE_LIMIT;
    const previousMax = process.env.AUTH_RATE_LIMIT_MAX;
    const previousWindow = process.env.AUTH_RATE_LIMIT_WINDOW_MS;
    delete process.env.DISABLE_RATE_LIMIT;
    process.env.AUTH_RATE_LIMIT_MAX = '100';
    process.env.AUTH_RATE_LIMIT_WINDOW_MS = '3600000';
    try {
      const limiter = serverModule.createRateLimiter();
      const response = () => {
        const state = { statusCode: null, body: null, headers: {} };
        return {
          state,
          setHeader: (name, value) => { state.headers[name] = value; },
          status: (code) => ({ json: (body) => { state.statusCode = code; state.body = body; } }),
        };
      };
      for (let i = 0; i < serverModule.MAX_AUTH_RATE_LIMIT_KEYS; i += 1) {
        const res = response();
        let passed = false;
        limiter({ ip: `198.51.${Math.floor(i / 256)}.${i % 256}` }, res, () => { passed = true; });
        expect(passed).toBe(true);
      }
      expect(limiter.keyCount()).toBe(serverModule.MAX_AUTH_RATE_LIMIT_KEYS);

      const overflow = response();
      let passed = false;
      limiter({ ip: '203.0.113.250' }, overflow, () => { passed = true; });
      expect(passed).toBe(false);
      expect(overflow.state.statusCode).toBe(429);
      expect(limiter.keyCount()).toBe(serverModule.MAX_AUTH_RATE_LIMIT_KEYS);
    } finally {
      if (previousDisabled === undefined) delete process.env.DISABLE_RATE_LIMIT; else process.env.DISABLE_RATE_LIMIT = previousDisabled;
      if (previousMax === undefined) delete process.env.AUTH_RATE_LIMIT_MAX; else process.env.AUTH_RATE_LIMIT_MAX = previousMax;
      if (previousWindow === undefined) delete process.env.AUTH_RATE_LIMIT_WINDOW_MS; else process.env.AUTH_RATE_LIMIT_WINDOW_MS = previousWindow;
    }
  });
});
