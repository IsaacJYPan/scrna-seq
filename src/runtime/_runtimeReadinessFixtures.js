import { READINESS_SCHEMA } from './runtimeReadiness';

export function readinessFixture(overrides = {}) {
  const storage = { state: 'ready', writable: true, freeBytes: 32 * 1024 ** 3, minFreeBytes: 1024 ** 3, reservedBytes: 0 };
  return {
    schema: READINESS_SCHEMA, checkedAt: new Date().toISOString(), staleAfterMs: 5000,
    service: { product: 'TraceOmics', state: 'ready', serviceApiVersion: 1, minimumClientApiVersion: 1, supportedTarget: 'R 4.5.x' },
    guided: { state: 'ready', rVersion: '4.5.3', packages: [{ name: 'Seurat', state: 'available' }, { name: 'CellChat', state: 'missing' }] },
    workers: { state: 'ready', mode: 'standalone', updatedAt: new Date().toISOString(), capabilities: { pathwayEnrichment: true, cellChat: false } },
    privateR: { state: 'ready', accessState: 'allowed', environment: { id: 'renv_' + 'a'.repeat(64), manifestSha256: 'a'.repeat(64), profileId: 'private-r-v1', rVersion: '4.5.3', bioconductor: '3.22', imageDigest: 'sha256:' + 'b'.repeat(64), imageId: 'sha256:' + 'b'.repeat(64), snapshotScope: 'container-userspace' }, capabilities: { persistentKernel: true, persistentKernelInterrupt: true, persistentKernelPublications: true }, resources: { oneShot: { memoryBytes: 8 * 1024 ** 3, cpuLimit: 2, timeoutSeconds: 600, maxConcurrent: 2 }, kernel: { memoryBytes: 8 * 1024 ** 3, cpuLimit: 2, pidsLimit: 256, idleTimeoutSeconds: 900, maxLifetimeSeconds: 14400, executionSeconds: 300, maxActive: 2, maxPerOwner: 1 } }, storage: { work: storage, durable: storage } },
    storage: { durable: storage, private: storage }, scheduler: { state: 'unsupported', kind: null }, issues: [{ code: 'MISSING_PACKAGE', scope: 'guided', state: 'missing', package: 'CellChat' }], ...overrides,
  };
}
