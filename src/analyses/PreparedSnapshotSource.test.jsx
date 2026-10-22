import React from 'react';
import { createHash, webcrypto } from 'node:crypto';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import PreparedSnapshotSource from './PreparedSnapshotSource';
import { readSnapshotPreparationDocument } from './snapshotPreparationApi';
import useExecutionTarget from '../runtime/useExecutionTarget';
import { canonicalNotebookContent } from '../../shared/notebookDocument.mjs';
import { canonicalAnalysisSnapshotDocumentSource, FIXED_DOCUMENT_SOURCE_SCHEMA } from '../../shared/analysisSnapshotPreparation.mjs';
import { snapshotScope, snapshotRecipe, snapshotRecord, savedSnapshotContent } from './snapshotPreparationTestFixtures';

vi.mock('./snapshotPreparationApi', () => ({ readSnapshotPreparationDocument: vi.fn() }));
vi.mock('../runtime/useExecutionTarget', () => ({ default: vi.fn() }));
const hash = value => createHash('sha256').update(value).digest('hex');
const connection = { identity: 'workspace-one', epoch: 1, blocked: false };
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
function fixture(content = structuredClone(savedSnapshotContent)) {
  const record = snapshotRecord(snapshotRecipe()), descriptor = structuredClone(record.package.documents[0]), canonical = canonicalNotebookContent(content);
  const bytes = new TextEncoder().encode(canonical); descriptor.sha256 = hash(bytes); descriptor.blobSha256 = descriptor.sha256;
  descriptor.contentBytes = bytes.byteLength; descriptor.blobBytes = bytes.byteLength;
  descriptor.viewSha256 = hash(canonicalAnalysisSnapshotDocumentSource({ schema: FIXED_DOCUMENT_SOURCE_SCHEMA,
    source: { documentId: descriptor.documentId, versionId: descriptor.versionId, sha256: descriptor.sha256 }, blobSha256: descriptor.blobSha256, blobBytes: descriptor.blobBytes }));
  return { props: { ...snapshotScope, preparationId: record.preparationId, descriptor, available: true, isActive: true, onDenied: vi.fn(), onUnavailable: vi.fn() },
    content, bytes, type: 'application/json', canonical };
}
const open = () => fireEvent.click(screen.getByRole('button', { name: 'View supporting source' }));
beforeEach(() => { vi.resetAllMocks(); vi.stubGlobal('crypto', webcrypto); useExecutionTarget.mockReturnValue(connection); });
afterEach(() => vi.unstubAllGlobals());

it('loads exact saved canonical supporting source only after an explicit action and preserves literal source whitespace', async () => {
  const value = fixture(); readSnapshotPreparationDocument.mockResolvedValue(value); render(<PreparedSnapshotSource {...value.props} />);
  expect(readSnapshotPreparationDocument).not.toHaveBeenCalled(); expect(screen.getByText(/producing code has not been established/)).toBeVisible();
  open(); const source = await screen.findByLabelText('Retained saved source');
  expect(source.textContent).toBe(value.content.cells[0].source); expect(screen.getByText('Saved supporting source checksum verified')).toBeVisible();
  expect(readSnapshotPreparationDocument).toHaveBeenCalledExactlyOnceWith(snapshotScope.projectId, snapshotScope.analysisId, value.props.preparationId,
    value.props.descriptor, { signal: expect.any(AbortSignal) });
  expect(screen.queryByLabelText('Canonical retained source')).not.toBeInTheDocument();
  const details = screen.getByText('Exact saved source and metadata').closest('details');
  await act(async () => { details.open = true; fireEvent(details, new Event('toggle')); });
  expect(screen.getByLabelText('Canonical retained source').textContent).toBe(value.canonical);
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument(); expect(screen.queryByRole('button', { name: /Run|Save changes|Edit source/ })).not.toBeInTheDocument();
});

