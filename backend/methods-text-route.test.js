import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';

const config = require('./config');
const db = require('./pgDatabase');
const projectAudit = require('./projectAudit');
const { startServer, createUserWithToken, api } = require('./_http-test-utils');

const CONFIGURED = config.hasPostgresConnection();
let server;

beforeAll(async () => {
  if (CONFIGURED) server = await startServer();
});

afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (CONFIGURED) await db.close();
});

describe.skipIf(!CONFIGURED)('GET /api/projects/:projectId/methods-text', () => {
  beforeEach(async () => { await db.resetSchemaForTests(); });

  async function seed() {
    const { user: owner, token } = await createUserWithToken({ email: 'methods-owner@example.com' });
    const org = await db.createOrganizationForUser(owner.id, { name: 'Methods lab' });
    const project = await db.createProjectForUser(owner.id, { organizationId: org.id, name: 'Methods study' });
    const object = await db.createProjectAnalysisObject(owner.id, project.id, {
      objectType: 'seurat', displayName: 'Methods root',
    });
    return { owner, token, project, object };
  }

  it('returns a Markdown draft for a visible analysis and records an audit event', async () => {
    const { owner, token, project, object } = await seed();
    const res = await api(server, `/api/projects/${project.id}/methods-text?analysisObjectId=${object.id}`, { token });

    expect(res.status).toBe(200);
    expect(res.res.headers.get('content-type')).toMatch(/^text\/markdown/);
    expect(res.res.headers.get('content-disposition')).toBe(`attachment; filename="methods-${object.id}.md"`);
    expect(res.res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.data).toContain('# Methods (draft)');
    expect(res.data).toContain(`analysis ${object.id}`);

    const events = await projectAudit.listEvents(owner.id, project.id, {});
    expect(events.find((event) => event.action === 'methods.exported')).toMatchObject({
      targetType: 'analysis_object', targetId: object.id,
      details: { manifestVersion: 1, methodsVersion: 1 },
    });
  });

  it('requires a session and hides analyses from non-members', async () => {
    const { project, object } = await seed();
    const anonymous = await api(server, `/api/projects/${project.id}/methods-text?analysisObjectId=${object.id}`);
    expect(anonymous.status).toBe(401);

    const { token: outsider } = await createUserWithToken({ email: 'methods-outsider@example.com' });
    const hidden = await api(server, `/api/projects/${project.id}/methods-text?analysisObjectId=${object.id}`, { token: outsider });
    expect([403, 404]).toContain(hidden.status);
    expect(JSON.stringify(hidden.data)).not.toContain('Methods (draft)');
  });
});
