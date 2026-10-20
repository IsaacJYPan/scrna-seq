import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import useNotebookDocuments from './useNotebookDocuments';
import { createNotebook, getNotebook, listNotebooks, saveNotebook } from './notebookApi';
import { NOTEBOOK_DOCUMENT_SCHEMA, normalizeNotebookContent } from '../../shared/notebookDocument.mjs';

vi.mock('./notebookApi', () => ({ createNotebook: vi.fn(), getNotebook: vi.fn(), listNotebooks: vi.fn(), saveNotebook: vi.fn() }));
const projectId = `proj_${'1'.repeat(24)}`, analysisId = `ra_${'2'.repeat(24)}`, secondAnalysis = `ra_${'3'.repeat(24)}`;
const defaults = { projectId, analysisId, isActive: true, blocked: false, canWrite: true };
const body = source => normalizeNotebookContent({ schema: NOTEBOOK_DOCUMENT_SCHEMA, defaultLanguage: 'R',
  cells: [{ id: 'stable-cell', type: 'code', language: 'R', source }] });
const notebook = (digit, analysis = analysisId, version = 1, source = 'ncol(object)\r\n') => ({
  id: `doc_${digit.repeat(24)}`, projectId, analysisId: analysis, visibility: 'project',
  title: `Notebook ${digit}`, version, versionId: `dv_${digit.repeat(22)}${String(version).padStart(2, '0')}`,
  sha256: digit.repeat(64), content: body(source), createdByUserId: 1, updatedByUserId: 1,
  createdAt: '2026-10-20T12:00:00Z', updatedAt: '2026-10-20T12:00:00Z', cellCount: 1, codeCellCount: 1, defaultLanguage: 'R',
});
const first = notebook('a'), second = notebook('b'), other = notebook('c', secondAnalysis);
const head = doc => Object.fromEntries(Object.entries(doc).filter(([key]) => key !== 'content'));
const response = (doc, current = doc) => ({ document: doc, currentHead: head(current) });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
let stored;
beforeEach(() => {
  vi.resetAllMocks(); stored = [structuredClone(first), structuredClone(second), structuredClone(other)];
  listNotebooks.mockImplementation(async (_project, analysis) => ({ documents: stored.filter(doc => doc.analysisId === analysis).map(head), nextCursor: null }));
  getNotebook.mockImplementation(async (_project, _analysis, id) => response(stored.find(doc => doc.id === id)));
  createNotebook.mockImplementation(async (_project, analysis, input) => {
    const doc = { ...notebook('d', analysis), title: input.title, content: input.content };
    stored.push(doc); return response(doc);
  });
  saveNotebook.mockImplementation(async (_project, _analysis, id, input) => {
    const original = stored.find(doc => doc.id === id);
    const doc = { ...original, title: input.title, content: input.content, version: input.expectedVersion + 1,
      versionId: `dv_${'e'.repeat(22)}${String(input.expectedVersion + 1).padStart(2, '0')}` };
    stored = stored.map(value => value.id === id ? doc : value); return response(doc);
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
async function start(props = defaults) {
  const rendered = renderHook(value => useNotebookDocuments(value), { initialProps: props });
  if (props.isActive && !props.blocked) await waitFor(() => expect(rendered.result.current.index.loaded).toBe(true));
  return rendered;
}
const open = async (result, id = first.id) => { await act(async () => result.current.open(id)); await waitFor(() => expect(result.current.selected?.id).toBe(id)); };
const editSource = (result, source) => act(() => result.current.edit(result.current.selectedId,
  draft => ({ ...draft, content: { ...draft.content, cells: draft.content.cells.map(cell => ({ ...cell, source })) } })));

describe('notebook document draft and request controller', () => {
  it('retains two independent source drafts and selections through document, analysis and tab navigation', async () => {
    const { result, rerender } = await start();
    await open(result); editSource(result, 'first draft\r\n');
    await open(result, second.id); editSource(result, 'second draft\n');
    rerender({ ...defaults, analysisId: secondAnalysis });
    await open(result, other.id); editSource(result, 'another analysis\n');
    rerender({ ...defaults, isActive: false });
    expect(result.current.selectedId).toBe(second.id); expect(result.current.draft.content.cells[0].source).toBe('second draft\n');
    rerender(defaults); await open(result);
    expect(result.current.draft.content.cells[0].source).toBe('first draft\r\n');
    expect(saveNotebook).not.toHaveBeenCalled(); expect(createNotebook).not.toHaveBeenCalled();
  });

  it('keeps a higher observed source/head when a delayed older save and lower list resolve', async () => {
    const { result } = await start(); await open(result); editSource(result, 'my saved second\n');
    const pending = deferred(); saveNotebook.mockReturnValueOnce(pending.promise);
    let saving; act(() => { saving = result.current.save(); });
    const third = { ...first, title: 'Colleague version three', version: 3, versionId: `dv_${'f'.repeat(24)}`, content: body('colleague_source()\n') };
    stored = stored.map(doc => doc.id === first.id ? third : doc);
    await open(result);
    listNotebooks.mockResolvedValue({ documents: [head(first), head(second)], nextCursor: null });
    const secondSaved = { ...first, title: 'Saved second', version: 2, versionId: `dv_${'e'.repeat(24)}`, content: body('my saved second\n') };
    await act(async () => { pending.resolve(response(secondSaved)); await saving; });
    await waitFor(() => expect(result.current.index.items.find(doc => doc.id === first.id)?.version).toBe(3));
    expect(result.current.selected.version).toBe(3); expect(result.current.selected.content.cells[0].source).toBe('colleague_source()\n');
    expect(result.current.heads[first.id].version).toBe(3); expect(result.current.notice).toMatch(/version 2.*newer/i);
    expect(result.current.draft.dirty).toBe(false);
  });

  it('fences a detail GET started before a successful save', async () => {
    const { result } = await start(); await open(result); editSource(result, 'saved source');
    const old = deferred(); getNotebook.mockReturnValueOnce(old.promise);
    let opening; act(() => { opening = result.current.open(first.id); });
    await act(async () => result.current.save());
    await act(async () => { old.resolve(response(first)); await opening; });
    expect(result.current.selected.version).toBe(2); expect(result.current.draft.content.cells[0].source).toBe('saved source');
  });

  it('fences an older list and does not drop a newly created document on a stale follow-up list', async () => {
    const { result } = await start(); const oldList = deferred(); listNotebooks.mockReturnValueOnce(oldList.promise);
    let refreshing; act(() => { refreshing = result.current.refresh(); });
    listNotebooks.mockResolvedValue({ documents: [head(first), head(second)], nextCursor: null });
    await act(async () => result.current.create('New notebook', 'R'));
    const created = result.current.selected;
    await act(async () => { oldList.resolve({ documents: [], nextCursor: null }); await refreshing; });
    expect(result.current.selected.id).toBe(created.id);
    expect(result.current.index.items.some(doc => doc.id === created.id)).toBe(true);
  });

  it('freezes an uncertain save and retries the identical UUID/payload after writer downgrade', async () => {
    const { result, rerender } = await start(); await open(result); editSource(result, 'exact pending source\r\n');
    saveNotebook.mockRejectedValueOnce(new Error('Connection lost'));
    await act(async () => result.current.save());
    const input = structuredClone(saveNotebook.mock.calls[0][3]);
    expect(result.current.pendingSave).toBe(true); expect(result.current.draft.dirty).toBe(true);
    editSource(result, 'must not replace unknown admitted source');
    expect(result.current.draft.content.cells[0].source).toBe('exact pending source\r\n');
    rerender({ ...defaults, canWrite: false });
    await act(async () => result.current.save());
    expect(saveNotebook.mock.calls[1][3]).toEqual(input);
    expect(result.current.pendingSave).toBe(false); expect(result.current.draft.dirty).toBe(false);
    await act(async () => result.current.save()); expect(saveNotebook).toHaveBeenCalledTimes(2);
  });

  it('retains uncertain create content and UUID after archive/downgrade while blocking fresh read-only creation', async () => {
    const { result, rerender } = await start(); const override = body('copied_source()\r\n');
    createNotebook.mockRejectedValueOnce(new Error('Lost reply'));
    await act(async () => result.current.create('Original request', 'R', override));
    const input = structuredClone(createNotebook.mock.calls[0][2]);
    expect(result.current.pendingCreate).toBe(true);
    expect(result.current.pendingCreateInfo).toEqual({ title: 'Original request', language: 'R' });
    rerender({ ...defaults, canWrite: false });
    await act(async () => result.current.create('Changed form ignored on retry', 'python', body('different source')));
    expect(createNotebook.mock.calls[1][2]).toEqual(input);
    expect(result.current.selected.content.cells[0].source).toBe('copied_source()\r\n');
    expect(result.current.pendingCreate).toBe(false);
    expect(result.current.pendingCreateInfo).toBeNull();
    await act(async () => result.current.create('Forbidden new request', 'R'));
    expect(createNotebook).toHaveBeenCalledTimes(2);
  });

  it('keeps the UUID when a success body is unreadable instead of losing a possibly committed save', async () => {
    const { result } = await start(); await open(result); editSource(result, 'awaiting confirmation');
    saveNotebook.mockResolvedValueOnce({});
    await act(async () => result.current.save());
    const input = structuredClone(saveNotebook.mock.calls[0][3]);
    expect(result.current.pendingSave).toBe(true); expect(result.current.draft.dirty).toBe(true);
    await act(async () => result.current.save());
    expect(saveNotebook.mock.calls[1][3]).toEqual(input); expect(result.current.selected.version).toBe(2);
  });

  it('treats a foreign-scope create response as uncertain and never selects its source', async () => {
    const { result } = await start(); createNotebook.mockResolvedValueOnce(response(other));
    await act(async () => result.current.create('New document', 'R'));
    expect(result.current.pendingCreate).toBe(true); expect(result.current.selected).toBeNull();
    expect(result.current.creationProblem.message).toMatch(/could not be confirmed/);
  });

  it('does not submit a duplicate request when two Save or Create actions run before React renders', async () => {
    const { result } = await start(); await open(result); editSource(result, 'single admitted snapshot');
    const pendingSave = deferred(); saveNotebook.mockReturnValueOnce(pendingSave.promise);
    let saving; act(() => { saving = result.current.save(); void result.current.save(); });
    expect(saveNotebook).toHaveBeenCalledTimes(1);
    await act(async () => { pendingSave.resolve(response({ ...first, version: 2, content: body('single admitted snapshot') })); await saving; });
    const pendingCreate = deferred(); createNotebook.mockReturnValueOnce(pendingCreate.promise);
    let creating; act(() => { creating = result.current.create('One', 'R'); void result.current.create('Two', 'R'); });
    expect(createNotebook).toHaveBeenCalledTimes(1);
    await act(async () => { pendingCreate.resolve(response(notebook('d'))); await creating; });
    expect(result.current.pendingCreate).toBe(false);
  });

  it('captures create/save updates under their original analysis after navigation', async () => {
    const { result, rerender } = await start(); await open(result); editSource(result, 'saved in analysis one');
    const pendingSave = deferred(); saveNotebook.mockReturnValueOnce(pendingSave.promise);
    let saving; act(() => { saving = result.current.save(); });
    rerender({ ...defaults, analysisId: secondAnalysis }); await open(result, other.id);
    await act(async () => { pendingSave.resolve(response({ ...first, version: 2, content: body('saved in analysis one') })); await saving; });
    expect(result.current.selected.id).toBe(other.id);
    rerender(defaults); expect(result.current.selected.version).toBe(2);
    const pendingCreate = deferred(); createNotebook.mockReturnValueOnce(pendingCreate.promise);
    let creating; act(() => { creating = result.current.create('Created in original analysis', 'R'); });
    rerender({ ...defaults, analysisId: secondAnalysis });
    await act(async () => { pendingCreate.resolve(response(notebook('d'))); await creating; });
    expect(result.current.selected.id).toBe(other.id);
    rerender(defaults); expect(result.current.selected.id).toBe(notebook('d').id);
  });

  it('does not steal a later document selection when create or retained-save refresh finishes', async () => {
    const { result } = await start(); await open(result);
    const creatingRequest = deferred(); createNotebook.mockReturnValueOnce(creatingRequest.promise);
    let creating; act(() => { creating = result.current.create('Background creation', 'R'); });
    await open(result, second.id);
    await act(async () => { creatingRequest.resolve(response(notebook('d'))); await creating; });
    expect(result.current.selected.id).toBe(second.id);
    await open(result); editSource(result, 'retained second');
    const savingRequest = deferred(); saveNotebook.mockReturnValueOnce(savingRequest.promise);
    let saving; act(() => { saving = result.current.save(); });
    await open(result, second.id);
    const third = { ...first, version: 3, versionId: `dv_${'f'.repeat(24)}`, content: body('latest third') };
    stored = stored.map(doc => doc.id === first.id ? third : doc);
    await act(async () => { savingRequest.resolve(response({ ...first, version: 2, content: body('retained second') }, third)); await saving; });
    expect(result.current.selected.id).toBe(second.id);
    await waitFor(() => expect(result.current.heads[first.id].version).toBe(3));
  });

  it('distinguishes retained old create evidence from the newer head and loads the actual current source', async () => {
    const { result } = await start(); const original = notebook('d'), newer = { ...original, version: 2, versionId: `dv_${'e'.repeat(24)}`, content: body('newer persisted source') };
    stored.push(newer); createNotebook.mockResolvedValueOnce(response(original, newer));
    await act(async () => result.current.create('Recover old creation', 'R'));
    await waitFor(() => expect(result.current.selected?.version).toBe(2));
    expect(result.current.draft.content.cells[0].source).toBe('newer persisted source');
    expect(result.current.notice).toMatch(/version 1.*newer/);
  });

  it('keeps local source on CAS conflict and explicitly copies it into a different notebook', async () => {
    const { result } = await start(); await open(result); editSource(result, 'my scientific alternative\r\n');
    const newer = { ...first, version: 2, versionId: `dv_${'e'.repeat(24)}`, content: body('colleague source') };
    saveNotebook.mockRejectedValueOnce(Object.assign(new Error('Conflict'), { status: 409, code: 'NOTEBOOK_VERSION_CONFLICT', currentHead: head(newer) }));
    await act(async () => result.current.save());
    expect(result.current.pendingSave).toBe(false); expect(result.current.problem.currentHead.version).toBe(2);
    expect(result.current.draft.content.cells[0].source).toBe('my scientific alternative\r\n');
    const originalDraft = result.current.draft;
    await act(async () => result.current.create('My alternative copy', 'R', originalDraft.content));
    expect(result.current.selected.id).not.toBe(first.id); expect(result.current.draft.content.cells[0].source).toBe('my scientific alternative\r\n');
    expect(result.current.drafts[first.id].dirty).toBe(true); expect(result.current.drafts[first.id].content).toEqual(originalDraft.content);
  });

  it('explains trusted local validation and allows correction without admitting a request', async () => {
    const { result } = await start(); await act(async () => result.current.create('  ', 'R'));
    expect(result.current.creationProblem.message).toMatch(/title must contain/i);
    expect(result.current.pendingCreate).toBe(false); expect(createNotebook).not.toHaveBeenCalled();
    await open(result); editSource(result, 'x'.repeat(256 * 1024 + 1));
    await act(async () => result.current.save());
    expect(result.current.problem.message).toMatch(/262144 UTF-8 bytes/); expect(result.current.pendingSave).toBe(false);
    editSource(result, 'corrected()'); await act(async () => result.current.save());
    expect(saveNotebook).toHaveBeenCalledTimes(1);
  });

  it('preserves pending request/draft while disconnected and does not issue fresh writes as a reader', async () => {
    const { result, rerender } = await start(); await open(result); editSource(result, 'pending_source()');
    saveNotebook.mockRejectedValueOnce(Object.assign(new Error('Target uncertain'), { code: 'TARGET_EXECUTION_UNCONFIRMED', status: 409 }));
    await act(async () => result.current.save());
    rerender({ ...defaults, blocked: true });
    await act(async () => result.current.save()); editSource(result, 'blocked overwrite');
    expect(saveNotebook).toHaveBeenCalledTimes(1); expect(result.current.pendingSave).toBe(true);
    expect(result.current.draft.content.cells[0].source).toBe('pending_source()');
    rerender({ ...defaults, canWrite: false }); await act(async () => result.current.save());
    expect(saveNotebook).toHaveBeenCalledTimes(2);
    editSource(result, 'reader overwrite'); expect(result.current.draft.dirty).toBe(false);
  });
});
