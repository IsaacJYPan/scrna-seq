import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import * as legacy from '../shared/analysisSnapshotPreparation.mjs';
import { ANALYSIS_SNAPSHOT_PREPARATION_SCHEMA_V2, ANALYSIS_SNAPSHOT_PACKAGE_SCHEMA_V2,
  FIXED_RESULT_VIEW_SCHEMA_V2, ANALYSIS_SNAPSHOT_LINKED_LIMITS, normalizeAnalysisSnapshotPreparation as normalize,
  canonicalAnalysisSnapshotPreparation as canonical, canonicalAnalysisSnapshotPackage as packageCanonical,
  canonicalAnalysisSnapshotResultView as viewCanonical, canonicalSnapshotJson } from '../shared/analysisSnapshotPreparationDispatch.mjs';
import { linkedRecipe, linkedRecord, linkedReference, linkedImageResult } from '../src/analyses/snapshotLinkedTestFixtures';
import { snapshotRecipe, snapshotRecord } from '../src/analyses/snapshotPreparationTestFixtures';

const hash = value => createHash('sha256').update(value).digest('hex');
const clone = value => structuredClone(value);
const referencePrerequisite = reference => ({ kind: 'analysis-reference', reference, label: 'Exact external dependency', detail: null });
const checkpoint = () => ({ kind: 'analysis-object', analysisObjectId: 'ao_' + 'c'.repeat(16), checkpointVersionId: 'art_' + 'd'.repeat(24), sha256: 'e'.repeat(64) });
const workflow = () => ({ kind: 'workflow-snapshot', snapshotId: 'wfs_' + 'f'.repeat(24), sha256: 'b'.repeat(64) });
const literal = '{"schema":"traceomics.analysis-snapshot-preparation.v2","serviceId":"svc_11111111111111111111111111111111","projectId":"proj_2222222222222222","analysisId":"ra_333333333333333333333333","ownerUserId":7,"requestId":"12345678-1234-4234-8234-123456789abc","analysisVersion":2,"results":[{"kind":"analysis-reference","reference":{"kind":"artifact-version","versionId":"art_444444444444444444444444","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"caption":"Linked measured result","view":{"family":"table","offset":0,"limit":25}}],"documents":[],"notes":{"summary":null,"decisions":null,"limitations":null},"prerequisites":[]}';

