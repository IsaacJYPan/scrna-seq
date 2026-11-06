#!/usr/bin/env node
'use strict';

// Qualifies the configured Slurm target for agent sandbox runs by running real
// jobs on the cluster (see backend/executors/slurmQualification.js). Uses the
// same SLURM_* settings as the web and worker processes. Prints each check and
// exits 1 if any required check fails. The result is recorded in the database;
// agent sandboxes can use the cluster only while the latest record passed.
//
//   npm run slurm:qualify

const config = require('../backend/config');
const db = require('../backend/pgDatabase');
const { createSlurmExecutor } = require('../backend/executors/slurm');
const { qualifySlurmTarget } = require('../backend/executors/slurmQualification');

async function main() {
  if (!config.hasPostgresConnection()) throw new Error('No Postgres connection configured. Set DATABASE_URL or PGHOST/PGDATABASE.');
  await db.initSchema();
  const executor = createSlurmExecutor({ db });
  if (!executor.config.enabled) throw new Error(executor.config.invalid ? `Invalid SLURM setting: ${executor.config.invalid}.` : 'Slurm is not configured (SLURM_SSH_TARGET, SLURM_REMOTE_ROOT).');
  console.log(`Qualifying ${executor.config.name} (${executor.config.target || 'local transport'}). This submits three small jobs.`);
  const result = await qualifySlurmTarget({ db, executor, log: (line) => console.log(line) });
  console.log(result.passed ? `Qualified (${result.id}). Agent sandboxes may now use this cluster.`
    : `Not qualified (${result.id}). Fix the failing checks and run again.`);
  process.exitCode = result.passed ? 0 : 1;
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
}).finally(() => db.close().catch(() => {}));
