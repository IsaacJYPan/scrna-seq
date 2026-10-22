import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ANALYSIS_SNAPSHOT_PREPARATION_SCHEMA, ANALYSIS_SNAPSHOT_PACKAGE_SCHEMA,
  FIXED_RESULT_VIEW_SCHEMA, FIXED_DOCUMENT_SOURCE_SCHEMA,
  ANALYSIS_SNAPSHOT_PREPARATION_LIMITS as L, ANALYSIS_SNAPSHOT_PREPARATION_ID,
  ANALYSIS_SNAPSHOT_VIEW_ID, normalizeAnalysisSnapshotPreparation as normalize,
  canonicalAnalysisSnapshotPreparation as canonical, canonicalSnapshotJson,
  canonicalAnalysisSnapshotResultView as resultCanonical,
  canonicalAnalysisSnapshotDocumentSource as documentCanonical,
  canonicalAnalysisSnapshotPackage as packageCanonical,
} from '../shared/analysisSnapshotPreparation.mjs';
import { canonicalNotebookContent } from '../shared/notebookDocument.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const clone = value => structuredClone(value);
const time = '2026-10-22T12:00:00.000Z';
const recipe = () => ({
  requestId: '12345678-1234-4234-8234-123456789abc', serviceId: 'svc_' + '1'.repeat(32),
  projectId: 'proj_' + '2'.repeat(16), analysisId: 'ra_' + '3'.repeat(24), ownerUserId: 7, analysisVersion: 2,
  results: [{ attachmentId: 'raa_' + '4'.repeat(24), revisionId: 'rar_' + '5'.repeat(24),
    reference: { kind: 'artifact-version', versionId: 'av_' + '6'.repeat(24), sha256: 'a'.repeat(64) },
    view: { family: 'table', offset: 25, limit: 25 } }],
  documents: [{ documentId: 'doc_' + '7'.repeat(24), versionId: 'dv_' + '8'.repeat(24), sha256: 'b'.repeat(64) }],
  notes: { summary: 'Measured PBMC results', decisions: null, limitations: 'Supporting source is not producing execution evidence.' },
  prerequisites: [{ kind: 'data', label: 'Raw counts', detail: 'Original data access is required.' }],
});
const literal = '{"schema":"traceomics.analysis-snapshot-preparation.v1","serviceId":"svc_11111111111111111111111111111111","projectId":"proj_2222222222222222","analysisId":"ra_333333333333333333333333","ownerUserId":7,"requestId":"12345678-1234-4234-8234-123456789abc","analysisVersion":2,"results":[{"attachmentId":"raa_444444444444444444444444","revisionId":"rar_555555555555555555555555","reference":{"kind":"artifact-version","versionId":"av_666666666666666666666666","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"view":{"family":"table","offset":25,"limit":25}}],"documents":[{"documentId":"doc_777777777777777777777777","versionId":"dv_888888888888888888888888","sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}],"notes":{"summary":"Measured PBMC results","decisions":null,"limitations":"Supporting source is not producing execution evidence."},"prerequisites":[{"kind":"data","label":"Raw counts","detail":"Original data access is required."}]}';
const view = () => ({ schema: FIXED_RESULT_VIEW_SCHEMA,
  source: { artifactId: 'af_' + '9'.repeat(24), versionId: 'av_' + '6'.repeat(24), projectId: recipe().projectId, sha256: 'a'.repeat(64) },
  family: 'table', spec: { offset: 25, limit: 25 }, blobSha256: 'c'.repeat(64), blobBytes: 128, width: null, height: null });
