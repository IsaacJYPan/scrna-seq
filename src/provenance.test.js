import { describe, it, expect } from 'vitest';
import { makeCacheKey } from './provenance';

describe('provenance.js logic', () => {
  it('generates a deterministic fallback cache key', async () => {
    const key = await makeCacheKey('RunUMAP', { dims: 10 }, 'v1', ['parent-id']);
    expect(key).toBe('RunUMAP-{"dims":10}-v1-["parent-id"]');
  });
});
