import React from 'react';
import { ANALYSIS_SNAPSHOT_PREPARATION_LIMITS as limits } from '../../shared/analysisSnapshotPreparation.mjs';

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
  const collectionKey = `analysis-references:${analysisVersion}`, collection = options[collectionKey], loading = optionLoading[collectionKey];
  const count = results.length + linkedResults.length, prerequisiteCount = prerequisites.length + linkedPrerequisites.length;
  const same = (first, second) => identity(first) === identity(second);
  const edit = (index, update) => setLinkedResults(previous => previous.map((item, position) => position === index ? { ...item, ...update } : item));
  const editPrerequisite = (index, update) => setLinkedPrerequisites(previous => previous.map((item, position) => position === index ? { ...item, ...update } : item));
  const addFinding = option => {
    const prior = linkedResults.filter(item => same(item.reference, option.reference));
    const view = option.viewFamily === 'table'
      ? { family: 'table', offset: Math.min(limits.tableOffset, prior.length ? prior.at(-1).view.offset + prior.at(-1).view.limit : 0), limit: 25 }
      : { family: 'image' };
    if (count >= limits.results || prior.some(item => identity(item.view) === identity(view))) return;
    setLinkedResults(previous => [...previous, { kind: 'analysis-reference', reference: option.reference, caption: option.label, view }]);
  };
  return <section aria-label={`Linked in saved analysis ${analysisVersion}`} className="space-y-4 border-t border-border pt-5">
    <div><h4 className="font-medium">Linked in saved analysis {analysisVersion}</h4>
      <p className="mt-1 text-sm text-textMuted">Choose findings already linked to this exact saved version. Linked selections are kept separately for each saved analysis version.</p>
      <p className="mt-2 text-xs text-textMuted">Eligibility is based on recorded metadata. Contents are checked when preparing a finding. Reference-only items include no contents or data access.</p></div>
    <ul aria-label="Linked saved references" className="space-y-3">{collection?.items.map(option => {
      const included = linkedPrerequisites.some(item => same(item.reference, option.reference));
      return <li key={identity(option.reference)} className="min-w-0 rounded border border-border bg-surface p-3">
        <p className="break-words text-sm font-medium">{option.label}</p>
        {option.referenceOnlyReason && <p className="mt-1 text-xs text-textMuted">{explanation(option.referenceOnlyReason)}</p>}
        <ExactReference reference={option.reference} />
        <div className="mt-3 flex flex-wrap gap-3">{option.viewFamily && <button type="button" className="btn btn-secondary text-xs"
          disabled={disabled || count >= limits.results || option.viewFamily === 'image' && linkedResults.some(item => same(item.reference, option.reference))}
          onClick={() => addFinding(option)}>{option.viewFamily === 'table' ? 'Add linked table excerpt' : 'Add linked figure'}</button>}
          <button type="button" className="text-xs text-primary underline" disabled={disabled || included || prerequisiteCount >= limits.prerequisites}
            onClick={() => setLinkedPrerequisites(previous => [...previous, { kind: 'analysis-reference', reference: option.reference, label: initialLabel(option.label), detail: null }])}>
            {included ? 'Reference included' : 'Include reference only'}</button></div>
      </li>;
    })}</ul>
    {loading && <p role="status" className="text-sm text-textMuted">Loading references for saved analysis {analysisVersion}…</p>}
    {collection && !collection.items.length && <p className="text-sm text-textMuted">No references are linked to this saved analysis version. Attached findings can still be selected above.</p>}
    <div className="flex flex-wrap gap-3 text-xs"><button type="button" className="text-primary underline" disabled={!!loading} onClick={() => void loadOptions('analysis-references')}>Refresh linked references</button>
      {collection?.cursor && <button type="button" className="text-primary underline" disabled={!!loading} onClick={() => void loadOptions('analysis-references', collection.cursor)}>Load more linked references</button>}</div>
    <ol aria-label="Selected linked findings" className="space-y-3">{linkedResults.map((item, index) => <li key={index} className="space-y-3 rounded border border-border p-3">
      <p className="text-sm font-medium">Linked finding {index + 1} · {item.view.family === 'table' ? 'Table excerpt' : 'Figure'} · Saved analysis {analysisVersion}</p>
      <label className="block text-sm">Caption for linked finding {index + 1}<textarea value={item.caption} required maxLength={2000} disabled={disabled} rows={2}
        onChange={event => edit(index, { caption: event.target.value })} className="input mt-2 block w-full" /></label>
      <p className="text-xs text-textMuted">This caption is supplied for this snapshot.</p>
      {item.view.family === 'table' && <div className="flex flex-wrap gap-3">
        <label className="text-xs">First data row<input aria-label={`First data row for linked finding ${index + 1}`} type="number" min={1} max={limits.tableOffset + 1} value={item.view.offset + 1} disabled={disabled}
          onChange={event => edit(index, { view: { ...item.view, offset: Number(event.target.value) - 1 } })} className="input mt-1 block w-28" /></label>
        <label className="text-xs">Rows to include<input aria-label={`Rows to include for linked finding ${index + 1}`} type="number" min={1} max={limits.tableRows} value={item.view.limit} disabled={disabled}
          onChange={event => edit(index, { view: { ...item.view, limit: Number(event.target.value) } })} className="input mt-1 block w-28" /></label>
      </div>}
      <ExactReference reference={item.reference} /><button type="button" className="text-xs text-textMuted underline" disabled={disabled} onClick={() => setLinkedResults(previous => previous.filter((_, position) => position !== index))}>Remove linked finding {index + 1}</button>
    </li>)}</ol>
    {linkedPrerequisites.length > 0 && <section aria-label="Selected reference-only prerequisites" className="space-y-3">
      <h4 className="text-sm font-medium">Reference-only prerequisites</h4><p className="text-xs text-textMuted">Contents not included. Integrity not checked. Data access not granted. These references do not count as retained findings.</p>
      {linkedPrerequisites.map((item, index) => <fieldset key={identity(item.reference)} className="space-y-3 rounded border border-border p-3">
        <legend className="px-1 text-sm">Linked prerequisite {index + 1}</legend>
        <label className="block text-sm">Label for linked prerequisite {index + 1}<input value={item.label} required maxLength={160} disabled={disabled} onChange={event => editPrerequisite(index, { label: event.target.value })} className="input mt-1 block w-full" /></label>
        <label className="block text-sm">Note for linked prerequisite {index + 1}<textarea value={item.detail || ''} maxLength={1000} disabled={disabled} rows={2} onChange={event => editPrerequisite(index, { detail: event.target.value })} className="input mt-1 block w-full" /></label>
        <ExactReference reference={item.reference} /><button type="button" className="text-xs text-textMuted underline" disabled={disabled} onClick={() => setLinkedPrerequisites(previous => previous.filter((_, position) => position !== index))}>Remove linked prerequisite {index + 1}</button>
      </fieldset>)}
    </section>}
  </section>;
}
