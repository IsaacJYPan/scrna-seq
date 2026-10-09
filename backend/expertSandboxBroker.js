'use strict';

// Trusted internal broker for ephemeral expert-R containers. The web service is
// intentionally not imported by server.js and has no public route. It accepts a
// narrow authenticated job spec, copies one checkpoint into a job-private host
// directory, starts a fixed image with no network or project-storage mount, then
// validates and archives only bounded output files.
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { pipeline } = require('stream/promises');
const storage = require('./storage');
const { MAX_ENVIRONMENT_BYTES, environmentBytes, summarizeEnvironmentManifest, assertEnvironmentMatches } = require('./rEnvironment');
const { rEnvironmentProbeCode, buildEnvironmentManifest } = require('./rEnvironmentProbe');
const {
  EXPERT_R_PROFILE,
  expertRProfileProbeCode,
  validateExpertRParams,
  MAX_EXPERT_R_OUTPUT_BYTES,
  MAX_EXPERT_R_BUNDLE_BYTES,
  EXPERT_R_RESOURCE_POLICY_VERSION,
  MAX_EXPERT_R_INPUT_BYTES,
  maxExpertRInputBytesForFilename,
  MAX_EXPERT_R_INPUTS_PER_RUN,
  sanitizeExpertRInputFilename,
} = require('./expertR');

// Expert R may write reviewed tables and figures. Extension and duplicate-input
// checks are defense in depth only: they do not turn arbitrary R into a general
// data-loss-prevention boundary.
const ALLOWED_OUTPUT_EXTENSIONS = new Set(['.csv', '.tsv', '.json', '.txt', '.png', '.pdf', '.svg', '.rds']);
const MAX_OUTPUT_FILES = 50;
const MAX_OUTPUT_BYTES = MAX_EXPERT_R_OUTPUT_BYTES;
const MAX_ARCHIVE_BYTES = MAX_EXPERT_R_BUNDLE_BYTES;
const DEFAULT_MIN_FREE_BYTES = 1024 * 1024 * 1024;
const OUTPUT_TMPFS_INODES = 1024;
const WORKSPACE_MANIFEST = '.traceomics-expert-workspace.json';
const WORKSPACE_DIRECTORY_RE = /^job_[0-9a-f]+-[0-9a-f]{24}$/;
const CONTAINER_NAME_RE = /^traceomics-expert-job_[0-9a-f]+-[0-9a-f]{10}$/;
const CONTAINER_LABEL = 'org.traceomics.expert';