it('renders one selected source cell at a time as inert text rather than executing or rendering embedded HTML', async () => {
  const content = structuredClone(savedSnapshotContent);
  content.cells.push({ id: 'text_two', type: 'markdown', source: '<script>window.run = true</script>', metadata: {}, collapsed: false });
  const value = fixture(content); readSnapshotPreparationDocument.mockResolvedValue(value); render(<PreparedSnapshotSource {...value.props} />); open();
  await screen.findByLabelText('Retained saved source'); expect(screen.queryByText(content.cells[1].source)).not.toBeInTheDocument();
  fireEvent.change(screen.getByRole('combobox', { name: 'Saved source cell' }), { target: { value: 'text_two' } });
  expect(screen.getByLabelText('Retained saved source').textContent).toBe(content.cells[1].source); expect(document.querySelector('script')).toBeNull();
  expect(screen.queryByText(content.cells[0].source)).not.toBeInTheDocument(); expect(readSnapshotPreparationDocument).toHaveBeenCalledOnce();
});

it('hides source bodies without persisting them and requires an explicit action to open them again', async () => {
  const value = fixture(), storage = vi.spyOn(Storage.prototype, 'setItem'); readSnapshotPreparationDocument.mockResolvedValue(value);
  const view = render(<PreparedSnapshotSource {...value.props} />); open(); await screen.findByLabelText('Retained saved source');
  fireEvent.click(screen.getByRole('button', { name: 'Hide supporting source' })); expect(screen.queryByLabelText('Retained saved source')).not.toBeInTheDocument();
  view.rerender(<PreparedSnapshotSource {...value.props} descriptor={structuredClone(value.props.descriptor)} />);
  await act(async () => {}); expect(readSnapshotPreparationDocument).toHaveBeenCalledOnce(); expect(storage).not.toHaveBeenCalled();
  open(); await screen.findByLabelText('Retained saved source'); expect(readSnapshotPreparationDocument).toHaveBeenCalledTimes(2); storage.mockRestore();
});

it('does not reload or reset the selected cell when original preparation checking returns equal descriptor objects', async () => {
  const value = fixture(); readSnapshotPreparationDocument.mockResolvedValue(value);
  const view = render(<PreparedSnapshotSource {...value.props} />); open(); await screen.findByLabelText('Retained saved source');
  view.rerender(<PreparedSnapshotSource {...value.props} descriptor={structuredClone(value.props.descriptor)} onUnavailable={vi.fn()} />);
  await act(async () => {}); expect(readSnapshotPreparationDocument).toHaveBeenCalledOnce(); expect(screen.getByLabelText('Retained saved source')).toBeVisible();
});

it.each(['wrong checksum', 'rewritten canonical source', 'wrong saved language'])('refuses %s rather than showing another document or inferring execution', async failure => {
  const value = fixture();
  if (failure === 'wrong checksum') value.bytes = new TextEncoder().encode('different source');
  else if (failure === 'wrong saved language') value.props.descriptor.defaultLanguage = 'python';
  else { value.bytes = new TextEncoder().encode(JSON.stringify(value.content, null, 2)); value.props.descriptor.blobSha256 = hash(value.bytes);
    value.props.descriptor.sha256 = hash(value.bytes); value.props.descriptor.blobBytes = value.bytes.byteLength; value.props.descriptor.contentBytes = value.bytes.byteLength; }
  readSnapshotPreparationDocument.mockResolvedValue(value); render(<PreparedSnapshotSource {...value.props} />); open();
  expect(await screen.findByRole('alert')).toHaveTextContent('exact saved identity is kept'); expect(screen.queryByLabelText('Retained saved source')).not.toBeInTheDocument();
  expect(value.props.onUnavailable).toHaveBeenCalledOnce(); expect(value.props.onDenied).not.toHaveBeenCalled();
});

