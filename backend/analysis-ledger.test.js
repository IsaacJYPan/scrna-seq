/**
 * The analysis ledger's validation and audit (shared/analysisLedger.mjs).
 * Database-backed behaviour (evidence verification, append-only rows, the
 * report export and finalization gate) is in agent-sandboxes.test.js.
 */
import { describe, expect, it } from 'vitest';

const {
  normalizeLedgerEntry, auditLedger, renderAuditMarkdown, ANALYSIS_CHECKLIST, CHECKLIST_KEYS, LEDGER_PROTOCOL, checkCitedValue,
} = require('../shared/analysisLedger.mjs');
const { LEDGER_CHECKLIST_KEYS, MCP_INSTRUCTIONS } = require('../cli/traceomics-mcp.mjs');

const ref = (extra = {}) => ({ file: 'markers.csv', locator: 'cluster 7, gene LEF1', value: 'avg_log2FC 3.1', ...extra });
const finding = (extra = {}) => ({
  kind: 'finding', tab: 'cluster', title: 'WNT-active tumor cells', statement: 'Cluster 7 expresses LEF1 and WNT5A.',
  confidence: 'high', sampleSupport: 'all', evidence: [ref()], ...extra,
});
const ids = (entries) => entries.map((entry, index) => ({ id: `e${index + 1}`, ...entry }));

function codeOf(fn) {
  try { fn(); } catch (error) { return [error.code, error.field, error.message]; }
  return null;
}

describe('ledger entry validation', () => {
  it('accepts a well-formed entry of each kind and drops nothing it was given', () => {
    expect(normalizeLedgerEntry(finding())).toEqual({ ...finding(), evidence: [ref()] });
    expect(normalizeLedgerEntry({
      kind: 'decision', tab: 'qc', title: 'Mitochondrial cutoff', choice: 'percent.mt < 15', alternatives: ['< 10', '< 20'],
      rationale: 'Per-sample 99th percentile is 14-16%.', impact: 'medium',
      sensitivity: { checked: true, summary: 'At < 20 every cluster keeps its label.' }, evidence: [ref({ file: 'qc.csv' })],
    })).toMatchObject({ kind: 'decision', impact: 'medium', sensitivity: { checked: true } });
    expect(normalizeLedgerEntry({
      kind: 'annotation', tab: 'cluster', title: 'Cluster 12', grouping: 'seurat_clusters res0.6', group: 12,
      label: 'T cells', markers: ['CD3E', 'CD2'], confidence: 'high', cells: 428, evidence: [ref()],
    })).toMatchObject({ group: '12', alternatives: [], cells: 428 });
    expect(normalizeLedgerEntry({ kind: 'check', tab: 'qc', title: 'Doublets', item: 'qc.doublets', status: 'blocked', note: 'No method installed.' }))
      .toMatchObject({ status: 'blocked', evidence: [] });
  });

  it('refuses entries a reviewer could not check', () => {
    expect(codeOf(() => normalizeLedgerEntry(finding({ evidence: [] })))?.[1]).toBe('evidence');
    expect(codeOf(() => normalizeLedgerEntry(finding({ evidence: [{ file: 'markers.csv' }] })))?.[2]).toMatch(/locator or value/);
    expect(codeOf(() => normalizeLedgerEntry(finding({ sampleSupport: 'several' })))?.[1]).toBe('sampleSupport');
    expect(codeOf(() => normalizeLedgerEntry(finding({ extra: 1 })))?.[0]).toBe('INVALID_LEDGER_ENTRY');
    expect(codeOf(() => normalizeLedgerEntry(finding({ evidence: [ref({ file: '../secrets.txt' })] })))?.[1]).toBe('evidence[0].file');
    // A medium/low label must say what else it could be.
    expect(codeOf(() => normalizeLedgerEntry({
      kind: 'annotation', tab: 'cluster', title: 'c9', grouping: 'g', group: '9', label: 'OPC', markers: ['OLIG2', 'SOX10'],
      confidence: 'low', evidence: [ref()],
    }))?.[1]).toBe('alternatives');
    expect(codeOf(() => normalizeLedgerEntry({ kind: 'check', tab: 'qc', title: 'x', item: 'qc.made-up', status: 'done' }))?.[1]).toBe('item');
    expect(codeOf(() => normalizeLedgerEntry({ kind: 'check', tab: 'qc', title: 'x', item: 'qc.doublets', status: 'done' }))?.[1]).toBe('evidence');
  });

  it('closes an issue only by a later entry that refers to it, with evidence when resolved', () => {
    const open = { kind: 'issue', tab: 'qc', title: 'IGKC in myeloid cluster', observation: 'IGKC is high in cluster 11.' };
    expect(normalizeLedgerEntry(open).status).toBe('open');
    const close = { kind: 'issue', tab: 'qc', title: 'IGKC explained', observation: 'Subclustered 11.', status: 'resolved',
      refersTo: 'e1', resolution: '24 B cells sit in cluster 11.', evidence: [ref()] };
    expect(codeOf(() => normalizeLedgerEntry(close))?.[1]).toBe('refersTo');
    expect(normalizeLedgerEntry(close, { known: new Set(['e1']) }).status).toBe('resolved');
    expect(codeOf(() => normalizeLedgerEntry({ ...close, evidence: [] }, { known: new Set(['e1']) }))?.[1]).toBe('evidence');
    expect(normalizeLedgerEntry({ ...close, status: 'accepted', evidence: [] }, { known: new Set(['e1']) }).status).toBe('accepted');
  });
});

