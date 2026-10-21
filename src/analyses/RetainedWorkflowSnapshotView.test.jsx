import React from 'react';
import { createHash } from 'node:crypto';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RetainedWorkflowSnapshotView from './RetainedWorkflowSnapshotView';
import { getWorkflowSnapshot } from './researchAnalysisApi';
import { canonicalRetainedWorkflowSnapshot } from '../../shared/workflowSnapshot.mjs';

vi.mock('./researchAnalysisApi', () => ({ getWorkflowSnapshot: vi.fn() }));
vi.mock('../components/RetainedArtifactView', () => ({ default: ({ reference }) => <p>Exact output {reference.versionId}</p> }));
const snapshotId = 'wfs_' + 'a'.repeat(24), objectId = 'ao_' + 'b'.repeat(24), instanceId = 'wfi_' + 'c'.repeat(24);
let snapshot, reference;
const onOpen = vi.fn();
const props = () => ({ projectId: 'proj_one', userId: 1, reference, canWrite: true, onOpenWorkflow: onOpen });
const fingerprint = value => createHash('sha256').update(canonicalRetainedWorkflowSnapshot(value)).digest('hex');
const response = (request, { accepted = 3, current = 3, canEditWorking = true, replayed = false } = {}) => ({ replayed, canEditWorking,
  restoration: { schema: 'traceomics.workflow-restoration.v1', requestId: request.requestId, snapshotId, sha256: reference.sha256,
    instanceId, analysisObjectId: objectId, packageDigest: snapshot.packageDigest, generation: accepted },
  currentInstance: current === null ? null : { id: instanceId, projectId: snapshot.projectId, analysisObjectId: objectId,
    packageDigest: snapshot.packageDigest, package: snapshot.package, state: { generation: current, active: null } } });
beforeEach(() => {
  vi.resetAllMocks();
  snapshot = { schema: 'traceomics.workflow-snapshot.v1', id: snapshotId, projectId: 'proj_one', ownerUserId: 1,
    visibility: 'private', analysisObjectId: objectId, name: 'Saved donor QC', packageDigest: 'd'.repeat(64),
    package: { id: 'donor-qc', name: 'Donor QC', version: '1.0.0', steps: [{ id: 'qc', label: 'Quality control' }], tabs: [{ id: 'qc' }],
      files: { 'analysis.R': 'window.untrustedCodeExecuted <- TRUE\n# <script>inert source</script>' } },
    state: { generation: 1, root: { id: 'art_' + 'e'.repeat(24) }, active: null, results: {} },
    support: { supported: true, message: '' }, canReopen: true, workingInstance: { id: instanceId, generation: 2, active: false } };
  snapshot.sha256 = fingerprint(snapshot); reference = { kind: 'workflow-snapshot', snapshotId, sha256: snapshot.sha256 };
  getWorkflowSnapshot.mockImplementation(async () => ({ snapshot: structuredClone(snapshot) }));
  onOpen.mockImplementation(async ({ request }) => response(request));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); delete window.untrustedCodeExecuted; });

