import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { validateResearchAnalysisReference } from '../../shared/researchAnalysis.mjs';
import { getArtifactVersion, previewArtifactVersion } from '../artifacts/artifactApi';
import { fetchRetainedArtifactImage } from '../artifacts/retainedArtifactApi';
import { artifactBytesLabel } from '../artifacts/privateRArtifactPolicy';
import useExecutionTarget from '../runtime/useExecutionTarget';
import {
  assertRetainedTypedSource,
  validRetainedMeaning,
  validRetainedTypedPreview,
} from '../artifacts/retainedTypedPreview';
import RetainedEmbedding from './RetainedEmbedding';

const opaqueMessage =
  'This saved artifact has no supported browser preview. Only its saved metadata is shown; its contents have not been read or verified here.';
const safeFailure = (error) => {
  if ([401, 403].includes(error.status))
    return 'Source access is restricted. Reconnect or ask for the required source access.';
  if (error.status === 404)
    return 'This saved result is unavailable or source access is restricted.';
  if (error.status === 409 || error.code === 'ARTIFACT_INTEGRITY_FAILED')
    return 'This result could not be verified against its saved version and checksum. No preview is shown.';
  if (error.status === 413)
    return 'This result is too large to preview here. Try fewer rows or open it in an analysis session.';
  return 'The saved result could not be loaded. Check the workspace connection and try again.';
};
function assertVersion(version, projectId, reference) {
  const versionId = reference.versionId || reference.checkpointVersionId;
  if (
    !version ||
    version.projectId !== projectId ||
    version.versionId !== versionId ||
    version.sha256 !== reference.sha256 ||
    typeof version.name !== 'string' ||
    !version.format ||
    !Array.isArray(version.previews)
  ) {
    throw Object.assign(new Error('The returned result does not match the requested version.'), {
      status: 409,
    });
  }
}
function validTablePreview(value) {
  return (
    Array.isArray(value.columns) &&
    value.columns.length <= 100 &&
    value.columns.every((column) => typeof column === 'string') &&
    Array.isArray(value.rows) &&
    value.rows.length <= 100 &&
    value.rows.every(
      (row) =>
        Array.isArray(row) &&
        row.length === value.columns.length &&
        row.every((cell) => cell === null || ['string', 'number', 'boolean'].includes(typeof cell))
    ) &&
    Number.isSafeInteger(value.offset) &&
    value.offset >= 0 &&
    value.offset <= 10000 &&
    Number.isSafeInteger(value.limit) &&
    value.limit >= 1 &&
    value.limit <= 100
  );
}

function ResultMeaning({ semantics }) {
  if (!validRetainedMeaning(semantics) || (!semantics.role && !semantics.title)) return null;
  return (
    <div aria-label="Declared result meaning" className="flex min-w-0 flex-wrap items-center gap-2">
      {semantics.role && (
        <span className="rounded border border-border px-2 py-1 text-xs text-textMuted">
          {semantics.role === 'primary' ? 'Primary result' : 'Diagnostic'}
        </span>
      )}
      {semantics.title && <h5 className="min-w-0 break-words font-medium">{semantics.title}</h5>}
    </div>
  );
}

// Rendering has no transport or execution dependency.
export function RetainedResultContent(props) {
  const { preview } = props;
  if (!preview) return null;
  return (
    <div className="min-w-0 space-y-3">
      <ResultMeaning semantics={preview.semantics} />
      <RetainedResultBody {...props} />
    </div>
  );
}

