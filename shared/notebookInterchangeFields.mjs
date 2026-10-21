export const NOTEBOOK_INTERCHANGE_SCHEMA = 'traceomics.notebook.v2';
export const NOTEBOOK_INTERCHANGE_LIMITS = Object.freeze({
  fileBytes: 2 * 1024 * 1024,
  contentBytes: 1024 * 1024,
  sourceBytes: 256 * 1024,
  cells: 2000,
  filenameBytes: 240,
  documentMetadataBytes: 16 * 1024,
  cellMetadataBytes: 4 * 1024,
  outputMetadataBytes: 4 * 1024,
  metadataDepth: 8,
  metadataNodes: 10000,
  outputsPerCell: 64,
  outputs: 2000,
  attachmentsPerCell: 32,
  attachments: 256,
  mimeTypes: 32,
  previewTextBytes: 64 * 1024,
  previewImageBytes: 256 * 1024,
  previewImagePixels: 12000000,
  previewImageDimension: 8192,
});

const encoder = new TextEncoder();
const own = (value, key) => Object.hasOwn(value, key);
export const notebookInterchangeBytes = value => encoder.encode(value).length;
export function notebookInterchangeError(message, tooLarge = false, code) {
  throw Object.assign(new Error(message), {
    code: code || (tooLarge ? 'NOTEBOOK_INTERCHANGE_TOO_LARGE' : 'INVALID_NOTEBOOK_INTERCHANGE'),
    status: tooLarge ? 413 : 400,
  });
}
export function notebookInterchangeText(value, label = 'Notebook text', maximum = NOTEBOOK_INTERCHANGE_LIMITS.contentBytes) {
  if (typeof value !== 'string' || !value.isWellFormed() || value.includes('\0')) {
    notebookInterchangeError(`${label} must be valid Unicode text without NUL characters.`);
  }
  if (value.length > maximum || notebookInterchangeBytes(value) > maximum) {
    notebookInterchangeError(`${label} exceeds its ${maximum} UTF-8 byte limit.`, true);
  }
  return value;
}
export function notebookInterchangeRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    notebookInterchangeError(`${label} must be a plain JSON object.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string'
      || !descriptors[key].enumerable || !own(descriptors[key], 'value'))) {
    notebookInterchangeError(`${label} must contain ordinary JSON fields.`);
  }
}
export function notebookInterchangeFields(value, allowed, label, required = []) {
  notebookInterchangeRecord(value, label);
  if (Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !own(value, key))) {
    notebookInterchangeError(`${label} has missing or unsupported fields.`);
  }
}
export function notebookInterchangeArray(value, label) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
      || Reflect.ownKeys(value).length !== value.length + 1) {
    notebookInterchangeError(`${label} must be an ordinary JSON array.`);
  }
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !own(descriptor, 'value')) {
      notebookInterchangeError(`${label} must contain ordinary JSON entries without gaps.`);
    }
  }
}
export const createNotebookInterchangeBudget = () => ({ nodes: 0, outputs: 0, attachments: 0, bytes: 0 });
function charge(value, budget) {
  budget.bytes = (budget.bytes || 0) + notebookInterchangeBytes(JSON.stringify(value));
  if (budget.bytes > NOTEBOOK_INTERCHANGE_LIMITS.contentBytes) {
    notebookInterchangeError('Imported outputs, attachments and metadata exceed the 1 MiB content budget.', true);
  }
}

/** Canonical inert JSON only. Metadata keys never become application options. */
export function normalizeNotebookInterchangeJSON(input, label, budget = createNotebookInterchangeBudget()) {
  const ancestors = new Set();
  const visit = (value, depth) => {
    budget.nodes++;
    if (budget.nodes > NOTEBOOK_INTERCHANGE_LIMITS.metadataNodes) {
      notebookInterchangeError('Notebook imported metadata and MIME data exceed 10000 JSON values.', true);
    }
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string') { notebookInterchangeText(value, label); charge(value, budget); return value; }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) notebookInterchangeError(`${label} must contain finite JSON numbers.`);
      return Object.is(value, -0) ? 0 : value;
    }
    if (typeof value !== 'object') notebookInterchangeError(`${label} must contain inert JSON values only.`);
    if (depth > NOTEBOOK_INTERCHANGE_LIMITS.metadataDepth) {
      notebookInterchangeError(`${label} exceeds eight nested JSON containers.`);
    }
    if (ancestors.has(value)) notebookInterchangeError(`${label} must not contain cycles.`);
    ancestors.add(value);
    let result;
    if (Array.isArray(value)) {
      if (value.length > NOTEBOOK_INTERCHANGE_LIMITS.metadataNodes - budget.nodes) {
        notebookInterchangeError('Notebook imported metadata and MIME data exceed 10000 JSON values.', true);
      }
      notebookInterchangeArray(value, label);
      result = value.map(item => visit(item, depth + 1));
    } else {
      notebookInterchangeRecord(value, label);
      result = Object.fromEntries(Object.keys(value).sort().map(key => {
        notebookInterchangeText(key, `${label} key`);
        charge(key, budget);
        return [key, visit(value[key], depth + 1)];
      }));
    }
    ancestors.delete(value);
    return result;
  };
  return visit(input, 0);
}
export function normalizeNotebookInterchangeMetadata(value, maximum, label, budget) {
  notebookInterchangeRecord(value, label);
  const result = normalizeNotebookInterchangeJSON(value, label, budget);
  if (notebookInterchangeBytes(JSON.stringify(result)) > maximum) {
    notebookInterchangeError(`${label} exceeds its ${maximum} UTF-8 byte limit.`, true);
  }
  return result;
}
export function notebookInterchangeFilename(filename) {
  notebookInterchangeText(filename, 'Notebook filename');
  if (!filename || notebookInterchangeBytes(filename) > NOTEBOOK_INTERCHANGE_LIMITS.filenameBytes
      || /[<>:"/\\|?*]/.test(filename) || /\p{Cc}/u.test(filename)
      || /[. ]$/.test(filename) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(filename)
      || !/\.ipynb$/i.test(filename)) {
    notebookInterchangeError('Choose a portable .ipynb filename of at most 240 UTF-8 bytes, without folders or reserved filename characters.');
  }
  return filename;
}
export function notebookMultilineText(value, label) {
  if (typeof value === 'string') return notebookInterchangeText(value, label);
  if (Array.isArray(value) && value.length > NOTEBOOK_INTERCHANGE_LIMITS.fileBytes / 3) {
    notebookInterchangeError(`${label} exceeds the bounded multiline representation.`, true);
  }
  notebookInterchangeArray(value, label);
  let bytes = 0;
  return value.map(item => {
    notebookInterchangeText(item, label); bytes += notebookInterchangeBytes(item);
    if (bytes > NOTEBOOK_INTERCHANGE_LIMITS.contentBytes) notebookInterchangeError(`${label} exceeds the 1 MiB text budget.`, true);
    return item;
  }).join('');
}
function count(value, label) {
  if (value !== null && (!Number.isSafeInteger(value) || value < 0)) {
    notebookInterchangeError(`${label} must be a nonnegative safe integer or null.`);
  }
  return value;
}
function knownMetadata(metadata, kind) {
  const optionalText = (record, key, label) => {
    if (own(record, key)) notebookInterchangeText(record[key], label);
  };
  if (kind === 'notebook') {
    if (own(metadata, 'kernelspec')) {
      notebookInterchangeRecord(metadata.kernelspec, 'Notebook kernel metadata');
      notebookInterchangeText(metadata.kernelspec.name, 'Kernel name');
      notebookInterchangeText(metadata.kernelspec.display_name, 'Kernel display name');
    }
    if (own(metadata, 'language_info')) {
      const info = metadata.language_info;
      notebookInterchangeRecord(info, 'Notebook language metadata');
      notebookInterchangeText(info.name, 'Declared language name');
      for (const key of ['file_extension', 'mimetype', 'pygments_lexer']) optionalText(info, key, 'Declared language metadata');
      if (own(info, 'codemirror_mode') && typeof info.codemirror_mode !== 'string') {
        notebookInterchangeRecord(info.codemirror_mode, 'Code editor language metadata');
      }
    }
    if (own(metadata, 'title')) notebookInterchangeText(metadata.title, 'Declared notebook title');
    if (own(metadata, 'authors')) notebookInterchangeArray(metadata.authors, 'Notebook authors');
    if (own(metadata, 'orig_nbformat') && (!Number.isSafeInteger(metadata.orig_nbformat) || metadata.orig_nbformat < 1)) {
      notebookInterchangeError('Original notebook format metadata must be a positive integer.');
    }
    return metadata;
  }
  if (own(metadata, 'name') && (typeof metadata.name !== 'string' || !metadata.name || /[\r\n]/.test(metadata.name))) {
    notebookInterchangeError('Cell metadata name must be nonempty text on one line.');
  }
  if (own(metadata, 'tags')) {
    notebookInterchangeArray(metadata.tags, 'Cell tags');
    if (metadata.tags.some(tag => typeof tag !== 'string' || !tag || tag.includes(','))
        || new Set(metadata.tags).size !== metadata.tags.length) {
      notebookInterchangeError('Cell tags must be unique strings without commas.');
    }
  }
  if (own(metadata, 'jupyter')) notebookInterchangeRecord(metadata.jupyter, 'Cell Jupyter metadata');
  if (kind === 'raw' && own(metadata, 'format')) notebookInterchangeText(metadata.format, 'Raw cell format');
  if (kind === 'code') {
    if (own(metadata, 'collapsed') && typeof metadata.collapsed !== 'boolean') notebookInterchangeError('Imported output collapse state must be a boolean.');
    if (own(metadata, 'scrolled') && ![true, false, 'auto'].includes(metadata.scrolled)) notebookInterchangeError('Imported output scroll state must be true, false or auto.');
    if (own(metadata, 'execution')) {
      notebookInterchangeRecord(metadata.execution, 'Imported execution metadata');
      if (Object.values(metadata.execution).some(value => typeof value !== 'string')) {
        notebookInterchangeError('Imported execution timestamp metadata must contain strings.');
      }
    }
  }
  return metadata;
}
export function normalizeNotebookInterchange(value, budget = createNotebookInterchangeBudget()) {
  notebookInterchangeFields(value, ['filename', 'nbformatMinor', 'metadata'], 'Notebook interchange', ['filename', 'nbformatMinor', 'metadata']);
  if (!Number.isSafeInteger(value.nbformatMinor) || value.nbformatMinor < 0 || value.nbformatMinor > 5) {
    notebookInterchangeError('Supported notebook format versions are 4.0 through 4.5.');
  }
  const metadata = normalizeNotebookInterchangeMetadata(value.metadata, NOTEBOOK_INTERCHANGE_LIMITS.documentMetadataBytes, 'Imported notebook metadata', budget);
  return { filename: notebookInterchangeFilename(value.filename), nbformatMinor: value.nbformatMinor,
    metadata: knownMetadata(metadata, 'notebook') };
}
export function normalizeNotebookMimeBundle(value, label, budget = createNotebookInterchangeBudget()) {
  notebookInterchangeRecord(value, label);
  if (Object.keys(value).length > NOTEBOOK_INTERCHANGE_LIMITS.mimeTypes) notebookInterchangeError(`${label} exceeds 32 MIME representations.`, true);
  return Object.fromEntries(Object.keys(value).sort().map(mime => {
    if (mime.length > 160 || !/^[A-Za-z0-9!#$%&'*+.^_`|~-]+\/[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(mime)) {
      notebookInterchangeError(`${label} contains an invalid MIME type.`);
    }
    charge(mime, budget);
    let content;
    if (/^application\/(?:[^/]+\+)?json$/.test(mime)) {
      content = normalizeNotebookInterchangeJSON(value[mime], label, budget);
    } else if (typeof value[mime] === 'string') { content = notebookInterchangeText(value[mime], label); charge(content, budget); }
    else {
      if (Array.isArray(value[mime]) && value[mime].length > NOTEBOOK_INTERCHANGE_LIMITS.metadataNodes) {
        notebookInterchangeError(`${label} exceeds 10000 string fragments.`, true);
      }
      notebookInterchangeArray(value[mime], label);
      content = value[mime].map(item => { notebookInterchangeText(item, label); charge(item, budget); return item; });
    }
    return [mime, content];
  }));
}
export function normalizeNotebookImportedOutput(value, budget = createNotebookInterchangeBudget()) {
  notebookInterchangeRecord(value, 'Imported output');
  if (value.output_type === 'stream') {
    notebookInterchangeFields(value, ['output_type', 'name', 'text'], 'Imported stream output', ['output_type', 'name', 'text']);
    const name = notebookInterchangeText(value.name, 'Output stream name'), text = notebookMultilineText(value.text, 'Imported stream text');
    charge(name, budget); charge(text, budget);
    return { output_type: 'stream', name, text };
  }
  if (value.output_type === 'error') {
    notebookInterchangeFields(value, ['output_type', 'ename', 'evalue', 'traceback'], 'Imported error output', ['output_type', 'ename', 'evalue', 'traceback']);
    notebookInterchangeArray(value.traceback, 'Imported traceback');
    if(value.traceback.length>NOTEBOOK_INTERCHANGE_LIMITS.metadataNodes)notebookInterchangeError('Imported traceback exceeds 10000 frames.', true);
    for(const frame of [value.ename,value.evalue,...value.traceback]){notebookInterchangeText(frame,'Imported error text');charge(frame,budget);}
    return { output_type: 'error', ename: notebookInterchangeText(value.ename, 'Imported error name'),
      evalue: notebookInterchangeText(value.evalue, 'Imported error message'),
      traceback: value.traceback.map(frame => notebookInterchangeText(frame, 'Imported traceback frame')) };
  }
  if (!['display_data', 'execute_result'].includes(value.output_type)) {
    notebookInterchangeError('Unsupported notebook output type. Supported types are stream, error, display_data and execute_result.');
  }
  const execute = value.output_type === 'execute_result';
  const allowed = ['output_type', 'data', 'metadata', ...(execute ? ['execution_count'] : [])];
  notebookInterchangeFields(value, allowed, 'Imported rich output', allowed);
  return { output_type: value.output_type, data: normalizeNotebookMimeBundle(value.data, 'Imported output MIME bundle', budget),
    metadata: normalizeNotebookInterchangeMetadata(value.metadata, NOTEBOOK_INTERCHANGE_LIMITS.outputMetadataBytes, 'Imported output metadata', budget),
    ...(execute ? { execution_count: count(value.execution_count, 'Output execution count') } : {}) };
}
export function normalizeNotebookImportedCell(value, { type, budget = createNotebookInterchangeBudget() } = {}) {
  if (!['code', 'markdown', 'raw'].includes(type)) notebookInterchangeError('Choose a supported imported cell type.');
  const code = type === 'code';
  const allowed = ['metadata', ...(code ? ['outputs', 'executionCount'] : ['attachments'])];
  notebookInterchangeFields(value, allowed, 'Imported cell payload', code ? allowed : ['metadata']);
  const metadata = knownMetadata(normalizeNotebookInterchangeMetadata(value.metadata,
    NOTEBOOK_INTERCHANGE_LIMITS.cellMetadataBytes, 'Imported cell metadata', budget), type);
  if (code) {
    notebookInterchangeArray(value.outputs, 'Imported cell outputs');
    budget.outputs += value.outputs.length;
    if (value.outputs.length > NOTEBOOK_INTERCHANGE_LIMITS.outputsPerCell || budget.outputs > NOTEBOOK_INTERCHANGE_LIMITS.outputs) {
      notebookInterchangeError('Imported results exceed 64 outputs per cell or 2000 outputs per notebook.', true);
    }
    return { metadata, outputs: value.outputs.map(output => normalizeNotebookImportedOutput(output, budget)),
      executionCount: count(value.executionCount, 'Cell execution count') };
  }
  if (!own(value, 'attachments')) return { metadata };
  notebookInterchangeRecord(value.attachments, 'Imported cell attachments');
  const names = Object.keys(value.attachments);
  budget.attachments += names.length;
  if (names.length > NOTEBOOK_INTERCHANGE_LIMITS.attachmentsPerCell || budget.attachments > NOTEBOOK_INTERCHANGE_LIMITS.attachments) {
    notebookInterchangeError('Imported attachments exceed 32 per cell or 256 per notebook.', true);
  }
  return { metadata, attachments: Object.fromEntries(names.sort().map(name => {
    notebookInterchangeText(name, 'Attachment name');
    if (!name || notebookInterchangeBytes(name) > NOTEBOOK_INTERCHANGE_LIMITS.filenameBytes || /\p{Cc}/u.test(name)) {
      notebookInterchangeError('Attachment names must contain 1–240 UTF-8 bytes without controls. They are inert cell-local names, not filesystem paths.');
    }
    return [name, normalizeNotebookMimeBundle(value.attachments[name], 'Attachment MIME bundle', budget)];
  })) };
}

