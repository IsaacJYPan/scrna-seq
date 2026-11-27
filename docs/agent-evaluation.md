# Agent evaluation: blind replication of a published study

How well does an agent analyze a dataset it has never seen, and how much work
is it for a person to check? To find out, we give the agent the raw data of a
published study and only what the researcher would know before analyzing it.
No paper and no web access. We then grade the result against the publication.
Two runs used the agent guidance TraceOmics had before the
[analysis ledger](agent-automation.md#analysis-ledger) (baseline). Two used the
ledger protocol and checklist. The harness is in
[`scripts/eval-agent-replication/`](../scripts/eval-agent-replication/README.md).

## Setup

- **Dataset.** Jiang et al., *Sci Adv* 2023;9:eadc8933: adamantinomatous
  craniopharyngioma, 3 patients, 10x Chromium 3′ v3. Raw Cell Ranger matrices
  are on Zenodo (record 7199080).
- **What the agent was told.** The tissue and the three samples, that sample2
  came from the tumor–glial scar junction, and the research question:
  composition, tumor heterogeneity, microenvironment, and interactions.
- **Model and runs.** Sonnet, four independent runs (A, B baseline; C, D
  ledger), each in its own folder with the same data. They ran two at a time
  on 4 CPUs.
- **Environment.** R 4.3 and Seurat 5.0.1 with common Bioconductor packages.
  scDblFinder, infercnv, CellChat, decontX and harmony were not installed, so
  agents wrote simple versions or stated the gap. In TraceOmics, several of
  these are trusted methods.
- **Grading.** Only results that can be recovered from these three samples
  count. The paper also integrated external PBMC and brain data, which the
  agents did not have.

## Results

| Published result | A | B | C (ledger) | D (ledger) |
| --- | --- | --- | --- | --- |
| ~27.7k cells after QC and doublet removal | 30.6k, no doublets | 31.5k, no doublets | **27.5k** | **27.1k** |
| Whorl-like WNT state (LEF1, WNT5A; FGF4, BMP4, WNT10A/B, SHH ligands) | yes | yes | yes | yes |
| Keratinized-like state (KRT6, KRT75) | yes | yes | yes | yes |
| Cycling state | yes | yes | yes | yes |
| Palisade-like stress/inflammatory state | yes (CXCL1/FOSL1) | no | not separated | yes (CXCL-high) |
| Strong patient-specific tumor structure | partly | yes | yes, quantified | yes |
| Tumor Tregs (FOXP3) | **missed** (54 of 428 T cells FOXP3+) | missed | **yes** | **yes** |
| B cells | **missed** (~24 inside a myeloid cluster) | plasma only | plasma only | **yes** |
| OPCs (OLIG2/SOX10) | mislabeled | "neuron-like" | **yes** | **yes** |
| Epithelium carries more CNV | not tested | no signal | no signal | weak (1.2 vs 1.0) |
| MHC-II⁺ "immune" oligodendrocytes | missed | missed | missed (MHC-II⁺ astrocytes) | missed |
| T-cell exhaustion, tumor trajectory | missed | missed | missed | missed |
| WNT/FGF ligands from the whorl-like state | yes | yes | yes | yes |

| | A | B | C | D |
| --- | --- | --- | --- | --- |
| Scripts | 6 | 5 | 17 | 14 |
| Wall time | 26 min | 36 min | 64 min | 56 min |
| Ledger entries (findings / labels / issues) | — | — | 121 (14 / 58 / 26) | 96 (11 / 51 / 12) |
| Cited values that match the cited table cell | — | — | 375 of 375 checkable | 286 of 286 |

## What the baseline runs got wrong

The headline biology was right in all four runs. The baseline runs failed in
the same three ways, and all three are cheap to fix:

1. **One clustering pass.** Neither baseline run re-clustered a compartment on
   its own, which is why both missed the Tregs and B cells.
2. **Anomalies explained away.** Run A attributed IGKC in a macrophage cluster
   to ambient RNA. There were B cells in that cluster.
3. **Caveats instead of checks.** Run A wrote that it "did not check
   P2RY12/TMEM119 cluster-wise", which takes one line of code to check.

Reviewing them was slow for a separate reason. Every cluster label was one
hard-coded line in a script, with no evidence next to it. Report numbers
pointed at console logs. Gene signatures typed from memory had misleading names.
Checking one claim meant cross-reading the script, the marker table and a plot.

## What the ledger changed

- **Coverage.** Both ledger runs answered every checklist item. They detected
  and removed doublets, compared integrated and unintegrated structure,
  checked several resolutions and re-clustered each compartment. That is where
  the extra true results came from: Tregs, B cells and OPCs, and cell counts
  within 2–3% of the paper.
- **Audit cost.** Every label, finding and issue is a row with its markers and
  the file, row and value that support it. All 661 cited values matched their
  tables, and the server now refuses a mismatch. Reports cite ledger entries,
  so a reviewer checks claims, not code.
- **Cost.** About twice the time and tokens of a baseline run.

## Still open

- **Entries are written at the end.** Both ledger runs wrote nearly all entries
  in the last minutes, even though the protocol says to record as they go.
  The values were still correct, because the agents copied them from their
  outputs. But a reviewer following a run in progress sees little, and issue
  entries written afterwards cannot show that the issue changed what the agent
  did next. The audit now lists finished runs that no entry cites
  (`RUN_NOT_IN_LEDGER`). Making recording a condition of the next run is a
  possible next step.
- **Free-text numbers are not checked.** Run C corrected its own typos in an
  annotation's `cells` count and a sensitivity summary. Only values cited
  through a table locator are checked.
- **Deeper biology is still missed.** No run found the MHC-II⁺ oligodendrocytes,
  T-cell exhaustion or the trajectory. The checklist makes the standard
  workflow reliable; it does not supply the domain hypotheses a researcher
  brings. Run D's glial subcluster did have CD74 and HLA-DRA among its
  markers, but it was labeled "ciliated/ependymal-like" without comment. A
  checklist item asking for the top markers that do not fit a cluster's label
  could catch cases like this.
- **Small sample.** Two datasets. Ledger runs: two on the first, one on the
  second. Repeat on more studies before generalizing.

## Second study: diabetes × stroke, multiple conditions

To check that the protocol is not tuned to one tumor dataset, one ledger run
(E) analyzed a study with a different design.

- **Data.** Mouse PBMCs in a 2 × 2 design: db/db (type 2 diabetes) vs db/+
  controls, each with ischemic stroke (dMCAO) or sham surgery. One 10x library
  per group, raw Cell Ranger v1.3 matrices (Zenodo 14117450).
- **Answer key.** Only the abstract of the preprint could be read
  (bioRxiv 10.1101/2024.06.03.597050, Europe PMC PPR860915), so the key is its
  four claims.
- **Brief.** Generated by `make-brief.mjs` from `studies/t2d-stroke-pbmc.md` with
  the current checklist. The local ledger tool enforced `LEDGER_BEHIND`.

| Published claim | Run E |
| --- | --- |
| T2DM expands monocytes at the expense of lymphocytes | **Yes.** Monocytes 47–65% of cells in db/db vs 31–34% in db/+; T cells 1.7–4.2% vs 22–24%; same direction in both surgery strata |
| T2DM increases inflammatory Ly6C⁺ MHC-II⁻ monocytes; db/+ sham richest in Ly6C⁺ MHC-II⁺ | **Mostly.** A Ly6c2⁺ Ccr1/Prtn3-high classical subset is enriched in db/db (21–25% vs 13% of monocytes), MHC-II-high monocytes are depleted in db/db, and db/+ sham has the largest MHC-II-high share (11.3%). Called low confidence. The subsets were not named by Ly6C/MHC-II status |
| Inflammation and coagulation pathways up in T2DM monocytes | **Inflammation yes** (S100a8, Lcn2; inflammatory-response NES +2.2). **Coagulation not reported**, although F13a1 marks the db/db-enriched subset |
| Type I and II interferon signaling suppressed in T2DM monocytes | **Yes.** Lower Gbp2, Stat1 and H2-Ab1; IFN-α NES −2.76, IFN-γ NES −2.73, MHC-II antigen presentation −2.14 |

Beyond the four claims:

- **Replicates.** The run stated that one library per group confounds group with
  batch, and treated the edgeR p-values (one residual degree of freedom) as a
  ranking only.
- **Consistency across contrasts.** It checked each genotype effect in both
  surgery strata.
- **Technical artefacts it caught.** Hemoglobin-dominated droplets, ambient
  S100a8/9 in one library, and a technical shift in both stroke libraries,
  detected with a lymphocyte control. It did not interpret the raw stroke DE
  list.
- **Ledger.** 77 entries across 15 runs. The entries were interleaved with the
  runs instead of written at the end, so the record-as-you-go gate worked.
  All 477 cited values matched their tables.

The checklist carried over to a different design without changes: the
malignancy item was replaced by `explore.orthogonal-support` and marked not
applicable. The remaining miss is again interpretive. A coagulation gene
marked the enriched subset, but the run did not draw the pathway-level
conclusion.
