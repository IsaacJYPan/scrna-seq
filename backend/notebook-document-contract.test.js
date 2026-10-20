import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  NOTEBOOK_CELL_ID, NOTEBOOK_DOCUMENT_ID, NOTEBOOK_DOCUMENT_LIMITS as limits,
  NOTEBOOK_DOCUMENT_SCHEMA, NOTEBOOK_VERSION_ID, canonicalNotebookContent,
  normalizeNotebookContent, normalizeNotebookCreate, normalizeNotebookSave,
} from '../shared/notebookDocument.mjs';

const requestId = '1c9ca426-9b2d-44d9-b6f1-7f0ad0bafcf7';
const cell = overrides => ({ id: 'cell-1', type: 'code', language: 'R', source: 'summary(object)\n', ...overrides });
const content = overrides => ({ schema: NOTEBOOK_DOCUMENT_SCHEMA, defaultLanguage: 'R', cells: [cell()], ...overrides });
const create = overrides => ({ requestId, title: 'Question', content: content(), ...overrides });
const save = overrides => ({ ...create(), expectedVersion: 1, ...overrides });
const sha = value => createHash('sha256').update(canonicalNotebookContent(value)).digest('hex');
const throwsInput = action => expect(action).toThrow(expect.objectContaining({ code: 'INVALID_NOTEBOOK_DOCUMENT', status: 400 }));
const throwsSize = action => expect(action).toThrow(expect.objectContaining({ code: 'NOTEBOOK_DOCUMENT_TOO_LARGE', status: 413 }));

