import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { exportNotebookFile, importNotebookFile, normalizeInterchangeNotebookContent, NOTEBOOK_INTERCHANGE_LIMITS } from '../../shared/notebookInterchange.mjs';
import { notebookInterchangeFilename } from '../../shared/notebookInterchangeFields.mjs';
import { publicErrorMessage } from '../publicError';
import CodeEditor from './CodeEditor';

const fileBytes = file => typeof file.arrayBuffer === 'function' ? file.arrayBuffer() : new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(new Error('The selected notebook could not be read. Choose it again.'));
  reader.onabort = () => reject(new Error('Notebook reading was canceled. Choose the file again.'));
  reader.readAsArrayBuffer(file);
});
const inputError = failure => ['INVALID_NOTEBOOK_INTERCHANGE', 'NOTEBOOK_INTERCHANGE_TOO_LARGE', 'NOTEBOOK_LANGUAGE_REQUIRED', 'INVALID_NOTEBOOK_DOCUMENT', 'NOTEBOOK_DOCUMENT_TOO_LARGE'].includes(failure?.code)
  ? failure.message : 'The selected notebook could not be read. Choose the file again.';
const languageLabel = language => language === 'python' ? 'Python' : 'R';

function pendingPreview(payload) {
  const normalized = normalizeInterchangeNotebookContent(payload.content);
  const filename = payload.filename ?? normalized.interchange.filename;
  if (filename !== normalized.interchange.filename) throw new Error('The pending filename is inconsistent.');
  const exported = exportNotebookFile(normalized);
  const preview = importNotebookFile({ filename, source: exported.text, language: normalized.defaultLanguage });
  // Derived preview data must never replace the exact admitted content.
  return { ...preview, filename, title: payload.title, content: payload.content };
}

