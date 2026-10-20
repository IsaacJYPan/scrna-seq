import { describe, expect, it } from 'vitest';
import { NOTEBOOK_DRAFT_LIMITS, canonicalNotebookDraftSnapshot, normalizeNotebookDraft,
  normalizeNotebookDraftClear } from '../shared/notebookDraft.mjs';

const input = (extra = {}) => ({ requestId: '550E8400-E29B-41D4-A716-446655440000', expectedDraftVersion: 0,
  baseVersion: 3, baseVersionId: 'dv_' + 'a'.repeat(24), title: '  Private title  ',
  content: { schema: 'traceomics.notebook.v1', defaultLanguage: 'R', metadata: { z: 1, a: 2 },
    cells: [{ id: 'inspect', type: 'code', language: 'R', source: '  x <- "β"\r\n\t\n' }] }, ...extra });

describe('private notebook working-copy contract', () => {
  it('preserves exact source and saved-base identity while normalizing inert defaults and UUIDs', () => {
    const value = normalizeNotebookDraft(input());
    expect(value).toMatchObject({ requestId: '550e8400-e29b-41d4-a716-446655440000', expectedDraftVersion: 0,
      baseVersion: 3, baseVersionId: 'dv_' + 'a'.repeat(24), title: 'Private title', uiState: { activeCellId: null, scrollTop: 0 } });
    expect(value.content.cells[0].source).toBe(input().content.cells[0].source);
    expect(canonicalNotebookDraftSnapshot(value)).toBe(canonicalNotebookDraftSnapshot(normalizeNotebookDraft(value)));
  });

  it('requires an exact saved source base, positive saved versions and monotonic draft CAS input', () => {
    for (const extra of [{ baseVersionId: 'dv_invalid' }, { baseVersionId: null }, { baseVersion: 0 },
      { expectedDraftVersion: -1 }, { expectedDraftVersion: 1.5 }, { expectedDraftVersion: 2147483647 }]) {
      expect(() => normalizeNotebookDraft(input(extra))).toThrow();
    }
  });

  it('bounds view state to an existing cell and finite scroll position without storing editor or runtime objects', () => {
    expect(normalizeNotebookDraft(input({ uiState: { activeCellId: 'inspect', scrollTop: NOTEBOOK_DRAFT_LIMITS.scrollTop } })).uiState)
      .toEqual({ activeCellId: 'inspect', scrollTop: NOTEBOOK_DRAFT_LIMITS.scrollTop });
    for (const uiState of [{ activeCellId: 'absent' }, { activeCellId: 1 }, { scrollTop: -1 }, { scrollTop: Infinity },
      { scrollTop: NaN }, { scrollTop: NOTEBOOK_DRAFT_LIMITS.scrollTop + 1 }, { editorState: 'source' }, { kernel: {} }]) {
      expect(() => normalizeNotebookDraft(input({ uiState }))).toThrow();
    }
  });

  it('rejects injected identity, grants, pending operations, accessors and malformed source metadata', () => {
    for (const extra of [{ ownerUserId: 4 }, { visibility: 'project' }, { pending: {} }, { content: { ...input().content, outputs: [] } }]) {
      expect(() => normalizeNotebookDraft(input(extra))).toThrow();
    }
    const getter = input(); Object.defineProperty(getter, 'title', { enumerable: true, get() { throw new Error('Getter must not execute'); } });
    expect(() => normalizeNotebookDraft(getter)).toThrow('unsupported fields');
  });

  it('does not include transport UUID/CAS in the private snapshot checksum, but does include title/base/view state', () => {
    const original = canonicalNotebookDraftSnapshot(normalizeNotebookDraft(input()));
    expect(canonicalNotebookDraftSnapshot(normalizeNotebookDraft(input({ requestId: '550e8400-e29b-41d4-a716-446655440001', expectedDraftVersion: 9 })))).toBe(original);
    for (const extra of [{ title: 'Different' }, { baseVersion: 4 }, { uiState: { activeCellId: 'inspect' } }]) {
      expect(canonicalNotebookDraftSnapshot(normalizeNotebookDraft(input(extra)))).not.toBe(original);
    }
  });

  it('keeps discard requests source-free and CAS protected', () => {
    expect(normalizeNotebookDraftClear({ requestId: input().requestId, expectedDraftVersion: 7 }))
      .toEqual({ requestId: input().requestId.toLowerCase(), expectedDraftVersion: 7 });
    expect(() => normalizeNotebookDraftClear({ requestId: input().requestId, expectedDraftVersion: 7, content: input().content })).toThrow();
    expect(() => normalizeNotebookDraftClear({ requestId: 'invalid', expectedDraftVersion: 7 })).toThrow();
  });
});
