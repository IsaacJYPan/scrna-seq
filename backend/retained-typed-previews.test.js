import { describe, expect, it } from 'vitest';
const { RETAINED_TYPED_LIMITS, projectRetainedMetrics, projectRetainedEmbedding, projectRetainedTypedPreview, validateRetainedRasterMetadata } = require('./retainedTypedPreviews');

const source = Object.freeze({ artifactId: 'eri_' + '1'.repeat(24), versionId: 'eri_' + '1'.repeat(24), projectId: 'proj_retained', sha256: 'a'.repeat(64) });
const embedding = count => ({
  x: Array.from({ length: count }, (_, index) => index / 3), y: Array.from({ length: count }, (_, index) => -index / 7),
  ids: Array.from({ length: count }, (_, index) => 'point-' + index), groups: Array.from({ length: count }, (_, index) => index % 2 ? 'treated' : 'control'),
});
const typed = (type, value, changes = {}) => {
  const bytes = Buffer.from(JSON.stringify(value));
  return { source, descriptor: { id: source.versionId, type, sha256: source.sha256, sizeBytes: bytes.length, profileId: 'seurat-5' }, bytes, ...changes };
};

describe('pure retained scalar metric projections', () => {
  it('preserves exact scalar values, source identity and unknown units without asserting integrity or scientific semantics', () => {
    const value = { zero: 0, finite: -1.25, missing: null, passed: false, label: '<script>inert text</script>' };
    const result = projectRetainedMetrics({ source, value });
    expect(result).toEqual({ family: 'metrics', source, semantics: { role: null, title: null }, items: Object.entries(value).map(([key, item]) => ({ key, value: item, label: null, unit: null })) });
    expect(result).not.toHaveProperty('integrityVerified');
    expect(result.source).not.toBe(source);
  });
  it('adds only explicitly declared metric meaning and never guesses units from names', () => {
    const result = projectRetainedMetrics({ source, value: { nCount_RNA: 34, fraction: 0.5 },
      semantics: { role: 'diagnostic', title: 'QC summary', metrics: { fraction: { label: 'Passing fraction', unit: '1' } } } });
    expect(result.items[0]).toMatchObject({ key: 'nCount_RNA', label: null, unit: null });
    expect(result.items[1]).toMatchObject({ label: 'Passing fraction', unit: '1', value: 0.5 });
    expect(() => projectRetainedMetrics({ source, value: { cells: 2 }, semantics: { metrics: { unknown: { unit: 'cells' } } } })).toThrow(/unsupported field/);
  });
  it('preserves explicit unknown semantic values as unknown rather than inventing defaults', () => {
    expect(projectRetainedMetrics({ source, value: { score: 1 }, semantics: { role: null, title: null, metrics: { score: { label: null, unit: null } } } }).items)
      .toEqual([{ key: 'score', value: 1, label: null, unit: null }]);
    expect(projectRetainedEmbedding({ source, value: embedding(1), semantics: { role: null, title: null, entityType: null, axes: { x: null, y: { label: null, unit: null } } } }).semantics)
      .toEqual({ role: null, title: null, entityType: null, axes: { x: { label: null, unit: null }, y: { label: null, unit: null } } });
  });
  it.each([NaN, Infinity, -Infinity, undefined, { nested: true }, [1, 2], 2n])('rejects non-scalar/non-finite metric %s', value => {
    expect(() => projectRetainedMetrics({ source, value: { metric: value } })).toThrow(/finite numbers/);
  });
  it('rejects dangerous object shapes and bounds keys, metric counts, text and response bytes without truncating values', () => {
    const values = Object.fromEntries(Array.from({ length: 41 }, (_, index) => ['metric' + index, index]));
    expect(() => projectRetainedMetrics({ source, value: values })).toThrow(/at most 40/);
    expect(() => projectRetainedMetrics({ source, value: { ['m'.repeat(101)]: 1 } })).toThrow(/bounded text/);
    expect(() => projectRetainedMetrics({ source, value: { text: 'x'.repeat(2001) } })).toThrow(/bounded text/);
    expect(() => projectRetainedMetrics({ source, value: JSON.parse('{"__proto__":1}') })).toThrow(/unsupported field/);
    let accessed = false;
    const getter = Object.defineProperty({}, 'value', { enumerable: true, get() { accessed = true; return 1; } });
    expect(() => projectRetainedMetrics({ source, value: getter })).toThrow(/unsupported field/); expect(accessed).toBe(false);
    const enormous = Object.fromEntries(Array.from({ length: 40 }, (_, index) => ['metric' + index, '\u0000'.repeat(2000)]));
    expect(() => projectRetainedMetrics({ source, value: enormous })).toThrow(/response size/);
  });
});