/** Prepare locally; only an explicit onImport callback may admit shared source. */
export default function NotebookImport({ onImport, onCancel, busy = false, pending = null, disabled = false, error = '', theme = 'light' }) {
  const headingId = useId();
  const [selection, setSelection] = useState(null), [title, setTitle] = useState('');
  const [readable, setReadable] = useState(null), [language, setLanguage] = useState('');
  const [reading, setReading] = useState(false), [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState('');
  const generation = useRef(0), mounted = useRef(false), inFlight = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (pending) { generation.current++; setReading(false); setLocalError(''); } }, [pending]);
  const frozen = useMemo(() => {
    if (!pending) return null;
    try { return pendingPreview(pending); } catch { return { unavailable: true }; }
  }, [pending]);
  const preview = frozen || selection, working = busy || submitting;
  const locked = working || !!pending || disabled;
  const currentTitle = pending ? String(pending.title ?? '') : title;
  const validTitle = !!currentTitle.trim() && [...currentTitle].length <= 160;
  const problem = localError || error || (frozen?.unavailable ? 'The pending notebook preview is unavailable. Return to document recovery before retrying.' : '');
  const accept = (prepared, input) => { setSelection(prepared); setTitle(prepared.title); setReadable(input); };
  const parse = (input, selectedLanguage) => importNotebookFile({ filename: input.filename, source: input.source, ...(selectedLanguage ? { language: selectedLanguage } : {}) });
  const choose = async event => {
    if (locked) return;
    const file = event.target.files?.[0], request = ++generation.current;
    setSelection(null); setReadable(null); setLanguage(''); setTitle(''); setLocalError('');
    if (!file) { setReading(false); return; }
    setReading(true);
    try {
      notebookInterchangeFilename(file.name);
      if (file.size > NOTEBOOK_INTERCHANGE_LIMITS.fileBytes) throw Object.assign(new Error('Notebook files must contain at most 2 MiB of UTF-8 JSON.'), { code: 'NOTEBOOK_INTERCHANGE_TOO_LARGE' });
      const bytes = new Uint8Array(await fileBytes(file));
      if (bytes.byteLength > NOTEBOOK_INTERCHANGE_LIMITS.fileBytes) throw Object.assign(new Error('Notebook files must contain at most 2 MiB of UTF-8 JSON.'), { code: 'NOTEBOOK_INTERCHANGE_TOO_LARGE' });
      let source;
      try { source = new globalThis.TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
      catch { throw Object.assign(new Error('This notebook is not valid UTF-8. Save a UTF-8 copy in its original tool and try again.'), { code: 'INVALID_NOTEBOOK_INTERCHANGE' }); }
      const input = { filename: file.name, source, size: bytes.byteLength };
      if (!mounted.current || generation.current !== request) return;
      try { accept(parse(input), input); }
      catch (failure) {
        if (failure.code === 'NOTEBOOK_LANGUAGE_REQUIRED') { setReadable(input); setLocalError(failure.message); }
        else throw failure;
      }
    } catch (failure) {
      if (mounted.current && generation.current === request) setLocalError(inputError(failure));
    } finally { if (mounted.current && generation.current === request) setReading(false); }
  };
  const selectLanguage = event => {
    if (locked || !readable) return;
    const value = event.target.value; setLanguage(value); setSelection(null); setLocalError('');
    if (!value) return;
    try { const prepared=parse(readable,value);setSelection(prepared);setTitle(current=>current||prepared.title); } catch (failure) { setLocalError(inputError(failure)); }
  };
  const submit = async event => {
    event.preventDefault();
    if (inFlight.current || working || disabled || reading || !preview || preview.unavailable || !validTitle) return;
    inFlight.current = true; setSubmitting(true); setLocalError('');
    const request=generation.current;
    try { await onImport({ filename: preview.filename, title: currentTitle, content: preview.content }); }
    catch (failure) { if (mounted.current&&generation.current===request) setLocalError(publicErrorMessage(failure, 'The import could not be confirmed. Your notebook preview is kept here.')); }
    finally { inFlight.current = false; if (mounted.current) setSubmitting(false); }
  };
  const declaredKernel = preview?.content?.interchange?.metadata?.kernelspec;
  const visibleWarnings = preview?.warnings?.filter((item, index, entries) => entries.findIndex(other => other.code === item.code) === index) || [];
  return <form aria-labelledby={headingId} onSubmit={submit} className="space-y-4 rounded-lg border border-border bg-surface p-4 sm:p-5">
    <div><h3 id={headingId} className="text-lg font-semibold text-text">Import notebook</h3>
      <p className="mt-2 text-sm leading-relaxed text-textMuted">Source, retained outputs, attachments and metadata will be shared with this project's members. Importing does not run R or Python.</p></div>
    <label className="block text-sm font-medium text-text">Notebook file<input autoFocus={!pending} hidden={!!pending} type="file" accept=".ipynb,.IPYNB" aria-label="Notebook file" disabled={locked} onChange={choose} className="mt-2 w-full text-sm" />
      {pending && preview && !preview.unavailable && <span className="mt-2 block break-words text-sm font-normal">{preview.filename} · pending confirmation</span>}</label>
    <p className="text-xs leading-relaxed text-textMuted">Choose a UTF-8 nbformat 4.0–4.5 file, up to 2 MiB. Source and retained contents must fit the 1 MiB saved-document limit. The original file stays unchanged.</p>
    {reading && <p role="status" className="text-sm text-textMuted">Reading notebook…</p>}
    {readable && !pending && <label className="block text-sm font-medium text-text">Editing language<select aria-label="Notebook import editing language" className="input mt-2" value={language || (selection ? selection.content.defaultLanguage : '')} disabled={locked} onChange={selectLanguage}>
      {!selection && <option value="">Choose a language</option>}<option value="R">R</option><option value="python">Python</option></select>
      <span className="mt-1 block text-xs font-normal text-textMuted">This controls source editing. Original kernel metadata is retained; it does not configure compute or convert source.</span></label>}
    {preview && !preview.unavailable && <>
      <label className="block text-sm font-medium text-text">Document title<input aria-label="Notebook document title" className="input mt-2 w-full" value={currentTitle} maxLength={320} required disabled={locked} onChange={event => { if (!locked) setTitle(event.target.value); }} /></label>
      <section aria-label="Notebook import preview" className="space-y-3 rounded border border-border p-3">
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-xs text-text"><dt className="text-textMuted">File</dt><dd className="break-words">{preview.filename}</dd>
          <dt className="text-textMuted">Cells</dt><dd>{preview.summary.cells} total · {preview.summary.codeCells} code · {preview.summary.markdownCells} Markdown · {preview.summary.rawCells} raw</dd>
          <dt className="text-textMuted">Editing language</dt><dd>{languageLabel(preview.content.defaultLanguage)}</dd>
          <dt className="text-textMuted">Declared kernel</dt><dd className="break-words">{declaredKernel?.display_name || declaredKernel?.name || 'Not declared'} · imported metadata</dd>
          <dt className="text-textMuted">Retained results</dt><dd>{preview.summary.outputs} historical outputs · {preview.summary.attachments} attachments</dd>
        </dl>
        <p className="text-xs leading-relaxed text-textMuted">Imported outputs are historical file contents. They are not a captured in-app run and may not match the current source. Embedded HTML, scripts and widgets are kept inert.</p>
        {visibleWarnings.length > 0 && <ul aria-label="Notebook import notes" className="space-y-1 text-xs text-textMuted">{visibleWarnings.map(item => <li key={item.code}>{item.message}</li>)}</ul>}
        <details><summary className="cursor-pointer text-sm text-primary">Review notebook source</summary><div className="mt-3 space-y-3">
          {preview.content.cells.slice(0, 10).map((cell, index) => <SourcePreview key={cell.id} cell={cell} index={index} theme={theme} />)}
          {preview.content.cells.length > 10 && <p className="text-xs text-textMuted">Source preview lists the first 10 cells. All {preview.content.cells.length} cells are retained in the import.</p>}
        </div></details>
      </section>
    </>}
    {problem && <p role="alert" className="text-sm text-danger">{problem}</p>}
    {pending && <p role="status" className="text-xs leading-relaxed text-textMuted">Retry checks the same admitted import request. File, source and title stay fixed until its outcome is confirmed.</p>}
    <div className="flex flex-wrap gap-3"><button type="submit" className="btn btn-primary" disabled={working || disabled || reading || !preview || preview.unavailable || !validTitle}>{working ? 'Importing…' : pending ? 'Retry import' : 'Import notebook'}</button>
      <button type="button" className="btn btn-secondary" disabled={working || !!pending} onClick={onCancel}>Cancel</button></div>
  </form>;
}

function SourcePreview({ cell, index, theme }) {
  const [open, setOpen] = useState(false);
  return <details onToggle={event=>setOpen(event.currentTarget.open)}><summary className="cursor-pointer text-xs text-text">Cell {index + 1} · {cell.type === 'code' ? languageLabel(cell.language) : cell.type === 'raw' ? 'Raw text' : 'Markdown'}</summary>
    {open && (cell.type === 'code'
    ? <CodeEditor value={cell.source} language={cell.language} theme={theme} label={`Notebook import cell ${index + 1} source`} readOnly />
    : <pre tabIndex={0} aria-label={`Notebook import cell ${index + 1} source`} className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-background p-3 text-xs">{cell.source}</pre>)}</details>;
}
