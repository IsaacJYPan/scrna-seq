import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Copy, FileText, Plus, Trash2 } from 'lucide-react';
import AnalysisShell from '../components/AnalysisShell';
import CodeEditor from './CodeEditor';
import useNotebookDocuments from './useNotebookDocuments';
import { getNotebookVersion } from './notebookApi';
import { publicErrorMessage } from '../publicError';

const RetainedArtifactView = React.lazy(() => import('../components/RetainedArtifactView'));
const cellLabel = cell => cell.type === 'markdown' ? 'Markdown' : cell.language === 'python' ? 'Python' : 'R';
const WRITE_ROLES = new Set(['owner', 'admin', 'analyst']);
const newCell = (type, language) => ({ id: crypto.randomUUID(), type, source: '', metadata: {}, collapsed: false,
  ...(type === 'code' ? { language } : {}) });

const NotebookCell = memo(function NotebookCell({
  cell, index, count, documentId, active, canEdit, theme, editorStates, onEdit, onActivate, onMove, onDuplicate, onRemove,
}) {
  const section = useRef(null);
  const editButton = useRef(null);
  const [viewCollapsed, setViewCollapsed] = useState(null);
  const collapsed = canEdit ? cell.collapsed : viewCollapsed ?? cell.collapsed;
  const label = `${cellLabel(cell)} cell ${index + 1}`;
  const stateKey = `${documentId}:${cell.id}`;
  useEffect(() => {
    if (!active || collapsed) return;
    section.current?.querySelector('.cm-content, textarea')?.focus({ preventScroll: true });
  }, [active, collapsed]);
  const toggle = () => canEdit ? onEdit(cell.id, { collapsed: !collapsed }) : setViewCollapsed(!collapsed);
  return <section ref={section} tabIndex={-1} aria-label={label} className={`min-w-0 rounded-lg border p-4 ${active ? 'border-primary/40 bg-surface' : 'border-border bg-surface/50'}`}
    onKeyDown={event => {
      if (!event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault(); onActivate(index + (event.key === 'ArrowUp' ? -1 : 1), true);
    }}>
    <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
      <button type="button" onClick={toggle} aria-expanded={!collapsed} aria-label={`${collapsed ? 'Show' : 'Hide'} ${label} source`} className="rounded p-1 text-textMuted focus-visible:ring-2 focus-visible:ring-primary">
        {collapsed ? <ChevronRight size={15} /> : <ChevronDown size={15} />}
      </button>
      <span className="font-semibold">{index + 1}. {cellLabel(cell)}</span>
      <button ref={editButton} type="button" className="rounded px-2 py-1 text-primary underline focus-visible:ring-2 focus-visible:ring-primary" onClick={() => {
        if (cell.type === 'markdown' && active && !collapsed) { onActivate(-1); return; }
        if (collapsed) toggle(); onActivate(index);
        if (active && !collapsed) section.current?.querySelector('.cm-content, textarea')?.focus({ preventScroll: true });
      }}>{cell.type === 'markdown' && active && !collapsed ? 'Preview text' : canEdit ? cell.type === 'markdown' ? 'Edit text' : 'Edit source' : 'View source'}</button>
      {canEdit && <>
        {cell.type === 'code' && <label className="ml-auto text-textMuted">Language<select aria-label={`${label} language`} value={cell.language} className="ml-2 rounded border border-border bg-background px-2 py-1" onChange={event => onEdit(cell.id, { language: event.target.value })}><option value="R">R</option><option value="python">Python</option></select></label>}
        <div className={`${cell.type === 'markdown' ? 'ml-auto' : ''} flex items-center gap-1`}>
          <button type="button" className="rounded p-1.5 text-textMuted hover:bg-primary/5" aria-label={`Move cell ${index + 1} up`} disabled={index === 0} onClick={() => onMove(index, -1)}><ArrowUp size={14} /></button>
          <button type="button" className="rounded p-1.5 text-textMuted hover:bg-primary/5" aria-label={`Move cell ${index + 1} down`} disabled={index === count - 1} onClick={() => onMove(index, 1)}><ArrowDown size={14} /></button>
          <button type="button" className="rounded p-1.5 text-textMuted hover:bg-primary/5" aria-label={`Duplicate cell ${index + 1}`} onClick={() => onDuplicate(index)}><Copy size={14} /></button>
          <button type="button" className="rounded p-1.5 text-textMuted hover:bg-danger/5" aria-label={`Remove cell ${index + 1}`} onClick={() => onRemove(index)}><Trash2 size={14} /></button>
        </div>
      </>}
    </div>
    {collapsed ? <p className="text-xs text-textMuted">Source hidden · {cell.source.split('\n').length} lines</p>
      : cell.type === 'markdown' ? <>
        <textarea hidden={!active} aria-label={`${label} source`} readOnly={!canEdit} className="min-h-36 w-full rounded border border-border bg-background p-3 font-mono text-sm leading-relaxed" value={cell.source} onChange={event => onEdit(cell.id, { source: event.target.value })} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); onActivate(-1); editButton.current?.focus(); } }} />
        {!active && <div className="notebook-narrative text-sm leading-relaxed">{cell.source ? <ReactMarkdown skipHtml components={{
          a: ({ children, href, title }) => <a href={href} title={title} target="_blank" rel="noreferrer" className="text-primary underline">{children}</a>,
          img: ({ alt }) => <span className="text-xs text-textMuted">Image reference: {alt || 'image'} (images are not loaded automatically)</span>,
        }}>{cell.source}</ReactMarkdown> : <p className="text-textMuted">Add a note, explanation, or scientific question.</p>}</div>}
      </>
      : active ? <CodeEditor key={stateKey} value={cell.source} language={cell.language} theme={theme} label={`${label} source`} readOnly={!canEdit}
        initialState={editorStates.current.get(stateKey)} onStateChange={state => editorStates.current.set(stateKey, state)}
        onChange={source => onEdit(cell.id, { source })} onEscape={() => editButton.current?.focus()} />
        : <pre className="max-h-72 overflow-auto whitespace-pre rounded border border-border bg-background p-3 font-mono text-[13px] leading-relaxed">{cell.source || <span className="text-textMuted">Write {cellLabel(cell)} here.</span>}</pre>}
  </section>;
});

