'use strict';

// Storage locations and R state keys for analysis objects are server-controlled.
// A client may not set them at the top level of a request or anywhere inside
// its metadata.

const REJECTED_ANALYSIS_OBJECT_STORAGE_FIELDS = [
  'storageUri', 'storage_uri',
  'storageKey', 'storage_key',
  'internalStorageKey', 'internal_storage_key',
  'objectHash', 'object_hash',
  'path', 'filePath', 'file_path',
  'stateKey', 'state_key'
];
const REJECTED_ANALYSIS_OBJECT_STORAGE_FIELD_SET = new Set(REJECTED_ANALYSIS_OBJECT_STORAGE_FIELDS);

function findRejectedAnalysisObjectStorageField(value) {
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findRejectedAnalysisObjectStorageField(item);
      if (found) return found;
    }
    return null;
  }
  for (const [field, child] of Object.entries(value)) {
    if (REJECTED_ANALYSIS_OBJECT_STORAGE_FIELD_SET.has(field)) return field;
    const found = findRejectedAnalysisObjectStorageField(child);
    if (found) return found;
  }
  return null;
}

function rejectAnalysisObjectStorageFields(body, res) {
  for (const field of REJECTED_ANALYSIS_OBJECT_STORAGE_FIELDS) {
    if (body[field] !== undefined) {
      res.status(400).json({ error: `Field '${field}' is not allowed; storage and state are server-controlled.` });
      return true;
    }
  }
  const metadataField = findRejectedAnalysisObjectStorageField(body.metadata);
  if (metadataField) {
    res.status(400).json({ error: `Metadata field '${metadataField}' is not allowed; storage and state are server-controlled.` });
    return true;
  }
  return false;
}

module.exports = {
  REJECTED_ANALYSIS_OBJECT_STORAGE_FIELDS,
  findRejectedAnalysisObjectStorageField,
  rejectAnalysisObjectStorageFields,
};
