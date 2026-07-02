#!/usr/bin/env node
/**
 * Initialize the Postgres schema for the hosted-service database path.
 *
 * Applies backend/pg/schema.sql idempotently (CREATE ... IF NOT EXISTS), so it
 * is safe to run against a fresh OR already-initialized database. Connection
 * info comes from backend/config.js (DATABASE_URL or PG* vars).
 *
 * Usage:
 *   DATABASE_URL=postgres://user:pass@localhost:5432/scrna node scripts/init-postgres.js
 *   # or with PGHOST/PGUSER/PGPASSWORD/PGDATABASE set
 *   npm run init:postgres
 *
 * This does NOT migrate existing SQLite dev data. Local SQLite state is
 * disposable dev/test data (see docs/architecture.md → "Database backend");
 * a fresh Postgres database starts empty and users/projects are re-created
 * through the normal signup/create flows.
 */

'use strict';

const config = require('../backend/config');
const pg = require('../backend/pgDatabase');

async function main() {
  if (!config.hasPostgresConnection()) {
    console.error(
      '[init-postgres] No Postgres connection configured. Set DATABASE_URL or PGHOST/PGDATABASE.'
    );
    process.exit(2);
  }

  // Never print credentials — only the non-secret summary.
  const s = config.summary();
  console.log('[init-postgres] backend=%s hasDatabaseUrl=%s', s.databaseBackend, s.hasDatabaseUrl);

  try {
    await pg.initSchema();
    console.log('[init-postgres] Schema initialized successfully.');
  } catch (err) {
    console.error('[init-postgres] Schema initialization failed:', err.message);
    process.exitCode = 1;
  } finally {
    await pg.close();
  }
}

main();