describe('notebook document source contract', () => {
  it('normalizes an ordinary mixed-language notebook without an execution graph or outputs', () => {
    const result = normalizeNotebookContent(content({ cells: [
      { id: 'intro', type: 'markdown', source: '# Question\n' },
      cell(), cell({ id: 'python_cell', language: 'python', source: 'len(cells)\n', collapsed: true }),
    ] }));
    expect(result.cells.map(item => item.id)).toEqual(['intro', 'cell-1', 'python_cell']);
    expect(result.cells[0]).toEqual({ id: 'intro', type: 'markdown', source: '# Question\n', metadata: {}, collapsed: false });
    expect(result.cells[2]).toMatchObject({ language: 'python', collapsed: true });
    expect(result.metadata).toEqual({});
  });

  it('retains exact CRLF, tabs, trailing whitespace, final newlines and Unicode source', () => {
    const source = '  # β 🧬\r\n\tx <- "é"  \r\n\r\n';
    const input = content({ cells: [cell({ source })] });
    expect(normalizeNotebookContent(input).cells[0].source).toBe(source);
    expect(JSON.parse(canonicalNotebookContent(input)).cells[0].source).toBe(source);
    expect(sha(input)).not.toBe(sha(content({ cells: [cell({ source: source.replaceAll('\r\n', '\n') })] })));
  });

  it('creates identical canonical bytes for metadata key-order changes, defaults and cloned inputs', () => {
    const left = content({ metadata: { z: 1, kernelspec: { name: 'ir', display_name: 'R' }, unknown: [{ b: false, a: null }] },
      cells: [cell({ metadata: { tags: ['inspection', 'custom'], y: { z: 1, a: 'kept' } } })] });
    const right = content({ metadata: { unknown: [{ a: null, b: false }], kernelspec: { display_name: 'R', name: 'ir' }, z: 1 },
      cells: [cell({ metadata: { y: { a: 'kept', z: 1 }, tags: ['inspection', 'custom'] }, collapsed: false })] });
    expect(canonicalNotebookContent(left)).toBe(canonicalNotebookContent(right));
    expect(sha(left)).toBe(sha(structuredClone(right)));
    expect(canonicalNotebookContent(content())).toBe(canonicalNotebookContent(content({ metadata: {}, cells: [cell({ metadata: {}, collapsed: false })] })));
  });

  it('preserves array and cell order and stable IDs instead of sorting scientific source', () => {
    const first = cell({ id: 'first' }), second = cell({ id: 'second', source: 'x + 1' });
    const initial = content({ cells: [first, second], metadata: { tags: ['a', 'b'] } });
    expect(normalizeNotebookContent(content({ cells: [second, first] })).cells.map(item => item.id)).toEqual(['second', 'first']);
    expect(sha(initial)).not.toBe(sha(content({ cells: [second, first], metadata: initial.metadata })));
    expect(sha(initial)).not.toBe(sha({ ...initial, metadata: { tags: ['b', 'a'] } }));
    expect(sha(initial)).not.toBe(sha({ ...initial, cells: [first, { ...second, id: 'duplicate-copy' }] }));
  });

  it('never mutates caller metadata/source and safely retains prototype-named inert keys', () => {
    const metadata = JSON.parse('{"__proto__":{"preserved":true},"constructor":{"x":1},"toJSON":"inert"}');
    const input = content({ metadata });
    const before = JSON.stringify(input), normalized = normalizeNotebookContent(input);
    expect(JSON.stringify(input)).toBe(before);
    expect(Object.getPrototypeOf(normalized.metadata)).toBe(Object.prototype);
    expect(Object.hasOwn(normalized.metadata, '__proto__')).toBe(true);
    expect(JSON.parse(canonicalNotebookContent(input)).metadata.__proto__).toEqual({ preserved: true });
    normalized.metadata.constructor.x = 2;
    expect(metadata.constructor.x).toBe(1);
    expect({}.preserved).toBeUndefined();
  });

  it('accepts blank notebooks and exactly 2000 individually identified cells', () => {
    expect(normalizeNotebookContent(content({ cells: [] })).cells).toEqual([]);
    const cells = Array.from({ length: limits.cells }, (_, index) => cell({ id: `cell-${index}`, source: '' }));
    expect(normalizeNotebookContent(content({ cells })).cells).toHaveLength(limits.cells);
    throwsSize(() => normalizeNotebookContent(content({ cells: [...cells, cell({ id: 'overflow' })] })));
  });

  it('supports the declared 1000-cell performance shape within the explicit byte budget', () => {
    const cells = Array.from({ length: 1000 }, (_, index) => index % 5 === 0
      ? { id: `cell-${index}`, type: 'markdown', source: `## Inspection ${index}\n` }
      : cell({ id: `cell-${index}`, source: `# Unexecuted cell ${index}\nvalue_${index} <- seq_len(100)\nsummary(value_${index})\n` }));
    const canonical = canonicalNotebookContent(content({ cells }));
    expect(JSON.parse(canonical).cells).toHaveLength(1000);
    expect(Buffer.byteLength(canonical)).toBeGreaterThan(100 * 1024);
    expect(Buffer.byteLength(canonical)).toBeLessThan(limits.contentBytes);
    expect(limits.bodyBytes).toBeGreaterThan(limits.contentBytes);
  });

  it('measures source limits in UTF-8 bytes, not JavaScript character counts', () => {
    const exact = '🧬'.repeat(limits.sourceBytes / 4);
    expect(normalizeNotebookContent(content({ cells: [cell({ source: exact })] })).cells[0].source).toBe(exact);
    throwsSize(() => normalizeNotebookContent(content({ cells: [cell({ source: exact + 'a' })] })));
  });

  it('bounds the full canonical JSON including source escaping and cell structure', () => {
    const base = content({ cells: Array.from({ length: 4 }, (_, index) => cell({ id: `cell-${index}`, source: '' })) });
    const overhead = Buffer.byteLength(canonicalNotebookContent(base));
    const remaining = limits.contentBytes - overhead;
    const cells = base.cells.map((item, index) => ({ ...item, source: 'a'.repeat(Math.floor(remaining / 4) + (index < remaining % 4 ? 1 : 0)) }));
    expect(Buffer.byteLength(canonicalNotebookContent({ ...base, cells }))).toBe(limits.contentBytes);
    throwsSize(() => canonicalNotebookContent({ ...base, cells: [{ ...cells[0], source: cells[0].source + 'a' }, ...cells.slice(1)] }));
    const escaped = content({ cells: Array.from({ length: 3 }, (_, index) => cell({ id: `cell-${index}`, source: '\t'.repeat(limits.sourceBytes) })) });
    throwsSize(() => canonicalNotebookContent(escaped));
  });

  it('rejects identity/ownership/output/execution fields instead of persisting opaque bytes', () => {
    for (const extra of [{ id: 'doc_foreign' }, { outputs: [] }, { references: [] }, { execution: {} }]) {
      throwsInput(() => normalizeNotebookContent({ ...content(), ...extra }));
    }
    for (const extra of [{ execution_count: 1 }, { outputs: [] }, { ownerUserId: 2 }, { attachments: { raw: 'bytes' } }]) {
      throwsInput(() => normalizeNotebookContent(content({ cells: [cell(extra)] })));
    }
  });

  it('rejects duplicate or malformed cell IDs without replacing them', () => {
    throwsInput(() => normalizeNotebookContent(content({ cells: [cell(), cell()] })));
    for (const id of ['', 'a'.repeat(65), 'space id', 'a/b', '🧬']) throwsInput(() => normalizeNotebookContent(content({ cells: [cell({ id })] })));
    expect(NOTEBOOK_CELL_ID.test('x'.repeat(64))).toBe(true);
  });

  it('requires recognized explicit code languages and correct markdown/source fields', () => {
    for (const language of [undefined, 'r', 'Python', 'javascript', null]) throwsInput(() => normalizeNotebookContent(content({ cells: [cell({ language })] })));
    throwsInput(() => normalizeNotebookContent(content({ defaultLanguage: 'r' })));
    throwsInput(() => normalizeNotebookContent(content({ cells: [cell({ type: 'markdown' })] })));
    throwsInput(() => normalizeNotebookContent(content({ cells: [cell({ type: 'raw' })] })));
    throwsInput(() => normalizeNotebookContent(content({ cells: [cell({ collapsed: 'false' })] })));
    for (const source of [undefined, null, 1, '\ud800', 'a\0b']) throwsInput(() => normalizeNotebookContent(content({ cells: [cell({ source })] })));
  });

  it('rejects malformed schema, top-level arrays, sparse cells and accessors', () => {
    throwsInput(() => normalizeNotebookContent(content({ schema: 'nbformat4' })));
    throwsInput(() => normalizeNotebookContent([]));
    throwsInput(() => normalizeNotebookContent(content({ cells: new Array(1) })));
    const accessor = { ...cell() }; Object.defineProperty(accessor, 'source', { get() { throw new Error('must not invoke'); }, enumerable: true });
    throwsInput(() => normalizeNotebookContent(content({ cells: [accessor] })));
  });
});

