import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useProjectPipelineSelection } from './useProjectPipelineSelection';

function trustedManifest(id, name) {
  return {
    schemaVersion: 1,
    id,
    name,
    tabs: [{ id: 'inspect', label: 'Inspect', moduleKey: 'inspectObject' }],
  };
}

function deferred() {
  let resolve;
  const promise = new Promise(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('useProjectPipelineSelection', () => {
  it('does not let a stale project GET overwrite a newer successful manager selection', async () => {
    const pendingSelection = deferred();
    const oldManifest = trustedManifest('old-pipeline', 'Old Pipeline');
    const newManifest = trustedManifest('new-pipeline', 'New Pipeline');
    const api = {
      getProjectPipelineSelection: vi.fn(() => pendingSelection.promise),
    };
    const { result } = renderHook(() => useProjectPipelineSelection({
      api,
      projectId: 'proj_1',
      userEmail: 'developer@example.test',
    }));

    act(() => {
      result.current.handlePipelineSelectionChanged(newManifest);
    });
    expect(result.current.activePipeline.id).toBe('new-pipeline');

    await act(async () => {
      pendingSelection.resolve({ definition: { manifest: oldManifest } });
      await pendingSelection.promise;
    });

    expect(result.current.activePipeline.id).toBe('new-pipeline');
  });
});
