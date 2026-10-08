import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  artifactPortsCompatible, validateAnalysisRun, validateArtifactVersion,
  validateOperationVersion,
} from '../shared/analysisModel.mjs';
import {
  adaptWorkflowV1, assessRecipeExecutability, inspectRecipePackage,
  normalizeRecipePackage, parseLegacyExecutableWorkflowPackage, parseRecipePackage,
  resolveRecipeParameters, validateRecipePackage,
} from '../shared/recipePackage.mjs';
import { parseWorkflowPackage, serializeWorkflow, WORKFLOW_LIMITS } from '../shared/workflowPackage.mjs';

const names = ['standard-seurat', 'zero-filter-edit', 'condition-pseudobulk', 'lr-subset', 'tissue-image-inspection', 'exploratory-r-promotion'];
const fixture = name => JSON.parse(readFileSync(new URL(`../examples/analysis-model/${name}.json`, import.meta.url), 'utf8'));
const clone = value => JSON.parse(JSON.stringify(value));
const legacy = () => ({
  format: 'traceomics-workflow', schemaVersion: 1, id: 'summary', name: 'Summary', version: '1.0.0', description: 'Count cells.',
  runtime: { language: 'r', profileId: 'test-profile' }, files: { 'summary.R': 'write_output("summary", list(cells = ncol(inputs$analysis)))' },
  steps: [{ id: 'summary', label: 'Summary', entry: 'summary.R', inputs: { analysis: { from: 'input.analysis', type: 'rds' } }, parameters: [], outputs: { summary: { type: 'metrics', label: 'Cell count' } } }],
  tabs: [{ id: 'summary', label: 'Summary', step: 'summary', plots: [] }],
});

describe('scientific analysis records', () => {
  it.each(names)('models %s with exact inputs, operations, environment and version boundaries', name => {
    const example = fixture(name);
    expect(example.illustrative).toBe(true);
    expect(validateRecipePackage(example.recipe)).toEqual(example.recipe);
    example.artifactVersions.forEach(record => expect(validateArtifactVersion(record)).toEqual(record));
    example.operationVersions.forEach(record => expect(validateOperationVersion(record)).toEqual(record));
    example.runs.forEach(record => expect(validateAnalysisRun(record)).toEqual(record));
    const ids = new Set(example.artifactVersions.map(record => record.versionId));
    [...example.versionBoundaries.inputVersions, ...example.versionBoundaries.outputVersions].forEach(id => expect(ids.has(id)).toBe(true));
    expect(new Set(example.artifactVersions.map(record => record.versionId)).size).toBe(example.artifactVersions.length);
    expect(example.runs.every(run => !run.replay.complete)).toBe(true);
  });
  it('preserves the exploratory execution and declares clean inputs on promotion', () => {
    const example = fixture('exploratory-r-promotion');
    expect(example.runs[0]).toMatchObject({ id: 'exploratory-origin-run', outputs: {}, kernel: { generation: 1, order: 7 } });
    expect(example.operationVersions[0]).toMatchObject({ originRunId: 'exploratory-origin-run', method: { state: 'isolated' } });
    expect(example.runs[1].kernel).toBeNull();
  });
  it.each([
    ['wrong-project input', run => { run.inputs.analysis.projectId = 'other-project'; }, /another project/],
    ['wrong-project design', run => { run.design = { ...run.inputs.analysis, projectId: 'other-project' }; }, /another project/],
    ['partial publication', run => { run.status = 'failed'; }, /only successful/],
    ['missing environment', run => { run.environment = null; }, /exact environment/],
    ['reversed time', run => { run.finishedAt = '2026-10-07T00:00:00Z'; }, /precedes/],
    ['false replay claim', run => { run.replay.complete = true; }, /missing requirements/],
    ['unbounded kernel order', run => { run.kernel = { id: 'kernel', generation: 0, order: 1 }; }, /generation/],
  ])('rejects %s', (_label, change, message) => {
    const run = fixture('exploratory-r-promotion').runs[1];
    change(run);
    expect(() => validateAnalysisRun(run)).toThrow(message);
  });
  it('keeps storage references opaque and rejects unnamespaced format metadata', () => {
    const artifact = fixture('standard-seurat').artifactVersions[0];
    artifact.storageRef = '/srv/private/project/object.rds';
    expect(() => validateArtifactVersion(artifact)).toThrow(/stable identifier/);
    artifact.storageRef = 'storage-reference'; artifact.format.metadata = { assay: 'RNA' };
    expect(() => validateArtifactVersion(artifact)).toThrow(/namespaced/);
  });
});

