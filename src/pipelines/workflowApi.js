import { withExecutionTarget } from '../runtime/executionTarget';
import { submitWithRecovery } from '../executions/submissionRecovery';

const base = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/+$/, '');

export function mergeWorkflowUpdate(current, incoming, replace = false) {
  if (!current) return current;
  if (current.id !== incoming.id) return replace ? incoming : current;
  if (current.state.generation > incoming.state.generation) return current;
  // Starting a run leaves the current results' generation intact. An older idle
  // poll at that same generation must not hide the accepted run.
  if (current.state.generation === incoming.state.generation && current.state.active && !incoming.state.active) return current;
  return incoming;
}

export function workflowUrl(projectId, suffix) {
  return `${base}/api/workflows/${encodeURIComponent(projectId)}/${suffix}`;
}
async function performWorkflowRequest(projectId, suffix, method, body, signal) {
  const response = await fetch(workflowUrl(projectId, suffix), {
    method, credentials: 'include', signal,
    headers: { 'Content-Type': 'application/json', 'X-Traceomics-Csrf': '1' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(value.error || 'The workflow request failed.'), { status: response.status, code: value.code });
  return value;
}

export async function workflowRequest(projectId, suffix, method = 'GET', body, signal) {
  const run = method === 'POST' && /^instances\/([^/]+)\/run$/.exec(suffix);
  if (run) return submitWithRecovery({ projectId, instanceId: run[1], kind: 'workflow', requestId: body?.requestId,
    submit: requestId => performWorkflowRequest(projectId, suffix, method, { ...body, requestId }, signal) });
  return withExecutionTarget(() => performWorkflowRequest(projectId, suffix, method, body, signal), { mutation: method !== 'GET' });
}
