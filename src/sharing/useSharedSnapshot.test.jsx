import { webcrypto } from 'node:crypto';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import useSharedSnapshot from './useSharedSnapshot';
import { getSnapshotPublication, listSnapshotPublications } from '../analyses/snapshotPublicationApi';
import { readSharedWorkspaceIdentity } from './sharedWorkspaceIdentity';
import useExecutionTarget from '../runtime/useExecutionTarget';
import { publicationFull } from '../analyses/snapshotPublicationTestFixtures';

vi.mock('../analyses/snapshotPublicationApi', () => ({ getSnapshotPublication: vi.fn(), listSnapshotPublications: vi.fn() }));
vi.mock('./sharedWorkspaceIdentity', () => ({ readSharedWorkspaceIdentity: vi.fn() }));
vi.mock('../runtime/useExecutionTarget', () => ({ default: vi.fn() }));
const connected = { identity: 'configured-workspace', epoch: 1, blocked: false };
const publication = () => publicationFull();
const locator = (value = publication()) => ({ serviceId: value.serviceId, projectId: value.projectId, analysisId: value.analysisId,
  publicationId: value.publicationId, snapshotSha256: value.snapshotSha256 });
const user = { id: 17, email: 'reader@example.test', displayName: 'Current reader' };
const identity = id => ({ installationId: publication().serviceId, userId: id });
const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const failure = (status, code) => Object.assign(new Error('private/internal/location'), { status, code });
const status = async (result, expected) => waitFor(() => expect(result.current.state.status).toBe(expected));
const mount = target => renderHook(({ target }) => useSharedSnapshot(target), { initialProps: { target: target || locator() } });
async function ready(target) { const hook = mount(target); await status(hook.result, 'ready'); return hook; }
const settle = async action => act(async () => { action(); await Promise.resolve(); });

beforeEach(() => {
  vi.resetAllMocks(); vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('fetch', vi.fn());
  window.electronAPI = { restoreSession: vi.fn().mockResolvedValue(user), logout: vi.fn().mockResolvedValue({ success: true }),
    getProjects: vi.fn(), getExpertRCapabilities: vi.fn(), getComputeRuntimeStatus: vi.fn(), apiRequest: vi.fn() };
  useExecutionTarget.mockReturnValue(connected);
  readSharedWorkspaceIdentity.mockImplementation(async id => identity(id)); getSnapshotPublication.mockImplementation(async () => publication());
  localStorage.clear(); sessionStorage.clear();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); delete window.electronAPI; });

it('waits for the current cookie and installation before its one exact GET, without lists, source or compute', async () => {
  const cookie = deferred(), installation = deferred();
  window.electronAPI.restoreSession.mockReturnValueOnce(cookie.promise); readSharedWorkspaceIdentity.mockReturnValueOnce(installation.promise);
  const hook = mount(); expect(hook.result.current.state.status).toBe('loading');
  expect(readSharedWorkspaceIdentity).not.toHaveBeenCalled(); expect(getSnapshotPublication).not.toHaveBeenCalled();
  await settle(() => cookie.resolve(user)); await waitFor(() => expect(readSharedWorkspaceIdentity).toHaveBeenCalledOnce());
  expect(getSnapshotPublication).not.toHaveBeenCalled();
  await settle(() => installation.resolve(identity(user.id))); await status(hook.result, 'ready');
  const target = locator();
  expect(getSnapshotPublication).toHaveBeenCalledExactlyOnceWith(target.projectId, target.analysisId, target.publicationId,
    expect.objectContaining({ signal: expect.any(AbortSignal) }));
  expect(hook.result.current.state.record.package.analysis.version).toBe(2);
  expect(hook.result.current.state.user.id).toBe(17); expect(hook.result.current.state.available).toBe(true);
  expect(listSnapshotPublications).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  for (const method of ['getProjects', 'getExpertRCapabilities', 'getComputeRuntimeStatus', 'apiRequest']) expect(window.electronAPI[method]).not.toHaveBeenCalled();
  expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0);
});

