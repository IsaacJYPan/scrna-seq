import { createHash, webcrypto } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import {
  ANALYSIS_SNAPSHOT_PREPARATION_SCHEMA as schema, ANALYSIS_SNAPSHOT_PACKAGE_SCHEMA,
  FIXED_RESULT_VIEW_SCHEMA, FIXED_DOCUMENT_SOURCE_SCHEMA, canonicalAnalysisSnapshotPreparation,
  canonicalSnapshotJson, canonicalAnalysisSnapshotResultView, canonicalAnalysisSnapshotDocumentSource,
} from '../../shared/analysisSnapshotPreparation.mjs';
import { canonicalNotebookContent } from '../../shared/notebookDocument.mjs';
import {
  validateSnapshotPreparationList as list, validateSnapshotPreparationOptions as options,
  validateSnapshotPreparation as full, decodeSnapshotPreparationTable as table,
  decodeSnapshotPreparationDocument as document,
} from './snapshotPreparationValidation';

const hash = value => createHash('sha256').update(value).digest('hex');
const bytes = value => new TextEncoder().encode(value);
const copy = value => structuredClone(value);
const scope = { serviceId: 'svc_' + '1'.repeat(32), projectId: 'proj_' + '2'.repeat(16), analysisId: 'ra_' + '3'.repeat(24), userId: 7 };
const time = '2026-10-22T12:00:00.000Z';
const context = () => ({ origin: null, sourceReference: null, documentReference: null, environmentReference: null });
const content = () => ({ schema: 'traceomics.notebook.v1', defaultLanguage: 'R', cells: [{ id: 'code_one', type: 'code', language: 'R', source: '\tncol(obj)  \r\n', metadata: {}, collapsed: false }], metadata: {} });
const savedTable = () => ({ family: 'table', columns: ['sample', 'value'], rows: [['donor α', '3'], ['donor β', '5']], offset: 0, limit: 2, hasMore: false, scannedRows: 2, truncated: false });
function seal(value) {
  if (value.recipe) value.requestSha256 = hash(canonicalAnalysisSnapshotPreparation(value.recipe));
  if (value.package) {
    value.package.results.forEach(item => {
      const { viewSha256: _viewSha, ...view } = item.view; void _viewSha;
      item.view.viewSha256 = hash(canonicalAnalysisSnapshotResultView({ ...view,
        source: { artifactId: item.source.artifactId, versionId: item.source.versionId, projectId: value.projectId, sha256: item.source.sha256 } }));
    });
    value.package.documents.forEach(item => { item.viewSha256 = hash(canonicalAnalysisSnapshotDocumentSource({ schema: FIXED_DOCUMENT_SOURCE_SCHEMA,
      source: { documentId: item.documentId, versionId: item.versionId, sha256: item.sha256 }, blobSha256: item.blobSha256, blobBytes: item.blobBytes })); });
    value.snapshotSha256 = hash(canonicalSnapshotJson(value.package));
  }
  return value;
}
function fixture() {
  const notebook = canonicalNotebookContent(content()), tableText = canonicalSnapshotJson(savedTable());
  const reference = { kind: 'artifact-version', versionId: 'av_' + '4'.repeat(24), sha256: 'a'.repeat(64) };
  const doc = { documentId: 'doc_' + '5'.repeat(24), versionId: 'dv_' + '6'.repeat(24), sha256: hash(notebook) };
  const recipe = { requestId: '12345678-1234-4234-8234-123456789abc', serviceId: scope.serviceId, projectId: scope.projectId, analysisId: scope.analysisId,
    ownerUserId: 7, analysisVersion: 2, results: [{ attachmentId: 'raa_' + '7'.repeat(24), revisionId: 'rar_' + '8'.repeat(24), reference, view: { family: 'table', offset: 0, limit: 2 } }],
    documents: [doc], notes: { summary: 'Measured PBMC observations', decisions: null, limitations: 'Supplied notes are unverified.' },
    prerequisites: [{ kind: 'data', label: 'Raw counts', detail: 'Original data access is required.' }] };
  const result = { schema, serviceId: scope.serviceId, projectId: scope.projectId, analysisId: scope.analysisId, ownerUserId: 7,
    preparationId: 'asp_' + '9'.repeat(24), requestId: recipe.requestId, requestSha256: '', createdAt: time, updatedAt: time, replayed: false,
    state: 'ready', canPrepare: true, canResume: false, canDelete: true, recipe, snapshotSha256: '', availability: { status: 'available',
      views: [{ viewId: 'asv_' + 'a'.repeat(24), status: 'available' }], documents: [{ documentId: doc.documentId, versionId: doc.versionId, status: 'available' }] }, failure: null,
    package: { schema: ANALYSIS_SNAPSHOT_PACKAGE_SCHEMA, serviceId: scope.serviceId, projectId: scope.projectId, analysisId: scope.analysisId, ownerUserId: 7,
      preparationId: 'asp_' + '9'.repeat(24), createdAt: time,
      analysis: { version: 2, name: 'PBMC contrast', description: 'Which cells differ?', status: 'active', createdByUserId: 7, createdAt: time, updatedAt: time, revisionSha256: 'b'.repeat(64) },
      results: [{ viewId: 'asv_' + 'a'.repeat(24), attachment: { attachmentId: recipe.results[0].attachmentId, revisionId: recipe.results[0].revisionId, revisionNumber: 1,
        caption: 'Measured expression', suppliedOrigin: context(), createdByUserId: 8, createdAt: time, sourceOwnerUserId: 7 },
      source: { artifactId: 'af_' + 'c'.repeat(24), versionId: reference.versionId, sha256: reference.sha256, sizeBytes: 1024, name: 'measured.csv', format: { id: 'org.ietf.csv', version: '1' } },
      view: { schema: FIXED_RESULT_VIEW_SCHEMA, family: 'table', spec: { offset: 0, limit: 2 }, blobSha256: hash(tableText), blobBytes: bytes(tableText).byteLength, viewSha256: '', width: null, height: null } }],
      documents: [{ viewId: 'asv_' + 'd'.repeat(24), ...doc, version: 1, title: 'Supporting source', documentKind: 'notebook', defaultLanguage: 'R', contentBytes: bytes(notebook).byteLength,
        role: 'supporting-source', producingSource: 'not-established', blobSha256: doc.sha256, blobBytes: bytes(notebook).byteLength, viewSha256: '' }],
      notes: copy(recipe.notes), prerequisites: { declaration: 'user-supplied', items: copy(recipe.prerequisites) },
      reproduction: { status: 'not-checked', producingSource: 'not-established', runtime: 'not-included', dataAccess: 'not-granted' } } };
  return seal(result);
}
function summary(value = fixture()) {
  return { preparationId: value.preparationId, requestId: value.requestId, requestSha256: value.requestSha256, createdAt: value.createdAt, updatedAt: value.updatedAt,
    state: value.state, canResume: value.canResume, canDelete: value.canDelete, snapshotSha256: value.snapshotSha256,
    selection: { analysisVersion: 2, analysisName: 'PBMC contrast', resultCount: 1, documentCount: 1, prerequisiteCount: 1 } };
}
const collection = (items = [summary()]) => ({ schema, serviceId: scope.serviceId, projectId: scope.projectId, analysisId: scope.analysisId, ownerUserId: 7, canPrepare: true, items, nextCursor: null });
function chooser(kind = 'results') {
  const p = fixture().package, item = p.results[0], doc = p.documents[0];
  const value = collection(); value.kind = kind;
  value.items = kind === 'analysis-versions' ? [p.analysis] : kind === 'documents' ? [{ documentId: doc.documentId, versionId: doc.versionId, version: doc.version, title: doc.title,
    documentKind: doc.documentKind, defaultLanguage: doc.defaultLanguage, sha256: doc.sha256, contentBytes: doc.contentBytes, actorUserId: 7, createdAt: time,
    role: doc.role, producingSource: doc.producingSource }] : [{ ...item.attachment, reference: copy(fixture().recipe.results[0].reference), source: item.source, families: ['table'], integrity: 'not-checked' }];
  return value;
}
const rejects = promise => expect(promise).rejects.toMatchObject({ code: 'INVALID_SNAPSHOT_PREPARATION_RESPONSE' });
const invalid = action => expect(action).toThrow(expect.objectContaining({ code: 'INVALID_SNAPSHOT_PREPARATION_RESPONSE' }));

