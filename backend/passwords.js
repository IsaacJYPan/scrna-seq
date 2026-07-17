/**
 * Shared password hashing / verification.
 *
 * The hash string format is the app credential contract:
 * `$pbkdf2-sha512$i=<iters>$<salt>$<hash>`, 600k iterations, sha512, 64 bytes.
 * It lives here so backend/pgDatabase.js does not duplicate credential logic.
 */

'use strict';

const crypto = require('crypto');

const PBKDF2_ITERATIONS = 600000;
const PBKDF2_KEY_BYTES = 64;
const PASSWORD_HASH_CONCURRENCY = 2;
const PASSWORD_HASH_MAX_QUEUE = 8;

// Fixed salt used only to spend an equivalent amount of PBKDF2 work on the
// "user not found" branch of verifyPassword(), removing a user-enumeration
// timing oracle. It never protects a real secret.
const DUMMY_PBKDF2_SALT = '00000000000000000000000000000000';

const GENERIC_CREDENTIAL_ERROR = 'Invalid email or password.';

function authenticationBusyError() {
  const error = new Error('Authentication work capacity is currently full.');
  error.code = 'AUTH_HASH_BUSY';
  return error;
}

/**
 * Bound expensive password work independently of client IP. The HTTP limiter
 * slows one address, while this admission controller protects the single Node
 * event loop/libuv pool from distributed login or registration bursts.
 */
function createAdmissionController({
  maxActive = PASSWORD_HASH_CONCURRENCY,
  maxQueued = PASSWORD_HASH_MAX_QUEUE,
} = {}) {
  if (!Number.isInteger(maxActive) || maxActive < 1
      || !Number.isInteger(maxQueued) || maxQueued < 0) {
    throw new TypeError('Password admission limits must be non-negative integers with at least one active slot.');
  }

  let active = 0;
  const queue = [];

  function start(entry) {
    active += 1;
    Promise.resolve()
      .then(entry.task)
      .then(entry.resolve, entry.reject)
      .finally(() => {
        active -= 1;
        const next = queue.shift();
        if (next) start(next);
      });
  }

  function run(task) {
    if (typeof task !== 'function') return Promise.reject(new TypeError('Password admission task must be a function.'));
    return new Promise((resolve, reject) => {
      const entry = { task, resolve, reject };
      if (active < maxActive) {
        start(entry);
        return;
      }
      if (queue.length >= maxQueued) {
        reject(authenticationBusyError());
        return;
      }
      queue.push(entry);
    });
  }

  return {
    run,
    snapshot: () => ({ active, queued: queue.length, maxActive, maxQueued }),
  };
}

const passwordAdmission = createAdmissionController();

function derivePassword(password, salt, iterations = PBKDF2_ITERATIONS) {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(String(password), salt, iterations, PBKDF2_KEY_BYTES, 'sha512', (error, result) => {
      if (error) reject(error);
      else resolve(result.toString('hex'));
    });
  });
}

async function hashPassword(password, salt) {
  return passwordAdmission.run(async () => {
    const hash = await derivePassword(password, salt);
    return `$pbkdf2-sha512$i=${PBKDF2_ITERATIONS}$${salt}$${hash}`;
  });
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
 * (user not found). In that case equivalent PBKDF2 work is still spent so the
 * not-found branch is not measurably faster. Returns a boolean.
 */
async function verifyPassword(password, storedHash) {
  return passwordAdmission.run(async () => {
    const parts = typeof storedHash === 'string' ? storedHash.split('$') : [];
    const iterationMatch = parts[2]?.match(/^i=([1-9][0-9]*)$/);
    const validStoredHash = parts.length === 5
      && parts[0] === ''
      && parts[1] === 'pbkdf2-sha512'
      && Number(iterationMatch?.[1]) === PBKDF2_ITERATIONS
      && /^[0-9a-f]{32}$/.test(parts[3] || '')
      && /^[0-9a-f]{128}$/.test(parts[4] || '');

    // Missing/malformed/legacy hashes deliberately take the same fixed PBKDF2
    // work path. Never honor a database-provided iteration count: a corrupted
    // row must not become an unbounded CPU request.
    const salt = validStoredHash ? parts[3] : DUMMY_PBKDF2_SALT;
    const expectedHash = validStoredHash ? parts[4] : '0'.repeat(128);
    const attemptHash = await derivePassword(password, salt);
    return validStoredHash && timingSafeEqualHex(attemptHash, expectedHash);
  });
}

module.exports = {
  PBKDF2_ITERATIONS,
  PASSWORD_HASH_CONCURRENCY,
  PASSWORD_HASH_MAX_QUEUE,
  GENERIC_CREDENTIAL_ERROR,
  authenticationBusyError,
  createAdmissionController,
  hashPassword,
  newSalt,
  passwordAdmission,
  timingSafeEqualHex,
  verifyPassword
};