it('does not refetch or reset an exact ready record for an equivalent newly allocated locator', async () => {
  const hook = await ready(); const epoch = hook.result.current.state.accessEpoch;
  hook.rerender({ target: { ...locator() } });
  await act(async () => { await Promise.resolve(); });
  expect(hook.result.current.state.status).toBe('ready'); expect(hook.result.current.state.accessEpoch).toBe(epoch);
  expect(window.electronAPI.restoreSession).toHaveBeenCalledOnce(); expect(getSnapshotPublication).toHaveBeenCalledOnce();
});

it('rejects a different signed-in installation before requesting linked project metadata', async () => {
  readSharedWorkspaceIdentity.mockResolvedValueOnce({ installationId: `svc_${'f'.repeat(32)}`, userId: 17 });
  const hook = mount(); await status(hook.result, 'wrong-workspace');
  expect(getSnapshotPublication).not.toHaveBeenCalled(); expect(hook.result.current.state.record).toBeNull();
});

it.each([null, false])('uses fresh signed-out cookie evidence %j rather than cached user metadata', async restored => {
  localStorage.setItem('auth_user', JSON.stringify(user)); sessionStorage.setItem('cached-publication', JSON.stringify(publication()));
  window.electronAPI.restoreSession.mockResolvedValueOnce(restored); const hook = mount(); await status(hook.result, 'signed-out');
  expect(readSharedWorkspaceIdentity).not.toHaveBeenCalled(); expect(getSnapshotPublication).not.toHaveBeenCalled();
  expect(hook.result.current.state.user).toBeNull(); expect(hook.result.current.state.record).toBeNull();
});

it.each([401, 503])('distinguishes session HTTP%i from successful sign-in evidence', async code => {
  window.electronAPI.restoreSession.mockRejectedValueOnce(failure(code)); const hook = mount();
  await status(hook.result, code === 401 ? 'signed-out' : 'unreachable');
  expect(readSharedWorkspaceIdentity).not.toHaveBeenCalled(); expect(getSnapshotPublication).not.toHaveBeenCalled();
});

it.each([401, 503])('classifies installation HTTP%i without a publication request', async code => {
  readSharedWorkspaceIdentity.mockRejectedValueOnce(failure(code)); const hook = mount();
  await status(hook.result, code === 401 ? 'signed-out' : 'unreachable'); expect(getSnapshotPublication).not.toHaveBeenCalled();
});

it.each([401, 403, 404, 503])('classifies exact publication HTTP%i while suppressing raw server error details', async code => {
  getSnapshotPublication.mockRejectedValueOnce(failure(code, code === 404 ? 'ANALYSIS_SNAPSHOT_SCOPE_NOT_FOUND' : undefined));
  const hook = mount(); await status(hook.result, code === 401 ? 'signed-out' : code === 503 ? 'unreachable' : 'denied');
  expect(hook.result.current.state.record).toBeNull(); expect(hook.result.current.state.error).not.toContain('private/');
});

it.each(['viewer', 'service', 'anchor', 'package'])('uses the real strict validator to reject a %s mismatch', async field => {
  const value = publication();
  if (field === 'viewer') value.viewerUserId = 18;
  if (field === 'service') value.serviceId = `svc_${'e'.repeat(32)}`;
  if (field === 'anchor') value.snapshotSha256 = 'b'.repeat(64);
  if (field === 'package') value.package.analysis.description = 'Unacknowledged newer scientific question';
  getSnapshotPublication.mockResolvedValueOnce(value); const hook = mount(); await status(hook.result, 'unverified');
  expect(hook.result.current.state.record).toBeNull(); expect(hook.result.current.state.available).toBe(false);
});

