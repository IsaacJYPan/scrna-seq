import React from 'react';
import { ANALYSIS_SNAPSHOT_PREPARATION_LIMITS as limits } from '../../shared/analysisSnapshotPreparation.mjs';
import { ANALYSIS_SNAPSHOT_INERT_LIMITS as inertLimits } from '../../shared/analysisSnapshotInertResult.mjs';

const same = (first, second) => JSON.stringify(first) === JSON.stringify(second);

export default function InertSnapshotChoices({ state, disabled }) {
  const { analysisVersion, options, optionLoading, loadOptions, results, linkedResults, setLinkedResults } = state;
  const kind = 'analysis-inert-references', key = `${kind}:${analysisVersion}`, collection = options[key], loading = optionLoading[key];
  const full = results.length + linkedResults.length >= limits.results;
  const selected = option => linkedResults.some(item => item.kind === 'inert-analysis-reference' && same(item.reference, option.reference)
    && item.view.maxBytes === inertLimits.prefixBytes);
  const add = option => {
    if (disabled || full || selected(option)) return;
    setLinkedResults(previous => [...previous, { kind: 'inert-analysis-reference', reference: option.reference,
      caption: option.label, view: { family: 'text', maxBytes: inertLimits.prefixBytes }, includeSourceText: false }]);
  };
  return <details className="space-y-3 rounded border border-border p-3" onToggle={event => {
    if (event.currentTarget.open && !disabled && !collection && !loading) void loadOptions(kind);
  }}>
    <summary className="cursor-pointer text-sm font-medium">Text and JSON source excerpts (optional)</summary>
    <p className="mt-3 text-xs text-textMuted">Select a prefix from an owned text or JSON file linked to saved analysis {analysisVersion}. You will choose whether to include its source text, then review the exact private preview before publishing.</p>
    <ul aria-label="Linked text and JSON sources" className="space-y-3">{collection?.items.map(option => <li key={JSON.stringify(option.reference)} className="min-w-0 space-y-2 border-t border-border pt-3">
      <p className="break-words text-sm font-medium">{option.label}</p>
      <p className="text-xs text-textMuted">{option.sourceFormatId === 'org.ietf.json' ? 'JSON source text' : 'Plain text'} · {option.sourceBytes.toLocaleString()} source bytes · contents not checked</p>
      <button type="button" className="btn btn-secondary text-xs" disabled={disabled || full || selected(option)} onClick={() => add(option)}>Select source prefix</button>
    </li>)}</ul>
    {loading && <p role="status" className="text-xs text-textMuted">Finding saved text and JSON sources…</p>}
    {collection && !collection.items.length && <p className="text-xs text-textMuted">No eligible owned text or JSON files are linked to this saved version. Import a file in Artifact versions and link its exact version to this analysis.</p>}
    <div className="flex flex-wrap gap-3 text-xs"><button type="button" className="text-primary underline" disabled={disabled || !!loading} onClick={() => void loadOptions(kind)}>Refresh text and JSON sources</button>
      {collection?.cursor && <button type="button" className="text-primary underline" disabled={disabled || !!loading} onClick={() => void loadOptions(kind, collection.cursor)}>Load more text and JSON sources</button>}</div>
  </details>;
}
