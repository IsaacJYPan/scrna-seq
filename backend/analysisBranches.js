'use strict';

const db = require('./pgDatabase');
const projectAudit = require('./projectAudit');

const READ_ROLES = ['owner', 'admin', 'analyst', 'viewer'];
const WRITE_ROLES = ['owner', 'admin', 'analyst'];
const PROMOTE_ROLES = ['owner', 'admin'];
const REVIEW_STATUSES = new Set(['open', 'approved', 'changes_requested', 'closed']);

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function safeText(value, field, maxLength, required = false) {
  const text = typeof value === 'string' ? value.trim() : '';
  const hasControlCharacter = [...text].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
  if ((required && !text) || text.length > maxLength || hasControlCharacter) {
    throw codedError('INVALID_BRANCH', `${field} is invalid.`);
  }
  return text;
}

function branchFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    ownerUserId: Number(row.owner_user_id),
    name: row.name,
    description: row.description || '',
    visibility: row.visibility,
    status: row.status,
    baseAnalysisObjectId: row.base_analysis_object_id,
    headAnalysisObjectId: row.head_analysis_object_id,
    version: Number(row.version),
    createdByUserId: Number(row.created_by_user_id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function eventFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    branchId: row.branch_id,
    actorUserId: Number(row.actor_user_id),
    eventType: row.event_type,
    fromAnalysisObjectId: row.from_analysis_object_id,
    toAnalysisObjectId: row.to_analysis_object_id,
    metadata: typeof row.metadata_json === 'string' ? JSON.parse(row.metadata_json) : row.metadata_json || {},
    createdAt: row.created_at,
  };
}

function reviewFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    branchId: row.branch_id,
    headAnalysisObjectId: row.head_analysis_object_id,
    requestedByUserId: Number(row.requested_by_user_id),
    title: row.title,
    summary: row.summary || '',
    status: row.status,
    decidedByUserId: row.decided_by_user_id == null ? null : Number(row.decided_by_user_id),
    decisionNote: row.decision_note || null,
    decidedAt: row.decided_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function commentFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    reviewId: row.review_id,
    authorUserId: Number(row.author_user_id),
    body: row.body,
    createdAt: row.created_at,
  };
}

function canonicalFromRow(row) {
  if (!row) return null;
  return {
    projectId: row.project_id,
    analysisObjectId: row.analysis_object_id,
    sourceBranchId: row.source_branch_id,
    sourceReviewId: row.source_review_id,
    promotedByUserId: Number(row.promoted_by_user_id),
    version: Number(row.version),
    promotedAt: row.promoted_at,
  };
}

async function objectRow(client, projectId, objectId) {
  const { rows } = await client.query(
    'SELECT * FROM analysis_objects WHERE id = $1 AND project_id = $2',
    [String(objectId), String(projectId)]
  );
  return db.rowToAnalysisObject(rows[0]);
}

async function accessibleBranch(userId, projectId, branchId, roles = READ_ROLES) {
  const membership = await db.requireProjectRole(userId, projectId, roles);
  const { rows } = await db.query(
    'SELECT * FROM analysis_branches WHERE id = $1 AND project_id = $2',
    [String(branchId), String(projectId)]
  );
  const branch = branchFromRow(rows[0]);
  if (!branch || (branch.visibility === 'private' && branch.ownerUserId !== Number(membership.userId))) {
    throw codedError('BRANCH_NOT_FOUND', 'Analysis branch not found.');
  }
  return branch;
}