function safeEqual(left, right) {
  const a = Buffer.from(String(left || '')); const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function safeFailureCode(error) {
  if (error && error.code === 'SANDBOX_OUTPUT_QUOTA_EXCEEDED') return 'SANDBOX_OUTPUT_QUOTA_EXCEEDED';
  if (error && error.code === 'SANDBOX_INTERRUPTED') return 'SANDBOX_INTERRUPTED';
  if (error && error.exitCode === 137) return 'SANDBOX_RESOURCE_KILLED';
  if (error && error.exitCode === 125) return 'SANDBOX_DAEMON_REJECTED';
  const diagnostic = String(error && error.diagnostic || '').toLowerCase();
  if (diagnostic.includes('permission denied')) return 'SANDBOX_PERMISSION_DENIED';
  if (diagnostic.includes('invalid mount') || diagnostic.includes('mount source path')) return 'SANDBOX_MOUNT_FAILED';
  if (diagnostic.includes('no such image')) return 'SANDBOX_IMAGE_UNAVAILABLE';
  if (diagnostic.includes('cannot open file')) return 'SANDBOX_RUNNER_UNAVAILABLE';
  return 'SANDBOX_FAILED';
}

function ownerScriptFailureExplanation(error, phase) {
  if (phase !== 'execute' || error?.exitCode !== 1) return null;
  if (error?.code === 'SANDBOX_OUTPUT_QUOTA_EXCEEDED') {
    return 'The R script exceeded the per-run output storage limit.';
  }
  const diagnostic = String(error?.diagnostic || '').toLowerCase();
  if (/no space left on device|cannot write|failed to write|problem writing to connection/.test(diagnostic)) {
    return 'The R script exceeded the per-run output storage limit.';
  }
  if (/parse error|unexpected (?:symbol|token|end|input)|incomplete final line/.test(diagnostic)) {
    return 'The R script could not be parsed. Check its syntax and line endings.';
  }
  if (/there is no package called|package .* is not available/.test(diagnostic)) {
    return 'A requested R package is not included in the approved package profile.';
  }
  if (/object .* not found|could not find function/.test(diagnostic)) {
    return 'The R script referenced an object or function that is not available.';
  }
  if (/cannot open (?:the )?(?:connection|file)|no such file or directory/.test(diagnostic)) {
    return 'The R script could not find a selected input file.';
  }
  return 'The R script stopped with an error. Check input names, columns, and function arguments.';
}

function positiveInteger(raw, fallback) {
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function isTrustedBrokerBindHost(raw) {
  const host = String(raw || '').trim().toLowerCase();
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

function validateExpertRuntimeIsolation(env = process.env) {
  if (String(env.NODE_ENV || '').trim().toLowerCase() !== 'production') return true;
  const mode = String(env.EXPERT_R_RUNTIME_ISOLATION || '').trim().toLowerCase();
  const dockerHost = String(env.DOCKER_HOST || '').trim();
  if (!['dedicated-rootless', 'isolated-vm'].includes(mode)) {
    throw new Error('Production Expert R requires an explicitly isolated container runtime.');
  }
  if (!dockerHost || /^unix:\/\/\/var\/run\/docker\.sock$/i.test(dockerHost)
      || /^npipe:/i.test(dockerHost)) {
    throw new Error('Production Expert R cannot use the host system Docker socket.');
  }
  if (mode === 'dedicated-rootless' && !/^unix:\/\/\/.+/i.test(dockerHost)) {
    throw new Error('The dedicated rootless Expert R runtime must use its private Unix socket.');
  }
  if (mode === 'isolated-vm' && /^tcp:/i.test(dockerHost)
      && (env.DOCKER_TLS_VERIFY !== '1' || !path.isAbsolute(String(env.DOCKER_CERT_PATH || '')))) {
    throw new Error('A remote Expert R runtime requires verified TLS credentials.');
  }
  return true;
}

async function assertExpertRuntimeSecurity(env = process.env, runProcessImpl = runProcess) {
  if (String(env.NODE_ENV || '').trim().toLowerCase() !== 'production') return true;
  const result = await runProcessImpl('docker', [
    'info', '--format', '{{json .SecurityOptions}}',
  ], { timeoutMs: 30000 });
  let options;
  try { options = JSON.parse(String(result.stdout || '').trim()); } catch {
    throw new Error('Expert R container runtime security could not be verified.');
  }
  if (String(env.EXPERT_R_RUNTIME_ISOLATION || '').trim().toLowerCase() === 'dedicated-rootless'
      && (!Array.isArray(options) || !options.includes('name=rootless'))) {
    throw new Error('The dedicated Expert R container runtime is not rootless.');
  }
  return true;
}

async function assertExpertRuntimeImage(env = process.env, runProcessImpl = runProcess) {
  const image = String(env.EXPERT_R_SANDBOX_IMAGE || '');
  if (!/^(?:[^\s@]+@)?sha256:[0-9a-f]{64}$/.test(image)) throw new Error('Expert R requires an immutable runtime image.');
  const inspected = await runProcessImpl('docker', ['image', 'inspect', image, '--format', '{{.Id}}'], { timeoutMs: 30000 });
  if (!/^sha256:[0-9a-f]{64}$/.test(String(inspected.stdout || '').trim())) throw new Error('Expert R runtime image is unavailable.');
  const containerName = `traceomics-expert-preflight-${crypto.randomBytes(12).toString('hex')}`;
  const result = await runProcessImpl('docker', ['run', '--rm', '--name', containerName,
    '--label', `${CONTAINER_LABEL}=true`, '--network', 'none', '--read-only',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '256',
    '--memory', env.EXPERT_R_MEMORY_LIMIT || '8g', '--cpus', env.EXPERT_R_CPU_LIMIT || '2',
    '--user', '10001:10001', '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=512m',
    '--entrypoint', 'Rscript', image, '-e', `${expertRProfileProbeCode()}; cat('private-r-profile-ok')`], {
    timeoutMs: 90000,
    onTimeout: () => runProcessImpl('docker', ['rm', '-f', containerName], { timeoutMs: 30000 }),
  });
  if (!String(result.stdout || '').includes('private-r-profile-ok')) throw new Error('Expert R runtime does not provide the supported package profile.');
  return true;
}

async function discoverExpertRuntimeEnvironment(env = process.env, runProcessImpl = runProcess) {
  const image = String(env.EXPERT_R_SANDBOX_IMAGE || '');
  if (!/^(?:[^\s@]+@)?sha256:[0-9a-f]{64}$/.test(image)) throw new Error('Expert R requires an immutable runtime image.');
  const inspected = await runProcessImpl('docker', ['image', 'inspect', image, '--format',
    '{"imageId":{{json .Id}},"os":{{json .Os}},"architecture":{{json .Architecture}}}'], { timeoutMs: 30000 });
  const metadata = JSON.parse(String(inspected.stdout || '').trim());
  const containerName = `traceomics-expert-environment-${crypto.randomBytes(12).toString('hex')}`;
  const result = await runProcessImpl('docker', ['run', '--rm', '--name', containerName,
    '--label', `${CONTAINER_LABEL}=true`, '--network', 'none', '--read-only',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '256',
    '--memory', env.EXPERT_R_MEMORY_LIMIT || '8g', '--cpus', env.EXPERT_R_CPU_LIMIT || '2',
    '--user', '10001:10001', '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=512m',
    '--entrypoint', 'Rscript', image, '--vanilla', '-e', rEnvironmentProbeCode()], {
    timeoutMs: 90000,
    onTimeout: () => runProcessImpl('docker', ['rm', '-f', containerName], { timeoutMs: 30000 }),
  });
  if (Buffer.byteLength(String(result.stdout || ''), 'utf8') > MAX_ENVIRONMENT_BYTES) throw new Error('Expert R environment inventory exceeds its size limit.');
  return buildEnvironmentManifest(JSON.parse(result.stdout), metadata, image);
}

function workspaceRootHash(workRoot) {
  return crypto.createHash('sha256').update(path.resolve(workRoot), 'utf8').digest('hex');
}

async function writeWorkspaceManifest(jobDirectory, workRoot, value) {
  const manifest = {
    version: 1,
    workspace: path.basename(jobDirectory),
    jobId: value.jobId,
    containerName: value.containerName || null,
    createdAt: value.createdAt,
    workRootSha256: workspaceRootHash(workRoot),
  };
  const destination = path.join(jobDirectory, WORKSPACE_MANIFEST);
  const temporary = `${destination}.tmp`;
  await fsp.writeFile(temporary, JSON.stringify(manifest), {
    encoding: 'utf8', flag: 'wx', mode: 0o600,
  });
  await fsp.rename(temporary, destination);
  return manifest;
}

async function readWorkspaceManifest(jobDirectory, workRoot) {
  const raw = await fsp.readFile(path.join(jobDirectory, WORKSPACE_MANIFEST), 'utf8');
  const value = JSON.parse(raw);
  const keys = Object.keys(value || {}).sort();
  if (JSON.stringify(keys) !== JSON.stringify([
    'containerName', 'createdAt', 'jobId', 'version', 'workRootSha256', 'workspace',
  ])
      || value.version !== 1
      || value.workspace !== path.basename(jobDirectory)
      || !WORKSPACE_DIRECTORY_RE.test(value.workspace)
      || !/^job_[0-9a-f]+$/.test(String(value.jobId || ''))
      || (value.containerName !== null && !CONTAINER_NAME_RE.test(String(value.containerName || '')))
      || !Number.isFinite(Date.parse(value.createdAt))
      || value.workRootSha256 !== workspaceRootHash(workRoot)) {
    throw new Error('Expert R workspace manifest is invalid.');
  }
  return value;
}

async function removeOwnedOrphanContainer(manifest, runProcessImpl) {
  if (!manifest.containerName) return true;
  let inspected;
  try {
    inspected = await runProcessImpl('docker', [
      'inspect', '--format', '{{json .Config.Labels}}', manifest.containerName,
    ], { timeoutMs: 30000 });
  } catch {
    // An unavailable runtime is not proof that the named container is gone.
    return false;
  }
  let labels;
  try { labels = JSON.parse(String(inspected.stdout || '').trim()); } catch { return false; }
  if (!labels || labels[CONTAINER_LABEL] !== 'true'
      || labels[`${CONTAINER_LABEL}.workspace`] !== manifest.workspace
      || labels[`${CONTAINER_LABEL}.work-root`] !== manifest.workRootSha256) return false;
  await runProcessImpl('docker', ['rm', '-f', manifest.containerName], { timeoutMs: 30000 });
  return true;
}

async function reconcileExpertSandboxWorkRoot({
  workRoot, activeWorkspaces = new Set(), staleAfterMs,
  now = Date.now(), runProcessImpl = runProcess,
}) {
  const resolvedRoot = path.resolve(workRoot);
  await fsp.mkdir(resolvedRoot, { recursive: true, mode: 0o700 });
  const result = { removed: 0, skipped: 0, invalid: 0 };
  for (const entry of await fsp.readdir(resolvedRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !WORKSPACE_DIRECTORY_RE.test(entry.name)) continue;
    if (activeWorkspaces.has(entry.name)) { result.skipped += 1; continue; }
    const jobDirectory = path.join(resolvedRoot, entry.name);
    let manifest;
    try { manifest = await readWorkspaceManifest(jobDirectory, resolvedRoot); } catch {
      result.invalid += 1; continue;
    }
    if (now - Date.parse(manifest.createdAt) < staleAfterMs) { result.skipped += 1; continue; }
    if (!await removeOwnedOrphanContainer(manifest, runProcessImpl)) {
      result.skipped += 1; continue;
    }
    await removeJobDirectory(jobDirectory, resolvedRoot);
    result.removed += 1;
  }
  return result;
}

async function freeBytesAt(directory) {
  const stats = await fsp.statfs(directory, { bigint: true });
  return stats.bavail * stats.bsize;
}

async function assertFreeSpace(directory, requiredBytes) {
  const required = BigInt(requiredBytes);
  const available = await freeBytesAt(directory);
  if (available < required) {
    const error = new Error('Expert R storage admission rejected.');
    error.code = 'SANDBOX_STORAGE_PRESSURE';
    throw error;
  }
  return available;
}

async function pathsShareFilesystem(left, right) {
  const [leftStat, rightStat] = await Promise.all([
    fsp.stat(left, { bigint: true }),
    fsp.stat(right, { bigint: true }),
  ]);
  return leftStat.dev === rightStat.dev;
}

async function copyVerifiedCheckpoint(provider, key, destination, expected) {
  const opened = await provider.openVerifiedRead(key, expected);
  try {
    await pipeline(
      opened.handle.createReadStream({ autoClose: false }),
      fs.createWriteStream(destination, { flags: 'wx', mode: 0o600 })
    );
  } finally {
    await opened.handle.close();
  }
  return { checksumSha256: opened.checksumSha256, sizeBytes: opened.stat.size };
}

async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}

async function collectOutputs(root, { forbiddenContentHashes = new Set() } = {}) {
  const files = [];
  async function walk(directory) {
    for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) throw new Error('Unsafe sandbox output.');
      if (entry.isDirectory()) await walk(absolute);
      else {
        const relative = path.relative(root, absolute);
        if (path.isAbsolute(relative) || relative.startsWith('..')
            || !ALLOWED_OUTPUT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) throw new Error('Unsupported sandbox output.');
        const portableRelative = relative.split(path.sep).join('/');
        if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,159}$/.test(portableRelative)
            || portableRelative.split('/').some((part) => part === '.' || part === '..' || part === '')) {
          throw new Error('Unsupported sandbox output name.');
        }
        const stat = await fsp.stat(absolute);
        const checksumSha256 = await sha256File(absolute);
        if (forbiddenContentHashes.has(checksumSha256)) {
          throw new Error('Sandbox output duplicates a private input.');
        }
        files.push({
          absolute,
          relative: portableRelative,
          sizeBytes: stat.size,
          checksumSha256,
        });
      }
    }
  }
  await walk(root);
  const totalBytes = files.reduce((sum, file) => sum + file.sizeBytes, 0);
  if (files.length > MAX_OUTPUT_FILES || totalBytes > MAX_OUTPUT_BYTES) throw new Error('Sandbox outputs exceed limits.');
  return { files, totalBytes };
}

