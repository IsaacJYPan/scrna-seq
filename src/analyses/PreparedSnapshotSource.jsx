import React, { useEffect, useRef, useState } from 'react';
import useExecutionTarget from '../runtime/useExecutionTarget';
import { readSnapshotPreparationDocument } from './snapshotPreparationApi';
import { decodeSnapshotPreparationDocument } from './snapshotPreparationValidation';

const denied = error => error.status === 401 || error.code === 'ANALYSIS_SNAPSHOT_SCOPE_NOT_FOUND'
  || error.status === 403 && !['ANALYSIS_SNAPSHOT_WRITE_REQUIRED', 'ANALYSIS_SNAPSHOT_WITHDRAW_REQUIRED', 'ANALYSIS_SNAPSHOT_SOURCE_READ_REQUIRED'].includes(error.code);
const unavailable = error => error.code === 'ANALYSIS_SNAPSHOT_PREPARATION_NOT_FOUND'
  || ['ANALYSIS_SNAPSHOT_PUBLICATION_NOT_FOUND', 'ANALYSIS_SNAPSHOT_PUBLICATION_WITHDRAWN', 'ANALYSIS_SNAPSHOT_SOURCE_READ_REQUIRED',
    'ANALYSIS_SNAPSHOT_VIEW_UNAVAILABLE', 'INVALID_SNAPSHOT_PREPARATION_RESPONSE', 'INVALID_SNAPSHOT_PUBLICATION_RESPONSE'].includes(error.code);
const cellLabel = (cell, index) => `Cell ${index + 1} · ${cell.type === 'code' ? `${cell.language} code` : cell.type === 'markdown' ? 'Markdown text' : 'Raw text'}`;

