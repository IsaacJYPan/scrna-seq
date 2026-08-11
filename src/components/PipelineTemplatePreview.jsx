import React from 'react';
import { FileClock, FormInput, TableProperties } from 'lucide-react';

const VIEW_LABELS = Object.freeze({
  summaryMetrics: 'Summary metrics',
  artifactTable: 'Result table',
  jobLogs: 'Run notes',
  placeholder: 'Result preview',
});

function previewValue(parameter) {
  if (parameter.default !== undefined) return parameter.default;
  if (parameter.type === 'boolean') return false;
  if (parameter.type === 'enum') return parameter.options?.[0] || '';
  return '';
}

function ParameterControl({ parameter, inputId }) {
  const label = `${parameter.label}${parameter.required ? ' (required)' : ''}`;
  const commonClass = 'mt-1 w-full rounded border border-border bg-background px-2 py-1.5 text-sm text-text disabled:cursor-not-allowed disabled:opacity-75';
  let control;
  if (parameter.type === 'boolean') {
    control = (
      <label htmlFor={inputId} className="mt-2 inline-flex items-center gap-2 text-sm text-text">
        <input id={inputId} type="checkbox" checked={Boolean(previewValue(parameter))} disabled readOnly />
        {label}
      </label>
    );
  } else if (parameter.type === 'enum') {
    control = (
      <>
        <label htmlFor={inputId} className="text-xs font-bold text-text">{label}</label>
        <select id={inputId} value={previewValue(parameter)} disabled className={commonClass}>
          {(parameter.options || []).map(option => <option key={option} value={option}>{option}</option>)}
        </select>
      </>
    );
  } else if (parameter.type === 'number' || parameter.type === 'integer') {
    control = (
      <>
        <label htmlFor={inputId} className="text-xs font-bold text-text">{label}</label>
        <input
          id={inputId}
          type="number"
          value={previewValue(parameter)}
          min={parameter.min}
          max={parameter.max}
          step={parameter.step || (parameter.type === 'integer' ? 1 : 'any')}
          disabled
          readOnly
          className={commonClass}
        />
      </>
    );
  } else {
    control = (
      <>
        <label htmlFor={inputId} className="text-xs font-bold text-text">{label}</label>
        <input
          id={inputId}
          type="text"
          value={previewValue(parameter)}
          placeholder={parameter.placeholder || ''}
          maxLength={parameter.maxLength}
          disabled
          readOnly
          className={commonClass}
        />
      </>
    );
  }

  return (
    <div className="rounded border border-border bg-surface/40 p-3">
      {control}
      {parameter.description && <p className="mt-1 text-xs text-textMuted">{parameter.description}</p>}
    </div>
  );
}

function ResultView({ view }) {
  const definition = typeof view === 'string' ? { type: view } : view;
  const title = definition.title || VIEW_LABELS[definition.type] || 'Result preview';
  const Icon = definition.type === 'artifactTable' ? TableProperties : FileClock;
  return (
    <div className="rounded border border-border bg-surface/40 p-3">
      <div className="flex items-center gap-2 text-sm font-bold text-text">
        <Icon size={15} className="text-primary" />
        {title}
      </div>
    </div>
  );
}

export default function PipelineTemplatePreview({ manifest }) {
  const tabs = Array.isArray(manifest?.tabs) ? manifest.tabs : [];
  const renderedTabs = tabs.filter(tab => (tab.parameterSchema || []).length > 0 || (tab.resultViews || []).length > 0);

  return (
    <section className="space-y-4" aria-labelledby="pipeline-template-preview-heading">
      <div>
        <h3 id="pipeline-template-preview-heading" className="flex items-center gap-2 text-lg font-bold text-text">
          <FormInput size={18} className="text-primary" />
          Workflow preview
        </h3>
        <p className="mt-1 max-w-4xl text-sm text-textMuted">
          These settings and result cards are available in the approved workflow. This is a read-only preview; start the workflow from its analysis step when you are ready.
        </p>
      </div>

      {renderedTabs.length === 0 ? (
        <div className="rounded border border-dashed border-border p-4 text-sm text-textMuted">
          No settings or result previews are available for this workflow.
        </div>
      ) : (
        <div className="space-y-3">
          {renderedTabs.map((tab, tabIndex) => (
            <details key={tab.id} open={tabIndex === 0} className="rounded-lg border border-border bg-surface/50">
              <summary className="cursor-pointer px-4 py-3 font-bold text-text">{tab.label}</summary>
              <div className="grid gap-4 border-t border-border p-4 lg:grid-cols-2">
                <fieldset disabled className="space-y-3">
                  <legend className="mb-2 text-[10px] font-bold uppercase tracking-widest text-textMuted">Parameters</legend>
                  {(tab.parameterSchema || []).length > 0 ? (tab.parameterSchema || []).map(parameter => (
                    <ParameterControl
                      key={parameter.key}
                      parameter={parameter}
                      inputId={`pipeline-preview-${manifest.id}-${tab.id}-${parameter.key}`}
                    />
                  )) : <p className="text-sm text-textMuted">No settings are needed for this step.</p>}
                </fieldset>
                <div>
                  <div className="mb-2 text-[10px] font-bold uppercase tracking-widest text-textMuted">Result views</div>
                  <div className="space-y-3">
                    {(tab.resultViews || []).length > 0 ? (tab.resultViews || []).map((view, index) => (
                      <ResultView key={`${typeof view === 'string' ? view : view.type}-${index}`} view={view} />
                    )) : <p className="text-sm text-textMuted">Results will appear in Runs &amp; Results.</p>}
                  </div>
                </div>
              </div>
            </details>
          ))}
        </div>
      )}
    </section>
  );
}
