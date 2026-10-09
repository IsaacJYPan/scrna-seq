'use strict';

const http = require('node:http');
const https = require('node:https');
const { isTrustedExpertRSandboxUrl } = require('./expertR');
const { LIMITS, KERNEL_ID, kernelError } = require('./privateKernelContract');

function createPrivateKernelClient({ baseUrl = process.env.EXPERT_R_SANDBOX_URL, token = process.env.EXPERT_R_SANDBOX_TOKEN, timeoutMs = (Math.max(1,Math.min(600,Number(process.env.PRIVATE_R_KERNEL_EXECUTION_SECONDS)||300))+25)*1000, startTimeoutMs=120000, controlTimeoutMs = 30000 } = {}) {
  function request(path, body, timeout) {
    if (!isTrustedExpertRSandboxUrl(baseUrl) || !/^[a-f0-9]{64}$/.test(token || '')) return Promise.reject(kernelError('PRIVATE_KERNEL_UNAVAILABLE', 'The persistent private R runtime is unavailable.', 503));
    const encoded = Buffer.from(JSON.stringify(body));
    if (encoded.length > 256 * 1024) return Promise.reject(kernelError('PRIVATE_KERNEL_REQUEST_INVALID', 'The private R request exceeds its size limit.'));
    return new Promise((resolve, reject) => {
      const url = new URL(path, baseUrl); let settled = false;
      const fail = () => { if (!settled) { settled = true; reject(kernelError('PRIVATE_KERNEL_TRANSPORT_UNKNOWN', 'The R runtime connection ended before completion was confirmed. Check the session state; do not rerun the command automatically.', 503)); } };
      const outgoing = (url.protocol === 'https:' ? https : http).request(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': encoded.length } }, response => {
        const chunks = []; let length = 0;
        response.on('data', bytes => { length += bytes.length; if (length > LIMITS.resultBytes) { fail(); outgoing.destroy(); } else chunks.push(bytes); });
        response.on('error', fail); response.on('aborted', fail);
        response.on('end', () => {
          if (settled) return;
          let raw; try { raw = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return fail(); }
          if (response.statusCode !== 200 || raw?.ok !== true) {
            settled = true;
            const errors = { PRIVATE_KERNEL_UNAVAILABLE: [503, 'Persistent R sessions are unavailable in this runtime. Existing one-shot R remains available.'], PRIVATE_KERNEL_NOT_FOUND: [404, 'The private R session is unavailable. Unsaved memory cannot be recovered.'], PRIVATE_KERNEL_BUSY: [409, 'The private R session is already executing a command.'], PRIVATE_KERNEL_LIMIT: [429, 'The private R runtime is at its active-session limit. Stop an unused session and try again.'], PRIVATE_KERNEL_ADMISSION_LIMIT:[429,'The private R runtime is at its active-session limit. Stop an unused session first.'],PRIVATE_KERNEL_ORDER_INVALID:[409,'The runtime rejected this command order. Inspect the session journal and start a new session if its order cannot be reconciled.'],PRIVATE_KERNEL_STOPPED:[409,'This session has ended. Its unsaved memory is lost; start a new session to continue.'],PRIVATE_KERNEL_INVALID:[400,'The runtime rejected the private R session request.'],PRIVATE_KERNEL_INPUT_INVALID:[400,'A selected private R input is invalid.'],PRIVATE_KERNEL_INPUT_INTEGRITY:[409,'The runtime could not verify a selected input version.'],PRIVATE_KERNEL_CONFLICT:[409,'This runtime identity already refers to another session snapshot.'], R_ENVIRONMENT_MISMATCH: [409, 'The session requires its pinned R environment. Restore that environment before starting a new session.'] };
            Object.assign(errors,{PRIVATE_KERNEL_PUBLICATION_NOT_FOUND:[404,'The runtime no longer retains this save receipt. Completion remains unconfirmed; the source will not be run again.'],PRIVATE_KERNEL_PUBLICATION_INVALID:[400,'The runtime rejected the saved-output request.'],PRIVATE_KERNEL_PUBLICATION_UNAVAILABLE:[503,'The saved output could not be verified. Refresh its receipt before continuing.']});
            Object.assign(errors,{PRIVATE_KERNEL_INTERRUPT_UNAVAILABLE:[503,'Interruption is unavailable in this runtime. You can stop the session and explicitly start again.'],PRIVATE_KERNEL_INTERRUPT_INVALID:[409,'The interrupt request no longer matches the active command. Refresh the session before continuing.']});
            Object.assign(errors,{PRIVATE_KERNEL_INTERRUPT_UNSUPPORTED:[503,'Interruption is unavailable in this runtime. You can stop the session and explicitly start again.'],PRIVATE_KERNEL_CONTROL_INVALID:[409,'The control request no longer matches the active command. Refresh the session before continuing.']});
            const known=typeof raw?.code==='string'&&Object.hasOwn(errors,raw.code);
            const [status, message] = known?errors[raw.code]:[503, 'The private R runtime could not confirm this request. Check the session state before continuing.'];
            reject(kernelError(known ? raw.code : 'PRIVATE_KERNEL_TRANSPORT_UNKNOWN', message, status)); return;
          }
          settled = true; resolve(raw);
        });
      });
      const deadline = setTimeout(() => { fail(); outgoing.destroy(); }, timeout); deadline.unref?.();
      outgoing.on('close', () => clearTimeout(deadline)); outgoing.on('error', fail); outgoing.end(encoded);
    });
  }
  const path = id => { if (!KERNEL_ID.test(id || '')) throw kernelError('PRIVATE_KERNEL_NOT_FOUND', 'Private R session not found.', 404); return '/kernels/' + id; };
  return { start: spec => request('/kernels/start', spec, startTimeoutMs), inspect: (scope, id) => request(path(id) + '/inspect', scope, controlTimeoutMs), execute: (scope, id, input) => request(path(id) + '/execute', { ...scope, ...input }, timeoutMs), interrupt:(scope,id,input)=>request(path(id)+'/interrupt',{...scope,...input},controlTimeoutMs), export:(scope,id,input)=>request(path(id)+'/export',{...scope,...input},timeoutMs+60000),exportStatus:(scope,id,input)=>request(path(id)+'/export-status',{...scope,...input},controlTimeoutMs), stop: (scope, id) => request(path(id) + '/stop', scope, controlTimeoutMs) };
}
module.exports = { createPrivateKernelClient };
