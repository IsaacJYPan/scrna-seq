'use strict';

// Study envelopes (docs/spec.md 8.2): the finite space an agent may work in.
// A person fixes the exact input versions, the approved release, the parameter
// values the agent may choose between, a trial limit, and a compute budget.
// Any parameter not listed as a variation is fixed. Content is immutable.

const crypto = require('crypto');
const { READ_ROLES, WRITE_ROLES, codedError } = require('../policy/agentCapabilities');
const { recordAutomationEvent } = require('../automation/automationAudit');
const { canonicalJson, validateScalar } = require('../workflowTrust/catalog');
const { slurmConfig } = require('../executors/slurm');

const MAX_INPUTS = 10;
const SLURM_JOB_TYPES = ['seurat.pipeline.v1', 'seurat.multisample.v1'];
const MAX_VALUES_PER_VARIATION = 10;
const MAX_VARIED_PARAMETERS = 6;
const DATASET_ID = /^ds_[A-Za-z0-9]+$/;
const STUDY_ID = /^study_[0-9a-f]{24}$/;

function requireHuman(actor) {
  if (actor?.kind !== 'human') throw codedError('HUMAN_ACTOR_REQUIRED', 'This operation requires a signed-in person.', 403);
}

function intInRange(value, field, min, max, fallback) {
  const n = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    throw codedError('INVALID_INPUT', `${field} must be an integer from ${min} to ${max}.`, 400);
  }
  return n;
}

