#!/usr/bin/env node

'use strict';

const path = require('path');
const { Client } = require('pg');
const config = require('../backend/config');
const {
  OFFLINE_ACKNOWLEDGEMENT,
  restoreBackup,
} = require('../backend/backupRestore');

function usage() {
  return [
    'Usage:',
    `  node scripts/restore-runtime.js --backup <backup-directory> --storage-root <new-or-empty-directory> --vault-root <new-or-empty-directory> --confirm-offline ${OFFLINE_ACKNOWLEDGEMENT}`,
    '',
    'The isolated target database must be empty. This command never uses pg_restore --clean.',
    'Database connection settings come only from DATABASE_URL or PG* environment variables.',
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
    else if (arg === '--confirm-offline') parsed.offlineAcknowledgement = value;
    else if (arg === '--pg-restore') parsed.pgRestorePath = value;
    else throw new Error(`Unknown argument: ${arg}`);
    index += 1;
  }
  return parsed;
}

async function databaseIsEmpty(postgresConfig = config.postgresConfig()) {
  const client = new Client(postgresConfig);
  await client.connect();
  try {
    const result = await client.query(`
      SELECT (
        EXISTS (
          SELECT 1
            FROM pg_namespace
           WHERE nspname <> 'public'
             AND nspname <> 'information_schema'
             AND nspname !~ '^pg_'
        )
        OR EXISTS (
          SELECT 1
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public'
        )
        OR EXISTS (
          SELECT 1
            FROM pg_proc p
            JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public'
        )
        OR EXISTS (
          SELECT 1
            FROM pg_type t
            JOIN pg_namespace n ON n.oid = t.typnamespace
           WHERE n.nspname = 'public'
        )
        OR EXISTS (
          SELECT 1 FROM pg_operator o JOIN pg_namespace n ON n.oid = o.oprnamespace
           WHERE n.nspname = 'public'
        )
        OR EXISTS (
          SELECT 1 FROM pg_collation c JOIN pg_namespace n ON n.oid = c.collnamespace
           WHERE n.nspname = 'public'
        )
        OR EXISTS (
          SELECT 1 FROM pg_conversion c JOIN pg_namespace n ON n.oid = c.connamespace
           WHERE n.nspname = 'public'
        )
        OR EXISTS (
          SELECT 1 FROM pg_ts_config c JOIN pg_namespace n ON n.oid = c.cfgnamespace
           WHERE n.nspname = 'public'
        )
        OR EXISTS (
          SELECT 1 FROM pg_ts_dict d JOIN pg_namespace n ON n.oid = d.dictnamespace
           WHERE n.nspname = 'public'
        )
        OR EXISTS (SELECT 1 FROM pg_publication)
        OR EXISTS (SELECT 1 FROM pg_foreign_data_wrapper)
        OR EXISTS (SELECT 1 FROM pg_foreign_server)
        OR EXISTS (SELECT 1 FROM pg_event_trigger)
        OR EXISTS (SELECT 1 FROM pg_largeobject_metadata)
        OR EXISTS (SELECT 1 FROM pg_extension WHERE extname <> 'plpgsql')
        OR EXISTS (
          SELECT 1 FROM pg_statistic_ext s JOIN pg_namespace n ON n.oid = s.stxnamespace
           WHERE n.nspname = 'public'
        )
      ) AS has_user_objects
    `);
    return result.rows[0] && result.rows[0].has_user_objects === false;
  } finally {
    await client.end();
  }
}

async function finalizeRestoredSecurityState(postgresConfig = config.postgresConfig()) {
  const client = new Client(postgresConfig);
  await client.connect();
  try {
    await client.query('BEGIN');
    const canceled = await client.query(`
      UPDATE jobs
         SET status = 'canceled',
             logs_json = (logs_json::jsonb || jsonb_build_array(
               jsonb_build_object(
                 'timestamp', now(),
                 'level', 'info',
                 'message', 'Job canceled by disaster-recovery restore.'
               )
             ))::text,
             updated_at = now(),
             canceled_at = now(),
             worker_id = NULL,
             claim_token = NULL,
             lease_expires_at = NULL,
             heartbeat_at = NULL,
             locked_at = NULL
       WHERE status IN ('queued', 'running')
    `);
    await client.query('COMMIT');
    return { canceledJobs: Number(canceled.rowCount || 0) };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* original error wins */ }
    throw error;
  } finally {
    await client.end();
  }
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return;
  }
  if (!args.backupDirectory) throw new Error(`--backup is required.\n${usage()}`);
  if (!config.hasPostgresConnection()) {
    throw new Error('Set DATABASE_URL or PGHOST/PGDATABASE for the isolated restore database.');
  }

  const result = await restoreBackup({
    backupDirectory: path.resolve(args.backupDirectory),
    storageRoot: path.resolve(args.storageRoot || config.storageRoot()),
    vaultRoot: path.resolve(args.vaultRoot || config.vaultRoot()),
    databaseUrl: config.databaseUrl(),
    sessionEpoch: config.sessionEpoch(),
    offlineAcknowledgement: args.offlineAcknowledgement,
    pgRestorePath: args.pgRestorePath,
    verifyDatabaseEmpty: () => databaseIsEmpty(),
    finalizeRestoredSecurityState: () => finalizeRestoredSecurityState(),
  });
  console.log(
    '[restore] completed: storageFiles=%d vaultFiles=%d',
    result.manifest.roots.storage.fileCount,
    result.manifest.roots.vault.fileCount
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[restore] failed:', error && error.message ? error.message : 'unknown error');
    process.exitCode = 1;
  });
}

module.exports = { databaseIsEmpty, finalizeRestoredSecurityState, main, parseArgs, usage };
