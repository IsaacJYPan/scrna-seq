import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Microscope, Moon, Sun } from 'lucide-react';
import { readSnapshotPublicationView, readSnapshotPublicationDocument } from '../analyses/snapshotPublicationApi';

const RetainedSnapshotFindings = React.lazy(() => import('../analyses/RetainedSnapshotFindings'));
const SharedRevisionDiscussion = React.lazy(() => import('./SharedRevisionDiscussion'));

const messages = {
  loading: ['Checking this shared snapshot', 'Confirming your current account, workspace and exact shared snapshot.'],
  'wrong-workspace': ['Connect to the linked workspace', 'The connected workspace differs from the one in this link. Select the correct workspace yourself, then check again. This link does not switch connections or grant access.'],
  unreachable: ['The workspace could not be reached', 'Reconnect to the workspace that hosts this snapshot, then try again. Viewing retained findings does not require the producer’s compute session, but the workspace service must be reachable.'],
  denied: ['This shared snapshot is not available to this account', 'Check that you are signed in with the intended account. A project owner can review your access. The link does not grant project membership.'],
  unverified: ['This exact snapshot could not be confirmed', 'Keep the original link and check again. The page will not substitute another snapshot or a newer analysis version.'],
};

function matchesTarget(record, target, user, serviceId) {
  return !!record && !!target && !!user?.id && serviceId === target.serviceId && record.serviceId === target.serviceId
    && record.projectId === target.projectId && record.analysisId === target.analysisId && record.publicationId === target.publicationId
    && record.snapshotSha256 === target.snapshotSha256 && record.viewerUserId === Number(user.id);
}

function ExactTarget({ target, serviceId }) {
  return <details className="rounded border border-border bg-surface p-4 text-xs text-textMuted">
    <summary className="cursor-pointer">Linked workspace and exact snapshot</summary>
    <p className="mt-3">Use the same reachable workspace. A local address or an SSH tunnel address may only work on the computer where it was configured.</p>
    <dl className="mt-3 space-y-3">
      {[
        ['Linked workspace', target?.serviceId], ['Project', target?.projectId], ['Analysis', target?.analysisId],
        ['Publication', target?.publicationId], ['Snapshot SHA-256', target?.snapshotSha256],
      ].map(([label, value]) => <div key={label}><dt>{label}</dt><dd className="mt-1 break-all text-text">{value || 'Unconfirmed'}</dd></div>)}
      {serviceId && serviceId !== target?.serviceId && <div><dt>Connected workspace</dt><dd className="mt-1 break-all text-text">{serviceId}</dd></div>}
    </dl>
    <p className="mt-3">Connection settings and SSH trust must be configured explicitly. Opening this page does not establish a connection or start compute.</p>
  </details>;
}

function ServerSettings() {
  const [error, setError] = useState(''), mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const open = () => {
    setError('');
    const failed = () => { if (mounted.current) setError('Server settings could not be opened. Try the desktop connection menu.'); };
    try { Promise.resolve(window.desktopShell.openTargetSettings()).catch(failed); }
    catch { failed(); }
  };
  return <div className="space-y-2"><button type="button" className="btn btn-secondary text-sm" onClick={open}>Server settings</button>
    {error && <p role="status" className="text-sm text-textMuted">{error}</p>}
  </div>;
}

