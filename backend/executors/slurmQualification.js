'use strict';

// Qualification of the Slurm target for agent sandbox runs (docs/spec.md 10.2).
//
// Runs small real jobs on the configured cluster, inside the configured
// sandbox container command, and records what was observed. Agent sandboxes
// may use the cluster only while the latest record for the current
// configuration passed and is recent. A configuration change (container
// command, image, partition, account, QoS, run directory) needs a new run.
//
// Checks:
//   reachable           sinfo answers on the login node
//   sandbox-configured  SLURM_SANDBOX_EXEC and SLURM_SANDBOX_IMAGE_DIGEST are set
//   job-roundtrip       a job is submitted, completes, and its output comes back
//   no-network          the sandboxed R process cannot open outbound connections
//   no-job-submission   the sandboxed R process cannot run sbatch or srun
//   no-credentials      no SSH keys, agent socket, or cloud credentials are visible
//   input-read-only     the staged input directory cannot be written
//   cpu-limit           the process is pinned to no more CPUs than requested
//   memory-limit        a job that allocates past its --mem is stopped
//   cancel              scancel stops a running job

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { wallTime } = require('./slurm');

const MAX_AGE_DAYS_DEFAULT = 30;
const REQUIRED = ['reachable', 'sandbox-configured', 'job-roundtrip', 'no-network', 'no-job-submission', 'no-credentials',
  'input-read-only', 'cpu-limit', 'memory-limit', 'cancel'];

const PROBE_R = `
work <- commandArgs(trailingOnly = TRUE)[[1]]
result <- list()
blocked <- function(expr) tryCatch({ force(expr); FALSE }, error = function(e) TRUE, warning = function(w) TRUE)
result$network_blocked <- blocked(suppressWarnings(socketConnection("1.1.1.1", 53, blocking = TRUE, timeout = 5))) &&
  blocked(readLines(url("http://example.com"), n = 1, warn = FALSE))
submit <- Sys.which(c("sbatch", "srun"))
result$submission_blocked <- all(vapply(submit, function(cmd) {
  if (!nzchar(cmd)) return(TRUE)
  status <- suppressWarnings(system2(cmd, "--version", stdout = FALSE, stderr = FALSE))
  !identical(as.integer(status), 0L)
}, logical(1)))
home <- path.expand("~")
result$credentials_hidden <- !dir.exists(file.path(home, ".ssh")) && !nzchar(Sys.getenv("SSH_AUTH_SOCK")) &&
  !file.exists(file.path(home, ".aws", "credentials")) && !nzchar(Sys.getenv("AWS_SECRET_ACCESS_KEY"))
result$input_read_only <- blocked(writeLines("x", file.path(work, "input", "probe-write.txt")))
cpus <- tryCatch(length(parallel::mcaffinity()), error = function(e) NA_integer_)
result$cpus_visible <- if (is.null(cpus) || is.na(cpus)) -1L else cpus
dir.create(file.path(work, "output"), showWarnings = FALSE)
writeLines(jsonlite::toJSON(result, auto_unbox = TRUE), file.path(work, "output", "probe.json"))
`;
const MEMORY_R = `
x <- numeric(4e8)
x[] <- 1
cat("allocated", sum(x) > 0, "\\n")
`;
const HOLD_R = `
Sys.sleep(900)
`;

function fingerprint(config) {
  const material = {
    target: config.name, remoteRoot: config.remoteRoot, partition: config.partition, account: config.account, qos: config.qos,
    sandboxExec: config.sandboxExec, sandboxImageDigest: config.sandboxImageDigest, modules: config.modules,
  };
  return crypto.createHash('sha256').update(JSON.stringify(material)).digest('hex');
}

function maxAgeDays(env = process.env) {
  const n = Number(env.SLURM_QUALIFICATION_MAX_AGE_DAYS);
  return Number.isFinite(n) && n > 0 && n <= 365 ? n : MAX_AGE_DAYS_DEFAULT;
}

async function latestQualification(db, config) {
  const { rows } = await db.query(
    'SELECT * FROM hpc_qualifications WHERE target = $1 ORDER BY created_at DESC, id DESC LIMIT 1', [config.name]);
  return rows[0] || null;
}

