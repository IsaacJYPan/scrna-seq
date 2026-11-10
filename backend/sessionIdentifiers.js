'use strict';

// Session cookies carry the user id and session version as decimal strings.
// Both the cookie verifier (server.js) and the session store (pgDatabase.js)
// must accept exactly the same canonical forms, so the checks live here once.

const MAX_POSTGRES_BIGINT = 9223372036854775807n;

function isCanonicalPositiveIntegerString(value, maximum) {
  const text = String(value ?? '');
  if (!/^[1-9][0-9]{0,18}$/.test(text)) return false;
  try { return BigInt(text) <= maximum; } catch { return false; }
}

function isSafeUserId(value) {
  return isCanonicalPositiveIntegerString(value, BigInt(Number.MAX_SAFE_INTEGER));
}

function isSessionVersion(value) {
  return isCanonicalPositiveIntegerString(value, MAX_POSTGRES_BIGINT);
}

module.exports = { isSafeUserId, isSessionVersion };
