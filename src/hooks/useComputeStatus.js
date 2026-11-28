import { useEffect, useState } from 'react';

const UNKNOWN_COMPUTE_STATUS = { status: 'unknown', updatedAt: null };
const COMPUTE_STATUS_POLL_MS = 5000;

// Polls the server's compute-availability projection while someone is signed
// in. Any failure reads as unknown rather than unavailable.
export function useComputeStatus(userEmail) {
  const [computeStatus, setComputeStatus] = useState(UNKNOWN_COMPUTE_STATUS);

  useEffect(() => {
    if (!userEmail || typeof window.electronAPI?.getComputeRuntimeStatus !== 'function') {
      setComputeStatus(UNKNOWN_COMPUTE_STATUS);
      return undefined;
    }
    let active = true;
    const refreshComputeStatus = async () => {
      try {
        const next = await window.electronAPI.getComputeRuntimeStatus();
        if (active) setComputeStatus(next);
      } catch {
        if (active) setComputeStatus(UNKNOWN_COMPUTE_STATUS);
      }
    };
    void refreshComputeStatus();
    const intervalId = window.setInterval(refreshComputeStatus, COMPUTE_STATUS_POLL_MS);
    return () => {
      active = false;
      window.clearInterval(intervalId);
    };
  }, [userEmail]);

  return computeStatus;
}
