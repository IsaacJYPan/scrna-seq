#!/usr/bin/env node
// Thin agent client for the TraceOmics automation API (docs/spec.md 15.2).
//
// It holds no authority of its own: every rule is enforced by the server. The
// credential is read from TRACEOMICS_AGENT_TOKEN or --token-file, never from
// argv (argv is visible to other local processes). JSON results go to stdout;
// diagnostics go to stderr. The command is always non-interactive.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const EXIT = Object.freeze({
  OK: 0, ERROR: 1, USAGE: 2, AUTH: 3, DENIED: 4, NOT_FOUND: 5, CONFLICT: 6, UNAVAILABLE: 7,
});
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_PATCH_BYTES = 262144;

const USAGE = `Usage: traceomics <command> [options]

Commands:
  context                                   Show this agent's identity, sponsor, and limits
  project show     --project <id>           Bounded project summary
  datasets list    --project <id> [--limit N]
  runs list        --project <id> [--mine] [--limit N]
  workflows list   --project <id>           Approved workflow releases
  targets list     --project <id>           Compute targets (local, Slurm) and availability
  studies list     --project <id>
  studies show     --project <id> <study-id>
  plans create     --project <id> --study <id> --dataset <id> [--choice name=value ...]
  plans show       --project <id> <plan-id>
  runs submit      --project <id> --plan <plan-id> --digest <sha256> [--request-id <id>]
  runs status      --project <id> <run-id>
  runs results     --project <id> <run-id>
  runs cancel      --project <id> <run-id>
  proposals create --project <id> --kind <code|method|workflow> --title <text>
                   [--summary <text>] [--patch <file>] [--request-id <id>]
  proposals list   --project <id> [--limit N]
  proposals show   --project <id> <proposal-id>

Environment:
  TRACEOMICS_URL           Server origin (default http://127.0.0.1:3000)
  TRACEOMICS_AGENT_TOKEN   Agent credential (or use --token-file <path>)

Output is JSON on stdout. Exit codes: 0 ok, 2 usage, 3 credential, 4 denied,
5 not found, 6 conflict or limit, 7 unavailable, 1 other.`;

class UsageError extends Error {}

export function parseArgs(argv) {
  const positional = [];
  const options = {};
  const flags = new Set(['help', 'json', 'mine']);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') { positional.push(...argv.slice(i + 1)); break; }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const name = (eq === -1 ? arg.slice(2) : arg.slice(2, eq)).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      if (name === 'token') throw new UsageError('Pass the credential with TRACEOMICS_AGENT_TOKEN or --token-file, not on the command line.');
      if (flags.has(name)) { options[name] = true; continue; }
      const value = eq === -1 ? argv[i + 1] : arg.slice(eq + 1);
      if (value === undefined || (eq === -1 && value.startsWith('--'))) throw new UsageError(`--${arg.slice(2)} needs a value.`);
      if (eq === -1) i += 1;
      if (name === 'choice') (options.choice ||= []).push(value);
      else options[name] = value;
    } else {
      positional.push(arg);
    }
  }
  return { positional, options };
}

function requireOption(options, name) {
  if (typeof options[name] !== 'string' || options[name] === '') throw new UsageError(`--${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} is required.`);
  return options[name];
}

function limitQuery(options) {
  if (options.limit === undefined) return '';
  if (!/^[1-9][0-9]{0,2}$/.test(options.limit)) throw new UsageError('--limit must be a number from 1 to 999.');
  return `?limit=${options.limit}`;
}

function projectPath(options) {
  const id = requireOption(options, 'project');
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw new UsageError('--project is not a valid project id.');
  return `/projects/${id}`;
}

function oneId(rest, pattern, label) {
  if (rest.length !== 1 || !pattern.test(rest[0])) throw new UsageError(`Give one ${label} id.`);
  return rest[0];
}

// --choice values: JSON literals (numbers, booleans, null, quoted strings) or bare strings.
export function parseChoice(text) {
  try {
    const value = JSON.parse(text);
    if (value === null || ['number', 'boolean', 'string'].includes(typeof value)) return value;
  } catch { /* bare string */ }
  return text;
}

