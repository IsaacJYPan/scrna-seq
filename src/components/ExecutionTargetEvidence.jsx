import React from 'react';

const runtimeLabels = { 'guided-r': 'Guided R', 'sandbox-r': 'Isolated R job', 'private-r': 'Private R session', service: 'Analysis service' };

export default function ExecutionTargetEvidence({ target }) {
  if (!target) return null;
  const candidateId = target.serviceId || (target.kind === 'service' ? target.id : null);
  const serverId = /^svc_[a-f0-9]{32}$/.test(candidateId || '') ? candidateId : null;
  const serverLabel = target.serviceLabel || target.label;
  return <div aria-label="Recorded execution target" className="rounded border border-border p-3 text-xs space-y-2">
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1">
      <dt>Execution server</dt><dd className="break-all">{serverId ? `${serverLabel || 'Analysis server'} · ${serverId}` : 'Not retained'}</dd>
      <dt>Executor</dt><dd className="break-all">{runtimeLabels[target.runtimeKind] || 'Not retained'}{target.generation ? ` · ${target.generation}` : ''}</dd>
      {target.runtimeGeneration && <><dt>Runtime generation</dt><dd className="break-all">{target.runtimeGeneration}</dd></>}
    </dl>
    {target.note && <p className="text-textMuted">{target.note}</p>}
    {serverId && <p className="text-textMuted">Retained by the service when execution was dispatched. Current connection settings do not replace this record.</p>}
  </div>;
}