export default function PreparedSnapshotSource({ projectId, analysisId, preparationId, serviceId, userId, descriptor,
  resourceId = preparationId, audience = 'private-preparation', snapshotSha256, readDocument,
  available, isActive, onDenied, onUnavailable }) {
  const target = useExecutionTarget();
  const reader = readDocument || (audience === 'private-preparation' ? readSnapshotPreparationDocument : null);
  const validScope = typeof resourceId === 'string' && (audience === 'private-preparation' && /^asp_[a-f0-9]{24}$/.test(resourceId)
    || audience === 'project-publication' && /^aspub_[a-f0-9]{24}$/.test(resourceId)) && typeof reader === 'function';
  const usable = available && isActive && !target.blocked && validScope;
  const key = JSON.stringify([audience, resourceId, snapshotSha256, projectId, analysisId, serviceId, userId, target.identity, target.epoch,
    descriptor?.viewId, descriptor?.documentId, descriptor?.versionId, descriptor?.sha256, descriptor?.viewSha256,
    descriptor?.blobSha256, descriptor?.blobBytes, descriptor?.documentKind, descriptor?.defaultLanguage]);
  const [opened, setOpened] = useState(null), [body, setBody] = useState(null), [problem, setProblem] = useState(null);
  const [loading, setLoading] = useState(false), [attempt, setAttempt] = useState(0), [cellId, setCellId] = useState(null), [rawOpen, setRawOpen] = useState(false);
  const [withdrawnKey, setWithdrawnKey] = useState(null), withdrawn = withdrawnKey === key;
  const generation = useRef(0), live = useRef(null);
  live.current = { key, usable, opened, reader, onDenied, onUnavailable };
  useEffect(() => {
    const currentGeneration = ++generation.current, controller = new AbortController();
    setBody(null); setProblem(null); setLoading(false); setCellId(null); setRawOpen(false);
    if (!usable || withdrawn || opened !== key) return () => controller.abort();
    const expected = JSON.parse(JSON.stringify(descriptor));
    const current = () => !controller.signal.aborted && currentGeneration === generation.current && live.current.key === key && live.current.usable
      && live.current.opened === key && live.current.reader === reader;
    setLoading(true);
    void (async () => {
      try {
        const received = await reader(projectId, analysisId, resourceId, expected, { signal: controller.signal });
        if (!current()) return;
        const content = await decodeSnapshotPreparationDocument(received.bytes, expected);
        if (!current()) return;
        setBody({ key, reader, content, canonical: new TextDecoder('utf-8', { fatal: true }).decode(received.bytes) });
        setCellId(content.cells[0]?.id || null);
      } catch (error) {
        if (!current()) return;
        if (error.code === 'ANALYSIS_SNAPSHOT_PUBLICATION_WITHDRAWN') setWithdrawnKey(key);
        else setProblem({ key, message: 'This retained supporting source is unavailable or could not be verified. Its exact saved identity is kept.' });
        if (denied(error)) live.current.onDenied?.(error);
        else if (unavailable(error)) live.current.onUnavailable?.(error);
      } finally { if (current()) setLoading(false); }
    })();
    return () => controller.abort();
    // A refreshed immutable descriptor must not cause another body read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, usable, opened, attempt, reader, withdrawn]);
  const visible = usable && !withdrawn && opened === key && body?.key === key && body.reader === reader ? body : null;
  const selectedCell = visible?.content.cells.find(cell => cell.id === cellId);
  return <section aria-label="Prepared supporting source" className="min-w-0 space-y-3 rounded border border-border bg-surface p-4">
    {!validScope ? <p role="alert" className="text-sm text-danger">The retained supporting source scope could not be verified.</p>
      : !usable ? <p className="text-xs text-textMuted">{!available || target.blocked ? 'Reconnect to inspect retained supporting source.' : 'Open this snapshot to inspect retained supporting source.'}</p>
      : <><h4 className="break-words text-sm font-semibold">{descriptor.title}</h4><p className="text-xs text-textMuted">Supporting source · saved version {descriptor.version} · producing code has not been established.</p>
        {!withdrawn && <button type="button" className="btn btn-secondary text-xs" onClick={() => setOpened(value => value === key ? null : key)}>{opened === key ? 'Hide supporting source' : 'View supporting source'}</button>}
        {loading && <p role="status" className="text-sm text-textMuted">Opening exact retained supporting source…</p>}
        {withdrawn ? <p role="alert" className="text-sm text-danger">This snapshot has been withdrawn. Its accepted identity remains recorded.</p>
          : problem?.key === key && <div className="space-y-2"><p role="alert" className="text-sm text-danger">{problem.message}</p><button type="button" className="btn btn-secondary text-xs" disabled={loading} onClick={() => setAttempt(value => value + 1)}>Retry supporting source</button></div>}
        {visible && <><p className="text-xs text-success">Saved supporting source checksum verified</p>
          {visible.content.cells.length > 1 && <label className="block text-sm">Saved source cell<select aria-label="Saved source cell" value={cellId || ''} className="input mt-1 block max-w-full" onChange={event => setCellId(event.target.value)}>{visible.content.cells.map((cell, index) => <option key={cell.id} value={cell.id}>{cellLabel(cell, index)}</option>)}</select></label>}
          {selectedCell ? <div><p className="mb-2 text-xs font-semibold">{cellLabel(selectedCell, visible.content.cells.indexOf(selectedCell))}</p><pre tabIndex={0} aria-label="Retained saved source" className="max-h-80 overflow-auto whitespace-pre rounded border border-border bg-background p-3 font-mono text-xs">{selectedCell.source || '(empty source)'}</pre></div>
            : <p className="text-xs text-textMuted">This saved source has no cells.</p>}
          <details className="text-xs text-textMuted" onToggle={event => setRawOpen(event.currentTarget.open)}><summary className="cursor-pointer">Exact saved source and metadata</summary>{rawOpen && <pre tabIndex={0} aria-label="Canonical retained source" className="mt-2 max-h-80 overflow-auto whitespace-pre rounded border border-border bg-background p-3 font-mono text-xs">{visible.canonical}</pre>}</details>
        </>}
      </>}
  </section>;
}
