import { parseWorkflowJSON, validateWorkflowPackage, WORKFLOW_LIMITS } from './workflowPackage.mjs';
import { validateResultSemantics } from './resultSemantics.mjs';
import {
  artifactPortsCompatible, contractDigest, contractError, contractId, contractInteger,
  contractJSON, contractList, contractPortId, contractRecord, contractText, contractUnique,
  validateArtifactPorts, validateEnvironmentReference, validateOperationMethod, validateSourcePath,
  validateVersionReference,
} from './analysisModel.mjs';

export const RECIPE_SCHEMA_VERSION = 2;
export const RECIPE_PARAMETER_TYPES = Object.freeze([
  'integer', 'number', 'boolean', 'choice', 'text', 'multiselect', 'metadata-column',
  'gene', 'condition', 'sample', 'annotation', 'artifact', 'pair-list', 'formula',
]);
const own = (value, key) => Object.hasOwn(value, key);
const encoder = new TextEncoder();

function parameterValue(spec, value, path) {
  const { type, min, max } = spec;
  if (type === 'boolean') {
    if (typeof value !== 'boolean') contractError(path, 'must be true or false.');
  } else if (['integer', 'number'].includes(type)) {
    if (!Number.isFinite(value) || (type === 'integer' && !Number.isSafeInteger(value))
        || (min !== undefined && value < min) || (max !== undefined && value > max)) contractError(path, 'is outside its declared numeric range.');
  } else if (['multiselect', 'pair-list'].includes(type)) {
    contractList(value, path, spec.maxItems ?? 1000);
    if (type === 'pair-list') {
      value.forEach(pair => {
        contractRecord(pair, ['ligand', 'receptor'], path);
        contractText(pair.ligand, `${path}.ligand`);
        contractText(pair.receptor, `${path}.receptor`);
      });
      contractUnique(value.map(pair => JSON.stringify([pair.ligand, pair.receptor])), path);
    } else {
      value.forEach(item => contractText(item, path, spec.maxLength ?? 240));
      contractUnique(value, path);
      if (spec.options && value.some(item => !spec.options.includes(item))) contractError(path, 'contains an unlisted option.');
    }
  } else if (type === 'artifact') {
    if (value !== null) {
      contractRecord(value, ['input'], path);
      contractPortId(value.input, `${path}.input`);
    }
  } else {
    if (typeof value !== 'string' || value.length > (spec.maxLength ?? 2000) || value.includes('\0')) contractError(path, 'must be bounded text.');
    if (spec.options && !spec.options.includes(value)) contractError(path, 'requires a listed option.');
  }
}

