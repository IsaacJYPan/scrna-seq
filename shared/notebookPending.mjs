import { normalizeNotebookCreate, normalizeNotebookSave } from './notebookDocument.mjs';

export const NOTEBOOK_PENDING_SCHEMA = 'traceomics.notebook-pending.v1';

const invalid = message => { throw Object.assign(new Error(message), { code: 'INVALID_NOTEBOOK_PENDING', status: 400 }); };
function fields(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid('Pending source requests require a plain JSON object.');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !allowed.includes(key)
      || !descriptors[key].enumerable || !Object.hasOwn(descriptors[key], 'value'))) invalid('Pending source request contains unsupported fields.');
}
function version(value, zero = false) {
  if (!Number.isSafeInteger(value) || value < (zero ? 0 : 1) || value >= 2147483647) invalid('Choose a valid confirmed pending source version.');
  return value;
}
const normalizePayload = (action, payload) => {
  if (!['create', 'save'].includes(action)) invalid('Choose a source create or save operation.');
  return action === 'create' ? normalizeNotebookCreate(payload) : normalizeNotebookSave(payload);
};

export function normalizeNotebookPendingAdmission(action, input) {
  fields(input, ['expectedJournalVersion', 'payload', 'confirmedDraftVersion']);
  const confirmedDraftVersion = input.confirmedDraftVersion ?? null;
  if (confirmedDraftVersion !== null && action !== 'save') invalid('Only an existing document can identify a private draft checkpoint.');
  return { expectedJournalVersion: version(input.expectedJournalVersion, true), payload: normalizePayload(action, input.payload),
    confirmedDraftVersion: confirmedDraftVersion === null ? null : version(confirmedDraftVersion) };
}

export function normalizeNotebookPendingSubmit(input) {
  fields(input, ['requestId', 'admittedVersion']);
  // Reuse the source UUID validator without admitting source in this operation.
  const parsed = normalizeNotebookCreate({ requestId: input.requestId, title: 'Pending source',
    content: { schema: 'traceomics.notebook.v1', defaultLanguage: 'R', cells: [] } });
  return { requestId: parsed.requestId, admittedVersion: version(input.admittedVersion) };
}

export function canonicalNotebookPendingRequest({ action, projectId, analysisId, documentId, payload }) {
  return JSON.stringify({ action, projectId, analysisId, ...(action === 'save' ? { documentId } : {}), ...normalizePayload(action, payload) });
}
