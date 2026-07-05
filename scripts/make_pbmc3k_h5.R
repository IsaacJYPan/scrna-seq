#!/usr/bin/env Rscript
# ─────────────────────────────────────────────────────────────────────────────
# Convert the bundled PBMC3k Matrix Market tutorial data into a 10x Genomics v3
# feature-barcode-matrix HDF5 file, so it can be uploaded to the tenx_h5 Seurat
# pipeline (seurat.pipeline.v1), which accepts ONLY 10x .h5 input.
#
# The repo ships MTX (data/pbmc3k/filtered_gene_bc_matrices/hg19/), but the durable
# pipeline reads with Read10X_h5, so a one-time conversion gives users a valid
# tutorial input. This writes an h5 that Read10X_h5 can read back.
#
# Usage:
#   Rscript scripts/make_pbmc3k_h5.R [SRC_MTX_DIR] [OUT_H5]
# Defaults:
#   SRC_MTX_DIR = data/pbmc3k/filtered_gene_bc_matrices/hg19
#   OUT_H5      = data/pbmc3k/pbmc3k_filtered.h5
#
# Requires the R packages: Seurat, Matrix, hdf5r.
# ─────────────────────────────────────────────────────────────────────────────

args <- commandArgs(trailingOnly = TRUE)
src <- if (length(args) >= 1) args[[1]] else "data/pbmc3k/filtered_gene_bc_matrices/hg19"
out <- if (length(args) >= 2) args[[2]] else "data/pbmc3k/pbmc3k_filtered.h5"

for (pkg in c("Seurat", "Matrix", "hdf5r")) {
  if (!requireNamespace(pkg, quietly = TRUE)) {
    stop(sprintf("Required R package '%s' is not installed. Install it and re-run.", pkg))
  }
}
suppressMessages({ library(Seurat); library(Matrix); library(hdf5r) })

if (!dir.exists(src)) {
  stop(sprintf("Source MTX directory not found: %s\nRun scripts/download_sample_data.js first.", src))
}
genes_file <- file.path(src, "genes.tsv")
features_file <- file.path(src, "features.tsv")
feat_path <- if (file.exists(genes_file)) genes_file else features_file
if (!file.exists(feat_path)) stop(sprintf("No genes.tsv/features.tsv under %s", src))

cat(sprintf("Reading 10x MTX from %s ...\n", src))
mat <- Read10X(data.dir = src)          # genes x cells (dgCMatrix)
mat <- as(mat, "CsparseMatrix")
genes <- read.table(feat_path, sep = "\t", stringsAsFactors = FALSE)
if (nrow(genes) != nrow(mat)) {
  stop(sprintf("Feature count mismatch: matrix has %d rows, features file has %d.", nrow(mat), nrow(genes)))
}
cat(sprintf("Matrix: %d genes x %d cells\n", nrow(mat), ncol(mat)))

dir.create(dirname(out), recursive = TRUE, showWarnings = FALSE)
if (file.exists(out)) file.remove(out)

# Write the 10x v3 feature-barcode-matrix layout that Read10X_h5 expects.
h5 <- H5File$new(out, mode = "w")
tryCatch({
  g <- h5$create_group("matrix")
  g[["data"]]    <- as.integer(mat@x)
  g[["indices"]] <- as.integer(mat@i)
  g[["indptr"]]  <- as.integer(mat@p)
  g[["shape"]]   <- as.integer(c(nrow(mat), ncol(mat)))
  g[["barcodes"]] <- colnames(mat)
  f <- g$create_group("features")
  f[["id"]]            <- genes[[1]]
  f[["name"]]          <- if (ncol(genes) >= 2) genes[[2]] else genes[[1]]
  f[["feature_type"]]  <- rep("Gene Expression", nrow(genes))
  f[["genome"]]        <- rep("unknown", nrow(genes))
  f[["_all_tag_keys"]] <- c("genome")
}, finally = { h5$close_all() })

size <- file.info(out)$size
cat(sprintf("Wrote %s (%.1f MB)\n", out, size / 1e6))

# Verify the round-trip so the file is guaranteed uploadable.
back <- Read10X_h5(out)
if (is.list(back)) back <- back[[1]]
cat(sprintf("Read10X_h5 round-trip OK: %d genes x %d cells\n", nrow(back), ncol(back)))
cat("Done. Upload this .h5 in the Workspace 'Supported Seurat Pipeline' panel.\n")
