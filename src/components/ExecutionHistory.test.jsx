import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import ExecutionHistory from './ExecutionHistory';
import { getExecutionEnvironment, getExecutionHistory, listExecutionHistory } from '../executions/executionHistoryApi';
import { getArtifactVersion, previewArtifactVersion } from '../artifacts/artifactApi';

vi.mock('../executions/executionHistoryApi', () => ({ getExecutionEnvironment: vi.fn(), getExecutionHistory: vi.fn(), listExecutionHistory: vi.fn() }));
vi.mock('../artifacts/artifactApi', () => ({ getArtifactVersion: vi.fn(), previewArtifactVersion: vi.fn(), artifactImageUrl: () => '/verified-image' }));
const item = { id: 'job_one', operation: 'expert.r.v1', kind: 'expert-r', status: 'completed', createdAt: '2026-10-08T10:00:00Z', detailAvailable: true, owner: { id: '1', displayName: 'Researcher' } };
const output = { name: 'Gene scores', versionId: 'art_one', sha256: 'a'.repeat(64), precision: 'recorded-version', basis: 'Retained output', inspectable: true, reference: { projectId: 'project', versionId: 'art_one', sha256: 'a'.repeat(64) } };
const detail = { ...item, origin: 'durable-job', source: { versionId: 'src_job_one', precision: 'exact-retained', sha256: 'b'.repeat(64), code: '<script>inert content</script>' }, parameters: { precision: 'recorded-resolved', values: { threshold: 2 }, seed: 42 }, inputs: [], outputs: [output], environment: { precision: 'pinned-reference', reference: { id: 'renv_one' }, manifestAvailable: true, note: 'Container userspace snapshot.' }, target: { id: 'project-service', precision: 'service-only' }, timestamps: { createdAt: item.createdAt }, kernel: { available: false, reason: 'One-shot job; persistent kernel order unavailable.' }, replay: { complete: false, issues: [{ code: 'input-missing', message: 'Exact input bytes unavailable.' }] } };
const props = { projectId: 'project', userId: 1 };
beforeEach(() => { vi.resetAllMocks(); listExecutionHistory.mockResolvedValue({ items: [item], nextCursor: null }); getExecutionHistory.mockResolvedValue(detail); getArtifactVersion.mockResolvedValue({ projectId: 'project', sha256: output.sha256 }); previewArtifactVersion.mockResolvedValue({ version: { versionId: output.versionId, sha256: output.sha256 }, preview: { family: 'table', columns: ['gene'], rows: [['GENE_A']] } }); });
const select = async () => { fireEvent.click(await screen.findByRole('button', { name: /job_one/ })); await screen.findByText('Replay evidence incomplete'); };

it('distinguishes confirmed interrupted commands and identifies a new session without implying restored unsaved memory',async()=>{
  listExecutionHistory.mockResolvedValue({items:[{...item,kind:'r-console',status:'failed',outcome:'interrupted'}],nextCursor:null});
  getExecutionHistory.mockResolvedValue({...detail,kind:'r-console',status:'failed',outcome:'interrupted',kernel:{available:true,generation:'c'.repeat(64),order:1,restartedFromKernelId:'pk_original',scope:'Private R generation.'}});
  render(<ExecutionHistory {...props}/>);await select();
  expect(screen.getByRole('heading',{name:'expert.r.v1 · interrupted'})).toBeVisible();
  expect(screen.getByText('Restarted from pk_original · earlier unsaved memory was discarded')).toBeInTheDocument();
  expect(screen.getByText('<script>inert content</script>')).toBeInTheDocument();
});