export default function NotebookWorkspace({ projectId, projectName, analysis, role, userId, theme = 'light', isActive, connection,
  onOpenOverview, onOpenAdvanced, referenceLabel }) {
  const canWrite = WRITE_ROLES.has(role) && analysis?.status === 'active';
  const docs = useNotebookDocuments({ projectId, analysisId: analysis?.id, isActive, blocked: connection.blocked, canWrite });
  const editDocument = docs.edit;
  const [creations, setCreations] = useState({});
  const setCreation = useCallback(change => setCreations(previous => {
    const id = analysis?.id;
    const value = typeof change === 'function' ? change(previous[id]) : change;
    return { ...previous, [id]: value };
  }), [analysis?.id]);
  const creation = docs.pendingCreateInfo ? { analysisId: analysis?.id, ...docs.pendingCreateInfo } : creations[analysis?.id];
  const [activeCells, setActiveCells] = useState({});
  const [removed, setRemoved] = useState({});
  const [inspector, setInspector] = useState(null);
  const [inspectionError, setInspectionError] = useState('');
  const editorStates = useRef(new Map());
  const inspectRequest = useRef(0);
  const analysisRef = useRef(analysis?.id);
  analysisRef.current = analysis?.id;
  const { selected, selectedId, draft } = docs;
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const activeId = activeCells[selectedId];
  const sourceFrozen = !canWrite || docs.busy || docs.pendingSave || connection.blocked;
  const creatingHere = creation?.analysisId === analysis?.id || docs.pendingCreate;
  const newerHead = selected && docs.heads[selected.id]?.version > draft.baseVersion;

  useEffect(() => {
    inspectRequest.current += 1;
    setInspector(null); setInspectionError('');
    return () => { inspectRequest.current += 1; };
  }, [analysis?.id, isActive, selectedId]);
  useEffect(() => {
    inspectRequest.current += 1;
    setInspector(current => current?.kind === 'source' ? null : current);
  }, [activeId]);

  const editCell = useCallback((id, change) => {
    editDocument(selectedId, current => ({ ...current, content: { ...current.content,
      cells: current.content.cells.map(cell => cell.id === id ? { ...cell, ...change } : cell) } }));
  }, [editDocument, selectedId]);
  const activate = useCallback((index, scroll = false) => {
    if (index === -1 && !scroll) { setActiveCells(previous => ({ ...previous, [selectedId]: null })); return; }
    const cell = draftRef.current?.content.cells[index];
    if (!cell) return;
    setActiveCells(previous => ({ ...previous, [selectedId]: cell.id }));
    if (scroll) requestAnimationFrame(() => document.getElementById(`notebook-cell-${cell.id}`)?.scrollIntoView({ block: 'nearest' }));
  }, [selectedId]);
  const add = type => {
    const cell = newCell(type, draft.content.defaultLanguage);
    docs.edit(selectedId, current => ({ ...current, content: { ...current.content, cells: [...current.content.cells, cell] } }));
    setActiveCells(previous => ({ ...previous, [selectedId]: cell.id }));
  };
  const move = useCallback((index, direction) => editDocument(selectedId, current => {
    const cells = [...current.content.cells];
    [cells[index], cells[index + direction]] = [cells[index + direction], cells[index]];
    return { ...current, content: { ...current.content, cells } };
  }), [editDocument, selectedId]);
  const duplicate = useCallback(index => editDocument(selectedId, current => {
    const cells = [...current.content.cells], copy = { ...cells[index], id: crypto.randomUUID(), collapsed: false };
    cells.splice(index + 1, 0, copy);
    return { ...current, content: { ...current.content, cells } };
  }), [editDocument, selectedId]);
  const remove = useCallback(index => {
    const cell = draftRef.current?.content.cells[index];
    if (!cell) return;
    setRemoved(previous => ({ ...previous, [selectedId]: { cell, index } }));
    editDocument(selectedId, current => ({ ...current, content: { ...current.content, cells: current.content.cells.filter(item => item.id !== cell.id) } }));
  }, [editDocument, selectedId]);
  const inspectSaved = async (versionId, wholeDocument = false) => {
    const scope = analysis.id, id = selected.id, request = ++inspectRequest.current;
    setInspectionError('');
    try {
      const response = await getNotebookVersion(projectId, scope, id, versionId);
      if (request !== inspectRequest.current || analysisRef.current !== scope) return;
      const cellExists = response.document.content.cells.some(cell => cell.id === activeId);
      setInspector({ kind: 'source', document: response.document, cellId: !wholeDocument && cellExists ? activeId : null,
        missingCell: !wholeDocument && !!activeId && !cellExists });
    } catch (error) { if (request === inspectRequest.current) setInspectionError(publicErrorMessage(error, 'The saved source could not be opened. Your draft is still here.')); }
  };
  const outline = <div className="space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs font-semibold text-textMuted">Notebooks</p>
      {canWrite && <button type="button" aria-label="New notebook" className="rounded p-1 text-primary focus-visible:ring-2 focus-visible:ring-primary" onClick={() => setCreation({ analysisId: analysis.id, title: '', language: 'R' })}><Plus size={16} /></button>}</div>
    {docs.index.loading && <p role="status" className="text-xs text-textMuted">Loading notebooks…</p>}
    {docs.index.error && <p role="alert" className="text-xs text-danger">{docs.index.error}</p>}
    <ul className="space-y-1">{docs.index.items.map(item => <li key={item.id}><button type="button" aria-current={selectedId === item.id ? 'page' : undefined}
      className={`w-full break-words rounded p-2 text-left text-sm focus-visible:ring-2 focus-visible:ring-primary ${selectedId === item.id ? 'bg-primary/10 font-semibold text-text' : 'text-textMuted hover:bg-primary/5'}`} onClick={() => void docs.open(item.id)}>
      {item.title}<span className="mt-1 block text-[11px] font-normal text-textMuted">{item.cellCount} cells · {docs.drafts[item.id]?.dirty ? 'Draft edited' : `v${item.version}`}</span>
    </button></li>)}</ul>
    {!docs.index.loading && !docs.index.items.length && <p className="text-xs leading-relaxed text-textMuted">No notebooks yet.</p>}
    {docs.index.nextCursor && <button type="button" className="text-xs text-primary underline" disabled={docs.index.loading} onClick={() => void docs.loadMore()}>More notebooks</button>}
    <button type="button" className="text-xs text-textMuted underline" disabled={connection.blocked} onClick={() => void docs.refresh()}>Refresh notebooks</button>
    <div className="border-t border-border pt-3"><button type="button" className="text-left text-sm text-textMuted hover:text-text" onClick={() => setInspector({ kind: 'links' })}>Linked material ({analysis?.references.length || 0})</button></div>
  </div>;
  const inspectorContent = inspector?.kind === 'source' ? <div className="space-y-4 text-sm">
    <p className="font-semibold">{inspector.document.title}</p><p className="text-xs text-textMuted">Saved source version {inspector.document.version}. This snapshot records saved code, not an execution.</p>
    {inspector.missingCell && <p className="text-xs text-textMuted">The selected draft cell is absent from this saved version. Showing the saved document.</p>}
    <dl className="space-y-2 break-all text-xs"><dt className="text-textMuted">Version</dt><dd>{inspector.document.versionId}</dd><dt className="text-textMuted">SHA-256</dt><dd className="font-mono">{inspector.document.sha256}</dd></dl>
    {inspector.document.content.cells.filter(cell => !inspector.cellId || cell.id === inspector.cellId).map(cell => <div key={cell.id}><p className="mb-2 text-xs font-semibold">Cell {inspector.document.content.cells.findIndex(item => item.id === cell.id) + 1} · {cellLabel(cell)} source</p><pre className="max-h-80 overflow-auto whitespace-pre rounded border border-border bg-background p-3 font-mono text-xs">{cell.source || '(empty source)'}</pre></div>)}
  </div> : inspector?.kind === 'artifact' ? <React.Suspense fallback={<p role="status" className="text-sm text-textMuted">Loading saved material…</p>}>
    <RetainedArtifactView projectId={projectId} userId={userId} reference={inspector.reference} compact />
  </React.Suspense> : inspector?.kind === 'links' ? <div className="space-y-3 text-sm">
    <p className="text-xs text-textMuted">These exact versions keep their original access rules. Inspection does not change or run them.</p>
    {analysis.references.map(item => <div key={JSON.stringify(item.reference)} className="rounded border border-border p-3"><p className="break-words">{referenceLabel?.(item.reference, item.access) || 'Saved material'}</p>
      {item.access === 'restricted' ? <p className="mt-2 text-xs text-textMuted">Source access is restricted.</p> : <button type="button" className="mt-2 text-xs text-primary underline" onClick={() => setInspector({ kind: 'artifact', reference: item.reference })}>Inspect saved version</button>}
    </div>)}{!analysis.references.length && <p>No material is linked yet. Add saved results from the analysis overview.</p>}
  </div> : null;

  if (!analysis) return null;
  return <AnalysisShell projectName={projectName} analysisName={analysis.name} documentTitle={draft?.title || 'Notebooks'} onOpenOverview={onOpenOverview}
    outline={outline} status={<span className={draft?.dirty ? 'text-primary' : 'text-textMuted'}>{draft?.dirty ? 'Draft edited' : selected ? `Saved version ${selected.version}` : 'Project notebooks'}</span>}
    inspector={inspectorContent} inspectorTitle={inspector?.kind === 'source' ? 'Saved source' : 'Linked material'} onCloseInspector={() => setInspector(null)}
    toolbar={<>{selected && <button type="button" className="btn btn-secondary text-xs" onClick={() => void inspectSaved(selected.versionId)}>Saved source</button>}
      {selected && (canWrite || docs.pendingSave) && <button type="button" className="btn btn-primary text-sm" disabled={docs.busy || connection.blocked || !draft?.dirty && !docs.pendingSave || !!docs.problem?.currentHead && !docs.pendingSave} onClick={() => void docs.save()}>{docs.busy ? 'Saving…' : docs.pendingSave ? 'Retry save' : 'Save notebook'}</button>}</>}>
    <div className="mx-auto max-w-4xl space-y-5 px-4 py-6 sm:px-7">
      {connection.blocked && <p role="status" className="rounded border border-border p-3 text-sm text-textMuted">Reconnect to save changes. Your current notebook draft is kept here.</p>}
      {creatingHere && <form aria-label="New notebook" className="space-y-4 rounded-lg border border-border bg-surface p-5" onSubmit={async event => {
        event.preventDefault();
        const created = await docs.create(creation?.title || '', creation?.language || 'R');
        if (created) setCreation(null);
      }}>
        <h3 className="text-lg font-semibold">New notebook</h3><p className="text-sm text-textMuted">Source in this notebook is shared with project members. Saving does not execute code.</p>
        <label className="block text-sm">Notebook title<input autoFocus aria-label="New notebook title" required maxLength={160} className="input mt-2 w-full" value={creation?.title || ''} disabled={docs.creating || docs.pendingCreate} onChange={event => setCreation(current => ({ ...current, title: event.target.value }))} placeholder="For example, cell composition across donors" /></label>
        <label className="block text-sm">Default language<select aria-label="New notebook language" className="input ml-3" value={creation?.language || 'R'} disabled={docs.creating || docs.pendingCreate} onChange={event => setCreation(current => ({ ...current, language: event.target.value }))}><option value="R">R</option><option value="python">Python</option></select></label>
        {docs.creationProblem && <p role="alert" className="text-sm text-danger">{docs.creationProblem.message}</p>}
        <div className="flex flex-wrap gap-3"><button type="submit" className="btn btn-primary" disabled={docs.creating || connection.blocked}>{docs.creating ? 'Creating…' : docs.pendingCreate ? 'Retry create' : 'Create notebook'}</button>
          <button type="button" className="btn btn-secondary" disabled={docs.creating || docs.pendingCreate} onClick={() => setCreation(null)}>Cancel</button></div>
      </form>}
      {docs.problem && <div role="alert" className="space-y-3 rounded border border-danger/30 bg-danger/5 p-4 text-sm"><p>{docs.problem.message}</p>
        {docs.problem.currentHead && <><p className="text-textMuted">Latest saved: {docs.problem.currentHead.title}, version {docs.problem.currentHead.version}. Your edits remain in this draft.</p>
          <div className="flex flex-wrap gap-3"><button type="button" className="btn btn-secondary text-xs" onClick={() => void inspectSaved(docs.problem.currentHead.versionId, true)}>Review latest saved source</button>
            {canWrite && <button type="button" className="btn btn-secondary text-xs" disabled={docs.creating || connection.blocked} onClick={() => void docs.create(`${draft.title.slice(0, 150)} (copy)`, draft.content.defaultLanguage, draft.content)}>Save my draft as a new notebook</button>}</div></>}
      </div>}
      {inspectionError && <p role="alert" className="text-sm text-danger">{inspectionError}</p>}
      {docs.notice && <p role="status" className="text-sm text-success">{docs.notice}</p>}
      {docs.pendingSave && !docs.busy && <p role="status" className="text-sm text-textMuted">Retry checks the same save request. Editing resumes when its outcome is confirmed.</p>}
      {selected && draft ? <>
        <div className="space-y-3"><label className="block text-xs font-medium text-textMuted">Notebook title<input aria-label="Notebook title" maxLength={160} readOnly={sourceFrozen} className="mt-1 w-full rounded border border-transparent bg-transparent px-0 py-1 text-xl font-semibold text-text focus:border-border focus:bg-surface focus:px-2 focus:outline-none" value={draft.title} onChange={event => docs.edit(selectedId, { title: event.target.value })} /></label>
          <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-textMuted"><p>Shared with this project · {canWrite ? 'Editable source' : 'View access'}</p><label>New cells use<select aria-label="Notebook default language" disabled={sourceFrozen} className="ml-2 rounded border border-border bg-surface px-2 py-1" value={draft.content.defaultLanguage} onChange={event => docs.edit(selectedId, current => ({ ...current, content: { ...current.content, defaultLanguage: event.target.value } }))}><option value="R">R</option><option value="python">Python</option></select></label></div>
          {newerHead && !docs.problem?.currentHead && <p role="status" className="text-xs text-textMuted">A newer saved version exists. Your draft stays separate.</p>}
          <p className="text-xs leading-relaxed text-textMuted">Notebook cells are source only. {onOpenAdvanced && <button type="button" className="text-primary underline" onClick={onOpenAdvanced}>Open Advanced analysis for R</button>}</p>
        </div>
        <div className="space-y-4">{draft.content.cells.map((cell, index) => <div key={cell.id} id={`notebook-cell-${cell.id}`}><NotebookCell cell={cell} index={index} count={draft.content.cells.length} documentId={selectedId}
          active={activeId === cell.id} canEdit={!sourceFrozen} theme={theme} editorStates={editorStates}
          onEdit={editCell} onActivate={activate} onMove={move} onDuplicate={duplicate} onRemove={remove} /></div>)}</div>
        {removed[selectedId] && <p role="status" className="flex flex-wrap items-center gap-3 text-xs text-textMuted">Cell removed.
          <button type="button" className="text-primary underline" disabled={sourceFrozen} onClick={() => {
            const item = removed[selectedId];
            docs.edit(selectedId, current => { const cells = [...current.content.cells]; if (!cells.some(cell => cell.id === item.cell.id)) cells.splice(Math.min(item.index, cells.length), 0, item.cell); return { ...current, content: { ...current.content, cells } }; });
            setRemoved(previous => ({ ...previous, [selectedId]: null }));
          }}>Undo removal</button></p>}
        {canWrite && <div className="flex flex-wrap gap-3 border-t border-border pt-4"><button type="button" className="btn btn-secondary inline-flex items-center gap-2 text-sm" disabled={sourceFrozen} onClick={() => add('code')}><Plus size={15} />Add code cell</button><button type="button" className="btn btn-secondary text-sm" disabled={sourceFrozen} onClick={() => add('markdown')}>Add Markdown</button></div>}
      </> : selectedId ? !docs.problem && <p role="status" className="py-10 text-sm text-textMuted">Loading notebook…</p> : !creatingHere && <div className="py-12 text-center"><FileText size={30} className="mx-auto mb-4 text-textMuted" /><h3 className="text-xl font-semibold">Write alongside your research question</h3><p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-textMuted">Keep ordinary R or Python source and Markdown in a notebook. Saved versions remain part of this analysis.</p>
        {canWrite && <button type="button" className="btn btn-primary mt-6" onClick={() => setCreation({ analysisId: analysis.id, title: '', language: 'R' })}>Create a notebook</button>}</div>}
    </div>
  </AnalysisShell>;
}
