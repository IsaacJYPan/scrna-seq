import React, { useEffect, useRef } from 'react';
import useSnapshotPublications from './useSnapshotPublications';
import { readSnapshotPublicationView, readSnapshotPublicationDocument } from './snapshotPublicationApi';

const RetainedSnapshotFindings = React.lazy(() => import('./RetainedSnapshotFindings'));
const time = value => new Date(value).toLocaleString();
function ExactSnapshot({ value }) {
  return <details className="text-xs text-textMuted"><summary className="cursor-pointer">Exact snapshot</summary>
    <dl className="mt-2 space-y-2 break-all"><div><dt>Snapshot SHA-256</dt><dd>{value.snapshotSha256}</dd></div>
      {value.publicationId && <div><dt>Publication</dt><dd>{value.publicationId}</dd></div>}
      <div><dt>Original private preparation</dt><dd>{value.preparationId}</dd></div></dl>
  </details>;
}
function OriginalAction({ state, available }) {
  const { original, lastCheck, busy, canPublish, checkRequest, retry, releaseChecked } = state;
  if (!original || lastCheck === 'confirmed') return null;
  return <section aria-label="Original sharing request" className="mb-6 space-y-3 rounded border border-border bg-surface p-4">
    <h3 className="text-sm font-semibold">{original.action === 'publish' ? 'Publication completion unconfirmed' : 'Withdrawal completion unconfirmed'}</h3>
    <p className="text-sm text-textMuted">Keep this original request and check its outcome. Checking does not submit another sharing action.</p>
    {lastCheck === 'missing' && <p className="text-sm text-textMuted">This original request is not recorded yet. Completion is still unconfirmed. A retry uses the same request and exact selection.</p>}
    <div className="flex flex-wrap gap-3"><button type="button" className="btn btn-secondary text-sm" disabled={busy || !available} onClick={() => void checkRequest()}>Check original sharing request</button>
      {lastCheck === 'missing' && <button type="button" className="btn btn-secondary text-sm" disabled={busy || !available || original.action === 'publish' && !canPublish} onClick={() => void retry()}>{original.action === 'publish' ? 'Retry original publication' : 'Retry original withdrawal'}</button>}</div>
    <details className="text-xs text-textMuted"><summary className="cursor-pointer">Original request identity</summary><dl className="mt-2 space-y-2 break-all"><div><dt>Request</dt><dd>{original.body.requestId}</dd></div><div><dt>Request SHA-256</dt><dd>{original.requestSha256}</dd></div></dl></details>
    {lastCheck === 'missing' && <div className="border-t border-border pt-3 text-xs text-textMuted"><p>Clearing this panel does not cancel the original action. Accepted actions remain in your sharing activity.</p><button type="button" className="mt-2 underline" disabled={busy} onClick={releaseChecked}>Clear checked request from this panel</button></div>}
  </section>;
}