describe('strict private preparation receipt', () => {
  it('accepts a bound ready package and independently verifies every digest', async () => {
    const value = fixture(); expect(await full(value, scope, value.recipe)).toEqual(value);
    expect(value.package.results[0].view.blobSha256).not.toBe(value.package.results[0].source.sha256);
    expect(value.package.results[0].view.viewSha256).not.toBe(value.package.results[0].view.blobSha256);
    expect(value.package.documents[0].blobSha256).toBe(value.recipe.documents[0].sha256);
  });
  it('permits archive/reader recovery and missing retained objects without erasing acceptance', async () => {
    const value = fixture(); value.canPrepare = false; value.replayed = true;
    value.availability.views[0].status = 'unavailable'; value.availability.status = 'unavailable';
    expect((await full(value, scope)).snapshotSha256).toBe(value.snapshotSha256);
    expect((await full(value, scope)).canDelete).toBe(true);
  });
  it.each(['preparing', 'failed', 'deleted'])('accepts honest %s state without a package', async state => {
    const value = fixture(); value.state = state; value.package = null; value.availability = null;
    value.canResume = state !== 'deleted'; value.snapshotSha256 = state === 'deleted' ? value.snapshotSha256 : null;
    if (state === 'failed') value.failure = { code: 'SNAPSHOT_SOURCE_UNAVAILABLE', message: 'The original source is unavailable.' };
    if (state === 'deleted') { value.recipe = null; value.canDelete = false; }
    expect((await full(value, scope, fixture().recipe)).state).toBe(state);
  });
  it('allows a deleted not-yet-ready original and never manufactures a snapshot SHA', async () => {
    const value = fixture(); Object.assign(value, { state: 'deleted', package: null, recipe: null, availability: null, snapshotSha256: null, canDelete: false });
    expect((await full(value, scope, fixture().recipe)).snapshotSha256).toBeNull();
  });
  it('binds a fully self-consistent changed recipe back to the original intent', async () => {
    const value = fixture(), original = copy(value.recipe); value.recipe.notes.summary = 'Different findings'; value.package.notes.summary = 'Different findings'; seal(value);
    expect((await full(value, scope)).recipe.notes.summary).toBe('Different findings');
    await rejects(full(value, scope, original));
  });
  it('accepts two excerpts of one source and two exact versions of the same document', async () => {
    const value = fixture(), result = copy(value.package.results[0]), selection = copy(value.recipe.results[0]);
    result.viewId = 'asv_' + 'e'.repeat(24); result.view.spec.offset = 2; selection.view.offset = 2;
    value.package.results.push(result); value.recipe.results.push(selection); value.availability.views.push({ viewId: result.viewId, status: 'available' });
    const doc = copy(value.package.documents[0]); doc.viewId = 'asv_' + 'f'.repeat(24); doc.versionId = 'dv_' + 'f'.repeat(24); doc.version = 2;
    value.package.documents.push(doc); value.recipe.documents.push({ documentId: doc.documentId, versionId: doc.versionId, sha256: doc.sha256 });
    value.availability.documents.push({ documentId: doc.documentId, versionId: doc.versionId, status: 'available' }); seal(value);
    expect((await full(value, scope)).package.results).toHaveLength(2);
  });
  it('captures response, scope and expected recipe before an asynchronous digest race', async () => {
    const value = fixture(), expected = copy(value.recipe), mutableScope = { ...scope };
    let release; const gate = new Promise(resolve => { release = resolve; });
    const digest = vi.spyOn(globalThis.crypto.subtle, 'digest').mockImplementationOnce(async (...args) => { await gate; return webcrypto.subtle.digest(...args); });
    const pending = full(value, mutableScope, expected);
    value.package.analysis.name = 'late mutation'; value.recipe.notes.summary = 'late mutation'; expected.notes.summary = 'late mutation'; mutableScope.serviceId = 'svc_' + '0'.repeat(32);
    release(); const accepted = await pending; digest.mockRestore();
    expect(accepted.package.analysis.name).toBe('PBMC contrast'); expect(accepted.recipe.notes.summary).toBe('Measured PBMC observations');
  });
  it.each([
    ['wrong service', v => { v.serviceId = 'svc_' + '0'.repeat(32); }], ['wrong owner', v => { v.ownerUserId = 8; }],
    ['wrong analysis', v => { v.analysisId = 'ra_' + '0'.repeat(24); }], ['wrong project', v => { v.projectId = 'proj_' + '0'.repeat(16); }],
    ['legacy cleanup flag', v => { v.cleanupPending = false; }], ['client preview grant', v => { v.canDownloadSource = true; }],
    ['request hash', v => { v.requestSha256 = '0'.repeat(64); }], ['snapshot hash', v => { v.snapshotSha256 = '0'.repeat(64); }],
    ['descriptor hash', v => { v.package.results[0].view.viewSha256 = '0'.repeat(64); v.snapshotSha256 = hash(canonicalSnapshotJson(v.package)); }],
    ['document descriptor hash', v => { v.package.documents[0].viewSha256 = '0'.repeat(64); v.snapshotSha256 = hash(canonicalSnapshotJson(v.package)); }],
    ['silent source substitution', v => { v.package.results[0].source.versionId = 'av_' + '0'.repeat(24); seal(v); }],
    ['silent selected-context substitution', v => { v.package.results[0].attachment.revisionId = 'rar_' + '0'.repeat(24); seal(v); }],
    ['silent saved-head substitution', v => { v.package.analysis.version = 3; seal(v); }],
    ['source grant after caption edit', v => { v.package.results[0].attachment.sourceOwnerUserId = 8; seal(v); }],
    ['stale view selection', v => { v.package.results[0].view.spec.offset = 50; seal(v); }],
    ['private import metadata', v => { v.package.results[0].source.sourceImport = { relativePath: 'private.csv' }; seal(v); }],
    ['future producing-source claim', v => { v.package.documents[0].producingSource = 'established'; seal(v); }],
    ['extra immutable visibility', v => { v.package.visibility = 'private'; seal(v); }],
    ['current snapshot permission in scientific package', v => { v.package.canPrepare = true; seal(v); }],
    ['availability mismatch', v => { v.availability.status = 'unavailable'; }], ['unrelated view availability', v => { v.availability.views[0].viewId = 'asv_' + '0'.repeat(24); }],
    ['unrelated document availability', v => { v.availability.documents[0].versionId = 'dv_' + '0'.repeat(24); }],
    ['missing source availability entry', v => { v.availability.documents = []; }],
    ['ready can resume', v => { v.canResume = true; }], ['ready cannot delete own candidate', v => { v.canDelete = false; }],
    ['failure attached to ready', v => { v.failure = { code: 'FAILED', message: 'Failed' }; }], ['invalid replay flag', v => { v.replayed = 'yes'; }],
    ['noncanonical UUID', v => { v.requestId = v.requestId.toUpperCase(); }], ['invalid timestamp', v => { v.updatedAt = '2026-02-30T12:00:00.000Z'; }],
    ['backdated update', v => { v.updatedAt = '2026-10-21T12:00:00.000Z'; }],
  ])('rejects %s', async (_, change) => { const value = fixture(); change(value); await rejects(full(value, scope)); });
  it('requires a bound service for full reads but permits discovery in a list', async () => {
    const { serviceId: _serviceId, ...discovery } = scope; void _serviceId;
    expect(list(collection(), discovery).serviceId).toBe(scope.serviceId); await rejects(full(fixture(), discovery));
  });
  it('rejects getters/prototypes/cycles without invoking source code', async () => {
    let calls = 0; const value = fixture(); Object.defineProperty(value.package.results[0].view, 'blobBytes', { enumerable: true, get() { calls++; return 1; } });
    await rejects(full(value, scope)); expect(calls).toBe(0);
    const cyclic = fixture(); cyclic.package.notes.summary = cyclic; await rejects(full(cyclic, scope));
    const inherited = fixture(); Object.setPrototypeOf(inherited.recipe.notes, { private: true }); await rejects(full(inherited, scope));
  });
});

