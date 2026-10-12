import { getExecutionTargetSnapshot, withExecutionTarget } from '../runtime/executionTarget';
import {
  clearProjectSubmissionRecovery, clearSubmissionRecovery, ensureSubmissionRecovery,
  getSubmissionRecoverySnapshot, subscribeSubmissionRecovery, submissionRecoveryCoordination as shared,
} from './submissionRecovery';

export const PRIVATE_RECOVERY_STORAGE_KEY = 'traceomics_private_r_submission_recovery_v1';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9_-]{1,120}$/;
const KERNEL = /^pk_[a-f0-9]{24}$/;
const EXECUTION = /^pex_[a-f0-9]{24}$/;
const PUBLICATION = /^pub_[a-f0-9]{24}$/;
const RESTART = /^prst_[a-f0-9]{24}$/;
const VERSION = /^av_[a-f0-9]{24}$/;
const KINDS = ['start', 'execution', 'publication', 'restart'];
const STATUSES = {
  start: ['starting', 'ready', 'running', 'unknown', 'stopping', 'stopped', 'failed'],
  execution: ['reserved', 'running', 'unknown', 'completed', 'failed'],
  publication: ['reserved', 'running', 'unknown', 'completed', 'failed'],
  restart: ['stopping', 'starting', 'unknown', 'completed', 'failed'],
};
const messages = {
  storage: 'The private R request identifier could not be saved. No further work was submitted. Free browser storage and check the exact receipt.',
  identity: 'The authenticated server or private R recovery scope changed. Reconnect and check your exact request before continuing.',
  earlier: 'An earlier private R request has not been confirmed. Check its exact receipt before starting more work in this session.',
  unconfirmed: 'Acceptance of this private R request is unconfirmed. Its identifier was saved. Check its exact receipt before continuing.',
  receipt: 'The server could not confirm this exact private R request. Keep its identifier and check again before submitting more work.',
  invalid: 'A valid private R request identity is required. No work was submitted.',
  limit: 'The saved private R request limit has been reached. Resolve earlier requests before starting more work.',
};
const failure = (message, code = 'PRIVATE_SUBMISSION_RECOVERY_REQUIRED') => Object.assign(new Error(message), { code });
const empty = () => ({ scope: null, generation: null, mutationGeneration: null, accessGeneration: null, connectionEpoch: 0, records: [], selection: null, checking: false, error: '' });
let snapshot = Object.freeze(empty());
let revision = 0;
let expectedOwner;
let watching = false;
const listeners = new Set();
const checks = new Map();
const emit = next => { snapshot = Object.freeze(next); for (const listener of listeners) listener(); };
export const getPrivateRecoverySnapshot = () => snapshot;
export const subscribePrivateRecovery = listener => { listeners.add(listener); watch(); return () => listeners.delete(listener); };
const invalidate = (error = '') => { revision += 1; checks.clear(); emit({ ...empty(), error }); };
const time = value => typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));

