import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Copy, FileText, Plus, Trash2, Upload } from 'lucide-react';
import AnalysisShell from '../components/AnalysisShell';
import CodeEditor from './CodeEditor';
import ScriptEditor from './ScriptEditor';
import ScriptImport from './ScriptImport';
import NotebookImport from './NotebookImport';
import ImportedNotebookOutputs from './ImportedNotebookOutputs';
import { notebookMarkdownComponents, notebookMarkdownUrlTransform } from './NotebookAttachment';
import useNotebookDocuments from './useNotebookDocuments';
import { getNotebookVersion } from './notebookApi';
import { publicErrorMessage } from '../publicError';
import { copyScriptToNotebook, exportScriptDocument, scriptDocumentInfo } from '../../shared/scriptDocument.mjs';
import { exportNotebookFile, NOTEBOOK_INTERCHANGE_SCHEMA } from '../../shared/notebookInterchange.mjs';

const RetainedWorkView = React.lazy(() => import('../analyses/RetainedWorkView'));
const cellLabel = cell => cell.type === 'markdown' ? 'Markdown' : cell.type === 'raw' ? 'Raw text' : cell.language === 'python' ? 'Python' : 'R';
const WRITE_ROLES = new Set(['owner', 'admin', 'analyst']);
const newCell = (type, language) => ({ id: crypto.randomUUID(), type, source: '', metadata: {}, collapsed: false,
  ...(type === 'code' ? { language } : {}) });
const scriptInfo = content => { if (content?.schema === NOTEBOOK_INTERCHANGE_SCHEMA) return null; try { return scriptDocumentInfo(content); } catch { return null; } };

function NotebookExportFeedback({ feedback }) {
  if (!feedback) return null;
  return <section aria-label="Notebook export notes" role={feedback.error ? 'alert' : 'status'} className={`space-y-2 rounded border border-border p-3 text-xs ${feedback.error ? 'text-danger' : 'text-textMuted'}`}>
    <p>{feedback.error || `${feedback.source} · ${feedback.filename} prepared for download.`}</p>
    {feedback.warnings?.length > 0 && <ul className="space-y-1">{feedback.warnings.map(item => <li key={item.code}>{item.message}</li>)}</ul>}
  </section>;
}

function SharedSourceRecovery({ record, payload, busy, blocked, onCheck, onRetry, onReviewSaved, onReviewSource, onCopy, onReviewUnsubmitted, onCopyUnsubmitted, pending }) {
  if (!record || record.phase === 'resolved' && !record.unsubmittedPayload) return null;
  const saved = record.journal?.state === 'succeeded' && !payload;
  const rejected = record.journal?.state === 'rejected';
  if (!record.journal && !record.error && !record.phase) return record.checking
    ? <p role="status" className="text-xs text-textMuted">Checking previous shared submissions…</p> : null;
  return <section aria-label="Shared source recovery" className="space-y-2 rounded border border-border bg-surface p-3 text-sm">
    <p className="font-medium">{saved ? `Your last submission was saved as version ${record.journal.outcome?.version || 'available'}.`
      : rejected ? 'Your submitted source is available privately.' : 'A shared submission needs confirmation.'}</p>
    <p className="text-xs leading-relaxed text-textMuted">{saved ? 'Open the saved version to review it. Your later private edits are kept separately.'
      : rejected ? 'A newer shared version prevented this save. Review the submitted source or keep it as a separate document.'
        : record.phase === 'unconfirmed' ? 'Recovery storage has not been confirmed. Keep this window open and retry the original request.'
          : record.loaded ? 'The original request is kept privately. Retry checks that submission; it does not create a replacement.'
            : 'Previous submission checks are unavailable. Reconnect and check before sharing more source.'}</p>
    <div className="flex flex-wrap gap-3 text-xs">
      {payload && <button type="button" className="text-primary underline" onClick={onReviewSource}>Review submitted source</button>}
      {!saved && !rejected && payload && <button type="button" className="text-primary underline" disabled={busy || blocked || record.checking} onClick={onRetry}>Check original submission</button>}
      {saved && <button type="button" className="text-primary underline" disabled={busy || blocked} onClick={onReviewSaved}>Review saved result</button>}
      {!record.loaded && <button type="button" className="text-primary underline" disabled={busy || blocked || record.checking} onClick={onCheck}>Check shared submission</button>}
      {rejected && payload && onCopy && <button type="button" className="text-primary underline" disabled={busy || blocked} onClick={onCopy}>Copy submitted source as a new document</button>}
    </div>
    {record.unsubmittedPayload && <div className="space-y-2 border-t border-border pt-2 text-xs">
      <p className="text-textMuted">Another window submitted first. Your unsubmitted source is kept in this window; save it before closing.</p>
      <div className="flex flex-wrap gap-3"><button type="button" className="text-primary underline" onClick={onReviewUnsubmitted}>Review unsubmitted source</button>
        {onCopyUnsubmitted && <button type="button" className="text-primary underline" disabled={busy || blocked || pending} onClick={onCopyUnsubmitted}>Save unsubmitted source as a new document</button>}</div>
    </div>}
  </section>;
}

