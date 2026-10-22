import React from 'react';
import { webcrypto } from 'node:crypto';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import EvidenceIntake from './EvidenceIntake';
import { createAnalysisAttachment, correctAnalysisAttachment, listAnalysisIntakes, getAnalysisIntake,
  createAnalysisServerIntake, createAnalysisLocalIntake, listAnalysisLocalIntakes, getAnalysisLocalIntake } from './analysisAttachmentApi';
import { importArtifactVersion } from '../artifacts/artifactApi';
import { importServerData, listServerDataImports, listServerDataRoots, listServerDataFiles } from '../artifacts/serverDataApi';
import { analysisServerIntakeAttachmentRequest } from '../../shared/analysisServerIntake.mjs';
import { scope, requestId, attachmentId, firstRevisionId, acceptedRevisionId, laterRevisionId, versionId, fileSha, bytes,
  emptyOrigin, record, full as wireFull, summary, list, legacyFull, attachmentReceipt } from './evidenceIntakeTestFixtures';

vi.mock('./analysisAttachmentApi', () => ({ createAnalysisAttachment: vi.fn(), correctAnalysisAttachment: vi.fn(),
  listAnalysisIntakes: vi.fn(), getAnalysisIntake: vi.fn(), createAnalysisServerIntake: vi.fn(), createAnalysisLocalIntake: vi.fn(),
  listAnalysisLocalIntakes: vi.fn(), getAnalysisLocalIntake: vi.fn() }));
vi.mock('../artifacts/artifactApi', () => ({ importArtifactVersion: vi.fn() }));
vi.mock('../artifacts/serverDataApi', () => ({ importServerData: vi.fn(), listServerDataImports: vi.fn(), listServerDataRoots: vi.fn(), listServerDataFiles: vi.fn() }));

const root = { id: 'lab-data', label: 'Granted study data' };
const limits = { maxFileBytes: 512 * 1024 ** 2, managedQuotaBytes: 5 * 1024 ** 3 };
const selectedFile = { kind: 'file', name: 'scores.csv', relativePath: 'scores.csv', sizeBytes: 14,
  modifiedAt: '2026-10-22T12:00:00.000Z', selectionToken: 'd'.repeat(64) };
const propsFor = changes => ({ projectId: scope.projectId, analysisId: scope.analysisId, userId: scope.userId,
  active: true, canWrite: true, available: true, seed: { key: 0 }, onClose: vi.fn(), onDenied: vi.fn(), onAuthority: vi.fn(),
  onAttached: vi.fn(), onInspect: vi.fn(), onPreview: vi.fn(), ...changes });
const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const unknown = () => new Error('The connection ended before completion.');
const missing = () => Object.assign(new Error('No original saved request.'), { status: 404, code: 'ANALYSIS_INTAKE_NOT_FOUND' });
const saved = () => screen.getByRole('region', { name: 'Saved import request' });
let state, events;
const full = (value = state.record, changes = {}) => wireFull(value, { ...state, ...changes });
async function ready(props = propsFor()) {
  const view = render(<EvidenceIntake {...props} />);
  await waitFor(() => expect(listAnalysisIntakes).toHaveBeenCalled());
  await waitFor(() => expect(screen.queryByText('Finding saved import requests…')).not.toBeInTheDocument());
  return { ...view, props };
}
async function prepareServer() {
  fireEvent.click(screen.getByRole('button', { name: 'On server', exact: true }));
  fireEvent.click(await screen.findByRole('button', { name: 'Select server file scores.csv' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Saved file name' }), { target: { value: '  Outside scores  ' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Result caption' }), { target: { value: '  Outside treatment scores  ' } });
}
async function admitServer() {
  fireEvent.click(screen.getByRole('button', { name: 'Import server file', exact: true }));
  await waitFor(() => expect(createAnalysisServerIntake).toHaveBeenCalledTimes(1));
  return createAnalysisServerIntake.mock.calls[0][2];
}
async function openSaved(props = propsFor()) {
  const view = await ready(props);
  fireEvent.click(screen.getByRole('button', { name: 'Open saved import request' }));
  await screen.findByText(`Original request checked. Checking does not ${state.record.sourceKind === 'server' ? 'copy' : 'upload'} a file or attach a result.`);
  return view;
}
beforeEach(() => {
  vi.resetAllMocks(); vi.stubGlobal('crypto', webcrypto); events = [];
  state = { record: null, imported: false, attached: false, allowed: true, sourceAllowed: true, unavailable: false, newer: false };
  listAnalysisIntakes.mockImplementation(async () => list((state.records || (state.record ? [state.record] : [])).map(value => summary(value, state)), state.allowed));
  getAnalysisIntake.mockImplementation(async (_project, _analysis, id) => {
    events.push('read'); return full((state.records || []).find(value => value.recipe.requestId === id) || state.record);
  });
  createAnalysisServerIntake.mockImplementation(async (_project, _analysis, recipe) => {
    events.push('admit'); state.record = { sourceKind: 'server', recipe: structuredClone(recipe) }; return full();
  });
  createAnalysisLocalIntake.mockImplementation(async (_project, _analysis, recipe) => {
    events.push('admit-local'); state.record = { sourceKind: 'local', recipe: structuredClone(recipe) }; return legacyFull(full());
  });
  importServerData.mockImplementation(async () => { events.push('copy'); state.imported = true; return { untrustedBareCopyReply: true }; });
  importArtifactVersion.mockImplementation(async () => { events.push('upload'); state.imported = true; return { untrustedBareUploadReply: true }; });
  createAnalysisAttachment.mockImplementation(async () => { events.push('attach'); state.attached = true; return attachmentReceipt(state.record, state); });
  correctAnalysisAttachment.mockImplementation(async () => { events.push('correct'); state.attached = true; return attachmentReceipt(state.record, state); });
  listServerDataImports.mockImplementation(async () => ({ projectId: scope.projectId, ownerUserId: scope.userId, serviceId: scope.serviceId,
    canImport: state.sourceAllowed, items: [], nextCursor: null }));
  listServerDataRoots.mockResolvedValue({ roots: [root], limits });
  listServerDataFiles.mockResolvedValue({ root, path: '', items: [selectedFile], nextCursor: null });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); delete window.desktopShell; });

