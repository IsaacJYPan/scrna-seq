import React, { useEffect, useState } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AnalysisShell from './AnalysisShell';

let shellWidth, observers, showModal, close;
const nativeShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
const nativeClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close');
beforeEach(() => {
  shellWidth = 1100; observers = [];
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({
    width: shellWidth, height: 700, top: 0, left: 0, bottom: 700, right: shellWidth,
  }));
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe(target) { this.target = target; }
    disconnect = vi.fn();
  });
  // jsdom does not implement the native top layer or modal focus trap.
  showModal = vi.fn(function () { this.setAttribute('open', ''); });
  close = vi.fn(function () { this.removeAttribute('open'); });
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: showModal });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: close });
});
afterEach(() => {
  cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  if (nativeShowModal) Object.defineProperty(HTMLDialogElement.prototype, 'showModal', nativeShowModal);
  else delete HTMLDialogElement.prototype.showModal;
  if (nativeClose) Object.defineProperty(HTMLDialogElement.prototype, 'close', nativeClose);
  else delete HTMLDialogElement.prototype.close;
});
const resize = width => act(() => {
  shellWidth = width;
  observers.forEach(observer => observer.callback([{ target: observer.target, contentRect: { width } }]));
});
const defaults = {
  projectName: 'Immune cohort', analysisName: 'Treatment response', documentTitle: 'Donor comparison.R',
  outline: <button id="document-one">Donor comparison.R</button>,
  children: <label>Research note<textarea defaultValue="Unpublished observation" /></label>,
};