async function removeJobDirectory(jobDirectory, workRoot) {
  if (!jobDirectory || !jobDirectory.startsWith(`${workRoot}${path.sep}`)) return;
  const inputDirectory = path.join(jobDirectory, 'input');
  const outputDirectory = path.join(jobDirectory, 'output');
  await fsp.chmod(jobDirectory, 0o700).catch(() => {});
  await fsp.chmod(inputDirectory, 0o700).catch(() => {});
  await fsp.chmod(path.join(inputDirectory, 'checkpoint.rds'), 0o600).catch(() => {});
  await fsp.chmod(path.join(inputDirectory, 'analysis.R'), 0o600).catch(() => {});
  await fsp.chmod(outputDirectory, 0o700).catch(() => {});
  await fsp.rm(jobDirectory, { recursive: true, force: true });
}

function runProcess(command, args, { timeoutMs, cwd, onTimeout, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    let interrupted = false; let cleanup = Promise.resolve(); let settled = false;
    const append = (current, chunk) => (current + chunk.toString('utf8')).slice(-524288);
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
    const interrupt = () => {
      if (interrupted || settled) return;
      interrupted = true;
      cleanup = typeof onTimeout === 'function'
        ? Promise.resolve().then(onTimeout).catch(() => {}) : Promise.resolve();
      child.kill('SIGKILL');
    };
    const timer = setTimeout(interrupt, timeoutMs || 600000);
    const abort = () => interrupt();
    if (signal) {
      if (signal.aborted) interrupt();
      else signal.addEventListener('abort', abort, { once: true });
    }
    const finish = async (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', abort);
      await cleanup;
      if (interrupted) reject(Object.assign(new Error('Sandbox process interrupted.'), { code: 'SANDBOX_INTERRUPTED' }));
      else if (error) reject(error);
      else resolve(value);
    };
    child.once('error', (error) => { void finish(error); });
    child.once('close', (code) => {
      void finish(code === 0 ? null : Object.assign(
        new Error('Sandbox process failed.'), {
          diagnostic: stderr.slice(-1000), exitCode: code,
        }
      ), { stdout, stderr });
    });
  });
}

