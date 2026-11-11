import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const config = require('./config');
const db = require('./pgDatabase');

const CONFIGURED = config.hasPostgresConnection();
const BASELINE = fs.readFileSync(path.join(__dirname, 'pg', 'schema.sql'), 'utf8');
// Frozen when the migration ledger was introduced. New schema changes are
// migrations in backend/pg/migrations, not inline ALTERs in the baseline.
const FROZEN_BASELINE_ALTER_COUNT = 60;

function migrationsDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrations-'));
  for (const [name, sql] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), sql);
  return dir;
}

describe('schema baseline', () => {
  it('gains no new inline ALTER TABLE statements', () => {
    expect((BASELINE.match(/\bALTER TABLE\b/g) || []).length).toBeLessThanOrEqual(FROZEN_BASELINE_ALTER_COUNT);
  });

  it('loads migrations in version order and refuses malformed or duplicate files', () => {
    const dir = migrationsDir({ '0002_b.sql': 'SELECT 2;', '0001_a.sql': 'SELECT 1;', 'README.md': 'notes' });
    expect(db.loadMigrations(dir).map((m) => m.name)).toEqual(['0001_a.sql', '0002_b.sql']);
    expect(() => db.loadMigrations(migrationsDir({ 'add-column.sql': 'SELECT 1;' })))
      .toThrow(expect.objectContaining({ code: 'DATABASE_MIGRATION_INVALID' }));
    expect(() => db.loadMigrations(migrationsDir({ '0001_a.sql': 'SELECT 1;', '0001_b.sql': 'SELECT 1;' })))
      .toThrow(expect.objectContaining({ code: 'DATABASE_MIGRATION_INVALID' }));
  });
});

describe.skipIf(!CONFIGURED)('schema migrations', () => {
  afterAll(async () => { await db.close(); });
  beforeEach(async () => {
    await db.resetSchemaForTests();
    await db.query('DROP TABLE IF EXISTS migration_probe');
  });

  it('applies pending migrations once, in order, and records their checksums', async () => {
    const dir = migrationsDir({
      '0001_create_probe.sql': 'CREATE TABLE migration_probe (id INTEGER PRIMARY KEY);',
      '0002_backfill_probe.sql': 'INSERT INTO migration_probe (id) VALUES (1), (2);',
    });
    expect((await db.initSchema({ migrationsDir: dir })).appliedMigrations)
      .toEqual(['0001_create_probe.sql', '0002_backfill_probe.sql']);
    expect((await db.initSchema({ migrationsDir: dir })).appliedMigrations).toEqual([]);
    expect((await db.query('SELECT count(*)::int AS n FROM migration_probe')).rows[0].n).toBe(2);
    const { rows } = await db.query('SELECT version, name, checksum_sha256 FROM schema_migrations ORDER BY version');
    expect(rows.map((r) => [r.version, r.name])).toEqual([[1, '0001_create_probe.sql'], [2, '0002_backfill_probe.sql']]);
    expect(rows.every((r) => /^[0-9a-f]{64}$/.test(r.checksum_sha256))).toBe(true);
  });

  it('applies nothing when a migration fails', async () => {
    const dir = migrationsDir({
      '0001_create_probe.sql': 'CREATE TABLE migration_probe (id INTEGER PRIMARY KEY);',
      '0002_broken.sql': 'INSERT INTO missing_table VALUES (1);',
    });
    await expect(db.initSchema({ migrationsDir: dir })).rejects.toThrow();
    expect((await db.query("SELECT to_regclass('migration_probe') AS t")).rows[0].t).toBeNull();
  });

  it('refuses a database whose applied migration changed or is unknown to the build', async () => {
    const dir = migrationsDir({ '0001_create_probe.sql': 'CREATE TABLE migration_probe (id INTEGER PRIMARY KEY);' });
    await db.initSchema({ migrationsDir: dir });
    fs.writeFileSync(path.join(dir, '0001_create_probe.sql'), 'CREATE TABLE migration_probe (id BIGINT PRIMARY KEY);');
    await expect(db.initSchema({ migrationsDir: dir })).rejects.toMatchObject({ code: 'DATABASE_MIGRATION_CHANGED' });
    await expect(db.initSchema({ migrationsDir: migrationsDir({}) })).rejects.toMatchObject({ code: 'DATABASE_MIGRATION_UNKNOWN' });
  });

  it('refuses to start an externally managed database with pending migrations', async () => {
    await db.initSchema({ migrationsDir: migrationsDir({}) });
    const dir = migrationsDir({ '0001_create_probe.sql': 'CREATE TABLE migration_probe (id INTEGER PRIMARY KEY);' });
    const previous = process.env.DATABASE_SCHEMA_MANAGED_EXTERNALLY;
    process.env.DATABASE_SCHEMA_MANAGED_EXTERNALLY = 'true';
    try {
      await expect(db.initSchema({ migrationsDir: dir })).rejects.toMatchObject({ code: 'DATABASE_SCHEMA_MISMATCH' });
      expect((await db.query("SELECT to_regclass('migration_probe') AS t")).rows[0].t).toBeNull();
      await db.initSchema({ migrationsDir: dir, force: true });
      await expect(db.initSchema({ migrationsDir: dir })).resolves.toBe(true);
    } finally {
      if (previous === undefined) delete process.env.DATABASE_SCHEMA_MANAGED_EXTERNALLY;
      else process.env.DATABASE_SCHEMA_MANAGED_EXTERNALLY = previous;
    }
  });
});
