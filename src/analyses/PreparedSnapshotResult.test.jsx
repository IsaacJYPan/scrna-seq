import React from 'react';
import { createHash, webcrypto } from 'node:crypto';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import PreparedSnapshotResult from './PreparedSnapshotResult';
import { readSnapshotPreparationView } from './snapshotPreparationApi';
import useExecutionTarget from '../runtime/useExecutionTarget';
import { getArtifactVersion, previewArtifactVersion } from '../artifacts/artifactApi';
import { fetchRetainedArtifactImage } from '../artifacts/retainedArtifactApi';
import { canonicalSnapshotJson, canonicalAnalysisSnapshotResultView } from '../../shared/analysisSnapshotPreparation.mjs';
import { snapshotScope, snapshotRecipe, snapshotRecord } from './snapshotPreparationTestFixtures';

vi.mock('./snapshotPreparationApi', () => ({ readSnapshotPreparationView: vi.fn() }));
vi.mock('../runtime/useExecutionTarget', () => ({ default: vi.fn() }));
vi.mock('../artifacts/artifactApi', () => ({ getArtifactVersion: vi.fn(), previewArtifactVersion: vi.fn() }));
vi.mock('../artifacts/retainedArtifactApi', () => ({ fetchRetainedArtifactImage: vi.fn() }));
const hash = value => createHash('sha256').update(value).digest('hex');
const connection = { identity: 'workspace-one', epoch: 1, blocked: false };
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
function fixture({ name = 'donor α', offset = 25, image = false, jpeg = false } = {}) {
  const record = snapshotRecord(snapshotRecipe()), descriptor = structuredClone(record.package.results[0]);
  const table = { family: 'table', columns: ['sample', 'value'], rows: [[name, '\t3\r\n']], offset, limit: 2, hasMore: false, scannedRows: offset + 1, truncated: false };
  const bytes = image ? new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGOQS7nzHwAEYAJeiHDUBAAAAABJRU5ErkJggg==', 'base64'))
    : new TextEncoder().encode(canonicalSnapshotJson(table));
  const type = image ? jpeg ? 'image/jpeg' : 'image/png' : 'application/json';
  if (image) descriptor.source.format = { id: jpeg ? 'org.iso.jpeg' : 'org.w3.png', version: '1' };
  const { viewSha256: _oldHash, ...previousView } = descriptor.view; void _oldHash;
  const view = { ...previousView, family: image ? 'image' : 'table', spec: image ? null : { offset, limit: 2 },
    blobSha256: hash(bytes), blobBytes: bytes.byteLength, width: image ? 1 : null, height: image ? 1 : null };
  descriptor.view = { ...view, viewSha256: hash(canonicalAnalysisSnapshotResultView({ ...view,
    source: { artifactId: descriptor.source.artifactId, versionId: descriptor.source.versionId, projectId: snapshotScope.projectId, sha256: descriptor.source.sha256 } })) };
  return { props: { ...snapshotScope, preparationId: record.preparationId, descriptor, available: true, isActive: true,
    onDenied: vi.fn(), onUnavailable: vi.fn() }, bytes, type, table };
}
beforeEach(() => {
  vi.resetAllMocks(); vi.stubGlobal('crypto', webcrypto); useExecutionTarget.mockReturnValue(connection);
  let sequence = 0; vi.stubGlobal('URL', { createObjectURL: vi.fn(() => `blob:retained-${++sequence}`), revokeObjectURL: vi.fn() });
});
afterEach(() => vi.unstubAllGlobals());

it('decodes exact retained table bytes and renders a fixed window without any original-source read', async () => {
  const value = fixture(); readSnapshotPreparationView.mockResolvedValue(value); render(<PreparedSnapshotResult {...value.props} />);
  expect(await screen.findByRole('cell', { name: 'donor α' })).toBeVisible();
  expect(screen.getByLabelText('Fixed retained table excerpt')).toHaveTextContent('source rows 26–26');
  expect(screen.queryByRole('button', { name: 'Next rows' })).not.toBeInTheDocument(); expect(screen.queryByRole('combobox', { name: 'Rows per page' })).not.toBeInTheDocument();
  expect(readSnapshotPreparationView).toHaveBeenCalledExactlyOnceWith(snapshotScope.projectId, snapshotScope.analysisId, value.props.preparationId,
    value.props.descriptor, { signal: expect.any(AbortSignal) });
  expect(getArtifactVersion).not.toHaveBeenCalled(); expect(previewArtifactVersion).not.toHaveBeenCalled(); expect(fetchRetainedArtifactImage).not.toHaveBeenCalled();
});

