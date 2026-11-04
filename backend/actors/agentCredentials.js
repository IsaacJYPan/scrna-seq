'use strict';

const crypto = require('crypto');

// Agent bearer credentials: opaque, high-entropy, shown once, stored only as a
// SHA-256 digest. The fixed prefix lets every non-automation route recognize
// and refuse an agent credential without a database lookup.
const AGENT_TOKEN_PREFIX = 'tro_agent_';
const SECRET_BYTES = 32;
const AGENT_TOKEN_PATTERN = /^tro_agent_[A-Za-z0-9_-]{43}$/;

function generateAgentToken() {
  const secret = crypto.randomBytes(SECRET_BYTES).toString('base64url');
  const token = `${AGENT_TOKEN_PREFIX}${secret}`;
  return { token, sha256: hashAgentToken(token), hint: secret.slice(0, 6) };
}

function hashAgentToken(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

function isWellFormedAgentToken(value) {
  return typeof value === 'string' && AGENT_TOKEN_PATTERN.test(value);
}

// Returns { present, token } where `present` means the request carries
// something that looks like an agent credential (even malformed), so callers
// can refuse it explicitly rather than silently treating the request as
// anonymous.
function readAgentCredential(req) {
  const header = req.headers?.authorization;
  if (typeof header !== 'string' || header.length === 0) return { present: false, token: null };
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  if (!match) return { present: header.includes(AGENT_TOKEN_PREFIX), token: null };
  const candidate = match[1];
  if (!candidate.startsWith(AGENT_TOKEN_PREFIX)) return { present: false, token: null };
  return { present: true, token: isWellFormedAgentToken(candidate) ? candidate : null };
}

module.exports = {
  AGENT_TOKEN_PREFIX,
  AGENT_TOKEN_PATTERN,
  generateAgentToken,
  hashAgentToken,
  isWellFormedAgentToken,
  readAgentCredential,
};
