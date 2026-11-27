#!/usr/bin/env node
// Local analysis ledger for offline evaluation runs (scripts/eval-agent-replication/README.md).
// It applies the same validation and audit as the server
// (shared/analysisLedger.mjs) to a ledger.jsonl file in the current folder.
// Evidence files must exist under the current folder, as the server requires
// them to be outputs of a finished run.
//
//   node analysis-ledger-local.mjs add '<json entry>'     (or: add - < entry.json)
//   node analysis-ledger-local.mjs list [kind]
//   node analysis-ledger-local.mjs audit [--report report/report.md] [--out audit.md]
//   node analysis-ledger-local.mjs run scripts/NN_tab_name.R [args...]
//   node analysis-ledger-local.mjs method <method-key> <analysis.rds> [key=value...]
//
// `run` mirrors a sandbox run: it runs the script with Rscript, saves the
// console to logs/, records which files under outputs/ the run wrote, and,
// like the server (LEDGER_BEHIND), refuses to start while more than one
// finished run has no interpretation entry citing one of its outputs.
// `method` runs one trusted library method (trusted-methods/) the same way,
// through eval-agent-replication/run-trusted-method.R, writing its outputs to
// outputs/methods/<run>_<method-key>/, as the app records a workflow run.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { auditLedger, normalizeLedgerEntry, renderAuditMarkdown, LedgerValidationError, checkCitedValue, parseSignals } from '../shared/analysisLedger.mjs';

const PREFIX = { decision: 'D', annotation: 'A', finding: 'F', issue: 'I', check: 'C', interpretation: 'N', prediction: 'P' };

export function readLedger(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

export function addEntry(root, input) {
  const file = path.join(root, 'ledger.jsonl');
  const entries = readLedger(file);
  const entry = normalizeLedgerEntry(input, { known: new Set(entries.map((e) => e.id)) });
  for (const ref of entry.evidence) {
    if (ref.file && !fs.existsSync(path.join(root, ref.file))) {
      throw new LedgerValidationError(`Evidence file not found: ${ref.file}. Cite an output that exists.`, 'evidence');
    }
    if (ref.file && ref.value && /\.(csv|tsv)$/i.test(ref.file)) {
      const check = checkCitedValue(fs.readFileSync(path.join(root, ref.file), 'utf8'), ref);
      if (check.status === 'mismatched') {
        throw new LedgerValidationError(`${ref.file} at "${ref.locator}" does not hold ${ref.value}: ${check.reason}.`, 'evidence');
      }
      ref.valueCheck = check.status;
    }
  }
  const n = entries.filter((e) => e.kind === entry.kind).length + 1;
  const stored = { id: `${PREFIX[entry.kind]}${n}`, createdAt: new Date().toISOString(), ...entry };
  fs.appendFileSync(file, `${JSON.stringify(stored)}\n`);
  return stored;
}

const MAX_UNRECORDED_RUNS = 1;

function listFiles(dir, base = dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? listFiles(full, base) : [[path.relative(base, full), fs.statSync(full).mtimeMs]];
  });
}