it('uses the real shared selector, saves metadata before copying, and reconciles exact acceptance before offering a separate attachment', async () => {
  const storage = vi.spyOn(Storage.prototype, 'setItem'), { props } = await ready(); await prepareServer();
  const recipe = await admitServer(); await screen.findByText('Accepted · saved file recorded');
  expect(events).toEqual(['admit', 'read', 'copy', 'read']);
  expect(recipe).toMatchObject({ serviceId: scope.serviceId, projectId: scope.projectId, ownerUserId: scope.userId,
    requestId: recipe.importRequest.requestId, selectionSizeBytes: 14,
    importRequest: { rootId: root.id, relativePath: 'scores.csv', selectionToken: selectedFile.selectionToken, name: 'Outside scores', artifactType: 'auto', previousVersionId: null },
    attachment: { action: 'create', caption: 'Outside treatment scores' } });
  expect(recipe.attachment.requestId).not.toBe(recipe.requestId); expect(recipe.importRequest).not.toHaveProperty('sha256');
  expect(importServerData).toHaveBeenCalledExactlyOnceWith(scope.projectId, recipe.importRequest, expect.any(AbortSignal),
    { userId: scope.userId, serviceId: scope.serviceId });
  expect(createAnalysisAttachment).not.toHaveBeenCalled(); expect(props.onAttached).not.toHaveBeenCalled(); expect(props.onPreview).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Attach imported result' })).toBeEnabled();
  expect(storage).not.toHaveBeenCalled(); expect(importArtifactVersion).not.toHaveBeenCalled();
});

it('never starts the source copy while metadata admission is still awaiting acknowledgement', async () => {
  const acknowledgement = deferred(); createAnalysisServerIntake.mockImplementationOnce(async (_project, _analysis, recipe) => {
    state.record = { sourceKind: 'server', recipe: structuredClone(recipe) }; return acknowledgement.promise;
  });
  await ready(); await prepareServer(); const recipe = await admitServer();
  expect(importServerData).not.toHaveBeenCalled(); expect(getAnalysisIntake).not.toHaveBeenCalled();
  expect(within(saved()).getByText(recipe.requestId)).toBeInTheDocument();
  await act(async () => acknowledgement.resolve(full())); await screen.findByText('Accepted · saved file recorded');
  expect(importServerData).toHaveBeenCalledTimes(1);
});

it('requires an explicit missing-record check before resaving the exact same server recipe and UUID after unknown admission', async () => {
  createAnalysisServerIntake.mockRejectedValueOnce(unknown()); getAnalysisIntake.mockRejectedValueOnce(missing());
  await ready(); await prepareServer(); const recipe = await admitServer(); await screen.findByRole('alert');
  expect(importServerData).not.toHaveBeenCalled(); expect(getAnalysisIntake).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: 'Retry saving original request' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Check saved import request' }));
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('A missing record does not prove rejection'));
  expect(importServerData).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Retry saving original request' })); await screen.findByText('Accepted · saved file recorded');
  expect(createAnalysisServerIntake.mock.calls[1][2]).toBe(recipe);
  expect(importServerData.mock.calls[0][1]).toEqual(recipe.importRequest);
});

