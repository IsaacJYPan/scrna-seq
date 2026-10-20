import { describe, expect, it } from 'vitest';
import { parseWorkflowJSON, parseWorkflowPackage, serializeWorkflow, validateWorkflowPackage, WORKFLOW_LIMITS } from '../../shared/workflowPackage.mjs';
import { beginWorkflowRun, cancelWorkflowRun, commitWorkflowRun, createWorkflowState, snapshotWorkflowState, workflowAvailability, workflowTabAvailability } from '../../shared/workflowState.mjs';
import { mergeWorkflowUpdate } from './workflowApi';
import { adaptWorkflowV1 } from '../../shared/recipePackage.mjs';

function example() {
  const step = (id, inputs) => ({ id, label: id, entry: `${id}.R`, inputs, parameters: [], outputs: { data: { type: 'rds', label: 'Data' } } });
  const binding = from => ({ analysis: { from, type: 'rds' } });
  const steps = [step('qc', binding('input.analysis')), step('pca', binding('qc.data')),
    step('neighbors', binding('pca.data')), step('umap', binding('pca.data')),
    step('clusters', binding('neighbors.data')), step('report', binding('qc.data'))];
  return { format: 'traceomics-workflow', schemaVersion: 1, id: 'example', name: 'Example', version: '1.0.0', description: 'A branching workflow.', runtime: { language: 'r', profileId: 'test-profile' },
    files: Object.fromEntries(steps.map(step => [step.entry, 'print(1)'])), steps,
    tabs: steps.map(step => ({ id: step.id, label: step.label, step: step.id, plots: [] })) };
}
const artifact = (value = 'a') => ({ id: value, type: 'rds', sha256: value.repeat(64), sizeBytes: 10, profileId: 'test-profile' });

it('ignores stale polls across run admission, completion, and a restored workflow', () => {
  const idle = { id: 'first', state: { generation: 0, active: null } };
  const running = { ...idle, state: { generation: 0, active: { id: 'run' } } };
  const done = { ...idle, state: { generation: 1, active: null } };
  const restored = { ...done, id: 'restored' };
  expect(mergeWorkflowUpdate(running, idle)).toBe(running);
  expect(mergeWorkflowUpdate(done, running)).toBe(done);
  expect(mergeWorkflowUpdate(done, restored)).toBe(done);
  expect(mergeWorkflowUpdate(done, restored, true)).toBe(restored);
  expect(mergeWorkflowUpdate(restored, done)).toBe(restored);
  expect(mergeWorkflowUpdate(null, done)).toBeNull();
});
function run(workflow, state, stepId, output = artifact()) {
  const started = beginWorkflowRun(workflow, state, { id: `run-${state.generation}`, stepId });
  return commitWorkflowRun(workflow, started, { id: started.active.id, generation: state.generation, producerKey: 'same-runtime-and-parameters', outputs: { data: output } });
}

describe('workflow packages', () => {
  it('round-trips a branching definition without executing source', () => {
    const workflow = example();
    expect(parseWorkflowPackage(serializeWorkflow(workflow))).toEqual(workflow);
  });
  it('retains optional declared output semantics in a pinned package and rejects incompatible meaning', () => {
    const workflow = example();
    workflow.steps[0].outputs.summary = { type: 'metrics', label: 'QC', semantics: { role: 'diagnostic', title: 'QC summary', metrics: { cells: { label: 'Retained cells', unit: 'cells' } } } };
    expect(parseWorkflowPackage(serializeWorkflow(workflow))).toEqual(workflow);
    expect(adaptWorkflowV1(workflow).steps[0].outputs.summary.format.metadata['org.traceomics.result:semantics']).toEqual(workflow.steps[0].outputs.summary.semantics);
    workflow.steps[0].outputs.summary.semantics.entityType = 'cell';
    expect(() => validateWorkflowPackage(workflow)).toThrow(/unsupported field/);
  });
  it.each([
    value => { value.steps[0].inputs.analysis.from = 'clusters.data'; },
    value => { value.steps[0].inputs.analysis.type = 'figure'; },
    value => { value.steps[1].inputs.analysis.from = 'missing.data'; },
    value => { value.steps[1].inputs.analysis.from = 'qc.missing'; },
    value => { value.steps[1].id = 'qc'; },
    value => { value.steps[0].id = 'input'; },
    value => { value.steps[1].entry = '../../private.R'; },
    value => { value.files['unused.R'] = 'print(1)'; },
    value => { value.tabs.pop(); },
    value => { value.steps[0].parameters = [{ key: 'count', label: 'Count', type: 'integer', default: 20, max: 10 }]; },
    value => { value.runtime.network = true; },
  ])('rejects invalid contracts before installation', change => {
    const value = example(); change(value);
    expect(() => validateWorkflowPackage(value)).toThrow();
  });
  it.each(['{"id":1,"id":2}', '{"nested":{"a":1,"\\u0061":2}}', '[{"a":1,"a":2}]'])('rejects duplicate JSON keys: %s', source => {
    expect(() => parseWorkflowJSON(source)).toThrow(/Duplicate/);
  });
  it.each(['{"a":}', '[1,]', '{"a":1,}', '{"a":1} false', '"unfinished', '01'])('rejects malformed JSON: %s', source => {
    expect(() => parseWorkflowJSON(source)).toThrow();
  });
  it('accepts escaped strings and repeated keys in separate objects', () => {
    const value = [{ key: 'one\\two"three' }, { key: 'four' }];
    expect(parseWorkflowJSON(JSON.stringify(value))).toEqual(value);
  });
  it('round-trips the exact exported byte limit and rejects one extra byte', () => {
    const workflow = example();
    workflow.steps = Array.from({ length: 20 }, (_, index) => ({
      ...workflow.steps[0], id: `step-${index}`, entry: `step-${index}.R`,
    }));
    workflow.tabs = workflow.steps.map(step => ({ id: step.id, label: step.label, step: step.id, plots: [] }));
    workflow.files = Object.fromEntries(workflow.steps.map(step => [step.entry, '# é']));
    const size = () => new TextEncoder().encode(serializeWorkflow(workflow)).length;
    let remaining = WORKFLOW_LIMITS.bytes - size();
    for (const file of Object.keys(workflow.files)) {
      const added = Math.min(remaining, WORKFLOW_LIMITS.scriptBytes - 4);
      workflow.files[file] += 'x'.repeat(added);
      remaining -= added;
    }
    expect(size()).toBe(WORKFLOW_LIMITS.bytes);
    expect(parseWorkflowPackage(serializeWorkflow(workflow))).toEqual(workflow);
    workflow.files['step-19.R'] += 'x';
    expect(() => validateWorkflowPackage(workflow)).toThrow(/512 KiB/);
  });
});