it('can deliberately retry a workspace outage without changing the immutable locator', async () => {
  window.electronAPI.restoreSession.mockRejectedValueOnce(failure(503)); const hook = mount(); await status(hook.result, 'unreachable');
  act(() => hook.result.current.refresh()); await status(hook.result, 'ready');
  expect(hook.result.current.state.target).toEqual(locator()); expect(getSnapshotPublication).toHaveBeenCalledOnce();
});

it('does not read even the cookie when the configured target is disconnected', async () => {
  useExecutionTarget.mockReturnValue({ ...connected, blocked: true }); const hook = mount(); await status(hook.result, 'unreachable');
  expect(window.electronAPI.restoreSession).not.toHaveBeenCalled(); expect(readSharedWorkspaceIdentity).not.toHaveBeenCalled(); expect(getSnapshotPublication).not.toHaveBeenCalled();
});

it.each(['session', 'identity', 'full'])('ignores a held %s response after a different locator becomes current', async phase => {
  const held = deferred(), second = publicationFull({ publicationId: `aspub_${'a'.repeat(24)}` });
  if (phase === 'session') window.electronAPI.restoreSession.mockReturnValueOnce(held.promise);
  if (phase === 'identity') readSharedWorkspaceIdentity.mockReturnValueOnce(held.promise);
  if (phase === 'full') getSnapshotPublication.mockReturnValueOnce(held.promise);
  const hook = mount();
  if (phase === 'identity') await waitFor(() => expect(readSharedWorkspaceIdentity).toHaveBeenCalledOnce());
  if (phase === 'full') await waitFor(() => expect(getSnapshotPublication).toHaveBeenCalledOnce());
  getSnapshotPublication.mockImplementation(async (_project, _analysis, id) => id === second.publicationId ? second : publication());
  hook.rerender({ target: locator(second) }); await status(hook.result, 'ready');
  expect(hook.result.current.state.record.publicationId).toBe(second.publicationId);
  await settle(() => held.resolve(phase === 'session' ? user : phase === 'identity' ? identity(user.id) : publication()));
  expect(hook.result.current.state.record.publicationId).toBe(second.publicationId);
  expect(getSnapshotPublication.mock.calls.filter(call => call[2] === locator().publicationId)).toHaveLength(phase === 'full' ? 1 : 0);
});

it('fences a real-validator digest awaiting completion when the locator changes', async () => {
  const held = deferred(), entered = deferred(); let first = true;
  vi.stubGlobal('crypto', { subtle: { digest: vi.fn(async (...args) => {
    if (first) { first = false; entered.resolve(); await held.promise; } return webcrypto.subtle.digest(...args);
  }) } });
  const second = publicationFull({ publicationId: `aspub_${'a'.repeat(24)}` });
  const hook = mount(); await entered.promise;
  getSnapshotPublication.mockResolvedValueOnce(second); hook.rerender({ target: locator(second) }); await status(hook.result, 'ready');
  await settle(() => held.resolve()); expect(hook.result.current.state.record.publicationId).toBe(second.publicationId);
});

it.each([
  { ...connected, epoch: 2 }, { ...connected, identity: 'other-configured-target' }, { ...connected, blocked: true },
])('clears an accepted record and fences pending reads on configured-target change %j', async target => {
  const hook = await ready(), held = deferred(); getSnapshotPublication.mockReturnValueOnce(held.promise);
  act(() => hook.result.current.refresh()); await waitFor(() => expect(getSnapshotPublication).toHaveBeenCalledTimes(2));
  const signal = getSnapshotPublication.mock.calls[1][3].signal;
  useExecutionTarget.mockReturnValue(target); window.electronAPI.restoreSession.mockReturnValueOnce(new Promise(() => {}));
  hook.rerender({ target: locator() }); expect(signal.aborted).toBe(true); expect(hook.result.current.state.record).toBeNull();
  await settle(() => held.resolve(publication())); expect(hook.result.current.state.record).toBeNull();
});

