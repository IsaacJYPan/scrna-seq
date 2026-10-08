'use strict';

const express = require('express');
import { afterEach, describe, expect, it, vi } from 'vitest';
const workflowRuntime = require('./workflowRuntime');

let server;
afterEach(async () => {
  vi.restoreAllMocks();
  if (server) await new Promise(resolve => server.close(resolve));
  server = null;
});

async function requestError(error) {
  vi.spyOn(workflowRuntime, 'createWorkflowRuntime').mockReturnValue({
    run: async () => { throw error; },
    expire: async () => {},
  });
  delete require.cache[require.resolve('./workflowRoutes')];
  const { workflowRoutes } = require('./workflowRoutes');
  const app = express();
  app.use('/api/workflows', workflowRoutes({ db: {}, provider: {}, requireAuth: (req, res, next) => { req.user = { id: 1 }; next(); } }));
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/workflows/proj_test/instances/wfi_test/run`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  return { status: response.status, body: await response.json() };
}

describe('workflow exact-environment errors', () => {
  it.each([['R_ENVIRONMENT_MISMATCH', 409], ['R_ENVIRONMENT_UNAVAILABLE', 503], ['R_ENVIRONMENT_INVALID', 503]])(
    'returns a bounded restoration message for %s', async (code, status) => {
      const result = await requestError(Object.assign(new Error('/private/worker/path credential'), { code, publicSafeHandlerError: true }));
      expect(result.status).toBe(status);
      expect(result.body.code).toBe(code);
      expect(result.body.error).not.toContain('/private');
      expect(result.body.error).not.toContain('credential');
    }
  );
  it('requires a trusted public-error marker', async () => {
    const result = await requestError(Object.assign(new Error('/private/worker/path'), { code: 'R_ENVIRONMENT_MISMATCH' }));
    expect(result.status).toBe(400);
    expect(result.body).toEqual({ error: 'The workflow request could not be completed.' });
  });
});
