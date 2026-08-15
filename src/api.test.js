import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  electronAPI,
  apiUrl,
  buildCellChatInferenceJobPayload,
  buildCheckpointForkJobPayload,
  buildCheckpointSaveJobPayload,
  buildDegFindMarkersJobPayload,
  buildEnrichmentGseaJobPayload,
  buildMultiSampleSeuratPipelineJobPayload,
  buildSeuratPipelineJobPayload,
} from './api';

describe('apiUrl (VITE_API_BASE_URL resolution)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function loadApiUrlWith(envValue) {
    if (envValue === undefined) {
      vi.stubEnv('VITE_API_BASE_URL', '');
    } else {
      vi.stubEnv('VITE_API_BASE_URL', envValue);
    }
    vi.resetModules();
    const mod = await import('./api');
    return mod.apiUrl;
  }

  it('returns a same-origin relative path when the env is empty', async () => {
    const url = await loadApiUrlWith('');
    expect(url('/api/auth/login')).toBe('/api/auth/login');
  });

  it('prefixes an absolute base with no trailing slash', async () => {
    const url = await loadApiUrlWith('https://example.com');
    expect(url('/api/auth/login')).toBe('https://example.com/api/auth/login');
  });

  it('strips a trailing slash on the base to avoid double slashes', async () => {
    const url = await loadApiUrlWith('https://example.com/');
    expect(url('/api/auth/login')).toBe('https://example.com/api/auth/login');
  });

  it('normalizes a path that is missing a leading slash', async () => {
    const url = await loadApiUrlWith('https://example.com');
    expect(url('api/db/figures')).toBe('https://example.com/api/db/figures');
  });

  it('is importable as a named export from the live module', () => {
    expect(typeof apiUrl).toBe('function');
  });
});

describe('buildDegFindMarkersJobPayload', () => {
  it('builds the durable DEG job payload without server-owned or non-allowlisted fields', () => {
    const payload = buildDegFindMarkersJobPayload('ao_abc123', {
      groupBy: 'seurat_clusters',
      assay: 'RNA',
      testUse: 'wilcox',
      minPct: 0.1,
      logfcThreshold: 0.25,
      onlyPositive: true,
      topMarkersPerCluster: 10,
      ownerUserId: 99,
      status: 'completed',
      storageUri: 'vault/private/markers.csv',
      stateKey: 'user-1:obj-ao_abc123',
      path: 'C:/private/markers.csv',
    });

    expect(payload).toEqual({
      jobType: 'deg.find_markers.v1',
      analysisObjectId: 'ao_abc123',
      parameters: {
        groupBy: 'seurat_clusters',
        assay: 'RNA',
        testUse: 'wilcox',
        minPct: 0.1,
        logfcThreshold: 0.25,
        onlyPositive: true,
        topMarkersPerCluster: 10,
      },
    });
    expect(JSON.stringify(payload)).not.toMatch(/ownerUserId|completed|vault|stateKey|C:\/private/i);
  });
});

describe('buildEnrichmentGseaJobPayload', () => {
  it('keeps only the ranked-enrichment allowlist and never accepts server-owned fields', () => {
    const payload = buildEnrichmentGseaJobPayload('ao_abc123', {
      groupBy: 'seurat_clusters',
      assay: 'RNA',
      targetGroup: '0',
      species: 'human',
      geneSetCollection: 'GO_BP',
      minGeneSetSize: 10,
      maxGeneSetSize: 500,
      adjustedPValueCutoff: 0.05,
      topPathways: 20,
      maxCellsPerIdent: null,
      randomSeed: 7,
      ownerUserId: 99,
      storageUri: 'vault/private/enrichment.csv',
      stateKey: 'user-1:obj-ao_abc123',
      endpoint: '/api/r/enrichment',
    });

    expect(payload).toEqual({
      jobType: 'enrichment.gsea.v1',
      analysisObjectId: 'ao_abc123',
      parameters: {
        groupBy: 'seurat_clusters',
        assay: 'RNA',
        targetGroup: '0',
        species: 'human',
        geneSetCollection: 'GO_BP',
        minGeneSetSize: 10,
        maxGeneSetSize: 500,
        adjustedPValueCutoff: 0.05,
        topPathways: 20,
        maxCellsPerIdent: null,
        randomSeed: 7,
      },
    });
    expect(JSON.stringify(payload)).not.toMatch(/ownerUserId|vault|stateKey|endpoint|api\/r/i);
  });
});

