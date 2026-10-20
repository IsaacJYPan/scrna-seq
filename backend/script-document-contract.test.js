import { describe, expect, it } from 'vitest';
import { NOTEBOOK_DOCUMENT_LIMITS } from '../shared/notebookDocument.mjs';
import { copyScriptToNotebook, exportScriptDocument, importScriptDocument, SCRIPT_DOCUMENT_SCHEMA, scriptDocumentInfo, scriptFileLanguage } from '../shared/scriptDocument.mjs';

const encode = source => new TextEncoder().encode(source);
const make = (source = 'source("helpers/prepare.R")\r\nsummary(object)\r\n', filename = 'analysis.R') =>
  importScriptDocument({ filename, bytes: encode(source), cellId: 'original-source' });
const invalid = action => expect(action).toThrow(expect.objectContaining({ code: 'INVALID_SCRIPT_DOCUMENT', status: 400 }));

describe('ordinary script source interoperability', () => {
  it.each(['analysis.R', 'analysis.r', 'Analyse β.R', '.hidden.R'])('recognizes a portable R filename: %s', filename => {
    expect(scriptFileLanguage(filename)).toBe('R');
  });
  it.each(['analysis.py', 'analysis.PY', '模型.py'])('recognizes a portable Python filename: %s', filename => {
    expect(scriptFileLanguage(filename)).toBe('python');
  });
  it.each(['../analysis.R', 'folder/analysis.R', 'C:\\analysis.R', 'analysis.R ', 'analysis.R.', 'con.R', 'LPT1.py', 'a\0.R', 'a?.R', 'analysis.ipynb', 'analysis.txt', '', '🧬'.repeat(61) + '.R'])('rejects an unsupported or nonportable filename: %j', filename => {
    invalid(() => scriptFileLanguage(filename));
  });
  it('retains an entire R script, stable identity and literal helper paths as one code cell', () => {
    const source = '# a section\r\nsource("helpers/prepare.R")\r\nx <- function() {\r\n  1\r\n}\r\n';
    const content = make(source);
    expect(content.cells).toEqual([{ id: 'original-source', type: 'code', language: 'R', source, metadata: {}, collapsed: false }]);
    expect(scriptDocumentInfo(content)).toEqual({ schema: SCRIPT_DOCUMENT_SCHEMA, filename: 'analysis.R', language: 'R', encoding: 'utf-8', bom: false });
    expect(content).not.toHaveProperty('outputs');
    expect(content).not.toHaveProperty('execution');
  });
  it.each([
    ['analysis.R', '# β 🧬\r\n\tx <- "é"  \r\n\r\n'],
    ['analysis.R', '\uFEFF# R source\r\nx <- 1\r\n'],
    ['analysis.py', '\uFEFFfrom helpers.prepare import prepare\nprint("β")\n'],
    ['analysis.py', '# no final newline'],
    ['analysis.R', 'x <- 1\ry <- 2\r'],
    ['analysis.R', '# mixed\r\nx <- 1\ny <- 2\r'],
    ['analysis.R', ''],
    ['analysis.R', '\uFEFF\uFEFF# two literal BOM characters\n'],
  ])('exports unchanged %s bytes exactly, including encoding and line endings', (filename, source) => {
    const result = exportScriptDocument(make(source, filename));
    expect(result.filename).toBe(filename);
    expect(result.bytes).toEqual(encode(source));
    expect(new TextDecoder('utf-8', { ignoreBOM: true }).decode(result.bytes)).toBe(source);
  });
  it('exports deliberate source edits without changing the original document', () => {
    const original = make('\uFEFF# original\r\nx <- 1\r\n');
    const edited = structuredClone(original);
    edited.cells[0].source += 'summary(x)\r\n';
    expect(exportScriptDocument(edited).bytes).toEqual(encode('\uFEFF# original\r\nx <- 1\r\nsummary(x)\r\n'));
    expect(exportScriptDocument(original).bytes).toEqual(encode('\uFEFF# original\r\nx <- 1\r\n'));
  });
  it('rejects invalid UTF-8 instead of silently substituting scientific source', () => {
    for (const bytes of [new Uint8Array([0xff]), new Uint8Array([0xc3, 0x28]), new Uint8Array([0xff, 0xfe, 0x41, 0])]) {
      invalid(() => importScriptDocument({ filename: 'analysis.R', bytes, cellId: 'source' }));
    }
  });
  it('requires original bytes and a valid stable cell ID', () => {
    invalid(() => importScriptDocument({ filename: 'analysis.R', bytes: 'x <- 1', cellId: 'source' }));
    expect(() => importScriptDocument({ filename: 'analysis.R', bytes: encode('x <- 1'), cellId: '../cell' })).toThrow(/stable notebook ID/);
  });
  it('applies the source byte budget independently of a permitted UTF-8 BOM', () => {
    const source = '#'.repeat(NOTEBOOK_DOCUMENT_LIMITS.sourceBytes);
    expect(exportScriptDocument(make('\uFEFF' + source)).bytes.byteLength).toBe(NOTEBOOK_DOCUMENT_LIMITS.sourceBytes + 3);
    expect(() => make(source + '#')).toThrow(expect.objectContaining({ code: 'SCRIPT_DOCUMENT_TOO_LARGE', status: 413 }));
    expect(() => make('\uFEFF' + source + '#')).toThrow(expect.objectContaining({ code: 'SCRIPT_DOCUMENT_TOO_LARGE', status: 413 }));
  });
  it('uses byte limits for Unicode source and rejects NUL without replacing it', () => {
    expect(() => make('β'.repeat(NOTEBOOK_DOCUMENT_LIMITS.sourceBytes / 2 + 1))).toThrow(/256 KiB/);
    expect(() => make('x <- "\0"')).toThrow(/NUL/);
  });
  it('copies source explicitly into an ordinary notebook without mutating the script', () => {
    const script = make('\uFEFFsource("helpers/prepare.R")\r\n');
    script.metadata.traceomics.other = { retained: true };
    script.metadata.unknown = { a: 1 };
    const notebook = copyScriptToNotebook(script);
    expect(scriptDocumentInfo(notebook)).toBeNull();
    expect(notebook.cells).toEqual(script.cells);
    expect(notebook.metadata).toEqual({ traceomics: { other: { retained: true } }, unknown: { a: 1 } });
    expect(scriptDocumentInfo(script).bom).toBe(true);
    expect(script.metadata.traceomics.kind).toBe('script');
  });
  it('does not mistake an ordinary notebook for a script or export it implicitly', () => {
    const notebook = copyScriptToNotebook(make());
    expect(scriptDocumentInfo(notebook)).toBeNull();
    expect(notebook.metadata).toEqual({});
    invalid(() => exportScriptDocument(notebook));
    invalid(() => copyScriptToNotebook(notebook));
  });
  it.each([
    content => { content.cells.push({ ...content.cells[0], id: 'second' }); },
    content => { content.cells[0].language = 'python'; },
    content => { content.defaultLanguage = 'python'; },
    content => { content.metadata.traceomics.script.language = 'python'; },
    content => { content.metadata.traceomics.script.schema = 'future'; },
    content => { content.metadata.traceomics.script.encoding = 'utf-16'; },
    content => { content.metadata.traceomics.script.bom = 1; },
    content => { content.metadata.traceomics.script.path = '/private/input'; },
  ])('rejects contradictory script presentation metadata without changing source', change => {
    const content = make();
    const source = content.cells[0].source;
    change(content);
    invalid(() => scriptDocumentInfo(content));
    expect(content.cells[0].source).toBe(source);
  });
});
