import { describe, it, expect, afterEach } from 'vitest';
import http from 'http';

const { createDefaultRCaller } = require('./rWorkerBridge');

const servers = [];

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    servers.push(server);
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      baseUrl: `http://127.0.0.1:${server.address().port}`,
    }));
  });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

describe('default R caller network and response bounds', () => {
  it('uses the configured private base URL and internal token', async () => {
    let seen;
    const { baseUrl } = await listen((req, res) => {
      seen = { url: req.url, method: req.method, token: req.headers['x-api-token'] };
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ status: 'ok' }));
    });
    const callR = createDefaultRCaller({ baseUrl, token: 'internal-token' });
    await expect(callR({ method: 'GET', path: '/health', timeoutMs: 1000 }))
      .resolves.toEqual({ status: 200, body: { status: 'ok' } });
    expect(seen).toEqual({ url: '/health', method: 'GET', token: 'internal-token' });
  });

  it('rejects non-allowlisted targets before any network contact', async () => {
    let contacts = 0;
    const { baseUrl } = await listen((_req, res) => { contacts += 1; res.end('{}'); });
    const callR = createDefaultRCaller({ baseUrl, token: 'internal-token' });
    await expect(callR({ method: 'POST', path: '/arbitrary-eval', timeoutMs: 1000 }))
      .rejects.toMatchObject({ code: 'R_BRIDGE_TARGET_REJECTED' });
    expect(contacts).toBe(0);
  });

  it('aborts an oversized response without buffering it unboundedly', async () => {
    const { baseUrl } = await listen((_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: 'x'.repeat(4096) }));
    });
    const callR = createDefaultRCaller({ baseUrl, token: 'internal-token', maxResponseBytes: 128 });
    await expect(callR({ method: 'GET', path: '/health', timeoutMs: 1000 }))
      .rejects.toMatchObject({ code: 'R_RESPONSE_TOO_LARGE' });
  });

  it('enforces a total wall-clock deadline against a slowly streaming peer', async () => {
    let interval;
    const { baseUrl } = await listen((_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.write('{');
      interval = setInterval(() => res.write(' '), 5);
      res.on('close', () => clearInterval(interval));
    });
    const callR = createDefaultRCaller({ baseUrl, token: 'internal-token' });
    await expect(callR({ method: 'GET', path: '/health', timeoutMs: 30 }))
      .rejects.toMatchObject({ code: 'R_TIMEOUT' });
    if (interval) clearInterval(interval);
  });

  it('collapses malformed endpoint configuration to a no-leak startup error', async () => {
    const callR = createDefaultRCaller({ baseUrl: 'file:///secret/path', token: 'internal-token' });
    await expect(callR({ method: 'GET', path: '/health', timeoutMs: 10 }))
      .rejects.toEqual(expect.objectContaining({ code: 'R_BRIDGE_MISCONFIGURED', message: 'R bridge is not configured.' }));
  });
});
