import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ExecutablePipelines from './ExecutablePipelines';
import { validateExecutablePipeline, pipelineRunScript } from '../pipelines/executablePipeline.mjs';

const pipeline = validateExecutablePipeline({
  format: 'traceomics-pipeline',
  schemaVersion: 1,
  id: 'cell-summary',
  name: 'Cell summary',
  version: '1.0.0',
  description: 'Count cells.',
  runtime: { language: 'r', profileId: 'scrna-r-4.5-bioconductor-3.22-v1' },
  script: 'print(ncol(obj))',
});
const storageKey = 'traceomics:pipelines:pipeline-test@example.test';
function show(overrides = {}) {
  return render(
    <ExecutablePipelines
      userEmail="pipeline-test@example.test"
      userId={7}
      projectId="proj_one"
      selectedObject={{ id: 'ao_owned', projectId: 'proj_one', ownerUserId: 7 }}
      canWriteProject
      deploymentPolicy={{
        expertREnabled: true,
        expertRProfile: { id: pipeline.runtime.profileId },
      }}
      setActiveTab={vi.fn()}
      {...overrides}
    />
  );
}

describe('installed executable pipelines', () => {
  beforeEach(() => {
    localStorage.removeItem(storageKey);
    window.electronAPI = { createProjectJob: vi.fn(async () => ({ id: 'job_new' })) };
  });
  afterEach(() => {
    localStorage.removeItem(storageKey);
    delete window.electronAPI;
  });

  it('previews and installs an imported file without executing or uploading it', async () => {
    show();
    const file = new File([JSON.stringify(pipeline)], 'cell-summary.pipeline.json', {
      type: 'application/json',
    });
    fireEvent.change(screen.getByLabelText('Pipeline package file'), { target: { files: [file] } });
    fireEvent.click(await screen.findByRole('button', { name: 'Install version 1.0.0' }));
    expect(JSON.parse(localStorage.getItem(storageKey))).toEqual([pipeline]);
    expect(window.electronAPI.createProjectJob).not.toHaveBeenCalled();
  });

  it('submits the pinned source to the existing runner on explicit Run', async () => {
    localStorage.setItem(storageKey, JSON.stringify([pipeline]));
    const onSubmitted = vi.fn();
    show({ onSubmitted });
    fireEvent.click(screen.getByRole('button', { name: 'Run Cell summary' }));
    await waitFor(() => expect(onSubmitted).toHaveBeenCalledWith('job_new'));
    expect(window.electronAPI.createProjectJob).toHaveBeenCalledWith('proj_one', {
      jobType: 'expert.r.v1',
      analysisObjectId: 'ao_owned',
      parameters: {
        profileId: pipeline.runtime.profileId,
        script: pipelineRunScript(pipeline),
        inputIds: [],
      },
    });
  });

  it('keeps installed pipelines separate when another account opens the library', () => {
    localStorage.setItem(storageKey, JSON.stringify([pipeline]));
    const firstAccount = show();
    expect(screen.getByRole('button', { name: 'Run Cell summary' })).toBeInTheDocument();
    firstAccount.unmount();
    show({ userEmail: 'other-pipeline-test@example.test' });
    expect(screen.queryByRole('button', { name: 'Run Cell summary' })).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem(storageKey))).toEqual([pipeline]);
  });

  it('does not update a different project after a pending submission completes', async () => {
    localStorage.setItem(storageKey, JSON.stringify([pipeline]));
    let complete;
    window.electronAPI.createProjectJob.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    const onSubmitted = vi.fn();
    const previousProject = show({ onSubmitted });
    fireEvent.click(screen.getByRole('button', { name: 'Run Cell summary' }));
    previousProject.unmount();
    complete({ id: 'job_previous_project' });
    await Promise.resolve();
    expect(onSubmitted).not.toHaveBeenCalled();
  });

  it.each([
    { deploymentPolicy: { expertREnabled: false, demoMode: true } },
    { selectedObject: { id: 'ao_other', projectId: 'proj_one', ownerUserId: 8 } },
    { selectedObject: { id: 'ao_other', projectId: 'proj_two', ownerUserId: 7 } },
    { canWriteProject: false },
    { unsavedLiveChanges: true },
    { deploymentPolicy: { expertREnabled: true, expertRProfile: { id: 'different-profile' } } },
  ])('does not run without an eligible saved analysis and runtime: %j', (overrides) => {
    localStorage.setItem(storageKey, JSON.stringify([pipeline]));
    show(overrides);
    const run = screen.getByRole('button', { name: 'Run Cell summary' });
    expect(run).toBeDisabled();
    fireEvent.click(run);
    expect(window.electronAPI.createProjectJob).not.toHaveBeenCalled();
  });
});