it('recovers a genuinely admitted request after a lost acknowledgement without automatically starting its first copy', async () => {
  createAnalysisServerIntake.mockImplementationOnce(async (_project, _analysis, recipe) => {
    state.record = { sourceKind: 'server', recipe: structuredClone(recipe) }; throw unknown();
  });
  await ready(); await prepareServer(); const recipe = await admitServer(); await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: 'Check saved import request' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Copy original server file' })).toBeEnabled());
  expect(createAnalysisServerIntake).toHaveBeenCalledOnce(); expect(importServerData).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Copy original server file' })); await screen.findByText('Accepted · saved file recorded');
  expect(importServerData.mock.calls[0][1]).toEqual(recipe.importRequest); expect(createAnalysisServerIntake).toHaveBeenCalledOnce();
});

it.each(['transport failure', 'unreadable success', 'wrong identity'])('cannot enable saving again after a check with %s', async failure => {
  createAnalysisServerIntake.mockRejectedValueOnce(unknown());
  if (failure === 'transport failure') getAnalysisIntake.mockRejectedValueOnce(unknown());
  else getAnalysisIntake.mockImplementationOnce(async () => failure === 'unreadable success' ? {} : wireFull(record('server', { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' })));
  await ready(); await prepareServer(); const recipe = await admitServer(); await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: 'Check saved import request' }));
  await waitFor(() => expect(getAnalysisIntake).toHaveBeenCalledOnce());
  await waitFor(() => expect(screen.getByRole('button', { name: 'Check saved import request' })).toBeEnabled());
  expect(screen.queryByRole('button', { name: 'Retry saving original request' })).not.toBeInTheDocument();
  expect(within(saved()).getByText(recipe.requestId)).toBeInTheDocument(); expect(importServerData).not.toHaveBeenCalled();
});

it('freezes a lost copy reply and permits only an explicitly checked retry of the original source body', async () => {
  importServerData.mockRejectedValueOnce(unknown()); await ready(); await prepareServer(); const recipe = await admitServer(); await screen.findByRole('alert');
  expect(screen.getByRole('button', { name: 'Copy original server file' })).toBeDisabled();
  expect(screen.queryByRole('textbox', { name: 'Saved file name' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'On this computer' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Check saved import request' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Copy original server file' })).toBeEnabled());
  expect(importServerData).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button', { name: 'Copy original server file' })); await screen.findByText('Accepted · saved file recorded');
  expect(importServerData).toHaveBeenCalledTimes(2);
  expect(importServerData.mock.calls[1][1]).toEqual(recipe.importRequest);
  expect(importServerData.mock.calls[1][1].requestId).toBe(importServerData.mock.calls[0][1].requestId);
  expect(createAnalysisServerIntake).toHaveBeenCalledOnce(); expect(createAnalysisAttachment).not.toHaveBeenCalled();
});