function cleanRecord(value) {
  if (!value || !KINDS.includes(value.kind) || !UUID.test(value.requestId) || !ID.test(value.projectId) || !ID.test(value.workspaceId)
    || !['pending', 'accepted', 'missing'].includes(value.state) || !time(value.createdAt) || !HASH.test(value.requestHash)) return null;
  if (value.kind !== 'start' && (!KERNEL.test(value.kernelId) || !HASH.test(value.generation))) return null;
  if (value.kernelId !== undefined && !KERNEL.test(value.kernelId)) return null;
  if (value.generation != null && !HASH.test(value.generation)) return null;
  if (value.status !== undefined && !STATUSES[value.kind].includes(value.status)) return null;
  if (value.completionKnown !== undefined && typeof value.completionKnown !== 'boolean') return null;
  for (const [key, pattern] of [['executionId', EXECUTION], ['sourceExecutionId', EXECUTION], ['publicationId', PUBLICATION], ['restartId', RESTART], ['replacementKernelId', KERNEL], ['versionId', VERSION]]) {
    if (value[key] != null && !pattern.test(value[key])) return null;
  }
  if (value.order !== undefined && (!Number.isSafeInteger(value.order) || value.order < 1 || value.order > 500)) return null;
  if (value.state === 'accepted' && (!value.kernelId || !value.status || typeof value.completionKnown !== 'boolean'
    || (value.kind === 'execution' && (!value.executionId || !value.order))
    || (value.kind === 'publication' && (!value.publicationId || !value.sourceExecutionId || !value.order))
    || (value.kind === 'restart' && !value.restartId))) return null;
  if (value.state === 'accepted' && value.completionKnown !== (value.kind === 'start'
    ? Boolean(value.generation || ['stopped', 'failed'].includes(value.status)) : ['completed', 'failed'].includes(value.status))) return null;
  if (value.kind === 'publication' && value.status === 'completed' && !value.versionId) return null;
  if (value.kind === 'restart' && value.status === 'completed' && !value.replacementKernelId) return null;
  const result = { kind: value.kind, requestId: value.requestId, projectId: value.projectId, workspaceId: value.workspaceId,
    state: value.state, createdAt: value.createdAt, requestHash: value.requestHash };
  for (const key of ['kernelId', 'generation', 'executionId', 'sourceExecutionId', 'publicationId', 'restartId', 'replacementKernelId', 'versionId', 'order', 'status', 'completionKnown']) {
    if (value[key] !== undefined) result[key] = value[key];
  }
  return result;
}

function cleanSelection(value) {
  if (!value || !ID.test(value.projectId) || !ID.test(value.workspaceId) || !KERNEL.test(value.kernelId)
    || value.executionId !== undefined && !EXECUTION.test(value.executionId) || value.requestId !== undefined && !UUID.test(value.requestId)) return null;
  return { projectId: value.projectId, workspaceId: value.workspaceId, kernelId: value.kernelId,
    ...(value.executionId ? { executionId: value.executionId } : {}), ...(value.requestId ? { requestId: value.requestId } : {}) };
}

function readEnvelope(authority = getSubmissionRecoverySnapshot()) {
  const raw = localStorage.getItem(PRIVATE_RECOVERY_STORAGE_KEY);
  if (!raw) return { raw, envelope: null };
  let envelope;
  try {
    const value = raw.length <= 32768 && new TextEncoder().encode(raw).byteLength <= 32768 ? JSON.parse(raw) : null;
    if (value?.version === 1 && shared.sameScope(value.scope, authority.scope) && value.generation === authority.generation
      && UUID.test(value.mutationGeneration) && UUID.test(value.accessGeneration) && Array.isArray(value.records) && value.records.length <= 24) {
      const records = value.records.map(cleanRecord);
      if (records.every(Boolean) && new Set(records.map(record => record.requestId)).size === records.length) envelope = {
        scope: authority.scope, generation: authority.generation, mutationGeneration: value.mutationGeneration,
        accessGeneration: authority.accessGeneration, records, selection: cleanSelection(value.selection),
      };
    }
  } catch { /* Untrusted persisted values never become execution instructions. */ }
  return { raw, envelope: envelope || null };
}

const sameRecord = (a, b) => a && b && a.requestId === b.requestId && a.kind === b.kind && a.projectId === b.projectId
  && a.workspaceId === b.workspaceId && a.createdAt === b.createdAt && a.requestHash === b.requestHash
  && (!b.kernelId || a.kernelId === b.kernelId) && (!b.generation || a.generation === b.generation);
