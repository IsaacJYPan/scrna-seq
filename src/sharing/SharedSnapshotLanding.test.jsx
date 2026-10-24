import React from 'react';
import { webcrypto } from 'node:crypto';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import SharedSnapshotLanding from './SharedSnapshotLanding';
import { readSnapshotPublicationDocument, readSnapshotPublicationView } from '../analyses/snapshotPublicationApi';
import { readSnapshotPreparationDocument, readSnapshotPreparationView } from '../analyses/snapshotPreparationApi';
import { listSharedRevisionComments } from './sharedRevisionDiscussionApi';
import { validateSnapshotPublication } from '../analyses/snapshotPublicationValidation';
import { publicationAnchor, publicationFull, publicationScope } from '../analyses/snapshotPublicationTestFixtures';
import { savedSnapshotContent, snapshotRecipe, snapshotRecord } from '../analyses/snapshotPreparationTestFixtures';
import { linkedRecipe, linkedRecord, linkedTableBytes } from '../analyses/snapshotLinkedTestFixtures';
import { canonicalNotebookContent } from '../../shared/notebookDocument.mjs';
import useExecutionTarget from '../runtime/useExecutionTarget';

vi.mock('../analyses/snapshotPublicationApi', () => ({ readSnapshotPublicationView: vi.fn(), readSnapshotPublicationDocument: vi.fn() }));
vi.mock('../analyses/snapshotPreparationApi', () => ({ readSnapshotPreparationView: vi.fn(), readSnapshotPreparationDocument: vi.fn() }));
vi.mock('./sharedRevisionDiscussionApi', () => ({ listSharedRevisionComments: vi.fn() }));
vi.mock('../runtime/useExecutionTarget', () => ({ default: vi.fn() }));

const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
async function fixture({ prepared, withdrawn = false } = {}) {
  const record = publicationFull({ ...(prepared ? { prepared } : {}), state: withdrawn ? 'withdrawn' : 'published' });
  await validateSnapshotPublication(record, publicationScope, publicationAnchor(record));
  const target = Object.fromEntries(['serviceId', 'projectId', 'analysisId', 'publicationId', 'snapshotSha256'].map(key => [key, record[key]]));
  const state = { target, user: { id: 17, displayName: 'Colleague β' }, record, status: 'ready', error: '', available: true,
    serviceId: record.serviceId, accessEpoch: 1 };
  return { state, theme: 'light', setTheme: vi.fn(), onRefresh: vi.fn(), onReadFailure: vi.fn(), onLogout: vi.fn(), onOpenWorkspace: vi.fn() };
}

beforeEach(() => {
  vi.resetAllMocks(); vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('fetch', vi.fn()); delete window.desktopShell;
  useExecutionTarget.mockReturnValue({ identity: 'reader-current-workspace', epoch: 1, blocked: false });
  readSnapshotPublicationView.mockImplementation((_p, _a, _id, item) => Promise.resolve({ bytes: linkedTableBytes(item), type: 'application/json' }));
  readSnapshotPublicationDocument.mockResolvedValue({ bytes: new TextEncoder().encode(canonicalNotebookContent(savedSnapshotContent)), type: 'application/json' });
  listSharedRevisionComments.mockRejectedValue(Object.assign(new Error('Not available'), { status: 404, code: 'ANALYSIS_ATTACHMENT_NOT_FOUND' }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); delete window.desktopShell; });

it('opens the exact saved question with a distinct current viewer and lazy permitted source, without mounting execution or private readers', async () => {
  const props = await fixture(); render(<SharedSnapshotLanding {...props} />);
  // The first real preview crosses lazy imports while full-suite workers share CPU.
  expect(await screen.findByRole('cell', { name: 'donor α' }, { timeout: 5000 })).toBeVisible();
  expect(screen.getByRole('heading', { level: 1, name: props.state.record.package.analysis.name })).toBeVisible();
  expect(screen.getByText('Question retained in saved version 2.')).toBeVisible();
  expect(screen.getByText('Saved analysis 2')).toBeVisible();
  expect(screen.getByText(/Published by Researcher α/)).toBeVisible();
  expect(screen.getByText('Signed in as Colleague β')).toBeVisible();
  expect(readSnapshotPublicationView).toHaveBeenCalledWith(props.state.target.projectId, props.state.target.analysisId,
    props.state.target.publicationId, props.state.record.package.results[0], expect.objectContaining({ signal: expect.any(AbortSignal) }));
  expect(readSnapshotPreparationView).not.toHaveBeenCalled(); expect(readSnapshotPreparationDocument).not.toHaveBeenCalled();
  expect(readSnapshotPublicationDocument).not.toHaveBeenCalled(); expect(listSharedRevisionComments).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'View supporting source' }));
  expect((await screen.findByLabelText('Retained saved source')).textContent).toBe(savedSnapshotContent.cells[0].source);
  expect(readSnapshotPublicationDocument).toHaveBeenCalledOnce(); expect(fetch).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: /Run|Execute|Import|Publish|Withdraw|Save changes/ })).not.toBeInTheDocument();
  expect(screen.queryByLabelText(/Connection status|R runtime/)).not.toBeInTheDocument();
});

