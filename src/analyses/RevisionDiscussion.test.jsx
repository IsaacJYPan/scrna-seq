import React from 'react';
import { createHash, webcrypto } from 'node:crypto';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import RevisionDiscussion from './RevisionDiscussion';
import { createAnalysisAttachmentComment, getAnalysisAttachmentCommentRequest, listAnalysisAttachmentComments } from './analysisAttachmentApi';
import { canonicalAnalysisAttachmentComment } from '../../shared/analysisAttachmentComment.mjs';

vi.mock('./analysisAttachmentApi', () => ({ createAnalysisAttachmentComment: vi.fn(), getAnalysisAttachmentCommentRequest: vi.fn(),
  listAnalysisAttachmentComments: vi.fn() }));

const projectId = `proj_${'1'.repeat(24)}`, analysisId = `ra_${'2'.repeat(24)}`, attachmentId = `raa_${'3'.repeat(24)}`;
const revisionId = `rar_${'4'.repeat(24)}`, newerRevisionId = `rar_${'5'.repeat(24)}`;
const common = { projectId, analysisId, attachmentId, revisionId, headRevisionId: newerRevisionId, canComment: true };
const comment = changes => ({ id: `rac_${'6'.repeat(24)}`, attachmentId, revisionId, body: 'Explain the treatment comparison.',
  authorUserId: 2, authorDisplayName: 'Private source colleague', createdAt: '2026-10-20T12:00:00.000Z', ...changes });
const page = (comments = [], changes = {}) => ({ ...common, comments, nextCursor: null, ...changes });
const accepted = (input, changes = {}) => ({ ...common, requestId: input.requestId,
  requestSha256: createHash('sha256').update(canonicalAnalysisAttachmentComment(attachmentId, revisionId, input)).digest('hex'),
  replayed: false, comment: comment({ body: input.body, authorUserId: 1, authorDisplayName: 'Current researcher' }), ...changes });
const makeProps = changes => ({ projectId, analysisId, userId: 1, attachmentId, revisionId, revisionNumber: 1,
  active: true, available: true, cache: new Map(), cacheId: revisionId, onDenied: vi.fn(), ...changes });
const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const unknown = () => new Error('The response ended before completion.');
const missing = () => Object.assign(new Error('No receipt found.'), { status: 404, code: 'ANALYSIS_ATTACHMENT_COMMENT_REQUEST_NOT_FOUND' });
const textBox = () => screen.getByRole('textbox', { name: 'Comment on this revision' });
const recovery = () => screen.getByRole('region', { name: 'Comment recovery' });
const originalBody = input => within(recovery()).getByText((_text, element) => element.tagName === 'P' && element.textContent === input.body);
async function ready(props = makeProps()) {
  const view = render(<RevisionDiscussion {...props} />);
  await waitFor(() => expect(screen.queryByText('Loading discussion…')).not.toBeInTheDocument());
  return { ...view, props };
}
async function post(value = '  Question about this exact result\r\nSecond line  ') {
  fireEvent.change(textBox(), { target: { value } }); fireEvent.click(screen.getByRole('button', { name: 'Post comment' }));
  await waitFor(() => expect(createAnalysisAttachmentComment).toHaveBeenCalledTimes(1));
  return createAnalysisAttachmentComment.mock.calls[0][4];
}

beforeEach(() => { vi.resetAllMocks(); vi.stubGlobal('crypto', webcrypto); listAnalysisAttachmentComments.mockResolvedValue(page()); });
afterEach(() => vi.unstubAllGlobals());

it('lets a permitted reader post normalized plain text to an older exact revision without attachment write authority or head CAS', async () => {
  createAnalysisAttachmentComment.mockImplementationOnce(async (_project, _analysis, _attachment, _revision, input) => {
    const result = accepted(input); listAnalysisAttachmentComments.mockResolvedValue(page([result.comment])); return result;
  });
  const { props } = await ready(); const input = await post('  <strong>Plain question</strong>\r\n\tSecond line  ');
  expect(input).toEqual({ requestId: expect.stringMatching(/^[a-f0-9-]{36}$/), body: '<strong>Plain question</strong>\n\tSecond line' });
  expect(Object.isFrozen(input)).toBe(true);
  expect(createAnalysisAttachmentComment).toHaveBeenCalledExactlyOnceWith(projectId, analysisId, attachmentId, revisionId, input,
    expect.objectContaining({ signal: expect.any(AbortSignal) }));
  expect(await screen.findByText('Your comment is saved on revision 1.')).toBeVisible();
  expect(await screen.findByText('<strong>Plain question</strong> Second line')).toBeVisible();
  expect(screen.getByRole('region', { name: 'Discussion for revision 1' }).querySelector('strong')).toBeNull();
  expect(textBox()).toHaveValue(''); expect(props.cache.has(props.cacheId)).toBe(false);
  expect(screen.getByText('Current researcher · You')).toBeVisible();
});

