import React, { useEffect, useRef, useState } from 'react';
import { listSharedRevisionComments } from './sharedRevisionDiscussionApi';
import { validateAttachmentCommentList } from '../analyses/analysisAttachmentCommentValidation';
import { ANALYSIS_ATTACHMENT_COMMENT_LIMITS } from '../../shared/analysisAttachmentComment.mjs';
import useExecutionTarget from '../runtime/useExecutionTarget';

const invalid = () => Object.assign(new Error('The discussion response could not be verified.'), { code: 'INVALID_SHARED_DISCUSSION' });
function appendPage(previous, page, cursor) {
  if (cursor && page.nextCursor === cursor) throw invalid();
  const values = new Map(previous.map(item => [item.id, item]));
  for (const item of page.comments) {
    const saved = values.get(item.id);
    if (saved && JSON.stringify(saved) !== JSON.stringify(item)) throw invalid();
    values.set(item.id, item);
  }
  const result = [...values.values()];
  if (result.length > ANALYSIS_ATTACHMENT_COMMENT_LIMITS.revision) throw invalid();
  for (let index = 1; index < result.length; index++) {
    const previous = result[index - 1], current = result[index];
    if (Date.parse(previous.createdAt) < Date.parse(current.createdAt)
      || Date.parse(previous.createdAt) === Date.parse(current.createdAt) && previous.id < current.id) throw invalid();
  }
  return result;
}

function Discussion({ projectId, analysisId, attachment, userId, usable, onCheckAccess }) {
  const [opened, setOpened] = useState(false), [items, setItems] = useState([]);
  const [cursor, setCursor] = useState(null), [loaded, setLoaded] = useState(false), [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const mounted = useRef(false), request = useRef(null), generation = useRef(0), itemsRef = useRef([]);
  const heading = useRef(null), opener = useRef(null), didOpen = useRef(false), checkAccess = useRef(onCheckAccess);
  checkAccess.current = onCheckAccess;
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; generation.current += 1; request.current?.abort(); };
  }, []);
  useEffect(() => {
    if (opened) heading.current?.focus({ preventScroll: true });
    else if (didOpen.current) opener.current?.focus();
  }, [opened]);
  const check = failure => {
    try { Promise.resolve(checkAccess.current?.(failure)).catch(() => {}); }
    catch { /* The containing page owns the current-publication access check. */ }
  };
  const load = async (next = null) => {
    if (!usable) return;
    request.current?.abort();
    const controller = new AbortController(), current = ++generation.current;
    request.current = controller; setLoading(true); setError('');
    const previous = next ? itemsRef.current : [];
    try {
      const page = validateAttachmentCommentList(await listSharedRevisionComments(projectId, analysisId,
        attachment.attachmentId, attachment.revisionId, { cursor: next, signal: controller.signal }),
      { projectId, analysisId, userId }, attachment.attachmentId, attachment.revisionId);
      if (!mounted.current || controller.signal.aborted || generation.current !== current) return;
      const merged = appendPage(previous, page, next);
      itemsRef.current = merged; setItems(merged); setCursor(page.nextCursor); setLoaded(true);
    } catch (failure) {
      if (!mounted.current || controller.signal.aborted || generation.current !== current) return;
      itemsRef.current = []; setItems([]); setCursor(null); setLoaded(false);
      setError(failure?.status === 401 ? 'Sign in again to check this discussion. Snapshot access is being checked.'
        : [403, 404].includes(failure?.status) ? 'Discussion for this saved revision is unavailable. The retained findings are unchanged.'
          : typeof failure?.code === 'string' && failure.code.startsWith('INVALID_') ? 'This discussion response could not be verified. Retry or check current snapshot access.'
            : 'This discussion could not be reached. Retry or check current snapshot access.');
      if (failure?.status === 401) check(failure);
    } finally {
      if (mounted.current && generation.current === current) { request.current = null; setLoading(false); }
    }
  };
  const open = () => { didOpen.current = true; setOpened(true); void load(); };
  const close = () => {
    generation.current += 1; request.current?.abort(); request.current = null;
    itemsRef.current = []; setItems([]); setCursor(null); setLoaded(false); setLoading(false); setError(''); setOpened(false);
  };
  return <section aria-label={`Current discussion for saved revision ${attachment.revisionNumber}`} className="space-y-3 rounded border border-border bg-surface p-4">
    <h3 ref={heading} tabIndex={-1} className="text-sm font-semibold focus-visible:outline-none">Current discussion · Saved revision {attachment.revisionNumber}</h3>
    <p className="text-xs leading-relaxed text-textMuted">These live comments belong to this exact saved attachment revision. They are outside the immutable snapshot checksum. Reading them does not grant access to the original source.</p>
    {!usable && <p role="status" className="text-sm text-textMuted">Reconnect to the same workspace and open the snapshot to read this discussion.</p>}
    {!opened ? <button ref={opener} type="button" className="btn btn-secondary text-sm" disabled={!usable} onClick={open}>Read revision discussion</button>
      : <>
        {loading && <p role="status" className="text-sm text-textMuted">Loading saved revision discussion…</p>}
        {error && <p role="alert" className="text-sm text-textMuted">{error}</p>}
        {loaded && !items.length && <p className="text-sm text-textMuted">No comments on this saved revision yet.</p>}
        {!!items.length && <ol aria-label="Saved revision comments" className="space-y-3">{items.map(item => <li key={item.id} className="min-w-0 rounded border border-border bg-background p-3">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-xs text-textMuted">
            <span className="min-w-0 break-words font-medium text-text">{item.authorDisplayName}{item.authorUserId === Number(userId) ? ' · You' : ''}</span>
            <time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString()}</time>
          </div><p className="mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed">{item.body}</p>
        </li>)}</ol>}
        <div className="flex flex-wrap gap-3">
          {cursor && <button type="button" className="btn btn-secondary text-sm" disabled={!usable || loading} onClick={() => void load(cursor)}>Load older discussion</button>}
          <button type="button" className="text-sm text-primary underline" disabled={!usable || loading} onClick={() => void load()}>Refresh discussion</button>
          {error && <button type="button" className="text-sm text-primary underline" disabled={!usable} onClick={() => check()}>Check snapshot access</button>}
          <button type="button" className="text-sm text-textMuted underline" onClick={close}>Close discussion</button>
        </div>
      </>}
  </section>;
}

