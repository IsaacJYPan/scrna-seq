import { useCallback, useEffect, useMemo } from 'react';
import { workflowRequest } from './workflowApi';

// Responses from a previous project or workflow must not replace the current view.
export function useWorkflowRequest(projectId, instanceId) {
  const scope = useMemo(() => ({ projectId, instanceId, active: true, controllers: new Set() }), [projectId, instanceId]);
  useEffect(() => {
    scope.active = true;
    return () => {
      scope.active = false;
      for (const controller of scope.controllers) controller.abort();
    };
  }, [scope]);
  return useCallback(async (suffix, method, body) => {
    if (!scope.active) throw new DOMException('Workflow closed.', 'AbortError');
    const controller = new AbortController();
    scope.controllers.add(controller);
    try {
      const result = await workflowRequest(projectId, suffix, method, body, controller.signal);
      if (controller.signal.aborted) throw new DOMException('Workflow closed.', 'AbortError');
      return result;
    } finally { scope.controllers.delete(controller); }
  }, [projectId, scope]);
}
