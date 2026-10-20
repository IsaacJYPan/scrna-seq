const express = require('express');
const cors = require('cors');
const { createProxyServer } = require('httpxy');
const multer = require('multer');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const db = require('./backend/pgDatabase');
const analysisBranches = require('./backend/analysisBranches');
const experimentalDesign = require('./backend/experimentalDesign');
const projectAudit = require('./backend/projectAudit');
const researchExports = require('./backend/researchExports');
const { researchAnalysisRoutes } = require('./backend/researchAnalyses');
const {
  expertRSandboxEnabled,
  EXPERT_R_PROFILE,
  MAX_EXPERT_R_INPUT_BYTES,
  EXPERT_R_INPUT_EXTENSIONS,
  maxExpertRInputBytesForFilename,
  generateExpertRInputId,
  sanitizeExpertRInputFilename,
  allocateExpertRInputStorageKey,
} = require('./backend/expertR');
const config = require('./backend/config');
const passwordPolicy = require('./backend/passwordPolicy');
const storage = require('./backend/storage');
const { validateStoredDataset } = require('./backend/datasetValidation');
const rRuntime = require('./backend/rRuntime');
const { createWebHealthController } = require('./backend/webHealth');
const { createRuntimeReadinessController, SERVICE_COMPATIBILITY } = require('./backend/runtimeReadiness');
const { probeExpertRReadiness } = require('./backend/expertRAccess');
const { shutdownWebRuntime } = require('./backend/webShutdown');
const { startTopologyLockWatchdog } = require('./backend/webTopologyWatchdog');
const {
  sanitizeObjectIdSegment,
  deriveRObjectStateKey,
  deriveRStateKey,
} = require('./backend/rStateKeys');
const { parseJobWorkerConfig } = require('./backend/jobWorker');
const { validateSeuratPipelineParams } = require('./backend/seuratPipeline');
const { validateMultiSampleSeuratParams } = require('./backend/multiSampleSeuratPipeline');
const { validateSpatialSeuratParams } = require('./backend/spatialPipeline');
const { validateEnrichmentGseaParams } = require('./backend/enrichmentGsea');
const { validateCellChatInferenceParams } = require('./backend/cellChatInference');
const { validateExploratoryAnalysisParams } = require('./backend/exploratoryAnalysis');

// Validate the executable web role before resolving R configuration, creating
// directories, opening Postgres, or binding a socket. Importing the module in
// tests remains side-effect-free with respect to the production startup gate.
if (require.main === module) {
  const startupConfigErrors = config.validateProductionConfig({ role: 'web' });
  if (startupConfigErrors.length > 0) {
    console.error('[Config] Refusing to start - invalid runtime configuration:');
    for (const error of startupConfigErrors) console.error(`  - ${error}`);
    process.exit(1);
  }
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', config.trustProxyHops() || false);
const PORT = config.webPort();
const WEB_HOST = config.webHost();
const R_RUNTIME_CONFIG = rRuntime.resolveRRuntimeConfig(process.env, { role: 'web' });
const PLUMBER_PORT = R_RUNTIME_CONFIG.port;
const SUPPORTED_R_TARGET = 'R 4.5.x';

// Plumber auth token
const API_TOKEN = R_RUNTIME_CONFIG.token;
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.SESSION_SECRET && process.env.NODE_ENV === 'production') {
  throw new Error('SESSION_SECRET must be set in production.');
}
if (!process.env.SESSION_SECRET) {
  console.warn('[Auth] SESSION_SECRET is not set. Using an ephemeral signing secret for this process.');
}