// Only the already validated included attachment context identifies a thread.
// A scope remount removes protected comments before a different scope renders.
export default function SharedRevisionDiscussion({ projectId, analysisId, attachment, serviceId, userId, available,
  isActive, onCheckAccess, accessEpoch = 0 }) {
  const target = useExecutionTarget();
  if (attachment === null || attachment === undefined) return <p className="text-sm text-textMuted">This finding has no linked saved-revision discussion.</p>;
  if (typeof serviceId !== 'string' || !/^svc_[a-f0-9]{32}$/.test(serviceId)
    || typeof projectId !== 'string' || !/^proj_[a-f0-9]{16,40}$/.test(projectId)
    || typeof analysisId !== 'string' || !/^ra_[a-f0-9]{24}$/.test(analysisId)
    || !Number.isSafeInteger(Number(userId)) || Number(userId) < 1
    || !['number', 'string'].includes(typeof userId) || typeof userId === 'string' && !/^[1-9]\d*$/.test(userId)
    || !Number.isSafeInteger(accessEpoch) || accessEpoch < 0
    || typeof attachment.attachmentId !== 'string' || !/^raa_[a-f0-9]{24}$/.test(attachment.attachmentId)
    || typeof attachment.revisionId !== 'string' || !/^rar_[a-f0-9]{24}$/.test(attachment.revisionId)
    || !Number.isSafeInteger(attachment.revisionNumber) || attachment.revisionNumber < 1 || attachment.revisionNumber > 200) {
    return <p role="alert" className="text-sm text-textMuted">The saved discussion reference could not be verified.</p>;
  }
  const usable = available === true && isActive === true && !target.blocked;
  const scopeKey = JSON.stringify([serviceId, projectId, analysisId, Number(userId), attachment.attachmentId, attachment.revisionId,
    attachment.revisionNumber, accessEpoch, available, isActive, target.identity, target.epoch, usable]);
  return <Discussion key={scopeKey} {...{ projectId, analysisId, attachment, userId, usable, onCheckAccess }} />;
}
