import { createHash } from 'node:crypto';
import { canonicalAnalysisLocalIntake, normalizeAnalysisLocalIntake, analysisLocalIntakeAttachmentRequest } from '../../shared/analysisLocalIntake.mjs';
import { canonicalAnalysisServerIntake, normalizeAnalysisServerIntake, analysisServerIntakeAttachmentRequest } from '../../shared/analysisServerIntake.mjs';
import { canonicalAnalysisAttachmentContent, canonicalAnalysisAttachmentCorrection } from '../../shared/analysisAttachment.mjs';
import { canonicalArtifactImportRequest } from '../../shared/artifactImport.mjs';
import { canonicalServerDataImportRequest } from '../../shared/serverDataImport.mjs';

// Test-only wire fixtures. Keep real normalization, hashes and acceptance
// descriptors so component tests also exercise the production validators.
export const scope = { serviceId: 'svc_' + '1'.repeat(32), projectId: 'proj_' + '2'.repeat(24), analysisId: 'ra_' + '3'.repeat(24), userId: 7 };
export const requestId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const attachmentRequestId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const artifactId = 'af_' + '4'.repeat(24), versionId = 'av_' + '5'.repeat(24), attachmentId = 'raa_' + '6'.repeat(24);
export const firstRevisionId = 'rar_' + '7'.repeat(24), acceptedRevisionId = 'rar_' + '8'.repeat(24), laterRevisionId = 'rar_' + '9'.repeat(24);
export const operationId = 'sdi_' + 'a'.repeat(24), bytes = 'gene,score\nA,2';
export const sha = value => createHash('sha256').update(value).digest('hex');
export const fileSha = sha(bytes);
export const emptyOrigin = () => ({ origin: null, sourceReference: null, documentReference: null, environmentReference: null });
const unknown = () => ({ status: 'unconfirmed', receipt: null });
export const common = (allowed = true) => ({ serviceId: scope.serviceId, projectId: scope.projectId, analysisId: scope.analysisId,
  ownerUserId: scope.userId, canContinue: allowed, canAttach: allowed });

export function record(sourceKind = 'server', { action = 'create', id = requestId, attachId = attachmentRequestId, name = 'Outside scores',
  caption = 'Outside treatment scores', relativePath = 'scores.csv', suppliedOrigin = emptyOrigin() } = {}) {
  const attachment = { requestId: attachId, action, attachmentId: action === 'correct' ? attachmentId : null,
    expectedHeadRevisionId: action === 'correct' ? firstRevisionId : null, caption, suppliedOrigin };
  const recipe = sourceKind === 'server'
    ? normalizeAnalysisServerIntake({ requestId: id, serviceId: scope.serviceId, projectId: scope.projectId, ownerUserId: scope.userId,
      importRequest: { requestId: id, rootId: 'lab-data', relativePath, selectionToken: 'd'.repeat(64), name }, selectionSizeBytes: 14, attachment })
    : normalizeAnalysisLocalIntake({ requestId: id, serviceId: scope.serviceId,
      importRequest: { schema: 'traceomics.artifact-import.v1', projectId: scope.projectId, ownerUserId: scope.userId, requestId: id,
        originalFilename: relativePath.split('/').at(-1), name, artifactType: 'auto', previousVersionId: null, sha256: fileSha, sizeBytes: 14 }, attachment });
  return { sourceKind, recipe };
}
export const canonical = value => value.sourceKind === 'server'
  ? canonicalAnalysisServerIntake(scope.analysisId, value.recipe) : canonicalAnalysisLocalIntake(scope.analysisId, value.recipe);