function validateParameters(value, inputPorts, path) {
  contractRecord(value, null, path);
  if (Object.keys(value).length > 32) contractError(path, 'exceeds 32 parameters.');
  for (const [key, parameter] of Object.entries(value)) {
    contractPortId(key, `${path}.${key}`);
    const label = `${path}.${key}`;
    contractRecord(parameter, ['type', 'label', 'default', 'min', 'max', 'options', 'maxLength', 'maxItems', 'input', 'empty'], label);
    if (!RECIPE_PARAMETER_TYPES.includes(parameter.type)) contractError(`${label}.type`, 'unsupported parameter type.');
    contractText(parameter.label, `${label}.label`);
    if (!own(parameter, 'default')) contractError(`${label}.default`, 'an explicit default is required.');
    for (const field of ['min', 'max']) {
      if (own(parameter, field) && (!['integer', 'number'].includes(parameter.type)
          || !Number.isFinite(parameter[field]) || (parameter.type === 'integer' && !Number.isSafeInteger(parameter[field])))) contractError(`${label}.${field}`, 'only numeric parameters accept finite bounds.');
    }
    if (parameter.min > parameter.max) contractError(label, 'minimum exceeds maximum.');
    if (own(parameter, 'maxLength')) {
      if (['integer', 'number', 'boolean', 'artifact', 'pair-list'].includes(parameter.type)) contractError(`${label}.maxLength`, 'not supported for this parameter type.');
      contractInteger(parameter.maxLength, `${label}.maxLength`, 1, 10000);
    }
    if (own(parameter, 'maxItems')) {
      if (!['multiselect', 'pair-list'].includes(parameter.type)) contractError(`${label}.maxItems`, 'only list parameters accept item limits.');
      contractInteger(parameter.maxItems, `${label}.maxItems`, 1, 10000);
    }
    if (parameter.type === 'choice' || own(parameter, 'options')) {
      if (!['choice', 'multiselect'].includes(parameter.type)) contractError(`${label}.options`, 'only choice and multiselect parameters accept options.');
      contractList(parameter.options, `${label}.options`, 1000, 1).forEach(option => contractText(option, `${label}.options`));
      contractUnique(parameter.options, `${label}.options`);
    }
    if (['pair-list', 'multiselect'].includes(parameter.type)) {
      if (!['all', 'none', 'error'].includes(parameter.empty)) contractError(`${label}.empty`, 'list parameters must declare whether an empty selection means all, none, or error.');
    } else if (own(parameter, 'empty')) contractError(`${label}.empty`, 'only list parameters accept empty-selection semantics.');
    if (own(parameter, 'input')) {
      contractPortId(parameter.input, `${label}.input`);
      if (!own(inputPorts, parameter.input)) contractError(`${label}.input`, 'references an undeclared operation input.');
    }
    parameterValue(parameter, parameter.default, `${label}.default`);
    if (['pair-list', 'multiselect'].includes(parameter.type) && parameter.empty === 'error' && !parameter.default.length) contractError(`${label}.default`, 'cannot be empty when empty selections are errors.');
    if (parameter.type === 'artifact' && parameter.default !== null && !own(inputPorts, parameter.default.input)) contractError(`${label}.default`, 'references an undeclared operation input.');
  }
  return contractJSON(value, path);
}

export function resolveRecipeParameters(step, values = {}) {
  contractRecord(values, Object.keys(step.parameters), `Step ${step.id} parameters`);
  return Object.fromEntries(Object.entries(step.parameters).map(([key, parameter]) => {
    const value = own(values, key) ? values[key] : parameter.default;
    parameterValue(parameter, value, `Step ${step.id} parameter ${key}`);
    if (['pair-list', 'multiselect'].includes(parameter.type) && parameter.empty === 'error' && value.length === 0) contractError(`Step ${step.id} parameter ${key}`, 'requires a nonempty selection.');
    if (parameter.type === 'artifact' && value !== null && !own(step.inputs, value.input)) contractError(`Step ${step.id} parameter ${key}`, 'references an undeclared operation input.');
    return [key, contractJSON(value, `Parameter ${key}`)];
  }));
}

function validateBinding(value, path) {
  if (!value || !['input', 'step'].includes(value.kind)) contractError(path, 'binding kind must be input or step.');
  contractRecord(value, value.kind === 'input' ? ['kind', 'port'] : ['kind', 'step', 'port'], path);
  contractPortId(value.port, `${path}.port`);
  if (value.kind === 'step') contractPortId(value.step, `${path}.step`);
}

function sourcePort(recipe, byId, binding, path) {
  validateBinding(binding, path);
  if (binding.kind === 'input') {
    if (!own(recipe.inputs, binding.port)) contractError(path, `root input ${binding.port} does not exist.`);
    return recipe.inputs[binding.port];
  }
  const producer = byId.get(binding.step);
  if (!producer || !own(producer.outputs, binding.port)) contractError(path, `output ${binding.step}.${binding.port} does not exist.`);
  return producer.outputs[binding.port];
}

