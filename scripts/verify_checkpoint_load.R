#!/usr/bin/env Rscript
# ──────────────────────────────────────────────────────────────────────────────
# Checkpoint load / reattach R-side smoke test (real Seurat).
#
# The `checkpoint.load.v1` worker job loads a durable internal checkpoint RDS back into
# the OWNER's live R session under the canonical object key (r-backend/plumber.R
# POST /object/checkpoint-load). The Node tests assert the contract with a mocked R; this
# script proves the R-SIDE load behavior against a live Seurat install by reproducing the
# endpoint's exact verify-and-restore sequence:
#   - verify the file sha256 BEFORE readRDS (RDS load can run arbitrary code), and detect
#     a tampered/mismatched checksum
#   - validate the bundle shape (Seurat object, or list(global=<Seurat>, raw=...)) and
#     reject an unrecognized bundle
#   - restore the Seurat object (and its raw companion) into the TARGET session only
#   - mutate ONLY the target object key — a different session key is left untouched
#
# Self-contained (a small synthetic object, no downloads, no live server) so it runs fast
# wherever Rscript + Seurat are available. Exits 0 on success, non-zero on any failure.
# ──────────────────────────────────────────────────────────────────────────────

suppressWarnings(suppressMessages({
  ok <- requireNamespace("Seurat", quietly = TRUE)
}))
if (!ok) {
  cat("SKIP: Seurat is not installed; cannot run the checkpoint-load smoke test.\n")
  quit(status = 0)  # absence of Seurat is not a failure of this branch's logic
}
suppressWarnings(suppressMessages(library(Seurat)))
have_digest <- requireNamespace("digest", quietly = TRUE)

fails <- 0
check <- function(label, cond) {
  if (isTRUE(cond)) {
    cat(sprintf("PASS %s\n", label))
  } else {
    cat(sprintf("FAIL %s\n", label))
    fails <<- fails + 1
  }
}

sha256_file <- function(path) {
  if (have_digest) return(digest::digest(file = path, algo = "sha256"))
  if (requireNamespace("openssl", quietly = TRUE)) return(as.character(openssl::sha256(file(path))))
  NA_character_
}

# ── The exact verify-and-restore steps the R endpoint performs ──
# `target` is an environment standing in for one X-Object-ID session's globals; only it
# is mutated. Returns the loaded object's class on success; stop()s on any failure.
load_checkpoint_into <- function(path, target, expected_checksum = NULL) {
  if (!grepl("\\.rds$", path, ignore.case = TRUE)) stop("Only RDS checkpoints can be loaded.")
  if (!file.exists(path)) stop("Checkpoint file not found.")
  if (!is.null(expected_checksum) && nchar(expected_checksum) > 0) {
    actual <- sha256_file(path)
    if (is.na(actual)) stop("Unable to verify checkpoint checksum.")
    if (!identical(tolower(actual), tolower(expected_checksum))) stop("Checkpoint checksum mismatch.")
  }
  bundle <- readRDS(path)
  if (inherits(bundle, "Seurat")) {
    loaded_obj <- bundle; raw_loaded <- bundle
  } else if (is.list(bundle) && "global" %in% names(bundle)) {
    loaded_obj <- bundle$global
    raw_loaded <- if ("raw" %in% names(bundle)) bundle$raw else bundle$global
  } else {
    stop("Checkpoint bundle format not recognized.")
  }
  if (!inherits(loaded_obj, "Seurat")) stop("Checkpoint does not contain a Seurat object.")
  target$global_obj <- loaded_obj
  target$raw_obj <- raw_loaded
  class(loaded_obj)[1]
}

set.seed(1)
n_genes <- 200; n_cells <- 60
m <- matrix(rpois(n_genes * n_cells, lambda = 3), nrow = n_genes, ncol = n_cells)
rownames(m) <- paste0("Gene", seq_len(n_genes))
colnames(m) <- paste0("Cell", seq_len(n_cells))