function merge(envelope, extras = {}) {
  const previous = new Map(snapshot.records.map(record => [record.requestId, record]));
  const same = shared.sameScope(snapshot.scope, envelope.scope) && snapshot.generation === envelope.generation;
  return { ...snapshot, ...envelope, ...extras, records: envelope.records.map(record => {
    const old = previous.get(record.requestId);
    return { ...record, confirmed: Boolean(same && old?.confirmed && record.state === 'accepted' && old.state === 'accepted'
      && sameRecord(record, old) && record.kernelId === old.kernelId && record.executionId === old.executionId
      && record.publicationId === old.publicationId && record.restartId === old.restartId
      && record.status === old.status && record.completionKnown === old.completionKnown) };
  }) };
}
function write(next) {
  const value = { version: 1, scope: next.scope, generation: next.generation, mutationGeneration: next.mutationGeneration,
    accessGeneration: next.accessGeneration, records: next.records.map(cleanRecord), selection: cleanSelection(next.selection) };
  const encoded = JSON.stringify(value);
  if (value.records.some(record => !record) || new TextEncoder().encode(encoded).byteLength > 32768) throw failure(messages.storage, 'PRIVATE_SUBMISSION_STORAGE_UNAVAILABLE');
  try { localStorage.setItem(PRIVATE_RECOVERY_STORAGE_KEY, encoded); }
  catch { throw failure(messages.storage, 'PRIVATE_SUBMISSION_STORAGE_UNAVAILABLE'); }
  emit(next);
}

// Access removals happen before the canonical access generation is committed.
// If either write fails, the canonical store quarantines both private views.
shared.registerCompanion({
  clear() { try { localStorage.removeItem(PRIVATE_RECOVERY_STORAGE_KEY); } finally { invalidate(); } },
  clearProject(projectId, authority) {
    const { envelope } = readEnvelope(authority);
    if (!envelope) { if (snapshot.scope) invalidate(); return; }
    write({ ...merge(envelope), records: envelope.records.filter(record => record.projectId !== projectId),
      selection: envelope.selection?.projectId === projectId ? null : envelope.selection,
      mutationGeneration: crypto.randomUUID(), accessGeneration: authority.accessGeneration });
  },
  proveProjectCleared(projectId, authority) {
    const { raw, envelope } = readEnvelope(authority);
    if (!raw) return true;
    return Boolean(envelope && JSON.parse(raw).accessGeneration === authority.accessGeneration
      && !envelope.records.some(record => record.projectId === projectId) && envelope.selection?.projectId !== projectId);
  },
});

function watch() {
  if (watching) return;
  watching = true;
  subscribeSubmissionRecovery(() => {
    const authority = getSubmissionRecoverySnapshot();
    if (!snapshot.scope) return;
    if (!authority.scope || !shared.sameScope(authority.scope, snapshot.scope) || authority.generation !== snapshot.generation) invalidate(messages.identity);
    else if (authority.accessGeneration !== snapshot.accessGeneration) invalidate(messages.identity);
  });
  window.addEventListener('storage', event => {
    if (event.key !== null && event.key !== PRIVATE_RECOVERY_STORAGE_KEY) return;
    if (!snapshot.scope) return;
    try {
      const { envelope } = readEnvelope();
      if (!envelope || envelope.mutationGeneration !== snapshot.mutationGeneration) {
        revision += 1; checks.clear();
        if (envelope) emit(merge(envelope)); else invalidate(messages.identity);
      } else emit(merge(envelope));
    } catch { invalidate(messages.storage); }
  });
}

const context = () => ({ shared: shared.context(), revision, mutationGeneration: snapshot.mutationGeneration, epoch: getExecutionTargetSnapshot().epoch });
const matches = value => value.revision === revision && value.mutationGeneration === snapshot.mutationGeneration
  && shared.matches(value.shared) && value.epoch === getExecutionTargetSnapshot().epoch && !getExecutionTargetSnapshot().blocked;