export function readRuns(root) {
  const file = path.join(root, 'runs.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
}

export function unrecordedRuns(root) {
  const cited = new Set(readLedger(path.join(root, 'ledger.jsonl')).filter((entry) => entry.kind === 'interpretation')
    .flatMap((entry) => entry.evidence.map((ref) => ref.file)));
  return readRuns(root).filter((run) => run.status === 0 && run.outputs.length && !run.outputs.some((file) => cited.has(file)));
}

const TRUSTED_RUNNER = path.join(path.dirname(new URL(import.meta.url).pathname), 'eval-agent-replication', 'run-trusted-method.R');

function runScript(root, script, args, { external = false } = {}) {
  const waiting = unrecordedRuns(root);
  if (waiting.length > MAX_UNRECORDED_RUNS) {
    throw new LedgerValidationError(`LEDGER_BEHIND: interpret your finished runs before starting another. `
      + `${waiting.length} finished run(s) have no interpretation entry citing their outputs: ${waiting.map((run) => `${run.id} (${run.script})`).join(', ')}.`, 'run');
  }
  if (!external && !fs.existsSync(path.join(root, script))) throw new LedgerValidationError(`Script not found: ${script}.`, 'run');
  const before = new Map(listFiles(path.join(root, 'outputs')));
  const startedAt = new Date().toISOString();
  const result = spawnSync('Rscript', [script, ...args], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const log = `${result.stdout || ''}${result.stderr || ''}`;
  fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
  const logName = external ? `method_R${readRuns(root).length + 1}_${args[0]}` : path.basename(script, '.R');
  const logFile = path.join('logs', `${logName}${args.length && !external ? `_${args.join('_').replace(/[^A-Za-z0-9._-]/g, '')}` : ''}.log`);
  fs.writeFileSync(path.join(root, logFile), log);
  const outputs = listFiles(path.join(root, 'outputs'))
    .filter(([file, mtime]) => before.get(file) !== mtime).map(([file]) => path.join('outputs', file));
  const runs = readRuns(root);
  const run = { id: `R${runs.length + 1}`, script: external ? `trusted method ${args[0]}` : script, args, startedAt, finishedAt: new Date().toISOString(), status: result.status, log: logFile, outputs };
  fs.appendFileSync(path.join(root, 'runs.jsonl'), `${JSON.stringify(run)}\n`);
  return { run, log };
}

function main(argv) {
  const root = process.cwd();
  const [command, ...rest] = argv;
  if (command === 'add') {
    const raw = rest[0] === '-' || rest[0] === undefined ? fs.readFileSync(0, 'utf8') : rest[0];
    let input;
    try { input = JSON.parse(raw); } catch { throw new LedgerValidationError('The entry is not valid JSON.', 'entry'); }
    const stored = addEntry(root, input);
    process.stdout.write(`recorded ${stored.id} (${stored.kind}): ${stored.title}\n`);
    return;
  }
  if (command === 'run') {
    const { run, log } = runScript(root, rest[0], rest.slice(1));
    process.stdout.write(`${log.split('\n').slice(-80).join('\n')}\n`);
    process.stdout.write(`run ${run.id} exited ${run.status}; wrote ${run.outputs.length} output(s): ${run.outputs.join(', ')}; full log ${run.log}\n`);
    if (run.status === 0 && run.outputs.length) process.stdout.write(`Write an interpretation of ${run.id} (cite one of its outputs) before running more than one further script.\n`);
    return;
  }
  if (command === 'method') {
    const [key, analysis, ...params] = rest;
    if (!key || !analysis) throw new LedgerValidationError('usage: method <method-key> <analysis.rds> [key=value...]', 'run');
    if (!fs.existsSync(path.join(root, analysis))) throw new LedgerValidationError(`Analysis object not found: ${analysis}.`, 'run');
    const outDir = path.join('outputs', 'methods', `R${readRuns(root).length + 1}_${key.replace(/[^A-Za-z0-9-]/g, '')}`);
    const { run, log } = runScript(root, TRUSTED_RUNNER, [key, analysis, outDir, ...params], { external: true });
    process.stdout.write(`${log.split('\n').slice(-40).join('\n')}\n`);
    process.stdout.write(`run ${run.id} (trusted method ${key}) exited ${run.status}; wrote ${run.outputs.length} output(s): ${run.outputs.join(', ')}; full log ${run.log}\n`);
    if (run.status === 0 && run.outputs.length) process.stdout.write(`Write an interpretation of ${run.id} (cite one of its outputs) before running more than one further script.\n`);
    return;
  }
  if (command === 'list') {
    for (const entry of readLedger(path.join(root, 'ledger.jsonl'))) {
      if (!rest[0] || entry.kind === rest[0]) process.stdout.write(`${entry.id}\t${entry.kind}\t${entry.tab}\t${entry.title}\n`);
    }
    return;
  }
  if (command === 'audit') {
    const opt = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
    const reportPath = opt('--report');
    const reportText = reportPath && fs.existsSync(path.join(root, reportPath)) ? fs.readFileSync(path.join(root, reportPath), 'utf8') : undefined;
    // Local runs stand in for sandbox runs: cited when an entry cites one of their outputs.
    const entries = readLedger(path.join(root, 'ledger.jsonl'));
    const runs = readRuns(root).filter((run) => run.status === 0 && run.outputs.length);
    const local = entries.map((entry) => ({ ...entry, evidence: entry.evidence.map((ref) => {
      const owner = runs.find((run) => run.outputs.includes(ref.file));
      return owner ? { ...ref, sandboxRunId: owner.id } : ref;
    }) }));
    const signals = listFiles(path.join(root, 'outputs')).map(([file]) => file).filter((file) => /signals\.csv$/.test(file))
      .flatMap((file) => parseSignals(fs.readFileSync(path.join(root, 'outputs', file), 'utf8'), { source: file }));
    const audit = auditLedger(local, { reportText, runs: runs.map((run) => ({ id: run.id, title: run.script })), signals });
    const markdown = renderAuditMarkdown(audit);
    if (opt('--out')) fs.writeFileSync(path.join(root, opt('--out')), markdown);
    const gaps = audit.gaps.filter((gap) => gap.severity !== 'info');
    process.stdout.write(`${audit.counts.blocker} blocking, ${audit.counts.review} to review, ${audit.counts.info} notes\n`);
    for (const gap of gaps) process.stdout.write(`[${gap.severity}] ${gap.code}: ${gap.message}\n`);
    return;
  }
  process.stdout.write('usage: add <json>|add - ; list [kind] ; audit [--report file] [--out file] ; run <script.R> [args] ; method <key> <analysis.rds> [key=value...]\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`error: ${error.message}${error.field ? ` (field: ${error.field})` : ''}\n`);
    process.exit(1);
  }
}
