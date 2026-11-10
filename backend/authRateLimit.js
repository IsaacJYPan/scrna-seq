'use strict';

const { positiveIntFromEnv } = require('./config');

// Defense-in-depth against credential stuffing / signup abuse. A small,
// dependency-free fixed-window limiter keyed by client IP is sufficient for
// this single-node app; a multi-node deployment would swap this for a shared
// store (e.g. Redis). The window/limit are read per-request from the
// environment so tests can tighten them deterministically without re-importing
// the module, and each limiter exposes reset() so tests can clear state between
// cases (preventing rate-limit leakage across tests).
const DEFAULT_AUTH_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_AUTH_RATE_LIMIT_MAX = 10;
const MAX_AUTH_RATE_LIMIT_KEYS = 10000;

// A malformed limiter override must NEVER silently disable the limiter (a NaN
// limit makes `count > NaN` always false), so positiveIntFromEnv falls CLOSED
// to the secure default.
function authRateLimitWindowMs() {
  return positiveIntFromEnv(process.env.AUTH_RATE_LIMIT_WINDOW_MS, DEFAULT_AUTH_RATE_LIMIT_WINDOW_MS);
}
function authRateLimitMax() {
  return positiveIntFromEnv(process.env.AUTH_RATE_LIMIT_MAX, DEFAULT_AUTH_RATE_LIMIT_MAX);
}

// The DISABLE_RATE_LIMIT escape hatch is for local/dev/test convenience only.
// It must NEVER take effect in production: rate limiting is a security control
// there, and a stray env var must not be able to silently remove credential-
// stuffing / signup-abuse protection.
function rateLimitDisabled() {
  return process.env.DISABLE_RATE_LIMIT === 'true' && process.env.NODE_ENV !== 'production';
}

function createRateLimiter() {
  const hits = new Map(); // ip -> { count, resetAt }
  let nextSweepAt = 0;

  function sweepExpired(now, windowMs) {
    for (const [key, entry] of hits) {
      if (now >= entry.resetAt) hits.delete(key);
    }
    // At most one O(n) sweep per minute (or per shorter configured window).
    // A full map rejects unseen keys immediately between sweeps.
    nextSweepAt = now + Math.min(windowMs, 60 * 1000);
  }

  function middleware(req, res, next) {
    if (rateLimitDisabled()) return next();

    const windowMs = authRateLimitWindowMs();
    const max = authRateLimitMax();
    const key = req.ip || req.socket?.remoteAddress || 'unknown';
    const now = Date.now();

    if (now >= nextSweepAt) sweepExpired(now, windowMs);

    // Fail closed for unseen addresses when a distributed source fills the
    // bounded key table. Existing callers retain their budgets; expired keys
    // are removed above. Nginx provides a second, independent ingress limit.
    if (!hits.has(key) && hits.size >= MAX_AUTH_RATE_LIMIT_KEYS) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil(windowMs / 1000))));
      return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
    }

    let entry = hits.get(key);
    if (!entry || now >= entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;

    if (entry.count > max) {
      const retryAfterSec = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retryAfterSec));
      return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
    }
    next();
  }

  middleware.reset = () => { hits.clear(); nextSweepAt = 0; };
  middleware.keyCount = () => hits.size;
  return middleware;
}

module.exports = {
  MAX_AUTH_RATE_LIMIT_KEYS,
  authRateLimitMax,
  authRateLimitWindowMs,
  createRateLimiter,
  rateLimitDisabled,
};
