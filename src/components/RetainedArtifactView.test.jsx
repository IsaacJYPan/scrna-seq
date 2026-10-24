import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

it('renders only the fixed retained table window without original-source paging or extra transport', () => {
  const onPageChange = vi.fn(), onPageSizeChange = vi.fn();
  render(<RetainedResultContent preview={{ ...table, offset: 25, rows: [['Retained gene', 0], ['Other gene', false]], truncated: false }}
    fixedView pageSize={25} onPageChange={onPageChange} onPageSizeChange={onPageSizeChange} />);
  expect(screen.getByRole('cell', { name: 'Retained gene' })).toBeVisible(); expect(screen.getByRole('cell', { name: '0' })).toBeVisible();
  expect(screen.getByLabelText('Fixed retained table excerpt')).toHaveTextContent('source rows 26–27');
  expect(screen.getByText('Other source rows are outside this retained view.')).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Next rows' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Previous rows' })).not.toBeInTheDocument();
  expect(screen.queryByRole('combobox', { name: 'Rows per page' })).not.toBeInTheDocument();
  expect(onPageChange).not.toHaveBeenCalled(); expect(onPageSizeChange).not.toHaveBeenCalled();
  expect(getArtifactVersion).not.toHaveBeenCalled(); expect(previewArtifactVersion).not.toHaveBeenCalled(); expect(fetchRetainedArtifactImage).not.toHaveBeenCalled();
});

it('renders only the included literal JSON source prefix with honest byte and syntax facts', () => {
  const text = '\uFEFF{\r\n  "n":900719925474099312345,"n":2,\r\n  "script":"<script>run()</script>"', included = new TextEncoder().encode(text).length;
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  render(<RetainedResultContent fixedView fixedSourceText preview={{ family: 'text', representation: 'utf8-source-prefix', sourceFormatId: 'org.ietf.json',
    text, sourceBytes: 200, maxBytes: included + 2, includedSourceBytes: included, truncated: true, syntax: 'not-checked' }} />);
  expect(screen.getByLabelText('Saved text preview').textContent).toBe(text);
  expect(screen.getByLabelText('Saved text preview')).toHaveAttribute('tabindex', '0');
  expect(screen.getByLabelText('Fixed retained source text')).toHaveTextContent('JSON source text · syntax not checked');
  expect(screen.getByLabelText('Fixed retained source text')).toHaveTextContent(`Included ${included} of 200 source bytes.`);
  expect(screen.getByText('Only this retained source prefix is included. Omitted source bytes are not accessible here.')).toBeVisible();
  expect(screen.queryByText('Showing part of the file. The full version is saved.')).not.toBeInTheDocument();
  expect(document.querySelector('script')).toBeNull(); expect(fetch).not.toHaveBeenCalled();
  expect(getArtifactVersion).not.toHaveBeenCalled(); expect(previewArtifactVersion).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: /Run|Load more|Download/ })).not.toBeInTheDocument();
});

it('distinguishes all included text from an empty source and from a zero-character multibyte prefix', () => {
  const preview = { family: 'text', representation: 'utf8-source-prefix', sourceFormatId: 'org.ietf.text', text: 'a\t0\r\n',
    sourceBytes: 5, includedSourceBytes: 5, maxBytes: 16384, truncated: false, syntax: 'not-checked' };
  const view = render(<RetainedResultContent fixedView fixedSourceText preview={preview} />);
  expect(screen.getByLabelText('Saved text preview').textContent).toBe(preview.text);
  expect(screen.getByText('All source text is included in this retained view.')).toBeVisible();
  view.rerender(<RetainedResultContent fixedView fixedSourceText preview={{ ...preview, text: '', sourceBytes: 0, includedSourceBytes: 0 }} />);
  expect(screen.getByText('The source is empty.')).toBeVisible();
  view.rerender(<RetainedResultContent fixedView fixedSourceText preview={{ ...preview, text: '', sourceBytes: 4, includedSourceBytes: 0, maxBytes: 1, truncated: true }} />);
  expect(screen.getByText('No complete UTF-8 character fits within the selected byte limit.')).toBeVisible();
  expect(screen.queryByText('The source is empty.')).not.toBeInTheDocument();
  expect(screen.getByLabelText('Fixed retained source text')).toHaveTextContent('Included 0 of 4 source bytes. Maximum selected: 1 byte.');
});