const NotebookCell = memo(function NotebookCell({
  cell, index, count, documentId, active, canEdit, theme, editorStates, onEdit, onActivate, onMove, onDuplicate, onRemove,
}) {
  const section = useRef(null);
  const editButton = useRef(null);
  const [viewCollapsed, setViewCollapsed] = useState(null);
  const collapsed = canEdit ? cell.collapsed : viewCollapsed ?? cell.collapsed;
  const label = `${cellLabel(cell)} cell ${index + 1}`;
  const stateKey = `${documentId}:${cell.id}`;
  const markdownComponents = useMemo(() => ({
    a: ({ children, href, title }) => <a href={href} title={title} target="_blank" rel="noreferrer" className="text-primary underline">{children}</a>,
    ...notebookMarkdownComponents(cell.imported?.attachments),
  }), [cell.imported?.attachments]);
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
        {!active && <div className="notebook-narrative text-sm leading-relaxed">{cell.source ? <ReactMarkdown skipHtml urlTransform={notebookMarkdownUrlTransform} components={markdownComponents}>{cell.source}</ReactMarkdown> : <p className="text-textMuted">Add a note, explanation, or scientific question.</p>}</div>}
      </>
      : cell.type === 'raw' ? active
        ? <textarea aria-label={`${label} source`} readOnly={!canEdit} className="min-h-36 w-full rounded border border-border bg-background p-3 font-mono text-sm leading-relaxed text-text" value={cell.source}
          onChange={event => onEdit(cell.id, { source: event.target.value })} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); editButton.current?.focus(); } }} />
        : <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-background p-3 font-mono text-[13px] leading-relaxed">{cell.source || '(empty raw text)'}</pre>
      : active ? <CodeEditor key={stateKey} value={cell.source} language={cell.language} theme={theme} label={`${label} source`} readOnly={!canEdit}
        initialState={editorStates.current.get(stateKey)} onStateChange={state => editorStates.current.set(stateKey, state)}
        onChange={source => onEdit(cell.id, { source })} onEscape={() => editButton.current?.focus()} />
        : <pre className="max-h-72 overflow-auto whitespace-pre rounded border border-border bg-background p-3 font-mono text-[13px] leading-relaxed">{cell.source || <span className="text-textMuted">Write {cellLabel(cell)} here.</span>}</pre>}
    <ImportedNotebookOutputs cell={cell} scopeKey={stateKey} />
  </section>;
});

