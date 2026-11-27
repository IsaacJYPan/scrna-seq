#!/usr/bin/env node
// Local analysis ledger for offline evaluation runs (scripts/eval-agent-replication).
// It applies the same validation and audit as the server
// (shared/analysisLedger.mjs) to a ledger.jsonl file in the current folder.
// Evidence files must exist under the current folder, as the server requires
// them to be outputs of a finished run.
//
//   node analysis-ledger-local.mjs add '<json entry>'     (or: add - < entry.json)
//   node analysis-ledger-local.mjs list [kind]
//   node analysis-ledger-local.mjs audit [--report report/report.md] [--out audit.md]

import fs from 'node:fs';
import path from 'node:path';
import { auditLedger, normalizeLedgerEntry, renderAuditMarkdown, LedgerValidationError, checkCitedValue } from '../shared/analysisLedger.mjs';

const PREFIX = { decision: 'D', annotation: 'A', finding: 'F', issue: 'I', check: 'C' };

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
    const audit = auditLedger(readLedger(path.join(root, 'ledger.jsonl')), { reportText });
    const markdown = renderAuditMarkdown(audit);
    if (opt('--out')) fs.writeFileSync(path.join(root, opt('--out')), markdown);
    const gaps = audit.gaps.filter((gap) => gap.severity !== 'info');
    process.stdout.write(`${audit.counts.blocker} blocking, ${audit.counts.review} to review, ${audit.counts.info} notes\n`);
    for (const gap of gaps) process.stdout.write(`[${gap.severity}] ${gap.code}: ${gap.message}\n`);
    return;
  }
  process.stdout.write('usage: add <json>|add - ; list [kind] ; audit [--report file] [--out file]\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`error: ${error.message}${error.field ? ` (field: ${error.field})` : ''}\n`);
    process.exit(1);
  }
}
