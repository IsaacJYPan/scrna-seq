// The demo runs the existing Seurat APIs on isolated guest objects.
const BASE = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/+$/, '');
const STORAGE_KEY = 'traceomics-analysis-demo-v2';
const CLIENT_ID = 'guided-demo';
export const DEFAULT_QC = Object.freeze({ min_features: 200, max_features: 2500, mt_threshold: 5, min_counts: 0 });
export const DEFAULT_PROCESSING = Object.freeze({ scaleFactor: 10000, variableFeatures: 2000, npcs: 30 });
export const DEFAULT_CLUSTERING = Object.freeze({ dims: 10, resolution: 0.5, neighbors: 30, minDist: 0.3 });
const RAW_QC = { min_features: 0, max_features: 0, mt_threshold: 100, min_counts: 0 };
let opening;
let policyRequest;

export async function demoRequest(path, { method = 'GET', body, objectId } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method, credentials: 'include',
    headers: { 'X-Client-ID': CLIENT_ID, 'X-TraceOmics-CSRF': '1',
      ...(body ? { 'Content-Type': 'application/json' } : {}), ...(objectId ? { 'X-Object-ID': objectId } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(90_000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) {
    const error = new Error(response.status === 401 ? 'The demo session has expired. Refresh to open a new session.'
      : response.status === 429 ? 'The server is processing another request. Please retry shortly.'
        : typeof data.error === 'string' ? data.error : 'Unable to connect to the analysis server. Please retry.');
    error.status = response.status; throw error;
  }
  return data;
}

export function readDemoPolicy() {
  if (!policyRequest) policyRequest = demoRequest('/api/auth/policy').catch(error => { policyRequest = null; throw error; });
  return policyRequest;
}
function savedContext() {
  try { return JSON.parse(sessionStorage.getItem(STORAGE_KEY)); }
  catch { throw new Error('The demo could not read its saved session. Restore browser session storage before starting more work.'); }
}
function remember(context) {
  try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(context)); }
  catch { throw new Error('The demo could not retain its request receipt. Restore browser session storage before starting more work.'); }
}
const unconfirmed = () => new Error('The earlier request could not be confirmed. Refresh to check that same request before starting more work. No analysis was repeated.');
function confirmReceipt(context, receipt) {
  const pending = context.pending;
  if (receipt?.schema !== 'traceomics.job-submission.v1' || receipt.requestId !== pending.requestId
    || receipt.projectId !== context.projectId || !/^job_[a-zA-Z0-9_-]{1,92}$/.test(receipt.jobId)
    || !/^[a-f0-9]{64}$/.test(receipt.requestHash) || (pending.id && pending.id !== receipt.jobId)
    || (pending.requestHash && pending.requestHash !== receipt.requestHash)) throw unconfirmed();
  Object.assign(pending, { id: receipt.jobId, requestHash: receipt.requestHash });
  remember(context);
}
async function resolvePendingReceipt(context) {
  const pending = context.pending;
  if (!pending.requestId) {
    // Older demo sessions retain a server-issued job ID but have no UUID.
    if (!pending.id) throw unconfirmed();
    return;
  }
  try {
    const receipt = await demoRequest(`/api/projects/${context.projectId}/job-submissions/${pending.requestId}`);
    if (receipt.job?.jobType !== pending.type || receipt.job?.analysisObjectId !== pending.objectId) throw unconfirmed();
    confirmReceipt(context, receipt);
  } catch { throw unconfirmed(); }
}

