import React, { useCallback, useEffect, useRef, useState } from 'react';
import { getRunMonitoring, listRunMonitoring } from '../executions/runMonitoringApi';
import useExecutionTarget from '../runtime/useExecutionTarget';
import ExecutionTargetEvidence from './ExecutionTargetEvidence';

const activeStatuses = new Set(['queued', 'running', 'reserved']);
const stateLabels = { queued: 'Waiting for compute', running: 'Running', reserved: 'Preparing', completed: 'Complete', failed: 'Needs attention', canceled: 'Canceled', unknown: 'Unconfirmed' };
const operationLabels = {
  'pbmc.pipeline.v1': 'PBMC preprocessing', 'seurat.pipeline.v1': 'Standard preprocessing',
  'seurat.multisample.v1': 'Multi-sample preprocessing', 'spatial.seurat.v1': 'Spatial preprocessing',
  'checkpoint.save.v1': 'Save current analysis', 'checkpoint.load.v1': 'Restore saved version',
  'checkpoint.fork.v1': 'Create analysis branch', 'deg.find_markers.v1': 'Cluster marker analysis',
  'enrichment.gsea.v1': 'Pathway enrichment', 'cellchat.infer.v1': 'CellChat candidate analysis',
  'condition.pseudobulk_de.v1': 'Condition comparison', 'explore.summarize.v1': 'Exploratory analysis',
  'expert.r.v1': 'R analysis',
};
const label = item => operationLabels[item.operation] || item.operation || 'Analysis run';
const date = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : 'Not reported';
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
function duration(value) {
  if (!number(value)) return 'Not reported';
  const seconds = Math.floor(value / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m ${seconds % 60}s`;
}
function bytes(value) {
  if (!number(value)) return 'Not reported';
  if (value < 1024 ** 2) return `${Math.round(value / 1024)} KiB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MiB`;
  return `${(value / 1024 ** 3).toFixed(2)} GiB`;
}

function ResourceObservation({ resources, lastConfirmed }) {
  const observed = resources?.state === 'observed' && resources.scope === 'r-container';
  const limits = resources?.limits || (observed ? { cpuLimit: resources.cpuLimit, memoryBytes: resources.memoryLimitBytes } : null);
  return <section aria-label="Runtime resources" className="rounded border border-border p-3 space-y-2 text-xs">
    <h5 className="font-medium">Runtime resources</h5>
    {observed ? <>
      {lastConfirmed && <p>Last confirmed container sample; current resource usage is unknown.</p>}
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1">
        <dt>CPU usage</dt><dd aria-label="CPU usage">{number(resources.cpuPercent) ? `${resources.cpuPercent.toFixed(1)}%` : 'Not reported'}</dd>
        <dt>Memory usage</dt><dd aria-label="Memory usage">{bytes(resources.memoryBytes)}</dd>
        <dt>Resource sample</dt><dd>{date(resources.observedAt)}</dd>
        <dt>Sample scope</dt><dd>Selected R container</dd>
      </dl>
      <p className="text-textMuted">Container CPU usage can exceed 100% when more than one CPU is used. This sample does not measure the whole server or predict completion time.</p>
    </> : <p>Resource usage is not reported for this run.</p>}
    {resources?.note && <p className="text-textMuted">{resources.note}</p>}
    {limits && <details><summary className="cursor-pointer">Configured resource limits</summary><dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1">
      <dt>CPU limit</dt><dd>{number(limits.cpuLimit) ? `${limits.cpuLimit} CPUs` : 'Not reported'}</dd>
      <dt>Memory limit</dt><dd>{bytes(limits.memoryBytes)}</dd>
    </dl><p className="mt-2 text-textMuted">Limits describe the configured allowance; they are separate from measured usage.</p></details>}
  </section>;
}

function WorkerObservation({ worker }) {
  if (!worker) return null;
  const states = { 'lease-current': 'Current', 'lease-expired': 'Expired', 'not-running': 'No active lease', unknown: 'Unconfirmed' };
  return <section aria-label="Worker status" className="rounded border border-border p-3 space-y-2 text-xs">
    <h5 className="font-medium">Worker status</h5>
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1">
      <dt>Worker lease</dt><dd>{states[worker.state] || 'Unconfirmed'}</dd>
      <dt>Last heartbeat</dt><dd>{date(worker.heartbeatAt)}</dd>
      <dt>Lease expiry</dt><dd>{date(worker.leaseExpiresAt)}</dd>
    </dl>
    {worker.note && <p className="text-textMuted">{worker.note}</p>}
  </section>;
}

export default function RunMonitor({ projectId, userId }) {
  const connection = useExecutionTarget();
  const scope = `${projectId}:${userId}:${connection.identity}`;
  const current = useRef(null); current.current = { scope, epoch: connection.epoch, blocked: connection.blocked };
  const [items, setItems] = useState([]); const [cursor, setCursor] = useState(null);
  const [selected, setSelected] = useState(null); const selectedRef = useRef(null);
  const [detail, setDetail] = useState(null); const [dataScope, setDataScope] = useState(scope);
  const [loading, setLoading] = useState(false); const [checking, setChecking] = useState(false);
  const [stale, setStale] = useState(false); const [error, setError] = useState('');
  const [expired, setExpired] = useState(false);
  const listRequest = useRef(null); const detailRequest = useRef(null);
  const scopeMatches = dataScope === scope;
  const visibleItems = scopeMatches ? items : [];
  const visibleDetail = scopeMatches ? detail : null;
  const observedId = visibleDetail?.id;
  const observedStatus = visibleDetail?.status;
  const observedAt = visibleDetail?.checkedAt;
  const staleAfterMs = number(visibleDetail?.staleAfterMs) && visibleDetail.staleAfterMs > 0 ? Math.min(visibleDetail.staleAfterMs, 10000) : 10000;
  const lastConfirmed = connection.blocked || stale || expired;

  const clearPrivate = useCallback(() => {
    listRequest.current?.abort(); detailRequest.current?.abort();
    setItems([]); setCursor(null); setSelected(null); selectedRef.current = null; setDetail(null);
    setLoading(false); setChecking(false); setStale(false); setExpired(false);
  }, []);
  const contextMatches = useCallback(context => current.current.scope === context.scope && current.current.epoch === context.epoch && !current.current.blocked, []);
  const showFailure = useCallback(failure => {
    setError(failure.message);
    if ([401, 403, 404].includes(failure.status)) clearPrivate();
    else setStale(true);
  }, [clearPrivate]);

  const readDetail = useCallback(async (id, skipIfPending = false) => {
    if (!projectId || !id || current.current.blocked || (skipIfPending && detailRequest.current)) return;
    detailRequest.current?.abort(); const controller = new AbortController(); detailRequest.current = controller;
    const context = { ...current.current };
    setChecking(true);
    try {
      const value = await getRunMonitoring(projectId, id, controller.signal);
      if (controller.signal.aborted || !contextMatches(context) || selectedRef.current !== id) return;
      if (!value || value.id !== id || value.projectId !== projectId) throw new Error('The monitoring response did not match the selected run. Refresh to check its status.');
      setDetail(value); setStale(false); setError('');
      setItems(existing => existing.map(item => item.id === id ? { ...item, status: value.status, timestamps: value.timestamps, timing: value.timing } : item));
    } catch (failure) {
      if (!controller.signal.aborted && contextMatches(context) && selectedRef.current === id) showFailure(failure);
    } finally { if (detailRequest.current === controller) { detailRequest.current = null; setChecking(false); } }
  }, [projectId, contextMatches, showFailure]);

  const readList = useCallback(async before => {
    if (!projectId || current.current.blocked) return;
    listRequest.current?.abort(); const controller = new AbortController(); listRequest.current = controller;
    const context = { ...current.current };
    setLoading(true);
    try {
      const value = await listRunMonitoring(projectId, { before, signal: controller.signal });
      if (controller.signal.aborted || !contextMatches(context)) return;
      if (!Array.isArray(value?.items) || value.items.length > 25 || value.items.some(item => !item?.id || item.projectId !== projectId)) throw new Error('The monitoring response was incomplete. Refresh to check the same runs.');
      setItems(existing => [...new Map([...(before ? existing : []), ...value.items].map(item => [item.id, item])).values()]);
      setCursor(value.nextCursor);
      if (!selectedRef.current) { setError(''); setStale(false); }
    } catch (failure) { if (!controller.signal.aborted && contextMatches(context)) showFailure(failure); }
    finally { if (listRequest.current === controller) setLoading(false); }
  }, [projectId, contextMatches, showFailure]);

  useEffect(() => {
    clearPrivate(); setDataScope(scope); setError('');
    return () => { listRequest.current?.abort(); detailRequest.current?.abort(); };
  }, [scope, clearPrivate]);
  useEffect(() => {
    if (connection.blocked) {
      listRequest.current?.abort(); detailRequest.current?.abort(); setLoading(false); setChecking(false);
      return undefined;
    }
    readList();
    if (selectedRef.current) readDetail(selectedRef.current);
    return () => { listRequest.current?.abort(); detailRequest.current?.abort(); };
  }, [connection.blocked, connection.epoch, scope, readList, readDetail]);
  useEffect(() => {
    if (connection.blocked || !selected || !activeStatuses.has(visibleDetail?.status)) return undefined;
    let stopped = false;
    let timer;
    const check = async () => {
      await readDetail(selected, true);
      if (!stopped) timer = setTimeout(check, 5000);
    };
    timer = setTimeout(check, 5000);
    return () => { stopped = true; clearTimeout(timer); };
  }, [connection.blocked, selected, visibleDetail?.status, readDetail]);
  useEffect(() => {
    setExpired(false);
    if (!observedId || !activeStatuses.has(observedStatus)) return undefined;
    const receivedAt = Date.now();
    const checkAge = () => { if (Date.now() - receivedAt >= staleAfterMs) setExpired(true); };
    const timer = setTimeout(checkAge, staleAfterMs);
    document.addEventListener('visibilitychange', checkAge);
    window.addEventListener('focus', checkAge);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', checkAge);
      window.removeEventListener('focus', checkAge);
    };
  }, [scope, observedId, observedAt, observedStatus, staleAfterMs]);

  const select = item => {
    if (connection.blocked) return;
    selectedRef.current = item.id; setSelected(item.id); setDetail(null); setError(''); setStale(false);
    readDetail(item.id);
  };
  const refresh = () => {
    if (connection.blocked) return;
    setError(''); readList();
    if (selectedRef.current) readDetail(selectedRef.current);
  };
  if (!projectId) return null;
  const timing = visibleDetail?.timing;
  const logs = visibleDetail?.logs;
  return <section aria-label="Run monitoring" className="rounded-xl border border-border bg-surface/50 p-5 space-y-4">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h3 className="text-lg font-semibold">Run monitoring</h3><p className="text-sm text-textMuted">Follow your server jobs and private R commands. Monitoring reads existing records and never submits work.</p></div>
      <button type="button" className="btn btn-secondary text-sm" disabled={connection.blocked || loading || checking} onClick={refresh}>Refresh monitoring</button>
    </div>
    <p className="text-xs text-textMuted">Selected server connection: {connection.blocked ? 'Disconnected or unconfirmed' : stale ? 'Service status could not be checked' : 'Connected'}{connection.target?.sshTunnel ? ' · SSH tunnel' : ''}.</p>
    {connection.blocked && <p role="status" className="rounded border border-amber-300 p-3 text-sm">The selected server connection is unavailable. Last confirmed observations remain visible; current computation status is unknown. Reconnect to check the same run. No work is resubmitted.</p>}
    {(stale || expired) && !connection.blocked && (visibleDetail || visibleItems.length > 0) && <p role="status" className="text-sm">{expired ? 'These active observations are no longer current.' : 'These observations could not be refreshed.'} The last confirmed server state and elapsed time remain visible.</p>}
    {error && scopeMatches && <p role="alert" className="text-sm text-danger">{error}</p>}
    <div className="grid gap-4 lg:grid-cols-[minmax(220px,1fr)_minmax(0,2fr)]">
      <div className="max-h-[600px] space-y-2 overflow-auto">
        <ul aria-label="Monitored runs" className="space-y-2">
        {visibleItems.map(item => <li key={item.id}><button type="button" aria-pressed={selected === item.id && scopeMatches} disabled={connection.blocked} onClick={() => select(item)} className={`w-full rounded border p-3 text-left disabled:opacity-70 ${selected === item.id && scopeMatches ? 'border-primary bg-primary/5' : 'border-border'}`}>
          <span className="block text-sm font-medium break-words">{label(item)}</span>
          <span className="block text-xs text-textMuted">{item.kind === 'r-console' ? 'Private R command' : 'Analysis job'} · {stateLabels[item.status] || 'Unconfirmed'}</span>
          <span className="block text-xs text-textMuted">{date(item.timestamps?.createdAt)}</span>
          <span className="block break-all text-xs">{item.id}</span>
        </button></li>)}
        </ul>
        {loading && <p role="status" className="text-sm">Loading run observations…</p>}
        {!loading && !visibleItems.length && <p className="text-sm text-textMuted">No jobs or private R commands are available for your account in this project.</p>}
        {scopeMatches && cursor && <button type="button" className="btn btn-secondary text-xs" disabled={connection.blocked || loading} onClick={() => readList(cursor)}>More monitored runs</button>}
      </div>
      <section aria-label="Selected run monitoring" className="min-w-0 space-y-3">
        {checking && !visibleDetail && <p role="status" className="text-sm">Checking the selected run…</p>}
        {visibleDetail && <>
          <h4 className="font-semibold">{lastConfirmed ? 'Last confirmed server state' : 'Server state'}: {stateLabels[visibleDetail.status] || 'Unconfirmed'}</h4>
          <p className="text-xs break-all">{label(visibleDetail)} · {visibleDetail.id}</p>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-xs">
            <dt>Last observed</dt><dd aria-label="Last run observation">{date(visibleDetail.checkedAt)}</dd>
            <dt>Queue elapsed</dt><dd>{duration(timing?.queueElapsedMs)}</dd>
            <dt>Run elapsed</dt><dd aria-label="Run elapsed time">{duration(timing?.runElapsedMs)}</dd>
            <dt>Total elapsed</dt><dd>{duration(timing?.totalElapsedMs)}</dd>
            <dt>Queued</dt><dd>{date(visibleDetail.timestamps?.createdAt)}</dd>
            <dt>Started</dt><dd>{date(visibleDetail.timestamps?.startedAt)}</dd>
            <dt>Finished</dt><dd>{date(visibleDetail.timestamps?.completedAt || visibleDetail.timestamps?.canceledAt)}</dd>
          </dl>
          <div className="rounded border border-border p-3 text-xs space-y-1">
            <p>{visibleDetail.progress?.state === 'complete' ? 'Run completed.' : 'Progress is not reported.'}</p>
            <p>Remaining time is unknown.</p>
            {visibleDetail.progress?.note && <p className="text-textMuted">{visibleDetail.progress.note}</p>}
            {activeStatuses.has(visibleDetail.status) && !lastConfirmed && <p className="text-textMuted">This selected record refreshes every five seconds while work is active.</p>}
          </div>
          <ExecutionTargetEvidence target={visibleDetail.target} />
          <ResourceObservation resources={visibleDetail.resources} lastConfirmed={lastConfirmed} />
          <WorkerObservation worker={visibleDetail.worker} />
          {visibleDetail.error?.message && <p className="rounded border border-danger/30 p-3 text-xs text-danger">{visibleDetail.error.message}</p>}
          <details className="text-xs"><summary className="cursor-pointer">Run notes{logs?.items?.length ? ` · ${Math.min(logs.items.length, 50)}` : ''}</summary>
            <div className="mt-2 max-h-64 space-y-2 overflow-auto">
              {(logs?.items || []).slice(0, 50).map((entry, index) => <div key={`${entry.ts || index}-${index}`} className="rounded border border-border p-2"><p className="text-textMuted">{date(entry.ts)} · {entry.level || 'info'}</p><p className="mt-1 whitespace-pre-wrap break-words">{entry.message}</p></div>)}
              {!logs?.items?.length && <p>No retained notes are available for this run.</p>}
            </div>
            {logs?.note && <p className="mt-2 text-textMuted">{logs.note}</p>}
            {(logs?.truncated || logs?.redacted) && <p className="mt-2 text-textMuted">This view is bounded; private or oversized details may have been omitted.</p>}
          </details>
          {(visibleDetail.execution || visibleDetail.kernel) && <details className="text-xs"><summary className="cursor-pointer">Execution identity</summary><dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1">
            {visibleDetail.execution && <><dt>Attempt</dt><dd>{visibleDetail.execution.attempt}</dd><dt>Dispatch</dt><dd className="break-all">{visibleDetail.execution.dispatchId}</dd></>}
            {visibleDetail.kernel && <><dt>Kernel</dt><dd className="break-all">{visibleDetail.kernel.id}</dd><dt>Generation</dt><dd className="break-all">{visibleDetail.kernel.generation}</dd><dt>Command order</dt><dd>{visibleDetail.kernel.order}</dd></>}
          </dl></details>}
        </>}
        {!visibleDetail && !checking && <p className="text-sm text-textMuted">Select your run to inspect its current server observations.</p>}
      </section>
    </div>
  </section>;
}
