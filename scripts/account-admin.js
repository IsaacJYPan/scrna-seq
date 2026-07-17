#!/usr/bin/env node

'use strict';

const config = require('../backend/config');
const db = require('../backend/pgDatabase');

const ACTIONS = new Set(['create', 'reset-password']);

function usage() {
  console.error('Usage:');
  console.error('  node scripts/account-admin.js create --email <address> --display-name <name> --password-stdin');
  console.error('  node scripts/account-admin.js reset-password --email <address> --password-stdin');
  console.error('The password must be piped on standard input; it is never accepted in argv or logged.');
}

function parseArgs(argv) {
  const parsed = { action: String(argv[0] || ''), email: '', displayName: '', passwordStdin: false };
  if (!ACTIONS.has(parsed.action)) {
    throw Object.assign(new Error('Invalid account-administration action.'), { code: 'INVALID_ARGUMENTS' });
  }
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--email' && index + 1 < argv.length) parsed.email = String(argv[++index]).trim().toLowerCase();
    else if (arg === '--display-name' && index + 1 < argv.length) parsed.displayName = String(argv[++index]).trim();
    else if (arg === '--password-stdin') parsed.passwordStdin = true;
    else throw Object.assign(new Error('Invalid account-administration arguments.'), { code: 'INVALID_ARGUMENTS' });
  }
  return parsed;
}

async function readPasswordFromStdin(input = process.stdin) {
  if (input.isTTY) {
    throw Object.assign(
      new Error('Refusing an echoed terminal password. Use a hidden shell prompt and pipe it with --password-stdin.'),
      { code: 'INVALID_PASSWORD' }
    );
  }
  input.setEncoding('utf8');
  let value = '';
  for await (const chunk of input) {
    value += chunk;
    if (Buffer.byteLength(value, 'utf8') > 4096) {
      throw Object.assign(new Error('Password input is too large.'), { code: 'INVALID_PASSWORD' });
    }
  }
  value = value.replace(/\r?\n$/, '');
  if (/[\r\n\0]/.test(value) || value.length < 8 || value.length > 1024) {
    throw Object.assign(
      new Error('Password must be between 8 and 1024 characters and contain no line break or NUL.'),
      { code: 'INVALID_PASSWORD' }
    );
  }
  return value;
}

function validateIdentity({ action, email, displayName, passwordStdin }) {
  const emailValid = email.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  const displayValid = action === 'create'
    ? !!displayName && displayName.length <= 200
    : displayName === '';
  if (!passwordStdin || !emailValid || !displayValid) {
    throw Object.assign(
      new Error('The action requires a valid email, the documented display-name fields, and --password-stdin.'),
      { code: 'INVALID_ARGUMENTS' }
    );
  }
}

async function main() {
  const input = parseArgs(process.argv.slice(2));
  validateIdentity(input);
  if (!config.hasPostgresConnection()) {
    throw new Error('No Postgres connection configured. Set DATABASE_URL or PGHOST/PGDATABASE.');
  }
  const password = await readPasswordFromStdin();
  await db.initSchema();
  const user = input.action === 'create'
    ? await db.provisionUserByOperator(input.email, password, input.displayName)
    : await db.resetUserPasswordByOperator(input.email, password);
  if (user.error) {
    throw Object.assign(new Error(user.error), { code: 'ACCOUNT_EXISTS' });
  }
  console.log(
    '[account-admin] action=%s user_id=%s email=%s audit_event=%s',
    input.action,
    user.id,
    user.email,
    user.auditEventId
  );
}

if (require.main === module) {
  main()
    .catch((error) => {
      if (error?.code === 'INVALID_ARGUMENTS') usage();
      console.error('[account-admin] Failed:', error.message);
      process.exitCode = ['INVALID_ARGUMENTS', 'INVALID_PASSWORD', 'ACCOUNT_EXISTS', 'USER_NOT_FOUND'].includes(error?.code) ? 2 : 1;
    })
    .finally(async () => {
      await db.close();
    });
}

module.exports = {
  parseArgs,
  readPasswordFromStdin,
  validateIdentity,
};
