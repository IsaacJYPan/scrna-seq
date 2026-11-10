#!/usr/bin/env node
// Builds installable workflow packages (.pipeline.json) from the trusted
// method library: one package per method plus the compositions declared in
// trusted-methods/workflows.json. The R bytes come straight from the library,
// so the human workbench and agent releases run identical code.
//
//   npm run trusted-workflows:build [-- <output directory>]
//
// Import the files through Pipelines -> Import workflow.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { validateWorkflowPackage, serializeWorkflow } from '../shared/workflowPackage.mjs';

const require = createRequire(import.meta.url);
const { loadLibrary, methodByKey, methodStep, singleMethodPackage } = require('../backend/workflowTrust/trustedMethods.js');
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMPOSITIONS = path.join(ROOT, 'trusted-methods', 'workflows.json');

export function compositionPackage(workflow, library = loadLibrary()) {
  const files = {};
  const steps = [];
  const tabs = [];
  let previous = null;
  for (const step of workflow.steps) {
    const method = methodByKey(step.method);
    if (!method) throw new Error(`${workflow.id}: unknown method ${step.method}.`);
    const upstream = step.from === undefined ? previous : step.from;
    if (upstream) {
      const parent = workflow.steps.find((item) => item.id === upstream);
      if (!parent) throw new Error(`${workflow.id}: ${step.id} reads unknown step ${upstream}.`);
      if (!method.accepts.includes(`trusted:${parent.method}`)) {
        throw new Error(`${workflow.id}: ${method.key} does not declare that it accepts ${parent.method}.`);
      }
    }
    files[method.entry] = method.source;
    steps.push(methodStep(method, { id: step.id, label: step.label || method.title, from: upstream ? `${upstream}.analysis` : 'input.analysis' }));
    tabs.push({ id: step.id, label: (step.label || method.title).slice(0, 100), step: step.id, plots: [] });
    previous = method.outputs.analysis ? step.id : previous;
  }
  return validateWorkflowPackage({
    format: 'traceomics-workflow', schemaVersion: 1, id: workflow.id, name: workflow.name, version: workflow.version,
    description: workflow.description, runtime: { language: 'r', profileId: library.runtimeProfileId }, files, steps, tabs,
  });
}

export function buildAll() {
  const library = loadLibrary({ fresh: true });
  const packages = library.methods.map((method) => validateWorkflowPackage(singleMethodPackage(method, library.runtimeProfileId)));
  const compositions = JSON.parse(fs.readFileSync(COMPOSITIONS, 'utf8'));
  if (compositions.format !== 'traceomics-trusted-workflows' || compositions.schemaVersion !== 1) {
    throw new Error('Unsupported trusted workflow composition file.');
  }
  for (const workflow of compositions.workflows) packages.push(compositionPackage(workflow, library));
  const ids = packages.map((pkg) => pkg.id);
  if (new Set(ids).size !== ids.length) throw new Error('Workflow ids must be unique across methods and compositions.');
  return packages;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = path.resolve(process.argv[2] || path.join(ROOT, 'trusted-methods', 'dist'));
  fs.mkdirSync(out, { recursive: true });
  for (const pkg of buildAll()) {
    const file = path.join(out, `${pkg.id}-${pkg.version}.pipeline.json`);
    fs.writeFileSync(file, serializeWorkflow(pkg));
    console.log(path.relative(process.cwd(), file));
  }
}
