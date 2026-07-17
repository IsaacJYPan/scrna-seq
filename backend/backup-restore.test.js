import { afterEach, describe, expect, it, vi } from 'vitest';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const backupRestore = require('./backupRestore');

const cleanup = [];
const DATABASE_URL = 'postgres://backup_user:do-not-leak@localhost:5432/scrna_test';
const SOURCE_SESSION_EPOCH = '4f8c2a6e1d9b3075c4e8a2f6d1b93570';
const RESTORE_SESSION_EPOCH = 'a7d31c8e5f209b64d2a84f1c7e3059b6';

afterEach(() => {
  while (cleanup.length) {
    const target = cleanup.pop();
    try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

function tempDir(label) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
  cleanup.push(directory);
  return directory;
}

function createRoots() {
  const base = tempDir('backup-restore');
  const storageRoot = path.join(base, 'data');
  const vaultRoot = path.join(base, 'vault');
  fs.mkdirSync(path.join(storageRoot, 'projects', 'proj_abc', 'datasets', 'ds_123'), { recursive: true });
  fs.mkdirSync(path.join(vaultRoot, 'user_example_com', 'state'), { recursive: true });
  fs.writeFileSync(
    path.join(storageRoot, 'projects', 'proj_abc', 'datasets', 'ds_123', 'matrix.h5'),
    Buffer.from('durable-dataset-bytes')
  );
  fs.writeFileSync(path.join(vaultRoot, 'user_example_com', 'state', 'object.rds'), 'private-r-state');
  return { base, storageRoot, vaultRoot };
}

function successfulPgSpawn(calls, dumpBytes = Buffer.from('fake-postgres-custom-dump')) {
  return (command, args, options) => {
    calls.push({ command, args: [...args], options });
    const child = new EventEmitter();
    child.stderr = new PassThrough();
    queueMicrotask(() => {
      if (path.basename(command).toLowerCase().includes('pg_dump')) {
        const fileIndex = args.indexOf('--file');
        fs.writeFileSync(args[fileIndex + 1], dumpBytes);
      }
      child.emit('close', 0, null);
    });
    return child;
  };
}

async function promoteDirectoryForTest(stage, target, existed) {
  if (existed) await fs.promises.rmdir(target);
  await fs.promises.rename(stage, target);
}

function createTestBackup(options) {
  return backupRestore.createBackup({ sessionEpoch: SOURCE_SESSION_EPOCH, ...options });
}

function restoreTestBackup(options) {
  return backupRestore.restoreBackup({
    sessionEpoch: RESTORE_SESSION_EPOCH,
    finalizeRestoredSecurityState: async () => ({ canceledJobs: 0 }),
    ...options,
  });
}

async function createFixtureBackup() {
  const roots = createRoots();
  const destination = path.join(roots.base, 'backup-package');
  const calls = [];
  const result = await createTestBackup({
    ...roots,
    destination,
    databaseUrl: DATABASE_URL,
    offlineAcknowledgement: backupRestore.OFFLINE_ACKNOWLEDGEMENT,
    createdAt: '2026-07-16T12:00:00.000Z',
    spawnImpl: successfulPgSpawn(calls),
  });
  return { ...roots, destination, calls, result };
}

describe('backup inventories', () => {
  it('records exact, sorted relative paths with sizes and SHA-256 hashes', async () => {
    const { storageRoot } = createRoots();
    const first = path.join(storageRoot, 'projects', 'proj_abc', 'artifacts', 'job_1');
    fs.mkdirSync(first, { recursive: true });
    fs.writeFileSync(path.join(first, 'a.json'), '{}');

    const inventory = await backupRestore.inventoryDirectory(storageRoot);

    expect(inventory.map((entry) => entry.path)).toEqual([
      'projects/proj_abc/artifacts/job_1/a.json',
      'projects/proj_abc/datasets/ds_123/matrix.h5',
    ]);
    expect(inventory.every((entry) => Number.isSafeInteger(entry.sizeBytes))).toBe(true);
    expect(inventory.every((entry) => /^[0-9a-f]{64}$/.test(entry.sha256))).toBe(true);
  });

  it('rejects a symbolic link or junction instead of traversing outside a root', async () => {
    const { storageRoot } = createRoots();
    const outside = tempDir('backup-outside');
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside');
    const link = path.join(storageRoot, 'projects', 'proj_abc', 'linked');
    try {
      fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      return;
    }

    await expect(backupRestore.inventoryDirectory(storageRoot)).rejects.toMatchObject({
      code: 'UNSAFE_LINKED_PATH',
    });
  });
});

describe('offline backup creation', () => {
  it('creates and revalidates a manifest-last package without credentials in process args', async () => {
    const fixture = await createFixtureBackup();
    const validated = await backupRestore.validateBackupPackage(fixture.destination);

    expect(validated.manifest).toEqual(fixture.result.manifest);
    expect(validated.manifest).toMatchObject({
      format: backupRestore.BACKUP_FORMAT,
      version: backupRestore.MANIFEST_VERSION,
      consistency: { mode: 'offline-quiesced', writersStoppedAcknowledged: true },
      authentication: { sessionEpoch: SOURCE_SESSION_EPOCH },
      database: { format: 'postgres-custom', file: backupRestore.DATABASE_DUMP_FILE_NAME },
      roots: {
        storage: { directory: 'storage', fileCount: 1 },
        vault: { directory: 'vault', fileCount: 1 },
      },
    });
    expect(fixture.calls).toHaveLength(1);
    const call = fixture.calls[0];
    expect(path.basename(call.command).toLowerCase()).toContain('pg_dump');
    expect(Array.isArray(call.args)).toBe(true);
    expect(call.args).toContain('--format=custom');
    expect(call.args).not.toContain('--clean');
    expect(call.args.join(' ')).not.toContain(DATABASE_URL);
    expect(call.args.join(' ')).not.toContain('do-not-leak');
    expect(call.options).toMatchObject({ shell: false, windowsHide: true });
    expect(call.options.env).toMatchObject({
      PGHOST: 'localhost',
      PGPORT: '5432',
      PGUSER: 'backup_user',
      PGPASSWORD: 'do-not-leak',
      PGDATABASE: 'scrna_test',
    });
  });

  it('requires the exact offline acknowledgement before any output is created', async () => {
    const roots = createRoots();
    const destination = path.join(roots.base, 'backup-package');
    const spawnImpl = vi.fn();

    await expect(createTestBackup({
      ...roots,
      destination,
      databaseUrl: DATABASE_URL,
      offlineAcknowledgement: 'yes',
      spawnImpl,
    })).rejects.toMatchObject({ code: 'OFFLINE_ACKNOWLEDGEMENT_REQUIRED' });
    expect(fs.existsSync(destination)).toBe(false);
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it('rejects overlapping and pre-existing destinations', async () => {
    const roots = createRoots();
    const overlap = path.join(roots.storageRoot, 'backup');
    await expect(createTestBackup({
      ...roots,
      destination: overlap,
      offlineAcknowledgement: backupRestore.OFFLINE_ACKNOWLEDGEMENT,
      spawnImpl: vi.fn(),
    })).rejects.toMatchObject({ code: 'OVERLAPPING_PATHS' });

    const existing = path.join(roots.base, 'existing');
    fs.mkdirSync(existing);
    await expect(createTestBackup({
      ...roots,
      destination: existing,
      offlineAcknowledgement: backupRestore.OFFLINE_ACKNOWLEDGEMENT,
      spawnImpl: vi.fn(),
    })).rejects.toMatchObject({ code: 'BACKUP_DESTINATION_EXISTS' });
  });
});

describe('backup validation and restore', () => {
  it('requires a new candidate session epoch before checking or mutating restore targets', async () => {
    const fixture = await createFixtureBackup();
    const storageTarget = path.join(fixture.base, 'restored-data');
    const vaultTarget = path.join(fixture.base, 'restored-vault');
    const verifyDatabaseEmpty = vi.fn(async () => true);
    const spawnImpl = vi.fn();

    await expect(backupRestore.restoreBackup({
      backupDirectory: fixture.destination,
      storageRoot: storageTarget,
      vaultRoot: vaultTarget,
      sessionEpoch: SOURCE_SESSION_EPOCH,
      offlineAcknowledgement: backupRestore.OFFLINE_ACKNOWLEDGEMENT,
      verifyDatabaseEmpty,
      spawnImpl,
    })).rejects.toMatchObject({ code: 'RESTORE_SESSION_EPOCH_REUSE' });
    expect(verifyDatabaseEmpty).not.toHaveBeenCalled();
    expect(spawnImpl).not.toHaveBeenCalled();
    expect(fs.existsSync(storageTarget)).toBe(false);
    expect(fs.existsSync(vaultTarget)).toBe(false);
  });

  it('detects changed package bytes before checking or mutating restore targets', async () => {
    const fixture = await createFixtureBackup();
    const copiedFile = path.join(
      fixture.destination,
      'storage',
      'projects',
      'proj_abc',
      'datasets',
      'ds_123',
      'matrix.h5'
    );
    fs.appendFileSync(copiedFile, 'tampered');
    const storageTarget = path.join(fixture.base, 'restored-data');
    const vaultTarget = path.join(fixture.base, 'restored-vault');
    const verifyDatabaseEmpty = vi.fn(async () => true);
    const spawnImpl = vi.fn();

    await expect(restoreTestBackup({
      backupDirectory: fixture.destination,
      storageRoot: storageTarget,
      vaultRoot: vaultTarget,
      databaseUrl: DATABASE_URL,
      offlineAcknowledgement: backupRestore.OFFLINE_ACKNOWLEDGEMENT,
      verifyDatabaseEmpty,
      spawnImpl,
    })).rejects.toMatchObject({ code: 'BACKUP_INTEGRITY_FAILED' });
    expect(verifyDatabaseEmpty).not.toHaveBeenCalled();
    expect(spawnImpl).not.toHaveBeenCalled();
    expect(fs.existsSync(storageTarget)).toBe(false);
    expect(fs.existsSync(vaultTarget)).toBe(false);
  });

  it('rejects a structurally tampered manifest before mutation', async () => {
    const fixture = await createFixtureBackup();
    const manifestPath = path.join(fixture.destination, backupRestore.MANIFEST_FILE_NAME);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.version = 999;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const storageTarget = path.join(fixture.base, 'restored-data');
    const vaultTarget = path.join(fixture.base, 'restored-vault');
    const spawnImpl = vi.fn();

    await expect(restoreTestBackup({
      backupDirectory: fixture.destination,
      storageRoot: storageTarget,
      vaultRoot: vaultTarget,
      offlineAcknowledgement: backupRestore.OFFLINE_ACKNOWLEDGEMENT,
      verifyDatabaseEmpty: vi.fn(async () => true),
      spawnImpl,
    })).rejects.toMatchObject({ code: 'INVALID_BACKUP_MANIFEST' });
    expect(spawnImpl).not.toHaveBeenCalled();
    expect(fs.existsSync(storageTarget)).toBe(false);
    expect(fs.existsSync(vaultTarget)).toBe(false);
  });

  it('rejects nonempty roots and a nonempty database before invoking pg_restore', async () => {
    const fixture = await createFixtureBackup();
    const storageTarget = path.join(fixture.base, 'restored-data');
    const vaultTarget = path.join(fixture.base, 'restored-vault');
    fs.mkdirSync(storageTarget);
    fs.writeFileSync(path.join(storageTarget, 'existing.txt'), 'do not overwrite');
    const spawnImpl = vi.fn();

    await expect(restoreTestBackup({
      backupDirectory: fixture.destination,
      storageRoot: storageTarget,
      vaultRoot: vaultTarget,
      offlineAcknowledgement: backupRestore.OFFLINE_ACKNOWLEDGEMENT,
      verifyDatabaseEmpty: vi.fn(async () => true),
      spawnImpl,
    })).rejects.toMatchObject({ code: 'RESTORE_ROOT_NOT_EMPTY' });
    expect(spawnImpl).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(storageTarget, 'existing.txt'), 'utf8')).toBe('do not overwrite');

    fs.rmSync(storageTarget, { recursive: true, force: true });
    const verifyDatabaseEmpty = vi.fn(async () => false);
    await expect(restoreTestBackup({
      backupDirectory: fixture.destination,
      storageRoot: storageTarget,
      vaultRoot: vaultTarget,
      offlineAcknowledgement: backupRestore.OFFLINE_ACKNOWLEDGEMENT,
      verifyDatabaseEmpty,
      spawnImpl,
    })).rejects.toMatchObject({ code: 'RESTORE_DATABASE_NOT_EMPTY' });
    expect(verifyDatabaseEmpty).toHaveBeenCalledOnce();
    expect(spawnImpl).not.toHaveBeenCalled();
    expect(fs.existsSync(storageTarget)).toBe(false);
    expect(fs.existsSync(vaultTarget)).toBe(false);
  });

  it('restores only into empty targets with pg_restore in one transaction and rechecks bytes', async () => {
    const fixture = await createFixtureBackup();
    const storageTarget = path.join(fixture.base, 'restored-data');
    const vaultTarget = path.join(fixture.base, 'restored-vault');
    fs.mkdirSync(storageTarget);
    const calls = [];
    const verifyDatabaseEmpty = vi.fn(async () => true);

    const restored = await restoreTestBackup({
      backupDirectory: fixture.destination,
      storageRoot: storageTarget,
      vaultRoot: vaultTarget,
      databaseUrl: DATABASE_URL,
      offlineAcknowledgement: backupRestore.OFFLINE_ACKNOWLEDGEMENT,
      verifyDatabaseEmpty,
      spawnImpl: successfulPgSpawn(calls),
    });

    expect(verifyDatabaseEmpty).toHaveBeenCalledTimes(2);
    expect(fs.readFileSync(
      path.join(storageTarget, 'projects', 'proj_abc', 'datasets', 'ds_123', 'matrix.h5'),
      'utf8'
    )).toBe('durable-dataset-bytes');
    expect(fs.readFileSync(
      path.join(vaultTarget, 'user_example_com', 'state', 'object.rds'),
      'utf8'
    )).toBe('private-r-state');
    expect(restored.manifest).toEqual(fixture.result.manifest);
    expect(restored.securityState).toEqual({ canceledJobs: 0 });
    expect(calls).toHaveLength(1);
    expect(path.basename(calls[0].command).toLowerCase()).toContain('pg_restore');
    expect(calls[0].args).toEqual(expect.arrayContaining([
      '--dbname',
      'scrna_test',
      '--exit-on-error',
      '--single-transaction',
      '--no-owner',
      '--no-privileges',
      '--no-password',
    ]));
    expect(calls[0].args).not.toContain('--clean');
    expect(calls[0].args.join(' ')).not.toContain(DATABASE_URL);
    expect(calls[0].args.join(' ')).not.toContain('do-not-leak');
    expect(calls[0].args.at(-1)).not.toBe(path.join(fixture.destination, backupRestore.DATABASE_DUMP_FILE_NAME));
    expect(path.dirname(calls[0].args.at(-1))).toBe(path.dirname(storageTarget));
    expect(calls[0].options.env).toMatchObject({
      PGHOST: 'localhost',
      PGPORT: '5432',
      PGUSER: 'backup_user',
      PGPASSWORD: 'do-not-leak',
      PGDATABASE: 'scrna_test',
    });
    expect(calls[0].options.shell).toBe(false);
  });

  it('seals the validated dump before use even if the read-only backup input changes later', async () => {
    const fixture = await createFixtureBackup();
    const storageTarget = path.join(fixture.base, 'restored-data');
    const vaultTarget = path.join(fixture.base, 'restored-vault');
    const originalDump = path.join(fixture.destination, backupRestore.DATABASE_DUMP_FILE_NAME);
    const calls = [];
    let promotions = 0;

    await restoreTestBackup({
      backupDirectory: fixture.destination,
      storageRoot: storageTarget,
      vaultRoot: vaultTarget,
      databaseUrl: DATABASE_URL,
      offlineAcknowledgement: backupRestore.OFFLINE_ACKNOWLEDGEMENT,
      verifyDatabaseEmpty: vi.fn(async () => true),
      spawnImpl: successfulPgSpawn(calls),
      promoteDirectory: async (...args) => {
        await promoteDirectoryForTest(...args);
        promotions += 1;
        if (promotions === 1) fs.appendFileSync(originalDump, 'changed-after-seal');
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].args.at(-1)).not.toBe(originalDump);
    expect(fs.existsSync(calls[0].args.at(-1))).toBe(false);
  });

  it('rechecks database emptiness at the final restore boundary', async () => {
    const fixture = await createFixtureBackup();
    const storageTarget = path.join(fixture.base, 'restored-data');
    const vaultTarget = path.join(fixture.base, 'restored-vault');
    const verifyDatabaseEmpty = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const spawnImpl = vi.fn();

    await expect(restoreTestBackup({
      backupDirectory: fixture.destination,
      storageRoot: storageTarget,
      vaultRoot: vaultTarget,
      databaseUrl: DATABASE_URL,
      offlineAcknowledgement: backupRestore.OFFLINE_ACKNOWLEDGEMENT,
      verifyDatabaseEmpty,
      spawnImpl,
    })).rejects.toMatchObject({
      code: 'RESTORE_CANDIDATE_INVALID',
      message: expect.stringMatching(/RESTORE_DATABASE_NOT_EMPTY/),
    });
    expect(verifyDatabaseEmpty).toHaveBeenCalledTimes(2);
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it('detects a dump change between package validation and private staging', async () => {
    const fixture = await createFixtureBackup();
    const storageTarget = path.join(fixture.base, 'restored-data');
    const vaultTarget = path.join(fixture.base, 'restored-vault');
    const calls = [];

    await expect(restoreTestBackup({
      backupDirectory: fixture.destination,
      storageRoot: storageTarget,
      vaultRoot: vaultTarget,
      databaseUrl: DATABASE_URL,
      offlineAcknowledgement: backupRestore.OFFLINE_ACKNOWLEDGEMENT,
      verifyDatabaseEmpty: vi.fn(async () => {
        fs.appendFileSync(path.join(fixture.destination, backupRestore.DATABASE_DUMP_FILE_NAME), 'race');
        return true;
      }),
      spawnImpl: successfulPgSpawn(calls),
    })).rejects.toMatchObject({ code: 'BACKUP_INTEGRITY_FAILED' });

    expect(calls).toHaveLength(0);
    expect(fs.existsSync(storageTarget)).toBe(false);
    expect(fs.existsSync(vaultTarget)).toBe(false);
  });

  it('marks the entire isolated candidate invalid if filesystem promotion becomes partial', async () => {
    const fixture = await createFixtureBackup();
    const storageTarget = path.join(fixture.base, 'restored-data');
    const vaultTarget = path.join(fixture.base, 'restored-vault');
    const spawnImpl = vi.fn();
    let promotions = 0;

    await expect(restoreTestBackup({
      backupDirectory: fixture.destination,
      storageRoot: storageTarget,
      vaultRoot: vaultTarget,
      databaseUrl: DATABASE_URL,
      offlineAcknowledgement: backupRestore.OFFLINE_ACKNOWLEDGEMENT,
      verifyDatabaseEmpty: vi.fn(async () => true),
      spawnImpl,
      promoteDirectory: async (...args) => {
        promotions += 1;
        if (promotions === 2) throw Object.assign(new Error('/private/mount'), { code: 'EIO' });
        await promoteDirectoryForTest(...args);
      },
    })).rejects.toMatchObject({
      code: 'RESTORE_CANDIDATE_INVALID',
      message: expect.stringMatching(/discard the isolated database and both restored roots/i),
    });

    expect(spawnImpl).not.toHaveBeenCalled();
    expect(fs.existsSync(storageTarget)).toBe(true);
    expect(fs.existsSync(vaultTarget)).toBe(false);
  });

  it('maps supported URI options to libpq variables and rejects unknown redirects', () => {
    const env = backupRestore.pgEnvironment(
      'postgres://user:p%40ss@db.example.test:5433/app?sslmode=verify-full&sslrootcert=%2Fcerts%2Fca.pem'
    );
    expect(env).toMatchObject({
      PGHOST: 'db.example.test',
      PGPORT: '5433',
      PGUSER: 'user',
      PGPASSWORD: 'p@ss',
      PGDATABASE: 'app',
      PGSSLMODE: 'verify-full',
      PGSSLROOTCERT: '/certs/ca.pem',
    });
    expect(() => backupRestore.pgEnvironment(
      'postgres://user:password@db.example.test/app?service=unexpected'
    )).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_DATABASE_URL_OPTION' }));
  });
});
