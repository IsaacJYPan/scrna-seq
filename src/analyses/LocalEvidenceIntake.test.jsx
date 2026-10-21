import React from 'react';
import { createHash, webcrypto } from 'node:crypto';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import LocalEvidenceIntake from './LocalEvidenceIntake';
import { importArtifactVersion } from '../artifacts/artifactApi';
import { createAnalysisAttachment, correctAnalysisAttachment, listAnalysisLocalIntakes, createAnalysisLocalIntake, getAnalysisLocalIntake } from './analysisAttachmentApi';
import { canonicalAnalysisLocalIntake, analysisLocalIntakeAttachmentRequest } from '../../shared/analysisLocalIntake.mjs';
import { canonicalAnalysisAttachmentContent, canonicalAnalysisAttachmentCorrection } from '../../shared/analysisAttachment.mjs';
import { canonicalArtifactImportRequest } from '../artifacts/artifactImportReceipt';

vi.mock('../artifacts/artifactApi', () => ({ importArtifactVersion: vi.fn() }));
vi.mock('./analysisAttachmentApi', () => ({ createAnalysisAttachment: vi.fn(), correctAnalysisAttachment: vi.fn(),
  listAnalysisLocalIntakes: vi.fn(), createAnalysisLocalIntake: vi.fn(), getAnalysisLocalIntake: vi.fn() }));

const projectId = `proj_${'1'.repeat(24)}`, analysisId = `ra_${'2'.repeat(24)}`, serviceId = `svc_${'3'.repeat(32)}`;
const artifactId = `af_${'4'.repeat(24)}`, versionId = `av_${'5'.repeat(24)}`, attachmentId = `raa_${'6'.repeat(24)}`;
const originalHead = `rar_${'7'.repeat(24)}`, acceptedId = `rar_${'8'.repeat(24)}`, laterHead = `rar_${'9'.repeat(24)}`;
const requestId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', attachRequestId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const bytes = 'gene,score\nA,2', sha256 = value => createHash('sha256').update(value).digest('hex'), fileSha = sha256(bytes);
const blankOrigin = { origin: null, sourceReference: null, documentReference: null, environmentReference: null };
const recipe = (action = 'create') => ({ requestId, serviceId, importRequest: { schema: 'traceomics.artifact-import.v1', projectId,
  ownerUserId: 7, requestId, originalFilename: 'scores.csv', name: 'Outside scores', artifactType: 'auto', previousVersionId: null,
  sha256: fileSha, sizeBytes: 14 }, attachment: { requestId: attachRequestId, action, attachmentId: action === 'correct' ? attachmentId : null,
  expectedHeadRevisionId: action === 'correct' ? originalHead : null, caption: 'Outside table', suppliedOrigin: { ...blankOrigin } } });
