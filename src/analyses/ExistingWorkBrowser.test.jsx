import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ExistingWorkBrowser from './ExistingWorkBrowser';
import { listExistingWork } from './researchAnalysisApi';

vi.mock('./researchAnalysisApi', () => ({ listExistingWork: vi.fn() }));
vi.mock('../components/RetainedArtifactView', () => ({ default: ({ reference }) => <div data-testid="saved-version">{JSON.stringify(reference)}</div> }));
const projectId = 'proj_one', ownId = 'ao_' + 'a'.repeat(24), otherId = 'ao_' + 'b'.repeat(24);
const reference = { kind: 'analysis-object', analysisObjectId: ownId, checkpointVersionId: 'art_' + 'c'.repeat(24), sha256: 'd'.repeat(64) };
const item = { id: ownId, kind: 'analysis-object', label: 'Donor biological analysis', type: 'seurat', ownership: 'yours', ownerUserId: 1,
  savedState: 'recorded', liveState: 'not-checked', notebookSource: 'not-linked', reference, createdAt: '2026-10-20T12:00:00Z', origin: { jobId: 'job_original', package: null } };
const colleague = { ...item, id: otherId, label: 'Colleague analysis', ownerUserId: 2, ownership: 'colleague', reference: null, savedState: 'restricted', origin: null };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const defaults = { projectId, userId: 1, projectName: 'Established study', canWrite: true, blocked: false, isActive: true, onClose: vi.fn(), onAdopt: vi.fn(), onOpenOriginal: vi.fn() };
beforeEach(() => {
  vi.resetAllMocks(); listExistingWork.mockResolvedValue({ projectId, kind: 'objects', items: [item, colleague], nextCursor: null });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ width: window.innerWidth, height: 800, top: 0, left: 0, right: window.innerWidth, bottom: 800 }));
  defaults.onAdopt.mockResolvedValue({ id: 'created_analysis' });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const choose = async (label = item.label) => fireEvent.click(await screen.findByRole('button', { name: new RegExp('^' + label) }));
