import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, CheckCircle2, Layers, Loader2, RefreshCw,
} from 'lucide-react';
import PipelineTemplatePreview from '../components/PipelineTemplatePreview';
import { SeuratPipelinePanel } from './Workspace';
import {
  DEFAULT_PIPELINE_ID,
  getDefaultPipelineManifest,
  resolvePipelineManifest,
  validatePipelineManifest,
} from '../pipelines/pipelineRegistry';
import { publicErrorMessage } from '../publicError';

function parseApiError(error) {
  const raw = error?.message || String(error || 'Request failed.');
  try {
    const parsed = JSON.parse(raw);
    return publicErrorMessage(parsed?.error || raw);
  } catch {
    return publicErrorMessage(raw);
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

function builtInDefinition(projectId) {
  const manifest = getDefaultPipelineManifest();
  return {
    id: DEFAULT_PIPELINE_ID,
    manifestId: DEFAULT_PIPELINE_ID,
    projectId: projectId || null,
    visibility: 'builtin',
    builtin: true,
    name: manifest.name,
    manifest,
  };
}

function researcherWorkflowLabel(definition) {
  if (definition?.builtin || definition?.id === DEFAULT_PIPELINE_ID) return 'Standard scRNA-seq workflow';
  const name = typeof definition?.name === 'string' ? definition.name.trim() : '';
  return name || 'Approved analysis workflow';
}

function researcherWorkflowDescription(definition) {
  return definition?.builtin || definition?.id === DEFAULT_PIPELINE_ID
    ? 'Guided preprocessing, exploration, marker analysis, pathway enrichment, and candidate cell communication analysis.'
    : 'This workflow uses reviewed settings and result views.';
}

function normalizeDefinition(definition, projectId) {
  if (!definition || typeof definition !== 'object' || typeof definition.id !== 'string') return null;
  if (definition.id === DEFAULT_PIPELINE_ID) return builtInDefinition(projectId);
  if (definition.visibility !== 'platform' || definition.projectId !== null) return null;
  try {
    const manifest = validatePipelineManifest(definition.manifest);
    if (definition.manifestId !== manifest.id || definition.name !== manifest.name) return null;
    return { ...definition, manifest };
  } catch {
    return null;
  }
}

function normalizeDefinitionList(rawDefinitions, projectId) {
  const source = Array.isArray(rawDefinitions) ? rawDefinitions : [];
  const definitions = source.map(definition => normalizeDefinition(definition, projectId)).filter(Boolean);
  const unique = [];
  const ids = new Set();
  for (const definition of definitions) {
    if (!ids.has(definition.id)) {
      ids.add(definition.id);
      unique.push(definition);
    }
  }
  if (!ids.has(DEFAULT_PIPELINE_ID)) unique.unshift(builtInDefinition(projectId));
  return { definitions: unique, rejectedCount: source.length - definitions.length };
}

function normalizeSelection(rawSelection, definitions, projectId) {
  const requestedId = typeof rawSelection?.pipelineId === 'string' ? rawSelection.pipelineId : DEFAULT_PIPELINE_ID;
  const definition = definitions.find(item => item.id === requestedId) || builtInDefinition(projectId);
  return {
    projectId,
    pipelineId: definition.id,
    definition,
    selectionUnavailable: rawSelection?.selectionUnavailable === true || definition.id !== requestedId,
    updatedAt: rawSelection?.updatedAt || null,
  };
}

function PipelineModuleList({ manifest }) {
  const tabs = Array.isArray(manifest?.tabs) ? manifest.tabs : [];
  return (
    <div className="rounded-lg border border-border bg-surface/50">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 border-b border-border px-4 py-3 text-[10px] font-bold uppercase tracking-widest text-textMuted">
        <span>Workflow step</span>
        <span>Availability</span>
      </div>
      <div className="divide-y divide-border/50">
        {tabs.map(tab => (
          <div key={tab.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 text-sm">
            <div className="min-w-0">
              <div className="truncate font-bold text-text">{tab.label}</div>
            </div>
            <StatusBadge tone={tab.executable ? 'green' : 'blue'}>
              {tab.executable ? 'Runs & results' : 'Available'}
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
  deploymentPolicy = {},
}) {
  const activeProjectId = currentWs?.selectedProjectId || datasetInfo?.projectId || currentWs?.projects?.[0]?.id || null;
  const activeProject = (currentWs?.projects || []).find(project => project.id === activeProjectId) || null;
  const canWriteProject = ['owner', 'admin', 'analyst'].includes(activeProject?.role);
  const selectedObject = selectedObjectForProject(currentWs, activeProjectId, datasetInfo);

  const [definitions, setDefinitions] = useState([]);
  const [selection, setSelection] = useState(null);
  const [loading, setLoading] = useState(false);
  const [selectingId, setSelectingId] = useState(null);
  const [error, setError] = useState(null);
  const [registryWarning, setRegistryWarning] = useState(null);

  const mountedRef = useRef(true);
  const projectRef = useRef(activeProjectId);
  const definitionsRef = useRef(definitions);
  const selectionChangedRef = useRef(onPipelineSelectionChanged);
  const pipelineOperationSequenceRef = useRef(0);
  projectRef.current = activeProjectId;
  definitionsRef.current = definitions;
  selectionChangedRef.current = onPipelineSelectionChanged;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      pipelineOperationSequenceRef.current += 1;
    };
  }, []);

  const manifest = useMemo(() => {
    const candidate = selection?.projectId === activeProjectId
      ? selection.definition?.manifest
      : (!activeProjectId ? activePipeline : null);
    try {
      return resolvePipelineManifest(candidate || getDefaultPipelineManifest());
    } catch {
      return resolvePipelineManifest(getDefaultPipelineManifest());
    }
  }, [activePipeline, activeProjectId, selection]);
  const selectedPipelineId = selection?.projectId === activeProjectId
    ? selection.pipelineId
    : DEFAULT_PIPELINE_ID;

  const loadPipelines = useCallback(async (projectId = projectRef.current) => {
    const sequence = ++pipelineOperationSequenceRef.current;
    setSelectingId(null);
    if (!projectId) {
      if (mountedRef.current) {
        setDefinitions([]);
        setSelection(null);
        setLoading(false);
        setError(null);
        setRegistryWarning(null);
      }
      return null;
    }
    const api = window.electronAPI || {};
    if (!api.listProjectPipelineDefinitions || !api.getProjectPipelineSelection) {
      if (mountedRef.current && projectId === projectRef.current) {
        setLoading(false);
        setError('Approved workflows are temporarily unavailable.');
      }
      return null;
    }
    setLoading(true);
    setError(null);
    setRegistryWarning(null);
    try {
      const [rawDefinitions, rawSelection] = await Promise.all([
        api.listProjectPipelineDefinitions(projectId),
        api.getProjectPipelineSelection(projectId),
      ]);
      if (!mountedRef.current || sequence !== pipelineOperationSequenceRef.current || projectId !== projectRef.current) return null;
      const normalized = normalizeDefinitionList(rawDefinitions, projectId);
      const nextSelection = normalizeSelection(rawSelection, normalized.definitions, projectId);
      setDefinitions(normalized.definitions);
      setSelection(nextSelection);
      definitionsRef.current = normalized.definitions;
      selectionChangedRef.current?.(nextSelection.definition.manifest);
      if (normalized.rejectedCount > 0) {
        setRegistryWarning('One or more invalid registry entries were ignored by the browser.');
      } else if (nextSelection.selectionUnavailable) {
        setRegistryWarning('Your previous workflow is no longer available. The standard workflow is active instead.');
      }
      return { definitions: normalized.definitions, selection: nextSelection };
    } catch (requestError) {
      if (!mountedRef.current || sequence !== pipelineOperationSequenceRef.current || projectId !== projectRef.current) return null;
      setError(parseApiError(requestError));
      return null;
    } finally {
      if (mountedRef.current && sequence === pipelineOperationSequenceRef.current && projectId === projectRef.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    setDefinitions([]);
    setSelection(null);
    setSelectingId(null);
    setError(null);
    setRegistryWarning(null);
    selectionChangedRef.current?.(getDefaultPipelineManifest());
    loadPipelines(activeProjectId);
  }, [activeProjectId, loadPipelines]);

  const refreshAll = () => {
    loadPipelines(projectRef.current);
  };

  const selectPipeline = async (pipelineId) => {
    const projectId = projectRef.current;
    if (!projectId || !pipelineId) return;
    const api = window.electronAPI || {};
    if (!api.setProjectPipelineSelection) {
      setError('Workflow selection is temporarily unavailable.');
      return;
    }
    const sequence = ++pipelineOperationSequenceRef.current;
    setLoading(false);
    setSelectingId(pipelineId);
    setError(null);
    try {
      const rawSelection = await api.setProjectPipelineSelection(projectId, pipelineId);
      if (!mountedRef.current || sequence !== pipelineOperationSequenceRef.current || projectId !== projectRef.current) return;
      const nextSelection = normalizeSelection(rawSelection, definitionsRef.current, projectId);
      if (nextSelection.pipelineId !== pipelineId) {
        throw new Error('The selected registry entry is no longer available.');
      }
      setSelection(nextSelection);
      setRegistryWarning(nextSelection.selectionUnavailable
        ? 'Your requested workflow is no longer available. The standard workflow is active instead.'
        : null);
      selectionChangedRef.current?.(nextSelection.definition.manifest);
    } catch (requestError) {
      if (mountedRef.current && sequence === pipelineOperationSequenceRef.current && projectId === projectRef.current) {
        setError(parseApiError(requestError));
      }
    } finally {
      if (mountedRef.current && sequence === pipelineOperationSequenceRef.current && projectId === projectRef.current) {
        setSelectingId(null);
      }
    }
  };


  return (
    <div className="h-full w-full overflow-y-auto bg-background p-4 custom-scrollbar sm:p-8">
      <div className="mx-auto max-w-6xl space-y-8">
        <header className="flex flex-wrap items-start justify-between gap-4 border-b border-border pb-6">
          <div>
            <h2 className="flex items-center gap-3 text-2xl font-black tracking-tight text-text">
              <Layers size={24} className="text-primary" />
              Approved workflows
            </h2>
            <p className="mt-2 max-w-3xl text-sm text-textMuted">
              Choose an approved analysis workflow for this project. Each researcher works in a private analysis workspace while saved results and review history follow project access.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <StatusBadge tone="green">project selection</StatusBadge>
              <StatusBadge tone="blue">approved workflows</StatusBadge>
              <StatusBadge tone="amber">no custom code</StatusBadge>
            </div>
          </div>
          <button onClick={refreshAll} disabled={loading || Boolean(selectingId)} className="btn btn-secondary inline-flex items-center gap-2 text-sm">
            {loading ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
            Refresh
          </button>
        </header>

        {!activeProjectId ? (
          <div className="rounded-lg border border-dashed border-border p-6 text-center">
            <p className="font-bold text-text">Select a project</p>
            <p className="mt-2 text-sm text-textMuted">A project is required to choose an approved workflow.</p>
          </div>
        ) : (
          <>
            <section className="grid grid-cols-1 gap-4 lg:grid-cols-3">
              <div className="rounded-lg border border-border bg-surface/60 p-4">
                <div className="text-[10px] font-bold uppercase tracking-widest text-textMuted">Project</div>
                <div className="mt-1 truncate font-bold text-text">{activeProject?.name || 'Selected project'}</div>
              </div>
              <div className="rounded-lg border border-border bg-surface/60 p-4">
                <div className="text-[10px] font-bold uppercase tracking-widest text-textMuted">Selected workflow</div>
                <div className="mt-1 truncate font-bold text-text">{researcherWorkflowLabel(selection?.definition || { id: manifest.id })}</div>
              </div>
              <div className="rounded-lg border border-border bg-surface/60 p-4">
                <div className="text-[10px] font-bold uppercase tracking-widest text-textMuted">Selected analysis</div>
                <div className="mt-1 truncate text-text">{selectedObject?.displayName || selectedObject?.name || 'None selected'}</div>
              </div>
            </section>

            {error && (
              <div className="rounded-lg border border-danger/30 bg-danger/10 p-4 text-danger" role="alert">
                <div className="flex items-center gap-2 font-bold"><AlertTriangle size={18} /> Workflow selection unavailable</div>
                <p className="mt-1 text-sm">{error}</p>
                <button type="button" onClick={() => loadPipelines(activeProjectId)} className="mt-3 text-sm font-bold underline">Retry</button>
              </div>
            )}
            {registryWarning && (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-900 dark:text-amber-200" role="status">
                <div className="flex items-center gap-2 font-bold"><AlertTriangle size={18} /> Workflow selection changed</div>
                <p className="mt-1">{registryWarning}</p>
              </div>
            )}

            <section className="space-y-4">
              <div>
                <h3 className="text-lg font-bold text-text">Available workflows</h3>
                <p className="mt-1 text-sm text-textMuted">Choose the workflow you want to use for this project. This does not change another collaborator&apos;s selection or grant access to their private analysis workspace.</p>
              </div>
              {loading && definitions.length === 0 ? (
                <div className="rounded border border-border p-5 text-sm text-textMuted" role="status">
                  <Loader2 size={16} className="mr-2 inline animate-spin" /> Loading approved workflows…
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  {definitions.map(definition => {
                    const isActive = selectedPipelineId === definition.id;
                    const isSelecting = selectingId === definition.id;
                    return (
                      <button
                        key={definition.id}
                        type="button"
                        onClick={() => selectPipeline(definition.id)}
                        disabled={loading || Boolean(selectingId)}
                        className={`rounded-lg border p-4 text-left transition disabled:cursor-wait disabled:opacity-75 ${
                          isActive ? 'border-primary bg-primary/10' : 'border-border bg-surface/60 hover:border-primary/40'
                        }`}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="truncate font-bold text-text">{researcherWorkflowLabel(definition)}</div>
                          </div>
                          {isSelecting ? <Loader2 size={18} className="animate-spin text-primary" />
                            : isActive ? <CheckCircle2 size={18} className="text-success" />
                              : <StatusBadge tone={definition.builtin ? 'slate' : 'blue'}>{definition.builtin ? 'Included' : 'Approved'}</StatusBadge>}
                        </div>
                        <p className="mt-3 line-clamp-2 text-xs text-textMuted">{researcherWorkflowDescription(definition)}</p>
                      </button>
                    );
                  })}
                </div>
              )}
            </section>

            <section className="space-y-4">
              <div>
                <h3 className="text-lg font-bold text-text">Included workflow steps</h3>
                <p className="mt-1 text-sm text-textMuted">The available steps and their results are reviewed with the application release.</p>
              </div>
              <PipelineModuleList manifest={manifest} />
            </section>

            <PipelineTemplatePreview manifest={manifest} />

            {manifest.id === DEFAULT_PIPELINE_ID && (
              <SeuratPipelinePanel
                activeProjectId={activeProjectId}
                selectedObject={selectedObject}
                currentWs={currentWs}
                updateActiveWorkspace={updateActiveWorkspace}
                onSelectAnalysisObject={onSelectAnalysisObject}
                setActiveTab={setActiveTab}
                datasetUploadsEnabled={deploymentPolicy.datasetUploadsEnabled !== false}
                canWriteProject={canWriteProject}
              />
            )}
          </>
        )}

      </div>
    </div>
  );
}
