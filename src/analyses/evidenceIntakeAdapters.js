import { normalizeAnalysisLocalIntake, analysisLocalIntakeAttachmentRequest } from '../../shared/analysisLocalIntake.mjs';
import { normalizeAnalysisServerIntake, analysisServerIntakeAttachmentRequest } from '../../shared/analysisServerIntake.mjs';
import { normalizeServerDataImportRequest } from '../../shared/serverDataImport.mjs';
import { prepareArtifactImportRequest, canonicalArtifactImportRequest, artifactImportRequestSha256 } from '../artifacts/artifactImportReceipt';
import { importArtifactVersion } from '../artifacts/artifactApi';
import { importServerData } from '../artifacts/serverDataApi';
import * as api from './analysisAttachmentApi';
import { validateAnalysisLocalIntake, validateAnalysisLocalIntakeList } from './analysisLocalIntakeValidation';
import { validateEvidenceIntake, validateEvidenceIntakeList } from './evidenceIntakeValidation';

function localRecord(result) {
  const { canUpload, ...rest } = result;
  return { sourceKind: 'local', ...rest, canStartImport: canUpload };
}

export function evidenceIntakeTransport(legacyLocal = false) {
  return {
    async list(scope, { cursor, signal } = {}) {
      const { projectId, analysisId } = scope;
      if (!legacyLocal) return validateEvidenceIntakeList(await api.listAnalysisIntakes(projectId, analysisId, { cursor, signal }), scope);
      const { canUpload, items, ...rest } = validateAnalysisLocalIntakeList(await api.listAnalysisLocalIntakes(projectId, analysisId, { cursor, signal }), scope);
      return { ...rest, items: items.map(item => ({ ...item, sourceKind: 'local', canStartImport: canUpload })) };
    },
    async get(scope, requestId, signal, expected) {
      const { projectId, analysisId } = scope;
      if (!legacyLocal) return validateEvidenceIntake(await api.getAnalysisIntake(projectId, analysisId, requestId, { signal }), scope, expected);
      return localRecord(await validateAnalysisLocalIntake(await api.getAnalysisLocalIntake(projectId, analysisId, requestId, { signal }), scope, expected?.recipe));
    },
    async admit(scope, record, signal) {
      const { projectId, analysisId } = scope;
      if (record.sourceKind === 'server') return validateEvidenceIntake(await api.createAnalysisServerIntake(projectId, analysisId, record.recipe, { signal }), scope, record);
      return localRecord(await validateAnalysisLocalIntake(await api.createAnalysisLocalIntake(projectId, analysisId, record.recipe, { signal }), scope, record.recipe));
    },
  };
}

export async function prepareEvidenceIntake(sourceKind, { file, selection, name, caption, context, intent }, scope) {
  const requestId = crypto.randomUUID();
  const attachment = { requestId: crypto.randomUUID(), action: intent?.attachmentId ? 'correct' : 'create',
    attachmentId: intent?.attachmentId || null, expectedHeadRevisionId: intent?.expectedHeadRevisionId || null,
    caption, suppliedOrigin: context };
  if (sourceKind === 'local') {
    if (!file || !/\.(csv|tsv|png|jpe?g)$/i.test(file.name)) throw new Error('Choose a CSV, TSV, PNG or JPEG file up to 25 MiB.');
    const importRequest = await prepareArtifactImportRequest({ file, name, projectId: scope.projectId, ownerUserId: scope.userId, requestId });
    return { sourceKind, recipe: normalizeAnalysisLocalIntake({ requestId, serviceId: scope.serviceId, importRequest, attachment }) };
  }
  if (sourceKind !== 'server' || !selection || selection.serviceId !== scope.serviceId) throw new Error('Select a result file on this analysis server before preparing its import.');
  const importRequest = normalizeServerDataImportRequest({ requestId, rootId: selection.rootId, relativePath: selection.file.relativePath,
    selectionToken: selection.file.selectionToken, name: name.trim() || selection.file.name, artifactType: 'auto', previousVersionId: null });
  return { sourceKind, recipe: normalizeAnalysisServerIntake({ requestId, serviceId: scope.serviceId, projectId: scope.projectId,
    ownerUserId: Number(scope.userId), importRequest, selectionSizeBytes: selection.file.sizeBytes, attachment }) };
}

// Called only after the controller has refreshed the exact acknowledged intake.
// Copying remains in the original managed upload/server copy services.
export async function transferEvidenceSource(record, file, scope, signal, onPhase, onMutation) {
  const { sourceKind, recipe } = record;
  if (sourceKind === 'server') {
    onPhase('Copying the original server selection…');
    onMutation();
    await importServerData(scope.projectId, recipe.importRequest, signal, { userId: scope.userId, serviceId: scope.serviceId });
    return;
  }
  if (!file) throw new Error('Choose the original local file before continuing its import.');
  onPhase('Checking the selected file against the original request…');
  const prepared = await prepareArtifactImportRequest({ file, name: recipe.importRequest.name, artifactType: 'auto',
    projectId: scope.projectId, ownerUserId: scope.userId, requestId: recipe.requestId });
  if (signal.aborted) return;
  if (canonicalArtifactImportRequest(prepared) !== canonicalArtifactImportRequest(recipe.importRequest)) throw new Error('Choose the original file with the same filename, size and SHA-256 checksum. No upload was sent.');
  const expectedRequestSha256 = await artifactImportRequestSha256(recipe.importRequest);
  if (signal.aborted) return;
  onPhase('Uploading the exact original file…');
  onMutation();
  await importArtifactVersion(scope.projectId, { file, name: recipe.importRequest.name, artifactType: 'auto',
    requestId: recipe.requestId, expectedRequestSha256, signal });
}

export function evidenceAttachmentRequest(record, acceptance) {
  return record.sourceKind === 'server' ? analysisServerIntakeAttachmentRequest(record.recipe, acceptance)
    : analysisLocalIntakeAttachmentRequest(record.recipe, acceptance);
}
export const evidenceFilename = record => record.sourceKind === 'server'
  ? record.recipe.importRequest.relativePath.split('/').at(-1) : record.recipe.importRequest.originalFilename;
export const evidenceSize = record => record.sourceKind === 'server' ? record.recipe.selectionSizeBytes : record.recipe.importRequest.sizeBytes;
