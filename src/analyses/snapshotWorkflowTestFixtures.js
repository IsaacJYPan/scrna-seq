// Test-only exact captured workflow identities. Production never imports these.
import { createHash } from 'node:crypto';
import { typedRecipe, typedRecord, typedOptions } from './snapshotTypedTestFixtures';
import { normalizeAnalysisSnapshotPreparation, canonicalAnalysisSnapshotPreparation, canonicalAnalysisSnapshotPackage,
  projectAnalysisSnapshotWorkflowContext, canonicalAnalysisSnapshotWorkflowContextBinding } from '../../shared/analysisSnapshotPreparationDispatch.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
export const workflowSnapshotReference = changes => ({ kind: 'workflow-snapshot', snapshotId: 'wfs_' + '7'.repeat(24), sha256: 'b'.repeat(64), ...changes });
export const workflowSelection = (changes = {}) => ({ method: false, parameterKeys: [], seed: false, environment: false, ...changes });
export function workflowOffer(changes = {}) {
  return { method: { id: 'condition-counts', name: 'Condition counts', version: '1.0.0', digest: 'c'.repeat(64), stepLabel: 'Summarize conditions', outputLabel: 'Recorded condition values' },
    parameters: [{ key: 'min-cells', type: 'integer', label: 'Minimum cells', value: 0 }, { key: 'include-empty', type: 'boolean', label: 'Include empty conditions', value: false },
      { key: 'mode', type: 'choice', label: 'Contrast mode', value: 'paired' }], seed: 0,
    environment: { id: 'renv_' + 'd'.repeat(64), manifestSha256: 'd'.repeat(64), profileId: 'expert.r.v1', rVersion: '4.5.3', bioconductor: '3.22',
      imageDigest: 'sha256:' + 'e'.repeat(64), imageId: 'sha256:' + 'f'.repeat(64), snapshotScope: 'container-userspace' }, ...changes };
}
export function workflowContext({ snapshotReference = workflowSnapshotReference(), stepId = 'counts', port = 'values', offer = workflowOffer(), selection = workflowSelection() } = {}) {
  return projectAnalysisSnapshotWorkflowContext({ snapshotReference, stepId, port, offer, selection });
}
export function workflowReferencePrerequisite(changes = {}) {
  return { kind: 'captured-workflow-reference', snapshotReference: workflowSnapshotReference(), stepId: 'counts', port: 'values', reference: typedRecipe().results[0].reference,
    label: 'Recorded output dependency', detail: null, ...changes };
}
export function workflowRecipe({ family = 'table', offer = workflowOffer(), selection = workflowSelection(), snapshotReference = workflowSnapshotReference(), stepId = 'counts', port = 'values', ...changes } = {}) {
  const base = typedRecipe({ family, ...changes }), context = workflowContext({ snapshotReference, stepId, port, offer, selection });
  const contextSha256 = hash(canonicalAnalysisSnapshotWorkflowContextBinding({ serviceId: base.serviceId, projectId: base.projectId, analysisId: base.analysisId,
    ownerUserId: base.ownerUserId, analysisVersion: base.analysisVersion, context }));
  return normalizeAnalysisSnapshotPreparation({ ...base, results: changes.results || [{ ...base.results[0], kind: 'captured-workflow-output', snapshotReference, stepId, port, contextSelection: selection, contextSha256 }] });
}
export function workflowRecord(input = workflowRecipe(), { offer = workflowOffer(), offers = [], contexts = [], referenceReasons = [], ...options } = {}) {
  const recipe = normalizeAnalysisSnapshotPreparation(input), surrogate = { ...recipe, prerequisites: recipe.prerequisites.map(item => item.kind === 'captured-workflow-reference'
    ? { kind: 'data', label: item.label, detail: item.detail } : item), results: recipe.results.map(item => item.kind === 'captured-workflow-output'
    ? { kind: 'typed-analysis-reference', reference: item.reference, descriptorSha256: item.descriptorSha256, caption: item.caption, view: item.view } : item) };
  const base = typedRecord(surrogate, options), prepared = typedRecord(surrogate);
  prepared.package.results.forEach((result, index) => {
    const chosen = recipe.results[index]; if (chosen.kind !== 'captured-workflow-output') return;
    const context = contexts[index] || workflowContext({ snapshotReference: chosen.snapshotReference, stepId: chosen.stepId, port: chosen.port, offer: offers[index] || offer, selection: chosen.contextSelection });
    result.origin = { kind: chosen.kind, snapshotReference: chosen.snapshotReference, analysisVersion: recipe.analysisVersion, stepId: chosen.stepId, port: chosen.port,
      reference: chosen.reference, caption: chosen.caption, captionOrigin: 'user-supplied', context, contextSha256: chosen.contextSha256,
      contextEvidence: { capture: 'fingerprint-checked', environment: context.environment === null ? 'not-included' : 'manifest-checked' } };
  });
  const pkg = prepared.package;
  pkg.prerequisites.items = recipe.prerequisites.map((item, index) => ['analysis-reference', 'captured-workflow-reference'].includes(item.kind)
    ? { ...item, role: 'reference-only', reason: referenceReasons[index] || 'not-included', integrity: 'not-checked', dataAccess: 'not-granted' } : item);
  const snapshotSha256 = hash(canonicalAnalysisSnapshotPackage(pkg));
  return { ...base, recipe: base.state === 'deleted' ? null : recipe, requestSha256: hash(canonicalAnalysisSnapshotPreparation(recipe)),
    package: base.state === 'ready' ? pkg : null, snapshotSha256: ['ready', 'deleted'].includes(base.state) ? snapshotSha256 : null };
}
export function workflowOptions({ family = 'table', offer = workflowOffer(), snapshotReference = workflowSnapshotReference(), items, reason = null, ...changes } = {}) {
  const base = typedOptions({ family, ...changes }), selected = base.items[0];
  return { ...base, kind: 'captured-workflow-outputs', snapshotReference, items: items || [{ stepId: 'counts', stepLabel: 'Summarize conditions', port: 'values', outputLabel: 'Recorded condition values',
    reference: selected.reference, viewFamily: reason === null ? selected.viewFamily : null, descriptor: reason === null ? selected.descriptor : null,
    descriptorSha256: reason === null ? selected.descriptorSha256 : null, referenceOnlyReason: reason, contextOffer: reason === null ? offer : null,
    integrity: 'not-checked', availability: 'not-checked' }] };
}