const document = () => ({ schema: FIXED_DOCUMENT_SOURCE_SCHEMA, source: recipe().documents[0], blobSha256: 'b'.repeat(64), blobBytes: 256 });
const context = () => ({ origin: null, sourceReference: null, documentReference: null, environmentReference: null });
function readyPackage() {
  const r = recipe(), v = view(), d = document();
  const { source: _source, ...fixed } = v; void _source;
  return { schema: ANALYSIS_SNAPSHOT_PACKAGE_SCHEMA, serviceId: r.serviceId, projectId: r.projectId, analysisId: r.analysisId,
    ownerUserId: 7, preparationId: 'asp_' + 'd'.repeat(24), createdAt: time,
    analysis: { version: 2, name: 'PBMC contrast', description: 'Measured observations', status: 'active', createdByUserId: 7, createdAt: time, updatedAt: time, revisionSha256: 'e'.repeat(64) },
    results: [{ viewId: 'asv_' + '1'.repeat(24), attachment: { attachmentId: r.results[0].attachmentId,
      revisionId: r.results[0].revisionId, revisionNumber: 2, caption: 'Selected measured results', suppliedOrigin: context(),
      createdByUserId: 9, createdAt: time, sourceOwnerUserId: 7 }, source: { artifactId: v.source.artifactId,
      versionId: v.source.versionId, sha256: v.source.sha256, sizeBytes: 400, name: 'contrast.csv', format: { id: 'org.ietf.csv', version: '1' } },
    view: { ...fixed, viewSha256: hash(resultCanonical(v)) } }],
    documents: [{ viewId: 'asv_' + '2'.repeat(24), documentId: d.source.documentId, versionId: d.source.versionId,
      version: 1, title: 'Supporting source', documentKind: 'script', defaultLanguage: 'R', sha256: d.source.sha256,
      contentBytes: d.blobBytes, role: 'supporting-source', producingSource: 'not-established', blobSha256: d.blobSha256,
      blobBytes: d.blobBytes, viewSha256: hash(documentCanonical(d)) }], notes: r.notes,
    prerequisites: { declaration: 'user-supplied', items: r.prerequisites },
    reproduction: { status: 'not-checked', producingSource: 'not-established', runtime: 'not-included', dataAccess: 'not-granted' } };
}
function invalid(action) { expect(action).toThrow(expect.objectContaining({ status: 400 })); }
function large(action) { expect(action).toThrow(expect.objectContaining({ status: 413 })); }