// Init durable storage roots. The app database is Postgres-only and initialized
// asynchronously at startup/request time.
const DB_DIR = config.storageRoot();
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
const UPLOAD_DIR = path.join(DB_DIR, 'uploads');
const VAULT_DIR = config.vaultRoot();
for (const dir of [UPLOAD_DIR, VAULT_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
const durableStorage = storage.createLocalStorageProvider({ root: DB_DIR });
let webTopologyLock = null;
const webHealth = createWebHealthController({
  db,
  storageRoot: DB_DIR,
  vaultRoot: VAULT_DIR,
  probeR: () => probeRHealth(500),
  getTopologyLock: () => webTopologyLock,
});
const runtimeReadiness = createRuntimeReadinessController({ rRuntime: R_RUNTIME_CONFIG, db,
  storageRoot: DB_DIR, vaultRoot: VAULT_DIR,
  probePrivateR: () => probeExpertRReadiness(),
  workerMode: () => process.env.ENABLE_JOB_WORKER === 'true' ? 'embedded' : 'standalone' });

let appDatabaseReady = null;
function initAppDatabase() {
  if (!appDatabaseReady) {
    if (!config.hasPostgresConnection()) {
      appDatabaseReady = Promise.reject(
        new Error('Postgres is required. Set DATABASE_URL or PGHOST/PGDATABASE before starting the app.')
      );
      return appDatabaseReady;
    }
    appDatabaseReady = db.initSchema();
  }
  return appDatabaseReady;
}

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function signPayload(payload) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
}

const MAX_POSTGRES_BIGINT = 9223372036854775807n;

function isCanonicalPositiveIntegerString(value, maximum) {
  const text = String(value ?? '');
  if (!/^[1-9][0-9]{0,18}$/.test(text)) return false;
  try { return BigInt(text) <= maximum; } catch { return false; }
}

function isSafeUserIdString(value) {
  return isCanonicalPositiveIntegerString(value, BigInt(Number.MAX_SAFE_INTEGER));
}

function isSessionVersionString(value) {
  return isCanonicalPositiveIntegerString(value, MAX_POSTGRES_BIGINT);
}

function issueSession(user) {
  const sessionVersion = String(user && user.sessionVersion || '');
  const sessionEpoch = config.sessionEpoch();
  if (!user || !isSafeUserIdString(user.id) || !isSessionVersionString(sessionVersion)
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
      || typeof parsed.sub !== 'string' || !isSafeUserIdString(parsed.sub)
      || typeof parsed.sv !== 'string' || !isSessionVersionString(parsed.sv)
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

function validateSignupBody(body) {
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : '';

  if (email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: 'A valid email is required.' };
  if (!displayName || displayName.length > 200) return { error: 'Display name must be between 1 and 200 characters.' };
  const passwordResult = passwordPolicy.validateNewPassword(password, { email, displayName });
  if (passwordResult.error) return passwordResult;
  return { email, password, displayName };
}

function validateLoginBody(body) {
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';

  if (email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: 'A valid email is required.' };
  if (!password) return { error: 'Password is required.' };
  if (password.length > 1024) return { error: 'Password must be at most 1024 characters.' };
  return { email, password };
}

function validatePasswordChangeBody(body, user) {
  const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : '';
  const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';

  if (!currentPassword) return { error: 'Current password is required.' };
  if (currentPassword.length > 1024) return { error: 'Current password must be at most 1024 characters.' };
  if (currentPassword === newPassword) return { error: 'New password must be different from the current password.' };
  const passwordResult = passwordPolicy.validateNewPassword(newPassword, user);
  if (passwordResult.error) return passwordResult;
  return { currentPassword, newPassword };
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
// Canonical, server-only derivation from a numeric owner user id + optional object
// id. This is the single source of truth for the R state key format; deriveRStateKey
// (the session-facing wrapper) delegates here, and the worker's read-only object
// inspection bridge is injected with this exact function so it derives the SAME key
// the /api/r/* proxy would — the client never controls the `user-${id}` prefix.
// Normalize a proxy sub-path (the part after the /api/r mount) before deciding
// whether it targets a test-only diagnostic endpoint. A raw
// `req.path.startsWith('/__test')` check is bypassable with double slashes
// (`//__test`) or an encoded slash (`%2F__test`), either of which would slip
// past the gate and reach the proxy/R. This decodes once, folds backslashes to
// forward slashes, and collapses repeated slashes so every spelling of the
// diagnostic prefix is recognized.
function normalizeRProxyPath(rawPath) {
  let p = String(rawPath || '');
  try {
    p = decodeURIComponent(p);
  } catch {
    // Malformed percent-encoding: fall back to the raw value rather than throw.
  }
  p = p.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  if (!p.startsWith('/')) p = `/${p}`;
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p;
}

function publicAuthUser(user) {
  return {
    id: Number(user.id),
    email: user.email,
    displayName: user.displayName,
    createdAt: user.createdAt,
  };
}

// Several legacy Plumber GET endpoints mutate the caller's private live R
// object. For this proxy, cookie-authenticated GET therefore is not considered
// CSRF-safe; every proxied method needs an allowed same-site Origin/Referer.
function enforceRProxyCsrfForCookieAuth(req, res, next) {
  if (req.authVia !== 'cookie') return next();
  // Browser GET fetches often omit Origin, and the production no-referrer
  // policy intentionally removes Referer. This non-simple header is set by our
  // first-party client; a cross-site script cannot send it with cookies unless
  // the configured CORS preflight explicitly admits that origin.
  if (req.headers['x-traceomics-csrf'] === '1') return next();
  const origin = req.headers.origin
    || (req.headers.referer ? originOf(req.headers.referer) : '');
  if (config.isAllowedOrigin(origin)
      || (!config.isProduction() && isSameOriginRequest(req, origin))) return next();
  return res.status(403).json({ error: 'CSRF validation failed for the R request.' });
}

function isDiagnosticRProxyPath(rawPath) {
  const p = normalizeRProxyPath(rawPath);
  return p === '/__test' || p.startsWith('/__test/');
}

function isProductionDiagnosticRProxyPath(reqPath) {
  return process.env.NODE_ENV === 'production' && isDiagnosticRProxyPath(reqPath);
}

function trustedRdsLoadEnabled(env = process.env) {
  return env.NODE_ENV !== 'production' && env.ALLOW_TRUSTED_RDS_LOAD === 'true';
}

const RDS_DESERIALIZATION_PROXY_PATHS = new Set(['/load-rds', '/restore-session']);

// ── Internal-only R endpoints (never reachable through the public proxy) ──────
// Some R endpoints are driven EXCLUSIVELY by the in-process worker bridge, which calls
// the R backend directly (it does NOT traverse this Express proxy). They must therefore
// be UNREACHABLE through the public /api/r/* catch-all. POST /object/pbmc-pipeline runs
// the PBMC/Seurat pipeline on a copy of a live object and writes a checkpoint RDS; a
// direct proxy call would let a client run it WITHOUT a durable job, worker claim,
// result object, artifact, lineage edge, or provenance/log record — bypassing the whole
// worker contract. We block every spelling (any method, trailing slash, doubled slashes,
// %2F-encoded or backslash separators) using the same normalization as the diagnostic
// gate, BEFORE any R contact, and return a no-leak 404 (never confirming the path).
//
// POST /object/checkpoint-load is the second such endpoint: it loads a durable internal
// checkpoint RDS back into a live R session and MUTATES that live object key. A direct
// proxy call would let a client trigger a live-state mutation WITHOUT a durable job,
// worker claim, ownership re-verification, server-selected checkpoint, or sanitized load
// record — and would accept a client-controlled storage key/path. It is driven ONLY by
// the in-process worker bridge, so it must be UNREACHABLE through the public proxy.
//
// POST /object/deg-find-markers is the third such endpoint: it runs DEG / FindAllMarkers
// over a live object and writes the full marker table to a SERVER-allocated internal vault
// key. A direct proxy call would let a client run DEG WITHOUT a durable job, worker claim,
// ownership re-verification, server-selected output key, or sanitized summary — and would
// accept a client-controlled storage key/path. It is driven ONLY by the in-process worker
// bridge, so it must be UNREACHABLE through the public proxy.
//
// POST /object/seurat-pipeline is the dataset-backed counterpart: it loads an uploaded
// dataset from a server-resolved storage key, runs Seurat preprocessing, and saves a
// checkpoint. It is worker-only for the same durable job/artifact/lineage reasons.
const R_PROXY_INTERNAL_ONLY_PATHS = new Set([
  '/object/pbmc-pipeline', '/object/checkpoint-save', '/object/checkpoint-load', '/object/deg-find-markers',
  '/object/explore-summary',
  '/object/condition-pseudobulk-de',
  '/object/enrichment-gsea', '/object/cellchat-infer', '/object/seurat-pipeline',
  '/object/spatial-seurat-pipeline', '/object/inspect',
  '/internal/worker-readiness'
]);

function isInternalOnlyRProxyPath(rawPath) {
  return R_PROXY_INTERNAL_ONLY_PATHS.has(normalizeRProxyPath(rawPath));
}

const R_PROXY_PRODUCTION_BLOCKED_PATHS = new Set([
  '/deg', '/cellchat', '/cellchat-infer', '/enrichment', '/annotate-clusters',
  '/load-rds', '/save-session', '/check-session', '/restore-session', '/delete-session',
  '/export-figure',
  // These legacy loaders read/convert user vault contents synchronously before
  // the object dimensions are known. Keep them available for explicit local/dev
  // use, but do not expose them in production until they are durable jobs with
  // aggregate input and memory admission limits.
  '/load-local-10x', '/load-h5ad', '/load-multi-10x',
  // These legacy live-state transformations bypass the durable job/artifact
  // contract. Metadata import can read and attach an unbounded CSV, while subset
  // can duplicate a large Seurat object and write an unmanaged client-selected
  // vault file. Retain them for explicit local development only until reviewed
  // queued equivalents own their input/output and resource limits.
  '/csv-columns', '/add-metadata', '/subset', '/integrate',
]);

const R_PROXY_PRODUCTION_ALLOWLIST = Object.freeze({
  GET: new Set([
    '/health', '/session-id', '/qc-distributions', '/load-data',
    '/object-info', '/pipeline-state', '/reduction-results', '/meta-values', '/cellchat-group-map',
    '/normalize', '/pca', '/cluster', '/umap',
    '/genes', '/gene-expression', '/feature-values', '/heatmap', '/dot-plot', '/validate',
  ]),
  POST: new Set([
    '/add-meta-mapping', '/qc',
    '/export-preview', '/render-plot-base64',
  ]),
});

function isProductionBlockedRProxyPath(rawPath, env = process.env) {
  return env.NODE_ENV === 'production' &&
    R_PROXY_PRODUCTION_BLOCKED_PATHS.has(normalizeRProxyPath(rawPath));
}

function isAllowedProductionRProxyRequest(method, rawPath, env = process.env) {
  if (env.NODE_ENV !== 'production') return true;
  const allowed = R_PROXY_PRODUCTION_ALLOWLIST[String(method || '').toUpperCase()];
  return !!allowed && allowed.has(normalizeRProxyPath(rawPath));
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

// Store an uploaded dataset under a server-owned project key. The client never
// controls the key or final path.
async function storeDatasetFile(file, projectId, datasetId) {
  const safeName = (db.sanitizeDatasetFilename(file.originalname) || 'upload.bin')
    .replace(/[^a-zA-Z0-9._-]/g, '_');
  const key = storage.projectStorageFileKey(
    sanitizeIdSegment(projectId),
    'datasets',
    sanitizeIdSegment(datasetId),
    safeName
  );
  const stored = await durableStorage.putFileFromPath(file.path, key);
  return {
    internalStorageKey: stored.key,
    sha256: stored.checksumSha256,
    fileSizeBytes: stored.sizeBytes
  };
}

function validateRProxyPaths(req, res, next) {
  try {
    if (isProductionDiagnosticRProxyPath(req.path)) {
      return res.status(404).json({ error: 'Not found' });
    }

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const normalizedProxyPath = normalizeRProxyPath(req.path);
    if (RDS_DESERIALIZATION_PROXY_PATHS.has(normalizedProxyPath) && !trustedRdsLoadEnabled()) {
      return res.status(403).json({
        error: 'RDS loading is disabled. Set ALLOW_TRUSTED_RDS_LOAD=true only for trusted local/dev inputs.'
      });
    }

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

    if (RDS_DESERIALIZATION_PROXY_PATHS.has(normalizedProxyPath)) {
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
// the id must be a real persisted analysis_objects.id owned by req.user and be
// usable through its authoritative scope. On success the verified canonical id
// is stashed on req.verifiedObjectId, and the proxy derives the R state key from
// it. With no X-Object-ID, the request falls through to the legacy user-scoped
// key.
async function verifyRObjectOwnership(req, res, next) {
  const rawObjectId = req.headers['x-object-id'];

  if (rawObjectId === undefined || rawObjectId === null || String(rawObjectId).trim() === '') {
    return next();
  }

  const objectId = String(rawObjectId).trim();
  if (!isValidObjectIdFormat(objectId)) {
    return res.status(400).json({ error: 'Malformed object ID.' });
  }

  // Mandatory DB ownership check — rejected before the request can reach R.
  const object = await db.getAnalysisObjectForUser(objectId, req.user.id);
  if (!object) {
    // 404 (not 403) so we never reveal that another user's object exists.
    return res.status(404).json({ error: 'Analysis object not found.' });
  }

  // Scientific authorship remains immutable, but a project-associated live
  // object is usable only while its owner is still a project writer. This is a
  // public-proxy check only: worker-internal ownership checks intentionally do
  // not revalidate here, so an already-valid running claim may finish.
  if (object.projectId) {
    try {
      await db.requireProjectRole(req.user.id, object.projectId, ['owner', 'admin', 'analyst']);
    } catch (error) {
      if (error.code === 'NOT_FOUND') {
        return res.status(404).json({ error: 'Analysis object not found.' });
      }
      if (error.code === 'FORBIDDEN') {
        return res.status(403).json({ error: 'You do not have permission to use this project analysis object.' });
      }
      throw error;
    }
  } else {
    // A projectless row is not necessarily private: legacy descendants can
    // inherit a project lineage, and legacy rows can reference a project
    // dataset. Apply the same private-scope resolution used by the compatibility
    // metadata routes so these rows cannot become an R-proxy bypass.
    const privateObject = await db.getPrivateAnalysisObjectForUser(objectId, req.user.id);
    if (!privateObject) {
      return res.status(404).json({ error: 'Analysis object not found.' });
    }
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
const MAX_AUTH_RATE_LIMIT_KEYS = 10000;

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

function isValidBranchIdFormat(value) {
  return typeof value === 'string' && /^br_[0-9a-f]+$/.test(value);
}

function isValidReviewIdFormat(value) {
  return typeof value === 'string' && /^rev_[0-9a-f]+$/.test(value);
}

function isValidConditionIdFormat(value) {
  return typeof value === 'string' && /^cond_[0-9a-f]+$/.test(value);
}

function isValidSampleIdFormat(value) {
  return typeof value === 'string' && /^sample_[0-9a-f]+$/.test(value);
}

// Separate limiters per endpoint so login attempts and signup attempts do not
// share (or exhaust) one another's budget.
const loginRateLimiter = createRateLimiter();
const signupRateLimiter = createRateLimiter();
const passwordChangeRateLimiter = createRateLimiter();

// A downstream browser disconnect does not prove that a synchronous R handler
// stopped. Keep the admission lease attached to the request until the upstream
// response actually settles, or until the full R deadline has elapsed. Without
// this fence an aborting client could immediately open another expensive request
// while the first one was still consuming the single shared R process.
const R_PROXY_ADMISSION_STATE = Symbol('rProxyAdmissionState');
const R_PROXY_CONCURRENCY_EXEMPT_GET_PATHS = new Set(['/health', '/session-id']);

function markRProxyAdmissionIndeterminate(req) {
  const state = req && req[R_PROXY_ADMISSION_STATE];
  if (state) state.markIndeterminate();
}

function markRProxyAdmissionSettled(req) {
  const state = req && req[R_PROXY_ADMISSION_STATE];
  if (state) state.markSettled();
}

function markRProxyUpstreamConnected(req) {
  const state = req && req[R_PROXY_ADMISSION_STATE];
  if (state) state.markConnected();
}

function markRProxyUpstreamError(req) {
  const state = req && req[R_PROXY_ADMISSION_STATE];
  if (state) state.markProxyError();
}

function createRProxyAdmission() {
  const hits = new Map();
  const activeByUser = new Map();
  let activeTotal = 0;

  function middleware(req, res, next) {
    const userKey = String(req.user?.id || 'unknown');
    const now = Date.now();
    const windowMs = config.rProxyRateLimitWindowMs();
    const maxRequests = config.rProxyRateLimitMax();
    let entry = hits.get(userKey);
    if (!entry || now >= entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(userKey, entry);
    }
    entry.count += 1;
    if (entry.count > maxRequests) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((entry.resetAt - now) / 1000))));
      return res.status(429).json({ error: 'R request rate limit exceeded. Please retry later.' });
    }

    // These are constant-size, read-only runtime probes. The UI legitimately
    // requests them together after login; making them consume the single heavy
    // analytical slot creates false 429s. They remain authenticated, CSRF
    // checked, exact-path allowlisted, response-bounded, and rate-limited above.
    if (String(req.method || '').toUpperCase() === 'GET'
        && R_PROXY_CONCURRENCY_EXEMPT_GET_PATHS.has(normalizeRProxyPath(req.path))) {
      return next();
    }

    const maxConcurrent = config.rProxyMaxConcurrent();
    const userActive = activeByUser.get(userKey) || 0;
    // One in-flight request per user prevents a single browser from filling the
    // entire shared R service. The global cap defaults to one because the v1 R
    // runtime is one private process; BYOC deployments may raise it only when
    // their R service topology actually has matching capacity.
    if (userActive >= 1 || activeTotal >= maxConcurrent) {
      res.setHeader('Retry-After', '1');
      return res.status(429).json({ error: 'R service is busy. Please retry shortly.' });
    }

    let released = false;
    let indeterminate = false;
    let upstreamConnected = false;
    let conservativeReleaseTimer = null;
    const release = () => {
      if (released) return;
      released = true;
      if (conservativeReleaseTimer) {
        clearTimeout(conservativeReleaseTimer);
        conservativeReleaseTimer = null;
      }
      delete req[R_PROXY_ADMISSION_STATE];
      activeTotal = Math.max(0, activeTotal - 1);
      const remaining = Math.max(0, (activeByUser.get(userKey) || 1) - 1);
      if (remaining === 0) activeByUser.delete(userKey);
      else activeByUser.set(userKey, remaining);
    };
    const scheduleConservativeRelease = () => {
      if (released || conservativeReleaseTimer) return;
      indeterminate = true;
      conservativeReleaseTimer = setTimeout(release, config.rProxyTimeoutMs());
      if (typeof conservativeReleaseTimer.unref === 'function') {
        conservativeReleaseTimer.unref();
      }
    };
    activeTotal += 1;
    activeByUser.set(userKey, userActive + 1);
    req[R_PROXY_ADMISSION_STATE] = Object.freeze({
      markIndeterminate: scheduleConservativeRelease,
      markConnected: () => { upstreamConnected = true; },
      // DNS/connection-refused failures before a TCP connection cannot have
      // started an R handler. Once connected, a reset is indeterminate.
      markProxyError: () => {
        if (upstreamConnected) scheduleConservativeRelease();
        else release();
      },
      // An upstream `end` proves the synchronous R request returned. Capacity is
      // safe to release even when the browser disappeared before receiving it.
      markSettled: release,
    });
    res.once('finish', () => {
      if (indeterminate) scheduleConservativeRelease();
      else release();
    });
    res.once('close', () => {
      if (res.writableFinished && !indeterminate) release();
      else scheduleConservativeRelease();
    });
    try {
      return next();
    } catch (error) {
      release();
      throw error;
    }
  }

  middleware.reset = () => {
    hits.clear();
    activeByUser.clear();
    activeTotal = 0;
  };
  return middleware;
}

function sendRProxyFailure(res, status, message) {
  if (res.headersSent || res.writableEnded) return;
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify({ error: message }));
}

const R_PROXY_MAX_REQUEST_BYTES = 256 * 1024;

function isJsonMediaType(value) {
  const mediaType = String(value || '').split(';', 1)[0].trim().toLowerCase();
  return mediaType === 'application/json'
    || /^application\/[a-z0-9!#$&^_.+-]+\+json$/.test(mediaType);
}

function enforceRProxyRequestShape(req, res, next) {
  const method = String(req.method || '').toUpperCase();
  const headers = req.headers || {};
  const rawLength = headers['content-length'];
  const hasTransferEncoding = headers['transfer-encoding'] !== undefined;
  let declaredLength = 0;
  if (rawLength !== undefined) {
    if (!/^[0-9]+$/.test(String(rawLength).trim())) {
      return res.status(400).json({ error: 'Invalid R request body length.' });
    }
    declaredLength = Number(rawLength);
    if (!Number.isSafeInteger(declaredLength)) {
      return res.status(400).json({ error: 'Invalid R request body length.' });
    }
  }

  if (method === 'GET') {
    if (declaredLength > 0 || hasTransferEncoding) {
      return res.status(400).json({ error: 'GET R requests must not include a body.' });
    }
    return next();
  }
  if (method !== 'POST') {
    return res.status(404).json({ error: 'Not found' });
  }
  const contentEncoding = String(headers['content-encoding'] || 'identity').trim().toLowerCase();
  if (contentEncoding !== 'identity') {
    return res.status(415).json({ error: 'Compressed R request bodies are not accepted.' });
  }
  if (!isJsonMediaType(headers['content-type'])) {
    return res.status(415).json({ error: 'R POST requests require a JSON body.' });
  }
  if (declaredLength > R_PROXY_MAX_REQUEST_BYTES) {
    return res.status(413).json({ error: 'R request body exceeded the configured size limit.' });
  }
  return next();
}

const parseRProxyJsonBody = express.json({
  limit: R_PROXY_MAX_REQUEST_BYTES,
  type: ['application/json', 'application/*+json'],
});

function parseBoundedRProxyJson(req, res, next) {
  if (String(req.method || '').toUpperCase() !== 'POST') return next();
  return parseRProxyJsonBody(req, res, (error) => {
    if (!error) {
      if (req.body === undefined) {
        return res.status(400).json({ error: 'R POST requests require a JSON body.' });
      }
      return next();
    }
    if (error.type === 'entity.too.large' || error.status === 413) {
      return res.status(413).json({ error: 'R request body exceeded the configured size limit.' });
    }
    return res.status(400).json({ error: 'R request body must be valid JSON.' });
  });
}

function writeRProxyRequest(proxyReq, req) {
  // http-proxy starts with a copy of every browser header. Remove that inherited
  // set completely so cookies, bearer tokens, forwarding headers, and arbitrary
  // X-* values cannot cross the Express/R trust boundary.
  for (const name of proxyReq.getHeaderNames()) proxyReq.removeHeader(name);
  proxyReq.setHeader('Host', new URL(R_RUNTIME_CONFIG.baseUrl).host);
  proxyReq.setHeader('Accept', 'application/json');
  proxyReq.setHeader('X-API-Token', API_TOKEN);
  proxyReq.setHeader('X-Object-ID', deriveRStateKey(req.user, req.verifiedObjectId));

  if (String(req.method || '').toUpperCase() === 'POST') {
    const bodyData = JSON.stringify(req.body);
    proxyReq.setHeader('Content-Type', 'application/json');
    proxyReq.setHeader('Content-Length', String(Buffer.byteLength(bodyData)));
    proxyReq.write(bodyData);
  }
}

const R_PROXY_PRIVATE_RESPONSE_KEYS = new Set([
  'r_home', 'file_path', 'path', 'paths', 'csv_path', 'storage_uri',
  'storage_key', 'dataset_storage_key', 'token', 'api_token',
]);

function redactAbsolutePaths(value) {
  return String(value)
    // Do this before drive-path matching: the `e:///` suffix in `file:///…`
    // and the `s://` suffix in `https://…` otherwise look like Windows paths.
    .replace(/\b(?:https?|file):\/\/[^\s'"`]+/gi, '[redacted-url]')
    .replace(/[A-Za-z]:[\\/][^\s'"`]+/g, '[redacted-path]')
    .replace(/(^|[\s'"`])\/(?:[^\s'"`/]+\/)+[^\s'"`]+/g, '$1[redacted-path]')
    // Metadata and identity labels are user-controlled values in some legacy
    // live-R routes. Do not let a label bypass the path/key boundary merely by
    // placing a URI or internal storage reference in an otherwise safe field.
    .replace(/\b(?:vault|projects)\/[^\s'"`]+/gi, '[redacted-storage]')
    .replace(/\buser-\d+:obj-[A-Za-z0-9_-]+\b/g, '[redacted-state]');
}

function sanitizeRProxyJson(value) {
  if (Array.isArray(value)) return value.map((item) => sanitizeRProxyJson(item));
  if (value && typeof value === 'object') {
    const safe = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      if (R_PROXY_PRIVATE_RESPONSE_KEYS.has(childKey.toLowerCase())) continue;
      safe[childKey] = sanitizeRProxyJson(childValue);
    }
    return safe;
  }
  if (typeof value === 'string') return redactAbsolutePaths(value);
  return value;
}

function handleBoundedRProxyResponse(proxyRes, req, res) {
  const maxBytes = config.rProxyMaxResponseBytes();
  const declaredBytes = Number(proxyRes.headers && proxyRes.headers['content-length']);
  if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
    markRProxyAdmissionIndeterminate(req);
    proxyRes.destroy();
    sendRProxyFailure(res, 502, 'R response exceeded the configured size limit.');
    return;
  }
  const chunks = [];
  let received = 0;
  let finished = false;

  proxyRes.on('data', (chunk) => {
    if (finished) return;
    received += chunk.length;
    if (received > maxBytes) {
      finished = true;
      markRProxyAdmissionIndeterminate(req);
      proxyRes.destroy();
      sendRProxyFailure(res, 502, 'R response exceeded the configured size limit.');
      return;
    }
    chunks.push(chunk);
  });
  proxyRes.on('end', async () => {
    if (finished) return;
    finished = true;
    markRProxyAdmissionSettled(req);
    const upstreamStatus = proxyRes.statusCode || 502;
    if (upstreamStatus < 200 || upstreamStatus >= 300) {
      sendRProxyFailure(res, upstreamStatus, 'R request failed.');
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(Buffer.concat(chunks, received).toString('utf8'));
    } catch {
      sendRProxyFailure(res, 502, 'R service returned an invalid response.');
      return;
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.error !== undefined) {
      sendRProxyFailure(res, 502, 'R request failed.');
      return;
    }
    if (req.verifiedObjectId && parsed?.provenance?.execution) {
      try {
        const recorded = await require('./backend/liveExecutionJournal').recordLiveRExecutionBounded({ db, req, envelope: parsed });
        if (recorded) parsed.execution_history = recorded;
      } catch (error) {
        console.warn('[live-execution-history] persistence failed code=' + String(error?.code || 'UNAVAILABLE').replace(/[^A-Z0-9_]/g, '').slice(0, 80));
        parsed.execution_history = { status: 'unavailable' };
      }
    }
    const outgoing = Buffer.from(JSON.stringify(sanitizeRProxyJson(parsed)));
    res.statusCode = upstreamStatus;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Length', String(outgoing.length));
    res.end(outgoing);
  });
  proxyRes.on('error', () => {
    if (finished) return;
    finished = true;
    markRProxyAdmissionIndeterminate(req);
    sendRProxyFailure(res, 502, 'R service response failed.');
  });
  proxyRes.on('aborted', () => {
    if (finished) return;
    finished = true;
    markRProxyAdmissionIndeterminate(req);
    sendRProxyFailure(res, 502, 'R service response failed.');
  });
}

const rProxyAdmission = createRProxyAdmission();

// ── R proxy path-field validation allowlist ─────────────────────────────────
// Single source of truth for which request fields validateRProxyPaths treats as
// vault paths before proxying to R. backend/r-path-drift.test.js asserts that
// every field feeding R's validate_path() in r-backend/plumber.R is covered
// here, so a new R path-like field can't silently bypass Node-side validation.
// 'storage_key' is the PBMC pipeline checkpoint key (r-backend/plumber.R
// POST /object/pbmc-pipeline → validate_path(storage_key, "vault")). In normal
// operation it is server-allocated by the worker bridge (never client-supplied), but
// because /api/r/* is a catch-all proxy we ALSO validate it here as defense-in-depth:
// if a client ever sends a top-level `storage_key` through the proxy it is confined to
// the vault before reaching R (and the r-path-drift guard stays satisfied).
const R_PROXY_VALIDATED_PATH_FIELDS = ['path', 'csv_path', 'paths', 'storage_key', 'dataset_storage_key'];

// Middleware
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', [
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
  ].join('; '));
  if (config.isProduction() && req.secure) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  const healthPath = req.path === '/livez' || req.path === '/readyz';
  if (config.isProduction() && !healthPath && !req.secure) {
    return res.status(426).json({ error: 'HTTPS required.' });
  }
  return next();
});

// CORS must allow credentials so the browser sends/stores the HttpOnly session
// cookie cross-origin (when the API is on a different origin than the frontend).
// Origin is reflected only from the configured allowlist; requests without an
// Origin header (same-origin, server-to-server, tests) are allowed.
app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    return cb(null, config.isAllowedOrigin(origin));
  },
  credentials: true
}));

// Process health routes deliberately precede database initialization. Liveness
// never touches a dependency. Readiness requires Postgres, both persistent
// storage roots, and the singleton web lock; R is reported as an optional
// compute component so metadata/API traffic stays available during R recovery.
app.get('/livez', (req, res) => {
  const result = webHealth.liveness();
  res.setHeader('Cache-Control', 'no-store');
  res.status(result.httpStatus).json(result.body);
});
app.get('/readyz', async (req, res) => {
  const result = await webHealth.readiness();
  res.setHeader('Cache-Control', 'no-store');
  res.status(result.httpStatus).json(result.body);
});

// Public, non-secret UI policy. Keep this ahead of database initialization so
// the login page can accurately hide registration during a database outage.
app.get('/api/service/compatibility', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(SERVICE_COMPATIBILITY);
});
const { DEMO_JOB_TYPES, demoAccountPolicy, demoCapabilityPolicy } = require('./backend/demoExperiencePolicy');
const guidedDemoMode = () => config.demoMode() && process.env.DEMO_DATASET === 'pbmc3k';

