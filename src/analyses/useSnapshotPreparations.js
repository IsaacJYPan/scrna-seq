import { useCallback, useEffect, useRef, useState } from 'react';
import { canonicalAnalysisSnapshotPreparation, normalizeAnalysisSnapshotPreparation } from '../../shared/analysisSnapshotPreparationDispatch.mjs';
import * as api from './snapshotPreparationApi';
import { validateSnapshotPreparation, validateSnapshotPreparationList, validateSnapshotPreparationOptions } from './snapshotPreparationValidation';
import { publicErrorMessage } from '../publicError';

const missing = error => error?.status === 404 && error.code === 'ANALYSIS_SNAPSHOT_PREPARATION_NOT_FOUND';
const sourceFailure = error => /^(?:ANALYSIS_SNAPSHOT_SOURCE_|ARTIFACT_|SERVER_IMPORT_)/.test(error.code || '');
const writerFailure = error => ['ANALYSIS_SNAPSHOT_WRITE_REQUIRED', 'ANALYSIS_SNAPSHOT_ANALYSIS_ARCHIVED', 'FORBIDDEN', 'PROJECT_ROLE_REQUIRED'].includes(error.code);
const denied = error => error.status === 401 || !sourceFailure(error) && !writerFailure(error) && (error.status === 403 || error.status === 404 && !missing(error));
const digest = async text => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), value => value.toString(16).padStart(2, '0')).join('');
const emptyNotes = () => ({ summary: '', decisions: '', limitations: '' });
const optionKey = (kind, value) => kind === 'analysis-versions' ? value.version : kind === 'results' ? value.revisionId
  : ['analysis-references', 'analysis-typed-references'].includes(kind) ? JSON.stringify(value.reference) : value.versionId;