describe('linked snapshot request compatibility', () => {
  it('pins a distinct explicit version while retaining old budgets and ID namespace', () => {
    expect(ANALYSIS_SNAPSHOT_PREPARATION_SCHEMA_V2).toBe('traceomics.analysis-snapshot-preparation.v2');
    expect(ANALYSIS_SNAPSHOT_PACKAGE_SCHEMA_V2).toBe('traceomics.analysis-snapshot-package.v2');
    expect(FIXED_RESULT_VIEW_SCHEMA_V2).toBe('traceomics.fixed-result-view.v2');
    expect(ANALYSIS_SNAPSHOT_LINKED_LIMITS).toEqual({ caption: 2000, label: 160, detail: 1000, sourceName: 200, optionLabel: 200 });
    expect(Object.isFrozen(ANALYSIS_SNAPSHOT_LINKED_LIMITS)).toBe(true);
  });
  it('matches an independent literal ordered canonical request and stable digest', () => {
    const value = linkedRecipe({ documents: [] });
    expect(canonical(value)).toBe(literal);
    expect(hash(canonical(value))).toBe('dca8140b007a6c13c451f80c18b23d8ddb64ec857ceaaf5430498ff232aaf60b');
    const reversed = Object.fromEntries(Object.entries(value).reverse());
    expect(canonical(reversed)).toBe(literal);
  });
  it('delegates every legacy request/package/view byte unchanged', () => {
    const recipe = snapshotRecipe(), full = snapshotRecord(recipe), item = full.package.results[0];
    expect(normalize(recipe)).toEqual(legacy.normalizeAnalysisSnapshotPreparation(recipe));
    expect(canonical(recipe)).toBe(legacy.canonicalAnalysisSnapshotPreparation(recipe));
    expect(packageCanonical(full.package)).toBe(legacy.canonicalAnalysisSnapshotPackage(full.package));
    const { viewSha256: _hash, ...view } = item.view; void _hash;
    const input = { ...view, source: { artifactId: item.source.artifactId, versionId: item.source.versionId, projectId: recipe.projectId, sha256: item.source.sha256 } };
    expect(viewCanonical(input)).toBe(legacy.canonicalAnalysisSnapshotResultView(input));
    expect(() => legacy.normalizeAnalysisSnapshotPreparation(linkedRecipe())).toThrow();
  });
  it.each(['av', 'art', 'eri'])('accepts existing exact %s reference IDs without inventing an attachment', prefix => {
    const value = linkedRecipe({ results: [{ ...linkedRecipe().results[0], reference: linkedReference({ versionId: prefix + '_' + '4'.repeat(24) }) }] });
    expect(normalize(value).results[0]).not.toHaveProperty('attachmentId'); expect(canonical(value)).toContain(prefix + '_');
  });
  it('supports mixed attachment/direct origins and preserves request array order', () => {
    const attached = { kind: 'attachment-revision', ...snapshotRecipe().results[0] }, direct = linkedRecipe().results[0];
    const value = linkedRecipe({ results: [attached, direct] });
    expect(normalize(value).results.map(item => item.kind)).toEqual(['attachment-revision', 'analysis-reference']);
    expect(canonical(value)).not.toBe(canonical({ ...value, results: [direct, attached] }));
  });
  it('allows distinct excerpts of one exact source but rejects caption-only duplication', () => {
    const direct = linkedRecipe().results[0];
    expect(normalize({ ...linkedRecipe(), results: [direct, { ...direct, view: { ...direct.view, offset: 25 } }] }).results).toHaveLength(2);
    expect(() => normalize({ ...linkedRecipe(), results: [direct, { ...direct, caption: 'Different words' }] })).toThrow();
  });
  it.each([linkedReference(), checkpoint(), workflow()])('records exact reference-only prerequisite %j', ref => {
    const value = linkedRecipe({ prerequisites: [referencePrerequisite(ref)] });
    expect(normalize(value).prerequisites[0].reference).toEqual(ref);
    expect(() => normalize({ ...value, prerequisites: [value.prerequisites[0], { ...value.prerequisites[0], label: 'Different caption' }] })).toThrow();
  });
  it('keeps source references as prerequisites without treating them as result grants', () => {
    const value = linkedRecipe({ prerequisites: [referencePrerequisite(linkedReference()), { kind: 'compute', label: 'SSH account', detail: 'Obtain your own access.' }] });
    expect(normalize(value).prerequisites).toHaveLength(2);
  });
  it('normalizes supplied captions/notes/prerequisites using bounded UTF16', () => {
    const value = linkedRecipe(); value.requestId = value.requestId.toUpperCase(); value.results[0].caption = '  α\r\nβ  ';
    value.prerequisites = [{ kind: 'other', label: '  Instrument  ', detail: '  Calibration\r\nrecord  ' }];
    expect(normalize(value)).toMatchObject({ requestId: value.requestId.toLowerCase(), results: [{ caption: 'α\nβ' }], prerequisites: [{ label: 'Instrument', detail: 'Calibration\nrecord' }] });
    value.results[0].caption = '🧬'.repeat(1000); expect(normalize(value).results[0].caption.length).toBe(2000);
    value.results[0].caption += 'a'; expect(() => normalize(value)).toThrow();
  });
  it.each([
    ['unknown schema', value => { value.schema = 'traceomics.analysis-snapshot-preparation.v3'; }],
    ['unknown field', value => { value.sourcePath = '/private/source'; }],
    ['missing explicit schema', value => { delete value.schema; }],
    ['caption controls', value => { value.results[0].caption = 'hidden\u200bcaption'; }],
    ['unpaired Unicode', value => { value.results[0].caption = '\ud800'; }],
    ['zero findings', value => { value.results = []; }],
    ['too many findings', value => { value.results = Array.from({ length: 9 }, (_, i) => ({ ...value.results[0], view: { family: 'table', offset: i, limit: 25 } })); }],
    ['nonartifact finding', value => { value.results[0].reference = checkpoint(); }],
    ['attachment nonmanaged source', value => { value.results = [{ kind: 'attachment-revision', ...snapshotRecipe().results[0], reference: linkedReference() }]; }],
    ['unbounded rows', value => { value.results[0].view.limit = 101; }],
    ['negative window', value => { value.results[0].view.offset = -1; }],
    ['client MIME', value => { value.results[0].view.mime = 'text/html'; }],
    ['future document ref', value => { value.prerequisites = [referencePrerequisite({ kind: 'document-version', documentId: 'doc_' + '1'.repeat(24), versionId: 'dv_' + '2'.repeat(24), sha256: 'a'.repeat(64) })]; }],
    ['client grant', value => { value.prerequisites = [{ ...referencePrerequisite(checkpoint()), dataAccess: 'granted' }]; }],
    ['source URL', value => { value.prerequisites = [{ kind: 'data', label: 'x', detail: null, url: 'https://example.com' }]; }],
    ['reference extra key', value => { value.results[0].reference.ownerUserId = 7; }],
  ])('rejects %s', (_label, change) => { const value = linkedRecipe(); change(value); expect(() => normalize(value)).toThrow(); });
  it('does not invoke getters, toJSON or sparse/foreign prototypes during schema dispatch', () => {
    const getter = vi.fn(() => ANALYSIS_SNAPSHOT_PREPARATION_SCHEMA_V2), value = linkedRecipe();
    Object.defineProperty(value, 'schema', { enumerable: true, get: getter }); expect(() => normalize(value)).toThrow(); expect(getter).not.toHaveBeenCalled();
    const nested = linkedRecipe(), nestedGetter = vi.fn(() => 'title'); Object.defineProperty(nested.results[0], 'caption', { enumerable: true, get: nestedGetter });
    expect(() => normalize(nested)).toThrow(); expect(nestedGetter).not.toHaveBeenCalled();
    const json = vi.fn(); expect(() => normalize({ ...linkedRecipe(), toJSON: json })).toThrow(); expect(json).not.toHaveBeenCalled();
    const sparse = linkedRecipe(); delete sparse.results[0]; expect(() => normalize(sparse)).toThrow();
    const foreign = Object.assign(Object.create({ schema: ANALYSIS_SNAPSHOT_PREPARATION_SCHEMA_V2 }), linkedRecipe()); expect(() => normalize(foreign)).toThrow();
  });
});

