import { describe, expect, it } from 'vitest';
import { hasAttachedLiveRObject } from './liveRState';

describe('hasAttachedLiveRObject', () => {
  it('allows live R calls only for an explicitly attached object', () => {
    expect(hasAttachedLiveRObject({ id: 'ao_1', liveState: 'attached' })).toBe(true);
    expect(hasAttachedLiveRObject({ id: 'ao_1', liveState: 'not_attached' })).toBe(false);
    expect(hasAttachedLiveRObject({ id: 'ao_1', liveState: 'private_transient' })).toBe(false);
    expect(hasAttachedLiveRObject({ id: 'ao_1' })).toBe(false);
    expect(hasAttachedLiveRObject(null)).toBe(false);
  });
});