export default function useSnapshotPreparations({ projectId, analysisId, userId, savedAnalysis, canWrite, available, isActive }) {
  const [mode, setMode] = useState(canWrite && savedAnalysis?.status === 'active' ? 'choose' : 'library');
  const [analysisVersion, setAnalysisVersion] = useState(savedAnalysis?.version || 1);
  const [results, setResults] = useState([]), [documents, setDocuments] = useState([]), [notes, setNotes] = useState(emptyNotes), [prerequisites, setPrerequisites] = useState([]);
  const [linkedDrafts, setLinkedDrafts] = useState({});
  const linkedResults = linkedDrafts[analysisVersion]?.results || [], linkedPrerequisites = linkedDrafts[analysisVersion]?.prerequisites || [];
  const versionRef = useRef(analysisVersion); versionRef.current = analysisVersion;
  const setLinkedResults = update => setLinkedDrafts(previous => {
    const draft = previous[analysisVersion] || { results: [], prerequisites: [] };
    return { ...previous, [analysisVersion]: { ...draft, results: typeof update === 'function' ? update(draft.results) : update } };
  });
  const setLinkedPrerequisites = update => setLinkedDrafts(previous => {
    const draft = previous[analysisVersion] || { results: [], prerequisites: [] };
    return { ...previous, [analysisVersion]: { ...draft, prerequisites: typeof update === 'function' ? update(draft.prerequisites) : update } };
  });
  const [library, setLibrary] = useState([]), [cursor, setCursor] = useState(null), [loaded, setLoaded] = useState(false), [loading, setLoading] = useState(false);
  const [options, setOptions] = useState({}), [optionLoading, setOptionLoading] = useState({});
  const [selected, setSelected] = useState(null), [original, setOriginal] = useState(null), [lastCheck, setLastCheck] = useState('unconfirmed');
  const [allowed, setAllowed] = useState(null), [phase, setPhase] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const mounted = useRef(false), service = useRef(null), permissionEpoch = useRef(0), allowedRef = useRef(null);
  const initialDiscovery = useRef(true);
  const selectedRef = useRef(null), originalRef = useRef(null), action = useRef(null), actionKind = useRef(null);
  const listing = useRef(null), listGeneration = useRef(0), optionRequests = useRef(new Map());
  const usable = available && isActive;
  const scope = useCallback(() => ({ projectId, analysisId, userId, ...(service.current ? { serviceId: service.current } : {}) }), [projectId, analysisId, userId]);
  const cancelAction = useCallback(() => { action.current?.abort(); action.current = null; actionKind.current = null; setPhase(''); }, []);
  const observe = useCallback((value, controller, epoch) => {
    if (!value) {
      permissionEpoch.current++; allowedRef.current = false; setAllowed(false);
      if (controller !== action.current && ['prepare', 'resume'].includes(actionKind.current)) cancelAction();
    } else if (epoch === permissionEpoch.current) { allowedRef.current = true; setAllowed(true); }
  }, [cancelAction]);
  const revoke = useCallback(() => {
    permissionEpoch.current++; cancelAction(); listing.current?.abort(); listGeneration.current++;
    for (const controller of optionRequests.current.values()) controller.abort(); optionRequests.current.clear();
    selectedRef.current = null; setSelected(null); setLibrary([]); setCursor(null); setLoaded(false); setLoading(false); setOptions({}); setOptionLoading({});
    allowedRef.current = false; setAllowed(false); setLastCheck('unconfirmed'); setNotice('');
    setError('Access to this private preparation is unavailable. Reconnect to the same workspace and refresh.');
  }, [cancelAction]);
  useEffect(() => { const controllers = optionRequests.current; mounted.current = true; return () => {
    mounted.current = false; action.current?.abort(); listing.current?.abort();
    for (const controller of controllers.values()) controller.abort();
  }; }, []);
  const valid = controller => mounted.current && !controller.signal.aborted && action.current === controller;
  const retain = value => { selectedRef.current = value; setSelected(value); };
  const fail = (caught, fallback) => {
    if (denied(caught)) revoke();
    else if (writerFailure(caught)) observe(false, action.current, permissionEpoch.current);
    setError(publicErrorMessage(caught, fallback));
  };
  const load = useCallback(async (next = null) => {
    if (!usable) return;
    listing.current?.abort(); const controller = new AbortController(); listing.current = controller;
    const generation = ++listGeneration.current, epoch = permissionEpoch.current;
    setLoading(true); setError('');
    try {
      const result = validateSnapshotPreparationList(await api.listSnapshotPreparations(projectId, analysisId, { cursor: next, signal: controller.signal }), scope());
      if (!mounted.current || controller.signal.aborted || generation !== listGeneration.current) return;
      service.current = result.serviceId; observe(result.canPrepare, controller, epoch);
      if (initialDiscovery.current) { initialDiscovery.current = false; if (!result.canPrepare) setMode('library'); }
      setLibrary(previous => next ? [...new Map([...previous, ...result.items].map(item => [item.preparationId, item])).values()] : result.items);
      setCursor(result.nextCursor); setLoaded(true);
    } catch (caught) {
      if (!mounted.current || controller.signal.aborted || generation !== listGeneration.current) return;
      if (denied(caught)) revoke(); setError(publicErrorMessage(caught, 'Saved preparations could not be loaded. Reconnect to the same workspace and refresh.'));
    } finally { if (mounted.current && generation === listGeneration.current) setLoading(false); }
  }, [usable, projectId, analysisId, scope, observe, revoke]);
  const loadOptions = useCallback(async (kind, next = null) => {
    if (!usable || !service.current) return;
    const linked = ['analysis-references', 'analysis-typed-references'].includes(kind), version = analysisVersion, key = linked ? `${kind}:${version}` : kind;
    optionRequests.current.get(key)?.abort(); const controller = new AbortController(); optionRequests.current.set(key, controller);
    const epoch = permissionEpoch.current; setOptionLoading(previous => ({ ...previous, [key]: true })); setError('');
    try {
      const result = await validateSnapshotPreparationOptions(await api.listSnapshotPreparationOptions(projectId, analysisId, kind,
        { cursor: next, signal: controller.signal, ...(linked ? { analysisVersion: version } : {}) }), scope(), kind, linked ? version : undefined);
      if (!mounted.current || controller.signal.aborted || optionRequests.current.get(key) !== controller) return;
      observe(result.canPrepare, controller, epoch);
      if (linked && versionRef.current !== version) return;
      setOptions(previous => ({ ...previous, [key]: { items: next ? [...new Map([...(previous[key]?.items || []), ...result.items].map(item => [optionKey(kind, item), item])).values()] : result.items, cursor: result.nextCursor } }));
    } catch (caught) {
      if (!mounted.current || controller.signal.aborted || optionRequests.current.get(key) !== controller) return;
      if (denied(caught)) revoke();
      if (!linked || versionRef.current === version) setError(publicErrorMessage(caught, 'Saved material could not be listed. Your current selection is kept.'));
    } finally { if (mounted.current && optionRequests.current.get(key) === controller) setOptionLoading(previous => ({ ...previous, [key]: false })); }
  }, [usable, projectId, analysisId, analysisVersion, scope, observe, revoke]);
  useEffect(() => { if (usable) void load(); }, [usable, load]);
  useEffect(() => {
    if (usable) return;
    cancelAction(); listing.current?.abort(); listGeneration.current++;
    for (const controller of optionRequests.current.values()) controller.abort(); optionRequests.current.clear();
    setLoading(false); setOptionLoading({});
    if (!available) { selectedRef.current = null; setSelected(null); setLibrary([]); setCursor(null); setLoaded(false); setOptions({}); allowedRef.current = null; setAllowed(null); setLastCheck('unconfirmed'); }
  }, [usable, available, cancelAction]);
  useEffect(() => {
    if (canWrite && savedAnalysis?.status === 'active') return;
    permissionEpoch.current++; allowedRef.current = false; setAllowed(false);
    if (['prepare', 'resume'].includes(actionKind.current)) cancelAction();
  }, [canWrite, savedAnalysis?.status, cancelAction]);
  useEffect(() => {
    if (usable && loaded && mode === 'choose') for (const kind of ['analysis-versions', 'results', 'documents']) {
      if (!options[kind] && !optionLoading[kind] && !error) void loadOptions(kind);
    }
  }, [usable, loaded, mode, options, optionLoading, error, loadOptions]);
  useEffect(() => {
    const kinds = ['analysis-references', 'analysis-typed-references'], keys = kinds.map(kind => `${kind}:${analysisVersion}`);
    for (const [name, controller] of optionRequests.current) if (kinds.some(kind => name.startsWith(kind + ':')) && !keys.includes(name)) {
      controller.abort(); optionRequests.current.delete(name);
      setOptionLoading(previous => previous[name] ? { ...previous, [name]: false } : previous);
    }
    if (usable && loaded && mode === 'choose' && !error) kinds.forEach((kind, index) => {
      if (!options[keys[index]] && !optionLoading[keys[index]]) void loadOptions(kind);
    });
  }, [usable, loaded, mode, analysisVersion, options, optionLoading, error, loadOptions]);
  const refresh = async (requestId, controller, expected) => {
    setLastCheck('unconfirmed'); const epoch = permissionEpoch.current;
    const result = await validateSnapshotPreparation(await api.getSnapshotPreparationRequest(projectId, analysisId, requestId, { signal: controller.signal }), scope(), expected?.recipe);
    if (!valid(controller)) return null;
    if (result.requestId !== requestId || expected && result.requestSha256 !== expected.requestSha256) throw new Error('The original preparation identity could not be verified.');
    observe(result.canPrepare, controller, epoch); retain(result); setLastCheck('confirmed'); return result;
  };
  const check = async (requestId = selectedRef.current?.requestId || originalRef.current?.recipe.requestId) => {
    if (!usable || action.current || !requestId || !service.current) return;
    const controller = new AbortController(); action.current = controller; actionKind.current = 'check';
    setPhase('Checking the original preparation…'); setError(''); setNotice(''); setLastCheck('unconfirmed');
    const expected = originalRef.current?.recipe.requestId === requestId ? originalRef.current : undefined;
    try {
      const result = await refresh(requestId, controller, expected); if (!result) return;
      if (!expected) { originalRef.current = null; setOriginal(null); }
      setMode('review'); setNotice('Original preparation checked. Checking does not build or share anything.');
    } catch (caught) {
      if (valid(controller)) { setLastCheck(missing(caught) ? 'missing' : 'unconfirmed'); fail(caught, 'The preparation remains unconfirmed. Keep the original request and check again.'); }
    } finally { if (action.current === controller) { action.current = null; actionKind.current = null; if (mounted.current) setPhase(''); } }
  };
  const prepare = async event => {
    event?.preventDefault();
    if (!usable || !canWrite || savedAnalysis?.status !== 'active' || allowedRef.current !== true || action.current || !service.current
        || originalRef.current && lastCheck !== 'missing') return;
    const controller = new AbortController(); action.current = controller; actionKind.current = 'prepare';
    setPhase('Checking current access…'); setError(''); setNotice('');
    try {
      const epoch = permissionEpoch.current;
      const access = validateSnapshotPreparationList(await api.listSnapshotPreparations(projectId, analysisId, { signal: controller.signal }), scope());
      if (!valid(controller)) return; observe(access.canPrepare, controller, epoch); if (!access.canPrepare || !allowedRef.current) return;
      let record = originalRef.current;
      if (!record) {
        const extended = linkedResults.length > 0 || linkedPrerequisites.length > 0;
        const recipe = normalizeAnalysisSnapshotPreparation({ requestId: crypto.randomUUID(), serviceId: service.current, projectId, analysisId,
          ...(extended ? { schema: 'traceomics.analysis-snapshot-preparation.v2' } : {}),
          ownerUserId: Number(userId), analysisVersion,
          results: extended ? [...results.map(item => ({ kind: 'attachment-revision', ...item })), ...linkedResults] : results,
          documents, notes, prerequisites: [...prerequisites, ...linkedPrerequisites] });
        record = { recipe, requestSha256: await digest(canonicalAnalysisSnapshotPreparation(recipe)) };
        if (!valid(controller)) return; originalRef.current = record; setOriginal(record);
      }
      retain(null); setMode('review'); setPhase('Preparing the exact private preview…'); setLastCheck('unconfirmed');
      const replyEpoch = permissionEpoch.current;
      const result = await validateSnapshotPreparation(await api.createSnapshotPreparation(projectId, analysisId, record.recipe, { signal: controller.signal }), scope(), record.recipe);
      if (!valid(controller)) return;
      if (result.requestSha256 !== record.requestSha256) throw new Error('The original preparation identity could not be verified.');
      observe(result.canPrepare, controller, replyEpoch); retain(result); setLastCheck('confirmed'); void load();
    } catch (caught) { if (valid(controller)) { setLastCheck('unconfirmed'); fail(caught, originalRef.current ? 'Preparation completion is unconfirmed. Check the original request before retrying.' : 'The selection could not be prepared. Review its saved versions and limits.'); } }
    finally { if (action.current === controller) { action.current = null; actionKind.current = null; if (mounted.current) setPhase(''); } }
  };
  const mutate = async operation => {
    const value = selectedRef.current;
    if (!usable || action.current || lastCheck !== 'confirmed' || !value || operation === 'resume' && (!canWrite || !value.canResume || allowedRef.current !== true)
        || operation === 'delete' && !value.canDelete) return;
    const controller = new AbortController(); action.current = controller; actionKind.current = operation;
    setPhase(operation === 'delete' ? 'Checking before removing this private preparation…' : 'Checking before resuming the original preparation…'); setError(''); setNotice('');
    try {
      const expected = value.recipe ? { recipe: value.recipe, requestSha256: value.requestSha256 } : undefined;
      const current = await refresh(value.requestId, controller, expected); if (!current || !valid(controller)) return;
      if (operation === 'resume' && (!current.canResume || !allowedRef.current) || operation === 'delete' && !current.canDelete) return;
      const record = { recipe: current.recipe, requestSha256: current.requestSha256 };
      if (record.recipe) { originalRef.current = record; setOriginal(record); }
      if (operation === 'delete') retain(null);
      setLastCheck('unconfirmed'); setPhase(operation === 'delete' ? 'Removing only the private retained copies…' : 'Resuming the exact private preparation…');
      const body = { requestId: current.requestId, requestSha256: current.requestSha256 }, epoch = permissionEpoch.current;
      const raw = await (operation === 'delete' ? api.deleteSnapshotPreparation : api.resumeSnapshotPreparation)(projectId, analysisId, current.preparationId, body, { signal: controller.signal });
      const result = await validateSnapshotPreparation(raw, scope(), current.recipe || undefined);
      if (!valid(controller)) return;
      if (result.requestId !== current.requestId || result.requestSha256 !== current.requestSha256) throw new Error('The original preparation identity could not be verified.');
      observe(result.canPrepare, controller, epoch); retain(result); setLastCheck('confirmed'); void load();
    } catch (caught) { if (valid(controller)) { setLastCheck('unconfirmed'); fail(caught, 'Completion is unconfirmed. Check this original preparation before trying again.'); } }
    finally { if (action.current === controller) { action.current = null; actionKind.current = null; if (mounted.current) setPhase(''); } }
  };
  const newPreparation = () => {
    if (action.current || originalRef.current && lastCheck === 'unconfirmed') return;
    originalRef.current = null; setOriginal(null); retain(null); setError(''); setNotice(''); setLastCheck('unconfirmed'); setMode('choose');
  };
  const chooseAnalysisVersion = version => {
    setAnalysisVersion(version);
    if (allowedRef.current === true) setError('');
  };
  const navigate = next => { cancelAction(); setMode(next); };
  return { mode, setMode: navigate, analysisVersion, setAnalysisVersion: chooseAnalysisVersion, results, setResults, linkedResults, setLinkedResults,
    linkedPrerequisites, setLinkedPrerequisites, documents, setDocuments, notes, setNotes, prerequisites, setPrerequisites,
    library, cursor, loaded, loading, options, optionLoading, selected, original, lastCheck, allowed, phase, busy: !!phase, error, notice,
    serviceId: service.current, writer: usable && canWrite && savedAnalysis?.status === 'active' && allowed === true,
    load, loadOptions, check, prepare, resume: () => mutate('resume'), remove: () => mutate('delete'), newPreparation, revoke };
}
