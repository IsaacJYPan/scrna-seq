import { workflowParameters } from './workflowPackage.mjs';

export function createWorkflowState(root) {
  return { generation: 0, root, results: {}, active: null };
}

export function workflowInput(state, from) {
  if (from === 'input.analysis') return state.root;
  const [step, port] = from.split('.');
  return state.results[step]?.outputs[port] || null;
}

export function workflowAvailability(workflow, state, stepId) {
  const step = workflow.steps.find(item => item.id === stepId);
  if (!step) throw new Error('Unknown workflow step.');
  if (state.active && state.active.stepId !== stepId) {
    const running = workflow.steps.find(item => item.id === state.active.stepId);
    if (invalidatedWorkflowSteps(workflow, Object.keys(running.outputs).map(port => `${running.id}.${port}`)).includes(stepId)) {
      return { ready: false, reason: `Waiting for ${running.label}.` };
    }
  }
  const missing = Object.values(step.inputs).filter(binding => !workflowInput(state, binding.from));
  const labels = [...new Set(missing.map(binding => binding.from === 'input.analysis'
    ? 'an input analysis' : workflow.steps.find(item => item.id === binding.from.split('.')[0]).label))];
  return { ready: !missing.length, reason: labels.length ? `Requires ${labels.join(' and ')}.` : '' };
}

export function workflowTabAvailability(workflow, state, tab) {
  const steps = [tab.step, ...(tab.plots || [])].map(id => workflowAvailability(workflow, state, id));
  if (steps.some(step => step.ready)) return { ready: true, reason: '' };
  return { ready: false, reason: [...new Set(steps.map(step => step.reason))].join(' ') };
}

export function beginWorkflowRun(workflow, state, { id, stepId, parameters, seed = 1 }) {
  if (state.active) throw new Error('Another step is already running.');
  if (!workflowAvailability(workflow, state, stepId).ready) throw new Error('Required workflow inputs are missing.');
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 2147483647) throw new Error('Invalid random seed.');
  const step = workflow.steps.find(item => item.id === stepId);
  const inputs = Object.fromEntries(Object.entries(step.inputs).map(([name, binding]) => [name, workflowInput(state, binding.from)]));
  return { ...state, active: { id, stepId, generation: state.generation, parameters: workflowParameters(step, parameters), seed, inputs } };
}

export function invalidatedWorkflowSteps(workflow, changedPorts) {
  const changed = new Set(changedPorts); const removed = new Set();
  let progress = true;
  while (progress) {
    progress = false;
    for (const step of workflow.steps) {
      if (!removed.has(step.id) && Object.values(step.inputs).some(binding => changed.has(binding.from))) {
        removed.add(step.id);
        Object.keys(step.outputs).forEach(port => changed.add(`${step.id}.${port}`));
        progress = true;
      }
    }
  }
  return [...removed];
}

function sameOutput(previous, next, sameProducer) {
  return previous && next && previous.type === next.type && previous.sha256 === next.sha256
    && previous.sizeBytes === next.sizeBytes && previous.profileId === next.profileId
    && (next.type !== 'rds' || sameProducer);
}

export function commitWorkflowRun(workflow, state, { id, generation, outputs, producerKey, runtime }) {
  if (!state.active || state.active.id !== id || state.generation !== generation) throw new Error('This run no longer owns the workspace.');
  const run = state.active; const previous = state.results[run.stepId];
  const step = workflow.steps.find(item => item.id === run.stepId);
  if (!outputs || Object.keys(outputs).length !== Object.keys(step.outputs).length) throw new Error('The step did not produce its declared outputs.');
  const accepted = {}; const changed = [];
  for (const [port, contract] of Object.entries(step.outputs)) {
    const output = outputs[port];
    if (!output || output.type !== contract.type || !/^[a-f0-9]{64}$/.test(output.sha256)
        || !Number.isSafeInteger(output.sizeBytes) || output.sizeBytes < 0) throw new Error('Invalid workflow output.');
    if (sameOutput(previous?.outputs[port], output, previous?.producerKey === producerKey)) accepted[port] = previous.outputs[port];
    else { accepted[port] = output; changed.push(`${step.id}.${port}`); }
  }
  const results = { ...state.results };
  for (const id of invalidatedWorkflowSteps(workflow, changed)) delete results[id];
  results[step.id] = { outputs: accepted, inputs: run.inputs, parameters: run.parameters, seed: run.seed, producerKey, ...(runtime ? { runtime } : {}) };
  return { ...state, results, active: null, generation: state.generation + 1 };
}

export function cancelWorkflowRun(state, id) {
  if (state.active?.id !== id) throw new Error('This run no longer owns the workspace.');
  return { ...state, active: null, generation: state.generation + 1 };
}

export function snapshotWorkflowState(state) {
  if (state.active) throw new Error('Wait for the current run before saving.');
  const snapshot = JSON.parse(JSON.stringify(state));
  delete snapshot.error;
  return snapshot;
}
