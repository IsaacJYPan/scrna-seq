import React from 'react';
import { webcrypto } from 'node:crypto';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import SharedSnapshotLink from './SharedSnapshotCopyLink';
import * as linkContract from './sharedSnapshotLink';
import useExecutionTarget from '../runtime/useExecutionTarget';
import { publicationAnchor, publicationFull, publicationPreparation, publicationScope, publicationSummary } from '../analyses/snapshotPublicationTestFixtures';
import { validateSnapshotPublication } from '../analyses/snapshotPublicationValidation';

vi.mock('../runtime/useExecutionTarget', () => ({ default: vi.fn() }));
const native = { identity: 'current-native-profile', epoch: 1, blocked: false };
const originalAddress = window.location.href;
const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const exactUrl = record => `${window.location.origin}/lab/app/#/shared-snapshots/v1/${record.serviceId}/${record.projectId}/${record.analysisId}/${record.publicationId}/${record.snapshotSha256}`;
async function fixture({ withdrawn = false } = {}) {
  const publication = publicationFull({ state: withdrawn ? 'withdrawn' : 'published' });
  await validateSnapshotPublication(publication, publicationScope, publicationAnchor(publication));
  return { publication, projectId: publication.projectId, analysisId: publication.analysisId, serviceId: publication.serviceId,
    userId: 17, available: true, isActive: true };
}
beforeEach(() => {
  vi.resetAllMocks(); vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
  vi.stubGlobal('fetch', vi.fn()); useExecutionTarget.mockReturnValue(native);
  window.history.replaceState(null, '', '/lab/app/?requestId=private-request&source=/private/source#private-scratch');
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); window.history.replaceState(null, '', originalAddress); });

it('copies only the accepted closed five-field target from the served app path after an explicit click', async () => {
  const props = await fixture(), builder = vi.spyOn(linkContract, 'buildSharedSnapshotUrl'); render(<SharedSnapshotLink {...props} />);
  expect(navigator.clipboard.writeText).not.toHaveBeenCalled(); expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));
  expect(await screen.findByText('Link copied. The recipient must sign in and already have project access.')).toBeVisible();
  expect(navigator.clipboard.writeText).toHaveBeenCalledExactlyOnceWith(exactUrl(props.publication));
  expect(builder).toHaveBeenCalledWith({ serviceId: props.serviceId, projectId: props.projectId, analysisId: props.analysisId,
    publicationId: props.publication.publicationId, snapshotSha256: props.publication.snapshotSha256 }, expect.stringContaining('?requestId=private-request'));
  const input = screen.getByRole('textbox', { name: 'Shared snapshot link' });
  expect(input).toHaveAttribute('readonly'); expect(input).toHaveValue(exactUrl(props.publication));
  expect(input.value).not.toMatch(/private|requestId|source=|scratch|asp_[a-f0-9]|doc_|dv_/);
  expect(input.value).not.toContain(props.publication.preparationId); expect(fetch).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Select link' }));
  expect(input).toHaveFocus(); expect(input.selectionStart).toBe(0); expect(input.selectionEnd).toBe(input.value.length);
  expect(screen.getByText(/Local and SSH tunnel addresses may only work on this computer/)).toBeVisible();
});

it('waits for the clipboard promise and prevents a duplicate gesture from reporting an early success', async () => {
  const props = await fixture(), held = deferred(); navigator.clipboard.writeText.mockReturnValue(held.promise);
  render(<SharedSnapshotLink {...props} />); fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));
  expect(screen.getByRole('button', { name: 'Copying link…' })).toBeDisabled();
  expect(screen.queryByText(/^Link copied/)).not.toBeInTheDocument(); fireEvent.click(screen.getByRole('button', { name: 'Copying link…' }));
  expect(navigator.clipboard.writeText).toHaveBeenCalledOnce();
  await act(async () => held.resolve()); expect(screen.getByText(/^Link copied/)).toBeVisible();
});

it('offers a selectable exact URL after clipboard rejection without claiming success or displaying a private error', async () => {
  const props = await fixture(); navigator.clipboard.writeText.mockRejectedValue(new Error('Private clipboard provider path /secret'));
  render(<SharedSnapshotLink {...props} />); fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));
  expect(await screen.findByText('Automatic copy failed. Select and copy the exact link below.')).toBeVisible();
  expect(screen.queryByText(/^Link copied/)).not.toBeInTheDocument(); expect(screen.queryByText(/Private clipboard provider/)).not.toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: 'Shared snapshot link' })).toHaveValue(exactUrl(props.publication));
});

it.each([undefined, {}, { writeText: null }])('provides the same manual fallback when clipboard access is unavailable: %s', async clipboard => {
  const props = await fixture(); vi.stubGlobal('navigator', { clipboard }); render(<SharedSnapshotLink {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));
  expect(await screen.findByText('Clipboard access is unavailable. Select and copy the exact link below.')).toBeVisible();
  expect(screen.getByRole('textbox', { name: 'Shared snapshot link' })).toHaveValue(exactUrl(props.publication));
  expect(screen.queryByText(/^Link copied/)).not.toBeInTheDocument();
});

it('keeps the unsafe app address out of fallback text when the URL builder rejects it', async () => {
  const props = await fixture(); vi.spyOn(linkContract, 'buildSharedSnapshotUrl').mockImplementation(() => { throw new Error('https://user:secret@private/'); });
  render(<SharedSnapshotLink {...props} />); fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));
  expect(await screen.findByText(/A link could not be built for this app address/)).toBeVisible();
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument(); expect(screen.queryByText(/user:secret/)).not.toBeInTheDocument();
  expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
});

