const express = require('express');
const cors = require('cors');
const { createProxyMiddleware } = require('http-proxy-middleware');
const multer = require('multer');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const db = require('./backend/database');

const app = express();
const PORT = process.env.PORT || 3000;
const PLUMBER_PORT = process.env.PLUMBER_PORT || 8000;
const SESSION_TTL_SECONDS = Number(process.env.SESSION_TTL_SECONDS || 12 * 60 * 60);

// Plumber auth token
const API_TOKEN = crypto.randomBytes(32).toString('hex');
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.SESSION_SECRET && process.env.NODE_ENV === 'production') {
  throw new Error('SESSION_SECRET must be set in production.');
}
if (!process.env.SESSION_SECRET) {
  console.warn('[Auth] SESSION_SECRET is not set. Using an ephemeral signing secret for this process.');
}

// Init Database
const DB_DIR = path.join(process.cwd(), 'data');
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
db.initDatabase(path.join(DB_DIR, 'dashboard.db'));
const UPLOAD_DIR = path.join(DB_DIR, 'uploads');
const VAULT_DIR = path.join(process.cwd(), 'vault');
for (const dir of [UPLOAD_DIR, VAULT_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function signPayload(payload) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
}

function issueSession(user) {
  const now = Math.floor(Date.now() / 1000);
  const payload = base64UrlJson({
    sub: String(user.id),
    email: user.email,
    displayName: user.displayName,
    iat: now,
    exp: now + SESSION_TTL_SECONDS
  });
  return `${payload}.${signPayload(payload)}`;
}

function verifySession(token) {
  if (!token || typeof token !== 'string') return null;
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return null;

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
  if (!parsed.email || !parsed.sub || !parsed.exp || parsed.exp < now) return null;

  const user = db.getUserByEmail(parsed.email);
  if (!user || String(user.id) !== String(parsed.sub)) return null;
  return user;
}

function getBearerToken(req) {
  const match = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

function requireAuth(req, res, next) {
  if (req.method === 'OPTIONS') return next();

  const user = verifySession(getBearerToken(req));
  if (!user) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  req.user = user;
  req.session = { id: `user-${user.id}`, user };
  next();
}

function validateSignupBody(body) {
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : '';

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: 'A valid email is required.' };
  if (password.length < 8) return { error: 'Password must be at least 8 characters.' };
  if (!displayName) return { error: 'Display name is required.' };
  return { email, password, displayName };
}

function validateLoginBody(body) {
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: 'A valid email is required.' };
  if (!password) return { error: 'Password is required.' };
  return { email, password };
}

