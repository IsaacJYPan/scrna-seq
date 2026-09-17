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
export async function workflowRequest(projectId, suffix, method = 'GET', body, signal) {
  const response = await fetch(workflowUrl(projectId, suffix), {
    method, credentials: 'include', signal,
    headers: { 'Content-Type': 'application/json', 'X-Traceomics-Csrf': '1' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || 'The workflow request failed.');
  return value;
}
