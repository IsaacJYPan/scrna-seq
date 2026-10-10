'use strict';

const http = require('node:http');
const https = require('node:https');
const { isTrustedExpertRSandboxUrl } = require('./expertR');
const { createPrivateKernelClient } = require('./privateKernelClient');
const { scope } = require('./privateKernelContract');
const { validateObservation, unavailable } = require('./containerObservation');

const validScope = value => value && /^job_[a-f0-9]{16,64}$/.test(value.jobId || '')
  && /^[A-Za-z0-9_-]{1,120}$/.test(value.projectId || '')
  && Number.isSafeInteger(value.ownerUserId) && value.ownerUserId > 0
  && /^[a-f0-9]{64}$/.test(value.dispatchId || '');

// This authenticated control request observes an already retained dispatch. It
// cannot start, reconcile, interrupt or repeat scientific work.
function createDispatchObserver({ baseUrl = process.env.EXPERT_R_SANDBOX_URL,
  token = process.env.EXPERT_R_SANDBOX_TOKEN, timeoutMs = 4500, now = Date.now } = {}) {
  return async value => {
    if (!validScope(value) || !isTrustedExpertRSandboxUrl(baseUrl) || !/^[a-f0-9]{64}$/.test(token || '')) return unavailable();
    const input = { jobId: value.jobId, projectId: value.projectId, ownerUserId: value.ownerUserId, dispatchId: value.dispatchId };
    return new Promise(resolve => {
      const url = new URL('/observe', baseUrl);
      const encoded = Buffer.from(JSON.stringify(input));
      let settled = false, deadline;
      const finish = result => { if (!settled) { settled = true; clearTimeout(deadline); resolve(result); } };
      const request = (url.protocol === 'https:' ? https : http).request(url, { method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': encoded.length } }, response => {
        const chunks = []; let size = 0;
        response.on('data', chunk => {
          size += chunk.length;
          if (size > 4096) { finish(unavailable()); request.destroy(); }
          else chunks.push(chunk);
        });
        response.on('aborted', () => finish(unavailable()));
        response.on('error', () => finish(unavailable()));
        response.on('end', () => {
          if (settled) return;
          try {
            const raw = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (response.statusCode !== 200 || raw?.ok !== true || !Object.keys(input).every(key => raw[key] === input[key])) return finish(unavailable());
            finish(validateObservation(raw.observation, now()));
          } catch { finish(unavailable()); }
        });
      });
      deadline = setTimeout(() => { finish(unavailable()); request.destroy(); }, timeoutMs);
      deadline.unref?.();
      request.on('error', () => finish(unavailable()));
      request.end(encoded);
    });
  };
}

function createRunResourceObservers(options = {}) {
  const now = options.now || Date.now;
  const observeDispatch = options.observeDispatch || createDispatchObserver(options);
  const kernelClient = options.kernelClient || createPrivateKernelClient(options);
  return {
    async observeJob(row, receipt) {
      if (row?.status !== 'running' || receipt?.target?.runtimeKind !== 'sandbox-r') return unavailable();
      const input = { jobId: row.id, projectId: row.project_id, ownerUserId: Number(row.owner_user_id), dispatchId: receipt.dispatchId };
      if (!validScope(input)) return unavailable();
      try { return validateObservation(await observeDispatch(input), now()); } catch { return unavailable(); }
    },
    async observeKernel(row) {
      if (!/^pk_[a-f0-9]{24}$/.test(row?.id || '') || !/^[a-f0-9]{64}$/.test(row.runtime_generation || '')
          || row.kernel_status !== 'running' || !Number.isSafeInteger(Number(row.owner_user_id)) || Number(row.owner_user_id) < 1) return unavailable();
      try {
        const raw = await kernelClient.observe(scope(row), row.id);
        if (raw?.ok !== true || raw.kernelId !== row.id || raw.generation !== row.runtime_generation) return unavailable();
        return validateObservation(raw.observation, now());
      } catch { return unavailable(); }
    },
  };
}

module.exports = { createDispatchObserver, createRunResourceObservers };
