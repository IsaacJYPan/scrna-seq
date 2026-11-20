'use strict';

// What verified code an agent can use before it writes its own (docs/agent-automation.md).
//
// Every built-in workflow release and every trusted library method is listed,
// with whether this project approved it. Agents are expected to choose from
// this list first and to write their own R in a sandbox only when nothing here
// fits, saying why when they do (sandboxes.submitRun requires that reason).

const trustedWorkflows = require('../../trusted-methods/workflows.json');

const GUIDANCE = [
  'Use verified code first. Each entry below is digest-pinned code that a person reviewed once; running it needs no new code review.',
  'If an entry fits but is not approved for this project, ask the sponsor to approve it, or submit a proposal (create_proposal), instead of re-implementing it.',
  'Approved entries run inside a study: list_studies, create_plan, submit_run.',
  'Write your own R (run_r_script) only when no entry covers the step. Give the reason, naming the entries you checked. Your code and its outputs are flagged as AI-written and stay drafts until a person reviews them.',
].join(' ');

function parameterSummary(schema) {
  return Object.entries(schema || {}).map(([key, entry]) => ({
    key,
    type: entry?.type || null,
    role: entry?.role || null,
    label: entry?.label || null,
  }));
}

function catalogEntry({ release, approved }) {
  const definition = release.definition || {};
  const method = definition.method || null;
  return {
    key: release.key,
    title: release.title,
    kind: method ? 'trusted-method' : 'built-in-workflow',
    approvedForProject: approved,
    releaseId: release.id,
    jobType: release.jobType,
    summary: method?.summary || null,
    category: method?.category || null,
    modalities: method?.modalities || null,
    upstream: method?.provenance ? { title: method.provenance.title || null, url: method.provenance.url || null } : null,
    deviations: method?.deviations || [],
    inputs: (definition.inputs || []).map((input) => ({ name: input.name, kind: input.kind || 'dataset' })),
    outputs: (definition.outputs || []).map((output) => ({ name: output.name, kind: output.kind })),
    parameters: parameterSummary(definition.parameterSchema),
  };
}

async function listVerifiedCode(approvals, projectId) {
  const catalog = await approvals.listCatalogForProject(projectId);
  const entries = catalog.map(catalogEntry);
  const keys = new Set(entries.map((entry) => entry.key));
  return {
    guidance: GUIDANCE,
    entries,
    // Reviewed chains of library methods; each step is still accepted by a person.
    workflows: (trustedWorkflows.workflows || []).map((workflow) => ({
      id: workflow.id,
      name: workflow.name,
      description: workflow.description || null,
      steps: (workflow.steps || []).map((step) => ({
        label: step.label || step.method,
        method: step.method,
        available: keys.has(step.method),
      })),
    })),
  };
}

module.exports = { listVerifiedCode, VERIFIED_CODE_GUIDANCE: GUIDANCE };