it('requires fresh identity and actual current-viewer validation when the signed-in user changes', async () => {
  const hook = await ready(), held = deferred(); getSnapshotPublication.mockReturnValueOnce(held.promise);
  act(() => hook.result.current.refresh()); await waitFor(() => expect(getSnapshotPublication).toHaveBeenCalledTimes(2));
  window.electronAPI.restoreSession.mockResolvedValueOnce({ ...user, id: 18 });
  getSnapshotPublication.mockResolvedValueOnce(publicationFull({ viewerUserId: 18 })); act(() => hook.result.current.refresh());
  await status(hook.result, 'ready'); expect(hook.result.current.state.user.id).toBe(18);
  expect(readSharedWorkspaceIdentity).toHaveBeenLastCalledWith(18, expect.any(Object));
  await settle(() => held.resolve(publication())); expect(hook.result.current.state.record.viewerUserId).toBe(18);
});

it.each(['session', 'identity', 'full', 'digest'])('fences a held %s reply after unmount', async phase => {
  const held = deferred(), entered = deferred(); let first = true;
  if (phase === 'session') window.electronAPI.restoreSession.mockReturnValueOnce(held.promise);
  if (phase === 'identity') readSharedWorkspaceIdentity.mockReturnValueOnce(held.promise);
  if (phase === 'full') getSnapshotPublication.mockReturnValueOnce(held.promise);
  if (phase === 'digest') vi.stubGlobal('crypto', { subtle: { digest: vi.fn(async (...args) => {
    if (first) { first = false; entered.resolve(); await held.promise; } return webcrypto.subtle.digest(...args);
  }) } });
  const hook = mount();
  if (phase === 'identity') await waitFor(() => expect(readSharedWorkspaceIdentity).toHaveBeenCalledOnce());
  if (phase === 'full') await waitFor(() => expect(getSnapshotPublication).toHaveBeenCalledOnce());
  if (phase === 'digest') await entered.promise;
  const requestCount = getSnapshotPublication.mock.calls.length; hook.unmount();
  await settle(() => held.resolve(phase === 'session' ? user : phase === 'identity' ? identity(user.id) : phase === 'full' ? publication() : undefined));
  expect(getSnapshotPublication).toHaveBeenCalledTimes(requestCount);
});

it.each([
  [401, undefined, 'signed-out'], [403, undefined, 'denied'], [404, 'ANALYSIS_SNAPSHOT_SCOPE_NOT_FOUND', 'denied'],
])('clears protected state for a current raw authority failure %i/%s', async (code, errorCode, expected) => {
  const hook = await ready(); act(() => hook.result.current.onReadFailure(failure(code, errorCode)));
  expect(hook.result.current.state.status).toBe(expected); expect(hook.result.current.state.record).toBeNull();
  expect(hook.result.current.state.available).toBe(false); expect(getSnapshotPublication).toHaveBeenCalledOnce();
});

it.each([
  failure(409, 'ANALYSIS_SNAPSHOT_VIEW_UNAVAILABLE'), failure(403, 'ANALYSIS_SNAPSHOT_SOURCE_READ_REQUIRED'),
  failure(undefined, 'INVALID_SNAPSHOT_PUBLICATION_RESPONSE'), failure(undefined, 'SNAPSHOT_PUBLICATION_UNREACHABLE'),
])('keeps independent retained-item errors local without a full→raw reload loop: %j', async error => {
  const hook = await ready(), accepted = hook.result.current.state.record, epoch = hook.result.current.state.accessEpoch;
  act(() => hook.result.current.onReadFailure(error));
  expect(hook.result.current.state.record).toBe(accepted); expect(hook.result.current.state.accessEpoch).toBe(epoch);
  expect(getSnapshotPublication).toHaveBeenCalledOnce(); expect(window.electronAPI.restoreSession).toHaveBeenCalledOnce();
});