describe('existing work adoption and inspection', () => {
  it('discloses source availability and original run without inventing notebook source or checking a live runtime', async () => {
    render(<ExistingWorkBrowser {...defaults} />); await choose();
    expect(screen.getByText(/Live compute state has not been checked/)).toBeVisible();
    expect(screen.getByText(/No notebook source is linked here/)).toBeVisible();
    fireEvent.click(screen.getByText('Recorded origin')); expect(screen.getByText('job_original')).toBeVisible();
    expect(defaults.onAdopt).not.toHaveBeenCalled(); expect(defaults.onOpenOriginal).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('textbox', { name: 'Adopted analysis name' }), { target: { value: 'Continue donor study' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start analysis with this saved version' }));
    await waitFor(() => expect(defaults.onAdopt).toHaveBeenCalledOnce());
    expect(defaults.onAdopt.mock.calls[0][0]).toMatchObject({ name: 'Continue donor study', references: [reference], description: '' });
    expect(defaults.onAdopt.mock.calls[0][0].requestId).toMatch(/^[a-f0-9-]{36}$/);
  });
  it('keeps the original request frozen through an uncertain reply and writer downgrade', async () => {
    defaults.onAdopt.mockRejectedValueOnce(new Error('Lost reply'));
    const view = render(<ExistingWorkBrowser {...defaults} />); await choose();
    fireEvent.click(screen.getByRole('button', { name: 'Start analysis with this saved version' }));
    await screen.findByRole('button', { name: 'Retry analysis creation' });
    const original = structuredClone(defaults.onAdopt.mock.calls[0][0]);
    expect(screen.getByRole('textbox', { name: 'Adopted analysis name' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Saved work category' })).toBeDisabled();
    view.rerender(<ExistingWorkBrowser {...defaults} canWrite={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry analysis creation' }));
    await waitFor(() => expect(defaults.onAdopt).toHaveBeenCalledTimes(2));
    expect(defaults.onAdopt.mock.calls[1][0]).toEqual(original);
  });
  it('allows another choice after a first known missing-source rejection, but keeps a previously uncertain request frozen', async () => {
    const missing = Object.assign(new Error('The selected saved version is no longer available. Refresh to choose another source.'), { status: 404, code: 'ANALYSIS_REFERENCE_NOT_FOUND' });
    defaults.onAdopt.mockRejectedValueOnce(missing);
    render(<ExistingWorkBrowser {...defaults} />); await choose();
    fireEvent.click(screen.getByRole('button', { name: 'Start analysis with this saved version' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This saved source is no longer available. Refresh saved work or choose another source.');
    expect(screen.getByRole('combobox', { name: 'Saved work category' })).not.toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'Adopted analysis name' })).not.toBeDisabled();
    defaults.onAdopt.mockRejectedValueOnce(new Error('Lost reply'));
    fireEvent.click(screen.getByRole('button', { name: 'Start analysis with this saved version' }));
    await screen.findByRole('button', { name: 'Retry analysis creation' });
    const frozen = structuredClone(defaults.onAdopt.mock.calls[1][0]);
    defaults.onAdopt.mockRejectedValueOnce(missing);
    fireEvent.click(screen.getByRole('button', { name: 'Retry analysis creation' }));
    await waitFor(() => expect(defaults.onAdopt).toHaveBeenCalledTimes(3));
    expect(defaults.onAdopt.mock.calls[2][0]).toEqual(frozen);
    expect(screen.getByRole('combobox', { name: 'Saved work category' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Refresh saved work' })).toBeDisabled();
  });
  it('returns to the source list when refresh removes a row selected while the request was in flight', async () => {
    vi.stubGlobal('innerWidth', 390);
    render(<ExistingWorkBrowser {...defaults} />);
    const row = await screen.findByRole('button', { name: new RegExp('^' + item.label) });
    const refresh = deferred(); listExistingWork.mockReturnValueOnce(refresh.promise);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh saved work' })); fireEvent.click(row);
    expect(screen.getByRole('button', { name: 'All saved work' })).toBeVisible();
    await act(async () => refresh.resolve({ projectId, kind: 'objects', items: [colleague], nextCursor: null }));
    expect(await screen.findByRole('button', { name: new RegExp('^' + colleague.label) })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'All saved work' })).toBeNull();
    const denial = deferred(); listExistingWork.mockReturnValueOnce(denial.promise);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh saved work' })); await choose(colleague.label);
    await act(async () => denial.reject(Object.assign(new Error('Revoked'), { status: 404 })));
    expect(screen.getByRole('button', { name: 'Refresh saved work' })).toBeVisible();
    expect(screen.getByRole('list', { name: 'Saved work list' })).toBeVisible();
  });
  it('keeps colleague private source inaccessible while explaining the next action', async () => {
    render(<ExistingWorkBrowser {...defaults} />); await choose(colleague.label);
    expect(screen.getByText(/source belongs to a colleague/)).toBeVisible();
    expect(screen.getByText(/Ask its owner to publish/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Inspect saved version' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Start analysis with this saved version' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open original object history' }));
    await waitFor(() => expect(defaults.onOpenOriginal).toHaveBeenCalledWith(otherId));
  });
  it('allows read-only owned-source inspection but never fresh analysis creation', async () => {
    render(<ExistingWorkBrowser {...defaults} canWrite={false} />); await choose();
    fireEvent.click(screen.getByRole('button', { name: 'Inspect saved version' }));
    // Nested lazy imports can settle slowly while the full suite transforms other modules.
    expect(await screen.findByTestId('saved-version', {}, { timeout: 5000 })).toHaveTextContent(reference.checkpointVersionId);
    expect(screen.queryByRole('form', { name: 'Start from saved work' })).toBeNull();
    expect(defaults.onAdopt).not.toHaveBeenCalled();
  });
  it('ignores an obsolete category result and rejects a foreign project response', async () => {
    const old = deferred(); listExistingWork.mockReturnValueOnce(old.promise);
    render(<ExistingWorkBrowser {...defaults} />);
    listExistingWork.mockResolvedValueOnce({ projectId, kind: 'results', items: [], nextCursor: null });
    fireEvent.change(screen.getByRole('combobox', { name: 'Saved work category' }), { target: { value: 'results' } });
    await screen.findByText('No saved results or files yet');
    await act(async () => old.resolve({ projectId, kind: 'objects', items: [item], nextCursor: null }));
    expect(screen.queryByRole('button', { name: new RegExp(item.label) })).toBeNull();
    listExistingWork.mockResolvedValueOnce({ projectId: 'another_project', kind: 'results', items: [item], nextCursor: null });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh saved work' }));
    await screen.findByRole('alert'); expect(screen.queryByRole('button', { name: new RegExp(item.label) })).toBeNull();
  });
  it('clears cached private metadata on a fresh access denial and keeps connection failures actionable', async () => {
    const view = render(<ExistingWorkBrowser {...defaults} />); await choose();
    listExistingWork.mockRejectedValueOnce(Object.assign(new Error('Revoked'), { status: 404 }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh saved work' })); await screen.findByRole('alert');
    expect(screen.queryByRole('textbox', { name: 'Adopted analysis name' })).toBeNull();
    expect(screen.queryByText('No analysis objects yet')).toBeNull();
    expect(screen.queryByText('Select saved work to review its version and start an analysis.')).toBeNull();
    expect(within(screen.getByRole('list', { name: 'Saved work list' })).queryAllByRole('button')).toHaveLength(0);
    view.rerender(<ExistingWorkBrowser {...defaults} blocked />);
    expect(screen.getByRole('button', { name: 'Refresh saved work' })).toBeDisabled();
  });
  it('preserves mobile list focus and position after inspecting a selected item', async () => {
    vi.stubGlobal('innerWidth', 390);
    render(<ExistingWorkBrowser {...defaults} />);
    const row = await screen.findByRole('button', { name: new RegExp('^' + item.label) });
    screen.getByRole('list', { name: 'Saved work list' }).scrollTop = 250;
    fireEvent.click(row); await waitFor(() => expect(screen.getByRole('button', { name: 'All saved work' })).toHaveFocus());
    fireEvent.click(screen.getByRole('button', { name: 'All saved work' }));
    expect(row).toHaveFocus(); expect(screen.getByRole('list', { name: 'Saved work list' }).scrollTop).toBe(250);
  });
});
