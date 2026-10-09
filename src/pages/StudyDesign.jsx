import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { FlaskConical, Link2, Loader2, RefreshCw } from 'lucide-react';
import { publicErrorMessage } from '../publicError';
import PageHeader from '../components/PageHeader';

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
  const formId = useId();
  const selectIds = {
    savedVersion: `${formId}-saved-version`,
    sampleCondition: `${formId}-sample-condition`,
    modality: `${formId}-modality`,
    boundSample: `${formId}-bound-sample`,
    numeratorCondition: `${formId}-numerator-condition`,
    denominatorCondition: `${formId}-denominator-condition`,
    replicationUnit: `${formId}-replication-unit`,
  };
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
  const mappingsReady = bindingsContext?.projectId === projectId && bindingsContext?.objectId === objectId;
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
    if (!canWriteStudyDesign || busy) return;
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
    <div className="h-full overflow-y-auto p-4 sm:p-6 bg-background text-text">
      <div className="max-w-6xl mx-auto space-y-5">
        <PageHeader title="Study Design" icon={FlaskConical} description="Register biological samples, map their cells, and define replication before condition-level inference." actions={
          <button type="button" className="btn btn-secondary" onClick={() => void refresh()} disabled={!!busy}><RefreshCw size={16} /> Refresh</button>
        } />
        {error && <div role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">{error}</div>}
        {!canWriteStudyDesign && <div className="rounded-lg border border-border bg-surface p-3 text-sm text-textMuted">Study design is read-only for your project role. An owner, administrator, or analyst can change conditions, samples, mappings, and comparisons.</div>}
        {singleSampleWarning && <div role="status" className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">This analysis contains one <code>{singleSampleWarning}</code> group. Map cells through a metadata column that distinguishes independent biological samples before condition-level inference.</div>}
        {conditionComparisonStarted && <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-300">Condition comparison started. Track it in Runs &amp; Results.</div>}
        <div className="block text-sm"><label className="block" htmlFor={selectIds.savedVersion}>Saved version</label><select id={selectIds.savedVersion} className="input mt-1 w-full" value={objectId} onChange={(event) => setObjectId(event.target.value)}><option value="">Select a saved version</option>{objects.map((object) => <option key={object.id} value={object.id}>{object.displayName || object.name || 'Saved version'}</option>)}</select></div>

        <fieldset disabled={!canWriteStudyDesign} className="space-y-4 min-w-0">
          <form className="card min-w-0 p-4 space-y-3" onSubmit={createCondition}>
            <h3 className="font-semibold">1. Conditions</h3>
            <div className="flex flex-wrap gap-2">{conditions.map((item) => <span className="max-w-full break-words rounded-full border border-border bg-background px-3 py-1 text-sm" key={item.id}>{item.name}</span>)}</div>
            <div className="flex max-w-2xl flex-col sm:flex-row sm:items-end gap-3">
              <label className="block min-w-0 flex-1 space-y-1 text-sm"><span>Condition name</span><input className="input w-full" placeholder="e.g. treated" value={conditionName} onChange={(event) => setConditionName(event.target.value)} /></label>
              <button className="btn btn-primary w-full sm:w-fit shrink-0" disabled={!!busy || !conditionName.trim()}>{busy === 'condition' && <Loader2 size={14} className="animate-spin" />}Add condition</button>
            </div>
          </form>

          <section className="card min-w-0 p-4 space-y-3" aria-labelledby={formId + '-samples-heading'}>
            <h3 id={formId + '-samples-heading'} className="font-semibold">2. Biological samples</h3>
            <p className="text-sm text-textMuted">{samples.length} registered sample{samples.length === 1 ? '' : 's'}. Donor and condition assignments define the independent replicates.</p>
            {samples.length > 0 && <div className="overflow-x-auto rounded border border-border" tabIndex={0} aria-label="Registered biological samples">
              <table className="w-full min-w-[540px] text-left text-sm">
                <thead className="bg-background text-textMuted"><tr><th className="p-3 font-medium">Sample</th><th className="p-3 font-medium">Condition</th><th className="p-3 font-medium">Donor</th><th className="p-3 font-medium">Batch</th><th className="p-3 font-medium">Modality</th></tr></thead>
                <tbody className="divide-y divide-border">{samples.map((item) => <tr key={item.id}>
                  <th scope="row" className="p-3 font-medium break-words">{item.name}</th>
                  <td className="p-3 break-words">{item.conditionName || conditions.find((condition) => condition.id === item.conditionId)?.name || 'Not assigned'}</td>
                  <td className="p-3 break-words">{item.donorCode || 'Not specified'}</td><td className="p-3 break-words">{item.batch || 'Not specified'}</td>
                  <td className="p-3">{item.modality === 'spatial' ? 'Spatial (metadata only)' : item.modality === 'scrna' ? 'Single-cell RNA' : 'Not specified'}</td>
                </tr>)}</tbody>
              </table>
            </div>}
            <details open={samples.length === 0}>
              <summary className="cursor-pointer text-sm font-medium">Add a biological sample</summary>
              <div className="mt-3">          <form className="grid min-w-0 grid-cols-1 sm:grid-cols-2 gap-3" onSubmit={createSample}><label className="block space-y-1 text-sm"><span>Sample name</span><input className="input w-full" value={sample.name} onChange={(event) => setSample({ ...sample, name: event.target.value })} /></label><div className="block space-y-1 text-sm"><label htmlFor={selectIds.sampleCondition}>Condition</label><select id={selectIds.sampleCondition} className="input w-full" value={sample.conditionId} onChange={(event) => setSample({ ...sample, conditionId: event.target.value })}><option value="">Select a condition</option>{conditions.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div><div className="grid min-w-0 grid-cols-1 sm:grid-cols-2 gap-2"><label className="block min-w-0 space-y-1 text-sm"><span>Donor code</span><input className="input w-full" value={sample.donorCode} onChange={(event) => setSample({ ...sample, donorCode: event.target.value })} /></label><label className="block min-w-0 space-y-1 text-sm"><span>Batch</span><input className="input w-full" value={sample.batch} onChange={(event) => setSample({ ...sample, batch: event.target.value })} /></label></div><div className="block space-y-1 text-sm"><label htmlFor={selectIds.modality}>Modality</label><select id={selectIds.modality} className="input w-full" value={sample.modality} onChange={(event) => setSample({ ...sample, modality: event.target.value })}><option value="scrna">Single-cell RNA</option><option value="spatial">Spatial (metadata only)</option></select></div><div className="sm:col-span-2"><button className="btn btn-primary text-sm w-full sm:w-fit sm:self-start" disabled={!!busy || !sample.name.trim() || !sample.conditionId}>Add sample</button></div></form></div>
            </details>
          </section>

          <form className="card min-w-0 p-4 grid grid-cols-1 sm:grid-cols-2 gap-3" onSubmit={createBinding}><h3 className="sm:col-span-2 font-semibold flex items-center gap-2"><Link2 size={16} />3. Map cells to samples</h3><div className="block space-y-1 text-sm"><label htmlFor={selectIds.boundSample}>Biological sample</label><select id={selectIds.boundSample} className="input w-full" value={binding.sampleId} onChange={(event) => setBinding({ ...binding, sampleId: event.target.value })}><option value="">Select a sample</option>{samples.map((item) => <option key={item.id} value={item.id}>{item.name} ({item.conditionName})</option>)}</select></div><div className="grid min-w-0 grid-cols-1 sm:grid-cols-2 gap-2 sm:col-span-2"><label className="block min-w-0 space-y-1 text-sm"><span>Cell metadata column</span><input className="input w-full" value={binding.cellMetadataColumn} onChange={(event) => setBinding({ ...binding, cellMetadataColumn: event.target.value })} /></label><label className="block min-w-0 space-y-1 text-sm"><span>Cell metadata value</span><input className="input w-full" placeholder="Exact value" value={binding.cellMetadataValue} onChange={(event) => setBinding({ ...binding, cellMetadataValue: event.target.value })} /></label></div><button className="btn btn-primary text-sm w-full sm:w-fit sm:justify-self-start" disabled={!!busy || !objectId || !binding.sampleId || !binding.cellMetadataColumn.trim() || !binding.cellMetadataValue.trim()}>Bind sample</button><div className="sm:col-span-2 space-y-2" aria-label="Current sample mappings"><h4 className="text-sm font-medium">Current mappings for this saved version</h4>{!mappingsReady ? <p className="text-sm text-textMuted">{busy === 'refresh' ? 'Loading mappings…' : 'Mappings unavailable for this saved version. Refresh to try again.'}</p> : bindings.length === 0 ? <p className="text-sm text-textMuted">No samples mapped yet.</p> : <ul className="grid gap-2 sm:grid-cols-2">{bindings.map((item) => <li key={item.id} className="rounded border border-border bg-background px-3 py-2 text-sm break-words"><span className="font-medium">{item.sampleName}</span><span className="block text-textMuted"><code>{item.cellMetadataColumn}</code> = {item.cellMetadataValue}</span></li>)}</ul>}</div></form>

          <form className="card min-w-0 p-4 grid grid-cols-1 sm:grid-cols-2 gap-3" onSubmit={createContrast}><h3 className="sm:col-span-2 font-semibold">4. Condition comparison</h3><label className="block space-y-1 text-sm"><span>Contrast name</span><input className="input w-full" value={contrast.name} onChange={(event) => setContrast({ ...contrast, name: event.target.value })} /></label><div className="grid min-w-0 grid-cols-1 sm:grid-cols-2 gap-2"><div className="block min-w-0 space-y-1 text-sm"><label htmlFor={selectIds.numeratorCondition}>Numerator condition</label><select id={selectIds.numeratorCondition} className="input w-full" value={contrast.numeratorConditionId} onChange={(event) => setContrast({ ...contrast, numeratorConditionId: event.target.value })}><option value="">Select condition</option>{conditions.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div><div className="block min-w-0 space-y-1 text-sm"><label htmlFor={selectIds.denominatorCondition}>Denominator condition</label><select id={selectIds.denominatorCondition} className="input w-full" value={contrast.denominatorConditionId} onChange={(event) => setContrast({ ...contrast, denominatorConditionId: event.target.value })}><option value="">Select condition</option>{conditions.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div></div><label className="block space-y-1 text-sm"><span>Cell type column</span><input className="input w-full" value={contrast.cellTypeColumn} onChange={(event) => setContrast({ ...contrast, cellTypeColumn: event.target.value })} /></label><div className="block space-y-1 text-sm"><label htmlFor={selectIds.replicationUnit}>Replication unit</label><select id={selectIds.replicationUnit} className="input w-full" value={contrast.unitOfReplication} onChange={(event) => setContrast({ ...contrast, unitOfReplication: event.target.value, paired: event.target.value === 'donor' ? contrast.paired : false })}><option value="sample">Independent samples</option><option value="donor">Independent donors</option></select></div><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={contrast.paired} disabled={contrast.unitOfReplication !== 'donor'} onChange={(event) => setContrast({ ...contrast, paired: event.target.checked })} />Paired by donor</label><p className="sm:col-span-2 rounded border border-border bg-background p-2 text-xs text-textMuted">Model: <code>{contrast.paired ? '~ donor + condition' : '~ condition'}</code>. Batch values are retained as metadata but are not included in this model.</p><button className="btn btn-primary text-sm w-full sm:w-fit sm:col-span-2 sm:justify-self-start" disabled={!!busy || !objectId || !contrast.name.trim() || !contrast.numeratorConditionId || !contrast.denominatorConditionId}>Save comparison design</button></form>
        </fieldset>

        <div className="card p-4"><h3 className="font-semibold mb-3">Saved contrasts</h3>{contrasts.length === 0 ? <p className="text-sm text-slate-400">No contrast snapshots yet.</p> : <div className="space-y-2">{contrasts.map((item) => <div key={item.id} className="rounded border border-border p-3 text-sm"><div className="flex justify-between gap-3"><strong>{item.name}</strong><span className={`badge ${item.status === 'invalid' ? 'text-red-700 dark:text-red-300' : item.status === 'warning' ? 'text-amber-700 dark:text-amber-300' : 'text-emerald-700 dark:text-emerald-300'}`}>{item.status}</span></div><p className="text-slate-400">{item.numeratorConditionName} vs {item.denominatorConditionName} · {item.unitOfReplication}-level · {item.cellTypeColumn}</p><p className="mt-1 text-xs text-textMuted">Model: <code>{item.modelFormula || (item.paired ? '~ donor + condition' : '~ condition')}</code></p>{item.validation?.issues?.map((issue) => <p className="text-red-700 dark:text-red-300 text-xs mt-1" key={issue}>{issue}</p>)}{item.validation?.warnings?.map((warning) => <p className="text-amber-700 dark:text-amber-300 text-xs mt-1" key={warning}>{warning}</p>)}<button type="button" className="btn btn-secondary text-xs mt-2" disabled={!canWriteStudyDesign || item.status === 'invalid' || !!busy} onClick={() => runContrast(item)}>Run edgeR pseudobulk</button></div>)}</div>}</div>
      </div>
    </div>
  );
}
