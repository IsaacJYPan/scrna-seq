'use strict';

const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_LOCAL_SIGNATURE = 0x04034b50;
const MAX_EOCD_SEARCH_BYTES = 65_557;
const MAX_CENTRAL_DIRECTORY_BYTES = 4 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 500;
const MAX_SELECTED_UNCOMPRESSED_BYTES = 1024 ** 3;

const VISIUM_REQUIRED_FILES = Object.freeze([
  'filtered_feature_bc_matrix.h5',
  'spatial/tissue_positions.csv (or spatial/tissue_positions_list.csv)',
  'spatial/scalefactors_json.json',
  'spatial/tissue_lowres_image.png',
]);

function validationError(message) {
  const error = new Error(message);
  error.code = 'DATASET_VALIDATION_FAILED';
  return error;
}

async function readExact(handle, length, position) {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const result = await handle.read(buffer, offset, length - offset, position + offset);
    if (result.bytesRead === 0) throw validationError('The ZIP archive is truncated.');
    offset += result.bytesRead;
  }
  return buffer;
}

function safeZipEntryName(nameBytes, flags) {
  if (nameBytes.length === 0 || nameBytes.length > 240) {
    throw validationError('The ZIP archive contains an invalid entry name.');
  }
  // The required Space Ranger names are ASCII. Reject ambiguous legacy encodings
  // instead of letting different ZIP readers disagree about the selected path.
  if ((flags & 0x0800) === 0 && nameBytes.some((byte) => byte > 0x7f)) {
    throw validationError('The ZIP archive contains an unsupported entry name encoding.');
  }
  const name = nameBytes.toString('utf8');
  if (name.includes('\uFFFD') || name.includes('\0') || name.includes('\\')
      || name.startsWith('/') || /^[A-Za-z]:/.test(name)) {
    throw validationError('The ZIP archive contains an unsafe entry path.');
  }
  const withoutTrailingSlash = name.endsWith('/') ? name.slice(0, -1) : name;
  const parts = withoutTrailingSlash.split('/');
  if (!withoutTrailingSlash || parts.some((part) => !part || part === '.' || part === '..')) {
    throw validationError('The ZIP archive contains an unsafe entry path.');
  }
  return name;
}

async function inspectZipInventory(handle, sizeBytes) {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 22) {
    throw validationError('The uploaded file is not a complete ZIP archive.');
  }
  const tailLength = Math.min(sizeBytes, MAX_EOCD_SEARCH_BYTES);
  const tailPosition = sizeBytes - tailLength;
  const tail = await readExact(handle, tailLength, tailPosition);
  let eocdOffset = -1;
  for (let index = tail.length - 22; index >= 0; index -= 1) {
    if (tail.readUInt32LE(index) !== ZIP_EOCD_SIGNATURE) continue;
    const commentLength = tail.readUInt16LE(index + 20);
    if (tailPosition + index + 22 + commentLength === sizeBytes) {
      eocdOffset = index;
      break;
    }
  }
  if (eocdOffset < 0) throw validationError('The uploaded file is not a complete ZIP archive.');

  const diskNumber = tail.readUInt16LE(eocdOffset + 4);
  const centralDisk = tail.readUInt16LE(eocdOffset + 6);
  const diskEntries = tail.readUInt16LE(eocdOffset + 8);
  const totalEntries = tail.readUInt16LE(eocdOffset + 10);
  const centralSize = tail.readUInt32LE(eocdOffset + 12);
  const centralOffset = tail.readUInt32LE(eocdOffset + 16);
  if (diskNumber !== 0 || centralDisk !== 0 || diskEntries !== totalEntries
      || totalEntries < 1 || totalEntries > MAX_ARCHIVE_ENTRIES
      || totalEntries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw validationError('The ZIP archive layout is unsupported.');
  }
  if (centralSize < 46 || centralSize > MAX_CENTRAL_DIRECTORY_BYTES
      || centralOffset + centralSize > tailPosition + eocdOffset) {
    throw validationError('The ZIP archive inventory is invalid.');
  }

  const central = await readExact(handle, centralSize, centralOffset);
  const entries = [];
  const seen = new Set();
  let cursor = 0;
  for (let index = 0; index < totalEntries; index += 1) {
    if (cursor + 46 > central.length || central.readUInt32LE(cursor) !== ZIP_CENTRAL_SIGNATURE) {
      throw validationError('The ZIP archive inventory is invalid.');
    }
    const flags = central.readUInt16LE(cursor + 8);
    const method = central.readUInt16LE(cursor + 10);
    const compressedSize = central.readUInt32LE(cursor + 20);
    const uncompressedSize = central.readUInt32LE(cursor + 24);
    const nameLength = central.readUInt16LE(cursor + 28);
    const extraLength = central.readUInt16LE(cursor + 30);
    const commentLength = central.readUInt16LE(cursor + 32);
    const externalAttributes = central.readUInt32LE(cursor + 38);
    const localHeaderOffset = central.readUInt32LE(cursor + 42);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > central.length || (flags & 0x0001) !== 0 || ![0, 8].includes(method)
        || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff
        || localHeaderOffset === 0xffffffff || localHeaderOffset + 30 > centralOffset) {
      throw validationError('The ZIP archive contains an unsupported entry.');
    }
    const unixType = (externalAttributes >>> 16) & 0xf000;
    if (unixType === 0xa000) throw validationError('The ZIP archive contains an unsafe link.');
    const name = safeZipEntryName(central.subarray(cursor + 46, cursor + 46 + nameLength), flags);
    if (seen.has(name)) throw validationError('The ZIP archive contains duplicate entries.');
    seen.add(name);
    entries.push({ name, uncompressedSize, localHeaderOffset, directory: name.endsWith('/') });
    cursor = next;
  }
  if (cursor !== central.length) throw validationError('The ZIP archive inventory is invalid.');

  for (const entry of entries.filter((item) => !item.directory)) {
    const local = await readExact(handle, 4, entry.localHeaderOffset);
    if (local.readUInt32LE(0) !== ZIP_LOCAL_SIGNATURE) {
      throw validationError('The ZIP archive contains an invalid file entry.');
    }
  }
  return entries;
}

