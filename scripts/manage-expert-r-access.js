#!/usr/bin/env node

'use strict';

const config = require('../backend/config');
const db = require('../backend/pgDatabase');

function usage() {
  console.error('Usage: npm run expert-r-access -- <grant|revoke|status> <user-email>');
}

async function main() {
  const [action, rawEmail, ...extra] = process.argv.slice(2);
  const email = String(rawEmail || '').trim().toLowerCase();
  if (!['grant', 'revoke', 'status'].includes(action) || !email || extra.length > 0) {
    usage();
    process.exitCode = 2;
    return;
  }
  if (!config.hasPostgresConnection()) {
    throw new Error('No Postgres connection configured. Set DATABASE_URL or PGHOST/PGDATABASE.');
  }

  await db.initSchema();
  const user = await db.getUserByEmail(email);
  if (!user) {
    const error = new Error(`No user account exists for ${email}.`);
    error.code = 'USER_NOT_FOUND';
    throw error;
  }

  let mutation = null;
  if (action === 'grant' || action === 'revoke') {
    mutation = await db.setExpertRExecutorByEmail(email, action === 'grant');
  }
  const capabilities = await db.getExpertRCapabilities(user.id);
  console.log(
    '[expert-r-access] %s expert_r.execute=%s%s',
    user.email,
    capabilities.canExecuteExpertR ? 'granted' : 'revoked',
    mutation ? ` audit_event=${mutation.auditEventId}` : ''
  );
}

main()
  .catch((error) => {
    console.error('[expert-r-access] Failed:', error.message);
    process.exitCode = error.code === 'USER_NOT_FOUND' ? 2 : 1;
  })
  .finally(async () => {
    await db.close();
  });
