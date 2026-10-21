import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import RetainedArtifactView, { RetainedResultContent } from './RetainedArtifactView';
import { getArtifactVersion, previewArtifactVersion } from '../artifacts/artifactApi';
import { fetchRetainedArtifactImage } from '../artifacts/retainedArtifactApi';
import useExecutionTarget from '../runtime/useExecutionTarget';

vi.mock('../artifacts/artifactApi', () => ({ getArtifactVersion: vi.fn(), previewArtifactVersion: vi.fn() }));
vi.mock('../artifacts/retainedArtifactApi', () => ({ fetchRetainedArtifactImage: vi.fn() }));
vi.mock('../runtime/useExecutionTarget', () => ({ default: vi.fn() }));
vi.mock('./Plot', () => ({ default: ({ data, layout }) => <pre data-testid="retained-plot">{JSON.stringify({ data, layout })}</pre>, getPlotHoverStyle: () => ({}) }));
const versionId = 'av_' + '1'.repeat(24), secondId = 'av_' + '2'.repeat(24), sha256 = 'a'.repeat(64);
const reference = { kind: 'artifact-version', versionId, sha256 };
const metadata = (id = versionId, projectId = 'project') => ({
  versionId: id, projectId, name: id === versionId ? 'Donor scores' : 'Other result', sha256,
  format: { id: 'org.ietf.csv', version: '1' }, previews: ['table'], sizeBytes: 50,
  owner: { displayName: 'Private source owner' }, versionNumber: 1,
});
const table = { family: 'table', columns: ['gene', 'score'], rows: [['Gene1', '2']], offset: 0, limit: 25, hasMore: true, truncated: true };
const result = (preview = table, id = versionId, projectId = 'project') => ({ version: metadata(id, projectId), integrityVerified: true, preview });
const props = { projectId: 'project', userId: 1, reference };
const connection = { identity: 'service-a', epoch: 1, blocked: false };
beforeEach(() => {
  vi.clearAllMocks();
  useExecutionTarget.mockReturnValue(connection);
  getArtifactVersion.mockImplementation(async (project, id) => metadata(id, project));
  previewArtifactVersion.mockImplementation(async (project, id, options) => result({ ...table, offset: options.offset, limit: options.limit }, id, project));
  vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:verified-image'), revokeObjectURL: vi.fn() });
});
afterEach(() => vi.unstubAllGlobals());

it('loads only the requested exact version, verifies response evidence, and requests bounded pages', async () => {
  render(<RetainedArtifactView {...props} />);
  expect(await screen.findByRole('columnheader', { name: 'gene' })).toBeVisible();
  expect(screen.getByText('Saved checksum verified · preview from this exact version')).toBeVisible();
  expect(screen.getByText(/Showing part of the table/)).toBeVisible();
  expect(getArtifactVersion).toHaveBeenCalledWith('project', versionId, expect.any(AbortSignal));
  fireEvent.click(screen.getByRole('button', { name: 'Next rows' }));
  await waitFor(() => expect(previewArtifactVersion).toHaveBeenLastCalledWith('project', versionId, expect.objectContaining({ offset: 25, limit: 25 })));
  await screen.findByText('Rows 26–26');
  fireEvent.change(screen.getByRole('combobox', { name: 'Rows per page' }), { target: { value: '10' } });
  await waitFor(() => expect(previewArtifactVersion).toHaveBeenLastCalledWith('project', versionId, expect.objectContaining({ offset: 0, limit: 10 })));
  expect(screen.queryByLabelText('Artifact file')).not.toBeInTheDocument();
});

it('rejects mismatched metadata before requesting bytes and rejects a mismatched preview version', async () => {
  getArtifactVersion.mockResolvedValueOnce({ ...metadata(), sha256: 'b'.repeat(64) });
  const view = render(<RetainedArtifactView {...props} />);
  expect(await screen.findByRole('alert')).toHaveTextContent('could not be verified');
  expect(previewArtifactVersion).not.toHaveBeenCalled();
  expect(screen.queryByText('Private source owner')).not.toBeInTheDocument();
  previewArtifactVersion.mockResolvedValueOnce(result(table, secondId));
  view.rerender(<RetainedArtifactView {...props} userId={2} />);
  expect(await screen.findByRole('alert')).toHaveTextContent('could not be verified');
  expect(screen.queryByRole('table')).not.toBeInTheDocument();
  expect(screen.queryByText(/Saved checksum verified/)).not.toBeInTheDocument();
});

