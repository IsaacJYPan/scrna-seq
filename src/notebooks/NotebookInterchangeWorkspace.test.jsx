import React from 'react';
import { createHash } from 'node:crypto';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import NotebookWorkspace from './NotebookWorkspace';
import * as api from './notebookApi';
import { installNotebookJournalFixture } from './notebookPending.testFixture';
import { canonicalNotebookContent } from '../../shared/notebookDocument.mjs';
import { importNotebookFile, exportNotebookFile } from '../../shared/notebookInterchange.mjs';

vi.mock('./notebookApi', () => ({
  createNotebook: vi.fn(), getNotebook: vi.fn(), getNotebookVersion: vi.fn(), listNotebooks: vi.fn(), saveNotebook: vi.fn(),
  getNotebookDraft: vi.fn(), saveNotebookDraft: vi.fn(), clearNotebookDraft: vi.fn(),
  getNotebookPending: vi.fn(), admitNotebookPending: vi.fn(), submitNotebookPending: vi.fn(),
}));
const clone = value => structuredClone(value);
const encoder = new TextEncoder();
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const outsideNotebook = (language = 'R') => ({ nbformat: 4, nbformat_minor: 5,
  metadata: { kernelspec: { name: language === 'R' ? 'ir' : 'python3', display_name: language, language },
    traceomics: { kind: 'script', script: { filename: 'untrusted.R' } }, collaborator: { opaque: ['retain', 3] } },
  cells: [
    { id: 'code_cell', cell_type: 'code', source: language === 'R' ? ['ncol(obj)  \r\n', '# retained\r\n'] : ['len(cells)\r\n'], metadata: { collapsed: true, custom: 'original' }, execution_count: 12,
      outputs: [{ output_type: 'display_data', data: { 'text/plain': 'SAVED historical result', 'text/html': '<script>window.externalExecuted=true</script>', 'application/vnd.jupyter.widget-view+json': { model_id: 'inert' } }, metadata: { isolated: true } }] },
    { id: 'raw_cell', cell_type: 'raw', source: '<img src="https://outside.invalid/raw">\nuntouched raw', metadata: { format: 'text/html' } },
    { id: 'markdown_cell', cell_type: 'markdown', source: '## Donor results\n\n![Local plot](attachment:plot%20space.png)\n\n![Remote plot](https://outside.invalid/remote.png)', metadata: { tag: 'notes' },
      attachments: { 'plot space.png': { 'image/png': png } } },
  ] });
const importedContent = (language = 'R', filename = 'donor-analysis.ipynb') => importNotebookFile({ filename, source: JSON.stringify(outsideNotebook(language)) }).content;
const defaults = { projectId: 'project_one', projectName: 'Immune cohort', analysis: { id: 'analysis_one', name: 'Donor research', status: 'active', references: [] },
  role: 'analyst', userId: 1, theme: 'light', isActive: true, connection: { blocked: false } };
const documentFor = (content = importedContent(), digit = 'a', version = 1) => ({
  id: `doc_${digit.repeat(24)}`, projectId: defaults.projectId, analysisId: defaults.analysis.id, title: 'Imported donor notebook', version,
  versionId: `dv_${digit.repeat(22)}${String(version).padStart(2, '0')}`, sha256: createHash('sha256').update(canonicalNotebookContent(content)).digest('hex'), content,
});
const head = document => ({ id: document.id, title: document.title, version: document.version, versionId: document.versionId, sha256: document.sha256,
  projectId: document.projectId, analysisId: document.analysisId, cellCount: document.content.cells.length, defaultLanguage: document.content.defaultLanguage, documentKind: 'notebook' });
