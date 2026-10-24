import React from 'react';

const schema = 'traceomics.captured-workflow-context.v1';

// The parent passes selected context from a validated immutable package.
// Inspecting it never opens the capture, environment manifest or a runtime.
export default function RecordedSnapshotContext({ origin }) {
  if (origin?.kind !== 'captured-workflow-output') return null;
  const context = origin.context, evidence = origin.contextEvidence;
  if (context?.schema !== schema || context.relation !== 'recorded-in-capture' || evidence?.capture !== 'fingerprint-checked'
      || evidence.environment !== (context.environment === null ? 'not-included' : 'manifest-checked')) {
    return <p role="alert" className="my-3 text-sm text-danger">The recorded workflow context could not be verified.</p>;
  }
  const { method, parameters, seed, environment } = context;
  return <details aria-label="Recorded workflow context" className="my-3 text-xs">
    <summary className="cursor-pointer font-medium">Recorded in this workflow capture</summary>
    <div className="mt-3 space-y-4">
      <p className="text-textMuted">This selected context is separate from the supplied caption. It does not establish the code or runtime that originally produced the result.</p>
      {method && <section aria-label="Recorded method" className="space-y-2">
        <h5 className="font-semibold">Recorded method</h5><p className="break-words">{method.name} · {method.version}</p>
        <dl className="space-y-2 sm:grid sm:grid-cols-[auto_minmax(0,1fr)] sm:gap-x-4 sm:space-y-0 sm:gap-y-2">
          <dt className="text-textMuted">Step</dt><dd className="break-words">{method.stepLabel}</dd>
          <dt className="text-textMuted">Output</dt><dd className="break-words">{method.outputLabel}</dd>
        </dl>
      </section>}
      {parameters.length > 0 && <section aria-label="Recorded settings" className="space-y-2">
        <h5 className="font-semibold">Selected recorded settings</h5>
        <dl className="divide-y divide-border">{parameters.map(parameter => <div key={parameter.key} className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-4 py-2">
          <dt className="break-words text-textMuted">{parameter.label}</dt>
          <dd className="whitespace-pre-wrap break-words font-medium">{String(parameter.value)}</dd>
        </div>)}</dl>
      </section>}
      {seed !== null && <p>Recorded random seed: <span className="font-medium">{seed}</span></p>}
      {environment && <section aria-label="Recorded environment reference" className="space-y-2">
        <h5 className="font-semibold">Recorded environment reference</h5>
        <p className="text-textMuted">Recorded environment reference checked when prepared; current runtime availability not checked.</p>
        <dl className="space-y-2 sm:grid sm:grid-cols-[auto_minmax(0,1fr)] sm:gap-x-4 sm:space-y-0 sm:gap-y-2">
          <dt className="text-textMuted">R version</dt><dd className="break-words">{environment.rVersion || 'Not recorded'}</dd>
          <dt className="text-textMuted">Bioconductor</dt><dd className="break-words">{environment.bioconductor || 'Not recorded'}</dd>
          <dt className="text-textMuted">Recorded profile</dt><dd className="break-words">{environment.profileId}</dd>
        </dl>
      </section>}
      {!method && !parameters.length && seed === null && !environment && <p className="text-textMuted">No method, settings, seed or environment reference was included.</p>}
      <details className="text-textMuted"><summary className="cursor-pointer">Exact capture identities</summary>
        <dl className="mt-2 space-y-2 break-all">
          <div><dt>Saved workflow capture</dt><dd>{context.snapshotReference.snapshotId}</dd></div>
          <div><dt>Capture SHA-256</dt><dd>{context.snapshotReference.sha256}</dd></div>
          <div><dt>Recorded step</dt><dd>{context.stepId}</dd></div><div><dt>Recorded output port</dt><dd>{context.port}</dd></div>
          <div><dt>Selected context SHA-256</dt><dd>{origin.contextSha256}</dd></div>
          {method && <><div><dt>Recorded method ID</dt><dd>{method.id}</dd></div><div><dt>Recorded method SHA-256</dt><dd>{method.digest}</dd></div></>}
          {environment && <><div><dt>Recorded environment ID</dt><dd>{environment.id}</dd></div>
            <div><dt>Environment manifest SHA-256</dt><dd>{environment.manifestSha256}</dd></div>
            <div><dt>Recorded image digest</dt><dd>{environment.imageDigest || 'Not recorded'}</dd></div>
            <div><dt>Recorded image ID</dt><dd>{environment.imageId || 'Not recorded'}</dd></div>
            <div><dt>Environment snapshot scope</dt><dd>{environment.snapshotScope}</dd></div></>}
        </dl>
        <p className="mt-2">Capture fingerprint checked when prepared. No source code, environment manifest or runtime access is included here.</p>
      </details>
    </div>
  </details>;
}
