import React, { useEffect, useRef, useState } from 'react';
import { buildSharedSnapshotUrl } from './sharedSnapshotLink';
import useExecutionTarget from '../runtime/useExecutionTarget';
import { ANALYSIS_SNAPSHOT_PUBLICATION_SCHEMA } from '../../shared/analysisSnapshotPublication.mjs';

function CopyLink({ target, withdrawn }) {
  const [url, setUrl] = useState(''), [status, setStatus] = useState('idle');
  const mounted = useRef(false), input = useRef(null), copying = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const copy = async () => {
    if (copying.current) return;
    let next;
    try { next = buildSharedSnapshotUrl(target, window.location.href); }
    catch { setUrl(''); setStatus('invalid-address'); return; }
    setUrl(next); copying.current = true; setStatus('copying');
    try {
      if (typeof navigator.clipboard?.writeText !== 'function') {
        setStatus('unavailable'); return;
      }
      await navigator.clipboard.writeText(next);
      if (mounted.current) setStatus('copied');
    } catch { if (mounted.current) setStatus('failed'); }
    finally { copying.current = false; }
  };
  const select = () => { input.current?.focus(); input.current?.select(); };
  return <>
    <button type="button" className="btn btn-secondary text-sm" disabled={status === 'copying'} onClick={() => void copy()}>
      {status === 'copying' ? 'Copying link…' : 'Copy link'}
    </button>
    {withdrawn && <p className="text-xs text-textMuted">This exact link opens the withdrawn publication record. Its findings are no longer available.</p>}
    {status === 'copied' && <p role="status" className="text-xs text-textMuted">Link copied. The recipient must sign in and already have project access.</p>}
    {status === 'unavailable' && <p role="status" className="text-xs text-textMuted">Clipboard access is unavailable. Select and copy the exact link below.</p>}
    {status === 'failed' && <p role="status" className="text-xs text-textMuted">Automatic copy failed. Select and copy the exact link below.</p>}
    {status === 'invalid-address' && <p role="status" className="text-xs text-textMuted">A link could not be built for this app address. Open the workspace at its HTTP or HTTPS app address and try again.</p>}
    {url && <div className="space-y-2"><label className="block text-xs text-textMuted">Exact shared snapshot link
      <textarea ref={input} aria-label="Shared snapshot link" value={url} readOnly rows={3}
        className="mt-1 block w-full min-w-0 rounded border border-border bg-background p-2 font-mono text-xs text-text"
        onFocus={event => event.currentTarget.select()} /></label>
      <button type="button" className="text-xs text-primary underline" onClick={select}>Select link</button>
    </div>}
    <p className="text-xs text-textMuted">The recipient needs this reachable workspace and project access. Local and SSH tunnel addresses may only work on this computer.</p>
  </>;
}

// The parent supplies an already strictly validated accepted full publication,
// never a private preparation, unconfirmed action or list-only summary.
export default function SharedSnapshotCopyLink({ publication, projectId, analysisId, serviceId, userId, available, isActive, blocked = false }) {
  const connection = useExecutionTarget();
  const validViewer = (typeof userId === 'number' || typeof userId === 'string' && /^[1-9]\d*$/.test(userId))
    && Number.isSafeInteger(Number(userId)) && Number(userId) > 0;
  const verified = publication?.schema === ANALYSIS_SNAPSHOT_PUBLICATION_SCHEMA && validViewer && typeof serviceId === 'string'
    && publication.serviceId === serviceId && publication.projectId === projectId && publication.analysisId === analysisId
    && publication.viewerUserId === Number(userId) && ['published', 'withdrawn'].includes(publication.policy?.state);
  const usable = verified && available === true && isActive === true && !blocked && !connection.blocked;
  const target = verified ? { serviceId: publication.serviceId, projectId: publication.projectId, analysisId: publication.analysisId,
    publicationId: publication.publicationId, snapshotSha256: publication.snapshotSha256 } : null;
  const key = JSON.stringify([target, userId, publication?.policy?.state, connection.identity, connection.epoch]);
  return <section aria-label="Share exact snapshot link" className="min-w-0 space-y-3 rounded border border-border p-3">
    {usable ? <CopyLink key={key} target={target} withdrawn={publication.policy.state === 'withdrawn'} />
      : <><button type="button" className="btn btn-secondary text-sm" disabled>Copy link</button>
        <p className="text-xs text-textMuted">Open this snapshot and confirm current access in the same workspace before copying a link.</p></>}
  </section>;
}
