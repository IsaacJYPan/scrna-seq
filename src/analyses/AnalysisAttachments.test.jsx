import React from 'react';
import { createHash, webcrypto } from 'node:crypto';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import AnalysisAttachments from './AnalysisAttachments';
import { createAnalysisAttachment, getAnalysisAttachmentRequest, listAnalysisAttachments, listAnalysisAttachmentOptions } from './analysisAttachmentApi';
import { canonicalAnalysisAttachmentContent } from '../../shared/analysisAttachment.mjs';

const preview = vi.hoisted(() => ({ render: vi.fn() }));
vi.mock('../components/RetainedArtifactView', () => ({ default: props => {
  preview.render(props);
  return <p aria-label="Authorized artifact preview">{props.reference.versionId}</p>;
} }));
vi.mock('./analysisAttachmentApi', () => ({ createAnalysisAttachment: vi.fn(), getAnalysisAttachmentRequest: vi.fn(),
  listAnalysisAttachments: vi.fn(), listAnalysisAttachmentOptions: vi.fn() }));

const projectId = `proj_${'1'.repeat(24)}`;
const analysis = { id: `ra_${'2'.repeat(24)}`, name: 'Treatment response', status: 'active' };
const otherAnalysis = { ...analysis, id: `ra_${'9'.repeat(24)}`, name: 'Other question' };
const reference = { kind: 'artifact-version', versionId: `av_${'5'.repeat(24)}`, sha256: 'a'.repeat(64) };
const emptyOrigin = { origin: null, sourceReference: null, documentReference: null, environmentReference: null };
const option = { reference, name: 'scores.csv', format: { id: 'org.ietf.csv', version: '1' }, sizeBytes: 14, createdAt: '2026-10-20T12:00:00Z' };
const common = { projectId, analysisId: analysis.id, canWrite: true };
const originalItem = { id: `raa_${'3'.repeat(24)}`, headRevisionId: `rar_${'4'.repeat(24)}`, sourceAccess: 'available', revision: {
  id: `rar_${'4'.repeat(24)}`, attachmentId: `raa_${'3'.repeat(24)}`, revisionNumber: 1,
  reference: { ...reference, versionId: `av_${'6'.repeat(24)}` }, caption: 'Earlier attachment', suppliedOrigin: emptyOrigin,
  createdByUserId: 1, createdAt: '2026-10-20T12:00:00Z',
} };
const props = { projectId, projectName: 'Immune cohort', analysis, userId: 1, role: 'analyst', isActive: true,
  connection: { blocked: false, identity: 'lab', epoch: 1 }, onClose: vi.fn() };
const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const unknown = () => new Error('The connection ended before the response.');
const missing = () => Object.assign(new Error('No accepted attachment request.'), { status: 404, code: 'ANALYSIS_ATTACHMENT_REQUEST_NOT_FOUND' });

function accepted(body, { canWrite = true, sourceAccess = 'available' } = {}) {
  const item = { id: `raa_${'7'.repeat(24)}`, headRevisionId: `rar_${'8'.repeat(24)}`, sourceAccess, revision: {
    id: `rar_${'8'.repeat(24)}`, attachmentId: `raa_${'7'.repeat(24)}`, revisionNumber: 1,
    reference: { ...body.reference }, caption: body.caption, suppliedOrigin: { ...body.suppliedOrigin }, createdByUserId: 1, createdAt: '2026-10-20T13:00:00Z',
  } };
  return { ...common, canWrite, requestId: body.requestId, requestSha256: createHash('sha256').update(canonicalAnalysisAttachmentContent(body)).digest('hex'),
    replayed: false, acceptedRevision: structuredClone(item.revision), attachment: item };
}
const collection = () => screen.getAllByRole('region', { name: 'Outside results' }).find(element => !element.closest('[hidden]'));
const inside = () => within(collection());
async function fillForm(caption = '  Imported score comparison  ') {
  await inside().findByText('No outside results attached');
  fireEvent.click(inside().getByRole('button', { name: 'Attach outside result', exact: true }));
  fireEvent.click(inside().getByRole('button', { name: 'Choose saved file' }));
  fireEvent.click(await inside().findByRole('radio', { name: /scores.csv/ }));
  fireEvent.change(inside().getByLabelText('Result caption'), { target: { value: caption } });
  fireEvent.click(inside().getByText('Add supplied origin and references (optional)'));
  fireEvent.change(inside().getByLabelText('Where this result came from'), { target: { value: '  External lab  ' } });
  return inside().getByRole('form', { name: 'Attach outside result' });
}
async function submit() {
  fireEvent.click(inside().getByRole('button', { name: 'Attach result', exact: true }));
  await waitFor(() => expect(createAnalysisAttachment).toHaveBeenCalledTimes(1));
  return createAnalysisAttachment.mock.calls[0][2];
}

