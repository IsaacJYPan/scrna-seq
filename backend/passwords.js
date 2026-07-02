/**
 * Shared password hashing / verification.
 *
 * The hash string format is IDENTICAL to backend/database.js
 * (`$pbkdf2-sha512$i=<iters>$<salt>$<hash>`, 600k iterations, sha512, 64 bytes)
 * so a user row created through the Postgres data layer is verifiable by the
 * same rules as a SQLite user row, and vice versa. Extracted into its own module
 * so the Postgres foundation (backend/pgDatabase.js) does not duplicate — and
 * cannot drift from — the credential contract. The SQLite database.js keeps its
 * own inline copy for now; both are pinned to this format by the auth tests.
 */

'use strict';

const crypto = require('crypto');

const PBKDF2_ITERATIONS = 600000;

// Fixed salt used only to spend an equivalent amount of PBKDF2 work on the
// "user not found" branch of verifyPassword(), removing a user-enumeration
// timing oracle. It never protects a real secret.
const DUMMY_PBKDF2_SALT = '00000000000000000000000000000000';

const GENERIC_CREDENTIAL_ERROR = 'Invalid email or password.';

function hashPassword(password, salt) {
  const hash = crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, 64, 'sha512').toString('hex');
  return `$pbkdf2-sha512$i=${PBKDF2_ITERATIONS}$${salt}$${hash}`;
}

function newSalt() {
  return crypto.randomBytes(16).toString('hex');
}

// Constant-time comparison for two hex-encoded hashes. Returns false (no throw)
// on length mismatch; the compared hashes are fixed-length so a length
// difference reveals nothing useful.
function timingSafeEqualHex(a, b) {
  const bufA = Buffer.from(String(a), 'utf8');
  const bufB = Buffer.from(String(b), 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Verify a plaintext password against a stored hash. `storedHash` may be null
 * (user not found) — in that case equivalent PBKDF2 work is still spent so the
 * not-found branch is not measurably faster. Returns a boolean.
 */
function verifyPassword(password, storedHash) {
  if (!storedHash) {
    crypto.pbkdf2Sync(String(password), DUMMY_PBKDF2_SALT, PBKDF2_ITERATIONS, 64, 'sha512');
    return false;
  }
  if (storedHash.startsWith('$pbkdf2-sha512$')) {
    const parts = storedHash.split('$');
    const iters = parseInt(parts[2].split('=')[1], 10);
    const salt = parts[3];
    const hashData = parts[4];
    const attemptHash = crypto.pbkdf2Sync(password, salt, iters, 64, 'sha512').toString('hex');
    return timingSafeEqualHex(attemptHash, hashData);
  }
  // Legacy (pre-format) hash: 100k iterations, salt supplied separately by the
  // caller is not available here, so a bare legacy hash cannot be verified by
  // this shared helper. New (Postgres) users are always created in the new
  // format, so this only matters for migrated legacy SQLite rows.
  return false;
}

module.exports = {
  PBKDF2_ITERATIONS,
  GENERIC_CREDENTIAL_ERROR,
  hashPassword,
  newSalt,
  timingSafeEqualHex,
  verifyPassword
};
