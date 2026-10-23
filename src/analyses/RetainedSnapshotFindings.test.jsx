import React from 'react';
import { createHash, webcrypto } from 'node:crypto';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import RetainedSnapshotFindings from './RetainedSnapshotFindings';
import { readSnapshotPreparationDocument, readSnapshotPreparationView } from './snapshotPreparationApi';
import useExecutionTarget from '../runtime/useExecutionTarget';
import { canonicalSnapshotJson, canonicalAnalysisSnapshotResultView } from '../../shared/analysisSnapshotPreparation.mjs';
import { canonicalNotebookContent } from '../../shared/notebookDocument.mjs';
import { savedSnapshotContent, snapshotScope, snapshotRecipe, snapshotRecord } from './snapshotPreparationTestFixtures';

vi.mock('./snapshotPreparationApi', () => ({ readSnapshotPreparationView: vi.fn(), readSnapshotPreparationDocument: vi.fn() }));
vi.mock('../runtime/useExecutionTarget', () => ({ default: vi.fn() }));
const hash = value => createHash('sha256').update(value).digest('hex');
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const publicId = 'aspub_' + 'b'.repeat(24);
const connection = { identity: 'same-workspace', epoch: 1, blocked: false };
const NativeURL = globalThis.URL;
function fixture({ image = false } = {}) {
  const original = snapshotRecipe(), next = { ...structuredClone(original.results[0]), attachmentId: 'raa_' + 'e'.repeat(24), revisionId: 'rar_' + 'e'.repeat(24) };
  const value = snapshotRecord(snapshotRecipe({ results: [...original.results, next], notes: { summary: '<script>private note</script>', decisions: null, limitations: 'Supplied limitations.' },
    prerequisites: [{ kind: 'compute', label: 'Supplied compute need', detail: 'An independently available R environment.' }] }));
  const bodies = new Map();
  value.package.results.forEach((item, index) => {
    item.attachment.caption = `Finding ${index + 1} exact caption`; item.source.name = `measured-${index + 1}.${image && index ? 'png' : 'csv'}`;
    const raster = image && index === 1;
    const table = { family: 'table', columns: ['sample', 'value'], rows: [[`retained donor ${index + 1}`, '3']], offset: item.view.spec?.offset || 0,
      limit: item.view.spec?.limit || 25, hasMore: false, scannedRows: 1, truncated: false };
    const bytes = raster ? new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGOQS7nzHwAEYAJeiHDUBAAAAABJRU5ErkJggg==', 'base64'))
      : new TextEncoder().encode(canonicalSnapshotJson(table));
    if (raster) item.source.format = { id: 'org.w3.png', version: '1' };
    const { viewSha256: _previous, ...view } = item.view; void _previous;
    Object.assign(view, { family: raster ? 'image' : 'table', spec: raster ? null : view.spec,
      blobSha256: hash(bytes), blobBytes: bytes.byteLength, width: raster ? 1 : null, height: raster ? 1 : null });
    item.view = { ...view, viewSha256: hash(canonicalAnalysisSnapshotResultView({ ...view, source: { artifactId: item.source.artifactId,
      versionId: item.source.versionId, projectId: snapshotScope.projectId, sha256: item.source.sha256 } })) };
    bodies.set(item.viewId, { bytes, type: raster ? 'image/png' : 'application/json' });
  });
  const source = { bytes: new TextEncoder().encode(canonicalNotebookContent(savedSnapshotContent)), type: 'application/json' };
  readSnapshotPreparationView.mockImplementation((_project, _analysis, _resource, descriptor) => Promise.resolve(bodies.get(descriptor.viewId)));
  readSnapshotPreparationDocument.mockResolvedValue(source);
  return { value, bodies, source, props: { ...snapshotScope, resourceId: value.preparationId, snapshotSha256: hash(canonicalSnapshotJson(value.package)),
    snapshot: value.package, availability: value.availability, available: true, isActive: true, onDenied: vi.fn(), onUnavailable: vi.fn() } };
}
beforeEach(() => {
  vi.resetAllMocks(); vi.stubGlobal('crypto', webcrypto); useExecutionTarget.mockReturnValue(connection);
  let sequence = 0; vi.stubGlobal('URL', Object.assign(class extends NativeURL {}, { createObjectURL: vi.fn(() => `blob:shared-${++sequence}`), revokeObjectURL: vi.fn() }));
});
afterEach(() => vi.unstubAllGlobals());