it('passes only the currently selected included exact attachment revision to the lazy live discussion', async () => {
  const attachment = { kind: 'attachment-revision', ...snapshotRecipe().results[0] };
  const prepared = linkedRecord(linkedRecipe({ results: [attachment, linkedRecipe().results[0]] }));
  const props = await fixture({ prepared }); render(<SharedSnapshotLanding {...props} />); await screen.findByRole('table');
  expect(await screen.findByRole('button', { name: 'Read revision discussion' })).toBeVisible();
  expect(listSharedRevisionComments).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Read revision discussion' }));
  await waitFor(() => expect(listSharedRevisionComments).toHaveBeenCalledOnce());
  expect(listSharedRevisionComments.mock.calls[0].slice(0, 4)).toEqual([props.state.target.projectId, props.state.target.analysisId,
    attachment.attachmentId, attachment.revisionId]);
  expect(await screen.findByRole('button', { name: 'Check snapshot access' })).toBeVisible();
  expect(props.onReadFailure).not.toHaveBeenCalled(); expect(screen.getByRole('table')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Check snapshot access' })); expect(props.onRefresh).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button', { name: /2\. Linked measured result/ }));
  expect(await screen.findByText('This finding has no linked saved-revision discussion.')).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Read revision discussion' })).not.toBeInTheDocument();
  expect(listSharedRevisionComments).toHaveBeenCalledOnce();
});

it.each(['serviceId', 'projectId', 'analysisId', 'publicationId', 'snapshotSha256'])('withholds protected content when the expected %s differs from a retained old record', async key => {
  const props = await fixture(); props.state.target = { ...props.state.target, [key]: `different-${key}` };
  render(<SharedSnapshotLanding {...props} />);
  expect(screen.getByRole('heading', { level: 1, name: 'This exact snapshot could not be confirmed' })).toBeVisible();
  expect(screen.queryByText(props.state.record.package.analysis.name)).not.toBeInTheDocument();
  expect(screen.queryByText('Question retained in saved version 2.')).not.toBeInTheDocument();
  expect(readSnapshotPublicationView).not.toHaveBeenCalled(); expect(readSnapshotPublicationDocument).not.toHaveBeenCalled();
  expect(listSharedRevisionComments).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('Linked workspace and exact snapshot')); expect(screen.getByText(`different-${key}`)).toBeVisible();
});

it.each([
  { user: { id: 18, displayName: 'Different colleague' } },
  { serviceId: 'svc_' + 'e'.repeat(32) },
])('does not reuse a previous viewer or installation as current authority', async changes => {
  const props = await fixture(); props.state = { ...props.state, ...changes }; render(<SharedSnapshotLanding {...props} />);
  expect(screen.getByRole('heading', { name: 'This exact snapshot could not be confirmed' })).toBeVisible();
  expect(screen.queryByRole('table')).not.toBeInTheDocument(); expect(readSnapshotPublicationView).not.toHaveBeenCalled();
});

