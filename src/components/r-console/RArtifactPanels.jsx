import React from 'react';
import { artifactImageUrl } from '../../artifacts/artifactApi';
import { artifactBytesLabel } from '../../artifacts/privateRArtifactPolicy';

export function SavedPreview({ projectId, value, onImageError }) {
  if (!value) return null;
  const { version, preview } = value;
  const data = preview?.preview;
  return (
    <section
      aria-label="Saved R artifact preview"
      className="rounded border border-border p-3 space-y-2"
    >
      <h3 className="font-medium">
        {version.name} · v{version.versionNumber || 1}
      </h3>
      <div className="text-xs break-all">
        Version {version.versionId} · {version.format.id}
      </div>
      <div className="text-xs">
        Saved size: {artifactBytesLabel(version.sizeBytes)}
        {Number.isSafeInteger(version.sizeBytes) && version.sizeBytes >= 0
          ? ` · ${version.sizeBytes.toLocaleString()} bytes`
          : ''}
      </div>
      <div className="text-xs break-all font-mono">SHA-256 {version.sha256}</div>
      {preview?.integrityVerified && (
        <p role="status" className="text-xs">
          Checksum verified for this saved version
        </p>
      )}
      {data?.family === 'metadata' && <p className="text-sm">{data.message}</p>}
      {data?.family === 'text' && (
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap text-xs">{data.text}</pre>
      )}
      {data?.family === 'table' && (
        <div className="max-h-64 overflow-auto">
          <table className="text-xs w-full">
            <thead>
              <tr>
                {data.columns.map((column) => (
                  <th className="text-left p-2" key={column}>
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row, index) => (
                <tr key={index}>
                  {row.map((cell, column) => (
                    <td className="p-2 border-t border-border" key={column}>
                      {cell == null ? 'NA' : String(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {data.hasMore && (
            <p className="text-xs">Showing a preview; all rows are saved in this version.</p>
          )}
        </div>
      )}
      {data?.family === 'image' && (
        <img
          src={artifactImageUrl(projectId, version.versionId)}
          alt={`Saved figure ${version.name}`}
          className="max-h-80 max-w-full object-contain bg-white"
          onError={onImageError}
        />
      )}
      {version.format.id === 'org.r-project.rds' && (
        <p className="text-xs">
          The full RDS object stays in server storage. This browser receives its metadata; RDS
          contents open only inside your isolated R session.
        </p>
      )}
      {['org.r-project.rds', 'org.ietf.csv'].includes(version.format.id) && (
        <p className="text-xs">
          To reopen, select this version as input for a new session and run{' '}
          <code>{`read_input(${JSON.stringify(version.versionId)})`}</code>.
        </p>
      )}
      <details className="text-xs">
        <summary>Saved reference and provenance</summary>
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all">
          {JSON.stringify(
            { reference: version.reference, provenance: version.provenance },
            null,
            2
          )}
        </pre>
      </details>
    </section>
  );
}

export function SaveOutputForm({
  publish,
  publicationForm,
  busy,
  setPublicationForm,
  figureSelection,
  replacements,
  inspected,
  inspecting,
  blocked,
  saving,
  controlBusy,
  recoveryBlocked,
  publicationUncertain,
  canSaveFigure,
  canSaveBinding,
}) {
  return (
    <form
      aria-label="Save R output"
      onSubmit={publish}
      className="rounded border border-border p-3 space-y-3"
    >
      <div>
        <h3 className="font-medium">Save a private artifact version</h3>
        <p className="text-xs text-textMuted">
          Save an existing R binding or choose a completed figure above. Saved bytes survive session
          termination; earlier versions remain immutable.
        </p>
      </div>
      <div className="flex flex-wrap gap-3">
        <label className="text-sm">
          Output type
          <select
            aria-label="R output type"
            className="block border border-border rounded p-2 bg-surface text-text"
            value={publicationForm.type}
            disabled={busy}
            onChange={(event) =>
              setPublicationForm((form) => ({
                ...form,
                type: event.target.value,
                previousVersionId: '',
              }))
            }
          >
            <option value="object">R object (RDS)</option>
            <option value="table">Data frame (CSV)</option>
            {figureSelection && <option value="figure">Selected figure (PNG)</option>}
          </select>
        </label>
        {publicationForm.type !== 'figure' && (
          <label className="text-sm">
            Existing R binding
            <input
              aria-label="Existing R binding"
              className="input block"
              value={publicationForm.binding}
              maxLength={256}
              disabled={busy}
              onChange={(event) =>
                setPublicationForm((form) => ({ ...form, binding: event.target.value }))
              }
            />
          </label>
        )}
        <label className="text-sm">
          Saved output name
          <input
            aria-label="Saved output name"
            className="input block"
            value={publicationForm.name}
            maxLength={160}
            disabled={busy}
            onChange={(event) =>
              setPublicationForm((form) => ({ ...form, name: event.target.value }))
            }
          />
        </label>
        <label className="text-sm">
          Version to extend
          <select
            aria-label="Version to extend"
            className="block border border-border rounded p-2 bg-surface text-text"
            value={publicationForm.previousVersionId}
            disabled={busy}
            onChange={(event) =>
              setPublicationForm((form) => ({ ...form, previousVersionId: event.target.value }))
            }
          >
            <option value="">New artifact</option>
            {replacements.map((version) => (
              <option key={version.versionId} value={version.versionId}>
                {version.name} · v{version.versionNumber || 1}
              </option>
            ))}
          </select>
        </label>
      </div>
      {publicationForm.type === 'figure' && figureSelection && (
        <p className="text-xs break-all">
          Selected figure {figureSelection.index + 1} from command {figureSelection.order} ·{' '}
          {figureSelection.executionId} · PNG SHA-256 {figureSelection.sha256}
        </p>
      )}
      <button
        className="btn btn-primary text-sm"
        disabled={
          !inspected ||
          inspecting ||
          blocked ||
          busy ||
          saving ||
          controlBusy ||
          recoveryBlocked ||
          publicationUncertain ||
          !publicationForm.name.trim() ||
          (publicationForm.type === 'figure'
            ? !canSaveFigure
            : !canSaveBinding || !publicationForm.binding)
        }
      >
        {saving
          ? `Saving ${publicationForm.type}…`
          : publicationForm.type === 'figure'
            ? 'Save figure'
            : publicationForm.type === 'table'
              ? 'Save table'
              : 'Save object'}
      </button>
      {saving && (
        <p role="status" className="text-xs">
          Saving the full artifact in server storage. Large serialization and transfers may take
          several minutes; keep this session open until completion is confirmed.
        </p>
      )}
      {publicationUncertain && (
        <p role="status" className="text-xs">
          Publication completion is unconfirmed. Refresh session status to inspect its retained
          receipt before saving again. No output will be serialized automatically.
        </p>
      )}
      <p className="text-xs text-textMuted">
        Object and table saves add an ordered serialization command. Saved files transfer directly
        between the R runtime and server storage; this browser receives metadata and previews. RDS
        objects reopen only in your isolated R runtime. CSV and PNG previews are validated from
        saved bytes.
      </p>
      {publicationForm.type === 'table' && (
        <p className="text-xs text-textMuted">
          CSV keeps data columns. Add important row identifiers as a column before saving, or save
          as RDS to preserve R attributes.
        </p>
      )}
    </form>
  );
}

export function SavedOutputs({ publications, blocked, busy, inspectSaved }) {
  return (
    <section aria-label="Saved R outputs" className="space-y-3">
      <h3 className="font-medium">Saved outputs</h3>
      {publications.map((publication) => (
        <div key={publication.id} className="rounded border border-border p-3 text-xs space-y-2">
          <div>
            {publication.name} · {publication.type} · {publication.status}
          </div>
          {publication.message && <p>{publication.message}</p>}
          {publication.version && (
            <button
              className="btn btn-secondary text-xs"
              disabled={blocked || busy}
              onClick={() => inspectSaved(publication.version)}
            >
              Inspect {publication.version.name} · v{publication.version.versionNumber || 1}
            </button>
          )}
          <details>
            <summary>Save details</summary>
            <div className="pt-2 space-y-1">
              <div className="break-all">
                Publication {publication.id} · kernel {publication.kernelId} · generation{' '}
                {publication.generation}
              </div>
              <div>
                Source command {publication.order} · {publication.sourceExecutionId}
              </div>
              <div className="break-all">Source SHA-256 {publication.sourceSha256}</div>
              <div className="break-all">
                Environment SHA-256 {publication.lineage?.environment?.manifestSha256}
              </div>
              {publication.lineage?.inputs?.map((input) => (
                <div key={input.id}>
                  {input.name} · <span className="font-mono break-all">{input.checksumSha256}</span>
                </div>
              ))}
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all">
                {JSON.stringify(publication.lineage, null, 2)}
              </pre>
            </div>
          </details>
        </div>
      ))}
    </section>
  );
}
