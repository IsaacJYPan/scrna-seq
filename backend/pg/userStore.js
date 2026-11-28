'use strict';

const passwords = require('../passwords');
const { isSafeUserId, isSessionVersion } = require('../sessionIdentifiers');

// Accounts, operator provisioning, password changes, session generations and
// the public demo guest lifecycle.
function createUserStore({
  connect, query, genId, codedError, parseJson, inheritedAnalysisSummary,
  createOrganizationForUser, createProjectForUser, getProjectAnalysisObjectRow,
}) {
  async function createUser(email, password, displayName) {
    const normalizedEmail = String(email || '').trim().toLowerCase();
    const salt = passwords.newSalt();
    const passwordHash = await passwords.hashPassword(password, salt);
    try {
      const { rows } = await query(
        `INSERT INTO users (email, password_hash, salt, display_name)
         VALUES ($1, $2, $3, $4)
         RETURNING id, email, display_name, session_version, created_at`,
        [normalizedEmail, passwordHash, salt, String(displayName || '').trim()]
      );
      const u = rows[0];
      // node-postgres returns BIGINT as a string to avoid precision loss; user ids
      // are small and the app treats them as numbers.
      return {
        id: Number(u.id),
        email: u.email,
        displayName: u.display_name,
        sessionVersion: String(u.session_version),
        createdAt: u.created_at,
      };
    } catch (err) {
      if (err && err.code === '23505') {
        return { error: 'An account with this email already exists.' };
      }
      throw err;
    }
  }

  async function provisionUserByOperator(email, password, displayName) {
    const normalizedEmail = String(email || '').trim().toLowerCase();
    const salt = passwords.newSalt();
    const passwordHash = await passwords.hashPassword(password, salt);
    const p = await connect();
    const client = await p.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `INSERT INTO users (email, password_hash, salt, display_name)
         VALUES ($1, $2, $3, $4)
         RETURNING id, email, display_name, session_version, created_at`,
        [normalizedEmail, passwordHash, salt, String(displayName || '').trim()]
      );
      const user = rows[0];
      const audit = await client.query(
        `INSERT INTO operator_audit_events
           (event_type, target_user_id, target_email, metadata_json)
         VALUES ('account.provisioned', $1, $2, $3)
         RETURNING id, created_at`,
        [user.id, user.email, JSON.stringify({ source: 'operator_cli' })]
      );
      await client.query('COMMIT');
      return {
        id: Number(user.id),
        email: user.email,
        displayName: user.display_name,
        sessionVersion: String(user.session_version),
        createdAt: user.created_at,
        auditEventId: String(audit.rows[0].id),
        auditCreatedAt: audit.rows[0].created_at,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      if (error?.code === '23505') {
        return { error: 'An account with this email already exists.' };
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async function resetUserPasswordByOperator(email, password) {
    const normalizedEmail = String(email || '').trim().toLowerCase();
    const salt = passwords.newSalt();
    const passwordHash = await passwords.hashPassword(password, salt);
    const p = await connect();
    const client = await p.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `UPDATE users
            SET password_hash = $2,
                salt = $3,
                session_version = session_version + 1
          WHERE email = $1
          RETURNING id, email, display_name, session_version, created_at`,
        [normalizedEmail, passwordHash, salt]
      );
      if (!rows[0]) {
        throw codedError('USER_NOT_FOUND', 'No account exists for that email.');
      }
      const user = rows[0];
      const audit = await client.query(
        `INSERT INTO operator_audit_events
           (event_type, target_user_id, target_email, metadata_json)
         VALUES ('account.password_reset', $1, $2, $3)
         RETURNING id, created_at`,
        [user.id, user.email, JSON.stringify({ source: 'operator_cli', sessionsRevoked: true })]
      );
      await client.query('COMMIT');
      return {
        id: Number(user.id),
        email: user.email,
        displayName: user.display_name,
        sessionVersion: String(user.session_version),
        createdAt: user.created_at,
        auditEventId: String(audit.rows[0].id),
        auditCreatedAt: audit.rows[0].created_at,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async function getUserByEmail(email) {
    const { rows } = await query(
      'SELECT id, email, display_name, created_at FROM users WHERE email = $1',
      [String(email || '').trim().toLowerCase()]
    );
    if (!rows[0]) return null;
    return { id: Number(rows[0].id), email: rows[0].email, displayName: rows[0].display_name, createdAt: rows[0].created_at };
  }

  async function verifyUser(email, password) {
    const normalizedEmail = String(email || '').trim().toLowerCase();
    const { rows } = await query('SELECT * FROM users WHERE email = $1', [normalizedEmail]);
    const user = rows[0];
    const ok = await passwords.verifyPassword(password, user ? user.password_hash : null);
    if (!user || !ok) return { error: passwords.GENERIC_CREDENTIAL_ERROR };
    return {
      id: Number(user.id),
      email: user.email,
      displayName: user.display_name,
      sessionVersion: String(user.session_version),
      createdAt: user.created_at,
    };
  }

  async function changeUserPassword({ userId, expectedSessionVersion, currentPassword, newPassword }) {
    const uid = Number(userId);
    const version = String(expectedSessionVersion || '');
    if (!isSafeUserId(userId) || !Number.isSafeInteger(uid) || !isSessionVersion(version)) {
      throw codedError('INVALID_SESSION', 'A valid session generation is required.');
    }

    const { rows } = await query(
      `SELECT id, email, display_name, password_hash, session_version, created_at
         FROM users
        WHERE id = $1 AND session_version = $2
          AND is_demo_guest = FALSE
          AND (expires_at IS NULL OR expires_at > now())`,
      [uid, version]
    );
    const existing = rows[0];
    if (!existing) throw codedError('INVALID_SESSION', 'The authenticated session is no longer current.');

    const currentMatches = await passwords.verifyPassword(currentPassword, existing.password_hash);
    if (!currentMatches) throw codedError('INVALID_CURRENT_PASSWORD', 'Current password is incorrect.');

    const salt = passwords.newSalt();
    const passwordHash = await passwords.hashPassword(newPassword, salt);
    const p = await connect();
    const client = await p.connect();
    try {
      await client.query('BEGIN');
      const updated = await client.query(
        `UPDATE users
            SET password_hash = $3,
                salt = $4,
                session_version = session_version + 1
          WHERE id = $1 AND session_version = $2
            AND password_hash = $5
            AND session_version < 9223372036854775807
          RETURNING id, email, display_name, session_version, created_at`,
        [uid, version, passwordHash, salt, existing.password_hash]
      );
      if (!updated.rows[0]) {
        throw codedError('INVALID_SESSION', 'The authenticated session changed during password update.');
      }
      const user = updated.rows[0];
      await client.query(
        `INSERT INTO account_security_events
           (event_type, actor_user_id, subject_user_id, subject_email, metadata_json)
         VALUES ('account.password_changed', $1, $1, $2, $3)`,
        [user.id, user.email, JSON.stringify({ source: 'self_service', sessionsRevoked: true })]
      );
      await client.query('COMMIT');
      return {
        id: Number(user.id),
        email: user.email,
        displayName: user.display_name,
        sessionVersion: String(user.session_version),
        createdAt: user.created_at,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async function createDemoGuest(email, password, expiresAt) {
    const user = await createUser(email, password, 'Demo Guest');
    if (user.error) throw codedError('DEMO_GUEST_CONFLICT', 'Could not create demo guest.');
    const { rows } = await query(
      `UPDATE users SET is_demo_guest = TRUE, expires_at = $2
        WHERE id = $1
        RETURNING id, email, display_name, session_version, is_demo_guest, expires_at, created_at`,
      [Number(user.id), expiresAt]
    );
    const guest = rows[0];
    const organization = await createOrganizationForUser(user.id, { name: 'Demo workspace' });
    const project = await createProjectForUser(user.id, {
      organizationId: organization.id, name: 'Curated single-cell demo',
    });
    return {
      user: {
        id: Number(guest.id), email: guest.email, displayName: guest.display_name,
        sessionVersion: String(guest.session_version), isDemoGuest: true,
        expiresAt: guest.expires_at, createdAt: guest.created_at,
      },
      organization,
      project,
    };
  }

  async function getDemoTemplateCheckpoint(templateProjectId) {
    const { rows } = await query(
      `SELECT object.id AS analysis_object_id, object.object_type, object.display_name, object.metadata_json,
              artifact.id AS artifact_id, artifact.storage_uri,
              artifact.checksum_sha256, artifact.size_bytes
         FROM project_canonical_analyses canonical
         JOIN analysis_objects object ON object.id = canonical.analysis_object_id
         JOIN job_artifacts artifact
           ON artifact.project_id = canonical.project_id
          AND artifact.artifact_type = 'checkpoint'
          AND artifact.storage_kind = 'local_internal'
          AND artifact.status = 'available'
         JOIN jobs artifact_job
           ON artifact_job.id = artifact.job_id
          AND artifact_job.project_id = canonical.project_id
          AND COALESCE(artifact.result_analysis_object_id,
                       artifact_job.result_analysis_object_id) = object.id
        WHERE canonical.project_id = $1
        ORDER BY artifact.created_at DESC, artifact.id DESC LIMIT 1`,
      [String(templateProjectId)]
    );
    if (!rows[0]) throw codedError('DEMO_TEMPLATE_UNAVAILABLE', 'Curated demo data is unavailable.');
    return {
      analysisObjectId: rows[0].analysis_object_id,
      objectType: rows[0].object_type,
      displayName: rows[0].display_name,
      artifactId: rows[0].artifact_id,
      storageUri: rows[0].storage_uri,
      checksumSha256: rows[0].checksum_sha256,
      sizeBytes: Number(rows[0].size_bytes),
      metadata: parseJson(rows[0].metadata_json, {}),
    };
  }

  async function cloneDemoExperimentalDesign(client, input) {
    const templateProjectId = String(input.templateProjectId || '');
    const templateAnalysisObjectId = String(input.templateAnalysisObjectId || '');
    if (!templateProjectId || !templateAnalysisObjectId) {
      throw codedError('DEMO_TEMPLATE_UNAVAILABLE', 'Curated demo design is unavailable.');
    }

    // Only rows attached to the operator-configured project and its canonical
    // analysis object are eligible. These identifiers are supplied by the
    // server after resolving the canonical template; no client value reaches
    // this path.
    const bindingResult = await client.query(
        `SELECT binding.*, sample.condition_id, sample.name AS sample_name,
                sample.donor_code, sample.batch, sample.replicate_label,
                sample.modality, sample.organism, sample.tissue, sample.platform,
                sample.metadata_json
           FROM analysis_object_sample_bindings binding
           JOIN biological_samples sample
             ON sample.id = binding.sample_id AND sample.project_id = binding.project_id
           JOIN study_conditions condition
             ON condition.id = sample.condition_id AND condition.project_id = binding.project_id
          WHERE binding.project_id = $1 AND binding.analysis_object_id = $2
          ORDER BY binding.created_at, binding.id`,
        [templateProjectId, templateAnalysisObjectId]
      );
    const contrastResult = await client.query(
        `SELECT * FROM condition_contrasts
          WHERE project_id = $1 AND analysis_object_id = $2
          ORDER BY created_at, id`,
        [templateProjectId, templateAnalysisObjectId]
      );

    const conditionIds = new Set();
    for (const row of bindingResult.rows) conditionIds.add(row.condition_id);
    for (const row of contrastResult.rows) {
      conditionIds.add(row.numerator_condition_id);
      conditionIds.add(row.denominator_condition_id);
    }
    if (conditionIds.size === 0) {
      return { conditions: 0, samples: 0, bindings: 0, contrasts: 0 };
    }

    const conditionResult = await client.query(
      `SELECT * FROM study_conditions
        WHERE project_id = $1 AND id = ANY($2::text[])
        ORDER BY created_at, id`,
      [templateProjectId, [...conditionIds]]
    );
    if (conditionResult.rows.length !== conditionIds.size) {
      throw codedError('DEMO_TEMPLATE_UNAVAILABLE', 'Curated demo design is incomplete.');
    }

    const conditionIdsBySource = new Map();
    for (const source of conditionResult.rows) {
      const id = genId('cond');
      conditionIdsBySource.set(source.id, id);
      await client.query(
        `INSERT INTO study_conditions
           (id, project_id, name, description, created_by_user_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, String(input.projectId), source.name, source.description, Number(input.userId)]
      );
    }

    const sampleIdsBySource = new Map();
    for (const source of bindingResult.rows) {
      const sampleId = genId('sample');
      sampleIdsBySource.set(source.sample_id, sampleId);
      await client.query(
        `INSERT INTO biological_samples
           (id, project_id, dataset_id, condition_id, name, donor_code, batch,
            replicate_label, modality, organism, tissue, platform, metadata_json,
            created_by_user_id)
         VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [sampleId, String(input.projectId), conditionIdsBySource.get(source.condition_id),
          source.sample_name, source.donor_code, source.batch, source.replicate_label,
          source.modality, source.organism, source.tissue, source.platform,
          source.metadata_json, Number(input.userId)]
      );
      await client.query(
        `INSERT INTO analysis_object_sample_bindings
           (id, project_id, analysis_object_id, sample_id, cell_metadata_column,
            cell_metadata_value, created_by_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [genId('bind'), String(input.projectId), String(input.analysisObjectId), sampleId,
          source.cell_metadata_column, source.cell_metadata_value, Number(input.userId)]
      );
    }

    let snapshotRows = [];
    if (contrastResult.rows.length > 0) {
      const snapshots = await client.query(
        `SELECT snapshot.* FROM condition_contrast_samples snapshot
         JOIN condition_contrasts contrast ON contrast.id = snapshot.contrast_id
         WHERE contrast.project_id = $1 AND contrast.analysis_object_id = $2
         ORDER BY snapshot.contrast_id, snapshot.sample_id`,
        [templateProjectId, templateAnalysisObjectId]
      );
      snapshotRows = snapshots.rows;
    }
    const snapshotsByContrast = new Map();
    for (const snapshot of snapshotRows) {
      const rows = snapshotsByContrast.get(snapshot.contrast_id) || [];
      rows.push(snapshot);
      snapshotsByContrast.set(snapshot.contrast_id, rows);
    }

    for (const source of contrastResult.rows) {
      const contrastId = genId('contrast');
      await client.query(
        `INSERT INTO condition_contrasts
           (id, project_id, analysis_object_id, name, numerator_condition_id,
            denominator_condition_id, unit_of_replication, paired, cell_type_column,
            blocking_factor, covariates_json, status, validation_json, created_by_user_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [contrastId, String(input.projectId), String(input.analysisObjectId), source.name,
          conditionIdsBySource.get(source.numerator_condition_id),
          conditionIdsBySource.get(source.denominator_condition_id),
          source.unit_of_replication, source.paired, source.cell_type_column,
          source.blocking_factor, source.covariates_json, source.status,
          source.validation_json, Number(input.userId)]
      );
      for (const snapshot of snapshotsByContrast.get(source.id) || []) {
        const sampleId = sampleIdsBySource.get(snapshot.sample_id);
        const conditionId = conditionIdsBySource.get(snapshot.condition_id);
        if (!sampleId || !conditionId) {
          throw codedError('DEMO_TEMPLATE_UNAVAILABLE', 'Curated demo contrast is incomplete.');
        }
        await client.query(
          `INSERT INTO condition_contrast_samples
             (contrast_id, sample_id, condition_id, donor_code,
              cell_metadata_column, cell_metadata_value)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [contrastId, sampleId, conditionId, snapshot.donor_code,
            snapshot.cell_metadata_column, snapshot.cell_metadata_value]
        );
      }
    }

    return {
      conditions: conditionResult.rows.length,
      samples: bindingResult.rows.length,
      bindings: bindingResult.rows.length,
      contrasts: contrastResult.rows.length,
    };
  }

  async function createDemoGuestCheckpoint(input) {
    const clientPool = await connect();
    const client = await clientPool.connect();
    const objectId = genId('ao');
    const jobId = input.jobId || genId('job');
    const artifactId = genId('art');
    // Copy only public dataset identity and a bounded display summary. Never
    // inherit arbitrary operator metadata, template IDs or private storage paths.
    const metadata = { curatedDemo: true };
    const source = input.templateMetadata?.sourceType;
    if (['pbmc3k_demo', 'synthetic_pbmc_demo'].includes(source)) {
      metadata.sourceType = source;
      metadata.synthetic = source === 'synthetic_pbmc_demo';
      metadata.summary = inheritedAnalysisSummary(input.templateMetadata);
      if (source === 'pbmc3k_demo') {
        metadata.dataset = 'pbmc3k';
        metadata.singleSample = true;
        metadata.tutorialUrl = 'https://satijalab.org/seurat/articles/pbmc3k_tutorial';
        metadata.sourceUrl = 'https://cf.10xgenomics.com/samples/cell/pbmc3k/pbmc3k_filtered_gene_bc_matrices.tar.gz';
        metadata.sourceSha256 = '847d6ebd9a1ec9a768f2be7e40ca42cbfe75ebeb6d76a4c24167041699dc28b5';
      }
    }
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO analysis_objects
           (id, owner_user_id, project_id, lineage_root_id, object_type, display_name, metadata_json)
         VALUES ($1, $2, $3, $1, $4, $5, $6)`,
        [objectId, Number(input.userId), String(input.projectId), input.objectType || 'seurat',
          input.displayName || 'Curated scRNA-seq demo',
          JSON.stringify(metadata)]
      );
      await client.query(
        `INSERT INTO jobs
           (id, owner_user_id, project_id, result_analysis_object_id, job_type, status,
            parameters_json, logs_json, created_at, updated_at, started_at, completed_at, attempts)
         VALUES ($1, $2, $3, $4, 'demo.curated_import.v1', 'completed', $5, $6,
                 now(), now(), now(), now(), 1)`,
        [jobId, Number(input.userId), String(input.projectId), objectId,
          JSON.stringify({ curated: true }), JSON.stringify([{ message: 'Curated demo checkpoint provisioned.' }])]
      );
      await client.query(
        `INSERT INTO job_artifacts
           (id, project_id, job_id, result_analysis_object_id, created_by_user_id,
            artifact_type, name, description, mime_type, storage_kind, storage_uri,
            checksum_sha256, size_bytes, status, metadata_json)
         VALUES ($1, $2, $3, $4, $5, 'checkpoint', 'Curated demo checkpoint',
                 'Immutable checkpoint copied from the operator-reviewed demo template.',
                 'application/x-r-rds', 'local_internal', $6, $7, $8, 'available', $9)`,
        [artifactId, String(input.projectId), jobId, objectId, Number(input.userId),
          input.storageUri, input.checksumSha256, Number(input.sizeBytes),
          JSON.stringify({ curatedDemo: true })]
      );
      const experimentalDesign = await cloneDemoExperimentalDesign(client, {
        userId: input.userId,
        projectId: input.projectId,
        analysisObjectId: objectId,
        templateProjectId: input.templateProjectId,
        templateAnalysisObjectId: input.templateAnalysisObjectId,
      });
      await client.query('COMMIT');
      return {
        analysisObject: await getProjectAnalysisObjectRow(objectId, input.projectId),
        jobId,
        artifactId,
        experimentalDesign,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async function listExpiredDemoGuests(limit = 100) {
    const bounded = Math.min(500, Math.max(1, Number(limit) || 100));
    const { rows } = await query(
      `SELECT user_row.id, user_row.email,
              COALESCE(array_agg(DISTINCT project.id) FILTER (WHERE project.id IS NOT NULL), '{}') AS project_ids,
              COALESCE(array_agg(DISTINCT storage_key) FILTER (WHERE storage_key IS NOT NULL), '{}') AS storage_keys
         FROM users user_row
         LEFT JOIN projects project ON project.created_by_user_id = user_row.id
         LEFT JOIN LATERAL (
           SELECT artifact.storage_uri AS storage_key FROM job_artifacts artifact
            WHERE artifact.project_id = project.id AND artifact.storage_uri IS NOT NULL
           UNION
           SELECT artifact.storage_key FROM managed_artifact_versions artifact
            WHERE artifact.project_id = project.id
           UNION
           SELECT dataset.internal_storage_key FROM datasets dataset
            WHERE dataset.project_id = project.id AND dataset.internal_storage_key IS NOT NULL
           UNION
           SELECT 'projects/' || project.id || '/artifacts/' || job.id || '/completion-receipt.json'
             FROM jobs job WHERE job.project_id = project.id
         ) stored ON TRUE
        WHERE user_row.is_demo_guest = TRUE AND user_row.expires_at <= now()
        GROUP BY user_row.id, user_row.email, user_row.expires_at
        ORDER BY user_row.expires_at, user_row.id LIMIT $1`,
      [bounded]
    );
    return rows.map((row) => ({
      userId: Number(row.id), email: row.email,
      projectIds: row.project_ids || [], storageKeys: row.storage_keys || [],
    }));
  }

  async function deleteExpiredDemoGuest(userId) {
    const clientPool = await connect();
    const client = await clientPool.connect();
    try {
      await client.query('BEGIN');
      // The audit table is immutable during normal application operation. Demo
      // expiry is the one deliberate lifecycle deletion, scoped to this transaction.
      await client.query("SET LOCAL app.demo_cleanup = 'on'");
      const locked = await client.query(
        `SELECT id, email FROM users
          WHERE id = $1 AND is_demo_guest = TRUE AND expires_at <= now() FOR UPDATE`,
        [Number(userId)]
      );
      if (!locked.rows[0]) {
        await client.query('ROLLBACK');
        return false;
      }
      const projectRows = await client.query(
        'SELECT id, organization_id FROM projects WHERE created_by_user_id = $1',
        [Number(userId)]
      );
      const projectIds = projectRows.rows.map((row) => row.id);
      const orgIds = [...new Set(projectRows.rows.map((row) => row.organization_id))];
      if (projectIds.length > 0) {
        await client.query('DELETE FROM automation_audit_events WHERE project_id = ANY($1::text[])', [projectIds]);
        await client.query('DELETE FROM hpc_dispatches WHERE job_id IN (SELECT id FROM jobs WHERE project_id = ANY($1::text[]))', [projectIds]);
        await client.query(
          'DELETE FROM agent_sandbox_remote_inputs WHERE run_id IN (SELECT id FROM agent_sandbox_runs WHERE project_id = ANY($1::text[]))',
          [projectIds]
        );
        for (const table of ['agent_notebook_notes', 'agent_report_reviews', 'agent_report_sections', 'agent_reports', 'agent_sandbox_runs', 'agent_sandboxes']) {
          await client.query(`DELETE FROM ${table} WHERE project_id = ANY($1::text[])`, [projectIds]);
        }
        for (const table of ['result_acceptances', 'agent_runs', 'execution_plans', 'study_envelopes', 'workflow_approvals']) {
          await client.query(`DELETE FROM ${table} WHERE project_id = ANY($1::text[])`, [projectIds]);
        }
        await client.query('DELETE FROM agent_change_proposals WHERE project_id = ANY($1::text[])', [projectIds]);
        await client.query(`DELETE FROM agent_credentials WHERE delegation_id IN
          (SELECT id FROM agent_delegations WHERE project_id = ANY($1::text[]))`, [projectIds]);
        await client.query('DELETE FROM agent_delegations WHERE project_id = ANY($1::text[])', [projectIds]);
        await client.query('DELETE FROM research_analysis_snapshot_publication_blobs WHERE publication_id IN (SELECT id FROM research_analysis_snapshot_publications WHERE project_id=ANY($1::text[]))', [projectIds]);
        await client.query('DELETE FROM research_analysis_snapshot_publication_requests WHERE project_id=ANY($1::text[])', [projectIds]);
        await client.query('DELETE FROM research_analysis_snapshot_publications WHERE project_id=ANY($1::text[])', [projectIds]);
        await client.query('DELETE FROM research_analysis_snapshot_blobs WHERE preparation_id IN (SELECT id FROM research_analysis_snapshot_preparations WHERE project_id=ANY($1::text[]))', [projectIds]);
        await client.query('DELETE FROM research_analysis_snapshot_preparations WHERE project_id=ANY($1::text[])', [projectIds]);
        await client.query('DELETE FROM research_analysis_intakes WHERE project_id = ANY($1::text[])', [projectIds]);
        await client.query('DELETE FROM managed_artifact_import_receipts WHERE project_id = ANY($1::text[])', [projectIds]);
        await client.query('DELETE FROM workflow_restoration_receipts WHERE project_id = ANY($1::text[])', [projectIds]);
        await client.query('DELETE FROM research_document_pending WHERE project_id = ANY($1::text[])', [projectIds]);
        await client.query('DELETE FROM research_document_pending_requests WHERE project_id = ANY($1::text[])', [projectIds]);
        await client.query('DELETE FROM research_document_draft_receipts WHERE project_id = ANY($1::text[])', [projectIds]);
        await client.query('DELETE FROM research_document_drafts WHERE project_id = ANY($1::text[])', [projectIds]);
        await client.query('DELETE FROM research_document_submissions WHERE project_id = ANY($1::text[])', [projectIds]);
        await client.query('DELETE FROM research_document_revisions WHERE project_id = ANY($1::text[])', [projectIds]);
        await client.query('DELETE FROM research_documents WHERE project_id = ANY($1::text[])', [projectIds]);
        await client.query('DELETE FROM research_analysis_attachment_comments WHERE project_id = ANY($1::text[])', [projectIds]);
        await client.query('DELETE FROM research_analysis_attachment_revisions WHERE project_id = ANY($1::text[])', [projectIds]);
        await client.query('DELETE FROM research_analysis_attachments WHERE project_id = ANY($1::text[])', [projectIds]);
        await client.query('DELETE FROM research_analysis_revisions WHERE project_id = ANY($1::text[])', [projectIds]);
        await client.query('DELETE FROM research_analyses WHERE project_id = ANY($1::text[])', [projectIds]);
        await client.query('DELETE FROM server_data_imports WHERE project_id = ANY($1::text[])', [projectIds]);
        await client.query('DELETE FROM managed_artifact_versions WHERE project_id = ANY($1::text[])', [projectIds]);
        await client.query('DELETE FROM private_r_publications WHERE project_id = ANY($1::text[])', [projectIds]);
        await client.query('DELETE FROM private_r_executions WHERE project_id = ANY($1::text[])', [projectIds]);
        await client.query('DELETE FROM private_r_kernel_restarts WHERE project_id = ANY($1::text[])', [projectIds]);
        await client.query('DELETE FROM private_r_kernels WHERE project_id = ANY($1::text[])', [projectIds]);
        await client.query('DELETE FROM project_audit_events WHERE project_id = ANY($1::text[])', [projectIds]);
        await client.query('DELETE FROM project_canonical_analyses WHERE project_id = ANY($1::text[])', [projectIds]);
        await client.query('DELETE FROM analysis_branch_review_comments WHERE project_id = ANY($1::text[])', [projectIds]);
        await client.query('DELETE FROM analysis_branch_reviews WHERE project_id = ANY($1::text[])', [projectIds]);
        await client.query('DELETE FROM analysis_branch_events WHERE project_id = ANY($1::text[])', [projectIds]);
        await client.query('DELETE FROM analysis_branches WHERE project_id = ANY($1::text[])', [projectIds]);
        await client.query(`DELETE FROM condition_contrast_samples WHERE contrast_id IN
          (SELECT id FROM condition_contrasts WHERE project_id = ANY($1::text[]))`, [projectIds]);
        await client.query('DELETE FROM condition_contrasts WHERE project_id = ANY($1::text[])', [projectIds]);
        await client.query('DELETE FROM analysis_object_sample_bindings WHERE project_id = ANY($1::text[])', [projectIds]);
        await client.query('DELETE FROM biological_samples WHERE project_id = ANY($1::text[])', [projectIds]);
        await client.query('DELETE FROM study_conditions WHERE project_id = ANY($1::text[])', [projectIds]);
        await client.query('DELETE FROM analysis_object_edges WHERE project_id = ANY($1::text[])', [projectIds]);
        await client.query('DELETE FROM job_artifacts WHERE project_id = ANY($1::text[])', [projectIds]);
        await client.query('DELETE FROM execution_source_versions WHERE project_id = ANY($1::text[])', [projectIds]);
        await client.query('DELETE FROM jobs WHERE project_id = ANY($1::text[])', [projectIds]);
        await client.query('DELETE FROM live_execution_records WHERE project_id = ANY($1::text[])', [projectIds]);
        await client.query('DELETE FROM analysis_objects WHERE project_id = ANY($1::text[])', [projectIds]);
        await client.query('DELETE FROM project_pipeline_selections WHERE project_id = ANY($1::text[])', [projectIds]);
        await client.query('DELETE FROM pipeline_definitions WHERE project_id = ANY($1::text[])', [projectIds]);
        await client.query('DELETE FROM figure_collection WHERE project_id = ANY($1::text[])', [projectIds]);
        await client.query(`DELETE FROM results_cache WHERE provenance_id IN
          (SELECT id FROM provenance WHERE project_id = ANY($1::text[]))`, [projectIds]);
        await client.query('DELETE FROM provenance WHERE project_id = ANY($1::text[])', [projectIds]);
        await client.query('DELETE FROM datasets WHERE project_id = ANY($1::text[])', [projectIds]);
        await client.query('DELETE FROM project_members WHERE project_id = ANY($1::text[])', [projectIds]);
        await client.query('DELETE FROM projects WHERE id = ANY($1::text[])', [projectIds]);
      }
      if (orgIds.length > 0) {
        await client.query('DELETE FROM organization_members WHERE organization_id = ANY($1::text[])', [orgIds]);
        await client.query('DELETE FROM organizations WHERE id = ANY($1::text[])', [orgIds]);
      }
      await client.query('DELETE FROM agent_principals WHERE sponsor_user_id = $1', [Number(userId)]);
      await client.query('DELETE FROM users WHERE id = $1', [Number(userId)]);
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async function getUserForSession(userId, sessionVersion) {
    const uid = Number(userId);
    const version = String(sessionVersion || '');
    if (!isSafeUserId(userId) || !Number.isSafeInteger(uid) || !isSessionVersion(version)) return null;
    const { rows } = await query(
      `SELECT id, email, display_name, is_demo_guest, expires_at, created_at
         FROM users
        WHERE id = $1 AND session_version = $2
          AND (expires_at IS NULL OR expires_at > now())`,
      [uid, version]
    );
    if (!rows[0]) return null;
    return {
      id: Number(rows[0].id),
      email: rows[0].email,
      displayName: rows[0].display_name,
      isDemoGuest: rows[0].is_demo_guest === true,
      expiresAt: rows[0].expires_at,
      createdAt: rows[0].created_at,
    };
  }

  async function getUserSessionVersion(userId) {
    const uid = Number(userId);
    if (!isSafeUserId(userId) || !Number.isSafeInteger(uid)) return null;
    const { rows } = await query('SELECT session_version FROM users WHERE id = $1', [uid]);
    return rows[0] ? String(rows[0].session_version) : null;
  }

  async function revokeUserSessions(userId, expectedVersion) {
    const uid = Number(userId);
    const version = String(expectedVersion || '');
    if (!isSafeUserId(userId) || !Number.isSafeInteger(uid) || !isSessionVersion(version)) {
      throw codedError('INVALID_SESSION', 'A valid session generation is required.');
    }
    const { rows } = await query(
      `UPDATE users
          SET session_version = session_version + 1
        WHERE id = $1 AND session_version = $2
          AND session_version < 9223372036854775807
        RETURNING session_version`,
      [uid, version]
    );
    if (rows[0]) return String(rows[0].session_version);
    const current = await getUserSessionVersion(uid);
    if (current === version) {
      throw codedError('SESSION_VERSION_EXHAUSTED', 'The session generation cannot be revoked safely.');
    }
    // A concurrent logout already advanced the generation, or the user was
    // deleted. In both cases this exact credential is no longer usable.
    return null;
  }

  return {
    createUser, provisionUserByOperator, resetUserPasswordByOperator, getUserByEmail, verifyUser, changeUserPassword, createDemoGuest, getDemoTemplateCheckpoint, createDemoGuestCheckpoint, listExpiredDemoGuests, deleteExpiredDemoGuest, getUserForSession, getUserSessionVersion, revokeUserSessions,
  };
}

module.exports = { createUserStore };
