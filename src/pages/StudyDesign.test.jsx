import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import StudyDesign from './StudyDesign';

const workspace = {
  selectedProjectId: 'proj_private_1',
  projects: [{ id: 'proj_private_1', role: 'analyst' }],
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

  it('makes study-design mutation controls read-only for viewers without sending a request', async () => {
    window.electronAPI.createStudyCondition = vi.fn();
    render(
      <StudyDesign
        currentWs={{ ...workspace, projects: [{ id: 'proj_private_1', role: 'viewer' }] }}
        datasetInfo={{ id: 'ao_private_1', projectId: 'proj_private_1' }}
      />
    );

    expect(await screen.findByText(/Study design is read-only/i)).toBeInTheDocument();
    expect(screen.getByLabelText('Condition name')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Add condition' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Add condition' }));
    expect(window.electronAPI.createStudyCondition).not.toHaveBeenCalled();
  });

  it('explains why one metadata group cannot be mapped to multiple samples', async () => {
    window.electronAPI.listAnalysisObjectSampleBindings.mockResolvedValueOnce([{
      id: 'binding_1', sampleName: 'Sample 1', cellMetadataColumn: 'orig.ident', cellMetadataValue: 'SeuratProject',
    }]);
    window.electronAPI.bindSampleToAnalysisObject = vi.fn(async () => {
      throw Object.assign(new Error('This metadata value is already mapped.'), { code: 'METADATA_VALUE_ALREADY_BOUND' });
    });
    window.electronAPI.listBiologicalSamples.mockResolvedValue([{
      id: 'sample_2', name: 'Sample 2', conditionName: 'treated',
    }]);
    render(<StudyDesign currentWs={workspace} datasetInfo={{ id: 'ao_private_1', projectId: 'proj_private_1' }} />);

    fireEvent.change(await screen.findByLabelText('Bound sample'), { target: { value: 'sample_2' } });
    fireEvent.change(screen.getByLabelText('Metadata value'), { target: { value: 'SeuratProject' } });
    fireEvent.click(screen.getByRole('button', { name: 'Bind sample' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/One metadata value cannot represent multiple independent samples/i);
  });

  it('warns before condition inference when the attached object has one orig.ident group', async () => {
    const callApi = vi.fn(async () => ({ n_unique: 1 }));
    render(
      <StudyDesign
        currentWs={workspace}
        datasetInfo={{
          id: 'ao_private_1', projectId: 'proj_private_1', liveState: 'attached', ownerUserId: 7,
        }}
        userId={7}
        callApi={callApi}
      />
    );

    expect(await screen.findByRole('status')).toHaveTextContent(/contains one orig.ident group/i);
    expect(callApi).toHaveBeenCalledWith('/meta-values?column=orig.ident');
  });
});
