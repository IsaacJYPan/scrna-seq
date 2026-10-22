import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import ServerDataImporter from './ServerDataImporter';
import { getServerDataImport, importServerData, listServerDataFiles, listServerDataImports, listServerDataRoots } from '../artifacts/serverDataApi';

vi.mock('../artifacts/serverDataApi', () => ({ getServerDataImport: vi.fn(), importServerData: vi.fn(), listServerDataFiles: vi.fn(), listServerDataImports: vi.fn(), listServerDataRoots: vi.fn() }));
const roots = { roots: [{ id: 'lab-data', label: 'Lab data' }], limits: { maxFileBytes: 512 * 1024 ** 2, managedQuotaBytes: 5 * 1024 ** 3 } };
const file = { name: 'cells.rds', relativePath: 'study/cells.rds', kind: 'file', sizeBytes: 3400, selectionToken: 'a'.repeat(64), modifiedAt: '2026-10-08T01:00:00Z' };
const serviceId = `svc_${'1'.repeat(32)}`, requestId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const version = { name: 'cells.rds', versionId: `av_${'2'.repeat(24)}`, sizeBytes: 3400, sha256: 'b'.repeat(64) };
const complete = { requestId, id: `sdi_${'3'.repeat(24)}`, status: 'succeeded', name: 'cells.rds', version, serviceId, canImport: true,
  source: { rootId: 'lab-data', relativePath: file.relativePath, name: file.name, serviceId, serviceLabel: 'Research server' },
  acceptanceState: 'recorded', availability: 'recorded', acceptance: { artifactId: `af_${'4'.repeat(24)}`, versionId: version.versionId,
    versionNumber: 1, previousVersionId: null, sha256: version.sha256, sizeBytes: 3400, createdAt: '2026-10-20T12:00:01.000Z' },
  createdAt: '2026-10-20T12:00:00.000Z', updatedAt: '2026-10-20T12:00:01.000Z', expiresAt: '2026-10-20T12:15:00.000Z',
  reservedBytes: 3400, bytesCopied: 3400, error: null, message: null, replayed: true };
const props = { projectId: `proj_${'5'.repeat(24)}`, userId: 1, canWrite: true };
const discovery = (items = [], canImport = true, nextCursor = null) => ({ projectId: props.projectId, ownerUserId: 1, serviceId, canImport, items, nextCursor });
const pendingReceipt = input => ({ ...complete, requestId: input.requestId, status: 'pending', version: null, acceptance: null,
  acceptanceState: 'not-accepted', availability: 'not-recorded', bytesCopied: 1000, message: 'Copying the original source.' });
const savedItem = (value = complete) => ({ ...Object.fromEntries(['id', 'requestId', 'name', 'status', 'source', 'reservedBytes', 'bytesCopied',
  'createdAt', 'updatedAt', 'expiresAt', 'acceptanceState', 'acceptance', 'error'].map(key => [key, value[key]])),
  availability: value.status === 'succeeded' ? 'not-checked' : 'not-recorded' });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
