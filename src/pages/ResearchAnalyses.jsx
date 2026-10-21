import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Archive, FileText, Link2, Loader2, Plus, RefreshCw } from 'lucide-react';
import useExecutionTarget from '../runtime/useExecutionTarget';
import { publicErrorMessage } from '../publicError';
import { createAnalysis, getAnalysis, listAnalyses, listReferenceOptions, updateAnalysis } from '../analyses/researchAnalysisApi';
import { RESEARCH_ANALYSIS_ID, RESEARCH_ANALYSIS_LIMITS } from '../../shared/researchAnalysis.mjs';
import { savedReferenceId, savedReferenceTitle } from '../analyses/savedWorkReference';

const NotebookWorkspace = React.lazy(() => import('../notebooks/NotebookWorkspace'));
const ExistingWorkBrowser = React.lazy(() => import('../analyses/ExistingWorkBrowser'));
const AnalysisAttachments = React.lazy(() => import('../analyses/AnalysisAttachments'));

const WRITE_ROLES = new Set(['owner', 'admin', 'analyst']);
const cleanReferences = analysis => (analysis.references || []).map(item => item.reference);
const referenceKey = reference => JSON.stringify(reference);
const draftFor = analysis => ({
  baseVersion: analysis.version, name: analysis.name, description: analysis.description || '',
  references: cleanReferences(analysis), baseName: analysis.name,
  baseDescription: analysis.description || '', baseReferences: cleanReferences(analysis),
});
const referenceTitle = savedReferenceTitle;
const versionId = savedReferenceId;
function rebaseDraft(draft, latest) {
  const latestDraft = draftFor(latest);
  const originalKeys = new Set(draft.baseReferences.map(referenceKey));
  const editedKeys = new Set(draft.references.map(referenceKey));
  const removed = new Set([...originalKeys].filter(key => !editedKeys.has(key)));
  const merged = latestDraft.references.filter(reference => !removed.has(referenceKey(reference)));
  const added = draft.references.filter(reference => !originalKeys.has(referenceKey(reference)));
  return {
    ...latestDraft,
    name: draft.name === draft.baseName ? latestDraft.name : draft.name,
    description: draft.description === draft.baseDescription ? latestDraft.description : draft.description,
    references: [...new Map([...merged, ...added].map(reference => [referenceKey(reference), reference])).values()],
  };
}
const describeTime = value => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Saved in this project' : `Updated ${date.toLocaleDateString()}`;
};

