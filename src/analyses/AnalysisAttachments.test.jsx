import React from 'react';
import { createHash, webcrypto } from 'node:crypto';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import AnalysisAttachments from './AnalysisAttachments';
import { createAnalysisAttachment, correctAnalysisAttachment, getAnalysisAttachmentRequest, getAnalysisAttachmentRevision,
  listAnalysisAttachments, listAnalysisAttachmentOptions, listAnalysisAttachmentRevisions } from './analysisAttachmentApi';
import { canonicalAnalysisAttachmentContent, canonicalAnalysisAttachmentCorrection } from '../../shared/analysisAttachment.mjs';

const preview = vi.hoisted(() => ({ render: vi.fn() }));
vi.mock('../components/RetainedArtifactView', () => ({ default: props => {
  preview.render(props);
  return <p aria-label="Authorized artifact preview">{props.reference.versionId}</p>;
} }));
vi.mock('./analysisAttachmentApi', () => ({ createAnalysisAttachment: vi.fn(), getAnalysisAttachmentRequest: vi.fn(),
  listAnalysisAttachments: vi.fn(), listAnalysisAttachmentOptions: vi.fn(), correctAnalysisAttachment: vi.fn(),
  getAnalysisAttachmentRevision: vi.fn(), listAnalysisAttachmentRevisions: vi.fn() }));

const projectId = `proj_${'1'.repeat(24)}`;
const analysis = { id: `ra_${'2'.repeat(24)}`, name: 'Treatment response', status: 'active' };
const otherAnalysis = { ...analysis, id: `ra_${'9'.repeat(24)}`, name: 'Other question' };
const reference = { kind: 'artifact-version', versionId: `av_${'5'.repeat(24)}`, sha256: 'a'.repeat(64) };
const emptyOrigin = { origin: null, sourceReference: null, documentReference: null, environmentReference: null };
const option = { reference, name: 'scores.csv', format: { id: 'org.ietf.csv', version: '1' }, sizeBytes: 14, createdAt: '2026-10-20T12:00:00Z' };
const common = { projectId, analysisId: analysis.id, canWrite: true };
const originalItem = { id: `raa_${'3'.repeat(24)}`, headRevisionId: `rar_${'4'.repeat(24)}`, sourceAccess: 'available', revision: {
  id: `rar_${'4'.repeat(24)}`, attachmentId: `raa_${'3'.repeat(24)}`, revisionNumber: 1, previousRevisionId: null,
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
    id: `rar_${'8'.repeat(24)}`, attachmentId: `raa_${'7'.repeat(24)}`, revisionNumber: 1, previousRevisionId: null,
    reference: { ...body.reference }, caption: body.caption, suppliedOrigin: { ...body.suppliedOrigin }, createdByUserId: 1, createdAt: '2026-10-20T13:00:00Z',
  } };
  return { ...common, canWrite, requestId: body.requestId, requestSha256: createHash('sha256').update(canonicalAnalysisAttachmentContent(body)).digest('hex'),
    replayed: false, acceptedRevision: structuredClone(item.revision), attachment: item };
}
const secondItem = { ...originalItem, id: `raa_${'a'.repeat(24)}`, headRevisionId: `rar_${'b'.repeat(24)}`,
  revision: { ...originalItem.revision, id: `rar_${'b'.repeat(24)}`, attachmentId: `raa_${'a'.repeat(24)}`, caption: 'Second attachment' } };
