#!/usr/bin/env node

'use strict';

const config = require('../backend/config');
const db = require('../backend/pgDatabase');

function quoteIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function quoteLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function main() {
  const runtimeUser = String(process.env.APP_DATABASE_USER || '').trim();
  const runtimePassword = String(process.env.APP_DATABASE_PASSWORD || '');
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(runtimeUser)
      || !/^[\x21-\x7e]{20,200}$/.test(runtimePassword)) {
    throw new Error('APP_DATABASE_USER and APP_DATABASE_PASSWORD are invalid.');
  }
  if (!config.hasPostgresConnection()) throw new Error('Administrator Postgres connection is missing.');

  await db.initSchema({ force: true });
  const pool = await db.connect();
  const client = await pool.connect();
  const role = quoteIdentifier(runtimeUser);
  try {
    await client.query('BEGIN');
    const current = await client.query('SELECT current_database() AS name, current_user AS role');
    if (current.rows[0].role === runtimeUser) {
      throw new Error('The schema administrator and runtime database roles must be different.');
    }
    const database = quoteIdentifier(current.rows[0].name);
    const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [runtimeUser]);
    if (!exists.rows[0]) await client.query(`CREATE ROLE ${role} LOGIN`);
    await client.query(
      `ALTER ROLE ${role} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION PASSWORD ${quoteLiteral(runtimePassword)}`
    );
    await client.query(`ALTER ROLE ${role} SET search_path TO public`);
    await client.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
    await client.query(`GRANT CONNECT ON DATABASE ${database} TO ${role}`);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
    await client.query(`GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
    await client.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${role}`);
    await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${role}`);
    await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${role}`);
    await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO ${role}`);
    await client.query(`REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON app_schema_contract FROM ${role}`);
    await client.query(`GRANT SELECT ON app_schema_contract TO ${role}`);
    await client.query('COMMIT');
    console.log('[init-production-database] Schema and runtime grants are ready.');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* original error wins */ }
    throw error;
  } finally {
    client.release();
    await db.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[init-production-database] Failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { main, quoteIdentifier, quoteLiteral };