describe('captured workflow inspection and deliberate reopen', () => {
  it('verifies exact private code/settings without executing them and keeps read-only inspection useful', async () => {
    render(<RetainedWorkflowSnapshotView {...props()} canWrite={false} />);
    await screen.findByText('Captured source checksum verified');
    fireEvent.click(screen.getByText('Captured method source')); fireEvent.click(screen.getByText('analysis.R'));
    expect(screen.getByText(/window.untrustedCodeExecuted/)).toBeVisible();
    expect(window.untrustedCodeExecuted).toBeUndefined();
    expect(screen.queryByRole('button', { name: 'Open saved workflow' })).toBeNull();
    expect(onOpen).not.toHaveBeenCalled();
    expect(getWorkflowSnapshot).toHaveBeenCalledOnce();
  });
  it.each(['checksum', 'owner', 'project'])('rejects an unrelated %s before presenting captured source', async field => {
    const wrong = structuredClone(snapshot);
    if (field === 'checksum') wrong.state.generation += 1;
    if (field === 'owner') wrong.ownerUserId = 2;
    if (field === 'project') wrong.projectId = 'another_project';
    getWorkflowSnapshot.mockResolvedValue({ snapshot: wrong });
    render(<RetainedWorkflowSnapshotView {...props()} />);
    await screen.findByRole('alert');
    expect(screen.queryByText('Captured source checksum verified')).toBeNull(); expect(onOpen).not.toHaveBeenCalled();
  });
  it('shows unsupported captured source without exposing a mutation or guessing a notebook', async () => {
    snapshot.support = { supported: false, message: 'The exact input is unavailable. Its captured source remains readable.' };
    render(<RetainedWorkflowSnapshotView {...props()} />);
    await screen.findByText('Captured source checksum verified');
    expect(screen.getByText(snapshot.support.message)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Open saved workflow' })).toBeNull();
  });
  it.each(['null-state', 'array-state', 'null-package', 'object-labels'])('keeps authentic unsupported %s inspectable as inert JSON', async type => {
    snapshot.support = { supported: false, message: 'This historical source is unsupported.' };
    if (type === 'null-state') snapshot.state = null;
    if (type === 'array-state') snapshot.state = ['legacy', { results: [] }];
    if (type === 'null-package') snapshot.package = null;
    if (type === 'object-labels') { snapshot.package.name = { legacy: 'name' }; snapshot.package.version = { old: 1 }; snapshot.state.root.id = { legacy: 'root' }; }
    snapshot.sha256 = fingerprint(snapshot); reference.sha256 = snapshot.sha256;
    render(<RetainedWorkflowSnapshotView {...props()} />);
    await screen.findByText('Captured source checksum verified');
    fireEvent.click(screen.getByText('Saved workflow identity')); fireEvent.click(screen.getByText('Captured source JSON'));
    expect(screen.getByText(/Unsupported fields have not been converted/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Open saved workflow' })).toBeNull();
    expect(onOpen).not.toHaveBeenCalled();
  });
  it('requires explicit identified replacement and preserves its UUID/body through unknown reply and reader downgrade', async () => {
    onOpen.mockRejectedValueOnce(new Error('Lost response'));
    const view = render(<RetainedWorkflowSnapshotView {...props()} />);
    const button = await screen.findByRole('button', { name: 'Open saved workflow' }); expect(button).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Replace this identified working workflow' })); fireEvent.click(button);
    await screen.findByRole('button', { name: 'Check original open request' });
    const original = structuredClone(onOpen.mock.calls[0][0].request);
    expect(original).toMatchObject({ sha256: reference.sha256, expectedInstance: { id: instanceId, generation: 2 }, replace: true });
    expect(screen.getByRole('checkbox')).toBeDisabled(); expect(screen.getByRole('button', { name: 'Refresh workflow details' })).toBeDisabled();
    view.rerender(<RetainedWorkflowSnapshotView {...props()} canWrite={false} />);
    onOpen.mockImplementationOnce(async ({ request }) => response(request, { canEditWorking: false, replayed: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Check original open request' }));
    await screen.findByText('The original open is confirmed. Your current project role allows inspection only; the working workflow was kept.');
    expect(onOpen.mock.calls[1][0].request).toEqual(original); expect(onOpen.mock.calls[1][0].retry).toBe(true);
    expect(screen.queryByRole('button', { name: 'Open saved workflow' })).toBeNull();
  });
  it('reports an accepted earlier open without replacing newer working results or a closed copy', async () => {
    onOpen.mockImplementationOnce(async ({ request }) => response(request, { current: 5, replayed: true }));
    render(<RetainedWorkflowSnapshotView {...props()} />); await screen.findByRole('button', { name: 'Open saved workflow' });
    fireEvent.click(screen.getByRole('checkbox')); fireEvent.click(screen.getByRole('button', { name: 'Open saved workflow' }));
    await screen.findByText('The original open is confirmed. A newer working state is kept; the saved snapshot was not reapplied.');
    expect(screen.getByRole('button', { name: 'Open saved workflow' })).toBeDisabled(); expect(screen.getByRole('checkbox')).not.toBeChecked();
    onOpen.mockImplementationOnce(async ({ request }) => response(request, { accepted: 6, current: null, replayed: true }));
    fireEvent.click(screen.getByRole('checkbox')); fireEvent.click(screen.getByRole('button', { name: 'Open saved workflow' }));
    await screen.findByText(/that working copy has since closed/);
    expect(onOpen.mock.calls[1][0].request.requestId).not.toBe(onOpen.mock.calls[0][0].request.requestId);
  });
  it('clears captured private source on a fresh denial and fences reads that finish after unmount', async () => {
    const view = render(<RetainedWorkflowSnapshotView {...props()} />); await screen.findByText('Captured source checksum verified');
    getWorkflowSnapshot.mockRejectedValueOnce(Object.assign(new Error('Unavailable'), { status: 404 }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh workflow details' })); await screen.findByRole('alert');
    expect(screen.queryByText('Captured method source')).toBeNull(); expect(screen.queryByRole('button', { name: 'Open saved workflow' })).toBeNull();
    let finish; getWorkflowSnapshot.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh workflow details' }));
    await waitFor(() => expect(finish).toBeTypeOf('function')); view.unmount();
    await act(async () => finish({ snapshot })); expect(screen.queryByText('Saved donor QC')).toBeNull();
  });
});