function RetainedResultBody({
  preview,
  integrityVerified = false,
  imageUrl,
  name,
  loading,
  pageSize,
  onPageChange,
  onPageSizeChange,
  onImageError,
  pointLimit = 2000,
  onPointLimitChange,
}) {
  if (!preview) return null;
  if (preview.family === 'metadata')
    return (
      <p className="text-sm text-textMuted">
        {integrityVerified
          ? 'The checksum matches this version, but no browser preview is available. Open the file in an analysis session.'
          : opaqueMessage}
      </p>
    );
  if (preview.family === 'text' && typeof preview.text === 'string')
    return (
      <>
        <pre
          tabIndex={0}
          aria-label="Saved text preview"
          className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded border border-border p-3 text-xs"
        >
          {preview.text}
        </pre>
        {preview.truncated && (
          <p className="text-xs text-textMuted">
            Showing part of the file. The full version is saved.
          </p>
        )}
      </>
    );
  if (preview.family === 'image')
    return imageUrl ? (
      <figure>
        <img
          src={imageUrl}
          alt={`Preview of ${name}`}
          className="max-h-80 max-w-full object-contain bg-white"
          onError={onImageError}
        />
        <a
          href={imageUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 inline-block text-sm text-primary underline"
        >
          Open full-size image
        </a>
        <figcaption className="mt-1 text-xs text-textMuted">
          {preview.width} × {preview.height} pixels · image preview
        </figcaption>
      </figure>
    ) : null;
  if (preview.family === 'metrics' && validRetainedTypedPreview(preview))
    return (
      <dl aria-label="Saved scalar metrics" className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {preview.items.map((item) => (
          <div key={item.key} className="min-w-0 rounded border border-border p-3">
            <dt className="break-words text-xs text-textMuted">
              {item.label || item.key}
              {item.unit ? ` (${item.unit})` : ''}
            </dt>
            <dd className="break-words whitespace-pre-wrap font-medium">
              {item.value === null ? 'Not recorded' : String(item.value)}
            </dd>
          </div>
        ))}
      </dl>
    );
  if (preview.family === 'embedding' && validRetainedTypedPreview(preview))
    return (
      <RetainedEmbedding
        preview={preview}
        pointLimit={pointLimit}
        onPointLimitChange={onPointLimitChange}
        loading={loading}
      />
    );
  if (preview.family === 'table' && validTablePreview(preview))
    return (
      <>
        <div
          tabIndex={0}
          aria-label="Saved table preview"
          className="max-h-80 overflow-auto rounded border border-border"
        >
          <table className="w-full text-left text-xs">
            <thead>
              <tr>
                {preview.columns.map((column, index) => (
                  <th scope="col" className="p-2" key={index}>
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {preview.rows.map((row, index) => (
                <tr key={preview.offset + index}>
                  {row.map((cell, column) => (
                    <td className="border-t border-border p-2 whitespace-pre-wrap" key={column}>
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {preview.truncated && (
          <p className="text-xs text-textMuted">
            Showing part of the table. More rows are saved in the full file.
          </p>
        )}
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <button
            type="button"
            className="btn btn-secondary text-xs"
            disabled={loading || preview.offset === 0}
            onClick={() => onPageChange(Math.max(0, preview.offset - preview.limit))}
          >
            Previous rows
          </button>
          <span>
            Rows {preview.offset + (preview.rows.length ? 1 : 0)}–
            {preview.offset + preview.rows.length}
          </span>
          <button
            type="button"
            className="btn btn-secondary text-xs"
            disabled={loading || !preview.hasMore || preview.offset + preview.limit > 10000}
            onClick={() => onPageChange(preview.offset + preview.limit)}
          >
            Next rows
          </button>
          <label>
            Rows per page
            <select
              aria-label="Rows per page"
              className="input ml-2"
              value={pageSize}
              disabled={loading}
              onChange={(event) => onPageSizeChange(Number(event.target.value))}
            >
              {[1, 10, 25, 50, 100].map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </label>
        </div>
      </>
    );
  return (
    <p className="text-sm text-textMuted">
      This retained result format has no supported browser renderer. The saved version remains
      available.
    </p>
  );
}

function ArtifactEvidence({ version, reference, compact, copied, copy }) {
  const details = (
    <>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
        <dt className="text-textMuted">Format</dt>
        <dd className="break-all">
          {version.format.id} · {version.format.version}
        </dd>
        <dt className="text-textMuted">Size</dt>
        <dd>{artifactBytesLabel(version.sizeBytes)}</dd>
        <dt className="text-textMuted">Owner</dt>
        <dd>{version.owner?.displayName || 'Researcher'}</dd>
        <dt className="text-textMuted">Source run</dt>
        <dd className="break-all">{version.sourceRunId || 'Imported file'}</dd>
        <dt className="text-textMuted">Version</dt>
        <dd className="break-all">{version.versionId}</dd>
        <dt className="text-textMuted">SHA-256</dt>
        <dd className="break-all font-mono text-xs">{reference.sha256}</dd>
        <dt className="text-textMuted">Previews</dt>
        <dd>{version.previews.join(', ') || 'Metadata only'}</dd>
      </dl>
      {version.sourceImport && (
        <details className="text-xs">
          <summary>Server source and sample details</summary>
          <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1">
            <dt className="text-textMuted">Server</dt>
            <dd>{version.sourceImport.serviceLabel}</dd>
            <dt className="text-textMuted">Data root</dt>
            <dd>{version.sourceImport.rootLabel}</dd>
            <dt className="text-textMuted">Source file</dt>
            <dd className="break-all">{version.sourceImport.relativePath}</dd>
            <dt className="text-textMuted">Saved</dt>
            <dd>{new Date(version.sourceImport.importedAt).toLocaleString()}</dd>
            <dt className="text-textMuted">Server import</dt>
            <dd className="break-all">{version.sourceImport.importId}</dd>
            {Object.entries(version.sourceImport.sampleMetadata || {}).map(([key, value]) => (
              <React.Fragment key={key}>
                <dt className="text-textMuted">
                  {{
                    sampleId: 'Sample ID',
                    condition: 'Condition',
                    tissue: 'Tissue',
                    species: 'Species',
                    replicate: 'Replicate',
                  }[key] || key}
                </dt>
                <dd className="break-all">{value}</dd>
              </React.Fragment>
            ))}
          </dl>
        </details>
      )}
      <button type="button" className="btn btn-secondary text-xs" onClick={copy}>
        {copied ? 'Artifact reference copied' : 'Copy artifact reference'}
      </button>
      <details className="text-xs">
        <summary>Exact artifact reference</summary>
        <pre className="mt-2 whitespace-pre-wrap break-all">
          {JSON.stringify(reference, null, 2)}
        </pre>
      </details>
    </>
  );
  return compact ? (
    <details className="space-y-3 text-xs">
      <summary>Saved version details</summary>
      {details}
    </details>
  ) : (
    details
  );
}

function ArtifactVersionView({ projectId, referenceKey, compact, onInspect }) {
  const reference = useMemo(() => JSON.parse(referenceKey), [referenceKey]);
  const [version, setVersion] = useState(null),
    [result, setResult] = useState(null);
  const [error, setError] = useState(''),
    [loading, setLoading] = useState(false),
    [copied, setCopied] = useState(false);
  const [imageUrl, setImageUrl] = useState(null),
    [pageSize, setPageSize] = useState(25);
  const [pointLimit, setPointLimit] = useState(2000);
  const request = useRef(null),
    generation = useRef(0),
    image = useRef(null);
  const releaseImage = useCallback(() => {
    if (image.current) URL.revokeObjectURL(image.current);
    image.current = null;
    setImageUrl(null);
  }, []);
  const versionId = reference.versionId || reference.checkpointVersionId;
  const load = useCallback(
    async (offset = 0, limit = 25, maximumPoints = 2000) => {
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      const current = ++generation.current;
      const valid = () => !controller.signal.aborted && current === generation.current;
      releaseImage();
      setResult(null);
      setError('');
      setCopied(false);
      setLoading(true);
      try {
        const metadata = await getArtifactVersion(projectId, versionId, controller.signal);
        if (!valid()) return;
        assertVersion(metadata, projectId, reference);
        setVersion(metadata);
        if (!metadata.previews.length) {
          setResult({ integrityVerified: false, preview: { family: 'metadata' } });
          return;
        }
        const preview = await previewArtifactVersion(projectId, versionId, {
          signal: controller.signal,
          offset,
          limit,
          ...(metadata.previews.includes('embedding') ? { pointLimit: maximumPoints } : {}),
        });
        if (!valid()) return;
        assertVersion(preview.version, projectId, reference);
        if (
          preview.integrityVerified !== true ||
          !preview.preview ||
          typeof preview.preview.family !== 'string'
        )
          throw Object.assign(new Error('The preview checksum could not be confirmed.'), {
            status: 409,
          });
        assertRetainedTypedSource(preview.preview, metadata);
        if (preview.preview.family === 'image') {
          const blob = await fetchRetainedArtifactImage(projectId, versionId, reference.sha256, {
            signal: controller.signal,
          });
          if (!valid()) return;
          const url = URL.createObjectURL(blob);
          image.current = url;
          setImageUrl(url);
        }
        if (valid()) setResult(preview);
      } catch (failure) {
        if (!valid()) return;
        setError(safeFailure(failure));
        setResult(null);
        releaseImage();
        if ([401, 403, 404].includes(failure.status)) setVersion(null);
      } finally {
        if (valid()) setLoading(false);
      }
    },
    [projectId, versionId, reference, releaseImage]
  );
  useEffect(() => {
    void load();
    return () => {
      generation.current += 1;
      request.current?.abort();
      if (image.current) URL.revokeObjectURL(image.current);
      image.current = null;
    };
  }, [load]);
  return (
    <section aria-label="Retained result" className="min-w-0 space-y-3">
      {version && (
        <>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <h4 className="min-w-0 break-words font-semibold">
              {version.name}
              {version.versionNumber ? ` · v${version.versionNumber}` : ''}
            </h4>
            {onInspect && (
              <button
                type="button"
                className="btn btn-secondary text-xs"
                onClick={() => onInspect({ projectId, reference, version })}
              >
                Inspect result
              </button>
            )}
          </div>
          <ArtifactEvidence
            version={version}
            reference={reference}
            compact={compact}
            copied={copied}
            copy={async () => {
              try {
                await navigator.clipboard.writeText(JSON.stringify(reference));
                setCopied(true);
              } catch {
                setError('Reference could not be copied. Select it in the details below.');
              }
            }}
          />
        </>
      )}
      {loading && (
        <p role="status" className="text-sm text-textMuted">
          Loading saved result and preview…
        </p>
      )}
      {error && (
        <div className="space-y-2">
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
          <button
            type="button"
            className="btn btn-secondary text-xs"
            disabled={loading}
            onClick={() => void load(0, pageSize, pointLimit)}
          >
            Retry saved result
          </button>
        </div>
      )}
      {result?.integrityVerified && (
        <p role="status" className="text-xs text-success">
          Saved checksum verified · preview from this exact version
        </p>
      )}
      <RetainedResultContent
        preview={result?.preview}
        integrityVerified={result?.integrityVerified}
        imageUrl={imageUrl}
        name={version?.name}
        loading={loading}
        pageSize={pageSize}
        pointLimit={pointLimit}
        onPointLimitChange={(maximum) => {
          setPointLimit(maximum);
          void load(0, pageSize, maximum);
        }}
        onPageChange={(offset) => void load(offset, pageSize)}
        onPageSizeChange={(size) => {
          setPageSize(size);
          void load(0, size);
        }}
        onImageError={() => {
          releaseImage();
          setResult(null);
          setError('The image preview is unavailable or its integrity check failed.');
        }}
      />
    </section>
  );
}

export default function RetainedArtifactView({
  projectId,
  userId,
  reference,
  compact = false,
  onInspect,
}) {
  const connection = useExecutionTarget();
  let validatedReference;
  try {
    validatedReference = validateResearchAnalysisReference(reference);
  } catch {
    return (
      <p role="alert" className="text-sm text-danger">
        Select a saved result with a version and checksum.
      </p>
    );
  }
  if (!projectId)
    return <p className="text-sm text-textMuted">Choose a project to inspect this saved result.</p>;
  if (connection.blocked)
    return (
      <p role="status" className="text-sm text-textMuted">
        Reconnect to this workspace to inspect its retained results. No analysis runtime is started.
      </p>
    );
  const key = JSON.stringify([
    userId ?? null,
    connection.identity,
    connection.epoch,
    projectId,
    validatedReference,
  ]);
  return (
    <ArtifactVersionView
      key={key}
      projectId={projectId}
      referenceKey={JSON.stringify(validatedReference)}
      compact={compact}
      onInspect={onInspect}
    />
  );
}
