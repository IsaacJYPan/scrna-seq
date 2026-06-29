const express = require('express');
const cors = require('cors');
const { createProxyMiddleware } = require('http-proxy-middleware');
const multer = require('multer');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const db = require('./backend/database');
const { parseJobWorkerConfig } = require('./backend/jobWorker');

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

// Canonical, server-only derivation from a numeric owner user id + optional object
// id. This is the single source of truth for the R state key format; deriveRStateKey
// (the session-facing wrapper) delegates here, and the worker's read-only object
// inspection bridge is injected with this exact function so it derives the SAME key
// the /api/r/* proxy would — the client never controls the `user-${id}` prefix.
function deriveRObjectStateKey(ownerUserId, clientObjectId) {
  if (ownerUserId === undefined || ownerUserId === null || ownerUserId === '') {
    throw new Error('An owner user id is required to derive an R state key.');
  }
  const base = `user-${ownerUserId}`;
  const objectSegment = sanitizeObjectIdSegment(clientObjectId);
  return objectSegment ? `${base}:obj-${objectSegment}` : base;
}

function deriveRStateKey(user, clientObjectId) {
  if (!user || (user.id === undefined || user.id === null)) {
    throw new Error('Authenticated user is required to derive an R state key.');
  }
  return deriveRObjectStateKey(user.id, clientObjectId);
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

// Sanitize a server-generated id (proj_.../ds_...) into a single safe path
// segment. The ids are already server-controlled and hex-suffixed, but we strip
// anything non-alphanumeric/._- defensively before using them in a path.
function sanitizeIdSegment(value) {
  const seg = String(value || '').replace(/[^a-zA-Z0-9._-]/g, '');
  if (!seg || seg === '.' || seg === '..') throw new Error('Invalid storage id segment.');
  return seg;
}

// Store an uploaded dataset file under a SERVER-CHOSEN key inside the controlled
// vault root. The client never influences the storage location: the path is
// derived from the authenticated user's vault, the (server-generated) project and
// dataset ids, and a sanitized, display-only filename. Returns the internal
// storage key (vault-relative posix path) plus the computed sha256 and byte size.
function storeDatasetFile(file, user, projectId, datasetId) {
  const safeName = (db.sanitizeDatasetFilename(file.originalname) || 'upload.bin')
    .replace(/[^a-zA-Z0-9._-]/g, '_');
  const root = path.join(
    getUserVaultDir(user), 'datasets',
    sanitizeIdSegment(projectId), sanitizeIdSegment(datasetId)
  );
  const destination = path.join(root, safeName);
  if (!isInsidePath(destination, root) || !isInsidePath(destination, getUserVaultDir(user))) {
    throw new Error('Invalid dataset storage destination.');
  }
  fs.mkdirSync(root, { recursive: true });
  const buf = fs.readFileSync(file.path);
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  fs.renameSync(file.path, destination);
  return {
    internalStorageKey: toPosixPath(path.relative(process.cwd(), destination)),
    sha256,
    fileSizeBytes: buf.length
  };
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

// Dataset ids are server-generated as `ds_` + lowercase hex. A client that
// supplies a `datasetId` (on analysis-object/job creation, or in a dataset route
// path) must match this shape, else the request is malformed (400) — distinct
// from a well-formed id that simply does not resolve (404).
const DATASET_ID_PATTERN = /^ds_[0-9a-f]+$/;
function isValidDatasetIdFormat(value) {
  return typeof value === 'string' && DATASET_ID_PATTERN.test(value);
}

// Analysis-object and job ids are server-generated as `ao_`/`job_` + lowercase
// hex. A client supplying one (in a project route path, or as a reference field)
// must match the shape, else the request is malformed (400) — distinct from a
// well-formed id that simply does not resolve (404).
const ANALYSIS_OBJECT_ID_PATTERN = /^ao_[0-9a-f]+$/;
function isValidAnalysisObjectIdFormat(value) {
  return typeof value === 'string' && ANALYSIS_OBJECT_ID_PATTERN.test(value);
}
const JOB_ID_PATTERN = /^job_[0-9a-f]+$/;
function isValidJobIdFormat(value) {
  return typeof value === 'string' && JOB_ID_PATTERN.test(value);
}

// Project-scoped provenance/figure ids are server-generated as `prov_`/`fig_` +
// lowercase hex. A client supplying one (in a project route path, or as a
// reference field) must match the shape, else the request is malformed (400) —
// distinct from a well-formed id that simply does not resolve (404).
const PROVENANCE_ID_PATTERN = /^prov_[0-9a-f]+$/;
function isValidProvenanceIdFormat(value) {
  return typeof value === 'string' && PROVENANCE_ID_PATTERN.test(value);
}
const FIGURE_ID_PATTERN = /^fig_[0-9a-f]+$/;
function isValidFigureIdFormat(value) {
  return typeof value === 'string' && FIGURE_ID_PATTERN.test(value);
}
// Job-artifact ids are server-generated as `art_` + lowercase hex. A client
// supplying one in a project route path must match the shape, else 400 — distinct
// from a well-formed id that simply does not resolve (404).
const ARTIFACT_ID_PATTERN = /^art_[0-9a-f]+$/;
function isValidArtifactIdFormat(value) {
  return typeof value === 'string' && ARTIFACT_ID_PATTERN.test(value);
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
const DEFAULT_AUTH_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_AUTH_RATE_LIMIT_MAX = 10;

// Parse a positive-integer env override, falling back to a safe default. A
// malformed value (non-numeric, NaN/Infinity, non-integer, or <= 0) must NEVER
// silently disable the limiter — that would turn a typo into an open door — so
// we fall CLOSED to the secure default instead of producing NaN (which would
// make `count > NaN` always false and skip limiting entirely).
function positiveIntFromEnv(rawValue, fallback) {
  if (rawValue === undefined || rawValue === null || String(rawValue).trim() === '') return fallback;
  const n = Number(rawValue);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return fallback;
  return n;
}

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

  function middleware(req, res, next) {
    if (rateLimitDisabled()) return next();

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
    // A row owned by another user — or a project-scoped row — is reported as a
    // generic 404 (no cross-user/project existence leak), not a raw 500.
    if (e.code === 'PROVENANCE_NOT_FOUND') {
      return res.status(404).json({ error: e.message });
    }
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
  // datasetId is now verified against the durable datasets model: if supplied it
  // must be a real dataset whose project the caller can write to (owner/admin/
  // analyst). A malformed id is rejected here (400); resolution + role enforcement
  // happen in the DB layer (404 unknown/inaccessible, 403 viewer), mapped below.
  if (body.datasetId !== undefined && body.datasetId !== null) {
    if (!isValidDatasetIdFormat(body.datasetId)) {
      return res.status(400).json({ error: 'Malformed dataset ID.' });
    }
  }

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
    if (e.code === 'PARENT_NOT_FOUND' || e.code === 'DATASET_NOT_FOUND') return res.status(404).json({ error: e.message });
    if (e.code === 'FORBIDDEN') return res.status(403).json({ error: e.message });
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
  // A supplied datasetId must be well-formed (else 400); resolution + role
  // enforcement happen in the DB layer (404 unknown/inaccessible, 403 viewer).
  if (body.datasetId !== undefined && body.datasetId !== null) {
    if (!isValidDatasetIdFormat(body.datasetId)) {
      return res.status(400).json({ error: 'Malformed dataset ID.' });
    }
  }

  try {
    const created = db.createJobForUser(req.user.id, {
      analysisObjectId: body.analysisObjectId,
      datasetId: body.datasetId,
      jobType: body.jobType,
      parameters: body.parameters
    });
    res.status(201).json(created);
  } catch (e) {
    if (e.code === 'ANALYSIS_OBJECT_NOT_FOUND' || e.code === 'DATASET_NOT_FOUND') return res.status(404).json({ error: e.message });
    if (e.code === 'FORBIDDEN') return res.status(403).json({ error: e.message });
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

// ── Organizations & Projects API ────────────────────────────────────────
// The first durable org/project authorization layer. Ids, owner, and role are
// server-controlled: clients may never supply an id, an owner/creator field, or
// a role on create/update. Read access is membership-scoped — an org/project the
// caller cannot access returns 404 (never revealing it exists); 403 is reserved
// for a known member who lacks the required role. This branch models membership
// + authorization ONLY; no existing user-scoped resource is migrated into
// project ownership (see docs/architecture.md).
app.use('/api/organizations', express.json());
app.use('/api/organizations', requireAuth);
app.use('/api/projects', express.json());
app.use('/api/projects', requireAuth);

// Body fields that name the row creator/owner. Ownership always derives from the
// session, so any client-supplied value here is rejected outright.
const REJECTED_CREATOR_FIELDS = ['createdByUserId', 'created_by_user_id'];

// Map the coded errors thrown by the org/project DB helpers to HTTP statuses.
// 404 for unknown/not-accessible resources (no existence leak), 403 for a known
// member lacking a role, 409 for membership conflicts (duplicate / last owner),
// 400 for input validation.
function sendOrgProjectError(res, e, context) {
  switch (e.code) {
    case 'NOT_FOUND':
    case 'MEMBER_NOT_FOUND':
    case 'USER_NOT_FOUND':
      return res.status(404).json({ error: e.message });
    case 'FORBIDDEN':
      return res.status(403).json({ error: e.message });
    case 'ALREADY_MEMBER':
    case 'LAST_OWNER':
      return res.status(409).json({ error: e.message });
    case 'INVALID_OWNER':
    case 'INVALID_ORG':
    case 'INVALID_NAME':
    case 'INVALID_DESCRIPTION':
    case 'INVALID_ROLE':
    case 'INVALID_EMAIL':
    case 'NO_FIELDS':
      return res.status(400).json({ error: e.message });
    default:
      console.error(`[${context}]`, e);
      return res.status(500).json({ error: 'Internal error.' });
  }
}

// Reject any client attempt to set a server-controlled field. Returns true (and
// has already sent a 400) when a forbidden field was present.
function rejectServerControlledFields(req, res, { rejectId = true, rejectRole = true, extra = [] } = {}) {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  if (rejectId && body.id !== undefined) {
    res.status(400).json({ error: 'Id is server-assigned and must not be provided.' });
    return true;
  }
  for (const field of [...REJECTED_OWNER_FIELDS, ...REJECTED_CREATOR_FIELDS, ...extra]) {
    if (body[field] !== undefined) {
      res.status(400).json({ error: `Field '${field}' is not allowed; it is server-controlled.` });
      return true;
    }
  }
  if (rejectRole && body.role !== undefined) {
    res.status(400).json({ error: 'Role is server-managed and must not be provided here.' });
    return true;
  }
  return false;
}

app.post('/api/organizations', (req, res) => {
  if (rejectServerControlledFields(req, res)) return;
  try {
    const org = db.createOrganizationForUser(req.user.id, { name: req.body.name });
    res.status(201).json(org);
  } catch (e) {
    sendOrgProjectError(res, e, 'Organizations');
  }
});

app.get('/api/organizations', (req, res) => {
  res.json(db.listOrganizationsForUser(req.user.id));
});

app.get('/api/organizations/:id', (req, res) => {
  const org = db.getOrganizationForUser(req.params.id, req.user.id);
  if (!org) return res.status(404).json({ error: 'Organization not found.' });
  res.json(org);
});

app.post('/api/projects', (req, res) => {
  if (rejectServerControlledFields(req, res)) return;
  try {
    const project = db.createProjectForUser(req.user.id, {
      organizationId: req.body.organizationId,
      name: req.body.name,
      description: req.body.description
    });
    res.status(201).json(project);
  } catch (e) {
    sendOrgProjectError(res, e, 'Projects');
  }
});

app.get('/api/projects', (req, res) => {
  res.json(db.listProjectsForUser(req.user.id));
});

app.get('/api/projects/:id', (req, res) => {
  const project = db.getProjectForUser(req.params.id, req.user.id);
  if (!project) return res.status(404).json({ error: 'Project not found.' });
  res.json(project);
});

app.patch('/api/projects/:id', (req, res) => {
  // A project cannot be reparented to another org in this branch.
  if (rejectServerControlledFields(req, res, { extra: ['organizationId', 'organization_id'] })) return;
  try {
    // owner/admin only; not-a-member → 404, member without role → 403.
    db.requireProjectRole(req.user.id, req.params.id, ['owner', 'admin']);
    db.updateProject(req.params.id, { name: req.body.name, description: req.body.description });
    res.json(db.getProjectForUser(req.params.id, req.user.id));
  } catch (e) {
    sendOrgProjectError(res, e, 'Projects');
  }
});

app.get('/api/projects/:id/members', (req, res) => {
  try {
    // Any project member (incl. viewer) may see the member list.
    db.requireProjectRole(req.user.id, req.params.id, ['owner', 'admin', 'analyst', 'viewer']);
    res.json(db.listProjectMembers(req.params.id));
  } catch (e) {
    sendOrgProjectError(res, e, 'Projects');
  }
});

app.post('/api/projects/:id/members', (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  // Members are added by exact email; reject any attempt to name a user/row id.
  if (rejectServerControlledFields(req, res, { rejectRole: false, extra: ['userId', 'user_id', 'projectId', 'project_id'] })) return;
  if (typeof body.email !== 'string' || !body.email.trim()) {
    return res.status(400).json({ error: 'A member email is required.' });
  }
  try {
    // owner/admin may manage members; the acting role is passed through so the
    // DB layer can enforce that only an owner grants the owner role.
    const actor = db.requireProjectRole(req.user.id, req.params.id, ['owner', 'admin']);
    const member = db.addProjectMemberByEmail(req.params.id, body.email, body.role, actor.role);
    res.status(201).json(member);
  } catch (e) {
    sendOrgProjectError(res, e, 'Projects');
  }
});

app.patch('/api/projects/:id/members/:userId', (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  if (typeof body.role !== 'string') {
    return res.status(400).json({ error: 'A role is required.' });
  }
  try {
    // owner/admin may manage members; the acting role is passed through so the
    // DB layer can enforce that only an owner grants or demotes the owner role.
    const actor = db.requireProjectRole(req.user.id, req.params.id, ['owner', 'admin']);
    const updated = db.updateProjectMemberRole(req.params.id, Number(req.params.userId), body.role, actor.role);
    res.json(updated);
  } catch (e) {
    sendOrgProjectError(res, e, 'Projects');
  }
});

app.delete('/api/projects/:id/members/:userId', (req, res) => {
  try {
    // owner/admin may manage members; the acting role is passed through so the
    // DB layer can enforce that only an owner removes an owner.
    const actor = db.requireProjectRole(req.user.id, req.params.id, ['owner', 'admin']);
    db.removeProjectMember(req.params.id, Number(req.params.userId), actor.role);
    res.json({ success: true });
  } catch (e) {
    sendOrgProjectError(res, e, 'Projects');
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

// ── Datasets API (project-scoped) ───────────────────────────────────────
// Durable, project-scoped dataset records. Access is governed by the caller's
// project role: owner/admin/analyst may create/register/update; any member
// (incl. viewer) may list/read metadata. Identity and storage location are
// server-controlled — clients may never supply an id, owner/creator/project
// field, storage key/uri, sha256/size, or a raw filesystem path. A dataset in a
// project the caller cannot access returns 404 (no existence leak); a known
// member lacking the role returns 403. (`/api/projects` already has express.json
// + requireAuth mounted above.) NOTE: there are intentionally no dataset
// download routes in this branch (see docs/architecture.md).

// Separate multer instance for dataset uploads so the dataset extension policy is
// independent of the R-vault upload filter. The declared file_type (validated
// against the DB allow-list) is the source of truth; the extension is a coarse
// guard. tenx_zip arrives as .zip, hence its inclusion here.
const datasetUpload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: Number(process.env.MAX_UPLOAD_BYTES || 512 * 1024 * 1024) },
  fileFilter: (req, file, cb) => {
    const allowed = new Set(['.csv', '.tsv', '.txt', '.mtx', '.gz', '.h5', '.h5ad', '.h5seurat', '.rds', '.zip']);
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (!allowed.has(ext)) return cb(new Error('Unsupported dataset file type'));
    cb(null, true);
  }
});

// Run multer only for multipart requests; JSON registration falls through to the
// express.json-parsed body. Surfaces multer errors (e.g. size/type) as 400.
function maybeDatasetMultipart(req, res, next) {
  if (String(req.headers['content-type'] || '').includes('multipart/form-data')) {
    return datasetUpload.single('file')(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.message });
      next();
    });
  }
  next();
}

function cleanupDatasetReqFile(req) {
  if (req.file) cleanupUploadedFiles([req.file]);
}

// Server-controlled fields a client may never set on dataset create/update,
// including any field that would let the client choose the storage location.
const REJECTED_DATASET_FIELDS = [
  'id', 'projectId', 'project_id', 'ownerUserId', 'owner_user_id',
  'createdByUserId', 'created_by_user_id', 'userId', 'user_id',
  'internalStorageKey', 'internal_storage_key', 'storageUri', 'storage_uri',
  'sha256', 'fileSizeBytes', 'file_size_bytes',
  'path', 'filePath', 'file_path', 'storagePath', 'storage_path'
];

function rejectDatasetServerFields(req, res) {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  for (const field of REJECTED_DATASET_FIELDS) {
    if (body[field] !== undefined) {
      cleanupDatasetReqFile(req);
      res.status(400).json({ error: `Field '${field}' is not allowed; it is server-controlled.` });
      return true;
    }
  }
  return false;
}

// Coerce a metadata/validation_errors field that may arrive as a JSON string
// (multipart form field) or a native object (JSON body). Returns { ok:false }
// when a non-empty string is not valid JSON.
function coerceDatasetJsonField(value) {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value === 'string') {
    if (value.trim() === '') return { ok: true, value: undefined };
    try { return { ok: true, value: JSON.parse(value) }; } catch { return { ok: false }; }
  }
  return { ok: true, value };
}

function sendDatasetError(res, e, context = 'Datasets') {
  switch (e.code) {
    case 'NOT_FOUND':
    case 'DATASET_NOT_FOUND':
      return res.status(404).json({ error: e.message });
    case 'FORBIDDEN':
      return res.status(403).json({ error: e.message });
    case 'INVALID_FILE_TYPE':
    case 'INVALID_UPLOAD_STATUS':
    case 'INVALID_VALIDATION_STATUS':
    case 'INVALID_VALIDATION_ERRORS':
    case 'INVALID_STATUS_COMBO':
    case 'INVALID_METADATA':
    case 'NO_FIELDS':
      return res.status(400).json({ error: e.message });
    default:
      console.error(`[${context}]`, e);
      return res.status(500).json({ error: 'Internal error.' });
  }
}

app.post('/api/projects/:projectId/datasets', maybeDatasetMultipart, (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  if (rejectDatasetServerFields(req, res)) return;

  const fileType = body.fileType !== undefined ? body.fileType : body.file_type;
  const meta = coerceDatasetJsonField(body.metadata);
  if (!meta.ok) { cleanupDatasetReqFile(req); return res.status(400).json({ error: 'metadata must be valid JSON.' }); }
  const verrs = coerceDatasetJsonField(body.validationErrors);
  if (!verrs.ok) { cleanupDatasetReqFile(req); return res.status(400).json({ error: 'validation_errors must be valid JSON.' }); }

  try {
    let dataset = db.createDatasetForProject(req.user.id, req.params.projectId, {
      fileType,
      originalFilename: body.originalFilename !== undefined
        ? body.originalFilename
        : (req.file ? req.file.originalname : undefined),
      uploadStatus: body.uploadStatus,
      validationStatus: body.validationStatus,
      metadata: meta.value,
      validationErrors: verrs.value
    });

    // If a file rode along, the server stores it under a server-chosen key and
    // records sha256 + size. A storage failure leaves the record `failed`, never
    // a misleading `uploaded`/`valid`.
    if (req.file) {
      try {
        const stored = storeDatasetFile(req.file, req.user, req.params.projectId, dataset.id);
        dataset = db.markDatasetUploaded(req.params.projectId, dataset.id, stored);
      } catch (storageErr) {
        console.error('[Datasets] Storage failed:', storageErr);
        db.markDatasetUploadFailed(req.params.projectId, dataset.id);
        cleanupDatasetReqFile(req);
        return res.status(500).json({ error: 'Dataset file storage failed.' });
      }
    }
    res.status(201).json(db.toPublicDataset(dataset));
  } catch (e) {
    cleanupDatasetReqFile(req);
    sendDatasetError(res, e);
  }
});

app.get('/api/projects/:projectId/datasets', (req, res) => {
  const filters = {};
  if (typeof req.query.fileType === 'string') filters.fileType = req.query.fileType;
  if (typeof req.query.uploadStatus === 'string') filters.uploadStatus = req.query.uploadStatus;
  if (typeof req.query.validationStatus === 'string') filters.validationStatus = req.query.validationStatus;
  try {
    const rows = db.listDatasetsForProject(req.user.id, req.params.projectId, filters);
    res.json(rows.map(db.toPublicDataset));
  } catch (e) {
    sendDatasetError(res, e);
  }
});

app.get('/api/projects/:projectId/datasets/:datasetId', (req, res) => {
  if (!isValidDatasetIdFormat(req.params.datasetId)) {
    return res.status(400).json({ error: 'Malformed dataset ID.' });
  }
  try {
    const dataset = db.getDatasetForProject(req.user.id, req.params.projectId, req.params.datasetId);
    if (!dataset) return res.status(404).json({ error: 'Dataset not found.' });
    res.json(db.toPublicDataset(dataset));
  } catch (e) {
    sendDatasetError(res, e);
  }
});

app.patch('/api/projects/:projectId/datasets/:datasetId', (req, res) => {
  if (!isValidDatasetIdFormat(req.params.datasetId)) {
    return res.status(400).json({ error: 'Malformed dataset ID.' });
  }
  if (rejectDatasetServerFields(req, res)) return;
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  try {
    const updated = db.updateDatasetForProject(req.user.id, req.params.projectId, req.params.datasetId, {
      uploadStatus: body.uploadStatus,
      validationStatus: body.validationStatus,
      validationErrors: body.validationErrors,
      metadata: body.metadata,
      originalFilename: body.originalFilename
    });
    res.json(db.toPublicDataset(updated));
  } catch (e) {
    sendDatasetError(res, e);
  }
});

// ── Project-scoped Analysis Objects & Jobs API ──────────────────────────
// Project association + project-member metadata/history visibility for analysis
// objects and jobs. Access is governed by the caller's project role: owner/admin/
// analyst may create; any member (incl. viewer) may list/read metadata/logs.
// Identity and scope are server-controlled — clients may never supply an id, an
// owner/creator field, a project field, or a job status; project_id comes from
// the route project. Cross-project references (dataset, parent object, linked
// objects) return 404. (`/api/projects` already has express.json + requireAuth
// mounted above.)
//
// IMPORTANT: this is project-scoped METADATA only. It does NOT make R execution/
// state project-shared — R state stays user/object-keyed (verifyRObjectOwnership
// is unchanged and still owner-verified). A project member seeing an object's
// metadata does NOT gain access to another user's live R session. There is no
// worker draining jobs in this branch. See docs/architecture.md.

// Map the coded errors thrown by the project-scoped analysis-object/job helpers
// to HTTP statuses: 404 for unknown/not-accessible (no existence leak), 403 for a
// known member lacking the role, 409 for a non-cancelable (terminal) job, 400 for
// input validation.
function sendProjectResourceError(res, e, context) {
  switch (e.code) {
    case 'NOT_FOUND':
    case 'PARENT_NOT_FOUND':
    case 'DATASET_NOT_FOUND':
    case 'ANALYSIS_OBJECT_NOT_FOUND':
    case 'RESULT_OBJECT_NOT_FOUND':
    case 'JOB_NOT_FOUND':
    case 'PROVENANCE_NOT_FOUND':
    case 'FIGURE_NOT_FOUND':
      return res.status(404).json({ error: e.message });
    case 'FORBIDDEN':
      return res.status(403).json({ error: e.message });
    case 'JOB_NOT_CANCELABLE':
      return res.status(409).json({ error: e.message });
    case 'INVALID_OBJECT_TYPE':
    case 'INVALID_METADATA':
    case 'INVALID_JOB_TYPE':
    case 'INVALID_PARAMETERS':
    case 'INVALID_PACKAGES':
    case 'INVALID_PARENT_IDS':
    case 'INVALID_PLOT_TYPE':
    case 'INVALID_OWNER':
      return res.status(400).json({ error: e.message });
    default:
      console.error(`[${context}]`, e);
      return res.status(500).json({ error: 'Internal error.' });
  }
}

// Reject any client attempt to set a server-controlled field on a project-scoped
// analysis-object/job create. Returns true (and has sent a 400) when one is
// present. project_id is taken from the route, never the body.
function rejectProjectResourceFields(req, res, { extra = [] } = {}) {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  if (body.id !== undefined) {
    res.status(400).json({ error: 'Id is server-assigned and must not be provided.' });
    return true;
  }
  const forbidden = [
    ...REJECTED_OWNER_FIELDS, ...REJECTED_CREATOR_FIELDS,
    'projectId', 'project_id', ...extra
  ];
  for (const field of forbidden) {
    if (body[field] !== undefined) {
      res.status(400).json({ error: `Field '${field}' is not allowed; it is server-controlled.` });
      return true;
    }
  }
  return false;
}

app.post('/api/projects/:projectId/analysis-objects', (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  // lineageRootId is server-derived; reject any client-supplied value alongside
  // the id/owner/creator/project fields.
  if (rejectProjectResourceFields(req, res, { extra: ['lineageRootId', 'lineage_root_id'] })) return;

  // Validate reference id shapes → 400 before touching the DB.
  if (body.parentObjectId !== undefined && body.parentObjectId !== null &&
      !isValidAnalysisObjectIdFormat(body.parentObjectId)) {
    return res.status(400).json({ error: 'Malformed parent object ID.' });
  }
  if (body.datasetId !== undefined && body.datasetId !== null &&
      !isValidDatasetIdFormat(body.datasetId)) {
    return res.status(400).json({ error: 'Malformed dataset ID.' });
  }
  // created-by provenance is user-scoped: the caller must own it (404 otherwise),
  // exactly as the owner-scoped route enforces. Provenance has no project.
  if (body.createdByProvenanceId !== undefined && body.createdByProvenanceId !== null) {
    if (typeof body.createdByProvenanceId !== 'string' || !db.getProvenance(body.createdByProvenanceId, req.user.email)) {
      return res.status(404).json({ error: 'Provenance record not found.' });
    }
  }

  try {
    const created = db.createProjectAnalysisObject(req.user.id, req.params.projectId, {
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
    sendProjectResourceError(res, e, 'ProjectAnalysisObjects');
  }
});

app.get('/api/projects/:projectId/analysis-objects', (req, res) => {
  const filters = {
    datasetId: typeof req.query.datasetId === 'string' ? req.query.datasetId : undefined,
    parentObjectId: typeof req.query.parentObjectId === 'string' ? req.query.parentObjectId : undefined,
    lineageRootId: typeof req.query.lineageRootId === 'string' ? req.query.lineageRootId : undefined,
    objectType: typeof req.query.objectType === 'string' ? req.query.objectType : undefined
  };
  try {
    res.json(db.listProjectAnalysisObjects(req.user.id, req.params.projectId, filters));
  } catch (e) {
    sendProjectResourceError(res, e, 'ProjectAnalysisObjects');
  }
});

app.get('/api/projects/:projectId/analysis-objects/:objectId', (req, res) => {
  if (!isValidAnalysisObjectIdFormat(req.params.objectId)) {
    return res.status(400).json({ error: 'Malformed analysis object ID.' });
  }
  try {
    const obj = db.getProjectAnalysisObject(req.user.id, req.params.projectId, req.params.objectId);
    if (!obj) return res.status(404).json({ error: 'Analysis object not found.' });
    res.json(obj);
  } catch (e) {
    sendProjectResourceError(res, e, 'ProjectAnalysisObjects');
  }
});

// ── Read-only analysis-object lineage (DAG) routes ───────────────────────────
// Role-checked, metadata-only lineage reads for project members (any role, incl.
// viewer, may read). The edge table is the graph source; single-parent
// parent_object_id / lineage_root_id remain compatibility/fast-path fields. There
// is intentionally NO public edge-create route in this branch (edges are created by
// the checkpoint helper / future server-side multi-parent operations). Responses
// are public-safe (edge/graph metadata only): no storage uri/path, R state key,
// claim token, or worker internal is ever in the edge or node projections. A
// malformed object id is 400; an object in another project (or legacy NULL-project)
// is 404; a non-member is 404; a member lacking the read role is 403.
app.get('/api/projects/:projectId/analysis-objects/:objectId/parents', (req, res) => {
  if (!isValidAnalysisObjectIdFormat(req.params.objectId)) {
    return res.status(400).json({ error: 'Malformed analysis object ID.' });
  }
  try {
    res.json(db.listProjectAnalysisObjectParents(req.user.id, req.params.projectId, req.params.objectId));
  } catch (e) {
    sendProjectResourceError(res, e, 'ProjectLineage');
  }
});

app.get('/api/projects/:projectId/analysis-objects/:objectId/children', (req, res) => {
  if (!isValidAnalysisObjectIdFormat(req.params.objectId)) {
    return res.status(400).json({ error: 'Malformed analysis object ID.' });
  }
  try {
    res.json(db.listProjectAnalysisObjectChildren(req.user.id, req.params.projectId, req.params.objectId));
  } catch (e) {
    sendProjectResourceError(res, e, 'ProjectLineage');
  }
});

app.get('/api/projects/:projectId/analysis-objects/:objectId/lineage', (req, res) => {
  if (!isValidAnalysisObjectIdFormat(req.params.objectId)) {
    return res.status(400).json({ error: 'Malformed analysis object ID.' });
  }
  try {
    res.json(db.getProjectAnalysisObjectLineage(req.user.id, req.params.projectId, req.params.objectId));
  } catch (e) {
    sendProjectResourceError(res, e, 'ProjectLineage');
  }
});

app.post('/api/projects/:projectId/jobs', (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  // Status is server-managed; a client cannot pick the initial status.
  if (body.status !== undefined) {
    return res.status(400).json({ error: 'Job status is server-managed and must not be provided.' });
  }
  if (rejectProjectResourceFields(req, res)) return;

  if (body.analysisObjectId !== undefined && body.analysisObjectId !== null &&
      !isValidAnalysisObjectIdFormat(body.analysisObjectId)) {
    return res.status(400).json({ error: 'Malformed analysis object ID.' });
  }
  if (body.resultAnalysisObjectId !== undefined && body.resultAnalysisObjectId !== null &&
      !isValidAnalysisObjectIdFormat(body.resultAnalysisObjectId)) {
    return res.status(400).json({ error: 'Malformed result analysis object ID.' });
  }
  if (body.datasetId !== undefined && body.datasetId !== null &&
      !isValidDatasetIdFormat(body.datasetId)) {
    return res.status(400).json({ error: 'Malformed dataset ID.' });
  }

  try {
    const created = db.createProjectJob(req.user.id, req.params.projectId, {
      analysisObjectId: body.analysisObjectId,
      resultAnalysisObjectId: body.resultAnalysisObjectId,
      datasetId: body.datasetId,
      jobType: body.jobType,
      parameters: body.parameters
    });
    res.status(201).json(created);
  } catch (e) {
    sendProjectResourceError(res, e, 'ProjectJobs');
  }
});

app.get('/api/projects/:projectId/jobs', (req, res) => {
  const filters = {
    status: typeof req.query.status === 'string' ? req.query.status : undefined,
    jobType: typeof req.query.jobType === 'string' ? req.query.jobType : undefined,
    analysisObjectId: typeof req.query.analysisObjectId === 'string' ? req.query.analysisObjectId : undefined,
    resultAnalysisObjectId: typeof req.query.resultAnalysisObjectId === 'string' ? req.query.resultAnalysisObjectId : undefined,
    datasetId: typeof req.query.datasetId === 'string' ? req.query.datasetId : undefined
  };
  try {
    res.json(db.listProjectJobs(req.user.id, req.params.projectId, filters));
  } catch (e) {
    sendProjectResourceError(res, e, 'ProjectJobs');
  }
});

app.get('/api/projects/:projectId/jobs/:jobId', (req, res) => {
  if (!isValidJobIdFormat(req.params.jobId)) {
    return res.status(400).json({ error: 'Malformed job ID.' });
  }
  try {
    const job = db.getProjectJob(req.user.id, req.params.projectId, req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found.' });
    res.json(job);
  } catch (e) {
    sendProjectResourceError(res, e, 'ProjectJobs');
  }
});

app.get('/api/projects/:projectId/jobs/:jobId/logs', (req, res) => {
  if (!isValidJobIdFormat(req.params.jobId)) {
    return res.status(400).json({ error: 'Malformed job ID.' });
  }
  try {
    const job = db.getProjectJob(req.user.id, req.params.projectId, req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found.' });
    res.json({ id: job.id, status: job.status, logs: job.logs, error: job.error });
  } catch (e) {
    sendProjectResourceError(res, e, 'ProjectJobs');
  }
});

app.post('/api/projects/:projectId/jobs/:jobId/cancel', (req, res) => {
  if (!isValidJobIdFormat(req.params.jobId)) {
    return res.status(400).json({ error: 'Malformed job ID.' });
  }
  try {
    const job = db.cancelProjectJob(req.user.id, req.params.projectId, req.params.jobId);
    res.json(job);
  } catch (e) {
    sendProjectResourceError(res, e, 'ProjectJobs');
  }
});

// ── Project-scoped provenance metadata ──────────────────────────────────
// Append-only provenance records associated with a project, readable by project
// members by role. project_id comes from the route; the responsible actor from
// the session. There is no update/delete route (provenance is append-only). R
// execution/state is untouched — this is metadata only. See docs/architecture.md.
app.post('/api/projects/:projectId/provenance', (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  // Reject server-controlled id/owner/creator/project fields, plus the actor email
  // (server-derived from the session, never the body).
  if (rejectProjectResourceFields(req, res, { extra: ['userEmail', 'user_email'] })) return;

  // Validate reference id shapes → 400 before touching the DB (well-formed-but-
  // unresolved / cross-project ids become 404 in the DB layer).
  if (body.datasetId !== undefined && body.datasetId !== null && !isValidDatasetIdFormat(body.datasetId)) {
    return res.status(400).json({ error: 'Malformed dataset ID.' });
  }
  if (body.analysisObjectId !== undefined && body.analysisObjectId !== null && !isValidAnalysisObjectIdFormat(body.analysisObjectId)) {
    return res.status(400).json({ error: 'Malformed analysis object ID.' });
  }
  if (body.jobId !== undefined && body.jobId !== null && !isValidJobIdFormat(body.jobId)) {
    return res.status(400).json({ error: 'Malformed job ID.' });
  }
  if (body.resultAnalysisObjectId !== undefined && body.resultAnalysisObjectId !== null && !isValidAnalysisObjectIdFormat(body.resultAnalysisObjectId)) {
    return res.status(400).json({ error: 'Malformed result analysis object ID.' });
  }
  if (body.parentIds !== undefined && body.parentIds !== null) {
    if (!Array.isArray(body.parentIds)) {
      return res.status(400).json({ error: 'parentIds must be an array.' });
    }
    for (const parentRef of body.parentIds) {
      if (!isValidProvenanceIdFormat(parentRef)) {
        return res.status(400).json({ error: 'Malformed parent provenance ID.' });
      }
    }
  }

  try {
    const created = db.createProjectProvenance(req.user.id, req.params.projectId, {
      datasetId: body.datasetId,
      analysisObjectId: body.analysisObjectId,
      jobId: body.jobId,
      resultAnalysisObjectId: body.resultAnalysisObjectId,
      parentIds: body.parentIds,
      timestamp: body.timestamp,
      language: body.language,
      languageVersion: body.languageVersion,
      packages: body.packages,
      script: body.script,
      parameters: body.parameters,
      operation: body.operation
    });
    res.status(201).json(created);
  } catch (e) {
    sendProjectResourceError(res, e, 'ProjectProvenance');
  }
});

app.get('/api/projects/:projectId/provenance', (req, res) => {
  const filters = {
    datasetId: typeof req.query.datasetId === 'string' ? req.query.datasetId : undefined,
    analysisObjectId: typeof req.query.analysisObjectId === 'string' ? req.query.analysisObjectId : undefined,
    jobId: typeof req.query.jobId === 'string' ? req.query.jobId : undefined,
    operation: typeof req.query.operation === 'string' ? req.query.operation : undefined
  };
  try {
    res.json(db.listProjectProvenance(req.user.id, req.params.projectId, filters));
  } catch (e) {
    sendProjectResourceError(res, e, 'ProjectProvenance');
  }
});

app.get('/api/projects/:projectId/provenance/:provenanceId', (req, res) => {
  if (!isValidProvenanceIdFormat(req.params.provenanceId)) {
    return res.status(400).json({ error: 'Malformed provenance ID.' });
  }
  try {
    const prov = db.getProjectProvenance(req.user.id, req.params.projectId, req.params.provenanceId);
    if (!prov) return res.status(404).json({ error: 'Provenance record not found.' });
    res.json(prov);
  } catch (e) {
    sendProjectResourceError(res, e, 'ProjectProvenance');
  }
});

// ── Project-scoped figure metadata ──────────────────────────────────────
// Figure metadata associated with a project, readable by members by role.
// SECURITY: a client may NOT supply file_path / storage key / raw path here, and
// the API never returns one — figure metadata is decoupled from any file-access
// surface (there is intentionally no figure download route in this branch).
// project_id comes from the route; the responsible actor from the session.
const REJECTED_FIGURE_PATH_FIELDS = [
  'filePath', 'file_path', 'storageKey', 'storage_key', 'storageUri', 'storage_uri',
  'internalStorageKey', 'internal_storage_key', 'path'
];

app.post('/api/projects/:projectId/figures', (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  // Reject server-controlled id/owner/creator/project fields, the actor email, and
  // — critically — any client-supplied file path / storage key.
  if (rejectProjectResourceFields(req, res, { extra: ['userEmail', 'user_email', ...REJECTED_FIGURE_PATH_FIELDS] })) return;

  if (body.analysisObjectId !== undefined && body.analysisObjectId !== null && !isValidAnalysisObjectIdFormat(body.analysisObjectId)) {
    return res.status(400).json({ error: 'Malformed analysis object ID.' });
  }
  if (body.jobId !== undefined && body.jobId !== null && !isValidJobIdFormat(body.jobId)) {
    return res.status(400).json({ error: 'Malformed job ID.' });
  }
  if (body.provenanceId !== undefined && body.provenanceId !== null && !isValidProvenanceIdFormat(body.provenanceId)) {
    return res.status(400).json({ error: 'Malformed provenance ID.' });
  }
  if (body.datasetId !== undefined && body.datasetId !== null && !isValidDatasetIdFormat(body.datasetId)) {
    return res.status(400).json({ error: 'Malformed dataset ID.' });
  }

  try {
    const created = db.createProjectFigure(req.user.id, req.params.projectId, {
      analysisObjectId: body.analysisObjectId,
      jobId: body.jobId,
      provenanceId: body.provenanceId,
      datasetId: body.datasetId,
      plotType: body.plotType,
      title: body.title,
      params: body.params,
      fileFormat: body.fileFormat,
      thumbnailB64: body.thumbnailB64
    });
    res.status(201).json(created);
  } catch (e) {
    sendProjectResourceError(res, e, 'ProjectFigures');
  }
});

app.get('/api/projects/:projectId/figures', (req, res) => {
  const filters = {
    analysisObjectId: typeof req.query.analysisObjectId === 'string' ? req.query.analysisObjectId : undefined,
    jobId: typeof req.query.jobId === 'string' ? req.query.jobId : undefined,
    provenanceId: typeof req.query.provenanceId === 'string' ? req.query.provenanceId : undefined,
    datasetId: typeof req.query.datasetId === 'string' ? req.query.datasetId : undefined,
    plotType: typeof req.query.plotType === 'string' ? req.query.plotType : undefined
  };
  try {
    res.json(db.listProjectFigures(req.user.id, req.params.projectId, filters));
  } catch (e) {
    sendProjectResourceError(res, e, 'ProjectFigures');
  }
});

app.get('/api/projects/:projectId/figures/:figureId', (req, res) => {
  if (!isValidFigureIdFormat(req.params.figureId)) {
    return res.status(400).json({ error: 'Malformed figure ID.' });
  }
  try {
    const fig = db.getProjectFigure(req.user.id, req.params.projectId, req.params.figureId);
    if (!fig) return res.status(404).json({ error: 'Figure not found.' });
    res.json(fig);
  } catch (e) {
    sendProjectResourceError(res, e, 'ProjectFigures');
  }
});

// ── Project-scoped job artifacts & checkpoints (read-only metadata) ──────
// Durable artifact/checkpoint METADATA produced by jobs, readable by project
// members by role. There is intentionally NO create/mutate route (artifact
// creation is worker/helper-driven) and NO download route — these endpoints
// return metadata only. The serializer omits storage_uri, so no internal/local
// path or storage key is ever exposed; claim tokens / worker internals are not in
// the artifact model at all. Legacy NULL-project artifacts never appear (the
// helpers always pin a real project_id). See docs/architecture.md.
app.get('/api/projects/:projectId/artifacts', (req, res) => {
  const filters = {
    jobId: typeof req.query.jobId === 'string' ? req.query.jobId : undefined,
    artifactType: typeof req.query.artifactType === 'string' ? req.query.artifactType : undefined,
    status: typeof req.query.status === 'string' ? req.query.status : undefined,
    analysisObjectId: typeof req.query.analysisObjectId === 'string' ? req.query.analysisObjectId : undefined,
    resultAnalysisObjectId: typeof req.query.resultAnalysisObjectId === 'string' ? req.query.resultAnalysisObjectId : undefined,
    datasetId: typeof req.query.datasetId === 'string' ? req.query.datasetId : undefined,
    provenanceId: typeof req.query.provenanceId === 'string' ? req.query.provenanceId : undefined,
    figureId: typeof req.query.figureId === 'string' ? req.query.figureId : undefined
  };
  try {
    res.json(db.listProjectArtifacts(req.user.id, req.params.projectId, filters));
  } catch (e) {
    sendProjectResourceError(res, e, 'ProjectArtifacts');
  }
});

app.get('/api/projects/:projectId/artifacts/:artifactId', (req, res) => {
  if (!isValidArtifactIdFormat(req.params.artifactId)) {
    return res.status(400).json({ error: 'Malformed artifact ID.' });
  }
  try {
    const artifact = db.getProjectArtifact(req.user.id, req.params.projectId, req.params.artifactId);
    if (!artifact) return res.status(404).json({ error: 'Artifact not found.' });
    res.json(artifact);
  } catch (e) {
    sendProjectResourceError(res, e, 'ProjectArtifacts');
  }
});

app.get('/api/projects/:projectId/jobs/:jobId/artifacts', (req, res) => {
  if (!isValidJobIdFormat(req.params.jobId)) {
    return res.status(400).json({ error: 'Malformed job ID.' });
  }
  const filters = {
    artifactType: typeof req.query.artifactType === 'string' ? req.query.artifactType : undefined,
    status: typeof req.query.status === 'string' ? req.query.status : undefined,
    resultAnalysisObjectId: typeof req.query.resultAnalysisObjectId === 'string' ? req.query.resultAnalysisObjectId : undefined
  };
  try {
    res.json(db.listProjectJobArtifacts(req.user.id, req.params.projectId, req.params.jobId, filters));
  } catch (e) {
    sendProjectResourceError(res, e, 'ProjectArtifacts');
  }
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

// ── Job worker (conservative, opt-in) ────────────────────────────────────────
// Disabled by default. The minimal drain loop only runs when ENABLE_JOB_WORKER is
// explicitly the string "true", so local/dev and tests stay worker-free unless they
// ask for it. It processes only registered handlers (currently the safe `generic`
// noop) — NO scientific pipeline execution. See backend/jobWorker.js and
// docs/architecture.md.
//
// Config parsing (parseJobWorkerConfig) is deterministic: invalid poll/lease values
// fall back to documented defaults with a sanitized warning, and any ENABLE_JOB_WORKER
// value other than exact "true" means disabled.

// How long shutdown waits for an in-flight worker tick to settle before giving up.
// Small + bounded so process shutdown never hangs forever on a stuck worker.
const WORKER_SHUTDOWN_TIMEOUT_MS = 10000;

let jobWorker = null;

/**
 * Start the opt-in worker if (and only if) the environment enables it. Idempotent:
 * at most one worker loop exists at a time — a second call while a worker is live
 * returns the existing worker instead of spawning a duplicate loop. Returns the
 * worker, or null when disabled.
 *
 * @param {object} env   environment-like object (defaults to process.env)
 * @param {object} deps  test seams: { createJobWorker, db, logger }
 */
function startJobWorkerIfEnabled(env = process.env, deps = {}) {
  if (jobWorker) return jobWorker; // never create a duplicate loop
  const logger = deps.logger || console;
  const config = parseJobWorkerConfig(env, { logger });
  if (!config.enabled) return null;
  const create = deps.createJobWorker || require('./backend/jobWorker').createJobWorker;
  // Wire the in-process worker to the local R backend so the r.runtime.check bridge
  // handler can reach it. We build the narrow R caller HERE and pass it as a function
  // (a closure over the secret), so the API token is NEVER placed as a plain field on
  // the worker options object — a function value carries no serializable secret. The
  // worker still runs ONLY the allowlisted, metadata-only R operation through it.
  const callR = require('./backend/rWorkerBridge').createDefaultRCaller({ port: PLUMBER_PORT, token: API_TOKEN });
  const worker = create({
    db: deps.db || db,
    pollIntervalMs: config.pollIntervalMs,
    leaseSeconds: config.leaseSeconds,
    callR,
    // Inject the canonical, server-only R state-key deriver so the read-only
    // r.object.inspect handler derives the SAME X-Object-ID the /api/r/* proxy would.
    // The client never controls this key (the user-prefix is server-derived).
    deriveRObjectStateKey,
    logger,
  });
  worker.start();
  jobWorker = worker;
  if (typeof logger.info === 'function') {
    logger.info(`[worker] Job worker started (id=${worker.workerId}).`);
  }
  return worker;
}

/** Stop the active worker (if any) and clear the singleton. Safe to call with no
 *  worker present and safe to call twice. Returns the worker's stop() promise, or
 *  undefined when there was nothing to stop. */
function stopJobWorker() {
  if (jobWorker) {
    const stopping = jobWorker.stop();
    jobWorker = null;
    return stopping;
  }
  return undefined;
}

/**
 * Graceful shutdown: await the worker's stop()/cleanup (bounded by a timeout so we
 * never hang forever), then stop accepting new connections, then exit. Used by the
 * SIGINT/SIGTERM handlers. Extracted + dependency-injected so the shutdown ordering
 * is directly testable without real signals.
 *
 * @param {object}   args
 * @param {object}   [args.server]    http.Server to close (best-effort; preserves the
 *                                    prior exit-driven teardown — exit still tears it
 *                                    down even if close() is slow).
 * @param {object}   [args.worker]    worker with an async stop(); if omitted, no wait.
 * @param {object}   [args.logger]    { warn, error, … } (default console).
 * @param {number}   [args.timeoutMs] max ms to wait for worker stop (default above).
 * @param {function} [args.exit]      process.exit seam (default process.exit).
 * @returns {Promise<number>} the exit code used (0 ok, 1 if worker stop failed/timed out).
 */
async function shutdownJobWorkerAndServer(args = {}) {
  const { server, worker } = args;
  const logger = args.logger || console;
  const timeoutMs = typeof args.timeoutMs === 'number' ? args.timeoutMs : WORKER_SHUTDOWN_TIMEOUT_MS;
  const exit = typeof args.exit === 'function' ? args.exit : (code) => process.exit(code);
  let exitCode = 0;

  // 1. Wait for the worker to stop, bounded by a timeout so a stuck tick cannot wedge
  //    shutdown. The timer is always cleared (finally) so no timer is leaked.
  if (worker && typeof worker.stop === 'function') {
    let timer = null;
    try {
      const stopped = Promise.resolve().then(() => worker.stop());
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(Object.assign(new Error('Worker stop timed out.'), { code: 'WORKER_STOP_TIMEOUT' })),
          timeoutMs
        );
      });
      await Promise.race([stopped, timeout]);
    } catch (err) {
      // Sanitized: code only, never a stack/message that could carry internals.
      const code = err && err.code ? err.code : 'error';
      if (typeof logger.error === 'function') {
        logger.error(`[worker] shutdown: worker stop failed (${code}); exiting non-zero.`);
      }
      exitCode = 1;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // 2. Stop accepting new connections (best-effort; exit finishes teardown).
  if (server && typeof server.close === 'function') {
    try { server.close(); } catch { /* best-effort; exit tears it down */ }
  }

  exit(exitCode);
  return exitCode;
}

// Start Server
if (require.main === module) {
  const httpServer = app.listen(PORT, () => {
    console.log(`Node.js Web Server running on http://localhost:${PORT}`);
    console.log(`Starting local R Plumber backend...`);
    startPlumber();
    startJobWorkerIfEnabled();
  });

  // Stop the worker cleanly on shutdown so no tick is left mid-claim. A single
  // `shuttingDown` latch makes this safe when SIGINT and SIGTERM arrive close
  // together (no double-shutdown race / double exit).
  let shuttingDown = false;
  const onShutdownSignal = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    const worker = jobWorker;
    jobWorker = null;
    shutdownJobWorkerAndServer({
      server: httpServer,
      worker,
      logger: console,
      timeoutMs: WORKER_SHUTDOWN_TIMEOUT_MS,
    });
  };
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, onShutdownSignal);
  }
}

module.exports = {
  app,
  resolveVaultPath,
  sanitizeVaultSegment,
  getUserVaultDir,
  isInsidePath,
  deriveRStateKey,
  deriveRObjectStateKey,
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
  authRateLimitMax,
  authRateLimitWindowMs,
  rateLimitDisabled,
  R_PROXY_VALIDATED_PATH_FIELDS,
  // Exposed for tests: opt-in job worker startup/shutdown wiring
  startJobWorkerIfEnabled,
  stopJobWorker,
  shutdownJobWorkerAndServer
};
