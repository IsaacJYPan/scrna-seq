/**
 * Shared HTTP test utilities for backend route tests.
 *
 * Starts the real Express app on an ephemeral port and issues genuine session
 * tokens so tests exercise the full auth + route stack (not mocked internals).
 * Underscore-prefixed so Vitest does not treat this file as a test suite.
 */

const serverModule = require('../server.js');
const db = require('./pgDatabase');
const config = require('./config');

const { app, issueSession } = serverModule;

async function startServer() {
  await serverModule.initAppDatabase();
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function baseUrl(server) {
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

/** Create a user directly in the DB and mint a valid session token for them. */
async function createUserWithToken({ email, password = 'password123', displayName = 'Test User' }) {
  const user = await db.createUser(email, password, displayName);
  if (user.error) throw new Error(user.error);
  const token = issueSession(user);
  return { user, token };
}

async function api(server, path, { method = 'GET', token, headers = {}, body } = {}) {
  const h = { ...headers };
  if (token) {
    h.Cookie = `${config.sessionCookieName()}=${encodeURIComponent(token)}`;
    if (!h.Origin && !h.origin) h.Origin = 'http://localhost:5173';
  }
  if (body !== undefined && h['Content-Type'] === undefined) h['Content-Type'] = 'application/json';
  const production = config.isProduction();
  const priorTrustProxy = app.get('trust proxy');
  if (production) {
    // A few policy tests deliberately switch NODE_ENV after the shared app was
    // imported. Reproduce the trusted one-hop TLS ingress for that request so
    // the intended route gate, not the plaintext-production gate, is asserted.
    app.set('trust proxy', 1);
    if (!h['X-Forwarded-Proto'] && !h['x-forwarded-proto']) h['X-Forwarded-Proto'] = 'https';
    if (!h['X-Forwarded-For'] && !h['x-forwarded-for']) h['X-Forwarded-For'] = '127.0.0.1';
  }

  let res;
  try {
    res = await fetch(`${baseUrl(server)}${path}`, {
      method,
      headers: h,
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
  } finally {
    if (production) app.set('trust proxy', priorTrustProxy);
  }

  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data, res };
}

module.exports = { startServer, createUserWithToken, api, db, serverModule };