it('deliberately refreshes an exact missing publication and never selects a different/latest record', async () => {
  const hook = await ready(); getSnapshotPublication.mockRejectedValueOnce(failure(404, 'ANALYSIS_SNAPSHOT_PUBLICATION_NOT_FOUND'));
  act(() => hook.result.current.onReadFailure(failure(404, 'ANALYSIS_SNAPSHOT_PUBLICATION_NOT_FOUND'))); await status(hook.result, 'denied');
  expect(getSnapshotPublication).toHaveBeenCalledTimes(2); expect(getSnapshotPublication.mock.calls[1].slice(0, 3)).toEqual(getSnapshotPublication.mock.calls[0].slice(0, 3));
  expect(listSnapshotPublications).not.toHaveBeenCalled();
});

it('keeps a validated withdrawal monotone across explicit refresh and never revives its old package', async () => {
  getSnapshotPublication.mockResolvedValueOnce(publicationFull({ state: 'withdrawn' })); const hook = await ready();
  expect(hook.result.current.state.record.package).toBeNull();
  act(() => hook.result.current.refresh()); await status(hook.result, 'ready');
  expect(hook.result.current.state.record.policy.state).toBe('withdrawn'); expect(hook.result.current.state.record.package).toBeNull();
});

it('fences an observed raw withdrawal before any validated tombstone, rejecting a later stale active body', async () => {
  const hook = await ready(); act(() => hook.result.current.onReadFailure(failure(409, 'ANALYSIS_SNAPSHOT_PUBLICATION_WITHDRAWN')));
  await status(hook.result, 'unverified'); expect(hook.result.current.state.record).toBeNull();
  getSnapshotPublication.mockResolvedValueOnce(publicationFull({ state: 'withdrawn' })); act(() => hook.result.current.refresh());
  await status(hook.result, 'ready'); expect(hook.result.current.state.record.policy.state).toBe('withdrawn');
});

it('does not accept changed withdrawal metadata from a later response', async () => {
  getSnapshotPublication.mockResolvedValueOnce(publicationFull({ state: 'withdrawn' })); const hook = await ready();
  getSnapshotPublication.mockResolvedValueOnce(publicationFull({ state: 'withdrawn', withdrawnByUserId: 18 }));
  act(() => hook.result.current.refresh()); await status(hook.result, 'unverified'); expect(hook.result.current.state.record).toBeNull();
});

it('cannot make a stale child denial revoke a newer exact-link view', async () => {
  const hook = await ready(), priorFailure = hook.result.current.onReadFailure;
  const second = publicationFull({ publicationId: `aspub_${'a'.repeat(24)}` }); getSnapshotPublication.mockResolvedValueOnce(second);
  hook.rerender({ target: locator(second) }); await status(hook.result, 'ready');
  act(() => priorFailure(failure(401))); expect(hook.result.current.state.status).toBe('ready');
  expect(hook.result.current.state.record.publicationId).toBe(second.publicationId);
});

it('clears a ready body while sign-out is pending and confirms only an acknowledged successful logout', async () => {
  const hook = await ready(), held = deferred(); window.electronAPI.logout.mockReturnValueOnce(held.promise);
  let outcome; act(() => { outcome = hook.result.current.logout(); });
  expect(hook.result.current.state.record).toBeNull(); expect(hook.result.current.state.available).toBe(false);
  await act(async () => { held.resolve({ success: true }); await outcome; });
  expect(hook.result.current.state.status).toBe('signed-out'); expect(hook.result.current.state.user).toBeNull();
});

it.each([false, 'throw'])('keeps a failed sign-out outcome unconfirmed and never restores its earlier package (%s)', async mode => {
  const hook = await ready(); if (mode === 'throw') window.electronAPI.logout.mockRejectedValueOnce(failure(503));
  else window.electronAPI.logout.mockResolvedValueOnce({ success: false });
  await act(async () => { await hook.result.current.logout(); });
  expect(hook.result.current.state.status).toBe('unverified'); expect(hook.result.current.state.record).toBeNull();
  expect(hook.result.current.state.error).toContain('Sign-out could not be confirmed');
});

