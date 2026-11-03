// Pure public-example contract. No account, storage, transport or runtime.
export const PUBLIC_SAVED_EXAMPLE_SCHEMA = 'traceomics.public-saved-example.v1';
export const PUBLIC_SAVED_EXAMPLE_VIEW_SCHEMA = 'traceomics.public-example-view.v1';
export const PUBLIC_SAVED_EXAMPLE_LIMITS = Object.freeze({ manifestBytes: 16384, sourceBytes: 4096, tableBytes: 16384,
  imageBytes: 262144, imageWidth: 1200, imageHeight: 800, imagePixels: 960000 });
const source = Object.freeze({ file: 'counts.csv', mediaType: 'text/csv', bytes: 87, sha256: '9a99e0f8ad73055902fcb3ef9c75d46cf51a70cde206ee6b17488b4bd61e8285' });
const table = Object.freeze({ file: 'table.json', mediaType: 'application/json', bytes: 215, sha256: '165e08989a9718386abb179b48e1496bd001c32be0a7d407cba658010dfbdd89' });
const image = Object.freeze({ file: 'figure.png', mediaType: 'image/png', bytes: 44517, sha256: 'be4e96cc6f4b422c9d2650d0fdc1a2293c913df6ccde8325ed9c3316801d0fd6' });
export const PUBLIC_QC_RETENTION_V1 = Object.freeze({ id: 'qc-retention', version: 1, route: '#/examples/qc-retention/v1', visibility: 'public',
  assetBase: 'examples/qc-retention/v1/', manifest: Object.freeze({ file: 'manifest.json', mediaType: 'application/json', bytes: 1967,
    sha256: 'b4eebe8ce2ebcb266891206a9a2db5777cedc7724f798994434cab7dc1b6d1da' }), assets: Object.freeze([source, table, image]) });
const findingIds = ['retention-table', 'retention-figure'];
const viewHashes = ['c0298750b4dcca26e07b3cefd5d86e60c901596f7907574193992822281f0f36', '4c007ca7b699c48493ea7fc02c8eb6e34ce982595421c8c80ef58a3d0fd01440'];
const counts = [['Sample A', 1000, 850], ['Sample B', 1200, 900], ['Sample C', 800, 720]];
const sourceText = 'sample,input_cells,retained_cells\nSample A,1000,850\nSample B,1200,900\nSample C,800,720\n';
const invalid = () => { throw Object.assign(new Error('The public saved example could not be verified.'), { code: 'INVALID_PUBLIC_SAVED_EXAMPLE' }); };

