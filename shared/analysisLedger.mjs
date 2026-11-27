// The analysis ledger: what an agent decided, concluded and still doubts,
// recorded as structured entries that each point at the output that supports
// them, plus the audit a reviewer reads first.
//
// Why it exists. Blind replications of published studies showed agents get the
// headline biology roughly right but (1) stop after one global clustering pass,
// (2) write anomalies and cheap checks into the caveats instead of resolving
// them, and (3) leave their key judgements (which cluster is which cell type,
// which number supports which sentence) buried in scripts and console logs, so
// a reviewer has to reconstruct them. The ledger makes each judgement a record
// with its evidence, and the audit lists, in order of risk, what is missing.
//
// Pure functions only: the backend validates and stores entries; the audit is
// computed from the stored entries. Shared by the backend, the MCP server's
// local mode, the app and the evaluation harness.

export const LEDGER_SCHEMA = 'traceomics.analysis-ledger.v1';

export const LEDGER_KINDS = Object.freeze(['decision', 'annotation', 'finding', 'issue', 'check']);
export const CONFIDENCE = Object.freeze(['high', 'medium', 'low']);
export const IMPACT = Object.freeze(['high', 'medium', 'low']);
export const SAMPLE_SUPPORT = Object.freeze(['all', 'most', 'one', 'not_checked', 'not_applicable']);
export const ISSUE_STATUS = Object.freeze(['open', 'resolved', 'accepted']);
export const CHECK_STATUS = Object.freeze(['done', 'not_applicable', 'blocked']);

const TABS = Object.freeze(['qc', 'normalize', 'pca', 'integrate', 'cluster', 'umap', 'deg', 'enrichment', 'cellchat', 'explore']);

// The standard checklist for a single-cell analysis. Each item names a step
// the blind runs skipped or did superficially and that a reviewer would
// otherwise have to ask about. An item is answered by a `check` entry: done
// (with evidence), not_applicable or blocked (with a reason).
export const ANALYSIS_CHECKLIST = Object.freeze([
  { key: 'qc.thresholds', tab: 'qc', title: 'QC thresholds chosen from per-sample distributions', detail: 'Plot nFeature, nCount and mitochondrial fraction per sample; state the thresholds and how many cells each removes per sample.' },
  { key: 'qc.doublets', tab: 'qc', title: 'Doublets detected and handled', detail: 'Run a doublet method (or a documented score of co-expressed lineage markers); report the rate per sample and what was removed.' },
  { key: 'qc.ambient', tab: 'qc', title: 'Ambient RNA assessed', detail: 'Check whether highly specific genes (Ig, hemoglobin, lineage markers) appear in clusters that should not express them; correct or state the effect.' },
  { key: 'integrate.compare', tab: 'integrate', title: 'Integrated and unintegrated structure compared', detail: 'Show clusters by sample before and after integration; for every population that separates by sample, say whether it is batch or biology and why.' },
  { key: 'cluster.resolution', tab: 'cluster', title: 'Clustering checked at more than one resolution', detail: 'Report which populations are stable across resolutions and which split or merge.' },
  { key: 'cluster.sample-composition', tab: 'cluster', title: 'Sample make-up of every cluster reported', detail: 'Flag clusters dominated by one sample.' },
  { key: 'cluster.every-label', tab: 'cluster', title: 'Every cluster labeled with marker evidence', detail: 'One annotation entry per cluster, each naming the markers (with their values) that support the label and the alternatives considered. Look at the top markers that do not fit the label and explain them (contamination, doublets, ambient RNA, or a state the label misses).' },
  { key: 'cluster.canonical-markers', tab: 'cluster', title: 'Canonical markers checked for every expected lineage', detail: 'For each lineage expected in this tissue, show its canonical markers across clusters, including lineages you did not find (absence is a result).' },
  { key: 'cluster.subcluster', tab: 'cluster', title: 'Each major compartment re-clustered on its own', detail: 'Subset each compartment the tissue has with enough cells (for example immune, lymphoid, myeloid, stromal, endothelial, neural, epithelial or tumor), re-normalize, re-cluster and annotate the subtypes. Global clustering hides subtypes.' },
  { key: 'explore.orthogonal-support', tab: 'explore', title: 'State calls backed by an independent signal', detail: 'Any call that expression clusters alone cannot make (malignant versus normal, infected versus bystander, perturbation or donor assignment, doublet versus transitional state) is supported by a second, independent signal such as inferred copy number, genotype, guide or hashtag counts, or a reference; say how confident the call is. Not applicable when no such call is made.' },
  { key: 'deg.replicate-aware', tab: 'deg', title: 'Comparisons are replicate-aware', detail: 'Use pseudobulk across samples for between-condition claims, or state that cell-level p-values are descriptive only.' },
  { key: 'explore.cross-sample', tab: 'explore', title: 'Main findings checked in each sample', detail: 'For every finding, report whether it holds in all samples, most, or one.' },
  { key: 'explore.anomalies', tab: 'explore', title: 'Every anomaly investigated', detail: 'Each unexpected signal is an issue entry, resolved by a follow-up run or explicitly accepted with a reason. A caveat that a short script could check is not a caveat: run the script.' },
  { key: 'cellchat.limitations', tab: 'cellchat', title: 'Interaction analysis method and limits stated', detail: 'Name the database or pair list, the statistic, and what the result can and cannot support.' },
]);

