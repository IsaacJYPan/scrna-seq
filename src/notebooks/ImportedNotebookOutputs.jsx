import React, { useEffect, useMemo, useRef, useState } from 'react';
import { notebookMimePreview, normalizeNotebookImportedOutput, NOTEBOOK_INTERCHANGE_LIMITS } from '../../shared/notebookInterchangeFields.mjs';

const unavailable = 'Imported representation retained for export; no supported safe browser preview is available.';
const historical = 'Imported historical output is not a captured in-app run and may not match the current source.';

/** A display projection only. The original imported payload is never rewritten. */
export function ImportedNotebookMimeView({ bundle, label = 'Imported image', inline = false }) {
  const preview = useMemo(() => {
    try { return notebookMimePreview(bundle); } catch { return { family: 'metadata', message: unavailable }; }
  }, [bundle]);
  if (preview.family === 'image') return <RasterPreview preview={preview} label={label} inline={inline} />;
  const Wrapper = inline ? 'span' : 'div';
  if (preview.family !== 'text') return <Wrapper className="text-xs text-textMuted">{preview.message}</Wrapper>;
  const Text = inline ? 'span' : 'pre';
  return <Wrapper className={inline ? 'whitespace-pre-wrap break-words' : 'space-y-2'}>
    <Text className={inline ? '' : 'max-h-96 overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-background p-3 text-xs text-text'}>{preview.text}</Text>
    {preview.truncated && <span className="block text-xs text-textMuted">Preview limited to 64 KiB. The complete imported value is retained for notebook export.</span>}
  </Wrapper>;
}

function RasterPreview({ preview, label, inline }) {
  const [loaded, setLoaded] = useState(null), [failed, setFailed] = useState(null);
  const release = useRef(() => {});
  useEffect(() => {
    let revoked = false, url;
    const revoke = () => { if (!revoked && url) { revoked = true; URL.revokeObjectURL(url); } };
    release.current = revoke;
    try {
      const binary = globalThis.atob(preview.base64);
      const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
      url = URL.createObjectURL(new Blob([bytes], { type: preview.mimeType }));
      setLoaded({ preview, url }); setFailed(null);
    } catch { setLoaded(null); setFailed(preview); }
    return revoke;
  }, [preview]);
  const Wrapper = inline ? 'span' : 'div';
  if (failed === preview) return <Wrapper className="text-xs text-textMuted">The browser could not display this imported image. Its original representation is retained for export.</Wrapper>;
  return <Wrapper className={inline ? 'inline-block max-w-full' : 'space-y-2'}>
    {loaded?.preview === preview && <img src={loaded.url} alt={label} width={preview.width} height={preview.height}
      className="h-auto max-h-[32rem] max-w-full rounded border border-border bg-white object-contain"
      onError={() => { release.current(); setFailed(preview); }} />}
    <span className="block text-xs text-textMuted">Imported {preview.mimeType === 'image/png' ? 'PNG' : 'JPEG'} · {preview.width} × {preview.height}. Browser preview; historical file contents.</span>
  </Wrapper>;
}

function Disclosure({ label, children }) {
  const [open, setOpen] = useState(false);
  return <details onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer text-sm text-text">{label}</summary>
    {open && <div className="mt-3 space-y-2">{children()}</div>}
  </details>;
}

function OutputBody({ output }) {
  const normalized = useMemo(() => { try { return normalizeNotebookImportedOutput(output); } catch { return null; } }, [output]);
  if (!normalized) return <p className="text-xs text-textMuted">This imported output cannot be previewed safely. Its stored contents are unchanged.</p>;
  if (normalized.output_type === 'stream') return <>
    <p className="text-xs text-textMuted">Historical {normalized.name} stream</p>
    <ImportedNotebookMimeView bundle={{ 'text/plain': normalized.text }} />
  </>;
  if (normalized.output_type === 'error') return <>
    <p className="text-xs text-textMuted">Historical error; this is not a new execution failure.</p>
    <ImportedNotebookMimeView bundle={{ 'text/plain': `${normalized.ename}: ${normalized.evalue}${normalized.traceback.length ? `\n${normalized.traceback.join('\n')}` : ''}` }} />
  </>;
  return <>
    {normalized.output_type === 'execute_result' && <p className="text-xs text-textMuted">Historical execution count: {normalized.execution_count ?? 'not recorded'}</p>}
    <ImportedNotebookMimeView bundle={normalized.data} />
    <p className="break-words text-xs text-textMuted">Retained representations: {Object.keys(normalized.data).join(', ') || 'none'}</p>
  </>;
}

function HistoricalContents({ imported }) {
  const [open, setOpen] = useState(false), [visible, setVisible] = useState(10);
  const outputs = Array.isArray(imported?.outputs) ? imported.outputs.slice(0, NOTEBOOK_INTERCHANGE_LIMITS.outputsPerCell) : [];
  const attachments = imported?.attachments && typeof imported.attachments === 'object' && !Array.isArray(imported.attachments)
    ? Object.entries(imported.attachments).slice(0, NOTEBOOK_INTERCHANGE_LIMITS.attachmentsPerCell) : [];
  const hasCount = Number.isSafeInteger(imported?.executionCount) && imported.executionCount >= 0;
  if (!outputs.length && !attachments.length && !hasCount) return null;
  const entries = [
    ...outputs.map((output, index) => ({ key: `output_${index}`, label: `Output ${index + 1} · ${['stream', 'error', 'display_data', 'execute_result'].includes(output?.output_type) ? output.output_type : 'unavailable'}`, body: () => <OutputBody output={output} /> })),
    ...attachments.map(([name, bundle], index) => ({ key: `attachment_${index}`, label: `Attachment · ${name}`, body: () => <ImportedNotebookMimeView bundle={bundle} label={`Imported attachment ${name}`} /> })),
  ];
  return <section aria-label="Imported historical results" className="space-y-2 rounded border border-border p-3">
    <p className="text-xs leading-relaxed text-textMuted">{historical}</p>
    {hasCount && <p className="text-xs text-textMuted">Historical cell execution count: {imported.executionCount}</p>}
    <details onToggle={event => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer text-sm text-primary">Imported results · {outputs.length} outputs · {attachments.length} attachments</summary>
      {open && <div className="mt-3 space-y-3">
        <p className="text-xs text-textMuted">Open an individual item to preview it. HTML, SVG, scripts, widgets and external resources are not rendered.</p>
        {entries.slice(0, visible).map(entry => <Disclosure key={entry.key} label={entry.label}>{entry.body}</Disclosure>)}
        {entries.length > visible && <button type="button" className="btn btn-secondary text-xs" onClick={() => setVisible(current => current + 10)}>Show next {Math.min(10, entries.length - visible)} imported items</button>}
      </div>}
    </details>
  </section>;
}

export default function ImportedNotebookOutputs({ cell, imported = cell?.imported, scopeKey = cell?.id }) {
  return <HistoricalContents key={scopeKey} imported={imported} />;
}
