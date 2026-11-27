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

// Verified code first. Every script an agent writes needs a person to review
// it, while reviewed workflows and library methods do not, so the server tells
// agents to look for verified code before writing their own.
export const MCP_INSTRUCTIONS = [
  'TraceOmics delegated-agent tools. Start with get_context to see what you may do.',
  'Prefer verified code. Call list_verified_code before any analysis: it lists every reviewed workflow and trusted library method, whether this project approved it, and reviewed multi-step chains.',
  'Run verified code through a study: list_studies, create_plan, submit_run, get_run, get_run_results.',
  'If a verified entry fits but is not approved or has no study, ask a person or use create_proposal rather than re-implementing it.',
  'Write your own R only when nothing verified covers the step: list_sandboxes, run_r_script (with its reason), get_sandbox_run, read_sandbox_file. That code is flagged as AI-written; inputs are read-only and outputs stay drafts until a person reviews and promotes them. Keep scripts short and close to standard Seurat and Bioconductor calls so they are quick to review.',
  'Everything you do is laid out for people as a notebook, filed under the analysis tab it serves (qc, normalize, pca, integrate, cluster, umap, deg, enrichment, cellchat, explore). Verified runs are placed automatically; give run_r_script the `tab` of the step it serves. Use add_notebook_note for a short Markdown note before or after a step (what you are about to do, what a result means); get_notebook reads back your cells. Notes and runs are append-only.',
  'Remote data: list_remote_files and read_remote_file use only folders granted to the sandbox. Use remoteInputs to stage files read-only. Figures: list_figures, view_figure, get_figure_history.',
  'After every run, record an interpretation with record_ledger_entry before the next run: what you observed, what it means biologically, the competing explanations, the result that would tell them apart, and the next step it implies; make the next run follow from that next step. A new sandbox run is refused (LEDGER_BEHIND) while more than one finished run has no interpretation. Characterize groups and contrasts with the characterize-groups trusted method (unbiased enrichment against full MSigDB collections) and interpret its strongest signals: the audit lists strong signals no entry mentions. Before a step whose outcome matters, record a prediction and later evaluate it.',
  'Analysis ledger: record your reasoning as you go with record_ledger_entry, not at the end; people watch it arrive in the notebook. A decision entry for every choice that could change results (thresholds, integration, resolution, gene sets). An annotation entry for every cluster you label (markers with values, confidence, alternatives). A finding entry for every claim you will make, with evidence naming the run, file and exact row/value. An issue entry the moment something looks unexpected. A check entry for each item of the standard checklist.',
  'Cite numbers from CSV/TSV outputs with a locator of the form "row <column>=<value>[, <column>=<value>...], column <column>" and the value as written in the file: the ledger compares it with the file and refuses a mismatch (EVIDENCE_VALUE_MISMATCH).',
  'Treat each issue as work, not as a caveat: investigate it with a follow-up run and resolve it with evidence, or accept it with a reason. If a short script could check a caveat, run it.',
  'After the first global clustering, re-cluster each major compartment the tissue has on its own (for example immune, lymphoid, myeloid, stromal, endothelial, neural, epithelial or tumor) and annotate the subtypes; global clusters hide them. Check each finding in every sample and record whether it holds in all, most, or one.',
  "Writing up: create_report, write_report_section, get_report to read reviewers' comments and revise. Before asking for review, call get_ledger_audit with the reportId and close every blocking gap. In the report, cite findings as [F:<entry id>], labels as [A:<entry id>] and interpretations as [N:<entry id>] so each claim links to its evidence.",
  'Ask a person (or create_proposal) for anything outside what you were given.',
].join(' ');
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

// Analysis tabs of the agent notebook; must match shared/agentNotebookTabs.mjs
// (checked by the tests). The CLI is standalone, so the list is repeated here.
export const NOTEBOOK_TABS = ['qc', 'normalize', 'pca', 'integrate', 'cluster', 'umap', 'deg', 'enrichment', 'cellchat', 'explore'];
const tabProp = { type: 'string', enum: NOTEBOOK_TABS, description: 'Analysis tab this belongs to in the notebook people read.' };
function tabArg(a) {
  if (!NOTEBOOK_TABS.includes(a.tab)) throw new ToolInputError(`tab must be one of: ${NOTEBOOK_TABS.join(', ')}.`);
  return a.tab;
}