it('honors canComment:false independently from whether a comment draft exists', async () => {
  const props = makeProps(); props.cache.set(props.cacheId, { body: 'Kept reader draft', pending: null });
  listAnalysisAttachmentComments.mockResolvedValue(page([comment()], { canComment: false })); await ready(props);
  expect(textBox()).toHaveValue('Kept reader draft'); expect(textBox()).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Post comment' })).toBeDisabled();
  expect(screen.getByText(comment().body)).toBeVisible(); expect(createAnalysisAttachmentComment).not.toHaveBeenCalled();
});

it('loads and deduplicates bounded older comment pages for the selected immutable revision', async () => {
  const newest = comment(), older = comment({ id: `rac_${'5'.repeat(24)}`, body: 'Earlier discussion', createdAt: '2026-10-20T11:59:00.000Z' });
  listAnalysisAttachmentComments.mockResolvedValueOnce(page([newest], { nextCursor: 'older_page' })).mockResolvedValueOnce(page([newest, older]));
  await ready(); fireEvent.click(screen.getByRole('button', { name: 'Load older comments' }));
  expect(await screen.findByText('Earlier discussion')).toBeVisible();
  expect(within(screen.getByRole('list', { name: 'Revision comments' })).getAllByRole('listitem')).toHaveLength(2);
  expect(listAnalysisAttachmentComments).toHaveBeenNthCalledWith(2, projectId, analysisId, attachmentId, revisionId,
    expect.objectContaining({ cursor: 'older_page', signal: expect.any(AbortSignal) }));
});

it('keeps drafts separate per revision across unmount/remount and never caches protected server comments', async () => {
  const props = makeProps(); listAnalysisAttachmentComments.mockResolvedValue(page([comment()]));
  const view = await ready(props); fireEvent.change(textBox(), { target: { value: 'Draft for the original evidence' } });
  const other = { ...props, revisionId: newerRevisionId, revisionNumber: 2, cacheId: newerRevisionId };
  listAnalysisAttachmentComments.mockResolvedValue(page([], { revisionId: newerRevisionId }));
  view.rerender(<RevisionDiscussion key={newerRevisionId} {...other} />); await waitFor(() => expect(textBox()).toBeEnabled());
  expect(textBox()).toHaveValue(''); fireEvent.change(textBox(), { target: { value: 'Draft for the corrected evidence' } });
  listAnalysisAttachmentComments.mockResolvedValue(page()); view.rerender(<RevisionDiscussion key={revisionId} {...props} />);
  await waitFor(() => expect(textBox()).toBeEnabled()); expect(textBox()).toHaveValue('Draft for the original evidence');
  expect(props.cache.get(newerRevisionId)).toEqual({ body: 'Draft for the corrected evidence', pending: null });
  expect(props.cache.get(revisionId)).toEqual({ body: 'Draft for the original evidence', pending: null });
  expect(screen.queryByText(comment().body)).not.toBeInTheDocument();
});

