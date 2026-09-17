export const WORKFLOW_LIMITS = Object.freeze({ bytes: 512 * 1024, metadataBytes: 64 * 1024, steps: 40, files: 64, scriptBytes: 30 * 1024 });
export const OUTPUT_TYPES = Object.freeze(['rds', 'table', 'metrics', 'scatter', 'figure']);
const encoder = new TextEncoder();
const idPattern = /^[a-z][a-z0-9-]{1,39}$/;
const filenamePattern = /^(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.R$/;
const own = (object, key) => Object.hasOwn(object, key);
const bytes = value => encoder.encode(value).length;

function fail(message) { throw new Error(message); }
function record(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(`${label} must be an object.`);
  for (const key of Object.keys(value)) if (!fields.includes(key)) fail(`${label}: unknown field ${key}.`);
}
function text(value, label, maximum = 100) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || [...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) fail(`${label} must contain 1–${maximum} characters on one line.`);
  return value.trim();
}
function identifier(value, label) {
  if (typeof value !== 'string' || !idPattern.test(value) || ['constructor', 'prototype'].includes(value)) fail(`${label} must be a lowercase identifier.`);
  return value;
}
function list(value, label, maximum, minimum = 0) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) fail(`${label} must contain ${minimum}–${maximum} entries.`);
  return value;
}
function unique(values, label) {
  if (new Set(values).size !== values.length) fail(`${label} contains duplicate entries.`);
}

// JSON.parse alone discards duplicate keys. Check the original text before parsing.
export function parseWorkflowJSON(source) {
  if (typeof source !== 'string' || bytes(source) > WORKFLOW_LIMITS.bytes) fail('Workflow package exceeds 512 KiB.');
  let position = 0;
  const whitespace = () => { while (/\s/.test(source[position] || '') && position < source.length) position++; };
  const string = () => {
    const start = position++;
    while (position < source.length) {
      const char = source[position++];
      if (char === '\\') position++;
      else if (char === '"') return JSON.parse(source.slice(start, position));
    }
    fail('Workflow package must contain valid JSON.');
  };
  function value(depth = 0) {
    if (depth > 32) fail('Workflow package is nested too deeply.');
    whitespace();
    const char = source[position];
    if (char === '"') { string(); return; }
    if (char === '{' || char === '[') {
      const object = char === '{'; const end = object ? '}' : ']'; const keys = new Set();
      position++; whitespace();
      if (source[position] === end) { position++; return; }
      while (position < source.length) {
        if (object) {
          whitespace();
          if (source[position] !== '"') fail('Workflow package must contain valid JSON.');
          const key = string();
          if (keys.has(key)) fail(`Duplicate JSON key: ${key}.`);
          keys.add(key); whitespace();
          if (source[position++] !== ':') fail('Workflow package must contain valid JSON.');
        }
        value(depth + 1); whitespace();
        const next = source[position++];
        if (next === end) return;
        if (next !== ',') fail('Workflow package must contain valid JSON.');
      }
      fail('Workflow package must contain valid JSON.');
    }
    const literal = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(source.slice(position));
    if (!literal) fail('Workflow package must contain valid JSON.');
    position += literal[0].length;
  }
  value(); whitespace();
  if (position !== source.length) fail('Workflow package must contain valid JSON.');
  return JSON.parse(source);
}

export function serializeWorkflow(value) { return `${JSON.stringify(value, null, 2)}\n`; }

function validateParameter(parameter) {
  record(parameter, ['key', 'type', 'label', 'default', 'min', 'max', 'options', 'maxLength'], 'Parameter');
  identifier(parameter.key, 'Parameter key'); text(parameter.label, 'Parameter label');
  if (!['integer', 'number', 'boolean', 'choice', 'text'].includes(parameter.type)) fail('Unsupported parameter template.');
  const numeric = ['integer', 'number'].includes(parameter.type);
  for (const field of ['min', 'max']) {
    if (own(parameter, field) && (!numeric || !Number.isFinite(parameter[field])
        || (parameter.type === 'integer' && !Number.isSafeInteger(parameter[field])))) fail(`Invalid parameter ${field}.`);
  }
  if (parameter.min > parameter.max) fail('Parameter minimum exceeds maximum.');
  if (parameter.type === 'choice') {
    list(parameter.options, 'Choices', 40, 1).forEach(option => text(option, 'Choice'));
    unique(parameter.options, 'Choices');
  } else if (own(parameter, 'options')) fail('Only choice parameters accept options.');
  if (own(parameter, 'maxLength') && (parameter.type !== 'text' || !Number.isSafeInteger(parameter.maxLength)
      || parameter.maxLength < 1 || parameter.maxLength > 2000)) fail('Invalid text length limit.');
  validateParameterValue(parameter, parameter.default);
  return { ...parameter };
}

function validateParameterValue(parameter, value) {
  const { type, label, min, max } = parameter;
  if (type === 'boolean' && typeof value !== 'boolean') fail(`${label} must be true or false.`);
  if (['integer', 'number'].includes(type) && (!Number.isFinite(value)
      || (type === 'integer' && !Number.isSafeInteger(value))
      || (min !== undefined && value < min) || (max !== undefined && value > max))) fail(`${label} is outside its allowed range.`);
  if (type === 'choice' && !parameter.options.includes(value)) fail(`${label} requires one of its listed choices.`);
  if (type === 'text' && (typeof value !== 'string' || value.length > (parameter.maxLength || 240) || value.includes('\0'))) fail(`${label} is too long or invalid.`);
}

export function workflowParameters(step, values = {}) {
  record(values, step.parameters.map(parameter => parameter.key), 'Parameters');
  return Object.fromEntries(step.parameters.map(parameter => {
    const value = own(values, parameter.key) ? values[parameter.key] : parameter.default;
    validateParameterValue(parameter, value);
    return [parameter.key, value];
  }));
}