describe('ledger audit', () => {
  it('lists every checklist item that was not addressed as blocking, and no findings as blocking', () => {
    const audit = auditLedger([]);
    expect(audit.counts.blocker).toBe(ANALYSIS_CHECKLIST.length + 1);
    expect(audit.gaps.map((gap) => gap.code)).toContain('NO_FINDINGS');
    expect(audit.checklist.every((item) => item.status === 'missing')).toBe(true);
  });

  it('orders gaps by severity and tracks the latest label, check and issue state', () => {
    const entries = ids([
      finding({ sampleSupport: 'one', title: 'IFN state' }),
      { kind: 'issue', tab: 'qc', title: 'IGKC in myeloid', observation: 'IGKC high', status: 'open', evidence: [] },
      { kind: 'issue', tab: 'cluster', title: 'Cycling over-called', observation: 'S phase in non-cycling', status: 'open', evidence: [] },
      { kind: 'issue', tab: 'qc', title: 'IGKC explained', observation: 'subclustered', status: 'resolved', refersTo: 'e2', resolution: 'B cells', evidence: [ref()] },
      { kind: 'annotation', tab: 'cluster', title: 'c9', grouping: 'g', group: '9', label: 'OPC', markers: ['OLIG2', 'SOX10'], confidence: 'low', alternatives: ['astrocyte'], evidence: [ref()] },
      { kind: 'annotation', tab: 'cluster', title: 'c9', grouping: 'g', group: '9', label: 'Reactive astrocyte', markers: ['GFAP', 'AQP4'], confidence: 'high', alternatives: [], evidence: [ref()] },
      { kind: 'decision', tab: 'integrate', title: 'Integration', choice: 'RPCA', alternatives: ['none'], rationale: 'r', impact: 'high', evidence: [] },
      ...CHECKLIST_KEYS.map((item) => ({ kind: 'check', tab: 'qc', title: item, item, status: 'done', evidence: [ref()] })),
      { kind: 'check', tab: 'qc', title: 'doublets', item: 'qc.doublets', status: 'blocked', note: 'not installed', evidence: [] },
    ]);
    const audit = auditLedger(entries);
    expect(audit.gaps.map((gap) => [gap.severity, gap.code])).toEqual([
      ['blocker', 'ISSUE_OPEN'],
      ['review', 'CHECK_BLOCKED'],
      ['review', 'FINDING_SINGLE_SAMPLE'],
      ['review', 'DECISION_UNTESTED'],
    ]);
    expect(audit.gaps[0].entryIds).toEqual(['e3']);
    expect(audit.labels).toEqual([expect.objectContaining({ id: 'e6', label: 'Reactive astrocyte' })]);
    expect(audit.issues.map((issue) => [issue.id, issue.status])).toEqual([['e2', 'resolved'], ['e3', 'open']]);
    expect(audit.checklist.find((item) => item.key === 'qc.doublets').status).toBe('blocked');
  });

  it('checks the report text against the ledger', () => {
    const entries = ids([finding(), finding({ title: 'second' })]);
    const uncited = auditLedger(entries, { reportText: 'Tumor cells are WNT-active.' });
    expect(uncited.gaps.map((gap) => gap.code)).toEqual(expect.arrayContaining(['REPORT_UNCITED', 'FINDING_NOT_IN_REPORT']));
    const cited = auditLedger(entries, { reportText: 'WNT-active cells [F:e1]; see also [F:e9].' });
    expect(cited.citations).toEqual({ cited: 2, unknown: ['e9'], uncitedFindings: ['e2'] });
    expect(cited.gaps.filter((gap) => gap.code === 'CITATION_UNKNOWN')).toHaveLength(1);
  });

  it('flags finished runs that no entry cites', () => {
    const entries = ids([finding({ evidence: [ref({ sandboxRunId: `sbr_${'a'.repeat(24)}` })] })]);
    const runs = [{ id: `sbr_${'a'.repeat(24)}`, title: 'Markers' }, { id: `sbr_${'b'.repeat(24)}`, title: 'Resolution 1.2 try' }];
    const audit = auditLedger(entries, { runs });
    expect(audit.uncitedRuns).toEqual([{ id: `sbr_${'b'.repeat(24)}`, title: 'Resolution 1.2 try' }]);
    expect(audit.gaps.find((gap) => gap.code === 'RUN_NOT_IN_LEDGER')).toMatchObject({ severity: 'review', message: expect.stringContaining('1 of 2 finished run(s)') });
    expect(auditLedger(entries).uncitedRuns).toBeNull();
  });

  it('renders the audit as a review packet with each claim next to its evidence', () => {
    const markdown = renderAuditMarkdown(auditLedger(ids([finding({ evidence: [ref({ sandboxRunId: `sbr_${'a'.repeat(24)}` })] })])));
    expect(markdown).toContain('## Audit');
    expect(markdown).toContain(`| e1 | Cluster 7 expresses LEF1 and WNT5A. | high | all | \`sbr_${'a'.repeat(24)}:markers.csv\` @ cluster 7, gene LEF1 = avg_log2FC 3.1 |`);
    expect(markdown).toContain('### Checklist');
  });
});

