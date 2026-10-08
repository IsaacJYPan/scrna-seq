import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';

const {
  createRProxyAdmission,
  enforceRProxyRequestShape,
  handleBoundedRProxyResponse,
  isProductionBlockedRProxyPath,
  sanitizeRProxyJson,
  writeRProxyRequest,
} = require('../server');

const SAVED = {};
const ENV_KEYS = [
  'R_PROXY_MAX_CONCURRENT', 'R_PROXY_RATE_LIMIT_MAX',
  'R_PROXY_RATE_LIMIT_WINDOW_MS', 'R_PROXY_MAX_RESPONSE_BYTES',
  'R_PROXY_TIMEOUT_MS',
];

for (const key of ENV_KEYS) SAVED[key] = process.env[key];

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const key of ENV_KEYS) {
    if (SAVED[key] === undefined) delete process.env[key];
    else process.env[key] = SAVED[key];
  }
});

function fakeResponse() {
  const res = new EventEmitter();
  res.headers = {};
  res.headersSent = false;
  res.writableEnded = false;
  res.statusCode = 200;
  res.setHeader = (name, value) => { res.headers[String(name).toLowerCase()] = String(value); };
  res.status = (status) => { res.statusCode = status; return res; };
  res.json = (body) => {
    res.body = body;
    res.writableEnded = true;
    res.emit('finish');
    return res;
  };
  res.end = (body) => {
    res.rawBody = body === undefined ? Buffer.alloc(0) : Buffer.from(body);
    res.writableEnded = true;
    res.emit('finish');
  };
  return res;
}

function fakeProxyRequest(initialHeaders = {}) {
  const headers = new Map(Object.entries(initialHeaders).map(([key, value]) => [key.toLowerCase(), String(value)]));
  return {
    writes: [],
    getHeaderNames: () => [...headers.keys()],
    removeHeader: (name) => headers.delete(String(name).toLowerCase()),
    setHeader: (name, value) => headers.set(String(name).toLowerCase(), String(value)),
    getHeader: (name) => headers.get(String(name).toLowerCase()),
    write(body) { this.writes.push(Buffer.from(body)); },
    headers,
  };
}

