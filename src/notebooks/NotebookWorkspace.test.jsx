import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorView } from '@codemirror/view';
import { undo } from '@codemirror/commands';
import NotebookWorkspace from './NotebookWorkspace';
import { createNotebook, getNotebook, getNotebookVersion, listNotebooks, saveNotebook, getNotebookDraft, saveNotebookDraft, clearNotebookDraft } from './notebookApi';
import { importScriptDocument } from '../../shared/scriptDocument.mjs';

vi.mock('./notebookApi', () => ({
  createNotebook: vi.fn(), getNotebook: vi.fn(), getNotebookVersion: vi.fn(), listNotebooks: vi.fn(), saveNotebook: vi.fn(),
  getNotebookDraft: vi.fn(), saveNotebookDraft: vi.fn(), clearNotebookDraft: vi.fn(),
}));

const sourceR = '\tcells <- ncol(object)  \r\n# retained source\r\n';
const cell = (id, type, source, language = 'R') => ({ id, type, source, metadata: {}, collapsed: false, ...(type === 'code' ? { language } : {}) });
const documentFixture = (digit, title, cells, version = 1) => ({
  id: `doc_${digit.repeat(24)}`, projectId: 'project_one', analysisId: 'analysis_one', title, version,
  versionId: `dv_${digit.repeat(22)}${String(version).padStart(2, '0')}`, sha256: 'a'.repeat(64),
  content: { schema: 'traceomics.notebook.v1', defaultLanguage: 'R', metadata: {}, cells },
});
const original = documentFixture('a', 'Donor responses', [
  cell('cohort_notes', 'markdown', '## Cohort notes\n\nCompare donors.'),
  cell('r_counts', 'code', sourceR), cell('py_counts', 'code', 'len(cells)\n', 'python'),
]);
const other = documentFixture('b', 'Cell annotation', [cell('annotation', 'code', 'levels(object)')]);
const head = document => ({ id: document.id, title: document.title, version: document.version,
  versionId: document.versionId, sha256: document.sha256, projectId: document.projectId, analysisId: document.analysisId,
  cellCount: document.content.cells.length, defaultLanguage: document.content.defaultLanguage, documentKind: document.documentKind || 'notebook' });
const clone = value => structuredClone(value);
let records, versions, createdCount, privateCopies;
const nativeClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close');
const nativeShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
const defaults = {
  projectId: 'project_one', projectName: 'Immune cohort', analysis: { id: 'analysis_one', name: 'Treatment response', status: 'active', references: [] },
  role: 'analyst', userId: 1, isActive: true, connection: { blocked: false }, theme: 'light',
};

