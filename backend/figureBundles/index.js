'use strict';

// Figure bundles: export only the objects, jobs and recorded scripts that the
// selected figures depend on, in dependency order, with one runnable R script.

const crypto = require('crypto');
const db = require('../pgDatabase');
const { codedError } = require('../codedError');
const { isValidAnalysisObjectIdFormat, isValidFigureIdFormat } = require('../resourceIds');
const { planSelection, figureReads, operationEffects } = require('./selection');

const BUNDLE_SCHEMA = 'traceomics.figure-bundle';
const BUNDLE_VERSION = 1;
const MAX_SELECTION = 50;
const MAX_LINEAGE_OBJECTS = 500;
const READ_ROLES = ['owner', 'admin', 'analyst', 'viewer'];

function parseJson(value, fallback) {
  if (value == null) return fallback;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function normalizeSelection(input = {}) {
  const figureIds = Array.isArray(input.figureIds) ? [...new Set(input.figureIds)] : [];
  const analysisObjectIds = Array.isArray(input.analysisObjectIds) ? [...new Set(input.analysisObjectIds)] : [];
  if (figureIds.length + analysisObjectIds.length === 0) {
    throw codedError('EMPTY_SELECTION', 'Select at least one figure or analysis object.');
  }
  if (figureIds.length + analysisObjectIds.length > MAX_SELECTION) {
    throw codedError('SELECTION_TOO_LARGE', `Select at most ${MAX_SELECTION} figures and objects.`);
  }
  if (!figureIds.every(isValidFigureIdFormat)) throw codedError('INVALID_FIGURE_ID', 'Malformed figure ID.');
  if (!analysisObjectIds.every(isValidAnalysisObjectIdFormat)) {
    throw codedError('INVALID_ANALYSIS_OBJECT_ID', 'Malformed analysis object ID.');
  }
  return { figureIds, analysisObjectIds };
}

// Upstream closure of the seed objects over lineage edges, limited to objects
// the caller may see. Invisible ancestors become unresolved boundaries.
async function collectLineage(userId, projectId, seedObjectIds) {
  const pid = String(projectId);
  if (seedObjectIds.length === 0) return { objects: new Map(), edges: [] };
  const { rows } = await db.query(
    `WITH RECURSIVE lineage(id, depth) AS (
       SELECT unnest($2::text[]), 0
       UNION
       SELECT edge.parent_analysis_object_id, lineage.depth + 1
         FROM analysis_object_edges edge JOIN lineage
           ON lineage.id = edge.child_analysis_object_id
        WHERE edge.project_id = $1 AND lineage.depth < 64
     )
     SELECT DISTINCT object.* FROM analysis_objects object JOIN lineage ON lineage.id = object.id
      WHERE object.project_id = $1 ORDER BY object.created_at, object.id LIMIT ${MAX_LINEAGE_OBJECTS + 1}`,
    [pid, seedObjectIds]
  );
  if (rows.length > MAX_LINEAGE_OBJECTS) {
    throw codedError('SELECTION_TOO_LARGE', 'The selected figures depend on too many analysis objects.');
  }
  const objects = new Map();
  for (const row of rows) {
    const visible = await db.getProjectAnalysisObject(userId, pid, row.id);
    if (!visible) continue;
    objects.set(row.id, {
      id: row.id, objectType: row.object_type, datasetId: row.dataset_id,
      displayName: parseJson(row.metadata_json, {})?.displayName || null,
      objectHash: row.object_hash || null,
      createdAt: row.created_at, parents: [],
    });
  }
  const ids = [...objects.keys()];
  const { rows: edgeRows } = ids.length === 0 ? { rows: [] } : await db.query(
    `SELECT * FROM analysis_object_edges WHERE project_id = $1
       AND child_analysis_object_id = ANY($2::text[])
     ORDER BY created_at, id`,
    [pid, ids]
  );
  const edges = [];
  for (const row of edgeRows) {
    const child = objects.get(row.child_analysis_object_id);
    if (!child) continue;
    const edge = {
      id: row.id, parentId: row.parent_analysis_object_id, childId: row.child_analysis_object_id,
      edgeType: row.edge_type, parentRole: row.parent_role, jobId: row.job_id, createdAt: row.created_at,
    };
    edges.push(edge);
    // Ancestors the caller cannot see stay out of the plan; the child is then
    // a boundary whose inherited state is reported as unresolved.
    if (objects.has(edge.parentId)) child.parents.push(edge);
  }
  return { objects, edges };
}

// Recorded steps come from two places: project provenance records, and the
// server-verified live execution journal that the interactive R session
// writes for every step (its code, parameters and package versions). The
// journal belongs to the person who ran the session, which is the analysis
// object's owner; the object has already passed the caller's visibility check.
async function collectRecords(projectId, objectIds) {
  if (objectIds.length === 0) return { byObject: new Map(), byId: new Map() };
  const { rows } = await db.query(
    `SELECT * FROM provenance WHERE project_id = $1 AND analysis_object_id = ANY($2::text[])
      ORDER BY created_at, id`,
    [String(projectId), objectIds]
  );
  const { rows: liveRows } = await db.query(
    `SELECT live.* FROM live_execution_records live
       JOIN analysis_objects object ON object.id = live.analysis_object_id
      WHERE live.project_id = $1 AND live.analysis_object_id = ANY($2::text[])
        AND live.owner_user_id = object.owner_user_id
      ORDER BY live.created_at, live.kernel_order, live.id`,
    [String(projectId), objectIds]
  );
  for (const row of liveRows) {
    const record = typeof row.record_json === 'string' ? parseJson(row.record_json, {}) : (row.record_json || {});
    rows.push({
      id: row.id, analysis_object_id: row.analysis_object_id, operation: row.operation,
      // Within one R session the execution counter breaks timestamp ties.
      created_at: row.created_at, sequence: Number(row.kernel_order), parent_ids: '[]', language: record.source?.language || 'R',
      language_version: record.environment?.rVersion || null,
      packages: JSON.stringify(record.environment?.packages || []),
      parameters: JSON.stringify(record.parameters || {}),
      script: record.source?.code || '', job_id: null, live: true,
    });
  }
  const byObject = new Map();
  const byId = new Map();
  for (const row of rows) {
    const record = {
      id: row.id, objectId: row.analysis_object_id, operation: row.operation || 'unknown',
      createdAt: row.created_at, sequence: row.sequence ?? null, parentIds: parseJson(row.parent_ids, []),
      language: row.language, languageVersion: row.language_version,
      packages: parseJson(row.packages, []), parameters: parseJson(row.parameters, {}),
      script: row.script || '', jobId: row.job_id || null, source: row.live ? 'live-session' : 'provenance',
    };
    byId.set(record.id, record);
    if (!byObject.has(record.objectId)) byObject.set(record.objectId, []);
    byObject.get(record.objectId).push(record);
  }
  return { byObject, byId };
}

async function collectProducingJobs(userId, projectId, objectIds) {
  if (objectIds.length === 0) return new Map();
  const { rows } = await db.query(
    `SELECT * FROM jobs WHERE project_id = $1 AND result_analysis_object_id = ANY($2::text[])
       AND status = 'succeeded' ORDER BY created_at, id`,
    [String(projectId), objectIds]
  );
  const jobs = new Map();
  for (const row of rows) {
    if (jobs.has(row.result_analysis_object_id)) continue;
    if (!(await db.getProjectJob(userId, projectId, row.id))) continue;
    jobs.set(row.result_analysis_object_id, {
      id: row.id, jobType: row.job_type, createdAt: row.created_at,
      analysisObjectId: row.analysis_object_id, datasetId: row.dataset_id,
      parameters: publicJobParameters(row),
    });
  }
  return jobs;
}

// Job parameters can carry caller code (expert R) or internal keys. Keep the
// scientific settings and replace code with its digest.
const PARAMETER_DENY = /(path|uri|url|storage|state.?key|token|secret|claim|worker)/i;
function publicJobParameters(row) {
  const parameters = parseJson(row.parameters_json, {});
  const output = {};
  for (const [key, value] of Object.entries(parameters || {})) {
    if (PARAMETER_DENY.test(key)) continue;
    if (key === 'script' && typeof value === 'string') {
      output.scriptSha256 = crypto.createHash('sha256').update(value, 'utf8').digest('hex');
      continue;
    }
    output[key] = value;
  }
  return output;
}

async function countProject(projectId) {
  const pid = String(projectId);
  const [objects, jobs, records, figures] = await Promise.all([
    db.query('SELECT count(*)::int AS n FROM analysis_objects WHERE project_id = $1', [pid]),
    db.query(`SELECT count(*)::int AS n FROM jobs WHERE project_id = $1 AND status = 'succeeded'`, [pid]),
    db.query(`SELECT (SELECT count(*) FROM provenance WHERE project_id = $1)
                   + (SELECT count(*) FROM live_execution_records WHERE project_id = $1) AS n`, [pid]),
    db.query('SELECT count(*)::int AS n FROM figure_collection WHERE project_id = $1', [pid]),
  ]);
  return {
    objects: objects.rows[0].n, jobs: jobs.rows[0].n,
    steps: Number(records.rows[0].n), figures: figures.rows[0].n,
  };
}

function rString(value) {
  return JSON.stringify(String(value ?? ''));
}

function rVector(values) {
  return `c(${values.map(rString).join(', ')})`;
}

function safeFileStem(value, fallback) {
  const stem = String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return stem || fallback;
}

// The figure step mirrors build_pub_plot's arguments for the supported types.
function figureScript(figure) {
  const params = figure.params || {};
  const groupBy = params.group_by || 'seurat_clusters';
  const features = Array.isArray(params.features) ? params.features.map(String).slice(0, 50) : [];
  const ptSize = Number.isFinite(Number(params.pt_size)) ? Number(params.pt_size) : 1;
  const width = Number.isFinite(Number(params.width)) ? Number(params.width) : 7;
  const height = Number.isFinite(Number(params.height)) ? Number(params.height) : 5;
  const dpi = Number.isFinite(Number(params.dpi)) ? Number(params.dpi) : 300;
  const format = ['png', 'pdf', 'svg', 'tiff'].includes(params.format || figure.fileFormat)
    ? (params.format || figure.fileFormat) : 'png';
  const split = params.split_by ? `, split.by = ${rString(params.split_by)}` : '';
  let plot;
  switch (figure.plotType) {
    case 'UMAP':
      plot = `DimPlot(obj, reduction = "umap", group.by = ${rString(groupBy)}, pt.size = ${ptSize}, label = ${params.label ? 'TRUE' : 'FALSE'}${split})`;
      break;
    case 'FeaturePlot':
      plot = `FeaturePlot(obj, features = ${rVector(features)}, pt.size = ${ptSize}${split})`;
      break;
    case 'DotPlot':
      plot = `DotPlot(obj, features = ${rVector(features)}, group.by = ${rString(groupBy)}) + RotatedAxis()`;
      break;
    case 'Heatmap':
      plot = `DoHeatmap(obj, features = ${rVector(features)}, group.by = ${rString(groupBy)})`;
      break;
    case 'Violin':
      plot = `VlnPlot(obj, features = ${rVector(features)}, group.by = ${rString(groupBy)}, pt.size = 0${split})`;
      break;
    default:
      plot = null;
  }
  const file = `figures/${safeFileStem(figure.title, figure.id)}.${format}`;
  const lines = [`# Figure ${figure.id}: ${String(figure.title || figure.plotType).replace(/\s+/g, ' ')}`];
  if (!plot) {
    lines.push(`# Plot type ${rString(figure.plotType)} has no scripted equivalent; saved parameters:`);
    lines.push(`figure_params <- jsonlite::fromJSON(${rString(JSON.stringify(params))})`);
    return lines.join('\n');
  }
  if (params.title) plot += ` + ggplot2::ggtitle(${rString(params.title)})`;
  lines.push('dir.create("figures", showWarnings = FALSE)');
  lines.push(`p <- ${plot}`);
  lines.push(`ggplot2::ggsave(${rString(file)}, p, width = ${width}, height = ${height}, dpi = ${dpi})`);
  return lines.join('\n');
}

function jobScript(job) {
  const lines = [
    `# Durable job ${job.id} (${job.jobType}) produced this object.`,
    '# It ran a server pipeline; its recorded settings are:',
    `job_settings <- jsonlite::fromJSON(${rString(JSON.stringify(job.parameters || {}))})`,
  ];
  if (job.jobType === 'checkpoint.save.v1' || job.jobType === 'checkpoint.fork.v1') {
    lines.push('# A checkpoint copies the parent object unchanged; no code to rerun.');
  }
  return lines.join('\n');
}

function indentScript(script) {
  return String(script || '').replace(/\r\n/g, '\n').trimEnd();
}

function assembleScript(bundle) {
  const lines = [
    '# TraceOmics figure bundle',
    `# Project ${bundle.projectId}; generated ${bundle.generatedAt}`,
    `# Selection: ${[...bundle.selection.figureIds, ...bundle.selection.analysisObjectIds].join(', ')}`,
    `# Kept ${bundle.summary.kept.steps} of ${bundle.summary.project.steps} recorded steps and ${bundle.summary.kept.objects} of ${bundle.summary.project.objects} objects.`,
    '# Steps appear in dependency order; every step follows everything it reads.',
    '# Paths shown as <...> are server-managed inputs: point them at your copy of the data.',
    '',
    'suppressPackageStartupMessages({ library(Seurat); library(ggplot2) })',
    '',
  ];
  const stepsById = new Map(bundle.steps.map((step) => [step.id, step]));
  const jobsById = new Map(bundle.jobs.map((job) => [job.id, job]));
  const figuresById = new Map(bundle.figures.map((figure) => [figure.id, figure]));
  const objectsById = new Map(bundle.objects.map((object) => [object.id, object]));
  let currentObject = null;
  for (const node of bundle.order) {
    if (node.kind === 'object') {
      const object = objectsById.get(node.id);
      lines.push(`# ==== Object ${node.id}${object?.displayName ? ` (${object.displayName})` : ''} ====`);
      if (object?.parents?.length) {
        lines.push(`# Derived from ${object.parents.map((p) => `${p.parentId} [${p.edgeType}]`).join(', ')}`);
      } else if (object?.datasetId) {
        lines.push(`# Starts from dataset ${object.datasetId}; the load step below reads it.`);
      }
      currentObject = node.id;
      lines.push('');
      continue;
    }
    if (node.kind === 'job') {
      lines.push(jobScript(jobsById.get(node.id)), '');
      continue;
    }
    if (node.kind === 'step') {
      const step = stepsById.get(node.id);
      if (step.objectId !== currentObject) {
        lines.push(`# (continuing object ${step.objectId})`);
        currentObject = step.objectId;
      }
      lines.push(`# ---- Step ${step.id}: ${step.operation}${step.conservative ? ' (kept conservatively: unknown effects)' : ''} ----`);
      lines.push(indentScript(step.script) || '# (no script was recorded for this step)', '');
      continue;
    }
    if (node.kind === 'figure') {
      lines.push(figureScript(figuresById.get(node.id)), '');
    }
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

async function buildFigureBundle(userId, projectId, input = {}) {
  await db.requireProjectRole(userId, projectId, READ_ROLES);
  const selection = normalizeSelection(input);
  const pid = String(projectId);
  const figures = [];
  for (const figureId of selection.figureIds) {
    const figure = await db.getProjectFigure(userId, pid, figureId);
    if (!figure) throw codedError('FIGURE_NOT_FOUND', 'Figure not found.');
    figures.push(figure);
  }
  for (const objectId of selection.analysisObjectIds) {
    if (!(await db.getProjectAnalysisObject(userId, pid, objectId))) {
      throw codedError('ANALYSIS_OBJECT_NOT_FOUND', 'Analysis object not found.');
    }
  }
  const seedObjects = [...new Set([
    ...figures.map((figure) => figure.analysisObjectId).filter(Boolean),
    ...selection.analysisObjectIds,
  ])];
  const lineage = await collectLineage(userId, pid, seedObjects);
  const objectIds = [...lineage.objects.keys()];
  const records = await collectRecords(pid, objectIds);
  const producingJobs = await collectProducingJobs(userId, pid, objectIds);

  const plan = planSelection({
    objects: lineage.objects, records: records.byObject,
    producingJobs, recordsById: records.byId,
  }, [
    ...figures.map((figure) => ({
      id: figure.id, kind: 'figure', objectId: figure.analysisObjectId,
      plotType: figure.plotType, createdAt: figure.createdAt, provenanceId: figure.provenanceId,
    })),
    ...selection.analysisObjectIds.map((objectId) => ({ id: objectId, kind: 'object', objectId })),
  ]);

  const keptIds = new Set(plan.order.map((node) => node.id));
  const steps = [...records.byId.values()].filter((record) => keptIds.has(record.id))
    .map((record) => ({
      id: record.id, objectId: record.objectId, operation: record.operation,
      createdAt: record.createdAt, source: record.source, language: record.language, languageVersion: record.languageVersion,
      packages: record.packages, parameters: record.parameters, script: record.script,
      scriptSha256: crypto.createHash('sha256').update(record.script, 'utf8').digest('hex'),
      reads: operationEffects(record.operation).reads, writes: operationEffects(record.operation).writes,
      conservative: Boolean(operationEffects(record.operation).conservative),
    }));
  const jobs = [...producingJobs.values()].filter((job) => keptIds.has(job.id));
  const objects = [...lineage.objects.values()].filter((object) => keptIds.has(object.id))
    .map((object) => ({ ...object, parents: object.parents.map((edge) => ({
      parentId: edge.parentId, edgeType: edge.edgeType, parentRole: edge.parentRole, jobId: edge.jobId,
    })) }));
  const recordedOnLineage = [...records.byId.values()];
  const omitted = recordedOnLineage.filter((record) => !keptIds.has(record.id))
    .map((record) => ({ id: record.id, objectId: record.objectId, operation: record.operation, createdAt: record.createdAt }));
  const project = await countProject(pid);

  const bundle = {
    schema: BUNDLE_SCHEMA,
    version: BUNDLE_VERSION,
    generatedAt: new Date().toISOString(),
    projectId: pid,
    selection,
    figures: figures.map((figure) => ({
      id: figure.id, title: figure.title, plotType: figure.plotType, params: figure.params,
      fileFormat: figure.fileFormat, analysisObjectId: figure.analysisObjectId,
      provenanceId: figure.provenanceId, jobId: figure.jobId, createdAt: figure.createdAt,
      reads: figureReads(figure.plotType),
    })),
    order: plan.order.map((node) => ({ id: node.id, kind: node.kind, objectId: node.objectId || null })),
    dependencies: plan.edges,
    objects,
    jobs,
    steps,
    omittedSteps: omitted,
    unresolved: plan.unresolved,
    summary: {
      kept: { objects: objects.length, jobs: jobs.length, steps: steps.length, figures: figures.length },
      onLineage: { objects: lineage.objects.size, steps: recordedOnLineage.length },
      project,
    },
  };
  bundle.script = assembleScript(bundle);
  bundle.scriptSha256 = crypto.createHash('sha256').update(bundle.script, 'utf8').digest('hex');
  return bundle;
}

module.exports = {
  BUNDLE_SCHEMA, BUNDLE_VERSION, MAX_SELECTION,
  buildFigureBundle, normalizeSelection, figureScript, assembleScript,
};
