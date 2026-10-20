import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { SCRIPT_FILE_LIMIT, exportScriptDocument, importScriptDocument, scriptDocumentInfo, scriptFileLanguage } from '../../shared/scriptDocument.mjs';
import { publicErrorMessage } from '../publicError';
import CodeEditor from './CodeEditor';

const initialTitle = filename => {
  const title = filename.slice(0, 160);
  return title.isWellFormed() ? title : title.slice(0, -1);
};
const fileBytes = file => typeof file.arrayBuffer === 'function' ? file.arrayBuffer() : new Promise((resolve, reject) => {
  // Older File implementations have FileReader but no Blob.arrayBuffer.
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(new Error('The selected script could not be read. Choose the file again.'));
  reader.onabort = () => reject(new Error('Script reading was canceled. Choose the file again.'));
  reader.readAsArrayBuffer(file);
});
const sourceError = error => ['INVALID_SCRIPT_DOCUMENT', 'SCRIPT_DOCUMENT_TOO_LARGE', 'INVALID_NOTEBOOK_DOCUMENT', 'NOTEBOOK_DOCUMENT_TOO_LARGE'].includes(error?.code)
  ? error.message : 'The selected script could not be read. Choose the file again.';
function previewFor(payload) {
  const info = scriptDocumentInfo(payload.content);
  if (!info || info.filename !== payload.filename) throw new Error('The pending script is unavailable.');
  return { ...payload, ...info, size: exportScriptDocument(payload.content).bytes.byteLength };
}
function lineEndings(source) {
  const pattern = /\r\n|\r|\n/g;
  const first = pattern.exec(source)?.[0];
  let match;
  while ((match = pattern.exec(source))) if (match[0] !== first) return 'mixed';
  return first === '\r\n' ? 'CRLF' : first === '\r' ? 'CR' : first === '\n' ? 'LF' : 'No line breaks';
}