function validateUI(value, outputPorts, path) {
  contractRecord(value, ['label', 'results'], path);
  if (own(value, 'label')) contractText(value.label, `${path}.label`);
  const results = contractList(value.results ?? [], `${path}.results`, 32);
  contractUnique(results, `${path}.results`);
  results.forEach(port => {
    contractPortId(port, `${path}.results`);
    if (!own(outputPorts, port)) contractError(`${path}.results`, `output ${port} does not exist.`);
  });
}

export function validateRecipePackage(input, limits = WORKFLOW_LIMITS) {
  const path = 'Recipe';
  contractRecord(input, ['format', 'schemaVersion', 'id', 'name', 'version', 'description', 'inputs', 'outputs', 'environments', 'files', 'steps', 'tabs', 'package', 'origin'], path);
  if (input.format !== 'traceomics-workflow' || input.schemaVersion !== RECIPE_SCHEMA_VERSION) contractError(path, `unsupported schema version ${String(input.schemaVersion)}; expected traceomics-workflow version 2.`);
  contractId(input.id, `${path}.id`);
  contractText(input.name, `${path}.name`);
  if (typeof input.version !== 'string' || !/^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/.test(input.version)) contractError(`${path}.version`, 'requires major.minor.patch.');
  contractText(input.description, `${path}.description`, 2000);
  validateArtifactPorts(input.inputs, `${path}.inputs`);
  contractRecord(input.environments, null, `${path}.environments`);
  if (Object.keys(input.environments).length > 16) contractError(`${path}.environments`, 'exceeds 16 environments.');
  for (const [id, environment] of Object.entries(input.environments)) {
    contractPortId(id, `${path}.environments.${id}`);
    validateEnvironmentReference(environment, `${path}.environments.${id}`);
  }
  contractRecord(input.files, null, `${path}.files`);
  if (Object.keys(input.files).length > WORKFLOW_LIMITS.files) contractError(`${path}.files`, 'too many package files.');
  for (const [file, source] of Object.entries(input.files)) {
    validateSourcePath(file, `${path}.files.${file}`);
    if (typeof source !== 'string' || !source.trim() || source.includes('\0') || encoder.encode(source).length > WORKFLOW_LIMITS.scriptBytes) contractError(`${path}.files.${file}`, 'requires nonempty text within the 30 KiB package-file limit.');
  }
  const steps = contractList(input.steps, `${path}.steps`, WORKFLOW_LIMITS.steps);
  const filesUsed = new Set();
  for (const [id, environment] of Object.entries(input.environments)) {
    if (environment.lockfile) {
      if (!own(input.files, environment.lockfile)) contractError(`${path}.environments.${id}.lockfile`, 'package file does not exist.');
      filesUsed.add(environment.lockfile);
    }
  }
  steps.forEach(step => {
    const label = `Step ${step?.id ?? '?'}`;
    contractRecord(step, ['id', 'label', 'operation', 'inputs', 'bindings', 'parameters', 'outputs', 'environment', 'ui'], label);
    contractPortId(step.id, `${label}.id`);
    if (step.id === 'input') contractError(`${label}.id`, 'input is reserved for recipe roots.');
    contractText(step.label, `${label}.label`);
    validateOperationMethod(step.operation, `${label}.operation`);
    validateArtifactPorts(step.inputs, `${label}.inputs`);
    validateArtifactPorts(step.outputs, `${label}.outputs`);
    contractRecord(step.bindings, Object.keys(step.inputs), `${label}.bindings`);
    for (const [port, declaration] of Object.entries(step.inputs)) {
      if (!own(step.bindings, port) && !declaration.optional) contractError(`${label}.bindings.${port}`, 'required input is not bound.');
      if (own(step.bindings, port)) validateBinding(step.bindings[port], `${label}.bindings.${port}`);
    }
    validateParameters(step.parameters, step.inputs, `${label}.parameters`);
    if (step.operation.kind === 'human') {
      if (step.environment !== null) contractError(`${label}.environment`, 'human operations have no computational environment.');
    } else {
      contractPortId(step.environment, `${label}.environment`);
      if (!own(input.environments, step.environment)) contractError(`${label}.environment`, 'environment does not exist.');
      if (step.operation.kind === 'r' && input.environments[step.environment].runtime.language !== 'r') contractError(`${label}.environment`, 'R operations require an R environment.');
      for (const file of [step.operation.entry, ...(step.operation.helpers ?? [])]) {
        if (!own(input.files, file)) contractError(`${label}.operation`, `source file ${file} does not exist.`);
        filesUsed.add(file);
      }
    }
    if (own(step, 'ui')) validateUI(step.ui, step.outputs, `${label}.ui`);
  });
  contractUnique(steps.map(step => step.id), `${path}.steps`);
  const byId = new Map(steps.map(step => [step.id, step]));
  const visited = new Set(); const visiting = new Set();
  function visit(step) {
    if (visiting.has(step.id)) contractError(`Step ${step.id}`, 'dependency cycle detected. Rebind an input to a root or an earlier independent operation.');
    if (visited.has(step.id)) return;
    visiting.add(step.id);
    for (const [port, binding] of Object.entries(step.bindings)) {
      const label = `Step ${step.id}.bindings.${port}`;
      if (!artifactPortsCompatible(sourcePort(input, byId, binding, label), step.inputs[port])) contractError(label, 'producer type, format, collection bounds, or optionality does not satisfy the input contract.');
      if (binding.kind === 'step') visit(byId.get(binding.step));
    }
    visiting.delete(step.id); visited.add(step.id);
  }
  steps.forEach(visit);
  contractRecord(input.outputs, null, `${path}.outputs`);
  if (Object.keys(input.outputs).length > 32) contractError(`${path}.outputs`, 'too many exported outputs.');
  for (const [id, output] of Object.entries(input.outputs)) {
    contractPortId(id, `${path}.outputs.${id}`);
    contractRecord(output, ['port', 'from'], `${path}.outputs.${id}`);
    validateArtifactPorts({ [id]: output.port }, `${path}.outputs`);
    if (!artifactPortsCompatible(sourcePort(input, byId, output.from, `${path}.outputs.${id}.from`), output.port)) contractError(`${path}.outputs.${id}`, 'exported output does not match its producer.');
  }
  if (own(input, 'tabs')) {
    const tabs = contractList(input.tabs, `${path}.tabs`, 40);
    contractUnique(tabs.map(tab => tab.id), `${path}.tabs`);
    const presented = [];
    tabs.forEach(tab => {
      contractRecord(tab, ['id', 'label', 'step', 'plots'], `${path}.tabs`);
      contractPortId(tab.id, 'Tab ID'); contractText(tab.label, 'Tab label');
      const tabSteps = [tab.step, ...contractList(tab.plots ?? [], 'Tab plot steps', 8)];
      contractUnique(tabSteps, 'Tab steps');
      tabSteps.forEach(id => { if (!byId.has(id)) contractError('Tab steps', `step ${id} does not exist.`); });
      presented.push(...tabSteps);
    });
    contractUnique(presented, 'Presented steps');
  }
  if (own(input, 'package')) {
    contractRecord(input.package, ['license', 'authors', 'permissions'], `${path}.package`);
    contractText(input.package.license, `${path}.package.license`);
    contractList(input.package.authors, `${path}.package.authors`, 20, 1).forEach(author => contractText(author, 'Package author'));
    const permissions = contractList(input.package.permissions, `${path}.package.permissions`, 16);
    contractUnique(permissions, 'Package permissions');
    if (permissions.some(permission => !['read-inputs', 'write-outputs', 'package-retrieval'].includes(permission))) contractError('Package permissions', 'unsupported permission; arbitrary filesystem or network access is not implied by a valid recipe.');
  }
  if (own(input, 'origin')) validateVersionReference(input.origin, `${path}.origin`);
  for (const file of Object.keys(input.files)) {
    if (!filesUsed.has(file)) contractError(`${path}.files.${file}`, 'unused source/helper/lock file.');
  }
  const result = contractJSON(input, path, limits.bytes);
  contractJSON({ ...result, files: {} }, 'Recipe metadata', limits.metadataBytes);
  return result;
}

