import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { SERVER_DATA_IMPORT_REQUEST_LIMITS, SERVER_DATA_IMPORT_ROOT_ID, canonicalServerDataImportRequest,
  normalizeServerDataImportPath, normalizeServerDataImportRequest } from '../shared/serverDataImport.mjs';

const { relativeSelection } = require('./serverDataImportConfig');
const sha = value => createHash('sha256').update(value).digest('hex');
const requestId = 'ABCDEFAB-1234-4ABC-8DEF-ABCDEFABCDEF';
const base = changes => ({ requestId, rootId: 'study-a', relativePath: 'donor 1/β scores.csv', selectionToken: 'd'.repeat(64), ...changes });
const fails = (action, code) => {
  try { action(); throw new Error('Expected a contract rejection'); }
  catch (error) { expect(error).toMatchObject({ code, status: 400 }); }
};

describe('server import request canonical compatibility without storage or execution', () => {
  it('preserves the literal existing ordered request, optional sample annotations and lowercased UUID', () => {
    const input = base({ name: '  Results β  ', artifactType: 'sample-sheet', previousVersionId: 'av_' + 'f'.repeat(24),
      sampleMetadata: { tissue: ' lung ', sampleId: ' donor-1 ', replicate: ' 2 ', species: ' human ', condition: ' treated ' } });
    const literal = '{"requestId":"abcdefab-1234-4abc-8def-abcdefabcdef","rootId":"study-a","relativePath":"donor 1/β scores.csv","selectionToken":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","name":"Results β","artifactType":"sample-sheet","previousVersionId":"av_ffffffffffffffffffffffff","sampleMetadata":{"condition":"treated","replicate":"2","sampleId":"donor-1","species":"human","tissue":"lung"}}';
    expect(canonicalServerDataImportRequest(input)).toBe(literal);
    expect(sha(canonicalServerDataImportRequest(input))).toBe(sha(literal));
    expect(Object.keys(normalizeServerDataImportRequest(input))).toEqual(['requestId', 'rootId', 'relativePath', 'selectionToken', 'name', 'artifactType', 'previousVersionId', 'sampleMetadata']);
    expect(Object.keys(normalizeServerDataImportRequest(input).sampleMetadata)).toEqual(['condition', 'replicate', 'sampleId', 'species', 'tissue']);
  });

  it('preserves documented optional defaults and distinguishes omitted annotations from supplied empty annotations', () => {
    const expected = { requestId: requestId.toLowerCase(), rootId: 'study-a', relativePath: 'donor 1/β scores.csv', selectionToken: 'd'.repeat(64),
      name: 'β scores.csv', artifactType: 'auto', previousVersionId: null };
    expect(normalizeServerDataImportRequest(base())).toEqual(expected);
    expect(normalizeServerDataImportRequest(base({ name: null, artifactType: undefined, previousVersionId: undefined, sampleMetadata: undefined }))).toEqual(expected);
    for (const artifactType of ['', null, false, 0]) expect(normalizeServerDataImportRequest(base({ artifactType })).artifactType).toBe('auto');
    expect(normalizeServerDataImportRequest(base({ sampleMetadata: {} }))).toEqual({ ...expected, sampleMetadata: {} });
    expect(canonicalServerDataImportRequest(base({ sampleMetadata: {} }))).not.toBe(canonicalServerDataImportRequest(base()));
    fails(() => normalizeServerDataImportRequest(base({ name: '' })), 'INVALID_ARTIFACT_NAME');
    fails(() => normalizeServerDataImportRequest(base({ sampleMetadata: null })), 'SERVER_IMPORT_METADATA_INVALID');
  });

  it('keeps 160 and 120 UTF-16 limits measured before trimming rather than changing accepted request hashes', () => {
    expect(SERVER_DATA_IMPORT_REQUEST_LIMITS).toEqual({ name: 160, sampleMetadata: 120, path: 1024, pathSegments: 32, pathSegment: 240 });
    expect(normalizeServerDataImportRequest(base({ name: '🧬'.repeat(80), sampleMetadata: { condition: '🧬'.repeat(60) } })).name).toHaveLength(160);
    fails(() => normalizeServerDataImportRequest(base({ name: '🧬'.repeat(81) })), 'INVALID_ARTIFACT_NAME');
    fails(() => normalizeServerDataImportRequest(base({ name: ' ' + 'a'.repeat(160) })), 'INVALID_ARTIFACT_NAME');
    fails(() => normalizeServerDataImportRequest(base({ sampleMetadata: { sampleId: '🧬'.repeat(61) } })), 'SERVER_IMPORT_METADATA_INVALID');
    fails(() => normalizeServerDataImportRequest(base({ sampleMetadata: { sampleId: ' ' + 'a'.repeat(120) } })), 'SERVER_IMPORT_METADATA_INVALID');
    expect(normalizeServerDataImportRequest(base({ name: '  β results  ', sampleMetadata: { sampleId: ' donor-1 ' } }))).toMatchObject({ name: 'β results', sampleMetadata: { sampleId: 'donor-1' } });
  });

  it('binds the request identity, selected source and all import meanings without adding scope or schema to the legacy hash', () => {
    const input = base(), original = canonicalServerDataImportRequest(input);
    for (const changes of [{ requestId: '00000000-0000-4000-8000-000000000001' }, { rootId: 'study-b' }, { relativePath: 'donor 2/β scores.csv' },
      { selectionToken: 'e'.repeat(64) }, { name: 'Other retained name' }, { artifactType: 'sample-sheet' }, { previousVersionId: 'av_' + 'e'.repeat(24) },
      { sampleMetadata: { condition: 'treated' } }]) expect(canonicalServerDataImportRequest({ ...input, ...changes })).not.toBe(original);
    expect(JSON.parse(original)).not.toHaveProperty('schema'); expect(JSON.parse(original)).not.toHaveProperty('projectId');
    for (const field of ['schema', 'projectId', 'ownerUserId', 'serviceId', 'storageKey', 'absolutePath', 'sha256', 'fileBytes']) {
      fails(() => normalizeServerDataImportRequest({ ...input, [field]: 'caller-controlled' }), 'SERVER_IMPORT_REQUEST_INVALID');
    }
  });

  it('retains generic RDS, text, JSON and sample-sheet requests for existing callers instead of restricting them to evidence figures', () => {
    for (const relativePath of ['cells.rds', 'summary.txt', 'metadata.json', 'figure.PNG', 'table.tsv']) {
      expect(normalizeServerDataImportRequest(base({ relativePath })).relativePath).toBe(relativePath);
    }
    expect(normalizeServerDataImportRequest(base({ artifactType: 'sample-sheet' })).artifactType).toBe('sample-sheet');
    fails(() => normalizeServerDataImportRequest(base({ artifactType: 'arbitrary-execution' })), 'SERVER_IMPORT_REQUEST_INVALID');
  });

  it('preserves all documented exact previous-version identifier families and lengths without coercing caller objects', () => {
    for (const prefix of ['av', 'art', 'eri']) for (const length of [16, 24, 40]) {
      const previousVersionId = `${prefix}_${'a'.repeat(length)}`;
      expect(normalizeServerDataImportRequest(base({ previousVersionId })).previousVersionId).toBe(previousVersionId);
    }
    for (const previousVersionId of ['', 'av_' + 'a'.repeat(15), 'av_' + 'a'.repeat(41), 'av_' + 'A'.repeat(24), ['av_' + 'a'.repeat(24)], {}]) {
      fails(() => normalizeServerDataImportRequest(base({ previousVersionId })), 'SERVER_IMPORT_REQUEST_INVALID');
    }
  });

  it('normalizes safe plain and null-prototype data without mutating a frozen caller request or its annotations', () => {
    const input = Object.freeze(base({ sampleMetadata: Object.freeze({ tissue: ' lung ', condition: ' control ' }) }));
    const before = JSON.stringify(input), parsed = normalizeServerDataImportRequest(input);
    expect(JSON.stringify(input)).toBe(before); expect(parsed.sampleMetadata).toEqual({ condition: 'control', tissue: 'lung' });
    expect(normalizeServerDataImportRequest(Object.assign(Object.create(null), input))).toEqual(parsed);
    expect(normalizeServerDataImportRequest(base({ sampleMetadata: Object.assign(Object.create(null), { species: ' human ' }) })).sampleMetadata).toEqual({ species: 'human' });
  });

  it('rejects unknown, inherited, accessor, symbol and nonenumerable fields before evaluating caller code', () => {
    let evaluated = false;
    const accessor = base(); Object.defineProperty(accessor, 'selectionToken', { enumerable: true, get() { evaluated = true; return 'd'.repeat(64); } });
    const hidden = base(); Object.defineProperty(hidden, 'name', { value: 'Hidden name', enumerable: false });
    const symbol = { ...base(), [Symbol('metadata')]: true };
    for (const input of [accessor, hidden, symbol, Object.assign(Object.create({ inherited: true }), base()), null, [], 'request']) {
      fails(() => normalizeServerDataImportRequest(input), 'SERVER_IMPORT_REQUEST_INVALID');
    }
    const sampleAccessor = {}; Object.defineProperty(sampleAccessor, 'sampleId', { enumerable: true, get() { evaluated = true; return 'hidden'; } });
    for (const sampleMetadata of [sampleAccessor, Object.assign(Object.create({ inherited: true }), { tissue: 'lung' }), { storagePath: 'private' }, [], 'notes']) {
      fails(() => normalizeServerDataImportRequest(base({ sampleMetadata })), 'SERVER_IMPORT_METADATA_INVALID');
    }
    expect(evaluated).toBe(false);
  });

  it('keeps required UUID/root/token checks and single-line names and annotations explicit', () => {
    expect(SERVER_DATA_IMPORT_ROOT_ID.test('a-' + 'b'.repeat(62))).toBe(true); expect(SERVER_DATA_IMPORT_ROOT_ID.test('A-root')).toBe(false);
    for (const changes of [{ requestId: 'not-a-uuid' }, { requestId: '00000000-0000-0000-0000-000000000000' }, { requestId: [requestId] },
      { rootId: 'A-root' }, { rootId: 'a'.repeat(65) }, { rootId: ['study-a'] }, { selectionToken: 'D'.repeat(64) }, { selectionToken: 'd'.repeat(63) }, { selectionToken: ['d'.repeat(64)] }]) {
      fails(() => normalizeServerDataImportRequest(base(changes)), 'SERVER_IMPORT_REQUEST_INVALID');
    }
    for (const control of ['\0', '\t', '\n', '\r', '\x1f', '\x7f']) {
      fails(() => normalizeServerDataImportRequest(base({ name: `Result${control}name` })), 'INVALID_ARTIFACT_NAME');
      fails(() => normalizeServerDataImportRequest(base({ sampleMetadata: { condition: `Control${control}treated` } })), 'SERVER_IMPORT_METADATA_INVALID');
    }
    fails(() => normalizeServerDataImportRequest(base({ sampleMetadata: { condition: '  ' } })), 'SERVER_IMPORT_METADATA_INVALID');
  });
});

