import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import ServerDataImporter from './ServerDataImporter';
import { getServerDataImport, importServerData, listServerDataFiles, listServerDataRoots } from '../artifacts/serverDataApi';

vi.mock('../artifacts/serverDataApi', () => ({ getServerDataImport: vi.fn(), importServerData: vi.fn(), listServerDataFiles: vi.fn(), listServerDataRoots: vi.fn() }));
const roots = { roots: [{ id: 'lab-data', label: 'Lab data' }], limits: { maxFileBytes: 512 * 1024 ** 2, managedQuotaBytes: 5 * 1024 ** 3 } };
const file = { name: 'cells.rds', relativePath: 'study/cells.rds', kind: 'file', sizeBytes: 3400, selectionToken: 'a'.repeat(64), modifiedAt: '2026-10-08T01:00:00Z' };
const version = { name: 'Saved cells', versionId: 'av_one', sizeBytes: 3400, sha256: 'b'.repeat(64) };
const complete = { requestId: 'request', status: 'succeeded', version };
const props = { projectId: 'project', userId: 1 };
beforeEach(() => {
  vi.clearAllMocks();
  listServerDataRoots.mockResolvedValue(roots);
  listServerDataFiles.mockResolvedValue({ path: '', items: [{ kind: 'directory', name: 'study', relativePath: 'study' }, file], nextCursor: null });
  importServerData.mockImplementation(async (_project, input) => ({ ...complete, requestId: input.requestId }));
  getServerDataImport.mockResolvedValue(complete);
});
afterEach(() => { delete window.desktopShell; vi.useRealTimers(); });
async function browseAndSelect() {
  fireEvent.click(screen.getByRole('button', { name: 'Browse server data' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Select server file cells.rds' }));
}

it('browses authorized folders, edits the name and sends only immutable source selection metadata', async () => {
  const onImported = vi.fn(); render(<ServerDataImporter {...props} onImported={onImported} />);
  expect(listServerDataRoots).not.toHaveBeenCalled();
  await browseAndSelect();
  expect(screen.getByText(/3,400 bytes/)).toBeVisible();
  expect(screen.getByText(/512.0 MiB per file/)).toBeVisible();
  fireEvent.change(screen.getByLabelText('Server artifact name'), { target: { value: 'Saved cells' } });
  fireEvent.click(screen.getByRole('button', { name: 'Import selected server file' }));
  expect(await screen.findByText('Server file saved as an immutable artifact version.')).toBeVisible();
  expect(importServerData).toHaveBeenCalledWith('project', { requestId: expect.any(String), rootId: 'lab-data', relativePath: 'study/cells.rds', selectionToken: file.selectionToken, name: 'Saved cells', artifactType: 'auto' }, expect.any(AbortSignal));
  expect(onImported).toHaveBeenCalledExactlyOnceWith(version);
  expect(screen.getByText('SHA-256 ' + version.sha256)).toBeVisible();
});

it('pages directories, clears file selections on navigation and sends sample-sheet purpose explicitly', async () => {
  render(<ServerDataImporter {...props} />); await browseAndSelect();
  listServerDataFiles.mockResolvedValueOnce({ path: 'study', items: [file], nextCursor: 'next' });
  fireEvent.click(screen.getByRole('button', { name: 'Open folder study' }));
  expect(await screen.findByRole('button', { name: 'More server files' })).toBeVisible();
  expect(screen.queryByLabelText('Server artifact name')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'More server files' }));
  await waitFor(() => expect(listServerDataFiles).toHaveBeenLastCalledWith('project', 'lab-data', expect.objectContaining({ path: 'study', cursor: 'next' })));
  fireEvent.click(screen.getByRole('button', { name: 'Select server file cells.rds' }));
  fireEvent.change(screen.getByLabelText('Server artifact purpose'), { target: { value: 'sample-sheet' } });
  fireEvent.click(screen.getByRole('button', { name: 'Import selected server file' }));
  await waitFor(() => expect(importServerData).toHaveBeenCalledWith('project', expect.objectContaining({ artifactType: 'sample-sheet' }), expect.any(AbortSignal)));
});

it('retains optional sample annotations without adding empty fields or changing source bytes', async () => {
  render(<ServerDataImporter {...props} />); await browseAndSelect();
  fireEvent.click(screen.getByText('Sample details (optional)'));
  fireEvent.change(screen.getByLabelText('Server sample sample id'), { target: { value: ' sample-A ' } });
  fireEvent.change(screen.getByLabelText('Server sample condition'), { target: { value: 'treatment' } });
  fireEvent.change(screen.getByLabelText('Server sample tissue'), { target: { value: '   ' } });
  fireEvent.click(screen.getByRole('button', { name: 'Import selected server file' }));
  await waitFor(() => expect(importServerData).toHaveBeenCalledWith('project', expect.objectContaining({ sampleMetadata: { sampleId: 'sample-A', condition: 'treatment' }, selectionToken: file.selectionToken }), expect.any(AbortSignal)));
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
  expect(getServerDataImport).toHaveBeenCalledWith('project', submittedId, expect.any(AbortSignal));
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
  importServerData.mockImplementationOnce(async (_project, input) => ({ requestId: input.requestId, status: 'pending', reservedBytes: 3400 }));
  getServerDataImport.mockResolvedValueOnce({ requestId: 'request', status: 'failed', error: { message: 'The source file changed during copying.' } });
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
  importServerData.mockImplementationOnce(async (_project, input) => ({ requestId: input.requestId, status: 'pending', bytesCopied: 1000, totalBytes: 3400 }));
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
