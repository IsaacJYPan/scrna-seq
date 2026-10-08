#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const composeFile = path.join(root, 'deploy', 'compose.single-host.yml');
const demoFile = path.join(root, 'deploy', 'compose.demo.yml');
const demoUiFile = path.join(root, 'deploy', 'compose.demo-ui-acceptance.yml');
const innerFile = path.join(root, 'scripts', 'compose-demo-acceptance-inner.js');
const project = `traceomics-demo-accept-${process.pid}-${Date.now()}`.toLowerCase();
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'traceomics-demo-acceptance-'));
const envFile = path.join(tempRoot, 'demo.env');
let webPort;
const freeTier = process.argv.includes('--free-tier');
// Exercise a reviewed prebuilt R image without rebuilding its scientific stack.
const prebuiltRImage = process.env.DEMO_ACCEPTANCE_R_IMAGE;

function secret(bytes) { return crypto.randomBytes(bytes).toString('hex'); }

function environment(templateProjectId) {
  return [
    'FRONTEND_ORIGIN=https://demo.accept.invalid',
    'PUBLIC_HOST=demo.accept.invalid',
    'APP_DEPLOYMENT_MODE=demo',
    `WEB_PORT=${webPort}`,
    'TRUST_PROXY_HOPS=1',
    'COOKIE_SAMESITE=Lax',
    `SESSION_SECRET=${secret(32)}`,
    `SESSION_EPOCH=${secret(16)}`,
    `R_API_TOKEN=${secret(32)}`,
    `POSTGRES_PASSWORD=${secret(24)}`,
    'POSTGRES_USER=traceomics_demo_accept',
    'POSTGRES_DB=traceomics_demo_accept',
    `APP_DATABASE_PASSWORD=${secret(24)}`,
    'APP_DATABASE_USER=traceomics_demo_accept_app',
    `DEMO_TEMPLATE_PROJECT_ID=${templateProjectId}`,
    'DEMO_GUEST_TTL_SECONDS=7200',
    'SESSION_TTL_SECONDS=7200',
    'APP_IMAGE=traceomics:single-host',
    'OPS_IMAGE=traceomics-operations:single-host',
    `R_IMAGE=${prebuiltRImage || 'traceomics-r:single-host'}`,
    'NAMESPACE_IMAGE=alpine:3.21',
    'POSTGRES_IMAGE=postgres:16-alpine',
    'BACKUP_HOST_PATH=C:/traceomics-demo-accept-backups',
    'APP_UID=10001',
    'APP_GID=10001',
    'POSTGRES_MEMORY_LIMIT=1g',
    'POSTGRES_CPU_LIMIT=1',
    'POSTGRES_SHM_SIZE=256m',
    'R_MEMORY_LIMIT=4g',
    'R_CPU_LIMIT=2',
    'R_COMPUTE_MEMORY_LIMIT=4g',
    'R_COMPUTE_CPU_LIMIT=2',
    'R_COMPUTE_SESSION_BYTES=3221225472',
    'R_COMPUTE_SESSION_BYTES_PER_JOB=2147483648',
    'WEB_MEMORY_LIMIT=1g',
    'WEB_CPU_LIMIT=1',
    'WORKER_MEMORY_LIMIT=1g',
    'WORKER_CPU_LIMIT=1',
    'OPS_MEMORY_LIMIT=1g',
    'OPS_CPU_LIMIT=1',
    'JOB_WORKER_MIN_FREE_MEMORY_MB=1',
    'EXPERT_R_ENABLED=false',
    'EXPERT_R_SANDBOX_TOKEN=disabled',
    'EXPERT_R_SANDBOX_IMAGE=disabled',
    'EXPERT_R_SANDBOX_HOST_WORK_ROOT=C:/traceomics-demo-accept-expert',
    '',
  ].join('\n');
}

let secrets;

