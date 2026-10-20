import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import useNotebookDocuments from './useNotebookDocuments';
import { createNotebook, getNotebook, listNotebooks, saveNotebook, getNotebookDraft, saveNotebookDraft, clearNotebookDraft } from './notebookApi';
import { NOTEBOOK_DOCUMENT_SCHEMA, normalizeNotebookContent } from '../../shared/notebookDocument.mjs';

vi.mock('./notebookApi', () => ({ createNotebook: vi.fn(), getNotebook: vi.fn(), listNotebooks: vi.fn(), saveNotebook: vi.fn(),
  getNotebookDraft: vi.fn(), saveNotebookDraft: vi.fn(), clearNotebookDraft: vi.fn() }));
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
let stored, privateCopies, privateReceipts;
beforeEach(() => {
  vi.resetAllMocks(); stored = [structuredClone(first), structuredClone(second), structuredClone(other)]; privateCopies = new Map(); privateReceipts = new Map();
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
  getNotebookDraft.mockImplementation(async (_project, _analysis, id) => ({ draft: privateCopies.get(id)?.draft || null,
    draftVersion: privateCopies.get(id)?.draftVersion || 0, currentHead: head(stored.find(doc => doc.id === id)), replayed: false }));
  saveNotebookDraft.mockImplementation(async (_project, analysis, id, input) => {
    if (privateReceipts.has(input.requestId)) return { ...privateCopies.get(id), currentHead: head(stored.find(doc => doc.id === id)),
      replayed: true, checkpoint: privateReceipts.get(input.requestId) };
    if ((privateCopies.get(id)?.draftVersion || 0) !== input.expectedDraftVersion) throw Object.assign(new Error('Private conflict'), { code: 'NOTEBOOK_DRAFT_CONFLICT', status: 409 });
    const draftVersion = (privateCopies.get(id)?.draftVersion || 0) + 1;
    const copy = { schema: 'traceomics.notebook-draft.v1', documentId: id, projectId, analysisId: analysis, ownerUserId: 1,
      visibility: 'private', draftVersion, baseVersion: input.baseVersion, baseVersionId: input.baseVersionId, title: input.title,
      content: input.content, uiState: input.uiState, sha256: 'f'.repeat(64), updatedAt: '2026-10-20T12:00:00Z' };
    privateCopies.set(id, { draft: copy, draftVersion });
    privateReceipts.set(input.requestId, { requestId: input.requestId, action: 'update', draftVersion, sha256: copy.sha256, cleared: false });
    return { draft: copy, draftVersion, currentHead: head(stored.find(doc => doc.id === id)), replayed: false,
      checkpoint: privateReceipts.get(input.requestId) };
  });
  clearNotebookDraft.mockImplementation(async (_project, _analysis, id, input) => {
    if (privateReceipts.has(input.requestId)) return { ...privateCopies.get(id), currentHead: head(stored.find(doc => doc.id === id)),
      replayed: true, checkpoint: privateReceipts.get(input.requestId) };
    if ((privateCopies.get(id)?.draftVersion || 0) !== input.expectedDraftVersion) throw Object.assign(new Error('Private conflict'), { code: 'NOTEBOOK_DRAFT_CONFLICT', status: 409 });
    const draftVersion = (privateCopies.get(id)?.draftVersion || 0) + 1;
    privateCopies.set(id, { draft: null, draftVersion });
    privateReceipts.set(input.requestId, { requestId: input.requestId, action: 'clear', draftVersion, sha256: null, cleared: true });
    return { draft: null, draftVersion, currentHead: head(stored.find(doc => doc.id === id)), replayed: false,
      checkpoint: privateReceipts.get(input.requestId) };
  });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });
async function start(props = defaults) {
  const rendered = renderHook(value => useNotebookDocuments(value), { initialProps: props });
  if (props.isActive && !props.blocked) await waitFor(() => expect(rendered.result.current.index.loaded).toBe(true));
  return rendered;
}
const open = async (result, id = first.id) => { await act(async () => result.current.open(id)); await waitFor(() => expect(result.current.selected?.id).toBe(id)); };
const editSource = (result, source) => act(() => result.current.edit(result.current.selectedId,
  draft => ({ ...draft, content: { ...draft.content, cells: draft.content.cells.map(cell => ({ ...cell, source })) } })));