describe('buildCellChatInferenceJobPayload', () => {
  it('keeps only the fixed CellChat v1 parameter contract and excludes server-owned fields', () => {
    const payload = buildCellChatInferenceJobPayload('ao_abc123', {
      groupBy: 'seurat_clusters',
      assay: 'RNA',
      species: 'human',
      databaseCategory: 'secreted_signaling',
      analysisIntent: 'single_context',
      minCellsPerGroup: 10,
      maxCellsPerGroup: 5000,
      maxTotalCells: 10000,
      pValueCutoff: 0.05,
      topInteractions: 25,
      topPathways: 15,
      randomSeed: 1,
      ownerUserId: 99,
      status: 'completed',
      storageUri: 'vault/private/cellchat.csv',
      storageKey: 'projects/proj_1/artifacts/job_1/cellchat.csv',
      stateKey: 'user-1:obj-ao_abc123',
      endpoint: '/api/r/cellchat-infer',
      path: 'C:/private/cellchat.csv',
    });

    expect(payload).toEqual({
      jobType: 'cellchat.infer.v1',
      analysisObjectId: 'ao_abc123',
      parameters: {
        groupBy: 'seurat_clusters',
        assay: 'RNA',
        species: 'human',
        databaseCategory: 'secreted_signaling',
        analysisIntent: 'single_context',
        minCellsPerGroup: 10,
        maxCellsPerGroup: 5000,
        maxTotalCells: 10000,
        pValueCutoff: 0.05,
        topInteractions: 25,
        topPathways: 15,
        randomSeed: 1,
      },
    });
    expect(JSON.stringify(payload)).not.toMatch(/ownerUserId|completed|vault|storageKey|stateKey|endpoint|api\/r|C:\/private/i);
  });
});

describe('buildSeuratPipelineJobPayload', () => {
  it('builds the durable Seurat pipeline payload without server-owned or unsupported fields', () => {
    const payload = buildSeuratPipelineJobPayload({
      datasetId: 'ds_abc123',
      analysisObjectId: 'ao_input123',
      params: {
        minCells: 3,
        minFeatures: 200,
        applyQcFilter: true,
        minFeaturesFilter: 250,
        maxFeaturesFilter: 5000,
        maxPercentMt: 20,
        normalizationMethod: 'LogNormalize',
        scaleFactor: 10000,
        variableFeatures: 2000,
        pcaDims: 30,
        clusterDims: 20,
        clusterResolution: 0.8,
        umapDims: 20,
        umapComponents: 2,
        umapNeighbors: 30,
        umapMinDist: 0.3,
        seed: 7,
        ownerUserId: 99,
        status: 'completed',
        storageUri: 'vault/private/pipeline.rds',
        stateKey: 'user-1:obj-ao_input123',
      },
    });

    expect(payload).toEqual({
      jobType: 'seurat.pipeline.v1',
      datasetId: 'ds_abc123',
      analysisObjectId: 'ao_input123',
      parameters: {
        minCells: 3,
        minFeatures: 200,
        applyQcFilter: true,
        minFeaturesFilter: 250,
        maxFeaturesFilter: 5000,
        maxPercentMt: 20,
        normalizationMethod: 'LogNormalize',
        scaleFactor: 10000,
        variableFeatures: 2000,
        pcaDims: 30,
        clusterDims: 20,
        clusterResolution: 0.8,
        umapDims: 20,
        umapComponents: 2,
        umapNeighbors: 30,
        umapMinDist: 0.3,
        seed: 7,
      },
    });
    expect(JSON.stringify(payload)).not.toMatch(/ownerUserId|completed|vault|stateKey/i);
  });
});