describe('portable granted-root relative selection compatibility', () => {
  const permitted = ['', 'samples.csv', 'donor 1/β scores.csv', 'subfolder/file.v2.tsv', 'a'.repeat(240), Array(32).fill('x').join('/')];
  const denied = [null, 1, '/absolute/file.csv', 'C:/data/file.csv', 'C:\\data\\file.csv', '../file.csv', 'a/../file.csv', 'a//file.csv',
    './file.csv', '.hidden/file.csv', 'a/.hidden', 'a/file.csv.', 'a/file.csv ', 'a/file%20.csv', 'a/file:stream.csv', 'a/file\0.csv',
    'a/vault/file.csv', 'a/SESSIONS/file.csv', 'credentials/file.csv', 'node_modules/file.csv', 'CON.csv', 'a/nul', 'a/LPT1.csv',
    'a/COM9.csv', 'a'.repeat(241), Array(33).fill('x').join('/'), Array(5).fill('a'.repeat(210)).join('/')];
  it('matches existing backend path validation for ordinary Unicode paths and every unsafe boundary', () => {
    for (const raw of [...permitted, ...denied, undefined]) for (const directory of [false, true]) {
      let expected, expectedFailure;
      try { expected = relativeSelection(raw, { directory }); } catch (error) { expectedFailure = error.code; }
      if (expectedFailure) fails(() => normalizeServerDataImportPath(raw, { directory }), expectedFailure);
      else expect(normalizeServerDataImportPath(raw, { directory })).toBe(expected);
    }
  });
  it('allows root browsing only in directory mode and does not interpret relative selection as a host-path grant', () => {
    expect(normalizeServerDataImportPath(undefined, { directory: true })).toBe('');
    expect(normalizeServerDataImportPath('', { directory: true })).toBe('');
    fails(() => normalizeServerDataImportPath(''), 'SERVER_IMPORT_PATH_INVALID');
    expect(normalizeServerDataImportPath('relative/allowed.csv')).toBe('relative/allowed.csv');
    expect(Object.keys(normalizeServerDataImportRequest(base()))).not.toContain('absolutePath');
  });
});