it('does not let a held sign-out response replace a later route/account check', async () => {
  const hook = await ready(), held = deferred(); window.electronAPI.logout.mockReturnValueOnce(held.promise);
  let outcome; act(() => { outcome = hook.result.current.logout(); });
  const second = publicationFull({ publicationId: `aspub_${'a'.repeat(24)}` }); getSnapshotPublication.mockResolvedValueOnce(second);
  hook.rerender({ target: locator(second) }); await status(hook.result, 'ready');
  await act(async () => { held.resolve({ success: true }); await outcome; });
  expect(hook.result.current.state.record.publicationId).toBe(second.publicationId); expect(hook.result.current.state.status).toBe('ready');
});

it('aborts a held full GET on logout and cannot accept it after a successful sign-out', async () => {
  const held = deferred(); getSnapshotPublication.mockReturnValueOnce(held.promise); const hook = mount();
  await waitFor(() => expect(getSnapshotPublication).toHaveBeenCalledOnce()); const signal = getSnapshotPublication.mock.calls[0][3].signal;
  expect(hook.result.current.state.status).toBe('loading'); expect(hook.result.current.state.user.id).toBe(17);
  expect(hook.result.current.state.serviceId).toBe(locator().serviceId); expect(hook.result.current.state.record).toBeNull();
  expect(hook.result.current.state.available).toBe(false); expect(typeof hook.result.current.logout).toBe('function');
  await act(async () => { await hook.result.current.logout(); }); expect(signal.aborted).toBe(true);
  await settle(() => held.resolve(publication())); expect(hook.result.current.state.status).toBe('signed-out'); expect(hook.result.current.state.record).toBeNull();
});

it('does not grant access from cached app state when the session service is unavailable', async () => {
  localStorage.setItem('auth_user', JSON.stringify(user)); localStorage.setItem('snapshot', JSON.stringify(publication()));
  window.electronAPI.restoreSession.mockRejectedValueOnce(failure(503)); const hook = mount(); await status(hook.result, 'unreachable');
  expect(hook.result.current.state.record).toBeNull(); expect(hook.result.current.state.user).toBeNull(); expect(getSnapshotPublication).not.toHaveBeenCalled();
});

it('normalizes a legitimate numeric-string session identity before installation and viewer binding', async () => {
  window.electronAPI.restoreSession.mockResolvedValueOnce({ ...user, id: '17' }); const hook = await ready();
  expect(hook.result.current.state.user.id).toBe(17); expect(readSharedWorkspaceIdentity).toHaveBeenCalledExactlyOnceWith(17, expect.any(Object));
});

it.each([0, NaN, '17garbage', [], '017'])('does not use malformed cookie-user identity %j for any project read', async id => {
  window.electronAPI.restoreSession.mockResolvedValueOnce({ ...user, id }); const hook = mount(); await status(hook.result, 'unreachable');
  expect(readSharedWorkspaceIdentity).not.toHaveBeenCalled(); expect(getSnapshotPublication).not.toHaveBeenCalled();
});

it('fresh sign-in retries the current cookie and never trusts an unverified login payload or local cached user', async () => {
  window.electronAPI.restoreSession.mockResolvedValueOnce(null); const hook = mount(); await status(hook.result, 'signed-out');
  act(() => hook.result.current.refresh({ id: 99, displayName: 'Unverified caller' })); await status(hook.result, 'ready');
  expect(hook.result.current.state.user.id).toBe(17); expect(readSharedWorkspaceIdentity).toHaveBeenCalledExactlyOnceWith(17, expect.any(Object));
});

it('keeps an observed withdrawal after logout and fresh login as the same researcher', async () => {
  getSnapshotPublication.mockResolvedValueOnce(publicationFull({ state: 'withdrawn' })); const hook = await ready();
  await act(async () => { await hook.result.current.logout(); }); expect(hook.result.current.state.status).toBe('signed-out');
  act(() => hook.result.current.refresh()); await status(hook.result, 'ready');
  expect(hook.result.current.state.record.policy.state).toBe('withdrawn'); expect(hook.result.current.state.record.package).toBeNull();
});

