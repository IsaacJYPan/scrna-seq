import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Code2, ShieldCheck } from 'lucide-react';
import { publicErrorMessage } from '../publicError';
import REnvironment from '../components/REnvironment';
import RConsole from '../components/RConsole';
import PageHeader from '../components/PageHeader';

const STARTER = `# Your saved Seurat analysis is available as obj.
# Selected private files are listed in input_manifest.
# Use read_input("metadata.csv") or input_path("metadata.csv") to open one.
# RDS inputs are untrusted and are deserialized only inside this isolated run.
# Write research outputs only through output_dir or the helpers below.
summary_table <- data.frame(
  cells = ncol(obj),
  features = nrow(obj),
  clusters = if ("seurat_clusters" %in% colnames(obj[[]])) length(unique(obj$seurat_clusters)) else NA_integer_
)
write_table(summary_table, "object-summary.csv")

if ("umap" %in% Seurat::Reductions(obj)) {
  group_column <- if ("seurat_clusters" %in% colnames(obj[[]])) "seurat_clusters" else NULL
  p <- Seurat::DimPlot(obj, reduction = "umap", group.by = group_column)
  save_figure(p, "umap-by-cluster.png", width = 8, height = 6)
}

# Optional: save a derived object as a private, untrusted Expert R artifact.
# save_workspace(obj, "derived-analysis.rds")
`;

function messageFor(error) {
  return publicErrorMessage(error, 'Could not queue Expert R. Review the saved analysis and script, then try again.');
}

