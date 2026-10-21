import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import AttachmentRevisionHistory from './AttachmentRevisionHistory';
import { listAnalysisAttachmentRevisions } from './analysisAttachmentApi';

vi.mock('./analysisAttachmentApi', () => ({ listAnalysisAttachmentRevisions: vi.fn() }));
const projectId = `proj_${'1'.repeat(24)}`, analysisId = `ra_${'2'.repeat(24)}`, attachmentId = `raa_${'3'.repeat(24)}`;
const firstId = `rar_${'4'.repeat(24)}`, secondId = `rar_${'5'.repeat(24)}`, thirdId = `rar_${'6'.repeat(24)}`;
const suppliedOrigin = { origin: null, sourceReference: null, documentReference: null, environmentReference: null };
const first = { id: firstId, attachmentId, previousRevisionId: null, revisionNumber: 1,
  reference: { kind: 'artifact-version', versionId: `av_${'7'.repeat(24)}`, sha256: 'a'.repeat(64) },
  caption: 'Original result', suppliedOrigin, createdByUserId: 1, createdAt: '2026-10-20T12:00:00Z' };
const second = { ...first, id: secondId, previousRevisionId: firstId, revisionNumber: 2, caption: 'Corrected result', createdByUserId: 2 };
const third = { ...second, id: thirdId, previousRevisionId: secondId, revisionNumber: 3, caption: 'Current result' };
const common = { projectId, analysisId, attachmentId, canWrite: true, headRevisionId: thirdId };
const row = (revision, sourceAccess = 'available') => ({ revision: structuredClone(revision), sourceAccess });
const fullHistory = () => ({ ...common, revisions: [row(third), row(second, 'restricted'), row(first, 'unavailable')], nextCursor: null });
const props = { projectId, analysisId, userId: 1, attachmentId, headRevisionId: thirdId, selectedRevisionId: secondId,
  available: true, onOpen: vi.fn(), onDenied: vi.fn() };
const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const open = async () => {
  fireEvent.click(screen.getByText('Saved revisions'));
  await waitFor(() => expect(listAnalysisAttachmentRevisions).toHaveBeenCalled());
};
beforeEach(() => { vi.resetAllMocks(); listAnalysisAttachmentRevisions.mockResolvedValue(fullHistory()); });

it('loads history only on explicit opening, pages exact immutable rows, and opens the chosen earlier revision without making it current', async () => {
  listAnalysisAttachmentRevisions.mockResolvedValueOnce({ ...common, revisions: [row(third), row(second, 'restricted')], nextCursor: 'older_page' })
    .mockResolvedValueOnce({ ...common, revisions: [row(first, 'unavailable')], nextCursor: null });
  render(<AttachmentRevisionHistory {...props} />);
  expect(listAnalysisAttachmentRevisions).not.toHaveBeenCalled(); await open();
  expect(await screen.findByText('Revision 3 · Current')).toBeVisible();
  expect(screen.getByText('Revision 2 · Viewing')).toBeVisible();
  expect(screen.getByText(/Private source access is restricted/)).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Load more revisions' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Open revision 1' }));
  expect(props.onOpen).toHaveBeenCalledExactlyOnceWith(first);
  expect(listAnalysisAttachmentRevisions).toHaveBeenNthCalledWith(2, projectId, analysisId, attachmentId,
    expect.objectContaining({ cursor: 'older_page', signal: expect.any(AbortSignal) }));
  expect(screen.getByText(/Original source unavailable/)).toBeVisible();
});

it('labels the current revision from the freshly authorized history response rather than an older caller head', async () => {
  render(<AttachmentRevisionHistory {...props} headRevisionId={firstId} />); await open();
  expect(await screen.findByText('Revision 3 · Current')).toBeVisible();
  expect(screen.queryByText('Revision 1 · Current')).not.toBeInTheDocument();
});