describe('private preparation discovery and exact chooser options', () => {
  it('accepts closed paged collection and numeric-string auth identity', () => {
    expect(list(collection(), { ...scope, userId: '7' }).items).toHaveLength(1);
    expect(list(collection([]), scope).items).toEqual([]);
  });
  it.each(['analysis-versions', 'results', 'documents'])('accepts real exact %s chooser descriptors', kind => {
    expect(options(chooser(kind), scope, kind).kind).toBe(kind);
  });
  it('keeps all four eligible formats and historical source-owner identity distinct from caption actor', () => {
    for (const format of ['org.ietf.csv', 'org.iana.tsv', 'org.w3.png', 'org.iso.jpeg']) {
      const value = chooser(); value.items[0].source.format.id = format; value.items[0].families = [format.includes('csv') || format.includes('tsv') ? 'table' : 'image'];
      expect(options(value, scope, 'results').items[0].sourceOwnerUserId).toBe(7);
    }
  });
  it('preserves legitimate historical codepoint text', () => {
    const value = chooser(); value.items[0].caption = '😀'.repeat(2000);
    expect(options(value, scope, 'results').items[0].caption).toHaveLength(4000);
    const analyses = chooser('analysis-versions'); analyses.items[0].name = '😀'.repeat(160);
    expect(options(analyses, scope, 'analysis-versions').items[0].name).toHaveLength(320);
    analyses.items[0].name = 'Saved\u0085name'; analyses.items[0].description = 'Saved\u0085description';
    expect(options(analyses, scope, 'analysis-versions').items[0].name).toBe('Saved\u0085name');
  });
  it.each([
    ['more than page', v => { v.items = Array(31).fill(v.items[0]); }], ['bad cursor', v => { v.nextCursor = 'a'.repeat(257); }],
    ['empty cursor page', v => { v.items = []; v.nextCursor = 'abc'; }], ['duplicate UUID', v => { v.items.push(copy(v.items[0])); v.items[1].preparationId = 'asp_' + '8'.repeat(24); }],
    ['duplicate preparation', v => { v.items.push(copy(v.items[0])); }],
    ['deleted listed candidate', v => { v.items[0].state = 'deleted'; v.items[0].canDelete = false; v.items[0].selection = null; }],
    ['newer-first ordering', v => { const item = copy(v.items[0]); item.preparationId = 'asp_' + 'f'.repeat(24); item.requestId = '12345678-1234-4234-8234-123456789abd'; v.items.push(item); }],
    ['wrong summary count', v => { v.items[0].selection.resultCount = 0; }],
    ['closed summary', v => { v.items[0].recipe = fixture().recipe; }],
    ['pending digest claim', v => { v.items[0].state = 'preparing'; v.items[0].canResume = true; }],
  ])('rejects list %s', (_, change) => { const value = collection(); change(value); invalid(() => list(value, scope)); });
  it.each([
    ['unverified format metadata', v => { v.items[0].source.format.metadata = { private: 'path' }; }],
    ['source owner transfer', v => { v.items[0].sourceOwnerUserId = 8; }], ['wrong exact ref', v => { v.items[0].reference.sha256 = '0'.repeat(64); }],
    ['false integrity promise', v => { v.items[0].integrity = 'verified'; }], ['unbounded family', v => { v.items[0].families = ['table', 'image']; }],
    ['wrong family', v => { v.items[0].families = ['image']; }], ['unknown kind', v => { v.kind = 'sources'; }],
    ['opaque RDS source', v => { v.items[0].source.format.id = 'org.r-project.rds'; }],
  ])('rejects chooser %s', (_, change) => { const value = chooser(); change(value); invalid(() => options(value, scope, 'results')); });
});

