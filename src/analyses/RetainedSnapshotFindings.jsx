import React, { useRef, useState } from 'react';
import RecordedSnapshotContext from './RecordedSnapshotContext';

const PreparedSnapshotResult = React.lazy(() => import('./PreparedSnapshotResult'));
const PreparedSnapshotSource = React.lazy(() => import('./PreparedSnapshotSource'));

const packageV1 = 'traceomics.analysis-snapshot-package.v1', packageV2 = 'traceomics.analysis-snapshot-package.v2';
function findingContext(item, schema) {
  const attachment = schema === packageV1 ? item.attachment : item.origin?.kind === 'attachment-revision' ? item.origin.attachment : null;
  if (attachment) return { attachment, caption: attachment.caption, short: `Saved revision ${attachment.revisionNumber}`, long: `Saved attachment revision ${attachment.revisionNumber}` };
  if (schema === packageV2 && ['analysis-reference', 'typed-analysis-reference'].includes(item.origin?.kind) && item.origin.captionOrigin === 'user-supplied') {
    return { caption: item.origin.caption, reference: item.origin.reference, analysisVersion: item.origin.analysisVersion,
      short: `Linked in saved analysis ${item.origin.analysisVersion}`, long: `Linked in saved analysis ${item.origin.analysisVersion}` };
  }
  if (schema === packageV2 && item.origin?.kind === 'inert-analysis-reference' && item.origin.captionOrigin === 'user-supplied' && item.origin.includeSourceText === true) {
    return { caption: item.origin.caption, reference: item.origin.reference, analysisVersion: item.origin.analysisVersion,
      short: `Source text included · Saved analysis ${item.origin.analysisVersion}`, long: `Source text included · Saved analysis ${item.origin.analysisVersion}` };
  }
  if (schema === packageV2 && item.origin?.kind === 'captured-workflow-output' && item.origin.captionOrigin === 'user-supplied') {
    return { caption: item.origin.caption, reference: item.origin.reference, analysisVersion: item.origin.analysisVersion,
      short: `Recorded in workflow capture · Saved analysis ${item.origin.analysisVersion}`,
      long: `Recorded in workflow capture · Saved analysis ${item.origin.analysisVersion}` };
  }
  return null;
}
function ExactReference({ reference, includeChecksum = true }) {
  return <>
    {reference.kind === 'workflow-snapshot' ? <div><dt>Saved workflow snapshot</dt><dd className="break-all">{reference.snapshotId}</dd></div>
      : reference.kind === 'analysis-object' ? <><div><dt>Saved analysis object</dt><dd className="break-all">{reference.analysisObjectId}</dd></div>
        <div><dt>Saved checkpoint version</dt><dd className="break-all">{reference.checkpointVersionId}</dd></div></>
        : <div><dt>Saved artifact version</dt><dd className="break-all">{reference.versionId}</dd></div>}
    {includeChecksum && <div><dt>Recorded reference SHA-256</dt><dd className="break-all">{reference.sha256}</dd></div>}
  </>;
}
const referenceReasons = {
  opaque: 'Object contents are not included.',
  'unsupported-view': 'This format is not included as a fixed finding.',
  'restricted-or-unavailable': 'Source access or availability has not been established.',
  'not-included': 'Only this saved reference was selected.',
};

