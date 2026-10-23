import { useCallback, useEffect, useRef, useState } from 'react';
import { normalizePublishAnalysisSnapshot, normalizeWithdrawAnalysisSnapshot,
  canonicalPublishAnalysisSnapshot, canonicalWithdrawAnalysisSnapshot } from '../../shared/analysisSnapshotPublication.mjs';
import * as api from './snapshotPublicationApi';
import { getSnapshotPreparation } from './snapshotPreparationApi';
import { validateSnapshotPreparation } from './snapshotPreparationValidation';
import { validateSnapshotPublicationList, validateSnapshotPublicationRequests, validateSnapshotPublication,
  validateSnapshotPublicationReceipt, validateSnapshotAlreadyPublished } from './snapshotPublicationValidation';
import { publicErrorMessage } from '../publicError';

const missing = error => error?.status === 404 && error.code === 'ANALYSIS_SNAPSHOT_PUBLICATION_NOT_FOUND';
const writerFailure = (error = {}) => ['ANALYSIS_SNAPSHOT_WRITE_REQUIRED', 'ANALYSIS_SNAPSHOT_ANALYSIS_ARCHIVED'].includes(error.code);
const scopeFailure = (error = {}) => error.status === 401 || error.code === 'ANALYSIS_SNAPSHOT_SCOPE_NOT_FOUND'
  || error.status === 403 && !writerFailure(error) && !['ANALYSIS_SNAPSHOT_WITHDRAW_REQUIRED', 'ANALYSIS_SNAPSHOT_SOURCE_READ_REQUIRED'].includes(error.code);
const canonical = (action, body) => (action === 'publish' ? canonicalPublishAnalysisSnapshot : canonicalWithdrawAnalysisSnapshot)(body);
const digest = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, '0')).join('');
const anchor = value => ({ publicationId: value.publicationId, snapshotSha256: value.snapshotSha256,
  ...(value.preparationId ? { preparationId: value.preparationId } : {}), ...(value.publisherUserId ? { publisherUserId: value.publisherUserId } : {}) });
const typed = original => ({ action: original.action, ...original.body });