function record(input, keys) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(input), actual = Reflect.ownKeys(descriptors);
  if (actual.length !== keys.length || actual.some(key => typeof key !== 'string' || !keys.includes(key))
    || keys.some(key => !descriptors[key]?.enumerable || !Object.hasOwn(descriptors[key], 'value'))) invalid();
  return Object.fromEntries(keys.map(key => [key, descriptors[key].value]));
}
function array(input, length) {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (descriptors.length?.value !== length || Reflect.ownKeys(descriptors).length !== length + 1) invalid();
  return Array.from({ length }, (_, index) => {
    if (!descriptors[index]?.enumerable || !Object.hasOwn(descriptors[index], 'value')) invalid();
    return descriptors[index].value;
  });
}
function text(value, maximum) {
  if (typeof value !== 'string' || !value || value.length > maximum || value !== value.trim()
    || !value.isWellFormed() || /[\p{Cc}\p{Cf}]/u.test(value)) invalid();
  return value;
}
function literal(value, expected) { if (value !== expected) invalid(); return value; }
function asset(input, expected) {
  const value = record(input, ['file', 'mediaType', 'bytes', 'sha256']);
  for (const key of Object.keys(expected)) literal(value[key], expected[key]);
  return value;
}
function finding(input, index) {
  const isImage = index === 1;
  const value = record(input, ['id', 'family', 'caption', 'sourceSha256', 'asset', 'viewSha256', ...(isImage ? ['width', 'height'] : [])]);
  literal(value.id, findingIds[index]); literal(value.family, isImage ? 'image' : 'table');
  text(value.caption, 1000); literal(value.sourceSha256, source.sha256);
  literal(value.viewSha256, viewHashes[index]);
  if (isImage) { literal(value.width, 960); literal(value.height, 600); }
  return { ...value, asset: asset(value.asset, isImage ? image : table) };
}
function sorted(value) {
  if (Array.isArray(value)) return `[${value.map(sorted).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${sorted(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function normalizePublicSavedExampleManifest(input) {
  const value = record(input, ['schema', 'id', 'version', 'visibility', 'title', 'question', 'provenance', 'method', 'limitations', 'source', 'findings']);
  literal(value.schema, PUBLIC_SAVED_EXAMPLE_SCHEMA); literal(value.id, 'qc-retention'); literal(value.version, 1); literal(value.visibility, 'public');
  text(value.title, 200); text(value.question, 1000); text(value.limitations, 2000);
  const provenance = record(value.provenance, ['kind', 'synthetic', 'license', 'notice']);
  literal(provenance.kind, 'authored-illustration'); literal(provenance.synthetic, true); literal(provenance.license, 'CC0-1.0'); text(provenance.notice, 1000);
  const method = record(value.method, ['label', 'description']); text(method.label, 200); text(method.description, 2000);
  const result = { ...value, provenance, method, source: asset(value.source, source), findings: array(value.findings, 2).map(finding) };
  if (new TextEncoder().encode(sorted(result)).byteLength > PUBLIC_SAVED_EXAMPLE_LIMITS.manifestBytes) invalid();
  return result;
}
export function canonicalPublicSavedExampleManifest(input) { return sorted(normalizePublicSavedExampleManifest(input)); }
export function publicSavedExampleFinding(input, findingId) {
  const value = normalizePublicSavedExampleManifest(input);
  if (typeof findingId !== 'string' || !findingIds.includes(findingId)) invalid();
  return value.findings[findingIds.indexOf(findingId)];
}
export function canonicalPublicSavedExampleView(input, findingId) {
  const value = publicSavedExampleFinding(input, findingId), isImage = value.family === 'image';
  return sorted({ schema: PUBLIC_SAVED_EXAMPLE_VIEW_SCHEMA, exampleId: 'qc-retention', version: 1, findingId,
    family: value.family, sourceSha256: value.sourceSha256, representation: isImage ? 'png-raster' : 'fixed-table',
    spec: isImage ? null : { offset: 0, limit: 3 }, blobSha256: value.asset.sha256, blobBytes: value.asset.bytes,
    width: isImage ? value.width : null, height: isImage ? value.height : null });
}
export function normalizePublicSavedExampleTable(input) {
  const value = record(input, ['family', 'columns', 'rows', 'offset', 'limit', 'hasMore', 'scannedRows', 'truncated']);
  literal(value.family, 'table'); literal(value.offset, 0); literal(value.limit, 3); literal(value.hasMore, false); literal(value.scannedRows, 3); literal(value.truncated, false);
  const columns = array(value.columns, 3), rows = array(value.rows, 3).map(row => array(row, 3));
  ['Sample', 'Input cells', 'Retained cells'].forEach((column, index) => literal(columns[index], column));
  counts.forEach((expected, index) => expected.forEach((cell, column) => literal(rows[index][column], cell)));
  return { ...value, columns, rows };
}
export function normalizePublicSavedExampleSource(input) { return literal(input, sourceText); }

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedArrayName = Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag).get;
const typedArrayLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength').get;
export function normalizePublicSavedExamplePng(input, expectedFinding) {
  finding(expectedFinding, 1);
  if (!ArrayBuffer.isView(input) || typedArrayName.call(input) !== 'Uint8Array' || typedArrayLength.call(input) !== image.bytes) invalid();
  const value = new Uint8Array(image.bytes); Uint8Array.prototype.set.call(value, input);
  if ([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82].some((byte, index) => value[index] !== byte)) invalid();
  const header = new DataView(value.buffer), width = header.getUint32(16), height = header.getUint32(20);
  if (width !== 960 || height !== 600 || width > PUBLIC_SAVED_EXAMPLE_LIMITS.imageWidth || height > PUBLIC_SAVED_EXAMPLE_LIMITS.imageHeight
    || width * height > PUBLIC_SAVED_EXAMPLE_LIMITS.imagePixels || value[24] !== 8 || value[25] !== 6 || value[26] || value[27] || value[28]) invalid();
  if ([0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130].some((byte, index) => value[value.length - 12 + index] !== byte)) invalid();
  return { family: 'image', width, height };
}