beforeAll(() => {
  if (!Range.prototype.getClientRects) Range.prototype.getClientRects = () => [];
  if (!Range.prototype.getBoundingClientRect) Range.prototype.getBoundingClientRect = () => ({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 });
});
beforeEach(() => {
  vi.resetAllMocks(); createdCount = 0; privateCopies = new Map();
  records = new Map([original, other].map(document => [document.id, clone(document)]));
  versions = new Map([original, other].map(document => [document.versionId, clone(document)]));
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 1150, height: 800, top: 0, left: 0, right: 1150, bottom: 800 });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value() { this.removeAttribute('open'); } });
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.setAttribute('open', ''); } });
  listNotebooks.mockImplementation(async () => ({ documents: [...records.values()].map(head), nextCursor: null }));
  getNotebook.mockImplementation(async (_project, _analysis, id) => ({ document: clone(records.get(id)), currentHead: head(records.get(id)) }));
  getNotebookVersion.mockImplementation(async (_project, _analysis, _id, versionId) => ({ document: clone(versions.get(versionId)) }));
  createNotebook.mockImplementation(async (_project, _analysis, input) => {
    const document = { ...documentFixture((11 + ++createdCount).toString(16), input.title, []), content: clone(input.content) };
    records.set(document.id, document); versions.set(document.versionId, clone(document));
    return { document: clone(document), currentHead: head(document) };
  });
  saveNotebook.mockImplementation(async (_project, _analysis, id, input) => {
    const current = records.get(id), version = current.version + 1;
    const document = { ...current, title: input.title, content: clone(input.content), version, versionId: `dv_${id.slice(4, 26)}${String(version).padStart(2, '0')}` };
    records.set(id, document); versions.set(document.versionId, clone(document));
    return { document: clone(document), currentHead: head(document) };
  });
  getNotebookDraft.mockImplementation(async (_project, _analysis, id) => ({
    draft: clone(privateCopies.get(id)?.draft || null), draftVersion: privateCopies.get(id)?.draftVersion || 0,
    currentHead: head(records.get(id)), replayed: false,
  }));
  saveNotebookDraft.mockImplementation(async (projectId, analysisId, id, input) => {
    const draftVersion = (privateCopies.get(id)?.draftVersion || 0) + 1;
    const draft = { schema: 'traceomics.notebook-draft.v1', visibility: 'private', ownerUserId: 1,
      projectId, analysisId, documentId: id, draftVersion, title: input.title, content: clone(input.content),
      baseVersion: input.baseVersion, baseVersionId: input.baseVersionId, uiState: clone(input.uiState),
      sha256: 'f'.repeat(64), updatedAt: '2026-10-20T12:00:00Z' };
    privateCopies.set(id, { draft, draftVersion });
    return { draft: clone(draft), draftVersion, currentHead: head(records.get(id)), replayed: false,
      checkpoint: { requestId: input.requestId, action: 'update', draftVersion, sha256: draft.sha256, cleared: false } };
  });
  clearNotebookDraft.mockImplementation(async (_project, _analysis, id, input) => {
    const draftVersion = (privateCopies.get(id)?.draftVersion || 0) + 1;
    privateCopies.set(id, { draft: null, draftVersion });
    return { draft: null, draftVersion, currentHead: head(records.get(id)), replayed: false,
      checkpoint: { requestId: input.requestId, action: 'clear', draftVersion, sha256: null, cleared: true } };
  });
});
afterEach(() => {
  cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  if (nativeClose) Object.defineProperty(HTMLDialogElement.prototype, 'close', nativeClose); else delete HTMLDialogElement.prototype.close;
  if (nativeShowModal) Object.defineProperty(HTMLDialogElement.prototype, 'showModal', nativeShowModal); else delete HTMLDialogElement.prototype.showModal;
});

const openDocument = async title => {
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(`^${title}`) }));
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Notebook title' })).toHaveValue(title));
};
const cellSection = label => screen.getByRole('region', { name: label });
const activateCode = async (label, action = 'Edit source') => {
  fireEvent.click(within(cellSection(label)).getByRole('button', { name: action }));
  const textbox = await screen.findByRole('textbox', { name: `${label} source` });
  return EditorView.findFromDOM(textbox);
};
const append = (view, text) => act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: text }, userEvent: 'input.type' }));
const registerScript = (filename, source, title = filename) => {
  const content = importScriptDocument({ filename, bytes: new Uint8Array(new TextEncoder().encode(source)), cellId: 'script-source' });
  const script = { ...documentFixture('0', title, []), content, documentKind: 'script' };
  records.set(script.id, script); versions.set(script.versionId, clone(script));
  return script;
};

