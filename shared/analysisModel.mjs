export const ANALYSIS_MODEL_VERSION = 1;
export const ANALYSIS_LIMITS = Object.freeze({ ports: 32, collectionItems: 10000, metadataBytes: 65536 });

const encoder = new TextEncoder();
const reserved = new Set(['__proto__', 'prototype', 'constructor']);
const own = (value, key) => Object.hasOwn(value, key);

export class AnalysisContractError extends Error {
  constructor(path, message) {
    super(`${path}: ${message}`);
    this.name = 'AnalysisContractError';
    this.path = path;
  }
}

export function contractError(path, message) { throw new AnalysisContractError(path, message); }
export function contractRecord(value, fields, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) contractError(path, 'must be an object.');
  for (const key of Object.keys(value)) {
    if (reserved.has(key) || (fields && !fields.includes(key))) contractError(path, `unknown or reserved field ${key}.`);
  }
  return value;
}
export function contractText(value, path, maximum = 120) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum
      || [...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) contractError(path, `must contain 1–${maximum} characters on one line.`);
  return value;
}
export function contractId(value, path) {
  contractText(value, path);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(value) || reserved.has(value)) contractError(path, 'must be a stable identifier.');
  return value;
}
export function contractPortId(value, path) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(value) || reserved.has(value)) contractError(path, 'must be a lowercase port identifier.');
  return value;
}
export function contractList(value, path, maximum, minimum = 0) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) contractError(path, `must contain ${minimum}–${maximum} entries.`);
  return value;
}
export function contractUnique(values, path) {
  if (new Set(values).size !== values.length) contractError(path, 'contains duplicate identifiers.');
}
export function contractInteger(value, path, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) contractError(path, `must be an integer between ${minimum} and ${maximum}.`);
  return value;
}
export function contractJSON(value, path, maximum = ANALYSIS_LIMITS.metadataBytes) {
  function visit(item, depth) {
    if (depth > 24) contractError(path, 'is nested too deeply.');
    if (item === null || ['string', 'boolean'].includes(typeof item)) return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (Array.isArray(item)) { item.forEach(entry => visit(entry, depth + 1)); return; }
    contractRecord(item, null, path);
    Object.values(item).forEach(entry => visit(entry, depth + 1));
  }
  visit(value, 0);
  if (encoder.encode(JSON.stringify(value)).length > maximum) contractError(path, `exceeds ${maximum} bytes.`);
  return JSON.parse(JSON.stringify(value));
}
export function contractDigest(value, path) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) contractError(path, 'requires a lowercase SHA-256 digest.');
  return value;
}

export function validateArtifactFormat(value, path = 'Format') {
  contractRecord(value, ['id', 'version', 'metadata'], path);
  if (typeof value.id !== 'string' || value.id.length > 120 || !/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/.test(value.id)) contractError(`${path}.id`, 'requires a namespaced format identifier, such as org.seurat.object.');
  contractText(value.version, `${path}.version`, 80);
  if (own(value, 'metadata')) {
    contractRecord(value.metadata, null, `${path}.metadata`);
    for (const key of Object.keys(value.metadata)) {
      if (!/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+:[a-z][a-z0-9._-]{0,79}$/.test(key)) contractError(`${path}.metadata.${key}`, 'metadata keys must be namespaced, such as org.seurat:assay.');
    }
    contractJSON(value.metadata, `${path}.metadata`);
  }
  return contractJSON(value, path);
}

export function validateArtifactPort(value, path = 'Port') {
  contractRecord(value, ['type', 'format', 'label', 'cardinality', 'optional', 'minItems', 'maxItems'], path);
  contractPortId(value.type, `${path}.type`);
  if (own(value, 'label')) contractText(value.label, `${path}.label`);
  if (own(value, 'format')) validateArtifactFormat(value.format, `${path}.format`);
  if (!['one', 'collection'].includes(value.cardinality)) contractError(`${path}.cardinality`, 'must be one or collection.');
  if (own(value, 'optional') && typeof value.optional !== 'boolean') contractError(`${path}.optional`, 'must be true or false.');
  if (value.cardinality === 'collection') {
    contractInteger(value.minItems ?? (value.optional ? 0 : 1), `${path}.minItems`, 0, ANALYSIS_LIMITS.collectionItems);
    contractInteger(value.maxItems, `${path}.maxItems`, 1, ANALYSIS_LIMITS.collectionItems);
    if ((value.minItems ?? (value.optional ? 0 : 1)) > value.maxItems) contractError(path, 'collection minimum exceeds maximum.');
  } else if (own(value, 'minItems') || own(value, 'maxItems')) contractError(path, 'only collections accept item bounds.');
  return contractJSON(value, path);
}

