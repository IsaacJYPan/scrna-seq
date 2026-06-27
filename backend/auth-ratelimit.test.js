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

const { initDatabase, closeDatabase } = require('./database');
const { startServer, api, serverModule } = require('./_http-test-utils');

let server;
let prev;

const MAX = 3;

beforeAll(async () => {
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

afterAll(() => {
  if (server) server.close();
  if (prev.max === undefined) delete process.env.AUTH_RATE_LIMIT_MAX; else process.env.AUTH_RATE_LIMIT_MAX = prev.max;
  if (prev.windowMs === undefined) delete process.env.AUTH_RATE_LIMIT_WINDOW_MS; else process.env.AUTH_RATE_LIMIT_WINDOW_MS = prev.windowMs;
  if (prev.disabled === undefined) delete process.env.DISABLE_RATE_LIMIT; else process.env.DISABLE_RATE_LIMIT = prev.disabled;
});

beforeEach(() => {
  initDatabase(':memory:');
  // Clear limiter state so counts never leak between tests.
  serverModule.loginRateLimiter.reset();
  serverModule.signupRateLimiter.reset();
});

afterEach(() => closeDatabase());

function signup(email) {
  return api(server, '/api/auth/signup', {
    method: 'POST',
    body: { email, password: 'password123', displayName: email.split('@')[0] }
  });
}

function login(email, password = 'password123') {
  return api(server, '/api/auth/login', { method: 'POST', body: { email, password } });
}

describe('auth rate limiting', () => {
  it('allows normal signup/login below the limit', async () => {
    const s = await signup('normal@example.com');
    expect(s.status).toBe(201);

    const l = await login('normal@example.com');
    expect(l.status).toBe(200);
    expect(l.data.token).toBeTruthy();
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
