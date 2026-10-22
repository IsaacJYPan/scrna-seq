export const SERVER_DATA_IMPORT_ROOT_ID = /^[a-z][a-z0-9-]{0,63}$/;
export const SERVER_DATA_IMPORT_REQUEST_LIMITS = Object.freeze({ name: 160, sampleMetadata: 120, path: 1024, pathSegments: 32, pathSegment: 240 });
const REQUEST_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const VERSION = /^(?:av|art|eri)_[a-f0-9]{16,40}$/;
const requestFields = ['requestId', 'rootId', 'relativePath', 'selectionToken', 'name', 'artifactType', 'previousVersionId', 'sampleMetadata'];
const sampleFields = ['sampleId', 'condition', 'tissue', 'species', 'replicate'];
const forbiddenSegments = new Set(['node_modules', 'vault', 'sessions', 'credentials']);
const failure = (code, message) => Object.assign(new Error(message), { code, status: 400 });
const invalidRequest = () => failure('SERVER_IMPORT_REQUEST_INVALID', 'Select an authorized server file with its current selection token and a request ID.');
const invalidPath = message => failure('SERVER_IMPORT_PATH_INVALID', message);
const invalidMetadata = () => failure('SERVER_IMPORT_METADATA_INVALID', 'Sample annotations accept sample ID, condition, tissue, species, and replicate as short single-line values.');
const controls = value => [...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
const line = (value, maximum) => typeof value === 'string' && value.trim().length > 0 && value.length <= maximum && !controls(value);
function fields(value, allowed, invalid) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw invalid();
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !allowed.includes(key) || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw invalid();
  }
}

// This is the platform-independent relative-path rule used by granted server
// browsing. It never resolves a host path or confers a source grant.
export function normalizeServerDataImportPath(raw, { directory = false } = {}) {
  if (directory && (raw === '' || raw === undefined)) return '';
  if (typeof raw !== 'string' || !raw || raw.length > SERVER_DATA_IMPORT_REQUEST_LIMITS.path
      || raw.includes('\\') || raw.includes('%') || controls(raw) || raw.includes(':') || raw.startsWith('/')) {
    throw invalidPath('Select a relative file or directory inside an authorized data root.');
  }
  const segments = raw.split('/');
  if (segments.length > SERVER_DATA_IMPORT_REQUEST_LIMITS.pathSegments || segments.some(segment => !segment || segment === '..' || segment.startsWith('.')
      || segment.length > SERVER_DATA_IMPORT_REQUEST_LIMITS.pathSegment || segment.endsWith('.') || segment.endsWith(' ')
      || forbiddenSegments.has(segment.toLowerCase()) || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(segment))) {
    throw invalidPath('Hidden, private, and unsafe paths cannot be imported.');
  }
  return raw;
}

// Preserve the existing request's exact canonical order and defaults. Its hash
// includes the selection token and UUID; scope is retained separately by the
// server operation. In particular, supplied {} sample metadata stays present.
export function normalizeServerDataImportRequest(input) {
  fields(input, requestFields, invalidRequest);
  if (typeof input.requestId !== 'string' || !REQUEST_ID.test(input.requestId)
      || typeof input.rootId !== 'string' || !SERVER_DATA_IMPORT_ROOT_ID.test(input.rootId)
      || typeof input.selectionToken !== 'string' || !HASH.test(input.selectionToken)) throw invalidRequest();
  const relativePath = normalizeServerDataImportPath(input.relativePath);
  const name = input.name ?? relativePath.split('/').at(-1);
  if (!line(name, SERVER_DATA_IMPORT_REQUEST_LIMITS.name)) throw failure('INVALID_ARTIFACT_NAME', 'Artifact name must contain 1–160 characters on one line.');
  const artifactType = input.artifactType || 'auto';
  if (!['auto', 'sample-sheet'].includes(artifactType) || input.previousVersionId != null
      && (typeof input.previousVersionId !== 'string' || !VERSION.test(input.previousVersionId))) {
    throw failure('SERVER_IMPORT_REQUEST_INVALID', 'Select a supported artifact type and an exact previous version.');
  }
  let sampleMetadata;
  if (input.sampleMetadata !== undefined) {
    fields(input.sampleMetadata, sampleFields, invalidMetadata);
    if (Object.values(input.sampleMetadata).some(value => !line(value, SERVER_DATA_IMPORT_REQUEST_LIMITS.sampleMetadata))) throw invalidMetadata();
    sampleMetadata = Object.fromEntries(Object.entries(input.sampleMetadata).sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => [key, value.trim()]));
  }
  return { requestId: input.requestId.toLowerCase(), rootId: input.rootId, relativePath, selectionToken: input.selectionToken,
    name: name.trim(), artifactType, previousVersionId: input.previousVersionId || null, ...(sampleMetadata ? { sampleMetadata } : {}) };
}
export const canonicalServerDataImportRequest = input => JSON.stringify(normalizeServerDataImportRequest(input));
