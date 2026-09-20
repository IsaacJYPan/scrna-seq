import React, { useEffect, useRef, useState } from 'react';
import { parseWorkflowPackage, serializeWorkflow, WORKFLOW_LIMITS } from '../../shared/workflowPackage.mjs';
import { readPipelineFile, downloadPipeline } from '../pipelines/pipelineFiles';
import { workflowRequest } from '../pipelines/workflowApi';

export default function WorkflowLibrary({ userEmail, projectId, selectedObject, enabled, unsavedLiveChanges, onOpen }) {
  const key = `traceomics:workflows:${userEmail}`;
  const [library, setLibrary] = useState(() => {
    try {
      const values = JSON.parse(localStorage.getItem(key) || '[]');
      if (!Array.isArray(values) || values.length > 20) return [];
      return values.map(source => parseWorkflowPackage(source));
    } catch { return []; }
  });
  const [pending, setPending] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const opening = useRef(null);
  useEffect(() => () => opening.current?.abort(), [projectId, selectedObject?.id]);
  const save = values => { localStorage.setItem(key, JSON.stringify(values.map(serializeWorkflow))); setLibrary(values); };
  const open = async workflow => {
    opening.current?.abort();
    const controller = new AbortController();
    opening.current = controller;
    setBusy(true); setError('');
    try {
      const instance = await workflowRequest(projectId, 'open', 'POST', { source: serializeWorkflow(workflow), analysisObjectId: selectedObject.id }, controller.signal);
      if (!controller.signal.aborted) onOpen(instance);
    } catch (error) { if (error.name !== 'AbortError') setError(error.message); }
    finally { setBusy(false); }
  };
  return <section className="rounded-xl border border-border bg-surface/50 p-5" aria-label="Workflow pipelines">
    <div className="flex items-center justify-between gap-4">
      <h3 className="text-lg font-semibold">Workflow pipelines</h3>
      <label className="btn btn-secondary cursor-pointer text-sm">Import workflow
        <input aria-label="Workflow package file" type="file" accept=".json" className="sr-only" onChange={async event => {
          const file = event.target.files?.[0]; event.target.value = ''; setPending(null); setError('');
          if (!file) return;
          try {
            if (file.size > WORKFLOW_LIMITS.bytes) throw new Error('Workflow package exceeds 512 KiB.');
            setPending(parseWorkflowPackage(await readPipelineFile(file)));
          } catch (error) { setError(error.message); }
        }} />
      </label>
    </div>
    <p className="mt-2 text-sm text-textMuted">Pipelines with their own analysis steps and plots. Install a version, then open it on a saved analysis.</p>
    {error && <p role="alert" className="mt-3 text-danger">{error}</p>}
    {pending && <div className="mt-4 border-t border-border pt-4">
      <p className="font-medium">{pending.name} · {pending.version}</p><p className="text-sm text-textMuted">{pending.description}</p>
      <p className="mt-2 text-sm">Tabs: {pending.tabs.map(tab => tab.label).join(', ')}</p>
      <details className="my-3 text-sm"><summary>Review R source</summary>{Object.entries(pending.files).map(([name, source]) => <div key={name}><p className="mt-3 font-medium">{name}</p><pre className="max-h-60 overflow-auto whitespace-pre-wrap">{source}</pre></div>)}</details>
      <p className="my-3 text-sm text-textMuted">Run code from authors you trust. A run can read the selected analysis and its workflow inputs.</p>
      <button className="btn btn-primary text-sm" onClick={() => {
        try {
          const existing = library.find(item => item.id === pending.id && item.version === pending.version);
          if (existing && serializeWorkflow(existing) !== serializeWorkflow(pending)) throw new Error('This version is installed with different contents. Use a new version number.');
          if (!existing && library.length >= 20) throw new Error('Remove an installed version before adding more than 20.');
          if (!existing) save([...library, pending]);
          setPending(null);
        } catch (error) { setError(error.message); }
      }}>Install {pending.name}</button>
    </div>}
    {library.map(workflow => <div key={`${workflow.id}@${workflow.version}`} className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
      <div><p className="font-medium">{workflow.name} <span className="text-sm text-textMuted">{workflow.version}</span></p><p className="text-sm text-textMuted">{workflow.tabs.length} tabs · {workflow.steps.length} steps</p></div>
      <div className="flex gap-2">
        <button className="btn btn-primary text-sm" disabled={busy || !enabled || !selectedObject || unsavedLiveChanges} onClick={() => open(workflow)}>Open {workflow.name}</button>
        <button className="btn btn-secondary text-sm" onClick={() => downloadPipeline(workflow, `${workflow.id}-${workflow.version}.pipeline.json`)}>Export</button>
        <button className="btn btn-secondary text-sm" onClick={() => { try { save(library.filter(item => item !== workflow)); } catch (error) { setError(error.message); } }}>Remove</button>
      </div>
    </div>)}
    {(!enabled || unsavedLiveChanges) && <p className="mt-3 text-sm text-textMuted">{unsavedLiveChanges ? 'Save your current analysis before opening a workflow.' : 'Running custom workflows requires access to the isolated R runtime.'}</p>}
  </section>;
}