describe('private exact snapshot preparation request', () => {
  it('pins schema, ID namespaces and transport/storage budgets', () => {
    expect(ANALYSIS_SNAPSHOT_PREPARATION_SCHEMA).toBe('traceomics.analysis-snapshot-preparation.v1');
    expect(ANALYSIS_SNAPSHOT_PREPARATION_ID.test('asp_' + 'a'.repeat(24))).toBe(true);
    expect(ANALYSIS_SNAPSHOT_VIEW_ID.test('asv_' + 'a'.repeat(24))).toBe(true);
    expect(L).toMatchObject({ results: 8, documents: 2, prerequisites: 20, requests: 2000, live: 10,
      originalBytes: 209715200, retainedBytes: 16777216, ownerBytes: 134217728, projectBytes: 536870912,
      requestBytes: 65536, packageBytes: 262144, fullBytes: 393216, listBytes: 131072, page: 30, cursor: 256 });
    expect(Object.isFrozen(L)).toBe(true);
  });
  it('keeps an independent literal ordered request and SHA fixture', () => {
    expect(canonical(recipe())).toBe(literal);
    expect(hash(canonical(recipe()))).toBe('004a82bcb1a5f23724325010911bba1f48fc73e5eadf5efbe6995dbf736c8919');
  });
  it('normalizes only new human notes/UUID and keeps scientific IDs/array order', () => {
    const input = recipe(); input.requestId = input.requestId.toUpperCase();
    input.notes = { summary: '  α\r\nβ\rγ  ', decisions: '\t \n', limitations: null };
    input.prerequisites = [{ kind: 'compute', label: '  Remote compute  ', detail: '  supplied\r\ncontext  ' }];
    const result = normalize(input);
    expect(result.requestId).toBe(recipe().requestId); expect(result.notes).toEqual({ summary: 'α\nβ\nγ', decisions: null, limitations: null });
    expect(result.prerequisites[0]).toEqual({ kind: 'compute', label: 'Remote compute', detail: 'supplied\ncontext' });
    expect(input.notes.summary).toBe('  α\r\nβ\rγ  ');
  });
  it('accepts fixed image intent without any client MIME claim', () => {
    const r = recipe(); r.results[0].view = { family: 'image' };
    expect(normalize(r).results[0].view).toEqual({ family: 'image' });
  });
  it('allows distinct fixed excerpts and rejects the exact duplicate', () => {
    const r = recipe(); r.results.push(clone(r.results[0])); r.results[1].view.offset = 50;
    expect(normalize(r).results).toHaveLength(2);
    expect(hash(canonical(r))).not.toBe(hash(canonical({ ...r, results: [...r.results].reverse() })));
    r.results[1].view.offset = 25; invalid(() => normalize(r));
  });
  it('allows two versions of one supporting source but rejects duplicate exact dv', () => {
    const r = recipe(); r.documents.push({ ...r.documents[0], versionId: 'dv_' + '9'.repeat(24) });
    expect(normalize(r).documents).toHaveLength(2);
    r.documents[1] = { ...r.documents[0], sha256: 'f'.repeat(64) }; invalid(() => normalize(r));
  });
  it('accepts all item boundary counts without fabricating source facts', () => {
    const r = recipe(); r.results = Array.from({ length: 8 }, (_, i) => ({ ...r.results[0], view: { family: 'table', offset: i * 100, limit: 100 } }));
    r.documents.push({ ...r.documents[0], versionId: 'dv_' + '9'.repeat(24) });
    r.prerequisites = Array.from({ length: 20 }, () => ({ kind: 'other', label: 'Declared prerequisite', detail: null }));
    expect(normalize(r).results).toHaveLength(8);
  });
  it('distinguishes all installation/project/analysis/owner/request/version intents in the hash', () => {
    const base = hash(canonical(recipe()));
    for (const [key, value] of Object.entries({ serviceId: 'svc_' + '0'.repeat(32), projectId: 'proj_' + '0'.repeat(16), analysisId: 'ra_' + '0'.repeat(24), ownerUserId: 8,
      requestId: '12345678-1234-4234-8234-123456789abd', analysisVersion: 3 })) expect(hash(canonical({ ...recipe(), [key]: value }))).not.toBe(base);
  });
  it.each([
    ['missing owner', r => { delete r.ownerUserId; }], ['client source bytes', r => { r.bytes = 'private'; }],
    ['client publication', r => { r.visibility = 'project'; }], ['wrong installation', r => { r.serviceId = 'svc_x'; }],
    ['wrong project', r => { r.projectId = 'proj_x'; }], ['wrong analysis', r => { r.analysisId = 'ra_x'; }],
    ['string owner', r => { r.ownerUserId = '7'; }], ['zero owner', r => { r.ownerUserId = 0; }],
    ['fractional owner', r => { r.ownerUserId = 1.2; }], ['invalid uuid', r => { r.requestId = 'not-a-uuid'; }],
    ['latest alias', r => { r.analysisVersion = 'latest'; }], ['zero saved version', r => { r.analysisVersion = 0; }],
    ['overflow saved version', r => { r.analysisVersion = 2147483648; }], ['empty results', r => { r.results = []; }],
    ['too many results', r => { r.results = Array(9).fill(r.results[0]); }], ['missing exact context', r => { delete r.results[0].revisionId; }],
    ['legacy object source', r => { r.results[0].reference.versionId = 'art_' + '6'.repeat(24); }],
    ['client path', r => { r.results[0].reference.path = '/lab/private.csv'; }], ['source hash case', r => { r.results[0].reference.sha256 = 'A'.repeat(64); }],
    ['client raster MIME', r => { r.results[0].view.mimeType = 'image/png'; }], ['dynamic view', r => { r.results[0].view.family = 'interactive'; }],
    ['negative offset', r => { r.results[0].view.offset = -1; }], ['too late offset', r => { r.results[0].view.offset = 10001; }],
    ['string limit', r => { r.results[0].view.limit = '25'; }], ['zero rows', r => { r.results[0].view.limit = 0; }],
    ['too many rows', r => { r.results[0].view.limit = 101; }], ['too many documents', r => { r.documents = Array(3).fill(r.documents[0]); }],
    ['source draft', r => { r.documents[0].draftVersion = 2; }], ['document checksum missing', r => { delete r.documents[0].sha256; }],
    ['source origin claim', r => { r.notes.execution = 'verified'; }], ['undefined optional text', r => { r.notes.summary = undefined; }],
    ['new note over UTF16 bound', r => { r.notes.summary = '😀'.repeat(1001); }], ['new note hidden Cf', r => { r.notes.summary = 'a\u200bb'; }],
    ['new note hidden Cc', r => { r.notes.summary = 'a\0b'; }], ['bad Unicode', r => { r.notes.summary = '\ud800'; }],
    ['too many prerequisites', r => { r.prerequisites = Array(21).fill(r.prerequisites[0]); }],
    ['unsupported reference adapter', r => { r.prerequisites[0].kind = 'url'; }], ['blank prerequisite', r => { r.prerequisites[0].label = ' '; }],
    ['multiline label', r => { r.prerequisites[0].label = 'a\nb'; }], ['long label', r => { r.prerequisites[0].label = 'a'.repeat(161); }],
    ['long detail', r => { r.prerequisites[0].detail = 'a'.repeat(1001); }], ['live source pointer', r => { r.documents[0].versionId = 'latest'; }],
  ])('rejects %s', (_, change) => { const r = recipe(); change(r); invalid(() => normalize(r)); });
  it('enforces request byte budget in addition to character/item budgets', () => {
    const r = recipe(); r.notes = { summary: '界'.repeat(2000), decisions: '界'.repeat(2000), limitations: '界'.repeat(2000) };
    r.prerequisites = Array.from({ length: 20 }, () => ({ kind: 'other', label: '界'.repeat(160), detail: '界'.repeat(1000) }));
    large(() => normalize(r));
  });
  it('does not invoke getters in nested records, arrays or discriminators', () => {
    let calls = 0;
    for (const target of ['top', 'reference', 'family', 'array']) {
      const r = recipe();
      const [object, key] = target === 'top' ? [r, 'ownerUserId'] : target === 'reference' ? [r.results[0].reference, 'sha256']
        : target === 'family' ? [r.results[0].view, 'family'] : [r.results, '0'];
      Object.defineProperty(object, key, { get() { calls++; return 'x'; }, enumerable: true });
      invalid(() => normalize(r));
    }
    expect(calls).toBe(0);
  });
  it.each(['prototype', 'hidden', 'symbol', 'array-property', 'sparse'])('rejects unsafe %s fields', type => {
    const r = recipe();
    if (type === 'prototype') Object.setPrototypeOf(r.notes, { secret: 'inherited' });
    if (type === 'hidden') Object.defineProperty(r.notes, 'secret', { value: true });
    if (type === 'symbol') r[Symbol('extra')] = true;
    if (type === 'array-property') r.results.extra = true;
    if (type === 'sparse') delete r.results[0];
    invalid(() => normalize(r));
  });
});

