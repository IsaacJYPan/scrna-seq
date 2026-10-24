import React from 'react';
import { webcrypto } from 'node:crypto';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import AnalysisSnapshotPreparations from './AnalysisSnapshotPreparations';
import { snapshotScope as scope, snapshotRecipe, snapshotRecord, snapshotList, snapshotOptions,
  snapshotAnalysisOption, snapshotResultOption } from './snapshotPreparationTestFixtures';
import { linkedRecord } from './snapshotLinkedTestFixtures';
import { typedDescriptor, typedOptions, typedRecord } from './snapshotTypedTestFixtures';
import { workflowSnapshotReference, workflowOffer, workflowSelection, workflowRecipe, workflowRecord, workflowOptions } from './snapshotWorkflowTestFixtures';
import { embeddingRecipe, embeddingRecord, embeddingOptions } from './snapshotEmbeddingTestFixtures';

// Keep the actual transport, target fence, canonical helpers and strict validators.
vi.mock('../api', () => ({ apiUrl: value => value }));
vi.mock('./PreparedSnapshotResult', () => ({ default: props => props.available && props.isActive
  ? <div data-testid="prepared-result"><span>{props.descriptor.viewId}</span><button type="button" onClick={props.onDenied}>Revoke retained result access</button></div> : null }));
vi.mock('./PreparedSnapshotSource', () => ({ default: props => props.available && props.isActive ? <div data-testid="prepared-source">{props.descriptor.title}</div> : null }));

const base = `/api/projects/${scope.projectId}/analyses/${scope.analysisId}/snapshot-preparations`;
const propsFor = changes => ({ projectId: scope.projectId, analysisId: scope.analysisId, userId: scope.userId,
  savedAnalysis: { ...snapshotAnalysisOption(2), id: scope.analysisId }, canWrite: true, available: true, isActive: true,
  overviewDirty: false, onBack: vi.fn(), onReturnToSave: vi.fn(), ...changes });
const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const failure = (status, code) => json({ code, error: 'A safe server refusal.' }, status);
let state;
function writes(kind = 'prepare') {
  return state.requests.filter(request => kind === 'prepare' ? request.method === 'POST' && request.pathname === base
    : kind === 'resume' ? request.method === 'POST' && request.pathname.endsWith('/resume') : request.method === 'DELETE');
}
function observe(value) {
  return { ...structuredClone(value), canPrepare: state.allowed, canResume: state.allowed && ['preparing', 'failed'].includes(value.state) };
}
const recordFactory = recipe => recipe.results.some(item => item.view.family === 'embedding') ? embeddingRecord
  : recipe.results.some(item => item.kind === 'captured-workflow-output') || recipe.prerequisites.some(item => item.kind === 'captured-workflow-reference') ? workflowRecord
  : recipe.results.some(item => item.kind === 'typed-analysis-reference') ? typedRecord
  : recipe.schema === 'traceomics.analysis-snapshot-preparation.v2' ? linkedRecord : snapshotRecord;