/** Local source preparation only; all creation/retry mutations belong to onImport. */
export default function ScriptImport({ onImport, onCancel, busy = false, pending = null, disabled = false, error = '', theme = 'light' }) {
  const headingId = useId();
  const [selection, setSelection] = useState(null);
  const [title, setTitle] = useState('');
  const [reading, setReading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState('');
  const readGeneration = useRef(0), inFlight = useRef(false), mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (pending) { readGeneration.current++; setReading(false); } }, [pending]);
  const frozen = useMemo(() => {
    if (!pending) return null;
    try { return previewFor(pending); } catch { return { unavailable: true }; }
  }, [pending]);
  const preview = frozen || selection;
  const currentTitle = pending ? String(pending.title ?? '') : title;
  const working = busy || submitting;
  const locked = working || !!pending || disabled;
  const problem = localError || error || (frozen?.unavailable ? 'The pending script preview is unavailable. Return to document recovery before retrying.' : '');
  const endings = preview && !preview.unavailable ? lineEndings(preview.content.cells[0].source) : null;

  const choose = async event => {
    if (locked) return;
    const file = event.target.files?.[0], request = ++readGeneration.current;
    setSelection(null); setTitle(''); setLocalError('');
    if (!file) { setReading(false); return; }
    setReading(true);
    try {
      scriptFileLanguage(file.name);
      if (file.size > SCRIPT_FILE_LIMIT) throw Object.assign(new Error('This script exceeds the 256 KiB source limit.'), { code: 'SCRIPT_DOCUMENT_TOO_LARGE' });
      const bytes = new Uint8Array(await fileBytes(file));
      const content = importScriptDocument({ filename: file.name, bytes, cellId: crypto.randomUUID() });
      if (!mounted.current || readGeneration.current !== request) return;
      const payload = { filename: file.name, content, title: initialTitle(file.name) };
      setSelection(previewFor(payload)); setTitle(payload.title);
    } catch (failure) {
      if (mounted.current && readGeneration.current === request) setLocalError(sourceError(failure));
    } finally { if (mounted.current && readGeneration.current === request) setReading(false); }
  };
  const submit = async event => {
    event.preventDefault();
    if (inFlight.current || working || disabled || reading || !preview || preview.unavailable || !currentTitle.trim() || currentTitle.length > 160) return;
    inFlight.current = true; setSubmitting(true); setLocalError('');
    try { await onImport({ filename: preview.filename, content: preview.content, title: currentTitle }); }
    catch (failure) {
      if (mounted.current) setLocalError(publicErrorMessage(failure, 'The import could not be confirmed. Your script preview is kept here.'));
    } finally {
      inFlight.current = false;
      if (mounted.current) setSubmitting(false);
    }
  };

  return <form aria-labelledby={headingId} onSubmit={submit} className="space-y-4 rounded-lg border border-border bg-surface p-4 sm:p-5">
    <div><h3 id={headingId} className="text-lg font-semibold text-text">Import script</h3>
      <p className="mt-2 text-sm leading-relaxed text-textMuted">Source will be shared with this project's members. Importing saves source only; it does not run R or Python.</p></div>
    <label className="block text-sm font-medium text-text">Script file<input autoFocus={!pending} hidden={!!pending} type="file" accept=".R,.r,.py,.PY" aria-label="Script file" disabled={locked} onChange={choose} className="mt-2 w-full text-sm" />
      {pending && preview && !preview.unavailable && <span className="mt-2 block break-words text-sm font-normal">{preview.filename} · pending confirmation</span>}</label>
    <p className="text-xs leading-relaxed text-textMuted">Choose a UTF-8 .R or .py file, up to 256 KiB of source. The original local file stays unchanged.</p>
    {reading && <p role="status" className="text-sm text-textMuted">Reading script source…</p>}
    {preview && !preview.unavailable && <>
      <label className="block text-sm font-medium text-text">Document title<input aria-label="Script document title" className="input mt-2 w-full" value={currentTitle} maxLength={160} required disabled={locked} onChange={event => { if (!locked) setTitle(event.target.value); }} /></label>
      <section aria-label="Script preview" className="space-y-3 rounded border border-border p-3">
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-xs text-text"><dt className="text-textMuted">File</dt><dd className="break-words">{preview.filename}</dd>
          <dt className="text-textMuted">Language</dt><dd>{preview.language === 'python' ? 'Python' : 'R'}</dd><dt className="text-textMuted">Encoding</dt><dd>UTF-8</dd>
          <dt className="text-textMuted">UTF-8 BOM</dt><dd>{preview.bom ? 'Preserved' : 'None'}</dd><dt className="text-textMuted">File size</dt><dd>{preview.size.toLocaleString()} bytes</dd>
          <dt className="text-textMuted">Line endings</dt><dd>{endings === 'mixed' ? 'Mixed' : endings}</dd></dl>
        {endings === 'mixed' && <p className="text-xs leading-relaxed text-textMuted">Mixed line endings are preserved on import. Editing later uses the file's first line-ending style.</p>}
        <p className="text-xs leading-relaxed text-textMuted">Only this file is imported. Helper files and the surrounding folder are not uploaded; existing imports and relative paths stay in the source.</p>
        <CodeEditor value={preview.content.cells[0].source} language={preview.language} theme={theme} label="Script source preview" readOnly />
      </section>
    </>}
    {problem && <p role="alert" className="text-sm text-danger">{problem}</p>}
    {pending && <p role="status" className="text-xs leading-relaxed text-textMuted">Retry checks the same import request. File and title stay fixed until its outcome is confirmed.</p>}
    <div className="flex flex-wrap gap-3"><button type="submit" className="btn btn-primary" disabled={working || disabled || reading || !preview || preview.unavailable || !currentTitle.trim() || currentTitle.length > 160}>{working ? 'Importing…' : pending ? 'Retry import' : 'Import script'}</button>
      <button type="button" className="btn btn-secondary" disabled={working || !!pending} onClick={onCancel}>Cancel</button></div>
  </form>;
}