/** Root document dispatch supplies its unchanged v1 normalizer; no module cycle. */
export function normalizeNotebookInterchangeContent(input, normalizeOrdinary) {
  notebookInterchangeFields(input, ['schema', 'defaultLanguage', 'cells', 'metadata', 'interchange'],
    'Imported notebook content', ['schema', 'defaultLanguage', 'cells', 'interchange']);
  if (input.schema !== NOTEBOOK_INTERCHANGE_SCHEMA) notebookInterchangeError('Choose the supported imported notebook schema.');
  if (typeof normalizeOrdinary !== 'function') notebookInterchangeError('Notebook source normalization is unavailable.');
  if (!Array.isArray(input.cells) || input.cells.length > NOTEBOOK_INTERCHANGE_LIMITS.cells) {
    notebookInterchangeError('A notebook must contain at most 2000 cells.', Array.isArray(input.cells));
  }
  notebookInterchangeArray(input.cells, 'Notebook cells');
  const budget = createNotebookInterchangeBudget();
  const metadata = normalizeNotebookInterchangeMetadata(input.metadata ?? {},
    NOTEBOOK_INTERCHANGE_LIMITS.documentMetadataBytes, 'Application notebook metadata', budget);
  const cells = input.cells.map(cell => {
    notebookInterchangeFields(cell, ['id', 'type', 'language', 'source', 'metadata', 'collapsed', 'imported'],
      'Notebook cell', ['id', 'type', 'source']);
    if (!['code', 'markdown', 'raw'].includes(cell.type)) notebookInterchangeError('Notebook cells must be code, Markdown or raw text.');
    const cellMetadata = normalizeNotebookInterchangeMetadata(cell.metadata ?? {},
      NOTEBOOK_INTERCHANGE_LIMITS.cellMetadataBytes, 'Application cell metadata', budget);
    notebookInterchangeText(cell.source, 'Cell source', NOTEBOOK_INTERCHANGE_LIMITS.sourceBytes);
    return { id: cell.id, type: cell.type === 'raw' ? 'markdown' : cell.type,
      ...(own(cell, 'language') ? { language: cell.language } : {}), source: cell.source, metadata: cellMetadata,
      ...(own(cell, 'collapsed') ? { collapsed: cell.collapsed } : {}) };
  });
  const ordinary = normalizeOrdinary({ schema: 'traceomics.notebook.v1', defaultLanguage: input.defaultLanguage, cells, metadata });
  const interchange = normalizeNotebookInterchange(input.interchange, budget);
  const result = { schema: NOTEBOOK_INTERCHANGE_SCHEMA, defaultLanguage: ordinary.defaultLanguage,
    cells: ordinary.cells.map((cell, index) => ({ ...cell, type: input.cells[index].type,
      ...(own(input.cells[index], 'imported')
        ? { imported: normalizeNotebookImportedCell(input.cells[index].imported, { type: input.cells[index].type, budget }) }
        : {}) })), metadata: ordinary.metadata, interchange };
  if (notebookInterchangeBytes(JSON.stringify(result)) > NOTEBOOK_INTERCHANGE_LIMITS.contentBytes) {
    notebookInterchangeError('Notebook source, retained outputs, attachments and metadata must fit the 1 MiB canonical content limit.', true);
  }
  return result;
}

