import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Code2, Layers, Loader2, RefreshCw, Upload } from 'lucide-react';
import { SeuratPipelinePanel } from './Workspace';
import {
  DEFAULT_PIPELINE_ID,
  PARAMETER_TEMPLATE_TYPES,
  RESULT_VIEW_TEMPLATES,
  getDefaultPipelineManifest,
  validatePipelineManifest,
} from '../pipelines/pipelineRegistry';

function parseApiError(error) {
  const raw = error?.message || String(error || 'Request failed.');
  try {
    const parsed = JSON.parse(raw);
    return parsed?.error || raw;
  } catch {
    return raw;
  }
}

function StatusBadge({ children, tone = 'slate' }) {
  const tones = {
    blue: 'bg-primary/10 text-text border-primary/20',
    green: 'bg-success/10 text-success border-success/30',
    amber: 'bg-amber-500/10 text-amber-900 dark:text-amber-200 border-amber-500/30',
    rose: 'bg-danger/10 text-danger border-danger/30',
    slate: 'bg-slate-800 text-slate-300 border-slate-700',
  };
  return (
    <span className={`inline-flex items-center rounded border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${tones[tone] || tones.slate}`}>
      {children}
    </span>
  );
}

function selectedObjectForProject(currentWs, activeProjectId, datasetInfo) {
  const selectedIds = currentWs?.selectedObjectIds || [];
  return (currentWs?.objects || []).find(object => object.projectId === activeProjectId && selectedIds.includes(object.id))
    || (datasetInfo?.projectId === activeProjectId ? datasetInfo : null);
}

