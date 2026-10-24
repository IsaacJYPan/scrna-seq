import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import SharedRevisionDiscussion from './SharedRevisionDiscussion';
import { listSharedRevisionComments } from './sharedRevisionDiscussionApi';
import { createAnalysisAttachmentComment, getAnalysisAttachmentRevision } from '../analyses/analysisAttachmentApi';
import useExecutionTarget from '../runtime/useExecutionTarget';

vi.mock('./sharedRevisionDiscussionApi', () => ({ listSharedRevisionComments: vi.fn() }));
vi.mock('../analyses/analysisAttachmentApi', () => ({ createAnalysisAttachmentComment: vi.fn(), getAnalysisAttachmentRevision: vi.fn() }));
vi.mock('../runtime/useExecutionTarget', () => ({ default: vi.fn() }));
const projectId = `proj_${'1'.repeat(24)}`, analysisId = `ra_${'2'.repeat(24)}`, serviceId = `svc_${'3'.repeat(32)}`;
const attachmentId = `raa_${'4'.repeat(24)}`, revisionId = `rar_${'5'.repeat(24)}`, newerRevisionId = `rar_${'6'.repeat(24)}`;
const attachment = { attachmentId, revisionId, revisionNumber: 1, caption: 'Included exact historical caption' };
const connected = { identity: 'known-workspace', epoch: 1, blocked: false };
const makeProps = changes => ({ projectId, analysisId, serviceId, userId: 7, attachment, accessEpoch: 0,
  available: true, isActive: true, onCheckAccess: vi.fn(), ...changes });
const comment = changes => ({ id: `rac_${'7'.repeat(24)}`, attachmentId, revisionId, body: 'Explain this saved treatment comparison.',
  authorUserId: 7, authorDisplayName: 'Current colleague', createdAt: '2026-10-24T12:00:00.000Z', ...changes });
const page = (comments = [comment()], changes = {}) => ({ projectId, analysisId, attachmentId, revisionId,
  headRevisionId: newerRevisionId, canComment: true, comments, nextCursor: null, ...changes });
const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const open = () => fireEvent.click(screen.getByRole('button', { name: 'Read revision discussion' }));
const refresh = () => fireEvent.click(screen.getByRole('button', { name: 'Refresh discussion' }));
const shownComments = () => screen.queryByRole('list', { name: 'Saved revision comments' });
async function ready(props = makeProps()) {
  const view = render(<SharedRevisionDiscussion {...props} />); open();
  await screen.findByText(comment().body); return { ...view, props };
}
beforeEach(() => {
  vi.resetAllMocks(); useExecutionTarget.mockReturnValue(connected); listSharedRevisionComments.mockResolvedValue(page());
  localStorage.clear(); sessionStorage.clear();
});
afterEach(() => vi.unstubAllGlobals());

it('opens only on request and reads the included historical revision without consulting its newer head or writing', async () => {
  render(<SharedRevisionDiscussion {...makeProps()} />);
  expect(listSharedRevisionComments).not.toHaveBeenCalled();
  expect(screen.getByText(/outside the immutable snapshot checksum/)).toBeVisible();
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument(); open();
  expect(await screen.findByText(comment().body)).toBeVisible();
  expect(listSharedRevisionComments).toHaveBeenCalledExactlyOnceWith(projectId, analysisId, attachmentId, revisionId,
    expect.objectContaining({ cursor: null, signal: expect.any(AbortSignal) }));
  expect(screen.getByText('Current colleague · You')).toBeVisible();
  expect(screen.getByRole('heading', { name: 'Current discussion · Saved revision 1' })).toHaveFocus();
  expect(createAnalysisAttachmentComment).not.toHaveBeenCalled(); expect(getAnalysisAttachmentRevision).not.toHaveBeenCalled();
  expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0);
});

it.each([null, undefined])('shows no corresponding discussion for an origin without included attachment context (%s)', value => {
  render(<SharedRevisionDiscussion {...makeProps({ attachment: value })} />);
  expect(screen.getByText('This finding has no linked saved-revision discussion.')).toBeVisible();
  expect(screen.queryByRole('button')).not.toBeInTheDocument(); expect(listSharedRevisionComments).not.toHaveBeenCalled();
});

