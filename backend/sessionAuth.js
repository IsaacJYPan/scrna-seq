'use strict';

// Cookie-only browser sessions: parsing, Set-Cookie serialization, session
// resolution, the CSRF origin check and the requireAuth middleware.
function createSessionAuth({ config, verifySessionDetails }) {
  // ── HttpOnly cookie session (hosted-service auth foundation) ─────────────────
  // Browser auth is cookie-only. The signed token carries a server-checked per-user
  // session generation, so logout revokes every previously issued session for that
  // account immediately. Tokens are never returned to JavaScript.

  // Minimal, dependency-free cookie reader. Express 5 does not parse cookies by
  // default and we deliberately avoid adding a parser dependency for one cookie.
  function parseCookies(req) {
    const header = req.headers.cookie;
    const out = {};
    if (!header || typeof header !== 'string') return out;
    for (const part of header.split(';')) {
      const eq = part.indexOf('=');
      if (eq === -1) continue;
      const name = part.slice(0, eq).trim();
      if (!name) continue;
      let value;
      try { value = decodeURIComponent(part.slice(eq + 1).trim()); } catch { value = null; }
      // Duplicate session-cookie names are ambiguous (cookie tossing). Preserve a
      // null marker rather than choosing attacker-controlled ordering.
      if (Object.prototype.hasOwnProperty.call(out, name)) out[name] = null;
      else out[name] = value;
    }
    return out;
  }

  function getCookieToken(req) {
    const value = parseCookies(req)[config.sessionCookieName()];
    return typeof value === 'string' && value.length > 0 ? value : null;
  }

  function hasSessionCookie(req) {
    const header = req.headers.cookie;
    if (!header || typeof header !== 'string') return false;
    const expected = config.sessionCookieName();
    return header.split(';').some((part) => part.slice(0, Math.max(0, part.indexOf('='))).trim() === expected);
  }

  // Serialize the session Set-Cookie. HttpOnly (never readable by JS, the whole
  // point of the migration), SameSite (CSRF first line of defense), Secure in
  // production, Path=/, and Max-Age tied to the session TTL.
  function buildSessionCookie(token, { clear = false, name = config.sessionCookieName() } = {}) {
    const parts = [`${name}=${clear ? '' : encodeURIComponent(token)}`];
    parts.push('Path=/');
    parts.push('HttpOnly');
    parts.push(`SameSite=${config.cookieSameSite()}`);
    if (config.cookieSecure()) parts.push('Secure');
    parts.push(`Max-Age=${clear ? 0 : config.sessionTtlSeconds()}`);
    return parts.join('; ');
  }

  function setSessionCookie(res, token) {
    res.append('Set-Cookie', buildSessionCookie(token));
    if (config.sessionCookieName() !== config.LEGACY_SESSION_COOKIE_NAME) {
      res.append('Set-Cookie', buildSessionCookie('', {
        clear: true,
        name: config.LEGACY_SESSION_COOKIE_NAME,
      }));
    }
  }

  function clearSessionCookie(res) {
    res.append('Set-Cookie', buildSessionCookie('', { clear: true }));
    if (config.sessionCookieName() !== config.LEGACY_SESSION_COOKIE_NAME) {
      res.append('Set-Cookie', buildSessionCookie('', {
        clear: true,
        name: config.LEGACY_SESSION_COOKIE_NAME,
      }));
    }
  }

  // Resolve only the HttpOnly cookie. Authorization bearer headers are ignored.
  async function resolveSessionUser(req) {
    const cookieToken = getCookieToken(req);
    if (cookieToken) {
      const details = await verifySessionDetails(cookieToken);
      if (details) return { ...details, via: 'cookie' };
    }
    return { user: null, sessionVersion: null, via: null };
  }

  // CSRF defense for cookie-authenticated state-changing requests. A cookie is
  // sent automatically by the browser on cross-site requests, so a mutating
  // request authenticated via cookie must also carry an Origin/Referer that is in
  // the allowed-origins allowlist. SameSite=Lax already blocks most cross-site
  // cookie sends; this origin check is the explicit, testable second layer.
  const CSRF_SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

  function enforceCsrfForCookieAuth(req, res) {
    if (req.authVia !== 'cookie') return true;
    if (CSRF_SAFE_METHODS.has(req.method)) return true;
    const origin = req.headers.origin
      || (req.headers.referer ? originOf(req.headers.referer) : '');
    if (config.isAllowedOrigin(origin)) return true;
    // Same-origin requests are not a CSRF vector: a cross-site attacker's page cannot
    // make the browser send an Origin equal to this server's own Host. When Express
    // serves the built SPA itself (npm start, default :3000) the request is same-origin,
    // so accept it even if the FRONTEND_ORIGIN allowlist only lists the dev origin
    // (:5173). Cross-origin requests still require an explicit allowlist entry.
    if (!config.isProduction() && isSameOriginRequest(req, origin)) return true;
    res.status(403).json({ error: 'CSRF origin check failed.' });
    return false;
  }

  // Development/test fallback for an Express-served SPA. Scheme is part of an
  // origin, so same host over HTTP and HTTPS are not interchangeable. Production
  // uses only the explicit HTTPS FRONTEND_ORIGIN allowlist.
  function isSameOriginRequest(req, origin) {
    if (!origin) return false;
    const host = req.headers.host;
    if (!host) return false;
    try {
      return new URL(origin).origin === `${req.protocol}://${host}`;
    } catch {
      return false;
    }
  }

  function originOf(url) {
    try {
      return new URL(url).origin;
    } catch {
      return '';
    }
  }

  async function requireAuth(req, res, next) {
    if (req.method === 'OPTIONS') return next();

    const { user, sessionVersion, via } = await resolveSessionUser(req);
    if (!user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    req.user = user;
    req.authVia = via;
    req.sessionVersion = sessionVersion;
    req.session = { id: `user-${user.id}`, user };

    if (!enforceCsrfForCookieAuth(req, res)) return undefined;
    return next();
  }

  return {
    parseCookies, getCookieToken, hasSessionCookie, buildSessionCookie, setSessionCookie,
    clearSessionCookie, resolveSessionUser, enforceCsrfForCookieAuth, isSameOriginRequest,
    originOf, requireAuth,
  };
}

module.exports = { createSessionAuth };
