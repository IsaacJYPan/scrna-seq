import React, { useEffect, useRef, useState } from 'react';
import useExecutionTarget from '../runtime/useExecutionTarget';
import { readSnapshotPreparationDocument } from './snapshotPreparationApi';
import { decodeSnapshotPreparationDocument } from './snapshotPreparationValidation';

const denied = error => error.status === 401 || error.code === 'ANALYSIS_SNAPSHOT_SCOPE_NOT_FOUND'
  || error.status === 403 && error.code !== 'ANALYSIS_SNAPSHOT_WRITE_REQUIRED';
const unavailable = error => error.code === 'ANALYSIS_SNAPSHOT_PREPARATION_NOT_FOUND'
  || error.code === 'ANALYSIS_SNAPSHOT_VIEW_UNAVAILABLE' || error.code === 'INVALID_SNAPSHOT_PREPARATION_RESPONSE';
const cellLabel = (cell, index) => `Cell ${index + 1} · ${cell.type === 'code' ? `${cell.language} code` : cell.type === 'markdown' ? 'Markdown text' : 'Raw text'}`;

export default function PreparedSnapshotSource({ projectId, analysisId, preparationId, serviceId, userId, descriptor,
  available, isActive, onDenied, onUnavailable }) {
  const target = useExecutionTarget(), usable = available && isActive && !target.blocked;
  const key = JSON.stringify([projectId, analysisId, preparationId, serviceId, userId, target.identity, target.epoch,
    descriptor?.viewId, descriptor?.documentId, descriptor?.versionId, descriptor?.sha256, descriptor?.viewSha256,
    descriptor?.blobSha256, descriptor?.blobBytes, descriptor?.documentKind, descriptor?.defaultLanguage]);
  const [opened, setOpened] = useState(null), [body, setBody] = useState(null), [problem, setProblem] = useState(null);
  const [loading, setLoading] = useState(false), [attempt, setAttempt] = useState(0), [cellId, setCellId] = useState(null), [rawOpen, setRawOpen] = useState(false);
  const generation = useRef(0), live = useRef(null);
  live.current = { key, usable, onDenied, onUnavailable };
  useEffect(() => {
    const currentGeneration = ++generation.current, controller = new AbortController();
    setBody(null); setProblem(null); setLoading(false); setCellId(null); setRawOpen(false);
    if (!usable || opened !== key) return () => controller.abort();
    const expected = JSON.parse(JSON.stringify(descriptor));
    const current = () => !controller.signal.aborted && currentGeneration === generation.current && live.current.key === key && live.current.usable;
    setLoading(true);
    void (async () => {
      try {
        const received = await readSnapshotPreparationDocument(projectId, analysisId, preparationId, expected, { signal: controller.signal });
        if (!current()) return;
        const content = await decodeSnapshotPreparationDocument(received.bytes, expected);
        if (!current()) return;
        setBody({ key, content, canonical: new TextDecoder('utf-8', { fatal: true }).decode(received.bytes) });
        setCellId(content.cells[0]?.id || null);
      } catch (error) {
        if (!current()) return;
        setProblem({ key, message: 'This retained supporting source is unavailable or could not be verified. Its exact saved identity is kept.' });
        if (denied(error)) live.current.onDenied?.(error);
        else if (unavailable(error)) live.current.onUnavailable?.(error);
      } finally { if (current()) setLoading(false); }
    })();
    return () => controller.abort();
    // A refreshed immutable descriptor must not cause another body read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, usable, opened, attempt]);
  const visible = usable && opened === key && body?.key === key ? body : null;
  const selectedCell = visible?.content.cells.find(cell => cell.id === cellId);
  return <section aria-label="Prepared supporting source" className="min-w-0 space-y-3 rounded border border-border bg-surface p-4">
    {!usable ? <p className="text-xs text-textMuted">{!available || target.blocked ? 'Reconnect to inspect retained supporting source.' : 'Open this preparation to inspect retained supporting source.'}</p>
      : <><h4 className="break-words text-sm font-semibold">{descriptor.title}</h4><p className="text-xs text-textMuted">Supporting source · saved version {descriptor.version} · producing code has not been established.</p>
        <button type="button" className="btn btn-secondary text-xs" onClick={() => setOpened(value => value === key ? null : key)}>{opened === key ? 'Hide supporting source' : 'View supporting source'}</button>
        {loading && <p role="status" className="text-sm text-textMuted">Opening exact retained supporting source…</p>}
        {problem?.key === key && <div className="space-y-2"><p role="alert" className="text-sm text-danger">{problem.message}</p><button type="button" className="btn btn-secondary text-xs" disabled={loading} onClick={() => setAttempt(value => value + 1)}>Retry supporting source</button></div>}
        {visible && <><p className="text-xs text-success">Saved supporting source checksum verified</p>
          {visible.content.cells.length > 1 && <label className="block text-sm">Saved source cell<select aria-label="Saved source cell" value={cellId || ''} className="input mt-1 block max-w-full" onChange={event => setCellId(event.target.value)}>{visible.content.cells.map((cell, index) => <option key={cell.id} value={cell.id}>{cellLabel(cell, index)}</option>)}</select></label>}
          {selectedCell ? <div><p className="mb-2 text-xs font-semibold">{cellLabel(selectedCell, visible.content.cells.indexOf(selectedCell))}</p><pre tabIndex={0} aria-label="Retained saved source" className="max-h-80 overflow-auto whitespace-pre rounded border border-border bg-background p-3 font-mono text-xs">{selectedCell.source || '(empty source)'}</pre></div>
            : <p className="text-xs text-textMuted">This saved source has no cells.</p>}
          <details className="text-xs text-textMuted" onToggle={event => setRawOpen(event.currentTarget.open)}><summary className="cursor-pointer">Exact saved source and metadata</summary>{rawOpen && <pre tabIndex={0} aria-label="Canonical retained source" className="mt-2 max-h-80 overflow-auto whitespace-pre rounded border border-border bg-background p-3 font-mono text-xs">{visible.canonical}</pre>}</details>
        </>}
      </>}
  </section>;
}
