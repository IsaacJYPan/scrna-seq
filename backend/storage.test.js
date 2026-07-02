/**
 * Storage convention contract (unit-only). Verifies project-scoped durable
 * storage keys are server-safe: allow-listed kinds, traversal-proof segments,
 * and a resolved path that cannot escape the storage root. No bytes are read or
 * written; this pins the key/path hygiene the (future) durable storage relies on.
 */

import { describe, it, expect } from 'vitest';
const path = require('path');
const storage = require('./storage');

describe('projectStorageKey', () => {
  it('builds a relative, provider-agnostic key for an allow-listed kind', () => {
    const key = storage.projectStorageKey('proj_abc123', 'artifacts', 'art_def456');
    expect(key).toBe('projects/proj_abc123/artifacts/art_def456');
    expect(key.startsWith('/')).toBe(false);
  });

  it('rejects an unknown resource kind', () => {
    expect(() => storage.projectStorageKey('proj_abc', 'secrets', 'art_x')).toThrow(/Unknown project storage kind/);
  });

  it('rejects traversal / separator segments in ids', () => {
    expect(() => storage.projectStorageKey('../etc', 'artifacts', 'art_x')).toThrow();
    expect(() => storage.projectStorageKey('proj_abc', 'artifacts', '..')).toThrow();
    expect(() => storage.projectStorageKey('proj_abc', 'artifacts', 'a/b')).toThrow();
    expect(() => storage.projectStorageKey('proj_abc', 'artifacts', 'a\0b')).toThrow();
  });
});

describe('resolveStoragePath', () => {
  it('resolves a key under the storage root', () => {
    const abs = storage.resolveStoragePath('projects/proj_abc/artifacts/art_def');
    expect(abs.startsWith(storage.storageRoot())).toBe(true);
  });

  it('refuses a key that escapes the storage root', () => {
    expect(() => storage.resolveStoragePath('../../etc/passwd')).toThrow(/escapes the storage root/);
    expect(() => storage.resolveStoragePath('a\0b')).toThrow(/Invalid storage key/);
  });

  it('honors STORAGE_ROOT override', () => {
    const prev = process.env.STORAGE_ROOT;
    try {
      process.env.STORAGE_ROOT = path.join(process.cwd(), 'data');
      expect(storage.storageRoot()).toBe(path.resolve(path.join(process.cwd(), 'data')));
    } finally {
      if (prev === undefined) delete process.env.STORAGE_ROOT; else process.env.STORAGE_ROOT = prev;
    }
  });
});
