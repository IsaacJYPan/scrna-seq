import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
        paired: false,
        modelFormula: '~ condition',
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
    expect(screen.getAllByText('~ condition', { exact: true }).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Saved version: PBMC cohort')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /run edgeR pseudobulk/i }));
    expect(await screen.findByText(/Condition comparison started/i)).toBeInTheDocument();
    await waitFor(() => expect(window.electronAPI.createProjectJob).toHaveBeenCalled());
    // Status appears beside the button, and a second click cannot start a duplicate.
    expect(await screen.findByText(/Run started at .*The result appears here when it finishes/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /run edgeR pseudobulk/i })).toBeDisabled();

    expect(container.textContent).not.toMatch(/job_internal_1|contrast_internal_1|ao_private_1|Project History|immutable object|queued|canonical|checkpoint/i);
  });

  it('reports a newer failed run beside its contrast with the reason', async () => {
    window.electronAPI.listProjectJobs = vi.fn(async (_projectId, { status }) => (status === 'failed' ? [{
      id: 'job_failed', status: 'failed', parameters: { contrastId: 'contrast_internal_1' }, completedAt: '2026-01-03T00:00:00.000Z',
      error: { code: 'CONDITION_METADATA_ABSENT', message: 'Choose the saved version that contains the "cell_type" column and the sample column; this saved version does not have them.' },
    }] : []));
    window.electronAPI.listProjectJobArtifacts = vi.fn(async () => []);
    render(<StudyDesign currentWs={workspace} datasetInfo={{ id: 'ao_private_1', projectId: 'proj_private_1' }} />);
    expect(await screen.findByText(/Latest run did not finish.*Choose the saved version that contains the "cell_type" column/)).toBeInTheDocument();
  });

  it('shows the newest pseudobulk summary for a saved contrast', async () => {
    window.electronAPI.listProjectJobs = vi.fn(async (_projectId, { status }) => (status !== 'completed' ? [] : [
      { id: 'job_old', parameters: { contrastId: 'contrast_internal_1' }, completedAt: '2026-01-01T00:00:00.000Z' },
      { id: 'job_new', parameters: { contrastId: 'contrast_internal_1' }, completedAt: '2026-01-02T00:00:00.000Z' },
    ]));
    window.electronAPI.listProjectJobArtifacts = vi.fn(async (_projectId, jobId) => [{
      artifactType: 'condition_de_summary',
      metadata: { summary: {
        method: 'edgeR quasi-likelihood pseudobulk', sampleCount: 4, testedCellTypeCount: 2,
        significantResultCount: jobId === 'job_new' ? 7 : 1, skippedCellTypes: ['pDC'],
        topResults: [{ cellType: 'CD14 Mono', gene: 'IFIT3', logFc: 3.3, pValue: 3.3e-8, fdr: 2.27e-5 }],
      } },
    }]);
    const { container } = render(
      <StudyDesign currentWs={workspace} datasetInfo={{ id: 'ao_private_1', projectId: 'proj_private_1' }} />
    );
    const result = await screen.findByTestId('contrast-result');
    expect(result).toHaveTextContent('7 gene–cell type results at FDR ≤ 0.05');
    expect(result).toHaveTextContent('Skipped (too few cells or replicates): pDC');
    expect(within(result).getByText('IFIT3')).toBeInTheDocument();
    expect(within(result).getByText('2.27e-5')).toBeInTheDocument();
    expect(window.electronAPI.listProjectJobs).toHaveBeenCalledWith('proj_private_1', { jobType: 'condition.pseudobulk_de.v1', status: 'completed' });
    expect(container.textContent).not.toMatch(/job_new|job_old/);
  });

  it('registers and maps the samples recorded when a multi-condition analysis was prepared', async () => {
    const conditions = [];
    const samples = [];
    const bindings = [];
    Object.assign(window.electronAPI, {
      listStudyConditions: vi.fn(async () => conditions.slice()),
      listBiologicalSamples: vi.fn(async () => samples.slice()),
      listAnalysisObjectSampleBindings: vi.fn(async () => bindings.slice()),
      listConditionContrasts: vi.fn(async () => []),
      createStudyCondition: vi.fn(async (_p, { name }) => { conditions.push({ id: `c_${name}`, name }); }),
      createBiologicalSample: vi.fn(async (_p, body) => { samples.push({ id: `s_${body.name}`, ...body }); }),
      bindSampleToAnalysisObject: vi.fn(async (_p, _o, body) => { bindings.push(body); }),
    });
    const ws = {
      ...workspace,
      objects: [
        { id: 'ao_saved', projectId: 'proj_private_1', displayName: 'Saved', parentObjId: 'ao_prepared' },
        { id: 'ao_prepared', projectId: 'proj_private_1', displayName: 'Prepared', metadata: {
          sampleMetadataColumn: 'sample_id',
          sampleDesign: [
            { sampleName: 'd1', conditionName: 'ctrl', donorCode: 'D1' },
            { sampleName: 'd2', conditionName: 'stim', donorCode: 'D2' },
          ],
        } },
      ],
    };
    render(<StudyDesign currentWs={ws} datasetInfo={{ id: 'ao_saved', projectId: 'proj_private_1' }} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Use recorded samples' }));
    expect(await screen.findByText(/already registered and mapped/)).toBeInTheDocument();
    expect(window.electronAPI.createBiologicalSample).toHaveBeenCalledWith('proj_private_1', expect.objectContaining({
      name: 'd2', conditionId: 'c_stim', donorCode: 'D2', modality: 'scrna',
    }));
    expect(window.electronAPI.bindSampleToAnalysisObject).toHaveBeenCalledWith('proj_private_1', 'ao_saved', {
      sampleId: 's_d1', cellMetadataColumn: 'sample_id', cellMetadataValue: 'd1',
    });
    expect(bindings).toHaveLength(2);
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

    fireEvent.change(await screen.findByLabelText('Biological sample'), { target: { value: 'sample_2' } });
    fireEvent.change(screen.getByLabelText('Cell metadata value'), { target: { value: 'SeuratProject' } });
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
  it('checks the mapped sample column instead of orig.ident for a multi-sample cohort', async () => {
    window.electronAPI.listAnalysisObjectSampleBindings.mockResolvedValue(
      ['C1', 'C2', 'T1', 'T2'].map((value) => ({
        id: value, sampleName: value, cellMetadataColumn: 'sample_id', cellMetadataValue: value,
      }))
    );
    const callApi = vi.fn(async (endpoint) => ({ n_unique: endpoint.includes('sample_id') ? 4 : 1 }));
    render(<StudyDesign currentWs={workspace}
      datasetInfo={{ id: 'ao_private_1', projectId: 'proj_private_1', liveState: 'attached', ownerUserId: 7 }}
      userId={7} callApi={callApi} />);

    await waitFor(() => expect(callApi).toHaveBeenCalledWith('/meta-values?column=sample_id'));
    expect(callApi).not.toHaveBeenCalledWith('/meta-values?column=orig.ident');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('names the mapped column when it contains only one sample group', async () => {
    window.electronAPI.listAnalysisObjectSampleBindings.mockResolvedValue([{
      id: 'mapping', sampleName: 'Sample 1', cellMetadataColumn: 'sample id', cellMetadataValue: 'C1',
    }]);
    const callApi = vi.fn(async () => ({ n_unique: 1 }));
    render(<StudyDesign currentWs={workspace}
      datasetInfo={{ id: 'ao_private_1', projectId: 'proj_private_1', liveState: 'attached', ownerUserId: 7 }}
      userId={7} callApi={callApi} />);

    expect(await screen.findByRole('status')).toHaveTextContent(/contains one sample id group/i);
    expect(callApi).toHaveBeenCalledWith('/meta-values?column=sample%20id');
  });

  it('waits for sample mappings before inspecting the attached object', async () => {
    let finishMappings;
    window.electronAPI.listAnalysisObjectSampleBindings.mockImplementation(() => new Promise((resolve) => {
      finishMappings = resolve;
    }));
    const callApi = vi.fn(async () => ({ n_unique: 4 }));
    render(<StudyDesign currentWs={workspace}
      datasetInfo={{ id: 'ao_private_1', projectId: 'proj_private_1', liveState: 'attached', ownerUserId: 7 }}
      userId={7} callApi={callApi} />);

    await waitFor(() => expect(finishMappings).toBeTypeOf('function'));
    expect(callApi).not.toHaveBeenCalled();
    finishMappings([{ id: 'mapping', cellMetadataColumn: 'sample_id' }]);
    await waitFor(() => expect(callApi).toHaveBeenCalledWith('/meta-values?column=sample_id'));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('does not inspect the active R object when the form selects another saved version', async () => {
    const callApi = vi.fn(async () => ({ n_unique: 1 }));
    render(<StudyDesign currentWs={{ ...workspace, objects: [
      ...workspace.objects,
      { id: 'ao_other', projectId: 'proj_private_1', displayName: 'Other version', liveState: 'attached', ownerUserId: 7 },
    ] }}
      datasetInfo={{ id: 'ao_private_1', projectId: 'proj_private_1', liveState: 'attached', ownerUserId: 7 }}
      userId={7} callApi={callApi} />);

    await screen.findByRole('status');
    callApi.mockClear();
    fireEvent.change(screen.getByLabelText('Saved version'), { target: { value: 'ao_other' } });
    await waitFor(() => expect(window.electronAPI.listAnalysisObjectSampleBindings)
      .toHaveBeenLastCalledWith('proj_private_1', 'ao_other'));
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
    expect(callApi).not.toHaveBeenCalled();
  });

  it('keeps an unreplicated contrast blocked and explains the deficient condition', async () => {
    window.electronAPI.listConditionContrasts.mockResolvedValue([{
      id: 'contrast_single', analysisObjectId: 'ao_private_1', name: 'Single treated sample',
      numeratorConditionName: 'Treated', denominatorConditionName: 'Control', unitOfReplication: 'sample',
      status: 'invalid', validation: { issues: ['Treated has one independent sample; at least two are required.'] },
    }]);
    render(<StudyDesign currentWs={workspace} datasetInfo={{ id: 'ao_private_1', projectId: 'proj_private_1' }} />);
    expect(await screen.findByText('Treated has one independent sample; at least two are required.')).toBeInTheDocument();
    const run = screen.getByRole('button', { name: /run edgeR pseudobulk/i });
    expect(run).toBeDisabled();
    fireEvent.click(run);
    expect(window.electronAPI.createProjectJob).not.toHaveBeenCalled();
  });

  it('shows the biological replicates and their condition, donor, batch, and mappings without opening selectors', async () => {
    window.electronAPI.listStudyConditions.mockResolvedValue([{ id: 'treated', name: 'Treated' }]);
    window.electronAPI.listBiologicalSamples.mockResolvedValue([{
      id: 'sample_1', name: 'Treated donor one', conditionId: 'treated', donorCode: 'D1', batch: 'Run A', modality: 'scrna',
    }, { id: 'sample_2', name: 'Spatial sample', conditionName: 'Control', modality: 'spatial' }]);
    window.electronAPI.listAnalysisObjectSampleBindings.mockResolvedValue([{
      id: 'binding_1', sampleName: 'Treated donor one', cellMetadataColumn: 'sample_id', cellMetadataValue: 'T1',
    }]);
    render(<StudyDesign currentWs={workspace} datasetInfo={{ id: 'ao_private_1', projectId: 'proj_private_1' }} />);
    const table = await screen.findByRole('table');
    const sampleRow = within(table).getByRole('row', { name: /Treated donor one/ });
    expect(sampleRow).toHaveTextContent('Treated');
    expect(sampleRow).toHaveTextContent('D1');
    expect(sampleRow).toHaveTextContent('Run A');
    expect(sampleRow).toHaveTextContent('Single-cell RNA');
    expect(within(table).getByRole('row', { name: /Spatial sample/ })).toHaveTextContent('Spatial (metadata only)');
    expect(screen.getByLabelText('Current sample mappings')).toHaveTextContent('sample_id = T1');
  });

  it('opens the compact add-sample form and submits the same explicit replicate metadata', async () => {
    window.electronAPI.listStudyConditions.mockResolvedValue([{ id: 'treated', name: 'Treated' }]);
    window.electronAPI.listBiologicalSamples.mockResolvedValue([{ id: 'existing', name: 'Existing sample', conditionName: 'Treated' }]);
    window.electronAPI.createBiologicalSample = vi.fn(async () => ({}));
    render(<StudyDesign currentWs={workspace} datasetInfo={{ id: 'ao_private_1', projectId: 'proj_private_1' }} />);
    await screen.findByRole('table');
    const disclosure = screen.getByText('Add a biological sample').closest('details');
    expect(disclosure).not.toHaveAttribute('open');
    fireEvent.click(screen.getByText('Add a biological sample'));
    fireEvent.change(screen.getByLabelText('Sample name'), { target: { value: 'New donor' } });
    fireEvent.change(screen.getByLabelText('Condition', { selector: 'select' }), { target: { value: 'treated' } });
    fireEvent.change(screen.getByLabelText('Donor code'), { target: { value: 'D2' } });
    fireEvent.change(screen.getByLabelText('Batch'), { target: { value: 'Run B' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add sample' }));
    await waitFor(() => expect(window.electronAPI.createBiologicalSample).toHaveBeenCalledWith('proj_private_1', {
      name: 'New donor', conditionId: 'treated', donorCode: 'D2', batch: 'Run B', modality: 'scrna',
    }));
  });

  it('does not label previous-version mappings as current while another version is loading', async () => {
    window.electronAPI.listAnalysisObjectSampleBindings.mockResolvedValueOnce([{
      id: 'binding_1', sampleName: 'Original sample', cellMetadataColumn: 'sample_id', cellMetadataValue: 'Old value',
    }]);
    render(<StudyDesign currentWs={{ ...workspace, objects: [
      ...workspace.objects, { id: 'ao_other', projectId: 'proj_private_1', displayName: 'Other version' },
    ] }} datasetInfo={{ id: 'ao_private_1', projectId: 'proj_private_1' }} />);
    await waitFor(() => expect(screen.getByLabelText('Current sample mappings')).toHaveTextContent('Old value'));
    let finish;
    window.electronAPI.listAnalysisObjectSampleBindings.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    fireEvent.change(screen.getByLabelText('Saved version'), { target: { value: 'ao_other' } });
    await waitFor(() => expect(finish).toBeTypeOf('function'));
    expect(screen.getByLabelText('Current sample mappings')).not.toHaveTextContent('Old value');
    expect(screen.getByLabelText('Current sample mappings')).toHaveTextContent('Loading mappings');
    finish([]);
    await waitFor(() => expect(screen.getByLabelText('Current sample mappings')).toHaveTextContent('No samples mapped yet'));
  });

});
