'use strict';

// Server-registered workflow releases (docs/spec.md 8.1). Only operations in
// this catalog can ever run for an agent. A release's digest covers the bytes
// of its handler files, its parameter schema, resource profile, inputs and
// outputs, so changing any of them yields a new release identity and makes
// earlier approvals stop matching. Nothing here accepts code, paths, or
// executable parameters from a caller.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { SEURAT_PIPELINE_PARAM_SPEC, validateSeuratPipelineParams } = require('../seuratPipeline');
const { DEG_FIND_MARKERS_PARAM_SPEC, validateDegFindMarkersParams } = require('../degFindMarkers');

const ROOT = path.join(__dirname, '..', '..');

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

const DEFINITIONS = [
  {
    key: 'seurat-qc-cluster',
    version: '1',
    title: 'Seurat QC, normalization and clustering (10x HDF5)',
    jobType: 'seurat.pipeline.v1',
    // seuratPipelineCore.R holds the analysis steps themselves; plumber.R only
    // sources it, so it must be digested in its own right.
    handlerFiles: ['backend/seuratPipeline.js', 'backend/jobs/pipelineHandlers.js', 'r-backend/plumber.R',
      'r-backend/lib/seuratPipelineCore.R'],
    readableSource: 'r-backend/lib/seuratPipelineCore.R',
    inputs: [{ name: 'dataset', fileTypes: ['tenx_h5'] }],
    outputs: [{ name: 'result', kind: 'analysis_object', objectType: 'seurat' }],
    parameterSchema: SEURAT_PIPELINE_PARAM_SPEC,
    // Accounting reservation per run. The local worker runs one job at a time;
    // physical CPU/memory limits come from the R runtime's container settings.
    resources: { cpus: 1, memoryMiB: 8192, maxWallSeconds: 3600 },
    validation: ['job.completed', 'result.analysis_object.present'],
    validateParameters: (params) => validateSeuratPipelineParams(params).params,
  },
  {
    // A follow-on step: it runs on the accepted clustering of a source study
    // (see studies.js), never on an arbitrary object, and reads it without
    // changing it. Its output is a marker table plus a bounded summary.
    key: 'seurat-markers',
    version: '1',
    title: 'Cluster marker genes (on an accepted clustering)',
    jobType: 'deg.find_markers.v1',
    handlerFiles: ['backend/degFindMarkers.js', 'backend/jobs/analysisHandlers.js', 'r-backend/plumber.R'],
    inputs: [{ name: 'clustering', kind: 'analysis_object', fromRelease: 'seurat-qc-cluster' }],
    outputs: [{ name: 'markers', kind: 'artifact', artifactType: 'deg_summary' }],
    parameterSchema: DEG_FIND_MARKERS_PARAM_SPEC,
    resources: { cpus: 1, memoryMiB: 8192, maxWallSeconds: 1800 },
    validation: ['job.completed', 'result.artifact.present'],
    validateParameters: (params) => validateDegFindMarkersParams(params).params,
  },
];

// Artifact types that count as a release's declared result (spec 13.1).
const RESULT_ARTIFACT_TYPES = Object.freeze(
  [...new Set(DEFINITIONS.flatMap((d) => d.outputs.filter((o) => o.kind === 'artifact').map((o) => o.artifactType)))]
);

// Type/range check for one parameter value against a release schema entry,
// without defaults. Cross-parameter constraints are checked at planning time.
function validateScalar(schema, name, value) {
  const spec = schema[name];
  if (!spec) throw new Error(`Unknown parameter '${name}'.`);
  const fail = (why) => { throw new Error(`Parameter '${name}' ${why}.`); };
  if (spec.type === 'enum') { if (!spec.values.includes(value)) fail(`must be one of: ${spec.values.join(', ')}`); return; }
  if (spec.type === 'bool') { if (typeof value !== 'boolean') fail('must be a boolean'); return; }
  if (spec.type === 'intOrNull' && value === null) return;
  if (typeof value !== 'number' || !Number.isFinite(value)) fail('must be a finite number');
  if ((spec.type === 'int' || spec.type === 'intOrNull') && !Number.isInteger(value)) fail('must be an integer');
  if (value < spec.min || value > spec.max) fail(`must be between ${spec.min} and ${spec.max}`);
}

function fileDigest(relative) {
  const bytes = fs.readFileSync(path.join(ROOT, relative));
  return { path: relative, sha256: sha256(bytes) };
}

function buildRelease(definition) {
  const identity = {
    schema: 'traceomics.workflow-release.v1',
    key: definition.key,
    version: definition.version,
    jobType: definition.jobType,
    handler: definition.handlerFiles.map(fileDigest),
    parameterSchema: definition.parameterSchema,
    inputs: definition.inputs,
    outputs: definition.outputs,
    resources: definition.resources,
    validation: definition.validation,
  };
  const digest = sha256(canonicalJson(identity));
  return {
    id: `rel_${digest.slice(0, 24)}`,
    key: definition.key,
    version: definition.version,
    title: definition.title,
    jobType: definition.jobType,
    digest,
    definition: { ...identity, title: definition.title },
    readableSource: definition.readableSource || null,
    validateParameters: definition.validateParameters,
  };
}

function currentReleases() {
  return DEFINITIONS.map(buildRelease);
}

// Registers the current releases and supersedes older digests of the same key.
async function syncReleaseCatalog(db, releases = currentReleases()) {
  const pool = await db.connect();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('workflow-release-catalog'))");
    for (const release of releases) {
      await client.query(
        `UPDATE workflow_releases SET status = 'superseded', superseded_at = now()
          WHERE release_key = $1 AND digest <> $2 AND status = 'current'`,
        [release.key, release.digest]
      );
      await client.query(
        `INSERT INTO workflow_releases (id, release_key, version, job_type, digest, definition_json, status)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'current')
         ON CONFLICT (digest) DO UPDATE SET status = 'current', superseded_at = NULL`,
        [release.id, release.key, release.version, release.jobType, release.digest, JSON.stringify(release.definition)]
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  return releases;
}

function releaseByKey(key) {
  return currentReleases().find((release) => release.key === key) || null;
}

module.exports = { RESULT_ARTIFACT_TYPES, validateScalar, canonicalJson, sha256, currentReleases, syncReleaseCatalog, releaseByKey, buildRelease };
