import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import ServerDataFilePicker from './ServerDataFilePicker';
import { listServerDataFiles, listServerDataImports, listServerDataRoots } from '../artifacts/serverDataApi';

vi.mock('../artifacts/serverDataApi', () => ({ listServerDataFiles: vi.fn(), listServerDataImports: vi.fn(), listServerDataRoots: vi.fn() }));
const projectId = `proj_${'1'.repeat(24)}`, serviceId = `svc_${'2'.repeat(32)}`;
const root = { id: 'study-data', label: 'Study files' };
const limits = { maxFileBytes: 512 * 1024 ** 2, managedQuotaBytes: 5 * 1024 ** 3 };
const csv = { kind: 'file', name: 'results.csv', relativePath: 'results.csv', sizeBytes: 75, modifiedAt: '2026-10-22T12:00:00.000Z', selectionToken: 'a'.repeat(64) };
const rds = { ...csv, name: 'cells.rds', relativePath: 'cells.rds', sizeBytes: 3400 };
const directory = { kind: 'directory', name: 'figures', relativePath: 'figures' };
const cursor = 'eyJvZmZzZXQiOjF9.' + 'a'.repeat(64);
const discovery = (allowed = true) => ({ projectId, ownerUserId: 7, serviceId, canImport: allowed, items: [], nextCursor: null });
const folder = (changes = {}) => ({ root, path: '', items: [directory, csv, rds], nextCursor: null, ...changes });
const props = () => ({ projectId, userId: 7, serviceId, available: true, onSelect: vi.fn(), onAuthority: vi.fn(), onDenied: vi.fn(), onError: vi.fn(), onLimits: vi.fn(), onLoading: vi.fn() });
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const ready = async (input = props()) => { const view = render(<ServerDataFilePicker {...input} />); await screen.findByRole('button', { name: 'Select server file results.csv' }); return { ...view, props: input }; };
beforeEach(() => {
  vi.resetAllMocks();
  listServerDataImports.mockResolvedValue(discovery());
  listServerDataRoots.mockResolvedValue({ roots: [root], limits });
  listServerDataFiles.mockResolvedValue(folder());
});
afterEach(() => { delete window.desktopShell; });

it('only discovers bounded owner/service metadata and returns a selected source without copying or retaining an import recipe', async () => {
  const { props: input } = await ready();
  expect(listServerDataImports).toHaveBeenCalledExactlyOnceWith(projectId, { userId: 7, serviceId, signal: expect.any(AbortSignal) });
  expect(listServerDataRoots).toHaveBeenCalledExactlyOnceWith(projectId, expect.any(AbortSignal));
  expect(listServerDataFiles).toHaveBeenCalledExactlyOnceWith(projectId, root.id, { path: '', cursor: null, signal: expect.any(AbortSignal) });
  fireEvent.click(screen.getByRole('button', { name: 'Select server file results.csv' }));
  expect(input.onSelect).toHaveBeenLastCalledWith({ rootId: root.id, rootLabel: root.label, file: csv, limits, serviceId });
  expect(input.onAuthority).toHaveBeenCalledWith(true, { serviceId });
  expect(screen.queryByRole('button', { name: /Import selected|Attach|Retry/ })).not.toBeInTheDocument();
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
});

it('pages a signed relative folder, clears selection on navigation, deduplicates rows and supports explicit refresh', async () => {
  const { props: input, rerender } = await ready();
  fireEvent.click(screen.getByRole('button', { name: 'Select server file results.csv' }));
  const nested = { ...csv, relativePath: 'figures/results.csv' };
  listServerDataFiles.mockResolvedValueOnce(folder({ path: 'figures', items: [nested], nextCursor: cursor }));
  fireEvent.click(screen.getByRole('button', { name: 'Open folder figures' }));
  await screen.findByRole('button', { name: 'More server files' }); expect(input.onSelect).toHaveBeenLastCalledWith(null);
  listServerDataFiles.mockResolvedValueOnce(folder({ path: 'figures', items: [nested], nextCursor: null }));
  fireEvent.click(screen.getByRole('button', { name: 'More server files' }));
  await waitFor(() => expect(listServerDataFiles).toHaveBeenLastCalledWith(projectId, root.id, expect.objectContaining({ path: 'figures', cursor })));
  expect(screen.getAllByRole('button', { name: 'Select server file results.csv' })).toHaveLength(1);
  rerender(<ServerDataFilePicker {...input} refreshKey={1} />);
  await waitFor(() => expect(listServerDataImports).toHaveBeenCalledTimes(2));
  await screen.findByRole('button', { name: 'Open folder figures' });
});