it.each(['wrong checksum', 'wrong fixed window', 'noncanonical bytes'])('refuses %s before showing any table and reports only retained unavailability', async failure => {
  const value = fixture();
  if (failure === 'wrong checksum') value.bytes = new TextEncoder().encode('unverified private content');
  else {
    if (failure === 'wrong fixed window') value.table.offset = 0;
    value.bytes = new TextEncoder().encode(failure === 'noncanonical bytes' ? JSON.stringify(value.table, null, 2) : canonicalSnapshotJson(value.table));
    value.props.descriptor.view.blobSha256 = hash(value.bytes); value.props.descriptor.view.blobBytes = value.bytes.byteLength;
  }
  readSnapshotPreparationView.mockResolvedValue(value); render(<PreparedSnapshotResult {...value.props} />);
  expect(await screen.findByRole('alert')).toHaveTextContent('exact saved identity is kept');
  expect(screen.queryByRole('table')).not.toBeInTheDocument(); expect(screen.queryByText(/checksum verified/)).not.toBeInTheDocument();
  expect(value.props.onUnavailable).toHaveBeenCalledOnce(); expect(value.props.onDenied).not.toHaveBeenCalled();
});

it('does not refetch when parent recovery returns the same immutable descriptor with new object and callback identities', async () => {
  const value = fixture(); readSnapshotPreparationView.mockResolvedValue(value);
  const view = render(<PreparedSnapshotResult {...value.props} />); await screen.findByRole('table');
  view.rerender(<PreparedSnapshotResult {...value.props} descriptor={structuredClone(value.props.descriptor)} onDenied={vi.fn()} onUnavailable={vi.fn()} />);
  await act(async () => {}); expect(readSnapshotPreparationView).toHaveBeenCalledOnce();
});

it('does not loop unavailable body reads after a parent exact check and permits only an explicit retained-view retry', async () => {
  const value = fixture(), failure = Object.assign(new Error('private raw error'), { status: 404, code: 'ANALYSIS_SNAPSHOT_PREPARATION_NOT_FOUND' });
  readSnapshotPreparationView.mockRejectedValueOnce(failure).mockResolvedValue(value);
  const view = render(<PreparedSnapshotResult {...value.props} />); await screen.findByRole('alert');
  expect(value.props.onUnavailable).toHaveBeenCalledExactlyOnceWith(failure); expect(value.props.onDenied).not.toHaveBeenCalled();
  expect(screen.queryByText('private raw error')).not.toBeInTheDocument();
  view.rerender(<PreparedSnapshotResult {...value.props} descriptor={structuredClone(value.props.descriptor)} />);
  await act(async () => {}); expect(readSnapshotPreparationView).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button', { name: 'Retry retained view' })); await screen.findByRole('table');
  expect(readSnapshotPreparationView).toHaveBeenCalledTimes(2);
});

it.each([
  [401, 'UNAUTHORIZED', true], [404, 'ANALYSIS_SNAPSHOT_SCOPE_NOT_FOUND', true], [403, 'FORBIDDEN', true],
  [403, 'ANALYSIS_SNAPSHOT_WRITE_REQUIRED', false], [409, 'ANALYSIS_SNAPSHOT_VIEW_UNAVAILABLE', false],
])('classifies retained read %s/%s without conflating write-only permission and read scope', async (status, code, revokes) => {
  const value = fixture(), failure = Object.assign(new Error('private upstream detail'), { status, code });
  readSnapshotPreparationView.mockRejectedValue(failure); render(<PreparedSnapshotResult {...value.props} />); await screen.findByRole('alert');
  if (revokes) expect(value.props.onDenied).toHaveBeenCalledExactlyOnceWith(failure); else expect(value.props.onDenied).not.toHaveBeenCalled();
  if (code === 'ANALYSIS_SNAPSHOT_VIEW_UNAVAILABLE') expect(value.props.onUnavailable).toHaveBeenCalledExactlyOnceWith(failure);
  expect(screen.queryByText('private upstream detail')).not.toBeInTheDocument();
});

