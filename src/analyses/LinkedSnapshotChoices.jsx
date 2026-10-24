import React from 'react';
import { ANALYSIS_SNAPSHOT_PREPARATION_LIMITS as limits } from '../../shared/analysisSnapshotPreparation.mjs';
import CapturedWorkflowChoices, { CapturedWorkflowContextChoices } from './CapturedWorkflowChoices';
import InertSnapshotChoices from './InertSnapshotChoices';
import { ANALYSIS_SNAPSHOT_INERT_LIMITS as inertLimits } from '../../shared/analysisSnapshotInertResult.mjs';

const identity = reference => JSON.stringify(reference);
const explanation = reason => ({
  opaque: 'Reference only. Object or opaque contents are not included.',
  'unsupported-view': 'Reference only. This format is not included as a finding.',
  'restricted-or-unavailable': 'Reference only. Access to these contents could not be confirmed.',
}[reason]);
const initialLabel = value => value.slice(0, 160).toWellFormed();

function ExactReference({ reference }) {
  return <details className="mt-2 text-xs text-textMuted"><summary className="cursor-pointer">Exact saved reference</summary>
    <dl className="mt-2 space-y-1 break-all">{Object.entries(reference).map(([field, value]) => <div key={field}>
      <dt>{({ kind: 'Reference kind', versionId: 'Saved version', analysisObjectId: 'Analysis object', checkpointVersionId: 'Saved checkpoint', snapshotId: 'Saved workflow', sha256: 'Recorded SHA-256' })[field]}</dt><dd>{value}</dd>
    </div>)}</dl></details>;
}