async function assertSandboxQuiescent(containerName) {
  const top = await runProcess('docker', [
    'top', containerName, '-eo', 'pid,ppid,user,comm',
  ], { timeoutMs: 30000 });
  const lines = String(top.stdout || '').trim().split(/\r?\n/).filter(Boolean);
  if (lines.length !== 2 || !/\btail\s*$/i.test(lines[1])) {
    throw new Error('Sandbox left an unexpected background process.');
  }
}

function parseContainerOutputInventory(raw) {
  const fields = String(raw || '').split('\0');
  if (fields[fields.length - 1] === '') fields.pop();
  if (fields.length % 3 !== 0 || fields.length / 3 > 128) {
    throw new Error('Sandbox output inventory is invalid.');
  }
  const entries = [];
  let fileCount = 0;
  let totalBytes = 0;
  for (let index = 0; index < fields.length; index += 3) {
    const type = fields[index];
    const sizeBytes = Number(fields[index + 1]);
    const absolute = fields[index + 2];
    const relative = path.posix.relative('/work/output', absolute);
    if (!['d', 'f'].includes(type)
        || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0
        || path.posix.isAbsolute(relative) || relative.startsWith('..')
        || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,159}$/.test(relative)
        || relative.split('/').some((part) => part === '.' || part === '..' || part === '')) {
      throw new Error('Sandbox output inventory is invalid.');
    }
    if (type === 'f') {
      fileCount += 1;
      totalBytes += sizeBytes;
      if (!ALLOWED_OUTPUT_EXTENSIONS.has(path.posix.extname(relative).toLowerCase())) {
        throw new Error('Unsupported sandbox output.');
      }
    }
    entries.push({ type, absolute, relative, sizeBytes });
  }
  if (fileCount > MAX_OUTPUT_FILES || totalBytes > MAX_OUTPUT_BYTES) {
    throw new Error('Sandbox outputs exceed limits.');
  }
  return entries;
}

function streamContainerFile(containerName, source, destination, expectedBytes, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['exec', containerName, 'cat', '--', source], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    let settled = false;
    const abort = () => child.kill('SIGKILL');
    if (signal) {
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    }
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString('utf8')).slice(-4096); });
    const output = fs.createWriteStream(destination, { flags: 'wx', mode: 0o600 });
    const copying = pipeline(child.stdout, output);
    const finish = async (error) => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener('abort', abort);
      if (error) return reject(error);
      try {
        const stat = await fsp.stat(destination);
        if (!stat.isFile() || stat.size !== expectedBytes) {
          throw new Error('Sandbox output changed during extraction.');
        }
        resolve();
      } catch (statError) { reject(statError); }
    };
    child.once('error', (error) => { void finish(error); });
    child.once('close', (code) => {
      void copying.then(
        () => finish(code === 0 ? null : Object.assign(new Error('Sandbox output extraction failed.'), { diagnostic: stderr })),
        (error) => finish(error)
      );
    });
  });
}

async function extractContainerOutputs(containerName, outputDirectory, signal) {
  await assertSandboxQuiescent(containerName);
  const inventory = await runProcess('docker', [
    'exec', containerName, 'find', '/work/output', '-mindepth', '1',
    '-printf', '%y\\0%s\\0%p\\0',
  ], { timeoutMs: 30000, signal });
  const entries = parseContainerOutputInventory(inventory.stdout);
  const directories = entries.filter((entry) => entry.type === 'd')
    .sort((left, right) => left.relative.length - right.relative.length);
  for (const entry of directories) {
    await fsp.mkdir(path.join(outputDirectory, ...entry.relative.split('/')), { recursive: true, mode: 0o700 });
  }
  for (const entry of entries.filter((candidate) => candidate.type === 'f')) {
    const destination = path.join(outputDirectory, ...entry.relative.split('/'));
    await fsp.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await streamContainerFile(containerName, entry.absolute, destination, entry.sizeBytes, signal);
  }
}