describe('ordinary script documents in the analysis workspace', () => {
  it('uses one source editor without cell controls, preserving exact script edits and ordinary undo', async () => {
    const source = '\uFEFF# β 🧬\r\nsource("helpers/prepare.R")\r\n';
    const script = registerScript('analysis.R', source);
    render(<NotebookWorkspace {...defaults} />);
    fireEvent.click(await screen.findByRole('button', { name: /^analysis\.R/ }));
    const box = await screen.findByRole('textbox', { name: 'Script source' });
    const view = EditorView.findFromDOM(box);
    expect(screen.getByRole('textbox', { name: 'Script title' })).toHaveValue('analysis.R');
    expect(screen.getByText(/R script · UTF-8 with BOM/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Add code cell' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add Markdown' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Notebook default language' })).toBeNull();
    append(view, '# changed\n');
    act(() => undo(view));
    fireEvent.click(screen.getByRole('button', { name: 'Save script' }));
    await waitFor(() => expect(saveNotebook).toHaveBeenCalledOnce());
    expect(saveNotebook.mock.calls[0][3].content.cells).toEqual(script.content.cells);
    expect(saveNotebook.mock.calls[0][3].content.metadata).toEqual(script.content.metadata);
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(screen.getByRole('button', { name: 'Edit script source' })).toHaveFocus();
  });

  it('copies a whole script into a notebook explicitly and keeps the original source document unchanged', async () => {
    const script = registerScript('analysis.py', 'from helpers.prepare import prepare\nprint("β")\n');
    render(<NotebookWorkspace {...defaults} />);
    fireEvent.click(await screen.findByRole('button', { name: /^analysis\.py/ }));
    await screen.findByRole('textbox', { name: 'Script source' });
    fireEvent.click(screen.getByRole('button', { name: 'Copy to a notebook' }));
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Notebook title' })).toHaveValue('analysis.py (notebook)'));
    expect(createNotebook.mock.calls[0][2].content.cells).toEqual(script.content.cells);
    expect(createNotebook.mock.calls[0][2].content.metadata).toEqual({});
    expect(records.get(script.id)).toEqual(script);
    expect(screen.getByRole('button', { name: 'Add code cell' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: /^analysis\.py\s+Python script/ }));
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Script title' })).toHaveValue('analysis.py'));
    expect(screen.getByRole('textbox', { name: 'Script source' })).toHaveTextContent('from helpers.prepare import prepare');
    expect(saveNotebook).not.toHaveBeenCalled();
  });

  it('allows a project viewer to read/export the saved script without import, editing or copying', async () => {
    registerScript('analysis.R', 'summary(object)\n');
    render(<NotebookWorkspace {...defaults} role="viewer" />);
    fireEvent.click(await screen.findByRole('button', { name: /^analysis\.R/ }));
    const box = await screen.findByRole('textbox', { name: 'Script source' });
    expect(box).toHaveAttribute('aria-readonly', 'true');
    expect(screen.getByRole('textbox', { name: 'Script title' })).toHaveAttribute('readonly');
    expect(screen.getByRole('button', { name: 'Export script' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Import script' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save script' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Copy to a notebook' })).toBeNull();
    expect(createNotebook).not.toHaveBeenCalled();
    expect(saveNotebook).not.toHaveBeenCalled();
  });

  it('keeps source accessible when script metadata is incompatible instead of mounting a misleading script editor', async () => {
    const script = registerScript('analysis.R', 'summary(object)\n');
    script.content.cells.push(cell('second', 'code', 'len(cells)', 'python'));
    render(<NotebookWorkspace {...defaults} />);
    fireEvent.click(await screen.findByRole('button', { name: /^analysis\.R/ }));
    await screen.findByRole('textbox', { name: 'Notebook title' });
    expect(screen.getByText(/incompatible script metadata/)).toBeVisible();
    expect(screen.queryByRole('textbox', { name: 'Script source' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Export script' })).toBeNull();
    expect(screen.getByRole('region', { name: 'R cell 1' })).toHaveTextContent('summary(object)');
    expect(screen.getByRole('region', { name: 'Python cell 2' })).toHaveTextContent('len(cells)');
  });
});

describe('private working-copy recovery presentation', () => {
  const seedPrivate = () => {
    const content = clone(original.content);
    content.cells[1].source = '# Private alternative\r\nprivate_value <- 42L\r\n';
    const draft = { schema: 'traceomics.notebook-draft.v1', visibility: 'private', ownerUserId: 1,
      projectId: defaults.projectId, analysisId: defaults.analysis.id, documentId: original.id, draftVersion: 2,
      title: 'My private alternative', content, baseVersion: original.version, baseVersionId: original.versionId,
      uiState: { activeCellId: 'r_counts', scrollTop: 0 }, sha256: 'f'.repeat(64), updatedAt: '2026-10-20T12:00:00Z' };
    privateCopies.set(original.id, { draft, draftVersion: 2 });
    return draft;
  };
  it('reviews an existing private snapshot and restores it only after an explicit choice', async () => {
    const privateDraft = seedPrivate();
    render(<NotebookWorkspace {...defaults} />);
    await openDocument(original.title);
    const recovery = await screen.findByRole('region', { name: 'Private draft recovery' });
    expect(screen.getByRole('textbox', { name: 'Notebook title' })).toHaveValue(original.title);
    expect(saveNotebookDraft).not.toHaveBeenCalled();
    fireEvent.click(within(recovery).getByRole('button', { name: 'Review private draft' }));
    expect(screen.getByText(/This draft is visible only to your account/)).toBeVisible();
    expect(screen.getByText(/private_value <- 42L/)).toBeVisible();
    fireEvent.click(within(recovery).getByRole('button', { name: 'Restore private draft' }));
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Notebook title' })).toHaveValue(privateDraft.title));
    expect(screen.getByRole('textbox', { name: 'R cell 2 source' })).toHaveTextContent('private_value <- 42L');
    expect(screen.getByText(/Your private working copy · Shared saved source is unchanged/)).toBeVisible();
    expect(screen.queryByRole('region', { name: 'Private draft recovery' })).toBeNull();
    expect(records.get(original.id).title).toBe(original.title);
    expect(saveNotebook).not.toHaveBeenCalled();
  });
  it('keeps saved source explicitly and clears only the current private draft version', async () => {
    seedPrivate();
    render(<NotebookWorkspace {...defaults} />);
    await openDocument(original.title);
    const recovery = await screen.findByRole('region', { name: 'Private draft recovery' });
    fireEvent.click(within(recovery).getByRole('button', { name: 'Keep current source' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Private draft recovery' })).toBeNull());
    expect(clearNotebookDraft.mock.calls[0][3]).toMatchObject({ expectedDraftVersion: 2 });
    expect(screen.getByRole('textbox', { name: 'Notebook title' })).toHaveValue(original.title);
    expect(records.get(original.id)).toEqual(original);
    expect(saveNotebook).not.toHaveBeenCalled();
  });
});

describe('notebook workspace editing and review flows', () => {
  it('makes shared-source privacy and save-without-execution explicit before creating a Python notebook', async () => {
    records.clear();
    render(<NotebookWorkspace {...defaults} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Create a notebook' }));
    const form = screen.getByRole('form', { name: 'New notebook' });
    expect(within(form).getByText('Source in this notebook is shared with project members. Saving does not execute code.')).toBeVisible();
    fireEvent.change(within(form).getByRole('textbox', { name: 'New notebook title' }), { target: { value: 'Donor summaries' } });
    fireEvent.change(within(form).getByRole('combobox', { name: 'New notebook language' }), { target: { value: 'python' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Create notebook' }));
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Notebook title' })).toHaveValue('Donor summaries'));
    const input = createNotebook.mock.calls[0][2];
    expect(input).toMatchObject({ title: 'Donor summaries', content: { defaultLanguage: 'python', cells: [{ type: 'code', language: 'python', source: '' }] } });
    expect(input.requestId).toMatch(/^[a-f0-9-]{36}$/);
    expect(screen.getByText(/Shared with this project/)).toBeVisible();
    expect(screen.queryByRole('button', { name: /^Run/ })).toBeNull();
    expect(saveNotebook).not.toHaveBeenCalled();
  });

  it('edits Markdown/R/Python in context while keeping document drafts and editor undo across navigation', async () => {
    render(<NotebookWorkspace {...defaults} />);
    await openDocument('Donor responses');
    expect(screen.getByRole('heading', { name: 'Cohort notes' })).toBeVisible();
    fireEvent.click(within(cellSection('Markdown cell 1')).getByRole('button', { name: 'Edit text' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Markdown cell 1 source' }), { target: { value: '*Updated donor observation*' } });
    const rView = await activateCode('R cell 2');
    append(rView, 'message("draft")');
    expect(screen.getByText('Updated donor observation').tagName).toBe('EM');
    const python = await activateCode('Python cell 3');
    append(python, '# Python draft');
    await openDocument('Cell annotation');
    await openDocument('Donor responses');
    expect(EditorView.findFromDOM(screen.getByRole('textbox', { name: 'Python cell 3 source' })).state.sliceDoc()).toBe('len(cells)\n# Python draft');
    const restoredR = await activateCode('R cell 2');
    expect(restoredR.state.sliceDoc()).toBe(`${sourceR}message("draft")`);
    act(() => expect(undo(restoredR)).toBe(true));
    expect(restoredR.state.sliceDoc()).toBe(sourceR);
    expect(screen.getByText('Updated donor observation')).toBeVisible();
    expect(createNotebook).not.toHaveBeenCalled(); expect(saveNotebook).not.toHaveBeenCalled();
  });

  it('moves, duplicates and removes cells while retaining identity and undoing a removal', async () => {
    render(<NotebookWorkspace {...defaults} />);
    await openDocument('Donor responses');
    fireEvent.click(screen.getByRole('button', { name: 'Move cell 2 up' }));
    expect(document.querySelector('[id^="notebook-cell-"]').id).toBe('notebook-cell-r_counts');
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate cell 1' }));
    let wrappers = [...document.querySelectorAll('[id^="notebook-cell-"]')];
    const duplicateId = wrappers[1].id.replace('notebook-cell-', '');
    expect(duplicateId).not.toBe('r_counts');
    expect(new Set(wrappers.map(item => item.id)).size).toBe(4);
    fireEvent.click(screen.getByRole('button', { name: 'Remove cell 2' }));
    expect(document.getElementById(`notebook-cell-${duplicateId}`)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Undo removal' }));
    expect(document.getElementById(`notebook-cell-${duplicateId}`)).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save notebook' }));
    await waitFor(() => expect(saveNotebook).toHaveBeenCalledOnce());
    const cells = saveNotebook.mock.calls[0][3].content.cells;
    expect(cells.map(item => item.id)).toEqual(['r_counts', duplicateId, 'cohort_notes', 'py_counts']);
    expect(cells[0].source).toBe(sourceR); expect(cells[1].source).toBe(sourceR);
    expect(cells[0].id).not.toBe(cells[1].id);
  });

  it('adds narrative and code cells with stable identities and a flexible per-cell language', async () => {
    render(<NotebookWorkspace {...defaults} />);
    await openDocument('Donor responses');
    fireEvent.click(screen.getByRole('button', { name: 'Add Markdown' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Markdown cell 4 source' }), { target: { value: '### Interpretation\n\nCompare biological replicates.' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Notebook default language' }), { target: { value: 'python' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add code cell' }));
    const pythonBox = screen.getByRole('textbox', { name: 'Python cell 5 source' });
    const view = EditorView.findFromDOM(pythonBox); append(view, 'len(cells)');
    fireEvent.change(screen.getByRole('combobox', { name: 'Python cell 5 language' }), { target: { value: 'R' } });
    expect(screen.getByRole('textbox', { name: 'R cell 5 source' })).toBe(pythonBox);
    expect(EditorView.findFromDOM(pythonBox)).toBe(view);
    fireEvent.click(screen.getByRole('button', { name: 'Save notebook' }));
    await waitFor(() => expect(saveNotebook).toHaveBeenCalledOnce());
    const saved = saveNotebook.mock.calls[0][3].content;
    expect(saved.defaultLanguage).toBe('python');
    expect(saved.cells[3]).toMatchObject({ type: 'markdown', source: '### Interpretation\n\nCompare biological replicates.' });
    expect(saved.cells[4]).toMatchObject({ type: 'code', language: 'R', source: 'len(cells)' });
    expect(new Set(saved.cells.map(item => item.id)).size).toBe(5);
    expect(saved.cells.slice(0, 3).map(item => item.id)).toEqual(original.content.cells.map(item => item.id));
  });

  it('shows immutable saved source separately from dirty source, then saves/reopens exact edited bytes', async () => {
    render(<NotebookWorkspace {...defaults} />);
    await openDocument('Donor responses');
    const view = await activateCode('R cell 2');
    append(view, '# deliberate edit');
    fireEvent.click(screen.getByRole('button', { name: 'Saved source', exact: true }));
    const inspection = await screen.findByRole('complementary', { name: 'Saved source' });
    expect(within(inspection).getByText(/This snapshot records saved code, not an execution/)).toBeVisible();
    expect(inspection.querySelector('pre').textContent).toBe(sourceR);
    expect(view.state.sliceDoc()).toBe(`${sourceR}# deliberate edit`);
    fireEvent.click(within(inspection).getByRole('button', { name: 'Close inspector' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save notebook' }));
    await waitFor(() => expect(saveNotebook).toHaveBeenCalledOnce());
    expect(saveNotebook.mock.calls[0][3]).toMatchObject({ expectedVersion: 1, content: { cells: [
      { id: 'cohort_notes', source: original.content.cells[0].source }, { id: 'r_counts', source: `${sourceR}# deliberate edit` }, { id: 'py_counts', source: 'len(cells)\n' },
    ] } });
    await openDocument('Cell annotation'); await openDocument('Donor responses');
    expect(EditorView.findFromDOM(screen.getByRole('textbox', { name: 'R cell 2 source' })).state.sliceDoc()).toBe(`${sourceR}# deliberate edit`);
    expect(versions.get(original.versionId).content.cells[1].source).toBe(sourceR);
    fireEvent.click(screen.getByRole('button', { name: 'Saved source', exact: true }));
    const saved = await screen.findByRole('complementary', { name: 'Saved source' });
    expect(saved.querySelector('pre').textContent).toBe(`${sourceR}# deliberate edit`);
  });

  it('protects a viewer or archived notebook while allowing genuine source inspection', async () => {
    const ui = render(<NotebookWorkspace {...defaults} role="viewer" />);
    await openDocument('Donor responses');
    expect(screen.getByRole('textbox', { name: 'Notebook title' })).toHaveAttribute('readonly');
    expect(screen.queryByRole('button', { name: 'Save notebook' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'New notebook' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add code cell' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Duplicate cell 1' })).toBeNull();
    const rView = await activateCode('R cell 2', 'View source');
    expect(rView.state.readOnly).toBe(true);
    expect(screen.getByRole('textbox', { name: 'R cell 2 source' })).toHaveAttribute('contenteditable', 'false');
    fireEvent.click(within(cellSection('Markdown cell 1')).getByRole('button', { name: 'View source' }));
    expect(screen.getByRole('textbox', { name: 'Markdown cell 1 source' })).toHaveAttribute('readonly');
    fireEvent.click(screen.getByRole('button', { name: 'Hide Markdown cell 1 source' }));
    expect(screen.getByRole('button', { name: 'Show Markdown cell 1 source' })).toHaveAttribute('aria-expanded', 'false');
    ui.rerender(<NotebookWorkspace {...defaults} role="owner" analysis={{ ...defaults.analysis, status: 'archived' }} />);
    expect(screen.queryByRole('button', { name: 'Save notebook' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add code cell' })).toBeNull();
    expect(createNotebook).not.toHaveBeenCalled(); expect(saveNotebook).not.toHaveBeenCalled();
  });

  it('keeps a conflict draft intact and copies its complete content to a separately identified notebook', async () => {
    render(<NotebookWorkspace {...defaults} />);
    await openDocument('Donor responses');
    const view = await activateCode('R cell 2'); append(view, '# my draft');
    const colleague = { ...clone(original), title: 'Colleague interpretation', version: 2, versionId: `dv_${'e'.repeat(24)}`, content: { ...clone(original.content), cells: [cell('colleague_notes', 'markdown', 'Colleague saved interpretation')] } };
    records.set(original.id, colleague); versions.set(colleague.versionId, colleague);
    saveNotebook.mockRejectedValueOnce(Object.assign(new Error('A newer saved notebook exists.'), { status: 409, code: 'NOTEBOOK_VERSION_CONFLICT', currentHead: head(colleague) }));
    fireEvent.click(screen.getByRole('button', { name: 'Save notebook' }));
    expect(await screen.findByText(/Your edits remain in this draft/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Save notebook' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Review latest saved source' }));
    const inspected = await screen.findByRole('complementary', { name: 'Saved source' });
    expect(inspected.textContent).toContain('Colleague saved interpretation');
    fireEvent.click(within(inspected).getByRole('button', { name: 'Close inspector' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save my draft as a new notebook' }));
    await waitFor(() => expect(createNotebook).toHaveBeenCalledOnce());
    const copy = createNotebook.mock.calls[0][2];
    expect(copy.title).toBe('Donor responses (copy)');
    expect(copy.content.cells.map(item => item.id)).toEqual(original.content.cells.map(item => item.id));
    expect(copy.content.cells[1].source).toBe(`${sourceR}# my draft`);
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Notebook title' })).toHaveValue('Donor responses (copy)'));
    fireEvent.click(screen.getByRole('button', { name: /^Colleague interpretation/ }));
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Notebook title' })).toHaveValue('Donor responses'));
    expect(EditorView.findFromDOM(screen.getByRole('textbox', { name: 'R cell 2 source' })).state.sliceDoc()).toBe(`${sourceR}# my draft`);
    expect(records.get(original.id).content.cells[0].source).toBe('Colleague saved interpretation');
  });

  it('does not show a previous notebook saved-source reply after navigating to another notebook', async () => {
    let resolveSource;
    getNotebookVersion.mockImplementationOnce(() => new Promise(resolve => { resolveSource = resolve; }));
    render(<NotebookWorkspace {...defaults} />);
    await openDocument('Donor responses');
    fireEvent.click(screen.getByRole('button', { name: 'Saved source', exact: true }));
    await openDocument('Cell annotation');
    await act(async () => resolveSource({ document: clone(original) }));
    expect(screen.queryByRole('complementary', { name: 'Saved source' })).toBeNull();
  });

  it('keeps an unconfirmed save frozen and exposes identical-request recovery after a role downgrade', async () => {
    saveNotebook.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const ui = render(<NotebookWorkspace {...defaults} />);
    await openDocument('Donor responses');
    append(await activateCode('R cell 2'), '# pending save');
    fireEvent.click(screen.getByRole('button', { name: 'Save notebook' }));
    const retry = await screen.findByRole('button', { name: 'Retry save' });
    expect(screen.getByRole('textbox', { name: 'Notebook title' })).toHaveAttribute('readonly');
    expect(screen.getByRole('textbox', { name: 'R cell 2 source' })).toHaveAttribute('contenteditable', 'false');
    expect(screen.queryByRole('button', { name: 'Duplicate cell 2' })).toBeNull();
    const admitted = clone(saveNotebook.mock.calls[0][3]);
    ui.rerender(<NotebookWorkspace {...defaults} role="viewer" />);
    expect(screen.getByRole('button', { name: 'Retry save' })).toBe(retry);
    fireEvent.click(retry);
    await waitFor(() => expect(saveNotebook).toHaveBeenCalledTimes(2));
    expect(saveNotebook.mock.calls[1][3]).toEqual(admitted);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Retry save' })).toBeNull());
    expect(records.get(original.id).content.cells[1].source).toBe(`${sourceR}# pending save`);
    expect(screen.queryByRole('button', { name: 'Save notebook' })).toBeNull();
  });

  it('retains each analysis creation form and restores the exact unconfirmed title/language for retry', async () => {
    createNotebook.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    listNotebooks.mockImplementation(async (_project, analysisId) => ({
      documents: [...records.values()].filter(document => document.analysisId === analysisId).map(head), nextCursor: null,
    }));
    const ui = render(<NotebookWorkspace {...defaults} />);
    fireEvent.click(await screen.findByRole('button', { name: 'New notebook' }));
    let form = screen.getByRole('form', { name: 'New notebook' });
    fireEvent.change(within(form).getByRole('textbox', { name: 'New notebook title' }), { target: { value: 'Frozen donor notebook' } });
    fireEvent.change(within(form).getByRole('combobox', { name: 'New notebook language' }), { target: { value: 'python' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Create notebook' }));
    expect(await within(form).findByRole('button', { name: 'Retry create' })).toBeVisible();
    const admitted = clone(createNotebook.mock.calls[0][2]);
    const second = { ...defaults.analysis, id: 'analysis_two', name: 'Cell annotation' };
    ui.rerender(<NotebookWorkspace {...defaults} analysis={second} />);
    expect(screen.queryByRole('form', { name: 'New notebook' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'New notebook' }));
    form = screen.getByRole('form', { name: 'New notebook' });
    expect(within(form).getByRole('textbox', { name: 'New notebook title' })).toHaveValue('');
    fireEvent.change(within(form).getByRole('textbox', { name: 'New notebook title' }), { target: { value: 'Separate annotation plan' } });
    ui.rerender(<NotebookWorkspace {...defaults} />);
    form = screen.getByRole('form', { name: 'New notebook' });
    expect(within(form).getByRole('textbox', { name: 'New notebook title' })).toHaveValue('Frozen donor notebook');
    expect(within(form).getByRole('textbox', { name: 'New notebook title' })).toBeDisabled();
    expect(within(form).getByRole('combobox', { name: 'New notebook language' })).toHaveValue('python');
    fireEvent.click(within(form).getByRole('button', { name: 'Retry create' }));
    await waitFor(() => expect(createNotebook).toHaveBeenCalledTimes(2));
    expect(createNotebook.mock.calls[1]).toEqual(['project_one', 'analysis_one', admitted]);
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Notebook title' })).toHaveValue('Frozen donor notebook'));
    ui.rerender(<NotebookWorkspace {...defaults} analysis={second} />);
    expect(within(screen.getByRole('form', { name: 'New notebook' })).getByRole('textbox', { name: 'New notebook title' })).toHaveValue('Separate annotation plan');
  });

  it('previews a Markdown-only notebook after editing or Escape without remounting source or rendering HTML', async () => {
    records.set(original.id, { ...clone(original), content: { ...clone(original.content), cells: [cell('only_note', 'markdown', '## Scientific context')] } });
    render(<NotebookWorkspace {...defaults} />);
    await openDocument('Donor responses');
    expect(screen.getByRole('heading', { name: 'Scientific context' })).toBeVisible();
    const section = cellSection('Markdown cell 1');
    fireEvent.click(within(section).getByRole('button', { name: 'Edit text' }));
    const source = screen.getByRole('textbox', { name: 'Markdown cell 1 source' });
    const text = '## Edited interpretation\n\n**Donor-level replication**\n\n<script>window.unwantedMarkdown = true</script>\n\n![Private slide](https://example.invalid/slide.png)';
    fireEvent.change(source, { target: { value: text } });
    source.setSelectionRange(5, 12);
    fireEvent.click(within(section).getByRole('button', { name: 'Preview text' }));
    expect(source).not.toBeVisible();
    expect(screen.getByRole('heading', { name: 'Edited interpretation' })).toBeVisible();
    expect(screen.getByText('Donor-level replication').tagName).toBe('STRONG');
    expect(section.querySelector('script, img')).toBeNull();
    expect(window.unwantedMarkdown).toBeUndefined();
    expect(screen.getByText('Image reference: Private slide (images are not loaded automatically)')).toBeVisible();
    fireEvent.click(within(section).getByRole('button', { name: 'Edit text' }));
    expect(screen.getByRole('textbox', { name: 'Markdown cell 1 source' })).toBe(source);
    expect(source).toHaveValue(text);
    expect(source.selectionStart).toBe(5); expect(source.selectionEnd).toBe(12);
    fireEvent.keyDown(source, { key: 'Escape' });
    expect(source).not.toBeVisible();
    expect(screen.getByRole('heading', { name: 'Edited interpretation' })).toBeVisible();
    expect(within(section).getByRole('button', { name: 'Edit text' })).toHaveFocus();
    expect(saveNotebook).not.toHaveBeenCalled();
  });

  it('returns from Escape to the cell action and can activate the same editor again', async () => {
    render(<NotebookWorkspace {...defaults} />);
    await openDocument('Donor responses');
    await activateCode('R cell 2');
    const source = screen.getByRole('textbox', { name: 'R cell 2 source' });
    fireEvent.keyDown(source, { key: 'Escape' });
    const action = within(cellSection('R cell 2')).getByRole('button', { name: 'Edit source' });
    expect(action).toHaveFocus();
    fireEvent.click(action);
    await waitFor(() => expect(source).toHaveFocus());
  });
});
