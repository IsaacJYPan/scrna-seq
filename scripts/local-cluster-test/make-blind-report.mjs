import fs from 'node:fs';
const dir='exports/blind-study/';
const result=JSON.parse(fs.readFileSync(dir+'blind-evaluation.json'));
const audit=JSON.parse(fs.readFileSync(dir+'blinding-audit.json'));
const report=`Blinded app-only population recovery benchmark

Source: Tian et al. (2019), Benchmarking single cell RNA-sequencing analysis
pipelines using mixture control experiments. Nature Methods 16, 479-487.
DOI: 10.1038/s41592-019-0425-8
Authors' data/code: https://github.com/LuyiTian/sc_mixology
Dataset: complete post-QC single-cell 10x experiment, 902 cells, 16,468 genes.
Ground truth: authors' cell_line_demuxlet labels, withheld from the analyst.

Design:
- Subagent spawned with fork_turns=none: no previous conversation or results.
- Neutral sample-A name and cell IDs; only raw counts and gene identifiers
  were imported into the app. All metadata, labels, logcounts, reductions,
  paper identity, expected population count and expected markers were withheld.
- Agent used only the thin authenticated app client. Seurat normalization,
  feature selection, PCA, graph clustering, UMAP and Wilcoxon markers ran
  inside actual app jobs. SSH/SCP and R were real; Slurm was simulated locally.
- This tests the app's authenticated API used by its UI, not only the narrower
  delegated-agent MCP interface. No standalone R/Python analysis by the child.
- Approximate methods guidance supplied: human UMI counts; retain all cells;
  LogNormalize 10000, 2000 variable features, PCA 20, neighborhoods/UMAP on
  10-20 PCs, seed 42; choose resolution independently; at most three trials.
- Parent corrected missing API schema help after a validation error. No
  biological feedback, score, reference labels or target outcome was sent.
- Final selection and complete agent conclusion were hashed before scoring.
  The reference and criteria were frozen before agent start and hash-verified.

Prespecified criteria:
All 902 cells retained; three populations; adjusted Rand index >= 0.95;
best one-to-one label accuracy >= 0.95. The agent was not given these criteria.
One-to-one matching penalizes overclustering, unlike many-to-one purity.

Locked result:
Selected object: ${result.selected_analysis_object_id}
Selected job: ${result.selected_job_id}
App cells: ${result.app_cells}; app clusters: ${result.app_clusters}
Reference populations: ${result.reference_populations}
Adjusted Rand index: ${result.adjusted_rand_index}
Best one-to-one accuracy: ${(100*result.best_one_to_one_accuracy).toFixed(4)}%
Matched cells: ${result.matched_cells}/${result.reference_cells}
Mismatched/unmatched cells: ${result.mismatched_or_unmatched_cells}
Additional diagnostic cluster purity: ${(100*result.additional_diagnostic_many_to_one_purity).toFixed(4)}%
This many-to-one diagnostic is not a pass criterion. Unmatched cells in the
one-to-one score include subdivisions of the same reference lineage, not only
cells crossing lineage boundaries. In this run, the reference populations were
each split into two app clusters and only one cell crossed a lineage boundary.
Criteria: ${JSON.stringify(result.criteria)}
All prespecified criteria passed: ${result.all_preregistered_criteria_pass}

Blinding audit:
Reference frozen: ${audit.referenceFrozenAt}
Selection locked: ${audit.selectionLockedAt}
Reference/selection/checkpoint hashes verified: true
Publication/cell-line identifiers found in app transcript: ${JSON.stringify(audit.publicationIdentifiersFound)}

Interpretation and limits:
This is a complete dataset population-recovery experiment, not a replication
of all preprocessing/normalization/trajectory/platform comparisons in the
paper or a byte-identical reproduction of its historical software outputs.
Modern Seurat differs from the original environment. Author post-QC cells and
their genotyping labels were used as published reference inputs.
Blinding is procedural: fresh context plus explicitly restricted tools, not
an adversarial filesystem boundary or guarantee against pretrained knowledge.
The app-response audit checks named identifiers, not every conceivable clue.
No reference-driven rerun or parameter tuning occurred after selection lock.

Read agent-conclusion.txt for the agent's unedited scientific interpretation.
Read app-transcript.jsonl for the actual app calls and returned results.
reference-confusion-matrix.csv and cell-assignment-comparison.csv contain the
per-population and per-cell comparisons. reference-comparison.png visualizes
the correspondence. selected-checkpoint.rds preserves the selected app output.
`;
fs.writeFileSync(dir+'report.txt',report);
console.log('Saved blinded benchmark report.');