it.each(['project', 'analysis', 'user', 'preparation', 'service', 'epoch', 'inactive', 'disconnected', 'unmounted'])('fences an ignored held result read when %s changes', async change => {
  const value = fixture({ name: 'Old private row' }), completion = deferred(); readSnapshotPreparationView.mockReturnValueOnce(completion.promise);
  const view = render(<PreparedSnapshotResult {...value.props} />);
  await waitFor(() => expect(readSnapshotPreparationView).toHaveBeenCalledOnce()); const signal = readSnapshotPreparationView.mock.calls[0][4].signal;
  readSnapshotPreparationView.mockRejectedValue(new Error('Current workspace unavailable.'));
  if (change === 'unmounted') view.unmount();
  else {
    if (change === 'epoch') useExecutionTarget.mockReturnValue({ ...connection, epoch: 2 });
    const changed = change === 'project' ? { projectId: 'proj_' + 'e'.repeat(16) } : change === 'analysis' ? { analysisId: 'ra_' + 'e'.repeat(24) }
      : change === 'user' ? { userId: 8 } : change === 'preparation' ? { preparationId: 'asp_' + 'e'.repeat(24) }
        : change === 'service' ? { serviceId: 'svc_' + 'e'.repeat(32) } : change === 'inactive' ? { isActive: false } : change === 'disconnected' ? { available: false } : {};
    view.rerender(<PreparedSnapshotResult {...value.props} {...changed} />);
  }
  expect(signal.aborted).toBe(true); await act(async () => completion.resolve(value));
  expect(screen.queryByRole('cell', { name: 'Old private row' })).not.toBeInTheDocument(); expect(value.props.onDenied).not.toHaveBeenCalled();
});

it('replaces an exact view selection without exposing an older response that ignores cancellation', async () => {
  const old = fixture({ name: 'Old selected row' }), next = fixture({ name: 'New selected row' }), completion = deferred();
  next.props.descriptor.viewId = 'asv_' + 'e'.repeat(24); readSnapshotPreparationView.mockReturnValueOnce(completion.promise).mockResolvedValue(next);
  const view = render(<PreparedSnapshotResult {...old.props} />); await waitFor(() => expect(readSnapshotPreparationView).toHaveBeenCalledOnce());
  view.rerender(<PreparedSnapshotResult {...next.props} />); await screen.findByRole('cell', { name: 'New selected row' });
  await act(async () => completion.resolve(old)); expect(screen.queryByRole('cell', { name: 'Old selected row' })).not.toBeInTheDocument();
});

it.each([false, true])('uses only the verified retained raster blob and removes all preview/export links on decode failure (JPEG: %s)', async jpeg => {
  const value = fixture({ image: true, jpeg }); readSnapshotPreparationView.mockResolvedValue(value);
  const view = render(<PreparedSnapshotResult {...value.props} />), raster = await screen.findByRole('img');
  expect(raster).toHaveAttribute('src', 'blob:retained-1'); expect(screen.getByText('1 × 1 pixels · image preview')).toBeVisible();
  expect(screen.getByRole('link', { name: 'Open full-size image' })).toHaveAttribute('href', 'blob:retained-1');
  const onUnavailable = vi.fn(); view.rerender(<PreparedSnapshotResult {...value.props} descriptor={structuredClone(value.props.descriptor)} onUnavailable={onUnavailable} />);
  expect(readSnapshotPreparationView).toHaveBeenCalledOnce(); fireEvent.error(raster);
  expect(screen.getByRole('alert')).toHaveTextContent('could not be decoded'); expect(screen.queryByRole('img')).not.toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'Open full-size image' })).not.toBeInTheDocument(); expect(screen.queryByText(/checksum verified/)).not.toBeInTheDocument();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:retained-1'); expect(onUnavailable).toHaveBeenCalledOnce(); expect(value.props.onUnavailable).not.toHaveBeenCalled();
});

