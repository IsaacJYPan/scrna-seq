/**
 * HttpOnly cookie session foundation (real Express, evidence label: backend
 * contract). Proves the cookie-only auth contract:
 *   - signup/login set an HttpOnly, SameSite, Max-Age session cookie,
 *   - GET /api/auth/session restores auth state from the cookie alone,
 *   - a protected route accepts cookie auth,
 *   - CSRF: a cookie-authenticated mutation is rejected without an allowed
 *     Origin and accepted with one,
 *   - logout revokes every cookie for the account and clears the browser cookie,
 *   - bearer credentials are rejected.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
const config = require('./config');
const { startServer, serverModule } = require('./_http-test-utils');
const db = require('./pgDatabase');

const CONFIGURED = config.hasPostgresConnection();
const { issueSession } = serverModule;
const COOKIE_NAME = config.sessionCookieName();
const ALLOWED_ORIGIN = 'http://localhost:5173'; // config default when FRONTEND_* unset

let server;
let baseUrl;

describe('session claim bounds', () => {
  it('rejects user ids that cannot round-trip safely and versions outside Postgres BIGINT', () => {
    expect(() => issueSession({ id: '9007199254740992', sessionVersion: '1' })).toThrow(/valid internal user/i);
    expect(() => issueSession({ id: 1, sessionVersion: '9223372036854775808' })).toThrow(/valid internal user/i);
    expect(() => issueSession({ id: 1, sessionVersion: '01' })).toThrow(/valid internal user/i);
  });
});

function uniqueEmail(tag) {
  return `cookie-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
}

function getSessionCookie(res) {
  const all = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  return all.find((c) => c.startsWith(`${COOKIE_NAME}=`)) || '';
}

function cookieValue(setCookieStr) {
  const first = setCookieStr.split(';')[0];
  return first.slice(first.indexOf('=') + 1);
}

async function http(path, { method = 'GET', headers = {}, body } = {}) {
  const h = { ...headers };
  if (body !== undefined && h['Content-Type'] === undefined) h['Content-Type'] = 'application/json';
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: h,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data, res };
}

beforeAll(async () => {
  if (!CONFIGURED) return;
  await db.resetSchemaForTests();
  server = await startServer();
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  if (!CONFIGURED) return;
  if (server) await new Promise((resolve) => server.close(resolve));
  await db.close();
});

beforeEach(() => {
  serverModule.loginRateLimiter.reset();
  serverModule.signupRateLimiter.reset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe.skipIf(!CONFIGURED)('cookie session issuance', () => {
  it('sets an HttpOnly SameSite session cookie on signup', async () => {
    const email = uniqueEmail('signup');
    const { status, data, res } = await http('/api/auth/signup', {
      method: 'POST',
      body: { email, password: 'password123', displayName: 'Cookie User' }
    });
    expect(status).toBe(201);
    const cookie = getSessionCookie(res);
    expect(cookie).toContain(`${COOKIE_NAME}=`);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Max-Age=\d+/i);
    expect(data.token).toBeUndefined();
    expect(data.user.sessionVersion).toBeUndefined();
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('sets a session cookie on login', async () => {
    const email = uniqueEmail('login');
    await http('/api/auth/signup', { method: 'POST', body: { email, password: 'password123', displayName: 'L' } });
    const { status, res } = await http('/api/auth/login', {
      method: 'POST',
      body: { email, password: 'password123' }
    });
    expect(status).toBe(200);
    expect(getSessionCookie(res)).toContain(`${COOKIE_NAME}=`);
  });
});

describe.skipIf(!CONFIGURED)('cookie session restore + protected access', () => {
  async function loginCookie(tag) {
    const email = uniqueEmail(tag);
    await http('/api/auth/signup', { method: 'POST', body: { email, password: 'password123', displayName: 'U' } });
    const { res } = await http('/api/auth/login', { method: 'POST', body: { email, password: 'password123' } });
    return { email, cookie: getSessionCookie(res) };
  }

  it('restores the current user from the cookie via /api/auth/session', async () => {
    const { email, cookie } = await loginCookie('session');
    const { status, data } = await http('/api/auth/session', {
      headers: { Cookie: `${COOKIE_NAME}=${cookieValue(cookie)}` }
    });
    expect(status).toBe(200);
    expect(data.user.email).toBe(email);
    expect(data.authVia).toBeUndefined();
  });

  it('accepts cookie auth on a protected route', async () => {
    const { cookie } = await loginCookie('protected');
    const { status } = await http('/api/organizations', {
      headers: { Cookie: `${COOKIE_NAME}=${cookieValue(cookie)}` }
    });
    expect(status).toBe(200);
  });

  it('invalidates every existing cookie when the deployment session epoch changes', async () => {
    const previous = process.env.SESSION_EPOCH;
    try {
      process.env.SESSION_EPOCH = '4f8c2a6e1d9b3075c4e8a2f6d1b93570';
      const { cookie } = await loginCookie('epoch-rotation');
      expect((await http('/api/auth/session', {
        headers: { Cookie: `${COOKIE_NAME}=${cookieValue(cookie)}` }
      })).status).toBe(200);

      process.env.SESSION_EPOCH = 'a7d31c8e5f209b64d2a84f1c7e3059b6';
      expect((await http('/api/auth/session', {
        headers: { Cookie: `${COOKIE_NAME}=${cookieValue(cookie)}` }
      })).status).toBe(401);
    } finally {
      if (previous === undefined) delete process.env.SESSION_EPOCH;
      else process.env.SESSION_EPOCH = previous;
    }
  });

  it('rejects an unauthenticated protected request', async () => {
    const { status } = await http('/api/organizations');
    expect(status).toBe(401);
  });
});

describe.skipIf(!CONFIGURED)('CSRF protection for cookie-authenticated mutations', () => {
  async function loginCookie(tag) {
    const email = uniqueEmail(tag);
    await http('/api/auth/signup', { method: 'POST', body: { email, password: 'password123', displayName: 'U' } });
    const { res } = await http('/api/auth/login', { method: 'POST', body: { email, password: 'password123' } });
    return getSessionCookie(res);
  }

  it('blocks a cookie-auth POST with no Origin header', async () => {
    const cookie = await loginCookie('csrf-none');
    const { status } = await http('/api/organizations', {
      method: 'POST',
      headers: { Cookie: `${COOKIE_NAME}=${cookieValue(cookie)}` },
      body: { name: 'My Org' }
    });
    expect(status).toBe(403);
  });

  it('blocks a cookie-auth POST from a disallowed Origin', async () => {
    const cookie = await loginCookie('csrf-bad');
    const { status } = await http('/api/organizations', {
      method: 'POST',
      headers: { Cookie: `${COOKIE_NAME}=${cookieValue(cookie)}`, Origin: 'https://evil.example.com' },
      body: { name: 'My Org' }
    });
    expect(status).toBe(403);
  });

  it('allows a cookie-auth POST from an allowed Origin', async () => {
    const cookie = await loginCookie('csrf-ok');
    const { status } = await http('/api/organizations', {
      method: 'POST',
      headers: { Cookie: `${COOKIE_NAME}=${cookieValue(cookie)}`, Origin: ALLOWED_ORIGIN },
      body: { name: 'My Org' }
    });
    expect(status).toBe(201);
  });

  it('allows a cookie-auth POST when the Origin matches the request Host (same-origin, e.g. npm start on :3000)', async () => {
    // Origin equals baseUrl (the host the browser connected to) but is NOT the
    // FRONTEND_ORIGIN allowlist entry (:5173). Same-origin is not a CSRF vector, so
    // this must be accepted — otherwise the Express-served SPA can't mutate.
    const cookie = await loginCookie('csrf-same-origin');
    const { status } = await http('/api/organizations', {
      method: 'POST',
      headers: { Cookie: `${COOKIE_NAME}=${cookieValue(cookie)}`, Origin: baseUrl },
      body: { name: 'My Org' }
    });
    expect(status).toBe(201);
  });

  it('rejects a valid signed token when it is presented only as a bearer credential', async () => {
    const email = uniqueEmail('bearer-csrf');
    const user = await db.createUser(email, 'password123', 'B');
    const token = issueSession(user);
    const { status } = await http('/api/organizations', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` }, // no Origin header
      body: { name: 'Bearer Org' }
    });
    expect(status).toBe(401);
  });
});

describe.skipIf(!CONFIGURED)('logout + removed bearer transport', () => {
  it('uses a valid cookie and ignores a different valid bearer token', async () => {
    const cookieEmail = uniqueEmail('cookie-wins');
    await http('/api/auth/signup', { method: 'POST', body: { email: cookieEmail, password: 'password123', displayName: 'Cookie' } });
    const { res: loginRes } = await http('/api/auth/login', { method: 'POST', body: { email: cookieEmail, password: 'password123' } });
    const cookie = getSessionCookie(loginRes);

    const bearerUser = await db.createUser(uniqueEmail('bearer-loses'), 'password123', 'Bearer');
    const bearerToken = issueSession(bearerUser);

    const { status, data } = await http('/api/auth/session', {
      headers: {
        Cookie: `${COOKIE_NAME}=${cookieValue(cookie)}`,
        Authorization: `Bearer ${bearerToken}`
      }
    });

    expect(status).toBe(200);
    expect(data.authVia).toBeUndefined();
    expect(data.user.email).toBe(cookieEmail);
  });

  it('clears the session cookie on logout', async () => {
    const email = uniqueEmail('logout');
    await http('/api/auth/signup', { method: 'POST', body: { email, password: 'password123', displayName: 'U' } });
    const { res: loginRes } = await http('/api/auth/login', { method: 'POST', body: { email, password: 'password123' } });
    const cookie = getSessionCookie(loginRes);

    const { status, res } = await http('/api/auth/logout', {
      method: 'POST',
      headers: { Cookie: `${COOKIE_NAME}=${cookieValue(cookie)}`, Origin: ALLOWED_ORIGIN }
    });
    expect(status).toBe(200);
    const cleared = getSessionCookie(res);
    expect(cleared).toMatch(/Max-Age=0/i);
  });

  it('preserves the retry credential on a revocation failure, then revokes it on retry', async () => {
    const email = uniqueEmail('logout-retry');
    await http('/api/auth/signup', { method: 'POST', body: { email, password: 'password123', displayName: 'U' } });
    const cookie = getSessionCookie((await http('/api/auth/login', {
      method: 'POST', body: { email, password: 'password123' }
    })).res);
    vi.spyOn(db, 'revokeUserSessions').mockRejectedValueOnce(new Error('/private/database'));

    const failed = await http('/api/auth/logout', {
      method: 'POST',
      headers: { Cookie: `${COOKIE_NAME}=${cookieValue(cookie)}`, Origin: ALLOWED_ORIGIN }
    });
    expect(failed.status).toBe(503);
    expect(getSessionCookie(failed.res)).toBe('');
    expect((await http('/api/auth/session', {
      headers: { Cookie: `${COOKIE_NAME}=${cookieValue(cookie)}` }
    })).status).toBe(200);

    const retried = await http('/api/auth/logout', {
      method: 'POST',
      headers: { Cookie: `${COOKIE_NAME}=${cookieValue(cookie)}`, Origin: ALLOWED_ORIGIN }
    });
    expect(retried.status).toBe(200);
    expect(retried.data.allSessionsRevoked).toBe(true);
    expect(getSessionCookie(retried.res)).toMatch(/Max-Age=0/i);
    expect((await http('/api/auth/session', {
      headers: { Cookie: `${COOKIE_NAME}=${cookieValue(cookie)}` }
    })).status).toBe(401);
  });

  it('does not falsely report revoke-all for an invalid cookie', async () => {
    const result = await http('/api/auth/logout', {
      method: 'POST',
      headers: { Cookie: `${COOKIE_NAME}=invalid`, Origin: ALLOWED_ORIGIN }
    });
    expect(result.status).toBe(200);
    expect(result.data).toMatchObject({ success: true, allSessionsRevoked: false });
    expect(getSessionCookie(result.res)).toMatch(/Max-Age=0/i);
  });

  it('clears the session cookie on same-origin logout even when FRONTEND_ORIGIN points at the dev server', async () => {
    const email = uniqueEmail('logout-same-origin');
    await http('/api/auth/signup', { method: 'POST', body: { email, password: 'password123', displayName: 'U' } });
    const { res: loginRes } = await http('/api/auth/login', { method: 'POST', body: { email, password: 'password123' } });
    const cookie = getSessionCookie(loginRes);

    const { status, res } = await http('/api/auth/logout', {
      method: 'POST',
      headers: { Cookie: `${COOKIE_NAME}=${cookieValue(cookie)}`, Origin: baseUrl }
    });

    expect(status).toBe(200);
    const cleared = getSessionCookie(res);
    expect(cleared).toMatch(/Max-Age=0/i);
  });

  it('does not authenticate via the removed bearer transport', async () => {
    const email = uniqueEmail('bearer');
    const user = await db.createUser(email, 'password123', 'B');
    const token = issueSession(user);
    const { status, data } = await http('/api/auth/session', {
      headers: { Authorization: `Bearer ${token}` }
    });
    expect(status).toBe(401);
    expect(data.error).toMatch(/authentication required/i);
  });

  it('revokes every cookie issued for the account immediately', async () => {
    const email = uniqueEmail('revoke-all');
    await http('/api/auth/signup', { method: 'POST', body: { email, password: 'password123', displayName: 'U' } });
    const first = getSessionCookie((await http('/api/auth/login', {
      method: 'POST', body: { email, password: 'password123' }
    })).res);
    const second = getSessionCookie((await http('/api/auth/login', {
      method: 'POST', body: { email, password: 'password123' }
    })).res);

    expect((await http('/api/auth/session', {
      headers: { Cookie: `${COOKIE_NAME}=${cookieValue(first)}` }
    })).status).toBe(200);
    expect((await http('/api/auth/logout', {
      method: 'POST',
      headers: { Cookie: `${COOKIE_NAME}=${cookieValue(first)}`, Origin: ALLOWED_ORIGIN }
    })).status).toBe(200);
    expect((await http('/api/auth/session', {
      headers: { Cookie: `${COOKIE_NAME}=${cookieValue(first)}` }
    })).status).toBe(401);
    expect((await http('/api/auth/session', {
      headers: { Cookie: `${COOKIE_NAME}=${cookieValue(second)}` }
    })).status).toBe(401);

    const fresh = getSessionCookie((await http('/api/auth/login', {
      method: 'POST', body: { email, password: 'password123' }
    })).res);
    expect((await http('/api/auth/session', {
      headers: { Cookie: `${COOKIE_NAME}=${cookieValue(fresh)}` }
    })).status).toBe(200);
  });

  it('rejects malformed and duplicate session cookies without throwing', async () => {
    const malformed = await http('/api/auth/session', {
      headers: { Cookie: `${COOKIE_NAME}=%not-valid` }
    });
    expect(malformed.status).toBe(401);

    const email = uniqueEmail('duplicate');
    const user = await db.createUser(email, 'password123', 'D');
    const token = issueSession(user);
    const duplicate = await http('/api/auth/session', {
      headers: { Cookie: `${COOKIE_NAME}=${encodeURIComponent(token)}; ${COOKIE_NAME}=${encodeURIComponent(token)}` }
    });
    expect(duplicate.status).toBe(401);
  });
});
