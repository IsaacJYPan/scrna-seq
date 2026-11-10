'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const ROOT = path.resolve(__dirname, '../..');
function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object')
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map(k => [k, canonical(v[k])])
    );
  return v;
}
function runtimeIdentity(raw) {
  if (
    !raw ||
    raw.schema !== 'traceomics.workflow-runtime.v1' ||
    !/^sha256:[a-f0-9]{64}$/.test(raw.imageDigest || '') ||
    !/^\d+\.\d+\.\d+$/.test(raw.rVersion || '') ||
    !Array.isArray(raw.packages) ||
    !raw.packages.length ||
    raw.packages.length > 1000
  )
    throw Object.assign(new Error('A pinned workflow runtime image and package inventory are required.'), {
      code: 'WORKFLOW_RUNTIME_REQUIRED'
    });
  const names = new Set();
  const packages = raw.packages
    .map(p => {
      if (
        !p ||
        !/^[A-Za-z][A-Za-z0-9.]{0,100}$/.test(p.name || '') ||
        names.has(p.name) ||
        typeof p.version !== 'string' ||
        !/^[0-9][A-Za-z0-9.+-]{0,80}$/.test(p.version)
      )
        throw new Error('Invalid workflow package inventory.');
      names.add(p.name);
      return { name: p.name, version: p.version };
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'en'));
  return { schema: raw.schema, imageDigest: raw.imageDigest, rVersion: raw.rVersion, packages };
}
function configuredRuntime(target = 'local') {
  const file = process.env.TRACEOMICS_WORKFLOW_RUNTIME_FILE;
  if (!file) return null;
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const profile = raw.targets ? raw.targets[target] : raw;
  return profile ? runtimeIdentity(profile) : null;
}
// Broad invalidation is deliberate: newly added production helpers cannot
// silently escape a manually maintained dependency list. Tests/data are excluded.
function sourceManifest() {
  const files = [
    'server.js',
    'worker.js',
    'package.json',
    'package-lock.json',
    'Dockerfile',
    'r-backend/Dockerfile',
    'trusted-methods/catalog.json',
    'trusted-methods/workflows.json'
  ];
  function walk(dir) {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const name = dir + '/' + e.name;
      if (e.isSymbolicLink()) throw new Error('Workflow source cannot contain symlinks.');
      if (e.isDirectory()) {
        if (!['tests', 'node_modules'].includes(e.name)) walk(name);
      } else if (/\.(js|mjs|cjs|R)$/.test(e.name) && !e.name.includes('.test.') && !e.name.startsWith('_'))
        files.push(name);
    }
  }
  for (const dir of ['backend', 'r-backend', 'shared', 'cli']) walk(dir);
  walk('trusted-methods/methods');
  return [...new Set(files)].sort().map(file => ({
    path: file,
    sha256: crypto
      .createHash('sha256')
      .update(fs.readFileSync(path.join(ROOT, file)))
      .digest('hex')
  }));
}
const startupSource = sourceManifest();
function trustManifest() {
  const source = sourceManifest();
  if (JSON.stringify(source) !== JSON.stringify(startupSource))
    throw Object.assign(
      new Error('Workflow source changed after server startup; restart before approving or executing releases.'),
      { code: 'WORKFLOW_SOURCE_CHANGED' }
    );
  return {
    schema: 'traceomics.workflow-trust.v2',
    source,
    runtime: configuredRuntime(),
    slurmRuntime: process.env.TRACEOMICS_WORKFLOW_RUNTIME_FILE ? configuredRuntime('slurm') : null
  };
}
function assertRuntime(expected, actual) {
  if (
    !expected ||
    JSON.stringify(canonical(runtimeIdentity(expected))) !== JSON.stringify(canonical(runtimeIdentity(actual)))
  )
    throw Object.assign(new Error('Workflow runtime differs from the approved image/package inventory.'), {
      code: 'WORKFLOW_RUNTIME_MISMATCH'
    });
}
async function verifyJobTrust(db, job, callR, slurm) {
  if (typeof db.getAgentRunTrustForJob !== 'function') return;
  const plan = await db.getAgentRunTrustForJob(job.id);
  if (!plan) return;
  const release = require('./catalog')
    .currentReleases()
    .find(r => r.id === plan.release.id);
  if (!release || release.digest !== plan.release.digest)
    throw Object.assign(new Error('Approved workflow source changed before execution.'), {
      code: 'WORKFLOW_SOURCE_CHANGED'
    });
  assertRuntime(plan.trust?.runtime, configuredRuntime(job.executionTarget || 'local'));
  if (plan.design) await require('./design').verifyDesign(db, plan);
  for (const input of plan.inputs?.samples || []) {
    const { rows } = await db.query('SELECT sha256 FROM datasets WHERE id=$1 AND project_id=$2', [
      input.datasetId,
      plan.projectId
    ]);
    if (rows[0]?.sha256 !== input.datasetSha256)
      throw Object.assign(new Error('A pinned multi-sample input changed before execution.'), {
        code: 'WORKFLOW_INPUT_CHANGED'
      });
  }
  if (job.executionTarget === 'slurm') {
    if (!slurm?.attestRuntime)
      throw Object.assign(new Error('Slurm runtime attestation is unavailable.'), {
        code: 'WORKFLOW_TARGET_UNQUALIFIED'
      });
    assertRuntime(plan.trust.runtime, await slurm.attestRuntime());
    job.workflowTrust = plan.trust;
    return;
  }
  const response = await callR({ method: 'GET', path: '/runtime/workflow-trust', timeoutMs: 30000 });
  if (response.status !== 200)
    throw Object.assign(new Error('Workflow runtime attestation unavailable.'), {
      code: 'WORKFLOW_RUNTIME_UNAVAILABLE'
    });
  assertRuntime(plan.trust.runtime, response.body);
  // Root build/demo/HPC scripts are pinned by the release but are not shipped
  // in the service image. HPC verifies its staged runner independently.
  const serviceRoots = new Set([
    'plumber.R',
    'run.R',
    'expert-runner.R',
    'private-kernel-init.R',
    'generate-demo-template.R'
  ]);
  const expected = plan.trust.source.filter(
    f =>
      (f.path.startsWith('r-backend/lib/') && f.path.endsWith('.R')) ||
      serviceRoots.has(f.path.replace(/^r-backend\//, ''))
  );
  const actual = new Map((response.body.source || []).map(f => [f.path, f.sha256]));
  if (expected.some(f => actual.get(f.path) !== f.sha256))
    throw Object.assign(new Error('R service code differs from the approved source manifest.'), {
      code: 'WORKFLOW_SOURCE_CHANGED'
    });
}
module.exports = { trustManifest, configuredRuntime, runtimeIdentity, assertRuntime, verifyJobTrust };
