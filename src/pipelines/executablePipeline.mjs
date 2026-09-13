export const MAX_PIPELINE_FILE_BYTES = 48 * 1024;
export const MAX_INSTALLED_PIPELINES = 20;
const MAX_RUN_SCRIPT_BYTES = 32 * 1024;
const FIELDS = new Set([
  'format',
  'schemaVersion',
  'id',
  'name',
  'version',
  'description',
  'runtime',
  'script',
]);
const bytes = (value) => new TextEncoder().encode(value).byteLength;

function text(value, field, limit, optional = false) {
  if (optional && value === undefined) return '';
  if (
    typeof value !== 'string' ||
    (!optional && !value.trim()) ||
    value.length > limit ||
    Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  ) {
    throw new Error(
      `Pipeline ${field} must be ${optional ? 'at most ' : '1–'}${limit} characters on one line.`
    );
  }
  return value.trim();
}

export function pipelineRunScript(pipeline) {
  return `# Pipeline: ${pipeline.id}@${pipeline.version}\n${pipeline.script}`;
}

export function validateExecutablePipeline(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !FIELDS.has(key))
  ) {
    throw new Error('This file is not a supported pipeline package.');
  }
  if (value.format !== 'traceomics-pipeline' || value.schemaVersion !== 1) {
    throw new Error('Expected a TraceOmics pipeline package with schema version 1.');
  }
  if (!/^[a-z][a-z0-9-]{2,63}$/.test(value.id || ''))
    throw new Error('Pipeline ID must use lowercase letters, numbers, and hyphens.');
  if (
    typeof value.version !== 'string' ||
    !/^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/.test(value.version)
  ) {
    throw new Error('Pipeline version must use major.minor.patch, for example 1.0.0.');
  }
  if (
    !value.runtime ||
    typeof value.runtime !== 'object' ||
    Array.isArray(value.runtime) ||
    Object.keys(value.runtime).some((key) => !['language', 'profileId'].includes(key)) ||
    value.runtime.language !== 'r' ||
    typeof value.runtime.profileId !== 'string' ||
    !/^[a-z0-9][a-z0-9.-]{2,99}$/.test(value.runtime.profileId)
  ) {
    throw new Error('Pipeline runtime must name an R package profile.');
  }
  if (typeof value.script !== 'string' || !value.script.trim() || value.script.includes('\0')) {
    throw new Error('Pipeline must contain an R script.');
  }
  const pipeline = {
    format: 'traceomics-pipeline',
    schemaVersion: 1,
    id: value.id,
    name: text(value.name, 'name', 100),
    version: value.version,
    description: text(value.description, 'description', 500, true),
    runtime: { language: 'r', profileId: value.runtime.profileId },
    script: value.script,
  };
  if (bytes(pipelineRunScript(pipeline)) > MAX_RUN_SCRIPT_BYTES)
    throw new Error('Pipeline script exceeds the 32 KiB run limit.');
  if (bytes(JSON.stringify(pipeline)) > MAX_PIPELINE_FILE_BYTES)
    throw new Error('Pipeline file exceeds 48 KiB.');
  return pipeline;
}

export function parseExecutablePipeline(source) {
  if (typeof source !== 'string' || bytes(source) > MAX_PIPELINE_FILE_BYTES)
    throw new Error('Pipeline file exceeds 48 KiB.');
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error('Pipeline file must contain valid JSON.');
  }
  return validateExecutablePipeline(value);
}

export function installPipeline(current, incoming) {
  const pipeline = validateExecutablePipeline(incoming);
  const existing = current.find(
    (item) => item.id === pipeline.id && item.version === pipeline.version
  );
  if (existing) {
    if (JSON.stringify(existing) !== JSON.stringify(pipeline)) {
      throw new Error(
        'This version is already installed with different contents. Ask the author to publish a new version.'
      );
    }
    return current;
  }
  if (current.length >= MAX_INSTALLED_PIPELINES)
    throw new Error('Remove an installed version before adding more than 20 pipelines.');
  return [...current, pipeline];
}