describe('bounded inert notebook metadata', () => {
  it('retains ordinary unknown notebook/cell metadata while canonicalizing negative zero', () => {
    const input = content({ metadata: { kernelspec: { name: 'ir', display_name: 'R', language: 'R' }, language_info: { name: 'R' }, custom: { flag: true, values: [null, -0, 2.5] } }, cells: [cell({ metadata: { tags: ['inspection'], extensions: { custom: 'retained' } } })] });
    const normalized = normalizeNotebookContent(input);
    expect(normalized.metadata.custom.values).toEqual([null, 0, 2.5]);
    expect(Object.is(normalized.metadata.custom.values[1], -0)).toBe(false);
    expect(normalized.cells[0].metadata.extensions).toEqual({ custom: 'retained' });
  });

  it('rejects functions, undefined, bigint, nonfinite numbers and non-JSON objects', () => {
    for (const value of [undefined, () => 1, 1n, NaN, Infinity, -Infinity, new Date(), new Map(), /x/]) {
      throwsInput(() => normalizeNotebookContent(content({ metadata: { unknown: value } })));
    }
    throwsInput(() => normalizeNotebookContent(content({ metadata: [] })));
    throwsInput(() => normalizeNotebookContent(content({ metadata: { key: '\udfff' } })));
    throwsInput(() => normalizeNotebookContent(content({ metadata: { ['bad\0key']: 'x' } })));
  });

  it('rejects cycles, sparse arrays, symbol fields and getters without invoking them', () => {
    const cycle = {}; cycle.self = cycle;
    throwsInput(() => normalizeNotebookContent(content({ metadata: cycle })));
    const array = []; array.push(array);
    throwsInput(() => normalizeNotebookContent(content({ metadata: { array } })));
    throwsInput(() => normalizeNotebookContent(content({ metadata: { array: new Array(1) } })));
    throwsInput(() => normalizeNotebookContent(content({ metadata: { [Symbol('hidden')]: 1 } })));
    const accessor = {}; Object.defineProperty(accessor, 'x', { get() { throw new Error('must not invoke'); }, enumerable: true });
    throwsInput(() => normalizeNotebookContent(content({ metadata: accessor })));
  });

  it('allows repeated inert subobjects but bounds nesting before recursive serialization', () => {
    const shared = { keep: 'value' };
    expect(normalizeNotebookContent(content({ metadata: { a: shared, b: shared } })).metadata).toEqual({ a: shared, b: shared });
    let accepted = { leaf: true };
    for (let index = 0; index < limits.metadataDepth; index++) accepted = { next: accepted };
    expect(() => normalizeNotebookContent(content({ metadata: accepted }))).not.toThrow();
    throwsInput(() => normalizeNotebookContent(content({ metadata: { next: accepted } })));
  });

  it('bounds document and cell metadata UTF-8 JSON independently', () => {
    const docValue = 'a'.repeat(limits.documentMetadataBytes - Buffer.byteLength('{"key":""}'));
    expect(normalizeNotebookContent(content({ metadata: { key: docValue } })).metadata.key).toBe(docValue);
    throwsSize(() => normalizeNotebookContent(content({ metadata: { key: docValue + 'a' } })));
    const cellValue = 'a'.repeat(limits.cellMetadataBytes - Buffer.byteLength('{"key":""}'));
    expect(normalizeNotebookContent(content({ cells: [cell({ metadata: { key: cellValue } })] })).cells[0].metadata.key).toBe(cellValue);
    throwsSize(() => normalizeNotebookContent(content({ cells: [cell({ metadata: { key: cellValue + 'a' } })] })));
  });

  it('bounds total metadata values across many small cells', () => {
    const cells = Array.from({ length: 1700 }, (_, index) => cell({ id: `cell-${index}`, source: '', metadata: { values: [1, 2, 3, 4, 5] } }));
    throwsSize(() => normalizeNotebookContent(content({ cells })));
  });
});

