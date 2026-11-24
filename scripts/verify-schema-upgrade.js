#!/usr/bin/env node
'use strict';

// Upgrade test: restore the schema of an earlier release, upgrade it with this
// build (baseline + pending migrations), and compare it with a fresh install.
//   DATABASE_URL=postgres://user:pass@host/any_test node scripts/verify-schema-upgrade.js [git-ref]
// The role in DATABASE_URL must be allowed to create databases. Two disposable
// databases are created and dropped. Exits 1 and prints a diff when they differ.

const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const path = require('node:path');
const { Client } = require('pg');

const ROOT = path.resolve(__dirname, '..');
// The last release before the migration ledger; override with an argument.
const FROM_REF = process.argv[2] || '8175ff51';

function urlFor(base, database) {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

async function withClient(url, fn) {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

function initSchema(url) {
  execFileSync(process.execPath, ['-e', "require('./backend/pgDatabase').initSchema().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); })"], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: url, DATABASE_SCHEMA_MANAGED_EXTERNALLY: 'false', NODE_ENV: 'test' },
    stdio: 'inherit',
  });
}

// Column order differs legitimately (ALTER ... ADD COLUMN appends), so the
// lines of each CREATE TABLE body are sorted before comparing.
function normalizedDump(url) {
  const dump = execFileSync('pg_dump', ['--schema-only', '--no-owner', '--no-privileges', '--no-comments', url], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const lines = dump
    .split('\n')
    .filter((line) => line.trim() && !line.startsWith('--') && !/^SET |^SELECT pg_catalog|^\\(un)?restrict /.test(line));
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (/^CREATE TABLE /.test(lines[i])) {
      const body = [];
      let j = i + 1;
      for (; j < lines.length && lines[j] !== ');'; j += 1) body.push(lines[j].replace(/,$/, ''));
      out.push(lines[i], ...body.sort(), ');');
      i = j;
    } else {
      out.push(lines[i]);
    }
  }
  return out;
}

function diff(a, b) {
  const left = new Set(a);
  const right = new Set(b);
  return [
    ...a.filter((line) => !right.has(line)).map((line) => `- ${line}`),
    ...b.filter((line) => !left.has(line)).map((line) => `+ ${line}`),
  ];
}

async function main() {
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error('DATABASE_URL is required.');
  const suffix = crypto.randomBytes(4).toString('hex');
  const upgraded = `schema_upgrade_test_${suffix}`;
  const fresh = `schema_fresh_test_${suffix}`;
  const oldSchema = execFileSync('git', ['show', `${FROM_REF}:backend/pg/schema.sql`], { cwd: ROOT, encoding: 'utf8' });
  await withClient(base, async (client) => {
    await client.query(`CREATE DATABASE ${upgraded}`);
    await client.query(`CREATE DATABASE ${fresh}`);
  });
  try {
    await withClient(urlFor(base, upgraded), (client) => client.query(oldSchema));
    console.log(`Restored the schema of ${FROM_REF}; upgrading.`);
    initSchema(urlFor(base, upgraded));
    initSchema(urlFor(base, fresh));
    const changes = diff(normalizedDump(urlFor(base, upgraded)), normalizedDump(urlFor(base, fresh)));
    if (changes.length) {
      console.error(`Upgraded schema differs from a fresh install (- upgraded, + fresh):\n${changes.join('\n')}`);
      process.exitCode = 1;
    } else {
      console.log(`Upgrade from ${FROM_REF} matches a fresh install.`);
    }
  } finally {
    await withClient(base, async (client) => {
      await client.query(`DROP DATABASE IF EXISTS ${upgraded}`);
      await client.query(`DROP DATABASE IF EXISTS ${fresh}`);
    });
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