export function validateWorkflowPackage(input) {
  record(input, ['format', 'schemaVersion', 'id', 'name', 'version', 'description', 'runtime', 'files', 'steps', 'tabs'], 'Workflow');
  if (input.format !== 'traceomics-workflow' || input.schemaVersion !== 1) fail('Unsupported workflow package version.');
  identifier(input.id, 'Workflow ID'); text(input.name, 'Workflow name');
  if (typeof input.version !== 'string' || !/^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/.test(input.version)) fail('Workflow version must use major.minor.patch.');
  text(input.description, 'Workflow description', 500);
  record(input.runtime, ['language', 'profileId'], 'Runtime');
  if (input.runtime.language !== 'r' || !/^[a-z0-9][a-z0-9.-]{2,99}$/.test(input.runtime.profileId || '')) fail('Workflow requires an R runtime profile.');
  record(input.files, Object.keys(input.files || {}), 'Source files');
  const files = Object.keys(input.files);
  if (!files.length || files.length > WORKFLOW_LIMITS.files) fail('Invalid source file count.');
  for (const file of files) {
    if (!filenamePattern.test(file) || file.length > 120 || file.split('/').some(part => ['constructor', 'prototype'].includes(part))) fail('Invalid R source filename.');
    if (typeof input.files[file] !== 'string' || !input.files[file].trim() || input.files[file].includes('\0')
        || bytes(input.files[file]) > WORKFLOW_LIMITS.scriptBytes) fail('R source exceeds the 30 KiB author-code limit.');
  }
  const steps = list(input.steps, 'Steps', WORKFLOW_LIMITS.steps, 1).map(step => {
    record(step, ['id', 'label', 'entry', 'inputs', 'parameters', 'outputs'], 'Step');
    identifier(step.id, 'Step ID'); text(step.label, 'Step label');
    if (step.id === 'input') fail('The step ID input is reserved for the starting analysis.');
    if (!own(input.files, step.entry)) fail(`Missing source file for ${step.id}.`);
    record(step.inputs, Object.keys(step.inputs || {}), 'Step inputs');
    if (!Object.keys(step.inputs).length || Object.keys(step.inputs).length > 5) fail('A step requires 1–5 inputs.');
    for (const [name, binding] of Object.entries(step.inputs)) {
      identifier(name, 'Input name');
      record(binding, ['from', 'type'], 'Input binding');
      if (typeof binding.from !== 'string' || !OUTPUT_TYPES.includes(binding.type) || binding.type === 'figure') fail('Invalid input binding. Figures are display outputs.');
    }
    record(step.outputs, Object.keys(step.outputs || {}), 'Step outputs');
    if (!Object.keys(step.outputs).length || Object.keys(step.outputs).length > 8) fail('A step requires 1–8 outputs.');
    for (const [name, output] of Object.entries(step.outputs)) {
      identifier(name, 'Output name'); record(output, ['type', 'label'], 'Output');
      if (!OUTPUT_TYPES.includes(output.type)) fail('Unsupported output type.');
      text(output.label, 'Output label');
    }
    const parameters = list(step.parameters, 'Parameters', 24).map(validateParameter);
    unique(parameters.map(parameter => parameter.key), 'Parameter keys');
    return { ...step, parameters };
  });
  unique(steps.map(step => step.id), 'Step IDs');
  const byId = new Map(steps.map(step => [step.id, step]));
  const visited = new Set(); const visiting = new Set();
  function visit(step) {
    if (visiting.has(step.id)) fail('Workflow dependencies contain a cycle.');
    if (visited.has(step.id)) return;
    visiting.add(step.id);
    for (const binding of Object.values(step.inputs)) {
      if (binding.from === 'input.analysis' && binding.type === 'rds') continue;
      const [producer, port, ...rest] = binding.from.split('.');
      const parent = byId.get(producer);
      if (rest.length || !parent || !own(parent.outputs, port) || parent.outputs[port].type !== binding.type) fail(`Invalid dependency ${binding.from}.`);
      visit(parent);
    }
    visiting.delete(step.id); visited.add(step.id);
  }
  steps.forEach(visit);
  const tabs = list(input.tabs, 'Tabs', 40, 1).map(tab => {
    record(tab, ['id', 'label', 'step', 'plots'], 'Tab');
    identifier(tab.id, 'Tab ID'); text(tab.label, 'Tab label');
    if (!byId.has(tab.step)) fail('Tab references an unknown step.');
    const plots = list(tab.plots || [], 'Plot steps', 8);
    unique([tab.step, ...plots], 'Tab steps');
    if (plots.some(id => !byId.has(id))) fail('Tab references an unknown plot step.');
    return { ...tab, plots };
  });
  unique(tabs.map(tab => tab.id), 'Tab IDs');
  const presented = tabs.flatMap(tab => [tab.step, ...tab.plots]);
  unique(presented, 'Presented steps');
  if (steps.some(step => !presented.includes(step.id))) fail('Every step must be available in a tab.');
  if (files.some(file => !steps.some(step => step.entry === file))) fail('Package contains an unused source file.');
  const result = JSON.parse(JSON.stringify({ ...input, steps, tabs }));
  if (bytes(serializeWorkflow(result)) > WORKFLOW_LIMITS.bytes) fail('Workflow package exceeds 512 KiB.');
  if (bytes(JSON.stringify({ ...result, files: {} })) > WORKFLOW_LIMITS.metadataBytes) fail('Workflow metadata exceeds 64 KiB.');
  return result;
}

export function parseWorkflowPackage(source) { return validateWorkflowPackage(parseWorkflowJSON(source)); }
