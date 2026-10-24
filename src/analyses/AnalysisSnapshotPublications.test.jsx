import React from 'react';
import { webcrypto } from 'node:crypto';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import AnalysisSnapshotPublications from './AnalysisSnapshotPublications';
import { publicationScope, publicationPreparation, publicationFull, publicationList, publicationReceipt, publicationRequests,
  publicationSummary, withdrawalTime } from './snapshotPublicationTestFixtures';
import { snapshotAnalysisOption, snapshotRecipe, snapshotRecord } from './snapshotPreparationTestFixtures';

// Exercise real bounded HTTP, execution-target fences, canonical requests and strict
// response validation. Only the separately tested retained finding body is replaced.
vi.mock('./RetainedSnapshotFindings', () => ({ default: props => {
  if (!props.available || !props.isActive) return null;
  return <section data-testid="published-findings"><p>{props.snapshot.analysis.name}</p>
    <output aria-label="Finding audience and viewer">{props.audience}:{props.resourceId}:{props.userId}</output>
    <button type="button" onClick={() => props.onUnavailable(Object.assign(new Error('retained withdrawn'), { status: 409, code: 'ANALYSIS_SNAPSHOT_PUBLICATION_WITHDRAWN' }))}>Report withdrawn retained view</button>
    <button type="button" onClick={() => props.onUnavailable(Object.assign(new Error('retained publication missing'), { status: 404, code: 'ANALYSIS_SNAPSHOT_PUBLICATION_NOT_FOUND' }))}>Report missing retained publication</button>
    <button type="button" onClick={() => props.onUnavailable(Object.assign(new Error('unconfirmed retained read'), { status: 500, code: 'ANALYSIS_SNAPSHOT_PUBLICATION_NOT_FOUND' }))}>Report unconfirmed retained read</button>
    <button type="button" onClick={() => props.onDenied(Object.assign(new Error('scope denied'), { status: 404, code: 'ANALYSIS_SNAPSHOT_SCOPE_NOT_FOUND' }))}>Report lost project access</button>
  </section>;
} }));

const scope = { ...publicationScope, userId: 7 };
const base = `/api/projects/${scope.projectId}/analyses/${scope.analysisId}/snapshot-publications`;
const preparations = `/api/projects/${scope.projectId}/analyses/${scope.analysisId}/snapshot-preparations`;
const propsFor = changes => ({ projectId: scope.projectId, analysisId: scope.analysisId, userId: scope.userId,
  savedAnalysis: { ...snapshotAnalysisOption(2), id: scope.analysisId }, canWrite: true, available: true, isActive: true, onBack: vi.fn(), ...changes });
const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const failure = (status, code) => json({ code, error: 'Private upstream server path must stay hidden.' }, status);
let state;
const writes = (action = 'publish') => state.requests.filter(request => request.method === 'POST'
  && (action === 'publish' ? request.pathname === base : request.pathname.endsWith('/withdrawals')));
const reads = path => state.requests.filter(request => request.method === 'GET' && request.pathname === path);
const observed = value => ({ ...structuredClone(value), viewerUserId: state.userId, canPublish: state.allowed,
  canWithdraw: value.policy.state === 'published' && (state.userId === value.publisherUserId || state.admin) });