const fileFor = (name, value) => {
  const bytes = encoder.encode(value), file = new File([bytes], name, { type: 'application/x-ipynb+json' });
  Object.defineProperty(file, 'arrayBuffer', { value: vi.fn(async () => bytes.slice().buffer) }); return file;
};
const toggle = (text, scope = screen, open = true) => {
  const details = scope.getByText(text).closest('details'); details.open = open; fireEvent(details, new Event('toggle'));
};
const blobText = blob => new Promise((resolve, reject) => {
  const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsText(blob);
});
let records, versions, privateCopies, journal, blobs, downloaded, created;
const nativeClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close');
const nativeShow = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
beforeAll(() => {
  if (!Range.prototype.getClientRects) Range.prototype.getClientRects = () => [];
  if (!Range.prototype.getBoundingClientRect) Range.prototype.getBoundingClientRect = () => ({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 });
});
beforeEach(() => {
  vi.resetAllMocks(); records = new Map(); versions = new Map(); privateCopies = new Map(); created = 0; blobs = []; downloaded = [];
  journal = installNotebookJournalFixture(api);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 1150, height: 800, top: 0, left: 0, right: 1150, bottom: 800 });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value() { this.removeAttribute('open'); } });
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.setAttribute('open', ''); } });
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(blob => { blobs.push(blob); return `blob:local-${blobs.length}`; }) });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function () { downloaded.push(this.download); });
  api.listNotebooks.mockImplementation(async () => ({ documents: [...records.values()].map(head), nextCursor: null }));
  api.getNotebook.mockImplementation(async (_project, _analysis, id) => ({ document: clone(records.get(id)), currentHead: head(records.get(id)) }));
  api.getNotebookVersion.mockImplementation(async (_project, _analysis, _id, versionId) => ({ document: clone(versions.get(versionId)) }));
  api.createNotebook.mockImplementation(async (_project, _analysis, input) => {
    const document = { ...documentFor(clone(input.content), (11 + ++created).toString(16)), title: input.title };
    records.set(document.id, document); versions.set(document.versionId, clone(document));
    return { document: clone(document), currentHead: head(document) };
  });
  api.saveNotebook.mockImplementation(async (_project, _analysis, id, input) => {
    const current = records.get(id), version = current.version + 1;
    const document = { ...current, content: clone(input.content), title: input.title, version, versionId: `dv_${id.slice(4, 26)}${String(version).padStart(2, '0')}` };
    document.sha256 = createHash('sha256').update(canonicalNotebookContent(document.content)).digest('hex');
    records.set(id, document); versions.set(document.versionId, clone(document)); return { document: clone(document), currentHead: head(document) };
  });
  api.getNotebookDraft.mockImplementation(async (_project, _analysis, id) => ({ draft: clone(privateCopies.get(id)?.draft || null), draftVersion: privateCopies.get(id)?.draftVersion || 0,
    currentHead: head(records.get(id)), replayed: false }));
  api.saveNotebookDraft.mockImplementation(async (projectId, analysisId, id, input) => {
    const draftVersion = (privateCopies.get(id)?.draftVersion || 0) + 1;
    const draft = { schema: 'traceomics.notebook-draft.v1', visibility: 'private', ownerUserId: 1, projectId, analysisId, documentId: id, draftVersion,
      title: input.title, content: clone(input.content), baseVersion: input.baseVersion, baseVersionId: input.baseVersionId, uiState: clone(input.uiState), sha256: 'f'.repeat(64), updatedAt: '2026-10-20T12:00:00Z' };
    privateCopies.set(id, { draft, draftVersion });
    return { draft: clone(draft), draftVersion, currentHead: head(records.get(id)), replayed: false,
      checkpoint: { requestId: input.requestId, action: 'update', draftVersion, sha256: draft.sha256, cleared: false } };
  });
  api.clearNotebookDraft.mockImplementation(async (_project, _analysis, id, input) => {
    const draftVersion = (privateCopies.get(id)?.draftVersion || 0) + 1; privateCopies.set(id, { draft: null, draftVersion });
    return { draft: null, draftVersion, currentHead: head(records.get(id)), replayed: false, checkpoint: { requestId: input.requestId, action: 'clear', draftVersion, sha256: null, cleared: true } };
  });
});
afterEach(() => {
  cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); delete window.externalExecuted;
  if (nativeClose) Object.defineProperty(HTMLDialogElement.prototype, 'close', nativeClose); else delete HTMLDialogElement.prototype.close;
  if (nativeShow) Object.defineProperty(HTMLDialogElement.prototype, 'showModal', nativeShow); else delete HTMLDialogElement.prototype.showModal;
});
const seed = (document = documentFor()) => { records.set(document.id, clone(document)); versions.set(document.versionId, clone(document)); return document; };
const open = async document => {
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(`^${document.title}`) }));
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Notebook title' })).toHaveValue(document.title));
};
const prepareImport = async (filename, raw) => {
  fireEvent.click(screen.getByRole('button', { name: 'Import notebook', exact: true }));
  const form = screen.getByRole('form', { name: 'Import notebook' });
  fireEvent.change(within(form).getByLabelText('Notebook file', { exact: true }), { target: { files: [fileFor(filename, raw)] } });
  await within(form).findByRole('region', { name: 'Notebook import preview' }); return form;
};

