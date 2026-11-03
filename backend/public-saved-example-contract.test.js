import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';
import {
  PUBLIC_SAVED_EXAMPLE_SCHEMA, PUBLIC_SAVED_EXAMPLE_VIEW_SCHEMA, PUBLIC_SAVED_EXAMPLE_LIMITS,
  PUBLIC_QC_RETENTION_V1, normalizePublicSavedExampleManifest, canonicalPublicSavedExampleManifest,
  publicSavedExampleFinding, canonicalPublicSavedExampleView, normalizePublicSavedExampleTable,
  normalizePublicSavedExampleSource, normalizePublicSavedExamplePng,
} from '../shared/publicSavedExample.mjs';

const { PNG } = createRequire(import.meta.url)('pngjs');
const assetUrl = name => new URL(`../public/examples/qc-retention/v1/${name}`, import.meta.url);
const read = name => fs.readFileSync(assetUrl(name));
const manifest = () => JSON.parse(read('manifest.json'));
const table = () => JSON.parse(read('table.json'));
const hash = value => createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value !== null && typeof value === 'object'
  ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const invalid = action => expect(action).toThrow(expect.objectContaining({ code: 'INVALID_PUBLIC_SAVED_EXAMPLE' }));
const expectedRows = [['Sample A', 1000, 850], ['Sample B', 1200, 900], ['Sample C', 800, 720]];
const identities = [
  ['counts.csv', 87, '9a99e0f8ad73055902fcb3ef9c75d46cf51a70cde206ee6b17488b4bd61e8285'],
  ['table.json', 215, '165e08989a9718386abb179b48e1496bd001c32be0a7d407cba658010dfbdd89'],
  ['figure.png', 44517, 'be4e96cc6f4b422c9d2650d0fdc1a2293c913df6ccde8325ed9c3316801d0fd6'],
  ['manifest.json', 1967, 'b4eebe8ce2ebcb266891206a9a2db5777cedc7724f798994434cab7dc1b6d1da'],
];

it.each(identities)('pins actual intentionally public %s bytes and their independently recorded SHA', (name, bytes, sha256) => {
  const content = read(name); expect(content.byteLength).toBe(bytes); expect(hash(content)).toBe(sha256);
  const declared = name === 'manifest.json' ? PUBLIC_QC_RETENTION_V1.manifest : PUBLIC_QC_RETENTION_V1.assets.find(value => value.file === name);
  expect(declared).toMatchObject({ file: name, bytes, sha256 });
});

it('retains the approved manifest exactly as canonical public-only metadata without inventing an authenticated resource', () => {
  const value = normalizePublicSavedExampleManifest(manifest());
  expect(value.schema).toBe(PUBLIC_SAVED_EXAMPLE_SCHEMA); expect(value.visibility).toBe('public');
  expect(value.provenance).toMatchObject({ kind: 'authored-illustration', synthetic: true, license: 'CC0-1.0' });
  expect(value.provenance.notice).toContain('No patient data'); expect(value.method.description).toContain('No cell-level filtering');
  expect(canonicalPublicSavedExampleManifest(value)).toBe(read('manifest.json').toString('utf8'));
  expect(hash(canonicalPublicSavedExampleManifest(value))).toBe('b4eebe8ce2ebcb266891206a9a2db5777cedc7724f798994434cab7dc1b6d1da');
  expect(JSON.stringify(value)).not.toMatch(/(?:svc|proj|ra|aspub|av|eri)_[a-f0-9]{16,}/);
  const forbidden = new Set(['serviceId', 'projectId', 'analysisId', 'publicationId', 'ownerUserId', 'viewerUserId', 'requestId', 'storageKey', 'path', 'runtime', 'code']);
  const inspect = item => { if (item && typeof item === 'object') for (const [key, value] of Object.entries(item)) { expect(forbidden.has(key)).toBe(false); inspect(value); } };
  inspect(value);
});