async function validateClassicVisiumZip(handle, sizeBytes) {
  const entries = await inspectZipInventory(handle, sizeBytes);
  const files = entries.filter((entry) => !entry.directory);
  const matrixEntries = files.filter((entry) => entry.name.split('/').at(-1) === 'filtered_feature_bc_matrix.h5');
  if (matrixEntries.length !== 1) {
    return { valid: false, errors: ['Include exactly one filtered_feature_bc_matrix.h5 file.'] };
  }
  const matrix = matrixEntries[0];
  const slash = matrix.name.lastIndexOf('/');
  const prefix = slash < 0 ? '' : matrix.name.slice(0, slash + 1);
  const requiredAlternatives = [
    [`${prefix}spatial/tissue_positions.csv`, `${prefix}spatial/tissue_positions_list.csv`],
    [`${prefix}spatial/scalefactors_json.json`],
    [`${prefix}spatial/tissue_lowres_image.png`],
  ];
  const byName = new Map(files.map((entry) => [entry.name, entry]));
  const missing = requiredAlternatives.filter((choices) => !choices.some((choice) => byName.has(choice)));
  if (missing.length > 0) {
    return {
      valid: false,
      errors: ['The Visium ZIP is missing one or more required Space Ranger files.'],
    };
  }
  const selected = [matrix, ...requiredAlternatives.map((choices) => byName.get(choices.find((choice) => byName.has(choice))))];
  if (selected.some((entry) => entry.uncompressedSize < 1)) {
    return { valid: false, errors: ['One or more required Visium files are empty.'] };
  }
  const uncompressedBytes = selected.reduce((total, entry) => total + entry.uncompressedSize, 0);
  if (!Number.isSafeInteger(uncompressedBytes) || uncompressedBytes > MAX_SELECTED_UNCOMPRESSED_BYTES) {
    return { valid: false, errors: ['The required Visium files exceed the supported uncompressed size.'] };
  }
  return { valid: true, errors: null };
}

async function validateStoredDataset(provider, dataset) {
  if (dataset?.fileType !== 'visium_zip') return { validationStatus: 'pending', validationErrors: null };
  const opened = await provider.openVerifiedRead(dataset.internalStorageKey, {
    checksumSha256: dataset.sha256,
    sizeBytes: dataset.fileSizeBytes,
  });
  try {
    const result = await validateClassicVisiumZip(opened.handle, opened.stat.size);
    return {
      validationStatus: result.valid ? 'valid' : 'invalid',
      validationErrors: result.errors,
    };
  } catch (error) {
    if (error?.code !== 'DATASET_VALIDATION_FAILED') throw error;
    return { validationStatus: 'invalid', validationErrors: [error.message] };
  } finally {
    await opened.handle.close();
  }
}

module.exports = {
  VISIUM_REQUIRED_FILES,
  inspectZipInventory,
  validateClassicVisiumZip,
  validateStoredDataset,
};
