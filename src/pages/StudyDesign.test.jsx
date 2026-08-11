import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import StudyDesign from './StudyDesign';

const workspace = {
  selectedProjectId: 'proj_private_1',
  objects: [{ id: 'ao_private_1', projectId: 'proj_private_1', displayName: 'PBMC cohort' }],
};

describe('StudyDesign', () => {
  beforeEach(() => {
    window.electronAPI = {
      listStudyConditions: vi.fn(async () => []),
      listBiologicalSamples: vi.fn(async () => []),
      listAnalysisObjectSampleBindings: vi.fn(async () => []),
      listConditionContrasts: vi.fn(async () => [{
        id: 'contrast_internal_1',
        analysisObjectId: 'ao_private_1',
        name: 'Treated vs control',
        numeratorConditionName: 'Treated',
        denominatorConditionName: 'Control',
        unitOfReplication: 'sample',
        cellTypeColumn: 'seurat_clusters',
        status: 'valid',
      }]),
      createProjectJob: vi.fn(async () => ({ id: 'job_internal_1' })),
    };
  });

  afterEach(() => {
    delete window.electronAPI;
    vi.restoreAllMocks();
  });

  it('reports a started condition comparison without rendering job or analysis identifiers', async () => {
    const { container } = render(
      <StudyDesign currentWs={workspace} datasetInfo={{ id: 'ao_private_1', projectId: 'proj_private_1' }} />
    );

    expect(await screen.findByText('PBMC cohort')).toBeInTheDocument();
    expect(screen.getByText('Saved version', { selector: 'label' })).toBeInTheDocument();
    expect(screen.getByText('Saved contrasts')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /run edgeR pseudobulk/i }));
    expect(await screen.findByText(/Condition comparison started/i)).toBeInTheDocument();
    await waitFor(() => expect(window.electronAPI.createProjectJob).toHaveBeenCalled());

    expect(container.textContent).not.toMatch(/job_internal_1|contrast_internal_1|ao_private_1|Project History|immutable object|queued|canonical|checkpoint/i);
  });

  it('replaces a hostile study-design error with researcher-safe recovery text', async () => {
    window.electronAPI.listStudyConditions.mockRejectedValueOnce(new Error(JSON.stringify({
      error: 'Rscript failed at C:\\private\\study-design.R https://worker.internal/api/job_unsafe_study',
    })));
    const { container } = render(
      <StudyDesign currentWs={workspace} datasetInfo={{ id: 'ao_private_1', projectId: 'proj_private_1' }} />
    );

    expect(await screen.findByRole('alert')).toHaveTextContent('Study-design operation failed. Review the settings and try again.');
    expect(container.textContent || '').not.toMatch(/C:\\private\\study-design\.R|worker\.internal|job_unsafe_study/i);
  });
});
