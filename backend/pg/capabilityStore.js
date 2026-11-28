'use strict';

const { DENIED_CAPABILITY, expertRAccessSql } = require('../expertRAccess');
const {
  allocateExpertRInputStorageKey, sanitizeExpertRInputFilename, maxExpertRInputBytesForFilename,
  MAX_EXPERT_R_PRIVATE_INPUTS, MAX_EXPERT_R_PRIVATE_INPUT_STORAGE_BYTES,
} = require('../expertR');

// Platform capabilities (pipeline registry publishing, Expert R execution) and
// the project-scoped private input files Expert R jobs may read.
function createCapabilityStore({
  connect, query, codedError, storage, requireProjectRole, toCanonicalTs,
  PROJECT_JOB_WRITE_ROLES, PIPELINE_REGISTRY_PUBLISH_CAPABILITY, EXPERT_R_EXECUTE_CAPABILITY,
}) {
  async function hasPlatformCapability(userId, capability) {
    const uid = Number(userId);
    if (!Number.isInteger(uid) || uid <= 0) return false;
    if (![PIPELINE_REGISTRY_PUBLISH_CAPABILITY, EXPERT_R_EXECUTE_CAPABILITY].includes(capability)) {
      return false;
    }
    const { rows } = await query(
      `SELECT 1 FROM platform_capabilities
        WHERE user_id = $1 AND capability = $2`,
      [uid, capability]
    );
    return Boolean(rows[0]);
  }

  async function hasPipelineRegistryPublishCapability(userId) {
    return hasPlatformCapability(userId, PIPELINE_REGISTRY_PUBLISH_CAPABILITY);
  }

  async function hasExpertRExecuteCapability(userId, projectId = null) {
    const uid = Number(userId);
    if (!Number.isSafeInteger(uid) || uid <= 0) return false;
    const { rows } = await query(
      `SELECT 1 WHERE ${expertRAccessSql('$1', projectId ? '$2' : null)}
        ${projectId ? "AND EXISTS (SELECT 1 FROM project_members WHERE user_id=$1 AND project_id=$2 AND role IN ('owner','admin','analyst'))" : ''}`,
      projectId ? [uid, String(projectId)] : [uid]
    );
    return Boolean(rows[0]);
  }

  async function getPipelineRegistryCapabilities(userId) {
    return {
      canPublishPipelineManifests: await hasPipelineRegistryPublishCapability(userId),
    };
  }

  async function getExpertRCapabilities(userId, projectId = null) {
    const denied = await query(
      'SELECT 1 FROM platform_capabilities WHERE user_id = $1 AND capability = $2',
      [Number(userId), DENIED_CAPABILITY]
    );
    return {
      canExecuteExpertR: await hasExpertRExecuteCapability(userId, projectId),
      expertRAccessRevoked: Boolean(denied.rows[0]),
    };
  }

  async function setPlatformCapabilityByEmail(email, capability, enabled) {
    if (![PIPELINE_REGISTRY_PUBLISH_CAPABILITY, EXPERT_R_EXECUTE_CAPABILITY].includes(capability)) {
      throw codedError('INVALID_CAPABILITY', 'Capability is not operator-manageable.');
    }
    const normalizedEmail = String(email || '').trim().toLowerCase();
    if (!normalizedEmail) throw codedError('INVALID_USER', 'A user email is required.');
    if (typeof enabled !== 'boolean') throw codedError('INVALID_CAPABILITY', 'Capability state must be boolean.');
    const p = await connect();
    const client = await p.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        'SELECT id, email FROM users WHERE email = $1 FOR UPDATE',
        [normalizedEmail]
      );
      if (!rows[0]) throw codedError('USER_NOT_FOUND', 'User not found.');
      const userId = Number(rows[0].id);
      if (capability === EXPERT_R_EXECUTE_CAPABILITY) {
        // An explicit denial must override automatic project-role eligibility.
        if (enabled) await client.query(
          'DELETE FROM platform_capabilities WHERE user_id = $1 AND capability = $2',
          [userId, DENIED_CAPABILITY]
        );
        else await client.query(
          'INSERT INTO platform_capabilities (user_id, capability) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [userId, DENIED_CAPABILITY]
        );
      }
      if (enabled) {
        await client.query(
          `INSERT INTO platform_capabilities (user_id, capability)
           VALUES ($1, $2)
           ON CONFLICT (user_id, capability) DO NOTHING`,
          [userId, capability]
        );
      } else {
        await client.query(
          'DELETE FROM platform_capabilities WHERE user_id = $1 AND capability = $2',
          [userId, capability]
        );
      }
      const audit = await client.query(
        `INSERT INTO operator_audit_events
           (event_type, target_user_id, target_email, metadata_json)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [
          enabled ? 'platform_capability_granted' : 'platform_capability_revoked',
          userId,
          rows[0].email,
          JSON.stringify({ capability }),
        ]
      );
      await client.query('COMMIT');
      return {
        userId,
        email: rows[0].email,
        enabled,
        capability,
        auditEventId: String(audit.rows[0].id),
      };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* original error wins */ }
      throw error;
    } finally {
      client.release();
    }
  }

  async function setPipelineRegistryPublisherByEmail(email, enabled) {
    const result = await setPlatformCapabilityByEmail(
      email,
      PIPELINE_REGISTRY_PUBLISH_CAPABILITY,
      enabled
    );
    return { ...result, canPublishPipelineManifests: enabled };
  }

  async function setExpertRExecutorByEmail(email, enabled) {
    const result = await setPlatformCapabilityByEmail(email, EXPERT_R_EXECUTE_CAPABILITY, enabled);
    return { ...result, canExecuteExpertR: enabled };
  }

  function rowToExpertRPrivateInput(row, { includeStorage = false } = {}) {
    if (!row) return null;
    const value = {
      id: row.id,
      projectId: row.project_id,
      ownerUserId: Number(row.owner_user_id),
      originalFilename: row.original_filename,
      mimeType: row.mime_type,
      sizeBytes: Number(row.file_size_bytes),
      checksumSha256: row.sha256,
      createdAt: toCanonicalTs(row.created_at),
    };
    if (includeStorage) value.internalStorageKey = row.internal_storage_key;
    return value;
  }

  async function createExpertRPrivateInput(userId, projectId, input = {}) {
    const owner = Number(userId);
    const pid = String(projectId || '');
    const id = String(input.id || '');
    const originalFilename = sanitizeExpertRInputFilename(input.originalFilename);
    const sizeBytes = Number(input.sizeBytes);
    const checksumSha256 = String(input.checksumSha256 || '');
    const internalStorageKey = String(input.internalStorageKey || '');
    const mimeType = String(input.mimeType || 'application/octet-stream').slice(0, 100);
    if (!/^eri_[0-9a-f]{24}$/.test(id)
        || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0
        || sizeBytes > maxExpertRInputBytesForFilename(originalFilename)
        || !/^[0-9a-f]{64}$/.test(checksumSha256)
        || internalStorageKey !== allocateExpertRInputStorageKey(pid, id, originalFilename)
        || !storage.isProjectStorageKey(internalStorageKey, { projectId: pid, kind: 'artifacts' })) {
      throw codedError('INVALID_EXPERT_R_INPUT', 'Expert R private input metadata is invalid.');
    }
    const p = await connect(); const client = await p.connect();
    try {
      await client.query('BEGIN');
      const project = await client.query('SELECT id FROM projects WHERE id = $1 FOR UPDATE', [pid]);
      if (!project.rows[0]) throw codedError('NOT_FOUND', 'Project not found.');
      const membership = await client.query(
        'SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2',
        [pid, owner]
      );
      if (!membership.rows[0]) throw codedError('NOT_FOUND', 'Project not found.');
      if (!PROJECT_JOB_WRITE_ROLES.includes(membership.rows[0].role)) {
        throw codedError('FORBIDDEN', 'You do not have permission to import Expert R inputs.');
      }
      // Serialize explicit account revocation with imports, using the same user
      // lock as the operator's grant/revoke transaction.
      await client.query('SELECT id FROM users WHERE id = $1 FOR KEY SHARE', [owner]);
      const capability = await client.query(
        `SELECT 1 WHERE ${expertRAccessSql('$1', '$2')}`, [owner, pid]
      );
      if (!capability.rows[0]) throw codedError('FORBIDDEN', 'Expert R access is not approved for this account.');
      const usage = await client.query(
        `SELECT COUNT(*)::int AS count, COALESCE(SUM(file_size_bytes), 0)::bigint AS bytes
           FROM expert_r_private_inputs WHERE project_id = $1 AND owner_user_id = $2`,
        [pid, owner]
      );
      if (Number(usage.rows[0].count) >= MAX_EXPERT_R_PRIVATE_INPUTS
          || Number(usage.rows[0].bytes) + sizeBytes > MAX_EXPERT_R_PRIVATE_INPUT_STORAGE_BYTES) {
        throw codedError('EXPERT_R_INPUT_QUOTA', 'Private Expert R input storage is full.');
      }
      const inserted = await client.query(
        `INSERT INTO expert_r_private_inputs
           (id, project_id, owner_user_id, original_filename, internal_storage_key,
            mime_type, file_size_bytes, sha256)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [id, pid, owner, originalFilename, internalStorageKey, mimeType, sizeBytes, checksumSha256]
      );
      await client.query('COMMIT');
      return rowToExpertRPrivateInput(inserted.rows[0]);
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* original error wins */ }
      throw error;
    } finally { client.release(); }
  }

  async function listExpertRPrivateInputs(userId, projectId) {
    const membership = await requireProjectRole(userId, projectId, PROJECT_JOB_WRITE_ROLES);
    const { rows } = await query(
      `SELECT * FROM expert_r_private_inputs
        WHERE project_id = $1 AND owner_user_id = $2
        ORDER BY created_at DESC, id DESC`,
      [String(projectId), membership.userId]
    );
    return rows.map((row) => rowToExpertRPrivateInput(row));
  }

  async function resolveExpertRPrivateInputs(userId, projectId, inputIds, { includeStorage = false } = {}) {
    const ids = Array.isArray(inputIds) ? inputIds : [];
    if (ids.length === 0) return [];
    const { rows } = await query(
      `SELECT * FROM expert_r_private_inputs
        WHERE project_id = $1 AND owner_user_id = $2 AND id = ANY($3::text[])`,
      [String(projectId), Number(userId), ids]
    );
    const byId = new Map(rows.map((row) => [row.id, row]));
    if (byId.size !== ids.length || ids.some((id) => !byId.has(id))) {
      throw codedError('EXPERT_R_INPUT_NOT_FOUND', 'A selected private input is no longer available.');
    }
    return ids.map((id) => rowToExpertRPrivateInput(byId.get(id), { includeStorage }));
  }

  return {
    hasPipelineRegistryPublishCapability, hasExpertRExecuteCapability, getPipelineRegistryCapabilities, getExpertRCapabilities, setPipelineRegistryPublisherByEmail, setExpertRExecutorByEmail, createExpertRPrivateInput, listExpertRPrivateInputs, resolveExpertRPrivateInputs,
  };
}

module.exports = { createCapabilityStore };