function Findings({ projectId, analysisId, serviceId, userId, resourceId, audience, snapshotSha256, snapshot, availability,
  available, isActive, readView, readDocument, onDenied, onUnavailable }) {
  const [findingId, setFindingId] = useState(null), heading = useRef(null), list = useRef(null);
  const finding = snapshot.results.find(item => item.viewId === findingId) || snapshot.results[0];
  const context = finding && findingContext(finding, snapshot.schema);
  const referenceOnly = item => ['analysis-reference', 'captured-workflow-reference'].includes(item.kind);
  const declared = snapshot.prerequisites.items.filter(item => !referenceOnly(item));
  const references = snapshot.prerequisites.items.filter(referenceOnly);
  const scope = { projectId, analysisId, serviceId, userId, resourceId, audience, snapshotSha256, available, isActive, onDenied, onUnavailable };
  return <>
    <h4 className="text-sm font-semibold">Retained findings</h4>
    <ul ref={list} tabIndex={-1} aria-label="Retained finding selection" className="space-y-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
      {snapshot.results.map((item, index) => { const label = findingContext(item, snapshot.schema); return <li key={item.viewId}>
        <button type="button" aria-pressed={finding?.viewId === item.viewId}
          className={`w-full min-w-0 rounded border p-3 text-left text-sm ${finding?.viewId === item.viewId ? 'border-primary bg-primary/5' : 'border-border bg-surface'}`}
          onClick={() => { setFindingId(item.viewId); requestAnimationFrame(() => heading.current?.focus()); }}>
          <span className="line-clamp-2 break-words">{index + 1}. {label.caption}</span>
          <span className="mt-1 block break-words text-xs text-textMuted">{item.source.name} · {label.short}</span>
        </button>
      </li>; })}
    </ul>
    <React.Suspense fallback={<p role="status" className="text-sm text-textMuted">Opening retained preview…</p>}>
      {finding && <section key={finding.viewId} aria-label="Retained prepared finding" className="min-w-0 rounded border border-border bg-surface p-4">
        <h4 ref={heading} tabIndex={-1} className="whitespace-pre-wrap break-words text-sm font-semibold focus-visible:outline-none">{context.caption}</h4>
        <p className="mt-1 break-words text-xs text-textMuted">{finding.source.name} · {context.long}</p>
        {context.reference && <p className="mt-2 text-xs text-textMuted">Caption supplied for this snapshot.</p>}
        <RecordedSnapshotContext origin={finding.origin} />
        <details className="my-3 text-xs text-textMuted"><summary className="cursor-pointer">Supplied context and exact view</summary>
          <dl className="mt-2 space-y-2">
            {context.attachment && Object.entries(context.attachment.suppliedOrigin).map(([field, value]) => <div key={field}><dt>{field}</dt><dd className="whitespace-pre-wrap break-words">{value || 'Unknown / not supplied'}</dd></div>)}
            {context.reference && <><div><dt>Saved analysis version</dt><dd>{context.analysisVersion}</dd></div><ExactReference reference={context.reference} includeChecksum={false} /></>}
            <div><dt>Original source SHA-256</dt><dd className="break-all">{finding.source.sha256}</dd></div>
            {['typed-analysis-reference', 'captured-workflow-output'].includes(finding.origin?.kind) && <div><dt>Recorded output descriptor SHA-256</dt><dd className="break-all">{finding.view.descriptorSha256}</dd></div>}
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
    {!!declared.length && <section className="space-y-3"><h4 className="text-sm font-semibold">Supplied reproduction prerequisites</h4>
      {declared.map((item, index) => <div key={index}><p className="break-words text-sm font-medium">{item.label} · {item.kind}</p><p className="whitespace-pre-wrap break-words text-sm text-textMuted">{item.detail}</p></div>)}
    </section>}
    {!!references.length && <section aria-label="Reference-only prerequisites" className="space-y-3"><h4 className="text-sm font-semibold">Reference-only prerequisites</h4>
      <p className="text-xs text-textMuted">Contents not included. Integrity not checked. Data access not granted.</p>
      {references.map((item, index) => <div key={index} className="space-y-2 rounded border border-border p-3"><p className="break-words text-sm font-medium">{item.label}</p>
        {item.detail && <p className="whitespace-pre-wrap break-words text-sm text-textMuted">{item.detail}</p>}
        <p className="text-xs text-textMuted">{referenceReasons[item.reason]}</p>
        <details className="text-xs text-textMuted"><summary className="cursor-pointer">Exact saved reference</summary><dl className="mt-2 space-y-2">
          {item.kind === 'captured-workflow-reference' && <><ExactReference reference={item.snapshotReference} includeChecksum={false} />
            <div><dt>Capture SHA-256</dt><dd className="break-all">{item.snapshotReference.sha256}</dd></div>
            <div><dt>Recorded step</dt><dd className="break-all">{item.stepId}</dd></div><div><dt>Recorded output port</dt><dd className="break-all">{item.port}</dd></div></>}
          <ExactReference reference={item.reference} /></dl></details>
      </div>)}
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
  if (![packageV1, packageV2].includes(props.snapshot.schema) || props.snapshot.results.some(item => !findingContext(item, props.snapshot.schema))) {
    return <p role="alert" className="text-sm text-danger">The retained finding context could not be verified.</p>;
  }
  const scopeKey = JSON.stringify([audience, props.resourceId, props.snapshot.schema, props.snapshotSha256, props.serviceId, props.projectId, props.analysisId, props.userId]);
  return <Findings key={scopeKey} {...props} audience={audience} />;
}