function createExpertSandboxBroker(env = process.env) {
  validateExpertRuntimeIsolation(env);
  const token = String(env.EXPERT_R_SANDBOX_TOKEN || '');
  const image = String(env.EXPERT_R_SANDBOX_IMAGE || '');
  const configuredWorkRoot = String(env.EXPERT_R_SANDBOX_WORK_ROOT || '').trim();
  const workRoot = path.resolve(configuredWorkRoot || '.');
  if (!/^[0-9a-f]{64}$/.test(token)
      || !/^(?:[^\s@]+@)?sha256:[0-9a-f]{64}$/.test(image)
      || !configuredWorkRoot || !path.isAbsolute(configuredWorkRoot)) {
    throw new Error('Expert sandbox broker configuration is invalid.');
  }
  const sandboxImageDigest = image.slice(image.lastIndexOf('sha256:'));
  const provider = storage.createLocalStorageProvider();
  const configuredConcurrent = Number(env.EXPERT_R_MAX_CONCURRENT || 2);
  const maxConcurrent = Number.isInteger(configuredConcurrent) && configuredConcurrent >= 1
    ? Math.min(2, configuredConcurrent) : 2;
  const minFreeBytes = positiveInteger(env.EXPERT_R_MIN_FREE_BYTES, DEFAULT_MIN_FREE_BYTES);
  let active = 0;
  let reservedWorkBytes = 0n;
  let reservedStorageBytes = 0n;
  const activeWorkspaces = new Set();
  let reconcileTimer = null;
  let reconciliation = null;
  let runtimeVerified = false;
  let environmentManifest = null;
  let environment = null;
  let kernelRuntime = null;
  let privateKernelStatus = { state: 'disabled' };
  const timeoutMs = positiveInteger(env.EXPERT_R_TIMEOUT_MS, 600000);
  const cleanupGraceMs = positiveInteger(env.EXPERT_R_CLEANUP_GRACE_MS, 300000);
  const reconcileIntervalMs = positiveInteger(env.EXPERT_R_RECONCILE_INTERVAL_MS, 300000);
  const reconcile = async () => {
    if (reconciliation) return reconciliation;
    reconciliation = reconcileExpertSandboxWorkRoot({
      workRoot, activeWorkspaces, staleAfterMs: timeoutMs + cleanupGraceMs,
    }).finally(() => { reconciliation = null; });
    return reconciliation;
  };
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'GET' && req.url === '/health') return res.end(JSON.stringify({ status: 'ok', profileId: EXPERT_R_PROFILE.id }));
    if (req.method === 'GET' && req.url === '/capabilities'
        && safeEqual(String(req.headers.authorization || '').replace(/^Bearer /, ''), token)) {
      if (!runtimeVerified) { res.statusCode = 503; return res.end(JSON.stringify({ status: 'unavailable' })); }
      return res.end(JSON.stringify({ status: 'ok', profileId: EXPERT_R_PROFILE.id,
        sandboxImageDigest, resourcePolicyVersion: EXPERT_R_RESOURCE_POLICY_VERSION, environment,
        persistentKernel: privateKernelStatus.state === 'ready',
        persistentKernelPublications: privateKernelStatus.state === 'ready' && privateKernelStatus.publications === true,
        persistentKernelInterrupt: privateKernelStatus.state === 'ready' && privateKernelStatus.interrupt === true,
        privateKernelStatus }));
    }
    if (req.method === 'GET' && req.url === '/environment'
        && safeEqual(String(req.headers.authorization || '').replace(/^Bearer /, ''), token)) {
      if (!runtimeVerified || !environmentManifest) { res.statusCode = 503; return res.end(JSON.stringify({ error: 'Exact R environment is unavailable.' })); }
      return res.end(environmentBytes(environmentManifest));
    }
    const kernelRoute = /^\/kernels\/(start|pk_[a-f0-9]{24}\/(?:inspect|execute|interrupt|export|export-status|stop))$/.exec(req.url || '');
    if (req.method === 'POST' && kernelRoute
        && safeEqual(String(req.headers.authorization || '').replace(/^Bearer /, ''), token)) {
      if (!runtimeVerified || privateKernelStatus.state !== 'ready' || !kernelRuntime) {
        res.statusCode = 503;
        return res.end(JSON.stringify({ error: 'Persistent private R is unavailable.', code: 'PRIVATE_KERNEL_UNAVAILABLE' }));
      }
      try {
        const chunks = []; let bytes = 0;
        for await (const chunk of req) {
          bytes += chunk.length;
          if (bytes > 256 * 1024) {
            res.statusCode = 413;
            return res.end(JSON.stringify({ error: 'The private R request exceeds its limit.', code: 'PRIVATE_KERNEL_INVALID' }));
          }
          chunks.push(chunk);
        }
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { throw Object.assign(new Error('A valid JSON request is required.'), { code: 'PRIVATE_KERNEL_INVALID', publicSafeHandlerError: true }); }
        const parts = kernelRoute[1].split('/');
        const result = parts[0] === 'start' ? await kernelRuntime.start(body)
          : parts[1] === 'execute' ? await kernelRuntime.execute(body, parts[0], body)
          : parts[1] === 'interrupt' ? await kernelRuntime.interrupt(body, parts[0], body)
          : parts[1] === 'export' ? await kernelRuntime.export(body, parts[0], body)
          : parts[1] === 'export-status' ? await kernelRuntime.exportStatus(body, parts[0], body)
          : await kernelRuntime[parts[1]](body, parts[0]);
        return res.end(JSON.stringify(result));
      } catch (error) {
        const code = error.publicSafeHandlerError === true ? error.code : 'PRIVATE_KERNEL_UNAVAILABLE';
        res.statusCode = /NOT_FOUND$/.test(code) ? 404
          : /INVALID/.test(code) ? 400 : /BUSY|CONFLICT|ORDER/.test(code) ? 409
            : /LIMIT/.test(code) ? 429 : 503;
        return res.end(JSON.stringify({ code,
          error: error.publicSafeHandlerError === true ? error.message : 'The private R runtime could not confirm this request.' }));
      }
    }
    if (req.method !== 'POST' || req.url !== '/run'
        || !safeEqual(String(req.headers.authorization || '').replace(/^Bearer /, ''), token)) {
      res.statusCode = 404; return res.end(JSON.stringify({ error: 'Not found.' }));
    }
    if (active >= maxConcurrent) {
      res.statusCode = 503; return res.end(JSON.stringify({ error: 'Expert R capacity is busy.' }));
    }
    active += 1;
    let jobDirectory = null;
    let containerName = null;
    let workReservationBytes = 0n;
    let storageReservationBytes = 0n;
    let phase = 'request';
    let environmentStorageKey = null;
    let published = false;
    const abortController = new AbortController();
    res.once('close', () => { if (!res.writableEnded) abortController.abort(); });
    try {
      const chunks = []; let bytes = 0;
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 65536) throw new Error('Request too large.'); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!runtimeVerified || !environment) throw Object.assign(new Error('The exact R environment is unavailable.'), { code: 'R_ENVIRONMENT_UNAVAILABLE' });
      assertEnvironmentMatches(body.environment, environment);
      try {
        const inspected = await runProcess('docker', ['image', 'inspect', image, '--format', '{{.Id}}'], { timeoutMs: 15000 });
        if (String(inspected.stdout || '').trim() !== environment.imageId) throw new Error('Runtime changed');
      } catch { throw Object.assign(new Error('The pinned runtime image is unavailable.'), { code: 'R_ENVIRONMENT_UNAVAILABLE' }); }
      const validated = validateExpertRParams({ profileId: body.profileId, script: body.script });
      const workflowOutputs = body.workflowOutputs;
      if (workflowOutputs !== undefined) {
        const types = { rds: 'rds', table: 'json', metrics: 'json', scatter: 'json', figure: 'png' };
        if (!workflowOutputs || typeof workflowOutputs !== 'object' || Array.isArray(workflowOutputs)
            || Object.keys(workflowOutputs).length < 1 || Object.keys(workflowOutputs).length > 8
            || Object.entries(workflowOutputs).some(([port, output]) => !/^[a-z][a-z0-9-]{1,39}$/.test(port)
              || !output || !Object.hasOwn(types, output.type) || output.name !== `${port}.${types[output.type]}`
              || Object.keys(output).some(key => !['type', 'name'].includes(key)))) throw new Error('Invalid workflow output contract.');
      }
      const privateInputs = body.privateInputs === undefined ? [] : body.privateInputs;
      const privateInputIds = new Set();
      if (!Array.isArray(privateInputs) || privateInputs.length > MAX_EXPERT_R_INPUTS_PER_RUN
          || privateInputs.some((input) => {
            if (!input || typeof input !== 'object' || Array.isArray(input)
                || !/^eri_[0-9a-f]{24}$/.test(String(input.id || ''))
                || privateInputIds.has(input.id)
                || !storage.isProjectStorageKey(input.internalStorageKey, { projectId: body.projectId, kind: 'artifacts' })
                || !/^[0-9a-f]{64}$/.test(String(input.checksumSha256 || ''))
                || !Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0
                || input.sizeBytes > MAX_EXPERT_R_INPUT_BYTES) return true;
            let safeName;
            try { safeName = sanitizeExpertRInputFilename(input.originalFilename); } catch { return true; }
            if (safeName !== input.originalFilename
                || input.sizeBytes > maxExpertRInputBytesForFilename(safeName)) return true;
            privateInputIds.add(input.id);
            return false;
          })) throw new Error('Invalid sandbox private inputs.');
      if (!/^job_[0-9a-f]+$/.test(body.jobId) || !storage.isProjectStorageKey(body.checkpointStorageKey, { projectId: body.projectId, kind: 'checkpoints' })
          || !storage.isProjectStorageKey(body.outputStorageKey, { projectId: body.projectId, kind: 'artifacts' })
          || !Number.isSafeInteger(body.checkpointSizeBytes) || body.checkpointSizeBytes < 0) throw new Error('Invalid sandbox job scope.');
      jobDirectory = path.join(workRoot, `${body.jobId}-${crypto.randomBytes(12).toString('hex')}`);
      phase = 'prepare-directories';
      const inputDirectory = path.join(jobDirectory, 'input'); const outputDirectory = path.join(jobDirectory, 'output');
      await fsp.mkdir(workRoot, { recursive: true, mode: 0o700 });
      await fsp.mkdir(provider.root, { recursive: true, mode: 0o700 });
      const privateInputBytes = privateInputs.reduce((sum, input) => sum + input.sizeBytes, 0);
      workReservationBytes = BigInt(body.checkpointSizeBytes)
        + BigInt(privateInputBytes) + BigInt(3 * MAX_ARCHIVE_BYTES);
      storageReservationBytes = BigInt(MAX_ARCHIVE_BYTES + MAX_ENVIRONMENT_BYTES);
      // Reservation counters close the two-request admission race: both active
      // runs must fit before either is allowed to start copying. If the broker's
      // work and durable roots share a filesystem, account for both growth
      // classes against the same free-space pool.
      reservedWorkBytes += workReservationBytes;
      reservedStorageBytes += storageReservationBytes;
      const reserve = BigInt(minFreeBytes);
      if (await pathsShareFilesystem(workRoot, provider.root)) {
        await assertFreeSpace(workRoot, reservedWorkBytes + reservedStorageBytes + reserve);
      } else {
        await assertFreeSpace(workRoot, reservedWorkBytes + reserve);
        await assertFreeSpace(provider.root, reservedStorageBytes + reserve);
      }
      await fsp.mkdir(jobDirectory, { recursive: true, mode: 0o700 });
      activeWorkspaces.add(path.basename(jobDirectory));
      const workspaceCreatedAt = new Date().toISOString();
      await writeWorkspaceManifest(jobDirectory, workRoot, {
        jobId: body.jobId, containerName: null, createdAt: workspaceCreatedAt,
      });
      await fsp.mkdir(inputDirectory, { mode: 0o700 }); await fsp.mkdir(outputDirectory, { mode: 0o700 });
      phase = 'prepare-checkpoint';
      const checkpointPath = path.join(inputDirectory, 'checkpoint.rds');
      if (!/^[0-9a-f]{64}$/.test(String(body.checkpointChecksumSha256 || ''))) {
        throw new Error('Private input checksum does not match the declared checkpoint.');
      }
      const copiedCheckpoint = await copyVerifiedCheckpoint(
        provider,
        body.checkpointStorageKey,
        checkpointPath,
        { checksumSha256: body.checkpointChecksumSha256, sizeBytes: body.checkpointSizeBytes }
      );
      const checkpointChecksumSha256 = copiedCheckpoint.checksumSha256;
      const forbiddenContentHashes = new Set([checkpointChecksumSha256]);
      const privateInputDirectory = path.join(inputDirectory, 'files');
      await fsp.mkdir(privateInputDirectory, { mode: 0o700 });
      const privateInputManifest = [];
      for (const input of privateInputs) {
        const containerFilename = `${input.id}${path.extname(input.originalFilename).toLowerCase()}`;
        const destination = path.join(privateInputDirectory, containerFilename);
        const copied = await copyVerifiedCheckpoint(provider, input.internalStorageKey, destination, {
          checksumSha256: input.checksumSha256,
          sizeBytes: input.sizeBytes,
        });
        forbiddenContentHashes.add(copied.checksumSha256);
        privateInputManifest.push({
          id: input.id,
          name: input.originalFilename,
          filename: containerFilename,
          sizeBytes: input.sizeBytes,
          checksumSha256: input.checksumSha256,
        });
        await fsp.chmod(destination, 0o444);
      }
      await fsp.writeFile(
        path.join(inputDirectory, 'input-manifest.json'),
        JSON.stringify(privateInputManifest),
        { encoding: 'utf8', flag: 'wx', mode: 0o444 }
      );
      await fsp.chmod(privateInputDirectory, 0o555);
      phase = 'prepare-script';
      await fsp.writeFile(path.join(inputDirectory, 'analysis.R'), validated.params.script, { encoding: 'utf8', flag: 'wx' });
      phase = 'prepare-permissions';
      await fsp.chmod(path.join(inputDirectory, 'checkpoint.rds'), 0o444);
      await fsp.chmod(path.join(inputDirectory, 'analysis.R'), 0o444);
      await fsp.chmod(inputDirectory, 0o555);
      containerName = `traceomics-expert-${body.jobId}-${crypto.randomBytes(5).toString('hex')}`;
      await fsp.rm(path.join(jobDirectory, WORKSPACE_MANIFEST), { force: true });
      await writeWorkspaceManifest(jobDirectory, workRoot, {
        jobId: body.jobId, containerName, createdAt: workspaceCreatedAt,
      });
      phase = 'execute';
      const sandboxWrapper = [
        'Rscript --vanilla /app/expert-runner.R',
        'status=$?',
        "printf '%s\\n' \"$status\" > /tmp/traceomics-exit-status",
        'exec tail -f /dev/null',
      ].join('; ');
      await runProcess('docker', [
        'run', '-d', '--name', containerName, '--network', 'none', '--read-only',
        '--label', `${CONTAINER_LABEL}=true`,
        '--label', `${CONTAINER_LABEL}.workspace=${path.basename(jobDirectory)}`,
        '--label', `${CONTAINER_LABEL}.work-root=${workspaceRootHash(workRoot)}`,
        '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '256',
        '--memory', env.EXPERT_R_MEMORY_LIMIT || '8g', '--cpus', env.EXPERT_R_CPU_LIMIT || '2',
        '--user', '10001:10001', '--tmpfs', '/tmp:rw,noexec,nosuid,size=512m',
        '--mount', `type=bind,src=${inputDirectory},dst=/work/input,ro`,
        '--tmpfs', `/work/output:rw,noexec,nosuid,nodev,size=${MAX_OUTPUT_BYTES},nr_inodes=${OUTPUT_TMPFS_INODES},mode=1777`,
        '--entrypoint', '/bin/sh', image, '-c', sandboxWrapper,
      ], { timeoutMs: 30000, signal: abortController.signal });
      const sandboxStatus = await runProcess('docker', [
        'exec', containerName, '/bin/sh', '-c',
        'while [ ! -f /tmp/traceomics-exit-status ]; do sleep 1; done; cat /tmp/traceomics-exit-status',
      ], {
        timeoutMs,
        onTimeout: () => runProcess('docker', ['rm', '-f', containerName], { timeoutMs: 30000 }),
        signal: abortController.signal,
      });
      const sandboxExitCode = Number(String(sandboxStatus.stdout || '').trim());
      if (!Number.isInteger(sandboxExitCode) || sandboxExitCode !== 0) {
        const quotaProbe = await runProcess('docker', [
          'exec', containerName, 'df', '-B1', '--output=avail', '/work/output',
        ], { timeoutMs: 30000 }).catch(() => ({ stdout: '' }));
        const availableOutputBytes = Number(String(quotaProbe.stdout || '').trim().split(/\s+/).pop());
        const logs = await runProcess('docker', ['logs', '--tail', '200', containerName], {
          timeoutMs: 30000,
        }).catch(() => ({ stdout: '', stderr: '' }));
        throw Object.assign(new Error('Sandbox process failed.'), {
          code: Number.isFinite(availableOutputBytes)
              && availableOutputBytes <= Math.floor(MAX_OUTPUT_BYTES / 20)
            ? 'SANDBOX_OUTPUT_QUOTA_EXCEEDED' : 'SANDBOX_SCRIPT_FAILED',
          diagnostic: `${logs.stdout || ''}\n${logs.stderr || ''}`.slice(-32768),
          outputAvailableBytes: Number.isFinite(availableOutputBytes) ? availableOutputBytes : null,
          exitCode: Number.isInteger(sandboxExitCode) ? sandboxExitCode : 1,
        });
      }
      phase = 'extract';
      await assertFreeSpace(workRoot, (2 * MAX_ARCHIVE_BYTES) + minFreeBytes);
      await extractContainerOutputs(containerName, outputDirectory, abortController.signal);
      await runProcess('docker', ['rm', '-f', containerName], { timeoutMs: 30000 });
      containerName = null;
      phase = 'collect';
      const outputs = await collectOutputs(outputDirectory, {
        forbiddenContentHashes: workflowOutputs ? new Set() : forbiddenContentHashes,
      });
      const environmentPath = path.join(jobDirectory, 'environment.lock.json');
      await fsp.writeFile(environmentPath, environmentBytes(environmentManifest), { flag: 'wx', mode: 0o600 });
      environmentStorageKey = `${body.outputStorageKey}.environment.json`;
      const storedEnvironment = await provider.putFileFromPath(environmentPath, environmentStorageKey);
      const environmentArtifact = { internalStorageKey: environmentStorageKey, checksumSha256: storedEnvironment.checksumSha256, sizeBytes: storedEnvironment.sizeBytes };
      if (workflowOutputs) {
        const expected = Object.values(workflowOutputs).map(output => output.name);
        if (outputs.files.length !== expected.length || outputs.files.some(file => !expected.includes(file.relative))) throw new Error('Workflow did not produce exactly its declared outputs.');
        const workflowFiles = [];
        for (const file of outputs.files) {
          const storageKey = `${body.outputStorageKey}-${file.relative}`;
          const stored = await provider.putFileFromPath(path.join(outputDirectory, file.relative), storageKey);
          workflowFiles.push({ name: file.relative, storageKey, sizeBytes: stored.sizeBytes, checksumSha256: stored.checksumSha256 });
        }
        published = true;
        if (!res.destroyed) res.end(JSON.stringify({
          ok: true, saved: true, workflowFiles, scriptSha256: validated.scriptSha256,
          profileId: EXPERT_R_PROFILE.id, checkpointChecksumSha256,
          sandboxImageDigest, resourcePolicyVersion: EXPERT_R_RESOURCE_POLICY_VERSION,
          environment, environmentArtifact,
        }));
        return;
      }
      phase = 'archive';
      await assertFreeSpace(workRoot, MAX_ARCHIVE_BYTES + minFreeBytes);
      const archive = path.join(jobDirectory, 'expert-r-outputs.tar.gz');
      await runProcess('tar', ['-czf', archive, '-C', outputDirectory, '.'], { timeoutMs: 120000 });
      const archiveStat = await fsp.stat(archive);
      if (!archiveStat.isFile() || archiveStat.size > MAX_ARCHIVE_BYTES) {
        throw new Error('Sandbox archive exceeds limits.');
      }
      phase = 'publish';
      await assertFreeSpace(provider.root, archiveStat.size + minFreeBytes);
      const stored = await provider.putFileFromPath(archive, body.outputStorageKey);
      published = true;
      if (!res.destroyed) res.end(JSON.stringify({
        ok: true, saved: true, checksumSha256: stored.checksumSha256,
        sizeBytes: stored.sizeBytes, nFiles: outputs.files.length, outputBytes: outputs.totalBytes,
        files: outputs.files.map((file) => ({
          name: file.relative,
          sizeBytes: file.sizeBytes,
          checksumSha256: file.checksumSha256,
        })),
        scriptSha256: validated.scriptSha256, profileId: EXPERT_R_PROFILE.id,
        checkpointChecksumSha256,
        privateInputs: privateInputManifest.map((input) => ({
          id: input.id,
          sizeBytes: input.sizeBytes,
          checksumSha256: input.checksumSha256,
        })),
        sandboxImageDigest,
        resourcePolicyVersion: EXPERT_R_RESOURCE_POLICY_VERSION,
        environment, environmentArtifact,
      }));
    } catch (error) {
      const exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 'none';
      const outputAvailable = Number.isFinite(error?.outputAvailableBytes)
        ? ` output_available=${error.outputAvailableBytes}` : '';
      console.error(`[expert-r-broker] request failed phase=${phase} code=${safeFailureCode(error)} exit=${exitCode}${outputAvailable}`);
      if (!res.destroyed) {
        const explanation = ownerScriptFailureExplanation(error, phase);
        if (explanation) {
          res.statusCode = 422;
          res.end(JSON.stringify({ error: 'Expert R script failed.', code: 'EXPERT_R_SCRIPT_FAILED', explanation }));
        } else if (['R_ENVIRONMENT_MISMATCH', 'R_ENVIRONMENT_INVALID', 'R_ENVIRONMENT_UNAVAILABLE'].includes(error?.code)) {
          res.statusCode = 409;
          res.end(JSON.stringify({ error: 'The exact R environment for this run is unavailable. Restore its pinned runtime image and package lock before retrying.', code: 'R_ENVIRONMENT_MISMATCH' }));
        } else if (error?.code === 'SANDBOX_STORAGE_PRESSURE') {
          res.statusCode = 503;
          res.end(JSON.stringify({ error: 'Expert R storage capacity is temporarily unavailable.' }));
        } else {
          res.statusCode = 500; res.end(JSON.stringify({ error: 'Expert R sandbox failed.' }));
        }
      }
    } finally {
      if (environmentStorageKey && !published) await provider.remove(environmentStorageKey).catch(() => {});
      active -= 1;
      reservedWorkBytes -= workReservationBytes;
      reservedStorageBytes -= storageReservationBytes;
      if (containerName) {
        await runProcess('docker', ['rm', '-f', containerName], { timeoutMs: 30000 }).catch(() => {});
      }
      await removeJobDirectory(jobDirectory, workRoot).catch(() => {});
      if (jobDirectory) activeWorkspaces.delete(path.basename(jobDirectory));
    }
  });
  server.startReconciliation = async () => {
    await assertExpertRuntimeSecurity(env);
    if (!runtimeVerified) {
      environmentManifest = await discoverExpertRuntimeEnvironment(env);
      environment = summarizeEnvironmentManifest(environmentManifest);
    }
    if (env.PRIVATE_R_KERNEL_ENABLED === 'true' && !kernelRuntime) {
      try {
        const { createPrivateKernelRuntime } = require('./privateKernelRuntime');
        kernelRuntime = createPrivateKernelRuntime({ env, provider, environmentManifest });
        const initialized = await kernelRuntime.initialize();
        privateKernelStatus = { state: 'ready', publications: initialized.publications === true, interrupt: initialized.interrupt === true };
      } catch (error) {
        await kernelRuntime?.close().catch(() => {});
        kernelRuntime = null;
        privateKernelStatus = { state: error.code === 'PRIVATE_KERNEL_UNSUPPORTED' ? 'unsupported' : 'unavailable' };
      }
    }
    await reconcile();
    runtimeVerified = true;
    if (!reconcileTimer) {
      reconcileTimer = setInterval(() => {
        void reconcile().catch((error) => {
          console.error(`[expert-r-broker] orphan reconciliation failed code=${safeFailureCode(error)}`);
        });
      }, reconcileIntervalMs);
      reconcileTimer.unref?.();
    }
  };
  server.once('close', () => {
    if (reconcileTimer) clearInterval(reconcileTimer);
    reconcileTimer = null;
  });
  // Stop owned containers before the close callback confirms broker shutdown.
  const nativeClose = server.close.bind(server);
  server.close = callback => {
    const cleanup = kernelRuntime ? kernelRuntime.close() : Promise.resolve();
    nativeClose(error => {
      cleanup.then(() => callback?.(error), failure => callback?.(error || failure));
    });
    return server;
  };
  return server;
}