describe('buildMultiSampleSeuratPipelineJobPayload', () => {
  it('uses the first dataset as lineage primary and only carries reviewed sample fields', () => {
    const payload = buildMultiSampleSeuratPipelineJobPayload({
      analysisObjectId: 'ao_primary',
      samples: [
        { datasetId: 'ds_a1', sampleName: 'control 1', conditionName: 'control', donorCode: 'd1', path: '../../x' },
        { datasetId: 'ds_b2', sampleName: 'treated 1', conditionName: 'treated', batch: 'run 2', stateKey: 'private' },
      ],
      params: { pcaDims: 20, storageUri: 'vault/private/result.rds' },
    });
    expect(payload).toEqual({
      jobType: 'seurat.multisample.v1',
      datasetId: 'ds_a1',
      analysisObjectId: 'ao_primary',
      parameters: {
        pcaDims: 20,
        samples: [
          { datasetId: 'ds_a1', sampleName: 'control 1', conditionName: 'control', donorCode: 'd1', batch: null },
          { datasetId: 'ds_b2', sampleName: 'treated 1', conditionName: 'treated', donorCode: null, batch: 'run 2' },
        ],
      },
    });
    expect(JSON.stringify(payload)).not.toMatch(/\.\.\/|storageUri|stateKey/);
  });
});

describe('buildCheckpointForkJobPayload', () => {
  it('pins the allowlisted fork job shape without client-controlled checkpoint fields', () => {
    expect(buildCheckpointForkJobPayload('ao_source123')).toEqual({
      jobType: 'checkpoint.fork.v1',
      analysisObjectId: 'ao_source123',
      parameters: {},
    });
  });
});

describe('buildCheckpointSaveJobPayload', () => {
  it('pins the parameterless save shape without client-controlled checkpoint fields', () => {
    expect(buildCheckpointSaveJobPayload('ao_source123')).toEqual({
      jobType: 'checkpoint.save.v1',
      analysisObjectId: 'ao_source123',
      parameters: {},
    });
  });
});