it('recovers an accepted copy after a lost reply without ever copying or attaching it a second time', async () => {
  importServerData.mockImplementationOnce(async () => { state.imported = true; throw unknown(); });
  await ready(); await prepareServer(); await admitServer(); await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: 'Check saved import request' })); await screen.findByText('Accepted · saved file recorded');
  expect(importServerData).toHaveBeenCalledOnce(); expect(screen.queryByRole('button', { name: 'Copy original server file' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Attach imported result' })).toBeEnabled(); expect(createAnalysisAttachment).not.toHaveBeenCalled();
});

it.each(['create', 'correct'])('attaches an accepted owned server snapshot after its source grant is revoked using the original %s identity', async action => {
  state.record = record('server', { action, suppliedOrigin: { ...emptyOrigin(), origin: 'Frozen external method' } });
  state.imported = true; state.sourceAllowed = false;
  const { props } = await openSaved(); const expected = analysisServerIntakeAttachmentRequest(state.record.recipe, full().importOutcome.receipt.acceptance); events = [];
  const button = screen.getByRole('button', { name: action === 'correct' ? 'Save original source correction' : 'Attach imported result' });
  expect(button).toBeEnabled(); fireEvent.click(button); await screen.findByText(`Confirmed · saved revision ${action === 'correct' ? 2 : 1}`);
  expect(events).toEqual(['read', action === 'correct' ? 'correct' : 'attach', 'read']);
  if (action === 'correct') expect(correctAnalysisAttachment).toHaveBeenCalledExactlyOnceWith(scope.projectId, scope.analysisId, attachmentId, expected, { signal: expect.any(AbortSignal) });
  else expect(createAnalysisAttachment).toHaveBeenCalledExactlyOnceWith(scope.projectId, scope.analysisId, expected, { signal: expect.any(AbortSignal) });
  expect(props.onAuthority).not.toHaveBeenCalledWith(false, 'intake'); expect(props.onDenied).not.toHaveBeenCalled();
  expect(props.onAttached).toHaveBeenCalledOnce(); expect(props.onInspect).not.toHaveBeenCalled();
  expect(importServerData).not.toHaveBeenCalled(); expect(listServerDataRoots).not.toHaveBeenCalled();
});

it('a fresh source-only capability downgrade fences an older held copy without revoking general analysis write access', async () => {
  const completion = deferred(); importServerData.mockReturnValueOnce(completion.promise);
  const { props } = await ready(); await prepareServer(); const recipe = await admitServer();
  await waitFor(() => expect(importServerData).toHaveBeenCalledOnce()); const signal = importServerData.mock.calls[0][2];
  state.sourceAllowed = false; fireEvent.click(screen.getByRole('button', { name: 'Refresh import requests' }));
  await waitFor(() => expect(signal.aborted).toBe(true)); state.imported = true;
  await act(async () => completion.resolve({ staleSuccess: true }));
  expect(props.onAuthority).not.toHaveBeenCalledWith(false, 'intake'); expect(props.onDenied).not.toHaveBeenCalled();
  expect(screen.queryByText('Accepted · saved file recorded')).not.toBeInTheDocument(); expect(within(saved()).getByText(recipe.requestId)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Check saved import request' })); await screen.findByText('Accepted · saved file recorded');
  expect(screen.getByRole('button', { name: 'Attach imported result' })).toBeEnabled(); expect(importServerData).toHaveBeenCalledOnce();
});

it('immediately disables the original copy action when refreshed history revokes source capability at rest', async () => {
  state.record = record(); const { props } = await openSaved();
  expect(screen.getByRole('button', { name: 'Copy original server file' })).toBeEnabled();
  state.sourceAllowed = false; fireEvent.click(screen.getByRole('button', { name: 'Refresh import requests' }));
  await waitFor(() => expect(listAnalysisIntakes).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.queryByText('Finding saved import requests…')).not.toBeInTheDocument());
  expect(screen.getByRole('button', { name: 'Copy original server file' })).toBeDisabled();
  expect(screen.getByText(/Starting a server copy is currently unavailable/)).toBeVisible();
  expect(props.onAuthority).not.toHaveBeenCalledWith(false, 'intake'); expect(props.onDenied).not.toHaveBeenCalled();
  expect(importServerData).not.toHaveBeenCalled();
});

it.each([false, true])('an older positive full GET cannot restore server-copy permission after newer source denial (already copied: %s)', async imported => {
  state.record = record(); state.imported = imported; const { props } = await openSaved();
  const completion = deferred(), olderPositive = full(); getAnalysisIntake.mockReturnValueOnce(completion.promise);
  fireEvent.click(screen.getByRole('button', { name: 'Check saved import request' }));
  await waitFor(() => expect(getAnalysisIntake).toHaveBeenCalledTimes(2)); const signal = getAnalysisIntake.mock.calls[1][3].signal;
  state.sourceAllowed = false; fireEvent.click(screen.getByRole('button', { name: 'Refresh import requests' }));
  await waitFor(() => expect(listAnalysisIntakes).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.queryByText('Finding saved import requests…')).not.toBeInTheDocument());
  expect(signal.aborted).toBe(false);
  await act(async () => completion.resolve(olderPositive));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Check saved import request' })).toBeEnabled());
  expect(screen.getByText(/Starting a server copy is currently unavailable/)).toBeVisible();
  if (!imported) expect(screen.getByRole('button', { name: 'Copy original server file' })).toBeDisabled();
  else expect(screen.getByRole('button', { name: 'Attach imported result' })).toBeEnabled();
  expect(props.onAuthority).not.toHaveBeenCalledWith(false, 'intake'); expect(props.onDenied).not.toHaveBeenCalled();
  expect(importServerData).not.toHaveBeenCalled(); expect(createAnalysisAttachment).not.toHaveBeenCalled();
  if (!imported) {
    state.imported = true; fireEvent.click(screen.getByRole('button', { name: 'Check saved import request' }));
    await screen.findByText('Accepted · saved file recorded');
  }
  fireEvent.click(screen.getByRole('button', { name: 'Attach imported result' })); await screen.findByText('Confirmed · saved revision 1');
  expect(props.onAttached).toHaveBeenCalledOnce(); expect(importServerData).not.toHaveBeenCalled();
});

