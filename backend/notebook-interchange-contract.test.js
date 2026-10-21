import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  importNotebookFile, exportNotebookFile, normalizeInterchangeNotebookContent,
  NOTEBOOK_INTERCHANGE_SCHEMA, NOTEBOOK_INTERCHANGE_LIMITS as limits,
} from '../shared/notebookInterchange.mjs';
import {
  createNotebookInterchangeBudget, normalizeNotebookInterchange, normalizeNotebookImportedCell,
  normalizeNotebookMimeBundle, notebookMimePreview, normalizeNotebookInterchangeContent,
} from '../shared/notebookInterchangeFields.mjs';
import { canonicalNotebookContent, NOTEBOOK_DOCUMENT_SCHEMA, normalizeNotebookContent } from '../shared/notebookDocument.mjs';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB1sAAAAASUVORK5CYII=';
const utf8 = text => new TextEncoder().encode(text).length;
const hash = text => createHash('sha256').update(text).digest('hex');
const code = overrides => ({ id: 'analysis', cell_type: 'code', metadata: {}, source: 'x <- 1\r\n', execution_count: null, outputs: [], ...overrides });
const notebook = overrides => ({ nbformat: 4, nbformat_minor: 5,
  metadata: { kernelspec: { name: 'ir', display_name: 'R', language: 'R' }, language_info: { name: 'R', version: '4.5.1' } },
  cells: [code()], ...overrides });
const read = (input = notebook(), options = {}, idFactory) => importNotebookFile({ filename: 'Research.ipynb', source: JSON.stringify(input), ...options }, idFactory);
const invalid = action => expect(action).toThrow(expect.objectContaining({ status: 400 }));
const tooLarge = action => expect(action).toThrow(expect.objectContaining({ status: 413 }));
const exactMetadata = (existing, limit) => {
  const result = { ...existing, payload: '' };
  result.payload = 'x'.repeat(limit - utf8(JSON.stringify(result)));
  return result;
};

