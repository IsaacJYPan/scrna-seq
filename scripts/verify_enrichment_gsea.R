#!/usr/bin/env Rscript
# Real-R smoke for the fixed ranked GO Biological Process enrichment operation.
# This is self-contained and performs no downloads or network calls. It skips on
# developer machines that do not have the production image's mandatory
# Bioconductor packages; a built production image must not skip its package audit.

required <- c(
  "Seurat", "dplyr", "Matrix", "ggplot2", "clusterProfiler", "fgsea",
  "AnnotationDbi", "org.Hs.eg.db", "org.Mm.eg.db", "GO.db"
)
missing <- required[!vapply(required, requireNamespace, logical(1), quietly = TRUE)]
if (length(missing) > 0L) {
  cat("SKIP: ranked enrichment smoke dependencies are not installed: ",
      paste(missing, collapse = ", "), "\n", sep = "")
  quit(status = 0L)
}

suppressPackageStartupMessages({
  library(Seurat)
  library(dplyr)
  library(Matrix)
  library(ggplot2)
})

workspace <- normalizePath(getwd(), winslash = "/", mustWork = TRUE)
plumber_file <- file.path(workspace, "r-backend", "plumber.R")
if (!file.exists(plumber_file)) stop("Run this script from the repository root.")
plumber_env <- new.env(parent = globalenv())
sys.source(plumber_file, envir = plumber_env)

failures <- 0L
check <- function(label, value) {
  if (isTRUE(value)) {
    cat("PASS ", label, "\n", sep = "")
  } else {
    cat("FAIL ", label, "\n", sep = "")
    failures <<- failures + 1L
  }
}

genes <- c(
  "ACTB", "GAPDH", "RPLP0", "RPS3", "RPS6", "RPL3", "RPL4", "RPL5",
  "RPS8", "RPS9", "CD3D", "CD3E", "CD247", "LCK", "TRAC", "TRBC1",
  "IL7R", "CCR7", "LTB", "MALAT1", "NKG7", "GNLY", "GZMB", "PRF1",
  "TYROBP", "LST1", "FCER1G", "CTSS", "LYZ", "S100A8", "S100A9", "CTSD",
  "MS4A1", "CD79A", "CD79B", "CD74", "HLA-DRA", "HLA-DPA1", "HLA-DPB1",
  "HLA-DQA1", "HLA-DQB1", "CD14", "FCGR3A", "LGALS3", "SAT1", "IFITM1",
  "IFITM2", "IFITM3", "ISG15", "IFI6", "IFIT1", "IFIT2", "IFIT3", "MX1",
  "OAS1", "OAS2", "STAT1", "IRF7", "JUN", "FOS", "DUSP1", "IER2", "KLF6",
  "B2M", "HLA-A", "HLA-B", "HLA-C", "PSMB8", "PSMB9", "TAP1", "TAP2",
  "CD4", "CD8A", "CD8B", "CXCR4", "CXCR3", "CCL5", "IL32", "TRAT1"
)
set.seed(11)
n_cells <- 60L
counts <- matrix(
  stats::rpois(length(genes) * n_cells, lambda = 2),
  nrow = length(genes), ncol = n_cells,
  dimnames = list(genes, paste0("cell_", seq_len(n_cells)))
)
counts[11:30, 31:60] <- counts[11:30, 31:60] + 18L
obj <- CreateSeuratObject(counts = counts, min.cells = 0, min.features = 0)
obj <- NormalizeData(obj, verbose = FALSE)
obj$seurat_clusters <- factor(c(rep("reference", 30), rep("target", 30)))

assay_before <- DefaultAssay(obj)
idents_before <- as.character(Idents(obj))
metadata_before <- obj@meta.data
rng_before <- get(".Random.seed", envir = .GlobalEnv, inherits = FALSE)
params <- plumber_env$normalize_enrichment_gsea_params(list(
  groupBy = "seurat_clusters",
  assay = "RNA",
  targetGroup = "target",
  species = "human",
  geneSetCollection = "GO_BP",
  minGeneSetSize = 10L,
  maxGeneSetSize = 500L,
  adjustedPValueCutoff = 0.05,
  topPathways = 5L,
  maxCellsPerIdent = 10000L,
  randomSeed = 11L
))
result <- plumber_env$run_enrichment_gsea_analysis(obj, params)

expected_columns <- c(
  "pathway_id", "pathway_name", "normalized_enrichment_score", "p_value",
  "adjusted_p_value", "set_size", "core_gene_entrez_ids", "core_gene_symbols"
)
check("the real helper returns the durable CSV schema",
      identical(colnames(result$table), expected_columns))
check("the helper keeps every eligible tested gene rather than only significant hits",
      identical(result$summary$input_gene_count, as.integer(length(genes))) &&
        result$summary$mapped_gene_count >= 50L)
check("the real GO Biological Process analysis tests and returns pathways",
      result$summary$tested_pathway_count > 0L && nrow(result$table) > 0L)
check("the receipt preview stays within the five-row request bound",
      length(result$summary$top_pathways) <= 5L)
check("the result records the complete scientific software stack",
      identical(names(result$summary$package_versions),
                c("r", "seurat", "annotation_dbi", "go_db", "cluster_profiler",
                  "fgsea", "organism_db")))
check("the input object's default assay is unchanged", identical(DefaultAssay(obj), assay_before))
check("the input object's identities are unchanged",
      identical(as.character(Idents(obj)), idents_before))
check("the input object's metadata is unchanged", identical(obj@meta.data, metadata_before))
check("the shared R random-number state is unchanged",
      identical(get(".Random.seed", envir = .GlobalEnv, inherits = FALSE), rng_before))

if (failures > 0L) {
  stop(sprintf("Ranked enrichment real-R smoke failed: %d check(s).", failures))
}
cat("RANKED ENRICHMENT REAL-R SMOKE PASSED\n")
