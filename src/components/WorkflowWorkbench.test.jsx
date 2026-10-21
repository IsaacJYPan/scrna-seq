import React, { useCallback, useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import WorkflowWorkbench from './WorkflowWorkbench';
import { workflowRequest } from '../pipelines/workflowApi';
import { getArtifactVersion, previewArtifactVersion } from '../artifacts/artifactApi';
import { getWorkflowSnapshot, openWorkflowSnapshot } from '../analyses/researchAnalysisApi';
import { canonicalRetainedWorkflowSnapshot } from '../../shared/workflowSnapshot.mjs';
import { createHash } from 'node:crypto';

vi.mock('../pipelines/workflowApi', () => ({ workflowRequest: vi.fn(), workflowUrl: (project, suffix) => `/api/workflows/${project}/${suffix}` }));
vi.mock('../artifacts/artifactApi', () => ({ getArtifactVersion: vi.fn(), previewArtifactVersion: vi.fn() }));
vi.mock('../analyses/researchAnalysisApi', () => ({ getWorkflowSnapshot: vi.fn(), openWorkflowSnapshot: vi.fn() }));
let instance, restored, requests;
const outputId = 'eri_' + '1'.repeat(24), checksum = 'a'.repeat(64);
const instanceId = 'wfi_' + '2'.repeat(24), objectId = 'ao_' + '3'.repeat(24);
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
  return <WorkflowWorkbench instance={current} projectId="proj_one" userId={1} activeTab="workflow:qc" onUpdate={update} onExit={vi.fn()} enabled />;
}
beforeEach(() => {
  vi.clearAllMocks();
  requests = [];
  getArtifactVersion.mockResolvedValue(metadata);
  previewArtifactVersion.mockResolvedValue({ version: metadata, integrityVerified: true, preview: metricPreview });
  instance = {
    id: instanceId, projectId: 'proj_one', analysisObjectId: objectId, packageDigest: 'c'.repeat(64),
    package: { name: 'Sample', version: '1.0.0', steps: [step], tabs: [{ id: 'qc', step: 'qc', plots: [] }] },
    state: { root: { id: 'root' }, generation: 1, active: null, results: { qc: { parameters: { minimum: 5 }, seed: 1, outputs: { summary: { id: outputId, type: 'metrics', sha256: checksum } } } } },
  };
  restored = structuredClone(instance);
  restored.state.generation = 2;
  restored.state.results.qc.parameters.minimum = 10;
  const captured = { schema: 'traceomics.workflow-snapshot.v1', id: 'wfs_' + 'a'.repeat(24), projectId: 'proj_one', ownerUserId: 1,
    visibility: 'private', analysisObjectId: objectId, name: 'Saved QC', packageDigest: 'c'.repeat(64),
    package: instance.package, state: restored.state, support: { supported: true }, canReopen: true,
    workingInstance: { id: instanceId, generation: 1, active: false } };
  captured.sha256 = createHash('sha256').update(canonicalRetainedWorkflowSnapshot(captured)).digest('hex');
  getWorkflowSnapshot.mockResolvedValue({ snapshot: captured });
  openWorkflowSnapshot.mockImplementation(async (_project, _snapshot, input) => ({ replayed: false, canEditWorking: true, restoration: {
    schema: 'traceomics.workflow-restoration.v1', requestId: input.requestId, snapshotId: captured.id, sha256: captured.sha256,
    analysisObjectId: objectId, packageDigest: captured.packageDigest, instanceId, generation: 2 }, currentInstance: restored }));
  workflowRequest.mockImplementation(async (project, suffix, method, body) => {
    requests.push({ project, suffix, method, body });
    if (suffix.startsWith('snapshots?')) return [{ id: captured.id, name: 'Saved QC', analysisObjectId: objectId }];
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
    suffix: `instances/${instanceId}/run`, method: 'POST', body: expect.objectContaining({ parameters: { minimum: 20 }, seed: 1 }),
  })])));
});

it('reviews saved source and explicitly replaces identified working settings together with results', async () => {
  render(<Workbench />);
  fireEvent.change(screen.getByLabelText('Minimum features'), { target: { value: '99' } });
  fireEvent.click(screen.getByText('Recent saved workflows for this analysis'));
  fireEvent.click(await screen.findByRole('button', { name: 'Open', exact: true }));
  await screen.findByText('Captured source checksum verified');
  expect(openWorkflowSnapshot).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('checkbox', { name: 'Replace this identified working workflow' }));
  fireEvent.click(screen.getByRole('button', { name: 'Open saved workflow' }));
  await waitFor(() => expect(screen.getByLabelText('Minimum features')).toHaveValue(10));
  expect(openWorkflowSnapshot).toHaveBeenCalledWith('proj_one', expect.any(String), expect.objectContaining({ replace: true,
    expectedInstance: { id: instanceId, generation: 1 } }));
});
it.each(['close', 'leave'])('keeps an accepted late restore from replacing the view after %s', async action => {
  let finish;
  const accepted = openWorkflowSnapshot.getMockImplementation();
  openWorkflowSnapshot.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const onUpdate = vi.fn();
  const view = render(<WorkflowWorkbench instance={instance} projectId="proj_one" userId={1} activeTab="workflow:qc" onUpdate={onUpdate} onExit={vi.fn()} enabled />);
  fireEvent.click(screen.getByText('Recent saved workflows for this analysis'));
  fireEvent.click(await screen.findByRole('button', { name: 'Open', exact: true }));
  await screen.findByText('Captured source checksum verified'); fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Open saved workflow' }));
  await waitFor(() => expect(openWorkflowSnapshot).toHaveBeenCalledOnce());
  const args = openWorkflowSnapshot.mock.calls[0]; onUpdate.mockClear();
  if (action === 'close') fireEvent.click(screen.getByRole('button', { name: 'Close saved workflow details' }));
  else view.unmount();
  await act(async () => finish(await accepted(...args)));
  expect(onUpdate).not.toHaveBeenCalled();
});

it('does not replace the current view when an old run response arrives after leaving', async () => {
  let finish;
  const onUpdate = vi.fn();
  workflowRequest.mockImplementation((project, suffix) => {
    if (suffix.endsWith('/run')) return new Promise(resolve => { finish = resolve; });
    if (suffix.startsWith('snapshots?')) return Promise.resolve([]);
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
