const express = require('express');

// Transport layer for the authenticated R Plumber proxy: admission control,
// request shape/size limits, upstream header forwarding and bounded, redacted
// response handling.
function createRProxyTransport({ config, db, rRuntimeConfig, apiToken, deriveRStateKey, normalizeRProxyPath }) {
  // A downstream browser disconnect does not prove that a synchronous R handler
  // stopped. Keep the admission lease attached to the request until the upstream
  // response actually settles, or until the full R deadline has elapsed. Without
  // this fence an aborting client could immediately open another expensive request
  // while the first one was still consuming the single shared R process.
  const R_PROXY_ADMISSION_STATE = Symbol('rProxyAdmissionState');
  const R_PROXY_CONCURRENCY_EXEMPT_GET_PATHS = new Set(['/health', '/session-id']);
  // Constant-size, read-only state reads that pages repeat on every navigation.
  // They count against their own budget, not the analysis request budget.
  const R_PROXY_STATE_POLL_GET_PATHS = new Set(['/health', '/session-id', '/pipeline-state']);

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

  // After a browser abort the proxy destroys the upstream request, so admission
  // can no longer observe R finishing and must keep the slot fenced. The v1 R
  // service is one Plumber process that evaluates handlers sequentially (no
  // promises/future), so a later direct /health reply proves every earlier
  // handler has returned. `drainProbe` uses that to release the fence early;
  // without a probe (or when it keeps failing) the fence lasts until the R
  // deadline exactly as before.
  const R_PROXY_DRAIN_PROBE_INTERVAL_MS = 1000;

  // True once the client connection has gone away. `req.destroyed` alone is not
  // enough: Node also marks a request destroyed after its body has been read,
  // which is the normal state of every proxied POST.
  function rProxyClientGone(req, res) {
    return Boolean(req.aborted || req.socket?.destroyed || res.destroyed || res.writableEnded);
  }

  function createRProxyAdmission(options = {}) {
    const drainProbe = typeof options.drainProbe === 'function' ? options.drainProbe : null;
    const drainProbeIntervalMs = Number.isInteger(options.drainProbeIntervalMs) && options.drainProbeIntervalMs > 0
      ? options.drainProbeIntervalMs : R_PROXY_DRAIN_PROBE_INTERVAL_MS;
    const hits = new Map();
    const activeByUser = new Map();
    let activeTotal = 0;

    function middleware(req, res, next) {
      const userKey = String(req.user?.id || 'unknown');
      const now = Date.now();
      const windowMs = config.rProxyRateLimitWindowMs();
      const statePoll = String(req.method || '').toUpperCase() === 'GET'
        && R_PROXY_STATE_POLL_GET_PATHS.has(normalizeRProxyPath(req.path));
      const maxRequests = statePoll ? config.rProxyStatePollRateLimitMax() : config.rProxyRateLimitMax();
      const bucketKey = statePoll ? `${userKey}:state` : userKey;
      let entry = hits.get(bucketKey);
      if (!entry || now >= entry.resetAt) {
        entry = { count: 0, resetAt: now + windowMs };
        hits.set(bucketKey, entry);
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

      // The browser can abandon a request (a page re-render or navigation aborts
      // it) while earlier asynchronous checks run. Its 'close' event has then
      // already fired, so a slot taken now would never be released. Nothing has
      // been sent to R, so there is nothing to wait for.
      if (rProxyClientGone(req, res)) return undefined;

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
      const startDrainProbe = () => {
        // Only a single-process R service gives the sequential-handler guarantee.
        if (!drainProbe || config.rProxyMaxConcurrent() !== 1) return;
        const attempt = () => {
          if (released) return;
          Promise.resolve()
            .then(() => drainProbe())
            .then(() => { release(); }, () => {
              if (released) return;
              const retry = setTimeout(attempt, drainProbeIntervalMs);
              if (typeof retry.unref === 'function') retry.unref();
            });
        };
        // The first probe queues directly behind the aborted handler in R, so it
        // answers as soon as that handler returns.
        attempt();
      };
      const scheduleConservativeRelease = () => {
        if (released || conservativeReleaseTimer) return;
        indeterminate = true;
        conservativeReleaseTimer = setTimeout(release, config.rProxyTimeoutMs());
        if (typeof conservativeReleaseTimer.unref === 'function') {
          conservativeReleaseTimer.unref();
        }
        startDrainProbe();
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
    proxyReq.setHeader('Host', new URL(rRuntimeConfig.baseUrl).host);
    proxyReq.setHeader('Accept', 'application/json');
    proxyReq.setHeader('X-API-Token', apiToken);
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
          const recorded = await require('./liveExecutionJournal').recordLiveRExecutionBounded({ db, req, envelope: parsed });
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

  return {
    createRProxyAdmission,
    rProxyClientGone,
    sendRProxyFailure,
    markRProxyUpstreamConnected,
    markRProxyUpstreamError,
    markRProxyAdmissionSettled,
    markRProxyAdmissionIndeterminate,
    enforceRProxyRequestShape,
    parseBoundedRProxyJson,
    writeRProxyRequest,
    handleBoundedRProxyResponse,
    sanitizeRProxyJson,
  };
}

module.exports = { createRProxyTransport };