describe('strict sorted snapshot JSON and representation fingerprints', () => {
  it('sorts nested keys without changing arrays/scientific strings', () => {
    expect(canonicalSnapshotJson({ z: ['\tR source  \r\n', { b: 2, a: 1 }], a: -0 })).toBe('{"a":0,"z":["\\tR source  \\r\\n",{"a":1,"b":2}]}');
    const empty = Object.create(null); empty.b = 2; empty.a = 1;
    expect(canonicalSnapshotJson(empty)).toBe('{"a":1,"b":2}');
    expect(canonicalSnapshotJson({ 2: 'two', 10: 'ten', z: { 9: 9, 100: 100 } })).toBe('{"10":"ten","2":"two","z":{"100":100,"9":9}}');
  });
  it.each([undefined, NaN, Infinity, 1n, () => 1, new Date(), new Map(), { value: undefined }])('rejects non-JSON input %#', value => invalid(() => canonicalSnapshotJson(value)));
  it('rejects cycles, hidden fields, custom toJSON and malformed keys without calling code', () => {
    let called = false; const cyclic = {}; cyclic.self = cyclic; invalid(() => canonicalSnapshotJson(cyclic));
    invalid(() => canonicalSnapshotJson({ toJSON() { called = true; return {}; } }));
    invalid(() => canonicalSnapshotJson({ '\ud800': 1 })); invalid(() => canonicalSnapshotJson(JSON.parse('{"__proto__":{}}')));
    const getter = {}; Object.defineProperty(getter, 'a', { enumerable: true, get() { called = true; return 1; } });
    invalid(() => canonicalSnapshotJson(getter)); expect(called).toBe(false);
  });
  it('bounds byte, depth and node complexity', () => {
    expect(canonicalSnapshotJson('界', 5)).toBe('"界"'); large(() => canonicalSnapshotJson('界', 4));
    let deep = null; for (let i = 0; i < 25; i++) deep = [deep]; large(() => canonicalSnapshotJson(deep));
    expect(canonicalSnapshotJson(Array(99999).fill(null))).toHaveLength(499996);
    large(() => canonicalSnapshotJson(Array(100000).fill(null)));
  });
  it('pins the exact fixed result and source descriptor literal hashes', () => {
    expect(resultCanonical(view())).toBe('{"blobBytes":128,"blobSha256":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","family":"table","height":null,"schema":"traceomics.fixed-result-view.v1","source":{"artifactId":"af_999999999999999999999999","projectId":"proj_2222222222222222","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","versionId":"av_666666666666666666666666"},"spec":{"limit":25,"offset":25},"width":null}');
    expect(hash(resultCanonical(view()))).toBe('036a564ea4bcfb59985e89cb501356d3926cfd0ae5fc08be5bb21672df2cd5fe');
    expect(hash(documentCanonical(document()))).toBe('fdb2443a0385b68881d53817edcf4e292b1ad6c5ed013d91f66e3cfdb964b2b9');
  });
  it('binds source, fixed table specification, retained bytes and view dimensions separately', () => {
    const baseline = hash(resultCanonical(view()));
    for (const change of [v => { v.source.projectId = 'proj_' + '0'.repeat(16); }, v => { v.spec.offset++; }, v => { v.blobBytes++; }, v => { v.blobSha256 = 'd'.repeat(64); }]) {
      const v = view(); change(v); expect(hash(resultCanonical(v))).not.toBe(baseline);
    }
    const image = { ...view(), family: 'image', spec: null, width: 4000, height: 3000, blobBytes: L.imageBytes };
    expect(resultCanonical(image)).toContain('"family":"image"');
    large(() => resultCanonical({ ...image, height: 3001 }));
  });
  it.each([
    ['self hash', v => { v.viewSha256 = 'a'.repeat(64); }], ['unbounded table', v => { v.spec.limit = 101; }],
    ['source substitution', v => { v.source.path = '/private'; }], ['table dimensions', v => { v.width = 1; }],
    ['oversized table', v => { v.blobBytes = L.tableBytes + 1; }], ['nonfinite bytes', v => { v.blobBytes = Infinity; }],
    ['source checksum', v => { v.source.sha256 = 'invalid'; }], ['unsupported schema', v => { v.schema = 'latest'; }],
  ])('rejects fixed result %s', (_, change) => { const v = view(); change(v); invalid(() => resultCanonical(v)); });
  it('preserves existing notebook canonical bytes instead of sorted source rewriting', () => {
    const source = { schema: 'traceomics.notebook.v1', defaultLanguage: 'R', cells: [{ id: 'code_1', type: 'code', language: 'R', source: '\tprint(ncol(x))  \r\n', metadata: {}, collapsed: false }], metadata: {} };
    const bytes = canonicalNotebookContent(source), d = document();
    d.source.sha256 = hash(bytes); d.blobSha256 = hash(bytes); d.blobBytes = Buffer.byteLength(bytes);
    expect(documentCanonical(d)).toContain(d.blobSha256);
    expect(canonicalNotebookContent(source)).not.toBe(canonicalSnapshotJson(source));
    expect(JSON.parse(bytes).cells[0].source).toBe('\tprint(ncol(x))  \r\n');
    invalid(() => documentCanonical({ ...d, blobSha256: '0'.repeat(64) }));
  });
});