app.get('/api/auth/policy', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const legacyUiEnabled = !config.isProduction();
  const demoMode = config.demoMode();
  res.json({
    registrationEnabled: !guidedDemoMode() && config.registrationEnabled(),
    authenticationEnabled: !guidedDemoMode(),
    guidedDemoEnabled: guidedDemoMode(),
    passwordPolicy: passwordPolicy.publicPasswordPolicy(),
    legacyLocalImportsEnabled: legacyUiEnabled,
    // Live mutation tools write into the source object's in-memory R state.
    // Keep them unavailable until they create a durable child checkpoint.
    legacyLiveMutationToolsEnabled: false,
    serverFigureExportEnabled: legacyUiEnabled,
    // Expert R entitlement is authenticated account data. The public policy
    // fails closed so login/demo surfaces cannot disclose or enable it.
    expertREnabled: false,
    expertRProfile: null,
    demoMode,
    datasetUploadsEnabled: !demoMode,
    demoGuestTtlSeconds: demoMode ? config.demoGuestTtlSeconds() : null,
  });
});

// In production this route terminates before database initialization or body
// parsing. Outside production it falls through to the normal signup handler.
app.use(demoAccountPolicy(guidedDemoMode));
app.use(demoCapabilityPolicy(guidedDemoMode));
app.post('/api/auth/signup', requireNetworkRegistrationEnabled);

app.use(async (req, res, next) => {
  if (req.path === '/api/auth/logout') return next();
  try {
    await initAppDatabase();
    return next();
  } catch {
    console.error('[DB] Postgres initialization failed (DATABASE_UNAVAILABLE).');
    return res.status(503).json({ error: 'Database unavailable' });
  }
});
// Keep the R request stream available for its bounded proxy body parser.
// ── Auth Endpoints ────────────────────────────────────────────────────────
app.use('/api/auth', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});
function requireNetworkRegistrationEnabled(req, res, next) {
  if (!config.registrationEnabled()) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(403).json({ error: 'Account registration is operator-managed for this deployment.' });
  }
  return next();
}

const authJson = express.json();

