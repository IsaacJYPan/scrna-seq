# Approved agent workflows and inspection

Agent execution still accepts parameter choices, never submitted R code. A person approves a release and creates a bounded study. Follow-on studies consume a person's accepted, immutable source result. Acceptance is not delegated to the analyst.

## Operator runtime pin

Set `TRACEOMICS_WORKFLOW_RUNTIME_FILE` in the web and worker processes to an operator-owned JSON file. Its profile has schema `traceomics.workflow-runtime.v1`, an immutable `imageDigest` (`sha256:…`), exact `rVersion`, and the complete installed package inventory (`packages: [{name, version}, …]`). It may instead contain `targets.local` and `targets.slurm` profiles. Missing runtime pins prevent agent planning. Read the authenticated R service's `/runtime/workflow-trust` report, verify its image against the deployed container, then approve that profile; do not treat an unverified remote response as independent proof of image identity.

Supply `TRACEOMICS_RUNTIME_IMAGE_DIGEST` from the deployed immutable image identity. Slurm can alternatively read an operator-owned `/run/traceomics/image-digest`. These are attestations within a trusted operator/runtime boundary, not hardware attestation against a compromised server.

The release digest includes production Node/R/CLI source inventories, package lockfiles, Dockerfiles, operation schema and resources, and runtime inventories. Tests and underscore-prefixed test helpers are excluded. Source edits require a process restart and a new approval. Workers recheck source and runtime immediately before executing agent jobs. The local R service reports its startup source inventory and refuses attestation after edits. Service checks cover shipped root scripts and all library modules; build-only and HPC scripts remain release-pinned. Slurm additionally checks staged runner/core bytes and R/package pins. Condition DE plans pin a sponsor-defined contrast and sample snapshot; changed designs are refused before dispatch.

This invalidates earlier release approvals deliberately. Operator runtime pins must be regenerated and reviewed after image/package changes. Legacy human jobs retain their existing execution contract.

## Stepwise analysis

`seurat-qc-cluster` accepts `stopAfter`: `qc`, `normalize`, `pca`, `cluster`, or `umap` (default). Each run saves a separate checkpoint. Prefix runs recompute deterministically from the pinned input; they do not resume computation from the preceding checkpoint. An agent can inspect QC before deciding filtering and inspect PCA before further runs. Clustering-dependent follow-ons reject incomplete source checkpoints.

QC inspection includes before/after quantiles, counts, finite/nonnegative/integer count checks, cluster sizes and PC variance fractions **among stored PCs**. Doublets, ambient RNA and batch effects are explicitly reported as unassessed; these diagnostics do not certify a clean dataset. Default filtering thresholds must be checked against observed distributions.

## Scientific inspection permission

`results.inspect` is a separate delegation capability and also requires `labels` disclosure. Existing `results.read` remains the scalar result view. MCP `inspect_run` exposes bounded scientific summaries of the delegation's completed, non-quarantined runs. `preview_artifact` returns checksum-verified table pages (maximum 100 rows, bounded offsets) or standard figure media. It never accepts a storage path, executable text, arbitrary file selection, or another delegation's run.

The standard figure bundle provides native MCP PNG image content and SVG/PDF embedded resources, with job/input/parameter provenance. Response sizes remain bounded. SVG/PDF are exports for review; analyst clients must explicitly save the returned resource bytes.

## Downstream releases

- `seurat-markers`: cluster-versus-rest marker genes, not replicated condition effects.
- `pathway-gsea`: ranked GO enrichment for one group, with mapping statistics and warnings. Group, species, gene-set collection and cutoff are design choices a person fixes.
- `cellchat-single-context`: bounded single-context candidate ligand–receptor inference. It does not establish physical interaction, causality or condition differences. Grouping, species, database and cell limits are design choices.
- `condition-pseudobulk`: replicate-aware condition DE on a sponsor-registered contrast on the accepted object. The contrast is a design choice, pinned by digest when a plan is created. It requires biological replication and usable cell/sample metadata; the count-only import workflow does not create these labels.
- `standard-figures`: fixed QC violin, PCA elbow, UMAP, variable-gene heatmap/dot/feature panels; 300 dpi PNG plus SVG/PDF. Feature panels currently use predetermined top variable features, not arbitrary agent-selected genes.

The original six recipes are standard scientific views, not a complete publication layout system. The workbench below adds targeted expression, DE volcano, enrichment and candidate-signaling panels. MA plots, full communication-network layouts, panel assembly and journal-specific typography remain gaps. GWAS is not part of the exposed workflow catalog.

## Multi-condition study workbench

