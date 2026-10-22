import { normalizeServerDataImportRequest } from './serverDataImport.mjs';
import { ANALYSIS_ATTACHMENT_ID, ANALYSIS_ATTACHMENT_REVISION_ID, normalizeAnalysisAttachmentCreate } from './analysisAttachment.mjs';

export const ANALYSIS_SERVER_INTAKE_SCHEMA = 'traceomics.analysis-server-intake.v1';
export const ANALYSIS_SERVER_INTAKE_LIMITS = Object.freeze({ recipes: 2000, page: 30, cursor: 256, canonicalBytes: 65536, fileBytes: 200 * 1024 * 1024 });
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const inputFields = ['requestId', 'serviceId', 'projectId', 'ownerUserId', 'importRequest', 'selectionSizeBytes', 'attachment'];
const attachmentFields = ['requestId', 'action', 'attachmentId', 'expectedHeadRevisionId', 'caption', 'suppliedOrigin'];
const acceptedFields = ['versionId', 'sha256', 'sizeBytes', 'previousVersionId'];
function invalid(message) {
  throw Object.assign(new Error(message), { code: 'INVALID_ANALYSIS_SERVER_INTAKE', status: 400 });
}
function plain(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid('Use plain server intake metadata.');
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      invalid('Use plain server intake metadata without computed or hidden fields.');
    }
  }
}
function fields(value, allowed) {
  plain(value);
  if (Reflect.ownKeys(value).length !== allowed.length || Object.keys(value).some(key => !allowed.includes(key))) {
    invalid('Use only the documented server intake metadata fields. File bytes and absolute paths are not admission metadata.');
  }
}
function uuid(value) {
  if (typeof value !== 'string' || !UUID.test(value)) invalid('Keep the original import and attachment request UUIDs.');
  return value.toLowerCase();
}
export function normalizeAnalysisServerIntake(input) {
  fields(input, inputFields);
  const requestId = uuid(input.requestId);
  if (typeof input.serviceId !== 'string' || !/^svc_[a-f0-9]{32}$/.test(input.serviceId)
      || typeof input.projectId !== 'string' || !/^proj_[a-f0-9]{16,40}$/.test(input.projectId)
      || !Number.isSafeInteger(input.ownerUserId) || input.ownerUserId < 1) {
    invalid('Keep the original server, project and import account for this intake.');
  }
  let importRequest;
  try { importRequest = normalizeServerDataImportRequest(input.importRequest); }
  catch (error) {
    if (error?.status !== 400) throw error;
    invalid('Keep the exact bounded granted-root selection, token, import settings and original UUID.');
  }
  if (importRequest.requestId !== requestId || importRequest.artifactType !== 'auto' || importRequest.previousVersionId !== null
      || !/\.(?:csv|tsv|png|jpe?g)$/i.test(importRequest.relativePath)
      || ![importRequest.relativePath, importRequest.name, ...Object.values(importRequest.sampleMetadata || {})].every(value => value.isWellFormed())) {
    invalid('Server evidence intake supports a new automatic CSV, TSV, PNG or JPEG import with its original selection and valid Unicode metadata.');
  }
  // This value is frozen selection metadata, not a verified checksum or a grant.
  // Fresh admission must verify it against the actual signed ordinary file.
  if (!Number.isSafeInteger(input.selectionSizeBytes) || input.selectionSizeBytes < 1
      || input.selectionSizeBytes > ANALYSIS_SERVER_INTAKE_LIMITS.fileBytes) {
    invalid('Select a nonempty server result of at most 200 MiB within the current server import limit.');
  }
  fields(input.attachment, attachmentFields);
  const attachmentRequestId = uuid(input.attachment.requestId), action = input.attachment.action;
  if (attachmentRequestId === requestId) invalid('Keep a separate original request UUID for the attachment step.');
  if (action !== 'create' && action !== 'correct'
      || action === 'create' && (input.attachment.attachmentId !== null || input.attachment.expectedHeadRevisionId !== null)
      || action === 'correct' && (typeof input.attachment.attachmentId !== 'string' || !ANALYSIS_ATTACHMENT_ID.test(input.attachment.attachmentId)
        || typeof input.attachment.expectedHeadRevisionId !== 'string' || !ANALYSIS_ATTACHMENT_REVISION_ID.test(input.attachment.expectedHeadRevisionId))) {
    invalid('Choose a new attachment or keep the exact attachment and expected revision for a correction.');
  }
  let context;
  try {
    context = normalizeAnalysisAttachmentCreate({ requestId: attachmentRequestId,
      reference: { kind: 'artifact-version', versionId: 'av_' + '0'.repeat(24), sha256: '0'.repeat(64) },
      caption: input.attachment.caption, suppliedOrigin: input.attachment.suppliedOrigin });
  } catch (error) {
    if (error?.code !== 'INVALID_ANALYSIS_ATTACHMENT') throw error;
    invalid('Keep a caption and bounded plain supplied origin notes for this exact intake.');
  }
  return { requestId, serviceId: input.serviceId, projectId: input.projectId, ownerUserId: input.ownerUserId, importRequest,
    selectionSizeBytes: input.selectionSizeBytes, attachment: { requestId: context.requestId, action,
      attachmentId: input.attachment.attachmentId, expectedHeadRevisionId: input.attachment.expectedHeadRevisionId,
      caption: context.caption, suppliedOrigin: context.suppliedOrigin } };
}
export function canonicalAnalysisServerIntake(analysisId, input) {
  if (typeof analysisId !== 'string' || !/^ra_[a-f0-9]{24}$/.test(analysisId)) invalid('Keep the original analysis identity for this intake.');
  const recipe = normalizeAnalysisServerIntake(input);
  const canonical = JSON.stringify({ schema: ANALYSIS_SERVER_INTAKE_SCHEMA, serviceId: recipe.serviceId,
    projectId: recipe.projectId, analysisId, ownerUserId: recipe.ownerUserId, requestId: recipe.requestId,
    selectionSizeBytes: recipe.selectionSizeBytes, importRequest: recipe.importRequest, attachment: recipe.attachment });
  if (new TextEncoder().encode(canonical).byteLength > ANALYSIS_SERVER_INTAKE_LIMITS.canonicalBytes) invalid('The intake metadata exceeds its 64 KiB admission bound.');
  return canonical;
}
export function analysisServerIntakeAttachmentRequest(input, acceptance) {
  const recipe = normalizeAnalysisServerIntake(input);
  plain(acceptance);
  if (acceptedFields.some(key => !Object.hasOwn(acceptance, key))
      || typeof acceptance.versionId !== 'string' || !/^av_[a-f0-9]{24}$/.test(acceptance.versionId)
      || typeof acceptance.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(acceptance.sha256)
      || acceptance.sizeBytes !== recipe.selectionSizeBytes || acceptance.previousVersionId !== null) {
    invalid('Recover the exact accepted server import before preparing its attachment.');
  }
  const { requestId, caption, suppliedOrigin, action, expectedHeadRevisionId } = recipe.attachment;
  return { requestId, ...(action === 'correct' ? { expectedHeadRevisionId } : {}),
    reference: { kind: 'artifact-version', versionId: acceptance.versionId, sha256: acceptance.sha256 }, caption, suppliedOrigin };
}
