'use strict';

// The worker side of the durable job queue: claiming, leases and heartbeats,
// execution receipts, completion, failure, release, log appends, lease reaping
// and the claim-scoped input lookups each job handler reads.
function createJobWorkerStore({
  connect, query, codedError, parseJson, crypto, storage, executionTargets, expertRAccessSql,
  addSeconds, generateClaimToken, normalizeTimestamp, toCanonicalTs, normalizeWorkerNow, normalizeLeaseSeconds,
  requireWorkerId, requireClaimToken, validateJobTransition, normalizeJobError, normalizeJobLogEntry,
  normalizeArtifactSizeBytes, normalizeChecksumSha256, rowToJob,
  getDatasetRow, getProjectAnalysisObjectRow, getAnalysisObjectForUser, getPrivateAnalysisObjectForUser,
  resolveCheckpointArtifact, resolveExpertRPrivateInputs,
  validateMultiSampleSeuratParams, assertSupportedMultiSampleDatasets, validateConditionComparisonParams,
  ALLOWED_JOB_TYPES, RETRYABLE_DURABLE_JOB_TYPES, PROJECT_JOB_WRITE_ROLES, EXPERT_R_EXECUTE_CAPABILITY,
  WORKER_CLAIM_GATE_LOCK, RECOVERY_ONLY_PENDING_CODES, COMMITTED_OUTPUT_RECOVERY_PENDING,
  R_DISPATCH_STARTED, R_RETRY_RECOVERY_PENDING, R_TIMEOUT_INDETERMINATE, R_TIMEOUT_RECOVERY_PENDING,
  R_TIMEOUT_RECOVERY_MAX_GRACE_SECONDS,
}) {
  async function getJobRowById(id) {
    if (typeof id !== 'string' || id === '') return null;
    const { rows } = await query('SELECT * FROM jobs WHERE id = $1', [String(id)]);
    return rows[0] || null;
  }

  function rowToWorkerJob(row) {
    if (!row) return null;
    return {
      ...rowToJob(row),
      workerId: row.worker_id,
      claimToken: row.claim_token,
      leaseExpiresAt: toCanonicalTs(row.lease_expires_at),
      heartbeatAt: toCanonicalTs(row.heartbeat_at),
      lockedAt: toCanonicalTs(row.locked_at),
      attempts: Number(row.attempts || 0),
      maxAttempts: Number(row.max_attempts || 1),
      priority: Number(row.priority || 0),
      lastWorkerError: row.last_worker_error ? parseJson(row.last_worker_error, null) : null,
      // Set by the claim: whether an agent run owns this job. Agent jobs must
      // pass the workflow trust recheck; it is never skipped for them.
      ...(typeof row.is_agent_job === 'boolean' ? { agentRun: row.is_agent_job } : {})
    };
  }

  async function getWorkerJob(jobId) {
    return rowToWorkerJob(await getJobRowById(jobId));
  }

  function workerHoldsClaim(row, workerId, claimToken, now) {
    const lease = row && row.lease_expires_at ? normalizeTimestamp(row.lease_expires_at) : null;
    return !!row
      && row.status === 'running'
      && row.worker_id === workerId
      && typeof row.claim_token === 'string'
      && row.claim_token === claimToken
      && lease
      && lease.getTime() > now.getTime();
  }

  const CLAIMED_OWNED_OBJECT_JOB_TYPES = new Set([
    'trusted.method.v1',
    'r.object.inspect',
    'pbmc.pipeline.v1',
    'checkpoint.save.v1',
    'checkpoint.load.v1',
    'deg.find_markers.v1',
    'enrichment.gsea.v1',
    'cellchat.infer.v1',
    'explore.summarize.v1',
    'condition.pseudobulk_de.v1',
    'expert.r.v1',
  ]);

  // Validates the worker's identity and claim before any worker-side write. Returns
  // the normalized worker id, claim token and clock so callers can re-check the
  // claim under a row lock inside their own transaction.
  async function claimedJobContextByWorker(jobId, workerId, claimToken, opts = {}) {
    const wid = requireWorkerId(workerId);
    const token = requireClaimToken(claimToken);
    const now = normalizeWorkerNow(opts);
    const row = await getJobRowById(jobId);
    if (!row) throw codedError('JOB_NOT_FOUND', 'Job not found.');
    if (!workerHoldsClaim(row, wid, token, now)) {
      throw codedError('CLAIM_LOST', 'This worker no longer holds a valid claim on the job.');
    }
    return { row, wid, token, now };
  }

  async function requireClaimedJobRowByWorker(jobId, workerId, claimToken, opts = {}, expectedJobType = null) {
    const { row } = await claimedJobContextByWorker(jobId, workerId, claimToken, opts);
    if (expectedJobType && row.job_type !== expectedJobType) {
      throw codedError('INVALID_JOB_TYPE', `A claimed ${expectedJobType} job is required.`);
    }
    return row;
  }

  async function resolveOwnedAnalysisObjectForClaimedJob(row) {
    if (!row.analysis_object_id) {
      throw codedError('ANALYSIS_OBJECT_NOT_FOUND', 'Analysis object not found.');
    }
    const object = row.project_id
      ? await getProjectAnalysisObjectRow(row.analysis_object_id, row.project_id)
      : await getPrivateAnalysisObjectForUser(row.analysis_object_id, Number(row.owner_user_id));
    if (!object || object.ownerUserId !== Number(row.owner_user_id)) {
      throw codedError('ANALYSIS_OBJECT_NOT_FOUND', 'Analysis object not found.');
    }
    return object;
  }

  // Worker-only resolvers authorize against the live job claim, not the creator's
  // current project membership. Membership is authoritative up to claim time; once
  // a project job is running, these helpers preserve its exact job/project/resource
  // binding so a validly claimed handler may finish after a later demotion/removal.
  // Every helper derives resource ids from the trusted job row and rechecks the
  // worker id, claim token, running status, and unexpired lease on each call.
  async function getOwnedAnalysisObjectForJobByWorker(jobId, workerId, claimToken, opts = {}) {
    const row = await requireClaimedJobRowByWorker(jobId, workerId, claimToken, opts);
    if (!CLAIMED_OWNED_OBJECT_JOB_TYPES.has(row.job_type)) {
      throw codedError('INVALID_JOB_TYPE', 'A claimed live-object job is required.');
    }
    return resolveOwnedAnalysisObjectForClaimedJob(row);
  }

  async function getSeuratPipelineInputsForJobByWorker(jobId, workerId, claimToken, opts = {}) {
    const row = await requireClaimedJobRowByWorker(
      jobId, workerId, claimToken, opts, 'seurat.pipeline.v1'
    );
    if (!row.project_id || !row.dataset_id || !row.analysis_object_id) {
      throw codedError('INVALID_JOB_CONTEXT', 'Seurat pipeline job inputs are incomplete.');
    }
    const [dataset, inputObject] = await Promise.all([
      getDatasetRow(row.dataset_id, row.project_id),
      getProjectAnalysisObjectRow(row.analysis_object_id, row.project_id),
    ]);
    if (!dataset) throw codedError('DATASET_NOT_FOUND', 'Dataset not found.');
    if (!inputObject) throw codedError('ANALYSIS_OBJECT_NOT_FOUND', 'Analysis object not found.');
    if (inputObject.datasetId !== dataset.id) {
      throw codedError('INVALID_PARAMETERS', 'Seurat pipeline input object must reference the same dataset as the job.');
    }
    return { dataset, inputObject };
  }

  async function getMultiSampleSeuratPipelineInputsForJobByWorker(jobId, workerId, claimToken, opts = {}) {
    const row = await requireClaimedJobRowByWorker(
      jobId, workerId, claimToken, opts, 'seurat.multisample.v1'
    );
    if (!row.project_id || !row.dataset_id || !row.analysis_object_id) {
      throw codedError('INVALID_JOB_CONTEXT', 'Multi-sample Seurat pipeline job inputs are incomplete.');
    }
    const validated = validateMultiSampleSeuratParams(parseJson(row.parameters_json, {}));
    if (validated.samples[0].datasetId !== row.dataset_id) {
      throw codedError('INVALID_PARAMETERS', 'Primary datasetId must match the first multi-sample input.');
    }
    const [datasets, inputObject] = await Promise.all([
      Promise.all(validated.samples.map(sample => getDatasetRow(sample.datasetId, row.project_id))),
      getProjectAnalysisObjectRow(row.analysis_object_id, row.project_id),
    ]);
    assertSupportedMultiSampleDatasets(datasets, validated.samples);
    if (!inputObject || inputObject.datasetId !== row.dataset_id) {
      throw codedError('ANALYSIS_OBJECT_NOT_FOUND', 'Analysis object not found.');
    }
    return { datasets, inputObject, validated };
  }

  async function getSpatialPipelineInputsForJobByWorker(jobId, workerId, claimToken, opts = {}) {
    const row = await requireClaimedJobRowByWorker(
      jobId, workerId, claimToken, opts, 'spatial.seurat.v1'
    );
    if (!row.project_id || !row.dataset_id || !row.analysis_object_id) {
      throw codedError('INVALID_JOB_CONTEXT', 'Spatial pipeline job inputs are incomplete.');
    }
    const [dataset, inputObject] = await Promise.all([
      getDatasetRow(row.dataset_id, row.project_id),
      getProjectAnalysisObjectRow(row.analysis_object_id, row.project_id),
    ]);
    if (!dataset) throw codedError('DATASET_NOT_FOUND', 'Spatial dataset not found.');
    if (!inputObject || inputObject.datasetId !== dataset.id) {
      throw codedError('ANALYSIS_OBJECT_NOT_FOUND', 'Analysis object not found.');
    }
    return { dataset, inputObject };
  }

  async function getLoadableCheckpointForJobByWorker(jobId, workerId, claimToken, opts = {}) {
    const row = await requireClaimedJobRowByWorker(
      jobId, workerId, claimToken, opts, 'checkpoint.load.v1'
    );
    const object = await resolveOwnedAnalysisObjectForClaimedJob(row);
    const checkpoint = await resolveCheckpointArtifact(object.id, object.projectId || null);
    return {
      analysisObjectId: object.id,
      projectId: object.projectId || null,
      ...checkpoint,
    };
  }

  const CHECKPOINT_HYDRATED_JOB_TYPES = new Set([
    'trusted.method.v1',
    'r.object.inspect',
    'pbmc.pipeline.v1',
    'deg.find_markers.v1',
    'enrichment.gsea.v1',
    'cellchat.infer.v1',
    'explore.summarize.v1',
    'condition.pseudobulk_de.v1',
    'expert.r.v1',
  ]);

  async function getHydrationCheckpointForJobByWorker(jobId, workerId, claimToken, opts = {}) {
    const row = await requireClaimedJobRowByWorker(jobId, workerId, claimToken, opts);
    if (!CHECKPOINT_HYDRATED_JOB_TYPES.has(row.job_type)) {
      throw codedError('INVALID_JOB_TYPE', 'A claimed checkpoint-backed analysis job is required.');
    }
    const object = await resolveOwnedAnalysisObjectForClaimedJob(row);
    const checkpoint = await resolveCheckpointArtifact(object.id, object.projectId || null);
    return {
      analysisObjectId: object.id,
      projectId: object.projectId || null,
      ...checkpoint,
    };
  }

  async function getExpertRPrivateInputsForJobByWorker(jobId, workerId, claimToken, opts = {}) {
    const row = await requireClaimedJobRowByWorker(
      jobId, workerId, claimToken, opts, 'expert.r.v1'
    );
    const parameters = parseJson(row.parameters_json, {});
    return resolveExpertRPrivateInputs(
      Number(row.owner_user_id), row.project_id, parameters.inputIds || [], { includeStorage: true }
    );
  }

  async function getConditionComparisonInputsForJobByWorker(jobId, workerId, claimToken, opts = {}) {
    // Condition DE and the workbench's contrast recipes resolve the same
    // person-registered contrast snapshot; neither reads design from cell labels.
    const row = await requireClaimedJobRowByWorker(jobId, workerId, claimToken, opts);
    let contrastId;
    if (row.job_type === 'condition.pseudobulk_de.v1') {
      contrastId = validateConditionComparisonParams(parseJson(row.parameters_json, {})).params.contrastId;
    } else if (row.job_type === 'explore.summarize.v1') {
      const { CONTRAST_RECIPES, validateExploratoryAnalysisParams } = require('./exploratoryAnalysis');
      const { params } = validateExploratoryAnalysisParams(parseJson(row.parameters_json, {}));
      if (!CONTRAST_RECIPES.includes(params.recipe)) {
        throw codedError('INVALID_JOB_TYPE', 'This exploratory recipe does not test a condition contrast.');
      }
      contrastId = params.contrastId;
    } else {
      throw codedError('INVALID_JOB_TYPE', 'A claimed condition-contrast job is required.');
    }
    const object = await resolveOwnedAnalysisObjectForClaimedJob(row);
    const contrastResult = await query(
      `SELECT contrast.*, numerator.name AS numerator_name, denominator.name AS denominator_name
       FROM condition_contrasts contrast
       JOIN study_conditions numerator ON numerator.id = contrast.numerator_condition_id
       JOIN study_conditions denominator ON denominator.id = contrast.denominator_condition_id
       WHERE contrast.id = $1 AND contrast.project_id = $2 AND contrast.analysis_object_id = $3`,
      [contrastId, row.project_id, object.id]
    );
    const contrast = contrastResult.rows[0];
    if (!contrast) throw codedError('CONTRAST_NOT_FOUND', 'Condition contrast not found.');
    if (contrast.status === 'invalid') {
      throw codedError('INVALID_CONTRAST', 'Condition contrast does not have sufficient biological replication.');
    }
    const samplesResult = await query(
      `SELECT snapshot.sample_id, snapshot.condition_id, snapshot.donor_code,
              snapshot.cell_metadata_column, snapshot.cell_metadata_value,
              sample.batch, sample.metadata_json
       FROM condition_contrast_samples snapshot
       JOIN biological_samples sample ON sample.id = snapshot.sample_id
       WHERE snapshot.contrast_id = $1 ORDER BY snapshot.sample_id`, [contrast.id]
    );
    if (samplesResult.rows.length < 4
        || samplesResult.rows.some((sample) => !sample.cell_metadata_column || !sample.cell_metadata_value)) {
      throw codedError('INVALID_CONTRAST', 'Condition contrast sample snapshot is incomplete.');
    }
    const covariates = parseJson(contrast.covariates_json, []);
    const samples = samplesResult.rows.map((sample) => {
      const metadata = parseJson(sample.metadata_json, {});
      const covariateValues = {};
      for (const name of covariates) {
        const value = metadata[name];
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
          covariateValues[name] = value;
        } else {
          covariateValues[name] = null;
        }
      }
      return {
        sampleId: sample.sample_id,
        condition: sample.condition_id === contrast.numerator_condition_id ? 'numerator' : 'denominator',
        donorCode: sample.donor_code || null,
        batch: sample.batch || null,
        cellMetadataColumn: sample.cell_metadata_column,
        cellMetadataValue: sample.cell_metadata_value,
        unitId: contrast.unit_of_replication === 'donor' ? sample.donor_code : sample.sample_id,
        covariates: covariateValues,
      };
    });
    return {
      analysisObjectId: object.id,
      contrast: {
        id: contrast.id,
        name: contrast.name,
        numeratorName: contrast.numerator_name,
        denominatorName: contrast.denominator_name,
        unitOfReplication: contrast.unit_of_replication,
        paired: contrast.paired === true,
        cellTypeColumn: contrast.cell_type_column,
        blockingFactor: contrast.blocking_factor || null,
        covariates,
        status: contrast.status,
        validation: parseJson(contrast.validation_json, {}),
      },
      samples,
    };
  }

  async function getForkableCheckpointForJobByWorker(jobId, workerId, claimToken, opts = {}) {
    const row = await requireClaimedJobRowByWorker(
      jobId, workerId, claimToken, opts, 'checkpoint.fork.v1'
    );
    if (!row.project_id || !row.analysis_object_id) {
      throw codedError('INVALID_JOB_CONTEXT', 'Checkpoint fork job inputs are incomplete.');
    }
    const sourceObject = await getProjectAnalysisObjectRow(row.analysis_object_id, row.project_id);
    if (!sourceObject) throw codedError('ANALYSIS_OBJECT_NOT_FOUND', 'Analysis object not found.');
    const checkpoint = await resolveCheckpointArtifact(sourceObject.id, row.project_id);
    return {
      sourceAnalysisObject: sourceObject,
      analysisObjectId: sourceObject.id,
      projectId: row.project_id,
      ...checkpoint,
    };
  }

  async function claimNextJob(workerId, opts = {}) {
    const wid = requireWorkerId(workerId);
    const now = normalizeWorkerNow(opts);
    const leaseSeconds = normalizeLeaseSeconds(opts.leaseSeconds);
    const maxConcurrentClaims = Number(opts.maxConcurrentClaims === undefined ? 1 : opts.maxConcurrentClaims);
    if (!Number.isInteger(maxConcurrentClaims) || maxConcurrentClaims < 1 || maxConcurrentClaims > 8) {
      throw codedError('INVALID_WORKER_POOL_SIZE', 'Worker pool size is invalid.');
    }
    let allowedJobTypes = null;
    if (opts.allowedJobTypes !== undefined && opts.allowedJobTypes !== null) {
      if (!Array.isArray(opts.allowedJobTypes)) {
        throw codedError('INVALID_WORKER_CAPABILITIES', 'allowedJobTypes must be an array.');
      }
      allowedJobTypes = [...new Set(opts.allowedJobTypes.map((value) => String(value)))];
      if (allowedJobTypes.some((jobType) => !ALLOWED_JOB_TYPES.has(jobType))) {
        throw codedError('INVALID_WORKER_CAPABILITIES', 'allowedJobTypes contains an invalid job type.');
      }
    }
    // Execution lanes: Slurm jobs wait on the cluster, not on local CPU, so they
    // are counted separately from local work and never hold the local slot. A
    // worker restricted to ['slurm'] is gated by running Slurm jobs; any other
    // worker is gated by running local jobs.
    let executionTargets = null;
    if (opts.executionTargets !== undefined && opts.executionTargets !== null) {
      if (!Array.isArray(opts.executionTargets)
          || opts.executionTargets.length === 0
          || opts.executionTargets.some((t) => !['local', 'slurm'].includes(t))) {
        throw codedError('INVALID_WORKER_CAPABILITIES', 'executionTargets must list local and/or slurm.');
      }
      executionTargets = [...new Set(opts.executionTargets)];
    }
    const gateLane = executionTargets && executionTargets.length === 1 && executionTargets[0] === 'slurm' ? 'slurm' : 'local';
    const claimToken = generateClaimToken();
    const p = await connect();
    const client = await p.connect();
    try {
      await client.query('BEGIN');

      await client.query(
        'SELECT pg_advisory_xact_lock($1, $2)',
        WORKER_CLAIM_GATE_LOCK
      );
      const activeClaim = await client.query(
        `SELECT COUNT(*)::int AS count FROM jobs
          WHERE status = 'running'
            AND lease_expires_at IS NOT NULL
            AND lease_expires_at > $1
            AND execution_target = $2`,
        [now, gateLane]
      );
      if (Number(activeClaim.rows[0]?.count || 0) >= maxConcurrentClaims) {
        await client.query('COMMIT');
        return null;
      }

      // Membership/role changes are authoritative at claim time. Ineligible
      // project jobs, plus legacy projectless jobs that reference project-scoped
      // inputs, are canceled before any handler or R contact; completed and
      // already-running scientific history is preserved.
      const revoked = await client.query(
        `SELECT j.id, j.job_type, j.attempts, j.logs_json,
                 (j.project_id IS NULL) AS invalid_project_scope,
                 (j.job_type = 'expert.r.v1' AND NOT ${expertRAccessSql('j.owner_user_id', 'j.project_id', process.env, '$3')}) AS expert_access_revoked,
                 (j.project_id IS NOT NULL AND agent_run_authority_revoked(j.id, now())) AS agent_authority_revoked,
                 (j.result_analysis_object_id IS NOT NULL
                  OR EXISTS (SELECT 1 FROM job_artifacts a WHERE a.job_id = j.id)
                  OR EXISTS (SELECT 1 FROM analysis_object_edges e WHERE e.job_id = j.id)
                ) AS has_committed_output
           FROM jobs j
          WHERE j.status = 'queued'
            AND (
              (j.project_id IS NOT NULL
                AND NOT (COALESCE(j.last_worker_error::jsonb ->> 'code', '') = ANY($2::text[]))
                AND (
                  NOT EXISTS (
                    SELECT 1 FROM project_members pm
                     WHERE pm.project_id = j.project_id
                       AND pm.user_id = j.owner_user_id
                       AND pm.role = ANY($1::text[])
                  )
                  OR (j.job_type = 'expert.r.v1' AND NOT ${expertRAccessSql('j.owner_user_id', 'j.project_id', process.env, '$3')})
                  -- Delegated agent runs recheck their delegation, approval, release,
                  -- study, and cancellation before any handler or R contact.
                  OR agent_run_authority_revoked(j.id, now())
                ))
              OR
              (j.project_id IS NULL AND (
                EXISTS (
                  SELECT 1
                    FROM analysis_objects ao
                    LEFT JOIN analysis_objects parent ON parent.id = ao.parent_object_id
                    LEFT JOIN analysis_objects root ON root.id = ao.lineage_root_id
                    LEFT JOIN datasets source_dataset ON source_dataset.id = ao.dataset_id
                    LEFT JOIN datasets root_dataset ON root_dataset.id = root.dataset_id
                   WHERE ao.id IN (j.analysis_object_id, j.result_analysis_object_id)
                     AND (ao.project_id IS NOT NULL
                       OR parent.project_id IS NOT NULL
                       OR root.project_id IS NOT NULL
                       OR source_dataset.project_id IS NOT NULL
                       OR root_dataset.project_id IS NOT NULL)
                )
                OR EXISTS (
                  SELECT 1 FROM datasets d
                   WHERE d.id = j.dataset_id AND d.project_id IS NOT NULL
                )
              ))
            )
          ORDER BY j.created_at ASC, j.id ASC
          LIMIT 100
          FOR UPDATE OF j SKIP LOCKED`,
        [PROJECT_JOB_WRITE_ROLES, RECOVERY_ONLY_PENDING_CODES, EXPERT_R_EXECUTE_CAPABILITY]
      );
      const accessError = normalizeJobError({
        code: 'PROJECT_ACCESS_REVOKED',
        message: 'Job canceled because its creator no longer has permission to run project jobs.',
      });
      const expertAccessError = normalizeJobError({
        code: 'EXPERT_R_ACCESS_REVOKED',
        message: 'Job canceled because its creator no longer has approved Expert R access.',
      });
      const agentAuthorityError = normalizeJobError({
        code: 'AGENT_AUTHORITY_REVOKED',
        message: 'Job canceled because the delegated agent authority, approval, or study is no longer valid.',
      });
      const scopeError = normalizeJobError({
        code: 'INVALID_PROJECT_SCOPE',
        message: 'Job canceled because a project-associated input was submitted without project scope.',
      });
      for (const row of revoked.rows) {
        const cancellationError = row.invalid_project_scope
          ? scopeError
          : row.expert_access_revoked ? expertAccessError
            : row.agent_authority_revoked ? agentAuthorityError : accessError;
        const logs = [
          ...parseJson(row.logs_json, []),
          normalizeJobLogEntry({ level: 'warn', message: cancellationError.message }),
        ];
        if (row.has_committed_output) {
          // Never label durable scientific history as canceled. A reviewed
          // project-scoped job type is left queued for the recovery-only claim
          // below; invalid/unknown shapes fail closed without another handler.
          if (!row.invalid_project_scope && RETRYABLE_DURABLE_JOB_TYPES.has(row.job_type)) continue;
          await client.query(
            `UPDATE jobs SET status = 'failed', logs_json = $1, error_json = $2,
               completed_at = $3, updated_at = $3, worker_id = NULL,
               claim_token = NULL, lease_expires_at = NULL
             WHERE id = $4 AND status = 'queued'`,
            [JSON.stringify(logs), JSON.stringify(cancellationError), now, row.id]
          );
          continue;
        }
        if (!row.invalid_project_scope
            && Number(row.attempts) > 0
            && RETRYABLE_DURABLE_JOB_TYPES.has(row.job_type)) {
          // A prior authorized attempt may have atomically written its private
          // signed R receipt even when no DB output transaction is visible yet.
          // Preserve one receipt-only claim after access revocation; the worker is
          // explicitly forbidden from dispatching R under this marker.
          const recoveryError = normalizeJobError({
            code: R_RETRY_RECOVERY_PENDING,
            message: 'Creator access changed after a prior attempt; queued for recovery-only inspection.',
          });
          await client.query(
            `UPDATE jobs SET logs_json = $1, last_worker_error = $2, updated_at = $3
              WHERE id = $4 AND status = 'queued'`,
            [JSON.stringify(logs), JSON.stringify(recoveryError), now, row.id]
          );
          continue;
        }
        await client.query(
          `UPDATE jobs SET status = 'canceled', logs_json = $1, error_json = $2,
             canceled_at = $3, updated_at = $3, worker_id = NULL,
             claim_token = NULL, lease_expires_at = NULL
           WHERE id = $4 AND status = 'queued'`,
          [JSON.stringify(logs), JSON.stringify(cancellationError), now, row.id]
        );
      }

      const found = await client.query(
        `SELECT j.id, j.project_id, j.owner_user_id, j.job_type,
                (COALESCE(j.last_worker_error::jsonb ->> 'code', '') = ANY($4::text[]))
                  AS recovery_only_pending,
                (j.result_analysis_object_id IS NOT NULL
                  OR EXISTS (SELECT 1 FROM job_artifacts a WHERE a.job_id = j.id)
                  OR EXISTS (SELECT 1 FROM analysis_object_edges e WHERE e.job_id = j.id)
                ) AS has_committed_output
           FROM jobs j
          WHERE j.status = 'queued' AND j.attempts < j.max_attempts
            AND ($2::text[] IS NULL OR j.job_type = ANY($2::text[]))
            AND ($6::text[] IS NULL OR j.execution_target = ANY($6::text[]))
            AND (
              (j.project_id IS NULL
                AND NOT EXISTS (
                  SELECT 1
                    FROM analysis_objects ao
                    LEFT JOIN analysis_objects parent ON parent.id = ao.parent_object_id
                    LEFT JOIN analysis_objects root ON root.id = ao.lineage_root_id
                    LEFT JOIN datasets source_dataset ON source_dataset.id = ao.dataset_id
                    LEFT JOIN datasets root_dataset ON root_dataset.id = root.dataset_id
                   WHERE ao.id IN (j.analysis_object_id, j.result_analysis_object_id)
                     AND (ao.project_id IS NOT NULL
                       OR parent.project_id IS NOT NULL
                       OR root.project_id IS NOT NULL
                       OR source_dataset.project_id IS NOT NULL
                       OR root_dataset.project_id IS NOT NULL)
                )
                AND NOT EXISTS (
                  SELECT 1 FROM datasets d
                   WHERE d.id = j.dataset_id AND d.project_id IS NOT NULL
                )
              ) OR (
                EXISTS (
                  SELECT 1 FROM project_members pm
                   WHERE pm.project_id = j.project_id
                     AND pm.user_id = j.owner_user_id
                     AND pm.role = ANY($1::text[])
                )
                AND (j.job_type <> 'expert.r.v1' OR ${expertRAccessSql('j.owner_user_id', 'j.project_id', process.env, '$5')})
              )
              OR (
                j.project_id IS NOT NULL
                AND j.job_type = ANY($3::text[])
                AND (j.result_analysis_object_id IS NOT NULL
                  OR EXISTS (SELECT 1 FROM job_artifacts a WHERE a.job_id = j.id)
                  OR EXISTS (SELECT 1 FROM analysis_object_edges e WHERE e.job_id = j.id))
              )
              OR (
                j.project_id IS NOT NULL
                AND COALESCE(j.last_worker_error::jsonb ->> 'code', '') = ANY($4::text[])
              )
            )
          ORDER BY j.priority DESC, j.created_at ASC, j.id ASC
          LIMIT 1
          FOR UPDATE OF j SKIP LOCKED`,
        [
          PROJECT_JOB_WRITE_ROLES,
          allowedJobTypes,
          [...RETRYABLE_DURABLE_JOB_TYPES],
          RECOVERY_ONLY_PENDING_CODES,
          EXPERT_R_EXECUTE_CAPABILITY,
          executionTargets,
        ]
      );
      if (!found.rows[0]) {
        await client.query('COMMIT');
        return null;
      }
      const selected = found.rows[0];
      const id = selected.id;
      if (selected.project_id && !selected.has_committed_output
          && !selected.recovery_only_pending) {
        // Serialize the final eligibility check with membership mutations. If a
        // removal/demotion committed while this job was being selected, cancel it
        // under the same job lock instead of starting a handler with stale access.
        await client.query('SELECT id FROM projects WHERE id = $1 FOR UPDATE', [selected.project_id]);
        const eligible = await client.query(
          `SELECT 1 FROM project_members
            WHERE project_id = $1 AND user_id = $2 AND role = ANY($3::text[])`,
          [selected.project_id, Number(selected.owner_user_id), PROJECT_JOB_WRITE_ROLES]
        );
        let finalEligibility = Boolean(eligible.rows[0]);
        if (finalEligibility && selected.job_type === 'expert.r.v1') {
          // The operator also locks this user row, so grant/revoke and claim
          // eligibility have a defined order even for automatic role access.
          await client.query('SELECT id FROM users WHERE id = $1 FOR KEY SHARE', [Number(selected.owner_user_id)]);
          const capability = await client.query(
            `SELECT 1 WHERE ${expertRAccessSql('$1', '$2')}`,
            [Number(selected.owner_user_id), selected.project_id]
          );
          finalEligibility = Boolean(capability.rows[0]);
        }
        if (!finalEligibility) {
          const finalAccessError = selected.job_type === 'expert.r.v1'
            ? expertAccessError
            : accessError;
          const row = await client.query('SELECT logs_json FROM jobs WHERE id = $1', [id]);
          const logs = [
            ...parseJson(row.rows[0]?.logs_json, []),
            normalizeJobLogEntry({ level: 'warn', message: finalAccessError.message }),
          ];
          await client.query(
            `UPDATE jobs SET status = 'canceled', logs_json = $1, error_json = $2,
               canceled_at = $3, updated_at = $3, worker_id = NULL,
               claim_token = NULL, lease_expires_at = NULL
             WHERE id = $4 AND status = 'queued'`,
            [JSON.stringify(logs), JSON.stringify(finalAccessError), now, id]
          );
          await client.query('COMMIT');
          return null;
        }
      }
      const updated = await client.query(
        `UPDATE jobs SET
           status = 'running',
           worker_id = $1,
           claim_token = $2,
           attempts = attempts + 1,
           locked_at = $3,
           heartbeat_at = $3,
           lease_expires_at = $4,
           started_at = COALESCE(started_at, $3),
           updated_at = $3
         WHERE id = $5 AND status = 'queued' AND attempts < max_attempts
         RETURNING *, EXISTS (SELECT 1 FROM agent_runs ar WHERE ar.job_id = jobs.id) AS is_agent_job`,
        [wid, claimToken, now, addSeconds(now, leaseSeconds), id]
      );
      await client.query('COMMIT');
      return rowToWorkerJob(updated.rows[0]);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async function heartbeatJob(jobId, workerId, claimToken, opts = {}) {
    const wid = requireWorkerId(workerId);
    const token = requireClaimToken(claimToken);
    const now = normalizeWorkerNow(opts);
    const leaseSeconds = normalizeLeaseSeconds(opts.leaseSeconds);
    if (!(await getJobRowById(jobId))) throw codedError('JOB_NOT_FOUND', 'Job not found.');
    const { rows } = await query(
      `UPDATE jobs SET heartbeat_at = $1, lease_expires_at = $2, updated_at = $1
        WHERE id = $3 AND worker_id = $4 AND claim_token = $5
          AND status = 'running' AND lease_expires_at > $1
          AND COALESCE(last_worker_error::jsonb ->> 'code', '') <> $6
        RETURNING *`,
      [now, addSeconds(now, leaseSeconds), String(jobId), wid, token, R_TIMEOUT_INDETERMINATE]
    );
    if (!rows[0]) throw codedError('CLAIM_LOST', 'This worker no longer holds a valid claim on the job.');
    return rowToWorkerJob(rows[0]);
  }

  async function recordJobExecutionReceiptByWorker(jobId, workerId, claimToken, input, opts = {}) {
    const wid = requireWorkerId(workerId);
    const token = requireClaimToken(claimToken);
    const now = normalizeWorkerNow(opts);
    const evidence = executionTargets.validateExecutionReceiptInput(input);
    const client = await (await connect()).connect();
    try {
      await client.query('BEGIN');
      const row = (await client.query('SELECT * FROM jobs WHERE id=$1 FOR UPDATE', [String(jobId)])).rows[0];
      if (!row) throw codedError('JOB_NOT_FOUND', 'Job not found.');
      if (!workerHoldsClaim(row, wid, token, now)) throw codedError('CLAIM_LOST', 'This worker no longer holds a valid claim on the job.');
      const identity = await executionTargets.getServiceExecutionIdentity(client);
      const target = { kind: 'service', ...identity, generation: executionTargets.executorGeneration(wid),
        precision: 'recorded-executor', runtimeKind: evidence.runtimeKind, runtimeGeneration: evidence.runtimeGeneration };
      const dispatchId = crypto.createHash('sha256').update('execution-dispatch:' + token).digest('hex');
      await client.query(`INSERT INTO job_execution_receipts(job_id,dispatch_id,attempt,owner_user_id,project_id,operation,target_json,environment_json,dispatch_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(job_id,dispatch_id) DO NOTHING`,
      [row.id,dispatchId,row.attempts,row.owner_user_id,row.project_id,evidence.operation,target,evidence.environment,now]);
      const retained = (await client.query('SELECT * FROM job_execution_receipts WHERE job_id=$1 AND dispatch_id=$2', [row.id,dispatchId])).rows[0];
      const result = executionTargets.rowToExecutionReceipt(retained);
      await client.query('COMMIT');
      return result;
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }

  /**
   * Persist the point of no safe retry immediately before a receipt-backed R
   * request is dispatched. A worker-process crash closes its HTTP socket but does
   * not stop synchronous R execution, so an expired lease carrying this marker is
   * observed and recovered without ever issuing the handler a second time.
   */
  async function markRDispatchStartedByWorker(jobId, workerId, claimToken, opts = {}) {
    const wid = requireWorkerId(workerId);
    const token = requireClaimToken(claimToken);
    const now = normalizeWorkerNow(opts);
    const marker = JSON.stringify(normalizeJobError({
      code: R_DISPATCH_STARTED,
      message: 'A receipt-backed R operation was dispatched; retries require recovery-only handling.',
    }));
    if (!(await getJobRowById(jobId))) throw codedError('JOB_NOT_FOUND', 'Job not found.');
    const { rows } = await query(
      `UPDATE jobs SET last_worker_error = $1, updated_at = $2
        WHERE id = $3 AND worker_id = $4 AND claim_token = $5
          AND status = 'running' AND lease_expires_at > $2
          AND job_type = ANY($6::text[])
        RETURNING *`,
      [
        marker,
        now,
        String(jobId),
        wid,
        token,
        [...RETRYABLE_DURABLE_JOB_TYPES],
      ]
    );
    if (!rows[0]) throw codedError(
      'CLAIM_LOST',
      'This worker no longer holds a valid receipt-backed claim on the job.'
    );
    return rowToWorkerJob(rows[0]);
  }

  async function completeJobByWorker(jobId, workerId, claimToken, opts = {}) {
    const { row, wid, token, now } = await claimedJobContextByWorker(jobId, workerId, claimToken, opts);
    if (!validateJobTransition(row.status, 'completed')) throw codedError('INVALID_TRANSITION', `Cannot complete a job in status '${row.status}'.`);
    let resultId = row.result_analysis_object_id;
    if (opts.resultAnalysisObjectId !== undefined && opts.resultAnalysisObjectId !== null) {
      if (typeof opts.resultAnalysisObjectId !== 'string' ||
          !(await getAnalysisObjectForUser(opts.resultAnalysisObjectId, Number(row.owner_user_id)))) {
        throw codedError('RESULT_OBJECT_NOT_FOUND', 'Result analysis object not found.');
      }
      resultId = opts.resultAnalysisObjectId;
    }
    const logs = opts.log !== undefined
      ? [...parseJson(row.logs_json, []), normalizeJobLogEntry(opts.log)]
      : parseJson(row.logs_json, []);
    const { rows } = await query(
      `UPDATE jobs SET
         status = 'completed',
         result_analysis_object_id = $1,
         logs_json = $2,
         error_json = NULL,
         last_worker_error = NULL,
         completed_at = $3,
         heartbeat_at = $3,
         updated_at = $3,
         claim_token = NULL,
         lease_expires_at = NULL
       WHERE id = $4 AND worker_id = $5 AND claim_token = $6
         AND status = 'running' AND lease_expires_at > $3
       RETURNING *`,
      [resultId == null ? null : String(resultId), JSON.stringify(logs), now, String(jobId), wid, token]
    );
    if (!rows[0]) throw codedError('CLAIM_LOST', 'This worker no longer holds a valid claim on the job.');
    return rowToWorkerJob(rows[0]);
  }

  /**
   * Recover the narrow crash window where a handler's atomic output transaction
   * committed but the process died before the generic terminal job update. Only
   * exact, reviewed output shapes are resumable; partial/ambiguous output fails
   * closed without another R call.
   */
  async function resumeCommittedJobByWorker(jobId, workerId, claimToken, opts = {}) {
    const { row, wid, token } = await claimedJobContextByWorker(jobId, workerId, claimToken, opts);

    const recoverySpecs = {
      'pbmc.pipeline.v1': { artifacts: ['checkpoint', 'pipeline_summary'], result: true, edges: 1 },
      'seurat.pipeline.v1': { artifacts: ['checkpoint', 'pipeline_summary'], result: true, edges: 1 },
      'seurat.multisample.v1': { artifacts: ['checkpoint', 'pipeline_summary'], result: true, edges: 1 },
      'spatial.seurat.v1': { artifacts: ['checkpoint', 'pipeline_summary'], result: true, edges: 1 },
      'checkpoint.save.v1': { artifacts: ['checkpoint', 'checkpoint_save'], result: true, edges: 1 },
      'checkpoint.fork.v1': {
        artifacts: ['checkpoint_fork'], result: true, edges: 1, runtimeBoundArtifact: 'checkpoint_fork',
      },
      'checkpoint.load.v1': {
        artifacts: ['checkpoint_load'], result: false, edges: 0, runtimeBoundArtifact: 'checkpoint_load',
      },
      'deg.find_markers.v1': { artifacts: ['deg_markers', 'deg_summary'], result: false, edges: 0 },
      'enrichment.gsea.v1': {
        artifacts: ['enrichment_results', 'enrichment_summary'], result: false, edges: 0,
      },
      'cellchat.infer.v1': {
        artifacts: ['cellchat_results', 'cellchat_summary'], result: false, edges: 0,
      },
      'condition.pseudobulk_de.v1': {
        artifacts: ['condition_de_results', 'condition_de_summary'], result: false, edges: 0,
      },
      'expert.r.v1': { artifacts: ['expert_r_bundle', 'expert_r_summary'], result: true, edges: 1 },
    };
    const spec = recoverySpecs[row.job_type];
    if (!spec) return { resumed: false, committedOutput: false };
    if (row.job_type === 'expert.r.v1' && parseJson(row.parameters_json, {}).environment) {
      spec.artifacts.push('expert_r_environment');
    }

    const artifacts = await query(
      `SELECT artifact_type, storage_kind, storage_uri, checksum_sha256, size_bytes, metadata_json
         FROM job_artifacts WHERE job_id = $1 ORDER BY created_at ASC, id ASC`,
      [String(jobId)]
    );
    const counts = new Map();
    for (const artifact of artifacts.rows) {
      counts.set(artifact.artifact_type, (counts.get(artifact.artifact_type) || 0) + 1);
    }
    const edgeCountResult = await query(
      'SELECT COUNT(*)::integer AS count FROM analysis_object_edges WHERE job_id = $1',
      [String(jobId)]
    );
    const edgeCount = Number(edgeCountResult.rows[0].count);
    const totalArtifacts = artifacts.rows.length;
    const hasCommittedOutput = totalArtifacts > 0 || edgeCount > 0 || !!row.result_analysis_object_id;
    if (!hasCommittedOutput) return { resumed: false, committedOutput: false };

    const artifactsComplete = totalArtifacts === spec.artifacts.length
      && spec.artifacts.every((artifactType) => counts.get(artifactType) === 1);
    const resultComplete = spec.result ? !!row.result_analysis_object_id : !row.result_analysis_object_id;
    const edgesComplete = edgeCount === spec.edges;
    async function failRecovery(errorCode, message, logMessage) {
      await failJobByWorker(
        jobId,
        wid,
        token,
        {
          code: errorCode,
          message,
        },
        {
          ...(opts.now === undefined ? {} : { now: opts.now }),
          log: { level: 'error', message: logMessage },
        }
      );
      return { resumed: false, committedOutput: true, failed: true, errorCode };
    }

    if (!artifactsComplete || !resultComplete || !edgesComplete) {
      return failRecovery(
        'INCOMPLETE_COMMITTED_OUTPUT',
        'A prior worker left an incomplete durable output; the job was stopped safely.',
        'Incomplete prior output detected; refusing to rerun R.'
      );
    }

    const localArtifacts = artifacts.rows.filter((artifact) => artifact.storage_kind === 'local_internal');
    if (localArtifacts.length > 0) {
      if (typeof opts.inspectStorageObject !== 'function') {
        return failRecovery(
          'COMMITTED_OUTPUT_INVALID',
          'A prior worker output could not be verified; the job was stopped safely.',
          'Prior output storage could not be verified; refusing recovery.'
        );
      }
      try {
        for (const artifact of localArtifacts) {
          const kind = artifact.artifact_type === 'checkpoint'
            ? 'checkpoints'
            : (artifact.artifact_type === 'deg_markers'
              || artifact.artifact_type === 'enrichment_results'
              || artifact.artifact_type === 'cellchat_results'
              || artifact.artifact_type === 'condition_de_results'
              || artifact.artifact_type === 'expert_r_bundle'
              || artifact.artifact_type === 'expert_r_environment' ? 'artifacts' : null);
          if (!kind || !row.project_id || !storage.isProjectStorageKey(artifact.storage_uri, {
            projectId: row.project_id,
            kind,
          })) {
            throw codedError('INVALID_STORAGE_KEY', 'Committed output storage is outside the job scope.');
          }
          const checksumSha256 = normalizeChecksumSha256(artifact.checksum_sha256);
          const sizeBytes = normalizeArtifactSizeBytes(artifact.size_bytes);
          if (!checksumSha256 || sizeBytes === null || sizeBytes === undefined) {
            throw codedError('INVALID_STORAGE_METADATA', 'Committed output integrity metadata is invalid.');
          }
          await opts.inspectStorageObject(artifact.storage_uri, { checksumSha256, sizeBytes });
        }
      } catch {
        return failRecovery(
          'COMMITTED_OUTPUT_INVALID',
          'A prior worker output failed integrity verification; the job was stopped safely.',
          'Prior output failed storage integrity verification; refusing recovery.'
        );
      }
    }

    if (spec.runtimeBoundArtifact) {
      const runtimeArtifact = artifacts.rows.find(
        (artifact) => artifact.artifact_type === spec.runtimeBoundArtifact
      );
      const metadata = runtimeArtifact ? parseJson(runtimeArtifact.metadata_json, {}) : {};
      const committedHash = metadata && metadata.loaded && metadata.loaded.runtimeInstanceHash;
      const currentHash = opts.rRuntimeInstanceHash;
      if (!/^[0-9a-f]{64}$/.test(String(committedHash || ''))
          || committedHash !== currentHash) {
        return failRecovery(
          'LIVE_R_STATE_LOST',
          'The R runtime restarted after a live-state operation; rerun the operation explicitly.',
          'R runtime identity changed after committed live-state output; refusing false recovery.'
        );
      }
    }

    const recoveryLog = normalizeJobLogEntry({
      level: 'info',
      message: 'Recovered committed output after a prior worker lease expired.',
    });
    // Hashing a large checkpoint above can take longer than the lease. Never use
    // the timestamp captured before that I/O for the guarded terminal update: an
    // expired claim must not be able to complete merely because its old timestamp
    // still predates lease_expires_at. Production uses the database clock at the
    // statement boundary; tests may continue to inject an explicit deterministic
    // timestamp through opts.now.
    const terminalNow = opts.now === undefined ? null : normalizeWorkerNow(opts);
    const { rows } = await query(
      `UPDATE jobs SET
         status = 'completed',
         logs_json = (logs_json::jsonb || $1::jsonb)::text,
         error_json = NULL,
         last_worker_error = NULL,
         completed_at = COALESCE($2::timestamptz, CURRENT_TIMESTAMP),
         heartbeat_at = COALESCE($2::timestamptz, CURRENT_TIMESTAMP),
         updated_at = COALESCE($2::timestamptz, CURRENT_TIMESTAMP),
         claim_token = NULL,
         lease_expires_at = NULL
       WHERE id = $3 AND worker_id = $4 AND claim_token = $5
         AND status = 'running'
         AND lease_expires_at > COALESCE($2::timestamptz, CURRENT_TIMESTAMP)
       RETURNING *`,
      [JSON.stringify([recoveryLog]), terminalNow, String(jobId), wid, token]
    );
    if (!rows[0]) throw codedError('CLAIM_LOST', 'This worker no longer holds a valid claim on the job.');
    return { resumed: true, committedOutput: true, job: rowToWorkerJob(rows[0]) };
  }

  async function failJobByWorker(jobId, workerId, claimToken, error, opts = {}) {
    const { row, wid, token, now } = await claimedJobContextByWorker(jobId, workerId, claimToken, opts);
    if (!validateJobTransition(row.status, 'failed')) throw codedError('INVALID_TRANSITION', `Cannot fail a job in status '${row.status}'.`);
    const errObj = normalizeJobError(error === undefined || error === null ? { message: 'Job failed.' } : error);
    const errJson = JSON.stringify(errObj);
    const logs = opts.log !== undefined
      ? [...parseJson(row.logs_json, []), normalizeJobLogEntry(opts.log)]
      : parseJson(row.logs_json, []);
    const { rows } = await query(
      `UPDATE jobs SET
         status = 'failed',
         error_json = $1,
         last_worker_error = $1,
         logs_json = $2,
         completed_at = $3,
         heartbeat_at = $3,
         updated_at = $3,
         claim_token = NULL,
         lease_expires_at = NULL
       WHERE id = $4 AND worker_id = $5 AND claim_token = $6
         AND status = 'running' AND lease_expires_at > $3
       RETURNING *`,
      [errJson, JSON.stringify(logs), now, String(jobId), wid, token]
    );
    if (!rows[0]) throw codedError('CLAIM_LOST', 'This worker no longer holds a valid claim on the job.');
    return rowToWorkerJob(rows[0]);
  }

  /**
   * Record an indeterminate R bridge outcome without terminally failing or releasing
   * the job. The R request may still be executing after a local timeout or transport
   * disconnect, so immediately re-queueing would permit overlapping R execution. The
   * claim remains running for a bounded grace period and is converted by
   * reapExpiredJobs into one recovery-only claim.
   */
  async function deferIndeterminateRTimeoutByWorker(jobId, workerId, claimToken, opts = {}) {
    const wid = requireWorkerId(workerId);
    const token = requireClaimToken(claimToken);
    const now = normalizeWorkerNow(opts);
    const requestedGraceSeconds = normalizeLeaseSeconds(opts.recoveryDelaySeconds);
    const recoveryDelaySeconds = Math.min(
      requestedGraceSeconds,
      R_TIMEOUT_RECOVERY_MAX_GRACE_SECONDS
    );
    const row = await getJobRowById(jobId);
    if (!row) throw codedError('JOB_NOT_FOUND', 'Job not found.');
    if (!workerHoldsClaim(row, wid, token, now)) {
      throw codedError('CLAIM_LOST', 'This worker no longer holds a valid claim on the job.');
    }

    const timeoutState = normalizeJobError({
      code: R_TIMEOUT_INDETERMINATE,
      message: 'The local R execution outcome is unknown; waiting for bounded output recovery.',
    });
    const logs = [
      ...parseJson(row.logs_json, []),
      normalizeJobLogEntry({
        level: 'warn',
        message: 'R execution became indeterminate after a local timeout or disconnect; waiting before exact-output recovery.',
      }),
    ];
    const { rows } = await query(
      `UPDATE jobs SET
         error_json = NULL,
         last_worker_error = $1,
         logs_json = $2,
         heartbeat_at = $3,
         lease_expires_at = $4,
         updated_at = $3
       WHERE id = $5 AND worker_id = $6 AND claim_token = $7
         AND status = 'running' AND lease_expires_at > $3
       RETURNING *`,
      [
        JSON.stringify(timeoutState),
        JSON.stringify(logs),
        now,
        addSeconds(now, recoveryDelaySeconds),
        String(jobId),
        wid,
        token,
      ]
    );
    if (!rows[0]) throw codedError('CLAIM_LOST', 'This worker no longer holds a valid claim on the job.');
    return rowToWorkerJob(rows[0]);
  }

  async function releaseJob(jobId, workerId, claimToken, opts = {}) {
    const { row, wid, token, now } = await claimedJobContextByWorker(jobId, workerId, claimToken, opts);
    if (!validateJobTransition(row.status, 'queued')) throw codedError('INVALID_TRANSITION', `Cannot release a job in status '${row.status}'.`);
    const logs = opts.log !== undefined ? [...parseJson(row.logs_json, []), normalizeJobLogEntry(opts.log)] : parseJson(row.logs_json, []);
    const { rows } = await query(
      `UPDATE jobs SET
         status = 'queued',
         worker_id = NULL,
         claim_token = NULL,
         locked_at = NULL,
         lease_expires_at = NULL,
         heartbeat_at = $1,
         attempts = CASE WHEN attempts > 0 THEN attempts - 1 ELSE 0 END,
         logs_json = $2,
         updated_at = $1
       WHERE id = $3 AND worker_id = $4 AND claim_token = $5
         AND status = 'running' AND lease_expires_at > $1
       RETURNING *`,
      [now, JSON.stringify(logs), String(jobId), wid, token]
    );
    if (!rows[0]) throw codedError('CLAIM_LOST', 'This worker no longer holds a valid claim on the job.');
    return rowToWorkerJob(rows[0]);
  }

  async function appendJobLogByWorker(jobId, workerId, claimToken, entry, opts = {}) {
    const { row, wid, token, now } = await claimedJobContextByWorker(jobId, workerId, claimToken, opts);
    const logs = [...parseJson(row.logs_json, []), normalizeJobLogEntry(entry)];
    const { rows } = await query(
      `UPDATE jobs SET logs_json = $1, updated_at = $2
        WHERE id = $3 AND worker_id = $4 AND claim_token = $5
          AND status = 'running' AND lease_expires_at > $2
        RETURNING *`,
      [JSON.stringify(logs), now, String(jobId), wid, token]
    );
    if (!rows[0]) throw codedError('CLAIM_LOST', 'This worker no longer holds a valid claim on the job.');
    return rowToWorkerJob(rows[0]);
  }

  async function reapExpiredJobs(opts = {}) {
    const now = normalizeWorkerNow(opts);
    const candidates = await query(
      `SELECT id FROM jobs
        WHERE status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= $1`,
      [now]
    );
    const requeued = [];
    const failed = [];
    for (const candidate of candidates.rows) {
      const p = await connect();
      const client = await p.connect();
      try {
        await client.query('BEGIN');
        // Atomic output publishers take this same row lock. After waiting for a
        // publisher, READ COMMITTED gives the output query below a fresh snapshot.
        const locked = await client.query('SELECT * FROM jobs WHERE id = $1 FOR UPDATE', [candidate.id]);
        const row = locked.rows[0];
        if (!row || row.status !== 'running' || !row.lease_expires_at
            || new Date(row.lease_expires_at).getTime() > now.getTime()) {
          await client.query('COMMIT');
          continue;
        }
        const output = await client.query(
          `SELECT
             EXISTS (SELECT 1 FROM job_artifacts a WHERE a.job_id = $1)
             OR EXISTS (SELECT 1 FROM analysis_object_edges e WHERE e.job_id = $1)
             AS present`,
          [row.id]
        );
        const hasCommittedOutput = row.result_analysis_object_id !== null || output.rows[0]?.present === true;
        const attempts = Number(row.attempts);
        const maxAttempts = Number(row.max_attempts);
        const previousError = parseJson(row.last_worker_error, {});
        const rDispatchStarted = previousError.code === R_DISPATCH_STARTED;
        const indeterminateRTimeout = previousError.code === R_TIMEOUT_INDETERMINATE;
        const recoveryOnlyClaim = RECOVERY_ONLY_PENDING_CODES.includes(previousError.code);
        if (rDispatchStarted) {
          // A hard worker crash can sever Node's upstream socket while the separate
          // R process continues synchronously. Revoke the dead claim and spend one
          // bounded observation window before granting receipt-only recovery. A
          // crash between this marker and actual dispatch may therefore fail, but
          // can never duplicate scientific execution.
          const recoveryError = JSON.stringify(normalizeJobError({
            code: R_TIMEOUT_INDETERMINATE,
            message: 'The worker exited after R dispatch; waiting for bounded completion recovery.',
          }));
          await client.query(
            `UPDATE jobs SET worker_id = NULL, claim_token = NULL, locked_at = NULL,
               lease_expires_at = $1, heartbeat_at = $2,
               last_worker_error = $3, updated_at = $2
             WHERE id = $4`,
            [addSeconds(now, R_TIMEOUT_RECOVERY_MAX_GRACE_SECONDS), now, recoveryError, row.id]
          );
        } else if (indeterminateRTimeout) {
          // The grace window ended. Grant exactly one claim that may validate and
          // finalize an exact committed output, but must never invoke the handler/R.
          // Refund only the claim consumed by this bounded recovery handoff.
          const recoveryError = JSON.stringify(normalizeJobError({
            code: R_TIMEOUT_RECOVERY_PENDING,
            message: 'R recovery grace period ended; queued for one recovery-only claim.',
          }));
          await client.query(
            `UPDATE jobs SET status = 'queued', attempts = GREATEST(attempts - 1, 0),
               worker_id = NULL, claim_token = NULL, locked_at = NULL,
               lease_expires_at = NULL, heartbeat_at = $1,
               last_worker_error = $2, updated_at = $1
             WHERE id = $3`,
            [now, recoveryError, row.id]
          );
          requeued.push(row.id);
        } else if (recoveryOnlyClaim) {
          // A recovery-only worker also died or stalled. We cannot prove the
          // separate synchronous R process stopped, so revoke the dead claim and
          // return to observation instead of failing, cleaning, or ever falling
          // through to another scientific dispatch. Operators may explicitly
          // cancel a permanently stuck job.
          const recoveryError = JSON.stringify(normalizeJobError({
            code: R_TIMEOUT_INDETERMINATE,
            message: 'Recovery is still observing an indeterminate R execution.',
          }));
          await client.query(
            `UPDATE jobs SET worker_id = NULL, claim_token = NULL, locked_at = NULL,
               lease_expires_at = $1, heartbeat_at = $2,
               last_worker_error = $3, updated_at = $2
             WHERE id = $4`,
            [addSeconds(now, R_TIMEOUT_RECOVERY_MAX_GRACE_SECONDS), now, recoveryError, row.id]
          );
        } else if (attempts < maxAttempts) {
          const lastErr = JSON.stringify(normalizeJobError({
            code: 'LEASE_EXPIRED', message: 'Worker lease expired; job re-queued for another claim.',
          }));
          await client.query(
            `UPDATE jobs SET status = 'queued', worker_id = NULL, claim_token = NULL,
               locked_at = NULL, lease_expires_at = NULL, heartbeat_at = $1,
               last_worker_error = $2, updated_at = $1
             WHERE id = $3`,
            [now, lastErr, row.id]
          );
          requeued.push(row.id);
        } else {
          if (hasCommittedOutput && RETRYABLE_DURABLE_JOB_TYPES.has(row.job_type)) {
            // Preserve the execution-attempt ceiling while granting exactly one
            // recovery-only claim. claimNextJob increments attempts back to the
            // final value, and resumeCommittedJobByWorker runs before any handler.
            const recoveryError = JSON.stringify(normalizeJobError({
              code: COMMITTED_OUTPUT_RECOVERY_PENDING,
              message: 'Final output committed before lease expiry; queued for recovery-only finalization.',
            }));
            await client.query(
              `UPDATE jobs SET status = 'queued', attempts = GREATEST(attempts - 1, 0),
                 worker_id = NULL, claim_token = NULL, locked_at = NULL,
                 lease_expires_at = NULL, heartbeat_at = $1,
                 last_worker_error = $2, updated_at = $1
               WHERE id = $3`,
              [now, recoveryError, row.id]
            );
            requeued.push(row.id);
          } else {
            const errJson = JSON.stringify(normalizeJobError({
              code: 'LEASE_EXPIRED',
              message: 'Worker lease expired and the claim budget is exhausted; job failed.',
            }));
            await client.query(
              `UPDATE jobs SET status = 'failed', error_json = $1, last_worker_error = $1,
                 completed_at = $2, heartbeat_at = $2, claim_token = NULL,
                 lease_expires_at = NULL, updated_at = $2
               WHERE id = $3`,
              [errJson, now, row.id]
            );
            failed.push(row.id);
          }
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }
    return { requeued, failed };
  }

  async function setJobScheduling(jobId, opts = {}) {
    const id = String(jobId);
    const row = await getJobRowById(id);
    if (!row) throw codedError('JOB_NOT_FOUND', 'Job not found.');
    const sets = [];
    const params = [];
    if (opts.priority !== undefined) {
      if (!Number.isInteger(opts.priority)) throw codedError('INVALID_PRIORITY', 'priority must be an integer.');
      params.push(opts.priority); sets.push(`priority = $${params.length}`);
    }
    if (opts.maxAttempts !== undefined) {
      if (!Number.isInteger(opts.maxAttempts) || opts.maxAttempts < 1) throw codedError('INVALID_MAX_ATTEMPTS', 'maxAttempts must be a positive integer.');
      params.push(opts.maxAttempts); sets.push(`max_attempts = $${params.length}`);
    }
    if (opts.createdAt !== undefined) {
      let createdAt;
      try { createdAt = normalizeTimestamp(opts.createdAt); }
      catch { throw codedError('INVALID_CREATED_AT', 'createdAt must be a valid timestamp.'); }
      params.push(createdAt); sets.push(`created_at = $${params.length}`);
    }
    if (sets.length === 0) return rowToWorkerJob(row);
    params.push(id);
    await query(`UPDATE jobs SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length}`, params);
    return getWorkerJob(id);
  }

  return {
    getJobRowById, getWorkerJob, workerHoldsClaim, claimedJobContextByWorker, getOwnedAnalysisObjectForJobByWorker, getSeuratPipelineInputsForJobByWorker, getMultiSampleSeuratPipelineInputsForJobByWorker, getSpatialPipelineInputsForJobByWorker, getLoadableCheckpointForJobByWorker, getHydrationCheckpointForJobByWorker, getExpertRPrivateInputsForJobByWorker, getConditionComparisonInputsForJobByWorker, getForkableCheckpointForJobByWorker, claimNextJob, heartbeatJob, recordJobExecutionReceiptByWorker, markRDispatchStartedByWorker, completeJobByWorker, resumeCommittedJobByWorker, failJobByWorker, deferIndeterminateRTimeoutByWorker, releaseJob, appendJobLogByWorker, reapExpiredJobs, setJobScheduling,
  };
}

module.exports = { createJobWorkerStore };