function latest(value, record, accessSensitive = false) {
  if (!matches(value)) throw failure(messages.identity, 'PRIVATE_SUBMISSION_RECOVERY_CHANGED');
  const authority = shared.latest(value.shared, undefined, accessSensitive);
  const { envelope } = readEnvelope(authority);
  if (!envelope || envelope.mutationGeneration !== value.mutationGeneration) {
    invalidate(messages.identity); throw failure(messages.identity, 'PRIVATE_SUBMISSION_RECOVERY_CHANGED');
  }
  emit(merge(envelope));
  if (record && !snapshot.records.some(item => sameRecord(item, record))) throw failure(messages.identity, 'PRIVATE_SUBMISSION_RECOVERY_CHANGED');
  return snapshot;
}
async function alter(change, { capture = context(), record, accessSensitive = false } = {}) {
  try { return await shared.lock(() => { const next = change(latest(capture, record, accessSensitive)); if (!next) return null; write(next); return next; }); }
  catch (error) { if (matches(capture)) emit({ ...snapshot, error: error.message }); return null; }
}

export async function ensurePrivateRecovery({ userId, force = false, signal } = {}) {
  if (userId) expectedOwner = userId;
  watch();
  await ensureSubmissionRecovery({ userId: expectedOwner, force, signal });
  const authority = getSubmissionRecoverySnapshot();
  const capture = shared.context();
  return shared.lock(() => {
    const current = shared.latest(capture, undefined, true);
    if (!current.scope || signal?.aborted) throw failure(messages.identity, 'PRIVATE_SUBMISSION_RECOVERY_CHANGED');
    const { raw, envelope } = readEnvelope(current);
    if (raw && !envelope) {
      // Corrupt same-scope data may contain an unresolved POST; never erase it
      // to make another mutation possible. Explicit logout clears the ledger.
      invalidate(messages.storage); throw failure(messages.storage, 'PRIVATE_SUBMISSION_STORAGE_UNAVAILABLE');
    }
    const nextEnvelope = envelope || { scope: current.scope, generation: current.generation, mutationGeneration: crypto.randomUUID(),
      accessGeneration: current.accessGeneration, records: [], selection: null };
    const changed = !shared.sameScope(snapshot.scope, nextEnvelope.scope) || snapshot.generation !== nextEnvelope.generation
      || snapshot.mutationGeneration !== nextEnvelope.mutationGeneration;
    const epochChanged = snapshot.connectionEpoch !== authority.connectionEpoch;
    if (changed) revision += 1;
    const next = merge(nextEnvelope, { connectionEpoch: authority.connectionEpoch, error: '' });
    if (changed || epochChanged) next.records = next.records.map(record => ({ ...record, confirmed: false }));
    write(next); return snapshot;
  });
}

async function digest(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value)));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}
function hashedInput(kind, input, kernelId) {
  if (kind === 'execution') {
    if (typeof input.source !== 'string' || !input.source.trim() || input.source.includes('\0') || new TextEncoder().encode(input.source).byteLength > 32768) throw failure(messages.invalid);
    return input.source;
  }
  if (kind === 'start') {
    if (!Array.isArray(input.inputs) || input.inputs.length > 5 || !input.environment) throw failure(messages.invalid);
    return { requestId: input.requestId, workspaceId: input.workspaceId, analysisObjectId: input.analysisObjectId || null, environment: input.environment,
      inputs: input.inputs.map(ref => ({ artifactId: ref.artifactId, versionId: ref.versionId, projectId: ref.projectId, sha256: ref.sha256 })) };
  }
  if (kind === 'restart') return { requestId: input.requestId, generation: input.generation, kernelId };
  if (typeof input.name !== 'string' || !input.name.trim() || !['object', 'table', 'figure'].includes(input.type)) throw failure(messages.invalid);
  return { requestId: input.requestId, name: input.name.trim(), type: input.type,
    ...(input.type === 'figure' ? { executionId: input.executionId, figureIndex: input.figureIndex } : { binding: input.binding }), previousVersionId: input.previousVersionId || null };
}