function PipelineModuleList({ manifest }) {
  const tabs = Array.isArray(manifest?.tabs) ? manifest.tabs : [];
  return (
    <div className="rounded-lg border border-border bg-surface/50">
      <div className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_auto] gap-3 border-b border-border px-4 py-3 text-[10px] font-bold uppercase tracking-widest text-textMuted">
        <span>Tab</span>
        <span>Module</span>
        <span>Status</span>
      </div>
      <div className="divide-y divide-border/50">
        {tabs.map(tab => (
          <div key={tab.id} className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 text-sm">
            <div className="min-w-0">
              <div className="truncate font-bold text-text">{tab.label}</div>
              <div className="font-mono text-xs text-textMuted">{tab.id}</div>
            </div>
            <div className="min-w-0">
              <div className="truncate font-mono text-xs text-textMuted">{tab.moduleKey}</div>
              {tab.jobType && <div className="mt-1 truncate font-mono text-[11px] text-textMuted">{tab.jobType}</div>}
            </div>
            <StatusBadge tone={tab.executableNow ? 'green' : tab.jobType ? 'amber' : 'blue'}>
              {tab.executableNow ? 'worker' : tab.jobType ? 'planned worker' : 'view'}
            </StatusBadge>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function PipelineManager({
  currentWs,
  datasetInfo,
  updateActiveWorkspace,
  onSelectAnalysisObject,
  setActiveTab,
  activePipeline,
  onPipelineSelectionChanged,
}) {
  const activeProjectId = currentWs?.selectedProjectId || datasetInfo?.projectId || currentWs?.projects?.[0]?.id || null;
  const activeProject = (currentWs?.projects || []).find(project => project.id === activeProjectId) || null;
  const selectedObject = selectedObjectForProject(currentWs, activeProjectId, datasetInfo);

  const [definitions, setDefinitions] = useState([]);
  const [selection, setSelection] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [uploadText, setUploadText] = useState('');
  const [uploadVisibility, setUploadVisibility] = useState('user');
  const [uploadError, setUploadError] = useState(null);
  const [uploading, setUploading] = useState(false);

  const manifest = useMemo(() => activePipeline || selection?.definition?.manifest || getDefaultPipelineManifest(), [activePipeline, selection]);
  const selectedPipelineId = selection?.pipelineId || manifest?.id || DEFAULT_PIPELINE_ID;

  const loadPipelines = useCallback(async () => {
    if (!activeProjectId) {
      setDefinitions([]);
      setSelection(null);
      setError(null);
      return;
    }
    const api = window.electronAPI || {};
    if (!api.listProjectPipelineDefinitions || !api.getProjectPipelineSelection) {
      setError('Pipeline APIs are unavailable in this frontend runtime.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [defs, selected] = await Promise.all([
        api.listProjectPipelineDefinitions(activeProjectId),
        api.getProjectPipelineSelection(activeProjectId),
      ]);
      const nextDefs = Array.isArray(defs) ? defs : [];
      setDefinitions(nextDefs);
      setSelection(selected || null);
      if (selected?.definition?.manifest) onPipelineSelectionChanged?.(selected.definition.manifest);
    } catch (err) {
      setError(parseApiError(err));
    } finally {
      setLoading(false);
    }
  }, [activeProjectId, onPipelineSelectionChanged]);

  useEffect(() => {
    loadPipelines();
  }, [loadPipelines]);

  const selectPipeline = async (pipelineId) => {
    if (!activeProjectId || !pipelineId) return;
    const api = window.electronAPI || {};
    if (!api.setProjectPipelineSelection) {
      setError('Pipeline selection API is unavailable in this frontend runtime.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const selected = await api.setProjectPipelineSelection(activeProjectId, pipelineId);
      setSelection(selected);
      if (selected?.definition?.manifest) onPipelineSelectionChanged?.(selected.definition.manifest);
    } catch (err) {
      setError(parseApiError(err));
    } finally {
      setLoading(false);
    }
  };

  const uploadManifest = async () => {
    if (!activeProjectId) return;
    setUploadError(null);
    let parsed;
    try {
      parsed = validatePipelineManifest(JSON.parse(uploadText));
    } catch (err) {
      setUploadError(err.message || 'Pipeline manifest is not valid JSON.');
      return;
    }
    const api = window.electronAPI || {};
    if (!api.createProjectPipelineDefinition) {
      setUploadError('Pipeline definition API is unavailable in this frontend runtime.');
      return;
    }
    setUploading(true);
    try {
      const created = await api.createProjectPipelineDefinition(activeProjectId, {
        manifest: parsed,
        visibility: uploadVisibility,
      });
      setUploadText('');
      await loadPipelines();
      if (created?.id) await selectPipeline(created.id);
    } catch (err) {
      setUploadError(parseApiError(err));
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="h-full w-full overflow-y-auto bg-background p-4 custom-scrollbar sm:p-8">
      <div className="mx-auto max-w-6xl space-y-8">
        <header className="flex flex-wrap items-start justify-between gap-4 border-b border-border pb-6">
          <div>
            <h2 className="flex items-center gap-3 text-2xl font-black tracking-tight text-text">
              <Layers size={24} className="text-primary" />
              Pipeline Manager
            </h2>
            <p className="mt-2 max-w-3xl text-sm text-textMuted">
              Active pipeline selection is scoped to you inside this project. Shared project jobs and artifacts remain durable project history.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <StatusBadge tone="green">user-project selection</StatusBadge>
              <StatusBadge tone="blue">module registry</StatusBadge>
              <StatusBadge tone="amber">declarative uploads only</StatusBadge>
            </div>
          </div>
          <button onClick={loadPipelines} disabled={loading || !activeProjectId} className="btn btn-secondary inline-flex items-center gap-2 text-sm">
            {loading ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
            Refresh
          </button>
        </header>

        {!activeProjectId ? (
          <div className="rounded-lg border border-dashed border-border p-6 text-center">
            <p className="font-bold text-text">Select a backend project</p>
            <p className="mt-2 text-sm text-textMuted">Pipeline definitions and selections are scoped to a project and user.</p>
          </div>
        ) : (
          <>
            <section className="grid grid-cols-1 gap-4 lg:grid-cols-3">
              <div className="rounded-lg border border-border bg-surface/60 p-4">
                <div className="text-[10px] font-bold uppercase tracking-widest text-textMuted">Project</div>
                <div className="mt-1 truncate font-bold text-text">{activeProject?.name || activeProjectId}</div>
              </div>
              <div className="rounded-lg border border-border bg-surface/60 p-4">
                <div className="text-[10px] font-bold uppercase tracking-widest text-textMuted">Active pipeline</div>
                <div className="mt-1 truncate font-bold text-text">{manifest.name}</div>
              </div>
              <div className="rounded-lg border border-border bg-surface/60 p-4">
                <div className="text-[10px] font-bold uppercase tracking-widest text-textMuted">Selected object</div>
                <div className="mt-1 truncate font-mono text-text">{selectedObject?.id || 'None'}</div>
              </div>
            </section>

            {error && (
              <div className="rounded-lg border border-danger/30 bg-danger/10 p-4 text-danger">
                <div className="flex items-center gap-2 font-bold"><AlertTriangle size={18} /> Pipeline unavailable</div>
                <p className="mt-1 text-sm">{error}</p>
              </div>
            )}

            <section className="space-y-4">
              <div>
                <h3 className="text-lg font-bold text-text">Available Pipelines</h3>
                <p className="mt-1 text-sm text-textMuted">Choose your active pipeline for this project. This does not change other users' active pipeline.</p>
              </div>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                {definitions.map(definition => {
                  const isActive = selectedPipelineId === definition.id || (selectedPipelineId === DEFAULT_PIPELINE_ID && definition.id === DEFAULT_PIPELINE_ID);
                  return (
                    <button
                      key={definition.id}
                      type="button"
                      onClick={() => selectPipeline(definition.id)}
                      className={`rounded-lg border p-4 text-left transition ${
                        isActive ? 'border-primary bg-primary/10' : 'border-border bg-surface/60 hover:border-primary/40'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="truncate font-bold text-text">{definition.name || definition.manifest?.name}</div>
                          <div className="mt-1 font-mono text-xs text-textMuted">{definition.id}</div>
                        </div>
                        {isActive ? <CheckCircle2 size={18} className="text-success" /> : <StatusBadge>{definition.visibility || 'user'}</StatusBadge>}
                      </div>
                      <p className="mt-3 line-clamp-2 text-xs text-textMuted">{definition.manifest?.description || 'Registered pipeline manifest.'}</p>
                    </button>
                  );
                })}
              </div>
            </section>

            <section className="space-y-4">
              <div>
                <h3 className="text-lg font-bold text-text">Active Pipeline Modules</h3>
                <p className="mt-1 text-sm text-textMuted">Pipeline-generated sidebar tabs are derived from these registered modules and labels.</p>
              </div>
              <PipelineModuleList manifest={manifest} />
            </section>

            <section className="rounded-lg border border-border bg-surface/60 p-5">
              <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="flex items-center gap-2 text-lg font-bold text-text">
                    <Upload size={18} className="text-primary" />
                    Upload Pipeline Manifest
                  </h3>
                  <p className="mt-1 max-w-3xl text-sm text-textMuted">
                    Uploads are validated against the module registry. Code, endpoints, paths, icons, and storage/state keys are rejected.
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <select
                    value={uploadVisibility}
                    onChange={event => setUploadVisibility(event.target.value)}
                    className="rounded border border-border bg-background px-2 py-1 text-sm text-text"
                  >
                    <option value="user">Only me</option>
                    <option value="project">Project visible</option>
                  </select>
                  <button onClick={uploadManifest} disabled={uploading || !uploadText.trim()} className="btn btn-primary inline-flex items-center gap-2 text-sm">
                    {uploading ? <Loader2 size={16} className="animate-spin" /> : <Upload size={16} />}
                    Upload
                  </button>
                </div>
              </div>
              <textarea
                value={uploadText}
                onChange={event => setUploadText(event.target.value)}
                rows={8}
                className="w-full rounded border border-border bg-background p-3 font-mono text-xs text-text focus:border-primary focus:outline-none"
                placeholder='{"schemaVersion":1,"id":"custom-seurat-view","name":"Custom Seurat View","tabs":[{"id":"inspect","label":"Inspect","moduleKey":"inspectObject"}]}'
              />
              {uploadError && (
                <div className="mt-3 rounded border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
                  {uploadError}
                </div>
              )}
              <div className="mt-4 grid grid-cols-1 gap-3 text-xs text-textMuted md:grid-cols-2">
                <div className="rounded border border-border bg-background/60 p-3">
                  <div className="mb-2 flex items-center gap-2 font-bold text-text"><Code2 size={14} /> Parameter Templates</div>
                  {PARAMETER_TEMPLATE_TYPES.join(', ')}
                </div>
                <div className="rounded border border-border bg-background/60 p-3">
                  <div className="mb-2 flex items-center gap-2 font-bold text-text"><Code2 size={14} /> Result View Templates</div>
                  {RESULT_VIEW_TEMPLATES.join(', ')}
                </div>
              </div>
            </section>

            {manifest.id === DEFAULT_PIPELINE_ID && (
              <SeuratPipelinePanel
                activeProjectId={activeProjectId}
                selectedObject={selectedObject}
                currentWs={currentWs}
                updateActiveWorkspace={updateActiveWorkspace}
                onSelectAnalysisObject={onSelectAnalysisObject}
                setActiveTab={setActiveTab}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}
