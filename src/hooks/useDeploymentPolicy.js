import { useEffect, useState } from 'react';

// What this deployment allows. Everything starts closed and opens only on an
// explicit server answer, so an outage never enables uploads or Expert R.
export const CLOSED_DEPLOYMENT_POLICY = Object.freeze({
  registrationEnabled: false,
  legacyLocalImportsEnabled: false,
  legacyLiveMutationToolsEnabled: false,
  serverFigureExportEnabled: false,
  expertREnabled: false,
  expertRProfile: null,
  expertRStatus: null,
  demoMode: false,
  datasetUploadsEnabled: false,
  demoGuestTtlSeconds: null,
});

const EXPERT_R_CLOSED = Object.freeze({ expertREnabled: false, expertRProfile: null, expertRStatus: null });

function expertRFields(policy) {
  return {
    expertREnabled: policy.expertREnabled,
    expertRProfile: policy.expertRProfile,
    expertRStatus: policy.expertRStatus,
  };
}

// The public registration policy loads once. Expert R capability is per account,
// so it reloads when the signed-in user changes and closes on sign-out.
export function useDeploymentPolicy(userId) {
  const [policy, setPolicy] = useState(CLOSED_DEPLOYMENT_POLICY);

  useEffect(() => {
    let active = true;
    if (!window.electronAPI?.registrationPolicy) return undefined;
    window.electronAPI.registrationPolicy().then((server) => {
      if (!active) return;
      setPolicy((current) => ({
        registrationEnabled: server?.registrationEnabled === true,
        legacyLocalImportsEnabled: server?.legacyLocalImportsEnabled === true,
        legacyLiveMutationToolsEnabled: server?.legacyLiveMutationToolsEnabled === true,
        serverFigureExportEnabled: server?.serverFigureExportEnabled === true,
        ...expertRFields(current),
        demoMode: server?.demoMode === true,
        datasetUploadsEnabled: server?.datasetUploadsEnabled === true,
        demoGuestTtlSeconds: server?.demoGuestTtlSeconds || null,
      }));
    }).catch(() => {
      if (active) setPolicy((current) => ({ ...CLOSED_DEPLOYMENT_POLICY, ...expertRFields(current) }));
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    if (!userId || typeof window.electronAPI?.getExpertRCapabilities !== 'function') {
      setPolicy((current) => ({ ...current, ...EXPERT_R_CLOSED }));
      return undefined;
    }
    window.electronAPI.getExpertRCapabilities().then((capability) => {
      if (!active) return;
      setPolicy((current) => ({
        ...current,
        expertREnabled: capability?.expertREnabled === true,
        expertRProfile: capability?.expertRProfile || null,
        expertRStatus: capability?.expertRStatus || null,
      }));
    }).catch(() => {
      if (active) setPolicy((current) => ({ ...current, ...EXPERT_R_CLOSED }));
    });
    return () => { active = false; };
  }, [userId]);

  return policy;
}
