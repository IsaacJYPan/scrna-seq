import { afterEach, describe, expect, it, vi } from 'vitest';

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
    expect(storage.completionReceiptKey('proj_abc123', 'job_def456'))
      .toBe('projects/proj_abc123/artifacts/job_def456/completion-receipt.json');
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
  it('atomically stores a file, removes the staging copy, and verifies integrity asynchronously', async () => {
    const root = tempDir('storage-root');
    const staging = tempDir('storage-stage');
    const source = path.join(staging, 'upload.h5');
    const bytes = Buffer.from('durable dataset bytes');
    fs.writeFileSync(source, bytes);
    const key = storage.projectStorageFileKey('proj_abc', 'datasets', 'ds_def', 'matrix.h5');
    const provider = storage.createLocalStorageProvider({ root });

    const copySync = vi.spyOn(fs, 'copyFileSync').mockImplementation(() => {
      throw new Error('dataset finalization must not copy synchronously');
    });
    const fsyncSync = vi.spyOn(fs, 'fsyncSync').mockImplementation(() => {
      throw new Error('dataset finalization must not fsync synchronously');
    });
    const hashReadSync = vi.spyOn(fs, 'readSync').mockImplementation(() => {
      throw new Error('dataset finalization must not hash synchronously');
    });
    const stored = await provider.putFileFromPath(source, key);
    expect(copySync).not.toHaveBeenCalled();
    expect(fsyncSync).not.toHaveBeenCalled();
    expect(hashReadSync).not.toHaveBeenCalled();
    copySync.mockRestore();
    fsyncSync.mockRestore();
    hashReadSync.mockRestore();

    expect(fs.existsSync(source)).toBe(false);
    expect(fs.readFileSync(provider.resolveKey(key))).toEqual(bytes);
    expect(stored).toEqual({
      key,
      sizeBytes: bytes.length,
      checksumSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    });
    const readSync = vi.spyOn(fs, 'readSync').mockImplementation(() => {
      throw new Error('inspect must not hash with synchronous reads');
    });
    await expect(provider.inspect(key, stored)).resolves.toEqual(stored);
    expect(readSync).not.toHaveBeenCalled();
    readSync.mockRestore();
    expect(provider.remove(key)).toBe(true);
    expect(fs.existsSync(provider.resolveKey(key))).toBe(false);
    expect(provider.remove(key)).toBe(false);
  });

  it('fails closed for missing, changed, duplicate, and non-project objects', async () => {
    const root = tempDir('storage-root');
    const staging = tempDir('storage-stage');
    const provider = storage.createLocalStorageProvider({ root });
    const key = storage.projectStorageFileKey('proj_abc', 'artifacts', 'job_def', 'result.csv');
    const source = path.join(staging, 'result.csv');
    fs.writeFileSync(source, 'a,b\n1,2\n');
    const stored = await provider.putFileFromPath(source, key);

    expect(() => provider.prepareWrite('vault/private/file.rds')).toThrow(/project-scoped/);
    expect(() => provider.remove('vault/private/file.rds')).toThrow(/project-scoped/);
    await expect(provider.inspect('projects/proj_abc/artifacts/job_def/missing.csv'))
      .rejects.toThrow(/missing/);
    await expect(provider.inspect(key, { ...stored, sizeBytes: stored.sizeBytes + 1 }))
      .rejects.toThrow(/size/);
    await expect(provider.inspect(key, { ...stored, checksumSha256: '0'.repeat(64) }))
      .rejects.toThrow(/checksum/);

    const duplicate = path.join(staging, 'duplicate.csv');
    fs.writeFileSync(duplicate, 'different');
    await expect(provider.putFileFromPath(duplicate, key)).rejects.toThrow(/already exists/);
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

  it('inspect rejects a linked parent instead of hashing a file outside the root', async () => {
    const root = tempDir('storage-root');
    const outside = tempDir('storage-outside');
    const projectDir = path.join(root, 'projects', 'proj_abc');
    const outsideResource = path.join(outside, 'job_def');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.mkdirSync(outsideResource, { recursive: true });
    fs.writeFileSync(path.join(outsideResource, 'result.csv'), 'outside');
    try {
      fs.symlinkSync(outside, path.join(projectDir, 'artifacts'),
        process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      return;
    }
    const provider = storage.createLocalStorageProvider({ root });
    const key = storage.projectStorageFileKey('proj_abc', 'artifacts', 'job_def', 'result.csv');
    await expect(provider.inspect(key)).rejects.toMatchObject({ code: 'UNSAFE_STORAGE_PATH' });
  });

  it('reads only a bounded plain-object completion receipt from the exact key', async () => {
    const root = tempDir('storage-root');
    const provider = storage.createLocalStorageProvider({ root });
    const key = storage.completionReceiptKey('proj_abc', 'job_def');
    const envelope = { algorithm: 'hmac-sha256', signed_receipt: '{}', signature: 'a'.repeat(64) };
    fs.writeFileSync(provider.prepareWrite(key), JSON.stringify(envelope), 'utf8');
    await expect(provider.readCompletionReceipt(key)).resolves.toEqual(envelope);

    fs.writeFileSync(provider.resolveKey(key), '{broken', 'utf8');
    await expect(provider.readCompletionReceipt(key)).rejects.toMatchObject({
      code: 'RECEIPT_JSON_INVALID',
    });
    fs.writeFileSync(
      provider.resolveKey(key),
      Buffer.alloc(storage.COMPLETION_RECEIPT_MAX_BYTES + 1, 0x61)
    );
    await expect(provider.readCompletionReceipt(key)).rejects.toMatchObject({
      code: 'RECEIPT_SIZE_INVALID',
    });
  });

  it('completion receipt reads reject a linked parent and ignore partial files', async () => {
    const root = tempDir('storage-root');
    const outside = tempDir('storage-outside');
    const projectDir = path.join(root, 'projects', 'proj_abc');
    const outsideResource = path.join(outside, 'job_def');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.mkdirSync(outsideResource, { recursive: true });
    fs.writeFileSync(
      path.join(outsideResource, storage.COMPLETION_RECEIPT_FILE_NAME),
      '{}'
    );
    try {
      fs.symlinkSync(outside, path.join(projectDir, 'artifacts'),
        process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      return;
    }
    const provider = storage.createLocalStorageProvider({ root });
    const key = storage.completionReceiptKey('proj_abc', 'job_def');
    await expect(provider.readCompletionReceipt(key)).rejects.toMatchObject({
      code: 'UNSAFE_STORAGE_PATH',
    });

    fs.rmSync(path.join(projectDir, 'artifacts'), { recursive: true, force: true });
    fs.mkdirSync(path.dirname(provider.resolveKey(key)), { recursive: true });
    fs.writeFileSync(`${provider.resolveKey(key)}.partial-test`, '{}');
    await expect(provider.readCompletionReceipt(key)).rejects.toMatchObject({
      code: 'STORAGE_OBJECT_MISSING',
    });
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