const common = allowed => ({ serviceId, projectId, analysisId, ownerUserId: 7, canContinue: allowed, canUpload: allowed, canAttach: allowed });
function importReceipt(value, unavailable = false) {
  const request = structuredClone(value.importRequest), acceptance = { artifactId, versionId, versionNumber: 1, previousVersionId: null,
    sha256: request.sha256, sizeBytes: request.sizeBytes, createdAt: '2026-10-20T12:00:01.000Z' };
  return { requestId: value.requestId, request, status: 'succeeded', canImport: true, requestSha256: sha256(canonicalArtifactImportRequest(request)), acceptance,
    availability: unavailable ? 'unavailable' : 'recorded', version: unavailable ? null : { artifactId, versionId, projectId, ownerId: '7',
      sha256: request.sha256, sizeBytes: request.sizeBytes, name: request.name, versionNumber: 1, previousVersionId: null,
      reference: { artifactId, versionId, projectId, sha256: request.sha256 }, type: 'table', format: { id: 'org.ietf.csv', version: '1' } } };
}
function attachmentReceipt(value, { allowed = true, unavailable = false, newer = false } = {}) {
  const input = analysisLocalIntakeAttachmentRequest(value, importReceipt(value).acceptance), correction = value.attachment.action === 'correct';
  const revision = { id: acceptedId, attachmentId, revisionNumber: correction ? 2 : 1, previousRevisionId: correction ? originalHead : null,
    reference: input.reference, caption: input.caption, suppliedOrigin: input.suppliedOrigin, createdByUserId: 7, createdAt: '2026-10-20T12:00:02.000Z' };
  return { projectId, analysisId, canWrite: allowed, requestId: input.requestId, replayed: true,
    requestSha256: sha256(correction ? canonicalAnalysisAttachmentCorrection(attachmentId, input) : canonicalAnalysisAttachmentContent(input)),
    acceptedRevision: revision, acceptedSourceAccess: unavailable ? 'unavailable' : 'available', attachment: newer
      ? { id: attachmentId, headRevisionId: laterHead, sourceAccess: 'restricted', revision: { ...revision, id: laterHead, revisionNumber: 4,
        previousRevisionId: `rar_${'f'.repeat(24)}`, caption: 'A newer colleague result', createdByUserId: 9 } }
      : { id: attachmentId, headRevisionId: acceptedId, revision: structuredClone(revision), sourceAccess: unavailable ? 'unavailable' : 'available' } };
}
let state, events;
function full(value = state.recipe) {
  return { ...common(state.allowed), requestId: value.requestId, requestSha256: sha256(canonicalAnalysisLocalIntake(analysisId, value)),
    recipe: structuredClone(value), createdAt: '2026-10-20T12:00:00.000Z', replayed: true,
    importOutcome: { status: state.imported ? 'accepted' : 'unconfirmed', receipt: state.imported ? importReceipt(value, state.unavailable) : null },
    attachmentOutcome: { status: state.attached ? 'accepted' : 'unconfirmed', receipt: state.attached ? attachmentReceipt(value, state) : null } };
}
function summary(value = state.recipe) {
  return { requestId: value.requestId, requestSha256: sha256(canonicalAnalysisLocalIntake(analysisId, value)), createdAt: '2026-10-20T12:00:00.000Z',
    originalFilename: value.importRequest.originalFilename, name: value.importRequest.name, caption: value.attachment.caption,
    action: value.attachment.action, attachmentId: value.attachment.attachmentId, expectedHeadRevisionId: value.attachment.expectedHeadRevisionId,
    importStatus: state.imported ? 'accepted' : 'unconfirmed', attachmentStatus: state.attached ? 'accepted' : 'unconfirmed' };
}
const makeProps = changes => ({ projectId, analysisId, userId: 7, active: true, canWrite: true, available: true, seed: { key: 0 },
  onClose: vi.fn(), onDenied: vi.fn(), onAuthority: vi.fn(), onAttached: vi.fn(), onInspect: vi.fn(), onPreview: vi.fn(), ...changes });
const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const unknown = () => new Error('The connection ended before completion.');
const missing = () => Object.assign(new Error('No original intake record.'), { status: 404, code: 'ANALYSIS_LOCAL_INTAKE_NOT_FOUND' });
const saved = () => screen.getByRole('region', { name: 'Saved local import request' });
async function ready(props = makeProps()) {
  const view = render(<LocalEvidenceIntake {...props} />);
  await waitFor(() => expect(listAnalysisLocalIntakes).toHaveBeenCalled());
  await waitFor(() => expect(screen.queryByText('Finding saved import requests…')).not.toBeInTheDocument());
  return { ...view, props };
}
async function prepare(value = new File([bytes], 'scores.csv')) {
  fireEvent.change(screen.getByLabelText('Local result file', { exact: true }), { target: { files: [value] } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Saved file name' }), { target: { value: '  Outside scores  ' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Result caption' }), { target: { value: '  Outside table  ' } });
  fireEvent.click(screen.getByText('Supplied origin and references (optional)'));
  return value;
}
async function admit() {
  fireEvent.click(screen.getByRole('button', { name: 'Import local file', exact: true }));
  await waitFor(() => expect(createAnalysisLocalIntake).toHaveBeenCalledTimes(1));
  return createAnalysisLocalIntake.mock.calls[0][2];
}
async function openSaved(props = makeProps()) {
  const view = await ready(props); fireEvent.click(screen.getByRole('button', { name: 'Open saved import request' }));
  await screen.findByText('Original request checked. Checking does not upload a file or attach a result.'); return view;
}

