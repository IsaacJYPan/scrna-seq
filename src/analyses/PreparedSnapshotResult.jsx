import React, { useEffect, useRef, useState } from 'react';
import { RetainedResultContent } from '../components/RetainedArtifactView';
import useExecutionTarget from '../runtime/useExecutionTarget';
import { readSnapshotPreparationView } from './snapshotPreparationApi';
import { decodeSnapshotPreparationTable } from './snapshotPreparationValidation';

const denied = error => error.status === 401 || error.code === 'ANALYSIS_SNAPSHOT_SCOPE_NOT_FOUND'
  || error.status === 403 && !['ANALYSIS_SNAPSHOT_WRITE_REQUIRED', 'ANALYSIS_SNAPSHOT_WITHDRAW_REQUIRED', 'ANALYSIS_SNAPSHOT_SOURCE_READ_REQUIRED'].includes(error.code);
const unavailable = error => error.code === 'ANALYSIS_SNAPSHOT_PREPARATION_NOT_FOUND'
  || ['ANALYSIS_SNAPSHOT_PUBLICATION_NOT_FOUND', 'ANALYSIS_SNAPSHOT_PUBLICATION_WITHDRAWN', 'ANALYSIS_SNAPSHOT_SOURCE_READ_REQUIRED',
    'ANALYSIS_SNAPSHOT_VIEW_UNAVAILABLE', 'INVALID_SNAPSHOT_PREPARATION_RESPONSE', 'INVALID_SNAPSHOT_PUBLICATION_RESPONSE'].includes(error.code);