beforeEach(() => {
  vi.resetAllMocks(); vi.stubGlobal('crypto', webcrypto);
  listAnalysisAttachments.mockImplementation(async (_project, selectedAnalysis) => ({ ...common, analysisId: selectedAnalysis, attachments: [], nextCursor: null }));
  listAnalysisAttachmentOptions.mockResolvedValue({ ...common, items: [option], nextCursor: null });
});
afterEach(() => vi.unstubAllGlobals());

it.each(['restricted', 'unavailable'])('retains imported caption and unknown supplied context for a %s source without requesting a preview', async sourceAccess => {
  listAnalysisAttachments.mockResolvedValue({ ...common, canWrite: false, attachments: [{ ...originalItem, sourceAccess }], nextCursor: null });
  render(<AnalysisAttachments {...props} role="viewer" />);
  fireEvent.click(await inside().findByRole('button', { name: 'Inspect result and context' }));
  expect(await inside().findByRole('heading', { name: 'Earlier attachment' })).toBeVisible();
  fireEvent.click(inside().getByText('Supplied context and exact version'));
  expect(inside().getByText(/Execution evidence for this attachment is unknown/)).toBeVisible();
  expect(inside().getAllByText('Unknown / not supplied')).toHaveLength(4);
  expect(preview.render).not.toHaveBeenCalled();
  expect(inside().queryByRole('button', { name: 'Attach outside result', exact: true })).not.toBeInTheDocument();
});

