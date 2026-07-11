import { afterEach, describe, expect, it } from 'vitest';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const storage = require('./storage');

const cleanup = [];

afterEach(() => {
  while (cleanup.length) {
    const target = cleanup.pop();
    try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

function tempDir(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
  cleanup.push(dir);
  return dir;
}

describe('project storage keys', () => {
  it('builds project-scoped resource and file keys', () => {
    expect(storage.projectStorageKey('proj_abc123', 'artifacts', 'art_def456'))
      .toBe('projects/proj_abc123/artifacts/art_def456');
    expect(storage.projectStorageFileKey('proj_abc123', 'checkpoints', 'job_def456', 'abc.rds'))
      .toBe('projects/proj_abc123/checkpoints/job_def456/abc.rds');
    expect(storage.isProjectStorageKey(
      'projects/proj_abc123/checkpoints/job_def456/abc.rds',
      { projectId: 'proj_abc123', kind: 'checkpoints' }
    )).toBe(true);
  });

  it('rejects unknown kinds and unsafe segments', () => {
    expect(() => storage.projectStorageKey('proj_abc', 'secrets', 'art_x')).toThrow(/Unknown/);
    for (const bad of ['../etc', '..', 'a/b', 'a\\b', 'a\0b', '%2e%2e']) {
      expect(() => storage.projectStorageKey(bad, 'artifacts', 'art_x')).toThrow();
    }
    expect(() => storage.projectStorageFileKey('proj_abc', 'artifacts', 'art_x', '../x'))
      .toThrow(/file name/i);
  });

  it('refuses traversal, encoded traversal, absolute, Windows-style, and empty segments', () => {
    const provider = storage.createLocalStorageProvider({ root: tempDir('storage-root') });
    for (const bad of [
      '../../etc/passwd',
      'projects/proj_abc/../artifacts/art_def',
      '/etc/passwd',
      'C:\\Windows\\win.ini',
      'projects\\proj_abc\\artifacts\\art_def',
      'a\0b',
      'projects/proj_abc/%2e%2e/secret',
      'projects//artifacts/art_def',
      './projects/proj_abc',
    ]) {
      expect(() => provider.resolveKey(bad)).toThrow();
    }
  });
});

describe('local durable storage provider', () => {
  it('atomically stores a file, removes the staging copy, and verifies integrity', () => {
    const root = tempDir('storage-root');
    const staging = tempDir('storage-stage');
    const source = path.join(staging, 'upload.h5');
    const bytes = Buffer.from('durable dataset bytes');
    fs.writeFileSync(source, bytes);
    const key = storage.projectStorageFileKey('proj_abc', 'datasets', 'ds_def', 'matrix.h5');
    const provider = storage.createLocalStorageProvider({ root });

    const stored = provider.putFileFromPath(source, key);

    expect(fs.existsSync(source)).toBe(false);
    expect(fs.readFileSync(provider.resolveKey(key))).toEqual(bytes);
    expect(stored).toEqual({
      key,
      sizeBytes: bytes.length,
      checksumSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    });
    expect(provider.inspect(key, stored)).toEqual(stored);
    expect(provider.remove(key)).toBe(true);
    expect(fs.existsSync(provider.resolveKey(key))).toBe(false);
    expect(provider.remove(key)).toBe(false);
  });

  it('fails closed for missing, changed, duplicate, and non-project objects', () => {
    const root = tempDir('storage-root');
    const staging = tempDir('storage-stage');
    const provider = storage.createLocalStorageProvider({ root });
    const key = storage.projectStorageFileKey('proj_abc', 'artifacts', 'job_def', 'result.csv');
    const source = path.join(staging, 'result.csv');
    fs.writeFileSync(source, 'a,b\n1,2\n');
    const stored = provider.putFileFromPath(source, key);

    expect(() => provider.prepareWrite('vault/private/file.rds')).toThrow(/project-scoped/);
    expect(() => provider.remove('vault/private/file.rds')).toThrow(/project-scoped/);
    expect(() => provider.inspect('projects/proj_abc/artifacts/job_def/missing.csv'))
      .toThrow(/missing/);
    expect(() => provider.inspect(key, { ...stored, sizeBytes: stored.sizeBytes + 1 }))
      .toThrow(/size/);
    expect(() => provider.inspect(key, { ...stored, checksumSha256: '0'.repeat(64) }))
      .toThrow(/checksum/);

    const duplicate = path.join(staging, 'duplicate.csv');
    fs.writeFileSync(duplicate, 'different');
    expect(() => provider.putFileFromPath(duplicate, key)).toThrow(/already exists/);
    expect(fs.existsSync(duplicate)).toBe(true);
  });

  it('does not follow a junction or symbolic link inside the storage root', () => {
    const root = tempDir('storage-root');
    const outside = tempDir('storage-outside');
    const projectDir = path.join(root, 'projects', 'proj_abc');
    fs.mkdirSync(projectDir, { recursive: true });
    const linkedKind = path.join(projectDir, 'datasets');
    try {
      fs.symlinkSync(outside, linkedKind, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      return;
    }
    const provider = storage.createLocalStorageProvider({ root });
    const key = storage.projectStorageFileKey('proj_abc', 'datasets', 'ds_def', 'matrix.h5');
    expect(() => provider.prepareWrite(key)).toThrow(/symbolic link|junction/);
  });
});

describe('storage roots', () => {
  it('honors STORAGE_ROOT override', () => {
    const prev = process.env.STORAGE_ROOT;
    try {
      process.env.STORAGE_ROOT = path.join(process.cwd(), 'data');
      expect(storage.storageRoot()).toBe(path.resolve(path.join(process.cwd(), 'data')));
    } finally {
      if (prev === undefined) delete process.env.STORAGE_ROOT;
      else process.env.STORAGE_ROOT = prev;
    }
  });
});
