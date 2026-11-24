import React, { useState, useEffect, useCallback, useMemo, useId } from 'react';
import PageHeader from '../components/PageHeader';
import FigureSavePanel from '../components/FigureSavePanel';
import { safeFigureFileName } from '../figureFileName';
import { publicErrorMessage } from '../publicError';
import { FIGURE_WRITE_ROLES, parseTags } from '../figures/FigureProjectContext';
import {
  ImageIcon, Trash2, Check, X, BookImage, Loader2, LayoutGrid, Rows3, RefreshCw, Search,
  FolderOpen, Tag, Pencil, FileCode2, Download, CheckSquare, Square, GitBranch, AlertTriangle,
} from 'lucide-react';

const PLOT_TYPE_COLORS = {
  UMAP:        { bg: 'bg-indigo-500/15', text: 'text-indigo-400', border: 'border-indigo-500/30' },
  FeaturePlot: { bg: 'bg-violet-500/15', text: 'text-violet-400', border: 'border-violet-500/30' },
  DotPlot:     { bg: 'bg-cyan-500/15',   text: 'text-cyan-400',   border: 'border-cyan-500/30'   },
  Heatmap:     { bg: 'bg-rose-500/15',   text: 'text-rose-400',   border: 'border-rose-500/30'   },
  Violin:      { bg: 'bg-amber-500/15',  text: 'text-amber-400',  border: 'border-amber-500/30'  },
  Unknown:     { bg: 'bg-slate-500/15',  text: 'text-slate-400',  border: 'border-slate-500/30'  },
};
const ALL_TYPES = ['UMAP', 'FeaturePlot', 'DotPlot', 'Heatmap', 'Violin'];
const UNFILED = '__unfiled__';

