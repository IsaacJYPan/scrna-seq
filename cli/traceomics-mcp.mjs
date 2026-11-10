#!/usr/bin/env node
// MCP server (stdio) over the TraceOmics automation API (docs/spec.md phase 5).
//
// It exposes the same operations as cli/traceomics.mjs as MCP tools, so an MCP
// client such as an AI coding assistant can plan and run approved workflows.
// It holds no authority of its own: every rule is enforced by the server, and
// the agent credential comes from TRACEOMICS_AGENT_TOKEN or
// TRACEOMICS_AGENT_TOKEN_FILE, never from a tool argument.
//
// Transport: newline-delimited JSON-RPC 2.0 on stdin/stdout. Logs go to stderr.

import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { defaultRequestId, readToken, sendRequest } from './traceomics.mjs';

const SERVER_INFO = { name: 'traceomics', version: '1.0.0' };
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const ID = {
  project: /^[A-Za-z0-9_-]{1,80}$/,
  study: /^study_[0-9a-f]{24}$/,
  plan: /^plan_[0-9a-f]{24}$/,
  run: /^run_[0-9a-f]{24}$/,
  proposal: /^prop_[0-9a-f]{24}$/,
  sandbox: /^sbx_[0-9a-f]{24}$/,
  sandboxRun: /^sbr_[0-9a-f]{24}$/,
  report: /^rep_[0-9a-f]{24}$/,
  object: /^[A-Za-z0-9_-]{1,80}$/,
  file: /^[A-Za-z0-9][A-Za-z0-9._/-]{0,159}$/,
  dataset: /^[A-Za-z0-9_-]{1,80}$/,
};

class ToolInputError extends Error {}

function str(args, name, pattern) {
  const value = args[name];
  if (typeof value !== 'string' || value === '') throw new ToolInputError(`${name} is required.`);
  if (pattern && !pattern.test(value)) throw new ToolInputError(`${name} is not a valid id.`);
  return value;
}

function optionalLimit(args) {
  if (args.limit === undefined) return '';
  if (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 999) throw new ToolInputError('limit must be an integer from 1 to 999.');
  return `limit=${args.limit}`;
}

const project = (args) => `/projects/${str(args, 'projectId', ID.project)}`;
const projectProp = { projectId: { type: 'string', description: 'Project id.' } };
const limitProp = { limit: { type: 'integer', minimum: 1, maximum: 999 } };

function tool(name, description, properties, required, build, { readOnly = true, render } = {}) {
  return {
    name, description, build, render,
    inputSchema: { type: 'object', properties, required, additionalProperties: false },
    annotations: { readOnlyHint: readOnly, openWorldHint: false },
  };
}

