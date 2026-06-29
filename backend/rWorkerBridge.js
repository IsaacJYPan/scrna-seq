// ── Minimal worker-to-R bridge ───────────────────────────────────────────────
//
// The smallest safe seam that lets a job worker invoke the R backend through
// SERVER-CONTROLLED code for exactly ONE explicitly allowlisted, read-only,
// metadata-only operation. It proves worker→R connectivity, explicit timeouts,
// sanitized errors, and the metadata-only artifact write path — WITHOUT opening a
// door to arbitrary R.
//
// HARD BOUNDARIES (do not weaken):
//   - This is NOT an HTTP route. It is an internal module called only by the
//     trusted worker handler. There is no public "run R bridge" endpoint.
//   - Only operations in R_BRIDGE_OPERATIONS may run. The operation NAME is the
//     only thing the caller chooses; the HTTP method + path are taken from the
//     server-defined spec, NEVER from caller input.
//   - No arbitrary R code, no client-controlled R path/endpoint/method/URL, no
//     client-controlled R state key. The `input` argument is intentionally
//     IGNORED for the one operation here (it is server-derived) — smuggling a
//     `code` / `path` / `endpoint` / `method` / `stateKey` field does nothing.
//   - Job/project/object identity is derived from the trusted `job` row, not from
//     caller input.
//   - Errors are sanitized before they can reach job logs / artifacts: raw R error
//     text, stacks, and internal URLs/hosts never escape (see sanitizeRBridgeError
//     and the default caller's catch). Thrown errors always carry a SAFE message.
//
// SCOPE (this branch): the only operation is `r.runtime.check` — a read-only call
// to the existing R `/health` endpoint that records sanitized runtime metadata. It
// touches NO analysis object, mutates NOTHING, creates NO checkpoint/result object,
// and produces NO download. This is NOT real scientific pipeline execution.

const http = require('http');

/** Coded error helper (mirrors database.js so callers can branch on err.code). */
function codedError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// Default per-call timeout. Explicit and bounded so a hung/unreachable R backend
// can never wedge a worker tick indefinitely.
const DEFAULT_R_BRIDGE_TIMEOUT_MS = 10000;

// ── Operation allowlist ──────────────────────────────────────────────────────
// The ONLY operations the bridge will run. Each entry fully describes the
// server-controlled request; nothing here is derived from caller input. To add an
// operation you must add an explicit, reviewed entry — there is no dynamic/
// pass-through path. `touchesAnalysisObject` documents (and is asserted in tests)
// that this op does not read or mutate analysis-object/live-R state.
const R_BRIDGE_OPERATIONS = Object.freeze({
  'r.runtime.check': Object.freeze({
    method: 'GET',
    path: '/health',
    artifactType: 'r_runtime_check',
    artifactName: 'R runtime check',
    artifactDescription:
      'Operational R runtime connectivity/health check. Metadata only — not a scientific result, no analysis-object data.',
    touchesAnalysisObject: false,
  }),
});

function isAllowedRBridgeOperation(operation) {
  return typeof operation === 'string'
    && Object.prototype.hasOwnProperty.call(R_BRIDGE_OPERATIONS, operation);
}

// ── Sanitization ─────────────────────────────────────────────────────────────

// Reduce an arbitrary value to a short, safe descriptive string: keep only a
// conservative character set and cap the length, so an R response field can never
// carry a path, URL, stack, or oversized blob into public artifact metadata.
function sanitizeRuntimeField(value, maxLen = 64) {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
    return null;
  }
  const cleaned = String(value).replace(/[^A-Za-z0-9 ._:+-]/g, '').trim().slice(0, maxLen);
  return cleaned === '' ? null : cleaned;
}

/**
 * Map any thrown bridge/caller error to a SAFE { code, message } pair. Known coded
 * errors get a stable, generic message; anything else collapses to a single generic
 * message. We never echo err.message verbatim from lower layers, so a raw R error
 * string, internal URL/host, or stack can never leak through job logs/artifacts.
 */
function sanitizeRBridgeError(err) {
  const code = err && typeof err.code === 'string' ? err.code : 'R_BRIDGE_ERROR';
  const SAFE_MESSAGES = {
    UNSUPPORTED_R_OPERATION: 'Requested R bridge operation is not allowlisted.',
    R_BRIDGE_MISCONFIGURED: 'R bridge is not configured.',
    R_TIMEOUT: 'R runtime did not respond before the timeout.',
    R_UNREACHABLE: 'R runtime is unreachable.',
    R_RUNTIME_CHECK_FAILED: 'R runtime check failed.',
    R_BRIDGE_ERROR: 'R bridge operation failed.',
  };
  return { code, message: SAFE_MESSAGES[code] || SAFE_MESSAGES.R_BRIDGE_ERROR };
}