it('requires affirmative integrity evidence rather than treating any successful JSON response as verified', async () => {
  previewArtifactVersion.mockResolvedValueOnce({ ...result(), integrityVerified: false });
  render(<RetainedArtifactView {...props} />);
  expect(await screen.findByRole('alert')).toHaveTextContent('could not be verified');
  expect(screen.queryByRole('table')).not.toBeInTheDocument();
});

it('shows authorized opaque metadata without reading or hashing a full analysis object', async () => {
  const checkpointId = 'art_' + '3'.repeat(24);
  getArtifactVersion.mockResolvedValueOnce({ ...metadata(checkpointId), name: 'Saved checkpoint', previews: [], format: { id: 'org.r-project.rds', version: '1' } });
  render(<RetainedArtifactView {...props} reference={{ kind: 'analysis-object', analysisObjectId: 'ao_' + '4'.repeat(24), checkpointVersionId: checkpointId, sha256 }} />);
  expect(await screen.findByText(/contents have not been read or verified/)).toBeVisible();
  expect(previewArtifactVersion).not.toHaveBeenCalled();
  expect(fetchRetainedArtifactImage).not.toHaveBeenCalled();
  expect(screen.queryByText(/Saved checksum verified/)).not.toBeInTheDocument();
});

it('distinguishes a verified but unrenderable saved table from metadata whose bytes were not inspected', async () => {
  previewArtifactVersion.mockResolvedValueOnce(result({ family: 'metadata', message: 'The complete table exceeds the browser preview budget.' }));
  render(<RetainedArtifactView {...props} />);
  expect(await screen.findByText(/checksum matches this version, but no browser preview/)).toBeVisible();
  expect(screen.getByText(/Saved checksum verified/)).toBeVisible();
  expect(screen.queryByText(/contents have not been read or verified/)).not.toBeInTheDocument();
});

it.each([401, 403, 404])('clears source details and rendered bytes when access fails with %s', async status => {
  previewArtifactVersion.mockRejectedValueOnce(Object.assign(new Error('Private host path must never be shown'), { status }));
  render(<RetainedArtifactView {...props} />);
  expect(await screen.findByRole('alert')).toHaveTextContent(/access is restricted/);
  expect(screen.queryByText('Private source owner')).not.toBeInTheDocument();
  expect(screen.queryByText(/Private host path/)).not.toBeInTheDocument();
  expect(screen.queryByRole('table')).not.toBeInTheDocument();
});

it('fences an old read after project, user, reference or target epoch changes even if abort is ignored', async () => {
  let finish;
  getArtifactVersion.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const view = render(<RetainedArtifactView {...props} />);
  const signal = getArtifactVersion.mock.calls[0][2];
  useExecutionTarget.mockReturnValue({ ...connection, identity: 'service-b', epoch: 2 });
  view.rerender(<RetainedArtifactView {...props} projectId="other-project" userId={2} reference={{ ...reference, versionId: secondId }} />);
  expect(signal.aborted).toBe(true);
  expect(await screen.findByRole('heading', { name: 'Other result · v1' })).toBeVisible();
  await act(async () => finish(metadata()));
  expect(screen.queryByRole('heading', { name: 'Donor scores · v1' })).not.toBeInTheDocument();
  expect(previewArtifactVersion).not.toHaveBeenCalledWith('project', versionId, expect.anything());
});

it('immediately removes already displayed source metadata when the target becomes unavailable', async () => {
  const view = render(<RetainedArtifactView {...props} />);
  await screen.findByRole('table');
  useExecutionTarget.mockReturnValue({ ...connection, blocked: true, epoch: 2 });
  view.rerender(<RetainedArtifactView {...props} />);
  expect(screen.queryByText('Private source owner')).not.toBeInTheDocument();
  expect(screen.queryByRole('table')).not.toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent('No analysis runtime is started');
});

it('discards a late preview body after a different exact version has already loaded', async () => {
  let finish;
  previewArtifactVersion.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const view = render(<RetainedArtifactView {...props} />);
  await waitFor(() => expect(previewArtifactVersion).toHaveBeenCalledOnce());
  const oldSignal = previewArtifactVersion.mock.calls[0][2].signal;
  view.rerender(<RetainedArtifactView {...props} reference={{ ...reference, versionId: secondId }} />);
  await screen.findByRole('columnheader', { name: 'gene' });
  expect(oldSignal.aborted).toBe(true);
  await act(async () => finish(result({ family: 'text', text: 'Private obsolete contents' })));
  expect(screen.queryByText('Private obsolete contents')).not.toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Other result · v1' })).toBeVisible();
});