export default function LinkedSnapshotChoices({ state, disabled }) {
  const { analysisVersion, results, linkedResults, setLinkedResults, linkedPrerequisites, setLinkedPrerequisites,
    prerequisites, options, optionLoading, loadOptions } = state;
  const collectionKey = `analysis-references:${analysisVersion}`, typedKey = `analysis-typed-references:${analysisVersion}`;
  const collection = options[collectionKey], typedCollection = options[typedKey], loading = optionLoading[collectionKey] || optionLoading[typedKey];
  const same = (first, second) => identity(first) === identity(second);
  const typedByReference = new Map((typedCollection?.items || []).map(item => [identity(item.reference), item]));
  const choices = [...(collection?.items || []).map(item => typedByReference.has(identity(item.reference))
    ? { ...typedByReference.get(identity(item.reference)), typed: true } : item),
  ...(typedCollection?.items || []).filter(item => !collection?.items.some(value => same(value.reference, item.reference))).map(item => ({ ...item, typed: true }))];
  const count = results.length + linkedResults.length, prerequisiteCount = prerequisites.length + linkedPrerequisites.length;
  const edit = (index, update) => setLinkedResults(previous => previous.map((item, position) => position === index ? { ...item, ...update } : item));
  const editPrerequisite = (index, update) => setLinkedPrerequisites(previous => previous.map((item, position) => position === index ? { ...item, ...update } : item));
  const addFinding = option => {
    const prior = linkedResults.filter(item => item.kind !== 'captured-workflow-output' && same(item.reference, option.reference));
    const previousTable = prior.filter(item => item.view.family === 'table').at(-1);
    const view = option.viewFamily === 'table'
      ? { family: 'table', offset: Math.min(limits.tableOffset, previousTable ? previousTable.view.offset + previousTable.view.limit : 0), limit: 25 }
      : option.viewFamily === 'embedding' ? { family: 'embedding', pointLimit: 2000 }
      : { family: option.viewFamily };
    if (count >= limits.results || prior.some(item => identity(item.view) === identity(view))) return;
    setLinkedResults(previous => [...previous, { kind: option.typed ? 'typed-analysis-reference' : 'analysis-reference', reference: option.reference,
      ...(option.typed ? { descriptorSha256: option.descriptorSha256 } : {}), caption: option.label, view }]);
  };
  return <section aria-label={`Linked in saved analysis ${analysisVersion}`} className="space-y-4 border-t border-border pt-5">
    <div><h4 className="font-medium">Linked in saved analysis {analysisVersion}</h4>
      <p className="mt-1 text-sm text-textMuted">Choose findings already linked to this exact saved version. Linked selections are kept separately for each saved analysis version.</p>
      <p className="mt-2 text-xs text-textMuted">Eligibility is based on recorded metadata. Contents are checked when preparing a finding. Reference-only items include no contents or data access.</p></div>
    <ul aria-label="Linked saved references" className="space-y-3">{choices.map(option => {
      const included = linkedPrerequisites.some(item => item.kind === 'analysis-reference' && same(item.reference, option.reference));
      return <li key={identity(option.reference)} className="min-w-0 rounded border border-border bg-surface p-3">
        <p className="break-words text-sm font-medium">{option.label}</p>
        {option.typed && <div className="mt-2 space-y-1 text-xs text-textMuted"><p>Recorded typed {option.viewFamily === 'image' ? 'figure' : option.viewFamily === 'metrics' ? 'metrics' : option.viewFamily === 'embedding' ? 'embedding' : 'table'} · declared meaning retained</p>
          {option.descriptor.semantics.title && <p className="break-words">{option.descriptor.semantics.title}</p>}
          <details><summary className="cursor-pointer">Recorded descriptor identity</summary><p className="mt-1 break-all">SHA-256 {option.descriptorSha256}</p><p>Recorded profile: {option.descriptor.profileId || 'Not recorded'}. Runtime availability has not been checked.</p></details></div>}
        {option.referenceOnlyReason && <p className="mt-1 text-xs text-textMuted">{explanation(option.referenceOnlyReason)}</p>}
        <ExactReference reference={option.reference} />
        <div className="mt-3 flex flex-wrap gap-3">{option.viewFamily && <button type="button" className="btn btn-secondary text-xs"
          disabled={disabled || count >= limits.results || option.viewFamily !== 'table' && linkedResults.some(item => item.kind !== 'captured-workflow-output'
            && same(item.reference, option.reference) && (option.viewFamily !== 'embedding' || item.view.family === 'embedding' && item.view.pointLimit === 2000))}
          onClick={() => addFinding(option)}>{option.viewFamily === 'table' ? 'Add linked table excerpt' : option.viewFamily === 'metrics' ? 'Add linked metrics' : option.viewFamily === 'embedding' ? 'Add linked embedding' : 'Add linked figure'}</button>}
          <button type="button" className="text-xs text-primary underline" disabled={disabled || included || prerequisiteCount >= limits.prerequisites}
            onClick={() => setLinkedPrerequisites(previous => [...previous, { kind: 'analysis-reference', reference: option.reference, label: initialLabel(option.label), detail: null }])}>
            {included ? 'Reference included' : 'Include reference only'}</button></div>
        {option.reference.kind === 'workflow-snapshot' && <CapturedWorkflowChoices snapshotReference={option.reference} state={state} disabled={disabled} />}
      </li>;
    })}</ul>
    {loading && <p role="status" className="text-sm text-textMuted">Loading references for saved analysis {analysisVersion}…</p>}
    {collection && typedCollection && !choices.length && <p className="text-sm text-textMuted">No references are linked to this saved analysis version. Attached findings can still be selected above.</p>}
    <div className="flex flex-wrap gap-3 text-xs"><button type="button" className="text-primary underline" disabled={!!loading} onClick={() => {
      void loadOptions('analysis-references'); void loadOptions('analysis-typed-references');
    }}>Refresh linked references</button>
      {collection?.cursor && <button type="button" className="text-primary underline" disabled={!!loading} onClick={() => void loadOptions('analysis-references', collection.cursor)}>Load more linked references</button>}
      {typedCollection?.cursor && <button type="button" className="text-primary underline" disabled={!!loading} onClick={() => void loadOptions('analysis-typed-references', typedCollection.cursor)}>Load more typed references</button>}</div>
    <InertSnapshotChoices key={analysisVersion} state={state} disabled={disabled} />
    <ol aria-label="Selected linked findings" className="space-y-3">{linkedResults.map((item, index) => <li key={index} className="space-y-3 rounded border border-border p-3">
      <p className="text-sm font-medium">Linked finding {index + 1} · {item.view.family === 'table' ? 'Table excerpt' : item.view.family === 'metrics' ? 'Metrics' : item.view.family === 'embedding' ? 'Embedding sample' : item.view.family === 'text' ? 'Source text prefix' : 'Figure'} · Saved analysis {analysisVersion}</p>
      <label className="block text-sm">Caption for linked finding {index + 1}<textarea value={item.caption} required maxLength={2000} disabled={disabled} rows={2}
        onChange={event => edit(index, { caption: event.target.value })} className="input mt-2 block w-full" /></label>
      <p className="text-xs text-textMuted">This caption is supplied for this snapshot.</p>
      {['typed-analysis-reference', 'captured-workflow-output'].includes(item.kind) && <details className="text-xs text-textMuted"><summary className="cursor-pointer">Selected descriptor identity</summary><p className="mt-1 break-all">SHA-256 {item.descriptorSha256}</p><p className="mt-1">This selection keeps its recorded meaning. If the source descriptor changes, start a new selection after reviewing it.</p></details>}
      {item.kind === 'captured-workflow-output' && <><p className="break-words text-xs text-textMuted">Captured output · {item.stepId} · {item.port}</p>
        <CapturedWorkflowContextChoices item={item} index={index} offer={state.capturedOffers[item.offerId]} disabled={disabled} readable={state.writer}
          onChange={contextSelection => edit(index, { contextSelection, contextSha256: null })} />
        <ExactReference reference={item.snapshotReference} /></>}
      {item.view.family === 'table' && <div className="flex flex-wrap gap-3">
        <label className="text-xs">First data row<input aria-label={`First data row for linked finding ${index + 1}`} type="number" min={1} max={limits.tableOffset + 1} value={item.view.offset + 1} disabled={disabled}
          onChange={event => edit(index, { view: { ...item.view, offset: Number(event.target.value) - 1 } })} className="input mt-1 block w-28" /></label>
        <label className="text-xs">Rows to include<input aria-label={`Rows to include for linked finding ${index + 1}`} type="number" min={1} max={limits.tableRows} value={item.view.limit} disabled={disabled}
          onChange={event => edit(index, { view: { ...item.view, limit: Number(event.target.value) } })} className="input mt-1 block w-28" /></label>
      </div>}
      {item.view.family === 'embedding' && <div className="space-y-2"><label className="block text-sm">Maximum included points
        <input aria-label={`Maximum included points for linked finding ${index + 1}`} type="number" min={1} max={5000} step={1}
          value={item.view.pointLimit} disabled={disabled} className="input mt-1 block w-36"
          onChange={event => edit(index, { view: { family: 'embedding', pointLimit: Number(event.target.value) } })} /></label>
        <p className="text-xs text-textMuted">Review the included point identifiers, groups and coordinates in the private preview. A fixed sample may omit groups and can include fewer points to fit its byte limit.</p>
      </div>}
      {item.kind === 'inert-analysis-reference' && <div className="space-y-3"><label className="block text-sm">Maximum source bytes to include
        <input aria-label={`Maximum source bytes for linked finding ${index + 1}`} type="number" min={1} max={inertLimits.prefixBytes} step={1}
          value={item.view.maxBytes} disabled={disabled} className="input mt-1 block w-36"
          onChange={event => edit(index, { view: { family: 'text', maxBytes: Number(event.target.value) } })} /></label>
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" required checked={item.includeSourceText === true} disabled={disabled} className="mt-1"
          aria-label={`Include source text for linked finding ${index + 1}`} onChange={event => edit(index, { includeSourceText: event.target.checked })} />
          <span>Include source text in this private preview.</span></label>
        <p className="text-xs text-textMuted">Only this prefix will be retained, using complete UTF-8 characters. Review the included text before publishing. Code and JSON stay plain text; syntax is not checked.</p>
      </div>}
      <ExactReference reference={item.reference} /><button type="button" className="text-xs text-textMuted underline" disabled={disabled} onClick={() => setLinkedResults(previous => previous.filter((_, position) => position !== index))}>Remove linked finding {index + 1}</button>
    </li>)}</ol>
    {linkedPrerequisites.length > 0 && <section aria-label="Selected reference-only prerequisites" className="space-y-3">
      <h4 className="text-sm font-medium">Reference-only prerequisites</h4><p className="text-xs text-textMuted">Contents not included. Integrity not checked. Data access not granted. These references do not count as retained findings.</p>
      {linkedPrerequisites.map((item, index) => <fieldset key={JSON.stringify([item.kind, item.snapshotReference, item.stepId, item.port, item.reference])} className="space-y-3 rounded border border-border p-3">
        <legend className="px-1 text-sm">Linked prerequisite {index + 1}</legend>
        <label className="block text-sm">Label for linked prerequisite {index + 1}<input value={item.label} required maxLength={160} disabled={disabled} onChange={event => editPrerequisite(index, { label: event.target.value })} className="input mt-1 block w-full" /></label>
        <label className="block text-sm">Note for linked prerequisite {index + 1}<textarea value={item.detail || ''} maxLength={1000} disabled={disabled} rows={2} onChange={event => editPrerequisite(index, { detail: event.target.value })} className="input mt-1 block w-full" /></label>
        {item.kind === 'captured-workflow-reference' && <><p className="break-words text-xs text-textMuted">Captured reference · {item.stepId} · {item.port}</p><ExactReference reference={item.snapshotReference} /></>}
        <ExactReference reference={item.reference} /><button type="button" className="text-xs text-textMuted underline" disabled={disabled} onClick={() => setLinkedPrerequisites(previous => previous.filter((_, position) => position !== index))}>Remove linked prerequisite {index + 1}</button>
      </fieldset>)}
    </section>}
  </section>;
}
