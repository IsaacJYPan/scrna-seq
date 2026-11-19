#!/usr/bin/env Rscript
# Split one 10x HDF5 count matrix into four donor files (two "ctrl", two "stim")
# with a known interferon-response signal added to the stim donors. The result
# exercises the multi-condition workflow end to end with a predictable answer:
# a stim-vs-ctrl pseudobulk comparison should report these genes as up in stim.
#
# Usage:
#   Rscript scripts/make_condition_fixture.R INPUT.h5 OUTPUT_DIR [SEED]
# INPUT.h5 can be data/pbmc3k/pbmc3k_filtered.h5 from scripts/make_pbmc3k_h5.R.
# This is synthetic test data: the condition effect is planted, not biological.

args <- commandArgs(trailingOnly = TRUE)
if (length(args) < 2) stop("Usage: Rscript scripts/make_condition_fixture.R INPUT.h5 OUTPUT_DIR [SEED]")
input <- args[[1]]
out_dir <- args[[2]]
seed <- if (length(args) >= 3) as.integer(args[[3]]) else 7L
suppressMessages({ library(Seurat); library(Matrix); library(hdf5r) })

counts <- Read10X_h5(input)
if (is.list(counts)) counts <- if ("Gene Expression" %in% names(counts)) counts[["Gene Expression"]] else counts[[1]]
counts <- as(counts, "CsparseMatrix")
signal_genes <- intersect(c("ISG15", "IFI6", "IFIT3", "MX1", "LY6E", "IFITM3"), rownames(counts))
if (length(signal_genes) < 3) stop("Input lacks the interferon-response genes used for the planted signal.")

write_10x_h5 <- function(mat, path) {
  if (file.exists(path)) file.remove(path)
  h5 <- H5File$new(path, mode = "w")
  on.exit(h5$close_all())
  g <- h5$create_group("matrix")
  g[["data"]] <- as.integer(mat@x)
  g[["indices"]] <- as.integer(mat@i)
  g[["indptr"]] <- as.integer(mat@p)
  g[["shape"]] <- as.integer(dim(mat))
  g[["barcodes"]] <- colnames(mat)
  f <- g$create_group("features")
  f[["id"]] <- rownames(mat)
  f[["name"]] <- rownames(mat)
  f[["feature_type"]] <- rep("Gene Expression", nrow(mat))
  f[["genome"]] <- rep("GRCh38", nrow(mat))
  f[["_all_tag_keys"]] <- "genome"
}

dir.create(out_dir, recursive = TRUE, showWarnings = FALSE)
set.seed(seed)
donor <- sample(rep(1:4, length.out = ncol(counts)))
for (d in 1:4) {
  sub <- counts[, donor == d, drop = FALSE]
  condition <- if (d <= 2) "ctrl" else "stim"
  if (condition == "stim") {
    rows <- match(signal_genes, rownames(sub))
    sub[rows, ] <- round(sub[rows, ] * 3 + 1)
    sub <- drop0(sub)
  }
  path <- file.path(out_dir, sprintf("donor%d_%s.h5", d, condition))
  write_10x_h5(as(sub, "CsparseMatrix"), path)
  back <- Read10X_h5(path)
  cat(sprintf("%s: %d genes x %d cells\n", basename(path), nrow(back), ncol(back)))
}
cat("Planted stim signal in:", paste(signal_genes, collapse = ", "), "\n")
