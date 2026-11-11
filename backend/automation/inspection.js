'use strict';
const { codedError } = require('../policy/agentCapabilities');
const { parseMetadata } = require('../resourceAdmission/summaries');
const storage = require('../storage');
const { parseDelimited } = require('../artifactPreviews');
const TABLES = new Set(['deg_markers', 'enrichment_results', 'cellchat_results', 'condition_de_results']);
const SUMMARY_KEYS = new Set([
  'nCells',
  'nFeatures',
  'completedStage',
  'diagnostics',
  'preFilterCells',
  'postFilterCells',
  'percentMtAvailable',
  'nVariableFeatures',
  'nPcs',
  'nClusters',
  'clusterSizes',
  'reductions',
  'normalizationMethod',
  'resolution',
  'usedSeed',
  'seuratVersion',
  'rVersion',
  'groupBy',
  'assay',
  'testUse',
  'nGroups',
  'groups',
  'nMarkersTotal',
  'markersPerGroup',
  'topMarkers',
  'topPathways',
  'topInteractions',
  'panels',
  'nPathways',
  'nInteractions',
  'nRankedGenes',
  'targetGroup',
  'species',
  'databaseCategory',
  'analysisIntent',
  'parameters',
  'recipe'
]);
SUMMARY_KEYS.add('investigation');
for (const key of [
  'method',
  'comparison',
  'geneSetCollection',
  'rankMetric',
  'inputGeneCount',
  'mappedGeneCount',
  'mappingRate',
  'testedPathwayCount',
  'significantPathwayCount',
  'packageVersions',
  'warnings',
  'features',
  'database',
  'minCells',
  'nBoot',
  'groupSizes',
  'testedInteractions',
  'significantInteractions',
  'contrast',
  'design',
  'nSamples',
  'nGenes',
  'nSignificant',
  'replication',
  'limitations'
])
  SUMMARY_KEYS.add(key);
for (const key of [
  'inputCellCount',
  'analyzedCellCount',
  'inputGroupCount',
  'analyzedGroupCount',
  'excludedGroupCount',
  'candidateInteractionCount',
  'retainedInteractionCount',
  'retainedPathwayCount',
  'excludedGroups',
  'pValueCutoff',
  'cellTypeColumn',
  'unitOfReplication',
  'paired',
  'modelFormula',
  'sampleCount',
  'testedCellTypeCount',
  'testedGeneCount',
  'significantResultCount',
  'skippedCellTypes',
  'topResults'
])
  SUMMARY_KEYS.add(key);