function acceptedCorrection(body, { item = originalItem, sourceAccess = 'available', canWrite = true, current } = {}) {
  const saved = { ...item.revision, id: `rar_${'8'.repeat(24)}`, previousRevisionId: body.expectedHeadRevisionId,
    revisionNumber: item.revision.revisionNumber + 1, reference: { ...body.reference }, caption: body.caption,
    suppliedOrigin: { ...body.suppliedOrigin }, createdByUserId: props.userId, createdAt: '2026-10-20T13:00:00Z' };
  return { ...common, canWrite, requestId: body.requestId,
    requestSha256: createHash('sha256').update(canonicalAnalysisAttachmentCorrection(item.id, body)).digest('hex'), replayed: false,
    acceptedRevision: saved, acceptedSourceAccess: sourceAccess,
    attachment: current || { ...item, headRevisionId: saved.id, revision: structuredClone(saved), sourceAccess } };
}
const savedItems = items => listAnalysisAttachments.mockResolvedValue({ ...common, attachments: items, nextCursor: null });
async function beginCorrection(item = originalItem) {
  const row = (await inside().findAllByRole('listitem')).find(element => element.textContent.includes(item.revision.caption));
  fireEvent.click(within(row).getByRole('button', { name: 'Correct caption or source' }));
  return inside().getByRole('form', { name: 'Correct outside result' });
}
async function saveCorrection(count = 1) {
  fireEvent.click(inside().getByRole('button', { name: 'Save correction', exact: true }));
  await waitFor(() => expect(correctAnalysisAttachment).toHaveBeenCalledTimes(count));
  return correctAnalysisAttachment.mock.calls[count - 1][3];
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
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

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

it('saves normalized caption and context against the exact frozen head while preserving a colleague private source without previewing it', async () => {
  const privateItem = { ...originalItem, sourceAccess: 'restricted', revision: { ...originalItem.revision, createdByUserId: 2 } };
  savedItems([privateItem]);
  correctAnalysisAttachment.mockImplementationOnce(async (_project, _analysis, _attachment, body) => {
    const result = acceptedCorrection(body, { item: privateItem, sourceAccess: 'restricted' }); savedItems([result.attachment]); return result;
  });
  render(<AnalysisAttachments {...props} />); const form = await beginCorrection(privateItem);
  expect(within(form).getByText(/Current attached source/)).toBeVisible();
  fireEvent.change(within(form).getByLabelText('Result caption'), { target: { value: '  Corrected private caption  ' } });
  fireEvent.click(within(form).getByText('Add supplied origin and references (optional)'));
  fireEvent.change(within(form).getByLabelText('Where this result came from'), { target: { value: '  Supplied by colleague  ' } });
  const body = await saveCorrection();
  expect(correctAnalysisAttachment).toHaveBeenCalledWith(projectId, analysis.id, privateItem.id, expect.objectContaining({
    requestId: expect.stringMatching(/^[a-f0-9-]{36}$/), expectedHeadRevisionId: privateItem.headRevisionId,
    reference: privateItem.revision.reference, caption: 'Corrected private caption', suppliedOrigin: { ...emptyOrigin, origin: 'Supplied by colleague' },
  }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
  expect(await inside().findByRole('region', { name: 'Attachment confirmed' })).toHaveTextContent('Correction saved as revision 2.');
  expect(body.reference).toEqual(privateItem.revision.reference);
  expect(preview.render).not.toHaveBeenCalled(); expect(getAnalysisAttachmentRevision).not.toHaveBeenCalled();
  expect(createAnalysisAttachment).not.toHaveBeenCalled();
});

it('changes the source only when a different owned exact saved version is selected for correction', async () => {
  savedItems([originalItem]); correctAnalysisAttachment.mockRejectedValueOnce(unknown());
  render(<AnalysisAttachments {...props} />); const form = await beginCorrection();
  fireEvent.click(within(form).getByRole('button', { name: 'Choose saved file' }));
  fireEvent.click(await within(form).findByRole('radio', { name: /scores.csv/ }));
  fireEvent.change(within(form).getByLabelText('Result caption'), { target: { value: 'Corrected source' } });
  const body = await saveCorrection();
  expect(body).toMatchObject({ expectedHeadRevisionId: originalItem.headRevisionId, reference, caption: 'Corrected source' });
  expect(body.reference.versionId).not.toBe(originalItem.revision.reference.versionId);
  await inside().findByRole('heading', { name: 'Attachment completion is unconfirmed' });
  expect(preview.render).not.toHaveBeenCalled();
});

it('keeps separate create and correction drafts for two attachments, including each source and supplied context', async () => {
  savedItems([originalItem, secondItem]); render(<AnalysisAttachments {...props} />);
  await inside().findByText(originalItem.revision.caption);
  fireEvent.click(inside().getByRole('button', { name: 'Attach outside result', exact: true }));
  fireEvent.click(inside().getByRole('button', { name: 'Choose saved file' }));
  fireEvent.click(await inside().findByRole('radio', { name: /scores.csv/ }));
  fireEvent.change(inside().getByLabelText('Result caption'), { target: { value: 'Unsaved new attachment' } });
  await beginCorrection();
  fireEvent.change(inside().getByLabelText('Result caption'), { target: { value: 'First correction draft' } });
  fireEvent.change(inside().getByLabelText('Code or method reference'), { target: { value: 'First method note' } });
  await beginCorrection(secondItem);
  fireEvent.change(inside().getByLabelText('Result caption'), { target: { value: 'Second correction draft' } });
  fireEvent.change(inside().getByLabelText('Code or method reference'), { target: { value: 'Second method note' } });
  fireEvent.click(inside().getByRole('button', { name: 'Attach outside result', exact: true }));
  expect(inside().getByRole('form', { name: 'Attach outside result' })).toBeVisible();
  expect(inside().getByLabelText('Result caption')).toHaveValue('Unsaved new attachment');
  expect(inside().getByText(/Selected: scores.csv/)).toBeVisible();
  await beginCorrection();
  expect(inside().getByLabelText('Result caption')).toHaveValue('First correction draft');
  expect(inside().getByLabelText('Code or method reference')).toHaveValue('First method note');
  expect(inside().getByText(/Current attached source/)).toBeVisible();
  await beginCorrection(secondItem);
  expect(inside().getByLabelText('Result caption')).toHaveValue('Second correction draft');
  expect(inside().getByLabelText('Code or method reference')).toHaveValue('Second method note');
  expect(correctAnalysisAttachment).not.toHaveBeenCalled(); expect(createAnalysisAttachment).not.toHaveBeenCalled();
});

it('opens the exact accepted correction rather than a newer current head after recovering its original receipt', async () => {
  savedItems([originalItem]); correctAnalysisAttachment.mockRejectedValueOnce(unknown());
  render(<AnalysisAttachments {...props} />); await beginCorrection();
  fireEvent.change(inside().getByLabelText('Result caption'), { target: { value: 'Original accepted correction' } });
  const body = await saveCorrection();
  const receipt = acceptedCorrection(body); receipt.replayed = true;
  receipt.attachment = { ...receipt.attachment, headRevisionId: `rar_${'9'.repeat(24)}`, revision: { ...receipt.attachment.revision,
    id: `rar_${'9'.repeat(24)}`, previousRevisionId: receipt.acceptedRevision.id, revisionNumber: 3, caption: 'A later current correction',
    reference: { ...reference, versionId: `av_${'a'.repeat(24)}` }, createdByUserId: 2 } };
  getAnalysisAttachmentRequest.mockResolvedValueOnce(receipt); savedItems([receipt.attachment]);
  getAnalysisAttachmentRevision.mockResolvedValueOnce({ ...common, attachmentId: originalItem.id, headRevisionId: receipt.attachment.headRevisionId,
    revision: receipt.acceptedRevision, sourceAccess: receipt.acceptedSourceAccess });
  const recovery = await inside().findByRole('region', { name: 'Attachment recovery' });
  await within(recovery).findByRole('heading', { name: 'Attachment completion is unconfirmed' });
  fireEvent.click(within(recovery).getByRole('button', { name: 'Check attachment outcome' }));
  const confirmation = await inside().findByRole('region', { name: 'Attachment confirmed' });
  expect(confirmation).toHaveTextContent('A newer revision is current.');
  fireEvent.click(within(confirmation).getByRole('button', { name: 'Inspect saved correction' }));
  expect(await inside().findByRole('heading', { name: 'Original accepted correction' })).toBeVisible();
  expect(getAnalysisAttachmentRevision).toHaveBeenCalledWith(projectId, analysis.id, originalItem.id, receipt.acceptedRevision.id, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  expect(inside().getByLabelText('Authorized artifact preview')).toHaveTextContent(body.reference.versionId);
  expect(preview.render.mock.calls.some(([value]) => value.reference.versionId === receipt.attachment.revision.reference.versionId)).toBe(false);
  expect(correctAnalysisAttachment).toHaveBeenCalledTimes(1);
});

it('keeps the exact correction UUID, expected head and body frozen through receipt404 and deliberate manual retry', async () => {
  savedItems([originalItem]); correctAnalysisAttachment.mockRejectedValueOnce(unknown()); getAnalysisAttachmentRequest.mockRejectedValueOnce(missing());
  render(<AnalysisAttachments {...props} />); const form = await beginCorrection();
  fireEvent.change(within(form).getByLabelText('Result caption'), { target: { value: '  Frozen correction  ' } });
  const body = await saveCorrection(); const recovery = await inside().findByRole('region', { name: 'Attachment recovery' });
  await within(recovery).findByRole('heading', { name: 'Attachment completion is unconfirmed' });
  expect(body).toMatchObject({ expectedHeadRevisionId: originalItem.headRevisionId, caption: 'Frozen correction' });
  expect(within(form).getByLabelText('Result caption')).toBeDisabled();
  expect(within(recovery).queryByRole('button', { name: 'Retry original attachment' })).not.toBeInTheDocument();
  expect(getAnalysisAttachmentRequest).not.toHaveBeenCalled();
  fireEvent.click(within(recovery).getByRole('button', { name: 'Check attachment outcome' }));
  expect(await inside().findByRole('alert')).toHaveTextContent('does not prove the original request was rejected');
  const receipt = acceptedCorrection(body); correctAnalysisAttachment.mockResolvedValueOnce(receipt); savedItems([receipt.attachment]);
  fireEvent.click(within(recovery).getByRole('button', { name: 'Retry original attachment' }));
  await inside().findByRole('region', { name: 'Attachment confirmed' });
  expect(correctAnalysisAttachment.mock.calls[1][3]).toBe(body);
  expect(correctAnalysisAttachment.mock.calls[1].slice(0, 3)).toEqual([projectId, analysis.id, originalItem.id]);
  expect(createAnalysisAttachment).not.toHaveBeenCalled();
});

it('keeps user edits after a bound CAS rejection and deliberately rebases untouched source/context onto the latest revision', async () => {
  const base = { ...originalItem, revision: { ...originalItem.revision, suppliedOrigin: { ...emptyOrigin, origin: 'Original origin', sourceReference: 'Original method' } } };
  const latest = { ...base, headRevisionId: `rar_${'9'.repeat(24)}`, revision: { ...base.revision, id: `rar_${'9'.repeat(24)}`,
    previousRevisionId: base.headRevisionId, revisionNumber: 2, caption: 'Latest server caption',
    reference: { ...reference }, suppliedOrigin: { ...emptyOrigin, origin: 'Latest origin', sourceReference: 'Latest method', environmentReference: 'Latest environment' } } };
  savedItems([base]);
  correctAnalysisAttachment.mockRejectedValueOnce(Object.assign(new Error('This attachment changed.'), { status: 409, code: 'ANALYSIS_ATTACHMENT_HEAD_CONFLICT',
    submittedExpectedHeadRevisionId: base.headRevisionId, attachment: latest })).mockRejectedValueOnce(unknown());
  render(<AnalysisAttachments {...props} />); await beginCorrection(base);
  fireEvent.change(inside().getByLabelText('Result caption'), { target: { value: 'My edited caption' } });
  fireEvent.change(inside().getByLabelText('Code or method reference'), { target: { value: 'My edited method' } });
  const first = await saveCorrection();
  const conflict = await inside().findByRole('region', { name: 'Newer attachment revision' });
  expect(inside().getByLabelText('Result caption')).toHaveValue('My edited caption');
  expect(inside().getByRole('button', { name: 'Save correction' })).toBeDisabled();
  expect(inside().queryByRole('region', { name: 'Attachment recovery' })).not.toBeInTheDocument();
  fireEvent.click(within(conflict).getByRole('button', { name: 'Keep my edits with latest revision' }));
  expect(inside().getByLabelText('Result caption')).toHaveValue('My edited caption');
  expect(inside().getByLabelText('Where this result came from')).toHaveValue('Latest origin');
  expect(inside().getByLabelText('Code or method reference')).toHaveValue('My edited method');
  expect(inside().getByLabelText('Environment reference')).toHaveValue('Latest environment');
  const rebased = await saveCorrection(2);
  expect(rebased).toMatchObject({ expectedHeadRevisionId: latest.headRevisionId, reference: latest.revision.reference, caption: 'My edited caption',
    suppliedOrigin: { ...latest.revision.suppliedOrigin, sourceReference: 'My edited method' } });
  expect(rebased.requestId).not.toBe(first.requestId);
  await inside().findByRole('heading', { name: 'Attachment completion is unconfirmed' });
});

it('releases earlier uncertainty only for a bound, monotonic serialized CAS rejection', async () => {
  const latest = { ...originalItem, headRevisionId: `rar_${'9'.repeat(24)}`, revision: { ...originalItem.revision,
    id: `rar_${'9'.repeat(24)}`, previousRevisionId: originalItem.headRevisionId, revisionNumber: 2, caption: 'Newer saved revision' } };
  savedItems([originalItem]); correctAnalysisAttachment.mockRejectedValueOnce(unknown()); getAnalysisAttachmentRequest.mockRejectedValueOnce(missing());
  correctAnalysisAttachment.mockRejectedValueOnce(Object.assign(new Error('This attachment changed.'), { status: 409, code: 'ANALYSIS_ATTACHMENT_HEAD_CONFLICT',
    submittedExpectedHeadRevisionId: originalItem.headRevisionId, attachment: latest }));
  render(<AnalysisAttachments {...props} />); await beginCorrection(); const body = await saveCorrection();
  const recovery = await inside().findByRole('region', { name: 'Attachment recovery' });
  await within(recovery).findByRole('heading', { name: 'Attachment completion is unconfirmed' });
  fireEvent.click(within(recovery).getByRole('button', { name: 'Check attachment outcome' }));
  fireEvent.click(await within(recovery).findByRole('button', { name: 'Retry original attachment' }));
  await inside().findByRole('region', { name: 'Newer attachment revision' });
  expect(correctAnalysisAttachment.mock.calls[1][3]).toBe(body);
  expect(inside().queryByRole('region', { name: 'Attachment recovery' })).not.toBeInTheDocument();
  expect(inside().getByLabelText('Result caption')).toBeEnabled();
});

it('keeps a correction unconfirmed when a receipt lookup returns a conflict that only the mutation endpoint can establish', async () => {
  const latest = { ...originalItem, headRevisionId: `rar_${'9'.repeat(24)}`, revision: { ...originalItem.revision,
    id: `rar_${'9'.repeat(24)}`, previousRevisionId: originalItem.headRevisionId, revisionNumber: 2, caption: 'A newer head' } };
  savedItems([originalItem]); correctAnalysisAttachment.mockRejectedValueOnce(unknown());
  getAnalysisAttachmentRequest.mockRejectedValueOnce(Object.assign(new Error('Invalid lookup conflict.'), { status: 409, code: 'ANALYSIS_ATTACHMENT_HEAD_CONFLICT',
    submittedExpectedHeadRevisionId: originalItem.headRevisionId, attachment: latest }));
  render(<AnalysisAttachments {...props} />); await beginCorrection(); const body = await saveCorrection();
  const recovery = await inside().findByRole('region', { name: 'Attachment recovery' });
  await within(recovery).findByRole('heading', { name: 'Attachment completion is unconfirmed' });
  fireEvent.click(within(recovery).getByRole('button', { name: 'Check attachment outcome' }));
  await waitFor(() => expect(getAnalysisAttachmentRequest).toHaveBeenCalledTimes(1));
  expect(await inside().findByRole('heading', { name: 'Attachment completion is unconfirmed' })).toBeVisible();
  expect(within(recovery).getByText(body.requestId)).toBeInTheDocument();
  expect(inside().queryByRole('region', { name: 'Newer attachment revision' })).not.toBeInTheDocument();
  expect(inside().getByLabelText('Result caption')).toBeDisabled();
});

it.each(['unrelated attachment', 'same revision number', 'wrong submitted head', 'wrong status'])('keeps a malformed CAS rejection unconfirmed for %s', async mismatch => {
  const latest = { ...originalItem, headRevisionId: `rar_${'9'.repeat(24)}`, revision: { ...originalItem.revision,
    id: `rar_${'9'.repeat(24)}`, previousRevisionId: originalItem.headRevisionId, revisionNumber: 2, caption: 'Unrelated conflict' } };
  const failure = Object.assign(new Error('This attachment changed.'), { status: 409, code: 'ANALYSIS_ATTACHMENT_HEAD_CONFLICT',
    submittedExpectedHeadRevisionId: originalItem.headRevisionId, attachment: latest });
  if (mismatch === 'unrelated attachment') { latest.id = secondItem.id; latest.revision.attachmentId = secondItem.id; }
  if (mismatch === 'same revision number') { latest.revision.revisionNumber = 1; latest.revision.previousRevisionId = null; }
  if (mismatch === 'wrong submitted head') failure.submittedExpectedHeadRevisionId = secondItem.headRevisionId;
  if (mismatch === 'wrong status') failure.status = 500;
  savedItems([originalItem]); correctAnalysisAttachment.mockRejectedValueOnce(failure);
  render(<AnalysisAttachments {...props} />); await beginCorrection(); const body = await saveCorrection();
  const recovery = await inside().findByRole('region', { name: 'Attachment recovery' });
  await within(recovery).findByRole('heading', { name: 'Attachment completion is unconfirmed' });
  expect(within(recovery).getByText(body.requestId)).toBeInTheDocument();
  expect(inside().queryByRole('region', { name: 'Newer attachment revision' })).not.toBeInTheDocument();
  expect(inside().getByLabelText('Result caption')).toBeDisabled();
});

it('fences a late accepted correction after a fresh scope denial while retaining its exact request', async () => {
  const completion = deferred(); savedItems([originalItem]); correctAnalysisAttachment.mockReturnValueOnce(completion.promise);
  render(<AnalysisAttachments {...props} />); await beginCorrection();
  fireEvent.change(inside().getByLabelText('Result caption'), { target: { value: 'Keep this correction request' } });
  const body = await saveCorrection(); const signal = correctAnalysisAttachment.mock.calls[0][4].signal;
  listAnalysisAttachments.mockRejectedValueOnce(Object.assign(new Error('Analysis unavailable.'), { status: 404, code: 'ANALYSIS_ATTACHMENT_NOT_FOUND' }));
  fireEvent.click(inside().getByRole('button', { name: 'Refresh results' })); await inside().findByRole('alert');
  expect(signal.aborted).toBe(true);
  await act(async () => completion.resolve(acceptedCorrection(body)));
  const recovery = inside().getByRole('region', { name: 'Attachment recovery' });
  expect(within(recovery).getByText(body.requestId)).toBeInTheDocument();
  expect(inside().queryByRole('region', { name: 'Attachment confirmed' })).not.toBeInTheDocument();
  expect(inside().queryByRole('button', { name: 'Correct caption or source' })).not.toBeInTheDocument();
  expect(inside().getByLabelText('Result caption')).toHaveValue('Keep this correction request');
});

async function inspectOriginalHistory(canWrite = true) {
  const row = (await inside().findAllByRole('listitem')).find(element => element.textContent.includes(originalItem.revision.caption));
  fireEvent.click(within(row).getByRole('button', { name: 'Inspect result and context' }));
  await inside().findByLabelText('Authorized artifact preview');
  listAnalysisAttachmentRevisions.mockResolvedValueOnce({ ...common, canWrite, attachmentId: originalItem.id, headRevisionId: originalItem.headRevisionId,
    revisions: [{ revision: originalItem.revision, sourceAccess: originalItem.sourceAccess }], nextCursor: null });
  fireEvent.click(inside().getByText('Saved revisions'));
  await inside().findByRole('button', { name: 'Open revision 1' });
}
const originalExact = () => ({ ...common, attachmentId: originalItem.id, headRevisionId: originalItem.headRevisionId,
  revision: structuredClone(originalItem.revision), sourceAccess: originalItem.sourceAccess });

it.each(['history', 'exact revision'])('honors current reader authority from a fresh %s read after an earlier writer catalog', async read => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 1100 });
  savedItems([originalItem]); render(<AnalysisAttachments {...props} />);
  expect(await inside().findByRole('button', { name: 'Correct caption or source' })).toBeEnabled();
  await inspectOriginalHistory(read === 'history' ? false : true);
  if (read === 'exact revision') {
    getAnalysisAttachmentRevision.mockResolvedValueOnce({ ...originalExact(), canWrite: false });
    fireEvent.click(inside().getByRole('button', { name: 'Open revision 1' }));
    await waitFor(() => expect(getAnalysisAttachmentRevision).toHaveBeenCalledTimes(1));
  }
  await waitFor(() => expect(inside().queryByRole('button', { name: 'Correct caption or source' })).not.toBeInTheDocument());
  expect(inside().queryByRole('button', { name: 'Attach outside result', exact: true })).not.toBeInTheDocument();
  expect(inside().getByLabelText('Authorized artifact preview')).toHaveTextContent(originalItem.revision.reference.versionId);
  expect(correctAnalysisAttachment).not.toHaveBeenCalled();
});

it.each(['catalog', 'options', 'correction'])('a fresh read-only historical observation fences an older %s response while keeping readable evidence and the draft', async transport => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 1100 });
  const completion = deferred(); savedItems([originalItem]);
  render(<AnalysisAttachments {...props} />); const form = await beginCorrection();
  fireEvent.change(within(form).getByLabelText('Result caption'), { target: { value: 'My retained correction draft' } });
  let body, signal;
  if (transport === 'catalog') {
    listAnalysisAttachments.mockReturnValueOnce(completion.promise);
    fireEvent.click(inside().getByRole('button', { name: 'Refresh results' }));
    await waitFor(() => expect(listAnalysisAttachments).toHaveBeenCalledTimes(2));
    signal = listAnalysisAttachments.mock.calls[1][2].signal;
  } else if (transport === 'options') {
    listAnalysisAttachmentOptions.mockReturnValueOnce(completion.promise);
    fireEvent.click(within(form).getByRole('button', { name: 'Choose saved file' }));
    await waitFor(() => expect(listAnalysisAttachmentOptions).toHaveBeenCalledTimes(1));
    signal = listAnalysisAttachmentOptions.mock.calls[0][2].signal;
  } else {
    correctAnalysisAttachment.mockReturnValueOnce(completion.promise); body = await saveCorrection();
    signal = correctAnalysisAttachment.mock.calls[0][4].signal;
  }
  await inspectOriginalHistory(false);
  await waitFor(() => expect(signal.aborted).toBe(true));
  expect(inside().getByLabelText('Authorized artifact preview')).toHaveTextContent(originalItem.revision.reference.versionId);
  expect(inside().getByLabelText('Result caption')).toHaveValue('My retained correction draft');
  const oldReply = transport === 'catalog' ? { ...common, attachments: [originalItem], nextCursor: null }
    : transport === 'options' ? { ...common, items: [option], nextCursor: null } : acceptedCorrection(body);
  await act(async () => completion.resolve(oldReply));
  expect(inside().queryByRole('button', { name: 'Correct caption or source' })).not.toBeInTheDocument();
  expect(inside().queryByRole('button', { name: 'Attach outside result', exact: true })).not.toBeInTheDocument();
  expect(inside().getByRole('button', { name: 'Save correction' })).toBeDisabled();
  expect(inside().getByLabelText('Result caption')).toHaveValue('My retained correction draft');
  if (transport === 'correction') {
    const recovery = inside().getByRole('region', { name: 'Attachment recovery' });
    expect(within(recovery).getByText(body.requestId)).toBeInTheDocument();
    expect(within(recovery).getByRole('heading')).toHaveTextContent('Attachment completion is unconfirmed');
    expect(inside().queryByRole('region', { name: 'Attachment confirmed' })).not.toBeInTheDocument();
  }
});