describe('bounded retained embeddings', () => {
  it('preserves a complete source in source order and aligns identifiers, groups and row positions', () => {
    const value = embedding(4), result = projectRetainedEmbedding({ source, value });
    expect(result).toMatchObject({ family: 'embedding', source, x: value.x, y: value.y, ids: value.ids, groups: value.groups, sourceIndices: [0, 1, 2, 3],
      semantics: { role: null, title: null, entityType: null, axes: { x: { label: null, unit: null }, y: { label: null, unit: null } } },
      identity: { kind: 'source-identifiers', scope: 'exact-source-version' },
      sampling: { method: 'none', sourceCount: 4, returnedCount: 4, sampled: false, aggregated: false, budgetLimited: false } });
  });
  it('provides reproducible hash sampling, retains exact point data, and does not mutate the source', () => {
    const value = embedding(400), before = JSON.stringify(value);
    const first = projectRetainedEmbedding({ source, value, pointLimit: 25 });
    expect(projectRetainedEmbedding({ source, value, pointLimit: 25 })).toEqual(first);
    expect(first.sourceIndices).toHaveLength(25);
    expect(new Set(first.ids).size).toBe(25);
    first.sourceIndices.forEach((index, at) => {
      expect(first.ids[at]).toBe(value.ids[index]); expect(first.x[at]).toBe(value.x[index]); expect(first.y[at]).toBe(value.y[index]); expect(first.groups[at]).toBe(value.groups[index]);
    });
    expect(first.sampling).toMatchObject({ method: 'sha256-priority-v1', sourceCount: 400, returnedCount: 25, sampled: true, aggregated: false, stratified: false });
    const larger = projectRetainedEmbedding({ source, value, pointLimit: 50 });
    expect(larger.ids.slice(0, 25)).toEqual(first.ids);
    expect(JSON.stringify(value)).toBe(before);
  });
  it('ranks provided identifiers rather than input array order and changes the sample when exact source identity changes', () => {
    const value = embedding(300), reversed = Object.fromEntries(Object.entries(value).map(([key, items]) => [key, [...items].reverse()]));
    const first = projectRetainedEmbedding({ source, value, pointLimit: 30 });
    const second = projectRetainedEmbedding({ source, value: reversed, pointLimit: 30 });
    expect(second.ids).toEqual(first.ids); expect(second.x).toEqual(first.x); expect(second.groups).toEqual(first.groups);
    expect(second.sourceIndices).toEqual(first.sourceIndices.map(index => value.x.length - 1 - index));
    const changed = projectRetainedEmbedding({ source: { ...source, sha256: 'b'.repeat(64) }, value, pointLimit: 30 });
    expect(changed.ids).not.toEqual(first.ids); expect(changed.source.sha256).toBe('b'.repeat(64));
  });
  it('never invents cell identifiers when only positions exist and handles an empty source honestly', () => {
    const value = { x: [1, 2, 3, 4], y: [5, 6, 7, 8] };
    const result = projectRetainedEmbedding({ source, value, pointLimit: 2 });
    expect(result.ids).toBeNull(); expect(result.identity).toEqual({ kind: 'source-row-positions', scope: 'exact-source-version', indexBase: 0 });
    expect(result.semantics.entityType).toBeNull();
    result.sourceIndices.forEach((index, at) => expect(result.x[at]).toBe(value.x[index]));
    const empty = projectRetainedEmbedding({ source, value: { x: [], y: [] } });
    expect(empty.sampling).toMatchObject({ sourceCount: 0, returnedCount: 0, sampled: false, method: 'none' });
    expect(empty.ids).toBeNull();
  });
  it('keeps declared axes and entity meaning separate from sampling and missing identifiers', () => {
    const result = projectRetainedEmbedding({ source, value: { x: [1], y: [2] },
      semantics: { role: 'primary', title: 'Declared map', entityType: 'observation', axes: { x: { label: 'Dimension A' }, y: { label: 'Position', unit: 'µm' } } } });
    expect(result.semantics).toMatchObject({ role: 'primary', entityType: 'observation', axes: { x: { label: 'Dimension A', unit: null }, y: { unit: 'µm' } } });
    expect(result.ids).toBeNull();
    expect(() => projectRetainedEmbedding({ source, value: { x: [1], y: [2] }, semantics: { entityType: 'guessed-cells' } })).toThrow(/entity type/);
  });
  it('enforces response bytes as well as requested point count and labels the extra reduction', () => {
    const value = embedding(3000);
    value.ids = value.ids.map(id => id + '漢'.repeat(180)); value.groups = value.groups.map(group => group + '界'.repeat(80));
    const result = projectRetainedEmbedding({ source, value, pointLimit: 5000 });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(RETAINED_TYPED_LIMITS.responseBytes);
    expect(result.sampling.returnedCount).toBeGreaterThan(0); expect(result.sampling.returnedCount).toBeLessThan(3000);
    expect(result.sampling).toMatchObject({ sampled: true, budgetLimited: true, sourceCount: 3000, requestedLimit: 5000 });
    expect(result.ids.every(id => value.ids.includes(id))).toBe(true);
  });
  it('reserves the full API envelope allowance without repeated source validation or dropping exact identity', () => {
    const value = embedding(3000);
    value.ids = value.ids.map(id => id + 'x'.repeat(150));
    const version = { ...source, metadata: 'v'.repeat(40000) };
    const fixedEnvelope = { version, integrityVerified: true, preview: null };
    const overhead = Buffer.byteLength(JSON.stringify(fixedEnvelope)) - Buffer.byteLength('null');
    const result = projectRetainedEmbedding({ source, value, pointLimit: 5000, responseBytes: RETAINED_TYPED_LIMITS.responseBytes - overhead });
    expect(Buffer.byteLength(JSON.stringify({ ...fixedEnvelope, preview: result }))).toBeLessThanOrEqual(RETAINED_TYPED_LIMITS.responseBytes);
    expect(result.source).toEqual(source); expect(result.sampling.budgetLimited).toBe(true);
    const tiny = projectRetainedTypedPreview(typed('scatter', embedding(100), { pointLimit: 100, responseBytes: 2048 }));
    expect(Buffer.byteLength(JSON.stringify(tiny))).toBeLessThanOrEqual(2048);
    expect(tiny.sampling).toMatchObject({ budgetLimited: true, sampled: true, sourceCount: 100 });
  });
  it('rejects unsafe response allowances and fails metrics rather than silently truncating scalar data', () => {
    for (const responseBytes of [0, -1, Infinity, 10.5, '1000', RETAINED_TYPED_LIMITS.responseBytes + 1]) {
      expect(() => projectRetainedEmbedding({ source, value: embedding(1), responseBytes })).toThrow(/response allowance/);
    }
    expect(() => projectRetainedMetrics({ source, value: { metric: 'x'.repeat(1000) }, responseBytes: 500 })).toThrow(/response size/);
  });
  it('validates the complete source even when invalid coordinates would not appear in the selected sample', () => {
    const value = embedding(50), sampled = projectRetainedEmbedding({ source, value, pointLimit: 1 });
    const unseen = Array.from({ length: 50 }, (_, index) => index).find(index => index !== sampled.sourceIndices[0]);
    value.x[unseen] = Infinity;
    expect(() => projectRetainedEmbedding({ source, value, pointLimit: 1 })).toThrow(/finite numbers/);
  });
  it.each([
    { x: [1], y: [] }, { x: [1], y: [2], ids: [] }, { x: [1, 2], y: [3, 4], ids: ['same', 'same'] },
    { x: [1], y: [2], ids: [''] }, { x: [1], y: [2], groups: [] }, { x: [1], y: [2], script: 'execute' },
    { x: [1], y: [NaN] }, { x: Array(1), y: [2] },
  ])('rejects malformed embedding input %#', value => {
    expect(() => projectRetainedEmbedding({ source, value })).toThrow();
  });
  it('bounds point requests, total source points, total groups and actual encoded source bytes', () => {
    for (const pointLimit of [0, -1, 1.5, 5001, '20', Infinity]) expect(() => projectRetainedEmbedding({ source, value: embedding(2), pointLimit })).toThrow(/point limit/);
    expect(() => projectRetainedEmbedding({ source, value: { x: Array(100001), y: Array(100001) } })).toThrow(/100000/);
    const grouped = embedding(41); grouped.groups = grouped.groups.map((_, index) => 'group-' + index);
    expect(() => projectRetainedEmbedding({ source, value: grouped })).toThrow(/40 source groups/);
    const huge = embedding(10000); huge.ids = huge.ids.map(id => id + '漢'.repeat(180));
    expect(() => projectRetainedEmbedding({ source, value: huge, pointLimit: 1 })).toThrow(/source JSON/);
  });
  it('supports an admitted 100000-point source without returning the entire coordinate set', () => {
    const value = embedding(100000);
    value.x = value.x.map((_, index) => index); value.y = value.y.map((_, index) => -index);
    expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThanOrEqual(RETAINED_TYPED_LIMITS.sourceJsonBytes);
    const result = projectRetainedEmbedding({ source, value, pointLimit: 100 });
    expect(result.sampling).toMatchObject({ sourceCount: 100000, returnedCount: 100 });
    expect(result.x).toHaveLength(100); expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(RETAINED_TYPED_LIMITS.responseBytes);
  });
});