describe('API Client (electronAPI)', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn();
    if (typeof localStorage !== 'undefined') {
      localStorage.clear();
    }
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('should handle 200 OK JSON responses properly', async () => {
    const mockResponse = { data: 'test-success' };
    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => mockResponse,
    });

    const result = await electronAPI.apiRequest('/test-endpoint');
    expect(result).toEqual(mockResponse);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/r/test-endpoint'),
      expect.objectContaining({
        credentials: 'include',
        headers: expect.objectContaining({ 'X-TraceOmics-CSRF': '1' }),
      })
    );
  });

  it('should handle 400/500 Error JSON responses properly', async () => {
    const mockErrorResponse = { error: 'Backend Exception: file not found' };
    global.fetch.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => mockErrorResponse,
      text: async () => JSON.stringify(mockErrorResponse),
    });

    const result = await electronAPI.apiRequest('/test-error');
    
    // Parsed failures must not expose raw backend exception detail to researchers.
    expect(result).toHaveProperty('error');
    expect(result.error).toBe('We could not complete this request. Please review the settings and try again.');
  });

  it('should handle 400/500 Error text responses properly', async () => {
    global.fetch.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      headers: new Headers({ 'content-type': 'text/plain' }),
      text: async () => 'Plain text error message',
    });

    const result = await electronAPI.apiRequest('/test-error-text');

    expect(result).toHaveProperty('error');
    expect(result.error).toBe('We could not complete this request. Please review the settings and try again.');
  });

  it('preserves structured domain error codes for scientific remediation', async () => {
    global.fetch.mockResolvedValue({
      ok: false,
      status: 409,
      statusText: 'Conflict',
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify({
        error: 'This metadata value is already mapped to a biological sample.',
        code: 'METADATA_VALUE_ALREADY_BOUND',
      }),
    });

    await expect(electronAPI.createStudyCondition('proj_1', { name: 'treated' }))
      .rejects.toMatchObject({
        message: 'This metadata value is already mapped to a biological sample.',
        code: 'METADATA_VALUE_ALREADY_BOUND',
        status: 409,
      });
  });

  it('routes db methods to their expected endpoint path (same-origin default)', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => [],
    });

    await electronAPI.getFigures();
    expect(global.fetch).toHaveBeenCalledWith('/api/db/figures', expect.any(Object));
  });

  it('preserves HTTP status on project API errors for access reconciliation', async () => {
    global.fetch.mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      text: async () => JSON.stringify({ error: 'Project job not found.' }),
    });

    await expect(electronAPI.getProjectJob('proj_1', 'job_1')).rejects.toMatchObject({
      status: 404,
      message: 'Project job not found.',
    });
  });

  it('clears auth and session localStorage so a reload remains logged out', async () => {
    localStorage.setItem('traceomics_auth_token', 'token-123');
    localStorage.setItem('traceomics_auth_user', JSON.stringify({ email: 'user@example.com' }));
    localStorage.setItem('traceomics_auth_extra', 'stale');
    localStorage.setItem('traceomics_session_id', 'session-123');
    localStorage.setItem('client_id', 'client-123');
    localStorage.setItem('traceomics_ws_user@example.com', 'workspace-state');

    expect(electronAPI.getCurrentUser()).toEqual({ email: 'user@example.com' });

    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, allSessionsRevoked: true }),
    });

    await electronAPI.logout();

    expect(localStorage.getItem('traceomics_auth_token')).toBeNull();
    expect(localStorage.getItem('traceomics_auth_user')).toBeNull();
    expect(localStorage.getItem('traceomics_auth_extra')).toBeNull();
    expect(localStorage.getItem('traceomics_session_id')).toBeNull();
    expect(localStorage.getItem('client_id')).toBeNull();
    expect(localStorage.getItem('traceomics_ws_user@example.com')).toBe('workspace-state');

    vi.resetModules();
    const reloaded = await import('./api');
    expect(reloaded.electronAPI.getCurrentUser()).toBeNull();
  });

  it('restores auth state from the HttpOnly cookie session (not localStorage bearer)', async () => {
    const sessionUser = { id: 7, email: 'restored@example.com', displayName: 'Restored' };
    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ user: sessionUser, authVia: 'cookie' }),
    });

    const result = await electronAPI.restoreSession();

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/auth/session',
      expect.objectContaining({ credentials: 'include' })
    );
    expect(result).toEqual(sessionUser);
    // Cached for the next synchronous bootstrap.
    expect(electronAPI.getCurrentUser()).toEqual(sessionUser);
  });

  it('loads the public registration policy without sending a bearer', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({
        registrationEnabled: false,
        legacyLocalImportsEnabled: false,
        legacyLiveMutationToolsEnabled: false,
        serverFigureExportEnabled: false,
      }),
    });

    await expect(electronAPI.registrationPolicy()).resolves.toEqual({
      registrationEnabled: false,
      legacyLocalImportsEnabled: false,
      legacyLiveMutationToolsEnabled: false,
      serverFigureExportEnabled: false,
    });
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/auth/policy',
      expect.objectContaining({ method: 'GET' })
    );
    expect(global.fetch.mock.calls[0][1].headers).not.toHaveProperty('Authorization');
  });

  it('loads Expert R availability from the authenticated account capability route', async () => {
    const capability = {
      expertREnabled: true,
      expertRProfile: { id: 'profile-v1', packages: ['Seurat'] },
    };
    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => capability,
    });

    await expect(electronAPI.getExpertRCapabilities()).resolves.toEqual(capability);
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/expert-r/capabilities',
      expect.objectContaining({ credentials: 'include' })
    );
  });

  it('purges a legacy bearer during restore and never sends it', async () => {
    localStorage.setItem('traceomics_auth_token', 'legacy-token');
    const sessionUser = { id: 8, email: 'cookie@example.com', displayName: 'Cookie' };
    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ user: sessionUser, authVia: 'cookie' }),
    });

    const result = await electronAPI.restoreSession();

    expect(result).toEqual(sessionUser);
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/auth/session',
      expect.objectContaining({
        credentials: 'include',
        headers: expect.not.objectContaining({ Authorization: expect.anything() })
      })
    );
    expect(localStorage.getItem('traceomics_auth_token')).toBeNull();
  });

  it('clears stale auth keys when the server rejects restore (401)', async () => {
    localStorage.setItem('traceomics_auth_token', 'stale-token');
    localStorage.setItem('traceomics_auth_user', JSON.stringify({ email: 'stale@example.com' }));
    localStorage.setItem('traceomics_auth_extra', 'stale-extra');
    global.fetch.mockResolvedValue({
      ok: false,
      status: 401,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ error: 'Authentication required' }),
    });

    const result = await electronAPI.restoreSession();

    expect(result).toBeNull();
    expect(localStorage.getItem('traceomics_auth_token')).toBeNull();
    expect(localStorage.getItem('traceomics_auth_user')).toBeNull();
    expect(localStorage.getItem('traceomics_auth_extra')).toBeNull();
  });

  it('does not treat cached localStorage auth as truth when session restore cannot reach the backend', async () => {
    localStorage.setItem('traceomics_auth_token', 'stale-token');
    localStorage.setItem('traceomics_auth_user', JSON.stringify({ email: 'offline@example.com' }));
    global.fetch.mockRejectedValue(new Error('network down'));

    const result = await electronAPI.restoreSession();

    expect(result).toBeNull();
    expect(localStorage.getItem('traceomics_auth_token')).toBeNull();
    expect(electronAPI.getCurrentUser()).toEqual({ email: 'offline@example.com' });
  });

  it('does not persist a bearer returned by an older login response', async () => {
    const user = { id: 9, email: 'cookie-only@example.com', displayName: 'Cookie Only' };
    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ user, token: 'must-not-be-stored' }),
    });

    expect(await electronAPI.login(user.email, 'correct horse battery staple')).toEqual(user);
    expect(localStorage.getItem('traceomics_auth_token')).toBeNull();
    const [, options] = global.fetch.mock.calls[0];
    expect(options.credentials).toBe('include');
    expect(options.headers).not.toHaveProperty('Authorization');
  });

  it('keeps cached user state when logout revocation fails', async () => {
    const user = { id: 10, email: 'retry@example.com', displayName: 'Retry' };
    localStorage.setItem('traceomics_auth_user', JSON.stringify(user));
    global.fetch.mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ error: 'Session revocation is temporarily unavailable.' }),
    });

    await expect(electronAPI.logout()).resolves.toEqual({
      error: 'Session revocation is temporarily unavailable.',
    });
    expect(electronAPI.getCurrentUser()).toEqual(user);
  });

  it('clears stale local auth when the current cookie already expired', async () => {
    const user = { id: 11, email: 'missing-cookie@example.com', displayName: 'Missing Cookie' };
    localStorage.setItem('traceomics_auth_user', JSON.stringify(user));
    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, allSessionsRevoked: false }),
    });

    await expect(electronAPI.logout()).resolves.toEqual({
      success: true,
      allSessionsRevoked: false,
      warning: 'The current session had already expired; other sessions could not be revoked.',
    });
    expect(electronAPI.getCurrentUser()).toBeNull();
  });

  it('reads runtime diagnostics from the backend instead of hardcoded R strings', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({
        supportedTarget: 'R 4.5.x',
        runtime: { status: 'ok', rVersion: '4.6.0' },
      }),
    });

    const result = await electronAPI.checkREnv();

    expect(global.fetch).toHaveBeenCalledWith('/api/runtime/diagnostics', expect.any(Object));
    expect(result.version).toBe('R 4.6.0');
    expect(result.version).not.toBe('R 4.5.1');
    expect(result.supportedTarget).toBe('R 4.5.x');
    expect(result.runtimeStatus).toBe('ok');
    expect(result).not.toHaveProperty('rscriptPath');
    expect(result).not.toHaveProperty('rscriptSource');
    expect(result).not.toHaveProperty('packages');
  });

  it('reads the public compute-runtime state without exposing worker internals', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({
        status: 'ready',
        updatedAt: '2026-08-01T00:00:00.000Z',
        capabilities: { pathwayEnrichment: false, cellChat: true, privatePackage: true },
        workerId: 'private-worker-id',
        stateKey: 'private-r-state-key',
      }),
    });

    await expect(electronAPI.getComputeRuntimeStatus()).resolves.toEqual({
      status: 'ready',
      updatedAt: '2026-08-01T00:00:00.000Z',
      capabilities: { pathwayEnrichment: false, cellChat: true },
    });
    expect(global.fetch).toHaveBeenCalledWith('/api/runtime/compute-status', expect.any(Object));
  });

  it('fails closed to an unknown compute-runtime state for malformed public responses', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ status: 'draining', updatedAt: 12345 }),
    });

    await expect(electronAPI.getComputeRuntimeStatus()).resolves.toEqual({
      status: 'unknown',
      updatedAt: null,
      capabilities: {},
    });
  });

  it('creates durable DEG jobs through the project job API wrapper', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      status: 201,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ id: 'job_abc123', jobType: 'deg.find_markers.v1', status: 'queued' }),
    });

    const result = await electronAPI.createDegFindMarkersJob('proj_1', 'ao_abc123', {
      groupBy: 'seurat_clusters',
      assay: 'RNA',
      testUse: 'wilcox',
      storageUri: 'vault/private/markers.csv',
    });

    expect(result.id).toBe('job_abc123');
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toBe('/api/projects/proj_1/jobs');
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual({
      jobType: 'deg.find_markers.v1',
      analysisObjectId: 'ao_abc123',
      parameters: {
        groupBy: 'seurat_clusters',
        assay: 'RNA',
        testUse: 'wilcox',
      },
    });
  });

  it('creates durable ranked pathway-enrichment jobs through the project job API wrapper', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      status: 201,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ id: 'job_enrich123', jobType: 'enrichment.gsea.v1', status: 'queued' }),
    });

    const result = await electronAPI.createEnrichmentGseaJob('proj_1', 'ao_abc123', {
      groupBy: 'seurat_clusters',
      assay: 'RNA',
      targetGroup: '0',
      species: 'human',
      geneSetCollection: 'GO_BP',
      minGeneSetSize: 10,
      maxGeneSetSize: 500,
      adjustedPValueCutoff: 0.05,
      topPathways: 20,
      storageKey: 'projects/proj_1/private.csv',
    });

    expect(result.id).toBe('job_enrich123');
    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toBe('/api/projects/proj_1/jobs');
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual({
      jobType: 'enrichment.gsea.v1',
      analysisObjectId: 'ao_abc123',
      parameters: {
        groupBy: 'seurat_clusters',
        assay: 'RNA',
        targetGroup: '0',
        species: 'human',
        geneSetCollection: 'GO_BP',
        minGeneSetSize: 10,
        maxGeneSetSize: 500,
        adjustedPValueCutoff: 0.05,
        topPathways: 20,
      },
    });
  });

  it('creates fixed durable CellChat inference jobs through the project job API wrapper', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      status: 201,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ id: 'job_cellchat123', jobType: 'cellchat.infer.v1', status: 'queued' }),
    });

    const result = await electronAPI.createCellChatInferenceJob('proj_1', 'ao_abc123', {
      groupBy: 'ident',
      assay: 'RNA',
      species: 'mouse',
      databaseCategory: 'cell_cell_contact',
      analysisIntent: 'single_context',
      minCellsPerGroup: 10,
      maxCellsPerGroup: 5000,
      maxTotalCells: 10000,
      pValueCutoff: 0.05,
      topInteractions: 25,
      topPathways: 15,
      randomSeed: 1,
      storageKey: 'projects/proj_1/private.csv',
      endpoint: '/api/r/cellchat-infer',
    });

    expect(result.id).toBe('job_cellchat123');
    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toBe('/api/projects/proj_1/jobs');
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual({
      jobType: 'cellchat.infer.v1',
      analysisObjectId: 'ao_abc123',
      parameters: {
        groupBy: 'ident',
        assay: 'RNA',
        species: 'mouse',
        databaseCategory: 'cell_cell_contact',
        analysisIntent: 'single_context',
        minCellsPerGroup: 10,
        maxCellsPerGroup: 5000,
        maxTotalCells: 10000,
        pValueCutoff: 0.05,
        topInteractions: 25,
        topPathways: 15,
        randomSeed: 1,
      },
    });
  });

  it('creates durable Seurat pipeline jobs through the project job API wrapper', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      status: 201,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ id: 'job_pipeline123', jobType: 'seurat.pipeline.v1', status: 'queued' }),
    });

    const result = await electronAPI.createSeuratPipelineJob('proj_1', {
      datasetId: 'ds_abc123',
      analysisObjectId: 'ao_input123',
      params: {
        minCells: 3,
        minFeatures: 200,
        storageUri: 'vault/private/pipeline.rds',
      },
    });

    expect(result.id).toBe('job_pipeline123');
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toBe('/api/projects/proj_1/jobs');
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual({
      jobType: 'seurat.pipeline.v1',
      datasetId: 'ds_abc123',
      analysisObjectId: 'ao_input123',
      parameters: {
        minCells: 3,
        minFeatures: 200,
      },
    });
  });

  it('creates spatial Seurat jobs with the same fixed parameter allowlist', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      status: 201,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ id: 'job_spatial123', jobType: 'spatial.seurat.v1', status: 'queued' }),
    });

    await electronAPI.createSpatialSeuratPipelineJob('proj_1', {
      datasetId: 'ds_spatial123',
      analysisObjectId: 'ao_spatial_input',
      params: { normalizationMethod: 'SCTransform', clusterResolution: 0.6, storageUri: 'private.rds' },
    });

    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toBe('/api/projects/proj_1/jobs');
    expect(JSON.parse(options.body)).toEqual({
      jobType: 'spatial.seurat.v1',
      datasetId: 'ds_spatial123',
      analysisObjectId: 'ao_spatial_input',
      parameters: { normalizationMethod: 'SCTransform', clusterResolution: 0.6 },
    });
  });

  it('creates checkpoint forks through the fixed project job API wrapper', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      status: 201,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ id: 'job_fork123', jobType: 'checkpoint.fork.v1', status: 'queued' }),
    });

    const result = await electronAPI.createCheckpointForkJob('proj_1', 'ao_source123');

    expect(result.id).toBe('job_fork123');
    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toBe('/api/projects/proj_1/jobs');
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual({
      jobType: 'checkpoint.fork.v1',
      analysisObjectId: 'ao_source123',
      parameters: {},
    });
  });

  it('retries a project job without accepting client input overrides', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      status: 201,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ id: 'job_retry123', retryOfJobId: 'job_failed123', status: 'queued' }),
    });

    const result = await electronAPI.retryProjectJob('proj_1', 'job_failed123');

    expect(result.id).toBe('job_retry123');
    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toBe('/api/projects/proj_1/jobs/job_failed123/retry');
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual({});
  });

  it('creates owner-only checkpoint saves through the fixed project job API wrapper', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      status: 201,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ id: 'job_save123', jobType: 'checkpoint.save.v1', status: 'queued' }),
    });

    const result = await electronAPI.createCheckpointSaveJob('proj_1', 'ao_owner123');

    expect(result.id).toBe('job_save123');
    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toBe('/api/projects/proj_1/jobs');
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual({
      jobType: 'checkpoint.save.v1',
      analysisObjectId: 'ao_owner123',
      parameters: {},
    });
  });

  it('creates owner-only checkpoint reattach jobs through the fixed project job API wrapper', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      status: 201,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ id: 'job_attach123', jobType: 'checkpoint.load.v1', status: 'queued' }),
    });

    const result = await electronAPI.createCheckpointLoadJob('proj_1', 'ao_owner123');

    expect(result.id).toBe('job_attach123');
    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toBe('/api/projects/proj_1/jobs');
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual({
      jobType: 'checkpoint.load.v1',
      analysisObjectId: 'ao_owner123',
      parameters: {},
    });
  });
});
