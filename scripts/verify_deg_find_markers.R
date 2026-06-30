#!/usr/bin/env Rscript
# ──────────────────────────────────────────────────────────────────────────────
# DEG / marker-finding R-side smoke test (real Seurat).
#
# The `deg.find_markers.v1` worker job runs the existing FindAllMarkers path over the
# owner's live object and writes a full marker table to a server-allocated internal key
# (r-backend/plumber.R POST /object/deg-find-markers). The Node tests assert the contract
# with a mocked R; this script proves the R-SIDE behavior against a live Seurat install by
# reproducing the endpoint's exact run-and-summarize sequence on a small synthetic object
# with clear groups:
#   - markers are produced (FindAllMarkers over >= 2 identity groups)
#   - the full table is written to a file + a sha256 checksum/size is computed
#   - the bounded top-N-per-group summary is produced with safe columns only
#   - the live object is NOT mutated (we run on a COPY; original idents/metadata unchanged)
#   - a missing/insufficient group field fails safely (no markers, no file)
#
# Self-contained (a small synthetic object, no downloads, no live server) so it runs fast
# wherever Rscript + Seurat are available. Exits 0 on success, non-zero on any failure.
# ──────────────────────────────────────────────────────────────────────────────

suppressWarnings(suppressMessages({
  ok <- requireNamespace("Seurat", quietly = TRUE) && requireNamespace("dplyr", quietly = TRUE)
}))
if (!ok) {
  cat("SKIP: Seurat/dplyr not installed; cannot run the DEG find-markers smoke test.\n")
  quit(status = 0)  # absence of Seurat is not a failure of this branch's logic
}
suppressWarnings(suppressMessages({ library(Seurat); library(dplyr) }))
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

# ── The exact run-and-summarize steps the R endpoint performs (on a COPY) ──
# Returns list(summary=..., n_markers=..., out_path=...); stop()s on any failure. `obj_in`
# is never mutated — DEG runs on a local copy, mirroring the endpoint's non-mutation.
run_deg <- function(obj_in, out_path, group_by = "seurat_clusters", top_n_val = 10L) {
  obj <- obj_in  # COPY-on-read: the input object is never mutated
  if (group_by == "seurat_clusters") {
    if (!"seurat_clusters" %in% colnames(obj@meta.data)) stop("Group field 'seurat_clusters' not found.")
    Idents(obj) <- obj$seurat_clusters
  }
  if (length(levels(factor(Idents(obj)))) < 2) stop("DEG needs at least two identity groups.")

  markers <- FindAllMarkers(obj, only.pos = TRUE, min.pct = 0.1, logfc.threshold = 0.25,
                            test.use = "wilcox", verbose = FALSE)
  if (is.null(markers) || nrow(markers) == 0) stop("No marker genes found.")
  markers <- as.data.frame(markers)
  if (!"gene" %in% colnames(markers)) markers$gene <- rownames(markers)

  write.csv(markers, file = out_path, row.names = FALSE)

  group_labels <- as.character(sort(unique(markers$cluster)))
  top_tbl <- markers %>% group_by(cluster) %>%
    arrange(desc(avg_log2FC), .by_group = TRUE) %>%
    slice_head(n = top_n_val) %>% mutate(rank = row_number()) %>% ungroup()
  top_markers <- lapply(seq_len(nrow(top_tbl)), function(i) {
    list(group = as.character(top_tbl$cluster[i]), gene = as.character(top_tbl$gene[i]),
         avg_log2FC = round(as.numeric(top_tbl$avg_log2FC[i]), 4), rank = as.integer(top_tbl$rank[i]))
  })
  list(
    summary = list(n_groups = length(group_labels), groups = group_labels,
                   n_markers_total = nrow(markers), top_markers = top_markers),
    n_markers = nrow(markers), out_path = out_path
  )
}

# ── Build a small synthetic object with TWO clearly separated groups ──
set.seed(1)
n_genes <- 200; n_cells <- 80
m <- matrix(rpois(n_genes * n_cells, lambda = 2), nrow = n_genes, ncol = n_cells)
# Make the first 20 genes strongly up in group B (cells 41..80) so DEG finds clear markers.
m[1:20, 41:80] <- m[1:20, 41:80] + 25L
rownames(m) <- paste0("Gene", seq_len(n_genes))
colnames(m) <- paste0("Cell", seq_len(n_cells))

obj <- CreateSeuratObject(counts = m, min.cells = 0, min.features = 0)
obj <- NormalizeData(obj, verbose = FALSE)
obj$seurat_clusters <- factor(c(rep("A", 40), rep("B", 40)))
# Snapshot the live object's idents/metadata BEFORE DEG to prove non-mutation afterward.
idents_before <- as.character(Idents(obj))
meta_cols_before <- colnames(obj@meta.data)

out_csv <- tempfile(fileext = ".csv")
res <- tryCatch(run_deg(obj, out_csv, "seurat_clusters", 10L),
                error = function(e) paste("ERR:", conditionMessage(e)))

check("DEG produced markers over two groups", is.list(res) && res$n_markers > 0)
check("the full marker table was written to a file", file.exists(out_csv) && file.info(out_csv)$size > 0)
checksum <- sha256_file(out_csv)
check("a sha256 checksum was computed for the table", !is.na(checksum) && nchar(checksum) == 64)

if (is.list(res)) {
  check("the summary detects exactly two groups (A, B)", res$summary$n_groups == 2)
  check("the top-marker preview is bounded (<= 10 per group)", length(res$summary$top_markers) <= 20)
  top_genes <- vapply(res$summary$top_markers, function(r) r$gene, character(1))
  check("the planted up-genes (Gene1..Gene20) appear among B's top markers",
        any(top_genes %in% paste0("Gene", 1:20)))
}

# ── Non-mutation: the original live object's idents + metadata are unchanged after DEG ──
check("the input object's identities are UNCHANGED after DEG",
      identical(as.character(Idents(obj)), idents_before))
check("the input object's metadata columns are UNCHANGED after DEG",
      identical(colnames(obj@meta.data), meta_cols_before))

# ── Negative: a missing group field fails safely (no markers, no completion) ──
obj_nogroup <- CreateSeuratObject(counts = m, min.cells = 0, min.features = 0)
obj_nogroup <- NormalizeData(obj_nogroup, verbose = FALSE)
miss <- tryCatch({ run_deg(obj_nogroup, tempfile(fileext = ".csv"), "seurat_clusters"); "NO_ERROR" },
                 error = function(e) conditionMessage(e))
check("a missing 'seurat_clusters' group field fails safely",
      grepl("not found", miss, ignore.case = TRUE))

# ── Negative: a single-group object fails safely (DEG needs >= 2 idents) ──
obj_one <- obj
obj_one$seurat_clusters <- factor(rep("A", n_cells))
one <- tryCatch({ run_deg(obj_one, tempfile(fileext = ".csv"), "seurat_clusters"); "NO_ERROR" },
                error = function(e) conditionMessage(e))
check("a single-identity object fails safely", grepl("at least two", one, ignore.case = TRUE))

if (file.exists(out_csv)) unlink(out_csv)

if (fails > 0) {
  cat(sprintf("\nDEG FIND-MARKERS SMOKE TEST FAILED: %d check(s) failed.\n", fails))
  quit(status = 1)
}
cat("\nDEG FIND-MARKERS SMOKE TEST PASSED: markers produced + table written; live object unchanged; bad group fields fail safely.\n")
quit(status = 0)