// The standard checklist of shared/analysisLedger.mjs (checked by the tests).
export const LEDGER_CHECKLIST_KEYS = [
  'qc.thresholds', 'qc.doublets', 'qc.ambient', 'integrate.compare', 'cluster.resolution', 'cluster.sample-composition',
  'cluster.every-label', 'cluster.canonical-markers', 'cluster.subcluster', 'explore.orthogonal-support', 'deg.replicate-aware',
  'explore.cross-sample', 'explore.anomalies', 'cellchat.limitations',
];
const LEDGER_KINDS = ['decision', 'annotation', 'finding', 'issue', 'check', 'interpretation', 'prediction'];

const ID = {
  project: /^[A-Za-z0-9_-]{1,80}$/,
  study: /^study_[0-9a-f]{24}$/,
  plan: /^plan_[0-9a-f]{24}$/,
  run: /^run_[0-9a-f]{24}$/,
  proposal: /^prop_[0-9a-f]{24}$/,
  sandbox: /^sbx_[0-9a-f]{24}$/,
  sandboxRun: /^sbr_[0-9a-f]{24}$/,
  report: /^rep_[0-9a-f]{24}$/,
  ledgerEntry: /^led_[0-9a-f]{24}$/,
  object: /^[A-Za-z0-9_-]{1,80}$/,
  file: /^[A-Za-z0-9][A-Za-z0-9._/-]{0,159}$/,
  dataset: /^[A-Za-z0-9_-]{1,80}$/,
  figure: /^fig_[0-9a-f]+$/,
  root: /^[a-z][a-z0-9_-]{0,31}$/,
};

// Remote paths are relative to a folder a person pinned to the sandbox. The
// server is the boundary (it resolves real paths on the cluster); refusing
// absolute paths and ".." here keeps a confused agent from even asking.
const REMOTE_SEGMENT = /^[A-Za-z0-9_@+=,-][A-Za-z0-9_. @+=,-]{0,199}$/;
function remotePath(value, { required = false } = {}) {
  if (value === undefined || value === '') {
    if (required) throw new ToolInputError('path is required.');
    return '';
  }
  if (typeof value !== 'string' || value.startsWith('/') || value.includes('\\')
      || value.split('/').filter(Boolean).some((part) => part === '.' || part === '..' || !REMOTE_SEGMENT.test(part))) {
    throw new ToolInputError('path must be relative to the remote folder, without "." or "..".');
  }
  return value.split('/').filter(Boolean).join('/');
}

class ToolInputError extends Error {}

function str(args, name, pattern) {
  const value = args[name];
  if (typeof value !== 'string' || value === '') throw new ToolInputError(`${name} is required.`);
  if (pattern && !pattern.test(value)) throw new ToolInputError(`${name} is not a valid id.`);
  return value;
}