const legacyTypes = Object.freeze({ rds: 'object', table: 'table', metrics: 'metrics', scatter: 'coordinates', figure: 'figure' });
const legacyFormats = Object.freeze({
  rds: 'org.r-project.rds', table: 'org.traceomics.table', metrics: 'org.traceomics.metrics',
  scatter: 'org.traceomics.scatter', figure: 'org.traceomics.figure',
});
function legacyPort(spec) {
  return { type: legacyTypes[spec.type], cardinality: 'one', format: { id: legacyFormats[spec.type], version: '1',
    ...(own(spec, 'semantics') ? { metadata: { 'org.traceomics.result:semantics': validateResultSemantics(spec.semantics, spec.type) } } : {}) }, ...(spec.label ? { label: spec.label } : {}) };
}

export function adaptWorkflowV1(input) {
  const workflow = validateWorkflowPackage(input);
  return validateRecipePackage({
    format: workflow.format, schemaVersion: RECIPE_SCHEMA_VERSION,
    id: workflow.id, name: workflow.name, version: workflow.version, description: workflow.description,
    inputs: { analysis: legacyPort({ type: 'rds', label: 'Saved analysis' }) }, outputs: {},
    environments: { legacy: { profileId: workflow.runtime.profileId, runtime: { language: 'r' } } },
    files: workflow.files, tabs: workflow.tabs,
    steps: workflow.steps.map(step => ({
      id: step.id, label: step.label,
      operation: { kind: 'r', entry: step.entry, helpers: [], state: 'isolated' }, environment: 'legacy',
      inputs: Object.fromEntries(Object.entries(step.inputs).map(([port, spec]) => [port, legacyPort(spec)])),
      bindings: Object.fromEntries(Object.entries(step.inputs).map(([port, spec]) => {
        const [producer, output] = spec.from.split('.');
        return [port, producer === 'input' ? { kind: 'input', port: output } : { kind: 'step', step: producer, port: output }];
      })),
      parameters: Object.fromEntries(step.parameters.map(({ key, ...spec }) => [key, spec])),
      outputs: Object.fromEntries(Object.entries(step.outputs).map(([port, spec]) => [port, legacyPort(spec)])),
      ui: { label: step.label, results: Object.keys(step.outputs) },
    })),
  }, { bytes: WORKFLOW_LIMITS.bytes + 4 * WORKFLOW_LIMITS.metadataBytes, metadataBytes: 4 * WORKFLOW_LIMITS.metadataBytes });
}

