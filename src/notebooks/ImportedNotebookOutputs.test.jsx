import React from 'react';
import ReactMarkdown from 'react-markdown';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ImportedNotebookOutputs, { ImportedNotebookMimeView } from './ImportedNotebookOutputs';
import { CellNotebookImage, notebookAttachmentBundle, notebookMarkdownComponents, notebookMarkdownUrlTransform } from './NotebookAttachment';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const raster = { 'image/png': png };
const display = data => ({ output_type: 'display_data', data, metadata: {} });
const cell = outputs => ({ id: 'imported_cell', source: 'edited_source()', imported: { metadata: {}, executionCount: 9, outputs } });
const toggle = (text, open = true) => {
  const details = screen.getByText(text).closest('details'); details.open = open; fireEvent(details, new Event('toggle'));
};
beforeEach(() => {
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:inert-local-preview') });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('historical notebook output preview', () => {
  it('labels execution counts as historical even after source edits and mounts individual outputs lazily', () => {
    const original = cell([{ output_type: 'stream', name: 'stdout', text: '<img src="https://outside.invalid/a">\n12 cells' }]);
    const ui = render(<ImportedNotebookOutputs cell={original} />);
    expect(screen.getByText(/not a captured in-app run and may not match the current source/)).toBeVisible();
    expect(screen.getByText('Historical cell execution count: 9')).toBeVisible();
    expect(screen.queryByText(/12 cells/)).toBeNull();
    toggle('Imported results · 1 outputs · 0 attachments');
    expect(screen.queryByText(/12 cells/)).toBeNull();
    toggle('Output 1 · stream');
    expect(screen.getByText(/12 cells/)).toHaveTextContent('<img src="https://outside.invalid/a">');
    expect(document.querySelector('img')).toBeNull();
    ui.rerender(<ImportedNotebookOutputs cell={{ ...original, source: 'different_source()' }} />);
    expect(screen.getByText(/may not match the current source/)).toBeVisible();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('renders errors and JSON as escaped text without creating executable rich content', () => {
    render(<ImportedNotebookOutputs cell={cell([
      { output_type: 'error', ename: '<script>', evalue: '<iframe src="x">', traceback: ['trace <img src="x">'] },
      display({ 'application/json': { html: '<svg onload="bad()">', values: [1, 2] }, 'text/html': '<iframe src="https://outside.invalid" />' }),
    ])} />);
    toggle('Imported results · 2 outputs · 0 attachments'); toggle('Output 1 · error'); toggle('Output 2 · display_data');
    expect(screen.getByText(/Historical error; this is not a new execution failure/)).toBeVisible();
    expect(screen.getByText(/trace <img/)).toHaveTextContent('<script>: <iframe');
    expect(JSON.parse(screen.getByText(/"html":/).textContent).html).toBe('<svg onload="bad()">');
    expect(document.querySelector('script,iframe,img,svg,object,embed')).toBeNull();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('retains unsupported HTML/SVG/widget and URL representations without requesting resources', () => {
    const data = { 'text/html': '<script>fetch("https://outside.invalid")</script>', 'image/svg+xml': '<svg/>', 'application/vnd.jupyter.widget-view+json': { model_id: 'remote' }, 'text/uri-list': 'https://outside.invalid/a.png' };
    const untouched = JSON.stringify(data);
    render(<ImportedNotebookOutputs cell={cell([display(data)])} />);
    toggle('Imported results · 1 outputs · 0 attachments'); toggle('Output 1 · display_data');
    expect(screen.getByText(/no supported safe browser preview/)).toBeVisible();
    expect(screen.getByText(/Retained representations:/)).toHaveTextContent('application/vnd.jupyter.widget-view+json');
    expect(document.querySelector('script,iframe,img,svg,a,object,embed')).toBeNull();
    expect(JSON.stringify(data)).toBe(untouched); expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('creates bounded raster object URLs only on request and revokes on close and unmount', async () => {
    const ui = render(<ImportedNotebookOutputs cell={cell([display(raster)])} />);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    toggle('Imported results · 1 outputs · 0 attachments'); expect(URL.createObjectURL).not.toHaveBeenCalled();
    toggle('Output 1 · display_data');
    const image = await screen.findByRole('img', { name: 'Imported image' });
    expect(image).toHaveAttribute('src', 'blob:inert-local-preview');
    expect(image).toHaveClass('bg-white'); expect(image).toHaveAttribute('width', '1');
    expect(URL.createObjectURL).toHaveBeenCalledOnce();
    expect(URL.createObjectURL.mock.calls[0][0]).toBeInstanceOf(Blob);
    toggle('Output 1 · display_data', false);
    expect(screen.queryByRole('img')).toBeNull(); expect(URL.revokeObjectURL).toHaveBeenCalledOnce();
    toggle('Output 1 · display_data'); await screen.findByRole('img');
    ui.unmount(); expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
  });

  it('falls back on actual browser decode failure and revokes only once', async () => {
    const ui = render(<ImportedNotebookMimeView bundle={raster} />);
    fireEvent.error(await screen.findByRole('img'));
    expect(screen.getByText(/browser could not display this imported image/)).toBeVisible();
    expect(screen.queryByRole('img')).toBeNull(); expect(URL.revokeObjectURL).toHaveBeenCalledOnce();
    ui.unmount(); expect(URL.revokeObjectURL).toHaveBeenCalledOnce();
  });

  it('releases a previous image when the source document changes and resets open output state', async () => {
    const ui = render(<ImportedNotebookOutputs cell={cell([display(raster)])} scopeKey="doc_a:cell" />);
    toggle('Imported results · 1 outputs · 0 attachments'); toggle('Output 1 · display_data'); await screen.findByRole('img');
    ui.rerender(<ImportedNotebookOutputs cell={cell([display(raster)])} scopeKey="doc_b:cell" />);
    expect(screen.queryByRole('img')).toBeNull(); expect(URL.revokeObjectURL).toHaveBeenCalledOnce();
    expect(screen.queryByText('Output 1 · display_data')).toBeNull();
  });

  it('bounds text previews without mutating the full export payload', () => {
    const text = 'μ'.repeat(40000), source = cell([{ output_type: 'stream', name: 'stderr', text }]);
    render(<ImportedNotebookOutputs cell={source} />);
    toggle('Imported results · 1 outputs · 0 attachments'); toggle('Output 1 · stream');
    const pre = document.querySelector('pre'); expect(new TextEncoder().encode(pre.textContent).length).toBeLessThanOrEqual(64 * 1024);
    expect(screen.getByText(/complete imported value is retained/)).toBeVisible();
    expect(source.imported.outputs[0].text).toBe(text);
  });

  it('paginates output summaries and creates no previews for unopened items', () => {
    render(<ImportedNotebookOutputs cell={cell(Array.from({ length: 24 }, () => display(raster)))} />);
    expect(document.querySelectorAll('details')).toHaveLength(1);
    toggle('Imported results · 24 outputs · 0 attachments');
    expect(document.querySelectorAll('details')).toHaveLength(11);
    expect(screen.queryByText('Output 11 · display_data')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show next 10 imported items' }));
    expect(screen.getByText('Output 20 · display_data')).toBeVisible();
    expect(screen.queryByText('Output 21 · display_data')).toBeNull();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('handles malformed output or raster safely and does not claim verified image integrity', () => {
    render(<ImportedNotebookOutputs cell={cell([{ output_type: 'new_executable_kind' }, display({ 'image/png': 'not-base64' })])} />);
    toggle('Imported results · 2 outputs · 0 attachments'); toggle('Output 1 · unavailable'); toggle('Output 2 · display_data');
    expect(screen.getByText(/cannot be previewed safely/)).toBeVisible(); expect(screen.getByText(/no supported safe browser preview/)).toBeVisible();
    expect(URL.createObjectURL).not.toHaveBeenCalled(); expect(screen.queryByText(/verified/i)).toBeNull();
  });
});

describe('cell-local notebook attachments', () => {
  it('resolves exact local keys first, then a single URI decode without plus conversion', () => {
    const attachments = { 'plot space.png': raster, 'a+b.png': raster, 'literal%20name.png': { 'text/plain': 'literal key wins' }, 'literal name.png': raster };
    expect(notebookAttachmentBundle('attachment:plot%20space.png', attachments)).toBe(raster);
    expect(notebookAttachmentBundle('attachment:a+b.png', attachments)).toBe(raster);
    expect(notebookAttachmentBundle('attachment:literal%20name.png', attachments)).toBe(attachments['literal%20name.png']);
    expect(notebookAttachmentBundle('attachment:plot%2520space.png', attachments)).toBeNull();
    expect(notebookAttachmentBundle('attachment:bad%escape', attachments)).toBeNull();
    expect(notebookAttachmentBundle('attachment:toString', {})).toBeNull();
    const getter = vi.fn(); expect(notebookAttachmentBundle('attachment:secret', Object.defineProperty({}, 'secret', { get: getter }))).toBeNull(); expect(getter).not.toHaveBeenCalled();
  });

  it('integrates ordinary Markdown attachments with an explicit lazy preview and no remote images', async () => {
    const source = '![Cell image](attachment:plot%20space.png)\n\n![Remote](https://outside.invalid/a.png)\n\n<img src="https://outside.invalid/b.png">';
    const ui = render(<ReactMarkdown skipHtml urlTransform={notebookMarkdownUrlTransform} components={notebookMarkdownComponents({ 'plot space.png': raster })}>{source}</ReactMarkdown>);
    expect(screen.getByText(/Image reference: Remote/)).toBeVisible(); expect(screen.queryByRole('img')).toBeNull(); expect(URL.createObjectURL).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Preview imported attachment: Cell image' }));
    expect(await screen.findByRole('img', { name: 'Cell image' })).toHaveAttribute('src', 'blob:inert-local-preview');
    expect(document.querySelector('p div,p pre,p figure')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Hide imported attachment: Cell image' }));
    expect(URL.revokeObjectURL).toHaveBeenCalledOnce(); ui.unmount();
  });

  it.each(['https://outside.invalid/a.png', 'data:image/png;base64,AAAA', 'blob:unknown', 'file:///private/image.png', 'javascript:alert(1)', 'attachment:missing.png'])('keeps %s inert', src => {
    render(<CellNotebookImage src={src} alt="Reference" attachments={{ 'real.png': raster }} />);
    expect(screen.getByText(/images are not loaded automatically/)).toBeVisible();
    expect(screen.queryByRole('img')).toBeNull(); expect(screen.queryByRole('button')).toBeNull(); expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('only uses attachments from the current cell and falls back for unsupported MIME', async () => {
    const ui = render(<CellNotebookImage src="attachment:local.svg" alt="diagram" attachments={{ 'local.svg': { 'image/svg+xml': '<svg onload="bad()"/>' } }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Preview imported attachment: diagram' }));
    expect(screen.getByText(/no supported safe browser preview/)).toBeVisible();
    expect(document.querySelector('svg,img')).toBeNull();
    ui.rerender(<CellNotebookImage src="attachment:other.png" alt="other" attachments={{ 'local.svg': raster }} />);
    await waitFor(() => expect(screen.queryByRole('button')).toBeNull());
    expect(screen.getByText(/Image reference: other/)).toBeVisible();
  });

  it('lists raw-cell attachments lazily without inventing an execution count', async () => {
    render(<ImportedNotebookOutputs cell={{ id: 'raw_cell', type: 'raw', imported: { metadata: {}, attachments: { 'local.png': raster } } }} />);
    expect(screen.queryByText(/Historical cell execution count/)).toBeNull();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    toggle('Imported results · 0 outputs · 1 attachments'); toggle('Attachment · local.png');
    expect(await screen.findByRole('img', { name: 'Imported attachment local.png' })).toHaveAttribute('src', 'blob:inert-local-preview');
  });
});
