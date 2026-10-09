import React, { useEffect, useState } from 'react';
import Plot from './Plot';
import { invalidatedWorkflowSteps, workflowAvailability } from '../../shared/workflowState.mjs';
import { workflowParameters } from '../../shared/workflowPackage.mjs';
import { workflowRequest, workflowUrl } from '../pipelines/workflowApi';
import { useWorkflowRequest } from '../pipelines/useWorkflowRequest';
import useExecutionTarget from '../runtime/useExecutionTarget';
import { TARGET_DISCONNECTED_MESSAGE } from '../runtime/executionTarget';

const inputClassName = 'w-full rounded-md border border-border bg-background px-3 py-2 text-text';

function ParameterField({ parameter, value, onChange }) {
  const numeric = ['number', 'integer'].includes(parameter.type);
  let control;
  if (parameter.type === 'boolean') {
    control = <input type="checkbox" checked={value} onChange={event => onChange(event.target.checked)} />;
  } else if (parameter.type === 'choice') {
    control = <select className={inputClassName} value={value} onChange={event => onChange(event.target.value)}>
      {parameter.options.map(option => <option key={option}>{option}</option>)}
    </select>;
  } else {
    control = <input className={inputClassName} type={numeric ? 'number' : 'text'}
      step={parameter.type === 'integer' ? 1 : 'any'} min={parameter.min} max={parameter.max}
      maxLength={parameter.maxLength} value={value}
      onChange={event => onChange(numeric && event.target.value !== '' ? Number(event.target.value) : event.target.value)} />;
  }
  return <label className="grid gap-1 text-sm">{parameter.label}{control}</label>;
}

function scatterTraces(data) {
  const escape = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const traces = new Map();
  data.ids.forEach((id, index) => {
    const group = data.groups?.[index] ?? 'Cells';
    if (!traces.has(group)) traces.set(group, {
      name: escape(group), type: data.ids.length <= 20000 ? 'scatter' : 'scattergl',
      mode: 'markers', x: [], y: [], text: [], marker: { size: 4 }, hoverinfo: 'text',
    });
    const trace = traces.get(group);
    trace.x.push(data.x[index]); trace.y.push(data.y[index]); trace.text.push(escape(id));
  });
  return [...traces.values()];
}

function ResultPanel({ projectId, output, label }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [page, setPage] = useState(0);
  const url = workflowUrl(projectId, `artifacts/${output.id}`);
  useEffect(() => {
    if (['figure', 'rds'].includes(output.type)) return;
    const controller = new AbortController();
    setData(null); setError(''); setPage(0);
    workflowRequest(projectId, `artifacts/${output.id}`, 'GET', undefined, controller.signal)
      .then(setData).catch(error => { if (error.name !== 'AbortError') setError(error.message); });
    return () => controller.abort();
  }, [projectId, output.id, output.type]);
  return <section className="rounded-lg border border-border bg-surface p-4">
    <div className="mb-3 flex items-center justify-between gap-3"><h3 className="font-medium">{label}</h3><a className="text-sm text-primary" href={`${url}?download=1`}>Download</a></div>
    {error && <p role="alert">{error}</p>}
    {output.type === 'figure' && <img src={url} alt={label} className="h-auto max-w-full" />}
    {output.type === 'rds' && <p className="text-sm text-textMuted">Available to dependent steps in this workflow.</p>}
    {data && output.type === 'metrics' && <dl className="grid grid-cols-2 gap-3">{Object.entries(data).map(([key, value]) => <div key={key}><dt className="text-sm text-textMuted">{key}</dt><dd>{String(value ?? '—')}</dd></div>)}</dl>}
    {data && output.type === 'table' && <>
      <div className="overflow-auto"><table className="w-full text-left text-sm"><thead><tr>{Object.keys(data[0] || {}).map(key => <th key={key} className="p-2">{key}</th>)}</tr></thead><tbody>{data.slice(page * 100, (page + 1) * 100).map((row, index) => <tr key={index}>{Object.entries(row).map(([key, value]) => <td key={key} className="border-t border-border p-2">{String(value ?? '')}</td>)}</tr>)}</tbody></table></div>
      <div className="mt-3 flex gap-3 text-sm"><button disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</button><span>{data.length} rows</span><button disabled={(page + 1) * 100 >= data.length} onClick={() => setPage(page + 1)}>Next</button></div>
    </>}
    {data && output.type === 'scatter' && <Plot data={scatterTraces(data)} layout={{ autosize: true, height: 460, showlegend: !!data.groups, margin: { l: 45, r: 20, t: 20, b: 40 } }} config={{ responsive: true, displaylogo: false }} style={{ width: '100%' }} useResizeHandler />}
  </section>;
}