it('keeps a read-only observation latched through a later writable history response until a fresh catalog refresh', async () => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 1100 });
  savedItems([originalItem]); render(<AnalysisAttachments {...props} />); const form = await beginCorrection();
  fireEvent.change(within(form).getByLabelText('Result caption'), { target: { value: 'Draft kept across access refresh' } });
  await inspectOriginalHistory(false);
  await waitFor(() => expect(inside().queryByRole('button', { name: 'Correct caption or source' })).not.toBeInTheDocument());
  listAnalysisAttachmentRevisions.mockResolvedValueOnce({ ...common, attachmentId: originalItem.id, headRevisionId: originalItem.headRevisionId,
    revisions: [{ revision: originalItem.revision, sourceAccess: originalItem.sourceAccess }], nextCursor: null });
  fireEvent.click(inside().getByRole('button', { name: 'Refresh revisions' }));
  await waitFor(() => expect(listAnalysisAttachmentRevisions).toHaveBeenCalledTimes(2));
  expect(inside().queryByRole('button', { name: 'Correct caption or source' })).not.toBeInTheDocument();
  fireEvent.click(inside().getByRole('button', { name: 'Refresh results' }));
  expect(await inside().findByRole('button', { name: 'Correct caption or source' })).toBeEnabled();
  expect(inside().getByLabelText('Result caption')).toHaveValue('Draft kept across access refresh');
});