export default function NotebookWorkspace({ projectId, projectName, analysis, role, userId, theme = 'light', isActive, connection,
  onOpenOverview, onOpenAdvanced, onOpenWorkflow, referenceLabel }) {
  const canWrite = WRITE_ROLES.has(role) && analysis?.status === 'active';
  const docs = useNotebookDocuments({ projectId, analysisId: analysis?.id, userId, isActive, blocked: connection.blocked, canWrite });
  const editDocument = docs.edit;
  const editUiState = docs.editUiState;
  const [creations, setCreations] = useState({});
  const setCreation = useCallback(change => setCreations(previous => {
    const id = analysis?.id;
    const value = typeof change === 'function' ? change(previous[id]) : change;
    return { ...previous, [id]: value };
  }), [analysis?.id]);
  const creation = docs.pendingCreateInfo ? { analysisId: analysis?.id, ...docs.pendingCreateInfo } : creations[analysis?.id];
  const [imports, setImports] = useState({});
  const setImportOpen = (scope, value) => setImports(previous => ({ ...previous, [scope]: value }));
  const [activeCells, setActiveCells] = useState({});
  const [removed, setRemoved] = useState({});
  const [inspector, setInspector] = useState(null);
  const [inspectionError, setInspectionError] = useState('');
  const [exportNotice, setExportNotice] = useState(null);
  const editorStates = useRef(new Map());
  const downloads = useRef(new Set());
  const body = useRef(null);
  const inspectRequest = useRef(0);
  const analysisRef = useRef(analysis?.id);
  analysisRef.current = analysis?.id;
  const { selected, selectedId, draft } = docs;
  const selectionRef = useRef(selectedId);
  selectionRef.current = selectedId;
  const script = scriptInfo(draft?.content);
  const pendingScript = scriptInfo(docs.pendingCreateInfo?.content);
  const pendingNotebook = docs.pendingCreateInfo?.content?.schema === NOTEBOOK_INTERCHANGE_SCHEMA;
  const pendingImportKind = pendingNotebook ? 'notebook' : pendingScript ? 'script' : null;
  const importOpen = !!imports[analysis?.id] || !!pendingImportKind;
  const titleLabel = script ? 'Script title' : 'Notebook title';
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const activeId = activeCells[selectedId];
  const sourceFrozen = !canWrite || docs.busy || docs.pendingSave || docs.sharedRecovery?.checking
    || docs.sharedRecovery?.loaded === false || connection.blocked;
  const creatingHere = !importOpen && (creation?.analysisId === analysis?.id || docs.pendingCreate);
  const newerHead = selected && docs.heads[selected.id]?.version > draft.baseVersion;

  useEffect(() => {
    inspectRequest.current += 1;
    setInspector(null); setInspectionError(''); setExportNotice(null);
    return () => { inspectRequest.current += 1; };
  }, [analysis?.id, isActive, selectedId]);
  useEffect(() => {
    inspectRequest.current += 1;
    setInspector(current => current?.kind === 'source' ? null : current);
  }, [activeId]);
  useEffect(() => {
    const urls = downloads.current;
    return () => { for (const url of urls) URL.revokeObjectURL(url); urls.clear(); };
  }, []);
  useEffect(() => {
    const area = body.current?.closest('[aria-label="Document work area"]');
    if (!area || !selectedId || !isActive) return;
    area.scrollTop = draftRef.current?.uiState?.scrollTop || 0;
    let timer;
    const changed = () => {
      clearTimeout(timer);
      timer = setTimeout(() => editUiState?.(selectedId, { scrollTop: Math.min(10000000, Math.max(0, area.scrollTop)) }), 200);
    };
    area.addEventListener('scroll', changed, { passive: true });
    return () => { clearTimeout(timer); area.removeEventListener('scroll', changed); };
  }, [selectedId, analysis?.id, isActive, editUiState]);

  const download = (filename, value, mimeType) => {
    const url = URL.createObjectURL(new Blob([value], { type: mimeType }));
    downloads.current.add(url);
    const release = () => { if (downloads.current.delete(url)) URL.revokeObjectURL(url); };
    const link = document.createElement('a'); link.href = url; link.download = filename;
    try { document.body.appendChild(link); link.click(); }
    catch (failure) { release(); throw failure; }
    finally { link.remove(); }
    setTimeout(release, 1000);
  };
  const exportScript = () => {
    try {
      const { filename, bytes } = exportScriptDocument(draft.content);
      download(filename, bytes, 'text/plain;charset=utf-8');
    } catch { setInspectionError('This script could not be exported. Its current source is still here.'); }
  };
  const exportNotebook = (content, source, versionId = null) => {
    setInspectionError(''); setExportNotice(null);
    try {
      const result = exportNotebookFile(content);
      download(result.filename, result.text, result.mimeType);
      setExportNotice({ filename: result.filename, source, versionId, warnings: result.warnings.filter((item, index, items) => items.findIndex(other => other.code === item.code) === index) });
    } catch (failure) {
      const safe = ['INVALID_NOTEBOOK_INTERCHANGE', 'NOTEBOOK_INTERCHANGE_TOO_LARGE', 'INVALID_NOTEBOOK_DOCUMENT', 'NOTEBOOK_DOCUMENT_TOO_LARGE'].includes(failure.code);
      setExportNotice({ source, versionId, error: safe ? `Notebook export could not be prepared. ${failure.message}` : 'This notebook could not be exported. Its current source is still here.' });
    }
  };

  const editCell = useCallback((id, change) => {
    editDocument(selectedId, current => ({ ...current, content: { ...current.content,
      cells: current.content.cells.map(cell => cell.id === id ? { ...cell, ...change } : cell) } }));
  }, [editDocument, selectedId]);
  const activate = useCallback((index, scroll = false) => {
    if (index === -1 && !scroll) { setActiveCells(previous => ({ ...previous, [selectedId]: null })); editUiState?.(selectedId, { activeCellId: null }); return; }
    const cell = draftRef.current?.content.cells[index];
    if (!cell) return;
    setActiveCells(previous => ({ ...previous, [selectedId]: cell.id }));
    editUiState?.(selectedId, { activeCellId: cell.id });
    if (scroll) requestAnimationFrame(() => document.getElementById(`notebook-cell-${cell.id}`)?.scrollIntoView({ block: 'nearest' }));
  }, [selectedId, editUiState]);
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
  const importPanel = (scope, mode) => {
    const kind = scope === analysis.id && pendingImportKind ? pendingImportKind : mode === 'notebook' ? 'notebook' : 'script';
    const hasPending = scope === analysis.id && pendingImportKind === kind;
    const Panel = kind === 'notebook' ? NotebookImport : ScriptImport;
    const pending = hasPending ? { filename: kind === 'notebook' ? docs.pendingCreateInfo.content.interchange?.filename : pendingScript.filename,
      title: docs.pendingCreateInfo.title, content: docs.pendingCreateInfo.content } : null;
    return <Panel theme={theme} busy={scope === analysis.id && docs.creating}
      disabled={scope !== analysis.id || connection.blocked || !canWrite && !pending || docs.pendingCreate && !pending}
      error={scope === analysis.id ? docs.creationProblem?.message || '' : ''} pending={pending}
      onCancel={() => setImportOpen(scope, false)} onImport={async input => {
        if (scope !== analysis.id) return null;
        const created = await docs.create(input.title, input.content.defaultLanguage, input.content);
        if (created) setImportOpen(scope, false);
        return created;
      }} />;
  };
  const outline = <div className="space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs font-semibold text-textMuted">Documents</p>
      {canWrite && <button type="button" aria-label="New notebook" disabled={docs.creating || docs.pendingCreate} className="rounded p-1 text-primary focus-visible:ring-2 focus-visible:ring-primary" onClick={() => { setImportOpen(analysis.id, false); setCreation({ analysisId: analysis.id, title: '', language: 'R' }); }}><Plus size={16} /></button>}</div>
    {canWrite && <button type="button" className="inline-flex items-center gap-2 text-xs text-primary underline" disabled={docs.creating || docs.pendingCreate || connection.blocked} onClick={() => { setCreation(null); setImportOpen(analysis.id, 'script'); }}><Upload size={13} />Import script</button>}
    {canWrite && <button type="button" className="inline-flex items-center gap-2 text-xs text-primary underline" disabled={docs.creating || docs.pendingCreate || connection.blocked} onClick={() => { setCreation(null); setImportOpen(analysis.id, 'notebook'); }}><Upload size={13} />Import notebook</button>}
    {docs.index.loading && <p role="status" className="text-xs text-textMuted">Loading documents…</p>}
    {docs.index.error && <p role="alert" className="text-xs text-danger">{docs.index.error}</p>}
    <ul className="space-y-1">{docs.index.items.map(item => <li key={item.id}><button type="button" aria-current={selectedId === item.id ? 'page' : undefined}
      className={`w-full break-words rounded p-2 text-left text-sm focus-visible:ring-2 focus-visible:ring-primary ${selectedId === item.id ? 'bg-primary/10 font-semibold text-text' : 'text-textMuted hover:bg-primary/5'}`} onClick={() => void docs.open(item.id)}>
      {item.title}{' '}<span className="mt-1 block text-[11px] font-normal text-textMuted">{item.documentKind === 'script' || scriptInfo(docs.drafts[item.id]?.content || (selectedId === item.id ? draft?.content : null)) ? `${item.defaultLanguage === 'python' ? 'Python' : 'R'} script` : `${item.cellCount} cells`} · {docs.drafts[item.id]?.dirty ? 'Draft edited' : `v${item.version}`}</span>
    </button></li>)}</ul>
    {!docs.index.loading && !docs.index.items.length && <p className="text-xs leading-relaxed text-textMuted">No documents yet.</p>}
    {docs.index.nextCursor && <button type="button" className="text-xs text-primary underline" disabled={docs.index.loading} onClick={() => void docs.loadMore()}>More documents</button>}
    <button type="button" className="text-xs text-textMuted underline" disabled={connection.blocked} onClick={() => void docs.refresh()}>Refresh documents</button>
    <div className="border-t border-border pt-3"><button type="button" className="text-left text-sm text-textMuted hover:text-text" onClick={() => setInspector({ kind: 'links' })}>Linked material ({analysis?.references.length || 0})</button></div>
  </div>;
  const inspectorContent = inspector?.kind === 'submission-source' ? <div className="space-y-4 text-sm">
    <p className="font-semibold">{inspector.payload.title}</p>
    <p className="text-xs leading-relaxed text-textMuted">{inspector.unsubmitted ? 'This source was not admitted. It is kept only in this window until you explicitly save it.' : 'Exact submitted source, visible only to your account until its shared save is confirmed.'} Reviewing it does not change your working copy.</p>
    {inspector.payload.content.cells.map((cell, index) => <div key={cell.id}><p className="mb-2 text-xs font-semibold">Cell {index + 1} · {cellLabel(cell)} source</p><pre className="max-h-80 overflow-auto whitespace-pre rounded border border-border bg-background p-3 font-mono text-xs">{cell.source || '(empty source)'}</pre></div>)}
  </div> : inspector?.kind === 'private-source' ? <div className="space-y-4 text-sm">
    <p className="font-semibold">{inspector.document.title}</p>
    <p className="text-xs text-textMuted">Private working copy {inspector.document.draftVersion}, based on saved source version {inspector.document.baseVersion}. This draft is visible only to your account.</p>
    <dl className="space-y-2 break-all text-xs"><dt className="text-textMuted">Base saved version</dt><dd>{inspector.document.baseVersionId}</dd><dt className="text-textMuted">SHA-256</dt><dd className="font-mono">{inspector.document.sha256}</dd></dl>
    {inspector.document.content.cells.map((cell, index) => <div key={cell.id}><p className="mb-2 text-xs font-semibold">Cell {index + 1} · {cellLabel(cell)} source</p><pre className="max-h-80 overflow-auto whitespace-pre rounded border border-border bg-background p-3 font-mono text-xs">{cell.source || '(empty source)'}</pre></div>)}
  </div> : inspector?.kind === 'source' ? <div className="space-y-4 text-sm">
    <p className="font-semibold">{inspector.document.title}</p><p className="text-xs text-textMuted">Saved source version {inspector.document.version}. This snapshot records saved code, not an execution.</p>
    {!scriptInfo(inspector.document.content) && <button type="button" className="text-xs text-primary underline" onClick={() => exportNotebook(inspector.document.content, `Saved source version ${inspector.document.version}`, inspector.document.versionId)}>Export saved notebook</button>}
    {exportNotice?.versionId === inspector.document.versionId && <NotebookExportFeedback feedback={exportNotice} />}
    {inspector.missingCell && <p className="text-xs text-textMuted">The selected draft cell is absent from this saved version. Showing the saved document.</p>}
    <dl className="space-y-2 break-all text-xs"><dt className="text-textMuted">Version</dt><dd>{inspector.document.versionId}</dd><dt className="text-textMuted">SHA-256</dt><dd className="font-mono">{inspector.document.sha256}</dd></dl>
    {inspector.document.content.cells.filter(cell => !inspector.cellId || cell.id === inspector.cellId).map(cell => <div key={cell.id}><p className="mb-2 text-xs font-semibold">Cell {inspector.document.content.cells.findIndex(item => item.id === cell.id) + 1} · {cellLabel(cell)} source</p><pre className="max-h-80 overflow-auto whitespace-pre rounded border border-border bg-background p-3 font-mono text-xs">{cell.source || '(empty source)'}</pre>
      <ImportedNotebookOutputs cell={cell} scopeKey={`${inspector.document.versionId}:${cell.id}`} /></div>)}
  </div> : inspector?.kind === 'artifact' ? <React.Suspense fallback={<p role="status" className="text-sm text-textMuted">Loading saved material…</p>}>
    <RetainedWorkView projectId={projectId} userId={userId} reference={inspector.reference} compact canWrite={canWrite} onOpenWorkflow={onOpenWorkflow} />
  </React.Suspense> : inspector?.kind === 'links' ? <div className="space-y-3 text-sm">
    <p className="text-xs text-textMuted">These saved versions keep their original access rules. Opening them does not run the analysis.</p>
    {analysis.references.map(item => <div key={JSON.stringify(item.reference)} className="rounded border border-border p-3"><p className="break-words">{referenceLabel?.(item.reference, item.access) || 'Saved material'}</p>
      {item.access === 'restricted' ? <p className="mt-2 text-xs text-textMuted">Source access is restricted.</p> : <button type="button" className="mt-2 text-xs text-primary underline" onClick={() => setInspector({ kind: 'artifact', reference: item.reference })}>Inspect saved version</button>}
    </div>)}{!analysis.references.length && <p>No material is linked yet. Add saved results from the analysis overview.</p>}
  </div> : null;

  if (!analysis) return null;
  return <AnalysisShell projectName={projectName} analysisName={analysis.name} documentTitle={draft?.title || 'Documents'} onOpenOverview={onOpenOverview}
    outline={outline} status={<span className={draft?.dirty ? 'text-primary' : 'text-textMuted'}>{draft?.dirty ? 'Draft edited' : selected ? `Saved version ${selected.version}` : 'Project documents'}</span>}
    inspector={inspectorContent} inspectorTitle={inspector?.kind === 'source' ? 'Saved source' : inspector?.kind === 'submission-source' ? inspector.unsubmitted ? 'Unsubmitted source' : 'Submitted source' : inspector?.kind === 'private-source' ? 'Private draft' : 'Linked material'} onCloseInspector={() => setInspector(null)}
    toolbar={<>{selected && <button type="button" className="btn btn-secondary text-xs" onClick={() => void inspectSaved(selected.versionId)}>Saved source</button>}
      {script && <button type="button" className="btn btn-secondary text-xs" title="Export the current edited script source" onClick={exportScript}>Export script</button>}
      {selected && draft && !script && <button type="button" className="btn btn-secondary text-xs" title="Export the current notebook draft as a conventional .ipynb file" onClick={() => exportNotebook(draft.content, 'Current notebook draft')}>Export notebook</button>}
      {selected && (canWrite || docs.pendingSave) && <button type="button" className="btn btn-primary text-sm" disabled={docs.busy || connection.blocked || !draft?.dirty && !docs.pendingSave || !!docs.problem?.currentHead && !docs.pendingSave} onClick={() => void docs.save()}>{docs.busy ? 'Saving…' : docs.pendingSave ? 'Retry save' : script ? 'Save script' : 'Save notebook'}</button>}</>}>
    <div ref={body} className="mx-auto max-w-4xl space-y-5 px-4 py-6 sm:px-7">
      {connection.blocked && <p role="status" className="rounded border border-border p-3 text-sm text-textMuted">Reconnect to save changes. Your current document draft is kept here.</p>}
      {(!selectedId || docs.creationRecovery?.journal?.state !== 'succeeded' || docs.creationRecovery?.unsubmittedPayload) && <SharedSourceRecovery record={docs.creationRecovery} payload={docs.pendingCreateInfo || docs.creationRecovery?.journal?.payload}
        busy={docs.creating} blocked={connection.blocked} pending={docs.pendingCreate} onCheck={() => void docs.refreshSubmission(null)}
        onRetry={() => void docs.create(docs.pendingCreateInfo?.title, docs.pendingCreateInfo?.language, docs.pendingCreateInfo?.content)}
        onReviewSaved={() => void docs.reviewSubmission(null)}
        onReviewSource={() => setInspector({ kind: 'submission-source', payload: docs.pendingCreateInfo || docs.creationRecovery?.journal?.payload })}
        onReviewUnsubmitted={() => setInspector({ kind: 'submission-source', unsubmitted: true, payload: docs.creationRecovery.unsubmittedPayload })}
        onCopyUnsubmitted={canWrite ? async () => {
          const input = docs.creationRecovery.unsubmittedPayload;
          if (await docs.create(input.title, input.content.defaultLanguage, input.content)) {
            docs.clearUnsubmitted(null, input.requestId); setImportOpen(analysis.id, false); setCreation(null);
          }
        } : undefined} />}
      {Object.entries(imports).filter(([, mode]) => mode).map(([scope, mode]) => <div key={scope} hidden={scope !== analysis.id}>{importPanel(scope, mode)}</div>)}
      {pendingImportKind && !imports[analysis.id] && importPanel(analysis.id, pendingImportKind)}
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
      {docs.problem && (!docs.problem.submissionRejected || draft?.dirty) && <div role="alert" className="space-y-3 rounded border border-danger/30 bg-danger/5 p-4 text-sm"><p>{docs.problem.message}</p>
        {docs.problem.currentHead && <><p className="text-textMuted">Saved when checked: {docs.problem.currentHead.title}, version {docs.problem.currentHead.version}. {draft?.dirty ? 'Your edits remain in this draft.' : 'The submitted source is kept separately below.'}</p>
          <div className="flex flex-wrap gap-3"><button type="button" className="btn btn-secondary text-xs" onClick={() => void inspectSaved(docs.problem.currentHead.versionId, true)}>Review saved version {docs.problem.currentHead.version}</button>
            {canWrite && draft?.dirty && <button type="button" className="btn btn-secondary text-xs" disabled={docs.creating || connection.blocked} onClick={() => void docs.create(`${[...draft.title].slice(0, 150).join('')} (copy)`, draft.content.defaultLanguage, draft.content)}>{script ? 'Save my draft as a new script' : 'Save my draft as a new notebook'}</button>}</div></>}
      </div>}
      {inspectionError && <p role="alert" className="text-sm text-danger">{inspectionError}</p>}
      {!(inspector?.kind === 'source' && exportNotice?.versionId === inspector.document.versionId) && <NotebookExportFeedback feedback={exportNotice} />}
      {docs.notice && <p role="status" className="text-sm text-success">{docs.notice}</p>}
      <SharedSourceRecovery record={docs.sharedRecovery} payload={docs.pendingSaveInfo || docs.sharedRecovery?.journal?.payload}
        busy={docs.busy} blocked={connection.blocked} pending={docs.pendingCreate || docs.pendingSave} onCheck={() => void docs.refreshSubmission(selectedId)}
        onRetry={() => void docs.save()}
        onReviewSaved={() => void docs.reviewSubmission(selectedId)}
        onReviewSource={() => setInspector({ kind: 'submission-source', payload: docs.pendingSaveInfo || docs.sharedRecovery?.journal?.payload })}
        onReviewUnsubmitted={() => setInspector({ kind: 'submission-source', unsubmitted: true, payload: docs.sharedRecovery.unsubmittedPayload })}
        onCopyUnsubmitted={canWrite ? async () => {
          const input = docs.sharedRecovery.unsubmittedPayload;
          if (await docs.create(`${[...input.title].slice(0, 150).join('')} (copy)`, input.content.defaultLanguage, input.content)) docs.clearUnsubmitted(selectedId, input.requestId);
        } : undefined}
        onCopy={canWrite ? () => {
          const submitted = docs.sharedRecovery.journal.payload;
          void docs.create(`${[...submitted.title].slice(0, 150).join('')} (copy)`, submitted.content.defaultLanguage, submitted.content);
        } : undefined} />
      {docs.pendingSave && !docs.busy && <p role="status" className="text-sm text-textMuted">Retry checks the same save request. Editing resumes when its outcome is confirmed.</p>}
      {selected && docs.autosave && !docs.recoverableDraft && docs.autosave.state !== 'idle' && <div className="flex flex-wrap items-center gap-3 text-xs text-textMuted">
        <p role="status">{docs.autosave.message}</p>{['failed', 'offline-unsaved'].includes(docs.autosave.state) && <button type="button" className="text-primary underline" disabled={connection.blocked} onClick={() => void docs.retryAutosave()}>Retry private autosave</button>}
      </div>}
      {docs.recoverableDraft && <section aria-label="Private draft recovery" className="space-y-3 rounded border border-primary/30 bg-primary/5 p-4 text-sm">
        <p className="font-semibold">Your private working copy is available</p>
        <p className="text-xs leading-relaxed text-textMuted">{docs.recoverableDraft.title} · private draft {docs.recoverableDraft.draftVersion}, based on saved source version {docs.recoverableDraft.baseVersion}. Review it before choosing which source to continue.</p>
        <div className="flex flex-wrap gap-3"><button type="button" className="btn btn-secondary text-xs" onClick={() => setInspector({ kind: 'private-source', document: docs.recoverableDraft })}>Review private draft</button>
          <button type="button" className="btn btn-secondary text-xs" disabled={docs.busy || !!docs.pendingSave || docs.autosave?.state === 'saving'} onClick={() => {
            const view = docs.recoverableDraft.uiState;
            const scope = analysis.id, id = selectedId;
            if (!docs.recoverDraft()) return;
            setActiveCells(previous => ({ ...previous, [selectedId]: view?.activeCellId || null })); setInspector(null);
            requestAnimationFrame(() => {
              if (selectionRef.current !== id || analysisRef.current !== scope) return;
              const area = body.current?.closest('[aria-label="Document work area"]');
              if (area) area.scrollTop = view?.scrollTop || 0;
            });
          }}>{draft?.dirty ? 'Replace current edits with private draft' : 'Restore private draft'}</button>
          <button type="button" className="btn btn-secondary text-xs" disabled={!canWrite || connection.blocked || docs.busy || !!docs.pendingSave || docs.autosave?.state === 'saving'} onClick={() => void docs.discardDraft()}>Keep current source</button>
          {draft?.dirty && canWrite && <button type="button" className="btn btn-secondary text-xs" disabled={docs.creating || docs.pendingCreate || connection.blocked} onClick={() => void docs.create(`${[...draft.title].slice(0, 150).join('')} (copy)`, draft.content.defaultLanguage, draft.content)}>Save current edits as a new document</button>}
        </div>
      </section>}
      {selected && draft ? <>
        <div className="space-y-3"><label className="block text-xs font-medium text-textMuted">{titleLabel}<input aria-label={titleLabel} maxLength={160} readOnly={sourceFrozen} className="mt-1 w-full rounded border border-transparent bg-transparent px-0 py-1 text-xl font-semibold text-text focus:border-border focus:bg-surface focus:px-2 focus:outline-none" value={draft.title} onChange={event => docs.edit(selectedId, { title: event.target.value })} /></label>
          <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-textMuted"><p>{draft.dirty ? 'Your private working copy · Shared saved source is unchanged' : 'Shared with this project'} · {canWrite ? 'Editable source' : 'View access'}</p>{!script && <label>New cells use<select aria-label="Notebook default language" disabled={sourceFrozen} className="ml-2 rounded border border-border bg-surface px-2 py-1" value={draft.content.defaultLanguage} onChange={event => docs.edit(selectedId, current => ({ ...current, content: { ...current.content, defaultLanguage: event.target.value } }))}><option value="R">R</option><option value="python">Python</option></select></label>}</div>
          {newerHead && !docs.problem?.currentHead && <p role="status" className="text-xs text-textMuted">A newer saved version exists. Your draft stays separate.</p>}
          <p className="text-xs leading-relaxed text-textMuted">{script ? 'Script editing is source only. ' : 'Notebook cells are source only. '}{onOpenAdvanced && <button type="button" className="text-primary underline" onClick={onOpenAdvanced}>Open Advanced analysis for R</button>}</p>
          {draft.content.interchange && <details className="text-xs text-textMuted"><summary className="cursor-pointer">Imported notebook metadata</summary>
            <p className="my-2">Editing does not run or configure the imported kernel. Original metadata is retained for export; imported outputs remain historical after source edits.</p>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-background p-3">{JSON.stringify(draft.content.interchange.metadata, null, 2)}</pre>
          </details>}
          {!script && draft.content.metadata?.traceomics?.kind === 'script' && <p role="status" className="text-xs text-textMuted">This document has incompatible script metadata. Its source is available in the notebook view.</p>}
        </div>
        {script ? <ScriptEditor documentId={selectedId} content={draft.content} info={script} canEdit={!sourceFrozen} theme={theme} editorStates={editorStates}
          onChange={source => editCell(draft.content.cells[0].id, { source })} /> : <div className="space-y-4">{draft.content.cells.map((cell, index) => <div key={`${selectedId}:${cell.id}`} id={`notebook-cell-${cell.id}`}><NotebookCell cell={cell} index={index} count={draft.content.cells.length} documentId={selectedId}
          active={activeId === cell.id} canEdit={!sourceFrozen} theme={theme} editorStates={editorStates}
          onEdit={editCell} onActivate={activate} onMove={move} onDuplicate={duplicate} onRemove={remove} /></div>)}</div>}
        {removed[selectedId] && <p role="status" className="flex flex-wrap items-center gap-3 text-xs text-textMuted">Cell removed.
          <button type="button" className="text-primary underline" disabled={sourceFrozen} onClick={() => {
            const item = removed[selectedId];
            docs.edit(selectedId, current => { const cells = [...current.content.cells]; if (!cells.some(cell => cell.id === item.cell.id)) cells.splice(Math.min(item.index, cells.length), 0, item.cell); return { ...current, content: { ...current.content, cells } }; });
            setRemoved(previous => ({ ...previous, [selectedId]: null }));
          }}>Undo removal</button></p>}
        {canWrite && <div className="flex flex-wrap gap-3 border-t border-border pt-4">{script ? <button type="button" className="btn btn-secondary text-sm" disabled={sourceFrozen || docs.creating || docs.pendingCreate} onClick={() => void docs.create(`${[...draft.title].slice(0, 149).join('')} (notebook)`, script.language, copyScriptToNotebook(draft.content))}>Copy to a notebook</button> : <><button type="button" className="btn btn-secondary inline-flex items-center gap-2 text-sm" disabled={sourceFrozen} onClick={() => add('code')}><Plus size={15} />Add code cell</button><button type="button" className="btn btn-secondary text-sm" disabled={sourceFrozen} onClick={() => add('markdown')}>Add Markdown</button></>}</div>}
      </> : selectedId ? !docs.problem && <p role="status" className="py-10 text-sm text-textMuted">Loading document…</p> : !creatingHere && <div className="py-12 text-center"><FileText size={30} className="mx-auto mb-4 text-textMuted" /><h3 className="text-xl font-semibold">Write alongside your research question</h3><p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-textMuted">Import a Jupyter notebook or ordinary R or Python script, or keep code and Markdown in a notebook. Saved versions remain part of this analysis.</p>
        {canWrite && <button type="button" className="btn btn-primary mt-6" onClick={() => setCreation({ analysisId: analysis.id, title: '', language: 'R' })}>Create a notebook</button>}</div>}
    </div>
  </AnalysisShell>;
}
