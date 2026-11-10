'use strict';

// Slurm execution target (docs/spec.md phases 3-4). Runs the Seurat pipeline,
// and agent sandbox runs on a qualified cluster, through a login node over SSH
// with a fixed command set (mkdir, chmod, sbatch, sacct, squeue, scancel, sinfo,
// tail, tar, rm) plus scp. Commands are built from validated tokens only; no
// caller-supplied text reaches the remote shell.
//
// Each job gets <SLURM_REMOTE_ROOT>/<jobId>/ with the exact runner code, its
// parameters, staged inputs, and an output directory. The dispatch record
// (hpc_dispatches) is written before sbatch so a restarted worker re-attaches to
// the submitted Slurm job instead of submitting a second one.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { codedError } = require('../errors');

const ROOT = path.join(__dirname, '..', '..');
const RUNNER_FILES = [
  { local: 'r-backend/hpc-runner.R', remote: 'hpc-runner.R' },
  { local: 'r-backend/lib/seuratPipelineCore.R', remote: 'lib/seuratPipelineCore.R' },
];
const SAFE_TOKEN = /^[A-Za-z0-9_.,:=@%+/-]+$/;
const SAFE_PATH = /^\/[A-Za-z0-9_./-]+$/;
const JOB_ID = /^job_[0-9a-f]+$/;
const ACTIVE_STATES = new Set(['PENDING', 'CONFIGURING', 'RUNNING', 'COMPLETING', 'SUSPENDED', 'REQUEUED', 'RESIZING', 'STAGE_OUT']);

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function slurmConfig(env = process.env) {
  const target = env.SLURM_SSH_TARGET || '';
  const transport = env.SLURM_TRANSPORT === 'local' ? 'local' : 'ssh';
  const enabled = transport === 'local' || /^[A-Za-z0-9_.-]+@[A-Za-z0-9.-]+$/.test(target);
  const tokens = (value) => String(value || '').trim().split(/\s+/).filter(Boolean);
  const config = {
    enabled: enabled && SAFE_PATH.test(env.SLURM_REMOTE_ROOT || ''),
    transport,
    target,
    port: /^\d{1,5}$/.test(env.SLURM_SSH_PORT || '') ? env.SLURM_SSH_PORT : null,
    keyPath: env.SLURM_SSH_KEY || null,
    knownHosts: env.SLURM_SSH_KNOWN_HOSTS || null,
    remoteRoot: env.SLURM_REMOTE_ROOT || '',
    partition: env.SLURM_PARTITION || null,
    account: env.SLURM_ACCOUNT || null,
    qos: env.SLURM_QOS || null,
    rscript: tokens(env.SLURM_RSCRIPT || 'Rscript'),
    modules: tokens(env.SLURM_MODULES),
    pollSeconds: Math.min(600, Math.max(1, Number(env.SLURM_POLL_SECONDS) || 30)),
    name: env.SLURM_TARGET_NAME || 'slurm',
    // Agent sandbox runs on the cluster: the container command that isolates
    // the R process (for example "apptainer exec --containall --cleanenv
    // --no-home --network none --bind {work}:/work /path/traceomics-r.sif"), and
    // that image's digest. {work} is replaced with the run's work directory.
    sandboxExec: tokens(env.SLURM_SANDBOX_EXEC),
    sandboxImageDigest: /^sha256:[0-9a-f]{64}$/.test(env.SLURM_SANDBOX_IMAGE_DIGEST || '') ? env.SLURM_SANDBOX_IMAGE_DIGEST : null,
  };
  for (const [key, value] of Object.entries({ partition: config.partition, account: config.account, qos: config.qos })) {
    if (value && !SAFE_TOKEN.test(value)) config.enabled = false, config.invalid = key;
  }
  if (!config.rscript.length || !config.rscript.every((t) => SAFE_TOKEN.test(t))) config.enabled = false, config.invalid = 'rscript';
  if (!config.modules.every((t) => SAFE_TOKEN.test(t))) config.enabled = false, config.invalid = 'modules';
  config.sandboxConfigured = config.enabled && config.sandboxExec.length > 0 && Boolean(config.sandboxImageDigest)
    && config.sandboxExec.every((t) => SAFE_TOKEN.test(t.replace('{work}', '/w')));
  return config;
}

