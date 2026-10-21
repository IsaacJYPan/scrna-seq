import React, { useEffect, useRef, useState } from 'react';
import RetainedArtifactView from './RetainedArtifactView';
import { invalidatedWorkflowSteps, workflowAvailability } from '../../shared/workflowState.mjs';
import { workflowParameters } from '../../shared/workflowPackage.mjs';
import { workflowRequest, workflowUrl } from '../pipelines/workflowApi';
import { useWorkflowRequest } from '../pipelines/useWorkflowRequest';
import useExecutionTarget from '../runtime/useExecutionTarget';
import { getExecutionTargetSnapshot, TARGET_DISCONNECTED_MESSAGE } from '../runtime/executionTarget';
import { getWorkflowSnapshot, openWorkflowSnapshot } from '../analyses/researchAnalysisApi';
import RetainedWorkflowSnapshotView from '../analyses/RetainedWorkflowSnapshotView';
import { validateWorkflowRestoration } from '../analyses/workflowSnapshotClient';

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

function ResultPanel({ projectId, userId, output, label }) {
  const { blocked } = useExecutionTarget();
  return <section className="min-w-0 rounded-lg border border-border bg-surface p-4">
    <div className="mb-3 flex items-center justify-between gap-3"><h3 className="font-medium">{label}</h3>{!blocked && <a className="text-sm text-primary" href={`${workflowUrl(projectId, `artifacts/${output.id}`)}?download=1`}>Download</a>}</div>
    <RetainedArtifactView projectId={projectId} userId={userId} reference={{ kind: 'artifact-version', versionId: output.id, sha256: output.sha256 }} compact />
  </section>;
}

function StepPanel({ step, instance, projectId, userId, update, enabled, request }) {
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
    {applied && Object.entries(applied.outputs).map(([port, output]) => <ResultPanel key={output.id} projectId={projectId} userId={userId} output={output} label={step.outputs[port].label} />)}
  </section>;
}