it('deeply freezes the compiled catalog and pins one exact route and three permitted public payloads', () => {
  expect(PUBLIC_QC_RETENTION_V1.route).toBe('#/examples/qc-retention/v1'); expect(PUBLIC_QC_RETENTION_V1.assetBase).toBe('examples/qc-retention/v1/');
  expect(Object.isFrozen(PUBLIC_QC_RETENTION_V1)).toBe(true); expect(Object.isFrozen(PUBLIC_QC_RETENTION_V1.manifest)).toBe(true);
  expect(Object.isFrozen(PUBLIC_QC_RETENTION_V1.assets)).toBe(true);
  for (const value of PUBLIC_QC_RETENTION_V1.assets) expect(Object.isFrozen(value)).toBe(true);
  expect(() => { PUBLIC_QC_RETENTION_V1.assets[0].sha256 = 'f'.repeat(64); }).toThrow();
});

it.each([
  ['retention-table', 'table', 'fixed-table', { offset: 0, limit: 3 }, null, null, 215,
    '165e08989a9718386abb179b48e1496bd001c32be0a7d407cba658010dfbdd89', 'c0298750b4dcca26e07b3cefd5d86e60c901596f7907574193992822281f0f36'],
  ['retention-figure', 'image', 'png-raster', null, 960, 600, 44517,
    'be4e96cc6f4b422c9d2650d0fdc1a2293c913df6ccde8325ed9c3316801d0fd6', '4c007ca7b699c48493ea7fc02c8eb6e34ce982595421c8c80ef58a3d0fd01440'],
])('pins the independent source/representation/payload preimage and distinct viewSHA for %s', (id, family, representation, spec, width, height, blobBytes, blobSha256, viewSha) => {
  const preimage = { schema: PUBLIC_SAVED_EXAMPLE_VIEW_SCHEMA, exampleId: 'qc-retention', version: 1, findingId: id,
    family, sourceSha256: '9a99e0f8ad73055902fcb3ef9c75d46cf51a70cde206ee6b17488b4bd61e8285', representation, spec, blobSha256, blobBytes, width, height };
  expect(canonicalPublicSavedExampleView(manifest(), id)).toBe(canonical(preimage)); expect(hash(canonical(preimage))).toBe(viewSha);
  expect(publicSavedExampleFinding(manifest(), id).viewSha256).toBe(viewSha); expect(viewSha).not.toBe(blobSha256);
});

it('captures nested manifest/finding data without retaining caller aliases or claiming original-source verification', () => {
  const input = manifest(), value = normalizePublicSavedExampleManifest(input), finding = publicSavedExampleFinding(input, 'retention-table');
  input.source.file = '/private/source'; input.findings[0].asset.sha256 = 'b'.repeat(64); input.findings[0].caption = 'Caller changed text';
  expect(value.source.file).toBe('counts.csv'); expect(finding.asset.sha256).toBe(identities[1][2]);
  expect(value.findings[0].caption).not.toBe('Caller changed text');
  expect(value.source.integrityVerified).toBeUndefined(); expect(value.source.available).toBeUndefined();
});

it('makes a changed human caption a different canonical manifest identity, not an unchanged trusted publication', () => {
  const value = manifest(); value.findings[0].caption = 'Another supplied public caption';
  expect(hash(canonicalPublicSavedExampleManifest(value))).not.toBe(PUBLIC_QC_RETENTION_V1.manifest.sha256);
});