beforeEach(() => {
  vi.resetAllMocks(); vi.stubGlobal('crypto', webcrypto); events = [];
  state = { recipe: null, imported: false, attached: false, allowed: true, unavailable: false, newer: false };
  listAnalysisLocalIntakes.mockImplementation(async () => ({ ...common(state.allowed), items: state.recipe ? [summary()] : [], nextCursor: null }));
  createAnalysisLocalIntake.mockImplementation(async (_project, _analysis, value) => { events.push('admit'); state.recipe = structuredClone(value); return full(); });
  getAnalysisLocalIntake.mockImplementation(async () => { events.push('read'); return full(); });
  importArtifactVersion.mockImplementation(async () => { events.push('upload'); state.imported = true; return { ignoredBareUploadReply: true }; });
  createAnalysisAttachment.mockImplementation(async () => { events.push('attach'); state.attached = true; return attachmentReceipt(state.recipe); });
  correctAnalysisAttachment.mockImplementation(async () => { events.push('correct'); state.attached = true; return attachmentReceipt(state.recipe); });
});
afterEach(() => vi.unstubAllGlobals());

it('saves a normalized private recipe before transfer, checks it immediately before/after upload and requires an explicit separate attachment', async () => {
  await ready(); const file = await prepare();
  fireEvent.change(screen.getByRole('textbox', { name: 'Where this result came from' }), { target: { value: '  External lab  ' } });
  const value = await admit(); await screen.findByText('Accepted · saved file recorded');
  expect(events).toEqual(['admit', 'read', 'upload', 'read']);
  expect(value).toMatchObject({ serviceId, requestId: value.importRequest.requestId, importRequest: { originalFilename: 'scores.csv', name: 'Outside scores',
    sha256: fileSha, sizeBytes: 14, artifactType: 'auto', previousVersionId: null }, attachment: { action: 'create', caption: 'Outside table',
    suppliedOrigin: { ...blankOrigin, origin: 'External lab' } } });
  expect(value.attachment.requestId).not.toBe(value.requestId);
  expect(importArtifactVersion).toHaveBeenCalledExactlyOnceWith(projectId, expect.objectContaining({ file, name: 'Outside scores', artifactType: 'auto',
    requestId: value.requestId, expectedRequestSha256: sha256(canonicalArtifactImportRequest(value.importRequest)), signal: expect.any(AbortSignal) }));
  expect(createAnalysisAttachment).not.toHaveBeenCalled(); expect(correctAnalysisAttachment).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Attach imported result' })).toBeEnabled();
});

it('does not upload after unknown admission and only resaves the identical original request after an explicit missing-record check', async () => {
  createAnalysisLocalIntake.mockRejectedValueOnce(unknown()); getAnalysisLocalIntake.mockRejectedValueOnce(missing());
  await ready(); const file = await prepare(), value = await admit(); await screen.findByRole('alert');
  expect(importArtifactVersion).not.toHaveBeenCalled(); expect(getAnalysisLocalIntake).not.toHaveBeenCalled();
  expect(within(saved()).queryByRole('button', { name: 'Retry saving original request' })).not.toBeInTheDocument();
  fireEvent.click(within(saved()).getByRole('button', { name: 'Check saved import request' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('A missing record does not prove rejection');
  expect(createAnalysisLocalIntake).toHaveBeenCalledTimes(1); expect(importArtifactVersion).not.toHaveBeenCalled();
  fireEvent.click(within(saved()).getByRole('button', { name: 'Retry saving original request' }));
  await screen.findByText('Accepted · saved file recorded');
  expect(createAnalysisLocalIntake.mock.calls[1][2]).toBe(value);
  expect(importArtifactVersion.mock.calls[0][1].file).toBe(file);
  expect(importArtifactVersion.mock.calls[0][1].requestId).toBe(value.requestId);
});

it.each(['hash', 'owner', 'service'])('does not transfer after a malformed admission response with wrong %s binding', async mismatch => {
  createAnalysisLocalIntake.mockImplementationOnce(async (_project, _analysis, value) => {
    const result = full(value);
    if (mismatch === 'hash') result.requestSha256 = '0'.repeat(64);
    if (mismatch === 'owner') result.ownerUserId = 8;
    if (mismatch === 'service') result.serviceId = `svc_${'f'.repeat(32)}`;
    return result;
  });
  await ready(); await prepare(); const value = await admit(); await screen.findByRole('alert');
  expect(importArtifactVersion).not.toHaveBeenCalled(); expect(createAnalysisAttachment).not.toHaveBeenCalled();
  expect(within(saved()).getByText(value.requestId)).toBeInTheDocument();
});

it('discovers and recovers an accepted older correction as a current archived reader without uploading or attaching again', async () => {
  state.recipe = recipe('correct'); state.imported = true; state.attached = true; state.allowed = false; state.newer = true;
  const { props } = await openSaved(makeProps({ active: false, canWrite: false }));
  expect(screen.getByText('Confirmed · saved revision 2')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Inspect original attached result' }));
  expect(props.onInspect).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: acceptedId, previousRevisionId: originalHead, reference: { kind: 'artifact-version', versionId, sha256: fileSha } }));
  expect(props.onInspect.mock.calls[0][0].id).not.toBe(laterHead);
  expect(importArtifactVersion).not.toHaveBeenCalled(); expect(correctAnalysisAttachment).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: 'Save original source correction' })).not.toBeInTheDocument();
});