it('keeps incompatible and oversized files visibly disabled without claiming that a filtered page is an empty folder', async () => {
  listServerDataFiles.mockResolvedValueOnce(folder({ items: [rds, { ...csv, name: 'large.csv', relativePath: 'large.csv', sizeBytes: 2000 }, { ...csv, name: 'empty.csv', relativePath: 'empty.csv', sizeBytes: 0 }] }));
  render(<ServerDataFilePicker {...props()} allowedExtensions={['.CSV', '.png']} maxFileBytes={1000} />);
  expect(await screen.findByRole('button', { name: 'Select server file cells.rds' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Select server file large.csv' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Select server file empty.csv' })).toBeDisabled();
  expect(screen.getByText('Server import limit: 1000 bytes per file · managed artifact quota 5.0 GiB.')).toBeVisible();
  expect(screen.queryByText('No supported files or folders are available here.')).not.toBeInTheDocument();
});

it('keeps a selected display disabled during an operation and does not restart browsing when the operation ends', async () => {
  const { props: input, rerender } = await ready();
  fireEvent.click(screen.getByRole('button', { name: 'Select server file results.csv' })); const notifications = input.onSelect.mock.calls.length;
  rerender(<ServerDataFilePicker {...input} disabled />);
  expect(screen.getByRole('button', { name: 'Select server file results.csv' })).toBeDisabled();
  expect(input.onSelect).toHaveBeenCalledTimes(notifications);
  rerender(<ServerDataFilePicker {...input} disabled={false} />);
  expect(screen.getByRole('button', { name: 'Select server file results.csv' })).toBeEnabled();
  expect(listServerDataImports).toHaveBeenCalledOnce();
});

it('treats a current import-policy denial as a source fence without opening roots or revoking analysis membership', async () => {
  const input = props(); listServerDataImports.mockResolvedValueOnce(discovery(false)); render(<ServerDataFilePicker {...input} />);
  await waitFor(() => expect(input.onAuthority).toHaveBeenCalledWith(false, { serviceId }));
  expect(listServerDataRoots).not.toHaveBeenCalled(); expect(listServerDataFiles).not.toHaveBeenCalled();
  expect(input.onDenied).not.toHaveBeenCalled();
  expect(screen.queryByText(/No allowed server folders/)).not.toBeInTheDocument();
});

it('offers a direct explicit refresh after source policy denial and discovers folders after access is restored without revoking project access', async () => {
  const input = props(); listServerDataImports.mockResolvedValueOnce(discovery(false)); render(<ServerDataFilePicker {...input} />);
  await waitFor(() => expect(input.onAuthority).toHaveBeenCalledWith(false, { serviceId }));
  expect(screen.getByText(/Server folders could not be opened/)).toBeVisible();
  expect(screen.queryByText(/No allowed server folders/)).not.toBeInTheDocument(); expect(listServerDataRoots).not.toHaveBeenCalled();
  listServerDataImports.mockResolvedValueOnce(discovery()); fireEvent.click(screen.getByRole('button', { name: 'Refresh server folders', exact: true }));
  fireEvent.click(await screen.findByRole('button', { name: 'Select server file results.csv' }));
  expect(listServerDataImports).toHaveBeenCalledTimes(2); expect(input.onAuthority).toHaveBeenLastCalledWith(true, { serviceId });
  expect(input.onSelect).toHaveBeenLastCalledWith(expect.objectContaining({ file: csv, serviceId }));
  expect(input.onDenied).not.toHaveBeenCalled(); expect(screen.queryByRole('button', { name: 'Refresh server folders', exact: true })).not.toBeInTheDocument();
});

