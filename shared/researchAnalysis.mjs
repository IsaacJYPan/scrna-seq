export const RESEARCH_ANALYSIS_SCHEMA = 'traceomics.research-analysis.v1';
export const RESEARCH_ANALYSIS_LIMITS = Object.freeze({ name: 160, description: 8000, references: 50, page: 100 });
export const RESEARCH_ANALYSIS_ID = /^ra_[a-f0-9]{24}$/;
export const RESEARCH_ANALYSIS_REFERENCE_KINDS = Object.freeze(['artifact-version', 'analysis-object', 'workflow-snapshot']);
// A later document service must bind these identifiers to an authorized immutable
// revision. Reserving a kind is not evidence that its source can be resolved now.
export const RESERVED_RESEARCH_REFERENCE_KINDS = Object.freeze(['document-version', 'study-design-version']);
export const RESEARCH_DOCUMENT_REFERENCE_SCHEMA = 'traceomics.analysis-document-reference.v1';
export const RESEARCH_DOCUMENT_REFERENCE_CONTRACT = Object.freeze({
  schema: RESEARCH_DOCUMENT_REFERENCE_SCHEMA, kind: 'document-version', availability: 'reserved',
  fields: Object.freeze(['kind', 'documentId', 'versionId', 'sha256']),
});
// NB-01 will resolve a documentId and immutable versionId in this analysis and
// project, verify the exact source checksum, and apply document read access.
// Until that service exists, validateResearchAnalysisReference rejects the kind.
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const VERSION_ID = /^(?:av|art|eri)_[a-f0-9]{16,40}$/;
const HASH = /^[a-f0-9]{64}$/;
const own = (value, key) => Object.hasOwn(value, key);
function invalid(message, code = 'INVALID_RESEARCH_ANALYSIS') {
  throw Object.assign(new Error(message), { code, status: 400 });
}
function fields(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => !allowed.includes(key))) {
    invalid('Use only the documented analysis fields. Identity, ownership and timestamps are set by the server.');
  }
}
function text(value, name, maximum, multiline = false) {
  if (typeof value !== 'string') invalid(`${name} must be text.`);
  const result = multiline ? value.replace(/\r\n?/g, '\n') : value.trim();
  const invalidControl = [...result].some(char => { const code = char.charCodeAt(0); return code === 127 || code < 32 && !(multiline && [9, 10].includes(code)); });
  if ((!multiline && !result) || [...result].length > maximum || invalidControl || !result.isWellFormed()) {
    invalid(`${name} must contain ${multiline ? 'at most ' : '1–'}${maximum} characters${multiline ? '.' : ' on one line.'}`);
  }
  return result;
}
export function validateResearchAnalysisReference(value) {
  if (RESERVED_RESEARCH_REFERENCE_KINDS.includes(value?.kind)) {
    invalid('This reference requires a versioned document or study-design source that is not available yet.', 'ANALYSIS_REFERENCE_UNSUPPORTED');
  }
  if (value?.kind === 'workflow-snapshot') {
    fields(value, ['kind', 'snapshotId', 'sha256']);
    if (typeof value.snapshotId !== 'string' || !/^wfs_[a-f0-9]{24}$/.test(value.snapshotId)
        || typeof value.sha256 !== 'string' || !HASH.test(value.sha256)) invalid('Select an exact saved workflow snapshot and its SHA-256 checksum.');
    return { kind: value.kind, snapshotId: value.snapshotId, sha256: value.sha256 };
  }
  if (value?.kind === 'artifact-version') {
    fields(value, ['kind', 'versionId', 'sha256']);
    if (typeof value.versionId !== 'string' || !VERSION_ID.test(value.versionId)
        || typeof value.sha256 !== 'string' || !HASH.test(value.sha256)) invalid('Select an exact saved artifact version and its SHA-256 checksum.');
    return { kind: value.kind, versionId: value.versionId, sha256: value.sha256 };
  }
  if (value?.kind === 'analysis-object') {
    fields(value, ['kind', 'analysisObjectId', 'checkpointVersionId', 'sha256']);
    if (typeof value.analysisObjectId !== 'string' || !/^ao_[a-f0-9]{16,40}$/.test(value.analysisObjectId)
        || typeof value.checkpointVersionId !== 'string' || !/^art_[a-f0-9]{16,40}$/.test(value.checkpointVersionId)
        || typeof value.sha256 !== 'string' || !HASH.test(value.sha256)) {
      invalid('An analysis object requires an exact saved checkpoint version and its SHA-256 checksum.');
    }
    return { kind: value.kind, analysisObjectId: value.analysisObjectId, checkpointVersionId: value.checkpointVersionId, sha256: value.sha256 };
  }
  invalid('Choose a supported exact artifact or saved analysis-object reference.');
}
function references(value) {
  if (!Array.isArray(value) || value.length > RESEARCH_ANALYSIS_LIMITS.references) invalid('An analysis can contain at most 50 exact references.');
  const result = value.map(validateResearchAnalysisReference);
  if (new Set(result.map(item => JSON.stringify(item))).size !== result.length) invalid('An analysis cannot contain duplicate references.');
  return result;
}
function studyDesign(value) {
  if (value !== null) invalid('Versioned study-design references are not available yet. Keep study notes in the description for now.', 'ANALYSIS_REFERENCE_UNSUPPORTED');
  return null;
}
export function normalizeResearchAnalysisCreate(input) {
  fields(input, ['requestId', 'name', 'description', 'references', 'studyDesignRef']);
  if (typeof input.requestId !== 'string' || !UUID.test(input.requestId)) invalid('A request UUID is required to safely create or recover this analysis.');
  return { requestId: input.requestId.toLowerCase(), name: text(input.name, 'Analysis name', RESEARCH_ANALYSIS_LIMITS.name),
    description: text(input.description ?? '', 'Analysis description', RESEARCH_ANALYSIS_LIMITS.description, true),
    references: references(input.references ?? []), studyDesignRef: studyDesign(input.studyDesignRef ?? null) };
}
export function normalizeResearchAnalysisPatch(input) {
  fields(input, ['expectedVersion', 'name', 'description', 'status', 'references', 'studyDesignRef']);
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1 || input.expectedVersion >= 2147483647) invalid('The exact current analysis version is required before saving changes.');
  const result = { expectedVersion: input.expectedVersion };
  if (own(input, 'name')) result.name = text(input.name, 'Analysis name', RESEARCH_ANALYSIS_LIMITS.name);
  if (own(input, 'description')) result.description = text(input.description, 'Analysis description', RESEARCH_ANALYSIS_LIMITS.description, true);
  if (own(input, 'status')) {
    if (!['active', 'archived'].includes(input.status)) invalid('Choose active or archived analysis status.');
    result.status = input.status;
  }
  if (own(input, 'references')) result.references = references(input.references);
  if (own(input, 'studyDesignRef')) result.studyDesignRef = studyDesign(input.studyDesignRef);
  if (Object.keys(result).length === 1) invalid('Choose at least one analysis field to change.');
  return result;
}