describe('linked immutable package projection', () => {
  it('supports all four allowed formats with no arbitrary metadata', () => {
    for (const format of ['org.ietf.csv', 'org.iana.tsv', 'org.w3.png', 'org.iso.jpeg']) {
      const image = ['org.w3.png', 'org.iso.jpeg'].includes(format), value = linkedRecord(image ? linkedRecipe({ results: [linkedImageResult()] }) : linkedRecipe()).package;
      value.results[0].source.format.id = format;
      expect(packageCanonical(value)).toBe(canonicalSnapshotJson(value));
    }
  });
  it('preserves legacy copied captions and analysis names by codepoint rather than shrinking history', () => {
    const value = linkedRecord(linkedRecipe({ results: [{ kind: 'attachment-revision', ...snapshotRecipe().results[0] }] })).package;
    value.analysis.name = '🧬'.repeat(160); value.results[0].origin.attachment.caption = '🧬'.repeat(2000);
    expect(() => packageCanonical(value)).not.toThrow();
    value.results[0].origin.attachment.caption += 'a'; expect(() => packageCanonical(value)).toThrow();
  });
  it('hashes fixed views under their own v2 schema and exact scoped source preimage', () => {
    const value = linkedRecord().package, item = value.results[0], { viewSha256, ...view } = item.view;
    const input = { ...view, source: { artifactId: item.source.artifactId, versionId: item.source.versionId, projectId: value.projectId, sha256: item.source.sha256 } };
    expect(hash(viewCanonical(input))).toBe(viewSha256);
    expect(hash(viewCanonical({ ...input, source: { ...input.source, projectId: 'proj_' + '9'.repeat(16) } }))).not.toBe(viewSha256);
    expect(() => legacy.canonicalAnalysisSnapshotResultView(input)).toThrow();
  });
  it('counts a repeated exact source only once for original-byte budget', () => {
    const chosen = linkedRecipe().results[0], value = linkedRecord(linkedRecipe({ results: [chosen, { ...chosen, view: { family: 'table', offset: 25, limit: 25 } }] })).package;
    value.results.forEach(item => { item.source.sizeBytes = 150 * 1024 * 1024; }); expect(() => packageCanonical(value)).not.toThrow();
    value.results[1].source.sha256 = 'f'.repeat(64); value.results[1].origin.reference.sha256 = 'f'.repeat(64); expect(() => packageCanonical(value)).toThrow();
  });
  it.each([
    ['wrong source owner', value => { value.results[0].source.ownerUserId = 8; }],
    ['source path label', value => { value.results[0].source.name = 'private/counts.csv'; }],
    ['source label bound', value => { value.results[0].source.name = 'a'.repeat(201); }],
    ['source format metadata', value => { value.results[0].source.format.metadata = { path: '/private' }; }],
    ['future source format', value => { value.results[0].source.format.id = 'org.ietf.json'; }],
    ['different selected version', value => { value.results[0].origin.analysisVersion++; }],
    ['wrong direct identity', value => { value.results[0].origin.reference.sha256 = 'f'.repeat(64); }],
    ['caption provenance claim', value => { value.results[0].origin.captionOrigin = 'produced'; }],
    ['fabricated attachment', value => { value.results[0].attachment = {}; }],
    ['old fixed schema', value => { value.results[0].view.schema = 'traceomics.fixed-result-view.v1'; }],
    ['arbitrary runtime', value => { value.reproduction.runtime = 'restorable'; }],
    ['time reversal', value => { value.analysis.updatedAt = '2026-10-21T12:00:00.000Z'; }],
    ['reference grant', value => { value.prerequisites = { declaration: 'selected-and-user-supplied', items: [{ ...referencePrerequisite(checkpoint()), role: 'reference-only', reason: 'opaque', integrity: 'verified', dataAccess: 'not-granted' }] }; }],
    ['duplicate view id', value => { value.documents[0].viewId = value.results[0].viewId; }],
  ])('rejects %s', (_label, change) => { const value = clone(linkedRecord().package); change(value); expect(() => packageCanonical(value)).toThrow(); });
});
