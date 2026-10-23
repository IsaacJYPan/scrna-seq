import React from 'react';
import { webcrypto } from 'node:crypto';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import AnalysisSnapshotPreparations from './AnalysisSnapshotPreparations';
import { snapshotScope as scope, snapshotRecipe, snapshotRecord, snapshotList, snapshotOptions,
  snapshotAnalysisOption, snapshotResultOption } from './snapshotPreparationTestFixtures';
import { linkedRecord } from './snapshotLinkedTestFixtures';

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
async function server(request) {
  if (request.method === 'GET' && request.pathname === base + '/options') {
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
    const factory = request.body.schema === 'traceomics.analysis-snapshot-preparation.v2' ? linkedRecord : snapshotRecord;
    const value = factory(request.body, { canPrepare: state.allowed }); state.records.set(value.requestId, value); return value;
  }
  if (request.method === 'POST' && request.pathname.endsWith('/resume')) {
    if (state.onResume) return state.onResume(request);
    const previous = state.records.get(request.body.requestId), factory = previous.recipe?.schema === 'traceomics.analysis-snapshot-preparation.v2' ? linkedRecord : snapshotRecord;
    const value = factory(previous.recipe, { canPrepare: state.allowed, preparationId: previous.preparationId });
    state.records.set(value.requestId, value); return value;
  }
  if (request.method === 'DELETE') {
    if (state.onDelete) return state.onDelete(request);
    const previous = state.records.get(request.body.requestId), factory = previous.recipe?.schema === 'traceomics.analysis-snapshot-preparation.v2' ? linkedRecord : snapshotRecord;
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
