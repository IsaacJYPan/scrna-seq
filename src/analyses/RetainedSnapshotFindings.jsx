import React, { useRef, useState } from 'react';

const PreparedSnapshotResult = React.lazy(() => import('./PreparedSnapshotResult'));
const PreparedSnapshotSource = React.lazy(() => import('./PreparedSnapshotSource'));

function Findings({ projectId, analysisId, serviceId, userId, resourceId, audience, snapshotSha256, snapshot, availability,
  available, isActive, readView, readDocument, onDenied, onUnavailable }) {
  const [findingId, setFindingId] = useState(null), heading = useRef(null), list = useRef(null);
  const finding = snapshot.results.find(item => item.viewId === findingId) || snapshot.results[0];
  const scope = { projectId, analysisId, serviceId, userId, resourceId, audience, snapshotSha256, available, isActive, onDenied, onUnavailable };
  return <>
    <h4 className="text-sm font-semibold">Retained findings</h4>
    <ul ref={list} tabIndex={-1} aria-label="Retained finding selection" className="space-y-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
      {snapshot.results.map((item, index) => <li key={item.viewId}>
        <button type="button" aria-pressed={finding?.viewId === item.viewId}
          className={`w-full min-w-0 rounded border p-3 text-left text-sm ${finding?.viewId === item.viewId ? 'border-primary bg-primary/5' : 'border-border bg-surface'}`}
          onClick={() => { setFindingId(item.viewId); requestAnimationFrame(() => heading.current?.focus()); }}>
          <span className="line-clamp-2 break-words">{index + 1}. {item.attachment.caption}</span>
          <span className="mt-1 block break-words text-xs text-textMuted">{item.source.name} · Saved revision {item.attachment.revisionNumber}</span>
        </button>
      </li>)}
    </ul>
    <React.Suspense fallback={<p role="status" className="text-sm text-textMuted">Opening retained preview…</p>}>
      {finding && <section key={finding.viewId} aria-label="Retained prepared finding" className="min-w-0 rounded border border-border bg-surface p-4">
        <h4 ref={heading} tabIndex={-1} className="whitespace-pre-wrap break-words text-sm font-semibold focus-visible:outline-none">{finding.attachment.caption}</h4>
        <p className="mt-1 break-words text-xs text-textMuted">{finding.source.name} · Saved attachment revision {finding.attachment.revisionNumber}</p>
        <details className="my-3 text-xs text-textMuted"><summary className="cursor-pointer">Supplied context and exact view</summary>
          <dl className="mt-2 space-y-2">
            {Object.entries(finding.attachment.suppliedOrigin).map(([field, value]) => <div key={field}><dt>{field}</dt><dd className="whitespace-pre-wrap break-words">{value || 'Unknown / not supplied'}</dd></div>)}
            <div><dt>Original source SHA-256</dt><dd className="break-all">{finding.source.sha256}</dd></div>
            <div><dt>Retained view SHA-256</dt><dd className="break-all">{finding.view.viewSha256}</dd></div>
          </dl>
        </details>
        {availability.views.find(item => item.viewId === finding.viewId)?.status === 'available'
          ? <PreparedSnapshotResult {...scope} descriptor={finding} readView={readView} />
          : <p role="status" className="text-sm text-textMuted">This retained view is unavailable. Its exact saved identity is kept and has not been regenerated.</p>}
        <button type="button" className="mt-4 text-xs text-primary underline" onClick={() => list.current?.focus()}>Back to retained findings</button>
      </section>}
      <div className="mt-6 space-y-4">
        {snapshot.documents.map(item => availability.documents.find(value => value.documentId === item.documentId && value.versionId === item.versionId)?.status === 'available'
          ? <PreparedSnapshotSource {...scope} key={item.viewId} descriptor={item} readDocument={readDocument} />
          : <section key={item.viewId} className="rounded border border-border p-4"><h4 className="break-words text-sm font-semibold">{item.title}</h4>
            <p role="status" className="mt-2 text-sm text-textMuted">This retained supporting source is unavailable. Its exact saved identity is kept and has not been regenerated.</p></section>)}
      </div>
    </React.Suspense>
    {Object.entries(snapshot.notes).some(([, value]) => value) && <section className="space-y-3"><h4 className="text-sm font-semibold">Supplied notes</h4>
      {Object.entries(snapshot.notes).filter(([, value]) => value).map(([field, value]) => <div key={field}><p className="text-xs capitalize text-textMuted">{field}</p><p className="whitespace-pre-wrap break-words text-sm">{value}</p></div>)}
    </section>}
    {!!snapshot.prerequisites.items.length && <section className="space-y-3"><h4 className="text-sm font-semibold">Supplied reproduction prerequisites</h4>
      {snapshot.prerequisites.items.map((item, index) => <div key={index}><p className="break-words text-sm font-medium">{item.label} · {item.kind}</p><p className="whitespace-pre-wrap break-words text-sm text-textMuted">{item.detail}</p></div>)}
    </section>}
  </>;
}

// Only validated immutable packages and their current availability overlays belong here.
// A null package/overlay (including withdrawal) must unmount every retained body.
export default function RetainedSnapshotFindings({ audience = 'private-preparation', ...props }) {
  if (!props.snapshot || !props.availability) return null;
  if (audience !== 'private-preparation' && audience !== 'project-publication') {
    return <p role="alert" className="text-sm text-danger">The retained snapshot audience could not be verified.</p>;
  }
  const scopeKey = JSON.stringify([audience, props.resourceId, props.snapshotSha256, props.serviceId, props.projectId, props.analysisId, props.userId]);
  return <Findings key={scopeKey} {...props} audience={audience} />;
}