it('does not reuse another account’s accepted record or viewer identity after a new cookie is checked', async () => {
  const hook = await ready(); window.electronAPI.restoreSession.mockResolvedValueOnce({ ...user, id: 18 });
  getSnapshotPublication.mockResolvedValueOnce(publication()); act(() => hook.result.current.refresh());
  await status(hook.result, 'unverified'); expect(hook.result.current.state.user.id).toBe(18); expect(hook.result.current.state.record).toBeNull();
});

it('retains the existing expired-cookie warning when other sessions were not revoked', async () => {
  const hook = await ready(); window.electronAPI.logout.mockResolvedValueOnce({ success: true, allSessionsRevoked: false,
    warning: 'The current session had already expired; other sessions could not be revoked.' });
  await act(async () => { await hook.result.current.logout(); }); expect(hook.result.current.state.status).toBe('signed-out');
  expect(hook.result.current.state.notice).toMatch(/other sessions.*not.*revok/i); expect(hook.result.current.state.record).toBeNull();
});

it.each(['true', 1, {}])('does not claim logout success from a malformed truthy acknowledgement %j', async success => {
  const hook = await ready(); window.electronAPI.logout.mockResolvedValueOnce({ success });
  await act(async () => { await hook.result.current.logout(); }); expect(hook.result.current.state.status).toBe('unverified');
  expect(hook.result.current.state.record).toBeNull();
});

it('coalesces same-turn focus/visibility return into one exact fresh-cookie authority check', async () => {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible'); const hook = await ready();
  const epoch = hook.result.current.state.accessEpoch;
  act(() => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus')); });
  expect(hook.result.current.state.record).toBeNull(); await status(hook.result, 'ready');
  expect(window.electronAPI.restoreSession).toHaveBeenCalledTimes(2); expect(getSnapshotPublication).toHaveBeenCalledTimes(2);
  expect(hook.result.current.state.accessEpoch).toBeGreaterThan(epoch); expect(hook.result.current.state.target).toEqual(locator());
});

it('forgets the protected body on hiding and verifies a different account before showing it on return', async () => {
  let visibility = 'visible'; vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  const hook = await ready(); act(() => { visibility = 'hidden'; document.dispatchEvent(new Event('visibilitychange')); });
  expect(hook.result.current.state.record).toBeNull(); expect(hook.result.current.state.available).toBe(false);
  expect(window.electronAPI.restoreSession).toHaveBeenCalledOnce();
  window.electronAPI.restoreSession.mockResolvedValueOnce({ ...user, id: 18 }); getSnapshotPublication.mockResolvedValueOnce(publicationFull({ viewerUserId: 18 }));
  act(() => { visibility = 'visible'; document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus')); });
  await status(hook.result, 'ready'); expect(hook.result.current.state.record.viewerUserId).toBe(18);
  expect(hook.result.current.state.user.id).toBe(18); expect(getSnapshotPublication).toHaveBeenCalledTimes(2);
});

it('does not initiate an authority check from focus while the document is hidden', async () => {
  const hook = await ready(); vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  act(() => window.dispatchEvent(new Event('focus')));
  expect(window.electronAPI.restoreSession).toHaveBeenCalledOnce(); expect(hook.result.current.state.record).not.toBeNull();
});

it('visibility loss fences a held full reply and a focused return cannot adopt the previous account response', async () => {
  let visibility = 'visible'; vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  const held = deferred(); getSnapshotPublication.mockReturnValueOnce(held.promise); const hook = mount();
  await waitFor(() => expect(getSnapshotPublication).toHaveBeenCalledOnce()); const signal = getSnapshotPublication.mock.calls[0][3].signal;
  act(() => { visibility = 'hidden'; document.dispatchEvent(new Event('visibilitychange')); }); expect(signal.aborted).toBe(true);
  window.electronAPI.restoreSession.mockResolvedValueOnce({ ...user, id: 18 }); getSnapshotPublication.mockResolvedValueOnce(publicationFull({ viewerUserId: 18 }));
  act(() => { visibility = 'visible'; document.dispatchEvent(new Event('visibilitychange')); }); await status(hook.result, 'ready');
  await settle(() => held.resolve(publication())); expect(hook.result.current.state.record.viewerUserId).toBe(18);
});

it('does not restart cookie checks on focus/visibility while sign-out is pending and submits logout only once', async () => {
  const hook = await ready(), held = deferred(); window.electronAPI.logout.mockReturnValueOnce(held.promise);
  let outcome; act(() => { outcome = hook.result.current.logout(); void hook.result.current.logout(); });
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  act(() => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); });
  expect(window.electronAPI.logout).toHaveBeenCalledOnce(); expect(window.electronAPI.restoreSession).toHaveBeenCalledOnce();
  expect(hook.result.current.state.record).toBeNull();
  await act(async () => { held.resolve({ success: true }); await outcome; }); expect(hook.result.current.state.status).toBe('signed-out');
});

it('removes focus/visibility listeners and queued callbacks when the route unmounts', async () => {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible'); const hook = await ready(); hook.unmount();
  act(() => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); });
  expect(window.electronAPI.restoreSession).toHaveBeenCalledOnce(); expect(getSnapshotPublication).toHaveBeenCalledOnce();
});