function rasterPreview(bundle, mimeType) {
  if (!own(bundle, mimeType)) return null;
  const encoded = notebookMultilineText(bundle[mimeType], 'Imported raster representation').replace(/[\t\n\r ]/g, '');
  if (!encoded || encoded.length > Math.ceil(NOTEBOOK_INTERCHANGE_LIMITS.previewImageBytes / 3) * 4
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) return null;
  let binary;
  try { binary = globalThis.atob(encoded); } catch { return null; }
  if (!binary.length || binary.length > NOTEBOOK_INTERCHANGE_LIMITS.previewImageBytes) return null;
  const bytes = Uint8Array.from(binary, value => value.charCodeAt(0));
  let width, height;
  if (mimeType === 'image/png') {
    const signature = [137, 80, 78, 71, 13, 10, 26, 10];
    if (bytes.length < 33 || signature.some((value, index) => value !== bytes[index])
        || String.fromCharCode(...bytes.subarray(12, 16)) !== 'IHDR') return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(8) !== 13) return null;
    width = view.getUint32(16); height = view.getUint32(20);
    let offset=8,imageData=false,ended=false;
    while(offset+12<=bytes.length){
      const length=view.getUint32(offset);if(length>bytes.length-offset-12)return null;
      const type=String.fromCharCode(...bytes.subarray(offset+4,offset+8));
      if(['acTL','fcTL','fdAT'].includes(type))return null;
      if(type==='IDAT')imageData=true;
      offset+=length+12;
      if(type==='IEND'){ended=length===0&&offset===bytes.length;break;}
    }
    if(!imageData||!ended)return null;
  } else {
    if (bytes[0] !== 255 || bytes[1] !== 216) return null;
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 255) return null;
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 216 || marker === 1 || marker >= 208 && marker <= 215) continue;
      if (marker === 217 || marker === 218 || offset + 2 > bytes.length) break;
      const length = bytes[offset] * 256 + bytes[offset + 1];
      if (length < 2 || offset + length > bytes.length) return null;
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) {
        if (length < 8) return null;
        height = bytes[offset + 3] * 256 + bytes[offset + 4];
        width = bytes[offset + 5] * 256 + bytes[offset + 6]; break;
      }
      offset += length;
    }
  }
  if (!width || !height || width > NOTEBOOK_INTERCHANGE_LIMITS.previewImageDimension
      || height > NOTEBOOK_INTERCHANGE_LIMITS.previewImageDimension
      || width * height > NOTEBOOK_INTERCHANGE_LIMITS.previewImagePixels) return null;
  return { family: 'image', mimeType, base64: encoded, sizeBytes: bytes.byteLength, width, height };
}

/** A safe display projection only; the original MIME bundle remains untouched. */
export function notebookMimePreview(input) {
  const bundle = normalizeNotebookMimeBundle(input, 'Imported MIME preview');
  for (const mime of ['image/png', 'image/jpeg']) {
    const preview = rasterPreview(bundle, mime);
    if (preview) return preview;
  }
  let text;
  if (own(bundle, 'text/plain')) text = notebookMultilineText(bundle['text/plain'], 'Imported plain text');
  else if (own(bundle, 'application/json')) text = JSON.stringify(bundle['application/json'], null, 2);
  if (text !== undefined) {
    const bytes = encoder.encode(text), truncated = bytes.length > NOTEBOOK_INTERCHANGE_LIMITS.previewTextBytes;
    return { family: 'text', text: truncated
      ? new globalThis.TextDecoder().decode(bytes.subarray(0, NOTEBOOK_INTERCHANGE_LIMITS.previewTextBytes), { stream: true }) : text,
    truncated };
  }
  return { family: 'metadata', message: 'Imported representation retained for export; no supported safe browser preview is available.' };
}
