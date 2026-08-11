import { describe, expect, it } from 'vitest';
import { hasAttachedLiveRObject, pipelineProbeAction } from './liveRState';

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

  it('reuses a positive probe and otherwise skips a stable projection', () => {
    expect(pipelineProbeAction({
      currentKey: key, nextKey: key, serverAttached: true, liveState: 'not_attached',
    })).toBe('project-attached');
    expect(pipelineProbeAction({
      currentKey: key, nextKey: key, serverAttached: false, liveState: 'not_attached',
    })).toBe('skip');
    expect(pipelineProbeAction({
      currentKey: key, nextKey: `${key}:new`, serverAttached: false, liveState: 'not_attached',
    })).toBe('probe');
  });
});