it.each([
  { projectId: 'proj_' + 'f'.repeat(16) }, { analysisId: 'ra_' + 'f'.repeat(24) }, { serviceId: 'svc_' + 'f'.repeat(32) },
  { serviceId: null }, { userId: 7 }, { userId: '' }, { userId: '017' }, { userId: 0 }, { userId: null },
  { available: false }, { isActive: false }, { blocked: true },
])('does not build or copy from an unverified current scope: %s', async changes => {
  const props = await fixture(), builder = vi.spyOn(linkContract, 'buildSharedSnapshotUrl'); render(<SharedSnapshotLink {...props} {...changes} />);
  expect(screen.getByRole('button', { name: 'Copy link' })).toBeDisabled(); expect(builder).not.toHaveBeenCalled();
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument(); expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
});

it('accepts the canonical string current viewer but never substitutes the publisher for the viewer', async () => {
  const props = await fixture(); render(<SharedSnapshotLink {...props} userId="17" />);
  fireEvent.click(screen.getByRole('button', { name: 'Copy link' })); await screen.findByText(/^Link copied/);
  expect(navigator.clipboard.writeText).toHaveBeenCalledWith(exactUrl(props.publication));
  expect(props.publication.publisherUserId).toBe(7); expect(props.publication.viewerUserId).toBe(17);
});

it.each(['list summary', 'private preparation', 'unconfirmed receipt', 'unknown schema', 'unknown policy'])('never treats a %s as a full accepted publication', async kind => {
  const props = await fixture();
  const publication = kind === 'list summary' ? publicationSummary(props.publication) : kind === 'private preparation' ? publicationPreparation()
    : kind === 'unconfirmed receipt' ? { requestId: '12345678-1234-4234-8234-123456789abc' }
      : kind === 'unknown schema' ? { ...props.publication, schema: 'future' } : { ...props.publication, policy: { state: 'pending' } };
  render(<SharedSnapshotLink {...props} publication={publication} />);
  expect(screen.getByRole('button', { name: 'Copy link' })).toBeDisabled(); expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
});

it('keeps an accepted withdrawn publication link exact and explains its source-free tombstone', async () => {
  const props = await fixture({ withdrawn: true }); render(<SharedSnapshotLink {...props} />);
  expect(screen.getByText('This exact link opens the withdrawn publication record. Its findings are no longer available.')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Copy link' })); await screen.findByText(/^Link copied/);
  expect(navigator.clipboard.writeText).toHaveBeenCalledWith(exactUrl(props.publication)); expect(fetch).not.toHaveBeenCalled();
});

it('removes a copied fallback and ignores a held old completion when the account or current authority changes', async () => {
  const props = await fixture(), held = deferred(); navigator.clipboard.writeText.mockReturnValue(held.promise);
  const view = render(<SharedSnapshotLink {...props} />); fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));
  expect(screen.getByRole('textbox')).toHaveValue(exactUrl(props.publication));
  view.rerender(<SharedSnapshotLink {...props} userId={18} />);
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument(); expect(screen.getByRole('button', { name: 'Copy link' })).toBeDisabled();
  await act(async () => held.resolve()); expect(screen.queryByText(/^Link copied/)).not.toBeInTheDocument();
});

it('does not let an older clipboard completion overwrite a later accepted publication attempt', async () => {
  const props = await fixture(), old = deferred(), later = deferred(); navigator.clipboard.writeText.mockReturnValueOnce(old.promise).mockReturnValueOnce(later.promise);
  const view = render(<SharedSnapshotLink {...props} />); fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));
  const next = publicationFull({ publicationId: 'aspub_' + 'e'.repeat(24) });
  await validateSnapshotPublication(next, publicationScope, publicationAnchor(next));
  view.rerender(<SharedSnapshotLink {...props} publication={next} />); expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Copy link' })); await act(async () => old.resolve());
  expect(screen.getByRole('button', { name: 'Copying link…' })).toBeDisabled(); expect(screen.queryByText(/^Link copied/)).not.toBeInTheDocument();
  expect(screen.getByRole('textbox')).toHaveValue(exactUrl(next)); await act(async () => later.resolve()); expect(screen.getByText(/^Link copied/)).toBeVisible();
});

it('clears pending clipboard feedback across a native target epoch and blocks copying while disconnected', async () => {
  const props = await fixture(), held = deferred(); navigator.clipboard.writeText.mockReturnValue(held.promise);
  const view = render(<SharedSnapshotLink {...props} />); fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));
  useExecutionTarget.mockReturnValue({ ...native, epoch: 2, blocked: true }); view.rerender(<SharedSnapshotLink {...props} />);
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument(); expect(screen.getByRole('button', { name: 'Copy link' })).toBeDisabled();
  await act(async () => held.resolve()); expect(screen.queryByText(/^Link copied/)).not.toBeInTheDocument();
});

it('clears stale copied status when the same publication is freshly observed withdrawn while keeping its exact URL', async () => {
  const props = await fixture(), view = render(<SharedSnapshotLink {...props} />); fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));
  await screen.findByText(/^Link copied/); const withdrawn = await fixture({ withdrawn: true });
  view.rerender(<SharedSnapshotLink {...withdrawn} />); expect(screen.queryByText(/^Link copied/)).not.toBeInTheDocument();
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument(); fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));
  await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(2));
  expect(navigator.clipboard.writeText.mock.calls[0][0]).toBe(navigator.clipboard.writeText.mock.calls[1][0]);
});