async function waitForJob(context, progress) {
  const pending = context.pending;
  await resolvePendingReceipt(context);
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    const data = await demoRequest(`/api/projects/${context.projectId}/jobs/${pending.id}`);
    const job = data.job || data;
    if (job.status === 'completed') {
      if (pending.type === 'checkpoint.save.v1') {
        const id = job.resultAnalysisObjectId || job.result?.resultAnalysisObjectId;
        if (!id) throw new Error('The analysis finished without a saved result. Please retry.');
        context.currentObjectId = id;
        Object.assign(context, pending.nextState);
      }
      delete context.pending; remember(context); return pending;
    }
    if (['failed', 'canceled'].includes(job.status)) {
      delete context.pending; remember(context);
      throw new Error('The result could not be saved or loaded. Your last saved analysis is available after refreshing.');
    }
    progress?.(job.status === 'queued' ? 'Waiting for the server…' : pending.type === 'checkpoint.save.v1' ? 'Saving analysis…' : 'Loading analysis…');
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error('The request is taking longer than expected. Refresh to reconnect to the same saved job.');
}
async function submitJob(context, type, objectId, nextState, progress) {
  if (context.pending) throw unconfirmed();
  const requestId = crypto.randomUUID();
  context.pending = { requestId, type, objectId, parameters: {}, ...(nextState ? { nextState } : {}) };
  // The UUID and intended saved state must survive even when the POST reply is
  // lost. An uncertain acknowledgment is resolved only through the receipt GET.
  remember(context);
  try {
    const submitted = await demoRequest(`/api/projects/${context.projectId}/jobs`, {
      method: 'POST', body: { requestId, jobType: type, analysisObjectId: objectId, parameters: {} },
    });
    const job = submitted.job || submitted;
    if (job.id !== job.submission?.jobId) throw unconfirmed();
    confirmReceipt(context, job.submission);
  } catch { await resolvePendingReceipt(context); }
  await waitForJob(context, progress);
}
async function loadCheckpoint(context, objectId = context.currentObjectId, progress) {
  await submitJob(context, 'checkpoint.load.v1', objectId, null, progress);
}
async function readCurrent(context) {
  const info = await demoRequest('/api/r/object-info', { objectId: context.currentObjectId });
  const qc = await demoRequest('/api/r/qc-distributions', { objectId: context.currentObjectId });
  return { context, info, qc, baseline: context.baseline, pca: context.pca || null, map: context.map || null };
}
async function persist(context, nextState, progress, workingObjectId = context.currentObjectId) {
  await submitJob(context, 'checkpoint.save.v1', workingObjectId, nextState, progress);
  await loadCheckpoint(context, context.currentObjectId, progress);
  const result = await readCurrent(context);
  opening = Promise.resolve(result); return result;
}
async function resumeEarlierRequest(previous, expectedStage, progress) {
  const saved = savedContext();
  if (!saved || saved.userId !== previous.userId || saved.projectId !== previous.projectId
    || saved.originalObjectId !== previous.originalObjectId) return null;
  const context = { ...saved };
  if (!context.pending) {
    if (context.currentObjectId !== previous.currentObjectId || context.stage !== previous.stage) {
      throw new Error('A newer saved analysis is available. Refresh to display it before starting more work.');
    }
    return null;
  }
  const pending = await waitForJob(context, progress);
  if (pending.type === 'checkpoint.save.v1') await loadCheckpoint(context, context.currentObjectId, progress);
  const result = await readCurrent(context);
  opening = Promise.resolve(result);
  if (context.stage !== expectedStage) {
    throw new Error('The earlier request was recovered. Refresh to display its saved result before starting more work. No analysis was repeated.');
  }
  return result;
}
async function startFromCounts(context) {
  await loadCheckpoint(context, context.originalObjectId);
  // The tutorial bundle contains its prepared object and original counts. QC
  // always uses those original counts, so filters never accumulate.
  await demoRequest('/api/r/qc', { method: 'POST', body: RAW_QC, objectId: context.originalObjectId });
  const baseline = await demoRequest('/api/r/qc-distributions', { objectId: context.originalObjectId });
  if (!Array.isArray(baseline.nFeature_RNA) || baseline.n_cells !== baseline.nFeature_RNA.length) throw new Error('The complete input QC metrics are unavailable. Please retry.');
  Object.assign(context, { currentObjectId: context.originalObjectId, stage: 'input', baseline, appliedQC: null, processing: null, clustering: null, pca: null, map: null });
  remember(context); return readCurrent(context);
}
async function prepareDemo() {
  let user;
  try { user = (await demoRequest('/api/auth/session')).user; } catch (error) { if (error.status !== 401) throw error; }
  let context = savedContext();
  if (!user || !user.email?.endsWith('@demo.invalid')) {
    const guest = await demoRequest('/api/auth/demo-guest', { method: 'POST', body: {} });
    user = guest.user;
    context = { userId: user.id, projectId: guest.project.id, originalObjectId: guest.analysisObject.id, currentObjectId: guest.analysisObject.id };
  } else if (!context || context.userId !== user.id) {
    const projects = await demoRequest('/api/projects');
    let original;
    for (const project of projects) {
      const objects = await demoRequest(`/api/projects/${project.id}/analysis-objects`);
      original = objects.find(object => object.metadata?.curatedDemo === true);
      if (original) { context = { userId: user.id, projectId: project.id, originalObjectId: original.id, currentObjectId: original.id }; break; }
    }
    if (!original) throw new Error('The input dataset is unavailable in this session. Open a new browser window to restart.');
  }
  if (context.pending) await waitForJob(context);
  if (!context.stage || context.stage === 'input') return startFromCounts(context);
  await loadCheckpoint(context); return readCurrent(context);
}
export function openDemo() {
  if (!opening) opening = prepareDemo().catch(error => { opening = null; throw error; });
  return opening;
}