function PlotTypeBadge({ plotType }) {
  const c = PLOT_TYPE_COLORS[plotType] || PLOT_TYPE_COLORS.Unknown;
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${c.bg} ${c.text} ${c.border}`}>
      {plotType}
    </span>
  );
}

function formatDate(value) {
  return value
    ? new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : '—';
}

function downloadText(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function downloadDataUrl(name, dataUrl) {
  const link = document.createElement('a');
  link.href = dataUrl;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function fileStem(figure) {
  return String(figure.title || figure.plotType || 'figure').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'figure';
}

function Thumbnail({ figure, className }) {
  const [failed, setFailed] = useState(false);
  if (!figure.thumbnailB64 || failed) {
    return (
      <div className="text-center text-slate-300">
        <ImageIcon size={32} className="mx-auto mb-1 opacity-40" />
        <p className="text-xs text-slate-400">No preview</p>
      </div>
    );
  }
  return <img src={figure.thumbnailB64} alt={figure.title || figure.plotType} className={className} onError={() => setFailed(true)} />;
}

function FigureCard({ figure, compact, selectable, selected, onToggle, onOpen, versionCount }) {
  const fileName = safeFigureFileName(figure.filePath);
  const select = selectable && (
    <button
      type="button" onClick={(event) => { event.stopPropagation(); onToggle(figure.id); }}
      aria-pressed={selected} aria-label={`${selected ? 'Deselect' : 'Select'} ${figure.title || figure.plotType}`}
      className={`p-1 rounded ${selected ? 'text-primary' : 'text-textMuted hover:text-text'}`}
    >
      {selected ? <CheckSquare size={16} /> : <Square size={16} />}
    </button>
  );
  const meta = (
    <div className="flex items-center gap-2 flex-wrap">
      <PlotTypeBadge plotType={figure.plotType} />
      {figure.collection && <span className="text-xs text-textMuted inline-flex items-center gap-1"><FolderOpen size={12} />{figure.collection}</span>}
      {versionCount > 1 && <span className="text-xs text-textMuted inline-flex items-center gap-1"><GitBranch size={12} />{versionCount} versions</span>}
      <span className="text-xs text-slate-500">{formatDate(figure.createdAt)}</span>
    </div>
  );
  if (compact) {
    return (
      <div className={`flex items-center gap-3 p-3 bg-surface border rounded-lg transition-all ${selected ? 'border-primary' : 'border-border hover:border-primary/40'}`}>
        {select}
        <button type="button" onClick={() => onOpen(figure)} className="flex items-center gap-3 flex-1 min-w-0 text-left">
          <div className="w-16 h-12 bg-white rounded border border-slate-200 flex items-center justify-center flex-shrink-0 overflow-hidden">
            <Thumbnail figure={figure} className="w-full h-full object-contain" />
          </div>
          <div className="flex-1 min-w-0 space-y-0.5">
            <p className="text-sm font-semibold text-text truncate">{figure.title || figure.plotType}</p>
            {meta}
            {fileName && <p className="text-xs text-slate-500 truncate font-mono">{fileName}</p>}
          </div>
        </button>
      </div>
    );
  }
  return (
    <div className={`bg-surface border rounded-xl overflow-hidden transition-all flex flex-col ${selected ? 'border-primary ring-1 ring-primary' : 'border-border hover:border-primary/40'}`}>
      <button type="button" onClick={() => onOpen(figure)} className="bg-white flex items-center justify-center h-48 overflow-hidden" aria-label={`Open ${figure.title || figure.plotType}`}>
        <Thumbnail figure={figure} className="w-full h-full object-contain p-2" />
      </button>
      <div className="p-4 flex-1 flex flex-col gap-2">
        <div className="flex items-start gap-2">
          {select}
          <p className="font-semibold text-text text-sm leading-tight line-clamp-2 flex-1">{figure.title || figure.plotType}</p>
        </div>
        {meta}
        {figure.tags?.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {figure.tags.map((tag) => <span key={tag} className="text-xs px-1.5 py-0.5 rounded bg-primary/10 text-primary">{tag}</span>)}
          </div>
        )}
        {fileName && <p className="text-xs text-slate-500 truncate font-mono">{fileName}</p>}
      </div>
    </div>
  );
}

function FigureViewer({
  figure, versions, editable, isProject, collections, onClose, onSaveDetails, onDelete, onEdit,
  editBlockedReason, onOpenAnalysis, onExport, onSelectVersion,
}) {
  const ids = useId();
  const [title, setTitle] = useState(figure.title || '');
  const [collection, setCollection] = useState(figure.collection || '');
  const [tagText, setTagText] = useState((figure.tags || []).join(', '));
  const [notes, setNotes] = useState(figure.notes || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const dirty = title !== (figure.title || '') || collection !== (figure.collection || '')
    || tagText !== (figure.tags || []).join(', ') || notes !== (figure.notes || '');

  useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      await onSaveDetails({ title, collection, tags: parseTags(tagText), notes });
    } catch (e) {
      setError(publicErrorMessage(e, 'Figure details could not be saved.'));
    } finally {
      setSaving(false);
    }
  };
  const settings = Object.entries(figure.params || {})
    .filter(([key, value]) => value !== null && value !== '' && !(Array.isArray(value) && value.length === 0) && key !== 'revision_of');
  const inputClass = 'w-full bg-background border border-border rounded px-3 py-1.5 text-sm text-text focus:outline-none focus:border-primary disabled:opacity-70';

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-2 sm:p-6" onClick={onClose}>
      <div
        role="dialog" aria-modal="true" aria-labelledby={`${ids}-title`}
        className="bg-background border border-border rounded-xl shadow-2xl w-full max-w-6xl max-h-full flex flex-col overflow-hidden"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 px-5 py-3 border-b border-border bg-surface">
          <div className="min-w-0">
            <h3 id={`${ids}-title`} className="font-bold text-text truncate">{figure.title || figure.plotType}</h3>
            <p className="text-xs text-textMuted">{figure.plotType} · saved {formatDate(figure.createdAt)}{figure.updatedAt ? ` · edited ${formatDate(figure.updatedAt)}` : ''}</p>
          </div>
          <button onClick={onClose} aria-label="Close figure" className="p-1.5 rounded text-textMuted hover:text-text"><X size={18} /></button>
        </div>
        <div className="flex-1 min-h-0 flex flex-col lg:flex-row overflow-auto">
          <div className="flex-1 bg-white flex items-center justify-center p-4 min-h-[40vh]">
            <Thumbnail figure={figure} className="max-w-full max-h-[70vh] object-contain" />
          </div>
          <div className="w-full lg:w-96 shrink-0 border-t lg:border-t-0 lg:border-l border-border p-4 space-y-4 overflow-y-auto">
            {isProject && (
              <div className="flex flex-wrap gap-2">
                {editable && (
                  <button className="btn btn-primary text-xs" onClick={onEdit} disabled={Boolean(editBlockedReason)} title={editBlockedReason || 'Adjust settings and save a new version'}>
                    <Pencil size={14} /> Edit figure
                  </button>
                )}
                <button className="btn btn-secondary text-xs" onClick={onExport} title="Export the steps this figure depends on">
                  <FileCode2 size={14} /> Export with history
                </button>
                {figure.thumbnailB64 && (
                  <button className="btn btn-secondary text-xs" onClick={() => downloadDataUrl(`${fileStem(figure)}.png`, figure.thumbnailB64)}>
                    <Download size={14} /> Preview PNG
                  </button>
                )}
              </div>
            )}
            {editable && editBlockedReason && (
              <div className="text-xs text-textMuted bg-surface border border-border rounded p-2 space-y-2">
                <p>{editBlockedReason}</p>
                {onOpenAnalysis && <button className="btn btn-secondary text-xs" onClick={onOpenAnalysis}>Open that analysis</button>}
              </div>
            )}
            <div className="space-y-3">
              <div>
                <label htmlFor={`${ids}-name`} className="block text-xs text-textMuted font-medium mb-1">Title</label>
                <input id={`${ids}-name`} className={inputClass} value={title} disabled={!editable} onChange={(e) => setTitle(e.target.value)} />
              </div>
              {isProject && (
                <>
                  <div>
                    <label htmlFor={`${ids}-collection`} className="block text-xs text-textMuted font-medium mb-1">Collection</label>
                    <input id={`${ids}-collection`} list={`${ids}-collections`} className={inputClass} value={collection} disabled={!editable}
                      placeholder="e.g. Figure 2" onChange={(e) => setCollection(e.target.value)} />
                    <datalist id={`${ids}-collections`}>{collections.map((name) => <option key={name} value={name} />)}</datalist>
                  </div>
                  <div>
                    <label htmlFor={`${ids}-tags`} className="block text-xs text-textMuted font-medium mb-1">Tags (comma-separated)</label>
                    <input id={`${ids}-tags`} className={inputClass} value={tagText} disabled={!editable} onChange={(e) => setTagText(e.target.value)} />
                  </div>
                  <div>
                    <label htmlFor={`${ids}-notes`} className="block text-xs text-textMuted font-medium mb-1">Caption / notes</label>
                    <textarea id={`${ids}-notes`} rows={3} className={inputClass} value={notes} disabled={!editable} onChange={(e) => setNotes(e.target.value)} />
                  </div>
                </>
              )}
              {error && <p role="alert" className="text-xs text-danger">{error}</p>}
              {editable && isProject && (
                <button className="btn btn-primary text-xs w-full" disabled={!dirty || saving} onClick={save}>
                  {saving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Save details
                </button>
              )}
            </div>
            {versions.length > 1 && (
              <div>
                <p className="text-xs font-medium text-textMuted mb-1">Versions</p>
                <ol className="space-y-1">
                  {versions.map((version, index) => (
                    <li key={version.id}>
                      <button
                        className={`text-xs w-full text-left px-2 py-1 rounded ${version.id === figure.id ? 'bg-primary/10 text-primary' : 'hover:bg-surface text-text'}`}
                        onClick={() => onSelectVersion(version)}
                      >
                        v{index + 1} · {version.title || version.plotType} · {formatDate(version.createdAt)}
                      </button>
                    </li>
                  ))}
                </ol>
              </div>
            )}
            {settings.length > 0 && (
              <details>
                <summary className="text-xs font-medium text-textMuted cursor-pointer">Saved settings</summary>
                <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                  {settings.map(([key, value]) => (
                    <React.Fragment key={key}>
                      <dt className="text-textMuted font-mono truncate">{key}</dt>
                      <dd className="text-text font-mono truncate" title={String(value)}>{Array.isArray(value) ? value.join(', ') : String(value)}</dd>
                    </React.Fragment>
                  ))}
                </dl>
              </details>
            )}
            {figure.analysisObjectId && <p className="text-xs text-textMuted">Drawn from analysis <span className="font-mono">{figure.analysisObjectId}</span></p>}
            {editable && (
              <div className="pt-2 border-t border-border">
                {confirmDelete ? (
                  <div className="flex gap-2">
                    <button className="btn text-xs bg-danger text-on-accent" onClick={onDelete}><Trash2 size={14} /> Remove figure</button>
                    <button className="btn btn-secondary text-xs" onClick={() => setConfirmDelete(false)}>Cancel</button>
                  </div>
                ) : (
                  <button className="text-xs text-textMuted hover:text-danger inline-flex items-center gap-1" onClick={() => setConfirmDelete(true)}>
                    <Trash2 size={14} /> Remove from gallery
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function BundleDialog({ projectId, figureIds, onClose }) {
  const [state, setState] = useState({ loading: true, bundle: null, error: '' });
  useEffect(() => {
    let cancelled = false;
    window.electronAPI.exportFigureBundle(projectId, { figureIds })
      .then((bundle) => { if (!cancelled) setState({ loading: false, bundle, error: '' }); })
      .catch((e) => { if (!cancelled) setState({ loading: false, bundle: null, error: publicErrorMessage(e, 'The figure history could not be exported.') }); });
    return () => { cancelled = true; };
  }, [projectId, figureIds]);
  useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  const { bundle } = state;
  const steps = bundle ? new Map(bundle.steps.map((step) => [step.id, step])) : new Map();
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-2 sm:p-6" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-labelledby="bundle-dialog-title"
        className="bg-background border border-border rounded-xl shadow-2xl w-full max-w-3xl max-h-full flex flex-col overflow-hidden"
        onClick={(event) => event.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-border bg-surface">
          <h3 id="bundle-dialog-title" className="font-bold text-text">Export {figureIds.length === 1 ? 'figure' : `${figureIds.length} figures`} with history</h3>
          <button onClick={onClose} aria-label="Close export" className="p-1.5 rounded text-textMuted hover:text-text"><X size={18} /></button>
        </div>
        <div className="flex-1 overflow-y-auto p-5 space-y-4 text-sm">
          {state.loading && <p className="flex items-center gap-2 text-textMuted"><Loader2 size={16} className="animate-spin" /> Working out what these figures depend on…</p>}
          {state.error && <p role="alert" className="text-danger">{state.error}</p>}
          {bundle && (
            <>
              <p className="text-text">
                Keeps <strong>{bundle.summary.kept.steps}</strong> of {bundle.summary.project.steps} recorded steps
                and <strong>{bundle.summary.kept.objects}</strong> of {bundle.summary.project.objects} analysis objects.
                {bundle.omittedSteps.length > 0 && ` ${bundle.omittedSteps.length} step${bundle.omittedSteps.length === 1 ? '' : 's'} on the same history ${bundle.omittedSteps.length === 1 ? 'is' : 'are'} not needed and left out.`}
              </p>
              {bundle.unresolved.length > 0 && (
                <div className="flex gap-2 text-xs bg-amber-500/10 border border-amber-500/30 rounded p-2 text-text">
                  <AlertTriangle size={16} className="text-amber-500 shrink-0" />
                  <p>Some state has no recorded step ({bundle.unresolved.map((item) => `${item.parts.join(', ')} on ${item.objectId}`).join('; ')}). It was loaded or changed outside the recorded history; the script marks where it starts.</p>
                </div>
              )}
              <ol className="space-y-1 text-xs">
                {bundle.order.map((node, index) => (
                  <li key={node.id} className="flex gap-2 items-baseline">
                    <span className="text-textMuted w-6 text-right shrink-0">{index + 1}.</span>
                    {node.kind === 'object' && <span className="font-semibold text-text">Analysis object <span className="font-mono">{node.id}</span></span>}
                    {node.kind === 'job' && <span className="text-text">Server job <span className="font-mono">{node.id}</span></span>}
                    {node.kind === 'step' && (
                      <span className="text-text">{steps.get(node.id)?.operation || 'step'}{steps.get(node.id)?.conservative && <span className="text-amber-600"> · custom code, kept to be safe</span>}</span>
                    )}
                    {node.kind === 'figure' && <span className="text-primary font-medium">Figure: {bundle.figures.find((f) => f.id === node.id)?.title || node.id}</span>}
                  </li>
                ))}
              </ol>
              <details>
                <summary className="cursor-pointer text-xs text-textMuted">Preview R script</summary>
                <pre className="mt-2 max-h-72 overflow-auto bg-surface border border-border rounded p-3 text-xs font-mono whitespace-pre">{bundle.script}</pre>
              </details>
            </>
          )}
        </div>
        <div className="px-5 py-3 border-t border-border bg-surface flex flex-wrap gap-2 justify-end">
          <button className="btn btn-secondary text-xs" disabled={!bundle}
            onClick={() => downloadText('figure-bundle.json', JSON.stringify(bundle, null, 2), 'application/json')}>
            <Download size={14} /> Manifest (JSON)
          </button>
          <button className="btn btn-primary text-xs" disabled={!bundle}
            onClick={() => downloadText('figure-bundle.R', bundle.script, 'text/x-r')}>
            <FileCode2 size={14} /> Download R script
          </button>
        </div>
      </div>
    </div>
  );
}

// Group revisions: a figure saved with params.revision_of joins its root.
function versionChains(figures) {
  const byId = new Map(figures.map((figure) => [figure.id, figure]));
  const rootOf = (figure) => {
    let current = figure;
    const seen = new Set();
    while (current.params?.revision_of && byId.has(current.params.revision_of) && !seen.has(current.id)) {
      seen.add(current.id);
      current = byId.get(current.params.revision_of);
    }
    return current.id;
  };
  const chains = new Map();
  for (const figure of figures) {
    const root = rootOf(figure);
    if (!chains.has(root)) chains.set(root, []);
    chains.get(root).push(figure);
  }
  for (const chain of chains.values()) chain.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  return chains;
}

export default function Publication({
  userEmail, userId = null, isActive = true, projectId = null, projectName = '', projectRole = null, objectId = null,
  deploymentPolicy = {}, onOpenAnalysisObject, figureRefreshToken = 0,
}) {
  const isProject = Boolean(projectId);
  const canWrite = FIGURE_WRITE_ROLES.includes(projectRole);
  const [figures, setFigures] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [filterType, setFilterType] = useState('All');
  const [filterCollection, setFilterCollection] = useState('All');
  const [query, setQuery] = useState('');
  const [viewMode, setViewMode] = useState('grid');
  const [showAllVersions, setShowAllVersions] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  const [openId, setOpenId] = useState(null);
  const [editing, setEditing] = useState(null);
  const [bundleIds, setBundleIds] = useState(null);
  const [bulkCollection, setBulkCollection] = useState('');
  const [notice, setNotice] = useState('');

  const loadFigures = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      if (isProject && window.electronAPI?.listProjectFigures) {
        setFigures((await window.electronAPI.listProjectFigures(projectId)) || []);
      } else if (window.electronAPI?.getFigures) {
        setFigures((await window.electronAPI.getFigures(userEmail || '')) || []);
      }
    } catch (e) {
      setLoadError(publicErrorMessage(e, 'Figures could not be loaded.'));
    } finally {
      setLoading(false);
    }
  }, [isProject, projectId, userEmail]);

  // TabContent keeps this page mounted while another workspace view is active.
  // Refresh on entry so a figure saved elsewhere appears immediately.
  useEffect(() => {
    if (isActive) loadFigures();
  }, [isActive, loadFigures, figureRefreshToken]);
  useEffect(() => { setSelected(new Set()); setOpenId(null); }, [projectId]);

  const chains = useMemo(() => versionChains(figures), [figures]);
  const chainOf = useMemo(() => {
    const map = new Map();
    for (const chain of chains.values()) for (const figure of chain) map.set(figure.id, chain);
    return map;
  }, [chains]);
  const collections = useMemo(() => [...new Set(figures.map((f) => f.collection).filter(Boolean))].sort(), [figures]);

  const visible = useMemo(() => {
    const latest = showAllVersions ? figures : [...chains.values()].map((chain) => chain[chain.length - 1]);
    const text = query.trim().toLowerCase();
    return latest
      .filter((f) => filterType === 'All' || f.plotType === filterType)
      .filter((f) => filterCollection === 'All' || (filterCollection === UNFILED ? !f.collection : f.collection === filterCollection))
      .filter((f) => !text || [f.title, f.plotType, f.collection, f.notes, ...(f.tags || [])]
        .some((value) => String(value || '').toLowerCase().includes(text)))
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }, [figures, chains, showAllVersions, filterType, filterCollection, query]);

  const grouped = useMemo(() => {
    if (!isProject) return [['', visible]];
    const groups = new Map();
    for (const figure of visible) {
      const key = figure.collection || '';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(figure);
    }
    return [...groups.entries()].sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)));
  }, [visible, isProject]);

  const openFigure = figures.find((f) => f.id === openId) || null;
  const toggle = (id) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  // Owners and admins organise any figure; analysts organise their own.
  const canEditFigure = (figure) => isProject && canWrite
    && (['owner', 'admin'].includes(projectRole) || Number(figure.createdByUserId) === Number(userId));
  const saveDetails = async (figure, changes) => {
    const updated = await window.electronAPI.updateProjectFigure(projectId, figure.id, changes);
    setFigures((current) => current.map((f) => (f.id === updated.id ? updated : f)));
  };
  const removeFigure = async (figure) => {
    try {
      if (isProject) await window.electronAPI.removeProjectFigure(projectId, figure.id);
      else await window.electronAPI.deleteFigure?.(figure.id);
      setFigures((current) => current.filter((f) => f.id !== figure.id));
      setSelected((current) => { const next = new Set(current); next.delete(figure.id); return next; });
      setOpenId(null);
    } catch (e) {
      setNotice(publicErrorMessage(e, 'The figure could not be removed.'));
    }
  };
  const fileSelected = async () => {
    const ids = [...selected];
    try {
      const updated = await Promise.all(ids.map((id) => window.electronAPI.updateProjectFigure(projectId, id, { collection: bulkCollection })));
      const byId = new Map(updated.map((f) => [f.id, f]));
      setFigures((current) => current.map((f) => byId.get(f.id) || f));
      setNotice(`${ids.length} figure${ids.length === 1 ? '' : 's'} moved to ${bulkCollection || 'no collection'}.`);
    } catch (e) {
      setNotice(publicErrorMessage(e, 'Some figures could not be moved. You can file only figures you saved unless you own the project.'));
    }
  };
  const editBlockedReason = (figure) => {
    if (!figure.analysisObjectId) return 'This figure is not linked to an analysis, so it cannot be redrawn.';
    if (figure.analysisObjectId !== objectId) return 'Open the analysis this figure was drawn from to redraw it with new settings.';
    return '';
  };

  const selectableCount = visible.length;
  const description = isProject
    ? <>{figures.length} figure{figures.length !== 1 ? 's' : ''} in {projectName || 'this project'}. Project members can see them.</>
    : <>{figures.length} figure{figures.length !== 1 ? 's' : ''} saved. Figures remain in this private gallery.</>;

  return (
    <div className="h-full w-full flex flex-col bg-background overflow-hidden">
      <PageHeader title="Figure Gallery" icon={BookImage} description={description} className="px-4 sm:px-8 pt-6 pb-4 border-b border-border" actions={<>
        <button onClick={loadFigures} disabled={loading} className="btn btn-secondary" aria-label="Refresh gallery" title="Refresh gallery">
          <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
        </button>
        <div className="flex bg-surface border border-border rounded-lg p-0.5">
          <button onClick={() => setViewMode('grid')} className={`min-h-10 min-w-10 rounded transition-colors ${viewMode === 'grid' ? 'bg-primary text-white' : 'text-textMuted hover:text-text'}`} aria-label="Grid view" aria-pressed={viewMode === 'grid'} title="Grid view">
            <LayoutGrid size={16} />
          </button>
          <button onClick={() => setViewMode('list')} className={`min-h-10 min-w-10 rounded transition-colors ${viewMode === 'list' ? 'bg-primary text-white' : 'text-textMuted hover:text-text'}`} aria-label="List view" aria-pressed={viewMode === 'list'} title="List view">
            <Rows3 size={16} />
          </button>
        </div>
      </>} />

      <div className="px-4 sm:px-8 py-3 border-b border-border/50 flex items-center gap-2 flex-wrap shrink-0 bg-surface/40">
        <label className="relative">
          <span className="sr-only">Search figures</span>
          <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-textMuted" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search title, tag, caption"
            className="pl-7 pr-2 py-1 text-xs bg-background border border-border rounded-full w-52 focus:outline-none focus:border-primary" />
        </label>
        {['All', ...ALL_TYPES].map((type) => (
          <button key={type} onClick={() => setFilterType(type)} aria-pressed={filterType === type}
            className={`px-3 py-1 rounded-full text-xs font-medium border transition-all ${filterType === type ? 'bg-primary text-white border-primary' : 'border-border text-textMuted hover:text-text hover:border-primary/40'}`}>
            {type}
            {type !== 'All' && <span className="ml-1 text-slate-400">({figures.filter((f) => f.plotType === type).length})</span>}
          </button>
        ))}
        {isProject && collections.length > 0 && (
          <label className="text-xs text-textMuted inline-flex items-center gap-1">
            <FolderOpen size={14} />
            <span className="sr-only">Collection</span>
            <select value={filterCollection} onChange={(e) => setFilterCollection(e.target.value)} className="bg-background border border-border rounded px-2 py-1 text-xs text-text">
              <option value="All">All collections</option>
              {collections.map((name) => <option key={name} value={name}>{name}</option>)}
              <option value={UNFILED}>Not in a collection</option>
            </select>
          </label>
        )}
        {isProject && (
          <label className="text-xs text-textMuted inline-flex items-center gap-1">
            <input type="checkbox" checked={showAllVersions} onChange={(e) => setShowAllVersions(e.target.checked)} /> All versions
          </label>
        )}
        <span className="ml-auto text-xs text-textMuted">{visible.length} shown</span>
      </div>

      {isProject && selected.size > 0 && (
        <div className="px-4 sm:px-8 py-2 border-b border-primary/30 bg-primary/5 flex items-center gap-2 flex-wrap text-xs">
          <span className="font-medium text-text">{selected.size} selected</span>
          <button className="btn btn-primary text-xs" onClick={() => setBundleIds([...selected])}><FileCode2 size={14} /> Export with history</button>
          {canWrite && (
            <span className="inline-flex items-center gap-1">
              <input list="bulk-collections" value={bulkCollection} onChange={(e) => setBulkCollection(e.target.value)} placeholder="Collection"
                aria-label="Move selected figures to collection" className="px-2 py-1 bg-background border border-border rounded w-36" />
              <datalist id="bulk-collections">{collections.map((name) => <option key={name} value={name} />)}</datalist>
              <button className="btn btn-secondary text-xs" onClick={fileSelected}><Tag size={14} /> Move</button>
            </span>
          )}
          <button className="text-textMuted hover:text-text" onClick={() => setSelected(new Set(visible.map((f) => f.id)))}>Select all {selectableCount}</button>
          <button className="text-textMuted hover:text-text" onClick={() => setSelected(new Set())}>Clear</button>
        </div>
      )}
      {notice && (
        <div role="status" className="px-4 sm:px-8 py-2 text-xs text-text bg-surface border-b border-border flex justify-between">
          <span>{notice}</span>
          <button aria-label="Dismiss" onClick={() => setNotice('')}><X size={14} /></button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto custom-scrollbar p-4 sm:p-8">
        {loading ? (
          <div className="flex flex-col items-center justify-center h-64">
            <Loader2 size={36} className="text-primary animate-spin mb-4" />
            <p className="text-textMuted text-sm">Loading figure gallery…</p>
          </div>
        ) : loadError ? (
          <p role="alert" className="text-danger text-sm">{loadError}</p>
        ) : visible.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 text-center">
            <div className="w-20 h-20 rounded-2xl bg-primary/10 border-2 border-primary/20 flex items-center justify-center mb-5">
              <BookImage size={36} className="text-primary/50" />
            </div>
            <h3 className="text-lg font-bold text-text mb-2">
              {figures.length > 0 ? 'No figures match these filters' : 'No figures yet'}
            </h3>
            <p className="text-textMuted text-sm max-w-xs">
              {figures.length > 0
                ? 'Clear the search or choose another type or collection.'
                : 'Click "Save Figure" in any plot (UMAP, Feature plot, Dot plot, Heatmap, or Violin) to add figures here.'}
            </p>
          </div>
        ) : (
          <div className="space-y-8">
            {grouped.map(([group, items]) => (
              <section key={group || 'unfiled'} aria-label={group || 'Not in a collection'}>
                {isProject && grouped.length > 1 && (
                  <h3 className="text-sm font-semibold text-text mb-3 flex items-center gap-2"><FolderOpen size={14} />{group || 'Not in a collection'} <span className="text-textMuted font-normal">({items.length})</span></h3>
                )}
                <div className={viewMode === 'grid' ? 'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5' : 'space-y-2 max-w-4xl'}>
                  {items.map((figure) => (
                    <FigureCard key={figure.id} figure={figure} compact={viewMode === 'list'} selectable={isProject}
                      selected={selected.has(figure.id)} onToggle={toggle} onOpen={(f) => setOpenId(f.id)}
                      versionCount={chainOf.get(figure.id)?.length || 1} />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>

      {openFigure && !editing && (
        <FigureViewer
          key={openFigure.id}
          figure={openFigure}
          versions={chainOf.get(openFigure.id) || [openFigure]}
          editable={isProject ? canEditFigure(openFigure) : true}
          isProject={isProject}
          collections={collections}
          onClose={() => setOpenId(null)}
          onSaveDetails={(changes) => saveDetails(openFigure, changes)}
          onDelete={() => removeFigure(openFigure)}
          onEdit={() => setEditing(openFigure)}
          editBlockedReason={editBlockedReason(openFigure)}
          onOpenAnalysis={openFigure.analysisObjectId && onOpenAnalysisObject && openFigure.analysisObjectId !== objectId
            ? () => { onOpenAnalysisObject(projectId, openFigure.analysisObjectId); setOpenId(null); }
            : null}
          onExport={() => setBundleIds([openFigure.id])}
          onSelectVersion={(version) => setOpenId(version.id)}
        />
      )}
      {editing && (
        <FigureSavePanel
          key={`edit-${editing.id}`}
          isOpen
          onClose={() => setEditing(null)}
          plotType={editing.plotType}
          baseParams={{ features: editing.params?.features || [], groupBy: editing.params?.group_by || 'seurat_clusters' }}
          userEmail={userEmail || ''}
          objectId={objectId || ''}
          deploymentPolicy={deploymentPolicy}
          initialParams={{ ...(editing.params || {}), title: editing.title || editing.params?.title || '' }}
          initialGallery={{ collection: editing.collection || '', tags: editing.tags || [] }}
          revisionOf={editing.id}
          onSaved={(saved) => {
            setEditing(null);
            if (saved?.id) { setFigures((current) => [saved, ...current]); setOpenId(saved.id); }
          }}
        />
      )}
      {bundleIds && <BundleDialog projectId={projectId} figureIds={bundleIds} onClose={() => setBundleIds(null)} />}
    </div>
  );
}
