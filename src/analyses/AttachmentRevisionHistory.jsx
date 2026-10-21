import React, { useCallback, useEffect, useRef, useState } from 'react';
import { listAnalysisAttachmentRevisions } from './analysisAttachmentApi';
import { validateAttachmentHistory } from './analysisAttachmentValidation';
import { publicErrorMessage } from '../publicError';

export default function AttachmentRevisionHistory({ projectId, analysisId, userId, attachmentId, headRevisionId, selectedRevisionId, available, onOpen, onDenied, onAuthority }) {
  const [open, setOpen] = useState(false), [items, setItems] = useState([]), [cursor, setCursor] = useState(null);
  const [loaded, setLoaded] = useState(false), [loading, setLoading] = useState(false), [error, setError] = useState('');
  const [observedHead, setObservedHead] = useState(headRevisionId);
  const currentRequest = useRef(null), generation = useRef(0), mounted = useRef(false), denied = useRef(onDenied);
  const authority = useRef(onAuthority); authority.current = onAuthority;
  denied.current = onDenied;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; currentRequest.current?.abort(); }; }, []);
  const load = useCallback(async (next = null) => {
    if (!available) return;
    currentRequest.current?.abort(); const controller = new AbortController(); currentRequest.current = controller;
    const current = ++generation.current; setLoading(true); setError('');
    try {
      const result = validateAttachmentHistory(await listAnalysisAttachmentRevisions(projectId, analysisId, attachmentId, { cursor: next, signal: controller.signal }), { projectId, analysisId, userId }, attachmentId);
      if (!mounted.current || controller.signal.aborted || current !== generation.current) return;
      authority.current?.(result.canWrite);
      setItems(previous => next ? [...new Map([...previous, ...result.revisions].map(item => [item.revision.id, item])).values()] : result.revisions);
      setCursor(result.nextCursor); setObservedHead(result.headRevisionId); setLoaded(true);
    } catch (failure) {
      if (!mounted.current || controller.signal.aborted || current !== generation.current) return;
      if ([401, 403, 404].includes(failure.status)) { setItems([]); denied.current?.(failure); }
      setError(publicErrorMessage(failure, 'Saved revisions could not be loaded. Try again when the workspace is available.'));
    } finally { if (mounted.current && current === generation.current) setLoading(false); }
  }, [projectId, analysisId, userId, attachmentId, available]);
  useEffect(() => {
    generation.current += 1; currentRequest.current?.abort(); setLoaded(false); setItems([]); setCursor(null); setLoading(false); setError('');
  }, [headRevisionId, available]);
  useEffect(() => { if (open && available && !loaded && !loading && !error) void load(); }, [open, available, loaded, loading, error, load]);
  return <details open={open} onToggle={event => setOpen(event.currentTarget.open)} className="rounded border border-border p-3 text-sm">
    <summary className="cursor-pointer font-medium">Saved revisions</summary>
    <div className="mt-3 space-y-3"><p className="text-xs leading-relaxed text-textMuted">Each correction keeps the earlier source and supplied context. Opening a revision does not make it current.</p>
      {loading && <p role="status" className="text-xs text-textMuted">Loading saved revisions…</p>}
      {error && <p role="alert" className="text-xs text-danger">{error}</p>}
      <ul aria-label="Attachment revision history" className="space-y-2">{items.map(item => <li key={item.revision.id} className="rounded border border-border p-3">
        <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-xs font-medium">Revision {item.revision.revisionNumber}{item.revision.id === observedHead ? ' · Current' : ''}{item.revision.id === selectedRevisionId ? ' · Viewing' : ''}</span>
          <button type="button" className="text-xs text-primary underline" disabled={!available} onClick={() => onOpen(item.revision)}>Open revision {item.revision.revisionNumber}</button></div>
        <p className="mt-2 whitespace-pre-wrap break-words text-xs">{item.revision.caption}</p><p className="mt-2 text-xs text-textMuted">{new Date(item.revision.createdAt).toLocaleString()} · {item.sourceAccess === 'available' ? 'Exact source available to you' : item.sourceAccess === 'restricted' ? 'Private source access is restricted' : 'Original source unavailable'}</p>
      </li>)}</ul>
      <button type="button" className="btn btn-secondary text-xs" disabled={loading || !available} onClick={() => void load(cursor || null)}>{cursor ? 'Load more revisions' : 'Refresh revisions'}</button>
    </div>
  </details>;
}
