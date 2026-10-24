import React, { useState } from 'react';
import { ANALYSIS_SNAPSHOT_PREPARATION_LIMITS as limits } from '../../shared/analysisSnapshotPreparation.mjs';
import { capturedOptionsKey, emptyCapturedContextSelection } from './snapshotCapturedChoices';

const same = (first, second) => JSON.stringify(first) === JSON.stringify(second);
const explanation = reason => ({ opaque: 'Object contents are not included.', 'unsupported-view': 'This output has no supported fixed view.',
  'restricted-or-unavailable': 'Access to the original output could not be confirmed.' }[reason]);
const selectedFrom = (item, reference, option) => item.kind === 'captured-workflow-output' && same(item.snapshotReference, reference)
  && item.stepId === option.stepId && item.port === option.port && same(item.reference, option.reference);

export default function CapturedWorkflowChoices({ snapshotReference, state, disabled }) {
  const { analysisVersion, options, optionLoading, loadOptions, results, linkedResults, setLinkedResults, prerequisites,
    linkedPrerequisites, setLinkedPrerequisites, keepCapturedOffer } = state;
  const key = capturedOptionsKey(analysisVersion, snapshotReference), [opened, setOpened] = useState(null);
  const collection = options[key], loading = !!optionLoading[key], visible = opened === key;
  const resultCount = results.length + linkedResults.length, prerequisiteCount = prerequisites.length + linkedPrerequisites.length;
  const open = () => { setOpened(key); if (!collection && !loading) void loadOptions('captured-workflow-outputs', null, snapshotReference); };
  const initialView = option => {
    const table = linkedResults.filter(item => selectedFrom(item, snapshotReference, option) && item.view.family === 'table').at(-1);
    return option.viewFamily === 'table' ? { family: 'table', offset: Math.min(limits.tableOffset, table ? table.view.offset + table.view.limit : 0), limit: 25 }
      : { family: option.viewFamily };
  };
  const duplicate = option => linkedResults.some(item => selectedFrom(item, snapshotReference, option)
    && same(item.view, initialView(option)) && same(item.contextSelection, emptyCapturedContextSelection()));
  const add = option => {
    if (disabled || resultCount >= limits.results || duplicate(option)) return;
    const item = { kind: 'captured-workflow-output', offerId: crypto.randomUUID(), snapshotReference, stepId: option.stepId, port: option.port, reference: option.reference,
      descriptorSha256: option.descriptorSha256, caption: option.outputLabel, view: initialView(option),
      contextSelection: emptyCapturedContextSelection(), contextSha256: null };
    keepCapturedOffer(item, option.contextOffer); setLinkedResults(previous => [...previous, item]);
  };
  return <div className="mt-3 space-y-3 border-t border-border pt-3">
    <button type="button" className="text-xs text-primary underline" disabled={disabled || loading} aria-expanded={visible}
      onClick={() => visible ? setOpened(null) : open()}>{visible ? 'Hide captured outputs' : 'Inspect captured outputs'}</button>
    {visible && <section aria-label={`Captured outputs from ${snapshotReference.snapshotId}`} className="space-y-3">
      <p className="text-xs text-textMuted">Choose existing outputs from this exact capture in saved analysis {analysisVersion}. Its working workflow is not opened.</p>
      {loading && <p role="status" className="text-sm text-textMuted">Finding captured outputs…</p>}
      {collection && !collection.items.length && <p className="text-sm text-textMuted">This capture has no recorded output references to include.</p>}
      <ul aria-label="Recorded workflow outputs" className="space-y-3">{collection?.items.map(option => {
        const included = linkedPrerequisites.some(item => item.kind === 'captured-workflow-reference' && same(item.snapshotReference, snapshotReference)
          && item.stepId === option.stepId && item.port === option.port && same(item.reference, option.reference));
        return <li key={JSON.stringify([option.stepId, option.port, option.reference])} className="min-w-0 space-y-2 border-l-2 border-border pl-3">
          <p className="break-words text-sm font-medium">{option.outputLabel}</p><p className="break-words text-xs text-textMuted">{option.stepLabel} · {option.port}</p>
          {option.descriptor?.semantics.title && <p className="break-words text-xs text-textMuted">{option.descriptor.semantics.title}</p>}
          {option.referenceOnlyReason && <p className="text-xs text-textMuted">Reference only. {explanation(option.referenceOnlyReason)}</p>}
          <details className="text-xs text-textMuted"><summary className="cursor-pointer">Exact captured output</summary><dl className="mt-2 space-y-1 break-all">
            <div><dt>Step</dt><dd>{option.stepId}</dd></div><div><dt>Output port</dt><dd>{option.port}</dd></div>
            <div><dt>Output version</dt><dd>{option.reference.versionId}</dd></div><div><dt>Recorded source SHA-256</dt><dd>{option.reference.sha256}</dd></div>
            {option.descriptorSha256 && <div><dt>Recorded descriptor SHA-256</dt><dd>{option.descriptorSha256}</dd></div>}
          </dl></details>
          <div className="flex flex-wrap gap-3 text-xs">{option.viewFamily && <button type="button" className="btn btn-secondary text-xs"
            disabled={disabled || resultCount >= limits.results || duplicate(option)} onClick={() => add(option)}>
            {option.viewFamily === 'table' ? 'Add captured table excerpt' : option.viewFamily === 'metrics' ? 'Add captured metrics' : 'Add captured figure'}</button>}
            <button type="button" className="text-primary underline" disabled={disabled || included || prerequisiteCount >= limits.prerequisites}
              onClick={() => setLinkedPrerequisites(previous => [...previous, { kind: 'captured-workflow-reference', snapshotReference, stepId: option.stepId,
                port: option.port, reference: option.reference, label: option.outputLabel.slice(0, 160).toWellFormed(), detail: null }])}>
              {included ? 'Captured reference included' : 'Include captured reference only'}</button></div>
        </li>;
      })}</ul>
      <div className="flex flex-wrap gap-3 text-xs"><button type="button" className="text-primary underline" disabled={disabled || loading}
        onClick={() => void loadOptions('captured-workflow-outputs', null, snapshotReference)}>Refresh captured outputs</button>
        {collection?.cursor && <button type="button" className="text-primary underline" disabled={disabled || loading}
          onClick={() => void loadOptions('captured-workflow-outputs', collection.cursor, snapshotReference)}>Load more captured outputs</button>}</div>
    </section>}
  </div>;
}