export default function useSnapshotPublications({ projectId, analysisId, userId, savedAnalysis, canWrite, available, isActive, seed }) {
  const [mode, setMode] = useState('list'), [items, setItems] = useState([]), [cursor, setCursor] = useState(null);
  const [activity, setActivity] = useState([]), [activityCursor, setActivityCursor] = useState(null), [activityLoaded, setActivityLoaded] = useState(false);
  const [loading, setLoading] = useState(false), [activityLoading, setActivityLoading] = useState(false), [loaded, setLoaded] = useState(false);
  const [selected, setSelected] = useState(null), [acknowledgement, setAcknowledgement] = useState(null), [receipt, setReceipt] = useState(null);
  const [original, setOriginal] = useState(null), [lastCheck, setLastCheck] = useState('unconfirmed'), [existing, setExisting] = useState(null);
  const [allowed, setAllowed] = useState(null), [phase, setPhase] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [blocked, setBlocked] = useState(new Set());
  const mounted = useRef(false), service = useRef(null), allowedRef = useRef(null), epoch = useRef(0), navigation = useRef(0);
  const selectedRef = useRef(null), originalRef = useRef(null), lastCheckRef = useRef('unconfirmed');
  const action = useRef(null), detail = useRef(null), listing = useRef(null), requests = useRef(null), processedSeed = useRef(null);
  const policies = useRef(new Map()), blockedRef = useRef(new Map());
  const usable = available && isActive;
  const scope = useCallback(() => ({ projectId, analysisId, userId, ...(service.current ? { serviceId: service.current } : {}) }), [projectId, analysisId, userId]);
  const retain = value => { selectedRef.current = value; setSelected(value); };
  const checkState = value => { lastCheckRef.current = value; setLastCheck(value); };
  const keepOriginal = value => { originalRef.current = value; setOriginal(value); };
  const cancelAction = useCallback(() => { action.current?.controller.abort(); action.current = null; setPhase(''); }, []);
  const observe = useCallback((value, observedEpoch) => {
    if (!value) {
      epoch.current++; allowedRef.current = false; setAllowed(false);
      if (action.current?.kind === 'publish') cancelAction();
    } else if (observedEpoch === epoch.current) { allowedRef.current = true; setAllowed(true); }
  }, [cancelAction]);
  const revoke = useCallback(() => {
    epoch.current++; cancelAction(); detail.current?.abort(); listing.current?.abort(); requests.current?.abort();
    selectedRef.current = null; setSelected(null); setItems([]); setActivity([]); setCursor(null); setActivityCursor(null);
    setLoaded(false); setActivityLoaded(false); setLoading(false); setActivityLoading(false); setAcknowledgement(null); setReceipt(null); setExisting(null);
    allowedRef.current = false; setAllowed(false); setNotice(''); setError('Access to this project is unavailable. Reconnect to the same workspace and refresh.');
  }, [cancelAction]);
  const remember = value => {
    const id = value.publicationId || value.acceptance?.publicationId, sha = value.snapshotSha256 || value.acceptance?.snapshotSha256;
    const policy = value.policy || value.currentPolicy;
    const previous = policies.current.get(id);
    if (previous && previous.sha !== sha) throw new Error('The published snapshot identity changed.');
    if (policy?.state === 'withdrawn') {
      if (previous && JSON.stringify(previous.policy) !== JSON.stringify(policy)) throw new Error('The original withdrawal identity changed.');
      policies.current.set(id, { sha, policy });
      if (selectedRef.current?.publicationId === id) retain({ ...selectedRef.current, policy, canWithdraw: false, package: null, availability: null });
    }
  };
  const constrain = value => {
    remember(value); const known = policies.current.get(value.publicationId);
    return known ? { ...value, policy: known.policy, canWithdraw: false, package: null, availability: null } : value;
  };
  const fail = (caught, fallback) => {
    if (scopeFailure(caught)) revoke();
    else if (writerFailure(caught)) observe(false, epoch.current);
    setError(publicErrorMessage(caught, fallback));
  };
  useEffect(() => { mounted.current = true; return () => {
    mounted.current = false; action.current?.controller.abort(); detail.current?.abort(); listing.current?.abort(); requests.current?.abort();
  }; }, []);
  const load = useCallback(async (next = null) => {
    if (!usable) return;
    listing.current?.abort(); const controller = new AbortController(); listing.current = controller;
    const observedEpoch = epoch.current; setLoading(true); setError('');
    try {
      const value = validateSnapshotPublicationList(await api.listSnapshotPublications(projectId, analysisId, { cursor: next, signal: controller.signal }), scope());
      if (!mounted.current || controller.signal.aborted || listing.current !== controller) return;
      service.current = value.serviceId; observe(value.canPublish, observedEpoch);
      for (const item of value.items) {
        const known = policies.current.get(item.publicationId);
        if (known && known.sha !== item.snapshotSha256) throw new Error('The published snapshot identity changed.');
        if (item.policy.state === 'withdrawn') {
          if (known && JSON.stringify(known.policy) !== JSON.stringify(item.policy)) throw new Error('The original withdrawal identity changed.');
          policies.current.set(item.publicationId, { sha: item.snapshotSha256, policy: item.policy });
        }
      }
      const safe = value.items.map(item => policies.current.has(item.publicationId) ? { ...item, policy: policies.current.get(item.publicationId).policy, canWithdraw: false, selection: null } : item);
      setItems(previous => next ? [...new Map([...previous, ...safe].map(item => [item.publicationId, item])).values()] : safe);
      const current = selectedRef.current, known = current && policies.current.get(current.publicationId);
      if (known) { selectedRef.current = { ...current, policy: known.policy, canWithdraw: false, package: null, availability: null }; setSelected(selectedRef.current); }
      setCursor(value.nextCursor); setLoaded(true);
    } catch (caught) {
      if (!mounted.current || controller.signal.aborted || listing.current !== controller) return;
      if (scopeFailure(caught)) revoke(); setError(publicErrorMessage(caught, 'Published snapshots could not be loaded. Refresh this workspace to try again.'));
    } finally { if (mounted.current && listing.current === controller) setLoading(false); }
  }, [usable, projectId, analysisId, scope, observe, revoke]);
  const loadActivity = async (next = null) => {
    if (!usable || !service.current) return;
    requests.current?.abort(); const controller = new AbortController(); requests.current = controller; setActivityLoading(true); setError('');
    try {
      const value = await validateSnapshotPublicationRequests(await api.listSnapshotPublicationRequests(projectId, analysisId, { cursor: next, signal: controller.signal }), scope());
      if (!mounted.current || controller.signal.aborted || requests.current !== controller) return;
      for (const item of value.items) remember(item);
      setActivity(previous => next ? [...new Map([...previous, ...value.items].map(item => [item.requestId, item])).values()] : value.items);
      setActivityCursor(value.nextCursor); setActivityLoaded(true);
    } catch (caught) { if (mounted.current && !controller.signal.aborted && requests.current === controller) fail(caught, 'Your accepted sharing actions could not be loaded.'); }
    finally { if (mounted.current && requests.current === controller) setActivityLoading(false); }
  };
  useEffect(() => { if (usable) void load(); }, [usable, load]);
  useEffect(() => {
    if (usable) return;
    cancelAction(); detail.current?.abort(); listing.current?.abort(); requests.current?.abort(); setLoading(false); setActivityLoading(false);
    if (!available) {
      retain(null); setItems([]); setActivity([]); setAcknowledgement(null); setReceipt(null); setExisting(null); setLoaded(false); setActivityLoaded(false);
      allowedRef.current = null; setAllowed(null);
    }
  }, [usable, available, cancelAction]);
  useEffect(() => {
    if (!canWrite || savedAnalysis?.status !== 'active') observe(false, epoch.current);
  }, [canWrite, savedAnalysis?.status, observe]);
  const navigate = next => { navigation.current++; detail.current?.abort(); setMode(next); setError(''); setNotice(''); };
  const open = async (summary, { preserveMode = false, deliberate = true } = {}) => {
    if (!usable || !service.current) return;
    detail.current?.abort(); const controller = new AbortController(); detail.current = controller;
    const expected = anchor(summary), observedEpoch = epoch.current, nav = navigation.current;
    const priorBlock = blockedRef.current.get(expected.publicationId);
    if (!preserveMode) { retain(null); setMode('detail'); } setError('');
    try {
      const value = await validateSnapshotPublication(await api.getSnapshotPublication(projectId, analysisId, expected.publicationId, { signal: controller.signal }), scope(), expected);
      if (!mounted.current || controller.signal.aborted || detail.current !== controller || nav !== navigation.current) return;
      observe(value.canPublish, observedEpoch); retain(constrain(value));
      if (deliberate && priorBlock?.reason === 'missing' && blockedRef.current.get(value.publicationId) === priorBlock
          && value.policy.state === 'published' && !policies.current.has(value.publicationId)) {
        blockedRef.current.delete(value.publicationId); setBlocked(new Set(blockedRef.current.keys()));
      }
    } catch (caught) { if (mounted.current && !controller.signal.aborted && detail.current === controller && nav === navigation.current) fail(caught, 'The exact published snapshot could not be opened.'); }
  };
  const reviewSeed = async preparation => {
    if (!usable || !service.current || action.current) return;
    if (originalRef.current && lastCheckRef.current !== 'confirmed') { setError('Check the original sharing request before starting another action.'); return; }
    navigate('confirm-publish'); setAcknowledgement(null); setExisting(null);
    detail.current?.abort(); const controller = new AbortController(); detail.current = controller; const nav = navigation.current, observedEpoch = epoch.current;
    try {
      if (preparation.serviceId !== service.current) throw new Error('The preparation belongs to another workspace.');
      const value = await validateSnapshotPreparation(await getSnapshotPreparation(projectId, analysisId, preparation.preparationId, { signal: controller.signal }), scope());
      if (!mounted.current || controller.signal.aborted || detail.current !== controller || nav !== navigation.current) return;
      if (value.state !== 'ready' || value.preparationId !== preparation.preparationId || value.snapshotSha256 !== preparation.snapshotSha256) throw new Error('The acknowledged private snapshot is no longer ready. It has not been replaced.');
      observe(value.canPrepare, observedEpoch); setAcknowledgement(value);
    } catch (caught) { if (mounted.current && !controller.signal.aborted && detail.current === controller) fail(caught, 'The exact private preparation could not be checked. Return to it and refresh.'); }
  };
  useEffect(() => {
    if (!usable || !service.current || !seed || processedSeed.current === seed.token) return;
    processedSeed.current = seed.token; void reviewSeed(seed.preparation);
    // An entry token is a deliberate navigation, not a refreshed object identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [usable, loaded, seed?.token]);
  const markBlocked = (id, reason) => {
    const priority = { missing: 1, 'pending-withdrawal': 2, withdrawn: 3 };
    if ((priority[blockedRef.current.get(id)?.reason] || 0) <= priority[reason]) blockedRef.current.set(id, { reason });
    setBlocked(new Set(blockedRef.current.keys()));
  };
  const valid = current => mounted.current && !current.controller.signal.aborted && action.current === current;
  const keepReceipt = value => {
    value = { ...value, current: constrain(value.current) }; setReceipt(value);
    if (selectedRef.current?.publicationId === value.current.publicationId) retain(value.current);
    return value;
  };
  const checkRequest = async summary => {
    if (!usable || !service.current || action.current) return;
    const own = originalRef.current, requestId = summary?.requestId || own?.body.requestId || receipt?.requestId;
    if (!requestId) return;
    const expected = own?.body.requestId === requestId ? typed(own) : summary?.request;
    const current = { controller: new AbortController(), kind: 'check' }; action.current = current;
    const nav = navigation.current, observedEpoch = epoch.current; setPhase('Checking the original sharing request…'); setError(''); setNotice('');
    if (own?.body.requestId === requestId) checkState('unconfirmed');
    try {
      const value = await validateSnapshotPublicationReceipt(await api.getSnapshotPublicationRequest(projectId, analysisId, requestId, { signal: current.controller.signal }), scope(), expected);
      if (!valid(current)) return;
      if (value.requestId !== requestId || own?.body.requestId === requestId && value.requestSha256 !== own.requestSha256
        || summary && value.requestSha256 !== summary.requestSha256) throw new Error('The original sharing request identity changed.');
      observe(value.current.canPublish, observedEpoch); keepReceipt(value);
      if (own?.body.requestId === requestId) checkState('confirmed');
      if (nav === navigation.current) setMode('receipt');
      setNotice('The original accepted action was checked. Checking does not publish or withdraw anything.');
    } catch (caught) {
      if (valid(current)) { if (own?.body.requestId === requestId) checkState(missing(caught) ? 'missing' : 'unconfirmed'); fail(caught, 'The original sharing action remains unconfirmed. Keep its request and check again.'); }
    } finally { if (action.current === current) { action.current = null; if (mounted.current) setPhase(''); } }
  };
  const mutate = async (kind, retry = false) => {
    if (!usable || !service.current || action.current || originalRef.current && lastCheckRef.current !== 'confirmed' && !retry) return;
    const previous = originalRef.current;
    if (retry && (!previous || previous.action !== kind || lastCheckRef.current !== 'missing')) return;
    if (kind === 'publish' && (!canWrite || savedAnalysis?.status !== 'active' || allowedRef.current !== true || !retry && !acknowledgement)) return;
    if (kind === 'withdraw' && !retry && !selectedRef.current?.canWithdraw) return;
    const current = { controller: new AbortController(), kind }; action.current = current;
    const nav = navigation.current; setPhase('Checking current access…'); setError(''); setNotice(''); setExisting(null);
    try {
      let record = retry ? previous : null;
      if (kind === 'publish') {
        const observedEpoch = epoch.current;
        const access = validateSnapshotPublicationList(await api.listSnapshotPublications(projectId, analysisId, { signal: current.controller.signal }), scope());
        if (!valid(current)) return; observe(access.canPublish, observedEpoch); if (!access.canPublish || !allowedRef.current) return;
        if (!record) {
          const body = normalizePublishAnalysisSnapshot({ requestId: crypto.randomUUID(), serviceId: service.current, projectId, analysisId, ownerUserId: Number(userId),
            preparationId: acknowledgement.preparationId, snapshotSha256: acknowledgement.snapshotSha256 });
          record = { action: kind, body, requestSha256: await digest(canonical(kind, body)) };
        }
      } else {
        const target = retry ? anchor(previous.body) : anchor(selectedRef.current), observedEpoch = epoch.current;
        const value = await validateSnapshotPublication(await api.getSnapshotPublication(projectId, analysisId, target.publicationId, { signal: current.controller.signal }), scope(), target);
        if (!valid(current)) return; observe(value.canPublish, observedEpoch); retain(constrain(value));
        if (!value.canWithdraw || policies.current.has(value.publicationId)) return;
        if (!record) {
          const body = normalizeWithdrawAnalysisSnapshot({ requestId: crypto.randomUUID(), serviceId: service.current, projectId, analysisId, ownerUserId: Number(userId), publicationId: value.publicationId, snapshotSha256: value.snapshotSha256 });
          record = { action: kind, body, requestSha256: await digest(canonical(kind, body)) };
        }
      }
      if (!valid(current)) return;
      keepOriginal(record); checkState('unconfirmed'); setReceipt(null);
      if (kind === 'withdraw') markBlocked(record.body.publicationId, 'pending-withdrawal');
      setPhase(kind === 'publish' ? 'Publishing this exact reviewed snapshot…' : 'Withdrawing this exact snapshot…');
      const observedEpoch = epoch.current;
      const raw = await (kind === 'publish' ? api.publishAnalysisSnapshot(projectId, analysisId, record.body, { signal: current.controller.signal })
        : api.withdrawAnalysisSnapshot(projectId, analysisId, record.body.publicationId, record.body, { signal: current.controller.signal }));
      const value = await validateSnapshotPublicationReceipt(raw, scope(), typed(record));
      if (!valid(current)) return;
      if (value.requestSha256 !== record.requestSha256) throw new Error('The original sharing request identity changed.');
      observe(value.current.canPublish, observedEpoch); keepReceipt(value); checkState('confirmed');
      if (nav === navigation.current) setMode('receipt'); void load();
    } catch (caught) {
      if (!valid(current)) return;
      if (caught.code === 'ANALYSIS_SNAPSHOT_ALREADY_PUBLISHED' && acknowledgement) {
        try { setExisting(validateSnapshotAlreadyPublished({ error: caught.message, code: caught.code, publication: caught.publication }, scope(),
          { preparationId: acknowledgement.preparationId, snapshotSha256: acknowledgement.snapshotSha256 }).publication); }
        catch { /* An unverified conflict never supplies an opening target. */ }
      }
      fail(caught, 'Completion remains unconfirmed. Check this original request before trying again.');
    } finally { if (action.current === current) { action.current = null; if (mounted.current) setPhase(''); } }
  };
  const releaseChecked = () => {
    if (action.current || lastCheckRef.current !== 'missing') return;
    const record = originalRef.current;
    if (record?.action === 'withdraw' && blockedRef.current.get(record.body.publicationId)?.reason === 'pending-withdrawal') {
      blockedRef.current.delete(record.body.publicationId); setBlocked(new Set(blockedRef.current.keys()));
    }
    keepOriginal(null); checkState('unconfirmed'); setError(''); setNotice('The checked request is no longer selected here. Accepted sharing actions remain discoverable in your activity.');
  };
  const readFailure = caught => {
    if (scopeFailure(caught)) { revoke(); return; }
    if (selectedRef.current) {
      if (caught?.code === 'ANALYSIS_SNAPSHOT_PUBLICATION_WITHDRAWN' || missing(caught || {})) markBlocked(selectedRef.current.publicationId, caught?.code === 'ANALYSIS_SNAPSHOT_PUBLICATION_WITHDRAWN' ? 'withdrawn' : 'missing');
      void open(selectedRef.current, { preserveMode: true, deliberate: false });
    }
  };
  // Every cached surface reflects newer known withdrawal, including receipts
  // and earlier list pages. Reading an old acceptance cannot restore its policy.
  const currentFull = value => {
    const known = value && policies.current.get(value.publicationId);
    return known ? { ...value, policy: known.policy, canWithdraw: false, package: null, availability: null } : value;
  };
  const visibleItems = items.map(item => policies.current.has(item.publicationId)
    ? { ...item, policy: policies.current.get(item.publicationId).policy, canWithdraw: false, selection: null } : item);
  const visibleActivity = activity.map(item => policies.current.has(item.acceptance.publicationId)
    ? { ...item, currentPolicy: policies.current.get(item.acceptance.publicationId).policy } : item);
  return { mode, navigate, items: visibleItems, cursor, loaded, loading, activity: visibleActivity, activityCursor, activityLoaded, activityLoading, selected: currentFull(selected),
    acknowledgement, receipt: receipt ? { ...receipt, current: currentFull(receipt.current) } : null, original, lastCheck, existing, phase, busy: !!phase, error, notice, serviceId: service.current,
    canPublish: usable && canWrite && savedAnalysis?.status === 'active' && allowed === true,
    bodyBlocked: !!selected && blocked.has(selected.publicationId), load, loadActivity, open, reviewSeed, checkRequest,
    publish: () => mutate('publish'), withdraw: () => mutate('withdraw'), retry: () => mutate(originalRef.current?.action, true),
    confirmWithdrawal: () => navigate('confirm-withdraw'), releaseChecked, revoke, readFailure,
    openReceipt: () => { if (receipt) { retain(constrain(receipt.current)); navigate('detail'); } },
  };
}