it.each(['catalog', 'options'])('a fresh read-only %s response fences an older accepted action without losing its original request', async read => {
  const completion = deferred(), options = deferred(); savedItems([originalItem]);
  correctAnalysisAttachment.mockReturnValueOnce(completion.promise);
  render(<AnalysisAttachments {...props} />); const form = await beginCorrection();
  fireEvent.change(within(form).getByLabelText('Result caption'), { target: { value: 'Original caption retained after access changes' } });
  if (read === 'options') {
    listAnalysisAttachmentOptions.mockReturnValueOnce(options.promise);
    fireEvent.click(within(form).getByRole('button', { name: 'Choose saved file' }));
    await waitFor(() => expect(listAnalysisAttachmentOptions).toHaveBeenCalledTimes(1));
  }
  const body = await saveCorrection(), signal = correctAnalysisAttachment.mock.calls[0][4].signal;
  if (read === 'catalog') {
    listAnalysisAttachments.mockResolvedValueOnce({ ...common, canWrite: false, attachments: [originalItem], nextCursor: null });
    fireEvent.click(inside().getByRole('button', { name: 'Refresh results' }));
  } else await act(async () => options.resolve({ ...common, canWrite: false, items: [option], nextCursor: null }));
  await waitFor(() => expect(inside().queryByRole('button', { name: 'Correct caption or source' })).not.toBeInTheDocument());
  expect(signal.aborted).toBe(true);
  await act(async () => completion.resolve(acceptedCorrection(body)));
  expect(inside().queryByRole('region', { name: 'Attachment confirmed' })).not.toBeInTheDocument();
  expect(inside().queryByRole('button', { name: 'Attach outside result', exact: true })).not.toBeInTheDocument();
  const recovery = inside().getByRole('region', { name: 'Attachment recovery' });
  expect(within(recovery).getByText(body.requestId)).toBeInTheDocument();
  expect(within(recovery).getByRole('heading')).toHaveTextContent('Attachment completion is unconfirmed');
  expect(inside().getByLabelText('Result caption')).toHaveValue('Original caption retained after access changes');
});