describe('immutable private package metadata contract', () => {
  it('canonicalizes one closed package and excludes mutable policy fields', () => {
    const p = readyPackage(), original = clone(p), canonicalValue = packageCanonical(p);
    expect(canonicalValue).toBe(canonicalSnapshotJson(p)); expect(p).toEqual(original);
    expect(canonicalValue).not.toMatch(/visibility|storageKey|relativePath|canPrepare/);
    invalid(() => packageCanonical({ ...p, availability: 'available' }));
  });
  it.each(['org.ietf.csv', 'org.iana.tsv', 'org.w3.png', 'org.iso.jpeg'])('supports owned attached %s without arbitrary metadata', format => {
    const p = readyPackage(), r = p.results[0]; r.source.format.id = format;
    if (['org.w3.png', 'org.iso.jpeg'].includes(format)) r.view = { schema: FIXED_RESULT_VIEW_SCHEMA, family: 'image', spec: null,
      width: 20, height: 10, blobSha256: r.source.sha256, blobBytes: r.source.sizeBytes, viewSha256: 'f'.repeat(64) };
    expect(packageCanonical(p)).toContain(format);
  });
  it('retains legitimate copied astral text under the original codepoint contracts', () => {
    const p = readyPackage(); p.analysis.name = '😀'.repeat(160); p.analysis.description = '😀'.repeat(8000);
    p.results[0].attachment.caption = '😀'.repeat(2000); p.results[0].attachment.suppliedOrigin.origin = '😀'.repeat(2000);
    p.documents[0].title = '😀'.repeat(160);
    expect(packageCanonical(p)).toContain('😀');
  });
  it('preserves the owning analysis/document/artifact ASCII-control policy for saved C1 text', () => {
    const p = readyPackage(); p.analysis.name = 'Saved\u0085name'; p.analysis.description = 'Saved\u0085description';
    p.documents[0].title = 'Saved\u0085source'; p.results[0].source.name = 'saved\u0085.csv';
    expect(packageCanonical(p)).toContain('\u0085');
  });
  it('keeps caption author separate from original source owner', () => {
    expect(readyPackage().results[0].attachment.createdByUserId).toBe(9);
    expect(packageCanonical(readyPackage())).toContain('"sourceOwnerUserId":7');
    const p = readyPackage(); p.results[0].attachment.sourceOwnerUserId = 9; invalid(() => packageCanonical(p));
  });
  it('counts a repeated exact source only once while retaining distinct fixed excerpts', () => {
    const p = readyPackage(); p.results[0].source.sizeBytes = L.originalBytes;
    const second = clone(p.results[0]); second.viewId = 'asv_' + '3'.repeat(24); second.view.spec.offset = 50; p.results.push(second);
    expect(packageCanonical(p)).toContain('"offset":50');
    second.source.versionId = 'av_' + '0'.repeat(24); second.source.sizeBytes = 1;
    large(() => packageCanonical(p));
  });
  it('bounds retained aggregate even when every raster/document fits individually', () => {
    const p = readyPackage(); p.results = Array.from({ length: 3 }, (_, i) => {
      const r = clone(p.results[0]); r.viewId = 'asv_' + String(i + 3).repeat(24); r.source.versionId = 'av_' + String(i + 3).repeat(24);
      r.attachment.revisionId = 'rar_' + String(i + 3).repeat(24); r.source.sizeBytes = L.imageBytes; r.source.format.id = 'org.w3.png';
      r.view = { schema: FIXED_RESULT_VIEW_SCHEMA, family: 'image', spec: null, width: 10, height: 10,
        blobSha256: r.source.sha256, blobBytes: L.imageBytes, viewSha256: 'f'.repeat(64) }; return r;
    });
    p.documents[0].blobBytes = L.documentBytes; p.documents[0].contentBytes = L.documentBytes;
    p.documents.push({ ...p.documents[0], viewId: 'asv_' + '9'.repeat(24), versionId: 'dv_' + '9'.repeat(24) });
    large(() => packageCanonical(p));
  });
  it.each([
    ['source storage key', p => { p.results[0].source.storageKey = 'private'; }],
    ['arbitrary format metadata', p => { p.results[0].source.format.metadata = { path: 'private' }; }],
    ['source format mismatch', p => { p.results[0].source.format.id = 'org.w3.png'; }],
    ['changed raster bytes', p => { const r = p.results[0]; r.source.format.id = 'org.w3.png'; r.view.family = 'image'; r.view.spec = null; r.view.width = 1; r.view.height = 1; }],
    ['missing context', p => { delete p.results[0].attachment; }], ['unverified owner transfer', p => { p.results[0].attachment.sourceOwnerUserId = 9; }],
    ['duplicate view identity', p => { p.documents[0].viewId = p.results[0].viewId; }],
    ['duplicate result selection', p => { p.results.push({ ...clone(p.results[0]), viewId: 'asv_' + '9'.repeat(24) }); }],
    ['changed canonical caption', p => { p.results[0].attachment.caption = '  changed  '; }],
    ['execution certification', p => { p.reproduction.status = 'reproducible'; }], ['runtime capture claim', p => { p.reproduction.runtime = 'included'; }],
    ['producing code claim', p => { p.documents[0].producingSource = 'verified'; }], ['document bytes mismatch', p => { p.documents[0].contentBytes++; }],
    ['unbound source bytes', p => { p.documents[0].blobSha256 = '0'.repeat(64); }], ['bad timestamp', p => { p.createdAt = '2026-02-30T12:00:00.000Z'; }],
    ['noncanonical notes', p => { p.notes.summary = '  edited  '; }], ['prerequisite proof claim', p => { p.prerequisites.declaration = 'verified'; }],
    ['unselected private references', p => { p.analysis.references = []; }], ['later mutable head', p => { p.analysis.headVersion = 3; }],
  ])('rejects %s', (_, change) => { const p = readyPackage(); change(p); invalid(() => packageCanonical(p)); });
});