export function acceptance() {
  return { artifactId, versionId, versionNumber: 1, previousVersionId: null, sha256: fileSha, sizeBytes: 14, createdAt: '2026-10-22T12:00:01.000Z' };
}
function version(value) {
  return { kind: 'artifact-version', schemaVersion: 1, artifactId, versionId, projectId: scope.projectId, ownerId: String(scope.userId),
    name: value.recipe.importRequest.name, type: 'table', format: { id: 'org.ietf.csv', version: '1' }, sha256: fileSha, sizeBytes: 14,
    storageRef: versionId, sourceRunId: null, createdAt: acceptance().createdAt, previews: ['table'], versionNumber: 1, previousVersionId: null,
    owner: { id: String(scope.userId), displayName: 'Researcher' }, source: { kind: 'managed-file', id: versionId },
    reference: { artifactId, versionId, projectId: scope.projectId, sha256: fileSha },
    previewBudget: { responseBytes: 262144, imageBytes: 5242880, maximumRows: 100 }, canReplace: true };
}
export function importReceipt(value, { unavailable = false, importStatus = 'accepted' } = {}) {
  const request = structuredClone(value.recipe.importRequest);
  if (value.sourceKind === 'local') return { requestId: request.requestId, status: 'succeeded', canImport: true,
    requestSha256: sha(canonicalArtifactImportRequest(request)), request, acceptance: acceptance(),
    availability: unavailable ? 'unavailable' : 'recorded', version: unavailable ? null : version(value) };
  const result = { projectId: scope.projectId, ownerUserId: scope.userId, serviceId: scope.serviceId, canImport: true,
    id: operationId, requestId: request.requestId, requestSha256: sha(canonicalServerDataImportRequest(request)), request,
    name: request.name, status: 'pending', replayed: true,
    source: { rootId: request.rootId, relativePath: request.relativePath, name: request.relativePath.split('/').at(-1), serviceId: scope.serviceId, serviceLabel: 'Research server' },
    reservedBytes: 14, bytesCopied: 7, createdAt: '2026-10-22T12:00:00.000Z', updatedAt: '2026-10-22T12:00:01.000Z', expiresAt: '2026-10-22T12:15:00.000Z',
    acceptanceState: 'not-accepted', acceptance: null, availability: 'not-recorded', version: null, error: null,
    message: 'The server is copying and verifying the original source.' };
  if (importStatus === 'failed') Object.assign(result, { status: 'failed', message: null,
    error: { code: 'SERVER_IMPORT_SOURCE_CHANGED', message: 'The source changed while copying.' } });
  if (['accepted', 'legacy-unrecorded'].includes(importStatus)) Object.assign(result, { status: 'succeeded', bytesCopied: 14, message: null,
    acceptanceState: importStatus === 'accepted' ? 'recorded' : 'legacy-unrecorded', acceptance: importStatus === 'accepted' ? acceptance() : null,
    availability: importStatus === 'accepted' && !unavailable ? 'recorded' : 'unavailable',
    version: importStatus === 'accepted' && !unavailable ? version(value) : null });
  if (importStatus === 'legacy-unrecorded') result.request = null;
  if (result.version) result.version.sourceImport = { importId: operationId, rootId: request.rootId, rootLabel: 'Granted study data',
    relativePath: request.relativePath, serviceId: scope.serviceId, serviceLabel: result.source.serviceLabel, sha256: fileSha, importedAt: result.updatedAt };
  return result;
}
export function attachmentReceipt(value, { allowed = true, unavailable = false, newer = false } = {}) {
  const input = value.sourceKind === 'server' ? analysisServerIntakeAttachmentRequest(value.recipe, acceptance())
    : analysisLocalIntakeAttachmentRequest(value.recipe, acceptance());
  const correction = value.recipe.attachment.action === 'correct';
  const revision = { id: acceptedRevisionId, attachmentId, revisionNumber: correction ? 2 : 1,
    previousRevisionId: correction ? firstRevisionId : null, reference: input.reference, caption: input.caption,
    suppliedOrigin: input.suppliedOrigin, createdByUserId: scope.userId, createdAt: '2026-10-22T12:00:02.000Z' };
  const currentRevision = newer ? { ...structuredClone(revision), id: laterRevisionId, revisionNumber: revision.revisionNumber + 1,
    previousRevisionId: revision.id, caption: 'Newer interpretation', createdByUserId: 8,
    reference: { kind: 'artifact-version', versionId: 'av_' + '9'.repeat(24), sha256: '9'.repeat(64) }, createdAt: '2026-10-22T12:00:03.000Z' } : structuredClone(revision);
  return { projectId: scope.projectId, analysisId: scope.analysisId, canWrite: allowed, requestId: input.requestId,
    requestSha256: sha(correction ? canonicalAnalysisAttachmentCorrection(attachmentId, input) : canonicalAnalysisAttachmentContent(input)),
    replayed: true, acceptedRevision: revision, acceptedSourceAccess: unavailable ? 'unavailable' : 'available',
    attachment: { id: attachmentId, headRevisionId: currentRevision.id, revision: currentRevision,
      sourceAccess: newer ? 'restricted' : unavailable ? 'unavailable' : 'available' } };
}
export function full(value = record(), options = {}) {
  const { allowed = true, sourceAllowed = true, imported = false, attached = false, importStatus = imported ? 'accepted' : 'unconfirmed' } = options;
  return { sourceKind: value.sourceKind, ...common(allowed), canStartImport: allowed && (value.sourceKind === 'local' || sourceAllowed),
    requestId: value.recipe.requestId, requestSha256: sha(canonical(value)), recipe: structuredClone(value.recipe), createdAt: '2026-10-22T12:00:00.000Z', replayed: true,
    importOutcome: ['unconfirmed', 'conflict'].includes(importStatus) ? { status: importStatus, receipt: null }
      : { status: importStatus, receipt: importReceipt(value, { ...options, importStatus }) },
    attachmentOutcome: attached ? { status: 'accepted', receipt: attachmentReceipt(value, options) } : unknown() };
}
export function summary(value = record(), options) {
  const result = full(value, options), attachment = value.recipe.attachment;
  return { sourceKind: value.sourceKind, canStartImport: result.canStartImport, requestId: result.requestId, requestSha256: result.requestSha256,
    createdAt: result.createdAt, originalFilename: value.sourceKind === 'server' ? value.recipe.importRequest.relativePath.split('/').at(-1) : value.recipe.importRequest.originalFilename,
    name: value.recipe.importRequest.name, caption: attachment.caption, action: attachment.action, attachmentId: attachment.attachmentId,
    expectedHeadRevisionId: attachment.expectedHeadRevisionId, importStatus: result.importOutcome.status, attachmentStatus: result.attachmentOutcome.status };
}
export const list = (items = [], allowed = true) => ({ ...common(allowed), items: [...items].sort((a, b) => b.requestId.localeCompare(a.requestId)), nextCursor: null });
export const legacyFull = value => { const { sourceKind: _kind, canStartImport, ...rest } = value; return { ...rest, canUpload: canStartImport }; };
