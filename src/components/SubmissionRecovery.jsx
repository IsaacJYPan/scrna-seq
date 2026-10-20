import React, { useState } from 'react';
import useSubmissionRecovery from '../executions/useSubmissionRecovery';
import { checkSubmissionReceipt, forgetSubmission, selectRecoveredRun } from '../executions/submissionRecovery';

export function SubmissionRecoveryNotice({ userId, projectId, onOpen }) {
  const recovery = useSubmissionRecovery(userId, { initialize: true });
  const records = recovery.records.filter(record => record.projectId === projectId);
  if (!records.length) return null;
  const unresolved = records.filter(record => record.state !== 'accepted' || !record.confirmed).length;
  if (!unresolved) return null;
  return <section aria-label="Submission recovery" className="shrink-0 border-b border-border bg-surface px-4 py-2 text-xs text-text">
    <p>{recovery.checking ? 'Checking saved submissions…' : `${unresolved} saved submission${unresolved === 1 ? '' : 's'} need a receipt check before more work is submitted.`}</p>
    <button type="button" className="mt-1 font-bold underline" onClick={onOpen}>Open recovered runs</button>
  </section>;
}

export default function SubmissionRecovery({ projectId, userId }) {
  const recovery = useSubmissionRecovery(userId);
  const [checking, setChecking] = useState(null);
  const records = recovery.records.filter(record => record.projectId === projectId);
  if (!records.length) return null;
  const check = async record => {
    setChecking(record.requestId);
    try { await checkSubmissionReceipt(record.requestId); } finally { setChecking(null); }
  };
  return <section aria-label="Saved submissions" className="rounded-xl border border-border bg-surface/50 p-5 space-y-3">
    <h3 className="text-lg font-semibold">Saved submissions</h3>
    <p className="text-sm text-textMuted">Small submission identifiers are retained on this computer. Receipt checks read server records and never repeat a job or recipe step.</p>
    {recovery.error && <p role="alert" className="text-sm text-danger">{recovery.error}</p>}
    <ul className="space-y-3">{[...records].reverse().map(record => <li key={record.requestId}><section aria-label={`Submission ${record.requestId}`} className="rounded border border-border p-3 space-y-2">
      <p className="text-sm font-medium">{record.kind === 'workflow' ? 'Recipe step submission' : 'Analysis job submission'} · {record.state === 'accepted' && record.confirmed ? 'Accepted' : 'Acceptance not confirmed'}</p>
      <p className="break-all text-xs">Request {record.requestId}{record.jobId && <> · Run {record.jobId}</>}</p>
      {record.state === 'missing' && <p className="text-xs text-textMuted">No matching receipt was found. A missing receipt does not prove that no work is running. Inspect existing runs before deciding to make another submission.</p>}
      <div className="flex flex-wrap gap-3">
        <button type="button" className="btn btn-secondary text-xs" disabled={recovery.connection.blocked || !!checking || recovery.checking} onClick={() => void check(record)}>Check receipt</button>
        {record.state === 'accepted' && record.confirmed && <button type="button" className="btn btn-secondary text-xs" disabled={recovery.connection.blocked} onClick={() => selectRecoveredRun(projectId, record.jobId, { requestId: record.requestId })}>Open exact run</button>}
        {(record.state !== 'accepted' || !record.confirmed) && <button type="button" className="text-xs underline" disabled={!!checking || recovery.checking} onClick={() => {
          if (window.confirm('Forget this unconfirmed request? Work may already be running on the server. Inspect existing runs first. Forgetting this identifier allows a new submission and could create duplicate work; nothing is resubmitted automatically.')) forgetSubmission(record.requestId);
        }}>Forget unconfirmed request</button>}
      </div>
    </section></li>)}</ul>
  </section>;
}