describe('common analysis shell', () => {
  it('shows actual context, caller actions and status without inventing runtime or result controls', () => {
    const overview = vi.fn(), save = vi.fn();
    render(<AnalysisShell {...defaults} onOpenOverview={overview} status={<span>Draft edited</span>} toolbar={<button onClick={save}>Save document</button>} />);
    expect(screen.getByRole('heading', { level: 2, name: 'Donor comparison.R' })).toBeVisible();
    expect(screen.getByText('Immune cohort')).toBeVisible();
    expect(screen.getByText('Treatment response')).toBeVisible();
    expect(screen.getByText('Draft edited')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Analysis overview' })); expect(overview).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Save document' })); expect(save).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('complementary')).toBeNull();
    expect(screen.queryByRole('button', { name: /run|result|compute/i })).toBeNull();
    expect(screen.getByRole('region', { name: 'Document work area' })).toHaveAttribute('tabindex', '0');
  });

  it('keeps one outline and the same mounted work area through compact disclosure and resize', () => {
    const mounted = vi.fn(), unmounted = vi.fn();
    function Draft() {
      useEffect(() => { mounted(); return unmounted; }, []);
      return <textarea aria-label="Unsaved source" defaultValue="cells <- ncol(object)" />;
    }
    render(<AnalysisShell {...defaults}><Draft /></AnalysisShell>);
    const source = screen.getByRole('textbox', { name: 'Unsaved source' });
    fireEvent.change(source, { target: { value: 'cells <- ncol(object) + 1' } });
    expect(screen.getAllByRole('navigation', { name: 'Documents and sections' })).toHaveLength(1);
    expect(document.querySelectorAll('#document-one')).toHaveLength(1);
    const disclosure = screen.getByText('Documents and sections').closest('details');
    expect(disclosure.open).toBe(true);
    resize(500);
    expect(disclosure.open).toBe(false);
    const summary = screen.getByText('Documents and sections');
    act(() => { disclosure.open = true; fireEvent(disclosure, new Event('toggle')); });
    expect(disclosure.open).toBe(true);
    fireEvent.keyDown(within(disclosure).getByRole('button', { name: 'Donor comparison.R' }), { key: 'Escape' });
    expect(disclosure.open).toBe(false); expect(summary).toHaveFocus();
    resize(1200);
    expect(disclosure.open).toBe(true);
    expect(screen.getByRole('textbox', { name: 'Unsaved source' })).toBe(source);
    expect(source).toHaveValue('cells <- ncol(object) + 1');
    expect(mounted).toHaveBeenCalledOnce(); expect(unmounted).not.toHaveBeenCalled();
    expect(document.querySelectorAll('#document-one')).toHaveLength(1);
  });

  it('chooses inspector modality using shell width rather than the browser width', () => {
    vi.stubGlobal('innerWidth', 1600);
    render(<AnalysisShell {...defaults} inspectorTitle="Saved table" inspector={<p>Exact retained rows</p>} onCloseInspector={vi.fn()} />);
    const panel = screen.getByRole('complementary', { name: 'Saved table' });
    const content = screen.getByText('Exact retained rows');
    expect(showModal).not.toHaveBeenCalled(); expect(panel).toHaveAttribute('open');
    resize(800);
    expect(screen.getByRole('dialog', { name: 'Saved table' })).toBe(panel);
    expect(panel).toHaveAttribute('aria-modal', 'true');
    expect(showModal).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Close inspector' })).toHaveFocus();
    resize(850);
    expect(showModal).toHaveBeenCalledOnce();
    resize(1150);
    expect(screen.getByRole('complementary', { name: 'Saved table' })).toBe(panel);
    expect(panel).not.toHaveAttribute('aria-modal');
    expect(screen.getByText('Exact retained rows')).toBe(content);
    expect(close).toHaveBeenCalled();
  });

  it('uses native modal open/cancel and returns focus to the actual opener without losing a draft', () => {
    shellWidth = 600;
    function Workspace() {
      const [inspecting, setInspecting] = useState(false);
      return <AnalysisShell {...defaults} inspector={inspecting ? <button>Inspect a row</button> : null}
        inspectorTitle="Selected table" onCloseInspector={() => setInspecting(false)}
        toolbar={<button onClick={() => setInspecting(true)}>Inspect saved table</button>} />;
    }
    render(<Workspace />);
    const source = screen.getByRole('textbox', { name: 'Research note' });
    fireEvent.change(source, { target: { value: 'Keep this draft' } });
    const opener = screen.getByRole('button', { name: 'Inspect saved table' });
    opener.focus(); fireEvent.click(opener);
    const panel = screen.getByRole('dialog', { name: 'Selected table' });
    expect(showModal).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Close inspector' })).toHaveFocus();
    fireEvent(panel, new Event('cancel', { cancelable: true }));
    expect(screen.queryByRole('dialog')).toBeNull(); expect(opener).toHaveFocus();
    expect(source).toHaveValue('Keep this draft');
    fireEvent.click(opener);
    fireEvent.click(screen.getByRole('button', { name: 'Close inspector' }));
    expect(screen.queryByRole('dialog')).toBeNull(); expect(opener).toHaveFocus();
  });

  it('does not open a modal for a hidden workspace and disconnects observation on unmount', () => {
    shellWidth = 0;
    const ui = render(<AnalysisShell {...defaults} inspector={<p>Private preview</p>} onCloseInspector={vi.fn()} />);
    expect(showModal).not.toHaveBeenCalled();
    resize(500); expect(showModal).toHaveBeenCalledOnce();
    resize(0); expect(close).toHaveBeenCalledOnce();
    const observer = observers[0];
    ui.unmount(); expect(observer.disconnect).toHaveBeenCalledOnce();
  });

  it('keeps independently mounted shell control IDs unique', () => {
    const { container } = render(<><AnalysisShell {...defaults} outline={<button>Document A</button>} inspector={<p>Preview A</p>} />
      <AnalysisShell {...defaults} outline={<button>Document B</button>} inspector={<p>Preview B</p>} /></>);
    const ids = [...container.querySelectorAll('[id]')].map(element => element.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(screen.getAllByRole('navigation', { name: 'Documents and sections' })).toHaveLength(2);
  });

  it('closes compact outline actions and reveals the work area without stealing new form autofocus', () => {
    shellWidth = 500;
    const frames = [];
    vi.stubGlobal('requestAnimationFrame', callback => { frames.push(callback); return frames.length; });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    function Workspace() {
      const [creating, setCreating] = useState(false);
      return <AnalysisShell {...defaults} outline={<><button onClick={() => {}}>Open document</button><button onClick={() => setCreating(true)}>New notebook</button></>}>
        {creating && <input aria-label="New notebook name" autoFocus />}
        <textarea aria-label="Retained draft" defaultValue="Original source" />
      </AnalysisShell>;
    }
    render(<Workspace />);
    const area = screen.getByRole('region', { name: 'Document work area' });
    const source = screen.getByRole('textbox', { name: 'Retained draft' });
    fireEvent.change(source, { target: { value: 'Edited source' } }); area.scrollTop = 300;
    const disclosure = screen.getByText('Documents and sections').closest('details');
    act(() => { disclosure.open = true; fireEvent(disclosure, new Event('toggle')); });
    const open = screen.getByRole('button', { name: 'Open document' }); open.focus(); fireEvent.click(open);
    act(() => frames.splice(0).forEach(callback => callback()));
    expect(disclosure.open).toBe(false); expect(area.scrollTop).toBe(0); expect(area).toHaveFocus();
    expect(screen.getByRole('textbox', { name: 'Retained draft' })).toBe(source); expect(source).toHaveValue('Edited source');
    act(() => { disclosure.open = true; fireEvent(disclosure, new Event('toggle')); });
    fireEvent.click(screen.getByRole('button', { name: 'New notebook' }));
    act(() => frames.splice(0).forEach(callback => callback()));
    expect(disclosure.open).toBe(false);
    expect(screen.getByRole('textbox', { name: 'New notebook name' })).toHaveFocus();
    expect(source).toHaveValue('Edited source');
  });

  it('returns a compact-outline inspector opener to the visible work area when its disclosure has closed', () => {
    shellWidth = 500;
    function Workspace() {
      const [inspecting, setInspecting] = useState(false);
      return <AnalysisShell {...defaults} outline={<button onClick={() => setInspecting(true)}>Linked material</button>}
        inspector={inspecting ? <p>Saved rows</p> : null} inspectorTitle="Saved rows" onCloseInspector={() => setInspecting(false)} />;
    }
    render(<Workspace />);
    const disclosure = screen.getByText('Documents and sections').closest('details');
    act(() => { disclosure.open = true; fireEvent(disclosure, new Event('toggle')); });
    const opener = screen.getByRole('button', { name: 'Linked material' }); opener.focus(); fireEvent.click(opener);
    expect(disclosure.open).toBe(false);
    expect(screen.getByRole('dialog', { name: 'Saved rows' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Close inspector' }));
    expect(screen.getByRole('region', { name: 'Document work area' })).toHaveFocus();
  });
});
