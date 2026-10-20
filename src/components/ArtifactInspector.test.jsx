import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import ArtifactInspector from './ArtifactInspector';
import { getArtifactVersion, importArtifactVersion, listArtifactVersions, previewArtifactVersion } from '../artifacts/artifactApi';
import { fetchRetainedArtifactImage } from '../artifacts/retainedArtifactApi';

vi.mock('../artifacts/artifactApi', () => ({
  artifactImageUrl: (project, version) => `/api/artifact-versions/${project}/${version}/image`,
  getArtifactVersion: vi.fn(), importArtifactVersion: vi.fn(), listArtifactVersions: vi.fn(), previewArtifactVersion: vi.fn(),
}));
vi.mock('../artifacts/retainedArtifactApi', () => ({ fetchRetainedArtifactImage: vi.fn() }));
const version = {
  artifactId: 'af_table', versionId: 'av_111111111111111111111111', projectId: 'project', type: 'table', ownerId: '1',
  name: 'Gene scores', versionNumber: 1, sizeBytes: 40, format: { id: 'org.ietf.csv', version: '1' },
  owner: { displayName: 'Researcher' }, sourceRunId: null, sha256: 'a'.repeat(64), previews: ['table'], canReplace: true,
  reference: { artifactId: 'af_table', versionId: 'av_111111111111111111111111', projectId: 'project', sha256: 'a'.repeat(64) },
};
const table = { version, integrityVerified: true, preview: { family: 'table', columns: ['gene', 'score'], rows: [['A', '1']], offset: 0, limit: 25, hasMore: true } };
beforeEach(() => {
  vi.clearAllMocks();
  listArtifactVersions.mockResolvedValue({ items: [version], nextCursor: null });
  getArtifactVersion.mockImplementation(async (_project, id) => ({ ...version, versionId: id }));
  previewArtifactVersion.mockResolvedValue(table);
});
const props = { projectId: 'project', canWrite: true, userId: 1 };
const select = async () => fireEvent.click(await screen.findByRole('button', { name: /Gene scores · v1/ }));

it('inspects authoritative exact metadata before requesting bounded table pages', async () => {
  render(<ArtifactInspector {...props} />); await select();
  expect(await screen.findByRole('columnheader', { name: 'gene' })).toBeVisible();
  expect(screen.getByText('Researcher')).toBeVisible(); expect(screen.getByText('org.ietf.csv · 1')).toBeVisible();
  expect(screen.getByText('Saved checksum verified · preview from this exact version')).toBeVisible();
  expect(getArtifactVersion).toHaveBeenCalledWith('project', 'av_111111111111111111111111', expect.any(AbortSignal));
  expect(previewArtifactVersion).toHaveBeenLastCalledWith('project', 'av_111111111111111111111111', expect.objectContaining({ offset: 0, limit: 25 }));
  fireEvent.click(screen.getByRole('button', { name: 'Next rows' }));
  await waitFor(() => expect(previewArtifactVersion).toHaveBeenLastCalledWith('project', 'av_111111111111111111111111', expect.objectContaining({ offset: 25, limit: 25 })));
});

it('creates a replacement with the prior immutable version reference and retains both list entries', async () => {
  const next = { ...version, versionId: 'av_222222222222222222222222', versionNumber: 2, reference: { ...version.reference, versionId: 'av_222222222222222222222222' } };
  importArtifactVersion.mockResolvedValue(next);
  render(<ArtifactInspector {...props} />); await select();
  await screen.findByRole('columnheader', { name: 'gene' });
  listArtifactVersions.mockResolvedValue({ items: [next, version], nextCursor: null });
  getArtifactVersion.mockResolvedValue(next);
  previewArtifactVersion.mockResolvedValue({ ...table, version: next });
  fireEvent.change(screen.getByLabelText('Artifact file'), { target: { files: [new File(['gene,score\nA,2'], 'scores.csv')] } });
  fireEvent.click(screen.getByLabelText('New version of selected artifact'));
  fireEvent.click(screen.getByRole('button', { name: 'Save new artifact version' }));
  await screen.findByRole('button', { name: /Gene scores · v2/ });
  await screen.findByRole('columnheader', { name: 'gene' });
  expect(screen.getByRole('button', { name: /Gene scores · v1/ })).toBeVisible();
  expect(importArtifactVersion).toHaveBeenCalledWith('project', expect.objectContaining({ previousVersionId: 'av_111111111111111111111111', file: expect.any(File) }));
});