it('does not copy if acknowledged metadata returns source capability false while retaining general analysis authority', async () => {
  createAnalysisServerIntake.mockImplementationOnce(async (_project, _analysis, recipe) => {
    state.record = { sourceKind: 'server', recipe: structuredClone(recipe) }; state.sourceAllowed = false; return full();
  });
  const { props } = await ready(); await prepareServer(); await admitServer();
  await screen.findByText('The original request is saved. Review its current outcomes before continuing.');
  expect(importServerData).not.toHaveBeenCalled(); expect(getAnalysisIntake).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Copy original server file' })).toBeDisabled();
  expect(props.onAuthority).not.toHaveBeenCalledWith(false, 'intake'); expect(props.onDenied).not.toHaveBeenCalled();
});

it('checks current attachment authority immediately before POST and stops when that exact GET returns a current reader', async () => {
  state.record = record(); state.imported = true; const { props } = await openSaved();
  getAnalysisIntake.mockImplementationOnce(async () => full(state.record, { allowed: false }));
  fireEvent.click(screen.getByRole('button', { name: 'Attach imported result' }));
  await waitFor(() => expect(props.onAuthority).toHaveBeenCalledWith(false, 'intake'));
  expect(createAnalysisAttachment).not.toHaveBeenCalled(); expect(correctAnalysisAttachment).not.toHaveBeenCalled();
  expect(importServerData).not.toHaveBeenCalled(); expect(screen.getByRole('button', { name: 'Attach imported result' })).toBeDisabled();
});

it('a source-only downgrade does not cancel an already submitted attachment of an accepted snapshot', async () => {
  state.record = record(); state.imported = true; const completion = deferred(); createAnalysisAttachment.mockReturnValueOnce(completion.promise);
  const { props } = await openSaved(); fireEvent.click(screen.getByRole('button', { name: 'Attach imported result' }));
  await waitFor(() => expect(createAnalysisAttachment).toHaveBeenCalledOnce()); const signal = createAnalysisAttachment.mock.calls[0][3].signal;
  state.sourceAllowed = false; fireEvent.click(screen.getByRole('button', { name: 'Refresh import requests' }));
  await waitFor(() => expect(listAnalysisIntakes).toHaveBeenCalledTimes(2)); expect(signal.aborted).toBe(false);
  state.attached = true; await act(async () => completion.resolve(attachmentReceipt(state.record, state)));
  await screen.findByText('Confirmed · saved revision 1'); expect(props.onAttached).toHaveBeenCalledOnce();
  expect(props.onAuthority).not.toHaveBeenCalledWith(false, 'intake'); expect(importServerData).not.toHaveBeenCalled();
});

it('fresh reader discovery cancels a held attachment and refuses its late success without destroying recorded copy identity', async () => {
  state.record = record(); state.imported = true; const completion = deferred(); createAnalysisAttachment.mockReturnValueOnce(completion.promise);
  const { props } = await openSaved(); fireEvent.click(screen.getByRole('button', { name: 'Attach imported result' }));
  await waitFor(() => expect(createAnalysisAttachment).toHaveBeenCalledOnce()); const signal = createAnalysisAttachment.mock.calls[0][3].signal;
  state.allowed = false; fireEvent.click(screen.getByRole('button', { name: 'Refresh import requests' })); await waitFor(() => expect(signal.aborted).toBe(true));
  state.attached = true; await act(async () => completion.resolve(attachmentReceipt(state.record, state)));
  expect(props.onAuthority).toHaveBeenCalledWith(false, 'intake'); expect(props.onAttached).not.toHaveBeenCalled();
  expect(screen.getByText('Accepted · saved file recorded')).toBeVisible(); expect(screen.getByRole('button', { name: 'Attach imported result' })).toBeDisabled();
  expect(screen.queryByText('Confirmed · saved revision 1')).not.toBeInTheDocument();
});

