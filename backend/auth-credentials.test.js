/**
 * Credential-verification hardening tests (audit finding 7).
 *
 * Behavior-focused (not timing-based):
 *   - verifyUser returns the SAME generic error for "no such user" and "wrong
 *     password", so the message can't be used to enumerate accounts.
 *   - The /api/auth/login route returns a generic 401 for both branches.
 *   - Correct credentials still authenticate.
 *
 * The not-found branch additionally runs a dummy PBKDF2 to remove a timing
 * oracle; that's defense-in-depth and intentionally not asserted via timing
 * here (timing assertions are brittle).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

const config = require('./config');
const db = require('./pgDatabase');
const { createUser, verifyUser } = db;
const { startServer, api } = require('./_http-test-utils');

const CONFIGURED = config.hasPostgresConnection();
const TEST_PASSWORD = 'violet-harbor-orbits-42';

let server;
let prevDisabled;

beforeAll(async () => {
  if (!CONFIGURED) return;
  prevDisabled = process.env.DISABLE_RATE_LIMIT;
  process.env.DISABLE_RATE_LIMIT = 'true'; // isolate from the rate limiter
  server = await startServer();
});

afterAll(async () => {
  if (!CONFIGURED) return;
  if (server) await new Promise((resolve) => server.close(resolve));
  await db.close();
  if (prevDisabled === undefined) delete process.env.DISABLE_RATE_LIMIT;
  else process.env.DISABLE_RATE_LIMIT = prevDisabled;
});

beforeEach(async () => {
  if (!CONFIGURED) return;
  await db.resetSchemaForTests();
});

describe.skipIf(!CONFIGURED)('credential verification (DB layer)', () => {
  it('returns an identical generic error for unknown email and wrong password', async () => {
    await createUser('real@example.com', 'correct-horse', 'Real User');

    const wrongPassword = await verifyUser('real@example.com', 'nope');
    const unknownEmail = await verifyUser('ghost@example.com', 'whatever');

    expect(wrongPassword.error).toBeTruthy();
    expect(unknownEmail.error).toBeTruthy();
    // No enumeration: the two failure branches are indistinguishable by message.
    expect(wrongPassword.error).toBe(unknownEmail.error);
    expect(wrongPassword.error).toMatch(/invalid email or password/i);
  });

  it('authenticates correct credentials', async () => {
    await createUser('real@example.com', 'correct-horse', 'Real User');
    const ok = await verifyUser('real@example.com', 'correct-horse');
    expect(ok.error).toBeUndefined();
    expect(ok.email).toBe('real@example.com');
  });

  it('rejects a wrong password whose length differs from the real hash', async () => {
    // Exercises the constant-time comparison's length-mismatch path.
    await createUser('real@example.com', 'correct-horse', 'Real User');
    expect((await verifyUser('real@example.com', 'x')).error).toMatch(/invalid email or password/i);
  });
});

describe.skipIf(!CONFIGURED)('login route (HTTP)', () => {
  async function login(email, password) {
    return api(server, '/api/auth/login', { method: 'POST', body: { email, password } });
  }

  it('returns a generic 401 for both unknown email and wrong password', async () => {
    await api(server, '/api/auth/signup', {
      method: 'POST',
      body: { email: 'user@example.com', password: TEST_PASSWORD, displayName: 'User' }
    });

    const unknown = await login('nobody@example.com', TEST_PASSWORD);
    const wrong = await login('user@example.com', 'wrong-password');

    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(unknown.data.error).toBe(wrong.data.error);
  });

  it('logs in with correct credentials', async () => {
    await api(server, '/api/auth/signup', {
      method: 'POST',
      body: { email: 'user@example.com', password: TEST_PASSWORD, displayName: 'User' }
    });
    const ok = await login('user@example.com', TEST_PASSWORD);
    expect(ok.status).toBe(200);
    expect(ok.data.token).toBeUndefined();
    expect(ok.data.user.email).toBe('user@example.com');
  });

  it('returns a sanitized retryable 503 when global password work is full', async () => {
    const busy = Object.assign(new Error('private capacity detail'), { code: 'AUTH_HASH_BUSY' });
    const verify = vi.spyOn(db, 'verifyUser').mockRejectedValueOnce(busy);
    try {
      const result = await login('user@example.com', TEST_PASSWORD);
      expect(result.status).toBe(503);
      expect(result.res.headers.get('retry-after')).toBe('1');
      expect(result.data).toEqual({ error: 'Authentication is temporarily busy. Please try again.' });
      expect(JSON.stringify(result.data)).not.toContain('private capacity detail');
    } finally {
      verify.mockRestore();
    }
  });
});
