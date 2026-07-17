import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DEFAULT_PIPELINE_ID,
  getDefaultPipelineManifest,
  validatePipelineManifest,
} from './pipelineRegistry';

function safePipelineManifest(candidate) {
  if (!candidate || candidate.id === DEFAULT_PIPELINE_ID) return getDefaultPipelineManifest();
  try {
    return validatePipelineManifest(candidate);
  } catch {
    return getDefaultPipelineManifest();
  }
}

export function useProjectPipelineSelection({ api, projectId, userEmail }) {
  const [activePipeline, setActivePipeline] = useState(() => getDefaultPipelineManifest());
  const requestEpochRef = useRef(0);

  const handlePipelineSelectionChanged = useCallback((manifest) => {
    requestEpochRef.current += 1;
    setActivePipeline(safePipelineManifest(manifest));
  }, []);

  useEffect(() => {
    const requestEpoch = ++requestEpochRef.current;
    if (!userEmail || !projectId || !api?.getProjectPipelineSelection) {
      setActivePipeline(getDefaultPipelineManifest());
      return undefined;
    }

    let cancelled = false;
    api.getProjectPipelineSelection(projectId)
      .then(selection => {
        if (cancelled || requestEpoch !== requestEpochRef.current) return;
        setActivePipeline(safePipelineManifest(selection?.definition?.manifest));
      })
      .catch(() => {
        if (!cancelled && requestEpoch === requestEpochRef.current) {
          setActivePipeline(getDefaultPipelineManifest());
        }
      });

    return () => {
      cancelled = true;
    };
  }, [api, projectId, userEmail]);

  return { activePipeline, handlePipelineSelectionChanged };
}
