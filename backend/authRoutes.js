'use strict';

const crypto = require('crypto');
const express = require('express');
const { validateSignupBody, validateLoginBody, validatePasswordChangeBody, publicAuthUser } = require('./authValidation');

// Mounted at /api/auth after the deployment demo policies and the database
// readiness gate. Logout is exempt from that gate and initializes the
// database itself so a still-valid cookie is never discarded on an outage.
function authRoutes({
  db, config, storage, durableStorage, issueSession, setSessionCookie, clearSessionCookie,
  resolveSessionUser, enforceCsrfForCookieAuth, hasSessionCookie, originOf, isSameOriginRequest,
  requireAuth, initAppDatabase, signupRateLimiter, loginRateLimiter, passwordChangeRateLimiter,
}) {
  const router = express.Router();
  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  const authJson = express.json();


  router.post('/demo-guest', signupRateLimiter, async (req, res) => {
    if (!config.demoMode()) return res.status(404).json({ error: 'Not found' });
    const origin = req.headers.origin
      || (req.headers.referer ? originOf(req.headers.referer) : '');
    if (!config.isAllowedOrigin(origin)
        && (config.isProduction() || !isSameOriginRequest(req, origin))) {
      return res.status(403).json({ error: 'Request origin is not allowed.' });
    }
    let copiedKey = null;
    try {
      const template = await db.getDemoTemplateCheckpoint(config.demoTemplateProjectId());
      const nonce = crypto.randomBytes(18).toString('hex');
      const expiresAt = new Date(Date.now() + config.demoGuestTtlSeconds() * 1000).toISOString();
      const provisioned = await db.createDemoGuest(
        `guest-${nonce}@demo.invalid`, crypto.randomBytes(32).toString('base64url'), expiresAt
      );
      const importJobId = db.genId('job');
      copiedKey = storage.projectStorageFileKey(
        provisioned.project.id, 'checkpoints', importJobId, 'checkpoint.rds'
      );
      const copied = await durableStorage.copyVerified(template.storageUri, copiedKey, {
        checksumSha256: template.checksumSha256,
        sizeBytes: template.sizeBytes,
      });
      const workspace = await db.createDemoGuestCheckpoint({
        userId: provisioned.user.id,
        projectId: provisioned.project.id,
        jobId: importJobId,
        storageUri: copied.key,
        checksumSha256: copied.checksumSha256,
        sizeBytes: copied.sizeBytes,
        objectType: template.objectType,
        displayName: template.displayName || 'Curated scRNA-seq demo',
        templateProjectId: config.demoTemplateProjectId(),
        templateAnalysisObjectId: template.analysisObjectId,
        templateMetadata: template.metadata,
      });
      const token = issueSession(provisioned.user);
      setSessionCookie(res, token);
      return res.status(201).json({
        success: true,
        user: publicAuthUser(provisioned.user),
        expiresAt,
        project: provisioned.project,
        analysisObject: db.toPublicAnalysisObject(workspace.analysisObject),
      });
    } catch {
      if (copiedKey) {
        try { durableStorage.remove(copiedKey); } catch { /* best effort */ }
      }
      console.error('[Demo] Guest provisioning failed (DEMO_PROVISION_FAILED).');
      return res.status(503).json({ error: 'The curated demo is temporarily unavailable.' });
    }
  });

  // Reject disabled registration and apply the IP limiter before consuming an
  // attacker-controlled JSON body. Production signup bodies are never parsed.
  router.post('/signup', signupRateLimiter, authJson, async (req, res) => {
    const validated = validateSignupBody(req.body || {});
    if (validated.error) return res.status(400).json({ error: validated.error });

    try {
      const user = await db.createUser(validated.email, validated.password, validated.displayName);
      if (user.error) return res.status(409).json({ error: user.error });

      const token = issueSession(user);
      setSessionCookie(res, token);
      res.status(201).json({ success: true, user: publicAuthUser(user) });
    } catch (error) {
      if (error?.code === 'AUTH_HASH_BUSY') {
        res.setHeader('Retry-After', '1');
        return res.status(503).json({ error: 'Authentication is temporarily busy. Please try again.' });
      }
      console.error('[Auth] Signup failed (SIGNUP_FAILED).');
      return res.status(500).json({ error: 'Signup failed' });
    }
  });

  router.post('/login', loginRateLimiter, authJson, async (req, res) => {
    const validated = validateLoginBody(req.body || {});
    if (validated.error) return res.status(400).json({ error: validated.error });

    try {
      const user = await db.verifyUser(validated.email, validated.password);
      if (user.error) return res.status(401).json({ error: 'Invalid email or password.' });

      const token = issueSession(user);
      setSessionCookie(res, token);
      res.json({ success: true, user: publicAuthUser(user) });
    } catch (error) {
      if (error?.code === 'AUTH_HASH_BUSY') {
        res.setHeader('Retry-After', '1');
        return res.status(503).json({ error: 'Authentication is temporarily busy. Please try again.' });
      }
      console.error('[Auth] Login failed (LOGIN_FAILED).');
      return res.status(500).json({ error: 'Login failed' });
    }
  });

  // Current-session endpoint: lets the browser restore auth state from the
  // HttpOnly cookie (which JavaScript cannot read). Cookie authentication is the
  // only supported browser transport; bearer credentials are ignored.
  router.get('/session', requireAuth, (req, res) => {
    res.json({ user: publicAuthUser(req.user) });
  });

  router.get('/installation', requireAuth, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const identity = await require('./executionTargets').getServiceExecutionIdentity(db);
      res.json({ schema: 'traceomics.installation.v1', installationId: identity.id, userId: Number(req.user.id) });
    } catch {
      res.status(503).json({ error: 'The authenticated installation identity is unavailable. Check the service before submitting work.' });
    }
  });

  router.post('/change-password', passwordChangeRateLimiter, authJson, requireAuth, async (req, res) => {
    if (req.user.isDemoGuest) return res.status(403).json({ error: 'Demo accounts cannot change credentials.' });
    const validated = validatePasswordChangeBody(req.body || {}, req.user);
    if (validated.error) return res.status(400).json({ error: validated.error });

    try {
      const user = await db.changeUserPassword({
        userId: req.user.id,
        expectedSessionVersion: req.sessionVersion,
        currentPassword: validated.currentPassword,
        newPassword: validated.newPassword,
      });
      const token = issueSession(user);
      setSessionCookie(res, token);
      return res.json({
        success: true,
        allOtherSessionsRevoked: true,
        user: publicAuthUser(user),
      });
    } catch (error) {
      if (error?.code === 'INVALID_CURRENT_PASSWORD') {
        return res.status(400).json({ error: 'Current password is incorrect.' });
      }
      if (error?.code === 'INVALID_SESSION') {
        clearSessionCookie(res);
        return res.status(401).json({ error: 'Your session changed. Sign in again before changing your password.' });
      }
      if (error?.code === 'AUTH_HASH_BUSY') {
        res.setHeader('Retry-After', '1');
        return res.status(503).json({ error: 'Authentication is temporarily busy. Please try again.' });
      }
      console.error('[Auth] Password change failed (PASSWORD_CHANGE_FAILED).');
      return res.status(503).json({ error: 'Password change is temporarily unavailable.' });
    }
  });

  // Logout clears the browser cookie and atomically increments the authenticated
  // user's session version, revoking every outstanding session. A revocation
  // failure is a 503 rather than false success; an unauthenticated request only
  // clears any stale cookie. Any request carrying a session cookie is origin
  // checked before either action.
  router.post('/logout', async (req, res) => {
    const cookieWasPresent = hasSessionCookie(req);
    req.authVia = cookieWasPresent ? 'cookie' : null;
    if (cookieWasPresent) {
      if (!enforceCsrfForCookieAuth(req, res)) return undefined;
    }
    if (!cookieWasPresent) return res.json({ success: true, allSessionsRevoked: false });
    try {
      await initAppDatabase();
      const { user, sessionVersion } = await resolveSessionUser(req);
      if (!user) {
        clearSessionCookie(res);
        return res.json({ success: true, allSessionsRevoked: false });
      }
      await db.revokeUserSessions(user.id, sessionVersion);
      clearSessionCookie(res);
      return res.json({ success: true, allSessionsRevoked: true });
    } catch {
      // Preserve the still-valid cookie so the browser can retry. Clearing it
      // here would destroy the only credential capable of revoking other copies.
      console.error('[Auth] Session revocation failed (SESSION_REVOCATION_UNAVAILABLE).');
      return res.status(503).json({ error: 'Session revocation unavailable.' });
    }
  });

  return router;
}

module.exports = { authRoutes };