it.each(['attachment', 'revision', 'source'])('does not replace an inspected result with an exact-read response bound to the wrong %s', async mismatch => {
  savedItems([originalItem]); render(<AnalysisAttachments {...props} />); await inspectOriginalHistory();
  const response = originalExact();
  if (mismatch === 'attachment') response.attachmentId = secondItem.id;
  if (mismatch === 'revision') response.revision.id = secondItem.headRevisionId;
  if (mismatch === 'source') response.revision.reference.sha256 = 'b'.repeat(64);
  getAnalysisAttachmentRevision.mockResolvedValueOnce(response);
  fireEvent.click(inside().getByRole('button', { name: 'Open revision 1' }));
  expect(await inside().findByRole('alert')).toHaveTextContent('This exact saved revision could not be read.');
  expect(inside().getByRole('heading', { name: originalItem.revision.caption })).toBeVisible();
  expect(inside().getByLabelText('Authorized artifact preview')).toHaveTextContent(originalItem.revision.reference.versionId);
  expect(preview.render.mock.calls.every(([value]) => value.reference.sha256 === originalItem.revision.reference.sha256)).toBe(true);
});

it.each(['new selection', 'blocked', 'denied', 'unmounted'])('ignores a held exact revision after its view is interrupted by %s', async interruption => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 1100 });
  const later = { ...secondItem, revision: { ...secondItem.revision, reference } };
  const completion = deferred(); savedItems([originalItem, later]); getAnalysisAttachmentRevision.mockReturnValueOnce(completion.promise);
  const view = render(<AnalysisAttachments {...props} />); await inspectOriginalHistory();
  fireEvent.click(inside().getByRole('button', { name: 'Open revision 1' }));
  await waitFor(() => expect(getAnalysisAttachmentRevision).toHaveBeenCalledTimes(1));
  const signal = getAnalysisAttachmentRevision.mock.calls[0][4].signal;
  if (interruption === 'new selection') {
    const row = inside().getAllByRole('listitem').find(element => element.textContent.includes(later.revision.caption));
    fireEvent.click(within(row).getByRole('button', { name: 'Inspect result and context' }));
    await inside().findByRole('heading', { name: later.revision.caption });
  } else if (interruption === 'blocked') view.rerender(<AnalysisAttachments {...props} connection={{ ...props.connection, blocked: true, epoch: 2 }} />);
  else if (interruption === 'unmounted') view.unmount();
  else {
    listAnalysisAttachments.mockRejectedValueOnce(Object.assign(new Error('Project access denied.'), { status: 403, code: 'FORBIDDEN' }));
    fireEvent.click(inside().getByRole('button', { name: 'Refresh results' })); await inside().findByRole('alert');
  }
  expect(signal.aborted).toBe(true);
  await act(async () => completion.resolve(originalExact()));
  if (interruption === 'new selection') {
    expect(inside().getByRole('heading', { name: later.revision.caption })).toBeVisible();
    expect(inside().getByLabelText('Authorized artifact preview')).toHaveTextContent(reference.versionId);
  } else expect(screen.queryByRole('region', { name: 'Outside result details' })).not.toBeInTheDocument();
  expect(correctAnalysisAttachment).not.toHaveBeenCalled();
});
