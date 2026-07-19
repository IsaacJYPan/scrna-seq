#!/usr/bin/env Rscript

# Build the small, deterministic checkpoint used only by the real durable
# CellChat worker smoke. The object deliberately uses unsafe-looking source
# labels so the Node harness can prove that the worker's summary and private
# table retain only opaque CellChat group labels.
#
# Usage:
#   Rscript scripts/make_cellchat_seed_checkpoint.R OUT_RDS_PATH

args <- commandArgs(trailingOnly = TRUE)
if (length(args) != 1L) {
  stop("Usage: Rscript scripts/make_cellchat_seed_checkpoint.R OUT_RDS_PATH")
}
out <- args[[1L]]

required <- c("Seurat", "CellChat")
missing <- required[!vapply(required, requireNamespace, logical(1), quietly = TRUE)]
if (length(missing) > 0L) {
  stop("Required R package(s) missing: ", paste(missing, collapse = ", "))
}

suppressPackageStartupMessages(library(Seurat))

set.seed(17)
genes <- unique(c(CellChat::extractGene(CellChat::CellChatDB.human), "ACTB", "GAPDH"))
n_per_group <- 500L
n_low_group <- 5L
n_cells <- (2L * n_per_group) + n_low_group
counts <- matrix(
  stats::rpois(length(genes) * n_cells, lambda = 1),
  nrow = length(genes),
  ncol = n_cells,
  dimnames = list(genes, paste0("cell_", seq_len(n_cells)))
)

# Seed a strong, known human secreted-signaling pair in opposing groups. This
# produces a compact but nonempty CellChat candidate table under the fixed
# secreted-signaling settings used by the durable job.
ligands <- match(c("TGFB1", "TGFB2", "TGFB3"), genes)
receptors <- match(c("TGFBR1", "TGFBR2", "ACVR1B"), genes)
counts[ligands, seq_len(n_per_group)] <- counts[ligands, seq_len(n_per_group)] + 10L
counts[receptors, n_per_group + seq_len(n_per_group)] <-
  counts[receptors, n_per_group + seq_len(n_per_group)] + 10L

obj <- Seurat::CreateSeuratObject(counts = counts, min.cells = 0, min.features = 0)
obj <- Seurat::NormalizeData(obj, verbose = FALSE)
obj$seurat_clusters <- factor(c(
  rep("unsafe/group-A", n_per_group),
  rep("unsafe/group-B", n_per_group),
  rep("unsafe/group-C", n_low_group)
))

dir.create(dirname(out), recursive = TRUE, showWarnings = FALSE)
saveRDS(list(global = obj, raw = obj), file = out)
if (!file.exists(out)) stop("Failed to write CellChat worker seed checkpoint.")

cat(sprintf("Wrote CellChat worker seed checkpoint to %s\n", out))
