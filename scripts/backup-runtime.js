#!/usr/bin/env node

'use strict';

const path = require('path');
const config = require('../backend/config');
const {
  OFFLINE_ACKNOWLEDGEMENT,
  createBackup,
} = require('../backend/backupRestore');

function usage() {
  return [
    'Usage:',
    `  node scripts/backup-runtime.js --destination <new-directory> --confirm-offline ${OFFLINE_ACKNOWLEDGEMENT}`,
    '',
    'The web process, worker, and R process must all be stopped first.',
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
    if (arg === '--destination') parsed.destination = value;
    else if (arg === '--confirm-offline') parsed.offlineAcknowledgement = value;
    else if (arg === '--pg-dump') parsed.pgDumpPath = value;
    else throw new Error(`Unknown argument: ${arg}`);
    index += 1;
  }
  return parsed;
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return;
  }
  if (!args.destination) throw new Error(`--destination is required.\n${usage()}`);
  if (!config.hasPostgresConnection()) {
    throw new Error('Set DATABASE_URL or PGHOST/PGDATABASE before creating a backup.');
  }

  const result = await createBackup({
    destination: path.resolve(args.destination),
    storageRoot: config.storageRoot(),
    vaultRoot: config.vaultRoot(),
    databaseUrl: config.databaseUrl(),
    sessionEpoch: config.sessionEpoch(),
    offlineAcknowledgement: args.offlineAcknowledgement,
    pgDumpPath: args.pgDumpPath,
  });
  console.log(
    '[backup] completed: files=%d bytes=%d',
    result.manifest.roots.storage.fileCount + result.manifest.roots.vault.fileCount,
    result.manifest.database.sizeBytes +
      result.manifest.roots.storage.totalSizeBytes +
      result.manifest.roots.vault.totalSizeBytes
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[backup] failed:', error && error.message ? error.message : 'unknown error');
    process.exitCode = 1;
  });
}

module.exports = { main, parseArgs, usage };
