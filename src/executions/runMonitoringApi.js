import { apiUrl } from '../api';
import { withExecutionTarget } from '../runtime/executionTarget';

async function request(path, signal) {
  return withExecutionTarget(async () => {
    const controller = new AbortController();
    const cancel = () => controller.abort(signal?.reason);
    if (signal?.aborted) cancel();
    else signal?.addEventListener('abort', cancel, { once: true });
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      let response;
      try { response = await fetch(apiUrl(path), { credentials: 'include', signal: controller.signal }); }
      catch (error) {
        if (signal?.aborted) throw error;
        throw new Error('Run monitoring could not be reached. Previously confirmed observations remain visible.');
      }
      if ([401, 403, 404].includes(response.status)) {
        throw Object.assign(new Error('This run is no longer available to your account.'), { status: response.status });
      }
      if (!response.ok) throw new Error('Run monitoring is unavailable. Refresh to check the same run.');
      let value;
      try { value = await response.json(); }
      catch { throw new Error('Run monitoring returned an invalid response. Refresh to check the same run.'); }
      return value;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', cancel);
    }
  });
}

const base = projectId => `/api/run-monitoring/${encodeURIComponent(projectId)}`;
export function listRunMonitoring(projectId, { before, limit = 25, signal } = {}) {
  const pageSize = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 25) : 25;
  return request(`${base(projectId)}?${new URLSearchParams({ limit: String(pageSize), ...(before ? { before } : {}) })}`, signal);
}
export function getRunMonitoring(projectId, recordId, signal) {
  return request(`${base(projectId)}/${encodeURIComponent(recordId)}`, signal);
}
