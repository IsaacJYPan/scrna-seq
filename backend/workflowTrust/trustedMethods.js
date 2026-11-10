'use strict';

// Trusted method library (trusted-methods/). Each method is one reviewed R
// file that follows a named upstream tutorial or paper repository, plus a
// declarative catalog entry: bounded parameters, typed outputs, provenance,
// resource reservation, and which accepted results it may run on.
//
// The same bytes serve two paths without duplication:
//  - people: scripts/build-trusted-workflows.mjs composes methods into
//    ordinary workflow packages (docs/workflow-pipelines.md);
//  - agents: workflowTrust/catalog.js turns each method into a digest-pinned
//    release executed by the `trusted.method.v1` job (jobs/trustedMethodHandler.js).
//
// Nothing here accepts code from a caller. Text parameters are restricted to
// fixed grammars (gene symbols, labels, label maps) and re-parsed in R.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const LIBRARY_DIR = path.join(ROOT, 'trusted-methods');
const CATALOG_PATH = path.join(LIBRARY_DIR, 'catalog.json');
const JOB_TYPE = 'trusted.method.v1';

const KEY = /^[a-z][a-z0-9-]{1,39}$/;
const VERSION = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;
const ENTRY = /^methods\/[a-z0-9-]+\.R$/;
const METRIC = /^[A-Za-z0-9_]{1,64}$/;
const OUTPUT_TYPES = ['rds', 'table', 'metrics', 'figure'];
const ROLES = ['tuning', 'design', 'display'];
const CATEGORIES = ['qc', 'normalization', 'integration', 'clustering', 'annotation', 'differential', 'trajectory',
  'spatial', 'scoring', 'visualization'];
const MODALITIES = ['scrna', 'snrna', 'visium', 'imaging'];
const BASE_RELEASES = ['seurat-qc-cluster', 'seurat-multisample', 'spatial-seurat'];

// Text grammars. Each is a plain regular language: never evaluated, and the R
// method splits and re-validates the value before using it as data.
const SYMBOL = '[A-Za-z0-9][A-Za-z0-9._-]{0,39}';
const LABEL = '[A-Za-z0-9][A-Za-z0-9 ._+()/-]{0,59}';
const TEXT_PATTERNS = Object.freeze({
  // One metadata column name. Columns are looked up as data and must exist.
  column: /^[A-Za-z][A-Za-z0-9._]{0,63}$/,
  genes: new RegExp(`^${SYMBOL}(,${SYMBOL}){0,199}$`),
  labels: new RegExp(`^${SYMBOL}(,${SYMBOL}){0,99}$`),
  labelMap: new RegExp(`^${SYMBOL}=${LABEL}(;${SYMBOL}=${LABEL}){0,199}$`),
  geneSets: new RegExp(
    `^[A-Za-z][A-Za-z0-9_]{0,39}:${SYMBOL}(,${SYMBOL}){0,199}(;[A-Za-z][A-Za-z0-9_]{0,39}:${SYMBOL}(,${SYMBOL}){0,199}){0,19}$`
  )
});

function fail(message) { throw new Error(`Trusted method catalog: ${message}`); }
function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function plain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function only(value, fields, label) {
  if (!plain(value)) fail(`${label} must be an object.`);
  for (const key of Object.keys(value)) if (!fields.includes(key)) fail(`${label}: unknown field ${key}.`);
}
function line(value, label, max = 200) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > max ||
    [...value].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  ) {
    fail(`${label} must be 1-${max} characters on one line.`);
  }
}