it.each([
  ['loading', 'Checking this shared snapshot'], ['wrong-workspace', 'Connect to the linked workspace'],
  ['unreachable', 'The workspace could not be reached'], ['denied', 'This shared snapshot is not available to this account'],
  ['unverified', 'This exact snapshot could not be confirmed'],
])('renders %s guidance ahead of collapsed target details without leaking a retained old package', async (status, heading) => {
  const props = await fixture(); props.state = { ...props.state, status }; render(<SharedSnapshotLanding {...props} />);
  expect(screen.getByRole('heading', { level: 1, name: heading })).toBeVisible();
  expect(screen.queryByText(props.state.record.package.analysis.name)).not.toBeInTheDocument();
  expect(readSnapshotPublicationView).not.toHaveBeenCalled(); expect(readSnapshotPublicationDocument).not.toHaveBeenCalled();
  const details = screen.getByText('Linked workspace and exact snapshot').closest('details'); expect(details.open).toBe(false);
  expect(screen.getByRole('button', { name: status === 'loading' ? 'Checking current access…' : 'Try again' })).toHaveProperty('disabled', status === 'loading');
});

it('clears a previously readable body immediately on current access loss and ignores its older held success', async () => {
  const props = await fixture(), held = deferred(); readSnapshotPublicationView.mockReturnValue(held.promise);
  const view = render(<SharedSnapshotLanding {...props} />); await waitFor(() => expect(readSnapshotPublicationView).toHaveBeenCalledOnce());
  const signal = readSnapshotPublicationView.mock.calls[0][4].signal;
  view.rerender(<SharedSnapshotLanding {...props} state={{ ...props.state, status: 'denied', accessEpoch: 2 }} />);
  expect(screen.getByRole('heading', { name: 'This shared snapshot is not available to this account' })).toBeVisible(); expect(signal.aborted).toBe(true);
  await act(async () => { held.resolve({ bytes: linkedTableBytes(props.state.record.package.results[0]), type: 'application/json' }); });
  expect(screen.queryByRole('table')).not.toBeInTheDocument(); expect(screen.queryByText(props.state.record.package.analysis.name)).not.toBeInTheDocument();
});