The `seurat-multisample` release exposes the existing multi-sample handler with up to 48 registered donor datasets. The sponsor fixes the sample/condition/donor/chemistry mapping. Plans pin every input checksum and recheck secondary inputs at submission and worker dispatch. Multi-sample normalized checkpoints join RNA layers for downstream count aggregation. Scaling uses variable genes rather than allocating a dense all-gene matrix. Optional RPCA corrects the graph/UMAP representation; RNA counts remain unchanged for donor-level DE. This does not establish that batch and biology are identifiable when chemistry is confounded with disease.

`study-workbench` adds reviewed QC, donor composition, targeted expression, independent-donor pseudobulk volcano, condition-ranked GO, and condition-specific CellChat figures. It produces PNG/SVG/PDF bundles with named bounded evidence tables, accessible through MCP `preview_artifact(table=...)`. The DE and pathway recipes (`study_de`, `study_pathways`) take a `contrastId`: they test a sponsor-registered contrast with the same pinned sample snapshot as `condition-pseudobulk`, never a design rebuilt from cell metadata. Their results are recorded as `study_inference_summary` artifacts, separate from descriptive `exploration_summary` views. DE uses the shared edgeR QL implementation on raw counts, at least 20 cells per unit/population and two units per arm. GO ranks by signed square root of edgeR QLF, maps symbols to Entrez with the annotation database of the study's fixed `species` (human or mouse), and performs GO_BP GSEA. Pathway and communication recipes require `species`; a pathway run is refused when fewer than 60% of symbols map, and the mapping rate is reported. FDR is within each population/contrast, not across an entire study.

What a workbench study asks is fixed by a person: the contrast, the condition, the cluster-to-population map and the target population are design parameters and cannot be varied. An agent that needs a different grouping runs `label-clusters`, and a person accepts that result before DE runs on it. The only free-text variation is the display gene panel: a sponsor can allow `['','*']` for `featureNames` (up to twelve genes). The asterisk authorizes a bounded gene list, never executable expressions, arbitrary fields, files or function names. Other parameters still require exact enumerated values. All choices remain in immutable plans.

Investigation tables retain at most 3,000 rows each. DE hits retain top 30 per population plus requested genes; GO and communication retain top 100 rows. They are explicitly incomplete scientific exports. Existing `condition-pseudobulk` jobs still retain a full private DEG CSV. Workbench CellChat pools donors within one condition, caps groups at 300 cells and total cells at 2,000, and returns explicit native-group mapping. Cross-condition score comparisons are descriptive rather than donor-replicated differential communication tests. Full communication-network layouts, MA panels, manuscript assembly, TCR, SCENIC and GWAS remain outside this release.

Known trust/runtime/design failures now appear as allowlisted bounded diagnostics on failed MCP run receipts. Raw exception messages, paths and credentials remain withheld.

Large UMAP/feature panels rasterize the point layer without sampling cells; axes and labels remain vector elements in SVG/PDF. Rendering provenance identifies this hybrid output. The atlas-sized synthetic export check covers 88,304 cells.

Private job-only hydration discards the unused pre-QC undo companion. Trusted expression-only job types additionally discard the unused PCA scaling workspace, retaining every count, normalized value, feature and embedding. This profile is derived by the worker from its job type/recipe, never from an agent argument. Standard heatmaps retain scaling; canonical interactive checkpoint loads retain their full undo state. Synthetic full-cell marker comparisons agree to 1e-12 after trimming. These optimizations do not guarantee arbitrary dataset sizes will fit a given machine.

MCP marker/condition-DE CSV previews accept a bounded `group` label. The server selects the fixed `cluster` or `cell_type` column; callers cannot supply a column or predicate. Page offsets count matching group rows, making late groups accessible without increasing the 100-row response or 64 MiB source budget. Generic summary arrays remain bounded; use these table pages rather than assuming a truncated summary covers every cluster.

Atlas-sized hydration and marker requests use a finite 600-second RPC deadline. Lost-response receipt recovery remains separate from execution and never blindly resubmits R. The disposable test helper forwards the authenticated singleton barrier/runtime hash used by production workerRuntime; omitting that evidence in an earlier fixture caused indefinite recovery windows and extra manual cleanup.

Figure export/private-job cleanup clears ggplot's global last-plot store, which otherwise can retain a plotting function's entire private Seurat environment. Large hydration performs a full GC first. A synthetic finalizer check verifies that captured private plotting environments are collectible after export. This is transient lifecycle cleanup, not a scientific data transformation.

A successful constrained study demonstrates these workflows on those inputs. It does not prove arbitrary studies need no code changes or that all biological assumptions have been checked. Record dataset selection, unsupported steps, runtime identity, analyst decisions and withheld reference criteria when using a blinded trial to evaluate the app.