it.each([
  ['future schema', value => { value.schema = 'traceomics.public-saved-example.v2'; }],
  ['other example', value => { value.id = 'private-project'; }],
  ['future version', value => { value.version = 2; }],
  ['string version', value => { value.version = '1'; }],
  ['private visibility', value => { value.visibility = 'project'; }],
  ['scientific run assertion', value => { value.provenance.kind = 'app-produced-run'; }],
  ['measured data assertion', value => { value.provenance.synthetic = false; }],
  ['different license', value => { value.provenance.license = 'proprietary'; }],
  ['private owner field', value => { value.ownerUserId = 7; }],
  ['execution method field', value => { value.method.code = 'run()'; }],
  ['hidden storage key', value => { value.source.storageKey = 'private/project/source'; }],
  ['absolute asset URL', value => { value.source.file = 'https://untrusted.test/source.csv'; }],
  ['relative traversal', value => { value.findings[0].asset.file = '../private/table.json'; }],
  ['query asset', value => { value.findings[1].asset.file = 'figure.png?expand=all'; }],
  ['encoded path', value => { value.findings[1].asset.file = '%66igure.png'; }],
  ['unsafe media type', value => { value.findings[1].asset.mediaType = 'image/svg+xml'; }],
  ['changed byte count', value => { value.findings[1].asset.bytes++; }],
  ['changed payload SHA', value => { value.findings[0].asset.sha256 = 'f'.repeat(64); }],
  ['changed source SHA', value => { value.findings[0].sourceSha256 = 'f'.repeat(64); }],
  ['changed view SHA', value => { value.findings[0].viewSha256 = 'f'.repeat(64); }],
  ['unknown view family', value => { value.findings[0].family = 'html'; }],
  ['duplicate selection', value => { value.findings[1] = value.findings[0]; }],
  ['reordered findings', value => { value.findings.reverse(); }],
  ['unsupported dimensions', value => { value.findings[1].width = 1200; }],
  ['oversized caption', value => { value.findings[0].caption = 'a'.repeat(1001); }],
  ['hidden control', value => { value.title = 'Public\u202eprivate'; }],
  ['malformed Unicode', value => { value.question = '\ud800'; }],
  ['missing required method', value => { delete value.method; }],
])('rejects %s without resolving any alternate public/private asset', (_name, change) => {
  const value = manifest(); change(value); invalid(() => normalizePublicSavedExampleManifest(value));
});

it.each(['root', 'source', 'finding', 'array'])('does not invoke a hostile %s getter during validation', location => {
  const value = manifest(); let invoked = 0;
  const target = location === 'root' ? value : location === 'source' ? value.source : location === 'finding' ? value.findings[0] : value.findings;
  const key = location === 'root' ? 'schema' : location === 'source' ? 'sha256' : location === 'finding' ? 'asset' : '0';
  Object.defineProperty(target, key, { enumerable: true, get: () => { invoked++; throw new Error('private getter'); } });
  invalid(() => normalizePublicSavedExampleManifest(value)); expect(invoked).toBe(0);
});

it.each(['symbol', 'hidden', 'sparse', 'array extra', 'inherited'])('rejects non-JSON %s manifest structure', kind => {
  let value = manifest();
  if (kind === 'symbol') value[Symbol('private')] = 'secret';
  if (kind === 'hidden') Object.defineProperty(value, 'private', { value: 'hidden', enumerable: false });
  if (kind === 'sparse') delete value.findings[0];
  if (kind === 'array extra') value.findings.custom = 'secret';
  if (kind === 'inherited') value = Object.create(value);
  invalid(() => normalizePublicSavedExampleManifest(value));
});

it('bounds the total UTF8 manifest, not merely each separate UTF16 string', () => {
  const value = manifest(); value.title = '🧬'.repeat(100); value.question = '🧬'.repeat(500); value.limitations = '🧬'.repeat(1000);
  value.provenance.notice = '🧬'.repeat(500); value.method.label = '🧬'.repeat(100); value.method.description = '🧬'.repeat(1000);
  for (const finding of value.findings) finding.caption = '🧬'.repeat(500);
  invalid(() => normalizePublicSavedExampleManifest(value));
});

it.each(['missing', 'current', 'retention-table?limit=100', '../retention-table', null, ['retention-table']])('does not infer an unselected finding from %j', id => {
  invalid(() => publicSavedExampleFinding(manifest(), id));
});