function observedReceipt(value) {
  return { ...structuredClone(value), replayed: true, current: observed(state.publications.get(value.acceptance.publicationId) || value.current) };
}
function acceptPublish(request) {
  const prepared = state.prepared.get(request.body.preparationId);
  const current = publicationFull({ prepared, viewerUserId: state.userId, publisherUserId: state.userId, canPublish: state.allowed });
  state.publications.set(current.publicationId, current);
  const receipt = publicationReceipt({ requestId: request.body.requestId, actorUserId: state.userId, publisherUserId: state.userId, current });
  state.journal.set(receipt.requestId, receipt); return receipt;
}
function acceptWithdrawal(request) {
  const old = state.publications.get(request.body.publicationId), current = { ...observed(old), package: null, availability: null, canWithdraw: false,
    policy: { state: 'withdrawn', version: 2, withdrawnAt: withdrawalTime, withdrawnByUserId: state.userId } };
  state.publications.set(current.publicationId, current);
  const receipt = publicationReceipt({ action: 'withdraw', requestId: request.body.requestId, actorUserId: state.userId, publisherUserId: old.publisherUserId, current });
  state.journal.set(receipt.requestId, receipt); return receipt;
}
async function server(request) {
  if (request.method === 'GET' && request.pathname.startsWith(preparations + '/')) {
    if (state.onPreparation) return state.onPreparation(request);
    const value = state.prepared.get(request.pathname.split('/').at(-1));
    return value ? { ...structuredClone(value), canPrepare: state.allowed } : failure(404, 'ANALYSIS_SNAPSHOT_PREPARATION_NOT_FOUND');
  }
  if (request.method === 'GET' && request.pathname === base) {
    if (state.onList) return state.onList(request);
    return publicationList([...state.publications.values()].map(observed), { scope: { ...scope, userId: state.userId }, canPublish: state.allowed });
  }
  if (request.method === 'GET' && request.pathname === base + '/requests') {
    if (state.onActivity) return state.onActivity(request);
    return publicationRequests([...state.journal.values()].filter(value => value.actorUserId === state.userId).map(observedReceipt), { scope: { ...scope, userId: state.userId } });
  }
  if (request.method === 'GET' && request.pathname.startsWith(base + '/requests/')) {
    if (state.onRequest) return state.onRequest(request);
    const value = state.journal.get(request.pathname.split('/').at(-1));
    return value && value.actorUserId === state.userId ? observedReceipt(value) : failure(404, 'ANALYSIS_SNAPSHOT_PUBLICATION_NOT_FOUND');
  }
  if (request.method === 'GET' && request.pathname.startsWith(base + '/')) {
    if (state.onDetail) return state.onDetail(request);
    const value = state.publications.get(request.pathname.split('/').at(-1));
    return value ? observed(value) : failure(404, 'ANALYSIS_SNAPSHOT_PUBLICATION_NOT_FOUND');
  }
  if (request.method === 'POST' && request.pathname === base) return state.onPublish ? state.onPublish(request) : json(acceptPublish(request), 201);
  if (request.method === 'POST' && request.pathname.endsWith('/withdrawals')) return state.onWithdraw ? state.onWithdraw(request) : acceptWithdrawal(request);
  throw new Error('Unexpected sharing test request: ' + request.method + ' ' + request.pathname);
}
async function frame(props = propsFor()) {
  const view = render(<AnalysisSnapshotPublications {...props} />);
  await waitFor(() => expect(reads(base).length).toBeGreaterThan(0));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh sharing access' })).toBeEnabled());
  return { ...view, props };
}
async function seeded(changes = {}) {
  const prepared = state.prepared.values().next().value;
  const view = await frame(propsFor({ seed: { token: 'seed-one', preparation: prepared }, returnToPreparation: true, ...changes }));
  await screen.findByRole('button', { name: 'Publish to project' }); return view;
}
async function publish() {
  fireEvent.click(screen.getByRole('button', { name: 'Publish to project' }));
  await waitFor(() => expect(writes()).toHaveLength(1)); return writes()[0].body;
}
async function openPublished(index = 0) {
  fireEvent.click((await screen.findAllByRole('button', { name: 'Open published snapshot' }))[index]);
  await screen.findByTestId('published-findings');
}
async function activity() {
  fireEvent.click(screen.getByRole('button', { name: 'Your sharing activity' }));
  await waitFor(() => expect(reads(base + '/requests').length).toBeGreaterThan(0));
}
beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto); delete window.desktopShell;
  const prepared = publicationPreparation(7);
  state = { userId: 7, allowed: true, admin: false, prepared: new Map([[prepared.preparationId, prepared]]), publications: new Map(), journal: new Map(), requests: [] };
  vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
    const parsed = new URL(url, 'http://localhost'), request = { pathname: parsed.pathname, query: parsed.searchParams, method: options.method || 'GET',
      body: options.body ? JSON.parse(options.body) : undefined, signal: options.signal, credentials: options.credentials, headers: options.headers };
    state.requests.push(request); const result = await server(request); return result instanceof Response ? result : json(result);
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); delete window.desktopShell; });

it('freshly verifies the exact acknowledged A seed without automatically publishing and submits only a separate explicit canonical action', async () => {
  const completion = deferred(), prepared = state.prepared.values().next().value; state.onPreparation = () => completion.promise;
  await frame(propsFor({ seed: { token: 'one', preparation: prepared } }));
  await waitFor(() => expect(reads(preparations + '/' + prepared.preparationId)).toHaveLength(1));
  expect(writes()).toHaveLength(0); expect(screen.queryByRole('button', { name: 'Publish to project' })).not.toBeInTheDocument();
  await act(async () => completion.resolve(prepared)); await screen.findByRole('button', { name: 'Publish to project' }); expect(writes()).toHaveLength(0);
  expect(screen.queryByRole('button', { name: 'Copy link' })).not.toBeInTheDocument();
  const request = await publish(); await screen.findByRole('heading', { name: 'Publication accepted' });
  expect(request).toEqual({ requestId: expect.any(String), serviceId: scope.serviceId, projectId: scope.projectId, analysisId: scope.analysisId,
    ownerUserId: 7, preparationId: prepared.preparationId, snapshotSha256: prepared.snapshotSha256 });
  expect(writes('withdraw')).toHaveLength(0); expect(writes()[0]).toMatchObject({ credentials: 'include', headers: { 'X-Traceomics-Csrf': '1' } });
  expect(screen.getByRole('button', { name: 'Copy link' })).toBeEnabled();
  expect(screen.queryByRole('button', { name: /run|execute/i })).not.toBeInTheDocument();
});