export const CHECKLIST_KEYS = Object.freeze(ANALYSIS_CHECKLIST.map((item) => item.key));

const LIMITS = Object.freeze({
  title: 200, text: 4000, short: 200, list: 40, evidence: 20, gene: 40,
});

export class LedgerValidationError extends Error {
  constructor(message, field) {
    super(message);
    this.name = 'LedgerValidationError';
    this.code = 'INVALID_LEDGER_ENTRY';
    this.field = field;
  }
}

function fail(message, field) {
  throw new LedgerValidationError(message, field);
}

function rejectUnknown(value, allowed, where) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${where} must be an object.`, where);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`Unknown field in ${where}: ${String(key).slice(0, 64)}.`, `${where}.${key}`);
  }
}

function str(value, field, max, { optional = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (optional) return undefined;
    fail(`${field} is required.`, field);
  }
  if (typeof value !== 'string') fail(`${field} must be text.`, field);
  const result = value.trim();
  if (!result && !optional) fail(`${field} is required.`, field);
  if (result.length > max) fail(`${field} must be at most ${max} characters.`, field);
  if (result.includes('\0')) fail(`${field} must be text.`, field);
  return result || undefined;
}

function oneOf(value, allowed, field, { optional = false } = {}) {
  if (value === undefined && optional) return undefined;
  if (!allowed.includes(value)) fail(`${field} must be one of: ${allowed.join(', ')}.`, field);
  return value;
}

function strList(value, field, { min = 0, max = LIMITS.list, itemMax = LIMITS.short, optional = false } = {}) {
  if (value === undefined && optional) return undefined;
  if (!Array.isArray(value)) fail(`${field} must be a list.`, field);
  if (value.length < min) fail(`${field} needs at least ${min} entr${min === 1 ? 'y' : 'ies'}.`, field);
  if (value.length > max) fail(`${field} has at most ${max} entries.`, field);
  return value.map((item, index) => str(item, `${field}[${index}]`, itemMax));
}

// An evidence reference points at one output of a run, optionally at the
// exact place in it (a row, a column, a cluster) and the value read there,
// so a reviewer can open the file and check one number instead of rerunning.
// `sandboxRunId` / `runId` are optional here; the backend requires and
// verifies one of them. The local harness uses paths relative to the run.
const SANDBOX_RUN_ID = /^sbr_[0-9a-f]{24}$/;
const RUN_ID = /^run_[0-9a-f]{24}$/;
const FILE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,239}$/;

export function normalizeEvidence(value, field = 'evidence') {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail(`${field} must be a list.`, field);
  if (value.length > LIMITS.evidence) fail(`${field} has at most ${LIMITS.evidence} entries.`, field);
  return value.map((ref, index) => {
    const where = `${field}[${index}]`;
    rejectUnknown(ref, ['sandboxRunId', 'runId', 'file', 'locator', 'value'], where);
    const out = {};
    if (ref.sandboxRunId !== undefined) {
      if (!SANDBOX_RUN_ID.test(String(ref.sandboxRunId))) fail(`${where}.sandboxRunId is not a sandbox run id.`, `${where}.sandboxRunId`);
      out.sandboxRunId = ref.sandboxRunId;
    }
    if (ref.runId !== undefined) {
      if (!RUN_ID.test(String(ref.runId))) fail(`${where}.runId is not a run id.`, `${where}.runId`);
      out.runId = ref.runId;
    }
    if (out.sandboxRunId && out.runId) fail(`${where} names both a sandbox run and a workflow run; give one.`, where);
    const file = str(ref.file, `${where}.file`, 240, { optional: Boolean(out.runId) });
    if (file !== undefined) {
      if (!FILE.test(file) || file.split('/').includes('..')) fail(`${where}.file must be a relative output path.`, `${where}.file`);
      out.file = file;
    }
    const locator = str(ref.locator, `${where}.locator`, LIMITS.short, { optional: true });
    if (locator) out.locator = locator;
    const reading = str(ref.value, `${where}.value`, LIMITS.short, { optional: true });
    if (reading) out.value = reading;
    return out;
  });
}

// ── Cited values ───────────────────────────────────────────────────────────
// A cited number is only useful if it is the number in the file. For CSV/TSV
// outputs, a locator of the form `row <column>=<value>[, <column>=<value>...],
// column <column>` names one cell; the store reads the table and refuses an
// entry whose value differs from that cell. Other locators are kept as text
// and marked unchecked.

