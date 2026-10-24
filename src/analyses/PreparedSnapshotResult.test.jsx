import React from 'react';
import { createHash, webcrypto } from 'node:crypto';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import PreparedSnapshotResult from './PreparedSnapshotResult';
import { readSnapshotPreparationView } from './snapshotPreparationApi';
import useExecutionTarget from '../runtime/useExecutionTarget';
import { getArtifactVersion, previewArtifactVersion } from '../artifacts/artifactApi';
import { fetchRetainedArtifactImage } from '../artifacts/retainedArtifactApi';
import { canonicalSnapshotJson, canonicalAnalysisSnapshotResultView } from '../../shared/analysisSnapshotPreparationDispatch.mjs';
import { snapshotScope, snapshotRecipe, snapshotRecord } from './snapshotPreparationTestFixtures';
import { linkedRecipe, linkedRecord, linkedReference, linkedTableBytes, linkedImageResult, linkedImageBytes } from './snapshotLinkedTestFixtures';
import { typedRecipe, typedRecord, typedTableBytes, typedMetricsBytes, typedImageBytes } from './snapshotTypedTestFixtures';

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
function linkedFixture({ prefix = 'art', format = 'org.ietf.csv', image = false } = {}) {
  const selected = image ? linkedImageResult({ reference: linkedReference({ versionId: prefix + '_' + '4'.repeat(24), sha256: hash(linkedImageBytes()) }) })
    : { kind: 'analysis-reference', reference: linkedReference({ versionId: prefix + '_' + '4'.repeat(24) }), caption: 'Supplied linked caption', view: { family: 'table', offset: 3, limit: 2 } };
  const record = linkedRecord(linkedRecipe({ results: [selected] })), descriptor = record.package.results[0];
  if (!image) descriptor.source.format.id = format;
  return { props: { ...snapshotScope, preparationId: record.preparationId, descriptor, available: true, isActive: true,
    onDenied: vi.fn(), onUnavailable: vi.fn() }, bytes: image ? linkedImageBytes() : linkedTableBytes(descriptor), type: image ? 'image/png' : 'application/json' };
}
function typedFixture(family = 'table') {
  const record = typedRecord(typedRecipe({ family })), descriptor = record.package.results[0];
  return { props: { ...snapshotScope, preparationId: record.preparationId, descriptor, snapshotSha256: record.snapshotSha256,
    available: true, isActive: true, onDenied: vi.fn(), onUnavailable: vi.fn() },
  bytes: family === 'image' ? typedImageBytes() : family === 'metrics' ? typedMetricsBytes(descriptor) : typedTableBytes(descriptor),
  type: family === 'image' ? 'image/png' : 'application/json' };
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

it.each(['av', 'art', 'eri'].flatMap(prefix => ['org.ietf.csv', 'org.iana.tsv'].map(format => [prefix, format])))('decodes an exact v2 %s source as %s without original source reads or mutable row controls', async (prefix, format) => {
  const value = linkedFixture({ prefix, format }); readSnapshotPreparationView.mockResolvedValue(value); render(<PreparedSnapshotResult {...value.props} />);
  expect(await screen.findByRole('cell', { name: 'donor α' })).toBeVisible(); expect(screen.getByLabelText('Fixed retained table excerpt')).toHaveTextContent('source rows 4–4');
  expect(screen.queryByRole('button', { name: 'Next rows' })).not.toBeInTheDocument(); expect(screen.queryByRole('combobox', { name: 'Rows per page' })).not.toBeInTheDocument();
  expect(getArtifactVersion).not.toHaveBeenCalled(); expect(previewArtifactVersion).not.toHaveBeenCalled(); expect(fetchRetainedArtifactImage).not.toHaveBeenCalled();
  expect(readSnapshotPreparationView.mock.calls[0][3].source).toMatchObject({ ownerUserId: 7, versionId: prefix + '_' + '4'.repeat(24) });
});

it('renders a v2 linked PNG using only publication retained bytes for a current viewer distinct from source owner', async () => {
  const value = linkedFixture({ prefix: 'eri', image: true }), readView = vi.fn().mockResolvedValue(value);
  render(<PreparedSnapshotResult {...value.props} userId={17} audience="project-publication" resourceId={'aspub_' + 'b'.repeat(24)} readView={readView} />);
  expect(await screen.findByRole('img')).toHaveAttribute('src', 'blob:retained-1'); expect(screen.getByRole('link', { name: 'Open full-size image' })).toHaveAttribute('href', 'blob:retained-1');
  expect(readView.mock.calls[0][3].source.ownerUserId).toBe(7); expect(readSnapshotPreparationView).not.toHaveBeenCalled(); expect(fetchRetainedArtifactImage).not.toHaveBeenCalled();
});

it('keeps a checked v2 descriptor stable through equal object and callback refreshes', async () => {
  const value = linkedFixture(); readSnapshotPreparationView.mockResolvedValue(value); const view = render(<PreparedSnapshotResult {...value.props} />); await screen.findByRole('table');
  view.rerender(<PreparedSnapshotResult {...value.props} descriptor={structuredClone(value.props.descriptor)} onDenied={vi.fn()} onUnavailable={vi.fn()} />);
  await act(async () => {}); expect(readSnapshotPreparationView).toHaveBeenCalledOnce(); expect(screen.getByRole('table')).toBeVisible();
});

it.each(['owner', 'origin', 'linked version', 'linked reference', 'view schema'])('fences held bytes when the v2 %s binding changes even if the blob checksum is unchanged', async changed => {
  const value = linkedFixture({ prefix: 'av' }), completion = deferred(), replacement = deferred(); readSnapshotPreparationView.mockReturnValueOnce(completion.promise).mockReturnValue(replacement.promise);
  const view = render(<PreparedSnapshotResult {...value.props} />); await waitFor(() => expect(readSnapshotPreparationView).toHaveBeenCalledOnce());
  const signal = readSnapshotPreparationView.mock.calls[0][4].signal, descriptor = structuredClone(value.props.descriptor);
  if (changed === 'owner') descriptor.source.ownerUserId = 8;
  else if (changed === 'origin') descriptor.origin = { kind: 'attachment-revision', attachment: snapshotRecord(snapshotRecipe()).package.results[0].attachment };
  else if (changed === 'linked version') descriptor.origin.analysisVersion++;
  else if (changed === 'linked reference') descriptor.origin.reference.versionId = 'av_' + 'e'.repeat(24);
  else descriptor.view.schema = 'traceomics.fixed-result-view.v1';
  view.rerender(<PreparedSnapshotResult {...value.props} descriptor={descriptor} />); expect(signal.aborted).toBe(true);
  await act(async () => completion.resolve(value)); expect(screen.queryByRole('table')).not.toBeInTheDocument(); expect(value.props.onUnavailable).not.toHaveBeenCalled();
  view.unmount(); await act(async () => replacement.resolve(value)); expect(URL.createObjectURL).not.toHaveBeenCalled();
});

it.each(['wrong checksum', 'different fixed rows'])('refuses v2 %s before displaying an unchecked scientific table', async changed => {
  const value = linkedFixture();
  if (changed === 'wrong checksum') value.bytes = new TextEncoder().encode('another source');
  else value.props.descriptor.view.spec.offset++;
  readSnapshotPreparationView.mockResolvedValue(value); render(<PreparedSnapshotResult {...value.props} />); await screen.findByRole('alert');
  expect(screen.queryByRole('table')).not.toBeInTheDocument(); expect(screen.queryByText(/checksum verified/)).not.toBeInTheDocument(); expect(value.props.onUnavailable).toHaveBeenCalledOnce();
});

it('preserves the strict v1 source boundary rather than accepting an art source without a v2 descriptor', async () => {
  const value = fixture(); value.props.descriptor.source.versionId = 'art_' + '4'.repeat(24); readSnapshotPreparationView.mockResolvedValue(value);
  render(<PreparedSnapshotResult {...value.props} />); await screen.findByRole('alert'); expect(screen.queryByRole('table')).not.toBeInTheDocument(); expect(value.props.onUnavailable).toHaveBeenCalledOnce();
});

it('decodes a fixed typed table with exact scalar values and declared meaning without reading original sources', async () => {
  const value = typedFixture(); readSnapshotPreparationView.mockResolvedValue(value); render(<PreparedSnapshotResult {...value.props} />);
  const row = (await screen.findAllByRole('row'))[1], cells = within(row).getAllByRole('cell');
  expect(cells.map(cell => cell.textContent)).toEqual(['null', 'false', 'true', '0', 'empty string', '1.25', 'null', 'donor 🧬']);
  expect(screen.getByRole('heading', { name: 'Recorded scalar table' })).toBeVisible(); expect(screen.getByText('Primary result')).toBeVisible();
  expect(within(cells[0]).getByTitle('JSON null')).toBeVisible(); expect(within(cells[6]).getByTitle('Text value')).toBeVisible();
  expect(screen.getByText('Source table: 1 row.')).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Next rows' })).not.toBeInTheDocument(); expect(URL.createObjectURL).not.toHaveBeenCalled();
  expect(getArtifactVersion).not.toHaveBeenCalled(); expect(previewArtifactVersion).not.toHaveBeenCalled(); expect(fetchRetainedArtifactImage).not.toHaveBeenCalled();
});

it('renders checked typed metrics with descriptor labels and units for a different current publication viewer', async () => {
  const value = typedFixture('metrics'), readView = vi.fn().mockResolvedValue(value), resourceId = 'aspub_' + 'b'.repeat(24);
  render(<PreparedSnapshotResult {...value.props} userId={17} audience="project-publication" resourceId={resourceId} readView={readView} />);
  expect(await screen.findByLabelText('Saved scalar metrics')).toBeVisible();
  expect(screen.getByText('Cells (cells)')).toBeVisible(); expect(screen.getByText('Coverage (%)')).toBeVisible();
  expect(screen.getByRole('heading', { name: 'Recorded QC metrics' })).toBeVisible(); expect(screen.getByText('Diagnostic')).toBeVisible();
  for (const text of ['0', '1.25', 'false']) expect(screen.getByText(text)).toBeVisible();
  expect(screen.getByTitle('JSON null')).toHaveTextContent('null'); expect(screen.getByTitle('Text with zero characters')).toHaveTextContent('empty string');
  expect(screen.queryByText('Not recorded')).not.toBeInTheDocument(); expect(readSnapshotPreparationView).not.toHaveBeenCalled();
  expect(readView).toHaveBeenCalledExactlyOnceWith(snapshotScope.projectId, snapshotScope.analysisId, resourceId, value.props.descriptor, { signal: expect.any(AbortSignal) });
});

it('keeps typed semantic PNG meaning alongside the exact retained raster and revokes it on native disconnect', async () => {
  const value = typedFixture('image'); readSnapshotPreparationView.mockResolvedValue(value);
  const view = render(<PreparedSnapshotResult {...value.props} />); await screen.findByRole('img');
  expect(screen.getByRole('heading', { name: 'Recorded measured figure' })).toBeVisible(); expect(screen.getByText('Primary result')).toBeVisible();
  expect(screen.getByRole('img')).toHaveAttribute('src', 'blob:retained-1'); expect(screen.getByRole('link', { name: 'Open full-size image' })).toHaveAttribute('href', 'blob:retained-1');
  useExecutionTarget.mockReturnValue({ ...connection, blocked: true, epoch: 2 }); view.rerender(<PreparedSnapshotResult {...value.props} />);
  expect(screen.queryByRole('img')).not.toBeInTheDocument(); expect(screen.queryByRole('heading', { name: 'Recorded measured figure' })).not.toBeInTheDocument();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:retained-1'); expect(fetchRetainedArtifactImage).not.toHaveBeenCalled();
});

it.each(['descriptor hash', 'meaning title', 'metric unit', 'source name'])('fences held typed metrics when %s changes under an unchanged retained byte hash', async change => {
  const value = typedFixture('metrics'), held = deferred(), replacement = deferred(); readSnapshotPreparationView.mockReturnValueOnce(held.promise).mockReturnValue(replacement.promise);
  const view = render(<PreparedSnapshotResult {...value.props} />); await waitFor(() => expect(readSnapshotPreparationView).toHaveBeenCalledOnce());
  const signal = readSnapshotPreparationView.mock.calls[0][4].signal, descriptor = structuredClone(value.props.descriptor);
  if (change === 'descriptor hash') descriptor.view.descriptorSha256 = 'e'.repeat(64);
  else if (change === 'meaning title') descriptor.view.semantics.title = 'Different recorded meaning';
  else if (change === 'metric unit') descriptor.view.semantics.metrics.coverage.unit = 'reads';
  else descriptor.source.name = 'Different exact recorded name';
  view.rerender(<PreparedSnapshotResult {...value.props} descriptor={descriptor} />); expect(signal.aborted).toBe(true);
  await act(async () => held.resolve(value)); expect(screen.queryByLabelText('Saved scalar metrics')).not.toBeInTheDocument();
  expect(value.props.onUnavailable).not.toHaveBeenCalled(); view.unmount(); await act(async () => replacement.resolve(value));
  expect(URL.createObjectURL).not.toHaveBeenCalled();
});

it('does not refetch typed metrics when immutable scope, descriptor and semantics are unchanged after recovery', async () => {
  const value = typedFixture('metrics'); readSnapshotPreparationView.mockResolvedValue(value);
  const view = render(<PreparedSnapshotResult {...value.props} />); await screen.findByLabelText('Saved scalar metrics');
  view.rerender(<PreparedSnapshotResult {...value.props} descriptor={structuredClone(value.props.descriptor)} onUnavailable={vi.fn()} onDenied={vi.fn()} />);
  await act(async () => {}); expect(readSnapshotPreparationView).toHaveBeenCalledOnce(); expect(screen.getByText('Coverage (%)')).toBeVisible();
});

it.each(['unit override', 'label override', 'source mismatch'])('rejects typed metrics %s even when the retained body checksum has been resealed', async change => {
  const value = typedFixture('metrics'), body = JSON.parse(new TextDecoder().decode(value.bytes));
  if (change === 'unit override') body.items[0].unit = 'reads';
  else if (change === 'label override') body.items[0].label = 'Fabricated biological conclusion';
  else body.source.sha256 = 'd'.repeat(64);
  value.bytes = new TextEncoder().encode(canonicalSnapshotJson(body)); value.props.descriptor.view.blobSha256 = hash(value.bytes); value.props.descriptor.view.blobBytes = value.bytes.length;
  const { viewSha256: previousHash, ...view } = value.props.descriptor.view; void previousHash;
  value.props.descriptor.view.viewSha256 = hash(canonicalAnalysisSnapshotResultView({ ...view,
    source: { artifactId: value.props.descriptor.source.artifactId, versionId: value.props.descriptor.source.versionId,
      projectId: snapshotScope.projectId, sha256: value.props.descriptor.source.sha256 } }));
  readSnapshotPreparationView.mockResolvedValue(value); render(<PreparedSnapshotResult {...value.props} />);
  expect(await screen.findByRole('alert')).toHaveTextContent('exact saved identity is kept');
  expect(screen.queryByLabelText('Saved scalar metrics')).not.toBeInTheDocument(); expect(screen.queryByText(/checksum verified/)).not.toBeInTheDocument();
  expect(value.props.onUnavailable).toHaveBeenCalledOnce(); expect(value.props.onDenied).not.toHaveBeenCalled();
});

it('keeps a withdrawn typed publication terminal rather than reloading scientific values after an equal descriptor refresh', async () => {
  const value = typedFixture('metrics'), readView = vi.fn().mockRejectedValue(Object.assign(new Error('withdrawn'), { status: 409, code: 'ANALYSIS_SNAPSHOT_PUBLICATION_WITHDRAWN' }));
  const props = { ...value.props, audience: 'project-publication', resourceId: 'aspub_' + 'b'.repeat(24), readView };
  const view = render(<PreparedSnapshotResult {...props} />); await screen.findByRole('alert');
  view.rerender(<PreparedSnapshotResult {...props} descriptor={structuredClone(props.descriptor)} />); await act(async () => {});
  expect(readView).toHaveBeenCalledOnce(); expect(screen.queryByLabelText('Saved scalar metrics')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Retry retained view' })).not.toBeInTheDocument();
});