export default function SharedSnapshotLanding({ state, onRefresh, onReadFailure, onLogout, onOpenWorkspace, theme = 'light', setTheme,
  initialFindingId, onFindingSelection }) {
  const { target, user, record, available, serviceId, error, accessEpoch = 0 } = state;
  const verified = matchesTarget(record, target, user, serviceId);
  const status = state.status === 'ready' ? !available ? 'unreachable' : verified ? 'ready' : 'unverified' : state.status;
  const ready = status === 'ready', withdrawn = ready && record.policy.state === 'withdrawn';
  const snapshot = ready && !withdrawn ? record.package : null;
  const checkDiscussionAccess = useCallback(failure => {
    if (failure) onReadFailure?.(failure);
    else onRefresh?.();
  }, [onReadFailure, onRefresh]);
  const renderRevisionDiscussion = useCallback(attachment => <SharedRevisionDiscussion
    projectId={target.projectId} analysisId={target.analysisId} attachment={attachment}
    serviceId={target.serviceId} userId={user.id} available={ready && available} isActive={ready && !withdrawn}
    onCheckAccess={checkDiscussionAccess} accessEpoch={accessEpoch} />,
  [target, user, ready, withdrawn, available, checkDiscussionAccess, accessEpoch]);
  const message = messages[status] || messages.unverified;
  const name = user?.displayName || user?.name || user?.email || 'your account';

  return <main aria-label="Shared analysis snapshot" className="flex h-dvh min-h-0 min-w-0 flex-col bg-background text-text">
    <header className="shrink-0 border-b border-border bg-surface px-4 py-3 sm:px-8">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2"><Microscope size={22} className="shrink-0 text-primary" aria-hidden="true" />
          <div className="min-w-0"><p className="text-sm font-semibold">TraceOmics</p><p className="text-xs text-textMuted">Shared snapshot · Read only</p></div>
        </div>
        <button type="button" className="btn btn-secondary flex items-center gap-2 text-xs"
          aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'} onClick={() => setTheme?.(theme === 'dark' ? 'light' : 'dark')}>
          {theme === 'dark' ? <Sun size={16} aria-hidden="true" /> : <Moon size={16} aria-hidden="true" />}<span>Appearance</span>
        </button>
        <div className="flex w-full min-w-0 flex-wrap items-center justify-between gap-2 border-t border-border pt-2 text-xs text-textMuted">
          <p className="min-w-0 break-words">{user?.id ? `Signed in as ${name}` : status === 'loading' ? 'Checking account…' : 'Account not confirmed'}</p>
          <div className="flex flex-wrap gap-4"><button type="button" className="text-primary underline" onClick={onOpenWorkspace}>Open workspace</button>
            {user?.id && <button type="button" className="underline" onClick={onLogout}>Sign out</button>}</div>
        </div>
      </div>
    </header>
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-8"><div className="mx-auto max-w-5xl space-y-5 pb-8">
      <section aria-label="Current snapshot access" className="space-y-3 rounded border border-border bg-surface p-4">
        {ready ? <p className="text-sm text-textMuted">{withdrawn ? 'Viewing through this publication has ended.' : 'Viewing these retained findings does not start the producer’s compute session. Current project access is still required.'}</p>
          : <><h1 className="text-xl font-semibold">{message[0]}</h1><p role="status" className="text-sm text-textMuted">{message[1]}</p></>}
        {typeof error === 'string' && error && <p role="alert" className="whitespace-pre-wrap break-words text-sm text-danger">{error}</p>}
        <button type="button" className="btn btn-secondary text-sm" disabled={status === 'loading'} onClick={onRefresh}>
          {status === 'loading' ? 'Checking current access…' : ready ? 'Check current access' : 'Try again'}
        </button>
        {typeof window.desktopShell?.openTargetSettings === 'function' && <ServerSettings key={JSON.stringify([target, user?.id])} />}
      </section>

      {withdrawn && <section aria-label="Withdrawn shared snapshot" className="space-y-3 rounded border border-border bg-surface p-4 sm:p-6">
        <h1 className="text-xl font-semibold">Snapshot withdrawn</h1>
        <p className="text-sm text-textMuted">This exact publication no longer provides findings or supporting source. Its identity and original publication remain recorded.</p>
        <p className="break-words text-sm">Published by {record.publisherLabel} · <time dateTime={record.publishedAt}>{new Date(record.publishedAt).toLocaleString()}</time></p>
        <p className="text-xs text-textMuted">Withdrawn <time dateTime={record.policy.withdrawnAt}>{new Date(record.policy.withdrawnAt).toLocaleString()}</time>. Checking the original publication does not reactivate it.</p>
      </section>}

      {snapshot && <>
        <section aria-label="Saved research question" className="space-y-4">
          <div><p className="mb-1 text-xs font-medium uppercase tracking-wide text-textMuted">Saved analysis {snapshot.analysis.version}</p>
            <h1 className="whitespace-pre-wrap break-words text-2xl font-semibold">{snapshot.analysis.name}</h1></div>
          <div><h2 className="text-sm font-semibold">Research question</h2><p className="mt-1 whitespace-pre-wrap break-words text-sm text-textMuted">{snapshot.analysis.description || 'No research question was supplied in this saved analysis.'}</p></div>
          <p className="break-words text-sm text-textMuted">Published by {record.publisherLabel} · <time dateTime={record.publishedAt}>{new Date(record.publishedAt).toLocaleString()}</time></p>
          <p className="text-xs text-textMuted">These are the selected findings from this saved version. Reproduction has not been checked. Original data and compute access are governed separately.</p>
        </section>
        <React.Suspense fallback={<p role="status" className="text-sm text-textMuted">Opening retained findings…</p>}>
          <RetainedSnapshotFindings projectId={target.projectId} analysisId={target.analysisId} serviceId={target.serviceId} userId={user.id}
            resourceId={target.publicationId} audience="project-publication" snapshotSha256={target.snapshotSha256}
            snapshot={snapshot} availability={record.availability} available={available} isActive={ready}
            initialFindingId={initialFindingId} onFindingSelection={onFindingSelection}
            readView={readSnapshotPublicationView} readDocument={readSnapshotPublicationDocument}
            onDenied={onReadFailure} onUnavailable={onReadFailure} renderRevisionDiscussion={renderRevisionDiscussion} />
        </React.Suspense>
      </>}
      <ExactTarget target={target} serviceId={serviceId} />
    </div></div>
  </main>;
}
