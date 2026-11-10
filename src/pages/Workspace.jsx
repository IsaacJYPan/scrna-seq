import WorkbenchOverview from '../components/WorkbenchOverview';
import DetailsPopover from '../components/DetailsPopover';
import React, { useRef, useState } from 'react';
import {
  FileUp,
  CheckCircle,
  LayoutGrid,
  Edit2,
  X,
  Search,
  Scissors,
  Trash2,
  MoreVertical,
} from 'lucide-react';
import { publicErrorMessage } from '../publicError';
import LoadModal, { isLiveLoadResult } from '../components/LoadModal';

function boundedDemoSetting(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(parsed)));
}

const PROJECT_WRITE_ROLES = new Set(['owner', 'admin', 'analyst']);


// ── Main Workspace ─────────────────────────────────────────────────

export default function Workspace({
  callApi: _callApi,
  datasetInfo: _datasetInfo,
  setDataVersion,
  openProvenance: _openProvenance,
  currentWs,
  updateActiveWorkspace,
  workspaces: _workspaces,
  setWorkspaces: _setWorkspaces,
  activeWsIndex: _activeWsIndex,
  setActiveWsIndex: _setActiveWsIndex,
  resetPipelineAfterSubset: _resetPipelineAfterSubset,
  setActiveTab,
  userEmail: _userEmail,
  userId,
  backendModelStatus,
  onSelectProject,
  onCreateProject,
  onCreateAnalysisObjectForLoad,
  onAnalysisObjectLoaded,
  onAnalysisObjectLoadFailed,
  onSelectAnalysisObject,
  pipelineState,
  deploymentPolicy = {},
}) {
  const selectedObjects = currentWs.objects.filter(obj => currentWs.selectedObjectIds?.includes(obj.id));
  const [showLoadModal, setShowLoadModal] = useState(false);
  const [loadingId, setLoadingId] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [loadError, setLoadError] = useState(null);

  // Projects come from the backend. The selected project ID may be cached as a
  // UI preference, but the project list itself is not localStorage truth.
  const defaultProjectId = currentWs.selectedProjectId || currentWs.projects?.[0]?.id || null;
  const [activeProjectId, setActiveProjectId] = useState(defaultProjectId);
  const [isCreatingProject, setIsCreatingProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const createProjectInFlightRef = useRef(false);
  const [isSubmittingProject, setIsSubmittingProject] = useState(false);
  const analysisCardsRef = useRef(new Map());
  const analysisHeadingRef = useRef(null);
  const deleteFocusRef = useRef(null);

  React.useLayoutEffect(() => {
    const pending = deleteFocusRef.current;
    if (!pending || currentWs.objects.some(object => object.id === pending.deleted)) return;
    deleteFocusRef.current = null;
    (analysisCardsRef.current.get(pending.next) || analysisHeadingRef.current)?.focus();
  }, [currentWs.objects]);

  // Sync active project if workspace changes
  React.useEffect(() => {
    setActiveProjectId(defaultProjectId);
  }, [defaultProjectId]);

  const handleProjectSelect = async (projId) => {
    setActiveProjectId(projId);
    await onSelectProject?.(projId);
  };

  const activeProjectObjects = activeProjectId
    ? currentWs.objects.filter(o => o.projectId === activeProjectId)
    : [];

  // Called when any load option completes successfully
  const handleLoaded = (data, suggestedName, analysisObject) => {
    if (!analysisObject?.id) {
      setLoadingId(null);
      return;
    }
    setLoadError(null);
    let baseName = suggestedName || 'Dataset';
    let finalName = baseName;
    let counter = 1;
    const existingNames = currentWs.objects.filter(o => o.projectId === activeProjectId).map(o => o.name);
    while (existingNames.includes(finalName)) {
      finalName = `${baseName} (${counter})`;
      counter++;
    }

    const namedAnalysisObject = { ...analysisObject, displayName: analysisObject.displayName || finalName };
    onAnalysisObjectLoaded?.(activeProjectId, namedAnalysisObject, data.result);

    setDataVersion(v => v + 1);
    setShowLoadModal(false);
  };

  const handleLoadFailed = (analysisObject) => {
    if (!analysisObject?.id) return;
    onAnalysisObjectLoadFailed?.(activeProjectId, analysisObject);
  };

  const selectObject = (id) => {
    const obj = currentWs.objects.find(o => o.id === id);
    if (!obj) return;
    onSelectAnalysisObject?.(obj.projectId, id);
  };

  const handleRenameObject = (e, objId, currentName) => {
    e.stopPropagation();
    setEditingId(objId);
    setEditName(currentName);
  };

  const saveRename = (e, objId) => {
    e.stopPropagation();
    const trimmed = editName.trim();
    if (trimmed) {
      const obj = currentWs.objects.find(o => o.id === objId);
      if (obj) {
        const existingNames = currentWs.objects.filter(o => o.projectId === obj.projectId && o.id !== objId).map(o => o.name);
        if (existingNames.includes(trimmed)) {
          alert(`An object named "${trimmed}" already exists in this project.`);
          return;
        }
      }
      updateActiveWorkspace({
        objects: currentWs.objects.map(o => o.id === objId ? { ...o, name: trimmed } : o)
      });
    }
    setEditingId(null);
  };

  const handleDeleteObject = (objId) => {
    if (confirmDeleteId !== objId) {
      setConfirmDeleteId(objId);
      return;
    }
    const obj = currentWs.objects.find(o => o.id === objId);
    if (obj?.parentObjId) {
      // It's a subset: don't delete from disk, just remove from workspace UI
      // If we *really* wanted to delete subset files we could do that here,
      // but right now subsets exist inside the parent's vault file.
    }
    setConfirmDeleteId(null);

    // 2. App State update
    const remainingObjects = currentWs.objects.filter(o => o.id !== objId);
    deleteFocusRef.current = { deleted: objId, next: remainingObjects.find(object => object.projectId === activeProjectId)?.id };
    const wasSelected = currentWs.selectedObjectIds?.includes(objId);
    const newSelected = wasSelected
      ? remainingObjects.length > 0 ? [remainingObjects[0].id] : []
      : (currentWs.selectedObjectIds || []).filter(id => id !== objId);
    
    updateActiveWorkspace({
      objects: remainingObjects,
      selectedObjectIds: newSelected,
    });

    // 3. LocalStorage cleanup (Tab parameters + Pipeline state)
    const keysToRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && (k.includes(`_${objId}`) || k.endsWith(`_${objId}`))) {
        keysToRemove.push(k);
      }
    }
    keysToRemove.forEach(k => localStorage.removeItem(k));
  };

  // ── Project Management ──────────────────────────────────────────

  const handleCreateProject = async () => {
    if (createProjectInFlightRef.current || !newProjectName.trim() || newProjectName.trim().length > 100) return;
    createProjectInFlightRef.current = true;
    setIsSubmittingProject(true);
    try {
      const project = await onCreateProject?.({ name: newProjectName.trim(), description: '' });
      if (project?.id) setActiveProjectId(project.id);
      setNewProjectName('');
      setIsCreatingProject(false);
    } catch (err) {
      alert(publicErrorMessage(err, 'The project could not be created. Please try again.'));
    } finally {
      createProjectInFlightRef.current = false;
      setIsSubmittingProject(false);
    }
  };

  const handleChangeObjectProject = (objId, newProjectId) => {
    
    let newSelected = currentWs.selectedObjectIds || [];
    if (newSelected.includes(objId)) {
      const remainingInCurrent = currentWs.objects.filter(o => o.projectId === activeProjectId && o.id !== objId);
      newSelected = remainingInCurrent.length > 0 ? [remainingInCurrent[remainingInCurrent.length - 1].id] : [];
    }

    updateActiveWorkspace({
      objects: currentWs.objects.map(o => o.id === objId ? { ...o, projectId: newProjectId } : o),
      selectedObjectIds: newSelected
    });
  };

  // ────────────────────────────────────────────────────────────────

  const activeSelectedObjects = selectedObjects.filter(obj => !activeProjectId || obj.projectId === activeProjectId);
  const activeCount = activeSelectedObjects.length;
  const displayObject = activeSelectedObjects[0] || null;
  const selectedObject = displayObject;
  const activeProject = currentWs.projects?.find(project => project.id === activeProjectId) || null;
  const canWriteProject = PROJECT_WRITE_ROLES.has(activeProject?.role);
  const canReloadPbmcDemo = selectedObject?.source === 'pbmc3k_demo'
    && selectedObject?.metadata?.curatedDemo !== true
    && canWriteProject
    && (!selectedObject?.ownerUserId || Number(selectedObject.ownerUserId) === Number(userId));

  const reloadPbmcDemo = async () => {
    if (!selectedObject?.id || !canReloadPbmcDemo) return;
    const minCells = boundedDemoSetting(selectedObject.metadata?.minCells, 3, 1, 1000);
    const minFeatures = boundedDemoSetting(selectedObject.metadata?.minFeatures, 200, 1, 100000);
    setLoadError(null);
    setLoadingId('reload-demo');
    try {
      const data = await window.electronAPI.apiRequest(
        `/load-data?min_cells=${minCells}&min_features=${minFeatures}`,
        { headers: { 'X-Object-ID': selectedObject.id } }
      );
      if (data?.error) throw new Error(data.error);
      if (!isLiveLoadResult(data?.result)) {
        throw new Error('The R runtime returned an incomplete load summary.');
      }
      handleLoaded(data, selectedObject.name || 'PBMC_3k_Tutorial', {
        ...selectedObject,
        displayName: selectedObject.name || 'PBMC_3k_Tutorial',
      });
    } catch (error) {
      setLoadError(publicErrorMessage(error, 'The PBMC demo could not be opened. Please try again.'));
    } finally {
      setLoadingId(null);
    }
  };

  return (
    <div className="h-full w-full flex flex-col bg-background overflow-hidden">
      <div className="page-scroll flex-1 custom-scrollbar">
        <div className="page-column space-y-6">
          {/* Projects Navigation */}
          <div>
            <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
              <h2 className="page-title">Projects</h2>
              {isCreatingProject ? (
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={newProjectName}
                    onChange={e => setNewProjectName(e.target.value)}
                    placeholder="Project Name"
                    maxLength={100}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && newProjectName.trim()) handleCreateProject();
                      if (e.key === 'Escape') setIsCreatingProject(false);
                    }}
                    className="bg-surface border border-border text-sm text-text px-3 py-1.5 rounded focus:outline-none focus:border-primary w-40"
                    autoFocus
                  />
                  <button onClick={handleCreateProject} disabled={!newProjectName.trim() || isSubmittingProject} className="btn btn-primary text-xs px-3 py-1.5">{isSubmittingProject ? 'Saving…' : 'Save'}</button>
                  <button onClick={() => setIsCreatingProject(false)} disabled={isSubmittingProject} aria-label="Cancel project creation" className="text-textMuted hover:text-text px-2"><X size={14} /></button>
                </div>
              ) : (
                <button
                  onClick={() => setIsCreatingProject(true)}
                  className="btn btn-secondary"
                >
                  New project
                </button>
              )}
            </div>

            {backendModelStatus?.error && (
              <div className="mb-4 rounded border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
                {publicErrorMessage(backendModelStatus.error, 'Project information is temporarily unavailable.')}
              </div>
            )}

            <div className="flex gap-2 overflow-x-auto pb-4 border-b border-border custom-scrollbar">
              {backendModelStatus?.projectsLoading ? (
                <div className="text-sm text-textMuted px-1 py-3">Loading projects...</div>
              ) : currentWs.projects?.length === 0 ? (
                <div className="flex w-full flex-wrap items-center justify-between gap-3">
                  <p className="text-sm text-textMuted">No projects yet. Create one to start adding datasets.</p>
                  <button onClick={() => setIsCreatingProject(true)} className="btn btn-primary">Create project</button>
                </div>
              ) : currentWs.projects?.map(proj => {
                const isActive = activeProjectId === proj.id;
                const projObjects = currentWs.objects.filter(o => o.projectId === proj.id);

                return (
                  <button
                    type="button"
                    key={proj.id}
                    onClick={() => handleProjectSelect(proj.id)}
                    className={`flex items-center gap-3 px-4 py-2.5 rounded-lg border transition-colors min-w-max group text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
                      isActive ? 'bg-primary/10 border-primary text-primary shadow-sm' : 'bg-slate-800/50 border-slate-700/50 text-slate-400 hover:bg-slate-800 hover:text-slate-200'
                    }`}
                  >
                    <div className="flex flex-col">
                      <span className="font-bold text-sm">{proj.name}</span>
                      {proj.role && <span className="mt-0.5 self-start text-xs capitalize px-1.5 rounded-sm border border-primary/40 text-primary">{proj.role}</span>}
                    </div>

                    {projObjects.length > 0 && <span className="text-sm text-textMuted" aria-label={`${projObjects.length} datasets`}>{projObjects.length}</span>}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Objects List */}
          <div className="pt-2">
            <div className="flex flex-wrap justify-between items-center gap-3 mb-4">
              <h3 ref={analysisHeadingRef} tabIndex={-1} className="text-lg font-bold text-text flex items-center gap-3">
                Datasets
                {activeProjectObjects.length > 0 && <>{' '}<span className="ml-1 text-sm font-normal text-textMuted">{activeProjectObjects.length}</span></>}
              </h3>
              {activeProjectObjects.length > 0 && <button
                onClick={() => setShowLoadModal(true)}
                disabled={!!loadingId || !activeProjectId || !canWriteProject}
                title={!canWriteProject && activeProjectId ? 'Your project role is read-only.' : undefined}
                className="btn btn-primary flex items-center gap-2 px-5 text-sm shadow-lg shadow-primary/20"
              >
                <FileUp size={16} /> Add dataset
              </button>}
            </div>
            <div className="mb-5 space-y-4">
              <WorkbenchOverview
                activeProject={activeProject}
                selectedObject={selectedObject}
                activeProjectObjects={activeProjectObjects}
                pipelineState={pipelineState}
                setActiveTab={setActiveTab}
                setShowLoadModal={setShowLoadModal}
                onReloadPbmcDemo={canReloadPbmcDemo ? reloadPbmcDemo : undefined}
              />

              {loadError && (
                <div role="alert" className="rounded-lg border border-danger/30 bg-danger/10 p-4 text-sm text-danger">
                  {loadError}
                </div>
              )}

              {/* Stats Block */}
              {displayObject && (
                <div className="flex flex-wrap items-center justify-between gap-4" aria-label="Dataset summary">
                  <dl className="flex flex-wrap gap-x-8 gap-y-3">
                    {[
                      { label: 'Cells', value: Number.isFinite(displayObject.cells) ? displayObject.cells.toLocaleString() : 'Unavailable' },
                      { label: 'Features', value: Number.isFinite(displayObject.features) ? displayObject.features.toLocaleString() : 'Unavailable' },
                    ].map(stat => <div key={stat.label}>
                      <dt className="text-xs text-textMuted">{stat.label}</dt>
                      <dd className="mt-1 text-xl font-semibold tabular-nums text-text">{stat.value}</dd>
                    </div>)}
                  </dl>
                  <DetailsPopover label="Dataset details">
                    {activeCount > 1 && <p className="mb-2">{activeCount} analyses selected. Counts describe the primary analysis.</p>}
                    <dl className="space-y-2">
                      <div><dt className="text-textMuted">Matrix density</dt><dd>{Number.isFinite(displayObject.density) ? `${displayObject.density}% non-zero values` : 'Unavailable for this dataset'}</dd></div>
                      <div><dt className="text-textMuted">Branch</dt><dd className="break-words">{currentWs.activeBranch}</dd></div>
                    </dl>
                    <p className="mt-3 text-textMuted">Your live workspace is private. Share saved versions through Runs &amp; Results.</p>
                  </DetailsPopover>
                </div>
              )}
            </div>

            <div className="grid grid-cols-1 gap-3">
              {!activeProjectId ? (
                <div className="empty-note">
                  <h4 className="font-semibold text-text">Select a project</h4>
                  <p className="mt-1 text-sm text-textMuted">
                    Select or create a project to list datasets.
                  </p>
                </div>
              ) : backendModelStatus?.objectsLoading ? (
                <div className="empty-note">
                  <h4 className="font-semibold text-text">Loading datasets</h4>
                  <p className="mt-1 text-sm text-textMuted">Loading dataset details.</p>
                </div>
              ) : activeProjectObjects.length === 0 ? (
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="text-sm text-textMuted">
                    {canWriteProject
                      ? 'No datasets yet. Start from the PBMC demo dataset or an approved workflow.'
                      : 'No datasets yet. Your project role is read-only; an owner, administrator, or analyst can add one.'}
                  </p>
                  <button
                    onClick={() => setShowLoadModal(true)}
                    disabled={!canWriteProject}
                    title={!canWriteProject ? 'Your project role is read-only.' : undefined}
                    className="btn btn-primary"
                  >
                    Add dataset
                  </button>
                </div>
              ) : activeProjectObjects.map(obj => {
                const isSelected = currentWs.selectedObjectIds?.includes(obj.id);
                return (
                  <div
                    key={obj.id}
                    ref={element => { if (element) analysisCardsRef.current.set(obj.id, element); else analysisCardsRef.current.delete(obj.id); }}
                    onClick={() => selectObject(obj.id)}
                    onKeyDown={event => {
                      if (event.target !== event.currentTarget) return;
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        selectObject(obj.id);
                      }
                    }}
                    role="group"
                    aria-label={`Dataset ${obj.name}. Press Enter or Space to select.`}
                    tabIndex={0}
                    className={`p-4 sm:p-5 rounded-xl border transition-colors cursor-pointer group relative grid grid-cols-[40px_minmax(0,1fr)_44px] items-start gap-3 sm:flex sm:items-center sm:gap-5 ${
                      isSelected
                        ? 'bg-primary/5 border-primary shadow-lg'
                        : 'bg-surface border-border hover:border-slate-700'
                    }`}
                  >
                    {/* Icon */}
                    <div className={`w-10 h-10 rounded-lg flex items-center justify-center transition-colors flex-shrink-0 ${
                      isSelected ? 'bg-primary text-white' : 'bg-slate-800 text-slate-400'
                    }`}>
                      {obj.isSubset ? <Scissors size={18} /> : <LayoutGrid size={20} />}
                    </div>

                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex flex-wrap items-center gap-2 group/edit min-h-6">
                        {editingId === obj.id ? (
                          <input
                            type="text" autoFocus
                            className="bg-background text-text px-2 py-0.5 rounded border border-primary text-sm font-bold w-48 focus:outline-none"
                            value={editName}
                            onChange={e => setEditName(e.target.value)}
                            maxLength={100}
                            onBlur={e => saveRename(e, obj.id)}
                            onKeyDown={e => { if (e.key === 'Enter') e.target.blur(); }}
                            onClick={e => e.stopPropagation()}
                          />
                        ) : (
                          <>
                            <div className="text-sm font-bold text-text break-words" title={obj.name}>{obj.name}</div>
                            {obj.isSubset && (
                              <span className="text-xs font-semibold px-1.5 py-0.5 rounded border text-amber-400 bg-amber-500/10 border-amber-500/20">
                                subset
                              </span>
                            )}
                            {!obj.isBackendAnalysisObject && (
                              <button
                                onClick={e => handleRenameObject(e, obj.id, obj.name)}
                                className="text-textMuted hover:text-text opacity-0 group-hover/edit:opacity-100 group-focus-within/edit:opacity-100 focus-visible:opacity-100 transition-opacity"
                                title="Rename"
                              >
                                <Edit2 size={12} />
                              </button>
                            )}
                          </>
                        )}
                      </div>
                      <div className="flex items-center gap-3 mt-0.5 flex-wrap">
                        <span className="text-xs text-primary font-medium">
                          {Number.isFinite(obj.cells) && Number.isFinite(obj.features)
                            ? `${obj.cells.toLocaleString()} cells × ${obj.features.toLocaleString()} features`
                            : 'Dimensions unavailable'}
                        </span>
                        <div className="w-1 h-1 rounded-full bg-slate-700"></div>
                        <span className="text-xs text-slate-400">
                          {new Date(obj.timestamp).toLocaleDateString()}
                        </span>
                        {obj.isBackendAnalysisObject && (
                          <>
                            <div className="w-1 h-1 rounded-full bg-slate-700"></div>
                            <span className="text-xs font-semibold px-1.5 py-0.5 rounded border text-text bg-primary/10 border-primary/20">
                              Saved
                            </span>
                          </>
                        )}
                        <span className={`text-xs font-semibold px-1.5 py-0.5 rounded border ${
                          obj.liveState === 'attached'
                            ? 'text-success bg-success/10 border-success/30'
                            : 'text-amber-400 bg-amber-500/10 border-amber-500/30'
                        }`}>
                          {obj.liveState === 'attached' ? 'Ready in your workspace' : 'Open saved version'}
                        </span>
                      </div>
                    </div>

                    {/* Right side: active badge + menu */}
                    <div className="flex items-center gap-3 flex-shrink-0 relative">

                      {isSelected && (
                        <div className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 bg-primary/10 border border-primary/20 rounded-full text-xs font-semibold text-text shadow-sm">
                          <CheckCircle size={10} /> Selected
                        </div>
                      )}

                      {/* 3-dot Menu */}
                      <div onClick={e => e.stopPropagation()}>
                        <DetailsPopover
                          label={<><MoreVertical size={16} aria-hidden="true" /><span className="sr-only">Object options</span></>}
                          summaryClassName="flex min-h-11 min-w-11 cursor-pointer list-none items-center justify-center rounded-lg text-textMuted hover:bg-black/5 hover:text-text transition-colors select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                          preferredWidth={224}
                          panelClassName="!p-1.5"
                          onOpenChange={() => setConfirmDeleteId(null)}
                        >
                            <button
                              data-close-popover
                              onClick={() => {
                                selectObject(obj.id);
                                setActiveTab('inspect');
                              }}
                              className="min-h-11 w-full rounded-lg text-left px-3 py-2 text-sm text-text hover:bg-black/5 flex items-center gap-2"
                            >
                              <Search size={14} /> Inspect Data
                            </button>
                            
                            {!obj.isBackendAnalysisObject && currentWs.projects?.length > 1 && (
                              <>
                                <div className="h-px bg-slate-700/50 my-1" />
                                <div className="px-3 py-1.5 text-xs font-medium text-slate-400">
                                  Move to Project
                                </div>
                                {currentWs.projects.map(p => (
                                  <button
                                    key={p.id}
                                    data-close-popover
                                    onClick={() => handleChangeObjectProject(obj.id, p.id)}
                                    className="min-h-11 w-full rounded-lg text-left px-3 py-2 text-sm text-textMuted hover:bg-black/5 hover:text-text flex items-center justify-between"
                                  >
                                    {p.name}
                                    {obj.projectId === p.id && <CheckCircle size={12} className="text-primary"/>}
                                  </button>
                                ))}
                              </>
                            )}

                            {!obj.isBackendAnalysisObject && (
                              <>
                                <div className="h-px bg-slate-700/50 my-1" />

                                {confirmDeleteId === obj.id ? (
                                  <div className="flex gap-1 px-2 py-1">
                                    <button
                                      data-close-popover
                                      onClick={() => handleDeleteObject(obj.id)}
                                      className="btn btn-primary flex-1 !bg-danger"
                                    >
                                      Confirm
                                    </button>
                                    <button
                                      onClick={() => setConfirmDeleteId(null)}
                                      className="btn btn-secondary flex-1"
                                    >
                                      Cancel
                                    </button>
                                  </div>
                                ) : (
                                  <button
                                    onClick={() => handleDeleteObject(obj.id)}
                                    className="min-h-11 w-full rounded-lg text-left px-3 py-2 text-sm text-danger hover:bg-danger/10 flex items-center gap-2"
                                  >
                                    <Trash2 size={14} /> Delete Object
                                  </button>
                                )}
                              </>
                            )}
                        </DetailsPopover>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {/* Modals */}
      {showLoadModal && canWriteProject && (
        <LoadModal
          onClose={() => setShowLoadModal(false)}
          onLoaded={handleLoaded}
          loadingId={loadingId}
          setLoadingId={setLoadingId}
          activeProjectId={activeProjectId}
          onCreateAnalysisObjectForLoad={onCreateAnalysisObjectForLoad}
          onLoadFailed={handleLoadFailed}
          legacyLocalImportsEnabled={deploymentPolicy.legacyLocalImportsEnabled === true}
          onOpenPipelineManager={() => {
            setShowLoadModal(false);
            setActiveTab?.('pipeline-manager');
          }}
        />
      )}
    </div>
  );
}