it.each(['denied membership', 'disconnected', 'inactive analysis', 'unmounted'])('fences held attachment completion when %s and never reports late acceptance', async interruption => {
  state.record = record(); state.imported = true; const completion = deferred(); createAnalysisAttachment.mockReturnValueOnce(completion.promise);
  const view = await openSaved(); fireEvent.click(screen.getByRole('button', { name: 'Attach imported result' }));
  await waitFor(() => expect(createAnalysisAttachment).toHaveBeenCalledOnce()); const signal = createAnalysisAttachment.mock.calls[0][3].signal;
  if (interruption === 'denied membership') {
    const denial = Object.assign(new Error('Project no longer available.'), { status: 404, code: 'NOT_FOUND' });
    listAnalysisIntakes.mockRejectedValueOnce(denial); fireEvent.click(screen.getByRole('button', { name: 'Refresh import requests' }));
    await waitFor(() => expect(view.props.onDenied).toHaveBeenCalledExactlyOnceWith(denial));
  } else if (interruption === 'unmounted') view.unmount();
  else view.rerender(<EvidenceIntake {...view.props} {...(interruption === 'disconnected' ? { available: false } : { active: false })} />);
  expect(signal.aborted).toBe(true); state.attached = true; await act(async () => completion.resolve(attachmentReceipt(state.record, state)));
  expect(view.props.onAttached).not.toHaveBeenCalled(); expect(view.props.onInspect).not.toHaveBeenCalled();
  expect(screen.queryByText('Confirmed · saved revision 1')).not.toBeInTheDocument();
  if (['denied membership', 'disconnected'].includes(interruption)) {
    expect(screen.queryByRole('region', { name: 'Saved import request' })).not.toBeInTheDocument();
    expect(screen.queryByText('Outside scores')).not.toBeInTheDocument(); expect(screen.queryByText(requestId)).not.toBeInTheDocument();
  }
});

it.each(['SERVER_IMPORT_SOURCE_CHANGED', 'SERVER_INTAKE_SOURCE_UNAVAILABLE'])('keeps %s failures local to server copying and recovers accepted snapshots afterwards', async code => {
  importServerData.mockRejectedValueOnce(Object.assign(new Error('The original source is unavailable.'), { status: 403, code }));
  const { props } = await ready(); await prepareServer(); await admitServer(); await screen.findByRole('alert');
  expect(props.onDenied).not.toHaveBeenCalled(); expect(props.onAuthority).not.toHaveBeenCalledWith(false, 'intake');
  expect(within(saved()).getByText('Outside scores')).toBeInTheDocument(); expect(createAnalysisAttachment).not.toHaveBeenCalled();
  state.imported = true; state.sourceAllowed = false; fireEvent.click(screen.getByRole('button', { name: 'Check saved import request' }));
  await screen.findByText('Accepted · saved file recorded'); expect(screen.getByRole('button', { name: 'Attach imported result' })).toBeEnabled();
});

it('permits a deliberate new local import after a source-specific server failure without requiring general authority to be restored', async () => {
  importServerData.mockRejectedValueOnce(Object.assign(new Error('The original server file changed.'), { status: 403, code: 'SERVER_IMPORT_SOURCE_CHANGED' }));
  const { props } = await ready(); await prepareServer(); await admitServer(); await screen.findByRole('alert');
  state.sourceAllowed = false; fireEvent.click(screen.getByRole('button', { name: 'Check saved import request' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Prepare another import' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Prepare another import' }));
  fireEvent.click(screen.getByRole('button', { name: 'On this computer', exact: true }));
  const file = new File([bytes], 'scores.csv');
  expect(screen.getByLabelText('Local result file', { exact: true })).toBeEnabled();
  fireEvent.change(screen.getByLabelText('Local result file', { exact: true }), { target: { files: [file] } });
  fireEvent.click(screen.getByRole('button', { name: 'Import local file', exact: true })); await screen.findByText('Accepted · saved file recorded');
  expect(createAnalysisLocalIntake).toHaveBeenCalledOnce(); expect(importArtifactVersion).toHaveBeenCalledOnce(); expect(importServerData).toHaveBeenCalledOnce();
  expect(props.onDenied).not.toHaveBeenCalled(); expect(props.onAuthority).not.toHaveBeenCalledWith(false, 'intake');
});