async function server(request) {
  if (request.method === 'GET' && request.pathname === base + '/options') {
    if (request.query.get('kind') === 'captured-workflow-outputs') return state.onCapturedOptions ? state.onCapturedOptions(request)
      : workflowOptions({ analysisVersion: Number(request.query.get('analysisVersion')), canPrepare: state.allowed,
        snapshotReference: workflowSnapshotReference({ snapshotId: request.query.get('snapshotId'), sha256: request.query.get('snapshotSha256') }) });
    if (request.query.get('kind') === 'analysis-typed-references') return state.onTypedOptions ? state.onTypedOptions(request)
      : snapshotOptions('analysis-typed-references', state.allowed, [], Number(request.query.get('analysisVersion')));
    if (request.query.get('kind') === 'analysis-references') return state.onLinkedOptions ? state.onLinkedOptions(request)
      : snapshotOptions('analysis-references', state.allowed, [], Number(request.query.get('analysisVersion')));
    if (state.onOptions) return state.onOptions(request);
    return snapshotOptions(request.query.get('kind'), state.allowed);
  }
  if (request.method === 'GET' && request.pathname === base) {
    if (state.onList) return state.onList(request);
    return snapshotList([...state.records.values()], state.allowed);
  }
  if (request.method === 'GET' && request.pathname.startsWith(base + '/requests/')) {
    if (state.onRead) return state.onRead(request);
    const value = state.records.get(request.pathname.split('/').at(-1));
    return value ? observe(value) : failure(404, 'ANALYSIS_SNAPSHOT_PREPARATION_NOT_FOUND');
  }
  if (request.method === 'POST' && request.pathname === base) {
    if (state.onPrepare) return state.onPrepare(request);
    const factory = recordFactory(request.body);
    const value = factory(request.body, { canPrepare: state.allowed }); state.records.set(value.requestId, value); return value;
  }
  if (request.method === 'POST' && request.pathname.endsWith('/resume')) {
    if (state.onResume) return state.onResume(request);
    const previous = state.records.get(request.body.requestId), factory = recordFactory(previous.recipe);
    const value = factory(previous.recipe, { canPrepare: state.allowed, preparationId: previous.preparationId });
    state.records.set(value.requestId, value); return value;
  }
  if (request.method === 'DELETE') {
    if (state.onDelete) return state.onDelete(request);
    const previous = state.records.get(request.body.requestId), factory = recordFactory(previous.recipe);
    const value = factory(previous.recipe, { state: 'deleted', canPrepare: state.allowed, preparationId: previous.preparationId });
    state.records.set(value.requestId, value); return value;
  }
  throw new Error('Unexpected snapshot test request: ' + request.method + ' ' + request.pathname);
}
async function frame(props = propsFor()) {
  const view = render(<AnalysisSnapshotPreparations {...props} />);
  await waitFor(() => expect(state.requests.some(request => request.pathname === base && request.method === 'GET')).toBe(true));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh access and saved preparations' })).toBeEnabled());
  return { ...view, props };
}
async function choose() {
  fireEvent.click(await screen.findByRole('button', { name: 'Add table excerpt' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Prepare private preview' })).toBeEnabled());
}
async function submit() {
  fireEvent.click(screen.getByRole('button', { name: 'Prepare private preview' }));
  await waitFor(() => expect(writes()).toHaveLength(1)); return writes()[0].body;
}
async function reviewSaved(props = propsFor()) {
  const view = await frame(props);
  if (screen.queryByRole('button', { name: 'Saved preparations' })) fireEvent.click(screen.getByRole('button', { name: 'Saved preparations' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Open private preparation' }));
  await screen.findByText('Original preparation checked. Checking does not build or share anything.');
  return view;
}
beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto); delete window.desktopShell;
  state = { allowed: true, records: new Map(), requests: [] };
  vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
    const parsed = new URL(url, 'http://localhost'), request = { pathname: parsed.pathname, query: parsed.searchParams,
      method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : undefined, signal: options.signal };
    state.requests.push(request); const result = await server(request); return result instanceof Response ? result : json(result);
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); delete window.desktopShell; });

const linkedOption = (version = 2, changes = {}) => ({ reference: { kind: 'artifact-version', versionId: 'av_' + String(version).repeat(24), sha256: 'a'.repeat(64) },
  label: `Linked measured result for version ${version}`, viewFamily: 'table', referenceOnlyReason: null,
  integrity: 'not-checked', availability: 'not-checked', ...changes });

function offerCaptured({ family = 'table', offer = workflowOffer(), reason = null } = {}) {
  state.onLinkedOptions = request => snapshotOptions('analysis-references', state.allowed, [linkedOption(2, { reference: workflowSnapshotReference(),
    label: 'Saved workflow capture', viewFamily: null, referenceOnlyReason: 'opaque' })], Number(request.query.get('analysisVersion')));
  state.onCapturedOptions = request => workflowOptions({ family, offer, reason, analysisVersion: Number(request.query.get('analysisVersion')), canPrepare: state.allowed,
    snapshotReference: workflowSnapshotReference({ snapshotId: request.query.get('snapshotId'), sha256: request.query.get('snapshotSha256') }) });
}
async function inspectCaptured() {
  if (!screen.queryByRole('button', { name: 'Hide captured outputs', exact: true })) fireEvent.click(await screen.findByRole('button', { name: 'Inspect captured outputs', exact: true }));
  return screen.findByRole('list', { name: 'Recorded workflow outputs' });
}
async function addCaptured(family = 'table') {
  const list = await inspectCaptured(), label = family === 'table' ? 'Add captured table excerpt' : family === 'metrics' ? 'Add captured metrics' : family === 'embedding' ? 'Add captured embedding' : 'Add captured figure';
  fireEvent.click(await within(list).findByRole('button', { name: label, exact: true }));
  return screen.getByRole('group', { name: 'Recorded context for linked finding 1' });
}

function offerEmbedding({ captured = false } = {}) {
  state.onTypedOptions = request => embeddingOptions({ analysisVersion: Number(request.query.get('analysisVersion')), canPrepare: state.allowed });
  if (captured) {
    const typed = state.onTypedOptions; offerCaptured(); state.onTypedOptions = typed;
    state.onCapturedOptions = request => embeddingOptions({ captured: true, analysisVersion: Number(request.query.get('analysisVersion')), canPrepare: state.allowed,
      snapshotReference: workflowSnapshotReference({ snapshotId: request.query.get('snapshotId'), sha256: request.query.get('snapshotSha256') }) });
  }
}

it('starts a direct embedding at an explicit 2000-point bound and preserves that bound in the accepted exact intent', async () => {
  offerEmbedding(); await frame(); fireEvent.click(await screen.findByRole('button', { name: 'Add linked embedding', exact: true }));
  expect(screen.getByRole('spinbutton', { name: 'Maximum included points for linked finding 1' })).toHaveValue(2000);
  expect(writes()).toHaveLength(0); const submitted = await submit(); await screen.findByTestId('prepared-result');
  const option = embeddingOptions().items[0];
  expect(submitted.results).toEqual([{ kind: 'typed-analysis-reference', reference: option.reference, descriptorSha256: option.descriptorSha256,
    caption: option.label, view: { family: 'embedding', pointLimit: 2000 } }]);
  expect(state.records.get(submitted.requestId).package.results[0].view.spec).toEqual({ pointLimit: 2000 });
  expect(state.requests.every(request => request.pathname === base || request.pathname === base + '/options')).toBe(true);
});

it('prepares distinct direct five-point and captured nine-point samples without confusing the sampling bound with the recorded seed', async () => {
  offerEmbedding({ captured: true }); await frame(); fireEvent.click(await screen.findByRole('button', { name: 'Add linked embedding', exact: true }));
  fireEvent.change(screen.getByRole('spinbutton', { name: 'Maximum included points for linked finding 1' }), { target: { value: '5' } });
  const outputs = await inspectCaptured(); fireEvent.click(await within(outputs).findByRole('button', { name: 'Add captured embedding', exact: true }));
  const context = screen.getByRole('group', { name: 'Recorded context for linked finding 2' });
  expect(within(context).getAllByRole('checkbox').every(node => !node.checked)).toBe(true);
  fireEvent.click(within(context).getByRole('checkbox', { name: /^Include recorded seed/ }));
  fireEvent.change(screen.getByRole('spinbutton', { name: 'Maximum included points for linked finding 2' }), { target: { value: '9' } });
  const submitted = await submit(); await screen.findByTestId('prepared-result');
  expect(submitted.results.map(item => [item.kind, item.view])).toEqual([
    ['typed-analysis-reference', { family: 'embedding', pointLimit: 5 }], ['captured-workflow-output', { family: 'embedding', pointLimit: 9 }],
  ]);
  expect(submitted.results[1].contextSelection).toEqual(workflowSelection({ seed: true }));
  expect(submitted.results[1].contextSha256).toBe(embeddingRecipe({ captured: true, pointLimit: 9, selection: workflowSelection({ seed: true }) }).results[0].contextSha256);
  expect(state.records.get(submitted.requestId).package.results.map(item => item.view.spec.pointLimit)).toEqual([5, 9]);
  expect(state.requests.every(request => request.pathname === base || request.pathname === base + '/options')).toBe(true);
});

it('preserves a separate point bound and caption for each chosen saved analysis version', async () => {
  offerEmbedding(); await frame(); fireEvent.click(await screen.findByRole('button', { name: 'Add linked embedding', exact: true }));
  fireEvent.change(screen.getByRole('spinbutton', { name: 'Maximum included points for linked finding 1' }), { target: { value: '5' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Caption for linked finding 1' }), { target: { value: 'Original five points' } });
  fireEvent.click(screen.getByRole('radio', { name: /Saved version 1/ }));
  fireEvent.click(await screen.findByRole('button', { name: 'Add linked embedding', exact: true }));
  fireEvent.change(screen.getByRole('spinbutton', { name: 'Maximum included points for linked finding 1' }), { target: { value: '9' } });
  fireEvent.click(screen.getByRole('radio', { name: /Saved version 2/ }));
  expect(screen.getByRole('spinbutton', { name: 'Maximum included points for linked finding 1' })).toHaveValue(5);
  expect(screen.getByRole('textbox', { name: 'Caption for linked finding 1' })).toHaveValue('Original five points');
  const submitted = await submit(); await screen.findByTestId('prepared-result');
  expect(submitted.analysisVersion).toBe(2); expect(submitted.results[0].view.pointLimit).toBe(5);
});

it('allows different embedding bounds but rejects an edited duplicate source and bound before any preparation POST', async () => {
  offerEmbedding(); await frame(); const add = await screen.findByRole('button', { name: 'Add linked embedding', exact: true }); fireEvent.click(add);
  expect(add).toBeDisabled(); fireEvent.change(screen.getByRole('spinbutton', { name: 'Maximum included points for linked finding 1' }), { target: { value: '5' } });
  expect(add).toBeEnabled(); fireEvent.click(add);
  fireEvent.change(screen.getByRole('spinbutton', { name: 'Maximum included points for linked finding 2' }), { target: { value: '5' } });
  fireEvent.submit(screen.getByRole('form', { name: 'Prepare private snapshot' })); await screen.findByRole('alert'); expect(writes()).toHaveLength(0);
  fireEvent.change(screen.getByRole('spinbutton', { name: 'Maximum included points for linked finding 2' }), { target: { value: '9' } });
  const submitted = await submit(); await screen.findByTestId('prepared-result');
  expect(submitted.results.map(item => item.view.pointLimit)).toEqual([5, 9]);
});

it.each([0, 5001, 1.5])('refuses an invalid embedding bound of %s even when native form validation is bypassed', async pointLimit => {
  offerEmbedding(); await frame(); fireEvent.click(await screen.findByRole('button', { name: 'Add linked embedding', exact: true }));
  fireEvent.change(screen.getByRole('spinbutton', { name: 'Maximum included points for linked finding 1' }), { target: { value: String(pointLimit) } });
  fireEvent.submit(screen.getByRole('form', { name: 'Prepare private snapshot' })); await screen.findByRole('alert'); expect(writes()).toHaveLength(0);
  expect(screen.queryByRole('button', { name: 'Retry original preparation' })).not.toBeInTheDocument();
});

it('recovers the original accepted embedding bound after a lost reply despite later chooser metadata', async () => {
  offerEmbedding(); state.onPrepare = request => { const value = embeddingRecord(request.body); state.records.set(value.requestId, value); throw new Error('Accepted reply lost.'); };
  await frame(); fireEvent.click(await screen.findByRole('button', { name: 'Add linked embedding', exact: true }));
  fireEvent.change(screen.getByRole('spinbutton', { name: 'Maximum included points for linked finding 1' }), { target: { value: '5' } });
  const submitted = await submit(); await screen.findByRole('alert');
  state.onTypedOptions = () => embeddingOptions({ items: [] });
  fireEvent.click(screen.getByRole('button', { name: 'Check original preparation' })); await screen.findByTestId('prepared-result');
  expect(state.records.get(submitted.requestId).recipe.results[0].view).toEqual({ family: 'embedding', pointLimit: 5 }); expect(writes()).toHaveLength(1);
});

it.each(['table', 'metrics', 'image'])('discovers a captured %s only after explicit expansion and prepares exact all-off context without opening a working workflow', async family => {
  offerCaptured({ family }); await frame(); await screen.findByRole('button', { name: 'Inspect captured outputs' });
  expect(state.requests.some(request => request.query.get('kind') === 'captured-workflow-outputs')).toBe(false);
  const context = await addCaptured(family); expect(within(context).getAllByRole('checkbox').every(node => !node.checked)).toBe(true);
  expect(writes()).toHaveLength(0); const submitted = await submit(); await screen.findByTestId('prepared-result');
  const expected = { ...workflowRecipe({ family }).results[0], caption: workflowOptions({ family }).items[0].outputLabel }; expect(submitted.results).toEqual([expected]);
  expect(submitted.results[0].contextSelection).toEqual(workflowSelection()); expect(submitted.results[0].contextSha256).toMatch(/^[a-f0-9]{64}$/);
  const discovery = state.requests.filter(request => request.query.get('kind') === 'captured-workflow-outputs');
  expect(discovery).toHaveLength(1); expect(discovery[0].query.get('analysisVersion')).toBe('2');
  expect(discovery[0].query.get('snapshotId')).toBe(workflowSnapshotReference().snapshotId); expect(discovery[0].query.get('snapshotSha256')).toBe(workflowSnapshotReference().sha256);
  expect(state.requests.every(request => request.pathname === base || request.pathname === base + '/options')).toBe(true);
});

it('includes only deliberately selected recorded settings with false, zero, seed zero and exact environment context SHA', async () => {
  offerCaptured(); await frame(); const context = await addCaptured();
  for (const name of ['Include recorded method', 'Include recorded seed', 'Include recorded environment reference']) fireEvent.click(within(context).getByRole('checkbox', { name: new RegExp('^' + name) }));
  for (const key of ['include-empty', 'min-cells', 'mode']) fireEvent.click(within(context).getByRole('checkbox', { name: `Include ${key} for linked finding 1` }));
  const selection = workflowSelection({ method: true, parameterKeys: ['include-empty', 'min-cells', 'mode'], seed: true, environment: true });
  const submitted = await submit(); await screen.findByTestId('prepared-result');
  expect(submitted.results[0].contextSelection).toEqual(selection);
  expect(submitted.results[0].contextSha256).toBe(workflowRecipe({ selection }).results[0].contextSha256);
  const captured = state.records.get(submitted.requestId).package.results[0].origin.context;
  expect(captured.parameters.map(item => item.value)).toEqual([false, 0, 'paired']); expect(captured.seed).toBe(0);
  expect(captured.environment).toEqual(workflowOffer().environment); expect(captured.method.name).toBe('Condition counts');
  expect(writes()).toHaveLength(1);
});

it('keeps captured context choices separate per saved version and retains the reviewed offer through later metadata refresh', async () => {
  offerCaptured(); await frame(); const context = await addCaptured();
  fireEvent.click(within(context).getByRole('checkbox', { name: 'Include min-cells for linked finding 1' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Caption for linked finding 1' }), { target: { value: 'Interpretation of the old capture' } });
  fireEvent.click(screen.getByRole('radio', { name: /Saved version 1/ }));
  expect(screen.queryByRole('textbox', { name: 'Caption for linked finding 1' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('radio', { name: /Saved version 2/ }));
  expect(screen.getByRole('textbox', { name: 'Caption for linked finding 1' })).toHaveValue('Interpretation of the old capture');
  expect(screen.getByRole('checkbox', { name: 'Include min-cells for linked finding 1' })).toBeChecked();
  state.onCapturedOptions = request => workflowOptions({ analysisVersion: Number(request.query.get('analysisVersion')),
    offer: workflowOffer({ parameters: [{ key: 'min-cells', type: 'integer', label: 'Later offered count', value: 99 }] }) });
  await inspectCaptured(); fireEvent.click(screen.getByRole('button', { name: 'Refresh captured outputs' }));
  await waitFor(() => expect(state.requests.filter(request => request.query.get('kind') === 'captured-workflow-outputs')).toHaveLength(2));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh captured outputs' })).toBeEnabled());
  const selectedContext = screen.getByRole('group', { name: 'Recorded context for linked finding 1' });
  expect(within(selectedContext).getByRole('checkbox', { name: 'Include min-cells for linked finding 1' }).closest('label')).toHaveTextContent('Minimum cells');
  expect(selectedContext).not.toHaveTextContent('Later offered count');
  const submitted = await submit(); await screen.findByTestId('prepared-result');
  expect(submitted.results[0].contextSha256).toBe(workflowRecipe({ selection: workflowSelection({ parameterKeys: ['min-cells'] }) }).results[0].contextSha256);
  expect(submitted.analysisVersion).toBe(2);
});

it('keeps captured reference-only outputs from counting as findings or disclosing recorded settings', async () => {
  offerCaptured({ reason: 'restricted-or-unavailable' }); await frame(); const list = await inspectCaptured();
  fireEvent.click(await within(list).findByRole('button', { name: 'Include captured reference only' }));
  expect(screen.getByRole('button', { name: 'Prepare private preview' })).toBeDisabled();
  expect(screen.queryByRole('group', { name: /Recorded context for/ })).not.toBeInTheDocument();
  expect(within(list).queryByRole('button', { name: /Add captured/ })).not.toBeInTheDocument(); await choose();
  const submitted = await submit(); await screen.findByTestId('prepared-result');
  expect(submitted.results[0].kind).toBe('attachment-revision'); expect(submitted.prerequisites[0]).toMatchObject({ kind: 'captured-workflow-reference',
    snapshotReference: workflowSnapshotReference(), stepId: 'counts', port: 'values' });
  expect(submitted.prerequisites[0]).not.toHaveProperty('context'); expect(writes()).toHaveLength(1);
});

it('keeps each captured excerpt bound to its own reviewed offer when another excerpt is added after refreshed context', async () => {
  offerCaptured(); await frame(); const first = await addCaptured();
  fireEvent.click(within(first).getByRole('checkbox', { name: 'Include min-cells for linked finding 1' }));
  const laterOffer = workflowOffer({ parameters: [{ key: 'min-cells', type: 'integer', label: 'Later reviewed count', value: 99 }] });
  state.onCapturedOptions = () => workflowOptions({ offer: laterOffer });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh captured outputs' }));
  await waitFor(() => expect(state.requests.filter(request => request.query.get('kind') === 'captured-workflow-outputs')).toHaveLength(2));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh captured outputs' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Add captured table excerpt' }));
  const second = screen.getByRole('group', { name: 'Recorded context for linked finding 2' });
  fireEvent.click(within(second).getByRole('checkbox', { name: 'Include min-cells for linked finding 2' }));
  expect(first).toHaveTextContent('Minimum cells'); expect(first).not.toHaveTextContent('Later reviewed count'); expect(second).toHaveTextContent('Later reviewed count');
  state.onPrepare = () => failure(409, 'ANALYSIS_SNAPSHOT_SOURCE_CONTEXT_CHANGED');
  const submitted = await submit(); await screen.findByRole('alert');
  const selection = workflowSelection({ parameterKeys: ['min-cells'] });
  expect(submitted.results[0].contextSha256).toBe(workflowRecipe({ selection }).results[0].contextSha256);
  expect(submitted.results[1].contextSha256).toBe(workflowRecipe({ selection, offer: laterOffer }).results[0].contextSha256);
  expect(submitted.results[0].contextSha256).not.toBe(submitted.results[1].contextSha256);
  for (const result of submitted.results) {
    expect(Object.keys(result).sort()).toEqual(['kind', 'snapshotReference', 'stepId', 'port', 'reference', 'descriptorSha256', 'caption', 'view', 'contextSelection', 'contextSha256'].sort());
    expect(result).not.toHaveProperty('offerId'); expect(result).not.toHaveProperty('contextOffer');
  }
});

it('keeps existing attached, direct flat and typed branches literal when mixed with an explicitly selected captured output', async () => {
  offerCaptured(); const capturedLinked = state.onLinkedOptions;
  state.onLinkedOptions = request => { const options = capturedLinked(request); options.items.push(linkedOption(2)); return options; };
  state.onTypedOptions = () => typedOptions({ descriptor: typedDescriptor({ id: 'eri_' + 'a'.repeat(24) }) }); await frame(); await choose();
  const linked = screen.getByRole('list', { name: 'Linked saved references' });
  fireEvent.click(await within(within(linked).getByText('Linked measured result for version 2').closest('li')).findByRole('button', { name: 'Add linked table excerpt' }));
  fireEvent.click(await within(within(linked).getByText('Recorded typed measured result').closest('li')).findByRole('button', { name: 'Add linked table excerpt' }));
  const outputs = await inspectCaptured(); fireEvent.click(await within(outputs).findByRole('button', { name: 'Add captured table excerpt' }));
  const submitted = await submit(); await screen.findAllByTestId('prepared-result');
  expect(submitted.results.map(item => item.kind)).toEqual(['attachment-revision', 'analysis-reference', 'typed-analysis-reference', 'captured-workflow-output']);
  expect(submitted.results[1]).not.toHaveProperty('descriptorSha256'); expect(submitted.results[2]).not.toHaveProperty('contextSelection');
  expect(submitted.results[3].contextSelection).toEqual(workflowSelection()); expect(submitted.results[3].contextSha256).toBe(workflowRecipe().results[0].contextSha256);
});

it('keeps a missing captured source local to its chooser without revoking unrelated selected analysis findings', async () => {
  offerCaptured(); await frame(); await choose(); state.onCapturedOptions = () => failure(404, 'ANALYSIS_SNAPSHOT_SOURCE_CAPTURE_UNAVAILABLE');
  await inspectCaptured(); await screen.findByRole('alert');
  expect(screen.getByRole('form', { name: 'Prepare private snapshot' })).toBeVisible(); expect(screen.getByRole('list', { name: 'Selected snapshot findings' })).toHaveTextContent('measured.csv');
  expect(screen.getByRole('button', { name: 'Prepare private preview' })).toBeEnabled(); expect(screen.getByRole('button', { name: 'Refresh captured outputs' })).toBeEnabled();
  expect(screen.queryByText('Access to this private preparation is unavailable. Reconnect to the same workspace and refresh.')).not.toBeInTheDocument(); expect(writes()).toHaveLength(0);
});

it('ignores an old capture reply after switching the chosen saved analysis version', async () => {
  offerCaptured(); const held = deferred(); state.onCapturedOptions = () => held.promise;
  await frame(); await inspectCaptured(); await waitFor(() => expect(state.requests.some(request => request.query.get('kind') === 'captured-workflow-outputs')).toBe(true));
  const request = state.requests.find(value => value.query.get('kind') === 'captured-workflow-outputs');
  fireEvent.click(screen.getByRole('radio', { name: /Saved version 1/ })); expect(request.signal.aborted).toBe(true);
  await act(async () => held.resolve(workflowOptions()));
  expect(screen.queryByRole('button', { name: 'Add captured table excerpt' })).not.toBeInTheDocument(); expect(writes()).toHaveLength(0);
});

function holdFirstCapturedContextHash() {
  const held = deferred(), actual = webcrypto.subtle.digest.bind(webcrypto.subtle); let pending;
  vi.stubGlobal('crypto', { randomUUID: webcrypto.randomUUID.bind(webcrypto), subtle: { digest: (algorithm, bytes) => {
    if (!pending && new TextDecoder().decode(bytes).includes('traceomics.captured-workflow-context-binding.v1')) {
      pending = { algorithm, bytes: new Uint8Array(bytes) }; return held.promise;
    }
    return actual(algorithm, bytes);
  } } });
  return { wait: async () => waitFor(() => expect(pending).toBeTruthy()), release: async () => held.resolve(await actual(pending.algorithm, pending.bytes)) };
}

it.each(['navigation', 'read-only'])('does not submit after %s changes while the selected captured context SHA is being computed', async change => {
  offerCaptured(); await frame(); await addCaptured(); const hold = holdFirstCapturedContextHash();
  fireEvent.click(screen.getByRole('button', { name: 'Prepare private preview' })); await hold.wait();
  if (change === 'navigation') fireEvent.click(screen.getByRole('button', { name: 'Saved preparations' }));
  else { state.allowed = false; fireEvent.click(screen.getByRole('button', { name: 'Refresh access and saved preparations' })); await screen.findByText(/New previews require write access/); }
  await act(async () => hold.release()); expect(writes()).toHaveLength(0);
  if (change === 'navigation') expect(screen.getByRole('region', { name: 'Your private preparations' })).toBeVisible();
  else expect(screen.getByRole('button', { name: 'Prepare private preview' })).toBeDisabled();
});

it('recovers an accepted captured preparation after a lost reply without computing new context or issuing a second prepare', async () => {
  offerCaptured(); state.onPrepare = request => { const value = workflowRecord(request.body); state.records.set(value.requestId, value); throw new Error('Accepted reply lost.'); };
  await frame(); await addCaptured(); const original = await submit(); await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: 'Check original preparation' })); await screen.findByTestId('prepared-result');
  expect(writes()).toHaveLength(1); expect(state.records.get(original.requestId).recipe.results[0].contextSha256).toBe(original.results[0].contextSha256);
  expect(screen.queryByRole('button', { name: 'Retry original preparation' })).not.toBeInTheDocument();
});

it('retries a genuinely missing captured preparation only with its original UUID and context-bound body', async () => {
  offerCaptured(); state.onPrepare = request => { if (writes().length === 1) throw new Error('The request never arrived.'); const value = workflowRecord(request.body); state.records.set(value.requestId, value); return value; };
  await frame(); await addCaptured(); const original = await submit(); await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: 'Check original preparation' })); await screen.findByRole('button', { name: 'Retry original preparation' });
  fireEvent.click(screen.getByRole('button', { name: 'Retry original preparation' })); await screen.findByTestId('prepared-result');
  expect(writes()).toHaveLength(2); expect(writes()[1].body).toEqual(original);
});

it.each(['table', 'metrics', 'image'])('merges duplicate linked metadata into one typed %s choice and submits its exact descriptor intent only on request', async family => {
  const options = typedOptions({ family }), option = options.items[0];
  state.onTypedOptions = () => options;
  state.onLinkedOptions = request => snapshotOptions('analysis-references', true, [linkedOption(2, { reference: option.reference,
    label: 'Duplicate generic choice', viewFamily: family === 'image' ? 'image' : null, referenceOnlyReason: family === 'image' ? null : 'unsupported-view' })], Number(request.query.get('analysisVersion')));
  await frame(); const label = family === 'table' ? 'Add linked table excerpt' : family === 'metrics' ? 'Add linked metrics' : 'Add linked figure';
  const button = await screen.findByRole('button', { name: label, exact: true });
  expect(screen.getAllByRole('list', { name: 'Linked saved references' })[0].children).toHaveLength(1);
  expect(screen.queryByText('Duplicate generic choice')).not.toBeInTheDocument(); expect(writes()).toHaveLength(0);
  fireEvent.click(button); fireEvent.change(screen.getByRole('textbox', { name: 'Caption for linked finding 1' }), { target: { value: 'Supplied exact typed interpretation' } });
  if (family === 'table') fireEvent.change(screen.getByRole('spinbutton', { name: 'Rows to include for linked finding 1' }), { target: { value: '1' } });
  const original = await submit(); await screen.findByTestId('prepared-result');
  expect(original.results).toEqual([{ kind: 'typed-analysis-reference', reference: option.reference, descriptorSha256: option.descriptorSha256,
    caption: 'Supplied exact typed interpretation', view: family === 'table' ? { family, offset: 0, limit: 1 } : { family } }]);
  expect(original.schema).toBe('traceomics.analysis-snapshot-preparation.v2'); expect(original.analysisVersion).toBe(2); expect(writes()).toHaveLength(1);
  expect(state.requests.every(request => request.pathname === base || request.pathname === base + '/options')).toBe(true);
});

it('keeps a selected descriptor SHA frozen when fresh metadata records new meaning under the same source checksum', async () => {
  const original = typedOptions({ family: 'metrics' }), changedDescriptor = typedDescriptor({ type: 'metrics', semantics: {
    role: 'diagnostic', title: 'A later recorded interpretation', metrics: { nCells: { label: 'Later cells', unit: 'cells' } } } });
  let options = original; state.onTypedOptions = () => options;
  await frame(); fireEvent.click(await screen.findByRole('button', { name: 'Add linked metrics' }));
  options = typedOptions({ family: 'metrics', descriptor: changedDescriptor });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh linked references' })); await screen.findByText('A later recorded interpretation', { exact: true });
  const selected = screen.getByText('Selected descriptor identity').closest('details'); selected.open = true;
  expect(selected).toHaveTextContent(original.items[0].descriptorSha256); expect(selected).not.toHaveTextContent(options.items[0].descriptorSha256);
  state.onPrepare = () => failure(409, 'ANALYSIS_SNAPSHOT_SOURCE_DESCRIPTOR_CHANGED');
  const submitted = await submit(); await screen.findByRole('alert');
  expect(submitted.results[0].descriptorSha256).toBe(original.items[0].descriptorSha256);
  expect(submitted.results[0].reference.sha256).toBe(options.items[0].reference.sha256);
  expect(screen.getByRole('button', { name: 'Check original preparation' })).toBeEnabled();
  expect(screen.queryByRole('button', { name: 'Retry original preparation' })).not.toBeInTheDocument();
});

it('starts a new table excerpt at row one when the same refreshed reference was previously selected as metrics', async () => {
  const original = typedOptions({ family: 'metrics' }), metadata = original.items[0].descriptor;
  let options = original; state.onTypedOptions = () => options;
  await frame(); fireEvent.click(await screen.findByRole('button', { name: 'Add linked metrics' }));
  options = typedOptions({ descriptor: typedDescriptor({ id: metadata.id, sha256: metadata.sha256, sizeBytes: metadata.sizeBytes, type: 'table' }) });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh linked references' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Add linked table excerpt' }));
  expect(screen.getByRole('spinbutton', { name: 'First data row for linked finding 2' })).toHaveValue(1);
  expect(screen.getByRole('spinbutton', { name: 'Rows to include for linked finding 2' })).toHaveValue(25);
  expect(writes()).toHaveLength(0);
});