it('allows only bounded safe current-user display fields into landing state', async () => {
  window.electronAPI.restoreSession.mockResolvedValueOnce({ ...user, privatePath: '/private/storage', roles: ['admin'],
    name: 'x'.repeat(321), displayName: { toString: () => 'Private object' } }); const hook = await ready();
  expect(hook.result.current.state.user).toEqual({ id: 17, email: user.email });
  expect(JSON.stringify(hook.result.current.state.user)).not.toContain('private');
});

it('does not restart signed-out authentication on focus/visibility and discard an in-progress login form', async () => {
  window.electronAPI.restoreSession.mockResolvedValueOnce(null); const hook = mount(); await status(hook.result, 'signed-out');
  let visibility = 'visible'; vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  act(() => { window.dispatchEvent(new Event('focus')); visibility = 'hidden'; document.dispatchEvent(new Event('visibilitychange'));
    visibility = 'visible'; document.dispatchEvent(new Event('visibilitychange')); });
  expect(hook.result.current.state.status).toBe('signed-out'); expect(window.electronAPI.restoreSession).toHaveBeenCalledOnce();
  expect(readSharedWorkspaceIdentity).not.toHaveBeenCalled(); expect(getSnapshotPublication).not.toHaveBeenCalled();
});

it.each([
  [500, 'ANALYSIS_SNAPSHOT_PUBLICATION_WITHDRAWN'], [undefined, 'ANALYSIS_SNAPSHOT_PUBLICATION_WITHDRAWN'],
  [500, 'ANALYSIS_SNAPSHOT_PUBLICATION_NOT_FOUND'], [undefined, 'ANALYSIS_SNAPSHOT_PUBLICATION_NOT_FOUND'],
])('does not trust a misleading retained-item status/code %s/%s as a withdrawal or missing-publication fact', async (httpStatus, code) => {
  const hook = await ready(), accepted = hook.result.current.state.record;
  act(() => hook.result.current.onReadFailure(failure(httpStatus, code)));
  expect(hook.result.current.state.record).toBe(accepted); expect(getSnapshotPublication).toHaveBeenCalledOnce();
  act(() => hook.result.current.refresh()); await status(hook.result, 'ready');
  expect(hook.result.current.state.record.policy.state).toBe('published'); expect(hook.result.current.state.record.package).not.toBeNull();
});
