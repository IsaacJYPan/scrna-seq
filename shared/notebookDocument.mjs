export const NOTEBOOK_DOCUMENT_SCHEMA = 'traceomics.notebook.v1';
export const NOTEBOOK_DOCUMENT_ID = /^doc_[a-f0-9]{24}$/;
export const NOTEBOOK_VERSION_ID = /^dv_[a-f0-9]{24}$/;
export const NOTEBOOK_CELL_ID = /^[A-Za-z0-9_-]{1,64}$/;
export const NOTEBOOK_DOCUMENT_LIMITS = Object.freeze({
  title: 160,
  cells: 2000,
  sourceBytes: 256 * 1024,
  contentBytes: 1024 * 1024,
  bodyBytes: 2 * 1024 * 1024,
  documentMetadataBytes: 16 * 1024,
  cellMetadataBytes: 4 * 1024,
  metadataDepth: 8,
  metadataNodes: 10000,
});

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const LANGUAGES = new Set(['R', 'python']);
const encoder = new TextEncoder();
const own = (value, key) => Object.hasOwn(value, key);
const byteLength = value => encoder.encode(value).length;

function invalid(message) {
  throw Object.assign(new Error(message), { code: 'INVALID_NOTEBOOK_DOCUMENT', status: 400 });
}

function tooLarge(message) {
  throw Object.assign(new Error(message), { code: 'NOTEBOOK_DOCUMENT_TOO_LARGE', status: 413 });
}

function plainRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    invalid(`${label} must be a plain JSON object.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string'
      || !descriptors[key].enumerable || !own(descriptors[key], 'value'))) {
    invalid(`${label} must contain ordinary JSON fields.`);
  }
}

function fields(value, allowed, label) {
  plainRecord(value, label);
  if (Object.keys(value).some(key => !allowed.includes(key))) {
    invalid(`${label} contains unsupported fields. Identity, ownership, execution and outputs are managed separately.`);
  }
}

function validText(value, label) {
  if (typeof value !== 'string' || !value.isWellFormed() || value.includes('\0')) {
    invalid(`${label} must be valid Unicode text without NUL characters.`);
  }
  return value;
}

function requestId(value) {
  if (typeof value !== 'string' || !UUID.test(value)) {
    invalid('A request UUID is required to safely save or recover this notebook.');
  }
  return value.toLowerCase();
}

function title(value) {
  const result = validText(value, 'Notebook title').trim();
  if (!result || [...result].length > NOTEBOOK_DOCUMENT_LIMITS.title
      || [...result].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) {
    invalid(`Notebook title must contain 1–${NOTEBOOK_DOCUMENT_LIMITS.title} characters on one line.`);
  }
  return result;
}

function denseArray(value, label) {
  if (!Array.isArray(value)) invalid(`${label} must be an array.`);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1) invalid(`${label} must contain only ordinary JSON array entries.`);
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !own(descriptor, 'value')) {
      invalid(`${label} must contain ordinary JSON array entries without gaps.`);
    }
  }
}

function metadata(value, limit, label, budget) {
  plainRecord(value, label);
  const ancestors = new Set();
  const visit = (item, depth) => {
    budget.nodes++;
    if (budget.nodes > NOTEBOOK_DOCUMENT_LIMITS.metadataNodes) {
      tooLarge(`Notebook metadata must contain at most ${NOTEBOOK_DOCUMENT_LIMITS.metadataNodes} JSON values in total.`);
    }
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'string') return validText(item, label);
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) invalid(`${label} must contain finite JSON numbers.`);
      return Object.is(item, -0) ? 0 : item;
    }
    if (typeof item !== 'object') invalid(`${label} must contain inert JSON values only.`);
    if (depth > NOTEBOOK_DOCUMENT_LIMITS.metadataDepth) {
      invalid(`Notebook metadata must not exceed ${NOTEBOOK_DOCUMENT_LIMITS.metadataDepth} nested containers below its root.`);
    }
    if (ancestors.has(item)) invalid('Notebook metadata must not contain cycles.');
    ancestors.add(item);
    let result;
    if (Array.isArray(item)) {
      if (item.length > NOTEBOOK_DOCUMENT_LIMITS.metadataNodes - budget.nodes) {
        tooLarge(`Notebook metadata must contain at most ${NOTEBOOK_DOCUMENT_LIMITS.metadataNodes} JSON values in total.`);
      }
      denseArray(item, label);
      result = item.map(entry => visit(entry, depth + 1));
    } else {
      plainRecord(item, label);
      result = Object.fromEntries(Object.keys(item).sort().map(key => {
        validText(key, `${label} key`);
        return [key, visit(item[key], depth + 1)];
      }));
    }
    ancestors.delete(item);
    return result;
  };
  const result = visit(value, 0);
  const bytes = byteLength(JSON.stringify(result));
  if (bytes > limit) tooLarge(`${label} must contain at most ${limit} UTF-8 JSON bytes.`);
  budget.bytes += bytes;
  return result;
}

/** Normalize source/structure only. Source whitespace and line endings are exact. */
export function normalizeNotebookContent(input) {
  fields(input, ['schema', 'defaultLanguage', 'cells', 'metadata'], 'Notebook content');
  if (input.schema !== NOTEBOOK_DOCUMENT_SCHEMA) invalid('Choose the supported notebook content schema.');
  if (!LANGUAGES.has(input.defaultLanguage)) invalid('Notebook default language must be R or python.');
  if (!Array.isArray(input.cells)) invalid('Notebook cells must be an array.');
  if (input.cells.length > NOTEBOOK_DOCUMENT_LIMITS.cells) {
    tooLarge(`A notebook can contain at most ${NOTEBOOK_DOCUMENT_LIMITS.cells} cells.`);
  }
  denseArray(input.cells, 'Notebook cells');
  const budget = { nodes: 0, bytes: 0 };
  const ids = new Set();
  const cells = input.cells.map(cell => {
    fields(cell, ['id', 'type', 'language', 'source', 'metadata', 'collapsed'], 'Notebook cell');
    if (typeof cell.id !== 'string' || !NOTEBOOK_CELL_ID.test(cell.id)) invalid('Each cell requires a stable notebook ID of 1–64 letters, numbers, underscores or hyphens.');
    if (ids.has(cell.id)) invalid('Notebook cell IDs must be unique within the document.');
    ids.add(cell.id);
    if (!['markdown', 'code'].includes(cell.type)) invalid('Notebook cells must be markdown or code.');
    if (cell.type === 'code' && !LANGUAGES.has(cell.language)) invalid('Each code cell must declare R or python as its language.');
    if (cell.type === 'markdown' && own(cell, 'language')) invalid('Markdown cells do not declare a code language.');
    const source = validText(cell.source, 'Cell source');
    const sourceBytes = byteLength(source);
    if (sourceBytes > NOTEBOOK_DOCUMENT_LIMITS.sourceBytes) {
      tooLarge(`Each cell source must contain at most ${NOTEBOOK_DOCUMENT_LIMITS.sourceBytes} UTF-8 bytes.`);
    }
    budget.bytes += sourceBytes;
    if (budget.bytes > NOTEBOOK_DOCUMENT_LIMITS.contentBytes) tooLarge('Notebook source and metadata exceed the 1 MiB content limit.');
    if (own(cell, 'collapsed') && typeof cell.collapsed !== 'boolean') invalid('Cell collapsed state must be true or false.');
    const cellMetadata = metadata(own(cell, 'metadata') ? cell.metadata : {}, NOTEBOOK_DOCUMENT_LIMITS.cellMetadataBytes, 'Cell metadata', budget);
    return { id: cell.id, type: cell.type, ...(cell.type === 'code' ? { language: cell.language } : {}), source,
      metadata: cellMetadata, collapsed: own(cell, 'collapsed') ? cell.collapsed : false };
  });
  const documentMetadata = metadata(own(input, 'metadata') ? input.metadata : {}, NOTEBOOK_DOCUMENT_LIMITS.documentMetadataBytes, 'Notebook metadata', budget);
  const result = { schema: NOTEBOOK_DOCUMENT_SCHEMA, defaultLanguage: input.defaultLanguage, cells, metadata: documentMetadata };
  if (byteLength(JSON.stringify(result)) > NOTEBOOK_DOCUMENT_LIMITS.contentBytes) {
    tooLarge('Notebook content must contain at most 1 MiB of canonical UTF-8 JSON.');
  }
  return result;
}

/** Deterministic JSON text for SHA256; cell order and exact source are retained. */
export function canonicalNotebookContent(input) {
  return JSON.stringify(normalizeNotebookContent(input));
}

export function normalizeNotebookCreate(input) {
  fields(input, ['requestId', 'title', 'content'], 'Notebook creation');
  return { requestId: requestId(input.requestId), title: title(input.title), content: normalizeNotebookContent(input.content) };
}

export function normalizeNotebookSave(input) {
  fields(input, ['requestId', 'expectedVersion', 'title', 'content'], 'Notebook save');
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1 || input.expectedVersion >= 2147483647) {
    invalid('The exact current notebook version is required before saving changes.');
  }
  return { requestId: requestId(input.requestId), expectedVersion: input.expectedVersion,
    title: title(input.title), content: normalizeNotebookContent(input.content) };
}