export const LOCATOR_GRAMMAR = 'row <column>=<value>[, <column>=<value>...], column <column>';

export function parseDelimited(text, delimiter = ',') {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i += 1; } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) { row.push(field); field = ''; } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length > 1 || r[0] !== '');
}

export function parseTableLocator(locator) {
  const match = /^row\s+(.+?),\s*column\s+(.+)$/i.exec(String(locator || '').trim());
  if (!match) return null;
  const conditions = [];
  for (const part of match[1].split(',')) {
    const eq = part.indexOf('=');
    if (eq <= 0) return null;
    conditions.push([part.slice(0, eq).trim(), part.slice(eq + 1).trim()]);
  }
  return { conditions, column: match[2].trim() };
}

function sameNumber(found, cited) {
  const text = String(cited).trim();
  const percent = text.endsWith('%');
  const number = Number(percent ? text.slice(0, -1) : text);
  const actual = Number(found);
  if (!Number.isFinite(number) || !Number.isFinite(actual) || String(found).trim() === '') return null;
  const decimals = (text.replace('%', '').split(/[eE]/)[0].split('.')[1] || '').length;
  const close = (a) => {
    if (Math.abs(a - number) <= 1e-9 * Math.max(1, Math.abs(a))) return true;
    // The agent rounded: accept the file's value at the precision cited.
    if (Math.abs(Number(a.toFixed(Math.min(decimals, 15))) - number) < 1e-12) return true;
    return Math.abs(a - number) <= 0.005 * Math.abs(a) && decimals >= 2;
  };
  return close(actual) || (percent && close(actual * 100));
}

