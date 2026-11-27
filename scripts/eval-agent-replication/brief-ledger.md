# Analysis brief

You are an AI analysis agent delegated by a researcher in TraceOmics, a Seurat
analysis workbench. The researcher has handed you a new dataset and wants a first
complete analysis and a written report they can review.

## The study (what the researcher told you)

- Tissue: surgically resected **adamantinomatous craniopharyngioma (ACP)** tumors
  from three patients (sample1, sample2, sample3). Human. 10x Genomics Chromium 3' v3,
  Cell Ranger filtered matrices aligned to GRCh38.
- sample2 was taken at the junction between the tumor and the adjacent glial scar
  (reactive brain tissue); sample1 and sample3 are tumor tissue.
- Research question: characterize the cellular composition of ACP, the heterogeneity
  of the neoplastic (tumor) cells, and the tumor microenvironment, including how
  tumor cells may interact with surrounding cells. Report what you find, how
  confident you are, and what the researcher should check.
- There is no published reference for this dataset. You are the first to analyze it.

## Data

Read-only: `../data/sample{1,2,3}/` each containing `matrix.mtx.gz`,
`features.tsv.gz`, `barcodes.tsv.gz` (use `Seurat::Read10X`).

## Environment and rules

- Run R with `Rscript`. R 4.3, Seurat 5.0.1, SeuratObject, SingleR (no celldex
  reference downloads available), scran, scuttle, bluster, glmGamPoi, edgeR,
  limma, DESeq2, GSVA, fgsea (no msigdbr; write gene sets yourself if needed),
  org.Hs.eg.db, ComplexHeatmap, pheatmap, ggplot2, patchwork, cowplot.
  Not available: harmony, scDblFinder, CellChat, infercnv, monocle, SCENIC, internet.
  If you want a method that isn't installed, implement a simple, standard version
  yourself or state the limitation.
- No internet or web access of any kind. Do not read any file outside this
  directory and `../data/`. Do not install packages.
- Machine: 4 CPUs, keep each R process under ~6 GB RAM. Another analysis may be
  running at the same time. Save intermediate Seurat objects (`saveRDS`) so you
  don't recompute.
- Work only inside this directory.

## How TraceOmics expects agents to work (from the app's agent instructions)

TraceOmics normally gives agents verified (reviewed) workflows plus a sandbox for
their own R. In this session no workflows are approved, so everything is your own
R in the sandbox — the reviewer treats it as AI-written code that needs review.
The app's guidance to agents is:

> Keep scripts short and close to standard Seurat and Bioconductor calls so they
> are quick to review. Each script run needs a `reason` and the analysis `tab` it
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

- `scripts/NN_<tab>_<short-name>.R` — each script starts with a comment header
  `# tab: <tab>` and `# reason: <why this step>`. Run each with Rscript; save
  its console output to `logs/NN_....log`.
- `outputs/` — tables (`.csv`) and figures (`.png`) written by scripts.
- `notebook.md` — append-only notes, each headed `### [tab] title`.
- `report/report.md` — the final report for the researcher, section by section,
  with figures referenced by path.
- `ledger.jsonl` — the analysis ledger (see below), written only through the ledger tool.


## Analysis ledger (TraceOmics records your reasoning for the reviewer)

The reviewer will read the ledger audit before your report. Use the ledger tool:

```
L="node /home/user/scrna-seq/scripts/analysis-ledger-local.mjs"
$L add '<json entry>'      # validates and appends; prints the new id (D1, A3, F2, I1, C5 ...)
$L list [kind]
$L audit --report report/report.md --out report/audit.md
```

Run the tool from this directory (evidence `file` paths are relative to it and must exist). Entry kinds (all need `kind`, `tab`, `title`; `evidence` is a list of `{file, locator, value}` where locator is e.g. `row cluster=7, column pct` and value is the number you read there):

