/**
 * Shared HTTP test utilities for backend route tests.
 *
 * Starts the real Express app on an ephemeral port and issues genuine session
 * tokens so tests exercise the full auth + route stack (not mocked internals).
 * Underscore-prefixed so Vitest does not treat this file as a test suite.
 */

const serverModule = require('../server.js');
const db = require('./database');

const { app, issueSession } = serverModule;

function startServer() {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function baseUrl(server) {
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

/** Create a user directly in the DB and mint a valid session token for them. */
function createUserWithToken({ email, password = 'password123', displayName = 'Test User' }) {
  const user = db.createUser(email, password, displayName);
  if (user.error) throw new Error(user.error);
  const token = issueSession(user);
  return { user, token };
}

async function api(server, path, { method = 'GET', token, headers = {}, body } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (body !== undefined && h['Content-Type'] === undefined) h['Content-Type'] = 'application/json';

  const res = await fetch(`${baseUrl(server)}${path}`, {
    method,
    headers: h,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });

  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}

module.exports = { startServer, createUserWithToken, api, db, serverModule };