describe('bounded authenticated R proxy policy', () => {
  it('hard-blocks unbounded legacy export/load routes in production across normalized spellings', () => {
    for (const path of [
      '/export-figure', '/export-figure/', '//export-figure', '%2Fexport-figure',
      '/load-local-10x', '/load-h5ad', '/load-multi-10x',
      '/csv-columns', '/add-metadata', '/subset', '/integrate',
    ]) {
      expect(isProductionBlockedRProxyPath(path, { NODE_ENV: 'production' })).toBe(true);
      expect(isProductionBlockedRProxyPath(path, { NODE_ENV: 'development' })).toBe(false);
    }
  });

  it('keeps the shared-R slot fenced after a browser abort until the R deadline', () => {
    vi.useFakeTimers();
    process.env.R_PROXY_MAX_CONCURRENT = '1';
    process.env.R_PROXY_RATE_LIMIT_MAX = '20';
    process.env.R_PROXY_TIMEOUT_MS = '100';
    const admission = createRProxyAdmission();
    const first = fakeResponse();
    const next = vi.fn();

    admission({ user: { id: 1 } }, first, next);
    expect(next).toHaveBeenCalledTimes(1);
    first.emit('close');

    const whileRMayStillRun = fakeResponse();
    admission({ user: { id: 2 } }, whileRMayStillRun, next);
    expect(whileRMayStillRun.statusCode).toBe(429);
    expect(next).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(99);
    const stillFenced = fakeResponse();
    admission({ user: { id: 3 } }, stillFenced, next);
    expect(stillFenced.statusCode).toBe(429);

    vi.advanceTimersByTime(1);
    const afterDeadline = fakeResponse();
    admission({ user: { id: 4 } }, afterDeadline, next);
    expect(next).toHaveBeenCalledTimes(2);
  });

  it('admits only one shared-R request at a time and releases on response completion', () => {
    process.env.R_PROXY_MAX_CONCURRENT = '1';
    process.env.R_PROXY_RATE_LIMIT_MAX = '10';
    const admission = createRProxyAdmission();
    const first = fakeResponse();
    const second = fakeResponse();
    const third = fakeResponse();
    const next = vi.fn();

    admission({ user: { id: 1 } }, first, next);
    expect(next).toHaveBeenCalledTimes(1);
    admission({ user: { id: 2 } }, second, next);
    expect(second.statusCode).toBe(429);
    expect(second.body.error).toMatch(/busy/i);

    first.emit('finish');
    admission({ user: { id: 2 } }, third, next);
    expect(next).toHaveBeenCalledTimes(2);
  });

  it('keeps bounded read-only runtime probes out of the heavy concurrency slot', () => {
    process.env.R_PROXY_MAX_CONCURRENT = '1';
    process.env.R_PROXY_RATE_LIMIT_MAX = '10';
    const admission = createRProxyAdmission();
    const next = vi.fn();

    admission({ method: 'GET', path: '/health', user: { id: 1 } }, fakeResponse(), next);
    admission({ method: 'GET', path: '/session-id', user: { id: 1 } }, fakeResponse(), next);
    const heavy = fakeResponse();
    admission({ method: 'GET', path: '/normalize', user: { id: 1 } }, heavy, next);

    expect(next).toHaveBeenCalledTimes(3);
    expect(heavy.statusCode).toBe(200);
  });

  it('rate-limits by authenticated user without echoing request data', () => {
    process.env.R_PROXY_MAX_CONCURRENT = '1';
    process.env.R_PROXY_RATE_LIMIT_MAX = '1';
    const admission = createRProxyAdmission();
    const first = fakeResponse();
    admission({ user: { id: 7 } }, first, () => {});
    first.emit('finish');

    const rejected = fakeResponse();
    admission({ user: { id: 7 } }, rejected, () => {
      throw new Error('must not admit');
    });
    expect(rejected.statusCode).toBe(429);
    expect(rejected.body).toEqual({ error: 'R request rate limit exceeded. Please retry later.' });
    expect(rejected.headers['retry-after']).toBeDefined();
  });

  it('rejects non-JSON, oversized, body-bearing GET, and unsupported request shapes', () => {
    const cases = [
      [{ method: 'GET', headers: { 'transfer-encoding': 'chunked' } }, 400],
      [{ method: 'GET', headers: { 'content-length': '1' } }, 400],
      [{ method: 'POST', headers: { 'content-type': 'text/plain', 'content-length': '2' } }, 415],
      [{ method: 'POST', headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' } }, 415],
      [{ method: 'POST', headers: { 'content-type': 'application/json', 'content-length': String(256 * 1024 + 1) } }, 413],
      [{ method: 'PUT', headers: {} }, 404],
    ];
    for (const [req, expectedStatus] of cases) {
      const res = fakeResponse();
      const next = vi.fn();
      enforceRProxyRequestShape(req, res, next);
      expect(res.statusCode).toBe(expectedStatus);
      expect(next).not.toHaveBeenCalled();
    }
    const next = vi.fn();
    enforceRProxyRequestShape({
      method: 'POST', headers: { 'content-type': 'application/problem+json', 'content-length': '2' },
    }, fakeResponse(), next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('replaces copied browser headers with the narrow R trust-boundary set', () => {
    const proxyReq = fakeProxyRequest({
      cookie: 'session=secret',
      authorization: 'Bearer browser-secret',
      'x-forwarded-for': '203.0.113.4',
      'x-api-token': 'attacker-token',
      'x-object-id': 'attacker-object',
      'accept-encoding': 'gzip',
      'content-type': 'text/plain',
      'content-length': '999',
    });
    writeRProxyRequest(proxyReq, {
      method: 'POST',
      user: { id: 17, email: 'owner@example.test' },
      verifiedObjectId: null,
      body: { ok: true },
    });

    expect([...proxyReq.headers.keys()].sort()).toEqual([
      'accept', 'content-length', 'content-type', 'host', 'x-api-token', 'x-object-id',
    ]);
    expect(proxyReq.getHeader('authorization')).toBeUndefined();
    expect(proxyReq.getHeader('cookie')).toBeUndefined();
    expect(proxyReq.getHeader('x-forwarded-for')).toBeUndefined();
    expect(proxyReq.getHeader('x-api-token')).not.toBe('attacker-token');
    expect(proxyReq.getHeader('x-object-id')).toBe('user-17');
    expect(Buffer.concat(proxyReq.writes).toString('utf8')).toBe('{"ok":true}');
  });

  it('buffers only up to the configured response cap and returns a sanitized failure', () => {
    process.env.R_PROXY_MAX_RESPONSE_BYTES = '5';
    const proxyRes = new EventEmitter();
    proxyRes.statusCode = 200;
    proxyRes.headers = { 'content-type': 'application/json' };
    proxyRes.destroy = vi.fn();
    const res = fakeResponse();

    handleBoundedRProxyResponse(proxyRes, {}, res);
    proxyRes.emit('data', Buffer.from('123456'));

    expect(proxyRes.destroy).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(502);
    expect(JSON.parse(res.rawBody.toString('utf8'))).toEqual({
      error: 'R response exceeded the configured size limit.',
    });
  });

  it('rejects an oversized declared response before buffering it', () => {
    process.env.R_PROXY_MAX_RESPONSE_BYTES = '5';
    const proxyRes = new EventEmitter();
    proxyRes.statusCode = 200;
    proxyRes.headers = { 'content-type': 'application/json', 'content-length': '6' };
    proxyRes.destroy = vi.fn();
    const res = fakeResponse();
    handleBoundedRProxyResponse(proxyRes, {}, res);
    expect(proxyRes.destroy).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(502);
  });

  it('forwards a bounded response with only safe response headers', () => {
    process.env.R_PROXY_MAX_RESPONSE_BYTES = '64';
    const proxyRes = new EventEmitter();
    proxyRes.statusCode = 201;
    proxyRes.headers = {
      'content-type': 'application/json',
      'set-cookie': 'must-not-forward=1',
      'x-internal-path': 'C:\\secret',
    };
    proxyRes.destroy = vi.fn();
    const res = fakeResponse();

    handleBoundedRProxyResponse(proxyRes, {}, res);
    proxyRes.emit('data', Buffer.from('{"ok":true}'));
    proxyRes.emit('end');

    expect(res.statusCode).toBe(201);
    expect(res.rawBody.toString('utf8')).toBe('{"ok":true}');
    expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.headers['x-internal-path']).toBeUndefined();
  });

  it('never forwards non-JSON success or non-2xx upstream bodies', () => {
    process.env.R_PROXY_MAX_RESPONSE_BYTES = '256';
    for (const scenario of [
      { status: 200, headers: { 'content-type': 'text/html' }, body: '<pre>C:\\secret\\trace</pre>', expected: 502,
        error: 'R service returned an invalid response.' },
      { status: 500, headers: { 'content-type': 'text/plain' }, body: 'C:\\secret\\trace', expected: 500,
        error: 'R request failed.' },
    ]) {
      const proxyRes = new EventEmitter();
      proxyRes.statusCode = scenario.status;
      proxyRes.headers = scenario.headers;
      proxyRes.destroy = vi.fn();
      const res = fakeResponse();
      handleBoundedRProxyResponse(proxyRes, {}, res);
      proxyRes.emit('data', Buffer.from(scenario.body));
      proxyRes.emit('end');
      expect(res.statusCode).toBe(scenario.expected);
      expect(JSON.parse(res.rawBody.toString('utf8'))).toEqual({ error: scenario.error });
      expect(res.rawBody.toString('utf8')).not.toMatch(/secret|trace/i);
    }
  });

  it('parses and sanitizes JSON success even when upstream omits content type', () => {
    process.env.R_PROXY_MAX_RESPONSE_BYTES = '256';
    const proxyRes = new EventEmitter();
    proxyRes.statusCode = 200;
    proxyRes.headers = {};
    proxyRes.destroy = vi.fn();
    const res = fakeResponse();
    handleBoundedRProxyResponse(proxyRes, {}, res);
    proxyRes.emit('data', Buffer.from('{"status":"ok","r_home":"C:\\\\R","message":"loaded C:\\\\private\\\\x.rds"}'));
    proxyRes.emit('end');
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.rawBody.toString('utf8'))).toEqual({ status: 'ok', message: 'loaded [redacted-path]' });
    expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
  });

  it('turns a top-level R error object with a 2xx status into a generic failure', () => {
    process.env.R_PROXY_MAX_RESPONSE_BYTES = '256';
    const proxyRes = new EventEmitter();
    proxyRes.statusCode = 200;
    proxyRes.headers = { 'content-type': 'application/json' };
    proxyRes.destroy = vi.fn();
    const res = fakeResponse();
    handleBoundedRProxyResponse(proxyRes, {}, res);
    proxyRes.emit('data', Buffer.from('{"error":"raw C:\\\\private\\\\trace"}'));
    proxyRes.emit('end');
    expect(res.statusCode).toBe(502);
    expect(JSON.parse(res.rawBody.toString('utf8'))).toEqual({ error: 'R request failed.' });
  });

  it('preserves a completed R result and reports history failure without retrying the mutation', async () => {
    process.env.R_PROXY_MAX_RESPONSE_BYTES = '4096';
    const journal = require('./liveExecutionJournal');
    const capture = vi.spyOn(journal, 'recordLiveRExecutionBounded').mockRejectedValue(new Error('private database connection diagnostic'));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const proxyRes = new EventEmitter(); proxyRes.statusCode = 200; proxyRes.headers = {}; proxyRes.destroy = vi.fn();
    const res = fakeResponse();
    const response = { provenance: { execution: { generation: 'a'.repeat(64), order: 1 } }, result: { completed: true }, live_state: { live_revision: 2 } };
    handleBoundedRProxyResponse(proxyRes, { method: 'GET', verifiedObjectId: 'ao_owned', user: { id: 1 } }, res);
    proxyRes.emit('data', Buffer.from(JSON.stringify(response))); proxyRes.emit('end');
    await vi.waitFor(() => expect(res.writableEnded).toBe(true));
    expect(JSON.parse(res.rawBody.toString('utf8'))).toEqual({ ...response, execution_history: { status: 'unavailable' } });
    expect(res.statusCode).toBe(200); expect(capture).toHaveBeenCalledOnce();
    expect(warning.mock.calls.flat().join(' ')).not.toContain('private database');
  });

  it('links the recorded live R execution to its successful response', async () => {
    process.env.R_PROXY_MAX_RESPONSE_BYTES = '4096';
    const journal = require('./liveExecutionJournal');
    const capture = vi.spyOn(journal, 'recordLiveRExecutionBounded').mockResolvedValue({ id: 'lex_saved', status: 'recorded' });
    const proxyRes = new EventEmitter(); proxyRes.statusCode = 200; proxyRes.headers = {}; proxyRes.destroy = vi.fn();
    const res = fakeResponse();
    const response = { provenance: { execution: { generation: 'a'.repeat(64), order: 1 } }, result: { completed: true } };
    handleBoundedRProxyResponse(proxyRes, { method: 'POST', verifiedObjectId: 'ao_owned', user: { id: 1 } }, res);
    proxyRes.emit('data', Buffer.from(JSON.stringify(response))); proxyRes.emit('end');
    await vi.waitFor(() => expect(res.writableEnded).toBe(true));
    expect(JSON.parse(res.rawBody.toString('utf8')).execution_history).toEqual({ id: 'lex_saved', status: 'recorded' });
    expect(capture).toHaveBeenCalledOnce();
  });

  it('removes private runtime/path fields and redacts paths in public scripts', () => {
    expect(sanitizeRProxyJson({
      status: 'ok',
      r_home: 'C:\\R\\4.5',
      result: { file_path: '/srv/private/output.png', storage_key: 'projects/secret' },
      provenance: { script: "readRDS('/srv/private/checkpoint.rds')" },
    })).toEqual({
      status: 'ok',
      result: {},
      provenance: { script: "readRDS('[redacted-path]')" },
    });
  });

  it('redacts URI, storage, and derived-state strings even when they arrive in a benign-looking label', () => {
    expect(sanitizeRProxyJson({
      labels: [
        'file:///srv/private/cellchat.csv',
        'https://example.invalid/private/result',
        'vault/owner/cellchat.csv',
        'projects/proj_1/artifacts/job_1/cellchat.csv',
        'user-7:obj-ao_abc123',
      ],
    })).toEqual({
      labels: [
        '[redacted-url]',
        '[redacted-url]',
        '[redacted-storage]',
        '[redacted-storage]',
        '[redacted-state]',
      ],
    });
  });
});
