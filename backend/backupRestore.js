/**
 * Offline backup/restore primitives for Postgres plus the two durable local
 * filesystem roots.
 *
 * This module deliberately does not try to create an online snapshot. The app
 * has no maintenance fence that every writer observes, so callers must first
 * stop web, worker, and R writers and provide the exact acknowledgement below.
 * Database credentials are passed to pg_dump/pg_restore through discrete libpq
 * PG* variables, never through process arguments or a shell.
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const BACKUP_FORMAT = 'scrna-seq-runtime-backup';
const MANIFEST_VERSION = 2;
const MANIFEST_FILE_NAME = 'backup-manifest.json';
const DATABASE_DUMP_FILE_NAME = 'database.dump';
const STORAGE_DIRECTORY_NAME = 'storage';
const VAULT_DIRECTORY_NAME = 'vault';
const OFFLINE_ACKNOWLEDGEMENT = 'I_CONFIRM_WRITES_ARE_STOPPED';
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SESSION_EPOCH_PATTERN = /^[0-9a-f]{32}$/;
const PORTABLE_SEGMENT_PATTERN = /^[A-Za-z0-9._@+-]+$/;
const WINDOWS_RESERVED_NAME_PATTERN = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i;

function backupError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requiredSessionEpoch(value, label = 'SESSION_EPOCH') {
  const epoch = typeof value === 'string' ? value.trim() : '';
  const obviousSequence = epoch.includes('0123456789abcdef') || epoch.includes('fedcba9876543210');
  let repeated = false;
  for (let period = 1; period <= Math.floor(epoch.length / 2); period += 1) {
    if (epoch.length % period === 0 && epoch === epoch.slice(0, period).repeat(epoch.length / period)) {
      repeated = true;
      break;
    }
  }
  if (!SESSION_EPOCH_PATTERN.test(epoch) || new Set(epoch).size < 8
      || /(.)\1{7}/.test(epoch) || obviousSequence || repeated) {
    throw backupError('SESSION_EPOCH_REQUIRED', `${label} must be a generated 32-character lowercase hexadecimal value.`);
  }
  return epoch;
}

function assertOfflineAcknowledgement(value) {
  if (value !== OFFLINE_ACKNOWLEDGEMENT) {
    throw backupError(
      'OFFLINE_ACKNOWLEDGEMENT_REQUIRED',
      `Refusing operation until all writers are stopped; acknowledge with ${OFFLINE_ACKNOWLEDGEMENT}.`
    );
  }
}

function comparisonPath(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function pathContains(parentPath, childPath) {
  const parent = comparisonPath(parentPath);
  const child = comparisonPath(childPath);
  const relative = path.relative(parent, child);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function pathsOverlap(first, second) {
  return pathContains(first, second) || pathContains(second, first);
}

function isFilesystemRoot(value) {
  const resolved = path.resolve(value);
  return resolved === path.parse(resolved).root;
}

function assertNotFilesystemRoot(value, label) {
  if (isFilesystemRoot(value)) {
    throw backupError('UNSAFE_ROOT', `${label} must not be a filesystem root.`);
  }
}

function assertNoLinkedAncestors(targetPath) {
  let cursor = path.resolve(targetPath);
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }

  while (true) {
    const entry = fs.lstatSync(cursor);
    if (entry.isSymbolicLink()) {
      throw backupError(
        'UNSAFE_LINKED_PATH',
        'Backup and restore paths cannot traverse a symbolic link, junction, or reparse point.'
      );
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
}

function assertOrdinaryDirectory(directory, label) {
  assertNoLinkedAncestors(directory);
  const entry = fs.lstatSync(directory);
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw backupError('UNSAFE_DIRECTORY', `${label} must be an ordinary directory.`);
  }
}

function assertPortableSegment(segment) {
  if (
    !PORTABLE_SEGMENT_PATTERN.test(segment) ||
    WINDOWS_RESERVED_NAME_PATTERN.test(segment) ||
    segment === '.' ||
    segment === '..' ||
    segment.endsWith('.') ||
    segment.endsWith(' ')
  ) {
    throw backupError('UNSAFE_BACKUP_PATH', 'A backup path contains a non-portable segment.');
  }
}

function requiredPathOption(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw backupError('REQUIRED_PATH_MISSING', `${label} is required.`);
  }
  return path.resolve(value);
}

function portableRelativePath(segments) {
  for (const segment of segments) assertPortableSegment(segment);
  return segments.join('/');
}

function comparePortablePaths(first, second) {
  if (first < second) return -1;
  if (first > second) return 1;
  return 0;
}

function resolvePortableRelativePath(root, relativePath) {
  if (
    typeof relativePath !== 'string' ||
    relativePath === '' ||
    relativePath.includes('\0') ||
    relativePath.includes('\\') ||
    relativePath.startsWith('/')
  ) {
    throw backupError('UNSAFE_BACKUP_PATH', 'A backup path must be a portable relative path.');
  }
  const segments = relativePath.split('/');
  if (segments.some((segment) => segment === '')) {
    throw backupError('UNSAFE_BACKUP_PATH', 'A backup path contains an empty segment.');
  }
  for (const segment of segments) assertPortableSegment(segment);
  const resolvedRoot = path.resolve(root);
  const candidate = path.resolve(resolvedRoot, ...segments);
  if (!pathContains(resolvedRoot, candidate) || candidate === resolvedRoot) {
    throw backupError('UNSAFE_BACKUP_PATH', 'A backup path escapes its root.');
  }
  return candidate;
}

async function hashRegularFile(filePath) {
  const before = await fs.promises.lstat(filePath);
  if (before.isSymbolicLink() || !before.isFile()) {
    throw backupError(
      'UNSAFE_BACKUP_ENTRY',
      'Backup roots may contain only ordinary directories and regular files.'
    );
  }

  const noFollow = Number.isInteger(fs.constants.O_NOFOLLOW) ? fs.constants.O_NOFOLLOW : 0;
  let handle;
  try {
    handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | noFollow);
  } catch (error) {
    if (error && (error.code === 'ELOOP' || error.code === 'EMLINK')) {
      throw backupError('UNSAFE_LINKED_PATH', 'Refusing to hash a linked backup entry.');
    }
    throw error;
  }

  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let position = 0;
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) {
      throw backupError('UNSAFE_BACKUP_ENTRY', 'Backup entry is not a regular file.');
    }
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== position || before.size !== position) {
      throw backupError('BACKUP_SOURCE_CHANGED', 'A durable file changed while it was being inventoried.');
    }
  } finally {
    await handle.close();
  }

  return { sizeBytes: position, sha256: hash.digest('hex') };
}

async function inventoryDirectory(root) {
  const resolvedRoot = path.resolve(root);
  assertNotFilesystemRoot(resolvedRoot, 'Inventory root');
  assertOrdinaryDirectory(resolvedRoot, 'Inventory root');
  const files = [];

  async function walk(directory, segments) {
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    entries.sort((first, second) => comparePortablePaths(first.name, second.name));
    for (const entry of entries) {
      assertPortableSegment(entry.name);
      const nextSegments = [...segments, entry.name];
      const absolutePath = path.join(directory, entry.name);
      const stat = await fs.promises.lstat(absolutePath);
      if (stat.isSymbolicLink()) {
        throw backupError(
          'UNSAFE_LINKED_PATH',
          'Backup roots cannot contain a symbolic link, junction, or reparse point.'
        );
      }
      if (stat.isDirectory()) {
        await walk(absolutePath, nextSegments);
      } else if (stat.isFile()) {
        const digest = await hashRegularFile(absolutePath);
        files.push({ path: portableRelativePath(nextSegments), ...digest });
      } else {
        throw backupError(
          'UNSAFE_BACKUP_ENTRY',
          'Backup roots may contain only ordinary directories and regular files.'
        );
      }
    }
  }

  await walk(resolvedRoot, []);
  files.sort((first, second) => comparePortablePaths(first.path, second.path));
  const caseFoldedPaths = new Set();
  for (const entry of files) {
    const folded = entry.path.toLowerCase();
    if (caseFoldedPaths.has(folded)) {
      throw backupError(
        'UNSAFE_BACKUP_PATH',
        'Backup paths must remain unique on case-insensitive filesystems.'
      );
    }
    caseFoldedPaths.add(folded);
  }
  return Object.freeze(files.map((entry) => Object.freeze({ ...entry })));
}

function summarizeInventory(directory, files) {
  const totalSizeBytes = files.reduce((sum, entry) => sum + entry.sizeBytes, 0);
  if (!Number.isSafeInteger(totalSizeBytes)) {
    throw backupError('BACKUP_TOO_LARGE', 'Backup inventory size exceeds the supported integer range.');
  }
  return {
    directory,
    fileCount: files.length,
    totalSizeBytes,
    files: files.map((entry) => ({ ...entry })),
  };
}

function inventoriesEqual(first, second) {
  if (!Array.isArray(first) || !Array.isArray(second) || first.length !== second.length) return false;
  return first.every((entry, index) => {
    const other = second[index];
    return entry.path === other.path &&
      entry.sizeBytes === other.sizeBytes &&
      entry.sha256 === other.sha256;
  });
}

function assertInventoriesEqual(expected, actual, label) {
  if (!inventoriesEqual(expected, actual)) {
    throw backupError('BACKUP_INTEGRITY_FAILED', `${label} does not match its exact backup inventory.`);
  }
}

async function copyInventory(sourceRoot, destinationRoot, inventory) {
  const source = path.resolve(sourceRoot);
  const destination = path.resolve(destinationRoot);
  if (pathsOverlap(source, destination)) {
    throw backupError('OVERLAPPING_PATHS', 'Backup copy source and destination must not overlap.');
  }
  await fs.promises.mkdir(destination, { recursive: false });
  assertOrdinaryDirectory(destination, 'Backup copy destination');

  for (const entry of inventory) {
    const sourcePath = resolvePortableRelativePath(source, entry.path);
    const destinationPath = resolvePortableRelativePath(destination, entry.path);
    const sourceEntry = await fs.promises.lstat(sourcePath);
    if (sourceEntry.isSymbolicLink() || !sourceEntry.isFile()) {
      throw backupError('UNSAFE_BACKUP_ENTRY', 'A backup source entry is no longer a regular file.');
    }
    await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true });
    await fs.promises.copyFile(sourcePath, destinationPath, fs.constants.COPYFILE_EXCL);
  }

  const copied = await inventoryDirectory(destination);
  assertInventoriesEqual(inventory, copied, 'Copied directory');
  return copied;
}

async function copyVerifiedFile(sourcePath, destinationPath, expected, label) {
  const sourceEntry = await fs.promises.lstat(sourcePath);
  if (sourceEntry.isSymbolicLink() || !sourceEntry.isFile()) {
    throw backupError('UNSAFE_BACKUP_ENTRY', `${label} is no longer a regular file.`);
  }
  await fs.promises.copyFile(sourcePath, destinationPath, fs.constants.COPYFILE_EXCL);
  const copied = await hashRegularFile(destinationPath);
  if (copied.sizeBytes !== expected.sizeBytes || copied.sha256 !== expected.sha256) {
    throw backupError('BACKUP_INTEGRITY_FAILED', `${label} changed before it could be sealed for restore.`);
  }
  await fs.promises.chmod(destinationPath, 0o400);
  return copied;
}

const DATABASE_URL_QUERY_TO_PG_ENV = Object.freeze({
  application_name: 'PGAPPNAME',
  channel_binding: 'PGCHANNELBINDING',
  connect_timeout: 'PGCONNECT_TIMEOUT',
  gssencmode: 'PGGSSENCMODE',
  options: 'PGOPTIONS',
  sslcert: 'PGSSLCERT',
  sslcrl: 'PGSSLCRL',
  sslcrldir: 'PGSSLCRLDIR',
  sslkey: 'PGSSLKEY',
  sslmode: 'PGSSLMODE',
  sslpassword: 'PGSSLPASSWORD',
  sslrootcert: 'PGSSLROOTCERT',
  target_session_attrs: 'PGTARGETSESSIONATTRS',
});

const PG_CONNECTION_ENV_NAMES = Object.freeze([
  'PGAPPNAME', 'PGCHANNELBINDING', 'PGCONNECT_TIMEOUT', 'PGDATABASE',
  'PGGSSENCMODE', 'PGHOST', 'PGHOSTADDR', 'PGOPTIONS', 'PGPASSWORD',
  'PGPORT', 'PGSERVICE', 'PGSERVICEFILE', 'PGSSLCERT', 'PGSSLCRL',
  'PGSSLCRLDIR', 'PGSSLKEY', 'PGSSLMODE', 'PGSSLPASSWORD',
  'PGSSLROOTCERT', 'PGTARGETSESSIONATTRS', 'PGUSER',
]);

function decodeUrlPart(value, label) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw backupError('INVALID_DATABASE_URL', `Database URL contains an invalid ${label}.`);
  }
}

function pgEnvironment(databaseUrl) {
  const env = { ...process.env };
  const connectionUrl = databaseUrl || (
    /^postgres(?:ql)?:\/\//i.test(String(process.env.PGDATABASE || ''))
      ? process.env.PGDATABASE
      : ''
  );
  if (!connectionUrl) return env;

  let parsed;
  try {
    parsed = new URL(String(connectionUrl));
  } catch {
    throw backupError('INVALID_DATABASE_URL', 'Database URL is invalid.');
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)
      || !parsed.hostname || !parsed.username
      || !parsed.pathname || parsed.pathname === '/') {
    throw backupError('INVALID_DATABASE_URL', 'Database URL must include a Postgres host, user, and database.');
  }

  // A URI in PGDATABASE is not expanded by pg_dump/pg_restore on all supported
  // libpq versions. Populate the documented discrete variables instead. Clear
  // inherited connection selectors first so PGSERVICE/PGHOSTADDR cannot redirect
  // the operation away from the reviewed DATABASE_URL target.
  for (const name of PG_CONNECTION_ENV_NAMES) delete env[name];
  env.PGHOST = parsed.hostname.replace(/^\[|\]$/g, '');
  env.PGPORT = parsed.port || '5432';
  env.PGUSER = decodeUrlPart(parsed.username, 'user');
  env.PGDATABASE = decodeUrlPart(parsed.pathname.slice(1), 'database name');
  if (parsed.password) env.PGPASSWORD = decodeUrlPart(parsed.password, 'password');

  for (const [name, value] of parsed.searchParams) {
    const envName = DATABASE_URL_QUERY_TO_PG_ENV[name.toLowerCase()];
    if (!envName) {
      throw backupError(
        'UNSUPPORTED_DATABASE_URL_OPTION',
        `Database URL option '${name}' is not supported by the backup tool.`
      );
    }
    env[envName] = value;
  }
  return env;
}

function runPgCommand(command, args, options = {}) {
  if (!Array.isArray(args) || args.some((value) => typeof value !== 'string')) {
    return Promise.reject(backupError('INVALID_PG_ARGUMENTS', 'Postgres tool arguments must be a string array.'));
  }
  const spawnImpl = options.spawnImpl || spawn;
  return new Promise((resolve, reject) => {
    let child;
    let stderr = '';
    let childEnv;
    try {
      childEnv = pgEnvironment(options.databaseUrl);
      child = spawnImpl(command, args, {
        env: childEnv,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
    } catch {
      reject(backupError('PG_TOOL_START_FAILED', `${path.basename(command)} could not be started.`));
      return;
    }

    // Drain and bound stderr so a verbose child cannot block. Operators need an
    // actionable local CLI error, but credentials and connection URIs must never
    // be echoed. Keep only the tail because Postgres puts the root cause last.
    if (child.stderr && typeof child.stderr.on === 'function') {
      child.stderr.on('data', (chunk) => {
        stderr = `${stderr}${chunk.toString('utf8')}`.slice(-8192);
      });
    }
    child.once('error', () => {
      reject(backupError('PG_TOOL_START_FAILED', `${path.basename(command)} could not be started.`));
    });
    child.once('close', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      const suffix = signal ? ` (signal ${signal})` : ` (exit ${code})`;
      let diagnostic = stderr.trim().slice(-2048);
      for (const secret of [options.databaseUrl, childEnv?.PGPASSWORD, childEnv?.PGSSLPASSWORD]) {
        if (secret) diagnostic = diagnostic.split(String(secret)).join('[redacted]');
      }
      diagnostic = diagnostic
        .replace(/postgres(?:ql)?:\/\/[^\s@]+@/gi, 'postgres://[redacted]@')
        .replace(/password\s*=\s*[^\s]+/gi, 'password=[redacted]');
      const detail = diagnostic ? ` ${diagnostic}` : '';
      reject(backupError('PG_TOOL_FAILED', `${path.basename(command)} failed${suffix}.${detail}`));
    });
  });
}

function assertPairwiseNonOverlapping(entries) {
  for (let first = 0; first < entries.length; first += 1) {
    for (let second = first + 1; second < entries.length; second += 1) {
      if (pathsOverlap(entries[first].path, entries[second].path)) {
        throw backupError(
          'OVERLAPPING_PATHS',
          `${entries[first].label} and ${entries[second].label} must not overlap.`
        );
      }
    }
  }
}

function assertExistingEmptyDirectoryOrMissing(directory, label) {
  const resolved = path.resolve(directory);
  assertNotFilesystemRoot(resolved, label);
  assertNoLinkedAncestors(resolved);
  const parent = path.dirname(resolved);
  if (!fs.existsSync(parent)) {
    throw backupError('RESTORE_PARENT_MISSING', `${label} parent must already exist.`);
  }
  assertOrdinaryDirectory(parent, `${label} parent`);
  if (!fs.existsSync(resolved)) return { path: resolved, existed: false };
  assertOrdinaryDirectory(resolved, label);
  if (fs.readdirSync(resolved).length !== 0) {
    throw backupError('RESTORE_ROOT_NOT_EMPTY', `${label} must be missing or empty.`);
  }
  return { path: resolved, existed: true };
}

function stagingSibling(target, purpose) {
  const parent = path.dirname(target);
  const name = `.${path.basename(target)}.${purpose}-${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
  return path.join(parent, name);
}

function assertDestinationAvailable(destination) {
  const resolved = path.resolve(destination);
  assertNotFilesystemRoot(resolved, 'Backup destination');
  assertNoLinkedAncestors(resolved);
  const parent = path.dirname(resolved);
  if (!fs.existsSync(parent)) {
    throw backupError('BACKUP_PARENT_MISSING', 'Backup destination parent must already exist.');
  }
  assertOrdinaryDirectory(parent, 'Backup destination parent');
  if (fs.existsSync(resolved)) {
    throw backupError('BACKUP_DESTINATION_EXISTS', 'Backup destination must not already exist.');
  }
  return resolved;
}

async function createBackup(options = {}) {
  assertOfflineAcknowledgement(options.offlineAcknowledgement);
  const sessionEpoch = requiredSessionEpoch(options.sessionEpoch);
  const storageRoot = requiredPathOption(options.storageRoot, 'STORAGE_ROOT');
  const vaultRoot = requiredPathOption(options.vaultRoot, 'VAULT_ROOT');
  const destination = assertDestinationAvailable(
    requiredPathOption(options.destination, 'Backup destination')
  );
  assertNotFilesystemRoot(storageRoot, 'STORAGE_ROOT');
  assertNotFilesystemRoot(vaultRoot, 'VAULT_ROOT');
  assertPairwiseNonOverlapping([
    { label: 'STORAGE_ROOT', path: storageRoot },
    { label: 'VAULT_ROOT', path: vaultRoot },
    { label: 'backup destination', path: destination },
  ]);
  assertOrdinaryDirectory(storageRoot, 'STORAGE_ROOT');
  assertOrdinaryDirectory(vaultRoot, 'VAULT_ROOT');

  // Inventory before creating any output. With the required quiescence this is
  // the exact point-in-time filesystem state paired with the following dump.
  const storageFiles = await inventoryDirectory(storageRoot);
  const vaultFiles = await inventoryDirectory(vaultRoot);
  const stage = stagingSibling(destination, 'backup-partial');
  let stageCreated = false;
  try {
    await fs.promises.mkdir(stage, { recursive: false });
    stageCreated = true;
    const storageDestination = path.join(stage, STORAGE_DIRECTORY_NAME);
    const vaultDestination = path.join(stage, VAULT_DIRECTORY_NAME);
    await copyInventory(storageRoot, storageDestination, storageFiles);
    await copyInventory(vaultRoot, vaultDestination, vaultFiles);

    const dumpPath = path.join(stage, DATABASE_DUMP_FILE_NAME);
    await runPgCommand(
      options.pgDumpPath || 'pg_dump',
      [
        '--format=custom',
        '--no-owner',
        '--no-privileges',
        '--no-password',
        '--file',
        dumpPath,
      ],
      { databaseUrl: options.databaseUrl, spawnImpl: options.spawnImpl }
    );
    const dump = await hashRegularFile(dumpPath);
    const manifest = {
      format: BACKUP_FORMAT,
      version: MANIFEST_VERSION,
      createdAt: options.createdAt || new Date().toISOString(),
      consistency: {
        mode: 'offline-quiesced',
        writersStoppedAcknowledged: true,
      },
      authentication: {
        sessionEpoch,
      },
      database: {
        format: 'postgres-custom',
        file: DATABASE_DUMP_FILE_NAME,
        ...dump,
      },
      roots: {
        storage: summarizeInventory(STORAGE_DIRECTORY_NAME, storageFiles),
        vault: summarizeInventory(VAULT_DIRECTORY_NAME, vaultFiles),
      },
    };
    await fs.promises.writeFile(
      path.join(stage, MANIFEST_FILE_NAME),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { encoding: 'utf8', flag: 'wx' }
    );

    // Validate the finished package before exposing it under its final name.
    await validateBackupPackage(stage);
    if (fs.existsSync(destination)) {
      throw backupError('BACKUP_DESTINATION_EXISTS', 'Backup destination appeared during backup.');
    }
    await fs.promises.rename(stage, destination);
    stageCreated = false;
    return { destination, manifest };
  } finally {
    if (stageCreated) {
      await fs.promises.rm(stage, { recursive: true, force: true });
    }
  }
}

function assertExactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw backupError('INVALID_BACKUP_MANIFEST', `${label} must be an object.`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw backupError('INVALID_BACKUP_MANIFEST', `${label} has unexpected or missing fields.`);
  }
}

function validateInventoryManifest(value, expectedDirectory, label) {
  assertExactKeys(value, ['directory', 'fileCount', 'totalSizeBytes', 'files'], label);
  if (value.directory !== expectedDirectory) {
    throw backupError('INVALID_BACKUP_MANIFEST', `${label} has an invalid directory.`);
  }
  if (!Number.isSafeInteger(value.fileCount) || value.fileCount < 0) {
    throw backupError('INVALID_BACKUP_MANIFEST', `${label} has an invalid file count.`);
  }
  if (!Number.isSafeInteger(value.totalSizeBytes) || value.totalSizeBytes < 0) {
    throw backupError('INVALID_BACKUP_MANIFEST', `${label} has an invalid total size.`);
  }
  if (!Array.isArray(value.files) || value.files.length !== value.fileCount) {
    throw backupError('INVALID_BACKUP_MANIFEST', `${label} file list does not match its count.`);
  }

  let prior = null;
  const caseFoldedPaths = new Set();
  let total = 0;
  for (const file of value.files) {
    assertExactKeys(file, ['path', 'sizeBytes', 'sha256'], `${label} file`);
    resolvePortableRelativePath(path.parse(path.resolve('manifest-root')).root, file.path);
    if (prior !== null && comparePortablePaths(prior, file.path) >= 0) {
      throw backupError('INVALID_BACKUP_MANIFEST', `${label} paths must be unique and sorted.`);
    }
    const folded = file.path.toLowerCase();
    if (caseFoldedPaths.has(folded)) {
      throw backupError('INVALID_BACKUP_MANIFEST', `${label} paths are not portable across filesystems.`);
    }
    caseFoldedPaths.add(folded);
    if (!Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 0 || !SHA256_PATTERN.test(file.sha256)) {
      throw backupError('INVALID_BACKUP_MANIFEST', `${label} contains invalid file integrity metadata.`);
    }
    total += file.sizeBytes;
    if (!Number.isSafeInteger(total)) {
      throw backupError('INVALID_BACKUP_MANIFEST', `${label} total size exceeds the supported range.`);
    }
    prior = file.path;
  }
  if (total !== value.totalSizeBytes) {
    throw backupError('INVALID_BACKUP_MANIFEST', `${label} total size does not match its files.`);
  }
  return value.files.map((file) => ({ ...file }));
}

function validateManifestShape(manifest) {
  assertExactKeys(
    manifest,
    ['format', 'version', 'createdAt', 'consistency', 'authentication', 'database', 'roots'],
    'Backup manifest'
  );
  if (manifest.format !== BACKUP_FORMAT || manifest.version !== MANIFEST_VERSION) {
    throw backupError('INVALID_BACKUP_MANIFEST', 'Unsupported backup manifest format or version.');
  }
  if (typeof manifest.createdAt !== 'string' || !Number.isFinite(Date.parse(manifest.createdAt))) {
    throw backupError('INVALID_BACKUP_MANIFEST', 'Backup manifest has an invalid creation time.');
  }
  assertExactKeys(manifest.consistency, ['mode', 'writersStoppedAcknowledged'], 'Consistency metadata');
  if (
    manifest.consistency.mode !== 'offline-quiesced' ||
    manifest.consistency.writersStoppedAcknowledged !== true
  ) {
    throw backupError('INVALID_BACKUP_MANIFEST', 'Backup was not recorded as an offline quiesced snapshot.');
  }
  assertExactKeys(manifest.authentication, ['sessionEpoch'], 'Authentication metadata');
  requiredSessionEpoch(manifest.authentication.sessionEpoch, 'Backup session epoch');
  assertExactKeys(manifest.database, ['format', 'file', 'sizeBytes', 'sha256'], 'Database metadata');
  if (
    manifest.database.format !== 'postgres-custom' ||
    manifest.database.file !== DATABASE_DUMP_FILE_NAME ||
    !Number.isSafeInteger(manifest.database.sizeBytes) ||
    manifest.database.sizeBytes < 0 ||
    !SHA256_PATTERN.test(manifest.database.sha256)
  ) {
    throw backupError('INVALID_BACKUP_MANIFEST', 'Database integrity metadata is invalid.');
  }
  assertExactKeys(manifest.roots, ['storage', 'vault'], 'Root metadata');
  const storageFiles = validateInventoryManifest(
    manifest.roots.storage,
    STORAGE_DIRECTORY_NAME,
    'STORAGE_ROOT inventory'
  );
  const vaultFiles = validateInventoryManifest(
    manifest.roots.vault,
    VAULT_DIRECTORY_NAME,
    'VAULT_ROOT inventory'
  );
  return { storageFiles, vaultFiles };
}

async function validateBackupPackage(backupDirectory) {
  const root = requiredPathOption(backupDirectory, 'Backup directory');
  assertNotFilesystemRoot(root, 'Backup directory');
  assertOrdinaryDirectory(root, 'Backup directory');
  const topLevel = await fs.promises.readdir(root);
  topLevel.sort();
  const expectedTopLevel = [
    DATABASE_DUMP_FILE_NAME,
    MANIFEST_FILE_NAME,
    STORAGE_DIRECTORY_NAME,
    VAULT_DIRECTORY_NAME,
  ].sort();
  if (
    topLevel.length !== expectedTopLevel.length ||
    topLevel.some((name, index) => name !== expectedTopLevel[index])
  ) {
    throw backupError('INVALID_BACKUP_PACKAGE', 'Backup package contains unexpected or missing top-level entries.');
  }

  const manifestPath = path.join(root, MANIFEST_FILE_NAME);
  const manifestEntry = await fs.promises.lstat(manifestPath);
  if (manifestEntry.isSymbolicLink() || !manifestEntry.isFile() || manifestEntry.size > MAX_MANIFEST_BYTES) {
    throw backupError('INVALID_BACKUP_MANIFEST', 'Backup manifest is missing, linked, or too large.');
  }
  let manifest;
  try {
    manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
  } catch {
    throw backupError('INVALID_BACKUP_MANIFEST', 'Backup manifest is not valid JSON.');
  }
  const expected = validateManifestShape(manifest);

  const dumpPath = path.join(root, DATABASE_DUMP_FILE_NAME);
  const dump = await hashRegularFile(dumpPath);
  if (dump.sizeBytes !== manifest.database.sizeBytes || dump.sha256 !== manifest.database.sha256) {
    throw backupError('BACKUP_INTEGRITY_FAILED', 'Database dump does not match the backup manifest.');
  }
  const storageFiles = await inventoryDirectory(path.join(root, STORAGE_DIRECTORY_NAME));
  const vaultFiles = await inventoryDirectory(path.join(root, VAULT_DIRECTORY_NAME));
  assertInventoriesEqual(expected.storageFiles, storageFiles, 'STORAGE_ROOT backup');
  assertInventoriesEqual(expected.vaultFiles, vaultFiles, 'VAULT_ROOT backup');
  return { backupDirectory: root, manifest, storageFiles, vaultFiles };
}

async function assertDirectoryMatchesInventory(directory, expected, label = 'Restored directory') {
  const actual = await inventoryDirectory(directory);
  assertInventoriesEqual(expected, actual, label);
  return actual;
}

async function restoreBackup(options = {}) {
  assertOfflineAcknowledgement(options.offlineAcknowledgement);

  // Package validation, target-path validation, and the database emptiness check
  // all complete before we create staging directories or invoke pg_restore.
  const validated = await validateBackupPackage(options.backupDirectory);
  const candidateSessionEpoch = requiredSessionEpoch(options.sessionEpoch, 'Candidate SESSION_EPOCH');
  if (candidateSessionEpoch === validated.manifest.authentication.sessionEpoch) {
    throw backupError(
      'RESTORE_SESSION_EPOCH_REUSE',
      'Restore requires a new SESSION_EPOCH so no pre-restore browser session can become valid again.'
    );
  }
  const storageTarget = assertExistingEmptyDirectoryOrMissing(
    requiredPathOption(options.storageRoot, 'restored STORAGE_ROOT'),
    'restored STORAGE_ROOT'
  );
  const vaultTarget = assertExistingEmptyDirectoryOrMissing(
    requiredPathOption(options.vaultRoot, 'restored VAULT_ROOT'),
    'restored VAULT_ROOT'
  );
  assertPairwiseNonOverlapping([
    { label: 'backup directory', path: validated.backupDirectory },
    { label: 'restored STORAGE_ROOT', path: storageTarget.path },
    { label: 'restored VAULT_ROOT', path: vaultTarget.path },
  ]);
  if (typeof options.verifyDatabaseEmpty !== 'function') {
    throw backupError(
      'DATABASE_EMPTY_CHECK_REQUIRED',
      'Restore requires a database emptiness verifier and never uses --clean by default.'
    );
  }
  if (typeof options.finalizeRestoredSecurityState !== 'function') {
    throw backupError(
      'RESTORE_SECURITY_FINALIZER_REQUIRED',
      'Restore requires a fail-closed security-state finalizer.'
    );
  }
  const databaseEmpty = await options.verifyDatabaseEmpty(options.databaseUrl);
  if (databaseEmpty !== true) {
    throw backupError('RESTORE_DATABASE_NOT_EMPTY', 'Restore database must be empty.');
  }

  const storageStage = stagingSibling(storageTarget.path, 'restore-partial');
  const vaultStage = stagingSibling(vaultTarget.path, 'restore-partial');
  const databaseStage = stagingSibling(storageTarget.path, 'database-restore');
  let storageStaged = false;
  let vaultStaged = false;
  let databaseStaged = false;
  let storagePromoted = false;
  let vaultPromoted = false;
  const promoteDirectory = options.promoteDirectory || (async (stage, target, existed) => {
    // Empty existing roots are removed non-recursively immediately before the
    // same-filesystem rename. A concurrent writer makes rmdir fail closed.
    if (existed) await fs.promises.rmdir(target);
    await fs.promises.rename(stage, target);
  });
  try {
    await copyInventory(
      path.join(validated.backupDirectory, STORAGE_DIRECTORY_NAME),
      storageStage,
      validated.storageFiles
    );
    storageStaged = true;
    await copyInventory(
      path.join(validated.backupDirectory, VAULT_DIRECTORY_NAME),
      vaultStage,
      validated.vaultFiles
    );
    vaultStaged = true;

    // Seal the exact already-validated dump into a private writable-volume
    // sibling. pg_restore never reads the operator bind directly, closing the
    // validation/use race if that bind changes after package validation.
    databaseStaged = true;
    await copyVerifiedFile(
      path.join(validated.backupDirectory, DATABASE_DUMP_FILE_NAME),
      databaseStage,
      validated.manifest.database,
      'Database dump'
    );

    // Publish and re-inventory both filesystem roots before mutating Postgres.
    // Cross-resource atomicity is impossible; this ordering ensures a file
    // promotion failure cannot leave a committed database pointing at missing
    // roots. Any later failure invalidates the whole isolated candidate.
    await promoteDirectory(storageStage, storageTarget.path, storageTarget.existed);
    storageStaged = false;
    storagePromoted = true;
    await promoteDirectory(vaultStage, vaultTarget.path, vaultTarget.existed);
    vaultStaged = false;
    vaultPromoted = true;
    await assertDirectoryMatchesInventory(storageTarget.path, validated.storageFiles, 'Restored STORAGE_ROOT');
    await assertDirectoryMatchesInventory(vaultTarget.path, validated.vaultFiles, 'Restored VAULT_ROOT');

    // The first check prevents needless file work. Recheck at the final
    // restore boundary so an object created during staging cannot be silently
    // merged with the recovered database. The supported runbook also keeps all
    // other clients stopped; PostgreSQL has no global DDL mutex for strangers.
    const databaseStillEmpty = await options.verifyDatabaseEmpty(options.databaseUrl);
    if (databaseStillEmpty !== true) {
      throw backupError('RESTORE_DATABASE_NOT_EMPTY', 'Restore database changed during staging and is no longer empty.');
    }

    const restoreEnvironment = pgEnvironment(options.databaseUrl);
    if (!restoreEnvironment.PGDATABASE) {
      throw backupError('DATABASE_NAME_REQUIRED', 'Restore requires a target Postgres database name.');
    }
    await runPgCommand(
      options.pgRestorePath || 'pg_restore',
      [
        '--dbname',
        restoreEnvironment.PGDATABASE,
        '--exit-on-error',
        '--single-transaction',
        '--no-owner',
        '--no-privileges',
        '--no-password',
        databaseStage,
      ],
      { databaseUrl: options.databaseUrl, spawnImpl: options.spawnImpl }
    );
    const securityState = await options.finalizeRestoredSecurityState(options.databaseUrl);
    if (!securityState || !Number.isSafeInteger(securityState.canceledJobs) || securityState.canceledJobs < 0) {
      throw backupError('RESTORE_SECURITY_FINALIZATION_FAILED', 'Restore security-state finalization returned an invalid result.');
    }
    return {
      manifest: validated.manifest,
      storageRoot: storageTarget.path,
      vaultRoot: vaultTarget.path,
      securityState,
    };
  } catch (error) {
    if (storagePromoted || vaultPromoted) {
      const causeCode = error && typeof error.code === 'string'
        ? error.code.replace(/[^A-Z0-9_]/gi, '').slice(0, 64)
        : 'RESTORE_STEP_FAILED';
      throw backupError(
        'RESTORE_CANDIDATE_INVALID',
        `Restore did not complete (${causeCode || 'RESTORE_STEP_FAILED'}); discard the isolated database and both restored roots before retrying.`
      );
    }
    throw error;
  } finally {
    if (storageStaged) await fs.promises.rm(storageStage, { recursive: true, force: true });
    if (vaultStaged) await fs.promises.rm(vaultStage, { recursive: true, force: true });
    if (databaseStaged) await fs.promises.rm(databaseStage, { force: true });
  }
}

module.exports = {
  BACKUP_FORMAT,
  MANIFEST_VERSION,
  MANIFEST_FILE_NAME,
  DATABASE_DUMP_FILE_NAME,
  STORAGE_DIRECTORY_NAME,
  VAULT_DIRECTORY_NAME,
  OFFLINE_ACKNOWLEDGEMENT,
  assertOfflineAcknowledgement,
  requiredSessionEpoch,
  pathsOverlap,
  resolvePortableRelativePath,
  inventoryDirectory,
  assertDirectoryMatchesInventory,
  pgEnvironment,
  runPgCommand,
  createBackup,
  validateBackupPackage,
  restoreBackup,
};
