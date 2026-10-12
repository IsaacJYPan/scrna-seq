import { getExecutionTargetSnapshot, withExecutionTarget } from '../runtime/executionTarget';
import { SUBMISSION_RECOVERY_MESSAGES as messages } from './submissionRecoveryMessages';

export const RECOVERY_STORAGE_KEY = 'traceomics_submission_recovery_v1';
export const RECOVERY_GENERATION_KEY = `${RECOVERY_STORAGE_KEY}_generation`;
const base = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/+$/, '');
const MAX_RECORDS = 24;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ID = /^[a-zA-Z0-9_-]{1,96}$/;
const HASH = /^[a-f0-9]{64}$/;
const empty = () => ({ scope: null, generation: null, accessGeneration: null, connectionIdentity: '', connectionEpoch: 0, records: [], selection: null, checking: false, error: '' });
let snapshot = Object.freeze(empty());
let revision = 0;
let accessSequence = 0;
let expectedOwner;
let quarantine;
let stopStorageWatching;
const listeners = new Set();
const companions = new Set();
let initialization;
const checks = new Map();
const emit = next => { snapshot = Object.freeze(next); for (const listener of listeners) listener(); };
export const getSubmissionRecoverySnapshot = () => snapshot;
export const subscribeSubmissionRecovery = listener => { listeners.add(listener); return () => listeners.delete(listener); };
const failure = (message, code = 'SUBMISSION_RECOVERY_REQUIRED') => Object.assign(new Error(message), { code });
const sameScope = (a, b) => a && b && a.installationId === b.installationId && a.userId === b.userId && a.targetHash === b.targetHash;

function cleanRecord(value) {
  if (!value || !['job', 'workflow'].includes(value.kind) || !UUID.test(value.requestId) || !ID.test(value.projectId)
    || !['pending', 'accepted', 'missing'].includes(value.state) || !Number.isFinite(Date.parse(value.createdAt))) return null;
  if (value.kind === 'workflow' && !ID.test(value.instanceId)) return null;
  if (value.jobId !== undefined && !/^job_[a-zA-Z0-9_-]{1,92}$/.test(value.jobId)) return null;
  if (value.requestHash !== undefined && !HASH.test(value.requestHash)) return null;
  if (value.state === 'accepted' && (!value.jobId || !value.requestHash)) return null;
  return { kind: value.kind, requestId: value.requestId, projectId: value.projectId, state: value.state, createdAt: value.createdAt,
    ...(value.instanceId ? { instanceId: value.instanceId } : {}), ...(value.jobId ? { jobId: value.jobId } : {}),
    ...(value.requestHash ? { requestHash: value.requestHash } : {}) };
}

function cleanSelection(value) {
  return value && ID.test(value.projectId) && /^(?:job_|pex_)[a-zA-Z0-9_-]{1,92}$/.test(value.runId)
    ? { projectId: value.projectId, runId: value.runId } : null;
}

function readStorage() {
  const raw = localStorage.getItem(RECOVERY_STORAGE_KEY);
  const generation = localStorage.getItem(RECOVERY_GENERATION_KEY);
  let envelope = null;
  try {
    if (raw && raw.length <= 32768) {
      const value = JSON.parse(raw);
      const scope = value?.scope;
      if (value.version === 1 && UUID.test(value.generation) && value.generation === generation
        && /^svc_[a-f0-9]{32}$/.test(scope?.installationId) && Number.isSafeInteger(scope.userId) && scope.userId > 0
        && HASH.test(scope.targetHash) && Array.isArray(value.records) && value.records.length <= MAX_RECORDS) {
        const records = value.records.map(cleanRecord);
        if (records.every(Boolean) && new Set(records.map(record => record.requestId)).size === records.length && (value.accessGeneration === undefined || UUID.test(value.accessGeneration))) envelope = {
          scope: { installationId: scope.installationId, userId: scope.userId, targetHash: scope.targetHash }, generation,
          accessGeneration: value.accessGeneration || generation, records, selection: cleanSelection(value.selection),
        };
      }
    }
  } catch { /* Invalid storage never becomes an execution instruction. */ }
  return { raw, generation, envelope };
}

