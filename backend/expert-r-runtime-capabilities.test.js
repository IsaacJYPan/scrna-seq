import { describe, expect, it } from 'vitest';
import http from 'node:http';
const { probeExpertRRuntime } = require('./expertRAccess');
const { EXPERT_R_RESOURCE_POLICY_VERSION } = require('./expertR');
const { environmentFixture } = require('./_r-environment-test-utils');

describe('independent private R publication capability', () => {
  it.each([
    [undefined, false], [false, false], ['true', false], [true, true],
  ])('keeps existing persistent R available while checking publication support %s', async (advertised, supported) => {
    const { reference } = environmentFixture();
    const token = 'a'.repeat(64);
    const server = http.createServer((req, res) => {
      if (req.url !== '/capabilities' || req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(404); res.end('{}'); return;
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ status: 'ok', profileId: reference.profileId,
        sandboxImageDigest: reference.imageDigest, resourcePolicyVersion: EXPERT_R_RESOURCE_POLICY_VERSION,
        environment: reference, persistentKernel: true, persistentKernelPublications: advertised }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const runtime = await probeExpertRRuntime({ APP_DEPLOYMENT_MODE: 'private', EXPERT_R_ENABLED: 'true',
        EXPERT_R_SANDBOX_URL: `http://127.0.0.1:${server.address().port}`, EXPERT_R_SANDBOX_TOKEN: token });
      expect(runtime).toMatchObject({ state: 'ready', persistentKernel: true,
        persistentKernelPublications: supported, environment: reference });
    } finally { await new Promise(resolve => server.close(resolve)); }
  });
});