it('revokes an already rendered raster immediately when its native target disconnects and makes no replacement source read', async () => {
  const value = fixture({ image: true }); readSnapshotPreparationView.mockResolvedValue(value);
  const view = render(<PreparedSnapshotResult {...value.props} />); await screen.findByRole('img');
  useExecutionTarget.mockReturnValue({ ...connection, blocked: true, epoch: 2 }); view.rerender(<PreparedSnapshotResult {...value.props} />);
  expect(screen.queryByRole('img')).not.toBeInTheDocument(); expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:retained-1');
  expect(readSnapshotPreparationView).toHaveBeenCalledOnce(); expect(fetchRetainedArtifactImage).not.toHaveBeenCalled();
});

it('never creates an object URL from a late raster body after scope loss', async () => {
  const value = fixture({ image: true }), completion = deferred(); readSnapshotPreparationView.mockReturnValueOnce(completion.promise);
  const view = render(<PreparedSnapshotResult {...value.props} />); await waitFor(() => expect(readSnapshotPreparationView).toHaveBeenCalledOnce());
  view.rerender(<PreparedSnapshotResult {...value.props} available={false} />); await act(async () => completion.resolve(value));
  expect(URL.createObjectURL).not.toHaveBeenCalled(); expect(screen.queryByRole('img')).not.toBeInTheDocument();
});

it('uses an explicit stable publication reader and current viewer without falling back to private preparation routes', async () => {
  const value = fixture(), readView = vi.fn().mockResolvedValue(value), resourceId = 'aspub_' + 'b'.repeat(24);
  const props = { ...value.props, userId: 8, audience: 'project-publication', resourceId, readView, snapshotSha256: 'b'.repeat(64) };
  const view = render(<PreparedSnapshotResult {...props} />); await screen.findByRole('table');
  expect(readView).toHaveBeenCalledExactlyOnceWith(snapshotScope.projectId, snapshotScope.analysisId, resourceId, value.props.descriptor, { signal: expect.any(AbortSignal) });
  expect(readSnapshotPreparationView).not.toHaveBeenCalled();
  view.rerender(<PreparedSnapshotResult {...props} descriptor={structuredClone(props.descriptor)} onUnavailable={vi.fn()} />);
  await act(async () => {}); expect(readView).toHaveBeenCalledOnce();
});

it.each([
  ['unknown namespace', { audience: 'public' }], ['private id in public namespace', { audience: 'project-publication' }],
  ['public id without transport', { audience: 'project-publication', resourceId: 'aspub_' + 'b'.repeat(24) }],
  ['public id in private namespace', { resourceId: 'aspub_' + 'b'.repeat(24) }],
])('fails closed for %s instead of resolving another audience', async (_label, changed) => {
  const value = fixture(); render(<PreparedSnapshotResult {...value.props} {...changed} />);
  expect(screen.getByRole('alert')).toHaveTextContent('scope could not be verified');
  await act(async () => {}); expect(readSnapshotPreparationView).not.toHaveBeenCalled(); expect(URL.createObjectURL).not.toHaveBeenCalled();
});

it.each(['audience', 'transport', 'snapshot'])('aborts a held response after a %s change even when the retained descriptor is identical', async change => {
  const value = fixture(), completion = deferred(), replacement = deferred(), readView = vi.fn().mockReturnValue(replacement.promise);
  readSnapshotPreparationView.mockReturnValue(completion.promise);
  const view = render(<PreparedSnapshotResult {...value.props} />); await waitFor(() => expect(readSnapshotPreparationView).toHaveBeenCalledOnce());
  const signal = readSnapshotPreparationView.mock.calls[0][4].signal;
  const changed = change === 'audience' ? { audience: 'project-publication', resourceId: 'aspub_' + 'b'.repeat(24), readView }
    : change === 'transport' ? { readView } : { snapshotSha256: 'b'.repeat(64) };
  if (change === 'snapshot') readSnapshotPreparationView.mockReturnValue(replacement.promise);
  view.rerender(<PreparedSnapshotResult {...value.props} {...changed} />); expect(signal.aborted).toBe(true);
  await act(async () => completion.resolve(value)); expect(screen.queryByRole('table')).not.toBeInTheDocument();
  await act(async () => replacement.resolve(value)); expect(await screen.findByRole('table')).toBeVisible();
});