export default function AnalysisSnapshotPublications(props) {
  const state = useSnapshotPublications(props), heading = useRef(null);
  const { mode, navigate, selected, acknowledgement, receipt, existing, busy, error, notice, phase } = state;
  useEffect(() => { if (props.isActive) heading.current?.focus({ preventScroll: true }); }, [mode, props.isActive]);
  const pending = !!state.original && state.lastCheck !== 'confirmed';
  const refresh = () => { void state.load(); if (mode === 'activity') void state.loadActivity(); };
  const showActivity = () => { navigate('activity'); void state.loadActivity(); };
  return <section aria-label="Published analysis snapshots" className="flex h-full min-h-0 min-w-0 flex-col bg-background text-text">
    <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3 sm:px-8">
      <div className="min-w-0"><button type="button" className="text-xs text-textMuted underline" onClick={props.onBack}>{props.returnToPreparation ? 'Back to private preparation' : 'Back to analysis'}</button>
        <h2 ref={heading} tabIndex={-1} className="mt-1 text-lg font-semibold focus-visible:outline-none">Published snapshots</h2></div>
      <div className="flex flex-wrap gap-3 text-xs"><button type="button" className="text-primary underline" onClick={() => navigate('list')}>Browse published snapshots</button>
        <button type="button" className="text-primary underline" onClick={showActivity}>Your sharing activity</button>
        <button type="button" className="text-primary underline" disabled={!props.available || state.loading || state.activityLoading} onClick={refresh}>Refresh sharing access</button></div>
    </header>
    <div className="min-h-0 flex-1 overflow-auto px-4 py-5 sm:px-8"><div className="mx-auto max-w-5xl space-y-5 pb-8">
      {!props.available && <p role="status" className="text-sm text-textMuted">Reconnect to the same workspace. The original sharing request is kept in this panel.</p>}
      {error && <p role="alert" className="whitespace-pre-wrap break-words text-sm text-danger">{error}</p>}
      {notice && <p role="status" className="text-sm text-textMuted">{notice}</p>}{busy && <p role="status" className="text-sm text-textMuted">{phase}</p>}
      <OriginalAction state={state} available={props.available} />

      {mode === 'list' && <section aria-label="Project published snapshots" className="space-y-4">
        <h3 className="font-semibold">Findings shared with this project</h3><p className="text-sm text-textMuted">Open selected saved findings without starting the producer's analysis session. The workspace service must be reachable.</p>
        {state.loading && <p role="status" className="text-sm text-textMuted">Finding published snapshots…</p>}
        {state.loaded && !state.items.length && <p className="text-sm text-textMuted">No snapshots have been published in this analysis. A researcher can prepare selected findings, review them, then publish them here.</p>}
        <ul className="space-y-3">{state.items.map(item => <li key={item.publicationId} className="min-w-0 rounded border border-border bg-surface p-4">
          <p className="break-words text-sm font-semibold">{item.selection ? `${item.selection.analysisName} · Saved analysis ${item.selection.analysisVersion}` : 'Withdrawn snapshot'}</p>
          <p className="mt-1 break-words text-xs text-textMuted">Published by {item.publisherLabel} · {time(item.publishedAt)}</p>
          <p className="mt-2 text-xs">{item.selection ? `${item.selection.resultCount} findings · ${item.selection.documentCount} supporting documents` : 'Viewing through this publication has ended.'}</p>
          <button type="button" className="mt-3 text-sm text-primary underline" disabled={!props.available} onClick={() => void state.open(item)}>Open published snapshot</button>
        </li>)}</ul>
        {state.cursor && <button type="button" className="btn btn-secondary text-sm" disabled={state.loading || !props.available} onClick={() => void state.load(state.cursor)}>Load older published snapshots</button>}
      </section>}

      {mode === 'confirm-publish' && <section aria-label="Confirm exact snapshot publication" className="space-y-4 rounded border border-border bg-surface p-4 sm:p-6">
        <h3 className="text-lg font-semibold">Share these reviewed findings with the project</h3>
        {!acknowledgement ? <><p className="text-sm text-textMuted">Check the acknowledged private preparation before publishing. It will not be replaced with a newer selection.</p>
          {props.seed && <button type="button" className="btn btn-secondary text-sm" disabled={busy || !props.available || pending} onClick={() => void state.reviewSeed(props.seed.preparation)}>Check selected private preparation</button>}</>
          : <><p className="break-words font-semibold">{acknowledgement.package.analysis.name}</p>
            <p className="text-sm text-textMuted">Saved analysis {acknowledgement.package.analysis.version} · {acknowledgement.package.results.length} findings · {acknowledgement.package.documents.length} supporting documents</p>
            <p className="text-sm">Current project members will be able to view the selected fixed table excerpts, whole retained figures, supplied notes and included saved supporting source. Members can save content they can view.</p>
            <p className="text-sm text-textMuted">Original datasets, private scratch, editing and execution access remain governed by their own permissions. Supporting source does not establish producing code or reproducibility.</p>
            <ExactSnapshot value={acknowledgement} />
            <button type="button" className="btn btn-primary" disabled={busy || pending || !state.canPublish} onClick={() => void state.publish()}>Publish to project</button>
            {!state.canPublish && <p className="text-sm text-textMuted">New publication requires write access to an active analysis. Your accepted sharing actions can still be recovered.</p>}
          </>}
        {existing && <div className="space-y-2 border-t border-border pt-4"><p className="text-sm">This exact preparation already has an active publication. No new publication was accepted for this request.</p><button type="button" className="btn btn-secondary text-sm" onClick={() => void state.open(existing)}>Open existing publication</button></div>}
      </section>}

      {mode === 'detail' && <section aria-label="Published snapshot review" className="space-y-5">
        {!selected ? <p role="status" className="text-sm text-textMuted">{error || !props.available
          ? 'This published snapshot is currently unavailable. Refresh sharing access or choose another snapshot.'
          : 'Opening the exact published snapshot…'}</p>
          : <><div className="space-y-3 rounded border border-border bg-surface p-4"><h3 className="text-lg font-semibold">{selected.policy.state === 'withdrawn' ? 'Snapshot withdrawn' : 'Published to this project'}</h3>
            <p className="break-words text-xs text-textMuted">Published by {selected.publisherLabel} · {time(selected.publishedAt)}</p>
            {selected.policy.state === 'withdrawn' && <p className="text-sm">Viewing through this publication ended {time(selected.policy.withdrawnAt)}. Its original publication identity remains recorded. Copies already delivered cannot be recalled.</p>}
            <ExactSnapshot value={selected} />
            <div className="flex flex-wrap gap-3"><button type="button" className="btn btn-secondary text-sm" disabled={!props.available} onClick={() => void state.open(selected, { preserveMode: true })}>Check current snapshot access</button>
              {selected.canWithdraw && <button type="button" className="text-sm text-textMuted underline" disabled={busy || pending || !props.available} onClick={state.confirmWithdrawal}>Withdraw from project</button>}</div>
          </div>
            {selected.package && !state.bodyBlocked && <><div><h3 className="break-words text-lg font-semibold">{selected.package.analysis.name}</h3><p className="mt-1 text-xs text-textMuted">Saved analysis {selected.package.analysis.version}</p>
              {props.savedAnalysis.version !== selected.package.analysis.version && <p className="mt-2 text-sm text-textMuted">The working overview now has another saved version. This publication keeps the original version above.</p>}
              <p className="mt-3 whitespace-pre-wrap break-words text-sm">{selected.package.analysis.description}</p></div>
              <p className="text-xs text-textMuted">Producing code has not been established. Runtime state is excluded, and original data access has not been granted.</p>
              <React.Suspense fallback={<p role="status" className="text-sm text-textMuted">Opening retained findings…</p>}><RetainedSnapshotFindings
                projectId={props.projectId} analysisId={props.analysisId} serviceId={state.serviceId} userId={props.userId}
                resourceId={selected.publicationId} audience="project-publication" snapshotSha256={selected.snapshotSha256}
                snapshot={selected.package} availability={selected.availability} available={props.available} isActive={props.isActive}
                readView={readSnapshotPublicationView} readDocument={readSnapshotPublicationDocument} onDenied={state.readFailure} onUnavailable={state.readFailure} /></React.Suspense>
            </>}
            {selected.package && state.bodyBlocked && <p role="status" className="text-sm text-textMuted">Viewing is paused while this publication's access or withdrawal is being checked. Check the original sharing request and current snapshot access.</p>}
          </>}
      </section>}

      {mode === 'confirm-withdraw' && <section aria-label="Confirm snapshot withdrawal" className="space-y-4 rounded border border-border bg-surface p-4 sm:p-6">
        <h3 className="text-lg font-semibold">Withdraw this snapshot from the project</h3>
        {selected && <><p className="break-words text-sm font-medium">{selected.package?.analysis.name || 'Exact published snapshot'}</p><ExactSnapshot value={selected} /></>}
        <p className="text-sm">Project members will no longer be able to view findings through this publication. Its original acceptance and scientific identities remain recorded. This cannot recall copies already delivered.</p>
        <p className="text-sm text-textMuted">Unneeded shared copies may be removed. Original results and private preparations keep their own retention and permissions.</p>
        <div className="flex flex-wrap gap-3"><button type="button" className="btn btn-primary" disabled={busy || pending || !props.available || !selected?.canWithdraw} onClick={() => void state.withdraw()}>Confirm withdrawal</button>
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => navigate('detail')}>Keep publication</button></div>
      </section>}

      {mode === 'activity' && <section aria-label="Your accepted sharing activity" className="space-y-4">
        <h3 className="font-semibold">Your accepted sharing actions</h3><p className="text-sm text-textMuted">This private history helps recover a publication or withdrawal after a lost reply. It lists accepted actions; unsent requests are not saved here.</p>
        {state.activityLoading && <p role="status" className="text-sm text-textMuted">Finding your accepted sharing actions…</p>}
        {state.activityLoaded && !state.activity.length && <p className="text-sm text-textMuted">No accepted sharing actions are recorded for your account in this analysis.</p>}
        <ul className="space-y-3">{state.activity.map(item => <li key={item.requestId} className="space-y-2 rounded border border-border bg-surface p-4">
          <p className="text-sm font-semibold">{item.request.action === 'publish' ? 'Published a snapshot' : 'Withdrew a snapshot'}</p><p className="text-xs text-textMuted">Accepted {time(item.acceptance.acceptedAt)} · {item.currentPolicy.state === 'withdrawn' ? 'Snapshot now withdrawn' : 'Snapshot currently published'}</p>
          <button type="button" className="text-sm text-primary underline" disabled={busy || !props.available} onClick={() => void state.checkRequest(item)}>Check accepted sharing action</button>
        </li>)}</ul>
        {state.activityCursor && <button type="button" className="btn btn-secondary text-sm" disabled={state.activityLoading || !props.available} onClick={() => void state.loadActivity(state.activityCursor)}>Load older sharing actions</button>}
      </section>}

      {mode === 'receipt' && receipt && <section aria-label="Accepted sharing action" className="space-y-4 rounded border border-border bg-surface p-4 sm:p-6">
        <h3 className="text-lg font-semibold">{receipt.acceptance.action === 'publish' ? 'Publication accepted' : 'Withdrawal accepted'}</h3>
        <p className="text-sm text-textMuted">Original action accepted {time(receipt.acceptance.acceptedAt)}.</p>
        <p className="text-sm">{receipt.current.policy.state === 'withdrawn' ? 'This snapshot is now withdrawn. Recovering its original acceptance does not reactivate it.' : 'The exact reviewed snapshot is published to current project members.'}</p>
        <ExactSnapshot value={receipt.current} />
        <details className="text-xs text-textMuted"><summary className="cursor-pointer">Accepted action identity</summary><dl className="mt-2 space-y-2 break-all"><div><dt>Original request</dt><dd>{receipt.requestId}</dd></div><div><dt>Request SHA-256</dt><dd>{receipt.requestSha256}</dd></div><div><dt>Audit event</dt><dd>{receipt.acceptance.auditEventId}</dd></div></dl></details>
        <button type="button" className="btn btn-primary text-sm" disabled={!props.available} onClick={state.openReceipt}>Open original published snapshot</button>
        <button type="button" className="ml-3 text-sm text-primary underline" onClick={() => void state.checkRequest({ requestId: receipt.requestId, requestSha256: receipt.requestSha256, request: receipt.request })} disabled={busy || !props.available}>Check accepted action again</button>
      </section>}
    </div></div>
  </section>;
}
