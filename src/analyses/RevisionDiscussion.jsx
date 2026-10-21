import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { normalizeAnalysisAttachmentComment, ANALYSIS_ATTACHMENT_COMMENT_LIMITS } from '../../shared/analysisAttachmentComment.mjs';
import { listAnalysisAttachmentComments, createAnalysisAttachmentComment, getAnalysisAttachmentCommentRequest } from './analysisAttachmentApi';
import { validateAttachmentCommentList, validateAttachmentCommentAcceptance } from './analysisAttachmentCommentValidation';
import { publicErrorMessage } from '../publicError';

const denied = failure => [401, 403].includes(failure.status) || failure.status === 404
  && failure.code !== 'ANALYSIS_ATTACHMENT_COMMENT_REQUEST_NOT_FOUND';

// Only a researcher's own draft and frozen request live in this cache. Server
// comments and file bytes are never copied into browser persistence.
export default function RevisionDiscussion({ projectId, analysisId, userId, attachmentId, revisionId, revisionNumber,
  active, available, cache, cacheId, onDenied }) {
  const initial = useRef(cache.get(cacheId));
  const [body, setBody] = useState(initial.current?.body || '');
  const [pending, setPending] = useState(initial.current?.pending || null), [checked, setChecked] = useState(false);
  const [items, setItems] = useState([]), [cursor, setCursor] = useState(null), [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [canComment, setCanComment] = useState(null);
  const [error, setError] = useState(''), [confirmation, setConfirmation] = useState(null);
  const bodyRef = useRef(body), pendingRef = useRef(pending), uncertain = useRef(!!pending);
  const mounted = useRef(false), readRequest = useRef(null), actionRequest = useRef(null), generation = useRef(0);
  const denial = useRef(onDenied); denial.current = onDenied;
  const inputId = useId();
  const permitted = available && active && canComment === true;
  const remember = useCallback(() => {
    if (bodyRef.current || pendingRef.current) cache.set(cacheId, { body: bodyRef.current, pending: pendingRef.current });
    else cache.delete(cacheId);
  }, [cache, cacheId]);
  const cancelAction = useCallback(() => {
    actionRequest.current?.abort(); actionRequest.current = null;
    if (pendingRef.current) uncertain.current = true;
    setBusy(false);
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; readRequest.current?.abort(); actionRequest.current?.abort(); remember(); };
  }, [remember]);
  const clearAccess = useCallback(failure => {
    generation.current += 1; readRequest.current?.abort(); setLoading(false); cancelAction();
    setItems([]); setCursor(null); setLoaded(false); setCanComment(false); setConfirmation(null);
    denial.current?.(failure);
  }, [cancelAction]);
  const load = useCallback(async (next = null) => {
    if (!available) return;
    readRequest.current?.abort(); const controller = new AbortController(); readRequest.current = controller;
    const current = ++generation.current; setLoading(true); setError('');
    try {
      const result = validateAttachmentCommentList(await listAnalysisAttachmentComments(projectId, analysisId, attachmentId, revisionId,
        { cursor: next, signal: controller.signal }), { projectId, analysisId, userId }, attachmentId, revisionId);
      if (!mounted.current || controller.signal.aborted || generation.current !== current) return;
      if (!result.canComment) cancelAction();
      setCanComment(result.canComment);
      setItems(previous => next ? [...new Map([...previous, ...result.comments].map(item => [item.id, item])).values()] : result.comments);
      setCursor(result.nextCursor); setLoaded(true);
    } catch (failure) {
      if (!mounted.current || controller.signal.aborted || generation.current !== current) return;
      if (denied(failure)) clearAccess(failure);
      setError(publicErrorMessage(failure, 'Discussion could not be refreshed. Your draft and original comment request are kept here.'));
    } finally { if (mounted.current && generation.current === current) setLoading(false); }
  }, [available, projectId, analysisId, userId, attachmentId, revisionId, cancelAction, clearAccess]);
  useEffect(() => {
    if (available) return;
    generation.current += 1; readRequest.current?.abort(); cancelAction();
    setLoading(false); setLoaded(false); setItems([]); setCursor(null); setCanComment(null); setConfirmation(null);
  }, [available, cancelAction]);
  useEffect(() => {
    if (!active) cancelAction();
  }, [active, cancelAction]);
  useEffect(() => { if (available && !loaded && !loading && !error) void load(); }, [available, loaded, loading, error, load]);

  const accept = async (input, lookup) => {
    if (!available || actionRequest.current || pendingRef.current !== input || !lookup && !permitted) return;
    const controller = new AbortController(); actionRequest.current = controller; setBusy(true); setError('');
    try {
      const raw = lookup ? await getAnalysisAttachmentCommentRequest(projectId, analysisId, input.requestId, { signal: controller.signal })
        : await createAnalysisAttachmentComment(projectId, analysisId, attachmentId, revisionId, input, { signal: controller.signal });
      const result = await validateAttachmentCommentAcceptance(raw, { projectId, analysisId, userId }, attachmentId, revisionId, input);
      if (!mounted.current || controller.signal.aborted || actionRequest.current !== controller || pendingRef.current !== input) return;
      pendingRef.current = null; bodyRef.current = ''; uncertain.current = false; remember();
      setPending(null); setBody(''); setChecked(false); setCanComment(result.canComment); setConfirmation(result.comment);
      void load();
    } catch (failure) {
      if (!mounted.current || controller.signal.aborted || actionRequest.current !== controller || pendingRef.current !== input) return;
      const missing = lookup && failure.status === 404 && failure.code === 'ANALYSIS_ATTACHMENT_COMMENT_REQUEST_NOT_FOUND';
      if (lookup) setChecked(true);
      const certain = !lookup && !uncertain.current && ['INVALID_ANALYSIS_ATTACHMENT_COMMENT', 'ANALYSIS_ARCHIVED', 'ANALYSIS_ATTACHMENT_COMMENT_LIMIT'].includes(failure.code);
      if (certain) { pendingRef.current = null; setPending(null); setChecked(false); remember(); }
      else uncertain.current = true;
      if (denied(failure)) clearAccess(failure);
      setError(missing ? 'No accepted comment receipt is available yet. This does not prove the original request was rejected. Check again, or deliberately retry the original comment.'
        : publicErrorMessage(failure, certain ? 'This comment was not saved. Your draft is kept here.' : 'Comment completion is unconfirmed. Check the original request before retrying.'));
    } finally { if (actionRequest.current === controller) { actionRequest.current = null; if (mounted.current) setBusy(false); } }
  };
  const submit = event => {
    event.preventDefault(); if (!permitted || actionRequest.current || pendingRef.current) return;
    let input;
    try { input = Object.freeze(normalizeAnalysisAttachmentComment({ requestId: crypto.randomUUID(), body })); }
    catch (failure) { setError(failure.message); return; }
    pendingRef.current = input; uncertain.current = false; remember(); setPending(input); setChecked(false); setConfirmation(null); void accept(input, false);
  };
  return <section aria-label={`Discussion for revision ${revisionNumber}`} className="space-y-4 border-t border-border pt-5">
    <header><h4 className="font-semibold">Discussion <span className="text-sm font-normal text-textMuted">· revision {revisionNumber}</span></h4>
      <p className="mt-1 text-xs leading-relaxed text-textMuted">Comments stay with this saved revision when a result is corrected. Discussing it does not change access to its source.</p></header>
    {confirmation && <p role="status" className="rounded border border-primary/30 bg-primary/5 p-3 text-sm">Your comment is saved on revision {revisionNumber}.</p>}
    {error && <p role="alert" className="break-words text-sm text-danger">{error}</p>}
    {loading && <p role="status" className="text-xs text-textMuted">Loading discussion…</p>}
    {loaded && !items.length && <p className="text-sm text-textMuted">No comments on this revision yet.</p>}
    <ol aria-label="Revision comments" className="space-y-3">{items.map(item => <li key={item.id} className="min-w-0 rounded-lg border border-border bg-background p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-xs text-textMuted"><span className="min-w-0 max-w-full break-words font-medium text-text">{item.authorDisplayName}{item.authorUserId === Number(userId) ? ' · You' : ''}</span><time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString()}</time></div>
      <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed">{item.body}</p>
    </li>)}</ol>
    <div className="flex flex-wrap gap-2">{cursor && <button type="button" className="btn btn-secondary text-xs" disabled={!available || loading} onClick={() => void load(cursor)}>Load older comments</button>}
      <button type="button" className="text-xs text-textMuted underline" disabled={!available || loading} onClick={() => void load()}>Refresh discussion</button></div>
    {pending ? <section aria-label="Comment recovery" className="space-y-3 rounded-lg border border-warning/50 bg-warning/5 p-4">
      <h5 className="text-sm font-semibold">Keep the original comment</h5><p className="text-xs leading-relaxed text-textMuted">Completion may be unconfirmed. This request stays tied to revision {revisionNumber}; checking does not submit another comment.</p>
      <p className="whitespace-pre-wrap break-words text-sm">{pending.body}</p>
      <div className="flex flex-wrap gap-2"><button type="button" className="btn btn-secondary text-xs" disabled={!available || busy} onClick={() => void accept(pendingRef.current, true)}>Check comment outcome</button>
        {checked && <button type="button" className="btn btn-secondary text-xs" disabled={!permitted || busy} onClick={() => void accept(pendingRef.current, false)}>Retry original comment</button>}</div>
      {busy && <p role="status" className="text-xs text-textMuted">Checking or saving the original comment…</p>}
    </section> : <form aria-label={`Comment on revision ${revisionNumber}`} onSubmit={submit} className="space-y-2">
      <label htmlFor={inputId} className="block text-sm font-medium">Comment on this revision</label><textarea id={inputId} value={body} maxLength={ANALYSIS_ATTACHMENT_COMMENT_LIMITS.body * 2} disabled={!permitted || busy} rows={3}
        onChange={event => { bodyRef.current = event.target.value; setBody(event.target.value); remember(); setConfirmation(null); }} className="w-full resize-y rounded-lg border border-border bg-background p-3 text-sm font-normal" />
      <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs text-textMuted">{[...body].length} / {ANALYSIS_ATTACHMENT_COMMENT_LIMITS.body}</p><button type="submit" className="btn btn-primary text-xs" disabled={!permitted || busy || !body.trim()}>Post comment</button></div>
    </form>}
    {!available ? <p className="text-xs text-textMuted">Reconnect to read or discuss this revision.</p> : !active || canComment === false ? <p className="text-xs text-textMuted">Discussion is read-only for this analysis. Existing comments are retained.</p> : null}
  </section>;
}