if (require.main === module) {
  void (async () => {
    const server = createExpertSandboxBroker();
    const host = String(process.env.EXPERT_R_SANDBOX_HOST || '127.0.0.1').trim();
    if (!isTrustedBrokerBindHost(host)) {
      throw new Error('EXPERT_R_SANDBOX_HOST must be a loopback address.');
    }
    await server.startReconciliation();
    server.listen(Number(process.env.EXPERT_R_SANDBOX_PORT || 8090), host);
    let closing = false;
    const shutdown = () => {
      if (closing) return; closing = true;
      server.close(error => { if (error) process.exitCode = 1; });
    };
    process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
    process.on('message', message => { if (message?.type === 'traceomics:shutdown') shutdown(); });
  })().catch((error) => {
    console.error(`[expert-r-broker] startup failed code=${safeFailureCode(error)}`);
    process.exitCode = 1;
  });
}

module.exports = {
  createExpertSandboxBroker, collectOutputs, removeJobDirectory, ALLOWED_OUTPUT_EXTENSIONS, sha256File,
  assertFreeSpace, pathsShareFilesystem, ownerScriptFailureExplanation, MAX_OUTPUT_BYTES, MAX_ARCHIVE_BYTES,
  isTrustedBrokerBindHost,
  validateExpertRuntimeIsolation, reconcileExpertSandboxWorkRoot,
  assertExpertRuntimeSecurity,
  assertExpertRuntimeImage,
  discoverExpertRuntimeEnvironment,
  writeWorkspaceManifest, workspaceRootHash, WORKSPACE_MANIFEST,
};
