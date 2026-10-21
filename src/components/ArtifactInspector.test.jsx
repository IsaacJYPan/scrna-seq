import React from 'react';
import { createHash, webcrypto } from 'node:crypto';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import ArtifactInspector from './ArtifactInspector';
import { getArtifactImportReceipt, getArtifactVersion, importArtifactVersion, listArtifactVersions, previewArtifactVersion } from '../artifacts/artifactApi';
import { artifactImportRequestSha256, prepareArtifactImportRequest } from '../artifacts/artifactImportReceipt';
import { fetchRetainedArtifactImage } from '../artifacts/retainedArtifactApi';

const serverImporter = vi.hoisted(() => ({ onImported: null }));
vi.mock('./ServerDataImporter', () => ({ default: ({ onImported }) => { serverImporter.onImported = onImported; return null; } }));
vi.mock('../artifacts/artifactApi', () => ({
  artifactImageUrl: (project, version) => `/api/artifact-versions/${project}/${version}/image`,
  getArtifactImportReceipt: vi.fn(), getArtifactVersion: vi.fn(), importArtifactVersion: vi.fn(), listArtifactVersions: vi.fn(), previewArtifactVersion: vi.fn(),
}));
vi.mock('../artifacts/retainedArtifactApi', () => ({ fetchRetainedArtifactImage: vi.fn() }));
const version = {
  artifactId: 'af_111111111111111111111111', versionId: 'av_111111111111111111111111', projectId: 'project', type: 'table', ownerId: '1',
  name: 'Gene scores', versionNumber: 1, sizeBytes: 40, format: { id: 'org.ietf.csv', version: '1' },
  owner: { displayName: 'Researcher' }, sourceRunId: null, sha256: 'a'.repeat(64), previews: ['table'], canReplace: true,
  reference: { artifactId: 'af_111111111111111111111111', versionId: 'av_111111111111111111111111', projectId: 'project', sha256: 'a'.repeat(64) },
};
const table = { version, integrityVerified: true, preview: { family: 'table', columns: ['gene', 'score'], rows: [['A', '1']], offset: 0, limit: 25, hasMore: true } };
beforeEach(() => {
  vi.resetAllMocks(); vi.stubGlobal('crypto', webcrypto); delete window.desktopShell; serverImporter.onImported = null;
  listArtifactVersions.mockResolvedValue({ items: [version], nextCursor: null });
  getArtifactVersion.mockImplementation(async (_project, id) => ({ ...version, versionId: id }));
  previewArtifactVersion.mockResolvedValue(table);
});
afterEach(() => { vi.unstubAllGlobals(); delete window.desktopShell; });
const props = { projectId: 'project', canWrite: true, userId: 1 };
const select = async () => fireEvent.click(await screen.findByRole('button', { name: /Gene scores · v1/ }));
const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const unknown = () => Object.assign(new Error('The connection ended before a response.'), { code: 'ARTIFACT_SERVICE_UNREACHABLE' });
const notFound = () => Object.assign(new Error('No receipt yet.'), { status: 404, code: 'ARTIFACT_IMPORT_NOT_FOUND' });
const other = { ...version, artifactId: 'af_333333333333333333333333', versionId: 'av_333333333333333333333333', name: 'Other scores',
  reference: { ...version.reference, artifactId: 'af_333333333333333333333333', versionId: 'av_333333333333333333333333' } };

async function acceptedUpload(options, { canImport = true, availability = 'recorded' } = {}) {
  const request = await prepareArtifactImportRequest({ ...options, projectId: 'project', ownerUserId: 1 });
  const saved = { ...version, name: request.name, type: request.artifactType === 'sample-sheet' ? 'sample-sheet' : 'table',
    versionId: 'av_222222222222222222222222', versionNumber: request.previousVersionId ? 2 : 1,
    previousVersionId: request.previousVersionId, sizeBytes: request.sizeBytes, sha256: request.sha256,
    reference: { ...version.reference, versionId: 'av_222222222222222222222222', sha256: request.sha256 } };
  const acceptance = { artifactId: saved.artifactId, versionId: saved.versionId, versionNumber: saved.versionNumber,
    previousVersionId: request.previousVersionId, sha256: request.sha256, sizeBytes: request.sizeBytes, createdAt: '2026-10-20T12:00:00Z' };
  const identity = { requestId: request.requestId, request, requestSha256: await artifactImportRequestSha256(request), status: 'succeeded',
    acceptance, availability, canImport };
  return { saved, receipt: { ...identity, version: availability === 'recorded' ? saved : null },
    post: availability === 'recorded' ? { ...saved, importRequest: { ...identity, replayed: false } } : { version: null, importRequest: { ...identity, replayed: true } } };
}

