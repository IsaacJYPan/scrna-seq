/**
 * HttpOnly cookie session foundation (real Express, evidence label: backend
 * contract). Proves the cookie auth migration path:
 *   - signup/login set an HttpOnly, SameSite, Max-Age session cookie,
 *   - GET /api/auth/session restores auth state from the cookie alone,
 *   - a protected route accepts cookie auth,
 *   - CSRF: a cookie-authenticated mutation is rejected without an allowed
 *     Origin and accepted with one; a bearer mutation is exempt (not a CSRF
 *     vector),
 *   - logout clears the cookie,
 *   - the legacy bearer path still authenticates (transition compatibility).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
const { startServer, serverModule } = require('./_http-test-utils');
const db = require('./database');

const { issueSession } = serverModule;
const COOKIE_NAME = 'benchone_session';
const ALLOWED_ORIGIN = 'http://localhost:5173'; // config default when FRONTEND_* unset

let server;
let baseUrl;

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
  server = await startServer();
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  if (server) server.close();
});

describe('cookie session issuance', () => {
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
    // Transition: the token is still returned in JSON for legacy bearer clients.
    expect(typeof data.token).toBe('string');
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

describe('cookie session restore + protected access', () => {
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
    expect(data.authVia).toBe('cookie');
  });

  it('accepts cookie auth on a protected route', async () => {
    const { cookie } = await loginCookie('protected');
    const { status } = await http('/api/organizations', {
      headers: { Cookie: `${COOKIE_NAME}=${cookieValue(cookie)}` }
    });
    expect(status).toBe(200);
  });

  it('rejects an unauthenticated protected request', async () => {
    const { status } = await http('/api/organizations');
    expect(status).toBe(401);
  });
});

describe('CSRF protection for cookie-authenticated mutations', () => {
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

  it('exempts bearer-auth mutations from the CSRF origin check', async () => {
    const email = uniqueEmail('bearer-csrf');
    const user = db.createUser(email, 'password123', 'B');
    const token = issueSession(user);
    const { status } = await http('/api/organizations', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` }, // no Origin header
      body: { name: 'Bearer Org' }
    });
    expect(status).toBe(201);
  });
});

describe('logout + legacy bearer compatibility', () => {
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

  it('still authenticates via the legacy bearer token', async () => {
    const email = uniqueEmail('bearer');
    const user = db.createUser(email, 'password123', 'B');
    const token = issueSession(user);
    const { status, data } = await http('/api/auth/session', {
      headers: { Authorization: `Bearer ${token}` }
    });
    expect(status).toBe(200);
    expect(data.user.email).toBe(email);
    expect(data.authVia).toBe('bearer');
  });
});
