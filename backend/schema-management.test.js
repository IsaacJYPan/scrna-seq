import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const db = require('./pgDatabase');
const role = `schema_reader_${randomBytes(6).toString('hex')}`;
const password = randomBytes(24).toString('hex');
const configured = Boolean(process.env.DATABASE_URL);

describe.skipIf(!configured)('externally managed database schema', () => {
  beforeAll(async () => {
    await db.initSchema({ force: true });
    await db.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}'`);
    await db.query(`GRANT USAGE ON SCHEMA public TO "${role}"`);
    await db.query(`GRANT SELECT ON app_schema_contract TO "${role}"`);
  });

  afterAll(async () => {
    await db.query(`DROP OWNED BY "${role}"`);
    await db.query(`DROP ROLE "${role}"`);
    await db.close();
  });

  it.each(['test', 'development'])('verifies schema with a read-only account in %s mode', mode => {
    const url = new URL(process.env.DATABASE_URL);
    url.username = role;
    url.password = password;
    const result = spawnSync(process.execPath, ['-e', `
      const db = require('./backend/pgDatabase');
      db.initSchema().catch(error => {
        console.error(error.code); process.exitCode = 1;
      }).finally(() => db.close());
    `], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 15000, windowsHide: true,
      env: { ...process.env, NODE_ENV: mode, DATABASE_URL: url.toString(), DATABASE_SCHEMA_MANAGED_EXTERNALLY: 'true' },
    });
    expect(result.status, result.stderr || result.error?.message).toBe(0);
  });
});
