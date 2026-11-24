# Schema migrations

`backend/pg/schema.sql` is the frozen baseline. It is applied idempotently at
startup, then every migration in this directory that the database has not
recorded is applied in version order, in the same transaction and under the same
advisory lock. Each applied migration is recorded in `schema_migrations` with
the SHA-256 of its file.

- Name files `NNNN_snake_case.sql` with the next unused four-digit version.
- Never edit or delete a migration once it is merged: startup refuses a
  database whose recorded checksum no longer matches the file
  (`DATABASE_MIGRATION_CHANGED`) or that recorded a migration this build lacks
  (`DATABASE_MIGRATION_UNKNOWN`).
- Do not add `ALTER TABLE` statements to `schema.sql`. Schema changes and data
  backfills go here. `backend/schema-migrations.test.js` fails if the baseline
  gains inline `ALTER TABLE` statements.
- A migration must not conflict with the baseline's idempotent statements, which
  run on every start (for example, do not drop a column the baseline adds with
  `ADD COLUMN IF NOT EXISTS`).
- With `DATABASE_SCHEMA_MANAGED_EXTERNALLY=true` the application applies
  nothing and refuses to start while migrations are pending.

`npm run test:schema-upgrade` restores the schema of an earlier release,
upgrades it, and compares the result with a fresh install.