- `decision`: `choice`, `alternatives` (list), `rationale`, `impact` (high/medium/low), optional `sensitivity` `{checked: bool, summary}` (checked needs evidence).
- `annotation`: `grouping` (e.g. `seurat_clusters res0.6` or `myeloid_sub res0.5`), `group` (cluster id), `label`, `markers` (≥2 genes), `confidence`, `alternatives` (required unless confidence is high), optional `cells`, evidence (marker table rows with values).
- `finding`: `statement`, `confidence`, `sampleSupport` (all/most/one/not_checked/not_applicable), optional `limitations`; evidence with at least one locator/value.
- `issue`: `observation` (status defaults to open). Close it with a new issue entry `{status: resolved|accepted, refersTo: <issue id>, resolution, evidence}`.
- `check`: `item` (one of the checklist keys below), `status` (done/not_applicable/blocked), `note` (required unless done), evidence when done.

Protocol:

1. Record your reasoning in the analysis ledger as you go, not at the end: a decision entry for every choice that could change results (thresholds, integration, resolution, gene sets), an annotation entry for every cluster you label (markers with values, confidence, alternatives), a finding entry for every claim you will make (with evidence that names the file and the exact row/value), an issue entry the moment something looks unexpected, and a check entry for each item of the standard checklist.
2. Treat each issue as work, not as a caveat: investigate it with a follow-up run and resolve it with evidence, or accept it with a reason. If a short script could check a caveat, run it.
3. After the first global clustering, re-cluster each major compartment on its own (immune, T/NK, myeloid, stromal, glial, epithelial or tumor) and annotate the subtypes; global clusters hide them.
4. Check each finding in every sample and record whether it holds in all, most, or one.
5. Cite numbers from tables with a locator of the form "row <column>=<value>[, <column>=<value>...], column <column>" and the value as written in the file; the ledger checks the value against the file and refuses a mismatch.
6. Before writing the report, run `$L audit --report report/report.md` and close every blocking gap. In the report, cite findings as [F:<id>] and labels as [A:<id>] so each claim links to its evidence.

Standard checklist (answer every item with a `check` entry):

- `qc.thresholds` (qc): QC thresholds chosen from per-sample distributions. Plot nFeature, nCount and mitochondrial fraction per sample; state the thresholds and how many cells each removes per sample.
- `qc.doublets` (qc): Doublets detected and handled. Run a doublet method (or a documented score of co-expressed lineage markers); report the rate per sample and what was removed.
- `qc.ambient` (qc): Ambient RNA assessed. Check whether highly specific genes (Ig, hemoglobin, lineage markers) appear in clusters that should not express them; correct or state the effect.
- `integrate.compare` (integrate): Integrated and unintegrated structure compared. Show clusters by sample before and after integration; for every population that separates by sample, say whether it is batch or biology and why.
- `cluster.resolution` (cluster): Clustering checked at more than one resolution. Report which populations are stable across resolutions and which split or merge.
- `cluster.sample-composition` (cluster): Sample make-up of every cluster reported. Flag clusters dominated by one sample.
- `cluster.every-label` (cluster): Every cluster labeled with marker evidence. One annotation entry per cluster, each naming the markers (with their values) that support the label and the alternatives considered.
- `cluster.canonical-markers` (cluster): Canonical markers checked for every expected lineage. For each lineage expected in this tissue, show its canonical markers across clusters, including lineages you did not find (absence is a result).
- `cluster.subcluster` (cluster): Each major compartment re-clustered on its own. Subset each compartment with enough cells (for example immune, T/NK, myeloid, stromal, glial, epithelial/tumor), re-normalize, re-cluster and annotate the subtypes. Global clustering hides subtypes.
- `explore.malignancy` (explore): Malignant cells distinguished from normal cells. For tumors: copy-number inference or another orthogonal signal; say which cells are called malignant and how confident that call is. Not applicable to non-tumor tissue.
- `deg.replicate-aware` (deg): Comparisons are replicate-aware. Use pseudobulk across samples for between-condition claims, or state that cell-level p-values are descriptive only.
- `explore.cross-sample` (explore): Main findings checked in each sample. For every finding, report whether it holds in all samples, most, or one.
- `explore.anomalies` (explore): Every anomaly investigated. Each unexpected signal is an issue entry, resolved by a follow-up run or explicitly accepted with a reason. A caveat that a short script could check is not a caveat: run the script.
- `cellchat.limitations` (cellchat): Interaction analysis method and limits stated. Name the database or pair list, the statistic, and what the result can and cannot support.

Finish only when `$L audit` shows 0 blocking gaps; save it with `--out report/audit.md`.

Work autonomously until the analysis and report are complete. When done, reply
with a short summary of your main findings and where the report is.