describe('working workflow state', () => {
  const workflow = validateWorkflowPackage(example());
  const complete = () => workflow.steps.reduce((state, step) => run(workflow, state, step.id), createWorkflowState(artifact()));
  it('unlocks both branches from PCA regardless of tab order', () => {
    let state = run(workflow, createWorkflowState(artifact()), 'qc');
    expect(workflowAvailability(workflow, state, 'umap').ready).toBe(false);
    state = run(workflow, state, 'pca');
    expect(workflowAvailability(workflow, state, 'umap').ready).toBe(true);
    expect(workflowAvailability(workflow, state, 'neighbors').ready).toBe(true);
    expect(workflowAvailability(workflow, state, 'clusters').ready).toBe(false);
  });
  it('allows an independent plot to be reached even when its tab’s main step is locked', () => {
    const state = run(workflow, createWorkflowState(artifact()), 'qc');
    expect(workflowAvailability(workflow, state, 'umap').ready).toBe(false);
    expect(workflowTabAvailability(workflow, state, { step: 'umap', plots: ['report'] }).ready).toBe(true);
  });
  it('clears only descendants of changed output after a successful rerun', () => {
    const state = run(workflow, complete(), 'pca', artifact('b'));
    expect(Object.keys(state.results).sort()).toEqual(['pca', 'qc', 'report']);
    expect(workflowAvailability(workflow, state, 'neighbors').ready).toBe(true);
    expect(workflowAvailability(workflow, state, 'clusters').reason).toContain('neighbors');
  });
  it('keeps downstream state and artifact references for exact unchanged output', () => {
    const before = complete(); const after = run(workflow, before, 'pca');
    expect(after.results.umap).toBe(before.results.umap);
    expect(after.results.pca.outputs.data).toBe(before.results.pca.outputs.data);
  });
  it('keeps changed declared meaning attached to its new immutable output instead of reusing an older descriptor', () => {
    const before = complete();
    const output = { ...artifact(), semantics: { role: 'primary', title: 'New declared source meaning' } };
    const after = run(workflow, before, 'pca', output);
    expect(after.results.pca.outputs.data).toBe(output);
    expect(after.results.umap).toBeUndefined();
  });
  it('preserves working results on failure or cancellation and rejects late completion', () => {
    const before = complete();
    const started = beginWorkflowRun(workflow, before, { id: 'replacement', stepId: 'pca' });
    expect(started.results).toBe(before.results);
    const canceled = cancelWorkflowRun(started, 'replacement');
    expect(canceled.results).toBe(before.results);
    expect(() => commitWorkflowRun(workflow, canceled, { id: 'replacement', generation: before.generation, outputs: { data: artifact('b') } })).toThrow(/no longer/);
  });
  it('rejects concurrent mutation, invalid output and saving during a run', () => {
    const started = beginWorkflowRun(workflow, complete(), { id: 'replacement', stepId: 'pca' });
    expect(() => beginWorkflowRun(workflow, started, { id: 'other', stepId: 'umap' })).toThrow(/already running/);
    expect(() => snapshotWorkflowState(started)).toThrow(/Wait/);
    expect(() => commitWorkflowRun(workflow, started, { id: 'replacement', generation: started.generation, outputs: {} })).toThrow(/declared outputs/);
  });
  it('leaves saved snapshots independent of future working changes', () => {
    const before = complete(); const saved = snapshotWorkflowState(before);
    run(workflow, before, 'qc', artifact('b'));
    expect(saved.results).toEqual(before.results);
    expect(saved.results).not.toBe(before.results);
    expect(snapshotWorkflowState({ ...before, error: 'A canceled attempt.' })).not.toHaveProperty('error');
  });
  it('keeps the exact input references used to produce a saved result', () => {
    const state = complete();
    expect(state.results.umap.inputs.analysis).toEqual(state.results.pca.outputs.data);
    expect(snapshotWorkflowState(state).results.umap.inputs).toEqual(state.results.umap.inputs);
  });
});
