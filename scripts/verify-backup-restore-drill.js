#!/usr/bin/env node

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Client } = require('pg');
const config = require('../backend/config');
const {
  OFFLINE_ACKNOWLEDGEMENT,
  createBackup,
  restoreBackup,
} = require('../backend/backupRestore');
const { databaseIsEmpty, finalizeRestoredSecurityState } = require('./restore-runtime');

const DRILL_DATABASE_PREFIX = 'scrna_restore_drill_';
const SOURCE_SESSION_EPOCH = '4f8c2a6e1d9b3075c4e8a2f6d1b93570';
const RESTORE_SESSION_EPOCH = 'a7d31c8e5f209b64d2a84f1c7e3059b6';

function safeDatabaseIdentifier(value) {
  if (typeof value !== 'string' || !new RegExp(`^${DRILL_DATABASE_PREFIX}[a-z0-9_]+$`).test(value)) {
    throw new Error('Refusing to operate on a database outside the restore-drill namespace.');
  }
  return `"${value}"`;
}

function configuredDatabaseUrl() {
  if (config.databaseUrl()) return config.databaseUrl();
  const host = String(process.env.PGHOST || '').trim();
  const database = String(process.env.PGDATABASE || '').trim();
  const user = String(process.env.PGUSER || '').trim();
  if (!host || !database || !user) {
    throw new Error('Set DATABASE_URL or PGHOST, PGUSER, and PGDATABASE before running the restore drill.');
  }
  const url = new URL('postgres://localhost/');
  url.hostname = host;
  url.port = String(process.env.PGPORT || '5432');
  url.username = user;
  if (process.env.PGPASSWORD !== undefined) url.password = String(process.env.PGPASSWORD);
  url.pathname = `/${database}`;
  const sslMode = String(process.env.PGSSLMODE || '').trim();
  if (sslMode) url.searchParams.set('sslmode', sslMode);
  return url.toString();
}