function run(command, args, { input, timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; if (stdout.length > 1e6) child.kill('SIGKILL'); });
    child.stderr.on('data', (chunk) => { stderr += chunk; if (stderr.length > 1e6) child.kill('SIGKILL'); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(Object.assign(codedError('SLURM_COMMAND_FAILED', `Cluster command failed (${code}).`), { stderr: stderr.slice(-2000) }));
    });
    if (input) child.stdin.end(input); else child.stdin.end();
  });
}

// SSH transport: commands run through the login node's shell with every argument
// single-quoted; files move with scp.
function sshTransport(config) {
  const sshOptions = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20'];
  if (config.port) sshOptions.push('-p', config.port);
  if (config.keyPath) sshOptions.push('-i', config.keyPath, '-o', 'IdentitiesOnly=yes');
  if (config.knownHosts) sshOptions.push('-o', `UserKnownHostsFile=${config.knownHosts}`, '-o', 'StrictHostKeyChecking=yes');
  const scpOptions = sshOptions.map((o) => (o === '-p' ? '-P' : o));
  return {
    exec: (argv, opts) => run('ssh', [...sshOptions, config.target, '--', argv.map(shellQuote).join(' ')], opts),
    put: (localPath, remotePath) => run('scp', [...scpOptions, '-q', localPath, `${config.target}:${remotePath}`], { timeoutMs: 3600000 }),
    get: (remotePath, localPath) => run('scp', [...scpOptions, '-q', `${config.target}:${remotePath}`, localPath], { timeoutMs: 3600000 }),
  };
}

// Local transport for development and tests: the "cluster" is this machine,
// with sbatch/sacct/scancel resolved from PATH.
function localTransport() {
  return {
    exec: (argv, opts) => run(argv[0], argv.slice(1), opts),
    put: async (localPath, remotePath) => { await fs.promises.mkdir(path.dirname(remotePath), { recursive: true }); await fs.promises.copyFile(localPath, remotePath); },
    get: async (remotePath, localPath) => { await fs.promises.copyFile(remotePath, localPath); },
  };
}