const ACCESS_MESSAGES = {
  'not-configured': 'The isolated R runtime has not been configured for this installation.',
  unreachable: 'The isolated R runtime is unavailable. Ask the installation administrator to start or reconnect it, then check again.',
  incompatible: 'The R runtime does not match this installation’s supported profile. The installation administrator must update its image or connection credentials.',
  'access-required': 'Your account needs R execution access. An administrator can grant access, or an owner can give you an analyst role when project-role access is enabled.',
  'access-revoked': 'An administrator has revoked R execution for your account. Existing saved results remain available; new and queued R analyses cannot run.',
  'demo-disabled': 'Advanced analysis is intentionally unavailable in the public demo.',
};

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
  const [capability, setCapability] = useState(null);
  const [checkingRuntime, setCheckingRuntime] = useState(false);
  const capabilityRequest = useRef(0);
  const consoleDetails = useRef(null);
  const policy = capability || deploymentPolicy;
  const profile = policy.expertRProfile;

  useEffect(() => {
    let active = true;
    const requestId = ++capabilityRequest.current;
    setCapability(null); setPrivateInputs([]); setSelectedInputIds([]); setInputFile(null);
    if (typeof window.electronAPI?.getExpertRCapabilities !== 'function') { setCheckingRuntime(false); return undefined; }
    setCheckingRuntime(true);
    window.electronAPI.getExpertRCapabilities(projectId).then((value) => {
      if (active && capabilityRequest.current === requestId) setCapability(value);
    }).catch(() => {
      if (active && capabilityRequest.current === requestId) {
        setCapability({ expertREnabled: false, expertRProfile: null, expertRStatus: { state: 'unreachable' } });
        setError('R availability could not be checked. Check your connection and try again.');
      }
    }).finally(() => { if (active && capabilityRequest.current === requestId) setCheckingRuntime(false); });
    return () => { active = false; capabilityRequest.current += 1; };
  }, [projectId, userId]);

  const refreshCapability = async () => {
    if (typeof window.electronAPI?.getExpertRCapabilities !== 'function') return;
    const requestId = ++capabilityRequest.current;
    setCheckingRuntime(true); setError('');
    try {
      const value = await window.electronAPI.getExpertRCapabilities(projectId);
      if (capabilityRequest.current === requestId) setCapability(value);
    } catch {
      if (capabilityRequest.current === requestId) {
        setCapability({ expertREnabled: false, expertRProfile: null, expertRStatus: { state: 'unreachable' } });
        setError('R availability could not be checked. Check your connection and try again.');
      }
    } finally { if (capabilityRequest.current === requestId) setCheckingRuntime(false); }
  };

  useEffect(() => {
    setObjectId((currentObjectId) => (
      objects.some((item) => item.id === currentObjectId) ? currentObjectId : preferredObjectId
    ));
  }, [objects, preferredObjectId]);

  useEffect(() => {
    let active = true;
    if (!projectId || !policy.expertREnabled
        || typeof window.electronAPI?.listExpertRInputs !== 'function') return undefined;
    window.electronAPI.listExpertRInputs(projectId).then((rows) => {
      if (!active) return;
      setPrivateInputs(Array.isArray(rows) ? rows : []);
    }).catch((loadError) => {
      if (active) setError(messageFor(loadError));
    });
    return () => { active = false; };
  }, [policy.expertREnabled, projectId]);

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
    event.preventDefault();
    if (!policy.expertREnabled || !profile || checkingRuntime) return;
    setBusy(true); setError('');
    try {
      const created = await window.electronAPI.createProjectJob(projectId, {
        jobType: 'expert.r.v1', analysisObjectId: objectId,
        parameters: { profileId: profile.id, script, inputIds: selectedInputIds,
          ...(policy.expertREnvironment ? { environment: policy.expertREnvironment } : {}) },
      });
      setJob(created);
      onExpertRSubmitted?.(created?.id);
    } catch (submitError) { setError(messageFor(submitError)); } finally { setBusy(false); }
  };

  if (!policy.expertREnabled || !profile) {
    const status = policy.expertRStatus?.state;
    const publicDemo = deploymentPolicy.demoMode || status === 'demo-disabled';
    return (
      <div className="h-full overflow-y-auto bg-background p-8 text-textMuted">
        <div className="mx-auto max-w-2xl rounded-xl border border-border bg-surface p-6">
          <PageHeader title="Advanced analysis" icon={Code2} />
          <p className="mt-3 text-sm">
            {ACCESS_MESSAGES[status] || (publicDemo
              ? 'Advanced analysis is intentionally unavailable in the public demo.'
              : 'Advanced analysis has not been enabled for this account or deployment.')}
          </p>
          <p className="mt-3 text-sm">
            It requires an isolated R runtime and an authorized project role or account grant. Ask a project owner or deployment administrator to review access for this project.
          </p>
          {error && <p role="alert" className="mt-3 text-sm text-red-300">{error}</p>}
          {!publicDemo && <>
            <button type="button" className="btn btn-secondary mt-4" disabled={checkingRuntime || typeof window.electronAPI?.getExpertRCapabilities !== 'function'} onClick={refreshCapability}>{checkingRuntime ? 'Checking R availability…' : 'Check R availability'}</button>
            <details className="mt-4 text-sm"><summary className="cursor-pointer text-text">Set up private R</summary>
              <p className="mt-3">The installation administrator can configure a pinned R image and the dedicated isolated runtime using:</p>
              <code className="mt-2 block break-all rounded bg-background p-3">node scripts/configure-private-r.js --help</code>
              <p className="mt-3">The setup preflight checks the runtime before enabling it. New private installations use owner, admin, and analyst project roles. Administrators can explicitly revoke account access.</p>
            </details>
          </>}
          {projectId && (
            <button type="button" className="btn btn-secondary mt-4" onClick={() => setActiveTab?.('team')}>
              Open project collaborators
            </button>
          )}
        </div>
      </div>
    );
  }
  return (
    <div className="h-full overflow-y-auto p-4 sm:p-6 bg-background text-text">
      <form className="max-w-5xl mx-auto space-y-4" onSubmit={submit}>
      <PageHeader title="Advanced analysis" icon={Code2} description="Use R for custom exploratory analysis on a private saved analysis." actions={
        <button type="button" className="btn btn-secondary" onClick={() => {
          if (consoleDetails.current) { consoleDetails.current.open = true; consoleDetails.current.scrollIntoView({ block: 'start' }); }
        }}>Interactive console</button>
      } />
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-surface px-4 py-3 text-sm">
        <p className="flex items-center gap-2"><ShieldCheck size={18} className="shrink-0 text-success" />Private, isolated runs · results stay private until shared.</p>
        {policy.expertRStatus?.state === 'ready' && <p role="status" className="text-textMuted">Isolated R runtime ready · {policy.expertRStatus.accessPolicy === 'project-roles' ? 'Project-role access' : 'Approved-account access'}</p>}
        <button type="button" className="btn btn-secondary text-sm" disabled={checkingRuntime || typeof window.electronAPI?.getExpertRCapabilities !== 'function'} onClick={refreshCapability}>{checkingRuntime ? 'Checking R availability…' : 'Check R availability'}</button>
      </div>
      {error && <div role="alert" className="text-sm text-red-300">{error}</div>}
      {job && <div className="flex flex-wrap items-center gap-3 text-sm"><span role="status" aria-live="polite" className="text-success">Run submitted. Results will remain private until you choose to share them.</span><button type="button" className="btn btn-secondary text-xs" onClick={() => setActiveTab?.('history')}>View in Runs &amp; Results</button></div>}
      <label className="block text-sm">Saved analysis<select className="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-text shadow-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20" value={objectId} onChange={(event) => setObjectId(event.target.value)} disabled={objects.length === 0}><option value="">Select a saved analysis</option>{objects.map((item) => <option value={item.id} key={item.id}>{item.displayName || item.name || 'Saved analysis'}</option>)}</select></label>
      {objects.length === 0 && <p className="text-sm text-slate-400">No saved analysis you own is available for R work. Open a saved version or create a branch first.</p>}
      <details className="card p-3">
        <summary className="cursor-pointer font-medium">Private input files · {selectedInputIds.length}/5 selected</summary>
        <div className="mt-4">
      <section className="space-y-3" aria-labelledby="expert-r-inputs-title">
        <div><h3 id="expert-r-inputs-title" className="font-medium">Private input files</h3><p className="mt-1 text-sm text-slate-400">Import bounded CSV, TSV, TXT, JSON, or RDS files. They stay private to you and are mounted read-only only for selected runs. RDS files remain untrusted and open only inside the isolated Expert R workspace.</p></div>
        <div className="flex flex-wrap items-center gap-2">
          <input className="min-w-0 max-w-full text-sm" aria-label="Choose private input" type="file" accept=".csv,.tsv,.txt,.json,.rds" onChange={(event) => setInputFile(event.target.files?.[0] || null)} />
          <button type="button" className="btn btn-secondary text-xs" disabled={!inputFile || inputBusy} onClick={uploadInput}>{inputBusy ? 'Importing…' : 'Import file'}</button>
        </div>
        {privateInputs.length > 0 ? <div className="grid gap-2 sm:grid-cols-2">{privateInputs.map((input) => {
          const selected = selectedInputIds.includes(input.id);
          return <label key={input.id} className="flex items-start gap-2 rounded border border-border p-2 text-sm"><input type="checkbox" checked={selected} disabled={!selected && selectedInputIds.length >= 5} onChange={() => setSelectedInputIds((current) => selected ? current.filter((id) => id !== input.id) : [...current, input.id])} /><span><span className="block text-text break-all">{input.originalFilename}</span><span className="text-xs text-slate-400">{Math.ceil(input.sizeBytes / 1024)} KiB</span></span></label>;
        })}</div> : <p className="text-sm text-slate-400">No private input files imported yet.</p>}
        <p className="text-xs text-slate-400">Selected for this run: {selectedInputIds.length}/5</p>
      </section>
        </div>
      </details>
      <section className="card p-4 space-y-3" aria-labelledby="expert-r-script-title">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <label id="expert-r-script-title" htmlFor="expert-r-script" className="font-semibold">R script</label>
          <button className="btn btn-primary" disabled={busy || checkingRuntime || !objectId || !script.trim()}>{busy ? 'Starting…' : 'Run R analysis'}</button>
        </div>
        <p className="text-sm text-textMuted">Runs use the selected saved analysis and {selectedInputIds.length}/5 private input files. Variables reset between runs.</p>
        {selectedInputIds.length > 0 && <p className="text-sm text-textMuted break-all">Selected inputs: {privateInputs.filter((input) => selectedInputIds.includes(input.id)).map((input) => input.originalFilename).join(', ')}</p>}
        <textarea id="expert-r-script" className="min-h-[320px] md:min-h-[420px] w-full rounded-lg border border-border bg-background p-3 font-mono text-sm leading-6 text-text shadow-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20" value={script} onChange={(event) => setScript(event.target.value)} spellCheck="false" />
      </section>
      <details className="card p-4 text-sm">
        <summary className="cursor-pointer font-medium">Runtime, packages, and privacy</summary>
        <div className="mt-4 space-y-4">
          <p className="text-textMuted">Your saved analysis opens in a fresh, time-limited R workspace. It cannot reach the network or files outside this analysis, and uses the packages listed below. Create tables and figures to inspect or export. They stay private unless you choose to share them through Analysis Branches.</p>
          <REnvironment reference={policy.expertREnvironment} projectId={projectId} />
          <p className="text-textMuted">Available packages ({profile.packages.length}): {profile.packages.join(', ')}</p>
        </div>
      </details>
    </form>
      <details ref={consoleDetails} className="max-w-5xl mx-auto mt-4 card p-4">
        <summary className="cursor-pointer font-medium">Interactive R console · reuse a private live session</summary>
        <p className="mt-3 mb-4 text-sm text-textMuted">Use the console for commands that share variables across cells. Its live session is separate from the fresh workspaces created by Run R analysis.</p>
        <RConsole projectId={projectId} userId={userId} workspaceId={currentWs?.id || 'default'}
          objects={objects} preferredObjectId={preferredObjectId} deploymentPolicy={policy} />
      </details>
    </div>
  );
}
