import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const respond = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
const metrics = { n_cells: 2700, nFeature_RNA: Array(2700).fill(800), nCount_RNA: Array(2700).fill(1500), percent_mt: Array(2700).fill(2) };
const context = { userId: 7, projectId: 'proj_1', originalObjectId: 'ao_1', currentObjectId: 'ao_2', stage: 'qc', appliedQC: { min_features: 200, max_features: 2500, mt_threshold: 5, min_counts: 0 }, baseline: metrics };
function mockAPI() {
  const jobs = new Map();
  const fetch = vi.fn(async (url, options) => {
    if (url.endsWith('/api/auth/session')) return respond({}, 401);
    if (url.endsWith('/api/auth/demo-guest')) return respond({ user: { id: 7 }, project: { id: 'proj_1' }, analysisObject: { id: 'ao_1' } }, 201);
    if (url.endsWith('/jobs') && options.method === 'POST') {
      const job = JSON.parse(options.body); const id = `job_${jobs.size}`;
      const receipt = { schema: 'traceomics.job-submission.v1', projectId: 'proj_1', requestId: job.requestId,
        requestHash: 'a'.repeat(64), jobId: id, job: { id, jobType: job.jobType, analysisObjectId: job.analysisObjectId } };
      jobs.set(id, { ...job, receipt }); return respond({ id, submission: receipt }, 201);
    }
    if (url.includes('/job-submissions/')) {
      const requestId = url.split('/').at(-1);
      const job = [...jobs.values()].find(value => value.requestId === requestId);
      return job ? respond(job.receipt) : respond({}, 404);
    }
    if (url.includes('/jobs/job_')) return respond({ status: 'completed', resultAnalysisObjectId: 'ao_saved' });
    if (url.endsWith('/object-info')) return respond({ n_cells: 2638, n_features: 13714 });
    if (url.endsWith('/qc-distributions')) return respond(metrics);
    if (url.endsWith('/qc')) return respond({ result: { post_filter_cells: 2638 } });
    if (url.includes('/normalize?')) return respond({ result: { n_variable_features: 1500 } });
    if (url.includes('/pca?')) return respond({ result: { npcs: 20, stdevs: [12, 8, 5] } });
    if (url.includes('/cluster?')) return respond({ result: { n_clusters: 11 } });
    if (url.includes('/umap?')) return respond({ result: { trace_data: [], n_clusters: 11 } });
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal('fetch', fetch); return fetch;
}
describe('count-based isolated demo workflow', () => {
  beforeEach(() => { vi.resetModules(); sessionStorage.clear(); });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  it('coalesces guest creation and opens counts with no analysis calculation', async () => {
    const fetch = mockAPI(); const { openDemo } = await import('./demoApi');
    const [a, b] = await Promise.all([openDemo(), openDemo()]);
    expect(a).toBe(b); expect(a.context.stage).toBe('input'); expect(a.map).toBeNull();
    expect(fetch.mock.calls.filter(([url]) => url.endsWith('/demo-guest'))).toHaveLength(1);
    expect(fetch.mock.calls.filter(([url]) => url.endsWith('/qc-distributions'))).toHaveLength(1);
    expect(a.qc).toEqual(a.baseline);
    const qc = fetch.mock.calls.find(([url]) => url.endsWith('/qc'));
    expect(JSON.parse(qc[1].body)).toEqual({ min_features: 0, max_features: 0, mt_threshold: 100, min_counts: 0 });
    expect(qc[1].headers['X-Object-ID']).toBe('ao_1'); expect(qc[1].credentials).toBe('include');
    expect(fetch.mock.calls.some(([url]) => /\/(pca|normalize|cluster|umap)\?/.test(url))).toBe(false);
  });
  it('reapplies QC to original counts before normalization and PCA, then saves the actual stage', async () => {
    const fetch = mockAPI(); const { processDemo } = await import('./demoApi');
    const next = await processDemo(context, { variableFeatures: 1500, scaleFactor: 10000, npcs: 20 });
    const load = fetch.mock.calls.find(([url, options]) => url.endsWith('/jobs') && options.method === 'POST');
    expect(JSON.parse(load[1].body).analysisObjectId).toBe('ao_1');
    expect(fetch.mock.calls.filter(([url]) => /\/r\//.test(url)).map(([url]) => url.split('/api/r/')[1])).toEqual([
      'qc', 'normalize?method=LogNormalize&scale_factor=10000&nfeatures=1500', 'pca?npcs=20&seed=42', 'object-info', 'qc-distributions',
    ]);
    expect(next.context.stage).toBe('pca'); expect(next.context.currentObjectId).toBe('ao_saved'); expect(next.pca.stdevs).toEqual([12, 8, 5]);
    expect(next.map).toBeNull(); expect(context.currentObjectId).toBe('ao_2');
  });
  it('rejects clustering before PCA or with more dimensions than computed', async () => {
    const fetch = mockAPI(); const { clusterDemo } = await import('./demoApi');
    await expect(clusterDemo(context, { dims: 10 })).rejects.toThrow(/Compute PCA/);
    await expect(clusterDemo({ ...context, pca: { npcs: 10 } }, { dims: 15 })).rejects.toThrow(/cannot exceed/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('reconnects to a saved receipt without recomputing PCA or UMAP', async () => {
    const pca = { npcs: 20, stdevs: [12, 8, 5] }; const map = { trace_data: [], n_clusters: 11 };
    sessionStorage.setItem('traceomics-analysis-demo-v2', JSON.stringify({ ...context, pending: { id: 'job_existing', type: 'checkpoint.save.v1',
      nextState: { stage: 'complete', pca, map, clustering: { dims: 10, resolution: 0.8, neighbors: 30, minDist: 0.3 } } } }));
    const fetch = mockAPI(); const base = fetch.getMockImplementation();
    fetch.mockImplementation(async (url, options) => url.endsWith('/api/auth/session') ? respond({ user: { id: 7, email: 'guest@demo.invalid' } }) : base(url, options));
    const { openDemo } = await import('./demoApi'); const next = await openDemo();
    expect(next.context.stage).toBe('complete'); expect(next.map).toEqual(map);
    expect(fetch.mock.calls.some(([url]) => /\/(pca|cluster|umap)\?/.test(url))).toBe(false);
    expect(fetch.mock.calls.filter(([url, options]) => url.endsWith('/jobs') && options.method === 'POST').map(([, options]) => JSON.parse(options.body).jobType)).toEqual(['checkpoint.load.v1']);
  });
  it('does not replace the session if checking it fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond({}, 503))); const { openDemo } = await import('./demoApi');
    await expect(openDemo()).rejects.toThrow(/Unable to connect/); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('retains the last saved object and its matching plots if a rerun fails before saving', async () => {
    const previous = { ...context, stage: 'complete', pca: { npcs: 20, stdevs: [12, 8] }, map: { n_clusters: 8, trace_data: [] } };
    sessionStorage.setItem('traceomics-analysis-demo-v2', JSON.stringify(previous));
    const fetch = mockAPI(); const base = fetch.getMockImplementation();
    fetch.mockImplementation(async (url, options) => url.includes('/normalize?') ? respond({ error: 'Normalization interrupted' }, 500) : base(url, options));
    const { processDemo } = await import('./demoApi');
    await expect(processDemo(previous, { variableFeatures: 1500, scaleFactor: 10000, npcs: 20 })).rejects.toThrow('Normalization interrupted');
    const saved = JSON.parse(sessionStorage.getItem('traceomics-analysis-demo-v2'));
    expect(saved.currentObjectId).toBe('ao_2'); expect(saved.stage).toBe('complete'); expect(saved.map).toEqual(previous.map);
    expect(saved.pending).toBeUndefined();
    expect(fetch.mock.calls.find(([url]) => url.endsWith('/qc'))[1].headers['X-Object-ID']).toBe('ao_1');
  });
  it('retains the UUID and exact intended state before sending each checkpoint request', async () => {
    const fetch = mockAPI(); const base = fetch.getMockImplementation();
    fetch.mockImplementation(async (url, options) => {
      if (url.endsWith('/jobs') && options.method === 'POST') {
        const body = JSON.parse(options.body);
        const saved = JSON.parse(sessionStorage.getItem('traceomics-analysis-demo-v2'));
        expect(saved.pending.requestId).toBe(body.requestId);
        expect(saved.pending).toMatchObject({ type: body.jobType, objectId: body.analysisObjectId, parameters: {} });
        if (body.jobType === 'checkpoint.save.v1') expect(saved.pending.nextState.processing.npcs).toBe(20);
      }
      return base(url, options);
    });
    const { processDemo } = await import('./demoApi');
    await processDemo(context, { variableFeatures: 1500, scaleFactor: 10000, npcs: 20 });
    const posts = fetch.mock.calls.filter(([url, options]) => url.endsWith('/jobs') && options.method === 'POST');
    expect(new Set(posts.map(([, options]) => JSON.parse(options.body).requestId)).size).toBe(posts.length);
  });
  it('resolves a lost save acknowledgment with its GET receipt without repeating scientific work', async () => {
    const fetch = mockAPI(); const base = fetch.getMockImplementation();
    fetch.mockImplementation(async (url, options) => {
      const response = await base(url, options);
      if (url.endsWith('/jobs') && options.method === 'POST' && JSON.parse(options.body).jobType === 'checkpoint.save.v1') {
        throw new TypeError('Lost reply after admission');
      }
      return response;
    });
    const { processDemo } = await import('./demoApi');
    const next = await processDemo(context, { variableFeatures: 1500, scaleFactor: 10000, npcs: 20 });
    expect(next.pca.npcs).toBe(20);
    expect(fetch.mock.calls.filter(([url]) => url.includes('/pca?'))).toHaveLength(1);
    expect(fetch.mock.calls.filter(([url, options]) => url.endsWith('/jobs') && options.method === 'POST'
      && JSON.parse(options.body).jobType === 'checkpoint.save.v1')).toHaveLength(1);
    expect(fetch.mock.calls.some(([url]) => url.includes('/job-submissions/'))).toBe(true);
  });
  it('blocks a second action when an earlier save acknowledgment remains unknown', async () => {
    const fetch = mockAPI(); const base = fetch.getMockImplementation();
    let uncertain;
    fetch.mockImplementation(async (url, options) => {
      if (url.endsWith('/jobs') && options.method === 'POST' && JSON.parse(options.body).jobType === 'checkpoint.save.v1') {
        uncertain = JSON.parse(options.body).requestId;
        throw new TypeError('No acknowledgment');
      }
      if (url.endsWith(`/job-submissions/${uncertain}`)) return respond({}, 404);
      return base(url, options);
    });
    const { processDemo, resetDemo } = await import('./demoApi');
    await expect(processDemo(context, { variableFeatures: 1500, scaleFactor: 10000, npcs: 20 })).rejects.toThrow(/could not be confirmed/);
    const pending = JSON.parse(sessionStorage.getItem('traceomics-analysis-demo-v2')).pending;
    expect(pending.requestId).toBe(uncertain); expect(pending.nextState.pca.npcs).toBe(20);
    fetch.mockClear();
    await expect(processDemo(context, { variableFeatures: 2000, scaleFactor: 10000, npcs: 30 })).rejects.toThrow(/No analysis was repeated/);
    await expect(resetDemo(context)).rejects.toThrow(/No analysis was repeated/);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(Array(2).fill(`/api/projects/proj_1/job-submissions/${uncertain}`));
    expect(JSON.parse(sessionStorage.getItem('traceomics-analysis-demo-v2')).pending).toEqual(pending);
  });
  it('recovers a pending completed save from stale displayed state before allowing another computation', async () => {
    const fetch = mockAPI(); const base = fetch.getMockImplementation(); let interrupted = false;
    fetch.mockImplementation(async (url, options) => {
      if (url.endsWith('/jobs/job_1') && !interrupted) { interrupted = true; return respond({}, 503); }
      return base(url, options);
    });
    const { processDemo } = await import('./demoApi');
    await expect(processDemo(context, { variableFeatures: 1500, scaleFactor: 10000, npcs: 20 })).rejects.toThrow(/Unable to connect/);
    expect(JSON.parse(sessionStorage.getItem('traceomics-analysis-demo-v2')).pending.type).toBe('checkpoint.save.v1');
    fetch.mockClear();
    const next = await processDemo(context, { variableFeatures: 2000, scaleFactor: 10000, npcs: 30 });
    expect(next.pca.npcs).toBe(20); expect(next.context.processing.variableFeatures).toBe(1500);
    expect(fetch.mock.calls.some(([url]) => /\/(qc|pca|normalize|cluster|umap)(?:\?|$)/.test(url))).toBe(false);
    expect(fetch.mock.calls.filter(([url, options]) => url.endsWith('/jobs') && options.method === 'POST')
      .map(([, options]) => JSON.parse(options.body).jobType)).toEqual(['checkpoint.load.v1']);
  });
  it('does not submit a checkpoint if the request receipt cannot be saved locally', async () => {
    const fetch = mockAPI(); vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Quota'); });
    const { processDemo } = await import('./demoApi');
    await expect(processDemo(context, { variableFeatures: 1500, scaleFactor: 10000, npcs: 20 })).rejects.toThrow(/retain its request receipt/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('refuses an owner-scoped receipt that describes different job inputs', async () => {
    const requestId = crypto.randomUUID();
    sessionStorage.setItem('traceomics-analysis-demo-v2', JSON.stringify({ ...context,
      pending: { requestId, type: 'checkpoint.save.v1', objectId: 'ao_1', parameters: {} } }));
    const fetch = mockAPI();
    fetch.mockImplementation(async () => respond({ schema: 'traceomics.job-submission.v1', requestId,
      projectId: 'proj_1', requestHash: 'a'.repeat(64), jobId: 'job_other',
      job: { jobType: 'checkpoint.save.v1', analysisObjectId: 'ao_other' } }));
    const { processDemo } = await import('./demoApi');
    await expect(processDemo(context, { variableFeatures: 1500, scaleFactor: 10000, npcs: 20 })).rejects.toThrow(/could not be confirmed/);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(sessionStorage.getItem('traceomics-analysis-demo-v2')).pending.id).toBeUndefined();
  });
});