function bounded(value, depth = 0, budget = { left: 10000 }) {
  if (--budget.left < 0 || depth > 8) return null;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string')
    return value.length <= 200 && ![...value].some(c => c.charCodeAt(0) < 32) && !/[\\/]/.test(value) ? value : null;
  if (Array.isArray(value)) return value.slice(0, 256).map(v => bounded(v, depth + 1, budget));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => /^[A-Za-z0-9_.-]{1,80}$/.test(k))
        .slice(0, 100)
        .map(([k, v]) => [k, bounded(v, depth + 1, budget)])
    );
  return null;
}
function tableCell(value) {
  if (typeof value !== 'string') return bounded(value);
  // Reviewed tables contain slash-delimited leading-edge gene identifiers.
  // Keep these scientific strings while still refusing absolute paths/URLs.
  if (
    value.length > 2000 ||
    [...value].some(c => c.charCodeAt(0) < 32) ||
    /^(?:[A-Za-z]:[\\/]|[\\/]|https?:|file:)/i.test(value) ||
    value.includes('\\') ||
    /(^|\/)\.\.(\/|$)/.test(value)
  )
    return null;
  return value;
}
function tableGroupFilter(type, group) {
  if (group === undefined) return undefined;
  const column = { deg_markers: 'cluster', condition_de_results: 'cell_type' }[type];
  if (!column || typeof group !== 'string' || !/^[A-Za-z0-9 ._+()-]{1,80}$/.test(group))
    throw codedError(
      'INVALID_INPUT',
      'Group filtering is supported only for marker or condition-DE tables with a bounded label.',
      400
    );
  return (columns, row) => {
    const index = columns.indexOf(column);
    if (index < 0) throw codedError('INVALID_ARTIFACT', 'The declared group column is missing.', 409);
    return row[index] === group;
  };
}
function createRunInspection({ db, admission }) {
  async function scope(actor, runId) {
    if (actor.delegation.disclosureProfile !== 'labels')
      throw codedError('DISCLOSURE_DENIED', 'Scientific inspection requires the labels disclosure profile.', 403);
    const run = await admission.getRunForAgent(actor, runId);
    if (run.state !== 'candidate_ready')
      throw codedError('RESULT_NOT_READY', 'Only completed, non-quarantined candidates can be inspected.', 409);
    return run;
  }
  async function inspect(actor, runId) {
    const run = await scope(actor, runId);
    const { rows } = await db.query(
      'SELECT a.id,a.artifact_type,a.metadata_json,a.mime_type,a.size_bytes FROM job_artifacts a JOIN agent_runs ar ON ar.job_id=a.job_id WHERE ar.id=$1 AND ar.delegation_id=$2 AND a.project_id=$3 ORDER BY a.created_at,a.id',
      [runId, actor.delegation.id, actor.delegation.projectId]
    );
    let summary = {};
    if (run.resultAnalysisObjectId) {
      const objects = await db.query('SELECT metadata_json FROM analysis_objects WHERE id=$1 AND project_id=$2', [
        run.resultAnalysisObjectId,
        actor.delegation.projectId
      ]);
      summary = parseMetadata(objects.rows[0]?.metadata_json).summary || {};
    }
    const scientific = value =>
      bounded(Object.fromEntries(Object.entries(value || {}).filter(([k]) => SUMMARY_KEYS.has(k))));
    return {
      run,
      summary: scientific(summary),
      artifacts: rows.map(row => ({
        id: row.id,
        type: row.artifact_type,
        mimeType: row.mime_type,
        sizeBytes: Number(row.size_bytes) || null,
        tableAvailable: TABLES.has(row.artifact_type),
        figureAvailable: row.mime_type === 'application/vnd.traceomics.figure+json',
        summary: scientific(parseMetadata(row.metadata_json).summary)
      }))
    };
  }
  async function artifact(actor, runId, artifactId, { offset = 0, limit = 50, format = 'png', table, group } = {}) {
    await scope(actor, runId);
    if (
      !/^art_[a-f0-9]+$/.test(artifactId) ||
      !Number.isInteger(offset) ||
      offset < 0 ||
      offset > 10000 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw codedError('INVALID_INPUT', 'Invalid artifact page.', 400);
    const { rows } = await db.query(
      'SELECT a.* FROM job_artifacts a JOIN agent_runs ar ON ar.job_id=a.job_id WHERE ar.id=$1 AND ar.delegation_id=$2 AND a.id=$3 AND a.project_id=$4',
      [runId, actor.delegation.id, artifactId, actor.delegation.projectId]
    );
    const row = rows[0];
    const figure =
      ['exploration_summary', 'study_inference_summary'].includes(row?.artifact_type) &&
      row.mime_type === 'application/vnd.traceomics.figure+json' &&
      parseMetadata(row.metadata_json).kind === 'standard_figure';
    if (!row || (!TABLES.has(row.artifact_type) && !figure))
      throw codedError('NOT_FOUND', 'Inspectable artifact not found.', 404);
    const maximum = figure ? 12 * 1024 * 1024 : 64 * 1024 * 1024;
    if (Number(row.size_bytes) > maximum || Number(row.size_bytes) < 1)
      throw codedError('INSPECTION_LIMIT', 'Artifact exceeds the bounded inspection budget.', 413);
    const provider = storage.createLocalStorageProvider();
    const opened = await provider.openVerifiedRead(row.storage_uri, {
      checksumSha256: row.checksum_sha256,
      sizeBytes: Number(row.size_bytes)
    });
    try {
      const bytes = await opened.handle.readFile();
      if (figure) {
        if (group !== undefined)
          throw codedError(
            'INVALID_INPUT',
            'Group filtering is for marker/condition-DE CSVs, not figure bundles.',
            400
          );
        if (!['png', 'svg', 'pdf'].includes(format)) throw codedError('INVALID_INPUT', 'Choose png, svg or pdf.', 400);
        const bundle = JSON.parse(bytes.toString('utf8'));
        if (bundle.schema !== 'traceomics.standard-figure.v1')
          throw codedError('INVALID_ARTIFACT', 'Invalid figure bundle.', 409);
        if (table !== undefined) {
          if (typeof table !== 'string' || !/^[a-z_]{1,40}$/.test(table) || !bundle.tables?.[table])
            throw codedError('INVALID_INPUT', 'Choose a named investigation table from the artifact summary.', 400);
          const data = bundle.tables[table];
          if (!Array.isArray(data.columns) || !Array.isArray(data.rows) || data.rows.length > 3000)
            throw codedError('INVALID_ARTIFACT', 'Invalid investigation table.', 409);
          return {
            artifactId,
            table,
            family: 'table',
            columns: data.columns,
            rows: data.rows.slice(offset, offset + limit).map(row => row.map(tableCell)),
            offset,
            limit,
            totalRows: data.rows.length,
            hasMore: offset + limit < data.rows.length
          };
        }
        return {
          artifactId,
          mimeType: { png: 'image/png', svg: 'image/svg+xml', pdf: 'application/pdf' }[format],
          sha256: row.checksum_sha256,
          format,
          provenance: bundle.provenance,
          ...(format === 'png' ? { imageBase64: bundle.png } : { blob: bundle[format] })
        };
      }
      const page = parseDelimited(bytes.toString('utf8'), ',', {
        offset,
        limit,
        rowFilter: tableGroupFilter(row.artifact_type, group)
      });
      return {
        artifactId,
        ...page,
        ...(group === undefined ? {} : { group, offsetBasis: 'matching_group_rows' }),
        rows: page.rows.map(row => row.map(tableCell))
      };
    } finally {
      await opened.handle.close();
    }
  }
  return { inspect, artifact };
}
module.exports = { createRunInspection, bounded, tableCell, tableGroupFilter };