export function validateArtifactPorts(value, path = 'Ports') {
  contractRecord(value, null, path);
  if (Object.keys(value).length > ANALYSIS_LIMITS.ports) contractError(path, `exceeds ${ANALYSIS_LIMITS.ports} ports.`);
  for (const [id, port] of Object.entries(value)) {
    contractPortId(id, `${path}.${id}`);
    validateArtifactPort(port, `${path}.${id}`);
  }
  return contractJSON(value, path);
}

export function artifactPortsCompatible(producer, consumer) {
  if (producer.type !== consumer.type || producer.cardinality !== consumer.cardinality) return false;
  if (consumer.format && (!producer.format || producer.format.id !== consumer.format.id || producer.format.version !== consumer.format.version)) return false;
  if (producer.optional && !consumer.optional) return false;
  if (producer.cardinality === 'collection') {
    const minimum = port => port.minItems ?? (port.optional ? 0 : 1);
    if (minimum(producer) < minimum(consumer) || producer.maxItems > consumer.maxItems) return false;
  }
  return true;
}

export function validateVersionReference(value, path = 'Version reference') {
  contractRecord(value, ['id', 'version', 'digest'], path);
  contractId(value.id, `${path}.id`);
  contractText(value.version, `${path}.version`, 80);
  contractDigest(value.digest, `${path}.digest`);
  return contractJSON(value, path);
}

export function validateArtifactReference(value, path = 'Artifact reference') {
  contractRecord(value, ['artifactId', 'versionId', 'projectId', 'sha256'], path);
  for (const field of ['artifactId', 'versionId', 'projectId']) contractId(value[field], `${path}.${field}`);
  contractDigest(value.sha256, `${path}.sha256`);
  return contractJSON(value, path);
}

export function validateArtifactVersion(value) {
  const path = 'Artifact version';
  contractRecord(value, ['kind', 'schemaVersion', 'artifactId', 'versionId', 'projectId', 'ownerId', 'type', 'format', 'sha256', 'sizeBytes', 'storageRef', 'sourceRunId', 'createdAt', 'previews'], path);
  if (value.kind !== 'artifact-version' || value.schemaVersion !== ANALYSIS_MODEL_VERSION) contractError(path, 'unsupported artifact record version.');
  validateArtifactReference({ artifactId: value.artifactId, versionId: value.versionId, projectId: value.projectId, sha256: value.sha256 });
  contractId(value.ownerId, `${path}.ownerId`);
  contractPortId(value.type, `${path}.type`);
  validateArtifactFormat(value.format, `${path}.format`);
  contractInteger(value.sizeBytes, `${path}.sizeBytes`);
  // Storage identities are opaque references; public records do not carry host paths or signed URLs.
  contractId(value.storageRef, `${path}.storageRef`);
  if (value.sourceRunId !== null) contractId(value.sourceRunId, `${path}.sourceRunId`);
  timestamp(value.createdAt, `${path}.createdAt`);
  contractList(value.previews, `${path}.previews`, 16).forEach(preview => contractPortId(preview, `${path}.previews`));
  contractUnique(value.previews, `${path}.previews`);
  return contractJSON(value, path);
}

function timestamp(value, path) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) contractError(path, 'requires a UTC ISO timestamp.');
}