// The default request id is derived from the content, so re-running the same
// command after a lost reply replays the original submission instead of
// creating a duplicate.
export function defaultRequestId(fields) {
  return `cli-${createHash('sha256').update(JSON.stringify(fields)).digest('hex').slice(0, 40)}`;
}

export function buildRequest({ positional, options }, { readFile = (p) => readFileSync(p, 'utf8') } = {}) {
  const [group, action, ...rest] = positional;
  if (!group || options.help) return { help: true };
  if (group === 'context' && action === undefined) return { method: 'GET', path: '/context' };
  if (group === 'project' && action === 'show') return { method: 'GET', path: projectPath(options) };
  if (group === 'datasets' && action === 'list') return { method: 'GET', path: `${projectPath(options)}/datasets${limitQuery(options)}` };
  if (group === 'runs' && action === 'list') {
    const query = [options.mine ? 'scope=mine' : '', limitQuery(options).slice(1)].filter(Boolean).join('&');
    return { method: 'GET', path: `${projectPath(options)}/runs${query ? `?${query}` : ''}` };
  }
  if (group === 'workflows' && action === 'list') return { method: 'GET', path: `${projectPath(options)}/workflows` };
  if (group === 'targets' && action === 'list') return { method: 'GET', path: `${projectPath(options)}/targets` };
  if (group === 'studies' && action === 'list') return { method: 'GET', path: `${projectPath(options)}/studies` };
  if (group === 'studies' && action === 'show') return { method: 'GET', path: `${projectPath(options)}/studies/${oneId(rest, /^study_[0-9a-f]{24}$/, 'study')}` };
  if (group === 'plans' && action === 'show') return { method: 'GET', path: `${projectPath(options)}/plans/${oneId(rest, /^plan_[0-9a-f]{24}$/, 'plan')}` };
  if (group === 'plans' && action === 'create') {
    const choices = {};
    for (const entry of options.choice || []) {
      const eq = entry.indexOf('=');
      if (eq < 1) throw new UsageError('--choice must be name=value.');
      choices[entry.slice(0, eq)] = parseChoice(entry.slice(eq + 1));
    }
    return { method: 'POST', path: `${projectPath(options)}/plans`,
      body: { studyId: requireOption(options, 'study'), datasetId: requireOption(options, 'dataset'), choices } };
  }
  if (group === 'runs' && action === 'submit') {
    const planId = requireOption(options, 'plan');
    const planDigest = requireOption(options, 'digest');
    // Derived from the plan, so re-running after a lost reply returns the original receipt.
    const requestId = options.requestId || defaultRequestId(['run', planId, planDigest]);
    return { method: 'POST', path: `${projectPath(options)}/runs`, body: { planId, planDigest, requestId } };
  }
  if (group === 'runs' && ['status', 'results', 'cancel'].includes(action)) {
    const id = oneId(rest, /^run_[0-9a-f]{24}$/, 'run');
    if (action === 'status') return { method: 'GET', path: `${projectPath(options)}/runs/${id}` };
    if (action === 'results') return { method: 'GET', path: `${projectPath(options)}/runs/${id}/results` };
    return { method: 'POST', path: `${projectPath(options)}/runs/${id}/cancel`, body: {} };
  }
  if (group === 'proposals' && action === 'list') return { method: 'GET', path: `${projectPath(options)}/proposals${limitQuery(options)}` };
  if (group === 'proposals' && action === 'show') {
    if (rest.length !== 1 || !/^prop_[0-9a-f]{24}$/.test(rest[0])) throw new UsageError('proposals show needs one proposal id.');
    return { method: 'GET', path: `${projectPath(options)}/proposals/${rest[0]}` };
  }
  if (group === 'proposals' && action === 'create') {
    const base = projectPath(options);
    const kind = requireOption(options, 'kind');
    const title = requireOption(options, 'title');
    let patch;
    if (options.patch !== undefined) {
      patch = readFile(options.patch);
      if (Buffer.byteLength(patch, 'utf8') > MAX_PATCH_BYTES) throw new UsageError(`--patch must be at most ${MAX_PATCH_BYTES} bytes.`);
    }
    const body = { kind, title };
    if (options.summary !== undefined) body.summary = options.summary;
    if (patch !== undefined) body.body = patch;
    body.requestId = options.requestId || defaultRequestId([base, kind, title, body.summary ?? '', patch ?? '']);
    return { method: 'POST', path: `${base}/proposals`, body };
  }
  throw new UsageError(`Unknown command: ${positional.join(' ')}`);
}