function validateParameter(parameter, methodKey) {
  const label = `${methodKey} parameter`;
  only(parameter, ['key', 'type', 'label', 'default', 'min', 'max', 'options', 'maxLength', 'role', 'pattern', 'help'], label);
  if (!KEY.test(parameter.key || '')) fail(`${label} key must be a lowercase identifier.`);
  line(parameter.label, `${label} ${parameter.key} label`, 100);
  if (parameter.help !== undefined) line(parameter.help, `${label} ${parameter.key} help`, 300);
  if (!ROLES.includes(parameter.role)) fail(`${label} ${parameter.key} needs a role (${ROLES.join(', ')}).`);
  const { type } = parameter;
  if (type === 'integer' || type === 'number') {
    if (!Number.isFinite(parameter.min) || !Number.isFinite(parameter.max) || parameter.min > parameter.max) {
      fail(`${label} ${parameter.key} needs a finite min <= max.`);
    }
    if (type === 'integer' && (!Number.isSafeInteger(parameter.min) || !Number.isSafeInteger(parameter.max))) {
      fail(`${label} ${parameter.key} bounds must be integers.`);
    }
  } else if (type === 'choice') {
    if (!Array.isArray(parameter.options) || parameter.options.length < 1 || parameter.options.length > 40
        || new Set(parameter.options).size !== parameter.options.length
        || !parameter.options.every((option) => typeof option === 'string' && /^[A-Za-z0-9._ -]{1,60}$/.test(option))) {
      fail(`${label} ${parameter.key} needs 1-40 distinct simple options.`);
    }
  } else if (type === 'text') {
    if (!Object.hasOwn(TEXT_PATTERNS, parameter.pattern)) fail(`${label} ${parameter.key} text needs a known pattern.`);
    // Lists of genes or labels define the scientific question: a person fixes them.
    if (parameter.role !== 'design') fail(`${label} ${parameter.key} text parameters must have the design role.`);
    if (!Number.isSafeInteger(parameter.maxLength) || parameter.maxLength < 1 || parameter.maxLength > 2000) {
      fail(`${label} ${parameter.key} needs maxLength 1-2000.`);
    }
  } else if (type !== 'boolean') {
    fail(`${label} ${parameter.key} has unsupported type ${type}.`);
  }
  if (type !== 'text' && parameter.pattern !== undefined) fail(`${label} ${parameter.key}: only text has a pattern.`);
  checkValue(parameter, parameter.default);
}

// Shared with release planning: one value against one catalog parameter.
function checkValue(parameter, value) {
  const name = parameter.key;
  const bad = (why) => { throw new Error(`Parameter '${name}' ${why}.`); };
  switch (parameter.type) {
    case 'boolean': if (typeof value !== 'boolean') bad('must be a boolean'); return value;
    case 'choice': if (!parameter.options.includes(value)) bad(`must be one of: ${parameter.options.join(', ')}`); return value;
    case 'text':
      if (typeof value !== 'string' || value.length > parameter.maxLength) bad(`must be text of at most ${parameter.maxLength} characters`);
      // An empty default means "not used"; any other value must match its grammar.
      if (value !== '' && !TEXT_PATTERNS[parameter.pattern].test(value))
        bad(`must be a ${parameter.pattern} list in the documented format`);
      return value;
    default:
      if (typeof value !== 'number' || !Number.isFinite(value)) bad('must be a finite number');
      if (parameter.type === 'integer' && !Number.isInteger(value)) bad('must be an integer');
      if (value < parameter.min || value > parameter.max) bad(`must be between ${parameter.min} and ${parameter.max}`);
      return value;
  }
}