function accepted(record, receipt) {
  if (receipt?.schema !== 'traceomics.private-r-submission.v1' || receipt.kind !== record.kind || receipt.requestId !== record.requestId
    || receipt.projectId !== record.projectId || receipt.workspaceId !== record.workspaceId || receipt.requestHash !== record.requestHash
    || !KERNEL.test(receipt.kernelId) || record.kernelId && receipt.kernelId !== record.kernelId
    || record.generation && receipt.generation !== record.generation) throw failure(messages.receipt);
  const next = cleanRecord({ ...record, state: 'accepted', kernelId: receipt.kernelId, generation: receipt.generation,
    executionId: receipt.executionId, sourceExecutionId: receipt.sourceExecutionId, publicationId: receipt.publicationId,
    restartId: receipt.restartId, replacementKernelId: receipt.replacementKernelId, versionId: receipt.versionId,
    order: receipt.order, status: receipt.status, completionKnown: receipt.completionKnown });
  if (!next) throw failure(messages.receipt);
  if (record.kind !== 'start' && record.state === 'accepted' && record.completionKnown) {
    if (!next.completionKnown && record.confirmed && ['executionId', 'sourceExecutionId', 'publicationId', 'restartId', 'order'].every(key => record[key] == null || record[key] === next[key])) return { ...record, confirmed: true };
    if (!next.completionKnown || next.status !== record.status) throw failure(messages.receipt);
  }
  for (const key of ['executionId', 'sourceExecutionId', 'publicationId', 'restartId', 'replacementKernelId', 'versionId', 'order']) {
    if (record[key] != null && next[key] !== record[key]) throw failure(messages.receipt);
  }
  return { ...next, confirmed: true };
}

const selectionFor = record => cleanSelection({ projectId: record.projectId, workspaceId: record.workspaceId,
  kernelId: record.kind === 'restart' && record.completionKnown && record.status === 'completed' ? record.replacementKernelId : record.kernelId,
  ...(record.executionId || record.sourceExecutionId ? { executionId: record.executionId || record.sourceExecutionId } : {}), requestId: record.requestId });
const blocks = record => record.state !== 'accepted' || !record.confirmed || !record.completionKnown;
const conflicts = (a, b) => a.projectId === b.projectId && (a.workspaceId === b.workspaceId || a.kernelId && a.kernelId === b.kernelId);

