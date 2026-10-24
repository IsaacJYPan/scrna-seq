'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { unusedPort, waitFor } = require('./browser-helpers');
const { seedSavedMaterial } = require('./verify-research-analyses-ui');
const execute = promisify(execFile), root = path.resolve(__dirname, '..');
const assert = (value, message) => { if (!value) throw new Error(message); };

// An actual worker and pinned R runtime generate all typed outputs. No seeded
// table, metric or figure is substituted for a successful workflow execution.
function createTypedSharingProducer(image) {
  const container = 'traceomics-sharing-workflow-' + process.pid + '-' + crypto.randomBytes(5).toString('hex');
  let started = false, workerEnvironment;
  async function stop() {
    if (!started) return;
    await execute('docker', ['rm', '-f', container], { windowsHide: true, timeout: 20000 }); started = false;
  }
  async function configureEnvironment({ env }) {
    const port = await unusedPort(); workerEnvironment = env;
    fs.mkdirSync(env.STORAGE_ROOT, { recursive: true }); fs.mkdirSync(env.VAULT_ROOT, { recursive: true });
    await execute('docker', ['run', '-d', '--rm', '--pull', 'never', '--name', container, '--label', 'traceomics.review=typed-sharing',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--read-only', '--user', '10001:10001', '--pids-limit', '256', '--memory', '2g', '--cpus', '1',
      '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m', '-p', `127.0.0.1:${port}:8000`, '-e', 'PLUMBER_HOST=0.0.0.0', '-e', 'API_TOKEN=' + env.R_API_TOKEN,
      '-e', 'STORAGE_ROOT=/service/storage', '-e', 'VAULT_ROOT=/service/vault', '--mount', `type=bind,source=${env.STORAGE_ROOT},target=/service/storage`,
      '--mount', `type=bind,source=${env.VAULT_ROOT},target=/service/vault`, '--mount', `type=bind,source=${path.join(root, 'r-backend')},target=/app,readonly`,
      '--entrypoint', 'Rscript', image, '/app/run.R'], { cwd: root, windowsHide: true, timeout: 30000 }); started = true;
    await waitFor(async () => {
      try { return (await fetch(`http://127.0.0.1:${port}/health`, { headers: { 'X-API-Token': env.R_API_TOKEN } })).ok; } catch { return false; }
    }, 'The genuine typed-sharing R service did not become ready.', 90000);
    return { R_BACKEND_URL: `http://127.0.0.1:${port}` };
  }
  async function produce({ database, service, owner, colleague, api }) {
    const material = await seedSavedMaterial(database, service, owner, colleague, image);
    const { EXPERT_R_PROFILE } = require('../backend/expertR');
    const source = [
      'stopifnot(ncol(inputs$analysis)==12L,nrow(inputs$analysis)==20L)',
      'write_output("values", list(list(condition="control",cells=6L,flag=FALSE,missing=NA,empty="",zero=0L),',
      '  list(condition="treated",cells=6L,flag=TRUE,missing=NA,empty="",zero=0L)))',
      'write_output("summary",list(cells=ncol(inputs$analysis),features=nrow(inputs$analysis),passed=FALSE,missing=NA,empty="",zero=0L))',
      'counts <- data.frame(condition=c("control","treated"),cells=c(6L,6L))',
      'write_output("figure",ggplot2::ggplot(counts,ggplot2::aes(x=condition,y=cells))+ggplot2::geom_col()+ggplot2::labs(title="Actual typed workflow counts"),width=4,height=3)',
    ].join('\n') + '\n';
    const meaning = {
      values: { role: 'primary', title: 'Condition counts with explicit scalar types' },
      summary: { role: 'diagnostic', title: 'Recorded cell summary', metrics: { cells: { label: 'Retained cells', unit: 'cells' }, features: { label: 'Measured features', unit: 'features' } } },
      figure: { role: 'primary', title: 'Condition counts from the typed workflow' },
    };
    const workflow = { format: 'traceomics-workflow', schemaVersion: 1, id: 'typed-sharing', name: 'Typed sharing acceptance', version: '1.0.0',
      description: 'Actual synthetic R output types and retained meaning; not a biological accuracy benchmark.', runtime: { language: 'r', profileId: EXPERT_R_PROFILE.id }, files: { 'measure.R': source },
      steps: [{ id: 'measure', label: 'Measure typed outputs', entry: 'measure.R', inputs: { analysis: { from: 'input.analysis', type: 'rds' } }, parameters: [],
        outputs: { values: { type: 'table', label: 'Condition scalar table', semantics: meaning.values }, summary: { type: 'metrics', label: 'Typed summary metrics', semantics: meaning.summary }, figure: { type: 'figure', label: 'Typed condition figure', semantics: meaning.figure } } }],
      tabs: [{ id: 'measure', label: 'Measured findings', step: 'measure', plots: [] }] };
    const opened = await api(`/api/workflows/${service.project.id}/open`, { method: 'POST', body: { analysisObjectId: material.checkpoint.reference.analysisObjectId, source: JSON.stringify(workflow) } });
    const submitted = await api(`/api/workflows/${service.project.id}/instances/${opened.id}/run`, { method: 'POST', body: { requestId: crypto.randomUUID(), stepId: 'measure', parameters: {}, seed: 1919 } });
    assert(submitted.state.active?.id, 'The genuine typed workflow did not queue a job.');
    let result;
    try { result = await execute(process.execPath, ['--require', './scripts/enable-job-worker.cjs', 'worker.js', '--once'], {
      cwd: root, windowsHide: true, timeout: 180000, maxBuffer: 65536,
      env: { ...workerEnvironment, ENABLE_JOB_WORKER: 'true', JOB_WORKER_HEALTH_PORT: '0', JOB_WORKER_MIN_FREE_MEMORY_MB: '1', JOB_WORKER_STARTUP_TIMEOUT_MS: '30000' },
    }); } catch { throw new Error('The actual typed workflow worker failed. No result is substituted.'); }
    const job = (await database.query('SELECT status FROM jobs WHERE id=$1', [submitted.state.active.id])).rows[0];
    assert(job.status === 'completed' && /one-shot result: completed/.test(result.stdout), 'The actual typed workflow did not complete.');
    const current = await api(`/api/workflows/${service.project.id}/instances/${opened.id}`), outputs = current.state.results.measure?.outputs;
    assert(outputs?.values.type === 'table' && outputs.summary.type === 'metrics' && outputs.figure.type === 'figure', 'The completed workflow did not retain all exact typed outputs.');
    return { outputs, source, jobId: submitted.state.active.id, workerCompleted: true, meaning };
  }
  return { configureEnvironment, produce, stop };
}

module.exports = { createTypedSharingProducer };
