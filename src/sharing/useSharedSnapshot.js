import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import useExecutionTarget from '../runtime/useExecutionTarget';
import { getSnapshotPublication } from '../analyses/snapshotPublicationApi';
import { validateSnapshotPublication } from '../analyses/snapshotPublicationValidation';
import { readSharedWorkspaceIdentity } from './sharedWorkspaceIdentity';
import { buildSharedSnapshotHash, parseSharedSnapshotHash } from './sharedSnapshotLink';

const denied = error => error?.status === 403 || error?.status === 404;
const unavailable = error => error?.status >= 500 || ['SHARED_WORKSPACE_UNREACHABLE', 'SHARED_WORKSPACE_UNAVAILABLE',
  'SNAPSHOT_PUBLICATION_UNREACHABLE', 'TARGET_CHANGED', 'TARGET_UNAVAILABLE', 'TARGET_DISCONNECTED'].includes(error?.code);
const userIdentity = user => {
  const id = typeof user?.id === 'string' && /^[1-9][0-9]*$/.test(user.id) ? Number(user.id) : user?.id;
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('The current account could not be confirmed.');
  return { id, ...Object.fromEntries(['displayName', 'name', 'email'].filter(field => typeof user[field] === 'string' && user[field].length <= 320)
    .map(field => [field, user[field]])) };
};

