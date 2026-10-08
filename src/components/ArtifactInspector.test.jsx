import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import ArtifactInspector from './ArtifactInspector';
import { getArtifactVersion, importArtifactVersion, listArtifactVersions, previewArtifactVersion } from '../artifacts/artifactApi';

vi.mock('../artifacts/artifactApi', () => ({
  artifactImageUrl: (project, version) => `/api/artifact-versions/${project}/${version}/image`,
  getArtifactVersion: vi.fn(), importArtifactVersion: vi.fn(), listArtifactVersions: vi.fn(), previewArtifactVersion: vi.fn(),
}));
const version = {
  artifactId: 'af_table', versionId: 'av_one', projectId: 'project', type: 'table', ownerId: '1',
  name: 'Gene scores', versionNumber: 1, sizeBytes: 40, format: { id: 'org.ietf.csv', version: '1' },
  owner: { displayName: 'Researcher' }, sourceRunId: null, sha256: 'a'.repeat(64), previews: ['table'], canReplace: true,
  reference: { artifactId: 'af_table', versionId: 'av_one', projectId: 'project', sha256: 'a'.repeat(64) },
};
const table = { integrityVerified: true, preview: { family: 'table', columns: ['gene', 'score'], rows: [['A', '1']], offset: 0, limit: 25, hasMore: true } };
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
  expect(getArtifactVersion).toHaveBeenCalledWith('project', 'av_one', expect.any(AbortSignal));
  expect(previewArtifactVersion).toHaveBeenLastCalledWith('project', 'av_one', expect.objectContaining({ offset: 0, limit: 25 }));
  fireEvent.click(screen.getByRole('button', { name: 'Next rows' }));
  await waitFor(() => expect(previewArtifactVersion).toHaveBeenLastCalledWith('project', 'av_one', expect.objectContaining({ offset: 25, limit: 25 })));
});

it('creates a replacement with the prior immutable version reference and retains both list entries', async () => {
  const next = { ...version, versionId: 'av_two', versionNumber: 2, reference: { ...version.reference, versionId: 'av_two' } };
  importArtifactVersion.mockResolvedValue(next);
  render(<ArtifactInspector {...props} />); await select();
  await screen.findByRole('columnheader', { name: 'gene' });
  listArtifactVersions.mockResolvedValue({ items: [next, version], nextCursor: null });
  getArtifactVersion.mockResolvedValue(next);
  fireEvent.change(screen.getByLabelText('Artifact file'), { target: { files: [new File(['gene,score\nA,2'], 'scores.csv')] } });
  fireEvent.click(screen.getByLabelText('New version of selected artifact'));
  fireEvent.click(screen.getByRole('button', { name: 'Save new artifact version' }));
  await screen.findByRole('button', { name: /Gene scores · v2/ });
  expect(screen.getByRole('button', { name: /Gene scores · v1/ })).toBeVisible();
  expect(importArtifactVersion).toHaveBeenCalledWith('project', expect.objectContaining({ previousVersionId: 'av_one', file: expect.any(File) }));
});

it('does not expose a preview after checksum failure and clears private details when access is revoked', async () => {
  previewArtifactVersion.mockRejectedValueOnce(Object.assign(new Error('Saved artifact integrity check failed.'), { status: 409 }));
  render(<ArtifactInspector {...props} />); await select();
  expect(await screen.findByRole('alert')).toHaveTextContent('Saved artifact integrity check failed.');
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
  expect(await screen.findByText('Metadata only. Inspect this object in a private runtime.')).toBeVisible();
  expect(screen.queryByLabelText('Artifact file')).not.toBeInTheDocument(); expect(screen.queryByRole('img')).not.toBeInTheDocument();
});

it('renders text as inert content and loads raster images through their verified endpoint', async () => {
  previewArtifactVersion.mockResolvedValueOnce({ integrityVerified: true, preview: { family: 'text', text: '<script>window.bad = true</script>' } });
  render(<ArtifactInspector {...props} />); await select();
  expect(await screen.findByText('<script>window.bad = true</script>')).toBeVisible(); expect(document.querySelector('script')).toBeNull();
  previewArtifactVersion.mockResolvedValueOnce({ integrityVerified: true, preview: { family: 'image', width: 1, height: 1 } });
  await select();
  const image = await screen.findByRole('img'); expect(image).toHaveAttribute('src', '/api/artifact-versions/project/av_one/image');
  fireEvent.error(image);
  expect(await screen.findByRole('alert')).toHaveTextContent('integrity check failed'); expect(screen.queryByRole('img')).not.toBeInTheDocument();
});