it('renders just the selected fixed finding, keeps supporting source lazy, and returns keyboard focus to the finding selection', async () => {
  const value = fixture(); render(<RetainedSnapshotFindings {...value.props} />);
  await screen.findByRole('cell', { name: 'retained donor 1' });
  expect(screen.getAllByLabelText('Retained prepared finding')).toHaveLength(1); expect(readSnapshotPreparationView).toHaveBeenCalledOnce();
  expect(readSnapshotPreparationDocument).not.toHaveBeenCalled(); expect(screen.queryByRole('button', { name: 'Next rows' })).not.toBeInTheDocument();
  expect(screen.queryByRole('combobox', { name: 'Rows per page' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /2\. Finding 2 exact caption/ }));
  await screen.findByRole('cell', { name: 'retained donor 2' }); expect(screen.queryByRole('cell', { name: 'retained donor 1' })).not.toBeInTheDocument();
  expect(readSnapshotPreparationView).toHaveBeenCalledTimes(2);
  await waitFor(() => expect(within(screen.getByLabelText('Retained prepared finding')).getByRole('heading', { name: 'Finding 2 exact caption' })).toHaveFocus());
  fireEvent.click(screen.getByRole('button', { name: 'Back to retained findings' })); expect(screen.getByLabelText('Retained finding selection')).toHaveFocus();
  fireEvent.click(screen.getByRole('button', { name: 'View supporting source' }));
  expect((await screen.findByLabelText('Retained saved source')).textContent).toBe(savedSnapshotContent.cells[0].source);
  expect(readSnapshotPreparationDocument).toHaveBeenCalledOnce();
});

it('keeps selected finding and exact source through equal package/availability refresh without duplicate reads', async () => {
  const value = fixture(), view = render(<RetainedSnapshotFindings {...value.props} />);
  await screen.findByRole('table'); fireEvent.click(screen.getByRole('button', { name: /2\. Finding 2 exact caption/ })); await screen.findByRole('cell', { name: 'retained donor 2' });
  fireEvent.click(screen.getByRole('button', { name: 'View supporting source' })); await screen.findByLabelText('Retained saved source');
  view.rerender(<RetainedSnapshotFindings {...value.props} snapshot={structuredClone(value.props.snapshot)} availability={structuredClone(value.props.availability)} onUnavailable={vi.fn()} />);
  await act(async () => {}); expect(screen.getByRole('button', { name: /2\. Finding 2 exact caption/ })).toHaveAttribute('aria-pressed', 'true');
  expect(readSnapshotPreparationView).toHaveBeenCalledTimes(2); expect(readSnapshotPreparationDocument).toHaveBeenCalledOnce();
});

it('preserves supplied context, literal notes and prerequisites without rendering code or duplicating the analysis header', async () => {
  const value = fixture(); render(<RetainedSnapshotFindings {...value.props} />); await screen.findByRole('table');
  expect(screen.getByText('<script>private note</script>')).toBeVisible(); expect(document.querySelector('script')).toBeNull();
  expect(screen.getByText('Supplied compute need · compute')).toBeVisible(); expect(screen.getByText('An independently available R environment.')).toBeVisible();
  expect(screen.queryByRole('heading', { name: value.props.snapshot.analysis.name })).not.toBeInTheDocument();
  expect(screen.getByText('Supplied context and exact view')).toBeVisible(); expect(screen.getByText('Original source SHA-256')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Run|Publish|Save changes/ })).not.toBeInTheDocument();
});

it('fails closed on absent availability rows while keeping unaffected retained findings inspectable', async () => {
  const value = fixture(); value.props.availability.views.shift(); value.props.availability.documents = [];
  render(<RetainedSnapshotFindings {...value.props} />);
  expect(await screen.findByText('This retained view is unavailable. Its exact saved identity is kept and has not been regenerated.')).toBeVisible();
  expect(screen.getByText('This retained supporting source is unavailable. Its exact saved identity is kept and has not been regenerated.')).toBeVisible();
  expect(readSnapshotPreparationView).not.toHaveBeenCalled(); expect(screen.queryByRole('button', { name: 'View supporting source' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /2\. Finding 2 exact caption/ })); await screen.findByRole('cell', { name: 'retained donor 2' });
  expect(readSnapshotPreparationView).toHaveBeenCalledOnce(); expect(readSnapshotPreparationDocument).not.toHaveBeenCalled();
});

it('uses public readers for a different current viewer while rendering the same immutable scientific package', async () => {
  const value = fixture(), readView = vi.fn().mockImplementation((_p, _a, _id, item) => Promise.resolve(value.bodies.get(item.viewId))), readDocument = vi.fn().mockResolvedValue(value.source);
  render(<RetainedSnapshotFindings {...value.props} userId={8} audience="project-publication" resourceId={publicId} readView={readView} readDocument={readDocument} />);
  await screen.findByRole('table'); expect(readSnapshotPreparationView).not.toHaveBeenCalled(); expect(readSnapshotPreparationDocument).not.toHaveBeenCalled();
  expect(readView.mock.calls[0][2]).toBe(publicId); expect(readDocument).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'View supporting source' })); await screen.findByLabelText('Retained saved source');
  expect(readDocument.mock.calls[0][2]).toBe(publicId); expect(readSnapshotPreparationDocument).not.toHaveBeenCalled();
});