function isInsidePath(childPath, parentPath) {
  const relative = path.relative(parentPath, childPath);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function sanitizeVaultSegment(value) {
  return String(value || '').replace(/[^a-zA-Z0-9]/g, '_');
}

// ── R state keying ──────────────────────────────────────────────────────
// The R Plumber backend stores the live Seurat object per "X-Object-ID".
// We MUST namespace that key by the authenticated user id (server-controlled,
// never client-supplied) so one user can never read or clobber another user's
// R state. Within a single user, we additionally separate state by an
// object/workspace id that the client may supply (the frontend already sends
// the active dataset id as X-Object-ID), so that two concurrent analyses by
// the same user do not collide on one shared global object.
//
// Security boundary: the `user-${id}` prefix is derived from the verified
// session, so a forged/guessed object id can only ever sub-partition the
// caller's OWN namespace — it can never reach another user's state.
// When no object id is supplied, the key is exactly `user-${id}`, preserving
// the previous behavior.
function sanitizeObjectIdSegment(value) {
  const cleaned = String(value || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 128);
  return cleaned.replace(/^[._-]+/, '');
}

function deriveRStateKey(user, clientObjectId) {
  if (!user || (user.id === undefined || user.id === null)) {
    throw new Error('Authenticated user is required to derive an R state key.');
  }
  const base = `user-${user.id}`;
  const objectSegment = sanitizeObjectIdSegment(clientObjectId);
  return objectSegment ? `${base}:obj-${objectSegment}` : base;
}

// Normalize a proxy sub-path (the part after the /api/r mount) before deciding
// whether it targets a test-only diagnostic endpoint. A raw
// `req.path.startsWith('/__test')` check is bypassable with double slashes
// (`//__test`) or an encoded slash (`%2F__test`), either of which would slip
// past the gate and reach the proxy/R. This decodes once, folds backslashes to
// forward slashes, and collapses repeated slashes so every spelling of the
// diagnostic prefix is recognized.
function isDiagnosticRProxyPath(rawPath) {
  let p = String(rawPath || '');
  try {
    p = decodeURIComponent(p);
  } catch {
    // Malformed percent-encoding: fall back to the raw value rather than throw.
  }
  p = p.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  if (!p.startsWith('/')) p = `/${p}`;
  return p === '/__test' || p.startsWith('/__test/');
}

function isProductionDiagnosticRProxyPath(reqPath) {
  return process.env.NODE_ENV === 'production' && isDiagnosticRProxyPath(reqPath);
}

function getUserVaultDir(user) {
  const segment = sanitizeVaultSegment(user?.email);
  if (!segment) throw new Error('Authenticated user email is required.');
  return path.join(VAULT_DIR, segment);
}

function isUnsafeUserPath(value) {
  if (typeof value !== 'string' || value.trim() === '') return true;
  const normalized = path.normalize(value);
  return path.isAbsolute(value) || normalized.split(/[\\/]+/).includes('..');
}

function resolveVaultPath(userPath, user) {
  if (isUnsafeUserPath(userPath)) {
    throw new Error('Path must be a relative vault path.');
  }

  const absolutePath = path.resolve(process.cwd(), userPath);
  if (!isInsidePath(absolutePath, getUserVaultDir(user))) {
    throw new Error('Path must stay within the authenticated user vault.');
  }

  return path.relative(process.cwd(), absolutePath);
}

function toPosixPath(value) {
  return value.split(path.sep).join('/');
}

function getSafeRelativeSegments(relativePath) {
  const rawSegments = String(relativePath || '').split(/[\\/]+/).filter(Boolean);
  const safeSegments = rawSegments.map(segment => segment.replace(/[^a-zA-Z0-9._-]/g, '_'));
  if (safeSegments.length === 0 || safeSegments.some(segment => !segment || segment === '.' || segment === '..')) {
    throw new Error('Invalid upload path.');
  }
  return safeSegments;
}

function moveUploadIntoUserVault(file, user, relativePath = file.originalname) {
  const batchId = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
  const segments = getSafeRelativeSegments(relativePath);
  const destinationRoot = path.join(getUserVaultDir(user), 'uploads', batchId);
  const destination = path.join(destinationRoot, ...segments);

  if (!isInsidePath(destination, destinationRoot) || !isInsidePath(destination, getUserVaultDir(user))) {
    throw new Error('Invalid upload destination.');
  }

  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.renameSync(file.path, destination);
  return toPosixPath(path.relative(process.cwd(), destination));
}

function moveDirectoryUploadIntoUserVault(files, user, relativePaths = []) {
  if (!files || files.length === 0) throw new Error('No files uploaded.');

  const batchId = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
  const destinationRoot = path.join(getUserVaultDir(user), 'uploads', batchId);
  const uploadedRelPaths = [];

  files.forEach((file, index) => {
    const relativePath = Array.isArray(relativePaths) ? relativePaths[index] : relativePaths;
    const segments = getSafeRelativeSegments(relativePath || file.originalname);
    const destination = path.join(destinationRoot, ...segments);
    if (!isInsidePath(destination, destinationRoot) || !isInsidePath(destination, getUserVaultDir(user))) {
      throw new Error('Invalid upload destination.');
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.renameSync(file.path, destination);
    uploadedRelPaths.push(toPosixPath(path.relative(destinationRoot, destination)));
  });

  const firstSegments = uploadedRelPaths.map(p => p.split('/')[0]).filter(Boolean);
  const commonTop = firstSegments.length > 0 && firstSegments.every(segment => segment === firstSegments[0])
    ? firstSegments[0]
    : '';
  const root = commonTop ? path.join(destinationRoot, commonTop) : destinationRoot;
  return toPosixPath(path.relative(process.cwd(), root));
}

function validateRProxyPaths(req, res, next) {
  try {
    if (isProductionDiagnosticRProxyPath(req.path)) {
      return res.status(404).json({ error: 'Not found' });
    }

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const values = [];
    // Scalar path fields from query string and JSON body (see allowlist above).
    for (const field of R_PROXY_VALIDATED_PATH_FIELDS) {
      if (field === 'paths') continue; // array field, handled below
      if (typeof req.query[field] === 'string') values.push(req.query[field]);
      if (typeof body[field] === 'string') values.push(body[field]);
    }
    // Array path field.
    if (Array.isArray(body.paths)) values.push(...body.paths.filter(v => typeof v === 'string'));

    for (const value of values) resolveVaultPath(value, req.user);

    if (req.path === '/load-rds') {
      const safePath = resolveVaultPath(body.path, req.user);
      if (path.extname(safePath).toLowerCase() !== '.rds') {
        return res.status(400).json({ error: 'Only RDS files in the application vault can be loaded.' });
      }
      req.body.path = safePath;
    }

    next();
  } catch (err) {
    console.warn('[Security] Rejected unsafe R path:', err.message);
    res.status(403).json({ error: 'Access denied: unsafe file path' });
  }
}

// ── R Object Ownership Verification ─────────────────────────────────────
// A client may name a specific analysis object via the X-Object-ID header so
// the R backend keeps that object's session state separate. The id is treated
// as untrusted: it must match a real analysis_objects row owned by the
// authenticated user before we let it influence the R state key. The R state
// key itself is then derived server-side by deriveRStateKey() (above), so the
// client never controls the `user-{id}` prefix and cannot reach another user's
// R state.
const OBJECT_ID_PATTERN = /^[A-Za-z0-9_-]{3,128}$/;

function isValidObjectIdFormat(value) {
  return typeof value === 'string' && OBJECT_ID_PATTERN.test(value);
}

// Middleware: verify any client-supplied X-Object-ID against the DB before it
// reaches R. Sanitizing the string (deriveRStateKey) is not enough on its own:
// the id must be a real persisted analysis_objects.id owned by req.user. On
// success the verified canonical id is stashed on req.verifiedObjectId, and the
// proxy derives the R state key from it. With no X-Object-ID, the request falls
// through to the legacy user-scoped key.
function verifyRObjectOwnership(req, res, next) {
  const rawObjectId = req.headers['x-object-id'];

  if (rawObjectId === undefined || rawObjectId === null || String(rawObjectId).trim() === '') {
    return next();
  }

  const objectId = String(rawObjectId).trim();
  if (!isValidObjectIdFormat(objectId)) {
    return res.status(400).json({ error: 'Malformed object ID.' });
  }

  // Mandatory DB ownership check — rejected before the request can reach R.
  if (!db.verifyAnalysisObjectOwner(req.user.id, objectId)) {
    // 404 (not 403) so we never reveal that another user's object exists.
    return res.status(404).json({ error: 'Analysis object not found.' });
  }

  req.verifiedObjectId = objectId;
  next();
}

function rTestDiagnosticsEnabled() {
  return process.env.ENABLE_R_TEST_DIAGNOSTICS === 'true' && process.env.NODE_ENV !== 'production';
}

// ── Auth rate limiting ──────────────────────────────────────────────────────
// Defense-in-depth against credential stuffing / signup abuse. A small,
// dependency-free fixed-window limiter keyed by client IP is sufficient for
// this single-node app; a multi-node deployment would swap this for a shared
// store (e.g. Redis). The window/limit are read per-request from the
// environment so tests can tighten them deterministically without re-importing
// the module, and each limiter exposes reset() so tests can clear state between
// cases (preventing rate-limit leakage across tests).
function authRateLimitWindowMs() {
  return Number(process.env.AUTH_RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000);
}
function authRateLimitMax() {
  return Number(process.env.AUTH_RATE_LIMIT_MAX || 10);
}

function createRateLimiter() {
  const hits = new Map(); // ip -> { count, resetAt }

  function middleware(req, res, next) {
    if (process.env.DISABLE_RATE_LIMIT === 'true') return next();

    const windowMs = authRateLimitWindowMs();
    const max = authRateLimitMax();
    const key = req.ip || req.socket?.remoteAddress || 'unknown';
    const now = Date.now();

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

  middleware.reset = () => hits.clear();
  return middleware;
}

// Separate limiters per endpoint so login attempts and signup attempts do not
// share (or exhaust) one another's budget.
const loginRateLimiter = createRateLimiter();
const signupRateLimiter = createRateLimiter();

// ── R proxy path-field validation allowlist ─────────────────────────────────
// Single source of truth for which request fields validateRProxyPaths treats as
// vault paths before proxying to R. backend/r-path-drift.test.js asserts that
// every field feeding R's validate_path() in r-backend/plumber.R is covered
// here, so a new R path-like field can't silently bypass Node-side validation.
const R_PROXY_VALIDATED_PATH_FIELDS = ['path', 'csv_path', 'paths'];

// Middleware
app.use(cors({ origin: process.env.FRONTEND_URL || 'http://localhost:5173' }));
// Do not use express.json() globally, as it consumes the body stream and breaks http-proxy-middleware for POST requests.
// ── Auth Endpoints ────────────────────────────────────────────────────────
app.use('/api/auth', express.json());
app.post('/api/auth/signup', signupRateLimiter, (req, res) => {
  const validated = validateSignupBody(req.body || {});
  if (validated.error) return res.status(400).json({ error: validated.error });

  try {
    const user = db.createUser(validated.email, validated.password, validated.displayName);
    if (user.error) return res.status(409).json({ error: user.error });

    res.status(201).json({ success: true, token: issueSession(user), user });
  } catch (err) {
    console.error('[Auth] Signup failed:', err);
    res.status(500).json({ error: 'Signup failed' });
  }
});

app.post('/api/auth/login', loginRateLimiter, (req, res) => {
  const validated = validateLoginBody(req.body || {});
  if (validated.error) return res.status(400).json({ error: validated.error });

  try {
    const user = db.verifyUser(validated.email, validated.password);
    if (user.error) return res.status(401).json({ error: 'Invalid email or password.' });

    res.json({ success: true, token: issueSession(user), user });
  } catch (err) {
    console.error('[Auth] Login failed:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ── Database API Endpoints ──────────────────────────────────────────────
app.use('/api/db', express.json());
app.use('/api/db', requireAuth);

app.get('/api/db/provenance', (req, res) => {
  res.json(db.getAllProvenance(req.user.email));
});

app.post('/api/db/provenance', (req, res) => {
  const env = { ...req.body, userEmail: req.user.email };
  try {
    const id = db.saveProvenance(env);
    res.json({ id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/db/provenance/:id', (req, res) => {
  res.json(db.getProvenance(req.params.id, req.user.email));
});

app.get('/api/db/provenance-chain/:id', (req, res) => {
  res.json(db.getProvenanceChain(req.params.id, req.user.email));
});

app.delete('/api/db/provenance/:id', (req, res) => {
  res.json({ success: db.deleteProvenance(req.params.id, req.user.email) });
});

app.get('/api/db/figures', (req, res) => {
  res.json(db.getFiguresByUser(req.user.email));
});

app.post('/api/db/figures', (req, res) => {
  try {
    const id = db.saveFigure({ ...req.body, userEmail: req.user.email });
    res.json({ id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/db/figures/:id', (req, res) => {
  res.json({ success: db.deleteFigure(req.params.id, req.user.email) });
});

// Cache Endpoints
app.post('/api/db/cache-key', (req, res) => {
  const { operation, params, dataVersion, parentIds } = req.body;
  res.json({ key: db.makeCacheKey(operation, params, dataVersion, parentIds, req.user.email) });
});

app.get('/api/db/cache/:key', (req, res) => {
  res.json(db.getCachedResult(req.params.key, req.user.email));
});

app.post('/api/db/cache/:key', (req, res) => {
  const { provenanceId, resultData } = req.body;
  try {
    db.setCachedResult(req.params.key, provenanceId, resultData, req.user.email);
    res.json({ success: true });
  } catch (e) {
    res.status(403).json({ error: e.message });
  }
});

app.delete('/api/db/cache', (req, res) => {
  db.clearCache(req.user.email);
  res.json({ success: true });
});

// ── Analysis Objects API ────────────────────────────────────────────────
// Durable, ownership-scoped analysis object identity. Object ids are issued by
// the server; clients may never choose an id or assert ownership.
app.use('/api/analysis-objects', express.json());
app.use('/api/analysis-objects', requireAuth);

const REJECTED_OWNER_FIELDS = ['userId', 'user_id', 'ownerUserId', 'owner_user_id'];

app.post('/api/analysis-objects', (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};

  // Object ids are server-issued. Reject any client attempt to choose one.
  if (body.id !== undefined) {
    return res.status(400).json({ error: 'Object id is server-assigned and must not be provided.' });
  }
  // Ownership is derived from the session only — never from the request body.
  for (const field of REJECTED_OWNER_FIELDS) {
    if (body[field] !== undefined) {
      return res.status(400).json({ error: `Field '${field}' is not allowed; ownership is derived from the session.` });
    }
  }

  // Validate linked-resource ownership before creating anything. 404 (not 403)
  // so we never reveal that another user's resource exists.
  if (body.parentObjectId !== undefined && body.parentObjectId !== null) {
    if (typeof body.parentObjectId !== 'string' || !db.getAnalysisObjectForUser(body.parentObjectId, req.user.id)) {
      return res.status(404).json({ error: 'Parent analysis object not found.' });
    }
  }
  if (body.createdByProvenanceId !== undefined && body.createdByProvenanceId !== null) {
    if (typeof body.createdByProvenanceId !== 'string' || !db.getProvenance(body.createdByProvenanceId, req.user.email)) {
      return res.status(404).json({ error: 'Provenance record not found.' });
    }
  }
  // NOTE: there is no durable datasets table yet, so datasetId is accepted as
  // an opaque nullable tag. Dataset ownership will be enforced once a datasets
  // model lands (see docs/architecture.md).

  try {
    const created = db.createAnalysisObjectForUser(req.user.id, {
      datasetId: body.datasetId,
      parentObjectId: body.parentObjectId,
      objectType: body.objectType,
      displayName: body.displayName,
      storageUri: body.storageUri,
      objectHash: body.objectHash,
      metadata: body.metadata,
      createdByProvenanceId: body.createdByProvenanceId
    });
    res.status(201).json(created);
  } catch (e) {
    if (e.code === 'PARENT_NOT_FOUND') return res.status(404).json({ error: e.message });
    if (['INVALID_OBJECT_TYPE', 'INVALID_METADATA', 'INVALID_OWNER'].includes(e.code)) {
      return res.status(400).json({ error: e.message });
    }
    console.error('[AnalysisObjects] Create failed:', e);
    res.status(500).json({ error: 'Failed to create analysis object.' });
  }
});

app.get('/api/analysis-objects', (req, res) => {
  const filters = {
    datasetId: typeof req.query.datasetId === 'string' ? req.query.datasetId : undefined,
    parentObjectId: typeof req.query.parentObjectId === 'string' ? req.query.parentObjectId : undefined,
    lineageRootId: typeof req.query.lineageRootId === 'string' ? req.query.lineageRootId : undefined,
    objectType: typeof req.query.objectType === 'string' ? req.query.objectType : undefined
  };
  res.json(db.listAnalysisObjectsForUser(req.user.id, filters));
});

app.get('/api/analysis-objects/:id', (req, res) => {
  const obj = db.getAnalysisObjectForUser(req.params.id, req.user.id);
  if (!obj) return res.status(404).json({ error: 'Analysis object not found.' });
  res.json(obj);
});

// ── Jobs API ────────────────────────────────────────────────────────────
// Durable, ownership-scoped records for long-running analysis work. Job ids
// and status are server-managed; clients may never choose an id, assert
// ownership, or set a status. This is the foundation for backgrounding R work
// — there is no worker draining jobs yet (see docs/architecture.md).
app.use('/api/jobs', express.json());
app.use('/api/jobs', requireAuth);

app.post('/api/jobs', (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};

  // Job ids are server-issued. Reject any client attempt to choose one.
  if (body.id !== undefined) {
    return res.status(400).json({ error: 'Job id is server-assigned and must not be provided.' });
  }
  // Ownership is derived from the session only — never from the request body.
  for (const field of REJECTED_OWNER_FIELDS) {
    if (body[field] !== undefined) {
      return res.status(400).json({ error: `Field '${field}' is not allowed; ownership is derived from the session.` });
    }
  }
  // Status is server-managed; a client cannot pick the initial status.
  if (body.status !== undefined) {
    return res.status(400).json({ error: 'Job status is server-managed and must not be provided.' });
  }

  try {
    const created = db.createJobForUser(req.user.id, {
      analysisObjectId: body.analysisObjectId,
      jobType: body.jobType,
      parameters: body.parameters
    });
    res.status(201).json(created);
  } catch (e) {
    if (e.code === 'ANALYSIS_OBJECT_NOT_FOUND') return res.status(404).json({ error: e.message });
    if (['INVALID_JOB_TYPE', 'INVALID_PARAMETERS', 'INVALID_OWNER'].includes(e.code)) {
      return res.status(400).json({ error: e.message });
    }
    console.error('[Jobs] Create failed:', e);
    res.status(500).json({ error: 'Failed to create job.' });
  }
});

app.get('/api/jobs', (req, res) => {
  const filters = {
    status: typeof req.query.status === 'string' ? req.query.status : undefined,
    jobType: typeof req.query.jobType === 'string' ? req.query.jobType : undefined,
    analysisObjectId: typeof req.query.analysisObjectId === 'string' ? req.query.analysisObjectId : undefined,
    resultAnalysisObjectId: typeof req.query.resultAnalysisObjectId === 'string' ? req.query.resultAnalysisObjectId : undefined
  };
  res.json(db.listJobsForUser(req.user.id, filters));
});

app.get('/api/jobs/:id', (req, res) => {
  const job = db.getJobForUser(req.params.id, req.user.id);
  if (!job) return res.status(404).json({ error: 'Job not found.' });
  res.json(job);
});

app.get('/api/jobs/:id/logs', (req, res) => {
  const job = db.getJobForUser(req.params.id, req.user.id);
  if (!job) return res.status(404).json({ error: 'Job not found.' });
  res.json({ id: job.id, status: job.status, logs: job.logs, error: job.error });
});

app.post('/api/jobs/:id/cancel', (req, res) => {
  try {
    const job = db.cancelJobForUser(req.user.id, req.params.id);
    res.json(job);
  } catch (e) {
    if (e.code === 'JOB_NOT_FOUND') return res.status(404).json({ error: e.message });
    if (e.code === 'JOB_NOT_CANCELABLE') return res.status(409).json({ error: e.message });
    console.error('[Jobs] Cancel failed:', e);
    res.status(500).json({ error: 'Failed to cancel job.' });
  }
});

// ── File Upload API (Replacing Desktop Dialogs) ─────────────────────────
// For a cloud app, the user cannot pick a local path and send it to R.
// They must upload the file to the Node.js server, which places it somewhere R can read.
const upload = multer({
  dest: UPLOAD_DIR,
  preservePath: true,
  limits: { fileSize: Number(process.env.MAX_UPLOAD_BYTES || 512 * 1024 * 1024) },
  fileFilter: (req, file, cb) => {
    const allowed = new Set(['.csv', '.tsv', '.txt', '.mtx', '.gz', '.h5', '.h5ad', '.h5seurat', '.rds']);
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (!allowed.has(ext)) {
      return cb(new Error('Unsupported upload file type'));
    }
    cb(null, true);
  }
});

function cleanupUploadedFiles(files) {
  for (const file of files.filter(Boolean)) {
    try {
      if (file.path && fs.existsSync(file.path)) fs.unlinkSync(file.path);
    } catch (err) {
      console.warn('[Upload] Failed to clean up temporary file:', err.message);
    }
  }
}

app.post('/api/upload', requireAuth, (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    try {
      const safePath = moveUploadIntoUserVault(req.file, req.user);
      res.json({ path: safePath, originalName: req.file.originalname });
    } catch (e) {
      cleanupUploadedFiles([req.file]);
      res.status(400).json({ error: e.message });
    }
  });
});

app.post('/api/upload-directory', requireAuth, (req, res) => {
  upload.array('files', Number(process.env.MAX_UPLOAD_FILES || 10000))(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No files uploaded' });

    try {
      const relativePaths = req.body.relativePaths || [];
      const safeRoot = moveDirectoryUploadIntoUserVault(req.files, req.user, relativePaths);
      res.json({ path: safeRoot, count: req.files.length });
    } catch (e) {
      cleanupUploadedFiles(req.files || []);
      res.status(400).json({ error: e.message });
    }
  });
});

// ── R Plumber Proxy ─────────────────────────────────────────────────────
// Forward all /api/r/* requests to localhost:8000/*
app.use('/api/r', requireAuth);
app.use('/api/r', express.json({ limit: '10mb', type: ['application/json', 'application/*+json'] }));

// Gate test-only diagnostic endpoints. They must return 404 in production (or
// whenever diagnostics are disabled) BEFORE the request can reach the proxy/R.
app.use('/api/r', (req, res, next) => {
  // Use the normalized check so //__test, /%2F__test, etc. cannot slip past the
  // gate and reach the proxy when diagnostics are disabled / in production.
  if (isDiagnosticRProxyPath(req.path)) {
    if (!rTestDiagnosticsEnabled()) {
      return res.status(404).json({ error: 'Not found' });
    }
  }
  next();
});

app.use('/api/r', validateRProxyPaths);
// Verify any client-supplied X-Object-ID against the DB BEFORE proxying to R,
// so unknown/not-owned/malformed object ids never reach the R backend.
app.use('/api/r', verifyRObjectOwnership);

// Test-only diagnostic: returns the server-derived R state key without
// contacting R, so object-ownership behavior can be asserted without a live R
// backend. Gated above (404 in production / when diagnostics are disabled).
app.get('/api/r/__test/state-key', (req, res) => {
  res.json({
    stateKey: deriveRStateKey(req.user, req.verifiedObjectId),
    objectId: req.verifiedObjectId || null
  });
});

app.use('/api/r', createProxyMiddleware({
  target: `http://127.0.0.1:${PLUMBER_PORT}`,
  changeOrigin: true,
  pathRewrite: {
    '^/api/r': '', // remove /api/r base
  },
  on: {
    proxyReq: (proxyReq, req, res) => {
      // Inject required headers for Plumber
      proxyReq.setHeader('X-API-Token', API_TOKEN);

      // Forward only the server-derived R state key. The user prefix is
      // server-controlled (from the verified session); the optional object
      // segment comes from req.verifiedObjectId, which verifyRObjectOwnership
      // has already confirmed is a DB-backed object owned by this user. A raw,
      // unverified client X-Object-ID never reaches R. See deriveRStateKey().
      proxyReq.setHeader('X-Object-ID', deriveRStateKey(req.user, req.verifiedObjectId));

      if (req.body && Object.keys(req.body).length > 0) {
        const bodyData = JSON.stringify(req.body);
        proxyReq.setHeader('Content-Type', 'application/json');
        proxyReq.setHeader('Content-Length', Buffer.byteLength(bodyData));
        proxyReq.write(bodyData);
      }
    }
  }
}));

// ── Static Frontend ─────────────────────────────────────────────────────
const distPath = path.join(__dirname, 'dist');
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
  // SPA routing fallback
  app.use((req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
  });
} else {
  app.get('/', (req, res) => {
    res.send('Frontend not built. Run `npm run build` or use Vite dev server.');
  });
}

// ── Launch R Plumber ────────────────────────────────────────────────────
function findRscript() {
  const candidates = [
    'C:\\Program Files\\R\\R-4.5.1\\bin\\Rscript.exe',
    'Rscript'
  ];
  for (const c of candidates) {
    // If it's absolute, check exists. If 'Rscript', just assume it works.
    if (path.isAbsolute(c) && fs.existsSync(c)) return c;
    if (c === 'Rscript') return c;
  }
  return 'Rscript';
}

function startPlumber() {
  const rscript = findRscript();
  const plumberScript = path.join(__dirname, 'r-backend', 'run.R');
  
  const rProcess = spawn(rscript, [plumberScript], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, API_TOKEN, PLUMBER_PORT: String(PLUMBER_PORT) }
  });

  rProcess.stdout.on('data', d => console.log(`[R] ${d.toString().trim()}`));
  rProcess.stderr.on('data', d => console.log(`[R:err] ${d.toString().trim()}`));
  rProcess.on('close', code => console.log(`R process exited with code ${code}`));

  process.on('exit', () => rProcess.kill());
}

// Start Server
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Node.js Web Server running on http://localhost:${PORT}`);
    console.log(`Starting local R Plumber backend...`);
    startPlumber();
  });
}

module.exports = {
  app,
  resolveVaultPath,
  sanitizeVaultSegment,
  getUserVaultDir,
  isInsidePath,
  deriveRStateKey,
  sanitizeObjectIdSegment,
  isProductionDiagnosticRProxyPath,
  isDiagnosticRProxyPath,
  // Exposed for tests + R proxy ownership verification
  issueSession,
  isValidObjectIdFormat,
  verifyRObjectOwnership,
  // Exposed for tests: auth rate limiting + R path-field drift guard
  loginRateLimiter,
  signupRateLimiter,
  R_PROXY_VALIDATED_PATH_FIELDS
};