it.each([{}, { fixedView: true }, { fixedSourceText: true }])('preserves generic text inspection wording outside explicit fixed-source mode (%j)', flags => {
  render(<RetainedResultContent {...flags} preview={{ family: 'text', text: '<img src="https://invalid.test/no-fetch">', truncated: true }} />);
  expect(screen.getByText('Showing part of the file. The full version is saved.')).toBeVisible();
  expect(screen.queryByLabelText('Fixed retained source text')).not.toBeInTheDocument(); expect(document.querySelector('img')).toBeNull();
});

it('discloses bounded scans honestly and never invents row numbers for an empty retained window', () => {
  const view = render(<RetainedResultContent fixedView preview={{ ...table, offset: 100, rows: [], hasMore: false, truncated: true }} />);
  expect(screen.getByText('Fixed retained excerpt · no rows are included from the selected source window.')).toBeVisible();
  expect(screen.getByText('Source inspection reached its scan limit; the complete source row count is unknown.')).toBeVisible();
  expect(screen.queryByText(/source rows 101–100/)).not.toBeInTheDocument(); expect(screen.queryByText(/More rows are saved/)).not.toBeInTheDocument();
  view.rerender(<RetainedResultContent fixedView preview={{ ...table, hasMore: false, truncated: false }} />);
  expect(screen.getByLabelText('Fixed retained table excerpt')).toHaveTextContent('source rows 1–1');
  expect(screen.queryByText('Other source rows are outside this retained view.')).not.toBeInTheDocument();
  expect(screen.queryByText(/complete source row count is unknown/)).not.toBeInTheDocument();
});

it('preserves every fixed typed scalar without confusing null, false, zero and empty text', () => {
  const preview = { ...table, scalarModel: 'finite-ieee754-safe-integers.v1', totalRows: 2,
    columns: ['null value', 'boolean', 'count', 'text', 'fraction', 'literal null'],
    rows: [[null, false, 0, '', 0.125, 'null'], ['<img onerror="attack()">', true, 42, 'β\nγ', 1.5, 'empty string']],
    hasMore: false, truncated: false };
  render(<RetainedResultContent fixedView preview={preview} />);
  const rows = screen.getAllByRole('row').slice(1), cells = within(rows[0]).getAllByRole('cell');
  expect(cells.map(cell => cell.textContent)).toEqual(['null', 'false', '0', 'empty string', '0.125', 'null']);
  expect(within(cells[0]).getByTitle('JSON null')).toBeVisible();
  expect(within(cells[3]).getByTitle('Text with zero characters')).toBeVisible();
  expect(within(cells[5]).getByTitle('Text value')).toBeVisible();
  expect(within(rows[1]).getByRole('cell', { name: 'true' })).toBeVisible();
  expect(screen.getByText('<img onerror="attack()">')).toBeVisible(); expect(screen.queryByRole('img')).not.toBeInTheDocument();
  expect(screen.getByText('Source table: 2 rows.')).toBeVisible();
  expect(screen.getByText('Null values and empty strings are marked explicitly.')).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Next rows' })).not.toBeInTheDocument(); expect(previewArtifactVersion).not.toHaveBeenCalled();
});

it('renders a genuinely empty fixed typed source without inventing a column or row', () => {
  render(<RetainedResultContent fixedView preview={{ ...table, columns: [], rows: [], scalarModel: 'finite-ieee754-safe-integers.v1',
    totalRows: 0, hasMore: false, truncated: false }} />);
  expect(screen.queryByRole('cell')).not.toBeInTheDocument(); expect(screen.queryByRole('columnheader')).not.toBeInTheDocument();
  expect(screen.getByText('Source table: 0 rows.')).toBeVisible();
  expect(screen.getByText('Fixed retained excerpt · no rows are included from the selected source window.')).toBeVisible();
});

it.each([undefined, 'unknown-model'])('keeps historical generic table literals outside the exact typed scalar model (%s)', scalarModel => {
  render(<RetainedResultContent fixedView typedScalars preview={{ ...table, columns: ['a', 'b', 'c'], rows: [[false, null, '']], scalarModel, totalRows: 1 }} />);
  expect(screen.getAllByRole('cell').map(cell => cell.textContent)).toEqual(['', '', '']);
  expect(screen.queryByText('Null values and empty strings are marked explicitly.')).not.toBeInTheDocument();
});