it('keeps source-loss acceptance and context without exposing a reupload or new attachment action', async () => {
  state.recipe = recipe(); state.imported = true; state.attached = true; state.unavailable = true;
  await openSaved(); expect(screen.getByText('Accepted · original file unavailable')).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Upload original file' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Inspect imported file' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Attach imported result' })).not.toBeInTheDocument();
  expect(importArtifactVersion).not.toHaveBeenCalled();
});

it.each(['create', 'correct'])('explicitly saves the original %s against the imported exact reference and frozen context after a fresh GET', async action => {
  state.recipe = recipe(action); state.recipe.attachment.suppliedOrigin.origin = 'Frozen external lab'; state.imported = true;
  const { props } = await openSaved(); events = [];
  fireEvent.click(screen.getByRole('button', { name: action === 'correct' ? 'Save original source correction' : 'Attach imported result' }));
  await screen.findByText(`Confirmed · saved revision ${action === 'correct' ? 2 : 1}`);
  expect(events).toEqual(['read', action === 'correct' ? 'correct' : 'attach', 'read']);
  const input = analysisLocalIntakeAttachmentRequest(state.recipe, importReceipt(state.recipe).acceptance);
  expect(input).toMatchObject({ requestId: attachRequestId, reference: { kind: 'artifact-version', versionId, sha256: fileSha },
    caption: 'Outside table', suppliedOrigin: { ...blankOrigin, origin: 'Frozen external lab' } });
  if (action === 'correct') expect(correctAnalysisAttachment).toHaveBeenCalledExactlyOnceWith(projectId, analysisId, attachmentId,
    { ...input, expectedHeadRevisionId: originalHead }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  else expect(createAnalysisAttachment).toHaveBeenCalledExactlyOnceWith(projectId, analysisId, input, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  expect(props.onAttached).toHaveBeenCalledTimes(1); expect(props.onInspect).not.toHaveBeenCalled();
  expect(importArtifactVersion).not.toHaveBeenCalled();
});

it('requires a fresh explicit outcome check after an unknown attachment POST before permitting another attachment attempt', async () => {
  state.recipe = recipe(); state.imported = true; createAnalysisAttachment.mockRejectedValueOnce(unknown());
  await openSaved(); fireEvent.click(screen.getByRole('button', { name: 'Attach imported result' })); await screen.findByRole('alert');
  expect(createAnalysisAttachment).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', { name: 'Attach imported result' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Check saved import request' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Attach imported result' })).toBeEnabled());
  expect(createAnalysisAttachment).toHaveBeenCalledTimes(1);
});

it('requires a new full check after unknown upload and keeps the same file, UUID and import settings for explicit retry', async () => {
  importArtifactVersion.mockRejectedValueOnce(unknown()); await ready(); const file = await prepare(); const value = await admit();
  await screen.findByRole('alert'); expect(screen.getByRole('button', { name: 'Upload original file' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Check saved import request' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Upload original file' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Upload original file' })); await screen.findByText('Accepted · saved file recorded');
  expect(importArtifactVersion).toHaveBeenCalledTimes(2);
  expect(importArtifactVersion.mock.calls[1][1]).toMatchObject({ file, requestId: value.requestId, name: value.importRequest.name,
    expectedRequestSha256: sha256(canonicalArtifactImportRequest(value.importRequest)) });
});

it('rejects reselected same-name/same-size bytes with the wrong SHA before any transfer', async () => {
  state.recipe = recipe(); await openSaved();
  fireEvent.change(screen.getByLabelText('Original file', { exact: true }), { target: { files: [new File(['gene,score\nA,3'], 'scores.csv')] } });
  fireEvent.click(screen.getByRole('button', { name: 'Upload original file' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('No upload was sent');
  expect(importArtifactVersion).not.toHaveBeenCalled(); expect(createAnalysisAttachment).not.toHaveBeenCalled();
});

it('fresh reader discovery fences a held admission reply and preserves the original request without transfer', async () => {
  const completion = deferred(); createAnalysisLocalIntake.mockReturnValueOnce(completion.promise);
  const { props } = await ready(); await prepare(); const value = await admit();
  const signal = createAnalysisLocalIntake.mock.calls[0][3].signal;
  state.allowed = false; fireEvent.click(screen.getByRole('button', { name: 'Refresh import requests' }));
  await waitFor(() => expect(signal.aborted).toBe(true)); await act(async () => completion.resolve(full(value)));
  expect(importArtifactVersion).not.toHaveBeenCalled(); expect(props.onAuthority).toHaveBeenCalledWith(false, 'intake');
  expect(within(saved()).getByText(value.requestId)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Upload original file' })).not.toBeInTheDocument();
});

it('fresh scope denial fences a held upload, removes protected saved outcomes and keeps only the researcher original request', async () => {
  const completion = deferred(); importArtifactVersion.mockReturnValueOnce(completion.promise);
  const { props } = await ready(); await prepare(); const value = await admit();
  await waitFor(() => expect(importArtifactVersion).toHaveBeenCalledTimes(1)); const signal = importArtifactVersion.mock.calls[0][1].signal;
  const denial = Object.assign(new Error('No current project access.'), { status: 403, code: 'FORBIDDEN' });
  listAnalysisLocalIntakes.mockRejectedValueOnce(denial); fireEvent.click(screen.getByRole('button', { name: 'Refresh import requests' }));
  await screen.findByRole('alert'); expect(signal.aborted).toBe(true); expect(props.onDenied).toHaveBeenCalledExactlyOnceWith(denial);
  await act(async () => completion.resolve({ untrustedUploadSuccess: true }));
  expect(screen.queryByText('Accepted · saved file recorded')).not.toBeInTheDocument();
  expect(within(saved()).getByText(value.requestId)).toBeInTheDocument(); expect(createAnalysisAttachment).not.toHaveBeenCalled();
});

it.each(['inactive', 'disconnected', 'unmounted'])('cancels held transfer when the panel becomes %s and never reports late acceptance', async interruption => {
  const completion = deferred(); importArtifactVersion.mockReturnValueOnce(completion.promise);
  const props = makeProps(), view = await ready(props); await prepare(); await admit();
  await waitFor(() => expect(importArtifactVersion).toHaveBeenCalledTimes(1)); const signal = importArtifactVersion.mock.calls[0][1].signal;
  if (interruption === 'unmounted') view.unmount();
  else view.rerender(<LocalEvidenceIntake {...props} {...(interruption === 'inactive' ? { active: false } : { available: false })} />);
  expect(signal.aborted).toBe(true); state.imported = true; await act(async () => completion.resolve({ late: true }));
  expect(screen.queryByText('Accepted · saved file recorded')).not.toBeInTheDocument(); expect(props.onAttached).not.toHaveBeenCalled();
});

it('keeps create and two correction metadata drafts separate when revisiting the same intent and clears the chosen File', async () => {
  const props = makeProps(), view = await ready(props); await prepare();
  fireEvent.change(screen.getByRole('textbox', { name: 'Code or method reference' }), { target: { value: 'Unsent method notes' } });
  const first = { key: 1, attachmentId, expectedHeadRevisionId: originalHead, caption: 'First correction', suppliedOrigin: { ...blankOrigin } };
  await act(async () => view.rerender(<LocalEvidenceIntake {...props} seed={first} />));
  expect(screen.getByRole('textbox', { name: 'Result caption' })).toHaveValue('First correction');
  fireEvent.change(screen.getByRole('textbox', { name: 'Result caption' }), { target: { value: 'Retained first correction draft' } });
  expect(screen.getByRole('textbox', { name: 'Result caption' })).toHaveValue('Retained first correction draft');
  const second = { ...first, key: 2, attachmentId: `raa_${'e'.repeat(24)}`, caption: 'Second correction' };
  await act(async () => view.rerender(<LocalEvidenceIntake {...props} seed={second} />));
  expect(screen.getByRole('textbox', { name: 'Result caption' })).toHaveValue('Second correction');
  await act(async () => view.rerender(<LocalEvidenceIntake {...props} seed={{ key: 3 }} />));
  expect(screen.getByRole('textbox', { name: 'Result caption' })).toHaveValue('  Outside table  ');
  expect(screen.getByRole('textbox', { name: 'Code or method reference' })).toHaveValue('Unsent method notes');
  expect(screen.getByRole('button', { name: 'Import local file' })).toBeDisabled();
  await act(async () => view.rerender(<LocalEvidenceIntake {...props} seed={first} />));
  expect(screen.getByRole('textbox', { name: 'Result caption' })).toHaveValue('Retained first correction draft');
});

it('a fresh explicit parent intent supersedes an older child correction draft while same-intent revisits preserve later child edits', async () => {
  const props = makeProps({ seed: { key: 1, attachmentId, expectedHeadRevisionId: originalHead, caption: 'Initial parent caption', suppliedOrigin: { ...blankOrigin } } });
  const view = await ready(props);
  fireEvent.change(screen.getByRole('textbox', { name: 'Result caption' }), { target: { value: 'Older child edit' } });
  const fresh = { ...props.seed, key: 2, caption: 'Fresh deliberate parent caption', suppliedOrigin: { ...blankOrigin, origin: 'Fresh parent origin' } };
  await act(async () => view.rerender(<LocalEvidenceIntake {...props} seed={fresh} />));
  expect(screen.getByRole('textbox', { name: 'Result caption' })).toHaveValue('Fresh deliberate parent caption');
  fireEvent.click(screen.getByText('Supplied origin and references (optional)'));
  expect(screen.getByRole('textbox', { name: 'Where this result came from' })).toHaveValue('Fresh parent origin');
  fireEvent.change(screen.getByRole('textbox', { name: 'Result caption' }), { target: { value: 'Later child edit for this intent' } });
  await act(async () => view.rerender(<LocalEvidenceIntake {...props} seed={{ key: 3 }} />));
  await act(async () => view.rerender(<LocalEvidenceIntake {...props} seed={fresh} />));
  expect(screen.getByRole('textbox', { name: 'Result caption' })).toHaveValue('Later child edit for this intent');
  expect(screen.getByRole('textbox', { name: 'Where this result came from' })).toHaveValue('Fresh parent origin');
});

it('a newer seed fences a held saved-recipe read and prevents an older target from replacing the later draft', async () => {
  state.recipe = recipe(); const completion = deferred(); getAnalysisLocalIntake.mockReturnValueOnce(completion.promise);
  const props = makeProps(), view = await ready(props); fireEvent.click(screen.getByRole('button', { name: 'Open saved import request' }));
  await waitFor(() => expect(getAnalysisLocalIntake).toHaveBeenCalledTimes(1)); const signal = getAnalysisLocalIntake.mock.calls[0][3].signal;
  await act(async () => view.rerender(<LocalEvidenceIntake {...props} seed={{ key: 1, attachmentId, expectedHeadRevisionId: originalHead, caption: 'Later intended correction' }} />));
  expect(signal.aborted).toBe(true); await act(async () => completion.resolve(full()));
  expect(screen.getByRole('textbox', { name: 'Result caption' })).toHaveValue('Later intended correction');
  expect(screen.queryByRole('region', { name: 'Saved local import request' })).not.toBeInTheDocument();
});

it.each(['conflict', 'unavailable'])('never resumes a %s import as if it were a missing upload', async mode => {
  state.recipe = recipe(); state.imported = mode === 'unavailable'; state.unavailable = mode === 'unavailable';
  if (mode === 'conflict') getAnalysisLocalIntake.mockImplementationOnce(async () => ({ ...full(), importOutcome: { status: 'conflict', receipt: null } }));
  await openSaved(); expect(screen.queryByRole('button', { name: 'Upload original file' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Attach imported result' })).not.toBeInTheDocument();
  expect(importArtifactVersion).not.toHaveBeenCalled(); expect(createAnalysisAttachment).not.toHaveBeenCalled();
});

it.each(['unsupported extension', 'oversized file'])('rejects %s before saving a recipe or transferring bytes', async kind => {
  await ready(); const file = new File([bytes], kind === 'unsupported extension' ? 'object.rds' : 'scores.csv');
  if (kind === 'oversized file') Object.defineProperty(file, 'size', { value: 25 * 1024 * 1024 + 1 });
  await prepare(file); fireEvent.click(screen.getByRole('button', { name: 'Import local file' })); await screen.findByRole('alert');
  expect(createAnalysisLocalIntake).not.toHaveBeenCalled(); expect(importArtifactVersion).not.toHaveBeenCalled();
});
