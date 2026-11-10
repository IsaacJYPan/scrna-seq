// Trusted method library: catalog validation, release identity, parameter
// envelopes, the handler's refusal paths, and the workflow-package builder.
// No database or R runtime is needed.

import { describe, it, expect, vi } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const trusted = require('./workflowTrust/trustedMethods');
const { currentReleases, releaseByKey, validateScalar, buildRelease } = require('./workflowTrust/catalog');
const { trustedMethodHandler, compileMethod } = require('./jobs/trustedMethodHandler');

const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');

describe('trusted method library', () => {
  const library = trusted.loadLibrary({ fresh: true });

  it('loads every method with provenance, metrics and existing R source', () => {
    expect(library.methods.length).toBeGreaterThan(0);
    for (const method of library.methods) {
      expect(method.provenance.url).toMatch(/^https:\/\//);
      expect(method.metrics.length).toBeGreaterThan(0);
      expect(method.sourceSha256).toBe(sha(fs.readFileSync(path.join(__dirname, '..', 'trusted-methods', method.entry), 'utf8')));
      for (const name of Object.keys(method.outputs)) expect(method.source).toContain(`write_output("${name}"`);
    }
  });

  it('keeps gene lists, columns and label maps out of the agent search space', () => {
    for (const method of library.methods) {
      for (const parameter of method.parameters.filter((p) => p.type === 'text')) expect(parameter.role).toBe('design');
    }
  });

  it('rejects text that is not a plain list in the declared grammar', () => {
    const p = { key: 'genes', type: 'text', pattern: 'genes', maxLength: 2000 };
    expect(trusted.checkValue(p, 'CD3E,CD4,MS4A1')).toBe('CD3E,CD4,MS4A1');
    for (const bad of ['CD3E; system("id")', 'a,,b', '`x`', 'CD3E\nCD4', '../etc']) {
      expect(() => trusted.checkValue(p, bad)).toThrow();
    }
    const map = { key: 'mapping', type: 'text', pattern: 'labelMap', maxLength: 2000 };
    expect(trusted.checkValue(map, '0=CD14+ Mono;1=Naive CD4 T')).toBeTruthy();
    expect(() => trusted.checkValue(map, '0=x);q(')).toThrow();
  });
});

describe('trusted method releases', () => {
  it('registers one digest-pinned release per method and the Visium pipeline', () => {
    const keys = currentReleases().map((r) => r.key);
    expect(keys).toContain('spatial-seurat');
    for (const method of trusted.loadLibrary().methods) {
      const release = releaseByKey(method.key);
      expect(release.jobType).toBe('trusted.method.v1');
      expect(release.definition.handler.map((h) => h.path)).toContain(`trusted-methods/${method.entry}`);
      expect(release.definition.method.provenance.citation).toBe(method.provenance.citation);
      expect(release.definition.inputs[0].fromReleases.length).toBeGreaterThan(0);
    }
  });

  it('changes release identity when method bytes change', () => {
    const method = trusted.loadLibrary().methods[0];
    const release = releaseByKey(method.key);
    const altered = buildRelease({
      key: method.key, version: method.version, title: 'x', jobType: 'trusted.method.v1',
      handlerFiles: ['backend/workflowTrust/trustedMethods.js'], inputs: [], outputs: [],
      parameterSchema: release.definition.parameterSchema, resources: method.resources, validation: [],
    });
    expect(altered.digest).not.toBe(release.digest);
  });

  it('validates plans with defaults and pins the exact method identity', () => {
    const release = releaseByKey('subset-cells');
    const params = release.validateParameters({ mode: 'remove' });
    expect(params).toMatchObject({ method: 'subset-cells', methodVersion: '1.0.0', values: { mode: 'remove', column: 'scDblFinder.class' } });
    expect(params.methodSourceSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(() => release.validateParameters({ script: 'q()' })).toThrow(/Unknown parameter/);
    expect(() => validateScalar(release.definition.parameterSchema, 'values', 'a;b')).toThrow();
  });

  it('compiles with the workflow-package wrapper and declared outputs only', () => {
    const method = trusted.methodByKey('recluster-integrate');
    const compiled = compileMethod(method, trusted.resolveMethodParameters(method, { seed: 7 }).values);
    expect(compiled.seed).toBe(7);
    expect(compiled.script).toContain('inputs[["analysis"]] <- obj');
    expect(compiled.script.endsWith(method.source)).toBe(true);
    expect(Object.keys(compiled.outputs).sort()).toEqual(Object.keys(method.outputs).sort());
  });
});

describe('trusted.method.v1 handler', () => {
  const method = trusted.methodByKey('subset-cells');
  const base = () => ({
    job: { id: 'job_abc', projectId: 'proj_1', analysisObjectId: 'obj_1', parameters: trusted.resolveMethodParameters(method, {}) },
    heartbeat: vi.fn(async () => {}),
    log: vi.fn(async () => {}),
    getOwnedAnalysisObject: vi.fn(async () => ({ id: 'obj_1' })),
  });

  it('refuses a job whose method bytes changed after planning', async () => {
    const ctx = base();
    ctx.job.parameters = { ...ctx.job.parameters, methodSourceSha256: '0'.repeat(64) };
    await expect(trustedMethodHandler(ctx)).rejects.toMatchObject({ code: 'TRUSTED_METHOD_CHANGED' });
    expect(ctx.getOwnedAnalysisObject).not.toHaveBeenCalled();
  });

  it('refuses extra job fields such as a script', async () => {
    const ctx = base();
    ctx.job.parameters = { ...ctx.job.parameters, script: 'q()' };
    await expect(trustedMethodHandler(ctx)).rejects.toMatchObject({ code: 'INVALID_PARAMETERS' });
  });

  it('fails clearly without the isolated runtime', async () => {
    const ctx = base();
    await expect(trustedMethodHandler(ctx)).rejects.toMatchObject({ code: 'EXPERT_R_UNAVAILABLE' });
  });
});

describe('trusted workflow packages', () => {
  it('builds valid packages for every method and composition', async () => {
    const { buildAll } = await import('../scripts/build-trusted-workflows.mjs');
    const { parseLegacyExecutableWorkflowPackage } = await import('../shared/recipePackage.mjs');
    const packages = buildAll();
    expect(packages.length).toBeGreaterThan(trusted.loadLibrary().methods.length);
    for (const pkg of packages) {
      const parsed = parseLegacyExecutableWorkflowPackage(JSON.stringify(pkg), { environmentProfiles: [pkg.runtime.profileId] });
      expect(parsed.id).toBe(pkg.id);
      for (const [file, source] of Object.entries(pkg.files)) {
        expect(source).toBe(fs.readFileSync(path.join(__dirname, '..', 'trusted-methods', file), 'utf8'));
      }
    }
  });

  it('rejects compositions that chain methods the catalog does not declare', async () => {
    const { compositionPackage } = await import('../scripts/build-trusted-workflows.mjs');
    expect(() => compositionPackage({
      id: 'bad-chain', name: 'Bad', version: '1.0.0', description: 'x',
      steps: [{ id: 'label', method: 'label-clusters' }, { id: 'doublets', method: 'doublets-scdblfinder' }],
    })).toThrow(/does not declare/);
  });
});
