'use strict';

// Disposable real R compute for the selected-findings sharing acceptance run.
// Tiny synthetic counts establish producer independence, not scientific validity.
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { createDesktopTunnelServiceFixture } = require('./desktop-tunnel-service-fixture.cjs');

const root = path.resolve(__dirname, '..');
const assert = (value, message) => { if (!value) throw new Error(message); };
async function reservePort() {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function createAnalysisSharingRuntimeFixture({ artifactDirectory, configureProjectEnvironment }) {
  const image = process.env.EXPERT_R_SANDBOX_IMAGE;
  assert(/^(?:[^\s@]+@)?sha256:[a-f0-9]{64}$/.test(image || ''), 'Set EXPERT_R_SANDBOX_IMAGE to the reviewed immutable R image.');
  const output = path.resolve(artifactDirectory), reportRoot = path.join(root, 'playwright', 'report');
  assert(output.startsWith(reportRoot + path.sep), 'Sharing acceptance must use owned ignored report storage.');
  const port = await reservePort(), token = crypto.randomBytes(32).toString('hex');
  const work = path.join(output, 'broker-work'), previousStorage = process.env.STORAGE_ROOT;
  let service, broker, closed = false;
  async function stopCompute() {
    if (!broker) return;
    const current = broker; broker = null;
    current.closeAllConnections?.();
    await new Promise((resolve, reject) => current.close(error => error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve()));
  }
  async function stop() {
    if (closed) return; closed = true;
    try { await stopCompute(); }
    finally {
      try { await service?.stop(); }
      finally {
        if (previousStorage === undefined) delete process.env.STORAGE_ROOT; else process.env.STORAGE_ROOT = previousStorage;
        assert(path.resolve(work).startsWith(output + path.sep), 'Invalid owned R work cleanup target.');
        await fs.rm(work, { recursive: true, force: true });
      }
    }
  }
  try {
    service = await createDesktopTunnelServiceFixture({ artifactDirectory: output,
      webEnvironment: { AUTH_RATE_LIMIT_MAX: '100', EXPERT_R_ENABLED: 'true', EXPERT_R_ACCESS_POLICY: 'project-roles',
        EXPERT_R_SANDBOX_URL: `http://127.0.0.1:${port}`, EXPERT_R_SANDBOX_TOKEN: token }, configureProjectEnvironment });
    process.env.STORAGE_ROOT = service.storageRoot;
    broker = require('../backend/expertSandboxBroker').createExpertSandboxBroker({ ...process.env, NODE_ENV: 'test',
      EXPERT_R_SANDBOX_IMAGE: image, EXPERT_R_SANDBOX_TOKEN: token, EXPERT_R_SANDBOX_WORK_ROOT: work,
      PRIVATE_R_KERNEL_ENABLED: 'true', PRIVATE_R_KERNEL_IDLE_SECONDS: '900', EXPERT_R_MEMORY_LIMIT: '2g', EXPERT_R_CPU_LIMIT: '1' });
    await broker.startReconciliation();
    await new Promise(resolve => broker.listen(port, '127.0.0.1', resolve));
    const response = await fetch(`http://127.0.0.1:${port}/capabilities`, { headers: { Authorization: 'Bearer ' + token } });
    const capability = await response.json();
    assert(response.ok && capability.persistentKernel && capability.persistentKernelPublications && capability.environment,
      'The pinned real R environment did not verify kernel and saved-output support.');
    return { ...service, image, environment: capability.environment, stopCompute, stop };
  } catch (error) { await stop(); throw error; }
}

const source = [
  'suppressPackageStartupMessages({library(Seurat);library(Matrix)})',
  'set.seed(1919)',
  'counts <- matrix(rpois(20L * 12L, 3), nrow=20L, ncol=12L)',
  'rownames(counts) <- paste0("Gene", seq_len(nrow(counts)))',
  'colnames(counts) <- paste0("Cell", seq_len(ncol(counts)))',
  'obj <- CreateSeuratObject(Matrix(counts, sparse=TRUE))',
  'obj$condition <- rep(c("control", "treated"), each=6L)',
  'stopifnot(ncol(obj) == 12L, nrow(obj) == 20L)',
  'condition_summary <- as.data.frame(table(obj$condition))',
  'names(condition_summary) <- c("condition", "cells")',
  'stopifnot(identical(as.integer(condition_summary$cells), c(6L, 6L)))',
  'display_table(condition_summary, name="Synthetic condition counts")',
  'barplot(condition_summary$cells, names.arg=condition_summary$condition,',
  '        ylab="Cells", main="Synthetic fixture: 12 cells across two conditions")',
].join('\n') + '\n';

// api is an authenticated page-bound production fetch helper. Saving output
// uses the existing private-kernel publication service and actual serializers.
async function produceSharingFindings(api, projectId, environment) {
  const base = `/api/private-r-kernels/${projectId}`;
  const kernel = await api(base, { method: 'POST', body: { requestId: crypto.randomUUID(), workspaceId: 'sharing-acceptance', environment, inputs: [] } });
  assert(kernel.status === 'ready' && kernel.id, 'A genuine producing R kernel did not become ready.');
  const execution = await api(`${base}/${kernel.id}/executions`, { method: 'POST', body: { requestId: crypto.randomUUID(), source } });
  assert(execution.status === 'completed' && execution.result?.figures.length === 1
    && JSON.stringify(execution.result.tables[0]?.rows) === JSON.stringify([['control', 6], ['treated', 6]]),
  'Actual R did not produce the selected synthetic counts and figure.');
  const table = await api(`${base}/${kernel.id}/publications`, { method: 'POST', body: {
    requestId: crypto.randomUUID(), type: 'table', binding: 'condition_summary', name: 'Computed condition counts' } });
  const figure = await api(`${base}/${kernel.id}/publications`, { method: 'POST', body: {
    requestId: crypto.randomUUID(), type: 'figure', executionId: execution.id, figureIndex: 0, name: 'Computed condition figure' } });
  assert(table.publication?.status === 'completed' && figure.publication?.status === 'completed'
    && table.version?.format.id === 'org.ietf.csv' && figure.version?.format.id === 'org.w3.png',
  'Actual saved R outputs did not yield verified CSV and PNG artifact versions.');
  return { kernel, executionId: execution.id, table: table.version, figure: figure.version, source,
    async stop() {
      const stopped = await api(`${base}/${kernel.id}/stop`, { method: 'POST' });
      assert(stopped.status === 'stopped' && stopped.memoryState === 'lost', 'The genuine producing kernel did not stop with memory lost.');
      return stopped;
    } };
}

module.exports = { createAnalysisSharingRuntimeFixture, produceSharingFindings };