// ── Default R caller (real HTTP) ─────────────────────────────────────────────
//
// Builds the function the bridge uses to actually reach R. It is intentionally
// narrow: it can only issue the server-defined { method, path } against the local
// Plumber backend with the API token, on a bounded timeout. It NEVER sends an
// X-Object-ID / R state key (so it cannot touch per-object live R state), and it
// sanitizes every low-level failure (ECONNREFUSED, socket/host details, timeouts)
// into a coded error with NO host/URL/stack, so nothing internal can leak upward.
function createDefaultRCaller(config = {}) {
  const host = '127.0.0.1';
  const port = Number(config.port) || Number(process.env.PLUMBER_PORT) || 8000;
  const token = config.token || process.env.API_TOKEN || '';

  return function callR({ method, path, timeoutMs }) {
    return new Promise((resolve, reject) => {
      if (!token) {
        reject(codedError('R_BRIDGE_MISCONFIGURED', 'R bridge is not configured.'));
        return;
      }
      let settled = false;
      const finishOk = (v) => { if (!settled) { settled = true; resolve(v); } };
      const finishErr = (e) => { if (!settled) { settled = true; reject(e); } };

      let req;
      try {
        req = http.request(
          { host, port, method, path, headers: { 'X-API-Token': token, Accept: 'application/json' } },
          (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
              const raw = Buffer.concat(chunks).toString('utf8');
              let body = null;
              try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
              finishOk({ status: res.statusCode, body });
            });
          }
        );
      } catch {
        // Never surface the raw construction error (could include host/port).
        finishErr(codedError('R_UNREACHABLE', 'R runtime is unreachable.'));
        return;
      }

      req.setTimeout(Number(timeoutMs) || DEFAULT_R_BRIDGE_TIMEOUT_MS, () => {
        req.destroy();
        finishErr(codedError('R_TIMEOUT', 'R runtime did not respond before the timeout.'));
      });
      // Collapse every transport-level error to a generic, host/URL-free code.
      req.on('error', () => finishErr(codedError('R_UNREACHABLE', 'R runtime is unreachable.')));
      req.end();
    });
  };
}

// ── The bridge ───────────────────────────────────────────────────────────────

/**
 * Run one allowlisted, metadata-only R-backed operation and return a SAFE artifact
 * descriptor describing what to record. Does NOT write to the database itself — the
 * worker handler creates the artifact through the claim-guarded helper — so the
 * bridge stays a pure, testable seam.
 *
 * @param {object}   args
 * @param {object}   args.job           trusted job row (source of jobId/projectId/owner)
 * @param {string}   args.operation     MUST be an allowlisted operation name
 * @param {object}   [args.actor]       server-derived actor info (informational)
 * @param {object}   [args.input]       IGNORED for the current op (server-derived)
 * @param {object}   [args.claimContext] e.g. { workerId } (informational; never recorded)
 * @param {object}   [args.logger]      { info, warn, error }
 * @param {function} args.callR         injected R caller (default built per worker)
 * @param {number}   [args.timeoutMs]   explicit per-call timeout
 * @returns {Promise<{artifactType,storageKind,name,description,metadata}>}
 * @throws  coded, SAFE-message errors only (see sanitizeRBridgeError codes).
 */
async function runRBridgeOperation(args = {}) {
  const { job, operation, callR } = args;
  const logger = args.logger || console;
  const timeoutMs = Number.isInteger(args.timeoutMs) && args.timeoutMs > 0
    ? args.timeoutMs : DEFAULT_R_BRIDGE_TIMEOUT_MS;

  // 1. Operation must be explicitly allowlisted. Arbitrary names are refused here,
  //    before any R contact.
  if (!isAllowedRBridgeOperation(operation)) {
    throw codedError('UNSUPPORTED_R_OPERATION', 'Requested R bridge operation is not allowlisted.');
  }
  if (!job || typeof job !== 'object') {
    throw codedError('R_BRIDGE_ERROR', 'A trusted job context is required.');
  }
  if (typeof callR !== 'function') {
    throw codedError('R_BRIDGE_MISCONFIGURED', 'R bridge is not configured.');
  }

  // 2. The request is built ENTIRELY from the server-defined spec. `args.input` is
  //    deliberately never read: the caller cannot choose method/path/code/endpoint/
  //    state key. (For r.runtime.check there is no per-job input at all.)
  const spec = R_BRIDGE_OPERATIONS[operation];
  const request = { method: spec.method, path: spec.path, timeoutMs };

  if (logger && typeof logger.info === 'function') {
    logger.info(`[r-bridge] running allowlisted operation '${operation}' (${spec.method} ${spec.path}).`);
  }

  // 3. Call R, mapping any failure to a sanitized, coded error.
  let response;
  try {
    response = await callR(request);
  } catch (err) {
    const safe = sanitizeRBridgeError(err);
    throw codedError(safe.code, safe.message);
  }

  if (!response || response.status !== 200) {
    // Never include the raw body/status text — only a generic, stable message.
    throw codedError('R_RUNTIME_CHECK_FAILED', 'R runtime check failed.');
  }

  // 4. Build SAFE, metadata-only artifact metadata. Only a small, sanitized set of
  //    known runtime fields is kept; everything else from the R response is dropped.
  const body = response.body && typeof response.body === 'object' ? response.body : {};
  const runtime = {};
  const status = sanitizeRuntimeField(body.status);
  const mode = sanitizeRuntimeField(body.mode);
  if (status) runtime.status = status;
  if (mode) runtime.mode = mode;

  const metadata = {
    operation,
    kind: 'operational',
    scientific_output: false,
    checkedAt: new Date().toISOString(),
    runtime,
  };

  return {
    operation,
    artifactType: spec.artifactType,
    storageKind: 'metadata_only',
    name: spec.artifactName,
    description: spec.artifactDescription,
    metadata,
  };
}

module.exports = {
  DEFAULT_R_BRIDGE_TIMEOUT_MS,
  R_BRIDGE_OPERATIONS,
  isAllowedRBridgeOperation,
  sanitizeRuntimeField,
  sanitizeRBridgeError,
  createDefaultRCaller,
  runRBridgeOperation,
};