export const TOOLS = [
  tool('get_context', 'Show this agent\'s identity, sponsor, project, effective capabilities, and limits. Call this first.',
    {}, [], () => ({ method: 'GET', path: '/context' })),
  tool('get_project', 'Bounded summary of the project.', projectProp, ['projectId'],
    (a) => ({ method: 'GET', path: project(a) })),
  tool('list_datasets', 'Datasets in the project (metadata only).', { ...projectProp, ...limitProp }, ['projectId'],
    (a) => { const q = optionalLimit(a); return { method: 'GET', path: `${project(a)}/datasets${q ? `?${q}` : ''}` }; }),
  tool('list_runs', 'Completed project runs, or only this agent\'s runs with mine=true.',
    { ...projectProp, ...limitProp, mine: { type: 'boolean' } }, ['projectId'],
    (a) => {
      const q = [a.mine === true ? 'scope=mine' : '', optionalLimit(a)].filter(Boolean).join('&');
      return { method: 'GET', path: `${project(a)}/runs${q ? `?${q}` : ''}` };
    }),
  tool('list_workflows', 'Workflow releases approved for this project, with parameter schemas.', projectProp, ['projectId'],
    (a) => ({ method: 'GET', path: `${project(a)}/workflows` })),
  tool('list_targets', 'Compute targets (local, Slurm) and whether they are available.', projectProp, ['projectId'],
    (a) => ({ method: 'GET', path: `${project(a)}/targets` })),
  tool('list_studies', 'Open studies this agent may work in: inputs, allowed parameter values, trial and compute budgets.',
    projectProp, ['projectId'], (a) => ({ method: 'GET', path: `${project(a)}/studies` })),
  tool('get_study', 'One study with its full trial history.', { ...projectProp, studyId: { type: 'string' } }, ['projectId', 'studyId'],
    (a) => ({ method: 'GET', path: `${project(a)}/studies/${str(a, 'studyId', ID.study)}` })),
  tool('create_plan', 'Create an immutable execution plan for one trial. choices maps each varied parameter to one of the study\'s allowed values. Returns the plan and its digest; nothing runs until submit_run.',
    { ...projectProp, studyId: { type: 'string' }, datasetId: { type: 'string' },
      choices: { type: 'object', additionalProperties: { type: ['number', 'string', 'boolean', 'null'] } } },
    ['projectId', 'studyId', 'datasetId'],
    (a) => {
      const choices = a.choices === undefined ? {} : a.choices;
      if (!choices || typeof choices !== 'object' || Array.isArray(choices)) throw new ToolInputError('choices must be an object.');
      return { method: 'POST', path: `${project(a)}/plans`,
        body: { studyId: str(a, 'studyId', ID.study), datasetId: str(a, 'datasetId', ID.dataset), choices } };
    }, { readOnly: false }),
  tool('get_plan', 'Read a plan.', { ...projectProp, planId: { type: 'string' } }, ['projectId', 'planId'],
    (a) => ({ method: 'GET', path: `${project(a)}/plans/${str(a, 'planId', ID.plan)}` })),
  tool('submit_run', 'Submit a plan for execution. Uses compute budget. Repeating the call with the same plan returns the original run instead of starting another.',
    { ...projectProp, planId: { type: 'string' }, planDigest: { type: 'string' }, requestId: { type: 'string' } },
    ['projectId', 'planId', 'planDigest'],
    (a) => {
      const planId = str(a, 'planId', ID.plan);
      const planDigest = str(a, 'planDigest', /^[0-9a-f]{64}$/);
      const requestId = a.requestId === undefined ? defaultRequestId(['run', planId, planDigest]) : str(a, 'requestId');
      return { method: 'POST', path: `${project(a)}/runs`, body: { planId, planDigest, requestId } };
    }, { readOnly: false }),
  tool('get_run', 'Run receipt and state (queued, running, candidate_ready, failed, ...).', { ...projectProp, runId: { type: 'string' } },
    ['projectId', 'runId'], (a) => ({ method: 'GET', path: `${project(a)}/runs/${str(a, 'runId', ID.run)}` })),
  tool('get_run_results', 'Bounded result summary of a finished run. Results stay candidates until a person accepts one.',
    { ...projectProp, runId: { type: 'string' } }, ['projectId', 'runId'],
    (a) => ({ method: 'GET', path: `${project(a)}/runs/${str(a, 'runId', ID.run)}/results` })),
  tool('cancel_run', 'Cancel one of this agent\'s runs. The reserved budget is not refunded.',
    { ...projectProp, runId: { type: 'string' } }, ['projectId', 'runId'],
    (a) => ({ method: 'POST', path: `${project(a)}/runs/${str(a, 'runId', ID.run)}/cancel`, body: {} }), { readOnly: false }),
  tool('create_proposal', 'Submit an inert proposal (code diff, method change, or workflow) for a person to review. Nothing is executed.',
    { ...projectProp, kind: { type: 'string', enum: ['code', 'method', 'workflow'] }, title: { type: 'string' },
      summary: { type: 'string' }, body: { type: 'string', description: 'For example a unified diff.' }, requestId: { type: 'string' } },
    ['projectId', 'kind', 'title'],
    (a) => {
      const base = project(a);
      const body = { kind: str(a, 'kind'), title: str(a, 'title') };
      if (a.summary !== undefined) body.summary = str(a, 'summary');
      if (a.body !== undefined) body.body = str(a, 'body');
      body.requestId = a.requestId === undefined
        ? defaultRequestId([base, body.kind, body.title, body.summary ?? '', body.body ?? ''])
        : str(a, 'requestId');
      return { method: 'POST', path: `${base}/proposals`, body };
    }, { readOnly: false }),
  tool('list_proposals', 'This agent\'s proposals.', { ...projectProp, ...limitProp }, ['projectId'],
    (a) => { const q = optionalLimit(a); return { method: 'GET', path: `${project(a)}/proposals${q ? `?${q}` : ''}` }; }),
  tool('get_proposal', 'One of this agent\'s proposals.', { ...projectProp, proposalId: { type: 'string' } }, ['projectId', 'proposalId'],
    (a) => ({ method: 'GET', path: `${project(a)}/proposals/${str(a, 'proposalId', ID.proposal)}` })),

  // Isolated development: the agent's own R scripts in a sandbox a person defined.
  tool('list_sandboxes', 'Sandboxes a person opened for this agent: the analyses you may read, run and compute budgets, and the R runtime (packages, helpers, limits).',
    projectProp, ['projectId'], (a) => ({ method: 'GET', path: `${project(a)}/sandboxes` })),
  tool('get_sandbox', 'One sandbox with this agent\'s runs in it.', { ...projectProp, sandboxId: { type: 'string' } }, ['projectId', 'sandboxId'],
    (a) => ({ method: 'GET', path: `${project(a)}/sandboxes/${str(a, 'sandboxId', ID.sandbox)}` })),
  tool('run_r_script', 'Run your own R script once in the sandbox: no network, a read-only copy of the input analysis as `obj` (a Seurat object). Save outputs with write_table(df, "name.csv"), save_figure(plot, "name.png"), or save_workspace(value, "name.rds"). Mark steps with "# ---- Step name ----" lines and keep error handling minimal: people read the steps. Outputs stay drafts until a person promotes them. Uses compute budget; repeating the same call returns the original run.',
    { ...projectProp, sandboxId: { type: 'string' }, title: { type: 'string', description: 'What this run does, in a few words.' },
      script: { type: 'string', description: 'R source, at most 32 KiB.' },
      inputAnalysisObjectId: { type: 'string', description: 'One of the sandbox inputs; defaults to the first.' },
      requestId: { type: 'string' } },
    ['projectId', 'sandboxId', 'title', 'script'],
    (a) => {
      const base = `${project(a)}/sandboxes/${str(a, 'sandboxId', ID.sandbox)}/runs`;
      const body = { title: str(a, 'title'), script: str(a, 'script') };
      if (a.inputAnalysisObjectId !== undefined) body.inputAnalysisObjectId = str(a, 'inputAnalysisObjectId', ID.object);
      body.requestId = a.requestId === undefined
        ? defaultRequestId([base, body.title, body.script, body.inputAnalysisObjectId ?? ''])
        : str(a, 'requestId');
      return { method: 'POST', path: base, body };
    }, { readOnly: false }),
  tool('get_sandbox_run', 'State of a sandbox run (queued, running, draft_ready, failed, ...), its output files, the last lines of the R console, and any error.',
    { ...projectProp, runId: { type: 'string' } }, ['projectId', 'runId'],
    (a) => ({ method: 'GET', path: `${project(a)}/sandbox-runs/${str(a, 'runId', ID.sandboxRun)}` })),
  tool('read_sandbox_file', 'Read one output file of a finished sandbox run: tables and text as text (up to 256 KiB), PNG figures as images (up to 2 MiB).',
    { ...projectProp, runId: { type: 'string' }, file: { type: 'string', description: 'Output file name, for example "markers.csv".' } },
    ['projectId', 'runId', 'file'],
    (a) => ({ method: 'GET', path: `${project(a)}/sandbox-runs/${str(a, 'runId', ID.sandboxRun)}/files/${str(a, 'file', ID.file).split('/').map(encodeURIComponent).join('/')}` }),
    { render: (data) => {
      if (data?.kind === 'image' && data.mimeType === 'image/png' && typeof data.base64 === 'string') {
        return { content: [{ type: 'image', data: data.base64, mimeType: 'image/png' }, { type: 'text', text: `${data.name} (${data.sizeBytes} bytes)` }] };
      }
      if (data?.kind === 'text' && typeof data.text === 'string') return { content: [{ type: 'text', text: data.text }] };
      return null;
    } }),
  tool('cancel_sandbox_run', 'Cancel one of this agent\'s sandbox runs. The reserved budget is not refunded.',
    { ...projectProp, runId: { type: 'string' } }, ['projectId', 'runId'],
    (a) => ({ method: 'POST', path: `${project(a)}/sandbox-runs/${str(a, 'runId', ID.sandboxRun)}/cancel`, body: {} }), { readOnly: false }),

  // Reports: draft sections for people to review.
  tool('create_report', 'Start a report (for example a paper draft). Sections are added with write_report_section and reviewed by people.',
    { ...projectProp, title: { type: 'string' }, requestId: { type: 'string' } }, ['projectId', 'title'],
    (a) => {
      const base = `${project(a)}/reports`;
      const title = str(a, 'title');
      return { method: 'POST', path: base, body: { title, requestId: a.requestId === undefined ? defaultRequestId([base, title]) : str(a, 'requestId') } };
    }, { readOnly: false }),
  tool('list_reports', 'This agent\'s reports and the review status of each section.', projectProp, ['projectId'],
    (a) => ({ method: 'GET', path: `${project(a)}/reports` })),
  tool('get_report', 'A report with every section, its version history, and reviewers\' decisions and comments. Read this to see what to revise.',
    { ...projectProp, reportId: { type: 'string' } }, ['projectId', 'reportId'],
    (a) => ({ method: 'GET', path: `${project(a)}/reports/${str(a, 'reportId', ID.report)}` })),
  tool('write_report_section', 'Write or revise one section (Markdown). Writing the same key again creates a new version that needs a fresh review. Figures cite output files of your sandbox runs.',
    { ...projectProp, reportId: { type: 'string' },
      key: { type: 'string', description: 'Stable section id, for example "methods" or "results-clustering".' },
      heading: { type: 'string' }, body: { type: 'string', description: 'Markdown, at most 64 KiB.' },
      position: { type: 'integer', minimum: 0, maximum: 999, description: 'Order in the report; defaults to the end, or the previous position for a revision.' },
      figures: { type: 'array', items: { type: 'object', properties: {
        sandboxRunId: { type: 'string' }, file: { type: 'string' }, caption: { type: 'string' } },
        required: ['sandboxRunId', 'file'], additionalProperties: false } },
      requestId: { type: 'string' } },
    ['projectId', 'reportId', 'key', 'heading', 'body'],
    (a) => {
      const base = `${project(a)}/reports/${str(a, 'reportId', ID.report)}/sections`;
      const body = { key: str(a, 'key'), heading: str(a, 'heading'), body: typeof a.body === 'string' ? a.body : str(a, 'body') };
      if (a.position !== undefined) body.position = a.position;
      if (a.figures !== undefined) {
        if (!Array.isArray(a.figures)) throw new ToolInputError('figures must be a list.');
        body.figures = a.figures;
      }
      body.requestId = a.requestId === undefined ? defaultRequestId([base, JSON.stringify(body)]) : str(a, 'requestId');
      return { method: 'POST', path: base, body };
    }, { readOnly: false }),
];
const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

