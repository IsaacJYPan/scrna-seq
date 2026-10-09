'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const { TextDecoder } = require('node:util');

const PREVIEW_LIMITS = Object.freeze({ bytes: 256 * 1024, scanBytes: 2 * 1024 * 1024, rows: 100, columns: 100, cellCharacters: 2000, imageBytes: 5 * 1024 * 1024, imagePixels: 12000000 });
const FORMATS = Object.freeze({
  '.csv': { type: 'table', id: 'org.ietf.csv', mime: 'text/csv', preview: 'table', delimiter: ',' },
  '.tsv': { type: 'table', id: 'org.iana.tsv', mime: 'text/tab-separated-values', preview: 'table', delimiter: '\t' },
  '.json': { type: 'file', id: 'org.ietf.json', mime: 'application/json', preview: 'json' },
  '.txt': { type: 'file', id: 'org.ietf.text', mime: 'text/plain', preview: 'text' },
  '.png': { type: 'image', id: 'org.w3.png', mime: 'image/png', preview: 'image' },
  '.jpg': { type: 'image', id: 'org.iso.jpeg', mime: 'image/jpeg', preview: 'image' },
  '.jpeg': { type: 'image', id: 'org.iso.jpeg', mime: 'image/jpeg', preview: 'image' },
  '.rds': { type: 'object', id: 'org.r-project.rds', mime: 'application/octet-stream', preview: null },
});
function previewError(message, status = 400) { return Object.assign(new Error(message), { code: 'ARTIFACT_PREVIEW_INVALID', status }); }

function fileFormat(filename, artifactType) {
  const ext = path.extname(filename || '').toLowerCase();
  const spec = FORMATS[ext];
  if (artifactType === 'sample-sheet') {
    if (!['.csv', '.tsv'].includes(ext)) throw previewError('A sample sheet must be CSV or TSV.');
    return { ...spec, type: 'sample-sheet' };
  }
  if (!spec) return { type: 'file', id: 'org.traceomics.opaque-file', mime: 'application/octet-stream', preview: null };
  return spec;
}

async function readBounded(handle, maximum) {
  const buffer = Buffer.alloc(maximum + 1);
  let position = 0;
  while (position < buffer.length) {
    const result = await handle.read(buffer, position, buffer.length - position, position);
    if (!result.bytesRead) break;
    position += result.bytesRead;
  }
  return { bytes: buffer.subarray(0, Math.min(position, maximum)), truncated: position > maximum };
}
function decode(bytes, truncated = false) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: truncated }); }
  catch { throw previewError('This preview requires valid UTF-8 text.'); }
}

function parseDelimited(source, delimiter, { offset = 0, limit = 50, truncated = false } = {}) {
  const records = []; let record = []; let field = ''; let quoted = false; let closed = false; let count = 0; let columns; let hasMore = false;
  const fieldDone = () => {
    if (record.length >= PREVIEW_LIMITS.columns) throw previewError('Table preview exceeds 100 columns.');
    record.push(field); field = ''; closed = false;
  };
  const recordDone = () => {
    fieldDone();
    if (!columns) {
      columns = record.map((value, index) => index === 0 ? value.replace(/^\uFEFF/, '') : value);
      if (columns.some(value => !value.trim()) || new Set(columns).size !== columns.length) throw previewError('Table headers must be nonempty and unique.');
    } else if (!(record.length === 1 && record[0] === '')) {
      if (record.length !== columns.length) throw previewError('Table rows must match the header column count.');
      if (count >= offset && records.length < limit) records.push(record);
      else if (count >= offset + limit) hasMore = true;
      count++;
    }
    record = [];
  };
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') { field += '"'; index++; }
      else if (char === '"') { quoted = false; closed = true; }
      else field += char;
    } else if (char === '"') {
      if (field || closed) throw previewError('Unexpected quote in table preview.');
      quoted = true;
    } else if (char === delimiter) fieldDone();
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[index + 1] === '\n') index++;
      recordDone();
      if (hasMore) break;
    } else {
      if (closed) throw previewError('Unexpected text after a quoted table field.');
      field += char;
    }
    if (field.length > PREVIEW_LIMITS.cellCharacters) throw previewError('A table preview cell exceeds 2000 characters.');
  }
  if (!hasMore && !truncated) {
    if (quoted) throw previewError('A quoted table field was not closed.');
    if (field || record.length || closed) recordDone();
  }
  if (!columns) throw previewError('A complete table header is required for preview.');
  if (truncated && !hasMore && records.length === 0) throw previewError('The requested rows exceed the bounded preview scan. Select an earlier page or use a private analysis runtime.', 413);
  return { family: 'table', columns, rows: records, offset, limit, hasMore: hasMore || truncated, scannedRows: count, truncated };
}