describe('recipe package v2', () => {
  it('supports zero input/output operations and zero-step reference recipes', () => {
    const recipe = fixture('exploratory-r-promotion').recipe;
    recipe.inputs = {}; recipe.steps[0].inputs = {}; recipe.steps[0].bindings = {}; recipe.steps[0].outputs = {};
    recipe.steps[0].ui.results = []; recipe.files['steps/count-cells.R'] = 'message("Inspection recorded")';
    expect(validateRecipePackage(recipe).steps[0].outputs).toEqual({});
    recipe.steps = []; recipe.environments = {}; recipe.files = {};
    expect(validateRecipePackage(recipe).steps).toEqual([]);
  });
  it('supports a root export and requires the exported port to match', () => {
    const recipe = fixture('exploratory-r-promotion').recipe;
    recipe.outputs = { input: { port: clone(recipe.inputs.analysis), from: { kind: 'input', port: 'analysis' } } };
    expect(validateRecipePackage(recipe).outputs.input.from.kind).toBe('input');
    recipe.outputs.input.port.type = 'image';
    expect(() => validateRecipePackage(recipe)).toThrow(/exported output does not match/);
  });
  it.each([
    ['unknown version', recipe => { recipe.schemaVersion = 99; }, /unsupported schema/],
    ['duplicate IDs', recipe => { recipe.steps.push(clone(recipe.steps[0])); }, /duplicate identifiers/],
    ['reserved ID', recipe => { recipe.steps[0].id = 'input'; }, /reserved/],
    ['missing root', recipe => { recipe.steps[0].bindings.analysis.port = 'missing'; }, /root input missing/],
    ['missing producer', recipe => { recipe.steps[0].bindings.analysis = { kind: 'step', step: 'missing', port: 'analysis' }; }, /does not exist/],
    ['cycle', recipe => { recipe.steps[0].outputs.analysis = clone(recipe.inputs.analysis); recipe.steps[0].bindings.analysis = { kind: 'step', step: recipe.steps[0].id, port: 'analysis' }; }, /cycle/],
    ['unbound input', recipe => { delete recipe.steps[0].bindings.analysis; }, /required input is not bound/],
    ['type mismatch', recipe => { recipe.steps[0].inputs.analysis.type = 'image'; }, /does not satisfy/],
    ['format mismatch', recipe => { recipe.steps[0].inputs.analysis.format.version = '6'; }, /does not satisfy/],
    ['missing entry', recipe => { recipe.steps[0].operation.entry = 'missing.R'; }, /does not exist/],
    ['missing helper', recipe => { recipe.steps[0].operation.helpers = ['helpers/missing.R']; }, /does not exist/],
    ['missing lock', recipe => { recipe.environments.research.lockfile = 'environment/missing.lock'; }, /does not exist/],
    ['path traversal', recipe => { recipe.steps[0].operation.entry = '../private.R'; }, /without traversal/],
    ['undeclared environment', recipe => { recipe.steps[0].environment = 'missing'; }, /environment does not exist/],
    ['wrong language', recipe => { recipe.environments.research.runtime.language = 'python'; }, /R environment/],
    ['unused file', recipe => { recipe.files['unused.R'] = 'print(1)'; }, /unused/],
    ['untrusted permission', recipe => { recipe.package.permissions = ['read-host-files']; }, /unsupported permission/],
  ])('rejects %s with an actionable path', (_label, change, message) => {
    const recipe = fixture('exploratory-r-promotion').recipe;
    change(recipe);
    expect(() => validateRecipePackage(recipe)).toThrow(message);
  });
  it('requires bounded compatible collections and explicit list-filter semantics', () => {
    const recipe = fixture('condition-pseudobulk').recipe;
    delete recipe.inputs.analyses.maxItems;
    expect(() => validateRecipePackage(recipe)).toThrow(/maxItems/);
    recipe.inputs.analyses.maxItems = 25;
    expect(() => validateRecipePackage(recipe)).toThrow(/collection bounds/);
    const lr = fixture('lr-subset').recipe;
    delete lr.steps[0].parameters.pairs.empty;
    expect(() => validateRecipePackage(lr)).toThrow(/empty selection/);
  });
  it('does not allow an optional producer to satisfy a required input', () => {
    const recipe = fixture('lr-subset').recipe;
    delete recipe.steps[0].inputs.design.optional;
    expect(() => validateRecipePackage(recipe)).toThrow(/optionality/);
    expect(artifactPortsCompatible(recipe.inputs.design, recipe.steps[0].inputs.design)).toBe(false);
  });
  it('resolves defaults and validates replacement values without editing the recipe', () => {
    const step = fixture('lr-subset').recipe.steps[0];
    expect(resolveRecipeParameters(step)).toEqual({ pairs: [] });
    const pairs = [{ ligand: 'CXCL12', receptor: 'CXCR4' }];
    expect(resolveRecipeParameters(step, { pairs })).toEqual({ pairs });
    expect(step.parameters.pairs.default).toEqual([]);
    expect(() => resolveRecipeParameters(step, { pairs: [['CXCL12', 'CXCR4']] })).toThrow(/must be an object/);
    expect(() => resolveRecipeParameters(step, { pairs: [...pairs, ...pairs] })).toThrow(/duplicate/);
    expect(() => resolveRecipeParameters(step, { unknown: 1 })).toThrow(/unknown/);
  });
  it('rejects duplicate JSON keys and unknown future schemas at the admission boundary', () => {
    expect(() => parseRecipePackage('{"schemaVersion":1,"schemaVersion":2}')).toThrow(/Duplicate JSON key/);
    expect(() => parseRecipePackage('{"format":"traceomics-workflow","schemaVersion":3}')).toThrow(/supported versions are 1 and 2/);
    expect(() => normalizeRecipePackage({ format: 'other-format', schemaVersion: 2 })).toThrow(/unsupported/);
  });
});

