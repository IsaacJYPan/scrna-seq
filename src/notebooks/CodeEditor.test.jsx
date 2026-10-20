import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { insertNewlineAndIndent, redo, undo, undoDepth } from '@codemirror/commands';
import { ensureSyntaxTree } from '@codemirror/language';
import CodeEditor from './CodeEditor';

// jsdom has no text layout. Actual keyboard traversal and rendering are covered
// by the notebook browser acceptance, not these deterministic editor-state tests.
beforeAll(() => {
  if (!Range.prototype.getClientRects) Range.prototype.getClientRects = () => [];
  if (!Range.prototype.getBoundingClientRect) Range.prototype.getBoundingClientRect = () => ({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const editor = () => EditorView.findFromDOM(screen.getByRole('textbox'));
const append = (view, text) => act(() => view.dispatch({
  changes: { from: view.state.doc.length, insert: text },
  selection: { anchor: view.state.doc.length + text.length },
  userEvent: 'input.type',
}));

describe('notebook source editor', () => {
  it('gives both editable and read-only source an accessible multiline name', () => {
    const ui = render(<CodeEditor value={'# Inspect cells\nncol(object)'} label="Cell inspection R source" />);
    const textbox = screen.getByRole('textbox', { name: 'Cell inspection R source' });
    expect(textbox).toHaveAttribute('aria-multiline', 'true');
    expect(textbox).toHaveAttribute('aria-readonly', 'false');
    expect(textbox).toHaveAttribute('contenteditable', 'true');
    expect(textbox).toHaveAttribute('tabindex', '0');
    expect(editor().dom.querySelector('.cm-lineNumbers')).not.toBeNull();
    ui.rerender(<CodeEditor value={'# Inspect cells\nncol(object)'} label="Retained R source" readOnly />);
    expect(screen.getByRole('textbox', { name: 'Retained R source' })).toBe(textbox);
    expect(textbox).toHaveAttribute('aria-readonly', 'true');
    expect(textbox).toHaveAttribute('contenteditable', 'false');
    expect(textbox).toHaveAttribute('tabindex', '0');
  });

  it('retains the view, selection and ordinary undo through controlled echoes and theme/language changes', () => {
    const changed = vi.fn();
    const ui = render(<CodeEditor value="cells" language="R" theme="light" onChange={changed} />);
    const view = editor();
    append(view, ' + 1');
    expect(changed).toHaveBeenCalledExactlyOnceWith('cells + 1');
    expect(undoDepth(view.state)).toBe(1);
    ui.rerender(<CodeEditor value="cells + 1" language="python" theme="dark" onChange={changed} />);
    expect(editor()).toBe(view);
    expect(view.state.selection.main.anchor).toBe('cells + 1'.length);
    expect(view.state.facet(EditorView.darkTheme)).toBe(true);
    expect(undoDepth(view.state)).toBe(1);
    act(() => expect(undo(view)).toBe(true));
    expect(view.state.doc.toString()).toBe('cells');
    expect(changed).toHaveBeenLastCalledWith('cells');
    act(() => expect(redo(view)).toBe(true));
    expect(view.state.doc.toString()).toBe('cells + 1');
  });

  it('uses actual R and Python parsers, changing syntax without replacing source or history', () => {
    const source = 'if (TRUE) {\n  print("cells")\n}\n# A note';
    const ui = render(<CodeEditor value={source} language="R" />);
    const view = editor();
    expect(ensureSyntaxTree(view.state, source.length, 200)?.topNode.name).toBe('Document');
    ui.rerender(<CodeEditor value={source} language="python" />);
    expect(ensureSyntaxTree(view.state, source.length, 200)?.topNode.name).toBe('Script');
    expect(view.state.doc.toString()).toBe(source);
    expect(editor()).toBe(view);
    expect(undoDepth(view.state)).toBe(0);
  });

  it('applies authoritative source without an onChange loop, preserving unaffected selection', () => {
    const changed = vi.fn(), stateChanged = vi.fn();
    const ui = render(<CodeEditor value="ncol(object)" onChange={changed} onStateChange={stateChanged} />);
    const view = editor();
    act(() => view.dispatch({ selection: { anchor: 5 } }));
    ui.rerender(<CodeEditor value={'# retained\nncol(object)'} onChange={changed} onStateChange={stateChanged} />);
    expect(view.state.doc.toString()).toBe('# retained\nncol(object)');
    expect(view.state.selection.main.anchor).toBe(5 + '# retained\n'.length);
    expect(changed).not.toHaveBeenCalled();
    expect(undoDepth(view.state)).toBe(0);
    expect(stateChanged).toHaveBeenLastCalledWith(view.state);
    ui.rerender(<CodeEditor value={'# retained\nncol(object)'} onChange={changed} onStateChange={stateChanged} />);
    expect(changed).not.toHaveBeenCalled();
    expect(editor()).toBe(view);
  });

  it('preserves exact CRLF and whitespace through passive mount/configuration and a deliberate edit', () => {
    const changed = vi.fn();
    const source = '\tx <- 1  \r\nprint(x)\r\n';
    const ui = render(<CodeEditor value={source} onChange={changed} />);
    const view = editor();
    expect(view.state.doc.lines).toBe(3);
    expect(view.state.sliceDoc()).toBe(source);
    ui.rerender(<CodeEditor value={source} language="python" theme="dark" readOnly onChange={changed} />);
    expect(view.state.sliceDoc()).toBe(source);
    ui.rerender(<CodeEditor value={source} language="R" theme="light" onChange={changed} />);
    expect(view.state.sliceDoc()).toBe(source);
    expect(changed).not.toHaveBeenCalled();
    append(view, '# note');
    expect(changed).toHaveBeenCalledExactlyOnceWith(`${source}# note`);
    act(() => expect(insertNewlineAndIndent(view)).toBe(true));
    expect(changed).toHaveBeenLastCalledWith(`${source}# note\r\n`);
    expect(view.state.doc.lines).toBe(4);
  });

  it('accepts an external line-ending change without a user-edit callback or malformed lines', () => {
    const changed = vi.fn();
    const ui = render(<CodeEditor value={'x <- 1\nprint(x)'} onChange={changed} />);
    const view = editor();
    ui.rerender(<CodeEditor value={'x <- 1\r\nprint(x)'} onChange={changed} />);
    expect(view.state.sliceDoc()).toBe('x <- 1\r\nprint(x)');
    expect(view.state.doc.lines).toBe(2);
    expect(changed).not.toHaveBeenCalled();
    ui.rerender(<CodeEditor value={'x <- 2\r\n\r\nprint(x)'} onChange={changed} />);
    expect(view.state.sliceDoc()).toBe('x <- 2\r\n\r\nprint(x)');
    expect(view.state.doc.lines).toBe(3);
    expect(changed).not.toHaveBeenCalled();
    const [filter] = view.state.facet(EditorView.clipboardInputFilter);
    expect(filter('a\nb\r\nc', view.state)).toBe('a\r\nb\r\nc');
  });

  it('makes read-only source non-editable without discarding its undo history', () => {
    const changed = vi.fn();
    const ui = render(<CodeEditor value="ncol(object)" onChange={changed} />);
    const view = editor();
    append(view, ' + 1');
    ui.rerender(<CodeEditor value="ncol(object) + 1" readOnly onChange={changed} />);
    expect(view.state.readOnly).toBe(true);
    act(() => { expect(insertNewlineAndIndent(view)).toBe(false); expect(undo(view)).toBe(false); });
    expect(view.state.doc.toString()).toBe('ncol(object) + 1');
    expect(undoDepth(view.state)).toBe(1);
    ui.rerender(<CodeEditor value="ncol(object) + 1" onChange={changed} />);
    act(() => expect(undo(view)).toBe(true));
    expect(view.state.doc.toString()).toBe('ncol(object)');
  });

  it('restores opaque in-memory undo across unmount while rebinding callbacks', () => {
    let retained;
    const oldChange = vi.fn(), newChange = vi.fn();
    const first = render(<CodeEditor value="cells" onChange={oldChange} onStateChange={state => { retained = state; }} />);
    append(editor(), ' + 1');
    first.unmount();
    expect(retained).toBeInstanceOf(EditorState);
    render(<CodeEditor value="cells + 1" theme="dark" initialState={retained} onChange={newChange} />);
    const restored = editor();
    expect(undoDepth(restored.state)).toBe(1);
    expect(restored.state.facet(EditorView.darkTheme)).toBe(true);
    act(() => expect(undo(restored)).toBe(true));
    expect(newChange).toHaveBeenCalledExactlyOnceWith('cells');
    expect(oldChange).toHaveBeenCalledExactlyOnceWith('cells + 1');
  });

  it('does not attach mismatched retained source or its undo to another document', () => {
    let retained;
    const first = render(<CodeEditor value="private_cell" onStateChange={state => { retained = state; }} />);
    append(editor(), ' + 1');
    first.unmount();
    render(<CodeEditor value="different_cell" initialState={retained} />);
    expect(editor().state.doc.toString()).toBe('different_cell');
    expect(undoDepth(editor().state)).toBe(0);
    act(() => expect(undo(editor())).toBe(false));
  });

  it('leaves Tab navigation native and calls the current Escape/focus handlers', () => {
    const oldEscape = vi.fn(), newEscape = vi.fn(), focused = vi.fn();
    const ui = render(<CodeEditor value="cells" onEscape={oldEscape} onFocus={focused} />);
    const textbox = screen.getByRole('textbox');
    expect(fireEvent.keyDown(textbox, { key: 'Tab', code: 'Tab' })).toBe(true);
    expect(fireEvent.keyDown(textbox, { key: 'Tab', code: 'Tab', shiftKey: true })).toBe(true);
    ui.rerender(<CodeEditor value="cells" onEscape={newEscape} onFocus={focused} />);
    act(() => textbox.focus());
    expect(focused).toHaveBeenCalledOnce();
    expect(fireEvent.keyDown(textbox, { key: 'Escape', code: 'Escape' })).toBe(false);
    expect(newEscape).toHaveBeenCalledOnce();
    expect(oldEscape).not.toHaveBeenCalled();
    // IME composition must not unexpectedly leave the cell.
    expect(fireEvent.keyDown(textbox, { key: 'Escape', code: 'Escape', isComposing: true })).toBe(true);
    expect(newEscape).toHaveBeenCalledOnce();
  });
});