it('retries bounded discovery after a source-specific missing-folder response without claiming that configured folders are empty', async () => {
  const input = props(), failure = Object.assign(new Error('The original data folder is unavailable.'), { status: 404, code: 'SERVER_IMPORT_NOT_FOUND' });
  listServerDataFiles.mockRejectedValueOnce(failure); render(<ServerDataFilePicker {...input} />);
  await waitFor(() => expect(input.onError).toHaveBeenCalledWith(failure));
  expect(screen.getByText(/Server folders could not be opened/)).toBeVisible();
  expect(screen.queryByText(/No allowed server folders/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh server folders', exact: true }));
  await screen.findByRole('button', { name: 'Select server file results.csv' });
  expect(listServerDataImports).toHaveBeenCalledTimes(2); expect(input.onDenied).not.toHaveBeenCalled();
});

it('refreshes a successfully empty allowed-folder list after a grant is added without requiring a source or analysis permission reset', async () => {
  const input = props(); listServerDataRoots.mockResolvedValueOnce({ roots: [], limits }); render(<ServerDataFilePicker {...input} />);
  await screen.findByText('No allowed server folders are configured for this project. Ask the server administrator to grant access to a data folder.');
  expect(screen.queryByText(/Server folders could not be opened/)).not.toBeInTheDocument(); expect(listServerDataFiles).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh server folders', exact: true }));
  await screen.findByRole('button', { name: 'Select server file results.csv' });
  expect(listServerDataImports).toHaveBeenCalledTimes(2); expect(listServerDataRoots).toHaveBeenCalledTimes(2);
  expect(input.onAuthority.mock.calls.every(([allowed]) => allowed === true)).toBe(true); expect(input.onDenied).not.toHaveBeenCalled();
  expect(screen.queryByText(/No allowed server folders/)).not.toBeInTheDocument();
});

it.each([
  [403, 'SERVER_IMPORT_UNAVAILABLE'], [404, 'SERVER_IMPORT_NOT_FOUND'],
])('keeps source-specific %s/%s separate from project membership denial', async (status, code) => {
  const input = props(); const failure = Object.assign(new Error('This source is unavailable.'), { status, code });
  listServerDataFiles.mockRejectedValueOnce(failure); render(<ServerDataFilePicker {...input} />);
  await waitFor(() => expect(input.onError).toHaveBeenCalledWith(failure));
  expect(input.onAuthority).toHaveBeenLastCalledWith(false, { serviceId, code });
  expect(input.onDenied).not.toHaveBeenCalled(); expect(screen.queryByLabelText('Server folder', { exact: true })).not.toBeInTheDocument();
});

it('clears protected source metadata and calls onDenied after a current membership denial', async () => {
  const { props: input } = await ready(); fireEvent.click(screen.getByRole('button', { name: 'Select server file results.csv' }));
  const failure = Object.assign(new Error('Project not found.'), { status: 404, code: 'NOT_FOUND' });
  listServerDataFiles.mockRejectedValueOnce(failure); fireEvent.click(screen.getByRole('button', { name: 'Refresh server folder' }));
  await waitFor(() => expect(input.onDenied).toHaveBeenCalledExactlyOnceWith(failure));
  expect(screen.queryByRole('button', { name: 'Select server file results.csv' })).not.toBeInTheDocument();
  expect(input.onSelect).toHaveBeenLastCalledWith(null);
});

it.each(['project', 'user', 'service', 'unavailable', 'unmounted'])('fences an older held listing after %s changes', async change => {
  const held = deferred(); listServerDataFiles.mockReturnValueOnce(held.promise);
  const input = props(), view = render(<ServerDataFilePicker {...input} />);
  await waitFor(() => expect(listServerDataFiles).toHaveBeenCalledOnce()); const signal = listServerDataFiles.mock.calls[0][2].signal;
  if (change === 'unmounted') view.unmount();
  else {
    if (change === 'project') listServerDataImports.mockResolvedValueOnce({ ...discovery(), projectId: `proj_${'3'.repeat(24)}` });
    if (change === 'user') listServerDataImports.mockResolvedValueOnce({ ...discovery(), ownerUserId: 8 });
    if (change === 'service') listServerDataImports.mockResolvedValueOnce({ ...discovery(), serviceId: `svc_${'4'.repeat(32)}` });
    listServerDataRoots.mockResolvedValueOnce({ roots: [], limits });
    view.rerender(<ServerDataFilePicker {...input} {...(change === 'project' ? { projectId: `proj_${'3'.repeat(24)}` }
      : change === 'user' ? { userId: 8 } : change === 'service' ? { serviceId: `svc_${'4'.repeat(32)}` } : { available: false })} />);
  }
  expect(signal.aborted).toBe(true); await act(async () => held.resolve(folder()));
  expect(screen.queryByRole('button', { name: 'Select server file results.csv' })).not.toBeInTheDocument();
  expect(input.onSelect.mock.calls.some(([value]) => value?.file)).toBe(false);
});

it('rejects a replacement service before browsing roots and does not silently rebind an existing selection', async () => {
  const input = props(); listServerDataImports.mockResolvedValueOnce({ ...discovery(), serviceId: `svc_${'9'.repeat(32)}` });
  render(<ServerDataFilePicker {...input} />);
  await waitFor(() => expect(input.onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'SERVER_DATA_SELECTION_INVALID' })));
  expect(listServerDataRoots).not.toHaveBeenCalled(); expect(input.onAuthority).not.toHaveBeenCalled();
});