beforeEach(() => {
  vi.resetAllMocks();
  listServerDataImports.mockResolvedValue(discovery());
  listServerDataRoots.mockResolvedValue(roots);
  listServerDataFiles.mockResolvedValue({ path: '', items: [{ kind: 'directory', name: 'study', relativePath: 'study' }, file], nextCursor: null });
  importServerData.mockImplementation(async (_project, input) => ({ ...complete, requestId: input.requestId, name: input.name, version: { ...version, name: input.name } }));
  getServerDataImport.mockImplementation(async (_project, requested) => ({ ...complete, requestId: requested }));
});
afterEach(() => { delete window.desktopShell; vi.useRealTimers(); });
async function browseAndSelect() {
  fireEvent.click(screen.getByRole('button', { name: 'Browse server data' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Select server file cells.rds' }));
}
const savedRow = (name = 'cells.rds') => within(screen.getByRole('list', { name: 'Saved server import requests' }))
  .findByRole('button', { name: new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) });

it('browses authorized folders, edits the name and sends only immutable source selection metadata', async () => {
  const onImported = vi.fn(); render(<ServerDataImporter {...props} onImported={onImported} />);
  expect(listServerDataRoots).not.toHaveBeenCalled();
  await browseAndSelect();
  expect(screen.getByText(/3,400 bytes/)).toBeVisible();
  expect(screen.getByText(/512.0 MiB per file/)).toBeVisible();
  fireEvent.change(screen.getByLabelText('Server artifact name'), { target: { value: 'Saved cells' } });
  fireEvent.click(screen.getByRole('button', { name: 'Import selected server file' }));
  expect(await screen.findByText('Server file saved as an immutable artifact version.')).toBeVisible();
  expect(importServerData).toHaveBeenCalledWith(props.projectId, { requestId: expect.any(String), rootId: 'lab-data', relativePath: 'study/cells.rds', selectionToken: file.selectionToken, name: 'Saved cells', artifactType: 'auto', previousVersionId: null }, expect.any(AbortSignal), { userId: 1, serviceId });
  expect(onImported).toHaveBeenCalledExactlyOnceWith({ ...version, name: 'Saved cells' });
  expect(screen.getByText('SHA-256 ' + version.sha256)).toBeVisible();
});

it('pages directories, clears file selections on navigation and sends sample-sheet purpose explicitly', async () => {
  render(<ServerDataImporter {...props} />); await browseAndSelect();
  listServerDataFiles.mockResolvedValueOnce({ path: 'study', items: [file], nextCursor: 'next' });
  fireEvent.click(screen.getByRole('button', { name: 'Open folder study' }));
  expect(await screen.findByRole('button', { name: 'More server files' })).toBeVisible();
  expect(screen.queryByLabelText('Server artifact name')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'More server files' }));
  await waitFor(() => expect(listServerDataFiles).toHaveBeenLastCalledWith(props.projectId, 'lab-data', expect.objectContaining({ path: 'study', cursor: 'next' })));
  fireEvent.click(screen.getByRole('button', { name: 'Select server file cells.rds' }));
  fireEvent.change(screen.getByLabelText('Server artifact purpose'), { target: { value: 'sample-sheet' } });
  fireEvent.click(screen.getByRole('button', { name: 'Import selected server file' }));
  await waitFor(() => expect(importServerData).toHaveBeenCalledWith(props.projectId, expect.objectContaining({ artifactType: 'sample-sheet' }), expect.any(AbortSignal), { userId: 1, serviceId }));
});

it('retains optional sample annotations without adding empty fields or changing source bytes', async () => {
  render(<ServerDataImporter {...props} />); await browseAndSelect();
  fireEvent.click(screen.getByText('Sample details (optional)'));
  fireEvent.change(screen.getByLabelText('Server sample sample id'), { target: { value: ' sample-A ' } });
  fireEvent.change(screen.getByLabelText('Server sample condition'), { target: { value: 'treatment' } });
  fireEvent.change(screen.getByLabelText('Server sample tissue'), { target: { value: '   ' } });
  fireEvent.click(screen.getByRole('button', { name: 'Import selected server file' }));
  await waitFor(() => expect(importServerData).toHaveBeenCalledWith(props.projectId, expect.objectContaining({ sampleMetadata: { sampleId: 'sample-A', condition: 'treatment' }, selectionToken: file.selectionToken }), expect.any(AbortSignal), { userId: 1, serviceId }));
});