// Returns { status: 'matched' | 'mismatched' | 'unchecked', found?, reason? }.
export function checkCitedValue(text, { file, locator, value }) {
  if (!value || !/\.(csv|tsv)$/i.test(String(file || ''))) return { status: 'unchecked', reason: 'not a table' };
  const parsed = parseTableLocator(locator);
  if (!parsed) return { status: 'unchecked', reason: `locator is not "${LOCATOR_GRAMMAR}"` };
  const rows = parseDelimited(String(text), /\.tsv$/i.test(file) ? '\t' : ',');
  if (rows.length < 2) return { status: 'unchecked', reason: 'empty table' };
  const header = rows[0];
  // R's write.csv(row.names = TRUE) leaves the first header cell empty.
  const columnIndex = (name) => {
    const index = header.indexOf(name);
    if (index >= 0) return index;
    return header[0] === '' && !header.includes(name) ? 0 : -1;
  };
  const keys = parsed.conditions.map(([name, wanted]) => [columnIndex(name), wanted]);
  if (keys.some(([index]) => index < 0)) return { status: 'unchecked', reason: 'a row key is not a column of the table' };
  const target = header.indexOf(parsed.column);
  if (target < 0) return { status: 'mismatched', reason: `the table has no column ${parsed.column}` };
  const hits = rows.slice(1).filter((row) => keys.every(([index, wanted]) => String(row[index] ?? '').trim() === wanted));
  if (!hits.length) return { status: 'mismatched', reason: 'no row matches the locator' };
  if (hits.length > 1) return { status: 'unchecked', reason: 'the locator matches more than one row' };
  const found = String(hits[0][target] ?? '').trim();
  const numeric = sameNumber(found, value);
  if (numeric === true || (numeric === null && found === String(value).trim())) return { status: 'matched', found };
  return { status: 'mismatched', found, reason: `the file says ${found.slice(0, 80)}` };
}

const COMMON = ['kind', 'tab', 'title', 'evidence', 'requestId', 'refersTo'];

const KIND_FIELDS = Object.freeze({
  decision: ['choice', 'alternatives', 'rationale', 'impact', 'sensitivity'],
  annotation: ['grouping', 'group', 'label', 'markers', 'confidence', 'alternatives', 'cells'],
  finding: ['statement', 'confidence', 'sampleSupport', 'limitations'],
  issue: ['observation', 'status', 'resolution'],
  check: ['item', 'status', 'note'],
});

