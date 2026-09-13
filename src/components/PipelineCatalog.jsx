import React, { useMemo, useState } from 'react';
import { CheckCircle2, Download, Layers, Loader2, Search } from 'lucide-react';
import PipelineTemplatePreview from './PipelineTemplatePreview';
import { DEFAULT_PIPELINE_ID, resolvePipelineManifest } from '../pipelines/pipelineRegistry';
import { downloadPipeline } from '../pipelines/pipelineFiles';

function workflowName(definition) {
  return definition.id === DEFAULT_PIPELINE_ID ? 'Standard scRNA-seq workflow' : definition.name;
}

export default function PipelineCatalog({
  definitions,
  selectedId,
  selectingId,
  loading,
  onSelect,
  onOpen,
}) {
  const [query, setQuery] = useState('');
  const [previewId, setPreviewId] = useState(null);
  const filtered = useMemo(() => {
    const search = query.trim().toLowerCase();
    return definitions.filter((definition) =>
      [
        workflowName(definition),
        definition.manifest.description,
        ...definition.manifest.tabs.map((tab) => tab.label),
      ]
        .join(' ')
        .toLowerCase()
        .includes(search)
    );
  }, [definitions, query]);
  const preview =
    definitions.find((item) => item.id === previewId) ||
    definitions.find((item) => item.id === selectedId) ||
    definitions[0];
  const manifest = preview ? resolvePipelineManifest(preview.manifest) : null;
  const isActive = preview?.id === selectedId;

  return (
    <section
      aria-label="Pipeline catalog"
      className="overflow-hidden rounded-xl border border-border bg-surface/50"
    >
      <div className="grid lg:grid-cols-[minmax(240px,1fr)_minmax(0,2fr)]">
        <div className="border-b border-border lg:border-b-0 lg:border-r">
          <div className="border-b border-border p-4">
            <label htmlFor="pipeline-search" className="mb-2 block text-sm font-semibold text-text">
              Available pipelines
            </label>
            <div className="relative">
              <Search
                size={16}
                className="pointer-events-none absolute left-3 top-3 text-textMuted"
                aria-hidden="true"
              />
              <input
                id="pipeline-search"
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search by name or step"
                className="w-full rounded-lg border border-border bg-background py-2 pl-9 pr-3 text-sm text-text"
              />
            </div>
            <p className="mt-2 text-xs text-textMuted" role="status">
              {filtered.length} pipeline{filtered.length === 1 ? '' : 's'}
            </p>
          </div>
          <div className="max-h-[28rem] overflow-y-auto p-2">
            {loading && !definitions.length ? (
              <p className="p-4 text-sm text-textMuted" role="status">
                <Loader2 size={16} className="mr-2 inline animate-spin" />
                Loading pipelines…
              </p>
            ) : filtered.length === 0 ? (
              <div className="p-4 text-sm text-textMuted">
                <p>No pipelines match your search.</p>
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  className="mt-2 font-medium text-primary underline"
                >
                  Clear search
                </button>
              </div>
            ) : (
              filtered.map((definition) => (
                <button
                  key={definition.id}
                  type="button"
                  onClick={() => setPreviewId(definition.id)}
                  aria-pressed={preview?.id === definition.id}
                  disabled={loading || Boolean(selectingId)}
                  className={`mb-1 flex w-full items-start gap-3 rounded-lg border p-3 text-left transition disabled:opacity-60 ${preview?.id === definition.id ? 'border-primary/30 bg-primary/10' : 'border-transparent hover:bg-background'}`}
                >
                  <Layers size={20} className="mt-0.5 shrink-0 text-primary" aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold text-text">
                      {workflowName(definition)}
                    </span>
                    <span className="mt-1 block text-xs text-textMuted">
                      {definition.builtin ? 'Built in' : 'Shared catalog'} ·{' '}
                      {definition.manifest.tabs.length} steps
                    </span>
                  </span>
                  {definition.id === selectedId && (
                    <CheckCircle2
                      size={16}
                      className="shrink-0 text-success"
                      aria-label="Active workflow"
                    />
                  )}
                </button>
              ))
            )}
          </div>
        </div>
        {preview && (
          <div className="min-w-0 space-y-6 p-5 sm:p-6">
            <div>
              <h3 className="text-xl font-semibold tracking-tight text-text">
                {workflowName(preview)}
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-textMuted">
                {preview.manifest.description ||
                  'A workflow assembled from the available analysis tools.'}
              </p>
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={() => (isActive ? onOpen?.() : onSelect(preview.id))}
                  disabled={loading || Boolean(selectingId)}
                  className="btn btn-primary inline-flex items-center gap-2 text-sm"
                >
                  {selectingId === preview.id ? (
                    <Loader2 size={15} className="animate-spin" />
                  ) : isActive ? (
                    <CheckCircle2 size={15} />
                  ) : null}
                  {isActive ? 'Open pipeline' : 'Use pipeline'}
                </button>
                <button
                  type="button"
                  onClick={() =>
                    downloadPipeline(preview.manifest, `${preview.manifest.id}.definition.json`)
                  }
                  className="btn btn-secondary inline-flex items-center gap-2 text-sm"
                >
                  <Download size={15} /> Export definition
                </button>
              </div>
              <p className="mt-3 text-xs text-textMuted">
                Applies to your account in this project. Saved analyses stay unchanged.
              </p>
            </div>
            <div>
              <details>
                <summary className="cursor-pointer text-sm font-semibold text-text">
                  Included steps ({manifest.tabs.length})
                </summary>
                <ol className="mt-3 divide-y divide-border">
                  {manifest.tabs.map((step, index) => (
                    <li key={step.id} className="flex items-center gap-3 py-2.5 text-sm">
                      <span className="w-5 shrink-0 text-right text-xs text-textMuted">
                        {index + 1}
                      </span>
                      <span className="text-text">{step.label}</span>
                      {step.optional && (
                        <span className="ml-auto text-xs text-textMuted">Optional</span>
                      )}
                    </li>
                  ))}
                </ol>
              </details>
            </div>
            <PipelineTemplatePreview manifest={manifest} />
          </div>
        )}
      </div>
    </section>
  );
}