it('fences discovery begun before the caller supplies its expected service identity', async () => {
  const held = deferred(), input = { ...props(), serviceId: undefined };
  listServerDataImports.mockReturnValueOnce(held.promise);
  const view = render(<ServerDataFilePicker {...input} />);
  await waitFor(() => expect(listServerDataImports).toHaveBeenCalledOnce()); const signal = listServerDataImports.mock.calls[0][1].signal;
  const replacement = `svc_${'8'.repeat(32)}`;
  listServerDataImports.mockResolvedValueOnce({ ...discovery(), serviceId: replacement });
  listServerDataRoots.mockResolvedValueOnce({ roots: [], limits });
  view.rerender(<ServerDataFilePicker {...input} serviceId={replacement} />);
  expect(signal.aborted).toBe(true); await act(async () => held.resolve(discovery()));
  expect(input.onAuthority).toHaveBeenCalledExactlyOnceWith(true, { serviceId: replacement });
  expect(screen.queryByRole('button', { name: 'Select server file results.csv' })).not.toBeInTheDocument();
});

it.each([
  ['different root', value => { value.root = { ...root, id: 'elsewhere' }; }],
  ['different directory', value => { value.path = 'elsewhere'; }],
  ['unsafe path', value => { value.items[1].relativePath = '../results.csv'; }],
  ['missing signed identity', value => { delete value.items[1].selectionToken; }],
  ['invalid size', value => { value.items[1].sizeBytes = -1; }],
  ['unbounded page', value => { value.items = Array.from({ length: 101 }, () => ({ ...csv })); }],
  ['invalid cursor', value => { value.nextCursor = 'not-a-signed-cursor'; }],
])('never exposes a file from a response with %s', async (_label, mutate) => {
  const value = structuredClone(folder()); mutate(value); listServerDataFiles.mockResolvedValueOnce(value);
  const input = props(); render(<ServerDataFilePicker {...input} />);
  await waitFor(() => expect(input.onError).toHaveBeenCalledWith(expect.any(Error)));
  expect(screen.queryByRole('button', { name: 'Select server file results.csv' })).not.toBeInTheDocument();
  expect(input.onSelect.mock.calls.some(([selected]) => selected?.file)).toBe(false);
});

it('aborts a native-disconnected listing and requires fresh metadata after reconnection', async () => {
  const target = { id: 'lab', endpoint: 'https://lab.example.test', status: 'connected', sshTunnel: { state: 'connected' } }; let notify;
  window.desktopShell = { getCurrentTarget: async () => target, onTargetStatus: callback => { notify = callback; return () => {}; } };
  const held = deferred(); listServerDataFiles.mockReturnValueOnce(held.promise); const input = props(); render(<ServerDataFilePicker {...input} />);
  await waitFor(() => expect(listServerDataFiles).toHaveBeenCalled()); const signal = listServerDataFiles.mock.calls[0][2].signal;
  act(() => notify({ ...target, status: 'disconnected', sshTunnel: { state: 'disconnected' } })); expect(signal.aborted).toBe(true);
  await act(async () => held.resolve(folder())); expect(screen.queryByRole('button', { name: 'Select server file results.csv' })).not.toBeInTheDocument();
  act(() => notify(target)); await screen.findByRole('button', { name: 'Select server file results.csv' });
  expect(listServerDataImports).toHaveBeenCalledTimes(2);
});