const composeArgs = [
  'compose', '-p', project, '--env-file', envFile,
  '-f', composeFile, '-f', demoFile,
];
if (freeTier) {
  const loopbackOnly = path.join(tempRoot, 'loopback-only.json');
  fs.writeFileSync(loopbackOnly, JSON.stringify({ services: { caddy: { profiles: ['acceptance-https'] } } }));
  composeArgs.push('-f', path.join(root, 'deploy', 'compose.demo-free-tier.yml'), '-f', loopbackOnly);
}
composeArgs.push('-f', demoUiFile);

function runDocker(args, options = {}) {
  const result = spawnSync('docker', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  if (result.status !== 0) {
    const detail = options.capture ? `${result.stdout || ''}\n${result.stderr || ''}` : '';
    const command = args.map((arg, index) => (
      index > 0 && args[index - 1] === '-e' && String(arg).startsWith('eval(')
        ? '<reviewed-inline-harness>' : arg
    )).join(' ');
    throw new Error(`docker ${command} failed${detail ? `\n${detail}` : ''}`);
  }
  return result.stdout || '';
}

function compose(extra, options) { return runDocker([...composeArgs, ...extra], options); }

function inner(action, input) {
  const source = fs.readFileSync(innerFile, 'utf8');
  const encoded = Buffer.from(source).toString('base64');
  const args = ['exec', '-T', '-e', `ACCEPTANCE_ACTION=${action}`];
  if (input) args.push('-e', `ACCEPTANCE_INPUT=${JSON.stringify(input)}`);
  args.push('web', 'node', '-e', `eval(Buffer.from('${encoded}','base64').toString('utf8'))`);
  const stdout = compose(args, { capture: true });
  const marker = stdout.trim().split(/\r?\n/).reverse().find((line) => line.startsWith('ACCEPTANCE_JSON='));
  if (!marker) throw new Error(`acceptance action ${action} returned no result\n${stdout}`);
  return JSON.parse(marker.slice('ACCEPTANCE_JSON='.length));
}

function parseLastJsonLine(output, label) {
  const lines = String(output || '').trim().split(/\r?\n/).filter(Boolean);
  for (const line of [...lines].reverse()) {
    try { return JSON.parse(line); } catch { /* keep looking */ }
  }
  throw new Error(`${label} returned no JSON result\n${output}`);
}

function bootstrapTemplate() {
  const prepared = parseLastJsonLine(
    compose(['exec', '-T', 'web', 'node', 'scripts/bootstrap-demo-template.js', 'prepare'], { capture: true }),
    'demo template prepare'
  );
  assertBootstrap(prepared?.action === 'prepared' && prepared?.projectId, 'Demo template prepare failed.');
  const generated = parseLastJsonLine(
    compose(['exec', '-T', 'r', 'Rscript', '/app/generate-demo-template.R'], { capture: true }),
    'demo template R generation'
  );
  assertBootstrap(generated?.synthetic === true && generated?.cells === 800, 'Demo R template is invalid.');
  if (process.env.DEMO_ACCEPTANCE_PRECOMPUTED === 'true') {
    assertBootstrap(generated.precomputed === true && /^[a-f0-9]{64}$/.test(generated.checksumSha256),
      'Demo bootstrap must copy the verified precomputed checkpoint.');
  }
  const finalized = parseLastJsonLine(
    compose(['exec', '-T', 'web', 'node', 'scripts/bootstrap-demo-template.js', 'finalize'], { capture: true }),
    'demo template finalize'
  );
  assertBootstrap(finalized?.action === 'finalized'
    && finalized?.demoTemplateProjectId === prepared.projectId, 'Demo template finalize failed.');
  return finalized;
}

function assertBootstrap(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  let keep = process.env.KEEP_ACCEPTANCE_STACK === 'true';
  try {
    // Let the OS select a usable port, including on Windows with reserved ranges.
    webPort = await new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        server.close((error) => error ? reject(error) : resolve(port));
      });
    });
    secrets = environment('proj_demoaccept0000000000000000');
    fs.writeFileSync(envFile, secrets, { mode: 0o600 });
    console.log(`[demo] project=${project} webPort=${webPort} profile=${freeTier ? 'free-tier' : 'standard'}`);
    compose(['build', 'web', ...(prebuiltRImage ? [] : ['r'])]);
    compose(['up', '-d', '--wait', '--wait-timeout', '240']);
    const template = bootstrapTemplate();
    fs.writeFileSync(envFile, secrets.replace(
      'DEMO_TEMPLATE_PROJECT_ID=proj_demoaccept0000000000000000',
      `DEMO_TEMPLATE_PROJECT_ID=${template.demoTemplateProjectId}`
    ), { mode: 0o600 });
    compose(['up', '-d', '--no-deps', '--force-recreate', '--wait', '--wait-timeout', '240',
      'web', 'worker', 'worker-compute-1', 'worker-compute-2']);
    const { runPublicDemoAcceptance } = require('./verify-public-demo-ui');
    const browserAcceptance = await runPublicDemoAcceptance({
      origin: `http://127.0.0.1:${webPort}`,
      allowLoopbackHttp: true,
    });
    console.log('[demo] PASS real browser guest checkpoint, UMAP, and exploratory workflow');
    console.log(JSON.stringify(browserAcceptance, null, 2));
    const { runAnalysisIntegrityAcceptance } = require('./verify-analysis-integrity-ui');
    const integrityAcceptance = await runAnalysisIntegrityAcceptance({
      origin: 'http://127.0.0.1:' + webPort,
      restartInteractiveRuntime: () => {
        compose(['restart', 'r']);
        compose(['up', '-d', '--wait', '--wait-timeout', '240', 'r']);
      },
    });
    console.log('[demo] PASS saved/live recovery and biological sample mapping');
    console.log(JSON.stringify(integrityAcceptance, null, 2));
    compose(['stop', 'worker', 'worker-compute-1', 'worker-compute-2']);
    const beforeRestart = inner('snapshot-persistence');
    compose(['restart', 'postgres', 'r', 'r-compute-1', 'r-compute-2', 'web']);
    compose(['up', '-d', '--wait', '--wait-timeout', '240']);
    compose(['stop', 'worker', 'worker-compute-1', 'worker-compute-2']);
    assertBootstrap(JSON.stringify(inner('snapshot-persistence')) === JSON.stringify(beforeRestart),
      'Saved demo users, projects, jobs, and artifact checksums must survive service restarts.');
    console.log('[demo] PASS saved demo data survives service restarts');
    const accepted = inner('accept-demo');
    console.log('[demo] PASS provisioning, private checkpoint copies, origin/rate limits, quotas, and disabled surfaces');
    console.log(JSON.stringify(accepted, null, 2));
    const cleanupOutput = compose(['--profile', 'demo-ops', 'run', '--rm', 'demo-cleanup'], { capture: true });
    if (!/removed 1 expired guests and 1 stored files/.test(cleanupOutput)) {
      throw new Error(`unexpected demo cleanup result\n${cleanupOutput}`);
    }
    const cleanup = inner('verify-cleanup', accepted);
    console.log('[demo] PASS expired guest database/storage cleanup preserved active guests and curated template');
    console.log(JSON.stringify(cleanup, null, 2));
  } catch (error) {
    keep = keep || process.env.KEEP_FAILED_ACCEPTANCE_STACK === 'true';
    try { compose(['ps', '--all']); } catch { /* best effort */ }
    try { compose(['logs', '--no-color', '--tail', '80']); } catch { /* best effort */ }
    throw error;
  } finally {
    if (keep) console.log(`[demo] preserved project ${project}`);
    else {
      try { compose(['--profile', 'demo-ops', 'down', '--volumes', '--remove-orphans']); } catch { /* best effort */ }
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`[demo] FAIL ${error.stack || error.message}`);
  process.exitCode = 1;
});
