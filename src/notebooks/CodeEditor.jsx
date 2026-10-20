import React, { useLayoutEffect, useRef } from 'react';
import { Annotation, Compartment, EditorState, StateEffect, Text, Transaction } from '@codemirror/state';
import { EditorView, drawSelection, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, isolateHistory } from '@codemirror/commands';
import { HighlightStyle, StreamLanguage, bracketMatching, indentOnInput, syntaxHighlighting } from '@codemirror/language';
import { python } from '@codemirror/lang-python';
import { r } from '@codemirror/legacy-modes/mode/r';
import { tags } from '@lezer/highlight';

const externalSource = Annotation.define();
const normalizedSource = value => String(value ?? '').replace(/\r\n?/g, '\n');
const sourceSeparator = value => String(value ?? '').match(/\r\n|\r|\n/)?.[0];
const languageExtension = language => language === 'python' ? python() : StreamLanguage.define(r);
const accessExtension = readOnly => [EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)];
const contentAttributes = (label, readOnly) => EditorView.contentAttributes.of({
  'aria-label': label,
  'aria-readonly': String(readOnly),
  // A read-only source remains keyboard reachable for selection and copying.
  tabindex: '0',
});

function editorTheme(theme) {
  const dark = theme === 'dark';
  return [EditorView.theme({
    '&': {
      minWidth: '0', maxWidth: '100%', color: 'var(--color-text)', backgroundColor: 'var(--color-surface)',
      border: '1px solid var(--color-border)', borderRadius: '8px', fontSize: '13px',
    },
    '&.cm-focused': { outline: '2px solid var(--color-primary)', outlineOffset: '2px' },
    '.cm-scroller': {
      minHeight: '5rem', maxHeight: 'min(28rem, 60vh)', overflow: 'auto',
      fontFamily: 'ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace', lineHeight: '1.65',
    },
    '.cm-content': { padding: '10px 0', caretColor: 'var(--color-text)' },
    '.cm-line': { padding: '0 12px' },
    '.cm-gutters': {
      backgroundColor: 'var(--color-background)', color: 'var(--color-textMuted)',
      borderRight: '1px solid var(--color-border)', borderRadius: '8px 0 0 8px',
    },
    '.cm-lineNumbers .cm-gutterElement': { minWidth: '2.5em', padding: '0 8px' },
    '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'var(--accent-soft)' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
      backgroundColor: dark ? 'rgba(96, 160, 255, 0.30)' : 'rgba(0, 113, 227, 0.20)',
    },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--color-text)' },
    '&.cm-focused .cm-matchingBracket': { backgroundColor: 'var(--accent-soft)', outline: '1px solid var(--color-border)' },
  }, { dark }), syntaxHighlighting(HighlightStyle.define([
    { tag: [tags.keyword, tags.controlKeyword, tags.definitionKeyword], color: dark ? '#d2a8ff' : '#7430a0' },
    { tag: [tags.string, tags.regexp], color: dark ? '#a5d6a7' : '#146d37' },
    { tag: [tags.number, tags.bool, tags.null, tags.atom], color: dark ? '#8cc9ff' : '#005ba8' },
    { tag: [tags.comment, tags.meta], color: 'var(--color-textMuted)', fontStyle: 'italic' },
    { tag: [tags.function(tags.variableName), tags.definition(tags.variableName)], color: dark ? '#ffcf8a' : '#854d0e' },
  ]))];
}

// Keep unaffected text (and its selection/history mapping) when authoritative
// source arrives from outside this editor, rather than replacing the whole doc.
function sourceChange(current, next) {
  let from = 0;
  while (from < current.length && from < next.length && current[from] === next[from]) from++;
  let currentEnd = current.length, nextEnd = next.length;
  while (currentEnd > from && nextEnd > from && current[currentEnd - 1] === next[nextEnd - 1]) {
    currentEnd--; nextEnd--;
  }
  return { from, to: currentEnd, insert: Text.of(next.slice(from, nextEnd).split('\n')) };
}

/**
 * Controlled source editor; it does not execute or persist code.
 *
 * A differing `value` is an authoritative external source update: it is mapped
 * into the current session without emitting onChange or adding an undo event.
 * Parent onChange echoes and configuration updates retain ordinary undo.
 * Existing CRLF, LF or CR source keeps that separator through deliberate edits.
 * Mixed source is untouched on opening; editing uses its first separator.
 *
 * `initialState` is an opaque EditorState previously supplied to onStateChange.
 * Keep it only in memory, scoped to a document/cell identity. It is used on mount
 * only, and only when its source matches value. Switch document identity with a
 * React key; passing another cell's state would also pass that cell's undo data.
 */