function invalidateMemory(error = '') {
  revision += 1; initialization = null; checks.clear(); emit({ ...empty(), error });
}

function mergeEnvelope(envelope, extra = {}) {
  const previous = new Map(snapshot.records.map(record => [record.requestId, record]));
  const records = envelope.records.map(record => {
    const old = previous.get(record.requestId);
    const confirmed = sameScope(snapshot.scope, envelope.scope) && snapshot.generation === envelope.generation
      && old?.confirmed && record.state === 'accepted' && old.state === 'accepted'
      && record.createdAt === old.createdAt && record.jobId === old.jobId && record.requestHash === old.requestHash;
    return { ...record, confirmed: Boolean(confirmed) };
  });
  return { ...snapshot, ...envelope, records, ...extra };
}
const applyEnvelope = (envelope, extra) => emit(mergeEnvelope(envelope, extra));

function watchStorage() {
  if (stopStorageWatching) return;
  const changed = event => {
    if (event.key !== null && ![RECOVERY_STORAGE_KEY, RECOVERY_GENERATION_KEY].includes(event.key)) return;
    if (!snapshot.scope && !quarantine) return;
    try {
      const { envelope } = readStorage();
      if (quarantine) {
        const proof = envelope && sameScope(envelope.scope, quarantine.scope) && envelope.generation === quarantine.generation
          && envelope.accessGeneration !== quarantine.accessGeneration && !envelope.records.some(record => record.projectId === quarantine.projectId)
          && envelope.selection?.projectId !== quarantine.projectId
          && [...companions].every(companion => !companion.proveProjectCleared || companion.proveProjectCleared(quarantine.projectId, envelope));
        if (proof) {
          quarantine = null;
          ensureSubmissionRecovery({ userId: expectedOwner, force: true }).then(() => reconcileSubmissions()).catch(() => {});
        }
        return;
      }
      if (!envelope || !sameScope(envelope.scope, snapshot.scope) || envelope.generation !== snapshot.generation) invalidateMemory(messages.identity);
      else applyEnvelope(envelope);
    } catch { invalidateMemory(messages.storage); }
  };
  window.addEventListener('storage', changed);
  stopStorageWatching = () => { window.removeEventListener('storage', changed); stopStorageWatching = null; };
}

async function ledgerLock(action) {
  if (typeof navigator.locks?.request !== 'function') throw failure(messages.coordination, 'SUBMISSION_COORDINATION_UNAVAILABLE');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    return await navigator.locks.request(RECOVERY_STORAGE_KEY, { mode: 'exclusive', signal: controller.signal }, () => {
      if (controller.signal.aborted) throw failure(messages.coordination, 'SUBMISSION_COORDINATION_UNAVAILABLE');
      return action();
    });
  } catch (error) {
    if (controller.signal.aborted) throw failure(messages.coordination, 'SUBMISSION_COORDINATION_UNAVAILABLE');
    throw error;
  } finally { clearTimeout(timer); }
}

function writeEnvelope(next) {
  const value = { version: 1, scope: next.scope, generation: next.generation, accessGeneration: next.accessGeneration, records: next.records.map(cleanRecord), selection: cleanSelection(next.selection) };
  if (value.records.some(record => !record)) throw failure(messages.storage, 'SUBMISSION_STORAGE_UNAVAILABLE');
  try { localStorage.setItem(RECOVERY_STORAGE_KEY, JSON.stringify(value)); }
  catch { throw failure(messages.storage, 'SUBMISSION_STORAGE_UNAVAILABLE'); }
  emit(next);
}

const contextNow = () => ({ revision, scope: snapshot.scope, generation: snapshot.generation, accessGeneration: snapshot.accessGeneration, epoch: getExecutionTargetSnapshot().epoch });
const matchesContext = context => context.revision === revision && sameScope(snapshot.scope, context.scope)
  && context.generation === snapshot.generation && getExecutionTargetSnapshot().epoch === context.epoch && !getExecutionTargetSnapshot().blocked;