export function CapturedWorkflowContextChoices({ item, index, offer, disabled, readable, onChange }) {
  if (!offer || !readable) return <p className="text-xs text-textMuted">Inspect this captured output with current preparation access to review its recorded settings. Your selected setting names are kept.</p>;
  const selection = item.contextSelection;
  const change = update => onChange({ ...selection, ...update });
  const value = input => typeof input === 'string' ? `“${input}”` : String(input);
  return <fieldset disabled={disabled} className="space-y-3 border-t border-border pt-3" aria-label={`Recorded context for linked finding ${index + 1}`}>
    <legend className="px-1 text-sm font-medium">Recorded context (optional)</legend>
    <p className="text-xs text-textMuted">Review what to include from this exact workflow capture. These settings do not establish the code or runtime that originally produced these bytes.</p>
    {offer.method && <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={selection.method} onChange={event => change({ method: event.target.checked })} />
      <span className="min-w-0 break-words">Include recorded method · {offer.method.name} {offer.method.version}</span></label>}
    {offer.parameters.length > 0 && <div className="space-y-2"><p className="text-xs text-textMuted">Applied settings · select up to 12. Text and file paths are excluded.</p>
      {offer.parameters.map(parameter => <label key={parameter.key} className="flex items-start gap-2 text-sm"><input type="checkbox"
        aria-label={`Include ${parameter.key} for linked finding ${index + 1}`} checked={selection.parameterKeys.includes(parameter.key)}
        disabled={!selection.parameterKeys.includes(parameter.key) && selection.parameterKeys.length >= 12}
        onChange={event => change({ parameterKeys: event.target.checked ? [...selection.parameterKeys, parameter.key] : selection.parameterKeys.filter(key => key !== parameter.key) })} />
        <span className="min-w-0 break-words">{parameter.label} <span className="text-textMuted">({parameter.key})</span> · <span className="whitespace-pre-wrap">{value(parameter.value)}</span></span>
      </label>)}</div>}
    {offer.seed !== null && <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={selection.seed} onChange={event => change({ seed: event.target.checked })} />
      <span>Include recorded seed · {offer.seed}</span></label>}
    {offer.environment && <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={selection.environment} onChange={event => change({ environment: event.target.checked })} />
      <span className="min-w-0 break-words">Include recorded environment reference · R {offer.environment.rVersion}<span className="mt-1 block text-xs text-textMuted">The exact manifest will be checked when preparing. Current runtime availability is not checked.</span></span></label>}
    {!offer.method && !offer.parameters.length && offer.seed === null && !offer.environment && <p className="text-xs text-textMuted">No supported recorded settings are available. The fixed finding can still be included.</p>}
  </fieldset>;
}