function optionalLimit(args) {
  if (args.limit === undefined) return '';
  if (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 999)
    throw new ToolInputError('limit must be an integer from 1 to 999.');
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
  tool(
    'get_context',
    "Show this agent's identity, sponsor, project, effective capabilities, and limits. Call this first.",
    {},
    [],
    () => ({ method: 'GET', path: '/context' })
  ),
  tool('get_project', 'Bounded summary of the project.', projectProp, ['projectId'], a => ({
    method: 'GET',
    path: project(a)
  })),
  tool(
    'list_datasets',
    'Datasets in the project (metadata only).',
    { ...projectProp, ...limitProp },
    ['projectId'],
    a => {
      const q = optionalLimit(a);
      return { method: 'GET', path: `${project(a)}/datasets${q ? `?${q}` : ''}` };
    }
  ),
  tool(
    'list_runs',
    "Completed project runs, or only this agent's runs with mine=true.",
    { ...projectProp, ...limitProp, mine: { type: 'boolean' } },
    ['projectId'],
    a => {
      const q = [a.mine === true ? 'scope=mine' : '', optionalLimit(a)].filter(Boolean).join('&');
      return { method: 'GET', path: `${project(a)}/runs${q ? `?${q}` : ''}` };
    }
  ),
  tool(
    'list_verified_code',
    'List reviewed workflows, trusted methods, their approval status, and reviewed multi-step chains. Check this before writing R.',
    projectProp,
    ['projectId'],
    a => ({ method: 'GET', path: `${project(a)}/verified-code` })
  ),
  tool(
    'list_workflows',
    'Workflow releases approved for this project, with parameter schemas.',
    projectProp,
    ['projectId'],
    a => ({ method: 'GET', path: `${project(a)}/workflows` })
  ),
  tool(
    'list_targets',
    'Compute targets (local, Slurm) and whether they are available.',
    projectProp,
    ['projectId'],
    a => ({ method: 'GET', path: `${project(a)}/targets` })
  ),
  tool(
    'list_studies',
    'Open studies this agent may work in: inputs, allowed parameter values, trial and compute budgets.',
    projectProp,
    ['projectId'],
    a => ({ method: 'GET', path: `${project(a)}/studies` })
  ),
  tool(
    'get_study',
    'One study with its full trial history.',
    { ...projectProp, studyId: { type: 'string' } },
    ['projectId', 'studyId'],
    a => ({ method: 'GET', path: `${project(a)}/studies/${str(a, 'studyId', ID.study)}` })
  ),
  tool(
    'create_plan',
    "Create an immutable execution plan for one trial. choices maps each varied parameter to one of the study's allowed values. Returns the plan and its digest; nothing runs until submit_run.",
    {
      ...projectProp,
      studyId: { type: 'string' },
      datasetId: { type: 'string' },
      choices: { type: 'object', additionalProperties: { type: ['number', 'string', 'boolean', 'null'] } }
    },
    ['projectId', 'studyId', 'datasetId'],
    a => {
      const choices = a.choices === undefined ? {} : a.choices;
      if (!choices || typeof choices !== 'object' || Array.isArray(choices))
        throw new ToolInputError('choices must be an object.');
      return {
        method: 'POST',
        path: `${project(a)}/plans`,
        body: { studyId: str(a, 'studyId', ID.study), datasetId: str(a, 'datasetId', ID.dataset), choices }
      };
    },
    { readOnly: false }
  ),
  tool('get_plan', 'Read a plan.', { ...projectProp, planId: { type: 'string' } }, ['projectId', 'planId'], a => ({
    method: 'GET',
    path: `${project(a)}/plans/${str(a, 'planId', ID.plan)}`
  })),
  tool(
    'submit_run',
    'Submit a plan for execution. Uses compute budget. Repeating the call with the same plan returns the original run instead of starting another.',
    { ...projectProp, planId: { type: 'string' }, planDigest: { type: 'string' }, requestId: { type: 'string' } },
    ['projectId', 'planId', 'planDigest'],
    a => {
      const planId = str(a, 'planId', ID.plan);
      const planDigest = str(a, 'planDigest', /^[0-9a-f]{64}$/);
      const requestId = a.requestId === undefined ? defaultRequestId(['run', planId, planDigest]) : str(a, 'requestId');
      return { method: 'POST', path: `${project(a)}/runs`, body: { planId, planDigest, requestId } };
    },
    { readOnly: false }
  ),
  tool(
    'get_run',
    'Run receipt and state (queued, running, candidate_ready, failed, ...).',
    { ...projectProp, runId: { type: 'string' } },
    ['projectId', 'runId'],
    a => ({ method: 'GET', path: `${project(a)}/runs/${str(a, 'runId', ID.run)}` })
  ),
  tool(
    'get_run_results',
    'Bounded result summary of a finished run. Results stay candidates until a person accepts one.',
    { ...projectProp, runId: { type: 'string' } },
    ['projectId', 'runId'],
    a => ({ method: 'GET', path: `${project(a)}/runs/${str(a, 'runId', ID.run)}/results` })
  ),
  tool(
    'cancel_run',
    "Cancel one of this agent's runs. The reserved budget is not refunded.",
    { ...projectProp, runId: { type: 'string' } },
    ['projectId', 'runId'],
    a => ({ method: 'POST', path: `${project(a)}/runs/${str(a, 'runId', ID.run)}/cancel`, body: {} }),
    { readOnly: false }
  ),
  tool(
    'inspect_run',
    'Bounded QC/stage diagnostics and scientific artifact metadata for your completed run. Requires results.inspect and labels disclosure.',
    { ...projectProp, runId: { type: 'string' } },
    ['projectId', 'runId'],
    a => ({ method: 'GET', path: `${project(a)}/runs/${str(a, 'runId', ID.run)}/inspection` })
  ),
  tool(
    'preview_artifact',
    'Verified bounded table page or standard PNG/SVG/PDF figure from your completed run. Set table to a named investigation table from inspect_run, or group to a cluster/cell-type label for marker/condition-DE CSV pages. Never accepts a path or source code.',
    {
      ...projectProp,
      runId: { type: 'string' },
      artifactId: { type: 'string' },
      table: { type: 'string' },
      group: { type: 'string' },
      offset: { type: 'integer', minimum: 0, maximum: 10000 },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
      format: { type: 'string', enum: ['png', 'svg', 'pdf'] }
    },
    ['projectId', 'runId', 'artifactId'],
    a => {
      const offset = a.offset ?? 0,
        limit = a.limit ?? 50;
      if (
        !Number.isInteger(offset) ||
        offset < 0 ||
        offset > 10000 ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 100
      )
        throw new ToolInputError('Invalid artifact page.');
      const format = a.format || 'png';
      if (!['png', 'svg', 'pdf'].includes(format)) throw new ToolInputError('Invalid figure format.');
      if (a.group !== undefined && (typeof a.group !== 'string' || !/^[A-Za-z0-9 ._+()-]{1,80}$/.test(a.group)))
        throw new ToolInputError('Invalid result group.');
      if (a.table !== undefined && (typeof a.table !== 'string' || !/^[a-z_]{1,40}$/.test(a.table)))
        throw new ToolInputError('Invalid investigation table.');
      return {
        method: 'GET',
        path: `${project(a)}/runs/${str(a, 'runId', ID.run)}/artifacts/${str(a, 'artifactId', /^art_[a-f0-9]+$/)}?offset=${offset}&limit=${limit}&format=${format}${a.table === undefined ? '' : `&table=${encodeURIComponent(a.table)}`}${a.group === undefined ? '' : `&group=${encodeURIComponent(a.group)}`}`
      };
    }
  ),
  // Figures people saved in the project gallery.
  tool('list_figures', 'Figures saved in the project gallery: plot type, the analysis each was drawn from, versions, and (with labels disclosure) titles, collections and captions.',
    projectProp, ['projectId'], (a) => ({ method: 'GET', path: `${project(a)}/figures` })),
  tool('view_figure', 'Look at one saved figure (its preview image) with its saved settings.',
    { ...projectProp, figureId: { type: 'string' } }, ['projectId', 'figureId'],
    (a) => ({ method: 'GET', path: `${project(a)}/figures/${str(a, 'figureId', ID.figure)}` }),
    { render: (data) => {
      const figure = data?.figure;
      if (!figure?.image?.base64) return null;
      const { image, ...metadata } = figure;
      return { content: [{ type: 'image', data: image.base64, mimeType: image.mimeType }, { type: 'text', text: JSON.stringify(metadata, null, 2) }] };
    } }),
  tool('get_figure_history', 'The minimal, dependency-ordered history behind selected figures: which analysis objects, server jobs and recorded steps they need (steps they do not need are listed as omitted), and one R script that reproduces them.',
    { ...projectProp, figureIds: { type: 'array', items: { type: 'string' }, maxItems: 50 } }, ['projectId', 'figureIds'],
    (a) => {
      if (!Array.isArray(a.figureIds) || a.figureIds.length === 0 || !a.figureIds.every((id) => typeof id === 'string' && ID.figure.test(id))) {
        throw new ToolInputError('figureIds must list figure ids.');
      }
      return { method: 'POST', path: `${project(a)}/figures/bundles`, body: { figureIds: a.figureIds } };
    }),

  tool(
    'create_proposal',
    'Submit an inert proposal (code diff, method change, or workflow) for a person to review. Nothing is executed.',
    {
      ...projectProp,
      kind: { type: 'string', enum: ['code', 'method', 'workflow'] },
      title: { type: 'string' },
      summary: { type: 'string' },
      body: { type: 'string', description: 'For example a unified diff.' },
      requestId: { type: 'string' }
    },
    ['projectId', 'kind', 'title'],
    a => {
      const base = project(a);
      const body = { kind: str(a, 'kind'), title: str(a, 'title') };
      if (a.summary !== undefined) body.summary = str(a, 'summary');
      if (a.body !== undefined) body.body = str(a, 'body');
      body.requestId =
        a.requestId === undefined
          ? defaultRequestId([base, body.kind, body.title, body.summary ?? '', body.body ?? ''])
          : str(a, 'requestId');
      return { method: 'POST', path: `${base}/proposals`, body };
    },
    { readOnly: false }
  ),
  tool('list_proposals', "This agent's proposals.", { ...projectProp, ...limitProp }, ['projectId'], a => {
    const q = optionalLimit(a);
    return { method: 'GET', path: `${project(a)}/proposals${q ? `?${q}` : ''}` };
  }),
  tool(
    'get_proposal',
    "One of this agent's proposals.",
    { ...projectProp, proposalId: { type: 'string' } },
    ['projectId', 'proposalId'],
    a => ({ method: 'GET', path: `${project(a)}/proposals/${str(a, 'proposalId', ID.proposal)}` })
  ),

  // Isolated development: the agent's own R scripts in a sandbox a person defined.
  tool(
    'list_sandboxes',
    'Sandboxes a person opened for this agent: the analyses you may read, run and compute budgets, and the R runtime (packages, helpers, limits).',
    projectProp,
    ['projectId'],
    a => ({ method: 'GET', path: `${project(a)}/sandboxes` })
  ),
  tool(
    'get_sandbox',
    "One sandbox with this agent's runs in it.",
    { ...projectProp, sandboxId: { type: 'string' } },
    ['projectId', 'sandboxId'],
    a => ({ method: 'GET', path: `${project(a)}/sandboxes/${str(a, 'sandboxId', ID.sandbox)}` })
  ),
  tool(
    'run_r_script',
    'Last resort: use only when list_verified_code has nothing that covers this step. Your script is flagged as AI-written code for a person to review. Give `reason`: which verified entries you checked and why none fits. Runs once in the sandbox: no network, a read-only copy of the input analysis as `obj` (a Seurat object). Save outputs with write_table(df, "name.csv"), save_figure(plot, "name.png"), or save_workspace(value, "name.rds"). Mark steps with "# ---- Step name ----" lines and keep error handling minimal: people read the steps. Outputs stay drafts until a person promotes them. Uses compute budget; repeating the same call returns the original run.',
    {
      ...projectProp,
      sandboxId: { type: 'string' },
      title: { type: 'string', description: 'What this run does, in a few words.' },
      script: { type: 'string', description: 'R source, at most 32 KiB.' },
      reason: { type: 'string', description: 'Why verified code does not cover this, naming the list_verified_code entries you checked (20-1000 characters). Shown to the reviewer.' },
      tab: tabProp,
      inputAnalysisObjectId: { type: 'string', description: 'One of the sandbox inputs; defaults to the first.' },
      remoteInputs: { type: 'array', maxItems: 5, description: 'Cluster sandboxes only: files from the sandbox\'s remote folders to copy in read-only. Read one in R with input_path("<root>/<path>").',
        items: { type: 'object', properties: { root: { type: 'string' }, path: { type: 'string' } }, required: ['root', 'path'], additionalProperties: false } },
      requestId: { type: 'string' }
    },
    ['projectId', 'sandboxId', 'title', 'script', 'reason', 'tab'],
    a => {
      const base = `${project(a)}/sandboxes/${str(a, 'sandboxId', ID.sandbox)}/runs`;
      const body = { title: str(a, 'title'), script: str(a, 'script'), reason: str(a, 'reason'), tab: tabArg(a) };
      if (a.inputAnalysisObjectId !== undefined)
        body.inputAnalysisObjectId = str(a, 'inputAnalysisObjectId', ID.object);
      if (a.remoteInputs !== undefined) {
        if (!Array.isArray(a.remoteInputs) || a.remoteInputs.length > 5) throw new ToolInputError('remoteInputs must list at most 5 files.');
        body.remoteInputs = a.remoteInputs.map((entry) => {
          if (!entry || typeof entry !== 'object') throw new ToolInputError('Each remote input needs root and path.');
          return { root: str(entry, 'root', ID.root), path: remotePath(entry.path, { required: true }) };
        });
      }
      body.requestId =
        a.requestId === undefined
          ? defaultRequestId([base, body.title, body.script, body.inputAnalysisObjectId ?? '', body.tab, ...(body.remoteInputs?.length ? [JSON.stringify(body.remoteInputs)] : [])])
          : str(a, 'requestId');
      return { method: 'POST', path: base, body };
    },
    { readOnly: false }
  ),
  tool(
    'get_sandbox_run',
    'State of a sandbox run (queued, running, draft_ready, failed, ...), its output files, the last lines of the R console, and any error.',
    { ...projectProp, runId: { type: 'string' } },
    ['projectId', 'runId'],
    a => ({ method: 'GET', path: `${project(a)}/sandbox-runs/${str(a, 'runId', ID.sandboxRun)}` })
  ),
  tool(
    'read_sandbox_file',
    'Read one output file of a finished sandbox run: tables and text as text (up to 256 KiB), PNG figures as images (up to 2 MiB).',
    {
      ...projectProp,
      runId: { type: 'string' },
      file: { type: 'string', description: 'Output file name, for example "markers.csv".' }
    },
    ['projectId', 'runId', 'file'],
    a => ({
      method: 'GET',
      path: `${project(a)}/sandbox-runs/${str(a, 'runId', ID.sandboxRun)}/files/${str(a, 'file', ID.file).split('/').map(encodeURIComponent).join('/')}`
    }),
    {
      render: data => {
        if (data?.kind === 'image' && data.mimeType === 'image/png' && typeof data.base64 === 'string') {
          return {
            content: [
              { type: 'image', data: data.base64, mimeType: 'image/png' },
              { type: 'text', text: `${data.name} (${data.sizeBytes} bytes)` }
            ]
          };
        }
        if (data?.kind === 'text' && typeof data.text === 'string')
          return { content: [{ type: 'text', text: data.text }] };
        return null;
      }
    }
  ),
  tool('list_remote_files', 'List a folder inside one of the sandbox\'s remote folders on the cluster (names, types, sizes). Paths are relative to that folder; nothing outside it can be reached.',
    { ...projectProp, sandboxId: { type: 'string' }, root: { type: 'string', description: 'Remote folder name from get_sandbox.' },
      path: { type: 'string', description: 'Relative folder path; empty for the top.' } },
    ['projectId', 'sandboxId', 'root'],
    (a) => {
      const rel = remotePath(a.path);
      return { method: 'GET', path: `${project(a)}/sandboxes/${str(a, 'sandboxId', ID.sandbox)}/remote/${str(a, 'root', ID.root)}${rel ? `?path=${encodeURIComponent(rel)}` : ''}` };
    }),
  tool('read_remote_file', 'Read a file in one of the sandbox\'s remote folders: text up to 256 KiB per call (use offset for more), PNG/SVG images up to 2 MiB. Binary data (h5, rds, mtx) cannot be read here; pass it to run_r_script as remoteInputs.',
    { ...projectProp, sandboxId: { type: 'string' }, root: { type: 'string' }, path: { type: 'string' },
      offset: { type: 'integer', minimum: 0 } },
    ['projectId', 'sandboxId', 'root', 'path'],
    (a) => {
      const rel = remotePath(a.path, { required: true });
      if (a.offset !== undefined && (!Number.isSafeInteger(a.offset) || a.offset < 0)) throw new ToolInputError('offset must be a non-negative integer.');
      const query = `path=${encodeURIComponent(rel)}${a.offset ? `&offset=${a.offset}` : ''}`;
      return { method: 'GET', path: `${project(a)}/sandboxes/${str(a, 'sandboxId', ID.sandbox)}/remote/${str(a, 'root', ID.root)}/file?${query}` };
    }, { render: (data) => {
      if (data?.kind === 'image' && data.mimeType === 'image/png' && typeof data.base64 === 'string') {
        return { content: [{ type: 'image', data: data.base64, mimeType: 'image/png' }, { type: 'text', text: `${data.root}/${data.path} (${data.sizeBytes} bytes)` }] };
      }
      if (data?.kind === 'image' && typeof data.base64 === 'string') {
        return { content: [{ type: 'text', text: Buffer.from(data.base64, 'base64').toString('utf8') }] };
      }
      if (data?.kind === 'text' && typeof data.text === 'string') {
        return { content: [{ type: 'text', text: data.truncated ? `${data.text}\n[truncated: call again with offset=${data.offset + Buffer.byteLength(data.text, 'utf8')}]` : data.text }] };
      }
      return null;
    } }),
  tool(
    'cancel_sandbox_run',
    "Cancel one of this agent's sandbox runs. The reserved budget is not refunded.",
    { ...projectProp, runId: { type: 'string' } },
    ['projectId', 'runId'],
    a => ({ method: 'POST', path: `${project(a)}/sandbox-runs/${str(a, 'runId', ID.sandboxRun)}/cancel`, body: {} }),
    { readOnly: false }
  ),

  // The agent notebook: cells filed by analysis tab, read top to bottom.
  tool('get_notebook', 'Your cells in the project notebook, oldest first: verified runs, your own scripts and your notes, each under its analysis tab. Pass `tab` for one tab only.',
    { ...projectProp, tab: tabProp }, ['projectId'],
    (a) => ({ method: 'GET', path: `${project(a)}/notebook${a.tab === undefined ? '' : `?tab=${encodeURIComponent(tabArg(a))}`}` })),
  tool('add_notebook_note', 'Add a short Markdown note to the notebook under an analysis tab, like a text cell: what the next step does and why, or what a result shows. Append-only; at most 8000 characters. Repeating the same call returns the original note.',
    { ...projectProp, tab: tabProp, markdown: { type: 'string', description: 'Markdown, at most 8000 characters.' }, requestId: { type: 'string' } },
    ['projectId', 'tab', 'markdown'],
    (a) => {
      const base = `${project(a)}/notebook/notes`;
      const body = { tab: tabArg(a), markdown: str(a, 'markdown') };
      body.requestId = a.requestId === undefined ? defaultRequestId([base, body.tab, body.markdown]) : str(a, 'requestId');
      return { method: 'POST', path: base, body };
    }, { readOnly: false }),

  // The analysis ledger: structured reasoning a reviewer can check claim by claim.
  tool(
    'record_ledger_entry',
    [
      'Record one entry in the analysis ledger. Common fields: kind, tab, title, evidence (list of {sandboxRunId or runId, file, locator, value}: the output that supports the entry, where in it, and the number read there).',
      'decision: choice, alternatives (list), rationale, impact (high|medium|low), optional sensitivity {checked, summary} (checked needs evidence).',
      'annotation: grouping (e.g. "seurat_clusters res0.6" or "myeloid_sub res0.5"), group, label, markers (2+ genes), confidence (high|medium|low), alternatives (required unless high), optional cells; needs evidence.',
      'finding: statement, confidence, sampleSupport (all|most|one|not_checked|not_applicable), optional limitations; needs evidence with a locator or value.',
      'issue: observation (opens it). Close it with a new issue entry {status: resolved|accepted, refersTo: <issue id>, resolution, evidence}.',
      `check: item (one of ${LEDGER_CHECKLIST_KEYS.join(', ')}), status (done|not_applicable|blocked), note (unless done), evidence when done.`,
      'interpretation (after every run, before the next): observation, meaning (biological mechanism, function or state), alternatives (competing explanations, technical and biological), test (the result that would tell them apart), nextStep, confidence; needs evidence. To evaluate a prediction add refersTo and outcome (confirmed|refuted|partly|inconclusive).',
      'prediction (before a step whose outcome matters): expectation, rationale.',
      'Append-only: a newer annotation for the same grouping and group, or a newer check for the same item, replaces the older one in the audit.',
    ].join(' '),
    {
      ...projectProp,
      entry: {
        type: 'object',
        description: 'The entry. kind is one of decision, annotation, finding, issue, check; tab is an analysis tab.',
        properties: { kind: { type: 'string', enum: LEDGER_KINDS }, tab: tabProp },
        required: ['kind', 'tab', 'title'],
      },
      requestId: { type: 'string' },
    },
    ['projectId', 'entry'],
    (a) => {
      if (!a.entry || typeof a.entry !== 'object' || Array.isArray(a.entry)) throw new ToolInputError('entry must be an object.');
      if (!LEDGER_KINDS.includes(a.entry.kind)) throw new ToolInputError(`entry.kind must be one of: ${LEDGER_KINDS.join(', ')}.`);
      tabArg(a.entry);
      const base = `${project(a)}/ledger`;
      const body = { ...a.entry };
      delete body.requestId;
      body.requestId = a.requestId === undefined ? defaultRequestId([base, JSON.stringify(body)]) : str(a, 'requestId');
      return { method: 'POST', path: base, body };
    },
    { readOnly: false }
  ),
  tool(
    'get_ledger',
    'Read back your analysis ledger entries in the order written, optionally only one kind.',
    { ...projectProp, kind: { type: 'string', enum: LEDGER_KINDS } },
    ['projectId'],
    (a) => {
      if (a.kind !== undefined && !LEDGER_KINDS.includes(a.kind)) throw new ToolInputError(`kind must be one of: ${LEDGER_KINDS.join(', ')}.`);
      return { method: 'GET', path: `${project(a)}/ledger${a.kind ? `?kind=${a.kind}` : ''}` };
    }
  ),
  tool(
    'get_ledger_audit',
    'The audit reviewers read before your report: blocking gaps (open issues, checklist items not addressed, report claims without ledger citations), items to review (single-sample findings, low-confidence labels, untested high-impact decisions), and the checklist. Pass reportId to check the report against the ledger. Close every blocking gap before asking for review.',
    { ...projectProp, reportId: { type: 'string' } },
    ['projectId'],
    (a) => ({
      method: 'GET',
      path: `${project(a)}/ledger/audit${a.reportId !== undefined ? `?reportId=${str(a, 'reportId', ID.report)}` : ''}`,
    })
  ),

  // Reports: draft sections for people to review.
  tool(
    'create_report',
    'Start a report (for example a paper draft). Sections are added with write_report_section and reviewed by people.',
    { ...projectProp, title: { type: 'string' }, requestId: { type: 'string' } },
    ['projectId', 'title'],
    a => {
      const base = `${project(a)}/reports`;
      const title = str(a, 'title');
      return {
        method: 'POST',
        path: base,
        body: { title, requestId: a.requestId === undefined ? defaultRequestId([base, title]) : str(a, 'requestId') }
      };
    },
    { readOnly: false }
  ),
  tool(
    'list_reports',
    "This agent's reports and the review status of each section.",
    projectProp,
    ['projectId'],
    a => ({ method: 'GET', path: `${project(a)}/reports` })
  ),
  tool(
    'get_report',
    "A report with every section, its version history, and reviewers' decisions and comments. Read this to see what to revise.",
    { ...projectProp, reportId: { type: 'string' } },
    ['projectId', 'reportId'],
    a => ({ method: 'GET', path: `${project(a)}/reports/${str(a, 'reportId', ID.report)}` })
  ),
  tool(
    'write_report_section',
    'Write or revise one section (Markdown). Writing the same key again creates a new version that needs a fresh review. Figures cite output files of your sandbox runs.',
    {
      ...projectProp,
      reportId: { type: 'string' },
      key: { type: 'string', description: 'Stable section id, for example "methods" or "results-clustering".' },
      heading: { type: 'string' },
      body: { type: 'string', description: 'Markdown, at most 64 KiB.' },
      position: {
        type: 'integer',
        minimum: 0,
        maximum: 999,
        description: 'Order in the report; defaults to the end, or the previous position for a revision.'
      },
      figures: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            sandboxRunId: { type: 'string' },
            file: { type: 'string' },
            caption: { type: 'string' }
          },
          required: ['sandboxRunId', 'file'],
          additionalProperties: false
        }
      },
      requestId: { type: 'string' }
    },
    ['projectId', 'reportId', 'key', 'heading', 'body'],
    a => {
      const base = `${project(a)}/reports/${str(a, 'reportId', ID.report)}/sections`;
      const body = {
        key: str(a, 'key'),
        heading: str(a, 'heading'),
        body: typeof a.body === 'string' ? a.body : str(a, 'body')
      };
      if (a.position !== undefined) body.position = a.position;
      if (a.figures !== undefined) {
        if (!Array.isArray(a.figures)) throw new ToolInputError('figures must be a list.');
        body.figures = a.figures;
      }
      body.requestId = a.requestId === undefined ? defaultRequestId([base, JSON.stringify(body)]) : str(a, 'requestId');
      return { method: 'POST', path: base, body };
    },
    { readOnly: false }
  )
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
      if (args !== undefined && (args === null || typeof args !== 'object' || Array.isArray(args)))
        throw new ToolInputError('arguments must be an object.');
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
    if(reply.response.ok&&name==='preview_artifact'&&(reply.data.imageBase64||reply.data.blob)){
      const {imageBase64,blob,...metadata}=reply.data;
      return {
        result: {
          content: [
            { type: 'text', text: JSON.stringify(metadata) },
            ...(imageBase64
              ? [{ type: 'image', data: imageBase64, mimeType: 'image/png' }]
              : [
                  {
                    type: 'resource',
                    resource: {
                      uri: `traceomics:figure/${metadata.artifactId}.${metadata.format}`,
                      mimeType: metadata.mimeType,
                      blob
                    }
                  }
                ])
          ]
        }
      };
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
      outcome = {
        result: {
          protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: MCP_INSTRUCTIONS
        }
      };
    } else if (method === 'ping') {
      outcome = { result: {} };
    } else if (method === 'tools/list') {
      outcome = {
        result: {
          tools: TOOLS.map(({ name, description, inputSchema, annotations }) => ({
            name,
            description,
            inputSchema,
            annotations
          }))
        }
      };
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
