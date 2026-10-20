import React, { useRef } from 'react';
import CodeEditor from './CodeEditor';

export default function ScriptEditor({ documentId, content, info, canEdit, theme, editorStates, onChange }) {
  const toolbar = useRef(null);
  const cell = content.cells[0];
  const stateKey = `${documentId}:${cell.id}`;
  const firstEnding = cell.source.match(/\r\n|\r|\n/)?.[0];
  const mixedEndings = firstEnding === '\r\n' ? /(^|[^\r])\n|\r(?!\n)/.test(cell.source)
    : firstEnding === '\n' ? /\r/.test(cell.source) : firstEnding === '\r' && /\n/.test(cell.source);
  return <section aria-label={`${info.language === 'R' ? 'R' : 'Python'} script`} className="min-w-0 space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><p className="break-all text-sm font-semibold">{info.filename}</p>
        <p className="mt-1 text-xs text-textMuted">{info.language === 'R' ? 'R' : 'Python'} script · UTF-8{info.bom ? ' with BOM' : ''} · {canEdit ? 'Editable source' : 'View access'}</p></div>
      <button ref={toolbar} type="button" className="text-xs text-primary underline" onClick={event => event.currentTarget.closest('section')?.querySelector('.cm-content')?.focus()}>{canEdit ? 'Edit script source' : 'View script source'}</button>
    </div>
    <p className="text-xs leading-relaxed text-textMuted">This is one ordinary source file. Helper paths stay as written; importing this file does not import its folder or run code.</p>
    {mixedEndings && <p role="note" className="rounded border border-border p-3 text-xs text-textMuted">This file has mixed line endings. Opening or exporting it preserves them; editing uses the first line ending style.</p>}
    <CodeEditor key={stateKey} value={cell.source} language={info.language} theme={theme} label="Script source" readOnly={!canEdit}
      initialState={editorStates.current.get(stateKey)} onStateChange={state => editorStates.current.set(stateKey, state)}
      onChange={onChange} onEscape={() => toolbar.current?.focus()} />
  </section>;
}
