import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { EditorView } from '@codemirror/view';
import { SCRIPT_FILE_LIMIT, exportScriptDocument, importScriptDocument } from '../../shared/scriptDocument.mjs';
import ScriptImport from './ScriptImport';

const encoder = new TextEncoder();
const pendingFor = (filename = 'frozen.py', source = 'print("saved")\r\n', title = 'Frozen Python source') => ({
  filename, title, content: importScriptDocument({ filename, bytes: new Uint8Array(encoder.encode(source)), cellId: 'frozen_cell' }),
});
const originalFile = (name, bytes) => {
  const data = typeof bytes === 'string' ? encoder.encode(bytes) : bytes;
  const file = new File([data], name, { type: 'text/plain' });
  Object.defineProperty(file, 'arrayBuffer', { configurable: true, value: vi.fn(async () => data.slice().buffer) });
  return file;
};
const choose = file => fireEvent.change(screen.getByLabelText('Script file', { exact: true }), { target: { files: [file] } });
const sourceView = () => EditorView.findFromDOM(screen.getByRole('textbox', { name: 'Script source preview' }));
beforeAll(() => {
  if (!Range.prototype.getClientRects) Range.prototype.getClientRects = () => [];
  if (!Range.prototype.getBoundingClientRect) Range.prototype.getBoundingClientRect = () => ({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('ordinary script import preparation', () => {
  it('previews R source, project sharing, BOM and exact bytes before the single explicit create action', async () => {
    const imported = vi.fn().mockResolvedValue({ id: 'saved_document' });
    const bytes = encoder.encode('\uFEFF# μ donor source\r\nsource("helpers/qc.R")  \r\n');
    const unchanged = bytes.slice();
    const file = originalFile('donor-analysis.R', bytes);
    render(<ScriptImport onImport={imported} onCancel={vi.fn()} />);
    expect(screen.getByRole('form', { name: 'Import script' })).toBeVisible();
    expect(screen.getByText(/Source will be shared with this project's members/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Import script', exact: true })).toBeDisabled();
    choose(file);
    const preview = await screen.findByRole('region', { name: 'Script preview' });
    expect(within(preview).getByText('donor-analysis.R')).toBeVisible();
    expect(within(preview).getByText('Preserved')).toBeVisible();
    expect(within(preview).getByText('CRLF')).toBeVisible();
    expect(within(preview).getByText(`${bytes.length.toLocaleString()} bytes`)).toBeVisible();
    expect(sourceView().state.sliceDoc()).toBe('# μ donor source\r\nsource("helpers/qc.R")  \r\n');
    expect(screen.getByRole('textbox', { name: 'Script source preview' })).toHaveAttribute('contenteditable', 'false');
    expect(within(preview).getByText(/Helper files and the surrounding folder are not uploaded/)).toBeVisible();
    expect(imported).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('textbox', { name: 'Script document title' }), { target: { value: 'Donor QC source' } });
    fireEvent.click(screen.getByRole('button', { name: 'Import script', exact: true }));
    await waitFor(() => expect(imported).toHaveBeenCalledOnce());
    const payload = imported.mock.calls[0][0];
    expect(payload).toMatchObject({ filename: 'donor-analysis.R', title: 'Donor QC source' });
    expect(exportScriptDocument(payload.content).bytes).toEqual(unchanged);
    expect(bytes).toEqual(unchanged);
    expect(file.name).toBe('donor-analysis.R');
  });

  it('retains a Python preview after asynchronous failure and passes the actual theme to its read-only editor', async () => {
    const imported = vi.fn().mockRejectedValue(new Error('Unexpected internal service detail'));
    render(<ScriptImport onImport={imported} theme="dark" onCancel={vi.fn()} />);
    choose(originalFile('summaries.py', 'from pathlib import Path\nprint("cells")\n'));
    await screen.findByRole('region', { name: 'Script preview' });
    const view = sourceView();
    expect(view.state.facet(EditorView.darkTheme)).toBe(true);
    expect(screen.getByText('Python', { exact: true })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Import script', exact: true }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The import could not be confirmed. Your script preview is kept here.');
    expect(sourceView()).toBe(view);
    expect(view.state.sliceDoc()).toBe('from pathlib import Path\nprint("cells")\n');
    expect(screen.getByRole('textbox', { name: 'Script document title' })).toHaveValue('summaries.py');
    expect(screen.getByRole('button', { name: 'Import script', exact: true })).toBeEnabled();
  });

  it('restores a frozen admitted import after remount and retries exactly that payload while file/title/cancel stay locked', async () => {
    const imported = vi.fn().mockResolvedValue(null), canceled = vi.fn(), pending = pendingFor();
    const ui = render(<ScriptImport pending={pending} onImport={imported} onCancel={canceled} error="Reconnect before confirming this import." />);
    expect(screen.getByRole('textbox', { name: 'Script document title' })).toHaveValue(pending.title);
    expect(screen.getByRole('textbox', { name: 'Script document title' })).toBeDisabled();
    expect(screen.getByLabelText('Script file', { exact: true })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('Reconnect before confirming this import.');
    choose(originalFile('wrong.R', 'wrong_source()'));
    fireEvent.change(screen.getByRole('textbox', { name: 'Script document title' }), { target: { value: 'Wrong title' } });
    fireEvent.click(screen.getByRole('button', { name: 'Retry import' }));
    await waitFor(() => expect(imported).toHaveBeenCalledExactlyOnceWith(pending));
    expect(canceled).not.toHaveBeenCalled();
    ui.rerender(<ScriptImport pending={pending} busy onImport={imported} onCancel={canceled} />);
    expect(screen.getByRole('button', { name: 'Importing…' })).toBeDisabled();
  });

  it('ignores a late file read after a newer file was selected', async () => {
    let finish;
    const slow = originalFile('old.R', 'old()');
    Object.defineProperty(slow, 'arrayBuffer', { configurable: true, value: vi.fn(() => new Promise(resolve => { finish = resolve; })) });
    const imported = vi.fn();
    render(<ScriptImport onImport={imported} onCancel={vi.fn()} />);
    choose(slow);
    expect(screen.getByRole('status')).toHaveTextContent('Reading script source');
    choose(originalFile('current.py', 'current = True\n'));
    await screen.findByRole('region', { name: 'Script preview' });
    await act(async () => finish(encoder.encode('old()').buffer));
    expect(screen.getByRole('textbox', { name: 'Script document title' })).toHaveValue('current.py');
    expect(sourceView().state.sliceDoc()).toBe('current = True\n');
    expect(screen.queryByText('old.R')).toBeNull();
    expect(imported).not.toHaveBeenCalled();
  });

  it.each([
    ['outside.ipynb', encoder.encode('{}'), /Choose an R \(\.R\) or Python \(\.py\) script/],
    ['legacy.R', new Uint8Array([0xc3, 0x28]), /not valid UTF-8/],
    ['binary.R', encoder.encode('x <- "\0"'), /without NUL/],
    ['huge.py', new Uint8Array(SCRIPT_FILE_LIMIT + 1), /exceeds the 256 KiB source limit/],
  ])('rejects unsupported or malformed %s before enabling creation', async (name, bytes, explanation) => {
    const imported = vi.fn(), file = originalFile(name, bytes);
    render(<ScriptImport onImport={imported} onCancel={vi.fn()} />);
    choose(file);
    expect(await screen.findByRole('alert')).toHaveTextContent(explanation);
    expect(screen.queryByRole('region', { name: 'Script preview' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Import script', exact: true })).toBeDisabled();
    expect(imported).not.toHaveBeenCalled();
    if (name === 'huge.py' || name === 'outside.ipynb') expect(file.arrayBuffer).not.toHaveBeenCalled();
  });

  it('keeps mixed source exact, discloses later editing behavior and supports FileReader-only implementations', async () => {
    const imported = vi.fn(), source = 'a <- 1\r\nb <- 2\nc <- 3\r';
    const file = new File([encoder.encode(source)], 'mixed.R', { type: 'text/plain' });
    Object.defineProperty(file, 'arrayBuffer', { value: undefined });
    render(<ScriptImport onImport={imported} onCancel={vi.fn()} />);
    choose(file);
    await screen.findByRole('region', { name: 'Script preview' });
    expect(screen.getByText(/Mixed line endings are preserved on import/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Import script', exact: true }));
    await waitFor(() => expect(imported).toHaveBeenCalledOnce());
    expect(new TextDecoder().decode(exportScriptDocument(imported.mock.calls[0][0].content).bytes)).toBe(source);
  });

  it('prevents duplicate submission and cancels preparation without any import request', async () => {
    let confirm;
    const imported = vi.fn(() => new Promise(resolve => { confirm = resolve; })), canceled = vi.fn();
    render(<ScriptImport onImport={imported} onCancel={canceled} />);
    choose(originalFile('cells.R', 'ncol(object)'));
    await screen.findByRole('region', { name: 'Script preview' });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(canceled).toHaveBeenCalledOnce(); expect(imported).not.toHaveBeenCalled();
    const submit = screen.getByRole('button', { name: 'Import script', exact: true });
    fireEvent.click(submit); fireEvent.click(submit);
    expect(imported).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    await act(async () => confirm(null));
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
  });

  it('requires a nonblank bounded title and respects externally disabled creation', async () => {
    const imported = vi.fn();
    const ui = render(<ScriptImport onImport={imported} onCancel={vi.fn()} />);
    choose(originalFile(`${'a'.repeat(170)}.R`, '1 + 1'));
    const title = await screen.findByRole('textbox', { name: 'Script document title' });
    expect(title).toHaveAttribute('maxlength', '160'); expect(title.value).toHaveLength(160);
    fireEvent.change(title, { target: { value: '   ' } });
    expect(screen.getByRole('button', { name: 'Import script', exact: true })).toBeDisabled();
    fireEvent.change(title, { target: { value: 'Imported script' } });
    ui.rerender(<ScriptImport onImport={imported} onCancel={vi.fn()} disabled />);
    expect(screen.getByRole('button', { name: 'Import script', exact: true })).toBeDisabled();
    expect(screen.getByLabelText('Script file', { exact: true })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
    expect(imported).not.toHaveBeenCalled();
  });

  it('shows the newly selected file validation problem ahead of an earlier submission error', async () => {
    render(<ScriptImport onImport={vi.fn()} onCancel={vi.fn()} error="An earlier import could not be confirmed." />);
    choose(originalFile('wrong-encoding.R', new Uint8Array([0xc3, 0x28])));
    expect(await screen.findByRole('alert')).toHaveTextContent(/not valid UTF-8/);
    expect(screen.getByRole('button', { name: 'Import script', exact: true })).toBeDisabled();
  });
});
