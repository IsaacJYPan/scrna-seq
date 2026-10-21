export const WORKFLOW_SNAPSHOT_SCHEMA = 'traceomics.workflow-snapshot.v1';
export const WORKFLOW_RESTORATION_SCHEMA = 'traceomics.workflow-restoration.v1';
export const WORKFLOW_SNAPSHOT_LIMITS = Object.freeze({ sourceBytes: 3 * 1024 * 1024, stateBytes: 2 * 1024 * 1024, transientSnapshots: 40 });
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const hash = /^[a-f0-9]{64}$/;
const invalid = message => { throw Object.assign(new Error(message), { code: 'INVALID_WORKFLOW_RESTORATION', status: 400 }); };
function fields(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid('Use a plain saved-workflow request.');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !allowed.includes(key)
      || !descriptors[key].enumerable || !Object.hasOwn(descriptors[key], 'value'))) invalid('Saved-workflow request contains unsupported fields.');
}
function canonical(value, ancestors = new Set(), depth = 0, budget = { nodes: 0 }) {
  if (depth > 24 || ++budget.nodes > 100000) invalid('Captured workflow source is too complex for the supported preview.');
  if (value === null || ['string', 'boolean'].includes(typeof value) || typeof value === 'number' && Number.isFinite(value)) return value;
  if (!value || typeof value !== 'object' || ancestors.has(value)) invalid('Captured workflow source must contain ordinary JSON values.');
  ancestors.add(value);
  let result;
  if (Array.isArray(value)) result = value.map(item => canonical(item, ancestors, depth + 1, budget));
  else {
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid('Captured workflow source must contain ordinary JSON objects.');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !descriptors[key].enumerable || !Object.hasOwn(descriptors[key], 'value'))) invalid('Captured workflow source contains unsupported fields.');
    result = Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(descriptors[key].value, ancestors, depth + 1, budget)]));
  }
  ancestors.delete(value);
  return result;
}
export function canonicalRetainedWorkflowSnapshot(value) {
  const text = JSON.stringify(canonical({ schema: WORKFLOW_SNAPSHOT_SCHEMA, projectId: value.projectId,
    ownerUserId: value.ownerUserId, analysisObjectId: value.analysisObjectId,
    packageDigest: value.packageDigest, package: value.package, state: value.state }));
  if (new TextEncoder().encode(text).length > WORKFLOW_SNAPSHOT_LIMITS.sourceBytes) invalid('Captured workflow source exceeds its supported preview size.');
  return text;
}
export function normalizeWorkflowSnapshotOpen(input) {
  fields(input, ['requestId', 'sha256', 'expectedInstance', 'replace']);
  if (typeof input.requestId !== 'string' || !uuid.test(input.requestId)) invalid('An original request UUID is required to safely reopen this saved workflow.');
  if (typeof input.sha256 !== 'string' || !hash.test(input.sha256)) invalid('Choose the exact saved workflow checksum.');
  if (typeof input.replace !== 'boolean') invalid('Choose whether to replace the identified working workflow.');
  let expectedInstance = null;
  if (input.expectedInstance !== null) {
    fields(input.expectedInstance, ['id', 'generation']);
    if (typeof input.expectedInstance.id !== 'string' || !/^wfi_[a-f0-9]{24}$/.test(input.expectedInstance.id)
        || !Number.isSafeInteger(input.expectedInstance.generation) || input.expectedInstance.generation < 0
        || input.expectedInstance.generation >= 2147483647) invalid('Identify the exact working workflow and generation before replacing it.');
    expectedInstance = { id: input.expectedInstance.id, generation: input.expectedInstance.generation };
  }
  if (expectedInstance === null && input.replace) invalid('Only an identified existing workflow can be replaced.');
  return { requestId: input.requestId.toLowerCase(), sha256: input.sha256, expectedInstance, replace: input.replace };
}
