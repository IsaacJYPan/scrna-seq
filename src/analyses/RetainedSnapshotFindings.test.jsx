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
import { linkedRecipe, linkedRecord, linkedReference, linkedTableBytes } from './snapshotLinkedTestFixtures';
import { typedDescriptor, typedRecipe, typedRecord, typedTableBytes, typedMetricsBytes, typedImageBytes } from './snapshotTypedTestFixtures';

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
function linkedFixture({ prerequisites = [], referenceReasons = [], caption = 'Caption supplied for a linked result' } = {}) {
  const attachment = { kind: 'attachment-revision', ...snapshotRecipe().results[0] };
  const direct = { kind: 'analysis-reference', reference: linkedReference(), caption, view: { family: 'table', offset: 2, limit: 2 } };
  const record = linkedRecord(linkedRecipe({ results: [attachment, direct], prerequisites }), { referenceReasons });
  readSnapshotPreparationView.mockImplementation((_p, _a, _id, result) => Promise.resolve({ bytes: linkedTableBytes(result), type: 'application/json' }));
  readSnapshotPreparationDocument.mockResolvedValue({ bytes: new TextEncoder().encode(canonicalNotebookContent(savedSnapshotContent)), type: 'application/json' });
  return { record, props: { ...snapshotScope, resourceId: record.preparationId, snapshotSha256: record.snapshotSha256, snapshot: record.package,
    availability: record.availability, available: true, isActive: true, onDenied: vi.fn(), onUnavailable: vi.fn() } };
}
beforeEach(() => {
  vi.resetAllMocks(); vi.stubGlobal('crypto', webcrypto); useExecutionTarget.mockReturnValue(connection);
  let sequence = 0; vi.stubGlobal('URL', Object.assign(class extends NativeURL {}, { createObjectURL: vi.fn(() => `blob:shared-${++sequence}`), revokeObjectURL: vi.fn() }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

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

it.each(['unknown package', 'unknown result origin'])('does not guess historical attachment context for an %s', async invalid => {
  const value = fixture();
  if (invalid === 'unknown package') value.props.snapshot.schema = 'traceomics.analysis-snapshot-package.v99';
  else { value.props.snapshot.schema = 'traceomics.analysis-snapshot-package.v2'; value.props.snapshot.results[0].origin = { kind: 'unsupported-result' }; }
  render(<RetainedSnapshotFindings {...value.props} />);
  expect(screen.getByRole('alert')).toHaveTextContent('context could not be verified');
  expect(screen.queryByLabelText('Retained finding selection')).not.toBeInTheDocument(); await act(async () => {});
  expect(readSnapshotPreparationView).not.toHaveBeenCalled(); expect(readSnapshotPreparationDocument).not.toHaveBeenCalled();
});

it('presents mixed v2 attached and linked findings with honest context and just one checked result body', async () => {
  const value = linkedFixture(); render(<RetainedSnapshotFindings {...value.props} />); await screen.findByRole('table');
  const historical = value.record.package.results[0].origin.attachment;
  expect(within(screen.getByLabelText('Retained prepared finding')).getByRole('heading', { name: historical.caption })).toBeVisible();
  expect(screen.getByText('measured.csv · Saved attachment revision 1')).toBeVisible(); expect(readSnapshotPreparationView).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button', { name: /2\. Caption supplied for a linked result/ }));
  await waitFor(() => expect(readSnapshotPreparationView).toHaveBeenCalledTimes(2));
  const finding = within(screen.getByLabelText('Retained prepared finding'));
  expect(finding.getByRole('heading', { name: 'Caption supplied for a linked result' })).toBeVisible();
  expect(finding.getByText('measured.csv · Linked in saved analysis 2')).toBeVisible(); expect(finding.getByText('Caption supplied for this snapshot.')).toBeVisible();
  expect(finding.queryByText(/Saved attachment revision|Saved revision/)).not.toBeInTheDocument();
  expect(screen.getAllByLabelText('Retained prepared finding')).toHaveLength(1); expect(readSnapshotPreparationDocument).not.toHaveBeenCalled();
});

it('keeps v2 linked caption text inert and exposes only its exact supplied reference and one source checksum under details', async () => {
  const caption = '<script>window.runScience()</script>\nA supplied interpretation', value = linkedFixture({ caption });
  render(<RetainedSnapshotFindings {...value.props} />); await screen.findByRole('table');
  fireEvent.click(screen.getByRole('button', { name: /2\. <script>/ })); await waitFor(() => expect(readSnapshotPreparationView).toHaveBeenCalledTimes(2));
  const panel = screen.getByLabelText('Retained prepared finding'), finding = within(panel); expect(finding.getByRole('heading').textContent).toBe(caption);
  expect(panel.querySelector('script')).toBeNull(); const details = finding.getByText('Supplied context and exact view').closest('details');
  fireEvent.click(finding.getByText('Supplied context and exact view')); details.open = true;
  expect(finding.getByText(value.record.package.results[1].origin.reference.versionId)).toBeVisible();
  expect(finding.getAllByText(value.record.package.results[1].source.sha256)).toHaveLength(1);
  expect(finding.queryByText('Recorded reference SHA-256')).not.toBeInTheDocument();
});

it('retains direct selection and exact source through equal v2 refreshes without reloading checked bodies', async () => {
  const value = linkedFixture(), view = render(<RetainedSnapshotFindings {...value.props} />); await screen.findByRole('table');
  fireEvent.click(screen.getByRole('button', { name: /2\. Caption supplied for a linked result/ })); await waitFor(() => expect(readSnapshotPreparationView).toHaveBeenCalledTimes(2));
  fireEvent.click(screen.getByRole('button', { name: 'View supporting source' })); await screen.findByLabelText('Retained saved source');
  view.rerender(<RetainedSnapshotFindings {...value.props} snapshot={structuredClone(value.props.snapshot)} availability={structuredClone(value.props.availability)} onUnavailable={vi.fn()} />);
  await act(async () => {}); expect(screen.getByRole('button', { name: /2\. Caption supplied for a linked result/ })).toHaveAttribute('aria-pressed', 'true');
  expect(readSnapshotPreparationView).toHaveBeenCalledTimes(2); expect(readSnapshotPreparationDocument).toHaveBeenCalledOnce();
});

it('shows all recorded reference-only reasons and exact checkpoint/workflow identities without granting or reading their contents', async () => {
  const network = vi.spyOn(globalThis, 'fetch');
  const prerequisites = [
    { kind: 'compute', label: 'Supplied computation requirement', detail: 'Use an independently available R environment.' },
    { kind: 'analysis-reference', reference: linkedReference({ versionId: 'av_' + 'b'.repeat(24), sha256: 'b'.repeat(64) }), label: 'A deliberately omitted linked table', detail: null },
    { kind: 'analysis-reference', reference: { kind: 'analysis-object', analysisObjectId: 'ao_' + 'c'.repeat(24), checkpointVersionId: 'art_' + 'c'.repeat(24), sha256: 'c'.repeat(64) }, label: 'Saved checkpoint requirement', detail: 'Object contents must be obtained separately.' },
    { kind: 'analysis-reference', reference: linkedReference({ versionId: 'eri_' + 'd'.repeat(24), sha256: 'd'.repeat(64) }), label: '<img src=x onerror=run()> Supplied restricted reference', detail: 'Availability is not established.' },
    { kind: 'analysis-reference', reference: { kind: 'workflow-snapshot', snapshotId: 'wfs_' + 'e'.repeat(24), sha256: 'e'.repeat(64) }, label: 'Saved workflow reference', detail: null },
  ];
  const value = linkedFixture({ prerequisites, referenceReasons: [null, 'not-included', 'opaque', 'restricted-or-unavailable', 'unsupported-view'] });
  render(<RetainedSnapshotFindings {...value.props} />); await screen.findByRole('table');
  const section = within(screen.getByLabelText('Reference-only prerequisites'));
  expect(section.getByText('Contents not included. Integrity not checked. Data access not granted.')).toBeVisible();
  for (const text of ['Only this saved reference was selected.', 'Object contents are not included.', 'Source access or availability has not been established.', 'This format is not included as a fixed finding.']) expect(section.getByText(text)).toBeVisible();
  expect(section.getByText('<img src=x onerror=run()> Supplied restricted reference')).toBeVisible(); expect(screen.getByLabelText('Reference-only prerequisites').querySelector('img')).toBeNull();
  expect(screen.getByText('Supplied computation requirement · compute')).toBeVisible(); expect(section.queryByText(/checksum verified/)).not.toBeInTheDocument();
  expect(section.queryByRole('button', { name: /Run|Restore|Preview|Download|View/ })).not.toBeInTheDocument();
  const checkpoint = section.getByText('Saved checkpoint requirement').parentElement, exact = within(checkpoint).getByText('Exact saved reference').closest('details'); exact.open = true;
  expect(within(checkpoint).getByText('ao_' + 'c'.repeat(24))).toBeVisible(); expect(within(checkpoint).getByText('art_' + 'c'.repeat(24))).toBeVisible();
  expect(within(checkpoint).getByText('c'.repeat(64))).toBeVisible(); expect(within(checkpoint).getByText('Recorded reference SHA-256')).toBeVisible();
  expect(readSnapshotPreparationView).toHaveBeenCalledOnce(); expect(readSnapshotPreparationView.mock.calls[0][3].viewId).toBe(value.record.package.results[0].viewId);
  expect(readSnapshotPreparationDocument).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
});

it('keeps an unavailable v2 fixed finding distinct from included metadata rather than replacing it with a reference-only preview', async () => {
  const value = linkedFixture({ prerequisites: [{ kind: 'analysis-reference', reference: linkedReference(), label: 'Recorded prerequisite only', detail: null }] });
  value.props.availability.views[1].status = 'unavailable'; render(<RetainedSnapshotFindings {...value.props} />); await screen.findByRole('table');
  fireEvent.click(screen.getByRole('button', { name: /2\. Caption supplied for a linked result/ }));
  expect(screen.getByText('This retained view is unavailable. Its exact saved identity is kept and has not been regenerated.')).toBeVisible();
  expect(screen.queryByRole('table')).not.toBeInTheDocument(); expect(readSnapshotPreparationView).toHaveBeenCalledOnce();
  expect(within(screen.getByLabelText('Reference-only prerequisites')).getByText('Recorded prerequisite only')).toBeVisible();
});

it('removes v2 reference-only metadata and fixed bodies together when publication policy withdraws the package', async () => {
  const value = linkedFixture({ prerequisites: [{ kind: 'analysis-reference', reference: linkedReference(), label: 'Recorded restricted prerequisite', detail: 'Supplied context only.' }] });
  const readView = vi.fn().mockImplementation((_p, _a, _id, result) => Promise.resolve({ bytes: linkedTableBytes(result), type: 'application/json' }));
  const props = { ...value.props, audience: 'project-publication', resourceId: publicId, userId: 17, readView };
  const view = render(<RetainedSnapshotFindings {...props} />); await screen.findByRole('table');
  expect(screen.getByText('Recorded restricted prerequisite')).toBeVisible(); view.rerender(<RetainedSnapshotFindings {...props} snapshot={null} availability={null} />);
  expect(screen.queryByText('Recorded restricted prerequisite')).not.toBeInTheDocument(); expect(screen.queryByRole('table')).not.toBeInTheDocument(); expect(screen.queryByLabelText('Reference-only prerequisites')).not.toBeInTheDocument();
  expect(readView).toHaveBeenCalledOnce(); expect(readSnapshotPreparationDocument).not.toHaveBeenCalled();
});

function typedFindingFixture() {
  const metricDescriptor = typedDescriptor({ type: 'metrics', id: 'eri_' + '7'.repeat(24) });
  const imageDescriptor = typedDescriptor({ type: 'figure', id: 'eri_' + '8'.repeat(24) });
  const recipe = typedRecipe({ results: [typedRecipe().results[0],
    { ...typedRecipe({ family: 'metrics', descriptor: metricDescriptor }).results[0], caption: 'Supplied QC interpretation' },
    { ...typedRecipe({ family: 'image', descriptor: imageDescriptor }).results[0], caption: 'Supplied measured figure interpretation' }] });
  const record = typedRecord(recipe, { descriptors: [typedDescriptor(), metricDescriptor, imageDescriptor] });
  const bodies = new Map(record.package.results.map(result => [result.viewId, {
    bytes: result.view.family === 'metrics' ? typedMetricsBytes(result) : result.view.family === 'image' ? typedImageBytes() : typedTableBytes(result),
    type: result.view.family === 'image' ? 'image/png' : 'application/json',
  }]));
  readSnapshotPreparationView.mockImplementation((_project, _analysis, _preparation, result) => Promise.resolve(bodies.get(result.viewId)));
  return { record, bodies, props: { ...snapshotScope, resourceId: record.preparationId, audience: 'private-preparation', snapshotSha256: record.snapshotSha256,
    snapshot: record.package, availability: record.availability, available: true, isActive: true, onDenied: vi.fn(), onUnavailable: vi.fn() } };
}

it('presents typed findings with supplied captions, frozen declared meaning and exact descriptor identity without inventing workflow capture', async () => {
  const value = typedFindingFixture(); render(<RetainedSnapshotFindings {...value.props} />); await screen.findByRole('table');
  expect(screen.getByRole('heading', { name: 'Recorded scalar table' })).toBeVisible(); expect(readSnapshotPreparationView).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button', { name: /2\. Supplied QC interpretation/ })); await screen.findByLabelText('Saved scalar metrics');
  const section = within(screen.getByLabelText('Retained prepared finding'));
  expect(section.getByRole('heading', { name: 'Supplied QC interpretation' })).toBeVisible();
  expect(section.getByText('recorded.json · Linked in saved analysis 2')).toBeVisible();
  expect(section.getByText('Caption supplied for this snapshot.')).toBeVisible();
  expect(section.getByRole('heading', { name: 'Recorded QC metrics' })).toBeVisible(); expect(section.getByText('Coverage (%)')).toBeVisible();
  expect(section.queryByText(/Saved attachment revision|Saved revision|Producing workflow|Captured settings/)).not.toBeInTheDocument();
  const details = section.getByText('Supplied context and exact view').closest('details'); details.open = true;
  expect(section.getByText('Recorded output descriptor SHA-256')).toBeVisible();
  expect(section.getByText(value.record.package.results[1].view.descriptorSha256)).toBeVisible();
  expect(section.getByText('Original source SHA-256')).toBeVisible(); expect(section.getByText('Retained view SHA-256')).toBeVisible();
  expect(screen.getAllByLabelText('Retained prepared finding')).toHaveLength(1); expect(readSnapshotPreparationView).toHaveBeenCalledTimes(2);
  expect(readSnapshotPreparationDocument).not.toHaveBeenCalled();
});

it('keeps a typed metrics selection and its exact units through equal recovery, then switches to the semantic raster', async () => {
  const value = typedFindingFixture(), view = render(<RetainedSnapshotFindings {...value.props} />); await screen.findByRole('table');
  fireEvent.click(screen.getByRole('button', { name: /2\. Supplied QC interpretation/ })); await screen.findByLabelText('Saved scalar metrics');
  view.rerender(<RetainedSnapshotFindings {...value.props} snapshot={structuredClone(value.props.snapshot)} availability={structuredClone(value.props.availability)} onUnavailable={vi.fn()} />);
  await act(async () => {}); expect(readSnapshotPreparationView).toHaveBeenCalledTimes(2);
  expect(screen.getByRole('button', { name: /2\. Supplied QC interpretation/ })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByText('Coverage (%)')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: /3\. Supplied measured figure interpretation/ })); await screen.findByRole('img');
  expect(screen.getByRole('heading', { name: 'Recorded measured figure' })).toBeVisible(); expect(screen.queryByLabelText('Saved scalar metrics')).not.toBeInTheDocument();
  expect(readSnapshotPreparationView).toHaveBeenCalledTimes(3); expect(readSnapshotPreparationDocument).not.toHaveBeenCalled();
});

it('keeps unavailable typed findings distinct from ordinary reference-only prerequisites and clears both on withdrawal', async () => {
  const value = typedFindingFixture(); value.props.availability.views[1].status = 'unavailable';
  value.props.snapshot.prerequisites.items.push({ kind: 'analysis-reference', reference: linkedReference(), label: 'Declared reference only', detail: null,
    role: 'reference-only', reason: 'not-included', integrity: 'not-checked', dataAccess: 'not-granted' });
  const readView = vi.fn().mockImplementation((_p, _a, _id, result) => Promise.resolve(value.bodies.get(result.viewId)));
  const props = { ...value.props, userId: 17, audience: 'project-publication', resourceId: publicId, readView };
  const view = render(<RetainedSnapshotFindings {...props} />); await screen.findByRole('table');
  fireEvent.click(screen.getByRole('button', { name: /2\. Supplied QC interpretation/ }));
  expect(screen.getByText('This retained view is unavailable. Its exact saved identity is kept and has not been regenerated.')).toBeVisible();
  expect(screen.queryByLabelText('Saved scalar metrics')).not.toBeInTheDocument(); expect(screen.getByText('Declared reference only')).toBeVisible();
  expect(readView).toHaveBeenCalledOnce(); expect(readSnapshotPreparationView).not.toHaveBeenCalled();
  view.rerender(<RetainedSnapshotFindings {...props} snapshot={null} availability={null} />);
  expect(screen.queryByLabelText('Retained finding selection')).not.toBeInTheDocument(); expect(screen.queryByText('Declared reference only')).not.toBeInTheDocument();
});