// Validates one entry as an agent submits it and returns the normalized
// payload (without ids or timestamps, which the store assigns).
// `known` is the set of entry ids already in the ledger, for `refersTo`.
export function normalizeLedgerEntry(input, { known = new Set() } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('An entry must be an object.', 'entry');
  const kind = oneOf(input.kind, LEDGER_KINDS, 'kind');
  rejectUnknown(input, [...COMMON, ...KIND_FIELDS[kind]], 'entry');
  const entry = { kind, tab: oneOf(input.tab, TABS, 'tab'), title: str(input.title, 'title', LIMITS.title) };
  entry.evidence = normalizeEvidence(input.evidence);
  if (input.refersTo !== undefined) {
    const ref = str(input.refersTo, 'refersTo', 80);
    if (!known.has(ref)) fail(`refersTo names no entry in this ledger: ${ref}.`, 'refersTo');
    entry.refersTo = ref;
  }

  if (kind === 'decision') {
    entry.choice = str(input.choice, 'choice', LIMITS.text);
    entry.alternatives = strList(input.alternatives, 'alternatives', { min: 1 });
    entry.rationale = str(input.rationale, 'rationale', LIMITS.text);
    entry.impact = oneOf(input.impact, IMPACT, 'impact');
    // What changes if the other choice is made. `checked` needs evidence.
    if (input.sensitivity !== undefined) {
      rejectUnknown(input.sensitivity, ['checked', 'summary'], 'sensitivity');
      if (typeof input.sensitivity.checked !== 'boolean') fail('sensitivity.checked must be true or false.', 'sensitivity.checked');
      entry.sensitivity = {
        checked: input.sensitivity.checked,
        summary: str(input.sensitivity.summary, 'sensitivity.summary', LIMITS.text),
      };
      if (entry.sensitivity.checked && !entry.evidence.length) {
        fail('A decision whose sensitivity was checked needs evidence from that check.', 'evidence');
      }
    }
  }

  if (kind === 'annotation') {
    entry.grouping = str(input.grouping, 'grouping', 120);
    entry.group = str(String(input.group ?? ''), 'group', 120);
    entry.label = str(input.label, 'label', LIMITS.title);
    entry.markers = strList(input.markers, 'markers', { min: 2, max: 30, itemMax: LIMITS.gene });
    entry.confidence = oneOf(input.confidence, CONFIDENCE, 'confidence');
    entry.alternatives = strList(input.alternatives, 'alternatives', { optional: true }) || [];
    if (input.cells !== undefined) {
      if (!Number.isSafeInteger(input.cells) || input.cells < 0) fail('cells must be a whole number.', 'cells');
      entry.cells = input.cells;
    }
    if (!entry.evidence.length) fail('An annotation needs evidence: the marker table or plot that shows its markers.', 'evidence');
    if (entry.confidence !== 'high' && !entry.alternatives.length) {
      fail('A medium or low confidence label must name the alternatives considered.', 'alternatives');
    }
  }

  if (kind === 'finding') {
    entry.statement = str(input.statement, 'statement', LIMITS.text);
    entry.confidence = oneOf(input.confidence, CONFIDENCE, 'confidence');
    entry.sampleSupport = oneOf(input.sampleSupport, SAMPLE_SUPPORT, 'sampleSupport');
    entry.limitations = str(input.limitations, 'limitations', LIMITS.text, { optional: true });
    if (!entry.evidence.length) fail('A finding needs evidence: at least one output that supports it.', 'evidence');
    if (!entry.evidence.some((ref) => ref.locator || ref.value)) {
      fail('A finding needs at least one evidence entry with a locator or value, so a reviewer can check the exact number.', 'evidence');
    }
  }

  if (kind === 'issue') {
    entry.observation = str(input.observation, 'observation', LIMITS.text);
    entry.status = oneOf(input.status ?? 'open', ISSUE_STATUS, 'status');
    entry.resolution = str(input.resolution, 'resolution', LIMITS.text, { optional: entry.status === 'open' });
    // Resolving or accepting an issue is a new entry that refers to it.
    if (entry.status !== 'open' && !entry.refersTo) fail('A resolved or accepted issue must refer to the open issue it closes.', 'refersTo');
    if (entry.status === 'resolved' && !entry.evidence.length) fail('Resolving an issue needs evidence from the run that resolved it.', 'evidence');
  }

  if (kind === 'check') {
    entry.item = oneOf(input.item, CHECKLIST_KEYS, 'item');
    entry.status = oneOf(input.status, CHECK_STATUS, 'status');
    entry.note = str(input.note, 'note', LIMITS.text, { optional: entry.status === 'done' });
    if (entry.status === 'done' && !entry.evidence.length) fail('A done check needs evidence.', 'evidence');
  }
  return entry;
}

function latestBy(entries, keyOf) {
  const latest = new Map();
  for (const entry of entries) latest.set(keyOf(entry), entry);
  return latest;
}