describe('exact lazy retained table and supporting source decoding', () => {
  it('decodes retained fixed values and literal saved notebook whitespace', async () => {
    const value = fixture(); expect(await table(bytes(canonicalSnapshotJson(savedTable())), value.package.results[0])).toEqual(savedTable());
    expect((await document(bytes(canonicalNotebookContent(content())), value.package.documents[0])).cells[0].source).toBe('\tncol(obj)  \r\n');
  });
  it('accepts native byte arrays from another realm and Node buffers using the same exact checksum', async () => {
    const value = fixture(), serialized = canonicalSnapshotJson(savedTable()), source = bytes(serialized);
    const crossRealm = runInNewContext('new Uint8Array(values)', { values: Array.from(source) });
    expect(crossRealm instanceof Uint8Array).toBe(false);
    expect(await table(crossRealm, value.package.results[0])).toEqual(savedTable());
    expect(await table(Buffer.from(serialized), value.package.results[0])).toEqual(savedTable());
  });
  it('copies native byte arrays without invoking custom iteration, constructor or length getters', async () => {
    const value = fixture(), source = bytes(canonicalSnapshotJson(savedTable())); let calls = 0;
    for (const key of [Symbol.iterator, Symbol.toStringTag, 'constructor', 'byteLength']) {
      Object.defineProperty(source, key, { get() { calls++; throw new Error('Byte property code must not run.'); } });
    }
    expect(await table(source, value.package.results[0])).toEqual(savedTable()); expect(calls).toBe(0);
  });
  it.each(['DataView', 'Uint16Array', 'Uint8ClampedArray', 'ArrayBuffer', 'array'])('rejects %s at the byte boundary', async kind => {
    const value = fixture(), source = bytes(canonicalSnapshotJson(savedTable()));
    const alternative = kind === 'DataView' ? new DataView(source.buffer) : kind === 'Uint16Array' ? new Uint16Array([1, 2])
      : kind === 'Uint8ClampedArray' ? new Uint8ClampedArray(source) : kind === 'ArrayBuffer' ? source.buffer : Array.from(source);
    await rejects(table(alternative, value.package.results[0]));
  });
  it('preserves scientific string controls rather than applying human-note rules to cells', async () => {
    const value = fixture(), body = savedTable(); body.rows[0][0] = '\0\tα\n\u200b';
    const serialized = canonicalSnapshotJson(body); value.package.results[0].view.blobBytes = bytes(serialized).byteLength; value.package.results[0].view.blobSha256 = hash(serialized);
    expect((await table(bytes(serialized), value.package.results[0])).rows[0][0]).toBe('\0\tα\n\u200b');
  });
  it.each([
    ['source query expansion', body => { body.offset = 100; }], ['larger source window', body => { body.limit = 100; }],
    ['unknown field', body => { body.sourcePath = '/private'; }], ['truncated without remaining', body => { body.truncated = true; }],
    ['non-string imported cell', body => { body.rows[0][1] = 3; }], ['row width', body => { body.rows[0].pop(); }],
    ['duplicate headers', body => { body.columns[1] = body.columns[0]; }], ['empty header', body => { body.columns[0] = ' '; }],
    ['wrong family', body => { body.family = 'metrics'; }], ['invalid scanned count', body => { body.scannedRows = 0; }],
    ['unbounded cell', body => { body.rows[0][0] = 'a'.repeat(2001); }], ['false remaining rows', body => { body.hasMore = true; }],
  ])('rejects table %s even with matching blob checksum', async (_, change) => {
    const value = fixture(), body = savedTable(); change(body); const serialized = canonicalSnapshotJson(body), descriptor = value.package.results[0];
    descriptor.view.blobBytes = bytes(serialized).byteLength; descriptor.view.blobSha256 = hash(serialized);
    await rejects(table(bytes(serialized), descriptor));
  });
  it('rejects wrong bytes, source metadata substitution, noncanonical JSON and invalid UTF8', async () => {
    const value = fixture(), descriptor = value.package.results[0];
    await rejects(table(bytes('wrong'), descriptor));
    const serialized = JSON.stringify(savedTable(), null, 2); descriptor.view.blobBytes = bytes(serialized).byteLength; descriptor.view.blobSha256 = hash(serialized);
    await rejects(table(bytes(serialized), descriptor));
    const bad = new Uint8Array([255]); descriptor.view.blobBytes = 1; descriptor.view.blobSha256 = hash(bad); await rejects(table(bad, descriptor));
    const doc = value.package.documents[0]; doc.blobSha256 = '0'.repeat(64); await rejects(document(bytes(canonicalNotebookContent(content())), doc));
  });
  it('rejects reserialized source and producing-kind/language mismatch without executing cells', async () => {
    const value = fixture(), descriptor = value.package.documents[0];
    descriptor.documentKind = 'script'; await rejects(document(bytes(canonicalNotebookContent(content())), descriptor));
    descriptor.documentKind = 'notebook'; descriptor.defaultLanguage = 'python'; await rejects(document(bytes(canonicalNotebookContent(content())), descriptor));
    const sourceText = canonicalSnapshotJson(content()); descriptor.defaultLanguage = 'R'; descriptor.sha256 = hash(sourceText); descriptor.blobSha256 = descriptor.sha256;
    descriptor.blobBytes = bytes(sourceText).byteLength; descriptor.contentBytes = descriptor.blobBytes;
    await rejects(document(bytes(sourceText), descriptor));
  });
});