it('keeps an exact view stable when its parent rerenders an equivalent reference', async () => {
  const view = render(<RetainedArtifactView {...props} />);
  await screen.findByRole('table');
  view.rerender(<RetainedArtifactView {...props} reference={{ ...reference }} compact />);
  expect(getArtifactVersion).toHaveBeenCalledTimes(1);
  expect(screen.getByText('Saved version details')).toBeVisible();
});

it('renders saved text inertly and provides an honest unknown-format fallback', async () => {
  previewArtifactVersion.mockResolvedValueOnce(result({ family: 'text', text: '<script>window.execute = true</script>', truncated: true }));
  const view = render(<RetainedArtifactView {...props} />);
  expect(await screen.findByText('<script>window.execute = true</script>')).toBeVisible();
  expect(document.querySelector('script')).toBeNull();
  view.unmount();
  render(<RetainedResultContent preview={{ family: 'future-embedding' }} />);
  expect(screen.getByText(/no supported browser renderer/)).toBeVisible();
});

it('loads images through a fenced digest-verifying helper and releases their object URLs', async () => {
  previewArtifactVersion.mockResolvedValue(result({ family: 'image', width: 1, height: 1 }));
  fetchRetainedArtifactImage.mockResolvedValue(new Blob(['png'], { type: 'image/png' }));
  const view = render(<RetainedArtifactView {...props} />);
  const image = await screen.findByRole('img');
  expect(image).toHaveAttribute('src', 'blob:verified-image');
  expect(screen.getByRole('link', { name: 'Open full-size image' })).toHaveAttribute('href', 'blob:verified-image');
  expect(screen.getByRole('link', { name: 'Open full-size image' })).toHaveAttribute('target', '_blank');
  expect(screen.getByRole('link', { name: 'Open full-size image' })).toHaveAttribute('rel', 'noopener noreferrer');
  expect(fetchRetainedArtifactImage).toHaveBeenCalledWith('project', versionId, sha256, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  fireEvent.error(image);
  expect(screen.getByRole('alert')).toHaveTextContent('integrity check failed');
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:verified-image');
  expect(screen.queryByRole('img')).not.toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'Open full-size image' })).not.toBeInTheDocument();
  view.unmount();
});

it('does not expose a late image after identity changes', async () => {
  let finish;
  previewArtifactVersion.mockResolvedValue(result({ family: 'image', width: 1, height: 1 }));
  fetchRetainedArtifactImage.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const view = render(<RetainedArtifactView {...props} />);
  await waitFor(() => expect(fetchRetainedArtifactImage).toHaveBeenCalledOnce());
  getArtifactVersion.mockRejectedValueOnce(Object.assign(new Error('No access'), { status: 403 }));
  view.rerender(<RetainedArtifactView {...props} userId={2} />);
  await act(async () => finish(new Blob(['old image'])));
  expect(URL.createObjectURL).not.toHaveBeenCalled();
  expect(screen.queryByRole('img')).not.toBeInTheDocument();
});

it('revokes an already rendered image as soon as its target disconnects', async () => {
  previewArtifactVersion.mockResolvedValue(result({ family: 'image', width: 1, height: 1 }));
  fetchRetainedArtifactImage.mockResolvedValue(new Blob(['png'], { type: 'image/png' }));
  const view = render(<RetainedArtifactView {...props} />);
  await screen.findByRole('img');
  useExecutionTarget.mockReturnValue({ ...connection, epoch: 2, blocked: true });
  view.rerender(<RetainedArtifactView {...props} />);
  expect(screen.queryByRole('img')).not.toBeInTheDocument();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:verified-image');
});

it('rejects unsupported pointers without making reads and delegates optional inspection explicitly', async () => {
  const onInspect = vi.fn();
  const view = render(<RetainedArtifactView {...props} reference={{ kind: 'path', path: '/private' }} />);
  expect(screen.getByRole('alert')).toHaveTextContent('saved result with a version and checksum');
  expect(getArtifactVersion).not.toHaveBeenCalled();
  view.rerender(<RetainedArtifactView {...props} onInspect={onInspect} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Inspect result' }));
  expect(onInspect).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'project', reference }));
});