function ProjectAnalyses({ projectId, projectName, role, userId, theme, isActive, onOpenWorkspace, onOpenAdvanced, onOpenOriginal, onOpenWorkflow, connection }) {
  const [items, setItems] = useState([]);
  const [status, setStatus] = useState('active');
  const [nextCursor, setNextCursor] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [notebookVisited, setNotebookVisited] = useState(false);
  const [notebookOpen, setNotebookOpen] = useState(false);
  const [attachmentsVisited, setAttachmentsVisited] = useState(false), [attachmentsOpen, setAttachmentsOpen] = useState(false);
  const attachmentsButton = useRef(null);
  const [adoptionOpen, setAdoptionOpen] = useState(false), [adoptionVisited, setAdoptionVisited] = useState(false);
  const adoptionButton = useRef(null), adoptionVisible = useRef(false);
  adoptionVisible.current = adoptionOpen;
  const [drafts, setDrafts] = useState({});
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [mutation, setMutation] = useState('');
  const [conflict, setConflict] = useState(null);
  const [notice, setNotice] = useState('');
  const [options, setOptions] = useState(null);
  const [knownLabels, setKnownLabels] = useState({});
  const [optionCursor, setOptionCursor] = useState(null);
  const [optionsLoading, setOptionsLoading] = useState(false);
  const mounted = useRef(false);
  const listRequest = useRef(0);
  const selectionRequest = useRef(0);
  const optionsRequest = useRef(0);
  const pendingCreate = useRef(null);
  const loaded = useRef(false);
  const listAbort = useRef(null);
  const scrollContainer = useRef(null);
  const listScroll = useRef(0);
  const rowButtons = useRef(new Map());
  const detailBack = useRef(null);
  const detailScroller = useRef(null);
  const canWrite = WRITE_ROLES.has(role);
  const selectedId = selected?.id;
  const draft = selected && (drafts[selected.id] || draftFor(selected));
  const dirty = selected && (draft.baseVersion !== selected.version || draft.name !== selected.name
    || draft.description !== (selected.description || '')
    || JSON.stringify(draft.references) !== JSON.stringify(cleanReferences(selected)));
  const overReferenceLimit = draft && draft.references.length > RESEARCH_ANALYSIS_LIMITS.references;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; listAbort.current?.abort(); listRequest.current += 1; selectionRequest.current += 1; };
  }, []);

  useEffect(() => {
    if (!selectedId || creating) return;
    if (window.innerWidth >= 1024) {
      if (detailScroller.current) detailScroller.current.scrollTop = 0;
      return;
    }
    if (detailOpen) {
      if (scrollContainer.current) scrollContainer.current.scrollTop = 0;
      detailBack.current?.focus({ preventScroll: true });
    } else {
      if (scrollContainer.current) scrollContainer.current.scrollTop = listScroll.current;
      rowButtons.current.get(selectedId)?.focus({ preventScroll: true });
    }
  }, [detailOpen, selectedId, creating]);

  const load = useCallback(async (cursor = null) => {
    const requestId = ++listRequest.current;
    listAbort.current?.abort();
    const controller = new AbortController();
    listAbort.current = controller;
    setLoading(true); setError('');
    try {
      const result = await listAnalyses(projectId, { status, cursor, signal: controller.signal });
      if (!mounted.current || requestId !== listRequest.current) return;
      setItems(previous => cursor
        ? [...new Map([...previous, ...result.analyses].map(item => [item.id, item])).values()]
        : result.analyses);
      setNextCursor(result.nextCursor || null); loaded.current = true;
    } catch (failure) {
      if (mounted.current && requestId === listRequest.current && failure.name !== 'AbortError') {
        setError(publicErrorMessage(failure, 'Analyses could not be loaded. Your current draft is still here.'));
      }
    } finally { if (mounted.current && requestId === listRequest.current) setLoading(false); }
  }, [projectId, status]);

  useEffect(() => { loaded.current = false; setItems([]); setNextCursor(null); }, [status]);
  useEffect(() => {
    if (projectId && isActive && !connection.blocked && !loaded.current) void load();
  }, [projectId, isActive, connection.blocked, load]);

  const edit = change => setDrafts(previous => ({
    ...previous, [selected.id]: { ...(previous[selected.id] || draftFor(selected)), ...change },
  }));

  const open = async item => {
    setNotebookOpen(false);
    setAttachmentsOpen(false);
    listScroll.current = scrollContainer.current?.scrollTop || 0;
    if (window.innerWidth >= 1024 && detailScroller.current) detailScroller.current.scrollTop = 0;
    const requestId = ++selectionRequest.current;
    optionsRequest.current += 1;
    setOptionsLoading(false);
    setError(''); setNotice(''); setConflict(null); setOptions(null); setCreating(false);
    setSelected(item); setDetailOpen(true);
    try {
      const result = await getAnalysis(projectId, item.id);
      if (mounted.current && requestId === selectionRequest.current) {
        setSelected(current => current?.id === result.analysis.id && current.version > result.analysis.version ? current : result.analysis);
      }
    } catch (failure) {
      if (mounted.current && requestId === selectionRequest.current) setError(publicErrorMessage(failure, 'This analysis could not be refreshed.'));
    }
  };

  const applySaved = analysis => {
    listRequest.current += 1;
    listAbort.current?.abort();
    setLoading(false);
    selectionRequest.current += 1;
    optionsRequest.current += 1;
    setOptionsLoading(false);
    setItems(previous => {
      const others = previous.filter(item => item.id !== analysis.id);
      const known = previous.find(item => item.id === analysis.id);
      const latest = known && known.version > analysis.version ? known : analysis;
      return latest.status === status ? [latest, ...others] : others;
    });
    setSelected(current => !current || current.id === analysis.id && current.version <= analysis.version ? analysis : current);
    setDrafts(previous => { const next = { ...previous }; delete next[analysis.id]; return next; });
    setConflict(null); setOptions(null);
    void load();
  };

  const create = async event => {
    event.preventDefault();
    if (mutation || !canWrite || connection.blocked) return;
    const input = pendingCreate.current || { requestId: crypto.randomUUID(), name: newName.trim(), description: newDescription };
    pendingCreate.current = input; setMutation('create'); setError(''); setNotice('');
    try {
      const result = await createAnalysis(projectId, input);
      if (!mounted.current) return;
      applySaved(result.analysis); setSelected(result.analysis); setDetailOpen(true); setCreating(false); setNewName(''); setNewDescription(''); pendingCreate.current = null;
      setNotice('Analysis created. Its identity and linked versions are saved in this project.');
    } catch (failure) {
      if (!mounted.current) return;
      if (failure.status >= 400 && failure.status < 500 && failure.code !== 'TARGET_EXECUTION_UNCONFIRMED') pendingCreate.current = null;
      setError(publicErrorMessage(failure, 'Creation could not be confirmed. Retry to check the same analysis.'));
    } finally { if (mounted.current) setMutation(''); }
  };

  const save = async (desiredStatus = selected.status) => {
    if (mutation || !canWrite || connection.blocked) return;
    const id = selected.id;
    setMutation('save'); setError(''); setNotice('');
    try {
      const result = await updateAnalysis(projectId, id, {
        expectedVersion: draft.baseVersion, name: draft.name.trim(), description: draft.description,
        references: draft.references, status: desiredStatus,
      });
      if (!mounted.current) return;
      applySaved(result.analysis);
      setNotice(desiredStatus === 'archived' ? 'Analysis archived. It remains available under Archived.' : 'Changes saved. Previous revisions are retained.');
    } catch (failure) {
      if (!mounted.current) return;
      if (failure.code === 'ANALYSIS_VERSION_CONFLICT' && failure.analysis?.id === id && failure.analysis.projectId === projectId) {
        setConflict(failure.analysis);
        setError('A colleague saved a newer version. Your edits are kept below; review the latest version before saving.');
      } else setError(publicErrorMessage(failure, 'Changes could not be saved. Your draft is kept here.'));
    } finally { if (mounted.current) setMutation(''); }
  };

  const showOptions = async (cursor = null) => {
    const requestId = ++optionsRequest.current;
    setOptionsLoading(true); setError('');
    try {
      const result = await listReferenceOptions(projectId, { cursor });
      if (!mounted.current || requestId !== optionsRequest.current) return;
      setOptions(previous => cursor ? [...(previous || []), ...result.options] : result.options);
      setKnownLabels(previous => ({ ...previous, ...Object.fromEntries(result.options.map(option => [referenceKey(option.reference), option.label])) }));
      setOptionCursor(result.nextCursor || null);
    } catch (failure) { if (mounted.current && requestId === optionsRequest.current) setError(publicErrorMessage(failure, 'Saved material could not be listed.')); }
    finally { if (mounted.current && requestId === optionsRequest.current) setOptionsLoading(false); }
  };

  const labelForReference = (reference, access) => `${access === 'restricted' ? 'Restricted saved source' : knownLabels[referenceKey(reference)] || referenceTitle(reference)} · ${versionId(reference).slice(-8)}`;
  const closeAdoption = () => { setAdoptionOpen(false); requestAnimationFrame(() => adoptionButton.current?.focus()); };
  const adopt = async input => {
    const selection = selectionRequest.current;
    const result = await createAnalysis(projectId, input);
    if (!mounted.current) return;
    if (!result?.analysis || result.analysis.projectId !== projectId || !RESEARCH_ANALYSIS_ID.test(result.analysis.id)
        || !Number.isSafeInteger(result.analysis.version) || result.analysis.version < 1) throw new Error('The saved analysis could not be confirmed. Retry the original request.');
    if (selection === selectionRequest.current && adoptionVisible.current) {
      applySaved(result.analysis); setSelected(result.analysis); setDetailOpen(true); setCreating(false); closeAdoption();
      setKnownLabels(previous => ({ ...previous, [referenceKey(input.references[0])]: input.name }));
      setNotice('Analysis created from the exact saved version. Original source access is unchanged.');
    } else void load();
    return result.analysis;
  };

  if (!projectId) return <div className="p-6 sm:p-10"><h2 className="text-2xl font-semibold text-text">Analyses</h2>
    <p className="mt-3 max-w-xl text-sm text-textMuted">Choose a project to organize questions, documents, results, and decisions together.</p>
    <button type="button" className="btn btn-primary mt-5" onClick={onOpenWorkspace}>Choose a project</button></div>;

  return <div className="relative h-full min-w-0">
    <div ref={scrollContainer} hidden={notebookOpen || adoptionOpen || attachmentsOpen} className="h-full overflow-auto bg-background px-4 py-6 text-text sm:px-8 sm:py-8 lg:overflow-hidden">
    <div className="mx-auto w-full max-w-6xl lg:flex lg:h-full lg:min-h-0 lg:flex-col">
      <header className="mb-7 flex shrink-0 flex-wrap items-start justify-between gap-4">
        <div><p className="mb-1 text-xs text-textMuted">{projectName || 'Current project'}</p><h2 className="text-2xl font-semibold tracking-tight">Analyses</h2>
          <p className="mt-2 max-w-xl text-sm text-textMuted">Keep a scientific question and its supporting work together.</p></div>
        <div className="flex flex-wrap gap-3"><button ref={adoptionButton} type="button" className="btn btn-secondary inline-flex items-center gap-2 text-sm" disabled={!!mutation || connection.blocked || !!pendingCreate.current}
          onClick={() => { setAdoptionVisited(true); setAdoptionOpen(true); }}><FileText size={16} />Bring saved work</button>
          {canWrite && <button type="button" className="btn btn-primary inline-flex items-center gap-2" disabled={!!mutation || connection.blocked}
          onClick={() => { setCreating(true); setError(''); setNotice(''); }}><Plus size={16} />New analysis</button>}</div>
      </header>
      {connection.blocked && <p role="status" className="mb-4 text-sm text-textMuted">Reconnect to this workspace to save changes. Your current draft is kept here.</p>}
      {error && <p role="alert" className="mb-4 rounded border border-danger/30 bg-danger/5 p-3 text-sm text-danger">{error}</p>}
      {notice && <p role="status" className="mb-4 text-sm text-success">{notice}</p>}
      {creating && <form onSubmit={create} aria-label="New analysis" className="mb-7 max-w-2xl space-y-4 rounded-lg border border-border bg-surface p-5 lg:max-h-[55%] lg:shrink-0 lg:overflow-auto">
        <h3 className="font-semibold">Start an analysis</h3>
        <label className="block text-sm">Analysis name<input aria-label="Analysis name" autoFocus required maxLength={160} value={newName} disabled={!!mutation || !!pendingCreate.current}
          onChange={event => setNewName(event.target.value)} className="mt-1.5 w-full rounded border border-border bg-background px-3 py-2" placeholder="For example, treatment response across donors" /></label>
        <label className="block text-sm">Research question or notes<textarea aria-label="Research question or notes" value={newDescription} maxLength={8000} disabled={!!mutation || !!pendingCreate.current}
          onChange={event => setNewDescription(event.target.value)} rows={3} className="mt-1.5 w-full rounded border border-border bg-background px-3 py-2" /></label>
        {pendingCreate.current && !mutation && <p className="text-xs text-textMuted">Retry checks the same creation request. It will not create a second copy.</p>}
        <div className="flex flex-wrap gap-3"><button type="submit" className="btn btn-primary" disabled={!!mutation || connection.blocked || !newName.trim()}>{mutation === 'create' ? 'Creating…' : pendingCreate.current ? 'Retry create' : 'Create analysis'}</button>
          <button type="button" className="btn btn-secondary" disabled={!!mutation || !!pendingCreate.current} onClick={() => setCreating(false)}>Cancel</button></div>
      </form>}
      <div className="grid gap-7 lg:min-h-0 lg:flex-1 lg:grid-cols-[minmax(230px,0.8fr)_minmax(0,1.6fr)]">
        <section aria-label="Project analyses" className={`min-w-0 lg:flex lg:min-h-0 lg:flex-col ${detailOpen || creating ? 'hidden' : ''}`}>
          <div className="mb-2 flex shrink-0 items-center justify-between gap-3 border-b border-border pb-3">
            <label className="text-sm"><span className="sr-only">Analysis status</span><select aria-label="Analysis status" value={status} disabled={loading || !!mutation} onChange={event => setStatus(event.target.value)} className="rounded border border-border bg-surface px-2 py-1.5"><option value="active">Active analyses</option><option value="archived">Archived analyses</option></select></label>
            <button type="button" aria-label="Refresh analyses" className="btn btn-secondary p-2" disabled={loading || connection.blocked} onClick={() => void load()}><RefreshCw size={16} /></button>
          </div>
          {loading && !items.length && <p role="status" className="py-6 text-sm text-textMuted">Loading analyses…</p>}
          {!loading && !items.length && <div className="py-7"><p className="text-sm font-medium">{status === 'archived' ? 'No archived analyses' : 'No analyses yet'}</p><p className="mt-2 text-sm text-textMuted">{status === 'archived' ? 'Archived work stays available here.' : canWrite ? 'Start with a question. You can link saved material without copying large objects.' : 'Analyses created by your project colleagues will appear here.'}</p></div>}
          <ul aria-label="Analysis list" tabIndex={0} className="divide-y divide-border rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary lg:min-h-0 lg:flex-1 lg:overflow-auto">{items.map(item => <li key={item.id}><button ref={element => { if (element) rowButtons.current.set(item.id, element); else rowButtons.current.delete(item.id); }} type="button" disabled={!!mutation} aria-pressed={selected?.id === item.id} onClick={() => void open(item)}
            className={`w-full rounded px-3 py-4 text-left transition-colors hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${selected?.id === item.id ? 'bg-primary/10' : ''}`}>
            <span className="block break-words text-sm font-semibold">{item.name}</span><span className="mt-1.5 block text-xs text-textMuted">{describeTime(item.updatedAt)} · Version {item.version}{drafts[item.id] ? ' · Draft edited' : ''}</span>
          </button></li>)}</ul>
          {nextCursor && <button type="button" className="btn btn-secondary mt-4 shrink-0" disabled={loading} onClick={() => void load(nextCursor)}>Load more analyses</button>}
        </section>
        <section ref={detailScroller} aria-label="Selected analysis" className={`min-w-0 lg:min-h-0 lg:overflow-auto lg:pr-1 ${!detailOpen || creating ? 'hidden lg:block' : ''}`}>
          {!selected ? <div className="px-2 py-9 text-sm text-textMuted"><FileText size={25} className="mb-4" /><p>Select an analysis to open its question and linked material.</p></div> : <div className="space-y-5">
            <button ref={detailBack} type="button" className="inline-flex items-center gap-2 rounded text-sm text-textMuted underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary lg:hidden" onClick={() => setDetailOpen(false)}><ArrowLeft size={15} />All analyses</button>
            <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-xs text-textMuted">Version {selected.version} · {selected.status === 'archived' ? 'Archived' : 'Project analysis'}</span>
              {!canWrite && <span className="text-xs text-textMuted">View access</span>}{dirty && <span role="status" className="text-xs text-primary">Draft edited</span>}</div>
            <button type="button" className="btn btn-secondary inline-flex items-center gap-2 text-sm" onClick={() => { setNotebookVisited(true); setNotebookOpen(true); }}><FileText size={15} />Open documents</button>
            <button ref={attachmentsButton} type="button" className="btn btn-secondary ml-2 inline-flex items-center gap-2 text-sm" onClick={() => { setAttachmentsVisited(true); setAttachmentsOpen(true); }}><Link2 size={15} />Outside results</button>
            {conflict && <section aria-label="Newer saved version" className="space-y-3 rounded border border-border bg-surface p-4">
              <h3 className="text-sm font-semibold">Latest saved version {conflict.version}</h3><p className="break-words text-sm">{conflict.name}</p><p className="whitespace-pre-wrap break-words text-sm text-textMuted">{conflict.description}</p>
              <p className="text-xs text-textMuted">Linked material in this version: {conflict.references.length}</p>
              <ul className="space-y-1 text-xs text-textMuted">{conflict.references.map(item => <li key={referenceKey(item.reference)}>{labelForReference(item.reference, item.access)}</li>)}</ul>
              <button type="button" className="btn btn-secondary text-xs" onClick={() => {
                const merged = rebaseDraft(draft, conflict);
                setDrafts(previous => ({ ...previous, [selected.id]: merged }));
                setSelected(conflict); setConflict(null); setError('');
              }}>Keep my edits with latest saved work</button>
              <p className="text-xs text-textMuted">Your edits are kept. Untouched text and links use the latest saved version; your added or removed links are applied to it. Review the merged material before saving.</p>
            </section>}
            <label className="block text-sm font-medium">Analysis name<input aria-label="Analysis name" value={draft.name} maxLength={160} readOnly={!canWrite || selected.status === 'archived'} disabled={!!mutation} onChange={event => edit({ name: event.target.value })} className="mt-2 w-full rounded border border-border bg-surface px-3 py-2.5 text-base font-semibold" /></label>
            <label className="block text-sm font-medium">Research question or notes<textarea aria-label="Research question or notes" value={draft.description} maxLength={8000} readOnly={!canWrite || selected.status === 'archived'} disabled={!!mutation} onChange={event => edit({ description: event.target.value })} rows={5} className="mt-2 w-full rounded border border-border bg-surface px-3 py-2.5 text-sm leading-relaxed" /></label>
            <section aria-label="Linked material" className="border-t border-border pt-5">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-semibold">Linked material</h3>{canWrite && selected.status !== 'archived' && <button type="button" className="btn btn-secondary inline-flex items-center gap-2 text-xs" disabled={!!mutation || optionsLoading || connection.blocked} onClick={() => options === null ? void showOptions() : setOptions(null)}><Link2 size={14} />{options === null ? 'Link saved material' : 'Close picker'}</button>}</div>
              <p className="mb-3 text-xs text-textMuted">{draft.references.length} of {RESEARCH_ANALYSIS_LIMITS.references} saved links</p>
              {overReferenceLimit && <p role="alert" className="mb-3 text-sm text-danger">This merged draft has more than {RESEARCH_ANALYSIS_LIMITS.references} links. Unlink material until it is within the limit before saving.</p>}
              {!draft.references.length && <p className="text-sm text-textMuted">No linked material yet. Large data stays in its existing storage.</p>}
              <ul className="space-y-2">{draft.references.map(reference => {
                const saved = selected.references.find(item => referenceKey(item.reference) === referenceKey(reference));
                const label = labelForReference(reference, saved?.access);
                return <li key={referenceKey(reference)} className="flex items-start justify-between gap-3 rounded border border-border px-3 py-2 text-sm"><div className="min-w-0"><span className="break-words">{label}</span><span className="mt-1 block text-xs text-textMuted">{saved?.access === 'restricted' ? 'Source access is restricted' : 'Exact version linked'}</span>
                  <details className="mt-2 text-xs text-textMuted"><summary className="cursor-pointer">Version details</summary><dl className="mt-2 space-y-1 break-all"><dt>Version</dt><dd className="font-mono">{versionId(reference)}</dd><dt>SHA-256</dt><dd className="font-mono">{reference.sha256}</dd></dl></details></div>
                  {canWrite && selected.status !== 'archived' && <button type="button" aria-label={`Unlink ${label}`} className="shrink-0 text-xs text-textMuted underline" disabled={!!mutation} onClick={() => edit({ references: draft.references.filter(item => referenceKey(item) !== referenceKey(reference)) })}>Unlink</button>}</li>;
              })}</ul>
              {optionsLoading && <p role="status" className="mt-3 text-sm text-textMuted">Finding saved material…</p>}
              {options !== null && <div className="mt-4 rounded border border-border bg-surface p-3"><h4 className="mb-2 text-sm font-medium">Saved material you can access</h4>{!options.length && <p className="text-sm text-textMuted">No compatible saved versions are available to your account yet.</p>}
                <ul className="max-h-72 overflow-auto rounded focus-visible:ring-2 focus-visible:ring-primary" tabIndex={0} aria-label="Available saved material">{options.map(option => {
                  const linked = draft.references.some(reference => referenceKey(reference) === referenceKey(option.reference));
                  return <li key={referenceKey(option.reference)} className="border-b border-border last:border-0"><label className="flex cursor-pointer items-start gap-3 py-3 text-sm"><input type="checkbox" className="mt-1" checked={linked} disabled={!!mutation || !linked && draft.references.length >= RESEARCH_ANALYSIS_LIMITS.references} onChange={event => edit({ references: event.target.checked ? [...draft.references, option.reference] : draft.references.filter(item => referenceKey(item) !== referenceKey(option.reference)) })} /><span className="min-w-0 break-words">{option.label}<span className="mt-1 block text-xs text-textMuted">{option.type} · exact saved version</span></span></label></li>;
                })}</ul>{optionCursor && <button type="button" className="btn btn-secondary mt-2 text-xs" disabled={optionsLoading} onClick={() => void showOptions(optionCursor)}>Load more saved material</button>}
                <p className="mt-3 text-xs text-textMuted">Links are saved with your changes below. Linking does not copy data or grant source access to colleagues.</p>
              </div>}
            </section>
            {canWrite && <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
              {selected.status === 'active' && <button type="button" className="btn btn-primary inline-flex items-center gap-2" disabled={!!mutation || !dirty || !draft.name.trim() || !!conflict || overReferenceLimit || connection.blocked} onClick={() => void save()}>{mutation === 'save' && <Loader2 size={15} className="animate-spin" />}{mutation === 'save' ? 'Saving…' : 'Save changes'}</button>}
              <button type="button" className="btn btn-secondary inline-flex items-center gap-2 text-sm" disabled={!!mutation || !!conflict || overReferenceLimit || connection.blocked || !draft.name.trim()} onClick={() => void save(selected.status === 'archived' ? 'active' : 'archived')}><Archive size={14} />{selected.status === 'archived' ? 'Restore analysis' : dirty ? 'Save and archive' : 'Archive'}</button>
            </div>}
            <p className="text-xs leading-relaxed text-textMuted">The analysis has its own identity. Linked objects and results keep their original versions and access rules.</p>
          </div>}
        </section>
      </div>
      {onOpenWorkspace && <button type="button" className="mt-8 inline-flex items-center gap-2 self-start text-xs text-textMuted underline lg:mt-4 lg:shrink-0" onClick={onOpenWorkspace}><ArrowLeft size={13} />Return to data workspace</button>}
    </div>
    </div>
    {notebookVisited && <div hidden={!notebookOpen} className="absolute inset-0">
      <React.Suspense fallback={<p role="status" className="p-8 text-sm text-textMuted">Opening notebooks…</p>}>
        <NotebookWorkspace projectId={projectId} projectName={projectName} analysis={selected} role={role} userId={userId} theme={theme}
          connection={connection} isActive={isActive && notebookOpen} onOpenOverview={() => setNotebookOpen(false)}
          onOpenAdvanced={onOpenAdvanced} onOpenWorkflow={onOpenWorkflow} referenceLabel={labelForReference} />
      </React.Suspense>
    </div>}
    {attachmentsVisited && selected && <div hidden={!attachmentsOpen} className="absolute inset-0">
      <React.Suspense fallback={<p role="status" className="p-8 text-sm text-textMuted">Opening outside results…</p>}>
        <AnalysisAttachments projectId={projectId} projectName={projectName} analysis={selected} role={role} userId={userId}
          connection={connection} isActive={isActive && attachmentsOpen} onClose={() => { setAttachmentsOpen(false); requestAnimationFrame(() => attachmentsButton.current?.focus({ preventScroll: true })); }} />
      </React.Suspense>
    </div>}
    {adoptionVisited && <div hidden={!adoptionOpen} className="absolute inset-0">
      <React.Suspense fallback={<p role="status" className="p-8 text-sm text-textMuted">Finding saved work…</p>}>
        <ExistingWorkBrowser projectId={projectId} projectName={projectName} userId={userId} canWrite={canWrite}
          blocked={connection.blocked} isActive={isActive && adoptionOpen} onClose={closeAdoption} onAdopt={adopt}
          onOpenWorkflow={onOpenWorkflow}
          onOpenOriginal={onOpenOriginal ? async id => { await onOpenOriginal(id); setAdoptionOpen(false); } : undefined} />
      </React.Suspense>
    </div>}
  </div>;
}

export default function ResearchAnalyses({ userId, projectId, ...props }) {
  const connection = useExecutionTarget();
  return <ProjectAnalyses key={`${userId || 'none'}:${connection.identity}:${projectId || 'none'}`} userId={userId} projectId={projectId} {...props} connection={connection} />;
}