it('hides retained findings when the workspace disconnects without calling the snapshot missing or signing out', async () => {
  const props = await fixture(), view = render(<SharedSnapshotLanding {...props} />); await screen.findByRole('table');
  view.rerender(<SharedSnapshotLanding {...props} state={{ ...props.state, available: false }} />);
  expect(screen.getByRole('heading', { name: 'The workspace could not be reached' })).toBeVisible();
  expect(screen.queryByRole('table')).not.toBeInTheDocument(); expect(screen.getByText('Signed in as Colleague β')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Try again' })); expect(props.onRefresh).toHaveBeenCalledOnce();
  expect(props.onLogout).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
});

it('shows an exact withdrawn tombstone without findings, source, comments or an editing action', async () => {
  const props = await fixture({ withdrawn: true }); render(<SharedSnapshotLanding {...props} />);
  expect(screen.getByRole('heading', { name: 'Snapshot withdrawn' })).toBeVisible();
  expect(screen.getByText(/Checking the original publication does not reactivate it/)).toBeVisible();
  expect(readSnapshotPublicationView).not.toHaveBeenCalled(); expect(readSnapshotPublicationDocument).not.toHaveBeenCalled();
  expect(listSharedRevisionComments).not.toHaveBeenCalled(); expect(screen.queryByRole('button', { name: /Publish|Withdraw|Execute/ })).not.toBeInTheDocument();
  fireEvent.click(screen.getByText('Linked workspace and exact snapshot')); expect(screen.getByText(props.state.target.snapshotSha256)).toBeVisible();
});

it('preserves the accepted saved question and other metadata while a corrupt body asks the root for an exact current check', async () => {
  const props = await fixture(), failure = Object.assign(new Error('Unavailable'), { status: 409, code: 'ANALYSIS_SNAPSHOT_VIEW_UNAVAILABLE' });
  readSnapshotPublicationView.mockRejectedValue(failure); render(<SharedSnapshotLanding {...props} />);
  expect(await screen.findByText('This retained view is unavailable or could not be verified. Its exact saved identity is kept.')).toBeVisible();
  expect(props.onReadFailure).toHaveBeenCalledWith(failure);
  expect(screen.getByRole('heading', { level: 1, name: props.state.record.package.analysis.name })).toBeVisible();
  expect(screen.getByRole('button', { name: 'View supporting source' })).toBeVisible();
  expect(readSnapshotPreparationView).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
});

it('keeps the same selected finding and lazy source on an equal verified refresh, but resets an opened discussion for a fresh authority epoch', async () => {
  const first = snapshotRecipe().results[0], second = { ...first, attachmentId: 'raa_' + 'f'.repeat(24), revisionId: 'rar_' + 'f'.repeat(24) };
  const props = await fixture({ prepared: snapshotRecord(snapshotRecipe({ results: [first, second] })) });
  const view = render(<SharedSnapshotLanding {...props} />); await screen.findByRole('table');
  fireEvent.click(screen.getByRole('button', { name: /2\. Measured expression contrast/ })); await waitFor(() => expect(readSnapshotPublicationView).toHaveBeenCalledTimes(2));
  fireEvent.click(screen.getByRole('button', { name: 'View supporting source' })); await screen.findByLabelText('Retained saved source');
  fireEvent.click(screen.getByRole('button', { name: 'Read revision discussion' })); await screen.findByRole('button', { name: 'Close discussion' });
  view.rerender(<SharedSnapshotLanding {...props} state={{ ...props.state, record: structuredClone(props.state.record), accessEpoch: 2 }} />);
  expect(screen.getByRole('button', { name: /2\. Measured expression contrast/ })).toHaveAttribute('aria-pressed', 'true');
  expect(await screen.findByRole('button', { name: 'Read revision discussion' })).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Close discussion' })).not.toBeInTheDocument();
  expect(screen.getByLabelText('Retained saved source')).toBeVisible();
  expect(readSnapshotPublicationView).toHaveBeenCalledTimes(2); expect(readSnapshotPublicationDocument).toHaveBeenCalledOnce();
});

it('restores a selected ID after authority revalidation without preserving body bytes, source expansion or discussion state', async () => {
  const first = snapshotRecipe().results[0], second = { ...first, attachmentId: 'raa_' + 'f'.repeat(24), revisionId: 'rar_' + 'f'.repeat(24) };
  const props = await fixture({ prepared: snapshotRecord(snapshotRecipe({ results: [first, second] })) }), onFindingSelection = vi.fn();
  const view = render(<SharedSnapshotLanding {...props} onFindingSelection={onFindingSelection} />); await screen.findByRole('table');
  fireEvent.click(screen.getByRole('button', { name: /2\. Measured expression contrast/ }));
  const chosen = props.state.record.package.results[1].viewId; expect(onFindingSelection).toHaveBeenCalledExactlyOnceWith(chosen);
  await waitFor(() => expect(readSnapshotPublicationView).toHaveBeenCalledTimes(2));
  fireEvent.click(screen.getByRole('button', { name: 'View supporting source' })); await screen.findByLabelText('Retained saved source');
  fireEvent.click(screen.getByRole('button', { name: 'Read revision discussion' })); await screen.findByRole('button', { name: 'Close discussion' });
  view.rerender(<SharedSnapshotLanding {...props} initialFindingId={chosen} onFindingSelection={onFindingSelection}
    state={{ ...props.state, record: null, user: null, status: 'loading', available: false, accessEpoch: 2 }} />);
  expect(screen.queryByRole('table')).not.toBeInTheDocument(); expect(screen.queryByLabelText('Retained saved source')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Close discussion' })).not.toBeInTheDocument();
  readSnapshotPublicationView.mockClear(); readSnapshotPublicationDocument.mockClear(); listSharedRevisionComments.mockClear(); onFindingSelection.mockClear();
  view.rerender(<SharedSnapshotLanding {...props} initialFindingId={chosen} onFindingSelection={onFindingSelection}
    state={{ ...props.state, accessEpoch: 3 }} />);
  expect(await screen.findByRole('table')).toBeVisible();
  expect(screen.getByRole('button', { name: /2\. Measured expression contrast/ })).toHaveAttribute('aria-pressed', 'true');
  expect(readSnapshotPublicationView).toHaveBeenCalledOnce(); expect(readSnapshotPublicationView.mock.calls[0][3].viewId).toBe(chosen);
  expect(readSnapshotPublicationDocument).not.toHaveBeenCalled(); expect(listSharedRevisionComments).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Read revision discussion' })).toBeVisible(); expect(screen.queryByRole('button', { name: 'Close discussion' })).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Retained saved source')).not.toBeInTheDocument(); expect(onFindingSelection).not.toHaveBeenCalled();
});