const sameRecord = (a, b) => a && b && a.requestId === b.requestId && a.projectId === b.projectId
  && a.kind === b.kind && a.instanceId === b.instanceId && a.createdAt === b.createdAt;

function latestWithinLock(context, record, accessSensitive = false) {
  if (!matchesContext(context)) throw failure(messages.identity, 'SUBMISSION_RECOVERY_CHANGED');
  const { envelope } = readStorage();
  if (!envelope || !sameScope(envelope.scope, context.scope) || envelope.generation !== context.generation) {
    invalidateMemory(messages.identity); throw failure(messages.identity, 'SUBMISSION_RECOVERY_CHANGED');
  }
  applyEnvelope(envelope);
  if (accessSensitive && envelope.accessGeneration !== context.accessGeneration) throw failure(messages.identity, 'SUBMISSION_RECOVERY_CHANGED');
  if (record && !snapshot.records.some(item => sameRecord(item, record))) throw failure(messages.identity, 'SUBMISSION_RECOVERY_CHANGED');
  return snapshot;
}

async function alterLedger(change, { context = contextNow(), record, quiet = false, accessSensitive = false } = {}) {
  try {
    return await ledgerLock(() => {
      const latest = latestWithinLock(context, record, accessSensitive);
      const next = change(latest);
      if (!next) return null;
      writeEnvelope(next); return next;
    });
  } catch (error) {
    if (!quiet && matchesContext(context)) emit({ ...snapshot, error: error.message });
    return null;
  }
}

export async function clearSubmissionRecovery({ preserveOwner = false } = {}) {
  quarantine = null; invalidateMemory(); if (!preserveOwner) expectedOwner = undefined; stopStorageWatching?.();
  const clear = () => {
    try { localStorage.setItem(RECOVERY_GENERATION_KEY, crypto.randomUUID()); }
    finally {
      try { for (const companion of companions) companion.clear(); }
      finally { localStorage.removeItem(RECOVERY_STORAGE_KEY); }
    }
  };
  try {
    if (typeof navigator.locks?.request === 'function') await ledgerLock(clear); else clear();
  } catch { /* Memory remains invalidated; future admission still requires a durable protected ledger. */ }
}

export async function clearProjectSubmissionRecovery(projectId) {
  const context = contextNow();
  const updated = await alterLedger(latest => {
    const accessGeneration = crypto.randomUUID();
    for (const companion of companions) companion.clearProject(projectId, { ...latest, accessGeneration });
    return { ...latest, records: latest.records.filter(record => record.projectId !== projectId),
      selection: latest.selection?.projectId === projectId ? null : latest.selection, accessGeneration, accessLoss: { projectId, sequence: ++accessSequence } };
  }, { context });
  if (!updated && matchesContext(context)) {
    quarantine = { scope: context.scope, generation: context.generation, accessGeneration: context.accessGeneration, projectId };
    invalidateMemory(messages.storage);
  }
  return updated;
}

