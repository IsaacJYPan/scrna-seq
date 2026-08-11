import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';

const config = require('./config');
const { startServer, createUserWithToken, db, serverModule } = require('./_http-test-utils');

const CONFIGURED = config.hasPostgresConnection();

let server;
let baseUrl;

function url(requestPath) {
  return `${baseUrl}${requestPath}`;
}

beforeAll(async () => {
  if (!CONFIGURED) return;
  await db.resetSchemaForTests();
  server = await startServer();
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  if (!CONFIGURED) return;
  await new Promise((resolve) => server.close(resolve));
  await db.close();
});

describe.skipIf(!CONFIGURED)('API fallback routing', () => {
  it('returns JSON 404 for unknown /api routes instead of SPA HTML', async () => {
    const res = await fetch(url('/api/definitely-not-a-real-route'));
    const text = await res.text();

    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toMatch(/application\/json/i);
    expect(JSON.parse(text)).toEqual({ error: 'Not found' });
    expect(text).not.toMatch(/<!doctype html/i);
  });

  const hasBuiltFrontend = fs.existsSync(path.join(__dirname, '..', 'dist', 'index.html'));
  const maybeIt = hasBuiltFrontend ? it : it.skip;

  maybeIt('keeps the built SPA fallback for non-API frontend routes', async () => {
    const res = await fetch(url('/workspace/not-a-server-route'));
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/i);
    expect(text).toMatch(/<div id="root"><\/div>/i);
  });
});

describe.skipIf(!CONFIGURED)('runtime diagnostics route', () => {
  it('reports a sanitized runtime projection without local executable or package details', async () => {
    const { token } = await createUserWithToken({ email: 'diagnostics@example.com' });
    const originalRscriptPath = process.env.RSCRIPT_PATH;
    const originalRscript = process.env.RSCRIPT;
    delete process.env.RSCRIPT_PATH;
    delete process.env.RSCRIPT;

    try {
      const res = await fetch(url('/api/runtime/diagnostics'), {
        headers: { Cookie: `${config.sessionCookieName()}=${encodeURIComponent(token)}` }
      });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.supportedTarget).toBe('R 4.5.x');
      expect(body.runtime).toHaveProperty('status');
      expect(body).not.toHaveProperty('rscript');
      expect(body).not.toHaveProperty('packages');
    } finally {
      if (originalRscriptPath === undefined) delete process.env.RSCRIPT_PATH;
      else process.env.RSCRIPT_PATH = originalRscriptPath;
      if (originalRscript === undefined) delete process.env.RSCRIPT;
      else process.env.RSCRIPT = originalRscript;
    }
  });

  it('uses PATH discovery when no Rscript environment override is configured', () => {
    expect(serverModule.findRscript({})).toMatchObject({ path: 'Rscript', source: 'PATH' });
  });
});
