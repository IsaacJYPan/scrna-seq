import { describe, expect, it } from 'vitest';
import {
  hasAttachedLiveRObject,
  PIPELINE_PROBE_MAX_RETRIES,
  pipelineProbeAction,
  pipelineProbeRetryDelay,
  reconcileRestoredSession,
} from './liveRState';

describe('hasAttachedLiveRObject', () => {
  it('allows live R calls only for an explicitly attached object', () => {
    expect(hasAttachedLiveRObject({ id: 'ao_1', liveState: 'attached' })).toBe(true);
    expect(hasAttachedLiveRObject({ id: 'ao_1', liveState: 'not_attached' })).toBe(false);
    expect(hasAttachedLiveRObject({ id: 'ao_1', liveState: 'private_transient' })).toBe(false);
    expect(hasAttachedLiveRObject({ id: 'ao_1' })).toBe(false);
    expect(hasAttachedLiveRObject(null)).toBe(false);
  });
});

describe('pipelineProbeAction', () => {
  const key = 'owner@example.org:ao_1:r-session-1';

  it('re-probes the same object after a durable checkpoint attach changes the UI projection', () => {
    expect(pipelineProbeAction({
      currentKey: key, nextKey: key, serverAttached: false, liveState: 'attached',
    })).toBe('probe');
  });

  it('never treats cached project metadata as proof of a live attachment', () => {
    expect(pipelineProbeAction({
      currentKey: key, nextKey: key, serverAttached: true, liveState: 'not_attached',
    })).toBe('skip');
    expect(pipelineProbeAction({
      currentKey: key, nextKey: key, serverAttached: false, liveState: 'not_attached',
    })).toBe('skip');
    expect(pipelineProbeAction({
      currentKey: key, nextKey: `${key}:new`, serverAttached: false, liveState: 'not_attached',
    })).toBe('probe');
    expect(pipelineProbeAction({
      currentKey: null, nextKey: key, serverAttached: false, liveState: 'attached',
    })).toBe('probe');
  });
});

describe('pipelineProbeRetryDelay', () => {
  it('backs off transient shared-runtime contention while remaining bounded', () => {
    expect(PIPELINE_PROBE_MAX_RETRIES).toBeGreaterThanOrEqual(8);
    expect(pipelineProbeRetryDelay(1)).toBe(500);
    expect(pipelineProbeRetryDelay(2)).toBe(1_000);
    expect(pipelineProbeRetryDelay(4)).toBe(4_000);
    expect(pipelineProbeRetryDelay(8)).toBe(5_000);
    expect(pipelineProbeRetryDelay(8, 250)).toBe(5_250);
    expect(pipelineProbeRetryDelay(0, -10)).toBe(500);
  });
});

describe('reconcileRestoredSession', () => {
  it('does not let an initial unauthenticated probe erase a login completed in flight', () => {
    const authenticated = { id: 7, email: 'guest@demo.invalid' };
    expect(reconcileRestoredSession(authenticated, null)).toBe(authenticated);
  });

  it('restores a cookie-authenticated user only while the app is still unauthenticated', () => {
    const restored = { id: 8, email: 'restored@example.org' };
    expect(reconcileRestoredSession(null, restored)).toBe(restored);
    expect(reconcileRestoredSession(null, null)).toBeNull();
  });
});