# Build a processed object (what pbmc.pipeline.v1 would checkpoint), then write the bundle.
obj <- CreateSeuratObject(counts = m, min.cells = 0, min.features = 0)
obj <- NormalizeData(obj, verbose = FALSE)
obj <- FindVariableFeatures(obj, selection.method = "vst", nfeatures = 80, verbose = FALSE)
obj <- ScaleData(obj, features = rownames(obj), verbose = FALSE)
npcs <- min(15L, ncol(obj) - 1L, nrow(obj) - 1L)
obj <- RunPCA(obj, features = VariableFeatures(object = obj), npcs = npcs, seed.use = 42L, verbose = FALSE)

ckpt <- tempfile(fileext = ".rds")
saveRDS(list(global = obj, raw = obj), file = ckpt)
checksum <- sha256_file(ckpt)
check("checkpoint bundle written + checksum computed", file.exists(ckpt) && !is.na(checksum))

# Two independent "sessions" (object keys). We load into B; A must stay untouched.
sessionA <- new.env(); sessionA$global_obj <- NULL; sessionA$raw_obj <- NULL
sessionB <- new.env(); sessionB$global_obj <- NULL; sessionB$raw_obj <- NULL

# ── Positive: load with a correct checksum restores the Seurat object into the target ──
loaded_class <- tryCatch(load_checkpoint_into(ckpt, sessionB, checksum), error = function(e) paste("ERR:", conditionMessage(e)))
check("checkpoint loads with a valid checksum (returns a Seurat object)", identical(loaded_class, "Seurat"))
check("target session now holds the restored Seurat object", inherits(sessionB$global_obj, "Seurat"))
check("restored object retains pca + variable features", "pca" %in% names(sessionB$global_obj@reductions) && length(VariableFeatures(sessionB$global_obj)) > 0)
check("restored object dimensions match the checkpoint", ncol(sessionB$global_obj) == ncol(obj) && nrow(sessionB$global_obj) == nrow(obj))
check("raw companion restored", inherits(sessionB$raw_obj, "Seurat"))

# ── Single-key mutation: the OTHER session was never touched by the load ──
check("a different session key is left UNTOUCHED by the load", is.null(sessionA$global_obj) && is.null(sessionA$raw_obj))

# ── Negative: a mismatched checksum is detected BEFORE the object is restored ──
bad <- tryCatch({ load_checkpoint_into(ckpt, sessionA, paste(rep("0", 64), collapse = "")); "NO_ERROR" },
                error = function(e) conditionMessage(e))
check("a checksum mismatch is rejected", grepl("checksum mismatch", bad, ignore.case = TRUE))
check("the rejected load did NOT mutate the target session", is.null(sessionA$global_obj))

# ── Negative: an unrecognized bundle shape is rejected ──
badfile <- tempfile(fileext = ".rds")
saveRDS(list(notglobal = 1), file = badfile)
shape <- tryCatch({ load_checkpoint_into(badfile, sessionA, NULL); "NO_ERROR" },
                  error = function(e) conditionMessage(e))
check("an unrecognized bundle shape is rejected", grepl("not recognized", shape, ignore.case = TRUE))

# ── Negative: a non-Seurat 'global' is rejected ──
badseurat <- tempfile(fileext = ".rds")
saveRDS(list(global = data.frame(x = 1:3)), file = badseurat)
nonseurat <- tryCatch({ load_checkpoint_into(badseurat, sessionA, NULL); "NO_ERROR" },
                      error = function(e) conditionMessage(e))
check("a non-Seurat checkpoint is rejected", grepl("does not contain a Seurat object", nonseurat, ignore.case = TRUE))

for (f in c(ckpt, badfile, badseurat)) if (file.exists(f)) unlink(f)

if (fails > 0) {
  cat(sprintf("\nCHECKPOINT-LOAD SMOKE TEST FAILED: %d check(s) failed.\n", fails))
  quit(status = 1)
}
cat("\nCHECKPOINT-LOAD SMOKE TEST PASSED: checksum-verified RDS reattach restores the object into the target session only.\n")
quit(status = 0)