export default function WorkflowWorkbench({ instance, projectId, userId, activeTab, onUpdate, onExit, enabled }) {
  const { blocked } = useExecutionTarget();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [name, setName] = useState('');
  const [snapshots, setSnapshots] = useState([]);
  const [busy, setBusy] = useState(false);
  const [restoration, setRestoration] = useState(0);
  const [openingSnapshot, setOpeningSnapshot] = useState(null);
  const [writeAccess, setWriteAccess] = useState(true);
  const mounted = useRef(false), discovery = useRef(null), openingSlot = useRef({ epoch: 0 });
  const scope = useRef(null);
  scope.current = { projectId, instanceId: instance.id, userId };
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; discovery.current?.abort(); openingSlot.current = { epoch: openingSlot.current.epoch + 1 }; };
  }, []);
  useEffect(() => {
    discovery.current?.abort(); openingSlot.current = { epoch: openingSlot.current.epoch + 1 };
    setOpeningSnapshot(null);
  }, [projectId, instance.id, userId]);
  const request = useWorkflowRequest(projectId, instance.id);
  const tab = instance.package.tabs.find(tab => `workflow:${tab.id}` === activeTab) || instance.package.tabs[0];
  useEffect(() => {
    let active = true; let timer;
    const refresh = async () => {
      try {
        const updated = await request(`instances/${instance.id}`);
        if (active) onUpdate(updated);
      } catch (error) { if (active && error.name !== 'AbortError') setError(error.message); }
      if (active) timer = setTimeout(refresh, 2000);
    };
    if (!blocked && writeAccess) refresh();
    return () => { active = false; clearTimeout(timer); };
  }, [request, instance.id, onUpdate, blocked, writeAccess]);
  useEffect(() => {
    if (!writeAccess) return undefined;
    const controller = new AbortController();
    workflowRequest(projectId, `snapshots?analysisObjectId=${encodeURIComponent(instance.analysisObjectId)}`, 'GET', undefined, controller.signal).then(value => { if (!controller.signal.aborted) setSnapshots(value); }).catch(error => { if (!controller.signal.aborted && error.name !== 'AbortError') setError(error.message); });
    return () => controller.abort();
  }, [projectId, instance.analysisObjectId, notice, writeAccess]);
  const action = async callback => {
    setBusy(true); setError(''); setNotice('');
    try { await callback(); } catch (error) { if (error.name !== 'AbortError') setError(error.message); } finally { setBusy(false); }
  };
  return <div className="mx-auto max-w-6xl space-y-6 p-6 text-text">
    <div className="flex flex-wrap items-center justify-between gap-4"><div><h1 className="text-2xl font-semibold">{instance.package.name}</h1><p className="text-sm text-textMuted">{instance.package.version} · Working results are temporary until saved.</p></div><button className="btn btn-secondary" onClick={onExit}>Back to Pipelines</button></div>
    {error && <p role="alert" className="text-danger">{error}</p>}
    {blocked && <p role="status" className="rounded border border-amber-300 p-3 text-sm">{TARGET_DISCONNECTED_MESSAGE} Reconnect to the same workspace for a fresh authorized read of retained results. No analysis runtime is started and no recipe step is rerun automatically.</p>}
    {instance.state.error && <p role="alert" className="text-danger">{instance.state.error}</p>}
    {notice && <p role="status">{notice}</p>}
    {!writeAccess && <p role="status" className="text-sm text-textMuted">Your current project role allows inspection only. Reload the workspace after any access change.</p>}
    <div className="flex flex-wrap items-end gap-3">
      <label className="grid gap-1 text-sm">Snapshot name<input className={inputClassName} value={name} maxLength={100} onChange={event => setName(event.target.value)} /></label>
      <button className="btn btn-secondary" disabled={!writeAccess || busy || !!instance.state.active || !name.trim()} onClick={() => action(async () => { await request(`instances/${instance.id}/save`, 'POST', { name }); setNotice(`Saved ${name}.`); })}>Save workflow</button>
      {instance.state.active && <button className="btn btn-secondary" disabled={!writeAccess || busy} onClick={() => action(async () => onUpdate(await request(`instances/${instance.id}/cancel`, 'POST', {})))}>Cancel run</button>}
      <button className="btn btn-secondary" disabled={!writeAccess || busy || !!instance.state.active} onClick={() => {
        if (window.confirm('Discard this workflow’s working results? Saved snapshots will remain available.')) action(async () => {
          await request(`instances/${instance.id}`, 'DELETE');
          onExit();
        });
      }}>Discard working results</button>
    </div>
    <details className="text-sm">
      <summary>Recent saved workflows for this analysis</summary>
      <ul className="mt-3 space-y-2">{snapshots.filter(snapshot => snapshot.analysisObjectId === instance.analysisObjectId).map(snapshot => <li key={snapshot.id} className="flex gap-3">
        <span>{snapshot.name}</span>
        <button className="text-primary" disabled={busy || !!instance.state.active} onClick={() => {
          action(async () => {
            const before = { ...scope.current }, target = getExecutionTargetSnapshot(), epoch = openingSlot.current.epoch + 1;
            discovery.current?.abort(); const controller = new AbortController(); discovery.current = controller;
            openingSlot.current = { epoch, id: snapshot.id };
            const result = await getWorkflowSnapshot(projectId, snapshot.id, { signal: controller.signal });
            const after = scope.current, currentTarget = getExecutionTargetSnapshot();
            if (!mounted.current || controller.signal.aborted || openingSlot.current.epoch !== epoch || after.projectId !== before.projectId
                || after.instanceId !== before.instanceId || after.userId !== before.userId
                || currentTarget.identity !== target.identity || currentTarget.epoch !== target.epoch || currentTarget.blocked) return;
            openingSlot.current = { epoch, id: snapshot.id, sha256: result.snapshot.sha256 };
            setOpeningSnapshot(result.snapshot);
          });
        }}>Open</button>
        <button disabled={!writeAccess || busy} onClick={() => {
          if (window.confirm(`Delete saved workflow “${snapshot.name}”?`)) action(async () => {
            await request(`snapshots/${snapshot.id}`, 'DELETE');
            setNotice('Snapshot deleted.');
          });
        }}>Delete</button>
      </li>)}</ul>
    </details>
    {openingSnapshot && <section aria-label="Open retained workflow" className="space-y-4 rounded border border-border bg-surface p-4">
      <button type="button" className="text-xs text-primary underline" onClick={() => { discovery.current?.abort(); openingSlot.current = { epoch: openingSlot.current.epoch + 1 }; setOpeningSnapshot(null); }}>Close saved workflow details</button>
      <RetainedWorkflowSnapshotView key={openingSnapshot.id} projectId={projectId} userId={userId} initialSnapshot={openingSnapshot}
        reference={{ kind: 'workflow-snapshot', snapshotId: openingSnapshot.id, sha256: openingSnapshot.sha256 }} canWrite={writeAccess}
        onOpenWorkflow={async ({ snapshot, request: input, isCurrent = () => true }) => {
          const before = { ...scope.current }, target = getExecutionTargetSnapshot(), slot = { ...openingSlot.current };
          const current = () => mounted.current && isCurrent() && scope.current.projectId === before.projectId
            && scope.current.instanceId === before.instanceId && scope.current.userId === before.userId
            && openingSlot.current.epoch === slot.epoch && openingSlot.current.id === snapshot.id && openingSlot.current.sha256 === snapshot.sha256
            && getExecutionTargetSnapshot().identity === target.identity && getExecutionTargetSnapshot().epoch === target.epoch
            && !getExecutionTargetSnapshot().blocked;
          if (!current()) throw Object.assign(new Error('The saved workflow view changed.'), { code: 'TARGET_CHANGED' });
          const result = validateWorkflowRestoration(await openWorkflowSnapshot(projectId, snapshot.id, input), snapshot, input);
          if (!current()) return { ...result, navigationNote: 'The original open is confirmed. Your current view was kept; the saved snapshot was not applied again.' };
          if (!result.canEditWorking) setWriteAccess(false);
          if (result.currentInstance && result.canEditWorking) { setRestoration(value => value + 1); onUpdate(result.currentInstance, { replace: true }); }
          return result;
        }} />
    </section>}
    {[tab.step, ...tab.plots].map(id => <StepPanel key={`${instance.id}:${restoration}:${id}`} step={instance.package.steps.find(step => step.id === id)} instance={instance} projectId={projectId} userId={userId} update={onUpdate} enabled={enabled && !blocked && writeAccess} request={request} />)}
  </div>;
}
