import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { spawn } from 'child_process';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';

const config = require('./config');
const db = require('./pgDatabase');
const { STORAGE_PROBE_PREFIX, STORAGE_PROBE_CONTENT } = require('./rRuntime');

const CONFIGURED = config.hasPostgresConnection();
const R_TOKEN = 'standalone-process-test-token-0000000000000000';
let rServer;
let rAddress;
let storageRoot;
const liveChildren = new Set();
const extraRServers = new Set();

function startIsolatedFakeR(onHealth) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.headers['x-api-token'] !== R_TOKEN) {
        res.statusCode = 403;
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      if (req.url === '/internal/worker-readiness') {
        const nonce = String(req.headers['x-storage-probe-nonce'] || '');
        const probePath = path.join(storageRoot, `${STORAGE_PROBE_PREFIX}${nonce}`);
        const storageShared = /^[0-9a-f]{32}$/.test(nonce)
          && fs.existsSync(probePath)
          && fs.readFileSync(probePath, 'utf8') === STORAGE_PROBE_CONTENT;
        if (!storageShared) res.statusCode = 503;
        res.end(JSON.stringify({
          status: storageShared ? 'ok' : 'not_ready',
          storage_shared: storageShared,
          runtime_session_id: storageShared ? `isolated-r-${server.address().port}` : null,
        }));
        return;
      }
      if (req.url === '/health') {
        onHealth(res);
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'not found' }));
    });
    server.listen(0, '127.0.0.1', () => {
      extraRServers.add(server);
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function startFakeR() {
  return new Promise((resolve) => {
    rServer = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.headers['x-api-token'] !== R_TOKEN) {
        res.statusCode = 403;
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      if (req.url === '/internal/worker-readiness') {
        const nonce = String(req.headers['x-storage-probe-nonce'] || '');
        const probePath = path.join(storageRoot, `${STORAGE_PROBE_PREFIX}${nonce}`);
        const storageShared = /^[0-9a-f]{32}$/.test(nonce)
          && fs.existsSync(probePath)
          && fs.readFileSync(probePath, 'utf8') === STORAGE_PROBE_CONTENT;
        if (!storageShared) res.statusCode = 503;
        res.end(JSON.stringify({
          status: storageShared ? 'ok' : 'not_ready',
          storage_shared: storageShared,
          runtime_session_id: storageShared ? 'process-test-r-instance-0001' : null,
        }));
        return;
      }
      if (req.url === '/health') {
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'not found' }));
    });
    rServer.listen(0, '127.0.0.1', () => {
      rAddress = rServer.address();
      resolve();
    });
  });
}

function workerEnv(extra = {}) {
  return {
    ...process.env,
    NODE_ENV: 'test',
    ENABLE_JOB_WORKER: 'true',
    R_RUNTIME_MODE: 'external',
    R_BACKEND_URL: `http://127.0.0.1:${rAddress.port}`,
    R_API_TOKEN: R_TOKEN,
    STORAGE_ROOT: storageRoot,
    VAULT_ROOT: path.join(storageRoot, 'vault'),
    JOB_WORKER_HEALTH_PORT: '0',
    JOB_WORKER_MIN_FREE_MEMORY_MB: '1',
    JOB_WORKER_POLL_MS: '10',
    JOB_WORKER_LEASE_SECONDS: '10',
    JOB_WORKER_STARTUP_TIMEOUT_MS: '5000',
    ...extra,
  };
}