describe('notebook create/save input identity', () => {
  it('normalizes the same UUID and content identically for a lost-reply retry', () => {
    const initial = normalizeNotebookCreate(create({ requestId: requestId.toUpperCase(), title: ' Question ' }));
    expect(initial).toEqual(normalizeNotebookCreate(create()));
    const saved = normalizeNotebookSave(save({ requestId: requestId.toUpperCase(), title: ' Question ' }));
    expect(saved).toEqual(normalizeNotebookSave(save()));
    expect(saved.expectedVersion).toBe(1);
    expect(initial.requestId).toBe(requestId);
  });

  it('preserves changed source, title and base as distinct idempotency inputs', () => {
    const initial = normalizeNotebookSave(save());
    expect(normalizeNotebookSave(save({ expectedVersion: 2 }))).not.toEqual(initial);
    expect(normalizeNotebookSave(save({ title: 'Different question' }))).not.toEqual(initial);
    expect(normalizeNotebookSave(save({ content: content({ cells: [cell({ source: 'changed\n' })] }) }))).not.toEqual(initial);
    expect(canonicalNotebookContent(initial.content)).toBe(canonicalNotebookContent(normalizeNotebookSave(save({ title: 'Different question' })).content));
  });

  it('rejects server-managed fields, malformed UUIDs and absent/unsafe CAS versions', () => {
    for (const request of [{ ...create(), id: `doc_${'a'.repeat(24)}` }, { ...create(), ownerUserId: 2 }, { ...create(), expectedVersion: 1 }]) throwsInput(() => normalizeNotebookCreate(request));
    for (const value of ['', null, 'not-a-uuid']) throwsInput(() => normalizeNotebookCreate(create({ requestId: value })));
    for (const expectedVersion of [undefined, '1', 0, -1, 1.5, Number.MAX_SAFE_INTEGER, 2147483647, Infinity]) throwsInput(() => normalizeNotebookSave(save({ expectedVersion })));
    throwsInput(() => normalizeNotebookSave({ ...save(), versionId: `dv_${'b'.repeat(24)}` }));
  });

  it('bounds and validates human titles separately from exact source strings', () => {
    expect(normalizeNotebookCreate(create({ title: '🧬'.repeat(limits.title) })).title).toBe('🧬'.repeat(limits.title));
    for (const title of ['', '  ', 'x'.repeat(limits.title + 1), 'x\ny', '\ud800', 'x\0y']) throwsInput(() => normalizeNotebookCreate(create({ title })));
    expect(NOTEBOOK_DOCUMENT_ID.test(`doc_${'a'.repeat(24)}`)).toBe(true);
    expect(NOTEBOOK_VERSION_ID.test(`dv_${'a'.repeat(24)}`)).toBe(true);
    expect(NOTEBOOK_DOCUMENT_ID.test(`doc_${'a'.repeat(23)}`)).toBe(false);
  });
});