function validateMethod(method, catalog) {
  only(method, ['key', 'version', 'title', 'summary', 'category', 'modalities', 'entry', 'packages', 'provenance',
    'deviations', 'parameters', 'outputs', 'summaryOutput', 'metrics', 'resources', 'accepts', 'requires'], 'Method');
  if (!KEY.test(method.key || '')) fail('method key must be a lowercase identifier.');
  if (!VERSION.test(method.version || '')) fail(`${method.key} version must be major.minor.patch.`);
  line(method.title, `${method.key} title`, 100);
  line(method.summary, `${method.key} summary`, 500);
  if (!CATEGORIES.includes(method.category)) fail(`${method.key} category is unknown.`);
  if (!Array.isArray(method.modalities) || !method.modalities.length || !method.modalities.every((m) => MODALITIES.includes(m))) {
    fail(`${method.key} modalities must list ${MODALITIES.join('/')}.`);
  }
  if (!ENTRY.test(method.entry || '')) fail(`${method.key} entry must be methods/<name>.R.`);
  if (!Array.isArray(method.packages) || !method.packages.every((p) => typeof p === 'string' && /^[A-Za-z][A-Za-z0-9.]{1,40}$/.test(p))) {
    fail(`${method.key} packages must list R package names.`);
  }
  only(method.provenance, ['kind', 'title', 'url', 'upstream', 'citation', 'doi', 'reviewedAgainst'], `${method.key} provenance`);
  if (!['vignette', 'paper-repository', 'book'].includes(method.provenance.kind)) fail(`${method.key} provenance kind is unknown.`);
  for (const field of ['title', 'url', 'upstream', 'citation', 'reviewedAgainst'])
    line(method.provenance[field], `${method.key} provenance ${field}`, 300);
  if (!/^https:\/\/[A-Za-z0-9.-]+\//.test(method.provenance.url)) fail(`${method.key} provenance url must be https.`);
  if (method.provenance.doi !== undefined && !/^10\.\d{4,9}\/\S{1,200}$/.test(method.provenance.doi))
    fail(`${method.key} doi is malformed.`);
  if (!Array.isArray(method.deviations) || method.deviations.length > 20) fail(`${method.key} deviations must be a list.`);
  method.deviations.forEach((d, i) => line(d, `${method.key} deviation ${i}`, 400));
  if (!Array.isArray(method.parameters) || method.parameters.length > 24) fail(`${method.key} has too many parameters.`);
  method.parameters.forEach((p) => validateParameter(p, method.key));
  if (new Set(method.parameters.map((p) => p.key)).size !== method.parameters.length) fail(`${method.key} duplicate parameter keys.`);
  only(method.outputs, Object.keys(method.outputs || {}), `${method.key} outputs`);
  const outputs = Object.entries(method.outputs);
  if (outputs.length < 1 || outputs.length > 8) fail(`${method.key} needs 1-8 outputs.`);
  for (const [name, output] of outputs) {
    if (!KEY.test(name)) fail(`${method.key} output names must be lowercase identifiers.`);
    only(output, ['type', 'label'], `${method.key} output ${name}`);
    if (!OUTPUT_TYPES.includes(output.type)) fail(`${method.key} output ${name} type is unsupported.`);
    line(output.label, `${method.key} output ${name} label`, 100);
  }
  if (method.outputs[method.summaryOutput]?.type !== 'metrics') fail(`${method.key} summaryOutput must name a metrics output.`);
  if (method.outputs.analysis && method.outputs.analysis.type !== 'rds') fail(`${method.key} 'analysis' must be rds.`);
  // The summary metrics a method promises; studies may rank trials by them.
  if (!Array.isArray(method.metrics) || method.metrics.length < 1 || method.metrics.length > 30)
    fail(`${method.key} must list 1-30 metrics.`);
  for (const metric of method.metrics) {
    only(metric, ['key', 'label'], `${method.key} metric`);
    if (!METRIC.test(metric.key || '')) fail(`${method.key} metric keys must be [A-Za-z0-9_].`);
    line(metric.label, `${method.key} metric ${metric.key} label`, 80);
  }
  only(method.resources, ['cpus', 'memoryMiB', 'maxWallSeconds'], `${method.key} resources`);
  const r = method.resources;
  if (!Number.isSafeInteger(r.cpus) || r.cpus < 1 || r.cpus > 16 || !Number.isSafeInteger(r.memoryMiB) || r.memoryMiB < 512
      || r.memoryMiB > 131072 || !Number.isSafeInteger(r.maxWallSeconds) || r.maxWallSeconds < 60 || r.maxWallSeconds > 86400) {
    fail(`${method.key} resources are out of range.`);
  }
  if (!Array.isArray(method.accepts) || !method.accepts.length) fail(`${method.key} must accept at least one source.`);
  for (const source of method.accepts) {
    const ok =
      BASE_RELEASES.includes(source) ||
      (source.startsWith('trusted:') && catalog.methods.some(m => `trusted:${m.key}` === source && m.outputs.analysis));
    if (!ok) fail(`${method.key} accepts unknown source ${source}.`);
  }
  if (method.requires !== undefined) {
    if (
      !Array.isArray(method.requires) ||
      !method.requires.every(item => ['clusters', 'umap', 'spatial', 'multiSample'].includes(item))
    ) {
      fail(`${method.key} requires must list clusters/umap/spatial/multiSample.`);
    }
  }
  const file = path.join(LIBRARY_DIR, method.entry);
  if (!fs.existsSync(file)) fail(`${method.key} entry file is missing.`);
  const source = fs.readFileSync(file, 'utf8');
  if (Buffer.byteLength(source) > 30 * 1024) fail(`${method.key} source exceeds 30 KiB.`);
  for (const name of Object.keys(method.outputs)) {
    if (!source.includes(`write_output("${name}"`)) fail(`${method.key} never writes declared output ${name}.`);
  }
  // Methods must not reach the network, the shell, or evaluate text.
  const forbidden =
    /\b(system2?|shell|eval|parse|source|download\.file|url|curl|install\.packages|BiocManager|remotes|Sys\.setenv|file\.remove|unlink)\s*\(/;
  const hit = source.split('\n').find((text) => !text.trim().startsWith('#') && forbidden.test(text));
  if (hit) fail(`${method.key} uses a forbidden call: ${hit.trim().slice(0, 80)}`);
  return { ...method, source, sourceSha256: sha256(Buffer.from(source, 'utf8')) };
}

let cached = null;
function loadLibrary({ fresh = false } = {}) {
  if (cached && !fresh) return cached;
  const text = fs.readFileSync(CATALOG_PATH, 'utf8');
  const catalog = JSON.parse(text);
  only(catalog, ['format', 'schemaVersion', 'runtimeProfileId', 'methods'], 'Catalog');
  if (catalog.format !== 'traceomics-trusted-methods' || catalog.schemaVersion !== 1) fail('unsupported format.');
  if (!/^[a-z0-9][a-z0-9.-]{2,99}$/.test(catalog.runtimeProfileId || '')) fail('runtimeProfileId is invalid.');
  if (!Array.isArray(catalog.methods) || catalog.methods.length > 60) fail('methods must be a list of at most 60.');
  const methods = catalog.methods.map((method) => validateMethod(method, catalog));
  if (new Set(methods.map((m) => m.key)).size !== methods.length) fail('duplicate method keys.');
  cached = Object.freeze({ runtimeProfileId: catalog.runtimeProfileId, methods: Object.freeze(methods) });
  return cached;
}

function methodByKey(key) {
  return loadLibrary().methods.find((method) => method.key === key) || null;
}

// Release parameter schema (used by study validation and the approval UI).
function releaseParameterSchema(method) {
  const schema = {};
  for (const p of method.parameters) {
    const entry = { type: p.type === 'integer' ? 'int' : p.type === 'boolean' ? 'bool' : p.type === 'choice' ? 'enum' : p.type,
      default: p.default, role: p.role, label: p.label };
    if (p.type === 'integer' || p.type === 'number') Object.assign(entry, { min: p.min, max: p.max });
    if (p.type === 'choice') entry.values = p.options;
    if (p.type === 'text') Object.assign(entry, { pattern: p.pattern, maxLength: p.maxLength });
    schema[p.key] = entry;
  }
  return schema;
}

// Resolve values with defaults and wrap them with the exact method identity.
// The handler refuses to run if the identity no longer matches the code.
function resolveMethodParameters(method, input) {
  const raw = input === undefined || input === null ? {} : input;
  if (!plain(raw)) throw Object.assign(new Error('parameters must be a plain JSON object.'), { code: 'INVALID_PARAMETERS' });
  const byKey = new Map(method.parameters.map((p) => [p.key, p]));
  for (const key of Object.keys(raw)) {
    if (!byKey.has(key)) throw Object.assign(new Error(`Unknown parameter '${key.slice(0, 64)}'.`), { code: 'UNKNOWN_PARAMETER' });
  }
  const values = {};
  for (const p of method.parameters) {
    try {
      values[p.key] = checkValue(p, Object.hasOwn(raw, p.key) ? raw[p.key] : p.default);
    } catch (error) {
      throw Object.assign(error, { code: 'INVALID_PARAMETER' });
    }
  }
  return { method: method.key, methodVersion: method.version, methodSourceSha256: method.sourceSha256, values };
}

// The workflow-package step for one method. Used to build human packages and
// to compile the agent job's script with the very same wrapper (workflowRuntime.compileStep).
function methodStep(method, { id = method.key, label = method.title, from = 'input.analysis' } = {}) {
  return {
    id,
    label,
    entry: method.entry,
    inputs: { analysis: { from, type: 'rds' } },
    parameters: method.parameters.map((p) => {
      const out = { key: p.key, type: p.type, label: p.label, default: p.default };
      for (const field of ['min', 'max', 'options', 'maxLength']) if (p[field] !== undefined) out[field] = p[field];
      return out;
    }),
    outputs: Object.fromEntries(Object.entries(method.outputs).map(([name, o]) => [name, { type: o.type, label: o.label }])),
  };
}

function singleMethodPackage(method, runtimeProfileId = loadLibrary().runtimeProfileId) {
  return {
    format: 'traceomics-workflow',
    schemaVersion: 1,
    id: method.key,
    name: method.title,
    version: method.version,
    description: method.summary.slice(0, 500),
    runtime: { language: 'r', profileId: runtimeProfileId },
    files: { [method.entry]: method.source },
    steps: [methodStep(method, { id: 'run' })],
    tabs: [{ id: 'run', label: method.title.slice(0, 100), step: 'run', plots: [] }],
  };
}

module.exports = {
  JOB_TYPE,
  TEXT_PATTERNS,
  METRIC,
  loadLibrary,
  methodByKey,
  releaseParameterSchema,
  resolveMethodParameters,
  methodStep,
  singleMethodPackage,
  checkValue,
};
