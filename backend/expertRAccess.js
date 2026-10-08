'use strict';

const http = require('http');
const https = require('https');
const { EXPERT_R_PROFILE, EXPERT_R_RESOURCE_POLICY_VERSION, expertRSandboxEnabled } = require('./expertR');

const DENIED_CAPABILITY = 'expert_r.denied';
const EXECUTE_CAPABILITY = 'expert_r.execute';
const WRITE_ROLES = Object.freeze(['owner', 'admin', 'analyst']);

function expertRAccessPolicy(env = process.env) {
  const value = env.EXPERT_R_ACCESS_POLICY || 'approved-accounts';
  return ['approved-accounts', 'project-roles'].includes(value) ? value : 'disabled';
}

// Callers supply only fixed SQL identifiers/placeholders, never request data.
function expertRAccessSql(userExpression, projectExpression = null, env = process.env,
  grantExpression = `'${EXECUTE_CAPABILITY}'`) {
  const policy = expertRAccessPolicy(env);
  const roleAccess = `(${policy === 'project-roles' ? 'TRUE' : 'FALSE'} AND EXISTS (
    SELECT 1 FROM project_members expert_pm
    WHERE expert_pm.user_id = ${userExpression}
      ${projectExpression ? `AND expert_pm.project_id = ${projectExpression}` : ''}
      AND expert_pm.role IN ('owner', 'admin', 'analyst')
  ))`;
  return `(${policy === 'disabled' ? 'FALSE' : 'TRUE'}
    AND EXISTS (SELECT 1 FROM users expert_user WHERE expert_user.id = ${userExpression}
      AND expert_user.is_demo_guest = FALSE)
    AND NOT EXISTS (SELECT 1 FROM platform_capabilities expert_deny
      WHERE expert_deny.user_id = ${userExpression} AND expert_deny.capability = '${DENIED_CAPABILITY}')
    AND (EXISTS (SELECT 1 FROM platform_capabilities expert_grant
      WHERE expert_grant.user_id = ${userExpression} AND expert_grant.capability = ${grantExpression})
      OR ${roleAccess}))`;
}

function probeExpertRRuntime(env = process.env, { timeoutMs = 1500 } = {}) {
  if (!expertRSandboxEnabled(env)) return Promise.resolve({ state: 'not-configured' });
  return new Promise((resolve) => {
    const url = new URL('/capabilities', env.EXPERT_R_SANDBOX_URL);
    const transport = url.protocol === 'https:' ? https : http;
    const request = transport.get(url, {
      headers: { Authorization: `Bearer ${env.EXPERT_R_SANDBOX_TOKEN}` },
    }, (response) => {
      let size = 0; const chunks = [];
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > 16384) { resolve({ state: 'incompatible' }); request.destroy(); }
        else chunks.push(chunk);
      });
      response.on('error', () => resolve({ state: 'unreachable' }));
      response.on('end', () => {
        let result;
        try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* invalid below */ }
        if (response.statusCode !== 200 || result?.status !== 'ok'
            || result.profileId !== EXPERT_R_PROFILE.id
            || result.resourcePolicyVersion !== EXPERT_R_RESOURCE_POLICY_VERSION
            || !/^sha256:[0-9a-f]{64}$/.test(result.sandboxImageDigest || '')) {
          resolve({ state: 'incompatible' }); return;
        }
        resolve({ state: 'ready', profileId: result.profileId, imageDigest: result.sandboxImageDigest,
          resourcePolicyVersion: result.resourcePolicyVersion });
      });
    });
    const deadline = setTimeout(() => { resolve({ state: 'unreachable' }); request.destroy(); }, timeoutMs);
    deadline.unref?.();
    request.on('close', () => clearTimeout(deadline));
    request.on('error', () => resolve({ state: 'unreachable' }));
  });
}

function expertRStatus({ canExecuteExpertR, runtime, revoked = false, demoMode = false, env = process.env }) {
  let state = runtime.state;
  if (demoMode) state = 'demo-disabled';
  else if (revoked) state = 'access-revoked';
  else if (state === 'ready' && !canExecuteExpertR) state = 'access-required';
  return { state, accessPolicy: expertRAccessPolicy(env), canExecute: canExecuteExpertR === true,
    runtime: runtime.state === 'ready' ? runtime : { state: runtime.state },
    setupCommand: 'node scripts/configure-private-r.js --help' };
}

module.exports = { DENIED_CAPABILITY, WRITE_ROLES, expertRAccessPolicy, expertRAccessSql, probeExpertRRuntime, expertRStatus };