function imageDimensions(bytes, format) {
  if (format === 'org.w3.png') {
    if (bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes.toString('ascii', 12, 16) !== 'IHDR') throw previewError('The file is not a supported PNG image.');
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw previewError('The file is not a supported JPEG image.');
  let position = 2;
  while (position + 4 <= bytes.length) {
    if (bytes[position++] !== 0xff) throw previewError('The JPEG header is invalid.');
    while (bytes[position] === 0xff) position++;
    if (position + 3 > bytes.length) break;
    const marker = bytes[position++];
    if ([0xd8, 0x01].includes(marker)) continue;
    if ([0xd9, 0xda].includes(marker)) break;
    const length = bytes.readUInt16BE(position);
    if (length < 2 || position + length > bytes.length) break;
    if ([0xc0, 0xc1, 0xc2].includes(marker) && length >= 8) return { height: bytes.readUInt16BE(position + 3), width: bytes.readUInt16BE(position + 5) };
    position += length;
  }
  throw previewError('JPEG dimensions are unavailable within the bounded header scan.');
}

async function inspectImportedFile(filename, artifactType) {
  const handle = await fs.open(filename.path, 'r');
  try {
    const stat = await handle.stat();
    return await inspectImportedHandle({ handle, stat, originalFilename: filename.originalFilename }, artifactType);
  } finally { await handle.close(); }
}

async function inspectImportedHandle({ handle, stat, originalFilename }, artifactType, options = {}) {
    const spec = fileFormat(originalFilename, artifactType);
    if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size < 0) throw previewError('Select a regular file with a valid size.');
    const maximum = options.maxBytes ?? (spec.type === 'object' ? 200 * 1024 * 1024 : 25 * 1024 * 1024);
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 64 * 1024 ** 3) throw previewError('The artifact inspection limit is invalid.');
    if (stat.size > maximum) throw previewError(`This artifact exceeds the ${maximum / (1024 * 1024)} MiB import limit.`, 413);
    const metadata = {};
    if (spec.preview === 'image') {
      const header = await readBounded(handle, 128 * 1024);
      const dimensions = imageDimensions(header.bytes, spec.id);
      if (!dimensions.width || !dimensions.height || dimensions.width > 100000 || dimensions.height > 100000) throw previewError('Image dimensions are invalid.');
      metadata['org.traceomics.image:width'] = dimensions.width;
      metadata['org.traceomics.image:height'] = dimensions.height;
    } else if (spec.preview === 'table') {
      const prefix = await readBounded(handle, PREVIEW_LIMITS.scanBytes);
      const summary = parseDelimited(decode(prefix.bytes, prefix.truncated), spec.delimiter, { limit: 1, truncated: prefix.truncated });
      metadata['org.traceomics.table:columns'] = summary.columns;
      metadata['org.traceomics.preview:validation'] = 'bounded-preview-only';
    }
    return { ...spec, metadata, sizeBytes: stat.size };
}

function previewCapabilities(type, format, sizeBytes) {
  if (['object', 'coordinates'].includes(type)) return [];
  if (['org.ietf.csv', 'org.iana.tsv', 'org.traceomics.table'].includes(format.id)) return ['table'];
  if (format.id === 'org.ietf.json') return sizeBytes <= PREVIEW_LIMITS.scanBytes ? ['json'] : [];
  if (format.id === 'org.ietf.text') return ['text'];
  if (['org.w3.png', 'org.iso.jpeg'].includes(format.id)) {
    const width = format.metadata?.['org.traceomics.image:width']; const height = format.metadata?.['org.traceomics.image:height'];
    if (sizeBytes <= PREVIEW_LIMITS.imageBytes && width && height && width * height <= PREVIEW_LIMITS.imagePixels) return ['image'];
  }
  return [];
}

async function buildPreview(opened, artifact, options = {}) {
  const offset = Number(options.offset ?? 0); const limit = Number(options.limit ?? 50);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10000 || !Number.isSafeInteger(limit) || limit < 1 || limit > PREVIEW_LIMITS.rows) throw previewError('Preview offset must be 0–10000 and page size 1–100.');
  const id = artifact.format.id;
  if (artifact.previews.includes('image')) return { family: 'image', width: artifact.format.metadata['org.traceomics.image:width'], height: artifact.format.metadata['org.traceomics.image:height'], boundedBytes: artifact.sizeBytes };
  const content = await readBounded(opened.handle, ['org.ietf.csv', 'org.iana.tsv', 'org.ietf.json', 'org.traceomics.table'].includes(id) ? PREVIEW_LIMITS.scanBytes : 16 * 1024);
  const text = decode(content.bytes, content.truncated);
  let result;
  if (['org.ietf.csv', 'org.iana.tsv'].includes(id)) result = parseDelimited(text, id === 'org.iana.tsv' ? '\t' : ',', { offset, limit, truncated: content.truncated });
  else if (['org.ietf.json', 'org.traceomics.table'].includes(id)) {
    if (content.truncated) throw previewError('JSON preview exceeds its bounded scan.', 413);
    let value;
    try { value = JSON.parse(text); } catch { throw previewError('The saved file does not contain valid JSON.'); }
    if (Array.isArray(value) && value.length && value.every(row => row && typeof row === 'object' && !Array.isArray(row))) {
      const columns = Object.keys(value[0]);
      if (columns.length > PREVIEW_LIMITS.columns || columns.some(column => column.length > 200)) throw previewError('JSON table preview has too many or oversized columns.');
      const rows = value.slice(offset, offset + limit).map(row => columns.map(column => String(row[column] ?? '').slice(0, PREVIEW_LIMITS.cellCharacters)));
      result = { family: 'table', columns, rows, offset, limit, hasMore: offset + limit < value.length, truncated: false };
    } else result = { family: 'text', text: JSON.stringify(value, null, 2).slice(0, 16 * 1024), truncated: text.length > 16 * 1024 };
  } else result = { family: 'text', text, truncated: content.truncated };
  if (Buffer.byteLength(JSON.stringify(result)) > PREVIEW_LIMITS.bytes) throw previewError('Preview exceeds the 256 KiB response budget. Reduce the page size.', 413);
  return result;
}

module.exports = { PREVIEW_LIMITS, fileFormat, parseDelimited, imageDimensions, inspectImportedFile, inspectImportedHandle, previewCapabilities, buildPreview };
