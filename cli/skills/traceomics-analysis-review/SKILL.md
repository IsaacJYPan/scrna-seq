---
name: traceomics-analysis-review
description: Review intermediate single-cell evidence in TraceOmics, choose follow-up analyses that resolve consequential uncertainty, and document what the results support.
---

# Review evidence before choosing the next step

Start with the biological question, tissue and sampling frame, upstream filtering, and unit of replication. Inspect the sample sheet for independent donors or specimens, conditions, paired collections, and technical factors. Identify which strata support condition comparisons. In a paper-blind study, use the supplied design and general marker knowledge. Save the population definitions, decisions, and results before opening the target publication or its study-specific annotations.

For a multistep request, keep a short list of requested analyses and the result expected from each. Track each as pending, reviewed, or blocked. Record the artifact ID for reviewed results and the specific unmet requirement for blocked work.

## Use evidence to decide whether to proceed

1. Before relying on an intermediate result, identify the decision it will inform, the strongest plausible competing explanation, and an observation that would change the decision.
2. Open the relevant artifact and check which cells, specimens, features, or comparisons it covers. If the ambiguity could change the conclusion, run the smallest informative check the study permits. Hold other consequential choices fixed where feasible. If a check changes the cohort or denominator, record that change when interpreting the result.
3. Read the check and decide whether to proceed, revise the population or analysis, or report a narrower conclusion. Record the artifact ID, observation, and decision as you go. One or two sentences usually suffice.

A journal entry might read “The inclusion table shows uneven cell coverage across conditions, which could affect candidate detection. I compared the same populations with matched cell totals and saw the candidate drop below the reporting threshold, so I reported its dependence on sampling.” When a table or figure is truncated, page it where possible. When a decisive comparison is unavailable, name the missing evidence and qualify the claim.

## Review QC and PCA before building the graph

- Check what cell selection already occurred. Use per-sample quality distributions and before/after retention to justify any additional filters. Investigate disproportionate losses by donor, condition, or plausible rare population. If a metric is zero across captures, check how many features matched and inspect their identifiers before interpreting the values.
- Inspect PCA variance, an elbow or other variance profile, and available loadings or scores. Check for lineage signals, depth, cell cycle, donor, and technical separation before choosing graph dimensions. Record the variance denominator. Variance fractions among stored PCs describe those PCs.
- Use staged runs where available. In an approved Seurat workflow, inspect `stopAfter=qc` and `stopAfter=pca` before committing to graph settings. If a combined run is the first source of evidence, review its choices and revise them where the evidence calls for it.
- When using a subsample for exploration, check coverage of the populations and replicates needed for the next analysis. If the cap limits that comparison, expand the relevant subset or narrow the claim.

## Test ambiguities that could change a conclusion

Start population labels with ranked markers, expression or detection, and markers of plausible competing identities. Use the study question to decide how fine the labels need to be. For mixed signals, inspect available evidence for competing explanations such as doublets, ambient RNA, cell cycle, or a biological transition. Record the candidate definitions before interpreting their condition enrichment.

- **Uncertain population boundary.** Compare plausible groupings or representations. For the same cells, use capture-qualified barcodes and report overlapping counts and their fraction of each group. For different cells, compare marker programs and expression patterns in the relevant samples. If the question requires finer resolution within an established lineage, save the marker-supported parent membership and recompute features, reduction, and neighbors within it.
- **A program spans groups or varies continuously.** Inspect expression and detection of several genes across related populations or along the relevant axis. A module score can summarize a coherent program. Record how genes and cutoffs were chosen and mark groupings or thresholds derived from the results as exploratory.
- **A result depends on a sample or technical factor.** Inspect sample contributions and comparable strata. Assess whether a similar signal appears elsewhere, whether technical structure could explain the pattern, and whether the design can distinguish those possibilities. Where informative, compare an alternative representation, an adjusted model, or a result with the influential sample omitted. A rare state supported by one sample can remain a descriptive finding.

Stop iterating on a decision when further checks would leave the conclusion or next action unchanged. Use marker coherence, membership, and replicate support to justify the resolution of the claim.

## Examine condition evidence at the biological replicate level

- **Composition.** Include every biological replicate and zero counts. Give per-replicate counts and fractions with a denominator that matches the question, such as all recovered cells or the cells within a parent population. If reporting a pooled fraction, label the denominator and show the contributions from individual replicates.
- **Expression.** Use a replicate-aware contrast on raw counts for condition inference where the design supports it. Record the actual per-population donors tested, the cell-count floor and excluded donors, sample pairing or covariates, model rank, and residual replication. Where a subgroup lacks controls, check whether a contrast is estimable in the overlapping strata. If the question is whether an effect changes across another factor, inspect the within-stratum effects and test the interaction when the design supports it. When a covariate sensitivity also changes the eligible cohort, compare models on the same donors where feasible. A fine state can support a marker annotation or composition observation while its condition expression contrast is untestable. Parent-level differential expression can reflect a changing mixture of states.
- **Ranked hits.** Inspect prespecified features and the leading genome-wide hits in both directions. Check effect direction and magnitude, prevalence or donor contributions where available, adjusted significance, and the scope of the multiple-testing correction. Inspect donor-level expression for unexpected coherent programs and verify the genes in the relevant population. State which findings came from exploratory ranking.

## Check derived results against their inputs

- **Pathways.** Check the source contrast, ranking or tested-gene background as appropriate, species mapping, and the genes driving the result. If a change in state proportions could explain a program, inspect its expression by replicate and test a narrower population or an exclusion sensitivity when feasible. Interpret permutation resolution separately from biological replication.
- **Candidate signaling.** Verify database species and feature mapping. Compare matched sender, receiver, ligand, and receptor identities using comparable group definitions and model settings. Check cell counts and replicate contributions in each group. When coverage could drive a difference, test comparable sampling and inspect ligand and receptor expression by replicate. Before calling an edge condition-specific, check whether both contexts evaluated it, what filters were applied, and whether the available tables include the relevant rows. Report pooled scores as candidate signaling. A replicate-level condition claim needs replicate-level evidence.
- **Spatial evidence.** Check section and specimen counts, assay coverage, and whether the selected spots cover the claimed anatomy. Inspect the mask or overlay and the number of retained spots. If the boundary is uncertain, compare a plausible region definition. Keep spot, section, and biological replicate evidence at their respective levels.

## Verify the deliverables before closing

Return to the requested analyses. For each, open the expected result and verify its scope and coverage. If a result is empty, check that the analysis ran on eligible inputs and the output was fully written. Check downstream tables as well as receipts and summaries. Resolve recoverable failures and continue pending work within scope. For a blocked branch, name the specific missing evidence or approval and what can still be concluded. Reconcile the final report with the reviewed results so that preliminary conclusions and task statuses reflect the latest evidence.

In TraceOmics, when approved and available, use `inspect_run` and paged `preview_artifact` for tables and figures. A lineage branch can use `subset-cells` followed by `recluster-integrate`. Request an overlap table when assignments are unavailable to the delegation. Check the actual study's allowed inputs, tunable parameters and inspected outputs. A precise handoff can name the parent run, inclusion rule, candidate setting, and evidence the branch would resolve.
