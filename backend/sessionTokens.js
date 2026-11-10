'use strict';

const crypto = require('crypto');
const config = require('./config');
const { isSafeUserId, isSessionVersion } = require('./sessionIdentifiers');

// Signed session tokens: `<base64url JSON payload>.<HMAC-SHA256>`. The payload
// names the user, their per-user session version (bumped on logout to revoke
// every earlier token), and the deployment-wide session epoch. Verification
// re-reads the user so a revoked or deleted account is rejected immediately.
function createSessionTokens({ secret, db }) {
  if (typeof secret !== 'string' || !secret) throw new Error('A session signing secret is required.');

  function base64UrlJson(value) {
    return Buffer.from(JSON.stringify(value)).toString('base64url');
  }

  function signPayload(payload) {
    return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  }

  function issueSession(user) {
    const sessionVersion = String(user && user.sessionVersion || '');
    const sessionEpoch = config.sessionEpoch();
    if (!user || !isSafeUserId(user.id) || !isSessionVersion(sessionVersion)
        || !config.isValidSessionEpoch(sessionEpoch)) {
      throw new Error('A valid internal user session generation is required.');
    }
    const now = Math.floor(Date.now() / 1000);
    const payload = base64UrlJson({
      v: 2,
      sub: String(user.id),
      sv: sessionVersion,
      se: sessionEpoch,
      iat: now,
      exp: now + config.sessionTtlSeconds()
    });
    return `${payload}.${signPayload(payload)}`;
  }

  async function verifySessionDetails(token) {
    if (!token || typeof token !== 'string' || token.length > 4096) return null;
    const parts = token.split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
    const [payload, signature] = parts;

    const expected = signPayload(payload);
    const expectedBuffer = Buffer.from(expected);
    const signatureBuffer = Buffer.from(signature);
    if (expectedBuffer.length !== signatureBuffer.length ||
        !crypto.timingSafeEqual(expectedBuffer, signatureBuffer)) {
      return null;
    }

    let parsed;
    try {
      parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch (err) {
      console.warn('[Auth] Rejected malformed session token:', err.message);
      return null;
    }

    const now = Math.floor(Date.now() / 1000);
    if (!parsed || Object.getPrototypeOf(parsed) !== Object.prototype
        || parsed.v !== 2
        || typeof parsed.sub !== 'string' || !isSafeUserId(parsed.sub)
        || typeof parsed.sv !== 'string' || !isSessionVersion(parsed.sv)
        || typeof parsed.se !== 'string' || !config.isValidSessionEpoch(parsed.se)
        || parsed.se !== config.sessionEpoch()
        || !Number.isSafeInteger(parsed.iat) || !Number.isSafeInteger(parsed.exp)
        || parsed.iat > now + 60 || parsed.exp <= now || parsed.exp <= parsed.iat) return null;

    const user = await db.getUserForSession(parsed.sub, parsed.sv);
    if (!user || String(user.id) !== parsed.sub) return null;
    return { user, sessionVersion: parsed.sv };
  }

  async function verifySession(token) {
    const details = await verifySessionDetails(token);
    return details ? details.user : null;
  }

  return { issueSession, verifySessionDetails, verifySession };
}

module.exports = { createSessionTokens };
