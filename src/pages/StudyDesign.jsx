import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlaskConical, Link2, Loader2, RefreshCw } from 'lucide-react';
import { publicErrorMessage } from '../publicError';

function errorMessage(error) {
  if (error?.code === 'UNSUPPORTED_CONDITION_MODEL') {
    return 'Adjusted condition models are not available yet. This release supports only ~ condition, or ~ donor + condition for paired donors.';
  }
  if (error?.code === 'METADATA_VALUE_ALREADY_BOUND') {
    return 'This metadata group is already mapped to a biological sample. One metadata value cannot represent multiple independent samples. Load a multi-sample analysis or use a metadata column that distinguishes samples.';
  }
  if (error?.code === 'SAMPLE_ALREADY_BOUND') {
    return 'This biological sample is already mapped to this analysis. Choose a different sample or review the existing mapping.';
  }
  return publicErrorMessage(error, 'Study-design operation failed. Review the settings and try again.');
}

export default function StudyDesign({ currentWs, datasetInfo, userId, callApi }) {
  const projectId = datasetInfo?.projectId || currentWs?.selectedProjectId || currentWs?.projects?.[0]?.id || null;
  const activeProject = (currentWs?.projects || []).find((project) => project.id === projectId);
  const canWriteStudyDesign = ['owner', 'admin', 'analyst'].includes(activeProject?.role);
  const objects = useMemo(
    () => (currentWs?.objects || []).filter((object) => object.projectId === projectId),
    [currentWs?.objects, projectId]
  );
  const [conditions, setConditions] = useState([]);
  const [samples, setSamples] = useState([]);
  const [contrasts, setContrasts] = useState([]);
  const [bindings, setBindings] = useState([]);
  const [bindingsContext, setBindingsContext] = useState(null);
  const designRequestRef = useRef(0);
  const [objectId, setObjectId] = useState(datasetInfo?.id || '');
  const [conditionName, setConditionName] = useState('');
  const [sample, setSample] = useState({ name: '', conditionId: '', donorCode: '', batch: '', modality: 'scrna' });
  const [binding, setBinding] = useState({ sampleId: '', cellMetadataColumn: 'orig.ident', cellMetadataValue: '' });
  const emptyContrast = { name: '', numeratorConditionId: '', denominatorConditionId: '', unitOfReplication: 'sample', paired: false, cellTypeColumn: 'seurat_clusters' };
  const [contrast, setContrast] = useState(emptyContrast);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [conditionComparisonStarted, setConditionComparisonStarted] = useState(false);
  const [singleSampleWarning, setSingleSampleWarning] = useState(null);

  const refresh = useCallback(async () => {
    if (!projectId || !window.electronAPI?.listStudyConditions) return;
    const request = ++designRequestRef.current;
    setBindingsContext(null);
    setSingleSampleWarning(null);
    setBusy('refresh'); setError('');
    try {
      const [nextConditions, nextSamples, nextContrasts, nextBindings] = await Promise.all([
        window.electronAPI.listStudyConditions(projectId),
        window.electronAPI.listBiologicalSamples(projectId),
        window.electronAPI.listConditionContrasts(projectId),
        objectId ? window.electronAPI.listAnalysisObjectSampleBindings(projectId, objectId) : [],
      ]);
      if (request !== designRequestRef.current) return;
      setConditions(nextConditions || []); setSamples(nextSamples || []); setContrasts(nextContrasts || []);
      setBindings(nextBindings || []);
      setBindingsContext({ projectId, objectId });
    } catch (loadError) {
      if (request === designRequestRef.current) setError(errorMessage(loadError));
    } finally {
      if (request === designRequestRef.current) setBusy('');
    }
  }, [objectId, projectId]);

  useEffect(() => {
    void refresh();
    return () => { designRequestRef.current += 1; };
  }, [refresh]);
  useEffect(() => { if (datasetInfo?.id) setObjectId(datasetInfo.id); }, [datasetInfo?.id]);
  useEffect(() => {
    let cancelled = false;
    setSingleSampleWarning(null);
    const workspaceSelected = objects.find((object) => object.id === objectId);
    const selected = datasetInfo?.id === objectId
      ? { ...(workspaceSelected || {}), ...datasetInfo }
      : workspaceSelected;
    const canInspectPrivateObject = datasetInfo?.id === objectId
      && bindingsContext?.projectId === projectId
      && bindingsContext?.objectId === objectId
      && selected?.liveState === 'attached'
      && Number(selected?.ownerUserId) === Number(userId)
      && typeof callApi === 'function';
    if (!canInspectPrivateObject) return () => { cancelled = true; };

    const mappedColumns = [...new Set(bindings.map((item) => item.cellMetadataColumn).filter(Boolean))];
    // Mixed-column mappings are validated by the saved contrast rather than this single-column hint.
    if (mappedColumns.length > 1) return () => { cancelled = true; };
    const column = mappedColumns[0] || 'orig.ident';
    void callApi('/meta-values?column=' + encodeURIComponent(column)).then((result) => {
      if (!cancelled) setSingleSampleWarning(Number(result?.n_unique) === 1 ? column : null);
    }).catch(() => {
      if (!cancelled) setSingleSampleWarning(null);
    });
    return () => { cancelled = true; };
  }, [bindings, bindingsContext, callApi, datasetInfo, objectId, objects, projectId, userId]);

  const mutate = async (key, action) => {
    if (!canWriteStudyDesign) return;
    setBusy(key); setError('');
    try { await action(); await refresh(); } catch (mutationError) { setError(errorMessage(mutationError)); } finally { setBusy(''); }
  };

  const createCondition = (event) => {
    event.preventDefault();
    if (!conditionName.trim()) return;
    void mutate('condition', async () => {
      await window.electronAPI.createStudyCondition(projectId, { name: conditionName.trim() });
      setConditionName('');
    });
  };

  const createSample = (event) => {
    event.preventDefault();
    if (!sample.name.trim() || !sample.conditionId) return;
    void mutate('sample', async () => {
      await window.electronAPI.createBiologicalSample(projectId, { ...sample, name: sample.name.trim() });
      setSample({ name: '', conditionId: '', donorCode: '', batch: '', modality: 'scrna' });
    });
  };

  const createBinding = (event) => {
    event.preventDefault();
    if (!objectId || !binding.sampleId || !binding.cellMetadataColumn.trim() || !binding.cellMetadataValue.trim()) return;
    void mutate('binding', async () => {
      await window.electronAPI.bindSampleToAnalysisObject(projectId, objectId, binding);
      setBinding({ sampleId: '', cellMetadataColumn: binding.cellMetadataColumn, cellMetadataValue: '' });
    });
  };

  const createContrast = (event) => {
    event.preventDefault();
    if (!objectId || !contrast.name.trim() || !contrast.numeratorConditionId || !contrast.denominatorConditionId) return;
    void mutate('contrast', async () => {
      await window.electronAPI.createConditionContrast(projectId, { ...contrast, name: contrast.name.trim(), analysisObjectId: objectId });
      setContrast(emptyContrast);
    });
  };

  const runContrast = (item) => void mutate(`run-${item.id}`, async () => {
    setConditionComparisonStarted(false);
    await window.electronAPI.createProjectJob(projectId, {
      jobType: 'condition.pseudobulk_de.v1', analysisObjectId: item.analysisObjectId,
      parameters: { contrastId: item.id },
    });
    setConditionComparisonStarted(true);
  });

  if (!projectId) return <div className="p-8 text-slate-400">Select a project to define its study design.</div>;

  return (
    <div className="h-full overflow-y-auto p-6 bg-background text-text">
      <div className="max-w-6xl mx-auto space-y-5">
        <div className="flex items-start justify-between gap-4">
          <div><h2 className="text-xl font-semibold flex items-center gap-2"><FlaskConical size={20} />Study Design</h2><p className="text-sm text-slate-400 mt-1">Register explicit biological samples and replication before condition-level inference.</p></div>
          <button type="button" className="btn btn-secondary text-sm" onClick={() => void refresh()} disabled={!!busy}><RefreshCw size={15} /> Refresh</button>
        </div>
        {error && <div role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">{error}</div>}
        {!canWriteStudyDesign && <div className="rounded-lg border border-border bg-surface p-3 text-sm text-textMuted">Study design is read-only for your project role. An owner, administrator, or analyst can change conditions, samples, mappings, and comparisons.</div>}
        {singleSampleWarning && <div role="status" className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">This analysis contains one <code>{singleSampleWarning}</code> group. Map cells through a metadata column that distinguishes independent biological samples before condition-level inference.</div>}
        {conditionComparisonStarted && <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-300">Condition comparison started. Track it in Runs &amp; Results.</div>}
        <label className="block text-sm">Saved version<select className="input mt-1 w-full" value={objectId} onChange={(event) => setObjectId(event.target.value)}><option value="">Select a saved version</option>{objects.map((object) => <option key={object.id} value={object.id}>{object.displayName || object.name || 'Saved version'}</option>)}</select></label>

        <fieldset disabled={!canWriteStudyDesign} className="grid gap-4 lg:grid-cols-2 disabled:opacity-70">
          <form className="card p-4 space-y-3" onSubmit={createCondition}><h3 className="font-semibold">1. Conditions</h3><input className="input w-full" aria-label="Condition name" placeholder="e.g. treated" value={conditionName} onChange={(event) => setConditionName(event.target.value)} /><button className="btn btn-primary text-sm" disabled={busy === 'condition'}>{busy === 'condition' && <Loader2 size={14} className="animate-spin" />}Add condition</button><div className="flex flex-wrap gap-2">{conditions.map((item) => <span className="badge" key={item.id}>{item.name}</span>)}</div></form>

          <form className="card p-4 space-y-3" onSubmit={createSample}><h3 className="font-semibold">2. Biological samples</h3><input className="input w-full" aria-label="Sample name" placeholder="Sample name" value={sample.name} onChange={(event) => setSample({ ...sample, name: event.target.value })} /><select className="input w-full" aria-label="Sample condition" value={sample.conditionId} onChange={(event) => setSample({ ...sample, conditionId: event.target.value })}><option value="">Condition</option>{conditions.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><div className="grid grid-cols-2 gap-2"><input className="input" aria-label="Donor code" placeholder="Donor code" value={sample.donorCode} onChange={(event) => setSample({ ...sample, donorCode: event.target.value })} /><input className="input" aria-label="Batch" placeholder="Batch" value={sample.batch} onChange={(event) => setSample({ ...sample, batch: event.target.value })} /></div><select className="input w-full" aria-label="Modality" value={sample.modality} onChange={(event) => setSample({ ...sample, modality: event.target.value })}><option value="scrna">Single-cell RNA</option><option value="spatial">Spatial (metadata only)</option></select><button className="btn btn-primary text-sm" disabled={busy === 'sample'}>Add sample</button><p className="text-xs text-slate-400">{samples.length} registered sample{samples.length === 1 ? '' : 's'}</p></form>

          <form className="card p-4 space-y-3" onSubmit={createBinding}><h3 className="font-semibold flex items-center gap-2"><Link2 size={16} />3. Map cells to samples</h3><select className="input w-full" aria-label="Bound sample" value={binding.sampleId} onChange={(event) => setBinding({ ...binding, sampleId: event.target.value })}><option value="">Sample</option>{samples.map((item) => <option key={item.id} value={item.id}>{item.name} ({item.conditionName})</option>)}</select><div className="grid grid-cols-2 gap-2"><input className="input" aria-label="Metadata column" value={binding.cellMetadataColumn} onChange={(event) => setBinding({ ...binding, cellMetadataColumn: event.target.value })} /><input className="input" aria-label="Metadata value" placeholder="Exact value" value={binding.cellMetadataValue} onChange={(event) => setBinding({ ...binding, cellMetadataValue: event.target.value })} /></div><button className="btn btn-primary text-sm" disabled={busy === 'binding' || !objectId}>Bind sample</button><div className="text-xs text-slate-400 space-y-1">{bindings.map((item) => <div key={item.id}>{item.sampleName}: {item.cellMetadataColumn} = {item.cellMetadataValue}</div>)}</div></form>

          <form className="card p-4 space-y-3" onSubmit={createContrast}><h3 className="font-semibold">4. Condition comparison</h3><input className="input w-full" aria-label="Contrast name" placeholder="Contrast name" value={contrast.name} onChange={(event) => setContrast({ ...contrast, name: event.target.value })} /><div className="grid grid-cols-2 gap-2"><select className="input" aria-label="Numerator condition" value={contrast.numeratorConditionId} onChange={(event) => setContrast({ ...contrast, numeratorConditionId: event.target.value })}><option value="">Numerator</option>{conditions.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><select className="input" aria-label="Denominator condition" value={contrast.denominatorConditionId} onChange={(event) => setContrast({ ...contrast, denominatorConditionId: event.target.value })}><option value="">Denominator</option>{conditions.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div><input className="input w-full" aria-label="Cell type column" value={contrast.cellTypeColumn} onChange={(event) => setContrast({ ...contrast, cellTypeColumn: event.target.value })} /><select className="input w-full" aria-label="Replication unit" value={contrast.unitOfReplication} onChange={(event) => setContrast({ ...contrast, unitOfReplication: event.target.value, paired: event.target.value === 'donor' ? contrast.paired : false })}><option value="sample">Independent samples</option><option value="donor">Independent donors</option></select><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={contrast.paired} disabled={contrast.unitOfReplication !== 'donor'} onChange={(event) => setContrast({ ...contrast, paired: event.target.checked })} />Paired by donor</label><p className="rounded border border-border bg-background p-2 text-xs text-textMuted">Model: <code>{contrast.paired ? '~ donor + condition' : '~ condition'}</code>. Batch values are retained as metadata but are not included in this model.</p><button className="btn btn-primary text-sm" disabled={busy === 'contrast' || !objectId}>Save comparison design</button></form>
        </fieldset>

        <div className="card p-4"><h3 className="font-semibold mb-3">Saved contrasts</h3>{contrasts.length === 0 ? <p className="text-sm text-slate-400">No contrast snapshots yet.</p> : <div className="space-y-2">{contrasts.map((item) => <div key={item.id} className="rounded border border-border p-3 text-sm"><div className="flex justify-between gap-3"><strong>{item.name}</strong><span className={`badge ${item.status === 'invalid' ? 'text-red-700 dark:text-red-300' : item.status === 'warning' ? 'text-amber-700 dark:text-amber-300' : 'text-emerald-700 dark:text-emerald-300'}`}>{item.status}</span></div><p className="text-slate-400">{item.numeratorConditionName} vs {item.denominatorConditionName} · {item.unitOfReplication}-level · {item.cellTypeColumn}</p><p className="mt-1 text-xs text-textMuted">Model: <code>{item.modelFormula || (item.paired ? '~ donor + condition' : '~ condition')}</code></p>{item.validation?.issues?.map((issue) => <p className="text-red-700 dark:text-red-300 text-xs mt-1" key={issue}>{issue}</p>)}{item.validation?.warnings?.map((warning) => <p className="text-amber-700 dark:text-amber-300 text-xs mt-1" key={warning}>{warning}</p>)}<button type="button" className="btn btn-secondary text-xs mt-2" disabled={!canWriteStudyDesign || item.status === 'invalid' || busy === `run-${item.id}`} onClick={() => runContrast(item)}>Run edgeR pseudobulk</button></div>)}</div>}</div>
      </div>
    </div>
  );
}