it('requires a fresh explicit full check after an unknown attachment reply before exposing an identical manual retry', async () => {
  state.record = record(); state.imported = true; createAnalysisAttachment.mockRejectedValueOnce(unknown());
  await openSaved(); fireEvent.click(screen.getByRole('button', { name: 'Attach imported result' })); await screen.findByRole('alert');
  const originalInput = createAnalysisAttachment.mock.calls[0][2]; expect(screen.getByRole('button', { name: 'Attach imported result' })).toBeDisabled();
  getAnalysisIntake.mockRejectedValueOnce(unknown()); fireEvent.click(screen.getByRole('button', { name: 'Check saved import request' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Check saved import request' })).toBeEnabled());
  expect(screen.getByRole('button', { name: 'Attach imported result' })).toBeDisabled(); expect(createAnalysisAttachment).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button', { name: 'Check saved import request' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Attach imported result' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Attach imported result' })); await screen.findByText('Confirmed · saved revision 1');
  expect(createAnalysisAttachment.mock.calls[1][2]).toEqual(originalInput); expect(importServerData).not.toHaveBeenCalled();
});

it('rediscovers one mixed local/server collection on remount as a reader and inspects only the explicitly chosen original revision', async () => {
  const server = record('server', { action: 'correct' });
  const local = record('local', { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', name: 'Local notebook figure' });
  state.record = server; state.records = [server, local]; state.imported = true; state.attached = true; state.allowed = false; state.newer = true;
  const initial = await ready(propsFor({ active: false, canWrite: false }));
  expect(screen.getAllByRole('button', { name: 'Open saved import request' })).toHaveLength(2);
  initial.unmount(); const { props } = await ready(propsFor({ active: false, canWrite: false }));
  const row = screen.getByText('Outside scores').closest('li'); fireEvent.click(within(row).getByRole('button', { name: 'Open saved import request' }));
  await screen.findByText('Confirmed · saved revision 2');
  expect(screen.getByText('A newer attachment revision is current. This request confirms the original saved revision.')).toBeVisible();
  expect(props.onInspect).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole('button', { name: 'Inspect original attached result' }));
  expect(props.onInspect).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: acceptedRevisionId, previousRevisionId: firstRevisionId,
    reference: { kind: 'artifact-version', versionId, sha256: fileSha } }));
  expect(props.onInspect.mock.calls[0][0].id).not.toBe(laterRevisionId);
  expect(listAnalysisLocalIntakes).not.toHaveBeenCalled(); expect(getAnalysisLocalIntake).not.toHaveBeenCalled();
  expect(importServerData).not.toHaveBeenCalled(); expect(importArtifactVersion).not.toHaveBeenCalled(); expect(createAnalysisAttachment).not.toHaveBeenCalled();
});

it('opens both local and server requests from the same reader history without falling back to source-specific detail routes or automatic previews', async () => {
  const server = record(), local = record('local', { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', name: 'Local notebook scores' });
  state.record = server; state.records = [server, local]; state.imported = true; state.attached = true; state.allowed = false;
  const { props } = await ready(propsFor({ canWrite: false }));
  fireEvent.click(within(screen.getByText('Local notebook scores').closest('li')).getByRole('button', { name: 'Open saved import request' }));
  await screen.findByText('Original request checked. Checking does not upload a file or attach a result.');
  expect(within(saved()).getByText('Local notebook scores')).toBeVisible(); expect(props.onPreview).not.toHaveBeenCalled();
  fireEvent.click(within(screen.getByText('Outside scores').closest('li')).getByRole('button', { name: 'Open saved import request' }));
  await screen.findByText('Original request checked. Checking does not copy a file or attach a result.');
  expect(within(saved()).getByText('Outside scores')).toBeVisible();
  expect(getAnalysisIntake.mock.calls.map(call => call[2])).toEqual([local.recipe.requestId, server.recipe.requestId]);
  expect(getAnalysisLocalIntake).not.toHaveBeenCalled(); expect(props.onPreview).not.toHaveBeenCalled(); expect(props.onInspect).not.toHaveBeenCalled();
  expect(createAnalysisLocalIntake).not.toHaveBeenCalled(); expect(createAnalysisServerIntake).not.toHaveBeenCalled();
});

it.each(['pending', 'failed', 'legacy-unrecorded'])('presents the real %s server outcome without offering another copy or an unproven attachment', async importStatus => {
  state.record = record(); state.importStatus = importStatus; await openSaved();
  expect(screen.queryByRole('button', { name: 'Copy original server file' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Attach imported result' })).not.toBeInTheDocument();
  expect(importServerData).not.toHaveBeenCalled(); expect(createAnalysisAttachment).not.toHaveBeenCalled();
  if (importStatus === 'failed') expect(screen.getByText('The source changed while copying.')).toBeVisible();
  if (importStatus === 'legacy-unrecorded') expect(screen.getByText(/No exact version or checksum is inferred/)).toBeVisible();
});

it('retains source-loss acceptance with no preview, recopy or attachment while keeping explicit original revision inspection available', async () => {
  state.record = record(); state.imported = true; state.attached = true; state.unavailable = true;
  const { props } = await openSaved(); expect(screen.getByText('Accepted · original file unavailable')).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Inspect imported file' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Copy original server file' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Attach imported result' })).not.toBeInTheDocument();
  expect(within(saved()).getByText(fileSha)).toBeInTheDocument(); fireEvent.click(screen.getByRole('button', { name: 'Inspect original attached result' }));
  expect(props.onInspect).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: acceptedRevisionId })); expect(importServerData).not.toHaveBeenCalled();
});

it('prepares an unrelated new create after accepting a correction without carrying its old attachment or expected predecessor', async () => {
  state.record = record('server', { action: 'correct' }); state.imported = true; state.attached = true;
  const original = structuredClone(state.record.recipe); await openSaved();
  fireEvent.click(screen.getByRole('button', { name: 'Prepare another import' }));
  expect(screen.queryByText('This file will correct the chosen attachment. Earlier sources and discussion stay with their saved revisions.')).not.toBeInTheDocument();
  expect(createAnalysisServerIntake).not.toHaveBeenCalled(); expect(importServerData).not.toHaveBeenCalled();
  state.imported = false; state.attached = false; await prepareServer(); const next = await admitServer();
  await screen.findByText('Accepted · saved file recorded');
  expect(next.requestId).not.toBe(original.requestId); expect(next.attachment.requestId).not.toBe(original.attachment.requestId);
  expect(next.attachment).toMatchObject({ action: 'create', attachmentId: null, expectedHeadRevisionId: null });
  expect(correctAnalysisAttachment).not.toHaveBeenCalled(); expect(createAnalysisAttachment).not.toHaveBeenCalled();
});

it('keeps metadata drafts per create/correction seed while dropping every chosen source across seed switches', async () => {
  const view = await ready(); await prepareServer();
  fireEvent.change(screen.getByRole('textbox', { name: 'Result caption' }), { target: { value: 'Unsent create caption' } });
  const first = { key: 1, attachmentId, expectedHeadRevisionId: firstRevisionId, caption: 'First parent correction', suppliedOrigin: emptyOrigin() };
  view.rerender(<EvidenceIntake {...view.props} seed={first} />);
  expect(screen.getByRole('textbox', { name: 'Result caption' })).toHaveValue('First parent correction');
  fireEvent.change(screen.getByRole('textbox', { name: 'Saved file name' }), { target: { value: 'First correction filename' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Result caption' }), { target: { value: 'First edited caption' } });
  const second = { ...first, key: 2, attachmentId: 'raa_' + 'e'.repeat(24), caption: 'Second parent correction' };
  view.rerender(<EvidenceIntake {...view.props} seed={second} />);
  expect(screen.getByRole('textbox', { name: 'Result caption' })).toHaveValue('Second parent correction');
  fireEvent.change(screen.getByRole('textbox', { name: 'Saved file name' }), { target: { value: 'Second correction filename' } });
  view.rerender(<EvidenceIntake {...view.props} seed={view.props.seed} />);
  expect(screen.getByRole('textbox', { name: 'Saved file name' })).toHaveValue('  Outside scores  ');
  expect(screen.getByRole('textbox', { name: 'Result caption' })).toHaveValue('Unsent create caption');
  expect(screen.getByRole('button', { name: 'On server', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await screen.findByRole('button', { name: 'Select server file scores.csv' });
  expect(screen.getByRole('button', { name: 'Import server file', exact: true })).toBeDisabled();
  view.rerender(<EvidenceIntake {...view.props} seed={first} />);
  expect(screen.getByRole('textbox', { name: 'Saved file name' })).toHaveValue('First correction filename');
  expect(screen.getByRole('textbox', { name: 'Result caption' })).toHaveValue('First edited caption');
  view.rerender(<EvidenceIntake {...view.props} seed={{ ...first, key: 3, caption: 'Fresh explicit parent caption' }} />);
  expect(screen.getByRole('textbox', { name: 'Result caption' })).toHaveValue('Fresh explicit parent caption');
  expect(createAnalysisServerIntake).not.toHaveBeenCalled(); expect(importServerData).not.toHaveBeenCalled();
});

it('admits local files through the unchanged local alias while reading outcomes and mixed history through the common controller', async () => {
  await ready(); const file = new File([bytes], 'scores.csv');
  fireEvent.change(screen.getByLabelText('Local result file', { exact: true }), { target: { files: [file] } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Saved file name' }), { target: { value: 'Outside scores' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Result caption' }), { target: { value: 'Outside treatment scores' } });
  fireEvent.click(screen.getByRole('button', { name: 'Import local file', exact: true })); await screen.findByText('Accepted · saved file recorded');
  expect(events).toEqual(['admit-local', 'read', 'upload', 'read']); expect(createAnalysisServerIntake).not.toHaveBeenCalled();
  expect(importArtifactVersion.mock.calls[0][1]).toMatchObject({ file, requestId: state.record.recipe.requestId });
  expect(getAnalysisIntake).toHaveBeenCalledTimes(2); expect(getAnalysisLocalIntake).not.toHaveBeenCalled(); expect(importServerData).not.toHaveBeenCalled();
});
