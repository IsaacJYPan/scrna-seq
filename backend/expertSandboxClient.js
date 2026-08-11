'use strict';

const http = require('http');
const https = require('https');
const { isTrustedExpertRSandboxUrl } = require('./expertR');

const SAFE_SCRIPT_EXPLANATIONS = new Set([
  'The R script exceeded the per-run output storage limit.',
  'The R script could not be parsed. Check its syntax and line endings.',
  'A requested R package is not included in the approved package profile.',
  'The R script referenced an object or function that is not available.',
  'The R script could not find a selected input file.',
  'The R script stopped with an error. Check input names, columns, and function arguments.',
]);

function codedError(code, message, { publicSafe = false } = {}) {
  const error = new Error(message); error.code = code;
  if (publicSafe) Object.defineProperty(error, 'publicSafeHandlerError', { value: true });
  return error;
}

function createExpertSandboxClient({ baseUrl, token, timeoutMs = 780000 } = {}) {
  if (!isTrustedExpertRSandboxUrl(baseUrl)) {
    throw new Error('Expert R sandbox client configuration is invalid.');
  }
  const url = new URL('/run', baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || !/^[0-9a-f]{64}$/.test(String(token || ''))) {
    throw new Error('Expert R sandbox client configuration is invalid.');
  }
  const transport = url.protocol === 'https:' ? https : http;
  return (input) => new Promise((resolve, reject) => {
    const encoded = Buffer.from(JSON.stringify(input), 'utf8');
    if (encoded.length > 65536) return reject(codedError('EXPERT_R_REQUEST_TOO_LARGE', 'Expert R request is too large.'));
    const request = transport.request(url, {
      method: 'POST', timeout: timeoutMs,
      headers: {
        Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
        'Content-Length': encoded.length,
      },
    }, (response) => {
      const chunks = []; let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > 256 * 1024) request.destroy(codedError('EXPERT_R_RESPONSE_INVALID', 'Expert R response is invalid.'));
        else chunks.push(chunk);
      });
      response.on('end', () => {
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return reject(codedError('EXPERT_R_RESPONSE_INVALID', 'Expert R response is invalid.')); }
        if (response.statusCode === 422 && body?.code === 'EXPERT_R_SCRIPT_FAILED'
            && SAFE_SCRIPT_EXPLANATIONS.has(body.explanation)) {
          return reject(codedError('EXPERT_R_SCRIPT_FAILED', body.explanation, { publicSafe: true }));
        }
        if (response.statusCode === 503
            && body?.error === 'Expert R storage capacity is temporarily unavailable.') {
          return reject(codedError(
            'EXPERT_R_STORAGE_CAPACITY',
            'Expert R storage capacity is temporarily unavailable. Try again later.',
            { publicSafe: true }
          ));
        }
        if (response.statusCode !== 200 || !body || body.ok !== true) {
          return reject(codedError('EXPERT_R_SANDBOX_FAILED', 'Expert R sandbox failed.'));
        }
        resolve(body);
      });
    });
    request.on('timeout', () => request.destroy(codedError('EXPERT_R_TIMEOUT', 'Expert R sandbox timed out.')));
    request.on('error', (error) => reject(error.code && String(error.code).startsWith('EXPERT_R_')
      ? error : codedError('EXPERT_R_UNAVAILABLE', 'Expert R sandbox is unavailable.')));
    request.end(encoded);
  });
}

module.exports = { createExpertSandboxClient };