describe('cited value check', () => {
  const markers = '"p_val","avg_log2FC","cluster","gene"\n1e-10,3.0412,"7","LEF1"\n1e-5,1.2,"7","WNT5A"\n2e-3,0.9,"2","LEF1"\n';
  const fractions = '"","sample1","sample2"\n"Tumor",0.9614,0.4005\n"Immune",0.0300,0.4300\n';
  const check = (text, file, locator, value) => checkCitedValue(text, { file, locator, value });

  it('matches the cell the locator names, at the precision cited', () => {
    expect(check(markers, 'm.csv', 'row cluster=7, gene=LEF1, column avg_log2FC', '3.04')).toMatchObject({ status: 'matched', found: '3.0412' });
    expect(check(markers, 'm.csv', 'row cluster=7, gene=LEF1, column avg_log2FC', '3.0412')).toMatchObject({ status: 'matched' });
    // write.csv row names: the first header cell is empty.
    expect(check(fractions, 'f.csv', 'row compartment=Tumor, column sample2', '0.4005').status).toBe('matched');
    expect(check(fractions, 'f.csv', 'row compartment=Tumor, column sample2', '40.05%').status).toBe('matched');
  });

  it('reports a different number, a missing row or column as a mismatch', () => {
    expect(check(markers, 'm.csv', 'row cluster=7, gene=LEF1, column avg_log2FC', '4.1')).toMatchObject({ status: 'mismatched', found: '3.0412' });
    expect(check(fractions, 'f.csv', 'row compartment=Tumor, column sample2', '0.50')).toMatchObject({ status: 'mismatched', found: '0.4005' });
    expect(check(markers, 'm.csv', 'row cluster=9, gene=LEF1, column avg_log2FC', '3.04').status).toBe('mismatched');
    expect(check(markers, 'm.csv', 'row cluster=7, gene=LEF1, column logFC', '3.04').status).toBe('mismatched');
  });

  it('leaves what it cannot locate unchecked rather than guessing', () => {
    expect(check(markers, 'm.csv', 'cluster 7 LEF1', '3.04').status).toBe('unchecked');
    expect(check(markers, 'm.csv', 'row gene=LEF1, column avg_log2FC', '3.04').status).toBe('unchecked');
    expect(check(markers, 'umap.png', 'row gene=LEF1, column avg_log2FC', '3.04').status).toBe('unchecked');
  });
});

describe('MCP server', () => {
  it('lists the same checklist and tells agents the ledger protocol', () => {
    expect(LEDGER_CHECKLIST_KEYS).toEqual(CHECKLIST_KEYS);
    expect(MCP_INSTRUCTIONS).toContain('record_ledger_entry');
    expect(MCP_INSTRUCTIONS).toContain('get_ledger_audit');
    expect(MCP_INSTRUCTIONS).toContain('re-cluster each major compartment');
    expect(MCP_INSTRUCTIONS).toContain('EVIDENCE_VALUE_MISMATCH');
    expect(LEDGER_PROTOCOL.length).toBeGreaterThan(0);
  });
});