function databaseUrlFor(baseUrl, databaseName) {
  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function createDrillDatabase(admin, databaseName) {
  await admin.query(`CREATE DATABASE ${safeDatabaseIdentifier(databaseName)}`);
}

async function dropDrillDatabase(admin, databaseName) {
  safeDatabaseIdentifier(databaseName);
  await admin.query(
    `SELECT pg_terminate_backend(pid)
       FROM pg_stat_activity
      WHERE datname = $1 AND pid <> pg_backend_pid()`,
    [databaseName]
  );
  await admin.query(`DROP DATABASE IF EXISTS ${safeDatabaseIdentifier(databaseName)}`);
}

async function initializeSourceDatabase(databaseUrl, storageRoot) {
  const schema = await fs.promises.readFile(path.join(__dirname, '..', 'backend', 'pg', 'schema.sql'), 'utf8');
  const datasetKey = 'projects/proj_restore/datasets/ds_restore/matrix.h5';
  const artifactKey = 'projects/proj_restore/artifacts/job_restore/result.csv';
  const managedVersionId = 'av_0123456789abcdef01234567';
  const managedKey = `projects/proj_restore/artifacts/${managedVersionId}/content.csv`;
  const datasetBytes = Buffer.from('restore-drill-dataset\n');
  const artifactBytes = Buffer.from('gene,score\nMS4A1,1.5\n');
  for (const [key, bytes] of [[datasetKey, datasetBytes], [artifactKey, artifactBytes], [managedKey, artifactBytes]]) {
    const file = path.join(storageRoot, ...key.split('/'));
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, bytes, { flag: 'wx' });
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(schema);
    await client.query('BEGIN');
    const user = await client.query(
      `INSERT INTO users (email, password_hash, salt, display_name)
       VALUES ('restore-drill@example.invalid', 'not-a-login-hash', 'not-a-login-salt', 'Restore Drill')
       RETURNING id`
    );
    const userId = user.rows[0].id;
    await client.query(
      `INSERT INTO organizations (id, name, owner_user_id)
       VALUES ('org_restore', 'Restore Drill', $1)`,
      [userId]
    );
    await client.query(
      `INSERT INTO organization_members (organization_id, user_id, role)
       VALUES ('org_restore', $1, 'owner')`,
      [userId]
    );
    await client.query(
      `INSERT INTO projects (id, organization_id, name, created_by_user_id)
       VALUES ('proj_restore', 'org_restore', 'Restore Drill', $1)`,
      [userId]
    );
    await client.query(
      `INSERT INTO project_members (project_id, user_id, role)
       VALUES ('proj_restore', $1, 'owner')`,
      [userId]
    );
    await client.query(
      `INSERT INTO datasets
         (id, project_id, owner_user_id, created_by_user_id, original_filename,
          internal_storage_key, file_type, file_size_bytes, sha256,
          upload_status, validation_status, metadata)
       VALUES ('ds_restore', 'proj_restore', $1, $1, 'matrix.h5', $2, 'tenx_h5',
               $3, $4, 'uploaded', 'valid', '{}')`,
      [userId, datasetKey, datasetBytes.length, sha256(datasetBytes)]
    );
    await client.query(
      `INSERT INTO jobs
         (id, owner_user_id, project_id, dataset_id, job_type, status,
          parameters_json, logs_json)
       VALUES ('job_restore', $1, 'proj_restore', 'ds_restore',
               'deg.find_markers.v1', 'completed', '{}', '[]')`,
      [userId]
    );
    await client.query(
      `INSERT INTO jobs
         (id, owner_user_id, project_id, dataset_id, job_type, status,
          parameters_json, logs_json)
       VALUES ('job_restore_queued', $1, 'proj_restore', 'ds_restore',
               'deg.find_markers.v1', 'queued', '{}', '[]')`,
      [userId]
    );
    await client.query(
      `INSERT INTO jobs
         (id, owner_user_id, project_id, dataset_id, job_type, status,
          parameters_json, logs_json, started_at, worker_id, claim_token,
          lease_expires_at, heartbeat_at, locked_at, attempts)
       VALUES ('job_restore_running', $1, 'proj_restore', 'ds_restore',
               'deg.find_markers.v1', 'running', '{}', '[]', now(),
               'restore-drill-worker', 'restore-drill-claim', now() + interval '5 minutes',
               now(), now(), 1)`,
      [userId]
    );
    await client.query(
      `INSERT INTO job_artifacts
         (id, project_id, job_id, dataset_id, created_by_user_id, artifact_type,
          name, storage_kind, storage_uri, checksum_sha256, size_bytes, status)
       VALUES ('art_restore', 'proj_restore', 'job_restore', 'ds_restore', $1,
               'deg_markers', 'result.csv', 'local_internal', $2, $3, $4, 'available')`,
      [userId, artifactKey, sha256(artifactBytes), artifactBytes.length]
    );
    await client.query(
      `INSERT INTO managed_artifact_versions
         (id, artifact_id, project_id, owner_user_id, name, version_number,
          artifact_type, format_json, mime_type, checksum_sha256, size_bytes,
          storage_key, source_job_id)
       VALUES ($1, 'af_0123456789abcdef01234567', 'proj_restore', $2,
               'Saved marker table', 1, 'table',
               '{"id":"org.ietf.csv","version":"1"}', 'text/csv',
               $3, $4, $5, 'job_restore')`,
      [managedVersionId, userId, sha256(artifactBytes), artifactBytes.length, managedKey]
    );
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* original error wins */ }
    throw error;
  } finally {
    await client.end();
  }
}