async function addEvent(client, input) {
  const { rows } = await client.query(
    `INSERT INTO analysis_branch_events
       (id, project_id, branch_id, actor_user_id, event_type,
        from_analysis_object_id, to_analysis_object_id, metadata_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [db.genId('bre'), input.projectId, input.branchId, Number(input.actorUserId), input.eventType,
      input.fromAnalysisObjectId || null, input.toAnalysisObjectId || null,
      JSON.stringify(input.metadata || {})]
  );
  return eventFromRow(rows[0]);
}

async function createBranch(userId, projectId, input = {}) {
  const membership = await db.requireProjectRole(userId, projectId, WRITE_ROLES);
  const baseId = typeof input.baseAnalysisObjectId === 'string' ? input.baseAnalysisObjectId : '';
  const base = await objectRow(db, projectId, baseId);
  if (!base || base.ownerUserId !== Number(membership.userId)) {
    throw codedError('ANALYSIS_OBJECT_NOT_FOUND', 'Analysis object not found.');
  }
  const name = safeText(input.name, 'Branch name', 80, true);
  const description = safeText(input.description, 'Branch description', 1000);
  const id = db.genId('br');
  const pool = await db.connect();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO analysis_branches
         (id, project_id, owner_user_id, name, description, visibility, status,
          base_analysis_object_id, head_analysis_object_id, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5, 'private', 'active', $6, $6, $3)
       RETURNING *`,
      [id, String(projectId), Number(membership.userId), name, description, base.id]
    );
    await addEvent(client, {
      projectId: String(projectId), branchId: id, actorUserId: userId,
      eventType: 'created', toAnalysisObjectId: base.id,
    });
    await projectAudit.recordEvent(client, {
      projectId, actorUserId: userId, action: 'branch.created',
      targetType: 'branch', targetId: id,
      details: { toAnalysisObjectId: base.id, branchVisibility: 'private' },
    });
    await client.query('COMMIT');
    return branchFromRow(rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    if (error && error.code === '23505') {
      throw codedError('BRANCH_NAME_EXISTS', 'A branch with this name already exists for this user.');
    }
    throw error;
  } finally {
    client.release();
  }
}

async function listBranches(userId, projectId) {
  const membership = await db.requireProjectRole(userId, projectId, READ_ROLES);
  const { rows } = await db.query(
    `SELECT * FROM analysis_branches
      WHERE project_id = $1 AND (visibility = 'project' OR owner_user_id = $2)
      ORDER BY updated_at DESC, id DESC`,
    [String(projectId), Number(membership.userId)]
  );
  return rows.map(branchFromRow);
}

async function isDescendant(client, projectId, ancestorId, descendantId) {
  const { rows } = await client.query(
    `WITH RECURSIVE descendants(id) AS (
       SELECT $2::text
       UNION
       SELECT edge.child_analysis_object_id
         FROM analysis_object_edges edge
         JOIN descendants current ON current.id = edge.parent_analysis_object_id
        WHERE edge.project_id = $1
     )
     SELECT 1 FROM descendants WHERE id = $3 LIMIT 1`,
    [String(projectId), String(ancestorId), String(descendantId)]
  );
  return !!rows[0];
}

