import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';

const { initDatabase, closeDatabase } = require('./database');
const { startServer, createUserWithToken, api } = require('./_http-test-utils');

let server;
let prevDiag;
let prevNodeEnv;

beforeAll(async () => {
  prevDiag = process.env.ENABLE_R_TEST_DIAGNOSTICS;
  prevNodeEnv = process.env.NODE_ENV;
  process.env.ENABLE_R_TEST_DIAGNOSTICS = 'true';
  delete process.env.NODE_ENV; // ensure not 'production'
  server = await startServer();
});

afterAll(() => {
  if (server) server.close();
  if (prevDiag === undefined) delete process.env.ENABLE_R_TEST_DIAGNOSTICS;
  else process.env.ENABLE_R_TEST_DIAGNOSTICS = prevDiag;
  if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = prevNodeEnv;
});

beforeEach(() => { initDatabase(':memory:'); });
afterEach(() => { closeDatabase(); });

function setup() {
  const alice = createUserWithToken({ email: 'alice@example.com', displayName: 'Alice' });
  const bob = createUserWithToken({ email: 'bob@example.com', displayName: 'Bob' });
  return { alice, bob };
}

async function createObject(token, body = { objectType: 'seurat' }) {
  const res = await api(server, '/api/analysis-objects', { method: 'POST', token, body });
  return res.data.id;
}

function stateKey(server, token, objectId) {
  const headers = objectId === undefined ? {} : { 'X-Object-ID': objectId };
  return api(server, '/api/r/__test/state-key', { token, headers });
}

describe('R proxy object-ownership verification', () => {
  it('requires auth before any ownership logic runs', async () => {
    const res = await api(server, '/api/r/__test/state-key', { headers: { 'X-Object-ID': 'ao_x' } });
    expect(res.status).toBe(401);
  });

  it('uses legacy user-scoped state key when no X-Object-ID is supplied', async () => {
    const { alice } = setup();
    const res = await stateKey(server, alice.token);
    expect(res.status).toBe(200);
    expect(res.data.stateKey).toBe(`user-${alice.user.id}`);
    expect(res.data.objectId).toBeNull();
  });

  it('derives an object-scoped state key for an object the user owns', async () => {
    const { alice } = setup();
    const id = await createObject(alice.token);
    const res = await stateKey(server, alice.token, id);
    expect(res.status).toBe(200);
    expect(res.data.stateKey).toBe(`user-${alice.user.id}:obj-${id}`);
    expect(res.data.objectId).toBe(id);
  });

  it('keeps distinct same-user objects on distinct state keys', async () => {
    const { alice } = setup();
    const a = await createObject(alice.token);
    const b = await createObject(alice.token);
    const ka = await stateKey(server, alice.token, a);
    const kb = await stateKey(server, alice.token, b);
    expect(ka.data.stateKey).not.toBe(kb.data.stateKey);
  });

  it('rejects an object id owned by another user (404, no enumeration)', async () => {
    const { alice, bob } = setup();
    const bobId = await createObject(bob.token);
    const res = await stateKey(server, alice.token, bobId);
    expect(res.status).toBe(404);
    expect(res.data.stateKey).toBeUndefined();
  });

  it('rejects an unknown but well-formed object id (404)', async () => {
    const { alice } = setup();
    const res = await stateKey(server, alice.token, 'ao_deadbeefdeadbeef');
    expect(res.status).toBe(404);
  });

  it('rejects a malformed object id before reaching R (400)', async () => {
    const { alice } = setup();
    // A crafted prefix-injection attempt is rejected on format grounds.
    const res = await stateKey(server, alice.token, `user-${alice.user.id}:obj-evil`);
    expect(res.status).toBe(400);
    expect(res.data.error).toMatch(/malformed/i);
  });

  it('never lets the client choose the user prefix', async () => {
    const { alice, bob } = setup();
    const aliceId = await createObject(alice.token);
    // Bob presents Alice's (valid-format) object id; he does not own it -> 404.
    const res = await stateKey(server, bob.token, aliceId);
    expect(res.status).toBe(404);
  });

  it('returns 404 for __test diagnostics when diagnostics are disabled', async () => {
    const { alice } = setup();
    process.env.ENABLE_R_TEST_DIAGNOSTICS = 'false';
    try {
      const res = await stateKey(server, alice.token);
      expect(res.status).toBe(404);
    } finally {
      process.env.ENABLE_R_TEST_DIAGNOSTICS = 'true';
    }
  });

  it('returns 404 for __test diagnostics in production even when enabled', async () => {
    const { alice } = setup();
    process.env.NODE_ENV = 'production';
    try {
      const res = await stateKey(server, alice.token);
      expect(res.status).toBe(404);
    } finally {
      delete process.env.NODE_ENV;
    }
  });
});