function runProcess(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env: options.env || process.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`child process timed out\nstdout: ${Buffer.concat(stdout).toString('utf8')}\nstderr: ${Buffer.concat(stderr).toString('utf8')}`));
    }, options.timeoutMs || 20000);
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timeout);
      resolve({
        code,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}

function runWorkerOnce(extraEnv = {}) {
  return runProcess([path.join(process.cwd(), 'worker.js'), '--once'], {
    env: workerEnv(extraEnv),
  });
}

function startLockHolder({ slot = 1, poolSize = 1 } = {}) {
  return new Promise((resolve, reject) => {
    const script = [
      "const db=require('./backend/pgDatabase');",
      'let lock;',
      `db.acquireStandaloneWorkerLock({slot:${slot},poolSize:${poolSize}}).then((owned)=>{lock=owned;console.log('LOCK_READY');`,
      "process.on('message',async(m)=>{if(m&&m.type==='stop'){await lock.release();await db.close();process.exit(0);}});",
      "}).catch((e)=>{console.error(e&&e.code||'LOCK_FAILED');process.exit(2);});",
    ].join('');
    const child = spawn(process.execPath, ['-e', script], {
      cwd: process.cwd(), env: workerEnv(), windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    liveChildren.add(child);
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      reject(new Error(`lock holder startup timed out: ${stderr}`));
    }, 10000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
      if (!settled && stdout.includes('LOCK_READY')) {
        settled = true;
        clearTimeout(timeout);
        resolve({
          child,
          stop: () => new Promise((stopResolve, stopReject) => {
            const stopTimeout = setTimeout(() => {
              child.kill('SIGTERM');
              stopReject(new Error('lock holder shutdown timed out'));
            }, 10000);
            child.once('exit', (code) => {
              clearTimeout(stopTimeout);
              liveChildren.delete(child);
              if (code === 0) stopResolve();
              else stopReject(new Error(`lock holder exited ${code}: ${stderr}`));
            });
            child.send({ type: 'stop' });
          }),
        });
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.once('exit', (code) => {
      liveChildren.delete(child);
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(new Error(`lock holder exited ${code}: ${stderr}`));
      }
    });
  });
}

beforeAll(async () => {
  if (!CONFIGURED) return;
  storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scrna-worker-process-'));
  await startFakeR();
});

beforeEach(async () => {
  if (!CONFIGURED) return;
  await db.resetSchemaForTests();
});

afterEach(async () => {
  for (const child of [...liveChildren]) {
    child.kill('SIGTERM');
    liveChildren.delete(child);
  }
});

afterAll(async () => {
  if (!CONFIGURED) return;
  for (const server of [...extraRServers]) {
    await new Promise((resolve) => server.close(resolve));
    extraRServers.delete(server);
  }
  if (rServer) await new Promise((resolve) => rServer.close(resolve));
  await db.close();
  if (storageRoot) fs.rmSync(storageRoot, { recursive: true, force: true });
});

describe.skipIf(!CONFIGURED)('standalone worker OS-process coordination', () => {
  it('allows distinct bounded-pool slots while refusing a duplicate slot owner', async () => {
    const slotOne = await startLockHolder({ slot: 1, poolSize: 2 });
    const slotTwo = await startLockHolder({ slot: 2, poolSize: 2 });

    const duplicateScript = [
      "const db=require('./backend/pgDatabase');",
      'db.acquireStandaloneWorkerLock({slot:2,poolSize:2})',
      ".then(async(lock)=>{await lock.release();await db.close();process.exit(0);})",
      ".catch(async(error)=>{console.error(error&&error.code||'LOCK_FAILED');await db.close();process.exit(2);});",
    ].join('');
    const duplicate = await runProcess(['-e', duplicateScript], { env: workerEnv() });
    expect(duplicate.code).toBe(2);
    expect(duplicate.stderr).toContain('WORKER_TOPOLOGY_LOCKED');

    await slotTwo.stop();
    await slotOne.stop();
  }, 30000);

  it('runs two R jobs concurrently in distinct worker slots routed to distinct R services', async () => {
    const pendingHealth = [];
    let maxOverlap = 0;
    const onHealth = (response) => {
      const fallback = setTimeout(() => {
        const index = pendingHealth.findIndex((entry) => entry.response === response);
        if (index >= 0) pendingHealth.splice(index, 1);
        if (!response.writableEnded) response.end(JSON.stringify({ status: 'ok' }));
      }, 5000);
      pendingHealth.push({ response, fallback });
      maxOverlap = Math.max(maxOverlap, pendingHealth.length);
      if (pendingHealth.length === 2) {
        for (const entry of pendingHealth.splice(0)) {
          clearTimeout(entry.fallback);
          entry.response.end(JSON.stringify({ status: 'ok' }));
        }
      }
    };
    const laneOne = await startIsolatedFakeR(onHealth);
    const laneTwo = await startIsolatedFakeR(onHealth);
    try {
      const user = await db.createUser('process-pool@example.com', 'password123', 'Process Pool');
      const first = await db.createJobForUser(user.id, { jobType: 'r.runtime.check' });
      const second = await db.createJobForUser(user.id, { jobType: 'r.runtime.check' });

      const results = await Promise.all([
        runWorkerOnce({
          JOB_WORKER_POOL_SIZE: '2', JOB_WORKER_POOL_SLOT: '1', R_BACKEND_URL: laneOne.url,
        }),
        runWorkerOnce({
          JOB_WORKER_POOL_SIZE: '2', JOB_WORKER_POOL_SLOT: '2', R_BACKEND_URL: laneTwo.url,
        }),
      ]);

      expect(results.every((result) => result.code === 0), JSON.stringify(results, null, 2)).toBe(true);
      expect(maxOverlap).toBe(2);
      expect((await db.getJobForUser(first.id, user.id)).status).toBe('completed');
      expect((await db.getJobForUser(second.id, user.id)).status).toBe('completed');
      expect((await db.getWorkerJob(first.id)).workerId).not.toBe((await db.getWorkerJob(second.id)).workerId);
    } finally {
      await Promise.all([laneOne.server, laneTwo.server].map((server) => new Promise((resolve) => {
        server.close(resolve);
        extraRServers.delete(server);
      })));
    }
  }, 30000);

  it('refuses a second standalone process while the global worker slot is held', async () => {
    const user = await db.createUser('process-one@example.com', 'password123', 'Process One');
    const job = await db.createJobForUser(user.id, { jobType: 'generic' });
    const holder = await startLockHolder();

    const refused = await runWorkerOnce();
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('WORKER_TOPOLOGY_LOCKED');
    expect((await db.getWorkerJob(job.id)).attempts).toBe(0);
    expect((await db.getJobForUser(job.id, user.id)).status).toBe('queued');

    await holder.stop();
    const drained = await runWorkerOnce();
    expect(drained.code, JSON.stringify(drained, null, 2)).toBe(0);
    expect(drained.stdout).toContain('one-shot result: completed');
    const after = await db.getJobForUser(job.id, user.id);
    const internal = await db.getWorkerJob(job.id);
    expect(after.status).toBe('completed');
    expect(internal.attempts).toBe(1);
    expect(internal.claimToken).toBeNull();
  }, 30000);

  it('one supported worker process drains queued jobs sequentially without duplicates', async () => {
    const user = await db.createUser('process-two@example.com', 'password123', 'Process Two');
    const first = await db.createJobForUser(user.id, { jobType: 'generic' });
    const second = await db.createJobForUser(user.id, { jobType: 'generic' });

    const results = [await runWorkerOnce(), await runWorkerOnce()];
    expect(results.every((result) => result.code === 0), JSON.stringify(results, null, 2)).toBe(true);
    expect((await db.getJobForUser(first.id, user.id)).status).toBe('completed');
    expect((await db.getJobForUser(second.id, user.id)).status).toBe('completed');
    expect((await db.getWorkerJob(first.id)).attempts).toBe(1);
    expect((await db.getWorkerJob(second.id)).attempts).toBe(1);
  }, 30000);

  it('recovers a claim from a crashed process after lease expiry and rejects its stale token', async () => {
    const user = await db.createUser('process-crash@example.com', 'password123', 'Process Crash');
    const job = await db.createJobForUser(user.id, { jobType: 'generic' });
    await db.setJobScheduling(job.id, { maxAttempts: 2 });
    const script = [
      "const db=require('./backend/pgDatabase');",
      "db.acquireStandaloneWorkerLock()",
      ".then(()=>db.claimNextJob('pool-1:worker_crashed_process',{leaseSeconds:1,now:'2030-01-01 00:00:00'}))",
      ".then((job)=>{process.stdout.write(job.claimToken);process.exit(job?0:2)})",
      ".catch(()=>process.exit(3));",
    ].join('');
    const crashed = await runProcess(['-e', script], { env: workerEnv() });
    expect(crashed.code).toBe(0);
    const staleToken = crashed.stdout;
    expect(staleToken).toMatch(/^wct_/);
    expect((await db.getWorkerJob(job.id)).status).toBe('running');

    const refused = await runWorkerOnce();
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('WORKER_ACTIVE_CLAIM_EXISTS');
    await db.reapExpiredJobs({ now: '2030-01-01 00:00:02' });
    const recovered = await runWorkerOnce();
    expect(recovered.code, JSON.stringify(recovered, null, 2)).toBe(0);
    const after = await db.getWorkerJob(job.id);
    expect(after.status).toBe('completed');
    expect(after.attempts).toBe(2);
    await expect(db.heartbeatJob(job.id, 'pool-1:worker_crashed_process', staleToken))
      .rejects.toMatchObject({ code: 'CLAIM_LOST' });
    await expect(db.completeJobByWorker(job.id, 'pool-1:worker_crashed_process', staleToken))
      .rejects.toMatchObject({ code: 'CLAIM_LOST' });
  }, 30000);
});
