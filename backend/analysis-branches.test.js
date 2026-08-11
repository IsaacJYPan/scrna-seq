import { describe, it, expect, beforeEach, afterAll } from 'vitest';

const config = require('./config');
const db = require('./pgDatabase');
const branches = require('./analysisBranches');
const projectAudit = require('./projectAudit');
const { startServer, createUserWithToken, api } = require('./_http-test-utils');

const CONFIGURED = config.hasPostgresConnection();

async function seedProject() {
  const owner = await db.createUser('branch-owner@example.com', 'password123', 'Owner');
  const analyst = await db.createUser('branch-analyst@example.com', 'password123', 'Analyst');
  const viewer = await db.createUser('branch-viewer@example.com', 'password123', 'Viewer');
  const org = await db.createOrganizationForUser(owner.id, { name: 'Branch lab' });
  const project = await db.createProjectForUser(owner.id, {
    organizationId: org.id, name: 'Branch study',
  });
  await db.addProjectMemberByEmail(project.id, analyst.email, 'analyst', 'owner');
  await db.addProjectMemberByEmail(project.id, viewer.email, 'viewer', 'owner');
  const root = await db.createProjectAnalysisObject(owner.id, project.id, {
    objectType: 'seurat', displayName: 'Canonical candidate root',
  });
  const ownerChild = await db.createProjectAnalysisObject(owner.id, project.id, {
    objectType: 'seurat', parentObjectId: root.id, displayName: 'Owner child',
  });
  const analystFork = await db.createProjectAnalysisObject(analyst.id, project.id, {
    objectType: 'seurat', parentObjectId: root.id, displayName: 'Analyst fork',
  });
  return { owner, analyst, viewer, project, root, ownerChild, analystFork };
}

afterAll(async () => {
  if (CONFIGURED) await db.close();
});

