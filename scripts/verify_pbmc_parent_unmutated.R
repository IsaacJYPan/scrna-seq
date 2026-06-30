#!/usr/bin/env Rscript
# ──────────────────────────────────────────────────────────────────────────────
# PBMC pipeline parent-immutability smoke test (object-level, real Seurat).
#
# The `pbmc.pipeline.v1` worker job runs the existing PBMC/Seurat preprocessing on a
# COPY of the input object so the PARENT is never mutated and stays a stable checkpoint
# (r-backend/plumber.R POST /object/pbmc-pipeline binds `obj <- global_obj` and only ever
# reassigns `obj`, never `global_obj`). The Node tests assert this at the DB-row level
# (mocked R); this script proves it at the OBJECT level against a live Seurat install by
# reproducing the endpoint's exact copy-on-modify call sequence and verifying that the
# original `global_obj` is unchanged while the derived copy gained the new state.
#
# It is intentionally self-contained (a small synthetic object — no downloads, no live
# server) so it runs fast and reliably wherever Rscript + Seurat are available. Exits 0
# on success, non-zero on any failure (so CI / an npm script can gate on it).
# ──────────────────────────────────────────────────────────────────────────────

suppressWarnings(suppressMessages({
  ok <- requireNamespace("Seurat", quietly = TRUE)
}))
if (!ok) {
  cat("SKIP: Seurat is not installed; cannot run the parent-immutability smoke test.\n")
  quit(status = 0)  # absence of Seurat is not a failure of this branch's logic
}
suppressWarnings(suppressMessages(library(Seurat)))

fails <- 0
check <- function(label, cond) {
  if (isTRUE(cond)) {
    cat(sprintf("PASS %s\n", label))
  } else {
    cat(sprintf("FAIL %s\n", label))
    fails <<- fails + 1
  }
}

set.seed(1)
n_genes <- 300
n_cells <- 80
m <- matrix(rpois(n_genes * n_cells, lambda = 3), nrow = n_genes, ncol = n_cells)
rownames(m) <- paste0("Gene", seq_len(n_genes))
colnames(m) <- paste0("Cell", seq_len(n_cells))

# The "live parent" the worker would load from the session via X-Object-ID.
global_obj <- CreateSeuratObject(counts = m, min.cells = 0, min.features = 0)

# Snapshot the parent's observable state BEFORE the pipeline runs.
parent_layers_before     <- tryCatch(sort(Layers(global_obj[["RNA"]])), error = function(e) NA_character_)
parent_varfeatures_before <- length(VariableFeatures(global_obj))
parent_reductions_before  <- sort(names(global_obj@reductions))
parent_ncol_before        <- ncol(global_obj)
parent_nrow_before        <- nrow(global_obj)

# ── Reproduce the endpoint's copy-on-modify path EXACTLY (mutate only `obj`) ──
used_seed <- 42L
obj <- global_obj
set.seed(used_seed)
obj <- NormalizeData(obj, normalization.method = "LogNormalize", scale.factor = 10000, verbose = FALSE)
obj <- FindVariableFeatures(obj, selection.method = "vst", nfeatures = 100, verbose = FALSE)
obj <- ScaleData(obj, features = rownames(obj), verbose = FALSE)
npcs <- min(20L, ncol(obj) - 1L, nrow(obj) - 1L)
obj <- RunPCA(obj, features = VariableFeatures(object = obj), npcs = npcs, seed.use = used_seed, verbose = FALSE)
cdims <- min(10L, ncol(Embeddings(obj, "pca")))
obj <- FindNeighbors(obj, reduction = "pca", dims = 1:cdims, verbose = FALSE)
obj <- FindClusters(obj, resolution = 0.8, random.seed = used_seed, verbose = FALSE)
un <- min(15L, ncol(obj) - 1L)
obj <- RunUMAP(obj, reduction = "pca", dims = 1:cdims, n.components = 2L,
               n.neighbors = un, min.dist = 0.3, seed.use = used_seed, verbose = FALSE)

# Mirror the endpoint's durable checkpoint save (to a temp file, not the vault — path
# confinement is covered separately by validate_path). The save must NOT mutate the parent.
ckpt <- tempfile(fileext = ".rds")
raw_for_bundle <- global_obj
saveRDS(list(global = obj, raw = raw_for_bundle), file = ckpt)
ckpt_ok <- file.exists(ckpt) && file.info(ckpt)$size > 0

# Snapshot the parent's observable state AFTER the pipeline + save.
parent_layers_after     <- tryCatch(sort(Layers(global_obj[["RNA"]])), error = function(e) NA_character_)
parent_varfeatures_after <- length(VariableFeatures(global_obj))
parent_reductions_after  <- sort(names(global_obj@reductions))
parent_ncol_after        <- ncol(global_obj)
parent_nrow_after        <- nrow(global_obj)

# ── Assertions: the PARENT is unchanged at the object level ──
check("parent layers unchanged (no data/scale.data added to global_obj)",
      identical(parent_layers_before, parent_layers_after))
check("parent has no variable features before or after",
      parent_varfeatures_before == 0 && parent_varfeatures_after == 0)
check("parent gained NO reductions (no pca/umap on global_obj)",
      identical(parent_reductions_before, parent_reductions_after) && length(parent_reductions_after) == 0)
check("parent dimensions unchanged",
      parent_ncol_before == parent_ncol_after && parent_nrow_before == parent_nrow_after)

# ── Assertions: the COPY actually received the new derived state ──
check("derived copy gained variable features", length(VariableFeatures(obj)) > 0)
check("derived copy gained pca + umap reductions",
      all(c("pca", "umap") %in% names(obj@reductions)))
check("derived copy is a DISTINCT object from the parent (clusters present on copy only)",
      ("seurat_clusters" %in% colnames(obj[[]])) && !("seurat_clusters" %in% colnames(global_obj[[]])))
check("durable checkpoint bundle written (saved + non-empty)", isTRUE(ckpt_ok))

if (file.exists(ckpt)) unlink(ckpt)

if (fails > 0) {
  cat(sprintf("\nPARENT-IMMUTABILITY SMOKE TEST FAILED: %d check(s) failed.\n", fails))
  quit(status = 1)
}
cat("\nPARENT-IMMUTABILITY SMOKE TEST PASSED: the PBMC pipeline ran on a copy; the parent object is unchanged.\n")
quit(status = 0)