const chooseUpload = (file = new File(['gene,score\nA,2'], 'scores.csv'), name = 'Imported scores') => {
  fireEvent.change(screen.getByLabelText('Artifact file'), { target: { files: [file] } });
  fireEvent.change(screen.getByLabelText('Artifact name'), { target: { value: name } });
  return file;
};
const startUpload = async () => {
  fireEvent.click(screen.getByRole('button', { name: /^(Import artifact|Save new artifact version)$/ }));
  await waitFor(() => expect(importArtifactVersion).toHaveBeenCalledTimes(1));
  return importArtifactVersion.mock.calls[0][1];
};

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
  let next;
  importArtifactVersion.mockImplementation(async (_project, options) => {
    const accepted = await acceptedUpload(options); next = accepted.saved;
    listArtifactVersions.mockResolvedValue({ items: [next, version], nextCursor: null });
    getArtifactVersion.mockResolvedValue(next); previewArtifactVersion.mockResolvedValue({ ...table, version: next });
    return accepted.post;
  });
  render(<ArtifactInspector {...props} />); await select();
  await screen.findByRole('columnheader', { name: 'gene' });
  fireEvent.change(screen.getByLabelText('Artifact file'), { target: { files: [new File(['gene,score\nA,2'], 'scores.csv')] } });
  fireEvent.change(screen.getByLabelText('Artifact name'), { target: { value: 'Gene scores' } });
  fireEvent.click(screen.getByLabelText('New version of selected artifact'));
  fireEvent.click(screen.getByRole('button', { name: 'Save new artifact version' }));
  await screen.findByRole('button', { name: /Gene scores · v2/ });
  await screen.findByRole('columnheader', { name: 'gene' });
  expect(screen.getByRole('button', { name: /Gene scores · v1/ })).toBeVisible();
  expect(importArtifactVersion).toHaveBeenCalledWith('project', expect.objectContaining({ previousVersionId: 'av_111111111111111111111111', file: expect.any(File), requestId: expect.stringMatching(/^[a-f0-9-]{36}$/), expectedRequestSha256: expect.stringMatching(/^[a-f0-9]{64}$/) }));
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