export default function CodeEditor({
  value = '', language = 'R', theme = 'light', label = 'Source code', readOnly = false,
  onChange, onFocus, onEscape, initialState, onStateChange,
}) {
  const host = useRef(null);
  const viewRef = useRef(null);
  const compartments = useRef(null);
  const configured = useRef(null);
  const initial = useRef({ value, language, theme, label, readOnly, initialState });
  const callbacks = useRef({ onChange, onFocus, onEscape, onStateChange });

  useLayoutEffect(() => {
    callbacks.current = { onChange, onFocus, onEscape, onStateChange };
  }, [onChange, onFocus, onEscape, onStateChange]);

  useLayoutEffect(() => {
    const start = initial.current;
    const slots = { language: new Compartment(), theme: new Compartment(), access: new Compartment(), label: new Compartment(), separator: new Compartment() };
    compartments.current = slots;
    configured.current = { language: start.language, theme: start.theme, readOnly: start.readOnly, label: start.label };
    const extensions = [
      lineNumbers(), highlightActiveLineGutter(), highlightActiveLine(), drawSelection(),
      history(), bracketMatching(), indentOnInput(),
      // Deliberately omit indentWithTab: Tab and Shift+Tab leave the editor.
      keymap.of([...historyKeymap, ...defaultKeymap]),
      slots.language.of(languageExtension(start.language)),
      slots.theme.of(editorTheme(start.theme)),
      slots.access.of(accessExtension(start.readOnly)),
      slots.label.of(contentAttributes(start.label, start.readOnly)),
      slots.separator.of(EditorState.lineSeparator.of(sourceSeparator(start.value) || '\n')),
      EditorView.clipboardInputFilter.of((text, state) => normalizedSource(text).replace(/\n/g, state.lineBreak)),
      EditorView.domEventHandlers({
        focus(event) { callbacks.current.onFocus?.(event); },
        keydown(event) {
          if (event.key !== 'Escape' || event.isComposing || !callbacks.current.onEscape) return false;
          event.preventDefault(); callbacks.current.onEscape(event); return true;
        },
      }),
      EditorView.updateListener.of(update => {
        callbacks.current.onStateChange?.(update.state);
        if (update.docChanged && !update.transactions.some(transaction => transaction.annotation(externalSource))) {
          callbacks.current.onChange?.(update.state.sliceDoc());
        }
      }),
    ];
    const doc = normalizedSource(start.value);
    const retained = start.initialState;
    // Rebind all view callbacks/compartments when restoring an in-memory state;
    // history is a stable state field and survives this reconfiguration.
    const state = retained instanceof EditorState && retained.doc.toString() === doc
      ? retained.update({ effects: StateEffect.reconfigure.of(extensions) }).state
      : EditorState.create({ doc: Text.of(doc.split('\n')), extensions });
    const view = new EditorView({ state, parent: host.current });
    viewRef.current = view;
    callbacks.current.onStateChange?.(state);
    return () => {
      callbacks.current.onStateChange?.(view.state);
      viewRef.current = null;
      view.destroy();
    };
  }, []);

  useLayoutEffect(() => {
    const view = viewRef.current, slots = compartments.current, previous = configured.current;
    if (!view || !slots) return;
    const effects = [];
    if (previous.language !== language) effects.push(slots.language.reconfigure(languageExtension(language)));
    if (previous.theme !== theme) effects.push(slots.theme.reconfigure(editorTheme(theme)));
    if (previous.readOnly !== readOnly) effects.push(slots.access.reconfigure(accessExtension(readOnly)));
    if (previous.label !== label || previous.readOnly !== readOnly) effects.push(slots.label.reconfigure(contentAttributes(label, readOnly)));
    configured.current = { language, theme, label, readOnly };
    if (effects.length) view.dispatch({ effects });
  }, [language, theme, label, readOnly]);

  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const next = normalizedSource(value), current = view.state.doc.toString();
    const separator = sourceSeparator(value);
    const effects = separator && separator !== view.state.lineBreak
      ? [compartments.current.separator.reconfigure(EditorState.lineSeparator.of(separator))] : [];
    if (next !== current || effects.length) view.dispatch({
      ...(next !== current ? { changes: sourceChange(current, next) } : {}), effects,
      annotations: [externalSource.of(true), Transaction.addToHistory.of(false), isolateHistory.of('full')],
    });
  }, [value]);

  return <div ref={host} className="min-w-0 max-w-full" />;
}
