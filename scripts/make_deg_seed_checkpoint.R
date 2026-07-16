#!/usr/bin/env Rscript
# ─────────────────────────────────────────────────────────────────────────────
# Build a small, fast synthetic Seurat checkpoint bundle with two clearly separated
# cluster groups already assigned, saved in the exact `list(global=<Seurat>, raw=...)`
# shape that POST /object/checkpoint-load accepts (r-backend/plumber.R).
#
# This exists ONLY to seed scripts/verify_deg_worker_pipeline.js: that script proves
# real-R lease renewal through the deg.find_markers.v1 worker path, and needs a
# live-loadable checkpoint with a `seurat_clusters` metadata column (>= 2 groups) as
# its input. Building a tiny synthetic object here (instead of running the full
# seurat.pipeline.v1 pipeline, which is already covered by
# scripts/verify_seurat_pipeline.js) keeps that check's real-R budget focused on the
# DEG endpoint itself.
#
# Usage:
#   Rscript scripts/make_deg_seed_checkpoint.R OUT_RDS_PATH
#
# Requires the R package: Seurat.
# ─────────────────────────────────────────────────────────────────────────────

args <- commandArgs(trailingOnly = TRUE)
if (length(args) < 1) stop("Usage: Rscript scripts/make_deg_seed_checkpoint.R OUT_RDS_PATH")
out <- args[[1]]

if (!requireNamespace("Seurat", quietly = TRUE)) {
  stop("Required R package 'Seurat' is not installed. Install it and re-run.")
}
suppressMessages(library(Seurat))

set.seed(1)
n_genes <- 200
n_cells <- 80
m <- matrix(rpois(n_genes * n_cells, lambda = 2), nrow = n_genes, ncol = n_cells)
# First 20 genes strongly up in group B (cells 41..80) so DEG finds clear markers.
m[1:20, 41:80] <- m[1:20, 41:80] + 25L
rownames(m) <- paste0("Gene", seq_len(n_genes))
colnames(m) <- paste0("Cell", seq_len(n_cells))

obj <- CreateSeuratObject(counts = m, min.cells = 0, min.features = 0)
obj <- NormalizeData(obj, verbose = FALSE)
obj$seurat_clusters <- factor(c(rep("A", 40), rep("B", 40)))

dir.create(dirname(out), recursive = TRUE, showWarnings = FALSE)
saveRDS(list(global = obj, raw = obj), file = out)

if (!file.exists(out)) stop("Failed to write checkpoint bundle.")
cat(sprintf("Wrote synthetic clustered checkpoint bundle to %s\n", out))