it('freezes the original File, UUID, normalized settings and replacement across an unknown outcome, explicit GET and explicit retry', async () => {
  listArtifactVersions.mockResolvedValue({ items: [version, other], nextCursor: null });
  importArtifactVersion.mockRejectedValueOnce(unknown());
  getArtifactImportReceipt.mockRejectedValueOnce(notFound());
  render(<ArtifactInspector {...props} />); await select();
  const content = 'gene,score\nα,2'; const file = chooseUpload(new File([content], 'scores.csv'), '  Frozen scores  ');
  fireEvent.change(screen.getByLabelText('Artifact purpose'), { target: { value: 'sample-sheet' } });
  fireEvent.click(screen.getByLabelText('New version of selected artifact'));
  const original = await startUpload();
  const recovery = await screen.findByRole('region', { name: 'Artifact import recovery' });
  await within(recovery).findByText(/Import completion is unconfirmed/);
  expect(original).toMatchObject({ file, name: 'Frozen scores', artifactType: 'sample-sheet', previousVersionId: version.versionId });
  const request = await prepareArtifactImportRequest({ ...original, projectId: 'project', ownerUserId: 1 });
  expect(request.sha256).toBe(createHash('sha256').update(content).digest('hex'));
  expect(request.sizeBytes).toBe(new TextEncoder().encode(content).byteLength);
  expect(original.expectedRequestSha256).toBe(await artifactImportRequestSha256(request));
  expect(screen.getByLabelText('Artifact file')).toBeDisabled(); expect(screen.getByLabelText('Artifact name')).toBeDisabled();
  expect(screen.getByLabelText('Artifact purpose')).toBeDisabled(); expect(screen.getByLabelText('New version of selected artifact')).toBeDisabled();
  expect(within(recovery).queryByRole('button', { name: 'Retry original upload' })).not.toBeInTheDocument();
  expect(getArtifactImportReceipt).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Artifact file'), { target: { files: [new File(['different'], 'different.csv')] } });
  fireEvent.change(screen.getByLabelText('Artifact name'), { target: { value: 'Different' } });
  fireEvent.change(screen.getByLabelText('Artifact purpose'), { target: { value: 'auto' } });
  fireEvent.click(screen.getByRole('button', { name: /Other scores · v1/ }));
  fireEvent.click(within(recovery).getByRole('button', { name: 'Check import outcome' }));
  await within(recovery).findByText(/does not prove the upload was rejected/);
  expect(getArtifactImportReceipt).toHaveBeenCalledExactlyOnceWith('project', original.requestId, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  expect(importArtifactVersion).toHaveBeenCalledTimes(1);
  const accepted = await acceptedUpload(original);
  importArtifactVersion.mockResolvedValueOnce(accepted.post);
  listArtifactVersions.mockResolvedValue({ items: [accepted.saved, version, other], nextCursor: null });
  fireEvent.click(within(recovery).getByRole('button', { name: 'Retry original upload' }));
  await within(recovery).findByText(/The original import was accepted/);
  const retried = importArtifactVersion.mock.calls[1][1];
  expect(retried).toEqual({ ...original, signal: expect.any(AbortSignal) });
  expect(retried.file).toBe(file); expect(retried.requestId).toBe(original.requestId);
  expect(within(recovery).getByText(/Your current artifact selection was kept/)).toBeVisible();
  expect(getArtifactVersion.mock.calls.at(-1)[1]).toBe(other.versionId);
  expect(within(recovery).queryByRole('button', { name: 'Retry original upload' })).not.toBeInTheDocument();
});

it('preserves an unknown request when a POST acknowledgement or GET receipt belongs to different bytes', async () => {
  importArtifactVersion.mockResolvedValueOnce(version);
  render(<ArtifactInspector {...props} />); chooseUpload(); const original = await startUpload();
  const recovery = await screen.findByRole('region', { name: 'Artifact import recovery' });
  await within(recovery).findByText(/The original import could not be confirmed/);
  const accepted = await acceptedUpload(original);
  accepted.receipt.acceptance.sha256 = '0'.repeat(64);
  getArtifactImportReceipt.mockResolvedValueOnce(accepted.receipt);
  fireEvent.click(within(recovery).getByRole('button', { name: 'Check import outcome' }));
  await waitFor(() => expect(getArtifactImportReceipt).toHaveBeenCalledTimes(1));
  await within(recovery).findByText(/The original import could not be confirmed/);
  expect(within(recovery).getByText(original.requestId)).toBeInTheDocument();
  expect(within(recovery).queryByText(/The original import was accepted/)).not.toBeInTheDocument();
  expect(within(recovery).queryByRole('button', { name: 'Inspect imported version' })).not.toBeInTheDocument();
  expect(screen.getByLabelText('Artifact file')).toBeDisabled(); expect(importArtifactVersion).toHaveBeenCalledTimes(1);
});

it('recovers an accepted outcome for a current reader through GET without a fresh mutation', async () => {
  importArtifactVersion.mockRejectedValueOnce(unknown());
  const view = render(<ArtifactInspector {...props} />); chooseUpload(); const original = await startUpload();
  const recovery = await screen.findByRole('region', { name: 'Artifact import recovery' });
  await within(recovery).findByText(/Import completion is unconfirmed/);
  view.rerender(<ArtifactInspector {...props} canWrite={false} />);
  const accepted = await acceptedUpload(original, { canImport: false });
  getArtifactImportReceipt.mockResolvedValue(accepted.receipt);
  listArtifactVersions.mockResolvedValue({ items: [accepted.saved], nextCursor: null });
  getArtifactVersion.mockResolvedValue(accepted.saved); previewArtifactVersion.mockResolvedValue({ ...table, version: accepted.saved });
  fireEvent.click(within(recovery).getByRole('button', { name: 'Check import outcome' }));
  await within(recovery).findByText(/The original import was accepted/);
  await screen.findByRole('columnheader', { name: 'gene' });
  expect(importArtifactVersion).toHaveBeenCalledTimes(1);
  expect(screen.queryByLabelText('Artifact file')).not.toBeInTheDocument();
  expect(within(recovery).getByText(/Receipt checks require current project read access/)).toBeVisible();
  expect(within(recovery).queryByRole('button', { name: 'Retry original upload' })).not.toBeInTheDocument();
  view.rerender(<ArtifactInspector {...props} />);
  expect(screen.queryByLabelText('Artifact file')).not.toBeInTheDocument();
});

it('keeps accepted missing bytes as an accepted outcome without offering a reupload', async () => {
  importArtifactVersion.mockRejectedValueOnce(unknown());
  render(<ArtifactInspector {...props} />); chooseUpload(); const original = await startUpload();
  const recovery = await screen.findByRole('region', { name: 'Artifact import recovery' });
  await within(recovery).findByText(/Import completion is unconfirmed/);
  const accepted = await acceptedUpload(original, { availability: 'unavailable' });
  getArtifactImportReceipt.mockResolvedValue(accepted.receipt);
  fireEvent.click(within(recovery).getByRole('button', { name: 'Check import outcome' }));
  await within(recovery).findByText(/accepted, but its saved file is currently unavailable/);
  expect(within(recovery).getByText(original.requestId)).toBeInTheDocument();
  expect(within(recovery).queryByRole('button', { name: 'Retry original upload' })).not.toBeInTheDocument();
  expect(within(recovery).queryByRole('button', { name: 'Inspect imported version' })).not.toBeInTheDocument();
  fireEvent.click(within(recovery).getByRole('button', { name: 'Check import outcome' }));
  await waitFor(() => expect(getArtifactImportReceipt).toHaveBeenCalledTimes(2));
  expect(importArtifactVersion).toHaveBeenCalledTimes(1); expect(getArtifactVersion).not.toHaveBeenCalled();
});

it.each(['POST', 'GET'])('keeps a later artifact selection when the original %s completes late', async transport => {
  const completion = deferred();
  listArtifactVersions.mockResolvedValue({ items: [version, other], nextCursor: null });
  if (transport === 'POST') importArtifactVersion.mockReturnValueOnce(completion.promise);
  else { importArtifactVersion.mockRejectedValueOnce(unknown()); getArtifactImportReceipt.mockReturnValueOnce(completion.promise); }
  render(<ArtifactInspector {...props} />); await select(); chooseUpload(); const original = await startUpload();
  const recovery = await screen.findByRole('region', { name: 'Artifact import recovery' });
  if (transport === 'GET') {
    await within(recovery).findByText(/Import completion is unconfirmed/);
    fireEvent.click(within(recovery).getByRole('button', { name: 'Check import outcome' }));
    await waitFor(() => expect(getArtifactImportReceipt).toHaveBeenCalledTimes(1));
  }
  fireEvent.click(screen.getByRole('button', { name: /Other scores · v1/ }));
  await waitFor(() => expect(getArtifactVersion.mock.calls.at(-1)[1]).toBe(other.versionId));
  const accepted = await acceptedUpload(original);
  listArtifactVersions.mockResolvedValue({ items: [accepted.saved, version, other], nextCursor: null });
  await act(async () => completion.resolve(transport === 'POST' ? accepted.post : accepted.receipt));
  await within(recovery).findByText(/Your current artifact selection was kept/);
  expect(getArtifactVersion.mock.calls.some(call => call[1] === accepted.saved.versionId)).toBe(false);
  getArtifactVersion.mockResolvedValue(accepted.saved); previewArtifactVersion.mockResolvedValue({ ...table, version: accepted.saved });
  fireEvent.click(within(recovery).getByRole('button', { name: 'Inspect imported version' }));
  await waitFor(() => expect(getArtifactVersion.mock.calls.at(-1)[1]).toBe(accepted.saved.versionId));
});

it.each(['POST', 'GET'])('ignores a late %s after the inspector closes or changes project', async transport => {
  const completion = deferred();
  if (transport === 'POST') importArtifactVersion.mockReturnValueOnce(completion.promise);
  else { importArtifactVersion.mockRejectedValueOnce(unknown()); getArtifactImportReceipt.mockReturnValueOnce(completion.promise); }
  const view = render(<ArtifactInspector {...props} />); chooseUpload(); const original = await startUpload();
  const recovery = await screen.findByRole('region', { name: 'Artifact import recovery' });
  if (transport === 'GET') {
    await within(recovery).findByText(/Import completion is unconfirmed/);
    fireEvent.click(within(recovery).getByRole('button', { name: 'Check import outcome' }));
    await waitFor(() => expect(getArtifactImportReceipt).toHaveBeenCalledTimes(1));
  }
  const signal = transport === 'POST' ? original.signal : getArtifactImportReceipt.mock.calls[0][2].signal;
  const accepted = await acceptedUpload(original);
  listArtifactVersions.mockResolvedValue({ items: [], nextCursor: null });
  if (transport === 'POST') view.unmount();
  else view.rerender(<ArtifactInspector {...props} projectId="other-project" />);
  expect(signal.aborted).toBe(true);
  await act(async () => completion.resolve(transport === 'POST' ? accepted.post : accepted.receipt));
  expect(screen.queryByRole('region', { name: 'Artifact import recovery' })).not.toBeInTheDocument();
  expect(screen.queryByText(/The original import was accepted/)).not.toBeInTheDocument();
  expect(getArtifactVersion).not.toHaveBeenCalled();
});

it.each(['POST', 'GET'])('forgets pending recovery when the server identity changes and ignores its late %s', async transport => {
  let notify; const target = { id: 'lab', serviceIdentity: 'first-lab', status: 'connected' };
  window.desktopShell = { getCurrentTarget: async () => target, onTargetStatus: listener => { notify = listener; return () => {}; } };
  const completion = deferred();
  if (transport === 'POST') importArtifactVersion.mockReturnValueOnce(completion.promise);
  else { importArtifactVersion.mockRejectedValueOnce(unknown()); getArtifactImportReceipt.mockReturnValueOnce(completion.promise); }
  render(<ArtifactInspector {...props} />); await screen.findByLabelText('Artifact file');
  chooseUpload(); const original = await startUpload();
  const recovery = await screen.findByRole('region', { name: 'Artifact import recovery' });
  if (transport === 'GET') {
    await within(recovery).findByText(/Import completion is unconfirmed/);
    fireEvent.click(within(recovery).getByRole('button', { name: 'Check import outcome' }));
    await waitFor(() => expect(getArtifactImportReceipt).toHaveBeenCalledTimes(1));
  }
  const signal = transport === 'POST' ? original.signal : getArtifactImportReceipt.mock.calls[0][2].signal;
  const accepted = await acceptedUpload(original);
  listArtifactVersions.mockResolvedValue({ items: [], nextCursor: null });
  await act(async () => notify({ ...target, serviceIdentity: 'second-lab' }));
  expect(signal.aborted).toBe(true);
  await act(async () => completion.resolve(transport === 'POST' ? accepted.post : accepted.receipt));
  expect(screen.queryByRole('region', { name: 'Artifact import recovery' })).not.toBeInTheDocument();
  expect(screen.getByLabelText('Artifact file')).toBeEnabled();
  expect(screen.getByLabelText('Artifact name')).toHaveValue('');
  expect(getArtifactVersion).not.toHaveBeenCalled(); expect(importArtifactVersion).toHaveBeenCalledTimes(1);
});

it.each(['INVALID_ARTIFACT_FORMAT', 'ARTIFACT_IMPORT_SOURCE_CHANGED'])('releases a first certain %s rejection so a corrected upload receives a fresh identity', async code => {
  importArtifactVersion.mockRejectedValueOnce(Object.assign(new Error('Rejected before acceptance.'), { status: 400, code }));
  importArtifactVersion.mockRejectedValueOnce(unknown());
  render(<ArtifactInspector {...props} />); chooseUpload(); const rejected = await startUpload();
  await screen.findByText(/rejected before acceptance/);
  expect(screen.queryByRole('region', { name: 'Artifact import recovery' })).not.toBeInTheDocument();
  expect(screen.getByLabelText('Artifact file')).toBeEnabled();
  const corrected = chooseUpload(new File(['gene,score\nA,3'], 'corrected.csv'), 'Corrected scores');
  fireEvent.click(screen.getByRole('button', { name: 'Import artifact', exact: true }));
  await waitFor(() => expect(importArtifactVersion).toHaveBeenCalledTimes(2));
  const next = importArtifactVersion.mock.calls[1][1];
  expect(next.requestId).not.toBe(rejected.requestId); expect(next.file).toBe(corrected);
});

it('keeps an uncertain request frozen after a later explicit retry receives a certain-looking 4xx rejection', async () => {
  importArtifactVersion.mockRejectedValueOnce(unknown());
  getArtifactImportReceipt.mockRejectedValueOnce(notFound());
  importArtifactVersion.mockRejectedValueOnce(Object.assign(new Error('Invalid later replay.'), { status: 400, code: 'INVALID_ARTIFACT_FORMAT' }));
  render(<ArtifactInspector {...props} />); chooseUpload(); const original = await startUpload();
  const recovery = await screen.findByRole('region', { name: 'Artifact import recovery' });
  await within(recovery).findByText(/Import completion is unconfirmed/);
  fireEvent.click(within(recovery).getByRole('button', { name: 'Check import outcome' }));
  fireEvent.click(await within(recovery).findByRole('button', { name: 'Retry original upload' }));
  await waitFor(() => expect(importArtifactVersion).toHaveBeenCalledTimes(2));
  await within(recovery).findByText(/Import completion is unconfirmed/);
  expect(within(recovery).getByText(original.requestId)).toBeInTheDocument();
  expect(screen.getByLabelText('Artifact file')).toBeDisabled();
  expect(screen.queryByText(/rejected before acceptance/)).not.toBeInTheDocument();
});

it('removes an earlier confirmed version after a fresh receipt access denial while retaining its original acceptance identity', async () => {
  let accepted;
  importArtifactVersion.mockImplementationOnce(async (_project, options) => {
    accepted = await acceptedUpload(options);
    listArtifactVersions.mockResolvedValue({ items: [accepted.saved], nextCursor: null });
    getArtifactVersion.mockResolvedValue(accepted.saved); previewArtifactVersion.mockResolvedValue({ ...table, version: accepted.saved });
    return accepted.post;
  });
  render(<ArtifactInspector {...props} />); chooseUpload(); const original = await startUpload();
  const recovery = await screen.findByRole('region', { name: 'Artifact import recovery' });
  await within(recovery).findByText(/The original import was accepted/);
  await screen.findByRole('columnheader', { name: 'gene' });
  getArtifactImportReceipt.mockRejectedValueOnce(Object.assign(new Error('/private/permissions/current'), { status: 403, code: 'FORBIDDEN' }));
  fireEvent.click(within(recovery).getByRole('button', { name: 'Check import outcome' }));
  expect(await within(recovery).findByRole('alert')).toHaveTextContent('Your current access does not permit this action.');
  expect(within(recovery).getByText(original.requestId)).toBeInTheDocument();
  expect(within(recovery).queryByRole('button', { name: 'Inspect imported version' })).not.toBeInTheDocument();
  expect(screen.queryByRole('table')).not.toBeInTheDocument();
  expect(screen.queryByText('Researcher')).not.toBeInTheDocument();
  expect(screen.queryByText('/private/permissions/current')).not.toBeInTheDocument();
  expect(importArtifactVersion).toHaveBeenCalledTimes(1);
});

it('keeps a later artifact selection when an earlier server import callback arrives and offers explicit inspection', async () => {
  listArtifactVersions.mockResolvedValue({ items: [version, other], nextCursor: null });
  render(<ArtifactInspector {...props} />); await select();
  const pendingServerCallback = serverImporter.onImported;
  fireEvent.click(screen.getByRole('button', { name: /Other scores · v1/ }));
  await waitFor(() => expect(getArtifactVersion.mock.calls.at(-1)[1]).toBe(other.versionId));
  const saved = { ...version, versionId: 'av_444444444444444444444444', name: 'Imported server scores',
    reference: { ...version.reference, versionId: 'av_444444444444444444444444' } };
  listArtifactVersions.mockResolvedValue({ items: [saved, version, other], nextCursor: null });
  await act(async () => pendingServerCallback(saved));
  expect(getArtifactVersion.mock.calls.some(call => call[1] === saved.versionId)).toBe(false);
  expect(getArtifactVersion.mock.calls.at(-1)[1]).toBe(other.versionId);
  const inspectImported = screen.getByRole('button', { name: 'Inspect imported server version' });
  getArtifactVersion.mockResolvedValue(saved); previewArtifactVersion.mockResolvedValue({ ...table, version: saved });
  fireEvent.click(inspectImported);
  await waitFor(() => expect(getArtifactVersion.mock.calls.at(-1)[1]).toBe(saved.versionId));
  await screen.findByRole('columnheader', { name: 'gene' });
});