const privateInput = (source, extra = {}) => ({ requestId: crypto.randomUUID(), expectedDraftVersion: 0,
  baseVersion: first.version, baseVersionId: first.versionId, title: first.title, content: body(source),
  uiState: { activeCellId: 'stable-cell', scrollTop: 50 }, ...extra });

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
    expect(result.current.pendingCreateInfo).toEqual({ title: 'Original request', language: 'R', content: input.content });
    result.current.pendingCreateInfo.content.cells[0].source = 'Presentation must not alter the admitted payload';
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
    await waitFor(() => expect(saveNotebook).toHaveBeenCalledTimes(1));
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

describe('authorized private autosave and whole-app draft recovery', () => {
  it('coalesces typing into a private checkpoint without committing shared source', async () => {
    const { result } = await start(); await open(result); vi.useFakeTimers();
    editSource(result, 'first keystrokes'); await act(async () => vi.advanceTimersByTimeAsync(600));
    editSource(result, 'exact latest source\r\n'); await act(async () => vi.advanceTimersByTimeAsync(600));
    expect(saveNotebookDraft).not.toHaveBeenCalled(); expect(result.current.autosave.state).toBe('pending');
    await act(async () => vi.advanceTimersByTimeAsync(401));
    expect(saveNotebookDraft).toHaveBeenCalledTimes(1);
    expect(saveNotebookDraft.mock.calls[0][3].content.cells[0].source).toBe('exact latest source\r\n');
    expect(result.current.autosave.state).toBe('saved'); expect(result.current.draft.dirty).toBe(true);
    expect(saveNotebook).not.toHaveBeenCalled(); expect(createNotebook).not.toHaveBeenCalled();
    expect(stored.find(doc => doc.id === first.id).version).toBe(1);
  });

  it('checkpoints continuous editing within the maximum interval rather than postponing autosave indefinitely', async () => {
    const { result } = await start(); await open(result); vi.useFakeTimers();
    for (let index = 0; index < 7; index++) {
      editSource(result, 'continuous typing ' + index); await act(async () => vi.advanceTimersByTimeAsync(750));
    }
    expect(saveNotebookDraft).toHaveBeenCalledTimes(1);
    expect(saveNotebookDraft.mock.calls[0][3].content.cells[0].source).toBe('continuous typing 6');
  });

  it('restores only the chosen owner-private confirmed copy after the entire controller is remounted', async () => {
    const original = await start(); await open(original.result); editSource(original.result, 'recover after closing everything\r\n');
    await act(async () => original.result.current.retryAutosave());
    const accepted = structuredClone(privateCopies.get(first.id).draft); original.unmount();
    const reopened = await start(); await open(reopened.result);
    expect(reopened.result.current.draft.content.cells[0].source).toBe(first.content.cells[0].source);
    expect(reopened.result.current.recoverableDraft).toEqual(accepted);
    act(() => { expect(reopened.result.current.recoverDraft()).toBe(true); });
    expect(reopened.result.current.draft).toMatchObject({ baseVersion: 1, baseVersionId: first.versionId, dirty: true });
    expect(reopened.result.current.draft.content.cells[0].source).toBe('recover after closing everything\r\n');
    expect(reopened.result.current.recoverableDraft).toBeNull();
    expect(saveNotebook).not.toHaveBeenCalled(); expect(createNotebook).not.toHaveBeenCalled();
  });

  it('never overwrites unreviewed recovered source when the researcher first edits the saved version instead', async () => {
    await saveNotebookDraft(projectId, analysisId, first.id, privateInput('previous private alternative'));
    saveNotebookDraft.mockClear(); const { result } = await start(); await open(result); vi.useFakeTimers();
    editSource(result, 'new local alternative'); await act(async () => vi.advanceTimersByTimeAsync(6000));
    expect(saveNotebookDraft).not.toHaveBeenCalled(); expect(privateCopies.get(first.id).draft.content.cells[0].source).toBe('previous private alternative');
    await act(async () => result.current.save()); expect(saveNotebook).not.toHaveBeenCalled();
    expect(result.current.draft.content.cells[0].source).toBe('new local alternative');
    expect(result.current.recoverableDraft.content.cells[0].source).toBe('previous private alternative');
  });

  it('fences a delayed private GET behind a newer accepted checkpoint', async () => {
    const { result } = await start(); await open(result);
    const old = deferred(); getNotebookDraft.mockReturnValueOnce(old.promise);
    let opening; act(() => { opening = result.current.open(first.id); });
    await waitFor(() => expect(getNotebookDraft).toHaveBeenCalledTimes(2));
    editSource(result, 'newly checkpointed source'); await act(async () => result.current.retryAutosave());
    await act(async () => { old.resolve({ draft: null, draftVersion: 0, currentHead: head(first) }); await opening; });
    expect(result.current.autosave).toMatchObject({ state: 'saved', confirmedDraftVersion: 1 });
    expect(result.current.recoverableDraft).toBeNull(); expect(result.current.draft.content.cells[0].source).toBe('newly checkpointed source');
  });

  it('keeps newer typing unconfirmed when an older private checkpoint finishes', async () => {
    const { result } = await start(); await open(result); editSource(result, 'snapshot A');
    const actual = saveNotebookDraft.getMockImplementation(), gate = deferred();
    saveNotebookDraft.mockImplementationOnce(async (...args) => { await gate.promise; return actual(...args); });
    let saving; act(() => { saving = result.current.retryAutosave(); });
    await waitFor(() => expect(saveNotebookDraft).toHaveBeenCalledTimes(1)); editSource(result, 'newer local B');
    await act(async () => { gate.resolve(); await saving; });
    expect(result.current.draft.content.cells[0].source).toBe('newer local B');
    expect(privateCopies.get(first.id).draft.content.cells[0].source).toBe('snapshot A'); expect(result.current.autosave.state).toBe('pending');
    await act(async () => result.current.retryAutosave());
    expect(privateCopies.get(first.id).draft.content.cells[0].source).toBe('newer local B'); expect(result.current.autosave.confirmedDraftVersion).toBe(2);
  });

  it.each(['wrong source', 'wrong receipt hash'])('retains the exact checkpoint UUID after a %s success response', async defect => {
    const { result } = await start(); await open(result); editSource(result, 'exact admitted private source');
    const actual = saveNotebookDraft.getMockImplementation();
    saveNotebookDraft.mockImplementationOnce(async (...args) => {
      const response = structuredClone(await actual(...args));
      if (defect === 'wrong source') response.draft.content.cells[0].source = 'foreign source';
      else response.checkpoint.sha256 = '0'.repeat(64);
      return response;
    });
    await act(async () => result.current.retryAutosave());
    const admitted = structuredClone(saveNotebookDraft.mock.calls[0][3]);
    expect(result.current.autosave.state).toBe('failed'); expect(result.current.autosave.confirmedDraftVersion).toBe(0);
    editSource(result, 'newer text must not alter pending snapshot');
    await act(async () => result.current.retryAutosave());
    expect(saveNotebookDraft.mock.calls[1][3]).toEqual(admitted);
    expect(result.current.autosave.confirmedDraftVersion).toBe(1);
    expect(result.current.draft.content.cells[0].source).toBe('newer text must not alter pending snapshot');
    expect(result.current.autosave.state).toBe('pending');
  });

  it('keeps both alternatives on a private CAS conflict and discards only the reviewed confirmed version', async () => {
    const { result } = await start(); await open(result); editSource(result, 'first checkpoint');
    await act(async () => result.current.retryAutosave());
    await saveNotebookDraft(projectId, analysisId, first.id, privateInput('other window source', { expectedDraftVersion: 1 }));
    editSource(result, 'my in-memory alternative'); await act(async () => result.current.retryAutosave());
    expect(result.current.autosave.state).toBe('conflict'); expect(result.current.recoverableDraft.content.cells[0].source).toBe('other window source');
    expect(result.current.draft.content.cells[0].source).toBe('my in-memory alternative');
    await act(async () => result.current.discardDraft());
    expect(clearNotebookDraft.mock.calls[0][3].expectedDraftVersion).toBe(2); expect(result.current.recoverableDraft).toBeNull();
    expect(result.current.draft.content.cells[0].source).toBe('my in-memory alternative');
    await act(async () => result.current.retryAutosave());
    expect(saveNotebookDraft.mock.calls.at(-1)[3].expectedDraftVersion).toBe(3);
  });

  it.each([false, true])('requires review on ordinary reopen of a newer unseen private copy (prior checkpoint=%s)', async hadCheckpoint => {
    const { result } = await start(); await open(result);
    if (hadCheckpoint) { editSource(result, 'my confirmed X'); await act(async () => result.current.retryAutosave()); }
    await saveNotebookDraft(projectId, analysisId, first.id, privateInput('other window Y', { expectedDraftVersion: hadCheckpoint ? 1 : 0 }));
    const writesBefore = saveNotebookDraft.mock.calls.length;
    await open(result, second.id); await open(result);
    expect(result.current.recoverableDraft.content.cells[0].source).toBe('other window Y');
    expect(result.current.draft.content.cells[0].source).toBe(hadCheckpoint ? 'my confirmed X' : first.content.cells[0].source);
    editSource(result, 'my newer Z'); await act(async () => result.current.retryAutosave());
    await act(async () => result.current.save());
    expect(saveNotebookDraft).toHaveBeenCalledTimes(writesBefore); expect(saveNotebook).not.toHaveBeenCalled();
    expect(privateCopies.get(first.id).draft.content.cells[0].source).toBe('other window Y');
    expect(result.current.draft.content.cells[0].source).toBe('my newer Z');
    act(() => { expect(result.current.recoverDraft()).toBe(true); });
    expect(result.current.draft.content.cells[0].source).toBe('other window Y');
  });

  it('invalidates a removed private checkpoint on reopen without recreating another window discard automatically', async () => {
    const { result } = await start(); await open(result); editSource(result, 'private A');
    await act(async () => result.current.retryAutosave());
    await clearNotebookDraft(projectId, analysisId, first.id, { requestId: crypto.randomUUID(), expectedDraftVersion: 1 });
    await open(result, second.id); await open(result); vi.useFakeTimers();
    expect(result.current.autosave).toMatchObject({ state: 'failed', confirmedDraftVersion: 2 });
    expect(result.current.autosave.message).toMatch(/removed.*only here/i); expect(result.current.recoverableDraft).toBeNull();
    expect(result.current.draft.content.cells[0].source).toBe('private A');
    editSource(result, 'local A remains unconfirmed'); await act(async () => vi.advanceTimersByTimeAsync(6000));
    expect(saveNotebookDraft).toHaveBeenCalledTimes(1); expect(privateCopies.get(first.id).draft).toBeNull();
    await act(async () => result.current.retryAutosave());
    expect(saveNotebookDraft.mock.calls[1][3].expectedDraftVersion).toBe(2);
    expect(result.current.autosave.state).toBe('saved'); expect(privateCopies.get(first.id).draft.content.cells[0].source).toBe('local A remains unconfirmed');
  });

  it('cancels an already queued autosave when a delayed read discovers another window removed the checkpoint', async () => {
    const { result } = await start(); await open(result); editSource(result, 'confirmed A');
    await act(async () => result.current.retryAutosave());
    await clearNotebookDraft(projectId, analysisId, first.id, { requestId: crypto.randomUUID(), expectedDraftVersion: 1 });
    vi.useFakeTimers(); const delayed = deferred(); getNotebookDraft.mockReturnValueOnce(delayed.promise);
    let reading; act(() => { reading = result.current.open(first.id); }); await act(async () => Promise.resolve());
    editSource(result, 'queued Z before clear read');
    await act(async () => { delayed.resolve({ draft: null, draftVersion: 2, currentHead: head(first) }); await reading; });
    await act(async () => vi.advanceTimersByTimeAsync(6000));
    expect(result.current.autosave.state).toBe('failed'); expect(privateCopies.get(first.id).draft).toBeNull();
    expect(saveNotebookDraft).toHaveBeenCalledTimes(1); expect(result.current.draft.content.cells[0].source).toBe('queued Z before clear read');
    await act(async () => result.current.retryAutosave()); expect(privateCopies.get(first.id).draft.content.cells[0].source).toBe('queued Z before clear read');
  });

  it('rejects repeated changed-body reads at an already known private version without replacing recovery evidence', async () => {
    await saveNotebookDraft(projectId, analysisId, first.id, privateInput('known private source'));
    const { result } = await start(); await open(result);
    const known = structuredClone(result.current.recoverableDraft);
    const bad = { draft: { ...known, content: body('invalid same-version source') }, draftVersion: 1, currentHead: head(first) };
    getNotebookDraft.mockResolvedValueOnce(bad); await open(result);
    expect(result.current.recoverableDraft).toEqual(known); expect(result.current.autosave.state).toBe('failed');
    getNotebookDraft.mockResolvedValueOnce(bad); await open(result);
    expect(result.current.recoverableDraft).toEqual(known); expect(result.current.autosave.confirmedDraftVersion).toBe(1);
  });

  it('does not clear a newer window private copy after an older shared save confirms', async () => {
    const { result } = await start(); await open(result); editSource(result, 'publish this exact source');
    const actual = saveNotebook.getMockImplementation();
    saveNotebook.mockImplementationOnce(async (...args) => {
      await saveNotebookDraft(projectId, analysisId, first.id, privateInput('newer other-window edits', { expectedDraftVersion: 1 }));
      return actual(...args);
    });
    await act(async () => result.current.save());
    expect(result.current.selected.version).toBe(2); expect(result.current.pendingSave).toBe(false);
    expect(clearNotebookDraft.mock.calls[0][3].expectedDraftVersion).toBe(1);
    expect(privateCopies.get(first.id).draft.content.cells[0].source).toBe('newer other-window edits');
    expect(result.current.autosave.state).toBe('conflict'); expect(result.current.recoverableDraft.draftVersion).toBe(2);
  });

  it('confirms newer current text after resolving an older uncertain private checkpoint before sharing it', async () => {
    const { result } = await start(); await open(result); editSource(result, 'older checkpoint A');
    const actual = saveNotebookDraft.getMockImplementation();
    saveNotebookDraft.mockImplementationOnce(async (...args) => { await actual(...args); throw new Error('Lost A reply'); });
    await act(async () => result.current.retryAutosave());
    const originalInput = structuredClone(saveNotebookDraft.mock.calls[0][3]); editSource(result, 'publish newer B');
    await act(async () => result.current.save());
    expect(saveNotebookDraft).toHaveBeenCalledTimes(3);
    expect(saveNotebookDraft.mock.calls[1][3]).toEqual(originalInput);
    expect(saveNotebookDraft.mock.calls[2][3]).toMatchObject({ expectedDraftVersion: 1, content: body('publish newer B') });
    expect(saveNotebook.mock.calls[0][3].content.cells[0].source).toBe('publish newer B');
    expect(clearNotebookDraft.mock.calls[0][3].expectedDraftVersion).toBe(2);
    expect(result.current.selected.version).toBe(2); expect(result.current.pendingSave).toBe(false);
  });

  it('retries an unknown private removal with the same UUID after downgrade without mislabeling the shared save', async () => {
    const { result, rerender } = await start(); await open(result); editSource(result, 'shared source is confirmed separately');
    const actual = clearNotebookDraft.getMockImplementation();
    clearNotebookDraft.mockImplementationOnce(async (...args) => { await actual(...args); throw new Error('Lost clear reply'); });
    await act(async () => result.current.save());
    const admitted = structuredClone(clearNotebookDraft.mock.calls[0][3]);
    expect(result.current.selected.version).toBe(2); expect(result.current.pendingSave).toBe(false); expect(result.current.autosave.state).toBe('failed');
    rerender({ ...defaults, canWrite: false }); await act(async () => result.current.retryAutosave());
    expect(clearNotebookDraft.mock.calls[1][3]).toEqual(admitted); expect(result.current.autosave.confirmedDraftVersion).toBe(2);
    expect(saveNotebook).toHaveBeenCalledTimes(1); expect(saveNotebookDraft).toHaveBeenCalledTimes(1);
  });

  it('treats an older accepted checkpoint replay as a recoverable newer private head without overwriting local text', async () => {
    const { result } = await start(); await open(result); editSource(result, 'my uncertain snapshot');
    const actual = saveNotebookDraft.getMockImplementation();
    saveNotebookDraft.mockImplementationOnce(async (...args) => { await actual(...args); throw new Error('Lost checkpoint reply'); });
    await act(async () => result.current.retryAutosave());
    await actual(projectId, analysisId, first.id, privateInput('newer other-window checkpoint', { expectedDraftVersion: 1 }));
    await act(async () => result.current.retryAutosave());
    expect(result.current.autosave).toMatchObject({ state: 'conflict', confirmedDraftVersion: 2 });
    expect(result.current.recoverableDraft.content.cells[0].source).toBe('newer other-window checkpoint');
    expect(result.current.draft.content.cells[0].source).toBe('my uncertain snapshot'); expect(saveNotebook).not.toHaveBeenCalled();
  });

  it('checkpoints view state privately without marking shared source dirty or permitting invalid positions', async () => {
    const { result } = await start(); await open(result);
    act(() => { expect(result.current.editUiState(first.id, { activeCellId: 'stable-cell', scrollTop: 125.5 })).toBe(true); });
    expect(result.current.draft.dirty).toBe(false); expect(result.current.draft.privateDirty).toBe(true);
    await act(async () => result.current.retryAutosave());
    expect(saveNotebookDraft.mock.calls[0][3].uiState).toEqual({ activeCellId: 'stable-cell', scrollTop: 125.5 });
    await act(async () => result.current.save()); expect(saveNotebook).not.toHaveBeenCalled();
    act(() => { expect(result.current.editUiState(first.id, { activeCellId: 'absent', scrollTop: Infinity })).toBe(false); });
    expect(result.current.draft.uiState.scrollTop).toBe(125.5);
  });

  it('clears a removed active cell from private view state so content transforms can still autosave and share', async () => {
    const { result } = await start(); await open(result);
    act(() => { result.current.editUiState(first.id, { activeCellId: 'stable-cell', scrollTop: 125 }); });
    act(() => result.current.edit(first.id, draft => ({ ...draft, content: { ...draft.content, cells: [] } })));
    expect(result.current.draft.uiState).toEqual({ activeCellId: null, scrollTop: 125 });
    await act(async () => result.current.save());
    expect(saveNotebookDraft.mock.calls[0][3].uiState).toEqual({ activeCellId: null, scrollTop: 125 });
    expect(saveNotebook.mock.calls[0][3].content.cells).toEqual([]); expect(result.current.selected.version).toBe(2);
  });

  it('keeps offline and read-only edits honest without writing source to browser persistence', async () => {
    const local = vi.spyOn(Storage.prototype, 'setItem');
    const { result, rerender } = await start(); await open(result); editSource(result, 'not yet confirmed source');
    rerender({ ...defaults, blocked: true });
    expect(result.current.autosave.state).toBe('offline-unsaved');
    await act(async () => result.current.retryAutosave()); expect(saveNotebookDraft).not.toHaveBeenCalled();
    rerender({ ...defaults, canWrite: false }); await act(async () => result.current.retryAutosave());
    expect(saveNotebookDraft).not.toHaveBeenCalled(); expect(local).not.toHaveBeenCalled();
    expect(result.current.draft.content.cells[0].source).toBe('not yet confirmed source');
  });
});