function holdFirstTypedDescriptorHash() {
  const held = deferred(), actual = webcrypto.subtle.digest.bind(webcrypto.subtle); let pending;
  vi.stubGlobal('crypto', { randomUUID: webcrypto.randomUUID.bind(webcrypto), subtle: { digest: (algorithm, bytes) => {
    if (!pending && new TextDecoder().decode(bytes).includes('traceomics.retained-output-descriptor.v1')) {
      pending = { algorithm, bytes: new Uint8Array(bytes) }; return held.promise;
    }
    return actual(algorithm, bytes);
  } } });
  return { wait: async () => waitFor(() => expect(pending).toBeTruthy()), release: async () => held.resolve(await actual(pending.algorithm, pending.bytes)) };
}

it('fences an old saved version while its typed descriptor verification is actually awaiting WebCrypto', async () => {
  const hold = holdFirstTypedDescriptorHash();
  state.onTypedOptions = request => {
    const version = Number(request.query.get('analysisVersion')), options = typedOptions({ analysisVersion: version });
    options.items[0].label = `Typed result from saved version ${version}`; return options;
  };
  await frame(); await hold.wait();
  fireEvent.click(screen.getByRole('radio', { name: /Saved version 1/ })); await screen.findByText('Typed result from saved version 1');
  await act(async () => hold.release()); expect(screen.queryByText('Typed result from saved version 2')).not.toBeInTheDocument();
  expect(state.requests.filter(request => request.query.get('kind') === 'analysis-typed-references').map(request => request.query.get('analysisVersion'))).toEqual(['2', '1']);
  expect(writes()).toHaveLength(0);
});