async function readJson(path, signal) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) throw new DOMException('Receipt check canceled.', 'AbortError');
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, 10000); let reader;
  try {
    const response = await fetch(`${base}${path}`, { credentials: 'include', signal: controller.signal });
    if (!response.ok) throw Object.assign(new Error('The submission receipt could not be checked.'), { status: response.status });
    const limit = 16384;
    if (Number(response.headers?.get('content-length')) > limit) throw new Error('The submission receipt exceeds its response limit.');
    let value;
    if (response.body?.getReader) {
      reader = response.body.getReader(); const decoder = new TextDecoder(); let text = ''; let size = 0;
      for (;;) {
        const part = await reader.read(); if (part.done) break;
        size += part.value.byteLength;
        if (size > limit) throw new Error('The submission receipt exceeds its response limit.');
        text += decoder.decode(part.value, { stream: true });
      }
      value = JSON.parse(text + decoder.decode());
    } else {
      value = await response.json();
      if (JSON.stringify(value).length > limit) throw new Error('The submission receipt exceeds its response limit.');
    }
    return value;
  } catch (error) {
    if (controller.signal.aborted && !signal?.aborted) throw failure('The server did not confirm the receipt within ten seconds. Check again before submitting more work.');
    throw error;
  } finally { reader?.cancel().catch(() => {}); clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

async function targetHash(identity) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function ensureSubmissionRecovery({ userId, force = false, signal } = {}) {
  if (quarantine) throw failure(messages.storage, 'SUBMISSION_STORAGE_UNAVAILABLE');
  if (userId) expectedOwner = userId;
  watchStorage();
  return withExecutionTarget(async () => {
    if (quarantine) throw failure(messages.storage, 'SUBMISSION_STORAGE_UNAVAILABLE');
    const connection = getExecutionTargetSnapshot();
    const identity = connection.identity || `${base || window.location.origin}`;
    if (!force && snapshot.scope && snapshot.connectionIdentity === connection.identity && (!userId || snapshot.scope.userId === userId)) return snapshot;
    const key = `${identity}:${userId || ''}:${connection.epoch}`;
    if (initialization?.key === key) return initialization.promise;
    const token = revision; const before = readStorage();
    const promise = (async () => {
      const value = await readJson('/api/auth/installation', signal);
      if (value?.schema !== 'traceomics.installation.v1' || !/^svc_[a-f0-9]{32}$/.test(value.installationId)
        || !Number.isSafeInteger(value.userId) || value.userId <= 0) throw failure(messages.identity);
      if (userId && value.userId !== userId) { await clearSubmissionRecovery({ preserveOwner: true }); throw failure(messages.identity); }
      const scope = { installationId: value.installationId, userId: value.userId, targetHash: await targetHash(identity) };
      return ledgerLock(() => {
        if (quarantine) throw failure(messages.storage, 'SUBMISSION_STORAGE_UNAVAILABLE');
        if (token !== revision || getExecutionTargetSnapshot().epoch !== connection.epoch || signal?.aborted) throw new DOMException('Server identity changed.', 'AbortError');
        const current = readStorage();
        if (current.generation !== before.generation && (snapshot.scope || !sameScope(current.envelope?.scope, scope))) {
          invalidateMemory(messages.identity); throw failure(messages.identity, 'SUBMISSION_RECOVERY_CHANGED');
        }
        if (snapshot.scope && sameScope(snapshot.scope, scope) && snapshot.generation !== current.envelope?.generation) {
          invalidateMemory(messages.identity); throw failure(messages.identity, 'SUBMISSION_RECOVERY_CHANGED');
        }
        let envelope = current.envelope;
        if (!sameScope(envelope?.scope, scope)) {
          if (current.raw !== before.raw) { invalidateMemory(messages.identity); throw failure(messages.identity, 'SUBMISSION_RECOVERY_CHANGED'); }
          const generation = crypto.randomUUID(); localStorage.setItem(RECOVERY_GENERATION_KEY, generation);
          for (const companion of companions) companion.clear();
          envelope = { scope, generation, accessGeneration: generation, records: [], selection: null };
        }
        const changed = !sameScope(snapshot.scope, scope) || snapshot.generation !== envelope.generation;
        if (changed) revision += 1;
        const previousEpoch = snapshot.connectionEpoch;
        const next = mergeEnvelope(envelope, { connectionIdentity: connection.identity, connectionEpoch: connection.epoch, error: '' });
        const records = changed || previousEpoch !== connection.epoch ? next.records.map(record => ({ ...record, confirmed: false })) : next.records;
        writeEnvelope({ ...next, records }); return snapshot;
      });
    })().catch(async error => { if (token === revision && [401, 403].includes(error.status)) await clearSubmissionRecovery({ preserveOwner: true }); throw error;
    }).finally(() => { if (initialization?.promise === promise) initialization = null; });
    initialization = { key, promise }; return promise;
  });
}

function accepted(record, receipt) {
  const schema = record.kind === 'workflow' ? 'traceomics.workflow-submission.v1' : 'traceomics.job-submission.v1';
  if (receipt?.schema !== schema || receipt.requestId !== record.requestId || receipt.projectId !== record.projectId
    || (record.kind === 'workflow' && receipt.instanceId !== record.instanceId)
    || !/^job_[a-zA-Z0-9_-]{1,92}$/.test(receipt.jobId) || !HASH.test(receipt.requestHash)
    || (record.jobId && record.jobId !== receipt.jobId) || (record.requestHash && record.requestHash !== receipt.requestHash)) throw failure('The receipt did not match this exact submission. No work was replayed.');
  return { ...record, state: 'accepted', jobId: receipt.jobId, requestHash: receipt.requestHash, confirmed: true };
}

export async function submitWithRecovery({ projectId, instanceId, kind = 'job', requestId = crypto.randomUUID(), submit }) {
  return withExecutionTarget(async () => {
    if (!['job', 'workflow'].includes(kind) || !ID.test(projectId) || !UUID.test(requestId) || (kind === 'workflow' && !ID.test(instanceId))) throw failure(messages.invalid);
    await ensureSubmissionRecovery({ userId: expectedOwner, force: true });
    const context = contextNow();
    const record = { kind, projectId, requestId, state: 'pending', createdAt: new Date().toISOString(), ...(instanceId ? { instanceId } : {}) };
    await ledgerLock(() => {
      const latest = latestWithinLock(context, undefined, true);
      if (latest.records.some(item => item.requestId === requestId || (item.projectId === projectId && (item.state !== 'accepted' || !item.confirmed)))) throw failure(messages.earlier);
      const records = [...latest.records];
      if (records.length >= MAX_RECORDS) {
        const removable = records.findIndex(item => item.state === 'accepted' && item.confirmed && item.jobId !== latest.selection?.runId);
        if (removable < 0) throw failure(messages.limit); records.splice(removable, 1);
      }
      writeEnvelope({ ...latest, records: [...records, record], error: '' });
    });
    // A different window may have cleared access after the admission lock was released.
    latestWithinLock(context, record, true);
    if (!matchesContext(context)) throw failure(messages.identity, 'SUBMISSION_RECOVERY_CHANGED');
    try {
      const result = await submit(requestId);
      const updated = await alterLedger(latest => {
        const current = latest.records.find(item => sameRecord(item, record)); const confirmed = accepted(current, result?.submission);
        return { ...latest, records: latest.records.map(item => item.requestId === requestId ? confirmed : item), selection: { projectId, runId: confirmed.jobId }, error: '' };
      }, { context, record });
      if (!updated && matchesContext(context) && snapshot.records.some(item => sameRecord(item, record))) throw failure(messages.unconfirmed, 'SUBMISSION_UNCONFIRMED');
      return result;
    } catch (error) {
      if (matchesContext(context)) {
        if (error.status === 401) await clearSubmissionRecovery({ preserveOwner: true });
        else if (error.status === 403) await clearProjectSubmissionRecovery(projectId);
        else if ([400, 404, 422].includes(error.status)) await alterLedger(latest => ({ ...latest, records: latest.records.filter(item => item.requestId !== requestId) }), { context, record });
      }
      if ([400, 401, 403, 404, 422].includes(error.status)) throw error;
      throw failure(messages.unconfirmed, 'SUBMISSION_UNCONFIRMED');
    }
  }, { mutation: true });
}

export async function checkSubmissionReceipt(requestId, { signal } = {}) {
  const record = snapshot.records.find(item => item.requestId === requestId);
  if (!record || !snapshot.scope) return null;
  if (checks.has(requestId)) return checks.get(requestId);
  const context = contextNow();
  const promise = withExecutionTarget(async () => {
    const path = record.kind === 'workflow' ? `/api/workflows/${encodeURIComponent(record.projectId)}/instances/${encodeURIComponent(record.instanceId)}/submissions/${requestId}`
      : `/api/projects/${encodeURIComponent(record.projectId)}/job-submissions/${requestId}`;
    try {
      const receipt = await readJson(path, signal); if (signal?.aborted) return null;
      accepted(record, receipt);
      const updated = await alterLedger(latest => {
        let confirmed;
        const current = latest.records.find(item => sameRecord(item, record)); confirmed = accepted(current, receipt);
        return { ...latest, records: latest.records.map(item => item.requestId === requestId ? confirmed : item), error: '',
          selection: latest.selection || { projectId: record.projectId, runId: confirmed.jobId } };
      }, { context, record });
      return updated?.records.find(item => sameRecord(item, record)) || null;
    } catch (error) {
      if (!matchesContext(context) || signal?.aborted) return null;
      if (error.status === 401) await clearSubmissionRecovery({ preserveOwner: true });
      else if (error.status === 403) await clearProjectSubmissionRecovery(record.projectId);
      else if (error.status === 404) {
        try { await readJson(`/api/projects/${encodeURIComponent(record.projectId)}`, signal); }
        catch (accessError) {
          if (matchesContext(context) && accessError.status === 401) await clearSubmissionRecovery({ preserveOwner: true });
          else if (matchesContext(context) && [403, 404].includes(accessError.status)) await clearProjectSubmissionRecovery(record.projectId);
          else if (matchesContext(context)) emit({ ...snapshot, error: 'Project access and submission acceptance could not be checked. No work was replayed.' });
          return null;
        }
        await alterLedger(latest => ({ ...latest, records: latest.records.map(item => item.requestId === requestId && (record.state === 'accepted' || item.state !== 'accepted')
          ? { ...item, state: 'missing', confirmed: false } : item), error: '' }), { context, record });
      } else await alterLedger(latest => ({ ...latest, records: latest.records.map(item => item.requestId === requestId ? { ...item, confirmed: false } : item),
        error: 'The server could not confirm the saved submission. Keep its identifier and check again before submitting work.' }), { context, record });
      return null;
    }
  }).finally(() => { if (checks.get(requestId) === promise) checks.delete(requestId); });
  checks.set(requestId, promise); return promise;
}

export async function reconcileSubmissions({ projectId, signal } = {}) {
  const context = contextNow(); emit({ ...snapshot, checking: true });
  const pending = snapshot.records.filter(record => !projectId || record.projectId === projectId); let index = 0;
  try { await Promise.all(Array.from({ length: Math.min(4, pending.length) }, async () => {
    while (index < pending.length && matchesContext(context) && !signal?.aborted) await checkSubmissionReceipt(pending[index++].requestId, { signal });
  })); } finally { if (matchesContext(context)) emit({ ...snapshot, checking: false }); }
}

export async function forgetSubmission(requestId) {
  return alterLedger(latest => {
    const record = latest.records.find(item => item.requestId === requestId);
    return { ...latest, records: latest.records.filter(item => item.requestId !== requestId), accessGeneration: crypto.randomUUID(), error: '', selection: record?.jobId === latest.selection?.runId ? null : latest.selection };
  });
}

export async function selectRecoveredRun(projectId, runId, { requestId } = {}) {
  const selection = cleanSelection({ projectId, runId }); if (!snapshot.scope || !selection) return null;
  const record = requestId ? snapshot.records.find(item => item.requestId === requestId && item.projectId === projectId && item.jobId === runId && item.confirmed) : undefined;
  if (requestId && !record) return null;
  return alterLedger(latest => ({ ...latest, selection }), { accessSensitive: true, record });
}

export async function clearRecoveredRunSelection(projectId) {
  return alterLedger(latest => latest.selection?.projectId === projectId ? { ...latest, selection: null } : null);
}

// Companion ledgers share the authenticated scope, tombstone and short Web Lock.
// Hooks must be synchronous: no network requests or scientific work inside a lock.
export const submissionRecoveryCoordination = Object.freeze({
  lock: ledgerLock, readJson, context: contextNow, matches: matchesContext,
  latest: latestWithinLock, sameScope,
  registerCompanion(companion) { companions.add(companion); return () => companions.delete(companion); },
});
