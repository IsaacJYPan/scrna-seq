import React, { useEffect, useRef, useState } from 'react';
import { RetainedResultContent } from '../components/RetainedArtifactView';
import useExecutionTarget from '../runtime/useExecutionTarget';
import { readSnapshotPreparationView } from './snapshotPreparationApi';
import { decodeSnapshotPreparationTable } from './snapshotPreparationValidation';

const denied = error => error.status === 401 || error.code === 'ANALYSIS_SNAPSHOT_SCOPE_NOT_FOUND'
  || error.status === 403 && error.code !== 'ANALYSIS_SNAPSHOT_WRITE_REQUIRED';
const unavailable = error => error.code === 'ANALYSIS_SNAPSHOT_PREPARATION_NOT_FOUND'
  || error.code === 'ANALYSIS_SNAPSHOT_VIEW_UNAVAILABLE' || error.code === 'INVALID_SNAPSHOT_PREPARATION_RESPONSE';

// The parent supplies a descriptor from a validated immutable ready package.
// This reader never opens the original source or changes the retained window.
export default function PreparedSnapshotResult({ projectId, analysisId, preparationId, serviceId, userId, descriptor,
  available, isActive, onDenied, onUnavailable }) {
  const target = useExecutionTarget();
  const usable = available && isActive && !target.blocked;
  const key = JSON.stringify([projectId, analysisId, preparationId, serviceId, userId, target.identity, target.epoch,
    descriptor?.viewId, descriptor?.view?.viewSha256, descriptor?.view?.blobSha256, descriptor?.view?.blobBytes,
    descriptor?.view?.family, descriptor?.view?.spec?.offset, descriptor?.view?.spec?.limit, descriptor?.view?.width,
    descriptor?.view?.height, descriptor?.source?.versionId, descriptor?.source?.sha256, descriptor?.source?.format?.id]);
  const [body, setBody] = useState(null), [problem, setProblem] = useState(null), [loading, setLoading] = useState(false), [attempt, setAttempt] = useState(0);
  const generation = useRef(0), image = useRef(null), live = useRef(null);
  live.current = { key, usable, onDenied, onUnavailable };
  const discardImage = () => { if (image.current) { URL.revokeObjectURL(image.current); image.current = null; } };
  useEffect(() => {
    const currentGeneration = ++generation.current, controller = new AbortController();
    discardImage(); setBody(null); setProblem(null); setLoading(false);
    if (!usable) return () => controller.abort();
    const expected = JSON.parse(JSON.stringify(descriptor));
    const current = () => !controller.signal.aborted && currentGeneration === generation.current && live.current.key === key && live.current.usable;
    setLoading(true);
    void (async () => {
      try {
        const received = await readSnapshotPreparationView(projectId, analysisId, preparationId, expected, { signal: controller.signal });
        if (!current()) return;
        if (expected.view.family === 'table') {
          const preview = await decodeSnapshotPreparationTable(received.bytes, expected);
          if (current()) setBody({ key, preview });
        } else {
          const imageUrl = URL.createObjectURL(new Blob([received.bytes], { type: received.type }));
          if (!current()) { URL.revokeObjectURL(imageUrl); return; }
          image.current = imageUrl;
          setBody({ key, imageUrl, preview: { family: 'image', width: expected.view.width, height: expected.view.height } });
        }
      } catch (error) {
        if (!current()) return;
        setProblem({ key, message: 'This retained view is unavailable or could not be verified. Its original preparation is kept.' });
        if (denied(error)) live.current.onDenied?.(error);
        else if (unavailable(error)) live.current.onUnavailable?.(error);
      } finally { if (current()) setLoading(false); }
    })();
    return () => { controller.abort(); discardImage(); };
    // The immutable key deliberately excludes refreshed descriptor/callback object identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, usable, attempt]);

  const visible = usable && body?.key === key ? body : null;
  const imageFailed = () => {
    if (!visible?.imageUrl || image.current !== visible.imageUrl || live.current.key !== key || !live.current.usable) return;
    discardImage(); setBody(null);
    setProblem({ key, message: 'This retained image could not be decoded. No figure preview is shown; the original preparation is kept.' });
    live.current.onUnavailable?.(Object.assign(new Error('The retained image could not be decoded.'), { status: 409, code: 'ANALYSIS_SNAPSHOT_VIEW_UNAVAILABLE' }));
  };
  return <div aria-label="Prepared retained result" className="min-w-0 space-y-3">
    {!usable ? <p className="text-xs text-textMuted">{!available || target.blocked ? 'Reconnect to inspect this retained view.' : 'Open this preparation to inspect its retained view.'}</p>
      : <>{loading && <p role="status" className="text-sm text-textMuted">Opening the fixed retained view…</p>}
        {problem?.key === key && <div className="space-y-2"><p role="alert" className="text-sm text-danger">{problem.message}</p><button type="button" className="btn btn-secondary text-xs" disabled={loading} onClick={() => setAttempt(value => value + 1)}>Retry retained view</button></div>}
        {visible && <><p className="text-xs text-success">Retained view checksum verified · fixed saved content</p><RetainedResultContent fixedView preview={visible.preview}
          imageUrl={visible.imageUrl} name={descriptor.source.name} onImageError={imageFailed} /></>}
      </>}
  </div>;
}