it('does not expose a preview after checksum failure and clears private details when access is revoked', async () => {
  previewArtifactVersion.mockRejectedValueOnce(Object.assign(new Error('Saved artifact integrity check failed.'), { status: 409 }));
  render(<ArtifactInspector {...props} />); await select();
  expect(await screen.findByRole('alert')).toHaveTextContent('could not be verified');
  expect(screen.queryByRole('table')).not.toBeInTheDocument();
  listArtifactVersions.mockRejectedValueOnce(Object.assign(new Error('Project not found.'), { status: 404 }));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh artifacts' }));
  await waitFor(() => expect(screen.queryByText('Researcher')).not.toBeInTheDocument());
  expect(screen.queryByRole('button', { name: /Gene scores · v1/ })).not.toBeInTheDocument();
});

it('ignores stale inspection responses after the active project changes', async () => {
  let finish;
  getArtifactVersion.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const view = render(<ArtifactInspector {...props} />); await select();
  const signal = getArtifactVersion.mock.calls[0][2];
  listArtifactVersions.mockResolvedValueOnce({ items: [], nextCursor: null });
  view.rerender(<ArtifactInspector {...props} projectId="new-project" />);
  expect(signal.aborted).toBe(true);
  await act(async () => finish(version));
  expect(previewArtifactVersion).not.toHaveBeenCalled(); expect(screen.queryByText('Researcher')).not.toBeInTheDocument();
});

it('shows metadata-only object inspection and hides import controls for viewers', async () => {
  previewArtifactVersion.mockResolvedValue({ integrityVerified: true, preview: { family: 'metadata', message: 'Metadata only. Inspect this object in a private runtime.' } });
  const object = { ...version, type: 'object', format: { id: 'org.r-project.rds', version: '1' }, previews: [] };
  listArtifactVersions.mockResolvedValue({ items: [object], nextCursor: null }); getArtifactVersion.mockResolvedValue(object);
  render(<ArtifactInspector {...props} canWrite={false} />); await select();
  expect(await screen.findByText(/contents have not been read or verified/)).toBeVisible();
  expect(previewArtifactVersion).not.toHaveBeenCalled();
  expect(screen.queryByLabelText('Artifact file')).not.toBeInTheDocument(); expect(screen.queryByRole('img')).not.toBeInTheDocument();
});

it('renders text as inert content and delegates raster bytes to the verified image transport', async () => {
  previewArtifactVersion.mockResolvedValueOnce({ version, integrityVerified: true, preview: { family: 'text', text: '<script>window.bad = true</script>' } });
  render(<ArtifactInspector {...props} />); await select();
  expect(await screen.findByText('<script>window.bad = true</script>')).toBeVisible(); expect(document.querySelector('script')).toBeNull();
  previewArtifactVersion.mockResolvedValueOnce({ version, integrityVerified: true, preview: { family: 'image', width: 1, height: 1 } });
  fetchRetainedArtifactImage.mockResolvedValueOnce(new Blob(['png'], { type: 'image/png' }));
  const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:verified-image');
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  await select();
  const image = await screen.findByRole('img'); expect(image).toHaveAttribute('src', 'blob:verified-image');
  fireEvent.error(image);
  expect(await screen.findByRole('alert')).toHaveTextContent('integrity check failed'); expect(screen.queryByRole('img')).not.toBeInTheDocument();
  create.mockRestore(); revoke.mockRestore();
});

it('shows retained server provenance and sample descriptions without exposing host paths', async () => {
  const sourceImport = { importId: 'request', rootId: 'lab-data', rootLabel: 'Lab data', relativePath: 'study/cells.rds', serviceId: 'service', serviceLabel: 'Lab analysis server', importedAt: '2026-10-08T01:00:00Z', sampleMetadata: { sampleId: 'sample-A', condition: 'treatment', species: 'human' } };
  getArtifactVersion.mockResolvedValue({ ...version, sourceImport });
  render(<ArtifactInspector {...props} />); await select();
  fireEvent.click(await screen.findByText('Server source and sample details'));
  expect(screen.getByText('Lab data')).toBeVisible(); expect(screen.getByText('study/cells.rds')).toBeVisible();
  expect(screen.getByText('Lab analysis server')).toBeVisible();
  expect(screen.getByText('sample-A')).toBeVisible(); expect(screen.getByText('treatment')).toBeVisible();
  expect(screen.getByText('human')).toBeVisible();
});