// The audit a reviewer reads first: the gaps in the ledger, most severe
// first. Entries are in append order and carry `id`.
// `reportText` (optional) is the concatenated report, to flag findings that
// the report states but never cites, and citations of unknown entries.
// `runs` (optional) are the agent's finished runs ({ id, title }), to flag
// work no entry explains: variants tried and dropped are exactly what a
// reviewer needs to see.
export function auditLedger(entries, { reportText, runs } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const byId = new Map(list.map((entry) => [entry.id, entry]));
  const gaps = [];
  const add = (severity, code, message, entryIds = []) => gaps.push({ severity, code, message, entryIds });

  // Issues: an issue is open until a later issue entry refers to it with a
  // status of resolved or accepted.
  const closing = new Map();
  for (const entry of list) {
    if (entry.kind === 'issue' && entry.refersTo && entry.status !== 'open') closing.set(entry.refersTo, entry);
  }
  const openIssues = list.filter((entry) => entry.kind === 'issue' && entry.status === 'open' && !closing.has(entry.id));
  for (const issue of openIssues) add('blocker', 'ISSUE_OPEN', `Open issue: ${issue.title}`, [issue.id]);
  for (const [openId, close] of closing) {
    if (close.status === 'accepted') add('review', 'ISSUE_ACCEPTED', `Issue accepted without a fix: ${byId.get(openId)?.title || openId}. Reason: ${close.resolution}`, [openId, close.id]);
  }

  // Checklist coverage: the latest check entry per item counts.
  const checks = latestBy(list.filter((entry) => entry.kind === 'check'), (entry) => entry.item);
  const checklist = ANALYSIS_CHECKLIST.map((item) => {
    const entry = checks.get(item.key);
    return { ...item, status: entry ? entry.status : 'missing', entryId: entry?.id || null, note: entry?.note || null };
  });
  for (const item of checklist) {
    if (item.status === 'missing') add('blocker', 'CHECK_MISSING', `Not addressed: ${item.title}`, []);
    else if (item.status === 'blocked') add('review', 'CHECK_BLOCKED', `Blocked: ${item.title}. ${item.note || ''}`.trim(), [item.entryId]);
  }

  // Findings: weak support is what a reviewer should check first.
  const findings = list.filter((entry) => entry.kind === 'finding');
  for (const finding of findings) {
    if (['one', 'not_checked'].includes(finding.sampleSupport)) {
      add('review', 'FINDING_SINGLE_SAMPLE', `Finding ${finding.sampleSupport === 'one' ? 'seen in one sample only' : 'not checked across samples'}: ${finding.title}`, [finding.id]);
    }
    if (finding.confidence === 'low') add('review', 'FINDING_LOW_CONFIDENCE', `Low-confidence finding: ${finding.title}`, [finding.id]);
    if (finding.evidence.some((ref) => ref.valueCheck) && !finding.evidence.some((ref) => ref.valueCheck === 'matched')) {
      add('info', 'FINDING_VALUES_UNCHECKED', `No cited value of this finding could be checked against its table: ${finding.title}`, [finding.id]);
    }
  }
  if (!findings.length) add('blocker', 'NO_FINDINGS', 'No findings recorded: the report has nothing a reviewer can check claim by claim.', []);

  // Annotations: the latest label per (grouping, group).
  const labels = [...latestBy(list.filter((entry) => entry.kind === 'annotation'), (entry) => `${entry.grouping}\u0000${entry.group}`).values()];
  for (const label of labels) {
    if (label.confidence === 'low') add('review', 'LABEL_LOW_CONFIDENCE', `Low-confidence label: ${label.grouping} ${label.group} = ${label.label} (alternatives: ${label.alternatives.join(', ')})`, [label.id]);
  }

  // Decisions that change results and were not tested.
  for (const decision of list.filter((entry) => entry.kind === 'decision')) {
    if (decision.impact === 'high' && !decision.sensitivity?.checked) {
      add('review', 'DECISION_UNTESTED', `High-impact choice not tested: ${decision.title} (${decision.choice.slice(0, 120)})`, [decision.id]);
    }
  }

  // Report cross-check: findings are cited as [F:<id>] and labels as [A:<id>].
  let citations = null;
  if (typeof reportText === 'string') {
    const cited = new Set([...reportText.matchAll(/\[(?:F|A|D|I|C):([A-Za-z0-9_-]{1,80})\]/g)].map((match) => match[1]));
    const unknown = [...cited].filter((id) => !byId.has(id));
    const uncited = findings.filter((finding) => !cited.has(finding.id));
    citations = { cited: cited.size, unknown, uncitedFindings: uncited.map((finding) => finding.id) };
    for (const id of unknown) add('blocker', 'CITATION_UNKNOWN', `The report cites an entry that does not exist: ${id}`, []);
    if (findings.length && cited.size === 0) add('blocker', 'REPORT_UNCITED', 'The report cites no ledger entries, so its claims cannot be traced to evidence.', []);
    for (const finding of uncited) add('info', 'FINDING_NOT_IN_REPORT', `Finding not cited in the report: ${finding.title}`, [finding.id]);
  }

  let uncitedRuns = null;
  if (Array.isArray(runs)) {
    const citedRuns = new Set(list.flatMap((entry) => (entry.evidence || []).map((ref) => ref.sandboxRunId || ref.runId)).filter(Boolean));
    uncitedRuns = runs.filter((run) => !citedRuns.has(run.id)).map((run) => ({ id: run.id, title: run.title || null }));
    if (uncitedRuns.length) {
      const names = uncitedRuns.slice(0, 10).map((run) => run.title || run.id).join('; ');
      add('review', 'RUN_NOT_IN_LEDGER', `${uncitedRuns.length} of ${runs.length} finished run(s) are not cited by any ledger entry: ${names}${uncitedRuns.length > 10 ? '; …' : ''}`, uncitedRuns.map((run) => run.id));
    }
  }

  const order = { blocker: 0, review: 1, info: 2 };
  gaps.sort((a, b) => order[a.severity] - order[b.severity]);
  const counts = { blocker: 0, review: 0, info: 0 };
  for (const gap of gaps) counts[gap.severity] += 1;
  return {
    schema: `${LEDGER_SCHEMA}.audit`,
    counts,
    gaps,
    checklist,
    findings: findings.map((finding) => ({
      id: finding.id, title: finding.title, statement: finding.statement, confidence: finding.confidence,
      sampleSupport: finding.sampleSupport, limitations: finding.limitations || null, evidence: finding.evidence,
    })),
    labels: labels.map((label) => ({
      id: label.id, grouping: label.grouping, group: label.group, label: label.label, markers: label.markers,
      confidence: label.confidence, alternatives: label.alternatives, cells: label.cells ?? null, evidence: label.evidence,
    })),
    decisions: list.filter((entry) => entry.kind === 'decision').map((decision) => ({
      id: decision.id, title: decision.title, choice: decision.choice, alternatives: decision.alternatives,
      rationale: decision.rationale, impact: decision.impact, sensitivity: decision.sensitivity || null, evidence: decision.evidence,
    })),
    issues: list.filter((entry) => entry.kind === 'issue' && entry.status === 'open').map((issue) => {
      const close = closing.get(issue.id);
      return {
        id: issue.id, title: issue.title, observation: issue.observation,
        status: close ? close.status : 'open', resolution: close?.resolution || null,
        evidence: close ? close.evidence : issue.evidence,
      };
    }),
    citations,
    uncitedRuns,
  };
}

