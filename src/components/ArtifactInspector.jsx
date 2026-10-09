import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  artifactImageUrl, getArtifactVersion, importArtifactVersion, listArtifactVersions,
  previewArtifactVersion,
} from '../artifacts/artifactApi';
import { artifactBytesLabel as bytesLabel } from '../artifacts/privateRArtifactPolicy';

export default function ArtifactInspector({ projectId, canWrite = false, userId }) {
  const [items, setItems] = useState([]);
  const [nextCursor, setNextCursor] = useState(null);
  const [selected, setSelected] = useState(null);
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [inspecting, setInspecting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [file, setFile] = useState(null);
  const [name, setName] = useState('');
  const [artifactType, setArtifactType] = useState('auto');
  const [replacement, setReplacement] = useState(false);
  const [copied, setCopied] = useState(false);
  const [pageSize, setPageSize] = useState(25);
  const listRequest = useRef(null);
  const inspectionRequest = useRef(null);
  const importRequest = useRef(null);
  const projectRef = useRef(projectId);
  projectRef.current = projectId;

  const refresh = useCallback(async before => {
    if (!projectId) return;
    listRequest.current?.abort();
    const controller = new AbortController(); listRequest.current = controller;
    setLoading(true); setError('');
    try {
      const response = await listArtifactVersions(projectId, { signal: controller.signal, before });
      if (controller.signal.aborted || projectRef.current !== projectId) return;
      setItems(current => before ? [...current, ...response.items.filter(item => !current.some(existing => existing.versionId === item.versionId))] : response.items);
      setNextCursor(response.nextCursor);
    } catch (failure) {
      if (!controller.signal.aborted) {
        setError(failure.message);
        if ([403, 404].includes(failure.status)) { setItems([]); setSelected(null); setPreview(null); setNextCursor(null); }
      }
    }
    finally { if (!controller.signal.aborted) setLoading(false); }
  }, [projectId]);

  useEffect(() => {
    setItems([]); setSelected(null); setPreview(null); setNextCursor(null); setError(''); setFile(null); setName(''); setReplacement(false); setInspecting(false); setImporting(false);
    refresh();
    return () => { listRequest.current?.abort(); inspectionRequest.current?.abort(); importRequest.current?.abort(); };
  }, [refresh]);

  const inspect = async (version, offset = 0, limit = pageSize) => {
    inspectionRequest.current?.abort();
    const controller = new AbortController(); inspectionRequest.current = controller;
    setSelected(version); setPreview(null); setError(''); setCopied(false); setInspecting(true); setReplacement(false);
    try {
      const current = await getArtifactVersion(projectId, version.versionId, controller.signal);
      if (controller.signal.aborted || projectRef.current !== projectId) return;
      setSelected(current);
      const result = await previewArtifactVersion(projectId, current.versionId, { signal: controller.signal, offset, limit });
      if (!controller.signal.aborted && projectRef.current === projectId) setPreview(result);
    } catch (failure) {
      if (!controller.signal.aborted) {
        setError(failure.message); setPreview(null);
        if ([403, 404].includes(failure.status)) setSelected(null);
      }
    } finally { if (!controller.signal.aborted) setInspecting(false); }
  };

  const submit = async event => {
    event.preventDefault();
    if (!file || !canWrite || !projectId) return;
    const controller = new AbortController(); importRequest.current = controller;
    const submittedProject = projectId;
    setImporting(true); setError('');
    try {
      const created = await importArtifactVersion(projectId, { file, name, artifactType, previousVersionId: replacement ? selected?.versionId : undefined, signal: controller.signal });
      if (controller.signal.aborted || projectRef.current !== submittedProject) return;
      setFile(null); setName(''); setReplacement(false);
      await refresh();
      if (!controller.signal.aborted) await inspect(created);
    } catch (failure) { if (!controller.signal.aborted) setError(failure.message); }
    finally { if (!controller.signal.aborted) setImporting(false); }
  };

  if (!projectId) return null;
  const data = preview?.preview;
  const canReplace = canWrite && selected?.canReplace && (!userId || selected.ownerId === String(userId));
  return <section aria-label="Artifact versions" className="rounded-xl border border-border bg-surface/50 p-5 space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="text-lg font-semibold">Artifact versions</h3><p className="text-sm text-textMuted">Inspect exact saved files, analysis versions, and private workflow outputs. Full analysis objects stay in storage.</p></div>
      <button type="button" className="btn btn-secondary text-sm" disabled={loading} onClick={() => refresh()}>{loading ? 'Refreshing artifacts…' : 'Refresh artifacts'}</button>
    </div>
    {canWrite && <form onSubmit={submit} className="rounded-lg border border-border p-3 space-y-3" aria-label="Import artifact version">
      <div className="grid gap-3 sm:grid-cols-2"><label className="text-sm">Artifact file<input aria-label="Artifact file" className="block w-full mt-1 text-sm" type="file" onChange={event => setFile(event.target.files?.[0] || null)} disabled={importing} /></label>
        <label className="text-sm">Artifact name<input className="input mt-1 w-full" value={name} maxLength={160} placeholder="Use the file name" onChange={event => setName(event.target.value)} disabled={importing} /></label>
      </div>
      <div className="flex flex-wrap items-center gap-3"><label className="text-sm">Artifact purpose<select aria-label="Artifact purpose" className="input ml-2" value={artifactType} onChange={event => setArtifactType(event.target.value)} disabled={importing}><option value="auto">Detect from file</option><option value="sample-sheet">Sample sheet (CSV/TSV)</option></select></label>
        {canReplace && <label className="text-sm flex items-center gap-2"><input type="checkbox" checked={replacement} onChange={event => setReplacement(event.target.checked)} disabled={importing} />New version of selected artifact</label>}
        <button className="btn btn-primary text-sm" disabled={!file || importing}>{importing ? 'Importing artifact…' : replacement ? 'Save new artifact version' : 'Import artifact'}</button>
      </div>
      <p className="text-xs text-textMuted">Imports stay private. Replacing a managed file saves a new version and retains earlier contents. RDS files open only in an appropriate private runtime.</p>
    </form>}
    {error && <p role="alert" className="text-danger text-sm">{error}</p>}
    <div className="grid gap-4 lg:grid-cols-[minmax(220px,1fr)_minmax(0,2fr)]">
      <div className="space-y-2 max-h-[600px] overflow-y-auto" aria-label="Available artifact versions">{items.map(item => <button key={item.versionId} type="button" className={`w-full rounded-lg border p-3 text-left ${selected?.versionId === item.versionId ? 'border-primary bg-primary/5' : 'border-border bg-surface'}`} onClick={() => inspect(item)}>
        <span className="block font-medium text-sm break-words">{item.name}{item.versionNumber ? ` · v${item.versionNumber}` : ''}</span>
        <span className="block text-xs text-textMuted">{item.type} · {bytesLabel(item.sizeBytes)}</span>
        <span className="block text-xs text-textMuted break-all">{item.versionId}</span>
      </button>)}
        {!loading && items.length === 0 && <p className="text-sm text-textMuted">No saved artifact files are available for your workspace yet.</p>}
        {nextCursor && <button className="btn btn-secondary text-sm" disabled={loading} onClick={() => refresh(nextCursor)}>More artifact versions</button>}
      </div>
      <div className="min-w-0 space-y-3">{selected ? <>
        <h4 className="font-semibold">{selected.name}{selected.versionNumber ? ` · v${selected.versionNumber}` : ''}</h4>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
          <dt className="text-textMuted">Format</dt><dd className="break-all">{selected.format.id} · {selected.format.version}</dd>
          <dt className="text-textMuted">Size</dt><dd>{bytesLabel(selected.sizeBytes)}</dd>
          <dt className="text-textMuted">Owner</dt><dd>{selected.owner.displayName}</dd>
          <dt className="text-textMuted">Source run</dt><dd className="break-all">{selected.sourceRunId || 'Imported file'}</dd>
          <dt className="text-textMuted">Version</dt><dd className="break-all">{selected.versionId}</dd>
          <dt className="text-textMuted">SHA-256</dt><dd className="break-all font-mono text-xs">{selected.sha256}</dd>
          <dt className="text-textMuted">Previews</dt><dd>{selected.previews.join(', ') || 'Metadata only'}</dd>
        </dl>
        <button type="button" className="btn btn-secondary text-xs" onClick={async () => {
          try { await navigator.clipboard.writeText(JSON.stringify(selected.reference)); setCopied(true); }
          catch { setError('Reference could not be copied. Select it in the details below.'); }
        }}>{copied ? 'Artifact reference copied' : 'Copy artifact reference'}</button>
        <details className="text-xs"><summary>Exact artifact reference</summary><pre className="mt-2 whitespace-pre-wrap break-all">{JSON.stringify(selected.reference, null, 2)}</pre></details>
        {inspecting && <p role="status" className="text-sm text-textMuted">Verifying saved bytes and loading a bounded preview…</p>}
        {preview?.integrityVerified && <p role="status" className="text-xs text-success">Saved checksum verified · preview from this exact version</p>}
        {data?.family === 'metadata' && <p className="text-sm text-textMuted">{data.message}</p>}
        {data?.family === 'text' && <><pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded border border-border p-3 text-xs">{data.text}</pre>{data.truncated && <p className="text-xs text-textMuted">Bounded text preview; additional contents remain in storage.</p>}</>}
        {data?.family === 'image' && <figure><img src={artifactImageUrl(projectId, selected.versionId)} alt={`Preview of ${selected.name}`} className="max-h-80 max-w-full object-contain bg-white" onError={() => { setPreview(null); setError('The image preview is unavailable or its integrity check failed.'); }} /><figcaption className="mt-1 text-xs text-textMuted">{data.width} × {data.height} pixels · bounded raster preview</figcaption></figure>}
        {data?.family === 'table' && <>
          <div className="max-h-80 overflow-auto rounded border border-border"><table className="w-full text-left text-xs"><thead><tr>{data.columns.map(column => <th className="p-2" key={column}>{column}</th>)}</tr></thead><tbody>{data.rows.map((row, index) => <tr key={data.offset + index}>{row.map((cell, column) => <td className="border-t border-border p-2 whitespace-pre-wrap" key={column}>{cell}</td>)}</tr>)}</tbody></table></div>
          <div className="flex flex-wrap items-center gap-3 text-xs"><button type="button" className="btn btn-secondary text-xs" disabled={inspecting || data.offset === 0} onClick={() => inspect(selected, Math.max(0, data.offset - data.limit))}>Previous rows</button><span>Rows {data.offset + (data.rows.length ? 1 : 0)}–{data.offset + data.rows.length}</span><button type="button" className="btn btn-secondary text-xs" disabled={inspecting || !data.hasMore} onClick={() => inspect(selected, data.offset + data.limit)}>Next rows</button>
            <label>Rows per page<select aria-label="Rows per page" className="input ml-2" value={pageSize} onChange={event => { const size = Number(event.target.value); setPageSize(size); inspect(selected, 0, size); }}>{[1, 10, 25, 50, 100].map(size => <option key={size} value={size}>{size}</option>)}</select></label>
          </div>
        </>}
      </> : <p className="text-sm text-textMuted">Select an exact artifact version to inspect its metadata and preview.</p>}</div>
    </div>
  </section>;
}