describe('conventional notebook documents in the analysis workspace', () => {
  it.each(['R', 'python'])('admits one exact %s notebook only after confirmation and never treats outside script metadata as an app script', async language => {
    const raw = JSON.stringify(outsideNotebook(language)), expected = importNotebookFile({ filename: 'outside.ipynb', source: raw }).content;
    render(<NotebookWorkspace {...defaults} />);
    await screen.findByText('No documents yet.');
    const form = await prepareImport('outside.ipynb', raw);
    expect(api.createNotebook).not.toHaveBeenCalled(); expect(api.admitNotebookPending).not.toHaveBeenCalled();
    fireEvent.change(within(form).getByRole('textbox', { name: 'Notebook document title' }), { target: { value: 'Outside donor analysis' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Import notebook', exact: true }));
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Notebook title' })).toHaveValue('Outside donor analysis'));
    expect(api.createNotebook).toHaveBeenCalledOnce(); expect(api.createNotebook.mock.calls[0][2].content).toEqual(expected);
    expect(screen.getByRole('button', { name: 'Add code cell' })).toBeVisible(); expect(screen.queryByRole('textbox', { name: 'Script source' })).toBeNull();
    expect(screen.getByRole('region', { name: 'Raw text cell 2' })).toHaveTextContent('<img src="https://outside.invalid/raw">');
    expect(window.externalExecuted).toBeUndefined(); expect(document.querySelector('script,iframe,img')).toBeNull();
    expect(screen.queryByRole('form', { name: 'Import notebook' })).toBeNull();
  });

  it('restores an unknown admitted notebook after remount and permits exact reader replay without admitting another request', async () => {
    const admit = api.admitNotebookPending.getMockImplementation();
    api.admitNotebookPending.mockImplementationOnce(async (...args) => { await admit(...args); throw new Error('Lost admission response'); });
    const first = render(<NotebookWorkspace {...defaults} />); await screen.findByText('No documents yet.');
    const form = await prepareImport('frozen.ipynb', JSON.stringify(outsideNotebook()));
    fireEvent.click(within(form).getByRole('button', { name: 'Import notebook', exact: true }));
    await waitFor(() => expect(api.admitNotebookPending).toHaveBeenCalledOnce());
    await waitFor(() => expect(within(form).getByRole('button', { name: 'Retry import' })).toBeEnabled());
    const originalRequest = clone(api.admitNotebookPending.mock.calls[0][3].payload);
    expect(api.createNotebook).not.toHaveBeenCalled(); first.unmount();
    render(<NotebookWorkspace {...defaults} role="viewer" />);
    const recovered = await screen.findByRole('form', { name: 'Import notebook' });
    expect(within(recovered).getByRole('textbox', { name: 'Notebook document title' })).toBeDisabled();
    expect(within(recovered).getByLabelText('Notebook file', { exact: true })).toBeDisabled();
    expect(within(recovered).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    fireEvent.click(within(recovered).getByRole('button', { name: 'Retry import' }));
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Notebook title' })).toHaveValue('frozen'));
    expect(api.admitNotebookPending).toHaveBeenCalledOnce(); expect(api.createNotebook).toHaveBeenCalledOnce();
    expect(api.createNotebook.mock.calls[0][2]).toEqual(originalRequest);
    expect([...journal.requests.values()]).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Save notebook' })).toBeNull();
  });

  it('keeps notebook and script preparation separate when switching between analyses', async () => {
    const ui = render(<NotebookWorkspace {...defaults} />); await screen.findByText('No documents yet.');
    const form = await prepareImport('first-analysis.ipynb', JSON.stringify(outsideNotebook()));
    fireEvent.change(within(form).getByRole('textbox', { name: 'Notebook document title' }), { target: { value: 'First analysis source' } });
    const second = { ...defaults, analysis: { ...defaults.analysis, id: 'analysis_two', name: 'Second question' } };
    ui.rerender(<NotebookWorkspace {...second} />); await screen.findByText('No documents yet.');
    fireEvent.click(screen.getByRole('button', { name: 'Import script', exact: true }));
    const script = screen.getByRole('form', { name: 'Import script' });
    fireEvent.change(within(script).getByLabelText('Script file', { exact: true }), { target: { files: [fileFor('second.py', 'print("second")\n')] } });
    await within(script).findByRole('region', { name: 'Script preview' });
    ui.rerender(<NotebookWorkspace {...defaults} />);
    expect(screen.getByRole('form', { name: 'Import notebook' })).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Notebook document title' })).toHaveValue('First analysis source');
    expect(screen.queryByRole('form', { name: 'Import script' })).toBeNull();
    ui.rerender(<NotebookWorkspace {...second} />);
    expect(screen.getByRole('textbox', { name: 'Script document title' })).toHaveValue('second.py');
    expect(screen.queryByRole('form', { name: 'Import notebook' })).toBeNull();
    expect(api.createNotebook).not.toHaveBeenCalled(); expect(api.admitNotebookPending).not.toHaveBeenCalled();
  });

  it('edits raw source as plain text, retains historical output when code source is hidden, and saves all inert imported data', async () => {
    const original = seed(), ui = render(<NotebookWorkspace {...defaults} />); await open(original);
    const code = screen.getByRole('region', { name: 'R cell 1' });
    expect(within(code).queryByText(/Source hidden/)).toBeNull();
    fireEvent.click(within(code).getByRole('button', { name: 'Hide R cell 1 source' }));
    expect(within(code).getByText(/Source hidden/)).toBeVisible();
    const historical = within(code).getByRole('region', { name: 'Imported historical results' });
    expect(within(historical).getByText(/may not match the current source/)).toBeVisible();
    toggle('Imported results · 1 outputs · 0 attachments', within(historical)); toggle('Output 1 · display_data', within(historical));
    expect(within(historical).getByText('SAVED historical result')).toBeVisible();
    const raw = screen.getByRole('region', { name: 'Raw text cell 2' }); fireEvent.click(within(raw).getByRole('button', { name: 'Edit source' }));
    const box = within(raw).getByRole('textbox', { name: 'Raw text cell 2 source' });
    expect(box.tagName).toBe('TEXTAREA'); expect(within(raw).queryByRole('combobox')).toBeNull();
    fireEvent.change(box, { target: { value: '<script>inert raw edit</script>\nnew raw value' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save notebook' })); await waitFor(() => expect(api.saveNotebook).toHaveBeenCalledOnce());
    const saved = api.saveNotebook.mock.calls[0][3].content;
    expect(saved.cells[1].type).toBe('raw'); expect(saved.cells[1].source).toContain('<script>inert raw edit</script>');
    expect(saved.interchange).toEqual(original.content.interchange);
    expect(saved.cells.map(cell => cell.imported)).toEqual(original.content.cells.map(cell => cell.imported));
    expect(original.content.cells[1].source).toContain('untouched raw'); expect(window.externalExecuted).toBeUndefined();
    expect(document.querySelector('script,iframe,img')).toBeNull(); ui.unmount();
  });

  it('exports current edited content and exact inspected saved source separately with retained results and visible warnings', async () => {
    const original = seed(); const ui = render(<NotebookWorkspace {...defaults} />); await open(original);
    fireEvent.click(within(screen.getByRole('region', { name: 'Raw text cell 2' })).getByRole('button', { name: 'Edit source' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Raw text cell 2 source' }), { target: { value: 'PRIVATE edited raw source' } });
    fireEvent.click(screen.getByRole('button', { name: 'Export notebook', exact: true }));
    expect(downloaded).toEqual(['donor-analysis.ipynb']);
    const draftExport = JSON.parse(await blobText(blobs[0])); expect(draftExport.cells[1].source).toBe('PRIVATE edited raw source');
    expect(draftExport.cells[0].outputs).toEqual(outsideNotebook().cells[0].outputs);
    expect(draftExport.metadata).toEqual(outsideNotebook().metadata);
    expect(screen.getByRole('status', { name: 'Notebook export notes' })).toHaveTextContent(/not a captured in-app execution/);
    fireEvent.click(screen.getByRole('button', { name: 'Saved source', exact: true }));
    fireEvent.click(await screen.findByRole('button', { name: 'Export saved notebook' }));
    const savedExport = JSON.parse(await blobText(blobs[1]));
    expect(savedExport).toEqual(JSON.parse(exportNotebookFile(original.content).text));
    expect(savedExport.cells[1].source).toContain('untouched raw'); expect(savedExport.cells[1].source).not.toContain('PRIVATE');
    expect(screen.getByRole('status', { name: 'Notebook export notes' })).toHaveTextContent('Saved source version 1');
    expect(api.saveNotebook).not.toHaveBeenCalled();
    ui.unmount(); expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:local-1'); expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:local-2');
  });

  it('shows retained historical output within the exact saved source inspector', async () => {
    const original = seed(); render(<NotebookWorkspace {...defaults} />); await open(original);
    fireEvent.click(screen.getByRole('button', { name: 'Saved source', exact: true }));
    const exportButton = await screen.findByRole('button', { name: 'Export saved notebook' });
    const inspector = exportButton.closest('dialog');
    const historical = within(inspector).getAllByRole('region', { name: 'Imported historical results' })[0];
    expect(historical).toBeTruthy(); toggle('Imported results · 1 outputs · 0 attachments', within(historical)); toggle('Output 1 · display_data', within(historical));
    expect(within(historical).getByText('SAVED historical result')).toBeVisible();
    expect(within(historical).getByText(/may not match the current source/)).toBeVisible();
  });

  it('loads only an explicitly selected cell-local attachment and revokes its image on document change', async () => {
    const original = seed(), other = seed({ ...documentFor(importedContent('python', 'other.ipynb'), 'b'), title: 'Other notebook' });
    render(<NotebookWorkspace {...defaults} />); await open(other); await open(original);
    expect(document.querySelector('img')).toBeNull(); expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(screen.getByText(/Image reference: Remote plot/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Preview imported attachment: Local plot' }));
    const image = await screen.findByRole('img', { name: 'Local plot' }); expect(image).toHaveAttribute('src', 'blob:local-1');
    await open(other); expect(screen.queryByRole('img')).toBeNull(); expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:local-1');
  });

  it('keeps dirty source and the original selected document when another notebook file is malformed', async () => {
    const original = seed(); render(<NotebookWorkspace {...defaults} />); await open(original);
    fireEvent.click(within(screen.getByRole('region', { name: 'Raw text cell 2' })).getByRole('button', { name: 'Edit source' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Raw text cell 2 source' }), { target: { value: 'keep my unsaved raw source' } });
    fireEvent.click(screen.getByRole('button', { name: 'Import notebook', exact: true }));
    const form = screen.getByRole('form', { name: 'Import notebook' }); fireEvent.change(within(form).getByLabelText('Notebook file', { exact: true }), { target: { files: [fileFor('broken.ipynb', '{"cells":')] } });
    expect(await within(form).findByRole('alert')).toHaveTextContent(/valid JSON/);
    expect(screen.getByRole('textbox', { name: 'Notebook title' })).toHaveValue(original.title);
    expect(screen.getByRole('textbox', { name: 'Raw text cell 2 source' })).toHaveValue('keep my unsaved raw source');
    expect(records.get(original.id)).toEqual(original); expect(api.admitNotebookPending).not.toHaveBeenCalled(); expect(api.createNotebook).not.toHaveBeenCalled();
  });

  it('allows read-only notebook export and safe raw inspection without exposing import or save actions', async () => {
    const original = seed(); render(<NotebookWorkspace {...defaults} role="viewer" />); await open(original);
    expect(screen.getByRole('button', { name: 'Export notebook', exact: true })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Import notebook', exact: true })).toBeNull(); expect(screen.queryByRole('button', { name: 'Save notebook' })).toBeNull();
    fireEvent.click(within(screen.getByRole('region', { name: 'Raw text cell 2' })).getByRole('button', { name: 'View source' }));
    expect(screen.getByRole('textbox', { name: 'Raw text cell 2 source' })).toHaveAttribute('readonly');
    fireEvent.click(screen.getByRole('button', { name: 'Export notebook', exact: true }));
    expect(JSON.parse(await blobText(blobs[0]))).toEqual(JSON.parse(exportNotebookFile(original.content).text));
    expect(api.createNotebook).not.toHaveBeenCalled(); expect(api.saveNotebook).not.toHaveBeenCalled();
  });

  it('explains export size failure while keeping the invalid unsaved source and immutable saved version', async () => {
    const original = seed(); render(<NotebookWorkspace {...defaults} />); await open(original);
    fireEvent.click(within(screen.getByRole('region', { name: 'Raw text cell 2' })).getByRole('button', { name: 'Edit source' }));
    const source = 'x'.repeat(256 * 1024 + 1), input = screen.getByRole('textbox', { name: 'Raw text cell 2 source' });
    fireEvent.change(input, { target: { value: source } }); fireEvent.click(screen.getByRole('button', { name: 'Export notebook', exact: true }));
    expect(screen.getByRole('alert')).toHaveTextContent(/Notebook export could not be prepared/);
    expect(screen.getByRole('alert')).toHaveTextContent(/262144 UTF-8 byte limit/);
    expect(input).toHaveValue(source); expect(records.get(original.id)).toEqual(original);
    expect(URL.createObjectURL).not.toHaveBeenCalled(); expect(api.saveNotebook).not.toHaveBeenCalled();
    expect(screen.queryByRole('status', { name: 'Notebook export notes' })).toBeNull();
  });

  it('releases a prepared download URL on browser download failure without exposing internal errors', async () => {
    const original = seed(); render(<NotebookWorkspace {...defaults} />); await open(original);
    HTMLAnchorElement.prototype.click.mockImplementationOnce(() => { throw new Error('https://private.example/token'); });
    fireEvent.click(screen.getByRole('button', { name: 'Export notebook', exact: true }));
    expect(screen.getByRole('alert')).toHaveTextContent('This notebook could not be exported. Its current source is still here.');
    expect(screen.queryByText(/private\.example/)).toBeNull(); expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:local-1');
    expect(document.querySelector('a[download]')).toBeNull(); expect(records.get(original.id)).toEqual(original);
  });

  it('shows saved-export warnings and download failure inside the inspector that initiated them', async () => {
    const original = seed(); render(<NotebookWorkspace {...defaults} />); await open(original);
    fireEvent.click(screen.getByRole('button', { name: 'Saved source', exact: true }));
    const button = await screen.findByRole('button', { name: 'Export saved notebook' }), inspector = button.closest('dialog');
    fireEvent.click(button);
    expect(within(inspector).getByRole('status', { name: 'Notebook export notes' })).toHaveTextContent(/historical imported data/);
    HTMLAnchorElement.prototype.click.mockImplementationOnce(() => { throw new Error('Internal browser download failure'); });
    fireEvent.click(button);
    expect(within(inspector).getByRole('alert', { name: 'Notebook export notes' })).toHaveTextContent('This notebook could not be exported. Its current source is still here.');
    expect(screen.getAllByRole('alert', { name: 'Notebook export notes' })).toHaveLength(1);
    fireEvent.click(within(inspector).getByRole('button', { name: 'Close inspector' }));
    expect(screen.getByRole('alert', { name: 'Notebook export notes' })).toBeVisible();
  });
});