it('freezes a normalized attachment request through an unknown result, explicit missing-receipt check and deliberate retry', async () => {
  createAnalysisAttachment.mockRejectedValueOnce(unknown()); getAnalysisAttachmentRequest.mockRejectedValueOnce(missing());
  render(<AnalysisAttachments {...props} />); const form = await fillForm(); const body = await submit();
  const recovery = await inside().findByRole('region', { name: 'Attachment recovery' });
  await within(recovery).findByRole('heading', { name: 'Attachment completion is unconfirmed' });
  expect(body).toMatchObject({ requestId: expect.stringMatching(/^[a-f0-9-]{36}$/), reference,
    caption: 'Imported score comparison', suppliedOrigin: { ...emptyOrigin, origin: 'External lab' } });
  expect(within(form).getByLabelText('Result caption')).toBeDisabled();
  expect(within(form).getByLabelText('Where this result came from')).toBeDisabled();
  expect(within(form).getByRole('radio', { name: /scores.csv/ })).toBeDisabled();
  expect(getAnalysisAttachmentRequest).not.toHaveBeenCalled();
  expect(within(recovery).queryByRole('button', { name: 'Retry original attachment' })).not.toBeInTheDocument();
  fireEvent.click(within(recovery).getByRole('button', { name: 'Check attachment outcome' }));
  expect(await inside().findByRole('alert')).toHaveTextContent('does not prove the original request was rejected');
  expect(getAnalysisAttachmentRequest).toHaveBeenCalledExactlyOnceWith(projectId, analysis.id, body.requestId, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  expect(createAnalysisAttachment).toHaveBeenCalledTimes(1);
  const receipt = accepted(body); createAnalysisAttachment.mockResolvedValueOnce(receipt);
  listAnalysisAttachments.mockResolvedValue({ ...common, attachments: [receipt.attachment], nextCursor: null });
  fireEvent.click(within(recovery).getByRole('button', { name: 'Retry original attachment' }));
  expect(await inside().findByRole('region', { name: 'Attachment confirmed' })).toHaveTextContent('Result attached.');
  expect(createAnalysisAttachment.mock.calls[1][2]).toBe(body);
  expect(createAnalysisAttachment).toHaveBeenCalledTimes(2);
  expect(preview.render).not.toHaveBeenCalled();
});

it('recovers acceptance for a current reader through GET without another create', async () => {
  createAnalysisAttachment.mockRejectedValueOnce(unknown());
  const view = render(<AnalysisAttachments {...props} />); await fillForm(); const body = await submit();
  const recovery = await inside().findByRole('region', { name: 'Attachment recovery' });
  await within(recovery).findByRole('heading', { name: 'Attachment completion is unconfirmed' });
  const receipt = accepted(body, { canWrite: false }); receipt.replayed = true;
  getAnalysisAttachmentRequest.mockResolvedValueOnce(receipt);
  listAnalysisAttachments.mockResolvedValue({ ...common, canWrite: false, attachments: [receipt.attachment], nextCursor: null });
  view.rerender(<AnalysisAttachments {...props} role="viewer" />);
  fireEvent.click(within(recovery).getByRole('button', { name: 'Check attachment outcome' }));
  await inside().findByRole('region', { name: 'Attachment confirmed' });
  expect(createAnalysisAttachment).toHaveBeenCalledTimes(1);
  expect(inside().getByText(/New attachments require current write access/)).toBeVisible();
  expect(inside().queryByRole('button', { name: 'Attach outside result', exact: true })).not.toBeInTheDocument();
});

it('keeps an acknowledgement with changed source or caption unconfirmed', async () => {
  createAnalysisAttachment.mockImplementationOnce(async (_project, _analysis, body) => {
    const receipt = accepted(body); receipt.acceptedRevision.caption = 'Another result'; return receipt;
  });
  render(<AnalysisAttachments {...props} />); await fillForm(); const body = await submit();
  const recovery = await inside().findByRole('region', { name: 'Attachment recovery' });
  await within(recovery).findByRole('heading', { name: 'Attachment completion is unconfirmed' });
  expect(within(recovery).getByText(body.requestId)).toBeInTheDocument();
  expect(inside().queryByRole('region', { name: 'Attachment confirmed' })).not.toBeInTheDocument();
  expect(inside().getByLabelText('Result caption')).toBeDisabled();
  expect(preview.render).not.toHaveBeenCalled();
});

it('releases a first exact source-unavailable rejection and preserves the caption while allowing another source', async () => {
  createAnalysisAttachment.mockRejectedValueOnce(Object.assign(new Error('Choose an exact managed version available to your account.'), {
    status: 404, code: 'ANALYSIS_ATTACHMENT_SOURCE_UNAVAILABLE',
  })).mockRejectedValueOnce(unknown());
  render(<AnalysisAttachments {...props} />); await fillForm('Keep this caption'); const rejected = await submit();
  await inside().findByRole('alert');
  expect(inside().queryByRole('region', { name: 'Attachment recovery' })).not.toBeInTheDocument();
  expect(inside().getByLabelText('Result caption')).toBeEnabled();
  expect(inside().getByLabelText('Result caption')).toHaveValue('Keep this caption');
  expect(inside().getByLabelText('Where this result came from')).toHaveValue('  External lab  ');
  expect(inside().queryByText(/Selected: scores.csv/)).not.toBeInTheDocument();
  const choose = inside().getByRole('button', { name: 'Choose saved file' }); expect(choose).toBeEnabled();
  const corrected = { ...option, reference: { ...reference, versionId: `av_${'9'.repeat(24)}` }, name: 'corrected.csv' };
  listAnalysisAttachmentOptions.mockResolvedValueOnce({ ...common, items: [corrected], nextCursor: null });
  fireEvent.click(choose);
  fireEvent.click(await inside().findByRole('radio', { name: /corrected.csv/ }));
  fireEvent.click(inside().getByRole('button', { name: 'Attach result', exact: true }));
  await waitFor(() => expect(createAnalysisAttachment).toHaveBeenCalledTimes(2));
  const next = createAnalysisAttachment.mock.calls[1][2];
  expect(next.requestId).not.toBe(rejected.requestId);
  expect(next).toMatchObject({ reference: corrected.reference, caption: 'Keep this caption', suppliedOrigin: { ...emptyOrigin, origin: 'External lab' } });
  await inside().findByRole('heading', { name: 'Attachment completion is unconfirmed' });
});

it('keeps a newer inspected attachment when an earlier create finishes late', async () => {
  const completion = deferred(); createAnalysisAttachment.mockReturnValueOnce(completion.promise);
  render(<AnalysisAttachments {...props} />); await fillForm(); const body = await submit();
  listAnalysisAttachments.mockResolvedValue({ ...common, attachments: [originalItem], nextCursor: null });
  fireEvent.click(inside().getByRole('button', { name: 'Refresh results' }));
  fireEvent.click(await inside().findByRole('button', { name: 'Inspect result and context' }));
  await inside().findByLabelText('Authorized artifact preview');
  const receipt = accepted(body);
  listAnalysisAttachments.mockResolvedValue({ ...common, attachments: [receipt.attachment, originalItem], nextCursor: null });
  await act(async () => completion.resolve(receipt));
  expect(inside().getByRole('heading', { name: 'Earlier attachment' })).toBeVisible();
  expect(inside().getByLabelText('Authorized artifact preview')).toHaveTextContent(originalItem.revision.reference.versionId);
  expect(preview.render.mock.calls.some(([value]) => value.reference.versionId === reference.versionId)).toBe(false);
});

it('preserves a caption and supplied context while navigating between analyses without copying the selected source', async () => {
  const view = render(<AnalysisAttachments {...props} />); await fillForm('An unsaved caption');
  view.rerender(<AnalysisAttachments {...props} analysis={otherAnalysis} />);
  await inside().findByText('No outside results attached');
  fireEvent.click(inside().getByRole('button', { name: 'Attach outside result', exact: true }));
  expect(inside().getByLabelText('Result caption')).toHaveValue('');
  expect(inside().queryByText(/Selected: scores.csv/)).not.toBeInTheDocument();
  view.rerender(<AnalysisAttachments {...props} />);
  expect(inside().getByLabelText('Result caption')).toHaveValue('An unsaved caption');
  expect(inside().getByLabelText('Where this result came from')).toHaveValue('  External lab  ');
  expect(inside().getByText(/Selected: scores.csv/)).toBeVisible();
  expect(createAnalysisAttachment).not.toHaveBeenCalled();
});

it('clears server-derived sources after a fresh access denial while keeping the user caption and supplied context', async () => {
  render(<AnalysisAttachments {...props} />); await fillForm('My private draft caption');
  fireEvent.click(inside().getByRole('button', { name: 'Preview scores.csv' }));
  await inside().findByLabelText('Authorized artifact preview');
  fireEvent.click(inside().getByRole('button', { name: 'Back to outside results' }));
  listAnalysisAttachments.mockRejectedValueOnce(Object.assign(new Error('Project access was removed.'), { status: 403, code: 'FORBIDDEN' }));
  fireEvent.click(inside().getByRole('button', { name: 'Refresh results' }));
  await inside().findByRole('alert');
  expect(inside().queryByLabelText('Authorized artifact preview')).not.toBeInTheDocument();
  expect(inside().queryByRole('radio', { name: /scores.csv/ })).not.toBeInTheDocument();
  expect(inside().queryByText(/Selected: scores.csv/)).not.toBeInTheDocument();
  expect(inside().getByLabelText('Result caption')).toHaveValue('My private draft caption');
  expect(inside().getByLabelText('Where this result came from')).toHaveValue('  External lab  ');
  expect(inside().getByLabelText('Result caption')).toBeDisabled();
});

it('does not restore stale acceptance or write controls after a fresh scope denial during a held create reply', async () => {
  const completion = deferred(); createAnalysisAttachment.mockReturnValueOnce(completion.promise);
  render(<AnalysisAttachments {...props} />); await fillForm('Keep the denied request'); const body = await submit();
  const signal = createAnalysisAttachment.mock.calls[0][3].signal;
  listAnalysisAttachments.mockRejectedValueOnce(Object.assign(new Error('Analysis attachment not found.'), {
    status: 404, code: 'ANALYSIS_ATTACHMENT_NOT_FOUND',
  }));
  fireEvent.click(inside().getByRole('button', { name: 'Refresh results' }));
  await inside().findByRole('alert');
  expect(signal.aborted).toBe(true);
  expect(inside().queryByRole('radio', { name: /scores.csv/ })).not.toBeInTheDocument();
  expect(inside().queryByText(/Selected: scores.csv/)).not.toBeInTheDocument();
  await act(async () => completion.resolve(accepted(body)));
  const recovery = inside().getByRole('region', { name: 'Attachment recovery' });
  expect(within(recovery).getByText(body.requestId)).toBeInTheDocument();
  expect(within(recovery).getByRole('heading')).toHaveTextContent('Attachment completion is unconfirmed');
  expect(inside().queryByRole('region', { name: 'Attachment confirmed' })).not.toBeInTheDocument();
  expect(inside().queryByRole('button', { name: 'Attach outside result', exact: true })).not.toBeInTheDocument();
  expect(inside().getByRole('button', { name: 'Choose saved file' })).toBeDisabled();
  expect(inside().getByLabelText('Result caption')).toHaveValue('Keep the denied request');
  expect(inside().getByLabelText('Where this result came from')).toHaveValue('  External lab  ');
  expect(listAnalysisAttachments).toHaveBeenCalledTimes(2);
});

it.each(['POST', 'GET'])('aborts a %s when blocked and ignores its late acceptance without losing the frozen request', async transport => {
  const completion = deferred();
  if (transport === 'POST') createAnalysisAttachment.mockReturnValueOnce(completion.promise);
  else { createAnalysisAttachment.mockRejectedValueOnce(unknown()); getAnalysisAttachmentRequest.mockReturnValueOnce(completion.promise); }
  const view = render(<AnalysisAttachments {...props} />); await fillForm(); const body = await submit();
  const recovery = await inside().findByRole('region', { name: 'Attachment recovery' });
  if (transport === 'GET') {
    await within(recovery).findByRole('heading', { name: 'Attachment completion is unconfirmed' });
    fireEvent.click(within(recovery).getByRole('button', { name: 'Check attachment outcome' }));
    await waitFor(() => expect(getAnalysisAttachmentRequest).toHaveBeenCalledTimes(1));
  }
  const signal = transport === 'POST' ? createAnalysisAttachment.mock.calls[0][3].signal : getAnalysisAttachmentRequest.mock.calls[0][3].signal;
  view.rerender(<AnalysisAttachments {...props} connection={{ ...props.connection, blocked: true, epoch: 2 }} />);
  expect(signal.aborted).toBe(true);
  await act(async () => completion.resolve(accepted(body)));
  expect(inside().queryByRole('region', { name: 'Attachment confirmed' })).not.toBeInTheDocument();
  expect(within(recovery).getByText(body.requestId)).toBeInTheDocument();
  expect(within(recovery).getByRole('button', { name: 'Check attachment outcome' })).toBeDisabled();
  expect(inside().getByLabelText('Result caption')).toHaveValue('  Imported score comparison  ');
  expect(createAnalysisAttachment).toHaveBeenCalledTimes(1);
});

it('keeps a pending request in its original analysis and ignores its late response after navigating away', async () => {
  const completion = deferred(); createAnalysisAttachment.mockReturnValueOnce(completion.promise);
  const view = render(<AnalysisAttachments {...props} />); await fillForm(); const body = await submit();
  const signal = createAnalysisAttachment.mock.calls[0][3].signal;
  view.rerender(<AnalysisAttachments {...props} analysis={otherAnalysis} />);
  expect(signal.aborted).toBe(true);
  await act(async () => completion.resolve(accepted(body)));
  expect(inside().queryByRole('region', { name: 'Attachment recovery' })).not.toBeInTheDocument();
  expect(inside().queryByRole('region', { name: 'Attachment confirmed' })).not.toBeInTheDocument();
  view.rerender(<AnalysisAttachments {...props} />);
  const recovery = inside().getByRole('region', { name: 'Attachment recovery' });
  expect(within(recovery).getByText(body.requestId)).toBeInTheDocument();
  expect(within(recovery).getByRole('button', { name: 'Check attachment outcome' })).toBeEnabled();
  expect(getAnalysisAttachmentRequest).not.toHaveBeenCalled(); expect(createAnalysisAttachment).toHaveBeenCalledTimes(1);
});