function wallTime(seconds) {
  const s = Math.max(60, Math.min(14 * 86400, Math.ceil(seconds)));
  const d = Math.floor(s / 86400);
  const hh = String(Math.floor((s % 86400) / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return d ? `${d}-${hh}:${mm}:${ss}` : `${hh}:${mm}:${ss}`;
}

function jobScript(config, { jobId, runDir, resources }) {
  const lines = [
    '#!/bin/bash',
    `#SBATCH --job-name=tro-${jobId}`,
    `#SBATCH --output=${runDir}/slurm.out`,
    `#SBATCH --cpus-per-task=${Math.max(1, Math.floor(resources.cpus))}`,
    `#SBATCH --mem=${Math.max(256, Math.floor(resources.memoryMiB))}M`,
    `#SBATCH --time=${wallTime(resources.maxWallSeconds)}`,
  ];
  if (config.partition) lines.push(`#SBATCH --partition=${config.partition}`);
  if (config.account) lines.push(`#SBATCH --account=${config.account}`);
  if (config.qos) lines.push(`#SBATCH --qos=${config.qos}`);
  lines.push('set -euo pipefail');
  if (config.modules.length) lines.push(`module load ${config.modules.join(' ')}`);
  lines.push(`cd ${runDir}`);
  lines.push(`exec ${config.rscript.join(' ')} ${runDir}/hpc-runner.R ${runDir}`);
  return `${lines.join('\n')}\n`;
}

// Job script for an agent sandbox run. The R process runs inside the
// operator's container command; the tarball of its output directory is made
// outside the container, after R exits successfully.
function sandboxJobScript(config, { jobId, runDir, work, containerWork, resources }) {
  const exec = config.sandboxExec.map((t) => t.split('{work}').join(work));
  const lines = [
    '#!/bin/bash',
    `#SBATCH --job-name=tro-${jobId}`,
    `#SBATCH --output=${runDir}/slurm.out`,
    `#SBATCH --cpus-per-task=${Math.max(1, Math.floor(resources.cpus))}`,
    `#SBATCH --mem=${Math.max(256, Math.floor(resources.memoryMiB))}M`,
    `#SBATCH --time=${wallTime(resources.maxWallSeconds)}`,
  ];
  if (config.partition) lines.push(`#SBATCH --partition=${config.partition}`);
  if (config.account) lines.push(`#SBATCH --account=${config.account}`);
  if (config.qos) lines.push(`#SBATCH --qos=${config.qos}`);
  lines.push('set -euo pipefail');
  if (config.modules.length) lines.push(`module load ${config.modules.join(' ')}`);
  lines.push(`cd ${runDir}`);
  lines.push(`${exec.join(' ')} Rscript --vanilla ${containerWork}/expert-runner.R ${containerWork}`);
  lines.push(`tar -czf ${runDir}/outputs.tar.gz -C ${work}/output .`);
  return `${lines.join('\n')}\n`;
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (c) => hash.update(c)).on('error', reject).on('end', () => resolve(hash.digest('hex')));
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createSlurmExecutor({ db, env = process.env, transport: injected } = {}) {
  const config = slurmConfig(env);
  const transport = injected || (config.transport === 'local' ? localTransport() : sshTransport(config));

  async function getDispatch(jobId) {
    const { rows } = await db.query('SELECT * FROM hpc_dispatches WHERE job_id = $1', [jobId]);
    return rows[0] || null;
  }
  async function saveDispatch(jobId, patch) {
    await db.query(
      `INSERT INTO hpc_dispatches (job_id, target, remote_dir, slurm_job_id, state)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (job_id) DO UPDATE SET
         slurm_job_id = COALESCE(EXCLUDED.slurm_job_id, hpc_dispatches.slurm_job_id),
         state = EXCLUDED.state, updated_at = now()`,
      [jobId, config.name, patch.remoteDir, patch.slurmJobId || null, patch.state]
    );
  }

  async function status() {
    if (!config.enabled) {
      return { name: config.name, kind: 'slurm', configured: false, available: false,
        reason: config.invalid ? `Invalid SLURM setting: ${config.invalid}.` : 'Slurm is not configured for this installation.' };
    }
    try {
      const out = await transport.exec(['sinfo', '-h', '-o', '%P %a %D'], { timeoutMs: 30000 });
      const partitions = out.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 50)
        .map((l) => { const [name, state, nodes] = l.split(/\s+/); return { name: name.replace(/\*$/, ''), default: name.endsWith('*'), state, nodes: Number(nodes) }; });
      return { name: config.name, kind: 'slurm', configured: true, available: true, partition: config.partition, partitions };
    } catch {
      return { name: config.name, kind: 'slurm', configured: true, available: false, reason: 'The cluster login node could not be reached.' };
    }
  }

  async function findExisting(jobId) {
    try {
      const out = await transport.exec(['squeue', '-h', '-n', `tro-${jobId}`, '-o', '%i']);
      const id = out.split('\n').map((l) => l.trim()).find((l) => /^\d+$/.test(l));
      if (id) return id;
    } catch { /* fall through to sacct */ }
    try {
      const out = await transport.exec(['sacct', '-n', '-X', '-P', '-S', 'now-7days', '--name', `tro-${jobId}`, '-o', 'JobID']);
      return out.split('\n').map((l) => l.trim()).filter((l) => /^\d+$/.test(l)).pop() || null;
    } catch { return null; }
  }

  async function jobState(slurmJobId) {
    try {
      const out = await transport.exec(['sacct', '-n', '-X', '-P', '-j', slurmJobId, '-o', 'State']);
      const state = out.split('\n').map((l) => l.trim()).filter(Boolean).pop();
      if (state) return state.split(/\s+/)[0];
    } catch { /* fall back to squeue */ }
    try {
      const out = await transport.exec(['squeue', '-h', '-j', slurmJobId, '-o', '%T']);
      return out.trim() || null;
    } catch { return null; }
  }

  async function tail(runDir) {
    try { return (await transport.exec(['tail', '-n', '40', `${runDir}/slurm.out`])).slice(-4000); } catch { return ''; }
  }

  // Stages a run directory (once), submits it, and waits for a terminal state.
  // `stage(write)` copies the run's files; it is skipped when re-attaching.
  async function submitAndWait({ jobId, runDir, stage, heartbeat, log, isCanceled, failureLabel = 'Slurm output (tail)' }) {
    let dispatch = await getDispatch(jobId);
    let slurmJobId = dispatch?.slurm_job_id || null;
    if (!slurmJobId && dispatch) {
      slurmJobId = await findExisting(jobId);
      if (slurmJobId) await log({ level: 'info', message: `Re-attached to Slurm job ${slurmJobId}.` });
    }
    if (!slurmJobId) {
      const staging = await fs.promises.mkdtemp(path.join(require('os').tmpdir(), 'tro-slurm-'));
      try {
        const write = async (name, text) => { const local = path.join(staging, name.replace(/\//g, '_')); await fs.promises.writeFile(local, text); await transport.put(local, `${runDir}/${name}`); };
        await stage(write);
      } finally {
        await fs.promises.rm(staging, { recursive: true, force: true });
      }
      await saveDispatch(jobId, { remoteDir: runDir, state: 'submitting' });
      const out = await transport.exec(['sbatch', '--parsable', `${runDir}/job.sh`]);
      slurmJobId = (out.trim().match(/^(\d+)/) || [])[1];
      if (!slurmJobId) throw codedError('SLURM_SUBMIT_FAILED', 'sbatch did not return a job id.');
      await log({ level: 'info', message: `Submitted Slurm job ${slurmJobId} (${config.name}).` });
    }
    await saveDispatch(jobId, { remoteDir: runDir, slurmJobId, state: 'submitted' });

    let canceled = false;
    let unknownPolls = 0;
    let lastState = null;
    for (;;) {
      try {
        await heartbeat();
      } catch (error) {
        // The claim was lost (job canceled or reaped): stop the cluster job too.
        await transport.exec(['scancel', slurmJobId]).catch(() => {});
        await saveDispatch(jobId, { remoteDir: runDir, slurmJobId, state: 'cancel_sent' }).catch(() => {});
        throw error;
      }
      if (!canceled && (await isCanceled())) {
        canceled = true;
        await transport.exec(['scancel', slurmJobId]).catch(() => {});
        await log({ level: 'warn', message: `Cancellation requested; sent scancel to Slurm job ${slurmJobId}.` });
      }
      const state = await jobState(slurmJobId);
      if (state && state !== lastState) {
        lastState = state;
        await saveDispatch(jobId, { remoteDir: runDir, slurmJobId, state: state.toLowerCase() });
        await log({ level: 'info', message: `Slurm job ${slurmJobId}: ${state}.` });
      }
      if (!state) {
        unknownPolls += 1;
        if (unknownPolls > 20) throw codedError('SLURM_STATE_UNKNOWN', 'The Slurm job state could not be determined.');
      } else if (state === 'COMPLETED') {
        break;
      } else if (!ACTIVE_STATES.has(state)) {
        const detail = await tail(runDir);
        if (detail) await log({ level: 'error', message: `${failureLabel}:\n${detail.slice(-1500)}` });
        throw codedError(canceled ? 'JOB_CANCELED' : 'SLURM_JOB_FAILED', `Slurm job ${slurmJobId} ended ${state}.`);
      }
      await sleep(config.pollSeconds * 1000);
    }
    return slurmJobId;
  }

  function runDirFor(jobId) {
    if (!config.enabled) throw codedError('SLURM_UNAVAILABLE', 'Slurm is not configured for this installation.');
    if (!JOB_ID.test(jobId)) throw codedError('INVALID_JOB_ID', 'Invalid job id.');
    return `${config.remoteRoot.replace(/\/+$/, '')}/${jobId}`;
  }

  // Runs the Seurat pipeline on the cluster and returns the R result body, after
  // copying the checkpoint to `checkpointPath` and verifying its checksum.
  async function runSeurat({ jobId, inputs, params, resources, checkpointPath, heartbeat, log, isCanceled }) {
    const runDir = runDirFor(jobId);
    const slurmJobId = await submitAndWait({ jobId, runDir, heartbeat, log, isCanceled, stage: async (write) => {
      await transport.exec(['mkdir', '-p', `${runDir}/input`, `${runDir}/output`, `${runDir}/lib`]);
      for (const file of RUNNER_FILES) await transport.put(path.join(ROOT, file.local), `${runDir}/${file.remote}`);
      const manifest = [];
      for (const [index, input] of inputs.entries()) {
        const name = `input/input-${index}.h5`;
        await transport.put(input.localPath, `${runDir}/${name}`);
        manifest.push({ file: name, sample_name: input.sampleName, condition_name: input.conditionName,
          donor_code: input.donorCode, batch: input.batch });
      }
      await write('params.json', JSON.stringify(params));
      await write('inputs.json', JSON.stringify(manifest));
      await write('job.sh', jobScript(config, { jobId, runDir, resources }));
    } });

    const resultLocal = `${checkpointPath}.result.json`;
    await transport.get(`${runDir}/output/result.json`, resultLocal);
    let body;
    try { body = JSON.parse(await fs.promises.readFile(resultLocal, 'utf8')); } finally { await fs.promises.rm(resultLocal, { force: true }); }
    await fs.promises.mkdir(path.dirname(checkpointPath), { recursive: true });
    await transport.get(`${runDir}/output/checkpoint.rds`, checkpointPath);
    const expected = body?.checkpoint?.checksum_sha256;
    if (typeof expected !== 'string' || (await sha256File(checkpointPath)) !== expected) {
      await fs.promises.rm(checkpointPath, { force: true });
      throw codedError('CHECKPOINT_INTEGRITY_FAILED', 'The cluster checkpoint did not match its recorded checksum.');
    }
    await saveDispatch(jobId, { remoteDir: runDir, slurmJobId, state: 'collected' });
    return { body, slurmJobId };
  }

  // Agent sandbox run (docs/spec.md phase 4) on the cluster. The R process runs
  // inside the operator's container command (SLURM_SANDBOX_EXEC) with the same
  // runner and helpers as the local Expert R container. Outputs come back as a
  // tarball that is listed, bounded, and re-validated here before anything is
  // stored; nothing on the cluster is trusted to have enforced the limits.
  async function runExpertR({ jobId, script, checkpointStorageKey, checkpointChecksumSha256, checkpointSizeBytes,
    privateInputs = [], outputStorageKey, resources, provider, heartbeat, log, isCanceled }) {
    if (!config.sandboxConfigured) throw codedError('SLURM_UNAVAILABLE', 'The cluster sandbox is not configured for this installation.');
    if (privateInputs.length) throw codedError('SLURM_UNAVAILABLE', 'Private input files are not staged to the cluster.');
    const { validateExpertRParams, EXPERT_R_PROFILE, SLURM_SANDBOX_POLICY_VERSION } = require('../expertR');
    const { collectOutputs, MAX_OUTPUT_BYTES, MAX_ARCHIVE_BYTES } = require('../expertSandboxBroker');
    const { scriptSha256 } = validateExpertRParams({ profileId: EXPERT_R_PROFILE.id, script, inputIds: [] });
    const runDir = runDirFor(jobId);
    const work = `${runDir}/work`;
    const containerWork = config.sandboxExec.some((t) => t.includes('{work}')) ? '/work' : work;
    const opened = await provider.openVerifiedRead(checkpointStorageKey, { sizeBytes: checkpointSizeBytes, checksumSha256: checkpointChecksumSha256 });
    await opened.handle.close();
    await submitAndWait({ jobId, runDir, heartbeat, log, isCanceled, failureLabel: 'R console (last lines)', stage: async (write) => {
      await transport.exec(['mkdir', '-p', `${work}/input`, `${work}/output`]);
      await transport.put(path.join(ROOT, 'r-backend/expert-runner.R'), `${work}/expert-runner.R`);
      await transport.put(provider.resolveKey(checkpointStorageKey), `${work}/input/checkpoint.rds`);
      await write('work/input/analysis.R', script);
      await write('work/input/input-manifest.json', '[]');
      await transport.exec(['chmod', '-R', 'a-w', `${work}/input`, `${work}/expert-runner.R`]);
      await write('job.sh', sandboxJobScript(config, { jobId, runDir, work, containerWork, resources }));
    } });

    const listing = await transport.exec(['tar', '-tvzf', `${runDir}/outputs.tar.gz`], { timeoutMs: 300000 });
    let listed = 0;
    let declared = 0;
    for (const line of listing.split('\n').filter(Boolean)) {
      const fields = line.trim().split(/\s+/);
      if (!['-', 'd'].includes(line[0])) throw codedError('EXPERT_R_RESULT_INVALID', 'The cluster outputs contain a link or special file.');
      if (line[0] === '-') { listed += 1; declared += Number(fields[2]) || 0; }
    }
    if (listed > 50 || declared > MAX_OUTPUT_BYTES) throw codedError('EXPERT_R_RESULT_INVALID', 'The cluster outputs exceed the sandbox limits.');
    const local = await fs.promises.mkdtemp(path.join(require('os').tmpdir(), 'tro-slurm-out-'));
    try {
      const fetched = path.join(local, 'fetched.tar.gz');
      await transport.get(`${runDir}/outputs.tar.gz`, fetched);
      if ((await fs.promises.stat(fetched)).size > MAX_ARCHIVE_BYTES) throw codedError('EXPERT_R_RESULT_INVALID', 'The cluster outputs exceed the sandbox limits.');
      const outputDir = path.join(local, 'output');
      await fs.promises.mkdir(outputDir);
      await run('tar', ['-xzf', fetched, '-C', outputDir, '--no-same-owner', '--no-same-permissions'], { timeoutMs: 300000 });
      let outputs;
      try { outputs = await collectOutputs(outputDir); } catch (error) {
        throw codedError('EXPERT_R_RESULT_INVALID', `The cluster outputs were rejected: ${error.message}`);
      }
      const archive = path.join(local, 'expert-r-outputs.tar.gz');
      await run('tar', ['-czf', archive, '-C', outputDir, '.'], { timeoutMs: 300000 });
      const stored = await provider.putFileFromPath(archive, outputStorageKey);
      const consoleTail = (await tail(runDir)).slice(-4000);
      await saveDispatch(jobId, { remoteDir: runDir, state: 'collected' });
      return {
        ok: true, saved: true, checksumSha256: stored.checksumSha256, sizeBytes: stored.sizeBytes,
        nFiles: outputs.files.length, outputBytes: outputs.totalBytes,
        files: outputs.files.map((file) => ({ name: file.relative, sizeBytes: file.sizeBytes, checksumSha256: file.checksumSha256 })),
        scriptSha256, profileId: EXPERT_R_PROFILE.id, checkpointChecksumSha256, privateInputs: [],
        sandboxImageDigest: config.sandboxImageDigest, resourcePolicyVersion: SLURM_SANDBOX_POLICY_VERSION,
        ...(consoleTail ? { consoleTail } : {}),
      };
    } finally {
      await fs.promises.rm(local, { recursive: true, force: true });
    }
  }

  async function cancel(jobId) {
    const dispatch = await getDispatch(jobId);
    if (dispatch?.slurm_job_id) await transport.exec(['scancel', dispatch.slurm_job_id]).catch(() => {});
  }

  return {
    config, status, runSeurat, runExpertR, cancel, transport, jobState, submitAndWait, runDirFor,
    jobScript: (args) => jobScript(config, args),
  };
}

module.exports = { createSlurmExecutor, slurmConfig, jobScript, sandboxJobScript, wallTime, shellQuote };
