#!/usr/bin/env node
'use strict';

const rawUrl = process.env.DATABASE_URL;
if (!rawUrl) {
  console.error('[ci-preflight] DATABASE_URL is required.');
  process.exit(1);
}

let databaseName;
try {
  const parsed = new URL(rawUrl);
  databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
} catch {
  console.error('[ci-preflight] DATABASE_URL must be a valid PostgreSQL URL.');
  process.exit(1);
}

if (!/(?:^|[_-])(test|ci)(?:$|[_-])/i.test(databaseName)) {
  console.error(`[ci-preflight] Refusing to reset non-test database "${databaseName || '(unnamed)'}".`);
  process.exit(1);
}

console.log(`[ci-preflight] Using isolated test database "${databaseName}".`);