function runVerifier({ databaseUrl, sourceDatabaseUrl, backupDirectory, storageRoot, vaultRoot }) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        path.join(__dirname, 'verify-backup-restore.js'),
        '--backup', backupDirectory,
        '--storage-root', storageRoot,
        '--vault-root', vaultRoot,
      ],
      {
        env: {
          ...process.env,
          DATABASE_URL: databaseUrl,
          SOURCE_DATABASE_URL: sourceDatabaseUrl,
          STORAGE_ROOT: storageRoot,
          VAULT_ROOT: vaultRoot,
        },
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    // Drain diagnostics without echoing connection metadata from dependencies.
    child.stderr.resume();
    child.once('error', () => reject(new Error('The post-restore verifier could not start.')));
    child.once('close', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`The post-restore verifier failed (exit ${code}).`));
    });
  });
}

async function main() {
  const baseUrl = configuredDatabaseUrl();
  const suffix = `${process.pid}_${crypto.randomBytes(5).toString('hex')}`;
  const sourceName = `${DRILL_DATABASE_PREFIX}source_${suffix}`;
  const targetName = `${DRILL_DATABASE_PREFIX}target_${suffix}`;
  const adminUrl = databaseUrlFor(baseUrl, 'postgres');
  const sourceUrl = databaseUrlFor(baseUrl, sourceName);
  const targetUrl = databaseUrlFor(baseUrl, targetName);
  const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'scrna-restore-drill-'));
  const sourceStorage = path.join(temp, 'source-storage');
  const sourceVault = path.join(temp, 'source-vault');
  const restoredStorage = path.join(temp, 'restored-storage');
  const restoredVault = path.join(temp, 'restored-vault');
  const backupDirectory = path.join(temp, 'backup-package');
  await fs.promises.mkdir(sourceStorage);
  await fs.promises.mkdir(sourceVault);
  await fs.promises.writeFile(path.join(sourceVault, 'private-state-marker.txt'), 'private-state\n', { flag: 'wx' });

  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  let sourceCreated = false;
  let targetCreated = false;
  try {
    await createDrillDatabase(admin, sourceName);
    sourceCreated = true;
    await createDrillDatabase(admin, targetName);
    targetCreated = true;
    await initializeSourceDatabase(sourceUrl, sourceStorage);

    await createBackup({
      destination: backupDirectory,
      storageRoot: sourceStorage,
      vaultRoot: sourceVault,
      databaseUrl: sourceUrl,
      sessionEpoch: SOURCE_SESSION_EPOCH,
      offlineAcknowledgement: OFFLINE_ACKNOWLEDGEMENT,
      pgDumpPath: process.env.PG_DUMP_PATH || 'pg_dump',
    });
    const restored = await restoreBackup({
      backupDirectory,
      storageRoot: restoredStorage,
      vaultRoot: restoredVault,
      databaseUrl: targetUrl,
      sessionEpoch: RESTORE_SESSION_EPOCH,
      offlineAcknowledgement: OFFLINE_ACKNOWLEDGEMENT,
      pgRestorePath: process.env.PG_RESTORE_PATH || 'pg_restore',
      verifyDatabaseEmpty: () => databaseIsEmpty({ connectionString: targetUrl }),
      finalizeRestoredSecurityState: () => finalizeRestoredSecurityState({ connectionString: targetUrl }),
    });
    if (restored.securityState?.canceledJobs !== 2) {
      throw new Error('Restore did not cancel both queued/running drill jobs.');
    }
    const verification = await runVerifier({
      databaseUrl: targetUrl,
      sourceDatabaseUrl: sourceUrl,
      backupDirectory,
      storageRoot: restoredStorage,
      vaultRoot: restoredVault,
    });
    console.log('[restore-drill] passed: real pg_dump, pg_restore, exact files, references, security finalization, and table fingerprints');
    if (verification) console.log(verification);
  } finally {
    if (targetCreated) await dropDrillDatabase(admin, targetName);
    if (sourceCreated) await dropDrillDatabase(admin, sourceName);
    await admin.end();
    await fs.promises.rm(temp, { recursive: true, force: true });
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[restore-drill] failed:', error && error.message ? error.message : 'unknown error');
    process.exitCode = 1;
  });
}

module.exports = {
  configuredDatabaseUrl,
  databaseUrlFor,
  main,
  safeDatabaseIdentifier,
};