function scalar(value) {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

function publicStudy(row, trials = null) {
  return {
    id: row.id,
    projectId: row.project_id,
    createdByUserId: Number(row.created_by_user_id),
    name: row.name,
    objective: row.objective,
    releaseId: row.release_id,
    approvalId: row.approval_id,
    inputs: row.inputs_json,
    fixedParameters: row.protected_json,
    variations: row.variations_json,
    maxTrials: row.max_trials,
    maxOutstandingRuns: row.max_outstanding_runs,
    maxCpuSeconds: Number(row.max_cpu_seconds),
    executionTarget: row.execution_target || 'local',
    sourceStudyId: row.source_study_id || null,
    status: row.status,
    closedAt: row.closed_at,
    acceptedRunId: row.accepted_run_id,
    acceptedVersion: row.accepted_version,
    createdAt: row.created_at,
    ...(trials ? { trials } : {}),
  };
}

function createStudyService({ db, withTransaction, approvals }) {
  async function create(actor, projectId, body = {}) {
    requireHuman(actor);
    const allowed = ['name', 'objective', 'releaseId', 'datasetIds', 'fixedParameters', 'variations',
      'maxTrials', 'maxOutstandingRuns', 'maxCpuSeconds', 'executionTarget', 'sourceStudyId'];
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw codedError('INVALID_INPUT', 'A JSON object is required.', 400);
    for (const key of Object.keys(body)) {
      if (!allowed.includes(key)) throw codedError('UNKNOWN_FIELD', `Unknown field: ${key.slice(0, 64)}.`, 400);
    }
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 200) throw codedError('INVALID_INPUT', 'name must be 1-200 characters.', 400);
    const objective = body.objective === undefined ? '' : String(body.objective).slice(0, 4000);
    const releases = await approvals.ensureCatalog();
    const release = releases.find((r) => r.id === body.releaseId);
    if (!release) throw codedError('NOT_FOUND', 'Workflow release not found.', 404);
    const schema = release.definition.parameterSchema;

    const fixed = body.fixedParameters === undefined ? {} : body.fixedParameters;
    const variations = body.variations === undefined ? {} : body.variations;
    for (const [label, obj] of [['fixedParameters', fixed], ['variations', variations]]) {
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw codedError('INVALID_INPUT', `${label} must be an object.`, 400);
      for (const key of Object.keys(obj)) {
        if (!Object.prototype.hasOwnProperty.call(schema, key)) {
          throw codedError('UNKNOWN_PARAMETER', `Unknown parameter '${key.slice(0, 64)}'.`, 400);
        }
      }
    }
    if (Object.keys(variations).length > MAX_VARIED_PARAMETERS) {
      throw codedError('INVALID_INPUT', `At most ${MAX_VARIED_PARAMETERS} parameters may vary.`, 400);
    }
    for (const [key, values] of Object.entries(variations)) {
      if (Object.prototype.hasOwnProperty.call(fixed, key)) {
        throw codedError('INVALID_INPUT', `'${key}' cannot be both fixed and varied.`, 400);
      }
      if (!Array.isArray(values) || values.length < 1 || values.length > MAX_VALUES_PER_VARIATION || !values.every(scalar)) {
        throw codedError('INVALID_INPUT', `Variation '${key}' needs 1-${MAX_VALUES_PER_VARIATION} plain values.`, 400);
      }
      if (new Set(values.map((v) => JSON.stringify(v))).size !== values.length) {
        throw codedError('INVALID_INPUT', `Variation '${key}' has duplicate values.`, 400);
      }
    }
    // Every fixed value and every allowed alternative must be individually
    // valid. Cross-parameter constraints are checked for each plan.
    try {
      for (const [key, value] of Object.entries(fixed)) validateScalar(schema, key, value);
      for (const [key, values] of Object.entries(variations)) {
        for (const value of values) validateScalar(schema, key, value);
      }
    } catch (error) {
      throw codedError('INVALID_PARAMETER', error.message, 400);
    }

    const inputSpec = release.definition.inputs[0];
    const composed = inputSpec.kind === 'analysis_object';
    if (composed && body.datasetIds !== undefined) {
      throw codedError('INVALID_INPUT', 'This workflow runs on the accepted result of another study; give sourceStudyId, not datasetIds.', 400);
    }
    if (!composed && body.sourceStudyId !== undefined) {
      throw codedError('INVALID_INPUT', 'This workflow takes datasets as input; sourceStudyId is not allowed.', 400);
    }
    const datasetIds = composed ? [] : body.datasetIds;
    if (!composed && (!Array.isArray(datasetIds) || datasetIds.length < 1 || datasetIds.length > MAX_INPUTS
        || !datasetIds.every((id) => typeof id === 'string' && DATASET_ID.test(id))
        || new Set(datasetIds).size !== datasetIds.length)) {
      throw codedError('INVALID_INPUT', `datasetIds must list 1-${MAX_INPUTS} distinct datasets.`, 400);
    }
    const executionTarget = body.executionTarget === undefined ? 'local' : body.executionTarget;
    if (!['local', 'slurm'].includes(executionTarget)) throw codedError('INVALID_INPUT', 'executionTarget must be local or slurm.', 400);
    if (executionTarget === 'slurm' && !SLURM_JOB_TYPES.includes(release.jobType)) {
      throw codedError('INVALID_INPUT', 'This workflow cannot run on the Slurm target yet.', 400);
    }
    if (executionTarget === 'slurm' && !slurmConfig().enabled) {
      throw codedError('TARGET_UNAVAILABLE', 'The Slurm target is not configured for this installation.', 409);
    }
    const maxTrials = intInRange(body.maxTrials, 'maxTrials', 1, 100, 4);
    const maxOutstandingRuns = intInRange(body.maxOutstandingRuns, 'maxOutstandingRuns', 1, 10, 1);
    const maxCpuSeconds = intInRange(body.maxCpuSeconds, 'maxCpuSeconds', 1, 100000000,
      maxTrials * release.definition.resources.cpus * release.definition.resources.maxWallSeconds);

    await db.requireProjectRole(actor.userId, projectId, WRITE_ROLES);
    const { rows: approvalRows } = await db.query(
      `SELECT wa.id FROM workflow_approvals wa JOIN workflow_releases wr ON wr.id = wa.release_id
        WHERE wa.project_id = $1 AND wa.release_id = $2 AND wa.revoked_at IS NULL AND wr.status = 'current'`,
      [String(projectId), release.id]
    );
    if (!approvalRows[0]) throw codedError('RELEASE_NOT_APPROVED', 'This release is not approved for this project.', 409);

    // Pin exact input versions. Each study gets its own dataset input object so
    // agent runs never reuse a person's working analysis objects.
    const inputs = [];
    for (const datasetId of datasetIds) {
      const { rows } = await db.query('SELECT * FROM datasets WHERE id = $1 AND project_id = $2', [datasetId, String(projectId)]);
      const dataset = rows[0];
      if (!dataset) throw codedError('DATASET_NOT_FOUND', 'Dataset not found.', 404);
      const fileTypes = release.definition.inputs[0].fileTypes;
      if (!fileTypes.includes(dataset.file_type) || dataset.upload_status !== 'uploaded' || dataset.validation_status === 'invalid') {
        throw codedError('INPUT_NOT_APPLICABLE', `Dataset ${datasetId} is not a ready ${fileTypes.join('/')} input for this workflow.`, 400);
      }
      if (!/^[0-9a-f]{64}$/.test(String(dataset.sha256 || ''))) {
        throw codedError('INPUT_NOT_PINNED', `Dataset ${datasetId} has no recorded checksum, so its exact version cannot be pinned.`, 400);
      }
      const object = await db.createProjectAnalysisObject(actor.userId, projectId, {
        datasetId, objectType: 'matrix', displayName: `Study input ${datasetId}`,
        metadata: { source: 'dataset', datasetId, fileType: dataset.file_type, scientific_output: false, studyInput: true },
      });
      inputs.push({ datasetId, datasetSha256: dataset.sha256, analysisObjectId: object.id });
    }

    let sourceStudyId = null;
    if (composed) {
      const source = await acceptedSource(actor, projectId, body.sourceStudyId, inputSpec, releases);
      sourceStudyId = source.studyId;
      inputs.push(source.input);
    }

    return withTransaction(async (client) => {
      const id = `study_${crypto.randomBytes(12).toString('hex')}`;
      const { rows } = await client.query(
        `INSERT INTO study_envelopes
           (id, project_id, created_by_user_id, name, objective, release_id, approval_id, inputs_json, protected_json,
            variations_json, max_trials, max_outstanding_runs, max_cpu_seconds, execution_target, source_study_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11, $12, $13, $14, $15) RETURNING *`,
        [id, String(projectId), actor.userId, name, objective, release.id, approvalRows[0].id, JSON.stringify(inputs),
          canonicalJson(fixed), canonicalJson(variations), maxTrials, maxOutstandingRuns, maxCpuSeconds, executionTarget,
          sourceStudyId]
      );
      await recordAutomationEvent(client, {
        projectId, actor, action: 'study.created', decision: 'allowed', targetType: 'study', targetId: id,
      });
      return publicStudy(rows[0]);
    });
  }

  // Composition (spec 8.3): a follow-on study binds the exact result a person
  // accepted in a source study of the release this one declares as its input.
  // The binding is fixed at creation; accepting a different result later does
  // not change what this study runs on.
  async function acceptedSource(actor, projectId, sourceStudyId, inputSpec, releases) {
    if (typeof sourceStudyId !== 'string' || !STUDY_ID.test(sourceStudyId)) {
      throw codedError('INVALID_INPUT', 'sourceStudyId must name a study.', 400);
    }
    const { rows } = await db.query(
      `SELECT se.*, j.result_analysis_object_id, j.dataset_id, ep.canonical_json
         FROM study_envelopes se
         LEFT JOIN agent_runs ar ON ar.id = se.accepted_run_id
         LEFT JOIN jobs j ON j.id = ar.job_id
         LEFT JOIN execution_plans ep ON ep.id = ar.plan_id
        WHERE se.id = $1 AND se.project_id = $2`,
      [sourceStudyId, String(projectId)]
    );
    const source = rows[0];
    if (!source) throw codedError('NOT_FOUND', 'Source study not found.', 404);
    const { rows: rel } = await db.query('SELECT release_key FROM workflow_releases WHERE id = $1', [source.release_id]);
    if (rel[0]?.release_key !== inputSpec.fromRelease) {
      const wanted = releases.find((r) => r.key === inputSpec.fromRelease);
      throw codedError('INPUT_NOT_APPLICABLE', `The source study must run ${wanted ? wanted.definition.title : inputSpec.fromRelease}.`, 400);
    }
    if (!source.accepted_run_id || !source.result_analysis_object_id) {
      throw codedError('SOURCE_NOT_ACCEPTED', 'Accept a result in the source study first.', 409);
    }
    const { rows: objects } = await db.query(
      'SELECT id, owner_user_id FROM analysis_objects WHERE id = $1 AND project_id = $2',
      [source.result_analysis_object_id, String(projectId)]
    );
    if (!objects[0]) throw codedError('INPUT_CHANGED', 'The accepted result is no longer available.', 409);
    // Runs execute as the study creator, who must own the result being read.
    if (String(objects[0].owner_user_id) !== String(actor.userId)) {
      throw codedError('INPUT_NOT_APPLICABLE', 'You can only build on accepted results of studies you created.', 403);
    }
    const plan = JSON.parse(source.canonical_json);
    return {
      studyId: source.id,
      input: {
        datasetId: plan.inputs.datasetId,
        datasetSha256: plan.inputs.datasetSha256,
        analysisObjectId: source.result_analysis_object_id,
        sourceStudyId: source.id,
        sourceRunId: source.accepted_run_id,
        sourceAcceptedVersion: source.accepted_version,
      },
    };
  }

  async function trialsFor(studyId) {
    const { rows } = await db.query(
      `SELECT ar.id, ar.trial_number, ar.created_at, ar.cancel_requested_at, ar.agent_principal_id, ar.delegation_id,
              ep.canonical_json, j.status AS job_status, j.result_analysis_object_id, j.completed_at
         FROM agent_runs ar JOIN execution_plans ep ON ep.id = ar.plan_id JOIN jobs j ON j.id = ar.job_id
        WHERE ar.study_id = $1 ORDER BY ar.trial_number`,
      [studyId]
    );
    // The full bounded trial history: every attempted variant, not only the best.
    return rows.map((row) => {
      const plan = JSON.parse(row.canonical_json);
      return {
        runId: row.id,
        trialNumber: row.trial_number,
        agentPrincipalId: row.agent_principal_id,
        delegationId: row.delegation_id,
        chosenParameters: plan.choices,
        jobStatus: row.job_status,
        cancelRequested: Boolean(row.cancel_requested_at),
        resultAnalysisObjectId: row.result_analysis_object_id,
        createdAt: row.created_at,
        completedAt: row.completed_at,
      };
    });
  }

  async function listForHuman(actor, projectId) {
    requireHuman(actor);
    await db.requireProjectRole(actor.userId, projectId, READ_ROLES);
    const { rows } = await db.query(
      'SELECT * FROM study_envelopes WHERE project_id = $1 ORDER BY created_at DESC, id DESC LIMIT 100', [String(projectId)]);
    return { schema: 'traceomics.studies.v1', studies: rows.map((row) => publicStudy(row)) };
  }

  async function getForHuman(actor, projectId, studyId) {
    requireHuman(actor);
    await db.requireProjectRole(actor.userId, projectId, READ_ROLES);
    if (!STUDY_ID.test(String(studyId))) throw codedError('NOT_FOUND', 'Study not found.', 404);
    const { rows } = await db.query('SELECT * FROM study_envelopes WHERE id = $1 AND project_id = $2', [studyId, String(projectId)]);
    if (!rows[0]) throw codedError('NOT_FOUND', 'Study not found.', 404);
    return publicStudy(rows[0], await trialsFor(studyId));
  }

  async function close(actor, projectId, studyId) {
    requireHuman(actor);
    if (!STUDY_ID.test(String(studyId))) throw codedError('NOT_FOUND', 'Study not found.', 404);
    return withTransaction(async (client) => {
      await db.requireProjectRole(actor.userId, projectId, WRITE_ROLES);
      const { rows } = await client.query(
        `UPDATE study_envelopes SET status = 'closed', closed_at = now(), closed_by_user_id = $3
          WHERE id = $1 AND project_id = $2 AND status = 'open' RETURNING *`,
        [studyId, String(projectId), actor.userId]
      );
      if (!rows[0]) throw codedError('NOT_FOUND', 'Open study not found.', 404);
      await recordAutomationEvent(client, {
        projectId, actor, action: 'study.closed', decision: 'allowed', targetType: 'study', targetId: studyId,
      });
      return publicStudy(rows[0]);
    });
  }

  // Agents see only open studies their sponsor created in the delegated project.
  async function listForAgent(actor) {
    const { rows } = await db.query(
      `SELECT * FROM study_envelopes WHERE project_id = $1 AND created_by_user_id = $2 AND status = 'open'
        ORDER BY created_at DESC LIMIT 100`,
      [actor.delegation.projectId, actor.sponsorUserId]
    );
    return rows.map((row) => publicStudy(row));
  }

  async function getForAgent(actor, studyId) {
    if (!STUDY_ID.test(String(studyId))) throw codedError('NOT_FOUND', 'Study not found.', 404);
    const { rows } = await db.query(
      'SELECT * FROM study_envelopes WHERE id = $1 AND project_id = $2 AND created_by_user_id = $3',
      [studyId, actor.delegation.projectId, actor.sponsorUserId]
    );
    if (!rows[0]) throw codedError('NOT_FOUND', 'Study not found.', 404);
    return publicStudy(rows[0], await trialsFor(studyId));
  }

  return { create, listForHuman, getForHuman, close, listForAgent, getForAgent, trialsFor };
}

module.exports = { createStudyService, publicStudy, STUDY_ID };
