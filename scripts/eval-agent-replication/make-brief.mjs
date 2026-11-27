#!/usr/bin/env node
// Builds an agent brief for a blind replication from a study description and
// the current ledger protocol and checklist (shared/analysisLedger.mjs), so
// the brief always matches what the server enforces.
//
//   node make-brief.mjs <study.md> [--baseline] > BRIEF.md
//
// <study.md> holds only what the researcher would know before analyzing:
// "## The study" (design, samples, question) and "## Data" (where the files
// are and their format). Never put published results in it.

import fs from 'node:fs';
import { ANALYSIS_CHECKLIST, LEDGER_PROTOCOL } from '../../shared/analysisLedger.mjs';

const LEDGER_TOOL = 'node /home/user/scrna-seq/scripts/analysis-ledger-local.mjs';

const COMMON = `## Environment and rules

- Run R with \`Rscript\`. R 4.3, Seurat 5.0.1, SeuratObject, SingleR (no celldex
  reference downloads available), scran, scuttle, bluster, glmGamPoi, edgeR,
  limma, DESeq2, GSVA, fgsea (no msigdbr; write gene sets yourself if needed),
  org.Hs.eg.db (human only), ComplexHeatmap, pheatmap, ggplot2, patchwork, cowplot.
  Not available: harmony, scDblFinder, CellChat, infercnv, monocle, SCENIC, internet.
  If you want a method that isn't installed, implement a simple, standard version
  yourself or state the limitation.
- No internet or web access of any kind. Do not read any file outside this
  directory and \`../data/\`. Do not install packages.
- Machine: 4 CPUs, keep each R process under ~6 GB RAM. Save intermediate
  objects (\`saveRDS\`) so you don't recompute.
- Work only inside this directory.

## How TraceOmics expects agents to work (from the app's agent instructions)

TraceOmics normally gives agents verified (reviewed) workflows plus a sandbox for
their own R. In this session no workflows are approved, so everything is your own
R in the sandbox — the reviewer treats it as AI-written code that needs review.
The app's guidance to agents is:

> Keep scripts short and close to standard Seurat and Bioconductor calls so they
> are quick to review. Each script run needs a \`reason\` and the analysis \`tab\` it
> serves (qc, normalize, pca, integrate, cluster, umap, deg, enrichment, cellchat,
> explore). Everything you do is laid out for people as a notebook filed under the
> analysis tab. Use notebook notes for a short Markdown note before or after a step
> (what you are about to do, what a result means). Notes and runs are append-only.
> Writing up: write a report section by section (Markdown, with figures that
> reference your run outputs) for a person to review.

Reviewed methods the app has (you may mirror them in your own code): Seurat
QC/normalize/cluster, multi-sample Seurat, cluster markers, doublet detection,
subset cells, re-cluster with batch integration, manual cluster labeling,
cell-cycle scoring, AddModuleScore signatures, expression figures, differential
abundance (propeller), trajectory (slingshot), ambient RNA (decontX), pseudobulk
DE (edgeR), SingleR annotation, GSEA (fgsea), CellChat.

Mirror that structure on disk:

- \`scripts/NN_<tab>_<short-name>.R\` — each script starts with a comment header
  \`# tab: <tab>\` and \`# reason: <why this step>\`.
- \`outputs/\` — tables (\`.csv\`) and figures (\`.png\`) written by scripts.
- \`notebook.md\` — append-only notes, each headed \`### [tab] title\`.
- \`report/report.md\` — the final report for the researcher, section by section,
  with figures referenced by path.
`;

const BASELINE_RUN = `
Run each script with Rscript and save its console output to \`logs/NN_....log\`.
`;

function ledgerSection() {
  const protocol = LEDGER_PROTOCOL.map((text) => text
    .replace('read get_ledger_audit', `run \`$L audit --report report/report.md\``)
    .replace('Before writing the report, read get_ledger_audit', `Before writing the report, run \`$L audit --report report/report.md\``));
  const checklist = ANALYSIS_CHECKLIST.map((item) => `- \`${item.key}\` (${item.tab}): ${item.title}. ${item.detail}`);
  return `- \`ledger.jsonl\`, \`runs.jsonl\` — the analysis ledger and the run record, written only through the ledger tool.

## Analysis ledger (TraceOmics records your reasoning for the reviewer)

People watch the ledger in the notebook while you work, and the reviewer reads
its audit before your report. Use the ledger tool for every script run and every
entry:

\`\`\`
L="${LEDGER_TOOL}"
$L run scripts/NN_tab_name.R [args]   # runs the script, saves logs/, records which outputs it wrote
$L add '<json entry>'                 # validates and appends; prints the new id (D1, A3, F2, I1, C5 ...)
$L list [kind]
$L audit --report report/report.md --out report/audit.md
\`\`\`

Run the tool from this directory. \`$L run\` refuses to start a script while more
than one finished run has no ledger entry citing one of its outputs
(LEDGER_BEHIND): record what each run showed as you go. Evidence \`file\` paths
are relative to this directory and must exist.

Entry kinds (all need \`kind\`, \`tab\`, \`title\`; \`evidence\` is a list of
\`{file, locator, value}\`; for CSV/TSV tables the locator is
\`row <column>=<value>[, <column>=<value>...], column <column>\` and the value is
checked against the file):

- \`decision\`: \`choice\`, \`alternatives\` (list), \`rationale\`, \`impact\` (high/medium/low), optional \`sensitivity\` \`{checked: bool, summary}\` (checked needs evidence).
- \`annotation\`: \`grouping\` (e.g. \`seurat_clusters res0.6\` or \`myeloid_sub res0.5\`), \`group\` (cluster id), \`label\`, \`markers\` (≥2 genes), \`confidence\`, \`alternatives\` (required unless confidence is high), optional \`cells\`, evidence (marker table rows with values).
- \`finding\`: \`statement\`, \`confidence\`, \`sampleSupport\` (all/most/one/not_checked/not_applicable), optional \`limitations\`; evidence with at least one locator/value.
- \`issue\`: \`observation\` (status defaults to open). Close it with a new issue entry \`{status: resolved|accepted, refersTo: <issue id>, resolution, evidence}\`.
- \`check\`: \`item\` (one of the checklist keys below), \`status\` (done/not_applicable/blocked), \`note\` (required unless done), evidence when done.

Protocol:

${protocol.map((text, index) => `${index + 1}. ${text}`).join('\n')}

Standard checklist (answer every item with a \`check\` entry; use not_applicable with a reason when an item does not fit this study):

${checklist.join('\n')}

Finish only when \`$L audit\` shows 0 blocking gaps; save it with \`--out report/audit.md\`.
`;
}

const [studyFile, flag] = process.argv.slice(2);
if (!studyFile) {
  process.stderr.write('usage: node make-brief.mjs <study.md> [--baseline]\n');
  process.exit(1);
}
const study = fs.readFileSync(studyFile, 'utf8').trim();
const baseline = flag === '--baseline';
process.stdout.write(`# Analysis brief

You are an AI analysis agent delegated by a researcher in TraceOmics, a Seurat
analysis workbench. The researcher has handed you a new dataset and wants a first
complete analysis and a written report they can review.

${study}

${COMMON}${baseline ? BASELINE_RUN : ledgerSection()}
Work autonomously until the analysis and report are complete. When done, reply
with a short summary of your main findings and where the report is.
`);
