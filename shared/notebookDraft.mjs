import { NOTEBOOK_VERSION_ID, normalizeNotebookContent, normalizeNotebookSave } from './notebookDocument.mjs';

export const NOTEBOOK_DRAFT_SCHEMA = 'traceomics.notebook-draft.v1';
export const NOTEBOOK_DRAFT_LIMITS = Object.freeze({ scrollTop: 10000000, receipts: 128 });

const invalid = message => { throw Object.assign(new Error(message), { code: 'INVALID_NOTEBOOK_DRAFT', status: 400 }); };
const fields = (value, allowed, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid(`${label} must be a plain JSON object.`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !allowed.includes(key)
      || !descriptors[key].enumerable || !Object.hasOwn(descriptors[key], 'value'))) invalid(`${label} contains unsupported fields.`);
};
const draftVersion = value => {
  if (!Number.isSafeInteger(value) || value < 0 || value >= 2147483647) invalid('Choose a valid confirmed private draft version.');
  return value;
};

export function normalizeNotebookDraft(input) {
  fields(input, ['requestId', 'expectedDraftVersion', 'baseVersion', 'baseVersionId', 'title', 'content', 'uiState'], 'Private draft');
  const saved = normalizeNotebookSave({ requestId: input.requestId, expectedVersion: input.baseVersion,
    title: input.title, content: input.content });
  if (typeof input.baseVersionId !== 'string' || !NOTEBOOK_VERSION_ID.test(input.baseVersionId)) invalid('Choose the exact saved source version for this private draft.');
  const ui = input.uiState === undefined ? {} : input.uiState;
  fields(ui, ['activeCellId', 'scrollTop'], 'Private draft view state');
  const activeCellId = ui.activeCellId ?? null;
  if (activeCellId !== null && (typeof activeCellId !== 'string' || !saved.content.cells.some(cell => cell.id === activeCellId))) {
    invalid('Choose an existing notebook cell for the private draft view.');
  }
  const scrollTop = ui.scrollTop ?? 0;
  if (typeof scrollTop !== 'number' || !Number.isFinite(scrollTop) || scrollTop < 0 || scrollTop > NOTEBOOK_DRAFT_LIMITS.scrollTop) {
    invalid(`Private draft scroll position must be between 0 and ${NOTEBOOK_DRAFT_LIMITS.scrollTop}.`);
  }
  return { requestId: saved.requestId, expectedDraftVersion: draftVersion(input.expectedDraftVersion),
    baseVersion: saved.expectedVersion, baseVersionId: input.baseVersionId,
    title: saved.title, content: saved.content, uiState: { activeCellId, scrollTop: Object.is(scrollTop, -0) ? 0 : scrollTop } };
}

export function normalizeNotebookDraftClear(input) {
  fields(input, ['requestId', 'expectedDraftVersion'], 'Private draft discard');
  // Reuse the document UUID validator without accepting source in this operation.
  const parsed = normalizeNotebookSave({ requestId: input.requestId, expectedVersion: 1, title: 'Private draft',
    content: { schema: 'traceomics.notebook.v1', defaultLanguage: 'R', cells: [] } });
  return { requestId: parsed.requestId, expectedDraftVersion: draftVersion(input.expectedDraftVersion) };
}

export function canonicalNotebookDraftSnapshot(parsed) {
  return JSON.stringify({ baseVersion: parsed.baseVersion, baseVersionId: parsed.baseVersionId,
    title: parsed.title, content: normalizeNotebookContent(parsed.content),
    uiState: { activeCellId: parsed.uiState?.activeCellId ?? null, scrollTop: parsed.uiState?.scrollTop ?? 0 } });
}