it('keeps the CSV literal UTF8/LF and the complete fixed table in agreement without invented percentages', () => {
  const source = read('counts.csv'); expect(source[0]).not.toBe(0xef); expect(source.toString()).not.toContain('\r');
  const text = normalizePublicSavedExampleSource(source.toString('utf8'));
  const rows = text.trimEnd().split('\n').slice(1).map(line => { const [sample, input, retained] = line.split(','); return [sample, Number(input), Number(retained)]; });
  expect(rows).toEqual(expectedRows); const preview = normalizePublicSavedExampleTable(table()); expect(preview.rows).toEqual(rows);
  expect(preview.columns).toEqual(['Sample', 'Input cells', 'Retained cells']); expect(preview.hasMore).toBe(false); expect(preview.truncated).toBe(false);
});

it.each([
  ['changed cell', value => { value.rows[0][1] = 999; }], ['rounded number', value => { value.rows[0][1] = 1000.1; }],
  ['numeric string', value => { value.rows[0][1] = '1000'; }], ['nested value', value => { value.rows[0][1] = { value: 1000 }; }],
  ['missing cell', value => { delete value.rows[0][1]; }], ['unselected fourth row', value => { value.rows.push(['Private', 1, 0]); }],
  ['changed row order', value => { value.rows.reverse(); }], ['claim more source', value => { value.hasMore = true; }],
  ['expanded bound', value => { value.limit = 100; }], ['HTML field', value => { value.html = '<script>run()</script>'; }],
])('rejects %s instead of fabricating a public table interpretation', (_name, change) => { const value = table(); change(value); invalid(() => normalizePublicSavedExampleTable(value)); });

it.each(['BOM', 'CRLF', 'changed count', 'extra sample', 'code-like text', 'empty'])('rejects %s as the known public CSV', variation => {
  let value = read('counts.csv').toString('utf8');
  if (variation === 'BOM') value = '\ufeff' + value;
  if (variation === 'CRLF') value = value.replaceAll('\n', '\r\n');
  if (variation === 'changed count') value = value.replace('850', '851');
  if (variation === 'extra sample') value += 'Sample D,100,90\n';
  if (variation === 'code-like text') value = 'system("run")';
  if (variation === 'empty') value = '';
  invalid(() => normalizePublicSavedExampleSource(value));
});

it('normalizes known PNG representation only after the caller can verify its full payload checksum', () => {
  const bytes = read('figure.png'), finding = publicSavedExampleFinding(manifest(), 'retention-figure');
  expect(normalizePublicSavedExamplePng(bytes, finding)).toEqual({ family: 'image', width: 960, height: 600 });
  expect(normalizePublicSavedExamplePng(new Uint8Array(bytes), finding)).toEqual({ family: 'image', width: 960, height: 600 });
  const corrupted = Buffer.from(bytes); corrupted[2000] ^= 1;
  expect(hash(corrupted)).not.toBe(finding.asset.sha256);
  expect(normalizePublicSavedExamplePng(corrupted, finding)).not.toHaveProperty('integrityVerified');
});

it('uses native byte-array facts across realms without invoking caller binary accessors', () => {
  const bytes = new Uint8Array(read('figure.png')), finding = manifest().findings[1]; let invoked = 0;
  for (const key of ['byteLength', 'buffer', Symbol.iterator]) Object.defineProperty(bytes, key, { get: () => { invoked++; throw new Error('private binary getter'); } });
  expect(normalizePublicSavedExamplePng(bytes, finding)).toEqual({ family: 'image', width: 960, height: 600 });
  expect(invoked).toBe(0);
  const foreign = runInNewContext('Uint8Array.from(values)', { values: Array.from(read('figure.png')) });
  expect(normalizePublicSavedExamplePng(foreign, finding)).toEqual({ family: 'image', width: 960, height: 600 });
});

