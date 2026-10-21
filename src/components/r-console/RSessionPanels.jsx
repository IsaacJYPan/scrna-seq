import React from 'react';
import { journalLimit, unresolvedSubmission } from './usePrivateRSession';

const date = (value) => (value ? new Date(value).toLocaleString() : 'Unavailable');
export const commandOutcome = (entry) =>
  entry?.interrupted || entry?.result?.interrupted ? 'interrupted' : entry.status;

export function RequestRecovery({
  retainedRequests,
  blocked,
  inspecting,
  controlBusy,
  busy,
  refresh,
  setForgetRequest,
  forgetRequest,
  forget,
}) {
  return (
    <section
      aria-label="Private R submitted requests"
      className="rounded border border-border p-3 space-y-3"
    >
      <h3 className="text-sm font-medium">Submitted R requests</h3>
      <p className="text-xs text-textMuted">
        These saved identifiers resolve the original request after reopening or losing a reply.
        Inspection never submits R work.
      </p>
      {retainedRequests.map((record) => (
        <section
          key={record.requestId}
          aria-label={`Private R request ${record.requestId}`}
          className="text-xs space-y-2"
        >
          <div className="break-all">
            {record.kind} ·{' '}
            {record.confirmed && record.state === 'accepted'
              ? record.status
              : record.state === 'missing'
                ? 'receipt not found · still unconfirmed'
                : 'acceptance unconfirmed'}{' '}
            · request {record.requestId}
          </div>
          {record.kernelId && (
            <div className="break-all">
              Kernel {record.kernelId} · generation {record.generation || 'Unconfirmed'}
              {record.executionId ? ` · command ${record.order} · ${record.executionId}` : ''}
              {record.publicationId ? ` · publication ${record.publicationId}` : ''}
            </div>
          )}
          <button
            className="btn btn-secondary text-xs"
            disabled={blocked || inspecting || controlBusy}
            onClick={() => refresh({ requestId: record.requestId })}
          >
            Check exact {record.kind} receipt
          </button>
          {unresolvedSubmission(record) && (
            <button
              className="btn btn-secondary text-xs ml-2"
              disabled={blocked || busy || controlBusy || inspecting}
              onClick={() => setForgetRequest(record.requestId)}
            >
              Forget unconfirmed identifier
            </button>
          )}
        </section>
      ))}
      {retainedRequests.some(unresolvedSubmission) && (
        <p role="status" className="text-xs">
          A request is still unconfirmed or unfinished. Check its receipt before running or saving
          again; a ready session or a newer command does not confirm earlier work.
        </p>
      )}
      {forgetRequest && (
        <div className="text-xs space-y-2">
          <p>
            This request may already be running or may arrive later. Forgetting its identifier
            removes duplicate protection for it. Check its receipt or explicitly stop the known
            session before starting more work.
          </p>
          <button
            className="btn btn-secondary text-xs"
            disabled={blocked || busy || controlBusy}
            onClick={forget}
          >
            Forget identifier and accept this risk
          </button>
          <button className="btn btn-secondary text-xs ml-2" onClick={() => setForgetRequest(null)}>
            Keep request identifier
          </button>
        </div>
      )}
    </section>
  );
}

export function SessionIdentity({ session }) {
  return (
    <div
      aria-label="R session identity"
      className="rounded border border-border p-3 text-xs space-y-2"
    >
      <div className="font-medium">
        Session {session.status} · unsaved memory {session.memoryState}
      </div>
      <div>
        R {session.environment.rVersion} · {session.resources.cpuLimit || '?'} CPUs ·{' '}
        {session.resources.memoryBytes
          ? Math.round(session.resources.memoryBytes / 1024 ** 2)
          : '?'}{' '}
        MiB · idle timeout {session.resources.idleTimeoutSeconds || '?'} seconds
      </div>
      <details>
        <summary className="cursor-pointer">Session reproducibility details</summary>
        <div className="space-y-1 pt-2">
          <div className="break-all">
            Kernel {session.id} · generation {session.generation || 'Unconfirmed'}
          </div>
          <div>
            Target {session.target?.id || 'Unconfirmed'} · starts {date(session.startedAt)} ·
            expires {date(session.expiresAt)}
          </div>
          <div className="break-all">Environment SHA-256 {session.environment.manifestSha256}</div>
          {session.inputs.map((input) => (
            <div key={input.id}>
              {input.role}: {input.name} ·{' '}
              <span className="break-all font-mono">{input.checksumSha256}</span>
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}

export function CommandJournal({
  journal,
  openEntry,
  blocked,
  busy,
  inspecting,
  journalCursor,
  controlBusy,
  loadOlder,
}) {
  return (
    <div aria-label="R command journal" className="space-y-2">
      <h3 className="text-sm font-medium">Command history</h3>
      <div className="flex flex-wrap gap-2">
        {journal.map((item) => (
          <button
            className="btn btn-secondary text-xs"
            key={item.id}
            onClick={() => openEntry(item)}
            disabled={blocked || busy || inspecting}
          >
            Command {item.order} · {commandOutcome(item)}
          </button>
        ))}
      </div>
      {journalCursor && (
        <button
          className="btn btn-secondary text-xs"
          disabled={blocked || busy || controlBusy || inspecting}
          onClick={loadOlder}
        >
          Load older R commands
        </button>
      )}
      {journal.length >= journalLimit && (
        <p className="text-xs text-textMuted">
          Showing up to {journalLimit} commands from this part of the journal. Refresh to return to
          the latest commands.
        </p>
      )}
    </div>
  );
}

export function PreviousSession({
  previousEvidence,
  session,
  blocked,
  busy,
  controlBusy,
  inspectPrevious,
  openEntry,
  inspectSaved,
}) {
  return (
    <section
      aria-label="Previous R session evidence"
      className="rounded border border-border p-3 space-y-2"
    >
      <h3 className="text-sm font-medium">Previous session</h3>
      <p className="text-xs break-all">
        Previous kernel {previousEvidence?.kernelId || session.restartedFromKernelId} → current
        kernel {session.id}
      </p>
      <button
        className="btn btn-secondary text-xs"
        disabled={blocked || busy || controlBusy}
        onClick={inspectPrevious}
      >
        Inspect previous session
      </button>
      {previousEvidence?.session && (
        <p className="text-xs break-all">
          Previous generation {previousEvidence.session.generation} ·{' '}
          {previousEvidence.session.status} · unsaved memory {previousEvidence.session.memoryState}
        </p>
      )}
      {previousEvidence?.journal?.map((item) => (
        <button
          key={item.id}
          className="btn btn-secondary text-xs"
          disabled={blocked || busy || controlBusy}
          onClick={() => openEntry(item, previousEvidence.kernelId)}
        >
          Previous command {item.order} · {commandOutcome(item)}
        </button>
      ))}
      {previousEvidence?.publications?.map((publication) => (
        <div key={publication.id} className="text-xs">
          {publication.name} · {publication.status}
          {publication.version && (
            <button
              className="btn btn-secondary text-xs ml-2"
              disabled={blocked || busy || controlBusy}
              onClick={() => inspectSaved(publication.version)}
            >
              Inspect previous {publication.version.name} · v
              {publication.version.versionNumber || 1}
            </button>
          )}
        </div>
      ))}
    </section>
  );
}