export async function submitPrivateWithRecovery(projectId, kind, input, { kernelId, workspaceId = input?.workspaceId, generation = input?.generation, userId, post, signal } = {}) {
  return withExecutionTarget(async () => {
    const originalTarget = getExecutionTargetSnapshot();
    if (!KINDS.includes(kind) || !ID.test(projectId) || !ID.test(workspaceId) || typeof post !== 'function'
      || kind !== 'start' && (!KERNEL.test(kernelId) || !HASH.test(generation))) throw failure(messages.invalid);
    const requestId = (input?.requestId || crypto.randomUUID()).toLowerCase();
    if (!UUID.test(requestId)) throw failure(messages.invalid);
    const body = { ...input, requestId };
    const requestHash = await digest(hashedInput(kind, body, kernelId));
    if (originalTarget.epoch !== getExecutionTargetSnapshot().epoch || getExecutionTargetSnapshot().blocked || signal?.aborted) throw failure(messages.identity, 'PRIVATE_SUBMISSION_RECOVERY_CHANGED');
    await ensurePrivateRecovery({ userId: userId || expectedOwner, force: true, signal });
    if (originalTarget.epoch !== getExecutionTargetSnapshot().epoch || getExecutionTargetSnapshot().blocked || signal?.aborted) throw failure(messages.identity, 'PRIVATE_SUBMISSION_RECOVERY_CHANGED');
    const capture = context();
    const record = { kind, projectId, workspaceId, requestId, requestHash, state: 'pending', createdAt: new Date().toISOString(),
      ...(kernelId ? { kernelId } : {}), ...(generation ? { generation } : {}) };
    await shared.lock(() => {
      const current = latest(capture, undefined, true);
      if (current.records.some(item => item.requestId === requestId || conflicts(item, record) && blocks(item)
        && !(kind === 'restart' && ['execution', 'publication'].includes(item.kind) && item.kernelId === kernelId && item.generation === generation))) throw failure(messages.earlier);
      const records = [...current.records];
      if (records.length >= 24) {
        const remove = records.findIndex(item => !blocks(item) && item.requestId !== current.selection?.requestId);
        if (remove < 0) throw failure(messages.limit);
        records.splice(remove, 1);
      }
      const pendingSelection = kind === 'start' ? null : { ...selectionFor(record),
        ...(kind === 'publication' && current.selection?.kernelId === kernelId && current.selection.executionId
          ? { executionId: current.selection.executionId } : {}) };
      write({ ...current, records: [...records, { ...record, confirmed: false }], selection: pendingSelection, error: '' });
    });
    latest(capture, record, true);
    if (signal?.aborted || !matches(capture)) throw failure(messages.identity, 'PRIVATE_SUBMISSION_RECOVERY_CHANGED');
    try {
      const result = await post(body);
      if (!matches(capture) || signal?.aborted) throw failure(messages.identity, 'PRIVATE_SUBMISSION_RECOVERY_CHANGED');
      const receipt = result?.submission || await shared.readJson(receiptPath(record), signal);
      const updated = await alter(current => {
        const item = current.records.find(value => sameRecord(value, record));
        const confirmed = accepted(item, receipt);
        return { ...current, records: current.records.map(value => value.requestId === requestId ? confirmed : value),
          selection: !current.selection || current.selection.requestId === requestId ? selectionFor(confirmed) : current.selection, error: '' };
      }, { capture, record, accessSensitive: true });
      if (!updated) throw failure(messages.unconfirmed, 'PRIVATE_SUBMISSION_UNCONFIRMED');
      return result;
    } catch (error) {
      if (matches(capture)) {
        if (error.status === 401) await clearSubmissionRecovery({ preserveOwner: true });
        else if (error.status === 403) await clearProjectSubmissionRecovery(projectId);
        else if ([400, 422].includes(error.status)) await alter(current => ({ ...current, records: current.records.filter(item => item.requestId !== requestId) }), { capture, record });
      }
      if ([400, 401, 403, 422].includes(error.status)) throw error;
      throw failure(messages.unconfirmed, 'PRIVATE_SUBMISSION_UNCONFIRMED');
    }
  }, { mutation: true });
}

function receiptPath(record) {
  const prefix = `/api/private-r-kernels/${encodeURIComponent(record.projectId)}`;
  if (record.kind === 'start' || record.kind === 'restart') return `${prefix}/${record.kind}-submissions/${record.requestId}`;
  return `${prefix}/${record.kernelId}/${record.kind}-submissions/${record.requestId}`;
}
export async function checkPrivateSubmissionReceipt(requestId, { signal } = {}) {
  const record = snapshot.records.find(item => item.requestId === requestId);
  if (!record || !snapshot.scope) return null;
  if (checks.has(requestId)) return checks.get(requestId);
  const capture = context();
  const promise = withExecutionTarget(async () => {
    try {
      const receipt = await shared.readJson(receiptPath(record), signal);
      if (signal?.aborted) return null;
      accepted(record, receipt);
      const updated = await alter(current => {
        const item = current.records.find(value => sameRecord(value, record));
        const confirmed = accepted(item, receipt);
        return { ...current, records: current.records.map(value => value.requestId === requestId ? confirmed : value),
          selection: !current.selection || current.selection.requestId === requestId ? selectionFor(confirmed) : current.selection, error: '' };
      }, { capture, record, accessSensitive: true });
      return updated?.records.find(item => sameRecord(item, record)) || null;
    } catch (error) {
      if (!matches(capture) || signal?.aborted) return null;
      if (error.status === 401) await clearSubmissionRecovery({ preserveOwner: true });
      else if (error.status === 403) await clearProjectSubmissionRecovery(record.projectId);
      else if (error.status === 404) {
        try { await shared.readJson(`/api/projects/${encodeURIComponent(record.projectId)}`, signal); }
        catch (accessError) {
          if (matches(capture) && accessError.status === 401) await clearSubmissionRecovery({ preserveOwner: true });
          else if (matches(capture) && [403, 404].includes(accessError.status)) await clearProjectSubmissionRecovery(record.projectId);
          else if (matches(capture)) emit({ ...snapshot, error: messages.receipt });
          return null;
        }
        await alter(current => ({ ...current, records: current.records.map(item => item.requestId === requestId
          && (record.state === 'accepted' || item.state !== 'accepted') ? { ...item, state: 'missing', confirmed: false } : item), error: '' }), { capture, record, accessSensitive: true });
      } else await alter(current => ({ ...current, records: current.records.map(item => item.requestId === requestId ? { ...item, confirmed: false } : item), error: messages.receipt }), { capture, record, accessSensitive: true });
      return null;
    }
  }).finally(() => { if (checks.get(requestId) === promise) checks.delete(requestId); });
  checks.set(requestId, promise); return promise;
}