it('revokes the displayed private raster before inspecting the same descriptor through a public capability', async () => {
  const value = fixture({ image: true }), completion = deferred(), readView = vi.fn().mockReturnValue(completion.promise);
  readSnapshotPreparationView.mockResolvedValue(value); const view = render(<PreparedSnapshotResult {...value.props} />); await screen.findByRole('img');
  view.rerender(<PreparedSnapshotResult {...value.props} audience="project-publication" resourceId={'aspub_' + 'b'.repeat(24)} readView={readView} />);
  expect(screen.queryByRole('img')).not.toBeInTheDocument(); expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:retained-1');
  await act(async () => completion.resolve(value)); expect(await screen.findByRole('img')).toHaveAttribute('src', 'blob:retained-2');
  expect(readSnapshotPreparationView).toHaveBeenCalledOnce();
});

it.each([
  [404, 'ANALYSIS_SNAPSHOT_PUBLICATION_NOT_FOUND', false, true], [409, 'ANALYSIS_SNAPSHOT_PUBLICATION_WITHDRAWN', false, true],
  [404, 'ANALYSIS_SNAPSHOT_SCOPE_NOT_FOUND', true, false], [403, 'FORBIDDEN', true, false],
  [403, 'ANALYSIS_SNAPSHOT_WITHDRAW_REQUIRED', false, false], [403, 'ANALYSIS_SNAPSHOT_SOURCE_READ_REQUIRED', false, true],
  [0, 'INVALID_SNAPSHOT_PUBLICATION_RESPONSE', false, true],
])('classifies public retained %s/%s independently from global scope', async (status, code, revokes, missing) => {
  const value = fixture(), failure = Object.assign(new Error('private server path'), { status, code }), readView = vi.fn().mockRejectedValue(failure);
  render(<PreparedSnapshotResult {...value.props} audience="project-publication" resourceId={'aspub_' + 'b'.repeat(24)} readView={readView} />);
  await screen.findByRole('alert');
  expect(value.props.onDenied).toHaveBeenCalledTimes(revokes ? 1 : 0); expect(value.props.onUnavailable).toHaveBeenCalledTimes(missing ? 1 : 0);
  expect(screen.queryByText('private server path')).not.toBeInTheDocument(); expect(readSnapshotPreparationView).not.toHaveBeenCalled();
});

it('does not offer raw view retry or reload after a withdrawn observation and an equal earlier active descriptor refresh', async () => {
  const value = fixture(), readView = vi.fn().mockRejectedValue(Object.assign(new Error('withdrawn'), { status: 409, code: 'ANALYSIS_SNAPSHOT_PUBLICATION_WITHDRAWN' }));
  const props = { ...value.props, audience: 'project-publication', resourceId: 'aspub_' + 'b'.repeat(24), readView };
  const view = render(<PreparedSnapshotResult {...props} />); await screen.findByRole('alert');
  expect(screen.queryByRole('button', { name: 'Retry retained view' })).not.toBeInTheDocument();
  view.rerender(<PreparedSnapshotResult {...props} descriptor={structuredClone(props.descriptor)} />);
  await act(async () => {}); expect(readView).toHaveBeenCalledOnce(); expect(screen.queryByRole('table')).not.toBeInTheDocument();
  const replacement = vi.fn().mockResolvedValue(value); view.rerender(<PreparedSnapshotResult {...props} readView={replacement} />);
  await act(async () => {}); expect(replacement).not.toHaveBeenCalled(); expect(screen.getByRole('alert')).toHaveTextContent('has been withdrawn');
});

it('fences a held public response when returning to the private audience without treating the shared descriptor as prior authority', async () => {
  const value = fixture(), completion = deferred(), readView = vi.fn().mockReturnValue(completion.promise);
  const view = render(<PreparedSnapshotResult {...value.props} audience="project-publication" resourceId={'aspub_' + 'b'.repeat(24)} readView={readView} />);
  await waitFor(() => expect(readView).toHaveBeenCalledOnce()); const signal = readView.mock.calls[0][4].signal;
  readSnapshotPreparationView.mockRejectedValue(new Error('Private preparation unavailable.')); view.rerender(<PreparedSnapshotResult {...value.props} />);
  expect(signal.aborted).toBe(true); await act(async () => completion.resolve(value)); expect(screen.queryByRole('table')).not.toBeInTheDocument();
  expect(readSnapshotPreparationView).toHaveBeenCalledOnce();
});