async function advanceBranch(userId, projectId, branchId, input = {}) {
  await db.requireProjectRole(userId, projectId, WRITE_ROLES);
  const expectedVersion = Number(input.expectedVersion);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    throw codedError('INVALID_BRANCH', 'expectedVersion must be a positive integer.');
  }
  const pool = await db.connect();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const locked = await client.query(
      'SELECT * FROM analysis_branches WHERE id = $1 AND project_id = $2 FOR UPDATE',
      [String(branchId), String(projectId)]
    );
    const branch = branchFromRow(locked.rows[0]);
    if (!branch || branch.ownerUserId !== Number(userId)) {
      throw codedError('BRANCH_NOT_FOUND', 'Analysis branch not found.');
    }
    if (branch.status !== 'active') throw codedError('BRANCH_ARCHIVED', 'Analysis branch is archived.');
    if (branch.version !== expectedVersion) {
      throw codedError('BRANCH_VERSION_CONFLICT', 'Analysis branch changed; refresh before updating it.');
    }
    const next = await objectRow(client, projectId, input.headAnalysisObjectId);
    if (!next || next.ownerUserId !== Number(userId)) {
      throw codedError('ANALYSIS_OBJECT_NOT_FOUND', 'Analysis object not found.');
    }
    if (!(await isDescendant(client, projectId, branch.headAnalysisObjectId, next.id))) {
      throw codedError('INVALID_BRANCH_HEAD', 'New branch head must descend from the current head.');
    }
    const { rows } = await client.query(
      `UPDATE analysis_branches
          SET head_analysis_object_id = $1, version = version + 1, updated_at = now()
        WHERE id = $2 RETURNING *`,
      [next.id, branch.id]
    );
    await addEvent(client, {
      projectId: String(projectId), branchId: branch.id, actorUserId: userId,
      eventType: 'head_updated', fromAnalysisObjectId: branch.headAnalysisObjectId,
      toAnalysisObjectId: next.id,
    });
    await projectAudit.recordEvent(client, {
      projectId, actorUserId: userId, action: 'branch.advanced',
      targetType: 'branch', targetId: branch.id,
      details: {
        fromAnalysisObjectId: branch.headAnalysisObjectId,
        toAnalysisObjectId: next.id,
      },
    });
    await client.query('COMMIT');
    return branchFromRow(rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function publishBranch(userId, projectId, branchId) {
  await db.requireProjectRole(userId, projectId, WRITE_ROLES);
  const pool = await db.connect();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE analysis_branches
          SET visibility = 'project', version = version + 1, updated_at = now()
        WHERE id = $1 AND project_id = $2 AND owner_user_id = $3 AND status = 'active'
        RETURNING *`,
      [String(branchId), String(projectId), Number(userId)]
    );
    const branch = branchFromRow(rows[0]);
    if (!branch) throw codedError('BRANCH_NOT_FOUND', 'Analysis branch not found.');
    await addEvent(client, {
      projectId: String(projectId), branchId: branch.id, actorUserId: userId,
      eventType: 'published', toAnalysisObjectId: branch.headAnalysisObjectId,
    });
    await projectAudit.recordEvent(client, {
      projectId, actorUserId: userId, action: 'branch.published',
      targetType: 'branch', targetId: branch.id,
      details: { toAnalysisObjectId: branch.headAnalysisObjectId, branchVisibility: 'project' },
    });
    await client.query('COMMIT');
    return branch;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function listBranchEvents(userId, projectId, branchId) {
  await accessibleBranch(userId, projectId, branchId);
  const { rows } = await db.query(
    `SELECT * FROM analysis_branch_events
      WHERE branch_id = $1 AND project_id = $2 ORDER BY created_at ASC, id ASC`,
    [String(branchId), String(projectId)]
  );
  return rows.map(eventFromRow);
}

async function requestReview(userId, projectId, branchId, input = {}) {
  const branch = await accessibleBranch(userId, projectId, branchId, WRITE_ROLES);
  if (branch.ownerUserId !== Number(userId) || branch.visibility !== 'project' || branch.status !== 'active') {
    throw codedError('BRANCH_NOT_REVIEWABLE', 'Only the owner can review a shared active branch.');
  }
  const title = safeText(input.title, 'Review title', 160, true);
  const summary = safeText(input.summary, 'Review summary', 4000);
  const pool = await db.connect();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const reviewId = db.genId('rev');
    const { rows } = await client.query(
      `INSERT INTO analysis_branch_reviews
         (id, project_id, branch_id, head_analysis_object_id, requested_by_user_id, title, summary)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [reviewId, String(projectId), branch.id, branch.headAnalysisObjectId,
        Number(userId), title, summary]
    );
    await projectAudit.recordEvent(client, {
      projectId, actorUserId: userId, action: 'review.requested',
      targetType: 'review', targetId: reviewId,
      details: { toAnalysisObjectId: branch.headAnalysisObjectId },
    });
    await client.query('COMMIT');
    return reviewFromRow(rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function listReviews(userId, projectId, filters = {}) {
  await db.requireProjectRole(userId, projectId, READ_ROLES);
  const params = [String(projectId), Number(userId)];
  const clauses = ['review.project_id = $1', "(branch.visibility = 'project' OR branch.owner_user_id = $2)"];
  if (filters.branchId) {
    params.push(String(filters.branchId));
    clauses.push(`review.branch_id = $${params.length}`);
  }
  if (filters.status) {
    if (!REVIEW_STATUSES.has(filters.status)) throw codedError('INVALID_REVIEW', 'Review status is invalid.');
    params.push(filters.status);
    clauses.push(`review.status = $${params.length}`);
  }
  const { rows } = await db.query(
    `SELECT review.* FROM analysis_branch_reviews review
       JOIN analysis_branches branch ON branch.id = review.branch_id
      WHERE ${clauses.join(' AND ')} ORDER BY review.created_at DESC, review.id DESC`,
    params
  );
  return rows.map(reviewFromRow);
}

async function accessibleReview(userId, projectId, reviewId) {
  await db.requireProjectRole(userId, projectId, READ_ROLES);
  const { rows } = await db.query(
    `SELECT review.* FROM analysis_branch_reviews review
       JOIN analysis_branches branch ON branch.id = review.branch_id
      WHERE review.id = $1 AND review.project_id = $2
        AND (branch.visibility = 'project' OR branch.owner_user_id = $3)`,
    [String(reviewId), String(projectId), Number(userId)]
  );
  const review = reviewFromRow(rows[0]);
  if (!review) throw codedError('BRANCH_NOT_FOUND', 'Analysis review not found.');
  return review;
}

async function listReviewComments(userId, projectId, reviewId) {
  await accessibleReview(userId, projectId, reviewId);
  const { rows } = await db.query(
    `SELECT * FROM analysis_branch_review_comments
      WHERE project_id = $1 AND review_id = $2 ORDER BY created_at, id`,
    [String(projectId), String(reviewId)]
  );
  return rows.map(commentFromRow);
}

async function addReviewComment(userId, projectId, reviewId, input = {}) {
  await db.requireProjectRole(userId, projectId, READ_ROLES);
  const review = await accessibleReview(userId, projectId, reviewId);
  if (review.status === 'closed') throw codedError('REVIEW_NOT_OPEN', 'Review is closed.');
  const body = safeText(input.body, 'Review comment', 4000, true);
  const pool = await db.connect();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const id = db.genId('com');
    const { rows } = await client.query(
      `INSERT INTO analysis_branch_review_comments
         (id, project_id, review_id, author_user_id, body)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [id, String(projectId), review.id, Number(userId), body]
    );
    await projectAudit.recordEvent(client, {
      projectId, actorUserId: userId, action: 'review.commented',
      targetType: 'review', targetId: review.id,
    });
    await client.query('COMMIT');
    return commentFromRow(rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function decideReview(userId, projectId, reviewId, input = {}) {
  await db.requireProjectRole(userId, projectId, PROMOTE_ROLES);
  const status = String(input.status || '');
  if (!['approved', 'changes_requested', 'closed'].includes(status)) {
    throw codedError('INVALID_REVIEW', 'Review decision is invalid.');
  }
  const note = safeText(input.note, 'Review decision note', 4000);
  const pool = await db.connect();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE analysis_branch_reviews
          SET status = $1, decided_by_user_id = $2, decision_note = $3,
              decided_at = now(), updated_at = now()
        WHERE id = $4 AND project_id = $5 AND status = 'open'
        RETURNING *`,
      [status, Number(userId), note || null, String(reviewId), String(projectId)]
    );
    if (!rows[0]) throw codedError('REVIEW_NOT_OPEN', 'Review was not found or is no longer open.');
    await projectAudit.recordEvent(client, {
      projectId, actorUserId: userId, action: 'review.decided',
      targetType: 'review', targetId: reviewId, details: { decision: status },
    });
    await client.query('COMMIT');
    return reviewFromRow(rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function promoteBranch(userId, projectId, branchId, input = {}) {
  await db.requireProjectRole(userId, projectId, PROMOTE_ROLES);
  const pool = await db.connect();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const branchRows = await client.query(
      'SELECT * FROM analysis_branches WHERE id = $1 AND project_id = $2 FOR UPDATE',
      [String(branchId), String(projectId)]
    );
    const branch = branchFromRow(branchRows.rows[0]);
    if (!branch || branch.visibility !== 'project' || branch.status !== 'active') {
      throw codedError('BRANCH_NOT_FOUND', 'Analysis branch not found.');
    }
    const reviewRows = await client.query(
      `SELECT * FROM analysis_branch_reviews
        WHERE id = $1 AND project_id = $2 AND branch_id = $3 AND status = 'approved'
        FOR UPDATE`,
      [String(input.reviewId || ''), String(projectId), branch.id]
    );
    const review = reviewFromRow(reviewRows.rows[0]);
    if (!review || review.headAnalysisObjectId !== branch.headAnalysisObjectId) {
      throw codedError('REVIEW_NOT_APPROVED', 'The current branch head requires an approved review.');
    }
    const { rows } = await client.query(
      `INSERT INTO project_canonical_analyses
         (project_id, analysis_object_id, source_branch_id, source_review_id,
          promoted_by_user_id, version, promoted_at)
       VALUES ($1, $2, $3, $4, $5, 1, now())
       ON CONFLICT (project_id) DO UPDATE SET
         analysis_object_id = EXCLUDED.analysis_object_id,
         source_branch_id = EXCLUDED.source_branch_id,
         source_review_id = EXCLUDED.source_review_id,
         promoted_by_user_id = EXCLUDED.promoted_by_user_id,
         version = project_canonical_analyses.version + 1,
         promoted_at = now()
       RETURNING *`,
      [String(projectId), branch.headAnalysisObjectId, branch.id, review.id, Number(userId)]
    );
    await addEvent(client, {
      projectId: String(projectId), branchId: branch.id, actorUserId: userId,
      eventType: 'promoted', toAnalysisObjectId: branch.headAnalysisObjectId,
      metadata: { canonicalVersion: Number(rows[0].version) },
    });
    await projectAudit.recordEvent(client, {
      projectId, actorUserId: userId, action: 'canonical.promoted',
      targetType: 'analysis_object', targetId: branch.headAnalysisObjectId,
      details: { canonicalVersion: Number(rows[0].version) },
    });
    await client.query('COMMIT');
    return canonicalFromRow(rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function getCanonical(userId, projectId) {
  await db.requireProjectRole(userId, projectId, READ_ROLES);
  const { rows } = await db.query(
    'SELECT * FROM project_canonical_analyses WHERE project_id = $1',
    [String(projectId)]
  );
  return canonicalFromRow(rows[0]);
}

async function headSummary(projectId, object) {
  const { rows: jobRows } = await db.query(
    `SELECT job_type, parameters_json
       FROM jobs
      WHERE project_id = $1 AND result_analysis_object_id = $2 AND status = 'completed'
      ORDER BY completed_at DESC NULLS LAST, created_at DESC, id DESC LIMIT 1`,
    [String(projectId), object.id]
  );
  const { rows: artifactRows } = await db.query(
    `SELECT artifact_type, COUNT(*)::int AS count
       FROM job_artifacts
      WHERE project_id = $1 AND result_analysis_object_id = $2 AND status = 'available'
      GROUP BY artifact_type ORDER BY artifact_type`,
    [String(projectId), object.id]
  );
  const producingJob = jobRows[0] || null;
  const reviewedParameterJobs = new Set([
    'pbmc.pipeline.v1', 'seurat.pipeline.v1', 'spatial.seurat.v1', 'checkpoint.fork.v1',
  ]);
  return {
    objectType: object.objectType,
    displayName: object.displayName || null,
    datasetId: object.datasetId || null,
    lineageRootId: object.lineageRootId,
    producingJobType: producingJob ? producingJob.job_type : null,
    resolvedParameters: producingJob && reviewedParameterJobs.has(producingJob.job_type)
      ? (typeof producingJob.parameters_json === 'string'
        ? JSON.parse(producingJob.parameters_json) : producingJob.parameters_json || {})
      : null,
    artifactCounts: Object.fromEntries(
      artifactRows.map((row) => [row.artifact_type, Number(row.count)])
    ),
  };
}

async function compareBranches(userId, projectId, leftBranchId, rightBranchId) {
  const left = await accessibleBranch(userId, projectId, leftBranchId);
  const right = await accessibleBranch(userId, projectId, rightBranchId);
  const leftObject = await objectRow(db, projectId, left.headAnalysisObjectId);
  const rightObject = await objectRow(db, projectId, right.headAnalysisObjectId);
  const canonical = await getCanonical(userId, projectId);
  const [leftSummary, rightSummary] = await Promise.all([
    headSummary(projectId, leftObject),
    headSummary(projectId, rightObject),
  ]);
  const sameHead = leftObject.id === rightObject.id;
  const sharedLineage = leftObject.lineageRootId === rightObject.lineageRootId;
  return {
    projectId: String(projectId),
    left: {
      branchId: left.id, headAnalysisObjectId: leftObject.id, version: left.version,
      summary: leftSummary,
    },
    right: {
      branchId: right.id, headAnalysisObjectId: rightObject.id, version: right.version,
      summary: rightSummary,
    },
    relation: sameHead ? 'same_head' : sharedLineage ? 'shared_lineage' : 'unrelated',
    canonicalAnalysisObjectId: canonical ? canonical.analysisObjectId : null,
    leftIsCanonical: !!canonical && canonical.analysisObjectId === leftObject.id,
    rightIsCanonical: !!canonical && canonical.analysisObjectId === rightObject.id,
  };
}

module.exports = {
  createBranch,
  listBranches,
  accessibleBranch,
  advanceBranch,
  publishBranch,
  listBranchEvents,
  requestReview,
  listReviews,
  listReviewComments,
  addReviewComment,
  decideReview,
  promoteBranch,
  getCanonical,
  compareBranches,
  branchFromRow,
  eventFromRow,
  reviewFromRow,
  commentFromRow,
  canonicalFromRow,
};
