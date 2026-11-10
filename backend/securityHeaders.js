'use strict';

const config = require('./config');

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "media-src 'self' blob:",
].join('; ');

// Browser hardening headers for every response. In production, plain-HTTP
// requests are refused (except the health probes) and HTTPS responses get HSTS.
function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  if (config.isProduction() && req.secure) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  const healthPath = req.path === '/livez' || req.path === '/readyz';
  if (config.isProduction() && !healthPath && !req.secure) {
    return res.status(426).json({ error: 'HTTPS required.' });
  }
  return next();
}

module.exports = { CONTENT_SECURITY_POLICY, securityHeaders };
