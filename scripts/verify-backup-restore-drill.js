#!/usr/bin/env node

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Client } = require('pg');
const config = require('../backend/config');
const { environmentBytes, summarizeEnvironmentManifest } = require('../backend/rEnvironment');
const { journalRecord } = require('../backend/liveExecutionJournal');
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
  // These records exercise backup fidelity; their synthetic inventory does not
  // claim that a scientific runtime executed the fixture.
  const environment = {
    schema: 'traceomics.r-environment.v1', profileId: 'scrna-r-4.5-bioconductor-3.22-v1',
    runtime: { imageReference: `sha256:${'a'.repeat(64)}`, imageDigest: `sha256:${'a'.repeat(64)}`, imageId: `sha256:${'a'.repeat(64)}`,
      os: 'linux', architecture: 'amd64', distribution: { id: 'ubuntu', version: '24.04' }, snapshotScope: 'container-userspace', kernel: 'worker-host' },
    r: { version: '4.5.3', platform: 'x86_64-pc-linux-gnu', bioconductor: '3.22' },
    packages: [{ name: 'base', version: '4.5.3', built: '4.5.3', priority: 'base', source: { kind: 'r-distribution' } }],
    systemPackages: [{ name: 'libc6', version: '2.39-0ubuntu8.6', architecture: 'amd64' }],
    lock: { format: 'installed-package-inventory.v1', sourceArchivesIncluded: false },
  };
  const environmentReference = summarizeEnvironmentManifest(environment);
  const manifestBytes = environmentBytes(environment);
  const environmentKey = 'projects/proj_restore/artifacts/job_restore_r/environment.json';
  const script = 'print(nrow(obj))\n';
  const liveEntry = journalRecord({ provenance: { language: 'R', script, operation: 'normalize', languageVersion: '4.5.3',
    timestamp: '2026-10-08T00:00:00Z', parameters: { method: 'LogNormalize' },
    execution: { generation: 'b'.repeat(64), order: 1, packages: [{ name: 'Seurat', version: '5.3.0' }] } },
    live_state: { live_revision: 1 } });
  for (const [key, bytes] of [[datasetKey, datasetBytes], [artifactKey, artifactBytes], [managedKey, artifactBytes], [environmentKey, manifestBytes]]) {
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
    await client.query(
      `INSERT INTO analysis_objects (id, owner_user_id, project_id, dataset_id, object_type, display_name)
       VALUES ('ao_restore', $1, 'proj_restore', 'ds_restore', 'seurat', 'Restore fixture')`, [userId]
    );
    await client.query(
      `INSERT INTO jobs (id, owner_user_id, project_id, analysis_object_id, job_type, status, parameters_json)
       VALUES ('job_restore_r', $1, 'proj_restore', 'ao_restore', 'expert.r.v1', 'queued', $2)`,
      [userId, JSON.stringify({ script, scriptSha256: sha256(script), profileId: environment.profileId, environment: environmentReference })]
    );
    await client.query(
      `INSERT INTO execution_source_versions (id, project_id, owner_user_id, job_id, language, source_code, source_sha256)
       VALUES ('src_job_restore_r', 'proj_restore', $1, 'job_restore_r', 'R', $2, $3)`, [userId, script, sha256(script)]
    );
    await client.query("UPDATE jobs SET status='completed' WHERE id='job_restore_r'");
    await client.query(
      `INSERT INTO job_artifacts (id, project_id, job_id, analysis_object_id, created_by_user_id, artifact_type,
         name, storage_kind, storage_uri, checksum_sha256, size_bytes, status, metadata_json)
       VALUES ('art_restore_environment', 'proj_restore', 'job_restore_r', 'ao_restore', $1,
         'expert_r_environment', 'environment.json', 'local_internal', $2, $3, $4, 'available', $5)`,
      [userId, environmentKey, sha256(manifestBytes), manifestBytes.length, JSON.stringify({ environment: environmentReference })]
    );
    await client.query(
      `INSERT INTO live_execution_records (id, project_id, owner_user_id, analysis_object_id, operation,
         kernel_generation, kernel_order, live_revision, source_sha256, record_json)
       VALUES ('lex_restore', 'proj_restore', $1, 'ao_restore', $2, $3, $4, $5, $6, $7::jsonb)`,
      [userId, liveEntry.operation, liveEntry.generation, liveEntry.order, liveEntry.liveRevision, liveEntry.sourceSha256, JSON.stringify(liveEntry.record)]
    );
    const kernelId='pk_'+ 'd'.repeat(24),completedId='pex_'+ 'e'.repeat(24),runningId='pex_'+ 'f'.repeat(24),kernelGeneration='c'.repeat(64);
    await client.query(`INSERT INTO private_r_kernels(id,project_id,owner_user_id,workspace_id,request_id,start_sha256,status,runtime_generation,environment_json,environment_manifest_json,inputs_json,next_order,active_execution_id,started_at,expires_at) VALUES($1,'proj_restore',$2,'restore_workspace','11111111-1111-4111-8111-111111111111',$3,'running',$4,$5,$6,'[]',2,$7,NOW(),NOW()+INTERVAL '4 hours')`,[kernelId,userId,sha256('restore kernel fixture'),kernelGeneration,environmentReference,environment,runningId]);
    const preview={ok:true,kernelId,generation:kernelGeneration,executionId:completedId,order:1,status:'completed',stdout:'[1] 3\n',warnings:[],error:null,tables:[],figures:[],truncated:false,startedAt:'2026-10-08T00:00:00.000Z',completedAt:'2026-10-08T00:00:01.000Z'};
    await client.query(`INSERT INTO private_r_executions(id,kernel_id,project_id,owner_user_id,request_id,kernel_generation,execution_order,status,source_code,source_sha256,result_json,started_at,completed_at) VALUES($1,$2,'proj_restore',$3,'22222222-2222-4222-8222-222222222222',$4,1,'completed','n <- 3',$5,$6,NOW(),NOW())`,[completedId,kernelId,userId,kernelGeneration,sha256('n <- 3'),preview]);
    await client.query(`INSERT INTO private_r_executions(id,kernel_id,project_id,owner_user_id,request_id,kernel_generation,execution_order,status,source_code,source_sha256,started_at) VALUES($1,$2,'proj_restore',$3,'33333333-3333-4333-8333-333333333333',$4,2,'running','n + 1',$5,NOW())`,[runningId,kernelId,userId,kernelGeneration,sha256('n + 1')]);
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
    if(restored.securityState?.stoppedKernels!==1||restored.securityState?.unknownExecutions!==1)throw new Error('Restore did not invalidate volatile private R memory and pending command completion.');
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