describe('conventional notebook import/export contract', () => {
  it.each([0, 1, 2, 3, 4, 5])('reads supported nbformat 4.%i and exports conventional 4.5 with stable IDs', minor => {
    const cell = code(); if (minor < 5) delete cell.id;
    const imported = read(notebook({ nbformat_minor: minor, cells: [cell] }), {}, index => 'legacy_' + index);
    expect(imported.content).toMatchObject({ schema: NOTEBOOK_INTERCHANGE_SCHEMA, defaultLanguage: 'R',
      metadata: {}, interchange: { filename: 'Research.ipynb', nbformatMinor: minor },
      cells: [{ id: minor < 5 ? 'legacy_0' : 'analysis', type: 'code', language: 'R', source: cell.source, collapsed: false }] });
    const exported = exportNotebookFile(imported.content), file = JSON.parse(exported.text);
    expect(exported).toMatchObject({ filename: 'Research.ipynb', mimeType: 'application/x-ipynb+json' });
    expect(file).toEqual({ nbformat: 4, nbformat_minor: 5, metadata: notebook().metadata,
      cells: [{ ...cell, id: imported.content.cells[0].id }] });
    expect(read(file).content.cells).toEqual(imported.content.cells);
  });

  it.each(['R', 'python'])('round trips a %s notebook with source, narrative, declared kernel and historical outputs', language => {
    const metadata = { language_info: { name: language, version: 'declared-version', custom: [false, null] },
      kernelspec: { name: language === 'R' ? 'lab-ir' : 'python3', display_name: 'Research kernel', language },
      authors: [{ name: 'Researcher', custom: { affiliation: 'Lab' } }], unknown: { value: 'Preserve 🧬', nested: [1, true] } };
    const outputs = [{ output_type: 'stream', name: 'stdout', text: ['first\r\n', 'second\n'] },
      { output_type: 'stream', name: 'stderr', text: 'diagnostic\n' },
      { output_type: 'error', ename: 'ScientificError', evalue: 'inspect inputs', traceback: ['\u001b[31mframe 1', 'frame 2'] },
      { output_type: 'execute_result', execution_count: null, metadata: { custom: ['kept'] }, data: { 'application/json': { cells: 12, values: [1, null] }, 'text/plain': ['12', ' cells'] } },
      { output_type: 'display_data', metadata: { 'image/png': { width: 1, height: 1 } }, data: { 'image/png': [png.slice(0, 32), png.slice(32)] } }];
    const source = language === 'R' ? ['# β 🧬\r\n', '\tx <- "é"  \r\n', '\r\n'] : ['# β 🧬\r\n', '\tx = "é"  \r\n', '\r\n'];
    const original = notebook({ metadata, cells: [{ id: 'intro', cell_type: 'markdown', metadata: { tags: ['question'], unknown: 3 }, source: ['# Question\n', 'A narrative.  \n'] }, code({ source, execution_count: 9, outputs })] });
    const saved = JSON.stringify(original), imported = read(original), exported = exportNotebookFile(imported.content), again = read(JSON.parse(exported.text));
    expect(JSON.stringify(original)).toBe(saved);
    expect(imported.content.cells[1].source).toBe(source.join(''));
    expect(again.content.cells).toEqual(imported.content.cells);
    expect(again.content.interchange.metadata).toEqual(metadata);
    expect(imported.summary).toMatchObject({ cells: 2, codeCells: 1, markdownCells: 1, rawCells: 0, outputs: 5, attachments: 0, unsupportedOutputs: 0, defaultLanguage: language });
    expect(imported.warnings.some(item => item.code === 'IMPORTED_HISTORICAL_OUTPUTS')).toBe(true);
    expect(exported.warnings.some(item => item.code === 'IMPORTED_HISTORICAL_OUTPUTS')).toBe(true);
    expect(JSON.parse(exported.text).cells[1].execution_count).toBe(9);
    expect(JSON.parse(exported.text).cells[1].outputs[0].text).toBe('first\r\nsecond\n');
  });

  it('retains Markdown/raw attachments, Unicode names and raw nbconvert source without treating names as paths', () => {
    const attachments = JSON.parse('{"figure α.png":{"image/png":"' + png + '"},"../literal-name":{"application/octet-stream":"AAE="},"__proto__":{"text/plain":"inert"}}');
    const cells = [{ id: 'narrative', cell_type: 'markdown', metadata: {}, source: '![cells](attachment:figure%20%CE%B1.png)', attachments },
      { id: 'latex', cell_type: 'raw', metadata: { format: 'text/latex' }, source: '\\section{Results}\r\n', attachments: { 'raw.png': { 'image/png': png } } }];
    const imported = read(notebook({ cells })), exported = JSON.parse(exportNotebookFile(imported.content).text);
    expect(imported.summary).toMatchObject({ markdownCells: 1, rawCells: 1, attachments: 4 });
    expect(imported.content.cells[1]).toMatchObject({ type: 'raw', source: cells[1].source });
    expect(imported.content.cells[1].language).toBeUndefined();
    expect(exported.cells).toEqual(cells);
    expect(Object.hasOwn(exported.cells[0].attachments, '__proto__')).toBe(true);
    expect({}.inert).toBeUndefined();
  });

  it('preserves unsupported widget/HTML/JavaScript/SVG MIME data as inert output, with honest warnings', () => {
    const data = { 'application/vnd.jupyter.widget-view+json': { version_major: 2, model_id: 'outside-work' },
      'application/vnd.plotly.v1+json': { data: [{ x: [1, 2] }] }, 'text/html': '<script>globalThis.embeddedExecution=true</script>',
      'application/javascript': 'globalThis.embeddedExecution=true', 'image/svg+xml': '<svg onload="fetch(https://outside.invalid)" />' };
    const metadata = { widgets: { 'application/vnd.jupyter.widget-state+json': { state: { outside: { model_name: 'Widget' } } } } };
    const imported = read(notebook({ metadata: { ...notebook().metadata, ...metadata }, cells: [code({ outputs: [{ output_type: 'display_data', metadata: { isolated: true }, data }] })] }));
    expect(imported.summary.unsupportedOutputs).toBe(1);
    expect(imported.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'UNSUPPORTED_MIME_RETAINED', cellId: 'analysis', outputIndex: 0 })]));
    expect(notebookMimePreview(imported.content.cells[0].imported.outputs[0].data).family).toBe('metadata');
    const exported = JSON.parse(exportNotebookFile(imported.content).text);
    expect(exported.cells[0].outputs[0].data).toEqual(data);
    expect(exported.metadata.widgets).toEqual(metadata.widgets);
    expect(globalThis.embeddedExecution).toBeUndefined();
  });

  it('quarantines external metadata instead of activating app script/execution markers or trusting imported status', () => {
    const metadata = JSON.parse('{"traceomics":{"kind":"script","script":{"schema":"traceomics.script.v1","filename":"outside.R"}},"trusted":true,"execution":{"status":"completed"},"__proto__":{"polluted":true},"constructor":{"kept":true},"toJSON":"literal"}');
    const original = notebook({ metadata: { ...metadata, ...notebook().metadata }, cells: [code({ metadata: { trusted: true, traceomics: { captured: true }, custom: ['x'] } })] });
    const imported = read(original);
    expect(imported.content.metadata).toEqual({});
    expect(imported.content.cells[0].metadata).toEqual({});
    expect(imported.content.interchange.metadata).toEqual(original.metadata);
    expect(imported.content.cells[0].imported.metadata).toEqual(original.cells[0].metadata);
    expect(imported.content.status).toBeUndefined();
    expect({}.polluted).toBeUndefined();
    expect(JSON.parse(exportNotebookFile(imported.content).text).metadata).toEqual(original.metadata);
    const forged = structuredClone(imported.content); forged.cells[0].imported.origin = 'captured';
    invalid(() => exportNotebookFile(forged));
  });

  it('preserves output-collapse metadata separately from the app source-collapse state', () => {
    const imported = read(notebook({ cells: [code({ metadata: { collapsed: true, scrolled: 'auto', jupyter: { source_hidden: true, outputs_hidden: true } } })] }));
    expect(imported.content.cells[0].collapsed).toBe(false);
    expect(imported.content.cells[0].imported.metadata.collapsed).toBe(true);
    expect(JSON.parse(exportNotebookFile(imported.content).text).cells[0].metadata).toEqual(notebook({ cells: [code({ metadata: imported.content.cells[0].imported.metadata })] }).cells[0].metadata);
  });

  it('keeps outputs historical after source changes and exports them without inventing a new run', () => {
    const imported = read(notebook({ cells: [code({ outputs: [{ output_type: 'stream', name: 'stdout', text: 'old output\n' }], execution_count: 4 })] }));
    imported.content.cells[0].source = 'a completely different question\n';
    const exported = exportNotebookFile(imported.content), file = JSON.parse(exported.text);
    expect(file.cells[0]).toMatchObject({ source: 'a completely different question\n', execution_count: 4, outputs: [{ text: 'old output\n' }] });
    expect(exported.warnings.some(item => item.code === 'IMPORTED_HISTORICAL_OUTPUTS')).toBe(true);
    expect(Object.keys(file)).toEqual(['nbformat', 'nbformat_minor', 'metadata', 'cells']);
    expect(file.cells[0].sourceRunId).toBeUndefined();
  });

  it('preserves string-array chunk text exactly, including CR, CRLF, BOM, Unicode, tabs and trailing whitespace', () => {
    const chunks = ['\uFEFF# 🧬\r', '\nx = 1  \r', '\n\t\n'];
    const imported = importNotebookFile({ filename: 'Mixed.IPYNB', source: '\uFEFF' + JSON.stringify(notebook({ cells: [code({ source: chunks })] })) });
    expect(imported.content.cells[0].source).toBe(chunks.join(''));
    expect(JSON.parse(exportNotebookFile(imported.content).text).cells[0].source).toBe(chunks.join(''));
    expect(exportNotebookFile(imported.content).filename).toBe('Mixed.IPYNB');
  });

  it('uses an explicit editing language for missing/unsupported declarations while retaining the original declarations', () => {
    const unsupported = notebook({ metadata: { kernelspec: { name: 'julia-1', display_name: 'Julia', language: 'julia' } } });
    expect(() => read(unsupported)).toThrow(expect.objectContaining({ code: 'NOTEBOOK_LANGUAGE_REQUIRED' }));
    const chosen = read(unsupported, { language: 'python' });
    expect(chosen.content.defaultLanguage).toBe('python');
    expect(chosen.content.interchange.metadata).toEqual(unsupported.metadata);
    expect(chosen.warnings.some(item => item.code === 'EDITING_LANGUAGE_SELECTED')).toBe(true);
    invalid(() => read(unsupported, { language: 'julia' }));
    expect(read(notebook({ metadata: {}, cells: [{ id: 'intro', cell_type: 'markdown', metadata: {}, source: '# Question' }] })).content.defaultLanguage).toBe('R');
    expect(() => read(notebook({ metadata: {} }))).toThrow(expect.objectContaining({ code: 'NOTEBOOK_LANGUAGE_REQUIRED' }));
  });

  it('rejects conflicting declarations unless the researcher explicitly selects an editing language', () => {
    const metadata = { language_info: { name: 'R' }, kernelspec: { name: 'python3', display_name: 'Python', language: 'python' } };
    expect(() => read(notebook({ metadata }))).toThrow(expect.objectContaining({ code: 'NOTEBOOK_LANGUAGE_REQUIRED' }));
    expect(read(notebook({ metadata }), { language: 'R' }).content.interchange.metadata).toEqual(metadata);
  });

  it('exports ordinary v1 notebooks and language hints without changing v1 canonical bytes or source', () => {
    const content = { schema: NOTEBOOK_DOCUMENT_SCHEMA, defaultLanguage: 'R', cells: [
      { id: 'r_code', type: 'code', language: 'R', source: 'x <- 1\n' },
      { id: 'python_code', type: 'code', language: 'python', source: 'x = 1\n' },
      { id: 'note', type: 'markdown', source: '# Conclusion\n' }], metadata: { unknown: ['preserve'] } };
    const canonical = canonicalNotebookContent(content), before = JSON.stringify(content), exported = exportNotebookFile(content), file = JSON.parse(exported.text);
    expect(exported.filename).toBe('notebook.ipynb'); expect(exported.warnings.some(item => item.code === 'MIXED_CELL_LANGUAGES')).toBe(true);
    expect(file.metadata).toMatchObject({ kernelspec: { name: 'ir' }, language_info: { name: 'R' }, unknown: ['preserve'] });
    expect(file.cells[1].metadata).toEqual({ vscode: { languageId: 'python' } });
    expect(read(file).content.cells.map(cell => cell.language)).toEqual(['R', 'python', undefined]);
    expect(file.cells.filter(cell => cell.cell_type === 'code').every(cell => cell.execution_count === null && cell.outputs.length === 0)).toBe(true);
    expect(JSON.stringify(content)).toBe(before); expect(hash(canonicalNotebookContent(content))).toBe(hash(canonical));
  });

  it('preserves conflicting external language hints and warns instead of rewriting original metadata or source', () => {
    const imported = read(notebook({ cells: [code({ metadata: { vscode: { languageId: 'R', custom: 'keep' } } })] }));
    imported.content.cells[0].language = 'python';
    const exported = exportNotebookFile(imported.content), file = JSON.parse(exported.text);
    expect(file.cells[0].metadata.vscode).toEqual({ languageId: 'R', custom: 'keep' });
    expect(file.cells[0].source).toBe(imported.content.cells[0].source);
    expect(exported.warnings.some(item => item.code === 'CELL_LANGUAGE_HINT_CONFLICT')).toBe(true);
  });

  it('retains actual cell language hints when the new-cell default differs from the imported declared kernel',()=>{
    const imported=read();imported.content.defaultLanguage='python';
    imported.content.cells.push({id:'new_python',type:'code',language:'python',source:'x = 2\n',metadata:{},collapsed:false});
    const exported=exportNotebookFile(imported.content),file=JSON.parse(exported.text),again=read(file);
    expect(file.metadata.kernelspec.name).toBe('ir');
    expect(file.cells[1].metadata).toEqual({vscode:{languageId:'python'}});
    expect(again.content.cells.map(cell=>cell.language)).toEqual(['R','python']);
    expect(exported.warnings.some(item=>item.code==='MIXED_CELL_LANGUAGES')).toBe(true);
  });

  it('supports newly authored v2 cells without imported results and warns before omitting app-only metadata', () => {
    const imported = read(); imported.content.metadata = { privateEditorSetting: false };
    imported.content.cells.push({ id: 'new_code', type: 'code', language: 'R', source: 'inspect(x)', metadata: {}, collapsed: false });
    const exported = exportNotebookFile(imported.content), file = JSON.parse(exported.text);
    expect(file.cells[1]).toMatchObject({ execution_count: null, outputs: [], source: 'inspect(x)' });
    expect(exported.warnings.some(item => item.code === 'APPLICATION_METADATA_NOT_EXPORTED')).toBe(true);
    expect(file.metadata.privateEditorSetting).toBeUndefined();
  });

  it.each(['../work.ipynb', 'C:\\work.ipynb', 'work/path.ipynb', 'work\n.ipynb', 'CON.ipynb', 'file.ipynb ', 'file.ipynb.', 'file.R', '', 'a'.repeat(240) + '.ipynb'])('rejects nonportable or unsupported filename %j', filename => {
    invalid(() => read(notebook(), { filename }));
    invalid(() => exportNotebookFile(read().content, { filename }));
  });

  it('retains the imported filename by default and accepts an explicit portable filename override', () => {
    const imported = read(notebook(), { filename: '研究 🧬.ipynb' }), before = JSON.stringify(imported.content);
    expect(imported.title).toBe('研究 🧬'); expect(exportNotebookFile(imported.content).filename).toBe('研究 🧬.ipynb');
    expect(exportNotebookFile(imported.content, { filename: 'Revision two.ipynb' }).filename).toBe('Revision two.ipynb');
    expect(JSON.stringify(imported.content)).toBe(before);
  });

  it.each([
    null, [], {}, { nbformat: 3, nbformat_minor: 0, metadata: {}, cells: [] },
    notebook({ nbformat_minor: 6 }), notebook({ nbformat_minor: 4.5 }), notebook({ metadata: [] }),
    notebook({ metadata: { kernelspec: { name: 'ir' } } }), notebook({ cells: {} }),
    notebook({ cells: [code({ id: undefined })] }), notebook({ cells: [code({ id: 'bad id' })] }),
    notebook({ cells: [code(), code()] }), notebook({ cells: [code({ source: [null] })] }),
    notebook({ cells: [code({ source: 'x\0y' })] }), notebook({ cells: [code({ source: '\uD800' })] }),
    notebook({ cells: [code({ cell_type: 'unrecognized' })] }), notebook({ extra: 'unsupported core field' }),
  ])('rejects malformed or unsupported notebook structure without repairing it silently (%#)', value => {
    const before = JSON.stringify(value); invalid(() => read(value)); expect(JSON.stringify(value)).toBe(before);
  });

  it.each(['{', '<html>not JSON</html>', '{"nbformat":NaN}', '{"cells":[]}', ''])('rejects malformed file text %j', source => invalid(() => importNotebookFile({ filename: 'input.ipynb', source })));

  it('preserves supplied IDs and assigns IDs only to missing legacy cells before admission', () => {
    let calls = 0; const cells = [code({ id: 'unchanged' }), code({ id: undefined })];
    const imported = read(notebook({ nbformat_minor: 4, cells }), {}, index => { calls++; return 'generated_' + index; });
    expect(imported.content.cells.map(cell => cell.id)).toEqual(['unchanged', 'generated_1']); expect(calls).toBe(1);
    expect(read(notebook({ nbformat_minor: 4, cells: [code({ id: undefined })] })).content.cells[0].id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    invalid(() => read(notebook({ nbformat_minor: 4, cells: [code({ id: undefined }), code({ id: undefined })] }), {}, () => 'same'));
    invalid(() => read(notebook({ nbformat_minor: 4, cells: [code({ id: undefined })] }), {}, () => 'invalid id'));
  });

  it.each([
    { output_type: 'unknown', payload: 'keep elsewhere' }, { output_type: 'stream', name: 'stdout', text: [2] },
    { output_type: 'error', ename: 'Error', evalue: 'message', traceback: 'not a list' },
    { output_type: 'display_data', metadata: {}, data: { 'not a mime': 'value' } },
    { output_type: 'display_data', metadata: {}, data: { 'image/png': { arbitrary: true } } },
    { output_type: 'execute_result', metadata: {}, data: {}, execution_count: -1 },
    { output_type: 'execute_result', metadata: {}, data: {}, execution_count: 1.5 },
    { output_type: 'display_data', metadata: {}, data: {}, origin: 'captured' },
  ])('rejects malformed output records and false execution fields (%#)', output => invalid(() => read(notebook({ cells: [code({ outputs: [output] })] }))));

  it('rejects outputs or execution counts on narrative/raw cells and attachments on code cells', () => {
    for (const type of ['markdown', 'raw']) invalid(() => read(notebook({ cells: [{ id: 'cell', cell_type: type, metadata: {}, source: '', outputs: [] }] })));
    invalid(() => read(notebook({ cells: [code({ attachments: {} })] })));
  });

  it('allows the exact raw-file and cell-source UTF-8 limits and rejects larger files without truncation', () => {
    const input = JSON.stringify(notebook()), source = input + ' '.repeat(limits.fileBytes - utf8(input));
    expect(importNotebookFile({ filename: 'bounded.ipynb', source }).content.cells).toHaveLength(1);
    tooLarge(() => importNotebookFile({ filename: 'bounded.ipynb', source: source + ' ' }));
    const exact = '🧬'.repeat(65536); expect(read(notebook({ cells: [code({ source: exact })] })).content.cells[0].source).toBe(exact);
    tooLarge(() => read(notebook({ cells: [code({ source: exact + '🧬' })] })));
  });

  it('counts source, base64 attachments and historical output bytes toward one canonical content budget', () => {
    const input = notebook({ cells: [code({ source: 'x'.repeat(250000), outputs: [{ output_type: 'stream', name: 'stdout', text: 'z'.repeat(850000) }] })] });
    expect(utf8(JSON.stringify(input))).toBeLessThan(limits.fileBytes); tooLarge(() => read(input));
    const imported = read(); imported.content.cells[0].imported.outputs = [{ output_type: 'display_data', metadata: {}, data: { 'text/plain': 'x'.repeat(limits.contentBytes + 1) } }];
    tooLarge(() => exportNotebookFile(imported.content));
  });

  it('enforces existing notebook and cell metadata limits on retained metadata', () => {
    const metadata = exactMetadata(notebook().metadata, limits.documentMetadataBytes);
    expect(read(notebook({ metadata })).content.interchange.metadata).toEqual(metadata);
    tooLarge(() => read(notebook({ metadata: { ...metadata, overflow: true } })));
    const cellMetadata = exactMetadata({}, limits.cellMetadataBytes);
    expect(read(notebook({ cells: [code({ metadata: cellMetadata })] })).content.cells[0].imported.metadata).toEqual(cellMetadata);
    tooLarge(() => read(notebook({ cells: [code({ metadata: { ...cellMetadata, overflow: true } })] })));
  });

  it('bounds cell/output/attachment/MIME counts and aggregate output/attachment counts', () => {
    const cells = Array.from({ length: 2000 }, (_, index) => code({ id: 'cell_' + index, source: '' }));
    expect(read(notebook({ cells })).content.cells).toHaveLength(2000); tooLarge(() => read(notebook({ cells: [...cells, code()] })));
    const output = { output_type: 'stream', name: 'stdout', text: '' };
    expect(read(notebook({ cells: [code({ outputs: Array(64).fill(output) })] })).summary.outputs).toBe(64);
    tooLarge(() => read(notebook({ cells: [code({ outputs: Array(65).fill(output) })] })));
    tooLarge(() => read(notebook({ cells: Array.from({ length: 32 }, (_, index) => code({ id: 'output_' + index, outputs: Array(64).fill(output) })) })));
    const attachments = Object.fromEntries(Array.from({ length: 32 }, (_, index) => ['a' + index, { 'text/plain': '' }]));
    const markdown = (index, values = attachments) => ({ id: 'attachment_' + index, cell_type: 'markdown', metadata: {}, source: '', attachments: values });
    expect(read(notebook({ cells: [markdown(0)] })).summary.attachments).toBe(32);
    tooLarge(() => read(notebook({ cells: [markdown(0, { ...attachments, overflow: { 'text/plain': '' } })] })));
    tooLarge(() => read(notebook({ cells: Array.from({ length: 9 }, (_, index) => markdown(index)) })));
    tooLarge(() => normalizeNotebookMimeBundle(Object.fromEntries(Array.from({ length: 33 }, (_, index) => ['application/x-' + index, ''])), 'MIME data'));
  });

  it('rejects excessive depth, node counts, nonfinite values, cycles, getters and non-JSON prototypes without invoking them', () => {
    let deep = {}; for (let index = 0; index < 9; index++) deep = { next: deep };
    invalid(() => read(notebook({ metadata: { ...notebook().metadata, deep } })));
    tooLarge(() => read(notebook({ metadata: { ...notebook().metadata, values: Array(10001).fill(null) } })));
    const imported = read().content, cycle = {}; cycle.self = cycle;
    imported.interchange.metadata = cycle; invalid(() => exportNotebookFile(imported));
    imported.interchange.metadata = { value: Infinity }; invalid(() => exportNotebookFile(imported));
    imported.interchange.metadata = { value: new Date() }; invalid(() => exportNotebookFile(imported));
    let called = 0; const getter = {}; Object.defineProperty(getter, 'unsafe', { enumerable: true, get() { called++; return 'never'; } });
    imported.interchange.metadata = getter; invalid(() => exportNotebookFile(imported)); expect(called).toBe(0);
    imported.interchange.metadata = { toJSON() { called++; return {}; } }; invalid(() => exportNotebookFile(imported)); expect(called).toBe(0);
    const sparse = new Array(2); imported.cells = sparse; invalid(() => exportNotebookFile(imported));
  });

  it('rejects metadata types that would make conventional exported notebooks invalid', () => {
    for (const metadata of [{ tags: [1] }, { tags: [''] }, { tags: ['a,b'] }, { tags: ['same', 'same'] }, { collapsed: 'yes' }, { scrolled: 2 }, { execution: { event: 123 } }, { jupyter: [] }]) {
      invalid(() => read(notebook({ cells: [code({ metadata })] })));
    }
    const v1 = { schema: NOTEBOOK_DOCUMENT_SCHEMA, defaultLanguage: 'R', metadata: {}, cells: [{ id: 'code', type: 'code', language: 'R', source: '', metadata: { tags: [1] } }] };
    invalid(() => exportNotebookFile(v1));
  });

  it('provides reusable payload validators without depending on the document normalizer or accepting captured claims', () => {
    const budget = createNotebookInterchangeBudget();
    const root = normalizeNotebookInterchange({ filename: 'outside.ipynb', nbformatMinor: 4, metadata: { unknown: true } }, budget);
    expect(root.metadata).toEqual({ unknown: true });
    expect(normalizeNotebookImportedCell({ metadata: {}, outputs: [], executionCount: 2 }, { type: 'code', budget })).toEqual({ metadata: {}, outputs: [], executionCount: 2 });
    invalid(() => normalizeNotebookImportedCell({ metadata: {}, outputs: [], executionCount: 2, status: 'completed' }, { type: 'code' }));
    const normalized = normalizeInterchangeNotebookContent(read().content);
    expect(normalizeInterchangeNotebookContent(normalized)).toEqual(normalized);
    expect(normalizeNotebookInterchangeContent(normalized,normalizeNotebookContent)).toEqual(normalized);
  });

  it('projects only bounded static raster/plaintext/JSON and never treats HTML/SVG/widgets as executable display', () => {
    expect(notebookMimePreview({ 'image/png': [png.slice(0, 20), '\n' + png.slice(20)] })).toMatchObject({ family: 'image', mimeType: 'image/png', width: 1, height: 1, sizeBytes: 68 });
    expect(notebookMimePreview({ 'image/png': 'PHN2ZyBvbmxvYWQ9ImFsZXJ0KDEpIj4=' }).family).toBe('metadata');
    expect(notebookMimePreview({ 'text/html': '<script>bad()</script>', 'image/svg+xml': '<svg />' }).family).toBe('metadata');
    expect(notebookMimePreview({ 'text/html': '<b>hidden</b>', 'text/plain': '<script>literal()</script>' })).toEqual({ family: 'text', text: '<script>literal()</script>', truncated: false });
    expect(notebookMimePreview({ 'application/json': { cells: 12, declared: false } })).toEqual({ family: 'text', text: '{\n  "cells": 12,\n  "declared": false\n}', truncated: false });
    const truncated = notebookMimePreview({ 'text/plain': '🧬'.repeat(20000) });
    expect(truncated.truncated).toBe(true); expect(utf8(truncated.text)).toBeLessThanOrEqual(limits.previewTextBytes); expect(truncated.text.isWellFormed()).toBe(true);
    const bomb = Buffer.from(png, 'base64'); bomb.writeUInt32BE(8192, 16); bomb.writeUInt32BE(8192, 20);
    expect(notebookMimePreview({ 'image/png': bomb.toString('base64') }).family).toBe('metadata');
    expect(notebookMimePreview({ 'image/png': Buffer.alloc(limits.previewImageBytes + 1).toString('base64') }).family).toBe('metadata');
  });

  it('rejects duplicate JSON keys and unsafe integer literals rather than silently discarding unknown metadata',()=>{
    const prefix='{"nbformat":4,"nbformat_minor":5,"metadata":';
    for(const metadata of ['{"same":1,"same":2}','{"a":1,"\\u0061":2}','{"value":9007199254740993}','{"value":-9007199254740993}']) {
      invalid(()=>importNotebookFile({filename:'metadata.ipynb',source:prefix+metadata+',"cells":[]}'}));
    }
    const source=prefix+'{"language_info":{"name":"R"},"numbers":{"float":1e20,"tiny":1e-200},"literal":'+JSON.stringify('9007199254740993, "quoted"')+'},"cells":[]}';
    const imported=importNotebookFile({filename:'numbers.ipynb',source}),exported=exportNotebookFile(imported.content);
    expect(exported.text).toContain('1e+20');
    expect(importNotebookFile({filename:'numbers.ipynb',source:exported.text}).content.interchange.metadata).toEqual(imported.content.interchange.metadata);
  });

  it('rejects structurally deep or invalid JSON before native parsing while respecting escaped string contents',()=>{
    invalid(()=>importNotebookFile({filename:'deep.ipynb',source:'['.repeat(34)+'null'+']'.repeat(34)}));
    for(const source of ['{"a":1,}','[1,]','{"a":1e309}','{"a":1e-999}','{"a":01}','{"a":undefined}','{"a":"unterminated}','true false'])invalid(()=>importNotebookFile({filename:'invalid.ipynb',source}));
    const original=notebook({metadata:{...notebook().metadata,literal:'{"same":1,"same":2,"unsafe":9007199254740993} \\ " end'}});
    expect(read(original).content.interchange.metadata.literal).toBe(original.metadata.literal);
  });

  it('does not invoke custom array prototypes or accept malformed import/export options',()=>{
    let called=0;
    class UnsafeArray extends Array {map(){called++;return[];}}
    const content=read().content;content.cells=new UnsafeArray(content.cells[0]);invalid(()=>exportNotebookFile(content));expect(called).toBe(0);
    for(const input of [null,[],{},'text',{filename:'work.ipynb',source:JSON.stringify(notebook()),captured:true}])invalid(()=>importNotebookFile(input));
    invalid(()=>exportNotebookFile(read().content,null));invalid(()=>exportNotebookFile(read().content,{unknown:true}));
  });

  it('validates JPEG dimensions and keeps animated/oversized/spoofed raster representations inert',()=>{
    const jpeg=Buffer.from([255,216,255,192,0,17,8,0,2,0,3,3,1,17,0,2,17,0,3,17,0,255,217]);
    expect(notebookMimePreview({'image/jpeg':jpeg.toString('base64')})).toMatchObject({family:'image',mimeType:'image/jpeg',width:3,height:2});
    const original=Buffer.from(png,'base64'),animation=Buffer.alloc(20);animation.writeUInt32BE(8,0);animation.write('acTL',4,'ascii');animation.writeUInt32BE(20,8);
    const animated=Buffer.concat([original.subarray(0,33),animation,original.subarray(33)]);
    expect(notebookMimePreview({'image/png':animated.toString('base64')}).family).toBe('metadata');
    expect(notebookMimePreview({'image/png':original.subarray(0,33).toString('base64')}).family).toBe('metadata');
    expect(notebookMimePreview({'image/jpeg':'PHN2ZyBvbmxvYWQ9ImFsZXJ0KDEpIj4='}).family).toBe('metadata');
    expect(notebookMimePreview({'image/png':png,'text/html':'<script>never()</script>'}).family).toBe('image');
    expect(notebookMimePreview({'image/png':'invalid','text/plain':'Raster unavailable'})).toEqual({family:'text',text:'Raster unavailable',truncated:false});
  });
});