const textResult = (value, isError = false) => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
  ...(isError ? { isError: true } : {}),
});

export function createMcpServer({ env = process.env, fetchImpl = globalThis.fetch, readFile = (p) => readFileSync(p, 'utf8') } = {}) {
  async function callTool(name, args) {
    const definition = BY_NAME.get(name);
    if (!definition) return { error: { code: -32602, message: `Unknown tool: ${name}` } };
    let request;
    let token;
    try {
      if (args !== undefined && (args === null || typeof args !== 'object' || Array.isArray(args))) throw new ToolInputError('arguments must be an object.');
      const input = args || {};
      const allowed = Object.keys(definition.inputSchema.properties);
      const unknown = Object.keys(input).filter((k) => !allowed.includes(k));
      if (unknown.length) throw new ToolInputError(`Unknown argument: ${unknown[0]}`);
      request = definition.build(input);
      token = readToken({ tokenFile: env.TRACEOMICS_AGENT_TOKEN_FILE }, env, readFile);
    } catch (error) {
      if (error instanceof ToolInputError) return { result: textResult(error.message, true) };
      return { result: textResult(error.message || 'The agent credential could not be read.', true) };
    }
    const reply = await sendRequest(request, { env, token, fetchImpl });
    if (reply.failure) return { result: textResult(reply.failure, true) };
    if (reply.response.ok && definition.render) {
      const rendered = definition.render(reply.data);
      if (rendered) return { result: rendered };
    }
    return { result: textResult(reply.data, !reply.response.ok) };
  }

  // Handles one parsed JSON-RPC message; returns the response object or null for notifications.
  async function handle(message) {
    if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      return { jsonrpc: '2.0', id: message?.id ?? null, error: { code: -32600, message: 'Invalid request' } };
    }
    const { id, method, params } = message;
    const isNotification = id === undefined;
    let outcome;
    if (method === 'initialize') {
      const requested = params?.protocolVersion;
      outcome = { result: {
        protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: 'TraceOmics delegated-agent tools. Start with get_context to see what you may do. Approved workflows: list_studies, create_plan, submit_run, get_run, get_run_results. Your own analysis code: list_sandboxes, run_r_script, get_sandbox_run, read_sandbox_file (inputs are read-only and outputs stay drafts until a person promotes them). Writing up: create_report, write_report_section, get_report to read reviewers\' comments and revise. Ask a person (or create_proposal) for anything outside what you were given.',
      } };
    } else if (method === 'ping') {
      outcome = { result: {} };
    } else if (method === 'tools/list') {
      outcome = { result: { tools: TOOLS.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations })) } };
    } else if (method === 'tools/call') {
      outcome = await callTool(params?.name, params?.arguments);
    } else if (method.startsWith('notifications/')) {
      return null;
    } else {
      outcome = { error: { code: -32601, message: `Method not found: ${method}` } };
    }
    if (isNotification) return null;
    return { jsonrpc: '2.0', id, ...outcome };
  }

  return { handle, callTool };
}

export function serveStdio({ input = process.stdin, output = process.stdout, ...options } = {}) {
  const server = createMcpServer(options);
  const lines = createInterface({ input, crlfDelay: Infinity });
  let closed = false;
  // The client went away (for example it closed the pipe): stop quietly.
  output.on('error', () => { closed = true; lines.close(); });
  const write = (msg) => { if (msg && !closed) output.write(`${JSON.stringify(msg)}\n`); };
  const pending = new Set();
  lines.on('line', (line) => {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); } catch {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    const messages = Array.isArray(message) ? message : [message];
    for (const m of messages) {
      const task = server.handle(m).then(write, (error) => {
        process.stderr.write(`traceomics-mcp: ${error?.message || error}\n`);
        write({ jsonrpc: '2.0', id: m?.id ?? null, error: { code: -32603, message: 'Internal error' } });
      }).finally(() => pending.delete(task));
      pending.add(task);
    }
  });
  return new Promise((resolve) => lines.on('close', () => Promise.all(pending).then(resolve)));
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  serveStdio();
}
