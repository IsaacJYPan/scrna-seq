import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ExpertR from './ExpertR';

const currentWs = {
  selectedProjectId: 'proj_private_1',
  objects: [{
    id: 'ao_private_1',
    projectId: 'proj_private_1',
    ownerUserId: 7,
    displayName: 'PBMC cohort',
  }],
};

describe('ExpertR', () => {
  beforeEach(() => {
    window.electronAPI = {
      createProjectJob: vi.fn(async () => ({ id: 'job_internal_123' })),
    };
  });

  afterEach(() => {
    delete window.electronAPI;
    vi.restoreAllMocks();
  });

  it('uses researcher-facing saved-analysis copy without rendering internal run identifiers', async () => {
    const onExpertRSubmitted = vi.fn();
    const { container } = render(
      <ExpertR
        currentWs={currentWs}
        datasetInfo={{ id: 'ao_private_1', projectId: 'proj_private_1' }}
        userId={7}
        onExpertRSubmitted={onExpertRSubmitted}
        deploymentPolicy={{
          expertREnabled: true,
          expertRProfile: { id: 'expert.r.v1', packages: ['Seurat'] },
        }}
      />
    );

    expect(screen.getByText('Saved analysis')).toBeInTheDocument();
    expect(screen.getByText(/private saved analysis/i)).toBeInTheDocument();
    expect(screen.getByText('PBMC cohort')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /run r analysis/i }));

    await waitFor(() => {
      expect(window.electronAPI.createProjectJob).toHaveBeenCalledWith('proj_private_1', expect.objectContaining({
        analysisObjectId: 'ao_private_1',
      }));
    });
    expect(onExpertRSubmitted).toHaveBeenCalledWith('job_internal_123');
    expect(await screen.findByText(/run submitted/i)).toBeInTheDocument();

    const rendered = container.textContent || '';
    expect(rendered).not.toMatch(/job_internal_123|ao_private_1|expert\.r\.v1/i);
    expect(rendered).not.toMatch(/checkpoint-backed object|project history/i);
  });

  it('replaces a hostile Expert R queue error with researcher-safe recovery text', async () => {
    window.electronAPI.createProjectJob.mockRejectedValueOnce(new Error(JSON.stringify({
      error: 'Rscript failed at C:\\private\\expert.R https://worker.internal/api/job_unsafe_expert',
    })));
    const { container } = render(
      <ExpertR
        currentWs={currentWs}
        datasetInfo={{ id: 'ao_private_1', projectId: 'proj_private_1' }}
        userId={7}
        deploymentPolicy={{
          expertREnabled: true,
          expertRProfile: { id: 'expert.r.v1', packages: ['Seurat'] },
        }}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /run r analysis/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not queue Expert R. Review the saved analysis and script, then try again.');
    expect(container.textContent || '').not.toMatch(/C:\\private\\expert\.R|worker\.internal|job_unsafe_expert/i);
  });

  it('explains unavailable access and provides a project-owner route', () => {
    const setActiveTab = vi.fn();
    render(<ExpertR currentWs={currentWs} userId={7} setActiveTab={setActiveTab} deploymentPolicy={{ expertREnabled: false }} />);
    expect(screen.getByText(/not been enabled for this account or deployment/i)).toBeInTheDocument();
    expect(screen.getByText(/project owner or deployment administrator/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /open project collaborators/i }));
    expect(setActiveTab).toHaveBeenCalledWith('team');
    expect(screen.queryByText(/ephemeral Expert R sandbox/i)).not.toBeInTheDocument();
  });
  it('explains missing runtime setup and can refresh into a verified ready workspace', async () => {
    window.electronAPI.getExpertRCapabilities = vi.fn()
      .mockResolvedValueOnce({ expertREnabled: false, expertRProfile: null, expertRStatus: { state: 'not-configured' } })
      .mockResolvedValueOnce({ expertREnabled: true, expertRProfile: { id: 'expert.r.v1', packages: ['Seurat'] }, expertRStatus: { state: 'ready', accessPolicy: 'project-roles' } });
    render(<ExpertR currentWs={currentWs} datasetInfo={{ id: 'ao_private_1', projectId: 'proj_private_1' }} userId={7} deploymentPolicy={{ expertREnabled: false }} />);
    expect(await screen.findByText(/runtime has not been configured/i)).toBeInTheDocument();
    expect(window.electronAPI.getExpertRCapabilities).toHaveBeenCalledWith('proj_private_1');
    fireEvent.click(screen.getByText('Set up private R'));
    expect(screen.getByText('node scripts/configure-private-r.js --help')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Check R availability' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Check R availability' }));
    expect(await screen.findByText(/Isolated R runtime ready/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run R analysis' })).toBeEnabled();
  });
  it('shows explicit revocation and offers status checks without an execution control', () => {
    render(<ExpertR currentWs={currentWs} userId={7} deploymentPolicy={{ expertREnabled: false, expertRStatus: { state: 'access-revoked' } }} />);
    expect(screen.getByText(/administrator has revoked R execution/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Run R analysis' })).not.toBeInTheDocument();
  });
  it('keeps anonymous demo restrictions separate from private installation setup', () => {
    render(<ExpertR currentWs={currentWs} userId={7} deploymentPolicy={{ expertREnabled: false, demoMode: true }} />);
    expect(screen.getByText(/unavailable in the public demo/i)).toBeInTheDocument();
    expect(screen.queryByText('Set up private R')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Check R availability' })).not.toBeInTheDocument();
  });

  it('offers only analyses owned by the current researcher and links to the private result', async () => {
    const setActiveTab = vi.fn();
    render(
      <ExpertR
        currentWs={{
          ...currentWs,
          objects: [...currentWs.objects, {
            id: 'ao_collaborator_1',
            projectId: 'proj_private_1',
            ownerUserId: 29,
            displayName: 'Collaborator analysis',
          }],
        }}
        datasetInfo={{ id: 'ao_private_1', projectId: 'proj_private_1' }}
        userId={7}
        setActiveTab={setActiveTab}
        deploymentPolicy={{
          expertREnabled: true,
          expertRProfile: { id: 'expert.r.v1', packages: ['Seurat'] },
        }}
      />
    );

    expect(screen.queryByRole('option', { name: 'Collaborator analysis' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /run r analysis/i }));
    expect(await screen.findByText(/run submitted/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /view in runs & results/i }));
    expect(setActiveTab).toHaveBeenCalledWith('history');
  });

  it('explains when the researcher has no eligible saved analysis', () => {
    render(
      <ExpertR
        currentWs={currentWs}
        datasetInfo={{ id: 'ao_private_1', projectId: 'proj_private_1' }}
        userId={29}
        deploymentPolicy={{
          expertREnabled: true,
          expertRProfile: { id: 'expert.r.v1', packages: ['Seurat'] },
        }}
      />
    );

    expect(screen.getByText(/no saved analysis you own/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /run r analysis/i })).toBeDisabled();
  });

  it('offers RDS as an explicitly sandbox-only private input', async () => {
    window.electronAPI.listExpertRInputs = vi.fn(async () => []);
    window.electronAPI.uploadExpertRInput = vi.fn(async (_projectId, file) => ({
      id: 'eri_aaaaaaaaaaaaaaaaaaaaaaaa', originalFilename: file.name, sizeBytes: file.size,
    }));
    render(
      <ExpertR
        currentWs={currentWs}
        datasetInfo={{ id: 'ao_private_1', projectId: 'proj_private_1' }}
        userId={7}
        deploymentPolicy={{
          expertREnabled: true,
          expertRProfile: { id: 'expert.r.v1', packages: ['Seurat'] },
        }}
      />
    );
    const picker = screen.getByLabelText(/choose private input/i);
    expect(picker.getAttribute('accept')).toContain('.rds');
    expect(screen.getByText(/RDS files remain untrusted/i)).toBeInTheDocument();
    const file = new File(['serialized-test-object'], 'derived.rds', {
      type: 'application/octet-stream',
    });
    fireEvent.change(picker, { target: { files: [file] } });
    fireEvent.click(screen.getByRole('button', { name: /import file/i }));
    await waitFor(() => {
      expect(window.electronAPI.uploadExpertRInput).toHaveBeenCalledWith('proj_private_1', file);
    });
    expect(await screen.findByText('derived.rds')).toBeInTheDocument();
  });
});