export function normalizeRecipePackage(input) {
  if (input?.format !== 'traceomics-workflow' || ![1, RECIPE_SCHEMA_VERSION].includes(input.schemaVersion)) contractError('Recipe', `unsupported schema version ${String(input?.schemaVersion)}; supported versions are 1 and 2.`);
  return input.schemaVersion === 1 ? adaptWorkflowV1(input) : validateRecipePackage(input);
}
export function parseRecipePackage(source) { return normalizeRecipePackage(parseWorkflowJSON(source)); }

export function inspectRecipePackage(source, capabilities = {}) {
  const input = typeof source === 'string' ? parseWorkflowJSON(source) : source;
  const recipe = normalizeRecipePackage(input);
  const original = input.schemaVersion === 1 ? validateWorkflowPackage(input) : recipe;
  return { package: original, recipe, sourceSchemaVersion: input.schemaVersion, execution: assessValidatedRecipe(recipe, input.schemaVersion, capabilities) };
}

export function parseLegacyExecutableWorkflowPackage(source, capabilities = {}) {
  const input = typeof source === 'string' ? parseWorkflowJSON(source) : source;
  const assessment = inspectRecipePackage(input, { ...capabilities, schemaVersions: [1] });
  if (input.schemaVersion !== 1) {
    const problems = assessment.execution.missing;
    const message = problems.map(problem => `${problem.stepId ? `${problem.stepId}: ` : ''}${problem.message}`).join(' ');
    const error = new Error(`This recipe is valid but cannot run with the installed workflow executor. ${message}`);
    error.code = 'WORKFLOW_EXECUTOR_UNAVAILABLE';
    error.status = 422;
    error.details = { schemaVersion: input.schemaVersion, missing: problems };
    throw error;
  }
  // Keep the original v1 shape: its worker consumes string bindings and scalar parameter arrays.
  return validateWorkflowPackage(input);
}