describe.skipIf(!CONFIGURED)('analysis branches, review, and canonical promotion', () => {
  beforeEach(async () => { await db.resetSchemaForTests(); });

  it('creates user-private branches and does not reveal them to project co-members', async () => {
    const { owner, analyst, viewer, project, root, analystFork } = await seedProject();
    const ownerBranch = await branches.createBranch(owner.id, project.id, {
      name: 'owner/qc-strategy', baseAnalysisObjectId: root.id,
    });
    const analystBranch = await branches.createBranch(analyst.id, project.id, {
      name: 'analyst/alternate-labels', baseAnalysisObjectId: analystFork.id,
    });

    expect(ownerBranch.visibility).toBe('private');
    expect(ownerBranch.headAnalysisObjectId).toBe(root.id);
    expect((await branches.listBranches(owner.id, project.id)).map((item) => item.id))
      .toEqual([ownerBranch.id]);
    expect((await branches.listBranches(analyst.id, project.id)).map((item) => item.id))
      .toEqual([analystBranch.id]);
    expect(await branches.listBranches(viewer.id, project.id)).toHaveLength(0);
    await expect(branches.accessibleBranch(analyst.id, project.id, ownerBranch.id))
      .rejects.toMatchObject({ code: 'BRANCH_NOT_FOUND' });
  });

  it('advances only to an owned descendant and rejects stale concurrent updates', async () => {
    const { owner, project, root, ownerChild, analystFork } = await seedProject();
    const branch = await branches.createBranch(owner.id, project.id, {
      name: 'owner/normalize', baseAnalysisObjectId: root.id,
    });
    const advanced = await branches.advanceBranch(owner.id, project.id, branch.id, {
      expectedVersion: 1, headAnalysisObjectId: ownerChild.id,
    });
    expect(advanced.headAnalysisObjectId).toBe(ownerChild.id);
    expect(advanced.version).toBe(2);

    await expect(branches.advanceBranch(owner.id, project.id, branch.id, {
      expectedVersion: 1, headAnalysisObjectId: ownerChild.id,
    })).rejects.toMatchObject({ code: 'BRANCH_VERSION_CONFLICT' });
    await expect(branches.advanceBranch(owner.id, project.id, branch.id, {
      expectedVersion: 2, headAnalysisObjectId: analystFork.id,
    })).rejects.toMatchObject({ code: 'ANALYSIS_OBJECT_NOT_FOUND' });

    const events = await branches.listBranchEvents(owner.id, project.id, branch.id);
    expect(events.map((event) => event.eventType)).toEqual(['created', 'head_updated']);
    expect(events[1]).toMatchObject({
      fromAnalysisObjectId: root.id,
      toAnalysisObjectId: ownerChild.id,
    });
    const audit = await projectAudit.listEvents(owner.id, project.id);
    expect(audit.map((event) => event.action)).toEqual([
      'branch.advanced', 'branch.created',
    ]);
    expect(JSON.stringify(audit)).not.toMatch(/storage|state.?key|script|token/i);
  });

  it('shares explicitly, snapshots review heads, and gates canonical promotion on approval', async () => {
    const { owner, analyst, viewer, project, root, ownerChild } = await seedProject();
    const branch = await branches.createBranch(owner.id, project.id, {
      name: 'owner/review-candidate', baseAnalysisObjectId: root.id,
    });
    await expect(branches.requestReview(owner.id, project.id, branch.id, { title: 'QC review' }))
      .rejects.toMatchObject({ code: 'BRANCH_NOT_REVIEWABLE' });

    const shared = await branches.publishBranch(owner.id, project.id, branch.id);
    expect(shared.visibility).toBe('project');
    expect((await branches.listBranches(analyst.id, project.id)).map((item) => item.id))
      .toContain(branch.id);
    const review = await branches.requestReview(owner.id, project.id, branch.id, {
      title: 'QC review', summary: 'Compare filtering and cluster stability.',
    });
    expect(review.headAnalysisObjectId).toBe(root.id);
    expect((await branches.listReviews(viewer.id, project.id, {}))[0].id).toBe(review.id);
    const comment = await branches.addReviewComment(viewer.id, project.id, review.id, {
      body: 'Please retain the QC threshold rationale.',
    });
    expect(comment).toMatchObject({ reviewId: review.id, authorUserId: viewer.id });
    expect(await branches.listReviewComments(owner.id, project.id, review.id))
      .toEqual([comment]);
    await expect(branches.decideReview(viewer.id, project.id, review.id, { status: 'approved' }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(branches.promoteBranch(owner.id, project.id, branch.id, { reviewId: review.id }))
      .rejects.toMatchObject({ code: 'REVIEW_NOT_APPROVED' });

    const approved = await branches.decideReview(owner.id, project.id, review.id, {
      status: 'approved', note: 'Provenance and QC accepted.',
    });
    expect(approved.status).toBe('approved');
    const canonical = await branches.promoteBranch(owner.id, project.id, branch.id, {
      reviewId: review.id,
    });
    expect(canonical).toMatchObject({
      analysisObjectId: root.id,
      sourceBranchId: branch.id,
      sourceReviewId: review.id,
      version: 1,
    });
    expect(await branches.getCanonical(viewer.id, project.id)).toEqual(canonical);

    const audit = await projectAudit.listEvents(viewer.id, project.id);
    expect(audit.map((event) => event.action)).toEqual(expect.arrayContaining([
      'branch.created', 'branch.published', 'review.requested',
      'review.decided', 'canonical.promoted',
    ]));
    await expect(db.query(
      'UPDATE project_audit_events SET action = action WHERE id = $1',
      [audit[0].id]
    )).rejects.toThrow(/append-only/i);

    const advanced = await branches.advanceBranch(owner.id, project.id, branch.id, {
      expectedVersion: shared.version, headAnalysisObjectId: ownerChild.id,
    });
    expect(advanced.headAnalysisObjectId).toBe(ownerChild.id);
    await expect(branches.promoteBranch(owner.id, project.id, branch.id, { reviewId: review.id }))
      .rejects.toMatchObject({ code: 'REVIEW_NOT_APPROVED' });
  });

  it('compares shared branch heads without exposing private branches or storage state', async () => {
    const { owner, analyst, viewer, project, root, analystFork } = await seedProject();
    const left = await branches.createBranch(owner.id, project.id, {
      name: 'owner/method-a', baseAnalysisObjectId: root.id,
    });
    const right = await branches.createBranch(analyst.id, project.id, {
      name: 'analyst/method-b', baseAnalysisObjectId: analystFork.id,
    });
    await branches.publishBranch(owner.id, project.id, left.id);
    await expect(branches.compareBranches(viewer.id, project.id, left.id, right.id))
      .rejects.toMatchObject({ code: 'BRANCH_NOT_FOUND' });
    await branches.publishBranch(analyst.id, project.id, right.id);

    const comparison = await branches.compareBranches(viewer.id, project.id, left.id, right.id);
    expect(comparison.relation).toBe('shared_lineage');
    expect(comparison.canonicalAnalysisObjectId).toBeNull();
    expect(JSON.stringify(comparison)).not.toMatch(/storage|checkpoint|state.?key|ownerUserId/i);
  });
});

describe.skipIf(!CONFIGURED)('analysis branch HTTP authorization and server-owned fields', () => {
  let server;

  beforeEach(async () => {
    await db.resetSchemaForTests();
    if (!server) server = await startServer();
  });

  afterAll(() => { if (server) server.close(); });

  it('keeps drafts private until publish and exposes only the reviewed promotion workflow', async () => {
    const owner = await createUserWithToken({ email: 'http-branch-owner@example.com' });
    const analyst = await createUserWithToken({ email: 'http-branch-analyst@example.com' });
    const viewer = await createUserWithToken({ email: 'http-branch-viewer@example.com' });
    const org = await db.createOrganizationForUser(owner.user.id, { name: 'HTTP branch lab' });
    const project = await db.createProjectForUser(owner.user.id, {
      organizationId: org.id, name: 'HTTP branch project',
    });
    await db.addProjectMemberByEmail(project.id, analyst.user.email, 'analyst', 'owner');
    await db.addProjectMemberByEmail(project.id, viewer.user.email, 'viewer', 'owner');
    const object = await db.createProjectAnalysisObject(owner.user.id, project.id, {
      objectType: 'seurat', displayName: 'HTTP root',
    });

    const controlled = await api(server, `/api/projects/${project.id}/branches`, {
      method: 'POST', token: owner.token,
      body: { name: 'owner/http', baseAnalysisObjectId: object.id, visibility: 'project' },
    });
    expect(controlled.status).toBe(400);

    const created = await api(server, `/api/projects/${project.id}/branches`, {
      method: 'POST', token: owner.token,
      body: { name: 'owner/http', baseAnalysisObjectId: object.id },
    });
    expect(created.status).toBe(201);
    expect(created.data.visibility).toBe('private');

    const hidden = await api(server, `/api/projects/${project.id}/branches/${created.data.id}/events`, {
      token: analyst.token,
    });
    expect(hidden.status).toBe(404);
    const analystList = await api(server, `/api/projects/${project.id}/branches`, {
      token: analyst.token,
    });
    expect(analystList.data).toEqual([]);

    const published = await api(server, `/api/projects/${project.id}/branches/${created.data.id}/publish`, {
      method: 'POST', token: owner.token, body: {},
    });
    expect(published.status).toBe(200);
    expect(published.data.visibility).toBe('project');

    const requested = await api(server, `/api/projects/${project.id}/branches/${created.data.id}/reviews`, {
      method: 'POST', token: owner.token,
      body: { title: 'Ready for canonical review', summary: 'All provenance attached.' },
    });
    expect(requested.status).toBe(201);
    const viewerDecision = await api(server, `/api/projects/${project.id}/reviews/${requested.data.id}/decision`, {
      method: 'PATCH', token: viewer.token, body: { status: 'approved' },
    });
    expect(viewerDecision.status).toBe(403);
    const approved = await api(server, `/api/projects/${project.id}/reviews/${requested.data.id}/decision`, {
      method: 'PATCH', token: owner.token, body: { status: 'approved', note: 'Accepted.' },
    });
    expect(approved.status).toBe(200);

    const promoted = await api(server, `/api/projects/${project.id}/branches/${created.data.id}/promote`, {
      method: 'POST', token: owner.token, body: { reviewId: requested.data.id },
    });
    expect(promoted.status).toBe(200);
    expect(promoted.data.analysisObjectId).toBe(object.id);
    const canonical = await api(server, `/api/projects/${project.id}/canonical-analysis`, {
      token: viewer.token,
    });
    expect(canonical.status).toBe(200);
    expect(canonical.data).toEqual(promoted.data);
    expect(JSON.stringify(canonical.data)).not.toMatch(/storage|checkpoint|state.?key/i);
  });
});