export function exitCodeFor(status) {
  if (status >= 200 && status < 300) return EXIT.OK;
  if (status === 401) return EXIT.AUTH;
  if (status === 403) return EXIT.DENIED;
  if (status === 404) return EXIT.NOT_FOUND;
  if (status === 409 || status === 413 || status === 429) return EXIT.CONFLICT;
  if (status === 501 || status === 503) return EXIT.UNAVAILABLE;
  if (status === 400) return EXIT.USAGE;
  return EXIT.ERROR;
}

function readToken(options, env, readFile) {
  let token = env.TRACEOMICS_AGENT_TOKEN;
  if (options.tokenFile) token = readFile(options.tokenFile).trim();
  if (!token) throw new UsageError('Set TRACEOMICS_AGENT_TOKEN or pass --token-file.');
  if (!/^tro_agent_[A-Za-z0-9_-]{43}$/.test(token)) throw new UsageError('The agent credential is not in the expected format.');
  return token;
}

async function readBounded(response) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error('Response exceeded the size limit.'); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function run(argv, { env = process.env, stdout = process.stdout, stderr = process.stderr,
  fetchImpl = globalThis.fetch, readFile = (p) => readFileSync(p, 'utf8') } = {}) {
  let request;
  let token;
  try {
    const parsed = parseArgs(argv);
    request = buildRequest(parsed, { readFile });
    if (request.help) { stderr.write(`${USAGE}\n`); return parsed.options.help ? EXIT.OK : EXIT.USAGE; }
    token = readToken(parsed.options, env, readFile);
  } catch (error) {
    if (error instanceof UsageError) { stderr.write(`traceomics: ${error.message}\n`); return EXIT.USAGE; }
    stderr.write(`traceomics: ${error.code === 'ENOENT' ? 'file not found' : 'could not read input'}\n`);
    return EXIT.USAGE;
  }
  let origin;
  try {
    origin = new URL(env.TRACEOMICS_URL || 'http://127.0.0.1:3000');
  } catch {
    stderr.write('traceomics: TRACEOMICS_URL is not a valid URL.\n');
    return EXIT.USAGE;
  }
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname);
  if (origin.protocol !== 'https:' && !local) {
    stderr.write('traceomics: refusing to send a credential over plain HTTP to a non-local server.\n');
    return EXIT.USAGE;
  }
  const url = new URL(`/api/automation/v1${request.path}`, origin);
  let response;
  try {
    response = await fetchImpl(url, {
      method: request.method,
      redirect: 'error',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(request.body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: request.body ? JSON.stringify(request.body) : undefined,
      signal: AbortSignal.timeout(30000),
    });
  } catch {
    // The outcome of a submission is unknown; re-running the same command
    // reuses the same request id and returns the original receipt.
    stderr.write('traceomics: the server could not be reached; the outcome is unknown. Re-run the same command to check.\n');
    return EXIT.UNAVAILABLE;
  }
  let text;
  try { text = await readBounded(response); } catch (error) { stderr.write(`traceomics: ${error.message}\n`); return EXIT.ERROR; }
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (data === null || typeof data !== 'object') {
    stderr.write(`traceomics: unexpected response (HTTP ${response.status}).\n`);
    return EXIT.ERROR;
  }
  stdout.write(`${JSON.stringify(data, null, 2)}\n`);
  if (!response.ok) stderr.write(`traceomics: ${data.code || `HTTP ${response.status}`}: ${data.error || 'request failed'}\n`);
  return exitCodeFor(response.status);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  run(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