// The parent supplies a descriptor from a validated immutable ready package.
// This reader never opens the original source or changes the retained window.
export default function PreparedSnapshotResult({ projectId, analysisId, preparationId, serviceId, userId, descriptor,
  resourceId = preparationId, audience = 'private-preparation', snapshotSha256, readView,
  available, isActive, onDenied, onUnavailable }) {
  const target = useExecutionTarget();
  const reader = readView || (audience === 'private-preparation' ? readSnapshotPreparationView : null);
  const validScope = typeof resourceId === 'string' && (audience === 'private-preparation' && /^asp_[a-f0-9]{24}$/.test(resourceId)
    || audience === 'project-publication' && /^aspub_[a-f0-9]{24}$/.test(resourceId)) && typeof reader === 'function';
  const usable = available && isActive && !target.blocked && validScope;
  const key = JSON.stringify([audience, resourceId, snapshotSha256, projectId, analysisId, serviceId, userId, target.identity, target.epoch,
    descriptor?.viewId, descriptor?.view?.schema, descriptor?.view?.viewSha256, descriptor?.view?.blobSha256, descriptor?.view?.blobBytes,
    descriptor?.view?.family, descriptor?.view?.spec?.offset, descriptor?.view?.spec?.limit, descriptor?.view?.width,
    descriptor?.view?.height, descriptor?.source?.artifactId, descriptor?.source?.versionId, descriptor?.source?.ownerUserId,
    descriptor?.source?.sha256, descriptor?.source?.sizeBytes, descriptor?.source?.format?.id, descriptor?.source?.format?.version,
    descriptor?.origin?.kind, descriptor?.origin?.reference?.kind, descriptor?.origin?.reference?.versionId, descriptor?.origin?.reference?.sha256,
    descriptor?.origin?.analysisVersion, descriptor?.origin?.caption, descriptor?.origin?.captionOrigin,
    descriptor?.origin?.attachment?.attachmentId, descriptor?.origin?.attachment?.revisionId, descriptor?.origin?.attachment?.sourceOwnerUserId,
    descriptor?.attachment?.attachmentId, descriptor?.attachment?.revisionId, descriptor?.attachment?.sourceOwnerUserId]);
  const [body, setBody] = useState(null), [problem, setProblem] = useState(null), [loading, setLoading] = useState(false), [attempt, setAttempt] = useState(0);
  const [withdrawnKey, setWithdrawnKey] = useState(null), withdrawn = withdrawnKey === key;
  const generation = useRef(0), image = useRef(null), live = useRef(null);
  live.current = { key, usable, reader, onDenied, onUnavailable };
  const discardImage = () => { if (image.current) { URL.revokeObjectURL(image.current); image.current = null; } };
  useEffect(() => {
    const currentGeneration = ++generation.current, controller = new AbortController();
    discardImage(); setBody(null); setProblem(null); setLoading(false);
    if (!usable || withdrawn) return () => controller.abort();
    const expected = JSON.parse(JSON.stringify(descriptor));
    const current = () => !controller.signal.aborted && currentGeneration === generation.current && live.current.key === key && live.current.usable && live.current.reader === reader;
    setLoading(true);
    void (async () => {
      try {
        const received = await reader(projectId, analysisId, resourceId, expected, { signal: controller.signal });
        if (!current()) return;
        if (expected.view.family === 'table') {
          const preview = await decodeSnapshotPreparationTable(received.bytes, expected);
          if (current()) setBody({ key, reader, preview });
        } else {
          const imageUrl = URL.createObjectURL(new Blob([received.bytes], { type: received.type }));
          if (!current()) { URL.revokeObjectURL(imageUrl); return; }
          image.current = imageUrl;
          setBody({ key, reader, imageUrl, preview: { family: 'image', width: expected.view.width, height: expected.view.height } });
        }
      } catch (error) {
        if (!current()) return;
        if (error.code === 'ANALYSIS_SNAPSHOT_PUBLICATION_WITHDRAWN') setWithdrawnKey(key);
        else setProblem({ key, message: 'This retained view is unavailable or could not be verified. Its exact saved identity is kept.' });
        if (denied(error)) live.current.onDenied?.(error);
        else if (unavailable(error)) live.current.onUnavailable?.(error);
      } finally { if (current()) setLoading(false); }
    })();
    return () => { controller.abort(); discardImage(); };
    // The immutable key deliberately excludes refreshed descriptor/callback object identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, usable, attempt, reader, withdrawn]);

  const visible = usable && !withdrawn && body?.key === key && body.reader === reader ? body : null;
  const imageFailed = () => {
    if (!visible?.imageUrl || image.current !== visible.imageUrl || live.current.key !== key || !live.current.usable) return;
    discardImage(); setBody(null);
    setProblem({ key, message: 'This retained image could not be decoded. No figure preview is shown; its exact saved identity is kept.' });
    live.current.onUnavailable?.(Object.assign(new Error('The retained image could not be decoded.'), { status: 409, code: 'ANALYSIS_SNAPSHOT_VIEW_UNAVAILABLE' }));
  };
  return <div aria-label="Prepared retained result" className="min-w-0 space-y-3">
    {!validScope ? <p role="alert" className="text-sm text-danger">The retained view scope could not be verified.</p>
      : !usable ? <p className="text-xs text-textMuted">{!available || target.blocked ? 'Reconnect to inspect this retained view.' : 'Open this snapshot to inspect its retained view.'}</p>
      : <>{loading && <p role="status" className="text-sm text-textMuted">Opening the fixed retained view…</p>}
        {withdrawn ? <p role="alert" className="text-sm text-danger">This snapshot has been withdrawn. Its accepted identity remains recorded.</p>
          : problem?.key === key && <div className="space-y-2"><p role="alert" className="text-sm text-danger">{problem.message}</p><button type="button" className="btn btn-secondary text-xs" disabled={loading} onClick={() => setAttempt(value => value + 1)}>Retry retained view</button></div>}
        {visible && <><p className="text-xs text-success">Retained view checksum verified · fixed saved content</p><RetainedResultContent fixedView preview={visible.preview}
          imageUrl={visible.imageUrl} name={descriptor.source.name} onImageError={imageFailed} /></>}
      </>}
  </div>;
}