// Validation describes a method. An installed executor separately declares what it can execute.
export function assessRecipeExecutability(input, capabilities = {}) {
  const recipe = normalizeRecipePackage(input);
  return assessValidatedRecipe(recipe, input.schemaVersion, capabilities);
}

function assessValidatedRecipe(recipe, schemaVersion, capabilities) {
  const missing = [];
  const reported = new Set();
  const require = (available, capability, message, stepId = null) => {
    const key = `${capability}:${stepId ?? ''}`;
    if (!available && !reported.has(key)) { missing.push({ capability, message, ...(stepId ? { stepId } : {}) }); reported.add(key); }
  };
  require((capabilities.schemaVersions ?? [1]).includes(schemaVersion), `schema:${schemaVersion}`, `No installed executor supports workflow schema ${schemaVersion}.`);
  for (const step of recipe.steps) {
    const kind = step.operation.kind;
    require((capabilities.operationKinds ?? ['r']).includes(kind), `operation:${kind}`, `No ${kind} operation executor is installed.`, step.id);
    if (kind !== 'human') {
      const environment = recipe.environments[step.environment];
      require((capabilities.environmentProfiles ?? []).includes(environment.profileId), `environment:${environment.profileId}`, `Environment ${environment.profileId} is unavailable.`, step.id);
      if (schemaVersion === 2 && environment.digest) require((capabilities.environmentDigests ?? []).includes(environment.digest), `environment-digest:${environment.digest}`, 'The exact environment version is unavailable.', step.id);
    }
    if (kind === 'tool') require((capabilities.toolAdapters ?? []).includes(step.operation.adapter), `tool:${step.operation.adapter}`, `Tool adapter ${step.operation.adapter} is unavailable.`, step.id);
    if (kind === 'r' && step.operation.state === 'kernel') require(capabilities.persistentKernel === true, 'persistent-kernel', 'This operation requires a persistent private R kernel.', step.id);
    if (step.operation.helpers?.length) require(capabilities.helperFiles === true, 'helper-files', 'The executor does not support helper files.', step.id);
    for (const port of [...Object.values(step.inputs), ...Object.values(step.outputs)]) {
      require((capabilities.artifactTypes ?? ['object', 'table', 'metrics', 'coordinates', 'figure']).includes(port.type), `artifact:${port.type}`, `Artifact type ${port.type} has no installed execution adapter.`, step.id);
      if (schemaVersion === 2 && port.format) require((capabilities.artifactFormats ?? Object.values(legacyFormats)).includes(port.format.id), `format:${port.format.id}`, `Artifact format ${port.format.id} has no installed execution adapter.`, step.id);
      if (port.cardinality === 'collection') require(capabilities.collections === true, 'collections', 'The executor does not support collection ports.', step.id);
    }
  }
  if (schemaVersion === 2 && (Object.keys(recipe.inputs).length !== 1 || !own(recipe.inputs, 'analysis'))) require(capabilities.rootInputs === true, 'root-inputs', 'The executor does not support arbitrary root inputs.');
  return { valid: true, executable: missing.length === 0, missing };
}

export function recipeVersionReference(recipe, digest) {
  const value = normalizeRecipePackage(recipe);
  return validateVersionReference({ id: value.id, version: value.version, digest: contractDigest(digest, 'Recipe digest') });
}