it('marks scalar metrics only in explicitly checked fixed typed mode while preserving labels and units', () => {
  const preview = { family: 'metrics', semantics: { role: 'diagnostic', title: 'QC overview' }, items: [
    { key: 'count', value: 0, label: 'Cells retained', unit: 'cells' }, { key: 'accepted', value: false, label: null, unit: null },
    { key: 'missing', value: null, label: null, unit: null }, { key: 'empty', value: '', label: null, unit: null },
  ] };
  const view = render(<RetainedResultContent fixedView typedScalars preview={preview} />);
  expect(screen.getByRole('heading', { name: 'QC overview' })).toBeVisible(); expect(screen.getByText('Diagnostic')).toBeVisible();
  expect(screen.getByText('Cells retained (cells)')).toBeVisible(); expect(screen.getByText('0')).toBeVisible(); expect(screen.getByText('false')).toBeVisible();
  expect(screen.getByTitle('JSON null')).toHaveTextContent('null'); expect(screen.getByTitle('Text with zero characters')).toHaveTextContent('empty string');
  view.rerender(<RetainedResultContent fixedView preview={preview} />);
  expect(screen.getByText('Not recorded')).toBeVisible(); expect(screen.queryByText('empty string')).not.toBeInTheDocument();
  view.rerender(<RetainedResultContent typedScalars preview={preview} />);
  expect(screen.getByText('Not recorded')).toBeVisible(); expect(screen.queryByTitle('JSON null')).not.toBeInTheDocument();
  expect(previewArtifactVersion).not.toHaveBeenCalled(); expect(fetchRetainedArtifactImage).not.toHaveBeenCalled();
});

it('keeps legacy source paging by default and enables its callbacks only outside fixed mode', () => {
  const onPageChange = vi.fn(), onPageSizeChange = vi.fn();
  const view = render(<RetainedResultContent preview={table} pageSize={25} onPageChange={onPageChange} onPageSizeChange={onPageSizeChange} />);
  fireEvent.click(screen.getByRole('button', { name: 'Next rows' })); expect(onPageChange).toHaveBeenCalledExactlyOnceWith(25);
  fireEvent.change(screen.getByRole('combobox', { name: 'Rows per page' }), { target: { value: '10' } });
  expect(onPageSizeChange).toHaveBeenCalledExactlyOnceWith(10); expect(screen.queryByLabelText('Fixed retained table excerpt')).not.toBeInTheDocument();
  view.rerender(<RetainedResultContent preview={table} fixedView pageSize={25} onPageChange={onPageChange} onPageSizeChange={onPageSizeChange} />);
  expect(screen.queryByRole('button', { name: 'Next rows' })).not.toBeInTheDocument();
});

it('opens fixed raster inspection from the supplied retained image bytes without using the original artifact loader', () => {
  render(<RetainedResultContent fixedView preview={{ family: 'image', width: 40, height: 20 }} name="Reviewed figure" imageUrl="blob:reviewed-retained-image" />);
  expect(screen.getByRole('img', { name: 'Preview of Reviewed figure' })).toHaveAttribute('src', 'blob:reviewed-retained-image');
  expect(screen.getByRole('link', { name: 'Open full-size image' })).toHaveAttribute('href', 'blob:reviewed-retained-image');
  expect(getArtifactVersion).not.toHaveBeenCalled(); expect(previewArtifactVersion).not.toHaveBeenCalled(); expect(fetchRetainedArtifactImage).not.toHaveBeenCalled();
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

it('forwards fixed-view disclosure to the shared embedding renderer without providing source controls', () => {
  const preview = { family: 'embedding', source: typedSource,
    semantics: { role: 'primary', title: 'Reviewed coordinates', entityType: 'cell', axes: { x: { label: null, unit: null }, y: { label: null, unit: null } } },
    x: [1], y: [2], ids: null, sourceIndices: [7], identity: { kind: 'source-row-positions', scope: 'exact-source-version', indexBase: 0 },
    sampling: { method: 'sha256-priority-v1', sourceCount: 10, returnedCount: 1, requestedLimit: 500, sampled: true, aggregated: false, stratified: false, budgetLimited: false } };
  render(<RetainedResultContent fixedView preview={preview} />);
  expect(screen.getByRole('heading', { name: 'Reviewed coordinates' })).toBeVisible(); expect(screen.getByText('Showing 1 of 10 source points.')).toBeVisible();
  expect(screen.queryByRole('combobox', { name: 'Maximum points' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Reset plot view' })).toBeInTheDocument(); expect(screen.getByRole('button', { name: 'Export plot PNG' })).toBeInTheDocument();
  expect(previewArtifactVersion).not.toHaveBeenCalled(); expect(getArtifactVersion).not.toHaveBeenCalled();
});
