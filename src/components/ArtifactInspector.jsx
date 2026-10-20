import React, { useCallback, useEffect, useRef, useState } from 'react';
import { importArtifactVersion, listArtifactVersions } from '../artifacts/artifactApi';
import { artifactBytesLabel as bytesLabel } from '../artifacts/privateRArtifactPolicy';
import ServerDataImporter from './ServerDataImporter';
import RetainedArtifactView from './RetainedArtifactView';
import useExecutionTarget from '../runtime/useExecutionTarget';

function ArtifactInspectorScope({ projectId, canWrite = false, userId }) {
  const [items, setItems] = useState([]);
  const [nextCursor, setNextCursor] = useState(null);
  const [selected, setSelected] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [file, setFile] = useState(null);
  const [name, setName] = useState('');
  const [artifactType, setArtifactType] = useState('auto');
  const [replacement, setReplacement] = useState(false);
  const [inspection, setInspection] = useState(0);
  const listRequest = useRef(null);
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
        if ([401, 403, 404].includes(failure.status)) { setItems([]); setSelected(null); setNextCursor(null); }
      }
    }
    finally { if (!controller.signal.aborted) setLoading(false); }
  }, [projectId]);

  useEffect(() => {
    setItems([]); setSelected(null); setNextCursor(null); setError(''); setFile(null); setName(''); setReplacement(false); setImporting(false);
    refresh();
    return () => { listRequest.current?.abort(); importRequest.current?.abort(); };
  }, [refresh]);

  const inspect = version => { setSelected(version); setInspection(value => value + 1); setError(''); setReplacement(false); };

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
    {canWrite && <ServerDataImporter projectId={projectId} userId={userId} onImported={async version => { await refresh(); if (projectRef.current === projectId) await inspect(version); }} />}
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
      <div className="min-w-0 space-y-3">{selected ? <RetainedArtifactView key={`${selected.versionId}:${inspection}`} projectId={projectId} userId={userId}
        reference={{ kind: 'artifact-version', versionId: selected.versionId, sha256: selected.sha256 }} />
        : <p className="text-sm text-textMuted">Select an exact artifact version to inspect its metadata and preview.</p>}</div>
    </div>
  </section>;
}

export default function ArtifactInspector(props) {
  const connection = useExecutionTarget();
  if (connection.blocked) return <p role="status" className="text-sm text-textMuted">Reconnect to this workspace to inspect saved artifact versions.</p>;
  return <ArtifactInspectorScope key={JSON.stringify([props.userId ?? null, connection.identity, connection.epoch, props.projectId])} {...props} />;
}
