import { afterEach, describe, expect, it } from 'vitest';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const storage = require('./storage');
const previews = require('./artifactPreviews');
const directories = [];
const handles = [];
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close().catch(() => {});
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});
async function fixture(bytes = Buffer.alloc(3 * 1024 * 1024 + 19, 37)) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'server-import-storage-')); directories.push(directory);
  const source = path.join(directory, 'source.rds'); fs.writeFileSync(source, bytes);
  const handle = await fs.promises.open(source, 'r'); handles.push(handle);
  const provider = storage.createLocalStorageProvider({ root: path.join(directory, 'managed') });
  const key = storage.projectStorageFileKey('proj_import', 'artifacts', 'av_import', 'content.rds');
  return { directory, source, handle, provider, key, bytes };
}

describe('bounded snapshots of authorized server file handles', () => {
  it('streams exact bytes, retains the source handle and atomically publishes a checksum', async () => {
    const value = await fixture(); const progress = [];
    const copied = await value.provider.putFileFromHandle(value.handle, value.key, {
      maxBytes: value.bytes.length, onProgress: bytes => progress.push(bytes),
    });
    expect(copied).toEqual({ key: value.key, sizeBytes: value.bytes.length, checksumSha256: crypto.createHash('sha256').update(value.bytes).digest('hex') });
    expect(progress.length).toBe(4); expect(progress.at(-1)).toBe(value.bytes.length);
    expect(fs.readFileSync(value.source).equals(value.bytes)).toBe(true);
    expect(fs.readFileSync(value.provider.resolveKey(value.key)).equals(value.bytes)).toBe(true);
    expect((await value.handle.stat()).size).toBe(value.bytes.length);
    expect(fs.existsSync(`${value.provider.resolveKey(value.key)}.import-partial`)).toBe(false);
  });
  it('refuses an overwritten selection and over-limit sources before creating any snapshot', async () => {
    const value = await fixture(); const expectedStat = await value.handle.stat();
    await expect(value.provider.putFileFromHandle(value.handle, value.key, { maxBytes: value.bytes.length - 1 })).rejects.toMatchObject({ code: 'STORAGE_SOURCE_CHANGED' });
    fs.appendFileSync(value.source, 'changed');
    await expect(value.provider.putFileFromHandle(value.handle, value.key, { maxBytes: value.bytes.length + 100, expectedStat })).rejects.toMatchObject({ code: 'STORAGE_SOURCE_CHANGED' });
    expect(fs.existsSync(value.provider.resolveKey(value.key))).toBe(false);
  });
  it('rejects a source mutated during streaming and removes the complete partial', async () => {
    const value = await fixture(); let changed = false;
    await expect(value.provider.putFileFromHandle(value.handle, value.key, { maxBytes: value.bytes.length,
      onProgress: () => { if (!changed) { changed = true; fs.appendFileSync(value.source, 'growth'); } },
    })).rejects.toMatchObject({ code: 'STORAGE_SOURCE_CHANGED' });
    expect(fs.existsSync(value.provider.resolveKey(value.key))).toBe(false);
    expect(fs.existsSync(`${value.provider.resolveKey(value.key)}.import-partial`)).toBe(false);
  });
  it('honors abort and post-copy authorization loss without publishing an object', async () => {
    const value = await fixture(); const controller = new AbortController();
    await expect(value.provider.putFileFromHandle(value.handle, value.key, { maxBytes: value.bytes.length, signal: controller.signal,
      onProgress: () => controller.abort(),
    })).rejects.toMatchObject({ code: 'STORAGE_SNAPSHOT_ABORTED' });
    await expect(value.provider.putFileFromHandle(value.handle, value.key, { maxBytes: value.bytes.length,
      validateSource: () => { throw Object.assign(new Error('Access removed'), { code: 'FORBIDDEN' }); },
    })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(fs.existsSync(value.provider.resolveKey(value.key))).toBe(false);
    expect(fs.existsSync(`${value.provider.resolveKey(value.key)}.import-partial`)).toBe(false);
  });
  it('never overwrites another publication or removes a partial it did not create', async () => {
    const value = await fixture(); const destination = value.provider.prepareWrite(value.key);
    fs.writeFileSync(`${destination}.import-partial`, 'retained');
    await expect(value.provider.putFileFromHandle(value.handle, value.key, { maxBytes: value.bytes.length })).rejects.toMatchObject({ code: 'EEXIST' });
    expect(fs.readFileSync(`${destination}.import-partial`, 'utf8')).toBe('retained');
    await value.provider.removeImportSnapshot(value.key);
    fs.writeFileSync(destination, 'immutable');
    await expect(value.provider.putFileFromHandle(value.handle, value.key, { maxBytes: value.bytes.length })).rejects.toMatchObject({ code: 'STORAGE_OBJECT_EXISTS' });
    expect(fs.readFileSync(destination, 'utf8')).toBe('immutable');
  });
  it('cleans only the exact retained import files without touching another version', async () => {
    const value = await fixture(); const destination = value.provider.prepareWrite(value.key);
    fs.writeFileSync(destination, 'incomplete'); fs.writeFileSync(`${destination}.import-partial`, 'partial');
    const other = `${destination}.other-version`; fs.writeFileSync(other, 'keep');
    await value.provider.removeImportSnapshot(value.key); await value.provider.removeImportSnapshot(value.key);
    expect(fs.existsSync(destination)).toBe(false); expect(fs.existsSync(`${destination}.import-partial`)).toBe(false);
    expect(fs.readFileSync(other, 'utf8')).toBe('keep');
  });
});

describe('server handle inspection', () => {
  it('uses the vetted handle with bounded table metadata and leaves it open', async () => {
    const value = await fixture(Buffer.from('sample,condition\na,control\nb,treated\n'));
    const inspected = await previews.inspectImportedHandle({ handle: value.handle, stat: await value.handle.stat(), originalFilename: 'samples.csv' }, 'sample-sheet', { maxBytes: 1024 });
    expect(inspected.type).toBe('sample-sheet'); expect(inspected.metadata['org.traceomics.table:columns']).toEqual(['sample','condition']);
    expect((await value.handle.stat()).size).toBe(value.bytes.length);
  });
  it('uses explicit server limits for large RDS metadata without deserializing or reading its bytes', async () => {
    const stat = { size: 201 * 1024 * 1024, isFile: () => true };
    const handle = { read: () => { throw new Error('RDS must not be inspected in the web process'); } };
    await expect(previews.inspectImportedHandle({ handle, stat, originalFilename: 'large.rds' }, 'auto')).rejects.toMatchObject({ code: 'ARTIFACT_PREVIEW_INVALID', status: 413 });
    const inspected = await previews.inspectImportedHandle({ handle, stat, originalFilename: 'large.rds' }, 'auto', { maxBytes: 512 * 1024 * 1024 });
    expect(inspected.id).toBe('org.r-project.rds'); expect(inspected.metadata).toEqual({});
  });
});
