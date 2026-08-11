import React, { useEffect, useMemo, useState } from 'react';
import { Code2, ShieldCheck } from 'lucide-react';
import { publicErrorMessage } from '../publicError';

const STARTER = `# Your saved Seurat analysis is available as obj.
# Selected private files are listed in input_manifest.
# Use read_input("metadata.csv") or input_path("metadata.csv") to open one.
# Write research outputs only through output_dir or the helpers below.
summary_table <- data.frame(
  cells = ncol(obj),
  features = nrow(obj),
  clusters = length(unique(obj$seurat_clusters))
)
write_table(summary_table, "object-summary.csv")

p <- Seurat::DimPlot(obj, reduction = "umap", group.by = "seurat_clusters")
save_figure(p, "umap-by-cluster.png", width = 8, height = 6)
`;

function messageFor(error) {
  return publicErrorMessage(error, 'Could not queue Expert R. Review the saved analysis and script, then try again.');
}

export default function ExpertR({ currentWs, datasetInfo, deploymentPolicy = {}, userId, setActiveTab, onExpertRSubmitted }) {
  const projectId = datasetInfo?.projectId || currentWs?.selectedProjectId || currentWs?.projects?.[0]?.id || null;
  const objects = useMemo(() => {
    const ownerId = Number(userId);
    if (!Number.isInteger(ownerId) || ownerId <= 0) return [];
    return (currentWs?.objects || []).filter((item) => (
      item.projectId === projectId && Number(item.ownerUserId) === ownerId
    ));
  }, [currentWs?.objects, projectId, userId]);
  const preferredObjectId = useMemo(() => (
    objects.some((item) => item.id === datasetInfo?.id) ? datasetInfo.id : ''
  ), [datasetInfo?.id, objects]);
  const [objectId, setObjectId] = useState(preferredObjectId);
  const [script, setScript] = useState(STARTER);
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState(null);
  const [error, setError] = useState('');
  const [privateInputs, setPrivateInputs] = useState([]);
  const [selectedInputIds, setSelectedInputIds] = useState([]);
  const [inputFile, setInputFile] = useState(null);
  const [inputBusy, setInputBusy] = useState(false);
  const profile = deploymentPolicy.expertRProfile;

  useEffect(() => {
    setObjectId((currentObjectId) => (
      objects.some((item) => item.id === currentObjectId) ? currentObjectId : preferredObjectId
    ));
  }, [objects, preferredObjectId]);

  useEffect(() => {
    let active = true;
    if (!projectId || !deploymentPolicy.expertREnabled
        || typeof window.electronAPI?.listExpertRInputs !== 'function') return undefined;
    window.electronAPI.listExpertRInputs(projectId).then((rows) => {
      if (!active) return;
      setPrivateInputs(Array.isArray(rows) ? rows : []);
    }).catch((loadError) => {
      if (active) setError(messageFor(loadError));
    });
    return () => { active = false; };
  }, [deploymentPolicy.expertREnabled, projectId]);

  const uploadInput = async () => {
    if (!inputFile) return;
    setInputBusy(true); setError('');
    try {
      const created = await window.electronAPI.uploadExpertRInput(projectId, inputFile);
      setPrivateInputs((current) => [created, ...current.filter((item) => item.id !== created.id)]);
      setSelectedInputIds((current) => current.length < 5 ? [...current, created.id] : current);
      setInputFile(null);
    } catch (uploadError) {
      setError(messageFor(uploadError));
    } finally {
      setInputBusy(false);
    }
  };

  const submit = async (event) => {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const created = await window.electronAPI.createProjectJob(projectId, {
        jobType: 'expert.r.v1', analysisObjectId: objectId,
        parameters: { profileId: profile.id, script, inputIds: selectedInputIds },
      });
      setJob(created);
      onExpertRSubmitted?.(created?.id);
    } catch (submitError) { setError(messageFor(submitError)); } finally { setBusy(false); }
  };

  if (!deploymentPolicy.expertREnabled || !profile) {
    return <div className="p-8 text-slate-400"><h2 className="text-xl text-text font-semibold">Expert R Workbench</h2><p className="mt-2">Expert R is not available for this account or deployment.</p></div>;
  }
  return (
    <div className="h-full overflow-y-auto p-6 bg-background text-text"><form className="max-w-5xl mx-auto space-y-4" onSubmit={submit}>
      <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-xl font-semibold flex gap-2 items-center"><Code2 size={20} />Expert R Workbench</h2><p className="text-sm text-slate-400 mt-1">Use R for custom exploratory analysis on a private saved analysis.</p></div><button className="btn btn-primary shrink-0" disabled={busy || !objectId || !script.trim()}>{busy ? 'Starting…' : 'Run R analysis'}</button></div>
      <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm"><div className="flex gap-2 items-center font-medium"><ShieldCheck size={16} />Private analysis workspace</div><p className="text-slate-400 mt-1">Your saved analysis opens in a fresh, time-limited R workspace. It cannot reach the network or files outside this analysis, and uses the packages listed below.</p></div>
      <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm"><p className="font-medium">Your results</p><p className="text-slate-400 mt-1">Create tables and figures to inspect or export. They stay private unless you choose to share them through Analysis Branches.</p></div>
      {error && <div role="alert" className="text-sm text-red-300">{error}</div>}
      {job && <div className="flex flex-wrap items-center gap-3 text-sm"><span role="status" aria-live="polite" className="text-success">Run submitted. Results will remain private until you choose to share them.</span><button type="button" className="btn btn-secondary text-xs" onClick={() => setActiveTab?.('history')}>View in Runs &amp; Results</button></div>}
      <label className="block text-sm">Saved analysis<select className="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-text shadow-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20" value={objectId} onChange={(event) => setObjectId(event.target.value)} disabled={objects.length === 0}><option value="">Select a saved analysis</option>{objects.map((item) => <option value={item.id} key={item.id}>{item.displayName || item.name || 'Saved analysis'}</option>)}</select></label>
      {objects.length === 0 && <p className="text-sm text-slate-400">No saved analysis you own is available for R work. Open a saved version or create a branch first.</p>}
      <section className="card p-4 space-y-3" aria-labelledby="expert-r-inputs-title">
        <div><h3 id="expert-r-inputs-title" className="font-medium">Private input files</h3><p className="mt-1 text-sm text-slate-400">Import bounded CSV, TSV, TXT, or JSON files. They stay private to you and are mounted read-only only for selected runs.</p></div>
        <div className="flex flex-wrap items-center gap-2">
          <input aria-label="Choose private input" type="file" accept=".csv,.tsv,.txt,.json" onChange={(event) => setInputFile(event.target.files?.[0] || null)} />
          <button type="button" className="btn btn-secondary text-xs" disabled={!inputFile || inputBusy} onClick={uploadInput}>{inputBusy ? 'Importing…' : 'Import file'}</button>
        </div>
        {privateInputs.length > 0 ? <div className="grid gap-2 sm:grid-cols-2">{privateInputs.map((input) => {
          const selected = selectedInputIds.includes(input.id);
          return <label key={input.id} className="flex items-start gap-2 rounded border border-border p-2 text-sm"><input type="checkbox" checked={selected} disabled={!selected && selectedInputIds.length >= 5} onChange={() => setSelectedInputIds((current) => selected ? current.filter((id) => id !== input.id) : [...current, input.id])} /><span><span className="block text-text">{input.originalFilename}</span><span className="text-xs text-slate-400">{Math.ceil(input.sizeBytes / 1024)} KiB</span></span></label>;
        })}</div> : <p className="text-sm text-slate-400">No private input files imported yet.</p>}
        <p className="text-xs text-slate-400">Selected for this run: {selectedInputIds.length}/5</p>
      </section>
      <label className="block text-sm">R script<textarea className="mt-1 min-h-[420px] w-full rounded-lg border border-border bg-surface p-3 font-mono text-xs leading-5 text-text shadow-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20" value={script} onChange={(event) => setScript(event.target.value)} spellCheck="false" /></label>
      <details className="card p-3 text-sm"><summary className="cursor-pointer">Available packages ({profile.packages.length})</summary><p className="text-slate-400 mt-2">{profile.packages.join(', ')}</p></details>
    </form></div>
  );
}