it('retains the frozen original request through unmount, receipt404 and explicit identical retry without auto-posting', async () => {
  const props = makeProps(); createAnalysisAttachmentComment.mockRejectedValueOnce(unknown());
  getAnalysisAttachmentCommentRequest.mockRejectedValueOnce(missing());
  const first = await ready(props), input = await post();
  await within(recovery()).findByRole('button', { name: 'Check comment outcome' });
  await waitFor(() => expect(within(recovery()).getByRole('button', { name: 'Check comment outcome' })).toBeEnabled());
  first.unmount(); await ready(props);
  expect(createAnalysisAttachmentComment).toHaveBeenCalledTimes(1);
  expect(within(recovery()).queryByRole('button', { name: 'Retry original comment' })).not.toBeInTheDocument();
  fireEvent.click(within(recovery()).getByRole('button', { name: 'Check comment outcome' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('This does not prove the original request was rejected');
  expect(getAnalysisAttachmentCommentRequest).toHaveBeenCalledExactlyOnceWith(projectId, analysisId, input.requestId,
    expect.objectContaining({ signal: expect.any(AbortSignal) }));
  expect(createAnalysisAttachmentComment).toHaveBeenCalledTimes(1);
  createAnalysisAttachmentComment.mockResolvedValueOnce(accepted(input));
  fireEvent.click(within(recovery()).getByRole('button', { name: 'Retry original comment' }));
  expect(await screen.findByText('Your comment is saved on revision 1.')).toBeVisible();
  expect(createAnalysisAttachmentComment).toHaveBeenCalledTimes(2);
  expect(createAnalysisAttachmentComment.mock.calls[1][4]).toBe(input);
  expect(props.cache.has(props.cacheId)).toBe(false);
});

it('recovers the original accepted comment after archival without granting fresh posting authority', async () => {
  const completion = deferred(); createAnalysisAttachmentComment.mockReturnValueOnce(completion.promise);
  const props = makeProps(), view = await ready(props), input = await post();
  const signal = createAnalysisAttachmentComment.mock.calls[0][5].signal;
  view.rerender(<RevisionDiscussion {...props} active={false} />); expect(signal.aborted).toBe(true);
  await act(async () => completion.resolve(accepted(input)));
  expect(screen.queryByText('Your comment is saved on revision 1.')).not.toBeInTheDocument();
  getAnalysisAttachmentCommentRequest.mockResolvedValueOnce(accepted(input, { canComment: false, replayed: true }));
  listAnalysisAttachmentComments.mockResolvedValue(page([comment({ body: input.body, authorUserId: 1 })], { canComment: false }));
  fireEvent.click(within(recovery()).getByRole('button', { name: 'Check comment outcome' }));
  expect(await screen.findByText('Your comment is saved on revision 1.')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Post comment' })).toBeDisabled();
  expect(createAnalysisAttachmentComment).toHaveBeenCalledTimes(1);
});

it('a fresh canComment:false read cancels an older held action and preserves permitted discussion plus the original request', async () => {
  const completion = deferred(); createAnalysisAttachmentComment.mockReturnValueOnce(completion.promise);
  const props = makeProps(); await ready(props); const input = await post();
  const signal = createAnalysisAttachmentComment.mock.calls[0][5].signal;
  listAnalysisAttachmentComments.mockResolvedValueOnce(page([comment()], { canComment: false }));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh discussion' }));
  expect(await screen.findByText(comment().body)).toBeVisible(); expect(signal.aborted).toBe(true);
  await act(async () => completion.resolve(accepted(input)));
  expect(screen.queryByText('Your comment is saved on revision 1.')).not.toBeInTheDocument();
  expect(originalBody(input)).toBeVisible();
  expect(props.cache.get(props.cacheId).pending).toBe(input);
  expect(within(recovery()).getByRole('button', { name: 'Check comment outcome' })).toBeEnabled();
});

it('fresh scope denial clears protected comments and fences an older accepted reply while retaining only the researcher request', async () => {
  listAnalysisAttachmentComments.mockResolvedValueOnce(page([comment()]));
  const completion = deferred(); createAnalysisAttachmentComment.mockReturnValueOnce(completion.promise);
  const props = makeProps(); await ready(props); const input = await post();
  const signal = createAnalysisAttachmentComment.mock.calls[0][5].signal;
  const failure = Object.assign(new Error('No longer available.'), { status: 404, code: 'ANALYSIS_ATTACHMENT_NOT_FOUND' });
  listAnalysisAttachmentComments.mockRejectedValueOnce(failure); fireEvent.click(screen.getByRole('button', { name: 'Refresh discussion' }));
  await screen.findByRole('alert'); expect(signal.aborted).toBe(true); expect(props.onDenied).toHaveBeenCalledExactlyOnceWith(failure);
  expect(screen.queryByText(comment().body)).not.toBeInTheDocument();
  await act(async () => completion.resolve(accepted(input)));
  expect(screen.queryByText('Your comment is saved on revision 1.')).not.toBeInTheDocument();
  expect(props.cache.get(props.cacheId).pending).toBe(input); expect(originalBody(input)).toBeVisible();
});

it.each(['inactive', 'disconnected', 'unmounted'])('fences a held accepted action after the discussion becomes %s', async interruption => {
  const completion = deferred(); createAnalysisAttachmentComment.mockReturnValueOnce(completion.promise);
  const props = makeProps(), view = await ready(props), input = await post();
  const signal = createAnalysisAttachmentComment.mock.calls[0][5].signal;
  if (interruption === 'unmounted') view.unmount();
  else view.rerender(<RevisionDiscussion {...props} {...(interruption === 'inactive' ? { active: false } : { available: false })} />);
  expect(signal.aborted).toBe(true); await act(async () => completion.resolve(accepted(input)));
  expect(screen.queryByText('Your comment is saved on revision 1.')).not.toBeInTheDocument();
  expect(props.cache.get(props.cacheId).pending).toBe(input);
  if (interruption !== 'unmounted') expect(originalBody(input)).toBeVisible();
});

it('fences a delayed read after a connection remount or a newer exact revision selection', async () => {
  const completion = deferred(); listAnalysisAttachmentComments.mockReturnValueOnce(completion.promise);
  const props = makeProps(), view = render(<RevisionDiscussion key="old-connection" {...props} />);
  await waitFor(() => expect(listAnalysisAttachmentComments).toHaveBeenCalledTimes(1));
  const signal = listAnalysisAttachmentComments.mock.calls[0][4].signal;
  const changed = { ...props, revisionId: newerRevisionId, revisionNumber: 2, cacheId: newerRevisionId };
  listAnalysisAttachmentComments.mockResolvedValue(page([], { revisionId: newerRevisionId }));
  view.rerender(<RevisionDiscussion key="new-connection-and-revision" {...changed} />); expect(signal.aborted).toBe(true);
  await screen.findByRole('form', { name: 'Comment on revision 2' });
  await act(async () => completion.resolve(page([comment()])));
  expect(screen.queryByText(comment().body)).not.toBeInTheDocument(); expect(screen.queryByRole('form', { name: 'Comment on revision 1' })).not.toBeInTheDocument();
});

it.each(['wrong revision', 'wrong author', 'wrong body', 'wrong digest', 'unknown field'])('keeps an acceptance with %s unconfirmed', async mismatch => {
  createAnalysisAttachmentComment.mockImplementationOnce(async (_project, _analysis, _attachment, _revision, input) => {
    const result = accepted(input);
    if (mismatch === 'wrong revision') result.comment.revisionId = newerRevisionId;
    if (mismatch === 'wrong author') result.comment.authorUserId = 2;
    if (mismatch === 'wrong body') result.comment.body = 'Unrelated comment';
    if (mismatch === 'wrong digest') result.requestSha256 = '0'.repeat(64);
    if (mismatch === 'unknown field') result.comment.privateStorageKey = '/private/source';
    return result;
  });
  const { props } = await ready(); const input = await post();
  await screen.findByRole('alert'); expect(originalBody(input)).toBeVisible();
  expect(screen.queryByText('Your comment is saved on revision 1.')).not.toBeInTheDocument();
  expect(props.cache.get(props.cacheId).pending).toBe(input);
});

it('releases a first definitive validation rejection but never releases an uncertain request based on a later validation error', async () => {
  const invalid = () => Object.assign(new Error('Invalid comment.'), { status: 400, code: 'INVALID_ANALYSIS_ATTACHMENT_COMMENT' });
  createAnalysisAttachmentComment.mockRejectedValueOnce(invalid());
  const { props } = await ready(); const first = await post('Keep the draft');
  await screen.findByRole('alert'); expect(screen.queryByRole('region', { name: 'Comment recovery' })).not.toBeInTheDocument();
  expect(textBox()).toHaveValue(first.body); expect(textBox()).toBeEnabled();
  expect(props.cache.get(props.cacheId)).toEqual({ body: 'Keep the draft', pending: null });
  createAnalysisAttachmentComment.mockRejectedValueOnce(unknown());
  fireEvent.click(screen.getByRole('button', { name: 'Post comment' })); await waitFor(() => expect(createAnalysisAttachmentComment).toHaveBeenCalledTimes(2));
  const second = createAnalysisAttachmentComment.mock.calls[1][4];
  await waitFor(() => expect(within(recovery()).getByRole('button', { name: 'Check comment outcome' })).toBeEnabled());
  getAnalysisAttachmentCommentRequest.mockRejectedValueOnce(missing());
  fireEvent.click(within(recovery()).getByRole('button', { name: 'Check comment outcome' }));
  const retry = await within(recovery()).findByRole('button', { name: 'Retry original comment' });
  createAnalysisAttachmentComment.mockRejectedValueOnce(invalid()); fireEvent.click(retry); await screen.findByRole('alert');
  expect(within(recovery()).getByText(second.body)).toBeVisible(); expect(props.cache.get(props.cacheId).pending).toBe(second);
});

it('keeps a readable discussion and draft on a refresh outage and rejects unrelated list scope before showing server comments', async () => {
  listAnalysisAttachmentComments.mockResolvedValueOnce(page([comment()])); await ready();
  fireEvent.change(textBox(), { target: { value: 'Unsaved question' } });
  listAnalysisAttachmentComments.mockRejectedValueOnce(unknown()); fireEvent.click(screen.getByRole('button', { name: 'Refresh discussion' }));
  await screen.findByRole('alert'); expect(screen.getByText(comment().body)).toBeVisible(); expect(textBox()).toHaveValue('Unsaved question');
  listAnalysisAttachmentComments.mockResolvedValueOnce(page([comment({ body: 'Another private discussion' })], { revisionId: newerRevisionId }));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh discussion' })); await screen.findByRole('alert');
  expect(screen.queryByText('Another private discussion')).not.toBeInTheDocument(); expect(textBox()).toHaveValue('Unsaved question');
});

it('does not post invalid oversized input even though UTF-16 entry permits a bounded Unicode draft', async () => {
  await ready(); fireEvent.change(textBox(), { target: { value: 'x'.repeat(4001) } });
  fireEvent.click(screen.getByRole('button', { name: 'Post comment' })); await screen.findByRole('alert');
  expect(createAnalysisAttachmentComment).not.toHaveBeenCalled(); expect(textBox()).toHaveValue('x'.repeat(4001));
});
