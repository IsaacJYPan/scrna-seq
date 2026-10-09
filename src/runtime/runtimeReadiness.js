export const READINESS_SCHEMA = 'traceomics.runtime-readiness.v1';
const STATES = new Set(['ready', 'unknown', 'unreachable', 'authentication-failed', 'incompatible', 'missing-packages', 'not-configured', 'unavailable', 'missing', 'not-writable', 'insufficient-resources', 'unsupported']);
const ACCESS = new Set(['allowed', 'access-required', 'access-revoked', 'demo-disabled', 'unknown']);
const SCOPES = new Set(['guided', 'workers', 'private-r', 'private-r-work', 'private-r-storage', 'durable-storage', 'private-storage']);
const PACKAGES = new Set(['Seurat', 'dplyr', 'harmony', 'CellChat', 'clusterProfiler', 'fgsea', 'AnnotationDbi', 'org.Hs.eg.db', 'org.Mm.eg.db', 'GO.db', 'plumber', 'jsonlite', 'ggplot2']);
export const READINESS_REMEDIATIONS = Object.freeze({
  GUIDED_R_UNREACHABLE: 'Ask the server administrator to start or reconnect the guided R service, then check again.',
  GUIDED_R_AUTHENTICATION_FAILED: 'Ask the server administrator to repair the guided R service credentials.',
  GUIDED_R_INCOMPATIBLE: 'Ask the server administrator to update the guided R service to the supported version.',
  GUIDED_R_UNKNOWN: 'Guided R availability could not be verified. Check again or ask the server administrator to inspect it.',
  GUIDED_R_UNAVAILABLE: 'Guided R is unavailable. Ask the server administrator to restore the analysis service, then check again.',
  MISSING_PACKAGE: 'Ask the server administrator to provide the required package in the supported R environment.',
  WORKER_UNKNOWN: 'No current queued-worker observation is available. Ask the server administrator to verify that the analysis worker is running.',
  WORKER_UNAVAILABLE: 'The queued-analysis worker is unavailable. Ask the server administrator to restore its R service and storage, then check again.',
  PRIVATE_R_NOT_CONFIGURED: 'Ask the server administrator to configure the isolated R runtime before using custom R.',
  PRIVATE_R_UNREACHABLE: 'Ask the server administrator to start or reconnect the isolated R runtime, then check again.',
  PRIVATE_R_AUTHENTICATION_FAILED: 'Ask the server administrator to repair the isolated R runtime credentials.',
  PRIVATE_R_INCOMPATIBLE: 'Ask the server administrator to restore the supported pinned R image and its exact environment.',
  PRIVATE_R_UNKNOWN: 'Custom R availability could not be verified. Check again or ask the server administrator to inspect the runtime.',
  PRIVATE_R_UNAVAILABLE: 'The isolated R runtime is unavailable. Ask the server administrator to restore it, then check again.',
  PRIVATE_R_INSUFFICIENT_RESOURCES: 'The isolated R runtime has insufficient resources. Ask the server administrator to review its capacity before starting heavy work.',
  PRIVATE_R_ACCESS_REQUIRED: 'Ask a project owner or server administrator to grant R execution access for this project.',
  PRIVATE_R_ACCESS_REVOKED: 'R execution access has been revoked. Ask the server administrator to review access; saved results remain available.',
  PRIVATE_R_DEMO_DISABLED: 'Custom R is unavailable in the public demonstration. Use a private research installation for custom analyses.',
  RESOURCE_POLICY_UNKNOWN: 'Resource limits could not be verified. Ask the server administrator to check the runtime policy before planning heavy work.',
  STORAGE_MISSING: 'The required storage is unavailable. Ask the server administrator to restore the persistent storage mount.',
  STORAGE_NOT_WRITABLE: 'The required storage is not writable. Ask the server administrator to repair its access permissions.',
  STORAGE_PRESSURE: 'Storage is below its required free-space reserve. Ask the server administrator to free space or expand storage before starting heavy work.',
  STORAGE_UNKNOWN: 'Storage readiness could not be verified. Ask the server administrator to check storage access and free space.',
});
const state = value => STATES.has(value) ? value : 'unknown';
const boolean = value => typeof value === 'boolean' ? value : null;
const number = (value, minimum = 0) => typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= Number.MAX_SAFE_INTEGER ? value : null;
const timestamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const version = value => typeof value === 'string' && /^(?:R(?: version)?\s+)?\d+\.\d+\.\d+(?:\s.*)?$/.test(value) ? value.match(/\d+\.\d+\.\d+/)[0] : null;
const packageName = value => PACKAGES.has(value) ? value : null;

function storage(value) {
  const byteCount = value => Number.isSafeInteger(value) ? number(value) : null;
  return { state: state(value?.state), writable: boolean(value?.writable), freeBytes: byteCount(value?.freeBytes), minFreeBytes: byteCount(value?.minFreeBytes), reservedBytes: byteCount(value?.reservedBytes) };
}
function resources(value, keys) {
  if (!value || typeof value !== 'object') return null;
  return Object.fromEntries(keys.map(key => [key, ['cpuLimit', 'timeoutSeconds'].includes(key) || Number.isInteger(value[key]) ? number(value[key], Number.MIN_VALUE) : null]));
}
function environment(value) {
  if (!value || !/^[a-f0-9]{64}$/.test(value.manifestSha256 || '') || value.id !== `renv_${value.manifestSha256}`
      || !/^sha256:[a-f0-9]{64}$/.test(value.imageDigest || '') || !/^sha256:[a-f0-9]{64}$/.test(value.imageId || '')
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value.profileId || '') || !/^\d+\.\d+\.\d+$/.test(value.rVersion || '')
      || !/^\d+\.\d+$/.test(value.bioconductor || '') || value.snapshotScope !== 'container-userspace') return null;
  return Object.fromEntries(['id', 'manifestSha256', 'profileId', 'rVersion', 'bioconductor', 'imageDigest', 'imageId', 'snapshotScope'].map(key => [key, value[key]]));
}

