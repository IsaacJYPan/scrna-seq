#!/usr/bin/env node
/**
 * Read-only post-restore verification.
 *
 * This is intended to run against an isolated database and the two restored
 * roots after restore-runtime.js. It validates the package again, compares the
 * restored bytes to both exact inventories, and checks every current durable
 * database reference. If SOURCE_DATABASE_URL is set, it additionally compares
 * a deterministic row fingerprint of every public table with the source DB.
 */

'use strict';

const crypto = require('crypto');
const path = require('path');
const { Client } = require('pg');
const config = require('../backend/config');
const {
  assertDirectoryMatchesInventory,
  resolvePortableRelativePath,
  validateBackupPackage,
} = require('../backend/backupRestore');

function usage() {
  return [
    'Usage:',
    '  node scripts/verify-backup-restore.js --backup <backup-directory>',
    '    [--storage-root <restored-directory>] [--vault-root <restored-directory>]',
    '',
    'DATABASE_URL or PG* identifies the restored database.',
    'Optional SOURCE_DATABASE_URL enables a source/restored public-table fingerprint comparison.',
  ].join('\n');
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}.`);
    if (arg === '--backup') parsed.backupDirectory = value;
    else if (arg === '--storage-root') parsed.storageRoot = value;
    else if (arg === '--vault-root') parsed.vaultRoot = value;
    else throw new Error(`Unknown argument: ${arg}`);
    index += 1;
  }
  return parsed;
}

function normalizedDatabaseSize(value, label) {
  if (value === null || value === undefined) return null;
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error(`${label} has invalid size metadata.`);
  }
  return size;
}

function assertDatabaseReference(inventoryByPath, reference) {
  // This validates portability/traversal independently of whether the path is
  // present in the inventory. The synthetic root is never accessed.
  resolvePortableRelativePath(path.parse(path.resolve('verification-root')).root, reference.key);
  const file = inventoryByPath.get(reference.key);
  if (!file) throw new Error(`${reference.label} points to a file absent from the restored inventory.`);
  const expectedSize = normalizedDatabaseSize(reference.sizeBytes, reference.label);
  if (expectedSize !== null && expectedSize !== file.sizeBytes) {
    throw new Error(`${reference.label} size does not match the restored inventory.`);
  }
  if (reference.sha256 !== null && reference.sha256 !== undefined) {
    const expectedHash = String(reference.sha256).toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(expectedHash) || expectedHash !== file.sha256) {
      throw new Error(`${reference.label} checksum does not match the restored inventory.`);
    }
  }
}

async function verifyDurableDatabaseReferences(client, storageFiles) {
  const inventoryByPath = new Map(storageFiles.map((file) => [file.path, file]));
  const datasets = await client.query(`
    SELECT id, internal_storage_key, storage_uri, file_size_bytes, sha256
      FROM datasets
     WHERE upload_status = 'uploaded'
       AND (internal_storage_key IS NOT NULL OR storage_uri IS NOT NULL)
     ORDER BY id
  `);
  let checkedDatasets = 0;
  let legacyDatasetReferences = 0;
  for (const row of datasets.rows) {
    if (!row.internal_storage_key) {
      // Legacy storage_uri records have no uniform root-relative contract. The
      // exact VAULT_ROOT inventory is still verified, but this mapping cannot be
      // inferred safely and must remain visible to operators.
      legacyDatasetReferences += 1;
      continue;
    }
    assertDatabaseReference(inventoryByPath, {
      key: String(row.internal_storage_key),
      sizeBytes: row.file_size_bytes,
      sha256: row.sha256,
      label: 'An uploaded dataset',
    });
    checkedDatasets += 1;
  }

  const artifacts = await client.query(`
    SELECT id, storage_uri, size_bytes, checksum_sha256
      FROM job_artifacts
     WHERE storage_kind = 'local_internal'
       AND status = 'available'
     ORDER BY id
  `);
  let checkedArtifacts = 0;
  for (const row of artifacts.rows) {
    if (!row.storage_uri) {
      throw new Error('An available local_internal artifact has no storage key.');
    }
    assertDatabaseReference(inventoryByPath, {
      key: String(row.storage_uri),
      sizeBytes: row.size_bytes,
      sha256: row.checksum_sha256,
      label: 'An available local artifact',
    });
    checkedArtifacts += 1;
  }

  let checkedManagedVersions = 0;
  const managedTable = await client.query("SELECT to_regclass('public.managed_artifact_versions') AS name");
  if (managedTable.rows[0]?.name) {
    const versions = await client.query(`
      SELECT id, storage_key, size_bytes, checksum_sha256
        FROM managed_artifact_versions ORDER BY id
    `);
    for (const row of versions.rows) {
      assertDatabaseReference(inventoryByPath, {
        key: String(row.storage_key), sizeBytes: row.size_bytes,
        sha256: row.checksum_sha256, label: 'A managed artifact version',
      });
      checkedManagedVersions += 1;
    }
  }

  const legacyObjects = await client.query(`
    SELECT count(*)::integer AS count
      FROM analysis_objects
     WHERE storage_uri IS NOT NULL
  `);
  return {
    checkedDatasets,
    checkedArtifacts,
    checkedManagedVersions,
    legacyDatasetReferences,
    legacyAnalysisObjectReferences: Number(legacyObjects.rows[0]?.count || 0),
  };
}

async function databaseFingerprint(postgresConfig, options = {}) {
  const excludedTables = new Set(options.excludedTables || []);
  const client = new Client(postgresConfig);
  await client.connect();
  try {
    const tables = await client.query(`
      SELECT tablename
        FROM pg_tables
       WHERE schemaname = 'public'
       ORDER BY tablename
    `);
    const fingerprint = {};
    for (const { tablename } of tables.rows) {
      if (excludedTables.has(tablename)) continue;
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tablename)) {
        throw new Error('Public schema contains a table name unsafe for fingerprinting.');
      }
      const rows = await client.query(
        `SELECT to_jsonb(row_value)::text AS value
           FROM public."${tablename}" AS row_value
          ORDER BY to_jsonb(row_value)::text`
      );
      const hash = crypto.createHash('sha256');
      for (const row of rows.rows) {
        const value = String(row.value);
        hash.update(String(Buffer.byteLength(value)));
        hash.update(':');
        hash.update(value);
        hash.update('\n');
      }
      fingerprint[tablename] = { rows: rows.rowCount, sha256: hash.digest('hex') };
    }
    return fingerprint;
  } finally {
    await client.end();
  }
}

async function jobRows(postgresConfig) {
  const client = new Client(postgresConfig);
  await client.connect();
  try {
    const result = await client.query(
      `SELECT to_jsonb(job_row)::text AS value
         FROM public.jobs AS job_row
        ORDER BY id`
    );
    return result.rows.map((row) => JSON.parse(row.value));
  } finally {
    await client.end();
  }
}

async function verifyRestoredJobSecurityDelta(sourceConfig, restoredConfig) {
  const [sourceRows, restoredRows] = await Promise.all([
    jobRows(sourceConfig),
    jobRows(restoredConfig),
  ]);
  if (sourceRows.length !== restoredRows.length) {
    throw new Error('Restore changed the number of durable jobs.');
  }
  let canceledJobs = 0;
  for (let index = 0; index < sourceRows.length; index += 1) {
    const source = sourceRows[index];
    const restored = restoredRows[index];
    if (source.id !== restored.id) throw new Error('Restored job identifiers differ from the source.');
    if (!['queued', 'running'].includes(source.status)) {
      if (JSON.stringify(source) !== JSON.stringify(restored)) {
        throw new Error('A terminal durable job changed during restore.');
      }
      continue;
    }

    canceledJobs += 1;
    if (restored.status !== 'canceled' || !restored.canceled_at
        || restored.worker_id !== null || restored.claim_token !== null
        || restored.lease_expires_at !== null || restored.heartbeat_at !== null
        || restored.locked_at !== null) {
      throw new Error('A restored active job was not safely canceled and de-claimed.');
    }
    const sourceLogs = JSON.parse(source.logs_json);
    const restoredLogs = JSON.parse(restored.logs_json);
    const finalLog = restoredLogs[restoredLogs.length - 1];
    if (restoredLogs.length !== sourceLogs.length + 1
        || JSON.stringify(restoredLogs.slice(0, -1)) !== JSON.stringify(sourceLogs)
        || finalLog?.level !== 'info'
        || finalLog?.message !== 'Job canceled by disaster-recovery restore.'
        || !Number.isFinite(Date.parse(finalLog?.timestamp))) {
      throw new Error('A restored active job is missing its disaster-recovery audit log.');
    }

    const normalized = {
      ...restored,
      status: source.status,
      logs_json: source.logs_json,
      updated_at: source.updated_at,
      canceled_at: source.canceled_at,
      worker_id: source.worker_id,
      claim_token: source.claim_token,
      lease_expires_at: source.lease_expires_at,
      heartbeat_at: source.heartbeat_at,
      locked_at: source.locked_at,
    };
    if (JSON.stringify(source) !== JSON.stringify(normalized)) {
      throw new Error('Restore changed fields outside the expected active-job security finalization.');
    }
  }
  return canceledJobs;
}

async function kernelRows(postgresConfig) {
  const client=new Client(postgresConfig);await client.connect();
  try {
    const records={};
    for(const table of ['private_r_kernels','private_r_executions','private_r_publications']) {
      const exists=(await client.query('SELECT to_regclass($1) AS name',['public.'+table])).rows[0]?.name;
      records[table]=exists?(await client.query(`SELECT to_jsonb(record)::text AS value FROM public.${table} AS record ORDER BY id`)).rows.map(row=>JSON.parse(row.value)):null;
    }
    return records;
  } finally {await client.end();}
}
function verifyPrivateKernelRowsDelta(sourceRecords,restoredRecords) {
  const counts={stoppedKernels:0,unknownExecutions:0,unknownPublications:0};
  for(const table of ['private_r_kernels','private_r_executions','private_r_publications']) {
    const sources=sourceRecords[table],restored=restoredRecords[table];
    if(sources==null&&restored==null)continue;
    if(!Array.isArray(sources)||!Array.isArray(restored)||sources.length!==restored.length)throw new Error('Restore changed private R journal tables or record counts.');
    const kernel=table==='private_r_kernels';
    for(let index=0;index<sources.length;index++) {
      const source=sources[index],target=restored[index];
      if(source.id!==target.id)throw new Error('Restore changed private R record identities.');
      const active=(kernel?['starting','ready','running','unknown','stopping']:['reserved','running']).includes(source.status);
      if(!active){if(JSON.stringify(source)!==JSON.stringify(target))throw new Error('Restore changed terminal private R source or result evidence.');continue;}
      if(target.status!==(kernel?'stopped':'unknown')||!Number.isFinite(Date.parse(target.updated_at))||kernel&&(!Number.isFinite(Date.parse(target.stopped_at))||target.active_execution_id!==null))throw new Error('Restored private R memory or command completion was not safely invalidated.');
      const normalized={...target,status:source.status,updated_at:source.updated_at,...(kernel?{active_execution_id:source.active_execution_id,stopped_at:source.stopped_at}:{})};
      if(JSON.stringify(source)!==JSON.stringify(normalized))throw new Error('Restore changed private R fields outside explicit memory/completion invalidation.');
      counts[kernel?'stoppedKernels':table==='private_r_publications'?'unknownPublications':'unknownExecutions']++;
    }
  }
  return counts;
}
async function verifyRestoredKernelSecurityDelta(sourceConfig,restoredConfig) {
  const [source,restored]=await Promise.all([kernelRows(sourceConfig),kernelRows(restoredConfig)]);
  return verifyPrivateKernelRowsDelta(source,restored);
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return;
  }
  if (!args.backupDirectory) throw new Error(`--backup is required.\n${usage()}`);
  if (!config.hasPostgresConnection()) {
    throw new Error('Set DATABASE_URL or PGHOST/PGDATABASE for the restored database.');
  }

  const validated = await validateBackupPackage(path.resolve(args.backupDirectory));
  const storageRoot = path.resolve(args.storageRoot || config.storageRoot());
  const vaultRoot = path.resolve(args.vaultRoot || config.vaultRoot());
  await assertDirectoryMatchesInventory(storageRoot, validated.storageFiles, 'Restored STORAGE_ROOT');
  await assertDirectoryMatchesInventory(vaultRoot, validated.vaultFiles, 'Restored VAULT_ROOT');

  const restoredClient = new Client(config.postgresConfig());
  await restoredClient.connect();
  let references;
  try {
    references = await verifyDurableDatabaseReferences(restoredClient, validated.storageFiles);
  } finally {
    await restoredClient.end();
  }

  if (process.env.SOURCE_DATABASE_URL) {
    const sourceConfig = { connectionString: process.env.SOURCE_DATABASE_URL };
    const excludedTables=['jobs','private_r_kernels','private_r_executions','private_r_publications'];
    const sourceFingerprint = await databaseFingerprint(sourceConfig, { excludedTables });
    const restoredFingerprint = await databaseFingerprint(config.postgresConfig(), { excludedTables });
    if (JSON.stringify(sourceFingerprint) !== JSON.stringify(restoredFingerprint)) {
      throw new Error('Source and restored database table fingerprints differ.');
    }
    const canceledJobs = await verifyRestoredJobSecurityDelta(sourceConfig, config.postgresConfig());
    const kernels=await verifyRestoredKernelSecurityDelta(sourceConfig,config.postgresConfig());
    console.log('[verify-restore] security-finalized active jobs=%d', canceledJobs);
    console.log('[verify-restore] invalidated volatile sessions=%d unconfirmed commands=%d unfinished saves=%d',kernels.stoppedKernels,kernels.unknownExecutions,kernels.unknownPublications);
  }

  console.log(
    '[verify-restore] passed: datasets=%d artifacts=%d managedVersions=%d legacyDatasetRefs=%d legacyObjectRefs=%d',
    references.checkedDatasets,
    references.checkedArtifacts,
    references.checkedManagedVersions,
    references.legacyDatasetReferences,
    references.legacyAnalysisObjectReferences
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[verify-restore] failed:', error && error.message ? error.message : 'unknown error');
    process.exitCode = 1;
  });
}

module.exports = {
  databaseFingerprint,
  main,
  parseArgs,
  verifyRestoredJobSecurityDelta,
  verifyRestoredKernelSecurityDelta,
  verifyPrivateKernelRowsDelta,
  verifyDurableDatabaseReferences,
};
