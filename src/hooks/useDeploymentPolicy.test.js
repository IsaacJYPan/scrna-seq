import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLOSED_DEPLOYMENT_POLICY, useDeploymentPolicy } from './useDeploymentPolicy';

afterEach(() => {
  delete window.electronAPI;
});

describe('useDeploymentPolicy', () => {
  it('stays closed until the server answers and closes again when it cannot', async () => {
    window.electronAPI = { registrationPolicy: vi.fn(async () => { throw new Error('offline'); }) };
    const { result } = renderHook(() => useDeploymentPolicy(null));
    expect(result.current).toEqual(CLOSED_DEPLOYMENT_POLICY);
    await waitFor(() => expect(window.electronAPI.registrationPolicy).toHaveBeenCalled());
    expect(result.current).toEqual(CLOSED_DEPLOYMENT_POLICY);
  });

  it('opens only fields the server set to exactly true', async () => {
    window.electronAPI = {
      registrationPolicy: vi.fn(async () => ({
        registrationEnabled: true, datasetUploadsEnabled: 'yes', demoMode: true, demoGuestTtlSeconds: 600,
      })),
    };
    const { result } = renderHook(() => useDeploymentPolicy(null));
    await waitFor(() => expect(result.current.registrationEnabled).toBe(true));
    expect(result.current.datasetUploadsEnabled).toBe(false);
    expect(result.current.demoMode).toBe(true);
    expect(result.current.demoGuestTtlSeconds).toBe(600);
  });

  it('loads Expert R per signed-in user and closes it on sign-out', async () => {
    window.electronAPI = {
      registrationPolicy: vi.fn(async () => ({ registrationEnabled: true })),
      getExpertRCapabilities: vi.fn(async () => ({ expertREnabled: true, expertRProfile: 'default', expertRStatus: 'approved' })),
    };
    const { result, rerender } = renderHook(({ userId }) => useDeploymentPolicy(userId), { initialProps: { userId: 7 } });
    await waitFor(() => expect(result.current.expertREnabled).toBe(true));
    expect(result.current).toMatchObject({ registrationEnabled: true, expertRProfile: 'default', expertRStatus: 'approved' });

    rerender({ userId: null });
    await waitFor(() => expect(result.current.expertREnabled).toBe(false));
    expect(result.current).toMatchObject({ registrationEnabled: true, expertRProfile: null, expertRStatus: null });
  });
});
