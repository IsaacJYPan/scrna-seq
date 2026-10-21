import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { EditorView } from '@codemirror/view';
import { exportNotebookFile, importNotebookFile, NOTEBOOK_INTERCHANGE_LIMITS } from '../../shared/notebookInterchange.mjs';
import NotebookImport from './NotebookImport';

const encoder = new TextEncoder();
const notebook = (metadata = { kernelspec: { name: 'ir', display_name: 'R', language: 'R' } }) => ({
  nbformat: 4, nbformat_minor: 5, metadata,
  cells: [
    { id: 'code_cell', cell_type: 'code', source: ['# μ cells\r\n', 'ncol(obj)  \r\n'], execution_count: 8, metadata: { trusted: true }, outputs: [
      { output_type: 'display_data', data: { 'text/html': '<script>run()</script>', 'text/plain': '12' }, metadata: {} },
    ] },
    { id: 'markdown_cell', cell_type: 'markdown', source: '![local](attachment:plot.svg)', metadata: {}, attachments: { 'plot.svg': { 'image/svg+xml': '<svg onload="run()" />' } } },
    { id: 'raw_cell', cell_type: 'raw', source: 'untouched raw', metadata: { format: 'text/plain' } },
  ],
});
const fileFor = (name = 'cell-analysis.ipynb', value = JSON.stringify(notebook())) => {
  const bytes = typeof value === 'string' ? encoder.encode(value) : value;
  const file = new File([bytes], name, { type: 'application/x-ipynb+json' });
  Object.defineProperty(file, 'arrayBuffer', { configurable: true, value: vi.fn(async () => bytes.slice().buffer) });
  return file;
};
const choose = file => fireEvent.change(screen.getByLabelText('Notebook file', { exact: true }), { target: { files: [file] } });
const toggle = (summary, open = true) => {
  const details = summary.closest('details');
  details.open = open; fireEvent(details, new Event('toggle'));
};
beforeAll(() => {
  if (!Range.prototype.getClientRects) Range.prototype.getClientRects = () => [];
  if (!Range.prototype.getBoundingClientRect) Range.prototype.getBoundingClientRect = () => ({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('notebook import preparation', () => {
  it('previews exact source and quarantined historical contents before explicit admission', async () => {
    const onImport = vi.fn().mockResolvedValue(null), source = `\uFEFF${JSON.stringify(notebook())}`, file = fileFor('cell-analysis.ipynb', source);
    render(<NotebookImport onImport={onImport} onCancel={vi.fn()} theme="dark" />);
    expect(screen.getByText(/Source, retained outputs, attachments and metadata will be shared/)).toBeVisible();
    choose(file);
    const preview = await screen.findByRole('region', { name: 'Notebook import preview' });
    expect(within(preview).getByText('3 total · 1 code · 1 Markdown · 1 raw')).toBeVisible();
    expect(within(preview).getByText('1 historical outputs · 1 attachments')).toBeVisible();
    expect(within(preview).getByText(/not a captured in-app run and may not match/)).toBeVisible();
    expect(within(preview).getByText(/retained for export but must not execute/)).toBeVisible();
    expect(screen.queryByRole('textbox', { name: 'Notebook import cell 1 source' })).toBeNull();
    toggle(screen.getByText('Review notebook source'));
    toggle(screen.getByText('Cell 1 · R'));
    const sourceBox = await screen.findByRole('textbox', { name: 'Notebook import cell 1 source' });
    const editor = EditorView.findFromDOM(sourceBox);
    expect(editor.state.sliceDoc()).toBe('# μ cells\r\nncol(obj)  \r\n');
    expect(editor.state.facet(EditorView.darkTheme)).toBe(true);
    expect(sourceBox).toHaveAttribute('contenteditable', 'false');
    expect(document.querySelector('script,iframe,img')).toBeNull();
    expect(onImport).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('textbox', { name: 'Notebook document title' }), { target: { value: 'Donor cell inspection' } });
    fireEvent.click(screen.getByRole('button', { name: 'Import notebook', exact: true }));
    await waitFor(() => expect(onImport).toHaveBeenCalledOnce());
    const admitted = onImport.mock.calls[0][0];
    expect(admitted).toMatchObject({ filename: 'cell-analysis.ipynb', title: 'Donor cell inspection' });
    const exported = JSON.parse(exportNotebookFile(admitted.content).text);
    expect(exported.cells[0]).toEqual({ ...notebook().cells[0], source: '# μ cells\r\nncol(obj)  \r\n' });
    expect(exported.cells[1].attachments).toEqual(notebook().cells[1].attachments);
    expect(file.name).toBe('cell-analysis.ipynb');
  });

  it('requires an editing language when declarations are unsupported and retains the original kernel', async () => {
    const onImport = vi.fn(), original = notebook({ kernelspec: { name: 'julia', display_name: 'Julia', language: 'julia' } });
    render(<NotebookImport onImport={onImport} onCancel={vi.fn()} />);
    choose(fileFor('unsupported.ipynb', JSON.stringify(original)));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Choose R or python for source editing/);
    expect(screen.queryByRole('region', { name: 'Notebook import preview' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Import notebook', exact: true })).toBeDisabled();
    fireEvent.change(screen.getByRole('combobox', { name: 'Notebook import editing language' }), { target: { value: 'python' } });
    const preview = await screen.findByRole('region', { name: 'Notebook import preview' });
    expect(within(preview).getByText('Julia · imported metadata')).toBeVisible();
    expect(within(preview).getByText(/selected editing language does not replace/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Import notebook', exact: true }));
    await waitFor(() => expect(onImport).toHaveBeenCalledOnce());
    expect(onImport.mock.calls[0][0].content.defaultLanguage).toBe('python');
    expect(onImport.mock.calls[0][0].content.interchange.metadata).toEqual(original.metadata);
    expect(onImport.mock.calls[0][0].content.cells[0].source).toBe(original.cells[0].source.join(''));
  });

  it('keeps the same preview and source after a failed admission without exposing raw network details', async () => {
    const onImport = vi.fn().mockRejectedValue(new Error('https://private.example/secret?token=bad'));
    render(<NotebookImport onImport={onImport} onCancel={vi.fn()} />);
    choose(fileFor()); await screen.findByRole('region', { name: 'Notebook import preview' });
    fireEvent.click(screen.getByRole('button', { name: 'Import notebook', exact: true }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The import could not be confirmed. Your notebook preview is kept here.');
    expect(screen.queryByText(/private\.example/)).toBeNull();
    expect(screen.getByRole('region', { name: 'Notebook import preview' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Import notebook', exact: true }));
    await waitFor(() => expect(onImport).toHaveBeenCalledTimes(2));
    expect(onImport.mock.calls[1][0].content).toBe(onImport.mock.calls[0][0].content);
  });

  it('recovers an admitted pending import without changing its exact content, filename or title', async () => {
    const content = importNotebookFile({ filename: 'frozen.ipynb', source: JSON.stringify(notebook()) }).content;
    const pending = { filename: 'frozen.ipynb', title: 'Fixed admitted title', content }, onImport = vi.fn().mockResolvedValue(null), cancel = vi.fn();
    render(<NotebookImport pending={pending} onImport={onImport} onCancel={cancel} error="Reconnect to confirm this notebook." />);
    expect(screen.getByRole('textbox', { name: 'Notebook document title' })).toHaveValue(pending.title);
    expect(screen.getByRole('textbox', { name: 'Notebook document title' })).toBeDisabled();
    expect(screen.getByLabelText('Notebook file', { exact: true })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    choose(fileFor('other.ipynb')); fireEvent.change(screen.getByRole('textbox', { name: 'Notebook document title' }), { target: { value: 'Wrong' } });
    fireEvent.click(screen.getByRole('button', { name: 'Retry import' }));
    await waitFor(() => expect(onImport).toHaveBeenCalledExactlyOnceWith(pending));
    expect(onImport.mock.calls[0][0].content).toBe(content);
    expect(cancel).not.toHaveBeenCalled();
  });

  it('rejects inconsistent pending payloads and never replaces recovery with a new import', () => {
    const content = importNotebookFile({ filename: 'frozen.ipynb', source: JSON.stringify(notebook()) }).content, onImport = vi.fn();
    render(<NotebookImport pending={{ filename: 'wrong.ipynb', title: 'Frozen', content }} onImport={onImport} onCancel={vi.fn()} />);
    expect(screen.getByRole('alert')).toHaveTextContent(/pending notebook preview is unavailable/);
    expect(screen.getByRole('button', { name: 'Retry import' })).toBeDisabled();
    expect(onImport).not.toHaveBeenCalled();
  });

  it.each([
    ['source.R', encoder.encode('{}'), /Choose a portable .ipynb filename/],
    ['invalid.ipynb', new Uint8Array([0xc3, 0x28]), /not valid UTF-8/],
    ['broken.ipynb', encoder.encode('{"nbformat":'), /valid JSON/],
    ['unknown.ipynb', encoder.encode('{"nbformat":5,"nbformat_minor":0,"metadata":{},"cells":[]}'), /nbformat 4/],
    ['huge.ipynb', new Uint8Array(NOTEBOOK_INTERCHANGE_LIMITS.fileBytes + 1), /at most 2 MiB/],
  ])('rejects %s without admitting or replacing a notebook', async (filename, bytes, message) => {
    const onImport = vi.fn(), file = fileFor(filename, bytes);
    render(<NotebookImport onImport={onImport} onCancel={vi.fn()} />);
    choose(file);
    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(screen.queryByRole('region', { name: 'Notebook import preview' })).toBeNull();
    expect(onImport).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Import notebook', exact: true })).toBeDisabled();
    if (filename === 'huge.ipynb' || filename === 'source.R') expect(file.arrayBuffer).not.toHaveBeenCalled();
  });

  it('checks actual read bytes when a file reports a smaller size', async () => {
    const file = fileFor(); Object.defineProperty(file, 'arrayBuffer', { value: vi.fn(async () => new ArrayBuffer(NOTEBOOK_INTERCHANGE_LIMITS.fileBytes + 1)) });
    render(<NotebookImport onImport={vi.fn()} onCancel={vi.fn()} />); choose(file);
    expect(await screen.findByRole('alert')).toHaveTextContent(/at most 2 MiB/);
  });

  it('ignores a late older read and supports FileReader-only browsers', async () => {
    let finish;
    const slow = fileFor('old.ipynb'); Object.defineProperty(slow, 'arrayBuffer', { value: () => new Promise(resolve => { finish = resolve; }) });
    render(<NotebookImport onImport={vi.fn()} onCancel={vi.fn()} />); choose(slow);
    const current = new File([JSON.stringify(notebook())], 'current.ipynb'); Object.defineProperty(current, 'arrayBuffer', { value: undefined });
    choose(current); await screen.findByRole('region', { name: 'Notebook import preview' });
    await act(async () => finish(encoder.encode(JSON.stringify(notebook())).buffer));
    expect(screen.getByRole('textbox', { name: 'Notebook document title' })).toHaveValue('current');
    expect(screen.queryByText('old.ipynb')).toBeNull();
  });

  it('discards a file read when an admitted pending request arrives during preparation', async () => {
    let finish;
    const slow = fileFor('unadmitted.ipynb'); Object.defineProperty(slow, 'arrayBuffer', { value: () => new Promise(resolve => { finish = resolve; }) });
    const onImport = vi.fn().mockResolvedValue(null), pending = { filename: 'frozen.ipynb', title: 'Already admitted', content: importNotebookFile({ filename: 'frozen.ipynb', source: JSON.stringify(notebook()) }).content };
    const ui = render(<NotebookImport onImport={onImport} onCancel={vi.fn()} />); choose(slow);
    ui.rerender(<NotebookImport pending={pending} onImport={onImport} onCancel={vi.fn()} />);
    await act(async () => finish(encoder.encode(JSON.stringify(notebook())).buffer));
    expect(screen.getByRole('textbox', { name: 'Notebook document title' })).toHaveValue('Already admitted');
    expect(screen.queryByText('unadmitted.ipynb')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry import' }));
    await waitFor(() => expect(onImport).toHaveBeenCalledExactlyOnceWith(pending));
  });

  it('prevents concurrent admission and disables preparation while the parent is busy', async () => {
    let finish; const onImport = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    const ui = render(<NotebookImport onImport={onImport} onCancel={vi.fn()} />);
    choose(fileFor()); await screen.findByRole('region', { name: 'Notebook import preview' });
    fireEvent.submit(screen.getByRole('form', { name: 'Import notebook' })); fireEvent.submit(screen.getByRole('form', { name: 'Import notebook' }));
    expect(onImport).toHaveBeenCalledOnce(); expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    await act(async () => finish(null));
    ui.rerender(<NotebookImport onImport={onImport} onCancel={vi.fn()} busy />);
    expect(screen.getByLabelText('Notebook file', { exact: true })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Importing…' })).toBeDisabled();
  });
});