// Whether agent sandbox runs may use the Slurm target now.
async function sandboxReadiness(db, config, env = process.env) {
  if (!config.sandboxConfigured) {
    return { ready: false, reason: 'The cluster sandbox is not configured (SLURM_SANDBOX_EXEC, SLURM_SANDBOX_IMAGE_DIGEST).' };
  }
  const record = await latestQualification(db, config).catch(() => null);
  if (!record) return { ready: false, reason: 'The cluster has not been qualified. Run npm run slurm:qualify.' };
  const summary = { qualifiedAt: record.created_at, checks: record.checks_json };
  if (record.config_fingerprint !== fingerprint(config)) {
    return { ready: false, reason: 'The cluster settings changed since the last qualification. Run it again.', ...summary };
  }
  if (!record.passed) return { ready: false, reason: 'The last qualification did not pass.', ...summary };
  const ageDays = (Date.now() - new Date(record.created_at).getTime()) / 86400000;
  if (ageDays > maxAgeDays(env)) return { ready: false, reason: 'The last qualification is too old. Run it again.', ...summary };
  return { ready: true, ...summary };
}

function probeScript(config, { name, runDir, work, containerWork, script, cpus, memoryMiB, seconds }) {
  const exec = config.sandboxExec.map((t) => t.split('{work}').join(work));
  const lines = [
    '#!/bin/bash',
    `#SBATCH --job-name=tro-qualify-${name}`,
    `#SBATCH --output=${runDir}/slurm.out`,
    `#SBATCH --cpus-per-task=${cpus}`,
    `#SBATCH --mem=${memoryMiB}M`,
    `#SBATCH --time=${wallTime(seconds)}`,
  ];
  if (config.partition) lines.push(`#SBATCH --partition=${config.partition}`);
  if (config.account) lines.push(`#SBATCH --account=${config.account}`);
  if (config.qos) lines.push(`#SBATCH --qos=${config.qos}`);
  lines.push('set -euo pipefail');
  if (config.modules.length) lines.push(`module load ${config.modules.join(' ')}`);
  lines.push(`cd ${runDir}`);
  lines.push(`${exec.join(' ')} Rscript --vanilla ${containerWork}/${script} ${containerWork}`);
  return `${lines.join('\n')}\n`;
}