export async function applyDemoQC(previous, parameters, progress) {
  const recovered = await resumeEarlierRequest(previous, 'qc', progress);
  if (recovered) return recovered;
  const context = { ...previous };
  await loadCheckpoint(context, context.originalObjectId, progress);
  progress?.('Applying quality filters…');
  const data = await demoRequest('/api/r/qc', { method: 'POST', body: parameters, objectId: context.originalObjectId });
  if (!data.result?.post_filter_cells) throw new Error('No cells passed the quality filters. Adjust the thresholds.');
  return persist(context, { stage: 'qc', appliedQC: { ...parameters }, processing: null, clustering: null, pca: null, map: null }, progress, context.originalObjectId);
}
export async function processDemo(previous, parameters, progress) {
  const recovered = await resumeEarlierRequest(previous, 'pca', progress);
  if (recovered) return recovered;
  if (!previous.appliedQC) throw new Error('Apply quality filters before running PCA.');
  const context = { ...previous };
  await loadCheckpoint(context, context.originalObjectId, progress);
  await demoRequest('/api/r/qc', { method: 'POST', body: context.appliedQC, objectId: context.originalObjectId });
  progress?.('Normalizing counts and selecting variable genes…');
  await demoRequest(`/api/r/normalize?method=LogNormalize&scale_factor=${parameters.scaleFactor}&nfeatures=${parameters.variableFeatures}`, { objectId: context.originalObjectId });
  progress?.('Scaling variable genes and computing PCA…');
  const pca = (await demoRequest(`/api/r/pca?npcs=${parameters.npcs}&seed=42`, { objectId: context.originalObjectId })).result;
  if (!Array.isArray(pca?.stdevs) || !pca.stdevs.length) throw new Error('PCA did not return component values. Please retry.');
  return persist(context, { stage: 'pca', processing: { ...parameters }, clustering: null, pca, map: null }, progress, context.originalObjectId);
}
export async function clusterDemo(previous, parameters, progress) {
  const recovered = await resumeEarlierRequest(previous, 'complete', progress);
  if (recovered) return recovered;
  if (!previous.pca) throw new Error('Compute PCA before clustering.');
  if (parameters.dims > previous.pca.npcs) throw new Error('The number of PCs used cannot exceed the number computed.');
  const context = { ...previous };
  await loadCheckpoint(context, context.currentObjectId, progress);
  progress?.('Computing neighbors and clusters…');
  await demoRequest(`/api/r/cluster?dims=${parameters.dims}&resolution=${parameters.resolution}&algorithm=1&seed=42`, { objectId: context.currentObjectId });
  progress?.('Computing UMAP…');
  const map = (await demoRequest(`/api/r/umap?dims=${parameters.dims}&n_components=2&n_neighbors=${parameters.neighbors}&min_dist=${parameters.minDist}&seed=42`, { objectId: context.currentObjectId })).result;
  if (!Array.isArray(map?.trace_data) || !map.n_clusters) throw new Error('UMAP did not return a cell embedding. Please retry.');
  return persist(context, { stage: 'complete', clustering: { ...parameters }, map }, progress);
}
export async function resetDemo(previous) {
  const recovered = await resumeEarlierRequest(previous, 'input');
  if (recovered) return recovered;
  const result = await startFromCounts({ ...previous });
  opening = Promise.resolve(result); return result;
}
export function readDemoGene(context, gene) {
  return demoRequest(`/api/r/feature-values?gene=${encodeURIComponent(gene)}`, { objectId: context.currentObjectId });
}