describe('trusted descriptor and raster metadata boundaries', () => {
  it('dispatches the actual workflow descriptor shape without performing storage or authorization', () => {
    expect(projectRetainedTypedPreview(typed('metrics', { cells: 12 }))).toMatchObject({ family: 'metrics', source });
    expect(projectRetainedTypedPreview(typed('scatter', embedding(3), { pointLimit: 2 }))).toMatchObject({ family: 'embedding', sampling: { sourceCount: 3, returnedCount: 2 } });
  });
  it('rejects source/descriptor mismatches, altered byte sizes, invalid JSON/UTF8 and unbounded source descriptors', () => {
    const input = typed('metrics', { cells: 12 });
    expect(() => projectRetainedTypedPreview({ ...input, descriptor: { ...input.descriptor, sha256: 'b'.repeat(64) } })).toThrow(/does not match/);
    expect(() => projectRetainedTypedPreview({ ...input, descriptor: { ...input.descriptor, id: 'eri_' + '2'.repeat(24) } })).toThrow(/does not match/);
    expect(() => projectRetainedTypedPreview({ ...input, bytes: Buffer.from('{}') })).toThrow(/descriptor size/);
    expect(() => projectRetainedTypedPreview(typed('metrics', null, { bytes: Buffer.from('????') }))).toThrow(/valid UTF-8 JSON/);
    expect(() => projectRetainedTypedPreview({ ...input, bytes: Buffer.from([0xff]), descriptor: { ...input.descriptor, sizeBytes: 1 } })).toThrow(/valid UTF-8 JSON/);
    expect(() => projectRetainedTypedPreview({ ...input, descriptor: { ...input.descriptor, sizeBytes: RETAINED_TYPED_LIMITS.sourceJsonBytes + 1 } })).toThrow(/source JSON/);
    expect(() => projectRetainedMetrics({ source: { ...source, storageKey: '/private/path' }, value: {} })).toThrow(/unsupported field/);
  });
  it('validates common-viewer dimensions and returns only the current namespaced format metadata', () => {
    expect(validateRetainedRasterMetadata({ formatId: 'org.w3.png', width: 4000, height: 3000, sizeBytes: 1000 })).toEqual({
      formatId: 'org.w3.png', width: 4000, height: 3000, pixels: 12000000, boundedBytes: 1000,
      formatMetadata: { 'org.traceomics.image:width': 4000, 'org.traceomics.image:height': 3000 },
    });
    for (const changes of [{ formatId: 'org.w3.svg' }, { width: 0 }, { height: 1.5 }, { width: Infinity }, { sizeBytes: 0 }, { width: 4001, height: 3000 }, { sizeBytes: 5 * 1024 * 1024 + 1 }]) {
      expect(() => validateRetainedRasterMetadata({ formatId: 'org.iso.jpeg', width: 100, height: 200, sizeBytes: 1000, ...changes })).toThrow();
    }
  });
});