it('retains the request when POST completion is unknown and checks it without submitting another import', async () => {
  importServerData.mockRejectedValueOnce(Object.assign(new Error('Transport lost.'), { code: 'SERVER_DATA_IMPORT_UNCONFIRMED' }));
  const onImported = vi.fn(); render(<ServerDataImporter {...props} onImported={onImported} />); await browseAndSelect();
  fireEvent.click(screen.getByRole('button', { name: 'Import selected server file' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('No import will be submitted again automatically.');
  expect(screen.getByRole('button', { name: 'Import selected server file' })).toBeDisabled();
  const submittedId = importServerData.mock.calls[0][1].requestId;
  getServerDataImport.mockResolvedValue({ ...complete, requestId: submittedId });
  fireEvent.click(screen.getByRole('button', { name: 'Check server import status' }));
  expect(await screen.findByText('Server file saved as an immutable artifact version.')).toBeVisible();
  expect(getServerDataImport).toHaveBeenCalledWith(props.projectId, submittedId, expect.any(AbortSignal), { userId: 1, serviceId });
  expect(importServerData).toHaveBeenCalledOnce(); expect(onImported).toHaveBeenCalledExactlyOnceWith(version);
});

it('does not automatically resubmit an unknown request that the selected server cannot find', async () => {
  importServerData.mockRejectedValueOnce(Object.assign(new Error('Transport lost.'), { code: 'TARGET_EXECUTION_UNCONFIRMED' }));
  getServerDataImport.mockRejectedValueOnce(Object.assign(new Error('Not found.'), { status: 404, code: 'SERVER_DATA_IMPORT_NOT_FOUND' }));
  render(<ServerDataImporter {...props} />); await browseAndSelect();
  fireEvent.click(screen.getByRole('button', { name: 'Import selected server file' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Check server import status' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('no import has been submitted again');
  expect(screen.getByRole('button', { name: 'Import selected server file' })).toBeDisabled();
  expect(importServerData).toHaveBeenCalledOnce();
});

it('continues with GET status only for a pending snapshot and reports terminal failures', async () => {
  render(<ServerDataImporter {...props} />); await browseAndSelect();
  importServerData.mockImplementationOnce(async (_project, input) => pendingReceipt(input));
  getServerDataImport.mockImplementationOnce(async (_project, requested) => ({ ...pendingReceipt({ requestId: requested }), status: 'failed', message: null,
    error: { code: 'SERVER_IMPORT_SOURCE_CHANGED', message: 'The source file changed during copying.' } }));
  fireEvent.click(screen.getByRole('button', { name: 'Import selected server file' }));
  expect(await screen.findByText(/Copying and verifying an immutable snapshot/)).toBeVisible();
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('The source file changed during copying.'), { timeout: 2500 });
  expect(importServerData).toHaveBeenCalledOnce(); expect(getServerDataImport).toHaveBeenCalledOnce();
  expect(screen.getByRole('button', { name: 'Import selected server file' })).toBeEnabled();
});

it('does not disclose or import stale files after the project changes', async () => {
  let finish; listServerDataFiles.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const view = render(<ServerDataImporter {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Browse server data' }));
  await waitFor(() => expect(listServerDataFiles).toHaveBeenCalledOnce());
  const signal = listServerDataFiles.mock.calls[0][2].signal;
  view.rerender(<ServerDataImporter {...props} projectId="other" />);
  expect(signal.aborted).toBe(true);
  await act(async () => finish({ path: '', items: [file], nextCursor: null }));
  expect(screen.queryByRole('button', { name: 'Select server file cells.rds' })).not.toBeInTheDocument();
  expect(importServerData).not.toHaveBeenCalled();
});

it('removes private folder and artifact details after membership is revoked', async () => {
  render(<ServerDataImporter {...props} />); await browseAndSelect();
  listServerDataFiles.mockRejectedValueOnce(Object.assign(new Error('Project access is unavailable.'), { status: 403 }));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh server folder' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Project access is unavailable.');
  expect(screen.queryByLabelText('Authorized data root')).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Server artifact name')).not.toBeInTheDocument();
});

it('blocks new imports while disconnected and preserves a confirmed saved version', async () => {
  const target = { id: 'lab', endpoint: 'https://lab.example.test', status: 'connected', sshTunnel: { state: 'connected' } }; let notify;
  window.desktopShell = { getCurrentTarget: async () => target, onTargetStatus: listener => { notify = listener; return () => {}; } };
  render(<ServerDataImporter {...props} />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Browse server data' })).toBeEnabled());
  await browseAndSelect(); fireEvent.click(screen.getByRole('button', { name: 'Import selected server file' }));
  await screen.findByText('Server file saved as an immutable artifact version.');
  act(() => notify({ ...target, status: 'disconnected', sshTunnel: { state: 'disconnected' } }));
  expect(screen.getByText('Server file saved as an immutable artifact version.')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Import selected server file' })).toBeDisabled();
  expect(screen.getByText(/selected server is disconnected/)).toBeVisible();
  expect(importServerData).toHaveBeenCalledOnce();
});

it('stops pending status polling after a native loss and requires an explicit status check after reconnect', async () => {
  const target = { id: 'lab', endpoint: 'https://lab.example.test', status: 'connected', sshTunnel: { state: 'connected' } }; let notify;
  window.desktopShell = { getCurrentTarget: async () => target, onTargetStatus: listener => { notify = listener; return () => {}; } };
  importServerData.mockImplementationOnce(async (_project, input) => pendingReceipt(input));
  render(<ServerDataImporter {...props} />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Browse server data' })).toBeEnabled());
  await browseAndSelect(); fireEvent.click(screen.getByRole('button', { name: 'Import selected server file' }));
  expect(await screen.findByRole('progressbar', { name: 'Server snapshot copy progress' })).toHaveAttribute('value', '1000');
  vi.useFakeTimers();
  act(() => notify({ ...target, status: 'disconnected', sshTunnel: { state: 'disconnected' } }));
  act(() => notify(target));
  await act(async () => { await vi.advanceTimersByTimeAsync(3500); });
  expect(getServerDataImport).not.toHaveBeenCalled();
  expect(importServerData).toHaveBeenCalledOnce();
  expect(screen.getByRole('button', { name: 'Check server import status' })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Import selected server file' })).toBeDisabled();
});

it('rediscovers an accepted original after remount as a reader and checks it without browsing, copying or repeating notification', async () => {
  const first = render(<ServerDataImporter {...props} />); await browseAndSelect();
  importServerData.mockRejectedValueOnce(Object.assign(new Error('Lost'), { code: 'SERVER_DATA_IMPORT_UNCONFIRMED' }));
  fireEvent.click(screen.getByRole('button', { name: 'Import selected server file' }));
  await screen.findByRole('alert'); const originalId = importServerData.mock.calls[0][1].requestId; first.unmount();
  const retained = { ...complete, requestId: originalId, canImport: false };
  listServerDataImports.mockResolvedValue(discovery([savedItem(retained)], false)); getServerDataImport.mockResolvedValue(retained);
  const onImported = vi.fn(); render(<ServerDataImporter {...props} canWrite={false} onImported={onImported} />);
  expect(screen.queryByRole('button', { name: 'Browse server data' })).not.toBeInTheDocument();
  expect(screen.queryByText(`Import request: ${originalId}`)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Saved server imports' }));
  const row = await savedRow();
  expect(getServerDataImport).not.toHaveBeenCalled(); expect(onImported).not.toHaveBeenCalled();
  fireEvent.click(row); await screen.findByRole('region', { name: 'Server import outcome' });
  expect(getServerDataImport).toHaveBeenCalledWith(props.projectId, originalId, expect.any(AbortSignal), { userId: 1, serviceId });
  fireEvent.click(screen.getByRole('button', { name: 'Check server import status' }));
  await waitFor(() => expect(getServerDataImport).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Check server import status' })).toBeEnabled());
  expect(onImported).toHaveBeenCalledExactlyOnceWith(version); expect(importServerData).toHaveBeenCalledOnce(); expect(listServerDataRoots).toHaveBeenCalledOnce();
});

it.each(['unavailable', 'legacy-unrecorded'])('shows %s completion without inventing a preview or recopying the source', async state => {
  const retained = { ...complete, canImport: false, version: null, availability: 'unavailable',
    ...(state === 'legacy-unrecorded' ? { acceptanceState: state, acceptance: null } : {}) };
  listServerDataImports.mockResolvedValue(discovery([savedItem(retained)], false)); getServerDataImport.mockResolvedValue(retained);
  const onImported = vi.fn(); render(<ServerDataImporter {...props} canWrite={false} onImported={onImported} />);
  fireEvent.click(screen.getByRole('button', { name: 'Saved server imports' }));
  fireEvent.click(await savedRow());
  const outcome = await screen.findByRole('region', { name: 'Server import outcome' });
  expect(outcome).toHaveTextContent(state === 'unavailable' ? 'Its saved file is currently unavailable' : 'its exact acceptance was not retained');
  if (state === 'unavailable') expect(outcome).toHaveTextContent(`SHA-256 ${version.sha256}`);
  else expect(outcome).toHaveTextContent('No checksum or exact version is inferred.');
  expect(screen.queryByRole('button', { name: 'Retry original server import' })).not.toBeInTheDocument();
  expect(onImported).not.toHaveBeenCalled(); expect(importServerData).not.toHaveBeenCalled(); expect(listServerDataFiles).not.toHaveBeenCalled();
});

it('pages saved request metadata without automatically opening it or duplicating a request', async () => {
  const older = { ...savedItem(), id: `sdi_${'8'.repeat(24)}`, requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'Older result' };
  listServerDataImports.mockResolvedValueOnce(discovery([savedItem()], false, 'older_page'))
    .mockResolvedValueOnce(discovery([savedItem(), older], false));
  render(<ServerDataImporter {...props} canWrite={false} />);
  fireEvent.click(screen.getByRole('button', { name: 'Saved server imports' }));
  fireEvent.click(await screen.findByRole('button', { name: 'More saved imports' }));
  await savedRow('Older result');
  expect(within(screen.getByRole('list', { name: 'Saved server import requests' })).getAllByRole('button')).toHaveLength(2);
  expect(listServerDataImports).toHaveBeenLastCalledWith(props.projectId, { cursor: 'older_page', userId: 1, serviceId, signal: expect.any(AbortSignal) });
  expect(getServerDataImport).not.toHaveBeenCalled(); expect(importServerData).not.toHaveBeenCalled();
});

it('requires an explicit missing check and repeats the exact normalized UUID/source/settings only on deliberate retry', async () => {
  importServerData.mockRejectedValueOnce(Object.assign(new Error('Lost'), { code: 'SERVER_DATA_IMPORT_UNCONFIRMED' }));
  getServerDataImport.mockRejectedValueOnce(Object.assign(new Error('Missing'), { status: 404, code: 'SERVER_DATA_IMPORT_NOT_FOUND' }));
  render(<ServerDataImporter {...props} />); await browseAndSelect();
  fireEvent.change(screen.getByLabelText('Server artifact name'), { target: { value: ' Frozen original ' } });
  fireEvent.click(screen.getByText('Sample details (optional)'));
  fireEvent.change(screen.getByLabelText('Server sample condition'), { target: { value: ' treated ' } });
  fireEvent.click(screen.getByRole('button', { name: 'Import selected server file' })); await screen.findByRole('alert');
  const frozen = importServerData.mock.calls[0][1];
  expect(frozen).toMatchObject({ name: 'Frozen original', previousVersionId: null, sampleMetadata: { condition: 'treated' } });
  expect(screen.queryByRole('button', { name: 'Retry original server import' })).not.toBeInTheDocument();
  expect(screen.getByLabelText('Server artifact name')).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Check server import status' }));
  const retry = await screen.findByRole('button', { name: 'Retry original server import' });
  expect(importServerData).toHaveBeenCalledOnce();
  fireEvent.click(retry); await screen.findByRole('region', { name: 'Server import outcome' });
  expect(importServerData).toHaveBeenCalledTimes(2); expect(importServerData.mock.calls[1][1]).toEqual(frozen);
  expect(importServerData.mock.calls[1][1]).toBe(frozen);
  expect(listServerDataImports.mock.invocationCallOrder.at(-1)).toBeLessThan(importServerData.mock.invocationCallOrder[1]);
  expect(listServerDataImports).toHaveBeenLastCalledWith(props.projectId, expect.objectContaining({ userId: 1, serviceId }));
});

it('releases a first precise rejection but preserves the frozen original after an earlier uncertain attempt', async () => {
  importServerData.mockRejectedValueOnce(Object.assign(new Error('Source changed.'), { status: 409, code: 'SERVER_IMPORT_SOURCE_CHANGED' }));
  render(<ServerDataImporter {...props} />); await browseAndSelect();
  fireEvent.click(screen.getByRole('button', { name: 'Import selected server file' })); await screen.findByRole('alert');
  expect(screen.getByRole('button', { name: 'Import selected server file' })).toBeEnabled(); expect(screen.queryByText(/Import request:/)).not.toBeInTheDocument();
  importServerData.mockRejectedValueOnce(Object.assign(new Error('Lost'), { code: 'SERVER_DATA_IMPORT_UNCONFIRMED' }));
  fireEvent.click(screen.getByRole('button', { name: 'Import selected server file' }));
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('No import will be submitted again automatically'));
  const frozen = importServerData.mock.calls[1][1];
  getServerDataImport.mockRejectedValueOnce(Object.assign(new Error('Missing'), { status: 404, code: 'SERVER_DATA_IMPORT_NOT_FOUND' }));
  fireEvent.click(screen.getByRole('button', { name: 'Check server import status' }));
  const retry = await screen.findByRole('button', { name: 'Retry original server import' });
  importServerData.mockRejectedValueOnce(Object.assign(new Error('Source changed again.'), { status: 409, code: 'SERVER_IMPORT_SOURCE_CHANGED' }));
  fireEvent.click(retry);
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Check the original import request again'));
  expect(screen.getByText(`Import request: ${frozen.requestId}`)).toBeVisible(); expect(screen.getByLabelText('Server artifact name')).toBeDisabled();
  expect(importServerData.mock.calls[2][1]).toEqual(frozen); expect(screen.queryByRole('button', { name: 'Retry original server import' })).not.toBeInTheDocument();
});

it('checks current service and authority again immediately before copying, refusing a fresh read-only result', async () => {
  render(<ServerDataImporter {...props} />); await browseAndSelect();
  listServerDataImports.mockResolvedValueOnce(discovery([], false));
  fireEvent.click(screen.getByRole('button', { name: 'Import selected server file' }));
  await waitFor(() => expect(screen.queryByLabelText('Server artifact name')).not.toBeInTheDocument());
  expect(importServerData).not.toHaveBeenCalled(); expect(screen.queryByText(/completion is unconfirmed/i)).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Browse server data' })).not.toBeInTheDocument();
});

it('does not copy to a replacement service that fails the bound discovery preflight', async () => {
  render(<ServerDataImporter {...props} />); await browseAndSelect();
  listServerDataImports.mockRejectedValueOnce(Object.assign(new Error('Original server identity could not be confirmed.'), { code: 'SERVER_DATA_RESPONSE_INVALID' }));
  fireEvent.click(screen.getByRole('button', { name: 'Import selected server file' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Original server identity could not be confirmed');
  expect(importServerData).not.toHaveBeenCalled(); expect(screen.queryByText(/Import request:/)).not.toBeInTheDocument();
});

it('a fresh read-only list fences a held POST and keeps its original request recoverable', async () => {
  const held = deferred(), onImported = vi.fn(); importServerData.mockReturnValueOnce(held.promise);
  render(<ServerDataImporter {...props} onImported={onImported} />); await browseAndSelect();
  fireEvent.click(screen.getByRole('button', { name: 'Import selected server file' })); await waitFor(() => expect(importServerData).toHaveBeenCalledOnce());
  const frozen = importServerData.mock.calls[0][1], signal = importServerData.mock.calls[0][2];
  listServerDataImports.mockResolvedValueOnce(discovery([savedItem({ ...complete, requestId: frozen.requestId })], false));
  fireEvent.click(screen.getByRole('button', { name: 'Saved server imports' }));
  await savedRow(); expect(signal.aborted).toBe(true);
  await act(async () => held.resolve({ ...complete, requestId: frozen.requestId }));
  expect(onImported).not.toHaveBeenCalled(); expect(screen.queryByRole('region', { name: 'Server import outcome' })).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Server artifact name')).not.toBeInTheDocument(); expect(screen.getByText(`Import request: ${frozen.requestId}`)).toBeVisible();
  expect(screen.getByRole('button', { name: 'Check server import status' })).toBeEnabled();
});

it('a fresh read-only exact receipt cancels an older writer list without restoring its picker or authority', async () => {
  importServerData.mockRejectedValueOnce(Object.assign(new Error('Lost'), { code: 'SERVER_DATA_IMPORT_UNCONFIRMED' }));
  render(<ServerDataImporter {...props} />); await browseAndSelect();
  fireEvent.click(screen.getByRole('button', { name: 'Import selected server file' })); await screen.findByRole('alert');
  const frozen = importServerData.mock.calls[0][1];
  listServerDataImports.mockResolvedValueOnce(discovery([savedItem()]));
  fireEvent.click(screen.getByRole('button', { name: 'Saved server imports' })); await savedRow();
  const held = deferred(); listServerDataImports.mockReturnValueOnce(held.promise);
  fireEvent.click(screen.getByRole('button', { name: 'Refresh saved imports' }));
  const signal = listServerDataImports.mock.calls.at(-1)[1].signal;
  getServerDataImport.mockResolvedValueOnce({ ...complete, requestId: frozen.requestId, canImport: false });
  fireEvent.click(screen.getByRole('button', { name: 'Check server import status' })); await screen.findByRole('region', { name: 'Server import outcome' });
  expect(signal.aborted).toBe(true); await act(async () => held.resolve(discovery([savedItem()])));
  expect(screen.queryByRole('button', { name: 'Browse server data' })).not.toBeInTheDocument(); expect(screen.queryByLabelText('Server artifact name')).not.toBeInTheDocument();
  expect(screen.getByText(/Starting a new copy requires write access/)).toBeVisible();
  expect(screen.queryByText(/No authorized server data roots are configured/)).not.toBeInTheDocument();
});

it('a fresh read-only list keeps its own metadata while discarding an older exact reader response', async () => {
  listServerDataImports.mockResolvedValueOnce(discovery([savedItem()]));
  const held = deferred(); getServerDataImport.mockReturnValueOnce(held.promise);
  const onImported = vi.fn(); render(<ServerDataImporter {...props} onImported={onImported} />);
  fireEvent.click(screen.getByRole('button', { name: 'Saved server imports' }));
  fireEvent.click(await savedRow()); await waitFor(() => expect(getServerDataImport).toHaveBeenCalledOnce());
  const signal = getServerDataImport.mock.calls[0][2];
  listServerDataImports.mockResolvedValueOnce(discovery([{ ...savedItem(), name: 'Current reader result' }], false));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh saved imports' }));
  await savedRow('Current reader result'); expect(signal.aborted).toBe(true);
  await act(async () => held.resolve(complete));
  expect(onImported).not.toHaveBeenCalled(); expect(screen.queryByRole('region', { name: 'Server import outcome' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Browse server data' })).not.toBeInTheDocument();
});

it('fresh membership denial clears private receipts and fences a genuinely held earlier copy response', async () => {
  const held = deferred(), onImported = vi.fn(); importServerData.mockReturnValueOnce(held.promise);
  render(<ServerDataImporter {...props} onImported={onImported} />); await browseAndSelect();
  fireEvent.click(screen.getByRole('button', { name: 'Import selected server file' })); await waitFor(() => expect(importServerData).toHaveBeenCalledOnce());
  const signal = importServerData.mock.calls[0][2];
  listServerDataImports.mockRejectedValueOnce(Object.assign(new Error('Project access is unavailable.'), { status: 403 }));
  fireEvent.click(screen.getByRole('button', { name: 'Saved server imports' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Project access is unavailable'); expect(signal.aborted).toBe(true);
  await act(async () => held.resolve(complete));
  expect(screen.queryByText(/Import request:/)).not.toBeInTheDocument(); expect(screen.queryByText(/study\/cells.rds/)).not.toBeInTheDocument();
  expect(screen.queryByRole('region', { name: 'Server import outcome' })).not.toBeInTheDocument(); expect(onImported).not.toHaveBeenCalled();
});

it.each(['project', 'user', 'unmount'])('discards a held exact private response after %s changes', async change => {
  listServerDataImports.mockResolvedValueOnce(discovery([savedItem()], false)); const held = deferred(); getServerDataImport.mockReturnValueOnce(held.promise);
  const onImported = vi.fn(), view = render(<ServerDataImporter {...props} canWrite={false} onImported={onImported} />);
  fireEvent.click(screen.getByRole('button', { name: 'Saved server imports' })); fireEvent.click(await savedRow());
  await waitFor(() => expect(getServerDataImport).toHaveBeenCalledOnce()); const signal = getServerDataImport.mock.calls[0][2];
  if (change === 'unmount') view.unmount();
  else view.rerender(<ServerDataImporter {...props} canWrite={false} {...(change === 'project' ? { projectId: 'other' } : { userId: 2 })} onImported={onImported} />);
  expect(signal.aborted).toBe(true); await act(async () => held.resolve(complete)); expect(onImported).not.toHaveBeenCalled();
  expect(screen.queryByRole('region', { name: 'Server import outcome' })).not.toBeInTheDocument();
});

it('fences a held copy across native loss and reconnect, then recovers only after an explicit check', async () => {
  const target = { id: 'lab', endpoint: 'https://lab.example.test', status: 'connected', sshTunnel: { state: 'connected' } }; let notify;
  window.desktopShell = { getCurrentTarget: async () => target, onTargetStatus: listener => { notify = listener; return () => {}; } };
  const held = deferred(), onImported = vi.fn(); importServerData.mockReturnValueOnce(held.promise);
  render(<ServerDataImporter {...props} onImported={onImported} />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Browse server data' })).toBeEnabled()); await browseAndSelect();
  fireEvent.click(screen.getByRole('button', { name: 'Import selected server file' })); await waitFor(() => expect(importServerData).toHaveBeenCalledOnce());
  const frozen = importServerData.mock.calls[0][1], signal = importServerData.mock.calls[0][2];
  act(() => notify({ ...target, status: 'disconnected', sshTunnel: { state: 'disconnected' } })); expect(signal.aborted).toBe(true);
  await act(async () => held.resolve({ ...complete, requestId: frozen.requestId })); expect(onImported).not.toHaveBeenCalled();
  act(() => notify(target)); expect(getServerDataImport).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Check server import status' }));
  await screen.findByRole('region', { name: 'Server import outcome' }); expect(importServerData).toHaveBeenCalledOnce(); expect(onImported).toHaveBeenCalledOnce();
});

it('reports a freshly unavailable accepted outcome so the parent can clear its earlier available inspection action', async () => {
  const onOutcome = vi.fn(), onImported = vi.fn(); render(<ServerDataImporter {...props} onOutcome={onOutcome} onImported={onImported} />);
  await browseAndSelect(); fireEvent.click(screen.getByRole('button', { name: 'Import selected server file' }));
  await screen.findByRole('region', { name: 'Server import outcome' }); expect(onImported).toHaveBeenCalledOnce();
  const originalId = importServerData.mock.calls[0][1].requestId;
  const unavailable = { ...complete, requestId: originalId, availability: 'unavailable', version: null, canImport: false };
  getServerDataImport.mockResolvedValueOnce(unavailable);
  fireEvent.click(screen.getByRole('button', { name: 'Check server import status' }));
  await waitFor(() => expect(screen.getByRole('region', { name: 'Server import outcome' })).toHaveTextContent('Its saved file is currently unavailable'));
  expect(onOutcome).toHaveBeenLastCalledWith(unavailable); expect(onImported).toHaveBeenCalledOnce();
  expect(screen.getByRole('region', { name: 'Server import outcome' })).toHaveTextContent(`Version ${version.versionId}`);
  expect(importServerData).toHaveBeenCalledOnce();
});

it('reports null after a real scope denial and never reports a held old receipt after that denial', async () => {
  listServerDataImports.mockResolvedValueOnce(discovery([savedItem()], false));
  const held = deferred(); getServerDataImport.mockReturnValueOnce(held.promise);
  const onOutcome = vi.fn(); render(<ServerDataImporter {...props} canWrite={false} onOutcome={onOutcome} />);
  fireEvent.click(screen.getByRole('button', { name: 'Saved server imports' })); fireEvent.click(await savedRow());
  await waitFor(() => expect(getServerDataImport).toHaveBeenCalledOnce());
  listServerDataImports.mockRejectedValueOnce(Object.assign(new Error('No current project access.'), { status: 404, code: 'SERVER_IMPORT_NOT_FOUND' }));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh saved imports' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('No current project access'); expect(onOutcome).toHaveBeenCalledExactlyOnceWith(null);
  await act(async () => held.resolve(complete)); expect(onOutcome).toHaveBeenCalledExactlyOnceWith(null);
  expect(screen.queryByRole('region', { name: 'Server import outcome' })).not.toBeInTheDocument();
});