it.each(['attachment', 'reference', 'lineage'])('rejects a history response with wrong %s identity before exposing revision controls', async mismatch => {
  const result = fullHistory();
  if (mismatch === 'attachment') result.attachmentId = `raa_${'9'.repeat(24)}`;
  if (mismatch === 'reference') result.revisions[0].revision.reference.sha256 = 'not-a-checksum';
  if (mismatch === 'lineage') result.revisions[0].revision.previousRevisionId = firstId;
  listAnalysisAttachmentRevisions.mockResolvedValueOnce(result);
  render(<AttachmentRevisionHistory {...props} />); await open();
  expect(await screen.findByRole('alert')).toHaveTextContent('Saved revisions could not be loaded.');
  expect(screen.queryByRole('button', { name: /Open revision/ })).not.toBeInTheDocument();
  expect(props.onOpen).not.toHaveBeenCalled();
});

it('aborts an older history request when a newer head is selected and ignores its late response', async () => {
  const completion = deferred(); listAnalysisAttachmentRevisions.mockReturnValueOnce(completion.promise);
  const view = render(<AttachmentRevisionHistory {...props} />); await open();
  const signal = listAnalysisAttachmentRevisions.mock.calls[0][3].signal;
  const fourthId = `rar_${'8'.repeat(24)}`, fourth = { ...third, id: fourthId, previousRevisionId: thirdId, revisionNumber: 4, caption: 'New current result' };
  listAnalysisAttachmentRevisions.mockResolvedValueOnce({ ...common, headRevisionId: fourthId,
    revisions: [row(fourth), row(third), row(second), row(first)], nextCursor: null });
  view.rerender(<AttachmentRevisionHistory {...props} headRevisionId={fourthId} />);
  expect(signal.aborted).toBe(true);
  expect(await screen.findByText('Revision 4 · Current')).toBeVisible();
  const stale = fullHistory(); stale.revisions[0].revision.caption = 'Stale withheld result';
  await act(async () => completion.resolve(stale));
  expect(screen.queryByText('Stale withheld result')).not.toBeInTheDocument();
  expect(screen.getByText('Revision 4 · Current')).toBeVisible();
});

it.each(['blocked', 'unmounted'])('ignores a history response after its view is %s', async state => {
  const completion = deferred(); listAnalysisAttachmentRevisions.mockReturnValueOnce(completion.promise);
  const view = render(<AttachmentRevisionHistory {...props} />); await open();
  const signal = listAnalysisAttachmentRevisions.mock.calls[0][3].signal;
  if (state === 'blocked') view.rerender(<AttachmentRevisionHistory {...props} available={false} />);
  else view.unmount();
  expect(signal.aborted).toBe(true);
  await act(async () => completion.resolve(fullHistory()));
  expect(screen.queryByRole('button', { name: /Open revision/ })).not.toBeInTheDocument();
  expect(props.onOpen).not.toHaveBeenCalled();
  if (state === 'blocked') expect(screen.getByRole('button', { name: 'Refresh revisions' })).toBeDisabled();
});

it('clears saved rows on a fresh denial and ignores a previously held refresh after the denial callback', async () => {
  const completion = deferred(); const view = render(<AttachmentRevisionHistory {...props} />); await open();
  await screen.findByRole('button', { name: 'Open revision 1' });
  listAnalysisAttachmentRevisions.mockReturnValueOnce(completion.promise);
  fireEvent.click(screen.getByRole('button', { name: 'Refresh revisions' }));
  await waitFor(() => expect(listAnalysisAttachmentRevisions).toHaveBeenCalledTimes(2));
  const signal = listAnalysisAttachmentRevisions.mock.calls[1][3].signal;
  listAnalysisAttachmentRevisions.mockRejectedValueOnce(Object.assign(new Error('Access denied.'), { status: 403, code: 'FORBIDDEN' }));
  view.rerender(<AttachmentRevisionHistory {...props} headRevisionId={`rar_${'9'.repeat(24)}`} />);
  await waitFor(() => expect(props.onDenied).toHaveBeenCalledTimes(1));
  expect(signal.aborted).toBe(true);
  expect(screen.queryByRole('button', { name: /Open revision/ })).not.toBeInTheDocument();
  await act(async () => completion.resolve(fullHistory()));
  expect(props.onDenied).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('button', { name: /Open revision/ })).not.toBeInTheDocument();
});
