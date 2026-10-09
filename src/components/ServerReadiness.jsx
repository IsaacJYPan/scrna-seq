import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { RefreshCw, Server, X } from 'lucide-react';
import { READINESS_REMEDIATIONS, readRuntimeReadiness, readinessFailureMessage } from '../runtime/runtimeReadiness';

const LABELS = {
  ready: 'Available when checked', unknown: 'Not verified', unreachable: 'Cannot reach service',
  'authentication-failed': 'Service authentication failed', incompatible: 'Update required',
  'missing-packages': 'Required packages missing', 'not-configured': 'Setup required', unavailable: 'Unavailable when checked',
  missing: 'Storage unavailable', 'not-writable': 'Storage not writable', 'insufficient-resources': 'Insufficient resources', unsupported: 'Not supported',
};
const ACCESS = { allowed: 'Execution access allowed', 'access-required': 'Execution access required', 'access-revoked': 'Execution access revoked', 'demo-disabled': 'Unavailable in the demonstration', unknown: 'Execution access not verified' };
const SCOPE = { guided: 'Guided analysis', workers: 'Queued analysis', 'private-r': 'Custom R', 'private-r-work': 'Custom R temporary storage', 'private-r-storage': 'Custom R result storage', 'durable-storage': 'Saved project storage', 'private-storage': 'Private input storage' };
const date = value => value ? new Date(value).toLocaleString() : 'Not recorded';
function bytes(value) {
  if (value == null) return 'Not verified';
  if (value === 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const power = Math.min(4, Math.floor(Math.log(value) / Math.log(1024)));
  return `${Number((value / 1024 ** power).toFixed(1))} ${units[power]}`;
}
const support = value => value === true ? 'Supported' : value === false ? 'Not supported' : 'Not verified';
const limit = (value, suffix) => value == null ? 'Not verified' : `${value} ${suffix}`;

function StatusRow({ title, state, children }) {
  return <div className="rounded-lg border border-border bg-background p-3">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <h4 className="font-medium text-text">{title}</h4>
      <span className={`text-xs ${state === 'ready' ? 'text-success' : state === 'unknown' || state === 'unsupported' ? 'text-textMuted' : 'text-amber-800 dark:text-amber-200'}`}>{LABELS[state] || LABELS.unknown}</span>
    </div>
    {children && <div className="mt-2 text-xs leading-relaxed text-textMuted">{children}</div>}
  </div>;
}
function StorageRow({ title, value }) {
  return <StatusRow title={title} state={value.state}>
    <p>Writable: {value.writable === true ? 'Verified' : value.writable === false ? 'No' : 'Not verified'} · Observed free: {bytes(value.freeBytes)}</p>
    <p>Required free-space reserve: {bytes(value.minFreeBytes)}{value.reservedBytes != null && ` · Already reserved: ${bytes(value.reservedBytes)}`}</p>
  </StatusRow>;
}
function Limits({ title, value, kernel = false }) {
  return <div className="rounded-lg border border-border bg-background p-3">
    <h4 className="font-medium text-text">{title}</h4>
    {value ? <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
      <dt className="text-textMuted">Memory</dt><dd>{bytes(value.memoryBytes)}</dd>
      <dt className="text-textMuted">CPU ceiling</dt><dd>{limit(value.cpuLimit, 'CPUs')}</dd>
      <dt className="text-textMuted">{kernel ? 'R command duration' : 'Run duration'}</dt><dd>{limit(kernel ? value.executionSeconds : value.timeoutSeconds, 'seconds')}</dd>
      {kernel ? <>
        <dt className="text-textMuted">Idle session timeout</dt><dd>{limit(value.idleTimeoutSeconds, 'seconds')}</dd>
        <dt className="text-textMuted">Session lifetime</dt><dd>{limit(value.maxLifetimeSeconds, 'seconds')}</dd>
        <dt className="text-textMuted">Sessions per researcher</dt><dd>{limit(value.maxPerOwner, 'sessions')}</dd>
        <dt className="text-textMuted">Server session ceiling</dt><dd>{limit(value.maxActive, 'sessions')}</dd>
      </> : <><dt className="text-textMuted">Concurrent run ceiling</dt><dd>{limit(value.maxConcurrent, 'runs')}</dd></>}
    </dl> : <p className="mt-2 text-xs text-textMuted">Resource limits have not been verified.</p>}
  </div>;
}

export default function ServerReadiness({ projectId, userId, target, onClose, api = window.electronAPI }) {
  const [report, setReport] = useState(null);
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(false);
  const [stale, setStale] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const panel = useRef(null), closeButton = useRef(null), request = useRef(0);
  const close = useRef(onClose); close.current = onClose;
  const titleId = useId();
  const endpoint = target?.endpoint || window.location.origin;
  const targetKey = `${target?.id || ''}:${endpoint}:${target?.status || ''}:${target?.sshTunnel?.state || ''}`;
  const sshTarget = Boolean(target?.sshTunnel || target?.kind === 'ssh');
  const disconnected = target?.status === 'disconnected' || (target?.sshTunnel && target.sshTunnel.state !== 'connected');
  const checkAgain = useCallback(() => setRefresh(value => value + 1), []);

  useEffect(() => {
    const previous = document.activeElement?.closest('details')?.querySelector('summary') || document.activeElement;
    closeButton.current?.focus();
    const escape = event => { if (event.key === 'Escape') { event.preventDefault(); close.current?.(); } };
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('keydown', escape); if (previous?.isConnected) previous.focus?.(); };
  }, []);

  useEffect(() => {
    const current = ++request.current;
    const controller = new AbortController();
    setReport(null); setError(''); setStale(false);
    if (!userId) {
      setChecking(false); setError('Sign in to the selected server to check readiness.');
    } else if (disconnected) {
      setChecking(false);
      setError(sshTarget
        ? 'The SSH connection is disconnected. Reconnect through server settings, then check this server again.'
        : 'The selected server is disconnected. Reconnect through server settings, then check this server again.');
    } else {
      setChecking(true);
      readRuntimeReadiness(api, projectId, { signal: controller.signal }).then(value => {
        if (request.current === current) setReport(value);
      }).catch(failure => {
        if (request.current === current && failure?.name !== 'AbortError') setError(readinessFailureMessage(failure));
      }).finally(() => { if (request.current === current) setChecking(false); });
    }
    return () => { request.current += 1; controller.abort(); };
  }, [api, projectId, userId, targetKey, disconnected, sshTarget, refresh]);

  useEffect(() => {
    if (!report) return undefined;
    const remaining = report.checkedAt && report.staleAfterMs != null ? Date.parse(report.checkedAt) + report.staleAfterMs - Date.now() : 0;
    setStale(remaining <= 0);
    if (remaining <= 0) return undefined;
    const timer = setTimeout(() => setStale(true), Math.min(remaining, 60_000));
    return () => clearTimeout(timer);
  }, [report]);

  const trapFocus = event => {
    if (event.key !== 'Tab') return;
    const controls = [...panel.current.querySelectorAll('button:not([disabled]), summary, a[href], [tabindex="0"]')];
    if (!controls.length) { event.preventDefault(); return; }
    if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1).focus(); }
    else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0].focus(); }
  };
  const privateR = report?.privateR;
  const visibleIssues = report?.issues.filter((issue, index, all) => all.findIndex(other => other.code === issue.code && other.scope === issue.scope && other.package === issue.package) === index);
  return <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-3 sm:p-6" onClick={event => { if (event.target === event.currentTarget) close.current?.(); }}>
    <section ref={panel} role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={trapFocus} className="flex max-h-[calc(100dvh-1.5rem)] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-border bg-surface text-text shadow-2xl sm:max-h-[90vh]">
      <header className="flex shrink-0 items-start justify-between gap-3 border-b border-border px-4 py-4 sm:px-6">
        <div className="min-w-0">
          <h2 id={titleId} className="flex items-center gap-2 text-lg font-bold"><Server size={20} className="shrink-0 text-primary" aria-hidden="true" />Server readiness</h2>
          <p className="mt-1 break-words text-sm text-textMuted">{target?.name || endpoint}</p>
          {target?.name && <p className="mt-1 break-all text-xs text-textMuted">{endpoint}</p>}
        </div>
        <button ref={closeButton} type="button" aria-label="Close server readiness" onClick={() => close.current?.()} className="btn btn-secondary shrink-0 p-2"><X size={18} aria-hidden="true" /></button>
      </header>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4 text-sm sm:px-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p role="status" className="text-xs text-textMuted">{checking ? 'Checking server readiness…' : report ? `Checked ${date(report.checkedAt)}` : 'Readiness has not been confirmed.'}</p>
          <button type="button" className="btn btn-secondary inline-flex items-center gap-2 text-xs" disabled={checking || disconnected} onClick={checkAgain}><RefreshCw size={14} className={checking ? 'animate-spin' : ''} aria-hidden="true" />Check again</button>
        </div>
        <p className="text-xs leading-relaxed text-textMuted">Checks describe the selected server. They do not start an analysis or reserve resources. Work continues to use this server.</p>
        {error && <p role="alert" className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-200">{error}</p>}
        {report && <>
          {stale && <p role="status" className="rounded-lg border border-border bg-background p-3 text-xs text-textMuted">This observation is no longer current. Check again before planning heavy work.</p>}
          <section aria-label="Analysis capabilities" className="space-y-3">
            <h3 className="font-semibold">Analysis capabilities</h3>
            <StatusRow title="Server compatibility" state={report.service.state}><p>{report.service.state === 'ready' ? 'This server supports the current application.' : 'Server compatibility has not been confirmed.'}{report.service.supportedTarget && ` Guided R target: ${report.service.supportedTarget}.`}</p></StatusRow>
            <div className="grid gap-3 sm:grid-cols-2">
              <StatusRow title="Guided R analysis" state={report.guided.state}><p>R version: {report.guided.rVersion || 'Not verified'}</p>
                <details className="mt-2"><summary className="cursor-pointer">Required and optional packages</summary><ul className="mt-2 space-y-1">{report.guided.packages.length ? report.guided.packages.map(pkg => <li key={pkg.name}>{pkg.name}: {pkg.state === 'available' ? 'Available when checked' : pkg.state === 'missing' ? 'Missing' : 'Not verified'}</li>) : <li>Package availability has not been verified.</li>}</ul></details>
              </StatusRow>
              <StatusRow title="Queued analysis worker" state={report.workers.state}><p>{report.workers.mode === 'standalone' ? 'Durable worker' : report.workers.mode === 'embedded' ? 'Local development worker' : 'Worker mode not verified'} · Updated: {date(report.workers.updatedAt)}</p><p>Pathway enrichment: {support(report.workers.capabilities.pathwayEnrichment)} · CellChat: {support(report.workers.capabilities.cellChat)}</p></StatusRow>
              <StatusRow title="Custom R runtime" state={privateR.state}><p>{ACCESS[privateR.accessState]}</p><p>Interactive console: {support(privateR.capabilities.persistentKernel)} · Interrupt: {support(privateR.capabilities.persistentKernelInterrupt)} · Save R outputs: {support(privateR.capabilities.persistentKernelPublications)}</p></StatusRow>
              <StatusRow title="Shared cluster scheduler" state={report.scheduler.state}><p>Direct isolated workers are supported. Submission to a shared cluster scheduler has not been implemented.</p></StatusRow>
            </div>
          </section>
          <section aria-label="Pinned R environment" className="space-y-3">
            <h3 className="font-semibold">Pinned R environment</h3>
            {privateR.environment ? <div className="rounded-lg border border-border bg-background p-3 text-xs text-textMuted">
              <p className="font-medium text-text">R {privateR.environment.rVersion} · Bioconductor {privateR.environment.bioconductor}</p>
              <p className="mt-2">Runtime availability is shown above. This record identifies the configured exact environment; existing runs may require a different recorded version.</p>
              <details className="mt-2"><summary className="cursor-pointer">Exact environment identity</summary><div className="mt-2 space-y-2 break-all"><p>Environment: <code>{privateR.environment.id}</code></p><p>Manifest SHA-256: <code>{privateR.environment.manifestSha256}</code></p><p>Pinned image: <code>{privateR.environment.imageDigest}</code></p></div></details>
            </div> : <p className="text-xs text-textMuted">An exact custom R environment has not been verified.</p>}
          </section>
          <section aria-label="Configured resource limits" className="space-y-3">
            <h3 className="font-semibold">Configured resource limits</h3>
            <p className="text-xs text-textMuted">These limits are ceilings, not available capacity or proof that a dataset will fit. Execution checks access and admission again.</p>
            <div className="grid gap-3 sm:grid-cols-2"><Limits title="Private R session" value={privateR.resources.kernel} kernel /><Limits title="Queued custom R run" value={privateR.resources.oneShot} /></div>
          </section>
          <section aria-label="Storage readiness" className="space-y-3">
            <h3 className="font-semibold">Storage readiness</h3>
            <div className="grid gap-3 sm:grid-cols-2"><StorageRow title="Saved project storage" value={report.storage.durable} /><StorageRow title="Private input storage" value={report.storage.private} /><StorageRow title="Custom R temporary storage" value={privateR.storage.work} /><StorageRow title="Custom R result storage" value={privateR.storage.durable} /></div>
            <p className="text-xs text-textMuted">Free space is an observation at check time. Other work can consume it before an analysis starts.</p>
          </section>
          {visibleIssues.length > 0 && <section aria-label="Readiness actions" className="space-y-3"><h3 className="font-semibold">Readiness actions</h3><ul className="space-y-3">{visibleIssues.map(issue => <li key={`${issue.code}:${issue.scope}:${issue.package || ''}`} className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3"><p className="text-xs font-medium">{SCOPE[issue.scope]}{issue.package && ` · ${issue.package}`}</p><p className="mt-1 text-xs leading-relaxed text-textMuted">{READINESS_REMEDIATIONS[issue.code]}</p></li>)}</ul></section>}
        </>}
      </div>
    </section>
  </div>;
}
