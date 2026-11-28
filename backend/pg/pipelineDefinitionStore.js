'use strict';

const {
  DEFAULT_PIPELINE_ID, validatePipelineManifest, getDefaultPipelineManifest, isBuiltInPipelineId,
} = require('../pipelineManifests');

// Platform pipeline registry definitions and each project's selected pipeline.
function createPipelineDefinitionStore({
  connect, query, codedError, requireProjectRole, generatePipelineDefinitionId, isValidPipelineDefinitionId,
  PIPELINE_REGISTRY_PUBLISH_CAPABILITY, PIPELINE_DEFINITION_READ_ROLES,
  PIPELINE_SELECTION_ROLES, PLATFORM_PIPELINE_VISIBILITY, PLATFORM_PIPELINE_REGISTRY_LIMIT,
}) {
  function validatedPlatformPipelineDefinition(row) {
    if (!row || !isValidPipelineDefinitionId(row.id)
        || row.project_id !== null || row.visibility !== PLATFORM_PIPELINE_VISIBILITY
        || typeof row.manifest_id !== 'string' || row.manifest_id === '') return null;
    let parsed;
    try {
      parsed = JSON.parse(row.manifest_json);
    } catch {
      return null;
    }
    let manifest;
    try {
      manifest = validatePipelineManifest(parsed);
    } catch {
      return null;
    }
    if (manifest.id !== row.manifest_id || manifest.name !== row.name) return null;
    return {
      id: row.id,
      projectId: null,
      ownerUserId: Number(row.owner_user_id),
      visibility: PLATFORM_PIPELINE_VISIBILITY,
      manifestId: row.manifest_id,
      name: row.name,
      manifest,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function toPublicPipelineDefinition(definition) {
    if (!definition) return null;
    return {
      id: definition.id,
      projectId: definition.projectId,
      visibility: definition.visibility,
      manifestId: definition.manifestId,
      name: definition.name,
      manifest: definition.manifest,
      createdAt: definition.createdAt,
      updatedAt: definition.updatedAt,
    };
  }

  function defaultPipelineDefinitionPublic(projectId) {
    return {
      id: DEFAULT_PIPELINE_ID,
      manifestId: DEFAULT_PIPELINE_ID,
      projectId: projectId || null,
      visibility: 'builtin',
      name: 'Default Seurat scRNA-seq Pipeline',
      manifest: getDefaultPipelineManifest(),
      builtin: true,
    };
  }

  async function getAccessiblePipelineDefinition(pipelineId) {
    if (isBuiltInPipelineId(pipelineId)) return { builtin: true };
    if (!isValidPipelineDefinitionId(pipelineId)) return null;
    const { rows } = await query(
      `SELECT * FROM pipeline_definitions
        WHERE id = $1
          AND project_id IS NULL
          AND visibility = $2
          AND manifest_id IS NOT NULL`,
      [String(pipelineId), PLATFORM_PIPELINE_VISIBILITY]
    );
    return validatedPlatformPipelineDefinition(rows[0]);
  }

  async function listProjectPipelineDefinitions(userId, projectId) {
    await requireProjectRole(userId, projectId, PIPELINE_DEFINITION_READ_ROLES);
    const { rows } = await query(
      `SELECT * FROM pipeline_definitions
        WHERE project_id IS NULL
          AND visibility = $1
          AND manifest_id IS NOT NULL
        ORDER BY created_at DESC, id DESC
        LIMIT $2`,
      [PLATFORM_PIPELINE_VISIBILITY, PLATFORM_PIPELINE_REGISTRY_LIMIT]
    );
    const trusted = rows.map(validatedPlatformPipelineDefinition).filter(Boolean);
    return [
      defaultPipelineDefinitionPublic(projectId),
      ...trusted.map(toPublicPipelineDefinition),
    ];
  }

  async function createPipelineRegistryDefinition(userId, input = {}) {
    const uid = Number(userId);
    if (!Number.isInteger(uid) || uid <= 0) {
      throw codedError('FORBIDDEN', 'Platform pipeline publication is not permitted.');
    }
    if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).some((field) => field !== 'manifest')) {
      throw codedError('INVALID_PIPELINE_DEFINITION', 'Only a declarative manifest may be published.');
    }
    const p = await connect();
    const client = await p.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1, $2)', [0x5343524e, 6]);
      const capability = await client.query(
        `SELECT 1 FROM platform_capabilities
          WHERE user_id = $1 AND capability = $2
          FOR SHARE`,
        [uid, PIPELINE_REGISTRY_PUBLISH_CAPABILITY]
      );
      if (!capability.rows[0]) {
        throw codedError('FORBIDDEN', 'Platform pipeline publication is not permitted.');
      }
      const count = await client.query(
        `SELECT count(*)::integer AS count FROM pipeline_definitions
          WHERE project_id IS NULL AND visibility = $1`,
        [PLATFORM_PIPELINE_VISIBILITY]
      );
      if (Number(count.rows[0]?.count || 0) >= PLATFORM_PIPELINE_REGISTRY_LIMIT) {
        throw codedError('PIPELINE_REGISTRY_FULL', 'The trusted pipeline registry has reached its configured limit.');
      }
      const manifest = validatePipelineManifest(input.manifest);
      const id = generatePipelineDefinitionId();
      const inserted = await client.query(
        `INSERT INTO pipeline_definitions
           (id, project_id, owner_user_id, visibility, manifest_id, name, manifest_json)
         VALUES ($1, NULL, $2, $3, $4, $5, $6)
         RETURNING *`,
        [
          id,
          uid,
          PLATFORM_PIPELINE_VISIBILITY,
          manifest.id,
          manifest.name,
          JSON.stringify(manifest),
        ]
      );
      await client.query('COMMIT');
      return toPublicPipelineDefinition(validatedPlatformPipelineDefinition(inserted.rows[0]));
    } catch (err) {
      await client.query('ROLLBACK');
      if (err && err.code === '23505') {
        throw codedError('PIPELINE_MANIFEST_EXISTS', 'A trusted pipeline with this manifest id already exists.');
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async function getProjectPipelineSelection(userId, projectId) {
    await requireProjectRole(userId, projectId, PIPELINE_SELECTION_ROLES);
    const { rows } = await query(
      'SELECT * FROM project_pipeline_selections WHERE project_id = $1 AND user_id = $2',
      [String(projectId), Number(userId)]
    );
    const requestedId = rows[0]?.pipeline_id || DEFAULT_PIPELINE_ID;
    const accessible = await getAccessiblePipelineDefinition(requestedId);
    const pipelineId = accessible ? requestedId : DEFAULT_PIPELINE_ID;
    const definition = isBuiltInPipelineId(pipelineId)
      ? defaultPipelineDefinitionPublic(projectId)
      : toPublicPipelineDefinition(accessible);
    return {
      projectId: String(projectId),
      userId: Number(userId),
      pipelineId,
      definition,
      selectionUnavailable: requestedId !== pipelineId,
      updatedAt: rows[0]?.updated_at || null,
    };
  }

  async function setProjectPipelineSelection(userId, projectId, pipelineId) {
    await requireProjectRole(userId, projectId, PIPELINE_SELECTION_ROLES);
    if (typeof pipelineId !== 'string' || pipelineId === '') {
      throw codedError('INVALID_PIPELINE_SELECTION', 'pipelineId is required.');
    }
    const accessible = await getAccessiblePipelineDefinition(pipelineId);
    if (!accessible) throw codedError('PIPELINE_NOT_FOUND', 'Pipeline definition not found.');
    await query(
      `INSERT INTO project_pipeline_selections (project_id, user_id, pipeline_id, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (project_id, user_id)
       DO UPDATE SET pipeline_id = EXCLUDED.pipeline_id, updated_at = EXCLUDED.updated_at`,
      [String(projectId), Number(userId), String(pipelineId)]
    );
    return getProjectPipelineSelection(userId, projectId);
  }

  return {
    toPublicPipelineDefinition, listProjectPipelineDefinitions, createPipelineRegistryDefinition, getProjectPipelineSelection, setProjectPipelineSelection,
  };
}

module.exports = { createPipelineDefinitionStore };