it('keeps activity navigation closed until a held initial list confirms the workspace, then opens exact accepted activity on one explicit click', async () => {
  const held = deferred(), value = publicationFull({ viewerUserId: 7, canPublish: true }), receipt = publicationReceipt({ current: value });
  state.publications.set(value.publicationId, value); state.journal.set(receipt.requestId, receipt); state.onList = () => held.promise;
  render(<AnalysisSnapshotPublications {...propsFor()} />); await waitFor(() => expect(reads(base)).toHaveLength(1));
  expect(screen.getByRole('button', { name: 'Your sharing activity' })).toBeDisabled();
  expect(screen.getByText('Checking workspace access before opening your sharing activity…')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Your sharing activity' })); expect(reads(base + '/requests')).toHaveLength(0);
  expect(screen.queryByLabelText('Your accepted sharing activity')).not.toBeInTheDocument();
  await act(async () => held.resolve(publicationList([value], { scope, canPublish: true })));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Your sharing activity' })).toBeEnabled());
  expect(reads(base + '/requests')).toHaveLength(0); fireEvent.click(screen.getByRole('button', { name: 'Your sharing activity' }));
  expect(await screen.findByRole('button', { name: 'Check accepted sharing action' })).toBeVisible();
  expect(reads(base + '/requests')).toHaveLength(1); expect(reads(base + '/requests')[0].credentials).toBe('include');
  expect(writes()).toHaveLength(0); expect(writes('withdraw')).toHaveLength(0);
});

it('offers an explicit workspace-access retry after initial discovery fails instead of stranding an empty activity page', async () => {
  const value = publicationFull({ viewerUserId: 7, canPublish: true }), receipt = publicationReceipt({ current: value });
  state.publications.set(value.publicationId, value); state.journal.set(receipt.requestId, receipt); state.onList = () => failure(503, 'SHARING_TEMPORARILY_UNAVAILABLE');
  render(<AnalysisSnapshotPublications {...propsFor()} />); await screen.findByRole('alert');
  expect(screen.getByRole('button', { name: 'Your sharing activity' })).toBeDisabled();
  expect(screen.getByText('Check workspace access to open your sharing activity. Use Refresh sharing access to try again.')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Your sharing activity' })); expect(reads(base + '/requests')).toHaveLength(0);
  state.onList = undefined; fireEvent.click(screen.getByRole('button', { name: 'Refresh sharing access' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Your sharing activity' })).toBeEnabled());
  expect(reads(base)).toHaveLength(2); await activity(); expect(await screen.findByRole('button', { name: 'Check accepted sharing action' })).toBeVisible();
  expect(reads(base + '/requests')).toHaveLength(1); expect(writes()).toHaveLength(0);
});

it('rejects a refreshed private package with another SHA instead of publishing a newer selection', async () => {
  const prepared = state.prepared.values().next().value, changed = publicationPreparation(7, { analysisVersion: 3 });
  state.onPreparation = () => changed; await frame(propsFor({ seed: { token: 'one', preparation: prepared } }));
  await screen.findByRole('alert'); expect(screen.queryByRole('button', { name: 'Publish to project' })).not.toBeInTheDocument(); expect(writes()).toHaveLength(0);
});

it('uses the current colleague viewer and publication audience while keeping the publisher and private action discovery separate', async () => {
  state.userId = 17; state.allowed = false;
  const value = publicationFull(); state.publications.set(value.publicationId, value);
  await frame(propsFor({ userId: 17, canWrite: false })); await openPublished();
  expect(screen.getByLabelText('Finding audience and viewer')).toHaveTextContent(`project-publication:${value.publicationId}:17`);
  expect(screen.queryByRole('button', { name: 'Withdraw from project' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Publish to project' })).not.toBeInTheDocument();
  await activity(); expect(await screen.findByText('No accepted sharing actions are recorded for your account in this analysis.')).toBeVisible();
  expect(state.requests.every(request => !request.pathname.startsWith(preparations))).toBe(true); expect(writes()).toHaveLength(0);
});

it('requires a specific missing original receipt before deliberate byte-identical publication retry', async () => {
  state.onPublish = request => { if (writes().length === 1) throw new Error('connection failed before upstream'); return json(acceptPublish(request), 201); };
  await seeded(); const original = await publish(); await screen.findByRole('alert');
  expect(screen.queryByRole('button', { name: 'Retry original publication' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Check original sharing request' }));
  await screen.findByRole('button', { name: 'Retry original publication' }); expect(writes()).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Retry original publication' })); await screen.findByRole('heading', { name: 'Publication accepted' });
  expect(writes()).toHaveLength(2); expect(writes()[1].body).toEqual(original); expect(state.journal.size).toBe(1);
});

it.each(['unreachable', 'malformed', 'wrong missing code', '500 with missing code'])('does not enable an original retry after a %s receipt GET', async kind => {
  state.onPublish = () => { throw new Error('lost acknowledgement'); };
  state.onRequest = () => { if (kind === 'unreachable') throw new Error('private network detail');
    return kind === 'malformed' ? { accepted: true } : kind === '500 with missing code'
      ? failure(500, 'ANALYSIS_SNAPSHOT_PUBLICATION_NOT_FOUND') : failure(404, 'UNRELATED_NOT_FOUND'); };
  await seeded(); await publish(); await screen.findByRole('alert'); fireEvent.click(screen.getByRole('button', { name: 'Check original sharing request' }));
  await waitFor(() => expect(reads(base + '/requests/' + writes()[0].body.requestId)).toHaveLength(1));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Check original sharing request' })).toBeEnabled());
  expect(screen.queryByRole('button', { name: 'Retry original publication' })).not.toBeInTheDocument(); expect(writes()).toHaveLength(1);
  expect(screen.queryByText('private network detail')).not.toBeInTheDocument(); expect(screen.queryByText('Private upstream server path must stay hidden.')).not.toBeInTheDocument();
});

it('recovers a genuinely accepted lost publish reply after reader downgrade without a duplicate mutation', async () => {
  state.onPublish = request => { acceptPublish(request); throw new Error('accepted response lost'); };
  const view = await seeded(); const body = await publish(); await screen.findByRole('alert');
  state.allowed = false; view.rerender(<AnalysisSnapshotPublications {...view.props} canWrite={false} />);
  fireEvent.click(screen.getByRole('button', { name: 'Check original sharing request' })); await screen.findByRole('heading', { name: 'Publication accepted' });
  expect(writes()).toHaveLength(1); expect(state.journal.get(body.requestId).requestId).toBe(body.requestId);
  fireEvent.click(screen.getByRole('button', { name: 'Open original published snapshot' })); await screen.findByTestId('published-findings');
  expect(screen.getByRole('button', { name: 'Withdraw from project' })).toBeEnabled(); expect(screen.queryByRole('button', { name: 'Publish to project' })).not.toBeInTheDocument();
});

it('discovers accepted private activity after complete frame remount without browser UUID or scientific persistence', async () => {
  const storage = vi.spyOn(Storage.prototype, 'setItem'); state.onPublish = request => { acceptPublish(request); throw new Error('accepted reply lost'); };
  const view = await seeded(); await publish(); await screen.findByRole('alert'); view.unmount();
  state.allowed = false; state.prepared.clear(); await frame(propsFor({ canWrite: false })); await activity();
  fireEvent.click(await screen.findByRole('button', { name: 'Check accepted sharing action' })); await screen.findByRole('heading', { name: 'Publication accepted' });
  expect(writes()).toHaveLength(1); expect(storage).not.toHaveBeenCalled();
  expect(state.requests.filter(request => request.pathname.startsWith(preparations))).toHaveLength(1);
});

it('applies a fresh writer denial to a held publish while preserving its original request for reader recovery', async () => {
  const completion = deferred(); state.onPublish = request => { acceptPublish(request); return completion.promise; };
  const view = await seeded(); await publish(); const signal = writes()[0].signal;
  state.allowed = false; fireEvent.click(screen.getByRole('button', { name: 'Refresh sharing access' }));
  await waitFor(() => expect(signal.aborted).toBe(true));
  await act(async () => completion.resolve(observedReceipt([...state.journal.values()][0])));
  expect(screen.queryByRole('heading', { name: 'Publication accepted' })).not.toBeInTheDocument();
  view.rerender(<AnalysisSnapshotPublications {...view.props} canWrite={false} />);
  fireEvent.click(screen.getByRole('button', { name: 'Check original sharing request' })); await screen.findByRole('heading', { name: 'Publication accepted' });
  expect(writes()).toHaveLength(1);
});

it('allows a downgraded publisher with current read access to withdraw explicitly, without fresh publish authority', async () => {
  state.allowed = false; const value = publicationFull({ viewerUserId: 7 }); state.publications.set(value.publicationId, value);
  await frame(propsFor({ canWrite: false })); await openPublished(); fireEvent.click(screen.getByRole('button', { name: 'Withdraw from project' }));
  expect(writes('withdraw')).toHaveLength(0); fireEvent.click(screen.getByRole('button', { name: 'Confirm withdrawal' }));
  await screen.findByRole('heading', { name: 'Withdrawal accepted' }); expect(writes('withdraw')).toHaveLength(1); expect(writes()).toHaveLength(0);
  expect(writes('withdraw')[0].body).toMatchObject({ ownerUserId: 7, publicationId: value.publicationId, snapshotSha256: value.snapshotSha256 });
});

it('lets a current administrator withdraw another publisher while binding the private receipt to the administrator actor', async () => {
  state.userId = 99; state.admin = true; const value = publicationFull({ viewerUserId: 99, canPublish: true, canWithdraw: true }); state.publications.set(value.publicationId, value);
  await frame(propsFor({ userId: 99 })); await openPublished(); fireEvent.click(screen.getByRole('button', { name: 'Withdraw from project' }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm withdrawal' })); await screen.findByRole('heading', { name: 'Withdrawal accepted' });
  expect(writes('withdraw')[0].body.ownerUserId).toBe(99); expect([...state.journal.values()][0]).toMatchObject({ actorUserId: 99, current: { publisherUserId: 7 } });
});

it('fences a held previously authorized detail when a fresh scope denial arrives through discovery', async () => {
  const value = publicationFull({ viewerUserId: 7, canPublish: true }), completion = deferred(); state.publications.set(value.publicationId, value); state.onDetail = () => completion.promise;
  await frame(); fireEvent.click(await screen.findByRole('button', { name: 'Open published snapshot' }));
  await waitFor(() => expect(reads(base + '/' + value.publicationId)).toHaveLength(1)); const signal = reads(base + '/' + value.publicationId)[0].signal;
  state.onList = () => failure(404, 'ANALYSIS_SNAPSHOT_SCOPE_NOT_FOUND'); fireEvent.click(screen.getByRole('button', { name: 'Refresh sharing access' }));
  await waitFor(() => expect(signal.aborted).toBe(true)); await act(async () => completion.resolve(value));
  expect(screen.queryByTestId('published-findings')).not.toBeInTheDocument(); expect(screen.queryByRole('button', { name: 'Withdraw from project' })).not.toBeInTheDocument();
  expect(screen.queryByText('Measured expression contrast')).not.toBeInTheDocument(); expect(writes()).toHaveLength(0);
});

it('keeps a withdrawn publication monotone across older active full, list and owner receipt observations', async () => {
  const value = publicationFull({ viewerUserId: 7, canPublish: true }), oldReceipt = publicationReceipt({ current: value }); state.publications.set(value.publicationId, value); state.journal.set(oldReceipt.requestId, oldReceipt);
  await frame(); await openPublished();
  const withdrawn = { ...value, package: null, availability: null, canWithdraw: false, policy: { state: 'withdrawn', version: 2, withdrawnAt: withdrawalTime, withdrawnByUserId: 7 } };
  state.onDetail = () => withdrawn; fireEvent.click(screen.getByRole('button', { name: 'Check current snapshot access' })); await screen.findByRole('heading', { name: 'Snapshot withdrawn' });
  state.onDetail = () => value; fireEvent.click(screen.getByRole('button', { name: 'Check current snapshot access' }));
  await act(async () => {}); expect(screen.queryByTestId('published-findings')).not.toBeInTheDocument();
  state.onList = () => publicationList([value], { scope, canPublish: true }); fireEvent.click(screen.getByRole('button', { name: 'Refresh sharing access' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh sharing access' })).toBeEnabled()); expect(screen.getByRole('heading', { name: 'Snapshot withdrawn' })).toBeVisible();
  state.onActivity = () => publicationRequests([oldReceipt], { scope }); state.onRequest = () => oldReceipt;
  await activity(); fireEvent.click(await screen.findByRole('button', { name: 'Check accepted sharing action' })); await screen.findByRole('heading', { name: 'Publication accepted' });
  expect(screen.getByText('This snapshot is now withdrawn. Recovering its original acceptance does not reactivate it.')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Open original published snapshot' })); expect(await screen.findByRole('heading', { name: 'Snapshot withdrawn' })).toBeVisible();
  expect(screen.queryByTestId('published-findings')).not.toBeInTheDocument(); expect(writes()).toHaveLength(0);
});

it('blocks raw bodies immediately on a known withdrawn callback even if the subsequent metadata response is older active policy', async () => {
  const value = publicationFull({ viewerUserId: 7, canPublish: true }); state.publications.set(value.publicationId, value);
  await frame(); await openPublished(); fireEvent.click(screen.getByRole('button', { name: 'Report withdrawn retained view' }));
  await screen.findByText(/Viewing is paused while this publication's access or withdrawal is being checked/);
  expect(screen.queryByTestId('published-findings')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Check current snapshot access' })); await act(async () => {});
  expect(screen.queryByTestId('published-findings')).not.toBeInTheDocument(); expect(writes('withdraw')).toHaveLength(0);
});

it('hides a pending withdrawal body, recovers a lost accepted receipt, and never submits another withdrawal automatically', async () => {
  const value = publicationFull({ viewerUserId: 7, canPublish: true }), completion = deferred(); state.publications.set(value.publicationId, value);
  state.onWithdraw = request => { acceptWithdrawal(request); return completion.promise; };
  await frame(); await openPublished(); fireEvent.click(screen.getByRole('button', { name: 'Withdraw from project' })); fireEvent.click(screen.getByRole('button', { name: 'Confirm withdrawal' }));
  await waitFor(() => expect(writes('withdraw')).toHaveLength(1));
  state.onDetail = () => value;
  fireEvent.click(screen.getByRole('button', { name: 'Browse published snapshots' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Open published snapshot' }));
  await screen.findByText(/Viewing is paused while this publication's access or withdrawal is being checked/);
  expect(screen.queryByTestId('published-findings')).not.toBeInTheDocument(); state.onDetail = undefined;
  await act(async () => completion.reject(new Error('accepted withdrawal reply lost'))); await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: 'Check original sharing request' })); await screen.findByRole('heading', { name: 'Withdrawal accepted' });
  expect(writes('withdraw')).toHaveLength(1); fireEvent.click(screen.getByRole('button', { name: 'Open original published snapshot' }));
  expect(await screen.findByRole('heading', { name: 'Snapshot withdrawn' })).toBeVisible(); expect(screen.queryByTestId('published-findings')).not.toBeInTheDocument();
});

it('retains a later selected publication when an original held accepted publish acknowledgement finally arrives', async () => {
  const prepared = snapshotRecord(snapshotRecipe({ analysisVersion: 3 }), { preparationId: 'asp_' + 'e'.repeat(24), analysisName: 'Later selected publication' });
  const later = publicationFull({ prepared, viewerUserId: 7, publisherUserId: 7, publicationId: 'aspub_' + 'e'.repeat(24), canPublish: true });
  state.publications.set(later.publicationId, later); const completion = deferred(); let accepted;
  state.onPublish = request => { accepted = acceptPublish(request); return completion.promise; };
  await seeded(); await publish(); fireEvent.click(screen.getByRole('button', { name: 'Browse published snapshots' }));
  const row = (await screen.findByText('Later selected publication · Saved analysis 3')).closest('li'); fireEvent.click(within(row).getByRole('button', { name: 'Open published snapshot' }));
  await screen.findByTestId('published-findings'); await act(async () => completion.resolve(accepted));
  expect(screen.getByLabelText('Finding audience and viewer')).toHaveTextContent(later.publicationId); expect(screen.queryByRole('heading', { name: 'Publication accepted' })).not.toBeInTheDocument();
  expect(writes()).toHaveLength(1);
});

it('does not offer an unverified conflicting publication as an existing target or fabricate an accepted receipt', async () => {
  state.onPublish = () => failure(409, 'ANALYSIS_SNAPSHOT_ALREADY_PUBLISHED'); await seeded(); await publish(); await screen.findByRole('alert');
  expect(screen.queryByRole('button', { name: 'Open existing publication' })).not.toBeInTheDocument(); expect(screen.queryByRole('heading', { name: 'Publication accepted' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Check original sharing request' })).toBeEnabled(); expect(writes()).toHaveLength(1);
});

it('offers only the exact acknowledged existing public summary for ALREADY_PUBLISHED without inventing acceptance', async () => {
  const prepared = state.prepared.values().next().value, existing = publicationFull({ prepared, viewerUserId: 7, canPublish: true }); state.publications.set(existing.publicationId, existing);
  state.onPublish = () => json({ error: 'Already published.', code: 'ANALYSIS_SNAPSHOT_ALREADY_PUBLISHED', publication: publicationSummary(existing) }, 409);
  await seeded(); await publish(); expect(await screen.findByRole('button', { name: 'Open existing publication' })).toBeEnabled();
  expect(screen.queryByRole('heading', { name: 'Publication accepted' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Open existing publication' })); await screen.findByTestId('published-findings'); expect(writes()).toHaveLength(1); expect(state.journal.size).toBe(0);
});

it.each(['different snapshot', 'another viewer'])('refuses a detail response bound to %s before mounting retained content', async mismatch => {
  const value = publicationFull({ viewerUserId: 7, canPublish: true }); state.publications.set(value.publicationId, value);
  state.onDetail = () => mismatch === 'another viewer' ? { ...value, viewerUserId: 17 }
    : publicationFull({ viewerUserId: 7, canPublish: true, prepared: publicationPreparation(7, { analysisVersion: 3 }) });
  await frame(); fireEvent.click(await screen.findByRole('button', { name: 'Open published snapshot' })); await screen.findByRole('alert');
  expect(screen.queryByTestId('published-findings')).not.toBeInTheDocument(); expect(screen.queryByRole('button', { name: 'Withdraw from project' })).not.toBeInTheDocument();
  expect(writes()).toHaveLength(0);
});

it('stops a native target-held publication read on actual disconnect without accepting the old response', async () => {
  const value = publicationFull({ viewerUserId: 7, canPublish: true }), completion = deferred(); state.publications.set(value.publicationId, value);
  const target = { id: 'remote-one', endpoint: 'https://local-tunnel.test', serviceIdentity: scope.serviceId, status: 'connected' };
  let targetListener; window.desktopShell = { getCurrentTarget: () => Promise.resolve(target), onTargetStatus: listener => { targetListener = listener; return () => {}; } };
  state.onDetail = () => completion.promise; await frame(); fireEvent.click(await screen.findByRole('button', { name: 'Open published snapshot' }));
  await waitFor(() => expect(reads(base + '/' + value.publicationId)).toHaveLength(1));
  await act(async () => targetListener({ ...target, status: 'disconnected' })); await screen.findByRole('alert');
  await act(async () => completion.resolve(value)); expect(screen.queryByTestId('published-findings')).not.toBeInTheDocument(); expect(writes()).toHaveLength(0);
});

it('aborts an inactive panel detail read and refreshes using GET only when made active again', async () => {
  const value = publicationFull({ viewerUserId: 7, canPublish: true }), completion = deferred(); state.publications.set(value.publicationId, value); state.onDetail = () => completion.promise;
  const view = await frame(); fireEvent.click(await screen.findByRole('button', { name: 'Open published snapshot' }));
  await waitFor(() => expect(reads(base + '/' + value.publicationId)).toHaveLength(1)); const signal = reads(base + '/' + value.publicationId)[0].signal;
  view.rerender(<AnalysisSnapshotPublications {...view.props} isActive={false} />); expect(signal.aborted).toBe(true);
  await act(async () => completion.resolve(value)); expect(screen.queryByTestId('published-findings')).not.toBeInTheDocument();
  state.onDetail = undefined; view.rerender(<AnalysisSnapshotPublications {...view.props} />);
  await waitFor(() => expect(reads(base).length).toBeGreaterThan(1)); expect(writes()).toHaveLength(0);
});

it('does not restore publication authority from an older positive preparation check after a fresh reader capability observation', async () => {
  const completion = deferred(), prepared = state.prepared.values().next().value; state.onPreparation = () => completion.promise;
  await frame(propsFor({ seed: { token: 'one', preparation: prepared } }));
  await waitFor(() => expect(reads(preparations + '/' + prepared.preparationId)).toHaveLength(1));
  state.allowed = false; fireEvent.click(screen.getByRole('button', { name: 'Refresh sharing access' }));
  await waitFor(() => expect(reads(base)).toHaveLength(2)); await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh sharing access' })).toBeEnabled());
  await act(async () => completion.resolve(prepared)); expect(await screen.findByRole('button', { name: 'Publish to project' })).toBeDisabled(); expect(writes()).toHaveLength(0);
});

it('keeps an unknown withdrawal body paused after failed checks and retries only an explicitly missing identical original', async () => {
  state.allowed = false; const value = publicationFull({ viewerUserId: 7 }); state.publications.set(value.publicationId, value);
  state.onWithdraw = request => { if (writes('withdraw').length === 1) throw new Error('lost before upstream'); return acceptWithdrawal(request); };
  await frame(propsFor({ canWrite: false })); await openPublished(); fireEvent.click(screen.getByRole('button', { name: 'Withdraw from project' }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm withdrawal' })); await screen.findByRole('alert'); const original = writes('withdraw')[0].body;
  state.onRequest = () => failure(500, 'ANALYSIS_SNAPSHOT_UNCONFIRMED'); fireEvent.click(screen.getByRole('button', { name: 'Check original sharing request' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Check original sharing request' })).toBeEnabled());
  expect(screen.queryByRole('button', { name: 'Retry original withdrawal' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Browse published snapshots' })); fireEvent.click(await screen.findByRole('button', { name: 'Open published snapshot' }));
  await screen.findByText(/Viewing is paused while this publication's access or withdrawal is being checked/); expect(screen.queryByTestId('published-findings')).not.toBeInTheDocument();
  state.onRequest = undefined; fireEvent.click(screen.getByRole('button', { name: 'Check original sharing request' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Retry original withdrawal' })); await screen.findByRole('heading', { name: 'Withdrawal accepted' });
  expect(writes('withdraw')).toHaveLength(2); expect(writes('withdraw')[1].body).toEqual(original); expect(writes()).toHaveLength(0);
});

it('allows a newer explicit successful current-access check to restore a temporarily missing body, without publication or regeneration', async () => {
  const value = publicationFull({ viewerUserId: 7, canPublish: true }); state.publications.set(value.publicationId, value);
  await frame(); await openPublished();
  // This is a resource-specific disappearance, not a withdrawal or member denial.
  // Invoke the real child callback vocabulary through the view boundary.
  state.onDetail = () => failure(404, 'ANALYSIS_SNAPSHOT_PUBLICATION_NOT_FOUND');
  fireEvent.click(screen.getByRole('button', { name: 'Report missing retained publication' })); await screen.findByRole('alert');
  expect(screen.queryByTestId('published-findings')).not.toBeInTheDocument(); expect(screen.getByText(/Viewing is paused while this publication's access or withdrawal is being checked/)).toBeVisible();
  state.onDetail = undefined; fireEvent.click(screen.getByRole('button', { name: 'Check current snapshot access' }));
  expect(await screen.findByTestId('published-findings')).toBeVisible(); expect(writes()).toHaveLength(0); expect(writes('withdraw')).toHaveLength(0);
});

it('does not clear a raw missing-resource fence from automatic metadata reconciliation before an explicit current-access check', async () => {
  const value = publicationFull({ viewerUserId: 7, canPublish: true }); state.publications.set(value.publicationId, value);
  await frame(); await openPublished(); const originalCount = reads(base + '/' + value.publicationId).length;
  fireEvent.click(screen.getByRole('button', { name: 'Report missing retained publication' }));
  await waitFor(() => expect(reads(base + '/' + value.publicationId)).toHaveLength(originalCount + 1));
  await act(async () => {}); expect(screen.queryByTestId('published-findings')).not.toBeInTheDocument();
  expect(screen.getByText(/Viewing is paused while this publication's access or withdrawal is being checked/)).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Check current snapshot access' })); expect(await screen.findByTestId('published-findings')).toBeVisible();
  expect(writes()).toHaveLength(0); expect(writes('withdraw')).toHaveLength(0);
});

it.each(['different preparation', 'different snapshot'])('refuses an ALREADY_PUBLISHED target from a %s without treating it as acceptance', async changed => {
  const prepared = state.prepared.values().next().value, existing = publicationFull({ prepared, viewerUserId: 7, canPublish: true });
  const summary = publicationSummary(existing); if (changed === 'different preparation') summary.preparationId = 'asp_' + 'e'.repeat(24); else summary.snapshotSha256 = 'e'.repeat(64);
  state.onPublish = () => json({ error: 'Already published.', code: 'ANALYSIS_SNAPSHOT_ALREADY_PUBLISHED', publication: summary }, 409);
  await seeded(); await publish(); await screen.findByRole('alert'); expect(screen.queryByRole('button', { name: 'Open existing publication' })).not.toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'Publication accepted' })).not.toBeInTheDocument(); expect(writes()).toHaveLength(1);
});

it('updates an already displayed accepted receipt when newer list discovery confirms withdrawal', async () => {
  await seeded(); await publish(); await screen.findByRole('heading', { name: 'Publication accepted' });
  const [id, value] = [...state.publications.entries()][0];
  state.publications.set(id, { ...value, package: null, availability: null, canWithdraw: false,
    policy: { state: 'withdrawn', version: 2, withdrawnAt: withdrawalTime, withdrawnByUserId: 7 } });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh sharing access' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh sharing access' })).toBeEnabled());
  expect(screen.getByText('This snapshot is now withdrawn. Recovering its original acceptance does not reactivate it.')).toBeVisible();
  expect(screen.queryByText('The exact reviewed snapshot is published to current project members.')).not.toBeInTheDocument();
});

it('does not restore a currently-published activity label from an older private summary after newer public withdrawal', async () => {
  const value = publicationFull({ viewerUserId: 7, canPublish: true }), receipt = publicationReceipt({ current: value });
  state.publications.set(value.publicationId, value); state.journal.set(receipt.requestId, receipt);
  await frame(); await activity(); await screen.findByText(/Snapshot currently published/);
  state.publications.set(value.publicationId, { ...value, package: null, availability: null, canWithdraw: false,
    policy: { state: 'withdrawn', version: 2, withdrawnAt: withdrawalTime, withdrawnByUserId: 7 } });
  state.onActivity = () => publicationRequests([receipt], { scope }); fireEvent.click(screen.getByRole('button', { name: 'Refresh sharing access' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh sharing access' })).toBeEnabled());
  expect(screen.getByText(/Snapshot now withdrawn/)).toBeVisible(); expect(screen.queryByText(/Snapshot currently published/)).not.toBeInTheDocument();
});

it('redacts a cached active colleague summary after private accepted activity confirms the same publication is withdrawn', async () => {
  const value = publicationFull({ viewerUserId: 7, canPublish: true }), current = { ...value, package: null, availability: null, canWithdraw: false,
    policy: { state: 'withdrawn', version: 2, withdrawnAt: withdrawalTime, withdrawnByUserId: 7 } };
  state.publications.set(value.publicationId, value); const receipt = publicationReceipt({ current }); state.journal.set(receipt.requestId, receipt);
  state.onActivity = () => publicationRequests([receipt], { scope }); await frame(); await activity(); await screen.findByText(/Snapshot now withdrawn/);
  fireEvent.click(screen.getByRole('button', { name: 'Browse published snapshots' }));
  expect(screen.getByText('Withdrawn snapshot')).toBeVisible(); expect(screen.queryByText(value.package.analysis.name + ' · Saved analysis 2')).not.toBeInTheDocument();
});

it('does not mark retained content missing from a 500 response with a misleading missing code', async () => {
  const value = publicationFull({ viewerUserId: 7, canPublish: true }), completion = deferred(); state.publications.set(value.publicationId, value);
  await frame(); await openPublished(); state.onDetail = () => completion.promise;
  fireEvent.click(screen.getByRole('button', { name: 'Report unconfirmed retained read' }));
  await waitFor(() => expect(reads(base + '/' + value.publicationId)).toHaveLength(2));
  expect(screen.getByTestId('published-findings')).toBeVisible(); expect(screen.queryByText(/Viewing is paused while this publication's access or withdrawal is being checked/)).not.toBeInTheDocument();
  await act(async () => completion.resolve(value)); expect(screen.getByTestId('published-findings')).toBeVisible(); expect(writes()).toHaveLength(0);
});

it('copies the exact accepted receipt and verified detail link without a private request identity or another sharing mutation', async () => {
  const clipboard = vi.fn().mockResolvedValue(undefined); vi.stubGlobal('navigator', { clipboard: { writeText: clipboard } });
  await seeded(); expect(screen.queryByRole('button', { name: 'Copy link' })).not.toBeInTheDocument();
  const original = await publish(); await screen.findByRole('heading', { name: 'Publication accepted' });
  fireEvent.click(screen.getByRole('button', { name: 'Copy link' })); await screen.findByText(/^Link copied/);
  const value = [...state.publications.values()][0], copied = clipboard.mock.calls[0][0];
  expect(copied).toContain(`#/shared-snapshots/v1/${scope.serviceId}/${scope.projectId}/${scope.analysisId}/${value.publicationId}/${original.snapshotSha256}`);
  expect(copied).not.toContain(original.requestId); expect(copied).not.toContain(original.preparationId);
  fireEvent.click(screen.getByRole('button', { name: 'Open original published snapshot' })); await screen.findByTestId('published-findings');
  fireEvent.click(screen.getByRole('button', { name: 'Copy link' })); await screen.findByText(/^Link copied/);
  expect(clipboard).toHaveBeenCalledTimes(2); expect(clipboard.mock.calls[1][0]).toBe(copied);
  expect(writes()).toHaveLength(1); expect(writes('withdraw')).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: 'Browse published snapshots' }));
  expect(screen.queryByRole('button', { name: 'Copy link' })).not.toBeInTheDocument();
});

it('offers no unconfirmed action link but recovers a copyable accepted record from private activity without another POST', async () => {
  const clipboard = vi.fn().mockResolvedValue(undefined); vi.stubGlobal('navigator', { clipboard: { writeText: clipboard } });
  state.onPublish = request => { acceptPublish(request); throw new Error('accepted reply lost'); };
  await seeded(); await publish(); await screen.findByRole('alert');
  expect(screen.queryByRole('button', { name: 'Copy link' })).not.toBeInTheDocument();
  await activity(); fireEvent.click(await screen.findByRole('button', { name: 'Check accepted sharing action' })); await screen.findByRole('heading', { name: 'Publication accepted' });
  fireEvent.click(screen.getByRole('button', { name: 'Copy link' })); await screen.findByText(/^Link copied/);
  expect(clipboard).toHaveBeenCalledOnce(); expect(writes()).toHaveLength(1);
});

it('allows a current reader to copy a verified colleague publication without publish or source authority', async () => {
  const clipboard = vi.fn().mockResolvedValue(undefined); vi.stubGlobal('navigator', { clipboard: { writeText: clipboard } });
  state.userId = 17; state.allowed = false; const value = publicationFull(); state.publications.set(value.publicationId, value);
  await frame(propsFor({ userId: 17, canWrite: false })); await openPublished();
  fireEvent.click(screen.getByRole('button', { name: 'Copy link' })); await screen.findByText(/^Link copied/);
  expect(clipboard.mock.calls[0][0]).toContain(`/${value.publicationId}/${value.snapshotSha256}`);
  expect(writes()).toHaveLength(0); expect(writes('withdraw')).toHaveLength(0);
  expect(state.requests.every(request => !request.pathname.startsWith(preparations))).toBe(true);
});

it('blocks copying while a withdrawal is unconfirmed but preserves exact accepted tombstone links after recovery', async () => {
  const clipboard = vi.fn().mockResolvedValue(undefined), held = deferred(); vi.stubGlobal('navigator', { clipboard: { writeText: clipboard } });
  const value = publicationFull({ viewerUserId: 7, canPublish: true }); state.publications.set(value.publicationId, value);
  state.onWithdraw = request => { acceptWithdrawal(request); return held.promise; };
  await frame(); await openPublished(); fireEvent.click(screen.getByRole('button', { name: 'Withdraw from project' }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm withdrawal' })); await waitFor(() => expect(writes('withdraw')).toHaveLength(1));
  state.onDetail = () => value; fireEvent.click(screen.getByRole('button', { name: 'Browse published snapshots' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Open published snapshot' })); await screen.findByText(/Viewing is paused while this publication's access or withdrawal is being checked/);
  expect(screen.getByRole('button', { name: 'Copy link' })).toBeDisabled(); expect(clipboard).not.toHaveBeenCalled();
  state.onDetail = undefined; await act(async () => held.reject(new Error('accepted withdrawal reply lost')));
  fireEvent.click(screen.getByRole('button', { name: 'Check original sharing request' })); await screen.findByRole('heading', { name: 'Withdrawal accepted' });
  fireEvent.click(screen.getByRole('button', { name: 'Copy link' })); await screen.findByText(/^Link copied/);
  expect(clipboard.mock.calls[0][0]).toContain(`/${value.publicationId}/${value.snapshotSha256}`);
  expect(screen.getByText('This exact link opens the withdrawn publication record. Its findings are no longer available.')).toBeVisible();
  expect(writes('withdraw')).toHaveLength(1); expect(writes()).toHaveLength(0);
});