export function validateOperationVersion(value) {
  const path = 'Operation version';
  contractRecord(value, ['kind', 'schemaVersion', 'id', 'version', 'digest', 'method', 'inputs', 'outputs', 'parameters', 'environment', 'originRunId'], path);
  if (value.kind !== 'operation-version' || value.schemaVersion !== ANALYSIS_MODEL_VERSION) contractError(path, 'unsupported operation record version.');
  validateVersionReference({ id: value.id, version: value.version, digest: value.digest }, path);
  validateOperationMethod(value.method, `${path}.method`);
  validateArtifactPorts(value.inputs, `${path}.inputs`);
  validateArtifactPorts(value.outputs, `${path}.outputs`);
  contractJSON(value.parameters, `${path}.parameters`);
  if (value.environment !== null) validateVersionReference(value.environment, `${path}.environment`);
  if (value.method.kind !== 'human' && value.environment === null) contractError(`${path}.environment`, 'computational operations require an environment version.');
  if (own(value, 'originRunId')) contractId(value.originRunId, `${path}.originRunId`);
  return contractJSON(value, path);
}

export function validateSourcePath(value, path) {
  contractText(value, path, 160);
  if (!/^(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)+$/.test(value)
      || value.split('/').some(part => reserved.has(part))) contractError(path, 'requires a relative package file without traversal.');
  return value;
}

export function validateOperationMethod(value, path = 'Operation') {
  const fields = { r: ['kind', 'entry', 'helpers', 'state'], human: ['kind', 'action', 'instructions'], tool: ['kind', 'adapter', 'entry', 'helpers', 'arguments'] };
  if (!value || !own(fields, value.kind)) contractError(path, 'kind must be r, human, or tool.');
  contractRecord(value, fields[value.kind], path);
  if (value.kind === 'human') {
    contractPortId(value.action, `${path}.action`);
    contractText(value.instructions, `${path}.instructions`, 2000);
  } else {
    validateSourcePath(value.entry, `${path}.entry`);
    const helpers = contractList(value.helpers ?? [], `${path}.helpers`, 64);
    helpers.forEach(file => validateSourcePath(file, `${path}.helpers`));
    contractUnique([value.entry, ...helpers], `${path}.source files`);
    if (value.kind === 'r') {
      if (!value.entry.endsWith('.R') || helpers.some(file => !file.endsWith('.R'))) contractError(path, 'R entry and helpers must be .R files.');
      if (!['isolated', 'kernel'].includes(value.state)) contractError(`${path}.state`, 'must be isolated or kernel.');
    } else {
      contractId(value.adapter, `${path}.adapter`);
      contractList(value.arguments, `${path}.arguments`, 64).forEach(argument => contractText(argument, `${path}.arguments`, 2000));
    }
  }
  return contractJSON(value, path);
}

export function validateEnvironmentReference(value, path = 'Environment') {
  contractRecord(value, ['profileId', 'version', 'digest', 'runtime', 'lockfile', 'imageDigest'], path);
  contractId(value.profileId, `${path}.profileId`);
  if (own(value, 'version')) contractText(value.version, `${path}.version`, 80);
  if (own(value, 'digest')) contractDigest(value.digest, `${path}.digest`);
  contractRecord(value.runtime, ['language', 'version'], `${path}.runtime`);
  contractPortId(value.runtime.language, `${path}.runtime.language`);
  if (own(value.runtime, 'version')) contractText(value.runtime.version, `${path}.runtime.version`, 80);
  if (own(value, 'lockfile')) validateSourcePath(value.lockfile, `${path}.lockfile`);
  if (own(value, 'imageDigest') && !/^sha256:[a-f0-9]{64}$/.test(value.imageDigest)) contractError(`${path}.imageDigest`, 'requires an immutable sha256 image digest.');
  return contractJSON(value, path);
}