async function qualifySlurmTarget({ db, executor, log = () => {}, pollMs, timeoutMs = 30 * 60 * 1000 } = {}) {
  const config = executor.config;
  const transport = executor.transport;
  const checks = [];
  const record = (name, passed, detail) => { checks.push({ name, passed: Boolean(passed), detail: String(detail || '').slice(0, 500) }); log(`${passed ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); };
  const wait = pollMs ?? config.pollSeconds * 1000;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const status = await executor.status();
  record('reachable', status.available, status.available ? `partitions: ${(status.partitions || []).map((p) => p.name).join(', ')}` : status.reason);
  record('sandbox-configured', config.sandboxConfigured, config.sandboxConfigured ? config.sandboxImageDigest : 'Set SLURM_SANDBOX_EXEC and SLURM_SANDBOX_IMAGE_DIGEST.');

  const tag = crypto.randomBytes(6).toString('hex');
  const root = `${config.remoteRoot.replace(/\/+$/, '')}/qualify-${tag}`;
  const staging = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tro-qualify-'));
  const containerWork = (work) => (config.sandboxExec.some((t) => t.includes('{work}')) ? '/work' : work);

  async function submit(name, script, body, resources) {
    const runDir = `${root}/${name}`;
    const work = `${runDir}/work`;
    await transport.exec(['mkdir', '-p', `${work}/input`, `${work}/output`]);
    const put = async (file, text) => { const local = path.join(staging, `${name}-${path.basename(file)}`); await fs.promises.writeFile(local, text); await transport.put(local, file); };
    await put(`${work}/${script}`, body);
    await transport.exec(['chmod', '-R', 'a-w', `${work}/input`]);
    await put(`${runDir}/job.sh`, probeScript(config, { name, runDir, work, containerWork: containerWork(work), script, ...resources }));
    const out = await transport.exec(['sbatch', '--parsable', `${runDir}/job.sh`]);
    const id = (out.trim().match(/^(\d+)/) || [])[1];
    if (!id) throw new Error('sbatch did not return a job id.');
    return { id, runDir, work };
  }
  async function waitFor(id, done) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const state = await executor.jobState(id);
      if (state && done(state)) return state;
      if (Date.now() > deadline) return state || 'UNKNOWN';
      await sleep(wait);
    }
  }
  const active = (state) => ['PENDING', 'CONFIGURING', 'RUNNING', 'COMPLETING', 'REQUEUED', 'RESIZING', 'SUSPENDED'].includes(state);

  try {
    if (status.available && config.sandboxConfigured) {
      // Probe job: isolation properties observed from inside the sandbox.
      try {
        const probe = await submit('probe', 'probe.R', PROBE_R, { cpus: 2, memoryMiB: 2048, seconds: 600 });
        const state = await waitFor(probe.id, (s) => !active(s));
        let result = null;
        if (state === 'COMPLETED') {
          const local = path.join(staging, 'probe.json');
          await transport.get(`${probe.work}/output/probe.json`, local);
          result = JSON.parse(await fs.promises.readFile(local, 'utf8'));
        }
        record('job-roundtrip', Boolean(result), result ? `Slurm job ${probe.id} completed` : `Slurm job ${probe.id} ended ${state}`);
        record('no-network', result?.network_blocked === true, result ? (result.network_blocked ? 'outbound connections failed' : 'an outbound connection succeeded') : 'no probe result');
        record('no-job-submission', result?.submission_blocked === true, result ? (result.submission_blocked ? 'sbatch/srun unavailable' : 'sbatch or srun works inside the sandbox') : 'no probe result');
        record('no-credentials', result?.credentials_hidden === true, result ? (result.credentials_hidden ? 'none visible' : 'SSH keys, an agent socket, or cloud credentials are visible') : 'no probe result');
        record('input-read-only', result?.input_read_only === true, result ? (result.input_read_only ? 'write refused' : 'the input directory is writable') : 'no probe result');
        const cpus = Number(result?.cpus_visible);
        record('cpu-limit', cpus >= 1 && cpus <= 2, result ? (cpus >= 1 ? `${cpus} CPU(s) visible for 2 requested` : 'CPU affinity could not be read') : 'no probe result');
      } catch (error) {
        record('job-roundtrip', false, error.message);
      }
      // Memory: allocating ~3 GiB under a 512 MiB limit must not complete.
      try {
        const memory = await submit('memory', 'memory.R', MEMORY_R, { cpus: 1, memoryMiB: 512, seconds: 600 });
        const state = await waitFor(memory.id, (s) => !active(s));
        record('memory-limit', state !== 'COMPLETED', `Slurm job ${memory.id} ended ${state}`);
      } catch (error) {
        record('memory-limit', false, error.message);
      }
      // Cancellation: a running job stops after scancel.
      try {
        const hold = await submit('hold', 'hold.R', HOLD_R, { cpus: 1, memoryMiB: 512, seconds: 1200 });
        await waitFor(hold.id, (s) => s !== 'PENDING' && s !== 'CONFIGURING');
        await transport.exec(['scancel', hold.id]);
        const state = await waitFor(hold.id, (s) => !active(s));
        record('cancel', /^CANCELLED/.test(state), `Slurm job ${hold.id} ended ${state}`);
      } catch (error) {
        record('cancel', false, error.message);
      }
    }
  } finally {
    await fs.promises.rm(staging, { recursive: true, force: true });
    await transport.exec(['rm', '-rf', root]).catch(() => {});
  }

  for (const name of REQUIRED) if (!checks.some((c) => c.name === name)) record(name, false, 'not run');
  const passed = REQUIRED.every((name) => checks.find((c) => c.name === name)?.passed);
  const id = `hq_${crypto.randomBytes(12).toString('hex')}`;
  await db.query(
    'INSERT INTO hpc_qualifications (id, target, config_fingerprint, checks_json, passed) VALUES ($1, $2, $3, $4, $5)',
    [id, config.name, fingerprint(config), JSON.stringify(checks), passed]);
  return { id, target: config.name, passed, checks };
}

module.exports = { qualifySlurmTarget, sandboxReadiness, latestQualification, fingerprint, REQUIRED, PROBE_R };