describe('workflow compatibility and executor admission', () => {
  it('adapts the current format but preserves its worker-facing shape exactly', () => {
    const original = legacy();
    const adapted = adaptWorkflowV1(original);
    expect(adapted).toMatchObject({ schemaVersion: 2, inputs: { analysis: { type: 'object' } } });
    expect(adapted.steps[0].bindings).toEqual({ analysis: { kind: 'input', port: 'analysis' } });
    const source = serializeWorkflow(original);
    expect(parseLegacyExecutableWorkflowPackage(source)).toEqual(parseWorkflowPackage(source));
    expect(inspectRecipePackage(source, { environmentProfiles: ['test-profile'] })).toMatchObject({ package: original, sourceSchemaVersion: 1, execution: { executable: true } });
    expect(original.schemaVersion).toBe(1);
  });
  it('adapts legacy choice whitespace without changing scientific parameter values', () => {
    const original = legacy();
    original.steps[0].parameters = [{ key: 'label', label: ' Labels ', type: 'choice', options: [' A ', 'B'], default: ' A ' }];
    expect(adaptWorkflowV1(original).steps[0].parameters.label.default).toBe(' A ');
    expect(parseLegacyExecutableWorkflowPackage(serializeWorkflow(original))).toEqual(original);
  });
  it('preserves legacy byte-limit packages after adapter metadata expansion', () => {
    const original = legacy();
    const initial = clone(original.steps[0]);
    original.steps = Array.from({ length: 20 }, (_, index) => ({ ...clone(initial), id: `step-${index}`, entry: `step-${index}.R` }));
    original.tabs = original.steps.map(step => ({ id: step.id, label: step.label, step: step.id, plots: [] }));
    original.files = Object.fromEntries(original.steps.map(step => [step.entry, '# x']));
    let remaining = WORKFLOW_LIMITS.bytes - new TextEncoder().encode(serializeWorkflow(original)).length;
    for (const file of Object.keys(original.files)) {
      const added = Math.min(remaining, WORKFLOW_LIMITS.scriptBytes - 3);
      original.files[file] += 'x'.repeat(added); remaining -= added;
    }
    expect(remaining).toBe(0);
    expect(parseLegacyExecutableWorkflowPackage(serializeWorkflow(original))).toEqual(original);
  });
  it('validates human/tool contracts without claiming the existing worker can run them', () => {
    const recipe = fixture('tissue-image-inspection').recipe;
    const assessment = assessRecipeExecutability(recipe, { environmentProfiles: ['image-preview-v1'] });
    expect(assessment.valid).toBe(true); expect(assessment.executable).toBe(false);
    expect(assessment.missing.map(issue => issue.capability)).toEqual(expect.arrayContaining(['schema:2', 'operation:tool', 'tool:image-preview-v1', 'operation:human', 'artifact:image']));
    let rejection;
    try { parseLegacyExecutableWorkflowPackage(serializeWorkflow(recipe)); } catch (error) { rejection = error; }
    expect(rejection).toMatchObject({ code: 'WORKFLOW_EXECUTOR_UNAVAILABLE', status: 422, details: { schemaVersion: 2 } });
    expect(rejection.message).toContain('recipe is valid');
    expect(rejection.message).toContain('mark-region');
  });
  it('requires explicit schema, environment, format and collection capabilities for new contracts', () => {
    const recipe = fixture('condition-pseudobulk').recipe;
    const environment = recipe.environments.research;
    const capabilities = { schemaVersions: [2], operationKinds: ['r'], environmentProfiles: [environment.profileId], environmentDigests: [environment.digest], artifactTypes: ['object', 'design', 'table'], artifactFormats: ['org.seurat.object', 'org.traceomics.experimental-design', 'org.traceomics.table'], collections: true, helperFiles: true, rootInputs: true };
    expect(assessRecipeExecutability(recipe, capabilities).executable).toBe(true);
    expect(assessRecipeExecutability(recipe, { ...capabilities, environmentDigests: [] }).missing).toContainEqual(expect.objectContaining({ capability: `environment-digest:${environment.digest}` }));
    expect(() => parseLegacyExecutableWorkflowPackage(recipe, capabilities)).toThrow(/schema 2/);
  });
});