app.post('/api/auth/demo-guest', signupRateLimiter, async (req, res) => {
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
app.post('/api/auth/signup', signupRateLimiter, authJson, async (req, res) => {
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

app.post('/api/auth/login', loginRateLimiter, authJson, async (req, res) => {
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
app.get('/api/auth/session', requireAuth, (req, res) => {
  res.json({ user: publicAuthUser(req.user) });
});

app.get('/api/auth/installation', requireAuth, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const identity = await require('./backend/executionTargets').getServiceExecutionIdentity(db);
    res.json({ schema: 'traceomics.installation.v1', installationId: identity.id, userId: Number(req.user.id) });
  } catch {
    res.status(503).json({ error: 'The authenticated installation identity is unavailable. Check the service before submitting work.' });
  }
});

app.post('/api/auth/change-password', passwordChangeRateLimiter, authJson, requireAuth, async (req, res) => {
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
app.post('/api/auth/logout', async (req, res) => {
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

// ── Database API Endpoints ──────────────────────────────────────────────
// Runtime diagnostics (authenticated metadata only). This reports what the
// backend detects; it does not let browser clients choose an executable path.
app.use('/api/runtime', express.json());
app.use('/api/runtime', requireAuth);
app.get('/api/runtime/readiness', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const projectId = req.query.projectId;
  if (projectId !== undefined && (typeof projectId !== 'string' || !/^proj_[A-Za-z0-9_-]{3,128}$/.test(projectId))) {
    return res.status(400).json({ error: 'A valid project id is required.' });
  }
  try {
    // Entitlement and membership are deliberately outside the shared probe
    // cache. A fresh request must reflect revocation or a changed project role.
    if (projectId && !(await db.getProjectForUser(projectId, req.user.id))) {
      return res.status(404).json({ error: 'Project not found.' });
    }
    return res.json(await runtimeReadiness.inspect({ resolveAccess: async () => {
      const access = await db.getExpertRCapabilities(req.user.id, projectId || null);
      if (projectId && !(await db.getProjectForUser(projectId, req.user.id))) {
        throw Object.assign(new Error('Project not found.'), { code: 'READINESS_PROJECT_NOT_FOUND' });
      }
      return { canExecuteExpertR: access.canExecuteExpertR,
        revoked: access.expertRAccessRevoked, demoMode: config.demoMode() };
    } }));
  } catch (error) {
    if (error?.code === 'READINESS_PROJECT_NOT_FOUND') return res.status(404).json({ error: 'Project not found.' });
    console.error('[Runtime] Readiness observation unavailable.');
    return res.status(503).json({ error: 'Server readiness could not be checked.' });
  }
});
app.get('/api/runtime/diagnostics', async (req, res) => {
  try {
    const diagnostics = await buildRuntimeDiagnostics();
    res.json(toPublicRuntimeDiagnostics(diagnostics));
  } catch (err) {
    console.error('[Diagnostics] Runtime diagnostics failed:', err);
    res.status(500).json({ error: 'Runtime diagnostics failed' });
  }
});

// Compute availability is projected from a short-lived DB heartbeat written by
// the standalone worker. Do not proxy the private worker health port or expose
// worker ids, paths, topology, R URLs, or raw errors to browser clients.
app.get('/api/runtime/compute-status', async (req, res) => {
  try {
    const status = await db.getStandaloneWorkerRuntimeStatus();
    res.json(status);
  } catch {
    console.error('[Runtime] Compute status unavailable.');
    res.status(503).json({ status: 'unknown', updatedAt: null });
  }
});

// Database API endpoints.
app.use('/api/db', express.json());
app.use('/api/db', requireAuth);

app.get('/api/db/provenance', async (req, res) => {
  res.json(await db.getAllProvenance(req.user.email));
});

app.post('/api/db/provenance', async (req, res) => {
  const env = { ...req.body, userEmail: req.user.email };
  try {
    const id = await db.saveProvenance(env);
    res.json({ id });
  } catch (e) {
    // A row owned by another user — or a project-scoped row — is reported as a
    // generic 404 (no cross-user/project existence leak), not a raw 500.
    if (e.code === 'PROVENANCE_NOT_FOUND') {
      return res.status(404).json({ error: 'Provenance record not found.' });
    }
    if (e.code === 'INVALID_PROVENANCE') {
      return res.status(400).json({ error: 'Invalid provenance record.' });
    }
    console.error('[Provenance] Save failed (PROVENANCE_SAVE_FAILED).');
    return res.status(500).json({ error: 'Provenance save failed.' });
  }
});

app.get('/api/db/provenance/:id', async (req, res) => {
  res.json(await db.getProvenance(req.params.id, req.user.email));
});

app.get('/api/db/provenance-chain/:id', async (req, res) => {
  res.json(await db.getProvenanceChain(req.params.id, req.user.email));
});

app.delete('/api/db/provenance/:id', async (req, res) => {
  res.json({ success: await db.deleteProvenance(req.params.id, req.user.email) });
});

app.get('/api/db/figures', async (req, res) => {
  res.json(await db.getFiguresByUser(req.user.email));
});

app.post('/api/db/figures', async (req, res) => {
  try {
    const id = await db.saveFigure({ ...req.body, userEmail: req.user.email });
    res.json({ id });
  } catch (e) {
    if (e.code === 'FIGURE_NOT_FOUND') {
      return res.status(404).json({ error: 'Figure not found.' });
    }
    console.error('[Figures] Save failed (FIGURE_SAVE_FAILED).');
    return res.status(500).json({ error: 'Figure save failed.' });
  }
});

app.delete('/api/db/figures/:id', async (req, res) => {
  res.json({ success: await db.deleteFigure(req.params.id, req.user.email) });
});

// Cache Endpoints
app.post('/api/db/cache-key', (req, res) => {
  const { operation, params, dataVersion, parentIds } = req.body;
  res.json({ key: db.makeCacheKey(operation, params, dataVersion, parentIds, req.user.email) });
});

app.get('/api/db/cache/:key', async (req, res) => {
  res.json(await db.getCachedResult(req.params.key, req.user.email));
});

app.post('/api/db/cache/:key', async (req, res) => {
  const { provenanceId, resultData } = req.body;
  try {
    await db.setCachedResult(req.params.key, provenanceId, resultData, req.user.email);
    res.json({ success: true });
  } catch (e) {
    if (e.code === 'CACHE_NOT_FOUND') {
      return res.status(404).json({ error: 'Cache record not found.' });
    }
    return res.status(403).json({ error: 'Cache write is not permitted.' });
  }
});

app.delete('/api/db/cache', async (req, res) => {
  await db.clearCache(req.user.email);
  res.json({ success: true });
});

// ── Analysis Objects API ────────────────────────────────────────────────
// Durable, ownership-scoped analysis object identity. Object ids are issued by
// the server; clients may never choose an id or assert ownership.
app.use('/api/analysis-objects', express.json());
app.use('/api/analysis-objects', requireAuth);

const REJECTED_OWNER_FIELDS = ['userId', 'user_id', 'ownerUserId', 'owner_user_id'];
const REJECTED_ANALYSIS_OBJECT_STORAGE_FIELDS = [
  'storageUri', 'storage_uri',
  'storageKey', 'storage_key',
  'internalStorageKey', 'internal_storage_key',
  'objectHash', 'object_hash',
  'path', 'filePath', 'file_path',
  'stateKey', 'state_key'
];
const REJECTED_ANALYSIS_OBJECT_STORAGE_FIELD_SET = new Set(REJECTED_ANALYSIS_OBJECT_STORAGE_FIELDS);

function findRejectedAnalysisObjectStorageField(value) {
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findRejectedAnalysisObjectStorageField(item);
      if (found) return found;
    }
    return null;
  }
  for (const [field, child] of Object.entries(value)) {
    if (REJECTED_ANALYSIS_OBJECT_STORAGE_FIELD_SET.has(field)) return field;
    const found = findRejectedAnalysisObjectStorageField(child);
    if (found) return found;
  }
  return null;
}

function rejectAnalysisObjectStorageFields(body, res) {
  for (const field of REJECTED_ANALYSIS_OBJECT_STORAGE_FIELDS) {
    if (body[field] !== undefined) {
      res.status(400).json({ error: `Field '${field}' is not allowed; storage and state are server-controlled.` });
      return true;
    }
  }
  const metadataField = findRejectedAnalysisObjectStorageField(body.metadata);
  if (metadataField) {
    res.status(400).json({ error: `Metadata field '${metadataField}' is not allowed; storage and state are server-controlled.` });
    return true;
  }
  return false;
}

app.post('/api/analysis-objects', async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};

  // Compatibility surface for genuinely private, projectless objects only.
  // Project data must use /api/projects/:projectId/analysis-objects so creator
  // identity can never bypass current project membership.

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
  if (rejectAnalysisObjectStorageFields(body, res)) return;

  // Validate linked-resource ownership before creating anything. 404 (not 403)
  // so we never reveal that another user's resource exists.
  if (body.parentObjectId !== undefined && body.parentObjectId !== null) {
    if (typeof body.parentObjectId !== 'string' || !(await db.getPrivateAnalysisObjectForUser(body.parentObjectId, req.user.id))) {
      return res.status(404).json({ error: 'Parent analysis object not found.' });
    }
  }
  if (body.createdByProvenanceId !== undefined && body.createdByProvenanceId !== null) {
    if (typeof body.createdByProvenanceId !== 'string' || !(await db.getProvenance(body.createdByProvenanceId, req.user.email))) {
      return res.status(404).json({ error: 'Provenance record not found.' });
    }
  }
  // Durable datasets are project-scoped and therefore unavailable here. Keep a
  // distinct 400 for malformed ids; any well-formed id is resolved as 404 by the
  // private-scope DB helper.
  if (body.datasetId !== undefined && body.datasetId !== null) {
    if (!isValidDatasetIdFormat(body.datasetId)) {
      return res.status(400).json({ error: 'Malformed dataset ID.' });
    }
  }
  try {
    const created = await db.createPrivateAnalysisObjectForUser(req.user.id, {
      datasetId: body.datasetId,
      parentObjectId: body.parentObjectId,
      objectType: body.objectType,
      displayName: body.displayName,
      metadata: body.metadata,
      createdByProvenanceId: body.createdByProvenanceId
    });
    res.status(201).json(db.toPublicAnalysisObject(created));
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

app.get('/api/analysis-objects', async (req, res) => {
  const filters = {
    datasetId: typeof req.query.datasetId === 'string' ? req.query.datasetId : undefined,
    parentObjectId: typeof req.query.parentObjectId === 'string' ? req.query.parentObjectId : undefined,
    lineageRootId: typeof req.query.lineageRootId === 'string' ? req.query.lineageRootId : undefined,
    objectType: typeof req.query.objectType === 'string' ? req.query.objectType : undefined
  };
  res.json((await db.listPrivateAnalysisObjectsForUser(req.user.id, filters)).map(db.toPublicAnalysisObject));
});

app.get('/api/analysis-objects/:id', async (req, res) => {
  const obj = await db.getPrivateAnalysisObjectForUser(req.params.id, req.user.id);
  if (!obj) return res.status(404).json({ error: 'Analysis object not found.' });
  res.json(db.toPublicAnalysisObject(obj));
});

// ── Jobs API ────────────────────────────────────────────────────────────
// Legacy compatibility API for private, projectless jobs. Project jobs use the
// project RBAC routes. Job ids/status are server-managed, and the worker drains
// only registered, allowlisted handlers.
app.use('/api/jobs', express.json());
app.use('/api/jobs', requireAuth);

app.post('/api/jobs', async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};

  // Receipt-backed scientific jobs require project-scoped durable storage and
  // recovery authorization. Do not accept them through this legacy projectless
  // compatibility route only to fail later in the worker.
  if (db.RETRYABLE_DURABLE_JOB_TYPES.has(body.jobType)) {
    return res.status(400).json({
      error: 'This durable scientific job type requires the project-scoped jobs API.',
    });
  }

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
  if (body.retryOfJobId !== undefined || body.retry_of_job_id !== undefined) {
    return res.status(400).json({ error: 'Job retry linkage is server-managed and must not be provided.' });
  }
  // Durable datasets are project-scoped and therefore unavailable here. Keep a
  // distinct 400 for malformed ids; well-formed ids resolve as 404 below.
  if (body.datasetId !== undefined && body.datasetId !== null) {
    if (!isValidDatasetIdFormat(body.datasetId)) {
      return res.status(400).json({ error: 'Malformed dataset ID.' });
    }
  }

  try {
    const created = await db.createPrivateJobForUser(req.user.id, {
      analysisObjectId: body.analysisObjectId,
      datasetId: body.datasetId,
      jobType: body.jobType,
      parameters: body.parameters
    });
    res.status(201).json(db.toPublicJob(created));
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

app.get('/api/jobs', async (req, res) => {
  const filters = {
    status: typeof req.query.status === 'string' ? req.query.status : undefined,
    jobType: typeof req.query.jobType === 'string' ? req.query.jobType : undefined,
    analysisObjectId: typeof req.query.analysisObjectId === 'string' ? req.query.analysisObjectId : undefined,
    resultAnalysisObjectId: typeof req.query.resultAnalysisObjectId === 'string' ? req.query.resultAnalysisObjectId : undefined
  };
  res.json((await db.listPrivateJobsForUser(req.user.id, filters)).map(db.toPublicJob));
});

app.get('/api/jobs/:id', async (req, res) => {
  const job = await db.getPrivateJobForUser(req.params.id, req.user.id);
  if (!job) return res.status(404).json({ error: 'Job not found.' });
  res.json(db.toPublicJob(job));
});

app.get('/api/jobs/:id/logs', async (req, res) => {
  const job = await db.getPrivateJobForUser(req.params.id, req.user.id);
  if (!job) return res.status(404).json({ error: 'Job not found.' });
  const publicJob = db.toPublicJob(job);
  res.json({ id: publicJob.id, status: publicJob.status, logs: publicJob.logs, error: publicJob.error });
});

app.post('/api/jobs/:id/cancel', async (req, res) => {
  try {
    const job = await db.cancelPrivateJobForUser(req.user.id, req.params.id);
    res.json(db.toPublicJob(job));
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
// project ownership.
app.use('/api/organizations', express.json());
app.use('/api/organizations', requireAuth);
app.use('/api/projects', express.json());
app.use('/api/projects', requireAuth);
app.use('/api/projects/:projectId/analyses', researchAnalysisRoutes({ database: db }));
app.use('/api/workflows', require('./backend/workflowRoutes').workflowRoutes({ db, provider: durableStorage, requireAuth }));
app.use('/api/artifact-versions', require('./backend/artifactVersionRoutes').artifactVersionRoutes({ db, provider: durableStorage, requireAuth }));
app.use('/api/server-data', require('./backend/serverDataImportRoutes').serverDataImportRoutes({ db, provider: durableStorage, requireAuth }));
app.use('/api/execution-history', require('./backend/executionHistoryRoutes').executionHistoryRoutes({ db, provider: durableStorage, requireAuth }));
app.use('/api/run-monitoring', require('./backend/runMonitoringRoutes').runMonitoringRoutes({ db, requireAuth,
  serviceOptions: require('./backend/runMonitoringResources').createRunResourceObservers() }));
app.use('/api/private-r-kernels', require('./backend/privateKernelRoutes').privateKernelRoutes({ db, provider: durableStorage, requireAuth }));

// Publishing a trusted pipeline manifest is a platform capability, not a
// project role. Authenticate before parsing the bounded body so cookie CSRF
// enforcement runs before any mutation work. Manifests are declarative only;
// this endpoint never accepts module code, R code, filesystem paths, or URLs.
const PIPELINE_REGISTRY_BODY_LIMIT = 70 * 1024;
const parsePipelineRegistryJson = express.json({
  limit: PIPELINE_REGISTRY_BODY_LIMIT,
  inflate: false,
  type: ['application/json', 'application/*+json'],
});

function parseBoundedPipelineRegistryJson(req, res, next) {
  if (String(req.method || '').toUpperCase() !== 'POST') return next();
  return parsePipelineRegistryJson(req, res, (error) => {
    if (!error) {
      if (req.body === undefined) {
        return res.status(400).json({ error: 'A JSON manifest body is required.' });
      }
      return next();
    }
    if (error.type === 'entity.too.large' || error.status === 413) {
      return res.status(413).json({ error: 'Pipeline manifest request exceeded the size limit.' });
    }
    if (error.type === 'encoding.unsupported' || error.status === 415) {
      return res.status(415).json({ error: 'Compressed pipeline manifest bodies are not accepted.' });
    }
    return res.status(400).json({ error: 'Pipeline manifest request body must be valid JSON.' });
  });
}

function sendPipelineRegistryError(res, error) {
  switch (error.code) {
    case 'FORBIDDEN':
      return res.status(403).json({ error: error.message });
    case 'PIPELINE_MANIFEST_EXISTS':
    case 'PIPELINE_REGISTRY_FULL':
      return res.status(409).json({ error: error.message });
    case 'INVALID_PIPELINE_DEFINITION':
    case 'INVALID_PIPELINE_MANIFEST':
      return res.status(400).json({ error: error.message });
    default:
      console.error('[PipelineRegistry]', error);
      return res.status(500).json({ error: 'Internal error.' });
  }
}

app.use('/api/pipeline-registry', requireAuth);
app.use('/api/pipeline-registry', parseBoundedPipelineRegistryJson);

app.get('/api/pipeline-registry/capabilities', async (req, res) => {
  try {
    res.json(await db.getPipelineRegistryCapabilities(req.user.id));
  } catch (error) {
    sendPipelineRegistryError(res, error);
  }
});

// Private R requires a provisioned isolated runtime and the configured account
// or project-role policy. Project access, explicit denial and object ownership
// are enforced again when a job is submitted and at worker claim time.
app.use('/api/expert-r', requireAuth);
app.get('/api/expert-r/capabilities', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const projectId = req.query.projectId;
    if (projectId !== undefined && (typeof projectId !== 'string' || !/^proj_[A-Za-z0-9_-]{3,128}$/.test(projectId))) {
      return res.status(400).json({ error: 'Choose a valid project to check R access.' });
    }
    const { probeExpertRRuntime, expertRStatus } = require('./backend/expertRAccess');
    const { effectivePrivateRArtifactPolicy } = require('./backend/privateRArtifactPolicy');
    const runtime = config.demoMode() ? { state: 'not-configured' } : await probeExpertRRuntime();
    const { canExecuteExpertR, expertRAccessRevoked } = await db.getExpertRCapabilities(req.user.id, projectId || null);
    const enabled = !config.demoMode() && runtime.state === 'ready' && canExecuteExpertR;
    res.json({
      expertREnabled: enabled,
      expertRProfile: enabled ? EXPERT_R_PROFILE : null,
      expertREnvironment: enabled ? runtime.environment || null : null,
      persistentKernel: enabled && runtime.persistentKernel === true,
      persistentKernelInterrupt: enabled && runtime.persistentKernelInterrupt === true,
      persistentKernelPublications: enabled && runtime.persistentKernelPublications === true,
      persistentKernelStreamedPublications: enabled && runtime.persistentKernelStreamedPublications === true,
      expertRArtifactPolicy: enabled ? effectivePrivateRArtifactPolicy(runtime) : null,
      expertRStatus: expertRStatus({ canExecuteExpertR, runtime,
        revoked: expertRAccessRevoked, demoMode: config.demoMode() }),
    });
  } catch (error) {
    console.error('[ExpertRCapabilities]', error);
    res.status(500).json({ error: 'Expert R access is temporarily unavailable.' });
  }
});

app.get('/api/expert-r/environment', async (req, res) => {
  res.setHeader('Cache-Control', 'private, no-store');
  const projectId = req.query.projectId;
  if (typeof projectId !== 'string' || !/^proj_[A-Za-z0-9_-]{3,128}$/.test(projectId)) {
    return res.status(400).json({ error: 'Choose a valid project to inspect its R environment.' });
  }
  try {
    await db.requireProjectRole(req.user.id, projectId, ['owner', 'admin', 'analyst']);
    const capabilities = await db.getExpertRCapabilities(req.user.id, projectId);
    if (config.demoMode() || !capabilities.canExecuteExpertR) return res.status(403).json({ error: 'R environment access is not available for this project.' });
    const { getExpertREnvironment } = require('./backend/expertSandboxClient');
    res.json(await getExpertREnvironment());
  } catch (error) {
    if (error.code === 'NOT_FOUND') return res.status(404).json({ error: 'Project not found.' });
    if (error.code === 'FORBIDDEN') return res.status(403).json({ error: 'Your project role cannot inspect the R environment.' });
    res.status(503).json({ error: 'The exact R environment is unavailable. Check the private runtime and retry.' });
  }
});

app.post('/api/pipeline-registry/definitions', async (req, res) => {
  try {
    const created = await db.createPipelineRegistryDefinition(req.user.id, req.body);
    res.status(201).json(created);
  } catch (error) {
    sendPipelineRegistryError(res, error);
  }
});

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

app.post('/api/organizations', async (req, res) => {
  if (rejectServerControlledFields(req, res)) return;
  try {
    const org = await db.createOrganizationForUser(req.user.id, { name: req.body.name });
    res.status(201).json(org);
  } catch (e) {
    sendOrgProjectError(res, e, 'Organizations');
  }
});

app.get('/api/organizations', async (req, res) => {
  res.json(await db.listOrganizationsForUser(req.user.id));
});

app.get('/api/organizations/:id', async (req, res) => {
  const org = await db.getOrganizationForUser(req.params.id, req.user.id);
  if (!org) return res.status(404).json({ error: 'Organization not found.' });
  res.json(org);
});

app.post('/api/projects', async (req, res) => {
  if (rejectServerControlledFields(req, res)) return;
  try {
    const project = await db.createProjectForUser(req.user.id, {
      organizationId: req.body.organizationId,
      name: req.body.name,
      description: req.body.description
    });
    res.status(201).json(project);
  } catch (e) {
    sendOrgProjectError(res, e, 'Projects');
  }
});

app.get('/api/projects', async (req, res) => {
  res.json(await db.listProjectsForUser(req.user.id));
});

app.get('/api/projects/:id', async (req, res) => {
  const project = await db.getProjectForUser(req.params.id, req.user.id);
  if (!project) return res.status(404).json({ error: 'Project not found.' });
  res.json(project);
});

app.patch('/api/projects/:id', async (req, res) => {
  // A project cannot be reparented to another org in this branch.
  if (rejectServerControlledFields(req, res, { extra: ['organizationId', 'organization_id'] })) return;
  try {
    // owner/admin only; not-a-member → 404, member without role → 403.
    await db.requireProjectRole(req.user.id, req.params.id, ['owner', 'admin']);
    await db.updateProject(req.params.id, { name: req.body.name, description: req.body.description });
    res.json(await db.getProjectForUser(req.params.id, req.user.id));
  } catch (e) {
    sendOrgProjectError(res, e, 'Projects');
  }
});

app.get('/api/projects/:id/members', async (req, res) => {
  try {
    // Any project member (incl. viewer) may see the member list.
    await db.requireProjectRole(req.user.id, req.params.id, ['owner', 'admin', 'analyst', 'viewer']);
    res.json(await db.listProjectMembers(req.params.id));
  } catch (e) {
    sendOrgProjectError(res, e, 'Projects');
  }
});

app.post('/api/projects/:id/members', async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  // Members are added by exact email; reject any attempt to name a user/row id.
  if (rejectServerControlledFields(req, res, { rejectRole: false, extra: ['userId', 'user_id', 'projectId', 'project_id'] })) return;
  if (typeof body.email !== 'string' || !body.email.trim()) {
    return res.status(400).json({ error: 'A member email is required.' });
  }
  try {
    // The DB layer re-reads this authenticated user's role while holding the
    // project mutation lock, so a concurrent demotion cannot leave stale authority.
    const member = await db.addProjectMemberByEmail(
      req.params.id, body.email, body.role, { userId: req.user.id }
    );
    res.status(201).json(member);
  } catch (e) {
    sendOrgProjectError(res, e, 'Projects');
  }
});

app.patch('/api/projects/:id/members/:userId', async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const targetUserId = Number(req.params.userId);
  if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
    return res.status(400).json({ error: 'Malformed member user ID.' });
  }
  if (rejectServerControlledFields(req, res, {
    rejectRole: false,
    extra: ['userId', 'user_id', 'projectId', 'project_id', 'email', 'id'],
  })) return;
  if (typeof body.role !== 'string') {
    return res.status(400).json({ error: 'A role is required.' });
  }
  try {
    const updated = await db.updateProjectMemberRole(
      req.params.id, targetUserId, body.role, { userId: req.user.id }
    );
    res.json(updated);
  } catch (e) {
    sendOrgProjectError(res, e, 'Projects');
  }
});

app.delete('/api/projects/:id/members/:userId', async (req, res) => {
  const targetUserId = Number(req.params.userId);
  if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
    return res.status(400).json({ error: 'Malformed member user ID.' });
  }
  try {
    await db.removeProjectMember(
      req.params.id, targetUserId, { userId: req.user.id }
    );
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
  limits: { fileSize: config.maxUploadBytes() },
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

function requireLegacyVaultUploadsEnabled(req, res, next) {
  if (config.isProduction()) {
    return res.status(403).json({ error: 'Legacy private-vault uploads are disabled in production.' });
  }
  return next();
}

app.post('/api/upload', requireAuth, requireLegacyVaultUploadsEnabled, (req, res) => {
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

app.post('/api/upload-directory', requireAuth, requireLegacyVaultUploadsEnabled, (req, res) => {
  upload.array('files', config.maxUploadFiles())(req, res, (err) => {
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
// download routes in this branch.

// Separate multer instance for dataset uploads so the dataset extension policy is
// independent of the R-vault upload filter. The declared file_type (validated
// against the DB allow-list) is the source of truth; the extension is a coarse
// guard. tenx_zip arrives as .zip, hence its inclusion here.
const datasetUpload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: config.maxUploadBytes() },
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
  'uploadStatus', 'upload_status', 'validationStatus', 'validation_status',
  'validationErrors', 'validation_errors',
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

// Coerce dataset metadata, which arrives as a string for multipart uploads or
// a native object for JSON requests. Returns { ok:false } for invalid JSON.
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

// Reject viewers/nonmembers before Multer consumes or stages their multipart
// body. The database mutation re-checks the role after parsing to close a role-
// change race; this early gate prevents unauthorized disk/CPU consumption.
async function requireDatasetWriterBeforeUpload(req, res, next) {
  if (config.demoMode()) {
    return res.status(403).json({ error: 'Dataset uploads are disabled in the public demo.' });
  }
  try {
    await db.requireProjectRole(req.user.id, req.params.projectId, ['owner', 'admin', 'analyst']);
    return next();
  } catch (error) {
    return sendDatasetError(res, error);
  }
}

app.post('/api/projects/:projectId/datasets', requireDatasetWriterBeforeUpload, maybeDatasetMultipart, async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  if (rejectDatasetServerFields(req, res)) return;

  const fileType = body.fileType !== undefined ? body.fileType : body.file_type;
  const meta = coerceDatasetJsonField(body.metadata);
  if (!meta.ok) { cleanupDatasetReqFile(req); return res.status(400).json({ error: 'metadata must be valid JSON.' }); }
  try {
    let dataset = await db.createDatasetForProject(req.user.id, req.params.projectId, {
      fileType,
      originalFilename: body.originalFilename !== undefined
        ? body.originalFilename
        : (req.file ? req.file.originalname : undefined),
      metadata: meta.value,
    });

    // If a file rode along, the server stores it under a server-chosen key and
    // records sha256 + size. A storage failure leaves the record `failed`, never
    // a misleading `uploaded`/`valid`.
    if (req.file) {
      let stored = null;
      try {
        stored = await storeDatasetFile(req.file, req.params.projectId, dataset.id);
        dataset = await db.markDatasetUploaded(req.params.projectId, dataset.id, stored);
        const validation = await validateStoredDataset(durableStorage, dataset);
        if (validation.validationStatus !== 'pending') {
          dataset = await db.setDatasetValidationResult(
            req.params.projectId,
            dataset.id,
            validation.validationStatus,
            validation.validationErrors
          );
        }
      } catch (storageErr) {
        console.error('[Datasets] Storage failed:', storageErr);
        if (stored && stored.internalStorageKey) {
          try { durableStorage.remove(stored.internalStorageKey); } catch { /* best effort */ }
        }
        await db.markDatasetUploadFailed(req.params.projectId, dataset.id);
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

app.get('/api/projects/:projectId/datasets', async (req, res) => {
  const filters = {};
  if (typeof req.query.fileType === 'string') filters.fileType = req.query.fileType;
  if (typeof req.query.uploadStatus === 'string') filters.uploadStatus = req.query.uploadStatus;
  if (typeof req.query.validationStatus === 'string') filters.validationStatus = req.query.validationStatus;
  try {
    const rows = await db.listDatasetsForProject(req.user.id, req.params.projectId, filters);
    res.json(rows.map(db.toPublicDataset));
  } catch (e) {
    sendDatasetError(res, e);
  }
});

app.get('/api/projects/:projectId/datasets/:datasetId', async (req, res) => {
  if (!isValidDatasetIdFormat(req.params.datasetId)) {
    return res.status(400).json({ error: 'Malformed dataset ID.' });
  }
  try {
    const dataset = await db.getDatasetForProject(req.user.id, req.params.projectId, req.params.datasetId);
    if (!dataset) return res.status(404).json({ error: 'Dataset not found.' });
    res.json(db.toPublicDataset(dataset));
  } catch (e) {
    sendDatasetError(res, e);
  }
});

app.patch('/api/projects/:projectId/datasets/:datasetId', async (req, res) => {
  if (!isValidDatasetIdFormat(req.params.datasetId)) {
    return res.status(400).json({ error: 'Malformed dataset ID.' });
  }
  if (rejectDatasetServerFields(req, res)) return;
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  try {
    const updated = await db.updateDatasetForProject(req.user.id, req.params.projectId, req.params.datasetId, {
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
// metadata does NOT gain access to another user's live R session. The opt-in
// worker remains allowlisted and does not change this boundary.

// Map the coded errors thrown by the project-scoped analysis-object/job helpers
// to HTTP statuses: 404 for unknown/not-accessible (no existence leak), 403 for a
// known member lacking the role, 409 for a non-cancelable (terminal) job, 400 for
// input validation.
function sendProjectResourceError(res, e, context) {
  if (e?.code === 'DEMO_COMPUTE_LIMIT') {
    res.setHeader('Retry-After', '10');
    return res.status(429).json({ error: e.message });
  }
  switch (e.code) {
    case 'EXPERT_R_UNAVAILABLE':
      return res.status(503).json({ error: e.message });
    case 'NOT_FOUND':
    case 'PARENT_NOT_FOUND':
    case 'DATASET_NOT_FOUND':
    case 'ANALYSIS_OBJECT_NOT_FOUND':
    case 'RESULT_OBJECT_NOT_FOUND':
    case 'JOB_NOT_FOUND':
    case 'SUBMISSION_NOT_FOUND':
    case 'PROVENANCE_NOT_FOUND':
    case 'FIGURE_NOT_FOUND':
    case 'PIPELINE_NOT_FOUND':
    case 'BRANCH_NOT_FOUND':
    case 'EXPERIMENTAL_DESIGN_NOT_FOUND':
    case 'CONTRAST_NOT_FOUND':
    case 'ARTIFACT_NOT_DOWNLOADABLE':
      return res.status(404).json({ error: e.message });
    case 'FORBIDDEN':
      return res.status(403).json({ error: e.message });
    case 'JOB_NOT_CANCELABLE':
    case 'JOB_NOT_RETRYABLE':
    case 'SUBMISSION_REQUEST_CONFLICT':
    case 'BRANCH_NAME_EXISTS':
    case 'BRANCH_ARCHIVED':
    case 'BRANCH_VERSION_CONFLICT':
    case 'BRANCH_NOT_REVIEWABLE':
    case 'REVIEW_NOT_OPEN':
    case 'REVIEW_NOT_APPROVED':
    case 'EXPERIMENTAL_DESIGN_CONFLICT':
    case 'METADATA_VALUE_ALREADY_BOUND':
    case 'SAMPLE_ALREADY_BOUND':
      return res.status(409).json({ error: e.message, code: e.code });
    case 'INVALID_OBJECT_TYPE':
    case 'INVALID_METADATA':
    case 'INVALID_JOB_TYPE':
    case 'INVALID_PARAMETERS':
    case 'INVALID_SUBMISSION_REQUEST':
    case 'UNKNOWN_PARAMETER':
    case 'INVALID_PARAMETER':
    case 'INVALID_PACKAGES':
    case 'INVALID_PARENT_IDS':
    case 'INVALID_PLOT_TYPE':
    case 'INVALID_OWNER':
    case 'INVALID_PIPELINE_DEFINITION':
    case 'INVALID_PIPELINE_MANIFEST':
    case 'INVALID_PIPELINE_SELECTION':
    case 'INVALID_BRANCH':
    case 'INVALID_BRANCH_HEAD':
    case 'INVALID_REVIEW':
    case 'INVALID_EXPERIMENTAL_DESIGN':
    case 'UNSUPPORTED_CONDITION_MODEL':
    case 'INVALID_AUDIT_CURSOR':
      return res.status(400).json({ error: e.message, ...(e.code === 'UNSUPPORTED_CONDITION_MODEL' ? { code: e.code } : {}) });
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

app.get('/api/projects/:projectId/pipeline-definitions', async (req, res) => {
  try {
    res.json(await db.listProjectPipelineDefinitions(req.user.id, req.params.projectId));
  } catch (e) {
    sendProjectResourceError(res, e, 'ProjectPipelines');
  }
});

const expertRInputUpload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: MAX_EXPERT_R_INPUT_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (!EXPERT_R_INPUT_EXTENSIONS.has(ext)) {
      return cb(new Error('Expert R inputs must be CSV, TSV, TXT, JSON, or RDS files.'));
    }
    cb(null, true);
  },
});

async function requireExpertRInputWriter(req, res, next) {
  if (!expertRSandboxEnabled()) {
    return res.status(403).json({ error: 'Expert R is not available for this deployment.' });
  }
  try {
    await db.requireProjectRole(req.user.id, req.params.projectId, ['owner', 'admin', 'analyst']);
    if (!(await db.hasExpertRExecuteCapability(req.user.id, req.params.projectId))) {
      return res.status(403).json({ error: 'Expert R access is not approved for this account.' });
    }
    return next();
  } catch (error) {
    return sendProjectResourceError(res, error, 'ExpertRInputs');
  }
}

function sendExpertRInputError(res, error) {
  if (['NOT_FOUND', 'EXPERT_R_INPUT_NOT_FOUND'].includes(error?.code)) {
    return res.status(404).json({ error: error.message });
  }
  if (error?.code === 'FORBIDDEN') return res.status(403).json({ error: error.message });
  if (['INVALID_EXPERT_R_INPUT', 'EXPERT_R_INPUT_QUOTA'].includes(error?.code)) {
    return res.status(400).json({ error: error.message });
  }
  console.error('[ExpertRInputs]', error);
  return res.status(500).json({ error: 'Private input import failed.' });
}

app.get('/api/expert-r/projects/:projectId/inputs', requireExpertRInputWriter, async (req, res) => {
  try {
    res.json(await db.listExpertRPrivateInputs(req.user.id, req.params.projectId));
  } catch (error) {
    sendExpertRInputError(res, error);
  }
});

app.post('/api/expert-r/projects/:projectId/inputs', requireExpertRInputWriter, (req, res) => {
  expertRInputUpload.single('file')(req, res, async (uploadError) => {
    if (uploadError) return res.status(400).json({ error: uploadError.message });
    if (!req.file) return res.status(400).json({ error: 'Select one private input file.' });
    let stored = null;
    try {
      const id = generateExpertRInputId();
      const originalFilename = sanitizeExpertRInputFilename(req.file.originalname);
      if (req.file.size > maxExpertRInputBytesForFilename(originalFilename)) {
        const limitMiB = Math.floor(maxExpertRInputBytesForFilename(originalFilename) / (1024 * 1024));
        const error = new Error(`This Expert R input exceeds the ${limitMiB} MiB file limit.`);
        error.code = 'INVALID_EXPERT_R_INPUT';
        throw error;
      }
      const internalStorageKey = allocateExpertRInputStorageKey(
        req.params.projectId, id, originalFilename
      );
      stored = await durableStorage.putFileFromPath(req.file.path, internalStorageKey);
      const created = await db.createExpertRPrivateInput(req.user.id, req.params.projectId, {
        id,
        originalFilename,
        internalStorageKey,
        mimeType: req.file.mimetype || 'application/octet-stream',
        sizeBytes: stored.sizeBytes,
        checksumSha256: stored.checksumSha256,
      });
      res.status(201).json(created);
    } catch (error) {
      if (stored?.key) {
        try { await durableStorage.remove(stored.key); } catch { /* original error wins */ }
      }
      sendExpertRInputError(res, error);
    } finally {
      cleanupUploadedFiles([req.file]);
    }
  });
});

app.get('/api/projects/:projectId/pipeline-selection', async (req, res) => {
  try {
    res.json(await db.getProjectPipelineSelection(req.user.id, req.params.projectId));
  } catch (e) {
    sendProjectResourceError(res, e, 'ProjectPipelines');
  }
});

app.put('/api/projects/:projectId/pipeline-selection', async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  if (body.projectId !== undefined || body.project_id !== undefined
      || body.userId !== undefined || body.user_id !== undefined
      || body.ownerUserId !== undefined || body.owner_user_id !== undefined) {
    return res.status(400).json({ error: 'Pipeline selection scope is server-controlled.' });
  }
  try {
    res.json(await db.setProjectPipelineSelection(req.user.id, req.params.projectId, body.pipelineId));
  } catch (e) {
    sendProjectResourceError(res, e, 'ProjectPipelines');
  }
});

app.post('/api/projects/:projectId/analysis-objects', async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  // lineageRootId is server-derived; reject any client-supplied value alongside
  // the id/owner/creator/project fields.
  if (rejectProjectResourceFields(req, res, {
    extra: ['lineageRootId', 'lineage_root_id', ...REJECTED_ANALYSIS_OBJECT_STORAGE_FIELDS]
  })) return;
  if (rejectAnalysisObjectStorageFields(body, res)) return;

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
    if (typeof body.createdByProvenanceId !== 'string' || !(await db.getProvenance(body.createdByProvenanceId, req.user.email))) {
      return res.status(404).json({ error: 'Provenance record not found.' });
    }
  }

  try {
    const created = await db.createProjectAnalysisObject(req.user.id, req.params.projectId, {
      datasetId: body.datasetId,
      parentObjectId: body.parentObjectId,
      objectType: body.objectType,
      displayName: body.displayName,
      metadata: body.metadata,
      createdByProvenanceId: body.createdByProvenanceId
    });
    res.status(201).json(db.toPublicAnalysisObject(created));
  } catch (e) {
    sendProjectResourceError(res, e, 'ProjectAnalysisObjects');
  }
});

app.get('/api/projects/:projectId/analysis-objects', async (req, res) => {
  const filters = {
    datasetId: typeof req.query.datasetId === 'string' ? req.query.datasetId : undefined,
    parentObjectId: typeof req.query.parentObjectId === 'string' ? req.query.parentObjectId : undefined,
    lineageRootId: typeof req.query.lineageRootId === 'string' ? req.query.lineageRootId : undefined,
    objectType: typeof req.query.objectType === 'string' ? req.query.objectType : undefined
  };
  try {
    res.json((await db.listProjectAnalysisObjects(req.user.id, req.params.projectId, filters)).map(db.toPublicAnalysisObject));
  } catch (e) {
    sendProjectResourceError(res, e, 'ProjectAnalysisObjects');
  }
});

app.get('/api/projects/:projectId/analysis-objects/:objectId', async (req, res) => {
  if (!isValidAnalysisObjectIdFormat(req.params.objectId)) {
    return res.status(400).json({ error: 'Malformed analysis object ID.' });
  }
  try {
    const obj = await db.getProjectAnalysisObject(req.user.id, req.params.projectId, req.params.objectId);
    if (!obj) return res.status(404).json({ error: 'Analysis object not found.' });
    res.json(db.toPublicAnalysisObject(obj));
  } catch (e) {
    sendProjectResourceError(res, e, 'ProjectAnalysisObjects');
  }
});

// Persist a small, safe DISPLAY summary (cells / features / density) for a project
// analysis object so the Workspace/Data Info card keeps accurate counts after a
// browser refresh (live R counts are transient and never persisted elsewhere). This
// is project METADATA only: it does NOT touch R state, does NOT make live R state
// project-shared, and does NOT weaken verifyRObjectOwnership. Server-controlled
// identity fields and any storage/state/path field are rejected; only finite numeric
// cells/features/density are read. project_id/object_id come from the route, never
// the body. Non-member → 404, member lacking a write role → 403.
app.patch('/api/projects/:projectId/analysis-objects/:objectId/summary', async (req, res) => {
  if (!isValidAnalysisObjectIdFormat(req.params.objectId)) {
    return res.status(400).json({ error: 'Malformed analysis object ID.' });
  }
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  if (rejectProjectResourceFields(req, res)) return;
  if (rejectAnalysisObjectStorageFields(body, res)) return;
  try {
    const updated = await db.updateProjectAnalysisObjectSummary(
      req.user.id, req.params.projectId, req.params.objectId,
      { cells: body.cells, features: body.features, density: body.density }
    );
    res.json(db.toPublicAnalysisObject(updated));
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
app.get('/api/projects/:projectId/analysis-objects/:objectId/parents', async (req, res) => {
  if (!isValidAnalysisObjectIdFormat(req.params.objectId)) {
    return res.status(400).json({ error: 'Malformed analysis object ID.' });
  }
  try {
    res.json(await db.listProjectAnalysisObjectParents(req.user.id, req.params.projectId, req.params.objectId));
  } catch (e) {
    sendProjectResourceError(res, e, 'ProjectLineage');
  }
});

app.get('/api/projects/:projectId/analysis-objects/:objectId/children', async (req, res) => {
  if (!isValidAnalysisObjectIdFormat(req.params.objectId)) {
    return res.status(400).json({ error: 'Malformed analysis object ID.' });
  }
  try {
    res.json(await db.listProjectAnalysisObjectChildren(req.user.id, req.params.projectId, req.params.objectId));
  } catch (e) {
    sendProjectResourceError(res, e, 'ProjectLineage');
  }
});

app.get('/api/projects/:projectId/analysis-objects/:objectId/lineage', async (req, res) => {
  if (!isValidAnalysisObjectIdFormat(req.params.objectId)) {
    return res.status(400).json({ error: 'Malformed analysis object ID.' });
  }
  try {
    res.json(await db.getProjectAnalysisObjectLineage(req.user.id, req.params.projectId, req.params.objectId));
  } catch (e) {
    sendProjectResourceError(res, e, 'ProjectLineage');
  }
});

// Explicit, project-scoped study design. These routes register metadata and
// immutable contrast snapshots only; they never accept R code, state keys,
// ownership fields, or an inferential result from the client.
app.post('/api/projects/:projectId/conditions', async (req, res) => {
  if (rejectProjectResourceFields(req, res)) return;
  try {
    res.status(201).json(await experimentalDesign.createCondition(
      req.user.id, req.params.projectId, req.body || {}
    ));
  } catch (error) {
    sendProjectResourceError(res, error, 'ProjectConditions');
  }
});

app.get('/api/projects/:projectId/conditions', async (req, res) => {
  try {
    res.json(await experimentalDesign.listConditions(req.user.id, req.params.projectId));
  } catch (error) {
    sendProjectResourceError(res, error, 'ProjectConditions');
  }
});

app.post('/api/projects/:projectId/samples', async (req, res) => {
  if (rejectProjectResourceFields(req, res, {
    extra: ['conditionName', 'condition_name', 'createdAt', 'created_at'],
  })) return;
  const body = req.body || {};
  if (!isValidConditionIdFormat(body.conditionId)) {
    return res.status(400).json({ error: 'Malformed condition ID.' });
  }
  if (body.datasetId != null && !isValidDatasetIdFormat(body.datasetId)) {
    return res.status(400).json({ error: 'Malformed dataset ID.' });
  }
  try {
    res.status(201).json(await experimentalDesign.createSample(
      req.user.id, req.params.projectId, body
    ));
  } catch (error) {
    sendProjectResourceError(res, error, 'ProjectSamples');
  }
});

app.get('/api/projects/:projectId/samples', async (req, res) => {
  try {
    res.json(await experimentalDesign.listSamples(req.user.id, req.params.projectId));
  } catch (error) {
    sendProjectResourceError(res, error, 'ProjectSamples');
  }
});

app.post('/api/projects/:projectId/analysis-objects/:objectId/sample-bindings', async (req, res) => {
  if (!isValidAnalysisObjectIdFormat(req.params.objectId)) {
    return res.status(400).json({ error: 'Malformed analysis object ID.' });
  }
  if (rejectProjectResourceFields(req, res, {
    extra: ['analysisObjectId', 'analysis_object_id', 'conditionId', 'condition_id'],
  })) return;
  if (!isValidSampleIdFormat(req.body?.sampleId)) {
    return res.status(400).json({ error: 'Malformed sample ID.' });
  }
  try {
    res.status(201).json(await experimentalDesign.bindSample(
      req.user.id, req.params.projectId, req.params.objectId, req.body || {}
    ));
  } catch (error) {
    sendProjectResourceError(res, error, 'ProjectSampleBindings');
  }
});

app.get('/api/projects/:projectId/analysis-objects/:objectId/sample-bindings', async (req, res) => {
  if (!isValidAnalysisObjectIdFormat(req.params.objectId)) {
    return res.status(400).json({ error: 'Malformed analysis object ID.' });
  }
  try {
    res.json(await experimentalDesign.listBindings(
      req.user.id, req.params.projectId, req.params.objectId
    ));
  } catch (error) {
    sendProjectResourceError(res, error, 'ProjectSampleBindings');
  }
});

app.post('/api/projects/:projectId/contrasts', async (req, res) => {
  if (rejectProjectResourceFields(req, res, {
    extra: ['status', 'validation', 'validationJson', 'validation_json'],
  })) return;
  const body = req.body || {};
  if (!isValidAnalysisObjectIdFormat(body.analysisObjectId)
      || !isValidConditionIdFormat(body.numeratorConditionId)
      || !isValidConditionIdFormat(body.denominatorConditionId)) {
    return res.status(400).json({ error: 'Malformed analysis object or condition ID.' });
  }
  try {
    res.status(201).json(await experimentalDesign.createContrast(
      req.user.id, req.params.projectId, body
    ));
  } catch (error) {
    sendProjectResourceError(res, error, 'ProjectContrasts');
  }
});

app.get('/api/projects/:projectId/contrasts', async (req, res) => {
  try {
    res.json(await experimentalDesign.listContrasts(req.user.id, req.params.projectId));
  } catch (error) {
    sendProjectResourceError(res, error, 'ProjectContrasts');
  }
});

// Named private work refs over immutable analysis-object/checkpoint history.
// Branch identity, owner, visibility, review decisions, and canonical pointers
// are server-controlled; publishing is explicit and canonical promotion requires
// an owner/admin decision on an approved review of the exact current head.
app.post('/api/projects/:projectId/branches', async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  if (rejectProjectResourceFields(req, res, {
    extra: ['visibility', 'status', 'headAnalysisObjectId', 'head_analysis_object_id', 'version'],
  })) return;
  if (!isValidAnalysisObjectIdFormat(body.baseAnalysisObjectId)) {
    return res.status(400).json({ error: 'Malformed base analysis object ID.' });
  }
  try {
    res.status(201).json(await analysisBranches.createBranch(req.user.id, req.params.projectId, {
      name: body.name,
      description: body.description,
      baseAnalysisObjectId: body.baseAnalysisObjectId,
    }));
  } catch (error) {
    sendProjectResourceError(res, error, 'ProjectBranches');
  }
});

app.get('/api/projects/:projectId/branches', async (req, res) => {
  try {
    res.json(await analysisBranches.listBranches(req.user.id, req.params.projectId));
  } catch (error) {
    sendProjectResourceError(res, error, 'ProjectBranches');
  }
});

app.patch('/api/projects/:projectId/branches/:branchId/head', async (req, res) => {
  if (!isValidBranchIdFormat(req.params.branchId)) {
    return res.status(400).json({ error: 'Malformed branch ID.' });
  }
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  if (rejectProjectResourceFields(req, res, {
    extra: ['visibility', 'status', 'baseAnalysisObjectId', 'base_analysis_object_id'],
  })) return;
  if (!isValidAnalysisObjectIdFormat(body.headAnalysisObjectId)) {
    return res.status(400).json({ error: 'Malformed head analysis object ID.' });
  }
  try {
    res.json(await analysisBranches.advanceBranch(
      req.user.id, req.params.projectId, req.params.branchId,
      { headAnalysisObjectId: body.headAnalysisObjectId, expectedVersion: body.expectedVersion }
    ));
  } catch (error) {
    sendProjectResourceError(res, error, 'ProjectBranches');
  }
});

app.post('/api/projects/:projectId/branches/:branchId/publish', async (req, res) => {
  if (!isValidBranchIdFormat(req.params.branchId)) {
    return res.status(400).json({ error: 'Malformed branch ID.' });
  }
  if (rejectProjectResourceFields(req, res)) return;
  try {
    res.json(await analysisBranches.publishBranch(req.user.id, req.params.projectId, req.params.branchId));
  } catch (error) {
    sendProjectResourceError(res, error, 'ProjectBranches');
  }
});

app.get('/api/projects/:projectId/branches/:branchId/events', async (req, res) => {
  if (!isValidBranchIdFormat(req.params.branchId)) {
    return res.status(400).json({ error: 'Malformed branch ID.' });
  }
  try {
    res.json(await analysisBranches.listBranchEvents(req.user.id, req.params.projectId, req.params.branchId));
  } catch (error) {
    sendProjectResourceError(res, error, 'ProjectBranches');
  }
});

app.post('/api/projects/:projectId/branches/:branchId/reviews', async (req, res) => {
  if (!isValidBranchIdFormat(req.params.branchId)) {
    return res.status(400).json({ error: 'Malformed branch ID.' });
  }
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  if (rejectProjectResourceFields(req, res, {
    extra: ['branchId', 'branch_id', 'headAnalysisObjectId', 'head_analysis_object_id', 'status'],
  })) return;
  try {
    res.status(201).json(await analysisBranches.requestReview(
      req.user.id, req.params.projectId, req.params.branchId,
      { title: body.title, summary: body.summary }
    ));
  } catch (error) {
    sendProjectResourceError(res, error, 'ProjectBranchReviews');
  }
});

app.get('/api/projects/:projectId/reviews', async (req, res) => {
  if (req.query.branchId !== undefined && !isValidBranchIdFormat(req.query.branchId)) {
    return res.status(400).json({ error: 'Malformed branch ID.' });
  }
  try {
    res.json(await analysisBranches.listReviews(req.user.id, req.params.projectId, {
      branchId: req.query.branchId,
      status: typeof req.query.status === 'string' ? req.query.status : undefined,
    }));
  } catch (error) {
    sendProjectResourceError(res, error, 'ProjectBranchReviews');
  }
});

app.get('/api/projects/:projectId/reviews/:reviewId/comments', async (req, res) => {
  if (!isValidReviewIdFormat(req.params.reviewId)) {
    return res.status(400).json({ error: 'Malformed review ID.' });
  }
  try {
    res.json(await analysisBranches.listReviewComments(
      req.user.id, req.params.projectId, req.params.reviewId
    ));
  } catch (error) {
    sendProjectResourceError(res, error, 'ProjectBranchReviewComments');
  }
});

app.post('/api/projects/:projectId/reviews/:reviewId/comments', async (req, res) => {
  if (!isValidReviewIdFormat(req.params.reviewId)) {
    return res.status(400).json({ error: 'Malformed review ID.' });
  }
  if (rejectProjectResourceFields(req, res, {
    extra: ['reviewId', 'review_id', 'authorUserId', 'author_user_id'],
  })) return;
  try {
    res.status(201).json(await analysisBranches.addReviewComment(
      req.user.id, req.params.projectId, req.params.reviewId,
      { body: req.body?.body }
    ));
  } catch (error) {
    sendProjectResourceError(res, error, 'ProjectBranchReviewComments');
  }
});

app.patch('/api/projects/:projectId/reviews/:reviewId/decision', async (req, res) => {
  if (!isValidReviewIdFormat(req.params.reviewId)) {
    return res.status(400).json({ error: 'Malformed review ID.' });
  }
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  if (rejectProjectResourceFields(req, res, {
    extra: ['branchId', 'branch_id', 'headAnalysisObjectId', 'head_analysis_object_id'],
  })) return;
  try {
    res.json(await analysisBranches.decideReview(
      req.user.id, req.params.projectId, req.params.reviewId,
      { status: body.status, note: body.note }
    ));
  } catch (error) {
    sendProjectResourceError(res, error, 'ProjectBranchReviews');
  }
});

app.post('/api/projects/:projectId/branches/:branchId/promote', async (req, res) => {
  if (!isValidBranchIdFormat(req.params.branchId)) {
    return res.status(400).json({ error: 'Malformed branch ID.' });
  }
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  if (rejectProjectResourceFields(req, res, {
    extra: ['analysisObjectId', 'analysis_object_id', 'version'],
  })) return;
  if (!isValidReviewIdFormat(body.reviewId)) {
    return res.status(400).json({ error: 'Malformed review ID.' });
  }
  try {
    res.json(await analysisBranches.promoteBranch(
      req.user.id, req.params.projectId, req.params.branchId, { reviewId: body.reviewId }
    ));
  } catch (error) {
    sendProjectResourceError(res, error, 'ProjectCanonicalAnalysis');
  }
});

app.get('/api/projects/:projectId/canonical-analysis', async (req, res) => {
  try {
    const canonical = await analysisBranches.getCanonical(req.user.id, req.params.projectId);
    if (!canonical) return res.status(404).json({ error: 'Canonical analysis not found.' });
    res.json(canonical);
  } catch (error) {
    sendProjectResourceError(res, error, 'ProjectCanonicalAnalysis');
  }
});

app.get('/api/projects/:projectId/branch-comparison', async (req, res) => {
  if (!isValidBranchIdFormat(req.query.leftBranchId)
      || !isValidBranchIdFormat(req.query.rightBranchId)) {
    return res.status(400).json({ error: 'Two valid branch IDs are required.' });
  }
  try {
    res.json(await analysisBranches.compareBranches(
      req.user.id, req.params.projectId, req.query.leftBranchId, req.query.rightBranchId
    ));
  } catch (error) {
    sendProjectResourceError(res, error, 'ProjectBranchComparison');
  }
});

app.post('/api/projects/:projectId/jobs', async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  // Status is server-managed; a client cannot pick the initial status.
  if (body.status !== undefined) {
    return res.status(400).json({ error: 'Job status is server-managed and must not be provided.' });
  }
  if (body.retryOfJobId !== undefined || body.retry_of_job_id !== undefined) {
    return res.status(400).json({ error: 'Job retry linkage is server-managed and must not be provided.' });
  }
  if (rejectProjectResourceFields(req, res)) return;

  // A repeated accepted request is a read of the original submission, even
  // after its inputs or runtime have changed. It never dispatches another run.
  let submissionHash = null;
  if (body.requestId !== undefined) {
    try {
      const existing = await db.resolveProjectJobSubmission(req.user.id, req.params.projectId, body);
      if (existing) { res.setHeader('Cache-Control', 'no-store'); return res.status(200).json(db.toPublicJob(existing)); }
      submissionHash = require('./backend/submissionIdentity').projectSubmissionHash(body);
    } catch (error) { return sendProjectResourceError(res, error, 'ProjectJobSubmission'); }
  }

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

  // Receipt-backed handlers bind their exact source and output shape before R
  // contact. Reject incompatible client references synchronously so they cannot
  // manufacture partial-output/recovery states after dispatch.
  const serverManagedResultTypes = [
    'pbmc.pipeline.v1', 'seurat.pipeline.v1', 'seurat.multisample.v1', 'deg.find_markers.v1', 'enrichment.gsea.v1',
    'cellchat.infer.v1', 'explore.summarize.v1',
    'condition.pseudobulk_de.v1', 'expert.r.v1',
    'spatial.seurat.v1',
    'checkpoint.save.v1', 'checkpoint.load.v1', 'checkpoint.fork.v1',
  ];
  const noDatasetBindingTypes = [
    'pbmc.pipeline.v1', 'deg.find_markers.v1', 'enrichment.gsea.v1', 'cellchat.infer.v1',
    'explore.summarize.v1',
    'condition.pseudobulk_de.v1', 'expert.r.v1',
    'checkpoint.save.v1', 'checkpoint.load.v1', 'checkpoint.fork.v1',
  ];
  if (serverManagedResultTypes.includes(body.jobType)
      && body.resultAnalysisObjectId !== undefined) {
    return res.status(400).json({
      error: `${body.jobType} result analysis object is server-managed and must not be provided.`,
    });
  }
  if (noDatasetBindingTypes.includes(body.jobType) && body.datasetId !== undefined) {
    return res.status(400).json({
      error: `${body.jobType} dataset is derived from its source analysis object and must not be provided.`,
    });
  }
  if (serverManagedResultTypes.includes(body.jobType)
      && (body.analysisObjectId === undefined || body.analysisObjectId === null)) {
    return res.status(400).json({
      error: `${body.jobType} requires a source analysisObjectId.`,
    });
  }

  // Durable dataset-backed Seurat pipeline has a strict server-side parameter
  // allowlist. Reject unknown/bad params at job creation, before any worker claim
  // or R contact can happen.
  if (body.jobType === 'seurat.pipeline.v1') {
    try {
      validateSeuratPipelineParams(body.parameters);
    } catch (e) {
      return res.status(400).json({ error: e.message || 'Invalid seurat.pipeline.v1 parameters.' });
    }
    if (body.datasetId === undefined || body.datasetId === null) {
      return res.status(400).json({ error: 'seurat.pipeline.v1 requires datasetId.' });
    }
  }
  if (body.jobType === 'seurat.multisample.v1') {
    let validated;
    try {
      validated = validateMultiSampleSeuratParams(body.parameters);
    } catch (e) {
      return res.status(400).json({ error: e.message || 'Invalid seurat.multisample.v1 parameters.' });
    }
    if (body.datasetId === undefined || body.datasetId === null) {
      return res.status(400).json({ error: 'seurat.multisample.v1 requires a primary datasetId.' });
    }
    if (validated.samples[0].datasetId !== body.datasetId) {
      return res.status(400).json({ error: 'Primary datasetId must match the first multi-sample input.' });
    }
  }
  if (body.jobType === 'spatial.seurat.v1') {
    try {
      validateSpatialSeuratParams(body.parameters);
    } catch (e) {
      return res.status(400).json({ error: e.message || 'Invalid spatial.seurat.v1 parameters.' });
    }
    if (body.datasetId === undefined || body.datasetId === null) {
      return res.status(400).json({ error: 'spatial.seurat.v1 requires datasetId.' });
    }
  }

  if (body.jobType === 'enrichment.gsea.v1') {
    try {
      validateEnrichmentGseaParams(body.parameters);
    } catch (e) {
      return res.status(400).json({
        error: e && e.message ? e.message : 'Invalid enrichment.gsea.v1 parameters.',
      });
    }
  }
  if (body.jobType === 'cellchat.infer.v1') {
    try {
      validateCellChatInferenceParams(body.parameters);
    } catch (e) {
      return res.status(400).json({
        error: e && e.message ? e.message : 'Invalid cellchat.infer.v1 parameters.',
      });
    }
  }
  if (body.jobType === 'explore.summarize.v1') {
    try {
      validateExploratoryAnalysisParams(body.parameters);
    } catch (e) {
      return res.status(400).json({
        error: e && e.message ? e.message : 'Invalid explore.summarize.v1 parameters.',
      });
    }
  }

  if (config.demoMode()) {
    if (!req.user.isDemoGuest) {
      return res.status(403).json({ error: 'Only an active demo guest may launch demo compute.' });
    }
    if (guidedDemoMode() && !DEMO_JOB_TYPES.includes(body.jobType)) {
      return res.status(403).json({ error: 'This capability is disabled for the demo. Try the standard Seurat workflow.' });
    }
    if (body.jobType === 'expert.r.v1') {
      return res.status(403).json({ error: 'Expert R is disabled in the public demo.' });
    }
    const heavyTypes = [
      'pbmc.pipeline.v1', 'seurat.pipeline.v1', 'seurat.multisample.v1', 'deg.find_markers.v1',
      'enrichment.gsea.v1', 'cellchat.infer.v1', 'explore.summarize.v1',
      'condition.pseudobulk_de.v1',
      'spatial.seurat.v1',
    ];
    if (heavyTypes.includes(body.jobType) && body.requestId === undefined) {
      const { rows } = await db.query(
        `SELECT
           COUNT(*) FILTER (WHERE owner_user_id = $1)::int AS guest_active,
           COUNT(*)::int AS global_active
         FROM jobs job JOIN users owner ON owner.id = job.owner_user_id
        WHERE owner.is_demo_guest = TRUE AND job.status IN ('queued', 'running')
          AND job.job_type = ANY($2::text[])`,
        [Number(req.user.id), heavyTypes]
      );
      if (Number(rows[0]?.guest_active) >= 1 || Number(rows[0]?.global_active) >= config.demoMaxGlobalHeavyJobs()) {
        res.setHeader('Retry-After', '10');
        return res.status(429).json({
          error: Number(rows[0]?.guest_active) >= 1
            ? 'This demo session already has an active compute job.'
            : 'The public demo compute pool is currently full.',
        });
      }
    }
  }

  try {
    let jobParameters = body.parameters;
    if (body.jobType === 'expert.r.v1') {
      await db.requireProjectRole(req.user.id, req.params.projectId, ['owner', 'admin', 'analyst']);
      const access = await db.getExpertRCapabilities(req.user.id, req.params.projectId);
      if (!access.canExecuteExpertR) return res.status(403).json({ error: 'Expert R access is not enabled for this account and project.' });
      if (!require('./backend/expertR').expertRSandboxEnabled()) return res.status(403).json({ error: 'Expert R is disabled for this installation.' });
      let validated;
      try { validated = require('./backend/expertR').validateExpertRParams(body.parameters).params; }
      catch { return res.status(400).json({ error: 'Expert R parameters are invalid. Check the script, input references and environment.' }); }
      try {
        const manifest = await require('./backend/expertSandboxClient').getExpertREnvironment();
        jobParameters = require('./backend/rEnvironment').pinExpertREnvironment(validated, manifest);
      } catch (error) {
        const mismatch = error.code === 'R_ENVIRONMENT_MISMATCH' || error.code === 'R_ENVIRONMENT_INVALID';
        return res.status(mismatch ? 409 : 503).json({ error: mismatch
          ? 'The selected exact R environment is unavailable. Refresh its recorded environment before submitting.'
          : 'The exact R environment could not be verified. Check the private runtime and retry.' });
      }
    }
    const created = await db.createProjectJob(req.user.id, req.params.projectId, {
      analysisObjectId: body.analysisObjectId,
      resultAnalysisObjectId: body.resultAnalysisObjectId,
      datasetId: body.datasetId,
      jobType: body.jobType,
      parameters: jobParameters,
      ...(body.requestId === undefined ? {} : { requestId: body.requestId }),
    }, submissionHash);
    res.setHeader('Cache-Control', 'no-store');
    res.status(created.submissionCreated === false ? 200 : 201).json(db.toPublicJob(created));
  } catch (e) {
    sendProjectResourceError(res, e, 'ProjectJobs');
  }
});

app.get('/api/projects/:projectId/job-submissions/:requestId', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const receipt = await db.getProjectJobSubmission(req.user.id, req.params.projectId, req.params.requestId);
    if (!receipt) return res.status(404).json({ error: 'Submission receipt not found.' });
    res.json(receipt);
  } catch (error) { sendProjectResourceError(res, error, 'ProjectJobSubmission'); }
});

app.get('/api/projects/:projectId/jobs', async (req, res) => {
  const filters = {
    status: typeof req.query.status === 'string' ? req.query.status : undefined,
    jobType: typeof req.query.jobType === 'string' ? req.query.jobType : undefined,
    analysisObjectId: typeof req.query.analysisObjectId === 'string' ? req.query.analysisObjectId : undefined,
    resultAnalysisObjectId: typeof req.query.resultAnalysisObjectId === 'string' ? req.query.resultAnalysisObjectId : undefined,
    datasetId: typeof req.query.datasetId === 'string' ? req.query.datasetId : undefined
  };
  try {
    res.json((await db.listProjectJobs(req.user.id, req.params.projectId, filters)).map(db.toPublicJob));
  } catch (e) {
    sendProjectResourceError(res, e, 'ProjectJobs');
  }
});

app.get('/api/projects/:projectId/jobs/:jobId', async (req, res) => {
  if (!isValidJobIdFormat(req.params.jobId)) {
    return res.status(400).json({ error: 'Malformed job ID.' });
  }
  try {
    const job = await db.getProjectJob(req.user.id, req.params.projectId, req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found.' });
    res.json(db.toPublicJob(job));
  } catch (e) {
    sendProjectResourceError(res, e, 'ProjectJobs');
  }
});

app.get('/api/projects/:projectId/jobs/:jobId/logs', async (req, res) => {
  if (!isValidJobIdFormat(req.params.jobId)) {
    return res.status(400).json({ error: 'Malformed job ID.' });
  }
  try {
    const job = await db.getProjectJob(req.user.id, req.params.projectId, req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found.' });
    const publicJob = db.toPublicJob(job);
    res.json({ id: publicJob.id, status: publicJob.status, logs: publicJob.logs, error: publicJob.error });
  } catch (e) {
    sendProjectResourceError(res, e, 'ProjectJobs');
  }
});

app.post('/api/projects/:projectId/jobs/:jobId/retry', async (req, res) => {
  if (!isValidJobIdFormat(req.params.jobId)) {
    return res.status(400).json({ error: 'Malformed job ID.' });
  }
  const bodyIsEmptyObject = req.body === undefined || (
    req.body !== null
      && typeof req.body === 'object'
      && !Array.isArray(req.body)
      && Object.keys(req.body).length === 0
  );
  if (!bodyIsEmptyObject) {
    return res.status(400).json({
      error: 'Retry uses the recorded run inputs and does not accept request fields.',
    });
  }
  try {
    const result = await db.retryProjectJob(req.user.id, req.params.projectId, req.params.jobId);
    res.status(result.created ? 201 : 200).json(db.toPublicJob(result.job));
  } catch (e) {
    sendProjectResourceError(res, e, 'ProjectJobRetry');
  }
});

app.post('/api/projects/:projectId/jobs/:jobId/cancel', async (req, res) => {
  if (!isValidJobIdFormat(req.params.jobId)) {
    return res.status(400).json({ error: 'Malformed job ID.' });
  }
  try {
    const job = await db.cancelProjectJob(req.user.id, req.params.projectId, req.params.jobId);
    res.json(db.toPublicJob(job));
  } catch (e) {
    sendProjectResourceError(res, e, 'ProjectJobs');
  }
});

// ── Project-scoped provenance metadata ──────────────────────────────────
// Append-only provenance records associated with a project, readable by project
// members by role. project_id comes from the route; the responsible actor from
// the session. There is no update/delete route (provenance is append-only). R
// execution/state is untouched — this is metadata only.
app.post('/api/projects/:projectId/provenance', async (req, res) => {
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
    const created = await db.createProjectProvenance(req.user.id, req.params.projectId, {
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

app.get('/api/projects/:projectId/provenance', async (req, res) => {
  const filters = {
    datasetId: typeof req.query.datasetId === 'string' ? req.query.datasetId : undefined,
    analysisObjectId: typeof req.query.analysisObjectId === 'string' ? req.query.analysisObjectId : undefined,
    jobId: typeof req.query.jobId === 'string' ? req.query.jobId : undefined,
    operation: typeof req.query.operation === 'string' ? req.query.operation : undefined
  };
  try {
    res.json(await db.listProjectProvenance(req.user.id, req.params.projectId, filters));
  } catch (e) {
    sendProjectResourceError(res, e, 'ProjectProvenance');
  }
});

app.get('/api/projects/:projectId/provenance/:provenanceId', async (req, res) => {
  if (!isValidProvenanceIdFormat(req.params.provenanceId)) {
    return res.status(400).json({ error: 'Malformed provenance ID.' });
  }
  try {
    const prov = await db.getProjectProvenance(req.user.id, req.params.projectId, req.params.provenanceId);
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

app.post('/api/projects/:projectId/figures', async (req, res) => {
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
    const created = await db.createProjectFigure(req.user.id, req.params.projectId, {
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

app.get('/api/projects/:projectId/figures', async (req, res) => {
  const filters = {
    analysisObjectId: typeof req.query.analysisObjectId === 'string' ? req.query.analysisObjectId : undefined,
    jobId: typeof req.query.jobId === 'string' ? req.query.jobId : undefined,
    provenanceId: typeof req.query.provenanceId === 'string' ? req.query.provenanceId : undefined,
    datasetId: typeof req.query.datasetId === 'string' ? req.query.datasetId : undefined,
    plotType: typeof req.query.plotType === 'string' ? req.query.plotType : undefined
  };
  try {
    res.json(await db.listProjectFigures(req.user.id, req.params.projectId, filters));
  } catch (e) {
    sendProjectResourceError(res, e, 'ProjectFigures');
  }
});

app.get('/api/projects/:projectId/figures/:figureId', async (req, res) => {
  if (!isValidFigureIdFormat(req.params.figureId)) {
    return res.status(400).json({ error: 'Malformed figure ID.' });
  }
  try {
    const fig = await db.getProjectFigure(req.user.id, req.params.projectId, req.params.figureId);
    if (!fig) return res.status(404).json({ error: 'Figure not found.' });
    res.json(fig);
  } catch (e) {
    sendProjectResourceError(res, e, 'ProjectFigures');
  }
});

// ── Project-scoped job artifacts & checkpoints (read-only metadata) ──────
// Durable artifact/checkpoint METADATA produced by jobs, readable by project
// members by role. There is intentionally NO create/mutate route (artifact
// creation is worker/helper-driven), and these endpoints return metadata only.
// A separate exact allowlist below provides controlled authenticated exports for
// selected result tables; checkpoints remain non-downloadable. The serializer
// omits storage_uri, so no internal/local path or storage key is ever exposed;
// claim tokens / worker internals are not in the artifact model at all. Legacy
// NULL-project artifacts never appear (the helpers always pin a real project_id).
app.get('/api/projects/:projectId/artifacts', async (req, res) => {
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
    res.json(await db.listProjectArtifacts(req.user.id, req.params.projectId, filters));
  } catch (e) {
    sendProjectResourceError(res, e, 'ProjectArtifacts');
  }
});

app.get('/api/projects/:projectId/artifacts/:artifactId', async (req, res) => {
  if (!isValidArtifactIdFormat(req.params.artifactId)) {
    return res.status(400).json({ error: 'Malformed artifact ID.' });
  }
  try {
    const artifact = await db.getProjectArtifact(req.user.id, req.params.projectId, req.params.artifactId);
    if (!artifact) return res.status(404).json({ error: 'Artifact not found.' });
    res.json(artifact);
  } catch (e) {
    sendProjectResourceError(res, e, 'ProjectArtifacts');
  }
});

app.get('/api/projects/:projectId/jobs/:jobId/artifacts', async (req, res) => {
  if (!isValidJobIdFormat(req.params.jobId)) {
    return res.status(400).json({ error: 'Malformed job ID.' });
  }
  const filters = {
    artifactType: typeof req.query.artifactType === 'string' ? req.query.artifactType : undefined,
    status: typeof req.query.status === 'string' ? req.query.status : undefined,
    resultAnalysisObjectId: typeof req.query.resultAnalysisObjectId === 'string' ? req.query.resultAnalysisObjectId : undefined
  };
  try {
    res.json(await db.listProjectJobArtifacts(req.user.id, req.params.projectId, req.params.jobId, filters));
  } catch (e) {
    sendProjectResourceError(res, e, 'ProjectArtifacts');
  }
});

// ── R Plumber Proxy ─────────────────────────────────────────────────────
// Forward all /api/r/* requests to localhost:8000/*
app.use('/api/r', requireAuth);
app.use('/api/r', enforceRProxyCsrfForCookieAuth);
app.use('/api/r', (req, res, next) => {
  if (String(req.originalUrl || '').length > 8192) {
    return res.status(414).json({ error: 'R request URL is too long.' });
  }
  next();
});

// Explicit authenticated export surfaces. Internal storage keys are resolved
// only after project membership, artifact allowlist, private-work visibility,
// size, and checksum checks. Neither response exposes a server path/key.
app.get('/api/projects/:projectId/artifacts/:artifactId/download', async (req, res) => {
  if (!isValidArtifactIdFormat(req.params.artifactId)) {
    return res.status(400).json({ error: 'Malformed artifact ID.' });
  }
  let opened;
  try {
    const download = await researchExports.authorizeArtifactDownload(
      req.user.id, req.params.projectId, req.params.artifactId
    );
    opened = await durableStorage.openVerifiedRead(download.artifact.storageUri, {
      checksumSha256: download.artifact.checksumSha256,
      sizeBytes: download.artifact.sizeBytes,
    });
    await projectAudit.recordEvent(db, {
      projectId: req.params.projectId, actorUserId: req.user.id,
      action: 'artifact.downloaded', targetType: 'artifact', targetId: download.artifact.id,
      details: { artifactType: download.artifact.artifactType },
    });
    res.setHeader('Content-Type', download.mimeType);
    res.setHeader('Content-Length', String(opened.stat.size));
    res.setHeader('Content-Disposition', `attachment; filename="${download.filename}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    const stream = opened.handle.createReadStream({ autoClose: true });
    opened = null;
    stream.on('error', (error) => {
      console.error('[ProjectArtifactDownload]', error);
      if (!res.headersSent) res.status(500).json({ error: 'Artifact download failed.' });
      else res.destroy(error);
    });
    stream.pipe(res);
  } catch (error) {
    if (opened?.handle) await opened.handle.close();
    sendProjectResourceError(res, error, 'ProjectArtifactDownload');
  }
});

app.get('/api/projects/:projectId/reproducibility-manifest', async (req, res) => {
  try {
    const manifest = await researchExports.buildReproducibilityManifest(
      req.user.id,
      req.params.projectId,
      {
        branchId: typeof req.query.branchId === 'string' ? req.query.branchId : undefined,
        analysisObjectId: typeof req.query.analysisObjectId === 'string'
          ? req.query.analysisObjectId : undefined,
      }
    );
    await projectAudit.recordEvent(db, {
      projectId: req.params.projectId, actorUserId: req.user.id,
      action: 'reproducibility.exported', targetType: 'analysis_object',
      targetId: manifest.exportedAnalysisObjectId,
      details: { manifestVersion: manifest.version },
    });
    res.setHeader('Content-Disposition',
      `attachment; filename="reproducibility-${manifest.exportedAnalysisObjectId}.json"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json(manifest);
  } catch (error) {
    sendProjectResourceError(res, error, 'ProjectReproducibilityManifest');
  }
});

app.get('/api/projects/:projectId/audit-events', async (req, res) => {
  try {
    res.json(await projectAudit.listEvents(req.user.id, req.params.projectId, {
      limit: req.query.limit,
      before: typeof req.query.before === 'string' ? req.query.before : undefined,
    }));
  } catch (error) {
    sendProjectResourceError(res, error, 'ProjectAudit');
  }
});
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

// Block internal-worker-only R endpoints (e.g. POST /object/pbmc-pipeline) from the
// public catch-all BEFORE any R contact. These run ONLY through the in-process worker
// bridge (a direct R call that does not traverse this proxy), so a direct user call
// would bypass the durable job/result/artifact/lineage/provenance contract. 404 (not
// 403), consistent with the no-leak policy — the proxy never confirms the endpoint
// exists. The worker bridge is unaffected (it never reaches this middleware).
app.use('/api/r', (req, res, next) => {
  if (isInternalOnlyRProxyPath(req.path)) {
    return res.status(404).json({ error: 'Not found' });
  }
  if (isProductionBlockedRProxyPath(req.path)
      || !isAllowedProductionRProxyRequest(req.method, req.path)) {
    return res.status(404).json({ error: 'Not found' });
  }
  next();
});

// Only reviewed public paths reach body parsing. This preserves the no-leak 404
// for internal/unknown paths while still enforcing a streaming cap for every
// body that can actually be proxied to R.
app.use('/api/r', enforceRProxyRequestShape);
app.use('/api/r', parseBoundedRProxyJson);

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

app.use('/api/r', rProxyAdmission);
const rProxyTransport = createProxyServer({
  target: R_RUNTIME_CONFIG.baseUrl,
  changeOrigin: true,
  selfHandleResponse: true,
  proxyTimeout: config.rProxyTimeoutMs(),
  timeout: config.rProxyTimeoutMs() + 5000,
});
rProxyTransport.on('proxyReq', (proxyReq, req) => {
      const observeSocket = (socket) => {
        if (!socket || socket.destroyed) return;
        if (socket.connecting) socket.once('connect', () => markRProxyUpstreamConnected(req));
        else markRProxyUpstreamConnected(req);
      };
      if (proxyReq.socket) observeSocket(proxyReq.socket);
      else proxyReq.once('socket', observeSocket);
      writeRProxyRequest(proxyReq, req);
});
rProxyTransport.on('proxyRes', handleBoundedRProxyResponse);
function handleRProxyTransportError(error, req, res) {
  markRProxyUpstreamError(req);
  sendRProxyFailure(res, 502, 'R service is unavailable or exceeded its deadline.');
}
rProxyTransport.on('error', handleRProxyTransportError);
// Express removes the /api/r mount prefix. No pattern matcher is needed for
// this single, authenticated upstream; admission owns the exact path policy.
app.use('/api/r', (req, res) => {
  rProxyTransport.web(req, res).catch((error) => handleRProxyTransportError(error, req, res));
});

// ── Static Frontend ─────────────────────────────────────────────────────
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found' });
});

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
let activeRscriptDiagnostic = null;

function findRscript(env = process.env) {
  const configured = (env.RSCRIPT_PATH || env.RSCRIPT || '').trim();
  if (configured) {
    return {
      path: configured,
      source: env.RSCRIPT_PATH ? 'RSCRIPT_PATH' : 'RSCRIPT',
      exists: path.isAbsolute(configured) ? fs.existsSync(configured) : null
    };
  }
  return { path: 'Rscript', source: 'PATH', exists: null };
}

function normalizeRVersion(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (!text) return null;
  const versionMatch = text.match(/(\d+\.\d+(?:\.\d+)?)/);
  return versionMatch ? versionMatch[1] : text;
}

async function probeRHealth(timeoutMs = 750) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${R_RUNTIME_CONFIG.baseUrl}/health`, {
      headers: { 'X-API-Token': API_TOKEN, Accept: 'application/json' },
      signal: controller.signal
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `R health returned ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

async function buildRuntimeDiagnostics() {
  const detectedRscript = activeRscriptDiagnostic || findRscript();
  const diagnostics = {
    supportedTarget: SUPPORTED_R_TARGET,
    rscript: detectedRscript,
    runtime: {
      status: 'unavailable',
      mode: null,
      rVersion: null
    },
    packages: {}
  };

  try {
    const health = await probeRHealth();
    diagnostics.runtime = {
      status: health.status || 'ok',
      mode: health.mode || null,
      rVersion: normalizeRVersion(health.r_version || health.rVersion || health.version)
    };
    diagnostics.packages = health.packages || {};
  } catch (err) {
    diagnostics.runtime.error = err.name === 'AbortError' ? 'R runtime health probe timed out.' : 'R runtime health probe unavailable.';
  }

  return diagnostics;
}

function toPublicRuntimeDiagnostics(diagnostics) {
  const runtime = diagnostics && typeof diagnostics.runtime === 'object' ? diagnostics.runtime : {};
  const status = ['ok', 'ready'].includes(runtime.status) ? runtime.status : 'unavailable';
  return {
    supportedTarget: typeof diagnostics?.supportedTarget === 'string'
      ? diagnostics.supportedTarget : SUPPORTED_R_TARGET,
    runtime: {
      status,
      rVersion: normalizeRVersion(runtime.rVersion),
    },
  };
}

function startPlumber(options = {}) {
  const logger = options.logger || console;
  const spawnFn = options.spawn || spawn;
  activeRscriptDiagnostic = findRscript();
  const rscript = activeRscriptDiagnostic.path;
  const plumberScript = path.join(__dirname, 'r-backend', 'run.R');

  let readySettled = false;
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  const resolveReadyOnce = () => {
    if (readySettled) return;
    readySettled = true;
    resolveReady();
  };
  const rejectReadyOnce = (message) => {
    if (readySettled) return;
    readySettled = true;
    rejectReady(new Error(message));
  };
  
  const rProcess = spawnFn(rscript, [plumberScript], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: rRuntime.buildRChildEnv(process.env, {
      token: API_TOKEN,
      port: PLUMBER_PORT,
      storageRoot: config.storageRoot(),
      analysisRoot: __dirname,
    })
  });

  rProcess.ready = ready;
  rProcess.stdout.on('data', d => {
    const text = d.toString().trim();
    if (typeof logger.log === 'function') logger.log(`[R] ${text}`);
    else if (typeof logger.info === 'function') logger.info(`[R] ${text}`);
    if (/Plumber API running/i.test(text)) resolveReadyOnce();
  });
  rProcess.stderr.on('data', d => {
    const text = d.toString().trim();
    if (typeof logger.log === 'function') logger.log(`[R:err] ${text}`);
    else if (typeof logger.warn === 'function') logger.warn(`[R:err] ${text}`);
    if (/address already in use|Failed to create server/i.test(text)) {
      rejectReadyOnce('R backend failed to bind its configured port.');
    }
  });
  rProcess.on('close', code => {
    if (typeof logger.log === 'function') logger.log(`R process exited with code ${code}`);
    else if (typeof logger.info === 'function') logger.info(`R process exited with code ${code}`);
    rejectReadyOnce('R backend exited before it became ready.');
  });

  // If Rscript cannot be spawned at all (e.g. not installed, or a bad
  // RSCRIPT_PATH), the child emits an 'error' event. Without a listener that
  // event is thrown as an uncaught exception and takes down the whole web
  // server. The app is designed to run degraded when R is unavailable (runtime
  // diagnostics report R as unavailable and R suites skip), so log a clear,
  // actionable message and keep the Express server alive instead of crashing.
  rProcess.on('error', (err) => {
    logger.error(
      `[R] Failed to launch R Plumber backend via ${activeRscriptDiagnostic.source} ` +
      `("${rscript}"): ${err.message}`
    );
    logger.error(
      '[R] The web server will keep running, but R-backed analysis and /api/r/* ' +
      'will be unavailable until R is reachable. Install R 4.5.x + Seurat, or set ' +
      'RSCRIPT_PATH to a valid Rscript. Runtime diagnostics will report R as unavailable.'
    );
    rejectReadyOnce('R backend process could not be launched.');
  });

  process.on('exit', () => rProcess.kill());
  // Avoid an unhandled rejection when startPlumber is used in degraded mode without
  // awaiting readiness. Callers that gate worker startup still await rProcess.ready.
  ready.catch(() => {});
  return rProcess;
}

function startWebRBackend(options = {}) {
  const logger = options.logger || console;
  if (R_RUNTIME_CONFIG.mode === 'external') {
    if (typeof logger.info === 'function') {
      logger.info('[R] Using configured private external R runtime; the web process will not spawn R.');
    }
    return null;
  }
  return (options.startPlumber || startPlumber)({ logger });
}

async function startRBackendAndJobWorkerIfEnabled(env = process.env, deps = {}) {
  const logger = deps.logger || console;
  const rProcess = (deps.startPlumber || startPlumber)({ logger });
  const config = parseJobWorkerConfig(env, { logger });
  if (!config.enabled) {
    if (typeof logger.info === 'function') {
      logger.info('[worker] Job worker disabled. Set ENABLE_JOB_WORKER=true to drain durable jobs.');
    }
    return { rProcess, worker: null };
  }

  try {
    if (!rProcess || !rProcess.ready || typeof rProcess.ready.then !== 'function') {
      throw new Error('R backend readiness signal is unavailable.');
    }
    await rProcess.ready;
    await waitForOwnedRHealth(deps.probeRHealth || probeRHealth, {
      logger,
      timeoutMs: deps.rHealthTimeoutMs,
      intervalMs: deps.rHealthIntervalMs,
    });
  } catch {
    if (typeof logger.error === 'function') {
      logger.error('[worker] Job worker not started because the owned R backend is not ready. Check PLUMBER_PORT conflicts and R startup logs.');
    }
    return { rProcess, worker: null };
  }

  return { rProcess, worker: startJobWorkerIfEnabled(env, deps) };
}

async function waitForOwnedRHealth(probe = probeRHealth, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 30000;
  const intervalMs = Number(opts.intervalMs) > 0 ? Number(opts.intervalMs) : 500;
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  do {
    try {
      const health = await probe();
      if (health && health.status === 'ok') return health;
      lastError = new Error('R backend health check did not return ok.');
    } catch (err) {
      lastError = err;
    }
    if (Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  } while (Date.now() < deadline);
  throw lastError || new Error('R backend health check failed.');
}

// ── Job worker (conservative, opt-in) ────────────────────────────────────────
// Disabled by default. The minimal drain loop only runs when ENABLE_JOB_WORKER is
// explicitly the string "true", so local/dev and tests stay worker-free unless they
// ask for it. It processes only registered handlers; arbitrary job types fail
// terminally instead of becoming dynamic R execution. See backend/jobWorker.js.
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
  // The fail-fast gate above ran before any directory or socket side effects.
  // This summary is deliberately secret-free.
  console.log('[Config]', JSON.stringify(config.summary()));

  let httpServer = null;
  let ownedRProcess = null;
  let topologyWatchdog = null;
  let shuttingDown = false;
  const onShutdownSignal = (initialExitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    topologyWatchdog?.stop?.();
    topologyWatchdog = null;
    void shutdownWebRuntime({
      server: httpServer,
      rProcess: ownedRProcess,
      topologyLock: webTopologyLock,
      db,
      health: webHealth,
      logger: console,
      timeoutMs: config.webShutdownTimeoutMs(),
      drainDelayMs: config.webDrainDelayMs(),
      initialExitCode,
    });
  };
  const start = async () => {
    try {
      await initAppDatabase();
      if (shuttingDown) throw Object.assign(new Error('Startup aborted.'), { code: 'STARTUP_ABORTED' });
      webTopologyLock = await db.acquireWebTopologyLock();
      if (shuttingDown) throw Object.assign(new Error('Startup aborted.'), { code: 'STARTUP_ABORTED' });
      topologyWatchdog = startTopologyLockWatchdog({
        lock: webTopologyLock,
        onLost: () => {
          console.error('[web] topology lock lost (WEB_TOPOLOGY_LOCK_LOST); shutting down.');
          onShutdownSignal(1);
        },
      });
      httpServer = app.listen(PORT, WEB_HOST);
      httpServer.requestTimeout = 10 * 60 * 1000;
      httpServer.headersTimeout = 15000;
      httpServer.keepAliveTimeout = 5000;
      httpServer.maxRequestsPerSocket = 1000;
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          httpServer.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          httpServer.off('error', onError);
          resolve();
        };
        httpServer.once('error', onError);
        httpServer.once('listening', onListening);
      });
      console.log(`[web] listening on ${WEB_HOST}:${PORT}.`);
      ownedRProcess = startWebRBackend();
    } catch (error) {
      const code = error && typeof error.code === 'string'
        ? error.code.replace(/[^A-Z0-9_]/gi, '').slice(0, 64)
        : 'STARTUP_FAILED';
      console.error(`[web] refusing to start (${code || 'STARTUP_FAILED'}).`);
      topologyWatchdog?.stop?.();
      topologyWatchdog = null;
      try { await webTopologyLock?.release?.(); } catch { /* startup already failed */ }
      webTopologyLock = null;
      try { await db.close(); } catch { /* startup already failed */ }
      process.exit(1);
    }
  };
  void start();

  // A single latch makes close signals and fatal topology loss idempotent.
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => onShutdownSignal(0));
  }
  process.on('message', (message) => {
    if (message && message.type === 'traceomics:shutdown') onShutdownSignal(0);
  });
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
  normalizeRProxyPath,
  trustedRdsLoadEnabled,
  RDS_DESERIALIZATION_PROXY_PATHS,
  isInternalOnlyRProxyPath,
  R_PROXY_INTERNAL_ONLY_PATHS,
  isProductionBlockedRProxyPath,
  R_PROXY_PRODUCTION_BLOCKED_PATHS,
  isAllowedProductionRProxyRequest,
  R_PROXY_PRODUCTION_ALLOWLIST,
  createRProxyAdmission,
  enforceRProxyRequestShape,
  parseBoundedRProxyJson,
  writeRProxyRequest,
  handleBoundedRProxyResponse,
  sanitizeRProxyJson,
  // Exposed for tests + R proxy ownership verification
  issueSession,
  verifySession,
  verifySessionDetails,
  isValidObjectIdFormat,
  verifyRObjectOwnership,
  // Exposed for tests: HttpOnly cookie session foundation
  parseCookies,
  hasSessionCookie,
  buildSessionCookie,
  initAppDatabase,
  resolveSessionUser,
  requireAuth,
  // Exposed for tests: auth rate limiting + R path-field drift guard
  loginRateLimiter,
  signupRateLimiter,
  passwordChangeRateLimiter,
  authRateLimitMax,
  authRateLimitWindowMs,
  rateLimitDisabled,
  requireNetworkRegistrationEnabled,
  createRateLimiter,
  MAX_AUTH_RATE_LIMIT_KEYS,
  requireLegacyVaultUploadsEnabled,
  requireDatasetWriterBeforeUpload,
  R_PROXY_VALIDATED_PATH_FIELDS,
  findRscript,
  buildRuntimeDiagnostics,
  toPublicRuntimeDiagnostics,
  // Exposed for tests: opt-in job worker startup/shutdown wiring
  startPlumber,
  startWebRBackend,
  startRBackendAndJobWorkerIfEnabled,
  waitForOwnedRHealth,
  startJobWorkerIfEnabled,
  stopJobWorker,
  shutdownJobWorkerAndServer,
  webHealth,
  shutdownWebRuntime,
};