const typedMetadata = family => ({ ...metadata(), artifactId: 'af_source', previews: [family] });
const typedSource = { artifactId: 'af_source', versionId, projectId: 'project', sha256 };
it('displays declared roles, titles and metric units as inert text while keeping absent meaning absent', async () => {
  const version = typedMetadata('metrics');
  const preview = { family: 'metrics', source: typedSource, semantics: { role: 'diagnostic', title: '<script>QC summary</script>' },
    items: [{ key: 'cells', value: 12, label: 'Retained cells', unit: 'cells' }] };
  getArtifactVersion.mockResolvedValue(version); previewArtifactVersion.mockResolvedValue({ version, integrityVerified: true, preview });
  render(<RetainedArtifactView {...props} />);
  expect(await screen.findByText('Diagnostic')).toBeVisible();
  expect(screen.getByRole('heading', { name: '<script>QC summary</script>' })).toBeVisible();
  expect(screen.getByText('Retained cells (cells)')).toBeVisible(); expect(document.querySelector('script')).toBeNull();
});

it('binds common figure semantics to the exact source before exposing the declared meaning', async () => {
  const version = { ...typedMetadata('image'), format: { id: 'org.w3.png', version: '1' } };
  getArtifactVersion.mockResolvedValue(version);
  previewArtifactVersion.mockResolvedValue({ version, integrityVerified: true, preview: { family: 'image', width: 1, height: 1,
    source: { ...typedSource, versionId: secondId }, semantics: { role: 'primary', title: 'Wrong figure meaning' } } });
  render(<RetainedArtifactView {...props} />);
  expect(await screen.findByRole('alert')).toHaveTextContent('could not be verified');
  expect(screen.queryByText('Wrong figure meaning')).not.toBeInTheDocument(); expect(fetchRetainedArtifactImage).not.toHaveBeenCalled();
});
it('renders finite scalar values without losing zero, false or inert text and rejects a mismatched typed source', async () => {
  const version = typedMetadata('metrics');
  const preview = { family: 'metrics', source: typedSource, semantics: { role: null, title: null }, items: [
    { key: 'zero', value: 0, label: null, unit: null }, { key: 'flag', value: false, label: null, unit: null },
    { key: 'note', value: '<img onerror="attack()">', label: null, unit: null }, { key: 'missing', value: null, label: null, unit: null },
  ] };
  getArtifactVersion.mockResolvedValue(version);
  previewArtifactVersion.mockResolvedValue({ version, integrityVerified: true, preview });
  const view = render(<RetainedArtifactView {...props} />);
  expect(await screen.findByText('false')).toBeVisible(); expect(screen.getByText('0')).toBeVisible();
  expect(screen.getByText('Not recorded')).toBeVisible(); expect(screen.getByText('<img onerror="attack()">')).toBeVisible();
  expect(screen.queryByRole('img')).not.toBeInTheDocument();
  previewArtifactVersion.mockResolvedValue({ version, integrityVerified: true, preview: { ...preview, source: { ...typedSource, sha256: 'b'.repeat(64) } } });
  view.rerender(<RetainedArtifactView {...props} userId={2} />);
  expect(await screen.findByRole('alert')).toHaveTextContent('could not be verified');
  expect(screen.queryByText('false')).not.toBeInTheDocument();
});

it('requests bounded deterministic embedding projections and changes limits without running analysis', async () => {
  const version = typedMetadata('embedding');
  const preview = { family: 'embedding', source: typedSource, semantics: { role: null, title: null, entityType: null, axes: { x: { label: null, unit: null }, y: { label: null, unit: null } } },
    x: [1, 2], y: [3, 4], ids: null, sourceIndices: [7, 9], identity: { kind: 'source-row-positions', scope: 'exact-source-version', indexBase: 0 },
    sampling: { method: 'sha256-priority-v1', sourceCount: 10000, returnedCount: 2, requestedLimit: 2000, sampled: true, aggregated: false, stratified: false, budgetLimited: true } };
  getArtifactVersion.mockResolvedValue(version);
  previewArtifactVersion.mockImplementation(async (project, id, options) => ({ version, integrityVerified: true, preview: { ...preview, sampling: { ...preview.sampling, requestedLimit: options.pointLimit } } }));
  render(<RetainedArtifactView {...props} />);
  expect(await screen.findByText('Showing 2 of 10,000 source points.')).toBeVisible();
  expect(screen.getByText(/not cell identifiers/)).toBeVisible();
  expect(screen.getByTestId('retained-plot')).toHaveTextContent('Source row 7 (zero-based)');
  fireEvent.change(screen.getByRole('combobox', { name: 'Maximum points' }), { target: { value: '500' } });
  await waitFor(() => expect(previewArtifactVersion).toHaveBeenLastCalledWith('project', versionId, expect.objectContaining({ pointLimit: 500 })));
  expect(await screen.findByText('Showing 2 of 10,000 source points.')).toBeVisible();
});