// A readiness response is an observation, never an execution grant. Retain only
// displayable fields so unexpected server diagnostics cannot enter this panel.
export function normalizeRuntimeReadiness(value) {
  const maximumApi = value?.service?.serviceApiVersion, minimumApi = value?.service?.minimumClientApiVersion;
  if (value?.schema !== READINESS_SCHEMA || value?.service?.product !== 'TraceOmics'
      || !Number.isInteger(maximumApi) || !Number.isInteger(minimumApi) || minimumApi < 1 || maximumApi > 1000
      || minimumApi > maximumApi || minimumApi > 1 || maximumApi < 1) {
    throw Object.assign(new Error('This server does not provide a supported readiness report. Ask the server administrator to update it.'), { code: 'READINESS_INCOMPATIBLE' });
  }
  const packages = Array.isArray(value.guided?.packages) ? value.guided.packages.slice(0, 32)
    .filter(item => packageName(item?.name)).map(item => ({ name: packageName(item.name), state: ['available', 'missing'].includes(item.state) ? item.state : 'unknown' })) : [];
  const issues = Array.isArray(value.issues) ? value.issues.slice(0, 32)
    .filter(item => Object.hasOwn(READINESS_REMEDIATIONS, item?.code) && SCOPES.has(item.scope))
    .map(item => ({ code: item.code, scope: item.scope, state: state(item.state), ...(packageName(item.package) ? { package: packageName(item.package) } : {}) })) : [];
  return {
    schema: READINESS_SCHEMA, checkedAt: timestamp(value.checkedAt), staleAfterMs: Number.isInteger(value.staleAfterMs) && value.staleAfterMs <= 10000 ? number(value.staleAfterMs, 1) : null,
    service: { product: 'TraceOmics', state: state(value.service.state), serviceApiVersion: maximumApi, minimumClientApiVersion: minimumApi, supportedTarget: /^R \d+\.\d+\.x$/.test(value.service.supportedTarget || '') ? value.service.supportedTarget : null },
    guided: { state: state(value.guided?.state), rVersion: version(value.guided?.rVersion), packages },
    workers: { state: state(value.workers?.state), mode: ['standalone', 'embedded'].includes(value.workers?.mode) ? value.workers.mode : 'unknown', updatedAt: timestamp(value.workers?.updatedAt), capabilities: { pathwayEnrichment: boolean(value.workers?.capabilities?.pathwayEnrichment), cellChat: boolean(value.workers?.capabilities?.cellChat) } },
    privateR: {
      state: state(value.privateR?.state), accessState: ACCESS.has(value.privateR?.accessState) ? value.privateR.accessState : 'unknown',
      environment: environment(value.privateR?.environment),
      capabilities: Object.fromEntries(['persistentKernel', 'persistentKernelInterrupt', 'persistentKernelPublications'].map(key => [key, boolean(value.privateR?.capabilities?.[key])])),
      resources: { oneShot: resources(value.privateR?.resources?.oneShot, ['memoryBytes', 'cpuLimit', 'timeoutSeconds', 'maxConcurrent']), kernel: resources(value.privateR?.resources?.kernel, ['memoryBytes', 'cpuLimit', 'pidsLimit', 'idleTimeoutSeconds', 'maxLifetimeSeconds', 'executionSeconds', 'maxActive', 'maxPerOwner']) },
      storage: { work: storage(value.privateR?.storage?.work), durable: storage(value.privateR?.storage?.durable) },
    },
    storage: { durable: storage(value.storage?.durable), private: storage(value.storage?.private) },
    scheduler: { state: value.scheduler?.state === 'unsupported' ? 'unsupported' : 'unknown', kind: null }, issues,
  };
}

export async function readRuntimeReadiness(api, projectId, { signal } = {}) {
  if (typeof api?.getRuntimeReadiness !== 'function') throw Object.assign(new Error('Server readiness is unavailable in this client. Update the application and check again.'), { code: 'READINESS_CLIENT_UNAVAILABLE' });
  return normalizeRuntimeReadiness(await api.getRuntimeReadiness(projectId, { signal }));
}

export function readinessFailureMessage(error) {
  if (error?.code === 'READINESS_INCOMPATIBLE') return 'This server does not provide a supported readiness report. Ask the server administrator to update it.';
  if (error?.code === 'READINESS_CLIENT_UNAVAILABLE') return 'Server readiness is unavailable in this client. Update the application and check again.';
  if (error?.status === 401) return 'Your sign-in has expired. Sign in to this server again to check readiness.';
  if (error?.status === 403 || error?.status === 404) return 'Readiness for this project is unavailable. Ask a project owner to review your access or choose another project.';
  return 'The selected server could not be reached or did not confirm readiness. Check the connection, then try again.';
}