it.each([
  { serviceId: 'other-service' }, { projectId: 'private/path' }, { analysisId: 'current' }, { userId: [] }, { userId: '7x' },
  { accessEpoch: NaN }, { accessEpoch: -1 }, { attachment: { ...attachment, revisionId: [revisionId] } },
  { attachment: { ...attachment, attachmentId: '../current-head' } }, { attachment: { ...attachment, revisionNumber: 201 } },
])('fails closed on an invalid exact reference/scope %j', changes => {
  render(<SharedRevisionDiscussion {...makeProps(changes)} />);
  expect(screen.getByRole('alert')).toHaveTextContent('could not be verified');
  expect(listSharedRevisionComments).not.toHaveBeenCalled();
});

it('keeps readable comments when posting is unavailable and renders user content as escaped plain text', async () => {
  const body = '<img src=x onerror=alert(1)>\nPlain question';
  listSharedRevisionComments.mockResolvedValue(page([comment({ body, authorDisplayName: '<Colleague>' })], { canComment: false }));
  render(<SharedRevisionDiscussion {...makeProps()} />); open();
  expect(await screen.findByText(/<img src=x onerror=alert\(1\)>/)).toBeVisible();
  const region = screen.getByRole('region', { name: 'Current discussion for saved revision 1' });
  expect(region.querySelector('img')).toBeNull(); expect(region.querySelector('script')).toBeNull();
  expect(region.querySelector('textarea')).toBeNull(); expect(screen.getByText('<Colleague> · You')).toBeVisible();
  expect(createAnalysisAttachmentComment).not.toHaveBeenCalled();
});

it('loads bounded older pages on demand and deduplicates identical immutable comments', async () => {
  const older = comment({ id: `rac_${'6'.repeat(24)}`, body: 'Older exact revision discussion', createdAt: '2026-10-24T11:00:00.000Z' });
  listSharedRevisionComments.mockResolvedValueOnce(page([comment()], { nextCursor: 'older_page' }))
    .mockResolvedValueOnce(page([comment(), older]));
  await ready(); expect(listSharedRevisionComments).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Load older discussion' }));
  expect(await screen.findByText(older.body)).toBeVisible();
  expect(within(shownComments()).getAllByRole('listitem')).toHaveLength(2);
  expect(listSharedRevisionComments).toHaveBeenNthCalledWith(2, projectId, analysisId, attachmentId, revisionId,
    expect.objectContaining({ cursor: 'older_page', signal: expect.any(AbortSignal) }));
  expect(screen.queryByRole('button', { name: 'Load older discussion' })).not.toBeInTheDocument();
});

it('refreshes the same exact revision and replaces only its current live discussion', async () => {
  await ready(); listSharedRevisionComments.mockResolvedValueOnce(page([])); refresh();
  expect(await screen.findByText('No comments on this saved revision yet.')).toBeVisible();
  expect(shownComments()).not.toBeInTheDocument();
  expect(listSharedRevisionComments.mock.calls.map(call => call.slice(0, 4))).toEqual([
    [projectId, analysisId, attachmentId, revisionId], [projectId, analysisId, attachmentId, revisionId],
  ]);
});

it.each([
  ['wrong revision', () => page([comment({ body: 'Unrelated private response' })], { revisionId: newerRevisionId })],
  ['extra private field', () => page([comment({ body: 'Unrelated private response' })], { storageKey: '/private/path' })],
  ['oversized page', () => page(Array.from({ length: 31 }, (_, index) => comment({ id: `rac_${index.toString(16).padStart(24, '0')}` })))],
  ['empty advancing page', () => page([], { nextCursor: 'missing' })],
])('rejects %s before displaying protected response text', async (_name, result) => {
  listSharedRevisionComments.mockResolvedValueOnce(result()); render(<SharedRevisionDiscussion {...makeProps()} />); open();
  expect(await screen.findByRole('alert')).toHaveTextContent('could not be verified');
  expect(screen.queryByText('Unrelated private response')).not.toBeInTheDocument(); expect(shownComments()).not.toBeInTheDocument();
});