it('delegates theme, logout and explicit workspace navigation without changing the target or owning theme/session persistence', async () => {
  const props = await fixture(), original = structuredClone(props.state.target); render(<SharedSnapshotLanding {...props} theme="dark" />); await screen.findByRole('table');
  const storage = vi.spyOn(Storage.prototype, 'setItem');
  fireEvent.click(screen.getByRole('button', { name: 'Switch to light mode' })); expect(props.setTheme).toHaveBeenCalledWith('light');
  fireEvent.click(screen.getByRole('button', { name: 'Check current access' })); expect(props.onRefresh).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button', { name: 'Open workspace' })); expect(props.onOpenWorkspace).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button', { name: 'Sign out' })); expect(props.onLogout).toHaveBeenCalledOnce();
  expect(props.state.target).toEqual(original); expect(storage).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  expect(within(screen.getByLabelText('Current snapshot access')).getByRole('button', { name: 'Check current access' })).toBeVisible();
});

it.each([['loading', 'Checking account…'], ['unreachable', 'Account not confirmed']])('does not claim a signed-in account before session confirmation in %s', async (status, label) => {
  const props = await fixture(); render(<SharedSnapshotLanding {...props} state={{ ...props.state, user: null, status }} />);
  expect(screen.getByText(label)).toBeVisible(); expect(screen.queryByText(/Signed in as/)).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Sign out' })).not.toBeInTheDocument();
  expect(readSnapshotPublicationView).not.toHaveBeenCalled(); expect(listSharedRevisionComments).not.toHaveBeenCalled();
});

it('offers desktop server settings only when supported and opens them explicitly without starting a connection check', async () => {
  const props = await fixture(), view = render(<SharedSnapshotLanding {...props} state={{ ...props.state, status: 'wrong-workspace' }} />);
  expect(screen.queryByRole('button', { name: 'Server settings' })).not.toBeInTheDocument();
  const shell = { openTargetSettings: vi.fn().mockResolvedValue(undefined), getCurrentTarget: vi.fn() }; window.desktopShell = shell;
  view.rerender(<SharedSnapshotLanding {...props} state={{ ...props.state, status: 'wrong-workspace' }} />);
  expect(screen.getByRole('button', { name: 'Server settings' })).toBeVisible(); expect(shell.openTargetSettings).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Server settings' })); await act(async () => {});
  expect(shell.openTargetSettings).toHaveBeenCalledOnce(); expect(shell.getCurrentTarget).not.toHaveBeenCalled();
  expect(props.onRefresh).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  expect(readSnapshotPublicationView).not.toHaveBeenCalled(); expect(screen.getByRole('heading', { name: 'Connect to the linked workspace' })).toBeVisible();
});

it.each(['rejected promise', 'synchronous failure'])('handles a %s opening desktop settings with safe local guidance', async kind => {
  const props = await fixture(); window.desktopShell = { openTargetSettings: vi.fn(() => {
    const failure = new Error('private SSH key path /secret'); if (kind === 'synchronous failure') throw failure;
    return Promise.reject(failure);
  }) };
  render(<SharedSnapshotLanding {...props} state={{ ...props.state, status: 'unreachable', user: null }} />);
  fireEvent.click(screen.getByRole('button', { name: 'Server settings' }));
  expect(await screen.findByText('Server settings could not be opened. Try the desktop connection menu.')).toBeVisible();
  expect(screen.queryByText(/private SSH key/)).not.toBeInTheDocument(); expect(props.onRefresh).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled(); expect(screen.queryByRole('button', { name: 'Sign out' })).not.toBeInTheDocument();
});

it('does not display an older desktop-settings failure after navigation to another exact shared target', async () => {
  const props = await fixture(), held = deferred(); window.desktopShell = { openTargetSettings: vi.fn(() => held.promise) };
  const view = render(<SharedSnapshotLanding {...props} state={{ ...props.state, status: 'unreachable' }} />);
  fireEvent.click(screen.getByRole('button', { name: 'Server settings' }));
  view.rerender(<SharedSnapshotLanding {...props} state={{ ...props.state, status: 'unverified', target: { ...props.state.target, publicationId: 'aspub_' + 'f'.repeat(24) } }} />);
  await act(async () => held.resolve(Promise.reject(new Error('old settings failure'))));
  expect(screen.queryByText('Server settings could not be opened. Try the desktop connection menu.')).not.toBeInTheDocument();
});