export function validateAnalysisRun(value) {
  const path = 'Run';
  contractRecord(value, ['kind', 'schemaVersion', 'id', 'projectId', 'ownerId', 'operation', 'recipe', 'inputs', 'parameters', 'design', 'environment', 'target', 'seed', 'status', 'startedAt', 'finishedAt', 'outputs', 'kernel', 'replay'], path);
  if (value.kind !== 'run' || value.schemaVersion !== ANALYSIS_MODEL_VERSION) contractError(path, 'unsupported run record version.');
  for (const field of ['id', 'projectId', 'ownerId']) contractId(value[field], `${path}.${field}`);
  validateVersionReference(value.operation, `${path}.operation`);
  if (value.recipe !== null) validateVersionReference(value.recipe, `${path}.recipe`);
  for (const field of ['inputs', 'outputs']) {
    contractRecord(value[field], null, `${path}.${field}`);
    if (Object.keys(value[field]).length > ANALYSIS_LIMITS.ports) contractError(`${path}.${field}`, 'too many ports.');
    for (const [port, reference] of Object.entries(value[field])) {
      contractPortId(port, `${path}.${field}.${port}`);
      const references = Array.isArray(reference) ? contractList(reference, `${path}.${field}.${port}`, ANALYSIS_LIMITS.collectionItems) : [reference];
      references.forEach(item => {
        validateArtifactReference(item, `${path}.${field}.${port}`);
        if (item.projectId !== value.projectId) contractError(`${path}.${field}.${port}`, 'artifact belongs to another project.');
      });
      contractUnique(references.map(item => item.versionId), `${path}.${field}.${port}`);
    }
  }
  contractJSON(value.parameters, `${path}.parameters`);
  if (value.design !== null) {
    validateArtifactReference(value.design, `${path}.design`);
    if (value.design.projectId !== value.projectId) contractError(`${path}.design`, 'artifact belongs to another project.');
  }
  if (value.environment !== null) validateVersionReference(value.environment, `${path}.environment`);
  contractRecord(value.target, ['id', 'kind'], `${path}.target`);
  contractId(value.target.id, `${path}.target.id`);
  if (!['local', 'remote', 'scheduler', 'human'].includes(value.target.kind)) contractError(`${path}.target.kind`, 'unsupported execution target.');
  if (value.target.kind !== 'human' && value.environment === null) contractError(`${path}.environment`, 'computational runs require an exact environment version.');
  if (value.seed !== null) contractInteger(value.seed, `${path}.seed`, 0, 2147483647);
  if (!['queued', 'running', 'succeeded', 'failed', 'canceled', 'interrupted'].includes(value.status)) contractError(`${path}.status`, 'unsupported run status.');
  if (value.startedAt !== null) timestamp(value.startedAt, `${path}.startedAt`);
  if (value.finishedAt !== null) timestamp(value.finishedAt, `${path}.finishedAt`);
  const terminal = ['succeeded', 'failed', 'canceled', 'interrupted'].includes(value.status);
  if (terminal !== (value.finishedAt !== null)) contractError(`${path}.finishedAt`, 'must be present exactly for completed runs.');
  if (['running', 'succeeded'].includes(value.status) && value.startedAt === null) contractError(`${path}.startedAt`, 'must be present for running or successful runs.');
  if (value.status === 'queued' && value.startedAt !== null) contractError(`${path}.startedAt`, 'queued runs have not started.');
  if (value.startedAt && value.finishedAt && Date.parse(value.finishedAt) < Date.parse(value.startedAt)) contractError(path, 'completion precedes start.');
  if (value.status !== 'succeeded' && Object.keys(value.outputs).length) contractError(`${path}.outputs`, 'only successful runs can publish durable outputs.');
  if (value.kernel !== null) {
    contractRecord(value.kernel, ['id', 'generation', 'order'], `${path}.kernel`);
    contractId(value.kernel.id, `${path}.kernel.id`);
    contractInteger(value.kernel.generation, `${path}.kernel.generation`, 1);
    contractInteger(value.kernel.order, `${path}.kernel.order`, 1);
  }
  contractRecord(value.replay, ['complete', 'issues'], `${path}.replay`);
  if (typeof value.replay.complete !== 'boolean') contractError(`${path}.replay.complete`, 'must be true or false.');
  contractList(value.replay.issues, `${path}.replay.issues`, 32).forEach(issue => contractText(issue, `${path}.replay.issues`, 500));
  if (value.replay.complete && value.replay.issues.length) contractError(`${path}.replay`, 'complete replay cannot have missing requirements.');
  return contractJSON(value, path, 1024 * 1024);
}
