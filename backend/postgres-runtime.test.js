import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const config = require('./config');
const pg = require('./pgDatabase');
const { startServer, api } = require('./_http-test-utils');

const CONFIGURED = config.hasPostgresConnection();
const TEST_PASSWORD = 'violet-harbor-orbits-42';

describe.skipIf(!CONFIGURED)('Postgres runtime API', () => {
  let server;
  let token;
  let user;

  beforeAll(async () => {
    await pg.resetSchemaForTests();
    server = await startServer();
  });

  afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    await pg.close();
  });

  it('signs up a user and restores the session through Postgres-backed auth', async () => {
    const email = `runtime-${Date.now()}@example.com`;
    const signup = await api(server, '/api/auth/signup', {
      method: 'POST',
      body: { email, password: TEST_PASSWORD, displayName: 'Runtime User' }
    });
    expect(signup.status).toBe(201);
    expect(signup.data.user.email).toBe(email);
    expect(signup.data.token).toBeUndefined();
    const setCookie = (signup.res.headers.getSetCookie?.() || [])
      .find((value) => value.startsWith(`${config.sessionCookieName()}=`));
    expect(setCookie).toBeTruthy();
    token = decodeURIComponent(setCookie.split(';')[0].slice(setCookie.indexOf('=') + 1));
    user = signup.data.user;

    const session = await api(server, '/api/auth/session', { token });
    expect(session.status).toBe(200);
    expect(session.data.user.id).toBe(user.id);
  });

  it('creates project data through the frontend-facing API without trusting client ownership fields', async () => {
    const org = await api(server, '/api/organizations', {
      method: 'POST',
      token,
      body: { name: 'Runtime Org', ownerUserId: 999 }
    });
    expect(org.status).toBe(400);

    const createdOrg = await api(server, '/api/organizations', {
      method: 'POST',
      token,
      body: { name: 'Runtime Org' }
    });
    expect(createdOrg.status).toBe(201);
    expect(createdOrg.data.id).toMatch(/^org_/);

    const project = await api(server, '/api/projects', {
      method: 'POST',
      token,
      body: { organizationId: createdOrg.data.id, name: 'Runtime Project' }
    });
    expect(project.status).toBe(201);
    expect(project.data.id).toMatch(/^proj_/);

    const dataset = await api(server, `/api/projects/${project.data.id}/datasets`, {
      method: 'POST',
      token,
      body: { fileType: 'tenx_h5', originalFilename: '../matrix.h5' }
    });
    expect(dataset.status).toBe(201);
    expect(dataset.data.id).toMatch(/^ds_/);
    expect(dataset.data.originalFilename).toBe('matrix.h5');
    expect(dataset.data).not.toHaveProperty('internalStorageKey');
    expect(dataset.data).not.toHaveProperty('storageUri');

    const object = await api(server, `/api/projects/${project.data.id}/analysis-objects`, {
      method: 'POST',
      token,
      body: { objectType: 'matrix', datasetId: dataset.data.id, displayName: 'Raw matrix' }
    });
    expect(object.status).toBe(201);
    expect(object.data.id).toMatch(/^ao_/);
    expect(object.data.ownerUserId).toBe(user.id);

    const job = await api(server, `/api/projects/${project.data.id}/jobs`, {
      method: 'POST',
      token,
      body: { jobType: 'checkpoint.noop', analysisObjectId: object.data.id }
    });
    expect(job.status).toBe(201);
    expect(job.data.id).toMatch(/^job_/);
    expect(job.data.status).toBe('queued');
    expect(job.data).not.toHaveProperty('claimToken');
  });
});