it('clears private bodies and source-open state when the identical package is opened through publication authority', async () => {
  const value = fixture(), publicRead = deferred(), readView = vi.fn().mockReturnValue(publicRead.promise), readDocument = vi.fn().mockResolvedValue(value.source);
  const view = render(<RetainedSnapshotFindings {...value.props} />); await screen.findByRole('table');
  fireEvent.click(screen.getByRole('button', { name: 'View supporting source' })); await screen.findByLabelText('Retained saved source');
  view.rerender(<RetainedSnapshotFindings {...value.props} audience="project-publication" resourceId={publicId} readView={readView} readDocument={readDocument} />);
  expect(screen.queryByRole('table')).not.toBeInTheDocument(); expect(screen.queryByLabelText('Retained saved source')).not.toBeInTheDocument();
  expect(readDocument).not.toHaveBeenCalled(); await act(async () => publicRead.resolve(value.bodies.get(value.props.snapshot.results[0].viewId)));
  expect(await screen.findByRole('table')).toBeVisible(); expect(screen.getByRole('button', { name: 'View supporting source' })).toBeVisible();
});

it.each(['package', 'availability'])('withdrawal without a %s unmounts a held public result and source so late bytes cannot restore the package', async removed => {
  const value = fixture(), result = deferred(), source = deferred(), readView = vi.fn().mockReturnValue(result.promise), readDocument = vi.fn().mockReturnValue(source.promise);
  const props = { ...value.props, audience: 'project-publication', resourceId: publicId, readView, readDocument };
  const view = render(<RetainedSnapshotFindings {...props} />); await screen.findByRole('button', { name: 'View supporting source' });
  fireEvent.click(screen.getByRole('button', { name: 'View supporting source' })); await waitFor(() => expect(readDocument).toHaveBeenCalledOnce());
  const resultSignal = readView.mock.calls[0][4].signal, sourceSignal = readDocument.mock.calls[0][4].signal;
  view.rerender(<RetainedSnapshotFindings {...props} {...(removed === 'package' ? { snapshot: null } : { availability: null })} />);
  expect(resultSignal.aborted).toBe(true); expect(sourceSignal.aborted).toBe(true);
  await act(async () => { result.resolve(value.bodies.get(value.props.snapshot.results[0].viewId)); source.resolve(value.source); });
  expect(screen.queryByLabelText('Retained finding selection')).not.toBeInTheDocument(); expect(screen.queryByRole('table')).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Retained saved source')).not.toBeInTheDocument(); expect(value.props.onDenied).not.toHaveBeenCalled();
});

it('revokes a selected retained figure URL when current publication policy removes its package', async () => {
  const value = fixture({ image: true }), readView = vi.fn().mockImplementation((_p, _a, _id, item) => Promise.resolve(value.bodies.get(item.viewId)));
  const props = { ...value.props, audience: 'project-publication', resourceId: publicId, readView };
  const view = render(<RetainedSnapshotFindings {...props} />); await screen.findByRole('table');
  fireEvent.click(screen.getByRole('button', { name: /2\. Finding 2 exact caption/ })); await screen.findByRole('img');
  view.rerender(<RetainedSnapshotFindings {...props} snapshot={null} availability={null} />);
  expect(screen.queryByRole('img')).not.toBeInTheDocument(); expect(screen.queryByRole('link', { name: 'Open full-size image' })).not.toBeInTheDocument();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:shared-1');
});

it('displays no protected finding metadata or lazy source for an unrecognized audience', async () => {
  const value = fixture(); render(<RetainedSnapshotFindings {...value.props} audience="public-internet" />);
  expect(screen.getByRole('alert')).toHaveTextContent('audience could not be verified');
  expect(screen.queryByText('Finding 1 exact caption')).not.toBeInTheDocument(); await act(async () => {});
  expect(readSnapshotPreparationView).not.toHaveBeenCalled(); expect(readSnapshotPreparationDocument).not.toHaveBeenCalled();
});

it.each(['viewer', 'resource', 'snapshot'])('does not carry a prior selected finding or opened source into a changed %s scope', async change => {
  const value = fixture(), view = render(<RetainedSnapshotFindings {...value.props} />); await screen.findByRole('table');
  fireEvent.click(screen.getByRole('button', { name: /2\. Finding 2 exact caption/ })); await screen.findByRole('cell', { name: 'retained donor 2' });
  fireEvent.click(screen.getByRole('button', { name: 'View supporting source' })); await screen.findByLabelText('Retained saved source');
  const changed = change === 'viewer' ? { userId: 8 } : change === 'resource' ? { resourceId: 'asp_' + 'e'.repeat(24) } : { snapshotSha256: 'e'.repeat(64) };
  view.rerender(<RetainedSnapshotFindings {...value.props} {...changed} />);
  await screen.findByRole('cell', { name: 'retained donor 1' }); expect(screen.getByRole('button', { name: /1\. Finding 1 exact caption/ })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.queryByLabelText('Retained saved source')).not.toBeInTheDocument(); expect(readSnapshotPreparationDocument).toHaveBeenCalledOnce();
});