it('does not let a held positive typed descriptor validation restore writes after fresh current read-only discovery', async () => {
  const hold = holdFirstTypedDescriptorHash(); state.onTypedOptions = () => typedOptions();
  await frame(); await hold.wait(); await choose(); state.allowed = false;
  fireEvent.click(screen.getByRole('button', { name: 'Refresh access and saved preparations' }));
  await screen.findByText('New previews require write access to an active analysis. You can still recover your own saved preparations.');
  await act(async () => hold.release());
  expect(screen.getByRole('button', { name: 'Prepare private preview' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Add linked table excerpt' })).toBeDisabled(); expect(writes()).toHaveLength(0);
});

it('keeps linked caption, row window and reference-only selections separate for each saved analysis version', async () => {
  state.onLinkedOptions = request => {
    const version = Number(request.query.get('analysisVersion'));
    return snapshotOptions('analysis-references', true, [linkedOption(version)], version);
  };
  const storage = vi.spyOn(Storage.prototype, 'setItem'); await frame();
  let linked = await screen.findByRole('region', { name: 'Linked in saved analysis 2', exact: true });
  fireEvent.click(await within(linked).findByRole('button', { name: 'Add linked table excerpt', exact: true }));
  fireEvent.change(within(linked).getByRole('textbox', { name: 'Caption for linked finding 1' }), { target: { value: 'Keep my old-version interpretation' } });
  fireEvent.change(within(linked).getByRole('spinbutton', { name: 'First data row for linked finding 1' }), { target: { value: '8' } });
  fireEvent.click(within(linked).getByRole('button', { name: 'Include reference only', exact: true }));
  fireEvent.change(within(linked).getByRole('textbox', { name: 'Note for linked prerequisite 1' }), { target: { value: 'The contents require a separate data agreement.' } });
  fireEvent.click(screen.getByRole('radio', { name: /Saved version 1/ }));
  linked = screen.getByRole('region', { name: 'Linked in saved analysis 1', exact: true });
  expect(within(linked).queryByRole('textbox', { name: 'Caption for linked finding 1' })).not.toBeInTheDocument();
  fireEvent.click(await within(linked).findByRole('button', { name: 'Add linked table excerpt', exact: true }));
  expect(within(linked).getByRole('textbox', { name: 'Caption for linked finding 1' })).toHaveValue('Linked measured result for version 1');
  fireEvent.click(screen.getByRole('radio', { name: /Saved version 2/ }));
  linked = screen.getByRole('region', { name: 'Linked in saved analysis 2', exact: true });
  expect(within(linked).getByRole('textbox', { name: 'Caption for linked finding 1' })).toHaveValue('Keep my old-version interpretation');
  expect(within(linked).getByRole('spinbutton', { name: 'First data row for linked finding 1' })).toHaveValue(8);
  expect(within(linked).getByRole('textbox', { name: 'Note for linked prerequisite 1' })).toHaveValue('The contents require a separate data agreement.');
  expect(writes()).toHaveLength(0); expect(storage).not.toHaveBeenCalled();
});

it('fences a late linked-options reply and can explicitly revisit a version whose earlier load was aborted', async () => {
  const held = deferred(); let olderCalls = 0;
  state.onLinkedOptions = request => {
    const version = Number(request.query.get('analysisVersion'));
    if (version === 2 && ++olderCalls === 1) return held.promise;
    return snapshotOptions('analysis-references', true, [linkedOption(version)], version);
  };
  await frame(); await waitFor(() => expect(olderCalls).toBe(1));
  fireEvent.click(screen.getByRole('radio', { name: /Saved version 1/ }));
  await screen.findByText('Linked measured result for version 1', { exact: true });
  await act(async () => held.resolve(snapshotOptions('analysis-references', true, [linkedOption(2)], 2)));
  expect(screen.queryByText('Linked measured result for version 2', { exact: true })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('radio', { name: /Saved version 2/ }));
  await screen.findByText('Linked measured result for version 2', { exact: true });
  expect(olderCalls).toBe(2); expect(writes()).toHaveLength(0);
});

it('keeps restricted prerequisites inert and requires an actual finding before preparation', async () => {
  const option = linkedOption(2, { label: 'Saved linked reference', viewFamily: null, referenceOnlyReason: 'restricted-or-unavailable' });
  state.onLinkedOptions = request => snapshotOptions('analysis-references', true, [option], Number(request.query.get('analysisVersion')));
  await frame(); const linked = screen.getByRole('region', { name: 'Linked in saved analysis 2', exact: true });
  fireEvent.click(await within(linked).findByRole('button', { name: 'Include reference only', exact: true }));
  expect(within(linked).queryByRole('button', { name: /Add linked/ })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Prepare private preview', exact: true })).toBeDisabled();
  expect(within(linked).getByText('Contents not included. Integrity not checked. Data access not granted. These references do not count as retained findings.', { exact: true })).toBeVisible();
  await choose(); expect(screen.getByRole('button', { name: 'Prepare private preview', exact: true })).toBeEnabled();
  expect(state.requests.every(request => request.method === 'GET' && (request.pathname === base || request.pathname === base + '/options'))).toBe(true);
  expect(writes()).toHaveLength(0);
});

it('loads another saved version after a source-choice service failure while preserving unsent selections', async () => {
  state.onLinkedOptions = request => {
    const version = Number(request.query.get('analysisVersion'));
    return version === 2 ? failure(503, 'TEMPORARY_FAILURE') : snapshotOptions('analysis-references', true, [linkedOption(version)], version);
  };
  await frame(); await screen.findByRole('alert'); await choose();
  fireEvent.click(screen.getByRole('radio', { name: /Saved version 1/ }));
  await screen.findByText('Linked measured result for version 1', { exact: true });
  expect(screen.getByRole('list', { name: 'Selected snapshot findings' })).toHaveTextContent('measured.csv');
  expect(screen.getByRole('button', { name: 'Prepare private preview', exact: true })).toBeEnabled();
  expect(writes()).toHaveLength(0);
});

it('submits one explicit mixed v2 intent with supplied captions and reference-only prerequisites, keeping attached context exact', async () => {
  const restricted = linkedOption(4, { label: 'Saved restricted reference', viewFamily: null, referenceOnlyReason: 'restricted-or-unavailable' });
  state.onLinkedOptions = request => snapshotOptions('analysis-references', true, [linkedOption(2), restricted], Number(request.query.get('analysisVersion')));
  await frame(); await choose(); const linked = screen.getByRole('region', { name: 'Linked in saved analysis 2', exact: true });
  fireEvent.click(await within(linked).findByRole('button', { name: 'Add linked table excerpt', exact: true }));
  fireEvent.change(within(linked).getByRole('textbox', { name: 'Caption for linked finding 1' }), { target: { value: '  Supplied snapshot finding\nwith context  ' } });
  fireEvent.click(within(screen.getByText('Saved restricted reference', { exact: true }).closest('li')).getByRole('button', { name: 'Include reference only', exact: true }));
  const intent = await submit(); await screen.findByTestId('prepared-result');
  expect(intent).toMatchObject({ schema: 'traceomics.analysis-snapshot-preparation.v2', analysisVersion: 2,
    results: [{ kind: 'attachment-revision', attachmentId: snapshotResultOption().attachmentId },
      { kind: 'analysis-reference', reference: linkedOption(2).reference, caption: 'Supplied snapshot finding\nwith context', view: { family: 'table', offset: 0, limit: 25 } }],
    prerequisites: [{ kind: 'analysis-reference', reference: restricted.reference, label: restricted.label, detail: null }] });
  expect(screen.getByRole('region', { name: 'Reference-only prerequisites', exact: true })).toHaveTextContent('Contents not included. Integrity not checked. Data access not granted.');
  expect(writes()).toHaveLength(1);
});

it('retries only the original normalized v2 selection after a genuine missing check with the same UUID and body', async () => {
  state.onLinkedOptions = request => snapshotOptions('analysis-references', true, [linkedOption(2)], Number(request.query.get('analysisVersion')));
  state.onPrepare = request => {
    if (writes().length === 1) throw new Error('The original request did not reach acceptance.');
    const record = linkedRecord(request.body); state.records.set(record.requestId, record); return record;
  };
  await frame(); const linked = screen.getByRole('region', { name: 'Linked in saved analysis 2', exact: true });
  fireEvent.click(await within(linked).findByRole('button', { name: 'Add linked table excerpt', exact: true }));
  const original = await submit(); await screen.findByRole('alert');
  expect(screen.queryByRole('button', { name: 'Retry original preparation', exact: true })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Check original preparation', exact: true }));
  await screen.findByRole('button', { name: 'Retry original preparation', exact: true });
  fireEvent.click(screen.getByRole('button', { name: 'Retry original preparation', exact: true })); await screen.findByTestId('prepared-result');
  expect(writes()).toHaveLength(2); expect(writes()[1].body).toEqual(original);
  expect(original.schema).toBe('traceomics.analysis-snapshot-preparation.v2');
});

it('creates only an exact owner/service-bound private recipe and keeps selected source and supplied notes distinct', async () => {
  const storage = vi.spyOn(Storage.prototype, 'setItem'); await frame(); await choose();
  fireEvent.click(screen.getByText('Notes and reproduction prerequisites (optional)'));
  fireEvent.change(screen.getByRole('textbox', { name: 'Summary (optional)' }), { target: { value: '  Measured observations\r\nfor review  ' } });
  fireEvent.click(screen.getByRole('checkbox', { name: /Supporting saved notebook/ }));
  const recipe = await submit(); await screen.findByTestId('prepared-result');
  expect(recipe).toMatchObject({ serviceId: scope.serviceId, projectId: scope.projectId, analysisId: scope.analysisId, ownerUserId: scope.userId, analysisVersion: 2,
    results: [{ attachmentId: snapshotResultOption().attachmentId, revisionId: snapshotResultOption().revisionId, reference: snapshotResultOption().reference, view: { family: 'table', offset: 0, limit: 25 } }],
    notes: { summary: 'Measured observations\nfor review', decisions: null, limitations: null } });
  expect(recipe.documents).toHaveLength(1); expect(screen.getByText('Private preparation. Publishing is a separate action.')).toBeVisible();
  expect(writes('resume')).toHaveLength(0); expect(writes('delete')).toHaveLength(0); expect(storage).not.toHaveBeenCalled();
  expect(state.requests.every(request => request.pathname.startsWith(base))).toBe(true);
  expect(screen.queryByRole('button', { name: /publish|run|execute/i })).not.toBeInTheDocument();
});

it('does not automatically prepare or resume when reopening a saved candidate', async () => {
  const value = snapshotRecord(snapshotRecipe(), { state: 'preparing' }); state.records.set(value.requestId, value);
  const view = await reviewSaved(); expect(screen.getByRole('button', { name: 'Resume original preparation' })).toBeEnabled();
  expect(writes()).toHaveLength(0); expect(writes('resume')).toHaveLength(0);
  view.unmount(); await reviewSaved(); expect(writes()).toHaveLength(0); expect(writes('resume')).toHaveLength(0);
});

it('requires an explicit genuine missing-receipt check before retrying the identical original UUID/body', async () => {
  state.onPrepare = async request => {
    if (writes().length === 1) throw new Error('Lost before acceptance.');
    const value = snapshotRecord(request.body); state.records.set(value.requestId, value); return value;
  };
  await frame(); await choose(); const recipe = await submit(); await screen.findByRole('alert');
  expect(screen.queryByRole('button', { name: 'Retry original preparation' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Check original preparation' }));
  await screen.findByRole('button', { name: 'Retry original preparation' }); expect(writes()).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Retry original preparation' })); await screen.findByTestId('prepared-result');
  expect(writes()).toHaveLength(2); expect(writes()[1].body).toEqual(recipe);
});

it('recovers an admitted original after lost acknowledgement without another preparation', async () => {
  state.onPrepare = async request => { const value = snapshotRecord(request.body); state.records.set(value.requestId, value); throw new Error('Accepted reply was lost.'); };
  await frame(); await choose(); await submit(); await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: 'Check original preparation' })); await screen.findByTestId('prepared-result');
  expect(writes()).toHaveLength(1); expect(writes('resume')).toHaveLength(0);
});

it('requires an actual 404 with the exact missing code before retrying an original preparation', async () => {
  state.onPrepare = request => {
    if (writes().length === 1) throw new Error('Lost before acceptance.');
    const value = snapshotRecord(request.body); state.records.set(value.requestId, value); return value;
  };
  state.onRead = () => failure(500, 'ANALYSIS_SNAPSHOT_PREPARATION_NOT_FOUND');
  await frame(); await choose(); const original = await submit(); await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: 'Check original preparation' }));
  await waitFor(() => expect(state.requests.filter(request => request.pathname === base + '/requests/' + original.requestId)).toHaveLength(1));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Check original preparation' })).toBeEnabled());
  expect(screen.queryByRole('button', { name: 'Retry original preparation' })).not.toBeInTheDocument(); expect(writes()).toHaveLength(1);
  state.onRead = undefined; fireEvent.click(screen.getByRole('button', { name: 'Check original preparation' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Retry original preparation' })); await screen.findByTestId('prepared-result');
  expect(writes()).toHaveLength(2); expect(writes()[1].body).toEqual(original);
});

it.each(['result', 'document'])('keeps exact ready identity while blocking an unavailable retained %s body', async kind => {
  const value = snapshotRecord(snapshotRecipe()), originalHash = value.snapshotSha256;
  value.availability.status = 'unavailable';
  if (kind === 'result') value.availability.views[0].status = 'unavailable';
  else value.availability.documents[0].status = 'unavailable';
  state.records.set(value.requestId, value); await reviewSaved();
  await screen.findByText('Ready for private review');
  expect(screen.getByText(originalHash)).toBeInTheDocument();
  expect(screen.getByText((_, node) => node.tagName === 'P' && /unavailable/i.test(node.textContent) && /regenerat/i.test(node.textContent))).toBeVisible();
  expect(screen.queryByTestId(kind === 'result' ? 'prepared-result' : 'prepared-source')).not.toBeInTheDocument();
  expect(await screen.findByTestId(kind === 'result' ? 'prepared-source' : 'prepared-result')).toBeInTheDocument();
  expect(state.records.get(value.requestId).snapshotSha256).toBe(originalHash); expect(writes()).toHaveLength(0); expect(writes('resume')).toHaveLength(0);
});

it('never enables a retry after an unreadable GET or inconsistent accepted receipt', async () => {
  state.onPrepare = async () => { throw new Error('Unknown completion'); };
  state.onRead = async () => { const wrong = snapshotRecord(snapshotRecipe()); wrong.requestSha256 = '0'.repeat(64); return wrong; };
  await frame(); await choose(); await submit(); await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: 'Check original preparation' }));
  await waitFor(() => expect(state.requests.filter(request => request.pathname.includes('/requests/'))).toHaveLength(1));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Check original preparation' })).toBeEnabled());
  expect(screen.queryByRole('button', { name: 'Retry original preparation' })).not.toBeInTheDocument(); expect(writes()).toHaveLength(1);
});

it('pins saved analysis N when the working overview advances and excludes unsaved overview text', async () => {
  const { rerender, props } = await frame(propsFor({ overviewDirty: true })); await choose();
  expect(screen.getByText('Unsaved overview edits are excluded from this preview.')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Return to save changes' })); expect(props.onReturnToSave).toHaveBeenCalledOnce();
  expect(writes()).toHaveLength(0);
  rerender(<AnalysisSnapshotPreparations {...props} savedAnalysis={{ ...props.savedAnalysis, version: 3, name: 'Later unsaved overview name' }} />);
  const recipe = await submit(); await screen.findByTestId('prepared-result'); expect(recipe.analysisVersion).toBe(2);
  expect(screen.getByText('PBMC saved question 2')).toBeVisible(); expect(screen.queryByText('Later unsaved overview name')).not.toBeInTheDocument();
  expect(screen.getByText(/Your overview now shows another saved version/)).toBeVisible();
});

it('allows distinct fixed excerpts from the same CSV and preserves their exact chosen windows', async () => {
  await frame(); await choose(); fireEvent.click(screen.getByRole('button', { name: 'Add table excerpt' }));
  fireEvent.change(screen.getByRole('spinbutton', { name: 'First data row for finding 1' }), { target: { value: '13' } });
  const recipe = await submit(); await screen.findByTestId('prepared-result');
  expect(recipe.results.map(result => result.view)).toEqual([{ family: 'table', offset: 12, limit: 25 }, { family: 'table', offset: 25, limit: 25 }]);
  expect(recipe.results[0].reference).toEqual(recipe.results[1].reference);
});

it('fences an older prepare acknowledgement after a newer reader-only authority observation', async () => {
  const held = deferred(); let accepted;
  state.onPrepare = request => { accepted = snapshotRecord(request.body); state.records.set(accepted.requestId, accepted); return held.promise; };
  await frame(); await choose(); await submit(); state.allowed = false;
  fireEvent.click(screen.getByRole('button', { name: 'Refresh access and saved preparations' }));
  await waitFor(() => expect(screen.queryByText('Preparing the exact private preview…')).not.toBeInTheDocument());
  await act(async () => held.resolve(accepted));
  expect(screen.queryByTestId('prepared-result')).not.toBeInTheDocument(); expect(writes()).toHaveLength(1);
  expect(screen.queryByRole('button', { name: 'Retry original preparation' })).not.toBeInTheDocument();
});

it('fences an older positive access preflight before it can POST after a newer reader observation', async () => {
  await frame(); await choose(); const held = deferred(); let calls = 0;
  state.onList = () => ++calls === 1 ? held.promise : snapshotList([], false);
  fireEvent.click(screen.getByRole('button', { name: 'Prepare private preview' }));
  await screen.findByText('Checking current access…'); fireEvent.click(screen.getByRole('button', { name: 'Refresh access and saved preparations' }));
  await waitFor(() => expect(screen.queryByText('Checking current access…')).not.toBeInTheDocument());
  await act(async () => held.resolve(snapshotList([], true))); expect(writes()).toHaveLength(0);
});

it('fences a held resume acknowledgement after current access becomes read-only', async () => {
  const value = snapshotRecord(snapshotRecipe(), { state: 'preparing' }); state.records.set(value.requestId, value);
  const held = deferred(); state.onResume = () => held.promise;
  await reviewSaved(); fireEvent.click(screen.getByRole('button', { name: 'Resume original preparation' }));
  await waitFor(() => expect(writes('resume')).toHaveLength(1)); state.allowed = false;
  fireEvent.click(screen.getByRole('button', { name: 'Refresh access and saved preparations' }));
  await waitFor(() => expect(screen.queryByText('Resuming the exact private preparation…')).not.toBeInTheDocument());
  await act(async () => held.resolve(snapshotRecord(value.recipe)));
  expect(screen.queryByTestId('prepared-result')).not.toBeInTheDocument(); expect(writes('resume')).toHaveLength(1);
});

it('allows a current reader to delete only their retained private copies', async () => {
  state.allowed = false; const value = snapshotRecord(snapshotRecipe(), { canPrepare: false }); state.records.set(value.requestId, value);
  await reviewSaved(propsFor({ canWrite: false })); await screen.findByTestId('prepared-result');
  fireEvent.click(screen.getByRole('button', { name: 'Remove private preparation' })); fireEvent.click(screen.getByRole('button', { name: 'Remove private preparation' }));
  await screen.findByText('Private preparation removed'); expect(screen.queryByTestId('prepared-result')).not.toBeInTheDocument();
  expect(writes('delete')[0].body).toEqual({ requestId: value.requestId, requestSha256: value.requestSha256 });
  expect(writes()).toHaveLength(0); expect(writes('resume')).toHaveLength(0);
});

it('hides old retained bodies while deletion completion is unconfirmed and recovers its tombstone', async () => {
  const value = snapshotRecord(snapshotRecipe()); state.records.set(value.requestId, value);
  state.onDelete = () => { state.records.set(value.requestId, snapshotRecord(value.recipe, { state: 'deleted' })); throw new Error('Deletion accepted but acknowledgement lost.'); };
  await reviewSaved(); await screen.findByTestId('prepared-result');
  fireEvent.click(screen.getByRole('button', { name: 'Remove private preparation' })); fireEvent.click(screen.getByRole('button', { name: 'Remove private preparation' }));
  await screen.findByRole('alert'); expect(screen.queryByTestId('prepared-result')).not.toBeInTheDocument(); expect(screen.queryByText('Measured expression contrast')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Check original preparation' })); await screen.findByText('Private preparation removed');
  expect(writes('delete')).toHaveLength(1); expect(writes()).toHaveLength(0);
});

it('keeps a source-specific chooser failure local without revoking owned preparation access or unsent choices', async () => {
  await frame(); await choose();
  state.onOptions = request => request.query.get('kind') === 'results' ? failure(404, 'ANALYSIS_SNAPSHOT_SOURCE_UNAVAILABLE') : snapshotOptions(request.query.get('kind'));
  fireEvent.click(within(screen.getByRole('region', { name: 'Choose retained findings' })).getByRole('button', { name: 'Refresh saved choices' }));
  await screen.findByRole('alert'); expect(screen.getByRole('spinbutton', { name: 'First data row for finding 1' })).toHaveValue(1);
  expect(screen.getByRole('button', { name: 'Prepare private preview' })).toBeEnabled();
});

it('retains current-reader metadata when only resuming write access is refused', async () => {
  const value = snapshotRecord(snapshotRecipe(), { state: 'preparing' }); state.records.set(value.requestId, value);
  state.onResume = () => { state.allowed = false; return failure(403, 'ANALYSIS_SNAPSHOT_WRITE_REQUIRED'); };
  await reviewSaved(); fireEvent.click(screen.getByRole('button', { name: 'Resume original preparation' })); await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: 'Saved preparations' }));
  expect(await screen.findByText('PBMC saved question 2 · Saved analysis 2')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Open private preparation' })).toBeEnabled(); expect(writes('resume')).toHaveLength(1);
});

it('clears protected bodies on scope404 and ignores an earlier held successful read', async () => {
  const value = snapshotRecord(snapshotRecipe()); state.records.set(value.requestId, value); await reviewSaved(); await screen.findByTestId('prepared-result');
  const held = deferred(); state.onRead = () => held.promise;
  fireEvent.click(screen.getByRole('button', { name: 'Check original preparation' })); await screen.findByText('Checking the original preparation…');
  state.onList = () => failure(404, 'ANALYSIS_SNAPSHOT_SCOPE_NOT_FOUND');
  fireEvent.click(screen.getByRole('button', { name: 'Refresh access and saved preparations' }));
  await screen.findByRole('alert'); expect(screen.queryByTestId('prepared-result')).not.toBeInTheDocument();
  await act(async () => held.resolve(value)); expect(screen.queryByTestId('prepared-result')).not.toBeInTheDocument();
  expect(screen.queryByText('Measured expression contrast')).not.toBeInTheDocument();
});

it('fences child membership revocation and disconnects without automatically rereading or rebuilding', async () => {
  const value = snapshotRecord(snapshotRecipe()); state.records.set(value.requestId, value); const view = await reviewSaved(); await screen.findByTestId('prepared-result');
  fireEvent.click(screen.getByRole('button', { name: 'Revoke retained result access' })); expect(screen.queryByTestId('prepared-result')).not.toBeInTheDocument();
  view.rerender(<AnalysisSnapshotPreparations {...view.props} available={false} />); await screen.findByText(/Reconnect to this workspace/);
  expect(writes()).toHaveLength(0); expect(writes('resume')).toHaveLength(0);
});

it('does not let an older held read steal later navigation or mutate unsent notes', async () => {
  const value = snapshotRecord(snapshotRecipe()); state.records.set(value.requestId, value); await reviewSaved(); await screen.findByTestId('prepared-result');
  const held = deferred(); state.onRead = () => held.promise;
  fireEvent.click(screen.getByRole('button', { name: 'Check original preparation' })); await screen.findByText('Checking the original preparation…');
  fireEvent.click(screen.getByRole('button', { name: 'Saved preparations' })); fireEvent.click(screen.getByRole('button', { name: 'New preparation' }));
  fireEvent.click(screen.getByText('Notes and reproduction prerequisites (optional)'));
  fireEvent.change(screen.getByRole('textbox', { name: 'Summary (optional)' }), { target: { value: 'Later unsent notes' } });
  await act(async () => held.resolve(value)); expect(screen.getByRole('form', { name: 'Prepare private snapshot' })).toBeVisible();
  expect(screen.getByRole('textbox', { name: 'Summary (optional)' })).toHaveValue('Later unsent notes'); expect(screen.queryByTestId('prepared-result')).not.toBeInTheDocument();
  expect(value.recipe.notes.summary).toBeNull(); expect(writes()).toHaveLength(0);
});

it('opens the library immediately for an initially cached writer whose current account is a reader', async () => {
  state.allowed = false; const value = snapshotRecord(snapshotRecipe(), { canPrepare: false }); state.records.set(value.requestId, value);
  await frame(); expect(await screen.findByRole('region', { name: 'Your private preparations' })).toBeVisible();
  expect(screen.queryByRole('form', { name: 'Prepare private snapshot' })).not.toBeInTheDocument(); expect(writes()).toHaveLength(0);
});

it('rejects a held old-account read after the parent replaces its scoped child', async () => {
  const value = snapshotRecord(snapshotRecipe()); state.records.set(value.requestId, value); const view = await reviewSaved(); await screen.findByTestId('prepared-result');
  const held = deferred(); state.onRead = () => held.promise;
  fireEvent.click(screen.getByRole('button', { name: 'Check original preparation' })); await screen.findByText('Checking the original preparation…');
  state.onList = () => ({ ...snapshotList([], false), ownerUserId: 8 });
  view.rerender(<AnalysisSnapshotPreparations key="new-owner" {...view.props} userId={8} canWrite={false} />);
  await screen.findByText('No saved private preparations are available.');
  await act(async () => held.resolve(value));
  expect(screen.queryByTestId('prepared-result')).not.toBeInTheDocument(); expect(screen.queryByText('Measured expression contrast')).not.toBeInTheDocument();
  expect(writes()).toHaveLength(0);
});

it('discards a held read on disconnect and never reopens or rebuilds it on reconnect', async () => {
  const value = snapshotRecord(snapshotRecipe()); state.records.set(value.requestId, value); const view = await reviewSaved(); await screen.findByTestId('prepared-result');
  const held = deferred(); state.onRead = () => held.promise;
  fireEvent.click(screen.getByRole('button', { name: 'Check original preparation' })); await screen.findByText('Checking the original preparation…');
  view.rerender(<AnalysisSnapshotPreparations {...view.props} available={false} />);
  await act(async () => held.resolve(value)); expect(screen.queryByTestId('prepared-result')).not.toBeInTheDocument();
  view.rerender(<AnalysisSnapshotPreparations {...view.props} available />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh access and saved preparations' })).toBeEnabled());
  expect(screen.queryByTestId('prepared-result')).not.toBeInTheDocument(); expect(writes()).toHaveLength(0); expect(writes('resume')).toHaveLength(0);
});