// This entry point deliberately owns no project list, editor, execution, or
// recovery controller. The locator identifies bytes; current cookie authority
// and the independently checked installation decide whether they may be read.
export default function useSharedSnapshot(inputTarget) {
  const hash = buildSharedSnapshotHash(inputTarget);
  const target = useMemo(() => parseSharedSnapshotHash(hash).target, [hash]);
  const execution = useExecutionTarget();
  const key = JSON.stringify([hash, execution.identity, execution.epoch, execution.blocked]);
  const [attempt, setAttempt] = useState(0), [result, setResult] = useState(null);
  const current = useRef(null), generation = useRef(0), withdrawals = useRef(new Map()), withdrawnBodies = useRef(new Set()), loggingOut = useRef(false);
  const invalidate = useCallback(() => { generation.current++; current.current?.controller.abort(); current.current = null; }, []);

  useEffect(() => {
    invalidate();
    const request = { id: generation.current, key, controller: new AbortController() };
    current.current = request;
    const valid = () => current.current === request && !request.controller.signal.aborted;
    let user = null, serviceId = null;
    const save = state => { if (valid()) setResult({ ...state, key, accessEpoch: request.id, target, user, serviceId }); };
    if (execution.blocked) {
      save({ status: 'unreachable', record: null, available: false, error: '' });
      return invalidate;
    }
    save({ status: 'loading', record: null, available: false, error: '' });
    void (async () => {
      try {
        if (typeof window.electronAPI?.restoreSession !== 'function') throw new Error('Session verification is unavailable.');
        const restored = await window.electronAPI.restoreSession();
        if (!valid()) return;
        if (!restored) { save({ status: 'signed-out', record: null, available: false, error: '' }); return; }
        user = userIdentity(restored);
        const identity = await readSharedWorkspaceIdentity(user.id, { signal: request.controller.signal });
        if (!valid()) return;
        serviceId = identity.installationId;
        if (serviceId !== target.serviceId) { save({ status: 'wrong-workspace', record: null, available: false, error: '' }); return; }
        save({ status: 'loading', record: null, available: false, error: '' });
        const response = await getSnapshotPublication(target.projectId, target.analysisId, target.publicationId, { signal: request.controller.signal });
        if (!valid()) return;
        let record = await validateSnapshotPublication(response, { projectId: target.projectId, analysisId: target.analysisId,
          serviceId, userId: user.id }, { publicationId: target.publicationId, snapshotSha256: target.snapshotSha256 });
        if (!valid()) return;
        const policyKey = JSON.stringify([serviceId, user.id, target.publicationId, target.snapshotSha256]);
        const previous = withdrawals.current.get(policyKey);
        if (record.policy.state === 'withdrawn') {
          if (previous && JSON.stringify(previous) !== JSON.stringify(record.policy)) throw new Error('The recorded withdrawal could not be confirmed.');
          withdrawals.current.set(policyKey, record.policy);
        } else if (previous) record = { ...record, policy: previous, canWithdraw: false, package: null, availability: null };
        else if (withdrawnBodies.current.has(policyKey)) { save({ status: 'unverified', record: null, available: false, error: '' }); return; }
        save({ status: 'ready', record, available: true, error: '' });
      } catch (error) {
        if (!valid() || error?.name === 'AbortError') return;
        if (error?.status === 401) { user = null; save({ status: 'signed-out', record: null, available: false, error: '' }); }
        else save({ status: !user || unavailable(error) ? 'unreachable' : denied(error) ? 'denied' : 'unverified', record: null, available: false, error: '' });
      }
    })();
    return invalidate;
  }, [key, attempt, target, execution.blocked, invalidate]);

  const state = result?.key === key && result.accessEpoch === generation.current ? result
    : { target, user: null, serviceId: null, record: null, available: false, error: '',
      status: execution.blocked ? 'unreachable' : 'loading', accessEpoch: generation.current };
  const visibleState = useRef(state);
  visibleState.current = state;
  const refresh = useCallback(() => {
    invalidate(); setAttempt(value => value + 1);
  }, [invalidate]);
  useEffect(() => {
    let queued = false, timer;
    const returned = () => {
      if (document.visibilityState === 'hidden' || loggingOut.current || queued || visibleState.current.status === 'signed-out') return;
      queued = true; refresh(); timer = setTimeout(() => { queued = false; }, 0);
    };
    const visibility = () => {
      if (loggingOut.current || visibleState.current.status === 'signed-out') return;
      if (document.visibilityState === 'hidden') { invalidate(); setResult(null); }
      else returned();
    };
    window.addEventListener('focus', returned); document.addEventListener('visibilitychange', visibility);
    return () => { clearTimeout(timer); window.removeEventListener('focus', returned); document.removeEventListener('visibilitychange', visibility); };
  }, [key, refresh, invalidate]);
  const onReadFailure = useCallback(error => {
    if (result?.key !== key || result.accessEpoch !== generation.current || current.current?.key !== key) return;
    // A retained-file or independent discussion failure cannot confer a new
    // grant. Recheck the exact publication, never rebuild from its producer.
    if (error?.status === 401 || error?.code === 'ANALYSIS_SNAPSHOT_SCOPE_NOT_FOUND'
        || error?.status === 403 && error?.code !== 'ANALYSIS_SNAPSHOT_SOURCE_READ_REQUIRED') {
      invalidate(); setResult({ ...result, accessEpoch: generation.current, record: null, available: false,
        status: error?.status === 401 ? 'signed-out' : 'denied', user: error?.status === 401 ? null : result.user });
    } else if (error?.status === 409 && error.code === 'ANALYSIS_SNAPSHOT_PUBLICATION_WITHDRAWN'
        || error?.status === 404 && error.code === 'ANALYSIS_SNAPSHOT_PUBLICATION_NOT_FOUND') {
      if (error.code === 'ANALYSIS_SNAPSHOT_PUBLICATION_WITHDRAWN') withdrawnBodies.current.add(JSON.stringify([
        result.serviceId, result.user.id, target.publicationId, target.snapshotSha256]));
      refresh();
    }
    // An unavailable or malformed retained item remains a local error. An
    // automatic reload here would repeatedly fetch the same bad bytes and
    // erase the other permitted findings; explicit access checks stay available.
  }, [key, result, target, invalidate, refresh]);
  const logout = async () => {
    if (loggingOut.current) return;
    loggingOut.current = true;
    invalidate();
    const id = generation.current;
    setResult({ ...state, key, accessEpoch: id, status: 'loading', record: null, available: false, error: '' });
    let response;
    try { response = await window.electronAPI?.logout?.(); } catch { /* Keep the logout outcome unconfirmed. */ }
    finally { loggingOut.current = false; }
    if (generation.current !== id) return;
    const confirmed = response?.success === true;
    setResult({ ...state, key, accessEpoch: id, record: null, available: false,
      user: confirmed ? null : state.user, status: confirmed ? 'signed-out' : 'unverified',
      notice: confirmed && response.allSessionsRevoked === false ? 'This session has expired. Other sessions could not be revoked; sign in again to manage them.' : '',
      error: confirmed ? '' : 'Sign-out could not be confirmed. Check the workspace connection and try again.' });
  };
  return { state, refresh, onReadFailure, logout };
}
