import { normalizeArtifactImportRequest } from './artifactImport.mjs';
import { ANALYSIS_ATTACHMENT_ID, ANALYSIS_ATTACHMENT_REVISION_ID, normalizeAnalysisAttachmentCreate } from './analysisAttachment.mjs';

export const ANALYSIS_LOCAL_INTAKE_SCHEMA = 'traceomics.analysis-local-intake.v1';
export const ANALYSIS_LOCAL_INTAKE_LIMITS = Object.freeze({ recipes: 2000, page: 30, cursor: 256, canonicalBytes: 65536, fileBytes: 25 * 1024 * 1024 });
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const inputFields = ['requestId', 'serviceId', 'importRequest', 'attachment'];
const importFields = ['schema', 'projectId', 'ownerUserId', 'requestId', 'originalFilename', 'name', 'artifactType', 'previousVersionId', 'sha256', 'sizeBytes'];
const attachmentFields = ['requestId', 'action', 'attachmentId', 'expectedHeadRevisionId', 'caption', 'suppliedOrigin'];
function invalid(message) {
  throw Object.assign(new Error(message), { code: 'INVALID_ANALYSIS_LOCAL_INTAKE', status: 400 });
}
function fields(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Reflect.ownKeys(value).length !== allowed.length) {
    invalid('Use the documented local intake metadata fields. File bytes and local paths are not admission metadata.');
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !allowed.includes(key) || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      invalid('Use plain local intake metadata without extra or computed fields.');
    }
  }
}
function uuid(value) {
  if (typeof value !== 'string' || !UUID.test(value)) invalid('Keep the original import and attachment request UUIDs.');
  return value.toLowerCase();
}
export function normalizeAnalysisLocalIntake(input) {
  fields(input, inputFields);
  const requestId = uuid(input.requestId);
  if (typeof input.serviceId !== 'string' || !/^svc_[a-f0-9]{32}$/.test(input.serviceId)) invalid('Confirm the same analysis server before preparing this import.');
  fields(input.importRequest, importFields);
  let importRequest;
  try { importRequest = normalizeArtifactImportRequest({ ...input.importRequest, requestId: uuid(input.importRequest.requestId) }); }
  catch { invalid('Keep the exact bounded file checksum, size, name, account, project and original import UUID.'); }
  if (requestId !== importRequest.requestId || importRequest.artifactType !== 'auto' || importRequest.previousVersionId !== null
      || !/\.(?:csv|tsv|png|jpe?g)$/i.test(importRequest.originalFilename) || importRequest.sizeBytes > ANALYSIS_LOCAL_INTAKE_LIMITS.fileBytes
      || !/^proj_[a-f0-9]{16,40}$/.test(importRequest.projectId)) {
    invalid('Local evidence intake supports a new automatic CSV, TSV, PNG or JPEG import of at most 25 MiB with its original UUID.');
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
      reference: { kind: 'artifact-version', versionId: 'av_' + '0'.repeat(24), sha256: importRequest.sha256 },
      caption: input.attachment.caption, suppliedOrigin: input.attachment.suppliedOrigin });
  } catch { invalid('Keep a caption and the bounded plain supplied origin notes for this exact intake.'); }
  return { requestId, serviceId: input.serviceId, importRequest, attachment: { requestId: context.requestId, action,
    attachmentId: input.attachment.attachmentId, expectedHeadRevisionId: input.attachment.expectedHeadRevisionId,
    caption: context.caption, suppliedOrigin: context.suppliedOrigin } };
}
export function canonicalAnalysisLocalIntake(analysisId, input) {
  if (typeof analysisId !== 'string' || !/^ra_[a-f0-9]{24}$/.test(analysisId)) invalid('Keep the original analysis identity for this intake.');
  const recipe = normalizeAnalysisLocalIntake(input);
  const canonical = JSON.stringify({ schema: ANALYSIS_LOCAL_INTAKE_SCHEMA, serviceId: recipe.serviceId,
    projectId: recipe.importRequest.projectId, analysisId, ownerUserId: recipe.importRequest.ownerUserId,
    requestId: recipe.requestId, importRequest: recipe.importRequest, attachment: recipe.attachment });
  if (new TextEncoder().encode(canonical).byteLength > ANALYSIS_LOCAL_INTAKE_LIMITS.canonicalBytes) invalid('The intake metadata exceeds its 64 KiB admission bound.');
  return canonical;
}
export function analysisLocalIntakeAttachmentRequest(input, acceptance) {
  const recipe = normalizeAnalysisLocalIntake(input);
  if (!acceptance || typeof acceptance.versionId !== 'string' || !/^av_[a-f0-9]{24}$/.test(acceptance.versionId)
      || acceptance.sha256 !== recipe.importRequest.sha256 || acceptance.sizeBytes !== recipe.importRequest.sizeBytes
      || acceptance.previousVersionId !== null) invalid('Recover the exact accepted import before preparing its attachment.');
  const { requestId, caption, suppliedOrigin, action, expectedHeadRevisionId } = recipe.attachment;
  return { requestId, ...(action === 'correct' ? { expectedHeadRevisionId } : {}),
    reference: { kind: 'artifact-version', versionId: acceptance.versionId, sha256: acceptance.sha256 }, caption, suppliedOrigin };
}