it.each([
  ['changed duplicate', () => page([comment({ body: 'Silently edited duplicate' })])],
  ['nonadvancing cursor', () => page([comment()], { nextCursor: 'older_page' })],
  ['newer page item', () => page([comment({ id: `rac_${'8'.repeat(24)}`, body: 'Unrelated newer item', createdAt: '2026-10-24T13:00:00.000Z' })])],
])('rejects a %s instead of mixing invalid pagination state', async (_name, result) => {
  listSharedRevisionComments.mockResolvedValueOnce(page([comment()], { nextCursor: 'older_page' })).mockResolvedValueOnce(result());
  await ready(); fireEvent.click(screen.getByRole('button', { name: 'Load older discussion' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('could not be verified'); expect(shownComments()).not.toBeInTheDocument();
});

it.each([403, 404])('keeps discussion denial %i local and offers an explicit current-snapshot access check', async status => {
  const props = makeProps(); await ready(props);
  listSharedRevisionComments.mockRejectedValueOnce(Object.assign(new Error('/private/source'), { status, code: 'ANALYSIS_ATTACHMENT_NOT_FOUND' }));
  refresh(); expect(await screen.findByRole('alert')).toHaveTextContent('The retained findings are unchanged.');
  expect(shownComments()).not.toBeInTheDocument(); expect(screen.queryByText('/private/source')).not.toBeInTheDocument();
  expect(props.onCheckAccess).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Check snapshot access' })); expect(props.onCheckAccess).toHaveBeenCalledExactlyOnceWith(undefined);
});

it('clears only local comments on401 and asks the host to revalidate current snapshot authority', async () => {
  const props = makeProps(); await ready(props); const failure = Object.assign(new Error('Expired session'), { status: 401 });
  listSharedRevisionComments.mockRejectedValueOnce(failure); refresh();
  expect(await screen.findByRole('alert')).toHaveTextContent('Snapshot access is being checked');
  expect(shownComments()).not.toBeInTheDocument(); expect(props.onCheckAccess).toHaveBeenCalledExactlyOnceWith(failure);
});

it('keeps a retryable outage local and never displays raw server failures', async () => {
  const props = makeProps(); await ready(props);
  listSharedRevisionComments.mockRejectedValueOnce(new Error('credentials@private-server/path')); refresh();
  expect(await screen.findByRole('alert')).toHaveTextContent('could not be reached');
  expect(screen.queryByText('credentials@private-server/path')).not.toBeInTheDocument(); expect(props.onCheckAccess).not.toHaveBeenCalled();
  listSharedRevisionComments.mockResolvedValueOnce(page()); refresh(); expect(await screen.findByText(comment().body)).toBeVisible();
});

it.each([{}, [], 23, null])('handles a malformed error code %j without an unhandled load rejection', async code => {
  listSharedRevisionComments.mockRejectedValueOnce(Object.assign(new Error('private/path'), { status: 500, code }));
  render(<SharedRevisionDiscussion {...makeProps()} />); open();
  expect(await screen.findByRole('alert')).toHaveTextContent('could not be reached');
  expect(screen.queryByText('private/path')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Refresh discussion' })).toBeEnabled();
});

it('closes, aborts and forgets a held page, then explicitly reopens without scientific browser persistence', async () => {
  const held = deferred(); listSharedRevisionComments.mockReturnValueOnce(held.promise);
  render(<SharedRevisionDiscussion {...makeProps()} />); open();
  const signal = listSharedRevisionComments.mock.calls[0][4].signal;
  fireEvent.click(screen.getByRole('button', { name: 'Close discussion' })); expect(signal.aborted).toBe(true);
  expect(screen.getByRole('button', { name: 'Read revision discussion' })).toHaveFocus();
  await act(async () => held.resolve(page())); expect(shownComments()).not.toBeInTheDocument();
  expect(listSharedRevisionComments).toHaveBeenCalledTimes(1); open(); expect(await screen.findByText(comment().body)).toBeVisible();
  expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0);
});

it.each([
  ['account', props => ({ ...props, userId: 8 })],
  ['service', props => ({ ...props, serviceId: `svc_${'a'.repeat(32)}` })],
  ['project', props => ({ ...props, projectId: `proj_${'b'.repeat(24)}` })],
  ['analysis', props => ({ ...props, analysisId: `ra_${'c'.repeat(24)}` })],
  ['revision', props => ({ ...props, attachment: { ...attachment, revisionId: newerRevisionId, revisionNumber: 2 } })],
  ['attachment', props => ({ ...props, attachment: { ...attachment, attachmentId: `raa_${'d'.repeat(24)}` } })],
  ['permission epoch', props => ({ ...props, accessEpoch: 1 })],
  ['inactive view', props => ({ ...props, isActive: false })],
  ['disconnected workspace', props => ({ ...props, available: false })],
])('fences a held response and clears old comments when %s changes', async (_name, change) => {
  const props = makeProps(), view = await ready(props), held = deferred();
  listSharedRevisionComments.mockReturnValueOnce(held.promise); refresh();
  const signal = listSharedRevisionComments.mock.calls[1][4].signal;
  view.rerender(<SharedRevisionDiscussion {...change(props)} />);
  expect(signal.aborted).toBe(true); expect(shownComments()).not.toBeInTheDocument();
  await act(async () => held.resolve(page([comment({ body: 'Late old scope content' })])));
  expect(screen.queryByText('Late old scope content')).not.toBeInTheDocument(); expect(listSharedRevisionComments).toHaveBeenCalledTimes(2);
});

it.each([
  { ...connected, epoch: 2 }, { ...connected, identity: 'different-target' }, { ...connected, blocked: true },
])('fences current native-target changes without waiting for a failed HTTP response: %j', async target => {
  const props = makeProps(), view = await ready(props), held = deferred();
  listSharedRevisionComments.mockReturnValueOnce(held.promise); refresh();
  const signal = listSharedRevisionComments.mock.calls[1][4].signal;
  useExecutionTarget.mockReturnValue(target); view.rerender(<SharedRevisionDiscussion {...props} />);
  expect(signal.aborted).toBe(true); expect(shownComments()).not.toBeInTheDocument();
  await act(async () => held.resolve(page([comment({ body: 'Late old connection content' })])));
  expect(screen.queryByText('Late old connection content')).not.toBeInTheDocument();
});

it('unmounts a held discussion without invoking access callbacks or accepting late comments', async () => {
  const held = deferred(), props = makeProps(); listSharedRevisionComments.mockReturnValueOnce(held.promise);
  const view = render(<SharedRevisionDiscussion {...props} />); open(); const signal = listSharedRevisionComments.mock.calls[0][4].signal;
  view.unmount(); expect(signal.aborted).toBe(true);
  await act(async () => held.reject(Object.assign(new Error('Late logout'), { status: 401 })));
  expect(props.onCheckAccess).not.toHaveBeenCalled();
});

it('replaces an older held refresh with an explicit newer check and never accepts the older response', async () => {
  const props = makeProps(), held = deferred(); listSharedRevisionComments.mockReturnValueOnce(held.promise);
  const view = render(<SharedRevisionDiscussion {...props} />); open();
  const signal = listSharedRevisionComments.mock.calls[0][4].signal;
  view.rerender(<SharedRevisionDiscussion {...props} accessEpoch={1} />); expect(signal.aborted).toBe(true);
  open(); expect(await screen.findByText(comment().body)).toBeVisible();
  await act(async () => held.resolve(page([comment({ body: 'Stale prior permission response' })])));
  expect(screen.queryByText('Stale prior permission response')).not.toBeInTheDocument(); expect(screen.getByText(comment().body)).toBeVisible();
});

it('does not read when the containing snapshot is inactive or the selected target is blocked', async () => {
  const props = makeProps(), view = render(<SharedRevisionDiscussion {...props} isActive={false} />);
  expect(screen.getByRole('button', { name: 'Read revision discussion' })).toBeDisabled();
  view.rerender(<SharedRevisionDiscussion {...props} available={false} />);
  expect(screen.getByRole('button', { name: 'Read revision discussion' })).toBeDisabled();
  useExecutionTarget.mockReturnValue({ ...connected, blocked: true }); view.rerender(<SharedRevisionDiscussion {...props} />);
  expect(screen.getByRole('button', { name: 'Read revision discussion' })).toBeDisabled();
  expect(listSharedRevisionComments).not.toHaveBeenCalled();
});