export async function reconcilePrivateSubmissions({ projectId, workspaceId, requestIds, signal } = {}) {
  const capture = context(); emit({ ...snapshot, checking: true });
  const requested = requestIds ? new Set(requestIds) : null;
  const records = snapshot.records.filter(item => (!projectId || item.projectId === projectId) && (!workspaceId || item.workspaceId === workspaceId)
    && (!requested || requested.has(item.requestId)));
  let index = 0;
  try { await Promise.all(Array.from({ length: Math.min(4, records.length) }, async () => {
    while (index < records.length && matches(capture) && !signal?.aborted) await checkPrivateSubmissionReceipt(records[index++].requestId, { signal });
  })); } finally { if (matches(capture)) emit({ ...snapshot, checking: false }); }
  return snapshot;
}
export async function forgetPrivateSubmission(requestId) {
  return alter(current => ({ ...current, records: current.records.filter(item => item.requestId !== requestId),
    selection: current.selection?.requestId === requestId ? null : current.selection, mutationGeneration: crypto.randomUUID(), error: '' }));
}
export async function selectPrivateRecoveredSession(value, options = {}) {
  const selection = cleanSelection(value);
  if (!selection || !snapshot.scope) return null;
  const record = selection.requestId ? snapshot.records.find(item => item.requestId === selection.requestId && item.projectId === selection.projectId
    && item.workspaceId === selection.workspaceId && item.confirmed && (item.kernelId === selection.kernelId || item.replacementKernelId === selection.kernelId)) : undefined;
  if (selection.requestId && !record) return null;
  return alter(current => {
    if (Object.hasOwn(options, 'expectedSelection')) {
      const expected = cleanSelection(options.expectedSelection);
      if (options.expectedSelection != null && !expected || JSON.stringify(current.selection) !== JSON.stringify(expected)) return null;
    }
    return { ...current, selection };
  }, { record, accessSensitive: true });
}
export async function clearKernelPrivateRecovery(projectId, kernelId, generation) {
  if (!ID.test(projectId) || !KERNEL.test(kernelId) || !HASH.test(generation)) return null;
  return alter(current => ({ ...current, records: current.records.filter(item => !(item.projectId === projectId && item.kernelId === kernelId
    && item.generation === generation && item.kind !== 'restart' && (item.state !== 'accepted' || !item.completionKnown))), selection: current.selection?.projectId === projectId && current.selection.kernelId === kernelId
      && !current.records.some(item => item.kind === 'restart' && item.requestId === current.selection.requestId) ? null : current.selection,
    mutationGeneration: crypto.randomUUID(), error: '' }), { accessSensitive: true });
}
export const forgetPrivateSessionSubmissions = clearKernelPrivateRecovery;
export const clearPrivateRecovery = options => clearSubmissionRecovery(options);
export const clearProjectPrivateRecovery = projectId => clearProjectSubmissionRecovery(projectId);