it('keeps actual PNG metadata limited to the public authoring label and dimensions, with no EXIF/private fields', () => {
  const bytes = read('figure.png'), types = [], texts = []; let offset = 8;
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset), type = bytes.toString('ascii', offset + 4, offset + 8);
    expect(offset + 12 + length).toBeLessThanOrEqual(bytes.length); types.push(type);
    if (type === 'tEXt') texts.push(bytes.toString('utf8', offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  expect(offset).toBe(bytes.length); expect([...new Set(types)].sort()).toEqual(['IDAT', 'IEND', 'IHDR', 'pHYs', 'tEXt'].sort());
  expect(texts).toEqual(['Software\u0000TraceOmics public illustration']); expect(types).not.toContain('eXIf');
});

it.each(['signature', 'IHDR length', 'width', 'height', 'bit depth', 'color type', 'compression', 'filter', 'interlace', 'IEND', 'truncated'])('rejects a PNG %s mismatch before rendering', variation => {
  let bytes = Buffer.from(read('figure.png'));
  if (variation === 'signature') bytes[0] = 0;
  if (variation === 'IHDR length') bytes[11] = 12;
  if (variation === 'width') bytes.writeUInt32BE(50000, 16);
  if (variation === 'height') bytes.writeUInt32BE(800, 20);
  if (variation === 'bit depth') bytes[24] = 16;
  if (variation === 'color type') bytes[25] = 2;
  if (variation === 'compression') bytes[26] = 1;
  if (variation === 'filter') bytes[27] = 1;
  if (variation === 'interlace') bytes[28] = 1;
  if (variation === 'IEND') bytes[bytes.length - 1] ^= 1;
  if (variation === 'truncated') bytes = bytes.subarray(0, bytes.length - 1);
  invalid(() => normalizePublicSavedExamplePng(bytes, manifest().findings[1]));
});

it.each([[], new DataView(new ArrayBuffer(44517)), new Uint16Array(44517), {}])('rejects a nonbyte PNG input without coercion', value => {
  invalid(() => normalizePublicSavedExamplePng(value, manifest().findings[1]));
});

it('checks actual decoded PNG dimensions and six independent bar heights against the source counts', () => {
  const png = PNG.sync.read(read('figure.png')); expect([png.width, png.height]).toEqual([960, 600]);
  expect(png.width * png.height).toBeLessThanOrEqual(PUBLIC_SAVED_EXAMPLE_LIMITS.imagePixels);
  for (const [row, xInput, xRetained] of [[expectedRows[0], 196, 299], [expectedRows[1], 467, 570], [expectedRows[2], 739, 842]]) {
    for (const [x, count, rgb] of [[xInput, row[1], [203, 213, 225]], [xRetained, row[2], [15, 118, 110]]]) {
      let first = null;
      for (let y = 126; y < 486 && first === null; y++) for (let dx = -6; dx <= 6; dx++) {
        const index = (y * png.width + x + dx) * 4;
        if (rgb.every((value, channel) => png.data[index + channel] === value)) { first = y; break; }
      }
      expect(first).not.toBeNull(); expect(Math.abs(first - (486 - count / 1400 * 360))).toBeLessThanOrEqual(3);
    }
  }
});

it('keeps the generator tied to the exact authored counts and frozen-version pins, without a private fixture or app-code relicensing', () => {
  const generator = fs.readFileSync(new URL('../scripts/generate-public-saved-example.py', import.meta.url), 'utf8');
  expect(generator).toContain('ROWS = (("Sample A", 1000, 850), ("Sample B", 1200, 900), ("Sample C", 800, 720))');
  for (const [, , sha] of identities) expect(generator).toContain(sha);
  expect(generator).toContain('EXPECTED_ASSETS[name]'); expect(generator).toContain('No cell-level filtering was run');
  expect(generator).not.toMatch(/scratch\/|snapshot.*[Ff]ixture|DATABASE_URL|sessionStorage|private.*storage|r-backend/);
  const source = fs.readFileSync(new URL('../shared/publicSavedExample.mjs', import.meta.url), 'utf8');
  expect(source).not.toMatch(/\b(?:fetch|localStorage|sessionStorage|window|process|require)\b|^import /m);
});