function formatEvidence(refs) {
  return refs.map((ref) => {
    const where = [ref.sandboxRunId || ref.runId, ref.file].filter(Boolean).join(':');
    const at = ref.locator ? ` @ ${ref.locator}` : '';
    const reading = ref.value ? ` = ${ref.value}` : '';
    const checked = ref.valueCheck === 'matched' ? ' ✓' : '';
    return `\`${where}\`${at}${reading}${checked}`;
  }).join('; ');
}

function cell(text) {
  return String(text ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
}

// The audit as Markdown: the review packet a person reads before the report.
export function renderAuditMarkdown(audit) {
  const lines = ['## Audit', ''];
  const { counts } = audit;
  lines.push(`${counts.blocker} blocking gap(s), ${counts.review} item(s) to review, ${counts.info} note(s).`, '');
  const section = (severity, heading) => {
    const items = audit.gaps.filter((gap) => gap.severity === severity);
    if (!items.length) return;
    lines.push(`### ${heading}`, '');
    for (const gap of items) lines.push(`- ${gap.message}${gap.entryIds.length ? ` (${gap.entryIds.join(', ')})` : ''}`);
    lines.push('');
  };
  section('blocker', 'Blocking');
  section('review', 'Review first');

  lines.push('### Findings', '', '| ID | Finding | Confidence | Samples | Evidence |', '| --- | --- | --- | --- | --- |');
  for (const finding of audit.findings) {
    lines.push(`| ${finding.id} | ${cell(finding.statement)} | ${finding.confidence} | ${finding.sampleSupport} | ${cell(formatEvidence(finding.evidence))} |`);
  }
  lines.push('');
  if (audit.labels.length) {
    lines.push('### Labels', '', '| ID | Group | Label | Markers | Confidence | Alternatives | Evidence |', '| --- | --- | --- | --- | --- | --- | --- |');
    for (const label of audit.labels) {
      lines.push(`| ${label.id} | ${cell(`${label.grouping} ${label.group}`)} | ${cell(label.label)} | ${cell(label.markers.join(', '))} | ${label.confidence} | ${cell(label.alternatives.join(', ') || '—')} | ${cell(formatEvidence(label.evidence))} |`);
    }
    lines.push('');
  }
  if (audit.decisions.length) {
    lines.push('### Decisions', '', '| ID | Decision | Choice | Alternatives | Impact | Tested |', '| --- | --- | --- | --- | --- | --- |');
    for (const decision of audit.decisions) {
      const tested = decision.sensitivity ? `${decision.sensitivity.checked ? 'yes' : 'no'}: ${decision.sensitivity.summary}` : 'no';
      lines.push(`| ${decision.id} | ${cell(decision.title)} | ${cell(decision.choice)} | ${cell(decision.alternatives.join(', '))} | ${decision.impact} | ${cell(tested)} |`);
    }
    lines.push('');
  }
  if (audit.issues.length) {
    lines.push('### Issues', '', '| ID | Observation | Status | Resolution |', '| --- | --- | --- | --- |');
    for (const issue of audit.issues) lines.push(`| ${issue.id} | ${cell(issue.observation)} | ${issue.status} | ${cell(issue.resolution || '—')} |`);
    lines.push('');
  }
  lines.push('### Checklist', '', '| Item | Status | Note |', '| --- | --- | --- |');
  for (const item of audit.checklist) lines.push(`| ${cell(item.title)} | ${item.status} | ${cell(item.note || '')} |`);
  lines.push('');
  return lines.join('\n');
}

// The protocol agents follow; used in the MCP server instructions and the
// ledger tool descriptions so the wording stays the same everywhere.
export const LEDGER_PROTOCOL = Object.freeze([
  'Record your reasoning in the analysis ledger as you go, not at the end: a decision entry for every choice that could change results (thresholds, integration, resolution, gene sets), an annotation entry for every cluster you label (markers with values, confidence, alternatives), a finding entry for every claim you will make (with evidence that names the file and the exact row/value), an issue entry the moment something looks unexpected, and a check entry for each item of the standard checklist.',
  'Treat each issue as work, not as a caveat: investigate it with a follow-up run and resolve it with evidence, or accept it with a reason. If a short script could check a caveat, run it.',
  'After the first global clustering, re-cluster each major compartment the tissue has on its own (for example immune, lymphoid, myeloid, stromal, endothelial, neural, epithelial or tumor) and annotate the subtypes; global clusters hide them.',
  'Check each finding in every sample and record whether it holds in all, most, or one.',
  `Cite numbers from tables with a locator of the form "${LOCATOR_GRAMMAR}" and the value as written in the file; the ledger checks the value against the file and refuses a mismatch.`,
  'Before writing the report, read get_ledger_audit and close every blocking gap. In the report, cite findings as [F:<id>] and labels as [A:<id>] so each claim links to its evidence.',
]);