it.each([
  [401, 'UNAUTHORIZED', true], [404, 'ANALYSIS_SNAPSHOT_SCOPE_NOT_FOUND', true], [403, 'FORBIDDEN', true],
  [403, 'ANALYSIS_SNAPSHOT_WRITE_REQUIRED', false], [404, 'ANALYSIS_SNAPSHOT_PREPARATION_NOT_FOUND', false], [409, 'ANALYSIS_SNAPSHOT_VIEW_UNAVAILABLE', false],
])('preserves the scope/resource distinction for saved-source %s/%s', async (status, code, revokes) => {
  const value = fixture(), failure = Object.assign(new Error('private host error'), { status, code }); readSnapshotPreparationDocument.mockRejectedValue(failure);
  render(<PreparedSnapshotSource {...value.props} />); open(); await screen.findByRole('alert');
  if (revokes) expect(value.props.onDenied).toHaveBeenCalledExactlyOnceWith(failure); else expect(value.props.onDenied).not.toHaveBeenCalled();
  if (['ANALYSIS_SNAPSHOT_PREPARATION_NOT_FOUND', 'ANALYSIS_SNAPSHOT_VIEW_UNAVAILABLE'].includes(code)) expect(value.props.onUnavailable).toHaveBeenCalledExactlyOnceWith(failure);
  expect(screen.queryByText('private host error')).not.toBeInTheDocument();
});

it.each(['project', 'analysis', 'user', 'preparation', 'service', 'epoch', 'inactive', 'disconnected', 'unmounted', 'hidden source'])('fences held source bytes when %s changes', async change => {
  const value = fixture(), completion = deferred(); readSnapshotPreparationDocument.mockReturnValueOnce(completion.promise);
  const view = render(<PreparedSnapshotSource {...value.props} />); open(); await waitFor(() => expect(readSnapshotPreparationDocument).toHaveBeenCalledOnce());
  const signal = readSnapshotPreparationDocument.mock.calls[0][4].signal;
  if (change === 'unmounted') view.unmount();
  else if (change === 'hidden source') fireEvent.click(screen.getByRole('button', { name: 'Hide supporting source' }));
  else {
    if (change === 'epoch') useExecutionTarget.mockReturnValue({ ...connection, epoch: 2 });
    const changed = change === 'project' ? { projectId: 'proj_' + 'e'.repeat(16) } : change === 'analysis' ? { analysisId: 'ra_' + 'e'.repeat(24) }
      : change === 'user' ? { userId: 8 } : change === 'preparation' ? { preparationId: 'asp_' + 'e'.repeat(24) }
        : change === 'service' ? { serviceId: 'svc_' + 'e'.repeat(32) } : change === 'inactive' ? { isActive: false } : change === 'disconnected' ? { available: false } : {};
    view.rerender(<PreparedSnapshotSource {...value.props} {...changed} />);
  }
  expect(signal.aborted).toBe(true); await act(async () => completion.resolve(value));
  expect(screen.queryByLabelText('Retained saved source')).not.toBeInTheDocument(); expect(value.props.onDenied).not.toHaveBeenCalled();
});

it('does not request another saved version until explicitly opened after an exact document change', async () => {
  const value = fixture(), next = fixture(); next.props.descriptor.versionId = 'dv_' + 'e'.repeat(24);
  readSnapshotPreparationDocument.mockResolvedValue(value); const view = render(<PreparedSnapshotSource {...value.props} />); open(); await screen.findByLabelText('Retained saved source');
  view.rerender(<PreparedSnapshotSource {...next.props} />); expect(screen.queryByLabelText('Retained saved source')).not.toBeInTheDocument();
  await act(async () => {}); expect(readSnapshotPreparationDocument).toHaveBeenCalledOnce();
  readSnapshotPreparationDocument.mockResolvedValue(next); open(); await screen.findByLabelText('Retained saved source'); expect(readSnapshotPreparationDocument).toHaveBeenCalledTimes(2);
});

it('keeps an unavailable retained document stable through parent checking and retries only on explicit source action', async () => {
  const value = fixture(), failure = Object.assign(new Error('gone'), { status: 404, code: 'ANALYSIS_SNAPSHOT_PREPARATION_NOT_FOUND' });
  readSnapshotPreparationDocument.mockRejectedValueOnce(failure).mockResolvedValue(value);
  const view = render(<PreparedSnapshotSource {...value.props} />); open(); await screen.findByRole('alert');
  view.rerender(<PreparedSnapshotSource {...value.props} descriptor={structuredClone(value.props.descriptor)} onUnavailable={vi.fn()} />);
  await act(async () => {}); expect(readSnapshotPreparationDocument).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button', { name: 'Retry supporting source' })); await screen.findByLabelText('Retained saved source'); expect(readSnapshotPreparationDocument).toHaveBeenCalledTimes(2);
});