function StepPanel({ step, instance, projectId, update, enabled, request }) {
  const { state, package: workflow } = instance;
  const applied = state.results[step.id];
  const [parameters, setParameters] = useState(() => workflowParameters(step, applied?.parameters));
  const [seed, setSeed] = useState(applied?.seed ?? 1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const available = workflowAvailability(workflow, state, step.id);
  const cleared = invalidatedWorkflowSteps(workflow, Object.keys(step.outputs).map(port => `${step.id}.${port}`))
    .filter(id => state.results[id]).map(id => workflow.steps.find(step => step.id === id).label);
  const run = async () => {
    setBusy(true); setError('');
    try {
      workflowParameters(step, parameters);
      update(await request(`instances/${instance.id}/run`, 'POST', { requestId: crypto.randomUUID(), stepId: step.id, parameters, seed }));
    } catch (error) { if (error.name !== 'AbortError') setError(error.message); }
    finally { setBusy(false); }
  };
  return <section className="space-y-4" aria-label={step.label}>
    <h2 className="text-xl font-semibold">{step.label}</h2>
    {!available.ready ? <p className="text-sm text-textMuted">{available.reason}</p> : <div className="rounded-lg border border-border bg-surface p-4">
      <div className="grid max-w-xl gap-4">
        {step.parameters.map(parameter => <ParameterField key={parameter.key} parameter={parameter}
          value={parameters[parameter.key]} onChange={value => setParameters({ ...parameters, [parameter.key]: value })} />)}
        <ParameterField parameter={{ label: 'Random seed', type: 'integer', min: 0, max: 2147483647 }} value={seed} onChange={setSeed} />
      </div>
      {cleared.length > 0 && <p className="mt-3 text-sm text-textMuted">Changed outputs will clear {cleared.join(', ')}.</p>}
      <button className="btn btn-primary mt-4" disabled={busy || !!state.active || !enabled} onClick={run}>Run {step.label}</button>
      {state.active?.stepId === step.id && <p role="status" className="mt-3 text-sm">Running {step.label}…</p>}
      {error && <p role="alert" className="mt-3 text-danger">{error}</p>}
    </div>}
    {applied && <details className="text-sm text-textMuted"><summary>Applied settings</summary><pre className="mt-2 whitespace-pre-wrap">{JSON.stringify({ ...applied.parameters, seed: applied.seed }, null, 2)}</pre></details>}
    {applied && Object.entries(applied.outputs).map(([port, output]) => <ResultPanel key={output.id} projectId={projectId} output={output} label={step.outputs[port].label} />)}
  </section>;
}

export default function WorkflowWorkbench({ instance, projectId, activeTab, onUpdate, onExit, enabled }) {
  const { blocked } = useExecutionTarget();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [name, setName] = useState('');
  const [snapshots, setSnapshots] = useState([]);
  const [busy, setBusy] = useState(false);
  const [restoration, setRestoration] = useState(0);
  const request = useWorkflowRequest(projectId, instance.id);
  const tab = instance.package.tabs.find(tab => `workflow:${tab.id}` === activeTab) || instance.package.tabs[0];
  useEffect(() => {
    let active = true; let timer;
    const refresh = async () => {
      try {
        const updated = await request(`instances/${instance.id}`);
        if (active) onUpdate(updated);
      } catch (error) { if (error.name !== 'AbortError') setError(error.message); }
      if (active) timer = setTimeout(refresh, 2000);
    };
    if (!blocked) refresh();
    return () => { active = false; clearTimeout(timer); };
  }, [request, instance.id, onUpdate, blocked]);
  useEffect(() => {
    const controller = new AbortController();
    workflowRequest(projectId, 'snapshots', 'GET', undefined, controller.signal).then(setSnapshots).catch(error => { if (error.name !== 'AbortError') setError(error.message); });
    return () => controller.abort();
  }, [projectId, notice]);
  const action = async callback => {
    setBusy(true); setError(''); setNotice('');
    try { await callback(); } catch (error) { if (error.name !== 'AbortError') setError(error.message); } finally { setBusy(false); }
  };
  return <div className="mx-auto max-w-6xl space-y-6 p-6 text-text">
    <div className="flex flex-wrap items-center justify-between gap-4"><div><h1 className="text-2xl font-semibold">{instance.package.name}</h1><p className="text-sm text-textMuted">{instance.package.version} · Working results are temporary until saved.</p></div><button className="btn btn-secondary" onClick={onExit}>Back to Pipelines</button></div>
    {error && <p role="alert" className="text-danger">{error}</p>}
    {blocked && <p role="status" className="rounded border border-amber-300 p-3 text-sm">{TARGET_DISCONNECTED_MESSAGE} Retained results stay visible; no recipe step is rerun automatically.</p>}
    {instance.state.error && <p role="alert" className="text-danger">{instance.state.error}</p>}
    {notice && <p role="status">{notice}</p>}
    <div className="flex flex-wrap items-end gap-3">
      <label className="grid gap-1 text-sm">Snapshot name<input className={inputClassName} value={name} maxLength={100} onChange={event => setName(event.target.value)} /></label>
      <button className="btn btn-secondary" disabled={busy || !!instance.state.active || !name.trim()} onClick={() => action(async () => { await request(`instances/${instance.id}/save`, 'POST', { name }); setNotice(`Saved ${name}.`); })}>Save workflow</button>
      {instance.state.active && <button className="btn btn-secondary" disabled={busy} onClick={() => action(async () => onUpdate(await request(`instances/${instance.id}/cancel`, 'POST', {})))}>Cancel run</button>}
      <button className="btn btn-secondary" disabled={busy || !!instance.state.active} onClick={() => {
        if (window.confirm('Discard this workflow’s working results? Saved snapshots will remain available.')) action(async () => {
          await request(`instances/${instance.id}`, 'DELETE');
          onExit();
        });
      }}>Discard working results</button>
    </div>
    <details className="text-sm">
      <summary>Saved workflows for this analysis</summary>
      <ul className="mt-3 space-y-2">{snapshots.filter(snapshot => snapshot.analysisObjectId === instance.analysisObjectId).map(snapshot => <li key={snapshot.id} className="flex gap-3">
        <span>{snapshot.name}</span>
        <button className="text-primary" disabled={busy || !!instance.state.active} onClick={() => {
          if (window.confirm('Open this snapshot and replace its current working results? Saved snapshots will remain unchanged.')) action(async () => {
            const restored = await request(`snapshots/${snapshot.id}/open`, 'POST', {});
            setRestoration(value => value + 1);
            onUpdate(restored, { replace: true });
            setNotice(`Opened ${snapshot.name}.`);
          });
        }}>Open</button>
        <button disabled={busy} onClick={() => {
          if (window.confirm(`Delete saved workflow “${snapshot.name}”?`)) action(async () => {
            await request(`snapshots/${snapshot.id}`, 'DELETE');
            setNotice('Snapshot deleted.');
          });
        }}>Delete</button>
      </li>)}</ul>
    </details>
    {[tab.step, ...tab.plots].map(id => <StepPanel key={`${instance.id}:${restoration}:${id}`} step={instance.package.steps.find(step => step.id === id)} instance={instance} projectId={projectId} update={onUpdate} enabled={enabled && !blocked} request={request} />)}
  </div>;
}
