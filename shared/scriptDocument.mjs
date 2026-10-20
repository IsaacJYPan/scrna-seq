import { NOTEBOOK_DOCUMENT_LIMITS, NOTEBOOK_DOCUMENT_SCHEMA, normalizeNotebookContent } from './notebookDocument.mjs';

export const SCRIPT_DOCUMENT_SCHEMA = 'traceomics.script.v1';
export const SCRIPT_FILE_LIMIT = NOTEBOOK_DOCUMENT_LIMITS.sourceBytes + 3;
const encoder = new TextEncoder();
const own = (value, key) => Object.hasOwn(value, key);

function invalid(message, tooLarge = false) {
  throw Object.assign(new Error(message), {
    code: tooLarge ? 'SCRIPT_DOCUMENT_TOO_LARGE' : 'INVALID_SCRIPT_DOCUMENT', status: tooLarge ? 413 : 400,
  });
}

export function scriptFileLanguage(filename) {
  if (typeof filename !== 'string' || !filename.isWellFormed() || !filename
      || encoder.encode(filename).length > 240 || /[<>:"/\\|?*]/.test(filename)
      || [...filename].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
      || /[. ]$/.test(filename) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(filename)) {
    invalid('Choose a script with a portable filename, without folders or reserved filename characters.');
  }
  if (/\.r$/i.test(filename)) return 'R';
  if (/\.py$/i.test(filename)) return 'python';
  invalid('Choose an R (.R) or Python (.py) script.');
}

// This is a source document, not a file binding or an execution request. A BOM
// belongs to the file representation and is kept out of the visible code cell.
export function importScriptDocument({ filename, bytes, cellId }) {
  const language = scriptFileLanguage(filename);
  if (!(bytes instanceof Uint8Array)) invalid('Script input must be the original file bytes.');
  if (bytes.byteLength > SCRIPT_FILE_LIMIT) invalid('This script exceeds the 256 KiB source limit.', true);
  let source;
  try { source = new globalThis.TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { invalid('This script is not valid UTF-8. Save a UTF-8 copy in your editor and try again.'); }
  const bom = source.startsWith('\uFEFF');
  if (bom) source = source.slice(1);
  if (encoder.encode(source).length > NOTEBOOK_DOCUMENT_LIMITS.sourceBytes) {
    invalid('This script exceeds the 256 KiB source limit.', true);
  }
  return normalizeNotebookContent({
    schema: NOTEBOOK_DOCUMENT_SCHEMA, defaultLanguage: language,
    cells: [{ id: cellId, type: 'code', language, source, metadata: {}, collapsed: false }],
    metadata: { traceomics: { kind: 'script', script: { schema: SCRIPT_DOCUMENT_SCHEMA, filename, language, encoding: 'utf-8', bom } } },
  });
}

export function scriptDocumentInfo(content) {
  const marker = content?.metadata?.traceomics;
  if (marker?.kind !== 'script') return null;
  const script = marker.script;
  if (!script || typeof script !== 'object' || Array.isArray(script)
      || Object.keys(script).some(key => !['schema', 'filename', 'language', 'encoding', 'bom'].includes(key))
      || !['schema', 'filename', 'language', 'encoding', 'bom'].every(key => own(script, key))
      || script.schema !== SCRIPT_DOCUMENT_SCHEMA || script.encoding !== 'utf-8' || typeof script.bom !== 'boolean') {
    invalid('This source document has unsupported script metadata. Its saved notebook source remains available.');
  }
  const language = scriptFileLanguage(script.filename);
  if (script.language !== language || content.defaultLanguage !== language || content.cells?.length !== 1
      || content.cells[0].type !== 'code' || content.cells[0].language !== language) {
    invalid('A script must contain one complete code cell in its declared language.');
  }
  return { ...script };
}

export function exportScriptDocument(content) {
  const normalized = normalizeNotebookContent(content);
  const info = scriptDocumentInfo(normalized);
  if (!info) invalid('This document is a notebook. Choose notebook export or copy a code cell explicitly.');
  return { filename: info.filename, language: info.language,
    bytes: encoder.encode(`${info.bom ? '\uFEFF' : ''}${normalized.cells[0].source}`) };
}

export function copyScriptToNotebook(content) {
  const normalized = normalizeNotebookContent(content);
  if (!scriptDocumentInfo(normalized)) invalid('Choose an ordinary script to copy into a notebook.');
  const metadata = { ...normalized.metadata };
  const traceomics = { ...metadata.traceomics };
  delete traceomics.kind;
  delete traceomics.script;
  if (Object.keys(traceomics).length) metadata.traceomics = traceomics;
  else delete metadata.traceomics;
  return normalizeNotebookContent({ ...normalized, metadata });
}
