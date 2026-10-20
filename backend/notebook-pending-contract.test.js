import { describe, expect, it } from 'vitest';
import { canonicalNotebookPendingRequest, normalizeNotebookPendingAdmission, normalizeNotebookPendingSubmit } from '../shared/notebookPending.mjs';
import { normalizeNotebookCreate, normalizeNotebookSave } from '../shared/notebookDocument.mjs';

const payload = () => ({ requestId: '550E8400-E29B-41D4-A716-446655440000', title: '  Source  ',
  content: { schema: 'traceomics.notebook.v1', defaultLanguage: 'R', cells: [{ id: 'a', type: 'code', language: 'R', source: ' α\r\n' }] } });

describe('durable pending notebook source contract', () => {
  it('freezes exact normalized source and captures only an existing private checkpoint', () => {
    expect(normalizeNotebookPendingAdmission('create', { expectedJournalVersion: 0, payload: payload() }))
      .toEqual({ expectedJournalVersion: 0, confirmedDraftVersion: null, payload: normalizeNotebookCreate(payload()) });
    const saved = { ...payload(), expectedVersion: 4 };
    expect(normalizeNotebookPendingAdmission('save', { expectedJournalVersion: 3, payload: saved, confirmedDraftVersion: 9 }))
      .toEqual({ expectedJournalVersion: 3, confirmedDraftVersion: 9, payload: normalizeNotebookSave(saved) });
  });
  it('matches the established shared create/save receipt hash input exactly', () => {
    const projectId = 'proj_' + '1'.repeat(24), analysisId = 'ra_' + '2'.repeat(24), documentId = 'doc_' + '3'.repeat(24);
    expect(canonicalNotebookPendingRequest({ action: 'create', projectId, analysisId, payload: payload() }))
      .toBe(JSON.stringify({ action: 'create', projectId, analysisId, ...normalizeNotebookCreate(payload()) }));
    const saved = { ...payload(), expectedVersion: 4 };
    expect(canonicalNotebookPendingRequest({ action: 'save', projectId, analysisId, documentId, payload: saved }))
      .toBe(JSON.stringify({ action: 'save', projectId, analysisId, documentId, ...normalizeNotebookSave(saved) }));
  });
  it('rejects injected identity, cancellation, mutable source submit and invalid CAS values', () => {
    for (const extra of [{ expectedJournalVersion: -1 }, { expectedJournalVersion: 1.2 }, { expectedJournalVersion: 2147483647 },
      { ownerUserId: 7 }, { state: 'succeeded' }, { confirmedDraftVersion: 3 }, { cancel: true }]) {
      expect(() => normalizeNotebookPendingAdmission('create', { expectedJournalVersion: 0, payload: payload(), ...extra })).toThrow();
    }
    for (const confirmedDraftVersion of [0, -1, 1.5, 2147483647, '2']) {
      expect(() => normalizeNotebookPendingAdmission('save', { expectedJournalVersion: 0, payload: { ...payload(), expectedVersion: 1 }, confirmedDraftVersion })).toThrow();
    }
    expect(() => normalizeNotebookPendingSubmit({ requestId: payload().requestId, admittedVersion: 1, payload: payload() })).toThrow();
  });
  it('normalizes source-free exact submit identity and rejects getters before reading them', () => {
    expect(normalizeNotebookPendingSubmit({ requestId: payload().requestId, admittedVersion: 2 }))
      .toEqual({ requestId: payload().requestId.toLowerCase(), admittedVersion: 2 });
    const input = { expectedJournalVersion: 0, payload: payload() };
    Object.defineProperty(input, 'payload', { enumerable: true, get() { throw new Error('should not execute'); } });
    expect(() => normalizeNotebookPendingAdmission('create', input)).toThrow('unsupported fields');
    for (const extra of [{ admittedVersion: 0 }, { requestId: 'invalid' }, { admittedVersion: '1' }]) {
      expect(() => normalizeNotebookPendingSubmit({ requestId: payload().requestId, admittedVersion: 1, ...extra })).toThrow();
    }
  });
});
