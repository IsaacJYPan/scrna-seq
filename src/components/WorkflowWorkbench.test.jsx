import React, { useCallback, useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import WorkflowWorkbench from './WorkflowWorkbench';
import { workflowRequest } from '../pipelines/workflowApi';
import { getArtifactVersion, previewArtifactVersion } from '../artifacts/artifactApi';

vi.mock('../pipelines/workflowApi', () => ({ workflowRequest: vi.fn(), workflowUrl: (project, suffix) => `/api/workflows/${project}/${suffix}` }));
vi.mock('../artifacts/artifactApi', () => ({ getArtifactVersion: vi.fn(), previewArtifactVersion: vi.fn() }));
let instance, restored, requests;
const outputId = 'eri_' + '1'.repeat(24), checksum = 'a'.repeat(64);
const metadata = { artifactId: outputId, versionId: outputId, projectId: 'proj_one', name: 'Saved workflow summary', sha256: checksum, format: { id: 'org.ietf.json', version: '1' }, previews: ['metrics'] };
const metricPreview = { family: 'metrics', source: { artifactId: outputId, versionId: outputId, projectId: 'proj_one', sha256: checksum }, semantics: { role: null, title: null }, items: [{ key: 'cells', value: 80, label: null, unit: null }] };
const step = {
  id: 'qc', label: 'Quality Control', inputs: { analysis: { from: 'input.analysis', type: 'rds' } },
  parameters: [{ key: 'minimum', label: 'Minimum features', type: 'integer', default: 5, min: 0, max: 100 }],
  outputs: { summary: { type: 'metrics', label: 'Summary' } },
};
function Workbench() {
  const [current, setCurrent] = useState(instance);
  const update = useCallback(value => setCurrent(value), []);
  return <WorkflowWorkbench instance={current} projectId="proj_one" activeTab="workflow:qc" onUpdate={update} onExit={vi.fn()} enabled />;
}
beforeEach(() => {
  vi.clearAllMocks();
  requests = [];
  getArtifactVersion.mockResolvedValue(metadata);
  previewArtifactVersion.mockResolvedValue({ version: metadata, integrityVerified: true, preview: metricPreview });
  instance = {
    id: 'wfi_one', analysisObjectId: 'ao_one',
    package: { name: 'Sample', version: '1.0.0', steps: [step], tabs: [{ id: 'qc', step: 'qc', plots: [] }] },
    state: { root: { id: 'root' }, generation: 1, active: null, results: { qc: { parameters: { minimum: 5 }, seed: 1, outputs: { summary: { id: outputId, type: 'metrics', sha256: checksum } } } } },
  };
  restored = structuredClone(instance);
  restored.state.generation = 2;
  restored.state.results.qc.parameters.minimum = 10;
  workflowRequest.mockImplementation(async (project, suffix, method, body) => {
    requests.push({ project, suffix, method, body });
    if (suffix === 'snapshots') return [{ id: 'saved', name: 'Saved QC', analysisObjectId: 'ao_one' }];
    if (suffix === 'snapshots/saved/open') return restored;
    if (suffix.startsWith('artifacts/')) return { cells: 80 };
    return instance;
  });
});
afterEach(() => { delete window.desktopShell; vi.restoreAllMocks(); });

it('requires a fresh authorized read after tunnel loss while retaining local parameter drafts', async () => {
  let notify;
  const target={id:'lab',status:'connected',serviceIdentity:'selected-lab',sshTunnel:{state:'connected'}};
  window.desktopShell={getCurrentTarget:async()=>target,onTargetStatus:listener=>{notify=listener;return()=>{};}};
  render(<Workbench/>);
  await screen.findByText('80');
  await waitFor(()=>expect(screen.getByRole('button',{name:'Run Quality Control'})).toBeEnabled());
  act(()=>notify({...target,sshTunnel:{state:'disconnected'}}));
  expect(screen.getByRole('button',{name:'Run Quality Control'})).toBeDisabled();
  expect(screen.queryByText('80')).not.toBeInTheDocument();
  expect(screen.getByText(/Reconnect to the same workspace/)).toBeVisible();
  fireEvent.change(screen.getByLabelText('Minimum features'),{target:{value:'20'}});
  expect(screen.getByLabelText('Minimum features')).toHaveValue(20);
  fireEvent.click(screen.getByRole('button',{name:'Run Quality Control'}));
  expect(requests.some(request=>request.method==='POST')).toBe(false);
  act(()=>notify(target));
  expect(await screen.findByText('80')).toBeVisible();
  expect(getArtifactVersion).toHaveBeenCalledTimes(2);
  expect(requests.some(request => request.suffix.startsWith('artifacts/'))).toBe(false);
});

it('keeps applied output when a draft changes and submits settings only on Run', async () => {
  render(<Workbench />);
  await screen.findByText('80');
  fireEvent.change(screen.getByLabelText('Minimum features'), { target: { value: '20' } });
  expect(screen.getByText('80')).toBeInTheDocument();
  expect(requests.some(request => request.method === 'POST')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Run Quality Control' }));
  await waitFor(() => expect(requests).toEqual(expect.arrayContaining([expect.objectContaining({
    suffix: 'instances/wfi_one/run', method: 'POST', body: expect.objectContaining({ parameters: { minimum: 20 }, seed: 1 }),
  })])));
});

it('restores saved settings together with results, replacing unsent drafts', async () => {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  render(<Workbench />);
  fireEvent.change(screen.getByLabelText('Minimum features'), { target: { value: '99' } });
  fireEvent.click(screen.getByText('Saved workflows for this analysis'));
  fireEvent.click(await screen.findByRole('button', { name: 'Open', exact: true }));
  await waitFor(() => expect(screen.getByLabelText('Minimum features')).toHaveValue(10));
  expect(screen.getByText('Opened Saved QC.')).toBeInTheDocument();
});

it('does not replace the current view when an old run response arrives after leaving', async () => {
  let finish;
  const onUpdate = vi.fn();
  workflowRequest.mockImplementation((project, suffix) => {
    if (suffix.endsWith('/run')) return new Promise(resolve => { finish = resolve; });
    if (suffix === 'snapshots') return Promise.resolve([]);
    if (suffix.startsWith('artifacts/')) return Promise.resolve({ cells: 80 });
    return Promise.resolve(instance);
  });
  const view = render(<WorkflowWorkbench instance={instance} projectId="proj_one" activeTab="workflow:qc" onUpdate={onUpdate} onExit={vi.fn()} enabled />);
  await screen.findByText('80');
  fireEvent.click(screen.getByRole('button', { name: 'Run Quality Control' }));
  view.unmount();
  onUpdate.mockClear();
  await act(async () => { finish(restored); });
  expect(onUpdate).not.toHaveBeenCalled();
});