it('shows retained source versions, resolved parameters and honest replay/kernel gaps as inert text', async () => {
  render(<ExecutionHistory {...props} />); await select();
  expect(screen.getByText('Private source version src_job_one')).toBeInTheDocument(); expect(screen.getByText('<script>inert content</script>')).toBeInTheDocument(); expect(document.querySelector('script')).toBeNull();
  expect(screen.getByText('Exact input bytes unavailable.')).toBeVisible(); expect(screen.getByText('One-shot job; persistent kernel order unavailable.')).toBeInTheDocument();
  expect(screen.getByText(/"threshold": 2/)).toBeInTheDocument();
});
it('never opens collaborator private evidence from project activity summaries', async () => {
  listExecutionHistory.mockResolvedValue({ items: [{ ...item, owner: { id: '2', displayName: 'Collaborator' }, detailAvailable: false }], nextCursor: null });
  render(<ExecutionHistory {...props} />); fireEvent.click(await screen.findByRole('button', { name: /job_one/ }));
  expect(await screen.findByText(/require separate sharing authorization/)).toBeVisible(); expect(getExecutionHistory).not.toHaveBeenCalled();
});
it('bounds inspection to the execution reference and rejects changed metadata before reading bytes', async () => {
  render(<ExecutionHistory {...props} />); await select(); fireEvent.click(screen.getByRole('button', { name: 'Inspect Gene scores' }));
  expect(await screen.findByRole('cell', { name: 'GENE_A' })).toBeVisible(); expect(previewArtifactVersion).toHaveBeenCalledWith('project', 'art_one', expect.objectContaining({ limit: 10 }));
  getArtifactVersion.mockResolvedValue({ projectId: 'project', sha256: 'c'.repeat(64) }); fireEvent.click(screen.getByRole('button', { name: 'Inspect Gene scores' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('no longer matches'); expect(screen.queryByRole('table')).not.toBeInTheDocument(); expect(previewArtifactVersion).toHaveBeenCalledTimes(1);
});
it('does not show a preview whose verified descriptor changed after metadata admission', async () => {
  previewArtifactVersion.mockResolvedValue({ version: { sha256: 'c'.repeat(64) }, preview: { family: 'text', text: 'Changed bytes' } });
  render(<ExecutionHistory {...props} />); await select(); fireEvent.click(screen.getByRole('button', { name: 'Inspect Gene scores' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('no longer matches'); expect(screen.queryByText('Changed bytes')).not.toBeInTheDocument();
});
it('verifies the protected environment manifest and clears its private details on access revocation', async () => {
  getExecutionEnvironment.mockResolvedValueOnce({ manifest: { packages: [{ name: 'Seurat', version: '5.3.0' }] }, integrityVerified: true });
  render(<ExecutionHistory {...props} />); await select(); fireEvent.click(screen.getByRole('button', { name: 'Verify environment manifest' }));
  expect(await screen.findByText('Environment manifest checksum verified')).toBeVisible();
  getExecutionEnvironment.mockRejectedValueOnce(Object.assign(new Error('Project not found.'), { status: 404 })); fireEvent.click(screen.getByRole('button', { name: 'Verify environment manifest' }));
  await screen.findByRole('alert'); expect(screen.queryByText('Environment manifest checksum verified')).not.toBeInTheDocument(); expect(screen.queryByText('Private source version src_job_one')).not.toBeInTheDocument();
});
it('clears existing private preview and history entries after membership is revoked on refresh', async () => {
  render(<ExecutionHistory {...props} />); await select(); fireEvent.click(screen.getByRole('button', { name: 'Inspect Gene scores' })); await screen.findByRole('table');
  listExecutionHistory.mockRejectedValueOnce(Object.assign(new Error('Project not found.'), { status: 404 })); fireEvent.click(screen.getByRole('button', { name: 'Refresh executions' }));
  await screen.findByRole('alert'); expect(screen.queryByRole('table')).not.toBeInTheDocument(); expect(screen.queryByRole('button', { name: /job_one/ })).not.toBeInTheDocument();
});
it('cancels prior project requests and ignores responses received after project navigation', async () => {
  let finish; getExecutionHistory.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const view = render(<ExecutionHistory {...props} />); fireEvent.click(await screen.findByRole('button', { name: /job_one/ }));
  const signal = getExecutionHistory.mock.calls[0][2]; listExecutionHistory.mockResolvedValueOnce({ items: [], nextCursor: null }); view.rerender(<ExecutionHistory {...props} projectId="other" />);
  expect(signal.aborted).toBe(true); await act(async () => finish(detail)); expect(screen.queryByText('Private source version src_job_one')).not.toBeInTheDocument();
});
it('supports bounded category pagination and shows real guided process order without conflating revision', async () => {
  listExecutionHistory.mockResolvedValueOnce({ items: [item], nextCursor: 'next' });
  getExecutionHistory.mockResolvedValueOnce({ ...detail, kernel: { available: true, generation: 'c'.repeat(64), order: 7, resultLiveRevision: 3, scope: 'Guided interactive R process.' } });
  render(<ExecutionHistory {...props} />); await select(); expect(screen.getByText('Execution order 7')).toBeInTheDocument(); expect(screen.getByText('Result live revision 3')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'More executions' })); await waitFor(() => expect(listExecutionHistory).toHaveBeenCalledWith('project', expect.objectContaining({ before: 'next' })));
  fireEvent.change(screen.getByLabelText('Execution category'), { target: { value: 'live-r' } }); await waitFor(() => expect(listExecutionHistory).toHaveBeenCalledWith('project', expect.objectContaining({ kind: 'live-r', before: undefined })));
});
